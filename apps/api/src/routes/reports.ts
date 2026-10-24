import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../plugins/auth.ts';
import { localDate, parseRange, toCsv } from '../services/reports.ts';
import { ACTIVITY_KINDS } from '../services/activity.ts';

const rangeQuery = z.object({ from: z.string().optional(), to: z.string().optional() });
const activityQuery = z.object({
  kinds: z.string().optional().transform((s) => s?.split(',').filter(Boolean)).pipe(z.array(z.enum(ACTIVITY_KINDS)).optional()),
  contact_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

export const reportRoutes: FastifyPluginAsync = async (app) => {
  const { reports } = app.services;
  const viewer = { preHandler: requireUser('viewer') };
  const range = (q: unknown) => { const { from, to } = rangeQuery.parse(q); return parseRange(from, to, now(), tz); };
  const tz = app.deps.config.PE_DEFAULT_TIMEZONE;
  const now = () => app.deps.clock?.() ?? new Date();
  const csv = (name: string, body: string) => ({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store', body });

  app.get('/api/reports/overview', viewer, async () => reports.overview());
  app.get('/api/reports/messages', viewer, async (req) => {
    const r = range(req.query);
    const [days, notSent] = await Promise.all([reports.daily(r), reports.notSentReasons(r)]);
    return { ...r, today: localDate(now(), tz), days, not_sent: notSent };
  });
  app.get('/api/reports/campaigns', viewer, async (req) => ({ data: await reports.campaigns(range(req.query)) }));
  app.get('/api/reports/journeys', viewer, async () => ({ data: await reports.journeys() }));

  // Activity across messages, consent, journeys and events (identifiers and labels only; no bodies or properties).
  app.get('/api/activity', viewer, async (req) => {
    const q = activityQuery.parse(req.query);
    return app.services.activity.list({ kinds: q.kinds, contactId: q.contact_id, limit: q.limit, cursor: q.cursor });
  });

  app.get('/api/reports/messages.csv', viewer, async (req, reply) => {
    const r = range(req.query);
    const days = await reports.daily(r);
    const { body, ...headers } = csv(`messages_${r.from}_${r.to}.csv`, toCsv(['day', 'channel', 'sent', 'delivered', 'opened', 'clicked', 'failed', 'not_sent'], days.map((d) => [d.day, d.channel, d.sent, d.delivered, d.opened, d.clicked, d.failed, d.not_sent])));
    return reply.headers(headers).send(body);
  });
  app.get('/api/reports/campaigns.csv', viewer, async (req, reply) => {
    const r = range(req.query);
    const rows = await reports.campaigns(r);
    const { body, ...headers } = csv(`campaigns_${r.from}_${r.to}.csv`, toCsv(['campaign', 'status', 'channel', 'completed_at', 'targeted', 'sent', 'opened', 'clicked', 'not_sent'], rows.map((c) => [c.name, c.status, c.channel, c.completed_at?.toISOString() ?? null, c.targeted, c.sent, c.opened, c.clicked, c.not_sent])));
    return reply.headers(headers).send(body);
  });

  app.post('/api/admin/retention/run', { preHandler: requireUser('admin') }, async () => app.services.retention.run());
};
