// Two-way Salesforce CRM connector (ADR-0009).
// - Connect: OAuth 2.0 web-server flow with PKCE against the customer's own Connected App. State and verifier are
//   kept server-side, bound to the admin's session, single use and valid for 10 minutes.
// - Pull: Contacts (and optionally Leads) changed since a per-object SystemModstamp cursor, mapped and written
//   through contacts.upsert, so contact resolution, consent history and audit work as for every other source.
// - Push: a pump turns message activity and email opt-outs of synced contacts into salesforce_outbox rows; a
//   delivery step writes them as Tasks (or HasOptedOutOfEmail updates) with the webhook backoff.
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { normalizeConsentValue } from '@pure-engage/shared';
import type { Config } from '../../config.ts';
import type {
  Database, SalesforceActivity, SalesforceConnection, SalesforceLastRun, SalesforceObject, SalesforceObjectSettings, SalesforceOutboxItem,
  SalesforcePullCounts, SalesforceSettings,
} from '../../db/schema.ts';
import { HttpError, badRequest, conflict, notFound } from '../../errors.ts';
import { audit, type Actor } from '../audit.ts';
import type { ContactsService } from '../contacts.ts';
import { decrypt, encrypt, randomToken, sha256 } from '../crypto.ts';
import type { IntegrationsService } from '../integrations.ts';
import { UnsafeUrlError } from '../net.ts';
import { BACKOFF_MS } from '../webhooks.ts';
import {
  SF_COMPOSITE_LIMIT, SF_SCOPES, SalesforceError, checkSalesforceUrl, createSalesforceClient, requestToken, revokeToken, scrub, userInfo,
  type SObjectRecord, type SaveResult,
} from './client.ts';

export const SF_OBJECTS: SalesforceObject[] = ['Contact', 'Lead'];
export const SF_ACTIVITIES: SalesforceActivity[] = ['sent', 'open', 'click', 'unsubscribe'];
export const MAX_SALESFORCE_ATTEMPTS = BACKOFF_MS.length + 1;
const STATE_TTL_MS = 10 * 60_000;
const PULL_LEASE_MS = 15 * 60_000;
const PUSH_LEASE_MS = 5 * 60_000;
const PUMP_BATCH = 500;
/** Fields every pull reads, whatever the mapping. */
const STANDARD_FIELDS = ['Id', 'SystemModstamp', 'Email', 'FirstName', 'LastName', 'MobilePhone', 'Phone', 'HasOptedOutOfEmail', 'DoNotCall'];
const RESERVED_ATTRIBUTES = new Set(['salesforce_id', 'salesforce_object', 'external_id', 'email', 'phone', 'first_name', 'last_name', 'preferred_language', 'timezone', 'consent', 'contact_id', 'id', 'created_at', 'updated_at']);
const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SF_ID = /^[A-Za-z0-9]{15,18}$/;

const sfField = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/, 'Salesforce field names are letters, digits and _');
const attrKey = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'names are letters, digits and _, starting with a letter')
  .refine((k) => !RESERVED_ATTRIBUTES.has(k), 'this name is reserved');

const objectSettingsSchema = z.object({
  enabled: z.boolean(),
  external_id_field: sfField.default('Id'),
  fields: z.array(z.object({ field: sfField, attribute: attrKey })).max(50).default([]),
  consent: z.array(z.object({ field: sfField, channel: z.enum(['email', 'sms']), purpose: z.enum(['care', 'marketing']), unchecked_denies: z.boolean().default(false) })).max(8).default([]),
});

const settingsSchema = z.object({
  objects: z.object({ Contact: objectSettingsSchema, Lead: objectSettingsSchema }),
  do_not_call_denies_sms: z.boolean(),
  write_back: z.object({ activities: z.array(z.enum(['sent', 'open', 'click', 'unsubscribe'])).max(4), email_opt_out: z.boolean() }),
  sync_minutes: z.number().int().min(5).max(1440),
});

export const defaultSettings = (): SalesforceSettings => ({
  objects: {
    Contact: { enabled: true, external_id_field: 'Id', fields: [], consent: [] },
    Lead: { enabled: false, external_id_field: 'Id', fields: [], consent: [] },
  },
  do_not_call_denies_sms: true,
  write_back: { activities: [...SF_ACTIVITIES], email_opt_out: true },
  sync_minutes: 15,
});

function readSettings(raw: unknown): SalesforceSettings {
  const d = defaultSettings();
  const r = (raw ?? {}) as Partial<SalesforceSettings>;
  const parsed = settingsSchema.safeParse({
    ...d, ...r, objects: { Contact: { ...d.objects.Contact, ...r.objects?.Contact }, Lead: { ...d.objects.Lead, ...r.objects?.Lead } },
    write_back: { ...d.write_back, ...r.write_back },
  });
  return parsed.success ? (parsed.data as SalesforceSettings) : d;
}

const configSchema = z.object({
  login_host: z.string().trim().min(1).max(300),
  consumer_key: z.string().trim().min(10).max(256).regex(/^[\x21-\x7e]+$/, 'The consumer key has no spaces'),
  consumer_secret: z.string().trim().min(8).max(256).regex(/^[\x21-\x7e]+$/, 'The consumer secret has no spaces').optional(),
});

const zero = (): SalesforcePullCounts => ({ created: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0, warnings: 0 });

