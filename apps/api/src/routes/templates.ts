import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { smsInfo } from '@pure-engage/shared';
import type { EmailContent, SmsContent, TemplateContent } from '../db/schema.ts';
import { actorOf, requireUser } from '../plugins/auth.ts';
import { contactContext, finaliseEmailHtml, localeFor, pickLocale, render, validateContent, type RenderedEmail, type RenderedSms } from '../services/rendering.ts';
import { audit } from '../services/audit.ts';

const idParam = z.object({ id: z.string().uuid() });
const versionParam = idParam.extend({ version: z.coerce.number().int().min(1) });
const previewSchema = z.object({
  channel: z.enum(['email', 'sms']),
  purpose: z.enum(['care', 'marketing']).default('care'),
  content: z.record(z.unknown()),
  locale: z.enum(['en', 'ar']).optional(),
  contact_id: z.string().uuid().optional(),
  data: z.record(z.unknown()).default({}),
});

const SAMPLE_CONTACT = { id: '00000000-0000-0000-0000-000000000000', external_id: 'MBR-TEST-0001', first_name: 'Test', last_name: 'Member', email: 'test.member@example.com', phone: '+971500000001', preferred_language: 'en', timezone: 'Asia/Dubai', attributes: {} };

export const templateRoutes: FastifyPluginAsync = async (app) => {
  const { templates } = app.services;
  const viewer = { preHandler: requireUser('viewer') };
  const marketer = { preHandler: requireUser('marketer') };

  app.get('/api/templates', viewer, async (req) => ({ data: await templates.list({ includeArchived: (req.query as { archived?: string }).archived === '1' }) }));
  app.post('/api/templates', marketer, async (req, reply) => reply.code(201).send(await templates.create(req.body, actorOf(req))));
  app.get('/api/templates/:id', viewer, async (req) => templates.get(idParam.parse(req.params).id));
  app.put('/api/templates/:id', marketer, async (req) => templates.update(idParam.parse(req.params).id, req.body, actorOf(req)));
  app.delete('/api/templates/:id', marketer, async (req, reply) => { await templates.archive(idParam.parse(req.params).id, actorOf(req)); return reply.code(204).send(); });
  app.get('/api/templates/:id/versions', viewer, async (req) => ({ data: await templates.versions(idParam.parse(req.params).id) }));
  app.get('/api/templates/:id/versions/:version', viewer, async (req) => { const p = versionParam.parse(req.params); return templates.getVersion(p.id, p.version); });
  app.post('/api/templates/:id/versions/:version/restore', marketer, async (req) => { const p = versionParam.parse(req.params); return templates.restore(p.id, p.version, actorOf(req)); });

  // Renders unsaved content for the editor, against a real contact or a synthetic sample.
  app.post('/api/templates/preview', viewer, async (req) => {
    const input = previewSchema.parse(req.body);
    const content = input.content as unknown as TemplateContent;
    validateContent(input.channel, content);
    let contact: Record<string, unknown> = SAMPLE_CONTACT;
    let wanted = input.locale ?? 'en';
    if (input.contact_id) {
      const c = await app.services.contacts.get(input.contact_id);
      await audit(app.deps.db, actorOf(req), { action: 'contact.view', entityType: 'contact', entityId: c.id, details: { via: 'template_preview' } });
      contact = contactContext(c);
      wanted = input.locale ?? localeFor(c);
    }
    const { locale, part } = pickLocale(content, wanted);
    const unsubscribe = input.channel === 'email' && input.purpose === 'marketing' ? `${app.services.signer.base}/u/preview` : '';
    const rendered = await render(input.channel, part as EmailContent | SmsContent, { contact, data: input.data, brand: { name: app.deps.config.PE_BRAND_NAME }, unsubscribe_url: unsubscribe });
    if (input.channel === 'sms') {
      const text = (rendered as RenderedSms).text;
      return { locale, text, sms: smsInfo(text) };
    }
    const email = rendered as RenderedEmail;
    return { locale, subject: email.subject, html: finaliseEmailHtml(email.html, { locale, unsubscribeUrl: unsubscribe || undefined, brand: app.deps.config.PE_BRAND_NAME }), text: email.text };
  });
};
