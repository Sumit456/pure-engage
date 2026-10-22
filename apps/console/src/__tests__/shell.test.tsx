import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import i18n from '../i18n/index.ts';
import { routes } from '../App.tsx';

afterEach(async () => { cleanup(); await i18n.changeLanguage('en'); });

const renderAt = (path: string) => render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />);

test('renders the shell with navigation and the dashboard', () => {
  renderAt('/');
  expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Journeys' })).toBeTruthy();
});

test('switching to Arabic translates the UI and sets right-to-left', async () => {
  renderAt('/');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ar' } });
  expect(await screen.findByRole('heading', { name: 'لوحة المعلومات' })).toBeTruthy();
  expect(document.documentElement.dir).toBe('rtl');
  expect(document.documentElement.lang).toBe('ar');
});

test('every nav key has an Arabic translation', async () => {
  const en = (await import('../i18n/en.json')).default;
  const ar = (await import('../i18n/ar.json')).default;
  const keys = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
  expect(keys(ar).sort()).toEqual(keys(en).sort());
});
