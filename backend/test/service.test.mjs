import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService, HttpError } from '../src/service.mjs';
import { memoryStore } from '../src/stores.mjs';
import { route } from '../src/handler.mjs';

const MIN = 60_000;
async function setup() {
  let t = Date.UTC(2026, 10, 18, 10);
  const clock = { now: () => t, advance: (m) => (t += m * MIN) };
  const svc = createService(memoryStore(), { now: clock.now });
  await svc.seed();
  return { svc, clock };
}

test('seed creates seats once', async () => {
  const { svc } = await setup();
  const seats = await svc.listSeats();
  assert.equal(seats.length, 62);
  assert.ok(seats.every((s) => s.status === 'free'));
  assert.deepEqual(await svc.seed(), { created: 0 });
});

test('check in hides token and identity from the public list', async () => {
  const { svc } = await setup();
  const { token, seat } = await svc.checkIn('G-R01', '22ce1045');
  assert.ok(token.length > 10);
  assert.equal(seat.status, 'occupied');
  const pub = (await svc.listSeats()).find((s) => s.seatId === 'G-R01');
  assert.equal(pub.status, 'occupied');
  assert.equal(pub.token, undefined);
  assert.equal(pub.holderHash, undefined);
});

test('a taken seat cannot be taken again, and one student holds one seat', async () => {
  const { svc } = await setup();
  await svc.checkIn('G-R01', 'A123');
  await assert.rejects(svc.checkIn('G-R01', 'B456'), { status: 409 });
  await assert.rejects(svc.checkIn('G-R02', 'a123'), /already hold seat G-R01/);
});

test('only the holder can extend, break or leave', async () => {
  const { svc } = await setup();
  const { token } = await svc.checkIn('G-R01', 'A123');
  await assert.rejects(svc.checkOut('G-R01', 'wrong'), { status: 403 });
  await assert.rejects(svc.extend('G-R01'), { status: 403 });
  const r = await svc.takeBreak('G-R01', token);
  assert.equal(r.seat.status, 'away');
  await svc.checkOut('G-R01', token);
  const pub = (await svc.listSeats()).find((s) => s.seatId === 'G-R01');
  assert.equal(pub.status, 'free');
  await svc.checkIn('G-R02', 'A123'); // free to take another now
});

test('holds expire and the sweeper releases them', async () => {
  const { svc, clock } = await setup();
  const { token } = await svc.checkIn('G-R01', 'A123');
  await svc.takeBreak('G-R01', token);
  clock.advance(21);
  // shown as free right away even before the sweeper runs
  assert.equal((await svc.listSeats()).find((s) => s.seatId === 'G-R01').status, 'free');
  await assert.rejects(svc.extend('G-R01', token), { status: 409 });
  assert.deepEqual(await svc.releaseExpired(), { released: 1 });
  await svc.checkIn('G-R01', 'B456');
});

test('reporting cuts the hold to 15 minutes; extending clears it', async () => {
  const { svc, clock } = await setup();
  const { token } = await svc.checkIn('G-R01', 'A123');
  const r = await svc.report('G-R01');
  assert.equal(r.seat.reported, true);
  clock.advance(10);
  const ext = await svc.extend('G-R01', token);
  assert.equal(ext.seat.reported, false);
  clock.advance(100);
  assert.equal((await svc.listSeats()).find((s) => s.seatId === 'G-R01').status, 'occupied');
  await assert.rejects(svc.report('G-R05'), { status: 409 });
});

test('validation and unknown seats', async () => {
  const { svc } = await setup();
  await assert.rejects(svc.checkIn('G-R01', ''), HttpError);
  await assert.rejects(svc.checkIn('G-R01', 'x; drop table'), { status: 400 });
  await assert.rejects(svc.checkIn('NOPE', 'A123'), { status: 404 });
});

test('stats summarise per zone', async () => {
  const { svc } = await setup();
  await svc.checkIn('F2-D01', 'A123');
  const st = await svc.stats();
  assert.equal(st.total, 62);
  assert.equal(st.free, 61);
  assert.equal(st.zones.find((z) => z.zone === 'Digital Library (PCs)').free, 11);
});

test('router: /api prefix, token header, errors, admin key', async () => {
  const { svc } = await setup();
  const call = (method, path, body, headers = {}) => route(svc, { method, path, body, headers });
  assert.equal((await call('GET', '/api/seats')).statusCode, 200);
  assert.equal((await call('GET', '/seats')).statusCode, 200);
  const ci = await call('POST', '/api/seats/G-R03/checkin', { rollNo: 'Z999' });
  const { token } = JSON.parse(ci.body);
  assert.equal((await call('POST', '/api/seats/G-R03/checkout', undefined, { 'x-seat-token': 'bad' })).statusCode, 403);
  assert.equal((await call('POST', '/api/seats/G-R03/checkout', undefined, { 'x-seat-token': token })).statusCode, 200);
  assert.equal((await call('GET', '/api/nothing')).statusCode, 404);
  delete process.env.ADMIN_KEY;
  assert.equal((await call('POST', '/api/admin/seed', undefined, { 'x-admin-key': '' })).statusCode, 401);
  process.env.ADMIN_KEY = 'secret123';
  assert.equal((await call('POST', '/api/admin/seed', undefined, { 'x-admin-key': 'secret123' })).statusCode, 200);
});
