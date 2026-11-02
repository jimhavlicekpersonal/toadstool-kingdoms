/**
 * Online bookkeeping in the village save: what the server has already given
 * this village, so a retry or a lost acknowledgement never applies anything
 * twice. Pure functions; the connection manager turns server answers into
 * commands that call these.
 */
import { scaleReward } from './economy';
import { addCapped, capacity } from './resources';
import { addReinforcements } from './social/grove';
import type { Cost, GameData, NetState, ResourceKind, VillageState } from './types';

/** How many applied donation ids to remember (older ones are long acknowledged). */
const MAX_DONATION_IDS = 300;
const MAX_RAID_WEEKS = 20;

export function emptyNet(): NetState {
  return { playerId: null, defensesSince: 0, donations: [], raidWeeks: [] };
}

/** Start fresh bookkeeping when this village is played by a different server account. Mutates. */
export function bindPlayer(state: VillageState, playerId: string): void {
  if (state.net.playerId === playerId) return;
  state.net = { ...emptyNet(), playerId };
}

export interface ServerDonation {
  id: string;
  troop: string;
  count: number;
  fromName: string;
}

/**
 * Troops friends sent through the server go into the Grove Lodge, up to its
 * free space (the rest is lost, like a full Lodge offline). Returns the troops
 * added. Mutates.
 */
export function receiveDonations(state: VillageState, items: ServerDonation[], data: GameData): { troop: string; count: number; fromName: string }[] {
  const added: { troop: string; count: number; fromName: string }[] = [];
  for (const d of items) {
    if (state.net.donations.includes(d.id)) continue;
    state.net.donations.push(d.id);
    const def = data.troops[d.troop];
    if (!def || !(d.count > 0)) continue;
    const housing = addReinforcements(state, d.troop, def.housing * Math.floor(d.count), data);
    if (housing > 0) added.push({ troop: d.troop, count: housing / def.housing, fromName: d.fromName });
  }
  if (state.net.donations.length > MAX_DONATION_IDS) state.net.donations.splice(0, state.net.donations.length - MAX_DONATION_IDS);
  return added;
}

/** The player donated troops to a real friend: they leave the army and earn Grove XP. Mutates. */
export function spendDonation(state: VillageState, troop: string, count: number, xp: number): boolean {
  if (!(count > 0) || (state.army[troop] ?? 0) < count) return false;
  state.army[troop] -= count;
  if (state.army[troop] === 0) delete state.army[troop];
  state.grove.xp += Math.max(0, Math.floor(xp));
  state.stats.donations += count;
  return true;
}

/**
 * Collect a server Grove Raid chest (same contents as the offline Grove Raid,
 * scaled to the hall level). Once per week. Mutates; returns the chest or null.
 */
export function claimRaidChest(state: VillageState, week: number, outcome: 'win' | 'draw' | 'loss', score: { ours: number; theirs: number }, hall: number, data: GameData): Cost | null {
  if (state.net.raidWeeks.includes(week)) return null;
  state.net.raidWeeks.push(week);
  if (state.net.raidWeeks.length > MAX_RAID_WEEKS) state.net.raidWeeks.shift();
  const { xp, ...base } = data.social.groveRaid.rewards[outcome];
  const chest = scaleReward(base, hall, data);
  const soft: Cost = {};
  for (const [k, v] of Object.entries(chest) as [ResourceKind, number][]) {
    if (k === 'moonstones') state.resources.moonstones += v;
    else soft[k] = v;
  }
  addCapped(state.resources, soft, capacity(state, data));
  state.grove.xp += xp;
  state.grove.raidHistory.push({ week, ours: score.ours, theirs: score.theirs, outcome, reward: { ...chest } });
  while (state.grove.raidHistory.length > 8) state.grove.raidHistory.shift();
  return chest;
}
