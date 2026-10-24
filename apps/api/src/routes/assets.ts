import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf, requireUser } from '../plugins/auth.ts';
import { MAX_ASSET_BYTES, MAX_BYTES, MAX_UPLOAD_BYTES } from '../services/assets.ts';

const idParam = z.object({ id: z.string().uuid() });
const uploadBody = z.object({ name: z.string().max(255).default('image'), data: z.string().max(Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/=]*$/, 'data must be base64') });
const listQuery = z.object({
  kind: z.enum(['image', 'document', 'video', 'audio']).optional(),
  folder_id: z.union([z.literal('root'), z.string().uuid()]).optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
/** Inline types render in the browser or email client; everything else downloads. */
const INLINE = /^(image\/|video\/|audio\/|application\/pdf$|text\/plain$)/;

/** `bytes=start-end`, `bytes=start-` or `bytes=-suffix`; one range only. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return 'invalid';
  let start: number, end: number;
  if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1; } else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

export const assetRoutes: FastifyPluginAsync = async (app) => {
  const { assets } = app.services;
  // Absolute links, because emails are read far away from the console.
  const base = app.deps.config.PE_PUBLIC_URL.replace(/\/+$/, '');
  const withUrl = <T extends { id: string }>(a: T) => ({ ...a, url: `${base}/a/${a.id}` });
  const marketer = { preHandler: requireUser('marketer') };

  // Base64 in JSON keeps designer image uploads on the same CSRF-protected, typed path as every other console write.
  app.post('/api/assets', { ...marketer, bodyLimit: Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 64 * 1024 }, async (req, reply) => {
    const b = uploadBody.parse(req.body);
    return reply.code(201).send(withUrl(await assets.create({ name: b.name, data: Buffer.from(b.data, 'base64'), imagesOnly: true }, actorOf(req))));
  });

  // The library uploads raw bytes (no base64 overhead), with the file name and folder in headers.
  await app.register(async (raw) => {
    raw.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));
    raw.post('/api/assets/upload', { ...marketer, bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
      const header = (n: string) => { const v = req.headers[n]; return typeof v === 'string' ? v : undefined; };
      let name = 'file';
      try { name = decodeURIComponent(header('x-file-name') ?? 'file'); } catch { /* keep the default */ }
      const folder = header('x-folder-id');
      const folderId = folder ? z.string().uuid().parse(folder) : null;
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      return reply.code(201).send(withUrl(await assets.create({ name, data, folderId }, actorOf(req))));
    });
  });

  app.get('/api/assets', { preHandler: requireUser('viewer') }, async (req) => {
    const q = listQuery.parse(req.query);
    return { data: (await assets.list({ kind: q.kind, folderId: q.folder_id === 'root' ? null : q.folder_id, q: q.q, limit: q.limit })).map(withUrl) };
  });
  app.get('/api/assets/usage', { preHandler: requireUser('viewer') }, async () => ({ ...(await assets.totals()), limits: MAX_BYTES }));
  app.get('/api/assets/:id', { preHandler: requireUser('viewer') }, async (req) => withUrl(await assets.get(idParam.parse(req.params).id)));
  app.patch('/api/assets/:id', marketer, async (req) => withUrl(await assets.update(idParam.parse(req.params).id, req.body, actorOf(req))));
  app.delete('/api/assets/:id', marketer, async (req, reply) => {
    await assets.remove(idParam.parse(req.params).id, actorOf(req));
    return reply.code(204).send();
  });

  // Public: email clients and apps load these without a session. Ids are random UUIDs; content never changes, so it
  // caches. Ranges let video players seek without downloading the whole file.
  app.get('/a/:id', async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Not found' });
    const file = await assets.head(parsed.data.id).catch(() => null);
    if (!file) return reply.code(404).send({ error: 'Not found' });
    const range = parseRange(req.headers.range, file.size);
    if (range === 'invalid') return reply.code(416).header('content-range', `bytes */${file.size}`).send();
    const data = await assets.bytes(parsed.data.id, range ?? undefined);
    const disposition = INLINE.test(file.content_type) ? 'inline' : `attachment; filename="${file.name.replace(/"/g, '')}"`;
    reply
      .header('content-type', file.content_type.startsWith('text/') ? `${file.content_type}; charset=utf-8` : file.content_type)
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('etag', `"${file.sha256}"`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('content-disposition', disposition);
    if (range) reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${file.size}`);
    return reply.send(data);
  });
};
