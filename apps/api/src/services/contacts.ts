import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { consentMapSchema, type ConsentMap } from '@pure-engage/shared';
import type { Contact, Database } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { audit, type Actor } from './audit.ts';

type Tx = Kysely<Database> | Transaction<Database>;

const isTimezone = (tz: string) => {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
};

// Standard fields live in columns; everything else goes into `attributes`. `null` clears a value.
const standardFields = {
  external_id: z.string().trim().min(1).max(200).nullable(),
  email: z.string().trim().toLowerCase().email().max(320).nullable(),
  phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'phone must be E.164, e.g. +971500000001').nullable(),
  first_name: z.string().trim().max(200).nullable(),
  last_name: z.string().trim().max(200).nullable(),
  preferred_language: z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'preferred_language must be a BCP 47 tag').nullable(),
  timezone: z.string().refine(isTimezone, 'timezone must be an IANA name, e.g. Asia/Dubai').nullable(),
};
const STANDARD_KEYS = Object.keys(standardFields) as (keyof typeof standardFields)[];
const RESERVED = new Set<string>([...STANDARD_KEYS, 'consent', 'contact_id', 'id', 'created_at', 'updated_at']);

const contactInputSchema = z
  .object({
    ...Object.fromEntries(STANDARD_KEYS.map((k) => [k, standardFields[k].optional()])),
    consent: consentMapSchema.optional(),
  })
  .passthrough();

export type ContactInput = Record<string, unknown>;
export interface ContactRef { contact_id?: string | undefined; external_id?: string | undefined; email?: string | undefined }
export interface WriteOptions { source: string; actor: Actor }

function splitInput(input: ContactInput) {
  const parsed = contactInputSchema.safeParse(input);
  if (!parsed.success) throw badRequest('Invalid contact', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const data = parsed.data as Record<string, unknown>;
  const columns: Record<string, unknown> = {};
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if ((STANDARD_KEYS as string[]).includes(k)) columns[k] = v;
    else if (!RESERVED.has(k)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) throw badRequest(`Invalid attribute name "${k}"`);
      attributes[k] = v;
    }
  }
  return { columns, attributes, consent: data.consent as ConsentMap | undefined };
}

