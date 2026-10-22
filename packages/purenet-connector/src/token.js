// OAuth 2.0 client-credentials token provider (A-002). Caches the token and refreshes it
// shortly before expiry. Concurrent callers share one in-flight request.
import { PureNetError } from './errors.js';

const REFRESH_EARLY_MS = 60_000;

export function createTokenProvider({ tokenUrl, clientId, clientSecret, scopes, fetch = globalThis.fetch, now = Date.now }) {
  let cached = null; // { token, expiresAt }
  let inflight = null;

  async function fetchToken() {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    if (scopes) body.set('scope', scopes);
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new PureNetError(res.status, { title: json.error ?? 'token request failed', detail: json.error_description }, { operation: 'token' });
    }
    cached = { token: json.access_token, expiresAt: now() + Number(json.expires_in ?? 300) * 1000 };
    return cached.token;
  }

  return {
    async get() {
      if (cached && now() < cached.expiresAt - REFRESH_EARLY_MS) return cached.token;
      inflight ??= fetchToken().finally(() => { inflight = null; });
      return inflight;
    },
    invalidate() { cached = null; },
  };
}
