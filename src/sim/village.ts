import { armyHousing, barracksLevel, finishTraining, housingCapacity, queueEndsAt, queueHousing, retimeQueue } from './army';
import { runBattle } from './battle/battle';
import type { BattleRecord, BattleSetup, Deployment } from './battle/types';
import { MS_PER_SECOND } from './clock';
import { buildingDef, hallType, levelDef, maxDefinedLevel, troopDef, troopLevel } from './data';
import { mixSeed } from './rng';
import { leagueFor, lossTrophies, seasonOf, winTrophies } from './ranks';
import { emptyResearch, finishResearch, researchQuote, startResearch, troopLevelOf } from './research';
import { chestContents, chestOutcome, emptyDaily, streakAfterClaim } from './daily';
import { eventEffect } from './events';
import { achievementViews } from './achievements';
import { skipCost, topUpCost } from './economy';
import { canPurchase, productInfo } from './monetization';
import { scatterObstacles } from './obstacles';
import { triggerOffer } from './offers';
import { buildTimeFactor, currentTasks, dayIndex, passSeason, rollPeriods, unlockedTier } from './pass';
import { emptyStats, type OfferTrigger } from './types';
import { advanceGrove, canRequest, donate as donateTroops, emptyGrove, joinGrove, requestTroops, sendChat } from './social/grove';
import { attacksLeft, ensureRaid, raidPhase, settleRaids } from './social/groveRaid';
import { bindPlayer, claimRaidChest, emptyNet, receiveDonations, spendDonation, type ServerDonation } from './net';
import { canPlace } from './grid';
import { addCapped, canAfford, capacity, collectorAmount, effectiveLevel, subtractCost } from './resources';
import type { Building, BuildingLimit, BuildingType, Cost, GameData, ResourceKind, VillageState } from './types';
import { RESOURCE_KINDS } from './types';

// ---------- Commands ----------

export type Command =
  | { type: 'place'; buildingType: BuildingType; x: number; y: number }
  | { type: 'move'; id: string; x: number; y: number }
  | { type: 'upgrade'; id: string }
  | { type: 'cancel'; id: string }
  | { type: 'collect'; id: string }
  | { type: 'train'; troop: string }
  | { type: 'cancelTraining'; index: number }
  | { type: 'research'; troop: string }
  | { type: 'cancelResearch' }
  | { type: 'skipResearch' }
  | { type: 'openDailyChest' }
  | { type: 'scout'; paid: boolean }
  | { type: 'battleEnd'; record: Omit<BattleRecord, 'result' | 'id' | 'kind'> }
  | { type: 'skip'; id: string }
  | { type: 'skipTraining' }
  | { type: 'topUp'; cost: Cost }
  | { type: 'grantPurchase'; productId: string; transactionId: string }
  | { type: 'setProfile'; under18: boolean }
  | { type: 'buySkin'; skin: string }
  | { type: 'equipSkin'; skin: string }
  | { type: 'claimTask'; id: string; kind: 'daily' | 'weekly' }
  | { type: 'claimTier'; tier: number; track: 'free' | 'premium' }
  | { type: 'claimAchievement'; id: string }
  | { type: 'clear'; id: string }
  | { type: 'triggerOffer'; trigger: OfferTrigger }
  | { type: 'joinGrove' }
  | { type: 'chat'; text: string }
  | { type: 'donate'; requestId: string; troop: string; count: number }
  | { type: 'requestTroops' }
  | { type: 'groveBattleEnd'; target: number; record: Omit<BattleRecord, 'result' | 'id' | 'kind'> }
  | { type: 'markPrepOffer'; week: number }
  | { type: 'tutorial'; step: number; done?: boolean }
  | { type: 'applyDefense'; record: BattleRecord; lost: Cost; trophies: number; shieldUntil: number }
  | { type: 'syncRank'; trophies: number; shieldUntil?: number }
  // Multiplayer server results (see sim/net.ts); each is safe to apply twice.
  | { type: 'netBind'; playerId: string }
  | { type: 'receiveDonations'; items: ServerDonation[] }
  | { type: 'spendDonation'; troop: string; count: number; xp: number }
  | { type: 'claimRaidChest'; week: number; outcome: 'win' | 'draw' | 'loss'; ours: number; theirs: number }
  | { type: 'remoteGroveBattleEnd'; target: number; record: Omit<BattleRecord, 'result' | 'id' | 'kind'> }
  | { type: 'leaveLocalGrove' };

export type ErrorCode =
  | 'NOT_FOUND'
  | 'NOT_AVAILABLE'
  | 'INVALID_PLACEMENT'
  | 'LIMIT_REACHED'
  | 'HALL_LEVEL_TOO_LOW'
  | 'MAX_LEVEL'
  | 'BUSY'
  | 'NOT_UPGRADING'
  | 'NOT_ENOUGH_RESOURCES'
  | 'NO_FREE_BUILDER'
  | 'NOTHING_TO_COLLECT'
  | 'STORAGE_FULL'
  | 'LOCKED'
  | 'ARMY_FULL'
  | 'INVALID_BATTLE'
  | 'NOT_ENOUGH_MOONSTONES'
  | 'NOTHING_TO_SKIP'
  | 'PURCHASE_REFUSED'
  | 'NOT_OWNED'
  | 'NOT_READY'
  | 'ALREADY_CLAIMED'
  | 'NO_OFFER';

export type SimEvent =
  | { kind: 'upgrade_start'; buildingType: BuildingType; id: string; toLevel: number; seconds: number; cost: Cost }
  | { kind: 'upgrade_cancel'; buildingType: BuildingType; id: string; toLevel: number; refund: Cost }
  | { kind: 'collect'; buildingType: BuildingType; id: string; resource: ResourceKind; amount: number; eventBonus?: number }
  | { kind: 'move'; buildingType: BuildingType; id: string }
  | { kind: 'train_start'; troop: string; seconds: number; cost: Cost }
  | { kind: 'train_cancel'; troop: string }
  | { kind: 'research_start'; troop: string; toLevel: number; seconds: number; cost: Cost }
  | { kind: 'research_cancel'; troop: string; toLevel: number; refund: Cost }
  | { kind: 'daily_chest'; outcome: string; step: number; grants: Cost; skipped: number; steppedBack: number }
  | { kind: 'scout'; seed: number; fee: number }
  | { kind: 'raid_end'; record: BattleRecord }
  | { kind: 'skip_used'; what: string; seconds: number; moonstones: number }
  | { kind: 'moonstone_spend'; what: string; moonstones: number }
  | { kind: 'purchase_granted'; productId: string; usd: number; grants: Cost }
  | { kind: 'trigger'; trigger: OfferTrigger }
  | { kind: 'offer_shown'; offerId: string; expiresAt: number }
  | { kind: 'reward'; source: string; grants: Cost }
  | { kind: 'clear_start'; buildingType: BuildingType; id: string; seconds: number }
  | { kind: 'donation'; troop: string; count: number; xp: number }
  | { kind: 'grove_attack'; target: number; stars: number; destruction: number }
  | { kind: 'reinforcements'; troops: { troop: string; count: number; fromName: string }[] };

