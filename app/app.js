import { html, raw, esc, uid, parseDate, isoDate, hhmm, addDays, daysBetween, fmtDay, fmtLongDay, fmtRange, fmtDuration, fmtUntil, money, fmtBytes, slug } from './util.js';
import { db, takeInbox } from './db.js';
import { icon } from './icons.js';
import {
  STATUS, COST_STATUS, TYPES, typeOf, isTransport, isStay, itemTitle, itemSubtitle, startOf, endOf,
  buildDays, tonight, moments, toBook, costs, liveLinks, stationCode, newTrip, mapsUrl, telHref, whatsappHref,
} from './model.js';
import { tripToIcs, googleCalendarUrl } from './ics.js';
import { shareLink, readShareLink, readAddLink, shareText, exportBundle, parseBundle } from './share.js';
import { api, loadServer, getServer, setServer, readConnectLink, joinLink, readJoinLink, redeemInvite } from './api.js';
import { stampChanges, tombstone, mergeTrips, forServer, sameContent } from './merge.js';
import { geocode, forecast, daily, hourly, legRisk, isWeatherSensitive, describeCode } from './weather.js';

const APP_VERSION = '2.0.0';

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
  snap: new Map(),      // last saved copy of each trip, to work out what changed
  synced: {},           // tripId → { rev, at } for trips shared live through the server
  sync: { state: 'idle', error: '' },
  account: null,        // what the server says about this phone's user (/api/me)
  incomingConnect: null,
  incomingJoin: null,   // an invite to share a trip live, not yet accepted
  invite: null,         // the last invite this phone created { tripId, name, link, expiresAt }
  installHint: false,   // after joining: show how to put the app on the home screen
  weather: {},          // place name → { geo, data }
  chat: {},             // tripId → [{ role, content, changes }]
  chatBusy: false,
  docs: [],             // personal documents (passport, insurance…), never synced
  docFiles: [],
  ai: null,             // last AI extraction, waiting for review
  aiBusy: '',
  email: { q: '', results: null, msg: null, busy: false, error: '' },
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
  S.synced = (await db.get('meta', 'synced')) || {};
  S.docs = (await db.get('meta', 'docs')) || [];
  S.installHint = !!(await db.get('meta', 'installHint')) && !isStandalone();
  for (const t of S.trips) S.snap.set(t.id, structuredClone(t));
  await loadServer();
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
  // Stamp what changed since the last save, so two phones can merge edits.
  stampChanges(S.snap.get(t.id), t);
  t.updatedAt = new Date().toISOString();
  await storeTrip(t);
  if (S.synced[t.id]) scheduleSync(t.id);
  if (!quiet) render();
}

/** Write a trip as-is (used for saves and for copies arriving from the server). */
async function storeTrip(t) {
  await db.put('trips', t);
  S.snap.set(t.id, structuredClone(t));
  const i = S.trips.findIndex((x) => x.id === t.id);
  if (i >= 0) S.trips[i] = t;
  else S.trips.push(t);
  S.trips.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  askPersist();
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

const TABS = ['today', 'plan', 'tickets', 'docs', 'todo', 'more'];

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '').split('?')[0];
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
  if (location.hash.startsWith('#connect=')) {
    try {
      S.incomingConnect = readConnectLink(location.hash.slice(1));
      history.replaceState(null, '', '#/connect');
    } catch {
      toast('That connect link could not be read.');
      history.replaceState(null, '', '#/today');
    }
  }
  if (location.hash.startsWith('#join=')) {
    try {
      S.incomingJoin = readJoinLink(location.hash.slice(1));
      history.replaceState(null, '', '#/join');
    } catch {
      toast('That invite link could not be read. It may have been cut short when it was copied.');
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
  if (S.route.name === 'sync') { S.serverTrips = null; loadServerTrips(); }
  if (S.route.name === 'join' && !S.incomingJoin) { history.replaceState(null, '', '#/today'); S.route = parseRoute(); }
  if (S.route.name === 'connect' && !S.incomingConnect) { history.replaceState(null, '', '#/today'); S.route = parseRoute(); }
  if (S.route.name === 'inbox') await refreshInbox();
  if (S.route.name === 'email' && /gmail=connected/.test(location.hash)) { toast('Gmail connected'); refreshAccount(); }
  if (S.route.name === 'email' && /gmail=error/.test(location.hash)) toast('Gmail was not connected. Try again.');
  if (['docs', 'doc'].includes(S.route.name) || (S.route.name === 'ticket' && S.route.parts[0]?.startsWith('d'))) await loadDocFiles();
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
    const f = anyFile(c.dataset.crop);
    if (f) drawCrop(c, f);
  });
}

function navBar() {
  const t = trip();
  const badge = t && !t.readOnly ? (t.checklist || []).filter((c) => !c.done).length + toBook(t).length : 0;
  const tabs = [
    ['today', 'sun', 'Today'], ['plan', 'calendar', 'Plan'], ['tickets', 'wallet', 'Wallet'],
    ['todo', 'checklist', 'To-do'], ['more', 'menu', 'More'],
  ];
  const on = (k) => S.route.name === k || (k === 'tickets' && S.route.name === 'docs');
  return html`<nav class="nav" aria-label="Main">${tabs.map(([k, ic, label]) => html`
    <a href="#/${k}" class="${on(k) ? 'on' : ''}" ${on(k) ? raw('aria-current="page"') : ''}>
      <span class="nav-ic">${icon(ic)}${k === 'todo' && badge ? html`<b class="badge">${badge}</b>` : ''}</span>${label}</a>`)}</nav>`;
}

function topBar(t) {
  return html`<header class="top">
    <a class="trip-switch" href="#/trips" aria-label="Switch trip">
      <span class="top-name">${t ? t.name : 'Travel Pack'}</span>
      ${t ? html`<span class="top-dates">${fmtRange(t.start, t.end)} ${icon('down', 'sm')}</span>` : ''}
    </a>
    ${netPill()}${syncPill(t)}
    ${getServer() && S.account?.ai && t && !t.readOnly ? html`<a class="icon-btn ask-btn" href="#/ask" aria-label="Ask Travel Pack">${icon('sparkle')}</a>` : ''}
  </header>`;
}

