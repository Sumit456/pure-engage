// Integrations: the console's management API (admin) and the public inbound webhook endpoint.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../errors.ts';
import { actorOf, requireUser } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const requestsQuery = z.object({
  api_key_id: z.string().uuid().optional(),
  integration_id: z.string().uuid().optional(),
  oauth_grant_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  const { integrations } = app.services;
  const admin = { preHandler: requireUser('admin') };

  app.get('/api/integrations/overview', admin, async () => ({
    ...(await integrations.overview()), ai_connections: await app.services.oauth.countActive(), salesforce: await app.services.salesforce.summary(),
    mcp_url: `${app.deps.config.PE_PUBLIC_URL.replace(/\/$/, '')}/mcp`,
  }));
  app.get('/api/integrations/requests', admin, async (req) => {
    const q = requestsQuery.parse(req.query);
    return { data: await integrations.requests({ apiKeyId: q.api_key_id, integrationId: q.integration_id, oauthGrantId: q.oauth_grant_id, limit: q.limit }) };
  });
  app.get('/api/integrations', admin, async () => ({ data: await integrations.list() }));
  app.post('/api/integrations', admin, async (req, reply) => reply.code(201).send(await integrations.create(req.body, actorOf(req))));
  app.get('/api/integrations/:id', admin, async (req) => integrations.get(idParam.parse(req.params).id));
  app.patch('/api/integrations/:id', admin, async (req) => integrations.update(idParam.parse(req.params).id, req.body, actorOf(req)));
  app.delete('/api/integrations/:id', admin, async (req, reply) => { await integrations.remove(idParam.parse(req.params).id, actorOf(req)); return reply.code(204).send(); });
  app.post('/api/integrations/:id/rotate-secret', admin, async (req) => integrations.rotateSecret(idParam.parse(req.params).id, actorOf(req)));
  app.post('/api/integrations/:id/test', { ...admin, bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const { payload } = z.object({ payload: z.unknown() }).parse(req.body);
    const { status, result } = await integrations.test(idParam.parse(req.params).id, payload, actorOf(req));
    return reply.code(status).send(result);
  });

  // Public: any app posts JSON here. The raw body is kept for HMAC verification, so this scope parses JSON itself.
  await app.register(async (hooks) => {
    hooks.removeContentTypeParser('application/json');
    hooks.addContentTypeParser(['application/json', 'text/plain'], { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
    hooks.post('/hooks/in/:id', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
      const parsedId = idParam.safeParse(req.params);
      if (!parsedId.success) throw new HttpError(404, 'Not found');
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const queryToken = (req.query as Record<string, unknown>)?.token;
      try {
        req.integration = await integrations.authenticate(parsedId.data.id, { headers: req.headers, rawBody, queryToken: typeof queryToken === 'string' ? queryToken : undefined });
      } catch (err) {
        // Failed sign-ins to a source that exists are logged against it, so its owner can see why a tool isn't getting through.
        if (err instanceof HttpError && err.statusCode === 401) req.integration = { id: parsedId.data.id, name: '' };
        throw err;
      }
      let payload: unknown;
      try { payload = JSON.parse(rawBody); } catch { throw new HttpError(400, 'Body must be JSON'); }
      const { status, result } = await integrations.receive(parsedId.data.id, payload);
      req.logItems = result.attributes_processed + result.events_processed;
      return reply.code(status).send(result);
    });
  });
};
