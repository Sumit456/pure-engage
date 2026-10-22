// Users, API keys and the audit log (admin only).
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf, requireUser } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const auditQuery = z.object({
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const admin = { preHandler: requireUser('admin') };
  const { auth } = app.services;

  app.get('/api/users', admin, async () => ({ data: await auth.listUsers() }));
  app.post('/api/users', admin, async (req, reply) => reply.code(201).send(await auth.createUser(req.body as never, actorOf(req))));
  app.patch('/api/users/:id', admin, async (req) => auth.updateUser(idParam.parse(req.params).id, req.body as never, actorOf(req)));

  app.get('/api/api-keys', admin, async () => ({ data: await auth.listApiKeys() }));
  app.post('/api/api-keys', admin, async (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse(req.body);
    return reply.code(201).send(await auth.createApiKey(name, actorOf(req)));
  });
  app.delete('/api/api-keys/:id', admin, async (req, reply) => {
    await auth.revokeApiKey(idParam.parse(req.params).id, actorOf(req));
    return reply.code(204).send();
  });

  app.get('/api/audit', admin, async (req) => {
    const q = auditQuery.parse(req.query);
    let query = app.deps.db.selectFrom('audit_log').selectAll().orderBy('at', 'desc').orderBy('id', 'desc').limit(q.limit);
    if (q.entity_type) query = query.where('entity_type', '=', q.entity_type);
    if (q.entity_id) query = query.where('entity_id', '=', q.entity_id);
    return { data: await query.execute() };
  });
};
