import { sql } from 'kysely';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createDb, type DB } from '../src/db/index.ts';
import type { Role } from '../src/db/schema.ts';
import { TEST_DATABASE_URL } from './global-setup.ts';

export const PASSWORD = 'correct-horse-battery';

export function testDb(): DB {
  return createDb(TEST_DATABASE_URL, { max: 4 });
}

export async function testApp(env: Record<string, string> = {}, purenetEnv?: NodeJS.ProcessEnv) {
  const db = testDb();
  const config = loadConfig({ NODE_ENV: 'test', PE_DATABASE_URL: TEST_DATABASE_URL, PE_LOGIN_RATE_LIMIT: '1000', ...env });
  const app = await buildApp({ config, db, ...(purenetEnv ? { purenetEnv } : {}) });
  return { app, db, close: async () => { await app.close(); await db.destroy(); } };
}

// Empties every application table (keeps the migration bookkeeping).
export async function truncateAll(db: DB): Promise<void> {
  const { rows } = await sql<{ tablename: string }>`
    select tablename from pg_tables where schemaname = 'public' and tablename not like 'kysely_%'`.execute(db);
  if (rows.length) await sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(', ')} restart identity cascade`).execute(db);
}

/** Creates a user directly and logs in; returns a request helper that sends the session cookie + CSRF header. */
export async function loginAs(app: FastifyInstance, role: Role, email = `${role}@example.com`) {
  await app.services.auth.createUser({ email, password: PASSWORD, role }, { type: 'system' });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-pe-csrf': '1' }, payload: { email, password: PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'pe_session')!;
  const userId = (res.json() as { user: { id: string } }).user.id;
  const request = (opts: InjectOptions) =>
    app.inject({ ...opts, headers: { 'x-pe-csrf': '1', ...opts.headers, cookie: `pe_session=${cookie.value}` } });
  return { request, cookie: cookie.value, userId };
}

export async function apiKey(app: FastifyInstance): Promise<string> {
  return (await app.services.auth.createApiKey('test', { type: 'system' })).key;
}
