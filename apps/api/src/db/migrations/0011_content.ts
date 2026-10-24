import { sql, type Kysely } from 'kysely';

// Content Builder: folders for everything, a file library beyond images (documents, video, audio), reusable content
// blocks, and push and WhatsApp templates (authored now; sending comes with their providers). File bytes move to
// asset_blobs so listings never read them, behind a storage interface that can later point at object storage.
const TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm', 'audio/mpeg',
  'text/csv', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];
const IMAGE_TYPES = TYPES.slice(0, 4);
const list = (xs: string[]) => sql.raw(xs.map((x) => `'${x}'`).join(', '));

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('content_folders')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('parent_id', 'uuid', (c) => c.references('content_folders.id').onDelete('cascade'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.alterTable('assets')
    .addColumn('kind', 'text', (c) => c.notNull().defaultTo('image').check(sql`kind in ('image', 'document', 'video', 'audio')`))
    .addColumn('folder_id', 'uuid', (c) => c.references('content_folders.id').onDelete('set null'))
    .addColumn('tags', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('storage', 'text', (c) => c.notNull().defaultTo('db'))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`alter table assets drop constraint assets_content_type_check`.execute(db);
  await sql`alter table assets add constraint assets_content_type_check check (content_type in (${list(TYPES)}))`.execute(db);

  await db.schema
    .createTable('asset_blobs')
    .addColumn('asset_id', 'uuid', (c) => c.primaryKey().references('assets.id').onDelete('cascade'))
    .addColumn('data', 'bytea', (c) => c.notNull())
    .execute();
  await sql`insert into asset_blobs (asset_id, data) select id, data from assets`.execute(db);
  await db.schema.alterTable('assets').dropColumn('data').execute();

  await sql`alter table templates drop constraint templates_channel_check`.execute(db);
  await sql`alter table templates add constraint templates_channel_check check (channel in ('email', 'sms', 'push', 'whatsapp'))`.execute(db);
  await db.schema.alterTable('templates')
    .addColumn('folder_id', 'uuid', (c) => c.references('content_folders.id').onDelete('set null'))
    .addColumn('tags', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute();

  await db.schema
    .createTable('content_blocks')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull().check(sql`kind in ('design', 'html', 'text')`))
    .addColumn('content', 'jsonb', (c) => c.notNull())
    .addColumn('folder_id', 'uuid', (c) => c.references('content_folders.id').onDelete('set null'))
    .addColumn('tags', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('created_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('archived_at', 'timestamptz')
    .execute();
}

// Going back drops what the old schema can't hold: non-image files, push and WhatsApp templates, blocks and folders.
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('content_blocks').execute();
  await sql`delete from templates where channel in ('push', 'whatsapp')`.execute(db);
  await db.schema.alterTable('templates').dropColumn('folder_id').dropColumn('tags').execute();
  await sql`alter table templates drop constraint templates_channel_check`.execute(db);
  await sql`alter table templates add constraint templates_channel_check check (channel in ('email', 'sms'))`.execute(db);

  await sql`delete from assets where content_type not in (${list(IMAGE_TYPES)})`.execute(db);
  await db.schema.alterTable('assets').addColumn('data', 'bytea').execute();
  await sql`update assets set data = b.data from asset_blobs b where b.asset_id = assets.id`.execute(db);
  await sql`alter table assets alter column data set not null`.execute(db);
  await db.schema.dropTable('asset_blobs').execute();
  await sql`alter table assets drop constraint assets_content_type_check`.execute(db);
  await sql`alter table assets add constraint assets_content_type_check check (content_type in (${list(IMAGE_TYPES)}))`.execute(db);
  await db.schema.alterTable('assets').dropColumn('kind').dropColumn('folder_id').dropColumn('tags').dropColumn('description').dropColumn('storage').dropColumn('updated_at').execute();
  await db.schema.dropTable('content_folders').execute();
}
