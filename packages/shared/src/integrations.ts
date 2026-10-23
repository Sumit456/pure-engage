// Integrations: API key scopes, and the field mapping that turns any JSON payload (from Zapier, Make, n8n, a
// booking system, a form tool...) into the platform's own /track shape. Shared by the API (which applies the
// mapping to inbound webhooks) and the console (which previews it live while you build it).

export const API_SCOPES = [
  'contacts:read', 'contacts:read_pii', 'contacts:write', 'consent:write', 'events:write',
  'journeys:trigger', 'messages:send', 'messages:read',
  'segments:read', 'campaigns:read', 'reports:read', 'drafts:write',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** What keys created before scopes existed could do (they keep it). */
export const LEGACY_SCOPES: ApiScope[] = ['contacts:write', 'consent:write', 'events:write', 'messages:send'];

/** Starting points offered in the console when creating a key. */
export const SCOPE_PRESETS: Record<'ingest' | 'messaging' | 'ai_read' | 'ai_drafts' | 'full', ApiScope[]> = {
  ingest: ['contacts:write', 'consent:write', 'events:write'],
  messaging: ['contacts:write', 'events:write', 'journeys:trigger', 'messages:send', 'messages:read'],
  ai_read: ['contacts:read', 'segments:read', 'campaigns:read', 'reports:read'],
  ai_drafts: ['contacts:read', 'segments:read', 'campaigns:read', 'reports:read', 'drafts:write'],
  full: [...API_SCOPES],
};

/** What an AI assistant connected over OAuth (MCP) may be granted: reads and drafts, never sending. */
export const AI_SCOPES: ApiScope[] = ['contacts:read', 'contacts:read_pii', 'segments:read', 'campaigns:read', 'reports:read', 'drafts:write'];

// ---------- inbound field mapping ----------

export const MAPPABLE_CONTACT_FIELDS = ['external_id', 'email', 'phone', 'first_name', 'last_name', 'preferred_language', 'timezone'] as const;
export type MappableContactField = (typeof MAPPABLE_CONTACT_FIELDS)[number];

export interface FieldPath { key: string; path: string }
export interface InboundMapping {
  /** Path to an array of records in the payload; empty means the payload itself is one record. */
  records?: string;
  /** Contact field → path within a record. external_id or email identifies the contact. */
  contact: Partial<Record<MappableContactField, string>>;
  attributes: FieldPath[];
  consent: { channel: 'email' | 'sms'; purpose: 'care' | 'marketing'; path: string }[];
  /** Records an event per record when set (e.g. `appointment.booked`, which can start a journey). */
  event?: { name: string; properties: FieldPath[]; time?: string; idempotency_key?: string } | null;
}

export const emptyMapping = (): InboundMapping => ({ contact: {}, attributes: [], consent: [], event: null });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads `a.b.0.c` from a value; an empty path is the value itself. */
export function getPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (isObject(cur) && Object.prototype.hasOwnProperty.call(cur, part)) cur = cur[part];
    else return undefined;
  }
  return cur;
}

/** Every scalar leaf of a sample payload with its value, for picking fields in the console. */
export function leafPaths(value: unknown, { maxDepth = 6, max = 300 } = {}): { path: string; sample: string }[] {
  const out: { path: string; sample: string }[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= max) return;
    if (Array.isArray(v)) { if (depth < maxDepth && v.length) walk(v[0], path ? `${path}.0` : '0', depth + 1); return; }
    if (isObject(v)) { if (depth < maxDepth) for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k, depth + 1); return; }
    if (path) out.push({ path, sample: v === null ? 'null' : String(v).slice(0, 80) });
  };
  walk(value, '', 0);
  return out;
}

/** Accepts the ways tools usually say yes or no to a channel. Anything else is ignored. */
export function normalizeConsentValue(v: unknown): 'granted' | 'denied' | undefined {
  const s = String(v ?? '').trim().toLowerCase();
  if (['granted', 'yes', 'y', 'true', '1', 'opt-in', 'opted_in', 'subscribed', 'on'].includes(s)) return 'granted';
  if (['denied', 'no', 'n', 'false', '0', 'opt-out', 'opted_out', 'unsubscribed', 'off'].includes(s)) return 'denied';
  return undefined;
}

const scalar = (v: unknown): string | number | boolean | null | undefined =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined;

/** Payload → `{ attributes, events }` for /track, plus readable problems for records that can't be used. */
export function applyMapping(payload: unknown, mapping: InboundMapping): { request: { attributes: Record<string, unknown>[]; events: Record<string, unknown>[] }; problems: string[] } {
  const attributes: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const problems: string[] = [];
  const list = mapping.records ? getPath(payload, mapping.records) : payload;
  const records = mapping.records ? (Array.isArray(list) ? list : []) : [payload];
  if (mapping.records && !Array.isArray(list)) problems.push(`"${mapping.records}" is not a list in this payload`);

  records.forEach((record, i) => {
    const label = records.length > 1 ? `Record ${i + 1}: ` : '';
    const contact: Record<string, unknown> = {};
    for (const field of MAPPABLE_CONTACT_FIELDS) {
      const path = mapping.contact[field];
      if (!path) continue;
      const v = scalar(getPath(record, path));
      if (v !== undefined && v !== null && String(v).trim() !== '') contact[field] = String(v).trim();
    }
    const ref = contact.external_id ? { external_id: contact.external_id } : contact.email ? { email: contact.email } : null;
    if (!ref) { problems.push(`${label}no external ID or email found, so it can't be matched to a contact`); return; }

    const item: Record<string, unknown> = { ...contact };
    for (const { key, path } of mapping.attributes) {
      if (!key || !path) continue;
      const v = getPath(record, path);
      if (v !== undefined) item[key] = scalar(v) ?? JSON.stringify(v);
    }
    const consent: Record<string, Record<string, string>> = {};
    for (const c of mapping.consent) {
      const v = normalizeConsentValue(getPath(record, c.path));
      if (v) (consent[c.channel] ??= {})[c.purpose] = v;
    }
    if (Object.keys(consent).length) item.consent = consent;
    attributes.push(item);

    if (mapping.event?.name) {
      const properties: Record<string, unknown> = {};
      for (const { key, path } of mapping.event.properties) {
        if (!key || !path) continue;
        const v = getPath(record, path);
        if (v !== undefined) properties[key] = v;
      }
      const ev: Record<string, unknown> = { ...ref, name: mapping.event.name, properties };
      const time = scalar(getPath(record, mapping.event.time || undefined));
      if (mapping.event.time && time) {
        const d = new Date(typeof time === 'number' && time < 1e12 ? time * 1000 : (time as string | number));
        if (Number.isNaN(d.getTime())) problems.push(`${label}"${mapping.event.time}" is not a date`);
        else ev.time = d.toISOString();
      }
      const key = scalar(getPath(record, mapping.event.idempotency_key || undefined));
      if (mapping.event.idempotency_key && key !== undefined && key !== null && key !== '') ev.idempotency_key = String(key).slice(0, 200);
      events.push(ev);
    }
  });
  return { request: { attributes, events }, problems };
}
