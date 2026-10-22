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
PE_NEW_USER_PASSWORD='choose-a-long-one' npm run create-user -- you@example.com admin "Your Name"
npm run dev:api        # API on http://127.0.0.1:4200 (applies migrations on start)
npm run dev:console    # console on http://127.0.0.1:5173
```

## API at a glance
| Area | Endpoints | Access |
|---|---|---|
| Auth | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/password` | Session cookie (httpOnly) + `x-pe-csrf: 1` on writes; 30 min idle / 12 h max |
| Contacts | `GET/POST /api/contacts`, `GET/PATCH/DELETE /api/contacts/:id`, `GET /api/contacts/:id/events` | viewer reads, marketer writes, admin deletes; every contact view is audited |
| Admin | `/api/users`, `/api/api-keys`, `GET /api/audit` | admin |
| Templates | `GET/POST /api/templates`, `GET/PUT/DELETE /api/templates/:id`, `…/versions`, `…/versions/:v/restore`, `POST /api/templates/preview` | viewer reads, marketer writes |
| Messages | `GET /api/messages`, `GET /api/messages/:id` (audited), `GET /api/delivery/status` | viewer |
| Public ingest | `POST /api/v1/track`, `POST /api/v1/messages/send` ([contract](docs/contracts/platform-ingest.openapi.yaml)) | `Authorization: Bearer pe_…` API key |
| Recipients | `GET /t/o/:token` (open), `GET /t/c/:token` (click), `GET/POST /u/:token` (unsubscribe, RFC 8058) | signed tokens |
| Twilio | `POST /hooks/twilio/status` | `X-Twilio-Signature` |
| PureNet | `POST /hooks/purenet` (only when `PURENET_WEBHOOK_SECRET` is set) | HMAC signature (A-011) |

Consent is stored per channel (`email`, `sms`, `push`) and purpose (`care`, `marketing`), with a history row per
change. Anything not explicitly `granted` counts as denied.

**Delivery is sandboxed by default.** Nothing reaches a real inbox or phone until `PE_DELIVERY_MODE=live` *and*
SMTP/Twilio credentials are set (see [ADR-0004](docs/adr/0004-messaging-and-delivery.md) and `.env.example`).
Use `PE_DELIVERY_ALLOWLIST` to limit live sends to test addresses.

Checks (all run in CI):
```bash
npm test               # connector + API (against Postgres) + console
npm run typecheck
npm run build
npm run lint:contracts && npm run check:evidence
npm run e2e:console    # Playwright: real API + Postgres + console
npm run e2e:purenet    # PureNet flow against the Prism mocks
npm run scan:secrets   # gitleaks
```

Configuration lives in environment variables; see [`.env.example`](.env.example). Ground rules (no real data,
no secrets, evidence labels, code conventions) are in [`CLAUDE.md`](CLAUDE.md).
