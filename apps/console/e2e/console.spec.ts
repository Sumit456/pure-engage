import { expect, test } from '@playwright/test';
import { E2E_ADMIN } from '../playwright.config.ts';

const shots = process.env.PE_E2E_SCREENSHOTS; // optional folder for review screenshots

test('admin signs in, adds a member, records consent and works in Arabic', async ({ page }) => {
  await page.goto('/contacts');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email', { exact: true }).fill(E2E_ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();

  // Create
  await page.getByRole('button', { name: 'New contact' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Member ID', { exact: true }).fill('MBR-TEST-0001');
  await dialog.getByLabel('First name', { exact: true }).fill('Test');
  await dialog.getByLabel('Last name', { exact: true }).fill('Member');
  await dialog.getByLabel('Email', { exact: true }).fill('test.member@example.com');
  await dialog.getByLabel('Mobile', { exact: true }).fill('0501234567');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText(/E\.164/)).toBeVisible(); // server-side validation surfaces on the field
  await dialog.getByLabel('Mobile', { exact: true }).fill('+971500000001');
  await dialog.getByLabel('Email · Care').selectOption('granted');
  await dialog.getByRole('button', { name: 'Save' }).click();

  // Detail
  await expect(page.getByRole('heading', { name: 'Test Member' })).toBeVisible();
  await expect(page.getByText('Granted').first()).toBeVisible();
  await expect(page.getByText(/Email · Care: Unknown → Granted/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/contact-detail-en.png`, fullPage: true });

  // Edit consent
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('dialog').getByLabel('SMS · Care').selectOption('granted');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/SMS · Care: Unknown → Granted/)).toBeVisible();

  // List + search
  await page.getByRole('link', { name: '← All contacts' }).click();
  await page.getByLabel('Search contacts').fill('member');
  await expect(page.getByRole('link', { name: 'Test Member' })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/contacts-en.png`, fullPage: true });

  // Arabic, right-to-left
  await page.getByLabel('Language').selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'جهات الاتصال' })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/contacts-ar.png`, fullPage: true });
  await page.getByLabel('اللغة').selectOption('en');

  // Sign out (from the account menu)
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/contacts');
  await expect(page).toHaveURL(/\/login$/);
});

test('phone numbers keep their + sign in Arabic', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(E2E_ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  // Own data, so this test also runs on its own (the session cookie is shared with page.request).
  await page.request.post('/api/contacts', { headers: { 'x-pe-csrf': '1' }, data: { external_id: 'MBR-TEST-BIDI', phone: '+971500000001' } });
  await page.getByRole('navigation').getByRole('link', { name: 'Contacts' }).click();
  await page.getByLabel('Language').selectOption('ar');
  const phone = page.locator('bdi.pe-ltr', { hasText: '971500000001' }).first();
  await expect(phone).toBeVisible();
  // The rendered text must start with "+": measure where the "+" glyph is relative to the digits.
  const order = await phone.evaluate((el) => {
    const range = document.createRange();
    const text = el.firstChild!;
    range.setStart(text, 0); range.setEnd(text, 1);
    const plus = range.getBoundingClientRect();
    range.setStart(text, 1); range.setEnd(text, 2);
    const digit = range.getBoundingClientRect();
    return plus.left < digit.left ? 'plus-first' : 'plus-last';
  });
  expect(order).toBe('plus-first');
  if (shots) await page.screenshot({ path: `${shots}/contacts-ar.png`, fullPage: true });
  await page.getByLabel('اللغة').selectOption('en');
});
