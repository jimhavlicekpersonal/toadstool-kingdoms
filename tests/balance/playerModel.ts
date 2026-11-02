/**
 * A simple model player used to tune progression. It plays through the real
 * game rules (applyCommand, matchmaking, real battles, offline raids) with a
 * fake clock. Nothing about loot is assumed: every raid is a real battle.
 *
 * Assumptions (documented so the balance targets mean something):
 * - Each session it collects everything, opens the daily chest (its streak
 *   never breaks), raids if its army is at least 80%
 *   full, refills the army, researches, then spends on a priority list (Elder
 *   Toadstool > storage it needs > army buildings > collectors > other
 *   storage > defenses and traps), saving half the next Elder Toadstool's cost
 *   before buying extras and keeping a builder free when the Elder Toadstool
 *   is nearly affordable.
 * - Raids: it scouts the matched opponent, presses Next (paying the fee) up to
 *   `maxNext` times while the loot on offer is below average for its hall,
 *   then attacks with its whole army using the simple bot plan (everything
 *   from one side, toughest troops first). A human usually does better.
 * - The army follows the bot army mix for its hall, using unlocked troops.
 * - Limited-time events (events.json) apply as they would for a player.
 * - Between sessions, real offline bot raids run against the real layout.
 */
import { armyHousing, barracksLevel, housingCapacity, queueHousing } from '../../src/sim/army';
import { createBattle, runBattle, type BattleSim } from '../../src/sim/battle/battle';
import type { BaseLayout, Deployment } from '../../src/sim/battle/types';
import { totalLoot } from '../../src/sim/battle/basegen';
import { FakeClock } from '../../src/sim/clock';
import { buildingDef, levelDef, troopLevel } from '../../src/sim/data';
import { botDeployments } from '../../src/sim/defense';
import { findFreeSpot } from '../../src/sim/grid';
import { opponentFor } from '../../src/sim/matchmaking';
import { computeOfflineProgress } from '../../src/sim/offline';
import { troopLevels } from '../../src/sim/research';
import { capacity, collectorAmount } from '../../src/sim/resources';
import { createRng, mixSeed } from '../../src/sim/rng';
import type { GameData, VillageState } from '../../src/sim/types';
import { advance, applyCommand, battleArmy, builderStatus, countOfType, createNewVillage, hallLevel, limitFor, researchStartQuote, scoutFee, type Command } from '../../src/sim/village';

export interface ModelOptions {
  /** Max raids per session (armies permitting). */
  raidsPerSession: number;
  /** Max paid "Next" presses per raid. */
  maxNext?: number;
  /** When the village is created (changes its seed); default 2026-01-05 08:00 UTC. */
  startAt?: number;
  /** Housing shares to train toward instead of the bot mix (unlocked troops only). */
  armyMix?: Record<string, number>;
  /** How troops are deployed (default: the bot plan, everything from one side). */
  deployPlan?: (deployable: Uint8Array, size: number, army: Record<string, number>, seed: number, data: GameData, levels: Record<string, number>) => Deployment[];
  /** Build defenses before collectors and extra storage. */
  defenseFirst?: boolean;
  /** Called after each raid with the finished battle (for analysis tools). */
  onRaid?: (info: { hall: number; base: BaseLayout; sim: BattleSim; loot: number; trophies: number; armyCost: number; at: number }) => void;
  /** Called at the end of each session (for analysis tools). */
  onSession?: (info: { hall: number; at: number; actions: number; buildersIdle: number; storageFull: boolean; raided: boolean }) => void;
}

export interface RaidLog {
  hall: number;
  opponentHall: number;
  stars: number;
  destruction: number;
  loot: number;
  trophies: number;
}

export class ModelPlayer {
  clock: FakeClock;
  state: VillageState;
  hallReachedAt: Record<number, number> = {};
  raids = 0;
  raidLog: RaidLog[] = [];
  defenseLog: { hall: number; stars: number; destruction: number; lost: number }[] = [];
  private readonly t0: number;

  constructor(private readonly data: GameData, private readonly opts: ModelOptions) {
    this.clock = new FakeClock(opts.startAt ?? Date.UTC(2026, 0, 5, 8, 0, 0));
    this.state = createNewVillage(this.clock.now(), data);
    this.t0 = this.clock.now();
    this.hallReachedAt[1] = 0;
  }

