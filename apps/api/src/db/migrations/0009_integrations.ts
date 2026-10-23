import { sql, type Kysely } from 'kysely';

// Integrations: scoped API keys, inbound webhook sources (any app posting JSON, mapped to /track) and a request
// log (metadata only, never payloads) for every call made with a key or to an inbound webhook.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('api_keys')
    .addColumn('scopes', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('expires_at', 'timestamptz')
    .execute();
  // Keys created before scopes existed keep exactly what they could do (LEGACY_SCOPES in packages/shared).
  await sql`update api_keys set scopes = '["contacts:write", "consent:write", "events:write", "messages:send"]'::jsonb`.execute(db);

  await db.schema
    .createTable('integrations')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('kind', 'text', (c) => c.notNull().check(sql`kind in ('inbound_webhook')`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('config', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('secret_encrypted', 'text', (c) => c.notNull())
    .addColumn('enabled', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('created_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz')
    .execute();

  await db.schema
    .createTable('integration_requests')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('api_key_id', 'uuid', (c) => c.references('api_keys.id').onDelete('cascade'))
    .addColumn('integration_id', 'uuid', (c) => c.references('integrations.id').onDelete('cascade'))
    .addColumn('method', 'text', (c) => c.notNull())
    .addColumn('route', 'text', (c) => c.notNull())
    .addColumn('status', 'integer', (c) => c.notNull())
    .addColumn('duration_ms', 'integer', (c) => c.notNull())
    .addColumn('items', 'integer')
    .addColumn('error', 'text')
    .execute();
  await db.schema.createIndex('integration_requests_at_idx').on('integration_requests').column('at').execute();
  await db.schema.createIndex('integration_requests_key_idx').on('integration_requests').columns(['api_key_id', 'at']).execute();
  await db.schema.createIndex('integration_requests_integration_idx').on('integration_requests').columns(['integration_id', 'at']).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('integration_requests').execute();
  await db.schema.dropTable('integrations').execute();
  await db.schema.alterTable('api_keys').dropColumn('scopes').dropColumn('expires_at').execute();
}
