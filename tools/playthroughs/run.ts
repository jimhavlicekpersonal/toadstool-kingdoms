/**
 * Simulated playthroughs: many model players with different habits play the
 * real game rules (real battles, matchmaking, offline raids, chests, events)
 * from a new village until well past the top Elder Toadstool level. The
 * report measures how hard each level is, in battle, in time, against raiders
 * and in how it feels to play (loss streaks, sessions with nothing to do).
 *
 *   npm run sim:playthroughs -- [count=100] [label=latest]
 *   npm run sim:playthroughs -- compare <label-before> <label-after>
 *
 * Results go to sim-results/<label>/report.md and report.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { buildingDef } from '../../src/sim/data';
import { defaultData as data } from '../../src/sim/data';
import { createRng, int, next, pick } from '../../src/sim/rng';
import { hallLevel } from '../../src/sim/village';
import { activeHour, ModelPlayer, normalDays } from '../../tests/balance/playerModel';
import { edgeDeployments } from './deploy';
import { analyzeBase, type BaseGeometry } from './geometry';

const HALLS = data.hall.levels.length;

// ---------------------------------------------------------------- Player profiles

const CADENCES: Record<string, number[]> = {
  '2/day': [8 * 60, 20 * 60],
  '3/day': [8 * 60, 13 * 60, 20 * 60],
  '4/day': [8 * 60, 12.5 * 60, 18 * 60, 22 * 60],
  '6/day': [7 * 60, 9.5 * 60, 12 * 60, 15 * 60, 18 * 60, 21 * 60],
};
const STYLES: Record<string, Record<string, number> | undefined> = {
  balanced: undefined,
  swarm: { hedgehog_roller: 0.8, frog_lobber: 0.2 },
  tank: { beetle_brute: 0.35, hedgehog_roller: 0.35, frog_lobber: 0.3 },
  air: { owl_bomber: 0.45, frog_lobber: 0.35, hedgehog_roller: 0.2 },
};
const DEPLOYS = { 'one side': 1, 'two sides': 2, 'all around': 4 } as const;

export interface Profile {
  id: number;
  cadence: string;
  style: string;
  deploy: keyof typeof DEPLOYS;
  raidsPerSession: number;
  maxNext: number;
  defenseFirst: boolean;
  firstHourMinutes: number;
  startAt: number;
}

export function profileFor(i: number): Profile {
  const rng = createRng(0x9e37 + i * 7919);
  return {
    id: i,
    cadence: Object.keys(CADENCES)[i % 4],
    style: Object.keys(STYLES)[Math.floor(i / 4) % 4],
    deploy: (Object.keys(DEPLOYS) as (keyof typeof DEPLOYS)[])[Math.floor(i / 16) % 3],
    raidsPerSession: 1 + int(rng, 0, 2),
    maxNext: int(rng, 0, 3),
    defenseFirst: next(rng) < 0.3,
    firstHourMinutes: pick(rng, [30, 60, 90]),
    startAt: Date.UTC(2026, 0, 5, 8, 0, 0) + i * 7919 * 60_000,
  };
}

// ---------------------------------------------------------------- One playthrough

interface LevelRun {
  hall: number;
  hours: number | null;
  raids: number;
  wins: number;
  threeStars: number;
  stars: number;
  destruction: number;
  loot: number;
  armyCost: number;
  deployed: number;
  lost: number;
  killedBy: { defense: number; trap: number; guardian: number };
  guardiansMet: number;
  guardiansDefeated: number;
  longestLossStreak: number;
  oppHallDiff: number;
  defenses: number;
  defenseDestruction: number;
  defenseLost: number;
  collected: number;
  sessions: number;
  deadSessions: number;
  storageFullSessions: number;
  idleBuilderSessions: number;
  longestDroughtHours: number;
  trophiesEnd: number;
}

export interface RunResult {
  profile: Profile;
  hallReachedHours: Record<number, number>;
  levels: LevelRun[];
}

function emptyLevel(hall: number): LevelRun {
  return {
    hall, hours: null, raids: 0, wins: 0, threeStars: 0, stars: 0, destruction: 0, loot: 0, armyCost: 0, deployed: 0, lost: 0,
    killedBy: { defense: 0, trap: 0, guardian: 0 }, guardiansMet: 0, guardiansDefeated: 0, longestLossStreak: 0, oppHallDiff: 0,
    defenses: 0, defenseDestruction: 0, defenseLost: 0, collected: 0, sessions: 0, deadSessions: 0, storageFullSessions: 0,
    idleBuilderSessions: 0, longestDroughtHours: 0, trophiesEnd: 0,
  };
}

export function playthrough(profile: Profile, maxDays = 30): RunResult {
  const levels = Array.from({ length: HALLS }, (_, i) => emptyLevel(i + 1));
  const streak = new Array(HALLS + 1).fill(0);
  const lastAction = new Array(HALLS + 1).fill(-1);
  let p!: ModelPlayer;
  let lastCollected = 0;
  const kindOf = (src: string): 'defense' | 'trap' | 'guardian' => (data.guardians.animals[src] ? 'guardian' : data.buildings[src] && buildingDef(data, src).category === 'trap' ? 'trap' : 'defense');
  p = new ModelPlayer(data, {
    raidsPerSession: profile.raidsPerSession,
    maxNext: profile.maxNext,
    startAt: profile.startAt,
    armyMix: STYLES[profile.style],
    defenseFirst: profile.defenseFirst,
    deployPlan: DEPLOYS[profile.deploy] === 1 ? undefined : (dep, size, army, seed, d, lv) => edgeDeployments(DEPLOYS[profile.deploy], dep, size, army, seed, d, lv),
    onRaid: ({ hall, base, sim, loot, trophies, armyCost }) => {
      const L = levels[hall - 1];
      const stars = sim.ended ? (sim.hallDestroyed ? 1 : 0) + (Math.floor((sim.destroyedCount * 100) / sim.countable) >= data.battle.starThresholds.destruction ? 1 : 0) + (sim.destroyedCount >= sim.countable ? 1 : 0) : 0;
      const destruction = Math.floor((sim.destroyedCount * 100) / Math.max(1, sim.countable));
      L.raids++;
      L.stars += stars;
      if (stars >= 1) L.wins++;
      if (stars === 3) L.threeStars++;
      L.destruction += destruction;
      L.loot += Math.max(0, loot);
      L.armyCost += armyCost;
      const attackers = sim.troops.filter((t) => t.side === 'attack');
      L.deployed += attackers.length;
      L.lost += attackers.filter((t) => t.dead).length;
      for (const [src, n] of Object.entries(sim.kills)) L.killedBy[kindOf(src)] += n;
      L.guardiansMet += sim.troops.filter((t) => t.side === 'guard').length;
      L.guardiansDefeated += sim.guardiansDefeated;
      L.oppHallDiff += base.hallLevel - hall;
      streak[hall] = stars === 0 ? streak[hall] + 1 : 0;
      L.longestLossStreak = Math.max(L.longestLossStreak, streak[hall]);
      L.trophiesEnd = trophies;
    },
    onSession: ({ hall, at, actions, buildersIdle, storageFull, raided }) => {
      const L = levels[hall - 1];
      L.sessions++;
      if (actions === 0 && !raided) L.deadSessions++;
      if (storageFull) L.storageFullSessions++;
      if (buildersIdle > 0) L.idleBuilderSessions++;
      if (actions > 0) {
        if (lastAction[hall] >= 0) L.longestDroughtHours = Math.max(L.longestDroughtHours, (at - lastAction[hall]) / 3_600_000);
        lastAction[hall] = at;
      }
      const c = p.state.stats.collectedAcorns + p.state.stats.collectedDew;
      L.collected += c - lastCollected;
      lastCollected = c;
      L.trophiesEnd = p.state.trophies;
    },
  });
  activeHour(p, profile.firstHourMinutes, 2);
  const sessions = CADENCES[profile.cadence];
  for (let day = 0; day < maxDays; day++) {
    normalDays(p, 1, undefined, sessions);
    const h6 = p.hallReachedAt[HALLS];
    if (h6 !== undefined && p.elapsedHours() - h6 > 72) break;
  }
  for (const d of p.defenseLog) {
    const L = levels[d.hall - 1];
    L.defenses++;
    L.defenseDestruction += d.destruction;
    L.defenseLost += d.lost;
  }
  for (let h = 1; h < HALLS; h++) {
    const a = p.hallReachedAt[h];
    const b = p.hallReachedAt[h + 1];
    levels[h - 1].hours = a !== undefined && b !== undefined ? b - a : null;
  }
  const top = p.hallReachedAt[HALLS];
  if (top !== undefined) levels[HALLS - 1].hours = p.elapsedHours() - top;
  void hallLevel;
  return { profile, hallReachedHours: { ...p.hallReachedAt }, levels };
}

// ---------------------------------------------------------------- Aggregation

function stats(xs: number[]): { mean: number; p10: number; p50: number; p90: number; n: number } {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { mean: NaN, p10: NaN, p50: NaN, p90: NaN, n: 0 };
  const q = (f: number) => v[Math.min(v.length - 1, Math.floor(f * (v.length - 1) + 0.5))];
  return { mean: v.reduce((a, b) => a + b, 0) / v.length, p10: q(0.1), p50: q(0.5), p90: q(0.9), n: v.length };
}

export interface LevelReport {
  hall: number;
  hours: ReturnType<typeof stats>;
  winRate: number;
  threeStarRate: number;
  avgStars: number;
  avgDestruction: number;
  troopLossRate: number;
  lootPerRaid: number;
  lootPerDew: number;
  killShare: { defense: number; trap: number; guardian: number };
  guardiansPerRaid: number;
  guardianDefeatRate: number;
  lossStreak: ReturnType<typeof stats>;
  oppHallDiff: number;
  defensesPerDay: number;
  defenseDestruction: number;
  defenseLossShare: number;
  deadSessionShare: number;
  storageFullShare: number;
  idleBuilderShare: number;
  drought: ReturnType<typeof stats>;
  trophiesEnd: ReturnType<typeof stats>;
  /** Composite indexes (0 = easy, 1 = brutal). */
  battleDifficulty: number;
  frustration: number;
  byStyle: Record<string, { winRate: number; destruction: number; raids: number }>;
  byDeploy: Record<string, { winRate: number; destruction: number; raids: number }>;
}