  elapsedHours(): number {
    return (this.clock.now() - this.t0) / 3_600_000;
  }

  /** Commands that moved the village forward this session (builds, upgrades, research). */
  private actions = 0;

  private run(cmd: Command): boolean {
    const r = applyCommand(this.state, cmd, this.clock.now(), this.data);
    if (r.ok) {
      this.state = r.state;
      if (cmd.type === 'place' || cmd.type === 'upgrade' || cmd.type === 'research') this.actions++;
    }
    return r.ok;
  }

  private noteHall(): void {
    const hl = hallLevel(this.state, this.data);
    for (let l = 1; l <= hl; l++) if (this.hallReachedAt[l] === undefined) this.hallReachedAt[l] = this.elapsedHours();
  }

  /** Let time pass with the game closed (offline raids apply). */
  away(ms: number): void {
    this.clock.advance(ms);
    const r = computeOfflineProgress(this.state, this.clock.now(), this.data);
    this.state = r.state;
    for (const d of r.summary.raids) this.defenseLog.push({ hall: hallLevel(this.state, this.data), stars: d.result.stars, destruction: d.result.destruction, lost: (d.result.loot.acorns ?? 0) + (d.result.loot.dew ?? 0) });
    this.state.defenseLog = [];
    this.noteHall();
  }

  /** Let time pass with the game open (no raids against us). */
  wait(ms: number): void {
    this.clock.advance(ms);
    this.state = advance(this.state, this.clock.now(), this.data).state;
    this.state.lastSeenAt = this.clock.now();
    this.state.raidCheckAt = this.clock.now();
    this.noteHall();
  }

  session(): void {
    const d = this.data;
    this.state = advance(this.state, this.clock.now(), d).state;
    this.noteHall();
    this.actions = 0;
    const raidsBefore = this.raids;
    for (const b of this.state.buildings) if (d.buildings[b.type].produces) this.run({ type: 'collect', id: b.id });
    // The free daily chest (fails harmlessly once today's is open).
    this.run({ type: 'openDailyChest' });
    this.raid();
    this.train();
    this.research();
    this.spend();
    this.train();
    this.state.lastSeenAt = this.clock.now();
    if (this.opts.onSession) {
      const cap = capacity(this.state, d);
      const bs = builderStatus(this.state, d, this.clock.now());
      this.opts.onSession({
        hall: hallLevel(this.state, d),
        at: this.clock.now(),
        actions: this.actions,
        buildersIdle: bs.free,
        storageFull: this.state.resources.acorns >= cap.acorns || this.state.resources.dew >= cap.dew,
        raided: this.raids > raidsBefore,
      });
    }
  }

  private hallCost(): Record<string, number> {
    const hl = hallLevel(this.state, this.data);
    const next = levelDef(this.data, 'elder_toadstool', hl + 1);
    return (next?.cost ?? {}) as Record<string, number>;
  }

