// PureNet webhook → connector → ingest → Postgres, with a fake PureNet API for member refetches.
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { sign } from '@pure-engage/purenet-connector';
import { testApp, truncateAll } from './helpers.ts';

const SECRET = 'whsec_test_only_0123456789';
let ctx: Awaited<ReturnType<typeof testApp>>;
let fake: Server;

beforeAll(async () => {
  // Fake PureNet: token endpoint + member + consents (shapes from docs/contracts/purenet*.openapi.yaml).
  fake = createServer((req, res) => {
    const send = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/oauth2/token') return send({ access_token: 't', token_type: 'Bearer', expires_in: 3600 });
    if (req.url?.endsWith('/consents')) return send({ data: [{ channel: 'email', purpose: 'care', status: 'granted', updatedAt: '2026-01-01T08:00:00Z' }] });
    if (req.url?.startsWith('/members/')) return send({ memberId: 'MBR-TEST-0001', identifiers: [], givenName: 'Test', preferredLanguage: 'ar', contactPoints: [{ channel: 'email', value: 'test.member@example.com', verified: true }], updatedAt: '2026-01-01T08:00:00Z' });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as { port: number }).port;
  ctx = await testApp({ PURENET_WEBHOOK_SECRET: SECRET }, {
    PURENET_BASE_URL: `http://127.0.0.1:${port}`,
    PURENET_TOKEN_URL: `http://127.0.0.1:${port}/oauth2/token`,
    PURENET_CLIENT_ID: 'c',
    PURENET_CLIENT_SECRET: 's',
  });
});
afterAll(async () => { await ctx.close(); await new Promise((r) => fake.close(r)); });
beforeEach(async () => { await truncateAll(ctx.db); });

const deliver = (payload: object, secret = SECRET) => {
  const body = JSON.stringify(payload);
  return ctx.app.inject({ method: 'POST', url: '/hooks/purenet', headers: { 'content-type': 'application/json', 'x-purenet-signature': sign(secret, body) }, payload: body });
};

const booked = { id: 'evt_test_0003', type: 'appointment.booked', occurred_at: '2026-01-02T09:00:00Z', data: { id: 'APT-TEST-0001', memberId: 'MBR-TEST-0001', facilityId: 'FAC-TEST-01', start: '2026-01-10T06:30:00Z', status: 'booked' } };

test('a signed appointment event creates the contact and stores the event (source purenet)', async () => {
  const res = await deliver(booked);
  expect(res.statusCode).toBe(200);
  const contact = await ctx.db.selectFrom('contacts').selectAll().where('external_id', '=', 'MBR-TEST-0001').executeTakeFirstOrThrow();
  const event = await ctx.db.selectFrom('events').selectAll().executeTakeFirstOrThrow();
  expect(event).toMatchObject({ contact_id: contact.id, name: 'purenet.appointment.booked', source: 'purenet', idempotency_key: 'purenet:evt_test_0003' });
  expect(event.properties).toMatchObject({ appointment_id: 'APT-TEST-0001', start: '2026-01-10T06:30:00Z' });
  const audit = await ctx.db.selectFrom('audit_log').selectAll().where('action', '=', 'contact.create').executeTakeFirstOrThrow();
  expect(audit).toMatchObject({ actor_type: 'integration', actor_id: 'purenet' });
});

test('redelivery is idempotent; a bad signature is rejected', async () => {
  await deliver(booked);
  expect((await deliver(booked)).statusCode).toBe(200);
  expect(await ctx.db.selectFrom('events').selectAll().execute()).toHaveLength(1);
  expect((await deliver({ ...booked, id: 'evt_other' }, 'whsec_wrong_secret_000000')).statusCode).toBe(401);
});

test('consent.changed updates consent with a purenet history entry', async () => {
  await deliver({ id: 'evt_c1', type: 'consent.changed', occurred_at: '2026-01-01T08:05:00Z', data: { memberId: 'MBR-TEST-0001', channel: 'sms', purpose: 'marketing', status: 'denied' } });
  const c = await ctx.db.selectFrom('contacts').selectAll().executeTakeFirstOrThrow();
  expect(c.consent).toEqual({ sms: { marketing: 'denied' } });
  const h = await ctx.db.selectFrom('consent_history').selectAll().executeTakeFirstOrThrow();
  expect(h.source).toBe('purenet');
});

test('member.updated refetches the member from PureNet and updates the profile', async () => {
  await deliver({ id: 'evt_m1', type: 'member.updated', occurred_at: '2026-01-01T08:00:00Z', data: { memberId: 'MBR-TEST-0001', changedFields: ['preferredLanguage'] } });
  const c = await ctx.db.selectFrom('contacts').selectAll().executeTakeFirstOrThrow();
  expect(c).toMatchObject({ external_id: 'MBR-TEST-0001', email: 'test.member@example.com', first_name: 'Test', preferred_language: 'ar', consent: { email: { care: 'granted' } } });
  expect(c.attributes).toMatchObject({ purenet_updated_at: '2026-01-01T08:00:00Z' });
});

test('the webhook is not mounted without a signing secret', async () => {
  const plain = await testApp();
  try {
    expect((await plain.app.inject({ method: 'POST', url: '/hooks/purenet', payload: {} })).statusCode).toBe(404);
  } finally { await plain.close(); }
});
