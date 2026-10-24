import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { checkSalesforceUrl } from '../src/services/salesforce/client.ts';
import { MAX_SALESFORCE_ATTEMPTS } from '../src/services/salesforce/service.ts';
import { startFakeSalesforce, type FakeSalesforce } from './fake-salesforce.ts';
import { emailTemplate, loginAs, makeContact, makeTemplate, testApp, truncateAll } from './helpers.ts';

let now = new Date('2026-01-10T06:00:00Z');
const clock = () => now;
const CALLBACK = 'https://engage.example.com/oauth/salesforce/callback';
const WIZARD = 'https://engage.example.com/integrations/salesforce';

type Ctx = Awaited<ReturnType<typeof testApp>>;
type Admin = Awaited<ReturnType<typeof loginAs>>;

async function configure(admin: Admin, fake: FakeSalesforce, over: Record<string, unknown> = {}) {
  return admin.request({ method: 'PUT', url: '/api/salesforce/config', payload: { login_host: fake.url, consumer_key: fake.state.clientId, consumer_secret: fake.state.clientSecret, ...over } });
}

/** Start → the fake's authorize endpoint (auto-approves) → the callback location it sends the browser to. */
async function authorize(admin: Admin) {
  const start = await admin.request({ method: 'POST', url: '/api/salesforce/connect' });
  expect(start.statusCode).toBe(200);
  const authorizeUrl = new URL((start.json() as { authorize_url: string }).authorize_url);
  const res = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('location')!);
  return { authorizeUrl, callback: `${loc.pathname}${loc.search}`, loc };
}

async function connect(admin: Admin, fake: FakeSalesforce) {
  expect((await configure(admin, fake)).statusCode).toBe(200);
  const { callback } = await authorize(admin);
  const res = await admin.request({ method: 'GET', url: callback });
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe(`${WIZARD}?connected=1`);
  return (await admin.request({ method: 'GET', url: '/api/salesforce' })).json() as { connection: Record<string, unknown> & { id: string } };
}

const sync = (admin: Admin) => admin.request({ method: 'POST', url: '/api/salesforce/sync' });

