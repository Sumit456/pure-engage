// OAuth 2.1 authorization server for AI assistants connecting over MCP (authorization code + PKCE S256, dynamic client
// registration for public clients, rotating refresh tokens). An admin approves each app in the console and picks
// what it may do from AI_SCOPES: reads and drafts, never sending. Only hashes of codes and tokens are stored.
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { AI_SCOPES, SCOPE_PRESETS, type ApiScope } from '@pure-engage/shared';
import type { Database } from '../db/schema.ts';
import { audit, type Actor } from './audit.ts';
import { randomToken, sha256 } from './crypto.ts';

const CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_S = 3600;

/** OAuth-style error: `error` is the RFC 6749 code, shown to the client as-is. */
export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, description: string, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

const isLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
/** https anywhere, or http on loopback for local tools; no fragments. */
export function validRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname));
  } catch { return false; }
}

const registerSchema = z.object({
  client_name: z.string().trim().max(100).optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  token_endpoint_auth_method: z.string().optional(),
});

export interface AuthorizeParams { response_type?: string; client_id?: string; redirect_uri?: string; code_challenge?: string; code_challenge_method?: string; scope?: string; state?: string }

const pkce = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const parseScopes = (scope: string | undefined): ApiScope[] => {
  const asked = (scope ?? '').split(/\s+/).filter(Boolean).filter((s): s is ApiScope => (AI_SCOPES as string[]).includes(s));
  return asked.length ? asked : SCOPE_PRESETS.ai_read;
};

