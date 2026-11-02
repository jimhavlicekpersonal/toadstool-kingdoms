/**
 * Weekly Grove Raids between real Groves (or against a server-generated bot
 * Grove when no rival is free). Same schedule, attack allowance, star scoring
 * and chests as the game's offline Grove Raid (src/sim/social/groveRaid.ts).
 */
import { runBattle } from '../../src/sim/battle/battle';
import { createRng, int, mixSeed, next } from '../../src/sim/rng';
import { enemyGrove, raidPhase, raidWindow } from '../../src/sim/social/groveRaid';
import type { RaidAttackResponse, RaidClaimResponse, RaidTicketResponse, RaidView, BattleSubmission } from '../../src/net/protocol';
import type { GroveSummaryRow, Player, RaidPairing, RosterEntry } from '../repo';
import { ApiError, HOUR, type ServerContext } from './context';
import { requireGrove } from './groves';
import { checkArmy, takeTicket, TICKET_TTL_MS } from './pvp';

const ACTIVE_WINDOW_MS = 3 * 24 * HOUR;

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** Bases of a Grove's members (the roster the other side attacks). */
async function rosterOf(ctx: ServerContext, groveId: string): Promise<RosterEntry[]> {
  const out: RosterEntry[] = [];
  for (const m of await ctx.repo.members(groveId)) {
    const p = await ctx.repo.getPlayer(m.playerId);
    if (!p?.base) continue;
    const base = structuredClone(p.base);
    for (const b of base.buildings) b.loot = {};
    out.push({ index: out.length, name: p.name, hallLevel: p.hallLevel, trophies: p.trophies, base: { ...base, name: p.name }, playerId: p.id });
  }
  return out;
}

async function sideInfo(ctx: ServerContext, groveId: string): Promise<{ size: number; hall: number }> {
  const members = await ctx.repo.members(groveId);
  let halls = 0;
  for (const m of members) halls += (await ctx.repo.getPlayer(m.playerId))?.hallLevel ?? 1;
  return { size: Math.max(1, members.length), hall: Math.max(1, Math.round(halls / Math.max(1, members.length))) };
}

/** Pair a Grove for the week: the closest active unpaired Grove, or a bot Grove. */
async function ensurePairing(ctx: ServerContext, groveId: string, week: number): Promise<RaidPairing> {
  const existing = await ctx.repo.getPairing(week, groveId);
  if (existing) return existing;
  const t = ctx.now();
  const me = (await ctx.repo.listGroves('', 1000)).find((g) => g.id === groveId);
  const mine = await sideInfo(ctx, groveId);
  const candidates = (await ctx.repo.unpairedGroves(week, t - ACTIVE_WINDOW_MS, 200)).filter((g) => g.id !== groveId && Math.abs(g.members - mine.size) <= 5);
  const avg = me?.averageTrophies ?? 0;
  candidates.sort((a: GroveSummaryRow, b: GroveSummaryRow) => Math.abs(a.averageTrophies - avg) - Math.abs(b.averageTrophies - avg));
  for (const rival of candidates.slice(0, 5)) {
    const theirs = await sideInfo(ctx, rival.id);
    const ourRoster = await rosterOf(ctx, groveId);
    const theirRoster = await rosterOf(ctx, rival.id);
    if (!ourRoster.length || !theirRoster.length) continue;
    const ourName = me?.name ?? 'Grove';
    const ok = await ctx.repo.createPairings([
      { week, groveId, opponentGroveId: rival.id, opponentName: rival.name, botSeed: 0, roster: theirRoster, ourSize: ourRoster.length, ourHall: mine.hall, createdAt: t },
      { week, groveId: rival.id, opponentGroveId: groveId, opponentName: ourName, botSeed: 0, roster: ourRoster, ourSize: theirRoster.length, ourHall: theirs.hall, createdAt: t },
    ]);
    if (ok) return (await ctx.repo.getPairing(week, groveId))!;
  }
  // No rival free: a bot Grove generated from this Grove's id, sized to match.
  const seed = mixSeed(hashString(groveId), week);
  const enemy = enemyGrove(seed, week, mine.hall, ctx.data);
  const count = Math.max(1, mine.size);
  const roster: RosterEntry[] = enemy.bases.slice(0, Math.max(count, 1)).map((b, i) => ({ index: i, name: enemy.members[i] ?? b.name, hallLevel: b.hallLevel, trophies: b.trophies ?? 0, base: b, playerId: null }));
  await ctx.repo.createPairings([{ week, groveId, opponentGroveId: null, opponentName: enemy.name, botSeed: seed, roster, ourSize: count, ourHall: mine.hall, createdAt: t }]);
  return (await ctx.repo.getPairing(week, groveId))!;
}

