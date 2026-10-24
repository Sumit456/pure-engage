# ADR-0005: Journeys engine

- **Status:** Accepted
- **Date:** 2026-10-22

## Context
The main use case is PureNet-driven care messaging, for example: confirm a booking, remind the member 24 hours
before, and stop if the appointment is cancelled. That needs event triggers, waits measured against times inside
the event (the appointment start), waits for other events, branching, and exactly-once behaviour across
retries, restarts and several API instances.

## Decisions

**1. Definition = trigger + step graph** (`packages/shared/src/journeys.ts`). The step types are `send`, `wait`,
`wait_until` (event property + offset, e.g. `start` − 24 h), `wait_for_event` (optionally matching a property
such as `appointment_id`, with a timeout branch), `split` (the segment rule language, evaluated now) and
`update`. Loops are rejected, so every run ends. The trigger can carry an audience `filter` and an `entry_key`
(one active run per contact per value, e.g. per appointment). `exit_on` lists events that end a run early,
optionally matched on a property.

**2. Events are processed by the worker, not in the request.** Events get `processed_at`. The worker claims
unprocessed events (`FOR UPDATE SKIP LOCKED`) and, per event, handles: exits → resuming runs waiting for that
event → new entries. Ingest stays fast, a crash between commit and processing loses nothing, and every
instance can share the load. Only events received after a journey's activation trigger it. Events from before
journeys existed are marked processed by the migration.

**3. Runs advance under a lease.** Due runs are claimed by moving `next_run_at` 5 minutes ahead before any work
starts. If a worker dies mid-step, the run is retried after the lease. Sends use the idempotency key
`journey:<run>:<step>`, so a retried step never sends twice. A run executes consecutive non-waiting steps in one
go (bounded), then parks on its next wait.

**4. Policy still applies.** A `send` step goes through the same delivery path as everything else (consent,
quiet hours, caps, sandbox). A message that's not sent is logged as `not_sent` with the reason, and the run
carries on.

**5. Editing rules.** Only draft or paused journeys can be edited. Pausing stops entries and step execution, and
resuming continues each run where it was. A run parked on a step that was removed exits with `step_removed`.
Archiving stops all active runs.

**6. Builder: a step tree, not a free-form canvas.** The console draws the graph from the start step, with
branches side by side. It adds steps at open ends and removes steps (pruning anything that becomes unreachable).
That covers the care and marketing flows we know of, works with keyboard and screen readers, and mirrors
correctly in Arabic. The API accepts any acyclic graph, so a canvas editor can be added later without
changing the engine. A dry-run simulator shows the path, the timing and who would receive each message,
without side effects.

**7. Starter.** "Appointment reminders" creates two bilingual care templates (an email confirmation and an SMS
24 hours before) and a draft journey on `purenet.appointment.booked`, keyed by `appointment_id`, which exits on
`purenet.appointment.cancelled`. Times render in the member's time zone and language with the
`local_datetime` Liquid filter.

## Consequences
- The PureNet event names and properties (`appointment_id`, `start`) are INFERRED (A-009, A-014). If PureNet's
  real payloads differ, the connector mapping changes, and journeys keep working on the platform's own event names.
- Entering a segment isn't a trigger yet; that would need segment membership snapshots. Event and API triggers
  cover the current use cases.