/** SOQL datetime literal (seconds precision; the cursor is inclusive, so flooring never skips a record). */
const soqlDate = (value: string) => {
  const d = new Date(String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

const errorText = (err: unknown) => (err instanceof SalesforceError || err instanceof HttpError ? err.message : scrub((err as Error).message ?? 'Unknown error'));
const errorStatus = (err: unknown) => (err instanceof SalesforceError && err.status ? err.status : err instanceof HttpError ? err.statusCode : 502);

type Conn = SalesforceConnection & { name: string; enabled: boolean; secret_encrypted: string };

export interface SalesforceDeps {
  db: Kysely<Database>;
  config: Config;
  contacts: ContactsService;
  integrations: IntegrationsService;
  clock: () => Date;
  log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function createSalesforceService({ db, config, contacts, integrations, clock, log = () => {}, sleep }: SalesforceDeps) {
  const allowAnyHost = config.PE_SALESFORCE_ALLOW_ANY_HOST;
  const callbackUrl = `${config.PE_PUBLIC_URL.replace(/\/$/, '')}/oauth/salesforce/callback`;
  const consoleReturn = `${config.consoleUrl}/integrations/salesforce`;
  const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: config.PE_DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

  const connQuery = () => db.selectFrom('salesforce_connections')
    .innerJoin('integrations', 'integrations.id', 'salesforce_connections.integration_id')
    .selectAll('salesforce_connections').select(['integrations.name', 'integrations.enabled', 'integrations.secret_encrypted'])
    .where('integrations.kind', '=', 'salesforce');

  /** The connection (one per installation). */
  const current = (): Promise<Conn | undefined> => connQuery().orderBy('salesforce_connections.created_at').limit(1).executeTakeFirst();
  const byId = (id: string): Promise<Conn | undefined> => connQuery().where('salesforce_connections.integration_id', '=', id).executeTakeFirst();

  async function requireConn(): Promise<Conn> {
    const c = await current();
    if (!c) throw notFound('Salesforce connection');
    return c;
  }

  const requestLog = (integrationId: string, method: string, route: string, status: number, startedAt: number, items: number | null, error: string | null) =>
    integrations.log({ integrationId, method, route, status, durationMs: Date.now() - startedAt, items, error }).catch((err) => log('warn', 'could not write salesforce request log', { error: (err as Error).message }));

  async function outboxCounts(integrationId: string) {
    const rows = await db.selectFrom('salesforce_outbox').select(['status', sql<string>`count(*)`.as('n')]).where('integration_id', '=', integrationId).groupBy('status').execute();
    const n = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
    return { pending: n('pending'), sent: n('sent'), failed: n('failed') };
  }

  /** Everything the console may see: never the consumer secret or tokens. */
  async function view(c: Conn) {
    return {
      id: c.integration_id, name: c.name, status: c.status, login_host: c.login_host, consumer_key: c.consumer_key, has_consumer_secret: !!c.secret_encrypted,
      connected: !!c.refresh_token_encrypted, instance_url: c.instance_url, org_id: c.org_id, username: c.username, connected_at: c.connected_at,
      settings: readSettings(c.settings), last_run: c.last_run, last_error: c.last_error, last_sync_at: c.last_sync_at, next_sync_at: c.next_sync_at,
      outbox: await outboxCounts(c.integration_id),
    };
  }

  async function markBroken(c: Conn, message: string) {
    await db.updateTable('salesforce_connections').set({
      status: 'error', last_error: message, refresh_token_encrypted: null, access_token_encrypted: null, lease_until: null, updated_at: clock(),
    }).where('integration_id', '=', c.integration_id).execute();
  }

  /** REST client for a connection. The access token is cached encrypted; a refresh stores the new one. */
  function clientFor(c: Conn) {
    if (!c.refresh_token_encrypted || !c.instance_url) throw new SalesforceError(0, 'NOT_CONNECTED', 'Salesforce is not connected');
    let access = c.access_token_encrypted ? decrypt(config.secretKey, c.access_token_encrypted) : null;
    let instanceUrl = c.instance_url;
    const refresh = async () => {
      const started = Date.now();
      let tok;
      try {
        tok = await requestToken(c.login_host, {
          grant_type: 'refresh_token', refresh_token: decrypt(config.secretKey, c.refresh_token_encrypted!),
          client_id: c.consumer_key, client_secret: decrypt(config.secretKey, c.secret_encrypted),
        }, allowAnyHost);
      } catch (err) {
        await requestLog(c.integration_id, 'POST', 'salesforce oauth refresh', errorStatus(err), started, null, errorText(err));
        if (err instanceof SalesforceError && (err.code === 'invalid_grant' || err.code === 'invalid_client')) {
          await markBroken(c, 'Salesforce no longer accepts the saved sign-in. Connect again.');
        }
        throw err;
      }
      await requestLog(c.integration_id, 'POST', 'salesforce oauth refresh', 200, started, null, null);
      access = tok.access_token;
      try { instanceUrl = checkSalesforceUrl(tok.instance_url, allowAnyHost); } catch { /* keep the instance we know */ }
      await db.updateTable('salesforce_connections').set({
        access_token_encrypted: encrypt(config.secretKey, access), instance_url: instanceUrl, updated_at: clock(),
        ...(tok.refresh_token ? { refresh_token_encrypted: encrypt(config.secretKey, tok.refresh_token) } : {}),
      }).where('integration_id', '=', c.integration_id).execute();
      return access;
    };
    return createSalesforceClient({ instanceUrl, allowAnyHost, getAccessToken: async () => access ?? refresh(), refreshAccessToken: refresh, ...(sleep ? { sleep } : {}) });
  }

  // ---------- pull ----------

  function selectFields(s: SalesforceObjectSettings) {
    return [...new Set([...STANDARD_FIELDS, s.external_id_field, ...s.fields.map((f) => f.field), ...s.consent.map((f) => f.field)])];
  }

  /** One Salesforce record → a contacts.upsert input (or null to skip). */
  function mapRecord(object: SalesforceObject, rec: SObjectRecord, settings: SalesforceSettings, counts: SalesforcePullCounts): Record<string, unknown> | null {
    const os = settings.objects[object];
    const ext = rec[os.external_id_field];
    if (typeof rec.Id !== 'string' || ext === null || ext === undefined || String(ext).trim() === '') { counts.skipped++; return null; }
    const input: Record<string, unknown> = { external_id: String(ext).trim().slice(0, 200), salesforce_id: rec.Id, salesforce_object: object };

    // Empty Salesforce values never clear what Pure Engage already knows.
    if (typeof rec.Email === 'string' && rec.Email.trim()) {
      if (EMAIL.test(rec.Email.trim()) && rec.Email.trim().length <= 320) input.email = rec.Email.trim().toLowerCase();
      else counts.warnings++;
    }
    for (const [from, to] of [['FirstName', 'first_name'], ['LastName', 'last_name']] as const) {
      if (typeof rec[from] === 'string' && (rec[from] as string).trim()) input[to] = (rec[from] as string).trim().slice(0, 200);
    }
    const phones = [rec.MobilePhone, rec.Phone].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
    const phone = phones.map((p) => p.replace(/[\s().-]/g, '')).find((p) => E164.test(p));
    if (phone) input.phone = phone;
    else if (phones.length) counts.warnings++;

    for (const { field, attribute } of os.fields) {
      const v = rec[field];
      if (v === undefined) continue;
      input[attribute] = v === null || typeof v !== 'object' ? v : JSON.stringify(v);
    }

    // House rule: only an explicit yes grants. A denial always wins over a grant from another field.
    const consent: Record<string, Record<string, 'granted' | 'denied'>> = {};
    const set = (channel: string, purpose: string, status: 'granted' | 'denied') => {
      const cur = consent[channel]?.[purpose];
      if (cur === 'denied') return;
      (consent[channel] ??= {})[purpose] = status;
    };
    if (rec.HasOptedOutOfEmail === true) set('email', 'marketing', 'denied');
    if (settings.do_not_call_denies_sms && rec.DoNotCall === true) set('sms', 'marketing', 'denied');
    for (const c of os.consent) {
      const v = rec[c.field];
      if (typeof v === 'boolean') {
        if (v) set(c.channel, c.purpose, 'granted');
        else if (c.unchecked_denies) set(c.channel, c.purpose, 'denied');
      } else {
        const n = normalizeConsentValue(v);
        if (n) set(c.channel, c.purpose, n);
      }
    }
    if (Object.keys(consent).length) input.consent = consent;
    return input;
  }

  async function pullObject(c: Conn, client: ReturnType<typeof clientFor>, object: SalesforceObject, settings: SalesforceSettings, cursors: Partial<Record<SalesforceObject, string>>) {
    const counts = zero();
    const started = Date.now();
    const source = `salesforce:${c.integration_id}`;
    const actor: Actor = { type: 'integration', id: source };
    let error: string | null = null;
    let status = 200;
    try {
      const cursor = cursors[object];
      const soql = `SELECT ${selectFields(settings.objects[object]).join(', ')} FROM ${object}${cursor ? ` WHERE SystemModstamp >= ${cursor}` : ''} ORDER BY SystemModstamp ASC, Id ASC`;
      for await (const page of client.queryPages(soql)) {
        for (const rec of page) {
          const input = mapRecord(object, rec, settings, counts);
          if (!input) continue;
          const before = Date.now();
          try {
            const { contact, created } = await contacts.upsert(input, { source, actor });
            if (created) counts.created++;
            else if (contact.updated_at.getTime() >= before) counts.updated++;
            else counts.unchanged++;
          } catch (err) {
            counts.errors++;
            error = `${object} ${rec.Id}: ${errorText(err)}`;
          }
        }
        const last = page.at(-1)?.SystemModstamp;
        const next = typeof last === 'string' ? soqlDate(last) : null;
        if (next) {
          cursors[object] = next;
          await db.updateTable('salesforce_connections').set({ pull_state: JSON.stringify({ cursors }), updated_at: clock() }).where('integration_id', '=', c.integration_id).execute();
        }
      }
    } catch (err) {
      error = errorText(err);
      status = errorStatus(err);
      throw Object.assign(new SalesforceError(status, err instanceof SalesforceError ? err.code : 'PULL_FAILED', error), { counts });
    } finally {
      await requestLog(c.integration_id, 'SYNC', `salesforce pull ${object}`, status, started, counts.created + counts.updated + counts.unchanged, error);
    }
    return { counts, recordError: error };
  }

  async function pull(c: Conn): Promise<SalesforceLastRun> {
    const settings = readSettings(c.settings);
    const started = Date.now();
    const cursors = { ...(c.pull_state?.cursors ?? {}) };
    const run: SalesforceLastRun = { at: clock().toISOString(), duration_ms: 0, objects: {}, error: null };
    // A whole object (or the sign-in) failing marks the connection as in error; a few bad records don't.
    let fatal = false;
    try {
      const client = clientFor(c);
      for (const object of SF_OBJECTS.filter((o) => settings.objects[o].enabled)) {
        try {
          const { counts, recordError } = await pullObject(c, client, object, settings, cursors);
          run.objects[object] = counts;
          if (recordError) run.error ??= recordError;
        } catch (err) {
          run.objects[object] = (err as { counts?: SalesforcePullCounts }).counts ?? zero();
          run.error = errorText(err);
          fatal = true;
          // Auth problems stop the run; other errors only this object.
          if (err instanceof SalesforceError && (err.status === 401 || err.code === 'invalid_grant')) break;
        }
      }
    } catch (err) {
      run.error = errorText(err);
      fatal = true;
    }
    run.duration_ms = Date.now() - started;
    const fresh = await byId(c.integration_id);
    await db.updateTable('salesforce_connections').set({
      last_run: JSON.stringify(run), last_sync_at: clock(), lease_until: null, updated_at: clock(),
      next_sync_at: new Date(clock().getTime() + settings.sync_minutes * 60_000),
      // When the sign-in was refused, markBroken already set the status and the message to show.
      ...(fresh?.refresh_token_encrypted ? { status: fatal ? 'error' : 'connected', last_error: run.error } : {}),
    }).where('integration_id', '=', c.integration_id).execute();
    if (run.error) log('warn', 'salesforce pull finished with errors', { integration: c.integration_id, error: run.error });
    return run;
  }

  /** Claims connections whose sync is due (lease, SKIP LOCKED). The row is never held locked while Salesforce is called. */
  async function claimForPull(only?: string) {
    const now = clock();
    return db.updateTable('salesforce_connections').set({ lease_until: new Date(now.getTime() + PULL_LEASE_MS) })
      .where('integration_id', 'in', (eb) => {
        let q = eb.selectFrom('salesforce_connections').select('integration_id')
          .where('refresh_token_encrypted', 'is not', null)
          .where((w) => w.or([w('lease_until', 'is', null), w('lease_until', '<', now)]));
        q = only ? q.where('integration_id', '=', only) : q.where((w) => w.or([w('next_sync_at', 'is', null), w('next_sync_at', '<=', now)]));
        return q.forNoKeyUpdate().skipLocked();
      })
      .returning('integration_id').execute();
  }

  // ---------- push ----------

  const verb: Record<SalesforceActivity, string> = { sent: 'sent', open: 'opened', click: 'link clicked', unsubscribe: 'unsubscribed' };

  /** Moves the keyset cursors over message_events and consent_history, queueing work for synced contacts. */
  async function pump(c: Conn) {
    const settings = readSettings(c.settings);
    const [{ hiEvent }, { hiConsent }] = await Promise.all([
      db.selectFrom('message_events').select(sql<string | null>`max(id)`.as('hiEvent')).executeTakeFirstOrThrow(),
      db.selectFrom('consent_history').select(sql<string | null>`max(id)`.as('hiConsent')).executeTakeFirstOrThrow(),
    ]);
    if (c.push_event_cursor === null || c.push_consent_cursor === null) {
      // First run: start from now, never backfill history.
      await db.updateTable('salesforce_connections').set({ push_event_cursor: c.push_event_cursor ?? hiEvent ?? '0', push_consent_cursor: c.push_consent_cursor ?? hiConsent ?? '0' })
        .where('integration_id', '=', c.integration_id).execute();
      return 0;
    }
    let queued = 0;
    const enqueue = async (rows: { kind: 'task' | 'opt_out'; source_key: string; contact_id: string; sf_object: string; sf_id: string; payload: Record<string, unknown> }[]) => {
      if (!rows.length) return;
      const res = await db.insertInto('salesforce_outbox').values(rows.map((r) => ({
        ...r, integration_id: c.integration_id, payload: JSON.stringify(r.payload), next_attempt_at: clock(), created_at: clock(), updated_at: clock(),
      }))).onConflict((oc) => oc.columns(['integration_id', 'source_key']).doNothing()).returning('id').execute();
      queued += res.length;
    };
    const validTarget = (r: { sf_id: string | null; sf_object: string | null }) => !!r.sf_id && SF_ID.test(r.sf_id) && (r.sf_object === 'Contact' || r.sf_object === 'Lead');

    const events = await db.selectFrom('message_events as me')
      .innerJoin('messages as m', 'm.id', 'me.message_id')
      .innerJoin('contacts as ct', 'ct.id', 'm.contact_id')
      .leftJoin('templates as t', 't.id', 'm.template_id')
      .leftJoin('campaigns as cp', 'cp.id', 'm.campaign_id')
      .leftJoin('journeys as j', 'j.id', 'm.journey_id')
      .select(['me.id', 'me.type', 'me.at', 'm.channel', 'm.contact_id', 't.name as template_name', 'cp.name as campaign_name', 'j.name as journey_name',
        sql<string | null>`ct.attributes->>'salesforce_id'`.as('sf_id'), sql<string | null>`ct.attributes->>'salesforce_object'`.as('sf_object')])
      .where('me.id', '>', c.push_event_cursor).where('me.id', '<=', hiEvent ?? '0')
      .where('me.type', 'in', SF_ACTIVITIES)
      .where(sql<boolean>`ct.attributes ? 'salesforce_id'`)
      .orderBy('me.id').limit(PUMP_BATCH).execute();
    await enqueue(events.filter((e) => validTarget(e) && settings.write_back.activities.includes(e.type as SalesforceActivity)).map((e) => {
      const description = [e.campaign_name ? `Campaign: ${e.campaign_name}` : null, e.journey_name ? `Journey: ${e.journey_name}` : null, 'Logged by Pure Engage'].filter(Boolean).join('\n');
      return {
        kind: 'task' as const, source_key: `event:${e.id}`, contact_id: e.contact_id, sf_object: e.sf_object!, sf_id: e.sf_id!,
        payload: {
          WhoId: e.sf_id, Subject: `${e.channel === 'sms' ? 'SMS' : 'Email'} ${verb[e.type as SalesforceActivity]}: ${e.template_name ?? 'message'}`.slice(0, 255),
          Status: 'Completed', ActivityDate: dateFormat.format(e.at), Description: description.slice(0, 32_000),
        },
      };
    }));
    const eventCursor = events.length === PUMP_BATCH ? events.at(-1)!.id : (hiEvent ?? c.push_event_cursor);

    // Email opt-outs from any source except this connection (so Salesforce's own opt-outs don't echo back).
    const optOuts = await db.selectFrom('consent_history as h')
      .innerJoin('contacts as ct', 'ct.id', 'h.contact_id')
      .select(['h.id', 'h.contact_id', sql<string | null>`ct.attributes->>'salesforce_id'`.as('sf_id'), sql<string | null>`ct.attributes->>'salesforce_object'`.as('sf_object')])
      .where('h.id', '>', c.push_consent_cursor).where('h.id', '<=', hiConsent ?? '0')
      .where('h.channel', '=', 'email').where('h.purpose', '=', 'marketing').where('h.status', '=', 'denied')
      .where('h.source', '!=', `salesforce:${c.integration_id}`)
      .where(sql<boolean>`ct.attributes ? 'salesforce_id'`)
      .orderBy('h.id').limit(PUMP_BATCH).execute();
    if (settings.write_back.email_opt_out) {
      await enqueue(optOuts.filter(validTarget).map((h) => ({
        kind: 'opt_out' as const, source_key: `consent:${h.id}`, contact_id: h.contact_id, sf_object: h.sf_object!, sf_id: h.sf_id!, payload: { HasOptedOutOfEmail: true },
      })));
    }
    const consentCursor = optOuts.length === PUMP_BATCH ? optOuts.at(-1)!.id : (hiConsent ?? c.push_consent_cursor);
    await db.updateTable('salesforce_connections').set({ push_event_cursor: eventCursor, push_consent_cursor: consentCursor })
      .where('integration_id', '=', c.integration_id).execute();
    return queued;
  }

  async function settle(rows: SalesforceOutboxItem[], outcome: { ok: true; results: SaveResult[] } | { ok: false; error: string; permanent: boolean }) {
    const now = clock();
    for (const [i, row] of rows.entries()) {
      const attempts = row.attempts + 1;
      let error: string | null = null;
      let permanent = false;
      let recordId: string | null = null;
      if (outcome.ok) {
        const r = outcome.results[i];
        if (r?.success) recordId = r.id ?? null;
        else {
          const codes = (r?.errors ?? []).map((e) => e.statusCode ?? 'ERROR');
          error = scrub((r?.errors ?? []).map((e) => `${e.statusCode ?? 'ERROR'}: ${e.message ?? ''}`).join('; ') || 'No result from Salesforce');
          // A locked row is worth retrying; other record errors (deleted record, validation rule) need a person.
          permanent = !codes.includes('UNABLE_TO_LOCK_ROW');
        }
      } else ({ error, permanent } = outcome);
      const status = !error ? 'sent' : permanent || attempts >= MAX_SALESFORCE_ATTEMPTS ? 'failed' : 'pending';
      await db.updateTable('salesforce_outbox').set({
        status, attempts, error, updated_at: now, ...(recordId ? { sf_record_id: recordId } : {}),
        next_attempt_at: status === 'pending' ? new Date(now.getTime() + BACKOFF_MS[attempts - 1]!) : null,
      }).where('id', '=', row.id).execute();
    }
  }

  async function deliverBatch(c: Conn | undefined, kind: 'task' | 'opt_out', rows: SalesforceOutboxItem[]) {
    if (!c || !c.refresh_token_encrypted) return settle(rows, { ok: false, error: 'Salesforce is not connected', permanent: false });
    let client;
    try { client = clientFor(c); } catch (err) { return settle(rows, { ok: false, error: errorText(err), permanent: false }); }
    for (let i = 0; i < rows.length; i += SF_COMPOSITE_LIMIT) {
      const chunk = rows.slice(i, i + SF_COMPOSITE_LIMIT);
      const records: SObjectRecord[] = chunk.map((r) => kind === 'task'
        ? { attributes: { type: 'Task' }, ...r.payload }
        : { attributes: { type: r.sf_object }, Id: r.sf_id, ...r.payload });
      const started = Date.now();
      const route = kind === 'task' ? 'salesforce push Task' : 'salesforce push opt-out';
      try {
        const results = kind === 'task' ? await client.createRecords(records) : await client.updateRecords(records);
        const failed = results.filter((r) => !r.success).length;
        await requestLog(c.integration_id, kind === 'task' ? 'POST' : 'PATCH', route, 200, started, chunk.length, failed ? `${failed} of ${chunk.length} records failed` : null);
        await settle(chunk, { ok: true, results });
      } catch (err) {
        await requestLog(c.integration_id, kind === 'task' ? 'POST' : 'PATCH', route, errorStatus(err), started, chunk.length, errorText(err));
        const permanent = err instanceof SalesforceError && err.code === 'BLOCKED';
        await settle(chunk, { ok: false, error: errorText(err), permanent });
      }
    }
  }

  /** Delivery step: claims due outbox rows (SKIP LOCKED plus a lease) and writes them in batches of 200. */
  async function deliverDue(limit = 1000) {
    const now = clock();
    const claimed = await db.updateTable('salesforce_outbox').set({ next_attempt_at: new Date(now.getTime() + PUSH_LEASE_MS), updated_at: now })
      .where('id', 'in', (eb) => eb.selectFrom('salesforce_outbox').select('id').where('status', '=', 'pending').where('next_attempt_at', '<=', now)
        .orderBy('next_attempt_at').orderBy('created_at').limit(limit).forUpdate().skipLocked())
      .returningAll().execute();
    const groups = new Map<string, SalesforceOutboxItem[]>();
    for (const row of claimed.sort((a, b) => a.created_at.getTime() - b.created_at.getTime())) {
      const key = `${row.integration_id}|${row.kind}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const [key, rows] of groups) {
      const [integrationId, kind] = key.split('|') as [string, 'task' | 'opt_out'];
      await deliverBatch(await byId(integrationId), kind, rows);
    }
    return claimed.length;
  }

  async function pushAll() {
    const conns = await connQuery().where('salesforce_connections.refresh_token_encrypted', 'is not', null).where('integrations.enabled', '=', true).execute();
    let queued = 0;
    for (const c of conns) {
      try { queued += await pump(c); } catch (err) { log('error', 'salesforce pump failed', { integration: c.integration_id, error: errorText(err) }); }
    }
    return { queued, delivered: await deliverDue() };
  }

  return {
    callbackUrl,
    scopes: SF_SCOPES,

    async get() {
      const c = await current();
      return { connection: c ? await view(c) : null, callback_url: callbackUrl, scopes: SF_SCOPES };
    },

    /** For the Integrations catalog card. */
    async summary(): Promise<{ status: 'not_set_up' | 'not_connected' | 'connected' | 'error' }> {
      const c = await current();
      return { status: !c ? 'not_set_up' : c.status };
    },

    /** Saves the Connected App settings. The consumer secret is required the first time and stored encrypted. */
    async saveConfig(input: unknown, actor: Actor) {
      const data = configSchema.parse(input);
      let loginHost: string;
      try { loginHost = checkSalesforceUrl(data.login_host, allowAnyHost); } catch (err) {
        throw badRequest((err as Error).message, [{ path: 'login_host', message: (err as Error).message }]);
      }
      const existing = await current();
      const now = clock();
      if (!existing) {
        if (!data.consumer_secret) throw badRequest('Enter the consumer secret', [{ path: 'consumer_secret', message: 'Required' }]);
        await db.transaction().execute(async (tx) => {
          const row = await tx.insertInto('integrations').values({
            kind: 'salesforce', name: 'Salesforce', config: '{}', secret_encrypted: encrypt(config.secretKey, data.consumer_secret!),
            created_by: actor.type === 'user' ? actor.id : null, created_at: now, updated_at: now,
          }).returning('id').executeTakeFirstOrThrow();
          await tx.insertInto('salesforce_connections').values({
            integration_id: row.id, login_host: loginHost, consumer_key: data.consumer_key, settings: JSON.stringify(defaultSettings()), created_at: now, updated_at: now,
          }).execute();
          await audit(tx, actor, { action: 'salesforce.configure', entityType: 'integration', entityId: row.id, details: { fields: Object.keys(data) } });
        });
      } else {
        // A different org or Connected App: the saved sign-in belongs to the old one.
        const reset = existing.login_host !== loginHost || existing.consumer_key !== data.consumer_key;
        await db.transaction().execute(async (tx) => {
          if (data.consumer_secret) await tx.updateTable('integrations').set({ secret_encrypted: encrypt(config.secretKey, data.consumer_secret), updated_at: now }).where('id', '=', existing.integration_id).execute();
          await tx.updateTable('salesforce_connections').set({
            login_host: loginHost, consumer_key: data.consumer_key, updated_at: now,
            ...(reset ? { refresh_token_encrypted: null, access_token_encrypted: null, status: 'not_connected', instance_url: null, org_id: null, sf_user_id: null, username: null, connected_at: null } : {}),
          }).where('integration_id', '=', existing.integration_id).execute();
          await audit(tx, actor, { action: 'salesforce.configure', entityType: 'integration', entityId: existing.integration_id, details: { fields: Object.keys(data), reset } });
        });
      }
      return this.get();
    },

    /** Starts the OAuth web-server flow: state and PKCE verifier stay here, bound to the admin's session for 10 minutes. */
    async startConnect(user: { id: string }, sessionToken: string) {
      const c = await current();
      if (!c) throw badRequest('Save the Connected App settings first');
      const now = clock();
      const state = randomToken(32);
      const verifier = randomToken(48);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      await db.deleteFrom('salesforce_oauth_states').where('expires_at', '<', now).execute();
      await db.insertInto('salesforce_oauth_states').values({
        state_hash: sha256(state), integration_id: c.integration_id, user_id: user.id, session_hash: sha256(sessionToken),
        verifier_encrypted: encrypt(config.secretKey, verifier), expires_at: new Date(now.getTime() + STATE_TTL_MS), created_at: now,
      }).execute();
      const params = new URLSearchParams({
        response_type: 'code', client_id: c.consumer_key, redirect_uri: callbackUrl, scope: SF_SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256',
      });
      return { authorize_url: `${c.login_host}/services/oauth2/authorize?${params}` };
    },

    /**
     * The callback: checks state, session and expiry, exchanges the code (with the PKCE verifier) and stores the
     * encrypted refresh token. Returns where to send the browser in the console.
     */
    async completeConnect(query: { code?: string | undefined; state?: string | undefined; error?: string | undefined }, session: { token: string; userId: string } | null): Promise<string> {
      const back = (error?: string) => `${consoleReturn}?${error ? `error=${error}` : 'connected=1'}`;
      if (!query.state) return back('invalid_state');
      const pending = await db.deleteFrom('salesforce_oauth_states').where('state_hash', '=', sha256(query.state)).returningAll().executeTakeFirst();
      if (!pending || pending.expires_at.getTime() < clock().getTime()) return back('invalid_state');
      if (!session || session.userId !== pending.user_id || sha256(session.token) !== pending.session_hash) return back('session');
      if (query.error) return back('denied');
      if (!query.code) return back('invalid_state');
      const c = await byId(pending.integration_id);
      if (!c) return back('not_configured');

      const started = Date.now();
      let tok;
      try {
        tok = await requestToken(c.login_host, {
          grant_type: 'authorization_code', code: query.code, client_id: c.consumer_key, client_secret: decrypt(config.secretKey, c.secret_encrypted),
          redirect_uri: callbackUrl, code_verifier: decrypt(config.secretKey, pending.verifier_encrypted),
        }, allowAnyHost);
      } catch (err) {
        await requestLog(c.integration_id, 'POST', 'salesforce oauth token', errorStatus(err), started, null, errorText(err));
        await db.updateTable('salesforce_connections').set({ last_error: errorText(err), updated_at: clock() }).where('integration_id', '=', c.integration_id).execute();
        return back('token');
      }
      await requestLog(c.integration_id, 'POST', 'salesforce oauth token', 200, started, null, null);
      let instanceUrl: string;
      try { instanceUrl = checkSalesforceUrl(tok.instance_url, allowAnyHost); } catch (err) {
        await db.updateTable('salesforce_connections').set({ last_error: `Refused instance URL: ${(err as UnsafeUrlError).message}`, updated_at: clock() }).where('integration_id', '=', c.integration_id).execute();
        return back('host');
      }
      if (!tok.refresh_token) {
        await db.updateTable('salesforce_connections').set({ last_error: 'Salesforce sent no refresh token. Add the refresh_token, offline_access scope to the Connected App.', updated_at: clock() })
          .where('integration_id', '=', c.integration_id).execute();
        return back('scope');
      }
      const ids = /\/id\/([A-Za-z0-9]{15,18})\/([A-Za-z0-9]{15,18})/.exec(tok.id ?? '');
      let info: { preferred_username?: string; organization_id?: string; user_id?: string } = {};
      try { info = await userInfo(instanceUrl, tok.access_token, allowAnyHost); } catch (err) { log('warn', 'salesforce userinfo failed', { error: errorText(err) }); }
      const orgId = info.organization_id ?? ids?.[1] ?? null;
      const [{ hiEvent }, { hiConsent }] = await Promise.all([
        db.selectFrom('message_events').select(sql<string | null>`max(id)`.as('hiEvent')).executeTakeFirstOrThrow(),
        db.selectFrom('consent_history').select(sql<string | null>`max(id)`.as('hiConsent')).executeTakeFirstOrThrow(),
      ]);
      await db.updateTable('salesforce_connections').set({
        status: 'connected', refresh_token_encrypted: encrypt(config.secretKey, tok.refresh_token), access_token_encrypted: encrypt(config.secretKey, tok.access_token),
        instance_url: instanceUrl, org_id: orgId, sf_user_id: info.user_id ?? ids?.[2] ?? null, username: info.preferred_username?.slice(0, 320) ?? null,
        connected_at: clock(), connected_by: pending.user_id, last_error: null, next_sync_at: clock(), lease_until: null, updated_at: clock(),
        push_event_cursor: hiEvent ?? '0', push_consent_cursor: hiConsent ?? '0',
        // Another org's cursors mean nothing here.
        ...(c.org_id && c.org_id !== orgId ? { pull_state: '{}', last_run: null } : {}),
      }).where('integration_id', '=', c.integration_id).execute();
      await audit(db, { type: 'user', id: pending.user_id }, { action: 'salesforce.connect', entityType: 'integration', entityId: c.integration_id, details: { org_id: orgId } });
      return back();
    },

    async updateSettings(input: unknown, actor: Actor) {
      const c = await requireConn();
      const merged = { ...readSettings(c.settings), ...(input as object) };
      const settings = settingsSchema.parse(merged) as SalesforceSettings;
      // When connected, every mapped field must exist on the object.
      if (c.refresh_token_encrypted) {
        const client = clientFor(c);
        const problems: { path: string; message: string }[] = [];
        for (const object of SF_OBJECTS.filter((o) => settings.objects[o].enabled)) {
          let names: Set<string>;
          try { names = new Set((await client.describe(object)).fields.map((f) => f.name)); } catch (err) {
            throw new HttpError(502, `Could not check the ${object} fields in Salesforce: ${errorText(err)}`);
          }
          const os = settings.objects[object];
          if (!names.has(os.external_id_field)) problems.push({ path: `objects.${object}.external_id_field`, message: `${os.external_id_field} is not a ${object} field` });
          os.fields.forEach((f, i) => { if (!names.has(f.field)) problems.push({ path: `objects.${object}.fields.${i}.field`, message: `${f.field} is not a ${object} field` }); });
          os.consent.forEach((f, i) => { if (!names.has(f.field)) problems.push({ path: `objects.${object}.consent.${i}.field`, message: `${f.field} is not a ${object} field` }); });
        }
        if (problems.length) throw badRequest(problems[0]!.message, problems);
      }
      await db.updateTable('salesforce_connections').set({ settings: JSON.stringify(settings), updated_at: clock() }).where('integration_id', '=', c.integration_id).execute();
      await audit(db, actor, { action: 'salesforce.settings', entityType: 'integration', entityId: c.integration_id, details: { fields: Object.keys(input as object) } });
      return this.get();
    },

    async describe(object: string) {
      if (!SF_OBJECTS.includes(object as SalesforceObject)) throw notFound('Object');
      const c = await requireConn();
      const started = Date.now();
      try {
        const res = await clientFor(c).describe(object);
        await requestLog(c.integration_id, 'GET', `salesforce describe ${object}`, 200, started, res.fields.length, null);
        return res;
      } catch (err) {
        await requestLog(c.integration_id, 'GET', `salesforce describe ${object}`, errorStatus(err), started, null, errorText(err));
        throw new HttpError(502, `Salesforce: ${errorText(err)}`);
      }
    },

    /** "Sync now": pull right away (unless a sync is running), then push. */
    async syncNow(actor: Actor) {
      const c = await requireConn();
      if (!c.refresh_token_encrypted) throw badRequest('Connect Salesforce first');
      const claimed = await claimForPull(c.integration_id);
      if (!claimed.length) throw conflict('A sync is already running');
      const run = await pull((await byId(c.integration_id))!);
      await audit(db, actor, { action: 'salesforce.sync', entityType: 'integration', entityId: c.integration_id });
      await pushAll();
      return { run, ...(await this.get()) };
    },

    /** Revokes the refresh token at Salesforce (best effort) and deletes the stored tokens. */
    async disconnect(actor: Actor) {
      const c = await requireConn();
      if (c.refresh_token_encrypted) {
        const started = Date.now();
        try {
          await revokeToken(c.login_host, decrypt(config.secretKey, c.refresh_token_encrypted), allowAnyHost);
          await requestLog(c.integration_id, 'POST', 'salesforce oauth revoke', 200, started, null, null);
        } catch (err) {
          await requestLog(c.integration_id, 'POST', 'salesforce oauth revoke', errorStatus(err), started, null, errorText(err));
        }
      }
      await db.updateTable('salesforce_connections').set({
        status: 'not_connected', refresh_token_encrypted: null, access_token_encrypted: null, instance_url: null, org_id: null, sf_user_id: null, username: null,
        connected_at: null, connected_by: null, lease_until: null, next_sync_at: null, last_error: null, updated_at: clock(),
      }).where('integration_id', '=', c.integration_id).execute();
      await db.deleteFrom('salesforce_oauth_states').where('integration_id', '=', c.integration_id).execute();
      await audit(db, actor, { action: 'salesforce.disconnect', entityType: 'integration', entityId: c.integration_id });
      return this.get();
    },

    async outbox(filter: { status?: 'pending' | 'sent' | 'failed' | undefined; limit?: number }) {
      const c = await current();
      if (!c) return [];
      let q = db.selectFrom('salesforce_outbox')
        .select(['id', 'kind', 'sf_object', 'status', 'attempts', 'next_attempt_at', 'error', 'sf_record_id', 'created_at', 'updated_at', sql<string | null>`payload->>'Subject'`.as('subject')])
        .where('integration_id', '=', c.integration_id).orderBy('created_at', 'desc').limit(Math.min(Math.max(filter.limit ?? 50, 1), 200));
      if (filter.status) q = q.where('status', '=', filter.status);
      return q.execute();
    },

    /** Manual retry of a failed row: one more attempt now. */
    async retry(id: string, actor: Actor) {
      const row = await db.selectFrom('salesforce_outbox').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw notFound('Outbox item');
      if (row.status !== 'failed') throw conflict('Only failed items can be retried');
      await db.updateTable('salesforce_outbox').set({ status: 'pending', attempts: MAX_SALESFORCE_ATTEMPTS - 1, next_attempt_at: null, updated_at: clock() }).where('id', '=', id).execute();
      const claimed = await db.updateTable('salesforce_outbox').set({ next_attempt_at: new Date(clock().getTime() + PUSH_LEASE_MS) })
        .where('id', '=', id).where('status', '=', 'pending').returningAll().executeTakeFirst();
      if (claimed) await deliverBatch(await byId(claimed.integration_id), claimed.kind, [claimed]);
      await audit(db, actor, { action: 'salesforce.outbox_retry', entityType: 'integration', entityId: row.integration_id, details: { item: id } });
      return db.selectFrom('salesforce_outbox').select(['id', 'kind', 'sf_object', 'status', 'attempts', 'next_attempt_at', 'error', 'sf_record_id', 'created_at', 'updated_at'])
        .where('id', '=', id).executeTakeFirstOrThrow();
    },

    // ---------- worker steps ----------

    /** Pulls every connection whose sync is due. */
    async pullDue() {
      const claimed = await claimForPull();
      for (const { integration_id } of claimed) {
        const c = await byId(integration_id);
        if (!c?.enabled) {
          await db.updateTable('salesforce_connections').set({ lease_until: null }).where('integration_id', '=', integration_id).execute();
          continue;
        }
        await pull(c);
      }
      return claimed.length;
    },

    /** Pump, then deliver. */
    pushDue: pushAll,
    pump: async () => {
      const conns = await connQuery().where('salesforce_connections.refresh_token_encrypted', 'is not', null).execute();
      let n = 0;
      for (const c of conns) n += await pump(c);
      return n;
    },
    deliverDue,
  };
}

export type SalesforceService = ReturnType<typeof createSalesforceService>;
