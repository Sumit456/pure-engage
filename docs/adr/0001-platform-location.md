# ADR-0001: Build the platform in a new repo that references Orbit

- **Status:** Accepted (the platform was later named Pure Engage; see ADR-0003)
- **Date:** 2026-10-22

## Context
We're building a PureHealth engagement platform that integrates with PureNet. The one existing codebase is
**Orbit** (`Sumit456/Orbit`). It's a public, working SFMC/Braze-style marketing-automation app, built with the
help of reverse-engineering tooling, and it contains no PureHealth material (see `docs/audit/orbit-audit.md`).
Its ingest API, idempotency and webhook-signing patterns are useful prior art.

Options:
1. Put the platform in a new top-level folder or package inside the Orbit repo.
2. Create a new repo (`Sumit456/purenet-platform`, private; since renamed `Sumit456/pure-engage`) that references Orbit.

## Decision
**Option 2.** The platform lives in its own private repo. Orbit is referenced by URL and pinned commit
(`dbc6cc9`). It isn't vendored or added as a submodule. Useful patterns are re-implemented here, and each one
cites its Orbit source in the contract's `x-evidence` or in code comments.

## Rationale
- **Keeps unverified assumptions out of production.** Orbit is a reverse-engineered model of other vendors'
  products. Sharing a repo makes it easy to import its behaviour without noticing. With separate repos, every
  borrowed pattern has to cross a visible boundary and get an evidence label.
- **Different visibility and sensitivity.** Orbit is public. This platform will handle healthcare integration
  details and must be private, with stricter CI (secret scanning, evidence checks).
- **Different lifecycles.** Orbit is a standalone product with its own deploy (Render blueprint). Coupling the
  two in one repo would tie their releases, CI and dependencies together.
- **Clean audit trail.** A pinned commit makes the reference exact and reproducible.

## Consequences
- Some duplication: patterns (HMAC signing, idempotency, SSRF guard) are re-implemented rather than shared. If
  duplication grows, extract a small shared library with its own tests rather than merging the repos.
- Reverse-engineering notes about PureNet or other PureHealth systems also stay out of this repo. If that
  analysis is ever produced, it goes into a separate private analysis repo. Only validated contracts move here.
- Bumping the Orbit reference is a deliberate change: update the SHA and re-check the cited sources.
