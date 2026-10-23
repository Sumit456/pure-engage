// Inbound webhooks (any app that can post JSON: Zapier, Make, n8n, booking or form tools) and the integration
// request log. A payload is mapped to the platform's own /track shape (applyMapping in packages/shared) and goes
// through the normal ingest path, so contact resolution, consent history and journeys behave exactly as for the API.
import { createHmac, randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { MAPPABLE_CONTACT_FIELDS, applyMapping, type InboundMapping } from '@pure-engage/shared';
import type { Config } from '../config.ts';
import type { Database, InboundWebhookConfig } from '../db/schema.ts';
import { HttpError, badRequest, notFound } from '../errors.ts';
import { audit, type Actor } from './audit.ts';
import { decrypt, encrypt, safeEqual } from './crypto.ts';
import type { IngestService } from './ingest.ts';

const path = z.string().trim().max(300).regex(/^[^\s]*$/, 'paths have no spaces');
const attrKey = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'names are letters, digits and _, starting with a letter');
const fieldPath = z.object({ key: attrKey, path: path.min(1) });

export const mappingSchema: z.ZodType<InboundMapping, z.ZodTypeDef, unknown> = z.object({
  records: path.optional(),
  contact: z.object(Object.fromEntries(MAPPABLE_CONTACT_FIELDS.map((f) => [f, path.optional()]))).default({}),
  attributes: z.array(fieldPath).max(50).default([]),
  consent: z.array(z.object({ channel: z.enum(['email', 'sms']), purpose: z.enum(['care', 'marketing']), path: path.min(1) })).max(4).default([]),
  event: z.object({
    name: z.string().trim().min(1).max(200),
    properties: z.array(fieldPath).max(50).default([]),
    time: path.optional(),
    idempotency_key: path.optional(),
  }).nullable().optional(),
}).refine((m) => m.contact.external_id || m.contact.email, { message: 'Map an external ID or an email so contacts can be matched', path: ['contact'] }) as never;

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  auth: z.enum(['token', 'hmac']).default('token'),
  mapping: mappingSchema,
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  auth: z.enum(['token', 'hmac']).optional(),
  mapping: mappingSchema.optional(),
  enabled: z.boolean().optional(),
});

const SIGNATURE_TOLERANCE_S = 300;
const DAY_MS = 86_400_000;

