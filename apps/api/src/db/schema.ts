// Table types for Kysely. Keep in step with src/db/migrations/.
import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable } from 'kysely';
import type { ApiScope, ConsentMap, InboundMapping, JourneyDefinition, SegmentRules } from '@pure-engage/shared';

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
  scopes: ColumnType<ApiScope[], ApiScope[] | string | undefined, ApiScope[] | string>;
  expires_at: NullableTimestamp;
}

export interface InboundWebhookConfig {
  mapping: InboundMapping;
  /** `token`: a bearer token (or ?token= for tools that can only set a URL); `hmac`: X-PE-Signature like our outbound webhooks. */
  auth: 'token' | 'hmac';
}

export interface IntegrationsTable {
  id: Generated<string>;
  kind: 'inbound_webhook';
  name: string;
  config: ColumnType<InboundWebhookConfig, InboundWebhookConfig | string | undefined, InboundWebhookConfig | string>;
  secret_encrypted: string;
  enabled: Generated<boolean>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  last_seen_at: NullableTimestamp;
}

export interface IntegrationRequestsTable {
  id: Generated<string>;
  at: Timestamp;
  api_key_id: string | null;
  integration_id: string | null;
  method: string;
  route: string;
  status: number;
  duration_ms: number;
  items: number | null;
  error: string | null;
  oauth_grant_id: string | null;
}

export interface OAuthClientsTable {
  id: string;
  name: string;
  redirect_uris: ColumnType<string[], string[] | string, string[] | string>;
  created_at: Timestamp;
}

export interface OAuthCodesTable {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: ColumnType<ApiScope[], ApiScope[] | string, ApiScope[] | string>;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
}

export interface OAuthGrantsTable {
  id: Generated<string>;
  client_id: string;
  user_id: string | null;
  scopes: ColumnType<ApiScope[], ApiScope[] | string, ApiScope[] | string>;
  access_hash: string;
  access_expires_at: Timestamp;
  refresh_hash: string;
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
  processed_at: NullableTimestamp;
}

/** Channels Pure Engage can send on today. */
export type MessageChannel = 'email' | 'sms';
/** Channels content can be authored for; push and WhatsApp are authored now and sent once their providers exist. */
export type TemplateChannel = MessageChannel | 'push' | 'whatsapp';
export type MessagePurpose = 'care' | 'marketing';
export type Locale = 'en' | 'ar';

export interface EmailContent { subject: string; html: string; text?: string | undefined; design?: Record<string, unknown> | undefined }
export interface SmsContent { body: string }
export interface PushContent { title: string; body: string; image_asset_id?: string | undefined; deep_link?: string | undefined; data?: Record<string, string> | undefined }
export type WhatsAppButton = { type: 'quick_reply'; text: string } | { type: 'url'; text: string; url: string } | { type: 'call'; text: string; phone: string };
export interface WhatsAppContent {
  header: { type: 'none' | 'text' | 'image' | 'video' | 'document'; text?: string | undefined; asset_id?: string | undefined };
  body: string;
  footer?: string | undefined;
  buttons: WhatsAppButton[];
  category: 'marketing' | 'utility';
  approval: 'draft' | 'submitted' | 'approved' | 'rejected';
}
export type ContentPart = EmailContent | SmsContent | PushContent | WhatsAppContent;
/** One entry per locale; `en` is required, `ar` optional (falls back to `en`). */
export type TemplateContent = { en: ContentPart; ar?: ContentPart | undefined };

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
  folder_id: string | null;
  tags: ColumnType<string[], string[] | string | undefined, string[] | string>;
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
  channel: MessageChannel;
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
  journey_id: string | null;
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
  channel: MessageChannel;
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

export type JourneyStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface JourneysTable {
  id: Generated<string>;
  name: string;
  description: Generated<string>;
  status: Generated<JourneyStatus>;
  definition: Json<JourneyDefinition>;
  /** Canvas positions per step id (and `__trigger`); presentation only. */
  layout: JSONColumnType<Record<string, { x: number; y: number }>, string | undefined, string>;
  trigger_event: string;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  activated_at: NullableTimestamp;
}

