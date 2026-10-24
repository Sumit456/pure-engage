// Serves the built console (apps/console/dist) for single-container deployments, with SPA fallback to
// index.html. API, hook and tracking paths keep their JSON 404s.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const API_PREFIXES = ['/api/', '/hooks/', '/t/', '/u/', '/healthz'];

export const consoleRoutes: FastifyPluginAsync<{ dir: string }> = async (app, { dir }) => {
  const root = path.resolve(dir);
  const index = await readFile(path.join(root, 'index.html'));

  app.setNotFoundHandler(async (req, reply) => {
    const urlPath = decodeURIComponent((req.url.split('?')[0] ?? '/'));
    if (req.method !== 'GET' || API_PREFIXES.some((p) => urlPath.startsWith(p))) return reply.code(404).send({ error: 'Not found' });
    const file = path.resolve(root, `.${urlPath}`);
    if (file.startsWith(root + path.sep) && (await stat(file).then((s) => s.isFile(), () => false))) {
      const immutable = urlPath.startsWith('/assets/'); // Vite content-hashed files
      return reply.headers({ 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' }).send(await readFile(file));
    }
    return reply.headers({ 'content-type': TYPES['.html']!, 'cache-control': 'no-cache' }).send(index);
  });
};
