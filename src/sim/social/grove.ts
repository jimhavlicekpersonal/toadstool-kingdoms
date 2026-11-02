/**
 * The player's Grove: bot members with names, schedules and chat, troop
 * requests and donations. All bot activity is generated from the grove seed
 * and the clock, so it is the same every time the save is loaded.
 */
import { barracksLevel } from '../army';
import { levelDef } from '../data';
import { createRng, int, mixSeed, next, pick } from '../rng';
import type { BotRequest, ChatMessage, GameData, GroveState, VillageState } from '../types';

const MIN = 60_000;
const HOUR = 3_600_000;

export interface Member {
  name: string;
  role: 'Leader' | 'Elder' | 'Member';
  /** Hours of the day (UTC) this member tends to be online. */
  onlineFrom: number;
  onlineHours: number;
  /** Offset from the player's Elder Toadstool level. */
  hallOffset: number;
  trophyOffset: number;
}

export interface Grove {
  name: string;
  color: string;
  members: Member[];
}

export function emptyGrove(): GroveState {
  return { joined: false, seed: 0, joinedAt: 0, xp: 0, chat: [], processedAt: 0, requests: [], myRequest: null, reinforcements: {}, raid: null, raidHistory: [], prepOfferWeek: -1, settledWeek: -1 };
}

export function groveSeedFor(villageSeed: number): number {
  return mixSeed(villageSeed, 0x6007e);
}

export function generateGrove(seed: number, data: GameData): Grove {
  const rng = createRng(seed);
  const so = data.social;
  const count = int(rng, so.membersMin, so.membersMax);
  const used = new Set<string>();
  const members: Member[] = [];
  for (let i = 0; i < count; i++) {
    let name = '';
    for (let tries = 0; tries < 20; tries++) {
      name = `${pick(rng, data.names.playerFirst)} ${pick(rng, data.names.playerSecond)}`;
      if (!used.has(name)) break;
    }
    used.add(name);
    members.push({
      name,
      role: i === 0 ? 'Leader' : i < 3 ? 'Elder' : 'Member',
      onlineFrom: int(rng, 0, 23),
      onlineHours: int(rng, 3, 10),
      hallOffset: int(rng, -1, 1),
      trophyOffset: int(rng, -150, 150),
    });
  }
  return { name: `${pick(rng, so.groveNames.first)} ${pick(rng, so.groveNames.second)}`, color: pick(rng, so.colors), members };
}

export function isOnline(m: Member, t: number): boolean {
  const hour = new Date(t).getUTCHours();
  const end = m.onlineFrom + m.onlineHours;
  return end <= 24 ? hour >= m.onlineFrom && hour < end : hour >= m.onlineFrom || hour < end - 24;
}

export function groveLevel(xp: number, data: GameData): number {
  const levels = data.social.xpLevels;
  let lvl = 1;
  for (let i = 0; i < levels.length; i++) if (xp >= levels[i]) lvl = i + 1;
  return lvl;
}

