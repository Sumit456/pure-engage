// Outbound webhooks (docs/contracts/platform-webhooks.asyncapi.yaml): every recorded event that matches a
// webhook's filter is queued, signed (X-PE-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "{t}.{body}")>)
// and delivered with retries. The payload carries only identifiers, never profile data.
import { createHmac, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Database, Event } from '../db/schema.ts';
import { badRequest, notFound } from '../errors.ts';
import { audit, type Actor } from './audit.ts';
import { decrypt, encrypt } from './crypto.ts';
import { UnsafeUrlError, assertWebhookUrl, safePost } from './net.ts';

export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
export const MAX_WEBHOOK_ATTEMPTS = BACKOFF_MS.length + 1;

export function signPayload(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

const inputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  url: z.string().trim().max(2000),
  events: z.array(z.string().min(1).max(200)).min(1).max(50).default(['*']),
  enabled: z.boolean().default(true),
});

export function createWebhooksService({ db, config, clock, log = () => {} }: { db: Kysely<Database>; config: Config; clock: () => Date; log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void }) {
  const allowPrivate = config.PE_WEBHOOKS_ALLOW_PRIVATE;
  const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;
  const publicColumns = ['id', 'name', 'url', 'events', 'enabled', 'created_at', 'updated_at'] as const;

  const checkUrl = (url: string) => {
    try { assertWebhookUrl(url, { allowPrivate }); } catch (err) {
      throw badRequest((err as Error).message, [{ path: 'url', message: (err as Error).message }]);
    }
  };

  async function getRow(id: string) {
    const w = await db.selectFrom('webhooks').selectAll().where('id', '=', id).executeTakeFirst();
    if (!w) throw notFound('Webhook');
    return w;
  }

  async function enqueue(webhookId: string, eventName: string, payload: Record<string, unknown>) {
    await db.insertInto('webhook_deliveries').values({
      id: payload.id as string, webhook_id: webhookId, event_name: eventName, payload: JSON.stringify(payload), status: 'pending', next_attempt_at: clock(), created_at: clock(), updated_at: clock(),
    }).execute();
  }

  async function attempt(d: { id: string; webhook_id: string; event_name: string; payload: Record<string, unknown>; attempts: number }, { final = false } = {}) {
    const hook = await db.selectFrom('webhooks').select(['url', 'secret_encrypted', 'enabled']).where('id', '=', d.webhook_id).executeTakeFirst();
    if (!hook) return;
    const body = JSON.stringify(d.payload);
    const attempts = d.attempts + 1;
    let code: number | null = null;
    let error: string | null = null;
    try {
      const res = await safePost(hook.url, body, {
        'content-type': 'application/json',
        'user-agent': 'PureEngage-Webhooks/1.0',
        'x-pe-event': d.event_name,
        'x-pe-delivery': d.id,
        'x-pe-signature': signPayload(decrypt(config.secretKey, hook.secret_encrypted), body, Math.floor(clock().getTime() / 1000)),
      }, { allowPrivate });
      code = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof UnsafeUrlError ? `blocked: ${err.message}` : (err as Error).message;
    }
    const permanent = error?.startsWith('blocked:') ?? false;
    const status = !error ? 'success' : final || permanent || attempts >= MAX_WEBHOOK_ATTEMPTS ? 'failed' : 'pending';
    await db.updateTable('webhook_deliveries').set({
      status, attempts, response_code: code, error: error?.slice(0, 500) ?? null, updated_at: clock(),
      next_attempt_at: status === 'pending' ? new Date(clock().getTime() + BACKOFF_MS[attempts - 1]!) : null,
    }).where('id', '=', d.id).execute();
    if (error) log('warn', 'webhook delivery failed', { delivery: d.id, attempts, error });
    return status;
  }

  return {
    async list() {
      return db.selectFrom('webhooks').select(publicColumns).orderBy('created_at', 'desc').execute();
    },

    /** Returns the signing secret once; it's stored encrypted and never shown again. */
    async create(input: unknown, actor: Actor) {
      const data = inputSchema.parse(input);
      checkUrl(data.url);
      const secret = newSecret();
      const row = await db.insertInto('webhooks').values({
        name: data.name, url: data.url, events: JSON.stringify(data.events), enabled: data.enabled,
        secret_encrypted: encrypt(config.secretKey, secret), created_by: actor.type === 'user' ? actor.id : null, created_at: clock(), updated_at: clock(),
      }).returning(publicColumns).executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'webhook.create', entityType: 'webhook', entityId: row.id });
      return { ...row, secret };
    },

    async update(id: string, input: unknown, actor: Actor) {
      await getRow(id);
      const data = inputSchema.partial().parse(input);
      if (data.url !== undefined) checkUrl(data.url);
      const row = await db.updateTable('webhooks').set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.url !== undefined ? { url: data.url } : {}),
        ...(data.events !== undefined ? { events: JSON.stringify(data.events) } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
        updated_at: clock(),
      }).where('id', '=', id).returning(publicColumns).executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'webhook.update', entityType: 'webhook', entityId: id, details: { fields: Object.keys(data) } });
      return row;
    },

    async remove(id: string, actor: Actor) {
      await getRow(id);
      await db.deleteFrom('webhooks').where('id', '=', id).execute();
      await audit(db, actor, { action: 'webhook.delete', entityType: 'webhook', entityId: id });
    },

    async rotateSecret(id: string, actor: Actor) {
      await getRow(id);
      const secret = newSecret();
      await db.updateTable('webhooks').set({ secret_encrypted: encrypt(config.secretKey, secret), updated_at: clock() }).where('id', '=', id).execute();
      await audit(db, actor, { action: 'webhook.rotate_secret', entityType: 'webhook', entityId: id });
      return { secret };
    },

    /** Sends a synthetic event right away (one attempt) and returns the delivery. */
    async test(id: string, actor: Actor) {
      await getRow(id);
      const deliveryId = crypto.randomUUID();
      const payload = { id: deliveryId, type: 'event', created_at: clock().toISOString(), event: { id: crypto.randomUUID(), name: 'pure_engage.test', properties: {}, source: 'test', ts: clock().toISOString() }, contact: { id: null, external_id: null } };
      await enqueue(id, 'pure_engage.test', payload);
      await db.updateTable('webhook_deliveries').set({ next_attempt_at: null }).where('id', '=', deliveryId).execute();
      await attempt({ id: deliveryId, webhook_id: id, event_name: 'pure_engage.test', payload, attempts: 0 }, { final: true });
      await audit(db, actor, { action: 'webhook.test', entityType: 'webhook', entityId: id });
      return db.selectFrom('webhook_deliveries').selectAll().where('id', '=', deliveryId).executeTakeFirstOrThrow();
    },

    async deliveries(id: string, limit = 50) {
      await getRow(id);
      return db.selectFrom('webhook_deliveries').select(['id', 'event_name', 'status', 'attempts', 'next_attempt_at', 'response_code', 'error', 'created_at', 'updated_at'])
        .where('webhook_id', '=', id).orderBy('created_at', 'desc').limit(Math.min(limit, 200)).execute();
    },

    /** Manual retry of a failed delivery (one attempt). */
    async retry(deliveryId: string, actor: Actor) {
      const d = await db.selectFrom('webhook_deliveries').selectAll().where('id', '=', deliveryId).executeTakeFirst();
      if (!d) throw notFound('Delivery');
      await attempt(d, { final: true });
      await audit(db, actor, { action: 'webhook.retry', entityType: 'webhook', entityId: d.webhook_id, details: { delivery: deliveryId } });
      return db.selectFrom('webhook_deliveries').selectAll().where('id', '=', deliveryId).executeTakeFirstOrThrow();
    },

    /** Called once per event by the event processor. The payload has identifiers only, not profile data. */
    async enqueueForEvent(event: Event) {
      const hooks = await db.selectFrom('webhooks').select(['id', 'events']).where('enabled', '=', true).execute();
      const matching = hooks.filter((h) => h.events.includes('*') || h.events.includes(event.name));
      if (!matching.length) return;
      const contact = await db.selectFrom('contacts').select(['id', 'external_id']).where('id', '=', event.contact_id).executeTakeFirst();
      for (const h of matching) {
        const id = crypto.randomUUID();
        await enqueue(h.id, event.name, {
          id, type: 'event', created_at: clock().toISOString(),
          event: { id: event.id, name: event.name, properties: event.properties, source: event.source, ts: event.occurred_at.toISOString() },
          contact: { id: contact?.id ?? event.contact_id, external_id: contact?.external_id ?? null },
        });
      }
    },

    /** Worker step: due deliveries, claimed with SKIP LOCKED and a lease. */
    async dispatchDue(limit = 50) {
      const now = clock();
      const claimed = await db.updateTable('webhook_deliveries').set({ next_attempt_at: new Date(now.getTime() + 5 * 60_000), updated_at: now })
        .where('id', 'in', (eb) => eb.selectFrom('webhook_deliveries').select('id').where('status', '=', 'pending').where('next_attempt_at', '<=', now)
          .orderBy('next_attempt_at').limit(limit).forUpdate().skipLocked())
        .returningAll().execute();
      for (const d of claimed) await attempt(d);
      return claimed.length;
    },
  };
}

export type WebhooksService = ReturnType<typeof createWebhooksService>;