export interface JourneyEnrollmentsTable {
  id: Generated<string>;
  journey_id: string;
  contact_id: string;
  status: 'active' | 'completed' | 'exited';
  current_step: string | null;
  next_run_at: NullableTimestamp;
  waiting_for: string | null;
  context: Json<Record<string, unknown>>;
  entry_key: string | null;
  exit_reason: string | null;
  entered_at: Timestamp;
  updated_at: Timestamp;
  completed_at: NullableTimestamp;
}

export interface JourneyStepLogTable {
  id: Generated<string>;
  enrollment_id: string;
  journey_id: string;
  step_id: string;
  outcome: string;
  detail: Json<Record<string, unknown>>;
  at: Timestamp;
}

export type AssetContentType =
  | 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf' | 'video/mp4' | 'video/webm' | 'audio/mpeg' | 'text/csv' | 'text/plain'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export type AssetKind = 'image' | 'document' | 'video' | 'audio';

export interface AssetsTable {
  id: Generated<string>;
  name: string;
  content_type: AssetContentType;
  kind: Generated<AssetKind>;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  folder_id: string | null;
  tags: ColumnType<string[], string[] | string | undefined, string[] | string>;
  description: Generated<string>;
  storage: Generated<string>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AssetBlobsTable {
  asset_id: string;
  data: Buffer;
}

export interface ContentFoldersTable {
  id: Generated<string>;
  name: string;
  parent_id: string | null;
  created_at: Timestamp;
}

export type ContentBlockContent = { blocks: Record<string, unknown>[] } | { html: string } | { text: string };
export interface ContentBlocksTable {
  id: Generated<string>;
  name: string;
  kind: 'design' | 'html' | 'text';
  content: ColumnType<ContentBlockContent, ContentBlockContent | string, ContentBlockContent | string>;
  folder_id: string | null;
  tags: ColumnType<string[], string[] | string | undefined, string[] | string>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: NullableTimestamp;
}

export interface WebhooksTable {
  id: Generated<string>;
  name: string;
  url: string;
  events: Json<string[]>;
  secret_encrypted: string;
  enabled: Generated<boolean>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WebhookDeliveriesTable {
  id: Generated<string>;
  webhook_id: string;
  event_name: string;
  payload: Json<Record<string, unknown>>;
  status: 'pending' | 'success' | 'failed';
  attempts: Generated<number>;
  next_attempt_at: NullableTimestamp;
  response_code: number | null;
  error: string | null;
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
  journeys: JourneysTable;
  journey_enrollments: JourneyEnrollmentsTable;
  journey_step_log: JourneyStepLogTable;
  webhooks: WebhooksTable;
  assets: AssetsTable;
  asset_blobs: AssetBlobsTable;
  content_folders: ContentFoldersTable;
  content_blocks: ContentBlocksTable;
  webhook_deliveries: WebhookDeliveriesTable;
  integrations: IntegrationsTable;
  integration_requests: IntegrationRequestsTable;
  oauth_clients: OAuthClientsTable;
  oauth_codes: OAuthCodesTable;
  oauth_grants: OAuthGrantsTable;
}

export type Template = Selectable<TemplatesTable>;
export type Message = Selectable<MessagesTable>;
export type Segment = Selectable<SegmentsTable>;
export type Campaign = Selectable<CampaignsTable>;
export type Journey = Selectable<JourneysTable>;
export type Enrollment = Selectable<JourneyEnrollmentsTable>;
export type Webhook = Selectable<WebhooksTable>;
export type WebhookDelivery = Selectable<WebhookDeliveriesTable>;
export type Integration = Selectable<IntegrationsTable>;

export type User = Selectable<UsersTable>;
export type Contact = Selectable<ContactsTable>;
export type NewContact = Insertable<ContactsTable>;
export type Event = Selectable<EventsTable>;
