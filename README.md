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
| `scripts/check-evidence.mjs` | Fails if any contract element lacks an `x-evidence` label |

## Quick start
```bash
npm ci
npm run lint:contracts     # Redocly + AsyncAPI
npm run check:evidence     # every element labelled CONFIRMED (with a source) or INFERRED (with an A-NNN)
npm run mock:purenet       # PureNet mock on http://127.0.0.1:4010
npm run smoke:purenet      # in another terminal
npm run scan:secrets       # gitleaks
```

Ground rules (no real data, no secrets, evidence labels, Orbit is read-only) are in [`CLAUDE.md`](CLAUDE.md).
