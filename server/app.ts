/**
 * HTTP adapter: puts the server core (server/core/) behind the protocol in
 * src/net/protocol.ts. All rules live in the core; this file only reads
 * requests, checks the bearer token and turns errors into protocol errors.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Routes, type ErrorBody, type MyGroveResponse } from '../src/net/protocol';
import type { GameData } from '../src/sim/types';
import { ApiError, createCore, type ServerCore } from './core';
import { nodeContext } from './nodeContext';
import type { Player, Repo } from './repo';

export { maxHousing, validateBase, validLevels } from './core/pvp';
export { nodeContext } from './nodeContext';

export interface ServerOptions {
  repo: Repo;
  data: GameData;
  now?: () => number;
  corsOrigin?: string;
  logger?: boolean;
  /** Override for tests (deterministic opponent picks). */
  random?: () => number;
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : undefined;
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const core: ServerCore = createCore(nodeContext(opts.repo, opts.data, opts.now, opts.random));
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000 });

  // CORS without an extra dependency. corsOrigin: '*' (default; fine because
  // auth is a bearer token, not a cookie) or a comma-separated list of origins.
  const allowed = (opts.corsOrigin ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (allowed.includes('*')) reply.header('Access-Control-Allow-Origin', '*');
    else if (origin && allowed.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    }
    reply.header('Access-Control-Allow-Headers', 'authorization, content-type');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      const body: ErrorBody = { error: err.code, message: err.message };
      return reply.code(err.status).send(body);
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    // Malformed JSON, oversized bodies and the like; details only for client errors.
    const body: ErrorBody = { error: 'bad_request', message: status >= 500 ? 'Server error.' : (err as Error).message };
    return reply.code(status).send(body);
  });

  type Handler = (me: Player, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** A route that needs a registered player. Undefined results become 204. */
  const authed = (h: Handler) => async (req: FastifyRequest, reply: FastifyReply) => {
    const me = await core.authenticate(bearer(req));
    const out = await h(me, req, reply);
    if (out === undefined) return reply.code(204).send();
    return out;
  };
  const body = <T>(req: FastifyRequest) => (req.body ?? {}) as Partial<T> & Record<string, unknown>;
  const query = (req: FastifyRequest) => (req.query ?? {}) as Record<string, string | undefined>;
  const param = (req: FastifyRequest, k: string) => String((req.params as Record<string, string>)[k] ?? '');

  app.get('/healthz', async () => ({ ok: true }));
  app.get(Routes.hello, async () => core.hello());

  // Identity
  app.post(Routes.players, async (req, reply) => reply.code(201).send(await core.register(body<{ name: string }>(req).name)));
  app.get(Routes.me, authed(async (me) => core.me(me)));
  app.put(Routes.me, authed(async (me, req) => core.rename(me, body<{ name: string }>(req).name)));

  // PvP
  app.put(Routes.base, authed(async (me, req) => core.uploadBase(me, req.body as never)));
  app.get(Routes.match, authed(async (me) => core.match(me)));
  app.post(Routes.attacks, authed(async (me, req) => core.attack(me, req.body as never)));
  app.get(Routes.defenses, authed(async (me, req) => core.defenses(me, Number(query(req).since ?? 0))));
  app.get(Routes.leaderboard, authed(async (me, req) => core.leaderboard(me, Number(query(req).limit ?? 50))));

  // Groves
  app.get(Routes.groves, authed(async (me, req) => core.listGroves(me, query(req).q ?? '')));
  app.post(Routes.groves, authed(async (me, req, reply) => reply.code(201).send(await core.createGrove(me, body<{ name: string }>(req).name))));
  app.post('/v1/groves/:id/join', authed(async (me, req) => core.joinGrove(me, param(req, 'id'))));
  app.get(Routes.grove, authed(async (me): Promise<MyGroveResponse> => ({ grove: await core.myGrove(me) })));
  app.post(Routes.groveLeave, authed(async (me) => core.leaveGrove(me)));
  app.get(Routes.groveChat, authed(async (me, req) => core.chat(me, query(req).after)));
  app.post(Routes.groveChat, authed(async (me, req, reply) => reply.code(201).send(await core.postChat(me, body<{ text: string }>(req).text))));
  app.get(Routes.groveRequests, authed(async (me) => core.requests(me)));
  app.post(Routes.groveRequests, authed(async (me, req, reply) => reply.code(201).send(await core.requestTroops(me, body<{ capacity: number }>(req).capacity))));
  app.post('/v1/grove/requests/:id/donate', authed(async (me, req) => core.donate(me, param(req, 'id'), req.body as never)));
  app.get(Routes.groveInbox, authed(async (me) => core.inbox(me)));
  app.post(Routes.groveInboxAck, authed(async (me, req) => core.ackInbox(me, body<{ ids: string[] }>(req).ids)));

  // Grove Raid
  app.get(Routes.groveRaid, authed(async (me) => core.raid(me)));
  app.post(Routes.groveRaidTicket, authed(async (me, req) => core.raidTicket(me, body<{ target: number }>(req).target)));
  app.post(Routes.groveRaidAttacks, authed(async (me, req) => core.raidAttack(me, req.body as never)));
  app.post(Routes.groveRaidClaim, authed(async (me, req) => core.claimRaid(me, body<{ week: number }>(req).week)));

  return app;
}
