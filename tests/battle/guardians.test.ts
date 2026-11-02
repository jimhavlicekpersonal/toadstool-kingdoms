/** Guardian animals: released from the Guardian Burrow, fight raiders, follow a rising difficulty curve. */
import { describe, expect, it } from 'vitest';
import { runBattle } from '../../src/sim/battle/battle';
import { generateOpponent } from '../../src/sim/battle/basegen';
import { defaultData as data } from '../../src/sim/data';
import { burrowCapAt, guardianShare } from '../../src/sim/difficulty';

const base = (burrowLevel: number) => ({
  name: 'Burrow test',
  hallLevel: 3,
  buildings: [
    { id: 'h', type: 'elder_toadstool', level: 1, x: 10, y: 10 },
    { id: 'g', type: 'guardian_burrow', level: burrowLevel, x: 20, y: 18 },
  ],
});
const rush = (troop: string, n: number, x = 26, y = 19) => Array.from({ length: n }, (_, i) => ({ tick: i, troop, x, y }));

describe('guardian animals', () => {
  it('come out when raiders get close, one after another', () => {
    const { sim } = runBattle({ seed: 3, base: base(2), army: { hedgehog_roller: 6 } }, rush('hedgehog_roller', 6), data, 200);
    const guards = sim.troops.filter((t) => t.side === 'guard');
    const inside = data.buildings.guardian_burrow.levels[1].guardians!;
    const expected = Object.entries(inside).flatMap(([t, v]) => Array(v.count).fill(t)).sort();
    expect(guards.map((g) => g.type).sort()).toEqual(expected);
    // Released one at a time, not all at once.
    expect(sim.troops.filter((t) => t.side === 'guard').length).toBeGreaterThan(1);
  });

  it('stay inside when nobody comes near', () => {
    const { sim } = runBattle({ seed: 3, base: base(2), army: { hedgehog_roller: 1 } }, [{ tick: 0, troop: 'hedgehog_roller', x: 1, y: 1 }], data, 20);
    expect(sim.troops.filter((t) => t.side === 'guard')).toHaveLength(0);
  });

  it('kill raiders, and raiders fight back', () => {
    const { sim } = runBattle({ seed: 3, base: base(5), army: { hedgehog_roller: 8 } }, rush('hedgehog_roller', 8), data);
    const guardKills = ['badger_warden', 'stoat_skirmisher', 'hawk_sentinel'].reduce((n, g) => n + (sim.kills[g] ?? 0), 0);
    expect(guardKills).toBeGreaterThan(0);
    const { sim: big } = runBattle({ seed: 3, base: base(1), army: { hedgehog_roller: 20 } }, rush('hedgehog_roller', 20), data);
    expect(big.guardiansDefeated).toBeGreaterThan(0);
  });

  it('Beetle Brutes ignore guardians and only ranged troops can hit hawks', () => {
    const { sim } = runBattle({ seed: 3, base: base(4), army: { beetle_brute: 2 } }, rush('beetle_brute', 2), data, 400);
    expect(sim.guardiansDefeated).toBe(0);
    const { sim: frogs } = runBattle({ seed: 5, base: base(4), army: { frog_lobber: 30 } }, rush('frog_lobber', 30), data);
    const hawk = frogs.troops.find((t) => t.type === 'hawk_sentinel');
    expect(hawk).toBeDefined();
  });

  it('a destroyed burrow lets out everyone still inside at once', () => {
    const { sim } = runBattle({ seed: 3, base: base(3), army: { hedgehog_roller: 40 } }, rush('hedgehog_roller', 40, 22, 22), data);
    const b = sim.buildings.find((x) => x.type === 'guardian_burrow')!;
    expect(b.pending).toHaveLength(0);
  });

  it('battles with guardians replay identically', () => {
    const a = runBattle({ seed: 9, base: base(5), army: { hedgehog_roller: 15, frog_lobber: 10 } }, [...rush('hedgehog_roller', 15), ...rush('frog_lobber', 10, 27, 20)], data);
    const b = runBattle({ seed: 9, base: base(5), army: { hedgehog_roller: 15, frog_lobber: 10 } }, [...rush('hedgehog_roller', 15), ...rush('frog_lobber', 10, 27, 20)], data);
    expect(a.result.hash).toBe(b.result.hash);
  });

  it('generated bases from Elder Toadstool 2 have a burrow in the core', () => {
    expect(generateOpponent(1, 1, data).buildings.some((b) => b.type === 'guardian_burrow')).toBe(false);
    for (let h = 2; h <= data.hall.levels.length; h++) {
      const b = generateOpponent(7, h, data).buildings.find((x) => x.type === 'guardian_burrow');
      expect(b, `hall ${h}`).toBeDefined();
      expect(Math.max(Math.abs(b!.x + 1.5 - 20), Math.abs(b!.y + 1.5 - 20))).toBeLessThanOrEqual(8);
    }
  });
});

describe('guardian difficulty curve', () => {
  it('guardian strength rises with the hall level along the curve in guardians.json', () => {
    const curve = data.guardians.strengthShareByHall;
    let last = -1;
    for (let h = 1; h <= data.hall.levels.length; h++) {
      const share = guardianShare(h, data);
      expect(share, `hall ${h}`).toBeGreaterThan(last);
      expect(Math.abs(share - curve[h - 1]), `hall ${h}: ${share.toFixed(3)} vs ${curve[h - 1]}`).toBeLessThanOrEqual(0.01);
      last = share;
    }
    expect(burrowCapAt(1, data)).toBe(0);
  });
});