export type CommandResult =
  | { ok: true; state: VillageState; events: SimEvent[] }
  | { ok: false; code: ErrorCode; message: string };

export interface Quote {
  toLevel: number;
  cost: Cost;
  seconds: number;
}

export type QuoteResult = { ok: true; quote: Quote } | { ok: false; code: ErrorCode; message: string; quote?: Quote };

export interface FinishedUpgrade {
  id: string;
  type: BuildingType;
  level: number;
  at: number;
}

function fail(code: ErrorCode, message: string): { ok: false; code: ErrorCode; message: string } {
  return { ok: false, code, message };
}

// ---------- Village setup and queries ----------

export function createNewVillage(now: number, data: GameData): VillageState {
  const state: VillageState = {
    createdAt: now,
    lastSeenAt: now,
    resources: { ...data.economy.startingResources },
    buildings: [],
    nextId: 1,
    army: {},
    training: [],
    research: emptyResearch(),
    scout: null,
    battleLog: [],
    seed: mixSeed(now >>> 0, Math.floor(now / 4294967296)),
    nextSeed: 1,
    trophies: data.ranks.startingTrophies,
    shieldUntil: now + data.raids.newPlayerShieldHours * 3_600_000,
    defenseLog: [],
    season: seasonOf(now),
    raidCheckAt: now,
    stats: emptyStats(),
    purchases: [],
    profile: { under18: null },
    offers: { active: [], lastShown: {}, bought: [] },
    pass: { season: passSeason(now, data), points: 0, premium: false, claimedFree: [], claimedPremium: [] },
    tasks: { day: dayIndex(now, data), dayBaseline: emptyStats(), dayClaimed: [], week: Math.floor(dayIndex(now, data) / 7), weekBaseline: emptyStats(), weekClaimed: [] },
    cosmetics: { owned: ['classic'], hallSkin: 'classic' },
    achievements: {},
    flags: { longWaitSeen: false },
    grove: emptyGrove(),
    net: emptyNet(),
    tutorial: { step: 0, done: false },
    daily: emptyDaily(data),
  };
  for (const sb of data.economy.startingLayout) {
    const def = buildingDef(data, sb.type);
    state.buildings.push({
      id: `b${state.nextId++}`,
      type: sb.type,
      level: sb.level,
      x: sb.x,
      y: sb.y,
      upgrade: null,
      collector: def.produces ? { stored: 0, accrueFrom: now } : null,
    });
  }
  scatterObstacles(state, data);
  return state;
}

/** Finish every timer whose end time has passed. Returns a new state; the input is untouched. */
export function advance(state: VillageState, now: number, data: GameData): { state: VillageState; finished: FinishedUpgrade[] } {
  const next = structuredClone(state);
  const finished: FinishedUpgrade[] = [];
  // Obstacles whose clearing finished disappear and give their Moonstones.
  next.buildings = next.buildings.filter((b) => {
    if (!b.upgrade || b.upgrade.toLevel !== 0 || b.upgrade.endsAt > now) return true;
    const reward = buildingDef(data, b.type).clear?.moonstones ?? 0;
    next.resources.moonstones += reward;
    next.stats.obstaclesCleared++;
    finished.push({ id: b.id, type: b.type, level: 0, at: b.upgrade.endsAt });
    return false;
  });
  for (const b of next.buildings) {
    if (b.upgrade && b.upgrade.endsAt <= now) {
      finished.push({ id: b.id, type: b.type, level: b.upgrade.toLevel, at: b.upgrade.endsAt });
      b.level = b.upgrade.toLevel;
      b.upgrade = null;
      // Tasks count finished upgrades only, so start-and-cancel earns nothing.
      next.stats.upgradesDone++;
    }
  }
  finished.sort((a, b) => a.at - b.at);
  finishTraining(next, now);
  finishResearch(next, now);
  rollPeriods(next, now, data);
  advanceGrove(next, now, data);
  settleRaids(next, now, hallLevel(next, data), data);
  return { state: next, finished };
}

export function hallLevel(state: VillageState, data: GameData): number {
  const type = hallType(data);
  const hall = state.buildings.find((b) => b.type === type);
  return Math.max(1, hall?.level ?? 1);
}

export function countOfType(state: VillageState, type: BuildingType): number {
  return state.buildings.filter((b) => b.type === type).length;
}

/** How many of a building the current Elder Toadstool level allows, and the highest level. */
export function limitFor(state: VillageState, data: GameData, type: BuildingType, atHallLevel?: number): BuildingLimit {
  if (buildingDef(data, type).category === 'hall') {
    return { count: 1, maxLevel: Math.min(data.hall.levels.length, maxDefinedLevel(data, type)) };
  }
  const level = atHallLevel ?? hallLevel(state, data);
  return data.hall.levels[level - 1]?.limits[type] ?? { count: 0, maxLevel: 0 };
}

/** The lowest Elder Toadstool level that allows the condition, or null if none does. */
export function hallLevelRequiredFor(data: GameData, type: BuildingType, test: (l: BuildingLimit) => boolean): number | null {
  for (const hl of data.hall.levels) {
    const lim = hl.limits[type];
    if (lim && test(lim)) return hl.level;
  }
  return null;
}

export function builderStatus(state: VillageState, data: GameData, now: number): { total: number; busy: number; free: number } {
  let total = 0;
  let busy = 0;
  for (const b of state.buildings) {
    if (buildingDef(data, b.type).category === 'builder' && effectiveLevel(b, now) >= 1) total++;
    if (b.upgrade && b.upgrade.endsAt > now) busy++;
  }
  return { total, busy, free: Math.max(0, total - busy) };
}

function costText(cost: Cost): string {
  return RESOURCE_KINDS.filter((k) => cost[k])
    .map((k) => `${cost[k]} ${k}`)
    .join(', ');
}

