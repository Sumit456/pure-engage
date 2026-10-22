// Recreates the test database and migrates it once per test run.
import pg from 'pg';
import { createDb } from '../src/db/index.ts';
import { migrateToLatest } from '../src/db/migrate.ts';

export const TEST_DATABASE_URL = process.env.PE_TEST_DATABASE_URL ?? 'postgres://pure_engage@127.0.0.1:5433/pure_engage_test';

export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9_]*_test$/.test(name)) throw new Error(`Refusing to reset "${name}": test database names must end in _test`);

  const admin = new URL(TEST_DATABASE_URL);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`drop database if exists ${name} with (force)`);
  await client.query(`create database ${name}`);
  await client.end();

  const db = createDb(TEST_DATABASE_URL, { max: 1 });
  await migrateToLatest(db);
  await db.destroy();
}
