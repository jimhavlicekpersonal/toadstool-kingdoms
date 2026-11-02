/**
 * The Toadstool Kingdoms multiplayer protocol: every request and response the
 * game exchanges with a server. Our server (server/) implements it, and so must
 * any future server. tests/contract/ checks an implementation against it, and
 * docs/PROTOCOL.md describes it in prose.
 *
 * Plain JSON over HTTPS. Auth is a bearer token from POST /v1/players.
 * Errors: HTTP status + { error: ErrorCode, message }.
 * Pure types and constants only (shared by browser and Node).
 */
import type { BaseLayout, BattleResult, Deployment } from '../sim/battle/types';

/** Bump when a change would break older clients; servers report the oldest they accept. */
export const PROTOCOL_VERSION = 2;

export type ErrorCode =
  | 'unauthorized'
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'expired'
  | 'cooldown'
  | 'full'
  | 'not_in_grove'
  | 'already_in_grove'
  | 'raid_not_live'
  | 'raid_not_ended'
  | 'no_attacks_left'
  | 'no_opponents'
  | 'version_mismatch';

export interface ErrorBody {
  error: ErrorCode;
  message: string;
}

export const Routes = {
  hello: '/v1/hello',
  players: '/v1/players',
  me: '/v1/me',
  base: '/v1/base',
  match: '/v1/match',
  attacks: '/v1/attacks',
  defenses: '/v1/defenses',
  leaderboard: '/v1/leaderboard',
  groves: '/v1/groves',
  groveJoin: (id: string) => `/v1/groves/${encodeURIComponent(id)}/join`,
  grove: '/v1/grove',
  groveLeave: '/v1/grove/leave',
  groveChat: '/v1/grove/chat',
  groveRequests: '/v1/grove/requests',
  groveDonate: (id: string) => `/v1/grove/requests/${encodeURIComponent(id)}/donate`,
  groveInbox: '/v1/grove/inbox',
  groveInboxAck: '/v1/grove/inbox/ack',
  groveRaid: '/v1/grove/raid',
  groveRaidTicket: '/v1/grove/raid/ticket',
  groveRaidAttacks: '/v1/grove/raid/attacks',
  groveRaidClaim: '/v1/grove/raid/claim',
} as const;

// ---------------------------------------------------------------- identity

export interface HelloResponse {
  name: 'toadstool-kingdoms';
  protocol: number;
  /** Oldest client protocol this server still accepts. */
  minProtocol: number;
  /** Server clock (epoch ms), so all players agree on Grove Raid times. */
  serverTime: number;
  features: string[];
}

export interface RegisterRequest {
  name: string;
}
export interface RegisterResponse {
  playerId: string;
  token: string;
}

export interface PlayerView {
  id: string;
  name: string;
  trophies: number;
  hallLevel: number;
  shieldUntil: number;
  groveId: string | null;
}

export interface RenameRequest {
  name: string;
}

// ---------------------------------------------------------------- PvP

export interface UploadBaseRequest {
  base: BaseLayout;
  name?: string;
}

export interface OpponentView {
  name: string;
  trophies: number;
  hallLevel: number;
  /** A real player's base, or a server-generated one when nobody fits. */
  kind: 'player' | 'bot';
}

export interface MatchResponse {
  ticket: string;
  /** The base to attack, loot already reduced by the attacker's loot penalty. */
  base: BaseLayout;
  opponent: OpponentView;
  /** The attack must be submitted before this time. */
  expiresAt: number;
}

/** The battle a client played; the server re-runs it from seed + deployments. */
export interface BattleSubmission {
  ticket: string;
  seed: number;
  army: Record<string, number>;
  levels?: Record<string, number>;
  deployments: Deployment[];
  endTick?: number;
}

export interface AttackResponse {
  attackId: string;
  result: BattleResult;
  /** Trophy change for the attacker. */
  trophies: number;
  /** The attacker's trophies after the attack. */
  playerTrophies: number;
}

export interface DefenseView {
  id: string;
  at: number;
  attackerName: string;
  seed: number;
  army: Record<string, number>;
  levels: Record<string, number>;
  base: BaseLayout;
  deployments: Deployment[];
  endTick?: number;
  result: BattleResult;
  /** Trophy change for the defender. */
  trophies: number;
}

