import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf, requireUser } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const body = (b: unknown) => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});

export const segmentRoutes: FastifyPluginAsync = async (app) => {
  const { segments } = app.services;
  const viewer = { preHandler: requireUser('viewer') };
  const marketer = { preHandler: requireUser('marketer') };

  app.get('/api/segments', viewer, async () => ({ data: await segments.list() }));
  app.post('/api/segments/preview', viewer, async (req) => segments.preview(body(req.body).rules));
  app.post('/api/segments', marketer, async (req, reply) => reply.code(201).send(await segments.create(body(req.body), actorOf(req))));
  app.get('/api/segments/:id', viewer, async (req) => {
    const s = await segments.get(idParam.parse(req.params).id);
    return { ...s, size: await segments.count(s.rules) };
  });
  app.put('/api/segments/:id', marketer, async (req) => segments.update(idParam.parse(req.params).id, body(req.body), actorOf(req)));
  app.delete('/api/segments/:id', marketer, async (req, reply) => { await segments.archive(idParam.parse(req.params).id, actorOf(req)); return reply.code(204).send(); });
};

export const campaignRoutes: FastifyPluginAsync = async (app) => {
  const { campaigns } = app.services;
  const viewer = { preHandler: requireUser('viewer') };
  const marketer = { preHandler: requireUser('marketer') };

  app.get('/api/campaigns', viewer, async () => ({ data: await campaigns.list() }));
  app.post('/api/campaigns', marketer, async (req, reply) => reply.code(201).send(await campaigns.create(req.body, actorOf(req))));
  app.get('/api/campaigns/:id', viewer, async (req) => campaigns.detail(idParam.parse(req.params).id));
  app.put('/api/campaigns/:id', marketer, async (req) => campaigns.update(idParam.parse(req.params).id, req.body, actorOf(req)));
  app.get('/api/campaigns/:id/estimate', viewer, async (req) => campaigns.estimate(idParam.parse(req.params).id));
  app.post('/api/campaigns/:id/schedule', marketer, async (req) => {
    const { scheduled_at } = z.object({ scheduled_at: z.string().datetime({ offset: true }).optional() }).parse(body(req.body));
    return campaigns.schedule(idParam.parse(req.params).id, scheduled_at, actorOf(req));
  });
  app.post('/api/campaigns/:id/cancel', marketer, async (req) => campaigns.cancel(idParam.parse(req.params).id, actorOf(req)));
  app.post('/api/campaigns/:id/test', marketer, async (req) => {
    const { contact_id } = z.object({ contact_id: z.string().uuid() }).parse(body(req.body));
    return campaigns.testSend(idParam.parse(req.params).id, contact_id, actorOf(req));
  });
};
