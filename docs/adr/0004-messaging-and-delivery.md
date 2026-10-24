# ADR-0004: Messaging and delivery design

- **Status:** Accepted
- **Date:** 2026-10-22

## Context
Pure Engage sends care messages (for example appointment reminders) and marketing messages, by email (SMTP) and
SMS (Twilio), to people in the UAE, in English and Arabic. Mistakes here reach real patients, so the defaults
must be safe, and every send must be explainable afterwards.

## Decisions

**1. Sandbox by default.** `PE_DELIVERY_MODE=sandbox` (the default) records and "sends" every message without
contacting any provider. Real sending needs both `PE_DELIVERY_MODE=live` and provider credentials, and
`PE_DELIVERY_ALLOWLIST` can restrict live sends to test addresses (for example in staging). The console shows a
banner in sandbox mode or when an allowlist is active.

**2. Templates have a purpose, and the purpose decides the consent.** A template is either `care` or
`marketing`. Sending needs an explicit `granted` for that channel × purpose (`canSend`). Marketing also gets an
unsubscribe link (signed, with RFC 8058 one-click headers on email) and counts toward a weekly cap
(`PE_MARKETING_CAP_PER_WEEK`).

**3. Policy is checked twice.** At enqueue time: address, consent, suppression list, cap and SMS quiet hours (in
the contact's time zone, default Asia/Dubai, 21:00–08:00). Consent and suppression are checked again just
before sending, because consent can be withdrawn while a message waits. Suppressed messages are stored
without content (nothing is rendered), so the outbox explains every "not sent" without holding PHI it doesn't need.

**4. Rendering.** Liquid (liquidjs) with HTML output escaped by default, no file-system includes, and
render/memory limits. Templates are parsed when saved, so syntax errors surface in the editor and not at send
time. Arabic content is optional, and contacts with `preferred_language: ar*` fall back to English when it's missing.

**5. Queue: Postgres, not pg-boss.** ADR-0003 named pg-boss. Instead, the `messages` table *is* the queue: the
dispatcher claims due rows with `FOR UPDATE SKIP LOCKED`, which is safe across several API instances.
Retries use a backoff of 1 m, 5 m, 30 m and 2 h (5 attempts), and rows stuck in `sending` for 10 minutes are
re-queued (at-least-once delivery). This is one less dependency, the outbox and the queue can't drift apart,
and the state is plain SQL. If volumes outgrow it, the dispatcher is the only piece to replace.

**6. Tracking and privacy.** Open pixels and click redirects use signed tokens. Click links also sign the
destination, so the redirect can't be used as an open redirect. Viewing a message in the console strips the
pixel, so staff views don't count as opens. Opening a message or previewing a template against a real contact
is audited as PHI access. `PE_TRACKING_SECRET` is required in production.

**7. Provider receipts.** Twilio status callbacks are verified with `X-Twilio-Signature` and update the message
to delivered or failed. SMTP 5xx errors are permanent; 4xx and connection errors are retried.

## Consequences
- **SMS opt-out by reply ("STOP") isn't handled yet.** Twilio's inbound webhook needs wiring to set
  `sms.marketing = denied`. That's tracked for M6 (settings and hardening).
- **Bounces and complaints from SMTP aren't processed yet.** The suppression list exists for them, but needs
  a provider-specific webhook (for example SES or SendGrid events). Tracked for M6.
- **Rendered message bodies are personal data.** A retention job (M6) will clear `body_html`/`body_text` after
  a configurable period while keeping the delivery metadata.