export interface DefensesResponse {
  defenses: DefenseView[];
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  trophies: number;
  hallLevel: number;
  grove: string | null;
}
export interface LeaderboardResponse {
  players: LeaderboardEntry[];
  me: { rank: number; trophies: number } | null;
}

// ---------------------------------------------------------------- Groves

export interface GroveSummary {
  id: string;
  name: string;
  color: string;
  members: number;
  maxMembers: number;
  averageTrophies: number;
}
export interface GrovesResponse {
  groves: GroveSummary[];
}

export interface CreateGroveRequest {
  name: string;
}

export type GroveRole = 'Leader' | 'Elder' | 'Member';

export interface MemberView {
  id: string;
  name: string;
  role: GroveRole;
  trophies: number;
  hallLevel: number;
  lastSeenAt: number;
  /** Grove XP from donations. */
  xp: number;
}

export interface GroveView {
  id: string;
  name: string;
  color: string;
  maxMembers: number;
  members: MemberView[];
  you: { id: string; role: GroveRole; xp: number };
}

/** GET /v1/grove: the player's Grove, or null when they are not in one. */
export interface MyGroveResponse {
  grove: GroveView | null;
}

export interface ChatView {
  id: string;
  at: number;
  /** Null for system messages. */
  from: { id: string; name: string } | null;
  text: string;
  kind: 'chat' | 'request' | 'donation' | 'system';
}

export interface ChatResponse {
  messages: ChatView[];
  /** Pass back as ?after= to get only newer messages. */
  cursor: string;
}

export interface PostChatRequest {
  text: string;
}

export interface RequestView {
  id: string;
  at: number;
  playerId: string;
  name: string;
  /** Housing space asked for and filled so far. */
  size: number;
  filled: number;
  mine: boolean;
}

export interface RequestsResponse {
  requests: RequestView[];
  /** When the player may ask again (0 = now). */
  nextRequestAt: number;
}

export interface CreateRequestRequest {
  /** Free housing in the requester's Grove Lodge. */
  capacity: number;
}

export interface DonateRequest {
  troop: string;
  count: number;
  level: number;
}

export interface DonateResponse {
  request: RequestView;
  xp: number;
}

export interface DonationView {
  id: string;
  at: number;
  fromName: string;
  troop: string;
  count: number;
  level: number;
}

export interface InboxResponse {
  donations: DonationView[];
}

export interface AckRequest {
  ids: string[];
}

// ---------------------------------------------------------------- Grove Raid

export interface RaidMemberView {
  index: number;
  name: string;
  hallLevel: number;
  trophies: number;
}

export interface RaidView {
  phase: 'upcoming' | 'live' | 'ended';
  week: number;
  start: number;
  end: number;
  nextStart: number;
  /** False when the player joined their Grove after this raid started (they take part from next week). */
  eligible: boolean;
  opponent: { name: string; kind: 'grove' | 'bot'; members: RaidMemberView[] } | null;
  ours: number;
  theirs: number;
  /** Best stars so far on each enemy base (by index). */
  enemyBaseStars: number[];
  attacksLeft: number;
  result: { outcome: 'win' | 'draw' | 'loss'; ours: number; theirs: number } | null;
  /** The player already collected this week's chest. */
  claimed: boolean;
  /**
   * Ended Grove Raids (this week and last week) the player took part in, and
   * whether their chest was claimed. Claiming again is safe and returns the
   * same outcome, so a client that lost a claim answer can recover it.
   */
  chests: { week: number; claimed: boolean }[];
}

export interface RaidTicketRequest {
  target: number;
}
export interface RaidTicketResponse {
  ticket: string;
  base: BaseLayout;
  expiresAt: number;
}

export interface RaidAttackResponse {
  result: BattleResult;
  stars: number;
  ours: number;
  theirs: number;
}

export interface RaidClaimRequest {
  week: number;
}
export interface RaidClaimResponse {
  week: number;
  outcome: 'win' | 'draw' | 'loss';
  /** Final stars for each side. */
  ours: number;
  theirs: number;
  /** True when this claim was already made (safe to retry). */
  alreadyClaimed: boolean;
}
