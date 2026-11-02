import buildings from '../data/buildings.json';
import hall from '../data/hall.json';
import economy from '../data/economy.json';
import troops from '../data/troops.json';
import battle from '../data/battle.json';
import names from '../data/names.json';
import ranks from '../data/ranks.json';
import raids from '../data/raids.json';
import store from '../data/store.json';
import offers from '../data/offers.json';
import pass from '../data/pass.json';
import cosmetics from '../data/cosmetics.json';
import achievements from '../data/achievements.json';
import social from '../data/social.json';
import daily from '../data/daily.json';
import events from '../data/events.json';
import notifications from '../data/notifications.json';
import guardians from '../data/guardians.json';
import type { BuildingDef, BuildingType, GameData, LevelDef, TroopLevelDef } from './types';

/** The game's balance data, straight from src/data/*.json. */
export const defaultData: GameData = {
  buildings: buildings as unknown as GameData['buildings'],
  hall: hall as unknown as GameData['hall'],
  economy: economy as unknown as GameData['economy'],
  troops: troops as unknown as GameData['troops'],
  battle: battle as unknown as GameData['battle'],
  names: names as unknown as GameData['names'],
  ranks: ranks as unknown as GameData['ranks'],
  raids: raids as unknown as GameData['raids'],
  store: store as unknown as GameData['store'],
  offers: offers as unknown as GameData['offers'],
  pass: pass as unknown as GameData['pass'],
  cosmetics: cosmetics as unknown as GameData['cosmetics'],
  achievements: achievements as unknown as GameData['achievements'],
  social: social as unknown as GameData['social'],
  daily: daily as unknown as GameData['daily'],
  events: events as unknown as GameData['events'],
  notifications: notifications as unknown as GameData['notifications'],
  guardians: guardians as unknown as GameData['guardians'],
};

export function buildingDef(data: GameData, type: BuildingType): BuildingDef {
  const def = data.buildings[type];
  if (!def) throw new Error(`Unknown building type: ${type}`);
  return def;
}

export function levelDef(data: GameData, type: BuildingType, level: number): LevelDef | undefined {
  return buildingDef(data, type).levels.find((l) => l.level === level);
}

export function maxDefinedLevel(data: GameData, type: BuildingType): number {
  const levels = buildingDef(data, type).levels;
  return levels.length ? levels[levels.length - 1].level : 0;
}

export function hallType(data: GameData): BuildingType {
  const entry = Object.entries(data.buildings).find(([, d]) => d.category === 'hall');
  if (!entry) throw new Error('No hall building defined');
  return entry[0];
}

export function troopDef(data: GameData, type: string) {
  const def = data.troops[type];
  if (!def) throw new Error(`Unknown troop type: ${type}`);
  return def;
}

/** Highest level defined for a troop. */
export function maxTroopLevel(data: GameData, type: string): number {
  return troopDef(data, type).levels.length;
}

/** Stats of a troop at a level (clamped to the levels that exist). */
export function troopLevel(data: GameData, type: string, level = 1): TroopLevelDef {
  const levels = troopDef(data, type).levels;
  const i = Math.max(1, Math.min(levels.length, Math.floor(level) || 1)) - 1;
  return levels[i];
}

export function guardianDef(data: GameData, type: string) {
  const def = data.guardians.animals[type];
  if (!def) throw new Error(`Unknown guardian type: ${type}`);
  return def;
}

/** Stats of a guardian animal at a level (clamped to the levels that exist). */
export function guardianLevel(data: GameData, type: string, level = 1): { level: number; hp: number; damage: number } {
  const levels = guardianDef(data, type).levels;
  return levels[Math.max(1, Math.min(levels.length, Math.floor(level) || 1)) - 1];
}
