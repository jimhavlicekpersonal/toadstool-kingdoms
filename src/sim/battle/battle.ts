/**
 * Fixed-step battle simulation: 10 ticks per second, seeded RNG, no
 * floating-point functions beyond + - * / and sqrt, so the same setup and
 * deployments replay identically on every device.
 */
import { buildingDef, guardianDef, guardianLevel, levelDef, troopDef, troopLevel } from '../data';
import { createRng, next, type Rng } from '../rng';
import type { CombatDef, Cost, GameData, ResourceKind } from '../types';
import { BLOCKED, HEDGE, distToRect, findPath, type PathGrid, type Rect } from './pathfind';
import type { BattleResult, BattleSetup, Deployment, EndReason } from './types';

export interface SimBuilding {
  id: string;
  type: string;
  level: number;
  x: number;
  y: number;
  size: number;
  hp: number;
  maxHp: number;
  kind: 'hall' | 'defense' | 'hedge' | 'trap' | 'burrow' | 'other';
  destroyed: boolean;
  loot: Cost;
  combat: (CombatDef & { damage: number }) | null;
  cooldown: number;
  targetTroop: number;
  /** Traps stay hidden until they go off. */
  hidden: boolean;
  /** Guardian Burrow: guardians still inside, whether raiders have been spotted, and the release timer. */
  pending: { type: string; level: number }[];
  triggered: boolean;
  releaseCooldown: number;
}

export interface SimTroop {
  id: number;
  /** 'attack' = deployed by the attacker; 'guard' = a guardian animal from the base. */
  side: 'attack' | 'guard';
  type: string;
  x: number;
  y: number;
  /** Researched level the troop fights at, and its damage per hit at that level. */
  level: number;
  damage: number;
  /** Position at the start of the tick, for smooth rendering between ticks. */
  px: number;
  py: number;
  hp: number;
  maxHp: number;
  air: boolean;
  target: number;
  path: number[] | null;
  pathPos: number;
  cooldown: number;
  dead: boolean;
  attacking: boolean;
  facing: 1 | -1;
  slowTicks: number;
  /** The enemy unit this one is fighting (-1 = none). */
  foe: number;
  /** Guardians: the burrow they defend (they walk back when nothing is near). */
  homeX: number;
  homeY: number;
}

export interface SimProjectile {
  id: number;
  kind: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  total: number;
  left: number;
  damage: number;
  splash: number;
  targetTroop: number;
  targetBuilding: number;
  hitsAir: boolean;
  hitsGround: boolean;
  /** Fired from height (towers) or from the ground (troops). */
  arc: boolean;
  /** Building or unit type that fired it (for kill counts). */
  source: string;
}

export type SimEvent =
  | { k: 'deploy'; troop: number }
  | { k: 'fire'; building: number }
  | { k: 'hit'; x: number; y: number; kind: string; splash: number }
  | { k: 'troopHit'; troop: number }
  | { k: 'buildingHit'; building: number }
  | { k: 'destroyed'; building: number }
  | { k: 'troopDied'; troop: number }
  | { k: 'trap'; building: number }
  | { k: 'guardian'; troop: number; building: number };

export interface BattleSim {
  setup: BattleSetup;
  data: GameData;
  tick: number;
  duration: number;
  rng: Rng;
  buildings: SimBuilding[];
  troops: SimTroop[];
  projectiles: SimProjectile[];
  remaining: Record<string, number>;
  used: Record<string, number>;
  loot: Cost;
  destroyedCount: number;
  countable: number;
  hallDestroyed: boolean;
  ended: boolean;
  endReason: EndReason | null;
  events: SimEvent[];
  grid: PathGrid;
  /** 1 where the attacker may deploy. */
  deployable: Uint8Array;
  nextProjectile: number;
  /** True when the base has a Guardian Burrow (skips guardian checks otherwise). */
  hasGuardians: boolean;
  /** Attacking troops killed, by what killed them (building, trap or guardian type). */
  kills: Record<string, number>;
  /** Guardians the attacker defeated. */
  guardiansDefeated: number;
}

const rect = (b: SimBuilding): Rect => ({ x: b.x, y: b.y, w: b.size, h: b.size });
const center = (b: SimBuilding) => ({ x: b.x + b.size / 2, y: b.y + b.size / 2 });

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

