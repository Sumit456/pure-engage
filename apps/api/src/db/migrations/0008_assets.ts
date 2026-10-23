import { sql, type Kysely } from 'kysely';

// Images uploaded for email templates. Stored in Postgres (hosts like Render have no persistent disk) and served
// publicly at /a/<id> because email clients fetch them without a session.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('assets')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('content_type', 'text', (c) => c.notNull().check(sql`content_type in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')`))
    .addColumn('size', 'integer', (c) => c.notNull())
    .addColumn('sha256', 'text', (c) => c.notNull())
    .addColumn('width', 'integer')
    .addColumn('height', 'integer')
    .addColumn('data', 'bytea', (c) => c.notNull())
    .addColumn('created_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('assets_created_at_idx').on('assets').column('created_at').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('assets').execute();
}
