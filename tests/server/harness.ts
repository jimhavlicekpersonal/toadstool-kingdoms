/** Shared setup for server tests: the core on a MemoryRepo with a test clock, players as in-process clients. */
import { createCore } from '../../server/core';
import { InProcessServerAdapter } from '../../server/inProcess';
import { nodeContext } from '../../server/nodeContext';
import { MemoryRepo, type Repo } from '../../server/repo';
import { generateOpponent } from '../../src/sim/battle/basegen';
import type { BaseLayout } from '../../src/sim/battle/types';
import { defaultData } from '../../src/sim/data';
import { raidWindow } from '../../src/sim/social/groveRaid';
import type { GameData } from '../../src/sim/types';

export const HOUR = 3_600_000;

export function world(opts: { data?: GameData; repo?: Repo; start?: number } = {}) {
  const data = opts.data ?? defaultData;
  const repo = opts.repo ?? new MemoryRepo();
  let t = opts.start ?? Date.UTC(2026, 3, 6, 12);
  let seed = 1;
  // Deterministic "random" so opponent picks are repeatable.
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const ctx = nodeContext(repo, data, () => t, random);
  // Deterministic ids too (bot Groves are seeded from the Grove id), so every run is the same.
  let ids = 0;
  ctx.uuid = () => `00000000-0000-4000-8000-${(++ids).toString(16).padStart(12, '0')}`;
  const core = createCore(ctx);
  const player = async (name: string, base?: BaseLayout) => {
    const c = new InProcessServerAdapter(core);
    const reg = await c.register(name);
    if (base) await c.uploadBase({ base });
    return Object.assign(c, { id: reg.playerId });
  };
  return {
    data,
    repo,
    core,
    player,
    now: () => t,
    advance: (ms: number) => (t += ms),
    setTime: (ms: number) => (t = ms),
    /** Jump past every new-player shield. */
    pastShields: () => (t += (data.raids.newPlayerShieldHours + 1) * HOUR),
    /** Move to `hours` into the next Grove Raid. */
    intoRaid: (hours = 1) => {
      const week = Math.floor((t - data.social.groveRaid.epoch) / (7 * 24 * HOUR)) + 1;
      t = raidWindow(week, data).start + hours * HOUR;
      return week;
    },
    raidEnd: (week: number) => raidWindow(week, data).end,
  };
}

/** A real-looking base at a hall level, with some loot on every building. */
export function baseAt(hall: number, seed = hall * 11, loot = 0): BaseLayout {
  const b = generateOpponent(seed, hall, defaultData);
  if (loot) for (const x of b.buildings) x.loot = { acorns: loot, dew: loot };
  return b;
}

export const sumLoot = (b: BaseLayout, k: 'acorns' | 'dew' = 'acorns') => b.buildings.reduce((s, x) => s + (x.loot?.[k] ?? 0), 0);

/** A small hedgehog rush along one edge. */
export function rush(n = 20) {
  return { army: { hedgehog_roller: n }, deployments: Array.from({ length: n }, (_, i) => ({ tick: i, troop: 'hedgehog_roller', x: 1, y: 1 + (i % 30) })) };
}
