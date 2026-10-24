import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '../i18n/index.ts';
import { contact, installFakeApi } from './fake-api.ts';
import { renderApp } from './render.tsx';

afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await i18n.changeLanguage('en'); });

const admin = { id: 'u1', email: 'admin@example.com', name: 'Test Admin', role: 'admin' as const };
const viewer = { ...admin, role: 'viewer' as const };

test('signed-out users are sent to login; signing in lands on the requested page', async () => {
  const api = installFakeApi();
  const { router } = renderApp('/contacts');
  const email = await screen.findByLabelText('Email');
  fireEvent.change(email, { target: { value: 'admin@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Incorrect email or password.');

  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'right-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('heading', { name: 'Contacts' })).toBeTruthy();
  expect(router.state.location.pathname).toBe('/contacts');
  const login = api.calls.find((c) => c.url === '/api/auth/login')!;
  expect(login.headers['x-pe-csrf']).toBe('1');
});

test('contacts list shows members with their care consent', async () => {
  installFakeApi({ user: admin, contacts: [contact(), contact({ external_id: 'MBR-TEST-0002', first_name: 'Layla', consent: {} })] });
  renderApp('/contacts');
  const table = await screen.findByRole('table');
  const rows = within(table).getAllByRole('row');
  expect(rows).toHaveLength(3);
  expect(within(rows[1]!).getByText('Test Member')).toBeTruthy();
  expect(within(rows[1]!).getByText('Email')).toBeTruthy(); // care consent badge
});

test('viewers cannot see the New contact button', async () => {
  installFakeApi({ user: viewer, contacts: [contact()] });
  renderApp('/contacts');
  await screen.findByRole('table');
  expect(screen.queryByRole('button', { name: 'New contact' })).toBeNull();
});

test('creating a contact shows field errors from the API, then opens the new contact', async () => {
  installFakeApi({ user: admin });
  const { router } = renderApp('/contacts');
  fireEvent.click(await screen.findByRole('button', { name: 'New contact' }));
  fireEvent.change(screen.getByLabelText('Member ID'), { target: { value: 'MBR-TEST-0009' } });
  fireEvent.change(screen.getByLabelText('Mobile'), { target: { value: '0501234567' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('phone must be E.164')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Mobile'), { target: { value: '+971500000009' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/contacts\/[0-9a-f-]+$/));
  expect(await screen.findByRole('heading', { name: 'Consent' })).toBeTruthy();
});

test('contact detail shows the consent matrix and treats missing consent as unknown', async () => {
  const c = contact();
  installFakeApi({ user: admin, contacts: [c] });
  renderApp(`/contacts/${c.id}`);
  await screen.findByRole('heading', { name: 'Test Member' });
  const matrix = screen.getAllByRole('table')[0]!;
  const emailRow = within(matrix).getByRole('row', { name: /Email/ });
  expect(within(emailRow).getByText('Granted')).toBeTruthy();
  expect(within(emailRow).getByText('Denied')).toBeTruthy();
  const smsRow = within(matrix).getByRole('row', { name: /SMS/ });
  expect(within(smsRow).getAllByText('Unknown')).toHaveLength(2);
});

test('unknown contact shows not found', async () => {
  installFakeApi({ user: admin });
  renderApp('/contacts/00000000-0000-0000-0000-000000000000');
  expect(await screen.findByText('Contact not found')).toBeTruthy();
});

test('switching to Arabic translates the UI and sets right-to-left', async () => {
  installFakeApi({ user: admin });
  renderApp('/');
  await screen.findByRole('heading', { name: 'Dashboard' });
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ar' } });
  expect(await screen.findByRole('heading', { name: 'لوحة المعلومات' })).toBeTruthy();
  expect(document.documentElement.dir).toBe('rtl');
  expect(document.documentElement.lang).toBe('ar');
});

test('every English string has an Arabic translation', async () => {
  const en = (await import('../i18n/en.json')).default;
  const ar = (await import('../i18n/ar.json')).default;
  const keys = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
  expect(keys(ar).sort()).toEqual(keys(en).sort());
});
