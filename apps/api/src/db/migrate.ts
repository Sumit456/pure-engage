import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileMigrationProvider, Migrator, type Kysely, type MigrationResultSet } from 'kysely';

const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function createMigrator(db: Kysely<any>): Migrator {
  return new Migrator({ db, provider: new FileMigrationProvider({ fs, path, migrationFolder: folder }) });
}

export async function migrateToLatest(db: Kysely<any>): Promise<MigrationResultSet> {
  const result = await createMigrator(db).migrateToLatest();
  if (result.error) throw result.error;
  return result;
}