/** Can a new building of this type be bought right now (ignoring where it goes)? */
export function placeQuote(state: VillageState, data: GameData, type: BuildingType, now: number): QuoteResult {
  const s = advance(state, now, data).state;
  const def = data.buildings[type];
  if (!def || !def.inShop) return fail('NOT_AVAILABLE', 'That building is not available.');
  const first = def.levels[0];
  const have = countOfType(s, type);
  let cost: Cost = first.cost;
  if (def.category === 'builder') {
    const i = have - 2;
    const price = data.economy.builderHutCosts[i];
    if (price === undefined || i < 0) return fail('LIMIT_REACHED', 'You have all the Beaver Builders you can hire.');
    cost = { moonstones: price };
  }
  const quote: Quote = { toLevel: 1, cost, seconds: Math.round(first.buildSeconds * buildTimeFactor(s, now, data)) };
  const lim = limitFor(s, data, type);
  if (have >= lim.count) {
    const need = hallLevelRequiredFor(data, type, (l) => l.count > have);
    return need
      ? { ...fail('HALL_LEVEL_TOO_LOW', `Upgrade your Elder Toadstool to level ${need} to build another ${def.name}.`), quote }
      : { ...fail('LIMIT_REACHED', `You have the most ${def.name}s allowed.`), quote };
  }
  if (!canAfford(s.resources, cost)) {
    return cost.moonstones && s.resources.moonstones < cost.moonstones
      ? { ...fail('NOT_ENOUGH_MOONSTONES', `Needs ${cost.moonstones} Moonstones.`), quote }
      : { ...fail('NOT_ENOUGH_RESOURCES', `Not enough resources (needs ${costText(cost)}).`), quote };
  }
  if (quote.seconds > 0 && builderStatus(s, data, now).free < 1) {
    return { ...fail('NO_FREE_BUILDER', 'All your Beaver Builders are busy.'), quote };
  }
  return { ok: true, quote };
}

/** What the next upgrade of a building costs, and whether it can start now. */
export function upgradeQuote(state: VillageState, id: string, data: GameData, now: number): QuoteResult {
  const s = advance(state, now, data).state;
  const b = s.buildings.find((x) => x.id === id);
  if (!b) return fail('NOT_FOUND', 'Building not found.');
  const def = buildingDef(data, b.type);
  if (b.upgrade) return fail('BUSY', `${def.name} is already being worked on.`);
  if (def.category === 'obstacle' || def.category === 'decor') return fail('MAX_LEVEL', `${def.name} cannot be upgraded.`);
  const next = levelDef(data, b.type, b.level + 1);
  const lim = limitFor(s, data, b.type);
  if (!next || b.level >= maxDefinedLevel(data, b.type) || (def.category === 'hall' && b.level >= lim.maxLevel)) {
    return fail('MAX_LEVEL', `${def.name} is at its highest level.`);
  }
  const quote: Quote = { toLevel: next.level, cost: next.cost, seconds: Math.round(next.buildSeconds * buildTimeFactor(s, now, data)) };
  if (next.level > lim.maxLevel) {
    const need = hallLevelRequiredFor(data, b.type, (l) => l.maxLevel >= next.level);
    return need
      ? { ...fail('HALL_LEVEL_TOO_LOW', `Upgrade your Elder Toadstool to level ${need} first.`), quote }
      : { ...fail('MAX_LEVEL', `${def.name} is at its highest level.`), quote };
  }
  if (!canAfford(s.resources, next.cost)) return { ...fail('NOT_ENOUGH_RESOURCES', `Not enough resources (needs ${costText(next.cost)}).`), quote };
  if (quote.seconds > 0 && builderStatus(s, data, now).free < 1) {
    return { ...fail('NO_FREE_BUILDER', 'All your Beaver Builders are busy.'), quote };
  }
  return { ok: true, quote };
}

// ---------- Applying commands ----------

/**
 * Apply one player command at time `now`. Pure: returns a new state and never
 * mutates the input. Timers that ended before `now` are finished first.
 */
export function applyCommand(state: VillageState, cmd: Command, now: number, data: GameData): CommandResult {
  const s = advance(state, now, data).state;
  const moonBefore = s.resources.moonstones;
  const r = runCommand(s, cmd, now, data);
  if (!r.ok) return r;
  afterCommand(r.state, r.events, cmd, moonBefore, now, data);
  return r;
}

/** Update counters, note Moonstone spending and raise offer triggers. Mutates. */
function afterCommand(s: VillageState, events: SimEvent[], cmd: Command, moonBefore: number, now: number, data: GameData): void {
  for (const e of [...events]) {
    if (e.kind === 'collect') {
      if (e.resource === 'acorns') s.stats.collectedAcorns += e.amount;
      if (e.resource === 'dew') s.stats.collectedDew += e.amount;
    } else if (e.kind === 'upgrade_start') {
      s.stats.upgradesStarted++;
      // Instant upgrades (hedges) finish right away; timed ones count in advance().
      if (e.seconds <= 0) s.stats.upgradesDone++;
      if (e.seconds > 3600 && !s.flags.longWaitSeen) {
        s.flags.longWaitSeen = true;
        events.push({ kind: 'trigger', trigger: 'first_long_wait' });
      }
      if (e.seconds > 0 && builderStatus(s, data, now).free === 0) events.push({ kind: 'trigger', trigger: 'all_builders_busy' });
    } else if (e.kind === 'raid_end' && e.record.kind === 'attack') {
      if (e.record.result.stars >= 1) s.stats.raidsWon++;
      s.stats.starsEarned += e.record.result.stars;
    }
  }
  const spent = moonBefore - s.resources.moonstones;
  if (spent > 0 && cmd.type !== 'grantPurchase') {
    s.stats.moonstonesSpent += spent;
    events.push({ kind: 'moonstone_spend', what: cmd.type === 'place' ? cmd.buildingType : cmd.type, moonstones: spent });
  }
}

