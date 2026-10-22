import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
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
    apiKey?: { id: string; name: string };
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

export const requireApiKey: preHandlerHookHandler = async function (req) {
  const header = req.headers.authorization ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const apiKey = key ? await this.services.auth.verifyApiKey(key) : null;
  if (!apiKey) throw new HttpError(401, 'Invalid or missing API key');
  req.apiKey = apiKey;
};

export function actorOf(req: FastifyRequest): Actor {
  if (req.user) return { type: 'user', id: req.user.id, ip: req.ip };
  if (req.apiKey) return { type: 'api_key', id: req.apiKey.id, ip: req.ip };
  return { type: 'system' };
}
