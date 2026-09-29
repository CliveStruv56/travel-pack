import { html, raw, esc, uid, parseDate, isoDate, hhmm, addDays, daysBetween, fmtDay, fmtLongDay, fmtRange, fmtDuration, fmtUntil, money, fmtBytes, slug } from './util.js';
import { db, takeInbox } from './db.js';
import { icon } from './icons.js';
import {
  STATUS, COST_STATUS, TYPES, typeOf, isTransport, isStay, itemTitle, itemSubtitle, startOf, endOf,
  buildDays, tonight, moments, toBook, costs, liveLinks, stationCode, newTrip, mapsUrl, telHref, whatsappHref,
} from './model.js';
import { tripToIcs, googleCalendarUrl } from './ics.js';
import { shareLink, readShareLink, readAddLink, shareText, exportBundle, parseBundle } from './share.js';

const APP_VERSION = '1.0.0';

/* =====================================================================
   State
   ===================================================================== */

const S = {
  trips: [],
  tripId: null,
  files: [],            // attachments of the current trip (with blobs)
  route: { name: 'today', parts: [] },
  online: navigator.onLine,
  preview: null,        // a trip opened from a share link, not yet saved
  incoming: null,       // bookings opened from an "add booking" link, not yet added
  draft: null,          // item being edited
  inbox: [],            // files shared into the app from other Android apps
  me: '',               // traveller name, used when sharing
  lastBackup: null,
  persisted: null,
  installPrompt: null,
  updateReady: null,
  showWhole: false,     // ticket viewer: whole image vs barcode crop
};

const qs = new URLSearchParams(location.search);
// ?now=2026-10-07T14:00 previews the app as it will look at that moment.
const NOW_OVERRIDE = qs.get('now');
const now = () => (NOW_OVERRIDE ? new Date(NOW_OVERRIDE) : new Date());

const urlCache = new Map();
function fileUrl(f) {
  if (!urlCache.has(f.id)) urlCache.set(f.id, URL.createObjectURL(f.blob));
  return urlCache.get(f.id);
}

const isPreview = () => S.route.name === 'shared';
const trip = () => (isPreview() ? S.preview?.trip : S.trips.find((t) => t.id === S.tripId)) || null;
const readOnly = () => isPreview() || !!trip()?.readOnly;
const itemById = (id) => trip()?.items.find((i) => i.id === id);
const filesFor = (itemId) => S.files.filter((f) => f.itemId === itemId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt.localeCompare(b.createdAt));

/** Tickets for this item plus any on other legs of the same booking. */
function ticketsFor(it) {
  const own = filesFor(it.id);
  if (!it.ref) return { own, related: [] };
  const siblings = trip().items.filter((o) => o.id !== it.id && o.ref && o.ref === it.ref).map((o) => o.id);
  return { own, related: S.files.filter((f) => siblings.includes(f.itemId)) };
}

/* =====================================================================
   Persistence
   ===================================================================== */

async function loadAll() {
  S.trips = (await db.getAll('trips')).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  S.tripId = (await db.get('meta', 'currentTrip')) || null;
  S.me = (await db.get('meta', 'me')) || '';
  S.lastBackup = (await db.get('meta', 'lastBackup')) || null;
  if (!S.trips.find((t) => t.id === S.tripId)) S.tripId = pickDefaultTrip()?.id || null;
  await loadFiles();
}

function pickDefaultTrip() {
  const today = isoDate(now());
  return (
    S.trips.find((t) => t.start <= today && t.end >= today) ||
    S.trips.find((t) => t.start > today) ||
    S.trips[S.trips.length - 1]
  );
}

async function loadFiles() {
  for (const u of urlCache.values()) URL.revokeObjectURL(u);
  urlCache.clear();
  S.files = S.tripId ? await db.byIndex('files', 'tripId', S.tripId) : [];
}

async function saveTrip(t, { quiet } = {}) {
  t.updatedAt = new Date().toISOString();
  await db.put('trips', t);
  const i = S.trips.findIndex((x) => x.id === t.id);
  if (i >= 0) S.trips[i] = t;
  else S.trips.push(t);
  S.trips.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  askPersist();
  if (!quiet) render();
}

async function setCurrentTrip(id) {
  S.tripId = id;
  await db.put('meta', id, 'currentTrip');
  await loadFiles();
}

async function askPersist() {
  if (S.persisted || !navigator.storage?.persist) return;
  try { S.persisted = await navigator.storage.persist(); } catch { /* not fatal */ }
}

/* =====================================================================
   Routing
   ===================================================================== */

const TABS = ['today', 'plan', 'tickets', 'todo', 'more'];

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'today', parts: parts.slice(1) };
}

const go = (path) => { location.hash = '#/' + path; };

async function onRoute() {
  if (location.hash.startsWith('#share=')) {
    try {
      S.preview = await readShareLink(location.hash.slice(1));
      history.replaceState(null, '', '#/shared');
    } catch (e) {
      toast('That share link could not be read. It may have been cut short when it was copied.');
      history.replaceState(null, '', '#/today');
    }
  }
  if (location.hash.startsWith('#add=')) {
    try {
      S.incoming = await readAddLink(location.hash.slice(1));
      history.replaceState(null, '', '#/add');
    } catch (e) {
      toast('That booking link could not be read. It may have been cut short when it was copied.');
      history.replaceState(null, '', '#/today');
    }
  }
  const prev = S.route;
  S.route = parseRoute();
  if (S.route.name === 'add' && !S.incoming) { history.replaceState(null, '', '#/today'); S.route = parseRoute(); }
  if (S.route.name === 'shared' && !S.preview) { history.replaceState(null, '', '#/today'); S.route = parseRoute(); }
  if (S.route.name === 'inbox') await refreshInbox();
  if (S.route.name !== 'edit' && S.route.name !== 'new') S.draft = null;
  if (S.route.name !== 'ticket') releaseWakeLock();
  closeSheet();
  render();
  const samePage = prev.name === S.route.name && prev.parts.join('/') === S.route.parts.join('/');
  if (!samePage) {
    window.scrollTo(0, 0);
    if (S.route.name === 'plan') scrollToDay(S.pendingDay || isoDate(now()));
    S.pendingDay = null;
    if (S.route.name === 'ticket') requestWakeLock();
  }
}

function scrollToDay(date) {
  const el = document.getElementById('day-' + date);
  if (el) requestAnimationFrame(() => window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 70 }));
}

/* =====================================================================
   Rendering
   ===================================================================== */

const root = document.getElementById('app');

function render() {
  const r = S.route;
  const t = trip();
  let body;
  try {
    body = VIEWS[r.name] ? VIEWS[r.name](t, r.parts) : VIEWS.today(t);
  } catch (e) {
    console.error(e);
    body = html`<div class="page"><div class="empty">${icon('alert')}<h2>Something went wrong</h2><p>${e.message}</p><a class="btn" href="#/today">Back to Today</a></div></div>`;
  }
  const tab = TABS.includes(r.name) || (r.name === 'shared' && !r.parts.length);
  root.innerHTML = String(html`${body}${tab && r.name !== 'shared' ? navBar() : ''}`);
  root.classList.toggle('has-nav', tab && r.name !== 'shared');
  document.title = t ? `${t.name} · Travel Pack` : 'Travel Pack';
  hydrate();
}

/** Things innerHTML can't do: draw barcode crops. */
function hydrate() {
  document.querySelectorAll('canvas[data-crop]').forEach((c) => {
    const f = S.files.find((x) => x.id === c.dataset.crop) || S.inboxFiles?.find((x) => x.id === c.dataset.crop);
    if (f) drawCrop(c, f);
  });
}

function navBar() {
  const t = trip();
  const badge = t && !t.readOnly ? (t.checklist || []).filter((c) => !c.done).length + toBook(t).length : 0;
  const tabs = [
    ['today', 'sun', 'Today'], ['plan', 'calendar', 'Plan'], ['tickets', 'ticket', 'Tickets'],
    ['todo', 'checklist', 'To-do'], ['more', 'menu', 'More'],
  ];
  return html`<nav class="nav" aria-label="Main">${tabs.map(([k, ic, label]) => html`
    <a href="#/${k}" class="${S.route.name === k ? 'on' : ''}" ${S.route.name === k ? raw('aria-current="page"') : ''}>
      <span class="nav-ic">${icon(ic)}${k === 'todo' && badge ? html`<b class="badge">${badge}</b>` : ''}</span>${label}</a>`)}</nav>`;
}

function topBar(t) {
  return html`<header class="top">
    <a class="trip-switch" href="#/trips" aria-label="Switch trip">
      <span class="top-name">${t ? t.name : 'Travel Pack'}</span>
      ${t ? html`<span class="top-dates">${fmtRange(t.start, t.end)} ${icon('down', 'sm')}</span>` : ''}
    </a>
    ${netPill()}
  </header>`;
}

const netPill = () => (S.online ? '' : html`<span class="pill offline" title="Everything is saved on this phone">${icon('offline', 'sm')} Offline</span>`);

function subBar(title, back = 'plan', right = '') {
  return html`<header class="top sub">
    <a class="icon-btn" href="${back.startsWith('#') ? back : '#/' + back}" data-act="back" aria-label="Back">${icon('left')}</a>
    <h1>${title}</h1>
    <div class="top-right">${netPill()}${right}</div>
  </header>`;
}

const chip = (status) => html`<span class="chip st-${status || 'confirmed'}">${(STATUS[status] || STATUS.confirmed).label}</span>`;

function roBanner(t) {
  if (!t?.readOnly && !isPreview()) return '';
  if (isPreview() && S.preview.editable) return html`<div class="banner info">${icon('download', 'sm')}<div><b>Your trip, ready to load</b><span>Save it to keep it on this phone. You can edit it afterwards.</span></div></div>`;
  const who = isPreview() ? S.preview.from : t.sharedFrom;
  const at = isPreview() ? S.preview.sharedAt : t.sharedAt;
  return html`<div class="banner info">${icon('lock', 'sm')}<div><b>Read-only copy${who ? ` from ${who}` : ''}</b>
    <span>Shared ${at ? fmtDay(isoDate(new Date(at))) : ''}. Open a newer link to update it.</span></div></div>`;
}

/* ---------- entry cards (Plan, Today, shared preview) ---------- */

function entryHref(it) {
  return isPreview() ? `#/shared/item/${it.id}` : `#/item/${it.id}`;
}

function ticketCount(it) {
  if (isPreview()) return '';
  const n = ticketsFor(it).own.length;
  return n ? html`<span class="meta-i">${icon('ticket', 'sm')} ${n}</span>` : '';
}

