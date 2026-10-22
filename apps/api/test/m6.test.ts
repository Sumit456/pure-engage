import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { parseRange, toCsv } from '../src/services/reports.ts';
import { emailTemplate, loginAs, makeContact, makeTemplate, testApp, truncateAll } from './helpers.ts';

let now = new Date('2026-03-10T08:00:00Z');
const clock = () => now;
const SYS = { type: 'system' as const };

describe('outbound webhooks', () => {
  let ctx: Awaited<ReturnType<typeof testApp>>;
  let receiver: Server;
  let port = 0;
  const hits: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let reply = 200;

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { hits.push({ headers: req.headers, body }); res.writeHead(reply).end('ok'); });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    port = (receiver.address() as { port: number }).port;
    ctx = await testApp({ PE_WEBHOOKS_ALLOW_PRIVATE: 'true' }, { clock });
  });
  afterAll(async () => { await ctx.close(); await new Promise((r) => receiver.close(r)); });
  beforeEach(async () => { await truncateAll(ctx.db); hits.length = 0; reply = 200; now = new Date('2026-03-10T08:00:00Z'); });

  const track = (name: string) => ctx.app.services.events.track({ external_id: 'MBR-TEST-WH', email: 'wh@example.com', name, properties: { appointment_id: 'APT-1' } }, { source: 'api', actor: SYS });

  test('matching events are delivered, signed, with identifiers only (no profile data)', async () => {
    const hook = await ctx.app.services.webhooks.create({ name: 'CRM', url: `http://127.0.0.1:${port}/hook`, events: ['purenet.appointment.booked'] }, SYS);
    expect(hook.secret).toMatch(/^whsec_/);
    const stored = await ctx.db.selectFrom('webhooks').select('secret_encrypted').executeTakeFirstOrThrow();
    expect(stored.secret_encrypted).not.toContain(hook.secret); // encrypted at rest

    await track('purenet.appointment.booked');
    await track('something.else'); // filtered out
    await ctx.app.services.worker.tick();

    expect(hits).toHaveLength(1);
    const { headers, body } = hits[0]!;
    expect(headers['x-pe-event']).toBe('purenet.appointment.booked');
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(headers['x-pe-signature']))!;
    expect(v1).toBe(createHmac('sha256', hook.secret).update(`${t}.${body}`).digest('hex'));
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({ type: 'event', event: { name: 'purenet.appointment.booked', properties: { appointment_id: 'APT-1' } }, contact: { external_id: 'MBR-TEST-WH' } });
    expect(body).not.toContain('wh@example.com');
  });

  test('failures retry with backoff, then succeed; deliveries are logged', async () => {
    const hook = await ctx.app.services.webhooks.create({ name: 'Flaky', url: `http://127.0.0.1:${port}/hook`, events: ['*'] }, SYS);
    reply = 503;
    await track('visit.completed');
    await ctx.app.services.worker.tick();
    let [d] = await ctx.app.services.webhooks.deliveries(hook.id);
    expect(d).toMatchObject({ status: 'pending', attempts: 1, response_code: 503 });
    expect(d!.next_attempt_at!.getTime() - now.getTime()).toBe(60_000);

    reply = 200;
    now = new Date(now.getTime() + 60_000);
    await ctx.app.services.worker.tick();
    [d] = await ctx.app.services.webhooks.deliveries(hook.id);
    expect(d).toMatchObject({ status: 'success', attempts: 2, response_code: 200 });
  });

  test('rotating the secret changes the signature key; test sends work', async () => {
    const hook = await ctx.app.services.webhooks.create({ name: 'Rotate', url: `http://127.0.0.1:${port}/hook` }, SYS);
    const { secret } = await ctx.app.services.webhooks.rotateSecret(hook.id, SYS);
    expect(secret).not.toBe(hook.secret);
    const d = await ctx.app.services.webhooks.test(hook.id, SYS);
    expect(d.status).toBe('success');
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(hits[0]!.headers['x-pe-signature']))!;
    expect(v1).toBe(createHmac('sha256', secret).update(`${t}.${hits[0]!.body}`).digest('hex'));
  });

  test('admin-only API never returns the stored secret', async () => {
    const admin = await loginAs(ctx.app, 'admin');
    const marketer = await loginAs(ctx.app, 'marketer');
    expect((await marketer.request({ method: 'GET', url: '/api/webhooks' })).statusCode).toBe(403);
    const created = (await admin.request({ method: 'POST', url: '/api/webhooks', payload: { name: 'x', url: `http://127.0.0.1:${port}/h` } })).json();
    const listed = (await admin.request({ method: 'GET', url: '/api/webhooks' })).body;
    expect(listed).not.toContain(created.secret);
    expect(listed).not.toContain('secret_encrypted');
  });
});

