/** Shared simulation types. No rendering code may live in src/sim. */

export type ResourceKind = 'acorns' | 'dew' | 'nightsap' | 'moonstones';
export const RESOURCE_KINDS: readonly ResourceKind[] = ['acorns', 'dew', 'nightsap', 'moonstones'];

export type Resources = Record<ResourceKind, number>;
export type Cost = Partial<Record<ResourceKind, number>>;

export type BuildingType = string;
export type BuildingCategory = 'hall' | 'collector' | 'storage' | 'builder' | 'military' | 'defense' | 'hedge' | 'trap' | 'decor' | 'obstacle' | 'social' | 'guardian';

export interface UpgradeTimer {
  /** Level the building will have when the timer ends. */
  toLevel: number;
  startedAt: number;
  endsAt: number;
  /** What was paid, so a cancel can refund part of it. */
  cost: Cost;
}

export interface CollectorState {
  /** Output already banked in the collector (not yet in storage). */
  stored: number;
  /** Production accrues from this timestamp at the building's current rate. */
  accrueFrom: number;
}

export interface Building {
  id: string;
  type: BuildingType;
  /** 0 means "under construction, not finished yet". */
  level: number;
  /** Top-left tile of the footprint. */
  x: number;
  y: number;
  upgrade: UpgradeTimer | null;
  collector: CollectorState | null;
}

export interface TrainingItem {
  troop: string;
  startedAt: number;
  endsAt: number;
  cost: Cost;
}

/** Troop research done in the Burrow Barracks (one at a time, no builder needed). */
export interface ResearchState {
  /** Researched level per troop type; missing means level 1. */
  levels: Record<string, number>;
  active: { troop: string; toLevel: number; startedAt: number; endsAt: number; cost: Cost } | null;
}

export interface VillageState {
  createdAt: number;
  /** Last time the game was open (used for offline progress). */
  lastSeenAt: number;
  resources: Resources;
  buildings: Building[];
  nextId: number;
  /** Trained troops ready to attack, by troop type. */
  army: Record<string, number>;
  /** Barracks queue; items finish one after another. */
  training: TrainingItem[];
  /** Troop levels and the research in progress. */
  research: ResearchState;
  /** The opponent found by scouting, kept until it is attacked or the player pays for Next. */
  scout: { seed: number } | null;
  /** Attacks this player made, newest last (for replays). */
  battleLog: import('./battle/types').BattleRecord[];
  /** Per-village seed and counter for deterministic generation (opponents, raids). */
  seed: number;
  nextSeed: number;
  /** Leaf rank. */
  trophies: number;
  /** No raids against this village before this time. */
  shieldUntil: number;
  /** Raids against this village, newest last. */
  defenseLog: import('./battle/types').BattleRecord[];
  /** Monthly season (UTC year * 12 + month) last processed. */
  season: number;
  /** Offline raids have been simulated up to this time. */
  raidCheckAt: number;
  /** Lifetime counters used by tasks, achievements and offers. */
  stats: Stats;
  /** Real-money purchases (for the spend summary and the minor spending cap). */
  purchases: PurchaseRecord[];
  profile: { under18: boolean | null };
  offers: { active: ActiveOffer[]; lastShown: Record<string, number>; bought: string[] };
  pass: { season: number; points: number; premium: boolean; claimedFree: number[]; claimedPremium: number[] };
  tasks: { day: number; dayBaseline: Stats; dayClaimed: string[]; week: number; weekBaseline: Stats; weekClaimed: string[] };
  cosmetics: { owned: string[]; hallSkin: string };
  /** Achievement id -> number of tiers claimed. */
  achievements: Record<string, number>;
  flags: { longWaitSeen: boolean };
  grove: GroveState;
  /** What a multiplayer server has already given this village (see sim/net.ts). */
  net: NetState;
  /** Guided first steps for new players. */
  tutorial: { step: number; done: boolean };
  /** Free daily chest and visit streak. */
  daily: DailyState;
}

