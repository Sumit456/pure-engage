import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../services/audit.ts';
import { actorOf, requireUser } from '../plugins/auth.ts';
import { badRequest } from '../errors.ts';

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
});
const importBody = z.object({
  rows: z.array(z.record(z.unknown())).max(1000, 'Max 1000 rows per request'),
  mode: z.string().optional(),
  dry_run: z.boolean().default(false),
  file_name: z.string().max(255).default('import'),
  first_row: z.number().int().min(1).default(2),
});
const eventsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().datetime({ offset: true }).optional() });
const body = (b: unknown) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw badRequest('Body must be a JSON object');
  return b as Record<string, unknown>;
};

export const contactRoutes: FastifyPluginAsync = async (app) => {
  const { contacts, events } = app.services;
  const viewer = { preHandler: requireUser('viewer') };
  const marketer = { preHandler: requireUser('marketer') };

  app.get('/api/contacts', viewer, async (req) => contacts.list(listQuery.parse(req.query)));

  // Spreadsheet import: the console parses and maps the file, then sends rows in chunks (dry run first).
  app.post('/api/contacts/import', marketer, async (req) => {
    const b = importBody.parse(req.body);
    const { contactImport } = app.services;
    return contactImport.run({ rows: b.rows, mode: contactImport.parseMode(b.mode), dryRun: b.dry_run, fileName: b.file_name, firstRow: b.first_row }, actorOf(req));
  });
  app.get('/api/contacts/imports', marketer, async () => ({ data: await app.services.contactImport.history() }));

  app.post('/api/contacts', marketer, async (req, reply) =>
    reply.code(201).send(await contacts.create(body(req.body), { source: 'console', actor: actorOf(req) })));

  // Opening a contact is PHI access, so every view is audited.
  app.get('/api/contacts/:id', viewer, async (req) => {
    const { id } = idParam.parse(req.params);
    const [contact, recentEvents, consentHistory, journeys] = await Promise.all([contacts.get(id), events.listForContact(id, { limit: 20 }), contacts.consentHistory(id, 20), app.services.journeys.forContact(id)]);
    await audit(app.deps.db, actorOf(req), { action: 'contact.view', entityType: 'contact', entityId: id });
    return { ...contact, recent_events: recentEvents, consent_history: consentHistory, journeys };
  });

  app.patch('/api/contacts/:id', marketer, async (req) => {
    const { contact_id: _ignored, ...patch } = body(req.body);
    return contacts.update(idParam.parse(req.params).id, patch, { source: 'console', actor: actorOf(req) });
  });

  app.delete('/api/contacts/:id', { preHandler: requireUser('admin') }, async (req, reply) => {
    await contacts.remove(idParam.parse(req.params).id, actorOf(req));
    return reply.code(204).send();
  });

  app.get('/api/contacts/:id/events', viewer, async (req) => {
    const { id } = idParam.parse(req.params);
    await contacts.get(id);
    return { data: await events.listForContact(id, eventsQuery.parse(req.query)) };
  });
};
