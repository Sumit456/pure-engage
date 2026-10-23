import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { applyMapping, leafPaths, type InboundMapping } from '@pure-engage/shared';
import { signPayload } from '../src/services/webhooks.ts';
import { loginAs, makeContact, makeTemplate, emailTemplate, testApp, truncateAll } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => { ctx = await testApp(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await truncateAll(ctx.db); });

const SYS = { type: 'system' as const };
const key = async (scopes: string[], name = 'test') => (await ctx.app.services.auth.createApiKey({ name, scopes: scopes as never }, SYS)).key;
const call = (k: string, method: 'GET' | 'POST', url: string, payload?: object) =>
  ctx.app.inject({ method, url, headers: { authorization: `Bearer ${k}` }, ...(payload ? { payload } : {}) });
/** The request log is written after the response is sent. */
const logRows = async (n: number) => {
  for (let i = 0; i < 50; i++) {
    const rows = await ctx.db.selectFrom('integration_requests').selectAll().orderBy('id').execute();
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return ctx.db.selectFrom('integration_requests').selectAll().orderBy('id').execute();
};

test('API keys carry scopes: routes refuse keys without the permission they need', async () => {
  const readOnly = await key(['contacts:read']);
  const res = await call(readOnly, 'POST', '/api/v1/track', { events: [{ external_id: 'MBR-TEST-7001', name: 'x' }] });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ details: { code: 'insufficient_scope', missing: ['events:write'] } });

  const eventsOnly = await key(['events:write']);
  expect((await call(eventsOnly, 'POST', '/api/v1/track', { events: [{ external_id: 'MBR-TEST-7001', name: 'x' }] })).statusCode).toBe(201);
  expect((await call(eventsOnly, 'POST', '/api/v1/track', { attributes: [{ external_id: 'MBR-TEST-7001', city: 'Dubai' }] })).statusCode).toBe(403);
  const contactsOnly = await key(['contacts:write']);
  expect((await call(contactsOnly, 'POST', '/api/v1/track', { attributes: [{ external_id: 'MBR-TEST-7001', consent: { email: { marketing: 'granted' } } }] })).statusCode).toBe(403);
  expect((await call(eventsOnly, 'GET', '/api/v1/segments')).statusCode).toBe(403);
});

test('keys created the old way keep their old permissions; expired and revoked keys stop working', async () => {
  const legacy = (await ctx.app.services.auth.createApiKey('legacy', SYS)).key;
  expect((await call(legacy, 'POST', '/api/v1/track', { attributes: [{ external_id: 'MBR-TEST-7002', consent: { sms: { care: 'granted' } } }] })).statusCode).toBe(201);

  const k = await ctx.app.services.auth.createApiKey({ name: 'short', scopes: ['segments:read'], expires_at: new Date(Date.now() + 60_000).toISOString() }, SYS);
  expect((await call(k.key, 'GET', '/api/v1/segments')).statusCode).toBe(200);
  await ctx.db.updateTable('api_keys').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', k.id).execute();
  expect((await call(k.key, 'GET', '/api/v1/segments')).statusCode).toBe(401);

  const admin = await loginAs(ctx.app, 'admin');
  const created = await admin.request({ method: 'POST', url: '/api/api-keys', payload: { name: 'Booking system', scopes: ['events:write', 'events:write', 'contacts:write'] } });
  expect(created.statusCode).toBe(201);
  expect(created.json().scopes).toEqual(['events:write', 'contacts:write']);
  expect((await admin.request({ method: 'POST', url: '/api/api-keys', payload: { name: 'none', scopes: [] } })).statusCode).toBe(400);
  expect((await admin.request({ method: 'POST', url: '/api/api-keys', payload: { name: 'bad', scopes: ['everything'] } })).statusCode).toBe(400);
  await admin.request({ method: 'DELETE', url: `/api/api-keys/${created.json().id}` });
  expect((await call(created.json().key, 'POST', '/api/v1/track', { events: [] })).statusCode).toBe(401);
});

