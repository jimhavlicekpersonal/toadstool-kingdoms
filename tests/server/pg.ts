/**
 * Postgres for tests. Set TEST_DATABASE_URL (e.g. postgres://postgres@localhost:5432/tk_test)
 * to run the repo and server-core suites against PgRepo as well as MemoryRepo.
 * Each repo gets its own fresh schema, so tests never see each other's rows.
 */
import { readFileSync } from 'node:fs';
import { afterAll } from 'vitest';
import pg from 'pg';
import { PgRepo } from '../../server/pgRepo';
import { MemoryRepo, type Repo } from '../../server/repo';

const url = process.env.TEST_DATABASE_URL;
const schemaSql = readFileSync(new URL('../../server/schema.sql', import.meta.url), 'utf8');
const pools: pg.Pool[] = [];
let n = 0;

afterAll(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

export async function freshPgRepo(): Promise<PgRepo> {
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  const schema = `t_${process.pid}_${Date.now().toString(36)}_${n++}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 });
  pools.push(pool);
  const repo = new PgRepo(pool);
  await repo.migrate(schemaSql);
  return repo;
}

/** Every storage adapter to test: memory always, Postgres when configured. */
export const repoFactories: [string, () => Promise<Repo>][] = [['memory', async () => new MemoryRepo()], ...(url ? ([['postgres', freshPgRepo]] as [string, () => Promise<Repo>][]) : [])];

export { schemaSql };
