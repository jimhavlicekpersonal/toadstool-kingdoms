/**
 * Combat-strength measures used to shape difficulty curves. Strength follows
 * Lanchester's square law for a group: sqrt(total HP x total damage per
 * second), so doubling a group's size doubles its strength.
 */
import { botArmy } from './matchmaking';
import { guardianDef, guardianLevel, levelDef } from './data';
import { troopLevelCapAt } from './research';
import { armyStrength, groupStrength } from './strength';
import type { GameData } from './types';

export { armyStrength } from './strength';

/** Strength of the guardians a Guardian Burrow of this level releases (0 for none). */
export function burrowStrength(level: number, data: GameData): number {
  if (level < 1) return 0;
  const tps = data.battle.ticksPerSecond;
  const g = levelDef(data, 'guardian_burrow', level)?.guardians ?? {};
  return groupStrength(
    Object.entries(g).map(([t, v]) => {
      const s = guardianLevel(data, t, v.level);
      return { hp: s.hp, dps: (s.damage * tps) / guardianDef(data, t).attackIntervalTicks, n: v.count };
    }),
  );
}

/** Highest Guardian Burrow level allowed at a hall level (0 = none yet). */
export function burrowCapAt(hall: number, data: GameData): number {
  return data.hall.levels[hall - 1]?.limits.guardian_burrow?.maxLevel ?? 0;
}

/** Guardian strength at a hall's cap, as a share of a full matched army's strength. */
export function guardianShare(hall: number, data: GameData): number {
  const cap = troopLevelCapAt(hall, data);
  const army = botArmy(hall, 1, data);
  const levels = Object.fromEntries(Object.keys(army).map((t) => [t, cap]));
  return burrowStrength(burrowCapAt(hall, data), data) / armyStrength(army, levels, data);
}
