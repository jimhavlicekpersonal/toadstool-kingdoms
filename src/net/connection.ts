/**
 * Online play: picks the server, keeps this device's player registered,
 * and brings server results into the village (real raids, donated troops,
 * Grove Raid chests) through idempotent commands. Battle reports go through a
 * persisted outbox, so a dropped connection never loses an attack.
 *
 * The game talks to the server only through a ServerPort, so any server that
 * speaks the protocol works, and tests can plug in the in-process adapter.
 */
import type { BattleRecord } from '../sim/battle/types';
import { villageToBase } from '../sim/defense';
import type { Command, CommandResult } from '../sim/village';
import type { GameData, VillageState } from '../sim/types';
import { HttpServerAdapter, normalizeServerUrl } from './httpAdapter';
import { ServerError, type ServerPort } from './ports';
import type { BattleSubmission, HelloResponse, PlayerView } from './protocol';

/** What the connection needs from the game. GameController provides it. */
export interface GameLink {
  readonly data: GameData;
  readonly state: VillageState;
  now(): number;
  dispatch(cmd: Command): CommandResult;
}

/** Small key-value storage (localStorage in the browser). */
export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export const browserKeyValue: KeyValue = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};

export type ConnectionStatus =
  /** No server configured: everything is local (generated opponents, bot raids, bot Grove). */
  | 'off'
  | 'connecting'
  | 'online'
  /** Server configured but not reachable right now; retrying. */
  | 'offline'
  /** The server and this game cannot talk (protocol versions). */
  | 'incompatible';

export interface OutboxItem {
  id: string;
  kind: 'attack' | 'raid';
  sub: BattleSubmission;
  at: number;
}

const SERVER_KEY = 'tk.net.server';
const NAME_KEY = 'tk.net.name';

/**
 * The server address: the one chosen in Settings, else the one built into
 * this version (VITE_SERVER_URL). 'off' in Settings turns online play off.
 */
export function resolveServerUrl(kv: KeyValue, builtIn: string | undefined): string {
  const chosen = kv.get(SERVER_KEY);
  if (chosen === 'off') return '';
  return normalizeServerUrl(chosen || builtIn || '');
}

export interface ConnectionOptions {
  game: GameLink;
  builtInUrl?: string;
  kv?: KeyValue;
  /** Makes the adapter for a server address (tests pass an in-process one). */
  makePort?: (url: string) => ServerPort;
  log?: (msg: string, err?: unknown) => void;
}

export class Connection {
  status: ConnectionStatus = 'off';
  /** Why the last attempt failed, for Settings. */
  lastError = '';
  server: HelloResponse | null = null;
  player: PlayerView | null = null;
  port: ServerPort | null = null;
  readonly url: string;

  private readonly kv: KeyValue;
  private readonly listeners = new Set<() => void>();
  private syncing: Promise<void> | null = null;
  private triedWeeks = new Set<number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 15_000;

  constructor(private readonly o: ConnectionOptions) {
    this.kv = o.kv ?? browserKeyValue;
    this.url = resolveServerUrl(this.kv, o.builtInUrl);
    if (this.url) {
      this.port = (o.makePort ?? ((u) => new HttpServerAdapter(u)))(this.url);
      this.status = 'connecting';
    }
  }

  /** A server is configured (real raids replace bot raids, the real Grove replaces the bot Grove). */
  get enabled(): boolean {
    return Boolean(this.port);
  }

  get online(): boolean {
    return this.status === 'online';
  }

  /** Save a server address chosen in Settings: a URL, '' for the built-in one, or 'off'. Takes effect on reload. */
  static choose(value: string, kv: KeyValue = browserKeyValue): void {
    const v = value.trim();
    kv.set(SERVER_KEY, v === 'off' ? 'off' : v ? normalizeServerUrl(v) : null);
  }

