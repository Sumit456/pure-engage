// POST /api/v1/track semantics from docs/contracts/platform-ingest.openapi.yaml:
// attributes first, then events; per-item errors (207) instead of failing the batch.
import { MAX_TRACK_OBJECTS, attributesSchema, trackEventSchema, trackRequestSchema, type TrackResult } from '@pure-engage/shared';
import { HttpError, badRequest } from '../errors.ts';
import type { Actor } from './audit.ts';
import type { ContactsService } from './contacts.ts';
import type { EventsService } from './events.ts';

const message = (err: unknown) =>
  err instanceof HttpError && Array.isArray(err.details) && err.details.length
    ? `${err.message}: ${err.details.map((d: { path?: string; message?: string }) => `${d.path ? `${d.path} ` : ''}${d.message}`).join('; ')}`
    : err instanceof Error ? err.message : String(err);

// Only validation and conflict errors are reported per item; anything else (DB down) aborts so the caller retries.
const isItemError = (err: unknown) => err instanceof HttpError && err.statusCode < 500;

export function createIngestService(contacts: ContactsService, events: EventsService) {
  return {
    async track(body: unknown, opts: { source: string; actor: Actor }): Promise<{ status: 201 | 207; result: TrackResult }> {
      const parsed = trackRequestSchema.safeParse(body ?? {});
      if (!parsed.success) throw badRequest('attributes and events must be arrays');
      const { attributes, events: evts } = parsed.data;
      if (attributes.length + evts.length > MAX_TRACK_OBJECTS) throw new HttpError(413, `Max ${MAX_TRACK_OBJECTS} objects per request`);

      const result: TrackResult = { attributes_processed: 0, events_processed: 0, duplicates: 0, errors: [] };

      for (const [index, raw] of attributes.entries()) {
        const item = attributesSchema.safeParse(raw);
        if (!item.success) { result.errors.push({ type: 'attribute', index, error: item.error.issues.map((i) => i.message).join('; ') }); continue; }
        try {
          await contacts.upsert(item.data, opts);
          result.attributes_processed++;
        } catch (err) {
          if (!isItemError(err)) throw err;
          result.errors.push({ type: 'attribute', index, error: message(err) });
        }
      }

      for (const [index, raw] of evts.entries()) {
        const item = trackEventSchema.safeParse(raw);
        if (!item.success) { result.errors.push({ type: 'event', index, error: item.error.issues.map((i) => `${i.path.join('.') || 'event'}: ${i.message}`).join('; ') }); continue; }
        try {
          // Keys from API callers live under `api:` (inbound webhooks under `hook:<id>:`) so they can never collide
          // with keys the platform and the PureNet receiver mint (`purenet:`, `journey:`, `campaign:`) and suppress
          // a legitimate event.
          const ns = opts.source === 'api' ? 'api:' : opts.source.startsWith('hook:') ? `${opts.source}:` : '';
          const key = item.data.idempotency_key && `${ns}${item.data.idempotency_key}`;
          const { duplicate } = await events.track({ ...item.data, idempotency_key: key }, opts);
          if (duplicate) result.duplicates++;
          else result.events_processed++;
        } catch (err) {
          if (!isItemError(err)) throw err;
          result.errors.push({ type: 'event', index, error: message(err) });
        }
      }

      return { status: result.errors.length ? 207 : 201, result };
    },
  };
}

export type IngestService = ReturnType<typeof createIngestService>;
