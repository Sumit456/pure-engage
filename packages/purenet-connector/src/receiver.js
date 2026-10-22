// Webhook receiver for PureNet events (purenet-events.asyncapi.yaml, all INFERRED).
// Order: verify signature on the raw body (A-011) → parse → de-duplicate on envelope id (A-010) → map → sink.
import { verify } from './signature.js';
import { eventToTrack, memberToAttributes } from './mapping.js';

const MAX_BODY = 256 * 1024;

// sink(trackRequest) receives the platform's TrackRequest. `client` (optional) refetches the member on
// member.updated so the profile carries current data rather than just the list of changed fields.
export function createReceiver({ secret, sink, client, seen = createSeenSet(), log = () => {}, now = Date.now }) {
  return async function handle(req, res) {
    const raw = await readBody(req).catch(() => null);
    if (raw === null) return reply(res, 413, { error: 'body too large' });

    const problem = verify(secret, raw, req.headers['x-purenet-signature'], { now: now() });
    if (problem) { log('warn', 'rejected PureNet delivery', { reason: problem }); return reply(res, 401, { error: 'invalid signature' }); }

    let envelope;
    try { envelope = JSON.parse(raw.toString('utf8')); } catch { return reply(res, 400, { error: 'invalid JSON' }); }
    if (!envelope?.id || !envelope?.type) return reply(res, 400, { error: 'missing id or type' });

    if (seen.has(envelope.id)) return reply(res, 200, { status: 'duplicate' });

    const track = eventToTrack(envelope);
    if (!track) { seen.add(envelope.id); return reply(res, 202, { status: 'ignored', type: envelope.type }); }

    try {
      if (envelope.type === 'member.updated' && client) {
        const id = envelope.data.memberId;
        const [member, consents] = await Promise.all([client.getMember(id), client.listConsents(id)]);
        track.attributes.push(memberToAttributes(member, consents));
      }
      await sink(track);
    } catch (err) {
      // Not marked as seen, so PureNet's retry (A-010 at-least-once) gets another chance.
      log('error', 'PureNet event processing failed', { id: envelope.id, type: envelope.type, error: err.message });
      return reply(res, 503, { error: 'processing failed, retry later' });
    }
    seen.add(envelope.id);
    log('info', 'PureNet event ingested', { id: envelope.id, type: envelope.type });
    return reply(res, 200, { status: 'ok' });
  };
}

// Bounded in-memory de-duplication. Swap for a shared store (DB/Redis) once there is more than one instance.
export function createSeenSet(max = 10_000) {
  const ids = new Set();
  return {
    has: (id) => ids.has(id),
    add(id) {
      ids.add(id);
      if (ids.size > max) ids.delete(ids.values().next().value);
    },
  };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
