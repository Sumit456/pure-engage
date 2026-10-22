import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

export type DB = Kysely<Database>;

export function createDb(connectionString: string, { max = 10 }: { max?: number } = {}): DB {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max }) }),
  });
}
