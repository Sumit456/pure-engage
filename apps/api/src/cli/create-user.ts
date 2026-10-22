// Create a console user. The password is read from PE_NEW_USER_PASSWORD so it never appears in shell history.
// Usage: PE_NEW_USER_PASSWORD='…' node src/cli/create-user.ts <email> [admin|marketer|viewer] [name]
import { loadConfig } from '../config.ts';
import { createDb } from '../db/index.ts';
import { migrateToLatest } from '../db/migrate.ts';
import { createServices } from '../services/index.ts';

const [email, role = 'admin', ...name] = process.argv.slice(2);
const password = process.env.PE_NEW_USER_PASSWORD;
if (!email || !password) {
  console.error("usage: PE_NEW_USER_PASSWORD='…' node src/cli/create-user.ts <email> [admin|marketer|viewer] [name]");
  process.exit(2);
}

const config = loadConfig();
const db = createDb(config.PE_DATABASE_URL, { max: 1 });
try {
  await migrateToLatest(db);
  const user = await createServices(db, config).auth.createUser(
    { email, password, role: role as 'admin', name: name.join(' ') },
    { type: 'system', id: 'cli' },
  );
  console.log(`created ${user.role} ${user.email}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
