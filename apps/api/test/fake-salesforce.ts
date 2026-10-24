// A local stand-in for Salesforce (OAuth web-server flow with PKCE, query with paging, describe and
// composite/sobjects), so tests never reach a real org. Node built-ins only: the console e2e spec starts it too.
// Every value it holds is synthetic.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

type Rec = Record<string, unknown> & { Id: string; SystemModstamp: string };
type ObjectName = 'Contact' | 'Lead';

const API = '/services/data/v62.0';
const alnum = (n: number) => Array.from(randomBytes(n), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 36]).join('');
const sfDate = (d: Date) => d.toISOString().replace('Z', '+0000');

const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, label: name.replace(/__c$/, '').replace(/_/g, ' '), type, custom: name.endsWith('__c'), externalId: false, unique: false, idLookup: name === 'Id', ...extra });
const STANDARD = [
  field('Id', 'id'), field('SystemModstamp', 'datetime'), field('Email', 'email'), field('FirstName', 'string'), field('LastName', 'string'),
  field('MobilePhone', 'phone'), field('Phone', 'phone'), field('HasOptedOutOfEmail', 'boolean'), field('DoNotCall', 'boolean'),
];
const DESCRIBE: Record<ObjectName, ReturnType<typeof field>[]> = {
  Contact: [
    ...STANDARD, field('Title', 'string'),
    field('Member_ID__c', 'string', { externalId: true, unique: true, idLookup: true }),
    field('Loyalty_Tier__c', 'picklist', { picklistValues: [{ value: 'Gold', active: true }, { value: 'Silver', active: true }] }),
    field('Marketing_Opt_In__c', 'boolean'),
    field('Sms_Consent__c', 'picklist', { picklistValues: [{ value: 'Opted_In', active: true }, { value: 'Opted_Out', active: true }] }),
  ],
  Lead: [...STANDARD, field('Company', 'string'), field('Status', 'picklist')],
};

export interface FakeSalesforceOptions {
  clientId?: string;
  clientSecret?: string;
  /** Records per query page (Salesforce uses 2,000; small here to exercise nextRecordsUrl). */
  pageSize?: number;
  /** What the token endpoint returns as instance_url (defaults to this server). */
  instanceUrl?: string;
  port?: number;
}

