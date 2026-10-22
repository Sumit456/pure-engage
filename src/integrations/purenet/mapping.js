// PureNet shapes → the platform's own ingest shapes (docs/contracts/platform-ingest.openapi.yaml).
// This is the only place PureNet field names appear outside the client.

export const MEMBER_ID_SYSTEM = 'urn:purenet:member-id'; // A-004: identifier system name is a placeholder

// A-006: take only what engagement needs. Unverified contact points aren't used for sending.
export function memberToAttributes(member, consents = []) {
  const verified = (channel) => member.contactPoints?.find((c) => c.channel === channel && c.verified !== false)?.value;
  return compact({
    external_id: member.memberId, // A-004: memberId is the stable key
    email: verified('email'),
    phone: verified('sms'),
    first_name: member.givenName,
    preferred_language: member.preferredLanguage,
    consent: consentsToAttribute(consents),
    purenet_updated_at: member.updatedAt,
  });
}

// A-007: { email: { care: 'granted', marketing: 'denied' }, ... }. Missing means unknown, which is never treated as granted.
export function consentsToAttribute(consents) {
  const out = {};
  for (const c of consents) (out[c.channel] ??= {})[c.purpose] = c.status;
  return out;
}

export function canSend(attributes, channel, purpose) {
  return attributes.consent?.[channel]?.[purpose] === 'granted';
}

// A-009/A-010/A-014: a PureNet event envelope → platform /track payload.
// The envelope id becomes the idempotency key, so at-least-once redelivery is de-duplicated downstream too.
export function eventToTrack(envelope) {
  const { id, type, occurred_at: time, data = {} } = envelope;
  const base = { name: `purenet.${type}`, time, idempotency_key: `purenet:${id}` };

  if (type.startsWith('appointment.')) {
    return {
      attributes: [],
      events: [{
        ...base,
        external_id: data.memberId,
        properties: compact({ appointment_id: data.id, facility_id: data.facilityId, service_type: data.serviceType, start: data.start, status: data.status }),
      }],
    };
  }
  if (type === 'consent.changed') {
    return {
      attributes: [{ external_id: data.memberId, consent: { [data.channel]: { [data.purpose]: data.status } } }],
      events: [{ ...base, external_id: data.memberId, properties: { channel: data.channel, purpose: data.purpose, status: data.status } }],
    };
  }
  if (type === 'member.updated') {
    return { attributes: [], events: [{ ...base, external_id: data.memberId, properties: { changed_fields: data.changedFields ?? [] } }] };
  }
  return null; // unknown event type: acknowledged but not ingested
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}
