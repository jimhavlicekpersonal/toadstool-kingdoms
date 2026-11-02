/**
 * Asynchronous PvP, following the game's matchmaking design
 * (src/sim/matchmaking.ts): opponents within one Elder Toadstool level of the
 * attacker, near their trophies; the loot penalty for hitting lower halls;
 * storage loot caps; shield tiers. Every attack is re-simulated here.
 */
import { maxHousingAtHall } from '../../src/sim/army';
import { runBattle } from '../../src/sim/battle/battle';
import type { BaseLayout } from '../../src/sim/battle/types';
import { buildingDef, levelDef } from '../../src/sim/data';
import { shieldHoursFor, storageLootCap } from '../../src/sim/defense';
import { applyLootPenalty, hallWindow, opponentForRank } from '../../src/sim/matchmaking';
import { lossTrophies, winTrophies } from '../../src/sim/ranks';
import { troopLevelCapAt } from '../../src/sim/research';
import type { GameData, ResourceKind } from '../../src/sim/types';
import type { AttackResponse, BattleSubmission, DefensesResponse, LeaderboardResponse, MatchResponse, UploadBaseRequest } from '../../src/net/protocol';
import type { Player, Ticket } from '../repo';
import { ApiError, HOUR, MIN, type ServerContext } from './context';

/** How long a matched base stays reserved for its attacker. */
export const TICKET_LOCK_MS = 5 * MIN;
/** How long the attacker has to report the battle (3 minutes of play plus slack for bad connections). */
export const TICKET_TTL_MS = HOUR;

/** Reject bases that could not exist in the game. */
export function validateBase(base: BaseLayout, data: GameData): string | null {
  if (!base || !Array.isArray(base.buildings) || base.buildings.length === 0 || base.buildings.length > 400) return 'bad base';
  const map = data.economy.mapSize;
  const occ = new Uint8Array(map * map);
  let halls = 0;
  for (const b of base.buildings) {
    const def = data.buildings[b.type];
    if (!def || def.category === 'obstacle' || def.category === 'decor') return `unknown building ${b.type}`;
    if (!Number.isInteger(b.level) || b.level < 1 || b.level > def.levels.length) return `bad level on ${b.type}`;
    if (def.category === 'hall') halls++;
    for (let y = b.y; y < b.y + def.size; y++) {
      for (let x = b.x; x < b.x + def.size; x++) {
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= map || y >= map) return 'building off the map';
        if (occ[y * map + x]) return 'overlapping buildings';
        occ[y * map + x] = 1;
      }
    }
    for (const v of Object.values(b.loot ?? {})) if (typeof v !== 'number' || v < 0 || !Number.isFinite(v)) return 'bad loot';
  }
  if (halls !== 1) return 'base needs exactly one Elder Toadstool';
  return null;
}

/**
 * Clamp loot to what the rules allow: storages give at most the hall level's
 * storage loot cap, collectors at most their raidable share of a full
 * collector. Mutates and returns the base.
 */
export function capBaseLoot(base: BaseLayout, data: GameData): BaseLayout {
  const hall = base.buildings.find((b) => data.buildings[b.type]?.category === 'hall');
  const hl = hall?.level ?? 1;
  base.hallLevel = hl;
  const storeCap = storageLootCap(hl, data);
  const fromStores: Record<string, number> = {};
  for (const b of base.buildings) {
    const def = buildingDef(data, b.type);
    const loot = b.loot ?? {};
    for (const k of Object.keys(loot) as ResourceKind[]) {
      if (def.produces === k) {
        const ld = levelDef(data, b.type, b.level);
        const max = Math.floor((ld?.ratePerHour ?? 0) * data.economy.collectorHoursCap * data.economy.raidableUncollectedFraction);
        loot[k] = Math.min(loot[k] ?? 0, max);
      } else {
        fromStores[k] = (fromStores[k] ?? 0) + (loot[k] ?? 0);
      }
    }
  }
  for (const [k, total] of Object.entries(fromStores)) {
    if (total <= storeCap) continue;
    const scale = storeCap / total;
    for (const b of base.buildings) {
      const def = buildingDef(data, b.type);
      const loot = b.loot as Record<string, number> | undefined;
      if (!loot || def.produces === k || !loot[k]) continue;
      loot[k] = Math.floor(loot[k] * scale);
    }
  }
  return base;
}

