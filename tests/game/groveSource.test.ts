/** The Grove screen's port: the same actions against the bot Grove and a real Grove on the server. */
import { describe, expect, it } from 'vitest';
import { InProcessServerAdapter } from '../../server/inProcess';
import { Analytics, MemoryEventStore } from '../../src/analytics/events';
import { GameController } from '../../src/game/controller';
import { LocalGroveSource, RemoteGroveSource } from '../../src/game/groveSource';
import { Connection, type KeyValue } from '../../src/net/connection';
import { MemorySaveStore } from '../../src/persist/saveStore';
import { baseAt, rush, world } from '../server/harness';

const kv = (): KeyValue => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => (v === null ? m.delete(k) : m.set(k, v)) };
};

async function game(w: ReturnType<typeof world>, botRaids = true) {
  const clock = { now: () => w.now() };
  const { controller } = await GameController.start({ clock, store: new MemorySaveStore(), data: w.data, analytics: new Analytics(new MemoryEventStore(), clock, 'test'), botRaids });
  return controller;
}

describe('LocalGroveSource', () => {
  it('joins the bot Grove and chats through village commands', async () => {
    const w = world();
    const c = await game(w);
    const src = new LocalGroveSource(c);
    expect(src.snapshot()).toMatchObject({ kind: 'local', joined: false, canLeave: false });
    expect((await src.join()).ok).toBe(true);
    const snap = src.snapshot();
    expect(snap.joined).toBe(true);
    expect(snap.members.filter((m) => m.you)).toHaveLength(1);
    expect((await src.send('hello friends')).ok).toBe(true);
    expect(src.snapshot().chat.some((m) => m.mine && m.text === 'hello friends')).toBe(true);
    const outside = await src.raidBattle(0);
    if (src.snapshot().raid.phase !== 'live') expect(outside).toHaveProperty('error');
  });
});

describe('RemoteGroveSource', () => {
  it('browses, joins, chats, donates and fights the Grove Raid on the server', async () => {
    const w = world();
    const c = await game(w, false);
    const port = new InProcessServerAdapter(w.core);
    const conn = new Connection({ game: c, builtInUrl: 'test.server', kv: kv(), makePort: () => port, log: () => undefined });
    const src = new RemoteGroveSource(c, conn);
    expect(src.snapshot().loading).toBe(true);

    const ben = await w.player('Ben', baseAt(3));
    const g = await ben.createGrove('Mossy Hollow');
    await src.refresh();
    let snap = src.snapshot();
    expect(snap).toMatchObject({ kind: 'online', loading: false, error: null, joined: false });
    expect(snap.listings.map((x) => x.name)).toEqual(['Mossy Hollow']);

    expect((await src.join(g.id)).ok).toBe(true);
    snap = src.snapshot();
    expect(snap.joined).toBe(true);
    expect(snap.members.map((m) => m.you).sort()).toEqual([false, true]);
    expect(snap.canLeave).toBe(true);

    expect((await src.send('hi Ben')).ok).toBe(true);
    expect((await ben.chat()).messages.some((m) => m.text === 'hi Ben')).toBe(true);

    // Donating: the server records it, then the troop leaves our army and we earn XP.
    const army = { hedgehog_roller: 12 };
    await c.replace({ ...structuredClone(c.state), army });
    await ben.requestTroops(10);
    await src.refresh();
    const req = src.snapshot().requests[0];
    expect(req.name).toBe('Ben');
    const xp = c.state.grove.xp;
    expect((await src.donate(req.id, 'hedgehog_roller')).ok).toBe(true);
    expect(c.state.army.hedgehog_roller).toBe(11);
    expect(c.state.grove.xp).toBe(xp + w.data.troops.hedgehog_roller.housing * w.data.social.xpPerHousing);
    expect(src.snapshot().requests[0].filled).toBe(1);
    // Our own request is not listed for us to fill.
    expect((await src.donate('nope', 'hedgehog_roller')).ok).toBe(false);
    expect(c.state.army.hedgehog_roller).toBe(11);

    // Grove Raid (both of us joined before it started).
    w.intoRaid(1);
    await conn.sync();
    await src.refresh();
    snap = src.snapshot();
    expect(snap.raid.phase).toBe('live');
    expect(snap.raid.bases.length).toBeGreaterThan(0);
    expect(snap.raid.attacksLeft).toBe(2);
    const battle = await src.raidBattle(0);
    if ('error' in battle) throw new Error(battle.error);
    const { deployments } = rush(10);
    const out = battle.finish(deployments, undefined);
    expect(out).not.toBeNull();
    expect(c.state.army.hedgehog_roller ?? 0).toBeLessThan(11);
    await conn.flush();
    await src.refresh();
    expect(src.snapshot().raid.attacksLeft).toBe(1);
    expect(src.snapshot().raid.bases[0].stars).toBe(out!.stars);

    expect((await src.leave()).ok).toBe(true);
    expect(src.snapshot().joined).toBe(false);
  });
});
