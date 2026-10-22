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
  PE_ADMIN_PASSWORD: z.string().optional(),

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

  // PureNet webhook is mounted only when its signing secret is configured (A-011).
  PURENET_WEBHOOK_SECRET: z.string().min(16).optional(),
});

export type Config = z.infer<typeof schema> & { trackingSecret: string };

const DEV_TRACKING_SECRET = 'dev-only-tracking-secret-do-not-use-in-production';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production' && !c.PE_TRACKING_SECRET) throw new Error('Invalid configuration: PE_TRACKING_SECRET is required in production');
  return { ...c, trackingSecret: c.PE_TRACKING_SECRET ?? DEV_TRACKING_SECRET };
}
