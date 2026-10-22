// Table types for Kysely. Keep in step with src/db/migrations/.
import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable } from 'kysely';
import type { ConsentMap } from '@pure-engage/shared';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T extends object | null> = JSONColumnType<T, T | string, T | string>;

export type Role = 'admin' | 'marketer' | 'viewer';

export interface AppSettingsTable {
  key: string;
  value: JSONColumnType<Record<string, unknown> | unknown[]>;
  updated_at: Timestamp;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: Generated<string>;
  password_hash: string;
  role: Role;
  active: Generated<boolean>;
  created_at: Timestamp;
  last_login_at: NullableTimestamp;
}

export interface SessionsTable {
  token_hash: string;
  user_id: string;
  created_at: Timestamp;
  last_seen_at: Timestamp;
  expires_at: Timestamp;
  ip: string | null;
  user_agent: string | null;
}

export interface ApiKeysTable {
  id: Generated<string>;
  name: string;
  prefix: string;
  key_hash: string;
  created_by: string | null;
  created_at: Timestamp;
  last_used_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
}

export interface AuditLogTable {
  id: Generated<string>;
  at: Timestamp;
  actor_type: 'user' | 'api_key' | 'integration' | 'system';
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: ColumnType<Record<string, unknown>, Record<string, unknown> | string | undefined, Record<string, unknown> | string>;
  ip: string | null;
}

export interface ContactsTable {
  id: Generated<string>;
  external_id: string | null;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  preferred_language: string | null;
  timezone: string | null;
  attributes: ColumnType<Record<string, unknown>, Record<string, unknown> | string | undefined, Record<string, unknown> | string>;
  consent: ColumnType<ConsentMap, ConsentMap | string | undefined, ConsentMap | string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ConsentHistoryTable {
  id: Generated<string>;
  contact_id: string;
  channel: string;
  purpose: string;
  status: string;
  previous_status: string | null;
  source: string;
  changed_at: Timestamp;
}

export interface EventsTable {
  id: Generated<string>;
  contact_id: string;
  name: string;
  properties: Json<Record<string, unknown>>;
  source: string;
  occurred_at: Timestamp;
  received_at: Timestamp;
  idempotency_key: string | null;
}

export interface Database {
  app_settings: AppSettingsTable;
  users: UsersTable;
  sessions: SessionsTable;
  api_keys: ApiKeysTable;
  audit_log: AuditLogTable;
  contacts: ContactsTable;
  consent_history: ConsentHistoryTable;
  events: EventsTable;
}

export type User = Selectable<UsersTable>;
export type Contact = Selectable<ContactsTable>;
export type NewContact = Insertable<ContactsTable>;
export type Event = Selectable<EventsTable>;