  private spend(): void {
    const d = this.data;
    for (let guard = 0; guard < 40; guard++) {
      const now = this.clock.now();
      if (builderStatus(this.state, d, now).free < 1) return;
      const hall = this.state.buildings.find((b) => b.type === 'elder_toadstool')!;
      if (!hall.upgrade && this.run({ type: 'upgrade', id: hall.id })) continue;
      const need = this.hallCost();
      const cap = capacity(this.state, d);
      const res = this.state.resources as Record<string, number>;
      const capR = cap as Record<string, number>;
      const hallSoon = Object.keys(need).length > 0 && Object.entries(need).every(([k, v]) => res[k] >= v * 0.6 && capR[k] >= v);
      // Keep the last free builder for the Elder Toadstool when it is nearly affordable.
      if (hallSoon && builderStatus(this.state, d, now).free <= 1) return;
      const costOf = (cmd: Command): Record<string, number> => {
        if (cmd.type === 'place') return (d.buildings[cmd.buildingType].levels[0].cost ?? {}) as Record<string, number>;
        if (cmd.type === 'upgrade') {
          const b = this.state.buildings.find((x) => x.id === cmd.id)!;
          return (levelDef(d, b.type, b.level + 1)?.cost ?? {}) as Record<string, number>;
        }
        return {};
      };
      const options: { cmd: Command; prio: number }[] = [];
      const consider = (type: string, prio: number) => {
        const def = buildingDef(d, type);
        const lim = limitFor(this.state, d, type);
        for (const b of this.state.buildings) {
          if (b.type !== type || b.upgrade || b.level >= lim.maxLevel) continue;
          options.push({ cmd: { type: 'upgrade', id: b.id }, prio: prio + b.level * 0.01 });
        }
        if (countOfType(this.state, type) < lim.count && def.inShop) {
          const spot = findFreeSpot(this.state, d, type, 20, 20);
          if (spot) options.push({ cmd: { type: 'place', buildingType: type, x: spot.x, y: spot.y }, prio: prio - 0.5 });
        }
      };
      const storageShort = Object.entries(need).some(([k, v]) => v > (cap as Record<string, number>)[k]);
      for (const t of ['acorn_silo', 'dew_cistern']) consider(t, storageShort ? 0 : 3);
      for (const t of ['army_camp', 'burrow_barracks']) consider(t, 1);
      for (const t of ['acorn_orchard', 'dewdrop_well']) consider(t, 2);
      for (const t of ['acorn_cannon', 'wasp_nest', 'pinecone_catapult', 'firefly_tower', 'guardian_burrow', 'thorn_snare', 'sap_puddle']) consider(t, this.opts.defenseFirst ? 1.5 : 4);
      options.sort((a, b) => a.prio - b.prio);
      let did = false;
      for (const o of options) {
        // Extras (army, defenses) only if they leave enough saved for the next Elder Toadstool.
        if (o.prio >= 3 || (this.opts.defenseFirst && o.prio === 1.5)) {
          const c = costOf(o.cmd);
          if (Object.entries(c).some(([k, v]) => res[k] - v < (need[k] ?? 0) * 0.5)) continue;
        }
        if (!this.run(o.cmd)) continue;
        did = true;
        break;
      }
      if (!did) return;
    }
  }

  /** Housing shares to train toward: the bot mix for this hall, using unlocked troops. */
  private mix(): [string, number][] {
    const d = this.data;
    const bl = barracksLevel(this.state, d);
    const mixes = d.raids.botArmyMix;
    const want = this.opts.armyMix ?? mixes[Math.min(mixes.length, hallLevel(this.state, d)) - 1];
    const ok = Object.entries(want).filter(([t]) => d.troops[t].barracksLevel <= bl);
    const sum = ok.reduce((a, [, v]) => a + v, 0);
    if (!ok.length || sum <= 0) return [['hedgehog_roller', 1]];
    return ok.map(([t, v]) => [t, v / sum]);
  }

  private train(): void {
    const d = this.data;
    const mix = this.mix();
    if (!mix.length) return;
    for (let i = 0; i < 400; i++) {
      const cap = housingCapacity(this.state, d);
      const used = armyHousing(this.state.army, d) + queueHousing(this.state.training, d);
      if (used >= cap) return;
      // Train the troop furthest below its share; fall back to the cheapest.
      const have: Record<string, number> = { ...this.state.army };
      for (const q of this.state.training) have[q.troop] = (have[q.troop] ?? 0) + 1;
      const order = mix
        .map(([t, share]) => ({ t, gap: share * cap - (have[t] ?? 0) * d.troops[t].housing }))
        .sort((a, b) => b.gap - a.gap);
      let trained = false;
      for (const o of order) {
        if (o.gap < d.troops[o.t].housing && o !== order[order.length - 1]) continue;
        if (this.run({ type: 'train', troop: o.t })) {
          trained = true;
          break;
        }
      }
      if (!trained && !this.run({ type: 'train', troop: 'hedgehog_roller' })) return;
    }
  }

  /** Research the most used unlocked troop that can go up a level, if it leaves 30% of Dew storage for the rest. */
  private research(): void {
    if (this.state.research.active) return;
    const d = this.data;
    const reserve = capacity(this.state, d).dew * 0.3;
    for (const [t] of this.mix().sort((a, b) => b[1] - a[1])) {
      const q = researchStartQuote(this.state, t, this.clock.now(), d);
      if (!q.ok || this.state.resources.dew - (q.quote.cost.dew ?? 0) < reserve) continue;
      if (this.run({ type: 'research', troop: t })) return;
    }
  }