/** Most donated troops (housing) the largest Grove Lodge allowed at this hall level holds. */
export function maxReinforcementAt(hall: number, data: GameData): number {
  const lim = data.hall.levels[Math.max(1, Math.min(data.hall.levels.length, hall)) - 1]?.limits.grove_lodge;
  if (!lim) return 0;
  return buildingDef(data, 'grove_lodge').levels[lim.maxLevel - 1]?.reinforcement ?? 0;
}

/** Largest army housing possible at a hall level: full Army Camps plus a full Grove Lodge. */
export function maxHousing(hallLevel: number, data: GameData): number {
  return maxHousingAtHall(hallLevel, data) + maxReinforcementAt(hallLevel, data);
}

/** Troop levels must be ones the attacker's hall level allows. */
export function validLevels(levels: unknown, hallLevel: number, data: GameData): Record<string, number> | null {
  if (levels === undefined || levels === null) return {};
  if (typeof levels !== 'object') return null;
  const cap = troopLevelCapAt(hallLevel, data);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(levels as Record<string, unknown>)) {
    const def = data.troops[k];
    if (!def || typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > Math.min(cap, def.levels.length)) return null;
    out[k] = v;
  }
  return out;
}

/** Check a battle submission's army and levels against the attacker's hall. */
export function checkArmy(sub: BattleSubmission, me: Player, data: GameData): { army: Record<string, number>; levels: Record<string, number> } {
  const army = sub.army ?? {};
  if (typeof army !== 'object') throw new ApiError(400, 'bad_request', 'bad army');
  let housing = 0;
  for (const [k, n] of Object.entries(army)) {
    const def = data.troops[k];
    if (!def || !Number.isInteger(n) || n < 0) throw new ApiError(400, 'bad_request', 'bad army');
    housing += def.housing * n;
  }
  if (housing > maxHousing(me.hallLevel, data)) throw new ApiError(400, 'bad_request', 'army too big');
  const levels = validLevels(sub.levels, me.hallLevel, data);
  if (!levels) throw new ApiError(400, 'bad_request', 'bad troop levels');
  return { army, levels };
}

export async function uploadBase(ctx: ServerContext, me: Player, req: UploadBaseRequest): Promise<void> {
  const base = structuredClone(req?.base) as BaseLayout;
  const err = validateBase(base, ctx.data);
  if (err) throw new ApiError(400, 'bad_request', err);
  capBaseLoot(base, ctx.data);
  base.name = me.name;
  await ctx.repo.updatePlayer(me.id, { base, hallLevel: base.hallLevel, updatedAt: ctx.now() });
}

/** Find someone to attack: a real player if one fits the rules, otherwise a generated base of matched strength. */
export async function match(ctx: ServerContext, me: Player): Promise<MatchResponse> {
  const t = ctx.now();
  const { data, repo } = ctx;
  const win = hallWindow(me.hallLevel, data);
  const recent = await repo.recentTargets(me.id, t - HOUR);
  const mates = me.groveId ? (await repo.members(me.groveId)).map((m) => m.playerId) : [];
  const exclude = [me.id, ...recent, ...mates];
  let found: Player | null = null;
  for (const range of [data.ranks.matchTrophyRange, 200, 400, 1_000_000]) {
    const list = await repo.findOpponents({ excludeIds: exclude, minHall: win.min, maxHall: win.max, minTrophies: me.trophies - range, maxTrophies: me.trophies + range, now: t, lockedSince: t - TICKET_LOCK_MS, limit: 20 });
    if (list.length) {
      found = list[Math.floor(ctx.random() * list.length)];
      break;
    }
  }
  let ticket: Ticket;
  if (found?.base) {
    const base = applyLootPenalty(capBaseLoot({ ...structuredClone(found.base), name: found.name, trophies: found.trophies }, data), me.hallLevel, data);
    ticket = { id: ctx.uuid(), kind: 'pvp', attackerId: me.id, defenderId: found.id, defenderName: found.name, base, defenderTrophies: found.trophies, createdAt: t, expiresAt: t + TICKET_TTL_MS, used: false };
  } else {
    // Nobody fits: a generated base with the same matchmaking math the game uses offline.
    const seed = Math.floor(ctx.random() * 4294967296) >>> 0;
    const base = opponentForRank(seed, me.trophies, me.hallLevel, data);
    const names = data.names;
    base.name = `${names.placeFirst[seed % names.placeFirst.length]} ${names.placeSecond[(seed >>> 8) % names.placeSecond.length]}`;
    ticket = { id: ctx.uuid(), kind: 'pvp', attackerId: me.id, defenderId: null, defenderName: base.name, base, defenderTrophies: base.trophies ?? me.trophies, createdAt: t, expiresAt: t + TICKET_TTL_MS, used: false };
  }
  await repo.createTicket(ticket);
  return {
    ticket: ticket.id,
    base: ticket.base,
    opponent: { name: ticket.defenderName, trophies: ticket.defenderTrophies, hallLevel: ticket.base.hallLevel, kind: ticket.defenderId ? 'player' : 'bot' },
    expiresAt: ticket.expiresAt,
  };
}

