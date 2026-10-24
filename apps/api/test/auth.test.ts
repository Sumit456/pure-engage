import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { PASSWORD, loginAs, testApp, truncateAll } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => { ctx = await testApp(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await truncateAll(ctx.db); });

const login = (email: string, password: string, headers: Record<string, string> = { 'x-pe-csrf': '1' }) =>
  ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { email, password } });

describe('login', () => {
  test('sets an httpOnly SameSite=Lax session cookie and returns the user', async () => {
    await ctx.app.services.auth.createUser({ email: 'Admin@Example.com', password: PASSWORD, role: 'admin' }, { type: 'system' });
    const res = await login('admin@example.com', PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: 'admin@example.com', role: 'admin' });
    const cookie = res.cookies.find((c) => c.name === 'pe_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    const stored = await ctx.db.selectFrom('sessions').select('token_hash').executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toBe(cookie.value); // only the hash is stored
  });

  test('wrong password and unknown user both give the same 401 and are audited', async () => {
    await ctx.app.services.auth.createUser({ email: 'a@example.com', password: PASSWORD, role: 'admin' }, { type: 'system' });
    const wrong = await login('a@example.com', 'nope-nope-nope');
    const unknown = await login('ghost@example.com', PASSWORD);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
    const failures = await ctx.db.selectFrom('audit_log').select('details').where('action', '=', 'auth.login_failed').execute();
    expect(failures.map((f) => f.details.reason).sort()).toEqual(['bad_password', 'unknown_user']);
  });

  test('requires the CSRF header', async () => {
    expect((await login('a@example.com', PASSWORD, {})).statusCode).toBe(403);
  });

  test('inactive users cannot log in', async () => {
    const u = await ctx.app.services.auth.createUser({ email: 'b@example.com', password: PASSWORD, role: 'viewer' }, { type: 'system' });
    await ctx.db.updateTable('users').set({ active: false }).where('id', '=', u.id).execute();
    expect((await login('b@example.com', PASSWORD)).statusCode).toBe(401);
  });

  test('is rate limited per IP', async () => {
    const limited = await testApp({ PE_LOGIN_RATE_LIMIT: '3' });
    try {
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await limited.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-pe-csrf': '1' }, payload: { email: 'x@example.com', password: 'whatever-pass' } })).statusCode);
      expect(codes).toEqual([401, 401, 401, 429]);
    } finally { await limited.close(); }
  });
});

