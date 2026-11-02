/**
 * Matchmaking for generated opponents and bot raiders.
 *
 * Trophies decide how strong an opponent is, measured in Elder Toadstool
 * levels ("strength"): hall h covers strength [h-1, h), and the fraction says
 * how close its buildings are to that hall's caps. Climbing therefore brings
 * tougher bases with more loot, and an opponent's trophies follow its
 * strength. When a player's trophies run ahead of what their own hall may be
 * matched against, their opponents carry fewer trophies than they do, so wins
 * pay less and losses cost more: trophies settle where the player wins about
 * as often as the trophy formula demands instead of climbing forever.
 */
import { generateOpponent } from './battle/basegen';
import type { BaseLayout } from './battle/types';
import { barracksLevel, housingCapacity, maxHousingAtHall } from './army';
import { troopDef } from './data';
import { troopLevelCapAt, troopLevelOf } from './research';
import { armyStrength } from './strength';
import { createRng, mixSeed, next, type Rng } from './rng';
import type { GameData, ResourceKind, VillageState } from './types';
import { hallLevel } from './village';

export interface MatchStrength {
  /** Elder Toadstool level of the opponent. */
  hall: number;
  /** 0..1 inside that hall level (0 = just arrived, 1 = maxed). */
  bias: number;
  trophies: number;
}

export function maxHall(data: GameData): number {
  return data.hall.levels.length;
}

/** Strength in hall units for a trophy count. */
export function strengthFor(trophies: number, data: GameData): number {
  return Math.max(0, trophies) / data.ranks.matchmaking.trophiesPerHall;
}

/**
 * Strength of a matched opponent: near the player's trophies, but never more
 * than `hallsBelow` / `hallsAbove` Elder Toadstool levels away from the
 * player's own hall. Pass `mirror` for attackers matched against a defender.
 */
export function matchStrength(rng: Rng, trophies: number, ownHall: number, data: GameData, mirror = false, floor?: number): MatchStrength {
  const mm = data.ranks.matchmaking;
  const top = maxHall(data);
  // Raiders come from at most one level below or above the defender.
  const below = mirror ? mm.hallsAbove : mm.hallsBelow;
  const above = mirror ? 1 : mm.hallsAbove;
  const lo = Math.max(0, ownHall - below - 1);
  const hi = Math.min(top, ownHall + above) - 1e-6;
  const jitter = (next(rng) * 2 - 1) * mm.strengthJitter;
  let s = strengthFor(trophies, data);
  if (floor !== undefined) {
    // Readiness floor: never weaker than the player's development calls for;
    // the random variety only goes up from there.
    s = Math.max(Math.max(lo, floor), Math.min(hi, Math.max(s, floor) + jitter));
  } else {
    s = Math.max(lo, Math.min(hi, s + jitter));
  }
  const whole = Math.floor(s);
  const t = Math.round(s * mm.trophiesPerHall + (next(rng) * 2 - 1) * mm.trophyJitter);
  return { hall: whole + 1, bias: s - whole, trophies: Math.max(0, t) };
}

/** Loot multiplier for an attacker at `attackerHall` hitting a base at `targetHall`. */
export function lootPenalty(attackerHall: number, targetHall: number, data: GameData): number {
  const diff = attackerHall - targetHall;
  if (diff <= 0) return 1;
  const table = data.ranks.lootPenaltyByHallDiff;
  return table[Math.min(diff, table.length - 1)];
}

/** Scale the loot in a base for the attacker's hall level. Mutates. */
export function applyLootPenalty(base: BaseLayout, attackerHall: number, data: GameData): BaseLayout {
  const m = lootPenalty(attackerHall, base.hallLevel, data);
  if (m >= 1) return base;
  for (const b of base.buildings) {
    if (!b.loot) continue;
    for (const k of Object.keys(b.loot) as ResourceKind[]) b.loot[k] = Math.floor((b.loot[k] ?? 0) * m);
  }
  return base;
}

/** Strength of the typical army at a hall level: full Army Camps, research one level under the cap. */
export function typicalArmyStrength(hall: number, data: GameData): number {
  const lvl = Math.max(1, troopLevelCapAt(hall, data) - 1);
  const ref = botArmy(hall, 1, data);
  return armyStrength(ref, Object.fromEntries(Object.keys(ref).map((t) => [t, lvl])), data);
}

/** Strength of the army the player can field: their Army Camps filled with their hall's mix at their research levels. */
export function playerArmyStrength(state: VillageState, data: GameData): number {
  const hall = hallLevel(state, data);
  const housing = housingCapacity(state, data);
  if (!housing) return 0;
  const bl = barracksLevel(state, data);
  const mixes = data.raids.botArmyMix;
  const mix = Object.fromEntries(Object.entries(mixes[Math.min(mixes.length, hall) - 1]).filter(([t]) => (data.troops[t]?.barracksLevel ?? 99) <= bl));
  if (!Object.keys(mix).length) return 0;
  const army = fillArmy(mix, housing, data);
  return armyStrength(army, Object.fromEntries(Object.keys(army).map((t) => [t, troopLevelOf(state, t)])), data);
}