export async function startFakeSalesforce(opts: FakeSalesforceOptions = {}) {
  const clientId = opts.clientId ?? `3MVG9fake${alnum(24)}`;
  const clientSecret = opts.clientSecret ?? alnum(32);
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const issued: string[] = [];
  let modstamp = Date.parse('2026-01-01T00:00:00Z');

  const state = {
    clientId, clientSecret,
    pageSize: opts.pageSize ?? 2,
    instanceUrl: opts.instanceUrl as string | undefined,
    records: { Contact: [] as Rec[], Lead: [] as Rec[] },
    tasks: [] as Record<string, unknown>[],
    /** Every request path and method, for asserting what was called. */
    calls: [] as { method: string; path: string }[],
    queries: [] as string[],
    tokenGrants: [] as string[],
    compositeCalls: [] as { method: string; records: number }[],
    revoked: [] as string[],
    /** The next N composite calls answer this status. */
    failComposite: 0,
    failStatus: 500,
    /** Answer the next data call with 403 REQUEST_LIMIT_EXCEEDED. */
    limitOnce: false,
    /** Refresh tokens are refused (as after the user revokes the app in Salesforce). */
    rejectRefresh: false,
    /** Tasks whose WhoId is here fail with INVALID_CROSS_REFERENCE_KEY. */
    rejectWhoIds: new Set<string>(),
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { b += c; });
    req.on('end', () => resolve(b));
  });
  const issue = () => {
    const access = `00DFAKE!${alnum(40)}`;
    accessTokens.add(access);
    issued.push(access);
    return access;
  };

  const queryResults = new Map<string, Rec[]>();
  const page = (id: string, offset: number) => {
    const all = queryResults.get(id) ?? [];
    const records = all.slice(offset, offset + state.pageSize);
    const done = offset + state.pageSize >= all.length;
    return { totalSize: all.length, done, ...(done ? {} : { nextRecordsUrl: `${API}/query/01gFAKE${id}-${offset + state.pageSize}` }), records };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    state.calls.push({ method: req.method ?? 'GET', path: url.pathname });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // ---------- OAuth ----------
    if (url.pathname === '/services/oauth2/authorize' && req.method === 'GET') {
      const p = url.searchParams;
      if (p.get('client_id') !== clientId || p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || !p.get('redirect_uri')) {
        return json(res, 400, { error: 'invalid_request', error_description: 'bad authorize request' });
      }
      const code = `aPrx${alnum(30)}`;
      codes.set(code, { challenge: p.get('code_challenge')!, redirectUri: p.get('redirect_uri')! });
      const to = new URL(p.get('redirect_uri')!);
      to.searchParams.set('code', code);
      if (p.get('state')) to.searchParams.set('state', p.get('state')!);
      res.writeHead(302, { location: to.toString() });
      return res.end();
    }
    if (url.pathname === '/services/oauth2/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const grant = form.get('grant_type') ?? '';
      state.tokenGrants.push(grant);
      if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) return json(res, 400, { error: 'invalid_client', error_description: 'invalid client credentials' });
      if (grant === 'authorization_code') {
        const pending = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!pending) return json(res, 400, { error: 'invalid_grant', error_description: 'invalid authorization code' });
        if (pending.redirectUri !== form.get('redirect_uri')) return json(res, 400, { error: 'redirect_uri_mismatch', error_description: 'redirect_uri must match configuration' });
        const verifier = form.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier).digest('base64url') !== pending.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'invalid code verifier' });
        const refresh = `5Aep${alnum(40)}`;
        refreshTokens.add(refresh);
        issued.push(refresh);
        return json(res, 200, {
          access_token: issue(), refresh_token: refresh, instance_url: state.instanceUrl ?? base, id: `${base}/id/00DFAKE000000000001/005FAKE000000000001`,
          token_type: 'Bearer', issued_at: String(Date.now()), signature: alnum(20), scope: 'api refresh_token offline_access',
        });
      }
      if (grant === 'refresh_token') {
        if (state.rejectRefresh || !refreshTokens.has(form.get('refresh_token') ?? '')) return json(res, 400, { error: 'invalid_grant', error_description: 'expired access/refresh token' });
        return json(res, 200, { access_token: issue(), instance_url: state.instanceUrl ?? base, id: `${base}/id/00DFAKE000000000001/005FAKE000000000001`, token_type: 'Bearer', issued_at: String(Date.now()), signature: alnum(20) });
      }
      return json(res, 400, { error: 'unsupported_grant_type', error_description: 'grant type not supported' });
    }
    if (url.pathname === '/services/oauth2/revoke' && req.method === 'POST') {
      const token = new URLSearchParams(await readBody(req)).get('token') ?? '';
      state.revoked.push(token);
      refreshTokens.delete(token);
      accessTokens.delete(token);
      res.writeHead(200);
      return res.end();
    }

    // ---------- everything else needs a valid access token ----------
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !accessTokens.has(auth.slice(7))) return json(res, 401, [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]);

    if (url.pathname === '/services/oauth2/userinfo') {
      return json(res, 200, { sub: `${base}/id/00DFAKE000000000001/005FAKE000000000001`, user_id: '005FAKE000000000001', organization_id: '00DFAKE000000000001', preferred_username: 'integration.user@example.com', name: 'Integration User' });
    }
    if (state.limitOnce && url.pathname.startsWith(API)) {
      state.limitOnce = false;
      return json(res, 403, [{ message: 'TotalRequests Limit exceeded.', errorCode: 'REQUEST_LIMIT_EXCEEDED' }]);
    }
    if (url.pathname === `${API}/query` && req.method === 'GET') {
      const soql = url.searchParams.get('q') ?? '';
      state.queries.push(soql);
      const m = /^SELECT (.+) FROM (Contact|Lead)(?: WHERE SystemModstamp >= (\S+))? ORDER BY SystemModstamp ASC, Id ASC$/.exec(soql);
      if (!m) return json(res, 400, [{ message: 'unexpected query', errorCode: 'MALFORMED_QUERY' }]);
      const fields = m[1]!.split(',').map((f) => f.trim());
      const object = m[2] as ObjectName;
      const known = new Set(DESCRIBE[object].map((f) => f.name));
      const unknown = fields.find((f) => !known.has(f));
      if (unknown) return json(res, 400, [{ message: `No such column '${unknown}' on entity '${object}'`, errorCode: 'INVALID_FIELD' }]);
      const since = m[3] ? Date.parse(m[3]) : -Infinity;
      const rows = state.records[object]
        .filter((r) => Date.parse(r.SystemModstamp.replace('+0000', 'Z')) >= since)
        .sort((a, b) => a.SystemModstamp.localeCompare(b.SystemModstamp) || a.Id.localeCompare(b.Id))
        .map((r) => ({ attributes: { type: object, url: `${API}/sobjects/${object}/${r.Id}` }, ...Object.fromEntries(fields.map((f) => [f, r[f] ?? null])) }) as unknown as Rec);
      const id = alnum(8);
      queryResults.set(id, rows);
      return json(res, 200, page(id, 0));
    }
    const more = new RegExp(`^${API}/query/01gFAKE([A-Z0-9]+)-(\\d+)$`).exec(url.pathname);
    if (more && req.method === 'GET') return json(res, 200, page(more[1]!, Number(more[2])));

    const describe = new RegExp(`^${API}/sobjects/(\\w+)/describe$`).exec(url.pathname);
    if (describe && req.method === 'GET') {
      const fields = DESCRIBE[describe[1] as ObjectName];
      if (!fields) return json(res, 404, [{ message: `The requested resource does not exist`, errorCode: 'NOT_FOUND' }]);
      return json(res, 200, { name: describe[1], label: describe[1], fields });
    }

    if (url.pathname === `${API}/composite/sobjects` && (req.method === 'POST' || req.method === 'PATCH')) {
      const body = JSON.parse(await readBody(req)) as { allOrNone?: boolean; records: Record<string, unknown>[] };
      state.compositeCalls.push({ method: req.method, records: body.records.length });
      if (state.failComposite > 0) {
        state.failComposite--;
        return json(res, state.failStatus, [{ message: 'An unexpected error occurred.', errorCode: 'UNKNOWN_EXCEPTION' }]);
      }
      if (body.records.length > 200) return json(res, 400, [{ message: 'Maximum 200 records', errorCode: 'EXCEEDED_ID_LIMIT' }]);
      if (req.method === 'POST') {
        return json(res, 200, body.records.map((r) => {
          const type = (r.attributes as { type?: string } | undefined)?.type;
          if (type !== 'Task') return { success: false, errors: [{ statusCode: 'INVALID_TYPE', message: 'only Task in the fake', fields: [] }] };
          if (state.rejectWhoIds.has(String(r.WhoId))) return { success: false, errors: [{ statusCode: 'INVALID_CROSS_REFERENCE_KEY', message: 'invalid cross reference id', fields: ['WhoId'] }] };
          const id = `00T${alnum(15)}`;
          const { attributes: _a, ...fields } = r;
          state.tasks.push({ Id: id, ...fields });
          return { id, success: true, errors: [] };
        }));
      }
      return json(res, 200, body.records.map((r) => {
        const type = (r.attributes as { type?: ObjectName } | undefined)?.type;
        const target = type ? state.records[type]?.find((x) => x.Id === r.Id) : undefined;
        if (!target) return { id: r.Id, success: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted', fields: [] }] };
        const { attributes: _a, Id: _id, ...fields } = r;
        Object.assign(target, fields, { SystemModstamp: sfDate(new Date(modstamp += 1000)) });
        return { id: target.Id, success: true, errors: [] };
      }));
    }
    return json(res, 404, [{ message: 'The requested resource does not exist', errorCode: 'NOT_FOUND' }]);
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    state,
    /** Adds a record with a fresh Id and a SystemModstamp one second after the previous change. */
    add(object: ObjectName, fields: Record<string, unknown>): Rec {
      const rec = { Id: `${object === 'Contact' ? '003' : '00Q'}${alnum(15)}`, ...fields, SystemModstamp: sfDate(new Date(modstamp += 1000)) } as Rec;
      state.records[object].push(rec);
      return rec;
    },
    update(object: ObjectName, id: string, fields: Record<string, unknown>) {
      const rec = state.records[object].find((r) => r.Id === id)!;
      Object.assign(rec, fields, { SystemModstamp: sfDate(new Date(modstamp += 1000)) });
      return rec;
    },
    /** Invalidates every access token, so the next call gets 401 INVALID_SESSION_ID. */
    expireSessions() { accessTokens.clear(); },
    /** Every token value this server issued, to check none of them leaks. */
    issuedSecrets() { return [clientSecret, ...issued]; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeSalesforce = Awaited<ReturnType<typeof startFakeSalesforce>>;
