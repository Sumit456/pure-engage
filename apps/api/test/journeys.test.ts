import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { JourneyDefinition } from '@pure-engage/shared';
import { localDateTime } from '../src/services/rendering.ts';
import { emailTemplate, loginAs, makeContact, makeTemplate, smsTemplate, testApp, truncateAll } from './helpers.ts';

let now = new Date('2026-03-01T06:00:00Z'); // 10:00 in Dubai
let ctx: Awaited<ReturnType<typeof testApp>>;
const SYS = { type: 'system' as const };
const consent = { email: { care: 'granted' }, sms: { care: 'granted' } };

beforeAll(async () => { ctx = await testApp({}, { clock: () => now }); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await truncateAll(ctx.db); now = new Date('2026-03-01T06:00:00Z'); });

const at = (iso: string) => { now = new Date(iso); };
const tick = () => ctx.app.services.worker.tick();
const track = (external_id: string, name: string, properties: Record<string, unknown>, idem?: string) =>
  ctx.app.services.events.track({ external_id, name, properties, ...(idem ? { idempotency_key: idem } : {}) }, { source: 'purenet', actor: { type: 'integration', id: 'purenet' } });
const runs = (journeyId: string) => ctx.db.selectFrom('journey_enrollments').selectAll().where('journey_id', '=', journeyId).orderBy('entered_at').execute();
const journeyMessages = (journeyId: string) => ctx.db.selectFrom('messages').innerJoin('templates', 'templates.id', 'messages.template_id')
  .select(['messages.channel', 'messages.status', 'messages.body_text', 'templates.name', 'messages.created_at']).where('messages.journey_id', '=', journeyId).orderBy('messages.created_at').execute();

async function starter() {
  const j = await ctx.app.services.journeys.createAppointmentReminderStarter(SYS);
  await ctx.app.services.journeys.activate(j.id, SYS);
  return j;
}

