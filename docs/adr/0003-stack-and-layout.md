# ADR-0003: Pure Engage stack and repository layout

- **Status:** Accepted
- **Date:** 2026-10-22

## Context
The platform is now **Pure Engage**: PureHealth's member engagement and marketing automation platform. It sits
alongside the Pura app. It is a new application with its own look and feel; no Orbit code is reused (ADR-0001
still applies). The owner chose Node + PostgreSQL + React and asked for the full platform, built in milestones.

## Decision
An npm-workspaces monorepo:

| Path | What | Key choices |
|---|---|---|
| `apps/api` | HTTP API, jobs, delivery | Fastify 5; PostgreSQL 16 via Kysely (typed SQL + migrations); pg-boss (Postgres-backed jobs/timers, no Redis); zod validation |
| `apps/console` | Web console | React 19 + Vite; React Router; TanStack Query; react-i18next (English + Arabic, RTL); all styling from `src/theme/tokens.css` |
| `packages/shared` | Schemas/types used by both | zod; mirrors `docs/contracts/platform-ingest.openapi.yaml` |
| `packages/purenet-connector` | PureNet integration | Unchanged JavaScript, node:test; still the only code that knows PureNet field names |

**TypeScript without a build step for the API.** Node 22 strips types natively (no tsx, no compile). This
requires "erasable" TypeScript only (`erasableSyntaxOnly`: no enums, namespaces or parameter properties) and
explicit `.ts` import extensions. `tsc` is used for type checking only. The console is built by Vite.

**Real Postgres in tests.** API tests run against a dedicated `*_test` database that's recreated per run (a
local cluster via `scripts/dev-db.sh`, or a `postgres:16` service in CI). There's no in-memory fake, so SQL
behaviour (JSONB, constraints, locking) is what production gets.

**Versions are pinned exactly.** Major versions were chosen for stability: TypeScript 5.9, Vitest 3, zod 3,
Vite 6. Root `devDependencies` pin `typescript` and `@types/node` so tooling deps (AsyncAPI CLI) can't hoist
older ones.

## Consequences
- One `npm ci` installs everything. `npm test`, `npm run typecheck` and `npm run build` fan out to the workspaces.
- Runtime is Node ≥ 22.18 (type stripping on by default).
- The brand is a placeholder until PureHealth's colours and fonts are confirmed. Swapping them is a
  one-file change in `apps/console/src/theme/tokens.css`.
- The GitHub repo was renamed from `purenet-platform` to `Sumit456/pure-engage` on 2026-10-22. GitHub
  redirects the old URL.
