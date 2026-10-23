// Journeys: event-triggered, multi-step flows per contact (ADR-0005).
//
// - processEvents(): reacts to each new event once (events.processed_at), after commit: exits runs whose
//   exit event arrived, resumes runs waiting for that event, and enters contacts into journeys it triggers.
// - runDue(): advances runs whose next_run_at is due. A run is claimed with a 5-minute lease (next_run_at moves
//   forward before work starts), so if a worker dies mid-step another one picks the run up later.
// Sends use the idempotency key `journey:<run>:<step>`, so a retried step never sends twice.
import { sql, type Kysely } from 'kysely';
import { canSend, durationMs, journeyDefinitionSchema, journeyProblems, nextSteps, type JourneyDefinition, type JourneyStep } from '@pure-engage/shared';
import type { Contact, Database, Enrollment, Event, Journey } from '../db/schema.ts';
import { HttpError, badRequest, conflict, notFound } from '../errors.ts';
import { audit, type Actor } from './audit.ts';
import type { ContactsService } from './contacts.ts';
import type { DeliveryService } from './delivery.ts';
import type { SegmentsService } from './segments.ts';
import type { TemplatesService } from './templates.ts';

const LEASE_MS = 5 * 60_000;
const MAX_STEPS_PER_RUN = 25;