describe('Salesforce connector', () => {
  let ctx: Ctx;
  let fake: FakeSalesforce;
  let admin: Admin;
  beforeAll(async () => { ctx = await testApp({ PE_SALESFORCE_ALLOW_ANY_HOST: 'true' }, { clock }); });
  afterAll(async () => { await ctx.close(); });
  beforeEach(async () => {
    await truncateAll(ctx.db);
    now = new Date('2026-01-10T06:00:00Z');
    fake = await startFakeSalesforce();
    admin = await loginAs(ctx.app, 'admin');
  });
  afterEach(async () => { await fake.close(); });

  const contactBy = (externalId: string) => ctx.app.services.contacts.findByRef({ external_id: externalId });
  const patchSettings = (payload: Record<string, unknown>) => admin.request({ method: 'PATCH', url: '/api/salesforce/settings', payload });
  const consentRows = (contactId: string) => ctx.db.selectFrom('consent_history').selectAll().where('contact_id', '=', contactId).orderBy('id').execute();

  test('connect: authorize URL with PKCE S256, state bound to the session, single use, 10-minute expiry', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/salesforce' })).statusCode).toBe(401);
    expect((await admin.request({ method: 'POST', url: '/api/salesforce/connect' })).statusCode).toBe(400); // nothing configured yet
    expect((await configure(admin, fake, { consumer_secret: undefined })).statusCode).toBe(400); // secret required the first time
    expect((await configure(admin, fake)).statusCode).toBe(200);

    const { authorizeUrl, loc } = await authorize(admin);
    const p = authorizeUrl.searchParams;
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(`${fake.url}/services/oauth2/authorize`);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(fake.state.clientId);
    expect(p.get('redirect_uri')).toBe(CALLBACK);
    expect(p.get('scope')).toBe('api refresh_token offline_access');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('state')!.length).toBeGreaterThanOrEqual(40);
    expect(loc.origin + loc.pathname).toBe(CALLBACK);

    // Another admin's session (or no session) can't complete it, and the state is then spent.
    const other = await loginAs(ctx.app, 'admin', 'admin2@example.com');
    expect((await other.request({ method: 'GET', url: `${loc.pathname}${loc.search}` })).headers.location).toBe(`${WIZARD}?error=session`);
    expect((await admin.request({ method: 'GET', url: `${loc.pathname}${loc.search}` })).headers.location).toBe(`${WIZARD}?error=invalid_state`);
    const anon = await authorize(admin);
    expect((await ctx.app.inject({ method: 'GET', url: anon.callback })).headers.location).toBe(`${WIZARD}?error=session`);

    // Expired after 10 minutes.
    const late = await authorize(admin);
    now = new Date(now.getTime() + 11 * 60_000);
    expect((await admin.request({ method: 'GET', url: late.callback })).headers.location).toBe(`${WIZARD}?error=invalid_state`);

    // A code issued for one PKCE challenge doesn't work with another handshake's verifier.
    const a = await authorize(admin);
    const b = await admin.request({ method: 'POST', url: '/api/salesforce/connect' });
    const stateB = new URL((b.json() as { authorize_url: string }).authorize_url).searchParams.get('state')!;
    const code = a.loc.searchParams.get('code')!;
    expect((await admin.request({ method: 'GET', url: `/oauth/salesforce/callback?code=${code}&state=${encodeURIComponent(stateB)}` })).headers.location).toBe(`${WIZARD}?error=token`);

    // The real thing.
    const ok = await authorize(admin);
    const res = await admin.request({ method: 'GET', url: ok.callback });
    expect(res.headers.location).toBe(`${WIZARD}?connected=1`);
    expect((await admin.request({ method: 'GET', url: ok.callback })).headers.location).toBe(`${WIZARD}?error=invalid_state`); // replay
    expect(fake.state.tokenGrants.filter((g) => g === 'authorization_code')).toHaveLength(2);

    const { connection } = (await admin.request({ method: 'GET', url: '/api/salesforce' })).json() as { connection: Record<string, unknown> };
    expect(connection).toMatchObject({ status: 'connected', connected: true, org_id: '00DFAKE000000000001', username: 'integration.user@example.com', instance_url: fake.url, has_consumer_secret: true });
    const audit = await ctx.db.selectFrom('audit_log').select(['action', 'details']).where('action', 'like', 'salesforce.%').execute();
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['salesforce.configure', 'salesforce.connect']));
  });

  test('the denial from Salesforce comes back as an error, and the state is spent', async () => {
    await configure(admin, fake);
    const { loc } = await authorize(admin);
    const state = loc.searchParams.get('state')!;
    expect((await admin.request({ method: 'GET', url: `/oauth/salesforce/callback?error=access_denied&state=${encodeURIComponent(state)}` })).headers.location).toBe(`${WIZARD}?error=denied`);
    expect((await admin.request({ method: 'GET', url: `${loc.pathname}${loc.search}` })).headers.location).toBe(`${WIZARD}?error=invalid_state`);
  });

  test('consumer secret and tokens never appear in an API response, the request log or the audit log', async () => {
    const { connection } = await connect(admin, fake);
    fake.add('Contact', { Email: 'sf.one@example.com', FirstName: 'Test', LastName: 'One' });
    expect((await sync(admin)).statusCode).toBe(200);
    fake.expireSessions();
    expect((await sync(admin)).statusCode).toBe(200);
    const bodies = await Promise.all([
      admin.request({ method: 'GET', url: '/api/salesforce' }),
      configure(admin, fake),
      admin.request({ method: 'GET', url: '/api/salesforce/outbox' }),
      admin.request({ method: 'GET', url: `/api/integrations/requests?integration_id=${connection.id}` }),
      admin.request({ method: 'GET', url: '/api/integrations/requests' }),
      admin.request({ method: 'GET', url: '/api/integrations' }),
      admin.request({ method: 'GET', url: '/api/integrations/overview' }),
      admin.request({ method: 'GET', url: '/api/salesforce/describe/Contact' }),
    ]);
    const log = (await admin.request({ method: 'GET', url: `/api/integrations/requests?integration_id=${connection.id}` })).json() as { data: { route: string }[] };
    expect(log.data.map((r) => r.route)).toEqual(expect.arrayContaining(['salesforce oauth token', 'salesforce oauth refresh', 'salesforce pull Contact']));
    const audit = await ctx.db.selectFrom('audit_log').selectAll().execute();
    const everything = JSON.stringify([...bodies.map((b) => b.body), audit]);
    const secrets = fake.issuedSecrets();
    expect(secrets.length).toBeGreaterThanOrEqual(4);
    for (const s of secrets) expect(everything).not.toContain(s);
    // Stored encrypted, too.
    const row = await ctx.db.selectFrom('salesforce_connections').selectAll().executeTakeFirstOrThrow();
    for (const s of secrets) expect(JSON.stringify(row)).not.toContain(s);
    // The generic integrations API doesn't expose (or accept deliveries for) the Salesforce row.
    expect((await admin.request({ method: 'GET', url: `/api/integrations/${connection.id}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'POST', url: `/hooks/in/${connection.id}`, headers: { authorization: `Bearer ${fake.state.clientSecret}` }, payload: {} })).statusCode).toBe(404);
    expect(((await admin.request({ method: 'GET', url: '/api/integrations' })).json() as { data: unknown[] }).data).toHaveLength(0);
  });

  test('refreshes the access token once on 401 INVALID_SESSION_ID; a refused refresh marks the connection broken', async () => {
    await connect(admin, fake);
    fake.add('Contact', { Email: 'sf.refresh@example.com', LastName: 'Refresh' });
    fake.expireSessions();
    const res = await sync(admin);
    expect(res.statusCode).toBe(200);
    expect(fake.state.tokenGrants).toEqual(['authorization_code', 'refresh_token']);
    expect((res.json() as { run: { error: string | null } }).run.error).toBeNull();

    // Backoff on REQUEST_LIMIT_EXCEEDED: retried within the call.
    fake.state.limitOnce = true;
    fake.add('Contact', { Email: 'sf.limit@example.com', LastName: 'Limit' });
    expect(((await sync(admin)).json() as { run: { error: string | null } }).run.error).toBeNull();
    expect(await ctx.app.services.contacts.findByRef({ email: 'sf.limit@example.com' })).toBeTruthy();

    fake.state.rejectRefresh = true;
    fake.expireSessions();
    const broken = (await sync(admin)).json() as { connection: { status: string; connected: boolean; last_error: string } };
    expect(broken.connection).toMatchObject({ status: 'error', connected: false });
    expect(broken.connection.last_error).toContain('Connect again');
  });

  test('pull: pages through Contacts and Leads, maps fields and identity, counts results, and the cursor advances', async () => {
    const { connection } = await connect(admin, fake);
    const recs = [
      fake.add('Contact', { Email: 'Ana.Test@Example.com', FirstName: 'Ana', LastName: 'Test', MobilePhone: '+971 50 000 0101', Title: 'Engineer', Loyalty_Tier__c: 'Gold' }),
      fake.add('Contact', { Email: 'b.test@example.com', LastName: 'B', MobilePhone: '050 000 0102', Phone: '+971500000103' }),
      fake.add('Contact', { Email: 'not-an-email', LastName: 'C', Phone: '0500000104' }),
      fake.add('Contact', { Email: 'd.test@example.com', LastName: 'D' }),
      fake.add('Contact', { Email: 'e.test@example.com', LastName: 'E' }),
    ];
    const lead = fake.add('Lead', { Email: 'lead.test@example.com', LastName: 'Lead', Company: 'Example Co' });
    expect((await patchSettings({
      objects: {
        Contact: { enabled: true, external_id_field: 'Id', fields: [{ field: 'Title', attribute: 'job_title' }, { field: 'Loyalty_Tier__c', attribute: 'loyalty_tier' }], consent: [] },
        Lead: { enabled: true, external_id_field: 'Id', fields: [{ field: 'Company', attribute: 'company' }], consent: [] },
      },
    })).statusCode).toBe(200);

    const res = await sync(admin);
    expect(res.statusCode).toBe(200);
    const run = (res.json() as { run: { objects: Record<string, Record<string, number>>; error: string | null } }).run;
    expect(run.objects.Contact).toMatchObject({ created: 5, updated: 0, skipped: 0, errors: 0, warnings: 2 });
    expect(run.objects.Lead).toMatchObject({ created: 1 });
    // Paged: 5 Contacts at 2 per page = 3 pages.
    expect(fake.state.calls.filter((c) => c.path.startsWith('/services/data/v62.0/query')).length).toBe(3 + 1);
    expect(fake.state.queries[0]).toBe('SELECT Id, SystemModstamp, Email, FirstName, LastName, MobilePhone, Phone, HasOptedOutOfEmail, DoNotCall, Title, Loyalty_Tier__c FROM Contact ORDER BY SystemModstamp ASC, Id ASC');

    const ana = (await contactBy(recs[0]!.Id))!;
    expect(ana).toMatchObject({ external_id: recs[0]!.Id, email: 'ana.test@example.com', first_name: 'Ana', last_name: 'Test', phone: '+971500000101' });
    expect(ana.attributes).toEqual({ salesforce_id: recs[0]!.Id, salesforce_object: 'Contact', job_title: 'Engineer', loyalty_tier: 'Gold' });
    expect((await contactBy(recs[1]!.Id))!.phone).toBe('+971500000103'); // MobilePhone isn't E.164, Phone is
    const c = (await contactBy(recs[2]!.Id))!;
    expect(c.email).toBeNull(); // invalid email skipped (warning)
    expect(c.phone).toBeNull(); // invalid phone skipped (warning)
    expect((await contactBy(lead.Id))!.attributes).toMatchObject({ salesforce_object: 'Lead', company: 'Example Co' });

    // Writes are attributed to the connection.
    const audit = await ctx.db.selectFrom('audit_log').selectAll().where('action', '=', 'contact.create').execute();
    expect(audit.every((a) => a.actor_type === 'integration' && a.actor_id === `salesforce:${connection.id}` && a.details.source === `salesforce:${connection.id}`)).toBe(true);
    const log = await ctx.db.selectFrom('integration_requests').selectAll().where('route', '=', 'salesforce pull Contact').execute();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ integration_id: connection.id, status: 200, items: 5 });

    // Second run reads only what changed since the cursor (inclusive), and counts updates.
    fake.update('Contact', recs[3]!.Id, { FirstName: 'Dana' });
    const second = (await sync(admin)).json() as { run: { objects: Record<string, Record<string, number>> } };
    const cursor = fake.state.records.Contact.find((r) => r.Id === recs[4]!.Id)!.SystemModstamp.replace('.000+0000', 'Z');
    expect(fake.state.queries.at(-2)).toContain(`FROM Contact WHERE SystemModstamp >= ${cursor} ORDER BY`);
    expect(second.run.objects.Contact).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    expect((await contactBy(recs[3]!.Id))!.first_name).toBe('Dana');
    const state = await ctx.db.selectFrom('salesforce_connections').select('pull_state').executeTakeFirstOrThrow();
    expect(state.pull_state.cursors?.Contact).toBe(fake.state.records.Contact.find((r) => r.Id === recs[3]!.Id)!.SystemModstamp.replace('.000+0000', 'Z'));
  });

  test('pull: a custom identity field becomes external_id; records without it are skipped; unknown fields are refused', async () => {
    await connect(admin, fake);
    const member = await makeContact(ctx.app, { external_id: 'MBR-TEST-SF-1', email: 'member.one@example.com', first_name: 'Existing' });
    fake.add('Contact', { Member_ID__c: 'MBR-TEST-SF-1', Email: 'member.one@example.com', LastName: 'One' });
    fake.add('Contact', { Member_ID__c: null, Email: 'nomember@example.com', LastName: 'None' });
    const bad = await patchSettings({ objects: { Contact: { enabled: true, external_id_field: 'Nope__c', fields: [], consent: [] }, Lead: { enabled: false, external_id_field: 'Id', fields: [], consent: [] } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details[0].path).toBe('objects.Contact.external_id_field');
    expect((await patchSettings({ objects: { Contact: { enabled: true, external_id_field: 'Member_ID__c', fields: [{ field: 'Title', attribute: 'email' }], consent: [] }, Lead: { enabled: false, external_id_field: 'Id', fields: [], consent: [] } } })).statusCode).toBe(400); // reserved attribute
    expect((await patchSettings({ objects: { Contact: { enabled: true, external_id_field: 'Member_ID__c', fields: [], consent: [] }, Lead: { enabled: false, external_id_field: 'Id', fields: [], consent: [] } } })).statusCode).toBe(200);

    const run = ((await sync(admin)).json() as { run: { objects: Record<string, Record<string, number>> } }).run;
    expect(run.objects.Contact).toMatchObject({ created: 0, updated: 1, skipped: 1 });
    const updated = (await ctx.app.services.contacts.get(member.id));
    expect(updated).toMatchObject({ first_name: 'Existing', last_name: 'One' });
    expect(updated.attributes).toMatchObject({ salesforce_object: 'Contact' });
    expect(await ctx.app.services.contacts.findByRef({ email: 'nomember@example.com' })).toBeUndefined();
  });

  test('consent: opt-out denies, false grants nothing, a mapped checkbox or picklist grants, DoNotCall denies SMS', async () => {
    const { connection } = await connect(admin, fake);
    expect((await patchSettings({
      objects: {
        Contact: { enabled: true, external_id_field: 'Id', fields: [], consent: [
          { field: 'Marketing_Opt_In__c', channel: 'email', purpose: 'marketing' },
          { field: 'Sms_Consent__c', channel: 'sms', purpose: 'marketing' },
        ] },
        Lead: { enabled: false, external_id_field: 'Id', fields: [], consent: [] },
      },
    })).statusCode).toBe(200);
    const optedOut = fake.add('Contact', { Email: 'out@example.com', LastName: 'Out', HasOptedOutOfEmail: true, Marketing_Opt_In__c: true });
    const neutral = fake.add('Contact', { Email: 'neutral@example.com', LastName: 'Neutral', HasOptedOutOfEmail: false, DoNotCall: false, Marketing_Opt_In__c: false });
    const optedIn = fake.add('Contact', { Email: 'in@example.com', LastName: 'In', HasOptedOutOfEmail: false, Marketing_Opt_In__c: true, Sms_Consent__c: 'Opted_In' });
    const noCalls = fake.add('Contact', { Email: 'dnc@example.com', LastName: 'Dnc', DoNotCall: true, Sms_Consent__c: 'Opted_In' });
    await sync(admin);

    expect((await contactBy(optedOut.Id))!.consent).toEqual({ email: { marketing: 'denied' } });
    expect((await contactBy(neutral.Id))!.consent).toEqual({});
    expect((await contactBy(optedIn.Id))!.consent).toEqual({ email: { marketing: 'granted' }, sms: { marketing: 'granted' } });
    expect((await contactBy(noCalls.Id))!.consent).toEqual({ sms: { marketing: 'denied' } });
    const history = await consentRows((await contactBy(optedIn.Id))!.id);
    expect(history.map((h) => h.source)).toEqual([`salesforce:${connection.id}`, `salesforce:${connection.id}`]);

    // Unticking the opt-in grants nothing back and denies nothing (unless the mapping says so).
    fake.update('Contact', optedIn.Id, { Marketing_Opt_In__c: false });
    await sync(admin);
    expect((await contactBy(optedIn.Id))!.consent.email).toEqual({ marketing: 'granted' });
    await patchSettings({ objects: { Contact: { enabled: true, external_id_field: 'Id', fields: [], consent: [{ field: 'Marketing_Opt_In__c', channel: 'email', purpose: 'marketing', unchecked_denies: true }] }, Lead: { enabled: false, external_id_field: 'Id', fields: [], consent: [] } } });
    fake.update('Contact', optedIn.Id, { LastName: 'In2' });
    await sync(admin);
    expect((await contactBy(optedIn.Id))!.consent.email).toEqual({ marketing: 'denied' });
  });

  async function syncedContact(fields: Record<string, unknown> = {}) {
    const rec = fake.add('Contact', { Email: `push.${Math.random().toString(36).slice(2, 8)}@example.com`, LastName: 'Push', ...fields });
    await sync(admin);
    const contact = (await contactBy(rec.Id))!;
    // Consent from another source, so messages can be sent.
    const withConsent = (await ctx.app.services.contacts.upsert({ contact_id: contact.id, consent: { email: { care: 'granted', marketing: 'granted' } } }, { source: 'test', actor: { type: 'system' } })).contact;
    return { rec, contact: withConsent };
  }

  test('push: sends and opens of synced contacts become completed Tasks with no personal data', async () => {
    await connect(admin, fake);
    const { rec, contact } = await syncedContact();
    const other = await makeContact(ctx.app, { external_id: 'MBR-TEST-SF-2', email: 'local.only@example.com', consent: { email: { care: 'granted' } } });
    const t = await makeTemplate(ctx.app, emailTemplate());
    const m = await ctx.app.services.delivery.enqueue({ contact, templateId: t.id, data: { date: '12 January' }, source: 'test' });
    await ctx.app.services.delivery.enqueue({ contact: other, templateId: t.id, data: { date: '12 January' }, source: 'test' });
    await ctx.app.services.delivery.dispatchOnce();
    await ctx.app.services.delivery.recordOpen(m.id);

    expect(await ctx.app.services.salesforce.pushDue()).toEqual({ queued: 2, delivered: 2 });
    expect(fake.state.tasks).toHaveLength(2);
    expect(fake.state.tasks.map((x) => x.Subject)).toEqual(['Email sent: Appointment confirmation', 'Email opened: Appointment confirmation']);
    for (const task of fake.state.tasks) {
      expect(task).toMatchObject({ WhoId: rec.Id, Status: 'Completed', Description: 'Logged by Pure Engage' });
      expect(task.ActivityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Object.keys(task).sort()).toEqual(['ActivityDate', 'Description', 'Id', 'Status', 'Subject', 'WhoId']);
      expect(JSON.stringify(task)).not.toContain('@example.com');
    }
    const outbox = ((await admin.request({ method: 'GET', url: '/api/salesforce/outbox' })).json() as { data: { status: string; sf_record_id: string }[] }).data;
    expect(outbox.map((o) => o.status)).toEqual(['sent', 'sent']);
    expect(outbox.every((o) => o.sf_record_id.startsWith('00T'))).toBe(true);
    expect(await ctx.app.services.salesforce.pushDue()).toEqual({ queued: 0, delivered: 0 }); // idempotent

    // Only the chosen activity types are written back.
    await patchSettings({ write_back: { activities: ['click'], email_opt_out: true } });
    await ctx.app.services.delivery.recordOpen(m.id);
    await ctx.app.services.delivery.recordClick(m.id, 'https://example.com/appointments');
    await ctx.app.services.salesforce.pushDue();
    expect(fake.state.tasks.map((x) => x.Subject).at(-1)).toBe('Email link clicked: Appointment confirmation');
    expect(fake.state.tasks).toHaveLength(3);
  });

  test('push: batches of at most 200 per composite call', async () => {
    await connect(admin, fake);
    const { contact } = await syncedContact();
    const t = await makeTemplate(ctx.app, emailTemplate());
    const m = await ctx.app.services.delivery.enqueue({ contact, templateId: t.id, data: { date: '12 January' }, source: 'test' });
    await ctx.db.insertInto('message_events').values(Array.from({ length: 250 }, () => ({ message_id: m.id, type: 'open' as const, detail: null }))).execute();
    await ctx.app.services.salesforce.pushDue();
    expect(fake.state.compositeCalls).toEqual([{ method: 'POST', records: 200 }, { method: 'POST', records: 50 }]);
    expect(fake.state.tasks).toHaveLength(250);
    const log = await ctx.db.selectFrom('integration_requests').select(['route', 'items', 'status']).where('route', '=', 'salesforce push Task').execute();
    expect(log).toEqual([{ route: 'salesforce push Task', items: 200, status: 200 }, { route: 'salesforce push Task', items: 50, status: 200 }]);
  });

  test('push: retries a 5xx with the webhook backoff, fails after the maximum, and can be retried from the console', async () => {
    await connect(admin, fake);
    const { contact } = await syncedContact();
    const t = await makeTemplate(ctx.app, emailTemplate());
    const m = await ctx.app.services.delivery.enqueue({ contact, templateId: t.id, data: { date: '12 January' }, source: 'test' });
    await ctx.db.insertInto('message_events').values({ message_id: m.id, type: 'open', detail: null }).execute();

    fake.state.failComposite = 3; // more than the client's in-call retries
    await ctx.app.services.salesforce.pushDue();
    let row = await ctx.db.selectFrom('salesforce_outbox').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row.error).toContain('UNKNOWN_EXCEPTION');
    expect(row.next_attempt_at!.getTime()).toBe(now.getTime() + 60_000);
    expect(await ctx.app.services.salesforce.deliverDue()).toBe(0); // not due yet
    now = new Date(now.getTime() + 61_000);
    expect(await ctx.app.services.salesforce.deliverDue()).toBe(1);
    row = await ctx.db.selectFrom('salesforce_outbox').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'sent', attempts: 2 });
    expect(fake.state.tasks).toHaveLength(1);

    // Always failing: failed after the maximum number of attempts.
    await ctx.db.insertInto('message_events').values({ message_id: m.id, type: 'open', detail: null }).execute();
    fake.state.failComposite = 1_000;
    await ctx.app.services.salesforce.pump();
    for (let i = 0; i < MAX_SALESFORCE_ATTEMPTS + 2; i++) {
      await ctx.app.services.salesforce.deliverDue();
      now = new Date(now.getTime() + 7 * 3_600_000);
    }
    const failed = await ctx.db.selectFrom('salesforce_outbox').selectAll().where('status', '!=', 'sent').executeTakeFirstOrThrow();
    expect(failed).toMatchObject({ status: 'failed', attempts: MAX_SALESFORCE_ATTEMPTS, next_attempt_at: null });
    const listed = (await admin.request({ method: 'GET', url: '/api/salesforce/outbox?status=failed' })).json() as { data: { id: string; subject: string }[] };
    expect(listed.data.map((d) => d.id)).toEqual([failed.id]);
    expect(listed.data[0]!.subject).toBe('Email opened: Appointment confirmation');

    fake.state.failComposite = 0;
    const retried = await admin.request({ method: 'POST', url: `/api/salesforce/outbox/${failed.id}/retry` });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ status: 'sent' });
    expect((await admin.request({ method: 'POST', url: `/api/salesforce/outbox/${failed.id}/retry` })).statusCode).toBe(409);
  });

  test('push: a record Salesforce rejects fails at once', async () => {
    await connect(admin, fake);
    const { rec, contact } = await syncedContact();
    fake.state.rejectWhoIds.add(rec.Id);
    const t = await makeTemplate(ctx.app, emailTemplate());
    const m = await ctx.app.services.delivery.enqueue({ contact, templateId: t.id, data: { date: '12 January' }, source: 'test' });
    await ctx.db.insertInto('message_events').values({ message_id: m.id, type: 'open', detail: null }).execute();
    await ctx.app.services.salesforce.pushDue();
    const row = await ctx.db.selectFrom('salesforce_outbox').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row.error).toContain('INVALID_CROSS_REFERENCE_KEY');
  });

  test('opt-out write-back: other sources set HasOptedOutOfEmail; Salesforce-sourced opt-outs do not echo', async () => {
    await connect(admin, fake);
    const { rec, contact } = await syncedContact();
    const t = await makeTemplate(ctx.app, emailTemplate({ name: 'Promo', purpose: 'marketing' }));
    const m = await ctx.app.services.delivery.enqueue({ contact, templateId: t.id, data: { date: '12 January' }, source: 'test' });
    await ctx.app.services.delivery.dispatchOnce();
    await ctx.app.services.delivery.unsubscribe(m.id);
    await ctx.app.services.salesforce.pushDue();
    expect(fake.state.compositeCalls.filter((c) => c.method === 'PATCH')).toEqual([{ method: 'PATCH', records: 1 }]);
    expect(fake.state.records.Contact.find((r) => r.Id === rec.Id)!.HasOptedOutOfEmail).toBe(true);
    expect(fake.state.tasks.map((x) => x.Subject)).toContain('Email unsubscribed: Promo');

    // An opt-out made in Salesforce comes in once and is not written back.
    const second = await syncedContact();
    fake.update('Contact', second.rec.Id, { HasOptedOutOfEmail: true });
    await sync(admin);
    expect((await ctx.app.services.contacts.get(second.contact.id)).consent.email?.marketing).toBe('denied');
    await ctx.app.services.salesforce.pushDue();
    expect(fake.state.compositeCalls.filter((c) => c.method === 'PATCH')).toHaveLength(1);

    // Turned off: nothing is written.
    await patchSettings({ write_back: { activities: [], email_opt_out: false } });
    const third = await syncedContact();
    await ctx.app.services.contacts.upsert({ contact_id: third.contact.id, consent: { email: { marketing: 'denied' } } }, { source: 'test', actor: { type: 'system' } });
    await ctx.app.services.salesforce.pushDue();
    expect(fake.state.compositeCalls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  test('the worker pulls on schedule; disconnect revokes and deletes the tokens', async () => {
    const { connection } = await connect(admin, fake);
    fake.add('Contact', { Email: 'scheduled@example.com', LastName: 'Scheduled' });
    await ctx.app.services.worker.tick();
    expect(await ctx.app.services.contacts.findByRef({ email: 'scheduled@example.com' })).toBeTruthy();
    expect(await ctx.app.services.salesforce.pullDue()).toBe(0); // next run in 15 minutes
    now = new Date(now.getTime() + 15 * 60_000);
    expect(await ctx.app.services.salesforce.pullDue()).toBe(1);

    const overview = (await admin.request({ method: 'GET', url: '/api/integrations/overview' })).json() as { salesforce: { status: string } };
    expect(overview.salesforce.status).toBe('connected');

    const res = await admin.request({ method: 'DELETE', url: '/api/salesforce/connection' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { connection: Record<string, unknown> }).connection).toMatchObject({ status: 'not_connected', connected: false, org_id: null, username: null });
    expect(fake.state.revoked).toHaveLength(1);
    const row = await ctx.db.selectFrom('salesforce_connections').selectAll().where('integration_id', '=', connection.id).executeTakeFirstOrThrow();
    expect(row.refresh_token_encrypted).toBeNull();
    expect(row.access_token_encrypted).toBeNull();
    expect((await sync(admin)).statusCode).toBe(400);
    expect(await ctx.app.services.salesforce.pullDue()).toBe(0);
  });

  test('admin only', async () => {
    await configure(admin, fake);
    const marketer = await loginAs(ctx.app, 'marketer');
    for (const [method, url] of [['GET', '/api/salesforce'], ['PUT', '/api/salesforce/config'], ['PATCH', '/api/salesforce/settings'], ['POST', '/api/salesforce/connect'],
      ['GET', '/api/salesforce/describe/Contact'], ['POST', '/api/salesforce/sync'], ['DELETE', '/api/salesforce/connection'], ['GET', '/api/salesforce/outbox'],
      ['POST', '/api/salesforce/outbox/00000000-0000-4000-8000-000000000000/retry']] as const) {
      expect((await marketer.request({ method, url, payload: method === 'GET' || method === 'DELETE' ? undefined : {} })).statusCode, `${method} ${url}`).toBe(403);
      expect((await ctx.app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
    }
    // A marketer's session can't finish an admin's handshake.
    const { callback } = await authorize(admin);
    expect((await marketer.request({ method: 'GET', url: callback })).headers.location).toBe(`${WIZARD}?error=session`);
  });
});

describe('Salesforce host allowlist', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await testApp({}, { clock }); });
  afterAll(async () => { await ctx.close(); });
  beforeEach(async () => { await truncateAll(ctx.db); });

  test('only https Salesforce hosts, unless PE_SALESFORCE_ALLOW_ANY_HOST (never in production)', async () => {
    const admin = await loginAs(ctx.app, 'admin');
    const save = (login_host: string) => admin.request({ method: 'PUT', url: '/api/salesforce/config', payload: { login_host, consumer_key: '3MVG9exampleConsumerKey', consumer_secret: 'example-consumer-secret' } });
    for (const host of ['http://127.0.0.1:9999', 'evil.example.com', 'https://salesforce.com.evil.example', 'https://evilsalesforce.com', 'http://login.salesforce.com', 'https://login.salesforce.com/services', 'https://user:pw@login.salesforce.com']) {
      const res = await save(host);
      expect(res.statusCode, host).toBe(400);
      expect(res.json().details[0].path).toBe('login_host');
    }
    expect((await save('login.salesforce.com')).statusCode).toBe(200);
    expect((await save('https://test.salesforce.com')).statusCode).toBe(200);
    const res = await save('acme--dev.sandbox.my.salesforce.com');
    expect(res.statusCode).toBe(200);
    expect(res.json().connection.login_host).toBe('https://acme--dev.sandbox.my.salesforce.com');

    // The instance URL returned by the token endpoint gets the same check.
    expect(checkSalesforceUrl('https://acme.my.salesforce.com', false)).toBe('https://acme.my.salesforce.com');
    expect(checkSalesforceUrl('https://acme.lightning.force.com', false)).toBe('https://acme.lightning.force.com');
    expect(() => checkSalesforceUrl('https://169.254.169.254', false)).toThrow();
    expect(() => checkSalesforceUrl('https://attacker.example.com', false)).toThrow();
    expect(checkSalesforceUrl('http://127.0.0.1:4010', true)).toBe('http://127.0.0.1:4010');
    expect(() => checkSalesforceUrl('ftp://127.0.0.1', true)).toThrow();

    expect(() => loadConfig({ NODE_ENV: 'production', PE_TRACKING_SECRET: 'x'.repeat(40), PE_SECRET_KEY: 'y'.repeat(40), PE_SALESFORCE_ALLOW_ANY_HOST: 'true' })).toThrow(/PE_SALESFORCE_ALLOW_ANY_HOST/);
  });
});
