import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PureEngage, PureEngageError, signWebhook, verifyWebhook } from '../src/index.js';

/** A fake fetch that records calls and replays canned responses. */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body && JSON.parse(init.body) });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  };
  return { fn, calls };
}

test('sends the key as a bearer token and shapes /track requests', async () => {
  const { fn, calls } = fakeFetch([{ status: 201, body: { attributes_processed: 0, events_processed: 1, duplicates: 0, errors: [] } }, { status: 201, body: {} }]);
  const pe = new PureEngage({ baseUrl: 'https://engage.example.com/', apiKey: 'pe_testtest_secret', fetch: fn });
  const r = await pe.track({ external_id: 'MBR-TEST-0001', name: 'signup' });
  assert.equal(r.events_processed, 1);
  await pe.identify([{ external_id: 'MBR-TEST-0001', consent: { email: { care: 'granted' } } }]);
  assert.equal(calls[0].url, 'https://engage.example.com/api/v1/track');
  assert.equal(calls[0].headers.authorization, 'Bearer pe_testtest_secret');
  assert.deepEqual(calls[0].body, { events: [{ external_id: 'MBR-TEST-0001', name: 'signup' }] });
  assert.deepEqual(calls[1].body, { attributes: [{ external_id: 'MBR-TEST-0001', consent: { email: { care: 'granted' } } }] });
});

test('errors carry the status and details, e.g. a missing permission', async () => {
  const { fn } = fakeFetch([{ status: 403, body: { error: 'This API key is missing the segments:read permission', details: { code: 'insufficient_scope', missing: ['segments:read'] } } }]);
  const pe = new PureEngage({ baseUrl: 'https://engage.example.com', apiKey: 'k', fetch: fn });
  await assert.rejects(pe.listSegments(), (err) => err instanceof PureEngageError && err.status === 403 && err.details.code === 'insufficient_scope');
});

test('reads retry 5xx; writes retry only 429', async () => {
  const reads = fakeFetch([{ status: 503 }, { status: 200, body: { data: [{ id: 's1' }] } }]);
  const pe = new PureEngage({ baseUrl: 'https://engage.example.com', apiKey: 'k', fetch: reads.fn });
  assert.deepEqual(await pe.listSegments(), [{ id: 's1' }]);
  assert.equal(reads.calls.length, 2);

  const writes = fakeFetch([{ status: 500, body: { error: 'Internal server error' } }]);
  const pe2 = new PureEngage({ baseUrl: 'https://engage.example.com', apiKey: 'k', fetch: writes.fn });
  await assert.rejects(pe2.track({ external_id: 'MBR-TEST-0002', name: 'x' }), { status: 500 });
  assert.equal(writes.calls.length, 1);

  const limited = fakeFetch([{ status: 429, headers: { 'retry-after': '0' } }, { status: 201, body: { events_processed: 1 } }]);
  const pe3 = new PureEngage({ baseUrl: 'https://engage.example.com', apiKey: 'k', fetch: limited.fn });
  assert.equal((await pe3.track({ external_id: 'MBR-TEST-0003', name: 'x' })).events_processed, 1);
  assert.equal(limited.calls.length, 2);
});

test('lookups put identifiers in the body, not the URL', async () => {
  const { fn, calls } = fakeFetch([{ status: 200, body: { id: 'c1', masked: true } }]);
  const pe = new PureEngage({ baseUrl: 'https://engage.example.com', apiKey: 'k', fetch: fn });
  await pe.lookupContact({ email: 'test.member@example.com' });
  assert.equal(calls[0].url, 'https://engage.example.com/api/v1/contacts/lookup');
  assert.deepEqual(calls[0].body, { email: 'test.member@example.com' });
});

test('webhook signatures match the platform scheme and are checked for age and tampering', async () => {
  const body = JSON.stringify({ id: 'evt_test', type: 'event' });
  const t = 1_767_225_600;
  const header = await signWebhook('whsec_test', body, t);
  const expected = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
  assert.equal(header, `t=${t},v1=${expected}`);
  assert.equal(await verifyWebhook(header, body, 'whsec_test', { now: t * 1000 }), true);
  assert.equal(await verifyWebhook(header, `${body} `, 'whsec_test', { now: t * 1000 }), false);
  assert.equal(await verifyWebhook(header, body, 'other', { now: t * 1000 }), false);
  assert.equal(await verifyWebhook(header, body, 'whsec_test', { now: (t + 600) * 1000 }), false);
  assert.equal(await verifyWebhook(undefined, body, 'whsec_test'), false);
});
