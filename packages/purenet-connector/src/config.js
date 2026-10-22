// Connector settings from the environment. Defaults point at the local Prism mocks.

const DEFAULT_SCOPES = 'members.read consents.read subscriptions.write'; // A-002: scope names are placeholders

export function loadConfig(env = process.env) {
  return {
    baseUrl: trimSlash(env.PURENET_BASE_URL || 'http://127.0.0.1:4010'), // A-003
    tokenUrl: env.PURENET_TOKEN_URL || 'http://127.0.0.1:4011/oauth2/token', // A-002
    clientId: env.PURENET_CLIENT_ID || 'test-client',
    clientSecret: env.PURENET_CLIENT_SECRET || 'test-secret',
    scopes: env.PURENET_SCOPES || DEFAULT_SCOPES,
    webhookSecret: env.PURENET_WEBHOOK_SECRET || '', // A-011: returned once by createSubscription
    maxRetries: Number(env.PURENET_MAX_RETRIES ?? 3),
    timeoutMs: Number(env.PURENET_TIMEOUT_MS ?? 10_000),
  };
}

const trimSlash = (url) => url.replace(/\/+$/, '');