function entryCard(e, opts = {}) {
  if (e.kind === 'gap') {
    return html`<div class="gap ${e.connection ? 'conn' : ''}">${icon('clock', 'sm')}<span>${[fmtDuration(e.ms), e.connection ? 'connection' : '', e.place ? `${e.connection ? 'at' : 'in'} ${e.place}` : ''].filter(Boolean).join(' ')}</span></div>`;
  }
  const it = e.item;
  const cls = `t-${it.type} ${it.status === 'cancelled' ? 'cancelled' : ''} ${opts.hero ? 'hero' : ''}`;
  if (e.kind === 'night') {
    return html`<a class="slim" href="${entryHref(it)}">${icon('moon', 'sm')}<span>Night ${e.night} of ${e.nights} · <b>${itemTitle(it)}</b></span>${icon('right', 'sm dim')}</a>`;
  }
  if (e.kind === 'checkout') {
    const verb = it.type === 'hotel' ? 'Check out' : `Leave ${itemTitle(it)}`;
    return html`<a class="slim" href="${entryHref(it)}">${icon(typeOf(it).icon, 'sm')}<span>${verb}${it.endTime ? html` <b>by ${it.endTime}</b>` : ''}${it.type === 'hotel' ? html` · ${itemTitle(it)}` : ''}</span>${icon('right', 'sm dim')}</a>`;
  }
  if (e.kind === 'checkin') {
    const T = typeOf(it);
    return html`<a class="card entry ${cls}" href="${entryHref(it)}">
      <div class="entry-top"><span class="tile">${icon(T.icon)}</span>
        <span class="entry-kicker">${it.type === 'hotel' ? 'Check in' : 'Staying'}${it.time ? ` · from ${it.time}` : ''}</span>${chip(it.status)}</div>
      <div class="entry-title">${itemTitle(it)}</div>
      ${itemSubtitle(it) ? html`<div class="entry-sub">${itemSubtitle(it)}</div>` : ''}
      <div class="meta">
        ${e.nights ? html`<span class="meta-i">${icon('moon', 'sm')} ${e.nights} night${e.nights === 1 ? '' : 's'}</span>` : ''}
        ${it.ref ? html`<span class="meta-i mono">${it.ref}</span>` : ''}
        ${it.cost?.status === 'due' && it.cost.amount ? html`<span class="meta-i warn">${icon('coin', 'sm')} ${money(it.cost.amount)} to pay</span>` : ''}
        ${ticketCount(it)}
      </div></a>`;
  }
  // transport / other
  const T = typeOf(it);
  const start = startOf(it), end = endOf(it);
  const dur = start && end && it.time && it.endTime ? fmtDuration(end - start) : '';
  const nextDay = it.endDate && it.endDate !== it.date;
  if (!isTransport(it)) {
    return html`<a class="card entry ${cls}" href="${entryHref(it)}">
      <div class="entry-top"><span class="tile">${icon(T.icon)}</span><span class="entry-kicker">${it.time || 'Time TBC'}${it.endTime ? `–${it.endTime}` : ''}</span>${chip(it.status)}</div>
      <div class="entry-title">${itemTitle(it)}</div>
      ${it.address ? html`<div class="entry-sub">${it.address}</div>` : ''}
      <div class="meta">${it.ref ? html`<span class="meta-i mono">${it.ref}</span>` : ''}${ticketCount(it)}</div></a>`;
  }
  return html`<a class="card entry ${cls}" href="${entryHref(it)}">
    <div class="entry-top"><span class="tile">${icon(T.icon)}</span>
      <span class="entry-kicker">${itemSubtitle(it) || T.label}</span>${chip(it.status)}</div>
    <div class="route">
      <div class="end-a"><b class="time">${it.time || '––:––'}</b><span class="place">${it.from || '—'}</span></div>
      <div class="route-line"><span>${dur}</span></div>
      <div class="end-b"><b class="time">${it.endTime || '––:––'}${nextDay ? html`<sup>+1</sup>` : ''}</b><span class="place">${it.to || '—'}</span></div>
    </div>
    ${!it.time && it.status !== 'cancelled' ? html`<div class="entry-note">${it.status === 'tobook' ? 'Service and time to choose' : 'Time to confirm'}</div>` : ''}
    <div class="meta">
      ${it.seat ? html`<span class="meta-i">${it.type === 'train' ? 'Seat' : it.type === 'ferry' ? 'Cabin' : 'Seat'} ${it.seat}</span>` : ''}
      ${it.ref ? html`<span class="meta-i mono">${it.ref}</span>` : ''}
      ${ticketCount(it)}
    </div></a>`;
}

function dayBlock(day, t) {
  const today = isoDate(now());
  const dayNo = daysBetween(t.start, day.date) + 1;
  const isToday = day.date === today;
  return html`<section class="day ${isToday ? 'is-today' : ''} ${day.date < today ? 'past' : ''}" id="day-${day.date}">
    <h2 class="day-h"><span>${fmtLongDay(day.date)}</span>
      <span class="day-no">${isToday ? html`<b class="today-tag">Today</b>` : ''}${dayNo > 0 ? `Day ${dayNo}` : ''}</span></h2>
    ${day.entries.length ? day.entries.map((e) => entryCard(e)) : html`<div class="slim quiet">${icon('sun', 'sm')}<span>Nothing planned</span></div>`}
  </section>`;
}

/* =====================================================================
   Views
   ===================================================================== */

const VIEWS = {};

VIEWS.today = (t) => {
  if (!t) return welcome();
  const n = now();
  const today = isoDate(n);
  const ms = moments(t);
  const live = ms.find((m) => m.until && m.at <= n && m.until >= n && isTransport(m.item));
  const next = ms.find((m) => m.at > n);
  const before = today < t.start, after = today > t.end;
  const days = buildDays(t);
  const todayDay = days.find((d) => d.date === today);
  const tonightAt = tonight(t, today);
  const tb = toBook(t);
  const dueRows = costs(t).rows.filter((it) => it.cost.status === 'due');
  const openTodos = (t.checklist || []).filter((c) => !c.done);
  const noTickets = S.files.length === 0 && !t.readOnly;

  const hero = (m, label, at = m.at) => {
    const it = m.item;
    const tk = ticketsFor(it);
    const all = [...tk.own, ...tk.related];
    return html`<section class="hero-wrap">
      <div class="hero-label">${label} <span class="due" data-due="${at.getTime()}">${fmtUntil(at, n)}</span></div>
      ${entryCard(isStay(it) ? { kind: m.end ? 'checkout' : 'checkin', item: it, nights: daysBetween(it.date, it.endDate || it.date) } : { kind: 'item', item: it }, { hero: true })}
      ${keyTimes(it, true)}
      <div class="hero-actions">
        ${all.length ? html`<a class="btn primary" href="#/ticket/${all[0].id}">${icon('scan')} Show ticket</a>` : ''}
        ${it.ref ? html`<button class="btn" data-act="copy" data-v="${it.ref}">${icon('copy')} ${it.ref}</button>` : ''}
        ${!all.length && !it.ref ? html`<a class="btn" href="#/item/${it.id}">Details</a>` : ''}
      </div>
    </section>`;
  };

  return html`${topBar(t)}<div class="page">
    ${roBanner(t)}
    ${before ? html`<div class="countdown"><span class="cd-n">${daysBetween(today, t.start)}</span><span class="cd-l">day${daysBetween(today, t.start) === 1 ? '' : 's'} to go<br><small>${fmtLongDay(t.start)}</small></span></div>` : ''}
    ${after ? html`<div class="card done-card">${icon('check')}<div><h3>Trip complete</h3><p>Welcome home. The plan and tickets stay here until you delete the trip.</p></div></div>` : ''}
    ${live ? hero(live, 'On the move · arrives', live.until) : ''}
    ${next && !after ? hero(next, before ? 'First up' : 'Next up') : ''}

    ${!t.readOnly && (tb.length || dueRows.length || (before && openTodos.length)) ? html`<section class="card list-card">
      ${tb.map((it) => html`<a class="row" href="#/item/${it.id}"><span class="row-ic amber">${icon('alert')}</span>
        <span class="row-main"><b>Book: ${itemTitle(it)}</b><small>${fmtDay(it.date)}${it.date === today ? ' · today' : ''}</small></span>${icon('right', 'sm dim')}</a>`)}
      ${dueRows.map((it) => html`<a class="row" href="#/item/${it.id}"><span class="row-ic amber">${icon('coin')}</span>
        <span class="row-main"><b>${money(it.cost.amount)} to pay · ${itemTitle(it)}</b><small>${it.cost.note || fmtDay(it.date)}</small></span>${icon('right', 'sm dim')}</a>`)}
      ${before && openTodos.length ? html`<a class="row" href="#/todo"><span class="row-ic">${icon('checklist')}</span>
        <span class="row-main"><b>${openTodos.length} thing${openTodos.length === 1 ? '' : 's'} to do before you go</b><small>${openTodos[0].text}</small></span>${icon('right', 'sm dim')}</a>` : ''}
    </section>` : ''}

    ${noTickets && !after ? html`<a class="card tip" href="#/tickets">${icon('ticket')}<div><b>Add your tickets</b><span>Screenshot your boarding passes and rail tickets, then add them here so they open without signal.</span></div>${icon('right', 'sm dim')}</a>` : ''}

    ${!before && !after && todayDay ? html`<h2 class="sec-h">Today · ${fmtDay(today)}</h2>${todayDay.entries.length ? todayDay.entries.map((e) => entryCard(e)) : html`<div class="slim quiet">${icon('sun', 'sm')}<span>No travel today</span></div>`}` : ''}

    ${!after && tonightAt && !before ? html`<h2 class="sec-h">Tonight</h2>
      <a class="card tonight t-${tonightAt.type}" href="#/item/${tonightAt.id}"><span class="tile">${icon(tonightAt.type === 'hotel' ? 'bed' : 'home')}</span>
        <div><b>${itemTitle(tonightAt)}</b><span>${tonightAt.address || itemSubtitle(tonightAt) || ''}</span></div>${icon('right', 'sm dim')}</a>` : ''}

    ${before ? html`<h2 class="sec-h">At a glance</h2>${glance(t)}` : ''}
    ${!before && !after ? (() => {
      const tm = days.find((d) => d.date === addDays(today, 1));
      return tm && tm.entries.some((e) => e.kind !== 'night') ? html`<h2 class="sec-h">Tomorrow · ${fmtDay(tm.date)}</h2>${tm.entries.filter((e) => e.kind !== 'night' && e.kind !== 'gap').slice(0, 3).map((e) => entryCard(e))}` : '';
    })() : ''}
  </div>`;
};

/** One line per day: where you go / where you sleep. */
function glance(t) {
  const days = buildDays(t);
  return html`<div class="card glance">${days.map((d) => {
    const moves = d.entries.filter((e) => e.kind === 'item' && isTransport(e.item) && e.item.status !== 'cancelled');
    const places = [];
    for (const e of moves) { if (!places.length && e.item.from) places.push(e.item.from); if (e.item.to) places.push(e.item.to); }
    const sleep = tonight(t, d.date);
    const worst = moves.some((e) => e.item.status === 'tobook') ? 'tobook' : moves.every((e) => e.item.status === 'confirmed') && moves.length ? 'confirmed' : moves.length ? 'arranged' : '';
    return html`<a class="g-row" href="#/plan" data-act="goto-day" data-day="${d.date}">
      <span class="g-day">${fmtDay(d.date)}</span>
      <span class="g-main">${places.length ? places.join(' → ') : sleep ? itemTitle(sleep) : '—'}</span>
      ${worst ? html`<i class="dot st-${worst}" title="${STATUS[worst].label}"></i>` : html`<i class="dot"></i>`}
    </a>`;
  })}</div>`;
}

