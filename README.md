# Pure Engage

PureHealth's member engagement and marketing automation platform, alongside the Pura app. It manages
contacts and consent, segments, templates, campaigns, multi-step journeys (for example appointment reminders)
and email/SMS delivery, and integrates with PureNet.

> **Status: under construction, built in milestones** (see [ADR-0003](docs/adr/0003-stack-and-layout.md)).
> The PureNet integration is built on **INFERRED** contracts until the PureNet team answers
> [`docs/contracts/ASSUMPTIONS.md`](docs/contracts/ASSUMPTIONS.md).

## Layout
| Path | What |
|---|---|
| `apps/api` | Fastify API + PostgreSQL (Kysely, migrations). TypeScript run directly by Node 22 |
| `apps/console` | React + Vite console. English and Arabic (RTL). Theme in `src/theme/tokens.css` |
| `packages/shared` | zod schemas and types shared by the API and console |
| `packages/purenet-connector` | Provisional PureNet connector: OAuth, REST client, signed webhook receiver, mapping |
| `docs/contracts/` | OpenAPI/AsyncAPI contracts (every element labelled CONFIRMED or INFERRED) + `ASSUMPTIONS.md` |
| `docs/adr/` | Decisions: 0001 repo location, 0002 contract-first mock, 0003 stack and layout |
| `docs/audit/orbit-audit.md` | Audit of `Sumit456/Orbit` (prior art only; no code reused) |
| `mock/purenet/` | Prism mock of PureNet, smoke test, examples |
| `scripts/` | `dev-db.sh` (local Postgres), `check-evidence.mjs`, `e2e-purenet.sh` |
| `.mcp.json` | REA reverse-engineering MCP server (analysis only; see CLAUDE.md rule 6) |

## Getting started
Requires Node ≥ 22.18 and PostgreSQL 16 (or set `PE_DATABASE_URL` / `PE_TEST_DATABASE_URL` to your own server).

```bash
npm ci
npm run db             # local Postgres on :5433 with pure_engage and pure_engage_test databases
npm run dev:api        # API on http://127.0.0.1:4200 (applies migrations on start)
npm run dev:console    # console on http://127.0.0.1:5173
```

Checks (all run in CI):
```bash
npm test               # connector + API (against Postgres) + console
npm run typecheck
npm run build
npm run lint:contracts && npm run check:evidence
npm run e2e            # PureNet flow against the Prism mocks
npm run scan:secrets   # gitleaks
```

Configuration lives in environment variables; see [`.env.example`](.env.example). Ground rules (no real data,
no secrets, evidence labels, code conventions) are in [`CLAUDE.md`](CLAUDE.md).
