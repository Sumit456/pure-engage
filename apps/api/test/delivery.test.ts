import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { SMTPServer } from 'smtp-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { apiKey, emailTemplate, makeContact, makeTemplate, smsTemplate, testApp, truncateAll } from './helpers.ts';

// 2026-01-10 10:00 in Dubai (UTC+4) unless a test moves the clock.
let now = new Date('2026-01-10T06:00:00Z');
const clock = () => now;
const consentAll = { email: { care: 'granted', marketing: 'granted' }, sms: { care: 'granted', marketing: 'granted' } };

describe('sandbox delivery and policy', () => {
  let ctx: Awaited<ReturnType<typeof testApp>>;
  beforeAll(async () => { ctx = await testApp({}, { clock }); });
  afterAll(async () => { await ctx.close(); });
  beforeEach(async () => { await truncateAll(ctx.db); now = new Date('2026-01-10T06:00:00Z'); });

  const enqueue = (contact: Awaited<ReturnType<typeof makeContact>>, templateId: string, extra: Record<string, unknown> = {}) =>
    ctx.app.services.delivery.enqueue({ contact, templateId, data: { date: '12 January' }, source: 'test', ...extra });

  test('renders, escapes, tracks links and sends through the sandbox', async () => {
    const t = await makeTemplate(ctx.app, emailTemplate());
    const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-1', email: 'test.member@example.com', first_name: '<b>Test</b>', consent: consentAll });
    const m = await enqueue(c, t.id);
    expect(m).toMatchObject({ status: 'queued', locale: 'en', to_address: 'test.member@example.com', subject: 'Your appointment, <b>Test</b>' });
    expect(m.body_html).toContain('Hello &lt;b&gt;Test&lt;/b&gt;');
    expect(m.body_html).toContain('https://engage.example.com/t/c/');
    expect(m.body_html).not.toContain('href="https://example.com/appointments');
    expect(m.body_html).toContain('/t/o/');
    expect(m.body_html).not.toContain('/u/'); // care email: no marketing unsubscribe footer
    expect(m.body_text).toContain('Manage (https://example.com/appointments?id=1&src=email)');

    expect(await ctx.app.services.delivery.dispatchOnce()).toBe(1);
    const sent = await ctx.app.services.delivery.get(m.id);
    expect(sent).toMatchObject({ status: 'sent', provider: 'sandbox', attempts: 1 });
    expect(sent.events.map((e) => e.type)).toEqual(['sent']);
  });

  test('Arabic contacts get the Arabic version, right-to-left; English fallback when missing', async () => {
    const t = await makeTemplate(ctx.app, emailTemplate());
    const ar = await makeContact(ctx.app, { external_id: 'MBR-TEST-2', email: 'a@example.com', first_name: 'ليلى', preferred_language: 'ar', consent: consentAll });
    const m = await enqueue(ar, t.id);
    expect(m.locale).toBe('ar');
    expect(m.body_html).toContain('dir="rtl"');
    const enOnly = await makeTemplate(ctx.app, emailTemplate({ content: { en: { subject: 'EN only', html: '<p>Hi</p>' } } }));
    expect((await enqueue(ar, enOnly.id)).locale).toBe('en');
  });

  test('consent, address, suppression list and marketing cap are enforced; nothing is rendered when suppressed', async () => {
    const care = await makeTemplate(ctx.app, emailTemplate());
    const marketing = await makeTemplate(ctx.app, emailTemplate({ name: 'Promo', purpose: 'marketing' }));
    const noConsent = await makeContact(ctx.app, { external_id: 'MBR-TEST-3', email: 'n@example.com' });
    const careOnly = await makeContact(ctx.app, { external_id: 'MBR-TEST-4', email: 'c@example.com', consent: { email: { care: 'granted' } } });
    const noEmail = await makeContact(ctx.app, { external_id: 'MBR-TEST-5', consent: consentAll });
    const blocked = await makeContact(ctx.app, { external_id: 'MBR-TEST-6', email: 'Blocked@Example.com', consent: consentAll });
    await ctx.app.services.delivery.suppress('email', 'blocked@example.com', 'bounce');

    const a = await enqueue(noConsent, care.id);
    expect(a).toMatchObject({ status: 'suppressed', status_reason: 'no_consent', body_html: null, subject: null });
    expect((await enqueue(careOnly, marketing.id)).status_reason).toBe('no_consent');
    expect((await enqueue(careOnly, care.id)).status).toBe('queued');
    expect((await enqueue(noEmail, care.id)).status_reason).toBe('no_address');
    expect((await enqueue(blocked, care.id)).status_reason).toBe('suppressed_address');

    const fan = await makeContact(ctx.app, { external_id: 'MBR-TEST-7', email: 'f@example.com', consent: consentAll });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await enqueue(fan, marketing.id)).status_reason ?? 'ok');
    expect(statuses).toEqual(['ok', 'ok', 'ok', 'frequency_cap']);
  });

  test('marketing email carries a signed unsubscribe link and footer', async () => {
    const marketing = await makeTemplate(ctx.app, emailTemplate({ name: 'Promo', purpose: 'marketing' }));
    const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-8', email: 'm@example.com', consent: consentAll });
    const m = await enqueue(c, marketing.id);
    expect(m.body_html).toMatch(/https:\/\/engage\.example\.com\/u\/[0-9a-f-]{36}\.[\w-]+/);
    expect(m.body_text).toContain('Unsubscribe: https://engage.example.com/u/');
  });

  test('SMS respects quiet hours in the contact time zone (deferred to 08:00), email does not', async () => {
    now = new Date('2026-01-10T18:30:00Z'); // 22:30 in Dubai
    const sms = await makeTemplate(ctx.app, smsTemplate());
    const email = await makeTemplate(ctx.app, emailTemplate());
    const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-9', email: 'q@example.com', phone: '+971500000009', consent: consentAll });
    const deferred = await enqueue(c, sms.id);
    expect(deferred).toMatchObject({ status: 'deferred', status_reason: 'quiet_hours' });
    expect(deferred.next_attempt_at?.toISOString()).toBe('2026-01-11T04:00:00.000Z'); // 08:00 Dubai
    expect((await enqueue(c, email.id)).status).toBe('queued');
    expect((await enqueue(c, sms.id, { bypassQuietHours: true })).status).toBe('queued');

    // London contact at the same instant is 18:30 local: not quiet.
    const london = await makeContact(ctx.app, { external_id: 'MBR-TEST-10', phone: '+447700900000', timezone: 'Europe/London', consent: consentAll });
    expect((await enqueue(london, sms.id)).status).toBe('queued');

    expect(await ctx.app.services.delivery.dispatchOnce()).toBe(3); // the deferred one isn't due yet
    now = new Date('2026-01-11T04:00:00Z');
    expect(await ctx.app.services.delivery.dispatchOnce()).toBe(1);
    expect((await ctx.app.services.delivery.get(deferred.id)).status).toBe('sent');
  });

  test('consent withdrawn while queued stops the send', async () => {
    const t = await makeTemplate(ctx.app, emailTemplate());
    const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-11', email: 'w@example.com', consent: consentAll });
    const m = await enqueue(c, t.id);
    await ctx.app.services.contacts.upsert({ contact_id: c.id, consent: { email: { care: 'denied' } } }, { source: 'test', actor: { type: 'system' } });
    await ctx.app.services.delivery.dispatchOnce();
    expect(await ctx.app.services.delivery.get(m.id)).toMatchObject({ status: 'suppressed', status_reason: 'no_consent' });
  });

  test('idempotency key returns the original message', async () => {
    const t = await makeTemplate(ctx.app, emailTemplate());
    const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-12', email: 'i@example.com', consent: consentAll });
    const a = await enqueue(c, t.id, { idempotencyKey: 'appt-1-confirm' });
    const b = await enqueue(c, t.id, { idempotencyKey: 'appt-1-confirm' });
    expect(b.id).toBe(a.id);
  });

  test('tracking: open pixel, signed click redirect, tampered links rejected', async () => {
    const t = await makeTemplate(ctx.app, emailTemplate());
    const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-13', email: 't@example.com', consent: consentAll });
    const m = await enqueue(c, t.id);
    const pixel = /src="https:\/\/engage\.example\.com(\/t\/o\/[^"]+)"/.exec(m.body_html!)![1]!;
    const click = /href="https:\/\/engage\.example\.com(\/t\/c\/[^"]+)"/.exec(m.body_html!)![1]!.replace(/&amp;/g, '&');

    const open = await ctx.app.inject({ method: 'GET', url: pixel });
    expect(open.headers['content-type']).toBe('image/gif');
    const redirect = await ctx.app.inject({ method: 'GET', url: click });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('https://example.com/appointments?id=1&src=email');
    const msg = await ctx.app.services.delivery.get(m.id);
    expect(msg.opened_at).not.toBeNull();
    expect(msg.clicked_at).not.toBeNull();
    expect(msg.events.map((e) => e.type)).toEqual(['open', 'click']);

    const evil = click.replace(encodeURIComponent('https://example.com/appointments?id=1&src=email'), encodeURIComponent('https://evil.example.net/'));
    expect((await ctx.app.inject({ method: 'GET', url: evil })).statusCode).toBe(400);
    const forged = pixel.replace(/\.[\w-]+\.gif$/, '.AAAAAAAAAAAAAAAAAAAAAA.gif');
    expect((await ctx.app.inject({ method: 'GET', url: forged })).statusCode).toBe(200); // pixel always answers…
    expect((await ctx.app.services.delivery.get(m.id)).events).toHaveLength(2); // …but records nothing
  });

  test('unsubscribe: GET only shows a form; POST (or one-click) withdraws marketing consent', async () => {
    const marketing = await makeTemplate(ctx.app, emailTemplate({ name: 'Promo', purpose: 'marketing' }));
    const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-14', email: 'u@example.com', consent: consentAll });
    const m = await enqueue(c, marketing.id);
    const path = /https:\/\/engage\.example\.com(\/u\/[^"\s]+)/.exec(m.body_text!)![1]!;

    const get = await ctx.app.inject({ method: 'GET', url: path });
    expect(get.body).toContain('<form method="post">');
    expect((await ctx.app.services.contacts.get(c.id)).consent.email?.marketing).toBe('granted');

    const post = await ctx.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(post.statusCode).toBe(200);
    const after = await ctx.app.services.contacts.get(c.id);
    expect(after.consent).toEqual({ ...consentAll, email: { care: 'granted', marketing: 'denied' } });
    const h = await ctx.db.selectFrom('consent_history').selectAll().where('source', '=', 'unsubscribe').executeTakeFirstOrThrow();
    expect(h).toMatchObject({ channel: 'email', purpose: 'marketing', status: 'denied' });
    expect((await ctx.app.inject({ method: 'POST', url: '/u/not-a-token' })).statusCode).toBe(404);
  });

  test('transactional send API (contract shape), with per-recipient errors', async () => {
    const t = await makeTemplate(ctx.app, emailTemplate());
    const key = await apiKey(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/messages/send', headers: { authorization: `Bearer ${key}` },
      payload: { template_id: t.id, recipients: [
        { external_id: 'MBR-TEST-20', email: 'x@example.com', attributes: { consent: { email: { care: 'granted' } } }, properties: { date: '1 Feb' } },
        { external_id: 'MBR-TEST-21', email: 'y@example.com' },
        { properties: {} },
      ] },
    });
    expect(res.statusCode).toBe(207);
    const [ok, noConsent, bad] = res.json().results;
    expect(ok).toMatchObject({ status: 'queued', reason: null });
    expect(noConsent).toMatchObject({ status: 'suppressed', reason: 'no_consent' });
    expect(bad.error).toContain('required');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/messages/send', payload: { template_id: t.id, recipients: [{}] } })).statusCode).toBe(401);
  });
});

