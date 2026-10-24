# ADR-0007: Integrations hub and AI assistant access (MCP)

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

Pure Engage has to connect to other applications. Some are systems with developers, like the Pura app or a CRM.
Others are no-code tools such as Zapier, Make and n8n, booking systems and form tools. AI assistants such as Claude
also need to reach it, using the Model Context Protocol (MCP).

Before this change, every API key could call every public endpoint, and the only public endpoints were `/track` and
`/messages/send`. Giving an AI agent such a key on a health platform is not acceptable.

## Decisions

### Integrations are one layer, and the AI connector is a client of it

The AI connector is built on the same foundations as every other integration, rather than as a separate system:
- scoped credentials;
- one public API that reuses the console's services, so contact resolution, consent history, delivery policy
  (`canSend`) and journeys behave identically;
- audit;
- a request log.

### Scoped API keys

There are twelve scopes. Keys carry a set of them and an optional expiry. Each route needs specific scopes. `/track`
needs them according to what the request does:
- attributes need `contacts:write`;
- consent needs `consent:write`;
- events need `events:write`.

A missing scope returns `403 insufficient_scope`. Keys created before scopes existed keep exactly what they could do
(`LEGACY_SCOPES`).

### Personal data stays masked by default

`contacts:read` returns initials, a masked email and phone number, and only attribute *names*, because attributes
can hold health details. Full values need `contacts:read_pii`.

Every read is audited as PHI access (`contact.view` / `contact.search` with `via` and `pii`). Lookups by external ID
or email go in the request body, so identifiers stay out of URLs and access logs.

### Inbound webhooks

Any tool that can POST JSON can send data in through `/hooks/in/:id`. A saved field mapping turns the payload into
the `/track` shape. The mapping is `applyMapping` in `packages/shared`, the same code that drives the console's live
preview. The result then goes through the normal ingest path.

Authentication:
- a bearer token, `X-PE-Token` or `?token=`. The query string is stripped from server logs, for tools that can only
  set a URL;
- or HMAC, the same scheme as our outbound webhooks.

Idempotency keys are namespaced per source as `hook:<id>:…`. Example payloads stay in the browser and are never
stored.

### Request log, metadata only

Each call made with a key, an OAuth grant or to an inbound webhook writes one row: route pattern (or MCP method and
tool name), status, item count, duration and error message. It never stores payloads, contact values or keys. The
retention job prunes the log.

### AI assistants connect over MCP with OAuth 2.1

`POST /mcp` is a stateless Streamable HTTP server built with the official SDK. Claude and other assistants find
authorization through:
- protected-resource metadata: `/.well-known/oauth-protected-resource/mcp`, advertised in `WWW-Authenticate` on 401;
- authorization-server metadata.

They then register dynamically and send an admin to a consent screen in the console. The authorization server:
- uses PKCE S256 only, with single-use 10-minute codes;
- accepts https redirect URIs, or http on loopback, and shows the redirect host on the consent screen;
- issues one-hour access tokens with rotating refresh tokens;
- stores only hashes of codes and tokens;
- lets an admin revoke a grant at any time.

API keys with scopes also work on `/mcp` for local tools.

### The AI can read and draft, never send

OAuth grants can only hold `AI_SCOPES`: read scopes plus `drafts:write`.

The MCP server registers only the tools the caller's scopes allow. There is deliberately no tool that sends,
schedules, activates or deletes anything. Drafts (segments, templates, draft campaigns) come back with a console link
for a person to review and launch.

Tool results go through the same masking as the API. Every action is audited as `integration` / `oauth:<grant>`.

### CORS only where it is needed

Only the discovery, registration, token and MCP endpoints allow cross-origin requests, for browser-based MCP
clients. They use bearer tokens, never cookies. The console API stays same-origin, with the CSRF header.

## Consequences

- The PureNet connector can later become one more integration, using its own scopes and the request log, once its
  contract is confirmed (CLAUDE.md rules 4 and 4a).
- New public endpoints must declare their scopes (`x-scopes` in the contract). New MCP tools must state which
  scope they need. A tool with external side effects (sending) needs a new ADR.
- Not yet covered: an approval queue for drafts, per-key rate limits, and push from Pure Engage into specific CRMs.
