// PureNet event webhook. The connector verifies the signature on the raw body, de-duplicates and maps the
// event to our /track shape; we feed that into the same ingest service the public API uses.
import type { FastifyPluginAsync } from 'fastify';
import { createPureNetFromEnv, createReceiver } from '@pure-engage/purenet-connector';
import { HttpError } from '../errors.ts';

export const purenetRoutes: FastifyPluginAsync<{ webhookSecret: string; env?: NodeJS.ProcessEnv }> = async (app, opts) => {
  const { client } = createPureNetFromEnv(opts.env ?? process.env);
  const actor = { type: 'integration' as const, id: 'purenet' };

  const handle = createReceiver({
    secret: opts.webhookSecret,
    client,
    // De-duplication happens in Postgres (events.idempotency_key = `purenet:<event id>`), which is shared by
    // every API instance and stays consistent with erasures. A per-process memory would not.
    seen: { has: () => false, add: () => {} },
    sink: async (track) => {
      const { result } = await app.services.ingest.track(track, { source: 'purenet', actor });
      // Item-level validation errors are permanent, so acknowledge and log them rather than asking PureNet to retry.
      if (result.errors.length) app.log.warn({ errors: result.errors }, 'PureNet event partially ingested');
    },
    log: (level, msg, fields) => app.log[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](fields ?? {}, msg),
  });

  // Leave the body unread: the receiver needs the exact raw bytes to check the signature.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, _payload, done) => done(null));

  app.post('/hooks/purenet', { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.hijack();
    try {
      await handle(req.raw, reply.raw);
    } catch (err) {
      app.log.error(err, 'PureNet webhook failed');
      if (!reply.raw.headersSent) reply.raw.writeHead(err instanceof HttpError ? err.statusCode : 500).end();
    }
  });
};
