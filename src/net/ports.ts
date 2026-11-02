/**
 * Ports: what the game needs from a multiplayer server, as plain async
 * interfaces. The game only talks to these. Adapters implement them:
 *   - HttpServerAdapter (src/net/httpAdapter.ts): any server speaking the
 *     protocol in protocol.ts over HTTPS (ours, or a future one).
 *   - InProcessServerAdapter (server/inProcess.ts): calls our server core
 *     directly, for tests and local sandboxes.
 */
import type {
  AttackResponse,
  BattleSubmission,
  ChatResponse,
  ChatView,
  DefensesResponse,
  DonateRequest,
  DonateResponse,
  ErrorCode,
  GroveView,
  GrovesResponse,
  HelloResponse,
  InboxResponse,
  LeaderboardResponse,
  MatchResponse,
  PlayerView,
  RaidAttackResponse,
  RaidClaimResponse,
  RaidTicketResponse,
  RaidView,
  RegisterResponse,
  RequestView,
  RequestsResponse,
  UploadBaseRequest,
} from './protocol';

/** A failed server call, with the protocol error code. */
export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network',
    message: string,
  ) {
    super(message);
  }
  /** Network problems and server hiccups can be retried; rule violations cannot. */
  get retryable(): boolean {
    return this.code === 'network' || this.status >= 500;
  }
}

export interface IdentityPort {
  hello(): Promise<HelloResponse>;
  register(name: string): Promise<RegisterResponse>;
  me(): Promise<PlayerView>;
  rename(name: string): Promise<PlayerView>;
}

export interface PvpPort {
  uploadBase(req: UploadBaseRequest): Promise<void>;
  /** Null when there is nobody to attack right now. */
  match(): Promise<MatchResponse | null>;
  submitAttack(sub: BattleSubmission): Promise<AttackResponse>;
  defenses(since: number): Promise<DefensesResponse>;
  leaderboard(limit?: number): Promise<LeaderboardResponse>;
}

export interface GrovePort {
  listGroves(query?: string): Promise<GrovesResponse>;
  createGrove(name: string): Promise<GroveView>;
  joinGrove(id: string): Promise<GroveView>;
  leaveGrove(): Promise<void>;
  /** Null when the player is not in a Grove. */
  myGrove(): Promise<GroveView | null>;
  chat(after?: string): Promise<ChatResponse>;
  postChat(text: string): Promise<ChatView>;
  requests(): Promise<RequestsResponse>;
  requestTroops(capacity: number): Promise<RequestView>;
  donate(requestId: string, req: DonateRequest): Promise<DonateResponse>;
  inbox(): Promise<InboxResponse>;
  ackInbox(ids: string[]): Promise<void>;
}

export interface GroveRaidPort {
  raid(): Promise<RaidView>;
  raidTicket(target: number): Promise<RaidTicketResponse>;
  submitRaidAttack(sub: BattleSubmission): Promise<RaidAttackResponse>;
  claimRaid(week: number): Promise<RaidClaimResponse>;
}

/** Everything a multiplayer server provides. */
export interface ServerPort extends IdentityPort, PvpPort, GrovePort, GroveRaidPort {
  /** Human-readable, e.g. the server URL. */
  readonly label: string;
  /** Credentials for this device's player, if registered. */
  hasIdentity(): boolean;
}
