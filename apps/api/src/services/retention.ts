// Daily housekeeping: drops rendered message bodies (personal data) after the retention period while keeping
// delivery metadata for reporting, prunes old webhook delivery and integration request logs and expired sessions.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Config } from '../config.ts';
import type { Database } from '../db/schema.ts';
import { audit } from './audit.ts';

const KEY = 'retention.last_run';
const DAY_MS = 86_400_000;

export function createRetentionService(rootDb: Kysely<Database>, config: Config, clock: () => Date) {
  // Takes the caller's transaction when there is one: runIfDue holds a lock on the settings row, and writing
  // that row over a different connection would wait on our own lock forever.
  async function run(db: Kysely<Database> | Transaction<Database> = rootDb) {
    const now = clock();
    const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const bodies = await db.updateTable('messages').set({ body_html: null, body_text: null, subject: null })
      .where('created_at', '<', before(config.PE_MESSAGE_BODY_RETENTION_DAYS))
      .where((eb) => eb.or([eb('body_html', 'is not', null), eb('body_text', 'is not', null)]))
      .where('status', 'not in', ['queued', 'deferred', 'sending']).executeTakeFirst();
    const deliveries = await db.deleteFrom('webhook_deliveries').where('created_at', '<', before(config.PE_WEBHOOK_LOG_RETENTION_DAYS)).where('status', '!=', 'pending').executeTakeFirst();
    const sessions = await db.deleteFrom('sessions').where('expires_at', '<', now).executeTakeFirst();
    const requests = await db.deleteFrom('integration_requests').where('at', '<', before(config.PE_WEBHOOK_LOG_RETENTION_DAYS)).executeTakeFirst();
    const result = {
      message_bodies_cleared: Number(bodies.numUpdatedRows), webhook_deliveries_deleted: Number(deliveries.numDeletedRows),
      sessions_deleted: Number(sessions.numDeletedRows), integration_requests_deleted: Number(requests.numDeletedRows),
    };
    await db.insertInto('app_settings').values({ key: KEY, value: JSON.stringify({ at: now.toISOString(), ...result }), updated_at: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: sql`excluded.value`, updated_at: now })).execute();
    await audit(db, { type: 'system', id: 'retention' }, { action: 'retention.run', details: result });
    return result;
  }

  return {
    run: () => run(),
    /** Worker step: runs at most once a day across all instances (the settings row is locked while checking). */
    async runIfDue() {
      return rootDb.transaction().execute(async (tx) => {
        const row = await tx.selectFrom('app_settings').select('value').where('key', '=', KEY).forUpdate().skipLocked().executeTakeFirst();
        const last = row ? Date.parse(String((row.value as { at?: string }).at ?? '')) : NaN;
        if (!Number.isNaN(last) && clock().getTime() - last < DAY_MS) return null;
        return run(tx);
      });
    },
  };
}
