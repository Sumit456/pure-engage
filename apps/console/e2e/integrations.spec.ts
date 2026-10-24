import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN } from '../playwright.config.ts';

const shots = process.env.PE_E2E_SCREENSHOTS;
const API = 'http://127.0.0.1:4201';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(E2E_ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function closeSecret(page: Page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('shown only once');
  const secret = (await dialog.locator('.pe-secret').textContent())!;
  await dialog.getByRole('button', { name: "I've saved it" }).click();
  await expect(page.getByText(secret)).toHaveCount(0);
  return secret;
}

test('API keys: pick permissions, see the key once, use it, and see the call in the log', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
  await page.getByTestId('card-api').click();

  await page.getByRole('button', { name: 'Create API key' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Key name').fill('Booking system');
  await dialog.getByRole('button', { name: 'AI: read only' }).click();
  await expect(dialog.getByLabel(/Read contacts \(masked\)/)).toBeChecked();
  await expect(dialog.getByLabel(/Record events/)).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Send data in' }).click();
  await dialog.getByLabel(/See full personal details/).check();
  await expect(dialog.getByText('Every read is recorded in the audit log')).toBeVisible();
  await dialog.getByLabel(/See full personal details/).uncheck();
  await dialog.getByRole('button', { name: 'Create API key' }).click();
  const key = await closeSecret(page);
  expect(key).toMatch(/^pe_[A-Za-z0-9]{8}_/);

  const item = page.locator('.pe-keylist__item').filter({ hasText: 'Booking system' });
  await expect(item).toContainText('events:write');
  await expect(item).not.toContainText('contacts:read');

  const ok = await page.request.post('/api/v1/track', { headers: { authorization: `Bearer ${key}` }, data: { events: [{ external_id: 'MBR-TEST-INT-1', name: 'signup' }] } });
  expect(ok.status()).toBe(201);
  const denied = await page.request.get('/api/v1/segments', { headers: { authorization: `Bearer ${key}` } });
  expect(denied.status()).toBe(403);

  await item.getByRole('button', { name: 'Recent requests' }).click();
  await expect(item.getByRole('row').filter({ hasText: 'POST /api/v1/track' })).toContainText('201');
  await expect(item.getByRole('row').filter({ hasText: 'GET /api/v1/segments' })).toContainText('403');
  if (shots) await page.screenshot({ path: `${shots}/integrations-api.png`, fullPage: true });

  await page.getByRole('link', { name: 'API reference' }).click();
  await expect(page.getByText('/contacts/lookup', { exact: true })).toBeVisible();
  await page.getByLabel('Search endpoints').fill('lookup');
  await expect(page.locator('.pe-endpoint')).toHaveCount(1);
});

test('inbound webhook: map a sample payload, then a real delivery creates the contact and event', async ({ page }) => {
  await signIn(page);
  await page.goto('/integrations');
  await page.getByTestId('card-inbound').click();
  await page.getByRole('link', { name: 'New inbound webhook' }).click();

  await page.getByLabel('Name', { exact: true }).fill('Booking tool');
  await page.getByRole('button', { name: 'Use an example' }).click();
  // Obvious fields are mapped automatically.
  await expect(page.getByLabel('External ID')).toHaveValue('patient.member_no');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('patient.email');
  await page.getByRole('button', { name: 'Add consent' }).click();
  await page.locator('.pe-pairrow').last().getByLabel('Field in payload').fill('patient.sms_ok');
  await page.locator('.pe-pairrow').last().getByLabel('Channel').selectOption('sms');
  await page.getByLabel(/Record an event for each record/).check();
  await page.getByLabel('Unique ID').fill('booking.id');
  await page.getByRole('button', { name: 'Add property' }).click();
  await page.locator('.pe-pairrow').last().getByLabel('Property').fill('appointment_id');
  await page.locator('.pe-pairrow').last().getByLabel('Field in payload').fill('booking.id');

  const preview = page.getByRole('complementary', { name: 'What this becomes' });
  await expect(preview).toContainText('Contacts (1)');
  await expect(preview).toContainText('MBR-TEST-0001');
  await expect(preview).toContainText('appointment.booked');
  await expect(preview).toContainText('"sms":{"care":"granted"}');
  if (shots) await page.screenshot({ path: `${shots}/integrations-inbound.png`, fullPage: true });

  await page.getByRole('button', { name: 'Create webhook' }).click();
  const secret = await closeSecret(page);
  expect(secret).toMatch(/^pe_hook_/);
  await expect(page).toHaveURL(/\/integrations\/inbound\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').pop()!;

  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.locator('.pe-connection')).toContainText('1 contacts, 1 events, 0 repeats');

  // A real delivery from the "other app".
  const res = await page.request.post(`${API}/hooks/in/${id}`, {
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    data: { booking: { id: 'APT-TEST-INT-2' }, patient: { member_no: 'MBR-TEST-INT-2', email: 'int2@example.com', sms_ok: 'no' } },
  });
  expect(res.status()).toBe(201);
  expect((await page.request.post(`${API}/hooks/in/${id}`, { headers: { authorization: 'Bearer wrong' }, data: {} })).status()).toBe(401);

  await page.getByText('Recent requests').click();
  await expect(page.locator('.pe-connection').getByRole('row').filter({ hasText: '401' })).toBeVisible();
  await expect(page.locator('.pe-connection').getByRole('row').filter({ hasText: '201' })).toBeVisible();

  await page.goto('/contacts?q=MBR-TEST-INT-2');
  await expect(page.getByRole('row').filter({ hasText: 'MBR-TEST-INT-2' })).toBeVisible();
  await page.goto('/integrations');
  await expect(page.getByTestId('kpi-requests')).not.toHaveText('0');
  if (shots) await page.screenshot({ path: `${shots}/integrations.png`, fullPage: true });
});