function runCommand(s: VillageState, cmd: Command, now: number, data: GameData): CommandResult {
  switch (cmd.type) {
    case 'place':
      return place(s, cmd.buildingType, cmd.x, cmd.y, now, data);
    case 'move':
      return move(s, cmd.id, cmd.x, cmd.y, data);
    case 'upgrade':
      return upgrade(s, cmd.id, now, data);
    case 'cancel':
      return cancel(s, cmd.id, now, data);
    case 'collect':
      return collect(s, cmd.id, now, data);
    case 'train':
      return train(s, cmd.troop, now, data);
    case 'cancelTraining':
      return cancelTraining(s, cmd.index, now, data);
    case 'research':
      return research(s, cmd.troop, now, data);
    case 'cancelResearch':
      return cancelResearch(s, now, data);
    case 'skipResearch':
      return skipResearch(s, now, data);
    case 'openDailyChest':
      return openDailyChest(s, now, data);
    case 'scout':
      return scout(s, cmd.paid, data);
    case 'battleEnd':
      return battleEnd(s, cmd.record, now, data);
    case 'skip':
      return skip(s, cmd.id, now, data);
    case 'skipTraining':
      return skipTraining(s, now, data);
    case 'topUp':
      return topUp(s, cmd.cost, data);
    case 'grantPurchase':
      return grantPurchase(s, cmd.productId, cmd.transactionId, now, data);
    case 'setProfile':
      s.profile.under18 = cmd.under18;
      return { ok: true, state: s, events: [] };
    case 'buySkin':
      return buySkin(s, cmd.skin, data);
    case 'equipSkin':
      if (!s.cosmetics.owned.includes(cmd.skin)) return fail('NOT_OWNED', 'You do not own that look yet.');
      s.cosmetics.hallSkin = cmd.skin;
      return { ok: true, state: s, events: [] };
    case 'claimTask':
      return claimTask(s, cmd.id, cmd.kind, data);
    case 'claimTier':
      return claimTier(s, cmd.tier, cmd.track, data);
    case 'claimAchievement':
      return claimAchievement(s, cmd.id, data);
    case 'clear':
      return clearObstacle(s, cmd.id, now, data);
    case 'joinGrove':
      if (s.grove.joined) return fail('ALREADY_CLAIMED', 'You are already in a Grove.');
      joinGrove(s, now, data);
      return { ok: true, state: s, events: [] };
    case 'chat': {
      if (!s.grove.joined) return fail('NOT_AVAILABLE', 'Join a Grove first.');
      if (!cmd.text.trim()) return fail('NOT_AVAILABLE', 'Type a message first.');
      sendChat(s, cmd.text, now, data);
      return { ok: true, state: s, events: [] };
    }
    case 'donate': {
      const r = donateTroops(s, cmd.requestId, cmd.troop, cmd.count, now, data);
      if (!r.ok) return fail('NOT_AVAILABLE', r.message);
      return { ok: true, state: s, events: [{ kind: 'donation', troop: cmd.troop, count: cmd.count, xp: r.xp }] };
    }
    case 'requestTroops': {
      const c = canRequest(s, now, data);
      if (!c.ok) return fail('NOT_AVAILABLE', c.message);
      requestTroops(s, now, data);
      return { ok: true, state: s, events: [] };
    }
    case 'groveBattleEnd':
      return groveBattleEnd(s, cmd.target, cmd.record, now, data);
    case 'applyDefense': {
      // A real player's raid reported by the server.
      if (s.defenseLog.some((d) => d.id === cmd.record.id)) return { ok: true, state: s, events: [] };
      for (const [k, v] of Object.entries(cmd.lost) as [ResourceKind, number][]) s.resources[k] = Math.max(0, s.resources[k] - Math.max(0, v));
      s.trophies = Math.max(0, cmd.trophies);
      s.shieldUntil = Math.max(s.shieldUntil, cmd.shieldUntil);
      s.defenseLog.push(cmd.record);
      while (s.defenseLog.length > data.raids.maxDefenseLog) s.defenseLog.shift();
      s.net.defensesSince = Math.max(s.net.defensesSince, cmd.record.at);
      return { ok: true, state: s, events: [] };
    }
    case 'netBind':
      bindPlayer(s, cmd.playerId);
      return { ok: true, state: s, events: [] };
    case 'receiveDonations': {
      const troops = receiveDonations(s, cmd.items, data);
      return { ok: true, state: s, events: troops.length ? [{ kind: 'reinforcements', troops }] : [] };
    }
    case 'spendDonation':
      if (!spendDonation(s, cmd.troop, cmd.count, cmd.xp)) return fail('NOT_AVAILABLE', 'Not enough of that troop.');
      return { ok: true, state: s, events: [{ kind: 'donation', troop: cmd.troop, count: cmd.count, xp: cmd.xp }] };
    case 'claimRaidChest': {
      const chest = claimRaidChest(s, cmd.week, cmd.outcome, cmd, hallLevel(s, data), data);
      if (!chest) return fail('ALREADY_CLAIMED', 'That chest was already collected.');
      return { ok: true, state: s, events: [{ kind: 'reward', source: `grove_raid:${cmd.week}`, grants: chest }] };
    }
    case 'remoteGroveBattleEnd': {
      // A Grove Raid attack scored by the server: only the troops are spent here.
      const bad = checkBattleSetup(s, cmd.record.setup, data);
      if (bad) return fail('INVALID_BATTLE', bad);
      const { result } = runBattle(cmd.record.setup, cmd.record.deployments, data, cmd.record.endTick);
      spendTroops(s, result.used);
      return { ok: true, state: s, events: [{ kind: 'grove_attack', target: cmd.target, stars: result.stars, destruction: result.destruction }] };
    }
    case 'leaveLocalGrove':
      // Playing online: the real Grove replaces the bot one (XP, Lodge troops and history stay).
      s.grove.joined = false;
      s.grove.requests = [];
      s.grove.myRequest = null;
      s.grove.raid = null;
      return { ok: true, state: s, events: [] };
    case 'syncRank':
      s.trophies = Math.max(0, cmd.trophies);
      if (cmd.shieldUntil !== undefined) s.shieldUntil = cmd.shieldUntil;
      return { ok: true, state: s, events: [] };
    case 'tutorial':
      s.tutorial = { step: cmd.step, done: Boolean(cmd.done) };
      return { ok: true, state: s, events: [] };
    case 'markPrepOffer':
      s.grove.prepOfferWeek = cmd.week;
      return { ok: true, state: s, events: [] };
    case 'triggerOffer': {
      const rule = triggerOffer(s, cmd.trigger, now, data);
      if (!rule) return fail('NO_OFFER', 'No offer right now.');
      const active = s.offers.active.find((a) => a.id === rule.id)!;
      return { ok: true, state: s, events: [{ kind: 'offer_shown', offerId: rule.id, expiresAt: active.expiresAt }] };
    }
  }
}

// ---------- Moonstones, purchases and rewards ----------

/** Moonstones to finish a building's timer now. */
export function skipQuote(state: VillageState, id: string, now: number, data: GameData): { seconds: number; moonstones: number } | null {
  const b = state.buildings.find((v) => v.id === id);
  if (!b?.upgrade || b.upgrade.endsAt <= now) return null;
  const seconds = Math.ceil((b.upgrade.endsAt - now) / 1000);
  return { seconds, moonstones: skipCost(seconds, data) };
}

function skip(s: VillageState, id: string, now: number, data: GameData): CommandResult {
  const q = skipQuote(s, id, now, data);
  if (!q) return fail('NOTHING_TO_SKIP', 'Nothing to finish.');
  if (s.resources.moonstones < q.moonstones) return fail('NOT_ENOUGH_MOONSTONES', `Needs ${q.moonstones} Moonstones.`);
  s.resources.moonstones -= q.moonstones;
  const b = s.buildings.find((v) => v.id === id)!;
  const finishedAt = now;
  if (b.collector && b.upgrade) b.collector = { stored: b.collector.stored, accrueFrom: finishedAt };
  b.upgrade!.endsAt = finishedAt;
  const adv = advance(s, now, data).state;
  return { ok: true, state: adv, events: [{ kind: 'skip_used', what: b.type, seconds: q.seconds, moonstones: q.moonstones }] };
}

