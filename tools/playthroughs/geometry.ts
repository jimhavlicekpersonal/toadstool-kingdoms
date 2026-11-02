/**
 * Geometry of generated bases: how much of the base each defense covers, how
 * many hedges stand between the edge and the Elder Toadstool, how long a full
 * army needs to knock everything down, and how strong the guardians are.
 */
import { createBattle } from '../../src/sim/battle/battle';
import { generateOpponent } from '../../src/sim/battle/basegen';
import { HEDGE } from '../../src/sim/battle/pathfind';
import { buildingDef, levelDef, troopDef, troopLevel } from '../../src/sim/data';
import { armyStrength, burrowStrength } from '../../src/sim/difficulty';
import { botArmy } from '../../src/sim/matchmaking';
import { troopLevelCapAt } from '../../src/sim/research';
import type { GameData } from '../../src/sim/types';

export interface BaseGeometry {
  hall: number;
  buildings: number;
  defenses: number;
  traps: number;
  /** Share of the base's tiles inside the range of at least one / two ground defenses. */
  groundCover: number;
  groundCover2: number;
  airCover: number;
  groundDps: number;
  airDps: number;
  /** Hit points of everything that counts toward destruction. */
  buildingHp: number;
  /** Fewest hedges a ground troop must break from the edge to reach the Elder Toadstool. */
  hedgesToHall: number;
  /** Tiles from the map edge to the Elder Toadstool along the cheapest route. */
  edgeToHall: number;
  /** Share of tiles inside the base's outline where troops may be dropped. */
  interiorDeploy: number;
  /** Share of the hedge ring left open (gaps). */
  hedgeGapShare: number;
  /** Share of the buildings that count toward destruction standing outside the walls. */
  outsideShare: number;
  guardianStrength: number;
  /** Full matched army: housing, damage per second, strength, and seconds to destroy every building if nothing fought back. */
  armyHousing: number;
  armyDps: number;
  armyStrength: number;
  clearSeconds: number;
  /** Defense damage per second per housing space of the attacking army. */
  pressure: number;
}

