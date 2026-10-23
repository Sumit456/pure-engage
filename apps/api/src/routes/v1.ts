// Public API v1 beyond /track and /messages/send (docs/contracts/platform-ingest.openapi.yaml). Every route takes a
// scoped API key and reuses the same services as the console, so contact resolution, consent history, delivery
// policy and journeys behave identically whoever calls them.
import { readFileSync } from 'node:fs';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { parse } from 'yaml';
import { z } from 'zod';
import { consentMapSchema } from '@pure-engage/shared';
import type { Contact } from '../db/schema.ts';
import { notFound, badRequest } from '../errors.ts';
import { actorOf, assertScope, hasScope, requireApiKey } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';

const SPEC_PATH = new URL('../../../../docs/contracts/platform-ingest.openapi.yaml', import.meta.url);

const refSchema = z.object({
  contact_id: z.string().uuid().optional(),
  external_id: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
}).refine((r) => r.contact_id || r.external_id || r.email, 'one of contact_id, external_id or email is required');
const idParam = z.object({ id: z.string().uuid() });

const maskEmail = (e: string | null) => {
  if (!e) return null;
  const [user = '', domain = ''] = e.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
};
const maskPhone = (p: string | null) => (p ? `${p.slice(0, 4)}${'*'.repeat(Math.max(0, p.length - 6))}${p.slice(-2)}` : null);
const initial = (s: string | null) => (s ? `${s.trim().slice(0, 1)}.` : null);

/**
 * A contact as an integration sees it. Without `contacts:read_pii`, names become initials, email and phone are
 * masked and only attribute names are returned (attributes can hold health details).
 */
export function contactView(c: Contact, pii: boolean) {
  const base = { id: c.id, external_id: c.external_id, preferred_language: c.preferred_language, timezone: c.timezone, consent: c.consent, created_at: c.created_at, updated_at: c.updated_at };
  if (pii) return { ...base, email: c.email, phone: c.phone, first_name: c.first_name, last_name: c.last_name, attributes: c.attributes, masked: false };
  return { ...base, email: maskEmail(c.email), phone: maskPhone(c.phone), first_name: initial(c.first_name), last_name: initial(c.last_name), attribute_names: Object.keys(c.attributes ?? {}), masked: true };
}

export const v1Routes: FastifyPluginAsync = async (app) => {
  const { contacts, events, journeys, delivery, segments, campaigns, reports } = app.services;
  const rate = { rateLimit: { max: 600, timeWindow: '1 minute' } };

  let spec: unknown = null;
  app.get('/api/v1/openapi.json', async (_req, reply) => {
    spec ??= { ...(parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, unknown>), servers: [{ url: `${app.deps.config.PE_PUBLIC_URL.replace(/\/$/, '')}/api/v1` }] };
    return reply.header('cache-control', 'public, max-age=300').send(spec);
  });

  // Opening a contact is PHI access, so every lookup is audited (with whether full values were returned).
  async function view(req: FastifyRequest, c: Contact) {
    const pii = hasScope(req, 'contacts:read_pii');
    await audit(app.deps.db, actorOf(req), { action: 'contact.view', entityType: 'contact', entityId: c.id, details: { via: 'api', pii } });
    req.logItems = 1;
    return contactView(c, pii);
  }

  app.get('/api/v1/contacts/:id', { preHandler: requireApiKey('contacts:read'), config: rate }, async (req) => view(req, await contacts.get(idParam.parse(req.params).id)));

  // Lookups by external ID or email go in the body so identifiers never end up in URLs or access logs.
  app.post('/api/v1/contacts/lookup', { preHandler: requireApiKey('contacts:read'), config: rate }, async (req) => {
    const c = await contacts.findByRef(refSchema.parse(req.body));
    if (!c) throw notFound('Contact');
    return view(req, c);
  });

  app.post('/api/v1/consent', { preHandler: requireApiKey('consent:write'), config: rate }, async (req) => {
    const body = refSchema.and(z.object({ consent: consentMapSchema })).parse(req.body);
    const existing = await contacts.findByRef(body);
    if (!existing) throw notFound('Contact');
    const { contact } = await contacts.upsert({ contact_id: existing.id, consent: body.consent }, { source: 'api', actor: actorOf(req) });
    req.logItems = 1;
    return { contact_id: contact.id, consent: contact.consent };
  });

  // Journeys start from events (ADR-0005), so a trigger records the journey's trigger event for the contact; the
  // worker enrols them. Other active journeys listening for the same event start too.
  app.post('/api/v1/journeys/:id/trigger', { preHandler: requireApiKey('journeys:trigger'), config: rate }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = refSchema.and(z.object({
      attributes: z.record(z.unknown()).default({}),
      properties: z.record(z.unknown()).default({}),
      idempotency_key: z.string().min(1).max(200).optional(),
    })).parse(req.body);
    const journey = await journeys.detail(id);
    if (journey.status !== 'active') throw badRequest('This journey is not active');
    const actor = actorOf(req);
    let contact = await contacts.findByRef(body);
    if (Object.keys(body.attributes).length || !contact) {
      assertScope(req, 'contacts:write');
      contact = (await contacts.upsert({ ...body.attributes, contact_id: contact?.id ?? body.contact_id, external_id: contact ? undefined : body.external_id, email: contact ? undefined : body.email }, { source: 'api', actor })).contact;
    }
    const { event, duplicate } = await events.track({
      contact_id: contact.id, name: journey.definition.trigger.event_name, properties: body.properties,
      ...(body.idempotency_key ? { idempotency_key: `api:${body.idempotency_key}` } : {}),
    }, { source: 'api', actor });
    req.logItems = 1;
    return reply.code(duplicate ? 200 : 202).send({ contact_id: contact.id, event_id: event.id, event_name: event.name, duplicate });
  });

  // Status only: message bodies are personal data and stay in the console.
  app.get('/api/v1/messages/:id', { preHandler: requireApiKey('messages:read'), config: rate }, async (req) => {
    const m = await delivery.get(idParam.parse(req.params).id);
    return {
      id: m.id, contact_id: m.contact_id, template_id: m.template_id, campaign_id: m.campaign_id, channel: m.channel,
      status: m.status, status_reason: m.status_reason, created_at: m.created_at, sent_at: m.sent_at,
      opened_at: m.opened_at, clicked_at: m.clicked_at, events: m.events.map((e) => ({ type: e.type, at: e.at })),
    };
  });

  app.get('/api/v1/segments', { preHandler: requireApiKey('segments:read'), config: rate }, async () => ({
    data: (await segments.list()).map((s) => ({ id: s.id, name: s.name, description: s.description, size: s.size, updated_at: s.updated_at })),
  }));

  app.get('/api/v1/campaigns', { preHandler: requireApiKey('campaigns:read'), config: rate }, async () => ({
    data: (await campaigns.list()).map((c) => ({
      id: c.id, name: c.name, status: c.status, channel: c.channel, purpose: c.purpose, template_name: c.template_name, segment_name: c.segment_name,
      scheduled_at: c.scheduled_at, completed_at: c.completed_at, stats: c.stats,
    })),
  }));
  app.get('/api/v1/campaigns/:id', { preHandler: requireApiKey('campaigns:read'), config: rate }, async (req) => {
    const c = await campaigns.detail(idParam.parse(req.params).id);
    return { id: c.id, name: c.name, status: c.status, template: c.template, segment: c.segment, scheduled_at: c.scheduled_at, completed_at: c.completed_at, stats: c.stats };
  });

  app.get('/api/v1/reports/overview', { preHandler: requireApiKey('reports:read'), config: rate }, async () => reports.overview());
};
