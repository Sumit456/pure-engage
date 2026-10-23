export type ConsentStatus = 'granted' | 'denied';
export type ConsentMap = Partial<Record<'email' | 'sms' | 'push', Partial<Record<'care' | 'marketing', ConsentStatus>>>>;
export type ContactRef = { external_id: string } | { email: string } | { contact_id: string };

export interface ContactInput {
  external_id?: string; email?: string; contact_id?: string; phone?: string | null;
  first_name?: string | null; last_name?: string | null; preferred_language?: string | null; timezone?: string | null;
  consent?: ConsentMap;
  [attribute: string]: unknown;
}
export interface EventInput { external_id?: string; email?: string; contact_id?: string; name: string; properties?: Record<string, unknown>; time?: string; idempotency_key?: string }
export interface TrackResult { attributes_processed: number; events_processed: number; duplicates: number; errors: { type: 'attribute' | 'event'; index: number; error: string }[] }
export interface ContactView {
  id: string; external_id: string | null; email: string | null; phone: string | null; first_name: string | null; last_name: string | null;
  preferred_language: string | null; timezone: string | null; consent: ConsentMap; masked: boolean;
  attributes?: Record<string, unknown>; attribute_names?: string[]; created_at: string; updated_at: string;
}
export interface SendInput {
  template_id: string;
  recipients: (Partial<ContactInput> & { properties?: Record<string, unknown>; attributes?: Record<string, unknown>; idempotency_key?: string })[];
  transactional?: boolean; bypass_quiet_hours?: boolean;
}
export interface SendResult { results: ({ contact_id: string; message_id: string; status: string; reason: string | null } | { error: string })[] }
export interface TriggerInput { external_id?: string; email?: string; contact_id?: string; properties?: Record<string, unknown>; attributes?: Record<string, unknown>; idempotency_key?: string }
export interface TriggerResult { contact_id: string; event_id: string; event_name: string; duplicate: boolean }
export interface MessageStatus {
  id: string; contact_id: string; template_id: string | null; campaign_id: string | null; channel: 'email' | 'sms';
  status: 'queued' | 'deferred' | 'sending' | 'sent' | 'delivered' | 'failed' | 'suppressed'; status_reason: string | null;
  created_at: string; sent_at: string | null; opened_at: string | null; clicked_at: string | null; events: { type: string; at: string }[];
}
export interface Segment { id: string; name: string; description: string; size: number; updated_at: string }
export interface Campaign { id: string; name: string; status: string; scheduled_at: string | null; completed_at: string | null; stats: Record<string, number>; [key: string]: unknown }

export class PureEngageError extends Error {
  readonly status: number;
  readonly details: unknown;
}

export class PureEngage {
  constructor(options: { baseUrl: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number; retries?: number });
  track(events: EventInput | EventInput[]): Promise<TrackResult>;
  identify(contacts: ContactInput | ContactInput[]): Promise<TrackResult>;
  batch(input: { attributes?: ContactInput[]; events?: EventInput[] }): Promise<TrackResult>;
  setConsent(ref: ContactRef, consent: ConsentMap): Promise<{ contact_id: string; consent: ConsentMap }>;
  triggerJourney(journeyId: string, input: TriggerInput): Promise<TriggerResult>;
  send(input: SendInput): Promise<SendResult>;
  getContact(contactId: string): Promise<ContactView>;
  lookupContact(ref: ContactRef): Promise<ContactView>;
  getMessage(messageId: string): Promise<MessageStatus>;
  listSegments(): Promise<Segment[]>;
  listCampaigns(): Promise<Campaign[]>;
  getCampaign(campaignId: string): Promise<Campaign>;
  reportsOverview(): Promise<Record<string, unknown>>;
}

export function signWebhook(secret: string, rawBody: string, t?: number): Promise<string>;
export function verifyWebhook(header: string | null | undefined, rawBody: string, secret: string, options?: { toleranceSec?: number; now?: number }): Promise<boolean>;
