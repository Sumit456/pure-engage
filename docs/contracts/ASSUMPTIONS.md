# Assumptions register: PureNet and PureHealth systems

Everything below is **INFERRED**. None of it comes from PureNet documentation, captures or tests (see
`docs/audit/orbit-audit.md`). Each item is a question for the PureNet team. When an item is answered:
1. Set its status to `CONFIRMED` (with a source: a document, sandbox test or email reference) or `REJECTED`.
2. Update the contract and change its `x-evidence` to `status: CONFIRMED` with that source.
3. Remove anything the answer makes obsolete.

Contract elements reference these IDs via `x-evidence.assumption`.

| ID | Assumption | Question for PureNet team | Contracts | Status |
|---|---|---|---|---|
| A-001 | PureNet exposes a JSON-over-HTTPS REST API to integrators | Is the integration surface REST/JSON, FHIR R4, HL7 v2, SOAP or file-based? Is there an API reference or sandbox? | `purenet.openapi.yaml` (all) | INFERRED |
| A-002 | Auth is OAuth 2.0 client credentials, with a token URL and scopes such as `members.read`, `consents.read` and `subscriptions.write` | What's the auth flow (OAuth2 CC, mTLS, API key)? What are the token URL and scope names, and how long do tokens last? | `purenet.openapi.yaml` `securitySchemes` | INFERRED |
| A-003 | Separate sandbox and production base URLs exist | What are the environments and base URLs? Is there IP allow-listing? | `purenet.openapi.yaml` `servers` | INFERRED |
| A-004 | A member has a stable PureNet `memberId` plus zero or more typed identifiers (`system` + `value`) | Which identifier systems exist (internal ID, MRN per facility, payer member number, national ID)? Which may we store? | `Member`, `Identifier` | INFERRED |
| A-005 | Members can be looked up by identifier (`GET /members?identifier=system\|value`) | Is lookup by identifier supported? Exact-match only? Can it return more than one match? | `searchMembers` | INFERRED |
| A-006 | The member record we need for engagement is minimal: name, preferred language and contact points | Which fields are available? What's the minimum-necessary set we're allowed to receive? | `Member`, `ContactPoint` | INFERRED |
| A-007 | Consent is per channel (`email`, `sms`, `push`) and per purpose (`care`, `marketing`), with a status and an update timestamp | How is communication consent modelled? Who is master: PureNet, Salesforce Health Cloud or the facility EMR? | `Consent`, `listMemberConsents` | INFERRED |
| A-008 | PureNet pushes change events to a registered HTTPS callback (webhook subscriptions) | Does PureNet push (webhook, Kafka, Azure Event Hub, MLLP) or must we poll? | `createSubscription`, `deleteSubscription`, `purenet-events.asyncapi.yaml` | INFERRED |
| A-009 | Event types include `member.updated`, `consent.changed`, `appointment.booked`, `appointment.cancelled` and `appointment.reminder_due` | What event catalogue exists? Are appointment events sourced from Oracle Health? | `purenet-events.asyncapi.yaml` channels | INFERRED |
| A-010 | Events use an envelope `{id, type, occurred_at, data}`, delivered at least once, with `id` usable as an idempotency key | What's the envelope format? Are delivery and ordering guarantees documented? | `EventEnvelope` | INFERRED |
| A-011 | Event deliveries are signed with HMAC-SHA256 in an `X-PureNet-Signature: t=<unix>,v1=<hex>` header (modelled on Orbit F7) | How are pushed events authenticated (HMAC, mTLS, signed JWT)? | `purenet-events.asyncapi.yaml` headers | INFERRED |
| A-012 | Errors use RFC 9457 `application/problem+json` | What's the error format? Are there error codes? | `Problem` | INFERRED |
| A-013 | List endpoints use cursor pagination (`cursor`, `limit` ≤ 100), and rate limits are signalled with HTTP 429 + `Retry-After` | What are the pagination style and rate limits? | `searchMembers`, `429` responses | INFERRED |
| A-014 | An appointment has `id`, `memberId`, `facilityId`, `start`, `status` and `serviceType` | Which appointment fields can be shared for reminders? | `AppointmentEvent` (`purenet-events.asyncapi.yaml`) | INFERRED |
| A-015 | SalamTek/Oracle Health is behind PureNet: we never call it directly | Do we integrate only with PureNet, or also directly with Oracle Health (Millennium/FHIR)? | — (scope) | INFERRED |
| A-016 | Salesforce Health Cloud holds CRM/engagement records that may overlap with this platform | What role does Health Cloud play? Is it the master for consent and contact preferences? Do we sync with it? | — (scope) | INFERRED |
| A-017 | SingleStore is an analytics store we might read from, not a transactional source | Will we get read access to SingleStore? Under which data-sharing agreement? | — (scope) | INFERRED |
| A-018 | Data must stay in-country (UAE), and the platform's hosting must meet the applicable health-data regulations | What are the hosting, residency and compliance requirements (for example DoH Abu Dhabi / DHA / ADHICS)? | — (non-functional) | INFERRED |
