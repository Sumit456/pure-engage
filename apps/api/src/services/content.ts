// Content Builder: folders shared by every kind of content, reusable content blocks, and one listing across emails,
// SMS, push, WhatsApp, blocks and files.
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { ContentBlockContent, Database } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { audit, type Actor } from './audit.ts';

export const CONTENT_TYPES = ['email', 'sms', 'push', 'whatsapp', 'block', 'image', 'document', 'video', 'audio'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
const TEMPLATE_TYPES = ['email', 'sms', 'push', 'whatsapp'] as const;
const FILE_TYPES = ['image', 'document', 'video', 'audio'] as const;

const tags = z.array(z.string().trim().min(1).max(40)).max(20).transform((t) => [...new Set(t.map((x) => x.toLowerCase()))]);
const folderInput = z.object({ name: z.string().trim().min(1).max(100), parent_id: z.string().uuid().nullable().default(null) });
const blockContent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('design'), content: z.object({ blocks: z.array(z.record(z.unknown())).min(1).max(50) }) }),
  z.object({ kind: z.literal('html'), content: z.object({ html: z.string().min(1).max(200_000) }) }),
  z.object({ kind: z.literal('text'), content: z.object({ text: z.string().min(1).max(20_000) }) }),
]);
const blockMeta = { name: z.string().trim().min(1).max(200), folder_id: z.string().uuid().nullable().optional(), tags: tags.optional() };
const blockCreate = z.intersection(z.object(blockMeta), blockContent);
const blockUpdate = z.object({ ...blockMeta, name: blockMeta.name.optional(), content: z.unknown().optional() });
const moveInput = z.object({
  folder_id: z.string().uuid().nullable(),
  items: z.array(z.object({ type: z.enum(CONTENT_TYPES), id: z.string().uuid() })).min(1).max(200),
});
export const contentQuery = z.object({
  type: z.string().optional().transform((s) => s?.split(',').filter(Boolean)).pipe(z.array(z.enum(CONTENT_TYPES)).optional()),
  folder_id: z.union([z.literal('root'), z.string().uuid()]).optional(),
  q: z.string().max(100).optional(),
  tag: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export interface ContentItem {
  type: ContentType; id: string; name: string; folder_id: string | null; tags: string[]; updated_at: Date;
  purpose?: string | null; content_type?: string | null; size?: number | null; width?: number | null; height?: number | null;
}

export function createContentService(db: Kysely<Database>) {
  async function folder(id: string) {
    const f = await db.selectFrom('content_folders').selectAll().where('id', '=', id).executeTakeFirst();
    if (!f) throw notFound('Folder');
    return f;
  }
  async function assertFolder(id: string | null | undefined) {
    if (id) await folder(id).catch(() => { throw badRequest('Folder not found', [{ path: 'folder_id', message: 'Not found' }]); });
  }
  async function block(id: string) {
    const b = await db.selectFrom('content_blocks').selectAll().where('id', '=', id).executeTakeFirst();
    if (!b) throw notFound('Content block');
    return b;
  }

  return {
    // ---------- folders ----------
    async folders() {
      const [rows, counts] = await Promise.all([
        db.selectFrom('content_folders').selectAll().orderBy('name').execute(),
        sql<{ folder_id: string; n: string }>`
          select folder_id, count(*)::text as n from (
            select folder_id from templates where archived_at is null and folder_id is not null
            union all select folder_id from content_blocks where archived_at is null and folder_id is not null
            union all select folder_id from assets where folder_id is not null) x
          group by folder_id`.execute(db),
      ]);
      const by = new Map(counts.rows.map((r) => [r.folder_id, Number(r.n)]));
      return rows.map((f) => ({ ...f, items: by.get(f.id) ?? 0 }));
    },

    async createFolder(input: unknown, actor: Actor) {
      const data = folderInput.parse(input);
      await assertFolder(data.parent_id);
      const row = await db.insertInto('content_folders').values({ name: data.name, parent_id: data.parent_id }).returningAll().executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'folder.create', entityType: 'folder', entityId: row.id });
      return row;
    },

    async updateFolder(id: string, input: unknown, actor: Actor) {
      await folder(id);
      const data = folderInput.partial().parse(input);
      if (data.parent_id) {
        // A folder can't move inside itself or one of its own subfolders.
        const { rows } = await sql<{ id: string }>`
          with recursive up as (select id, parent_id from content_folders where id = ${data.parent_id}
            union all select f.id, f.parent_id from content_folders f join up on f.id = up.parent_id)
          select id from up`.execute(db);
        if (rows.some((r) => r.id === id)) throw badRequest('A folder can\'t be moved into itself', [{ path: 'parent_id', message: 'Would create a loop' }]);
      }
      const row = await db.updateTable('content_folders').set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.parent_id !== undefined ? { parent_id: data.parent_id } : {}),
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'folder.update', entityType: 'folder', entityId: id, details: { fields: Object.keys(data) } });
      return row;
    },

    async removeFolder(id: string, actor: Actor) {
      await folder(id);
      const busy = await sql<{ n: string }>`
        select (select count(*) from content_folders where parent_id = ${id})
          + (select count(*) from templates where folder_id = ${id} and archived_at is null)
          + (select count(*) from content_blocks where folder_id = ${id} and archived_at is null)
          + (select count(*) from assets where folder_id = ${id}) as n`.execute(db);
      if (Number(busy.rows[0]?.n ?? 0) > 0) throw conflict('This folder isn\'t empty. Move or delete what\'s in it first.');
      await db.deleteFrom('content_folders').where('id', '=', id).execute();
      await audit(db, actor, { action: 'folder.delete', entityType: 'folder', entityId: id });
    },

    // ---------- content blocks ----------
    async blocks() {
      return db.selectFrom('content_blocks').selectAll().where('archived_at', 'is', null).orderBy('updated_at', 'desc').execute();
    },
    block,

    async createBlock(input: unknown, actor: Actor) {
      const data = blockCreate.parse(input);
      await assertFolder(data.folder_id);
      const row = await db.insertInto('content_blocks').values({
        name: data.name, kind: data.kind, content: JSON.stringify(data.content), folder_id: data.folder_id ?? null,
        tags: JSON.stringify(data.tags ?? []), created_by: actor.type === 'user' ? actor.id : null,
      }).returningAll().executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'content_block.create', entityType: 'content_block', entityId: row.id });
      return row;
    },

    async updateBlock(id: string, input: unknown, actor: Actor) {
      const current = await block(id);
      const data = blockUpdate.parse(input);
      await assertFolder(data.folder_id);
      let content: ContentBlockContent | undefined;
      if (data.content !== undefined) content = blockContent.parse({ kind: current.kind, content: data.content }).content;
      const row = await db.updateTable('content_blocks').set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.folder_id !== undefined ? { folder_id: data.folder_id } : {}),
        ...(data.tags !== undefined ? { tags: JSON.stringify(data.tags) } : {}),
        ...(content ? { content: JSON.stringify(content) } : {}),
        updated_at: new Date(),
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'content_block.update', entityType: 'content_block', entityId: id, details: { fields: Object.keys(data) } });
      return row;
    },

    async archiveBlock(id: string, actor: Actor) {
      await block(id);
      await db.updateTable('content_blocks').set({ archived_at: new Date(), updated_at: new Date() }).where('id', '=', id).execute();
      await audit(db, actor, { action: 'content_block.archive', entityType: 'content_block', entityId: id });
    },

    // ---------- the library ----------
    /** Everything in one list, newest first. Metadata only: no content bodies or file bytes. */
    async list(input: unknown): Promise<{ data: ContentItem[]; total: number }> {
      const q = contentQuery.parse(input ?? {});
      const want = new Set(q.type?.length ? q.type : CONTENT_TYPES);
      const parts = [];
      const folderSql = (col: string) => (q.folder_id === 'root' ? sql`and ${sql.ref(col)} is null` : q.folder_id ? sql`and ${sql.ref(col)} = ${q.folder_id}` : sql``);
      const nameSql = (col: string) => (q.q?.trim() ? sql`and ${sql.ref(col)} ilike ${`%${q.q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`}` : sql``);
      const tagSql = (col: string) => (q.tag ? sql`and ${sql.ref(col)} ? ${q.tag.toLowerCase()}` : sql``);
      const channels = TEMPLATE_TYPES.filter((t) => want.has(t));
      if (channels.length) {
        parts.push(sql`select t.channel as type, t.id, t.name, t.folder_id, t.tags, t.updated_at, t.purpose, null::text as content_type, null::int as size, null::int as width, null::int as height
          from templates t where t.archived_at is null and t.channel in (${sql.join(channels)}) ${folderSql('t.folder_id')} ${nameSql('t.name')} ${tagSql('t.tags')}`);
      }
      if (want.has('block')) {
        parts.push(sql`select 'block' as type, b.id, b.name, b.folder_id, b.tags, b.updated_at, null::text as purpose, b.kind as content_type, null::int as size, null::int as width, null::int as height
          from content_blocks b where b.archived_at is null ${folderSql('b.folder_id')} ${nameSql('b.name')} ${tagSql('b.tags')}`);
      }
      const kinds = FILE_TYPES.filter((t) => want.has(t));
      if (kinds.length) {
        parts.push(sql`select a.kind as type, a.id, a.name, a.folder_id, a.tags, a.updated_at, null::text as purpose, a.content_type, a.size, a.width, a.height
          from assets a where a.kind in (${sql.join(kinds)}) ${folderSql('a.folder_id')} ${nameSql('a.name')} ${tagSql('a.tags')}`);
      }
      if (!parts.length) return { data: [], total: 0 };
      const union = sql.join(parts, sql` union all `);
      const [rows, total] = await Promise.all([
        sql<ContentItem>`select * from (${union}) c order by updated_at desc, id desc limit ${q.limit} offset ${q.offset}`.execute(db),
        sql<{ n: string }>`select count(*)::text as n from (${union}) c`.execute(db),
      ]);
      return { data: rows.rows, total: Number(total.rows[0]?.n ?? 0) };
    },

    /** Moves any mix of content and files into a folder (or to the top level with null). */
    async move(input: unknown, actor: Actor) {
      const data = moveInput.parse(input);
      await assertFolder(data.folder_id);
      const ids = (types: readonly string[]) => data.items.filter((i) => types.includes(i.type)).map((i) => i.id);
      const now = new Date();
      await db.transaction().execute(async (tx) => {
        const t = ids(TEMPLATE_TYPES), b = ids(['block']), a = ids(FILE_TYPES);
        if (t.length) await tx.updateTable('templates').set({ folder_id: data.folder_id, updated_at: now }).where('id', 'in', t).execute();
        if (b.length) await tx.updateTable('content_blocks').set({ folder_id: data.folder_id, updated_at: now }).where('id', 'in', b).execute();
        if (a.length) await tx.updateTable('assets').set({ folder_id: data.folder_id, updated_at: now }).where('id', 'in', a).execute();
      });
      await audit(db, actor, { action: 'content.move', entityType: 'folder', ...(data.folder_id ? { entityId: data.folder_id } : {}), details: { items: data.items.length } });
      return { moved: data.items.length };
    },
  };
}

export type ContentService = ReturnType<typeof createContentService>;
