// PureNet REST client for docs/contracts/purenet.openapi.yaml (all INFERRED, A-001).
import { PureNetError } from './errors.js';

const RETRYABLE = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createPureNetClient({ baseUrl, tokens, fetch = globalThis.fetch, maxRetries = 3, timeoutMs = 10_000, wait = sleep }) {
  async function request(operation, method, path, { query, body } = {}) {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, String(v));

    let refreshedAuth = false;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${await tokens.get()}`,
          accept: 'application/json, application/problem+json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 401 && !refreshedAuth) { // token revoked or expired early: refresh once
        refreshedAuth = true;
        tokens.invalidate();
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < maxRetries) { // A-013: 429 + Retry-After
        await wait(retryDelayMs(res.headers.get('retry-after'), attempt));
        continue;
      }
      if (res.status === 204) return null;
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new PureNetError(res.status, json, { operation });
      return json;
    }
  }

  return {
    // A-005: exact-match lookup by `system|value`; may return several members.
    async searchMembers(system, value, { limit, cursor } = {}) {
      return request('searchMembers', 'GET', '/members', { query: { identifier: `${system}|${value}`, limit, cursor } });
    },
    // A-013: follows next_cursor until exhausted.
    async *searchAllMembers(system, value) {
      let cursor;
      do {
        const page = await this.searchMembers(system, value, { cursor, limit: 100 });
        yield* page.data;
        cursor = page.next_cursor;
      } while (cursor);
    },
    async getMember(memberId) { // A-006
      return request('getMember', 'GET', `/members/${encodeURIComponent(memberId)}`);
    },
    async listConsents(memberId) { // A-007
      return (await request('listMemberConsents', 'GET', `/members/${encodeURIComponent(memberId)}/consents`)).data;
    },
    async createSubscription(callbackUrl, eventTypes) { // A-008; the response's signingSecret is shown once (A-011)
      return request('createSubscription', 'POST', '/subscriptions', { body: { callbackUrl, eventTypes } });
    },
    async deleteSubscription(subscriptionId) {
      return request('deleteSubscription', 'DELETE', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    },
  };
}

// Retry-After in seconds (or an HTTP date); otherwise exponential backoff of 0.5s, 1s, 2s and so on, capped at 30s.
export function retryDelayMs(retryAfter, attempt) {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, 30_000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), 30_000);
  }
  return Math.min(500 * 2 ** attempt, 30_000);
}
