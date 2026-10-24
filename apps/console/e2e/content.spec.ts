import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN } from '../playwright.config.ts';

const shots = process.env.PE_E2E_SCREENSHOTS;
// Synthetic files: just enough bytes for each format.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4), Buffer.from('isommp41'), Buffer.alloc(2000, 7)]);

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(E2E_ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test('content library: folders, uploads of images, PDFs and video, previews, moving, and refused file types', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Content' }).click();
  await expect(page.getByRole('heading', { name: 'Content', level: 1 })).toBeVisible();

  // Work inside fresh folders: other tests add their own content to the library.
  const tree = page.getByRole('complementary', { name: 'Folders' });
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Ramadan 2027');
  await tree.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.pe-library__meta')).toContainText('Ramadan 2027');
  await page.getByRole('button', { name: 'New folder' }).click();
  await expect(tree).toContainText('New folder inside Ramadan 2027');
  await page.getByLabel('Folder name').fill('Videos');
  await tree.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.pe-library__meta')).toContainText('Videos');
  await tree.getByRole('button', { name: /^Ramadan 2027/ }).click();

  // Uploads land in the open folder; unsupported types are refused per file.
  await page.getByLabel('Upload files').setInputFiles([
    { name: 'hero.png', mimeType: 'image/png', buffer: PNG },
    { name: 'Health guide.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: 'Intro.mp4', mimeType: 'video/mp4', buffer: MP4 },
    { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
  ]);
  await expect(page.locator('.pe-uploads li[data-state="error"]')).toContainText('logo.svg');
  await expect(page.locator('.pe-tile')).toHaveCount(3);

  // Preview drawer for a file, with its public link and where it's used.
  await page.getByRole('button', { name: 'Document: Health guide.pdf' }).click();
  const drawer = page.getByRole('complementary', { name: 'Details' });
  await expect(drawer).toContainText('application/pdf');
  await expect(drawer.getByText('Not used in any current content.')).toBeVisible();
  await page.getByRole('button', { name: 'Video: Intro.mp4' }).click();
  await expect(drawer.locator('video')).toBeVisible();

  // Move the video into the subfolder.
  await page.getByLabel('Select Intro.mp4').check();
  await page.getByLabel('Move to…').selectOption({ label: '\u00a0\u00a0Videos' });
  await expect(page.locator('.pe-tile')).toHaveCount(2);
  await tree.getByRole('button', { name: /^Videos/ }).click();
  await expect(page.locator('.pe-tile')).toHaveCount(1);
  await expect(page.locator('.pe-tile')).toContainText('Intro.mp4');
  await tree.getByRole('button', { name: /^Ramadan 2027/ }).click();
  await page.getByRole('button', { name: 'Images' }).click();
  await expect(page.locator('.pe-tile')).toHaveCount(1);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: 'Document: Health guide.pdf' }).click();
  if (shots) await page.screenshot({ path: `${shots}/content-library.png`, fullPage: true });
});

test('push and WhatsApp messages: author with library media and live phone previews', async ({ page }) => {
  await signIn(page);
  await page.goto('/content');
  // Different bytes from the earlier test's image (identical files are stored once, under the first name).
  await page.getByLabel('Upload files').setInputFiles([{ name: 'offer.png', mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.from('offer')]) }]);
  await expect(page.locator('.pe-tile').filter({ hasText: 'offer.png' })).toBeVisible();

  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('menuitem', { name: /^Push/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('Check-up reminder');
  await page.getByLabel('Title', { exact: true }).fill('Hi {{ contact.first_name }}, time for a check-up');
  await page.getByLabel('Message', { exact: true }).fill('Book your annual check-up in two taps.');
  await page.getByLabel('Opens (app link or URL)').fill('pura://appointments');
  await page.getByRole('button', { name: /Use offer\.png/ }).click();
  const push = page.getByTestId('push-preview');
  await expect(push).toContainText('Hi Test, time for a check-up');
  await expect(push.locator('img')).toBeVisible();
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page).toHaveURL(/\/content\/push\/[0-9a-f-]{36}$/);
  await expect(push).toContainText('Hi Test, time for a check-up');
  if (shots) await page.screenshot({ path: `${shots}/content-push.png`, fullPage: true });

  await page.goto('/content/whatsapp/new');
  await page.getByLabel('Name', { exact: true }).fill('Wellness guide');
  await page.getByLabel('Header', { exact: true }).selectOption('image');
  await page.getByRole('button', { name: /Use offer\.png/ }).click();
  await page.getByLabel('Message', { exact: true }).fill('Hello {{ contact.first_name }}, your *wellness guide* is ready.');
  await page.getByLabel('Footer (optional)').fill('Reply STOP to opt out');
  await page.getByRole('button', { name: 'Add button' }).click();
  await page.getByLabel('Button text').fill('Show me');
  const wa = page.getByTestId('wa-preview');
  await expect(wa).toContainText('Hello Test, your *wellness guide* is ready.');
  await expect(wa).toContainText('Show me');
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page).toHaveURL(/\/content\/whatsapp\/[0-9a-f-]{36}$/);
  await expect(wa).toContainText('Hello Test, your *wellness guide* is ready.');
  if (shots) await page.screenshot({ path: `${shots}/content-whatsapp.png`, fullPage: true });

  // The image is now in use, so it can't be deleted from the library.
  await page.goto('/content?type=images');
  await page.getByRole('button', { name: 'Image: offer.png' }).click();
  const drawer = page.getByRole('complementary', { name: 'Details' });
  await expect(drawer.getByRole('link', { name: 'Wellness guide' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Delete' }).click();
  await expect(drawer.getByRole('alert')).toContainText('used in');
});

test('save a designer block as a content block and insert it into another email', async ({ page }) => {
  await signIn(page);
  await page.goto('/content/email/new');
  const email = page.locator('.pe-designer__email');
  await email.locator('.pe-eb-wrap[data-block="footer"]').click();
  await page.getByRole('button', { name: 'Save as content block' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Standard clinic footer');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  const saved = page.getByRole('complementary', { name: 'Blocks' }).getByRole('button', { name: 'Standard clinic footer' });
  await expect(saved).toBeVisible();
  await saved.click();
  await expect(email.locator('.pe-eb-wrap[data-block="footer"]')).toHaveCount(2);

  await page.goto('/content?type=blocks');
  await expect(page.locator('.pe-tile').filter({ hasText: 'Standard clinic footer' })).toBeVisible();
});
