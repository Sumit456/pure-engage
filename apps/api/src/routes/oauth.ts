// OAuth for AI assistants (MCP authorization): discovery metadata, dynamic client registration, the authorize
// redirect to the console's consent screen, the token endpoint, and the console API behind the consent screen.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AI_SCOPES } from '@pure-engage/shared';
import { actorOf, requireUser } from '../plugins/auth.ts';
import { OAuthError, type AuthorizeParams } from '../services/oauth.ts';
import { notFound } from '../errors.ts';

const authorizeQuery = z.object({
  response_type: z.string().optional(), client_id: z.string().max(200).optional(), redirect_uri: z.string().max(2000).optional(),
  code_challenge: z.string().max(200).optional(), code_challenge_method: z.string().max(20).optional(),
  scope: z.string().max(1000).optional(), state: z.string().max(1000).optional(), resource: z.string().max(2000).optional(),
}).passthrough();

const sendOAuthError = (reply: FastifyReply, err: unknown) => {
  if (err instanceof OAuthError) return reply.code(err.status).header('cache-control', 'no-store').send({ error: err.code, error_description: err.message });
  throw err;
};

/** Endpoints that browser-based MCP clients call cross-origin. They use bearer tokens, never cookies. */
export const PUBLIC_CORS_PATHS = [/^\/\.well-known\//, /^\/oauth\/(register|token)$/, /^\/mcp$/];

/** Root-level onRequest hook: CORS for the public OAuth and MCP endpoints only (the console API stays same-origin). */
export async function publicCors(req: FastifyRequest, reply: FastifyReply) {
  const path = req.url.split('?')[0]!;
  if (!PUBLIC_CORS_PATHS.some((re) => re.test(path))) return;
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-expose-headers', 'www-authenticate, mcp-session-id');
  if (req.method === 'OPTIONS') {
    return reply.code(204).header('access-control-allow-methods', 'GET, POST, OPTIONS')
      .header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id').header('access-control-max-age', '600').send();
  }
}

export const oauthRoutes: FastifyPluginAsync = async (app) => {
  const { oauth } = app.services;
  const base = app.deps.config.PE_PUBLIC_URL.replace(/\/$/, '');
  const admin = { preHandler: requireUser('admin') };

  const resourceMetadata = {
    resource: `${base}/mcp`,
    resource_name: 'Pure Engage',
    authorization_servers: [base],
    scopes_supported: AI_SCOPES,
    bearer_methods_supported: ['header'],
  };
  app.get('/.well-known/oauth-protected-resource', async () => resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', async () => resourceMetadata);
  app.get('/.well-known/oauth-authorization-server', async () => ({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: AI_SCOPES,
  }));

  app.post('/oauth/register', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    try { return reply.code(201).header('cache-control', 'no-store').send(await oauth.register(req.body)); } catch (err) { return sendOAuthError(reply, err); }
  });

  // The browser lands here from the AI app; the console signs the admin in and asks them to approve.
  app.get('/oauth/authorize', async (req, reply) => {
    const q = authorizeQuery.parse(req.query);
    try { await oauth.describe(q); } catch (err) {
      if (err instanceof OAuthError) return reply.code(400).type('text/plain').send(`This connection request is not valid: ${err.message}`);
      throw err;
    }
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => typeof v === 'string') as [string, string][]);
    return reply.redirect(`${app.deps.config.consoleUrl}/connect/authorize?${params}`);
  });

  app.post('/oauth/token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    try { return reply.header('cache-control', 'no-store').send(await oauth.token((req.body ?? {}) as Record<string, unknown>)); } catch (err) { return sendOAuthError(reply, err); }
  });

  // ---------- console (admin session) ----------

  app.get('/api/oauth/describe', admin, async (req, reply) => {
    try { return await oauth.describe(authorizeQuery.parse(req.query)); } catch (err) {
      if (err instanceof OAuthError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/oauth/decide', admin, async (req, reply) => {
    const body = authorizeQuery.extend({ approve: z.boolean(), scopes: z.array(z.string()).optional() }).parse(req.body);
    try { return await oauth.decide(body as AuthorizeParams & { approve: boolean; scopes?: unknown }, { type: 'user', id: req.user!.id, ip: req.ip }); } catch (err) {
      if (err instanceof OAuthError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/oauth/grants', admin, async () => ({ data: await oauth.grants() }));
  app.delete('/api/oauth/grants/:id', admin, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await oauth.revoke(id, actorOf(req)))) throw notFound('Connection');
    return reply.code(204).send();
  });
};