export function createOAuthService(db: Kysely<Database>, clock: () => Date) {
  async function client(id: string | undefined) {
    if (!id) throw new OAuthError('invalid_request', 'client_id is required');
    const c = await db.selectFrom('oauth_clients').selectAll().where('id', '=', id).executeTakeFirst();
    if (!c) throw new OAuthError('invalid_client', 'Unknown client', 401);
    return c;
  }

  /** Checks an authorization request before anything is shown to the user. */
  async function check(p: AuthorizeParams) {
    const c = await client(p.client_id);
    if (!p.redirect_uri || !c.redirect_uris.includes(p.redirect_uri)) throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client');
    if (p.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported');
    if (p.code_challenge_method !== 'S256' || !p.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) throw new OAuthError('invalid_request', 'PKCE with S256 is required');
    return c;
  }

  async function issue(grant: { clientId: string; userId: string | null; scopes: ApiScope[] }, existingId?: string) {
    const access = `pe_at_${randomToken(32)}`;
    const refresh = `pe_rt_${randomToken(32)}`;
    const values = { access_hash: sha256(access), refresh_hash: sha256(refresh), access_expires_at: new Date(clock().getTime() + ACCESS_TTL_S * 1000) };
    if (existingId) await db.updateTable('oauth_grants').set(values).where('id', '=', existingId).execute();
    else await db.insertInto('oauth_grants').values({ ...values, client_id: grant.clientId, user_id: grant.userId, scopes: JSON.stringify(grant.scopes), created_at: clock() }).execute();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: grant.scopes.join(' ') };
  }

  return {
    async register(input: unknown) {
      const parsed = registerSchema.safeParse(input);
      if (!parsed.success) throw new OAuthError('invalid_client_metadata', 'redirect_uris (1 to 10) are required');
      const bad = parsed.data.redirect_uris.find((u) => !validRedirectUri(u));
      if (bad) throw new OAuthError('invalid_redirect_uri', 'Redirect URIs must be https (or http on localhost) without a fragment');
      const id = `pec_${randomToken(16)}`;
      const name = parsed.data.client_name?.trim() || new URL(parsed.data.redirect_uris[0]!).hostname;
      await db.insertInto('oauth_clients').values({ id, name, redirect_uris: JSON.stringify(parsed.data.redirect_uris), created_at: clock() }).execute();
      return {
        client_id: id, client_name: name, redirect_uris: parsed.data.redirect_uris, client_id_issued_at: Math.floor(clock().getTime() / 1000),
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
      };
    },

    /** What the consent screen shows: who is asking, where the answer goes and what they asked for. */
    async describe(p: AuthorizeParams) {
      const c = await check(p);
      return { client: { id: c.id, name: c.name, redirect_host: new URL(p.redirect_uri!).host }, requested_scopes: parseScopes(p.scope), available_scopes: AI_SCOPES };
    },

    /** The admin's answer. Returns where to send the browser next. */
    async decide(p: AuthorizeParams & { approve: boolean; scopes?: unknown }, actor: Actor & { type: 'user' }) {
      const c = await check(p);
      const back = new URL(p.redirect_uri!);
      if (p.state) back.searchParams.set('state', p.state);
      if (!p.approve) {
        back.searchParams.set('error', 'access_denied');
        await audit(db, actor, { action: 'oauth.deny', entityType: 'oauth_client', entityId: c.id });
        return { redirect: back.toString() };
      }
      const scopes = z.array(z.enum(AI_SCOPES as [ApiScope, ...ApiScope[]])).min(1).parse(p.scopes);
      const code = randomToken(32);
      await db.insertInto('oauth_codes').values({
        code_hash: sha256(code), client_id: c.id, user_id: actor.id, redirect_uri: p.redirect_uri!, code_challenge: p.code_challenge!,
        scopes: JSON.stringify([...new Set(scopes)]), expires_at: new Date(clock().getTime() + CODE_TTL_MS),
      }).execute();
      await audit(db, actor, { action: 'oauth.approve', entityType: 'oauth_client', entityId: c.id, details: { client: c.name, scopes } });
      back.searchParams.set('code', code);
      return { redirect: back.toString() };
    },

    async token(body: Record<string, unknown>) {
      const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
      const grantType = str('grant_type');
      if (grantType === 'authorization_code') {
        const code = str('code'); const verifier = str('code_verifier');
        if (!code || !verifier) throw new OAuthError('invalid_request', 'code and code_verifier are required');
        const row = await db.transaction().execute(async (tx) => {
          const r = await tx.selectFrom('oauth_codes').selectAll().where('code_hash', '=', sha256(code)).forUpdate().executeTakeFirst();
          if (!r || r.used_at || r.expires_at.getTime() < clock().getTime()) return null;
          await tx.updateTable('oauth_codes').set({ used_at: clock() }).where('code_hash', '=', r.code_hash).execute();
          return r;
        });
        if (!row) throw new OAuthError('invalid_grant', 'The code is invalid, expired or already used');
        if (row.client_id !== str('client_id') || row.redirect_uri !== str('redirect_uri')) throw new OAuthError('invalid_grant', 'client_id or redirect_uri does not match');
        if (pkce(verifier) !== row.code_challenge) throw new OAuthError('invalid_grant', 'PKCE verification failed');
        return issue({ clientId: row.client_id, userId: row.user_id, scopes: row.scopes });
      }
      if (grantType === 'refresh_token') {
        const refresh = str('refresh_token');
        if (!refresh) throw new OAuthError('invalid_request', 'refresh_token is required');
        const g = await db.selectFrom('oauth_grants').selectAll().where('refresh_hash', '=', sha256(refresh)).where('revoked_at', 'is', null).executeTakeFirst();
        if (!g || (str('client_id') && g.client_id !== str('client_id'))) throw new OAuthError('invalid_grant', 'The refresh token is invalid or revoked');
        return issue({ clientId: g.client_id, userId: g.user_id, scopes: g.scopes }, g.id);
      }
      throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
    },

    /** Resolves a bearer access token to the grant it belongs to. */
    async verifyAccessToken(token: string): Promise<{ id: string; name: string; scopes: ApiScope[] } | null> {
      if (!/^pe_at_[A-Za-z0-9_-]{20,}$/.test(token)) return null;
      const g = await db.selectFrom('oauth_grants').innerJoin('oauth_clients', 'oauth_clients.id', 'oauth_grants.client_id')
        .select(['oauth_grants.id', 'oauth_grants.scopes', 'oauth_grants.access_expires_at', 'oauth_grants.last_used_at', 'oauth_clients.name'])
        .where('oauth_grants.access_hash', '=', sha256(token)).where('oauth_grants.revoked_at', 'is', null).executeTakeFirst();
      if (!g || g.access_expires_at.getTime() <= clock().getTime()) return null;
      if (!g.last_used_at || clock().getTime() - g.last_used_at.getTime() > 60_000) {
        await db.updateTable('oauth_grants').set({ last_used_at: clock() }).where('id', '=', g.id).execute();
      }
      return { id: g.id, name: g.name, scopes: g.scopes };
    },

    async grants() {
      return db.selectFrom('oauth_grants').innerJoin('oauth_clients', 'oauth_clients.id', 'oauth_grants.client_id').leftJoin('users', 'users.id', 'oauth_grants.user_id')
        .select(['oauth_grants.id', 'oauth_clients.name as client_name', 'oauth_grants.scopes', 'users.email as approved_by', 'oauth_grants.created_at', 'oauth_grants.last_used_at', 'oauth_grants.revoked_at'])
        .orderBy('oauth_grants.created_at', 'desc').limit(100).execute();
    },

    async revoke(id: string, actor: Actor) {
      const res = await db.updateTable('oauth_grants').set({ revoked_at: clock() }).where('id', '=', id).where('revoked_at', 'is', null).executeTakeFirst();
      if (res.numUpdatedRows) await audit(db, actor, { action: 'oauth.revoke', entityType: 'oauth_grant', entityId: id });
      return Number(res.numUpdatedRows) > 0;
    },

    /** Housekeeping for retention: drop used or expired codes. */
    async prune() {
      const res = await db.deleteFrom('oauth_codes').where((eb) => eb.or([eb('expires_at', '<', clock()), eb('used_at', 'is not', null)])).executeTakeFirst();
      return Number(res.numDeletedRows);
    },

    countActive: async () => Number((await db.selectFrom('oauth_grants').select(sql<string>`count(*)`.as('n')).where('revoked_at', 'is', null).executeTakeFirstOrThrow()).n),
  };
}

export type OAuthService = ReturnType<typeof createOAuthService>;
