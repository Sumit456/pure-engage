# purenet-platform

The PureHealth engagement platform, which integrates with PureNet. It's contract-first: the API and event
contracts in `docs/contracts/` come first, and a PureNet mock is generated from them so platform work can start
before sandbox access.

> **Status: every PureNet contract is INFERRED.** It's a draft of what we need, not PureNet's documented API.
> The open questions for the PureNet team are in [`docs/contracts/ASSUMPTIONS.md`](docs/contracts/ASSUMPTIONS.md).

## Layout
| Path | What |
|---|---|
| `docs/audit/orbit-audit.md` | Audit of `Sumit456/Orbit` (prior art): classification, findings, secrets result |
| `docs/adr/` | ADR-0001 (new repo, Orbit referenced by pinned commit), ADR-0002 (Prism mock) |
| `docs/contracts/purenet.openapi.yaml` | PureNet API draft: members, consents, subscriptions (INFERRED) |
| `docs/contracts/purenet-events.asyncapi.yaml` | PureNet → platform events draft (INFERRED) |
| `docs/contracts/platform-ingest.openapi.yaml` | Our ingest API, adopted from Orbit (CONFIRMED as Orbit behaviour) |
| `docs/contracts/platform-webhooks.asyncapi.yaml` | Our outbound webhooks, adopted from Orbit (CONFIRMED as Orbit behaviour) |
| `docs/contracts/ASSUMPTIONS.md` | Register of assumptions to validate |
| `mock/purenet/` | Prism mock: docker-compose, smoke test, examples |
| `docs/contracts/purenet-oauth.openapi.yaml` | PureNet token endpoint draft (INFERRED), so the mock can issue tokens |
| `src/integrations/purenet/` | **PureNet connector (provisional, built on INFERRED contracts)**: OAuth client, REST client with retries, webhook receiver with signature check and de-duplication, mapping to the platform's `/track` shape |
| `src/server.js` | Dev service: `POST /hooks/purenet`, `GET /healthz`, `GET /_dev/ingested` |
| `scripts/check-evidence.mjs` | Fails if any contract element lacks an `x-evidence` label |
| `scripts/sync-member.mjs`, `scripts/emit-events.mjs`, `scripts/e2e.sh` | Member sync, signed sample events, end-to-end run against the mocks |
| `.mcp.json` | REA reverse-engineering MCP server (analysis only; see CLAUDE.md rule 6) |

## Quick start
```bash
npm ci
npm run lint:contracts     # Redocly + AsyncAPI
npm run check:evidence     # every element labelled CONFIRMED (with a source) or INFERRED (with an A-NNN)
npm test                   # connector unit tests
npm run e2e                # starts both mocks + the service, syncs a member, sends signed events
npm run scan:secrets       # gitleaks
```

Running it by hand:
```bash
npm run mocks                                         # PureNet API :4010 + OAuth :4011
PURENET_WEBHOOK_SECRET=whsec_dev npm start            # service on :4100
npm run sync:member -- MBR-TEST-0001                  # member + consents → platform attributes
PURENET_WEBHOOK_SECRET=whsec_dev npm run emit:events  # signed sample events → /hooks/purenet
curl http://127.0.0.1:4100/_dev/ingested
```

Ground rules (no real data, no secrets, evidence labels, Orbit is read-only) are in [`CLAUDE.md`](CLAUDE.md).