describe('appointment reminder starter', () => {
  test('confirms the booking by email, then texts 24 hours before, then completes', async () => {
    const j = await starter();
    await makeContact(ctx.app, { external_id: 'MBR-TEST-1', first_name: 'Layla', email: 'layla@example.com', phone: '+971500000001', consent });
    await track('MBR-TEST-1', 'purenet.appointment.booked', { appointment_id: 'APT-1', start: '2026-03-04T06:30:00Z' }); // Wed 10:30 Dubai
    await tick();

    let [run] = await runs(j.id);
    expect(run).toMatchObject({ status: 'active', entry_key: 'APT-1', current_step: 'remind' });
    expect(run!.next_run_at?.toISOString()).toBe('2026-03-03T06:30:00.000Z'); // 24 h before
    let msgs = await journeyMessages(j.id);
    expect(msgs.map((m) => [m.name, m.status])).toEqual([['Appointment confirmation (email)', 'sent']]);

    at('2026-03-03T06:30:00Z');
    await tick();
    [run] = await runs(j.id);
    expect(run).toMatchObject({ status: 'completed', current_step: null });
    msgs = await journeyMessages(j.id);
    expect(msgs[1]).toMatchObject({ name: 'Appointment reminder (SMS)', channel: 'sms', status: 'sent' });
    expect(msgs[1]!.body_text).toBe('PureHealth: reminder of your appointment Wednesday 4 March at 10:30. Need to change it? Contact your clinic.');

    const log = await ctx.db.selectFrom('journey_step_log').select(['step_id', 'outcome']).where('enrollment_id', '=', run!.id).orderBy('id').execute();
    expect(log.map((l) => `${l.step_id}:${l.outcome}`)).toEqual(['confirm:entered', 'confirm:sent', 'day_before:waiting', 'remind:sent']);
  });

  test('cancelling that appointment stops the reminder; cancelling another one does not', async () => {
    const j = await starter();
    await makeContact(ctx.app, { external_id: 'MBR-TEST-2', email: 'b@example.com', phone: '+971500000002', consent });
    await track('MBR-TEST-2', 'purenet.appointment.booked', { appointment_id: 'APT-A', start: '2026-03-05T06:00:00Z' });
    await track('MBR-TEST-2', 'purenet.appointment.booked', { appointment_id: 'APT-B', start: '2026-03-06T06:00:00Z' });
    await tick();
    await track('MBR-TEST-2', 'purenet.appointment.cancelled', { appointment_id: 'APT-A' });
    await tick();
    const byKey = Object.fromEntries((await runs(j.id)).map((r) => [r.entry_key, r]));
    expect(byKey['APT-A']).toMatchObject({ status: 'exited', exit_reason: 'exit_event:purenet.appointment.cancelled' });
    expect(byKey['APT-B']).toMatchObject({ status: 'active' });

    at('2026-03-06T06:00:00Z');
    await tick();
    const sms = (await journeyMessages(j.id)).filter((m) => m.channel === 'sms');
    expect(sms).toHaveLength(1); // only APT-B's reminder
  });

  test('a repeated booking event for the same appointment does not start a second run', async () => {
    const j = await starter();
    await makeContact(ctx.app, { external_id: 'MBR-TEST-3', email: 'c@example.com', consent });
    await track('MBR-TEST-3', 'purenet.appointment.booked', { appointment_id: 'APT-9', start: '2026-03-09T06:00:00Z' }, 'evt-1');
    await track('MBR-TEST-3', 'purenet.appointment.booked', { appointment_id: 'APT-9', start: '2026-03-09T06:00:00Z' }, 'evt-2');
    await tick();
    expect(await runs(j.id)).toHaveLength(1);
    expect((await journeyMessages(j.id)).filter((m) => m.channel === 'email')).toHaveLength(1);
  });

  test('a booking less than 24 hours ahead gets its reminder straight after the confirmation', async () => {
    const j = await starter();
    await makeContact(ctx.app, { external_id: 'MBR-TEST-4', email: 'd@example.com', phone: '+971500000004', consent });
    await track('MBR-TEST-4', 'purenet.appointment.booked', { appointment_id: 'APT-S', start: '2026-03-01T10:00:00Z' });
    await tick();
    const [run] = await runs(j.id);
    expect(run!.status).toBe('completed');
    expect((await journeyMessages(j.id)).map((m) => m.channel).sort()).toEqual(['email', 'sms']); // same instant: order not defined
  });

  test('events from before activation do not trigger the journey', async () => {
    await makeContact(ctx.app, { external_id: 'MBR-TEST-5', email: 'e@example.com', consent });
    await track('MBR-TEST-5', 'purenet.appointment.booked', { appointment_id: 'APT-OLD', start: '2026-03-09T06:00:00Z' });
    await tick(); // processed with no journeys active
    const j = await starter();
    await tick();
    expect(await runs(j.id)).toHaveLength(0);
  });
});

