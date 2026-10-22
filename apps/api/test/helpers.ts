import { sql } from 'kysely';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createDb, type DB } from '../src/db/index.ts';
import { TEST_DATABASE_URL } from './global-setup.ts';

export function testDb(): DB {
  return createDb(TEST_DATABASE_URL, { max: 4 });
}

export async function testApp(db: DB = testDb()) {
  const config = loadConfig({ NODE_ENV: 'test', PE_DATABASE_URL: TEST_DATABASE_URL });
  const app = await buildApp({ config, db });
  return { app, db, close: async () => { await app.close(); await db.destroy(); } };
}

// Empties every application table (keeps the migration bookkeeping).
export async function truncateAll(db: DB): Promise<void> {
  const { rows } = await sql<{ tablename: string }>`
    select tablename from pg_tables where schemaname = 'public' and tablename not like 'kysely_%'`.execute(db);
  if (rows.length) await sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(', ')} restart identity cascade`).execute(db);
}
