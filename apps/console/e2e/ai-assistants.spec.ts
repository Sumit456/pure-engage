import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN } from '../playwright.config.ts';

const shots = process.env.PE_E2E_SCREENSHOTS;
const API = 'http://127.0.0.1:4201';
const REDIRECT = 'http://127.0.0.1:9/oauth/callback'; // the "AI app"; intercepted below

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(E2E_ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test('an AI assistant connects with OAuth: the admin approves read-only access, it calls a tool, then is disconnected', async ({ page }) => {
  await signIn(page);
  await page.goto('/integrations');
  await page.getByTestId('card-ai').click();
  await expect(page.getByText('/mcp', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('No assistants connected yet')).toBeVisible();

  // The assistant registers itself and sends the admin's browser to /oauth/authorize.
  const client = await (await page.request.post(`${API}/oauth/register`, { data: { client_name: 'Claude', redirect_uris: [REDIRECT] } })).json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'e2e-state', scope: 'reports:read campaigns:read contacts:read' });
  let callback: URL | null = null;
  await page.route('http://127.0.0.1:9/**', (route) => { callback = new URL(route.request().url()); return route.fulfill({ status: 200, body: 'connected' }); });
  await page.goto(`${API}/oauth/authorize?${params}`);

  await expect(page.getByRole('heading', { name: 'Claude wants to connect to Pure Engage' })).toBeVisible();
  await expect(page.getByLabel(/Read reports/)).toBeChecked();
  await expect(page.getByLabel(/See full personal details/)).not.toBeChecked();
  await expect(page.getByText('It can never send, schedule or activate')).toBeVisible();
  await page.getByLabel(/Read contacts \(masked\)/).uncheck();
  if (shots) await page.screenshot({ path: `${shots}/ai-consent.png`, fullPage: true });
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => callback?.searchParams.get('state')).toBe('e2e-state');

  const token = await (await page.request.post(`${API}/oauth/token`, { form: { grant_type: 'authorization_code', code: callback!.searchParams.get('code')!, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT } })).json();
  expect(token.scope).toBe('reports:read campaigns:read');
  const mcp = (body: object) => page.request.post(`${API}/mcp`, { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, ...body } });
  const tools = await (await mcp({ method: 'tools/list', params: {} })).json();
  expect(tools.result.tools.map((t: { name: string }) => t.name)).not.toContain('get_contact');
  const overview = await (await mcp({ method: 'tools/call', params: { name: 'get_overview', arguments: {} } })).json();
  expect(JSON.parse(overview.result.content[0].text)).toHaveProperty('contacts');

  await page.goto('/integrations/ai');
  const item = page.locator('.pe-keylist__item').filter({ hasText: 'Claude' });
  await expect(item).toContainText('reports:read');
  await expect(item).not.toContainText('contacts:read');
  await item.getByRole('button', { name: 'Activity' }).click();
  await expect(item.getByRole('row').filter({ hasText: 'tools/call get_overview' })).toContainText('200');
  if (shots) await page.screenshot({ path: `${shots}/ai-assistants.png`, fullPage: true });
  await item.getByRole('button', { name: 'Disconnect' }).click();
  await expect(item).toContainText('Revoked');
  expect((await mcp({ method: 'tools/list', params: {} })).status()).toBe(401);
});
