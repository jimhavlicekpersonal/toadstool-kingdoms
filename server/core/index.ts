/**
 * The server core: every multiplayer rule, independent of HTTP and of the
 * database. server/app.ts puts it behind HTTP; server/inProcess.ts calls it
 * directly. A future server can reuse it with other adapters.
 */
import type { ServerContext } from './context';
import * as groves from './groves';
import * as groveRaid from './groveRaid';
import * as identity from './identity';
import * as pvp from './pvp';

export type { ServerContext } from './context';
export { ApiError } from './context';

export function createCore(ctx: ServerContext) {
  return {
    ctx,
    hello: () => identity.hello(ctx),
    register: (name: unknown) => identity.register(ctx, name),
    authenticate: (token: string | undefined) => identity.authenticate(ctx, token),
    me: identity.playerView,
    rename: identity.rename.bind(null, ctx),
    uploadBase: pvp.uploadBase.bind(null, ctx),
    match: pvp.match.bind(null, ctx),
    attack: pvp.attack.bind(null, ctx),
    defenses: pvp.defenses.bind(null, ctx),
    leaderboard: pvp.leaderboard.bind(null, ctx),
    listGroves: groves.listGroves.bind(null, ctx),
    createGrove: groves.createGrove.bind(null, ctx),
    joinGrove: groves.joinGrove.bind(null, ctx),
    leaveGrove: groves.leaveGrove.bind(null, ctx),
    myGrove: groves.myGrove.bind(null, ctx),
    chat: groves.chat.bind(null, ctx),
    postChat: groves.postChat.bind(null, ctx),
    requests: groves.requests.bind(null, ctx),
    requestTroops: groves.requestTroops.bind(null, ctx),
    donate: groves.donate.bind(null, ctx),
    inbox: groves.inbox.bind(null, ctx),
    ackInbox: groves.ackInbox.bind(null, ctx),
    raid: groveRaid.raid.bind(null, ctx),
    raidTicket: groveRaid.raidTicket.bind(null, ctx),
    raidAttack: groveRaid.raidAttack.bind(null, ctx),
    claimRaid: groveRaid.claimRaid.bind(null, ctx),
  };
}

export type ServerCore = ReturnType<typeof createCore>;
