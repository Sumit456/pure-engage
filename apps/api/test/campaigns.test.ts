import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { emailTemplate, loginAs, makeContact, makeTemplate, testApp, truncateAll } from './helpers.ts';

let now = new Date('2026-03-01T06:00:00Z'); // 10:00 Dubai
let ctx: Awaited<ReturnType<typeof testApp>>;
let marketer: Awaited<ReturnType<typeof loginAs>>;
let templateId: string;
let segmentId: string;
const goldIds: string[] = [];

beforeAll(async () => { ctx = await testApp({ PE_CAMPAIGN_BATCH_SIZE: '2', PE_MARKETING_CAP_PER_WEEK: '10' }, { clock: () => now }); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => {
  await truncateAll(ctx.db);
  now = new Date('2026-03-01T06:00:00Z');
  goldIds.length = 0;
  marketer = await loginAs(ctx.app, 'marketer');
  templateId = (await makeTemplate(ctx.app, emailTemplate({ name: 'Spring check-up', purpose: 'marketing' }))).id;
  // 5 gold members: 3 can receive marketing email, 1 has no consent, 1 has no email.
  for (let i = 1; i <= 5; i++) {
    const c = await makeContact(ctx.app, {
      external_id: `MBR-TEST-G${i}`, plan: 'gold',
      ...(i === 5 ? {} : { email: `g${i}@example.com` }),
      consent: i === 4 ? { email: { care: 'granted' } } : { email: { marketing: 'granted' } },
    });
    goldIds.push(c.id);
  }
  await makeContact(ctx.app, { external_id: 'MBR-TEST-S1', plan: 'silver', email: 's1@example.com', consent: { email: { marketing: 'granted' } } });
  segmentId = (await ctx.app.services.segments.create({ name: 'Gold', rules: { type: 'group', op: 'and', rules: [{ type: 'attribute', key: 'plan', op: 'eq', value: 'gold' }] } }, { type: 'system' })).id;
});

const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => marketer.request({ method, url, ...(payload ? { payload } : {}) });
const newCampaign = async () => (await api('POST', '/api/campaigns', { name: 'Spring', template_id: templateId, segment_id: segmentId })).json();
const campaignMessages = (id: string) => ctx.db.selectFrom('messages').selectAll().where('campaign_id', '=', id).where('source', '=', 'campaign').execute();

test('estimate counts only members who can actually receive it', async () => {
  const c = await newCampaign();
  expect((await api('GET', `/api/campaigns/${c.id}/estimate`)).json()).toEqual({ segment_size: 5, eligible: 3, channel: 'email', purpose: 'marketing' });
});

test('send now: batched fan-out to the whole segment, policy applied, stats add up', async () => {
  const c = await newCampaign();
  expect((await api('POST', `/api/campaigns/${c.id}/schedule`, {})).json().status).toBe('scheduled');
  await ctx.app.services.worker.tick();

  const msgs = await campaignMessages(c.id);
  expect(msgs).toHaveLength(5);
  expect(new Set(msgs.map((m) => m.contact_id))).toEqual(new Set(goldIds));
  const detail = (await api('GET', `/api/campaigns/${c.id}`)).json();
  expect(detail).toMatchObject({ status: 'sent', enqueued_count: 5 });
  expect(detail.stats).toMatchObject({ targeted: 5, sent: 3, suppressed: 2, suppressed_by_reason: { no_consent: 1, no_address: 1 } });
  const audit = await ctx.db.selectFrom('audit_log').select('action').where('entity_id', '=', c.id).orderBy('id').execute();
  expect(audit.map((a) => a.action)).toEqual(['campaign.create', 'campaign.schedule', 'campaign.start', 'campaign.complete']);
});

test('fan-out is resumable and never duplicates, even if the cursor is lost', async () => {
  const c = await newCampaign();
  await api('POST', `/api/campaigns/${c.id}/schedule`, {});
  expect(await ctx.app.services.campaigns.processDue(1)).toBe(1); // first batch of 2, then "crash"
  expect(await campaignMessages(c.id)).toHaveLength(2);
  // Worst case: the cursor never got saved.
  await ctx.db.updateTable('campaigns').set({ cursor_contact_id: null }).where('id', '=', c.id).execute();
  await ctx.app.services.campaigns.processDue();
  expect(await campaignMessages(c.id)).toHaveLength(5);
  expect((await ctx.app.services.campaigns.get(c.id)).status).toBe('sent');
});

test('a scheduled campaign waits for its time', async () => {
  const c = await newCampaign();
  await api('POST', `/api/campaigns/${c.id}/schedule`, { scheduled_at: '2026-03-02T05:00:00Z' });
  await ctx.app.services.worker.tick();
  expect(await campaignMessages(c.id)).toHaveLength(0);
  now = new Date('2026-03-02T05:00:00Z');
  await ctx.app.services.worker.tick();
  expect(await campaignMessages(c.id)).toHaveLength(5);
  expect((await api('POST', `/api/campaigns/${c.id}/schedule`, { scheduled_at: '2020-01-01T00:00:00Z' })).statusCode).toBe(409);
});

test('cancelling mid-send stops fan-out and withdraws unsent messages', async () => {
  const c = await newCampaign();
  await api('POST', `/api/campaigns/${c.id}/schedule`, {});
  await ctx.app.services.campaigns.processDue(1); // 2 queued, not dispatched yet
  const cancelled = (await api('POST', `/api/campaigns/${c.id}/cancel`)).json();
  expect(cancelled.status).toBe('cancelled');
  await ctx.app.services.worker.tick();
  const msgs = await campaignMessages(c.id);
  expect(msgs).toHaveLength(2);
  expect(msgs.every((m) => m.status === 'suppressed' && (m.status_reason === 'campaign_cancelled' || m.status_reason === 'no_consent' || m.status_reason === 'no_address'))).toBe(true);
});

test('only drafts can be edited; past times are refused; test sends are excluded from stats', async () => {
  const c = await newCampaign();
  expect((await api('POST', `/api/campaigns/${c.id}/schedule`, { scheduled_at: '2020-01-01T00:00:00Z' })).statusCode).toBe(400);
  const test = await api('POST', `/api/campaigns/${c.id}/test`, { contact_id: goldIds[0] });
  expect(test.json()).toMatchObject({ status: 'queued', source: 'campaign_test' });
  await api('POST', `/api/campaigns/${c.id}/schedule`, {});
  expect((await api('PUT', `/api/campaigns/${c.id}`, { name: 'Renamed' })).statusCode).toBe(409);
  await ctx.app.services.worker.tick();
  expect((await api('GET', `/api/campaigns/${c.id}`)).json().stats.targeted).toBe(5);
});

test('archiving the template mid-send stops the campaign', async () => {
  const c = await newCampaign();
  await api('POST', `/api/campaigns/${c.id}/schedule`, {});
  await ctx.app.services.campaigns.processDue(1);
  await ctx.app.services.templates.archive(templateId, { type: 'system' });
  await ctx.app.services.campaigns.processDue();
  expect((await ctx.app.services.campaigns.get(c.id)).status).toBe('cancelled');
  expect(await campaignMessages(c.id)).toHaveLength(2);
});

test('viewers cannot create or send campaigns', async () => {
  const viewer = await loginAs(ctx.app, 'viewer');
  expect((await viewer.request({ method: 'POST', url: '/api/campaigns', payload: { name: 'x', template_id: templateId, segment_id: segmentId } })).statusCode).toBe(403);
  expect((await viewer.request({ method: 'GET', url: '/api/campaigns' })).statusCode).toBe(200);
});
