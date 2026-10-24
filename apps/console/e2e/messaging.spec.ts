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

test('build a bilingual SMS template, send it through the API and follow it in the outbox', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('status').filter({ hasText: 'Sandbox mode' })).toBeVisible();

  // Template editor with live preview and SMS segment counter.
  await page.getByRole('navigation').getByRole('link', { name: 'Content' }).click();
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('menuitem', { name: /^SMS/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('Appointment reminder (SMS)');
  await expect(page.getByLabel('Channel')).toHaveValue('sms');
  await page.getByLabel('Message', { exact: true }).fill('Hi {{ contact.first_name }}, your appointment is on {{ data.date }}. Reply STOP to opt out.');
  await expect(page.getByTestId('sms-counter')).toContainText('GSM-7');
  await expect(page.locator('.pe-sms-bubble')).toContainText('Hi Test, your appointment is on 12 January 2026, 9:30.');
  await page.getByRole('tab', { name: /العربية/ }).click();
  await page.getByLabel('Message', { exact: true }).fill('مرحبًا {{ contact.first_name }}، موعدك في {{ data.date }}.');
  await expect(page.getByTestId('sms-counter')).toContainText('UCS-2');
  await expect(page.locator('.pe-sms-bubble')).toHaveText('مرحبًا Test، موعدك في 12 January 2026, 9:30.');
  await expect(page.getByText('No Arabic version yet')).toBeHidden();
  if (shots) await page.screenshot({ path: `${shots}/template-editor.png`, fullPage: true });
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page.getByRole('heading', { name: 'Appointment reminder (SMS)' })).toBeVisible();
  await expect(page.locator('.pe-page-header').getByText('v1', { exact: true })).toBeVisible();
  const templateId = page.url().split('/').pop()!;

  // Send through the public API with a fresh API key (as an integration would).
  const key = (await (await page.request.post('/api/api-keys', { headers: { 'x-pe-csrf': '1' }, data: { name: 'e2e', scopes: ['contacts:write', 'consent:write', 'events:write', 'messages:send'] } })).json()).key as string;
  const send = await page.request.post('/api/v1/messages/send', {
    headers: { authorization: `Bearer ${key}` },
    data: { template_id: templateId, bypass_quiet_hours: true, recipients: [
      { external_id: 'MBR-TEST-SMS-1', phone: '+971500000011', attributes: { first_name: 'Layla', preferred_language: 'ar', consent: { sms: { care: 'granted' } } }, properties: { date: '12/01' } },
      { external_id: 'MBR-TEST-SMS-2', phone: '+971500000012', attributes: { first_name: 'Omar' }, properties: { date: '12/01' } },
    ] },
  });
  expect(send.status()).toBe(201);
  const [ok, blocked] = (await send.json()).results;
  expect(ok.status).toBe('queued');
  expect(blocked).toMatchObject({ status: 'suppressed', reason: 'no_consent' });

  // Outbox: the dispatcher sends the consented one (sandbox); the other is recorded as not sent.
  await page.getByRole('navigation').getByRole('link', { name: 'Messages' }).click();
  await expect(page.getByRole('row').filter({ hasText: '+971500000011' }).getByText('Sent')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('row').filter({ hasText: '+971500000012' }).getByText('No consent')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/messages.png`, fullPage: true });

  await page.getByRole('row').filter({ hasText: '+971500000011' }).getByRole('link').first().click();
  await expect(page.locator('.pe-sms-bubble')).toHaveText('مرحبًا Layla، موعدك في 12/01.');
  await expect(page.locator('dl.pe-dl').getByText('sandbox', { exact: true })).toBeVisible();
});