function keyTimes(it, compact) {
  const rows = String(it.keyTimes || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const m = l.match(/^(\d{1,2}[:.]\d{2})\s*[-–:]?\s*(.*)$/); return m ? { t: m[1].replace('.', ':').padStart(5, '0'), label: m[2] } : { t: '', label: l }; })
    .sort((a, b) => (a.t && b.t ? a.t.localeCompare(b.t) : 0));
  if (!rows.length) return '';
  return html`<div class="keytimes ${compact ? 'compact' : ''}">${rows.map((r) => html`<div class="kt"><b>${r.t}</b><span>${r.label}</span></div>`)}</div>`;
}

function welcome() {
  return html`${topBar(null)}<div class="page"><div class="empty welcome">
    <div class="logo-big">${icon('suitcase')}</div>
    <h2>Your trips, offline</h2>
    <p>Bookings, tickets and barcodes, kept on this phone. They work with no signal.</p>
    <button class="btn primary wide" data-act="import-file">${icon('upload')} Import a trip file</button>
    <button class="btn wide" data-act="new-trip">${icon('plus')} Start a new trip</button>
    ${S.installPrompt ? html`<button class="btn wide ghost" data-act="install">${icon('download')} Install on home screen</button>` : ''}
  </div></div>`;
}

VIEWS.plan = (t) => {
  if (!t) return welcome();
  const days = buildDays(t);
  return html`${topBar(t)}<div class="page plan">
    ${roBanner(t)}
    ${days.map((d) => dayBlock(d, t))}
    ${!readOnly() ? html`<button class="fab" data-act="new-item" aria-label="Add booking">${icon('plus')}</button>` : ''}
  </div>`;
};

VIEWS.shared = (_t, parts) => {
  const p = S.preview;
  if (parts[0] === 'item') return VIEWS.item(p.trip, [parts[1]]);
  const t = p.trip;
  const existing = S.trips.find((x) => x.sourceId === t.id || x.id === t.id);
  return html`<header class="top"><div class="trip-switch"><span class="top-name">${t.name}</span><span class="top-dates">${fmtRange(t.start, t.end)}</span></div>${netPill()}</header>
  <div class="page plan">
    ${roBanner(t)}
    <div class="card save-card">
      <p>${existing ? 'You already have this trip. Save to replace it with this newer version.' : 'Save it to this phone so it opens without signal.'}</p>
      <div class="row-btns"><button class="btn primary" data-act="save-preview">${icon('download')} ${existing ? 'Update my copy' : 'Save to this phone'}</button>
      <a class="btn ghost" href="#/today" data-act="close-preview">Not now</a></div>
    </div>
    ${buildDays(t).map((d) => dayBlock(d, t))}
  </div>`;
};

/* ---------- item detail ---------- */

