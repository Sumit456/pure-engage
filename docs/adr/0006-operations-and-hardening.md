# ADR-0006: Reporting, outbound webhooks and operational hardening

- **Status:** Accepted
- **Date:** 2026-10-22

## Decisions

**Reports are aggregates only.** The dashboard KPIs, daily volumes per channel (bucketed by day in
`PE_DEFAULT_TIMEZONE`), the not-sent reasons and the campaign and journey summaries all return counts. CSV exports
are aggregate too, and cells that start with `= + - @` are prefixed with `'` so a spreadsheet can't run them as
formulas. Ranges are capped at 366 days. Charts follow the data-visualisation rules: one y-axis, two validated
series colours (light and dark mode checked with the palette validator), a legend plus direct labels, keyboard
and pointer tooltips, and a table view.

**Outbound webhooks** (`platform-webhooks.asyncapi.yaml`, now CONFIRMED by our own tests):
- Signed with `X-PE-Signature` (HMAC-SHA256 over `"{t}.{body}"`), with `X-PE-Event` and `X-PE-Delivery` headers.
- Payloads carry identifiers only, never profile data.
- Signing secrets are encrypted at rest (AES-256-GCM, `PE_SECRET_KEY`), shown once, and rotatable.
- Delivery runs from the worker with a lease, a backoff of 1 m, 5 m, 30 m, 2 h and 6 h (6 attempts), a
  delivery log and manual retry.
- SSRF protection: https only (no credentials in the URL). The host is resolved and every address is checked
  against private, loopback, link-local and metadata ranges, and the connection is pinned to the checked
  address to defeat DNS rebinding. `PE_WEBHOOKS_ALLOW_PRIVATE` exists for local development and is refused in
  production.

**SMS opt-out.** Twilio inbound messages (signature-verified) that match STOP-style keywords in English or Arabic
set `sms.marketing = denied` for every contact with that number, recorded with source `sms_stop`. Care messages
are unaffected, because care consent is a separate decision.

**Retention.** A daily worker step (at most once per day across instances):
- clears rendered message bodies after `PE_MESSAGE_BODY_RETENTION_DAYS` (default 90), keeping delivery
  metadata for reports;
- deletes webhook delivery logs after `PE_WEBHOOK_LOG_RETENTION_DAYS`;
- deletes expired sessions.

Each run is audited. It runs inside the transaction that holds its lock: an earlier version wrote the lock row
over a second connection and deadlocked on the second day (see CLAUDE.md).

**Deployment.**
- **One image.** The `Dockerfile` builds the console and runs the API, which also serves the console
  (`PE_CONSOLE_DIR`, with page-reload routing, immutable caching for hashed assets and no path traversal).
  `docker-compose.yml` adds Postgres.
- **Fails closed.** Production refuses to start without `PE_TRACKING_SECRET` and `PE_SECRET_KEY`.
- **Secure defaults.** Session cookies are `Secure`, and helmet sets CSP, HSTS and frame-deny. These were
  checked by driving the production build in Chromium: no CSP violations, and the sandboxed email previews render.

## Consequences
- Provider credentials (SMTP, Twilio) stay in the environment and aren't editable in the console. The settings
  page shows the mode and providers read-only. Moving them into the database would need encrypted storage and
  a re-validation flow; it's deferred until operators ask for it.
- SMTP bounces and complaints still need a provider-specific feed (for example SES or SendGrid events) to fill
  the suppression list automatically.
- The Docker image is built and smoke-tested in CI. Docker isn't available in the development sandbox.
