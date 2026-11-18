// SeatSpot front end. Talks to the API under /api (same origin via CloudFront).
const API = window.SEATSPOT_API ?? '/api';
const REFRESH_MS = 10_000;
const MINE_KEY = 'seatspot.mine';
const SESSION_MIN = { occupied: 120, away: 20, reported: 15 };
const ZONE_ICONS = [
  [/silent|reading/i, '📖'], [/group/i, '👥'], [/digital|pc|computer/i, '💻'],
  [/news|magazine/i, '📰'], [/reference/i, '📚'],
];

const $ = (sel) => document.querySelector(sel);
const state = { seats: [], floor: null, powerOnly: false, offset: 0, prev: new Map(), loaded: false };

// ---------- my seat (token kept only on this phone) ----------
function getMine() {
  try { return JSON.parse(localStorage.getItem(MINE_KEY)) ?? null; } catch { return null; }
}
function setMine(v) {
  try { v ? localStorage.setItem(MINE_KEY, JSON.stringify(v)) : localStorage.removeItem(MINE_KEY); } catch {}
}

// ---------- api ----------
async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-seat-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status });
  return data;
}

async function refresh() {
  try {
    const { seats, now } = await call('/seats');
    state.prev = new Map(state.seats.map((s) => [s.seatId, s.status]));
    state.seats = seats;
    state.offset = now - Date.now(); // keep countdowns in step with the server clock
    reconcileMine();
    render();
    $('#live').classList.remove('off');
    $('#updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  } catch (e) {
    $('#live').classList.add('off');
    $('#updated').textContent = `Offline: ${e.message}`;
  }
}

// If my seat was released (timer ran out / someone else has it), forget it.
function reconcileMine() {
  const mine = getMine();
  if (!mine) return;
  const s = state.seats.find((x) => x.seatId === mine.seatId);
  if (!s || s.status === 'free' || (s.since && s.since !== mine.since)) {
    setMine(null);
    toast(`Seat ${mine.seatId} was released`);
  }
}

// ---------- helpers ----------
const FLOOR_ORDER = ['Basement', 'Ground', 'First', 'Second', 'Third', 'Fourth'];
const rank = (f) => (FLOOR_ORDER.indexOf(f) + 1 || 99);
const floors = () => [...new Set(state.seats.map((s) => s.floor))].sort((a, b) => rank(a) - rank(b));
const now = () => Date.now() + state.offset;
const mins = (ms) => Math.max(0, Math.ceil(ms / 60_000));
const isFree = (s) => s.status === 'free';
const zoneIcon = (z) => (ZONE_ICONS.find(([re]) => re.test(z)) ?? [null, '🪑'])[1];
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function level(free, total) {
  const r = total ? free / total : 0;
  if (r >= 0.5) return ['plenty', 'Plenty of seats'];
  if (r >= 0.2) return ['filling', 'Filling up'];
  return ['full', free ? 'Almost full' : 'Full'];
}

// Zone with the most free seats (respecting the power filter).
function bestZone() {
  const zones = new Map();
  for (const s of state.seats) {
    if (!isFree(s) || (state.powerOnly && !s.hasPower)) continue;
    const k = `${s.floor}|${s.zone}`;
    zones.set(k, [...(zones.get(k) ?? []), s]);
  }
  let best = null;
  for (const [k, list] of zones) if (!best || list.length > best[1].length) best = [k, list];
  return best && { floor: best[1][0].floor, zone: best[1][0].zone, seats: best[1] };
}

// ---------- rendering ----------
function render() {
  const all = state.seats;
  const free = all.filter(isFree).length;
  const away = all.filter((s) => s.status === 'away').length;
  const total = all.length;
  $('#freeCount').textContent = free;
  $('#totalCount').textContent = total;
  $('#cFree').textContent = free;
  $('#cTaken').textContent = total - free - away;
  $('#cAway').textContent = away;
  const pct = total ? (free / total) * 100 : 0;
  const ring = $('#ringFg');
  ring.style.strokeDasharray = `${pct} 100`;
  ring.style.stroke = pct >= 50 ? '#5eead4' : pct >= 20 ? '#fcd34d' : '#fca5a5';
  $('#headline').textContent =
    !total ? 'No seats set up yet' : pct >= 50 ? 'Plenty of space right now' : pct >= 20 ? 'Filling up, grab a seat soon' : free ? 'Almost full, a few seats left' : 'Library is full right now';

  const best = bestZone();
  const mine = getMine();
  const bestBtn = $('#bestBtn');
  bestBtn.disabled = !best || !!mine;
  $('#bestHint').textContent = mine
    ? `You're at ${mine.seatId}`
    : best ? `Most room: ${best.zone}, ${best.floor} floor (${best.seats.length} free)` : 'No free seats match right now';

  const fl = floors();
  if (!fl.includes(state.floor)) state.floor = fl[0];
  $('#floorTabs').innerHTML = fl
    .map((f) => {
      const fs = all.filter((s) => s.floor === f);
      const ff = fs.filter(isFree).length;
      return `<button class="tab" role="tab" data-floor="${esc(f)}" aria-selected="${f === state.floor}">${esc(f)}<small>${ff}/${fs.length}</small></button>`;
    })
    .join('');

  const zones = new Map();
  for (const s of all.filter((s) => s.floor === state.floor)) {
    if (!zones.has(s.zone)) zones.set(s.zone, []);
    zones.get(s.zone).push(s);
  }

  const main = $('#zones');
  main.setAttribute('aria-busy', 'false');
  if (!total) {
    main.innerHTML = `<p class="empty">No seats yet. Run the deploy script to seed them.</p>`;
    return;
  }
  main.innerHTML = [...zones]
    .map(([zone, seats], i) => {
      const zf = seats.filter(isFree).length;
      const [cls, label] = level(zf, seats.length);
      const shown = state.powerOnly ? seats.filter((s) => s.hasPower) : seats;
      const wide = seats.length > 16 ? ' wide' : '';
      return `<section class="zone${wide}" style="animation-delay:${i * 50}ms">
        <div class="zone-head">
          <span class="zone-icon" aria-hidden="true">${zoneIcon(zone)}</span>
          <div class="zone-title"><h3>${esc(zone)}</h3><p class="zone-sub">${zf} of ${seats.length} free · ${seats.filter((s) => s.hasPower).length} with power</p></div>
          <span class="badge ${cls}">${label}</span>
        </div>
        <div class="bar"><i style="width:${(zf / seats.length) * 100}%"></i></div>
        <div class="grid">${shown.map((s) => seatBtn(s, mine)).join('') || '<span class="empty">No power-socket seats here</span>'}</div>
      </section>`;
    })
    .join('');
  renderMine();
  state.loaded = true;
}

function seatBtn(s, mine) {
  const short = s.seatId.split('-').pop();
  const isMine = mine?.seatId === s.seatId;
  const justFreed = state.loaded && isFree(s) && state.prev.get(s.seatId) && state.prev.get(s.seatId) !== 'free';
  const cls = ['seat', s.status, s.reported && 'reported', isMine && 'mine', justFreed && 'flash'].filter(Boolean).join(' ');
  const sub = isMine ? 'you' : s.status === 'away' ? `${mins(s.expiresAt - now())}m` : s.status === 'occupied' ? 'taken' : 'free';
  const label = `Seat ${s.seatId}, ${isMine ? 'your seat' : s.status}${s.hasPower ? ', has power socket' : ''}`;
  return `<button class="${cls}" data-seat="${esc(s.seatId)}" aria-label="${esc(label)}">${s.hasPower ? '<span class="pwr" aria-hidden="true">⚡</span>' : ''}${esc(short)}<small>${sub}</small></button>`;
}

function renderMine() {
  const mine = getMine();
  const s = mine && state.seats.find((x) => x.seatId === mine.seatId);
  const box = $('#mySeat');
  box.hidden = !s;
  if (!s) return;
  const kind = s.reported ? 'reported' : s.status;
  box.className = `my-seat ${kind}`;
  $('#myId').textContent = `${s.seatId} · ${s.zone}`;
  const left = mins(s.expiresAt - now());
  const totalMin = SESSION_MIN[kind] ?? 120;
  $('#timerMin').textContent = left >= 60 ? `${Math.floor(left / 60)}h${String(left % 60).padStart(2, '0')}` : `${left}m`;
  $('#timerFg').style.strokeDasharray = `${Math.min(100, (left / totalMin) * 100)} 100`;
  $('#myTimer').textContent =
    s.status === 'away'
      ? `On a break. Tap “I'm still here” within ${left} min or the seat is released.`
      : s.reported
        ? `Someone reported this seat as empty. Confirm within ${left} min.`
        : `Held for ${left} more min. Extend any time.`;
  box.querySelector('[data-act="break"]').hidden = s.status === 'away';
}

// ---------- dialog ----------
function openSeat(seatId) {
  const s = state.seats.find((x) => x.seatId === seatId);
  if (!s) return toast(`Seat ${seatId} not found`);
  const mine = getMine();
  const dlg = $('#seatDialog');
  const isMine = mine?.seatId === s.seatId;
  const badge = $('#dlgBadge');
  badge.className = `dlg-badge ${isMine ? 'mine' : s.status}`;
  badge.textContent = isMine ? 'Your seat' : { free: 'Free', occupied: 'Taken', away: 'On a break' }[s.status];
  $('#dlgTitle').textContent = `Seat ${s.seatId}`;
  $('#dlgMeta').textContent = `${s.floor} floor · ${s.zone}${s.hasPower ? ' · ⚡ power socket' : ''}`;
  $('#dlgError').textContent = '';
  const body = $('#dlgBody');
  const actions = $('#dlgActions');

  if (isMine) {
    body.innerHTML = `<p>This is your seat. Manage it from the card at the top of the screen.</p>`;
    actions.innerHTML = `<button class="btn" value="close">OK</button>`;
  } else if (isFree(s)) {
    if (mine) {
      body.innerHTML = `<p>You're already holding <b>${esc(mine.seatId)}</b>. Leave it first to take this one.</p>`;
      actions.innerHTML = `<button class="btn secondary" value="close">Close</button>`;
    } else {
      body.innerHTML = `<label>Roll / ID number
          <input id="rollNo" name="rollNo" autocomplete="off" required minlength="3" maxlength="20" placeholder="e.g. 22CE1045" />
          <span class="hint">Only used to stop one person holding several seats. Stored as a one-way hash.</span>
        </label>`;
      const saved = (() => { try { return localStorage.getItem('seatspot.roll') ?? ''; } catch { return ''; } })();
      body.querySelector('input').value = saved;
      actions.innerHTML = `<button class="btn secondary" value="close" formnovalidate>Cancel</button><button class="btn" value="checkin" data-do="checkin">Check in for 2 hours</button>`;
    }
  } else {
    const left = mins(s.expiresAt - now());
    const what = s.status === 'away'
      ? `On a break. Frees up in <b>${left} min</b> unless the student comes back.`
      : `Taken since ${new Date(s.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
    body.innerHTML = `<p>${what}</p><p class="muted">Only a bag on the seat and nobody around? Report it. It frees up in 15 min unless the student confirms they're here.</p>`;
    actions.innerHTML = `<button class="btn secondary" value="close">Close</button>${s.reported ? '' : '<button class="btn warn" value="report" data-do="report">Report as empty</button>'}`;
  }

  dlg.dataset.seat = s.seatId;
  dlg.showModal();
}

$('#seatForm').addEventListener('submit', async (ev) => {
  const btn = ev.submitter;
  const what = btn?.dataset.do;
  if (!what) return; // plain close
  ev.preventDefault();
  const seatId = $('#seatDialog').dataset.seat;
  btn.disabled = true;
  try {
    if (what === 'checkin') {
      const rollNo = $('#rollNo').value.trim();
      const r = await call(`/seats/${seatId}/checkin`, { method: 'POST', body: { rollNo } });
      try { localStorage.setItem('seatspot.roll', rollNo); } catch {}
      setMine({ seatId, token: r.token, since: r.seat.since });
      toast(`You're checked in at ${seatId}. Happy studying!`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (what === 'report') {
      await call(`/seats/${seatId}/report`, { method: 'POST' });
      toast(`Thanks! ${seatId} frees up in 15 min if nobody's there`);
    }
    $('#seatDialog').close();
    await refresh();
  } catch (e) {
    $('#dlgError').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

// Close the sheet when tapping the backdrop.
$('#seatDialog').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });

// ---------- my-seat actions ----------
$('#mySeat').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-act]');
  const act = btn?.dataset.act;
  const mine = getMine();
  if (!act || !mine) return;
  if (act === 'checkout' && !confirm(`Leave seat ${mine.seatId}?`)) return;
  btn.disabled = true;
  try {
    await call(`/seats/${mine.seatId}/${act}`, { method: 'POST', token: mine.token });
    if (act === 'checkout') { setMine(null); toast('Seat released. Thanks for freeing it up!'); }
    if (act === 'extend') toast('Got it, your seat is held for another 2 hours');
    if (act === 'break') toast('Enjoy your break! Be back within 20 min');
  } catch (e) {
    if (e.status === 403 || e.status === 409) setMine(null);
    toast(e.message);
  } finally {
    btn.disabled = false;
    await refresh();
  }
});

// ---------- misc ----------
$('#bestBtn').addEventListener('click', () => {
  const best = bestZone();
  if (!best) return toast('No free seats right now');
  const pick = best.seats[Math.floor(Math.random() * best.seats.length)];
  state.floor = pick.floor;
  render();
  document.querySelector(`[data-seat="${pick.seatId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  openSeat(pick.seatId);
});
$('#zones').addEventListener('click', (ev) => {
  const id = ev.target.closest('[data-seat]')?.dataset.seat;
  if (id) openSeat(id);
});
$('#floorTabs').addEventListener('click', (ev) => {
  const f = ev.target.closest('[data-floor]')?.dataset.floor;
  if (f) { state.floor = f; render(); }
});
$('#powerOnly').addEventListener('change', (ev) => { state.powerOnly = ev.target.checked; render(); });

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// Boot: load seats, then honour ?seat=ID from a desk QR code.
await refresh();
const deep = new URLSearchParams(location.search).get('seat');
if (deep) {
  const s = state.seats.find((x) => x.seatId === deep);
  if (s) { state.floor = s.floor; render(); openSeat(deep); }
  history.replaceState(null, '', location.pathname);
}
setInterval(refresh, REFRESH_MS);
setInterval(renderMine, 15_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
