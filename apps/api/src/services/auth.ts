import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { API_SCOPES, LEGACY_SCOPES, type ApiScope } from '@pure-engage/shared';
import type { Database, Role, User } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { audit, type Actor } from './audit.ts';
import { MIN_PASSWORD_LENGTH, hashPassword, randomToken, safeEqual, sha256, verifyPassword, verifyPasswordAgainstDummy } from './crypto.ts';

export const ROLES = ['viewer', 'marketer', 'admin'] as const satisfies readonly Role[];
export const roleAtLeast = (role: Role, minimum: Role) => ROLES.indexOf(role) >= ROLES.indexOf(minimum);

export type PublicUser = Pick<User, 'id' | 'email' | 'name' | 'role' | 'active' | 'created_at' | 'last_login_at'>;
const publicColumns = ['id', 'email', 'name', 'role', 'active', 'created_at', 'last_login_at'] as const;

export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`).max(200);
export const newUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().max(200).default(''),
  role: z.enum(ROLES),
  password: passwordSchema,
});
export const updateUserSchema = z.object({
  name: z.string().trim().max(200).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  password: passwordSchema.optional(),
});

export const apiKeySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  scopes: z.array(z.enum(API_SCOPES)).min(1, 'Choose at least one permission').transform((s) => [...new Set(s)]),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
});

export interface VerifiedApiKey { id: string; name: string; scopes: ApiScope[] }

export interface SessionPolicy {
  idleMinutes: number;
  maxHours: number;
}

export function createAuthService(db: Kysely<Database>, policy: SessionPolicy) {
  async function assertNotLastAdmin(userId: string) {
    const { count } = await db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('role', '=', 'admin')
      .where('active', '=', true)
      .where('id', '!=', userId)
      .executeTakeFirstOrThrow();
    if (Number(count) === 0) throw conflict('At least one active admin is required');
  }

  return {
    async countUsers(): Promise<number> {
      const { count } = await db.selectFrom('users').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      return Number(count);
    },

    async createUser(input: z.input<typeof newUserSchema>, actor: Actor): Promise<PublicUser> {
      const data = newUserSchema.parse(input);
      const existing = await db.selectFrom('users').select('id').where(sql`lower(email)`, '=', data.email).executeTakeFirst();
      if (existing) throw conflict('A user with this email already exists');
      const user = await db
        .insertInto('users')
        .values({ email: data.email, name: data.name, role: data.role, password_hash: await hashPassword(data.password) })
        .returning(publicColumns)
        .executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'user.create', entityType: 'user', entityId: user.id, details: { role: user.role } });
      return user;
    },

    async updateUser(id: string, input: z.input<typeof updateUserSchema>, actor: Actor): Promise<PublicUser> {
      const data = updateUserSchema.parse(input);
      const current = await db.selectFrom('users').select(['id', 'role', 'active']).where('id', '=', id).executeTakeFirst();
      if (!current) throw notFound('User');
      const demoting = current.role === 'admin' && ((data.role && data.role !== 'admin') || data.active === false);
      if (demoting) await assertNotLastAdmin(id);

      const changes: Record<string, unknown> = {};
      if (data.name !== undefined) changes.name = data.name;
      if (data.role !== undefined) changes.role = data.role;
      if (data.active !== undefined) changes.active = data.active;
      if (data.password !== undefined) changes.password_hash = await hashPassword(data.password);
      const user = Object.keys(changes).length
        ? await db.updateTable('users').set(changes).where('id', '=', id).returning(publicColumns).executeTakeFirstOrThrow()
        : await db.selectFrom('users').select(publicColumns).where('id', '=', id).executeTakeFirstOrThrow();

      // Deactivation, a role change or a password reset ends existing sessions.
      if (data.active === false || data.role !== undefined || data.password !== undefined) {
        await db.deleteFrom('sessions').where('user_id', '=', id).execute();
      }
      await audit(db, actor, { action: 'user.update', entityType: 'user', entityId: id, details: { fields: Object.keys(changes).map((k) => k.replace('_hash', '')) } });
      return user;
    },

    async listUsers(): Promise<PublicUser[]> {
      return db.selectFrom('users').select(publicColumns).orderBy('created_at').execute();
    },

    /** Returns the session token (only ever held by the client) on success, null on bad credentials. */
    async login(email: string, password: string, meta: { ip?: string; userAgent?: string }) {
      const user = await db.selectFrom('users').selectAll().where(sql`lower(email)`, '=', email.trim().toLowerCase()).executeTakeFirst();
      const ok = user ? await verifyPassword(password, user.password_hash) : await verifyPasswordAgainstDummy(password);
      if (!user || !ok || !user.active) {
        await audit(db, { type: 'system' }, { action: 'auth.login_failed', details: { reason: !user ? 'unknown_user' : !ok ? 'bad_password' : 'inactive' } });
        return null;
      }
      const token = randomToken();
      await db
        .insertInto('sessions')
        .values({
          token_hash: sha256(token),
          user_id: user.id,
          expires_at: new Date(Date.now() + policy.maxHours * 3_600_000),
          ip: meta.ip ?? null,
          user_agent: meta.userAgent?.slice(0, 300) ?? null,
        })
        .execute();
      await db.updateTable('users').set({ last_login_at: new Date() }).where('id', '=', user.id).execute();
      await audit(db, { type: 'user', id: user.id, ip: meta.ip ?? null }, { action: 'auth.login' });
      return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
    },

    /** Resolves a session token, enforcing the absolute and idle timeouts. */
    async userForToken(token: string) {
      const row = await db
        .selectFrom('sessions')
        .innerJoin('users', 'users.id', 'sessions.user_id')
        .select(['sessions.token_hash', 'sessions.expires_at', 'sessions.last_seen_at', 'users.id', 'users.email', 'users.name', 'users.role', 'users.active'])
        .where('sessions.token_hash', '=', sha256(token))
        .executeTakeFirst();
      if (!row) return null;
      const now = Date.now();
      const idleExpired = now - row.last_seen_at.getTime() > policy.idleMinutes * 60_000;
      if (!row.active || row.expires_at.getTime() <= now || idleExpired) {
        await db.deleteFrom('sessions').where('token_hash', '=', row.token_hash).execute();
        return null;
      }
      if (now - row.last_seen_at.getTime() > 60_000) {
        await db.updateTable('sessions').set({ last_seen_at: new Date(now) }).where('token_hash', '=', row.token_hash).execute();
      }
      return { id: row.id, email: row.email, name: row.name, role: row.role };
    },

    async logout(token: string): Promise<void> {
      await db.deleteFrom('sessions').where('token_hash', '=', sha256(token)).execute();
    },

    async changeOwnPassword(userId: string, currentPassword: string, newPassword: string, keepToken: string): Promise<boolean> {
      const user = await db.selectFrom('users').select('password_hash').where('id', '=', userId).executeTakeFirstOrThrow();
      if (!(await verifyPassword(currentPassword, user.password_hash))) return false;
      await db.updateTable('users').set({ password_hash: await hashPassword(passwordSchema.parse(newPassword)) }).where('id', '=', userId).execute();
      await db.deleteFrom('sessions').where('user_id', '=', userId).where('token_hash', '!=', sha256(keepToken)).execute();
      await audit(db, { type: 'user', id: userId }, { action: 'user.password_change', entityType: 'user', entityId: userId });
      return true;
    },

    // ---- API keys: `pe_<prefix>_<secret>`; only the hash is stored ----
    async createApiKey(input: z.input<typeof apiKeySchema> | string, actor: Actor) {
      const data = apiKeySchema.parse(typeof input === 'string' ? { name: input, scopes: LEGACY_SCOPES } : input);
      if (data.expires_at && Date.parse(data.expires_at) <= Date.now()) throw badRequest('Expiry must be in the future', [{ path: 'expires_at', message: 'Must be in the future' }]);
      const prefix = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8);
      const key = `pe_${prefix}_${randomToken(32)}`;
      const row = await db
        .insertInto('api_keys')
        .values({ name: data.name, prefix, key_hash: sha256(key), scopes: JSON.stringify(data.scopes), expires_at: data.expires_at ?? null, created_by: actor.type === 'user' ? actor.id : null })
        .returning(['id', 'name', 'prefix', 'scopes', 'expires_at', 'created_at'])
        .executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'api_key.create', entityType: 'api_key', entityId: row.id, details: { scopes: data.scopes } });
      return { ...row, key };
    },

    async listApiKeys() {
      return db.selectFrom('api_keys').select(['id', 'name', 'prefix', 'scopes', 'expires_at', 'created_at', 'last_used_at', 'revoked_at']).orderBy('created_at', 'desc').execute();
    },

    async revokeApiKey(id: string, actor: Actor): Promise<void> {
      const res = await db.updateTable('api_keys').set({ revoked_at: new Date() }).where('id', '=', id).where('revoked_at', 'is', null).executeTakeFirst();
      if (!res.numUpdatedRows) throw notFound('API key');
      await audit(db, actor, { action: 'api_key.revoke', entityType: 'api_key', entityId: id });
    },

    async verifyApiKey(key: string): Promise<VerifiedApiKey | null> {
      const m = /^pe_([A-Za-z0-9]{8})_[A-Za-z0-9_-]{20,}$/.exec(key);
      if (!m) return null;
      const row = await db.selectFrom('api_keys').select(['id', 'name', 'key_hash', 'scopes', 'expires_at', 'last_used_at']).where('prefix', '=', m[1]!).where('revoked_at', 'is', null).executeTakeFirst();
      if (!row || !safeEqual(row.key_hash, sha256(key))) return null;
      if (row.expires_at && row.expires_at.getTime() <= Date.now()) return null;
      if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000) {
        await db.updateTable('api_keys').set({ last_used_at: new Date() }).where('id', '=', row.id).execute();
      }
      return { id: row.id, name: row.name, scopes: row.scopes };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
