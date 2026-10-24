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

export async function testApp(env: Record<string, string> = {}, opts: { purenetEnv?: NodeJS.ProcessEnv; clock?: () => Date } = {}) {
  const db = testDb();
  const config = loadConfig({ NODE_ENV: 'test', PE_DATABASE_URL: TEST_DATABASE_URL, PE_LOGIN_RATE_LIMIT: '1000', PE_DISPATCH_INTERVAL_MS: '0', PE_PUBLIC_URL: 'https://engage.example.com', ...env });
  const app = await buildApp({ config, db, ...opts });
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

const SYSTEM = { type: 'system' as const };

export async function makeContact(app: FastifyInstance, input: Record<string, unknown>) {
  return (await app.services.contacts.upsert(input, { source: 'test', actor: SYSTEM })).contact;
}

export async function makeTemplate(app: FastifyInstance, input: Record<string, unknown>) {
  return app.services.templates.create(input, SYSTEM);
}

export const emailTemplate = (over: Record<string, unknown> = {}) => ({
  name: 'Appointment confirmation', channel: 'email', purpose: 'care',
  content: {
    en: { subject: 'Your appointment, {{ contact.first_name }}', html: '<p>Hello {{ contact.first_name }}, see you on {{ data.date }}.</p><p><a href="https://example.com/appointments?id=1&src=email">Manage</a></p>' },
    ar: { subject: 'موعدك يا {{ contact.first_name }}', html: '<p>مرحبًا {{ contact.first_name }}، نراك في {{ data.date }}.</p>' },
  },
  ...over,
});

export const smsTemplate = (over: Record<string, unknown> = {}) => ({
  name: 'Reminder SMS', channel: 'sms', purpose: 'care',
  content: { en: { body: 'Hi {{ contact.first_name }}, reminder: appointment {{ data.date }}.' }, ar: { body: 'مرحبًا {{ contact.first_name }}، تذكير بموعدك {{ data.date }}.' } },
  ...over,
});
