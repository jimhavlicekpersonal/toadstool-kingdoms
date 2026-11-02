/** Real Groves: membership, filtered chat, troop requests and donations. */
import { filterText } from '../../src/sim/social/grove';
import { troopLevelCapAt } from '../../src/sim/research';
import type { ChatResponse, ChatView, DonateRequest, DonateResponse, GroveSummary, GroveView, GrovesResponse, InboxResponse, MemberView, RequestView, RequestsResponse } from '../../src/net/protocol';
import type { ChatRow, Grove, Player, TroopRequest } from '../repo';
import { ApiError, HOUR, MIN, type ServerContext } from './context';
import { cleanName } from './identity';
import { maxReinforcementAt } from './pvp';


export function maxMembers(ctx: ServerContext): number {
  return ctx.data.social.membersMax;
}

/** Largest Grove Lodge a player at this hall level can have. */
export function maxReinforcement(hall: number, ctx: ServerContext): number {
  return maxReinforcementAt(hall, ctx.data);
}

async function requireGrove(ctx: ServerContext, me: Player): Promise<{ grove: Grove; role: MemberView['role']; xp: number; joinedAt: number }> {
  const m = await ctx.repo.getMembership(me.id);
  const grove = m ? await ctx.repo.getGrove(m.groveId) : null;
  if (!m || !grove) throw new ApiError(404, 'not_in_grove', 'You are not in a Grove.');
  return { grove, role: m.role, xp: m.xp, joinedAt: m.joinedAt };
}

export { requireGrove };

function chatView(c: ChatRow): ChatView {
  return { id: c.id, at: c.at, from: c.playerId ? { id: c.playerId, name: c.name ?? 'Friend' } : null, text: c.text, kind: c.kind };
}

async function system(ctx: ServerContext, groveId: string, text: string): Promise<void> {
  await ctx.repo.addChat({ id: ctx.uuid(), groveId, at: ctx.now(), playerId: null, name: null, text, kind: 'system' });
}

export async function groveView(ctx: ServerContext, me: Player, grove: Grove): Promise<GroveView> {
  const rows = await ctx.repo.members(grove.id);
  const members: MemberView[] = [];
  for (const r of rows) {
    const p = await ctx.repo.getPlayer(r.playerId);
    if (!p) continue;
    members.push({ id: p.id, name: p.name, role: r.role, trophies: p.trophies, hallLevel: p.hallLevel, lastSeenAt: p.lastSeenAt, xp: r.xp });
  }
  members.sort((a, b) => b.trophies - a.trophies);
  const mine = rows.find((r) => r.playerId === me.id);
  return { id: grove.id, name: grove.name, color: grove.color, maxMembers: maxMembers(ctx), members, you: { id: me.id, role: mine?.role ?? 'Member', xp: mine?.xp ?? 0 } };
}

export async function listGroves(ctx: ServerContext, me: Player, query: string): Promise<GrovesResponse> {
  const rows = await ctx.repo.listGroves(String(query ?? ''), 200);
  const max = maxMembers(ctx);
  const groves: GroveSummary[] = rows
    .filter((g) => g.members < max)
    .sort((a, b) => Math.abs(a.averageTrophies - me.trophies) - Math.abs(b.averageTrophies - me.trophies) || b.lastActiveAt - a.lastActiveAt)
    .slice(0, 30)
    .map((g) => ({ id: g.id, name: g.name, color: g.color, members: g.members, maxMembers: max, averageTrophies: g.averageTrophies }));
  return { groves };
}

export async function createGrove(ctx: ServerContext, me: Player, name: unknown): Promise<GroveView> {
  if (await ctx.repo.getMembership(me.id)) throw new ApiError(409, 'already_in_grove', 'Leave your Grove first.');
  const clean = cleanName(name, ctx);
  const colors = ctx.data.social.colors;
  const grove: Grove = { id: ctx.uuid(), name: clean, color: colors[Math.floor(ctx.random() * colors.length)], createdAt: ctx.now() };
  await ctx.repo.createGrove(grove);
  if (!(await ctx.repo.addMember({ groveId: grove.id, playerId: me.id, role: 'Leader', joinedAt: ctx.now(), xp: 0 }))) throw new ApiError(409, 'already_in_grove', 'Leave your Grove first.');
  await ctx.repo.updatePlayer(me.id, { groveId: grove.id });
  await system(ctx, grove.id, `${me.name} founded ${grove.name}!`);
  return groveView(ctx, { ...me, groveId: grove.id }, grove);
}

