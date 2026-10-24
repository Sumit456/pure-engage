import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { emailTemplate, loginAs, makeContact, makeTemplate, testApp, truncateAll } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => { ctx = await testApp({ PE_CONSOLE_URL: 'https://console.example.com' }); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await truncateAll(ctx.db); });

const SYS = { type: 'system' as const };
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

/** Plays the AI app's side of OAuth: register, authorize (an admin approves in the console), exchange the code. */
async function connect(scopes: string[]) {
  const reg = await ctx.app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude', redirect_uris: [REDIRECT] } });
  expect(reg.statusCode).toBe(201);
  const clientId = reg.json().client_id as string;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', scope: scopes.join(' ') };

  const auth = await ctx.app.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams(params)}` });
  expect(auth.statusCode).toBe(302);
  expect(auth.headers.location).toMatch(/^https:\/\/console\.example\.com\/connect\/authorize\?/);

  const admin = await loginAs(ctx.app, 'admin', `admin-${randomBytes(3).toString('hex')}@example.com`);
  const described = await admin.request({ method: 'GET', url: `/api/oauth/describe?${new URLSearchParams(params)}` });
  expect(described.json()).toMatchObject({ client: { name: 'Claude', redirect_host: 'claude.ai' } });
  const decided = await admin.request({ method: 'POST', url: '/api/oauth/decide', payload: { ...params, approve: true, scopes } });
  const back = new URL(decided.json().redirect);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('st-1');
  const code = back.searchParams.get('code')!;

  const token = await ctx.app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }).toString() });
  expect(token.statusCode).toBe(200);
  return { ...token.json(), clientId, code, verifier, admin } as { access_token: string; refresh_token: string; scope: string; clientId: string; code: string; verifier: string; admin: Awaited<ReturnType<typeof loginAs>> };
}

let rpcId = 0;
async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
    payload: { jsonrpc: '2.0', id: ++rpcId, method, params },
  });
  return { status: res.statusCode, body: res.body ? res.json() : null, headers: res.headers };
}
const callTool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  const result = r.body.result as { content: { text: string }[]; isError?: boolean };
  return { ...result, data: result.isError ? null : JSON.parse(result.content[0]!.text) };
};

test('discovery: MCP asks for OAuth and points at the metadata', async () => {
  const anon = await ctx.app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  expect(anon.statusCode).toBe(401);
  expect(anon.headers['www-authenticate']).toBe('Bearer resource_metadata="https://engage.example.com/.well-known/oauth-protected-resource/mcp"');
  const prm = (await ctx.app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' })).json();
  expect(prm).toMatchObject({ resource: 'https://engage.example.com/mcp', authorization_servers: ['https://engage.example.com'] });
  const as = (await ctx.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
  expect(as).toMatchObject({ token_endpoint: 'https://engage.example.com/oauth/token', code_challenge_methods_supported: ['S256'], registration_endpoint: 'https://engage.example.com/oauth/register' });
  expect(as.scopes_supported).not.toContain('messages:send');

  const pre = await ctx.app.inject({ method: 'OPTIONS', url: '/mcp', headers: { origin: 'https://inspector.example.com', 'access-control-request-method': 'POST' } });
  expect(pre.statusCode).toBe(204);
  expect(pre.headers['access-control-allow-origin']).toBe('*');
  expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { origin: 'https://evil.example.com' } })).headers['access-control-allow-origin']).toBeUndefined();
});

test('OAuth: PKCE, single-use codes, rotating refresh tokens, revocation; only https or loopback redirects', async () => {
  expect((await ctx.app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['http://evil.example.com/cb'] } })).json().error).toBe('invalid_redirect_uri');
  expect((await ctx.app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['http://127.0.0.1:6274/oauth/callback'] } })).statusCode).toBe(201);

  const t = await connect(['reports:read']);
  expect(t.scope).toBe('reports:read');
  const exchange = (extra: Record<string, string>) => ctx.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', client_id: t.clientId, redirect_uri: REDIRECT, ...extra } });
  expect((await exchange({ code: t.code, code_verifier: t.verifier })).json().error).toBe('invalid_grant'); // used already

  const refreshed = await ctx.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId } });
  expect(refreshed.statusCode).toBe(200);
  const next = refreshed.json();
  expect(next.access_token).not.toBe(t.access_token);
  expect((await rpc(t.access_token, 'tools/list')).status).toBe(401); // old access token replaced
  expect((await ctx.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: t.refresh_token } })).json().error).toBe('invalid_grant');
  expect((await rpc(next.access_token, 'tools/list')).status).toBe(200);

  const grants = (await t.admin.request({ method: 'GET', url: '/api/oauth/grants' })).json().data;
  expect(grants[0]).toMatchObject({ client_name: 'Claude', scopes: ['reports:read'] });
  await t.admin.request({ method: 'DELETE', url: `/api/oauth/grants/${grants[0].id}` });
  expect((await rpc(next.access_token, 'tools/list')).status).toBe(401);

  const other = await connect(['segments:read']);
  expect(other.access_token).toMatch(/^pe_at_/);

  // A wrong verifier fails PKCE; permissions outside the AI set (e.g. sending) can't be granted.
  const challenge = createHash('sha256').update('right-verifier-right-verifier-right-verifier').digest('base64url');
  const params = { response_type: 'code', client_id: other.clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' };
  const sendScope = await other.admin.request({ method: 'POST', url: '/api/oauth/decide', payload: { ...params, approve: true, scopes: ['messages:send'] } });
  expect(sendScope.statusCode).toBe(400);
  const ok = (await other.admin.request({ method: 'POST', url: '/api/oauth/decide', payload: { ...params, approve: true, scopes: ['reports:read'] } })).json();
  const code = new URL(ok.redirect).searchParams.get('code')!;
  const wrong = await ctx.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', code, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier', client_id: other.clientId, redirect_uri: REDIRECT } });
  expect(wrong.json()).toMatchObject({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
  const denied = (await other.admin.request({ method: 'POST', url: '/api/oauth/decide', payload: { ...params, approve: false, state: 's' } })).json();
  expect(new URL(denied.redirect).searchParams.get('error')).toBe('access_denied');
  const audits = await ctx.db.selectFrom('audit_log').select('action').where('action', 'like', 'oauth.%').execute();
  expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['oauth.approve', 'oauth.revoke']));
  const marketer = await loginAs(ctx.app, 'marketer');
  expect((await marketer.request({ method: 'POST', url: '/api/oauth/decide', payload: { client_id: other.clientId, approve: true } })).statusCode).toBe(403);
});

test('tools follow the granted scopes, and nothing can send, schedule or activate', async () => {
  const readOnly = await connect(['reports:read', 'segments:read', 'campaigns:read', 'contacts:read']);
  const init = await rpc(readOnly.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  expect(init.body.result.serverInfo.name).toBe('pure-engage');
  expect(init.body.result.instructions).toContain('cannot send');
  const names = (await rpc(readOnly.access_token, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name);
  expect(names).toEqual(expect.arrayContaining(['get_overview', 'list_campaigns', 'list_segments', 'count_audience', 'search_contacts', 'get_contact']));
  expect(names.filter((n: string) => n.startsWith('create_'))).toEqual([]);

  const drafts = await connect(['drafts:write']);
  const all = (await rpc(drafts.access_token, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name);
  expect(all).toEqual(expect.arrayContaining(['create_segment', 'create_email_template', 'create_sms_template', 'create_campaign_draft', 'create_push_draft', 'create_whatsapp_draft', 'list_content']));
  const wa = await callTool(drafts.access_token, 'create_whatsapp_draft', { name: 'AI WhatsApp', purpose: 'care', body: 'Hello {{ contact.first_name }}', quick_replies: ['Yes', 'No'] });
  expect(wa.data.console_url).toContain('/content/whatsapp/');
  expect((await callTool(drafts.access_token, 'list_content', { type: 'whatsapp' })).data.items[0]).toMatchObject({ type: 'whatsapp', name: 'AI WhatsApp' });
  for (const n of [...names, ...all]) expect(n).not.toMatch(/send|schedule|launch|activate|delete/);
});

test('contact tools are masked and audited; drafts are created as drafts', async () => {
  const c = await makeContact(ctx.app, { external_id: 'MBR-TEST-8001', email: 'mcp.member@example.com', first_name: 'Mona', last_name: 'Test', consent: { email: { marketing: 'granted' } }, condition: 'synthetic' });
  const tpl = await makeTemplate(ctx.app, { ...emailTemplate(), purpose: 'marketing' });
  const t = await connect(['contacts:read', 'segments:read', 'campaigns:read', 'drafts:write']);

  const got = await callTool(t.access_token, 'get_contact', { external_id: 'MBR-TEST-8001' });
  expect(got.data).toMatchObject({ id: c.id, email: 'm***@example.com', first_name: 'M.', masked: true, console_url: `https://console.example.com/contacts/${c.id}` });
  expect(got.content[0]!.text).not.toContain('synthetic');
  const found = await callTool(t.access_token, 'search_contacts', { query: 'Mona' });
  expect(found.data).toHaveLength(1);
  expect(JSON.stringify(found.data)).not.toContain('mcp.member@example.com');
  const audits = await ctx.db.selectFrom('audit_log').selectAll().where('action', 'in', ['contact.view', 'contact.search']).orderBy('at').execute();
  expect(audits.map((a) => [a.action, a.actor_type, a.details])).toEqual([
    ['contact.view', 'integration', { via: 'mcp', pii: false }],
    ['contact.search', 'integration', { via: 'mcp', results: 1, pii: false }],
  ]);
  expect(audits[0]!.actor_id).toMatch(/^oauth:/);
  expect((await callTool(t.access_token, 'get_contact', { external_id: 'MBR-TEST-NOPE' })).isError).toBe(true);

  const audience = { match: 'all', conditions: [{ type: 'consent', channel: 'email', purpose: 'marketing', status: 'granted' }] };
  expect((await callTool(t.access_token, 'count_audience', audience)).data).toEqual({ count: 1 });
  const seg = (await callTool(t.access_token, 'create_segment', { name: 'Email marketing opt-ins', ...audience })).data;
  const draft = await callTool(t.access_token, 'create_campaign_draft', { name: 'AI drafted', template_id: tpl.id, segment_id: seg.id });
  expect(draft.data).toMatchObject({ status: 'draft', console_url: expect.stringContaining('/campaigns/') });
  const row = await ctx.db.selectFrom('campaigns').selectAll().where('id', '=', draft.data.id).executeTakeFirstOrThrow();
  expect(row.status).toBe('draft');
  expect(row.scheduled_at).toBeNull();
  expect(await ctx.db.selectFrom('messages').select('id').execute()).toEqual([]);

  const email = await callTool(t.access_token, 'create_email_template', {
    name: 'AI newsletter', purpose: 'marketing', subject: 'Healthy habits', heading: 'Small steps', paragraphs: ['Hello {{ contact.first_name | default: \'there\' }},', '<script>alert(1)</script> Stay **active**.'],
    button: { label: 'Book a check-up', url: 'https://example.com/book' },
  });
  const created = await ctx.app.services.templates.get(email.data.id);
  const html = (created.content as { en: { html: string; design?: unknown } }).en;
  expect(html.html).not.toContain('<script>');
  expect(html.html).toContain('<strong>active</strong>');
  expect(html.design).toBeTruthy();
  expect((await callTool(t.access_token, 'create_campaign_draft', { name: 'Bad', template_id: tpl.id, segment_id: '00000000-0000-4000-8000-000000000000' })).isError).toBe(true);

  // Calls are logged by method and tool name, against the connection.
  await new Promise((r) => setTimeout(r, 50));
  const log = await ctx.db.selectFrom('integration_requests').selectAll().where('oauth_grant_id', 'is not', null).orderBy('id').execute();
  expect(log.filter((l) => l.route === '/mcp tools/call get_contact')).toHaveLength(2); // found + not found
  expect(log.map((l) => l.route)).not.toContain('/mcp');
  expect(JSON.stringify(log)).not.toContain('MBR-TEST-8001');
});