export function aggregate(runs: RunResult[]): LevelReport[] {
  const out: LevelReport[] = [];
  for (let h = 1; h <= HALLS; h++) {
    const L = runs.map((r) => r.levels[h - 1]);
    const sum = (f: (x: LevelRun) => number) => L.reduce((a, x) => a + f(x), 0);
    const raids = Math.max(1, sum((x) => x.raids));
    const deployed = Math.max(1, sum((x) => x.deployed));
    const kills = Math.max(1, sum((x) => x.killedBy.defense + x.killedBy.trap + x.killedBy.guardian));
    const hoursAll = sum((x) => x.hours ?? 0);
    const income = Math.max(1, sum((x) => x.loot + x.collected));
    const sessions = Math.max(1, sum((x) => x.sessions));
    const group = (key: (r: RunResult) => string) => {
      const m: Record<string, { winRate: number; destruction: number; raids: number }> = {};
      for (const r of runs) {
        const x = r.levels[h - 1];
        const k = key(r);
        const g = (m[k] ??= { winRate: 0, destruction: 0, raids: 0 });
        g.winRate += x.wins;
        g.destruction += x.destruction;
        g.raids += x.raids;
      }
      for (const g of Object.values(m)) {
        g.winRate = g.raids ? g.winRate / g.raids : NaN;
        g.destruction = g.raids ? g.destruction / g.raids : NaN;
      }
      return m;
    };
    const winRate = sum((x) => x.wins) / raids;
    const avgDestruction = sum((x) => x.destruction) / raids;
    const troopLossRate = sum((x) => x.lost) / deployed;
    const dead = sum((x) => x.deadSessions) / sessions;
    const streaks = stats(L.map((x) => x.longestLossStreak));
    out.push({
      hall: h,
      hours: stats(L.map((x) => (x.hours === null ? NaN : x.hours))),
      winRate,
      threeStarRate: sum((x) => x.threeStars) / raids,
      avgStars: sum((x) => x.stars) / raids,
      avgDestruction,
      troopLossRate,
      lootPerRaid: sum((x) => x.loot) / raids,
      lootPerDew: sum((x) => x.loot) / Math.max(1, sum((x) => x.armyCost)),
      killShare: { defense: sum((x) => x.killedBy.defense) / kills, trap: sum((x) => x.killedBy.trap) / kills, guardian: sum((x) => x.killedBy.guardian) / kills },
      guardiansPerRaid: sum((x) => x.guardiansMet) / raids,
      guardianDefeatRate: sum((x) => x.guardiansDefeated) / Math.max(1, sum((x) => x.guardiansMet)),
      lossStreak: streaks,
      oppHallDiff: sum((x) => x.oppHallDiff) / raids,
      defensesPerDay: sum((x) => x.defenses) / Math.max(1, hoursAll / 24),
      defenseDestruction: sum((x) => x.defenseDestruction) / Math.max(1, sum((x) => x.defenses)),
      defenseLossShare: sum((x) => x.defenseLost) / income,
      deadSessionShare: dead,
      storageFullShare: sum((x) => x.storageFullSessions) / sessions,
      idleBuilderShare: sum((x) => x.idleBuilderSessions) / sessions,
      drought: stats(L.map((x) => x.longestDroughtHours)),
      trophiesEnd: stats(L.map((x) => x.trophiesEnd)),
      battleDifficulty: sum((x) => x.raids) ? 0.4 * (1 - winRate) + 0.3 * troopLossRate + 0.3 * (1 - avgDestruction / 100) : NaN,
      frustration: 0.5 * dead + 0.5 * Math.min(1, streaks.mean / 5),
      byStyle: group((r) => r.profile.style),
      byDeploy: group((r) => r.profile.deploy),
    });
  }
  return out;
}

