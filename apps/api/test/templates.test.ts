import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { smsInfo } from '@pure-engage/shared';
import { emailTemplate, loginAs, makeContact, smsTemplate, testApp, truncateAll } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof testApp>>;
let marketer: Awaited<ReturnType<typeof loginAs>>;
beforeAll(async () => { ctx = await testApp(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await truncateAll(ctx.db); marketer = await loginAs(ctx.app, 'marketer'); });

const post = (url: string, payload: unknown) => marketer.request({ method: 'POST', url, payload: payload as object });

test('create, then a content change makes a new version; restore copies an old version forward', async () => {
  const created = await post('/api/templates', emailTemplate());
  expect(created.statusCode).toBe(201);
  const { id } = created.json();
  expect(created.json()).toMatchObject({ current_version: 1, channel: 'email', purpose: 'care' });

  const renamed = await marketer.request({ method: 'PUT', url: `/api/templates/${id}`, payload: { name: 'Renamed' } });
  expect(renamed.json()).toMatchObject({ name: 'Renamed', current_version: 1 });

  const v2 = await marketer.request({ method: 'PUT', url: `/api/templates/${id}`, payload: { content: { en: { subject: 'v2', html: '<p>v2</p>' } } } });
  expect(v2.json()).toMatchObject({ current_version: 2, content: { en: { subject: 'v2' } } });

  const restored = await post(`/api/templates/${id}/versions/1/restore`, {});
  expect(restored.json()).toMatchObject({ current_version: 3 });
  expect(restored.json().content.en.subject).toContain('Your appointment');
  const versions = (await marketer.request({ method: 'GET', url: `/api/templates/${id}/versions` })).json().data;
  expect(versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
});

test('Liquid syntax errors are rejected at save time with the field path', async () => {
  const res = await post('/api/templates', emailTemplate({ content: { en: { subject: 'ok', html: '<p>{% if contact.first_name %}unclosed</p>' } } }));
  expect(res.statusCode).toBe(400);
  expect(res.json().details[0].path).toBe('content.en.html');
});

test('content must match the channel', async () => {
  expect((await post('/api/templates', { ...smsTemplate(), content: { en: { subject: 'x', html: 'y' } } })).statusCode).toBe(400);
});

test('viewers cannot create templates; archived templates drop out of the list', async () => {
  const viewer = await loginAs(ctx.app, 'viewer');
  expect((await viewer.request({ method: 'POST', url: '/api/templates', payload: emailTemplate() })).statusCode).toBe(403);
  const { id } = (await post('/api/templates', emailTemplate())).json();
  await marketer.request({ method: 'DELETE', url: `/api/templates/${id}` });
  expect((await marketer.request({ method: 'GET', url: '/api/templates' })).json().data).toHaveLength(0);
  expect((await marketer.request({ method: 'GET', url: '/api/templates?archived=1' })).json().data).toHaveLength(1);
});

test('preview escapes contact data in HTML and uses the contact language', async () => {
  const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-1', first_name: '<img src=x onerror=alert(1)>', preferred_language: 'ar' });
  const res = await post('/api/templates/preview', { channel: 'email', content: emailTemplate().content, contact_id: c.id, data: { date: '10 Jan' } });
  const body = res.json();
  expect(body.locale).toBe('ar');
  expect(body.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(body.html).not.toContain('<img src=x');
  expect(body.html).toContain('dir="rtl"');
  // Previewing a real contact is PHI access.
  expect(await ctx.db.selectFrom('audit_log').select('action').where('action', '=', 'contact.view').execute()).toHaveLength(1);
});

test('SMS preview reports encoding and segments; Arabic switches to UCS-2', async () => {
  const res = await post('/api/templates/preview', { channel: 'sms', content: smsTemplate().content, locale: 'ar', data: { date: '10/01' } });
  expect(res.json()).toMatchObject({ locale: 'ar', sms: { encoding: 'UCS-2', segments: 1 } });
});

test('smsInfo counts GSM-7 and UCS-2 segments', () => {
  expect(smsInfo('a'.repeat(160))).toMatchObject({ encoding: 'GSM-7', segments: 1 });
  expect(smsInfo('a'.repeat(161))).toMatchObject({ encoding: 'GSM-7', segments: 2 });
  expect(smsInfo('€'.repeat(80))).toMatchObject({ encoding: 'GSM-7', units: 160, segments: 1 });
  expect(smsInfo('م'.repeat(70))).toMatchObject({ encoding: 'UCS-2', segments: 1 });
  expect(smsInfo('م'.repeat(71))).toMatchObject({ encoding: 'UCS-2', segments: 2 });
});