VIEWS.item = (t, [id]) => {
  const it = t?.items.find((i) => i.id === id);
  if (!it) return html`${subBar('Not found')}<div class="page"><div class="empty"><p>That booking no longer exists.</p></div></div>`;
  const T = typeOf(it);
  const ro = readOnly();
  const back = isPreview() ? '#/shared' : 'plan';
  const tk = isPreview() ? { own: [], related: [] } : ticketsFor(it);
  const people = (it.people || []).map((pid) => t.people.find((p) => p.id === pid)).filter(Boolean);
  const f = T.fields;
  const nights = isStay(it) && it.endDate ? daysBetween(it.date, it.endDate) : 0;
  const detail = (k, label = f[k], copy = false) =>
    it[k] ? html`<div class="kv"><span>${label}</span><b class="${copy ? 'mono' : ''}">${it[k]}</b>${copy ? html`<button class="icon-btn sm" data-act="copy" data-v="${it[k]}" aria-label="Copy ${label}">${icon('copy')}</button>` : ''}</div>` : '';
  const links = liveLinks(it);

  return html`${subBar(T.label, back, ro ? '' : html`<a class="icon-btn" href="#/edit/${it.id}" aria-label="Edit">${icon('edit')}</a>`)}
  <div class="page detail t-${it.type}">
    <div class="d-head">
      <span class="tile lg">${icon(T.icon)}</span>
      <div><h2>${itemTitle(it)}</h2>${itemSubtitle(it) ? html`<p>${itemSubtitle(it)}</p>` : ''}</div>
      ${chip(it.status)}
    </div>

    ${isTransport(it) ? html`<div class="card d-route">
      <div><small>${T.when[0]}</small><b class="time">${it.time || '––:––'}</b><span>${it.from || ''}</span><em>${fmtDay(it.date)}</em></div>
      <div class="route-line v"><span>${it.time && it.endTime ? fmtDuration(endOf(it) - startOf(it)) : ''}</span></div>
      <div><small>${T.when[1]}</small><b class="time">${it.endTime || '––:––'}</b><span>${it.to || ''}</span><em>${fmtDay(it.endDate || it.date)}</em></div>
    </div>` : html`<div class="card d-route stay">
      <div><small>${T.when[0]}</small><b class="time">${it.time || '—'}</b><em>${fmtDay(it.date)}</em></div>
      <div class="route-line v"><span>${nights ? `${nights} night${nights === 1 ? '' : 's'}` : ''}</span></div>
      <div><small>${T.when[1]}</small><b class="time">${it.endTime || '—'}</b><em>${it.endDate ? fmtDay(it.endDate) : ''}</em></div>
    </div>`}

    ${it.status === 'tobook' && !ro ? html`<div class="banner warn">${icon('alert', 'sm')}<div><b>Still to book</b><span>When it's booked, tap Edit, set it to Confirmed and add the reference and times.</span></div></div>` : ''}

    ${!isPreview() && (tk.own.length || tk.related.length || !ro) ? html`<h3 class="sec-h">Tickets</h3>
    <div class="thumbs">
      ${[...tk.own, ...tk.related].map((file) => thumb(file, tk.related.includes(file)))}
      ${!ro ? html`<button class="thumb add" data-act="add-files" data-item="${it.id}">${icon('plus')}<span>Add ticket</span></button>` : ''}
    </div>` : ''}

    <div class="card kvs">
      ${detail('ref', f.ref, true)}${detail('eticket', f.eticket, true)}
      ${detail('seat')}${detail('class')}${detail('number')}
      ${it.type !== 'lift' && it.type !== 'stay' ? detail('provider') : ''}
      ${it.address ? html`<div class="kv"><span>${f.address || 'Address'}</span><b>${it.address}</b>
        <a class="icon-btn sm" href="${mapsUrl(it.address)}" target="_blank" rel="noopener" aria-label="Open in Maps">${icon('map')}</a></div>` : ''}
      ${it.phone ? html`<div class="kv"><span>Phone</span><b>${it.phone}</b><a class="icon-btn sm" href="${telHref(it.phone)}" aria-label="Call">${icon('phone')}</a></div>` : ''}
      ${it.cost && Number(it.cost.amount) ? html`<div class="kv"><span>Cost</span><b>${money(it.cost.amount)} <span class="chip cs-${it.cost.status || 'unknown'}">${COST_STATUS[it.cost.status || 'unknown']}</span>${it.cost.note ? html`<small>${it.cost.note}</small>` : ''}</b>
        ${!ro && it.cost.status !== 'paid' ? html`<button class="btn xs" data-act="mark-paid" data-item="${it.id}">Mark paid</button>` : ''}</div>` : ''}
    </div>

    ${it.keyTimes ? html`<h3 class="sec-h">Key times</h3>${keyTimes(it)}` : ''}

    ${people.length ? html`<h3 class="sec-h">People</h3><div class="card list-card">${people.map(personRow)}</div>` : ''}

    ${it.notes ? html`<h3 class="sec-h">Notes</h3><div class="card notes">${it.notes}</div>` : ''}

    ${links.length ? html`<h3 class="sec-h">Live status ${!S.online ? html`<small class="dim">· needs signal</small>` : ''}</h3>
      ${S.online ? html`<div class="card list-card">${links.map((l) => html`<a class="row" href="${l.url}" target="_blank" rel="noopener"><span class="row-ic">${icon('live')}</span><span class="row-main"><b>${l.label}</b></span>${icon('external', 'sm dim')}</a>`)}</div>`
        : html`<div class="slim quiet">${icon('offline', 'sm')}<span>Links to live status appear when you're back online.</span></div>`}` : ''}

    ${!ro ? html`<div class="d-actions">
      ${S.online ? html`<a class="btn" href="${googleCalendarUrl(it)}" target="_blank" rel="noopener">${icon('calendar')} Add to Google Calendar</a>` : ''}
      <button class="btn" data-act="dup-item" data-item="${it.id}">${icon('copy')} Duplicate</button>
      <button class="btn danger-ghost" data-act="del-item" data-item="${it.id}">${icon('trash')} Delete</button>
    </div>` : ''}
  </div>`;
};

function thumb(file, related) {
  const img = file.type?.startsWith('image/');
  return html`<a class="thumb ${related ? 'related' : ''}" href="#/ticket/${file.id}">
    ${img ? html`<img src="${fileUrl(file)}" alt="" loading="lazy">` : html`<span class="thumb-file">${icon('file')}<small>PDF</small></span>`}
    ${file.barcode ? html`<span class="thumb-badge">${icon('scan', 'sm')}</span>` : ''}
    <span class="thumb-name">${related ? 'Same booking' : file.label || file.name || ''}</span></a>`;
}

function personRow(p) {
  return html`<div class="row person"><span class="avatar">${(p.name || '?').trim().charAt(0).toUpperCase()}</span>
    <span class="row-main"><b>${p.name}</b><small>${[p.role, p.phone].filter(Boolean).join(' · ')}</small></span>
    ${p.phone ? html`<a class="icon-btn sm" href="${telHref(p.phone)}" aria-label="Call ${p.name}">${icon('phone')}</a>
      <a class="icon-btn sm" href="sms:${p.phone.replace(/[^\d+]/g, '')}" aria-label="Text ${p.name}">${icon('message')}</a>
      ${S.online ? html`<a class="icon-btn sm wa" href="${whatsappHref(p.phone)}" target="_blank" rel="noopener" aria-label="WhatsApp ${p.name}">WA</a>` : ''}` : ''}
  </div>`;
}

/* ---------- editor ---------- */

function blankItem(type, date) {
  return { id: uid('it_'), type, status: 'confirmed', date, time: '', endDate: '', endTime: '', people: [] };
}

VIEWS.new = (t, [type, date]) => {
  if (!t || readOnly()) return VIEWS.today(t);
  if (!S.draft) S.draft = blankItem(type || 'flight', date || defaultDate(t));
  return editor(t, S.draft, true);
};

VIEWS.edit = (t, [id]) => {
  if (!t || readOnly()) return VIEWS.today(t);
  if (!S.draft || S.draft.id !== id) {
    const it = t.items.find((i) => i.id === id);
    if (!it) return VIEWS.item(t, [id]);
    S.draft = structuredClone(it);
  }
  return editor(t, S.draft, false);
};

function defaultDate(t) {
  const today = isoDate(now());
  return today >= t.start && today <= t.end ? today : t.start;
}

function editor(t, d, isNew) {
  const T = typeOf(d);
  const f = T.fields;
  const input = (k, label, attrs = '') => html`<label class="fld"><span>${label}</span><input name="${k}" value="${d[k] || ''}" ${raw(attrs)}></label>`;
  const has = (k) => k in f;
  return html`${subBar(isNew ? 'Add booking' : 'Edit booking', isNew ? 'plan' : `item/${d.id}`)}
  <form class="page form" data-form="item" autocomplete="off">
    <div class="type-grid" role="radiogroup" aria-label="Type">
      ${Object.entries(TYPES).map(([k, v]) => html`<label class="type-opt ${d.type === k ? 'on' : ''}">
        <input type="radio" name="type" value="${k}" ${d.type === k ? raw('checked') : ''} data-change="type">${icon(v.icon)}<span>${v.label}</span></label>`)}
    </div>

    <div class="seg" role="radiogroup" aria-label="Status">
      ${Object.entries(STATUS).map(([k, v]) => html`<label class="${d.status === k ? 'on' : ''} st-${k}"><input type="radio" name="status" value="${k}" ${d.status === k ? raw('checked') : ''} data-change="seg">${v.label}</label>`)}
    </div>

    ${has('title') ? input('title', f.title, 'required') : ''}
    ${has('provider') || has('number') ? html`<div class="two">${has('provider') ? input('provider', f.provider, d.type === 'lift' ? 'placeholder="Name (optional)"' : '') : ''}${has('number') ? input('number', f.number) : ''}</div>` : ''}
    ${has('from') ? html`<div class="two">${input('from', f.from)}${input('to', f.to)}</div>` : ''}
    ${has('fromCode') ? html`<div class="two">${input('fromCode', f.fromCode, 'maxlength="3" style="text-transform:uppercase"')}${input('toCode', f.toCode, 'maxlength="3" style="text-transform:uppercase"')}</div>
      <p class="hint">Station codes power the live-departure links. Common ones fill in automatically.</p>` : ''}

    <fieldset class="when"><legend>${T.when[0]}</legend><div class="two">
      <label class="fld"><span>Date</span><input type="date" name="date" value="${d.date || ''}" required></label>
      <label class="fld"><span>Time</span><input type="time" name="time" value="${d.time || ''}"></label></div></fieldset>
    <fieldset class="when"><legend>${T.when[1]}</legend><div class="two">
      <label class="fld"><span>Date</span><input type="date" name="endDate" value="${d.endDate || ''}" ${isStay(d) ? raw('required') : ''}></label>
      <label class="fld"><span>Time</span><input type="time" name="endTime" value="${d.endTime || ''}"></label></div></fieldset>

    ${has('seat') || has('class') ? html`<div class="two">${has('seat') ? input('seat', f.seat) : ''}${has('class') ? input('class', f.class) : ''}</div>` : ''}
    ${has('ref') || has('eticket') ? html`<div class="two">${has('ref') ? input('ref', f.ref, 'autocapitalize="characters" class="mono"') : ''}${has('eticket') ? input('eticket', f.eticket, 'class="mono"') : ''}</div>` : ''}
    ${has('address') ? input('address', f.address) : ''}
    ${has('phone') ? input('phone', f.phone, 'type="tel"') : ''}

    <label class="fld"><span>Key times <small>one per line, e.g. “21:45 Check-in opens”</small></span>
      <textarea name="keyTimes" rows="3" placeholder="07:45 Be at Terminal 2">${d.keyTimes || ''}</textarea></label>

    <fieldset class="cost"><legend>Cost</legend><div class="three">
      <label class="fld"><span>Amount (£)</span><input name="costAmount" type="number" inputmode="decimal" step="0.01" min="0" value="${d.cost?.amount ?? ''}"></label>
      <label class="fld"><span>Status</span><select name="costStatus">${Object.entries(COST_STATUS).map(([k, v]) => html`<option value="${k}" ${(d.cost?.status || 'unknown') === k ? raw('selected') : ''}>${v}</option>`)}</select></label>
    </div><label class="fld"><span>Payment note</span><input name="costNote" value="${d.cost?.note || ''}" placeholder="e.g. Pay on arrival"></label></fieldset>

    ${t.people.length ? html`<fieldset><legend>People</legend><div class="checks">${t.people.map((p) => html`<label class="check"><input type="checkbox" name="people" value="${p.id}" ${(d.people || []).includes(p.id) ? raw('checked') : ''}><span>${p.name}</span></label>`)}</div></fieldset>` : ''}
    <p class="hint">${t.people.length ? '' : html`Add drivers and hosts under <a href="#/people">More → People</a> to link them here.`}</p>

    <label class="fld"><span>Notes</span><textarea name="notes" rows="4">${d.notes || ''}</textarea></label>
    <label class="fld"><span>Links <small>one per line: Label | https://…</small></span><textarea name="links" rows="2" placeholder="Manage booking | https://…">${d.links || ''}</textarea></label>

    <div class="form-actions">
      <button class="btn primary wide" type="submit">${icon('check')} Save</button>
      ${!isNew ? html`<button class="btn danger-ghost wide" type="button" data-act="del-item" data-item="${d.id}">${icon('trash')} Delete booking</button>` : ''}
    </div>
  </form>`;
}

function readItemForm(form, base) {
  const fd = new FormData(form);
  const d = { ...base };
  for (const k of ['type', 'status', 'title', 'provider', 'number', 'from', 'to', 'fromCode', 'toCode', 'date', 'time', 'endDate', 'endTime', 'seat', 'class', 'ref', 'eticket', 'address', 'phone', 'keyTimes', 'notes', 'links']) {
    if (fd.has(k)) d[k] = String(fd.get(k) || '').trim();
  }
  if (fd.has('people')) d.people = fd.getAll('people').map(String);
  else if (form.querySelector('[name=people]')) d.people = [];
  const amt = String(fd.get('costAmount') || '').trim();
  d.cost = amt ? { amount: Number(amt), status: String(fd.get('costStatus') || 'unknown'), note: String(fd.get('costNote') || '').trim() } : null;
  return d;
}

/* ---------- tickets ---------- */

VIEWS.tickets = (t) => {
  if (!t) return welcome();
  const ro = readOnly();
  const items = [...t.items].filter((it) => it.date).sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
  const withFiles = items.filter((it) => filesFor(it.id).length);
  const needing = items.filter((it) => !filesFor(it.id).length && ['flight', 'ferry', 'train', 'bus'].includes(it.type) && it.status === 'confirmed'
    && !(it.ref && t.items.some((o) => o.id !== it.id && o.ref === it.ref && filesFor(o.id).length)));
  const today = isoDate(now());
  return html`${topBar(t)}<div class="page">
    ${withFiles.length ? '' : html`<div class="card tip static">${icon('info')}<div><b>How to add tickets</b>
      <span>In the Loganair or Trainline app, open the boarding pass or ticket and take a screenshot. For emails (NorthLink, Premier Inn), open the attachment and screenshot the page with the barcode, or tap <b>Share → Travel Pack</b>. Then add it to the booking below. Barcodes are found automatically so they can be shown full-screen.</span></div></div>`}
    ${withFiles.map((it) => html`<section class="tk-group ${(it.endDate || it.date) < today ? 'past' : ''}">
      <a class="tk-h" href="#/item/${it.id}"><span class="tile sm t-${it.type}">${icon(typeOf(it).icon)}</span>
        <span><b>${itemTitle(it)}</b><small>${fmtDay(it.date)}${it.time ? ` · ${it.time}` : ''}${it.ref ? ` · ${it.ref}` : ''}</small></span>${icon('right', 'sm dim')}</a>
      <div class="thumbs">${filesFor(it.id).map((f) => thumb(f))}${!ro ? html`<button class="thumb add" data-act="add-files" data-item="${it.id}">${icon('plus')}<span>Add</span></button>` : ''}</div>
    </section>`)}
    ${needing.length && !ro ? html`<h2 class="sec-h">No ticket saved yet</h2><div class="card list-card">${needing.map((it) => html`
      <button class="row" data-act="add-files" data-item="${it.id}"><span class="tile sm t-${it.type}">${icon(typeOf(it).icon)}</span>
        <span class="row-main"><b>${itemTitle(it)}</b><small>${fmtDay(it.date)}${it.time ? ` · ${it.time}` : ''} · ${itemSubtitle(it)}</small></span><span class="btn xs">${icon('plus', 'sm')} Add</span></button>`)}</div>` : ''}
    ${!withFiles.length && !needing.length ? html`<div class="empty"><p>No tickets yet.</p></div>` : ''}
    ${S.inbox.length ? html`<a class="card tip" href="#/inbox">${icon('download')}<div><b>${S.inbox.length} shared file${S.inbox.length === 1 ? '' : 's'} waiting</b><span>Choose which booking they belong to.</span></div></a>` : ''}
  </div>`;
};

VIEWS.ticket = (t, [fileId]) => {
  const f = S.files.find((x) => x.id === fileId);
  if (!f) return html`${subBar('Ticket', 'tickets')}<div class="page"><div class="empty"><p>Ticket not found.</p></div></div>`;
  const it = t.items.find((i) => i.id === f.itemId);
  const siblings = it ? [...ticketsFor(it).own, ...ticketsFor(it).related] : [f];
  const pos = siblings.findIndex((x) => x.id === f.id);
  const prev = siblings[pos - 1], next = siblings[pos + 1];
  const img = f.type?.startsWith('image/');
  const crop = f.barcode && !S.showWhole;
  return html`<div class="viewer">
    <header class="v-top">
      <a class="icon-btn" href="${it ? `#/item/${it.id}` : '#/tickets'}" data-act="back" aria-label="Close">${icon('x')}</a>
      <div class="v-title"><b>${it ? itemTitle(it) : 'Ticket'}</b><small>${it ? `${fmtDay(it.date)}${it.time ? ` · ${it.time}` : ''}` : ''}${siblings.length > 1 ? ` · ${pos + 1} of ${siblings.length}` : ''}</small></div>
      ${!readOnly() ? html`<button class="icon-btn" data-act="file-menu" data-file="${f.id}" aria-label="Ticket options">${icon('edit')}</button>` : ''}
    </header>
    <div class="v-body ${crop ? 'crop' : ''}" data-act="toggle-crop">
      ${img ? (crop ? html`<canvas data-crop="${f.id}" aria-label="Barcode"></canvas>` : html`<img src="${fileUrl(f)}" alt="Ticket image">`)
        : html`<div class="v-pdf">${icon('file')}<p><b>${f.name}</b><br>PDF (${fmtBytes(f.size || f.blob.size)})</p>
          <button class="btn primary" data-act="open-file" data-file="${f.id}">${icon('external')} Open PDF</button>
          <p class="hint">Opens in your PDF viewer. For the gate, a screenshot of the barcode page works best. Add it here and it will show full-screen.</p></div>`}
    </div>
    <footer class="v-foot">
      ${it ? html`<div class="v-facts">
        ${it.ref ? html`<div><small>Ref</small><b class="mono">${it.ref}</b></div>` : ''}
        ${it.seat ? html`<div><small>${it.type === 'ferry' ? 'Cabin' : 'Seat'}</small><b>${it.seat}</b></div>` : ''}
        ${it.number ? html`<div><small>${typeOf(it).fields.number || ''}</small><b>${it.number}</b></div>` : ''}
      </div>` : ''}
      ${f.barcode && img ? html`<button class="btn xs ghost" data-act="toggle-crop">${S.showWhole ? 'Show barcode only' : 'Show whole ticket'}</button>` : ''}
      <div class="v-nav">
        ${prev ? html`<a class="btn ghost" href="#/ticket/${prev.id}" data-replace>${icon('left')} Prev</a>` : html`<span></span>`}
        ${next ? html`<a class="btn ghost" href="#/ticket/${next.id}" data-replace>Next ${icon('right')}</a>` : html`<span></span>`}
      </div>
      <p class="v-hint">Screen stays on while this is open. Turn brightness up for scanners.</p>
    </footer>
  </div>`;
};

function drawCrop(canvas, f) {
  const img = new Image();
  img.onload = () => {
    const b = f.barcode.box;
    const pad = Math.max(b.w, b.h) * 0.08 + 12;
    const sx = Math.max(0, b.x - pad), sy = Math.max(0, b.y - pad);
    const sw = Math.min(img.naturalWidth - sx, b.w + pad * 2), sh = Math.min(img.naturalHeight - sy, b.h + pad * 2);
    const scale = Math.max(1, Math.floor(900 / Math.max(sw, sh)));
    canvas.width = sw * scale; canvas.height = sh * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  };
  img.src = fileUrl(f);
}

/* ---------- to-do ---------- */

VIEWS.todo = (t) => {
  if (!t) return welcome();
  const ro = readOnly();
  const tb = toBook(t);
  const list = t.checklist || [];
  const open = list.filter((c) => !c.done), done = list.filter((c) => c.done);
  const row = (c) => html`<div class="todo ${c.done ? 'done' : ''}">
    <button class="tick" data-act="toggle-todo" data-id="${c.id}" aria-label="${c.done ? 'Mark not done' : 'Mark done'}" ${ro ? raw('disabled') : ''}>${c.done ? icon('check') : ''}</button>
    <button class="todo-text" data-act="edit-todo" data-id="${c.id}" ${ro ? raw('disabled') : ''}>${c.text}${c.due ? html`<small>${fmtDay(c.due)}</small>` : ''}</button>
  </div>`;
  return html`${topBar(t)}<div class="page">
    ${tb.length ? html`<h2 class="sec-h">Still to book</h2><div class="card list-card">${tb.map((it) => html`<a class="row" href="#/item/${it.id}">
      <span class="row-ic amber">${icon(typeOf(it).icon)}</span><span class="row-main"><b>${itemTitle(it)}</b><small>${fmtLongDay(it.date)}</small></span>
      ${!ro ? html`<span class="btn xs" data-act="book-now" data-item="${it.id}">Booked it</span>` : ''}</a>`)}</div>` : ''}
    ${!ro ? html`<form class="add-todo" data-form="todo"><input name="text" placeholder="Add something to do…" required aria-label="New to-do"><button class="btn primary" aria-label="Add">${icon('plus')}</button></form>` : ''}
    ${open.length ? html`<div class="card todo-list">${open.map(row)}</div>` : html`<div class="slim quiet">${icon('check', 'sm')}<span>Nothing left to do</span></div>`}
    ${done.length ? html`<h2 class="sec-h">Done · ${done.length}</h2><div class="card todo-list">${done.map(row)}</div>` : ''}
  </div>`;
};

/* ---------- more ---------- */

VIEWS.more = (t) => {
  const c = t ? costs(t) : null;
  const ro = readOnly();
  const link = (href, ic, label, sub = '', act = '') => html`<a class="row" href="${href}" ${act ? raw(`data-act="${act}"`) : ''}><span class="row-ic">${icon(ic)}</span><span class="row-main"><b>${label}</b>${sub ? html`<small>${sub}</small>` : ''}</span>${icon('right', 'sm dim')}</a>`;
  const backupAge = S.lastBackup ? daysBetween(isoDate(new Date(S.lastBackup)), isoDate(new Date())) : null;
  return html`${topBar(t)}<div class="page">
    ${S.updateReady ? html`<button class="card tip" data-act="apply-update">${icon('refresh')}<div><b>Update available</b><span>Tap to load the new version.</span></div></button>` : ''}
    ${t ? html`<h2 class="sec-h">This trip</h2><div class="card list-card">
      ${!ro ? link('#/trip-edit', 'edit', 'Trip details', `${t.name} · ${fmtRange(t.start, t.end)}`) : ''}
      ${link('#/costs', 'coin', 'Costs', c.rows.length ? `${money(c.paid)} paid · ${money(c.due)} to pay${c.unknown ? ` · ${money(c.unknown)} to check` : ''}` : 'No costs recorded')}
      ${link('#/people', 'people', 'People', t.people.length ? t.people.map((p) => p.name).join(', ') : 'Drivers, hosts, family')}
      ${link('#/share', 'share', 'Share this trip', 'Link for Jane or friends, or a plain-text itinerary')}
      <button class="row" data-act="export-ics"><span class="row-ic">${icon('calendar')}</span><span class="row-main"><b>Add to calendar</b><small>Calendar file with reminders before each departure</small></span>${icon('download', 'sm dim')}</button>
      ${ro ? html`<button class="row" data-act="make-editable"><span class="row-ic">${icon('edit')}</span><span class="row-main"><b>Make an editable copy</b><small>Stops updating from share links</small></span></button>` : ''}
    </div>` : ''}
    <h2 class="sec-h">Trips</h2><div class="card list-card">
      ${link('#/trips', 'suitcase', 'All trips', `${S.trips.length} on this phone`)}
      <button class="row" data-act="new-trip"><span class="row-ic">${icon('plus')}</span><span class="row-main"><b>New trip</b></span></button>
      <button class="row" data-act="import-file"><span class="row-ic">${icon('upload')}</span><span class="row-main"><b>Import a trip or backup file</b></span></button>
    </div>
    <h2 class="sec-h">Your data</h2><div class="card list-card">
      ${link('#/backup', 'database', 'Back up & restore', backupAge === null ? 'Never backed up' : backupAge === 0 ? 'Backed up today' : `Last backup ${backupAge} day${backupAge === 1 ? '' : 's'} ago`)}
      <button class="row" data-act="set-name"><span class="row-ic">${icon('people')}</span><span class="row-main"><b>Your name</b><small>${S.me || 'Shown when you share a trip'}</small></span>${icon('right', 'sm dim')}</button>
      ${S.installPrompt ? html`<button class="row" data-act="install"><span class="row-ic">${icon('download')}</span><span class="row-main"><b>Install on home screen</b></span></button>` : ''}
    </div>
    <div class="about">
      <p>${icon(S.persisted ? 'lock' : 'info', 'sm')} ${S.persisted ? 'Storage is protected. Android will not clear it to free space.' : 'Everything is stored on this phone only.'}</p>
      <p>Travel Pack ${APP_VERSION} · works offline</p>
    </div>
  </div>`;
};

VIEWS['trip-edit'] = (t) => {
  if (!t) return welcome();
  return html`${subBar('Trip details', 'more')}<form class="page form" data-form="trip">
    <label class="fld"><span>Trip name</span><input name="name" value="${t.name}" required></label>
    <div class="two"><label class="fld"><span>First day</span><input type="date" name="start" value="${t.start}" required></label>
    <label class="fld"><span>Last day</span><input type="date" name="end" value="${t.end}" required></label></div>
    <label class="fld"><span>Notes</span><textarea name="notes" rows="4">${t.notes || ''}</textarea></label>
    <div class="form-actions"><button class="btn primary wide">${icon('check')} Save</button>
    <button type="button" class="btn danger-ghost wide" data-act="del-trip" data-id="${t.id}">${icon('trash')} Delete this trip</button></div>
  </form>`;
};

VIEWS.trips = () => {
  const today = isoDate(now());
  return html`${subBar('Trips', 'more')}<div class="page">
    ${S.trips.map((t) => html`<button class="card trip-card ${t.id === S.tripId ? 'current' : ''}" data-act="open-trip" data-id="${t.id}">
      <div><b>${t.name}</b><small>${fmtRange(t.start, t.end)} · ${t.items.length} booking${t.items.length === 1 ? '' : 's'}${t.readOnly ? ' · shared copy' : ''}</small></div>
      <span class="chip ${t.end < today ? '' : t.start <= today ? 'st-confirmed' : 'st-arranged'}">${t.end < today ? 'Past' : t.start <= today ? 'Now' : 'Upcoming'}</span>
    </button>`)}
    <div class="row-btns"><button class="btn primary" data-act="new-trip">${icon('plus')} New trip</button>
    <button class="btn" data-act="import-file">${icon('upload')} Import file</button></div>
    ${S.trips.length ? html`<p class="hint">To reuse a trip as a template, open it, then use More → Share → “Save trip file”, and import that file.</p>` : ''}
  </div>`;
};

VIEWS.costs = (t) => {
  if (!t) return welcome();
  const c = costs(t);
  const ro = readOnly();
  return html`${subBar('Costs', 'more')}<div class="page">
    <div class="tiles">
      <div class="tile-stat"><small>Paid</small><b>${money(c.paid)}</b></div>
      <div class="tile-stat amber"><small>To pay</small><b>${money(c.due)}</b></div>
      ${c.unknown ? html`<div class="tile-stat grey"><small>To check</small><b>${money(c.unknown)}</b></div>` : ''}
    </div>
    <div class="card list-card">${c.rows.length ? c.rows.sort((a, b) => a.date.localeCompare(b.date)).map((it) => html`<div class="row">
      <span class="tile sm t-${it.type}">${icon(typeOf(it).icon)}</span>
      <a class="row-main" href="#/item/${it.id}"><b>${itemTitle(it)}</b><small>${fmtDay(it.date)}${it.cost.note ? ` · ${it.cost.note}` : ''}</small></a>
      <span class="amt"><b>${money(it.cost.amount)}</b><span class="chip cs-${it.cost.status || 'unknown'}">${COST_STATUS[it.cost.status || 'unknown']}</span></span>
      ${!ro && it.cost.status !== 'paid' ? html`<button class="btn xs" data-act="mark-paid" data-item="${it.id}">Paid</button>` : ''}
    </div>`) : html`<div class="row"><span class="row-main"><small>Add a cost to any booking when you edit it.</small></span></div>`}</div>
  </div>`;
};

VIEWS.people = (t) => {
  if (!t) return welcome();
  const ro = readOnly();
  return html`${subBar('People', 'more')}<div class="page">
    <div class="card list-card">${t.people.length ? t.people.map((p) => {
      const linked = t.items.filter((it) => (it.people || []).includes(p.id));
      return html`<div class="person-block">${personRow(p)}
        ${linked.length ? html`<div class="linked">${linked.map((it) => html`<a href="#/item/${it.id}">${fmtDay(it.date)} · ${itemTitle(it)}</a>`)}</div>` : ''}
        ${!ro ? html`<button class="btn xs ghost" data-act="edit-person" data-id="${p.id}">${icon('edit', 'sm')} Edit</button>` : ''}</div>`;
    }) : html`<div class="row"><span class="row-main"><small>Add the people driving you, hosting you or collecting you, so their numbers are one tap away.</small></span></div>`}</div>
    ${!ro ? html`<button class="btn primary wide" data-act="edit-person">${icon('plus')} Add person</button>` : ''}
  </div>`;
};

VIEWS.share = (t) => {
  if (!t) return welcome();
  return html`${subBar('Share trip', 'more')}<form class="page form" data-form="share" onsubmit="return false">
    <p class="lead">Send a read-only copy of the plan. It opens in Travel Pack and can be saved there for offline use. Tickets are never included in a link.</p>
    <fieldset><legend>Include</legend><div class="checks col">
      <label class="check"><input type="checkbox" name="refs" checked><span>Booking references</span></label>
      <label class="check"><input type="checkbox" name="contacts" checked><span>People & phone numbers</span></label>
      <label class="check"><input type="checkbox" name="notes" checked><span>Notes & links</span></label>
      <label class="check"><input type="checkbox" name="costs"><span>Costs</span></label>
    </div></fieldset>
    <button class="btn primary wide" data-act="share-link">${icon('share')} Share link</button>
    <button class="btn wide" data-act="share-text">${icon('message')} Share as text (WhatsApp, SMS)</button>
    <h2 class="sec-h">Full copy</h2>
    <p class="hint">A trip file includes every ticket and attachment. Use it to give Jane an editable copy, or as a template for the next trip.</p>
    <button class="btn wide" data-act="export-trip">${icon('download')} Save trip file</button>
  </form>`;
};

VIEWS.backup = () => {
  const total = S.trips.length;
  return html`${subBar('Back up & restore', 'more')}<div class="page">
    <p class="lead">A backup is one file with every trip, contact and ticket. Keep it in Google Drive or email it to yourself. If this phone is lost or reset, install the app on the new phone and restore it.</p>
    <div class="card list-card">
      <button class="row" data-act="backup-share"><span class="row-ic">${icon('share')}</span><span class="row-main"><b>Back up now</b><small>Share to Drive, Gmail or Files · ${total} trip${total === 1 ? '' : 's'}</small></span></button>
      <button class="row" data-act="backup-download"><span class="row-ic">${icon('download')}</span><span class="row-main"><b>Download backup file</b><small>Saves to Downloads</small></span></button>
      <button class="row" data-act="import-file"><span class="row-ic">${icon('upload')}</span><span class="row-main"><b>Restore from a file</b><small>Adds trips; replaces ones with the same name and ID</small></span></button>
    </div>
    ${S.lastBackup ? html`<p class="hint">Last backup: ${new Date(S.lastBackup).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</p>` : ''}
  </div>`;
};

VIEWS.add = () => {
  const p = S.incoming;
  const editable = S.trips.filter((t) => !t.readOnly);
  const target = editable.find((t) => t.id === p.tripId) || editable.find((t) => t.id === S.tripId) || editable[0];
  return html`${subBar(p.items.length === 1 ? 'Add booking' : `Add ${p.items.length} bookings`, 'today')}<div class="page">
    <p class="lead">From a Travel Pack link. Nothing else in your trip changes.</p>
    ${p.items.map((it) => {
      const T = typeOf(it);
      const exists = S.trips.some((t) => t.items.some((x) => x.id === it.id));
      return html`<div class="card add-card t-${it.type}">
        <div class="entry-top"><span class="tile">${icon(T.icon)}</span><span class="entry-kicker">${T.label}${exists ? ' · replaces the existing one' : ''}</span>${chip(it.status)}</div>
        <div class="entry-title">${itemTitle(it)}</div>
        ${itemSubtitle(it) ? html`<div class="entry-sub">${itemSubtitle(it)}</div>` : ''}
        <div class="kvs-mini">
          <span>${fmtDay(it.date)}${it.time ? ` · ${it.time}` : ''}${it.endDate && it.endDate !== it.date ? ` → ${fmtDay(it.endDate)}${it.endTime ? ` · ${it.endTime}` : ''}` : ''}</span>
          ${it.ref ? html`<span class="mono">${it.ref}</span>` : ''}
          ${it.cost && Number(it.cost.amount) ? html`<span>${money(it.cost.amount)} · ${COST_STATUS[it.cost.status || 'unknown']}</span>` : ''}
        </div></div>`;
    })}
    ${target ? html`<form data-form="add" onsubmit="return false">
      ${editable.length > 1 ? html`<label class="fld"><span>Add to trip</span><select name="tripId">${editable.map((t) => html`<option value="${t.id}" ${t.id === target.id ? raw('selected') : ''}>${t.name} · ${fmtRange(t.start, t.end)}</option>`)}</select></label>`
        : html`<input type="hidden" name="tripId" value="${target.id}"><p class="hint">Adding to <b>${target.name}</b> (${fmtRange(target.start, target.end)}).</p>`}
      <button class="btn primary wide" data-act="apply-add">${icon('plus')} Add to my trip</button>
      <a class="btn ghost wide" href="#/today" data-act="close-add">Not now</a>
    </form>` : html`<div class="banner warn">${icon('alert', 'sm')}<div><b>No trip to add it to</b><span>Create or import a trip first, then open this link again.</span></div></div>`}
  </div>`;
};

VIEWS.inbox = (t) => {
  const items = t ? [...t.items].sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))) : [];
  return html`${subBar('Shared files', 'tickets')}<div class="page">
    ${!S.inbox.length ? html`<div class="empty"><p>Nothing waiting.</p></div>` : html`
    <p class="lead">Choose which booking ${S.inbox.length === 1 ? 'this file belongs' : 'these files belong'} to.</p>
    ${S.inbox.map((f) => html`<div class="card inbox-row">
      ${f.type?.startsWith('image/') ? html`<img src="${inboxUrl(f)}" alt="">` : html`<span class="thumb-file">${icon('file')}</span>`}
      <div class="inbox-main"><b>${f.name}</b>
        <select data-inbox="${f.id}" aria-label="Booking">${items.map((it) => html`<option value="${it.id}">${fmtDay(it.date)} · ${itemTitle(it)}</option>`)}</select>
        <div class="row-btns"><button class="btn primary xs" data-act="inbox-attach" data-id="${f.id}">Attach</button>
        <button class="btn ghost xs" data-act="inbox-discard" data-id="${f.id}">Discard</button></div></div>
    </div>`)}`}
  </div>`;
};

const inboxUrls = new Map();
function inboxUrl(f) {
  if (!inboxUrls.has(f.id)) inboxUrls.set(f.id, URL.createObjectURL(f.blob));
  return inboxUrls.get(f.id);
}
async function refreshInbox() {
  try { S.inbox = (await takeInbox()).rows; } catch { S.inbox = []; }
}

/* =====================================================================
   Sheets, toasts, dialogs
   ===================================================================== */

const sheetRoot = document.getElementById('sheet');
let sheetSubmit = null;

function openSheet({ title, body, submit = 'Save', onSubmit, extra = '' }) {
  sheetSubmit = onSubmit;
  sheetRoot.innerHTML = String(html`<div class="sheet-bg" data-act="close-sheet"></div>
    <form class="sheet-panel" data-form="sheet" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="grab"></div><h3>${title}</h3>${body}
      <div class="sheet-actions">${extra}<button type="button" class="btn ghost" data-act="close-sheet">Cancel</button>${submit ? html`<button class="btn primary">${submit}</button>` : ''}</div>
    </form>`);
  sheetRoot.classList.add('open');
  const first = sheetRoot.querySelector('input:not([type=hidden]):not([type=checkbox]), textarea, select');
  if (first) setTimeout(() => first.focus(), 60);
}

function closeSheet() {
  sheetRoot.classList.remove('open');
  sheetRoot.innerHTML = '';
  sheetSubmit = null;
}

function confirmBox(message, ok = 'Delete', danger = true) {
  return new Promise((resolve) => {
    openSheet({
      title: message, body: '', submit: ok,
      onSubmit: () => { resolve(true); },
    });
    const b = sheetRoot.querySelector('.btn.primary');
    if (danger) b.classList.add('danger');
    sheetRoot.querySelectorAll('[data-act=close-sheet]').forEach((el) => el.addEventListener('click', () => resolve(false), { once: true }));
  });
}

let toastTimer;
function toast(msg, action) {
  const el = document.getElementById('toast');
  el.innerHTML = String(html`<span>${msg}</span>${action ? html`<button data-act="${action.act}">${action.label}</button>` : ''}`);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 8000 : 2600);
}

/* =====================================================================
   Files: add, detect barcode, export
   ===================================================================== */

const fileInput = document.getElementById('file-input');
const importInput = document.getElementById('import-input');
let pendingItem = null;

async function detectBarcode(blob) {
  if (!('BarcodeDetector' in window) || !blob.type.startsWith('image/')) return null;
  try {
    const bmp = await createImageBitmap(blob);
    const codes = await new BarcodeDetector().detect(bmp);
    if (!codes.length) return null;
    const c = codes.sort((a, b) => b.boundingBox.width * b.boundingBox.height - a.boundingBox.width * a.boundingBox.height)[0];
    const bb = c.boundingBox;
    return { format: c.format, value: c.rawValue, box: { x: bb.x, y: bb.y, w: bb.width, h: bb.height } };
  } catch {
    return null;
  }
}

async function addFiles(itemId, fileList) {
  const t = trip();
  let found = 0;
  const existing = filesFor(itemId).length;
  let i = 0;
  for (const file of fileList) {
    const blob = file.blob || file;
    const rec = {
      id: uid('f_'), tripId: t.id, itemId, name: file.name || 'ticket', type: blob.type || file.type,
      size: blob.size, blob, createdAt: new Date().toISOString(), order: existing + i++,
    };
    rec.barcode = await detectBarcode(blob);
    if (rec.barcode) found++;
    await db.put('files', rec);
    S.files.push(rec);
  }
  askPersist();
  render();
  const n = fileList.length;
  toast(`${n} ticket${n === 1 ? '' : 's'} added${found ? ` · ${found} barcode${found === 1 ? '' : 's'} found` : ''}`);
}

fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (files.length && pendingItem) await addFiles(pendingItem, files);
});

importInput.addEventListener('change', async () => {
  const file = importInput.files[0];
  importInput.value = '';
  if (file) await importBundleFile(file);
});

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

async function shareOrDownload(name, blob, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  download(name, blob);
  return true;
}

async function importBundleFile(file) {
  let bundle;
  try { bundle = parseBundle(await file.text()); }
  catch (e) { toast(e.message.includes('Travel Pack') ? e.message : 'That file could not be read.'); return; }
  const nFiles = bundle.files.length;
  const clashes = bundle.trips.filter((t) => S.trips.some((x) => x.id === t.id));
  openSheet({
    title: bundle.kind === 'backup' ? 'Restore backup?' : `Import “${bundle.trips[0]?.name}”?`,
    body: html`<p>${bundle.trips.length} trip${bundle.trips.length === 1 ? '' : 's'} · ${nFiles} ticket${nFiles === 1 ? '' : 's'}.</p>
      ${clashes.length ? html`<label class="check"><input type="checkbox" name="copy"><span>Keep my current version too (import as a copy)</span></label>
      <p class="hint">Otherwise ${clashes.map((c) => c.name).join(', ')} will be replaced.</p>` : ''}`,
    submit: 'Import',
    onSubmit: async (fd) => {
      const asCopy = fd.get('copy') === 'on';
      for (const t of bundle.trips) {
        let target = t;
        const idMap = {};
        if (asCopy && S.trips.some((x) => x.id === t.id)) {
          target = { ...structuredClone(t), id: uid('trip_'), name: `${t.name} (copy)` };
        } else if (S.trips.some((x) => x.id === t.id)) {
          await db.delWhere('files', 'tripId', t.id);
        }
        idMap[t.id] = target.id;
        await saveTrip(target, { quiet: true });
        for (const f of bundle.files.filter((f) => f.tripId === t.id)) {
          await db.put('files', { ...f, id: asCopy ? uid('f_') : f.id, tripId: target.id });
        }
        if (bundle.trips.length === 1) await setCurrentTrip(target.id);
      }
      if (!S.tripId) await setCurrentTrip(S.trips[0].id);
      await loadFiles();
      toast('Imported');
      go('today');
      render();
    },
  });
}

/* =====================================================================
   Wake lock (keeps the screen on while a ticket is shown)
   ===================================================================== */

let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } }
  catch { /* battery saver etc. */ }
}
function releaseWakeLock() { wakeLock?.release().catch(() => {}); wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.route.name === 'ticket') requestWakeLock();
  if (document.visibilityState === 'visible') tick();
});

/* =====================================================================
   Actions
   ===================================================================== */

function shareOpts() {
  const fd = new FormData(document.querySelector('form[data-form=share]'));
  return { refs: fd.get('refs') === 'on', contacts: fd.get('contacts') === 'on', notes: fd.get('notes') === 'on', costs: fd.get('costs') === 'on' };
}

async function copyText(v, label) {
  try { await navigator.clipboard.writeText(v); toast(`Copied ${label || v}`); }
  catch { toast(v); }
}

function personSheet(p) {
  const t = trip();
  openSheet({
    title: p ? 'Edit person' : 'Add person',
    body: html`<label class="fld"><span>Name</span><input name="name" value="${p?.name || ''}" required></label>
      <label class="fld"><span>Phone</span><input name="phone" type="tel" value="${p?.phone || ''}" placeholder="07…"></label>
      <label class="fld"><span>Role</span><input name="role" value="${p?.role || ''}" placeholder="e.g. Lift to Heathrow, Hosts in Somerset"></label>`,
    extra: p ? html`<button type="button" class="btn danger-ghost" data-act="del-person" data-id="${p.id}">Delete</button>` : '',
    onSubmit: async (fd) => {
      const rec = { id: p?.id || uid('p_'), name: String(fd.get('name')).trim(), phone: String(fd.get('phone')).trim(), role: String(fd.get('role')).trim() };
      const i = t.people.findIndex((x) => x.id === rec.id);
      if (i >= 0) t.people[i] = rec; else t.people.push(rec);
      closeSheet();
      await saveTrip(t);
    },
  });
}

function tripSheet() {
  const today = isoDate(now());
  openSheet({
    title: 'New trip',
    body: html`<label class="fld"><span>Name</span><input name="name" required placeholder="e.g. Spring 2027"></label>
      <div class="two"><label class="fld"><span>First day</span><input type="date" name="start" value="${today}" required></label>
      <label class="fld"><span>Last day</span><input type="date" name="end" value="${addDays(today, 7)}" required></label></div>`,
    submit: 'Create',
    onSubmit: async (fd) => {
      const start = String(fd.get('start')), end = String(fd.get('end'));
      if (end < start) { toast('The last day is before the first day.'); return false; }
      const t = newTrip({ name: String(fd.get('name')).trim(), start, end });
      await saveTrip(t, { quiet: true });
      await setCurrentTrip(t.id);
      closeSheet();
      go('plan');
    },
  });
}

const ACT = {
  back(el, e) {
    // Use history when the previous page was inside the app; otherwise follow the link.
    if (history.length > 1 && S.cameFromApp) { e.preventDefault(); history.back(); }
  },
  'close-sheet': () => closeSheet(),
  copy: (el) => copyText(el.dataset.v),
  'goto-day': (el, e) => { e.preventDefault(); S.pendingDay = el.dataset.day; go('plan'); },
  'new-item': () => {
    openSheet({
      title: 'Add a booking', submit: '',
      body: html`<div class="type-grid">${Object.entries(TYPES).map(([k, v]) => html`<button type="button" class="type-opt" data-act="pick-type" data-type="${k}">${icon(v.icon)}<span>${v.label}</span></button>`)}</div>`,
    });
  },
  'pick-type': (el) => { closeSheet(); S.draft = null; go(`new/${el.dataset.type}`); },
  'add-files': (el) => { pendingItem = el.dataset.item; fileInput.click(); },
  async 'del-item'(el) {
    const t = trip();
    const it = t.items.find((i) => i.id === el.dataset.item);
    if (!it) return;
    const n = filesFor(it.id).length;
    if (!(await confirmBox(`Delete “${itemTitle(it)}”${n ? ` and its ${n} ticket${n === 1 ? '' : 's'}` : ''}?`))) return;
    closeSheet();
    t.items = t.items.filter((i) => i.id !== it.id);
    await db.delWhere('files', 'itemId', it.id);
    S.files = S.files.filter((f) => f.itemId !== it.id);
    S.draft = null;
    await saveTrip(t, { quiet: true });
    toast('Booking deleted');
    go('plan');
  },
  async 'dup-item'(el) {
    const t = trip();
    const it = t.items.find((i) => i.id === el.dataset.item);
    const copy = { ...structuredClone(it), id: uid('it_') };
    t.items.splice(t.items.indexOf(it) + 1, 0, copy);
    await saveTrip(t, { quiet: true });
    go(`edit/${copy.id}`);
  },
  async 'mark-paid'(el) {
    const t = trip();
    const it = t.items.find((i) => i.id === el.dataset.item);
    it.cost = { ...it.cost, status: 'paid' };
    await saveTrip(t);
    toast(`Marked ${money(it.cost.amount)} as paid`);
  },
  'book-now': (el, e) => {
    e.preventDefault();
    const t = trip();
    const it = t.items.find((i) => i.id === el.dataset.item);
    S.draft = { ...structuredClone(it), status: 'confirmed' };
    go(`edit/${it.id}`);
  },
  'toggle-crop': (el, e) => {
    if (e.target.closest('.v-pdf')) return;
    const f = S.files.find((x) => x.id === S.route.parts[0]);
    if (!f?.barcode) return;
    S.showWhole = !S.showWhole;
    render();
  },
  'open-file': (el) => {
    const f = S.files.find((x) => x.id === el.dataset.file);
    window.open(fileUrl(f), '_blank');
  },
  'file-menu': (el) => {
    const f = S.files.find((x) => x.id === el.dataset.file);
    const t = trip();
    openSheet({
      title: 'Ticket',
      body: html`<label class="fld"><span>Label</span><input name="label" value="${f.label || ''}" placeholder="e.g. Boarding pass, Outbound"></label>
        <label class="fld"><span>Booking</span><select name="itemId">${t.items.map((it) => html`<option value="${it.id}" ${it.id === f.itemId ? raw('selected') : ''}>${fmtDay(it.date)} · ${itemTitle(it)}</option>`)}</select></label>
        ${f.barcode ? html`<p class="hint">Barcode found: ${f.barcode.format.replace(/_/g, ' ').toUpperCase()}</p>` : html`<p class="hint">No barcode was found automatically, so the whole image is shown.</p>`}`,
      extra: html`<button type="button" class="btn danger-ghost" data-act="del-file" data-file="${f.id}">Delete</button>`,
      onSubmit: async (fd) => {
        f.label = String(fd.get('label')).trim();
        f.itemId = String(fd.get('itemId'));
        await db.put('files', f);
        closeSheet();
        render();
      },
    });
  },
  async 'del-file'(el) {
    const f = S.files.find((x) => x.id === el.dataset.file);
    closeSheet();
    if (!(await confirmBox('Delete this ticket?'))) return;
    closeSheet();
    await db.del('files', f.id);
    S.files = S.files.filter((x) => x.id !== f.id);
    toast('Ticket deleted');
    go(`item/${f.itemId}`);
  },
  async 'toggle-todo'(el) {
    const t = trip();
    const c = t.checklist.find((x) => x.id === el.dataset.id);
    c.done = !c.done;
    await saveTrip(t);
  },
  'edit-todo': (el) => {
    const t = trip();
    const c = t.checklist.find((x) => x.id === el.dataset.id);
    openSheet({
      title: 'Edit to-do',
      body: html`<label class="fld"><span>To-do</span><textarea name="text" rows="3" required>${c.text}</textarea></label>
        <label class="fld"><span>By (optional)</span><input type="date" name="due" value="${c.due || ''}"></label>`,
      extra: html`<button type="button" class="btn danger-ghost" data-act="del-todo" data-id="${c.id}">Delete</button>`,
      onSubmit: async (fd) => {
        c.text = String(fd.get('text')).trim();
        c.due = String(fd.get('due') || '');
        closeSheet();
        await saveTrip(t);
      },
    });
  },
  async 'del-todo'(el) {
    const t = trip();
    t.checklist = t.checklist.filter((x) => x.id !== el.dataset.id);
    closeSheet();
    await saveTrip(t);
  },
  'edit-person': (el) => personSheet(trip().people.find((p) => p.id === el.dataset.id)),
  async 'del-person'(el) {
    const t = trip();
    t.people = t.people.filter((p) => p.id !== el.dataset.id);
    for (const it of t.items) it.people = (it.people || []).filter((id) => id !== el.dataset.id);
    closeSheet();
    await saveTrip(t);
  },
  'new-trip': () => tripSheet(),
  async 'open-trip'(el) {
    await setCurrentTrip(el.dataset.id);
    go('today');
  },
  async 'del-trip'(el) {
    const t = S.trips.find((x) => x.id === el.dataset.id);
    const n = (await db.byIndex('files', 'tripId', t.id)).length;
    if (!(await confirmBox(`Delete “${t.name}”${n ? ` and ${n} ticket${n === 1 ? '' : 's'}` : ''}? This cannot be undone.`))) return;
    closeSheet();
    await db.del('trips', t.id);
    await db.delWhere('files', 'tripId', t.id);
    S.trips = S.trips.filter((x) => x.id !== t.id);
    await setCurrentTrip(pickDefaultTrip()?.id || null);
    toast('Trip deleted');
    go('today');
  },
  'import-file': () => importInput.click(),
  async 'export-trip'() {
    const t = trip();
    const json = await exportBundle('trip', [t], S.files);
    await shareOrDownload(`${slug(t.name)}.travelpack.json`, new Blob([json], { type: 'application/json' }), t.name);
  },
  async 'backup-share'() { await doBackup(true); },
  async 'backup-download'() { await doBackup(false); },
  async 'export-ics'() {
    const t = trip();
    const blob = new Blob([tripToIcs(t)], { type: 'text/calendar' });
    openSheet({
      title: 'Add to calendar',
      body: html`<p>This makes a calendar file with every booking, plus reminders 1 day and 3 hours before each flight or ferry (1 hour before trains).</p>
        <p class="hint">On Android, <b>Share</b> and choose your calendar app. If Google Calendar isn't offered, save the file and import it at calendar.google.com (Settings → Import). Each booking also has its own “Add to Google Calendar” button.</p>`,
      submit: '',
      extra: html`<button type="button" class="btn" data-act="ics-download">${icon('download')} Save file</button><button type="button" class="btn primary" data-act="ics-share">${icon('share')} Share</button>`,
    });
    S.icsBlob = blob;
  },
  async 'ics-share'() {
    const name = `${slug(trip().name)}.ics`;
    const file = new File([S.icsBlob], name, { type: 'text/calendar' });
    closeSheet();
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: trip().name }); } catch { /* cancelled */ }
    } else download(name, S.icsBlob);
  },
  'ics-download': () => { closeSheet(); download(`${slug(trip().name)}.ics`, S.icsBlob); },
  async 'share-link'(el, e) {
    e.preventDefault();
    const t = trip();
    const url = await shareLink(t, shareOpts(), S.me);
    const text = `${t.name} (${fmtRange(t.start, t.end)}): my travel plan. Opens offline in Travel Pack.`;
    if (navigator.share) {
      try { await navigator.share({ title: t.name, text, url }); return; } catch (err) { if (err.name === 'AbortError') return; }
    }
    copyText(url, 'link');
  },
  async 'share-text'(el, e) {
    e.preventDefault();
    const t = trip();
    const text = shareText(t, shareOpts());
    if (navigator.share) {
      try { await navigator.share({ title: t.name, text }); return; } catch (err) { if (err.name === 'AbortError') return; }
    }
    copyText(text, 'itinerary');
  },
  async 'save-preview'() {
    const p = S.preview;
    const existing = S.trips.find((x) => x.sourceId === p.trip.id || x.id === p.trip.id);
    // Saving your own trip back from your own link would overwrite the editable
    // original with a redacted copy — keep both instead.
    const own = existing && !existing.readOnly;
    const t = {
      ...structuredClone(p.trip),
      id: own || !existing ? uid('trip_') : existing.id,
      sourceId: p.trip.id, readOnly: true, sharedFrom: p.from, sharedAt: p.sharedAt,
      checklist: [],
    };
    // A setup link (tools/make-link.mjs) hands over the owner's own trip, fully editable.
    if (p.editable) { delete t.readOnly; delete t.sourceId; delete t.sharedFrom; t.id = p.trip.id; t.checklist = p.trip.checklist || []; }
    await saveTrip(t, { quiet: true });
    await setCurrentTrip(t.id);
    S.preview = null;
    toast(existing && !own ? 'Updated' : 'Saved to this phone');
    go('today');
  },
  'close-preview': () => { S.preview = null; },
  'close-add': () => { S.incoming = null; },
  async 'apply-add'(el, e) {
    e.preventDefault();
    const fd = new FormData(el.closest('form'));
    const t = S.trips.find((x) => x.id === fd.get('tripId'));
    if (!t) return;
    const items = S.incoming.items.map((it) => ({ people: [], ...structuredClone(it) }));
    for (const it of items) putItem(t, it);
    S.incoming = null;
    await saveTrip(t, { quiet: true });
    if (S.tripId !== t.id) await setCurrentTrip(t.id);
    toast(items.length === 1 ? 'Booking added' : `${items.length} bookings added`);
    history.replaceState(null, '', `#/item/${items[0].id}`);
    onRoute();
  },
  async 'make-editable'() {
    const t = trip();
    if (!(await confirmBox('Make this an editable copy? It will no longer update from share links.', 'Make editable', false))) return;
    closeSheet();
    delete t.readOnly; delete t.sourceId;
    t.checklist = t.checklist || [];
    await saveTrip(t);
    toast('You can now edit this trip');
  },
  'set-name': () => {
    openSheet({
      title: 'Your name',
      body: html`<label class="fld"><span>Name</span><input name="me" value="${S.me}" placeholder="e.g. Clive"></label><p class="hint">Shown to people you share a trip with.</p>`,
      onSubmit: async (fd) => { S.me = String(fd.get('me')).trim(); await db.put('meta', S.me, 'me'); closeSheet(); render(); },
    });
  },
  async install() {
    if (!S.installPrompt) return;
    S.installPrompt.prompt();
    await S.installPrompt.userChoice;
    S.installPrompt = null;
    render();
  },
  'apply-update': () => { S.updateReady?.postMessage('skipWaiting'); },
  async 'inbox-attach'(el) {
    const f = S.inbox.find((x) => x.id === el.dataset.id);
    const itemId = document.querySelector(`select[data-inbox="${f.id}"]`).value;
    await addFiles(itemId, [{ blob: f.blob, name: f.name }]);
    (await takeInbox()).remove(f.id);
    await refreshInbox();
    if (!S.inbox.length) go(`item/${itemId}`); else render();
  },
  async 'inbox-discard'(el) {
    (await takeInbox()).remove(el.dataset.id);
    await refreshInbox();
    render();
  },
};

