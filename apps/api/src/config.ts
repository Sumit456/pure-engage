import { createHash } from 'node:crypto';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4200),
  HOST: z.string().default('127.0.0.1'),
  PE_DATABASE_URL: z.string().default('postgres://pure_engage@127.0.0.1:5433/pure_engage'),
  PE_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Public base URL of the API, used in tracking, unsubscribe and provider callback links. */
  PE_PUBLIC_URL: z.string().url().default('http://127.0.0.1:4200'),
  PE_BRAND_NAME: z.string().default('PureHealth'),

  // Sessions: idle timeout and absolute lifetime.
  PE_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).default(30),
  PE_SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(24).default(12),
  // Login attempts per IP per 15 minutes.
  PE_LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
  // Optional first admin, created at startup only when there are no users yet.
  PE_ADMIN_EMAIL: z.string().email().optional(),
  PE_ADMIN_PASSWORD: z.string().min(12, 'PE_ADMIN_PASSWORD must be at least 12 characters').optional(),
  /** Seeds synthetic demo data at startup when there are no contacts yet (test deployments only). */
  PE_SEED_DEMO: bool.default('false'),

  // ---- Delivery ----
  /** `sandbox` (default) never contacts a provider; `live` sends through SMTP/Twilio when configured. */
  PE_DELIVERY_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  /** Optional comma-separated allowlist for live sends: emails, @domains or E.164 numbers. Others are suppressed. */
  PE_DELIVERY_ALLOWLIST: z.string().optional(),
  /** Signs tracking and unsubscribe links. Required in production; must stay stable or old links stop working. */
  PE_TRACKING_SECRET: z.string().min(32).optional(),
  PE_DEFAULT_TIMEZONE: z.string().default('Asia/Dubai'),
  /** SMS quiet hours in the contact's time zone, `startHour-endHour` (24 h). */
  PE_SMS_QUIET_HOURS: z.string().regex(/^\d{1,2}-\d{1,2}$/).default('21-8'),
  /** Marketing messages per contact per channel per rolling 7 days. */
  PE_MARKETING_CAP_PER_WEEK: z.coerce.number().int().min(0).default(3),
  /** Dispatcher poll interval; 0 disables the in-process dispatcher (tests drive it directly). */
  PE_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(2000),
  PE_TRACKING_ENABLED: bool.default('true'),
  /** Contacts enqueued per campaign batch (each batch holds a row lock briefly). */
  PE_CAMPAIGN_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(500),

  // SMTP (email)
  PE_SMTP_URL: z.string().optional(),
  PE_EMAIL_FROM: z.string().default('Pure Engage <no-reply@example.com>'),
  PE_EMAIL_REPLY_TO: z.string().optional(),

  // Twilio (SMS)
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  PE_TWILIO_API_BASE: z.string().url().default('https://api.twilio.com'),

  /**
   * Encrypts stored secrets (webhook signing secrets). Required in production. Either 32 bytes base64
   * (`openssl rand -base64 32`) or any random string of 32+ characters, such as a value Render generates.
   */
  PE_SECRET_KEY: z.string().min(32, 'PE_SECRET_KEY must be at least 32 characters').optional(),
  /** Lets outbound webhooks target private/loopback addresses (local development and tests only). */
  PE_WEBHOOKS_ALLOW_PRIVATE: bool.default('false'),

  // Retention (days). Message bodies are personal data; delivery metadata is kept.
  PE_MESSAGE_BODY_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  PE_WEBHOOK_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  PE_SESSION_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),

  /** Serve the built console (apps/console/dist) from the API, for single-container deployments. */
  PE_CONSOLE_DIR: z.string().optional(),

  // PureNet webhook is mounted only when its signing secret is configured (A-011).
  PURENET_WEBHOOK_SECRET: z.string().min(16).optional(),
});

export type Config = z.infer<typeof schema> & { trackingSecret: string; secretKey: Buffer };

const DEV_TRACKING_SECRET = 'dev-only-tracking-secret-do-not-use-in-production';
const DEV_SECRET_KEY_SEED = 'dev-only-secret-key-do-not-use-in-production';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  // On Render the service's public URL is provided as RENDER_EXTERNAL_URL.
  if (!set.PE_PUBLIC_URL && set.RENDER_EXTERNAL_URL) set.PE_PUBLIC_URL = set.RENDER_EXTERNAL_URL;
  const parsed = schema.safeParse(set);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production' && !c.PE_TRACKING_SECRET) throw new Error('Invalid configuration: PE_TRACKING_SECRET is required in production');
  if (c.NODE_ENV === 'production' && !c.PE_SECRET_KEY) throw new Error('Invalid configuration: PE_SECRET_KEY is required in production');
  if (c.NODE_ENV === 'production' && c.PE_WEBHOOKS_ALLOW_PRIVATE) throw new Error('Invalid configuration: PE_WEBHOOKS_ALLOW_PRIVATE cannot be used in production');
  return { ...c, trackingSecret: c.PE_TRACKING_SECRET ?? DEV_TRACKING_SECRET, secretKey: deriveSecretKey(c.PE_SECRET_KEY ?? DEV_SECRET_KEY_SEED) };
}

/** A 32-byte base64 value is used as the AES key as is; any other (long, random) string is hashed to 32 bytes. */
function deriveSecretKey(value: string): Buffer {
  const raw = /^[A-Za-z0-9+/_-]{43}=?$/.test(value) ? Buffer.from(value, 'base64') : null;
  return raw?.length === 32 ? raw : createHash('sha256').update(value).digest();
}