/** Moonstones to finish the running research now. */
export function researchSkipQuote(state: VillageState, now: number, data: GameData): { seconds: number; moonstones: number } | null {
  const a = state.research?.active;
  if (!a || a.endsAt <= now) return null;
  const seconds = Math.ceil((a.endsAt - now) / 1000);
  return { seconds, moonstones: skipCost(seconds, data) };
}

function skipResearch(s: VillageState, now: number, data: GameData): CommandResult {
  const q = researchSkipQuote(s, now, data);
  if (!q) return fail('NOTHING_TO_SKIP', 'Nothing to finish.');
  if (s.resources.moonstones < q.moonstones) return fail('NOT_ENOUGH_MOONSTONES', `Needs ${q.moonstones} Moonstones.`);
  s.resources.moonstones -= q.moonstones;
  const what = s.research.active!.troop;
  s.research.active!.endsAt = now;
  finishResearch(s, now);
  return { ok: true, state: s, events: [{ kind: 'skip_used', what: `research:${what}`, seconds: q.seconds, moonstones: q.moonstones }] };
}

export function trainingSkipQuote(state: VillageState, now: number, data: GameData): { seconds: number; moonstones: number } | null {
  const last = state.training[state.training.length - 1];
  if (!last || last.endsAt <= now) return null;
  const seconds = Math.ceil((last.endsAt - now) / 1000);
  return { seconds, moonstones: skipCost(seconds, data) };
}

function skipTraining(s: VillageState, now: number, data: GameData): CommandResult {
  const q = trainingSkipQuote(s, now, data);
  if (!q) return fail('NOTHING_TO_SKIP', 'Nothing to finish.');
  if (s.resources.moonstones < q.moonstones) return fail('NOT_ENOUGH_MOONSTONES', `Needs ${q.moonstones} Moonstones.`);
  s.resources.moonstones -= q.moonstones;
  for (const item of s.training) item.endsAt = Math.min(item.endsAt, now);
  finishTraining(s, now);
  return { ok: true, state: s, events: [{ kind: 'skip_used', what: 'training', seconds: q.seconds, moonstones: q.moonstones }] };
}

/** Moonstones to buy exactly the resources missing for `cost` (null if nothing is missing or it would not fit). */
export function topUpQuote(state: VillageState, cost: Cost, data: GameData): { missing: Cost; moonstones: number } | null {
  const missing: Cost = {};
  const cap = capacity(state, data);
  for (const k of RESOURCE_KINDS) {
    if (k === 'moonstones') continue;
    const need = (cost[k] ?? 0) - state.resources[k];
    if (need > 0) {
      if ((cost[k] ?? 0) > cap[k]) return null;
      missing[k] = need;
    }
  }
  if (!Object.keys(missing).length) return null;
  return { missing, moonstones: topUpCost(missing, data) };
}

function topUp(s: VillageState, cost: Cost, data: GameData): CommandResult {
  const q = topUpQuote(s, cost, data);
  if (!q) return fail('NOTHING_TO_SKIP', 'Nothing missing, or it would not fit in your storage.');
  if (s.resources.moonstones < q.moonstones) return fail('NOT_ENOUGH_MOONSTONES', `Needs ${q.moonstones} Moonstones.`);
  s.resources.moonstones -= q.moonstones;
  for (const [k, v] of Object.entries(q.missing) as [ResourceKind, number][]) s.resources[k] += v;
  return { ok: true, state: s, events: [] };
}

function grantPurchase(s: VillageState, productId: string, transactionId: string, now: number, data: GameData): CommandResult {
  if (s.purchases.some((p) => p.id === transactionId)) return fail('ALREADY_CLAIMED', 'This purchase was already delivered.');
  const check = canPurchase(s, productId, now, data);
  if (!check.ok) return fail('PURCHASE_REFUSED', check.message);
  const product = productInfo(data, productId)!;
  s.purchases.push({ id: transactionId, productId, usd: product.usd, at: now });
  const grants = { ...product.grants };
  if (product.kind === 'pass') {
    s.pass.premium = true;
    s.pass.season = passSeason(now, data);
  }
  if (product.kind === 'offer') {
    const rule = data.offers.rules.find((o) => o.productId === productId)!;
    s.offers.bought.push(rule.id);
    s.offers.active = s.offers.active.filter((a) => a.id !== rule.id);
  }
  // Bought resources are always delivered in full, even beyond storage.
  for (const [k, v] of Object.entries(grants) as [ResourceKind, number][]) s.resources[k] += v;
  return { ok: true, state: s, events: [{ kind: 'purchase_granted', productId, usd: product.usd, grants }] };
}

function buySkin(s: VillageState, id: string, data: GameData): CommandResult {
  const skin = data.cosmetics.hallSkins.find((k) => k.id === id);
  if (!skin) return fail('NOT_FOUND', 'Unknown look.');
  if (s.cosmetics.owned.includes(id)) return fail('ALREADY_CLAIMED', 'You already own this look.');
  if (skin.passOnly) return fail('LOCKED', 'This look comes from the Lantern Pass.');
  if (s.resources.moonstones < skin.moonstones) return fail('NOT_ENOUGH_MOONSTONES', `Needs ${skin.moonstones} Moonstones.`);
  s.resources.moonstones -= skin.moonstones;
  s.cosmetics.owned.push(id);
  s.cosmetics.hallSkin = id;
  return { ok: true, state: s, events: [] };
}

/** Grant a reward bundle (resources capped by storage, Moonstones and skins in full). Mutates. */
function grantReward(s: VillageState, reward: Cost & { skin?: string }, data: GameData): Cost {
  const { skin, ...res } = reward;
  if (skin && !s.cosmetics.owned.includes(skin)) s.cosmetics.owned.push(skin);
  const soft: Cost = {};
  for (const [k, v] of Object.entries(res) as [ResourceKind, number][]) {
    if (k === 'moonstones') s.resources.moonstones += v;
    else soft[k] = v;
  }
  addCapped(s.resources, soft, capacity(s, data));
  return res;
}

function claimTask(s: VillageState, id: string, kind: 'daily' | 'weekly', data: GameData): CommandResult {
  const task = currentTasks(s, hallLevel(s, data), data).find((t) => t.id === id && t.kind === kind);
  if (!task) return fail('NOT_FOUND', 'No such task today.');
  if (task.claimed) return fail('ALREADY_CLAIMED', 'Already claimed.');
  if (task.progress < task.target) return fail('NOT_READY', 'Not finished yet.');
  (kind === 'daily' ? s.tasks.dayClaimed : s.tasks.weekClaimed).push(id);
  s.pass.points += task.points;
  return { ok: true, state: s, events: [{ kind: 'reward', source: `task:${id}`, grants: {} }] };
}