  private raid(): void {
    const d = this.data;
    for (let r = 0; r < this.opts.raidsPerSession; r++) {
      const cap = housingCapacity(this.state, d);
      const have = armyHousing(this.state.army, d);
      if (!cap || have < cap * 0.8) return;
      const hl = hallLevel(this.state, d);
      const range = d.battle.generatedLootByHall[hl - 1];
      const avg = (range.min + range.max) / 2;
      let seed = this.scout(false);
      if (seed === null) return;
      let base = opponentFor(seed, this.state, d);
      for (let n = 0; n < (this.opts.maxNext ?? 2); n++) {
        const offer = totalLoot(base);
        if ((offer.acorns ?? 0) + (offer.dew ?? 0) >= avg * 2 || this.state.resources.acorns < scoutFee(this.state, d) * 3) break;
        const next = this.scout(true);
        if (next === null) break;
        seed = next;
        base = opponentFor(seed, this.state, d);
      }
      const army = battleArmy(this.state);
      const levels = troopLevels(this.state, d);
      const setup = { seed: mixSeed(seed, 0xba771e), base, army, levels };
      const probe = createBattle(setup, d);
      const deployments = this.opts.deployPlan
        ? this.opts.deployPlan(probe.deployable, probe.grid.size, army, seed, d, levels)
        : botDeployments(probe.deployable, probe.grid.size, army, createRng(seed), d, levels);
      const before = this.state.resources.acorns + this.state.resources.dew;
      const armyCost = Object.entries(army).reduce((sum, [t, n]) => sum + n * (troopLevel(d, t, levels[t] ?? 1).cost.dew ?? 0), 0);
      const res = applyCommand(this.state, { type: 'battleEnd', record: { at: this.clock.now(), opponentName: base.name, setup, deployments } }, this.clock.now(), d);
      if (!res.ok) throw new Error(`battleEnd failed: ${res.message}`);
      this.state = res.state;
      const rec = this.state.battleLog[this.state.battleLog.length - 1];
      const loot = this.state.resources.acorns + this.state.resources.dew - before;
      this.raidLog.push({ hall: hl, opponentHall: base.hallLevel, stars: rec.result.stars, destruction: rec.result.destruction, loot, trophies: this.state.trophies });
      if (this.opts.onRaid) this.opts.onRaid({ hall: hl, base, sim: runBattle(setup, deployments, d).sim, loot, trophies: this.state.trophies, armyCost, at: this.clock.now() });
      // Replays are not needed here, and cloning them on every command is slow.
      this.state.battleLog = [];
      this.raids++;
    }
  }

  private scout(paid: boolean): number | null {
    const r = applyCommand(this.state, { type: 'scout', paid }, this.clock.now(), this.data);
    if (!r.ok) return null;
    this.state = r.state;
    const e = r.events.find((x) => x.kind === 'scout');
    return e && e.kind === 'scout' ? e.seed : null;
  }

  /** Total resources waiting in collectors (for debugging). */
  waiting(): number {
    return this.state.buildings.reduce((s, b) => s + collectorAmount(b, this.clock.now(), this.data), 0);
  }
}

/** First hour: continuous play, a session every `stepMin` minutes. */
export function activeHour(p: ModelPlayer, minutes = 60, stepMin = 2): void {
  for (let m = 0; m < minutes; m += stepMin) {
    p.session();
    p.wait(stepMin * 60_000);
  }
}

/** Normal play: 4 sessions a day (8:00, 12:30, 18:00, 22:00 UTC here), the game closed in between. */
export function normalDays(p: ModelPlayer, days: number, onDay?: (day: number) => void, sessionsAt = [8 * 60, 12.5 * 60, 18 * 60, 22 * 60]): void {
  const dayStart = (t: number) => Math.floor(t / 86_400_000) * 86_400_000;
  for (let day = 0; day < days; day++) {
    const base = dayStart(p.clock.now()) + (day === 0 ? 0 : 0);
    for (const m of sessionsAt) {
      const t = base + m * 60_000;
      if (t <= p.clock.now()) continue;
      p.away(t - p.clock.now());
      // A session lasts ~10 minutes: play, then a second round after training.
      p.session();
      p.wait(10 * 60_000);
      p.session();
    }
    // Sleep until the next morning.
    const next = dayStart(p.clock.now()) + 86_400_000;
    p.away(next - p.clock.now());
    onDay?.(day + 1);
  }
}
