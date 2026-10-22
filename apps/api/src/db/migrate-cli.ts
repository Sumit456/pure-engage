// Usage: node src/db/migrate-cli.ts [latest|down]
import { loadConfig } from '../config.ts';
import { createDb } from './index.ts';
import { createMigrator } from './migrate.ts';

const direction = process.argv[2] ?? 'latest';
const db = createDb(loadConfig().PE_DATABASE_URL, { max: 1 });
const migrator = createMigrator(db);
const { error, results } = direction === 'down' ? await migrator.migrateDown() : await migrator.migrateToLatest();
for (const r of results ?? []) console.log(`${r.status.padEnd(7)} ${r.direction.padEnd(4)} ${r.migrationName}`);
if (!results?.length) console.log('nothing to do');
await db.destroy();
if (error) {
  console.error(error);
  process.exit(1);
}