function syncPill(t) {
  if (!t || !S.synced[t.id]) return '';
  const st = S.sync.state;
  const label = st === 'busy' ? 'Syncing' : st === 'error' ? 'Not synced' : 'Shared';
  return html`<a class="pill sync ${st}" href="#/sync" title="${S.sync.error || 'Shared live through your server'}">${icon(st === 'error' ? 'alert' : 'refresh', 'sm')} ${label}</a>`;
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
    ${riskBadge(it)}
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
      <span class="day-no">${dayWeatherChip(t, day.date)}${isToday ? html`<b class="today-tag">Today</b>` : ''}${dayNo > 0 ? `Day ${dayNo}` : ''}</span></h2>
    ${day.entries.length ? day.entries.map((e) => entryCard(e)) : html`<div class="slim quiet">${icon('sun', 'sm')}<span>Nothing planned</span></div>`}
    ${isPreview() ? '' : html`<div class="day-tools">
      ${!readOnly() ? html`<button class="mini" data-act="new-item" data-date="${day.date}">${icon('plus', 'sm')} Add</button>` : ''}
      ${!t.readOnly ? html`<a class="mini" href="#/journal/${day.date}">${icon('edit', 'sm')} Journal${journalCount(t, day.date) ? ` · ${journalCount(t, day.date)}` : ''}</a>` : ''}
    </div>`}
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
  const install = installCard();

  const hero = (m, label, at = m.at) => {
    const it = m.item;
    const tk = ticketsFor(it);
    const all = [...tk.own, ...tk.related];
    return html`<section class="hero-wrap">
      <div class="hero-label">${label} <span class="due" data-due="${at.getTime()}">${fmtUntil(at, n)}</span></div>
      ${entryCard(isStay(it) ? { kind: m.end ? 'checkout' : 'checkin', item: it, nights: daysBetween(it.date, it.endDate || it.date) } : { kind: 'item', item: it }, { hero: true })}
      ${riskBanner(it)}
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
    ${install}
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
    ${!before && !t.readOnly ? html`<a class="card tip" href="#/journal/${after ? t.end : today}">${icon('edit')}<div><b>${after ? 'Trip journal' : "Today's journal"}</b>${journalPhotos(t, today).length ? html`<span class="jn-strip">${journalPhotos(t, today).slice(0, 4).map((f) => mediaTile(f))}</span>` : ''}<span>${journalCount(t, today) ? `${journalCount(t, today)} entr${journalCount(t, today) === 1 ? 'y' : 'ies'} today` : 'A few lines and photos to remember the day by.'}</span></div>${icon('right', 'sm dim')}</a>` : ''}
    ${!t.readOnly ? html`<button class="fab" data-act="new-item" data-date="${today >= t.start && today <= t.end ? today : ''}" aria-label="Add booking">${icon('plus')}</button>` : ''}
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
      ${ro ? chip(it.status) : html`<button class="chip-btn" data-act="status-sheet" data-item="${it.id}" aria-label="Change status">${chip(it.status)}${icon('down', 'sm')}</button>`}
    </div>
    ${!ro ? html`<div class="d-quick">
      <a class="btn primary" href="#/edit/${it.id}">${icon('edit')} Edit booking</a>
      ${(tk.own.length || tk.related.length) ? html`<a class="btn" href="#/ticket/${[...tk.own, ...tk.related][0].id}">${icon('scan')} Ticket</a>` : ''}
    </div>` : ''}

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

    ${weatherSection(it)}

    ${people.length ? html`<h3 class="sec-h">People</h3><div class="card list-card">${people.map(personRow)}</div>` : ''}

    ${it.notes ? html`<h3 class="sec-h">Notes</h3><div class="card notes">${it.notes}</div>` : ''}

    ${links.length ? html`<h3 class="sec-h">Live status ${!S.online ? html`<small class="dim">· needs signal</small>` : ''}</h3>
      ${S.online ? html`<div class="card list-card">${links.map((l) => html`<a class="row" href="${l.url}" target="_blank" rel="noopener"><span class="row-ic">${icon('live')}</span><span class="row-main"><b>${l.label}</b></span>${icon('external', 'sm dim')}</a>`)}</div>`
        : html`<div class="slim quiet">${icon('offline', 'sm')}<span>Links to live status appear when you're back online.</span></div>`}` : ''}

    ${!ro ? html`<div class="d-actions">
      ${S.online ? html`<a class="btn" href="${googleCalendarUrl(it)}" target="_blank" rel="noopener">${icon('calendar')} Add to Google Calendar</a>` : ''}
      <a class="btn" href="#/edit/${it.id}">${icon('edit')} Edit booking</a>
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

    ${isTransport(d) ? html`<fieldset><legend>Weather & Plan B</legend>
      <label class="check"><input type="checkbox" name="weatherSensitive" ${isWeatherSensitive(d) ? raw('checked') : ''}><span>Warn me if weather could disrupt this leg</span></label>
      <label class="fld" style="margin-top:10px"><span>Plan B <small>what to do if it's cancelled</small></span>
      <textarea name="planB" rows="3" placeholder="e.g. Next flight is… / ferry alternative… / who to call">${d.planB || ''}</textarea></label></fieldset>` : ''}
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
  for (const k of ['type', 'status', 'title', 'provider', 'number', 'from', 'to', 'fromCode', 'toCode', 'date', 'time', 'endDate', 'endTime', 'seat', 'class', 'ref', 'eticket', 'address', 'phone', 'keyTimes', 'notes', 'links', 'planB']) {
    if (fd.has(k)) d[k] = String(fd.get(k) || '').trim();
  }
  if (form.querySelector('[name=weatherSensitive]')) d.weatherSensitive = fd.get('weatherSensitive') === 'on';
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
    ${walletTabs('tickets')}
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
  const f = anyFile(fileId);
  if (!f) return html`${subBar('Ticket', 'tickets')}<div class="page"><div class="empty"><p>Ticket not found.</p></div></div>`;
  const ctx = fileContext(f, t);
  if (ctx) return viewerFor(f, ctx);
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
      ${link('#/share', 'share', 'Share this trip', getServer() && !t?.readOnly ? 'Invite Jane or family to share it live, or send a copy' : 'Link for Jane or friends, or a plain-text itinerary')}
      <button class="row" data-act="export-ics"><span class="row-ic">${icon('calendar')}</span><span class="row-main"><b>Add to calendar</b><small>Calendar file with reminders before each departure</small></span>${icon('download', 'sm dim')}</button>
      ${ro ? html`<button class="row" data-act="make-editable"><span class="row-ic">${icon('edit')}</span><span class="row-main"><b>Make an editable copy</b><small>Stops updating from share links</small></span></button>` : ''}
    </div>` : ''}
    <h2 class="sec-h">Assistant, email & sharing</h2><div class="card list-card">
      ${getServer() ? html`
        ${S.account?.ai && t && !ro ? link('#/ask', 'sparkle', 'Ask Travel Pack', 'Questions about the trip, or changes in plain English') : ''}
        ${S.account?.gmail?.available ? link('#/email', 'message', 'Search email', S.account.gmail.connected ? `Gmail · ${S.account.gmail.email || 'connected'}` : 'Connect Gmail to find bookings') : ''}
        ${link('#/sync', 'refresh', 'Live sharing & server', t && S.synced[t.id] ? 'This trip is shared live' : `Connected as ${getServer().name}`)}`
        : link('#/sync', 'refresh', 'Live sharing, AI & email', 'Connect this phone to your Travel Pack server')}
    </div>
    <h2 class="sec-h">Keepsakes & papers</h2><div class="card list-card">
      ${t && !ro ? link(`#/journal/${isoDate(now()) >= t.start && isoDate(now()) <= t.end ? isoDate(now()) : t.start}`, 'edit', 'Journal', `${(t.journal || []).length} entr${(t.journal || []).length === 1 ? 'y' : 'ies'}`) : ''}
      ${link('#/docs', 'file', 'Documents', S.docs.length ? `${S.docs.length} saved · passport, insurance, cards` : 'Passport, insurance, railcard…')}
    </div>
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
      <p>Travel Pack ${APP_VERSION}${S.build ? ` · build ${S.build}` : ''} · works offline</p>
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

function inviteCard(t) {
  if (t.readOnly) return '';
  if (!getServer()) {
    return html`<div class="card tip static">${icon('info')}<div><b>Live sharing needs your server</b><span>Connect this phone first (More → Live sharing). Until then you can send a read-only copy below.</span></div></div>`;
  }
  const inv = S.invite?.tripId === t.id ? S.invite : null;
  return html`<div class="card invite-card">
    <div class="invite-head"><span class="tile">${icon('people')}</span><div><b>Share live with family</b>
      <small>They get the whole plan on their own phone: bookings, tickets, contacts, checklist and journal. Edits from either phone appear on both. Your documents (passport, insurance…) are never shared.</small></div></div>
    ${inv ? html`<div class="invite-ready">
        <p><b>Invite for ${inv.name} is ready.</b> Send it by WhatsApp, text or email. It works once and expires ${fmtUntil(new Date(inv.expiresAt), new Date())}.</p>
        <button type="button" class="btn primary wide" data-act="invite-send">${icon('share')} Send invite to ${inv.name}</button>
        <a class="btn wide" href="${inviteMailto(inv, t)}">${icon('message')} Email it</a>
        <button type="button" class="btn ghost wide" data-act="invite-copy">${icon('copy')} Copy link</button>
        <button type="button" class="btn ghost xs" data-act="invite-new">Invite someone else</button>
      </div>`
    : html`<label class="fld"><span>Their name</span><input name="inviteName" value="Jane" autocomplete="off"></label>
      <button type="button" class="btn primary wide" data-act="invite-create">${icon('people')} Create invite link</button>`}
  </div>`;
}

const inviteText = (inv, t) => `${S.me || getServer()?.name || 'I'} has invited you to share “${t.name}” (${fmtRange(t.start, t.end)}) in Travel Pack.

Open this link on your phone, tap Join, then add Travel Pack to your home screen. The plan stays in sync between our phones and works offline.

${inv.link}`;

const inviteMailto = (inv, t) => `mailto:?subject=${encodeURIComponent(`Travel Pack: ${t.name}`)}&body=${encodeURIComponent(inviteText(inv, t))}`;

VIEWS.share = (t) => {
  if (!t) return welcome();
  return html`${subBar('Share trip', 'more')}<form class="page form" data-form="share" onsubmit="return false">
    ${inviteCard(t)}
    <h2 class="sec-h">Send a copy</h2>
    <p class="lead">A read-only snapshot of the plan as it is now. It opens in Travel Pack and can be saved for offline use, but later changes do not reach it. Tickets are never included in a link.</p>
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
      ${f.text ? html`<span class="thumb-file">${icon('message')}</span>` : f.type?.startsWith('image/') ? html`<img src="${inboxUrl(f)}" alt="">` : html`<span class="thumb-file">${icon('file')}</span>`}
      <div class="inbox-main"><b>${f.name}</b>
        ${f.text ? html`<p class="hint clamp">${f.text}</p>` : html`<select data-inbox="${f.id}" aria-label="Booking">${items.map((it) => html`<option value="${it.id}">${fmtDay(it.date)} · ${itemTitle(it)}</option>`)}</select>`}
        <div class="row-btns">
          ${!f.text ? html`<button class="btn primary xs" data-act="inbox-attach" data-id="${f.id}">Attach</button>` : ''}
          ${getServer() && S.account?.ai ? html`<button class="btn xs" data-act="inbox-ai" data-id="${f.id}">${icon('sparkle', 'sm')} Read with AI</button>` : ''}
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
   Documents
   ===================================================================== */

const DOCS = '__docs';

const DOC_CATS = {
  passport: { label: 'Passport & ID', icon: 'lock' },
  licence: { label: 'Driving licence', icon: 'car' },
  insurance: { label: 'Travel insurance', icon: 'info' },
  car: { label: 'Car insurance', icon: 'car' },
  health: { label: 'Health & medical', icon: 'alert' },
  railcard: { label: 'Railcards & passes', icon: 'train' },
  cards: { label: 'Cards & memberships', icon: 'wallet' },
  other: { label: 'Other', icon: 'file' },
};

function anyFile(id) {
  return S.files.find((f) => f.id === id) || S.docFiles.find((f) => f.id === id) || null;
}

/** Where a non-ticket file belongs (a document or a journal entry), for the viewer. */
function fileContext(f, t) {
  if (f.tripId === DOCS) {
    const d = S.docs.find((x) => x.id === f.itemId);
    return {
      title: d?.title || 'Document', sub: d ? (DOC_CATS[d.category] || DOC_CATS.other).label : '', back: d ? `#/doc/${d.id}` : '#/docs',
      siblings: S.docFiles.filter((x) => x.itemId === f.itemId), facts: d ? [['Number', d.number], ['Expires', d.expiry ? fmtDay(d.expiry) : '']] : [],
    };
  }
  if (f.itemId?.startsWith('j_') && t) {
    const j = (t.journal || []).find((x) => x.id === f.itemId);
    return { title: 'Journal', sub: j ? fmtLongDay(j.date) : '', back: j ? `#/journal/${j.date}` : '#/plan', siblings: S.files.filter((x) => x.itemId === f.itemId), facts: [] };
  }
  return null;
}

function viewerFor(f, ctx) {
  const pos = ctx.siblings.findIndex((x) => x.id === f.id);
  const prev = ctx.siblings[pos - 1], next = ctx.siblings[pos + 1];
  const img = f.type?.startsWith('image/');
  const crop = f.barcode && !S.showWhole;
  const facts = ctx.facts.filter(([, v]) => v);
  return html`<div class="viewer">
    <header class="v-top"><a class="icon-btn" href="${ctx.back}" aria-label="Close">${icon('x')}</a>
      <div class="v-title"><b>${ctx.title}</b><small>${ctx.sub}${ctx.siblings.length > 1 ? ` · ${pos + 1} of ${ctx.siblings.length}` : ''}</small></div>
      ${!readOnly() ? html`<button class="icon-btn" data-act="del-file" data-file="${f.id}" aria-label="Delete">${icon('trash')}</button>` : ''}</header>
    <div class="v-body ${crop ? 'crop' : ''}" ${isVideo(f) ? '' : raw('data-act="toggle-crop"')}>
      ${isVideo(f) ? html`<video class="v-video" src="${fileUrl(f)}" controls playsinline preload="metadata"></video>${f.localOnly ? html`<p class="hint v-note">Too large to share (over ${fmtBytes(VIDEO_SYNC_LIMIT)}): kept on this phone only.</p>` : ''}`
      : img ? (crop ? html`<canvas data-crop="${f.id}" aria-label="Barcode"></canvas>` : html`<img src="${fileUrl(f)}" alt="">`)
        : html`<div class="v-pdf">${icon('file')}<p><b>${f.name}</b></p><button class="btn primary" data-act="open-file" data-file="${f.id}">${icon('external')} Open</button></div>`}
    </div>
    <footer class="v-foot">
      ${facts.length ? html`<div class="v-facts">${facts.map(([k, v]) => html`<div><small>${k}</small><b>${v}</b></div>`)}</div>` : ''}
      ${f.barcode && img ? html`<button class="btn xs ghost" data-act="toggle-crop">${S.showWhole ? 'Show barcode only' : 'Show whole image'}</button>` : ''}
      <div class="v-nav">
        ${prev ? html`<a class="btn ghost" href="#/ticket/${prev.id}" data-replace>${icon('left')} Prev</a>` : html`<span></span>`}
        ${next ? html`<a class="btn ghost" href="#/ticket/${next.id}" data-replace>Next ${icon('right')}</a>` : html`<span></span>`}
      </div>
    </footer>
  </div>`;
}

async function loadDocFiles() {
  S.docFiles = await db.byIndex('files', 'tripId', DOCS);
}

async function saveDocs() {
  await db.put('meta', S.docs, 'docs');
}

function walletTabs(on) {
  return html`<div class="seg-tabs" role="tablist">
    <a href="#/tickets" role="tab" class="${on === 'tickets' ? 'on' : ''}">${icon('ticket', 'sm')} Tickets</a>
    <a href="#/docs" role="tab" class="${on === 'docs' ? 'on' : ''}">${icon('file', 'sm')} Documents</a></div>`;
}

function expiryNote(d, t) {
  if (!d.expiry) return null;
  const today = isoDate(now());
  if (d.expiry < today) return { cls: 'bad', text: `Expired ${fmtDay(d.expiry)}` };
  const months = daysBetween(today, d.expiry) / 30.4;
  const tripEnd = t?.end || today;
  if (d.expiry < tripEnd) return { cls: 'bad', text: `Expires during the trip (${fmtDay(d.expiry)})` };
  if (months < 6) return { cls: 'warn', text: `Expires ${fmtDay(d.expiry)}` };
  return { cls: '', text: `Expires ${new Date(d.expiry).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}` };
}

