// Aggregate reporting. Everything here is counts; no report returns personal data.
import { sql, type Kysely } from 'kysely';
import type { Config } from '../config.ts';
import type { Database } from '../db/schema.ts';
import { badRequest } from '../errors.ts';

export interface DayRow { day: string; channel: 'email' | 'sms'; sent: number; delivered: number; opened: number; clicked: number; failed: number; not_sent: number }

const DAY_MS = 86_400_000;

/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
export const localDate = (d: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/**
 * Validates an inclusive [from, to] date range (YYYY-MM-DD), at most 366 days. "Today" is taken in the reporting
 * time zone, the same one days are bucketed in: in UTC, Dubai's evening messages would fall after the range.
 */
export function parseRange(from: string | undefined, to: string | undefined, now: Date, timeZone = 'UTC'): { from: string; to: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const end = to ?? localDate(now, timeZone);
  const start = from ?? iso(new Date(new Date(`${end}T00:00:00Z`).getTime() - 29 * DAY_MS));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw badRequest('Dates must be YYYY-MM-DD');
  const span = (Date.parse(end) - Date.parse(start)) / DAY_MS;
  if (Number.isNaN(span) || span < 0) throw badRequest('"from" must be on or before "to"');
  if (span > 366) throw badRequest('The range can be at most 366 days');
  return { from: start, to: end };
}

/** CSV with formula-injection protection (cells starting with = + - @ are prefixed with '). */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function createReportsService(db: Kysely<Database>, config: Config, clock: () => Date) {
  const tz = config.PE_DEFAULT_TIMEZONE;
  const localDay = (col: string) => sql<string>`to_char((${sql.ref(col)} at time zone ${tz})::date, 'YYYY-MM-DD')`;

  return {
    async overview() {
      const now = clock();
      const since = new Date(now.getTime() - 30 * DAY_MS);
      const [contacts, consent, msgs, runs, campaigns] = await Promise.all([
        db.selectFrom('contacts').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
        db.selectFrom('contacts').select([
          sql<string>`count(*) filter (where consent->'email'->>'care' = 'granted')`.as('email_care'),
          sql<string>`count(*) filter (where consent->'sms'->>'care' = 'granted')`.as('sms_care'),
          sql<string>`count(*) filter (where consent->'email'->>'marketing' = 'granted')`.as('email_marketing'),
          sql<string>`count(*) filter (where consent->'sms'->>'marketing' = 'granted')`.as('sms_marketing'),
        ]).executeTakeFirstOrThrow(),
        db.selectFrom('messages').select([
          sql<string>`count(*) filter (where status in ('sent', 'delivered'))`.as('sent'),
          sql<string>`count(*) filter (where status = 'suppressed')`.as('not_sent'),
          sql<string>`count(*) filter (where status = 'failed')`.as('failed'),
          sql<string>`count(*) filter (where channel = 'email' and status in ('sent', 'delivered'))`.as('email_sent'),
          sql<string>`count(*) filter (where channel = 'email' and opened_at is not null)`.as('email_opened'),
          sql<string>`count(*) filter (where channel = 'email' and clicked_at is not null)`.as('email_clicked'),
        ]).where('created_at', '>=', since).executeTakeFirstOrThrow(),
        db.selectFrom('journey_enrollments').select([
          sql<string>`count(*) filter (where status = 'active')`.as('active'),
          sql<string>`count(*) filter (where entered_at >= ${since})`.as('entered'),
        ]).executeTakeFirstOrThrow(),
        db.selectFrom('campaigns').select((eb) => eb.fn.countAll<string>().as('n')).where('status', '=', 'sent').where('completed_at', '>=', since).executeTakeFirstOrThrow(),
      ]);
      const n = (v: string | number) => Number(v);
      const emailSent = n(msgs.email_sent);
      return {
        window_days: 30,
        contacts: n(contacts.n),
        consent: { email_care: n(consent.email_care), sms_care: n(consent.sms_care), email_marketing: n(consent.email_marketing), sms_marketing: n(consent.sms_marketing) },
        messages: { sent: n(msgs.sent), not_sent: n(msgs.not_sent), failed: n(msgs.failed) },
        email: { sent: emailSent, open_rate: emailSent ? n(msgs.email_opened) / emailSent : null, click_rate: emailSent ? n(msgs.email_clicked) / emailSent : null },
        journeys: { active_runs: n(runs.active), entered: n(runs.entered) },
        campaigns_sent: n(campaigns.n),
      };
    },

    /** One row per day per channel in the platform time zone, zero-filled. */
    async daily(range: { from: string; to: string }): Promise<DayRow[]> {
      const rows = await db.selectFrom('messages')
        .select([
          localDay('messages.created_at').as('day'), 'channel',
          sql<string>`count(*) filter (where status in ('sent', 'delivered'))`.as('sent'),
          sql<string>`count(*) filter (where status = 'delivered')`.as('delivered'),
          sql<string>`count(*) filter (where opened_at is not null)`.as('opened'),
          sql<string>`count(*) filter (where clicked_at is not null)`.as('clicked'),
          sql<string>`count(*) filter (where status = 'failed')`.as('failed'),
          sql<string>`count(*) filter (where status = 'suppressed')`.as('not_sent'),
        ])
        .where(sql<boolean>`(created_at at time zone ${tz})::date between ${range.from}::date and ${range.to}::date`)
        .groupBy([sql`1`, 'channel']).execute();
      const byKey = new Map(rows.map((r) => [`${r.day}|${r.channel}`, r]));
      const out: DayRow[] = [];
      for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= Date.parse(`${range.to}T00:00:00Z`); t += DAY_MS) {
        const day = new Date(t).toISOString().slice(0, 10);
        for (const channel of ['email', 'sms'] as const) {
          const r = byKey.get(`${day}|${channel}`);
          out.push({ day, channel, sent: Number(r?.sent ?? 0), delivered: Number(r?.delivered ?? 0), opened: Number(r?.opened ?? 0), clicked: Number(r?.clicked ?? 0), failed: Number(r?.failed ?? 0), not_sent: Number(r?.not_sent ?? 0) });
        }
      }
      return out;
    },

    async notSentReasons(range: { from: string; to: string }) {
      const rows = await db.selectFrom('messages').select(['status_reason', (eb) => eb.fn.countAll<string>().as('n')])
        .where('status', '=', 'suppressed')
        .where(sql<boolean>`(created_at at time zone ${tz})::date between ${range.from}::date and ${range.to}::date`)
        .groupBy('status_reason').orderBy('n', 'desc').execute();
      return rows.map((r) => ({ reason: r.status_reason ?? 'unknown', count: Number(r.n) }));
    },

    async campaigns(range: { from: string; to: string }) {
      return db.selectFrom('campaigns').innerJoin('templates', 'templates.id', 'campaigns.template_id')
        .leftJoin('messages', (j) => j.onRef('messages.campaign_id', '=', 'campaigns.id').on('messages.source', '=', 'campaign'))
        .select([
          'campaigns.id', 'campaigns.name', 'campaigns.status', 'campaigns.completed_at', 'templates.channel',
          sql<string>`count(messages.id)`.as('targeted'),
          sql<string>`count(messages.id) filter (where messages.status in ('sent', 'delivered'))`.as('sent'),
          sql<string>`count(messages.id) filter (where messages.opened_at is not null)`.as('opened'),
          sql<string>`count(messages.id) filter (where messages.clicked_at is not null)`.as('clicked'),
          sql<string>`count(messages.id) filter (where messages.status = 'suppressed')`.as('not_sent'),
        ])
        .where('campaigns.status', 'in', ['sending', 'sent', 'cancelled'])
        .where(sql<boolean>`(coalesce(campaigns.started_at, campaigns.created_at) at time zone ${tz})::date between ${range.from}::date and ${range.to}::date`)
        .groupBy(['campaigns.id', 'templates.channel']).orderBy('campaigns.completed_at', 'desc').execute()
        .then((rows) => rows.map((r) => ({ ...r, targeted: Number(r.targeted), sent: Number(r.sent), opened: Number(r.opened), clicked: Number(r.clicked), not_sent: Number(r.not_sent) })));
    },

    async journeys() {
      const rows = await db.selectFrom('journeys')
        .leftJoin('journey_enrollments', 'journey_enrollments.journey_id', 'journeys.id')
        .select([
          'journeys.id', 'journeys.name', 'journeys.status',
          sql<string>`count(journey_enrollments.id)`.as('runs'),
          sql<string>`count(journey_enrollments.id) filter (where journey_enrollments.status = 'active')`.as('active'),
          sql<string>`count(journey_enrollments.id) filter (where journey_enrollments.status = 'completed')`.as('completed'),
          sql<string>`count(journey_enrollments.id) filter (where journey_enrollments.status = 'exited')`.as('exited'),
        ])
        .where('journeys.status', '!=', 'archived').groupBy('journeys.id').orderBy('journeys.name').execute();
      return rows.map((r) => ({ ...r, runs: Number(r.runs), active: Number(r.active), completed: Number(r.completed), exited: Number(r.exited) }));
    },
  };
}

export type ReportsService = ReturnType<typeof createReportsService>;
