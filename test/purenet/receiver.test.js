import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReceiver, sign, verify, createSeenSet } from '../../src/integrations/purenet/index.js';

const SECRET = 'whsec_test';
const booked = { id: 'evt_1', type: 'appointment.booked', occurred_at: '2026-01-02T09:00:00Z', data: { id: 'APT-1', memberId: 'MBR-1', facilityId: 'FAC-1', serviceType: 'gp', start: '2026-01-10T06:30:00Z', status: 'booked' } };

async function start(opts = {}) {
  const ingested = [];
  const handler = createReceiver({ secret: SECRET, sink: async (t) => { ingested.push(t); }, ...opts });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (payload, { signature, raw } = {}) => {
    const body = raw ?? JSON.stringify(payload);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-purenet-signature': signature ?? sign(SECRET, body) }, body });
    return { status: res.status, body: await res.json() };
  };
  return { ingested, post, close: () => new Promise((r) => server.close(r)) };
}

test('signature: valid, tampered, stale, malformed, no secret', () => {
  const body = '{"a":1}';
  const now = 1_767_254_400_000;
  const header = sign(SECRET, body, now / 1000);
  assert.equal(verify(SECRET, body, header, { now }), null);
  assert.equal(verify(SECRET, '{"a":2}', header, { now }), 'signature mismatch');
  assert.equal(verify('other', body, header, { now }), 'signature mismatch');
  assert.equal(verify(SECRET, body, header, { now: now + 301_000 }), 'timestamp outside tolerance');
  assert.equal(verify(SECRET, body, 'v1=abc', { now }), 'malformed signature header');
  assert.equal(verify('', body, header, { now }), 'no signing secret configured');
});

test('valid appointment event is mapped to a platform track payload', async () => {
  const r = await start();
  try {
    assert.deepEqual(await r.post(booked), { status: 200, body: { status: 'ok' } });
    assert.deepEqual(r.ingested, [{
      attributes: [],
      events: [{
        name: 'purenet.appointment.booked', time: '2026-01-02T09:00:00Z', idempotency_key: 'purenet:evt_1', external_id: 'MBR-1',
        properties: { appointment_id: 'APT-1', facility_id: 'FAC-1', service_type: 'gp', start: '2026-01-10T06:30:00Z', status: 'booked' },
      }],
    }]);
  } finally { await r.close(); }
});

test('redelivery of the same event id is acknowledged but ingested once', async () => {
  const r = await start();
  try {
    await r.post(booked);
    assert.deepEqual(await r.post(booked), { status: 200, body: { status: 'duplicate' } });
    assert.equal(r.ingested.length, 1);
  } finally { await r.close(); }
});

test('bad signature is rejected with 401 and nothing is ingested', async () => {
  const r = await start();
  try {
    assert.equal((await r.post(booked, { signature: sign('wrong', JSON.stringify(booked)) })).status, 401);
    assert.equal((await r.post(booked, { signature: 'nope' })).status, 401);
    assert.equal(r.ingested.length, 0);
  } finally { await r.close(); }
});

test('invalid JSON → 400; unknown type → 202 ignored', async () => {
  const r = await start();
  try {
    assert.equal((await r.post(null, { raw: '{oops' })).status, 400);
    assert.equal((await r.post({ id: 'evt_x' })).status, 400);
    assert.deepEqual(await r.post({ id: 'evt_9', type: 'lab.result', occurred_at: '2026-01-01T00:00:00Z', data: {} }), { status: 202, body: { status: 'ignored', type: 'lab.result' } });
    assert.equal(r.ingested.length, 0);
  } finally { await r.close(); }
});

test('sink failure → 503 and the event is not marked seen, so a retry succeeds', async () => {
  let fail = true;
  const ingested = [];
  const handler = createReceiver({ secret: SECRET, sink: async (t) => { if (fail) throw new Error('db down'); ingested.push(t); } });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = () => { const body = JSON.stringify(booked); return fetch(url, { method: 'POST', headers: { 'x-purenet-signature': sign(SECRET, body) }, body }); };
  try {
    assert.equal((await send()).status, 503);
    fail = false;
    assert.equal((await send()).status, 200);
    assert.equal(ingested.length, 1);
  } finally { await new Promise((r) => server.close(r)); }
});

test('consent.changed updates the consent attribute and records an event', async () => {
  const r = await start();
  try {
    await r.post({ id: 'evt_2', type: 'consent.changed', occurred_at: '2026-01-01T08:05:00Z', data: { memberId: 'MBR-1', channel: 'sms', purpose: 'marketing', status: 'denied' } });
    assert.deepEqual(r.ingested[0].attributes, [{ external_id: 'MBR-1', consent: { sms: { marketing: 'denied' } } }]);
    assert.equal(r.ingested[0].events[0].name, 'purenet.consent.changed');
  } finally { await r.close(); }
});

test('member.updated refetches the member and consents when a client is given', async () => {
  const client = {
    getMember: async (id) => ({ memberId: id, givenName: 'Test', preferredLanguage: 'ar', contactPoints: [{ channel: 'email', value: 't@example.com', verified: true }], updatedAt: '2026-01-01T08:00:00Z' }),
    listConsents: async () => [{ channel: 'email', purpose: 'care', status: 'granted' }],
  };
  const r = await start({ client });
  try {
    await r.post({ id: 'evt_3', type: 'member.updated', occurred_at: '2026-01-01T08:00:00Z', data: { memberId: 'MBR-1', changedFields: ['preferredLanguage'] } });
    assert.deepEqual(r.ingested[0].attributes, [{
      external_id: 'MBR-1', email: 't@example.com', first_name: 'Test', preferred_language: 'ar',
      consent: { email: { care: 'granted' } }, purenet_updated_at: '2026-01-01T08:00:00Z',
    }]);
  } finally { await r.close(); }
});

test('seen set is bounded', () => {
  const seen = createSeenSet(2);
  seen.add('a'); seen.add('b'); seen.add('c');
  assert.equal(seen.has('a'), false);
  assert.equal(seen.has('c'), true);
});
