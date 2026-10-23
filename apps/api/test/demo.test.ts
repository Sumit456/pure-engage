import { afterAll, beforeAll, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { seedDemo } from '../src/demo/seed.ts';
import { selectProviders, smtpConfigured, smtpTransportOptions } from '../src/services/providers.ts';
import { testApp, truncateAll } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => { ctx = await testApp(); await truncateAll(ctx.db); });
afterAll(async () => { await ctx.close(); });

test('the demo seed fills every screen once, with synthetic values only', async () => {
  expect(await seedDemo(ctx.app.services)).toBe(true);
  expect(await seedDemo(ctx.app.services)).toBe(false);

  const contacts = await ctx.db.selectFrom('contacts').select(['external_id', 'email', 'phone', 'first_name']).execute();
  expect(contacts).toHaveLength(20);
  for (const c of contacts) {
    expect(c.external_id).toMatch(/^MBR-TEST-\d+$/);
    expect(c.email).toMatch(/@example\.com$/);
    expect(c.phone).toMatch(/^\+971500000\d{3}$/);
    expect(c.first_name).toBe('Test');
  }
  expect(await ctx.db.selectFrom('segments').select('id').execute()).toHaveLength(3);
  expect((await ctx.db.selectFrom('campaigns').select('status').orderBy('name').execute()).map((c) => c.status)).toEqual(['scheduled', 'draft']);
  expect(await ctx.db.selectFrom('journeys').select('status').execute()).toEqual([{ status: 'active' }]);

  // The worker turns the seed into a sent campaign, journey runs and sandbox messages.
  for (let i = 0; i < 4; i++) await ctx.app.services.worker.tick();
  const sent = await ctx.db.selectFrom('messages').select(['to_address', 'status']).where('status', 'in', ['sent', 'delivered']).execute();
  expect(sent.length).toBeGreaterThan(5);
  for (const m of sent) expect(m.to_address).toMatch(/@example\.com$|^\+971500000\d{3}$/);
  expect(await ctx.db.selectFrom('journey_enrollments').select('id').execute()).toHaveLength(5);
});

test('PE_SECRET_KEY takes a 32-byte base64 key or any random string of 32+ characters', () => {
  const b64 = Buffer.alloc(32, 7).toString('base64');
  expect(loadConfig({ PE_SECRET_KEY: b64 }).secretKey).toEqual(Buffer.alloc(32, 7));
  const generated = 'r9Xq2LmV8sKp4Tz7Wc1Nb6Hy3Fd0Ju5Ea'; // like a value from Render's Generate button
  expect(loadConfig({ PE_SECRET_KEY: generated }).secretKey).toHaveLength(32);
  expect(loadConfig({ PE_SECRET_KEY: generated }).secretKey).toEqual(loadConfig({ PE_SECRET_KEY: generated }).secretKey);
  expect(() => loadConfig({ PE_SECRET_KEY: 'too-short' })).toThrow(/at least 32/);
  expect(() => loadConfig({ PE_ADMIN_PASSWORD: 'short' })).toThrow(/PE_ADMIN_PASSWORD must be at least 12 characters/);
});

test('SMTP can be configured as one URL or as host, port, user and password', () => {
  const parts = loadConfig({ PE_SMTP_HOST: 'smtp-relay.example.com', PE_SMTP_PORT: '2525', PE_SMTP_USER: 'login@smtp.example.com', PE_SMTP_PASS: 'smtp-key-for-tests' });
  expect(smtpConfigured(parts)).toBe(true);
  expect(smtpTransportOptions(parts)).toEqual({ host: 'smtp-relay.example.com', port: 2525, secure: false, auth: { user: 'login@smtp.example.com', pass: 'smtp-key-for-tests' } });
  expect(smtpTransportOptions(loadConfig({ PE_SMTP_HOST: 'h.example.com', PE_SMTP_PORT: '465', PE_SMTP_PASS: 'x' }))).toMatchObject({ secure: true });
  expect(selectProviders(loadConfig({ PE_DELIVERY_MODE: 'live', PE_SMTP_HOST: 'h.example.com', PE_SMTP_PASS: 'x' })).email.name).toBe('smtp');
  expect(selectProviders(loadConfig({ PE_DELIVERY_MODE: 'live', PE_SMTP_HOST: 'h.example.com' })).email.name).toBe('sandbox'); // no password yet
  expect(smtpTransportOptions(loadConfig({ PE_SMTP_URL: 'smtp://u:p@a.example.com:25', PE_SMTP_HOST: 'b.example.com', PE_SMTP_PASS: 'x' }))).toBe('smtp://u:p@a.example.com:25');
});

test('on Render, the public URL defaults to RENDER_EXTERNAL_URL', () => {
  expect(loadConfig({ RENDER_EXTERNAL_URL: 'https://pure-engage-test.example.com' }).PE_PUBLIC_URL).toBe('https://pure-engage-test.example.com');
  expect(loadConfig({ RENDER_EXTERNAL_URL: 'https://a.example.com', PE_PUBLIC_URL: 'https://b.example.com' }).PE_PUBLIC_URL).toBe('https://b.example.com');
});
