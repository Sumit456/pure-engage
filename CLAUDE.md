# CLAUDE.md

Rules for anyone (human or agent) working in this repository.

## What this repo is
**Pure Engage**: PureHealth's member engagement and marketing automation platform (alongside the Pura app).
An npm-workspaces monorepo (ADR-0003): `apps/api` (Fastify + PostgreSQL), `apps/console` (React + Vite),
`packages/shared`, `packages/purenet-connector`. Integrations are contract-first: `docs/contracts/` is the
source of truth, and the PureNet mock is generated from it.

## Hard rules
1. **No real data, ever.** No patient data, PHI, real names, national IDs, phone numbers or emails.
   Examples and fixtures use synthetic values only (`example.com`, `MBR-TEST-*`, `+971500000xxx`).
2. **No secrets in the repo.** Credentials come from the environment or a secret manager. `npm run scan:secrets`
   and CI (gitleaks) must stay clean. If a secret is committed, rotate it first and then rewrite history.
3. **Every contract element carries `x-evidence`** (`npm run check:evidence` enforces this):
   - `status: CONFIRMED` means documented or tested, with `source: <repo>@<sha> <path>` or a document reference.
   - `status: INFERRED` means it's an assumption, with `assumption: A-NNN` pointing at `docs/contracts/ASSUMPTIONS.md`.
4. **Don't build production logic on INFERRED items** beyond the mock and adapter interfaces. First get the item
   CONFIRMED by the PureNet team, then update `ASSUMPTIONS.md` and the contract.
4a. PureNet code lives only in `packages/purenet-connector/` and tags each assumption it relies on with its
   `A-NNN` ID. Nothing outside that folder uses PureNet field names: the connector hands the rest of the
   platform its own `/track` shape (`platform-ingest.openapi.yaml`).
5. **Orbit (`github.com/Sumit456/Orbit`) is read-only prior art.** Reference it by pinned commit (`dbc6cc9`).
   Re-implement patterns here; don't copy files or add it as a submodule (see ADR-0001).
6. Reverse-engineering notes about PureNet or other PureHealth systems don't go in this repo. They belong in a
   separate analysis repo. Only validated contracts cross over. The REA MCP server is configured in `.mcp.json`
   (pinned `rea-agents@6.7.0`) for convenience. Its output (captures, decompiled code, evidence bundles) is
   analysis material: don't commit it here. Use it to *propose* a change to `ASSUMPTIONS.md`, and treat the item
   as INFERRED until the PureNet team confirms it.

## Code conventions
- API TypeScript runs directly on Node 22 type stripping: erasable syntax only (no `enum`, `namespace` or
  constructor parameter properties), `import type` for types, and `.ts` extensions on relative imports.
- Every schema change is a new file in `apps/api/src/db/migrations/` with `up` and `down`, plus matching types in
  `apps/api/src/db/schema.ts`. Never edit a migration that has been pushed.
- Console styling reads CSS variables from `apps/console/src/theme/tokens.css` only (no hard-coded colours).
  Use logical CSS properties (`inline-start`/`inline-end`) so Arabic RTL works. Every UI string goes in both
  `en.json` and `ar.json` (a test enforces matching keys).

## Domain rules
- Consent is per channel × purpose. Only an explicit `granted` permits sending (`canSend` in `packages/shared`).
  Every consent change writes a `consent_history` row with its source.
- Opening a contact (`GET /api/contacts/:id`) is PHI access and is audited. Audit `details` record which fields
  changed, never their values.
- Contacts resolve by `contact_id` → `external_id` → `email`. Email-only matching refuses ambiguous matches.
- Templates are `care` or `marketing`; the purpose decides which consent is needed. Delivery policy runs at
  enqueue *and* again before sending (ADR-0004). Never add a code path that sends without `canSend`.
- Segment rules are compiled to SQL in `apps/api/src/services/segments.ts`. Every user value must stay a bound
  parameter; operators come from fixed allowlists. New rule types need a test in `test/segments.test.ts`.
- Background work (campaign fan-out, dispatch) claims rows with `SKIP LOCKED`. Lock a row that other rows
  reference by foreign key with `FOR NO KEY UPDATE`, not `FOR UPDATE`, or concurrent inserts deadlock.
- Delivery defaults to the sandbox. Tests must never reach a real provider: use the local SMTP server and the fake
  Twilio in `apps/api/test/delivery.test.ts`.

## Commands
- `npm run db`: start the local Postgres (`.pgdata`, port 5433) and create the dev and test databases
- `npm run dev:api` / `npm run dev:console`: API on :4200, console on :5173 (proxies `/api`)
- `npm test`: all workspaces (connector node:test, API Vitest against Postgres, console Vitest)
- `npm run typecheck`, `npm run build`
- `npm run migrate`: apply API migrations to `PE_DATABASE_URL`
- `PE_NEW_USER_PASSWORD=… npm run create-user -- <email> [admin|marketer|viewer] [name]`: create a console user
- `npm run e2e:console`: Playwright against the real API, Postgres (fresh `pure_engage_e2e`) and the console
- `npm run e2e:purenet`: PureNet end-to-end run against both Prism mocks
- `npm run lint:contracts`: lint the OpenAPI and AsyncAPI specs
- `npm run check:evidence`: check that every contract element is labelled
- `npm run mocks`: run the PureNet API mock (:4010) and OAuth mock (:4011)
- `npm run smoke:purenet`: run curl checks against a running mock
- `npm run scan:secrets`: run gitleaks (local binary, or Docker as a fallback)
