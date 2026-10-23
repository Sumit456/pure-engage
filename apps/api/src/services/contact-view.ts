// How integrations (API keys, AI assistants) see a contact: masked unless they hold contacts:read_pii.
import type { Contact } from '../db/schema.ts';

const maskEmail = (e: string | null) => {
  if (!e) return null;
  const [user = '', domain = ''] = e.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
};
const maskPhone = (p: string | null) => (p ? `${p.slice(0, 4)}${'*'.repeat(Math.max(0, p.length - 6))}${p.slice(-2)}` : null);
const initial = (s: string | null) => (s ? `${s.trim().slice(0, 1)}.` : null);

/**
 * A contact as an integration sees it. Without `contacts:read_pii`, names become initials, email and phone are
 * masked and only attribute names are returned (attributes can hold health details).
 */
export function contactView(c: Contact, pii: boolean) {
  const base = { id: c.id, external_id: c.external_id, preferred_language: c.preferred_language, timezone: c.timezone, consent: c.consent, created_at: c.created_at, updated_at: c.updated_at };
  if (pii) return { ...base, email: c.email, phone: c.phone, first_name: c.first_name, last_name: c.last_name, attributes: c.attributes, masked: false };
  return { ...base, email: maskEmail(c.email), phone: maskPhone(c.phone), first_name: initial(c.first_name), last_name: initial(c.last_name), attribute_names: Object.keys(c.attributes ?? {}), masked: true };
}
