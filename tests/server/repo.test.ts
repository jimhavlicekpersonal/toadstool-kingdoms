/**
 * Contract for the server's storage port (server/repo.ts). Every adapter must
 * pass it: MemoryRepo always, PgRepo when TEST_DATABASE_URL is set. A future
 * database adapter only needs a factory added in ./pg.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Player, Repo, Ticket } from '../../server/repo';
import { baseAt } from './harness';
import { repoFactories } from './pg';

const T = Date.UTC(2026, 5, 1);

function player(id: string, over: Partial<Player> = {}): Player {
  return { id, name: id, tokenHash: `h-${id}`, trophies: 100, hallLevel: 2, shieldUntil: 0, base: baseAt(2), groveId: null, createdAt: T, updatedAt: T, lastSeenAt: T, ...over };
}

function ticket(id: string, attackerId: string, defenderId: string | null, over: Partial<Ticket> = {}): Ticket {
  return { id, kind: 'pvp', attackerId, defenderId, defenderName: 'x', base: baseAt(1), defenderTrophies: 0, createdAt: T, expiresAt: T + 3_600_000, used: false, ...over };
}

for (const [label, make] of repoFactories) {
  describe(`Repo contract: ${label}`, () => {
    let repo: Repo;
    const fresh = async () => (repo = await make());

    it('stores, finds and patches players', async () => {
      await fresh();
      await repo.createPlayer(player('a', { base: null }));
      expect((await repo.playerByTokenHash('h-a'))!.id).toBe('a');
      expect(await repo.playerByTokenHash('nope')).toBeNull();
      await repo.updatePlayer('a', { trophies: 250, groveId: 'g1', base: baseAt(3), hallLevel: 3, lastSeenAt: T + 5 });
      const a = (await repo.getPlayer('a'))!;
      expect(a).toMatchObject({ trophies: 250, groveId: 'g1', hallLevel: 3, lastSeenAt: T + 5 });
      expect(a.base!.buildings.length).toBeGreaterThan(0);
      await repo.updatePlayer('a', { groveId: null });
      expect((await repo.getPlayer('a'))!.groveId).toBeNull();
    });

    it('finds opponents by hall, trophies, shield, exclusions and open tickets', async () => {
      await fresh();
      await repo.createPlayer(player('me'));
      await repo.createPlayer(player('ok'));
      await repo.createPlayer(player('shielded', { shieldUntil: T + 1 }));
      await repo.createPlayer(player('nobase', { base: null }));
      await repo.createPlayer(player('tooHigh', { hallLevel: 5 }));
      await repo.createPlayer(player('tooRich', { trophies: 900 }));
      await repo.createPlayer(player('locked'));
      await repo.createPlayer(player('oldLock'));
      await repo.createTicket(ticket('t1', 'me', 'locked', { createdAt: T - 60_000 }));
      await repo.createTicket(ticket('t2', 'me', 'oldLock', { createdAt: T - 600_000 }));
      const q = { excludeIds: ['me'], minHall: 1, maxHall: 3, minTrophies: 0, maxTrophies: 200, now: T, lockedSince: T - 300_000, limit: 20 };
      expect((await repo.findOpponents(q)).map((p) => p.id).sort()).toEqual(['ok', 'oldLock']);
      await repo.useTicket('t1');
      expect((await repo.findOpponents(q)).map((p) => p.id).sort()).toEqual(['locked', 'ok', 'oldLock']);
      expect(await repo.findOpponents({ ...q, excludeIds: ['me', 'ok', 'locked', 'oldLock'] })).toEqual([]);
    });

    it('ranks players and uses each ticket once', async () => {
      await fresh();
      await repo.createPlayer(player('a', { trophies: 300 }));
      await repo.createPlayer(player('b', { trophies: 200, createdAt: T + 1 }));
      await repo.createPlayer(player('c', { trophies: 200, createdAt: T + 2 }));
      await repo.createPlayer(player('d', { trophies: 999, base: null }));
      expect((await repo.topPlayers(10)).map((p) => p.id)).toEqual(['a', 'b', 'c']);
      expect(await repo.rankOf(200)).toBe(2);
      expect(await repo.rankOf(1000)).toBe(1);
      await repo.createTicket(ticket('t', 'a', null, { kind: 'raid', week: 4, groveId: 'g', target: 2 }));
      expect(await repo.getTicket('t')).toMatchObject({ kind: 'raid', defenderId: null, week: 4, groveId: 'g', target: 2, used: false });
      const both = await Promise.all([repo.useTicket('t'), repo.useTicket('t')]);
      expect(both.filter(Boolean)).toHaveLength(1);
      expect(await repo.useTicket('missing')).toBe(false);
    });

    it('keeps attacks as defense logs and recent targets', async () => {
      await fresh();
      await repo.createPlayer(player('a'));
      await repo.createPlayer(player('b'));
      const rec = (id: string, at: number) => ({ id, at, attackerId: 'a', attackerName: 'A', defenderId: 'b', seed: 1, army: {}, levels: {}, base: baseAt(1), deployments: [], result: { stars: 1, destruction: 50, loot: {}, used: {}, ticks: 10, hallDestroyed: false, endReason: 'time' as const, hash: 'h' }, attackerTrophies: 5, defenderTrophies: -5 });
      await repo.addAttack(rec('x1', T + 1));
      await repo.addAttack(rec('x2', T + 2));
      await repo.addAttack(rec('x3', T + 3));
      expect((await repo.defensesFor('b', T + 1, 10)).map((a) => a.id)).toEqual(['x2', 'x3']);
      expect((await repo.defensesFor('b', 0, 2)).map((a) => a.id)).toEqual(['x2', 'x3']);
      expect(await repo.recentTargets('a', T + 2)).toEqual(['b']);
      expect(await repo.recentTargets('a', T + 3)).toEqual([]);
    });

    it('lists Groves with member counts and activity, and manages members', async () => {
      await fresh();
      await repo.createPlayer(player('a', { trophies: 100, lastSeenAt: T + 10 }));
      await repo.createPlayer(player('b', { trophies: 300, lastSeenAt: T + 20 }));
      await repo.createGrove({ id: 'g1', name: 'Mossy Hollow', color: '#fff', createdAt: T });
      await repo.createGrove({ id: 'g2', name: 'Empty', color: '#fff', createdAt: T });
      await repo.addMember({ groveId: 'g1', playerId: 'a', role: 'Leader', joinedAt: T, xp: 0 });
      await repo.addMember({ groveId: 'g1', playerId: 'b', role: 'Member', joinedAt: T + 1, xp: 0 });
      const list = await repo.listGroves('', 10);
      expect(list).toHaveLength(1); // empty Groves are not listed
      expect(list[0]).toMatchObject({ id: 'g1', members: 2, averageTrophies: 200, lastActiveAt: T + 20 });
      expect(await repo.listGroves('HOLLOW', 10)).toHaveLength(1);
      expect(await repo.listGroves('%', 10)).toHaveLength(0);
      expect(await repo.addMember({ groveId: 'g2', playerId: 'a', role: 'Member', joinedAt: T, xp: 0 })).toBe(false); // one Grove per player
      await repo.updateMember('g1', 'b', { role: 'Elder', xp: 40 });
      expect(await repo.getMembership('b')).toMatchObject({ groveId: 'g1', role: 'Elder', xp: 40 });
      expect((await repo.members('g1')).map((m) => m.playerId)).toEqual(['a', 'b']);
      await repo.removeMember('g1', 'b');
      expect(await repo.getMembership('b')).toBeNull();
    });

    it('pages chat by increasing cursor and counts recent messages', async () => {
      await fresh();
      await repo.createGrove({ id: 'g', name: 'G', color: '#fff', createdAt: T });
      await repo.createGrove({ id: 'h', name: 'H', color: '#fff', createdAt: T });
      const rows = [];
      for (let i = 0; i < 5; i++) rows.push(await repo.addChat({ id: `c${i}`, groveId: i === 2 ? 'h' : 'g', at: T + i, playerId: 'p', name: 'P', text: `m${i}`, kind: i === 4 ? 'system' : 'chat' }));
      expect(rows.map((r) => r.seq)).toEqual([...rows.map((r) => r.seq)].sort((a, b) => a - b));
      expect((await repo.chatAfter('g', 0, 100)).map((r) => r.text)).toEqual(['m0', 'm1', 'm3', 'm4']);
      expect((await repo.chatAfter('g', rows[1].seq, 100)).map((r) => r.text)).toEqual(['m3', 'm4']);
      expect((await repo.chatAfter('g', 0, 2)).map((r) => r.text)).toEqual(['m3', 'm4']); // newest page
      expect(await repo.recentChatCount('p', T + 1)).toBe(2); // m2, m3 ('system' does not count)
    });

    it('fills troop requests atomically and delivers donations once', async () => {
      await fresh();
      await repo.createPlayer(player('a'));
      await repo.createGrove({ id: 'g', name: 'G', color: '#fff', createdAt: T });
      await repo.addRequest({ id: 'r', groveId: 'g', playerId: 'a', name: 'A', at: T, size: 10, filled: 0, open: true });
      await repo.addRequest({ id: 'old', groveId: 'g', playerId: 'a', name: 'A', at: T - 10, size: 5, filled: 0, open: true });
      expect(await repo.lastRequestAt('a')).toBe(T);
      expect((await repo.openRequests('g', T - 5)).map((r) => r.id)).toEqual(['r']);
      const fills = await Promise.all([repo.fillRequest('r', 6), repo.fillRequest('r', 6)]);
      expect(fills.filter(Boolean)).toHaveLength(1); // never over-filled
      const done = await repo.fillRequest('r', 4);
      expect(done).toMatchObject({ filled: 10, open: false });
      expect(await repo.fillRequest('r', 1)).toBeNull();
      await repo.closeRequestsOf('a');
      expect(await repo.openRequests('g', 0)).toEqual([]);
      const don = { requestId: 'r', groveId: 'g', fromId: 'b', fromName: 'B', toId: 'a', troop: 'hedgehog_roller', count: 2, level: 1, at: T, delivered: false };
      await repo.addDonation({ ...don, id: 'd1' });
      await repo.addDonation({ ...don, id: 'd2' });
      await repo.markDelivered('someone-else', ['d1']);
      expect((await repo.undelivered('a')).map((d) => d.id)).toEqual(['d1', 'd2']);
      await repo.markDelivered('a', ['d1']);
      expect((await repo.undelivered('a')).map((d) => d.id)).toEqual(['d2']);
    });

    it('pairs Groves once per week and records raid attacks and single claims', async () => {
      await fresh();
      await repo.createPlayer(player('a', { lastSeenAt: T }));
      await repo.createPlayer(player('b', { lastSeenAt: T - 1_000_000 }));
      for (const [g, p] of [['g1', 'a'], ['g2', 'b']]) {
        await repo.createGrove({ id: g, name: g, color: '#fff', createdAt: T });
        expect(await repo.addMember({ groveId: g, playerId: p, role: 'Leader', joinedAt: T, xp: 0 })).toBe(true);
      }
      expect((await repo.unpairedGroves(3, T - 10, 10)).map((g) => g.id)).toEqual(['g1']); // g2 inactive
      const pairing = (g: string, o: string | null) => ({ week: 3, groveId: g, opponentGroveId: o, opponentName: 'x', botSeed: 7, roster: [{ index: 0, name: 'n', hallLevel: 1, trophies: 0, base: baseAt(1), playerId: null }], ourSize: 1, ourHall: 1, createdAt: T });
      expect(await repo.createPairings([pairing('g1', 'g2'), pairing('g2', 'g1')])).toBe(true);
      expect(await repo.createPairings([pairing('g1', null)])).toBe(false);
      expect(await repo.getPairing(3, 'g1')).toMatchObject({ opponentGroveId: 'g2', botSeed: 7, ourSize: 1 });
      expect((await repo.getPairing(3, 'g1'))!.roster[0].base.buildings.length).toBeGreaterThan(0);
      expect(await repo.unpairedGroves(3, 0, 10)).toEqual([]);
      expect((await repo.unpairedGroves(4, 0, 10)).length).toBe(2);
      await repo.addRaidAttack({ id: 'ra', week: 3, groveId: 'g1', attackerId: 'a', target: 0, stars: 2, destruction: 61.5, at: T });
      expect(await repo.raidAttacks(3, 'g1')).toEqual([{ id: 'ra', week: 3, groveId: 'g1', attackerId: 'a', target: 0, stars: 2, destruction: 61.5, at: T }]);
      expect(await repo.raidAttacks(3, 'g2')).toEqual([]);
      const claim = { week: 3, playerId: 'a', groveId: 'g1', outcome: 'win' as const, at: T };
      const claims = await Promise.all([repo.addClaim(claim), repo.addClaim(claim)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await repo.getClaim(3, 'a')).toMatchObject({ outcome: 'win' });
      expect(await repo.getClaim(4, 'a')).toBeNull();
    });
  });
}
