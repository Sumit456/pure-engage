import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { apiKey, testApp, truncateAll } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof testApp>>;
let key: string;
beforeAll(async () => { ctx = await testApp(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await truncateAll(ctx.db); key = await apiKey(ctx.app); });

const track = (payload: unknown, k: string | null = key) =>
  ctx.app.inject({ method: 'POST', url: '/api/v1/track', headers: k ? { authorization: `Bearer ${k}` } : {}, payload: payload as object });

test('requires a valid API key', async () => {
  expect((await track({ events: [] }, null)).statusCode).toBe(401);
  expect((await track({ events: [] }, 'pe_abcdefgh_not-the-right-secret-at-all')).statusCode).toBe(401);
});

test('contract example: attributes then events → 201 with counts', async () => {
  // Example from docs/contracts/platform-ingest.openapi.yaml
  const res = await track({
    attributes: [{ external_id: 'MBR-TEST-0001', email: 'test.member@example.com', preferred_language: 'ar' }],
    events: [{ external_id: 'MBR-TEST-0001', name: 'appointment.booked', properties: { appointment_id: 'APT-TEST-0001' }, idempotency_key: 'evt_test_0003' }],
  });
  expect(res.statusCode).toBe(201);
  expect(res.json()).toEqual({ attributes_processed: 1, events_processed: 1, duplicates: 0, errors: [] });
  const event = await ctx.db.selectFrom('events').selectAll().executeTakeFirstOrThrow();
  expect(event).toMatchObject({ name: 'appointment.booked', source: 'api', properties: { appointment_id: 'APT-TEST-0001' } });
});

test('idempotency_key de-duplicates, within and across requests', async () => {
  const e = { external_id: 'MBR-TEST-0002', name: 'purchase', idempotency_key: 'k1' };
  expect((await track({ events: [e, e] })).json()).toMatchObject({ events_processed: 1, duplicates: 1 });
  expect((await track({ events: [e] })).json()).toMatchObject({ events_processed: 0, duplicates: 1 });
  expect(await ctx.db.selectFrom('events').selectAll().execute()).toHaveLength(1);
});

test('an event for an unknown external_id creates the contact', async () => {
  await track({ events: [{ external_id: 'MBR-TEST-NEW', name: 'signup', time: '2026-01-01T08:00:00Z' }] });
  const c = await ctx.db.selectFrom('contacts').selectAll().where('external_id', '=', 'MBR-TEST-NEW').executeTakeFirstOrThrow();
  const e = await ctx.db.selectFrom('events').selectAll().executeTakeFirstOrThrow();
  expect(e.contact_id).toBe(c.id);
  expect(e.occurred_at.toISOString()).toBe('2026-01-01T08:00:00.000Z');
});

test('bad items are reported by index with 207; good items still go in', async () => {
  const res = await track({
    attributes: [{ external_id: 'MBR-TEST-0003', phone: 'not-a-phone' }, { email: 'ok@example.com' }, { city: 'no ref' }],
    events: [{ external_id: 'MBR-TEST-0003' }, { external_id: 'MBR-TEST-0003', name: 'ok' }],
  });
  expect(res.statusCode).toBe(207);
  const body = res.json();
  expect(body).toMatchObject({ attributes_processed: 1, events_processed: 1 });
  expect(body.errors.map((e: { type: string; index: number }) => `${e.type}:${e.index}`)).toEqual(['attribute:0', 'attribute:2', 'event:0']);
  expect(body.errors[0].error).toContain('phone');
});

test('consent can be set through attributes and is recorded with source api', async () => {
  await track({ attributes: [{ external_id: 'MBR-TEST-0004', consent: { sms: { care: 'granted' } } }] });
  const h = await ctx.db.selectFrom('consent_history').selectAll().executeTakeFirstOrThrow();
  expect(h).toMatchObject({ channel: 'sms', purpose: 'care', status: 'granted', source: 'api' });
});

test('rejects non-array bodies (400) and oversized batches (413)', async () => {
  expect((await track({ events: 'nope' })).statusCode).toBe(400);
  const big = Array.from({ length: 501 }, (_, i) => ({ external_id: `x${i}`, name: 'n' }));
  expect((await track({ events: big })).statusCode).toBe(413);
});
