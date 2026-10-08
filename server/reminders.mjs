// What to remind people about, and when. Pure functions: given a trip and a
// person's settings, list every notification with the moment it is due. The
// server's ticker sends the ones whose moment has just passed.
//
// Trip times are local wall-clock times (the app never stores a zone), so they
// are read in the trip's time zone, Europe/London unless the trip says
// otherwise. British Summer Time is handled by Intl, not by hand.
import { typeOf, isTransport, itemTitle, itemSubtitle } from '../app/model.js';

/** Minutes before departure to remind, by booking type. */
export const LEAD_MIN = { flight: 120, ferry: 120, train: 60, bus: 45, lift: 30 };
export const CHECKOUT_LEAD_MIN = 60;
export const DEFAULT_PREFS = { departures: true, briefing: true, briefingTime: '07:30' };
/** A reminder this late is skipped rather than sent (the server was down, say). */
export const STALE_MS = 30 * 60000;

function offsetMs(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

/** "2026-10-08" + "14:52" in Europe/London → epoch ms. */
export function localToUtc(date, time, tz = 'Europe/London') {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const first = naive - offsetMs(naive, tz);
  return naive - offsetMs(first, tz);
}

const days = (start, end) => {
  const out = [];
  for (let t = Date.parse(`${start}T12:00:00Z`); t <= Date.parse(`${end}T12:00:00Z`) && out.length < 120; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

const live = (it) => it.status !== 'cancelled' && it.date;
const hours = (min) => (min % 60 ? `${min} minutes` : `${min / 60} hour${min === 60 ? '' : 's'}`);

/** Every reminder for one trip: [{ key, at, title, body, url, tag }]. */
export function plan(trip, prefs = DEFAULT_PREFS, tz = trip.timezone || 'Europe/London') {
  const p = { ...DEFAULT_PREFS, ...prefs };
  const out = [];
  const items = (trip.items || []).filter(live);
  if (p.departures) {
    for (const it of items) {
      if (isTransport(it) && it.time) {
        const lead = LEAD_MIN[it.type] ?? 60;
        const at = localToUtc(it.date, it.time, tz) - lead * 60000;
        const extra = [itemSubtitle(it), it.seat && `${typeOf(it).fields.seat || 'Seat'} ${it.seat}`, it.ref && `Ref ${it.ref}`].filter(Boolean).join(' · ');
        out.push({
          key: `dep:${trip.id}:${it.id}:${at}`, at, tag: `dep-${it.id}`, url: `#/item/${it.id}`,
          title: `${typeOf(it).label} at ${it.time}: ${itemTitle(it)}`,
          body: `Leaves in ${hours(lead)}.${extra ? ` ${extra}` : ''}`,
        });
      }
      if (it.type === 'hotel' && it.endTime) {
        const at = localToUtc(it.endDate || it.date, it.endTime, tz) - CHECKOUT_LEAD_MIN * 60000;
        out.push({
          key: `out:${trip.id}:${it.id}:${at}`, at, tag: `out-${it.id}`, url: `#/item/${it.id}`,
          title: `Check out by ${it.endTime}`, body: `${itemTitle(it)}. Collect everything and hand back the key.`,
        });
      }
    }
  }
  if (p.briefing && trip.start && trip.end) {
    for (const d of days(trip.start, trip.end)) {
      const today = items
        .filter((it) => it.date === d || ((it.endDate || it.date) === d && it.endTime && typeOf(it).kind === 'stay'))
        .map((it) => ({ it, t: it.date === d ? it.time : it.endTime, out: it.date !== d }))
        .sort((a, b) => (a.t || '99').localeCompare(b.t || '99'));
      if (!today.length) continue;
      const line = today.slice(0, 3).map(({ it, t, out: o }) => `${t ? `${t} ` : ''}${o ? 'Check out: ' : ''}${itemTitle(it)}`).join(' · ');
      const at = localToUtc(d, p.briefingTime, tz);
      out.push({
        key: `brief:${trip.id}:${d}:${at}`, at, tag: `brief-${trip.id}`, url: '#/today',
        title: `Today: ${trip.name}`, body: `${line}${today.length > 3 ? ` and ${today.length - 3} more` : ''}. Tap for your briefing.`,
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Reminders whose moment has passed but are not yet stale. */
export const due = (list, now) => list.filter((r) => r.at <= now && now - r.at < STALE_MS);
