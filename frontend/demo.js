// Demo mode for static hosting (GitHub Pages): runs the real SeatSpot rules
// (backend/service.mjs + the same API router) inside the browser, keeps state in
// localStorage, and simulates other students so the library feels alive.
// On AWS the app talks to API Gateway + Lambda + DynamoDB instead.
const STATE_KEY = 'seatspot.demo.seats.v1';
const BOTS_KEY = 'seatspot.demo.bots.v1';

const load = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};
const save = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
};

export async function createDemoApi(backendBase) {
  const [{ route }, { createService }, { memoryStore }] = await Promise.all([
    import(`${backendBase}/handler.mjs`),
    import(`${backendBase}/service.mjs`),
    import(`${backendBase}/stores.mjs`),
  ]);

  const saved = load(STATE_KEY, null);
  const mem = memoryStore(saved ?? []);
  const persist = async () => save(STATE_KEY, await mem.list());
  const store = { ...mem, async save(item, prev) { await mem.save(item, prev); await persist(); } };
  const service = createService(store);
  await service.seed();

  // Simulated students: seatId -> token
  const bots = new Map(Object.entries(load(BOTS_KEY, {})));
  const saveBots = () => save(BOTS_KEY, Object.fromEntries(bots));
  let botNo = Number(load('seatspot.demo.botno', 0));
  const nextRoll = () => { botNo++; save('seatspot.demo.botno', botNo); return `DEMO${botNo}`; };

  async function botCheckIn(seatId) {
    try {
      const { token } = await service.checkIn(seatId, nextRoll());
      bots.set(seatId, token);
    } catch { /* seat got taken meanwhile */ }
  }

  if (!saved) {
    // First visit: fill roughly a third of the library.
    const seats = await service.listSeats();
    for (const s of seats) if (Math.random() < 0.34) await botCheckIn(s.seatId);
    for (const [id, token] of [...bots].slice(0, 5)) await service.takeBreak(id, token).catch(() => {});
    saveBots();
  }

  async function tick() {
    await service.releaseExpired();
    const seats = await service.listSeats();
    for (const [id] of bots) if (seats.find((s) => s.seatId === id)?.status === 'free') bots.delete(id);
    const free = seats.filter((s) => s.status === 'free');
    const roll = Math.random();
    const botIds = [...bots.keys()];
    if (roll < 0.45 && free.length > 8) {
      await botCheckIn(free[Math.floor(Math.random() * free.length)].seatId);
    } else if (roll < 0.8 && botIds.length) {
      const id = botIds[Math.floor(Math.random() * botIds.length)];
      await service.checkOut(id, bots.get(id)).catch(() => {});
      bots.delete(id);
    } else if (botIds.length) {
      const id = botIds[Math.floor(Math.random() * botIds.length)];
      const s = seats.find((x) => x.seatId === id);
      await (s?.status === 'away' ? service.extend(id, bots.get(id)) : service.takeBreak(id, bots.get(id))).catch(() => {});
    }
    saveBots();
  }
  setInterval(tick, 7000);

  return async function call(path, { method = 'GET', body, token } = {}) {
    const r = await route(service, { method, path, body, headers: token ? { 'x-seat-token': token } : {} });
    const data = JSON.parse(r.body);
    if (r.statusCode >= 400) throw Object.assign(new Error(data.error ?? 'Request failed'), { status: r.statusCode });
    return data;
  };
}

export async function resetDemo() {
  for (const k of [STATE_KEY, BOTS_KEY, 'seatspot.demo.botno', 'seatspot.mine']) {
    try { localStorage.removeItem(k); } catch {}
  }
}