/** Stars the bot Grove has taken from our side by time `t` (deterministic). */
function botStars(p: RaidPairing, t: number, ctx: ServerContext): number[] {
  const { start, end } = raidWindow(p.week, ctx.data);
  const odds = ctx.data.social.groveRaid.starOdds;
  const rng = createRng(mixSeed(p.botSeed, 0xb07));
  const best = new Array(p.ourSize).fill(0);
  const attacks = p.roster.length * ctx.data.social.groveRaid.attacksPerMember;
  for (let i = 0; i < attacks; i++) {
    const at = start + Math.floor(next(rng) * (end - start));
    const target = int(rng, 0, p.ourSize - 1);
    const attackerHall = p.roster[i % p.roster.length]?.hallLevel ?? p.ourHall;
    const p3 = Math.max(0.02, Math.min(0.9, odds.base3 + (attackerHall - p.ourHall) * odds.perHallDiff));
    const r = next(rng);
    const stars = r < p3 ? 3 : r < p3 + odds.base2 ? 2 : r < p3 + odds.base2 + odds.base1 ? 1 : 0;
    if (at <= t) best[target] = Math.max(best[target], stars);
  }
  return best;
}

async function scores(ctx: ServerContext, p: RaidPairing, t: number): Promise<{ ours: number; theirs: number; enemyBaseStars: number[] }> {
  const enemyBaseStars = new Array(p.roster.length).fill(0);
  for (const a of await ctx.repo.raidAttacks(p.week, p.groveId)) {
    if (a.at <= t && a.target < enemyBaseStars.length) enemyBaseStars[a.target] = Math.max(enemyBaseStars[a.target], a.stars);
  }
  let theirStars: number[];
  if (p.opponentGroveId) {
    const theirPairing = await ctx.repo.getPairing(p.week, p.opponentGroveId);
    theirStars = new Array(theirPairing?.roster.length ?? 0).fill(0);
    for (const a of await ctx.repo.raidAttacks(p.week, p.opponentGroveId)) {
      if (a.at <= t && a.target < theirStars.length) theirStars[a.target] = Math.max(theirStars[a.target], a.stars);
    }
  } else {
    theirStars = botStars(p, t, ctx);
  }
  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
  return { ours: sum(enemyBaseStars), theirs: sum(theirStars), enemyBaseStars };
}

/**
 * Only members who were in the Grove when the raid started take part (attacks
 * and the chest). So nobody can hop to a second Grove for extra attacks, or
 * into a winning Grove just before the end for its chest.
 */
function eligible(joinedAt: number, week: number, ctx: ServerContext): boolean {
  return joinedAt <= raidWindow(week, ctx.data).start;
}

function outcomeOf(ours: number, theirs: number): 'win' | 'draw' | 'loss' {
  return ours > theirs ? 'win' : ours < theirs ? 'loss' : 'draw';
}

export async function raid(ctx: ServerContext, me: Player): Promise<RaidView> {
  const { grove, joinedAt } = await requireGrove(ctx, me);
  const t = ctx.now();
  const ph = raidPhase(t, ctx.data);
  const per = ctx.data.social.groveRaid.attacksPerMember;
  const ok = eligible(joinedAt, ph.week, ctx);
  const chests: RaidView['chests'] = [];
  for (const w of [ph.week - 1, ph.week]) {
    if (w < 0 || raidWindow(w, ctx.data).end > t) continue;
    const claim = await ctx.repo.getClaim(w, me.id);
    if (claim) chests.push({ week: w, claimed: true });
    else if (eligible(joinedAt, w, ctx) && (await ctx.repo.getPairing(w, grove.id))) chests.push({ week: w, claimed: false });
  }
  const base: RaidView = { phase: ph.phase, week: ph.week, start: ph.start, end: ph.end, nextStart: ph.nextStart, eligible: ok, opponent: null, ours: 0, theirs: 0, enemyBaseStars: [], attacksLeft: 0, result: null, claimed: false, chests };
  const pairing = ph.phase === 'live' ? await ensurePairing(ctx, grove.id, ph.week) : await ctx.repo.getPairing(ph.week, grove.id);
  if (!pairing) return base;
  const s = await scores(ctx, pairing, ph.phase === 'ended' ? ph.end : t);
  const mine = (await ctx.repo.raidAttacks(ph.week, grove.id)).filter((a) => a.attackerId === me.id).length;
  const claim = await ctx.repo.getClaim(ph.week, me.id);
  return {
    ...base,
    opponent: { name: pairing.opponentName, kind: pairing.opponentGroveId ? 'grove' : 'bot', members: pairing.roster.map((r) => ({ index: r.index, name: r.name, hallLevel: r.hallLevel, trophies: r.trophies })) },
    ours: s.ours,
    theirs: s.theirs,
    enemyBaseStars: s.enemyBaseStars,
    attacksLeft: ph.phase === 'live' && ok ? Math.max(0, per - mine) : 0,
    result: ph.phase === 'ended' ? { outcome: outcomeOf(s.ours, s.theirs), ours: s.ours, theirs: s.theirs } : null,
    claimed: Boolean(claim),
  };
}