function claimTier(s: VillageState, tier: number, track: 'free' | 'premium', data: GameData): CommandResult {
  const def = data.pass.tiers.find((t) => t.tier === tier);
  if (!def) return fail('NOT_FOUND', 'No such tier.');
  if (tier > unlockedTier(s, data)) return fail('NOT_READY', 'Earn more pass points first.');
  if (track === 'premium' && !s.pass.premium) return fail('LOCKED', 'Premium rewards need the premium Lantern Pass.');
  const list = track === 'free' ? s.pass.claimedFree : s.pass.claimedPremium;
  if (list.includes(tier)) return fail('ALREADY_CLAIMED', 'Already claimed.');
  list.push(tier);
  const grants = grantReward(s, track === 'free' ? def.free : def.premium, data);
  return { ok: true, state: s, events: [{ kind: 'reward', source: `pass:${track}:${tier}`, grants }] };
}

function claimAchievement(s: VillageState, id: string, data: GameData): CommandResult {
  const view = achievementViews(s, hallLevel(s, data), data).find((v) => v.def.id === id);
  if (!view) return fail('NOT_FOUND', 'Unknown achievement.');
  if (!view.next) return fail('ALREADY_CLAIMED', 'All tiers claimed.');
  if (!view.claimable) return fail('NOT_READY', 'Not finished yet.');
  s.achievements[id] = view.claimed + 1;
  s.resources.moonstones += view.next.reward;
  return { ok: true, state: s, events: [{ kind: 'reward', source: `achievement:${id}`, grants: { moonstones: view.next.reward } }] };
}

function clearObstacle(s: VillageState, id: string, now: number, data: GameData): CommandResult {
  const b = s.buildings.find((v) => v.id === id);
  if (!b) return fail('NOT_FOUND', 'Not found.');
  const def = buildingDef(data, b.type);
  if (def.category !== 'obstacle' || !def.clear) return fail('NOT_AVAILABLE', 'That cannot be cleared.');
  if (b.upgrade) return fail('BUSY', 'Already being cleared.');
  if (!canAfford(s.resources, def.clear.cost)) return fail('NOT_ENOUGH_RESOURCES', `Not enough resources (needs ${costText(def.clear.cost)}).`);
  if (builderStatus(s, data, now).free < 1) return fail('NO_FREE_BUILDER', 'All your Beaver Builders are busy.');
  subtractCost(s.resources, def.clear.cost);
  b.upgrade = { toLevel: 0, startedAt: now, endsAt: now + def.clear.seconds * MS_PER_SECOND, cost: def.clear.cost };
  return { ok: true, state: s, events: [{ kind: 'clear_start', buildingType: b.type, id, seconds: def.clear.seconds }] };
}

// ---------- Army and raids ----------

export function trainQuote(state: VillageState, troop: string, now: number, data: GameData): QuoteResult {
  const s = advance(state, now, data).state;
  const def = data.troops[troop];
  if (!def) return fail('NOT_FOUND', 'Unknown troop.');
  const level = troopLevelOf(s, troop);
  const cost = discounted(troopLevel(data, troop, level).cost, eventEffect(now, data).trainingDiscount);
  const quote: Quote = { toLevel: level, cost, seconds: def.trainSeconds };
  if (barracksLevel(s, data) < def.barracksLevel) {
    return { ...fail('LOCKED', `Needs a level ${def.barracksLevel} Burrow Barracks.`), quote };
  }
  const cap = housingCapacity(s, data);
  if (armyHousing(s.army, data) + queueHousing(s.training, data) + def.housing > cap) {
    return { ...fail('ARMY_FULL', cap ? 'Your Army Camps are full.' : 'Build an Army Camp to house troops.'), quote };
  }
  if (!canAfford(s.resources, cost)) return { ...fail('NOT_ENOUGH_RESOURCES', `Not enough resources (needs ${costText(cost)}).`), quote };
  return { ok: true, quote };
}

function train(s: VillageState, troop: string, now: number, data: GameData): CommandResult {
  const q = trainQuote(s, troop, now, data);
  if (!q.ok) return q;
  const def = troopDef(data, troop);
  const cost = q.quote.cost;
  subtractCost(s.resources, cost);
  const startedAt = queueEndsAt(s, now);
  s.training.push({ troop, startedAt, endsAt: startedAt + def.trainSeconds * MS_PER_SECOND, cost });
  return { ok: true, state: s, events: [{ kind: 'train_start', troop, seconds: def.trainSeconds, cost }] };
}

/** A cost with a share taken off (limited-time events). */
function discounted(cost: Cost, share: number): Cost {
  if (share <= 0) return cost;
  const out: Cost = {};
  for (const [k, v] of Object.entries(cost) as [ResourceKind, number][]) out[k] = Math.round(v * (1 - share));
  return out;
}

/** Open today's free chest. Never costs anything and cannot be reopened or rerolled. */
function openDailyChest(s: VillageState, now: number, data: GameData): CommandResult {
  const day = dayIndex(now, data);
  if (s.daily.lastDay >= day) return fail('ALREADY_CLAIMED', "You've opened today's chest. A new one is ready at the start of the next day (UTC).");
  const st = streakAfterClaim(s.daily, day, data);
  const outcome = chestOutcome(s.seed, day, data);
  const grants = grantReward(s, chestContents(outcome, hallLevel(s, data), st.step, data), data);
  const history = [...s.daily.history, { day, outcome, step: st.step, grants }].slice(-data.daily.streak.historyDays);
  s.daily = { lastDay: day, step: st.step, skipsLeft: st.skipsLeft, skipWeek: st.skipWeek, history };
  return {
    ok: true,
    state: s,
    events: [
      { kind: 'daily_chest', outcome, step: st.step, grants, skipped: st.skipped, steppedBack: st.steppedBack },
      { kind: 'reward', source: `daily_chest:${outcome}`, grants },
    ],
  };
}

/** Research quote including the resource check (for the UI). */
export function researchStartQuote(state: VillageState, troop: string, now: number, data: GameData): QuoteResult {
  const s = advance(state, now, data).state;
  const q = researchQuote(s, troop, hallLevel(s, data), data);
  const quote: Quote | undefined = q.toLevel !== undefined ? { toLevel: q.toLevel, cost: q.cost ?? {}, seconds: Math.round((q.seconds ?? 0) * buildTimeFactor(s, now, data)) } : undefined;
  if (!q.ok) return { ...fail(q.code, q.message), quote };
  if (!canAfford(s.resources, q.cost)) return { ...fail('NOT_ENOUGH_RESOURCES', `Not enough resources (needs ${costText(q.cost)}).`), quote };
  return { ok: true, quote: quote! };
}

