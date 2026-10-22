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

export interface AppDeps {
  config: Config;
  db: DB;
  /** Overrides for the PureNet connector's environment (tests point it at a fake). */
  purenetEnv?: NodeJS.ProcessEnv;
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
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    trustProxy: config.NODE_ENV === 'production',
    bodyLimit: 1024 * 1024,
  });
  app.decorate('deps', deps);
  app.decorate('services', createServices(deps.db, config));

  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

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
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found' }));

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
  if (config.PURENET_WEBHOOK_SECRET) {
    await app.register(purenetRoutes, { webhookSecret: config.PURENET_WEBHOOK_SECRET, env: deps.purenetEnv });
  }

  return app;
}