export async function joinGrove(ctx: ServerContext, me: Player, id: string): Promise<GroveView> {
  if (await ctx.repo.getMembership(me.id)) throw new ApiError(409, 'already_in_grove', 'Leave your Grove first.');
  const grove = await ctx.repo.getGrove(String(id));
  if (!grove) throw new ApiError(404, 'not_found', 'That Grove does not exist.');
  const rows = await ctx.repo.members(grove.id);
  if (!rows.length) throw new ApiError(404, 'not_found', 'That Grove is empty.');
  if (rows.length >= maxMembers(ctx)) throw new ApiError(409, 'full', 'That Grove is full.');
  if (!(await ctx.repo.addMember({ groveId: grove.id, playerId: me.id, role: 'Member', joinedAt: ctx.now(), xp: 0 }))) throw new ApiError(409, 'already_in_grove', 'Leave your Grove first.');
  await ctx.repo.updatePlayer(me.id, { groveId: grove.id });
  await system(ctx, grove.id, `${me.name} joined the Grove. Say hello!`);
  return groveView(ctx, { ...me, groveId: grove.id }, grove);
}

export async function leaveGrove(ctx: ServerContext, me: Player): Promise<void> {
  const { grove, role } = await requireGrove(ctx, me);
  await ctx.repo.removeMember(grove.id, me.id);
  await ctx.repo.updatePlayer(me.id, { groveId: null });
  await ctx.repo.closeRequestsOf(me.id);
  await system(ctx, grove.id, `${me.name} left the Grove.`);
  if (role === 'Leader') {
    // Hand leadership to the longest-serving member.
    const rest = (await ctx.repo.members(grove.id)).sort((a, b) => (a.role === 'Elder' ? 0 : 1) - (b.role === 'Elder' ? 0 : 1) || a.joinedAt - b.joinedAt);
    if (rest[0]) {
      await ctx.repo.updateMember(grove.id, rest[0].playerId, { role: 'Leader' });
      const p = await ctx.repo.getPlayer(rest[0].playerId);
      if (p) await system(ctx, grove.id, `${p.name} is the new leader.`);
    }
  }
}

/** The player's Grove, or null when they are not in one. */
export async function myGrove(ctx: ServerContext, me: Player): Promise<GroveView | null> {
  const m = await ctx.repo.getMembership(me.id);
  const grove = m ? await ctx.repo.getGrove(m.groveId) : null;
  return grove ? groveView(ctx, me, grove) : null;
}

export async function chat(ctx: ServerContext, me: Player, after: string | undefined): Promise<ChatResponse> {
  const { grove } = await requireGrove(ctx, me);
  const afterSeq = Number(after ?? 0) || 0;
  const rows = await ctx.repo.chatAfter(grove.id, afterSeq, 100);
  const cursor = rows.length ? String(rows[rows.length - 1].seq) : String(afterSeq);
  return { messages: rows.map(chatView), cursor };
}

export async function postChat(ctx: ServerContext, me: Player, text: unknown): Promise<ChatView> {
  const { grove } = await requireGrove(ctx, me);
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) throw new ApiError(400, 'bad_request', 'Type a message first.');
  if ((await ctx.repo.recentChatCount(me.id, ctx.now() - MIN)) >= ctx.data.social.chatPerMinute) throw new ApiError(429, 'cooldown', 'Slow down a little!');
  // Chat is always filtered (also for players who are not under 18).
  const row = await ctx.repo.addChat({ id: ctx.uuid(), groveId: grove.id, at: ctx.now(), playerId: me.id, name: me.name, text: filterText(raw, ctx.data), kind: 'chat' });
  return chatView(row);
}

function requestView(r: TroopRequest, me: Player): RequestView {
  return { id: r.id, at: r.at, playerId: r.playerId, name: r.name, size: r.size, filled: r.filled, mine: r.playerId === me.id };
}

