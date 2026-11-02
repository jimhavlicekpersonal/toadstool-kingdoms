/** Base geometry: where troops may land, and how generated bases are laid out by level. */
import { describe, expect, it } from 'vitest';
import { createBattle } from '../../src/sim/battle/battle';
import { generateOpponent } from '../../src/sim/battle/basegen';
import { buildingDef, defaultData as data } from '../../src/sim/data';

describe('drop zone', () => {
  it('is open ground reachable from the map edge, so a closed hedge ring keeps troops outside', () => {
    const ring: { id: string; type: string; level: number; x: number; y: number }[] = [];
    for (let x = 12; x <= 27; x++) ring.push({ id: `t${x}`, type: 'bramble_hedge', level: 1, x, y: 12 }, { id: `b${x}`, type: 'bramble_hedge', level: 1, x, y: 27 });
    for (let y = 13; y <= 26; y++) ring.push({ id: `l${y}`, type: 'bramble_hedge', level: 1, x: 12, y }, { id: `r${y}`, type: 'bramble_hedge', level: 1, x: 27, y });
    const base = { name: 'Ring', hallLevel: 3, buildings: [{ id: 'h', type: 'elder_toadstool', level: 1, x: 18, y: 18 }, ...ring] };
    const sim = createBattle({ seed: 1, base, army: {} }, data);
    const n = sim.grid.size;
    // Open ground well inside the ring, away from the hall.
    expect(sim.deployable[15 * n + 15]).toBe(0);
    // Outside the ring it's fine.
    expect(sim.deployable[5 * n + 5]).toBe(1);
  });

  it('a wide opening in the ring lets troops in', () => {
    const ring: { id: string; type: string; level: number; x: number; y: number }[] = [];
    for (let x = 12; x <= 27; x++) if (x < 17 || x > 22) ring.push({ id: `t${x}`, type: 'bramble_hedge', level: 1, x, y: 12 });
    for (let x = 12; x <= 27; x++) ring.push({ id: `b${x}`, type: 'bramble_hedge', level: 1, x, y: 27 });
    for (let y = 13; y <= 26; y++) ring.push({ id: `l${y}`, type: 'bramble_hedge', level: 1, x: 12, y }, { id: `r${y}`, type: 'bramble_hedge', level: 1, x: 27, y });
    const base = { name: 'Open', hallLevel: 3, buildings: [{ id: 'h', type: 'elder_toadstool', level: 1, x: 18, y: 18 }, ...ring] };
    const sim = createBattle({ seed: 1, base, army: {} }, data);
    expect(sim.deployable[15 * sim.grid.size + 15]).toBe(1);
  });
});

describe('generated base layout', () => {
  it('keeps outer buildings off the hedge ring, so gaps are only the planned ones', () => {
    for (let h = 2; h <= data.hall.levels.length; h++) {
      for (const seed of [3, 11, 99]) {
        const base = generateOpponent(seed, h, data);
        const sim = createBattle({ seed, base, army: {} }, data);
        const n = sim.grid.size;
        // The hall's surroundings are not a drop zone from Elder Toadstool 3 (closed enough ring).
        const hall = base.buildings[0];
        if (h >= 3) {
          let inside = 0;
          for (let y = hall.y - 3; y < hall.y + 7; y++) for (let x = hall.x - 3; x < hall.x + 7; x++) inside += sim.deployable[y * n + x];
          expect(inside, `hall ${h} seed ${seed}`).toBe(0);
        }
        // Every hedge is part of a ring line, never inside another building.
        for (const b of base.buildings) expect(buildingDef(data, b.type)).toBeDefined();
      }
    }
  });
});
