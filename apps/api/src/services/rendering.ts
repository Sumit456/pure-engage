// Template rendering with Liquid. HTML output is escaped by default (so contact data can't inject markup);
// plain text and SMS are not. No file system access: {% include %} / {% render %} have nothing to load.
import { Liquid } from 'liquidjs';
import type { Contact, ContentPart, EmailContent, Locale, PushContent, SmsContent, TemplateChannel, TemplateContent, WhatsAppContent } from '../db/schema.ts';
import { badRequest } from '../errors.ts';

const base = { strictFilters: true, ownPropertyOnly: true, templates: {}, cache: 200, parseLimit: 200_000, renderLimit: 1_000, memoryLimit: 32 * 1024 * 1024 };
const htmlEngine = new Liquid({ ...base, outputEscape: 'escape' });
const textEngine = new Liquid(base);

/**
 * `{{ data.start | local_datetime: contact.timezone, 'ar' }}` → the time in the contact's zone and language,
 * e.g. "Saturday 10 January, 10:30". Falls back to Asia/Dubai and English; invalid input renders as-is.
 */
export function localDateTime(value: unknown, timeZone?: unknown, locale?: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value ?? '');
  const tz = typeof timeZone === 'string' && timeZone ? timeZone : 'Asia/Dubai';
  const loc = locale === 'ar' ? 'ar-AE' : 'en-GB';
  try {
    return new Intl.DateTimeFormat(loc, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  } catch {
    return new Intl.DateTimeFormat(loc, { timeZone: 'Asia/Dubai', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  }
}
for (const engine of [htmlEngine, textEngine]) engine.registerFilter('local_datetime', localDateTime);

export interface RenderContext {
  contact: Record<string, unknown>;
  data: Record<string, unknown>;
  brand: { name: string };
  unsubscribe_url: string;
}

export function contactContext(c: Contact): Record<string, unknown> {
  return {
    id: c.id, external_id: c.external_id, first_name: c.first_name, last_name: c.last_name,
    email: c.email, phone: c.phone, preferred_language: c.preferred_language, timezone: c.timezone,
    attributes: c.attributes,
  };
}

export const localeFor = (c: Pick<Contact, 'preferred_language'>): Locale => (c.preferred_language?.toLowerCase().startsWith('ar') ? 'ar' : 'en');

/** Picks the contact's language when the template has it, otherwise English. */
export function pickLocale(content: TemplateContent, wanted: Locale): { locale: Locale; part: ContentPart } {
  if (wanted === 'ar' && content.ar) return { locale: 'ar', part: content.ar };
  return { locale: 'en', part: content.en };
}

export interface RenderedEmail { subject: string; html: string; text: string }
export interface RenderedSms { text: string }

export async function render(channel: TemplateChannel, part: EmailContent | SmsContent, ctx: RenderContext): Promise<RenderedEmail | RenderedSms> {
  try {
    if (channel === 'sms') {
      return { text: (await textEngine.parseAndRender((part as SmsContent).body, ctx)).trim() };
    }
    const email = part as EmailContent;
    const html = await htmlEngine.parseAndRender(email.html, ctx);
    const text = email.text?.trim() ? await textEngine.parseAndRender(email.text, ctx) : htmlToText(html);
    const subject = (await textEngine.parseAndRender(email.subject, ctx)).replace(/\s+/g, ' ').trim();
    return { subject, html, text };
  } catch (err) {
    throw badRequest(`Template error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

/** The Liquid-bearing fields of one locale's content, by field path. */
function liquidSources(channel: TemplateChannel, part: ContentPart): Record<string, string> {
  switch (channel) {
    case 'sms': return { body: (part as SmsContent).body };
    case 'push': { const p = part as PushContent; return { title: p.title, body: p.body, deep_link: p.deep_link ?? '' }; }
    case 'whatsapp': { const w = part as WhatsAppContent; return { 'header.text': w.header.text ?? '', body: w.body, footer: w.footer ?? '' }; }
    default: { const e = part as EmailContent; return { subject: e.subject, html: e.html, text: e.text ?? '' }; }
  }
}

/** Push and WhatsApp previews: their text fields rendered with Liquid (they aren't sent yet). */
export async function renderTextFields(channel: 'push' | 'whatsapp', part: PushContent | WhatsAppContent, ctx: RenderContext): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    for (const [field, src] of Object.entries(liquidSources(channel, part))) out[field] = src ? (await textEngine.parseAndRender(src, ctx)).trim() : '';
  } catch (err) {
    throw badRequest(`Template error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  return out;
}

/** Parses every part so syntax errors are caught when a template is saved, not when it's sent. */
export function validateContent(channel: TemplateChannel, content: TemplateContent): void {
  for (const [locale, part] of Object.entries(content)) {
    if (!part) continue;
    const sources = liquidSources(channel, part);
    for (const [field, src] of Object.entries(sources)) {
      try {
        (field === 'html' ? htmlEngine : textEngine).parse(src);
      } catch (err) {
        throw badRequest('Template has a syntax error', [{ path: `content.${locale}.${field}`, message: err instanceof Error ? err.message.split('\n')[0] : String(err) }]);
      }
    }
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => `${label.replace(/<[^>]+>/g, '')} (${href})`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Adds click tracking (absolute http(s) links only, never the unsubscribe link) and an open pixel.
 * `trackUrl(url)` returns the signed redirect for a link.
 */
export function addTracking(html: string, { trackUrl, pixelUrl, skipPrefix }: { trackUrl: (url: string) => string; pixelUrl: string; skipPrefix: string }): string {
  const linked = html.replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (m, pre: string, q: string, url: string) => {
    const decoded = url.replace(/&amp;/g, '&');
    return decoded.startsWith(skipPrefix) ? m : `${pre}${q}${trackUrl(decoded).replace(/&/g, '&amp;')}${q}`;
  });
  const pixel = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px" />`;
  return /<\/body>/i.test(linked) ? linked.replace(/<\/body>/i, `${pixel}</body>`) : linked + pixel;
}

/** Wraps a fragment in a minimal document and appends the marketing footer when needed. */
export function finaliseEmailHtml(html: string, { locale, unsubscribeUrl, brand }: { locale: Locale; unsubscribeUrl?: string | undefined; brand: string }): string {
  const footer = unsubscribeUrl
    ? `<p style="font-size:12px;color:#6b7b83;margin-top:32px">${escapeHtml(brand)} · <a href="${unsubscribeUrl}" style="color:#6b7b83">${locale === 'ar' ? 'إلغاء الاشتراك' : 'Unsubscribe'}</a></p>`
    : '';
  if (/<html[\s>]/i.test(html)) return footer ? html.replace(/<\/body>/i, `${footer}</body>`) : html;
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}${footer}</body></html>`;
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
