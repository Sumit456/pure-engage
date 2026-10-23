// Image assets for email templates. The type is decided from the file's bytes (never the name or the declared
// type), only raster formats email clients render are accepted (no SVG, which can carry script), and identical
// uploads are stored once.
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { AssetsTable, Database } from '../db/schema.ts';
import { HttpError, badRequest, notFound } from '../errors.ts';
import { audit, type Actor } from './audit.ts';

export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
type ImageType = AssetsTable['content_type'];

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

const cleanName = (n: string) => n.replace(/^.*[\\/]/, '').replace(/[^\w .()-]/g, '_').slice(0, 120) || 'image';
const meta = ['id', 'name', 'content_type', 'size', 'width', 'height', 'created_at'] as const;

export function createAssetsService(db: Kysely<Database>) {
  return {
    async create({ name, data }: { name: string; data: Buffer }, actor: Actor) {
      if (!data.length) throw badRequest('The file is empty');
      if (data.length > MAX_ASSET_BYTES) throw new HttpError(413, 'Images can be at most 2 MB');
      const kind = sniffImage(data);
      if (!kind) throw badRequest('Only PNG, JPEG, GIF and WebP images are supported');
      const sha256 = createHash('sha256').update(data).digest('hex');
      const existing = await db.selectFrom('assets').select(meta).where('sha256', '=', sha256).executeTakeFirst();
      if (existing) return existing;
      const row = await db.insertInto('assets')
        .values({ name: cleanName(name), content_type: kind.type, size: data.length, sha256, width: kind.width, height: kind.height, data, created_by: actor.type === 'user' ? actor.id : null })
        .returning(meta).executeTakeFirstOrThrow();
      await audit(db, actor, { action: 'asset.create', entityType: 'asset', entityId: row.id, details: { content_type: row.content_type, size: row.size } });
      return row;
    },

    list(limit = 100) {
      return db.selectFrom('assets').select(meta).orderBy('created_at', 'desc').limit(limit).execute();
    },

    async file(id: string) {
      const row = await db.selectFrom('assets').select(['content_type', 'data', 'name', 'sha256']).where('id', '=', id).executeTakeFirst();
      if (!row) throw notFound('Image');
      return row;
    },

    /** Removing an image breaks it in emails already sent, so the console asks first. */
    async remove(id: string, actor: Actor) {
      const row = await db.deleteFrom('assets').where('id', '=', id).returning('id').executeTakeFirst();
      if (!row) throw notFound('Image');
      await audit(db, actor, { action: 'asset.delete', entityType: 'asset', entityId: id });
    },
  };
}

export type AssetsService = ReturnType<typeof createAssetsService>;
