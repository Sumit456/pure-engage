import type { Kysely } from 'kysely';
import type { TrackEvent } from '@pure-engage/shared';
import type { Database, Event } from '../db/schema.ts';
import type { Actor } from './audit.ts';
import type { ContactsService } from './contacts.ts';

export type EventListener = (event: Event) => void | Promise<void>;

export function createEventsService(db: Kysely<Database>, contacts: ContactsService) {
  const listeners: EventListener[] = [];

  return {
    /** Journeys, webhooks etc. subscribe here (later milestones). Called after commit. */
    onEvent(listener: EventListener) { listeners.push(listener); },

    /**
     * Records an event, creating the contact if needed. A repeated idempotency_key returns the
     * original event with `duplicate: true` and nothing is written.
     */
    async track(input: TrackEvent, opts: { source: string; actor: Actor }): Promise<{ event: Event; duplicate: boolean }> {
      const result = await db.transaction().execute(async (tx) => {
        if (input.idempotency_key) {
          const existing = await tx.selectFrom('events').selectAll().where('idempotency_key', '=', input.idempotency_key).executeTakeFirst();
          if (existing) return { event: existing, duplicate: true };
        }
        const { contact } = await contacts.upsertIn(
          tx,
          { contact_id: input.contact_id, external_id: input.external_id, email: input.email },
          opts,
        );
        const inserted = await tx
          .insertInto('events')
          .values({
            contact_id: contact.id,
            name: input.name,
            properties: JSON.stringify(input.properties ?? {}),
            source: opts.source,
            occurred_at: input.time ? new Date(input.time) : new Date(),
            idempotency_key: input.idempotency_key ?? null,
          })
          .onConflict((oc) => oc.column('idempotency_key').doNothing())
          .returningAll()
          .executeTakeFirst();
        if (inserted) return { event: inserted, duplicate: false };
        // A concurrent request inserted the same key between our check and insert.
        const winner = await tx.selectFrom('events').selectAll().where('idempotency_key', '=', input.idempotency_key!).executeTakeFirstOrThrow();
        return { event: winner, duplicate: true };
      });
      if (!result.duplicate) for (const l of listeners) await l(result.event);
      return result;
    },

    async listForContact(contactId: string, { limit = 50, before }: { limit?: number; before?: string | undefined } = {}) {
      let q = db.selectFrom('events').selectAll().where('contact_id', '=', contactId).orderBy('occurred_at', 'desc').orderBy('id', 'desc').limit(Math.min(limit, 200));
      if (before) q = q.where('occurred_at', '<', new Date(before));
      return q.execute();
    },
  };
}

export type EventsService = ReturnType<typeof createEventsService>;