describe('engine', () => {
  async function journey(definition: Partial<JourneyDefinition> & Pick<JourneyDefinition, 'steps' | 'start'>, trigger = 'visit.completed') {
    const j = await ctx.app.services.journeys.create({ name: 'Test', definition: { trigger: { event_name: trigger }, exit_on: [], ...definition } }, SYS);
    expect(j.problems).toEqual([]);
    await ctx.app.services.journeys.activate(j.id, SYS);
    return j;
  }

  test('wait_for_event: a matching event takes the matched branch; otherwise it times out', async () => {
    const thanks = await makeTemplate(ctx.app, emailTemplate({ name: 'Thanks', content: { en: { subject: 'Thanks', html: '<p>Thanks</p>' } } }));
    const j = await journey({
      start: 'await',
      steps: {
        await: { type: 'wait_for_event', event_name: 'survey.completed', match_property: 'visit_id', timeout: { days: 2, hours: 0, minutes: 0 }, matched: 'thank', timed_out: 'flag' },
        thank: { type: 'send', template_id: thanks.id, next: null },
        flag: { type: 'update', attributes: { survey_missed: true }, next: null },
      },
    });
    const yes = await makeContact(ctx.app, { external_id: 'MBR-TEST-W1', email: 'w1@example.com', consent });
    const no = await makeContact(ctx.app, { external_id: 'MBR-TEST-W2', email: 'w2@example.com', consent });
    await track('MBR-TEST-W1', 'visit.completed', { visit_id: 'V1' });
    await track('MBR-TEST-W2', 'visit.completed', { visit_id: 'V2' });
    await tick();
    await track('MBR-TEST-W1', 'survey.completed', { visit_id: 'OTHER' }); // wrong visit: ignored
    await track('MBR-TEST-W1', 'survey.completed', { visit_id: 'V1' });
    await tick();
    at('2026-03-03T06:00:01Z');
    await tick();

    const byContact = Object.fromEntries((await runs(j.id)).map((r) => [r.contact_id, r]));
    expect(byContact[yes.id]).toMatchObject({ status: 'completed' });
    expect(byContact[no.id]).toMatchObject({ status: 'completed' });
    expect((await journeyMessages(j.id)).length).toBe(1);
    expect((await ctx.app.services.contacts.get(no.id)).attributes).toMatchObject({ survey_missed: true });
    expect((await ctx.app.services.contacts.get(yes.id)).attributes).not.toHaveProperty('survey_missed');
  });

  test('split evaluates a condition on the contact; a filter limits who enters', async () => {
    const t = await makeTemplate(ctx.app, smsTemplate());
    const j = await ctx.app.services.journeys.create({ name: 'Split', definition: {
      trigger: { event_name: 'visit.completed', filter: { type: 'group', op: 'and', rules: [{ type: 'attribute', key: 'plan', op: 'exists' }] } },
      start: 'is_gold',
      steps: {
        is_gold: { type: 'split', condition: { type: 'group', op: 'and', rules: [{ type: 'attribute', key: 'plan', op: 'eq', value: 'gold' }] }, yes: 'text', no: null },
        text: { type: 'send', template_id: t.id, next: null },
      },
    } }, SYS);
    await ctx.app.services.journeys.activate(j.id, SYS);
    for (const [id, plan] of [['G', 'gold'], ['S', 'silver'], ['N', undefined]] as const) {
      await makeContact(ctx.app, { external_id: `MBR-TEST-${id}`, phone: '+971500000099', consent, ...(plan ? { plan } : {}) });
      await track(`MBR-TEST-${id}`, 'visit.completed', {});
    }
    await tick();
    expect(await runs(j.id)).toHaveLength(2); // N has no plan: filtered out
    expect(await journeyMessages(j.id)).toHaveLength(1);
  });

  test('pausing stops steps; resuming continues where the run was', async () => {
    const t = await makeTemplate(ctx.app, emailTemplate());
    const j = await journey({ start: 'wait', steps: { wait: { type: 'wait', duration: { days: 1, hours: 0, minutes: 0 }, next: 'send' }, send: { type: 'send', template_id: t.id, next: null } } });
    await makeContact(ctx.app, { external_id: 'MBR-TEST-P', email: 'p@example.com', consent });
    await track('MBR-TEST-P', 'visit.completed', {});
    await tick();
    await ctx.app.services.journeys.pause(j.id, SYS);
    at('2026-03-02T07:00:00Z');
    await tick();
    expect(await journeyMessages(j.id)).toHaveLength(0);
    await ctx.app.services.journeys.activate(j.id, SYS);
    await tick();
    expect(await journeyMessages(j.id)).toHaveLength(1);
    expect((await runs(j.id))[0]!.status).toBe('completed');
  });

  test('archiving a template mid-run logs a failed step and carries on', async () => {
    const t = await makeTemplate(ctx.app, emailTemplate());
    const j = await journey({ start: 'wait', steps: { wait: { type: 'wait', duration: { days: 0, hours: 1, minutes: 0 }, next: 'send' }, send: { type: 'send', template_id: t.id, next: null } } });
    await makeContact(ctx.app, { external_id: 'MBR-TEST-F', email: 'f@example.com', consent });
    await track('MBR-TEST-F', 'visit.completed', {});
    await tick();
    await ctx.app.services.templates.archive(t.id, SYS);
    at('2026-03-01T07:00:00Z');
    await tick();
    const [run] = await runs(j.id);
    expect(run!.status).toBe('completed');
    const failed = await ctx.db.selectFrom('journey_step_log').select(['outcome', 'detail']).where('step_id', '=', 'send').executeTakeFirstOrThrow();
    expect(failed.outcome).toBe('failed');
  });
});

