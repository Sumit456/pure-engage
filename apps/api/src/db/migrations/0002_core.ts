import { sql, type Kysely } from 'kysely';

// Users, sessions, API keys, audit log, contacts (with consent history) and events.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('email', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull().check(sql`role in ('admin', 'marketer', 'viewer')`))
    .addColumn('active', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_login_at', 'timestamptz')
    .execute();
  await sql`create unique index users_email_key on users (lower(email))`.execute(db);

  await db.schema
    .createTable('sessions')
    .addColumn('token_hash', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('ip', 'text')
    .addColumn('user_agent', 'text')
    .execute();
  await db.schema.createIndex('sessions_user_idx').on('sessions').column('user_id').execute();

  await db.schema
    .createTable('api_keys')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('prefix', 'text', (c) => c.notNull().unique())
    .addColumn('key_hash', 'text', (c) => c.notNull())
    .addColumn('created_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .execute();

  await db.schema
    .createTable('audit_log')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('actor_type', 'text', (c) => c.notNull().check(sql`actor_type in ('user', 'api_key', 'integration', 'system')`))
    .addColumn('actor_id', 'text')
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('entity_type', 'text')
    .addColumn('entity_id', 'text')
    .addColumn('details', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('ip', 'text')
    .execute();
  await db.schema.createIndex('audit_entity_idx').on('audit_log').columns(['entity_type', 'entity_id', 'at']).execute();
  await db.schema.createIndex('audit_at_idx').on('audit_log').column('at').execute();

  await db.schema
    .createTable('contacts')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('external_id', 'text', (c) => c.unique())
    .addColumn('email', 'text')
    .addColumn('phone', 'text')
    .addColumn('first_name', 'text')
    .addColumn('last_name', 'text')
    .addColumn('preferred_language', 'text')
    .addColumn('timezone', 'text')
    .addColumn('attributes', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('consent', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`create index contacts_email_idx on contacts (lower(email))`.execute(db);
  await sql`create index contacts_phone_idx on contacts (phone)`.execute(db);
  await sql`create index contacts_updated_idx on contacts (updated_at desc, id desc)`.execute(db);

  await db.schema
    .createTable('consent_history')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('contact_id', 'uuid', (c) => c.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('channel', 'text', (c) => c.notNull())
    .addColumn('purpose', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('previous_status', 'text')
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('changed_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('consent_history_contact_idx').on('consent_history').columns(['contact_id', 'changed_at']).execute();

  await db.schema
    .createTable('events')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('contact_id', 'uuid', (c) => c.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('properties', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('occurred_at', 'timestamptz', (c) => c.notNull())
    .addColumn('received_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('idempotency_key', 'text', (c) => c.unique())
    .execute();
  await db.schema.createIndex('events_contact_idx').on('events').columns(['contact_id', 'occurred_at']).execute();
  await db.schema.createIndex('events_name_idx').on('events').columns(['name', 'occurred_at']).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of ['events', 'consent_history', 'contacts', 'audit_log', 'api_keys', 'sessions', 'users']) {
    await db.schema.dropTable(t).execute();
  }
}
