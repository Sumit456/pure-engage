// Public API, authenticated by API key: docs/contracts/platform-ingest.openapi.yaml.
import type { FastifyPluginAsync } from 'fastify';
import { actorOf, assertScope, requireApiKey } from '../plugins/auth.ts';

const has = (v: unknown) => Array.isArray(v) && v.length > 0;

export const ingestRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/v1/track', {
    preHandler: requireApiKey(),
    bodyLimit: 2 * 1024 * 1024,
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    // Scopes follow what the request does: attributes write contacts (and consent), events write events.
    const body = (req.body ?? {}) as { attributes?: unknown; events?: unknown };
    if (has(body.attributes)) assertScope(req, 'contacts:write');
    if (has(body.attributes) && (body.attributes as unknown[]).some((a) => typeof a === 'object' && a !== null && 'consent' in a)) assertScope(req, 'consent:write');
    if (has(body.events)) assertScope(req, 'events:write');
    const { status, result } = await app.services.ingest.track(req.body, { source: 'api', actor: actorOf(req) });
    req.logItems = result.attributes_processed + result.events_processed;
    return reply.code(status).send(result);
  });
};
