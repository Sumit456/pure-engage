// Minimal in-memory stand-in for the API, installed as global fetch in component tests.
import { vi } from 'vitest';
import type { Contact, ContactDetail, User } from '../api/types.ts';

export interface FakeState { user: User | null; contacts: ContactDetail[]; calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] }

export const contact = (over: Partial<ContactDetail> = {}): ContactDetail => ({
  id: crypto.randomUUID(), external_id: 'MBR-TEST-0001', email: 'test.member@example.com', phone: '+971500000001',
  first_name: 'Test', last_name: 'Member', preferred_language: 'ar', timezone: 'Asia/Dubai', attributes: {},
  consent: { email: { care: 'granted', marketing: 'denied' } }, created_at: '2026-01-01T08:00:00Z', updated_at: '2026-01-02T08:00:00Z',
  recent_events: [], consent_history: [], ...over,
});

export function installFakeApi(initial: Partial<FakeState> = {}): FakeState {
  const state: FakeState = { user: null, contacts: [], calls: [], ...initial };
  const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ method, url: url.pathname + url.search, headers: (init.headers ?? {}) as Record<string, string>, body });
    const path = url.pathname;

    if (path === '/api/auth/me') return state.user ? json(200, { user: state.user }) : json(401, { error: 'Authentication required' });
    if (path === '/api/auth/login' && method === 'POST') {
      if (body.password !== 'right-password') return json(401, { error: 'Incorrect email or password' });
      state.user = { id: 'u1', email: body.email, name: 'Test Admin', role: 'admin' };
      return json(200, { user: state.user });
    }
    if (path === '/api/auth/logout') { state.user = null; return json(204); }
    if (!state.user) return json(401, { error: 'Authentication required' });

    if (path === '/api/contacts' && method === 'GET') {
      const q = url.searchParams.get('q')?.toLowerCase();
      const data: Contact[] = state.contacts.filter((c) => !q || JSON.stringify(c).toLowerCase().includes(q));
      return json(200, { data, next_cursor: null });
    }
    if (path === '/api/contacts' && method === 'POST') {
      if (body.phone && !String(body.phone).startsWith('+')) return json(400, { error: 'Invalid contact', details: [{ path: 'phone', message: 'phone must be E.164' }] });
      const c = contact({ ...body, attributes: {} });
      state.contacts.push(c);
      return json(201, c);
    }
    const m = /^\/api\/contacts\/([^/]+)$/.exec(path);
    if (m) {
      const c = state.contacts.find((x) => x.id === m[1]);
      if (!c) return json(404, { error: 'Contact not found' });
      return json(200, c);
    }
    return json(404, { error: 'Not found' });
  }));
  return state;
}
