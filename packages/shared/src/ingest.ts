// Zod mirror of docs/contracts/platform-ingest.openapi.yaml (TrackRequest and friends).
import { z } from 'zod';

const contactRef = {
  external_id: z.string().min(1).max(200).optional(),
  email: z.string().email().max(320).optional(),
  contact_id: z.string().uuid().optional(),
};
const hasRef = (v: { external_id?: string | undefined; email?: string | undefined; contact_id?: string | undefined }) =>
  Boolean(v.external_id || v.email || v.contact_id);
const refMessage = 'one of external_id, email or contact_id is required';

export const attributesSchema = z.object(contactRef).passthrough().refine(hasRef, refMessage);

export const trackEventSchema = z
  .object({
    ...contactRef,
    name: z.string().min(1).max(200),
    properties: z.record(z.unknown()).default({}),
    time: z.string().datetime({ offset: true }).optional(),
    idempotency_key: z.string().min(1).max(200).optional(),
  })
  .refine(hasRef, refMessage);

export const MAX_TRACK_OBJECTS = 500;

export const trackRequestSchema = z.object({
  attributes: z.array(z.unknown()).default([]),
  events: z.array(z.unknown()).default([]),
});

export type TrackEvent = z.infer<typeof trackEventSchema>;

export interface TrackResult {
  attributes_processed: number;
  events_processed: number;
  duplicates: number;
  errors: { type: 'attribute' | 'event'; index: number; error: string }[];
}