test('full personal details only with contacts:read_pii; API keys work on /mcp too', async () => {
  await makeContact(ctx.app, { external_id: 'MBR-TEST-8002', email: 'pii.member@example.com', first_name: 'Pia' });
  const t = await connect(['contacts:read', 'contacts:read_pii']);
  expect((await callTool(t.access_token, 'get_contact', { external_id: 'MBR-TEST-8002' })).data).toMatchObject({ email: 'pii.member@example.com', masked: false });

  const key = (await ctx.app.services.auth.createApiKey({ name: 'Local agent', scopes: ['reports:read'] }, SYS)).key;
  expect((await callTool(key, 'get_overview')).data).toMatchObject({ contacts: 1 });
  const names = (await rpc(key, 'tools/list')).body.result.tools.map((x: { name: string }) => x.name);
  expect(names).not.toContain('get_contact');
});

test('the official MCP client connects over HTTP and calls tools', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const key = (await ctx.app.services.auth.createApiKey({ name: 'SDK client', scopes: ['reports:read', 'campaigns:read'] }, SYS)).key;
  const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const client = new Client({ name: 'pure-engage-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['get_overview', 'list_campaigns', 'list_templates']));
  expect(tools.find((t) => t.name === 'get_overview')?.annotations?.readOnlyHint).toBe(true);
  const res = await client.callTool({ name: 'list_campaigns', arguments: {} });
  expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toEqual([]);
  await client.close();
});
