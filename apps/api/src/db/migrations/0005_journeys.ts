import { sql, type Kysely } from 'kysely';

// Journeys: definitions, enrollments (one run of one contact through a journey) and a step log.
// Events gain `processed_at` so the worker reacts to each event exactly once, after commit, even across restarts.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('journeys')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('draft').check(sql`status in ('draft', 'active', 'paused', 'archived')`))
    .addColumn('definition', 'jsonb', (c) => c.notNull())
    .addColumn('trigger_event', 'text', (c) => c.notNull())
    .addColumn('created_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('activated_at', 'timestamptz')
    .execute();
  await sql`create index journeys_trigger_idx on journeys (trigger_event) where status = 'active'`.execute(db);

  await db.schema
    .createTable('journey_enrollments')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('journey_id', 'uuid', (c) => c.notNull().references('journeys.id').onDelete('cascade'))
    .addColumn('contact_id', 'uuid', (c) => c.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('status', 'text', (c) => c.notNull().check(sql`status in ('active', 'completed', 'exited')`))
    .addColumn('current_step', 'text')
    .addColumn('next_run_at', 'timestamptz')
    .addColumn('waiting_for', 'text') // event name while parked on a wait_for_event step
    .addColumn('context', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('entry_key', 'text')
    .addColumn('exit_reason', 'text')
    .addColumn('entered_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('completed_at', 'timestamptz')
    .execute();
  await sql`create index enrollments_due_idx on journey_enrollments (next_run_at) where status = 'active'`.execute(db);
  await sql`create index enrollments_contact_idx on journey_enrollments (contact_id) where status = 'active'`.execute(db);
  await db.schema.createIndex('enrollments_journey_idx').on('journey_enrollments').columns(['journey_id', 'status']).execute();
  // One active run per contact per entry key (e.g. per appointment).
  await sql`create unique index enrollments_entry_key_idx on journey_enrollments (journey_id, contact_id, entry_key) where status = 'active' and entry_key is not null`.execute(db);

  await db.schema
    .createTable('journey_step_log')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('enrollment_id', 'uuid', (c) => c.notNull().references('journey_enrollments.id').onDelete('cascade'))
    .addColumn('journey_id', 'uuid', (c) => c.notNull().references('journeys.id').onDelete('cascade'))
    .addColumn('step_id', 'text', (c) => c.notNull())
    .addColumn('outcome', 'text', (c) => c.notNull())
    .addColumn('detail', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('step_log_enrollment_idx').on('journey_step_log').columns(['enrollment_id', 'at']).execute();
  await db.schema.createIndex('step_log_journey_idx').on('journey_step_log').columns(['journey_id', 'step_id']).execute();

  await db.schema.alterTable('messages').addColumn('journey_id', 'uuid', (c) => c.references('journeys.id').onDelete('set null')).execute();

  await db.schema.alterTable('events').addColumn('processed_at', 'timestamptz').execute();
  await sql`update events set processed_at = now()`.execute(db); // history before journeys existed never triggers them
  await sql`create index events_unprocessed_idx on events (received_at) where processed_at is null`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('events').dropColumn('processed_at').execute();
  await db.schema.alterTable('messages').dropColumn('journey_id').execute();
  for (const t of ['journey_step_log', 'journey_enrollments', 'journeys']) await db.schema.dropTable(t).execute();
}
