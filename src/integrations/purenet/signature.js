// A-011: `X-PureNet-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "{t}.{raw body}")>`.
// Modelled on Orbit's webhook signing (orbit@dbc6cc9 src/services/webhooks.js:11-12). Not confirmed for PureNet.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOLERANCE_SECONDS = 300;

export function sign(secret, rawBody, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${hmac(secret, t, rawBody)}`;
}

// Returns null when valid, otherwise a short reason.
export function verify(secret, rawBody, header, { now = Date.now(), tolerance = TOLERANCE_SECONDS } = {}) {
  if (!secret) return 'no signing secret configured';
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return 'malformed signature header';
  const t = Number(m[1]);
  if (Math.abs(Math.floor(now / 1000) - t) > tolerance) return 'timestamp outside tolerance';
  const expected = Buffer.from(hmac(secret, t, rawBody), 'hex');
  return timingSafeEqual(expected, Buffer.from(m[2], 'hex')) ? null : 'signature mismatch';
}

const hmac = (secret, t, rawBody) => createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