export function createBattle(setup: BattleSetup, data: GameData): BattleSim {
  const size = data.economy.mapSize;
  const buildings: SimBuilding[] = setup.base.buildings.map((bb) => {
    const def = buildingDef(data, bb.type);
    const ld = levelDef(data, bb.type, bb.level) ?? def.levels[0];
    const kind: SimBuilding['kind'] =
      def.category === 'hall' ? 'hall' : def.category === 'defense' ? 'defense' : def.category === 'hedge' ? 'hedge' : def.category === 'trap' ? 'trap' : def.category === 'guardian' ? 'burrow' : 'other';
    const pending: { type: string; level: number }[] = [];
    if (kind === 'burrow') for (const [g, n] of Object.entries(ld.guardians ?? {})) for (let i = 0; i < n.count; i++) pending.push({ type: g, level: n.level });
    return {
      id: bb.id,
      type: bb.type,
      level: bb.level,
      x: bb.x,
      y: bb.y,
      size: def.size,
      hp: ld.hp,
      maxHp: ld.hp,
      kind,
      destroyed: false,
      loot: { ...(bb.loot ?? {}) },
      combat: def.combat && !bb.upgrading ? { ...def.combat, damage: ld.damage ?? 0 } : null,
      cooldown: 0,
      targetTroop: -1,
      hidden: kind === 'trap',
      pending,
      triggered: false,
      releaseCooldown: 0,
    };
  });
  const cells = new Uint8Array(size * size);
  buildings.forEach((b) => {
    if (b.kind === 'trap') return;
    for (let y = b.y; y < b.y + b.size; y++) for (let x = b.x; x < b.x + b.size; x++) cells[y * size + x] = b.kind === 'hedge' ? HEDGE : BLOCKED;
  });
  const m = data.battle.deployMarginTiles;
  const near = new Uint8Array(size * size);
  for (const b of buildings) {
    if (b.kind === 'trap') continue;
    for (let y = Math.max(0, b.y - m); y < Math.min(size, b.y + b.size + m); y++) {
      for (let x = Math.max(0, b.x - m); x < Math.min(size, b.x + b.size + m); x++) near[y * size + x] = 1;
    }
  }
  // Troops land only on open ground reachable from the map edge: the inside of
  // a closed hedge ring (gaps narrower than the margin count as closed) is off limits.
  const deployable = new Uint8Array(size * size);
  const stack: number[] = [];
  for (let i = 0; i < size; i++) {
    for (const j of [i, (size - 1) * size + i, i * size, i * size + size - 1]) {
      if (!near[j] && !deployable[j]) {
        deployable[j] = 1;
        stack.push(j);
      }
    }
  }
  while (stack.length) {
    const j = stack.pop()!;
    const x = j % size;
    const y = (j - x) / size;
    for (const k of [x > 0 ? j - 1 : -1, x < size - 1 ? j + 1 : -1, y > 0 ? j - size : -1, y < size - 1 ? j + size : -1]) {
      if (k < 0 || near[k] || deployable[k]) continue;
      deployable[k] = 1;
      stack.push(k);
    }
  }
  return {
    setup,
    data,
    tick: 0,
    duration: data.battle.durationSeconds * data.battle.ticksPerSecond,
    rng: createRng(setup.seed),
    buildings,
    troops: [],
    projectiles: [],
    remaining: { ...setup.army },
    used: {},
    loot: {},
    destroyedCount: 0,
    countable: buildings.filter((b) => b.kind !== 'hedge' && b.kind !== 'trap').length,
    hallDestroyed: false,
    ended: false,
    endReason: null,
    events: [],
    grid: { size, cells },
    deployable,
    nextProjectile: 1,
    hasGuardians: buildings.some((b) => b.kind === 'burrow' && b.pending.length > 0),
    kills: {},
    guardiansDefeated: 0,
  };
}

export function canDeploy(sim: BattleSim, troop: string, x: number, y: number): boolean {
  if (sim.ended || (sim.remaining[troop] ?? 0) <= 0) return false;
  const n = sim.grid.size;
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= n || ty >= n) return false;
  return sim.deployable[ty * n + tx] === 1;
}

