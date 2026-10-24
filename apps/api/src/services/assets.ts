// The content library's files: images, documents, video and audio. The type is decided from the file's bytes (never
// the name or the declared type); SVG and HTML are refused because they can carry script. Identical uploads are
// stored once, and bytes live behind an AssetStore so they can move to object storage later.
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { AssetContentType, AssetKind, Database } from '../db/schema.ts';
import { HttpError, badRequest, conflict, notFound } from '../errors.ts';
import { audit, type Actor } from './audit.ts';
import { createDbStore, type AssetStore, type ByteRange } from './storage.ts';

/** Per-kind limits. The free Render database is 1 GB, so video stays short until object storage is configured. */
export const MAX_BYTES: Record<AssetKind, number> = { image: 5 * 1024 * 1024, document: 10 * 1024 * 1024, video: 20 * 1024 * 1024, audio: 20 * 1024 * 1024 };
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(MAX_BYTES));
/** Images uploaded inline from the email designer. */
export const MAX_ASSET_BYTES = MAX_BYTES.image;
type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Detects the image type and, where cheap, its pixel size from the first bytes. */
export function sniffImage(b: Buffer): { type: ImageType; width: number | null; height: number | null } | null {
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) {
    return { type: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = b.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8X' && b.length >= 30) return { type: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8 ' && b.length >= 30) return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && b.length >= 25) { const v = b.readUInt32LE(21); return { type: 'image/webp', width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    return { type: 'image/webp', width: null, height: null };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // Walk the JPEG segments to the first start-of-frame marker for the size.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'image/jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return { type: 'image/jpeg', width: null, height: null };
  }
  return null;
}

const OFFICE: Record<string, { type: AssetContentType; dir: string }> = {
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dir: 'word/' },
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dir: 'xl/' },
  pptx: { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', dir: 'ppt/' },
};
const MP4_BRANDS = /^(isom|iso[2-9]|mp41|mp42|avc1|dash|M4V |mmp4|f4v )$/;

/**
 * Detects a supported file from its bytes. Office files and text need the matching extension as well, since their
 * bytes alone (ZIP, plain text) don't say what they are.
 */
export function sniffFile(b: Buffer, name: string): { type: AssetContentType; kind: AssetKind; width: number | null; height: number | null } | null {
  const image = sniffImage(b);
  if (image) return { ...image, kind: 'image' };
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const none = { width: null, height: null };
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return { type: 'application/pdf', kind: 'document', ...none };
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && MP4_BRANDS.test(b.subarray(8, 12).toString('latin1'))) return { type: 'video/mp4', kind: 'video', ...none };
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return { type: 'video/webm', kind: 'video', ...none };
  if (b.length >= 3 && (b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && ext === 'mp3'))) return { type: 'audio/mpeg', kind: 'audio', ...none };
  if (b.length >= 4 && b.readUInt32BE(0) === 0x504b0304 && OFFICE[ext] && b.includes('[Content_Types].xml') && b.includes(OFFICE[ext]!.dir)) {
    return { type: OFFICE[ext]!.type, kind: 'document', ...none };
  }
  if ((ext === 'csv' || ext === 'txt') && !b.includes(0)) {
    const text = b.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(b) && !/<\s*(script|html|svg|iframe)/i.test(text)) return { type: ext === 'csv' ? 'text/csv' : 'text/plain', kind: 'document', ...none };
  }
  return null;
}

const cleanName = (n: string) => n.replace(/^.*[\\/]/, '').replace(/[^\w .()-]/g, '_').slice(0, 120) || 'file';
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(20).transform((t) => [...new Set(t.map((x) => x.toLowerCase()))]);
export const assetUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  folder_id: z.string().uuid().nullable().optional(),
  tags: tagsSchema.optional(),
  description: z.string().max(1000).optional(),
});
const meta = ['id', 'name', 'content_type', 'kind', 'size', 'width', 'height', 'folder_id', 'tags', 'description', 'created_at', 'updated_at'] as const;
const LIMIT_TEXT: Record<AssetKind, string> = { image: 'Images can be at most 5 MB', document: 'Documents can be at most 10 MB', video: 'Videos can be at most 20 MB', audio: 'Audio files can be at most 20 MB' };