test('contact reads are masked unless the key may see personal data, and every read is audited', async () => {
  const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-7003', email: 'sara.test@example.com', phone: '+971500000123', first_name: 'Sara', last_name: 'Test', condition: 'synthetic' });
  const masked = await call(await key(['contacts:read']), 'POST', '/api/v1/contacts/lookup', { external_id: 'MBR-TEST-7003' });
  expect(masked.statusCode).toBe(200);
  expect(masked.json()).toMatchObject({ id: c.id, email: 's***@example.com', phone: '+971*******23', first_name: 'S.', last_name: 'T.', attribute_names: ['condition'], masked: true });
  expect(masked.json()).not.toHaveProperty('attributes');
  expect(JSON.stringify(masked.json())).not.toContain('synthetic');

  const full = await call(await key(['contacts:read', 'contacts:read_pii']), 'GET', `/api/v1/contacts/${c.id}`);
  expect(full.json()).toMatchObject({ email: 'sara.test@example.com', first_name: 'Sara', attributes: { condition: 'synthetic' }, masked: false });

  const views = await ctx.db.selectFrom('audit_log').selectAll().where('action', '=', 'contact.view').orderBy('at').execute();
  expect(views.map((v) => v.details)).toEqual([{ via: 'api', pii: false }, { via: 'api', pii: true }]);
  expect(views.every((v) => v.actor_type === 'api_key')).toBe(true);
  expect((await call(await key(['contacts:read']), 'POST', '/api/v1/contacts/lookup', { email: 'nobody@example.com' })).statusCode).toBe(404);
});

test('consent can be changed over the API, with history; unknown contacts are not created', async () => {
  const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-7004' });
  const k = await key(['consent:write']);
  const res = await call(k, 'POST', '/api/v1/consent', { external_id: 'MBR-TEST-7004', consent: { email: { marketing: 'granted' } } });
  expect(res.statusCode).toBe(200);
  expect(res.json().consent).toMatchObject({ email: { marketing: 'granted' } });
  const history = await ctx.db.selectFrom('consent_history').selectAll().where('contact_id', '=', c.id).execute();
  expect(history).toMatchObject([{ channel: 'email', purpose: 'marketing', status: 'granted', source: 'api' }]);
  expect((await call(k, 'POST', '/api/v1/consent', { external_id: 'MBR-TEST-NOPE', consent: { email: { marketing: 'granted' } } })).statusCode).toBe(404);
  expect((await call(k, 'POST', '/api/v1/consent', { external_id: 'MBR-TEST-7004', consent: { email: { marketing: 'maybe' } } })).statusCode).toBe(400);
});

test('a journey can be triggered over the API (as its trigger event, picked up by the worker)', async () => {
  const j = await ctx.app.services.journeys.createAppointmentReminderStarter(SYS);
  const k = await key(['journeys:trigger']);
  expect((await call(k, 'POST', `/api/v1/journeys/${j.id}/trigger`, { external_id: 'MBR-TEST-7005' })).statusCode).toBe(400); // not active
  await ctx.app.services.journeys.activate(j.id, SYS);
  // Unknown contact without contacts:write → refused rather than silently created.
  expect((await call(k, 'POST', `/api/v1/journeys/${j.id}/trigger`, { external_id: 'MBR-TEST-7005' })).statusCode).toBe(403);
  await makeContact(ctx.app, { external_id: 'MBR-TEST-7005' });
  const start = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const body = { external_id: 'MBR-TEST-7005', properties: { appointment_id: 'APT-TEST-7005', start }, idempotency_key: 'trig-1' };
  const res = await call(k, 'POST', `/api/v1/journeys/${j.id}/trigger`, body);
  expect(res.statusCode).toBe(202);
  expect(res.json()).toMatchObject({ event_name: j.definition.trigger.event_name, duplicate: false });
  expect((await call(k, 'POST', `/api/v1/journeys/${j.id}/trigger`, body)).json()).toMatchObject({ duplicate: true });
  await ctx.app.services.journeys.processEvents();
  const runs = await ctx.db.selectFrom('journey_enrollments').selectAll().where('journey_id', '=', j.id).execute();
  expect(runs).toHaveLength(1);
});