export interface DailyState {
  /** Day index (pass days) the chest was last opened; -1 = never. */
  lastDay: number;
  /** Current step on the streak ladder (0 before the first chest). */
  step: number;
  /** Free skips left this week, and the week they belong to. */
  skipsLeft: number;
  skipWeek: number;
  /** Recent chests, newest last. */
  history: { day: number; outcome: string; step: number; grants: Cost }[];
}

export interface NetState {
  /** Server account these markers belong to (reset when it changes). */
  playerId: string | null;
  /** Real raids from the server applied up to this time. */
  defensesSince: number;
  /** Server donation ids already added to the Grove Lodge. */
  donations: string[];
  /** Server Grove Raid weeks whose chest was collected. */
  raidWeeks: number[];
}

export interface ChatMessage {
  at: number;
  /** Member index, or -1 for the player. */
  from: number;
  text: string;
  kind: 'chat' | 'request' | 'donation' | 'system';
}

export interface BotRequest {
  id: string;
  at: number;
  member: number;
  troop: string;
  /** Housing space requested and donated so far. */
  size: number;
  donated: number;
}

export interface GroveRaidState {
  week: number;
  /** Player's attacks: target enemy base index and stars won. */
  attacks: { target: number; stars: number; destruction: number; at: number }[];
  paidOut: boolean;
  result: { ours: number; theirs: number; outcome: 'win' | 'draw' | 'loss' } | null;
}

export interface GroveState {
  joined: boolean;
  seed: number;
  joinedAt: number;
  xp: number;
  chat: ChatMessage[];
  /** Bot activity has been generated up to this time. */
  processedAt: number;
  requests: BotRequest[];
  myRequest: { at: number; chunks: number } | null;
  reinforcements: Record<string, number>;
  raid: GroveRaidState | null;
  raidHistory: { week: number; ours: number; theirs: number; outcome: 'win' | 'draw' | 'loss'; reward: Cost }[];
  prepOfferWeek: number;
  /** Every Grove Raid up to and including this week has been paid out. */
  settledWeek: number;
}

/**
 * Lifetime counters. `upgradesDone` and `troopsTrained` count finished work
 * (cancelled timers never count), so tasks cannot be farmed by start-and-cancel.
 */
export type StatKey = 'collectedAcorns' | 'collectedDew' | 'upgradesStarted' | 'upgradesDone' | 'troopsTrained' | 'raidsWon' | 'starsEarned' | 'obstaclesCleared' | 'moonstonesSpent' | 'donations';
export type Stats = Record<StatKey, number>;
export const STAT_KEYS: readonly StatKey[] = ['collectedAcorns', 'collectedDew', 'upgradesStarted', 'upgradesDone', 'troopsTrained', 'raidsWon', 'starsEarned', 'obstaclesCleared', 'moonstonesSpent', 'donations'];
export function emptyStats(): Stats {
  return Object.fromEntries(STAT_KEYS.map((k) => [k, 0])) as Stats;
}

export interface PurchaseRecord {
  id: string;
  productId: string;
  usd: number;
  at: number;
}

export interface ActiveOffer {
  id: string;
  shownAt: number;
  expiresAt: number;
}

// ---- Balance data (loaded from src/data/*.json) ----

export interface LevelDef {
  level: number;
  cost: Cost;
  buildSeconds: number;
  hp: number;
  ratePerHour?: number;
  storage?: Cost;
  /** Army Camp capacity. */
  housing?: number;
  /** Damage per shot for defenses and traps. */
  damage?: number;
  /** Grove Lodge: housing space for donated troops. */
  reinforcement?: number;
  /** Guardian Burrow: the guardian animals that rush out during a raid. */
  guardians?: Record<string, { count: number; level: number }>;
}

export type TargetLayer = 'ground' | 'air' | 'both';

