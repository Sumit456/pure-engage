import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/index.ts';
import { migrateToLatest } from './db/migrate.ts';

const config = loadConfig();
const db = createDb(config.PE_DATABASE_URL);
await migrateToLatest(db);
const app = await buildApp({ config, db });

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
