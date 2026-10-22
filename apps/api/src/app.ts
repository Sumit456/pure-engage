import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { sql } from 'kysely';
import type { Config } from './config.ts';
import type { DB } from './db/index.ts';

export interface AppDeps {
  config: Config;
  db: DB;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.config.NODE_ENV === 'test' ? false : { level: deps.config.PE_LOG_LEVEL },
    trustProxy: deps.config.NODE_ENV === 'production',
  });
  app.decorate('deps', deps);
  await app.register(helmet);

  app.get('/healthz', async (_req, reply) => {
    try {
      await sql`select 1`.execute(deps.db);
      return { status: 'ok', db: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'degraded', db: 'unreachable' });
    }
  });

  return app;
}