export async function raidTicket(ctx: ServerContext, me: Player, target: unknown): Promise<RaidTicketResponse> {
  const { grove, joinedAt } = await requireGrove(ctx, me);
  const t = ctx.now();
  const ph = raidPhase(t, ctx.data);
  if (ph.phase !== 'live') throw new ApiError(409, 'raid_not_live', 'The Grove Raid is not running.');
  if (!eligible(joinedAt, ph.week, ctx)) throw new ApiError(409, 'no_attacks_left', 'You joined during this Grove Raid; you can take part from next week.');
  const pairing = await ensurePairing(ctx, grove.id, ph.week);
  const used = (await ctx.repo.raidAttacks(ph.week, grove.id)).filter((a) => a.attackerId === me.id).length;
  if (used >= ctx.data.social.groveRaid.attacksPerMember) throw new ApiError(409, 'no_attacks_left', 'You have used your Grove Raid attacks.');
  const idx = Math.floor(Number(target));
  const entry = pairing.roster[idx];
  if (!entry) throw new ApiError(404, 'not_found', 'No such enemy base.');
  const expiresAt = Math.min(t + TICKET_TTL_MS, ph.end + 10 * 60_000);
  const ticket = { id: ctx.uuid(), kind: 'raid' as const, attackerId: me.id, defenderId: entry.playerId, defenderName: entry.name, base: entry.base, defenderTrophies: entry.trophies, createdAt: t, expiresAt, used: false, week: ph.week, groveId: grove.id, target: idx };
  await ctx.repo.createTicket(ticket);
  return { ticket: ticket.id, base: entry.base, expiresAt };
}

export async function raidAttack(ctx: ServerContext, me: Player, sub: BattleSubmission): Promise<RaidAttackResponse> {
  const ticket = await takeTicket(ctx, me, sub?.ticket, 'raid');
  const { army, levels } = checkArmy(sub, me, ctx.data);
  const week = ticket.week!;
  const used = (await ctx.repo.raidAttacks(week, ticket.groveId!)).filter((a) => a.attackerId === me.id).length;
  if (used >= ctx.data.social.groveRaid.attacksPerMember) throw new ApiError(409, 'no_attacks_left', 'You have used your Grove Raid attacks.');
  if (!(await ctx.repo.useTicket(ticket.id))) throw new ApiError(409, 'conflict', 'This battle was already reported.');
  const deployments = Array.isArray(sub.deployments) ? sub.deployments.slice(0, 2000) : [];
  const { result } = runBattle({ seed: Number(sub.seed) >>> 0, base: ticket.base, army, levels }, deployments, ctx.data, sub.endTick);
  const t = Math.min(ctx.now(), raidWindow(week, ctx.data).end - 1);
  await ctx.repo.addRaidAttack({ id: ctx.uuid(), week, groveId: ticket.groveId!, attackerId: me.id, target: ticket.target!, stars: result.stars, destruction: result.destruction, at: t });
  const pairing = (await ctx.repo.getPairing(week, ticket.groveId!))!;
  const s = await scores(ctx, pairing, ctx.now());
  return { result, stars: result.stars, ours: s.ours, theirs: s.theirs };
}

export async function claimRaid(ctx: ServerContext, me: Player, week: unknown): Promise<RaidClaimResponse> {
  const w = Math.floor(Number(week));
  if (!Number.isFinite(w)) throw new ApiError(400, 'bad_request', 'week must be a number');
  const { end } = raidWindow(w, ctx.data);
  const existing = await ctx.repo.getClaim(w, me.id);
  if (existing) {
    // Safe to retry, even after leaving the Grove.
    const p = await ctx.repo.getPairing(w, existing.groveId);
    const s = p ? await scores(ctx, p, end) : { ours: 0, theirs: 0 };
    return { week: w, outcome: existing.outcome, ours: s.ours, theirs: s.theirs, alreadyClaimed: true };
  }
  const { grove, joinedAt } = await requireGrove(ctx, me);
  if (ctx.now() < end) throw new ApiError(409, 'raid_not_ended', 'That Grove Raid has not ended yet.');
  if (!eligible(joinedAt, w, ctx)) throw new ApiError(404, 'not_found', 'You joined your Grove after that Grove Raid started.');
  const pairing = await ctx.repo.getPairing(w, grove.id);
  if (!pairing) throw new ApiError(404, 'not_found', 'Your Grove did not take part in that Grove Raid.');
  const s = await scores(ctx, pairing, end);
  const outcome = outcomeOf(s.ours, s.theirs);
  const fresh = await ctx.repo.addClaim({ week: w, playerId: me.id, groveId: grove.id, outcome, at: ctx.now() });
  return { week: w, outcome, ours: s.ours, theirs: s.theirs, alreadyClaimed: !fresh };
}
