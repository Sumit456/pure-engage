// Remote MCP endpoint for AI assistants (Streamable HTTP, stateless, JSON responses). Authenticated by an OAuth
// access token (Claude and other assistants connect through the consent screen) or an API key (local tools).
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { actorOf, resolveBearer } from '../plugins/auth.ts';
import { createMcpServer } from '../services/mcp.ts';

/** `tools/call get_overview`: method and tool name only, for the request log. */
function describeCall(body: unknown): string {
  const one = (m: unknown) => {
    const msg = (m ?? {}) as { method?: unknown; params?: { name?: unknown } };
    const method = typeof msg.method === 'string' ? msg.method.slice(0, 60) : '?';
    return method === 'tools/call' && typeof msg.params?.name === 'string' ? `${method} ${msg.params.name.slice(0, 60)}` : method;
  };
  return Array.isArray(body) ? body.map(one).join(', ').slice(0, 150) : one(body);
}

export const mcpRoutes: FastifyPluginAsync = async (app) => {
  const base = app.deps.config.PE_PUBLIC_URL.replace(/\/$/, '');

  app.post('/mcp', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req, reply) => {
    const caller = await resolveBearer(app, req);
    if (!caller) {
      return reply.code(401).header('www-authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`)
        .send({ error: 'Sign in required: connect this assistant from Pure Engage (Integrations → AI assistants)' });
    }
    req.apiKey = caller;
    const server = createMcpServer({ services: app.services, db: app.deps.db, scopes: caller.scopes, actor: actorOf(req), consoleUrl: app.deps.config.consoleUrl });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    req.logRoute = `/mcp ${describeCall(req.body)}`;

    // The transport writes the response itself; headers set so far (security headers, CORS) are copied over by hand.
    // The request log is still written by the app's onResponse hook, from the raw status.
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) reply.raw.setHeader(k, v as string | string[]);
    reply.hijack();
    reply.raw.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless server: no standalone SSE stream and no sessions to end.
  const notAllowed = async (_req: unknown, reply: FastifyReply) => reply.code(405).header('allow', 'POST').send({ error: 'Method not allowed' });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
};
