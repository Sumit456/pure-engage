import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'kysely';
import { ZodError } from 'zod';
import type { Config } from './config.ts';
import type { DB } from './db/index.ts';
import { HttpError } from './errors.ts';
import { createServices, type Services } from './services/index.ts';
import { authRoutes } from './routes/auth.ts';
import { adminRoutes } from './routes/admin.ts';
import { contactRoutes } from './routes/contacts.ts';
import { ingestRoutes } from './routes/ingest.ts';
import { purenetRoutes } from './routes/purenet.ts';
import { templateRoutes } from './routes/templates.ts';
import { messageRoutes } from './routes/messages.ts';
import { publicRoutes } from './routes/public.ts';
import { campaignRoutes, segmentRoutes } from './routes/campaigns.ts';
import { journeyRoutes } from './routes/journeys.ts';
import { reportRoutes } from './routes/reports.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { consoleRoutes } from './routes/console.ts';
import { assetRoutes } from './routes/assets.ts';
import { v1Routes } from './routes/v1.ts';
import { integrationRoutes } from './routes/integrations.ts';
import { oauthRoutes, publicCors } from './routes/oauth.ts';
import { mcpRoutes } from './routes/mcp.ts';
import { salesforceRoutes } from './routes/salesforce.ts';

export interface AppDeps {
  config: Config;
  db: DB;
  /** Overrides for the PureNet connector's environment (tests point it at a fake). */
  purenetEnv?: NodeJS.ProcessEnv;
  /** Injectable clock (tests use it for quiet hours and retries). */
  clock?: () => Date;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    services: Services;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : {
      level: config.PE_LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-pe-token"]', 'res.headers["set-cookie"]'],
      // Query strings are dropped from logged URLs: inbound webhooks may carry their token there.
      serializers: { req: (req) => ({ method: req.method, url: req.url.split('?')[0], host: req.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort }) },
    },
    trustProxy: config.NODE_ENV === 'production',
    bodyLimit: 1024 * 1024,
  });
  app.decorate('deps', deps);
  app.decorate('services', createServices(deps.db, config, {
    ...(deps.clock ? { clock: deps.clock } : {}),
    log: (level, msg, fields) => app.log[level](fields ?? {}, msg),
  }));

  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  // Twilio callbacks and the unsubscribe form post urlencoded bodies.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, details: err.details });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Internal server error' });
  });
  if (!config.PE_CONSOLE_DIR) app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found' }));

  app.addHook('onRequest', publicCors);
  // Integration request log: one metadata row per call made with an API key or to an inbound webhook.
  app.addHook('onSend', async (req, reply, payload) => {
    if ((req.apiKey || req.integration) && reply.statusCode >= 400 && typeof payload === 'string') {
      try { (req as { logError?: string }).logError = String((JSON.parse(payload) as { error?: unknown }).error ?? ''); } catch { /* not JSON */ }
    }
    return payload;
  });
  app.addHook('onResponse', async (req, reply) => {
    if (!req.apiKey && !req.integration) return;
    try {
      await app.services.integrations.log({
        apiKeyId: req.apiKey?.kind === 'api_key' ? req.apiKey.id : null, oauthGrantId: req.apiKey?.kind === 'oauth' ? req.apiKey.id : null,
        integrationId: req.integration?.id ?? null, method: req.method,
        route: req.logRoute ?? req.routeOptions.url ?? req.url.split('?')[0]!, status: reply.raw.statusCode, durationMs: reply.elapsedTime,
        items: req.logItems ?? null, error: (req as { logError?: string }).logError ?? null,
      });
    } catch (err) {
      req.log.warn({ err }, 'could not write integration request log');
    }
  });

  app.get('/healthz', async (_req, reply) => {
    try {
      await sql`select 1`.execute(deps.db);
      return { status: 'ok', db: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'degraded', db: 'unreachable' });
    }
  });

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(contactRoutes);
  await app.register(ingestRoutes);
  await app.register(templateRoutes);
  await app.register(messageRoutes);
  await app.register(publicRoutes);
  await app.register(segmentRoutes);
  await app.register(campaignRoutes);
  await app.register(journeyRoutes);
  await app.register(reportRoutes);
  await app.register(webhookRoutes);
  await app.register(assetRoutes);
  await app.register(v1Routes);
  await app.register(integrationRoutes);
  await app.register(oauthRoutes);
  await app.register(mcpRoutes);
  await app.register(salesforceRoutes);
  if (config.PURENET_WEBHOOK_SECRET) {
    await app.register(purenetRoutes, { webhookSecret: config.PURENET_WEBHOOK_SECRET, env: deps.purenetEnv });
  }

  if (config.PE_CONSOLE_DIR) await app.register(consoleRoutes, { dir: config.PE_CONSOLE_DIR });

  return app;
}