async function doBackup(share) {
  const trips = await db.getAll('trips');
  const files = await db.getAll('files');
  const json = await exportBundle('backup', trips, files);
  const blob = new Blob([json], { type: 'application/json' });
  const name = `travel-pack-backup-${isoDate(new Date())}.json`;
  const ok = share ? await shareOrDownload(name, blob, 'Travel Pack backup') : (download(name, blob), true);
  if (ok) {
    S.lastBackup = new Date().toISOString();
    await db.put('meta', S.lastBackup, 'lastBackup');
    toast(`Backup ready · ${fmtBytes(blob.size)}`);
    render();
  }
}

/** Add or replace a booking, keeping date order and the trip's date range. */
function putItem(t, d) {
  const i = t.items.findIndex((x) => x.id === d.id);
  if (i >= 0) t.items[i] = d;
  else {
    // Insert in date order so untimed items keep a sensible position.
    const at = t.items.findIndex((x) => (x.date + (x.time || '')) > (d.date + (d.time || '99')));
    if (at < 0) t.items.push(d); else t.items.splice(at, 0, d);
  }
  if (!t.start || d.date < t.start) t.start = d.date;
  if (!t.end || (d.endDate || d.date) > t.end) t.end = d.endDate || d.date;
}

const FORMS = {
  async item(fd, form) {
    const t = trip();
    const d = readItemForm(form, S.draft);
    if (d.type === 'train') {
      if (!d.fromCode) d.fromCode = stationCode(d.from);
      if (!d.toCode) d.toCode = stationCode(d.to);
      d.fromCode = (d.fromCode || '').toUpperCase(); d.toCode = (d.toCode || '').toUpperCase();
    }
    if (d.endTime && !d.endDate) d.endDate = d.date;
    if (d.endDate && d.endDate < d.date) { toast(`${typeOf(d).when[1]} is before ${typeOf(d).when[0].toLowerCase()}.`); return; }
    if (d.endDate === d.date && d.time && d.endTime && d.endTime < d.time && isTransport(d)) d.endDate = addDays(d.date, 1);
    putItem(t, d);
    S.draft = null;
    await saveTrip(t, { quiet: true });
    toast('Saved');
    history.replaceState(null, '', `#/item/${d.id}`);
    onRoute();
  },
  async todo(fd, form) {
    const t = trip();
    const text = String(fd.get('text') || '').trim();
    if (!text) return;
    t.checklist = t.checklist || [];
    t.checklist.push({ id: uid('c_'), text, done: false });
    await saveTrip(t);
    document.querySelector('form[data-form=todo] input')?.focus();
  },
  async trip(fd) {
    const t = trip();
    t.name = String(fd.get('name')).trim();
    t.start = String(fd.get('start'));
    t.end = String(fd.get('end'));
    t.notes = String(fd.get('notes') || '');
    if (t.end < t.start) { toast('The last day is before the first day.'); return; }
    await saveTrip(t, { quiet: true });
    toast('Saved');
    go('more');
  },
  async sheet(fd) {
    if (sheetSubmit) await sheetSubmit(fd);
  },
};

