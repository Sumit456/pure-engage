// Quiet hours in the contact's own time zone, e.g. "21-8" = 21:00–08:00 local.

export function parseWindow(spec: string): { start: number; end: number } {
  const [start, end] = spec.split('-').map(Number) as [number, number];
  return { start, end };
}

export function localHour(at: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(at));
}

export function isQuiet(at: Date, timeZone: string, { start, end }: { start: number; end: number }): boolean {
  if (start === end) return false;
  const h = localHour(at, timeZone);
  return start > end ? h >= start || h < end : h >= start && h < end;
}

/** The first quarter-hour at or after `from` that is outside quiet hours (DST-safe: it checks each step). */
export function nextAllowed(from: Date, timeZone: string, window: { start: number; end: number }): Date {
  if (!isQuiet(from, timeZone, window)) return from;
  const step = 15 * 60_000;
  let t = new Date(Math.ceil(from.getTime() / step) * step);
  for (let i = 0; i < 4 * 25; i++, t = new Date(t.getTime() + step)) {
    if (!isQuiet(t, timeZone, window)) return t;
  }
  return t;
}
