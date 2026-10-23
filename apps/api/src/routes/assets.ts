import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf, requireUser } from '../plugins/auth.ts';
import { MAX_ASSET_BYTES } from '../services/assets.ts';

const idParam = z.object({ id: z.string().uuid() });
const uploadBody = z.object({ name: z.string().max(255).default('image'), data: z.string().max(Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/=]*$/, 'data must be base64') });

export const assetRoutes: FastifyPluginAsync = async (app) => {
  const { assets } = app.services;
  // Absolute links, because emails are read far away from the console.
  const base = app.deps.config.PE_PUBLIC_URL.replace(/\/+$/, '');
  const withUrl = <T extends { id: string }>(a: T) => ({ ...a, url: `${base}/a/${a.id}` });

  // Base64 in JSON keeps uploads on the same CSRF-protected, typed path as every other console write.
  app.post('/api/assets', { preHandler: requireUser('marketer'), bodyLimit: Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 64 * 1024 }, async (req, reply) => {
    const b = uploadBody.parse(req.body);
    return reply.code(201).send(withUrl(await assets.create({ name: b.name, data: Buffer.from(b.data, 'base64') }, actorOf(req))));
  });
  app.get('/api/assets', { preHandler: requireUser('viewer') }, async () => ({ data: (await assets.list()).map(withUrl) }));
  app.delete('/api/assets/:id', { preHandler: requireUser('marketer') }, async (req, reply) => {
    await assets.remove(idParam.parse(req.params).id, actorOf(req));
    return reply.code(204).send();
  });

  // Public: email clients load these without a session. Ids are random UUIDs; content never changes, so it caches.
  app.get('/a/:id', async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Not found' });
    const file = await assets.file(parsed.data.id);
    return reply
      .header('content-type', file.content_type)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('etag', `"${file.sha256}"`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('content-disposition', 'inline')
      .send(file.data);
  });
};