/** Put a troop on the field. Returns false if not allowed. */
export function deploy(sim: BattleSim, d: Deployment): boolean {
  if (!canDeploy(sim, d.troop, d.x, d.y)) return false;
  const def = troopDef(sim.data, d.troop);
  const stats = troopLevel(sim.data, d.troop, sim.setup.levels?.[d.troop] ?? 1);
  const s = sim.data.battle.deploySpread;
  const x = Math.floor(d.x) + 0.5 + (next(sim.rng) * 2 - 1) * s;
  const y = Math.floor(d.y) + 0.5 + (next(sim.rng) * 2 - 1) * s;
  const t: SimTroop = {
    id: sim.troops.length,
    side: 'attack',
    type: d.troop,
    x,
    y,
    px: x,
    py: y,
    level: stats.level,
    damage: stats.damage,
    hp: stats.hp,
    maxHp: stats.hp,
    air: def.air,
    target: -1,
    path: null,
    pathPos: 0,
    cooldown: 0,
    dead: false,
    attacking: false,
    facing: 1,
    slowTicks: 0,
    foe: -1,
    homeX: 0,
    homeY: 0,
  };
  sim.troops.push(t);
  sim.remaining[d.troop] -= 1;
  sim.used[d.troop] = (sim.used[d.troop] ?? 0) + 1;
  sim.events.push({ k: 'deploy', troop: t.id });
  return true;
}

function damageBuilding(sim: BattleSim, bi: number, amount: number): void {
  const b = sim.buildings[bi];
  if (b.destroyed) return;
  b.hp -= amount;
  sim.events.push({ k: 'buildingHit', building: bi });
  if (b.hp > 0) return;
  b.hp = 0;
  b.destroyed = true;
  for (const [k, v] of Object.entries(b.loot) as [ResourceKind, number][]) sim.loot[k] = (sim.loot[k] ?? 0) + v;
  if (b.kind !== 'hedge' && b.kind !== 'trap') sim.destroyedCount++;
  if (b.kind === 'hall') sim.hallDestroyed = true;
  const n = sim.grid.size;
  if (b.kind !== 'trap') for (let y = b.y; y < b.y + b.size; y++) for (let x = b.x; x < b.x + b.size; x++) sim.grid.cells[y * n + x] = 0;
  sim.events.push({ k: 'destroyed', building: bi });
}

function damageTroop(sim: BattleSim, ti: number, amount: number, source = ''): void {
  const t = sim.troops[ti];
  if (t.dead) return;
  t.hp -= amount;
  sim.events.push({ k: 'troopHit', troop: ti });
  if (t.hp <= 0) {
    t.hp = 0;
    t.dead = true;
    if (t.side === 'attack') sim.kills[source] = (sim.kills[source] ?? 0) + 1;
    else sim.guardiansDefeated++;
    sim.events.push({ k: 'troopDied', troop: ti });
  }
}

// ---------------------------------------------------------------- Guardians

/** Release guardians from burrows once raiders come close (all at once if the burrow falls). */
function stepBurrows(sim: BattleSim): void {
  if (!sim.hasGuardians) return;
  const g = sim.data.guardians;
  sim.buildings.forEach((b, bi) => {
    if (b.kind !== 'burrow' || !b.pending.length) return;
    const c = center(b);
    if (!b.triggered) {
      b.triggered = b.destroyed || sim.troops.some((t) => t.side === 'attack' && !t.dead && dist(t.x, t.y, c.x, c.y) <= g.triggerRange + b.size / 2);
      if (!b.triggered) return;
    }
    if (b.releaseCooldown > 0 && !b.destroyed) {
      b.releaseCooldown--;
      return;
    }
    const n = b.destroyed ? b.pending.length : 1;
    for (let i = 0; i < n; i++) spawnGuardian(sim, bi, b.pending.shift()!);
    b.releaseCooldown = g.releaseIntervalTicks;
  });
}

function spawnGuardian(sim: BattleSim, bi: number, gu: { type: string; level: number }): void {
  const b = sim.buildings[bi];
  const def = guardianDef(sim.data, gu.type);
  const stats = guardianLevel(sim.data, gu.type, gu.level);
  const c = center(b);
  const x = c.x + (next(sim.rng) * 2 - 1) * 0.6;
  const y = c.y + b.size / 2 + (next(sim.rng) * 2 - 1) * 0.3;
  const t: SimTroop = {
    id: sim.troops.length, side: 'guard', type: gu.type, x, y, px: x, py: y, level: stats.level, damage: stats.damage, hp: stats.hp, maxHp: stats.hp,
    air: def.air, target: -1, path: null, pathPos: 0, cooldown: 0, dead: false, attacking: false, facing: -1, slowTicks: 0, foe: -1, homeX: c.x, homeY: c.y,
  };
  sim.troops.push(t);
  sim.events.push({ k: 'guardian', troop: t.id, building: bi });
}

