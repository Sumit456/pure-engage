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

test('appointment reminders: start from the template, simulate, activate, and a PureNet booking starts a run', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Journeys' }).click();
  await page.getByRole('button', { name: 'Start from appointment reminders' }).click();

  await expect(page.getByRole('heading', { name: 'Appointment reminders' })).toBeAttached();
  // The canvas shows the trigger plus the three steps, each with its own card.
  await expect(page.locator('.pe-jnode')).toHaveCount(4);
  await expect(page.locator('.pe-jnode[data-step="confirm"]')).toContainText('Appointment confirmation (email)');
  await expect(page.locator('.pe-jnode[data-step="day_before"]')).toContainText('Wait until');
  await expect(page.locator('.pe-jnode[data-step="remind"]')).toContainText('SMS');
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);
  await expect(page.getByText('No problems found. Ready to activate.')).toBeVisible();

  // Dry run for an appointment in 3 days; the path is numbered on the canvas.
  const start = new Date(Date.now() + 3 * 86_400_000).toISOString();
  await page.getByRole('tab', { name: 'Test run' }).click();
  await page.getByLabel('start', { exact: true }).fill(start);
  await page.getByRole('button', { name: 'Run simulation' }).click();
  const sim = page.getByTestId('simulation');
  await expect(sim.locator('li')).toHaveCount(3);
  await expect(sim.locator('li').nth(1)).toContainText('wait');
  await expect(page.locator('.pe-jnode[data-path]')).toHaveCount(3);
  if (shots) await page.screenshot({ path: `${shots}/journey-builder.png` });

  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page.locator('.pe-jeditor__bar').getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByText('This journey is running.')).toBeVisible();

  // A booking arrives through the ingest API (the same path the PureNet webhook uses).
  const csrf = { 'x-pe-csrf': '1' };
  const key = (await (await page.request.post('/api/api-keys', { headers: csrf, data: { name: 'journey-e2e' } })).json()).key as string;
  const res = await page.request.post('/api/v1/track', {
    headers: { authorization: `Bearer ${key}` },
    data: {
      attributes: [{ external_id: 'MBR-TEST-JRN-1', first_name: 'Layla', email: 'layla.jrn@example.com', phone: '+971500000101', consent: { email: { care: 'granted' }, sms: { care: 'granted' } } }],
      events: [{ external_id: 'MBR-TEST-JRN-1', name: 'purenet.appointment.booked', properties: { appointment_id: 'APT-E2E-1', start }, idempotency_key: 'purenet:evt-e2e-1' }],
    },
  });
  expect(res.status()).toBe(201);

  // The worker enrols the contact and sends the confirmation; the run then waits for the day before.
  await expect(async () => {
    await page.reload();
    await expect(page.locator('.pe-jnode[data-step="confirm"]')).toContainText('sent: 1');
  }).toPass({ timeout: 15_000 });
  await page.getByRole('tab', { name: 'Runs' }).click();
  await expect(page.getByText('In progress').first()).toBeVisible();

  await page.getByRole('link', { name: 'Layla' }).click();
  await expect(page.getByRole('heading', { name: 'Journeys' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Appointment reminders' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Appointment confirmation (email)' }).getByText('Sent')).toBeVisible({ timeout: 10_000 });
});

test('build a journey on the canvas: add steps, branch, save, and the arrangement is kept', async ({ page }) => {
  await signIn(page);
  await page.goto('/journeys/new');
  await expect(page.locator('.pe-jnode--trigger')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Canvas e2e journey');

  // Clicking an activity adds it after the selected step (the first one becomes the start).
  await page.getByRole('button', { name: 'Wait', exact: true }).click();
  await page.getByRole('button', { name: 'Yes / no split', exact: true }).click();
  await page.getByRole('button', { name: 'Wait', exact: true }).click(); // fills the split's "yes" branch
  await expect(page.locator('.pe-jnode')).toHaveCount(4);
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);
  await expect(page.locator('.pe-jnode[data-step^="split_"]')).toContainText('Yes');

  // Selecting a step opens its settings in the inspector.
  await page.locator('.pe-jnode[data-step^="split_"]').click();
  await expect(page.getByRole('complementary', { name: 'Step settings' })).toContainText('If / else');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/journeys\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Saved', { exact: false }).first()).toBeVisible();

  // Drag a card; its new position is saved and comes back after a reload.
  const card = page.locator('.react-flow__node').filter({ has: page.locator('.pe-jnode[data-step^="split_"]') });
  const before = await card.getAttribute('style');
  const box = (await card.boundingBox())!;
  const saved = page.waitForResponse((r) => r.url().endsWith('/layout') && r.request().method() === 'PUT');
  await page.mouse.move(box.x + 40, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 240, box.y + 60, { steps: 8 });
  await page.mouse.up();
  expect((await saved).status()).toBe(200);
  await page.reload();
  await expect(card).toBeVisible();
  expect(await card.getAttribute('style')).not.toBe(before);
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);
});
