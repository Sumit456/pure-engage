// Salesforce REST client (docs/contracts/salesforce.openapi.yaml): the OAuth token endpoint, query with paging,
// describe, and composite/sobjects create and update. Every call goes through safeRequest (SSRF guard, pinned
// address) to a host that passed the allowlist. Tokens are never logged, and error messages are scrubbed before
// they reach the request log or the connection status.
import { safeRequest, UnsafeUrlError } from '../net.ts';

export const SF_API_VERSION = 'v62.0';
export const SF_SCOPES = 'api refresh_token offline_access';
/** composite/sobjects takes at most 200 records per call. */
export const SF_COMPOSITE_LIMIT = 200;

const ALLOWED_SUFFIXES = ['.salesforce.com', '.my.salesforce.com', '.force.com'];
const RETRY_DELAYS_MS = [1_000, 4_000];
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export class SalesforceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(scrub(message));
    this.name = 'SalesforceError';
    this.status = status;
    this.code = code;
  }
}

/** Error text from Salesforce can echo record values; emails and long digit runs are blanked before it is stored. */
export function scrub(message: string): string {
  return message
    .replace(/[^\s@'"]+@[^\s@'"]+/g, '[redacted]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[redacted]')
    .slice(0, 300);
}

/**
 * Validates a login host or instance URL and returns its origin. Only https hosts under salesforce.com or force.com
 * are accepted, unless `allowAnyHost` (PE_SALESFORCE_ALLOW_ANY_HOST, refused in production) is set for tests.
 */
export function checkSalesforceUrl(raw: string, allowAnyHost: boolean): string {
  const input = raw.trim();
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`); } catch { throw new UnsafeUrlError('Not a valid host'); }
  if (url.username || url.password) throw new UnsafeUrlError('The host must not contain credentials');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new UnsafeUrlError('Enter the host only, without a path');
  if (allowAnyHost) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UnsafeUrlError('The host must use https');
    return url.origin;
  }
  if (url.protocol !== 'https:') throw new UnsafeUrlError('The host must use https');
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_SUFFIXES.some((s) => host.endsWith(s))) throw new UnsafeUrlError('The host must end with .salesforce.com, .my.salesforce.com or .force.com');
  return url.origin;
}

interface HttpResult { status: number; json: unknown }

async function http(method: string, url: string, body: string | null, headers: Record<string, string>, allowAnyHost: boolean): Promise<HttpResult> {
  checkSalesforceUrl(new URL(url).origin, allowAnyHost);
  let res;
  try {
    res = await safeRequest(method, url, body, { accept: 'application/json', 'user-agent': 'PureEngage-Salesforce/1.0', ...headers }, { allowPrivate: allowAnyHost, timeoutMs: 30_000, maxBytes: MAX_RESPONSE_BYTES });
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new SalesforceError(0, 'BLOCKED', err.message);
    throw new SalesforceError(0, 'NETWORK', `Could not reach Salesforce: ${(err as Error).message}`);
  }
  let json: unknown = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { json = null; }
  return { status: res.status, json };
}

/** REST errors are `[{ errorCode, message }]`; OAuth errors are `{ error, error_description }`. */
function toError(res: HttpResult): SalesforceError {
  const j = res.json as unknown;
  const first = Array.isArray(j) ? (j[0] as { errorCode?: string; message?: string } | undefined) : undefined;
  if (first?.errorCode) return new SalesforceError(res.status, first.errorCode, `${first.errorCode}: ${first.message ?? ''}`);
  const o = j as { error?: string; error_description?: string } | null;
  if (o?.error) return new SalesforceError(res.status, o.error, `${o.error}: ${o.error_description ?? ''}`);
  return new SalesforceError(res.status, `HTTP_${res.status}`, `Salesforce returned HTTP ${res.status}`);
}

// ---------- OAuth ----------

export interface TokenResponse { access_token: string; refresh_token?: string; instance_url: string; id?: string; scope?: string; token_type?: string; issued_at?: string }

/** POST <login host>/services/oauth2/token (authorization_code with PKCE, or refresh_token). */
export async function requestToken(loginHost: string, params: Record<string, string>, allowAnyHost: boolean): Promise<TokenResponse> {
  const res = await http('POST', `${loginHost}/services/oauth2/token`, new URLSearchParams(params).toString(), { 'content-type': 'application/x-www-form-urlencoded' }, allowAnyHost);
  const tok = res.json as Partial<TokenResponse> | null;
  if (res.status !== 200 || !tok?.access_token) throw toError(res);
  if (!tok.instance_url) throw new SalesforceError(res.status, 'invalid_response', 'The token response had no instance_url');
  return tok as TokenResponse;
}

export async function revokeToken(loginHost: string, token: string, allowAnyHost: boolean): Promise<void> {
  const res = await http('POST', `${loginHost}/services/oauth2/revoke`, new URLSearchParams({ token }).toString(), { 'content-type': 'application/x-www-form-urlencoded' }, allowAnyHost);
  if (res.status !== 200) throw toError(res);
}

export interface UserInfo { preferred_username?: string; organization_id?: string; user_id?: string }

export async function userInfo(instanceUrl: string, accessToken: string, allowAnyHost: boolean): Promise<UserInfo> {
  const res = await http('GET', `${instanceUrl}/services/oauth2/userinfo`, null, { authorization: `Bearer ${accessToken}` }, allowAnyHost);
  if (res.status !== 200) throw toError(res);
  return (res.json ?? {}) as UserInfo;
}

// ---------- REST ----------

export interface SObjectRecord { attributes?: { type: string; url?: string }; Id?: string; [field: string]: unknown }
export interface QueryResult { totalSize: number; done: boolean; nextRecordsUrl?: string; records: SObjectRecord[] }
export interface SaveResult { id?: string | null; success: boolean; errors: { statusCode?: string; message?: string; fields?: string[] }[] }
export interface DescribeField { name: string; label: string; type: string; custom: boolean; externalId: boolean; unique: boolean; idLookup: boolean; picklistValues: string[] }

export interface SalesforceClientOptions {
  instanceUrl: string;
  allowAnyHost: boolean;
  /** The cached access token, or a fresh one. */
  getAccessToken: () => Promise<string>;
  /** Called once when Salesforce answers 401 INVALID_SESSION_ID. */
  refreshAccessToken: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createSalesforceClient({ instanceUrl, allowAnyHost, getAccessToken, refreshAccessToken, sleep = defaultSleep }: SalesforceClientOptions) {
  const base = `${instanceUrl}/services/data/${SF_API_VERSION}`;

  /** One REST call: refreshes the token once on INVALID_SESSION_ID; backs off on REQUEST_LIMIT_EXCEEDED, 5xx and network errors. */
  async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    let token = await getAccessToken();
    let refreshed = false;
    let retries = 0;
    for (;;) {
      let res: HttpResult;
      try {
        res = await http(method, url, body === undefined ? null : JSON.stringify(body), {
          authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        }, allowAnyHost);
      } catch (err) {
        if (err instanceof SalesforceError && err.code === 'NETWORK' && retries < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[retries++]!); continue; }
        throw err;
      }
      if (res.status >= 200 && res.status < 300) return res.json as T;
      const err = toError(res);
      if (res.status === 401 && err.code === 'INVALID_SESSION_ID' && !refreshed) {
        refreshed = true;
        token = await refreshAccessToken();
        continue;
      }
      const retryable = res.status >= 500 || res.status === 429 || err.code === 'REQUEST_LIMIT_EXCEEDED';
      if (retryable && retries < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[retries++]!); continue; }
      throw err;
    }
  }

  return {
    /** Pages of a SOQL query, following nextRecordsUrl. */
    async *queryPages(soql: string): AsyncGenerator<SObjectRecord[]> {
      let res = await call<QueryResult>('GET', `${base}/query?q=${encodeURIComponent(soql)}`);
      yield res.records ?? [];
      while (!res.done && res.nextRecordsUrl) {
        if (!res.nextRecordsUrl.startsWith('/services/data/')) throw new SalesforceError(0, 'invalid_response', 'Unexpected nextRecordsUrl');
        res = await call<QueryResult>('GET', `${instanceUrl}${res.nextRecordsUrl}`);
        yield res.records ?? [];
      }
    },

    async query(soql: string): Promise<SObjectRecord[]> {
      const out: SObjectRecord[] = [];
      for await (const page of this.queryPages(soql)) out.push(...page);
      return out;
    },

    async describe(object: string): Promise<{ name: string; fields: DescribeField[] }> {
      if (!OBJECT_NAME.test(object)) throw new SalesforceError(0, 'INVALID_TYPE', 'Invalid object name');
      const res = await call<{ name: string; fields: (Omit<DescribeField, 'picklistValues'> & { picklistValues?: { value: string; active?: boolean }[] })[] }>('GET', `${base}/sobjects/${object}/describe`);
      return {
        name: res.name,
        fields: (res.fields ?? []).map((f) => ({
          name: f.name, label: f.label, type: f.type, custom: !!f.custom, externalId: !!f.externalId, unique: !!f.unique, idLookup: !!f.idLookup,
          picklistValues: (f.picklistValues ?? []).filter((p) => p.active !== false).map((p) => p.value),
        })),
      };
    },

    /** composite/sobjects create, at most 200 records per call (allOrNone false: one result per record). */
    async createRecords(records: SObjectRecord[]): Promise<SaveResult[]> {
      const out: SaveResult[] = [];
      for (let i = 0; i < records.length; i += SF_COMPOSITE_LIMIT) {
        out.push(...await call<SaveResult[]>('POST', `${base}/composite/sobjects`, { allOrNone: false, records: records.slice(i, i + SF_COMPOSITE_LIMIT) }));
      }
      return out;
    },

    /** composite/sobjects update; each record carries its Id and attributes.type. */
    async updateRecords(records: SObjectRecord[]): Promise<SaveResult[]> {
      const out: SaveResult[] = [];
      for (let i = 0; i < records.length; i += SF_COMPOSITE_LIMIT) {
        out.push(...await call<SaveResult[]>('PATCH', `${base}/composite/sobjects`, { allOrNone: false, records: records.slice(i, i + SF_COMPOSITE_LIMIT) }));
      }
      return out;
    },
  };
}

export type SalesforceClient = ReturnType<typeof createSalesforceClient>;
