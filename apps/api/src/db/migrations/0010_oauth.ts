import { sql, type Kysely } from 'kysely';

// OAuth 2.1 for AI assistants (MCP): apps register themselves (dynamic client registration), an admin approves them
// with chosen permissions in the console, and the app gets short-lived access tokens plus a rotating refresh token.
// Only hashes of codes and tokens are stored.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('oauth_clients')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('redirect_uris', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('oauth_codes')
    .addColumn('code_hash', 'text', (c) => c.primaryKey())
    .addColumn('client_id', 'text', (c) => c.notNull().references('oauth_clients.id').onDelete('cascade'))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('redirect_uri', 'text', (c) => c.notNull())
    .addColumn('code_challenge', 'text', (c) => c.notNull())
    .addColumn('scopes', 'jsonb', (c) => c.notNull())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('used_at', 'timestamptz')
    .execute();

  await db.schema
    .createTable('oauth_grants')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('client_id', 'text', (c) => c.notNull().references('oauth_clients.id').onDelete('cascade'))
    .addColumn('user_id', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('scopes', 'jsonb', (c) => c.notNull())
    .addColumn('access_hash', 'text', (c) => c.notNull().unique())
    .addColumn('access_expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('refresh_hash', 'text', (c) => c.notNull().unique())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .execute();

  await db.schema.alterTable('integration_requests')
    .addColumn('oauth_grant_id', 'uuid', (c) => c.references('oauth_grants.id').onDelete('cascade'))
    .execute();
  await db.schema.createIndex('integration_requests_grant_idx').on('integration_requests').columns(['oauth_grant_id', 'at']).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('integration_requests').dropColumn('oauth_grant_id').execute();
  await db.schema.dropTable('oauth_grants').execute();
  await db.schema.dropTable('oauth_codes').execute();
  await db.schema.dropTable('oauth_clients').execute();
}
