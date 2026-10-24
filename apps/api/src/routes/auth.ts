import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE, assertCsrf, requireUser } from '../plugins/auth.ts';
import { unauthorized, badRequest } from '../errors.ts';

const loginSchema = z.object({ email: z.string().trim().min(1).max(320), password: z.string().min(1).max(200) });
const passwordChangeSchema = z.object({ current_password: z.string().min(1), new_password: z.string() });

export const authRoutes: FastifyPluginAsync = async (app) => {
  const secure = app.deps.config.NODE_ENV === 'production';
  const cookieOptions = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure, maxAge: app.deps.config.PE_SESSION_MAX_HOURS * 3600 };

  app.post('/api/auth/login', {
    config: { rateLimit: { max: app.deps.config.PE_LOGIN_RATE_LIMIT, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    assertCsrf(req);
    const { email, password } = loginSchema.parse(req.body);
    const session = await app.services.auth.login(email, password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    if (!session) throw unauthorized('Incorrect email or password');
    reply.setCookie(SESSION_COOKIE, session.token, cookieOptions);
    return { user: session.user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    assertCsrf(req);
    const token = req.cookies[SESSION_COOKIE];
    if (token) await app.services.auth.logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: requireUser() }, async (req) => ({ user: req.user }));

  app.post('/api/auth/password', { preHandler: requireUser() }, async (req, reply) => {
    const { current_password, new_password } = passwordChangeSchema.parse(req.body);
    const ok = await app.services.auth.changeOwnPassword(req.user!.id, current_password, new_password, req.cookies[SESSION_COOKIE]!);
    if (!ok) throw badRequest('Current password is incorrect');
    return reply.code(204).send();
  });
};
