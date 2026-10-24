import { defineConfig, devices } from '@playwright/test';

// Full stack: real API + Postgres (fresh *_e2e database) + Vite dev server proxying /api.
const base = new URL(process.env.PE_E2E_DATABASE_BASE ?? 'postgres://pure_engage@127.0.0.1:5433/');
const dbUrl = new URL('pure_engage_e2e', base).toString();
const API_PORT = 4201;
const WEB_PORT = 5174;

export const E2E_ADMIN = { email: 'admin@example.com', password: 'e2e-admin-password' };

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  // In CI, failures also become GitHub annotations, readable without downloading the run's logs.
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'node e2e/reset-db.mjs && node ../api/src/main.ts',
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PE_DATABASE_URL: dbUrl,
        PORT: String(API_PORT),
        PE_LOG_LEVEL: 'warn',
        PE_ADMIN_EMAIL: E2E_ADMIN.email,
        PE_ADMIN_PASSWORD: E2E_ADMIN.password,
        PE_DISPATCH_INTERVAL_MS: '300',
        PE_WEBHOOKS_ALLOW_PRIVATE: 'true',
        // salesforce.spec.ts runs a local fake Salesforce on http://127.0.0.1.
        PE_SALESFORCE_ALLOW_ANY_HOST: 'true',
        PE_PUBLIC_URL: `http://127.0.0.1:${API_PORT}`,
        PE_CONSOLE_URL: `http://127.0.0.1:${WEB_PORT}`,
        // Every spec signs in from 127.0.0.1; the production default (10 per 15 min) would throttle the suite.
        PE_LOGIN_RATE_LIMIT: '200',
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { PE_API_URL: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
