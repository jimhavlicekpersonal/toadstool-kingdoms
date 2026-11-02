/**
 * End to end over real HTTP: the game's HttpServerAdapter and Connection
 * against the Fastify server listening on a port.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { buildServer } from '../../server/app';
import { MemoryRepo } from '../../server/repo';
import { Connection, type KeyValue } from '../../src/net/connection';
import { HttpServerAdapter, memoryTokenStore, normalizeServerUrl } from '../../src/net/httpAdapter';
import { ServerError } from '../../src/net/ports';
import { generateOpponent } from '../../src/sim/battle/basegen';
import { defaultData as data } from '../../src/sim/data';
import { applyCommand, createNewVillage, type Command } from '../../src/sim/village';
import { rush } from './harness';

const kv = (): KeyValue => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => (v === null ? m.delete(k) : m.set(k, v)) };
};

describe('game client against a running server', () => {
  let t = Date.UTC(2026, 3, 1);
  const app = buildServer({ repo: new MemoryRepo(), data, now: () => t });
  let url = '';
  const client = () => new HttpServerAdapter(url, { tokens: memoryTokenStore(), retryDelayMs: 0 });
  beforeAll(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
  });

  it('normalises server addresses', () => {
    expect(normalizeServerUrl('play.example.com/')).toBe('https://play.example.com');
    expect(normalizeServerUrl('192.168.1.20:8787')).toBe('http://192.168.1.20:8787');
    expect(normalizeServerUrl(' https://x.io// ')).toBe('https://x.io');
  });

  it('checks the protocol version and maps errors', async () => {
    const c = client();
    const hello = await c.hello();
    expect(hello.features).toContain('grove-raid');
    const err = await c.me().catch((e) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect(err).toMatchObject({ status: 401, code: 'unauthorized', retryable: false });
    const dead = new HttpServerAdapter('http://127.0.0.1:1', { tokens: memoryTokenStore(), retries: 1, retryDelayMs: 0, timeoutMs: 2000 });
    const net = await dead.hello().catch((e) => e);
    expect(net).toMatchObject({ code: 'network', retryable: true });
  });

  it('refuses a server whose protocol is too new or too old', async () => {
    const fake = (body: object) => new HttpServerAdapter('https://fake', { tokens: memoryTokenStore(), fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch });
    await expect(fake({ name: 'toadstool-kingdoms', protocol: 99, minProtocol: 99, serverTime: 0, features: [] }).hello()).rejects.toMatchObject({ code: 'version_mismatch' });
    await expect(fake({ name: 'toadstool-kingdoms', protocol: 1, minProtocol: 1, serverTime: 0, features: [] }).hello()).rejects.toMatchObject({ code: 'version_mismatch' });
    await expect(fake({ hello: 'world' }).hello()).rejects.toMatchObject({ code: 'version_mismatch' });
  });

  it('plays a full online loop: register, share the base, get raided, see it in the village', async () => {
    // Alice plays the real game client (Connection + village commands).
    const village = { data, state: createNewVillage(t, data), now: () => t, dispatch: (cmd: Command) => applyCommand(village.state, cmd, t, data) };
    village.dispatch = (cmd: Command) => {
      const r = applyCommand(village.state, cmd, t, data);
      if (r.ok) village.state = r.state;
      return r;
    };
    const alice = new Connection({ game: village, builtInUrl: url, kv: kv(), makePort: (u) => new HttpServerAdapter(u, { tokens: memoryTokenStore(), retryDelayMs: 0 }), log: () => undefined });
    await alice.sync();
    expect(alice.status).toBe('online');

    // Bob uses the adapter directly.
    const bob = client();
    await bob.register('Bob');
    await bob.uploadBase({ base: generateOpponent(9, 1, data) });
    t += 25 * 3_600_000; // past the new-player shields
    await alice.uploadBase();
    const m = (await bob.match())!;
    expect(m.opponent).toMatchObject({ kind: 'player', name: alice.player!.name });
    await bob.submitAttack({ ticket: m.ticket, seed: 3, ...rush(20) });

    await alice.sync();
    expect(village.state.defenseLog.map((d) => d.opponentName)).toEqual(['Bob']);

    // And Alice attacks back through her outbox.
    const back = (await alice.port!.match())!;
    await alice.report('attack', { ticket: back.ticket, seed: 4, ...rush(20) });
    expect(alice.outbox()).toHaveLength(0);
    expect((await bob.defenses(0)).defenses.map((d) => d.attackerName)).toContain(alice.player!.name);
  });
});
