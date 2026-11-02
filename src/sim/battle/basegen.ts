/** Generated opponent bases for scouting, built deterministically from a seed. */
import { buildingDef, hallType } from '../data';
import { createRng, int, next, pick, type Rng } from '../rng';
import type { Cost, GameData, ResourceKind } from '../types';
import type { BaseBuilding, BaseLayout } from './types';

interface Occ {
  size: number;
  cells: Uint8Array;
}

function free(o: Occ, x: number, y: number, s: number, gap: number): boolean {
  if (x < 1 || y < 1 || x + s > o.size - 1 || y + s > o.size - 1) return false;
  for (let yy = y - gap; yy < y + s + gap; yy++) {
    for (let xx = x - gap; xx < x + s + gap; xx++) {
      if (xx < 0 || yy < 0 || xx >= o.size || yy >= o.size) continue;
      if (o.cells[yy * o.size + xx]) return false;
    }
  }
  return true;
}

function mark(o: Occ, x: number, y: number, s: number): void {
  for (let yy = y; yy < y + s; yy++) for (let xx = x; xx < x + s; xx++) o.cells[yy * o.size + xx] = 1;
}

/** Try random spots in a square ring around the centre. */
function placeInRing(rng: Rng, o: Occ, s: number, c: number, r1: number, r2: number, gap: number): { x: number; y: number } | null {
  for (let attempt = 0; attempt < 300; attempt++) {
    const r = attempt > 200 ? r2 + 4 : r2;
    const x = int(rng, c - r, c + r) - Math.floor(s / 2);
    const y = int(rng, c - r, c + r) - Math.floor(s / 2);
    const cheb = Math.max(Math.abs(x + s / 2 - c), Math.abs(y + s / 2 - c));
    if (cheb < r1) continue;
    if (free(o, x, y, s, gap)) return { x, y };
  }
  return null;
}

/** Any free spot whose footprint stays a tile clear of the walled rectangle (fallback when the outer band is full). */
function outsideSpot(rng: Rng, o: Occ, s: number, x0: number, y0: number, x1: number, y1: number): { x: number; y: number } | null {
  const spots: { x: number; y: number }[] = [];
  for (let y = 1; y + s <= o.size - 1; y++) {
    for (let x = 1; x + s <= o.size - 1; x++) {
      const clear = x + s < x0 || y + s < y0 || x > x1 + 1 || y > y1 + 1;
      if (clear && free(o, x, y, s, 1)) spots.push({ x, y });
    }
  }
  return spots.length ? spots[int(rng, 0, spots.length - 1)] : null;
}

export function opponentName(rng: Rng, data: GameData): string {
  return `${pick(rng, data.names.placeFirst)} ${pick(rng, data.names.placeSecond)}`;
}

export interface OpponentOptions {
  /**
   * 0..1: how close buildings are to this hall level's caps. 0 = about two
   * levels below the caps (a fresh arrival at this hall), 1 = maxed. Higher
   * also means a bit more loot. Default 0.5.
   */
  levelBias?: number;
}

