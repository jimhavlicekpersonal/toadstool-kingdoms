/** The server core's environment on Node: real clock, crypto ids and tokens, SHA-256 token hashes. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { GameData } from '../src/sim/types';
import type { ServerContext } from './core';
import type { Repo } from './repo';

export function nodeContext(repo: Repo, data: GameData, now: () => number = () => Date.now(), random: () => number = Math.random): ServerContext {
  return {
    repo,
    data,
    now,
    uuid: () => randomUUID(),
    newToken: () => randomBytes(24).toString('base64url'),
    hash: async (token) => createHash('sha256').update(token).digest('hex'),
    random,
  };
}
