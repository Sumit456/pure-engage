import { sql, type Kysely } from 'kysely';

// Segments (rule trees compiled to SQL) and campaigns (resumable batched fan-out into the outbox).
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('segments')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('rules', 'jsonb', (c) => c.notNull())
    .addColumn('created_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('archived_at', 'timestamptz')
    .execute();

  await db.schema
    .createTable('campaigns')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('template_id', 'uuid', (c) => c.notNull().references('templates.id'))
    .addColumn('segment_id', 'uuid', (c) => c.notNull().references('segments.id'))
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('draft').check(sql`status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled')`))
    .addColumn('scheduled_at', 'timestamptz')
    .addColumn('started_at', 'timestamptz')
    .addColumn('completed_at', 'timestamptz')
    // Fan-out cursor: the last contact id enqueued, so a crashed or paused send resumes where it stopped.
    .addColumn('cursor_contact_id', 'uuid')
    .addColumn('enqueued_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`create index campaigns_due_idx on campaigns (scheduled_at) where status in ('scheduled', 'sending')`.execute(db);

  await db.schema.alterTable('messages').addColumn('campaign_id', 'uuid', (c) => c.references('campaigns.id').onDelete('set null')).execute();
  await sql`create index messages_campaign_idx on messages (campaign_id) where campaign_id is not null`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('messages').dropColumn('campaign_id').execute();
  await db.schema.dropTable('campaigns').execute();
  await db.schema.dropTable('segments').execute();
}
