// Message delivery: policy and rendering at enqueue time, then a Postgres-backed dispatcher
// (FOR UPDATE SKIP LOCKED, safe with several API instances). Consent is checked again just before sending,
// because it can be withdrawn while a message waits (quiet hours, retries).
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { canSend } from '@pure-engage/shared';
import type { Config } from '../config.ts';
import type { Insertable } from 'kysely';
import type { Contact, Database, EmailContent, Message, MessagesTable, MessageStatus, SmsContent } from '../db/schema.ts';
import { badRequest, notFound } from '../errors.ts';
import type { ContactsService } from './contacts.ts';
import { ProviderError, allowlistMatcher, verifyTwilioSignature, type Provider } from './providers.ts';
import { isQuiet, nextAllowed, parseWindow } from './quiet-hours.ts';
import { addTracking, contactContext, finaliseEmailHtml, localeFor, pickLocale, render, type RenderedEmail, type RenderedSms } from './rendering.ts';
import type { TemplatesService } from './templates.ts';
import type { LinkSigner } from './tracking.ts';

const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;
const STUCK_AFTER_MS = 10 * 60_000;
type NewMessage = Omit<Insertable<MessagesTable>, 'created_at' | 'updated_at'> & { id: string };
const COUNTS_TOWARD_CAP: MessageStatus[] = ['queued', 'deferred', 'sending', 'sent', 'delivered'];

export interface EnqueueInput {
  contact: Contact;
  templateId: string;
  data?: Record<string, unknown>;
  source: string;
  idempotencyKey?: string | undefined;
  /** For urgent care messages only (e.g. a same-day appointment change). */
  bypassQuietHours?: boolean;
  campaignId?: string | undefined;
  journeyId?: string | undefined;
}

