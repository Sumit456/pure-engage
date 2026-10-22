import { sql, type Kysely } from 'kysely';

// Outbound webhooks (docs/contracts/platform-webhooks.asyncapi.yaml) and their delivery queue.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('webhooks')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('events', 'jsonb', (c) => c.notNull().defaultTo(sql`'["*"]'::jsonb`))
    .addColumn('secret_encrypted', 'text', (c) => c.notNull())
    .addColumn('enabled', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('created_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('webhook_deliveries')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('webhook_id', 'uuid', (c) => c.notNull().references('webhooks.id').onDelete('cascade'))
    .addColumn('event_name', 'text', (c) => c.notNull())
    .addColumn('payload', 'jsonb', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().check(sql`status in ('pending', 'success', 'failed')`))
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'timestamptz')
    .addColumn('response_code', 'integer')
    .addColumn('error', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`create index webhook_deliveries_due_idx on webhook_deliveries (next_attempt_at) where status = 'pending'`.execute(db);
  await db.schema.createIndex('webhook_deliveries_hook_idx').on('webhook_deliveries').columns(['webhook_id', 'created_at']).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('webhook_deliveries').execute();
  await db.schema.dropTable('webhooks').execute();
}
