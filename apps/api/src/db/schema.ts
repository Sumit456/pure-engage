// Table types for Kysely. Keep in step with src/db/migrations/.
import type { ColumnType, Generated, JSONColumnType } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface AppSettingsTable {
  key: string;
  value: JSONColumnType<Record<string, unknown> | unknown[]>;
  updated_at: Generated<Timestamp>;
}

export interface Database {
  app_settings: AppSettingsTable;
}
