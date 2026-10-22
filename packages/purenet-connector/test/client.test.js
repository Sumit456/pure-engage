import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenProvider, createPureNetClient, PureNetError } from '../src/index.js';
import { retryDelayMs } from '../src/client.js';
import { fakeServer, json, tokenHandler } from './helpers.js';

async function setup() {
  const auth = await fakeServer();
  const api = await fakeServer();
  const issued = { n: 0 };
  auth.handle(tokenHandler(issued));
  const tokens = createTokenProvider({ tokenUrl: `${auth.url}/oauth2/token`, clientId: 'c', clientSecret: 's', scopes: 'members.read' });
  const waits = [];
  const client = createPureNetClient({ baseUrl: api.url, tokens, wait: async (ms) => { waits.push(ms); } });
  return { auth, api, issued, tokens, client, waits, close: () => Promise.all([auth.close(), api.close()]) };
}

test('token: client-credentials form post, cached across calls', async () => {
  const t = await setup();
  try {
    t.api.handle((req, res) => json(res, 200, { memberId: 'M1', identifiers: [], updatedAt: '2026-01-01T00:00:00Z' }));
    await t.client.getMember('M1');
    await t.client.getMember('M1');
    assert.equal(t.issued.n, 1);
    const form = new URLSearchParams(t.auth.requests[0].body);
    assert.deepEqual(Object.fromEntries(form), { grant_type: 'client_credentials', client_id: 'c', client_secret: 's', scope: 'members.read' });
    assert.equal(t.api.requests[1].headers.authorization, 'Bearer tok1');
  } finally { await t.close(); }
});

test('token: refreshed shortly before expiry; concurrent callers share one request', async () => {
  const auth = await fakeServer();
  const issued = { n: 0 };
  auth.handle(tokenHandler(issued, 120));
  let clock = 0;
  const tokens = createTokenProvider({ tokenUrl: auth.url, clientId: 'c', clientSecret: 's', now: () => clock });
  try {
    assert.deepEqual(await Promise.all([tokens.get(), tokens.get(), tokens.get()]), ['tok1', 'tok1', 'tok1']);
    clock = 59_000;
    assert.equal(await tokens.get(), 'tok1');
    clock = 61_000; // within 60s of the 120s expiry
    assert.equal(await tokens.get(), 'tok2');
  } finally { await auth.close(); }
});

test('token: OAuth error surfaces as PureNetError', async () => {
  const auth = await fakeServer();
  auth.handle((req, res) => json(res, 401, { error: 'invalid_client' }));
  const tokens = createTokenProvider({ tokenUrl: auth.url, clientId: 'c', clientSecret: 'bad' });
  try {
    await assert.rejects(tokens.get(), (e) => e instanceof PureNetError && e.status === 401 && /invalid_client/.test(e.message));
  } finally { await auth.close(); }
});

test('401 from the API refreshes the token once, then retries', async () => {
  const t = await setup();
  try {
    let calls = 0;
    t.api.handle((req, res) => (++calls === 1 ? json(res, 401, { title: 'Unauthorized', status: 401 }) : json(res, 200, { data: [] })));
    assert.deepEqual(await t.client.listConsents('M1'), []);
    assert.equal(t.issued.n, 2);
    assert.equal(t.api.requests[1].headers.authorization, 'Bearer tok2');
  } finally { await t.close(); }
});

test('persistent 401 is not retried forever', async () => {
  const t = await setup();
  try {
    t.api.handle((req, res) => json(res, 401, { title: 'Unauthorized', status: 401 }));
    await assert.rejects(t.client.getMember('M1'), (e) => e.status === 401);
    assert.equal(t.api.requests.length, 2);
  } finally { await t.close(); }
});

test('429 honours Retry-After, then succeeds', async () => {
  const t = await setup();
  try {
    let calls = 0;
    t.api.handle((req, res) => (++calls < 3
      ? json(res, 429, { title: 'Too Many Requests', status: 429 }, { 'retry-after': '2' })
      : json(res, 200, { memberId: 'M1' })));
    assert.equal((await t.client.getMember('M1')).memberId, 'M1');
    assert.deepEqual(t.waits, [2000, 2000]);
  } finally { await t.close(); }
});

test('retries stop at maxRetries and the problem+json is surfaced', async () => {
  const t = await setup();
  try {
    t.api.handle((req, res) => json(res, 503, { title: 'Service Unavailable', status: 503, detail: 'maintenance' }));
    await assert.rejects(t.client.getMember('M1'), (e) => e instanceof PureNetError && e.status === 503 && e.problem.detail === 'maintenance');
    assert.equal(t.api.requests.length, 4); // 1 + 3 retries
    assert.deepEqual(t.waits, [500, 1000, 2000]);
  } finally { await t.close(); }
});

test('404 is not retried', async () => {
  const t = await setup();
  try {
    t.api.handle((req, res) => json(res, 404, { title: 'Not Found', status: 404 }));
    await assert.rejects(t.client.getMember('nope'), (e) => e.status === 404);
    assert.equal(t.api.requests.length, 1);
  } finally { await t.close(); }
});

test('search encodes system|value and follows cursors', async () => {
  const t = await setup();
  try {
    t.api.handle((req, res) => {
      const cursor = new URL(req.url, 'http://x').searchParams.get('cursor');
      json(res, 200, cursor ? { data: [{ memberId: 'M2' }], next_cursor: null } : { data: [{ memberId: 'M1' }], next_cursor: 'c2' });
    });
    const ids = [];
    for await (const m of t.client.searchAllMembers('urn:x', 'A B')) ids.push(m.memberId);
    assert.deepEqual(ids, ['M1', 'M2']);
    const first = new URL(t.api.requests[0].url, 'http://x');
    assert.equal(first.pathname, '/members');
    assert.equal(first.searchParams.get('identifier'), 'urn:x|A B');
  } finally { await t.close(); }
});

test('subscriptions: create sends JSON; delete handles 204; ids are path-encoded', async () => {
  const t = await setup();
  try {
    t.api.handle((req, res) => (req.method === 'POST'
      ? json(res, 201, { id: 'sub1', callbackUrl: 'https://cb', eventTypes: ['member.updated'], signingSecret: 'whsec_x' })
      : json(res, 204)));
    const sub = await t.client.createSubscription('https://cb', ['member.updated']);
    assert.equal(sub.signingSecret, 'whsec_x');
    assert.deepEqual(JSON.parse(t.api.requests[0].body), { callbackUrl: 'https://cb', eventTypes: ['member.updated'] });
    assert.equal(await t.client.deleteSubscription('a/b'), null);
    assert.equal(t.api.requests[1].url, '/subscriptions/a%2Fb');
  } finally { await t.close(); }
});

test('retryDelayMs: seconds, HTTP date, fallback backoff, cap', () => {
  assert.equal(retryDelayMs('3', 0), 3000);
  assert.equal(retryDelayMs('999', 0), 30_000);
  assert.ok(retryDelayMs(new Date(Date.now() + 5000).toUTCString(), 0) <= 5000);
  assert.equal(retryDelayMs(null, 2), 2000);
  assert.equal(retryDelayMs(null, 20), 30_000);
});