test('message status, segments, campaigns and reports are readable with the matching scopes', async () => {
  const tpl = await makeTemplate(ctx.app, emailTemplate());
  const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-7006', first_name: 'Test', email: 'status@example.com', consent: { email: { care: 'granted' } } });
  const m = await ctx.app.services.delivery.enqueue({ contact: c, templateId: tpl.id, source: 'test', data: { date: 'Monday' } });
  const msg = await call(await key(['messages:read']), 'GET', `/api/v1/messages/${m.id}`);
  expect(msg.statusCode).toBe(200);
  expect(msg.json()).toMatchObject({ id: m.id, channel: 'email', status: 'queued' });
  expect(msg.json()).not.toHaveProperty('body_html');
  expect(msg.json()).not.toHaveProperty('subject');

  const all = await key(['segments:read', 'campaigns:read', 'reports:read']);
  expect((await call(all, 'GET', '/api/v1/segments')).json()).toEqual({ data: [] });
  expect((await call(all, 'GET', '/api/v1/campaigns')).json()).toEqual({ data: [] });
  expect((await call(all, 'GET', '/api/v1/reports/overview')).json()).toMatchObject({ contacts: 1 });
});

test('the send API needs contacts:write only when it would write contacts', async () => {
  const tpl = await makeTemplate(ctx.app, emailTemplate());
  await makeContact(ctx.app, { external_id: 'MBR-TEST-7007', first_name: 'Test', email: 'send@example.com', consent: { email: { care: 'granted' } } });
  const k = await key(['messages:send']);
  const send = (recipients: object[]) => call(k, 'POST', '/api/v1/messages/send', { template_id: tpl.id, recipients });
  expect((await send([{ external_id: 'MBR-TEST-7007', properties: { date: 'Monday' } }])).statusCode).toBe(201);
  expect((await send([{ external_id: 'MBR-TEST-NEW', email: 'new@example.com' }])).statusCode).toBe(403);
  expect((await send([{ external_id: 'MBR-TEST-7007', attributes: { city: 'Dubai' } }])).statusCode).toBe(403);
});

test('the OpenAPI spec is served with this deployment as its server', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
  expect(res.statusCode).toBe(200);
  expect(res.json().servers).toEqual([{ url: 'https://engage.example.com/api/v1' }]);
  expect(Object.keys(res.json().paths)).toEqual(expect.arrayContaining(['/track', '/contacts/lookup', '/consent', '/journeys/{journeyId}/trigger']));
});

// ---------- inbound webhooks ----------

const BOOKING = {
  booking: { id: 'APT-TEST-7100', starts_at: '2026-12-01T09:00:00Z', clinic: 'Synthetic Clinic' },
  patient: { member_no: 'MBR-TEST-7100', email: 'hook.member@example.com', given_name: 'Hook', sms_ok: 'yes' },
};
const mapping: InboundMapping = {
  contact: { external_id: 'patient.member_no', email: 'patient.email', first_name: 'patient.given_name' },
  attributes: [{ key: 'clinic', path: 'booking.clinic' }],
  consent: [{ channel: 'sms', purpose: 'care', path: 'patient.sms_ok' }],
  event: { name: 'appointment.booked', properties: [{ key: 'appointment_id', path: 'booking.id' }, { key: 'start', path: 'booking.starts_at' }], idempotency_key: 'booking.id' },
};

test('the field mapping turns any payload into contacts and events', () => {
  const { request, problems } = applyMapping(BOOKING, mapping);
  expect(problems).toEqual([]);
  expect(request.attributes).toEqual([{ external_id: 'MBR-TEST-7100', email: 'hook.member@example.com', first_name: 'Hook', clinic: 'Synthetic Clinic', consent: { sms: { care: 'granted' } } }]);
  expect(request.events).toEqual([{ external_id: 'MBR-TEST-7100', name: 'appointment.booked', properties: { appointment_id: 'APT-TEST-7100', start: '2026-12-01T09:00:00Z' }, idempotency_key: 'APT-TEST-7100' }]);

  const batch = applyMapping({ rows: [BOOKING, { patient: {} }] }, { ...mapping, records: 'rows', contact: { external_id: 'patient.member_no' } });
  expect(batch.request.attributes).toHaveLength(1);
  expect(batch.problems).toEqual(["Record 2: no external ID or email found, so it can't be matched to a contact"]);
  expect(leafPaths(BOOKING).map((p) => p.path)).toContain('patient.member_no');
});

