// Signed, unguessable links for opens, clicks and unsubscribes. A token is `<message id>.<mac>`, and click links
// also sign the destination so the redirect can't be abused to send people elsewhere (no open redirect).
import { createHmac } from 'node:crypto';
import { safeEqual } from './crypto.ts';

const mac = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('base64url').slice(0, 22);

export function createLinkSigner(secret: string, publicUrl: string) {
  const base = publicUrl.replace(/\/+$/, '');
  const token = (messageId: string) => `${messageId}.${mac(secret, `m:${messageId}`)}`;

  return {
    base,
    token,
    /** Returns the message id for a valid token, otherwise null. */
    verifyToken(t: string): string | null {
      const [id, sig] = t.split('.');
      if (!id || !sig || !/^[0-9a-f-]{36}$/.test(id)) return null;
      return safeEqual(sig, mac(secret, `m:${id}`)) ? id : null;
    },
    pixelUrl: (messageId: string) => `${base}/t/o/${token(messageId)}.gif`,
    unsubscribeUrl: (messageId: string) => `${base}/u/${token(messageId)}`,
    clickUrl: (messageId: string, url: string) =>
      `${base}/t/c/${token(messageId)}?u=${encodeURIComponent(url)}&s=${mac(secret, `c:${messageId}:${url}`)}`,
    verifyClick: (messageId: string, url: string, sig: string) => safeEqual(sig, mac(secret, `c:${messageId}:${url}`)),
  };
}

export type LinkSigner = ReturnType<typeof createLinkSigner>;