export interface CombatDef {
  targets: TargetLayer;
  range: number;
  minRange?: number;
  fireIntervalTicks: number;
  splashRadius?: number;
  projectile: string;
  projectileSpeed: number;
}

export interface TroopLevelDef {
  level: number;
  hp: number;
  damage: number;
  /** Training cost per troop at this level. */
  cost: Cost;
  /** What researching this level costs (absent on level 1). */
  research?: { cost: Cost; seconds: number };
}

export interface TroopDef {
  name: string;
  description: string;
  housing: number;
  attackIntervalTicks: number;
  range: number;
  /** Tiles per tick. */
  speed: number;
  air: boolean;
  prefers: 'any' | 'defense';
  ignoresHedges: boolean;
  trainSeconds: number;
  barracksLevel: number;
  levels: TroopLevelDef[];
  projectile?: string;
  projectileSpeed?: number;
  splashRadius?: number;
}

export interface BattleDef {
  ticksPerSecond: number;
  durationSeconds: number;
  starThresholds: { destruction: number; full: number };
  deployMarginTiles: number;
  hedgePathCost: number;
  maxReplays: number;
  scoutFeeByHall: number[];
  generatedLootByHall: { min: number; max: number }[];
  lootShares: { storage: number; collector: number; hall: number };
  catapultSpread: number;
  deploySpread: number;
  /** Generated base layout by hall level: 2-tile gaps in the hedge ring, and an inner ring around the Elder Toadstool. */
  baseLayoutByHall?: { hedgeGaps: number; innerRing: boolean }[];
  /** When an attack counts as a close call (shown after the battle, only if true). */
  closeCall: { starMargin: number; hallHpFraction: number; buildingsLeft: number; perfectMinDestruction: number };
}

export interface NamesDef {
  placeFirst: string[];
  placeSecond: string[];
  playerFirst: string[];
  playerSecond: string[];
}

export interface BuildingDef {
  name: string;
  description: string;
  size: number;
  category: BuildingCategory;
  produces?: ResourceKind;
  inShop: boolean;
  combat?: CombatDef;
  /** Forest obstacles: what clearing costs and the Moonstones it gives. */
  clear?: { cost: Cost; seconds: number; moonstones: number };
  levels: LevelDef[];
}

export interface BuildingLimit {
  count: number;
  maxLevel: number;
}

export interface HallLevelDef {
  level: number;
  /** Highest troop level that can be researched at this hall level. */
  troopLevelCap: number;
  limits: Record<BuildingType, BuildingLimit>;
}

export interface StartingBuilding {
  type: BuildingType;
  x: number;
  y: number;
  level: number;
}

export interface EconomyDef {
  mapSize: number;
  startingResources: Resources;
  startingLayout: StartingBuilding[];
  collectorHoursCap: number;
  raidableStoredFraction: number;
  raidableUncollectedFraction: number;
  cancelRefundFraction: number;
  welcomeBackMinAwaySeconds: number;
  collectBubbleMinFraction: number;
  minCollectAmount: number;
  builderHutCosts: number[];
  obstacles: { count: number; kinds: string[]; keepClearRadius: number };
  /**
   * Multiplier on the Acorns and Dew in fixed rewards (league chests, Grove
   * Raid chests) by the player's Elder Toadstool level, so a reward is worth
   * about the same share of progress at every hall. Data amounts are for 1.0.
   */
  rewardScaleByHall: number[];
}

export interface LeagueDef {
  id: string;
  name: string;
  min: number;
  /** Monthly chest; Acorns and Dew are scaled by `rewardScaleByHall`. */
  chest: Cost;
  /** Extra loot for a won attack in this league (paid in full at 3 stars, a third per star). */
  winBonus: Cost;
}

