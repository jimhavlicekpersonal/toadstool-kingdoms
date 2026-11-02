/**
 * The Grove screen's port. GroveUi renders a GroveSnapshot and calls these
 * actions; it does not know whether the Grove is the offline bot Grove
 * (LocalGroveSource) or a real Grove on a server (RemoteGroveSource).
 */
import type { BattleSetup, Deployment } from '../sim/battle/types';
import type { Connection } from '../net/connection';
import { ServerError } from '../net/ports';
import type { ChatView, GroveView, GroveSummary, RaidView, RequestView } from '../net/protocol';
import { troopLevels } from '../sim/research';
import { mixSeed } from '../sim/rng';
import { canRequest, generateGrove, groveLevel, isOnline, reinforcementCapacity, reinforcementHousing } from '../sim/social/grove';
import { attacksLeft, enemyGrove, raidPhase, raidScore } from '../sim/social/groveRaid';
import { battleArmy, hallLevel } from '../sim/village';
import type { BaseLayout } from '../sim/battle/types';
import type { GameController } from './controller';

export type ChatKind = 'chat' | 'request' | 'donation' | 'system';
export type ActionResult = { ok: true; message?: string } | { ok: false; message: string };

export interface GroveMemberRow {
  id: string;
  name: string;
  role: string;
  hall: number;
  trophies: number;
  online: boolean;
  you: boolean;
}

export interface GroveChatRow {
  id: string;
  /** Empty for system messages. */
  who: string;
  mine: boolean;
  text: string;
  at: number;
  kind: ChatKind;
}

export interface GroveRequestRow {
  id: string;
  name: string;
  size: number;
  filled: number;
}

export interface GroveRaidSnapshot {
  phase: 'upcoming' | 'live' | 'ended';
  week: number;
  end: number;
  nextStart: number;
  /** False when the player joined after this raid started (online only). */
  eligible: boolean;
  enemyName: string | null;
  bases: { index: number; name: string; hall: number; stars: number }[];
  ours: number;
  theirs: number;
  attacksLeft: number;
}

export interface GroveSnapshot {
  kind: 'local' | 'online';
  /** Waiting for the first answer from the server. */
  loading: boolean;
  /** The server could not be reached (online only). */
  error: string | null;
  joined: boolean;
  /** Groves to join (online, not in a Grove). */
  listings: GroveSummary[];
  name: string;
  color: string;
  level: number;
  xp: number;
  maxMembers: number;
  members: GroveMemberRow[];
  chat: GroveChatRow[];
  requests: GroveRequestRow[];
  ask: { ok: boolean; message: string; readyAt?: number };
  raid: GroveRaidSnapshot;
  canLeave: boolean;
}

/** A Grove Raid battle ready to play: the base, and how to report it when done. */
export interface RaidBattle {
  setup: BattleSetup;
  enemyName: string;
  finish(deployments: Deployment[], endTick: number | undefined): { stars: number; destruction: number } | null;
}

export interface GroveSource {
  readonly kind: 'local' | 'online';
  snapshot(): GroveSnapshot;
  subscribe(fn: () => void): () => void;
  /** Live updates while the Grove screen is open; returns a function that stops them. */
  watch(): () => void;
  search(query: string): Promise<void>;
  join(id?: string): Promise<ActionResult>;
  create(name: string): Promise<ActionResult>;
  leave(): Promise<ActionResult>;
  send(text: string): Promise<ActionResult>;
  ask(): Promise<ActionResult>;
  donate(requestId: string, troop: string): Promise<ActionResult>;
  raidBattle(target: number): Promise<RaidBattle | { error: string }>;
}

const sub = (set: Set<() => void>, fn: () => void) => {
  set.add(fn);
  return () => {
    set.delete(fn);
  };
};

// -------------------------------------------------------------------- local

/** The offline Grove: bot members generated from the village seed (sim/social). */
export class LocalGroveSource implements GroveSource {
  readonly kind = 'local' as const;
  constructor(private readonly c: GameController) {}

