import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberToAttributes, canSend, eventToTrack } from '../src/index.js';

const member = {
  memberId: 'MBR-1',
  identifiers: [{ system: 'urn:purenet:member-id', value: 'MBR-1' }],
  givenName: 'Test',
  familyName: 'Member',
  preferredLanguage: 'ar',
  contactPoints: [
    { channel: 'email', value: 'old@example.com', verified: false },
    { channel: 'email', value: 'test@example.com', verified: true },
    { channel: 'sms', value: '+971500000001', verified: true },
  ],
  updatedAt: '2026-01-01T08:00:00Z',
};

test('member → attributes keeps only what engagement needs and skips unverified contacts', () => {
  const attrs = memberToAttributes(member, [
    { channel: 'email', purpose: 'care', status: 'granted' },
    { channel: 'email', purpose: 'marketing', status: 'denied' },
  ]);
  assert.deepEqual(attrs, {
    external_id: 'MBR-1', email: 'test@example.com', phone: '+971500000001', first_name: 'Test', preferred_language: 'ar',
    consent: { email: { care: 'granted', marketing: 'denied' } }, purenet_updated_at: '2026-01-01T08:00:00Z',
  });
  assert.equal('familyName' in attrs || 'family_name' in attrs || 'identifiers' in attrs, false);
});

test('canSend only when consent is explicitly granted', () => {
  const attrs = memberToAttributes(member, [{ channel: 'email', purpose: 'care', status: 'granted' }, { channel: 'sms', purpose: 'marketing', status: 'unknown' }]);
  assert.equal(canSend(attrs, 'email', 'care'), true);
  assert.equal(canSend(attrs, 'email', 'marketing'), false); // missing
  assert.equal(canSend(attrs, 'sms', 'marketing'), false); // unknown
  assert.equal(canSend(attrs, 'push', 'care'), false);
});

test('appointment events of every type map to namespaced platform events', () => {
  for (const type of ['appointment.booked', 'appointment.cancelled', 'appointment.reminder_due']) {
    const t = eventToTrack({ id: 'e', type, occurred_at: '2026-01-01T00:00:00Z', data: { id: 'A', memberId: 'M', start: '2026-01-02T00:00:00Z', status: 'booked' } });
    assert.equal(t.events[0].name, `purenet.${type}`);
    assert.equal(t.events[0].idempotency_key, 'purenet:e');
    assert.equal('facility_id' in t.events[0].properties, false);
  }
});