export async function requests(ctx: ServerContext, me: Player): Promise<RequestsResponse> {
  const { grove } = await requireGrove(ctx, me);
  const list = await ctx.repo.openRequests(grove.id, ctx.now() - ctx.data.social.requestLifetimeHours * HOUR);
  const last = await ctx.repo.lastRequestAt(me.id);
  const next = last ? last + ctx.data.social.requestCooldownMinutes * MIN : 0;
  return { requests: list.map((r) => requestView(r, me)), nextRequestAt: next > ctx.now() ? next : 0 };
}

export async function requestTroops(ctx: ServerContext, me: Player, capacity: unknown): Promise<RequestView> {
  const { grove } = await requireGrove(ctx, me);
  const t = ctx.now();
  const last = await ctx.repo.lastRequestAt(me.id);
  if (last && t < last + ctx.data.social.requestCooldownMinutes * MIN) throw new ApiError(429, 'cooldown', 'You can ask again soon.');
  const size = Math.min(Math.floor(Number(capacity) || 0), maxReinforcement(me.hallLevel, ctx));
  if (size <= 0) throw new ApiError(400, 'bad_request', 'Build a Grove Lodge with free space first.');
  await ctx.repo.closeRequestsOf(me.id);
  const r: TroopRequest = { id: ctx.uuid(), groveId: grove.id, playerId: me.id, name: me.name, at: t, size, filled: 0, open: true };
  await ctx.repo.addRequest(r);
  await ctx.repo.addChat({ id: ctx.uuid(), groveId: grove.id, at: t, playerId: me.id, name: me.name, text: `Could anyone spare ${size} housing of troops?`, kind: 'request' });
  return requestView(r, me);
}

export async function donate(ctx: ServerContext, me: Player, requestId: string, req: DonateRequest): Promise<DonateResponse> {
  const { grove } = await requireGrove(ctx, me);
  const r = await ctx.repo.getRequest(String(requestId));
  if (!r || r.groveId !== grove.id || !r.open || ctx.now() - r.at > ctx.data.social.requestLifetimeHours * HOUR) throw new ApiError(404, 'not_found', 'That request is gone.');
  if (r.playerId === me.id) throw new ApiError(400, 'bad_request', 'You cannot fill your own request.');
  const def = ctx.data.troops[req?.troop];
  const count = Math.floor(Number(req?.count) || 0);
  const level = Math.floor(Number(req?.level) || 1);
  if (!def || count <= 0) throw new ApiError(400, 'bad_request', 'Pick a troop to donate.');
  if (level < 1 || level > Math.min(troopLevelCapAt(me.hallLevel, ctx.data), def.levels.length)) throw new ApiError(400, 'bad_request', 'bad troop level');
  const housing = def.housing * count;
  const updated = await ctx.repo.fillRequest(r.id, housing);
  if (!updated) throw new ApiError(409, 'full', 'That request does not have room for those troops.');
  const xp = housing * ctx.data.social.xpPerHousing;
  const mine = await ctx.repo.getMembership(me.id);
  await ctx.repo.updateMember(grove.id, me.id, { xp: (mine?.xp ?? 0) + xp });
  await ctx.repo.addDonation({ id: ctx.uuid(), requestId: r.id, groveId: grove.id, fromId: me.id, fromName: me.name, toId: r.playerId, troop: req.troop, count, level, at: ctx.now(), delivered: false });
  await ctx.repo.addChat({ id: ctx.uuid(), groveId: grove.id, at: ctx.now(), playerId: me.id, name: me.name, text: `Sent ${count} ${def.name}${count > 1 ? 's' : ''} to ${r.name}.`, kind: 'donation' });
  return { request: requestView(updated, me), xp };
}

export async function inbox(ctx: ServerContext, me: Player): Promise<InboxResponse> {
  const list = await ctx.repo.undelivered(me.id);
  return { donations: list.map((d) => ({ id: d.id, at: d.at, fromName: d.fromName, troop: d.troop, count: d.count, level: d.level })) };
}

export async function ackInbox(ctx: ServerContext, me: Player, ids: unknown): Promise<void> {
  if (!Array.isArray(ids)) throw new ApiError(400, 'bad_request', 'ids must be a list');
  await ctx.repo.markDelivered(me.id, ids.map(String).slice(0, 200));
}
