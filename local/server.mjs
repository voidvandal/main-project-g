// Run the whole app locally with an in-memory store: `node local/server.mjs`
// Serves frontend/ and the same API router the Lambda uses, under /api.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { route } from '../backend/src/handler.mjs';
import { createService } from '../backend/src/service.mjs';
import { memoryStore } from '../backend/src/stores.mjs';

const PORT = Number(process.env.PORT ?? 5174);
const root = fileURLToPath(new URL('../frontend/', import.meta.url));
const service = createService(memoryStore());
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

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

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
  const file = normalize(join(root, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`SeatSpot running at http://localhost:${PORT}`));
