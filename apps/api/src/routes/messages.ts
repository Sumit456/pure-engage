// Outbox (console) and the transactional send API (docs/contracts/platform-ingest.openapi.yaml: /messages/send).
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf, requireApiKey, requireUser } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { HttpError, badRequest } from '../errors.ts';

const listQuery = z.object({
  contact_id: z.string().uuid().optional(),
  status: z.enum(['queued', 'deferred', 'sending', 'sent', 'delivered', 'failed', 'suppressed']).optional(),
  channel: z.enum(['email', 'sms']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
});

const recipientSchema = z.object({
  contact_id: z.string().uuid().optional(),
  external_id: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  properties: z.record(z.unknown()).default({}),
  attributes: z.record(z.unknown()).default({}),
  idempotency_key: z.string().min(1).max(200).optional(),
}).refine((r) => r.contact_id || r.external_id || r.email, 'one of contact_id, external_id or email is required');

const sendSchema = z.object({
  template_id: z.string().uuid(),
  recipients: z.array(z.unknown()).min(1),
  transactional: z.boolean().default(true),
  bypass_quiet_hours: z.boolean().default(false),
});

export const messageRoutes: FastifyPluginAsync = async (app) => {
  const { delivery, contacts, templates } = app.services;

  app.get('/api/messages', { preHandler: requireUser('viewer') }, async (req) => {
    const q = listQuery.parse(req.query);
    return delivery.list({ contactId: q.contact_id, status: q.status, channel: q.channel, limit: q.limit, cursor: q.cursor });
  });

  // Message bodies contain personal data, so opening one is audited like a contact view.
  app.get('/api/messages/:id', { preHandler: requireUser('viewer') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const msg = await delivery.get(id);
    await audit(app.deps.db, actorOf(req), { action: 'message.view', entityType: 'message', entityId: id });
    // Viewing in the console must not count as the recipient opening it: drop the open pixel from the preview copy.
    const preview = msg.body_html?.replace(/<img[^>]+\/t\/o\/[^>]+>/gi, '') ?? null;
    return { ...msg, body_html_preview: preview };
  });

  app.get('/api/delivery/status', { preHandler: requireUser('viewer') }, async () => ({
    mode: app.deps.config.PE_DELIVERY_MODE,
    providers: { email: app.services.providers.email.name, sms: app.services.providers.sms.name },
    allowlist: app.deps.config.PE_DELIVERY_MODE === 'live' && !!app.deps.config.PE_DELIVERY_ALLOWLIST,
  }));

  app.post('/api/v1/messages/send', { preHandler: requireApiKey, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = sendSchema.parse(req.body);
    if (body.recipients.length > 100) throw new HttpError(413, 'Max 100 recipients per request');
    const template = await templates.get(body.template_id);
    if (!body.transactional && template.purpose !== 'marketing') throw badRequest('Non-transactional sends must use a marketing template');
    const actor = actorOf(req);
    const results = [];
    for (const raw of body.recipients) {
      const parsed = recipientSchema.safeParse(raw);
      if (!parsed.success) { results.push({ error: parsed.error.issues.map((i) => i.message).join('; ') }); continue; }
      const r = parsed.data;
      try {
        const contact = r.contact_id
          ? await contacts.get(r.contact_id)
          : (await contacts.upsert({ external_id: r.external_id, email: r.email, ...(r.phone ? { phone: r.phone } : {}), ...r.attributes }, { source: 'api', actor })).contact;
        const m = await delivery.enqueue({ contact, templateId: template.id, data: r.properties, source: 'api', idempotencyKey: r.idempotency_key, bypassQuietHours: body.bypass_quiet_hours && template.purpose === 'care' });
        results.push({ contact_id: contact.id, message_id: m.id, status: m.status, reason: m.status_reason });
      } catch (err) {
        if (err instanceof HttpError && err.statusCode < 500) results.push({ error: err.message });
        else throw err;
      }
    }
    return reply.code(results.some((r) => 'error' in r) ? 207 : 201).send({ results });
  });
};