describe('validation, simulation and API', () => {
  test('structural problems block activation: missing steps, loops, unreachable steps', async () => {
    const t = await makeTemplate(ctx.app, emailTemplate());
    const j = await ctx.app.services.journeys.create({ name: 'Broken', definition: {
      trigger: { event_name: 'x' }, start: 'a',
      steps: {
        a: { type: 'send', template_id: t.id, next: 'b' },
        b: { type: 'wait', duration: { days: 1 }, next: 'a' },
        c: { type: 'send', template_id: t.id, next: 'missing' },
      },
    } }, SYS);
    const messages = j.problems.map((p) => `${p.step}:${p.message}`);
    expect(messages).toEqual(expect.arrayContaining(['c:Leads to "missing", which doesn\'t exist', 'c:Not reachable from the start']));
    expect(messages.some((m) => m.includes('loop'))).toBe(true);
    await expect(ctx.app.services.journeys.activate(j.id, SYS)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('simulation walks the path with times and says who would not receive a message', async () => {
    const j = await ctx.app.services.journeys.createAppointmentReminderStarter(SYS);
    const noSms = await makeContact(ctx.app, { external_id: 'MBR-TEST-SIM', email: 's@example.com', phone: '+971500000077', consent: { email: { care: 'granted' } } });
    const { path } = await ctx.app.services.journeys.simulate({ definition: j.definition, contact_id: noSms.id, context: { appointment_id: 'X', start: '2026-03-10T06:00:00Z' } });
    expect(path.map((p) => `${p.step}:${p.outcome}@${p.at}`)).toEqual([
      'confirm:would_send@2026-03-01T06:00:00.000Z',
      'day_before:wait@2026-03-01T06:00:00.000Z',
      'remind:would_not_send@2026-03-09T06:00:00.000Z',
    ]);
    expect(path[2]!.detail).toMatchObject({ reason: 'no_consent', channel: 'sms' });
  });

  test('marketers manage journeys; active journeys must be paused to edit; viewers read only', async () => {
    const marketer = await loginAs(ctx.app, 'marketer');
    const viewer = await loginAs(ctx.app, 'viewer');
    const created = await marketer.request({ method: 'POST', url: '/api/journeys/starters/appointment-reminder' });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();
    expect((await viewer.request({ method: 'POST', url: `/api/journeys/${id}/activate` })).statusCode).toBe(403);
    expect((await marketer.request({ method: 'POST', url: `/api/journeys/${id}/activate` })).json().status).toBe('active');
    expect((await marketer.request({ method: 'PUT', url: `/api/journeys/${id}`, payload: { name: 'x' } })).statusCode).toBe(409);
    const detail = (await viewer.request({ method: 'GET', url: `/api/journeys/${id}` })).json();
    expect(detail).toMatchObject({ status: 'active', problems: [], stats: { enrollments: { active: 0 } } });
  });

  test('local_datetime formats in the contact time zone and language', () => {
    expect(localDateTime('2026-03-04T06:30:00Z', 'Asia/Dubai')).toBe('Wednesday 4 March at 10:30');
    expect(localDateTime('2026-03-04T06:30:00Z', 'Europe/London')).toBe('Wednesday 4 March at 06:30');
    expect(localDateTime('2026-03-04T06:30:00Z', 'Asia/Dubai', 'ar')).toContain('الأربعاء');
    expect(localDateTime('not a date')).toBe('not a date');
  });
});
