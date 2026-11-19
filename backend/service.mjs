// Business rules for library seats. Pure logic on top of a store, so it runs
// the same in Lambda (DynamoDB) and locally / in tests (in-memory).
import { buildSeats } from './layout.mjs';
import { ConflictError } from './stores.mjs';

const MIN = 60_000;
export const DEFAULTS = {
  sessionMinutes: 120, // a check-in holds the seat for 2 hours, extendable
  breakMinutes: 20, // "back in 20" before the seat is released
  reportMinutes: 15, // reported as unattended -> released in 15 min unless holder confirms
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Web Crypto (globalThis.crypto) works in Node 20+ and in browsers, so the same
// rules can also run client-side for the GitHub Pages demo.
async function hashId(rollNo) {
  const data = new TextEncoder().encode(String(rollNo).trim().toUpperCase());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const isHeld = (s, now) => s.token && s.expiresAt > now;

function freeSeat(s) {
  const { token, holderHash, since, expiresAt, reports, ...rest } = s;
  return { ...rest, status: 'free' };
}

// What clients get to see: never the token or the holder's identity.
export function publicView(s, now = Date.now()) {
  const held = isHeld(s, now);
  return {
    seatId: s.seatId,
    floor: s.floor,
    zone: s.zone,
    hasPower: !!s.hasPower,
    status: held ? s.status : 'free',
    since: held ? s.since : undefined,
    expiresAt: held ? s.expiresAt : undefined,
    reported: held && (s.reports ?? 0) > 0,
  };
}

export function createService(store, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const clock = opts.now ?? (() => Date.now());

  async function load(seatId) {
    const s = await store.get(seatId);
    if (!s) throw new HttpError(404, `Seat ${seatId} does not exist`);
    return s;
  }

  async function write(next, prev) {
    await store.save({ ...next, version: (prev.version ?? 0) + 1 }, prev.version ?? 0);
  }

  function requireHolder(s, token, now) {
    if (!isHeld(s, now)) throw new HttpError(409, 'This seat is not checked in any more');
    if (!token || token !== s.token) throw new HttpError(403, 'Only the student holding this seat can do that');
  }

  return {
    async listSeats() {
      const now = clock();
      const seats = (await store.list()).map((s) => publicView(s, now));
      return seats.sort((a, b) => a.seatId.localeCompare(b.seatId));
    },

    async stats() {
      const seats = await this.listSeats();
      const zones = {};
      for (const s of seats) {
        const z = (zones[s.zone] ??= { floor: s.floor, zone: s.zone, total: 0, free: 0, away: 0 });
        z.total++;
        if (s.status === 'free') z.free++;
        if (s.status === 'away') z.away++;
      }
      const total = seats.length;
      const free = seats.filter((s) => s.status === 'free').length;
      return { total, free, occupancyPct: total ? Math.round(((total - free) / total) * 100) : 0, zones: Object.values(zones) };
    },

    async checkIn(seatId, rollNo) {
      if (!rollNo || !/^[A-Za-z0-9\-/]{3,20}$/.test(String(rollNo).trim())) {
        throw new HttpError(400, 'Enter a valid roll / ID number');
      }
      const now = clock();
      const holderHash = await hashId(rollNo);

      // One seat per student: refuse if this roll number already holds a seat.
      const existing = (await store.list()).find((s) => isHeld(s, now) && s.holderHash === holderHash);
      if (existing) {
        throw new HttpError(409, `You already hold seat ${existing.seatId}. Leave it before taking another.`);
      }

      const s = await load(seatId);
      if (isHeld(s, now)) throw new HttpError(409, `Seat ${seatId} is already taken`);

      const token = newToken();
      const next = {
        ...freeSeat(s),
        status: 'occupied',
        token,
        holderHash,
        since: now,
        expiresAt: now + cfg.sessionMinutes * MIN,
        reports: 0,
      };
      await write(next, s);
      return { token, seat: publicView(next, now) };
    },

    async extend(seatId, token) {
      const now = clock();
      const s = await load(seatId);
      requireHolder(s, token, now);
      const next = { ...s, status: 'occupied', expiresAt: now + cfg.sessionMinutes * MIN, reports: 0 };
      await write(next, s);
      return { seat: publicView(next, now) };
    },

    async takeBreak(seatId, token) {
      const now = clock();
      const s = await load(seatId);
      requireHolder(s, token, now);
      const next = { ...s, status: 'away', expiresAt: now + cfg.breakMinutes * MIN };
      await write(next, s);
      return { seat: publicView(next, now) };
    },

    async checkOut(seatId, token) {
      const now = clock();
      const s = await load(seatId);
      requireHolder(s, token, now);
      const next = freeSeat(s);
      await write(next, s);
      return { seat: publicView(next, now) };
    },

    // Anyone can flag a seat that is "held" by a bag with nobody around.
    // The hold is cut to reportMinutes; the holder clears it by extending.
    async report(seatId) {
      const now = clock();
      const s = await load(seatId);
      if (!isHeld(s, now)) throw new HttpError(409, 'That seat is already free, go ahead and take it');
      const next = {
        ...s,
        reports: (s.reports ?? 0) + 1,
        expiresAt: Math.min(s.expiresAt, now + cfg.reportMinutes * MIN),
      };
      await write(next, s);
      return { seat: publicView(next, now) };
    },

    // Runs on a schedule: releases every seat whose hold has run out.
    async releaseExpired() {
      const now = clock();
      let released = 0;
      for (const s of await store.list()) {
        if (s.token && s.expiresAt <= now) {
          try {
            await write(freeSeat(s), s);
            released++;
          } catch (e) {
            if (!(e instanceof ConflictError)) throw e; // someone acted on it meanwhile: fine
          }
        }
      }
      return { released };
    },

    // Creates seats from the layout. Existing seats are left untouched.
    async seed() {
      let created = 0;
      for (const seat of buildSeats()) {
        try {
          await store.save(seat, null);
          created++;
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
        }
      }
      return { created };
    },
  };
}