export interface DeliveryDeps {
  db: Kysely<Database>;
  config: Config;
  contacts: ContactsService;
  templates: TemplatesService;
  signer: LinkSigner;
  providers: { email: Provider; sms: Provider };
  clock: () => Date;
  log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

export function createDeliveryService({ db, config, contacts, templates, signer, providers, clock, log = () => {} }: DeliveryDeps) {
  const quietWindow = parseWindow(config.PE_SMS_QUIET_HOURS);
  const allowed = allowlistMatcher(config.PE_DELIVERY_MODE === 'live' ? config.PE_DELIVERY_ALLOWLIST : undefined);
  const addressOf = (c: Contact, channel: Message['channel']) => (channel === 'email' ? c.email : c.phone);
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function isSuppressed(channel: Message['channel'], address: string) {
    return !!(await db.selectFrom('suppressions').select('id').where('channel', '=', channel).where('address', '=', address.toLowerCase()).executeTakeFirst());
  }

  async function overMarketingCap(contactId: string, channel: Message['channel'], now: Date) {
    if (config.PE_MARKETING_CAP_PER_WEEK === 0) return false;
    const { count } = await db.selectFrom('messages').select((eb) => eb.fn.countAll<string>().as('count'))
      .where('contact_id', '=', contactId).where('channel', '=', channel).where('purpose', '=', 'marketing')
      .where('status', 'in', COUNTS_TOWARD_CAP).where('created_at', '>', new Date(now.getTime() - 7 * 86_400_000))
      .executeTakeFirstOrThrow();
    return Number(count) >= config.PE_MARKETING_CAP_PER_WEEK;
  }

  async function event(messageId: string, type: Database['message_events']['type'], detail?: string) {
    await db.insertInto('message_events').values({ message_id: messageId, type, detail: detail ?? null }).execute();
  }

  async function enqueue(input: EnqueueInput): Promise<Message> {
    const now = clock();
    if (input.idempotencyKey) {
      const existing = await db.selectFrom('messages').selectAll().where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (existing) return existing;
    }
    const template = await templates.get(input.templateId);
    if (template.archived_at) throw badRequest('Template is archived');
    const { contact } = input;
    const { channel, purpose } = template;
    const { locale, part } = pickLocale(template.content, localeFor(contact));
    const address = addressOf(contact, channel);
    const id = randomUUID();

    const base = {
      id, contact_id: contact.id, template_id: template.id, template_version: template.current_version,
      channel, purpose, locale, to_address: address, source: input.source, idempotency_key: input.idempotencyKey ?? null,
      campaign_id: input.campaignId ?? null,
      journey_id: input.journeyId ?? null,
    };

    let suppressedReason: string | null = null;
    if (!address) suppressedReason = 'no_address';
    else if (!canSend(contact.consent, channel, purpose)) suppressedReason = 'no_consent';
    else if (await isSuppressed(channel, address)) suppressedReason = 'suppressed_address';
    else if (purpose === 'marketing' && (await overMarketingCap(contact.id, channel, now))) suppressedReason = 'frequency_cap';

    if (suppressedReason) {
      // Nothing is rendered or stored for messages that will never be sent.
      return insert({ ...base, status: 'suppressed', status_reason: suppressedReason, next_attempt_at: null });
    }

    const unsubscribeUrl = channel === 'email' && purpose === 'marketing' ? signer.unsubscribeUrl(id) : undefined;
    const rendered = await render(channel, part as EmailContent | SmsContent, {
      contact: contactContext(contact), data: input.data ?? {}, brand: { name: config.PE_BRAND_NAME }, unsubscribe_url: unsubscribeUrl ?? '',
    });

    let subject: string | null = null;
    let html: string | null = null;
    let text: string;
    if (channel === 'email') {
      const r = rendered as RenderedEmail;
      subject = r.subject;
      html = finaliseEmailHtml(r.html, { locale, unsubscribeUrl, brand: config.PE_BRAND_NAME });
      if (config.PE_TRACKING_ENABLED) {
        html = addTracking(html, { trackUrl: (url) => signer.clickUrl(id, url), pixelUrl: signer.pixelUrl(id), skipPrefix: `${signer.base}/u/` });
      }
      text = unsubscribeUrl ? `${r.text}\n\n${locale === 'ar' ? 'إلغاء الاشتراك' : 'Unsubscribe'}: ${unsubscribeUrl}` : r.text;
    } else {
      text = (rendered as RenderedSms).text;
      if (!text) return insert({ ...base, status: 'failed', status_reason: 'empty_body', next_attempt_at: null });
    }

    const timeZone = contact.timezone ?? config.PE_DEFAULT_TIMEZONE;
    const deferred = channel === 'sms' && !input.bypassQuietHours && isQuiet(now, timeZone, quietWindow);
    return insert({
      ...base, subject, body_html: html, body_text: text,
      status: deferred ? 'deferred' : 'queued',
      status_reason: deferred ? 'quiet_hours' : null,
      next_attempt_at: deferred ? nextAllowed(now, timeZone, quietWindow) : now,
    });
  }

  async function insert(values: NewMessage): Promise<Message> {
    const now = clock();
    const row = await db.insertInto('messages').values({ ...values, created_at: now, updated_at: now })
      .onConflict((oc) => oc.column('idempotency_key').doNothing()).returningAll().executeTakeFirst();
    if (row) return row;
    return db.selectFrom('messages').selectAll().where('idempotency_key', '=', values.idempotency_key!).executeTakeFirstOrThrow();
  }

  async function finish(id: string, set: Partial<Pick<Message, 'status' | 'status_reason' | 'provider' | 'provider_message_id' | 'next_attempt_at' | 'sent_at'>>) {
    await db.updateTable('messages').set({ ...set, updated_at: clock() }).where('id', '=', id).execute();
  }

  async function deliverOne(msg: Message): Promise<void> {
    const contact = await db.selectFrom('contacts').selectAll().where('id', '=', msg.contact_id).executeTakeFirst();
    if (!contact) return; // erased while queued (the message row cascades away)
    if (!canSend(contact.consent, msg.channel, msg.purpose)) return finish(msg.id, { status: 'suppressed', status_reason: 'no_consent', next_attempt_at: null });
    if (!msg.to_address || (await isSuppressed(msg.channel, msg.to_address))) return finish(msg.id, { status: 'suppressed', status_reason: 'suppressed_address', next_attempt_at: null });
    if (!allowed(msg.to_address)) return finish(msg.id, { status: 'suppressed', status_reason: 'not_in_allowlist', next_attempt_at: null });

    const provider = providers[msg.channel];
    try {
      const { providerMessageId } = await provider.send({
        ...msg,
        unsubscribeUrl: msg.channel === 'email' && msg.purpose === 'marketing' ? signer.unsubscribeUrl(msg.id) : undefined,
      });
      await finish(msg.id, { status: 'sent', status_reason: null, provider: provider.name, provider_message_id: providerMessageId, sent_at: clock(), next_attempt_at: null });
      await event(msg.id, 'sent', provider.name);
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 500) : String(err);
      const retryable = err instanceof ProviderError ? err.retryable : true;
      if (retryable && msg.attempts < MAX_ATTEMPTS) {
        await finish(msg.id, { status: 'queued', status_reason: reason, provider: provider.name, next_attempt_at: new Date(clock().getTime() + RETRY_BACKOFF_MS[msg.attempts - 1]!) });
        await event(msg.id, 'retry', reason);
      } else {
        await finish(msg.id, { status: 'failed', status_reason: reason, provider: provider.name, next_attempt_at: null });
        await event(msg.id, 'failed', reason);
      }
      log('warn', 'message delivery failed', { id: msg.id, channel: msg.channel, retryable, attempts: msg.attempts, reason });
    }
  }