test('inbound webhooks: token or HMAC auth, mapped through the normal ingest path, logged without payloads', async () => {
  const admin = await loginAs(ctx.app, 'admin');
  expect((await admin.request({ method: 'POST', url: '/api/integrations', payload: { name: 'No ref', mapping: { contact: { first_name: 'x' } } } })).statusCode).toBe(400);
  const created = await admin.request({ method: 'POST', url: '/api/integrations', payload: { name: 'Booking tool', mapping } });
  expect(created.statusCode).toBe(201);
  const hook = created.json();
  expect(hook.url).toBe(`https://engage.example.com/hooks/in/${hook.id}`);
  expect(hook.secret).toMatch(/^pe_hook_/);
  expect((await admin.request({ method: 'GET', url: '/api/integrations' })).json().data[0]).not.toHaveProperty('secret');

  const post = (headers: Record<string, string>, body: unknown = BOOKING, url = `/hooks/in/${hook.id}`) =>
    ctx.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(body) });
  expect((await post({})).statusCode).toBe(401);
  expect((await post({ authorization: 'Bearer wrong' })).statusCode).toBe(401);
  expect((await post({}, BOOKING, '/hooks/in/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  const ok = await post({ authorization: `Bearer ${hook.secret}` });
  expect(ok.statusCode).toBe(201);
  expect(ok.json()).toMatchObject({ attributes_processed: 1, events_processed: 1, skipped: [] });
  expect((await post({}, BOOKING, `/hooks/in/${hook.id}?token=${hook.secret}`)).json()).toMatchObject({ duplicates: 1 });

  const contact = await ctx.db.selectFrom('contacts').selectAll().where('external_id', '=', 'MBR-TEST-7100').executeTakeFirstOrThrow();
  expect(contact).toMatchObject({ first_name: 'Hook', attributes: { clinic: 'Synthetic Clinic' }, consent: { sms: { care: 'granted' } } });
  const event = await ctx.db.selectFrom('events').selectAll().executeTakeFirstOrThrow();
  expect(event).toMatchObject({ name: 'appointment.booked', source: `hook:${hook.id}`, idempotency_key: `hook:${hook.id}:APT-TEST-7100` });
  const history = await ctx.db.selectFrom('consent_history').select('source').executeTakeFirstOrThrow();
  expect(history.source).toBe(`hook:${hook.id}`);

  // HMAC mode: signed like our outbound webhooks, rejected when tampered with or stale.
  await admin.request({ method: 'PATCH', url: `/api/integrations/${hook.id}`, payload: { auth: 'hmac' } });
  const body = JSON.stringify(BOOKING);
  expect((await post({ authorization: `Bearer ${hook.secret}` })).statusCode).toBe(401);
  expect((await post({ 'x-pe-signature': signPayload(hook.secret, body) })).statusCode).toBe(201);
  expect((await post({ 'x-pe-signature': signPayload(hook.secret, body) }, { ...BOOKING, extra: 1 })).statusCode).toBe(401);
  expect((await post({ 'x-pe-signature': signPayload(hook.secret, body, Math.floor(Date.now() / 1000) - 3600) })).statusCode).toBe(401);

  // Disabled and rotated sources stop accepting.
  const { secret } = (await admin.request({ method: 'POST', url: `/api/integrations/${hook.id}/rotate-secret` })).json();
  expect((await post({ 'x-pe-signature': signPayload(hook.secret, body) })).statusCode).toBe(401);
  expect((await post({ 'x-pe-signature': signPayload(secret, body) })).statusCode).toBe(201);
  await admin.request({ method: 'PATCH', url: `/api/integrations/${hook.id}`, payload: { enabled: false } });
  expect((await post({ 'x-pe-signature': signPayload(secret, body) })).statusCode).toBe(404);

  // The log has metadata only: no payloads, emails or tokens.
  const rows = await logRows(10);
  expect(rows.filter((r) => r.integration_id === hook.id).map((r) => r.status)).toEqual([401, 401, 201, 201, 401, 201, 401, 401, 401, 201]);
  const dump = JSON.stringify(rows);
  for (const secretish of ['hook.member@example.com', 'MBR-TEST-7100', hook.secret, secret]) expect(dump).not.toContain(secretish);
  expect(rows[2]).toMatchObject({ route: '/hooks/in/:id', method: 'POST', items: 2 });
});

test('the console can test a mapping with a sample, and sees request counts', async () => {
  const admin = await loginAs(ctx.app, 'admin');
  const hook = (await admin.request({ method: 'POST', url: '/api/integrations', payload: { name: 'Form tool', mapping: { ...mapping, event: null } } })).json();
  const res = await admin.request({ method: 'POST', url: `/api/integrations/${hook.id}/test`, payload: { payload: BOOKING } });
  expect(res.statusCode).toBe(201);
  expect(res.json()).toMatchObject({ attributes_processed: 1, events_processed: 0 });
  expect((await admin.request({ method: 'POST', url: `/api/integrations/${hook.id}/test`, payload: { payload: { nothing: true } } })).statusCode).toBe(400);
  const audit = await ctx.db.selectFrom('audit_log').select(['action', 'details']).where('action', '=', 'integration.test').executeTakeFirstOrThrow();
  expect(audit.details).toEqual({ attributes: 1, events: 0 });

  const k = await key(['segments:read'], 'Dashboard');
  await call(k, 'GET', '/api/v1/segments');
  await call(k, 'GET', '/api/v1/campaigns'); // 403
  await logRows(2);
  const overview = (await admin.request({ method: 'GET', url: '/api/integrations/overview' })).json();
  expect(overview).toMatchObject({ api_keys: 1, inbound_webhooks: { total: 1, enabled: 1 }, requests_24h: 2, errors_24h: 1 });
  expect(overview.hourly).toHaveLength(24);
  expect(overview.hourly.at(-1)).toBe(2);
  const log = (await admin.request({ method: 'GET', url: '/api/integrations/requests' })).json().data;
  expect(log[0]).toMatchObject({ api_key_name: 'Dashboard', status: 403, error: expect.stringContaining('campaigns:read') });

  const marketer = await loginAs(ctx.app, 'marketer');
  expect((await marketer.request({ method: 'GET', url: '/api/integrations' })).statusCode).toBe(403);
});

test('the JavaScript SDK works against the real API, and verifies our outbound signatures', async () => {
  const { PureEngage, PureEngageError, verifyWebhook, signWebhook } = await import('@pure-engage/sdk');
  // Route the SDK's fetch into the app in-process.
  const fetchViaInject = (async (url: string, init: RequestInit) => {
    const res = await ctx.app.inject({ method: init.method as 'GET', url: new URL(url).pathname, headers: init.headers as Record<string, string>, ...(init.body ? { payload: String(init.body) } : {}) });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const pe = new PureEngage({ baseUrl: 'https://engage.example.com', apiKey: await key(['contacts:write', 'consent:write', 'events:write', 'contacts:read']), fetch: fetchViaInject });
  expect(await pe.identify({ external_id: 'MBR-TEST-7200', email: 'sdk@example.com' })).toMatchObject({ attributes_processed: 1 });
  expect(await pe.track({ external_id: 'MBR-TEST-7200', name: 'sdk.test', idempotency_key: 'sdk-1' })).toMatchObject({ events_processed: 1 });
  expect(await pe.setConsent({ external_id: 'MBR-TEST-7200' }, { sms: { care: 'granted' } })).toMatchObject({ consent: { sms: { care: 'granted' } } });
  expect(await pe.lookupContact({ external_id: 'MBR-TEST-7200' })).toMatchObject({ email: 's***@example.com', masked: true });
  await expect(pe.listSegments()).rejects.toBeInstanceOf(PureEngageError);

  const body = JSON.stringify({ id: 'evt_test', type: 'event' });
  expect(await verifyWebhook(signPayload('whsec_test', body), body, 'whsec_test')).toBe(true);
  expect(await signWebhook('whsec_test', body, 1767225600)).toBe(signPayload('whsec_test', body, 1767225600));
});
