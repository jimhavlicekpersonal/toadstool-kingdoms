/**
 * Group combat strength (Lanchester's square law): sqrt(total HP x total
 * damage per second). Doubling a group's size doubles its strength.
 */
import { troopDef, troopLevel } from './data';
import type { GameData } from './types';

export function groupStrength(units: { hp: number; dps: number; n: number }[]): number {
  let hp = 0;
  let dps = 0;
  for (const u of units) {
    hp += u.hp * u.n;
    dps += u.dps * u.n;
  }
  return Math.sqrt(hp * dps);
}

/** Strength of an army at given troop levels. */
export function armyStrength(army: Record<string, number>, levels: Record<string, number>, data: GameData): number {
  const tps = data.battle.ticksPerSecond;
  return groupStrength(
    Object.entries(army).map(([t, n]) => {
      const s = troopLevel(data, t, levels[t] ?? 1);
      return { hp: s.hp, dps: (s.damage * tps) / troopDef(data, t).attackIntervalTicks, n };
    }),
  );
}