export function generateOpponent(seed: number, hallLevel: number, data: GameData, opts: OpponentOptions = {}): BaseLayout {
  const rng = createRng(seed);
  const bias = Math.max(0, Math.min(1, opts.levelBias ?? 0.5));
  const map = data.economy.mapSize;
  const hl = Math.max(1, Math.min(hallLevel, data.hall.levels.length));
  const limits = data.hall.levels[hl - 1].limits;
  const o: Occ = { size: map, cells: new Uint8Array(map * map) };
  const buildings: BaseBuilding[] = [];
  let id = 1;
  const add = (type: string, level: number, x: number, y: number) => {
    buildings.push({ id: `o${id++}`, type, level, x, y });
    mark(o, x, y, buildingDef(data, type).size);
  };
  const c = Math.floor(map / 2);
  const ht = hallType(data);
  const hallSize = buildingDef(data, ht).size;
  add(ht, hl, c - hallSize / 2, c - hallSize / 2);

  const levelFor = (type: string) => {
    const max = limits[type]?.maxLevel ?? 1;
    const below = Math.max(0, Math.min(3, Math.round((1 - bias) * 2 + next(rng) - 0.5)));
    return Math.max(1, max - below);
  };
  const layout = data.battle.baseLayoutByHall?.[hl - 1] ?? { hedgeGaps: 2, innerRing: false };
  // Inside the hedge ring: everything but collectors and Beaver Lodges, so the
  // 50% star needs a breach rather than picking off the outskirts.
  const coreCats = ['guardian', 'defense', 'storage', 'trap', 'military', 'social'];
  const core: string[] = [];
  const outer: string[] = [];
  for (const [type, lim] of Object.entries(limits)) {
    const def = buildingDef(data, type);
    if (def.category === 'hedge' || def.category === 'decor') continue;
    let count = lim.count;
    if (def.category === 'builder') count = 2 + int(rng, 0, Math.min(3, lim.count - 2));
    else if (def.category === 'collector') count = Math.max(1, int(rng, Math.ceil(count / 2), count));
    for (let i = 0; i < count; i++) (coreCats.includes(def.category) ? core : outer).push(type);
  }
  // 1. The core: guardians, defenses, storages and traps close to the Elder Toadstool.
  const order = (t: string) => ({ guardian: -1, defense: 0, storage: 1, military: 2, social: 2, trap: 3 } as Record<string, number>)[buildingDef(data, t).category] ?? 4;
  core.sort((a, b) => order(a) - order(b));
  for (const type of core) {
    const def = buildingDef(data, type);
    const ring = def.category === 'defense' || def.category === 'trap' ? { r1: 3, r2: 6 } : def.category === 'military' || def.category === 'social' ? { r1: 4, r2: 7 } : { r1: 2, r2: 5 };
    const spot = placeInRing(rng, o, def.size, c, ring.r1, ring.r2, def.category === 'trap' ? 0 : 1);
    if (spot) add(type, levelFor(type), spot.x, spot.y);
  }

  // 2. Hedges, before the outer buildings so nothing sits on the ring:
  //    an inner ring around the Elder Toadstool on higher levels, then a ring
  //    around the core with a few 2-tile gaps (fewer on higher levels).
  const hedgeLimit = limits.bramble_hedge;
  let rx0 = c - 2;
  let ry0 = c - 2;
  let rx1 = c + 2;
  let ry1 = c + 2;
  if (hedgeLimit && hedgeLimit.count > 0) {
    const lvl = levelFor('bramble_hedge');
    let budget = hedgeLimit.count;
    const ringTiles = (x0: number, y0: number, x1: number, y1: number) => {
      const t: [number, number][] = [];
      for (let x = x0; x <= x1; x++) t.push([x, y0]);
      for (let y = y0 + 1; y <= y1; y++) t.push([x1, y]);
      for (let x = x1 - 1; x >= x0; x--) t.push([x, y1]);
      for (let y = y1 - 1; y > y0; y--) t.push([x0, y]);
      return t;
    };
    const lay = (tiles: [number, number][], gaps: number) => {
      // Gaps are 2 tiles wide and spread evenly from a random start. With too
      // few hedges for the whole ring, they form one continuous arc.
      const start = int(rng, 0, tiles.length - 1);
      const skip = new Set<number>();
      for (let g = 0; g < gaps; g++) {
        const at = Math.floor((g * tiles.length) / Math.max(1, gaps));
        skip.add(at);
        skip.add((at + 1) % tiles.length);
      }
      for (let k = 0; k < tiles.length && budget > 0; k++) {
        if (skip.has(k)) continue;
        const [x, y] = tiles[(start + k) % tiles.length];
        if (x < 0 || y < 0 || x >= map || y >= map || o.cells[y * map + x]) continue;
        add('bramble_hedge', lvl, x, y);
        budget--;
      }
    };
    if (layout.innerRing) {
      const hb = buildings[0];
      lay(ringTiles(hb.x - 1, hb.y - 1, hb.x + hallSize, hb.y + hallSize), 1);
    }
    const coreB = buildings.filter((b) => b.type !== 'bramble_hedge' && buildingDef(data, b.type).category !== 'trap');
    let x0 = map;
    let y0 = map;
    let x1 = 0;
    let y1 = 0;
    for (const b of coreB) {
      const sz = buildingDef(data, b.type).size;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + sz);
      y1 = Math.max(y1, b.y + sz);
    }
    rx0 = x0 - 2;
    ry0 = y0 - 2;
    rx1 = x1 + 1;
    ry1 = y1 + 1;
    lay(ringTiles(rx0, ry0, rx1, ry1), layout.hedgeGaps);
  }

  // 3. Everything else outside the ring, with a lane between.
  const ringR = Math.max(c - rx0, rx1 - c, c - ry0, ry1 - c);
  for (const type of outer) {
    const def = buildingDef(data, type);
    const r1 = Math.ceil(Math.max(8, ringR + 2 + def.size / 2));
    const spot = placeInRing(rng, o, def.size, c, r1, Math.min(Math.floor(map / 2) - 1, r1 + 6), 1) ?? outsideSpot(rng, o, def.size, rx0, ry0, rx1, ry1);
    if (spot) add(type, levelFor(type), spot.x, spot.y);
  }

  // Loot: spread between storages, collectors and the hall.
  const range = data.battle.generatedLootByHall[hl - 1];
  const shares = data.battle.lootShares;
  for (const res of ['acorns', 'dew'] as ResourceKind[]) {
    const total = Math.floor(range.min + (range.max - range.min) * (0.5 * next(rng) + 0.5 * bias));
    const holders = (cat: string) =>
      buildings.filter((b) => {
        const d = buildingDef(data, b.type);
        if (d.category !== cat) return false;
        if (cat === 'collector') return d.produces === res;
        return Object.keys(d.levels[0].storage ?? {}).includes(res);
      });
    const give = (bs: BaseBuilding[], amount: number) => {
      if (!bs.length) return amount;
      const each = Math.floor(amount / bs.length);
      for (const b of bs) b.loot = { ...(b.loot ?? {}), [res]: ((b.loot as Cost)?.[res] ?? 0) + each };
      return amount - each * bs.length;
    };
    let rest = 0;
    rest += give(holders('storage'), Math.floor(total * shares.storage));
    rest += give(holders('collector'), Math.floor(total * shares.collector));
    const hall = buildings[0];
    const hallAmount = total - Math.floor(total * shares.storage) - Math.floor(total * shares.collector) + rest;
    // Shares with no holder (no storages or collectors) came back in `rest`, so they land in the hall.
    hall.loot = { ...(hall.loot ?? {}), [res]: ((hall.loot as Cost)?.[res] ?? 0) + hallAmount };
  }
  return { name: opponentName(rng, data), hallLevel: hl, buildings };
}

/** Total loot on offer in a base. */
export function totalLoot(base: BaseLayout): Cost {
  const out: Cost = {};
  for (const b of base.buildings) for (const [k, v] of Object.entries(b.loot ?? {}) as [ResourceKind, number][]) out[k] = (out[k] ?? 0) + v;
  return out;
}