  static chosen(kv: KeyValue = browserKeyValue): string | null {
    return kv.get(SERVER_KEY);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private setStatus(s: ConnectionStatus, err = ''): void {
    this.status = s;
    this.lastError = err;
    this.emit();
  }

  private log(msg: string, err?: unknown): void {
    (this.o.log ?? ((m, e) => console.warn(m, e ?? '')))(msg, err);
  }

  /** The name other players see. */
  get name(): string {
    let n = this.kv.get(NAME_KEY) ?? this.kv.get('tk.online.name') ?? '';
    if (!n) {
      const d = this.o.game.data.names;
      n = `${d.playerFirst[Math.floor(Math.random() * d.playerFirst.length)]} ${d.playerSecond[Math.floor(Math.random() * d.playerSecond.length)]}`;
      this.kv.set(NAME_KEY, n);
    }
    return n;
  }

  async rename(name: string): Promise<void> {
    if (!this.port) return;
    this.player = await this.port.rename(name);
    this.kv.set(NAME_KEY, this.player.name);
    void this.uploadBase();
    this.emit();
  }

  /** Begin connecting, and keep in touch: light sync every minute, base upload every 2 minutes. */
  start(): void {
    if (!this.port) return;
    void this.sync();
    this.timers.push(setInterval(() => void this.sync(), 60_000));
    this.timers.push(setInterval(() => void this.uploadBase(), 120_000));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Connect if needed, then bring everything in. Concurrent calls share one run. */
  sync(): Promise<void> {
    if (!this.port || this.status === 'incompatible') return Promise.resolve();
    if (!this.syncing) {
      this.syncing = this.runSync().finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  private async runSync(): Promise<void> {
    const port = this.port!;
    const g = this.o.game;
    try {
      if (!this.online) {
        if (this.status !== 'connecting') this.setStatus('connecting');
        this.server = await port.hello();
        await this.ensurePlayer(port);
        g.dispatch({ type: 'netBind', playerId: this.player!.id });
        // The real Grove replaces the bot Grove while playing online.
        if (g.state.grove.joined) g.dispatch({ type: 'leaveLocalGrove' });
        await this.uploadBase();
        this.retryDelay = 15_000;
        this.setStatus('online');
      } else {
        this.player = await port.me(); // Grove membership may have changed
      }
      await this.pullDefenses(port);
      await this.pullDonations(port);
      await this.claimChests(port);
      await this.flush();
      this.player = await port.me();
      g.dispatch({ type: 'syncRank', trophies: this.player.trophies, shieldUntil: this.player.shieldUntil });
      this.emit();
    } catch (e) {
      this.handleError(e);
    }
  }

  private handleError(e: unknown): void {
    if (e instanceof ServerError && e.code === 'version_mismatch') {
      this.setStatus('incompatible', e.message);
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    this.log('Online play: sync failed', e);
    if (e instanceof ServerError && !e.retryable && this.online) {
      // A rule said no to one call; the connection itself is fine.
      this.lastError = msg;
      this.emit();
      return;
    }
    this.setStatus('offline', msg);
    if (!this.retryTimer && this.timers.length) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.sync();
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 5 * 60_000);
    }
  }

  private async ensurePlayer(port: ServerPort): Promise<void> {
    if (port.hasIdentity()) {
      try {
        this.player = await port.me();
        return;
      } catch (e) {
        if (!(e instanceof ServerError) || e.code !== 'unauthorized') throw e;
        // The server forgot us (new database): start a new player there.
      }
    }
    await port.register(this.name);
    this.player = await port.me();
    this.kv.set(NAME_KEY, this.player.name);
  }

  /** Share the village layout so other players can attack it. */
  async uploadBase(): Promise<void> {
    if (!this.port || !this.player) return;
    const g = this.o.game;
    try {
      await this.port.uploadBase({ base: villageToBase(g.state, g.now(), g.data, this.player.name), name: this.player.name });
    } catch (e) {
      this.log('Online play: base upload failed', e);
    }
  }

  /** Real raids against this village since the last check. */
  private async pullDefenses(port: ServerPort): Promise<void> {
    const g = this.o.game;
    const { defenses } = await port.defenses(g.state.net.defensesSince);
    if (!defenses.length) return;
    const me = await port.me();
    const known = new Set(g.state.defenseLog.map((x) => x.id));
    let added = 0;
    for (const d of defenses) {
      const record: BattleRecord = { id: d.id, at: d.at, kind: 'defense', opponentName: d.attackerName, setup: { seed: d.seed, base: d.base, army: d.army, levels: d.levels }, deployments: d.deployments, endTick: d.endTick, result: d.result, trophies: d.trophies };
      g.dispatch({ type: 'applyDefense', record, lost: d.result.loot, trophies: me.trophies, shieldUntil: me.shieldUntil });
      if (!known.has(d.id)) added++;
    }
    if (added) this.newDefenses += added;
  }

  /** Raids that arrived since the HUD last asked (for a toast). */
  newDefenses = 0;

  /** Troops friends sent: into the Grove Lodge, then acknowledged. */
  private async pullDonations(port: ServerPort): Promise<void> {
    const { donations } = await port.inbox();
    if (!donations.length) return;
    this.o.game.dispatch({ type: 'receiveDonations', items: donations });
    await port.ackInbox(donations.map((d) => d.id));
  }

  /** Grove Raid chests the server lists for this player that this village has not received yet. */
  private async claimChests(port: ServerPort): Promise<void> {
    const g = this.o.game;
    if (!this.player?.groveId) return;
    const view = await port.raid();
    for (const { week } of view.chests) {
      if (g.state.net.raidWeeks.includes(week) || this.triedWeeks.has(week)) continue;
      this.triedWeeks.add(week);
      try {
        const c = await port.claimRaid(week);
        g.dispatch({ type: 'claimRaidChest', week, outcome: c.outcome, ours: c.ours, theirs: c.theirs });
      } catch (e) {
        if (!(e instanceof ServerError) || e.retryable) {
          this.triedWeeks.delete(week);
          throw e;
        }
        // not_found: the Grove did not take part, or the player joined later.
      }
    }
  }

  // ---------------------------------------------------------------- outbox

  private get outboxKey(): string {
    return `tk.net.outbox:${this.url}`;
  }

  outbox(): OutboxItem[] {
    try {
      const v = JSON.parse(this.kv.get(this.outboxKey) ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private saveOutbox(items: OutboxItem[]): void {
    this.kv.set(this.outboxKey, items.length ? JSON.stringify(items) : null);
  }

  /** Queue a finished battle for the server and try to send it now. */
  report(kind: OutboxItem['kind'], sub: BattleSubmission): Promise<void> {
    const items = this.outbox();
    if (!items.some((i) => i.sub.ticket === sub.ticket)) items.push({ id: sub.ticket, kind, sub, at: this.o.game.now() });
    this.saveOutbox(items);
    return this.flush().catch((e) => this.handleError(e));
  }

  private flushing: Promise<void> | null = null;

  /** Send queued battles in order. Rule rejections are dropped; network trouble stops and retries later. */
  flush(): Promise<void> {
    if (!this.port) return Promise.resolve();
    if (!this.flushing) {
      this.flushing = this.runFlush().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async runFlush(): Promise<void> {
    const port = this.port!;
    for (const item of this.outbox()) {
      try {
        if (item.kind === 'attack') {
          const r = await port.submitAttack(item.sub);
          this.o.game.dispatch({ type: 'syncRank', trophies: r.playerTrophies });
        } else {
          await port.submitRaidAttack(item.sub);
        }
      } catch (e) {
        if (!(e instanceof ServerError) || e.retryable) throw e;
        this.log(`Online play: the server refused a ${item.kind} report (${e.code})`, e);
      }
      this.saveOutbox(this.outbox().filter((i) => i.id !== item.id));
    }
    this.emit();
  }
}
