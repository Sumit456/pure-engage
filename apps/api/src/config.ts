import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4200),
  HOST: z.string().default('127.0.0.1'),
  PE_DATABASE_URL: z.string().default('postgres://pure_engage@127.0.0.1:5433/pure_engage'),
  PE_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Sessions: idle timeout and absolute lifetime.
  PE_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).default(30),
  PE_SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(24).default(12),
  // Login attempts per IP per 15 minutes.
  PE_LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
  // Optional first admin, created at startup only when there are no users yet.
  PE_ADMIN_EMAIL: z.string().email().optional(),
  PE_ADMIN_PASSWORD: z.string().optional(),
  // PureNet webhook is mounted only when its signing secret is configured (A-011).
  PURENET_WEBHOOK_SECRET: z.string().min(16).optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
