import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf, requireUser } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';

const idParam = z.object({ id: z.string().uuid() });
const body = (b: unknown) => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});
const simulateSchema = z.object({
  definition: z.unknown(),
  contact_id: z.string().uuid().optional(),
  context: z.record(z.unknown()).optional(),
  events: z.array(z.string()).max(20).optional(),
});

export const journeyRoutes: FastifyPluginAsync = async (app) => {
  const { journeys } = app.services;
  const viewer = { preHandler: requireUser('viewer') };
  const marketer = { preHandler: requireUser('marketer') };

  app.get('/api/journeys', viewer, async () => ({ data: await journeys.list() }));
  app.post('/api/journeys', marketer, async (req, reply) => reply.code(201).send(await journeys.create(body(req.body), actorOf(req))));
  app.post('/api/journeys/starters/appointment-reminder', marketer, async (req, reply) => reply.code(201).send(await journeys.createAppointmentReminderStarter(actorOf(req))));
  app.post('/api/journeys/simulate', viewer, async (req) => {
    const input = simulateSchema.parse(req.body);
    if (input.contact_id) await audit(app.deps.db, actorOf(req), { action: 'contact.view', entityType: 'contact', entityId: input.contact_id, details: { via: 'journey_simulation' } });
    return journeys.simulate({ ...input, definition: input.definition });
  });
  app.get('/api/journeys/:id', viewer, async (req) => journeys.detail(idParam.parse(req.params).id));
  app.put('/api/journeys/:id', marketer, async (req) => journeys.update(idParam.parse(req.params).id, body(req.body), actorOf(req)));
  app.post('/api/journeys/:id/activate', marketer, async (req) => journeys.activate(idParam.parse(req.params).id, actorOf(req)));
  app.post('/api/journeys/:id/pause', marketer, async (req) => journeys.pause(idParam.parse(req.params).id, actorOf(req)));
  app.delete('/api/journeys/:id', marketer, async (req, reply) => { await journeys.archive(idParam.parse(req.params).id, actorOf(req)); return reply.code(204).send(); });
  app.get('/api/journeys/:id/enrollments', viewer, async (req) => ({ data: await journeys.enrollments(idParam.parse(req.params).id) }));
};
