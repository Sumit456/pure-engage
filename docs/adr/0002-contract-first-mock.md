# ADR-0002: Mock PureNet with Prism, served directly from the OpenAPI contract

- **Status:** Accepted
- **Date:** 2026-10-22

## Context
We need a PureNet stand-in so platform work can begin before we have sandbox access. We have no evidence of
PureNet's real behaviour, so every contract element is INFERRED and will change as the PureNet team answers
`docs/contracts/ASSUMPTIONS.md`.

Options considered:
- Stoplight Prism, generated from OpenAPI.
- A handwritten Node/Fastify mock.
- A handwritten Python/FastAPI mock.

## Decision
Use **Stoplight Prism** (`prism mock`) on `docs/contracts/purenet.openapi.yaml`. Run it with `npm run mock:purenet`
or with `mock/purenet/docker-compose.yml`.

## Rationale
- **One source of truth.** The mock is the contract. Fixing an assumption in the YAML fixes the mock, and
  there's no handwritten server code to drift from it.
- **Request validation for free.** Prism rejects requests that don't match the spec (for example a missing
  bearer token, a bad body or a missing required parameter). Our adapter is tested against the contract, not
  against whatever a handwritten mock happens to accept.
- **Deterministic by default.** Static mode returns the spec's examples. Dynamic mode (`-d`) is available for
  fuzz-style tests.
- **Low cost.** It's a pinned dev dependency, and there's no server code to maintain.

## Consequences
- Prism doesn't keep state (for example, a created subscription won't appear in a later GET) and can't push
  webhooks. When stateful flows or event emission are needed, add a small event emitter that posts the
  `purenet-events.asyncapi.yaml` examples, signed per A-011, to the platform. Keep it next to the mock and
  generate it from the AsyncAPI examples.
- Prism is pinned to an exact version, so upgrades are explicit.