describe('live providers', () => {
  let smtp: SMTPServer;
  let smtpPort = 0;
  const received: { to: string[]; raw: string }[] = [];
  let smtpReply: { code: number; message: string } | null = null;

  let twilio: Server;
  let twilioPort = 0;
  const twilioCalls: { auth: string; form: URLSearchParams }[] = [];
  let twilioReply: { status: number; body: object } = { status: 201, body: { sid: 'SM00000000000000000000000000000001' } };

  let ctx: Awaited<ReturnType<typeof testApp>>;

  beforeAll(async () => {
    smtp = new SMTPServer({
      authOptional: true, disabledCommands: ['STARTTLS'], logger: false,
      onRcptTo(_addr, _session, cb) {
        if (smtpReply) { const e = Object.assign(new Error(smtpReply.message), { responseCode: smtpReply.code }); return cb(e); }
        cb();
      },
      onData(stream, session, cb) {
        let raw = '';
        stream.on('data', (d: Buffer) => { raw += d.toString(); });
        stream.on('end', () => { received.push({ to: session.envelope.rcptTo.map((r) => r.address), raw }); cb(); });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
    smtpPort = (smtp.server.address() as { port: number }).port;

    twilio = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        twilioCalls.push({ auth: req.headers.authorization ?? '', form: new URLSearchParams(body) });
        res.writeHead(twilioReply.status, { 'content-type': 'application/json' }).end(JSON.stringify(twilioReply.body));
      });
    });
    await new Promise<void>((r) => twilio.listen(0, '127.0.0.1', r));
    twilioPort = (twilio.address() as { port: number }).port;

    ctx = await testApp({
      PE_DELIVERY_MODE: 'live',
      PE_SMTP_URL: `smtp://127.0.0.1:${smtpPort}?ignoreTLS=true`,
      PE_EMAIL_FROM: 'Pure Engage <no-reply@example.com>',
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'twilio-test-token',
      TWILIO_FROM: '+15005550006',
      PE_TWILIO_API_BASE: `http://127.0.0.1:${twilioPort}`,
      PE_DELIVERY_ALLOWLIST: '@example.com,+971500000001',
    }, { clock });
  });
  afterAll(async () => { await ctx.close(); await new Promise((r) => smtp.close(() => r(null))); await new Promise((r) => twilio.close(r)); });
  beforeEach(async () => { await truncateAll(ctx.db); received.length = 0; twilioCalls.length = 0; smtpReply = null; twilioReply = { status: 201, body: { sid: 'SM00000000000000000000000000000001' } }; now = new Date('2026-01-10T06:00:00Z'); });
  afterEach(() => { smtpReply = null; });

  const send = async (template: Record<string, unknown>, contact: Record<string, unknown>) => {
    const t = await makeTemplate(ctx.app, template);
    const c = await makeContact(ctx.app, { consent: consentAll, ...contact });
    const m = await ctx.app.services.delivery.enqueue({ contact: c, templateId: t.id, data: { date: '12 January' }, source: 'test' });
    await ctx.app.services.delivery.dispatchOnce();
    return ctx.app.services.delivery.get(m.id);
  };

  test('SMTP delivers real mail; marketing mail has RFC 8058 one-click unsubscribe headers', async () => {
    const m = await send(emailTemplate({ purpose: 'marketing' }), { external_id: 'MBR-TEST-30', email: 'test.member@example.com', first_name: 'Test' });
    expect(m).toMatchObject({ status: 'sent', provider: 'smtp' });
    expect(received).toHaveLength(1);
    expect(received[0]!.to).toEqual(['test.member@example.com']);
    const raw = received[0]!.raw.replace(/\r\n[ \t]+/g, ' '); // unfold RFC 5322 continuation lines
    expect(raw).toMatch(/^Subject: Your appointment, Test/m);
    expect(raw).toMatch(/^List-Unsubscribe: <https:\/\/engage\.example\.com\/u\//m);
    expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
    expect(raw).toMatch(new RegExp(`^X-PE-Message-Id: ${m.id}`, 'mi'));
  });

  test('SMTP 5xx is permanent; 4xx is retried with backoff', async () => {
    smtpReply = { code: 550, message: 'No such user' };
    const hard = await send(emailTemplate(), { external_id: 'MBR-TEST-31', email: 'gone@example.com' });
    expect(hard).toMatchObject({ status: 'failed' });
    expect(hard.status_reason).toContain('No such user');

    smtpReply = { code: 451, message: 'Try later' };
    const soft = await send(emailTemplate(), { external_id: 'MBR-TEST-32', email: 'busy@example.com' });
    expect(soft).toMatchObject({ status: 'queued', attempts: 1 });
    expect(soft.next_attempt_at!.getTime() - now.getTime()).toBe(60_000);
    expect(soft.events.map((e) => e.type)).toEqual(['retry']);

    smtpReply = null;
    now = new Date(now.getTime() + 60_000);
    await ctx.app.services.delivery.dispatchOnce();
    expect((await ctx.app.services.delivery.get(soft.id)).status).toBe('sent');
  });

  test('Twilio receives the SMS with auth, sender and status callback; signed receipts mark it delivered', async () => {
    const m = await send(smsTemplate(), { external_id: 'MBR-TEST-33', phone: '+971500000001', first_name: 'Test' });
    expect(m).toMatchObject({ status: 'sent', provider: 'twilio', provider_message_id: 'SM00000000000000000000000000000001' });
    const call = twilioCalls[0]!;
    expect(call.auth).toBe(`Basic ${Buffer.from('ACtest:twilio-test-token').toString('base64')}`);
    expect(Object.fromEntries(call.form)).toMatchObject({ To: '+971500000001', From: '+15005550006', Body: 'Hi Test, reminder: appointment 12 January.', StatusCallback: 'https://engage.example.com/hooks/twilio/status' });

    const params = { MessageSid: 'SM00000000000000000000000000000001', MessageStatus: 'delivered', AccountSid: 'ACtest' };
    const url = 'https://engage.example.com/hooks/twilio/status';
    const sig = createHmac('sha1', 'twilio-test-token').update(url + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join('')).digest('base64');
    const form = new URLSearchParams(params).toString();
    const forged = await ctx.app.inject({ method: 'POST', url: '/hooks/twilio/status', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'bad' }, payload: form });
    expect(forged.statusCode).toBe(403);
    const ok = await ctx.app.inject({ method: 'POST', url: '/hooks/twilio/status', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, payload: form });
    expect(ok.statusCode).toBe(204);
    expect((await ctx.app.services.delivery.get(m.id)).status).toBe('delivered');
  });

  test('Twilio 5xx retries, 4xx fails permanently', async () => {
    twilioReply = { status: 503, body: { message: 'Service unavailable' } };
    expect((await send(smsTemplate(), { external_id: 'MBR-TEST-34', phone: '+971500000001' })).status).toBe('queued');
    twilioReply = { status: 400, body: { code: 21211, message: "The 'To' number is not valid" } };
    const bad = await send(smsTemplate(), { external_id: 'MBR-TEST-35', phone: '+971500000001' });
    expect(bad.status).toBe('failed');
    expect(bad.status_reason).toContain('21211');
  });

  test('the live allowlist suppresses anyone not on it', async () => {
    const m = await send(emailTemplate(), { external_id: 'MBR-TEST-36', email: 'someone@other.example.org' });
    expect(m).toMatchObject({ status: 'suppressed', status_reason: 'not_in_allowlist' });
    expect(received).toHaveLength(0);
  });
});

