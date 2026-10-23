import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ApiScope } from '@pure-engage/shared';
import type { Role } from '../db/schema.ts';
import { forbidden, unauthorized, HttpError } from '../errors.ts';
import type { Actor } from '../services/audit.ts';
import { roleAtLeast } from '../services/auth.ts';

export const SESSION_COOKIE = 'pe_session';
export const CSRF_HEADER = 'x-pe-csrf';

export interface SessionUser { id: string; email: string; name: string; role: Role }

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
    apiKey?: { id: string; name: string; scopes: ApiScope[] };
    /** Set on inbound webhook requests. */
    integration?: { id: string; name: string };
    /** Items handled by an integration request, for the request log. */
    logItems?: number;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cookie sessions are only trusted with a custom header on state-changing requests. Browsers can't send a
 * custom header cross-site without a CORS preflight (which we never grant), so this blocks CSRF.
 */
export function assertCsrf(req: FastifyRequest): void {
  if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== '1') {
    throw new HttpError(403, `Missing ${CSRF_HEADER} header`);
  }
}

export function requireUser(minimum: Role = 'viewer'): preHandlerHookHandler {
  return async function (req: FastifyRequest, _reply: FastifyReply) {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await this.services.auth.userForToken(token) : null;
    if (!user) throw unauthorized();
    assertCsrf(req);
    if (!roleAtLeast(user.role, minimum)) throw forbidden();
    req.user = user;
  };
}

/** Checks the bearer API key and that it carries every listed scope. */
export function requireApiKey(...scopes: ApiScope[]): preHandlerHookHandler {
  return async function (req) {
    const header = req.headers.authorization ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const apiKey = key ? await this.services.auth.verifyApiKey(key) : null;
    if (!apiKey) throw new HttpError(401, 'Invalid or missing API key');
    req.apiKey = apiKey;
    assertScope(req, ...scopes);
  };
}

export const hasScope = (req: FastifyRequest, scope: ApiScope) => !!req.apiKey?.scopes.includes(scope);

export function assertScope(req: FastifyRequest, ...scopes: ApiScope[]): void {
  const missing = scopes.filter((s) => !hasScope(req, s));
  if (missing.length) throw new HttpError(403, `This API key is missing the ${missing.join(', ')} permission`, { code: 'insufficient_scope', missing });
}

export function actorOf(req: FastifyRequest): Actor {
  if (req.user) return { type: 'user', id: req.user.id, ip: req.ip };
  if (req.apiKey) return { type: 'api_key', id: req.apiKey.id, ip: req.ip };
  if (req.integration) return { type: 'integration', id: req.integration.id };
  return { type: 'system' };
}