  return {
    enqueue,

    /** Claims due messages and sends them. Returns how many were processed. */
    async dispatchOnce(limit = 50): Promise<number> {
      const now = clock();
      // Recover rows left in `sending` by a crashed process (at-least-once delivery).
      await db.updateTable('messages').set({ status: 'queued', updated_at: now })
        .where('status', '=', 'sending').where('updated_at', '<', new Date(now.getTime() - STUCK_AFTER_MS)).execute();
      const claimed = await db.updateTable('messages')
        .set({ status: 'sending', attempts: sql`attempts + 1`, updated_at: now })
        .where('id', 'in', (eb) => eb.selectFrom('messages').select('id')
          .where('status', 'in', ['queued', 'deferred']).where('next_attempt_at', '<=', now)
          .orderBy('next_attempt_at').limit(limit).forUpdate().skipLocked())
        .returningAll().execute();
      for (const msg of claimed) await deliverOne(msg);
      return claimed.length;
    },

    start(intervalMs: number) {
      if (!intervalMs || timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        this.dispatchOnce().catch((err) => log('error', 'dispatcher failed', { error: (err as Error).message })).finally(() => { running = false; });
      }, intervalMs);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },

    async recordOpen(messageId: string) {
      const res = await db.updateTable('messages').set({ opened_at: sql`coalesce(opened_at, now())` }).where('id', '=', messageId).executeTakeFirst();
      if (res.numUpdatedRows) await event(messageId, 'open');
    },

    async recordClick(messageId: string, url: string) {
      const res = await db.updateTable('messages').set({ clicked_at: sql`coalesce(clicked_at, now())`, opened_at: sql`coalesce(opened_at, now())` }).where('id', '=', messageId).executeTakeFirst();
      if (res.numUpdatedRows) await event(messageId, 'click', url.slice(0, 2000));
    },

    /** Unsubscribe from marketing on the message's channel. Idempotent. */
    async unsubscribe(messageId: string) {
      const msg = await db.selectFrom('messages').select(['id', 'contact_id', 'channel']).where('id', '=', messageId).executeTakeFirst();
      if (!msg) throw notFound('Message');
      await db.transaction().execute(async (tx) => {
        await contacts.upsertIn(tx, { contact_id: msg.contact_id, consent: { [msg.channel]: { marketing: 'denied' } } }, { source: 'unsubscribe', actor: { type: 'system', id: 'unsubscribe' } });
      });
      await event(messageId, 'unsubscribe');
    },

