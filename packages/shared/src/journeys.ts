// Journey definition: a trigger plus a graph of steps (each step names the step(s) that follow).
// Shared by the API (validation, engine) and the console (builder).
import { z } from 'zod';
import { segmentRulesSchema } from './segments.ts';

export const MAX_JOURNEY_STEPS = 50;

const stepId = z.string().regex(/^[a-z0-9_-]{1,40}$/i, 'step ids are letters, digits, - and _');
const next = stepId.nullable().default(null); // null = end of the journey
export const durationSchema = z.object({
  days: z.number().int().min(0).max(365).default(0),
  hours: z.number().int().min(-8760).max(8760).default(0),
  minutes: z.number().int().min(-525600).max(525600).default(0),
});
export type Duration = z.infer<typeof durationSchema>;
export const durationMs = (d: Partial<Duration>) => (((d.days ?? 0) * 24 + (d.hours ?? 0)) * 60 + (d.minutes ?? 0)) * 60_000;
const propertyName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'property names are letters, digits and _');

export const stepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send'), template_id: z.string().uuid(), next }),
  z.object({ type: z.literal('wait'), duration: durationSchema, next }),
  /** Waits until a time taken from the trigger event (e.g. `start`) plus an offset (e.g. -24 h). */
  z.object({ type: z.literal('wait_until'), property: propertyName, offset: durationSchema, if_past: z.enum(['continue', 'exit']).default('continue'), next }),
  /** Branches on a segment-style condition evaluated against the contact now. */
  z.object({ type: z.literal('split'), condition: segmentRulesSchema, yes: next, no: next }),
  /** Waits for an event (optionally the same `match_property` value as the trigger), or times out. */
  z.object({ type: z.literal('wait_for_event'), event_name: z.string().min(1).max(200), match_property: propertyName.optional(), timeout: durationSchema, matched: next, timed_out: next }),
  z.object({ type: z.literal('update'), attributes: z.record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()])), next }),
]);
export type JourneyStep = z.infer<typeof stepSchema>;

export const journeyDefinitionSchema = z.object({
  trigger: z.object({
    event_name: z.string().min(1).max(200),
    /** Optional audience filter on the contact at entry time. */
    filter: segmentRulesSchema.optional(),
    /** Trigger property that identifies one run (e.g. `appointment_id`); one active run per contact per value. */
    entry_key: propertyName.optional(),
  }),
  /** Events that end a run early, e.g. the appointment being cancelled (matching `match_property`). */
  exit_on: z.array(z.object({ event_name: z.string().min(1).max(200), match_property: propertyName.optional() })).max(10).default([]),
  start: stepId,
  steps: z.record(stepId, stepSchema),
});
export type JourneyDefinition = z.infer<typeof journeyDefinitionSchema>;

/** The steps a step can lead to. */
export function nextSteps(step: JourneyStep): (string | null)[] {
  switch (step.type) {
    case 'split': return [step.yes, step.no];
    case 'wait_for_event': return [step.matched, step.timed_out];
    default: return [step.next];
  }
}

/** Structural problems (missing steps, unreachable steps, loops). Empty means valid. */
export function journeyProblems(def: JourneyDefinition): { step?: string; message: string }[] {
  const problems: { step?: string; message: string }[] = [];
  const ids = Object.keys(def.steps);
  if (ids.length > MAX_JOURNEY_STEPS) problems.push({ message: `A journey can have at most ${MAX_JOURNEY_STEPS} steps` });
  if (!def.steps[def.start]) problems.push({ message: `Start step "${def.start}" doesn't exist` });
  for (const [id, step] of Object.entries(def.steps)) {
    for (const n of nextSteps(step)) if (n && !def.steps[n]) problems.push({ step: id, message: `Leads to "${n}", which doesn't exist` });
  }
  // Loops are rejected outright: every run must end.
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 'visiting') return false;
    if (state.get(id) === 'done' || !def.steps[id]) return true;
    state.set(id, 'visiting');
    for (const n of nextSteps(def.steps[id]!)) if (n && !visit(n)) { problems.push({ step: id, message: 'Steps form a loop' }); return false; }
    state.set(id, 'done');
    return true;
  };
  if (def.steps[def.start]) visit(def.start);
  for (const id of ids) if (!state.has(id)) problems.push({ step: id, message: 'Not reachable from the start' });
  return problems;
}
