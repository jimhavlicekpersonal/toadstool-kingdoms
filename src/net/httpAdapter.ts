/**
 * HTTP adapter for the ServerPort: talks to any server that speaks the
 * protocol in protocol.ts (ours in server/, or a future one). Handles the
 * bearer token, timeouts, retries for safe reads, and protocol errors.
 */
import { ServerError, type ServerPort } from './ports';
import {
  PROTOCOL_VERSION,
  Routes,
  type AttackResponse,
  type BattleSubmission,
  type ChatResponse,
  type ChatView,
  type DefensesResponse,
  type DonateRequest,
  type DonateResponse,
  type ErrorBody,
  type GroveView,
  type GrovesResponse,
  type HelloResponse,
  type InboxResponse,
  type LeaderboardResponse,
  type MatchResponse,
  type MyGroveResponse,
  type PlayerView,
  type RaidAttackResponse,
  type RaidClaimResponse,
  type RaidTicketResponse,
  type RaidView,
  type RegisterResponse,
  type RequestView,
  type RequestsResponse,
  type UploadBaseRequest,
} from './protocol';

/** Where this device keeps its player token for a server. */
export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
}

/** localStorage, one token per server address (a token is never sent to a different server). */
export function localTokenStore(serverUrl: string): TokenStore {
  const key = `tk.net.token:${serverUrl}`;
  return {
    get() {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(token) {
      try {
        if (token) localStorage.setItem(key, token);
        else localStorage.removeItem(key);
      } catch {
        /* private mode: the token lasts for this session only */
      }
    },
  };
}

export function memoryTokenStore(initial: string | null = null): TokenStore {
  let t = initial;
  return { get: () => t, set: (v) => (t = v) };
}

export interface HttpAdapterOptions {
  tokens?: TokenStore;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra attempts for GET requests that fail with a network or server error. */
  retries?: number;
  /** Wait between retries (tests set 0). */
  retryDelayMs?: number;
}

/** Normalise a server address typed by a player: adds https://, drops a trailing slash. */
export function normalizeServerUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `${/^(localhost|127\.|192\.168\.|10\.)/.test(s) ? 'http' : 'https'}://${s}`;
  return s.replace(/\/+$/, '');
}

export class HttpServerAdapter implements ServerPort {
  readonly label: string;
  private readonly tokens: TokenStore;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(
    readonly baseUrl: string,
    opts: HttpAdapterOptions = {},
  ) {
    this.baseUrl = normalizeServerUrl(baseUrl);
    this.label = this.baseUrl;
    this.tokens = opts.tokens ?? localTokenStore(this.baseUrl);
    this.fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 600;
  }

  hasIdentity(): boolean {
    return Boolean(this.tokens.get());
  }

  /** Forget this device's player on this server (a new one is made on the next register). */
  forgetIdentity(): void {
    this.tokens.set(null);
  }