export interface RanksDef {
  startingTrophies: number;
  attackWin: { base: number; perTrophyDiff: number; min: number; max: number };
  attackLoss: { base: number; perTrophyDiff: number; min: number; max: number };
  matchTrophyRange: number;
  seasonResetFloor: number;
  leagues: LeagueDef[];
  /**
   * Generated opponents and bot raiders are picked by trophies. Strength is
   * measured in Elder Toadstool levels: `trophies / trophiesPerHall`, so hall
   * h covers strength [h-1, h). The fractional part sets how close the base's
   * buildings are to that hall's caps.
   */
  matchmaking: {
    trophiesPerHall: number;
    /** Random spread of an opponent's strength around yours (hall levels). */
    strengthJitter: number;
    /** Opponents are kept within these many hall levels below / above yours (can be fractional, in strength units). */
    hallsBelow: number;
    hallsAbove: number;
    /** Random spread of an opponent's trophies around its strength. */
    trophyJitter: number;
    /**
     * Opponents are never weaker than the player's development: the floor
     * rises from `hallsBelow` levels down (army not built up yet) to the
     * player's own level as their Army Camps and research catch up.
     */
    readinessFloor?: boolean;
  };
  /** Loot multiplier when the target's Elder Toadstool is lower than the attacker's (index = difference). */
  lootPenaltyByHallDiff: number[];
}

export interface RaidsDef {
  newPlayerShieldHours: number;
  /** Shield after a raid, by destruction (highest tier reached wins). */
  shieldTiers: { destruction: number; hours: number }[];
  /**
   * Bot raids are scheduled on the real clock: each slot of `slotMinutes`
   * (counted from the Unix epoch) holds a raid with `chancePerSlot`, at a time
   * fixed by the village seed. A raid lands if the game was closed then and no
   * shield was up, so how often the player checks in does not matter.
   */
  slotMinutes: number;
  chancePerSlot: number;
  /** No raid in the first minutes after closing the game. */
  graceMinutes: number;
  /** Safety cap on raids simulated in one catch-up. */
  maxRaidsPerCatchUp: number;
  maxDefenseLog: number;
  /** Bot army make-up by attacker hall level: share of housing per troop. */
  botArmyMix: Record<string, number>[];
  /** Most of each resource raiders can take from storages, by the defender's hall level. */
  storageLootCapByHall: number[];
}

export interface PackDef {
  id: string;
  name: string;
  usd: number;
  moonstones: number;
}

export interface StoreDef {
  currency: string;
  packs: PackDef[];
  skipCurve: [number, number][];
  topUpCurve: [number, number][];
  minorMonthlyCapUsd: number;
}

export type OfferTrigger = 'first_long_wait' | 'all_builders_busy' | 'grove_raid_soon' | 'heavy_defense_loss';

export interface OfferRule {
  id: string;
  trigger: OfferTrigger;
  title: string;
  description: string;
  productId: string;
  usd: number;
  contents: Cost;
  durationHours: number;
  oncePerAccount: boolean;
  cooldownHours: number;
  /** Do not show this offer to brand-new players. */
  minAccountHours?: number;
}

export interface OffersDef {
  durationHoursMin: number;
  durationHoursMax: number;
  maxPerSession: number;
  rules: OfferRule[];
}

export interface PassReward extends Cost {
  skin?: never;
}

export interface TaskTemplate {
  id: string;
  text: string;
  stat: StatKey;
  base: number;
  perHall: number;
}

export interface PassDef {
  name: string;
  epoch: number;
  seasonDays: number;
  pointsPerTier: number;
  productId: string;
  usd: number;
  premiumBuildSpeedBonus: number;
  tiers: { tier: number; free: Cost & { skin?: string }; premium: Cost & { skin?: string } }[];
  dailyTaskPoints: number;
  weeklyChallengePoints: number;
  dailyTasks: TaskTemplate[];
  weeklyChallenges: TaskTemplate[];
  weeklyCount: number;
}

export interface SkinDef {
  id: string;
  name: string;
  moonstones: number;
  passOnly?: boolean;
  cap: string;
  spots: string;
}

