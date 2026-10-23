// Pure Engage JavaScript SDK: a small client for the public API (docs/contracts/platform-ingest.openapi.yaml) and
// helpers for webhook signatures. No dependencies; works in Node 18+ and any runtime with fetch and Web Crypto.

export class PureEngageError extends Error {
  /** @param {number} status @param {string} message @param {unknown} [details] */
  constructor(status, message, details) {
    super(message);
    this.name = 'PureEngageError';
    this.status = status;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asList = (v) => (Array.isArray(v) ? v : [v]);

export class PureEngage {
  /**
   * @param {{ baseUrl: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number; retries?: number }} options
   */
  constructor({ baseUrl, apiKey, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10_000, retries = 2 }) {
    if (!baseUrl) throw new TypeError('baseUrl is required');
    if (!apiKey) throw new TypeError('apiKey is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  /**
   * Retries reads on 429, 5xx and network errors, and writes only on 429 (a rate-limited request was not processed).
   * Writes that must survive other failures should carry an idempotency_key, then retrying them yourself is safe.
   */
  async request(method, path, body) {
    const read = method === 'GET';
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(`${this.baseUrl}/api/v1${path}`, {
          method,
          headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (read && attempt < this.retries) { await sleep(250 * 2 ** attempt); continue; }
        throw err;
      }
      const retryable = res.status === 429 || (read && res.status >= 500);
      if (retryable && attempt < this.retries) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 250 * 2 ** attempt);
        continue;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new PureEngageError(res.status, json.error ?? res.statusText, json.details);
      return json;
    }
  }

  /** Records one event or several. Needs events:write. */
  track(events) { return this.request('POST', '/track', { events: asList(events) }); }
  /** Creates or updates one contact or several (consent included). Needs contacts:write (and consent:write for consent). */
  identify(contacts) { return this.request('POST', '/track', { attributes: asList(contacts) }); }
  /** Contacts and events in one request (at most 500 objects). */
  batch({ attributes = [], events = [] }) { return this.request('POST', '/track', { attributes, events }); }
  /** Needs consent:write. `ref` is { external_id } , { email } or { contact_id }. */
  setConsent(ref, consent) { return this.request('POST', '/consent', { ...ref, consent }); }
  /** Needs journeys:trigger. */
  triggerJourney(journeyId, input) { return this.request('POST', `/journeys/${encodeURIComponent(journeyId)}/trigger`, input); }
  /** Needs messages:send. */
  send(input) { return this.request('POST', '/messages/send', input); }
  /** Needs contacts:read; personal details are masked unless the key also has contacts:read_pii. */
  getContact(contactId) { return this.request('GET', `/contacts/${encodeURIComponent(contactId)}`); }
  lookupContact(ref) { return this.request('POST', '/contacts/lookup', ref); }
  /** Needs messages:read. */
  getMessage(messageId) { return this.request('GET', `/messages/${encodeURIComponent(messageId)}`); }
  async listSegments() { return (await this.request('GET', '/segments')).data; }
  async listCampaigns() { return (await this.request('GET', '/campaigns')).data; }
  getCampaign(campaignId) { return this.request('GET', `/campaigns/${encodeURIComponent(campaignId)}`); }
  reportsOverview() { return this.request('GET', '/reports/overview'); }
}

// ---------- webhook signatures: X-PE-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "{t}.{body}")> ----------

const enc = new TextEncoder();
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}
function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Signs a body for an inbound webhook in HMAC mode. Returns the X-PE-Signature header value. */
export async function signWebhook(secret, rawBody, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${rawBody}`)}`;
}

/** Checks an outbound webhook's X-PE-Signature against the raw request body. */
export async function verifyWebhook(header, rawBody, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.trim().split('=', 2)));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(now / 1000 - t) > toleranceSec) return false;
  return equal(parts.v1, await hmacHex(secret, `${parts.t}.${rawBody}`));
}
