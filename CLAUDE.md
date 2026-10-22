# CLAUDE.md

Rules for anyone (human or agent) working in this repository.

## What this repo is
The production codebase for the PureHealth engagement platform that integrates with PureNet.
It is contract-first: `docs/contracts/` is the source of truth, and the PureNet mock is generated from it.

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
4a. PureNet code lives only in `src/integrations/purenet/` and tags each assumption it relies on with its
   `A-NNN` ID. Nothing outside that folder uses PureNet field names: the connector hands the rest of the
   platform its own `/track` shape (`platform-ingest.openapi.yaml`).
5. **Orbit (`github.com/Sumit456/Orbit`) is read-only prior art.** Reference it by pinned commit (`dbc6cc9`).
   Re-implement patterns here; don't copy files or add it as a submodule (see ADR-0001).
6. Reverse-engineering notes about PureNet or other PureHealth systems don't go in this repo. They belong in a
   separate analysis repo. Only validated contracts cross over. The REA MCP server is configured in `.mcp.json`
   (pinned `rea-agents@6.7.0`) for convenience. Its output (captures, decompiled code, evidence bundles) is
   analysis material: don't commit it here. Use it to *propose* a change to `ASSUMPTIONS.md`, and treat the item
   as INFERRED until the PureNet team confirms it.

## Commands
- `npm test`: connector unit tests (`node:test`)
- `npm run e2e`: end-to-end run against both Prism mocks
- `npm run lint:contracts`: lint the OpenAPI and AsyncAPI specs
- `npm run check:evidence`: check that every contract element is labelled
- `npm run mocks`: run the PureNet API mock (:4010) and OAuth mock (:4011)
- `npm run smoke:purenet`: run curl checks against a running mock
- `npm run scan:secrets`: run gitleaks (local binary, or Docker as a fallback)
