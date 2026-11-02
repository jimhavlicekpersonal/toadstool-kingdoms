/**
 * The server core, through the same ServerPort the game uses (in-process
 * adapter). Checks that online play follows the game-theory rules: hall
 * window, trophy-based matching, loot penalty and storage caps, shield tiers,
 * Grove rules and the weekly Grove Raid.
 */
import { describe, expect, it } from 'vitest';
import { ServerError } from '../../src/net/ports';
import { runBattle } from '../../src/sim/battle/battle';
import { defaultData } from '../../src/sim/data';
import { shieldHoursFor, storageLootCap } from '../../src/sim/defense';
import { hallWindow, lootPenalty } from '../../src/sim/matchmaking';
import type { GameData } from '../../src/sim/types';
import { HOUR, baseAt, rush, sumLoot, world } from './harness';
import { repoFactories } from './pg';

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServerError) return e.code;
    throw e;
  }
  return 'ok';
}

const noTroops = { army: {}, deployments: [], endTick: 1 };

for (const [label, makeRepo] of repoFactories) {
  const W = async (o: { data?: GameData } = {}) => world({ ...o, repo: await makeRepo() });

  describe(`server core on ${label} storage`, () => {

    describe('PvP matchmaking on the server', () => {
      it('falls back to a generated base of matched strength when no real player fits', async () => {
        const w = await W();
        const a = await w.player('Ann', baseAt(2));
        const m = (await a.match())!;
        expect(m.opponent.kind).toBe('bot');
        const win = hallWindow(2, w.data);
        expect(m.base.hallLevel).toBeGreaterThanOrEqual(win.min);
        expect(m.base.hallLevel).toBeLessThanOrEqual(win.max);
        expect(m.expiresAt).toBe(w.now() + HOUR);
        // A bot battle still counts for trophies but leaves no defense record.
        const r = await a.submitAttack({ ticket: m.ticket, seed: 1, ...rush() });
        expect(r.playerTrophies).toBe(Math.max(0, r.trophies));
        expect(w.repo).toBeTruthy();
      });

      it('only matches real players within one Elder Toadstool level, and not while shielded', async () => {
        const w = await W();
        const a = await w.player('Ann', baseAt(1));
        await w.player('Three', baseAt(3));
        await w.player('Two', baseAt(2));
        expect((await a.match())!.opponent.kind).toBe('bot'); // everyone is still under the new-player shield
        w.pastShields();
        const m = (await a.match())!;
        expect(m.opponent).toMatchObject({ kind: 'player', name: 'Two', hallLevel: 2 });
      });

      it('reserves a matched base for its attacker for 5 minutes', async () => {
        const w = await W();
        const a = await w.player('Ann', baseAt(1));
        const b = await w.player('Ben', baseAt(1, 5));
        await w.player('Two', baseAt(2));
        w.pastShields();
        // Ann and Ben would match each other, so put them in one Grove (Grove mates never match).
        const g = await a.createGrove('Mossy Hollow');
        await b.joinGrove(g.id);
        expect((await a.match())!.opponent.name).toBe('Two');
        expect((await b.match())!.opponent.kind).toBe('bot');
        w.advance(6 * 60_000);
        expect((await b.match())!.opponent.name).toBe('Two');
      });

      it('does not offer the same player again within an hour', async () => {
        const w = await W();
        const a = await w.player('Ann', baseAt(1));
        await w.player('Two', baseAt(2));
        w.pastShields();
        const m = (await a.match())!;
        expect(m.opponent.name).toBe('Two');
        await a.submitAttack({ ticket: m.ticket, seed: 1, ...noTroops }); // 0% destruction: no shield
        expect((await a.match())!.opponent.kind).toBe('bot');
        w.advance(HOUR + 60_000);
        expect((await a.match())!.opponent.name).toBe('Two');
      });

      it('caps storage loot at upload and applies the loot penalty to higher-hall attackers', async () => {
        const w = await W();
        const two = await w.player('Two', baseAt(2, 22, 1_000_000));
        const stored = (await w.repo.getPlayer(two.id))!.base!;
        const stores = stored.buildings.filter((b) => !w.data.buildings[b.type].produces);
        expect(stores.reduce((s, b) => s + (b.loot?.acorns ?? 0), 0)).toBeLessThanOrEqual(storageLootCap(2, w.data));
        for (const b of stored.buildings) {
          const def = w.data.buildings[b.type];
          if (!def.produces) continue;
          const rate = def.levels[b.level - 1].ratePerHour ?? 0;
          expect(b.loot?.[def.produces] ?? 0).toBeLessThanOrEqual(rate * w.data.economy.collectorHoursCap * w.data.economy.raidableUncollectedFraction);
        }
        const a = await w.player('Ann', baseAt(3));
        w.pastShields();
        const m = (await a.match())!;
        expect(m.opponent.name).toBe('Two');
        const k = lootPenalty(3, 2, w.data);
        expect(k).toBeLessThan(1);
        m.base.buildings.forEach((b, i) => expect(b.loot?.acorns ?? 0).toBe(Math.floor((stored.buildings[i].loot?.acorns ?? 0) * k)));
        expect(sumLoot(m.base)).toBeLessThan(sumLoot(stored));
      });

      it('re-simulates attacks, moves trophies both ways and shields the defender by destruction tier', async () => {
        const w = await W();
        const a = await w.player('Ann', baseAt(1));
        const d = await w.player('Dot', baseAt(1, 77));
        w.pastShields();
        const m = (await a.match())!;
        expect(m.opponent.name).toBe('Dot');
        const { army, deployments } = rush(20);
        const r = await a.submitAttack({ ticket: m.ticket, seed: 5, army, deployments });
        const local = runBattle({ seed: 5, base: m.base, army }, deployments, w.data).result;
        expect(r.result.hash).toBe(local.hash);
        expect((await a.me()).trophies).toBe(r.playerTrophies);
        const dp = await d.me();
        expect(dp.trophies).toBe(Math.max(0, -r.trophies));
        const hours = shieldHoursFor(local.destruction, w.data);
        if (hours) expect(dp.shieldUntil).toBe(w.now() + hours * HOUR);
        const defs = (await d.defenses(0)).defenses;
        expect(defs).toHaveLength(1);
        expect(defs[0]).toMatchObject({ attackerName: 'Ann', trophies: -r.trophies, seed: 5 });
      });

      it('refuses late, reused and foreign tickets, and impossible armies', async () => {
        const w = await W();
        const a = await w.player('Ann', baseAt(1));
        const b = await w.player('Ben', baseAt(1, 4));
        const m1 = (await a.match())!;
        expect(await code(b.submitAttack({ ticket: m1.ticket, seed: 1, ...noTroops }))).toBe('not_found');
        expect(await code(a.submitAttack({ ticket: m1.ticket, seed: 1, army: { beetle_brute: 500 }, deployments: [] }))).toBe('bad_request');
        expect(await code(a.submitAttack({ ticket: m1.ticket, seed: 1, army: { hedgehog_roller: 5 }, levels: { hedgehog_roller: 4 }, deployments: [] }))).toBe('bad_request');
        expect(await code(a.submitAttack({ ticket: m1.ticket, seed: 1, ...noTroops }))).toBe('ok');
        expect(await code(a.submitAttack({ ticket: m1.ticket, seed: 1, ...noTroops }))).toBe('conflict');
        const m2 = (await a.match())!;
        w.advance(HOUR + 1);
        expect(await code(a.submitAttack({ ticket: m2.ticket, seed: 1, ...noTroops }))).toBe('expired');
      });

      it('ranks players with bases on the leaderboard', async () => {
        const w = await W();
        const a = await w.player('Ann', baseAt(1));
        await w.player('Ben', baseAt(1, 4));
        await w.repo.updatePlayer(a.id, { trophies: 300 });
        const lb = await a.leaderboard(10);
        expect(lb.players.map((p) => p.name)).toEqual(['Ann', 'Ben']);
        expect(lb.me).toEqual({ rank: 1, trophies: 300 });
      });
    });

    describe('Groves on the server', () => {
      const small: GameData = { ...defaultData, social: { ...defaultData.social, membersMax: 3 } };

      it('creates, lists and joins Groves, and refuses full ones and double membership', async () => {
        const w = await W({ data: small });
        const [a, b, c, d] = await Promise.all(['Ann', 'Ben', 'Cat', 'Dan'].map((n) => w.player(n, baseAt(1))));
        const g = await a.createGrove('Mossy Hollow');
        expect(g.you.role).toBe('Leader');
        expect(await code(a.createGrove('Second'))).toBe('already_in_grove');
        expect((await b.listGroves()).groves.map((x) => x.name)).toEqual(['Mossy Hollow']);
        await b.joinGrove(g.id);
        await c.joinGrove(g.id);
        expect((await d.listGroves()).groves).toHaveLength(0); // full Groves are not listed
        expect(await code(d.joinGrove(g.id))).toBe('full');
        expect(await d.myGrove()).toBeNull();
        expect((await a.myGrove())!.members).toHaveLength(3);
        expect((await a.me()).groveId).toBe(g.id);
      });

      it('hands leadership to the longest-serving member when the Leader leaves', async () => {
        const w = await W();
        const a = await w.player('Ann');
        const b = await w.player('Ben');
        const c = await w.player('Cat');
        const g = await a.createGrove('Fern Gully');
        await b.joinGrove(g.id);
        w.advance(1000);
        await c.joinGrove(g.id);
        await a.leaveGrove();
        const view = (await c.myGrove())!;
        expect(view.members.find((m) => m.name === 'Ben')!.role).toBe('Leader');
        expect(await a.myGrove()).toBeNull();
        expect((await a.me()).groveId).toBeNull();
      });

      it('filters chat, limits how fast one player posts and pages with a cursor', async () => {
        const w = await W();
        const a = await w.player('Ann');
        const b = await w.player('Ben');
        const g = await a.createGrove('Puddle Pals');
        await b.joinGrove(g.id);
        const first = await b.chat();
        const sent = await a.postChat('you are a stupid idiot');
        expect(sent.text).not.toMatch(/stupid|idiot/);
        const later = await b.chat(first.cursor);
        expect(later.messages.map((m) => m.id)).toEqual([sent.id]);
        expect(later.messages[0].from!.name).toBe('Ann');
        for (let i = 1; i < w.data.social.chatPerMinute; i++) await a.postChat(`hi ${i}`);
        expect(await code(a.postChat('one more'))).toBe('cooldown');
        w.advance(61_000);
        expect(await code(a.postChat('ok again'))).toBe('ok');
        expect(await code(a.postChat('   '))).toBe('bad_request');
      });

      it('runs troop requests and donations end to end', async () => {
        const w = await W();
        const a = await w.player('Ann', baseAt(3));
        const b = await w.player('Ben', baseAt(3, 8));
        const g = await a.createGrove('Toad Hall');
        await b.joinGrove(g.id);
        const req = await a.requestTroops(10);
        expect(req.size).toBe(10);
        expect(await code(a.requestTroops(10))).toBe('cooldown');
        expect(await code(a.donate(req.id, { troop: 'hedgehog_roller', count: 1, level: 1 }))).toBe('bad_request'); // not your own
        const list = await b.requests();
        expect(list.requests).toHaveLength(1);
        expect(list.requests[0].mine).toBe(false);
        const don = await b.donate(req.id, { troop: 'beetle_brute', count: 1, level: 1 });
        expect(don.request.filled).toBe(5);
        expect(don.xp).toBe(5 * w.data.social.xpPerHousing);
        expect(await code(b.donate(req.id, { troop: 'beetle_brute', count: 2, level: 1 }))).toBe('full');
        expect(await code(b.donate(req.id, { troop: 'hedgehog_roller', count: 1, level: 9 }))).toBe('bad_request');
        await b.donate(req.id, { troop: 'hedgehog_roller', count: 5, level: 1 });
        expect((await b.requests()).requests).toHaveLength(0); // filled requests close
        const inbox = await a.inbox();
        expect(inbox.donations.map((d) => [d.fromName, d.troop, d.count])).toEqual([
          ['Ben', 'beetle_brute', 1],
          ['Ben', 'hedgehog_roller', 5],
        ]);
        await a.ackInbox(inbox.donations.map((d) => d.id));
        expect((await a.inbox()).donations).toHaveLength(0);
        expect((await a.myGrove())!.members.find((m) => m.name === 'Ben')!.xp).toBe(10 * w.data.social.xpPerHousing);
        w.advance(w.data.social.requestCooldownMinutes * 60_000);
        expect(await code(a.requestTroops(10))).toBe('ok');
      });
    });

    describe('Grove Raids on the server', () => {
      it('pairs two real Groves, scores best stars per base and pays each member once', async () => {
        const w = await W();
        const [ann, ben, cat, dan] = await Promise.all([w.player('Ann', baseAt(1, 1)), w.player('Ben', baseAt(1, 2)), w.player('Cat', baseAt(1, 3)), w.player('Dan', baseAt(1, 4))]);
        const ga = await ann.createGrove('Acorn Army');
        await ben.joinGrove(ga.id);
        const gb = await cat.createGrove('Beetle Band');
        await dan.joinGrove(gb.id);
        const before = await ann.raid();
        expect(before.phase).not.toBe('live');
        const week = w.intoRaid(1);
        await cat.me(); // Beetle Band was seen recently
        const view = await ann.raid();
        expect(view).toMatchObject({ phase: 'live', week, eligible: true, attacksLeft: 2 });
        expect(view.opponent).toMatchObject({ name: 'Beetle Band', kind: 'grove' });
        expect(view.opponent!.members.map((m) => m.name).sort()).toEqual(['Cat', 'Dan']);
        expect((await cat.raid()).opponent!.name).toBe('Acorn Army');

        const stars: number[] = [];
        for (const who of [ann, ann, ben]) {
          const t = await who.raidTicket(0);
          expect(t.base.buildings.every((b) => !Object.values(b.loot ?? {}).some((v) => v))).toBe(true); // no loot in Grove Raids
          const r = await who.submitRaidAttack({ ticket: t.ticket, seed: stars.length + 1, ...rush(20) });
          stars.push(r.stars);
        }
        expect(await code(ann.raidTicket(1))).toBe('no_attacks_left');
        const best = Math.max(...stars);
        expect((await ann.raid()).enemyBaseStars[0]).toBe(best);
        expect((await ann.raid()).ours).toBe(best);
        expect((await cat.raid()).theirs).toBe(best);
        expect((await ben.raid()).attacksLeft).toBe(1);

        expect(await code(ann.claimRaid(week))).toBe('raid_not_ended');
        w.setTime(w.raidEnd(week) + 1);
        const done = await ann.raid();
        expect(done.result).toMatchObject({ ours: best, theirs: 0, outcome: best > 0 ? 'win' : 'draw' });
        expect(done.chests).toEqual([{ week, claimed: false }]);
        const claim = await ann.claimRaid(week);
        expect(claim).toMatchObject({ week, outcome: done.result!.outcome, alreadyClaimed: false });
        expect((await ann.claimRaid(week)).alreadyClaimed).toBe(true);
        expect((await ann.raid()).claimed).toBe(true);
        expect((await ann.raid()).chests).toEqual([{ week, claimed: true }]);
        expect((await cat.claimRaid(week)).outcome).toBe(best > 0 ? 'loss' : 'draw');
      });

      it('gives a Grove with no free rival a bot Grove whose stars grow during the event', async () => {
        const w = await W();
        const fay = await w.player('Fay', baseAt(2));
        const g = await fay.createGrove('Lonely Leaf');
        for (const n of ['Gus', 'Hal', 'Ivy']) await (await w.player(n, baseAt(2, n.length * 7))).joinGrove(g.id);
        const week = w.intoRaid(0.01);
        const early = await fay.raid();
        expect(early.opponent!.kind).toBe('bot');
        expect(early.opponent!.members.length).toBeGreaterThan(0);
        expect((await fay.raid()).theirs).toBe(early.theirs); // deterministic
        w.setTime(w.raidEnd(week) - 1);
        const late = await fay.raid();
        expect(late.theirs).toBeGreaterThanOrEqual(early.theirs);
        expect(late.theirs).toBeGreaterThan(0);
        expect(late.opponent!.name).toBe(early.opponent!.name);
      });

      it('keeps members who join during a raid out of it until next week', async () => {
        const w = await W();
        const ann = await w.player('Ann', baseAt(1));
        const g = await ann.createGrove('Acorn Army');
        const week = w.intoRaid(2);
        const eve = await w.player('Eve', baseAt(1, 9));
        await eve.joinGrove(g.id);
        const v = await eve.raid();
        expect(v).toMatchObject({ eligible: false, attacksLeft: 0 });
        expect(await code(eve.raidTicket(0))).toBe('no_attacks_left');
        w.setTime(w.raidEnd(week) + 1);
        expect((await eve.raid()).chests).toEqual([]);
        expect(await code(eve.claimRaid(week))).toBe('not_found');
        expect((await ann.claimRaid(week)).alreadyClaimed).toBe(false);
      });
    });
  });
}
