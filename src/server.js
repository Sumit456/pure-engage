// Development service: receives PureNet webhooks and shows what would be ingested.
// There is no platform store yet. The sink keeps the last payloads in memory, and they're visible at
// GET /_dev/ingested (disabled when NODE_ENV=production).
import { createServer } from 'node:http';
import { createPureNetFromEnv, createReceiver } from './integrations/purenet/index.js';

const PORT = Number(process.env.PORT || 4100);
const HOST = process.env.HOST || '127.0.0.1';
const DEV = process.env.NODE_ENV !== 'production';

const log = (level, msg, fields = {}) => console.log(JSON.stringify({ level, msg, ...fields, ts: new Date().toISOString() }));

const { config, client } = createPureNetFromEnv();
if (!config.webhookSecret) log('warn', 'PURENET_WEBHOOK_SECRET is not set; every delivery will be rejected');

const ingested = [];
const sink = async (track) => {
  ingested.push(track);
  if (ingested.length > 200) ingested.shift();
};

const purenetHook = createReceiver({ secret: config.webhookSecret, sink, client, log });

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (req.method === 'GET' && pathname === '/healthz') return res.writeHead(200).end('ok');
  if (req.method === 'POST' && pathname === '/hooks/purenet') return purenetHook(req, res);
  if (DEV && req.method === 'GET' && pathname === '/_dev/ingested') {
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ingested, null, 2));
  }
  res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
});

server.listen(PORT, HOST, () => log('info', 'listening', { url: `http://${HOST}:${PORT}`, purenet: config.baseUrl }));
