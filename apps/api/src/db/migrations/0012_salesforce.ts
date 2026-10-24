import { sql, type Kysely } from 'kysely';

// Salesforce CRM connector (ADR-0009). The connection is an `integrations` row of kind `salesforce` (its consumer
// secret, encrypted, is the row's secret), so it shares the request log. Tokens, mapping and sync state live in
// salesforce_connections; the pending OAuth handshakes in salesforce_oauth_states (hashes and encrypted values
// only); activity and opt-outs on their way to Salesforce in salesforce_outbox.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table integrations drop constraint integrations_kind_check`.execute(db);
  await sql`alter table integrations add constraint integrations_kind_check check (kind in ('inbound_webhook', 'salesforce'))`.execute(db);

  await db.schema
    .createTable('salesforce_connections')
    .addColumn('integration_id', 'uuid', (c) => c.primaryKey().references('integrations.id').onDelete('cascade'))
    .addColumn('login_host', 'text', (c) => c.notNull())
    .addColumn('consumer_key', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('not_connected').check(sql`status in ('not_connected', 'connected', 'error')`))
    .addColumn('refresh_token_encrypted', 'text')
    .addColumn('access_token_encrypted', 'text')
    .addColumn('instance_url', 'text')
    .addColumn('org_id', 'text')
    .addColumn('sf_user_id', 'text')
    .addColumn('username', 'text')
    .addColumn('connected_at', 'timestamptz')
    .addColumn('connected_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('settings', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    // Written only by the pull that holds the lease: per-object SystemModstamp cursors, and the last run's counts.
    .addColumn('pull_state', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('last_run', 'jsonb')
    .addColumn('last_error', 'text')
    .addColumn('last_sync_at', 'timestamptz')
    .addColumn('next_sync_at', 'timestamptz')
    .addColumn('lease_until', 'timestamptz')
    // Keyset cursors of the push pump (message_events.id and consent_history.id).
    .addColumn('push_event_cursor', 'bigint')
    .addColumn('push_consent_cursor', 'bigint')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('salesforce_oauth_states')
    .addColumn('state_hash', 'text', (c) => c.primaryKey())
    .addColumn('integration_id', 'uuid', (c) => c.notNull().references('integrations.id').onDelete('cascade'))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('session_hash', 'text', (c) => c.notNull())
    .addColumn('verifier_encrypted', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('salesforce_outbox')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('integration_id', 'uuid', (c) => c.notNull().references('integrations.id').onDelete('cascade'))
    .addColumn('kind', 'text', (c) => c.notNull().check(sql`kind in ('task', 'opt_out')`))
    .addColumn('source_key', 'text', (c) => c.notNull())
    .addColumn('contact_id', 'uuid', (c) => c.references('contacts.id').onDelete('cascade'))
    .addColumn('sf_object', 'text', (c) => c.notNull())
    .addColumn('sf_id', 'text', (c) => c.notNull())
    .addColumn('payload', 'jsonb', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending').check(sql`status in ('pending', 'sent', 'failed')`))
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'timestamptz')
    .addColumn('error', 'text')
    .addColumn('sf_record_id', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('salesforce_outbox_source_key', ['integration_id', 'source_key'])
    .execute();
  await db.schema.createIndex('salesforce_outbox_due_idx').on('salesforce_outbox').columns(['status', 'next_attempt_at']).execute();
  await db.schema.createIndex('salesforce_outbox_integration_idx').on('salesforce_outbox').columns(['integration_id', 'created_at']).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('salesforce_outbox').execute();
  await db.schema.dropTable('salesforce_oauth_states').execute();
  await db.schema.dropTable('salesforce_connections').execute();
  await sql`delete from integrations where kind = 'salesforce'`.execute(db);
  await sql`alter table integrations drop constraint integrations_kind_check`.execute(db);
  await sql`alter table integrations add constraint integrations_kind_check check (kind in ('inbound_webhook'))`.execute(db);
}
