// Calendar export: a whole trip as an .ics file, or one booking as a Google
// Calendar "add event" link. Trip times are UK wall-clock times; they are
// converted to UTC here so the phone's calendar can't misread them.
import { itemTitle, itemSubtitle, typeOf, isStay, isTransport } from './model.js';
import { addDays } from './util.js';

const TZ = 'Europe/London';

function tzOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return asUTC - utcMs;
}

/** UK local date + time → Date (UTC instant). */
export function londonToDate(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMs(guess);
  t = guess - tzOffsetMs(t);
  return new Date(t);
}

const stamp = (dt) => dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = (d) => d.replace(/-/g, '');

function escText(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);
}

function fold(line) {
  const out = [];
  let s = line;
  while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); }
  out.push(s);
  return out.join('\r\n');
}

export function describe(it) {
  const t = typeOf(it).fields;
  const lines = [];
  const sub = itemSubtitle(it);
  if (sub) lines.push(sub);
  for (const k of ['ref', 'eticket', 'seat', 'class', 'address', 'phone']) {
    if (it[k] && t[k]) lines.push(`${t[k]}: ${it[k]}`);
  }
  if (it.keyTimes) lines.push('', it.keyTimes);
  if (it.notes) lines.push('', it.notes);
  return lines.join('\n');
}

function summary(it) {
  const title = itemTitle(it);
  if (it.type === 'flight' && it.number) return `✈ ${it.number} ${title}`;
  if (it.type === 'hotel') return `🛏 ${title}`;
  if (it.type === 'stay') return `🏠 ${title}`;
  if (it.type === 'train') return `🚆 ${title}`;
  if (it.type === 'ferry') return `⛴ ${title}`;
  if (it.type === 'lift') return `🚗 ${title}`;
  return title;
}

/** Start/end for an item: timed (Date pair) or all-day (date strings, end exclusive). */
function span(it) {
  if (isStay(it)) {
    const end = it.endDate && it.endDate > it.date ? it.endDate : addDays(it.date, 1);
    return { allDay: true, start: it.date, end };
  }
  if (!it.time) return { allDay: true, start: it.date, end: addDays(it.date, 1) };
  const start = londonToDate(it.date, it.time);
  const end = it.endTime ? londonToDate(it.endDate || it.date, it.endTime) : new Date(start.getTime() + 3600000);
  return { allDay: false, start, end: end > start ? end : new Date(start.getTime() + 3600000) };
}

export function tripToIcs(trip) {
  const now = stamp(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Travel Pack//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escText(trip.name)}`];
  for (const it of trip.items || []) {
    if (!it.date || it.status === 'cancelled') continue;
    const s = span(it);
    lines.push('BEGIN:VEVENT', `UID:${it.id}@travel-pack`, `DTSTAMP:${now}`);
    if (s.allDay) lines.push(`DTSTART;VALUE=DATE:${dateOnly(s.start)}`, `DTEND;VALUE=DATE:${dateOnly(s.end)}`, 'TRANSP:TRANSPARENT');
    else lines.push(`DTSTART:${stamp(s.start)}`, `DTEND:${stamp(s.end)}`);
    lines.push(`SUMMARY:${escText((it.status === 'tobook' ? '[TO BOOK] ' : '') + summary(it))}`);
    const loc = isTransport(it) ? it.from : it.address || it.title;
    if (loc) lines.push(`LOCATION:${escText(loc)}`);
    const desc = describe(it);
    if (desc) lines.push(`DESCRIPTION:${escText(desc)}`);
    if (!s.allDay && ['flight', 'ferry', 'train', 'bus'].includes(it.type)) {
      const lead = it.type === 'train' || it.type === 'bus' ? '-PT1H' : '-PT3H';
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escText(summary(it))}`, `TRIGGER:${lead}`, 'END:VALARM');
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escText(summary(it))}`, 'TRIGGER:-P1D', 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function googleCalendarUrl(it) {
  const s = span(it);
  const dates = s.allDay ? `${dateOnly(s.start)}/${dateOnly(s.end)}` : `${stamp(s.start)}/${stamp(s.end)}`;
  const p = new URLSearchParams({
    action: 'TEMPLATE', text: summary(it), dates, details: describe(it),
    location: (isTransport(it) ? it.from : it.address || it.title) || '',
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}