/** Replace blocked words with flowers. Chat is always filtered. */
export function filterText(text: string, data: GameData): string {
  let out = text.slice(0, 160);
  for (const word of data.social.profanity) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}\\b`, 'gi');
    out = out.replace(re, (m) => '✿'.repeat(Math.min(5, m.length)));
  }
  return out;
}

/** Reinforcement capacity from the Grove Lodge (0 if not built). */
export function reinforcementCapacity(state: VillageState, data: GameData): number {
  let cap = 0;
  for (const b of state.buildings) if (b.level >= 1) cap += levelDef(data, b.type, b.level)?.reinforcement ?? 0;
  return cap;
}

export function reinforcementHousing(state: VillageState, data: GameData): number {
  return Object.entries(state.grove.reinforcements).reduce((s, [t, n]) => s + (data.troops[t]?.housing ?? 0) * n, 0);
}

function pushChat(g: GroveState, msg: ChatMessage, data: GameData): void {
  g.chat.push(msg);
  if (g.chat.length > data.social.maxChat) g.chat.splice(0, g.chat.length - data.social.maxChat);
}

/** Troops a member can donate: ones the player's Burrow Barracks has unlocked. */
function giftTroop(rng: ReturnType<typeof createRng>, state: VillageState, data: GameData): string {
  const bl = barracksLevel(state, data);
  const ok = data.social.requestTroops.filter((t) => (data.troops[t]?.barracksLevel ?? Infinity) <= bl);
  return ok.length ? pick(rng, ok) : data.social.requestTroops[0];
}

/** Add donated troops to the player's reinforcements, up to Lodge capacity. Returns housing added. */
export function addReinforcements(state: VillageState, troop: string, housing: number, data: GameData): number {
  const def = data.troops[troop];
  if (!def) return 0;
  const room = reinforcementCapacity(state, data) - reinforcementHousing(state, data);
  const n = Math.floor(Math.min(room, housing) / def.housing);
  if (n <= 0) return 0;
  state.grove.reinforcements[troop] = (state.grove.reinforcements[troop] ?? 0) + n;
  return n * def.housing;
}

/**
 * Generate bot activity (chat, requests, donations to the player) from
 * `processedAt` up to `now`. Mutates.
 */
export function advanceGrove(state: VillageState, now: number, data: GameData): void {
  const g = state.grove;
  if (!g.joined || now <= g.processedAt) return;
  const so = data.social;
  const grove = generateGrove(g.seed, data);
  const slot = so.chatSlotMinutes * MIN;
  // Long absences only replay the most recent day of chatter.
  const from = Math.max(g.processedAt, now - 24 * HOUR);
  const s0 = Math.floor(from / slot) + 1;
  const s1 = Math.floor(now / slot);
  for (let si = s0; si <= s1; si++) {
    const t = si * slot;
    const rng = createRng(mixSeed(g.seed, si));
    grove.members.forEach((m, mi) => {
      if (!isOnline(m, t)) return;
      const roll = next(rng);
      if (roll < so.chatChancePerSlot) {
        pushChat(g, { at: t + mi * 1000, from: mi, text: pick(rng, so.chatLines.random), kind: 'chat' }, data);
      } else if (roll < so.chatChancePerSlot + so.requestChancePerSlot && !g.requests.some((r) => r.member === mi)) {
        const req: BotRequest = { id: `q${si}-${mi}`, at: t + mi * 1000, member: mi, troop: pick(rng, so.requestTroops), size: pick(rng, so.requestSizes), donated: 0 };
        g.requests.push(req);
        pushChat(g, { at: req.at, from: mi, text: `Could use ${req.size} housing of troops, please!`, kind: 'request' }, data);
      }
    });
  }
  // Grove Raid start and end announcements.
  const epoch = so.groveRaid.epoch;
  const WEEK = 7 * 86_400_000;
  for (let w = Math.floor((from - epoch) / WEEK) - 1; w <= Math.floor((now - epoch) / WEEK); w++) {
    const start = epoch + w * WEEK;
    const end = start + so.groveRaid.durationHours * HOUR;
    const rng = createRng(mixSeed(g.seed, 0x4a1d + w));
    if (start > from && start <= now) pushChat(g, { at: start, from: 0, text: pick(rng, so.chatLines.raidStart), kind: 'system' }, data);
    if (end > from && end <= now) pushChat(g, { at: end, from: 0, text: pick(rng, so.chatLines.raidEnd), kind: 'system' }, data);
  }
  g.chat.sort((a, b) => a.at - b.at);
  // Requests expire or fill up.
  g.requests = g.requests.filter((r) => r.donated < r.size && now - r.at < so.requestLifetimeHours * HOUR);
  // Friends fill the player's own request in chunks.
  if (g.myRequest) {
    const chunk = so.reinforcementChunkMinutes * MIN;
    while (g.myRequest && g.myRequest.at + (g.myRequest.chunks + 1) * chunk <= now) {
      const k = g.myRequest.chunks + 1;
      const t = g.myRequest.at + k * chunk;
      const rng = createRng(mixSeed(g.seed, Math.floor(g.myRequest.at / 1000) + k));
      const online = grove.members.map((m, i) => ({ m, i })).filter(({ m }) => isOnline(m, t));
      const giver = online.length ? pick(rng, online).i : int(rng, 0, grove.members.length - 1);
      const added = addReinforcements(state, giftTroop(rng, state, data), so.reinforcementChunkHousing, data);
      g.myRequest.chunks = k;
      if (added > 0) pushChat(g, { at: t, from: giver, text: pick(rng, so.chatLines.donated), kind: 'donation' }, data);
      if (added <= 0 || k >= 6) g.myRequest = null;
    }
  }
  g.processedAt = now;
}

export function joinGrove(state: VillageState, now: number, data: GameData): void {
  const g = state.grove;
  g.joined = true;
  g.seed = groveSeedFor(state.seed);
  g.joinedAt = now;
  g.processedAt = now;
  // Raids that already ended before joining are not ours to settle.
  const epoch = data.social.groveRaid.epoch;
  const week = Math.floor((now - epoch) / (7 * 86_400_000));
  const end = epoch + week * 7 * 86_400_000 + data.social.groveRaid.durationHours * 3_600_000;
  g.settledWeek = now >= end ? week : week - 1;
  const grove = generateGrove(g.seed, data);
  const rng = createRng(mixSeed(g.seed, 1));
  pushChat(g, { at: now, from: -2, text: `You joined ${grove.name}!`, kind: 'system' }, data);
  for (let i = 0; i < 2; i++) pushChat(g, { at: now + (i + 1) * 4000, from: int(rng, 0, grove.members.length - 1), text: pick(rng, data.social.chatLines.greet), kind: 'chat' }, data);
}

/** Player sends a chat message; it is filtered, and a friend may reply. */
export function sendChat(state: VillageState, text: string, now: number, data: GameData): string {
  const g = state.grove;
  const clean = filterText(text.trim(), data);
  pushChat(g, { at: now, from: -1, text: clean, kind: 'chat' }, data);
  const grove = generateGrove(g.seed, data);
  let h = 0;
  for (let i = 0; i < clean.length; i++) h = (Math.imul(h, 31) + clean.charCodeAt(i)) >>> 0;
  const rng = createRng(mixSeed(g.seed, h ^ Math.floor(now / 1000)));
  if (next(rng) < 0.7) {
    const online = grove.members.map((m, i) => ({ m, i })).filter(({ m }) => isOnline(m, now));
    const who = online.length ? pick(rng, online).i : int(rng, 0, grove.members.length - 1);
    pushChat(g, { at: now + 3000, from: who, text: pick(rng, data.social.chatLines.reply), kind: 'chat' }, data);
  }
  return clean;
}

/**
 * Donate troops from the army to a bot request. Gives XP, and the grove
 * returns the favour by filling the player's reinforcement slot.
 */
export function donate(state: VillageState, requestId: string, troop: string, count: number, now: number, data: GameData): { ok: true; xp: number } | { ok: false; message: string } {
  const g = state.grove;
  const req = g.requests.find((r) => r.id === requestId);
  const def = data.troops[troop];
  if (!req || !def) return { ok: false, message: 'That request is gone.' };
  if ((state.army[troop] ?? 0) < count || count <= 0) return { ok: false, message: 'Not enough of that troop.' };
  const room = req.size - req.donated;
  const n = Math.min(count, Math.floor(room / def.housing));
  if (n <= 0) return { ok: false, message: 'That request is full.' };
  state.army[troop] -= n;
  if (state.army[troop] === 0) delete state.army[troop];
  req.donated += n * def.housing;
  const xp = n * def.housing * data.social.xpPerHousing;
  g.xp += xp;
  state.stats.donations += n;
  const rng = createRng(mixSeed(g.seed, Math.floor(now / 1000) ^ req.member));
  pushChat(g, { at: now, from: req.member, text: pick(rng, data.social.chatLines.thanks), kind: 'chat' }, data);
  // Donating costs the troops and earns Grove XP only. Your own reinforcements
  // come from your own requests, so donating can't be used to swap cheap
  // troops for expensive ones.
  if (req.donated >= req.size) g.requests = g.requests.filter((r) => r.id !== requestId);
  return { ok: true, xp };
}

export function canRequest(state: VillageState, now: number, data: GameData): { ok: boolean; message: string; readyAt?: number } {
  const g = state.grove;
  if (!g.joined) return { ok: false, message: 'Join a Grove first.' };
  if (reinforcementCapacity(state, data) <= 0) return { ok: false, message: 'Build a Grove Lodge to receive troops.' };
  if (reinforcementHousing(state, data) >= reinforcementCapacity(state, data)) return { ok: false, message: 'Your Grove Lodge is full.' };
  const last = g.myRequest?.at ?? -Infinity;
  const lastAny = g.chat.filter((c) => c.from === -1 && c.kind === 'request').map((c) => c.at).pop() ?? -Infinity;
  const readyAt = Math.max(last, lastAny) + data.social.requestCooldownMinutes * MIN;
  if (now < readyAt) return { ok: false, message: 'You can ask again soon.', readyAt };
  return { ok: true, message: '' };
}

export function requestTroops(state: VillageState, now: number, data: GameData): void {
  state.grove.myRequest = { at: now, chunks: 0 };
  pushChat(state.grove, { at: now, from: -1, text: 'Could anyone spare some troops?', kind: 'request' }, data);
}
