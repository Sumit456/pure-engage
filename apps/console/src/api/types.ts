import type { ConsentMap } from '@pure-engage/shared';

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
