// Small helpers shared by every module: safe HTML templating, dates, money.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s));

function fmt(v) {
  if (v == null || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  return esc(v);
}

/** Tagged template: interpolated values are escaped unless wrapped in raw(). */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += fmt(vals[i]);
  });
  return new Raw(out);
}

export const uid = (p = '') =>
  p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- dates (all trip times are local wall-clock times) ---------- */

export function parseDate(d, t) {
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  let hh = 0, mm = 0;
  if (t) [hh, mm] = t.split(':').map(Number);
  return new Date(y, m - 1, day, hh, mm);
}

export const isoDate = (dt) =>
  `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

export const hhmm = (dt) =>
  `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;

export function addDays(d, n) {
  const dt = parseDate(d);
  dt.setDate(dt.getDate() + n);
  return isoDate(dt);
}

export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

export function dateRange(a, b) {
  const out = [];
  if (!a || !b) return out;
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}

const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const longDayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const shortFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export const fmtDay = (d) => (d ? dayFmt.format(parseDate(d)) : '');
export const fmtLongDay = (d) => (d ? longDayFmt.format(parseDate(d)) : '');
export const fmtShort = (d) => (d ? shortFmt.format(parseDate(d)) : '');

export function fmtRange(a, b) {
  if (!a) return '';
  if (!b || a === b) return fmtShort(a);
  const A = parseDate(a), B = parseDate(b);
  if (A.getMonth() === B.getMonth() && A.getFullYear() === B.getFullYear())
    return `${A.getDate()}–${B.getDate()} ${shortFmt.format(B).split(' ')[1]}`;
  return `${fmtShort(a)} – ${fmtShort(b)}`;
}

export function fmtDuration(ms) {
  const mins = Math.round(Math.abs(ms) / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** "in 3h 12m", "in 2 days", "now", "12m ago" */
export function fmtUntil(target, now) {
  const ms = target - now;
  if (Math.abs(ms) < 60000) return 'now';
  const future = ms > 0;
  const mins = Math.abs(ms) / 60000;
  let txt;
  if (mins < 60 * 24) txt = fmtDuration(Math.abs(ms));
  else {
    const days = Math.round(mins / 60 / 24);
    txt = `${days} day${days === 1 ? '' : 's'}`;
  }
  return future ? `in ${txt}` : `${txt} ago`;
}

/* ---------- money ---------- */

const gbpFmt = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
export const money = (n) => gbpFmt.format(Number(n) || 0);

/* ---------- files ---------- */

export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

export function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const slug = (s) =>
  String(s || 'trip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'trip';
