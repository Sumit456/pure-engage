// Table types for Kysely. Keep in step with src/db/migrations/.
import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable } from 'kysely';
import type { ConsentMap, SegmentRules } from '@pure-engage/shared';

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

export type TemplateChannel = 'email' | 'sms';
export type MessagePurpose = 'care' | 'marketing';
export type Locale = 'en' | 'ar';

export interface EmailContent { subject: string; html: string; text?: string | undefined }
export interface SmsContent { body: string }
/** One entry per locale; `en` is required, `ar` optional (falls back to `en`). */
export type TemplateContent = { en: EmailContent | SmsContent; ar?: EmailContent | SmsContent | undefined };

export interface TemplatesTable {
  id: Generated<string>;
  name: string;
  channel: TemplateChannel;
  purpose: MessagePurpose;
  description: Generated<string>;
  current_version: Generated<number>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: NullableTimestamp;
}

export interface TemplateVersionsTable {
  id: Generated<string>;
  template_id: string;
  version: number;
  content: Json<TemplateContent>;
  created_by: string | null;
  created_at: Timestamp;
}

export type MessageStatus = 'queued' | 'deferred' | 'sending' | 'sent' | 'delivered' | 'failed' | 'suppressed';

export interface MessagesTable {
  id: Generated<string>;
  contact_id: string;
  template_id: string | null;
  template_version: number | null;
  channel: TemplateChannel;
  purpose: MessagePurpose;
  locale: Locale;
  to_address: string | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  status: MessageStatus;
  status_reason: string | null;
  provider: string | null;
  provider_message_id: string | null;
  attempts: Generated<number>;
  next_attempt_at: NullableTimestamp;
  source: string;
  idempotency_key: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  sent_at: NullableTimestamp;
  delivered_at: NullableTimestamp;
  opened_at: NullableTimestamp;
  clicked_at: NullableTimestamp;
  campaign_id: string | null;
}

export interface MessageEventsTable {
  id: Generated<string>;
  message_id: string;
  type: 'sent' | 'delivered' | 'failed' | 'open' | 'click' | 'unsubscribe' | 'retry';
  detail: string | null;
  at: Timestamp;
}

export interface SuppressionsTable {
  id: Generated<string>;
  channel: TemplateChannel;
  address: string;
  reason: string;
  created_at: Timestamp;
}

export interface SegmentsTable {
  id: Generated<string>;
  name: string;
  description: Generated<string>;
  rules: Json<SegmentRules>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: NullableTimestamp;
}

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled';

export interface CampaignsTable {
  id: Generated<string>;
  name: string;
  template_id: string;
  segment_id: string;
  status: Generated<CampaignStatus>;
  scheduled_at: NullableTimestamp;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  cursor_contact_id: string | null;
  enqueued_count: Generated<number>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
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
  templates: TemplatesTable;
  template_versions: TemplateVersionsTable;
  messages: MessagesTable;
  message_events: MessageEventsTable;
  suppressions: SuppressionsTable;
  segments: SegmentsTable;
  campaigns: CampaignsTable;
}

export type Template = Selectable<TemplatesTable>;
export type Message = Selectable<MessagesTable>;
export type Segment = Selectable<SegmentsTable>;
export type Campaign = Selectable<CampaignsTable>;

export type User = Selectable<UsersTable>;
export type Contact = Selectable<ContactsTable>;
export type NewContact = Insertable<ContactsTable>;
export type Event = Selectable<EventsTable>;
