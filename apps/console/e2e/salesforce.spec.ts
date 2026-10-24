import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN } from '../playwright.config.ts';
import { startFakeSalesforce, type FakeSalesforce } from '../../api/test/fake-salesforce.ts';

// The whole Salesforce journey against the local fake (never a real org): the API runs with
// PE_SALESFORCE_ALLOW_ANY_HOST=true (playwright.config.ts) so the fake's http://127.0.0.1 host is accepted.
const shots = process.env.PE_E2E_SCREENSHOTS;
const API = 'http://127.0.0.1:4201';

let fake: FakeSalesforce;
test.beforeAll(async () => { fake = await startFakeSalesforce({ pageSize: 2 }); });
test.afterAll(async () => { await fake?.close(); });

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(E2E_ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test('Salesforce: set up the Connected App, connect with PKCE, map fields, sync, see the log and disconnect', async ({ page }) => {
  const ana = fake.add('Contact', { Email: 'sf.e2e.ana@example.com', FirstName: 'Ana', LastName: 'E2e', MobilePhone: '+971500000301', Title: 'Engineer', Marketing_Opt_In__c: true });
  fake.add('Contact', { Email: 'sf.e2e.ben@example.com', FirstName: 'Ben', LastName: 'E2e', HasOptedOutOfEmail: true });
  fake.add('Contact', { Email: 'sf.e2e.cy@example.com', FirstName: 'Cy', LastName: 'E2e', Phone: '050 not a number' });

  await signIn(page);
  await page.goto('/integrations');
  await expect(page.getByTestId('card-salesforce')).toContainText('Not set up');
  await page.getByTestId('card-salesforce').click();
  await expect(page.getByRole('heading', { name: 'Salesforce', level: 1 })).toBeVisible();

  // 1. Connected App instructions with the exact callback URL and scopes.
  await expect(page.locator('.pe-copyfield').filter({ hasText: 'Callback URL' })).toContainText(`${API}/oauth/salesforce/callback`);
  await expect(page.locator('.pe-copyfield').filter({ hasText: 'OAuth scopes' })).toContainText('api refresh_token offline_access');
  await expect(page.getByRole('button', { name: 'Connect with Salesforce' })).toBeDisabled();

  // 2. App details. A non-Salesforce host would be refused without the dev flag; the fake is allowed here.
  await page.getByLabel('Login host').selectOption('custom');
  await page.getByLabel('My Domain host').fill(fake.url);
  await page.getByLabel('Consumer key').fill(fake.state.clientId);
  await page.getByLabel('Consumer secret').fill(fake.state.clientSecret);
  await page.getByRole('button', { name: 'Save app details' }).click();
  await expect(page.getByText('Saved and encrypted. Leave empty to keep it.')).toBeVisible();
  await expect(page.getByLabel('Consumer secret')).toHaveValue('');

  // 3. Connect: the browser goes to the fake's authorize page, back to the API callback, then to this wizard.
  await page.getByRole('button', { name: 'Connect with Salesforce' }).click();
  await expect(page).toHaveURL(/\/integrations\/salesforce\?connected=1$/);
  await expect(page.getByRole('status').filter({ hasText: 'Salesforce is connected' })).toBeVisible();
  await expect(page.locator('.pe-dl').first()).toContainText('integration.user@example.com');
  await expect(page.locator('.pe-dl').first()).toContainText('00DFAKE000000000001');
  expect(fake.state.tokenGrants).toEqual(['authorization_code']);

  // 4. Mapping from describe: an extra field and a consent checkbox.
  const contact = page.getByTestId('sf-object-Contact');
  await expect(contact.getByLabel('Identity field')).toHaveValue('Id');
  await contact.getByRole('button', { name: 'Add a field' }).click();
  await contact.locator('.pe-pairrow').last().getByLabel('Salesforce field').selectOption('Title');
  await contact.locator('.pe-pairrow').last().getByLabel('Attribute name').fill('job_title');
  await contact.getByRole('button', { name: 'Add a consent field' }).click();
  await contact.locator('.pe-pairrow').last().getByLabel('Salesforce field').selectOption('Marketing_Opt_In__c');
  await expect(contact.getByLabel('Unticked means denied')).not.toBeChecked();
  await page.getByLabel('Sync every').selectOption('30');
  await page.getByRole('button', { name: 'Save sync settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

  // 5. Sync now: counts, the request log and the contacts themselves.
  await page.getByRole('button', { name: 'Sync now' }).click();
  // The background worker may already have run the first pull, so only check that a run was recorded.
  await expect(page.getByTestId('sf-counts-Contact')).toBeVisible();
  await expect(page.getByTestId('sf-last-sync')).not.toHaveText('Not yet');
  // The scheduled worker may also have synced by now, so there can be more than one pull row.
  await expect(page.getByRole('row').filter({ hasText: 'SYNC salesforce pull Contact' }).first()).toContainText('200');
  await expect(page.getByRole('row').filter({ hasText: 'POST salesforce oauth token' }).first()).toBeVisible();
  await page.getByRole('tab', { name: /Pending/ }).click();
  await expect(page.getByText('Nothing here')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/integrations-salesforce.png`, fullPage: true });

  await page.goto(`/contacts?q=${ana.Id}`);
  await expect(page.getByRole('row').filter({ hasText: ana.Id })).toBeVisible();

  // Disconnect revokes the token at Salesforce.
  await page.goto('/integrations/salesforce');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('button', { name: 'Connect with Salesforce' })).toBeEnabled();
  await expect(page.locator('.pe-page-header')).toContainText('Not connected');
  expect(fake.state.revoked).toHaveLength(1);

  await page.goto('/integrations');
  await expect(page.getByTestId('card-salesforce')).toContainText('Not set up');
});