describe('sessions', () => {
  test('me, then logout ends the session', async () => {
    const { request } = await loginAs(ctx.app, 'viewer');
    expect((await request({ method: 'GET', url: '/api/auth/me' })).json().user.role).toBe('viewer');
    expect((await request({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(204);
    expect((await request({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
  });

  test('idle timeout and absolute expiry both end the session', async () => {
    const a = await loginAs(ctx.app, 'viewer', 'idle@example.com');
    await ctx.db.updateTable('sessions').set({ last_seen_at: new Date(Date.now() - 31 * 60_000) }).execute();
    expect((await a.request({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);

    const b = await loginAs(ctx.app, 'viewer', 'old@example.com');
    await ctx.db.updateTable('sessions').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    expect((await b.request({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    expect(await ctx.db.selectFrom('sessions').selectAll().execute()).toEqual([]);
  });

  test('a session cookie without the CSRF header cannot change state', async () => {
    const { cookie } = await loginAs(ctx.app, 'marketer');
    const res = await ctx.app.inject({ method: 'POST', url: '/api/contacts', headers: { cookie: `pe_session=${cookie}` }, payload: { external_id: 'X' } });
    expect(res.statusCode).toBe(403);
  });

  test('changing your password keeps this session and ends the others', async () => {
    const first = await loginAs(ctx.app, 'marketer', 'm@example.com');
    const second = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-pe-csrf': '1' }, payload: { email: 'm@example.com', password: PASSWORD } });
    const otherCookie = second.cookies.find((c) => c.name === 'pe_session')!.value;

    const bad = await first.request({ method: 'POST', url: '/api/auth/password', payload: { current_password: 'wrong', new_password: 'new-password-123' } });
    expect(bad.statusCode).toBe(400);
    const short = await first.request({ method: 'POST', url: '/api/auth/password', payload: { current_password: PASSWORD, new_password: 'short' } });
    expect(short.statusCode).toBe(400);
    const ok = await first.request({ method: 'POST', url: '/api/auth/password', payload: { current_password: PASSWORD, new_password: 'new-password-123' } });
    expect(ok.statusCode).toBe(204);

    expect((await first.request({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `pe_session=${otherCookie}` } })).statusCode).toBe(401);
  });
});

describe('roles and user admin', () => {
  test('viewer reads, marketer writes, admin manages users', async () => {
    const viewer = await loginAs(ctx.app, 'viewer');
    const marketer = await loginAs(ctx.app, 'marketer');
    const admin = await loginAs(ctx.app, 'admin');

    expect((await viewer.request({ method: 'GET', url: '/api/contacts' })).statusCode).toBe(200);
    expect((await viewer.request({ method: 'POST', url: '/api/contacts', payload: { external_id: 'MBR-TEST-1' } })).statusCode).toBe(403);
    expect((await marketer.request({ method: 'POST', url: '/api/contacts', payload: { external_id: 'MBR-TEST-1' } })).statusCode).toBe(201);
    expect((await marketer.request({ method: 'GET', url: '/api/users' })).statusCode).toBe(403);
    expect((await admin.request({ method: 'GET', url: '/api/users' })).json().data).toHaveLength(3);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/contacts' })).statusCode).toBe(401);
  });

  test('admin creates and updates users; password hashes never leave the API', async () => {
    const admin = await loginAs(ctx.app, 'admin');
    const created = await admin.request({ method: 'POST', url: '/api/users', payload: { email: 'New@Example.com', name: 'New', role: 'marketer', password: 'long-enough-pw' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).not.toHaveProperty('password_hash');
    expect(created.json().email).toBe('new@example.com');

    const dupe = await admin.request({ method: 'POST', url: '/api/users', payload: { email: 'new@example.com', role: 'viewer', password: 'long-enough-pw' } });
    expect(dupe.statusCode).toBe(409);

    const updated = await admin.request({ method: 'PATCH', url: `/api/users/${created.json().id}`, payload: { role: 'viewer' } });
    expect(updated.json().role).toBe('viewer');
    const audit = await ctx.db.selectFrom('audit_log').select(['action', 'details']).where('entity_id', '=', created.json().id).orderBy('id').execute();
    expect(audit.map((a) => a.action)).toEqual(['user.create', 'user.update']);
  });

  test('the last active admin cannot be demoted or deactivated', async () => {
    const admin = await loginAs(ctx.app, 'admin');
    expect((await admin.request({ method: 'PATCH', url: `/api/users/${admin.userId}`, payload: { role: 'viewer' } })).statusCode).toBe(409);
    expect((await admin.request({ method: 'PATCH', url: `/api/users/${admin.userId}`, payload: { active: false } })).statusCode).toBe(409);
  });

  test('deactivating a user ends their sessions immediately', async () => {
    const admin = await loginAs(ctx.app, 'admin');
    const marketer = await loginAs(ctx.app, 'marketer');
    await admin.request({ method: 'PATCH', url: `/api/users/${marketer.userId}`, payload: { active: false } });
    expect((await marketer.request({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
  });
});

describe('API keys', () => {
  test('shown once, stored hashed, revocable', async () => {
    const admin = await loginAs(ctx.app, 'admin');
    const created = await admin.request({ method: 'POST', url: '/api/api-keys', payload: { name: 'PureNet bridge', scopes: ['events:write', 'contacts:write'] } });
    expect(created.statusCode).toBe(201);
    const { key, id } = created.json();
    expect(key).toMatch(/^pe_[A-Za-z0-9]{8}_/);

    const listed = (await admin.request({ method: 'GET', url: '/api/api-keys' })).json().data;
    expect(JSON.stringify(listed)).not.toContain(key);

    const track = () => ctx.app.inject({ method: 'POST', url: '/api/v1/track', headers: { authorization: `Bearer ${key}` }, payload: { events: [] } });
    expect((await track()).statusCode).toBe(201);
    await admin.request({ method: 'DELETE', url: `/api/api-keys/${id}` });
    expect((await track()).statusCode).toBe(401);
  });
});
