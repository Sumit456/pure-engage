// Stand-in for PureNet pushing events (ADR-0002): POSTs every payload example from
// docs/contracts/purenet-events.asyncapi.yaml to the receiver, signed per A-011.
// Usage: PURENET_WEBHOOK_SECRET=... node scripts/emit-events.mjs [url] [--twice]
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { sign } from '../src/signature.js';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--')) || 'http://127.0.0.1:4100/hooks/purenet';
const twice = args.includes('--twice'); // resend everything to exercise de-duplication
const secret = process.env.PURENET_WEBHOOK_SECRET;
if (!secret) { console.error('PURENET_WEBHOOK_SECRET is required'); process.exit(2); }

const spec = parse(readFileSync(new URL('../../../docs/contracts/purenet-events.asyncapi.yaml', import.meta.url), 'utf8'));
const payloads = Object.values(spec.components.messages).flatMap((m) => (m.examples ?? []).map((e) => e.payload));

let failed = 0;
for (const round of twice ? [1, 2] : [1]) {
  for (const payload of payloads) {
    const body = JSON.stringify(payload);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-purenet-event': payload.type, 'x-purenet-delivery': `dlv_${payload.id}`, 'x-purenet-signature': sign(secret, body) },
      body,
    });
    const text = await res.text();
    if (!res.ok) failed++;
    console.log(`round ${round}  ${res.status}  ${payload.type.padEnd(24)} ${payload.id}  ${text}`);
  }
}
process.exit(failed ? 1 : 0);
