// SeatSpot front end. Talks to the API under /api (same origin via CloudFront).
const API = window.SEATSPOT_API ?? '/api';
const REFRESH_MS = 10_000;
const MINE_KEY = 'seatspot.mine';

const $ = (sel) => document.querySelector(sel);
const state = { seats: [], floor: null, powerOnly: false, offset: 0 };

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
    state.seats = seats;
    state.offset = now - Date.now(); // keep countdowns in step with the server clock
    reconcileMine();
    render();
    $('#updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  } catch (e) {
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

// ---------- rendering ----------
const FLOOR_ORDER = ['Basement', 'Ground', 'First', 'Second', 'Third', 'Fourth'];
const rank = (f) => (FLOOR_ORDER.indexOf(f) + 1 || 99);
const floors = () => [...new Set(state.seats.map((s) => s.floor))].sort((a, b) => rank(a) - rank(b));
const now = () => Date.now() + state.offset;
const mins = (ms) => Math.max(0, Math.ceil(ms / 60_000));

function render() {
  const all = state.seats;
  const free = all.filter((s) => s.status === 'free').length;
  $('#freeCount').textContent = free;
  $('#totalCount').textContent = all.length;

  const fl = floors();
  if (!fl.includes(state.floor)) state.floor = fl[0];
  $('#floorTabs').innerHTML = fl
    .map((f) => {
      const fs = all.filter((s) => s.floor === f);
      const ff = fs.filter((s) => s.status === 'free').length;
      return `<button class="tab" role="tab" data-floor="${f}" aria-selected="${f === state.floor}">${f}<small>${ff}/${fs.length}</small></button>`;
    })
    .join('');

  const mine = getMine();
  const zones = new Map();
  for (const s of all.filter((s) => s.floor === state.floor)) {
    if (!zones.has(s.zone)) zones.set(s.zone, []);
    zones.get(s.zone).push(s);
  }

  const main = $('#zones');
  main.setAttribute('aria-busy', 'false');
  if (!all.length) {
    main.innerHTML = `<p class="loading">No seats yet. Run the deploy script to seed them.</p>`;
    return;
  }
  main.innerHTML = [...zones]
    .map(([zone, seats]) => {
      const zf = seats.filter((s) => s.status === 'free').length;
      const shown = state.powerOnly ? seats.filter((s) => s.hasPower) : seats;
      return `<section class="zone">
        <div class="zone-head"><h3>${zone}</h3><span class="zone-count">${zf} free / ${seats.length}</span></div>
        <div class="bar"><i style="width:${(zf / seats.length) * 100}%"></i></div>
        <div class="grid">${shown.map((s) => seatBtn(s, mine)).join('') || '<span class="muted">No power-socket seats here</span>'}</div>
      </section>`;
    })
    .join('');
  renderMine();
}

function seatBtn(s, mine) {
  const short = s.seatId.split('-').pop();
  const isMine = mine?.seatId === s.seatId;
  const cls = ['seat', s.status, s.reported && 'reported', isMine && 'mine'].filter(Boolean).join(' ');
  const sub = isMine ? 'you' : s.status === 'away' ? `${mins(s.expiresAt - now())}m` : s.status === 'occupied' ? 'taken' : 'free';
  const label = `Seat ${s.seatId}, ${s.status}${s.hasPower ? ', has power socket' : ''}`;
  return `<button class="${cls}" data-seat="${s.seatId}" aria-label="${label}">${s.hasPower ? '<span class="pwr" aria-hidden="true">⚡</span>' : ''}${short}<small>${sub}</small></button>`;
}

function renderMine() {
  const mine = getMine();
  const s = mine && state.seats.find((x) => x.seatId === mine.seatId);
  const box = $('#mySeat');
  box.hidden = !s;
  if (!s) return;
  $('#myId').textContent = `${s.seatId} · ${s.zone}`;
  const left = mins(s.expiresAt - now());
  $('#myTimer').textContent =
    s.status === 'away'
      ? `On a break — seat is released in ${left} min unless you tap “I'm still here”`
      : s.reported
        ? `Someone reported this seat as unattended — confirm within ${left} min`
        : `Held for ${left} more min`;
  box.querySelector('[data-act="break"]').hidden = s.status === 'away';
}

// ---------- dialog ----------
function openSeat(seatId) {
  const s = state.seats.find((x) => x.seatId === seatId);
  if (!s) return toast(`Seat ${seatId} not found`);
  const mine = getMine();
  const dlg = $('#seatDialog');
  $('#dlgTitle').textContent = `Seat ${s.seatId}`;
  $('#dlgMeta').textContent = `${s.floor} floor · ${s.zone}${s.hasPower ? ' · ⚡ power socket' : ''}`;
  $('#dlgError').textContent = '';
  const body = $('#dlgBody');
  const actions = $('#dlgActions');

  if (mine?.seatId === s.seatId) {
    body.innerHTML = `<p>This is your seat. Manage it from the green bar on the main screen.</p>`;
    actions.innerHTML = `<button class="btn" value="close">OK</button>`;
  } else if (s.status === 'free') {
    if (mine) {
      body.innerHTML = `<p>You're already holding <b>${mine.seatId}</b>. Leave it first to take this one.</p>`;
      actions.innerHTML = `<button class="btn secondary" value="close">Close</button>`;
    } else {
      body.innerHTML = `<label>Roll / ID number
          <input id="rollNo" name="rollNo" autocomplete="off" required minlength="3" maxlength="20" placeholder="e.g. 22CE1045" />
          <span class="hint">Used only to stop one person holding several seats. Stored as a one-way hash.</span>
        </label>`;
      const saved = (() => { try { return localStorage.getItem('seatspot.roll') ?? ''; } catch { return ''; } })();
      body.querySelector('input').value = saved;
      actions.innerHTML = `<button class="btn secondary" value="close" formnovalidate>Cancel</button><button class="btn" value="checkin" data-do="checkin">Check in</button>`;
    }
  } else {
    const left = mins(s.expiresAt - now());
    const what = s.status === 'away' ? `On a break — frees up in ${left} min` : `Taken since ${new Date(s.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    body.innerHTML = `<p>${what}.</p><p class="muted">Seat looks empty with just a bag on it? Report it and it auto-releases in 15 min unless the student confirms they're here.</p>`;
    actions.innerHTML = `<button class="btn secondary" value="close">Close</button>${s.reported ? '' : '<button class="btn warn" value="report" data-do="report">Report unattended</button>'}`;
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
      toast(`Checked in to ${seatId}. Enjoy studying!`);
    } else if (what === 'report') {
      await call(`/seats/${seatId}/report`, { method: 'POST' });
      toast(`Thanks — ${seatId} will free up in 15 min if nobody's there`);
    }
    $('#seatDialog').close();
    await refresh();
  } catch (e) {
    $('#dlgError').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- my-seat actions ----------
$('#mySeat').addEventListener('click', async (ev) => {
  const act = ev.target.closest('[data-act]')?.dataset.act;
  const mine = getMine();
  if (!act || !mine) return;
  if (act === 'checkout' && !confirm(`Leave seat ${mine.seatId}?`)) return;
  ev.target.disabled = true;
  try {
    await call(`/seats/${mine.seatId}/${act}`, { method: 'POST', token: mine.token });
    if (act === 'checkout') { setMine(null); toast('Seat released. Thanks for freeing it up!'); }
    if (act === 'extend') toast('Got it — seat held for another 2 hours');
    if (act === 'break') toast('Enjoy your break! Back within 20 min');
  } catch (e) {
    if (e.status === 403 || e.status === 409) setMine(null);
    toast(e.message);
  } finally {
    ev.target.disabled = false;
    await refresh();
  }
});

// ---------- misc ----------
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
