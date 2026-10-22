import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN } from '../playwright.config.ts';

const shots = process.env.PE_E2E_SCREENSHOTS;

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(E2E_ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test('dashboard KPIs and reports reflect sent messages; the chart has a table view', async ({ page }) => {
  await signIn(page);
  const csrf = { 'x-pe-csrf': '1' };
  const tpl = await (await page.request.post('/api/templates', { headers: csrf, data: { name: 'Report check', channel: 'email', purpose: 'care', content: { en: { subject: 'Hi', html: '<p>Hi</p>' } } } })).json();
  const key = (await (await page.request.post('/api/api-keys', { headers: csrf, data: { name: 'reports-e2e' } })).json()).key;
  await page.request.post('/api/v1/messages/send', { headers: { authorization: `Bearer ${key}` }, data: { template_id: tpl.id, recipients: [
    { external_id: 'MBR-TEST-REP-1', email: 'rep1@example.com', attributes: { consent: { email: { care: 'granted' } } } },
    { external_id: 'MBR-TEST-REP-2', email: 'rep2@example.com' },
  ] } });

  await expect(async () => {
    await page.reload();
    expect(Number((await page.getByTestId('kpi-sent').textContent())?.replace(/\D/g, ''))).toBeGreaterThanOrEqual(1);
  }).toPass({ timeout: 15_000 });

  await page.getByRole('navigation').getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByText('Messages sent per day')).toBeVisible();
  await expect(page.locator('.pe-chart__plot svg path').first()).toBeVisible();
  await expect(page.locator('.pe-bars li').filter({ hasText: 'No consent' })).toBeVisible();
  // Keyboard reading of the chart shows a tooltip.
  await page.locator('.pe-chart__plot').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.pe-tooltip')).toContainText('Email');
  if (shots) await page.screenshot({ path: `${shots}/reports.png`, fullPage: true });
  await page.getByRole('button', { name: 'Show table' }).click();
  await expect(page.locator('figure.pe-chart table')).toBeVisible();

  const csv = await page.request.get(`/api/reports/messages.csv?from=${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}`);
  expect(csv.headers()['content-type']).toContain('text/csv');
});

test('settings: API keys are shown once; webhooks record test deliveries', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('tab', { name: 'Delivery' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Sandbox: nothing is sent')).toBeVisible();

  await page.getByRole('tab', { name: 'API keys' }).click();
  await page.getByLabel('Key name').fill('Settings e2e');
  await page.getByRole('button', { name: 'Create API key' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('shown only once');
  const secret = (await dialog.locator('.pe-secret').textContent())!;
  expect(secret).toMatch(/^pe_[A-Za-z0-9]{8}_/);
  await dialog.getByRole('button', { name: "I've saved it" }).click();
  await expect(page.getByText(secret)).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'Settings e2e' })).toBeVisible();

  await page.getByRole('tab', { name: 'Webhooks' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Local receiver');
  await page.getByLabel('URL').fill('http://127.0.0.1:4201/hooks/does-not-exist');
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await expect(page.getByRole('dialog')).toContainText('whsec_');
  await page.getByRole('dialog').getByRole('button', { name: "I've saved it" }).click();
  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'pure_engage.test' }).getByText('Failed')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'pure_engage.test' })).toContainText('404');
  if (shots) await page.screenshot({ path: `${shots}/settings-webhooks.png`, fullPage: true });

  await page.getByRole('tab', { name: 'Audit log' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'webhook.create' })).toBeVisible();
});