function research(s: VillageState, troop: string, now: number, data: GameData): CommandResult {
  const q = researchStartQuote(s, troop, now, data);
  if (!q.ok) return q;
  const { cost, seconds, toLevel } = q.quote;
  subtractCost(s.resources, cost);
  startResearch(s, troop, toLevel, cost, seconds, now);
  finishResearch(s, now);
  return { ok: true, state: s, events: [{ kind: 'research_start', troop, toLevel, seconds, cost }] };
}

function cancelResearch(s: VillageState, now: number, data: GameData): CommandResult {
  const a = s.research.active;
  if (!a) return fail('NOT_UPGRADING', 'Nothing to cancel.');
  s.research.active = null;
  const want: Cost = {};
  for (const k of RESOURCE_KINDS) {
    const r = Math.floor((a.cost[k] ?? 0) * data.economy.cancelRefundFraction);
    if (r > 0) want[k] = r;
  }
  const refund = addCapped(s.resources, want, capacity(s, data));
  void now;
  return { ok: true, state: s, events: [{ kind: 'research_cancel', troop: a.troop, toLevel: a.toLevel, refund }] };
}

function cancelTraining(s: VillageState, index: number, now: number, data: GameData): CommandResult {
  const item = s.training[index];
  if (!item) return fail('NOT_FOUND', 'Nothing to cancel.');
  s.training.splice(index, 1);
  if (index === 0 && s.training.length) {
    // The next item starts now.
    const first = s.training[0];
    const dur = first.endsAt - first.startedAt;
    first.startedAt = now;
    first.endsAt = now + dur;
  }
  retimeQueue(s.training, now, data);
  addCapped(s.resources, item.cost, capacity(s, data));
  return { ok: true, state: s, events: [{ kind: 'train_cancel', troop: item.troop }] };
}

export function scoutFee(state: VillageState, data: GameData): number {
  const fees = data.battle.scoutFeeByHall;
  return fees[Math.min(fees.length, hallLevel(state, data)) - 1] ?? 0;
}

/**
 * Find an opponent. The first look after each attack is free, and it stays the
 * same opponent until the player attacks it or pays the Acorn fee for "Next":
 * leaving and pressing Attack again shows the same base, so rerolling always
 * costs the fee.
 */
function scout(s: VillageState, paid: boolean, data: GameData): CommandResult {
  if (!paid && s.scout) return { ok: true, state: s, events: [{ kind: 'scout', seed: s.scout.seed, fee: 0 }] };
  const fee = paid ? scoutFee(s, data) : 0;
  if (s.resources.acorns < fee) return fail('NOT_ENOUGH_RESOURCES', `Next costs ${fee} acorns.`);
  s.resources.acorns -= fee;
  const seed = mixSeed(s.seed, s.nextSeed++);
  s.scout = { seed };
  return { ok: true, state: s, events: [{ kind: 'scout', seed, fee }] };
}

/**
 * Apply the result of an attack. The battle is re-simulated from its seed and
 * deployments, so the loot always matches what really happened.
 */
/** Reject a battle that used troops or troop levels the player does not have. */
function checkBattleSetup(s: VillageState, setup: BattleSetup, data: GameData): string | null {
  const have = battleArmy(s);
  for (const [t, n] of Object.entries(setup.army)) {
    if (!data.troops[t] || !Number.isInteger(n) || n < 0) return 'Unknown troops in battle.';
    if (n > (have[t] ?? 0)) return 'More troops than your army holds.';
  }
  for (const [t, lvl] of Object.entries(setup.levels ?? {})) {
    if (!data.troops[t] || !Number.isInteger(lvl) || lvl < 1 || lvl > troopLevelOf(s, t)) return 'Troop levels do not match your research.';
  }
  return null;
}

/** League bonus for a won attack: the full bonus at 3 stars, a third per star. */
export function leagueWinBonus(trophies: number, stars: number, data: GameData): Cost {
  const bonus = leagueFor(trophies, data).winBonus ?? {};
  const out: Cost = {};
  if (stars < 1) return out;
  for (const [k, v] of Object.entries(bonus) as [ResourceKind, number][]) {
    const amt = Math.floor((v * stars) / 3);
    if (amt > 0) out[k] = amt;
  }
  return out;
}

function battleEnd(s: VillageState, rec: Omit<BattleRecord, 'result' | 'id' | 'kind'>, now: number, data: GameData): CommandResult {
  const bad = checkBattleSetup(s, rec.setup, data);
  if (bad) return fail('INVALID_BATTLE', bad);
  const { result } = runBattle(rec.setup, rec.deployments, data, rec.endTick);
  spendTroops(s, result.used);
  const cap = capacity(s, data);
  const added = addCapped(s.resources, result.loot, cap);
  const bonusWanted = leagueWinBonus(s.trophies, result.stars, data);
  const bonus = addCapped(s.resources, bonusWanted, cap);
  for (const [k, v] of Object.entries(bonus) as [ResourceKind, number][]) added[k] = (added[k] ?? 0) + v;
  // Limited-time event: extra loot on won attacks.
  const lootBonus = result.stars >= 1 ? eventEffect(now, data).raidLootBonus : 0;
  const eventWanted: Cost = {};
  if (lootBonus > 0) for (const [k, v] of Object.entries(result.loot) as [ResourceKind, number][]) if (v > 0) eventWanted[k] = Math.floor(v * lootBonus);
  const eventBonus = addCapped(s.resources, eventWanted, cap);
  for (const [k, v] of Object.entries(eventBonus) as [ResourceKind, number][]) added[k] = (added[k] ?? 0) + v;
  const opp = rec.setup.base.trophies ?? s.trophies;
  const trophies = result.stars >= 1 ? winTrophies(s.trophies, opp, data) : -lossTrophies(s.trophies, opp, data);
  s.trophies = Math.max(0, s.trophies + trophies);
  // Attacking ends your shield, and the next look at an opponent is free again.
  s.shieldUntil = Math.min(s.shieldUntil, now);
  s.scout = null;
  const record: BattleRecord = { ...rec, id: `r${s.nextSeed++}`, kind: 'attack', at: rec.at ?? now, result: { ...result, loot: { ...result.loot } }, trophies };
  record.result.loot = added;
  if (Object.keys(bonus).length) record.leagueBonus = bonus;
  if (Object.values(eventBonus).some((v) => (v ?? 0) > 0)) record.eventBonus = eventBonus;
  s.battleLog.push(record);
  while (s.battleLog.length > data.battle.maxReplays) s.battleLog.shift();
  return { ok: true, state: s, events: [{ kind: 'raid_end', record }] };
}

