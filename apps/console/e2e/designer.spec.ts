import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN } from '../playwright.config.ts';

const shots = process.env.PE_E2E_SCREENSHOTS;
// A small synthetic PNG (1x1, transparent).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(E2E_ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test('design an email with blocks and an uploaded image, save it, and it reopens in the designer', async ({ page }) => {
  await signIn(page);
  await page.goto('/templates/new');
  await page.getByLabel('Name', { exact: true }).fill('Designed wellness email');

  // New email templates open in the designer with a starter layout.
  const email = page.locator('.pe-designer__email');
  await expect(email.locator('.pe-eb-wrap')).toHaveCount(5);
  await page.getByLabel('Subject', { exact: true }).fill('Your wellness week, {{ contact.first_name }}');

  // Edit the heading.
  await email.locator('.pe-eb-wrap[data-block="heading"]').click();
  await page.getByRole('complementary', { name: 'Block settings' }).getByLabel('Text', { exact: true }).fill('Spring wellness week');
  await expect(email).toContainText('Spring wellness week');

  // Add an image block after the heading and upload an image into it.
  await page.getByRole('button', { name: 'Image', exact: true }).click();
  await expect(email.locator('.pe-eb-wrap')).toHaveCount(6);
  await page.getByLabel('Upload an image').setInputFiles({ name: 'clinic.png', mimeType: 'image/png', buffer: PNG });
  const img = email.locator('.pe-eb-wrap[data-block="image"] img');
  await expect(img).toHaveAttribute('src', /^\/a\/[0-9a-f-]{36}$/);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1);
  await page.getByLabel(/Alternative text/).fill('Our clinic');

  // Reorder: move the image above the heading.
  await page.getByRole('button', { name: 'Move up' }).click();
  await expect(email.locator('.pe-eb-wrap').nth(1)).toHaveAttribute('data-block', 'image');
  if (shots) await page.screenshot({ path: `${shots}/designer.png`, fullPage: true });

  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);

  // The preview is the real rendered email: personalised, with the image.
  const preview = page.frameLocator('iframe.pe-preview');
  await expect(preview.locator('h1')).toHaveText('Spring wellness week');
  await expect(preview.locator('img[alt="Our clinic"]')).toHaveAttribute('src', /\/a\/[0-9a-f-]{36}$/);

  await page.reload();
  await expect(page.locator('.pe-designer__email .pe-eb-wrap')).toHaveCount(6);
});
