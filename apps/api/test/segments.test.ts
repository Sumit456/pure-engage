import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { SegmentRule } from '@pure-engage/shared';
import { loginAs, makeContact, testApp, truncateAll } from './helpers.ts';

const now = new Date('2026-03-01T08:00:00Z');
let ctx: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => { ctx = await testApp({}, { clock: () => now }); });
afterAll(async () => { await ctx.close(); });

const ids: Record<string, string> = {};
const SYS = { source: 'test', actor: { type: 'system' as const } };

beforeEach(async () => {
  await truncateAll(ctx.db);
  const people = [
    { key: 'layla', external_id: 'MBR-TEST-A', first_name: 'Layla', email: 'layla@example.com', preferred_language: 'ar', plan: 'gold', visits: 12, vip: true, consent: { email: { care: 'granted', marketing: 'granted' } } },
    { key: 'omar', external_id: 'MBR-TEST-B', first_name: 'Omar', email: 'omar@example.com', preferred_language: 'en', plan: 'silver', visits: 3, consent: { email: { care: 'granted', marketing: 'denied' } } },
    { key: 'sara', external_id: 'MBR-TEST-C', first_name: 'Sara', phone: '+971500000003', plan: 'Gold', visits: 'many', consent: { sms: { care: 'granted' } } },
    { key: 'noor', external_id: 'MBR-TEST-D', first_name: 'Noor%', email: 'noor@example.org' },
  ];
  for (const { key, ...p } of people) ids[key] = (await makeContact(ctx.app, p)).id;
  await ctx.db.updateTable('contacts').set({ created_at: new Date('2025-01-01T00:00:00Z') }).where('id', '=', ids.omar!).execute();
  const ev = (external_id: string, name: string, time: string) => ctx.app.services.events.track({ external_id, name, properties: {}, time }, SYS);
  await ev('MBR-TEST-A', 'appointment.completed', '2026-02-20T10:00:00Z');
  await ev('MBR-TEST-A', 'appointment.completed', '2026-02-25T10:00:00Z');
  await ev('MBR-TEST-B', 'appointment.completed', '2025-06-01T10:00:00Z');
});

const members = async (...rules: SegmentRule[]) => {
  const { sample, count } = await ctx.app.services.segments.preview({ type: 'group', op: 'and', rules });
  expect(sample.length).toBe(Math.min(count, 10));
  return sample.map((c) => Object.keys(ids).find((k) => ids[k] === c.id)).sort();
};

