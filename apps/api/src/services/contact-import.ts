// Contact import from a spreadsheet. The console parses the file and maps columns; the API receives mapped rows in
// chunks and applies them with the same resolution rules as every other write (contact_id is never accepted here:
// external_id first, then an unambiguous email). Each row is its own transaction, so one bad row never blocks the
// rest. Consent changes are recorded with the source `import`, and one audit row records the counts.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/schema.ts';
import { HttpError, badRequest } from '../errors.ts';
import { audit, type Actor } from './audit.ts';
import type { ContactInput, ContactsService } from './contacts.ts';

export const MAX_IMPORT_ROWS = 1000;
export type ImportMode = 'upsert' | 'create_only' | 'update_only';
export type RowOutcome = 'created' | 'updated' | 'skipped' | 'error';

export interface ImportRequest {
  rows: ContactInput[];
  mode: ImportMode;
  dryRun: boolean;
  fileName: string;
  /** Row number of rows[0] in the file (chunks keep the file's numbering in error reports). */
  firstRow: number;
}

export interface ImportResult {
  dry_run: boolean;
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; message: string; fields?: { path: string; message: string }[] }[];
}

const cleanFileName = (name: string) => name.replace(/^.*[\\/]/, '').replace(/[^\w .()-]/g, '_').slice(0, 100) || 'import';
const describe = (err: unknown) => {
  if (err instanceof HttpError) {
    const fields = Array.isArray(err.details) ? (err.details as { path?: string; message?: string }[]).map((d) => ({ path: d.path ?? '', message: d.message ?? '' })) : undefined;
    return { message: err.message, ...(fields?.length ? { fields } : {}) };
  }
  throw err; // database or programming errors abort the request so the console can retry the chunk
};

export function createContactImportService(db: Kysely<Database>, contacts: ContactsService) {
  return {
    async run(req: ImportRequest, actor: Actor): Promise<ImportResult> {
      if (req.rows.length > MAX_IMPORT_ROWS) throw new HttpError(413, `Max ${MAX_IMPORT_ROWS} rows per request`);
      const fileName = cleanFileName(req.fileName);
      const result: ImportResult = { dry_run: req.dryRun, created: 0, updated: 0, skipped: 0, errors: [] };
      const seen = new Set<string>(); // within this chunk, a repeated member updates the earlier row

      for (const [i, raw] of req.rows.entries()) {
        const rowNo = req.firstRow + i;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { result.errors.push({ row: rowNo, message: 'Row must be an object' }); continue; }
        const { contact_id: _never, ...input } = raw as Record<string, unknown>;
        const externalId = typeof input.external_id === 'string' && input.external_id.trim() ? input.external_id.trim() : undefined;
        const email = typeof input.email === 'string' && input.email.trim() ? input.email.trim() : undefined;
        if (!externalId && !email) { result.errors.push({ row: rowNo, message: 'Each row needs an external ID or an email' }); continue; }
        const key = externalId ? `x:${externalId}` : `e:${email!.toLowerCase()}`;
        try {
          contacts.check(input);
          const existing = seen.has(key) || !!(await contacts.findByRef(externalId ? { external_id: externalId } : { email: email! }));
          if ((req.mode === 'create_only' && existing) || (req.mode === 'update_only' && !existing)) { result.skipped++; continue; }
          if (req.dryRun) {
            existing ? result.updated++ : result.created++;
          } else {
            const { created } = await contacts.upsert(input, { source: 'import', actor });
            created ? result.created++ : result.updated++;
          }
          seen.add(key);
        } catch (err) {
          result.errors.push({ row: rowNo, ...describe(err) });
        }
      }

      if (!req.dryRun) {
        await audit(db, actor, {
          action: 'contacts.import',
          entityType: 'contact',
          details: { file_name: fileName, mode: req.mode, first_row: req.firstRow, rows: req.rows.length, created: result.created, updated: result.updated, skipped: result.skipped, errors: result.errors.length },
        });
      }
      return result;
    },

    /** Recent imports (one audit row per chunk), newest first. Counts only. */
    async history(limit = 50) {
      // audit_log.actor_id is text (actors can be users, API keys or integrations), hence the cast.
      const { rows } = await sql<{ id: string; at: Date; details: Record<string, unknown>; actor_name: string | null; actor_email: string | null }>`
        select a.id, a.at, a.details, u.name as actor_name, u.email as actor_email
        from audit_log a left join users u on a.actor_type = 'user' and u.id::text = a.actor_id
        where a.action = 'contacts.import' order by a.at desc limit ${limit}`.execute(db);
      return rows;
    },

    parseMode(v: unknown): ImportMode {
      if (v === undefined) return 'upsert';
      if (v === 'upsert' || v === 'create_only' || v === 'update_only') return v;
      throw badRequest('mode must be upsert, create_only or update_only');
    },
  };
}

export type ContactImportService = ReturnType<typeof createContactImportService>;
