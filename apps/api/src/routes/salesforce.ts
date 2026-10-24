// Salesforce connector (ADR-0009): the console's admin API and the OAuth callback the admin's browser returns to.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf, requireUser, SESSION_COOKIE } from '../plugins/auth.ts';
import { roleAtLeast } from '../services/auth.ts';

const callbackQuery = z.object({
  code: z.string().max(2000).optional(), state: z.string().max(200).optional(),
  error: z.string().max(200).optional(), error_description: z.string().max(1000).optional(),
}).passthrough();
const outboxQuery = z.object({ status: z.enum(['pending', 'sent', 'failed']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

export const salesforceRoutes: FastifyPluginAsync = async (app) => {
  const { salesforce } = app.services;
  const admin = { preHandler: requireUser('admin') };

  app.get('/api/salesforce', admin, async () => salesforce.get());
  app.put('/api/salesforce/config', admin, async (req) => salesforce.saveConfig(req.body, actorOf(req)));
  app.patch('/api/salesforce/settings', admin, async (req) => salesforce.updateSettings(req.body, actorOf(req)));
  app.post('/api/salesforce/connect', admin, async (req) => salesforce.startConnect(req.user!, req.cookies[SESSION_COOKIE]!));
  app.get('/api/salesforce/describe/:object', admin, async (req) => salesforce.describe(z.object({ object: z.string().max(40) }).parse(req.params).object));
  app.post('/api/salesforce/sync', admin, async (req) => salesforce.syncNow(actorOf(req)));
  app.delete('/api/salesforce/connection', admin, async (req) => salesforce.disconnect(actorOf(req)));
  app.get('/api/salesforce/outbox', admin, async (req) => {
    const q = outboxQuery.parse(req.query);
    return { data: await salesforce.outbox({ status: q.status, limit: q.limit }) };
  });
  app.post('/api/salesforce/outbox/:id/retry', admin, async (req) => salesforce.retry(z.object({ id: z.string().uuid() }).parse(req.params).id, actorOf(req)));

  // Salesforce sends the browser back here. The session cookie (SameSite=Lax) comes with this top-level navigation;
  // the state must belong to this very session, so a link from someone else can't attach their org.
  app.get('/oauth/salesforce/callback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = callbackQuery.parse(req.query);
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await app.services.auth.userForToken(token) : null;
    const session = token && user && roleAtLeast(user.role, 'admin') ? { token, userId: user.id } : null;
    const to = await salesforce.completeConnect({ code: q.code, state: q.state, error: q.error }, session);
    return reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').redirect(to);
  });
};
