// Lambda entry points: `api` behind API Gateway (HTTP API, payload v2)
// and `sweeper` on an EventBridge schedule.
import { createService, HttpError } from './service.mjs';
import { dynamoStore, ConflictError } from './stores.mjs';

let servicePromise;
const getService = () =>
  (servicePromise ??= dynamoStore(process.env.TABLE_NAME).then((store) => createService(store)));

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

// Shared router, also used by the local dev server.
export async function route(service, { method, path, body, headers }) {
  // CloudFront forwards /api/* unchanged, so accept both /api/seats and /seats.
  const p = path.replace(/^\/api(?=\/)/, '').replace(/\/+$/, '') || '/';
  const token = headers?.['x-seat-token'] ?? body?.token;
  let m;

  try {
    if (method === 'GET' && p === '/health') return json(200, { ok: true });
    if (method === 'GET' && p === '/seats') return json(200, { seats: await service.listSeats(), now: Date.now() });
    if (method === 'GET' && p === '/stats') return json(200, await service.stats());

    if (method === 'POST' && (m = p.match(/^\/seats\/([A-Za-z0-9-]+)\/(checkin|extend|break|checkout|report)$/))) {
      const [, id, action] = m;
      switch (action) {
        case 'checkin':
          return json(200, await service.checkIn(id, body?.rollNo));
        case 'extend':
          return json(200, await service.extend(id, token));
        case 'break':
          return json(200, await service.takeBreak(id, token));
        case 'checkout':
          return json(200, await service.checkOut(id, token));
        case 'report':
          return json(200, await service.report(id));
      }
    }

    if (method === 'POST' && p === '/admin/seed') {
      const key = headers?.['x-admin-key'];
      if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) return json(401, { error: 'Bad admin key' });
      return json(200, await service.seed());
    }

    return json(404, { error: `No route for ${method} ${p}` });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    if (e instanceof ConflictError) return json(409, { error: e.message });
    console.error(e);
    return json(500, { error: 'Something went wrong' });
  }
}

export async function api(event) {
  let body;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    return json(400, { error: 'Body must be JSON' });
  }
  return route(await getService(), {
    method: event.requestContext.http.method,
    path: event.rawPath,
    body,
    headers: event.headers ?? {},
  });
}

export async function sweeper() {
  const result = await (await getService()).releaseExpired();
  console.log(JSON.stringify({ msg: 'released expired seats', ...result }));
  return result;
}