export interface AchievementDef {
  id: string;
  name: string;
  text: string;
  stat: StatKey | 'hallLevel';
  tiers: [number, number][];
}

export interface SocialDef {
  membersMin: number;
  membersMax: number;
  groveNames: { first: string[]; second: string[] };
  colors: string[];
  chatSlotMinutes: number;
  chatChancePerSlot: number;
  requestChancePerSlot: number;
  requestSizes: number[];
  requestTroops: string[];
  requestLifetimeHours: number;
  maxChat: number;
  requestCooldownMinutes: number;
  /** Chat messages one player may post per minute on the server. */
  chatPerMinute: number;
  reinforcementChunkMinutes: number;
  reinforcementChunkHousing: number;
  xpPerHousing: number;
  xpLevels: number[];
  chatLines: Record<'random' | 'greet' | 'thanks' | 'raidStart' | 'raidEnd' | 'reply' | 'donated', string[]>;
  profanity: string[];
  groveRaid: {
    epoch: number;
    durationHours: number;
    attacksPerMember: number;
    prepOfferHours: number;
    starOdds: { base3: number; base2: number; base1: number; perHallDiff: number };
    rewards: Record<'win' | 'draw' | 'loss', Cost & { xp: number }>;
  };
}

export interface DailyDef {
  chest: { outcomes: { id: string; label: string; weight: number; reward: Cost }[] };
  streak: { steps: { bonus: number; moonstones?: number }[]; skipsPerWeek: number; stepsLostPerMissedDay: number; historyDays: number };
}

export interface EventEffect {
  /** Extra share when collecting from collectors. */
  collectBonus?: number;
  /** Extra share of the loot from a won attack. */
  raidLootBonus?: number;
  /** Share taken off troop training costs. */
  trainingDiscount?: number;
}

export interface EventsDef {
  /** Schedule start (UTC ms); the schedule repeats every `periodDays`. */
  epoch: number;
  periodDays: number;
  schedule: { id: string; name: string; description: string; startHour: number; durationHours: number; effect: EventEffect }[];
}

export interface NotificationsDef {
  maxPerDay: number;
  /** Local hours; reminders that would land in between wait until `end`. */
  quietHours: { start: number; end: number };
  /** In priority order: when a day has too many, the earlier types win. */
  types: { id: string; label: string; default: boolean }[];
}

export interface GuardianDef {
  name: string;
  description: string;
  air: boolean;
  /** Which attacking troops it can hit. */
  targets: TargetLayer;
  range: number;
  speed: number;
  attackIntervalTicks: number;
  projectile?: string;
  projectileSpeed?: number;
  levels: { level: number; hp: number; damage: number }[];
}

export interface GuardiansDef {
  /** Guardians come out when an attacking troop gets this close to the burrow (tiles). */
  triggerRange: number;
  /** They chase attackers only this far from the burrow, then walk back. */
  leashRange: number;
  /** One guardian comes out every this many ticks. */
  releaseIntervalTicks: number;
  /** Attacking troops that can hit a guardian fight it when it is this much beyond their range. */
  engageRange: number;
  /** Target guardian strength at each hall's burrow cap, as a share of a full matched army's strength. */
  strengthShareByHall: number[];
  animals: Record<string, GuardianDef>;
}

export interface GameData {
  buildings: Record<BuildingType, BuildingDef>;
  hall: { levels: HallLevelDef[] };
  economy: EconomyDef;
  troops: Record<string, TroopDef>;
  battle: BattleDef;
  names: NamesDef;
  ranks: RanksDef;
  raids: RaidsDef;
  store: StoreDef;
  offers: OffersDef;
  pass: PassDef;
  cosmetics: { hallSkins: SkinDef[] };
  achievements: AchievementDef[];
  social: SocialDef;
  daily: DailyDef;
  events: EventsDef;
  notifications: NotificationsDef;
  guardians: GuardiansDef;
}