export function createIntegrationsService({ db, config, ingest, clock }: { db: Kysely<Database>; config: Config; ingest: IngestService; clock: () => Date }) {
  const newSecret = () => `pe_hook_${randomBytes(24).toString('base64url')}`;
  const publicColumns = ['id', 'kind', 'name', 'config', 'enabled', 'created_at', 'updated_at', 'last_seen_at'] as const;
  const url = (id: string) => `${config.PE_PUBLIC_URL.replace(/\/$/, '')}/hooks/in/${id}`;
  const withUrl = <T extends { id: string }>(row: T) => ({ ...row, url: url(row.id) });

  async function getRow(id: string) {
    if (!z.string().uuid().safeParse(id).success) throw notFound('Integration');
    const row = await db.selectFrom('integrations').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound('Integration');
    return row;
  }

  async function run(id: string, payload: unknown, actor: Actor, source: string) {
    const row = await getRow(id);
    const { request, problems } = applyMapping(payload, row.config.mapping);
    if (!request.attributes.length && !request.events.length) throw badRequest(problems[0] ?? 'Nothing in this payload matched the mapping', problems);
    const { status, result } = await ingest.track(request, { source, actor });
    return { status: (problems.length ? 207 : status) as 201 | 207, result: { ...result, skipped: problems } };
  }

  return {
    url,

    async list() {
      const rows = await db.selectFrom('integrations').select(publicColumns).orderBy('created_at', 'desc').execute();
      return rows.map(withUrl);
    },

    async get(id: string) {
      const { secret_encrypted: _s, created_by: _c, ...row } = await getRow(id);
      return withUrl(row);
    },

    async create(input: unknown, actor: Actor) {
      const data = createSchema.parse(input);
      const secret = newSecret();
      const cfg: InboundWebhookConfig = { mapping: data.mapping, auth: data.auth };
      const row = await db.insertInto('integrations').values({
        kind: 'inbound_webhook', name: data.name, config: JSON.stringify(cfg), secret_encrypted: encrypt(config.secretKey, secret),
        created_by: actor.type === 'user' ? actor.id : null, created_at: clock(), updated_at: clock(),
      }).returning(publicColumns).executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'integration.create', entityType: 'integration', entityId: row.id, details: { kind: row.kind, auth: data.auth } });
      return { ...withUrl(row), secret };
    },

    async update(id: string, input: unknown, actor: Actor) {
      const current = await getRow(id);
      const data = updateSchema.parse(input);
      const cfg: InboundWebhookConfig = { mapping: data.mapping ?? current.config.mapping, auth: data.auth ?? current.config.auth };
      const row = await db.updateTable('integrations').set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
        config: JSON.stringify(cfg), updated_at: clock(),
      }).where('id', '=', id).returning(publicColumns).executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'integration.update', entityType: 'integration', entityId: id, details: { fields: Object.keys(data) } });
      return withUrl(row);
    },

    async remove(id: string, actor: Actor) {
      await getRow(id);
      await db.deleteFrom('integrations').where('id', '=', id).execute();
      await audit(db, actor, { action: 'integration.delete', entityType: 'integration', entityId: id });
    },

    async rotateSecret(id: string, actor: Actor) {
      await getRow(id);
      const secret = newSecret();
      await db.updateTable('integrations').set({ secret_encrypted: encrypt(config.secretKey, secret), updated_at: clock() }).where('id', '=', id).execute();
      await audit(db, actor, { action: 'integration.rotate_secret', entityType: 'integration', entityId: id });
      return { secret };
    },

    /**
     * Authenticates an inbound delivery: a bearer token (`Authorization: Bearer`, `X-PE-Token` or `?token=` for
     * tools that can only set a URL) or, for `hmac` sources, `X-PE-Signature: t=<unix>,v1=<hex>` over "{t}.{raw body}".
     */
    async authenticate(id: string, req: { headers: Record<string, string | string[] | undefined>; rawBody: string; queryToken?: string | undefined }) {
      const row = await getRow(id).catch(() => null);
      if (!row || !row.enabled) throw new HttpError(404, 'Not found');
      const secret = decrypt(config.secretKey, row.secret_encrypted);
      const header = (name: string) => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; };
      if (row.config.auth === 'hmac') {
        const sig = header('x-pe-signature') ?? '';
        const parts = Object.fromEntries(sig.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
        const t = Number(parts.t);
        const fresh = Number.isFinite(t) && Math.abs(clock().getTime() / 1000 - t) <= SIGNATURE_TOLERANCE_S;
        const expected = createHmac('sha256', secret).update(`${parts.t}.${req.rawBody}`).digest('hex');
        if (!fresh || !parts.v1 || !safeEqual(parts.v1, expected)) throw new HttpError(401, 'Invalid or expired signature');
      } else {
        const auth = header('authorization') ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : header('x-pe-token') ?? req.queryToken ?? '';
        if (!token || !safeEqual(token, secret)) throw new HttpError(401, 'Invalid or missing token');
      }
      if (!row.last_seen_at || clock().getTime() - row.last_seen_at.getTime() > 60_000) {
        await db.updateTable('integrations').set({ last_seen_at: clock() }).where('id', '=', id).execute();
      }
      return { id: row.id, name: row.name };
    },

    /** A real delivery from the connected app. */
    receive(id: string, payload: unknown) {
      return run(id, payload, { type: 'integration', id }, `hook:${id}`);
    },

    /** "Send test" in the console: the same pipeline, attributed to the admin who pressed it. */
    async test(id: string, payload: unknown, actor: Actor) {
      const res = await run(id, payload, actor, `hook:${id}`);
      await audit(db, actor, { action: 'integration.test', entityType: 'integration', entityId: id, details: { attributes: res.result.attributes_processed, events: res.result.events_processed } });
      return res;
    },

    // ---------- request log (metadata only: never payloads, contact values or keys) ----------

    async log(entry: { apiKeyId?: string | null; oauthGrantId?: string | null; integrationId?: string | null; method: string; route: string; status: number; durationMs: number; items?: number | null; error?: string | null }) {
      await db.insertInto('integration_requests').values({
        at: clock(), api_key_id: entry.apiKeyId ?? null, oauth_grant_id: entry.oauthGrantId ?? null, integration_id: entry.integrationId ?? null, method: entry.method,
        route: entry.route.slice(0, 200), status: entry.status, duration_ms: Math.round(entry.durationMs), items: entry.items ?? null, error: entry.error?.slice(0, 300) ?? null,
      }).execute();
    },

    async requests(filter: { apiKeyId?: string | undefined; integrationId?: string | undefined; oauthGrantId?: string | undefined; limit?: number }) {
      let q = db.selectFrom('integration_requests')
        .leftJoin('api_keys', 'api_keys.id', 'integration_requests.api_key_id')
        .leftJoin('integrations', 'integrations.id', 'integration_requests.integration_id')
        .leftJoin('oauth_grants', 'oauth_grants.id', 'integration_requests.oauth_grant_id')
        .leftJoin('oauth_clients', 'oauth_clients.id', 'oauth_grants.client_id')
        .selectAll('integration_requests').select(['api_keys.name as api_key_name', 'integrations.name as integration_name', 'oauth_clients.name as oauth_client_name'])
        .orderBy('integration_requests.at', 'desc').orderBy('integration_requests.id', 'desc').limit(Math.min(Math.max(filter.limit ?? 50, 1), 200));
      if (filter.apiKeyId) q = q.where('integration_requests.api_key_id', '=', filter.apiKeyId);
      if (filter.integrationId) q = q.where('integration_requests.integration_id', '=', filter.integrationId);
      if (filter.oauthGrantId) q = q.where('integration_requests.oauth_grant_id', '=', filter.oauthGrantId);
      return q.execute();
    },

    /** Counts for the Integrations overview: last 24 hours, plus hourly volume for sparklines. */
    async overview() {
      const since = new Date(clock().getTime() - DAY_MS);
      const [keys, hooks, outbound, totals, hourly, perSource] = await Promise.all([
        db.selectFrom('api_keys').select((eb) => eb.fn.countAll<string>().as('n')).where('revoked_at', 'is', null)
          .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', clock())])).executeTakeFirstOrThrow(),
        db.selectFrom('integrations').select([sql<string>`count(*)`.as('n'), sql<string>`count(*) filter (where enabled)`.as('enabled')]).where('kind', '=', 'inbound_webhook').executeTakeFirstOrThrow(),
        db.selectFrom('webhooks').select([sql<string>`count(*)`.as('n'), sql<string>`count(*) filter (where enabled)`.as('enabled')]).executeTakeFirstOrThrow(),
        db.selectFrom('integration_requests').select([sql<string>`count(*)`.as('n'), sql<string>`count(*) filter (where status >= 400)`.as('errors')]).where('at', '>=', since).executeTakeFirstOrThrow(),
        db.selectFrom('integration_requests').select([sql<string>`date_trunc('hour', at)`.as('hour'), sql<string>`count(*)`.as('n')]).where('at', '>=', since).groupBy(sql`1`).orderBy(sql`1`).execute(),
        db.selectFrom('integration_requests').select(['api_key_id', 'integration_id', sql<string>`count(*)`.as('n'), sql<string>`count(*) filter (where status >= 400)`.as('errors'), sql<Date>`max(at)`.as('last_at')])
          .where('at', '>=', since).groupBy(['api_key_id', 'integration_id']).execute(),
      ]);
      const buckets = Array.from({ length: 24 }, (_, i) => {
        const h = new Date(Math.floor((clock().getTime() - (23 - i) * 3_600_000) / 3_600_000) * 3_600_000).getTime();
        return Number(hourly.find((r) => new Date(r.hour).getTime() === h)?.n ?? 0);
      });
      return {
        api_keys: Number(keys.n),
        inbound_webhooks: { total: Number(hooks.n), enabled: Number(hooks.enabled) },
        outbound_webhooks: { total: Number(outbound.n), enabled: Number(outbound.enabled) },
        requests_24h: Number(totals.n), errors_24h: Number(totals.errors), hourly: buckets,
        by_source: perSource.map((r) => ({ api_key_id: r.api_key_id, integration_id: r.integration_id, requests: Number(r.n), errors: Number(r.errors), last_at: r.last_at })),
      };
    },
  };
}

export type IntegrationsService = ReturnType<typeof createIntegrationsService>;
