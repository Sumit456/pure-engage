import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '../i18n/index.ts';
import { LineChart } from '../components/LineChart.tsx';

afterEach(cleanup);

const series = [
  { key: 'email', label: 'Email', color: 'blue', values: [0, 2, 0] },
  { key: 'sms', label: 'SMS', color: 'orange', values: [1, 0, 0] },
];

test('end labels are pushed apart when lines finish on the same value', () => {
  const { container } = render(<LineChart title="Sent" labels={['2026-03-01', '2026-03-02', '2026-03-03']} series={series} />);
  const labels = [...container.querySelectorAll('text.pe-chart__label')].map((t) => Number(t.getAttribute('y')));
  expect(labels).toHaveLength(2);
  expect(Math.abs(labels[0]! - labels[1]!)).toBeGreaterThanOrEqual(13);
});

test('keyboard reading shows a tooltip, and the table view holds every value', () => {
  render(<LineChart title="Sent" labels={['2026-03-01', '2026-03-02', '2026-03-03']} series={series} />);
  const plot = screen.getByRole('img');
  fireEvent.keyDown(plot, { key: 'ArrowRight' });
  expect(screen.getByRole('status').textContent).toContain('Email: 0');
  fireEvent.click(screen.getByRole('button', { name: 'Show table' }));
  const cells = [...document.querySelectorAll('tbody td')].map((td) => td.textContent);
  expect(cells).toEqual(['2026-03-01', '0', '1', '2026-03-02', '2', '0', '2026-03-03', '0', '0']);
});
