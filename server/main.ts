/** Server entry point. Env: PORT, DATABASE_URL (Postgres; memory if unset), CORS_ORIGIN ('*' or a comma-separated list of origins). */
import { defaultData } from '../src/sim/data';
import { buildServer } from './app';
import schema from './schema.sql?raw';
import { PgRepo } from './pgRepo';
import { MemoryRepo, type Repo } from './repo';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  let repo: Repo;
  if (url) {
    const pg = PgRepo.fromUrl(url);
    await pg.migrate(schema); // creates tables if they do not exist yet
    repo = pg;
  } else {
    console.warn('DATABASE_URL not set: using in-memory storage (data is lost on restart).');
    repo = new MemoryRepo();
  }
  const app = buildServer({ repo, data: defaultData, corsOrigin: process.env.CORS_ORIGIN, logger: true });
  const port = Number(process.env.PORT ?? 8787);
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