    /** Twilio delivery receipts. Returns false when the signature doesn't verify. */
    async twilioStatus(params: Record<string, string>, signature: string): Promise<boolean> {
      const url = `${config.PE_PUBLIC_URL.replace(/\/+$/, '')}/hooks/twilio/status`;
      if (!config.TWILIO_AUTH_TOKEN || !verifyTwilioSignature(config.TWILIO_AUTH_TOKEN, url, params, signature)) return false;
      const sid = params.MessageSid ?? params.SmsSid;
      const status = params.MessageStatus ?? params.SmsStatus;
      if (!sid || !status) return true;
      const msg = await db.selectFrom('messages').select(['id']).where('provider', '=', 'twilio').where('provider_message_id', '=', sid).executeTakeFirst();
      if (!msg) return true;
      if (status === 'delivered') {
        await db.updateTable('messages').set({ status: 'delivered', delivered_at: clock(), updated_at: clock() }).where('id', '=', msg.id).execute();
        await event(msg.id, 'delivered');
      } else if (status === 'undelivered' || status === 'failed') {
        const reason = `twilio_${status}${params.ErrorCode ? `_${params.ErrorCode}` : ''}`;
        await finish(msg.id, { status: 'failed', status_reason: reason });
        await event(msg.id, 'failed', reason);
      }
      return true;
    },

    async list({ contactId, campaignId, status, channel, limit = 50, cursor }: { contactId?: string | undefined; campaignId?: string | undefined; status?: MessageStatus | undefined; channel?: Message['channel'] | undefined; limit?: number; cursor?: string | undefined }) {
      let q = db.selectFrom('messages').leftJoin('templates', 'templates.id', 'messages.template_id')
        .select(['messages.id', 'messages.contact_id', 'messages.template_id', 'templates.name as template_name', 'messages.channel', 'messages.purpose', 'messages.locale', 'messages.to_address', 'messages.subject', 'messages.status', 'messages.status_reason', 'messages.provider', 'messages.source', 'messages.campaign_id', 'messages.journey_id', 'messages.created_at', 'messages.sent_at', 'messages.delivered_at', 'messages.opened_at', 'messages.clicked_at', 'messages.next_attempt_at'])
        .orderBy('messages.created_at', 'desc').orderBy('messages.id', 'desc').limit(Math.min(limit, 200) + 1);
      if (contactId) q = q.where('messages.contact_id', '=', contactId);
      if (campaignId) q = q.where('messages.campaign_id', '=', campaignId);
      if (status) q = q.where('messages.status', '=', status);
      if (channel) q = q.where('messages.channel', '=', channel);
      if (cursor) {
        const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
        if (!at || !id) throw badRequest('Invalid cursor');
        q = q.where((eb) => eb.or([eb('messages.created_at', '<', new Date(at)), eb.and([eb('messages.created_at', '=', new Date(at)), eb('messages.id', '<', id)])]));
      }
      const rows = await q.execute();
      const page = rows.slice(0, Math.min(limit, 200));
      const last = page.at(-1);
      return { data: page, next_cursor: rows.length > page.length && last ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url') : null };
    },

    async get(id: string) {
      const msg = await db.selectFrom('messages').selectAll().where('id', '=', id).executeTakeFirst();
      if (!msg) throw notFound('Message');
      const events = await db.selectFrom('message_events').selectAll().where('message_id', '=', id).orderBy('at').orderBy('id').execute();
      return { ...msg, events };
    },

    async suppress(channel: Message['channel'], address: string, reason: string) {
      await db.insertInto('suppressions').values({ channel, address: address.toLowerCase(), reason }).onConflict((oc) => oc.columns(['channel', 'address']).doNothing()).execute();
    },
  };
}

export type DeliveryService = ReturnType<typeof createDeliveryService>;
