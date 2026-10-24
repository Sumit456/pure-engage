import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';

export type Actor =
  | { type: 'user'; id: string; ip?: string | null }
  | { type: 'api_key'; id: string; ip?: string | null }
  | { type: 'integration'; id: string }
  | { type: 'system'; id?: string };

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  /** Never put PHI values here: record which fields changed, not what they changed to. */
  details?: Record<string, unknown>;
}

export async function audit(db: Kysely<Database>, actor: Actor, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      actor_type: actor.type,
      actor_id: actor.id ?? null,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      details: JSON.stringify(entry.details ?? {}),
      ip: 'ip' in actor ? (actor.ip ?? null) : null,
    })
    .execute();
}
