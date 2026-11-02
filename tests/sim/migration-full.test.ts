import { expect, it } from 'vitest';
import { defaultData as data } from '../../src/sim/data';
import { deserialize, SAVE_VERSION } from '../../src/sim/save';
import { computeOfflineProgress } from '../../src/sim/offline';

it('a Phase 1 (v1) save loads in the latest version', () => {
  const t = Date.UTC(2026, 10, 1, 20, 0, 0);
  const v1 = {
    version: 1,
    savedAt: t,
    village: {
      createdAt: t - 3_600_000,
      lastSeenAt: t,
      resources: { acorns: 1200, dew: 900, nightsap: 0, moonstones: 0 },
      nextId: 6,
      buildings: [
        { id: 'b1', type: 'elder_toadstool', level: 2, x: 18, y: 18, upgrade: null, collector: null },
        { id: 'b2', type: 'beaver_lodge', level: 1, x: 14, y: 19, upgrade: null, collector: null },
        { id: 'b3', type: 'beaver_lodge', level: 1, x: 24, y: 19, upgrade: null, collector: null },
        { id: 'b4', type: 'acorn_orchard', level: 2, x: 22, y: 23, upgrade: { toLevel: 3, startedAt: t - 10_000, endsAt: t + 40_000, cost: { dew: 700 } }, collector: { stored: 120, accrueFrom: t + 40_000 } },
        { id: 'b5', type: 'acorn_silo', level: 1, x: 12, y: 23, upgrade: null, collector: null },
      ],
    },
  };
  const village = deserialize(JSON.parse(JSON.stringify(v1)), data);
  expect(SAVE_VERSION).toBe(10);
  expect(village.daily.lastDay).toBe(-1);
  expect(village.research).toEqual({ levels: {}, active: null });
  expect(village.scout).toBeNull();
  expect(village.net).toEqual({ playerId: null, defensesSince: 0, donations: [], raidWeeks: [] });
  expect(village.stats.upgradesDone).toBe(0);
  expect(village.buildings.filter((b) => !b.type.startsWith('obstacle_'))).toHaveLength(5);
  expect(village.tutorial.done).toBe(true); // existing players skip the tutorial
  expect(village.grove.joined).toBe(false);
  expect(village.trophies).toBe(0);
  // Coming back a day later works: timers finish, collectors fill, raids may happen.
  const { state, summary } = computeOfflineProgress(village, t + 24 * 3_600_000, data);
  expect(state.buildings.find((b) => b.id === 'b4')!.level).toBe(3);
  expect(summary.awayMs).toBe(24 * 3_600_000);
});
