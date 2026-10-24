# Audit: `Sumit456/Orbit` as input to purenet-platform (now Pure Engage)

- **Audited:** 2026-10-22, full history (8 commits, `0206a35`..`dbc6cc9`), read-only clone.
- **Pinned reference:** `https://github.com/Sumit456/Orbit/tree/dbc6cc9`

## 1. Classification: (b) working application code, plus one analysis document

Evidence:
- `package.json`: Node ≥ 22.13, Express 5 and nodemailer. `npm start` runs `src/server.js` with built-in `node:sqlite`.
- `src/`: routes, services and libs for a complete marketing-automation app (contacts, events, segments,
  templates, campaigns, journeys, delivery, webhooks and data tables). `public/` is the console UI and web SDK.
- `test/`: 61 `node:test` tests run in CI (`.github/workflows/ci.yml`). Deploy config is in `Dockerfile` and `render.yaml`.
- `docs/TEARDOWN.md`: a clean-room functional analysis of Salesforce Marketing Cloud and Braze from public
  documentation. It's the only analysis artifact, and it describes marketing platforms, not PureHealth systems.
- The owner confirms Orbit was built with the help of a reverse-engineering MCP. What it reverse-engineered is
  SFMC/Braze *functionality*. No proprietary code or API captures are present.

## 2. Coverage of PureHealth systems: none

Every revision was searched (`git grep` over `git rev-list --all`) for
`purenet|purehealth|salamtek|oracle|cerner|health cloud|singlestore|fhir|hl7|patient|mrn|malaffi|riayati`.
There were **zero matches**. Orbit contains no endpoints, payloads, schemas, auth flows or event formats for PureNet,
SalamTek/Oracle Health, Salesforce Health Cloud or SingleStore.

As a result, **every PureNet-facing contract in `docs/contracts/` is INFERRED.** These are consumer-driven drafts of
what this platform needs, written for the PureNet team to correct. See `docs/contracts/ASSUMPTIONS.md`.

## 3. Findings usable as input

"CONFIRMED" here means *confirmed as Orbit's behaviour* (code plus a passing test). Adopting a pattern for this
platform is a design decision, and it says nothing about how PureNet behaves.

| # | Finding | Status | Source (orbit@dbc6cc9) | Used in |
|---|---|---|---|---|
| F1 | `POST /api/v1/track`: batch `{attributes[], events[]}`, max 500 objects. Returns 201 with counts, or 207 with per-item errors, 400 or 413 | CONFIRMED | `src/routes/api.js:216-231`, `test/api.test.js:30-38` | `platform-ingest.openapi.yaml` |
| F2 | Event idempotency: a repeated `idempotency_key` is counted as a duplicate and not stored again | CONFIRMED | `src/services/events.js:22-35`, `test/api.test.js:34-38` | ingest, `purenet-events` envelope |
| F3 | Public API auth uses a static bearer key (`Authorization: Bearer <key>`) and returns 401 otherwise | CONFIRMED | `src/routes/api.js:209-214`, `test/api.test.js:31` | ingest |
| F4 | `POST /api/v1/messages/send`: transactional send, 1–100 recipients, per-recipient result, 201/207 | CONFIRMED | `src/routes/api.js:234-250`, `test/messaging.test.js:99` | ingest |
| F5 | `POST /api/v1/journeys/:id/trigger` accepts `{external_id\|email\|contact_id, properties}` | CONFIRMED (code); no dedicated public-route test | `src/routes/api.js:252`, `src/services/journeys.js:297` | ingest |
| F6 | Outbound webhook envelope `{id, type, created_at, event{…}, contact{id, external_id, email}}` | CONFIRMED | `src/services/webhooks.js:70-86`, `test/integrations.test.js:140-172` | `platform-webhooks.asyncapi.yaml` |
| F7 | Webhook signature `X-Orbit-Signature: t=<unix>,v1=hex(HMAC-SHA256(secret, "{t}.{body}"))`, plus `X-Orbit-Event` and `X-Orbit-Delivery` headers | CONFIRMED | `src/services/webhooks.js:11-12,104`, `test/integrations.test.js:152-153` | platform webhooks; also the model for INFERRED A-011 |
| F8 | Webhook retries with backoff of 1m, 5m, 30m, 2h and 6h, then failure (6 attempts) | CONFIRMED | `src/services/webhooks.js:8-9,114-115`, `test/integrations.test.js:174` | platform webhooks |
| F9 | SSRF guard on outbound URLs | CONFIRMED | `src/lib/net.js`, `test/integrations.test.js:64` | design input for the PureNet subscription callback |
| F10 | Provider credentials encrypted at rest and masked on read | CONFIRMED | `src/lib/crypto.js`, `test/integrations.test.js:74` | design input for storing PureNet client secrets |
| F11 | Web SDK identity verification `user_hash = HMAC-SHA256(sdk_secret, user_id)` | CONFIRMED | `src/routes/sdk.js`, `test/messaging.test.js:88-89` | not used yet |
| F12 | SFMC/Braze capability model (profiles, events, segments, journeys, delivery policy) | INFERRED (public-doc analysis, not tested against those products) | `docs/TEARDOWN.md` | product scoping only |

## 4. Secrets, credentials and real data

**Result: nothing to remediate.** `gitleaks 8.21.2 git` over all 8 commits, with default rules and no allowlist, reported no leaks.

- No `.env`, key, certificate or database file has ever been committed (checked with `git log --all --name-only`).
- `render.yaml` uses `generateValue: true` and `sync: false`, so secrets are never stored in the file.
- Seed data is synthetic: `src/seed.js` and `scripts/seed.js` build names from fixed lists, use a seeded RNG,
  and generate `user_1000…` IDs.
- The only pattern hits are deliberate dummy values in test fixtures:
  - `test/auth.test.js`
  - `test/integrations.test.js`
  - `test/api.test.js`

**Recommendations for Orbit** (the owner's call, since Orbit is read-only from here):
1. Add gitleaks to Orbit's CI, with an allowlist for the test fixtures.
2. Keep Orbit public and free of anything PureHealth-specific.