export function geometryByHall(samples = 30): { hall: number; geo: Record<keyof Omit<BaseGeometry, 'hall'>, number> }[] {
  const out = [];
  for (let h = 1; h <= HALLS; h++) {
    const list = Array.from({ length: samples }, (_, i) => analyzeBase(1000 + i * 7919, h, 0.5, data));
    const geo = {} as Record<string, number>;
    for (const k of Object.keys(list[0]) as (keyof BaseGeometry)[]) {
      if (k === 'hall') continue;
      geo[k] = list.reduce((a, g) => a + (g[k] as number), 0) / list.length;
    }
    out.push({ hall: h, geo: geo as Record<keyof Omit<BaseGeometry, 'hall'>, number> });
  }
  return out;
}

// ---------------------------------------------------------------- Report

const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
const num = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');

export function markdown(label: string, runs: RunResult[], levels: LevelReport[], geo: ReturnType<typeof geometryByHall>, ms: number): string {
  const L: string[] = [];
  const reached6 = runs.filter((r) => r.hallReachedHours[HALLS] !== undefined);
  L.push(`# Playthroughs: ${label}`, '', `${runs.length} simulated players, ${(ms / 60000).toFixed(1)} min of compute. ${reached6.length} reached Elder Toadstool ${HALLS}; median ${num(stats(reached6.map((r) => r.hallReachedHours[HALLS] / 24)).p50)} days (p10 ${num(stats(reached6.map((r) => r.hallReachedHours[HALLS] / 24)).p10)}, p90 ${num(stats(reached6.map((r) => r.hallReachedHours[HALLS] / 24)).p90)}).`, '');
  L.push('## Battle difficulty by level', '', '| Level | Raids won | 3★ | Avg ★ | Destruction | Troops lost | Killed by defense / trap / guardian | Guardians met / defeated | Loot per Dew | Opponent hall diff | Battle difficulty |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const l of levels) L.push(`| ${l.hall} | ${pct(l.winRate)} | ${pct(l.threeStarRate)} | ${num(l.avgStars, 2)} | ${num(l.avgDestruction, 0)}% | ${pct(l.troopLossRate)} | ${pct(l.killShare.defense)} / ${pct(l.killShare.trap)} / ${pct(l.killShare.guardian)} | ${num(l.guardiansPerRaid)} / ${pct(l.guardianDefeatRate)} | ${num(l.lootPerDew, 2)} | ${num(l.oppHallDiff, 2)} | **${num(l.battleDifficulty, 3)}** |`);
  L.push('', '## Time, raids against you, and how it feels', '', '| Level | Hours at level (p10 / median / p90) | Raided per day | Raid destruction | Lost to raids (of income) | Sessions with nothing to do | Storage full | Builder idle | Longest loss streak (median / p90) | Longest wait between upgrades, h (median / p90) | Frustration |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const l of levels) L.push(`| ${l.hall} | ${num(l.hours.p10)} / ${num(l.hours.p50)} / ${num(l.hours.p90)} | ${num(l.defensesPerDay, 2)} | ${num(l.defenseDestruction, 0)}% | ${pct(l.defenseLossShare)} | ${pct(l.deadSessionShare)} | ${pct(l.storageFullShare)} | ${pct(l.idleBuilderShare)} | ${num(l.lossStreak.p50, 0)} / ${num(l.lossStreak.p90, 0)} | ${num(l.drought.p50)} / ${num(l.drought.p90)} | **${num(l.frustration, 3)}** |`);
  L.push('', '## Strategy: raids won by army style and by deploy plan', '');
  const styles = Object.keys(levels[0].byStyle);
  const deploys = Object.keys(levels[0].byDeploy);
  L.push(`| Level | ${[...styles, ...deploys].join(' | ')} |`, `|---|${[...styles, ...deploys].map(() => '---').join('|')}|`);
  for (const l of levels) L.push(`| ${l.hall} | ${[...styles.map((s) => `${pct(l.byStyle[s]?.winRate)} (${num(l.byStyle[s]?.destruction, 0)}%)`), ...deploys.map((s) => `${pct(l.byDeploy[s]?.winRate)} (${num(l.byDeploy[s]?.destruction, 0)}%)`)].join(' | ')} |`);
  L.push('', '## Base geometry by level (typical generated base)', '', '| Level | Buildings | Defenses | Traps | Ground cover (1+ / 2+) | Air cover | Ground DPS | Hedges edge→hall | Hedge ring open | Outside the walls | Drop zone inside walls | Edge→hall tiles | Guardian strength | Army housing | Army strength | Clear time, s | Defense DPS per housing |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const { hall, geo: g } of geo) L.push(`| ${hall} | ${num(g.buildings, 0)} | ${num(g.defenses, 1)} | ${num(g.traps, 1)} | ${pct(g.groundCover)} / ${pct(g.groundCover2)} | ${pct(g.airCover)} | ${num(g.groundDps, 0)} | ${num(g.hedgesToHall, 1)} | ${pct(g.hedgeGapShare)} | ${pct(g.outsideShare)} | ${pct(g.interiorDeploy)} | ${num(g.edgeToHall, 1)} | ${num(g.guardianStrength, 0)} | ${num(g.armyHousing, 0)} | ${num(g.armyStrength, 0)} | ${num(g.clearSeconds, 0)} | ${num(g.pressure, 2)} |`);
  L.push('', 'Battle difficulty = 0.4 × raids lost + 0.3 × troop loss rate + 0.3 × destruction missed. Frustration = 0.5 × share of sessions with nothing to do + 0.5 × (median longest loss streak / 5).', '');
  return L.join('\n');
}

// ---------------------------------------------------------------- Main (parallel)

if (!isMainThread) {
  const ids = workerData as number[];
  for (const i of ids) parentPort!.postMessage(playthrough(profileFor(i)));
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === 'compare') {
  // npm run sim:playthroughs -- compare <before> <after>
  const load = (l: string) => JSON.parse(readFileSync(join('sim-results', l, 'report.json'), 'utf8')) as { levels: LevelReport[] };
  const [a, b] = [load(process.argv[3]), load(process.argv[4])];
  const rows = ['| Level | Battle difficulty | Raids won | Troops lost | Guardian kill share | Opp. hall diff | Median hours at level | Lost to raids | Nothing-to-do sessions | Frustration |', '|---|---|---|---|---|---|---|---|---|---|'];
  const ab = (f: (l: LevelReport) => string, i: number) => `${f(a.levels[i])} → ${f(b.levels[i])}`;
  for (let i = 0; i < a.levels.length; i++) {
    rows.push(`| ${i + 1} | ${ab((l) => num(l.battleDifficulty, 3), i)} | ${ab((l) => pct(l.winRate), i)} | ${ab((l) => pct(l.troopLossRate), i)} | ${ab((l) => pct(l.killShare.guardian), i)} | ${ab((l) => num(l.oppHallDiff, 2), i)} | ${ab((l) => num(l.hours.p50), i)} | ${ab((l) => pct(l.defenseLossShare), i)} | ${ab((l) => pct(l.deadSessionShare), i)} | ${ab((l) => num(l.frustration, 3), i)} |`);
  }
  const out = rows.join('\n');
  writeFileSync(join('sim-results', `compare-${process.argv[3]}-${process.argv[4]}.md`), out);
  console.log(out);
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const count = Number(process.argv[2] ?? 100) || 100;
  const label = process.argv[3] ?? 'latest';
  const threads = Math.max(1, Math.min(cpus().length, count));
  const t0 = Date.now();
  const runs: RunResult[] = [];
  await Promise.all(
    Array.from({ length: threads }, (_, w) => {
      const ids = Array.from({ length: count }, (_, i) => i).filter((i) => i % threads === w);
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(fileURLToPath(import.meta.url), { workerData: ids });
        worker.on('message', (r: RunResult) => {
          runs.push(r);
          process.stdout.write(`\r${runs.length}/${count} playthroughs`);
        });
        worker.on('error', reject);
        worker.on('exit', () => resolve());
      });
    }),
  );
  process.stdout.write('\n');
  runs.sort((a, b) => a.profile.id - b.profile.id);
  const levels = aggregate(runs);
  const geo = geometryByHall();
  const md = markdown(label, runs, levels, geo, Date.now() - t0);
  const dir = join('sim-results', label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), md);
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ label, levels, geo, runs }, null, 1));
  console.log(md);
}
