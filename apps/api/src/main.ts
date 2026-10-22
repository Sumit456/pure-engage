import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/index.ts';
import { migrateToLatest } from './db/migrate.ts';

const config = loadConfig();
const db = createDb(config.PE_DATABASE_URL);
await migrateToLatest(db);
const app = await buildApp({ config, db });

if (config.PE_ADMIN_EMAIL && config.PE_ADMIN_PASSWORD && (await app.services.auth.countUsers()) === 0) {
  await app.services.auth.createUser({ email: config.PE_ADMIN_EMAIL, password: config.PE_ADMIN_PASSWORD, role: 'admin', name: 'Administrator' }, { type: 'system', id: 'bootstrap' });
  app.log.info({ email: config.PE_ADMIN_EMAIL }, 'created first admin from PE_ADMIN_EMAIL');
}

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