export function createAssetsService(db: Kysely<Database>, store: AssetStore = createDbStore(db)) {
  async function assertFolder(id: string | null | undefined) {
    if (!id) return;
    if (!(await db.selectFrom('content_folders').select('id').where('id', '=', id).executeTakeFirst())) throw badRequest('Folder not found', [{ path: 'folder_id', message: 'Not found' }]);
  }

  /** Current templates and content blocks that reference the asset (by id or by its public URL). */
  async function usage(id: string) {
    const like = `%${id}%`;
    const [templates, blocks] = await Promise.all([
      db.selectFrom('templates').innerJoin('template_versions', (j) => j.onRef('template_versions.template_id', '=', 'templates.id').onRef('template_versions.version', '=', 'templates.current_version'))
        .select(['templates.id', 'templates.name', 'templates.channel']).where('templates.archived_at', 'is', null).where(sql`template_versions.content::text`, 'like', like).execute(),
      db.selectFrom('content_blocks').select(['id', 'name']).where('archived_at', 'is', null).where(sql`content::text`, 'like', like).execute(),
    ]);
    return [...templates.map((t) => ({ type: t.channel, id: t.id, name: t.name })), ...blocks.map((b) => ({ type: 'block' as const, id: b.id, name: b.name }))];
  }

  return {
    usage,

    async create({ name, data, folderId, imagesOnly = false }: { name: string; data: Buffer; folderId?: string | null; imagesOnly?: boolean }, actor: Actor) {
      if (!data.length) throw badRequest('The file is empty');
      const file = sniffFile(data, name);
      if (!file || (imagesOnly && file.kind !== 'image')) {
        throw badRequest(imagesOnly ? 'Only PNG, JPEG, GIF and WebP images are supported' : 'This file type isn\'t supported. Use PNG, JPEG, GIF, WebP, PDF, MP4, WebM, MP3, CSV, TXT, DOCX, XLSX or PPTX.');
      }
      if (data.length > MAX_BYTES[file.kind]) throw new HttpError(413, LIMIT_TEXT[file.kind]);
      await assertFolder(folderId);
      const sha256 = createHash('sha256').update(data).digest('hex');
      const existing = await db.selectFrom('assets').select(meta).where('sha256', '=', sha256).executeTakeFirst();
      if (existing) return existing;
      const row = await db.transaction().execute(async (tx) => {
        const r = await tx.insertInto('assets')
          .values({ name: cleanName(name), content_type: file.type, kind: file.kind, size: data.length, sha256, width: file.width, height: file.height, folder_id: folderId ?? null, created_by: actor.type === 'user' ? actor.id : null })
          .returning(meta).executeTakeFirstOrThrow();
        await store.put(r.id, data, tx);
        return r;
      });
      await audit(db, actor, { action: 'asset.create', entityType: 'asset', entityId: row.id, details: { content_type: row.content_type, size: row.size } });
      return row;
    },

    async list({ kind, folderId, q, limit = 100 }: { kind?: AssetKind | undefined; folderId?: string | null | undefined; q?: string | undefined; limit?: number } = {}) {
      let query = db.selectFrom('assets').select(meta).orderBy('created_at', 'desc').limit(Math.min(limit, 500));
      if (kind) query = query.where('kind', '=', kind);
      if (folderId !== undefined) query = folderId === null ? query.where('folder_id', 'is', null) : query.where('folder_id', '=', folderId);
      if (q?.trim()) query = query.where('name', 'ilike', `%${q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
      return query.execute();
    },

    async get(id: string) {
      const row = await db.selectFrom('assets').select(meta).where('id', '=', id).executeTakeFirst();
      if (!row) throw notFound('File');
      return { ...row, used_in: await usage(id) };
    },

    async update(id: string, input: unknown, actor: Actor) {
      const data = assetUpdateSchema.parse(input);
      await assertFolder(data.folder_id);
      const row = await db.updateTable('assets').set({
        ...(data.name !== undefined ? { name: cleanName(data.name) } : {}),
        ...(data.folder_id !== undefined ? { folder_id: data.folder_id } : {}),
        ...(data.tags !== undefined ? { tags: JSON.stringify(data.tags) } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        updated_at: new Date(),
      }).where('id', '=', id).returning(meta).executeTakeFirst();
      if (!row) throw notFound('File');
      await audit(db, actor, { action: 'asset.update', entityType: 'asset', entityId: id, details: { fields: Object.keys(data) } });
      return row;
    },

    /** What public delivery needs before reading any bytes. */
    async head(id: string) {
      const row = await db.selectFrom('assets').select(['content_type', 'kind', 'name', 'sha256', 'size']).where('id', '=', id).executeTakeFirst();
      if (!row) throw notFound('File');
      return row;
    },

    /** The file's bytes: all of them, or one range (video seeking). */
    async bytes(id: string, range?: ByteRange) {
      const data = await store.get(id, range);
      if (!data) throw notFound('File');
      return data;
    },

    /** Refused while current content uses the file; it would break in emails and messages. */
    async remove(id: string, actor: Actor) {
      const used = await usage(id);
      if (used.length) throw conflict(`This file is used in ${used.slice(0, 3).map((u) => `"${u.name}"`).join(', ')}${used.length > 3 ? ` and ${used.length - 3} more` : ''}. Remove it there first.`);
      const row = await db.deleteFrom('assets').where('id', '=', id).returning('id').executeTakeFirst();
      if (!row) throw notFound('File');
      await audit(db, actor, { action: 'asset.delete', entityType: 'asset', entityId: id });
    },

    /** Bytes stored, for the library's quota indicator. */
    async totals() {
      const r = await db.selectFrom('assets').select([sql<string>`coalesce(sum(size), 0)`.as('bytes'), sql<string>`count(*)`.as('files')]).executeTakeFirstOrThrow();
      return { bytes: Number(r.bytes), files: Number(r.files) };
    },
  };
}

export type AssetsService = ReturnType<typeof createAssetsService>;
