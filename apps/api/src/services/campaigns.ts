// Campaigns: a template sent to a segment, now or at a scheduled time. Fan-out is batched and resumable:
// the campaign row is locked while a batch is enqueued, the cursor advances after each batch, and every message
// has the idempotency key `campaign:<id>:<contact id>`, so a crash or a second worker can never send twice.
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Campaign, Database } from '../db/schema.ts';
import { HttpError, badRequest, conflict, notFound } from '../errors.ts';
import { audit, type Actor } from './audit.ts';
import type { DeliveryService } from './delivery.ts';
import type { SegmentsService } from './segments.ts';
import type { TemplatesService } from './templates.ts';

const createSchema = z.object({ name: z.string().trim().min(1).max(200), template_id: z.string().uuid(), segment_id: z.string().uuid() });
const updateSchema = createSchema.partial();

export interface CampaignDeps {
  db: Kysely<Database>;
  segments: SegmentsService;
  templates: TemplatesService;
  delivery: DeliveryService;
  clock: () => Date;
  batchSize: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

export function createCampaignsService({ db, segments, templates, delivery, clock, batchSize, log = () => {} }: CampaignDeps) {
  async function getRow(id: string) {
    const c = await db.selectFrom('campaigns').selectAll().where('id', '=', id).executeTakeFirst();
    if (!c) throw notFound('Campaign');
    return c;
  }

  async function assertUsable(templateId: string, segmentId: string) {
    const t = await templates.get(templateId);
    if (t.archived_at) throw badRequest('Template is archived', [{ path: 'template_id', message: 'Archived' }]);
    const s = await segments.get(segmentId);
    if (s.archived_at) throw badRequest('Segment is archived', [{ path: 'segment_id', message: 'Archived' }]);
    return { template: t, segment: s };
  }

  async function stats(id: string) {
    const rows = await db.selectFrom('messages').select(['status', 'status_reason', (eb) => eb.fn.countAll<string>().as('n')])
      .where('campaign_id', '=', id).where('source', '=', 'campaign').groupBy(['status', 'status_reason']).execute();
    const engagement = await db.selectFrom('messages')
      .select([sql<string>`count(*) filter (where opened_at is not null)`.as('opened'), sql<string>`count(*) filter (where clicked_at is not null)`.as('clicked')])
      .where('campaign_id', '=', id).where('source', '=', 'campaign').executeTakeFirstOrThrow();
    const by: Record<string, number> = {};
    const suppressed: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const n = Number(r.n);
      total += n;
      by[r.status] = (by[r.status] ?? 0) + n;
      if (r.status === 'suppressed' && r.status_reason) suppressed[r.status_reason] = (suppressed[r.status_reason] ?? 0) + n;
    }
    return {
      targeted: total,
      pending: (by.queued ?? 0) + (by.deferred ?? 0) + (by.sending ?? 0),
      sent: (by.sent ?? 0) + (by.delivered ?? 0),
      delivered: by.delivered ?? 0,
      failed: by.failed ?? 0,
      suppressed: by.suppressed ?? 0,
      suppressed_by_reason: suppressed,
      opened: Number(engagement.opened),
      clicked: Number(engagement.clicked),
    };
  }

  /** One batch for one due campaign. Returns false when nothing was due. */
  async function processOne(): Promise<boolean> {
    const now = clock();
    return db.transaction().execute(async (tx) => {
      const c = await tx.selectFrom('campaigns').selectAll()
        .where('status', 'in', ['scheduled', 'sending']).where('scheduled_at', '<=', now)
        // NO KEY UPDATE, not UPDATE: messages inserted on other connections reference this row, and their
        // foreign-key checks take KEY SHARE locks, which FOR UPDATE would block (a deadlock across the pool).
        .orderBy('scheduled_at').limit(1).forNoKeyUpdate().skipLocked().executeTakeFirst();
      if (!c) return false;
      if (c.status === 'scheduled') {
        await tx.updateTable('campaigns').set({ status: 'sending', started_at: now, updated_at: now }).where('id', '=', c.id).execute();
        await audit(tx, { type: 'system', id: 'campaigns' }, { action: 'campaign.start', entityType: 'campaign', entityId: c.id });
      }
      const segment = await segments.get(c.segment_id);
      const batch = await segments.memberBatch(segment.rules, c.cursor_contact_id, batchSize);
      let enqueued = 0;
      for (const contact of batch) {
        try {
          await delivery.enqueue({ contact, templateId: c.template_id, source: 'campaign', campaignId: c.id, idempotencyKey: `campaign:${c.id}:${contact.id}` });
          enqueued++;
        } catch (err) {
          if (err instanceof HttpError && err.statusCode < 500) {
            // The template became unusable mid-send (e.g. archived): stop rather than skip silently.
            await tx.updateTable('campaigns').set({ status: 'cancelled', completed_at: now, updated_at: now }).where('id', '=', c.id).execute();
            log('warn', 'campaign stopped', { id: c.id, reason: err.message });
            return true;
          }
          throw err;
        }
      }
      const done = batch.length < batchSize;
      await tx.updateTable('campaigns').set({
        cursor_contact_id: batch.at(-1)?.id ?? c.cursor_contact_id,
        enqueued_count: sql`enqueued_count + ${enqueued}`,
        updated_at: now,
        ...(done ? { status: 'sent' as const, completed_at: now } : {}),
      }).where('id', '=', c.id).execute();
      if (done) await audit(tx, { type: 'system', id: 'campaigns' }, { action: 'campaign.complete', entityType: 'campaign', entityId: c.id, details: { enqueued: c.enqueued_count + enqueued } });
      return true;
    });
  }