export interface JourneyDeps {
  db: Kysely<Database>;
  contacts: ContactsService;
  templates: TemplatesService;
  segments: SegmentsService;
  delivery: DeliveryService;
  clock: () => Date;
  /** Other consumers of each event (e.g. outbound webhooks), run once per event before journeys. */
  eventHooks?: ((event: Event) => Promise<void>)[];
  log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

export function parseDefinition(input: unknown): JourneyDefinition {
  const parsed = journeyDefinitionSchema.safeParse(input);
  if (!parsed.success) throw badRequest('Invalid journey', parsed.error.issues.map((i) => ({ path: `definition.${i.path.join('.')}`, message: i.message })));
  return parsed.data;
}

const sameValue = (a: unknown, b: unknown) => a !== undefined && a !== null && String(a) === String(b);

export function createJourneysService({ db, contacts, templates, segments, delivery, clock, eventHooks = [], log = () => {} }: JourneyDeps) {
  async function getRow(id: string) {
    const j = await db.selectFrom('journeys').selectAll().where('id', '=', id).executeTakeFirst();
    if (!j) throw notFound('Journey');
    return j;
  }

  /** Structural problems plus template checks; empty means the journey can be activated. */
  async function problems(def: JourneyDefinition) {
    const list = journeyProblems(def);
    for (const [id, step] of Object.entries(def.steps)) {
      if (step.type !== 'send') continue;
      const t = await db.selectFrom('templates').select(['id', 'archived_at']).where('id', '=', step.template_id).executeTakeFirst();
      if (!t) list.push({ step: id, message: 'Template not found' });
      else if (t.archived_at) list.push({ step: id, message: 'Template is archived' });
    }
    return list;
  }

  async function contactMatches(contactId: string, rules: NonNullable<JourneyDefinition['trigger']['filter']>) {
    const row = await db.selectFrom('contacts').select('id').where('id', '=', contactId).where(segments.where(rules)).executeTakeFirst();
    return !!row;
  }

  async function logStep(e: Pick<Enrollment, 'id' | 'journey_id'>, stepId: string, outcome: string, detail: Record<string, unknown> = {}) {
    await db.insertInto('journey_step_log').values({ enrollment_id: e.id, journey_id: e.journey_id, step_id: stepId, outcome, detail: JSON.stringify(detail), at: clock() }).execute();
  }

  async function finish(e: Pick<Enrollment, 'id'>, status: 'completed' | 'exited', reason: string | null) {
    await db.updateTable('journey_enrollments').set({ status, exit_reason: reason, current_step: null, next_run_at: null, waiting_for: null, completed_at: clock(), updated_at: clock() })
      .where('id', '=', e.id).where('status', '=', 'active').execute();
  }

  // ---------- event processing ----------

  async function enter(journey: Journey, event: Event): Promise<void> {
    const def = journey.definition;
    if (event.received_at.getTime() < (journey.activated_at?.getTime() ?? Infinity)) return; // only events after activation
    if (def.trigger.filter && !(await contactMatches(event.contact_id, def.trigger.filter))) return;
    const context = { ...event.properties, _event: event.name, _event_id: event.id, _occurred_at: event.occurred_at.toISOString() };
    let entryKey: string | null = null;
    if (def.trigger.entry_key) {
      const v = event.properties[def.trigger.entry_key];
      if (v === undefined || v === null || v === '') { log('warn', 'journey trigger without entry key', { journey: journey.id, event: event.id }); return; }
      entryKey = String(v);
    } else {
      const active = await db.selectFrom('journey_enrollments').select('id').where('journey_id', '=', journey.id).where('contact_id', '=', event.contact_id).where('status', '=', 'active').executeTakeFirst();
      if (active) return; // no re-entry while a run is in progress
    }
    const row = await db.insertInto('journey_enrollments').values({
      journey_id: journey.id, contact_id: event.contact_id, status: 'active', current_step: def.start, next_run_at: clock(),
      context: JSON.stringify(context), entry_key: entryKey, entered_at: clock(), updated_at: clock(),
    }).onConflict((oc) => oc.columns(['journey_id', 'contact_id', 'entry_key']).where('status', '=', 'active').where('entry_key', 'is not', null).doNothing())
      .returning(['id', 'journey_id']).executeTakeFirst();
    if (row) await logStep(row, def.start, 'entered', { event: event.name });
  }

  async function processEvent(event: Event): Promise<void> {
    // 1. Exits: e.g. the appointment this run is about was cancelled.
    const runs = await db.selectFrom('journey_enrollments').innerJoin('journeys', 'journeys.id', 'journey_enrollments.journey_id')
      .selectAll('journey_enrollments').select(['journeys.definition'])
      .where('journey_enrollments.contact_id', '=', event.contact_id).where('journey_enrollments.status', '=', 'active').execute();
    for (const run of runs) {
      const def = run.definition as JourneyDefinition;
      const exit = def.exit_on.find((x) => x.event_name === event.name && (!x.match_property || sameValue(event.properties[x.match_property], run.context[x.match_property])));
      if (exit) {
        await finish(run, 'exited', `exit_event:${event.name}`);
        await logStep(run, run.current_step ?? '-', 'exited', { event: event.name });
        continue;
      }
      // 2. Waiting runs that this event satisfies.
      if (run.waiting_for === event.name && run.current_step) {
        const step = def.steps[run.current_step];
        if (step?.type !== 'wait_for_event') continue;
        if (step.match_property && !sameValue(event.properties[step.match_property], run.context[step.match_property])) continue;
        const res = await db.updateTable('journey_enrollments').set({ current_step: step.matched, waiting_for: null, next_run_at: clock(), updated_at: clock() })
          .where('id', '=', run.id).where('status', '=', 'active').where('waiting_for', '=', event.name).executeTakeFirst();
        if (res.numUpdatedRows) {
          await logStep(run, run.current_step, 'event_matched', { event: event.name });
          if (!step.matched) await finish(run, 'completed', null);
        }
      }
    }
    // 3. New entries.
    const journeys = await db.selectFrom('journeys').selectAll().where('status', '=', 'active').where('trigger_event', '=', event.name).execute();
    for (const j of journeys) await enter(j, event);
  }

  async function processEvents(limit = 200): Promise<number> {
    return db.transaction().execute(async (tx) => {
      const batch = await tx.selectFrom('events').selectAll().where('processed_at', 'is', null).orderBy('received_at').orderBy('id').limit(limit).forUpdate().skipLocked().execute();
      for (const event of batch) {
        for (const hook of eventHooks) await hook(event);
        await processEvent(event);
        await tx.updateTable('events').set({ processed_at: clock() }).where('id', '=', event.id).execute();
      }
      return batch.length;
    });
  }

  // ---------- step execution ----------

  async function advance(run: Enrollment, journey: Journey, contact: Contact): Promise<void> {
    const def = journey.definition;
    let stepId: string | null = run.current_step;
    let resumedWait = run.waiting_for !== null; // picked up while parked on wait_for_event = timed out
    for (let i = 0; i < MAX_STEPS_PER_RUN; i++) {
      if (!stepId) return finish(run, 'completed', null);
      const step: JourneyStep | undefined = def.steps[stepId];
      if (!step) { await logStep(run, stepId, 'exited', { reason: 'step_removed' }); return finish(run, 'exited', 'step_removed'); }
      const now = clock();
      const park = async (next: string | null, at: Date, waitingFor: string | null = null) => {
        await db.updateTable('journey_enrollments').set({ current_step: next, next_run_at: at, waiting_for: waitingFor, updated_at: now }).where('id', '=', run.id).where('status', '=', 'active').execute();
      };

      switch (step.type) {
        case 'send': {
          try {
            const m = await delivery.enqueue({ contact, templateId: step.template_id, data: run.context, source: 'journey', journeyId: journey.id, idempotencyKey: `journey:${run.id}:${stepId}` });
            await logStep(run, stepId, m.status === 'suppressed' ? 'not_sent' : 'sent', { message_id: m.id, status: m.status, reason: m.status_reason });
          } catch (err) {
            if (!(err instanceof HttpError && err.statusCode < 500)) throw err;
            await logStep(run, stepId, 'failed', { error: err.message });
          }
          stepId = step.next;
          break;
        }
        case 'wait': {
          await logStep(run, stepId, 'waiting');
          return park(step.next, new Date(now.getTime() + durationMs(step.duration)));
        }
        case 'wait_until': {
          const base = new Date(String(run.context[step.property] ?? ''));
          if (Number.isNaN(base.getTime())) { await logStep(run, stepId, 'exited', { reason: 'invalid_time', property: step.property }); return finish(run, 'exited', 'invalid_time'); }
          const target = new Date(base.getTime() + durationMs(step.offset));
          if (target.getTime() <= now.getTime()) {
            if (step.if_past === 'exit') { await logStep(run, stepId, 'exited', { reason: 'time_passed' }); return finish(run, 'exited', 'time_passed'); }
            await logStep(run, stepId, 'time_passed');
            stepId = step.next;
            break;
          }
          await logStep(run, stepId, 'waiting', { until: target.toISOString() });
          return park(step.next, target);
        }
        case 'wait_for_event': {
          if (resumedWait) {
            resumedWait = false;
            await logStep(run, stepId, 'timed_out');
            await park(step.timed_out, now);
            stepId = step.timed_out;
            break;
          }
          await logStep(run, stepId, 'waiting', { event: step.event_name });
          return park(stepId, new Date(now.getTime() + durationMs(step.timeout)), step.event_name);
        }
        case 'split': {
          const yes = await contactMatches(contact.id, step.condition);
          await logStep(run, stepId, yes ? 'yes' : 'no');
          stepId = yes ? step.yes : step.no;
          break;
        }
        case 'update': {
          contact = (await contacts.upsert({ contact_id: contact.id, ...step.attributes }, { source: 'journey', actor: { type: 'system', id: `journey:${journey.id}` } })).contact;
          await logStep(run, stepId, 'updated', { attributes: Object.keys(step.attributes) });
          stepId = step.next;
          break;
        }
      }
    }
    // Defensive: definitions are acyclic, so this only triggers on very long chains.
    await db.updateTable('journey_enrollments').set({ current_step: stepId, next_run_at: clock(), updated_at: clock() }).where('id', '=', run.id).where('status', '=', 'active').execute();
  }

  async function runDue(limit = 100): Promise<number> {
    const now = clock();
    const claimed = await db.updateTable('journey_enrollments')
      .set({ next_run_at: new Date(now.getTime() + LEASE_MS), updated_at: now })
      .where('id', 'in', (eb) => eb.selectFrom('journey_enrollments').select('journey_enrollments.id')
        .where('journey_enrollments.status', '=', 'active').where('journey_enrollments.next_run_at', '<=', now)
        .where((w) => w.exists(w.selectFrom('journeys').select(sql`1`.as('one')).whereRef('journeys.id', '=', 'journey_enrollments.journey_id').where('journeys.status', '=', 'active')))
        .orderBy('journey_enrollments.next_run_at').limit(limit).forNoKeyUpdate().skipLocked())
      .returningAll().execute();
    const cache = new Map<string, Journey>();
    for (const run of claimed) {
      try {
        const journey = cache.get(run.journey_id) ?? (await getRow(run.journey_id));
        cache.set(journey.id, journey);
        const contact = await db.selectFrom('contacts').selectAll().where('id', '=', run.contact_id).executeTakeFirst();
        if (!contact) continue; // erased; the run cascades away
        await advance(run, journey, contact);
      } catch (err) {
        log('error', 'journey step failed; will retry after the lease', { enrollment: run.id, error: (err as Error).message });
      }
    }
    return claimed.length;
  }

  // ---------- simulation (no side effects) ----------

  async function simulate(input: { definition: unknown; contact_id?: string | undefined; context?: Record<string, unknown> | undefined; events?: string[] | undefined }) {
    const def = parseDefinition(input.definition);
    const structural = journeyProblems(def);
    if (structural.length) throw badRequest('The journey has problems', structural.map((p) => ({ path: p.step ? `definition.steps.${p.step}` : 'definition', message: p.message })));
    const contact = input.contact_id ? await contacts.get(input.contact_id) : null;
    const context = input.context ?? {};
    const happen = new Set(input.events ?? []);
    let at = clock();
    const path: { step: string; type: JourneyStep['type']; at: string; outcome: string; detail?: Record<string, unknown> }[] = [];
    let stepId: string | null = def.start;
    while (stepId && path.length < 60) {
      const step: JourneyStep = def.steps[stepId]!;
      const entry = { step: stepId, type: step.type, at: at.toISOString() };
      switch (step.type) {
        case 'send': {
          const t = await templates.get(step.template_id).catch(() => null);
          const address = t && contact ? (t.channel === 'email' ? contact.email : contact.phone) : null;
          const allowed = !!t && !!contact && !!address && canSend(contact.consent, t.channel, t.purpose);
          path.push({ ...entry, outcome: !contact ? 'would_send' : allowed ? 'would_send' : 'would_not_send', detail: { template: t?.name ?? null, channel: t?.channel ?? null, ...(contact && !allowed ? { reason: !address ? 'no_address' : 'no_consent' } : {}) } });
          stepId = step.next; break;
        }
        case 'wait':
          at = new Date(at.getTime() + durationMs(step.duration));
          path.push({ ...entry, outcome: 'wait', detail: { until: at.toISOString() } });
          stepId = step.next; break;
        case 'wait_until': {
          const base = new Date(String(context[step.property] ?? ''));
          if (Number.isNaN(base.getTime())) { path.push({ ...entry, outcome: 'exit', detail: { reason: 'invalid_time', property: step.property } }); stepId = null; break; }
          const target = new Date(base.getTime() + durationMs(step.offset));
          if (target <= at) {
            path.push({ ...entry, outcome: step.if_past === 'exit' ? 'exit' : 'time_passed', detail: { target: target.toISOString() } });
            stepId = step.if_past === 'exit' ? null : step.next; break;
          }
          at = target;
          path.push({ ...entry, outcome: 'wait', detail: { until: at.toISOString() } });
          stepId = step.next; break;
        }
        case 'wait_for_event': {
          const matched = happen.has(step.event_name);
          if (!matched) at = new Date(at.getTime() + durationMs(step.timeout));
          path.push({ ...entry, outcome: matched ? 'event_matched' : 'timed_out', detail: { event: step.event_name } });
          stepId = matched ? step.matched : step.timed_out; break;
        }
        case 'split': {
          const yes: boolean = contact ? await contactMatches(contact.id, step.condition) : false;
          path.push({ ...entry, outcome: contact ? (yes ? 'yes' : 'no') : 'no (no contact)' });
          stepId = yes ? step.yes : step.no; break;
        }
        case 'update':
          path.push({ ...entry, outcome: 'update', detail: { attributes: Object.keys(step.attributes) } });
          stepId = step.next; break;
      }
    }
    return { path };
  }

  // ---------- management ----------

  async function stats(id: string) {
    const [byStatus, steps, messages] = await Promise.all([
      db.selectFrom('journey_enrollments').select(['status', (eb) => eb.fn.countAll<string>().as('n')]).where('journey_id', '=', id).groupBy('status').execute(),
      db.selectFrom('journey_step_log').select(['step_id', 'outcome', (eb) => eb.fn.countAll<string>().as('n')]).where('journey_id', '=', id).groupBy(['step_id', 'outcome']).execute(),
      db.selectFrom('messages').select([(eb) => eb.fn.countAll<string>().as('total'), sql<string>`count(*) filter (where status in ('sent', 'delivered'))`.as('sent')]).where('journey_id', '=', id).executeTakeFirstOrThrow(),
    ]);
    const enrollments = { active: 0, completed: 0, exited: 0 } as Record<'active' | 'completed' | 'exited', number>;
    for (const r of byStatus) enrollments[r.status] = Number(r.n);
    const perStep: Record<string, Record<string, number>> = {};
    for (const r of steps) (perStep[r.step_id] ??= {})[r.outcome] = Number(r.n);
    return { enrollments, steps: perStep, messages: { total: Number(messages.total), sent: Number(messages.sent) } };
  }

  return {
    processEvents,
    runDue,
    simulate,
    stats,
    get: getRow,

    async list() {
      const rows = await db.selectFrom('journeys').selectAll().where('status', '!=', 'archived').orderBy('updated_at', 'desc').execute();
      return Promise.all(rows.map(async (j) => ({ ...j, stats: await stats(j.id) })));
    },

    async saveLayout(id: string, layout: Record<string, { x: number; y: number }>) {
      const j = await getRow(id);
      if (j.status === 'archived') throw conflict('Archived journeys cannot be changed');
      await db.updateTable('journeys').set({ layout: JSON.stringify(layout) }).where('id', '=', id).execute();
      return { layout };
    },

    async detail(id: string) {
      const j = await getRow(id);
      return { ...j, problems: await problems(j.definition), stats: await stats(id) };
    },

    async create(input: { name?: unknown; description?: unknown; definition?: unknown }, actor: Actor) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name) throw badRequest('Name is required', [{ path: 'name', message: 'Required' }]);
      const def = parseDefinition(input.definition);
      const row = await db.insertInto('journeys').values({
        name: name.slice(0, 200), description: typeof input.description === 'string' ? input.description.slice(0, 1000) : '',
        definition: JSON.stringify(def), trigger_event: def.trigger.event_name, created_by: actor.type === 'user' ? actor.id : null, created_at: clock(), updated_at: clock(),
      }).returningAll().executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'journey.create', entityType: 'journey', entityId: row.id });
      return { ...row, problems: await problems(def) };
    },

    /** Draft and paused journeys can be edited. Runs parked on a removed step exit when they resume. */
    async update(id: string, input: { name?: unknown; description?: unknown; definition?: unknown }, actor: Actor) {
      const j = await getRow(id);
      if (j.status === 'active') throw conflict('Pause the journey before editing it');
      if (j.status === 'archived') throw conflict('Archived journeys cannot be edited');
      const set: Record<string, unknown> = { updated_at: clock() };
      if (typeof input.name === 'string' && input.name.trim()) set.name = input.name.trim().slice(0, 200);
      if (typeof input.description === 'string') set.description = input.description.slice(0, 1000);
      if (input.definition !== undefined) {
        const def = parseDefinition(input.definition);
        set.definition = JSON.stringify(def);
        set.trigger_event = def.trigger.event_name;
      }
      const row = await db.updateTable('journeys').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'journey.update', entityType: 'journey', entityId: id, details: { fields: Object.keys(set).filter((k) => k !== 'updated_at') } });
      return { ...row, problems: await problems(row.definition) };
    },

    async activate(id: string, actor: Actor) {
      const j = await getRow(id);
      if (j.status === 'active') return j;
      if (j.status === 'archived') throw conflict('Archived journeys cannot be activated');
      const list = await problems(j.definition);
      if (list.length) throw badRequest('Fix the journey before activating it', list.map((p) => ({ path: p.step ? `definition.steps.${p.step}` : 'definition', message: p.message })));
      const row = await db.updateTable('journeys').set({ status: 'active', activated_at: j.activated_at ?? clock(), updated_at: clock() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'journey.activate', entityType: 'journey', entityId: id });
      return row;
    },

    /** Paused: no new entries and no steps run; runs resume where they were when reactivated. */
    async pause(id: string, actor: Actor) {
      const j = await getRow(id);
      if (j.status !== 'active') throw conflict('Only active journeys can be paused');
      const row = await db.updateTable('journeys').set({ status: 'paused', updated_at: clock() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'journey.pause', entityType: 'journey', entityId: id });
      return row;
    },

    async archive(id: string, actor: Actor) {
      await getRow(id);
      await db.transaction().execute(async (tx) => {
        await tx.updateTable('journeys').set({ status: 'archived', updated_at: clock() }).where('id', '=', id).execute();
        await tx.updateTable('journey_enrollments').set({ status: 'exited', exit_reason: 'journey_archived', next_run_at: null, waiting_for: null, completed_at: clock(), updated_at: clock() })
          .where('journey_id', '=', id).where('status', '=', 'active').execute();
        await audit(tx, actor, { action: 'journey.archive', entityType: 'journey', entityId: id });
      });
    },

    async enrollments(id: string, limit = 50) {
      await getRow(id);
      return db.selectFrom('journey_enrollments').innerJoin('contacts', 'contacts.id', 'journey_enrollments.contact_id')
        .select(['journey_enrollments.id', 'journey_enrollments.contact_id', 'contacts.external_id', 'contacts.first_name', 'contacts.last_name', 'journey_enrollments.status',
          'journey_enrollments.current_step', 'journey_enrollments.next_run_at', 'journey_enrollments.waiting_for', 'journey_enrollments.exit_reason', 'journey_enrollments.entry_key',
          'journey_enrollments.entered_at', 'journey_enrollments.completed_at'])
        .where('journey_enrollments.journey_id', '=', id).orderBy('journey_enrollments.entered_at', 'desc').limit(Math.min(limit, 200)).execute();
    },

    async forContact(contactId: string) {
      return db.selectFrom('journey_enrollments').innerJoin('journeys', 'journeys.id', 'journey_enrollments.journey_id')
        .select(['journey_enrollments.id', 'journeys.id as journey_id', 'journeys.name as journey_name', 'journey_enrollments.status', 'journey_enrollments.current_step',
          'journey_enrollments.next_run_at', 'journey_enrollments.exit_reason', 'journey_enrollments.entered_at', 'journey_enrollments.completed_at'])
        .where('journey_enrollments.contact_id', '=', contactId).orderBy('journey_enrollments.entered_at', 'desc').limit(20).execute();
    },

    /** Creates the bilingual appointment-reminder templates (if missing) and a draft journey wired to PureNet events. */
    async createAppointmentReminderStarter(actor: Actor) {
      const ensure = async (name: string, input: Record<string, unknown>) => {
        const existing = await db.selectFrom('templates').select('id').where('name', '=', name).where('archived_at', 'is', null).executeTakeFirst();
        return existing?.id ?? (await templates.create({ name, ...input }, actor)).id;
      };
      const confirmation = await ensure('Appointment confirmation (email)', {
        channel: 'email', purpose: 'care', description: 'Sent when PureNet reports a new booking.',
        content: {
          en: { subject: 'Your appointment is confirmed', html: '<p>Hello {{ contact.first_name | default: "there" }},</p><p>Your appointment is confirmed for <strong>{{ data.start | local_datetime: contact.timezone }}</strong>.</p><p>If you need to change it, please contact your clinic.</p><p>{{ brand.name }}</p>' },
          ar: { subject: 'تم تأكيد موعدك', html: '<p>مرحبًا {{ contact.first_name | default: "" }}،</p><p>تم تأكيد موعدك في <strong>{{ data.start | local_datetime: contact.timezone, "ar" }}</strong>.</p><p>إذا احتجت إلى تغييره، يُرجى التواصل مع عيادتك.</p><p>{{ brand.name }}</p>' },
        },
      });
      const reminder = await ensure('Appointment reminder (SMS)', {
        channel: 'sms', purpose: 'care', description: 'Sent 24 hours before the appointment.',
        content: {
          en: { body: '{{ brand.name }}: reminder of your appointment {{ data.start | local_datetime: contact.timezone }}. Need to change it? Contact your clinic.' },
          ar: { body: '{{ brand.name }}: تذكير بموعدك {{ data.start | local_datetime: contact.timezone, "ar" }}. للتغيير، تواصل مع عيادتك.' },
        },
      });
      const definition: JourneyDefinition = {
        trigger: { event_name: 'purenet.appointment.booked', entry_key: 'appointment_id' },
        exit_on: [{ event_name: 'purenet.appointment.cancelled', match_property: 'appointment_id' }],
        start: 'confirm',
        steps: {
          confirm: { type: 'send', template_id: confirmation, next: 'day_before' },
          day_before: { type: 'wait_until', property: 'start', offset: { days: 0, hours: -24, minutes: 0 }, if_past: 'continue', next: 'remind' },
          remind: { type: 'send', template_id: reminder, next: null },
        },
      };
      return this.create({ name: 'Appointment reminders', description: 'Confirms each PureNet booking by email, then sends an SMS reminder 24 hours before. Stops if the appointment is cancelled.', definition }, actor);
    },

    nextSteps,
  };
}

export type JourneysService = ReturnType<typeof createJourneysService>;
