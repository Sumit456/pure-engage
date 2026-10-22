import { createServer } from 'node:http';

// Starts an HTTP server whose handler is swappable per test; records every request.
export async function fakeServer() {
  const requests = [];
  let handler = (req, res) => res.writeHead(500).end();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    handler(req, res, body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    handle(fn) { handler = fn; },
    close: () => new Promise((r) => server.close(r)),
  };
}

export const json = (res, status, body, headers = {}) =>
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(body === undefined ? '' : JSON.stringify(body));

export const tokenHandler = (counter, expires_in = 3600) => (req, res) => {
  counter.n++;
  json(res, 200, { access_token: `tok${counter.n}`, token_type: 'Bearer', expires_in });
};
