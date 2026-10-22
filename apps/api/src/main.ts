import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/index.ts';
import { migrateToLatest } from './db/migrate.ts';
import { seedDemo } from './demo/seed.ts';

const config = loadConfig();
const db = createDb(config.PE_DATABASE_URL);
await migrateToLatest(db);
const app = await buildApp({ config, db });

if (config.PE_ADMIN_EMAIL && config.PE_ADMIN_PASSWORD && (await app.services.auth.countUsers()) === 0) {
  await app.services.auth.createUser({ email: config.PE_ADMIN_EMAIL, password: config.PE_ADMIN_PASSWORD, role: 'admin', name: 'Administrator' }, { type: 'system', id: 'bootstrap' });
  app.log.info({ email: config.PE_ADMIN_EMAIL }, 'created first admin from PE_ADMIN_EMAIL');
}

if (config.PE_SEED_DEMO && (await seedDemo(app.services))) app.log.info('seeded synthetic demo data (PE_SEED_DEMO)');

const { worker, providers } = app.services;
app.log.info({ mode: config.PE_DELIVERY_MODE, email: providers.email.name, sms: providers.sms.name }, 'delivery providers');
if (config.PE_DELIVERY_MODE === 'live' && (providers.email.name === 'sandbox' || providers.sms.name === 'sandbox')) {
  app.log.warn('live delivery mode, but a channel has no provider credentials and stays in the sandbox');
}
worker.start(config.PE_DISPATCH_INTERVAL_MS);

const shutdown = async () => {
  worker.stop();
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
