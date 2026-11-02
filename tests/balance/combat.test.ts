/**
 * Attack vs defense at matched strength, with real battles (#5, #7, #8).
 *
 * The attacker is the simple bot plan (everything from one side, toughest
 * troops first) with a full army at its hall's research cap, the same plan
 * bot raiders use against the player. A thoughtful player does better.
 */
import { describe, expect, it } from 'vitest';
import { maxHousingAtHall } from '../../src/sim/army';
import { createBattle, runBattle } from '../../src/sim/battle/battle';
import { generateOpponent } from '../../src/sim/battle/basegen';
import { defaultData as data } from '../../src/sim/data';
import { botDeployments } from '../../src/sim/defense';
import { botArmy } from '../../src/sim/matchmaking';
import { edgeDeployments } from '../../tools/playthroughs/deploy';
import { troopLevelCapAt } from '../../src/sim/research';
import { createRng } from '../../src/sim/rng';

interface Outcome {
  destruction: number;
  oneStar: number;
  threeStar: number;
}

function fight(baseHall: number, bias: number, army: Record<string, number>, level: number, n = 10): Outcome {
  let d = 0;
  let one = 0;
  let three = 0;
  const levels = Object.fromEntries(Object.keys(army).map((t) => [t, level]));
  for (let i = 0; i < n; i++) {
    const base = generateOpponent(1000 + i * 7919, baseHall, data, { levelBias: bias });
    const setup = { seed: 42 + i, base, army, levels };
    const probe = createBattle(setup, data);
    const deps = botDeployments(probe.deployable, probe.grid.size, army, createRng(9 + i), data, levels);
    const { result } = runBattle(setup, deps, data);
    d += result.destruction;
    if (result.stars >= 1) one++;
    if (result.stars === 3) three++;
  }
  return { destruction: d / n, oneStar: one / n, threeStar: three / n };
}

describe('attack vs defense at the same hall (#5)', () => {
  for (const hall of [3, 4, 5, 6]) {
    it(`hall ${hall}: a full army usually wins, but often leaves buildings standing`, { timeout: 60_000 }, () => {
      const o = fight(hall, 0.5, botArmy(hall, 1, data), troopLevelCapAt(hall, data));
      // It used to be close to 100% destruction and 3 stars every time.
      expect(o.destruction).toBeGreaterThanOrEqual(45);
      expect(o.destruction).toBeLessThanOrEqual(90);
      expect(o.oneStar).toBeGreaterThanOrEqual(0.6);
      expect(o.threeStar).toBeLessThanOrEqual(0.65);
    });
  }

  it('a base a hall above is much harder', { timeout: 60_000 }, () => {
    const same = fight(4, 0.5, botArmy(4, 1, data), troopLevelCapAt(4, data));
    const above = fight(5, 0.2, botArmy(4, 1, data), troopLevelCapAt(4, data));
    expect(above.destruction).toBeLessThan(same.destruction - 10);
  });
});

describe('levels in order of difficulty (docs/DIFFICULTY.md)', () => {
  /**
   * Battle difficulty of a level: every army style, deployed from one, two
   * and four sides, at research one level under the cap, against fresh and
   * built-up bases of the same level.
   */
  function levelDifficulty(hall: number, seeds = 3): number {
    const styles: (Record<string, number> | null)[] = [null, { hedgehog_roller: 0.8, frog_lobber: 0.2 }, { beetle_brute: 0.35, hedgehog_roller: 0.35, frog_lobber: 0.3 }, { owl_bomber: 0.45, frog_lobber: 0.35, hedgehog_roller: 0.2 }];
    const lvl = Math.max(1, troopLevelCapAt(hall, data) - 1);
    const maxBarracks = data.hall.levels[hall - 1].limits.burrow_barracks.maxLevel;
    const H = maxHousingAtHall(hall, data);
    let won = 0;
    let n = 0;
    let destr = 0;
    let deployed = 0;
    let lost = 0;
    for (const mix of styles) {
      let army = botArmy(hall, 1, data);
      if (mix) {
        army = {};
        const ok = Object.entries(mix).filter(([t]) => data.troops[t].barracksLevel <= maxBarracks);
        const sum = ok.reduce((a, [, v]) => a + v, 0);
        let used = 0;
        for (const [t, v] of ok) {
          const k = Math.floor((H * v) / sum / data.troops[t].housing);
          if (k > 0) army[t] = k;
          used += k * data.troops[t].housing;
        }
        army.hedgehog_roller = (army.hedgehog_roller ?? 0) + (H - used);
      }
      const levels = Object.fromEntries(Object.keys(army).map((t) => [t, lvl]));
      for (const sides of [1, 2, 4]) {
        for (const bias of [0.25, 0.75]) {
          for (let i = 0; i < seeds; i++) {
            const base = generateOpponent(500 + i * 7919 + hall, hall, data, { levelBias: bias });
            const setup = { seed: 11 + i, base, army, levels };
            const probe = createBattle(setup, data);
            const { sim, result } = runBattle(setup, edgeDeployments(sides, probe.deployable, probe.grid.size, army, 77 + i * 13, data, levels), data);
            n++;
            if (result.stars >= 1) won++;
            destr += result.destruction;
            const att = sim.troops.filter((t) => t.side === 'attack');
            deployed += att.length;
            lost += att.filter((t) => t.dead).length;
          }
        }
      }
    }
    return 0.4 * (1 - won / n) + 0.3 * (lost / deployed) + 0.3 * (1 - destr / n / 100);
  }

  it('each level is harder than the one before', { timeout: 300_000 }, () => {
    // Single bases vary a lot, so neighbouring levels get a small tolerance;
    // levels two apart must be clearly ordered.
    const d = [2, 3, 4, 5, 6].map((h) => levelDifficulty(h, 6));
    const show = d.map((x) => x.toFixed(3)).join(', ');
    for (let i = 1; i < d.length; i++) expect(d[i], `level ${i + 2} vs ${i + 1}: ${show}`).toBeGreaterThan(d[i - 1] - 0.02);
    for (let i = 2; i < d.length; i++) expect(d[i], `level ${i + 2} vs ${i}: ${show}`).toBeGreaterThan(d[i - 2]);
    expect(d[d.length - 1] - d[0]).toBeGreaterThan(0.1);
  });
});

describe('army make-up matters (#7)', () => {
  it('a mixed army beats the same housing of Hedgehogs alone', { timeout: 60_000 }, () => {
    for (const hall of [4, 6]) {
      const lvl = troopLevelCapAt(hall, data);
      const mixed = fight(hall, 0.5, botArmy(hall, 1, data), lvl, 8);
      const hedgehogs = fight(hall, 0.5, { hedgehog_roller: maxHousingAtHall(hall, data) }, lvl, 8);
      expect(mixed.destruction).toBeGreaterThan(hedgehogs.destruction + 15);
    }
  });
});
