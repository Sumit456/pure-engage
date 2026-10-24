// Activity feed: one newest-first stream across message events, consent changes, journey runs and contact events,
// for the dashboard and the contact timeline. Items carry identifiers and labels only, never message bodies or
// event properties.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import { badRequest } from '../errors.ts';

export const ACTIVITY_KINDS = ['message', 'consent', 'journey', 'event'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  /** e.g. `message.open`, `consent.changed`, `journey.entered`, `event.received`. */
  type: string;
  at: Date;
  contact: { id: string; name: string | null; external_id: string | null } | null;
  data: Record<string, unknown>;
}

export interface ActivityQuery {
  kinds?: ActivityKind[] | undefined;
  contactId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

const encodeCursor = (at: Date, id: string) => Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
function decodeCursor(cursor: string): { at: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const date = new Date(at ?? '');
  if (!id || Number.isNaN(date.getTime())) throw badRequest('Invalid cursor');
  return { at: date, id };
}

export function createActivityService(db: Kysely<Database>) {
  return {
    async list({ kinds = [...ACTIVITY_KINDS], contactId, limit = 50, cursor }: ActivityQuery) {
      const after = cursor ? decodeCursor(cursor) : null;
      const byContact = (col: string) => (contactId ? sql`and ${sql.ref(col)} = ${contactId}` : sql``);
      const parts = [];
      if (kinds.includes('message')) {
        parts.push(sql`
          select me.id::text as id, 'message' as kind, 'message.' || me.type as type, me.at, m.contact_id,
            jsonb_build_object('message_id', m.id, 'channel', m.channel, 'purpose', m.purpose, 'template', t.name,
              'campaign_id', m.campaign_id, 'journey_id', m.journey_id) as data
          from message_events me join messages m on m.id = me.message_id left join templates t on t.id = m.template_id
          where true ${byContact('m.contact_id')}`);
      }
      if (kinds.includes('consent')) {
        parts.push(sql`
          select ch.id::text, 'consent', 'consent.changed', ch.changed_at, ch.contact_id,
            jsonb_build_object('channel', ch.channel, 'purpose', ch.purpose, 'status', ch.status,
              'previous_status', ch.previous_status, 'source', ch.source)
          from consent_history ch where true ${byContact('ch.contact_id')}`);
      }
      if (kinds.includes('journey')) {
        parts.push(sql`
          select je.id::text || ':in', 'journey', 'journey.entered', je.entered_at, je.contact_id,
            jsonb_build_object('journey_id', j.id, 'journey', j.name)
          from journey_enrollments je join journeys j on j.id = je.journey_id where true ${byContact('je.contact_id')}
          union all
          select je.id::text || ':out', 'journey', 'journey.' || je.status, je.completed_at, je.contact_id,
            jsonb_build_object('journey_id', j.id, 'journey', j.name, 'exit_reason', je.exit_reason)
          from journey_enrollments je join journeys j on j.id = je.journey_id
          where je.completed_at is not null ${byContact('je.contact_id')}`);
      }
      if (kinds.includes('event')) {
        parts.push(sql`
          select e.id::text, 'event', 'event.received', e.occurred_at, e.contact_id,
            jsonb_build_object('name', e.name, 'source', e.source)
          from events e where true ${byContact('e.contact_id')}`);
      }
      if (!parts.length) return { data: [] as ActivityItem[], next_cursor: null };

      const rows = await sql<{ id: string; kind: ActivityKind; type: string; at: Date; contact_id: string | null; data: Record<string, unknown>; first_name: string | null; last_name: string | null; external_id: string | null }>`
        select a.*, c.first_name, c.last_name, c.external_id
        from (${sql.join(parts, sql` union all `)}) as a (id, kind, type, at, contact_id, data)
        left join contacts c on c.id = a.contact_id
        ${after ? sql`where (a.at, a.id) < (${after.at}, ${after.id})` : sql``}
        order by a.at desc, a.id desc
        limit ${limit + 1}`.execute(db);

      const items = rows.rows.slice(0, limit).map((r): ActivityItem => ({
        id: r.id, kind: r.kind, type: r.type, at: new Date(r.at), data: r.data,
        contact: r.contact_id ? { id: r.contact_id, external_id: r.external_id, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null } : null,
      }));
      const last = items[items.length - 1];
      return { data: items, next_cursor: rows.rows.length > limit && last ? encodeCursor(last.at, last.id) : null };
    },
  };
}

export type ActivityService = ReturnType<typeof createActivityService>;