  return {
    get: getRow,
    stats,

    async list() {
      const rows = await db.selectFrom('campaigns')
        .innerJoin('templates', 'templates.id', 'campaigns.template_id')
        .innerJoin('segments', 'segments.id', 'campaigns.segment_id')
        .selectAll('campaigns')
        .select(['templates.name as template_name', 'templates.channel', 'templates.purpose', 'segments.name as segment_name'])
        .orderBy('campaigns.created_at', 'desc').execute();
      return Promise.all(rows.map(async (r) => ({ ...r, stats: await stats(r.id) })));
    },

    async detail(id: string) {
      const c = await getRow(id);
      const [template, segment, s] = await Promise.all([templates.get(c.template_id), segments.get(c.segment_id), stats(id)]);
      return { ...c, template: { id: template.id, name: template.name, channel: template.channel, purpose: template.purpose }, segment: { id: segment.id, name: segment.name }, stats: s };
    },

    async create(input: unknown, actor: Actor) {
      const data = createSchema.parse(input);
      await assertUsable(data.template_id, data.segment_id);
      const row = await db.insertInto('campaigns').values({ ...data, created_by: actor.type === 'user' ? actor.id : null, created_at: clock(), updated_at: clock() }).returningAll().executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'campaign.create', entityType: 'campaign', entityId: row.id });
      return row;
    },

    async update(id: string, input: unknown, actor: Actor) {
      const data = updateSchema.parse(input);
      const c = await getRow(id);
      if (c.status !== 'draft') throw conflict('Only draft campaigns can be edited');
      await assertUsable(data.template_id ?? c.template_id, data.segment_id ?? c.segment_id);
      const row = await db.updateTable('campaigns').set({ ...data, updated_at: clock() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'campaign.update', entityType: 'campaign', entityId: id, details: { fields: Object.keys(data) } });
      return row;
    },

    /** How many of the segment can actually receive it: address present and consent granted for the template. */
    async estimate(id: string) {
      const c = await getRow(id);
      const { template, segment } = await assertUsable(c.template_id, c.segment_id);
      const addressCol = template.channel === 'email' ? 'email' : 'phone';
      const base = db.selectFrom('contacts').where(segments.where(segment.rules));
      const [{ n: total }, { n: eligible }] = await Promise.all([
        base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
        base.select((eb) => eb.fn.countAll<string>().as('n'))
          .where(addressCol, 'is not', null)
          .where(sql<string>`consent -> ${template.channel} ->> ${template.purpose}`, '=', 'granted')
          .where((eb) => eb.not(eb.exists(eb.selectFrom('suppressions').select(sql`1`.as('one')).where('suppressions.channel', '=', template.channel).whereRef('suppressions.address', '=', sql`lower(contacts.${sql.ref(addressCol)})`))))
          .executeTakeFirstOrThrow(),
      ]);
      return { segment_size: Number(total), eligible: Number(eligible), channel: template.channel, purpose: template.purpose };
    },

    /** Schedules for `at`, or for now when omitted. */
    async schedule(id: string, at: string | undefined, actor: Actor): Promise<Campaign> {
      const c = await getRow(id);
      if (c.status !== 'draft') throw conflict('Only draft campaigns can be scheduled');
      await assertUsable(c.template_id, c.segment_id);
      const when = at ? new Date(at) : clock();
      if (Number.isNaN(when.getTime())) throw badRequest('Invalid date', [{ path: 'scheduled_at', message: 'Invalid date' }]);
      if (at && when.getTime() < clock().getTime() - 60_000) throw badRequest('That time is in the past', [{ path: 'scheduled_at', message: 'In the past' }]);
      const row = await db.updateTable('campaigns').set({ status: 'scheduled', scheduled_at: when, updated_at: clock() }).where('id', '=', id).where('status', '=', 'draft').returningAll().executeTakeFirst();
      if (!row) throw conflict('Campaign changed; reload and try again');
      await audit(db, actor, { action: 'campaign.schedule', entityType: 'campaign', entityId: id, details: { scheduled_at: when.toISOString() } });
      return row;
    },

    /** Stops further fan-out and withdraws messages that haven't gone out yet. */
    async cancel(id: string, actor: Actor) {
      const c = await getRow(id);
      if (!['draft', 'scheduled', 'sending'].includes(c.status)) throw conflict(`A ${c.status} campaign can't be cancelled`);
      await db.transaction().execute(async (tx) => {
        await tx.updateTable('campaigns').set({ status: 'cancelled', completed_at: clock(), updated_at: clock() }).where('id', '=', id).execute();
        await tx.updateTable('messages').set({ status: 'suppressed', status_reason: 'campaign_cancelled', next_attempt_at: null, updated_at: clock() })
          .where('campaign_id', '=', id).where('status', 'in', ['queued', 'deferred']).execute();
        await audit(tx, actor, { action: 'campaign.cancel', entityType: 'campaign', entityId: id });
      });
      return getRow(id);
    },

    /** Sends the campaign's template to one contact (still subject to consent and policy). */
    async testSend(id: string, contactId: string, actor: Actor) {
      const c = await getRow(id);
      const contact = await db.selectFrom('contacts').selectAll().where('id', '=', contactId).executeTakeFirst();
      if (!contact) throw notFound('Contact');
      const m = await delivery.enqueue({ contact, templateId: c.template_id, source: 'campaign_test', campaignId: c.id });
      await audit(db, actor, { action: 'campaign.test_send', entityType: 'campaign', entityId: id, details: { contact_id: contactId, message_id: m.id } });
      return m;
    },

    /** Processes up to `maxBatches` batches across due campaigns. */
    async processDue(maxBatches = 5): Promise<number> {
      let n = 0;
      while (n < maxBatches && (await processOne())) n++;
      return n;
    },
  };
}

export type CampaignsService = ReturnType<typeof createCampaignsService>;
