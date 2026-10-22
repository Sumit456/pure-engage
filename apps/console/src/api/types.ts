import type { ConsentMap, GroupRule } from '@pure-engage/shared';

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
