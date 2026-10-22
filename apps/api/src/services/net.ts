// Outbound HTTP to user-configured URLs (webhooks) with SSRF protection: the host is resolved once, every
// address is checked against private/loopback/link-local ranges, and the connection is pinned to the checked
// address so DNS can't be swapped between the check and the request (rebinding).
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16]] as const) blocked.addSubnet(net, prefix, 'ipv6');

export const isPrivateAddress = (address: string) => blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');

export class UnsafeUrlError extends Error {}

/** Validates the URL's form (https unless private targets are allowed, no credentials). */
export function assertWebhookUrl(raw: string, { allowPrivate }: { allowPrivate: boolean }): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UnsafeUrlError('Not a valid URL'); }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new UnsafeUrlError('Webhook URLs must use https');
  if (url.username || url.password) throw new UnsafeUrlError('URLs must not contain credentials');
  return url;
}

export interface PostResult { status: number; body: string }

export async function safePost(raw: string, body: string, headers: Record<string, string>, { allowPrivate, timeoutMs = 10_000 }: { allowPrivate: boolean; timeoutMs?: number }): Promise<PostResult> {
  const url = assertWebhookUrl(raw, { allowPrivate });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length) throw new UnsafeUrlError('Host did not resolve');
  if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError('Destination address is not allowed');
  const pinned = addresses[0]!;

  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, {
      method: 'POST',
      headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() },
      // Connect to the address we checked, while TLS still verifies the original host name.
      lookup: (_hostname, opts, cb) => {
        if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned]);
        else cb(null, pinned.address, pinned.family);
      },
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { if (text.length < 2000) text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text.slice(0, 2000) }));
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end(body);
  });
}
