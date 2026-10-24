# ADR-0009: Two-way Salesforce sync

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

Many PureHealth teams keep members and prospects in Salesforce. They want those people in Pure Engage with the
right consent, and they want sales and care staff to see in Salesforce what Pure Engage sent and what happened next.
Each customer brings their own org, so there is no shared Salesforce account to call.

The contract for the calls we make is `docs/contracts/salesforce.openapi.yaml`. Every element is CONFIRMED against
Salesforce's published documentation.

## Decisions

### The customer's own Connected App, OAuth web-server flow with PKCE

An admin creates a Connected App in their org and enters three things in the console:
- the login host: `login.salesforce.com`, `test.salesforce.com` or a My Domain;
- the consumer key;
- the consumer secret, which is stored encrypted (`PE_SECRET_KEY`, like webhook secrets) and never shown again.

**Connect with Salesforce** sends the admin to `<login host>/services/oauth2/authorize`, with:
- scopes `api refresh_token offline_access`;
- the callback `<PE_PUBLIC_URL>/oauth/salesforce/callback`;
- an S256 code challenge.

The state and the PKCE verifier stay on the server. The state is stored as a hash and the verifier is encrypted.
Both are bound to the admin's session (hash of the session token), single use, and valid for 10 minutes.

The callback accepts the code only from the same admin session. The browser brings the session cookie because it is
`SameSite=Lax` and this is a top-level navigation. The callback then:
1. exchanges the code with the verifier;
2. stores the refresh token (encrypted), `instance_url`, org ID and user name;
3. redirects to the console wizard.

Nothing returns a token or secret: not the API, not the request log, not the audit log. Error text from Salesforce
is scrubbed of emails and long digit runs before it is stored.

### Only Salesforce hosts

The login host and the returned `instance_url` must be https and end with `.salesforce.com`, `.my.salesforce.com`
or `.force.com`. Requests go through `safeRequest`, which applies the same SSRF guard and address pinning as
outbound webhooks.

`PE_SALESFORCE_ALLOW_ANY_HOST` lifts the host check for tests and local development (a local fake Salesforce).
`loadConfig` refuses it in production.

### One connection, stored as an integration

The connection is an `integrations` row of kind `salesforce`, so it shares the request log and the Integrations
overview. Its consumer secret is the row's encrypted secret. Everything else lives in `salesforce_connections`:
- tokens;
- mapping settings;
- pull cursors and the last run's counts;
- the push cursors.

The generic integrations API ignores this row, and so does `/hooks/in/:id`.

### Pull: Salesforce → Pure Engage

A worker step (`salesforce-pull`) syncs each connection every N minutes (default 15, set in the console). It claims
the connection with a lease taken through `FOR NO KEY UPDATE SKIP LOCKED`, so the row is never held locked while
Salesforce is called. An admin can also press **Sync now**.

For Contact (and Lead, if chosen), the pull:
- queries only the mapped fields, `WHERE SystemModstamp >= <cursor> ORDER BY SystemModstamp, Id`, following
  `nextRecordsUrl`;
- moves the per-object cursor forward after each page.

The cursor is inclusive. A crash between pages that share a timestamp re-reads those records rather than skipping
them. Re-reading is harmless: unchanged records count as "unchanged".

Each record goes through `contacts.upsert` with:
- source `salesforce:<integration id>`;
- actor `integration` / `salesforce:<integration id>`.

So contact resolution, consent history and audit behave as for any other source. The mapping:
- **external_id** comes from the chosen identity field, `Id` by default. A member ID field matches people who
  already exist in Pure Engage; with `Id`, a person already known from another source becomes a second contact.
- **Attributes** always include `salesforce_id` and `salesforce_object`.
- **Email** is taken if it is a valid email address. **Phone** is MobilePhone, then Phone, if it is valid E.164 once
  spaces, dots, hyphens and brackets are removed; otherwise it is skipped and counted as a warning.
- **FirstName** and **LastName** are copied. Empty Salesforce values never clear what Pure Engage already holds.
- **Custom fields** go to attributes, and here a null does clear the attribute.

Consent follows the house rule: only an explicit yes grants.
- `HasOptedOutOfEmail = true` denies email marketing. `false` grants nothing.
- `DoNotCall = true` denies SMS marketing. This is on by default.
- A mapped checkbox grants when ticked. When unticked it does nothing, unless "unticked means denied" is set for that
  mapping.
- A mapped picklist or text field goes through `normalizeConsentValue`.
- A denial always wins over a grant in the same record.

Each run records created, updated, unchanged, skipped, error and warning counts and the last error. It also writes one
request-log row per object (`SYNC salesforce pull Contact`).

### Push: Pure Engage → Salesforce

The pump (`salesforce-push` worker step) keeps two keyset cursors, both starting at "now" when the connection is made.
It never backfills.
- Over `message_events`, it looks at `sent`, `open`, `click` and `unsubscribe` for contacts that have a
  `salesforce_id`.
- Over `consent_history`, it looks at email-marketing denials whose source is *not* this connection, so opt-outs that
  came from Salesforce don't echo back.

The pump queues `salesforce_outbox` rows, one per source item: `(integration_id, source_key)` is unique.

Delivery claims due rows with `SKIP LOCKED` and a lease, and writes them through `composite/sobjects`, 200 records
per call:
- **Activity** becomes a Task: `WhoId`, `Subject` such as `Email opened: <template name>`, `Status=Completed`,
  `ActivityDate` in the default time zone, and a `Description` naming the campaign or journey. It never contains a
  message body or a contact detail.
- **An opt-out** sets `HasOptedOutOfEmail=true` on the Contact or Lead, when "write email opt-outs back" is on.

Which activity types are written is configurable.

When a whole call fails (a 5xx, the request limit, the network), the rows are retried on the webhook backoff
(1 min, 5 min, 30 min, 2 h, 6 h) and marked failed after six attempts. A record that Salesforce itself rejects fails
at once, except `UNABLE_TO_LOCK_ROW`, which is retried. An admin can retry failed rows from the console.

### Client behaviour

The client uses REST API version `v62.0`. It handles errors as follows:
- On 401 `INVALID_SESSION_ID`, it refreshes the access token once and retries. If the refresh token is refused
  (`invalid_grant`), the connection goes to the error state, the tokens are dropped and the admin is asked to
  reconnect.
- On `REQUEST_LIMIT_EXCEEDED`, 429, 5xx and network errors, it retries twice within the call (1 s, then 4 s) before
  the outbox backoff takes over.

**Disconnect** revokes the refresh token at Salesforce, on a best-effort basis, and deletes the stored tokens.
Synced contacts stay.

## Consequences

- Tests never reach Salesforce. `apps/api/test/fake-salesforce.ts` implements the contract subset (PKCE check,
  paging, describe, composite, a 401 once). The console e2e spec starts the same fake.
- Keyset cursors over `bigserial` IDs can, in theory, miss a row committed out of order in the instant between
  reading the maximum ID and the query. The windows are tiny (single-statement inserts); a periodic reconciliation
  would close it if it ever matters.
- One connection per installation. Several orgs would need a connection picker in the console and an org marker on
  synced contacts.
- Not covered yet: deletes and merges in Salesforce, custom objects, writing contact fields other than the email
  opt-out, and the Bulk API for very large first syncs.