  snapshot(): GroveSnapshot {
    const s = this.c.state;
    const gd = this.c.data;
    const now = this.c.now();
    const hl = hallLevel(s, gd);
    const grove = generateGrove(s.grove.seed, gd);
    const names = grove.members.map((m) => m.name);
    const members: GroveMemberRow[] = grove.members.map((m, i) => ({
      id: `m${i}`,
      name: m.name,
      role: m.role,
      hall: Math.max(1, Math.min(gd.hall.levels.length, hl + m.hallOffset)),
      trophies: Math.max(0, s.trophies + m.trophyOffset),
      online: isOnline(m, now),
      you: false,
    }));
    members.push({ id: 'you', name: 'You', role: 'Member', hall: hl, trophies: s.trophies, online: true, you: true });
    members.sort((a, b) => b.trophies - a.trophies);
    const p = raidPhase(now, gd);
    let raid: GroveRaidSnapshot = { phase: p.phase, week: p.week, end: p.end, nextStart: p.nextStart, eligible: true, enemyName: null, bases: [], ours: 0, theirs: 0, attacksLeft: 0 };
    if (s.grove.joined && p.phase === 'live') {
      const enemy = enemyGrove(s.grove.seed, p.week, hl, gd);
      const score = raidScore(s, p.week, now, hl, gd);
      raid = { ...raid, enemyName: enemy.name, bases: enemy.bases.map((b, i) => ({ index: i, name: b.name, hall: b.hallLevel, stars: score.enemyBaseStars[i] })), ours: score.ours, theirs: score.theirs, attacksLeft: attacksLeft(s, p.week, gd) };
    }
    return {
      kind: 'local',
      loading: false,
      error: null,
      joined: s.grove.joined,
      listings: [],
      name: grove.name,
      color: grove.color,
      level: groveLevel(s.grove.xp, gd),
      xp: s.grove.xp,
      maxMembers: grove.members.length + 1,
      members,
      chat: s.grove.chat.slice(-50).map((m, i) => ({ id: `${m.at}:${i}`, who: m.from === -1 ? 'You' : m.from === -2 ? '' : names[m.from] ?? 'Friend', mine: m.from === -1, text: m.text, at: m.at, kind: m.kind })),
      requests: s.grove.requests.map((r) => ({ id: r.id, name: names[r.member] ?? 'Friend', size: r.size, filled: r.donated })),
      ask: canRequest(s, now, gd),
      raid,
      canLeave: false,
    };
  }

  subscribe(fn: () => void): () => void {
    return this.c.subscribe(fn);
  }

  watch(): () => void {
    return () => undefined;
  }

  async search(): Promise<void> {}

  private run(cmd: Parameters<GameController['dispatch']>[0], okMessage?: string): ActionResult {
    const r = this.c.dispatch(cmd);
    return r.ok ? { ok: true, message: okMessage } : { ok: false, message: r.message };
  }

  async join(): Promise<ActionResult> {
    return this.run({ type: 'joinGrove' });
  }
  async create(): Promise<ActionResult> {
    return this.run({ type: 'joinGrove' });
  }
  async leave(): Promise<ActionResult> {
    return { ok: false, message: 'Offline Groves cannot be left.' };
  }
  async send(text: string): Promise<ActionResult> {
    return this.run({ type: 'chat', text });
  }
  async ask(): Promise<ActionResult> {
    return this.run({ type: 'requestTroops' }, 'Request sent! Friends will send troops soon.');
  }
  async donate(requestId: string, troop: string): Promise<ActionResult> {
    return this.run({ type: 'donate', requestId, troop, count: 1 });
  }

  async raidBattle(target: number): Promise<RaidBattle | { error: string }> {
    const c = this.c;
    const p = raidPhase(c.now(), c.data);
    if (p.phase !== 'live') return { error: 'The Grove Raid is not running.' };
    const enemy = enemyGrove(c.state.grove.seed, p.week, hallLevel(c.state, c.data), c.data);
    const base = enemy.bases[target];
    if (!base) return { error: 'No such enemy base.' };
    const done = c.state.grove.raid?.week === p.week ? c.state.grove.raid.attacks.length : 0;
    const setup: BattleSetup = { seed: mixSeed(c.state.grove.seed, p.week * 1000 + target + done * 97 + 1), base, army: battleArmy(c.state), levels: troopLevels(c.state, c.data) };
    return { setup, enemyName: enemy.name, finish: (deployments, endTick) => c.finishGroveBattle(target, setup, deployments, endTick, base.name) };
  }
}

// -------------------------------------------------------------------- remote