VIEWS.docs = (t) => {
  const groups = Object.entries(DOC_CATS).map(([k, c]) => [k, c, S.docs.filter((d) => (d.category || 'other') === k)]).filter(([, , list]) => list.length);
  return html`${topBar(t)}<div class="page">
    ${walletTabs('docs')}
    ${!S.docs.length ? html`<div class="card tip static">${icon('lock')}<div><b>Your travel papers, offline</b>
      <span>Passport, insurance policy and helpline, railcard, prescriptions. Add the number and a photo of each. Documents stay on this phone and in your backups; they are never shared with anyone, including through live sharing.</span></div></div>` : ''}
    ${groups.map(([k, c, list]) => html`<h2 class="sec-h">${c.label}</h2><div class="card list-card">${list.map((d) => {
      const ex = expiryNote(d, t);
      const n = S.docFiles.filter((f) => f.itemId === d.id).length;
      return html`<a class="row" href="#/doc/${d.id}"><span class="row-ic">${icon(c.icon)}</span>
        <span class="row-main"><b>${d.title}</b><small>${[d.number ? `•••• ${String(d.number).slice(-4)}` : '', n ? `${n} photo${n === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</small></span>
        ${ex ? html`<span class="chip exp ${ex.cls}">${ex.text}</span>` : ''}${icon('right', 'sm dim')}</a>`;
    })}</div>`)}
    <button class="btn primary wide" data-act="doc-sheet">${icon('plus')} Add document</button>
  </div>`;
};

VIEWS.doc = (t, [id]) => {
  const d = S.docs.find((x) => x.id === id);
  if (!d) return html`${subBar('Document', 'docs')}<div class="page"><div class="empty"><p>Not found.</p></div></div>`;
  const files = S.docFiles.filter((f) => f.itemId === d.id);
  const ex = expiryNote(d, t);
  const c = DOC_CATS[d.category] || DOC_CATS.other;
  return html`${subBar(c.label, 'docs', html`<button class="icon-btn" data-act="doc-sheet" data-id="${d.id}" aria-label="Edit">${icon('edit')}</button>`)}
  <div class="page detail">
    <div class="d-head"><span class="tile lg">${icon(c.icon)}</span><div><h2>${d.title}</h2>${d.holder ? html`<p>${d.holder}</p>` : ''}</div>
      ${ex ? html`<span class="chip exp ${ex.cls}">${ex.text}</span>` : ''}</div>
    ${files.length ? html`<div class="thumbs">${files.map((f) => thumb(f))}</div>` : html`<div class="slim quiet">${icon('image', 'sm')}<span>No copy saved yet. Upload a PDF or photo, take a photo, or scan the page.</span></div>`}
    ${docPickers('doc-files', d.id)}
    ${d.number || d.expiry || d.phone ? html`<div class="card kvs">
      ${d.number ? html`<div class="kv"><span>Number</span><b class="mono">${d.number}</b><button class="icon-btn sm" data-act="copy" data-v="${d.number}" aria-label="Copy number">${icon('copy')}</button></div>` : ''}
      ${d.expiry ? html`<div class="kv"><span>Expires</span><b>${fmtLongDay(d.expiry)}</b></div>` : ''}
      ${d.phone ? html`<div class="kv"><span>Helpline</span><b>${d.phone}</b><a class="icon-btn sm" href="${telHref(d.phone)}" aria-label="Call">${icon('phone')}</a></div>` : ''}
    </div>` : ''}
    ${d.notes ? html`<h3 class="sec-h">Notes</h3><div class="card notes">${d.notes}</div>` : ''}
    <div class="d-actions"><button class="btn" data-act="doc-sheet" data-id="${d.id}">${icon('edit')} Edit</button>
      <button class="btn danger-ghost" data-act="del-doc" data-id="${d.id}">${icon('trash')} Delete</button></div>
  </div>`;
};

function docSheet(d) {
  openSheet({
    title: d ? 'Edit document' : 'Add document',
    body: html`<label class="fld"><span>Type</span><select name="category">${Object.entries(DOC_CATS).map(([k, c]) => html`<option value="${k}" ${(d?.category || 'passport') === k ? raw('selected') : ''}>${c.label}</option>`)}</select></label>
      <label class="fld"><span>Name</span><input name="title" required value="${d?.title || ''}" placeholder="e.g. UK passport, Aviva travel insurance"></label>
      <div class="two"><label class="fld"><span>Number</span><input name="number" class="mono" value="${d?.number || ''}"></label>
      <label class="fld"><span>Expires</span><input type="date" name="expiry" value="${d?.expiry || ''}"></label></div>
      <div class="two"><label class="fld"><span>Holder</span><input name="holder" value="${d?.holder || ''}"></label>
      <label class="fld"><span>Helpline</span><input type="tel" name="phone" value="${d?.phone || ''}"></label></div>
      <label class="fld"><span>Notes</span><textarea name="notes" rows="3">${d?.notes || ''}</textarea></label>
      <div class="fld"><span>Copy of the document <small>PDF, photo or scan</small></span>
        <div class="jn-previews"></div>${docPickers('journal-photos')}</div>`,
    onSubmit: async (fd) => {
      const files = await pickedFiles(sheetRoot);
      const rec = { id: d?.id || uid('doc_'), createdAt: d?.createdAt || new Date().toISOString() };
      for (const k of ['category', 'title', 'number', 'expiry', 'holder', 'phone', 'notes']) rec[k] = String(fd.get(k) || '').trim();
      const i = S.docs.findIndex((x) => x.id === rec.id);
      if (i >= 0) S.docs[i] = rec; else S.docs.push(rec);
      await saveDocs();
      closeSheet();
      if (files.length) { await loadDocFiles(); await addDocFiles(rec.id, files); }
      if (!d) go(`doc/${rec.id}`); else render();
    },
  });
}

/** Upload, Photo and Scan buttons. Scan uses the camera and then cleans the
 *  picture up to look like a scanned page (see enhanceScan). */
function docPickers(change, id = '') {
  const data = raw(`data-change="${change}"${id ? ` data-id="${id}"` : ''}`);
  return html`<div class="jn-actions doc-pick">
    <label class="btn">${icon('upload')} Upload<input type="file" name="files" accept="image/*,application/pdf" multiple hidden ${data}></label>
    <label class="btn">${icon('camera')} Photo<input type="file" name="camera" accept="image/*" capture="environment" hidden ${data}></label>
    <label class="btn">${icon('scan')} Scan<input type="file" name="scan" accept="image/*" capture="environment" hidden ${data}></label>
  </div>`;
}

/** Files chosen in a picker form, with Scan pictures turned into clean pages. */
async function pickedFiles(root) {
  const out = [];
  for (const input of root.querySelectorAll('input[type=file]')) {
    for (const f of input.files) {
      if (!f.size) continue;
      out.push(input.name === 'scan' ? await enhanceScan(f) : f);
    }
  }
  return out;
}

/**
 * Make a phone photo of a document read like a scan: greyscale, with the
 * levels stretched so the paper goes white and the print goes dark. It keeps
 * the whole picture (no cropping), so nothing on the page is ever cut off.
 */
async function enhanceScan(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const img = g.getImageData(0, 0, c.width, c.height);
    const px = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) {
      const y = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
      px[i] = y; hist[y]++;
    }
    const total = px.length / 4;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255 && (acc += hist[lo]) < total * 0.02; lo++);
    acc = 0;
    for (; hi > lo + 1 && (acc += hist[hi]) < total * 0.10; hi--);
    const span = Math.max(hi - lo, 1);
    for (let i = 0; i < px.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((px[i] - lo) / span) * 255));
      const out = 255 * Math.pow(v / 255, 1.2);
      px[i] = px[i + 1] = px[i + 2] = out;
    }
    g.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], (file.name || 'scan').replace(/\.\w+$/, '') + '-scan.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

async function addDocFiles(docId, fileList) {
  for (const file of fileList) {
    const rec = { id: uid('df_'), tripId: DOCS, itemId: docId, name: file.name || 'document', type: file.type, size: file.size, blob: file, createdAt: new Date().toISOString() };
    rec.barcode = await detectBarcode(file);
    await db.put('files', rec);
    S.docFiles.push(rec);
  }
  askPersist();
  render();
  const pdfs = fileList.filter((f) => f.type === 'application/pdf').length;
  toast(`${fileList.length} ${pdfs === fileList.length ? 'file' : 'item'}${fileList.length === 1 ? '' : 's'} added`);
}

/* =====================================================================
   Journal
   ===================================================================== */

const journalPhotos = (t, date) => {
  const ids = new Set((t?.journal || []).filter((j) => j.date === date).map((j) => j.id));
  return S.files.filter((f) => ids.has(f.itemId));
};

const isVideo = (f) => !!f?.type?.startsWith('video/');

/** A journal photo or video as a still tile. Videos show their first frame and a play badge. */
function mediaTile(f) {
  return isVideo(f)
    ? html`<span class="vid-tile"><video src="${fileUrl(f)}#t=0.1" preload="metadata" muted playsinline aria-label="Journal video"></video><span class="play-badge">${icon('play', 'sm')}</span></span>`
    : html`<img src="${fileUrl(f)}" alt="Journal photo" loading="lazy">`;
}

const journalCount = (t, date) => (t?.journal || []).filter((j) => j.date === date).length;

VIEWS.journal = (t, [date]) => {
  if (!t) return welcome();
  const today = isoDate(now());
  const d = date || (today >= t.start && today <= t.end ? today : t.start);
  const entries = (t.journal || []).filter((j) => j.date === d).sort((a, b) => (a.at || '').localeCompare(b.at || ''));
  const prev = d > t.start ? addDays(d, -1) : null, next = d < t.end ? addDays(d, 1) : null;
  const ro = readOnly();
  const daysWith = [...new Set((t.journal || []).map((j) => j.date))].sort();
  return html`${subBar('Journal', 'plan')}<div class="page">
    <div class="day-pager">
      ${prev ? html`<a class="icon-btn" href="#/journal/${prev}" data-replace aria-label="Previous day">${icon('left')}</a>` : html`<span class="icon-btn"></span>`}
      <div><b>${fmtLongDay(d)}</b><small>Day ${daysBetween(t.start, d) + 1}${dayWeatherChip(t, d)}</small></div>
      ${next ? html`<a class="icon-btn" href="#/journal/${next}" data-replace aria-label="Next day">${icon('right')}</a>` : html`<span class="icon-btn"></span>`}
    </div>
    ${entries.map((j) => {
      const photos = S.files.filter((f) => f.itemId === j.id);
      return html`<article class="card journal-entry">
        <header><span class="avatar sm">${(j.author || '?').charAt(0).toUpperCase()}</span><b>${j.author || 'Me'}</b><small>${j.at ? hhmm(new Date(j.at)) : ''}</small>
          ${!ro ? html`<button class="icon-btn sm" data-act="journal-edit" data-id="${j.id}" aria-label="Edit entry">${icon('edit')}</button>` : ''}</header>
        ${j.text ? html`<p>${j.text}</p>` : ''}
        ${photos.length ? html`<div class="photo-grid n${Math.min(photos.length, 3)}">${photos.map((f) => html`<a href="#/ticket/${f.id}">${mediaTile(f)}</a>`)}</div>` : ''}
        ${!ro ? html`<button class="mini" data-act="add-files" data-item="${j.id}">${icon('image', 'sm')} Add photos or videos</button>` : ''}
      </article>`;
    })}
    ${!ro ? html`<form class="card journal-new" data-form="journal">
      <input type="hidden" name="date" value="${d}">
      <textarea name="text" rows="4" placeholder="${entries.length ? 'Add more…' : 'What happened today? Where did you eat, who did you see?'}"></textarea>
      <div class="jn-previews" aria-live="polite"></div>
      <div class="jn-actions">
        <label class="btn" aria-label="Add photos or videos">${icon('image')} Gallery<input type="file" name="photos" accept="image/*,video/*" multiple hidden data-change="journal-photos"></label>
        <label class="btn" aria-label="Take a photo">${icon('camera')} Photo<input type="file" name="camera" accept="image/*" capture="environment" hidden data-change="journal-photos"></label>
        <label class="btn" aria-label="Record a video">${icon('video')} Video<input type="file" name="video" accept="video/*" capture="environment" hidden data-change="journal-photos"></label>
        <button class="btn primary">${icon('plus')} Add</button>
      </div>
    </form>` : ''}
    ${daysWith.length ? html`<h2 class="sec-h">Days with entries</h2><div class="chips">${daysWith.map((x) => html`<a class="chip-link ${x === d ? 'on' : ''}" href="#/journal/${x}" data-replace>${fmtDay(x)} · ${journalCount(t, x)}</a>`)}</div>` : ''}
    ${S.synced[t.id] ? html`<p class="hint">Shared live: entries, photos and videos appear on Jane's phone too.</p>` : ''}
  </div>`;
};

/* =====================================================================
   Weather & Plan B
   ===================================================================== */

const wxPending = new Set();
let wxRenderTimer = null;

/** True while a form on the page holds something typed or picked that is not saved yet. */
function unsavedInput() {
  return [...root.querySelectorAll('form textarea, form input[type=file]')].some((el) => (el.type === 'file' ? el.files?.length : el.value.trim()));
}

function scheduleQuietRender() {
  clearTimeout(wxRenderTimer);
  wxRenderTimer = setTimeout(() => {
    if (['edit', 'new', 'ask'].includes(S.route.name) || sheetRoot.classList.contains('open')) return;
    // A background refresh (weather, someone else's edit arriving) must not
    // wipe a half-written journal entry or chosen photos. Try again shortly.
    if (unsavedInput()) { scheduleQuietRender(); return; }
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }, 400);
}

/** Forecast for a place, if loaded. Starts loading it in the background otherwise. */
function wxFor(place) {
  if (!place) return null;
  const key = place.toLowerCase();
  if (S.weather[key]) return S.weather[key].data;
  if (!wxPending.has(key)) {
    wxPending.add(key);
    (async () => {
      const g = await geocode(place);
      const data = g ? await forecast(g.lat, g.lon) : null;
      S.weather[key] = { geo: g, data };
      if (data) scheduleQuietRender();
    })().catch(() => { S.weather[key] = { data: null }; });
  }
  return null;
}

const inForecastRange = (date) => date && date >= isoDate(now()) && daysBetween(isoDate(now()), date) <= 15;

/** Where the traveller is on a date: the last leg's destination, carried forward. */
function placeOn(t, date) {
  let place = '';
  const legs = t.items.filter((i) => isTransport(i) && i.date && i.status !== 'cancelled').sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  for (const leg of legs) {
    if (leg.date > date) { if (!place) place = leg.from; break; }
    if (leg.to) place = leg.to;
  }
  return place || legs[0]?.from || '';
}

function dayWeatherChip(t, date) {
  if (!inForecastRange(date) || isPreview()) return '';
  const data = wxFor(placeOn(t, date));
  const d = daily(data, date);
  if (!d) return '';
  const c = describeCode(d.code);
  return html`<span class="wx" title="${c.label}${d.rain != null ? `, ${d.rain}% chance of rain` : ''}">${c.emoji} ${d.max}°</span>`;
}

function riskFor(it) {
  if (!isTransport(it) || !isWeatherSensitive(it) || it.status === 'cancelled' || !inForecastRange(it.date)) return null;
  const dep = hourly(wxFor(it.from), it.date, it.time);
  const arr = it.to ? hourly(wxFor(it.to), it.endDate || it.date, it.endTime || it.time) : null;
  if (!dep && !arr) return null;
  const r = legRisk(it.type, [{ place: it.from, w: dep }, { place: it.to, w: arr }]);
  return { ...r, dep, arr };
}

const RISK_TEXT = ['Weather looks fine', 'Weather could disrupt this leg', 'Weather likely to disrupt this leg'];

function riskBadge(it) {
  const r = riskFor(it);
  if (!r) return '';
  return html`<div class="risk lv${r.level}">${r.level ? icon('alert', 'sm') : icon('check', 'sm')}<span>${RISK_TEXT[r.level]}${r.reasons.length ? `: ${r.reasons[0]}` : ''}</span></div>`;
}

function riskBanner(it) {
  const r = riskFor(it);
  if (!r || !r.level) return '';
  return html`<a class="banner ${r.level === 2 ? 'bad' : 'warn'}" href="#/item/${it.id}">${icon('alert', 'sm')}<div><b>${RISK_TEXT[r.level]}</b>
    <span>${r.reasons.join(', ')}. ${it.planB ? 'See your Plan B.' : 'Check the operator before you set off.'}</span></div></a>`;
}

function wxLine(label, place, w) {
  if (!w) return '';
  const c = describeCode(w.code);
  return html`<div class="wx-row"><span>${label}<small>${place}</small></span><b>${c.emoji} ${w.temp}°</b><span>${c.label}${w.rain != null ? ` · ${w.rain}% rain` : ''}<small>Wind ${w.wind} mph, gusts ${w.gusts}</small></span></div>`;
}

function weatherSection(it) {
  if (!isTransport(it) || isPreview()) return '';
  const r = riskFor(it);
  const sensitive = isWeatherSensitive(it);
  if (!r && !it.planB) {
    return sensitive && it.date && !inForecastRange(it.date) && it.date > isoDate(now())
      ? html`<h3 class="sec-h">Weather & Plan B</h3><div class="slim quiet">${icon('clock', 'sm')}<span>A forecast appears here about two weeks before ${fmtDay(it.date)}.</span></div>`
      : '';
  }
  return html`<h3 class="sec-h">Weather & Plan B</h3>
    <div class="card wx-card">
      ${r ? html`<div class="risk lv${r.level} big">${r.level ? icon('alert', 'sm') : icon('check', 'sm')}<span>${RISK_TEXT[r.level]}${r.reasons.length ? `: ${r.reasons.join(', ')}` : ''}</span></div>
        ${wxLine(`Departs ${it.time || ''}`, it.from, r.dep)}${wxLine(`Arrives ${it.endTime || ''}`, it.to, r.arr)}
        <p class="hint">A rough guide from the forecast, not the operator's decision. Small island aircraft are grounded by strong crosswinds and fog well before larger ones.</p>` : ''}
      ${it.planB ? html`<div class="planb"><b>${icon('refresh', 'sm')} Plan B</b><p>${it.planB}</p></div>`
        : sensitive && !readOnly() ? html`<a class="btn xs" href="#/edit/${it.id}">${icon('plus', 'sm')} Write a Plan B</a>` : ''}
    </div>`;
}

/* =====================================================================
   Live sync through the server
   ===================================================================== */

const syncTimers = {};
const syncing = {};

function scheduleSync(id, delay = 1500) {
  clearTimeout(syncTimers[id]);
  syncTimers[id] = setTimeout(() => syncTrip(id), delay);
}

function updateSyncPill() {
  const el = document.querySelector('.pill.sync');
  if (!el) return;
  const st = S.sync.state;
  el.className = `pill sync ${st}`;
  el.lastChild.textContent = ` ${st === 'busy' ? 'Syncing' : st === 'error' ? 'Not synced' : 'Shared'}`;
}

async function syncTrip(id) {
  if (!getServer() || !navigator.onLine || !S.synced[id]) return;
  if (syncing[id]) { syncing[id].again = true; return; }
  syncing[id] = {};
  S.sync = { ...S.sync, state: 'busy' };
  updateSyncPill();
  let changed = false;
  try {
    const local = S.trips.find((t) => t.id === id);
    if (!local) return;
    const { trip: remote, rev } = await api(`/api/trips/${encodeURIComponent(id)}/sync`, { method: 'POST', body: { trip: forServer(local) } });
    const current = S.trips.find((t) => t.id === id) || local;
    const merged = mergeTrips(current, remote);
    if (!sameContent(merged, current)) { await storeTrip(merged); changed = true; }
    if (!sameContent(merged, remote)) syncing[id].again = true;
    changed = (await syncFiles(id, merged)) || changed;
    S.synced[id] = { rev, at: new Date().toISOString() };
    await db.put('meta', S.synced, 'synced');
    S.sync = { state: 'ok', error: '', at: Date.now() };
  } catch (e) {
    S.sync = { state: 'error', error: e.message };
  } finally {
    const again = syncing[id]?.again;
    delete syncing[id];
    if (changed) scheduleQuietRender(); else updateSyncPill();
    if (again && S.sync.state !== 'error') scheduleSync(id, 300);
  }
}

const fileMeta = (f) => ({ itemId: f.itemId, name: f.name, label: f.label || '', order: f.order ?? 0, createdAt: f.createdAt, barcode: f.barcode || null, metaAt: f.metaAt || '' });

async function syncFiles(id, t) {
  const remote = await api(`/api/trips/${encodeURIComponent(id)}/files`);
  const local = await db.byIndex('files', 'tripId', id);
  const gone = t.deleted || {};
  const rmap = new Map(remote.map((f) => [f.id, f]));
  let changed = false;
  for (const f of local) {
    if (gone[f.id]) { await db.del('files', f.id); changed = true; continue; }
    const r = rmap.get(f.id);
    if (!r) {
      if (f.localOnly) continue;
      const meta = btoa(unescape(encodeURIComponent(JSON.stringify(fileMeta(f)))));
      await api(`/api/files/${encodeURIComponent(f.id)}?trip=${encodeURIComponent(id)}`, { method: 'PUT', body: f.blob, headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-File-Meta': meta }, timeout: isVideo(f) ? 900000 : 120000 });
    } else if ((f.metaAt || '') > (r.meta.metaAt || '')) {
      await api(`/api/files/${encodeURIComponent(f.id)}`, { method: 'PATCH', body: { meta: fileMeta(f) } });
    } else if ((r.meta.metaAt || '') > (f.metaAt || '')) {
      Object.assign(f, { itemId: r.meta.itemId, label: r.meta.label, order: r.meta.order, metaAt: r.meta.metaAt });
      await db.put('files', f);
      changed = true;
    }
  }
  const have = new Set(local.map((f) => f.id));
  for (const r of remote) {
    if (have.has(r.id) || gone[r.id]) continue;
    const res = await api(`/api/files/${encodeURIComponent(r.id)}`, { raw: true, timeout: isVideo(r) ? 900000 : 120000 });
    const blob = await res.blob();
    await db.put('files', { id: r.id, tripId: id, type: r.type, size: r.size, blob, ...r.meta });
    changed = true;
  }
  if (changed && id === S.tripId) await loadFiles();
  return changed;
}

async function refreshAccount() {
  if (!getServer() || !navigator.onLine) return;
  try {
    S.account = await api('/api/me');
    await db.put('meta', S.account, 'account');
  } catch (e) {
    if (e.status === 401) toast('This phone’s server access was refused. Ask for a new connect link.');
  }
  scheduleQuietRender();
}

VIEWS.connect = () => {
  const c = S.incomingConnect;
  return html`${subBar('Connect this phone', 'today')}<div class="page">
    <div class="card save-card">
      <p>Connect Travel Pack on this phone to your server as <b>${c.name}</b>?</p>
      <p class="hint">${c.url}</p>
      <p class="hint">This turns on live sharing between phones, email search and the AI assistant. Your trips stay on this phone as well.</p>
      <div class="row-btns"><button class="btn primary" data-act="connect-confirm">${icon('check')} Connect</button>
      <a class="btn ghost" href="#/today" data-act="connect-cancel">Cancel</a></div>
    </div>
  </div>`;
};

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

VIEWS.join = (t) => {
  const j = S.incomingJoin;
  if (!j) return VIEWS.today(t);  // just joined; the route moves to Today next
  const srv = getServer();
  const otherServer = srv && srv.url !== j.url;
  // On iPhone the home-screen app has its own storage, separate from Safari,
  // so joining in Safari would leave the installed app empty.
  const iosFirst = isIos() && !isStandalone();
  return html`${subBar('Join a trip', 'today')}<form class="page form" data-form="join" onsubmit="return false">
    <div class="empty welcome">
      <div class="logo-big">${icon('suitcase')}</div>
      <h2>${j.from ? `${j.from} invited you` : 'You are invited'}</h2>
      <p>to share <b>${j.trip || 'a trip'}</b> in Travel Pack. You will see the plan, tickets and contacts, and any change either of you makes appears on both phones. It works offline.</p>
    </div>
    ${iosFirst ? html`<div class="card tip static">${icon('info')}<div><b>On iPhone, install first</b>
      <span>1. Tap <b>Copy invite link</b> below. 2. Tap the Share button ${icon('share', 'sm')} then <b>Add to Home Screen</b>. 3. Open Travel Pack from your home screen, tap <b>I have an invite link</b> and paste.</span></div></div>
      <button type="button" class="btn primary wide" data-act="join-copy">${icon('copy')} Copy invite link</button>` : ''}
    ${otherServer ? html`<div class="banner warn">${icon('alert', 'sm')}<div><b>This phone uses a different server</b><span>Joining will switch it to ${j.url}. Trips already on this phone stay here.</span></div></div>` : ''}
    <label class="fld"><span>Your name</span><input name="name" value="${S.me || j.name || ''}" autocomplete="given-name" required></label>
    <button type="button" class="btn ${iosFirst ? '' : 'primary'} wide" data-act="join-confirm" ${S.joinBusy ? 'disabled' : ''}>${S.joinBusy ? html`<span class="spinner"></span> Joining…` : html`${icon('check')} ${iosFirst ? 'Join here in Safari instead' : 'Join'}`}</button>
    ${!S.online ? html`<p class="hint">Needs signal to join. After that it works offline.</p>` : ''}
    <a class="btn ghost wide" href="#/today" data-act="join-cancel">Not now</a>
  </form>`;
};

function installCard() {
  if (!S.installHint || isStandalone()) return '';
  return html`<div class="card install-card">
    <div class="invite-head"><span class="tile">${icon('download')}</span><div><b>Put Travel Pack on your home screen</b>
      <small>So it opens like an app and works with no signal.</small></div></div>
    ${S.installPrompt ? html`<button class="btn primary wide" data-act="install">${icon('download')} Install</button>`
      : isIos() ? html`<p class="hint">Tap the Share button ${icon('share', 'sm')} at the bottom of Safari, then <b>Add to Home Screen</b>.</p>`
      : html`<p class="hint">Tap the browser menu <b>⋮</b> (top right), then <b>Install app</b> or <b>Add to Home screen</b>. If you opened this from Gmail or WhatsApp, first choose <b>Open in Chrome</b> from that menu.</p>`}
    <button class="btn ghost xs" data-act="install-dismiss">Done</button>
  </div>`;
}

VIEWS.sync = (t) => {
  const srv = getServer();
  if (!srv) {
    return html`${subBar('Live sharing & server', 'more')}<div class="page">
      <div class="card tip static">${icon('info')}<div><b>Not connected</b><span>Open the invite or connect link you were sent on this phone. It links Travel Pack to a private server for live sharing, email search and the AI assistant.</span></div></div>
      <button class="btn wide" data-act="join-paste">${icon('people')} I have an invite link</button></div>`;
  }
  const a = S.account;
  const on = t && S.synced[t.id];
  const local = new Set(S.trips.map((x) => x.id));
  return html`${subBar('Live sharing & server', 'more')}<div class="page">
    <div class="card kvs">
      <div class="kv"><span>Connected as</span><b>${srv.name}</b></div>
      <div class="kv"><span>Assistant</span><b>${a ? (a.ai ? 'Ready' : 'Not set up on the server') : 'Checking…'}</b></div>
      <div class="kv"><span>Gmail</span><b>${a ? (!a.gmail.available ? 'Not set up on the server' : a.gmail.connected ? a.gmail.email || 'Connected' : 'Not connected') : '…'}</b>
        ${a?.gmail?.available ? html`<a class="btn xs" href="#/email">${a.gmail.connected ? 'Open' : 'Connect'}</a>` : ''}</div>
    </div>
    ${t && !t.readOnly ? html`<h2 class="sec-h">${t.name}</h2><div class="card list-card">
      ${on ? html`<div class="row"><span class="row-ic">${icon('refresh')}</span><span class="row-main"><b>Shared live</b>
          <small>${S.sync.state === 'error' ? `Last attempt failed: ${S.sync.error}` : S.synced[t.id].at ? `Synced ${fmtUntil(new Date(S.synced[t.id].at), new Date())}` : 'Waiting to sync'}</small></span>
          <button class="btn xs" data-act="sync-now">Sync now</button></div>
        <a class="row" href="#/share"><span class="row-ic">${icon('people')}</span><span class="row-main"><b>Invite someone</b><small>Send Jane or family a link to join this trip</small></span>${icon('right', 'sm dim')}</a>
        <button class="row" data-act="sync-off"><span class="row-ic">${icon('x')}</span><span class="row-main"><b>Stop sharing on this phone</b><small>Keeps the server copy for others</small></span></button>`
      : html`<button class="row" data-act="sync-on"><span class="row-ic">${icon('refresh')}</span><span class="row-main"><b>Share this trip live</b><small>Puts it on your server so the people you invite can see and edit it. Changes appear on every phone.</small></span>${icon('right', 'sm dim')}</button>`}
    </div>` : ''}
    <h2 class="sec-h">Trips on the server</h2>
    <div class="card list-card">${S.serverTrips == null ? html`<div class="row"><span class="row-main"><small>${S.online ? 'Loading…' : 'Needs signal'}</small></span></div>`
      : S.serverTrips.length ? S.serverTrips.map((x) => html`<div class="row"><span class="row-ic">${icon('suitcase')}</span>
          <span class="row-main"><b>${x.name}</b><small>${fmtRange(x.start, x.end)} · ${x.items} booking${x.items === 1 ? '' : 's'}</small></span>
          ${local.has(x.id) ? html`<span class="chip st-confirmed">On this phone</span>` : html`<button class="btn xs primary" data-act="pull-trip" data-id="${x.id}">Download</button>`}</div>`)
      : html`<div class="row"><span class="row-main"><small>No trips shared yet.</small></span></div>`}</div>
    <button class="btn danger-ghost wide" data-act="disconnect">Disconnect this phone</button>
  </div>`;
};

/* =====================================================================
   Email (Gmail through the server)
   ===================================================================== */

const DEFAULT_EMAIL_Q = 'newer_than:90d (booking OR reservation OR confirmation OR e-ticket OR itinerary OR invoice)';
const EMAIL_CHIPS = ['Premier Inn', 'Loganair', 'NorthLink', 'Trainline', 'booking confirmation', 'has:attachment ticket'];

/** "When do I leave Aberdeen?" is a question for the assistant, not a Gmail search. */
const looksLikeQuestion = (q) => /\?\s*$/.test(q || '') || /^(when|what|where|which|how|who|why|can|could|should|do|does|is|are|am|will|tell me)\b/i.test((q || '').trim());

async function emailSearch(q) {
  S.email = { ...S.email, q, busy: true, error: '' };
  render();
  try {
    S.email.results = await api(`/api/gmail/search?q=${encodeURIComponent(q || DEFAULT_EMAIL_Q)}`);
  } catch (e) {
    S.email.error = e.message;
    if (e.status === 409) refreshAccount();
  }
  S.email.busy = false;
  if (S.route.name === 'email') render();
}

VIEWS.email = (t) => {
  const a = S.account;
  const head = subBar('Search email', 'more');
  if (!getServer()) return html`${head}<div class="page"><div class="card tip static">${icon('info')}<div><b>Connect to your server first</b><span>Email search runs through your private Travel Pack server.</span></div></div><a class="btn wide" href="#/sync">Live sharing & server</a></div>`;
  if (a && !a.gmail.available) return html`${head}<div class="page"><div class="card tip static">${icon('info')}<div><b>Gmail isn't set up on the server yet</b><span>It needs a Google client ID and secret in the server settings.</span></div></div></div>`;
  if (a && !a.gmail.connected) {
    return html`${head}<div class="page"><div class="empty welcome">
      <div class="logo-big">${icon('message')}</div><h2>Find bookings in Gmail</h2>
      <p>Sign in with Google once. Travel Pack gets read-only access: it can search and read your email, never send or delete anything.</p>
      <button class="btn primary wide" data-act="gmail-connect">${icon('external')} Connect Gmail</button>
      ${!S.online ? html`<p class="hint">Needs signal.</p>` : ''}</div></div>`;
  }
  if (S.email.results == null && !S.email.busy && !S.email.error && S.online && a) setTimeout(() => emailSearch(''), 0);
  const r = S.email.results || [];
  const question = looksLikeQuestion(S.email.q);
  return html`${head}<div class="page">
    ${question && a?.ai && t && !t.readOnly ? html`<button class="card tip" data-act="email-to-ask">${icon('sparkle')}<div><b>That looks like a question</b><span>Search email only finds matching emails. Ask the assistant instead: it answers from your trip plan.</span></div>${icon('right', 'sm dim')}</button>` : ''}
    <form class="search" data-form="email-search" role="search"><input name="q" value="${S.email.q}" placeholder="Search Gmail (e.g. Premier Inn)" aria-label="Search email"><button class="btn primary" aria-label="Search">${icon('scan')}</button></form>
    <div class="chips">${EMAIL_CHIPS.map((c) => html`<button class="chip-link" data-act="email-chip" data-q="${c}">${c}</button>`)}</div>
    ${S.email.busy ? html`<div class="slim quiet"><span class="spinner"></span><span>Searching…</span></div>` : ''}
    ${S.email.error ? html`<div class="banner warn">${icon('alert', 'sm')}<div><b>Search failed</b><span>${S.email.error}</span></div></div>` : ''}
    ${!S.email.busy && S.email.results && !r.length ? html`<div class="empty"><p>No emails found.</p></div>` : ''}
    <div class="card list-card">${r.map((m) => html`<a class="row mail-row" href="#/mail/${m.id}">
      <span class="row-main"><b>${m.subject || '(no subject)'}</b><small>${(m.from || '').replace(/<.*>/, '').trim()} · ${new Date(m.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</small><small class="clamp">${m.snippet}</small></span></a>`)}</div>
    ${!S.email.q && r.length ? html`<p class="hint">Showing recent emails that look like bookings. Search for anything else above.</p>` : ''}
  </div>`;
};

VIEWS.mail = (t, [id]) => {
  const m = S.email.msg;
  if (!m || m.id !== id) {
    if (!S.email.loading) {
      S.email.loading = id;
      api(`/api/gmail/messages/${encodeURIComponent(id)}`).then((msg) => { S.email.msg = msg; }).catch((e) => { S.email.msgError = e.message; })
        .finally(() => { S.email.loading = null; if (S.route.name === 'mail') render(); });
    }
    return html`${subBar('Email', 'email')}<div class="page">${S.email.msgError ? html`<div class="banner warn">${icon('alert', 'sm')}<div><b>Could not open</b><span>${S.email.msgError}</span></div></div>` : html`<div class="slim quiet"><span class="spinner"></span><span>Opening…</span></div>`}</div>`;
  }
  const aiOk = S.account?.ai && t && !t.readOnly;
  return html`${subBar('Email', 'email')}<div class="page mail">
    <h2 class="mail-subject">${m.subject}</h2>
    <p class="hint">${m.from}<br>${new Date(m.date).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</p>
    ${aiOk ? html`<button class="btn primary wide" data-act="ai-email" data-id="${m.id}">${icon('sparkle')} Create bookings from this email</button>` : ''}
    ${m.attachments.length ? html`<h3 class="sec-h">Attachments</h3><div class="card list-card">${m.attachments.map((x) => html`<div class="row">
      <span class="row-ic">${icon(x.type.startsWith('image/') ? 'image' : 'file')}</span>
      <span class="row-main"><b>${x.name}</b><small>${fmtBytes(x.size)}</small></span>
      ${t && !t.readOnly ? html`<button class="btn xs" data-act="mail-save" data-msg="${m.id}" data-att="${x.id}" data-name="${x.name}" data-type="${x.type}">${icon('ticket', 'sm')} Save as ticket</button>` : ''}
    </div>`)}</div>` : ''}
    <h3 class="sec-h">Message</h3>
    <div class="card notes mail-body">${m.text || '(empty)'}</div>
  </div>`;
};

/* =====================================================================
   AI: bookings from emails / screenshots, and the trip assistant
   ===================================================================== */

function busySheet(text) {
  openSheet({ title: text, body: html`<div class="busy"><span class="spinner big"></span><p class="hint">This usually takes 10 to 30 seconds.</p></div>`, submit: '' });
}

function tripForAi(t) {
  const x = forServer(t);
  delete x.deleted;
  return x;
}

function fromAi(x) {
  const it = {};
  for (const [k, v] of Object.entries(x || {})) {
    if (['costAmount', 'costStatus', 'costNote'].includes(k)) continue;
    if (v !== '' && v != null) it[k] = v;
  }
  if (x?.costAmount > 0 && x.costStatus !== 'none') it.cost = { amount: x.costAmount, status: x.costStatus, note: x.costNote || '' };
  if (it.type === 'train') {
    if (!it.fromCode) it.fromCode = stationCode(it.from);
    if (!it.toCode) it.toCode = stationCode(it.to);
  }
  return it;
}

async function runExtract(path, body, source) {
  const t = trip();
  busySheet('Reading with Claude…');
  try {
    const out = await api(path, { method: 'POST', body: { ...body, trip: t ? tripForAi(t) : null }, timeout: 180000 });
    closeSheet();
    S.ai = {
      source, summary: out.summary,
      items: out.items.map((p) => ({ existingId: t?.items.some((i) => i.id === p.updatesExistingId) ? p.updatesExistingId : '', item: fromAi(p.item), state: 'pending' })),
    };
    go('ai');
  } catch (e) {
    closeSheet();
    toast(e.message);
  }
}

const fileToB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

/** Phone screenshots are large; the model reads a 1600px image just as well. */
async function shrinkImage(blob, max = 1600, minBytes = 600000) {
  if (!blob.type.startsWith('image/') || blob.size < minBytes) return blob;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  } catch { return blob; }
}

async function attachmentsFrom(files) {
  const out = [];
  for (const f of files) {
    if (!/^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(f.type)) continue;
    const b = await shrinkImage(f);
    out.push({ type: b.type, data: await fileToB64(b) });
  }
  return out;
}

VIEWS.ai = (t) => {
  const r = S.ai;
  if (!r || !t) return VIEWS.today(t);
  const pending = r.items.filter((x) => x.state === 'pending');
  return html`${subBar('Check and add', 'plan')}<div class="page">
    <div class="ai-summary">${icon('sparkle')}<p>${r.summary || 'Here is what Claude found.'}</p></div>
    ${!r.items.length ? html`<div class="empty"><p>No bookings found${r.source ? ` in this ${r.source}` : ''}.</p></div>` : ''}
    ${r.items.map((p, i) => {
      const it = p.item;
      const existing = p.existingId ? t.items.find((x) => x.id === p.existingId) : null;
      const T = typeOf(it);
      return html`<div class="card ai-card ${p.state}">
        <div class="entry-top"><span class="tile t-${it.type}">${icon(T.icon)}</span><span class="entry-kicker">${existing ? `Updates: ${itemTitle(existing)}` : `New ${T.label.toLowerCase()}`}</span>${chip(it.status || 'confirmed')}</div>
        <div class="entry-title">${itemTitle(it)}</div>
        ${itemSubtitle(it) ? html`<div class="entry-sub">${itemSubtitle(it)}</div>` : ''}
        <div class="kvs-mini">
          <span>${fmtDay(it.date)}${it.time ? ` · ${it.time}` : ''}${it.endTime || it.endDate ? ` → ${it.endDate && it.endDate !== it.date ? fmtDay(it.endDate) + ' ' : ''}${it.endTime || ''}` : ''}</span>
          ${it.ref ? html`<span class="mono">${it.ref}</span>` : ''}${it.seat ? html`<span>${it.seat}</span>` : ''}
          ${it.cost ? html`<span>${money(it.cost.amount)} · ${COST_STATUS[it.cost.status]}</span>` : ''}
        </div>
        ${!it.date ? html`<p class="entry-note">No date found: edit before adding.</p>` : ''}
        ${p.state === 'pending' ? html`<div class="row-btns">
          ${it.date ? html`<button class="btn primary xs" data-act="ai-apply" data-i="${i}">${icon('check', 'sm')} ${existing ? 'Update' : 'Add'}</button>` : ''}
          <button class="btn xs" data-act="ai-edit" data-i="${i}">${icon('edit', 'sm')} Edit first</button>
          <button class="btn ghost xs" data-act="ai-skip" data-i="${i}">Skip</button></div>`
        : html`<p class="hint">${p.state === 'done' ? (existing ? 'Updated' : 'Added') : 'Skipped'}</p>`}
      </div>`;
    })}
    ${pending.filter((p) => p.item.date).length > 1 ? html`<button class="btn primary wide" data-act="ai-apply-all">${icon('check')} Add all</button>` : ''}
    <p class="hint">Check references and times against the original. Claude can misread.</p>
  </div>`;
};

function applyAi(p) {
  const t = trip();
  if (p.existingId) {
    const cur = t.items.find((x) => x.id === p.existingId);
    if (cur) { putItem(t, { ...structuredClone(cur), ...p.item, id: cur.id }); return cur.id; }
  }
  const it = { id: uid('it_'), people: [], status: 'confirmed', ...p.item };
  putItem(t, it);
  return it.id;
}

const CHAT_SUGGESTIONS = ["What's next, and when do I need to leave?", 'Is anything still to book or pay?', 'Summarise tomorrow for me', 'How do I get from the hotel to Terminal 2?'];

async function loadChat(id) {
  if (!S.chat[id]) S.chat[id] = (await db.get('meta', 'chat:' + id)) || [];
  return S.chat[id];
}

VIEWS.ask = (t) => {
  if (!t) return welcome();
  if (!S.chat[t.id]) { loadChat(t.id).then(() => render()); return html`${subBar('Ask', 'today')}<div class="page"></div>`; }
  const msgs = S.chat[t.id];
  return html`${subBar('Ask Travel Pack', 'today', msgs.length ? html`<button class="icon-btn" data-act="chat-clear" aria-label="Clear conversation">${icon('trash')}</button>` : '')}
  <div class="page chat">
    ${!msgs.length ? html`<div class="ai-summary">${icon('sparkle')}<p>Ask anything about ${t.name}: timings, connections, what to do if something's cancelled. You can also ask for changes ("my lift on Saturday is at 10:30") and approve them here.</p></div>
      <div class="chips col">${CHAT_SUGGESTIONS.map((q) => html`<button class="chip-link" data-act="chat-suggest" data-q="${q}">${q}</button>`)}</div>` : ''}
    ${msgs.map((m, mi) => html`<div class="bubble ${m.role}"><span class="bubble-text">${m.content}</span>
      ${(m.changes || []).map((c, ci) => {
        const cur = c.itemId ? t.items.find((x) => x.id === c.itemId) : null;
        const it = c.action === 'delete' ? cur : fromAi(c.item);
        return html`<div class="change ${c.state}">
          <b>${c.action === 'add' ? 'Add' : c.action === 'update' ? 'Change' : 'Remove'}: ${it ? itemTitle(it) : 'booking'}</b>
          ${it ? html`<small>${fmtDay(it.date)}${it.time ? ` · ${it.time}` : ''}${c.reason ? ` · ${c.reason}` : ''}</small>` : ''}
          ${c.state === 'pending' ? html`<div class="row-btns"><button class="btn primary xs" data-act="chat-apply" data-m="${mi}" data-c="${ci}">Apply</button>
            <button class="btn ghost xs" data-act="chat-dismiss" data-m="${mi}" data-c="${ci}">Dismiss</button></div>` : html`<small>${c.state === 'applied' ? 'Applied' : 'Dismissed'}</small>`}
        </div>`;
      })}</div>`)}
    ${S.chatBusy ? html`<div class="bubble assistant"><span class="spinner"></span> Thinking…</div>` : ''}
    <form class="chat-input" data-form="ask"><textarea name="q" rows="1" placeholder="${S.online ? 'Ask about your trip…' : 'Needs signal'}" ${S.chatBusy || !S.online ? raw('disabled') : ''} required></textarea>
      <button class="btn primary" aria-label="Send" ${S.chatBusy ? raw('disabled') : ''}>${icon('arrow')}</button></form>
  </div>`;
};

function describeNow() {
  const n = now();
  return `${fmtLongDay(isoDate(n))} ${hhmm(n)}, UK local time`;
}

async function askAssistant(q) {
  const t = trip();
  const msgs = await loadChat(t.id);
  msgs.push({ role: 'user', content: q });
  S.chatBusy = true;
  render();
  scrollChat();
  try {
    const out = await api('/api/ai/chat', { method: 'POST', body: { trip: tripForAi(t), messages: msgs.map(({ role, content }) => ({ role, content })), now: describeNow() }, timeout: 180000 });
    msgs.push({ role: 'assistant', content: out.reply, changes: (out.changes || []).map((c) => ({ ...c, state: 'pending' })) });
  } catch (e) {
    msgs.push({ role: 'assistant', content: `Sorry, that didn't work: ${e.message}` });
  }
  S.chatBusy = false;
  S.chat[t.id] = msgs.slice(-40);
  await db.put('meta', S.chat[t.id], 'chat:' + t.id);
  if (S.route.name === 'ask') { render(); scrollChat(); }
}

function scrollChat() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
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
let pendingDoc = null;

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

// Larger videos stay on the phone that took them: the server takes up to this
// size, and every other phone in the trip downloads what is shared.
const VIDEO_SYNC_LIMIT = 100 * 1024 * 1024;

async function addFiles(itemId, fileList) {
  const t = trip();
  const photos = itemId.startsWith('j_');
  let found = 0;
  const existing = filesFor(itemId).length;
  let i = 0;
  let videos = 0, big = 0;
  for (const file of fileList) {
    const raw = file.blob || file;
    const video = photos && isVideo(raw);
    if (photos && !video && !raw.type?.startsWith('image/')) continue;
    if (video) { videos++; if (raw.size > VIDEO_SYNC_LIMIT) big++; }
    // Journal photos are kept at 2048px: plenty for a phone screen, and a
    // fraction of the size to store, back up and share with Jane. Videos are
    // kept as recorded; the phone cannot re-encode them quickly.
    const blob = photos && !video ? await shrinkImage(raw, 2048, 1200000) : raw;
    const rec = {
      id: uid('f_'), tripId: t.id, itemId, name: file.name || 'ticket', type: blob.type || file.type,
      size: blob.size, blob, createdAt: new Date().toISOString(), order: existing + i++,
    };
    rec.barcode = photos ? null : await detectBarcode(blob);
    if (video && blob.size > VIDEO_SYNC_LIMIT) rec.localOnly = true;
    if (rec.barcode) found++;
    await db.put('files', rec);
    S.files.push(rec);
  }
  askPersist();
  if (S.synced[t.id]) scheduleSync(t.id);
  render();
  const n = fileList.length - videos;
  const noun = photos ? 'photo' : 'ticket';
  const what = [n ? `${n} ${noun}${n === 1 ? '' : 's'}` : '', videos ? `${videos} video${videos === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  toast(big && S.synced[t.id]
    ? `${what} added · ${big === 1 ? 'one video is' : `${big} videos are`} over ${fmtBytes(VIDEO_SYNC_LIMIT)}, so ${big === 1 ? 'it stays' : 'they stay'} on this phone only`
    : `${what} added${found ? ` · ${found} barcode${found === 1 ? '' : 's'} found` : ''}`);
}

fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (!files.length) return;
  if (pendingDoc) { const d = pendingDoc; pendingDoc = null; await addDocFiles(d, files); return; }
  if (pendingItem) await addFiles(pendingItem, files);
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
    body: html`<p>${bundle.trips.length} trip${bundle.trips.length === 1 ? '' : 's'} · ${nFiles} file${nFiles === 1 ? '' : 's'}${bundle.docs?.length ? ` · ${bundle.docs.length} document${bundle.docs.length === 1 ? '' : 's'}` : ''}.</p>
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
      if (Array.isArray(bundle.docs) && bundle.docs.length) {
        const byId = new Map(S.docs.map((d) => [d.id, d]));
        for (const d of bundle.docs) byId.set(d.id, d);
        S.docs = [...byId.values()];
        await db.put('meta', S.docs, 'docs');
        for (const f of bundle.files.filter((f) => f.tripId === DOCS)) await db.put('files', f);
      }
      if (!S.tripId && S.trips.length) await setCurrentTrip(S.trips[0].id);
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
  'new-item': (el) => {
    const date = el?.dataset?.date || '';
    const aiOk = getServer() && S.account?.ai;
    openSheet({
      title: date ? `Add to ${fmtDay(date)}` : 'Add a booking', submit: '',
      body: html`${aiOk ? html`<button type="button" class="ai-entry" data-act="ai-sheet">${icon('sparkle')}<div><b>From an email, PDF or screenshot</b><span>Claude reads it and fills in the booking for you to check</span></div></button>` : ''}
        <div class="type-grid">${Object.entries(TYPES).map(([k, v]) => html`<button type="button" class="type-opt" data-act="pick-type" data-type="${k}" data-date="${date}">${icon(v.icon)}<span>${v.label}</span></button>`)}</div>`,
    });
  },
  'pick-type': (el) => { closeSheet(); S.draft = null; go(`new/${el.dataset.type}${el.dataset.date ? '/' + el.dataset.date : ''}`); },
  'add-files': (el) => {
    pendingItem = el.dataset.item;
    fileInput.accept = pendingItem.startsWith('j_') ? 'image/*,video/*' : 'image/*,application/pdf';
    fileInput.click();
  },
  async 'del-item'(el) {
    const t = trip();
    const it = t.items.find((i) => i.id === el.dataset.item);
    if (!it) return;
    const files = filesFor(it.id);
    if (!(await confirmBox(`Delete “${itemTitle(it)}”${files.length ? ` and its ${files.length} ticket${files.length === 1 ? '' : 's'}` : ''}?`))) return;
    closeSheet();
    const index = t.items.indexOf(it);
    t.items = t.items.filter((i) => i.id !== it.id);
    S.draft = null;
    await saveTrip(t, { quiet: true });
    go('plan');
    // Tickets go only once the chance to undo has passed.
    const undo = { done: false };
    const purge = setTimeout(async () => {
      if (undo.done) return;
      for (const f of files) { await db.del('files', f.id); tombstone(t, f.id); }
      S.files = S.files.filter((f) => f.itemId !== it.id);
      if (files.length) await saveTrip(t, { quiet: true });
    }, 9000);
    S.undo = async () => {
      undo.done = true;
      clearTimeout(purge);
      t.items.splice(Math.min(index, t.items.length), 0, it);
      await saveTrip(t);
      toast('Booking restored');
    };
    toast('Booking deleted', { act: 'undo', label: 'Undo' });
  },
  undo: () => { const u = S.undo; S.undo = null; if (u) u(); },
  'status-sheet': (el) => {
    const t = trip();
    const it = t.items.find((i) => i.id === el.dataset.item);
    openSheet({
      title: 'Status', submit: '',
      body: html`<div class="status-list">${Object.entries(STATUS).map(([k, v]) => html`<button type="button" class="status-opt ${it.status === k ? 'on' : ''}" data-act="set-status" data-item="${it.id}" data-status="${k}">${chip(k)}${it.status === k ? icon('check', 'sm') : ''}</button>`)}</div>`,
    });
  },
  async 'set-status'(el) {
    const t = trip();
    const it = t.items.find((i) => i.id === el.dataset.item);
    it.status = el.dataset.status;
    closeSheet();
    await saveTrip(t);
    toast(`Marked ${STATUS[it.status].label.toLowerCase()}`);
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
    const f = anyFile(S.route.parts[0]);
    if (!f?.barcode) return;
    S.showWhole = !S.showWhole;
    render();
  },
  'open-file': (el) => {
    const f = anyFile(el.dataset.file);
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
        f.metaAt = new Date().toISOString();
        await db.put('files', f);
        if (S.synced[f.tripId]) scheduleSync(f.tripId);
        closeSheet();
        render();
      },
    });
  },
  async 'del-file'(el) {
    const f = anyFile(el.dataset.file);
    closeSheet();
    if (!(await confirmBox('Delete this ticket?'))) return;
    closeSheet();
    await db.del('files', f.id);
    if (f.tripId === DOCS) {
      S.docFiles = S.docFiles.filter((x) => x.id !== f.id);
      toast('File deleted');
      go(`doc/${f.itemId}`);
      return;
    }
    S.files = S.files.filter((x) => x.id !== f.id);
    const t = trip();
    tombstone(t, f.id);
    await saveTrip(t, { quiet: true });
    toast('Ticket deleted');
    go(f.itemId.startsWith('j_') ? `journal/${t.journal.find((j) => j.id === f.itemId)?.date || ''}` : `item/${f.itemId}`);
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
  const json = await exportBundle('backup', trips, files, { docs: S.docs });
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
  async 'doc-files'(el) {
    const files = await pickedFiles(el.closest('.doc-pick'));
    el.value = '';
    if (files.length) await addDocFiles(el.dataset.id, files);
  },
  'journal-photos'(el) {
    const form = el.closest('form');
    const box = form.querySelector('.jn-previews');
    for (const u of box.querySelectorAll('img, video')) URL.revokeObjectURL(u.src.split('#')[0]);
    const files = [...form.querySelectorAll('input[type=file]')].flatMap((i) => [...i.files]);
    box.innerHTML = files.map((f) => (f.type.startsWith('image/') ? `<img src="${URL.createObjectURL(f)}" alt="">`
      : f.type.startsWith('video/') ? `<video src="${URL.createObjectURL(f)}#t=0.1" preload="metadata" muted playsinline></video>`
      : '<b class="pdf-tile">PDF</b>')).join('');
    const nv = files.filter((f) => f.type.startsWith('video/')).length, np = files.length - nv;
    const words = [np ? `${np} photo${np === 1 ? '' : 's'}` : '', nv ? `${nv} video${nv === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    if (files.length) box.insertAdjacentHTML('beforeend', `<span>${words}</span>`);
  },
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
  // A new version installs in the background and then waits. If that happens
  // while the app is just opening (nothing typed yet), switch to it at once;
  // otherwise offer a Reload. Checking happens on open, on return to the app
  // and hourly, so an update never sits unnoticed.
  const opening = () => performance.now() < 20000 && !S.draft && !sheetRoot.classList.contains('open');
  const ready = (w) => {
    if (!navigator.serviceWorker.controller || S.updateReady === w) return;
    S.updateReady = w;
    if (opening()) { w.postMessage('skipWaiting'); return; }
    toast('A new version is ready', { act: 'apply-update', label: 'Reload' });
    if (S.route.name === 'more') render();
  };
  const watch = (w) => {
    if (!w) return;
    if (w.state === 'installed') return ready(w);
    w.addEventListener('statechange', () => { if (w.state === 'installed') ready(w); });
  };
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    if (reg.waiting) ready(reg.waiting);
    watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    let lastCheck = Date.now();
    const check = () => { if (Date.now() - lastCheck > 60000) { lastCheck = Date.now(); reg.update().catch(() => {}); } };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(() => reg.update().catch(() => {}), 3600000);
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading && S.updateReady) { reloading = true; location.reload(); } });
}

/* =====================================================================
   Actions for documents, journal, sync, email and AI
   ===================================================================== */

Object.assign(ACT, {
  'doc-sheet': (el) => docSheet(S.docs.find((d) => d.id === el.dataset.id)),
  'add-doc-files': (el) => { pendingDoc = el.dataset.id; fileInput.click(); },
  async 'del-doc'(el) {
    const d = S.docs.find((x) => x.id === el.dataset.id);
    if (!(await confirmBox(`Delete “${d.title}” and its photos?`))) return;
    closeSheet();
    for (const f of S.docFiles.filter((x) => x.itemId === d.id)) await db.del('files', f.id);
    S.docFiles = S.docFiles.filter((x) => x.itemId !== d.id);
    S.docs = S.docs.filter((x) => x.id !== d.id);
    await saveDocs();
    go('docs');
  },

  'journal-edit': (el) => {
    const t = trip();
    const j = t.journal.find((x) => x.id === el.dataset.id);
    openSheet({
      title: 'Edit entry',
      body: html`<label class="fld"><span>Entry</span><textarea name="text" rows="6">${j.text || ''}</textarea></label>`,
      extra: html`<button type="button" class="btn danger-ghost" data-act="journal-del" data-id="${j.id}">Delete</button>`,
      onSubmit: async (fd) => { j.text = String(fd.get('text') || '').trim(); closeSheet(); await saveTrip(t); },
    });
  },
  async 'journal-del'(el) {
    const t = trip();
    closeSheet();
    if (!(await confirmBox('Delete this entry and its photos?'))) return;
    closeSheet();
    for (const f of S.files.filter((x) => x.itemId === el.dataset.id)) { await db.del('files', f.id); tombstone(t, f.id); }
    S.files = S.files.filter((x) => x.itemId !== el.dataset.id);
    t.journal = t.journal.filter((x) => x.id !== el.dataset.id);
    await saveTrip(t);
  },

  async 'connect-confirm'() {
    const c = S.incomingConnect;
    S.incomingConnect = null;
    await setServer(c);
    if (!S.me) { S.me = c.name.charAt(0).toUpperCase() + c.name.slice(1); await db.put('meta', S.me, 'me'); }
    toast(`Connected as ${c.name}`);
    go('sync');
    refreshAccount();
    loadServerTrips();
  },
  'connect-cancel': () => { S.incomingConnect = null; },
  async disconnect() {
    if (!(await confirmBox('Disconnect this phone from the server? Trips stay on the phone; live sharing, email and the assistant stop.', 'Disconnect'))) return;
    closeSheet();
    await setServer(null);
    S.account = null;
    S.synced = {};
    await db.put('meta', S.synced, 'synced');
    await db.del('meta', 'account');
    go('more');
  },
  async 'sync-on'() {
    const t = trip();
    S.synced[t.id] = { rev: 0, at: '' };
    await db.put('meta', S.synced, 'synced');
    render();
    await syncTrip(t.id);
    toast(S.sync.state === 'error' ? `Not shared yet: ${S.sync.error}` : 'Shared live');
    loadServerTrips();
  },
  'sync-now': () => syncTrip(S.tripId).then(() => { render(); toast(S.sync.state === 'error' ? S.sync.error : 'Up to date'); }),
  'sync-off': () => {
    openSheet({
      title: 'Stop sharing this trip?', submit: '',
      body: html`<p>This phone keeps its copy and stops sending and receiving changes.</p>`,
      extra: html`${S.account?.owner !== false ? html`<button type="button" class="btn danger-ghost" data-act="sync-remove">Also remove from server</button>` : ''}<button type="button" class="btn primary" data-act="sync-stop">Stop on this phone</button>`,
    });
  },
  async 'sync-stop'() {
    delete S.synced[S.tripId];
    await db.put('meta', S.synced, 'synced');
    closeSheet();
    render();
  },
  async 'sync-remove'() {
    try { await api(`/api/trips/${encodeURIComponent(S.tripId)}`, { method: 'DELETE' }); } catch (e) { toast(e.message); return; }
    delete S.synced[S.tripId];
    await db.put('meta', S.synced, 'synced');
    closeSheet();
    loadServerTrips();
    toast('Removed from the server');
  },
  async 'pull-trip'(el) {
    try {
      const t = await pullTrip(el.dataset.id);
      toast(`${t.name} is on this phone`);
    } catch (e) { toast(e.message); }
  },

  /* ----- invites: share a trip live with someone else's phone ----- */
  async 'invite-create'(el) {
    const t = trip();
    const name = String(el.closest('form').querySelector('[name=inviteName]').value || '').trim() || 'Guest';
    el.disabled = true;
    try {
      // The trip has to be on the server before anyone can join it.
      if (!S.synced[t.id]) {
        S.synced[t.id] = { rev: 0, at: '' };
        await db.put('meta', S.synced, 'synced');
      }
      await syncTrip(t.id);
      if (S.sync.state === 'error') throw new Error(`Could not share the trip: ${S.sync.error}`);
      const { code, expiresAt } = await api(`/api/trips/${encodeURIComponent(t.id)}/invites`, { method: 'POST', body: { name } });
      const from = S.me || getServer().name;
      S.invite = { tripId: t.id, name, expiresAt, link: joinLink(appUrl(), { url: getServer().url, code, trip: t.name, from, name }) };
    } catch (e) { toast(e.message); }
    render();
  },
  async 'invite-send'(el, e) {
    e?.preventDefault();
    const t = trip(), inv = S.invite;
    const text = inviteText(inv, t);
    if (navigator.share) {
      try { await navigator.share({ title: `Travel Pack: ${t.name}`, text }); return; } catch (err) { if (err.name === 'AbortError') return; }
    }
    copyText(inv.link, 'invite link');
  },
  'invite-copy': () => copyText(S.invite.link, 'invite link'),
  'invite-new': () => { S.invite = null; render(); },

  async 'join-confirm'(el) {
    const j = S.incomingJoin;
    const name = String(el.closest('form').querySelector('[name=name]').value || '').trim();
    if (!name) { toast('Add your name first'); return; }
    S.joinBusy = true;
    render();
    try {
      const srv = getServer();
      const same = srv && srv.url === j.url;
      const r = await redeemInvite(j.url, j.code, name, same ? srv.token : null);
      if (r.token) {
        // Switching servers: trips shared through the old one must not be pushed to the new one.
        if (srv && !same) { S.synced = {}; await db.put('meta', S.synced, 'synced'); S.account = null; }
        await setServer({ url: j.url, token: r.token, name: r.name });
      }
      if (!S.me) { S.me = name; await db.put('meta', S.me, 'me'); }
      S.incomingJoin = null;
      S.installHint = !isStandalone();
      if (S.installHint) await db.put('meta', true, 'installHint');
      const t = await pullTrip(r.tripId);
      refreshAccount();
      toast(`${t.name} is on this phone and will stay in sync`);
    } catch (e) {
      toast(e.message || 'Could not join. Check your signal and try again.');
    } finally {
      S.joinBusy = false;
      if (S.route.name === 'join') render();
    }
  },
  'join-cancel': () => { S.incomingJoin = null; },
  'join-copy': () => copyText(joinLink(appUrl(), S.incomingJoin), 'invite link'),
  'join-paste': () => {
    openSheet({
      title: 'Join with an invite link',
      submit: 'Continue',
      body: html`<label class="fld"><span>Invite link</span><textarea name="link" rows="4" placeholder="Paste the link you were sent" required></textarea></label>`,
      onSubmit: (fd) => {
        const v = String(fd.get('link') || '');
        const i = v.indexOf('#join=');
        try {
          if (i < 0) throw new Error();
          S.incomingJoin = readJoinLink(v.slice(i + 1).trim());
        } catch { toast('That is not a Travel Pack invite link.'); return; }
        closeSheet();
        go('join');
      },
    });
  },
  async 'install-dismiss'() {
    S.installHint = false;
    await db.del('meta', 'installHint');
    render();
  },

  async 'gmail-connect'() {
    try {
      const { url } = await api('/api/gmail/start');
      location.href = url;
    } catch (e) { toast(e.message); }
  },
  'email-chip': (el) => emailSearch(el.dataset.q),
  'email-to-ask': () => { const q = S.email.q; go('ask'); setTimeout(() => askAssistant(q), 0); },
  'ai-email': (el) => runExtract('/api/ai/extract-email', { messageId: el.dataset.id }, 'email'),
  'mail-save': (el) => {
    const t = trip();
    const items = [...t.items].sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    openSheet({
      title: `Save “${el.dataset.name}”`,
      body: html`<label class="fld"><span>Booking</span><select name="itemId">${items.map((it) => html`<option value="${it.id}">${fmtDay(it.date)} · ${itemTitle(it)}</option>`)}</select></label>`,
      submit: 'Save as ticket',
      onSubmit: async (fd) => {
        closeSheet();
        try {
          const res = await api(`/api/gmail/messages/${encodeURIComponent(el.dataset.msg)}/attachments/${encodeURIComponent(el.dataset.att)}?type=${encodeURIComponent(el.dataset.type)}`, { raw: true, timeout: 120000 });
          const blob = new Blob([await res.arrayBuffer()], { type: el.dataset.type });
          await addFiles(String(fd.get('itemId')), [new File([blob], el.dataset.name, { type: el.dataset.type })]);
        } catch (e) { toast(e.message); }
      },
    });
  },

  'ai-sheet': () => {
    openSheet({
      title: 'Add from an email, PDF or screenshot',
      body: html`<label class="fld"><span>Paste the email or booking text</span><textarea name="text" rows="6" placeholder="Paste here…"></textarea></label>
        <label class="fld"><span>…and/or add screenshots or PDFs</span><input type="file" name="files" accept="image/*,application/pdf" multiple></label>
        ${S.account?.gmail?.connected ? html`<a class="btn ghost" href="#/email">${icon('message')} Or search Gmail</a>` : ''}`,
      submit: 'Read with Claude',
      onSubmit: async (fd) => {
        const text = String(fd.get('text') || '').trim();
        const files = fd.getAll('files').filter((f) => f && f.size);
        if (!text && !files.length) { toast('Paste some text or add a file first.'); return false; }
        closeSheet();
        const attachments = await attachmentsFrom(files);
        runExtract('/api/ai/extract', { text, attachments, source: files.length ? 'document' : 'text' }, files.length ? 'document' : 'text');
      },
    });
  },
  async 'inbox-ai'(el) {
    const f = S.inbox.find((x) => x.id === el.dataset.id);
    if (f.text) return runExtract('/api/ai/extract', { text: `${f.name}\n\n${f.text}`, source: 'shared text' }, 'text');
    runExtract('/api/ai/extract', { attachments: await attachmentsFrom([f.blob]), source: 'document' }, 'document');
  },
  async 'ai-apply'(el) {
    const p = S.ai.items[Number(el.dataset.i)];
    applyAi(p);
    p.state = 'done';
    await saveTrip(trip());
    toast(p.existingId ? 'Booking updated' : 'Booking added');
  },
  async 'ai-apply-all'() {
    for (const p of S.ai.items) if (p.state === 'pending' && p.item.date) { applyAi(p); p.state = 'done'; }
    await saveTrip(trip());
    toast('Added');
  },
  'ai-skip': (el) => { S.ai.items[Number(el.dataset.i)].state = 'skipped'; render(); },
  'ai-edit': (el) => {
    const p = S.ai.items[Number(el.dataset.i)];
    const t = trip();
    const cur = p.existingId ? t.items.find((x) => x.id === p.existingId) : null;
    p.state = 'done';
    S.draft = cur ? { ...structuredClone(cur), ...p.item, id: cur.id } : { ...blankItem(p.item.type || 'other', p.item.date || defaultDate(t)), ...p.item };
    go(cur ? `edit/${cur.id}` : `new/${S.draft.type}`);
  },

  'chat-suggest': (el) => askAssistant(el.dataset.q),
  async 'chat-clear'() {
    const t = trip();
    S.chat[t.id] = [];
    await db.put('meta', [], 'chat:' + t.id);
    render();
  },
  async 'chat-apply'(el) {
    const t = trip();
    const msgs = S.chat[t.id];
    const c = msgs[Number(el.dataset.m)].changes[Number(el.dataset.c)];
    if (c.action === 'delete') {
      t.items = t.items.filter((x) => x.id !== c.itemId);
    } else if (c.action === 'update' && t.items.some((x) => x.id === c.itemId)) {
      const cur = t.items.find((x) => x.id === c.itemId);
      putItem(t, { ...structuredClone(cur), ...fromAi(c.item), id: cur.id });
    } else {
      putItem(t, { id: uid('it_'), people: [], status: 'confirmed', ...fromAi(c.item) });
    }
    c.state = 'applied';
    await db.put('meta', msgs, 'chat:' + t.id);
    await saveTrip(t);
    toast('Done');
  },
  async 'chat-dismiss'(el) {
    const t = trip();
    S.chat[t.id][Number(el.dataset.m)].changes[Number(el.dataset.c)].state = 'dismissed';
    await db.put('meta', S.chat[t.id], 'chat:' + t.id);
    render();
  },
});

Object.assign(FORMS, {
  async journal(fd) {
    const t = trip();
    const text = String(fd.get('text') || '').trim();
    const photos = [...fd.getAll('photos'), ...fd.getAll('camera'), ...fd.getAll('video')].filter((f) => f && f.size && /^(image|video)\//.test(f.type));
    if (!text && !photos.length) { toast('Write something or add a photo first.'); return; }
    t.journal = t.journal || [];
    const entry = { id: uid('j_'), date: String(fd.get('date')), text, author: S.me || getServer()?.name || '', at: new Date().toISOString() };
    t.journal.push(entry);
    await saveTrip(t);
    if (photos.length) await addFiles(entry.id, photos);
  },
  'email-search': (fd) => emailSearch(String(fd.get('q') || '').trim()),
  ask(fd, form) {
    const q = String(fd.get('q') || '').trim();
    if (q) askAssistant(q);
    form.reset();
  },
});

const appUrl = () => location.origin + location.pathname;

/** Download a trip from the server (merging with any copy already here) and keep it in sync. */
async function pullTrip(id) {
  const { trip: remote, rev } = await api(`/api/trips/${encodeURIComponent(id)}`);
  const here = S.trips.find((x) => x.id === id);
  const t = here ? mergeTrips(here, remote) : remote;
  await storeTrip(t);
  S.synced[t.id] = { rev, at: new Date().toISOString() };
  await db.put('meta', S.synced, 'synced');
  await setCurrentTrip(t.id);
  // Show the plan straight away; tickets follow in the background of this call.
  if (S.route.name === 'today') render(); else go('today');
  toast('Downloading tickets…');
  await syncFiles(t.id, t);
  await loadFiles();
  if (here) scheduleSync(t.id);
  return t;
}

async function loadServerTrips() {
  if (!getServer() || !navigator.onLine) return;
  try { S.serverTrips = await api('/api/trips'); } catch { S.serverTrips = []; }
  if (S.route.name === 'sync') render();
}

// Keep shared trips fresh while the app is open.
setInterval(() => {
  if (document.visibilityState === 'visible' && navigator.onLine && S.tripId && S.synced[S.tripId]) syncTrip(S.tripId);
}, 45000);
window.addEventListener('online', () => { if (S.tripId && S.synced[S.tripId]) syncTrip(S.tripId); refreshAccount(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.tripId && S.synced[S.tripId]) syncTrip(S.tripId);
});

/* =====================================================================
   Boot
   ===================================================================== */

(async function boot() {
  try {
    await loadAll();
    try { S.build = ((await caches.keys()).find((k) => k.startsWith('tp-')) || '').replace(/^tp-/, ''); } catch { /* no cache API */ }
    S.account = (await db.get('meta', 'account')) || null;
    if (navigator.storage?.persisted) S.persisted = await navigator.storage.persisted();
    await refreshInbox();
  } catch (e) {
    console.error(e);
    root.innerHTML = String(html`<div class="page"><div class="empty">${icon('alert')}<h2>Storage unavailable</h2><p>This browser blocked local storage (private mode?). Travel Pack needs it to keep your trips offline.</p></div></div>`);
    return;
  }
  await onRoute();
  refreshAccount();
  if (S.tripId && S.synced[S.tripId]) syncTrip(S.tripId);
  if (S.inbox.length && S.route.name !== 'inbox') toast(`${S.inbox.length} shared file${S.inbox.length === 1 ? '' : 's'} waiting`, { act: 'goto-inbox', label: 'Attach' });
})();

ACT['goto-inbox'] = () => go('inbox');

// Exposed for debugging from the console.
window.__tp = { S, db, render, scheduleQuietRender };
