import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { loginAs, testApp, truncateAll } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof testApp>>;
let marketer: Awaited<ReturnType<typeof loginAs>>;
let admin: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => { ctx = await testApp(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => {
  await truncateAll(ctx.db);
  marketer = await loginAs(ctx.app, 'marketer');
  admin = await loginAs(ctx.app, 'admin');
});

const create = (payload: Record<string, unknown>) => marketer.request({ method: 'POST', url: '/api/contacts', payload });

test('creates a contact: standard fields in columns, the rest in attributes', async () => {
  const res = await create({ external_id: 'MBR-TEST-0001', email: 'Test.Member@Example.com', phone: '+971500000001', first_name: 'Test', preferred_language: 'ar', timezone: 'Asia/Dubai', plan: 'gold' });
  expect(res.statusCode).toBe(201);
  expect(res.json()).toMatchObject({ external_id: 'MBR-TEST-0001', email: 'test.member@example.com', phone: '+971500000001', preferred_language: 'ar', timezone: 'Asia/Dubai', attributes: { plan: 'gold' }, consent: {} });
});

test('validates fields and reports every problem', async () => {
  const res = await create({ external_id: 'MBR-TEST-0002', phone: '0501234567', timezone: 'Mars/Base', 'bad key': 1 });
  expect(res.statusCode).toBe(400);
  const paths = res.json().details.map((d: { path: string }) => d.path);
  expect(paths).toEqual(expect.arrayContaining(['phone', 'timezone']));
  expect((await create({ first_name: 'No ref' })).statusCode).toBe(400);
});

test('rejects a duplicate external_id', async () => {
  await create({ external_id: 'MBR-TEST-0003' });
  expect((await create({ external_id: 'MBR-TEST-0003' })).statusCode).toBe(409);
});

test('update merges attributes; null removes one; unchanged updates are not audited', async () => {
  const { id } = (await create({ external_id: 'MBR-TEST-0004', plan: 'gold', tier: 2 })).json();
  const res = await marketer.request({ method: 'PATCH', url: `/api/contacts/${id}`, payload: { tier: null, city: 'Abu Dhabi', first_name: 'Test' } });
  expect(res.json()).toMatchObject({ first_name: 'Test', attributes: { plan: 'gold', city: 'Abu Dhabi' } });
  expect(res.json().attributes).not.toHaveProperty('tier');

  await marketer.request({ method: 'PATCH', url: `/api/contacts/${id}`, payload: { first_name: 'Test' } });
  const audits = await ctx.db.selectFrom('audit_log').select(['action', 'details']).where('entity_id', '=', id).orderBy('id').execute();
  expect(audits.map((a) => a.action)).toEqual(['contact.create', 'contact.update']);
  // Audit records which fields changed, never their values.
  expect(audits[1]!.details).toMatchObject({ fields: ['first_name'], attributes: ['tier', 'city'] });
  expect(JSON.stringify(audits)).not.toContain('Abu Dhabi');
});

test('consent changes are merged and recorded in history with the previous status', async () => {
  const { id } = (await create({ external_id: 'MBR-TEST-0005', consent: { email: { care: 'granted' } } })).json();
  await marketer.request({ method: 'PATCH', url: `/api/contacts/${id}`, payload: { consent: { email: { marketing: 'denied' }, sms: { care: 'granted' } } } });
  await marketer.request({ method: 'PATCH', url: `/api/contacts/${id}`, payload: { consent: { email: { care: 'granted' } } } }); // no-op
  await marketer.request({ method: 'PATCH', url: `/api/contacts/${id}`, payload: { consent: { email: { care: 'denied' } } } });

  const detail = (await marketer.request({ method: 'GET', url: `/api/contacts/${id}` })).json();
  expect(detail.consent).toEqual({ email: { care: 'denied', marketing: 'denied' }, sms: { care: 'granted' } });
  const history = detail.consent_history.map((h: Record<string, string>) => `${h.channel}.${h.purpose}:${h.previous_status}->${h.status}`);
  expect(history.sort()).toEqual(['email.care:granted->denied', 'email.care:null->granted', 'email.marketing:null->denied', 'sms.care:null->granted'].sort());

  expect((await marketer.request({ method: 'PATCH', url: `/api/contacts/${id}`, payload: { consent: { email: { care: 'yes' } } } })).statusCode).toBe(400);
});

test('viewing a contact is audited (PHI access)', async () => {
  const { id } = (await create({ external_id: 'MBR-TEST-0006' })).json();
  const viewer = await loginAs(ctx.app, 'viewer');
  expect((await viewer.request({ method: 'GET', url: `/api/contacts/${id}` })).statusCode).toBe(200);
  const views = await ctx.db.selectFrom('audit_log').selectAll().where('action', '=', 'contact.view').execute();
  expect(views).toHaveLength(1);
  expect(views[0]).toMatchObject({ actor_type: 'user', actor_id: viewer.userId, entity_id: id });
});

test('list searches and paginates with a cursor', async () => {
  for (let i = 0; i < 5; i++) await create({ external_id: `MBR-TEST-01${i}`, first_name: i % 2 ? 'Layla' : 'Omar', email: `p${i}@example.com` });
  const search = (await marketer.request({ method: 'GET', url: '/api/contacts?q=layla' })).json();
  expect(search.data).toHaveLength(2);

  const page1 = (await marketer.request({ method: 'GET', url: '/api/contacts?limit=2' })).json();
  const page2 = (await marketer.request({ method: 'GET', url: `/api/contacts?limit=2&cursor=${page1.next_cursor}` })).json();
  const page3 = (await marketer.request({ method: 'GET', url: `/api/contacts?limit=2&cursor=${page2.next_cursor}` })).json();
  const ids = [...page1.data, ...page2.data, ...page3.data].map((c: { id: string }) => c.id);
  expect(new Set(ids).size).toBe(5);
  expect(page3.next_cursor).toBeNull();

  // LIKE wildcards in the search are literal.
  expect((await marketer.request({ method: 'GET', url: '/api/contacts?q=%25' })).json().data).toHaveLength(0);
});

test('delete is admin-only, removes events and is audited', async () => {
  const { id } = (await create({ external_id: 'MBR-TEST-0007' })).json();
  await ctx.app.services.events.track({ external_id: 'MBR-TEST-0007', name: 'x', properties: {} }, { source: 'test', actor: { type: 'system' } });
  expect((await marketer.request({ method: 'DELETE', url: `/api/contacts/${id}` })).statusCode).toBe(403);
  expect((await admin.request({ method: 'DELETE', url: `/api/contacts/${id}` })).statusCode).toBe(204);
  expect(await ctx.db.selectFrom('events').selectAll().execute()).toEqual([]);
  expect((await admin.request({ method: 'GET', url: `/api/contacts/${id}` })).statusCode).toBe(404);
  expect(await ctx.db.selectFrom('audit_log').select('action').where('action', '=', 'contact.delete').execute()).toHaveLength(1);
});

test('matching by email alone refuses ambiguous matches', async () => {
  await create({ external_id: 'MBR-TEST-0008', email: 'family@example.com' });
  await create({ external_id: 'MBR-TEST-0009', email: 'family@example.com' });
  await expect(ctx.app.services.contacts.upsert({ email: 'family@example.com', city: 'x' }, { source: 'test', actor: { type: 'system' } }))
    .rejects.toMatchObject({ statusCode: 409 });
});

test('concurrent upserts of the same new external_id create one contact', async () => {
  const opts = { source: 'test', actor: { type: 'system' as const } };
  await Promise.all(Array.from({ length: 5 }, (_, i) => ctx.app.services.contacts.upsert({ external_id: 'MBR-TEST-RACE', [`k${i}`]: i }, opts)));
  const rows = await ctx.db.selectFrom('contacts').selectAll().where('external_id', '=', 'MBR-TEST-RACE').execute();
  expect(rows).toHaveLength(1);
});