function stepGuardian(sim: BattleSim, ti: number): void {
  const t = sim.troops[ti];
  if (t.dead) return;
  t.px = t.x;
  t.py = t.y;
  const def = guardianDef(sim.data, t.type);
  const leash = sim.data.guardians.leashRange;
  if (t.cooldown > 0) t.cooldown--;
  const canHit = (u: SimTroop) => !u.dead && u.side === 'attack' && (u.air ? def.targets !== 'ground' : def.targets !== 'air') && dist(u.x, u.y, t.homeX, t.homeY) <= leash;
  if (t.foe < 0 || !canHit(sim.troops[t.foe])) {
    t.foe = -1;
    let best = Infinity;
    sim.troops.forEach((u, i) => {
      if (!canHit(u)) return;
      const d = dist(t.x, t.y, u.x, u.y);
      if (d < best) {
        best = d;
        t.foe = i;
      }
    });
  }
  if (t.foe < 0) {
    t.attacking = false;
    if (dist(t.x, t.y, t.homeX, t.homeY) > 0.6) moveToward(t, t.homeX, t.homeY, def.speed);
    return;
  }
  const f = sim.troops[t.foe];
  if (dist(t.x, t.y, f.x, f.y) > def.range) {
    t.attacking = false;
    moveToward(t, f.x, f.y, def.speed);
    return;
  }
  t.attacking = true;
  t.facing = f.x - f.y >= t.x - t.y ? 1 : -1;
  if (t.cooldown > 0) return;
  t.cooldown = def.attackIntervalTicks;
  if (def.projectile) {
    const travel = Math.max(1, Math.ceil(dist(t.x, t.y, f.x, f.y) / (def.projectileSpeed ?? 1)));
    sim.projectiles.push({
      id: sim.nextProjectile++, kind: def.projectile, fromX: t.x, fromY: t.y, toX: f.x, toY: f.y, total: travel, left: travel,
      damage: t.damage, splash: 0, targetTroop: t.foe, targetBuilding: -1, hitsAir: true, hitsGround: true, arc: false, source: t.type,
    });
  } else {
    damageTroop(sim, t.foe, t.damage, t.type);
  }
}

/**
 * Attacking troops fight a guardian that comes within reach. Troops that go
 * for defenses (Beetle Brutes, Owl Bombers) ignore guardians, and only ranged
 * troops can hit flying ones. Returns true if the troop spent its tick fighting.
 */
function fightGuardian(sim: BattleSim, t: SimTroop): boolean {
  const def = troopDef(sim.data, t.type);
  if (def.prefers === 'defense') return false;
  const reach = def.range + sim.data.guardians.engageRange;
  const canHit = (g: SimTroop) => !g.dead && g.side === 'guard' && (!g.air || def.range >= 2) && dist(t.x, t.y, g.x, g.y) <= reach;
  if (t.foe < 0 || !canHit(sim.troops[t.foe])) {
    t.foe = -1;
    let best = Infinity;
    sim.troops.forEach((g, i) => {
      if (!canHit(g)) return;
      const d = dist(t.x, t.y, g.x, g.y);
      if (d < best) {
        best = d;
        t.foe = i;
      }
    });
    if (t.foe < 0) return false;
  }
  const g = sim.troops[t.foe];
  t.path = null;
  if (dist(t.x, t.y, g.x, g.y) > def.range) {
    t.attacking = false;
    moveToward(t, g.x, g.y, t.slowTicks > 0 ? def.speed * 0.5 : def.speed);
    return true;
  }
  t.attacking = true;
  t.facing = g.x - g.y >= t.x - t.y ? 1 : -1;
  if (t.cooldown > 0) return true;
  t.cooldown = def.attackIntervalTicks;
  if (def.projectile) {
    const travel = Math.max(1, Math.ceil(dist(t.x, t.y, g.x, g.y) / (def.projectileSpeed ?? 1)));
    sim.projectiles.push({
      id: sim.nextProjectile++, kind: def.projectile, fromX: t.x, fromY: t.y, toX: g.x, toY: g.y, total: travel, left: travel,
      damage: t.damage, splash: 0, targetTroop: t.foe, targetBuilding: -1, hitsAir: true, hitsGround: true, arc: true, source: t.type,
    });
  } else {
    damageTroop(sim, t.foe, t.damage, t.type);
  }
  return true;
}