describe('rule compilation', () => {
  test('fields: case-insensitive equality, literal LIKE characters, in, exists', async () => {
    expect(await members({ type: 'field', field: 'first_name', op: 'eq', value: 'LAYLA' })).toEqual(['layla']);
    expect(await members({ type: 'field', field: 'first_name', op: 'contains', value: '%' })).toEqual(['noor']);
    expect(await members({ type: 'field', field: 'preferred_language', op: 'in', value: ['ar', 'fr'] })).toEqual(['layla']);
    expect(await members({ type: 'field', field: 'email', op: 'not_exists' })).toEqual(['sara']);
    expect(await members({ type: 'field', field: 'email', op: 'starts_with', value: 'o' })).toEqual(['omar']);
  });

  test('created_at relative dates use the injected clock', async () => {
    expect(await members({ type: 'field', field: 'created_at', op: 'more_than_days_ago', value: 30 })).toEqual(['omar']);
    expect((await members({ type: 'field', field: 'created_at', op: 'within_last_days', value: 30 })).length).toBe(3);
  });

  test('attributes: text, booleans, and numbers that ignore non-numeric values', async () => {
    expect(await members({ type: 'attribute', key: 'plan', op: 'eq', value: 'gold' })).toEqual(['layla', 'sara']);
    expect(await members({ type: 'attribute', key: 'vip', op: 'eq', value: true })).toEqual(['layla']);
    expect(await members({ type: 'attribute', key: 'visits', op: 'gte', value: 5 })).toEqual(['layla']); // 'many' doesn't crash or match
    expect(await members({ type: 'attribute', key: 'visits', op: 'eq', value: 3 })).toEqual(['omar']);
    expect(await members({ type: 'attribute', key: 'visits', op: 'exists' })).toEqual(['layla', 'omar', 'sara']);
  });

  test('consent: granted, denied, and unknown when missing', async () => {
    expect(await members({ type: 'consent', channel: 'email', purpose: 'marketing', status: 'granted' })).toEqual(['layla']);
    expect(await members({ type: 'consent', channel: 'email', purpose: 'marketing', status: 'denied' })).toEqual(['omar']);
    expect(await members({ type: 'consent', channel: 'email', purpose: 'marketing', status: 'unknown' })).toEqual(['noor', 'sara']);
  });

  test('events: counts, recency windows and none', async () => {
    expect(await members({ type: 'event', name: 'appointment.completed', op: 'at_least', count: 2 })).toEqual(['layla']);
    expect(await members({ type: 'event', name: 'appointment.completed', op: 'at_least', count: 1, within_days: 30 })).toEqual(['layla']);
    expect(await members({ type: 'event', name: 'appointment.completed', op: 'at_least', count: 1 })).toEqual(['layla', 'omar']);
    expect(await members({ type: 'event', name: 'appointment.completed', op: 'none', count: 1, within_days: 30 })).toEqual(['noor', 'omar', 'sara']);
    expect(await members({ type: 'event', name: 'appointment.completed', op: 'at_most', count: 1 })).toEqual(['noor', 'omar', 'sara']);
  });

  test('nested groups combine AND and OR; an empty AND is everyone', async () => {
    expect(await members({
      type: 'group', op: 'or', rules: [
        { type: 'attribute', key: 'plan', op: 'eq', value: 'silver' },
        { type: 'group', op: 'and', rules: [{ type: 'field', field: 'preferred_language', op: 'eq', value: 'ar' }, { type: 'attribute', key: 'vip', op: 'eq', value: true }] },
      ],
    })).toEqual(['layla', 'omar']);
    expect(await members()).toHaveLength(4);
  });

  test('values are bound parameters, not SQL', async () => {
    expect(await members({ type: 'field', field: 'first_name', op: 'eq', value: "x' or '1'='1" })).toEqual([]);
    expect(await members({ type: 'event', name: "x'); delete from contacts; --", op: 'none', count: 1 })).toHaveLength(4);
    expect(await ctx.db.selectFrom('contacts').select('id').execute()).toHaveLength(4);
  });
});

describe('validation and API', () => {
  test('rejects bad attribute keys, wrong operators and over-deep nesting', async () => {
    const preview = (rules: unknown) => ctx.app.services.segments.preview(rules);
    await expect(preview({ type: 'group', op: 'and', rules: [{ type: 'attribute', key: "a'; drop table contacts; --", op: 'eq', value: 1 }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(preview({ type: 'group', op: 'and', rules: [{ type: 'field', field: 'email', op: 'within_last_days', value: 3 }] })).rejects.toMatchObject({ statusCode: 400 });
    let deep: SegmentRule = { type: 'group', op: 'and', rules: [] };
    for (let i = 0; i < 5; i++) deep = { type: 'group', op: 'and', rules: [deep] };
    await expect(preview(deep)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('marketers create segments; list includes live sizes; viewers can only read', async () => {
    const marketer = await loginAs(ctx.app, 'marketer');
    const viewer = await loginAs(ctx.app, 'viewer');
    const rules = { type: 'group', op: 'and', rules: [{ type: 'attribute', key: 'plan', op: 'eq', value: 'gold' }] };
    expect((await viewer.request({ method: 'POST', url: '/api/segments', payload: { name: 'Gold', rules } })).statusCode).toBe(403);
    const created = await marketer.request({ method: 'POST', url: '/api/segments', payload: { name: 'Gold members', rules } });
    expect(created.statusCode).toBe(201);
    const list = (await viewer.request({ method: 'GET', url: '/api/segments' })).json().data;
    expect(list).toMatchObject([{ name: 'Gold members', size: 2 }]);
    const preview = (await viewer.request({ method: 'POST', url: '/api/segments/preview', payload: { rules } })).json();
    expect(preview.count).toBe(2);
    expect(Object.keys(preview.sample[0]).sort()).toEqual(['email', 'external_id', 'first_name', 'id', 'last_name']);
  });
});
