/**
 * Protocol contract: what any Toadstool Kingdoms server must do, checked
 * through the game's own HTTP adapter. Run it against a deployed or future
 * server with
 *
 *   CONTRACT_URL=https://your-server.example.com npm run test:contract
 *
 * Without CONTRACT_URL it starts our server (memory storage) on a free port,
 * so it also runs with every `npm test`.
 *
 * It uses the server's real clock and leaves a few test players and a test
 * Grove behind (names start with "Contract"), so point it at a staging server
 * rather than production when you can.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { buildServer } from '../../server/app';
import { MemoryRepo } from '../../server/repo';
import { HttpServerAdapter, memoryTokenStore } from '../../src/net/httpAdapter';
import { ServerError } from '../../src/net/ports';
import { PROTOCOL_VERSION, Routes } from '../../src/net/protocol';
import { runBattle } from '../../src/sim/battle/battle';
import { generateOpponent } from '../../src/sim/battle/basegen';
import { defaultData as data } from '../../src/sim/data';

let url = process.env.CONTRACT_URL ?? '';
let close: (() => Promise<void>) | null = null;
const tag = Math.random().toString(36).slice(2, 7);

beforeAll(async () => {
  if (url) return;
  const app = buildServer({ repo: new MemoryRepo(), data });
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.close();
});
afterAll(async () => {
  await close?.();
});

const client = () => new HttpServerAdapter(url, { tokens: memoryTokenStore(), retryDelayMs: 200 });

async function player(name: string, hall = 1) {
  const c = client();
  const reg = await c.register(`Contract ${name} ${tag}`);
  await c.uploadBase({ base: generateOpponent(hall * 101 + name.length, hall, data) });
  return Object.assign(c, { id: reg.playerId });
}

async function errorOf(p: Promise<unknown>): Promise<ServerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServerError) return e;
    throw e;
  }
  throw new Error('expected the server to refuse this');
}

const rush = (n: number) => ({ army: { hedgehog_roller: n }, deployments: Array.from({ length: n }, (_, i) => ({ tick: i, troop: 'hedgehog_roller', x: 1, y: 1 + i })) });

describe('protocol contract', () => {
  it('hello: names the game, its protocol range and features', async () => {
    const h = await client().hello(); // the adapter also checks compatibility
    expect(h.name).toBe('toadstool-kingdoms');
    expect(h.minProtocol).toBeLessThanOrEqual(PROTOCOL_VERSION);
    expect(h.protocol).toBeGreaterThanOrEqual(PROTOCOL_VERSION);
    expect(Math.abs(h.serverTime - Date.now())).toBeLessThan(5 * 60_000);
    expect(h.features).toEqual(expect.arrayContaining(['pvp', 'leaderboard', 'groves', 'grove-chat', 'donations', 'grove-raid']));
  });

  it('answers CORS preflights so the web game can call it', async () => {
    const res = await fetch(`${url}${Routes.match}`, { method: 'OPTIONS', headers: { origin: 'https://example.github.io', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('identity: register gives a token; calls without it get 401 unauthorized with an error body', async () => {
    const c = client();
    const e = await errorOf(c.me());
    expect(e.status).toBe(401);
    expect(e.code).toBe('unauthorized');
    expect(e.message).toBeTruthy();
    const r = await c.register(`Contract Pip ${tag}`);
    expect(r.playerId).toBeTruthy();
    expect(r.token.length).toBeGreaterThanOrEqual(16);
    const me = await c.me();
    expect(me).toMatchObject({ id: r.playerId, groveId: null, hallLevel: 1 });
    expect(me.shieldUntil).toBeGreaterThan(Date.now()); // new players start shielded
    expect((await c.rename(`Contract Pip the Bold ${tag}`.slice(0, 24))).name).toMatch(/^Contract Pip/);
  });

  it('bases: valid ones are stored, impossible ones are refused with bad_request', async () => {
    const c = client();
    await c.register(`Contract Base ${tag}`);
    await c.uploadBase({ base: generateOpponent(5, 2, data) });
    expect((await c.me()).hallLevel).toBe(2);
    const bad = generateOpponent(5, 2, data);
    bad.buildings[1] = { ...bad.buildings[1], x: bad.buildings[0].x, y: bad.buildings[0].y };
    const e = await errorOf(c.uploadBase({ base: bad }));
    expect(e).toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('pvp: match gives a base within one Elder Toadstool level; the server re-runs the battle exactly like the game', async () => {
    const a = await player('Attacker', 2);
    const m = (await a.match())!;
    expect(m).not.toBeNull();
    expect(Math.abs(m.base.hallLevel - 2)).toBeLessThanOrEqual(1);
    expect(['player', 'bot']).toContain(m.opponent.kind);
    expect(m.expiresAt).toBeGreaterThan(Date.now() + 3 * 60_000);
    const sub = { ticket: m.ticket, seed: 1234, ...rush(25) };
    const r = await a.submitAttack(sub);
    const local = runBattle({ seed: sub.seed, base: m.base, army: sub.army }, sub.deployments, data).result;
    expect(r.result.hash).toBe(local.hash); // same deterministic battle on both sides
    expect(r.result.stars).toBe(local.stars);
    expect((await a.me()).trophies).toBe(r.playerTrophies);
    const again = await errorOf(a.submitAttack(sub));
    expect(again).toMatchObject({ status: 409, code: 'conflict' });
  });

  it('pvp: refuses foreign tickets, oversized armies and troop levels above the hall cap', async () => {
    const a = await player('Ann');
    const b = await player('Ben');
    const m = (await a.match())!;
    expect(await errorOf(b.submitAttack({ ticket: m.ticket, seed: 1, army: {}, deployments: [] }))).toMatchObject({ status: 404, code: 'not_found' });
    expect(await errorOf(a.submitAttack({ ticket: m.ticket, seed: 1, army: { beetle_brute: 999 }, deployments: [] }))).toMatchObject({ status: 400, code: 'bad_request' });
    expect(await errorOf(a.submitAttack({ ticket: m.ticket, seed: 1, army: { hedgehog_roller: 5 }, levels: { hedgehog_roller: 5 }, deployments: [] }))).toMatchObject({ status: 400, code: 'bad_request' });
    const { defenses } = await a.defenses(0);
    expect(Array.isArray(defenses)).toBe(true);
    const lb = await a.leaderboard(5);
    expect(lb.players.length).toBeLessThanOrEqual(5);
    for (const p of lb.players) expect(p).toEqual(expect.objectContaining({ rank: expect.any(Number), name: expect.any(String), trophies: expect.any(Number), hallLevel: expect.any(Number) }));
  });

  it('groves: found, find, join, chat (filtered), request and donate troops, inbox, leave', async () => {
    const lead = await player('Leader', 3);
    const mate = await player('Mate', 3);
    expect(await lead.myGrove()).toBeNull();
    const g = await lead.createGrove(`Contract ${tag}`);
    expect(g.you.role).toBe('Leader');
    expect(await errorOf(lead.createGrove('Twice'))).toMatchObject({ status: 409, code: 'already_in_grove' });
    expect((await mate.listGroves(tag)).groves.map((x) => x.id)).toContain(g.id);
    const joined = await mate.joinGrove(g.id);
    expect(joined.members.map((m) => m.id).sort()).toEqual([lead.id, mate.id].sort());
    const start = await lead.chat();
    const msg = await mate.postChat('hello you stupid idiot');
    expect(msg.text).not.toMatch(/stupid|idiot/);
    const after = await lead.chat(start.cursor);
    expect(after.messages.map((m) => m.id)).toContain(msg.id);
    const req = await lead.requestTroops(10);
    expect(req.size).toBeGreaterThan(0);
    expect(await errorOf(lead.requestTroops(10))).toMatchObject({ status: 429, code: 'cooldown' });
    const seen = await mate.requests();
    expect(seen.requests.find((r) => r.id === req.id)).toMatchObject({ mine: false, filled: 0 });
    const don = await mate.donate(req.id, { troop: 'hedgehog_roller', count: 2, level: 1 });
    expect(don.request.filled).toBe(2);
    expect(don.xp).toBeGreaterThan(0);
    const inbox = await lead.inbox();
    expect(inbox.donations).toEqual([expect.objectContaining({ troop: 'hedgehog_roller', count: 2, level: 1 })]);
    await lead.ackInbox(inbox.donations.map((d) => d.id));
    expect((await lead.inbox()).donations).toHaveLength(0);
    await mate.leaveGrove();
    expect(await mate.myGrove()).toBeNull();
    expect(await errorOf(mate.chat())).toMatchObject({ status: 404, code: 'not_in_grove' });
  });

  it('grove raid: the weekly schedule, attack rules and claims', async () => {
    const lead = await player('Raider', 2);
    await lead.createGrove(`Contract Raid ${tag}`);
    const v = await lead.raid();
    expect(['upcoming', 'live', 'ended']).toContain(v.phase);
    expect(v.end - v.start).toBe(data.social.groveRaid.durationHours * 3_600_000);
    expect(v.nextStart).toBeGreaterThan(Date.now() - 1000);
    expect(Array.isArray(v.chests)).toBe(true);
    // Founded just now, so not part of a raid that already started.
    expect(await errorOf(lead.claimRaid(v.week + 1))).toMatchObject({ status: 409, code: 'raid_not_ended' });
    if (v.phase === 'live') {
      expect(v.eligible).toBe(false);
      expect(await errorOf(lead.raidTicket(0))).toMatchObject({ code: 'no_attacks_left' });
    } else {
      expect(await errorOf(lead.raidTicket(0))).toMatchObject({ status: 409, code: 'raid_not_live' });
    }
  });
});
