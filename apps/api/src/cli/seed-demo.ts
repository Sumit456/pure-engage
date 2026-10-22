// Seed synthetic demo data into an empty database (the same data PE_SEED_DEMO=true creates at startup).
// Usage: node src/cli/seed-demo.ts
import { loadConfig } from '../config.ts';
import { createDb } from '../db/index.ts';
import { migrateToLatest } from '../db/migrate.ts';
import { seedDemo } from '../demo/seed.ts';
import { createServices } from '../services/index.ts';

const config = loadConfig();
const db = createDb(config.PE_DATABASE_URL, { max: 1 });
try {
  await migrateToLatest(db);
  const seeded = await seedDemo(createServices(db, config));
  console.log(seeded ? 'Seeded demo data. The worker sends the campaign and journey messages (to the sandbox) once the API is running.' : 'Contacts already exist; nothing seeded.');
} finally {
  await db.destroy();
}
