import { afterAll, beforeAll, expect, test } from 'vitest';
import { testApp } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => { ctx = await testApp(); });
afterAll(async () => { await ctx.close(); });

test('healthz reports the database as reachable', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
});

test('security headers are set', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['content-security-policy']).toBeDefined();
});

test('migrations created the app_settings table', async () => {
  const rows = await ctx.db.selectFrom('app_settings').selectAll().execute();
  expect(rows).toEqual([]);
});