describe('console message views', () => {
  let ctx: Awaited<ReturnType<typeof testApp>>;
  beforeAll(async () => { ctx = await testApp({}, { clock }); });
  afterAll(async () => { await ctx.close(); });

  test('viewing a message is audited and its preview has no open pixel', async () => {
    await truncateAll(ctx.db);
    const { loginAs } = await import('./helpers.ts');
    const viewer = await loginAs(ctx.app, 'viewer');
    const t = await makeTemplate(ctx.app, emailTemplate());
    const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-40', email: 'v@example.com', consent: consentAll });
    const m = await ctx.app.services.delivery.enqueue({ contact: c, templateId: t.id, source: 'test' });
    const res = (await viewer.request({ method: 'GET', url: `/api/messages/${m.id}` })).json();
    expect(res).not.toHaveProperty('body_html');
    expect(res.body_html_preview).not.toContain('/t/o/');
    expect(res.body_html_preview).not.toContain('/t/c/');
    expect(res.body_html_preview).toContain('href="https://example.com/appointments');
    const list = (await viewer.request({ method: 'GET', url: `/api/messages?contact_id=${c.id}` })).json();
    expect(list.data[0]).toMatchObject({ id: m.id, template_name: 'Appointment confirmation', status: 'queued' });
    expect(list.data[0]).not.toHaveProperty('body_html');
    expect(await ctx.db.selectFrom('audit_log').select('action').where('action', '=', 'message.view').execute()).toHaveLength(1);
  });

  test('a viewer never receives the signed unsubscribe link', async () => {
    await truncateAll(ctx.db);
    const { loginAs } = await import('./helpers.ts');
    const viewer = await loginAs(ctx.app, 'viewer');
    const t = await makeTemplate(ctx.app, emailTemplate({ name: 'Promo', purpose: 'marketing' }));
    const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-41', email: 'u@example.com', consent: consentAll });
    const m = await ctx.app.services.delivery.enqueue({ contact: c, templateId: t.id, source: 'test' });
    expect(m.body_html).toContain('/u/');
    const raw = (await viewer.request({ method: 'GET', url: `/api/messages/${m.id}` })).body;
    expect(raw).not.toMatch(/\/(u|t\/[oc])\/[0-9a-f-]{36}\./);
  });
});