export function analyzeBase(seed: number, hall: number, bias: number, data: GameData): BaseGeometry {
  const base = generateOpponent(seed, hall, data, { levelBias: bias });
  const sim = createBattle({ seed, base, army: {} }, data);
  const n = sim.grid.size;
  const tps = data.battle.ticksPerSecond;
  // The walled area: inside the hedge ring if there is one, else the bounding box of the buildings.
  let x0 = n;
  let y0 = n;
  let x1 = 0;
  let y1 = 0;
  const hedgeList = sim.buildings.filter((b) => b.kind === 'hedge');
  const outline = hedgeList.length >= 8 ? hedgeList : sim.buildings.filter((b) => b.kind !== 'trap');
  for (const b of outline) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.size);
    y1 = Math.max(y1, b.y + b.size);
  }
  let tiles = 0;
  let g1 = 0;
  let g2 = 0;
  let a1 = 0;
  const defs = sim.buildings.filter((b) => b.kind === 'defense' && b.combat);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      tiles++;
      let g = 0;
      let a = 0;
      for (const d of defs) {
        const c = d.combat!;
        const dx = x + 0.5 - (d.x + d.size / 2);
        const dy = y + 0.5 - (d.y + d.size / 2);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > c.range || dist < (c.minRange ?? 0)) continue;
        if (c.targets !== 'air') g++;
        if (c.targets !== 'ground') a++;
      }
      if (g >= 1) g1++;
      if (g >= 2) g2++;
      if (a >= 1) a1++;
    }
  }
  let groundDps = 0;
  let airDps = 0;
  for (const d of defs) {
    const dps = (d.combat!.damage * tps) / d.combat!.fireIntervalTicks;
    if (d.combat!.targets !== 'air') groundDps += dps;
    if (d.combat!.targets !== 'ground') airDps += dps;
  }
  const countable = sim.buildings.filter((b) => b.kind !== 'hedge' && b.kind !== 'trap');
  const buildingHp = countable.reduce((s, b) => s + b.maxHp, 0);
  // Fewest hedges to cross from any deploy tile to a tile next to the hall (0-1 BFS).
  const hallB = sim.buildings.find((b) => b.kind === 'hall')!;
  const cost = new Int32Array(n * n).fill(1 << 29);
  const steps = new Int32Array(n * n).fill(1 << 29);
  const dq: number[] = [];
  // Start from the map border (where a careful attacker drops troops).
  for (let i = 0; i < n * n; i++) {
    const x = i % n;
    const y = (i - x) / n;
    if ((x === 0 || y === 0 || x === n - 1 || y === n - 1) && sim.grid.cells[i] === 0) {
      cost[i] = 0;
      steps[i] = 0;
      dq.push(i);
    }
  }
  let head = 0;
  const queue = dq;
  // Simple Dijkstra on small grid with costs 0/1 (blocked tiles impassable except the hall itself).
  const isHall = (x: number, y: number) => x >= hallB.x && x < hallB.x + hallB.size && y >= hallB.y && y < hallB.y + hallB.size;
  let bestHedges = 1 << 29;
  let bestSteps = 1 << 29;
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % n;
    const y = (i - x) / n;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (isHall(nx, ny)) {
        if (cost[i] < bestHedges || (cost[i] === bestHedges && steps[i] + 1 < bestSteps)) {
          bestHedges = cost[i];
          bestSteps = steps[i] + 1;
        }
        continue;
      }
      const cell = sim.grid.cells[j];
      if (cell !== 0 && cell !== HEDGE) continue;
      const c = cost[i] + (cell === HEDGE ? 1 : 0);
      if (c < cost[j] || (c === cost[j] && steps[i] + 1 < steps[j])) {
        cost[j] = c;
        steps[j] = steps[i] + 1;
        queue.push(j);
      }
    }
  }
  const cap = troopLevelCapAt(hall, data);
  const army = botArmy(hall, 1, data);
  const levels = Object.fromEntries(Object.keys(army).map((t) => [t, cap]));
  let housing = 0;
  let armyDps = 0;
  for (const [t, k] of Object.entries(army)) {
    const def = troopDef(data, t);
    housing += def.housing * k;
    armyDps += (k * troopLevel(data, t, cap).damage * tps) / def.attackIntervalTicks;
  }
  const burrow = base.buildings.find((b) => buildingDef(data, b.type).category === 'guardian');
  let inside = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (sim.deployable[y * n + x]) inside++;
  const hedges = sim.buildings.filter((b) => b.kind === 'hedge').length;
  const ringLen = Math.max(1, 2 * (x1 - x0) + 2 * (y1 - y0) - 4);
  const outside = countable.filter((b) => b.x + b.size <= x0 || b.y + b.size <= y0 || b.x >= x1 || b.y >= y1).length;
  void levelDef;
  return {
    hall,
    buildings: countable.length,
    defenses: defs.length,
    traps: sim.buildings.filter((b) => b.kind === 'trap').length,
    groundCover: g1 / tiles,
    groundCover2: g2 / tiles,
    airCover: a1 / tiles,
    groundDps,
    airDps,
    buildingHp,
    hedgesToHall: bestHedges,
    edgeToHall: bestSteps,
    interiorDeploy: inside / Math.max(1, tiles),
    hedgeGapShare: hedges ? Math.max(0, 1 - hedges / ringLen) : 1,
    outsideShare: outside / Math.max(1, countable.length),
    guardianStrength: burrow ? burrowStrength(burrow.level, data) : 0,
    armyHousing: housing,
    armyDps,
    armyStrength: armyStrength(army, levels, data),
    clearSeconds: buildingHp / Math.max(1, armyDps),
    pressure: groundDps / Math.max(1, housing),
  };
}