const CHANGE = {
  type(el) {
    const form = el.closest('form');
    S.draft = readItemForm(form, S.draft);
    S.draft.type = el.value;
    render();
  },
  seg(el) {
    el.closest('.seg').querySelectorAll('label').forEach((l) => l.classList.toggle('on', l.contains(el)));
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el) {
    const fn = ACT[el.dataset.act];
    if (fn) {
      if (el.tagName === 'BUTTON' && el.type !== 'submit') e.preventDefault();
      fn(el, e);
    }
    return;
  }
  const a = e.target.closest('a[data-replace]');
  if (a) { e.preventDefault(); history.replaceState(null, '', a.getAttribute('href')); onRoute(); }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fn = FORMS[form.dataset.form];
  if (fn) fn(new FormData(form), form);
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && CHANGE[el.dataset.change]) CHANGE[el.dataset.change](el);
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

/* =====================================================================
   Live bits: countdowns, network state, service worker
   ===================================================================== */

function tick() {
  const n = now();
  document.querySelectorAll('[data-due]').forEach((el) => { el.textContent = fmtUntil(new Date(Number(el.dataset.due)), n); });
}
setInterval(tick, 30000);

// Re-render Today at midnight / when the next moment passes.
let lastMinuteKey = '';
setInterval(() => {
  const n = now();
  const key = isoDate(n) + hhmm(n).slice(0, 4);
  if (key !== lastMinuteKey && S.route.name === 'today' && !sheetRoot.classList.contains('open')) { lastMinuteKey = key; render(); }
}, 60000);