/**
 * Which level the player's army matches, in strength units: 2.5 means
 * halfway between the typical level 2 and level 3 armies.
 */
export function powerStrength(state: VillageState, data: GameData): number {
  const p = playerArmyStrength(state, data);
  const top = maxHall(data);
  let prev = 0;
  for (let h = 1; h <= top; h++) {
    const r = typicalArmyStrength(h, data);
    if (p < r) return h - 1 + (p - prev) / Math.max(1, r - prev);
    prev = r;
  }
  return top;
}

/** 0..1: how close the player's army is to the typical army of their own level. */
export function readiness(state: VillageState, data: GameData): number {
  const hall = hallLevel(state, data);
  const s = powerStrength(state, data);
  return Math.max(0, Math.min(1, s - (hall - 1)));
}

/**
 * Lowest opponent strength: the level the player's army matches (but no more
 * than `hallsBelow` levels under their own, and never above their own).
 * Weak armies meet weaker bases with less loot; trophies push opponents up
 * from there.
 */
export function strengthFloor(state: VillageState, data: GameData): number | undefined {
  const mm = data.ranks.matchmaking;
  if (!mm.readinessFloor) return undefined;
  const own = hallLevel(state, data);
  return Math.max(Math.max(0, own - 1 - mm.hallsBelow), Math.min(own - 1, powerStrength(state, data) - 1));
}

/** The generated opponent behind a scout seed, for this player. */
export function opponentFor(seed: number, state: VillageState, data: GameData): BaseLayout {
  return opponentForRank(seed, state.trophies, hallLevel(state, data), data, strengthFloor(state, data));
}

/**
 * The same generated opponent from just a rank and hall level (plus the
 * army-strength floor when the caller knows it). The server uses this when no
 * real player fits, so online and offline matchmaking agree.
 */
export function opponentForRank(seed: number, trophies: number, ownHall: number, data: GameData, floor?: number): BaseLayout {
  const st = matchStrength(createRng(mixSeed(seed, 0x5c0a7)), trophies, ownHall, data, false, floor);
  const base = generateOpponent(seed, st.hall, data, { levelBias: st.bias });
  base.trophies = st.trophies;
  return applyLootPenalty(base, ownHall, data);
}

/** The Elder Toadstool levels a player at `ownHall` may be matched against. */
export function hallWindow(ownHall: number, data: GameData): { min: number; max: number } {
  const mm = data.ranks.matchmaking;
  // hallsBelow can be fractional (strength units): a half level below still reaches that hall.
  return { min: Math.max(1, ownHall - Math.ceil(mm.hallsBelow)), max: Math.min(maxHall(data), ownHall + mm.hallsAbove) };
}

export interface BotAttacker {
  hall: number;
  trophies: number;
  army: Record<string, number>;
  levels: Record<string, number>;
}

/** A full army for a bot at a hall level, made from that hall's mix in raids.json. */
export function botArmy(hall: number, bias: number, data: GameData): Record<string, number> {
  const mixes = data.raids.botArmyMix;
  const mix = mixes[Math.max(1, Math.min(mixes.length, hall)) - 1];
  return fillArmy(mix, Math.floor(maxHousingAtHall(hall, data) * (0.85 + 0.15 * bias)), data);
}

/** Fill `housing` with troops in the given housing shares; rounding leftovers go to the smallest troop. */
export function fillArmy(mix: Record<string, number>, housing: number, data: GameData): Record<string, number> {
  const army: Record<string, number> = {};
  let used = 0;
  for (const [troop, share] of Object.entries(mix)) {
    const h = troopDef(data, troop).housing;
    const n = Math.floor((housing * share) / h);
    if (n > 0) {
      army[troop] = n;
      used += n * h;
    }
  }
  // Fill what rounding left over with the cheapest troop of the mix.
  const filler = Object.keys(mix).sort((a, b) => troopDef(data, a).housing - troopDef(data, b).housing)[0];
  if (filler) {
    const h = troopDef(data, filler).housing;
    const extra = Math.floor((housing - used) / h);
    if (extra > 0) army[filler] = (army[filler] ?? 0) + extra;
  }
  return army;
}

/** The bot that raids a village: matched by the defender's trophies, with a full army for its hall. */
export function attackerFor(rng: Rng, state: VillageState, data: GameData): BotAttacker {
  const st = matchStrength(rng, state.trophies, hallLevel(state, data), data, true);
  const cap = troopLevelCapAt(st.hall, data);
  const lvl = Math.max(1, cap - (st.bias < 0.5 ? 1 : 0));
  const army = botArmy(st.hall, st.bias, data);
  const levels: Record<string, number> = {};
  for (const t of Object.keys(army)) levels[t] = Math.min(lvl, troopDef(data, t).levels.length);
  return { hall: st.hall, trophies: st.trophies, army, levels };
}
