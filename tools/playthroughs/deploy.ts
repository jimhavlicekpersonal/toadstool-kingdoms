/** Alternative attack plans for simulated players (the game's bots always use one side). */
import { troopDef, troopLevel } from '../../src/sim/data';
import type { Deployment } from '../../src/sim/battle/types';
import { createRng, int, next } from '../../src/sim/rng';
import type { GameData } from '../../src/sim/types';

/**
 * Split the army over `sides` map edges (1 = all from one side, 4 = all
 * around). Toughest troops go first on every side, then the rest in waves.
 */
export function edgeDeployments(sides: number, deployable: Uint8Array, size: number, army: Record<string, number>, seed: number, data: GameData, levels: Record<string, number>): Deployment[] {
  const rng = createRng(seed ^ 0x51de5);
  const first = int(rng, 0, 3);
  const chosen = Array.from({ length: Math.max(1, Math.min(4, sides)) }, (_, i) => (first + (sides === 2 ? i : i)) % 4);
  const spotsBySide = chosen.map((side) => {
    const along = (0.25 + next(rng) * 0.5) * size;
    const ex = side === 0 ? along : side === 1 ? size - 1 : side === 2 ? along : 0;
    const ey = side === 0 ? 0 : side === 1 ? along : side === 2 ? size - 1 : along;
    const tiles: { x: number; y: number; d: number }[] = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (deployable[y * size + x]) tiles.push({ x, y, d: (x - ex) * (x - ex) + (y - ey) * (y - ey) });
    tiles.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
    return tiles.slice(0, 6);
  });
  const tough = (t: string) => troopLevel(data, t, levels[t] ?? 1).hp / troopDef(data, t).housing;
  const order = Object.keys(army).filter((t) => army[t] > 0).sort((a, b) => tough(b) - tough(a) || (a < b ? -1 : 1));
  const out: Deployment[] = [];
  let tick = 0;
  for (const troop of order) {
    const n = army[troop];
    for (let i = 0; i < n; i++) {
      const spots = spotsBySide[i % spotsBySide.length];
      if (!spots.length) continue;
      const s = spots[Math.floor(i / spotsBySide.length) % spots.length];
      out.push({ tick: tick + Math.floor(i / (2 * spotsBySide.length)), troop, x: s.x, y: s.y });
    }
    tick += Math.ceil(n / (2 * spotsBySide.length)) + 10;
  }
  return out;
}