  private async once<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.tokens.get();
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl?.signal,
      });
    } catch (e) {
      throw new ServerError(0, 'network', ctrl?.signal.aborted ? 'The server took too long to answer.' : `Could not reach the server (${(e as Error)?.message ?? e}).`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json ?? {}) as Partial<ErrorBody>;
      throw new ServerError(res.status, err.error ?? (res.status >= 500 ? 'network' : 'bad_request'), err.message ?? `Server answered ${res.status}.`);
    }
    return json as T;
  }

  private async req<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.once<T>(method, path, body);
      } catch (e) {
        // Only reads are retried here; writes are made safe by tickets and the outbox.
        if (method !== 'GET' || !(e instanceof ServerError) || !e.retryable || attempt >= this.retries) throw e;
        attempt++;
        if (this.retryDelayMs) await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
      }
    }
  }

  private async orNull<T>(p: Promise<T>, code: string): Promise<T | null> {
    try {
      return await p;
    } catch (e) {
      if (e instanceof ServerError && e.code === code) return null;
      throw e;
    }
  }

  // ---------------------------------------------------------------- identity

  /** The server's description; throws version_mismatch when this game and the server cannot talk. */
  async hello(): Promise<HelloResponse> {
    const h = await this.req<HelloResponse>('GET', Routes.hello);
    if (!h || h.name !== 'toadstool-kingdoms') throw new ServerError(0, 'version_mismatch', 'That address is not a Toadstool Kingdoms server.');
    if (h.minProtocol > PROTOCOL_VERSION) throw new ServerError(0, 'version_mismatch', 'This server needs a newer version of the game. Update the game.');
    if (h.protocol < PROTOCOL_VERSION) throw new ServerError(0, 'version_mismatch', 'This server is older than the game and cannot be used yet.');
    return h;
  }

  async register(name: string): Promise<RegisterResponse> {
    const r = await this.req<RegisterResponse>('POST', Routes.players, { name });
    this.tokens.set(r.token);
    return r;
  }

  me(): Promise<PlayerView> {
    return this.req('GET', Routes.me);
  }

  rename(name: string): Promise<PlayerView> {
    return this.req('PUT', Routes.me, { name });
  }

  // ---------------------------------------------------------------- PvP

  uploadBase(req: UploadBaseRequest): Promise<void> {
    return this.req('PUT', Routes.base, req);
  }

  match(): Promise<MatchResponse | null> {
    return this.orNull(this.req<MatchResponse>('GET', Routes.match), 'no_opponents');
  }

  submitAttack(sub: BattleSubmission): Promise<AttackResponse> {
    return this.req('POST', Routes.attacks, sub);
  }

  defenses(since: number): Promise<DefensesResponse> {
    return this.req('GET', `${Routes.defenses}?since=${Math.floor(since)}`);
  }

  leaderboard(limit = 50): Promise<LeaderboardResponse> {
    return this.req('GET', `${Routes.leaderboard}?limit=${limit}`);
  }

  // ---------------------------------------------------------------- Groves

  listGroves(query = ''): Promise<GrovesResponse> {
    return this.req('GET', query ? `${Routes.groves}?q=${encodeURIComponent(query)}` : Routes.groves);
  }

  createGrove(name: string): Promise<GroveView> {
    return this.req('POST', Routes.groves, { name });
  }

  joinGrove(id: string): Promise<GroveView> {
    return this.req('POST', Routes.groveJoin(id), {});
  }

  leaveGrove(): Promise<void> {
    return this.req('POST', Routes.groveLeave, {});
  }

  async myGrove(): Promise<GroveView | null> {
    return (await this.req<MyGroveResponse>('GET', Routes.grove)).grove;
  }

  chat(after?: string): Promise<ChatResponse> {
    return this.req('GET', after ? `${Routes.groveChat}?after=${encodeURIComponent(after)}` : Routes.groveChat);
  }

  postChat(text: string): Promise<ChatView> {
    return this.req('POST', Routes.groveChat, { text });
  }

  requests(): Promise<RequestsResponse> {
    return this.req('GET', Routes.groveRequests);
  }

  requestTroops(capacity: number): Promise<RequestView> {
    return this.req('POST', Routes.groveRequests, { capacity });
  }

  donate(requestId: string, req: DonateRequest): Promise<DonateResponse> {
    return this.req('POST', Routes.groveDonate(requestId), req);
  }

  inbox(): Promise<InboxResponse> {
    return this.req('GET', Routes.groveInbox);
  }

  ackInbox(ids: string[]): Promise<void> {
    return this.req('POST', Routes.groveInboxAck, { ids });
  }

  // ---------------------------------------------------------------- Grove Raid

  raid(): Promise<RaidView> {
    return this.req('GET', Routes.groveRaid);
  }

  raidTicket(target: number): Promise<RaidTicketResponse> {
    return this.req('POST', Routes.groveRaidTicket, { target });
  }

  submitRaidAttack(sub: BattleSubmission): Promise<RaidAttackResponse> {
    return this.req('POST', Routes.groveRaidAttacks, sub);
  }

  claimRaid(week: number): Promise<RaidClaimResponse> {
    return this.req('POST', Routes.groveRaidClaim, { week });
  }
}