const ONLINE_WINDOW_MS = 10 * 60_000;

/** A real Grove on the multiplayer server. Village-side effects (troops, XP) go through commands. */
export class RemoteGroveSource implements GroveSource {
  readonly kind = 'online' as const;
  private readonly listeners = new Set<() => void>();
  private loaded = false;
  private error: string | null = null;
  private grove: GroveView | null = null;
  private listings: GroveSummary[] = [];
  private chatRows: ChatView[] = [];
  private cursor: string | undefined;
  private reqs: RequestView[] = [];
  private nextRequestAt = 0;
  private raidView: RaidView | null = null;

  constructor(
    private readonly c: GameController,
    private readonly conn: Connection,
  ) {}

  private get port() {
    if (!this.conn.port) throw new Error('No server configured.');
    return this.conn.port;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: () => void): () => void {
    const a = sub(this.listeners, fn);
    const b = this.c.subscribe(fn);
    return () => {
      a();
      b();
    };
  }

  /** Reload everything (or just the fast-changing parts). */
  async refresh(full = true): Promise<void> {
    try {
      if (!this.conn.online) await this.conn.sync();
      if (!this.conn.online) throw new Error(this.conn.lastError || 'Cannot reach the server right now.');
      if (full || !this.grove) {
        this.grove = await this.port.myGrove();
        if (!this.grove) {
          this.chatRows = [];
          this.cursor = undefined;
          this.listings = (await this.port.listGroves()).groves;
        }
      }
      if (this.grove) {
        const ch = await this.port.chat(this.cursor);
        this.chatRows = [...this.chatRows, ...ch.messages].slice(-100);
        this.cursor = ch.cursor;
        const rq = await this.port.requests();
        this.reqs = rq.requests;
        this.nextRequestAt = rq.nextRequestAt;
        if (full || !this.raidView) this.raidView = await this.port.raid();
      }
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.loaded = true;
    this.emit();
  }

  watch(): () => void {
    void this.refresh(true);
    let n = 0;
    const timer = setInterval(() => {
      n++;
      void this.refresh(n % 5 === 0); // chat and requests every 4 s, everything every 20 s
    }, 4000);
    return () => {
      clearInterval(timer);
    };
  }

  snapshot(): GroveSnapshot {
    const s = this.c.state;
    const gd = this.c.data;
    const now = this.c.now();
    const g = this.grove;
    const meId = g?.you.id ?? this.conn.player?.id ?? '';
    const free = reinforcementCapacity(s, gd) - reinforcementHousing(s, gd);
    let ask: GroveSnapshot['ask'] = { ok: true, message: '' };
    if (reinforcementCapacity(s, gd) <= 0) ask = { ok: false, message: 'Build a Grove Lodge to receive troops.' };
    else if (free <= 0) ask = { ok: false, message: 'Your Grove Lodge is full.' };
    else if (this.reqs.some((r) => r.mine)) ask = { ok: false, message: 'Your request is still open.' };
    else if (this.nextRequestAt > now) ask = { ok: false, message: 'You can ask again soon.', readyAt: this.nextRequestAt };
    const rv = this.raidView;
    const p = raidPhase(now, gd);
    const raid: GroveRaidSnapshot = rv
      ? {
          phase: rv.phase,
          week: rv.week,
          end: rv.end,
          nextStart: rv.nextStart,
          eligible: rv.eligible,
          enemyName: rv.opponent?.name ?? null,
          bases: (rv.opponent?.members ?? []).map((m) => ({ index: m.index, name: m.name, hall: m.hallLevel, stars: rv.enemyBaseStars[m.index] ?? 0 })),
          ours: rv.ours,
          theirs: rv.theirs,
          attacksLeft: rv.attacksLeft,
        }
      : { phase: p.phase, week: p.week, end: p.end, nextStart: p.nextStart, eligible: true, enemyName: null, bases: [], ours: 0, theirs: 0, attacksLeft: 0 };
    return {
      kind: 'online',
      loading: !this.loaded,
      error: this.error,
      joined: Boolean(g),
      listings: this.listings,
      name: g?.name ?? '',
      color: g?.color ?? '#5ccf4a',
      level: groveLevel(s.grove.xp, gd),
      xp: s.grove.xp,
      maxMembers: g?.maxMembers ?? gd.social.membersMax,
      members: (g?.members ?? []).map((m) => ({ id: m.id, name: m.id === meId ? `${m.name} (you)` : m.name, role: m.role, hall: m.hallLevel, trophies: m.trophies, online: m.id === meId || now - m.lastSeenAt < ONLINE_WINDOW_MS, you: m.id === meId })),
      chat: this.chatRows.map((m) => ({ id: m.id, who: m.from ? (m.from.id === meId ? 'You' : m.from.name) : '', mine: m.from?.id === meId, text: m.text, at: m.at, kind: m.kind })),
      requests: this.reqs.filter((r) => !r.mine).map((r) => ({ id: r.id, name: r.name, size: r.size, filled: r.filled })),
      ask,
      raid,
      canLeave: Boolean(g),
    };
  }

  private async act(fn: () => Promise<unknown>, okMessage?: string): Promise<ActionResult> {
    try {
      await fn();
      return { ok: true, message: okMessage };
    } catch (e) {
      return { ok: false, message: e instanceof ServerError || e instanceof Error ? e.message : String(e) };
    } finally {
      await this.refresh(true);
    }
  }

  async search(query: string): Promise<void> {
    try {
      this.listings = (await this.port.listGroves(query)).groves;
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.emit();
  }

  join(id?: string): Promise<ActionResult> {
    if (!id) return Promise.resolve({ ok: false, message: 'Pick a Grove to join.' });
    return this.act(async () => {
      await this.port.joinGrove(id);
      await this.conn.sync();
    });
  }

  create(name: string): Promise<ActionResult> {
    if (name.trim().length < 2) return Promise.resolve({ ok: false, message: 'Give your Grove a name.' });
    return this.act(async () => {
      await this.port.createGrove(name);
      await this.conn.sync();
    });
  }

  leave(): Promise<ActionResult> {
    return this.act(async () => {
      await this.port.leaveGrove();
      this.chatRows = [];
      this.cursor = undefined;
      this.raidView = null;
      await this.conn.sync();
    });
  }

  send(text: string): Promise<ActionResult> {
    if (!text.trim()) return Promise.resolve({ ok: false, message: 'Type a message first.' });
    return this.act(() => this.port.postChat(text));
  }

  ask(): Promise<ActionResult> {
    const s = this.c.state;
    const free = reinforcementCapacity(s, this.c.data) - reinforcementHousing(s, this.c.data);
    const snap = this.snapshot();
    if (!snap.ask.ok) return Promise.resolve({ ok: false, message: snap.ask.message });
    return this.act(() => this.port.requestTroops(free), 'Request sent! Friends will send troops when they can.');
  }

  donate(requestId: string, troop: string): Promise<ActionResult> {
    const s = this.c.state;
    if ((s.army[troop] ?? 0) < 1) return Promise.resolve({ ok: false, message: 'Not enough of that troop.' });
    const level = troopLevels(s, this.c.data)[troop] ?? 1;
    return this.act(async () => {
      const r = await this.port.donate(requestId, { troop, count: 1, level });
      // The server accepted: the troop leaves our army and we earn the XP.
      this.c.dispatch({ type: 'spendDonation', troop, count: 1, xp: r.xp });
    });
  }

  async raidBattle(target: number): Promise<RaidBattle | { error: string }> {
    try {
      const t = await this.port.raidTicket(target);
      const c = this.c;
      const base: BaseLayout = t.base;
      const setup: BattleSetup = { seed: mixSeed(c.state.seed, Math.floor(c.now() / 1000) ^ target), base, army: battleArmy(c.state), levels: troopLevels(c.state, c.data) };
      const enemyName = this.raidView?.opponent?.name ?? 'Enemy Grove';
      return {
        setup,
        enemyName,
        finish: (deployments, endTick) => {
          const r = c.dispatch({ type: 'remoteGroveBattleEnd', target, record: { at: c.now(), opponentName: base.name, setup, deployments, endTick } });
          if (!r.ok) return null;
          const e = r.events.find((x) => x.kind === 'grove_attack');
          void this.conn.report('raid', { ticket: t.ticket, seed: setup.seed, army: setup.army, levels: setup.levels, deployments, endTick }).then(() => this.refresh(true));
          return e && e.kind === 'grove_attack' ? { stars: e.stars, destruction: e.destruction } : null;
        },
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}
