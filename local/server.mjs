// Serves frontend/ and the same API router the Lambda uses, under /api.
// Locally: `node local/server.mjs` (in-memory store, demo data).
// In production (Lightsail container): DATA_BUCKET=<s3 bucket> DEMO=0 PORT=8080.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { route } from '../backend/src/handler.mjs';
import { createService } from '../backend/src/service.mjs';
import { memoryStore, s3SnapshotStore } from '../backend/src/stores.mjs';

const PORT = Number(process.env.PORT ?? 5174);
const root = fileURLToPath(new URL('../frontend/', import.meta.url));
const backendSrc = fileURLToPath(new URL('../backend/src/', import.meta.url)); // for ?demo mode
const store = process.env.DATA_BUCKET ? await s3SnapshotStore(process.env.DATA_BUCKET) : memoryStore();
const service = createService(store);
await service.seed();

// Optional: pre-fill some seats so the map looks lived-in for a demo video.
if (process.env.DEMO !== '0') {
  const ids = (await service.listSeats()).map((s) => s.seatId);
  let n = 0;
  for (const id of ids) {
    if ((id.charCodeAt(id.length - 1) + id.length) % 3 === 0) {
      const { token } = await service.checkIn(id, `DEMO${n++}`);
      if (n % 5 === 0) await service.takeBreak(id, token);
    }
  }
}
setInterval(() => service.releaseExpired(), 60_000);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    let raw = '';
    for await (const c of req) raw += c;
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    const r = await route(service, { method: req.method, path: url.pathname, body, headers: req.headers });
    res.writeHead(r.statusCode, r.headers).end(r.body);
    return;
  }
  const isBackend = url.pathname.startsWith('/backend/');
  const base = isBackend ? backendSrc : root;
  const rel = isBackend ? url.pathname.slice('/backend/'.length) : url.pathname === '/' ? 'index.html' : url.pathname;
  const file = normalize(join(base, rel));
  if (!file.startsWith(base)) return res.writeHead(403).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, '0.0.0.0', () => console.log(`SeatSpot running at http://localhost:${PORT}`));
