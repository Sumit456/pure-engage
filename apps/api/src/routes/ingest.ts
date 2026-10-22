// Public API, authenticated by API key: docs/contracts/platform-ingest.openapi.yaml.
import type { FastifyPluginAsync } from 'fastify';
import { actorOf, requireApiKey } from '../plugins/auth.ts';

export const ingestRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/v1/track', {
    preHandler: requireApiKey,
    bodyLimit: 2 * 1024 * 1024,
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { status, result } = await app.services.ingest.track(req.body, { source: 'api', actor: actorOf(req) });
    return reply.code(status).send(result);
  });
};
