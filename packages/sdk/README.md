# @pure-engage/sdk

A small JavaScript client for the Pure Engage public API (`docs/contracts/platform-ingest.openapi.yaml`), plus
helpers for webhook signatures. It has no dependencies and runs on Node 18+, Deno, Bun and edge runtimes.

Create an API key in the console under **Integrations → REST API & keys**. Give it only the permissions your app
needs. Every method below names the permission it requires.

```js
import { PureEngage } from '@pure-engage/sdk';

const pe = new PureEngage({ baseUrl: 'https://engage.example.com', apiKey: process.env.PE_API_KEY });

// contacts:write (+ consent:write when consent is included)
await pe.identify({ external_id: 'MBR-TEST-0001', email: 'test.member@example.com', consent: { email: { care: 'granted' } } });

// events:write. Events can start journeys.
await pe.track({ external_id: 'MBR-TEST-0001', name: 'appointment.booked', properties: { appointment_id: 'APT-TEST-0001' }, idempotency_key: 'apt-0001' });

// consent:write
await pe.setConsent({ external_id: 'MBR-TEST-0001' }, { email: { marketing: 'denied' } });

// journeys:trigger
await pe.triggerJourney(journeyId, { external_id: 'MBR-TEST-0001', properties: { appointment_id: 'APT-TEST-0001', start: '2026-12-01T09:00:00Z' } });

// messages:send (consent and quiet hours are always enforced by the platform)
await pe.send({ template_id: templateId, recipients: [{ external_id: 'MBR-TEST-0001', properties: { date: 'Monday' } }] });

// contacts:read: masked unless the key also has contacts:read_pii. Every read is audited.
const contact = await pe.lookupContact({ external_id: 'MBR-TEST-0001' });
```

## Errors and retries

A failed call throws `PureEngageError` with `status` and `details`. A missing permission gives
`status: 403, details.code: 'insufficient_scope'`.

- **Reads** are retried on 429, 5xx and network errors.
- **Writes** are retried only on 429. Give writes an `idempotency_key` so it is safe to retry them yourself.

## Webhooks

```js
import { verifyWebhook, signWebhook } from '@pure-engage/sdk';

// Outbound: check that a delivery really came from Pure Engage (use the raw body, before JSON parsing).
const ok = await verifyWebhook(req.headers['x-pe-signature'], rawBody, process.env.PE_WEBHOOK_SECRET);

// Inbound in HMAC mode: sign what you send to /hooks/in/<id>.
const signature = await signWebhook(process.env.PE_HOOK_SECRET, body);
await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pe-signature': signature }, body });
```