window.addEventListener('online', () => { S.online = true; if (!S.draft) render(); });
window.addEventListener('offline', () => { S.online = false; if (!S.draft) render(); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; if (!S.draft) render(); });
window.addEventListener('hashchange', () => { S.cameFromApp = true; onRoute(); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const watch = (w) => w && w.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) {
        S.updateReady = w;
        toast('A new version is ready', { act: 'apply-update', label: 'Reload' });
      }
    });
    if (reg.waiting && navigator.serviceWorker.controller) { S.updateReady = reg.waiting; }
    reg.addEventListener('updatefound', () => watch(reg.installing));
    setInterval(() => reg.update().catch(() => {}), 6 * 3600000);
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading && S.updateReady) { reloading = true; location.reload(); } });
}

/* =====================================================================
   Boot
   ===================================================================== */

(async function boot() {
  try {
    await loadAll();
    if (navigator.storage?.persisted) S.persisted = await navigator.storage.persisted();
    await refreshInbox();
  } catch (e) {
    console.error(e);
    root.innerHTML = String(html`<div class="page"><div class="empty">${icon('alert')}<h2>Storage unavailable</h2><p>This browser blocked local storage (private mode?). Travel Pack needs it to keep your trips offline.</p></div></div>`);
    return;
  }
  await onRoute();
  if (S.inbox.length && S.route.name !== 'inbox') toast(`${S.inbox.length} shared file${S.inbox.length === 1 ? '' : 's'} waiting`, { act: 'goto-inbox', label: 'Attach' });
})();

ACT['goto-inbox'] = () => go('inbox');

// Exposed for debugging from the console.
window.__tp = { S, db, render };