describe('SSRF protection', () => {
  let ctx: Awaited<ReturnType<typeof testApp>>;
  beforeAll(async () => { ctx = await testApp({}, { clock }); });
  afterAll(async () => { await ctx.close(); });
  beforeEach(async () => { await truncateAll(ctx.db); });

  test('plain http is refused; https to a private or loopback address is blocked at send time', async () => {
    await expect(ctx.app.services.webhooks.create({ name: 'x', url: 'http://example.com/hook' }, SYS)).rejects.toMatchObject({ statusCode: 400 });
    await expect(ctx.app.services.webhooks.create({ name: 'x', url: 'https://user:pw@example.com/hook' }, SYS)).rejects.toMatchObject({ statusCode: 400 });
    for (const url of ['https://127.0.0.1/hook', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/hook', 'https://10.1.2.3/x']) {
      const hook = await ctx.app.services.webhooks.create({ name: 'x', url }, SYS);
      const d = await ctx.app.services.webhooks.test(hook.id, SYS);
      expect(d.status).toBe('failed');
      expect(d.error).toContain('blocked');
    }
  });
});

describe('reports, retention, SMS STOP and console hosting', () => {
  let ctx: Awaited<ReturnType<typeof testApp>>;
  const consoleDir = mkdtempSync(path.join(tmpdir(), 'pe-console-'));
  mkdirSync(path.join(consoleDir, 'assets'));
  writeFileSync(path.join(consoleDir, 'index.html'), '<!doctype html><title>Pure Engage</title>');
  writeFileSync(path.join(consoleDir, 'assets', 'app-abc123.js'), 'console.log(1)');

  beforeAll(async () => {
    ctx = await testApp({ TWILIO_AUTH_TOKEN: 'twilio-test-token', PE_CONSOLE_DIR: consoleDir }, { clock });
  });
  afterAll(async () => { await ctx.close(); });
  beforeEach(async () => { await truncateAll(ctx.db); now = new Date('2026-03-10T08:00:00Z'); });

  test('overview and daily report count by day in the platform time zone, zero-filled', async () => {
    const t = await makeTemplate(ctx.app, emailTemplate());
    const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-R1', email: 'r1@example.com', consent: { email: { care: 'granted' } } });
    const blocked = await makeContact(ctx.app, { external_id: 'MBR-TEST-R2', email: 'r2@example.com' });
    now = new Date('2026-03-09T21:30:00Z'); // 01:30 on the 10th in Dubai
    await ctx.app.services.delivery.enqueue({ contact: c, templateId: t.id, source: 'test' });
    await ctx.app.services.delivery.enqueue({ contact: blocked, templateId: t.id, source: 'test' });
    await ctx.app.services.delivery.dispatchOnce();
    now = new Date('2026-03-10T08:00:00Z');

    const viewer = await loginAs(ctx.app, 'viewer');
    const overview = (await viewer.request({ method: 'GET', url: '/api/reports/overview' })).json();
    expect(overview).toMatchObject({ contacts: 2, consent: { email_care: 1 }, messages: { sent: 1, not_sent: 1 }, email: { sent: 1, open_rate: 0 } });

    const report = (await viewer.request({ method: 'GET', url: '/api/reports/messages?from=2026-03-09&to=2026-03-10' })).json();
    expect(report.days).toHaveLength(4); // 2 days × 2 channels
    expect(report.days.find((d: { day: string; channel: string }) => d.day === '2026-03-10' && d.channel === 'email')).toMatchObject({ sent: 1, not_sent: 1 });
    expect(report.days.find((d: { day: string; channel: string }) => d.day === '2026-03-09' && d.channel === 'email')).toMatchObject({ sent: 0 });
    expect(report.not_sent).toEqual([{ reason: 'no_consent', count: 1 }]);

    const csv = await viewer.request({ method: 'GET', url: '/api/reports/messages.csv?from=2026-03-10&to=2026-03-10' });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toBe('day,channel,sent,delivered,opened,clicked,failed,not_sent');
    expect((await viewer.request({ method: 'GET', url: '/api/reports/messages?from=2026-03-10&to=2025-01-01' })).statusCode).toBe(400);
  });

  test('CSV cells cannot become spreadsheet formulas; ranges are bounded', () => {
    expect(toCsv(['a'], [['=HYPERLINK("x")'], ['+1'], ['-2'], ['@cmd'], ['plain, with comma']])).toBe('a\r\n"\'=HYPERLINK(""x"")"\r\n\'+1\r\n\'-2\r\n\'@cmd\r\n"plain, with comma"\r\n');
    expect(toCsv(['n'], [[-5]])).toBe('n\r\n-5\r\n'); // numbers are not text, so no prefix
    expect(() => parseRange('2024-01-01', '2026-01-01', now)).toThrow();
    expect(parseRange(undefined, '2026-03-10', now)).toEqual({ from: '2026-02-09', to: '2026-03-10' });
  });

  test('retention clears old message bodies but keeps delivery metadata, at most daily', async () => {
    const t = await makeTemplate(ctx.app, emailTemplate());
    const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-RET', email: 'ret@example.com', consent: { email: { care: 'granted' } } });
    now = new Date('2025-11-01T08:00:00Z');
    const old = await ctx.app.services.delivery.enqueue({ contact: c, templateId: t.id, source: 'test' });
    await ctx.app.services.delivery.dispatchOnce();
    now = new Date('2026-03-10T08:00:00Z');
    const fresh = await ctx.app.services.delivery.enqueue({ contact: c, templateId: t.id, source: 'test' });

    expect(await ctx.app.services.retention.runIfDue()).toMatchObject({ message_bodies_cleared: 1 });
    expect(await ctx.app.services.retention.runIfDue()).toBeNull(); // already ran today
    now = new Date('2026-03-11T08:00:01Z'); // a day later it runs again (and must not deadlock on its own lock)
    expect(await ctx.app.services.retention.runIfDue()).toMatchObject({ message_bodies_cleared: 0 });
    now = new Date('2026-03-10T08:00:00Z');
    const o = await ctx.app.services.delivery.get(old.id);
    expect(o).toMatchObject({ status: 'sent', body_html: null, body_text: null, subject: null });
    expect((await ctx.app.services.delivery.get(fresh.id)).body_html).not.toBeNull();
  });

  test('replying STOP (English or Arabic) withdraws SMS marketing consent; unsigned requests are refused', async () => {
    const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-STOP', phone: '+971500000055', consent: { sms: { care: 'granted', marketing: 'granted' } } });
    const send = (params: Record<string, string>, sig?: string) => {
      const url = 'https://engage.example.com/hooks/twilio/inbound';
      const signature = sig ?? createHmac('sha1', 'twilio-test-token').update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');
      return ctx.app.inject({ method: 'POST', url: '/hooks/twilio/inbound', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, payload: new URLSearchParams(params).toString() });
    };
    expect((await send({ From: '+971500000055', Body: 'STOP' }, 'forged')).statusCode).toBe(403);
    expect((await send({ From: '+971500000055', Body: 'hello' })).statusCode).toBe(200);
    expect((await ctx.app.services.contacts.get(c.id)).consent.sms?.marketing).toBe('granted');
    const res = await send({ From: '+971500000055', Body: ' إلغاء ' });
    expect(res.headers['content-type']).toContain('text/xml');
    expect((await ctx.app.services.contacts.get(c.id)).consent.sms).toEqual({ care: 'granted', marketing: 'denied' });
    const h = await ctx.db.selectFrom('consent_history').selectAll().where('source', '=', 'sms_stop').executeTakeFirstOrThrow();
    expect(h).toMatchObject({ channel: 'sms', purpose: 'marketing', status: 'denied' });
  });

  test('the API serves the console with SPA fallback, cache headers, and no path traversal', async () => {
    const root = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(root.body).toContain('<title>Pure Engage</title>');
    expect((await ctx.app.inject({ method: 'GET', url: '/contacts/123' })).body).toContain('<title>Pure Engage</title>');
    const asset = await ctx.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.headers['content-type']).toContain('javascript');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/nope' })).json()).toEqual({ error: 'Not found' });
    const traversal = await ctx.app.inject({ method: 'GET', url: '/..%2f..%2fetc%2fpasswd' });
    expect(traversal.body).not.toContain('root:');
    expect(traversal.body).toContain('<title>Pure Engage</title>');
    expect(root.headers['content-security-policy']).toBeDefined();
  });
});
