// Content Builder API: the library listing, folders, content blocks and moving items between folders.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf, requireUser } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

export const contentRoutes: FastifyPluginAsync = async (app) => {
  const { content } = app.services;
  const viewer = { preHandler: requireUser('viewer') };
  const marketer = { preHandler: requireUser('marketer') };

  app.get('/api/content', viewer, async (req) => content.list(req.query));
  app.post('/api/content/move', marketer, async (req) => content.move(req.body, actorOf(req)));

  app.get('/api/folders', viewer, async () => ({ data: await content.folders() }));
  app.post('/api/folders', marketer, async (req, reply) => reply.code(201).send(await content.createFolder(req.body, actorOf(req))));
  app.patch('/api/folders/:id', marketer, async (req) => content.updateFolder(idParam.parse(req.params).id, req.body, actorOf(req)));
  app.delete('/api/folders/:id', marketer, async (req, reply) => { await content.removeFolder(idParam.parse(req.params).id, actorOf(req)); return reply.code(204).send(); });

  app.get('/api/content-blocks', viewer, async () => ({ data: await content.blocks() }));
  app.get('/api/content-blocks/:id', viewer, async (req) => content.block(idParam.parse(req.params).id));
  app.post('/api/content-blocks', marketer, async (req, reply) => reply.code(201).send(await content.createBlock(req.body, actorOf(req))));
  app.put('/api/content-blocks/:id', marketer, async (req) => content.updateBlock(idParam.parse(req.params).id, req.body, actorOf(req)));
  app.delete('/api/content-blocks/:id', marketer, async (req, reply) => { await content.archiveBlock(idParam.parse(req.params).id, actorOf(req)); return reply.code(204).send(); });
};
