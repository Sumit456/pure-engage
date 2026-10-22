# PureNet connector (provisional)

**Built on INFERRED contracts.** Every PureNet behaviour this code relies on is an assumption from
`docs/contracts/ASSUMPTIONS.md`, and each one is tagged in the code with its `A-NNN` ID. When the PureNet team
answers a question, `grep -rn "A-0NN" packages/purenet-connector/` finds the code to revisit.

| Module | Does | Assumptions |
|---|---|---|
| `config.js` | Reads `PURENET_*` env vars | A-002, A-003 |
| `token.js` | OAuth2 client-credentials token, cached, refreshed 60s before expiry | A-002 |
| `client.js` | Members, consents, subscriptions; retries 429/5xx with `Retry-After`; refreshes once on 401; parses problem+json | A-001, A-005–A-008, A-012, A-013 |
| `signature.js` | Signs/verifies `X-PureNet-Signature` (HMAC-SHA256, 5-minute tolerance) | A-011 |
| `mapping.js` | PureNet member, consents and events → platform `/track` payload (`platform-ingest.openapi.yaml`) | A-004, A-006, A-007, A-009, A-010, A-014 |
| `receiver.js` | Webhook handler: verify signature → de-duplicate on event id → map → sink | A-008, A-010, A-011 |

Isolation: nothing outside this folder imports PureNet shapes. Everything leaves through `mapping.js` as the
platform's own `TrackRequest`, so when an assumption changes, only this folder changes.
