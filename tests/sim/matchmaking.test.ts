/** Scouting (#1, #2), trophy-based matchmaking (#3), trophy equilibrium (#4) and the loot penalty. */
import { describe, expect, it } from 'vitest';
import { totalLoot } from '../../src/sim/battle/basegen';
import { applyLootPenalty, matchStrength, opponentFor, readiness, strengthFor } from '../../src/sim/matchmaking';
import { lossTrophies, winTrophies } from '../../src/sim/ranks';
import { createRng, next } from '../../src/sim/rng';
import type { VillageState } from '../../src/sim/types';
import { applyCommand, leagueWinBonus, scoutFee } from '../../src/sim/village';
import { data, must, newGame } from './helpers';

function seedOf(r: ReturnType<typeof applyCommand>): number {
  if (!r.ok) throw new Error(r.message);
  const e = r.events.find((x) => x.kind === 'scout');
  return e && e.kind === 'scout' ? e.seed : -1;
}

function atHall(state: VillageState, hall: number): VillageState {
  return { ...state, buildings: state.buildings.map((b) => (b.type === 'elder_toadstool' ? { ...b, level: hall } : b)) };
}

/** A village at `hall` with every Army Camp, the Barracks and troop research at that hall's caps. */
function builtUp(state: VillageState, hall: number): VillageState {
  const s = atHall(state, hall);
  const lim = data.hall.levels[hall - 1].limits;
  const extra = [
    ...Array.from({ length: lim.army_camp.count }, (_, i) => ({ id: `camp${i}`, type: 'army_camp', level: lim.army_camp.maxLevel, x: 2 + i * 4, y: 2, upgrade: null, collector: null })),
    { id: 'barracks', type: 'burrow_barracks', level: lim.burrow_barracks.maxLevel, x: 2, y: 6, upgrade: null, collector: null },
  ];
  const cap = data.hall.levels[hall - 1].troopLevelCap;
  return { ...s, buildings: [...s.buildings, ...extra], research: { levels: Object.fromEntries(Object.keys(data.troops).map((t) => [t, Math.min(cap, data.troops[t].levels.length)])), active: null } };
}

const avgLoot = (hall: number) => {
  const r = data.battle.generatedLootByHall[hall - 1];
  return (r.min + r.max) / 2;
};

describe('scouting (#1, #2)', () => {
  it('leaving and pressing Attack again shows the same opponent; only Next rerolls, for the fee', () => {
    const { state, clock } = newGame({ acorns: 2000 });
    const first = applyCommand(state, { type: 'scout', paid: false }, clock.now(), data);
    const s1 = (first as { state: VillageState }).state;
    // "Home", then "Attack" again: same base, nothing paid.
    const again = applyCommand(s1, { type: 'scout', paid: false }, clock.now(), data);
    expect(seedOf(again)).toBe(seedOf(first));
    expect((again as { state: VillageState }).state.resources.acorns).toBe(2000);
    // Next costs the fee and gives a new base, which then sticks too.
    const next = applyCommand(s1, { type: 'scout', paid: true }, clock.now(), data);
    const s2 = (next as { state: VillageState }).state;
    expect(seedOf(next)).not.toBe(seedOf(first));
    expect(s2.resources.acorns).toBe(2000 - scoutFee(s1, data));
    expect(seedOf(applyCommand(s2, { type: 'scout', paid: false }, clock.now(), data))).toBe(seedOf(next));
  });

  it('after an attack, the next look is free and new', () => {
    const { state, clock } = newGame();
    const s0 = { ...state, army: { hedgehog_roller: 5 } };
    const r = applyCommand(s0, { type: 'scout', paid: false }, clock.now(), data);
    const s1 = (r as { state: VillageState }).state;
    const base = opponentFor(seedOf(r), s1, data);
    const s2 = must(s1, { type: 'battleEnd', record: { at: clock.now(), opponentName: base.name, setup: { seed: 1, base, army: s1.army }, deployments: [] } }, clock.now());
    expect(s2.scout).toBeNull();
    expect(seedOf(applyCommand(s2, { type: 'scout', paid: false }, clock.now(), data))).not.toBe(seedOf(r));
  });

  it('the Next fee is a steady share of the loot on offer at every hall', () => {
    const { state } = newGame();
    for (let h = 1; h <= data.hall.levels.length; h++) {
      const share = scoutFee(atHall(state, h), data) / avgLoot(h);
      expect(share, `hall ${h}`).toBeGreaterThanOrEqual(0.02);
      expect(share, `hall ${h}`).toBeLessThanOrEqual(0.05);
    }
  });
});