/** Nearest standing building this troop wants, by its preference. */
function chooseTarget(sim: BattleSim, t: SimTroop): number {
  const def = troopDef(sim.data, t.type);
  const pick = (filter: (b: SimBuilding) => boolean) => {
    let best = -1;
    let bestD = Infinity;
    sim.buildings.forEach((b, i) => {
      if (b.destroyed || b.kind === 'hedge' || b.kind === 'trap' || !filter(b)) return;
      const d = distToRect(t.x, t.y, rect(b));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  if (def.prefers === 'defense') {
    const d = pick((b) => b.kind === 'defense');
    if (d >= 0) return d;
  }
  return pick(() => true);
}

function stepTroop(sim: BattleSim, ti: number): void {
  const t = sim.troops[ti];
  if (t.dead) return;
  if (t.side === 'guard') {
    stepGuardian(sim, ti);
    return;
  }
  t.px = t.x;
  t.py = t.y;
  const def = troopDef(sim.data, t.type);
  if (t.cooldown > 0) t.cooldown--;
  if (sim.hasGuardians && fightGuardian(sim, t)) return;
  if (t.target < 0 || sim.buildings[t.target].destroyed) {
    t.target = chooseTarget(sim, t);
    t.path = null;
    t.attacking = false;
    if (t.target < 0) return;
  }
  const target = sim.buildings[t.target];
  const r = rect(target);
  if (distToRect(t.x, t.y, r) <= def.range) {
    t.attacking = true;
    const c = center(target);
    t.facing = c.x - c.y >= t.x - t.y ? 1 : -1;
    if (t.cooldown <= 0) {
      t.cooldown = def.attackIntervalTicks;
      if (def.projectile) {
        const d = dist(t.x, t.y, c.x, c.y);
        const travel = Math.max(1, Math.ceil(d / (def.projectileSpeed ?? 1)));
        sim.projectiles.push({
          id: sim.nextProjectile++, kind: def.projectile, fromX: t.x, fromY: t.y, toX: c.x, toY: c.y, total: travel, left: travel,
          damage: t.damage, splash: 0, targetTroop: -1, targetBuilding: t.target, hitsAir: false, hitsGround: false, arc: true, source: t.type,
        });
      } else {
        damageBuilding(sim, t.target, t.damage);
      }
    }
    return;
  }
  t.attacking = false;
  const speed = t.slowTicks > 0 ? def.speed * 0.5 : def.speed;
  if (t.slowTicks > 0) t.slowTicks--;
  if (t.air) {
    const c = center(target);
    moveToward(t, c.x, c.y, speed);
    return;
  }
  const n = sim.grid.size;
  if (!t.path || t.pathPos >= t.path.length) {
    t.path = findPath(sim.grid, t.x, t.y, r, def.range, sim.data.battle.hedgePathCost, def.ignoresHedges);
    t.pathPos = 0;
    if (!t.path) {
      // Fully walled in: walk straight at it.
      const c = center(target);
      moveToward(t, c.x, c.y, speed);
      return;
    }
  }
  if (t.path.length === 0 || t.pathPos >= t.path.length) {
    // Already on a tile next to the target: close the last bit directly.
    const nx = Math.max(r.x, Math.min(r.x + r.w, t.x));
    const ny = Math.max(r.y, Math.min(r.y + r.h, t.y));
    moveToward(t, nx, ny, speed);
    return;
  }
  const wp = t.path[t.pathPos];
  const cell = sim.grid.cells[wp];
  if (cell === HEDGE && !def.ignoresHedges) {
    // Break through the hedge in the way.
    const hx = wp % n;
    const hy = (wp - hx) / n;
    const hi = sim.buildings.findIndex((b) => !b.destroyed && b.kind === 'hedge' && b.x === hx && b.y === hy);
    if (hi >= 0) {
      t.attacking = true;
      if (t.cooldown <= 0) {
        t.cooldown = def.attackIntervalTicks;
        damageBuilding(sim, hi, t.damage);
      }
      return;
    }
  }
  if (cell === BLOCKED) {
    t.path = null;
    return;
  }
  const wx = (wp % n) + 0.5;
  const wy = Math.floor(wp / n) + 0.5;
  if (moveToward(t, wx, wy, speed)) t.pathPos++;
}

/** Move toward a point; returns true on arrival. */
function moveToward(t: SimTroop, x: number, y: number, speed: number): boolean {
  const d = dist(t.x, t.y, x, y);
  if (d > 0.0001) t.facing = x - y >= t.x - t.y ? 1 : -1;
  if (d <= speed) {
    t.x = x;
    t.y = y;
    return true;
  }
  t.x += ((x - t.x) / d) * speed;
  t.y += ((y - t.y) / d) * speed;
  return false;
}

function stepDefense(sim: BattleSim, bi: number): void {
  const b = sim.buildings[bi];
  const c = b.combat;
  if (b.destroyed || !c || b.kind === 'trap') return;
  if (b.cooldown > 0) b.cooldown--;
  const cx = b.x + b.size / 2;
  const cy = b.y + b.size / 2;
  const ok = (t: SimTroop) => {
    if (t.dead || t.side !== 'attack') return false;
    if (t.air ? c.targets === 'ground' : c.targets === 'air') return false;
    const d = dist(cx, cy, t.x, t.y);
    return d <= c.range && d >= (c.minRange ?? 0);
  };
  if (b.targetTroop < 0 || !ok(sim.troops[b.targetTroop])) {
    b.targetTroop = -1;
    let bestD = Infinity;
    sim.troops.forEach((t, i) => {
      if (!ok(t)) return;
      const d = dist(cx, cy, t.x, t.y);
      if (d < bestD) {
        bestD = d;
        b.targetTroop = i;
      }
    });
  }
  if (b.targetTroop < 0 || b.cooldown > 0) return;
  const t = sim.troops[b.targetTroop];
  b.cooldown = c.fireIntervalTicks;
  const d = dist(cx, cy, t.x, t.y);
  const travel = Math.max(1, Math.ceil(d / c.projectileSpeed));
  let toX = t.x;
  let toY = t.y;
  if (c.splashRadius) {
    const s = sim.data.battle.catapultSpread;
    toX += (next(sim.rng) * 2 - 1) * s;
    toY += (next(sim.rng) * 2 - 1) * s;
  }
  sim.projectiles.push({
    id: sim.nextProjectile++, kind: c.projectile, fromX: cx, fromY: cy, toX, toY, total: travel, left: travel,
    damage: c.damage, splash: c.splashRadius ?? 0, targetTroop: c.splashRadius ? -1 : b.targetTroop, targetBuilding: -1,
    hitsAir: c.targets !== 'ground', hitsGround: c.targets !== 'air', arc: Boolean(c.splashRadius), source: b.type,
  });
  sim.events.push({ k: 'fire', building: bi });
}

function stepTraps(sim: BattleSim): void {
  sim.buildings.forEach((b, bi) => {
    if (b.kind !== 'trap' || b.destroyed) return;
    const c = b.combat;
    if (!c) return;
    const cx = b.x + b.size / 2;
    const cy = b.y + b.size / 2;
    const triggered = sim.troops.some((t) => t.side === 'attack' && !t.dead && !t.air && dist(cx, cy, t.x, t.y) <= c.range);
    if (!triggered) return;
    b.hidden = false;
    b.destroyed = true;
    sim.events.push({ k: 'trap', building: bi });
    const radius = c.splashRadius ?? c.range;
    sim.troops.forEach((t, ti) => {
      if (t.side !== 'attack' || t.dead || t.air || dist(cx, cy, t.x, t.y) > radius) return;
      if (c.projectile === 'sap') t.slowTicks = 40;
      if (c.damage > 0) damageTroop(sim, ti, c.damage, b.type);
    });
    sim.events.push({ k: 'hit', x: cx, y: cy, kind: c.projectile, splash: radius });
  });
}

function stepProjectiles(sim: BattleSim): void {
  const keep: SimProjectile[] = [];
  for (const p of sim.projectiles) {
    p.left--;
    if (p.left > 0) {
      keep.push(p);
      continue;
    }
    if (p.targetBuilding >= 0) {
      damageBuilding(sim, p.targetBuilding, p.damage);
      sim.events.push({ k: 'hit', x: p.toX, y: p.toY, kind: p.kind, splash: 0 });
    } else if (p.splash > 0) {
      sim.troops.forEach((t, ti) => {
        if (t.side !== 'attack' || t.dead || (t.air ? !p.hitsAir : !p.hitsGround)) return;
        if (dist(p.toX, p.toY, t.x, t.y) <= p.splash) damageTroop(sim, ti, p.damage, p.source);
      });
      sim.events.push({ k: 'hit', x: p.toX, y: p.toY, kind: p.kind, splash: p.splash });
    } else if (p.targetTroop >= 0) {
      const t = sim.troops[p.targetTroop];
      if (!t.dead) {
        damageTroop(sim, p.targetTroop, p.damage, p.source);
        sim.events.push({ k: 'hit', x: t.x, y: t.y, kind: p.kind, splash: 0 });
      }
    }
  }
  sim.projectiles = keep;
}

/** Advance one tick, applying `deployments` (all for this tick) first. */
export function step(sim: BattleSim, deployments: Deployment[] = []): void {
  if (sim.ended) return;
  sim.events = [];
  for (const d of deployments) deploy(sim, d);
  for (let i = 0; i < sim.troops.length; i++) stepTroop(sim, i);
  stepBurrows(sim);
  stepTraps(sim);
  for (let i = 0; i < sim.buildings.length; i++) stepDefense(sim, i);
  stepProjectiles(sim);
  sim.tick++;
  if (sim.destroyedCount >= sim.countable) end(sim, 'destroyed');
  else if (sim.tick >= sim.duration) end(sim, 'time');
  else if (
    sim.troops.some((t) => t.side === 'attack') &&
    sim.troops.every((t) => t.dead || t.side !== 'attack') &&
    Object.values(sim.remaining).every((v) => v <= 0) &&
    sim.projectiles.length === 0
  ) {
    end(sim, 'no_troops');
  }
}

export function end(sim: BattleSim, reason: EndReason): void {
  if (sim.ended) return;
  sim.ended = true;
  sim.endReason = reason;
}

export function destruction(sim: BattleSim): number {
  return sim.countable ? Math.floor((sim.destroyedCount * 100) / sim.countable) : 100;
}

export function stars(sim: BattleSim): number {
  const d = destruction(sim);
  const t = sim.data.battle.starThresholds;
  return (d >= t.destruction ? 1 : 0) + (sim.hallDestroyed ? 1 : 0) + (d >= t.full ? 1 : 0);
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function stateHash(sim: BattleSim): string {
  const parts: string[] = [String(sim.tick)];
  for (const b of sim.buildings) parts.push(b.hp.toFixed(3));
  for (const t of sim.troops) parts.push(`${t.hp.toFixed(3)},${t.x.toFixed(4)},${t.y.toFixed(4)}`);
  parts.push(JSON.stringify(sim.loot));
  return fnv(parts.join('|'));
}

export function result(sim: BattleSim): BattleResult {
  return {
    stars: stars(sim),
    destruction: destruction(sim),
    hallDestroyed: sim.hallDestroyed,
    loot: { ...sim.loot },
    used: { ...sim.used },
    ticks: sim.tick,
    endReason: sim.endReason ?? 'time',
    hash: stateHash(sim),
  };
}

/** Group deployments by tick for fast lookup. */
export function deploymentsByTick(list: Deployment[]): Map<number, Deployment[]> {
  const m = new Map<number, Deployment[]>();
  for (const d of list) {
    const arr = m.get(d.tick);
    if (arr) arr.push(d);
    else m.set(d.tick, [d]);
  }
  return m;
}

/** Run a whole battle from its seed and deployments (used for replays and to verify results). */
export function runBattle(setup: BattleSetup, deployments: Deployment[], data: GameData, endTick?: number): { sim: BattleSim; result: BattleResult } {
  const sim = createBattle(setup, data);
  const byTick = deploymentsByTick(deployments);
  while (!sim.ended) {
    if (endTick !== undefined && sim.tick >= endTick) {
      end(sim, 'surrender');
      break;
    }
    step(sim, byTick.get(sim.tick));
  }
  return { sim, result: result(sim) };
}