/** Use donated (Grove) troops first, then your own army. Mutates. */
function spendTroops(s: VillageState, used: Record<string, number>): void {
  for (const [t, n0] of Object.entries(used)) {
    let n = n0;
    const fromGrove = Math.min(n, s.grove.reinforcements[t] ?? 0);
    if (fromGrove > 0) {
      s.grove.reinforcements[t] -= fromGrove;
      if (s.grove.reinforcements[t] <= 0) delete s.grove.reinforcements[t];
      n -= fromGrove;
    }
    s.army[t] = Math.max(0, (s.army[t] ?? 0) - n);
    if (s.army[t] === 0) delete s.army[t];
  }
}

/** Troops available for a battle: your army plus troops your Grove donated. */
export function battleArmy(state: VillageState): Record<string, number> {
  const out: Record<string, number> = { ...state.army };
  for (const [t, n] of Object.entries(state.grove.reinforcements)) out[t] = (out[t] ?? 0) + n;
  return out;
}

/** A Grove Raid attack: no loot or trophies, best stars per enemy base count. */
function groveBattleEnd(s: VillageState, target: number, rec: Omit<BattleRecord, 'result' | 'id' | 'kind'>, now: number, data: GameData): CommandResult {
  const phase = raidPhase(now, data);
  if (!s.grove.joined || phase.phase !== 'live') return fail('NOT_AVAILABLE', 'The Grove Raid is not running.');
  const raid = ensureRaid(s, now, data)!;
  if (attacksLeft(s, phase.week, data) <= 0) return fail('NOT_AVAILABLE', 'You have used both Grove Raid attacks.');
  const bad = checkBattleSetup(s, rec.setup, data);
  if (bad) return fail('INVALID_BATTLE', bad);
  const { result } = runBattle(rec.setup, rec.deployments, data, rec.endTick);
  spendTroops(s, result.used);
  raid.attacks.push({ target, stars: result.stars, destruction: result.destruction, at: now });
  return { ok: true, state: s, events: [{ kind: 'grove_attack', target, stars: result.stars, destruction: result.destruction }] };
}

export type { BattleSetup, Deployment };

function place(s: VillageState, type: BuildingType, x: number, y: number, now: number, data: GameData): CommandResult {
  const q = placeQuote(s, data, type, now);
  if (!q.ok) return q;
  if (!canPlace(s, data, type, x, y).ok) return fail('INVALID_PLACEMENT', "That spot isn't free.");
  const def = buildingDef(data, type);
  const { cost, seconds } = q.quote;
  subtractCost(s.resources, cost);
  const endsAt = now + seconds * MS_PER_SECOND;
  const b: Building = {
    id: `b${s.nextId++}`,
    type,
    level: seconds > 0 ? 0 : 1,
    x,
    y,
    upgrade: seconds > 0 ? { toLevel: 1, startedAt: now, endsAt, cost } : null,
    collector: def.produces ? { stored: 0, accrueFrom: endsAt } : null,
  };
  s.buildings.push(b);
  return { ok: true, state: s, events: [{ kind: 'upgrade_start', buildingType: type, id: b.id, toLevel: 1, seconds, cost }] };
}

function move(s: VillageState, id: string, x: number, y: number, data: GameData): CommandResult {
  const b = s.buildings.find((v) => v.id === id);
  if (!b) return fail('NOT_FOUND', 'Building not found.');
  if (!canPlace(s, data, b.type, x, y, id).ok) return fail('INVALID_PLACEMENT', "That spot isn't free.");
  b.x = x;
  b.y = y;
  return { ok: true, state: s, events: [{ kind: 'move', buildingType: b.type, id }] };
}

function upgrade(s: VillageState, id: string, now: number, data: GameData): CommandResult {
  const q = upgradeQuote(s, id, data, now);
  if (!q.ok) return q;
  const b = s.buildings.find((v) => v.id === id)!;
  const { cost, seconds, toLevel } = q.quote;
  subtractCost(s.resources, cost);
  const endsAt = now + seconds * MS_PER_SECOND;
  if (seconds <= 0) {
    b.level = toLevel;
  } else {
    if (b.collector) {
      // Bank what it holds; production pauses until the upgrade ends.
      b.collector = { stored: collectorAmount(b, now, data), accrueFrom: endsAt };
    }
    b.upgrade = { toLevel, startedAt: now, endsAt, cost };
  }
  return { ok: true, state: s, events: [{ kind: 'upgrade_start', buildingType: b.type, id, toLevel, seconds, cost }] };
}

function cancel(s: VillageState, id: string, now: number, data: GameData): CommandResult {
  const b = s.buildings.find((v) => v.id === id);
  if (!b) return fail('NOT_FOUND', 'Building not found.');
  if (!b.upgrade) return fail('NOT_UPGRADING', 'Nothing to cancel.');
  const { toLevel, cost } = b.upgrade;
  if (toLevel === 0) {
    b.upgrade = null;
  } else if (b.level < 1) {
    s.buildings = s.buildings.filter((v) => v.id !== id);
  } else {
    b.upgrade = null;
    if (b.collector) b.collector = { stored: b.collector.stored, accrueFrom: now };
  }
  const refundWanted: Cost = {};
  for (const k of RESOURCE_KINDS) {
    const r = Math.floor((cost[k] ?? 0) * data.economy.cancelRefundFraction);
    if (r > 0) refundWanted[k] = r;
  }
  const refund = addCapped(s.resources, refundWanted, capacity(s, data));
  return { ok: true, state: s, events: [{ kind: 'upgrade_cancel', buildingType: b.type, id, toLevel, refund }] };
}

function collect(s: VillageState, id: string, now: number, data: GameData): CommandResult {
  const b = s.buildings.find((v) => v.id === id);
  if (!b) return fail('NOT_FOUND', 'Building not found.');
  const resource = buildingDef(data, b.type).produces;
  if (!b.collector || !resource) return fail('NOTHING_TO_COLLECT', 'This building does not produce anything.');
  const amount = collectorAmount(b, now, data);
  if (Math.floor(amount) < data.economy.minCollectAmount) return fail('NOTHING_TO_COLLECT', 'Nothing to collect yet.');
  const room = Math.max(0, capacity(s, data)[resource] - s.resources[resource]);
  if (room <= 0) return fail('STORAGE_FULL', `Your ${resource} storage is full. Build or upgrade storage.`);
  const take = Math.min(Math.floor(amount), room);
  // Limited-time event: collecting gives extra, as far as storage allows.
  const extra = Math.min(room - take, Math.floor(take * eventEffect(now, data).collectBonus));
  s.resources[resource] += take + extra;
  // While an upgrade runs, production stays paused until it ends.
  b.collector = { stored: amount - take, accrueFrom: b.upgrade ? b.upgrade.endsAt : now };
  return { ok: true, state: s, events: [{ kind: 'collect', buildingType: b.type, id, resource, amount: take + extra, ...(extra > 0 ? { eventBonus: extra } : {}) }] };
}