describe('matchmaking by trophies (#3)', () => {
  it('more trophies bring stronger opponents with more loot', () => {
    const { state } = newGame();
    const s = builtUp(state, 5);
    const avg = (trophies: number) => {
      let hall = 0;
      let loot = 0;
      let lvl = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const b = opponentFor(seed * 7919, { ...s, trophies }, data);
        hall += b.hallLevel;
        const l = totalLoot(b);
        loot += (l.acorns ?? 0) + (l.dew ?? 0);
        const cannons = b.buildings.filter((x) => x.type === 'acorn_cannon');
        lvl += cannons.reduce((n, x) => n + x.level, 0) / Math.max(1, cannons.length);
      }
      return { hall: hall / 20, loot: loot / 20, lvl: lvl / 20 };
    };
    // A hall 5 village: low trophies meet fresh hall 5 bases, high trophies meet built-up ones and some hall 6.
    const low = avg(0);
    const mid = avg(1500);
    const high = avg(2050);
    expect(low.hall).toBe(5);
    expect(high.hall).toBeGreaterThan(mid.hall);
    expect(mid.lvl).toBeGreaterThan(low.lvl);
    expect(mid.loot).toBeGreaterThan(low.loot);
    expect(high.loot).toBeGreaterThan(mid.loot);
  });

  it('opponents stay within the allowed hall range, and their trophies follow their strength', () => {
    const { state } = newGame();
    for (const hall of [1, 3, 6]) {
      for (const trophies of [0, 500, 1200, 3000]) {
        for (let i = 0; i < 15; i++) {
          const m = matchStrength(createRng(i * 31 + trophies), trophies, hall, data);
          // Never below your own hall: trophies that lag behind your hall just mean fresher bases.
          expect(m.hall).toBeGreaterThanOrEqual(Math.max(1, hall - Math.ceil(data.ranks.matchmaking.hallsBelow)));
          expect(m.hall).toBeLessThanOrEqual(Math.min(6, hall + 1));
          const s = m.hall - 1 + m.bias;
          expect(Math.abs(m.trophies - s * data.ranks.matchmaking.trophiesPerHall)).toBeLessThanOrEqual(data.ranks.matchmaking.trophyJitter + 1);
        }
      }
    }
    void state;
  });

  it('opponents follow army strength: a built-up village meets its own hall, one still building up meets weaker bases', () => {
    const { state } = newGame();
    for (const hall of [3, 4, 6]) {
      const ready = { ...builtUp(state, hall), trophies: 0 };
      expect(readiness(ready, data)).toBeGreaterThan(0.95);
      const fresh = { ...atHall(state, hall), trophies: 0 };
      expect(readiness(fresh, data)).toBe(0);
      for (let seed = 1; seed <= 10; seed++) {
        expect(opponentFor(seed * 31, ready, data).hallLevel).toBeGreaterThanOrEqual(hall);
        expect(opponentFor(seed * 31, fresh, data).hallLevel).toBeLessThan(hall);
        expect(opponentFor(seed * 31, fresh, data).hallLevel).toBeGreaterThanOrEqual(hall - Math.ceil(data.ranks.matchmaking.hallsBelow));
      }
    }
    // The penalty still exists for higher-hall attackers (bot raiders one hall above you).
    const base = opponentFor(5, { ...atHall(state, 2), trophies: 0 }, data);
    const cut = applyLootPenalty(structuredClone(base), 3, data);
    expect(totalLoot(cut).acorns!).toBeLessThan(totalLoot(base).acorns!);
  });

  it('higher leagues add a bonus to won attacks', () => {
    expect(leagueWinBonus(0, 3, data)).toEqual({});
    expect(leagueWinBonus(2100, 0, data)).toEqual({});
    const elder = leagueWinBonus(2100, 3, data);
    expect(elder.acorns!).toBeGreaterThan(leagueWinBonus(1100, 3, data).acorns!);
    expect(leagueWinBonus(2100, 1, data).acorns).toBe(Math.floor(elder.acorns! / 3));
  });
});

describe('trophy equilibrium (#4)', () => {
  /**
   * Simulate many attacks with a player who wins against bases up to a
   * strength and loses above it (with some noise), through the real
   * matchmaking and trophy formulas.
   */
  function settle(ownHall: number, beatsUpTo: number, attacks = 600): number {
    let trophies = 0;
    const rng = createRng(ownHall * 1000 + Math.round(beatsUpTo * 10));
    for (let i = 0; i < attacks; i++) {
      const m = matchStrength(rng, trophies, ownHall, data);
      const s = m.hall - 1 + m.bias;
      const pWin = 1 / (1 + Math.exp((s - beatsUpTo) * 4));
      const won = next(rng) < pWin;
      trophies = Math.max(0, trophies + (won ? winTrophies(trophies, m.trophies, data) : -lossTrophies(trophies, m.trophies, data)));
    }
    return trophies;
  }

  it('trophies settle near what the army can beat instead of climbing forever', () => {
    const tph = data.ranks.matchmaking.trophiesPerHall;
    // An army that can beat bases up to strength 2.5 settles around 2.5 * tph.
    const mid = settle(3, 2.5);
    expect(mid).toBeGreaterThan(1.8 * tph);
    expect(mid).toBeLessThan(3.2 * tph);
  });

  it('a hall 1 village cannot reach the Elder League even if it wins far above its level', () => {
    // Its opponents are at most hall 2, so once its trophies run ahead of
    // them, wins pay almost nothing and losses cost a lot.
    const t = settle(1, 2.6);
    expect(t).toBeLessThan(data.ranks.leagues.find((l) => l.id === 'elder')!.min);
    expect(t).toBeLessThan(3.5 * data.ranks.matchmaking.trophiesPerHall);
  });

  it('strength is trophies over trophiesPerHall', () => {
    expect(strengthFor(data.ranks.matchmaking.trophiesPerHall * 2, data)).toBe(2);
  });
});