function mergeAttributes(current: Record<string, unknown>, patch: Record<string, unknown>) {
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

/** Applies a consent patch, recording one history row per actual change. */
async function applyConsent(tx: Tx, contact: Pick<Contact, 'id' | 'consent'>, patch: ConsentMap | undefined, source: string) {
  if (!patch) return { consent: contact.consent, changed: false };
  const next: ConsentMap = structuredClone(contact.consent ?? {});
  const rows: { contact_id: string; channel: string; purpose: string; status: string; previous_status: string | null; source: string }[] = [];
  for (const [channel, purposes] of Object.entries(patch)) {
    for (const [purpose, status] of Object.entries(purposes ?? {})) {
      const ch = channel as keyof ConsentMap;
      const previous = next[ch]?.[purpose as 'care'] ?? null;
      if (previous === status) continue;
      next[ch] = { ...(next[ch] ?? {}), [purpose]: status };
      rows.push({ contact_id: contact.id, channel, purpose, status: status as string, previous_status: previous, source });
    }
  }
  if (rows.length) await tx.insertInto('consent_history').values(rows).execute();
  return { consent: next, changed: rows.length > 0 };
}

export function createContactsService(db: Kysely<Database>) {
  async function findByRef(tx: Tx, ref: ContactRef, { lock = false } = {}): Promise<Contact | undefined> {
    let q = tx.selectFrom('contacts').selectAll();
    if (ref.contact_id) q = q.where('id', '=', ref.contact_id);
    else if (ref.external_id) q = q.where('external_id', '=', ref.external_id);
    else if (ref.email) {
      // Matching by email alone is only safe when it's unambiguous (families can share an address).
      const matches = await tx.selectFrom('contacts').select('id').where(sql`lower(email)`, '=', ref.email.toLowerCase()).limit(2).execute();
      if (matches.length > 1) throw conflict('More than one contact has this email; use external_id or contact_id');
      if (!matches[0]) return undefined;
      q = q.where('id', '=', matches[0].id);
    } else throw badRequest('one of external_id, email or contact_id is required');
    return (lock ? q.forUpdate() : q).executeTakeFirst();
  }

  async function upsertIn(tx: Tx, input: ContactInput, opts: WriteOptions): Promise<{ contact: Contact; created: boolean }> {
    const ref: ContactRef = {
      contact_id: typeof input.contact_id === 'string' ? input.contact_id : undefined,
      external_id: typeof input.external_id === 'string' ? input.external_id.trim() : undefined,
      email: typeof input.email === 'string' ? input.email.trim() : undefined,
    };
    const { columns, attributes, consent } = splitInput(input);
    let existing = await findByRef(tx, ref, { lock: true });
    if (!existing && ref.contact_id) throw notFound('Contact');

    let created = false;
    if (!existing) {
      const inserted = await tx
        .insertInto('contacts')
        .values({ ...columns, attributes: JSON.stringify(attributes), consent: '{}' })
        .onConflict((oc) => oc.column('external_id').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) { existing = inserted; created = true; }
      else existing = await findByRef(tx, ref, { lock: true }); // lost a race on external_id
      if (!existing) throw conflict('Contact could not be created');
    }

    const { consent: nextConsent, changed: consentChanged } = await applyConsent(tx, existing, consent, opts.source);
    const changedColumns = created ? [] : Object.keys(columns).filter((k) => (existing as Record<string, unknown>)[k] !== columns[k]);
    const nextAttributes = created ? attributes : mergeAttributes(existing.attributes, attributes);
    const attributesChanged = !created && JSON.stringify(nextAttributes) !== JSON.stringify(existing.attributes);

    let contact = existing;
    if (consentChanged || changedColumns.length || attributesChanged) {
      contact = await tx
        .updateTable('contacts')
        .set({
          ...Object.fromEntries(changedColumns.map((k) => [k, columns[k]])),
          attributes: JSON.stringify(nextAttributes),
          consent: JSON.stringify(nextConsent),
          updated_at: new Date(),
        })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    if (created || changedColumns.length || attributesChanged || consentChanged) {
      await audit(tx, opts.actor, {
        action: created ? 'contact.create' : 'contact.update',
        entityType: 'contact',
        entityId: contact.id,
        details: {
          source: opts.source,
          fields: created ? Object.keys(columns) : changedColumns,
          attributes: Object.keys(attributes),
          consent_changed: consentChanged,
        },
      });
    }
    return { contact, created };
  }

  return {
    findByRef: (ref: ContactRef) => findByRef(db, ref),

    /** Create or update by contact_id → external_id → email. */
    upsert(input: ContactInput, opts: WriteOptions) {
      return db.transaction().execute((tx) => upsertIn(tx, input, opts));
    },
    upsertIn,

    async create(input: ContactInput, opts: WriteOptions) {
      if (typeof input.external_id === 'string') {
        const clash = await db.selectFrom('contacts').select('id').where('external_id', '=', input.external_id.trim()).executeTakeFirst();
        if (clash) throw conflict('A contact with this external_id already exists');
      }
      if (!input.external_id && !input.email) throw badRequest('external_id or email is required');
      return (await this.upsert({ ...input, contact_id: undefined }, opts)).contact;
    },

    async update(id: string, input: ContactInput, opts: WriteOptions) {
      return (await this.upsert({ ...input, contact_id: id }, opts)).contact;
    },

    async get(id: string): Promise<Contact> {
      const c = await db.selectFrom('contacts').selectAll().where('id', '=', id).executeTakeFirst();
      if (!c) throw notFound('Contact');
      return c;
    },

    async remove(id: string, actor: Actor): Promise<void> {
      await db.transaction().execute(async (tx) => {
        const c = await tx.deleteFrom('contacts').where('id', '=', id).returning(['id', 'external_id']).executeTakeFirst();
        if (!c) throw notFound('Contact');
        await audit(tx, actor, { action: 'contact.delete', entityType: 'contact', entityId: id, details: { external_id: c.external_id } });
      });
    },

    /** Keyset pagination on (updated_at desc, id desc). */
    async list({ q, limit = 50, cursor }: { q?: string | undefined; limit?: number; cursor?: string | undefined }) {
      let query = db.selectFrom('contacts').selectAll().orderBy('updated_at', 'desc').orderBy('id', 'desc').limit(Math.min(Math.max(limit, 1), 200) + 1);
      if (q?.trim()) {
        const term = `%${q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
        query = query.where((eb) =>
          eb.or([
            eb('external_id', 'ilike', term),
            eb('email', 'ilike', term),
            eb('phone', 'ilike', term),
            eb(sql`coalesce(first_name, '') || ' ' || coalesce(last_name, '')`, 'ilike', term),
          ]),
        );
      }
      if (cursor) {
        const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
        if (!at || !id) throw badRequest('Invalid cursor');
        query = query.where((eb) => eb.or([eb('updated_at', '<', new Date(at)), eb.and([eb('updated_at', '=', new Date(at)), eb('id', '<', id)])]));
      }
      const rows = await query.execute();
      const page = rows.slice(0, Math.min(Math.max(limit, 1), 200));
      const last = page.at(-1);
      const next_cursor = rows.length > page.length && last ? Buffer.from(`${last.updated_at.toISOString()}|${last.id}`).toString('base64url') : null;
      return { data: page, next_cursor };
    },

    async consentHistory(id: string, limit = 50) {
      return db.selectFrom('consent_history').selectAll().where('contact_id', '=', id).orderBy('changed_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    },
  };
}

export type ContactsService = ReturnType<typeof createContactsService>;
