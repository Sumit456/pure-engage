// Synthetic demo data for test deployments (PE_SEED_DEMO=true, or `npm run seed:demo`). Every value follows the
// CLAUDE.md patterns: MBR-TEST-* ids, example.com addresses, +971500000xxx numbers, "Test Member" names.
// Runs only on an empty contacts table, so restarting the service never adds a second copy.
import type { Actor } from '../services/audit.ts';
import type { Services } from '../services/index.ts';

const ACTOR: Actor = { type: 'system', id: 'demo-seed' };
const OPTS = { source: 'demo', actor: ACTOR };
const HOUR = 3_600_000;

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** The demo members: alternating languages, and a spread of consent answers so policies have something to refuse. */
export function demoContacts(count = 20) {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const marketing = n % 4 === 0 ? 'denied' : n % 5 === 0 ? undefined : 'granted';
    return {
      external_id: `MBR-TEST-${1000 + n}`,
      email: `test.member${pad(n, 2)}@example.com`,
      phone: `+971500000${pad(n, 3)}`,
      first_name: 'Test',
      last_name: `Member ${n}`,
      preferred_language: n % 2 ? 'en' : 'ar',
      timezone: 'Asia/Dubai',
      consent: {
        email: { care: 'granted', ...(marketing ? { marketing } : {}) },
        sms: { care: n % 3 === 0 ? 'denied' : 'granted', ...(marketing ? { marketing } : {}) },
      },
      membership_tier: ['silver', 'gold', 'platinum'][n % 3],
      visits_last_year: n % 7,
    };
  });
}

/** Seeds the demo data set. Returns false (and does nothing) when contacts already exist. */
export async function seedDemo(services: Services, now: () => Date = () => new Date()): Promise<boolean> {
  const { contacts, templates, segments, campaigns, journeys, events } = services;
  if ((await contacts.list({ limit: 1 })).data.length) return false;

  const members = [];
  for (const c of demoContacts()) members.push((await contacts.upsert(c, OPTS)).contact);

  // A little history for the event-based segment rules and the contact timelines.
  for (const [i, m] of members.entries()) {
    if (i % 3) continue;
    await events.track({ contact_id: m.id, name: 'clinic.visit', properties: { clinic: 'Demo Clinic' }, time: new Date(now().getTime() - (i + 2) * 24 * HOUR).toISOString() }, OPTS);
  }

  const checkup = await templates.create({
    name: 'Wellness check-up offer', channel: 'email', purpose: 'marketing', description: 'Demo marketing email.',
    content: {
      en: { subject: 'Time for your annual check-up, {{ contact.first_name }}', html: '<p>Hello {{ contact.first_name }},</p><p>Book your annual wellness check-up this month.</p><p><a href="https://example.com/book">Book now</a></p><p>{{ brand.name }}</p>' },
      ar: { subject: 'حان وقت فحصك السنوي', html: '<p>مرحبًا {{ contact.first_name }}،</p><p>احجز فحصك الصحي السنوي هذا الشهر.</p><p><a href="https://example.com/book">احجز الآن</a></p><p>{{ brand.name }}</p>' },
    },
  }, ACTOR);
  const sms = await templates.create({
    name: 'Flu vaccine reminder (SMS)', channel: 'sms', purpose: 'marketing', description: 'Demo marketing SMS.',
    content: {
      en: { body: '{{ brand.name }}: flu vaccines are now available at your clinic.' },
      ar: { body: '{{ brand.name }}: لقاحات الإنفلونزا متوفرة الآن في عيادتك.' },
    },
  }, ACTOR);

  const emailOptIn = await segments.create({
    name: 'Email marketing opt-in', description: 'Members who said yes to marketing email.',
    rules: { type: 'group', op: 'and', rules: [{ type: 'consent', channel: 'email', purpose: 'marketing', status: 'granted' }] },
  }, ACTOR);
  const smsOptIn = await segments.create({
    name: 'SMS marketing opt-in', description: 'Members who said yes to marketing SMS.',
    rules: { type: 'group', op: 'and', rules: [{ type: 'consent', channel: 'sms', purpose: 'marketing', status: 'granted' }] },
  }, ACTOR);
  await segments.create({
    name: 'Arabic speakers who visited recently', description: 'Arabic-preferring members with a clinic visit in the last 30 days.',
    rules: { type: 'group', op: 'and', rules: [
      { type: 'field', field: 'preferred_language', op: 'eq', value: 'ar' },
      { type: 'event', name: 'clinic.visit', op: 'at_least', count: 1, within_days: 30 },
    ] },
  }, ACTOR);

  // One email campaign sent now (to the sandbox) so the outbox and reports have data, whatever the hour: SMS would
  // wait out the quiet hours. The SMS campaign is left as a draft to try.
  const sent = await campaigns.create({ name: 'Annual check-up', template_id: checkup.id, segment_id: emailOptIn.id }, ACTOR);
  await campaigns.schedule(sent.id, undefined, ACTOR);
  await campaigns.create({ name: 'Flu season SMS (draft)', template_id: sms.id, segment_id: smsOptIn.id }, ACTOR);

  // The appointment-reminder journey, live, with a few synthetic PureNet bookings for the worker to pick up.
  const journey = await journeys.createAppointmentReminderStarter(ACTOR);
  await journeys.activate(journey.id, ACTOR);
  for (const [i, m] of members.slice(0, 5).entries()) {
    const id = `APT-TEST-${pad(i + 1, 4)}`;
    await events.track({
      contact_id: m.id, name: 'purenet.appointment.booked', idempotency_key: `demo:${id}`,
      properties: { appointment_id: id, start: new Date(now().getTime() + (48 + i * 24) * HOUR).toISOString(), clinic: 'Demo Clinic' },
    }, { source: 'purenet', actor: ACTOR });
  }
  return true;
}
