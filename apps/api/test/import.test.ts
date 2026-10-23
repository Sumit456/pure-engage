import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { loginAs, makeContact, testApp, truncateAll } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => { ctx = await testApp(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await truncateAll(ctx.db); });

const rows = [
  { external_id: 'MBR-TEST-5001', email: 'imp1@example.com', first_name: 'Test', last_name: 'Import 1', preferred_language: 'en', consent: { email: { marketing: 'granted' } }, plan: 'gold' },
  { external_id: 'MBR-TEST-5002', email: 'imp2@example.com', phone: '+971500000501', consent: { sms: { care: 'granted' } } },
  { external_id: 'MBR-TEST-5003', phone: 'not-a-phone' },
  { first_name: 'No identifier' },
];

test('a dry run reports what would happen without writing anything', async () => {
  await makeContact(ctx.app, { external_id: 'MBR-TEST-5002', email: 'old@example.com' });
  const marketer = await loginAs(ctx.app, 'marketer');
  const res = await marketer.request({ method: 'POST', url: '/api/contacts/import', payload: { rows, dry_run: true, file_name: 'members.csv' } });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body).toMatchObject({ dry_run: true, created: 1, updated: 1, skipped: 0 });
  expect(body.errors.map((e: { row: number }) => e.row)).toEqual([4, 5]);
  expect(body.errors[0].fields[0]).toMatchObject({ path: 'phone' });
  expect(body.errors[1].message).toMatch(/external ID or an email/);
  expect(await ctx.db.selectFrom('contacts').select('id').execute()).toHaveLength(1);
  expect(await ctx.db.selectFrom('audit_log').select('id').where('action', '=', 'contacts.import').execute()).toHaveLength(0);
});

test('importing creates and updates, records consent with source "import", and audits counts only', async () => {
  await makeContact(ctx.app, { external_id: 'MBR-TEST-5002', email: 'old@example.com' });
  const marketer = await loginAs(ctx.app, 'marketer');
  const res = await marketer.request({ method: 'POST', url: '/api/contacts/import', payload: { rows, file_name: 'C:\\fakepath\\members.csv' } });
  expect(res.json()).toMatchObject({ dry_run: false, created: 1, updated: 1, skipped: 0 });

  const c1 = await ctx.db.selectFrom('contacts').selectAll().where('external_id', '=', 'MBR-TEST-5001').executeTakeFirstOrThrow();
  expect(c1).toMatchObject({ email: 'imp1@example.com', attributes: { plan: 'gold' }, consent: { email: { marketing: 'granted' } } });
  const c2 = await ctx.db.selectFrom('contacts').selectAll().where('external_id', '=', 'MBR-TEST-5002').executeTakeFirstOrThrow();
  expect(c2).toMatchObject({ email: 'imp2@example.com', phone: '+971500000501' });
  const history = await ctx.db.selectFrom('consent_history').select(['source']).execute();
  expect(history.map((h) => h.source)).toEqual(['import', 'import']);

  const [log] = await ctx.db.selectFrom('audit_log').select('details').where('action', '=', 'contacts.import').execute();
  expect(log!.details).toEqual({ file_name: 'members.csv', mode: 'upsert', first_row: 2, rows: 4, created: 1, updated: 1, skipped: 0, errors: 2 });
  expect(JSON.stringify(log!.details)).not.toMatch(/imp1@example.com|MBR-TEST/);

  const historyRes = await marketer.request({ method: 'GET', url: '/api/contacts/imports' });
  const history2 = historyRes.json();
  expect(historyRes.statusCode, historyRes.body).toBe(200);
  expect(history2.data[0].details).toMatchObject({ file_name: 'members.csv', created: 1 });
});

test('create-only skips existing members and update-only skips new ones; repeats within a file update the first', async () => {
  await makeContact(ctx.app, { external_id: 'MBR-TEST-5002', email: 'old@example.com' });
  const marketer = await loginAs(ctx.app, 'marketer');
  const createOnly = (await marketer.request({ method: 'POST', url: '/api/contacts/import', payload: { rows: rows.slice(0, 2), mode: 'create_only' } })).json();
  expect(createOnly).toMatchObject({ created: 1, updated: 0, skipped: 1 });
  expect((await ctx.db.selectFrom('contacts').select('email').where('external_id', '=', 'MBR-TEST-5002').executeTakeFirstOrThrow()).email).toBe('old@example.com');

  const updateOnly = (await marketer.request({ method: 'POST', url: '/api/contacts/import', payload: { rows: [{ external_id: 'MBR-TEST-5999', email: 'new@example.com' }, { external_id: 'MBR-TEST-5002', first_name: 'Updated' }], mode: 'update_only' } })).json();
  expect(updateOnly).toMatchObject({ created: 0, updated: 1, skipped: 1 });

  const repeats = (await marketer.request({ method: 'POST', url: '/api/contacts/import', payload: { rows: [{ email: 'twice@example.com', first_name: 'A' }, { email: 'twice@example.com', first_name: 'B' }], dry_run: true } })).json();
  expect(repeats).toMatchObject({ created: 1, updated: 1 });
});

test('only marketers and admins can import, and requests are bounded', async () => {
  const viewer = await loginAs(ctx.app, 'viewer');
  expect((await viewer.request({ method: 'POST', url: '/api/contacts/import', payload: { rows: [] } })).statusCode).toBe(403);
  const marketer = await loginAs(ctx.app, 'marketer');
  const tooMany = Array.from({ length: 1001 }, (_, i) => ({ external_id: `MBR-TEST-${9000 + i}` }));
  expect((await marketer.request({ method: 'POST', url: '/api/contacts/import', payload: { rows: tooMany } })).statusCode).toBe(400);
  expect((await marketer.request({ method: 'POST', url: '/api/contacts/import', payload: { rows: [], mode: 'merge' } })).statusCode).toBe(400);
  // contact_id in a file is ignored: rows can't target arbitrary contacts by internal id.
  const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-5100', email: 'target@example.com' });
  const res = (await marketer.request({ method: 'POST', url: '/api/contacts/import', payload: { rows: [{ contact_id: c.id, email: 'someone@example.com', first_name: 'X' }] } })).json();
  expect(res).toMatchObject({ created: 1, updated: 0 });
  expect((await ctx.db.selectFrom('contacts').select('first_name').where('id', '=', c.id).executeTakeFirstOrThrow()).first_name).toBeNull();
});
