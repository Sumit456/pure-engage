// Where file bytes live. Today: the asset_blobs table (hosts like Render have no persistent disk). An S3-compatible
// store can implement the same interface later without touching the rest of the app.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/schema.ts';

/** Inclusive byte range, as in HTTP `Range: bytes=start-end`. */
export interface ByteRange { start: number; end: number }

export interface AssetStore {
  put(id: string, data: Buffer, tx?: Transaction<Database>): Promise<void>;
  get(id: string, range?: ByteRange): Promise<Buffer | null>;
}

export function createDbStore(db: Kysely<Database>): AssetStore {
  return {
    async put(id, data, tx) {
      await (tx ?? db).insertInto('asset_blobs').values({ asset_id: id, data }).execute();
    },
    async get(id, range) {
      // Ranges are cut in SQL, so seeking in a video doesn't read the whole file.
      const q = range
        ? db.selectFrom('asset_blobs').select(sql<Buffer>`substring(data from ${range.start + 1} for ${range.end - range.start + 1})`.as('data'))
        : db.selectFrom('asset_blobs').select('data');
      const row = await q.where('asset_id', '=', id).executeTakeFirst();
      return row?.data ?? null;
    },
  };
}
