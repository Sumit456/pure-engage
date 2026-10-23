// Delivery providers. Sandbox never contacts anything; SMTP (nodemailer) and Twilio (REST) are used only in
// live mode with credentials. Errors say whether a retry could help.
import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Config } from '../config.ts';
import type { Message } from '../db/schema.ts';
import { safeEqual } from './crypto.ts';

export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
  }
}

export interface OutgoingMessage extends Pick<Message, 'id' | 'channel' | 'purpose' | 'to_address' | 'subject' | 'body_html' | 'body_text'> {
  unsubscribeUrl?: string | undefined;
}

export interface Provider {
  name: string;
  send(msg: OutgoingMessage): Promise<{ providerMessageId: string | null }>;
}

export const sandboxProvider: Provider = {
  name: 'sandbox',
  async send(msg) { return { providerMessageId: `sandbox-${msg.id}` }; },
};

const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };

/** SMTP is configured by PE_SMTP_URL, or by PE_SMTP_HOST + PE_SMTP_PASS (with PE_SMTP_PORT and PE_SMTP_USER). */
export const smtpConfigured = (config: Config) => !!(config.PE_SMTP_URL || (config.PE_SMTP_HOST && config.PE_SMTP_PASS));

/** nodemailer transport options; port 465 is implicit TLS, other ports upgrade with STARTTLS. */
export function smtpTransportOptions(config: Config) {
  if (config.PE_SMTP_URL) return config.PE_SMTP_URL;
  return {
    host: config.PE_SMTP_HOST!,
    port: config.PE_SMTP_PORT,
    secure: config.PE_SMTP_PORT === 465,
    auth: { user: config.PE_SMTP_USER ?? '', pass: config.PE_SMTP_PASS! },
  };
}

export function smtpProvider(config: Config): Provider {
  const options = smtpTransportOptions(config);
  const transport = typeof options === 'string' ? nodemailer.createTransport(options, SMTP_TIMEOUTS) : nodemailer.createTransport({ ...options, ...SMTP_TIMEOUTS });
  return {
    name: 'smtp',
    async send(msg) {
      const headers: Record<string, string> = { 'X-PE-Message-Id': msg.id };
      if (msg.unsubscribeUrl) {
        headers['List-Unsubscribe'] = `<${msg.unsubscribeUrl}>`;
        headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'; // RFC 8058
      }
      try {
        const info = await transport.sendMail({
          from: config.PE_EMAIL_FROM,
          replyTo: config.PE_EMAIL_REPLY_TO,
          to: msg.to_address!,
          subject: msg.subject ?? '',
          html: msg.body_html ?? undefined,
          text: msg.body_text ?? undefined,
          headers,
        });
        return { providerMessageId: info.messageId ?? null };
      } catch (err) {
        const code = (err as { responseCode?: number }).responseCode;
        // 5xx = permanent rejection (e.g. no such mailbox); 4xx and connection errors may succeed later.
        throw new ProviderError(`SMTP: ${(err as Error).message}`, !(code && code >= 500));
      }
    },
  };
}

export function twilioProvider(config: Config): Provider {
  const sid = config.TWILIO_ACCOUNT_SID!;
  const url = `${config.PE_TWILIO_API_BASE.replace(/\/+$/, '')}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = `Basic ${Buffer.from(`${sid}:${config.TWILIO_AUTH_TOKEN}`).toString('base64')}`;
  return {
    name: 'twilio',
    async send(msg) {
      const form = new URLSearchParams({ To: msg.to_address!, Body: msg.body_text ?? '', StatusCallback: `${config.PE_PUBLIC_URL.replace(/\/+$/, '')}/hooks/twilio/status` });
      if (config.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', config.TWILIO_MESSAGING_SERVICE_SID);
      else form.set('From', config.TWILIO_FROM!);
      let res: Response;
      try {
        res = await fetch(url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(15_000) });
      } catch (err) {
        throw new ProviderError(`Twilio: ${(err as Error).message}`, true);
      }
      const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
      if (!res.ok) throw new ProviderError(`Twilio ${res.status}${json.code ? ` (${json.code})` : ''}: ${json.message ?? res.statusText}`, res.status === 429 || res.status >= 500);
      return { providerMessageId: json.sid ?? null };
    },
  };
}

/** X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)). */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return safeEqual(createHmac('sha1', authToken).update(data).digest('base64'), signature);
}

export function selectProviders(config: Config): { email: Provider; sms: Provider } {
  const live = config.PE_DELIVERY_MODE === 'live';
  return {
    email: live && smtpConfigured(config) ? smtpProvider(config) : sandboxProvider,
    sms: live && config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && (config.TWILIO_FROM || config.TWILIO_MESSAGING_SERVICE_SID) ? twilioProvider(config) : sandboxProvider,
  };
}

/** Live-mode allowlist: exact addresses, `@domain` suffixes or E.164 numbers. Empty means everyone. */
export function allowlistMatcher(list: string | undefined): (address: string) => boolean {
  const entries = (list ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!entries.length) return () => true;
  return (address) => {
    const a = address.toLowerCase();
    return entries.some((e) => (e.startsWith('@') ? a.endsWith(e) : a === e));
  };
}
