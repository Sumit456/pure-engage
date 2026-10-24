import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { newBlock, renderEmailDesign, starterDesign, type EmailDesign } from '@pure-engage/shared';
import { sniffImage } from '../src/services/assets.ts';
import { loginAs, makeContact, testApp, truncateAll } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => { ctx = await testApp(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await truncateAll(ctx.db); await ctx.db.deleteFrom('assets').execute(); });

// A 1x1 transparent PNG (synthetic test data).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('images are typed by their bytes, sized, de-duplicated and served publicly with safe headers', async () => {
  expect(sniffImage(PNG)).toEqual({ type: 'image/png', width: 1, height: 1 });
  expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();

  const marketer = await loginAs(ctx.app, 'marketer');
  const up = await marketer.request({ method: 'POST', url: '/api/assets', payload: { name: 'C:\\fakepath\\logo.png', data: PNG.toString('base64') } });
  expect(up.statusCode).toBe(201);
  const asset = up.json();
  expect(asset).toMatchObject({ name: 'logo.png', content_type: 'image/png', size: PNG.length, width: 1, height: 1 });
  expect(asset).not.toHaveProperty('data');
  expect(asset.url).toMatch(new RegExp(`^https?://[^/]+/a/${asset.id}$`));

  const again = (await marketer.request({ method: 'POST', url: '/api/assets', payload: { name: 'copy.png', data: PNG.toString('base64') } })).json();
  expect(again.id).toBe(asset.id);

  const pub = await ctx.app.inject({ method: 'GET', url: `/a/${asset.id}` });
  expect(pub.statusCode).toBe(200);
  expect(pub.rawPayload.equals(PNG)).toBe(true);
  expect(pub.headers).toMatchObject({
    'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'cross-origin',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  expect(String(pub.headers['content-security-policy'])).toContain("default-src 'none'");
  expect((await ctx.app.inject({ method: 'GET', url: '/a/not-a-uuid' })).statusCode).toBe(404);
  expect((await ctx.app.inject({ method: 'GET', url: '/a/00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);

  const viewer = await loginAs(ctx.app, 'viewer');
  expect((await viewer.request({ method: 'GET', url: '/api/assets' })).json().data).toHaveLength(1);
  expect((await viewer.request({ method: 'POST', url: '/api/assets', payload: { data: PNG.toString('base64') } })).statusCode).toBe(403);
  expect((await viewer.request({ method: 'DELETE', url: `/api/assets/${asset.id}` })).statusCode).toBe(403);
});

test('uploads that are not supported images, or too large, are refused', async () => {
  const marketer = await loginAs(ctx.app, 'marketer');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64');
  expect((await marketer.request({ method: 'POST', url: '/api/assets', payload: { name: 'x.png', data: svg } })).statusCode).toBe(400);
  expect((await marketer.request({ method: 'POST', url: '/api/assets', payload: { name: 'x.png', data: '' } })).statusCode).toBe(400);
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]).toString('base64');
  expect([400, 413]).toContain((await marketer.request({ method: 'POST', url: '/api/assets', payload: { name: 'big.png', data: big } })).statusCode);
});

test('a designed email renders to safe HTML, keeps Liquid working, and survives the send pipeline', async () => {
  const design: EmailDesign = starterDesign();
  design.blocks.push({ ...newBlock('image'), src: 'https://engage.example.com/a/00000000-0000-4000-8000-000000000001', alt: 'Clinic' } as never);
  design.blocks.push({ ...newBlock('text'), text: '<script>alert(1)</script> and [a link](javascript:alert(1))' } as never);
  const html = renderEmailDesign(design);
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('javascript:');
  expect(html).toContain("{{ contact.first_name | default: 'there' }}");
  expect(renderEmailDesign(design, { dir: 'rtl' })).toContain('dir="rtl"');

  const marketer = await loginAs(ctx.app, 'marketer');
  const created = await marketer.request({ method: 'POST', url: '/api/templates', payload: { name: 'Designed', channel: 'email', purpose: 'care', content: { en: { subject: 'Hi', html, design } } } });
  expect(created.statusCode).toBe(201);
  const tpl = created.json();
  expect(tpl.content.en.design.blocks).toHaveLength(design.blocks.length);

  const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-6001', first_name: 'Test', email: 'designed@example.com', consent: { email: { care: 'granted' } } });
  const m = await ctx.app.services.delivery.enqueue({ contact: c, templateId: tpl.id, source: 'test' });
  expect(m.body_html).toContain('Hello Test,');
  expect(m.body_html).toContain('/a/00000000-0000-4000-8000-000000000001');
  expect(m.body_html).not.toContain('<script>');
});
