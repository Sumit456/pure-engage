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

test('build a segment, send a campaign to it, and see the results', async ({ page }) => {
  await signIn(page);
  const csrf = { 'x-pe-csrf': '1' };
  // Audience: three gold members (two with marketing consent), one silver.
  for (const [i, plan, consent] of [[1, 'gold', 'granted'], [2, 'gold', 'granted'], [3, 'gold', 'denied'], [4, 'silver', 'granted']] as const) {
    await page.request.post('/api/contacts', { headers: csrf, data: { external_id: `MBR-TEST-CMP-${i}`, first_name: `Member ${i}`, email: `cmp${i}@example.com`, plan, consent: { email: { marketing: consent } } } });
  }
  await page.request.post('/api/templates', { headers: csrf, data: { name: 'Spring check-up offer', channel: 'email', purpose: 'marketing', content: { en: { subject: 'Your spring check-up, {{ contact.first_name }}', html: '<p>Book your check-up.</p>' } } } });

  // Segment via the rule builder, with a live count.
  await page.getByRole('navigation').getByRole('link', { name: 'Segments' }).click();
  await page.getByRole('link', { name: 'New segment' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Gold members');
  await page.getByRole('button', { name: '+ Attribute' }).click();
  await page.getByLabel('Attribute name').fill('plan');
  await page.getByLabel('Value', { exact: true }).fill('gold');
  await expect(page.getByTestId('segment-count')).toHaveText('3');
  if (shots) await page.screenshot({ path: `${shots}/segment-builder.png`, fullPage: true });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Gold members' })).toBeVisible();

  // Campaign draft → estimate → send now.
  await page.getByRole('navigation').getByRole('link', { name: 'Campaigns' }).click();
  await page.getByRole('link', { name: 'New campaign' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Spring check-up');
  await page.getByLabel('Template').selectOption({ label: 'Spring check-up offer · Email · Marketing' });
  await page.getByLabel('Segment', { exact: true }).selectOption({ label: 'Gold members (3)' });
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('estimate-eligible')).toHaveText('2');

  await page.getByRole('button', { name: 'Send or schedule' }).click();
  await expect(page.getByRole('dialog')).toContainText('up to 2 contacts');
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();

  // The worker fans out and the sandbox sends; the page refreshes itself.
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('stat-targeted')).toHaveText('3', { timeout: 15_000 });
  await expect(page.getByTestId('stat-sent')).toHaveText('2', { timeout: 15_000 });
  await expect(page.getByTestId('stat-suppressed')).toHaveText('1');
  await expect(page.getByText('No consent: 1')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/campaign-results.png`, fullPage: true });

  await page.getByRole('link', { name: 'See all messages for this campaign →' }).click();
  await expect(page.getByRole('row')).toHaveCount(4); // header + 3
});
