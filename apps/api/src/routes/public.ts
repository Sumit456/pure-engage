// Public endpoints reached from recipients' inboxes and phones, and provider callbacks. No session auth:
// every link carries a signed token (services/tracking.ts).
import type { FastifyPluginAsync } from 'fastify';
import { escapeHtml } from '../services/rendering.ts';

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const page = (lang: 'en' | 'ar', title: string, body: string) =>
  `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,'Segoe UI',Tahoma,sans-serif;background:#f6f8f9;color:#16252c;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}main{background:#fff;border:1px solid #d9e1e5;border-radius:10px;padding:32px;max-width:440px}button{font:inherit;padding:10px 18px;border-radius:6px;border:0;background:#0f6e78;color:#fff;cursor:pointer}</style>
</head><body><main>${body}</main></body></html>`;

export const publicRoutes: FastifyPluginAsync = async (app) => {
  const { signer, delivery } = app.services;
  const noStore = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };

  app.get('/t/o/:token', async (req, reply) => {
    const token = (req.params as { token: string }).token.replace(/\.gif$/, '');
    const id = signer.verifyToken(token);
    if (id) await delivery.recordOpen(id).catch((err) => req.log.warn(err, 'open tracking failed'));
    return reply.headers({ ...noStore, 'content-type': 'image/gif' }).send(PIXEL);
  });

  app.get('/t/c/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const { u, s } = req.query as { u?: string; s?: string };
    const id = signer.verifyToken(token);
    // Only redirect to the exact URL that was signed into this message (no open redirect).
    if (!id || !u || !s || !/^https?:\/\//i.test(u) || !signer.verifyClick(id, u, s)) return reply.code(400).headers(noStore).send({ error: 'Invalid link' });
    await delivery.recordClick(id, u).catch((err) => req.log.warn(err, 'click tracking failed'));
    return reply.headers(noStore).redirect(u, 302);
  });

  // GET shows a confirmation page, so link scanners in mail gateways can't unsubscribe people by prefetching.
  app.get('/u/:token', async (req, reply) => {
    const id = signer.verifyToken((req.params as { token: string }).token);
    const lang = (req.headers['accept-language'] ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
    reply.headers({ ...noStore, 'content-type': 'text/html; charset=utf-8' });
    if (!id) return reply.code(404).send(page(lang, 'Link expired', lang === 'ar' ? '<p>هذا الرابط غير صالح.</p>' : '<p>This link is not valid.</p>'));
    const t = lang === 'ar'
      ? { h: 'إلغاء الاشتراك', p: 'لن تصلك رسائل تسويقية على هذه القناة بعد الآن. ستستمر رسائل الرعاية المهمة.', b: 'تأكيد إلغاء الاشتراك' }
      : { h: 'Unsubscribe', p: 'You will stop receiving marketing messages on this channel. Important care messages will continue.', b: 'Confirm unsubscribe' };
    return page(lang, t.h, `<h1>${t.h}</h1><p>${t.p}</p><form method="post"><button type="submit">${t.b}</button></form>`);
  });

  // RFC 8058 one-click (mail clients POST `List-Unsubscribe=One-Click`) and the confirmation form.
  app.post('/u/:token', async (req, reply) => {
    const id = signer.verifyToken((req.params as { token: string }).token);
    if (!id) return reply.code(404).send({ error: 'Invalid link' });
    await delivery.unsubscribe(id);
    const lang = (req.headers['accept-language'] ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
    reply.headers({ ...noStore, 'content-type': 'text/html; charset=utf-8' });
    return page(lang, 'Unsubscribed', lang === 'ar' ? '<h1>تم إلغاء الاشتراك</h1><p>لن تصلك رسائل تسويقية على هذه القناة.</p>' : '<h1>You are unsubscribed</h1><p>You won’t receive marketing messages on this channel.</p>');
  });

  // Inbound SMS: reply STOP to opt out of SMS marketing. Twilio wants a TwiML response; an empty one sends nothing back.
  app.post('/hooks/twilio/inbound', async (req, reply) => {
    const { ok } = await delivery.twilioInbound(req.body as Record<string, string>, String(req.headers['x-twilio-signature'] ?? ''));
    if (!ok) return reply.code(403).send();
    return reply.header('content-type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  app.post('/hooks/twilio/status', async (req, reply) => {
    const ok = await delivery.twilioStatus(req.body as Record<string, string>, String(req.headers['x-twilio-signature'] ?? ''));
    return reply.code(ok ? 204 : 403).send();
  });
};