async function takeTicket(ctx: ServerContext, me: Player, id: string | undefined, kind: Ticket['kind']): Promise<Ticket> {
  const ticket = id ? await ctx.repo.getTicket(String(id)) : null;
  if (!ticket || ticket.attackerId !== me.id || ticket.kind !== kind) throw new ApiError(404, 'not_found', 'Unknown ticket.');
  if (ctx.now() > ticket.expiresAt) throw new ApiError(410, 'expired', 'This battle took too long to report.');
  return ticket;
}

export { takeTicket };

export async function attack(ctx: ServerContext, me: Player, sub: BattleSubmission): Promise<AttackResponse> {
  const { data, repo } = ctx;
  const ticket = await takeTicket(ctx, me, sub?.ticket, 'pvp');
  const { army, levels } = checkArmy(sub, me, data);
  const deployments = Array.isArray(sub.deployments) ? sub.deployments.slice(0, 2000) : [];
  if (!(await repo.useTicket(ticket.id))) throw new ApiError(409, 'conflict', 'This battle was already reported.');
  const t = ctx.now();
  const seed = Number(sub.seed) >>> 0;
  const { result } = runBattle({ seed, base: ticket.base, army, levels }, deployments, data, sub.endTick);
  const defender = ticket.defenderId ? await repo.getPlayer(ticket.defenderId) : null;
  const defTrophies = defender?.trophies ?? ticket.defenderTrophies;
  const delta = result.stars >= 1 ? winTrophies(me.trophies, defTrophies, data) : -lossTrophies(me.trophies, defTrophies, data);
  const playerTrophies = Math.max(0, me.trophies + delta);
  await repo.updatePlayer(me.id, { trophies: playerTrophies, shieldUntil: Math.min(me.shieldUntil, t) });
  if (defender) {
    const patch: { trophies: number; shieldUntil?: number } = { trophies: Math.max(0, defender.trophies - delta) };
    const shield = shieldHoursFor(result.destruction, data);
    if (shield > 0) patch.shieldUntil = Math.max(defender.shieldUntil, t + shield * HOUR);
    await repo.updatePlayer(defender.id, patch);
  }
  const attackId = ctx.uuid();
  if (defender) {
    await repo.addAttack({ id: attackId, at: t, attackerId: me.id, attackerName: me.name, defenderId: defender.id, seed, army, levels, base: ticket.base, deployments, endTick: sub.endTick, result, attackerTrophies: delta, defenderTrophies: -delta });
  }
  return { attackId, result, trophies: delta, playerTrophies };
}

export async function defenses(ctx: ServerContext, me: Player, since: number): Promise<DefensesResponse> {
  const list = await ctx.repo.defensesFor(me.id, Number(since) || 0, 20);
  return {
    defenses: list.map((a) => ({ id: a.id, at: a.at, attackerName: a.attackerName, seed: a.seed, army: a.army, levels: a.levels ?? {}, base: a.base, deployments: a.deployments, endTick: a.endTick, result: a.result, trophies: a.defenderTrophies })),
  };
}

export async function leaderboard(ctx: ServerContext, me: Player, limit: number): Promise<LeaderboardResponse> {
  const n = Math.max(1, Math.min(100, Number(limit) || 50));
  const top = await ctx.repo.topPlayers(n);
  const groveNames = new Map<string, string>();
  for (const p of top) {
    if (p.groveId && !groveNames.has(p.groveId)) groveNames.set(p.groveId, (await ctx.repo.getGrove(p.groveId))?.name ?? '');
  }
  return {
    players: top.map((p, i) => ({ rank: i + 1, name: p.name, trophies: p.trophies, hallLevel: p.hallLevel, grove: p.groveId ? groveNames.get(p.groveId) || null : null })),
    me: me.base ? { rank: await ctx.repo.rankOf(me.trophies), trophies: me.trophies } : null,
  };
}
