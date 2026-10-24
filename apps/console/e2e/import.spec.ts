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

const csv = [
  'Member ID,E-mail,Mobile,First Name,Surname,Language,Email marketing,SMS marketing,Clinic',
  'MBR-TEST-IMP-1,test.import1@example.com,+971500000901,Test,Import One,EN,yes,no,Demo Clinic',
  'MBR-TEST-IMP-2,test.import2@example.com,+971500000902,Test,Import Two,ar,granted,granted,Demo Clinic',
  'MBR-TEST-IMP-3,test.import3@example.com,0500000903,Test,Import Three,en,,,Demo Clinic',
].join('\n');

test('import contacts from a CSV: auto-mapping, dry run with errors, import, history', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Contacts' }).click();
  await page.getByRole('link', { name: 'Import contacts' }).click();
  await expect(page.getByRole('heading', { name: 'Import contacts' })).toBeVisible();

  await page.getByLabel('Choose a CSV or Excel file').setInputFiles({ name: 'members-e2e.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText('3 rows · 9 columns')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Headings are matched automatically; unknown ones become custom attributes.
  await expect(page.getByText('8 of 9 columns matched automatically')).toBeVisible();
  await expect(page.getByLabel('Import column Member ID as')).toHaveValue('external_id');
  await expect(page.getByLabel('Import column Mobile as')).toHaveValue('phone');
  await expect(page.getByLabel('Import column Email marketing as')).toHaveValue('consent.email.marketing');
  await expect(page.getByLabel('Import column Clinic as')).toHaveValue('attribute');
  if (shots) await page.screenshot({ path: `${shots}/import-map.png`, fullPage: true });
  await page.getByRole('button', { name: 'Check file' }).click();

  // Dry run: two new members, one row rejected (not an international number).
  await expect(page.getByRole('button', { name: 'Import 2 members' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: /^4/ })).toContainText('phone');
  if (shots) await page.screenshot({ path: `${shots}/import-review.png`, fullPage: true });
  await page.getByRole('button', { name: 'Import 2 members' }).click();

  const result = page.getByTestId('import-result');
  await expect(result).toContainText('Created');
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'members-e2e.csv' })).toBeVisible();

  // The new member is there, with consent recorded from the file.
  await page.getByRole('link', { name: 'View contacts' }).click();
  await page.getByLabel('Search contacts').fill('IMP-2');
  await page.getByRole('link', { name: 'Test Import Two' }).click();
  await expect(page.getByText('Source: import').first()).toBeVisible();
});

test('import contacts from an Excel workbook', async ({ page }) => {
  await signIn(page);
  await page.goto('/contacts/import');
  await page.getByLabel('Choose a CSV or Excel file').setInputFiles(new URL('./fixtures/members-synthetic.xlsx', import.meta.url).pathname);
  await expect(page.getByText('2 rows · 6 columns')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Import column sms_marketing as')).toHaveValue('consent.sms.marketing');
  await page.getByRole('button', { name: 'Check file' }).click();
  await page.getByRole('button', { name: 'Import 2 members' }).click();
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible();
});
