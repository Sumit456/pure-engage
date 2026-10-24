import { sql, type Kysely } from 'kysely';

// Templates (versioned, bilingual), the message outbox, tracking events and the suppression list.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('templates')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('channel', 'text', (c) => c.notNull().check(sql`channel in ('email', 'sms')`))
    .addColumn('purpose', 'text', (c) => c.notNull().check(sql`purpose in ('care', 'marketing')`))
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('current_version', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('archived_at', 'timestamptz')
    .execute();

  await db.schema
    .createTable('template_versions')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('template_id', 'uuid', (c) => c.notNull().references('templates.id').onDelete('cascade'))
    .addColumn('version', 'integer', (c) => c.notNull())
    .addColumn('content', 'jsonb', (c) => c.notNull())
    .addColumn('created_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('template_versions_unique', ['template_id', 'version'])
    .execute();

  await db.schema
    .createTable('messages')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('contact_id', 'uuid', (c) => c.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('template_id', 'uuid', (c) => c.references('templates.id').onDelete('set null'))
    .addColumn('template_version', 'integer')
    .addColumn('channel', 'text', (c) => c.notNull())
    .addColumn('purpose', 'text', (c) => c.notNull())
    .addColumn('locale', 'text', (c) => c.notNull())
    .addColumn('to_address', 'text')
    .addColumn('subject', 'text')
    .addColumn('body_html', 'text')
    .addColumn('body_text', 'text')
    .addColumn('status', 'text', (c) => c.notNull().check(sql`status in ('queued', 'deferred', 'sending', 'sent', 'delivered', 'failed', 'suppressed')`))
    .addColumn('status_reason', 'text')
    .addColumn('provider', 'text')
    .addColumn('provider_message_id', 'text')
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'timestamptz')
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('idempotency_key', 'text', (c) => c.unique())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('sent_at', 'timestamptz')
    .addColumn('delivered_at', 'timestamptz')
    .addColumn('opened_at', 'timestamptz')
    .addColumn('clicked_at', 'timestamptz')
    .execute();
  // The dispatcher's work queue.
  await sql`create index messages_due_idx on messages (next_attempt_at) where status in ('queued', 'deferred')`.execute(db);
  await db.schema.createIndex('messages_contact_idx').on('messages').columns(['contact_id', 'created_at']).execute();
  await db.schema.createIndex('messages_created_idx').on('messages').columns(['created_at', 'id']).execute();
  await sql`create index messages_provider_id_idx on messages (provider, provider_message_id) where provider_message_id is not null`.execute(db);

  await db.schema
    .createTable('message_events')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('message_id', 'uuid', (c) => c.notNull().references('messages.id').onDelete('cascade'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('detail', 'text')
    .addColumn('at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('message_events_message_idx').on('message_events').columns(['message_id', 'at']).execute();

  await db.schema
    .createTable('suppressions')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('channel', 'text', (c) => c.notNull())
    .addColumn('address', 'text', (c) => c.notNull())
    .addColumn('reason', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('suppressions_unique', ['channel', 'address'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of ['suppressions', 'message_events', 'messages', 'template_versions', 'templates']) {
    await db.schema.dropTable(t).execute();
  }
}
