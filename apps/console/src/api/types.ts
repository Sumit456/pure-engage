import type { ConsentMap, GroupRule, JourneyDefinition } from '@pure-engage/shared';

export type Role = 'viewer' | 'marketer' | 'admin';

export interface User { id: string; email: string; name: string; role: Role }

export interface Contact {
  id: string;
  external_id: string | null;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  preferred_language: string | null;
  timezone: string | null;
  attributes: Record<string, unknown>;
  consent: ConsentMap;
  created_at: string;
  updated_at: string;
}

export interface ContactEvent {
  id: string;
  name: string;
  properties: Record<string, unknown>;
  source: string;
  occurred_at: string;
}

export interface ConsentChange {
  id: string;
  channel: string;
  purpose: string;
  status: string;
  previous_status: string | null;
  source: string;
  changed_at: string;
}

export interface ContactDetail extends Contact {
  recent_events: ContactEvent[];
  consent_history: ConsentChange[];
  journeys: { id: string; journey_id: string; journey_name: string; status: 'active' | 'completed' | 'exited'; current_step: string | null; next_run_at: string | null; exit_reason: string | null; entered_at: string; completed_at: string | null }[];
}

export interface Page<T> { data: T[]; next_cursor: string | null }

export type Channel = 'email' | 'sms';
export type Purpose = 'care' | 'marketing';
export interface EmailPart { subject: string; html: string; text?: string }
export interface SmsPart { body: string }
export interface TemplateContent { en: EmailPart | SmsPart; ar?: EmailPart | SmsPart }

export interface Template {
  id: string;
  name: string;
  channel: Channel;
  purpose: Purpose;
  description: string;
  current_version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}
export interface TemplateDetail extends Template { content: TemplateContent }
export interface TemplateVersion { version: number; created_at: string; created_by_email: string | null }

export type MessageStatus = 'queued' | 'deferred' | 'sending' | 'sent' | 'delivered' | 'failed' | 'suppressed';
export interface MessageSummary {
  id: string;
  contact_id: string;
  template_id: string | null;
  template_name: string | null;
  channel: Channel;
  purpose: Purpose;
  locale: 'en' | 'ar';
  to_address: string | null;
  subject: string | null;
  status: MessageStatus;
  status_reason: string | null;
  provider: string | null;
  source: string;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  next_attempt_at: string | null;
}
export interface MessageDetail extends MessageSummary {
  body_text: string | null;
  body_html_preview: string | null;
  attempts: number;
  events: { id: string; type: string; detail: string | null; at: string }[];
}
export interface DeliveryStatus { mode: 'sandbox' | 'live'; providers: { email: string; sms: string }; allowlist: boolean }

export interface Segment { id: string; name: string; description: string; rules: GroupRule; size: number; created_at: string; updated_at: string }
export interface SegmentPreview { count: number; sample: Pick<Contact, 'id' | 'external_id' | 'first_name' | 'last_name' | 'email'>[] }

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled';
export interface CampaignStats {
  targeted: number; pending: number; sent: number; delivered: number; failed: number; suppressed: number;
  suppressed_by_reason: Record<string, number>; opened: number; clicked: number;
}
export interface Campaign {
  id: string; name: string; template_id: string; segment_id: string; status: CampaignStatus;
  scheduled_at: string | null; started_at: string | null; completed_at: string | null; enqueued_count: number; created_at: string; updated_at: string;
}
export interface CampaignSummary extends Campaign { template_name: string; channel: Channel; purpose: Purpose; segment_name: string; stats: CampaignStats }
export interface CampaignDetail extends Campaign { template: { id: string; name: string; channel: Channel; purpose: Purpose }; segment: { id: string; name: string }; stats: CampaignStats }
export interface CampaignEstimate { segment_size: number; eligible: number; channel: Channel; purpose: Purpose }

export type JourneyStatus = 'draft' | 'active' | 'paused' | 'archived';
export interface JourneyStats {
  enrollments: { active: number; completed: number; exited: number };
  steps: Record<string, Record<string, number>>;
  messages: { total: number; sent: number };
}
export interface Journey { id: string; name: string; description: string; status: JourneyStatus; definition: JourneyDefinition; trigger_event: string; created_at: string; updated_at: string; activated_at: string | null; stats: JourneyStats }
export interface JourneyDetail extends Journey { problems: { step?: string; message: string }[] }
export interface JourneyRun {
  id: string; contact_id: string; external_id: string | null; first_name: string | null; last_name: string | null; status: 'active' | 'completed' | 'exited';
  current_step: string | null; next_run_at: string | null; waiting_for: string | null; exit_reason: string | null; entry_key: string | null; entered_at: string; completed_at: string | null;
}
export interface SimulationStep { step: string; type: string; at: string; outcome: string; detail?: Record<string, unknown> }

export interface Overview {
  window_days: number;
  contacts: number;
  consent: { email_care: number; sms_care: number; email_marketing: number; sms_marketing: number };
  messages: { sent: number; not_sent: number; failed: number };
  email: { sent: number; open_rate: number | null; click_rate: number | null };
  journeys: { active_runs: number; entered: number };
  campaigns_sent: number;
}
export interface DayRow { day: string; channel: Channel; sent: number; delivered: number; opened: number; clicked: number; failed: number; not_sent: number }
export interface MessagesReport { from: string; to: string; days: DayRow[]; not_sent: { reason: string; count: number }[] }
export interface CampaignReportRow { id: string; name: string; status: CampaignStatus; completed_at: string | null; channel: Channel; targeted: number; sent: number; opened: number; clicked: number; not_sent: number }
export interface JourneyReportRow { id: string; name: string; status: JourneyStatus; runs: number; active: number; completed: number; exited: number }
export interface WebhookSummary { id: string; name: string; url: string; events: string[]; enabled: boolean; created_at: string; updated_at: string }
export interface WebhookDelivery { id: string; event_name: string; status: 'pending' | 'success' | 'failed'; attempts: number; next_attempt_at: string | null; response_code: number | null; error: string | null; created_at: string }
export interface ApiKey { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
export interface AdminUser extends User { active: boolean; created_at: string; last_login_at: string | null }
export interface AuditEntry { id: string; at: string; actor_type: string; actor_id: string | null; action: string; entity_type: string | null; entity_id: string | null; details: Record<string, unknown> }
