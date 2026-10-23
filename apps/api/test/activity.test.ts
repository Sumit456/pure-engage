import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { seedDemo } from '../src/demo/seed.ts';
import { loginAs } from './helpers.ts';
import { testApp, truncateAll } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => { ctx = await testApp(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await truncateAll(ctx.db); });

test('the activity feed merges messages, consent, journeys and events, newest first, with cursor paging', async () => {
  await seedDemo(ctx.app.services);
  for (let i = 0; i < 4; i++) await ctx.app.services.worker.tick();
  const viewer = await loginAs(ctx.app, 'viewer');

  const first = (await viewer.request({ method: 'GET', url: '/api/activity?limit=20' })).json();
  expect(first.data).toHaveLength(20);
  const times = first.data.map((i: { at: string }) => Date.parse(i.at));
  expect([...times].sort((a, b) => b - a)).toEqual(times);
  expect(new Set(first.data.map((i: { kind: string }) => i.kind)).size).toBeGreaterThan(1);
  expect(first.next_cursor).toBeTruthy();

  const second = (await viewer.request({ method: 'GET', url: `/api/activity?limit=20&cursor=${first.next_cursor}` })).json();
  const ids = new Set(first.data.map((i: { id: string }) => i.id));
  for (const item of second.data) expect(ids.has(item.id)).toBe(false);
  expect(Date.parse(second.data[0].at)).toBeLessThanOrEqual(times[times.length - 1]);

  // Labels only: no message bodies, addresses or event properties.
  const raw = JSON.stringify([...first.data, ...second.data]);
  expect(raw).not.toMatch(/body_html|body_text|to_address|appointment_id/);
});

test('the feed filters by kind and by contact', async () => {
  await seedDemo(ctx.app.services);
  for (let i = 0; i < 4; i++) await ctx.app.services.worker.tick();
  const viewer = await loginAs(ctx.app, 'viewer');

  const consent = (await viewer.request({ method: 'GET', url: '/api/activity?kinds=consent&limit=100' })).json();
  expect(consent.data.length).toBeGreaterThan(0);
  expect(consent.data.every((i: { type: string }) => i.type === 'consent.changed')).toBe(true);
  expect(consent.data[0].data).toMatchObject({ channel: expect.any(String), purpose: expect.any(String), status: expect.any(String), source: 'demo' });

  const one = consent.data[0].contact.id;
  const timeline = (await viewer.request({ method: 'GET', url: `/api/activity?contact_id=${one}&limit=100` })).json();
  expect(timeline.data.length).toBeGreaterThan(0);
  expect(timeline.data.every((i: { contact: { id: string } }) => i.contact.id === one)).toBe(true);

  expect((await viewer.request({ method: 'GET', url: '/api/activity?kinds=bogus' })).statusCode).toBe(400);
  expect((await viewer.request({ method: 'GET', url: '/api/activity?cursor=bm90LWEtY3Vyc29y' })).statusCode).toBe(400);
  expect((await ctx.app.inject({ method: 'GET', url: '/api/activity' })).statusCode).toBe(401);
});
