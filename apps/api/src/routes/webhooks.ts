import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf, requireUser } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  const { webhooks } = app.services;
  const admin = { preHandler: requireUser('admin') };

  app.get('/api/webhooks', admin, async () => ({ data: await webhooks.list() }));
  app.post('/api/webhooks', admin, async (req, reply) => reply.code(201).send(await webhooks.create(req.body, actorOf(req))));
  app.patch('/api/webhooks/:id', admin, async (req) => webhooks.update(idParam.parse(req.params).id, req.body, actorOf(req)));
  app.delete('/api/webhooks/:id', admin, async (req, reply) => { await webhooks.remove(idParam.parse(req.params).id, actorOf(req)); return reply.code(204).send(); });
  app.post('/api/webhooks/:id/rotate-secret', admin, async (req) => webhooks.rotateSecret(idParam.parse(req.params).id, actorOf(req)));
  app.post('/api/webhooks/:id/test', admin, async (req) => webhooks.test(idParam.parse(req.params).id, actorOf(req)));
  app.get('/api/webhooks/:id/deliveries', admin, async (req) => ({ data: await webhooks.deliveries(idParam.parse(req.params).id) }));
  app.post('/api/webhook-deliveries/:id/retry', admin, async (req) => webhooks.retry(idParam.parse(req.params).id, actorOf(req)));
};
