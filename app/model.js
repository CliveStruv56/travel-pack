// The trip model: booking types, statuses, and the derived views (timeline,
// "next up", costs, to-book list, live-status links).
import { parseDate, dateRange, addDays, daysBetween, isoDate } from './util.js';

export const STATUS = {
  confirmed: { label: 'Confirmed' },
  arranged: { label: 'Arranged' },
  tobook: { label: 'To book' },
  cancelled: { label: 'Cancelled' },
};

export const COST_STATUS = {
  paid: 'Paid',
  due: 'To pay',
  unknown: 'Check',
};

// `fields` maps each shared field to the label it takes for this type. Fields
// not listed are hidden in the editor for that type.
export const TYPES = {
  flight: {
    label: 'Flight', icon: 'plane', kind: 'transport', when: ['Departs', 'Arrives'],
    fields: { provider: 'Airline', number: 'Flight number', from: 'From', to: 'To', seat: 'Seat', class: 'Fare / class', ref: 'Booking reference', eticket: 'E-ticket number' },
  },
  ferry: {
    label: 'Ferry', icon: 'ship', kind: 'transport', when: ['Departs', 'Arrives'],
    fields: { provider: 'Operator', number: 'Vessel', from: 'From', to: 'To', seat: 'Cabin / seat', class: 'Fare', ref: 'Booking reference', eticket: 'Ticket number' },
  },
  train: {
    label: 'Train', icon: 'train', kind: 'transport', when: ['Departs', 'Arrives'],
    fields: { provider: 'Operator', from: 'From station', to: 'To station', fromCode: 'From code (e.g. ABD)', toCode: 'To code (e.g. EDB)', seat: 'Carriage & seat', class: 'Class', ref: 'Booking reference', eticket: 'Ticket / collection ref' },
  },
  bus: {
    label: 'Bus / coach', icon: 'bus', kind: 'transport', when: ['Departs', 'Arrives'],
    fields: { provider: 'Operator', number: 'Service', from: 'From', to: 'To', seat: 'Seat', ref: 'Booking reference' },
  },
  lift: {
    label: 'Lift / car', icon: 'car', kind: 'transport', when: ['Leaves', 'Arrives'],
    fields: { provider: 'Driver', from: 'From', to: 'To' },
  },
  hotel: {
    label: 'Hotel', icon: 'bed', kind: 'stay', when: ['Check-in', 'Check-out'],
    fields: { title: 'Hotel name', address: 'Address', phone: 'Phone', seat: 'Room & rate', ref: 'Booking reference' },
  },
  stay: {
    label: 'Staying with', icon: 'home', kind: 'stay', when: ['Arrive', 'Leave'],
    fields: { title: 'Place (e.g. Buckingham)', provider: 'Host', address: 'Address', phone: 'Phone' },
  },
  other: {
    label: 'Other', icon: 'pin', kind: 'event', when: ['Starts', 'Ends'],
    fields: { title: 'Title', address: 'Location', ref: 'Reference' },
  },
};

export const typeOf = (it) => TYPES[it.type] || TYPES.other;
export const isTransport = (it) => typeOf(it).kind === 'transport';
export const isStay = (it) => typeOf(it).kind === 'stay';

export function itemTitle(it) {
  if (it.title) return it.title;
  if (isTransport(it) && (it.from || it.to)) return `${it.from || '?'} → ${it.to || '?'}`;
  return typeOf(it).label;
}

/** "Loganair LM0710" / "LNER · First Class" – the line under the title. */
export function itemSubtitle(it) {
  const t = it.type;
  const parts = [];
  if (t === 'flight' || t === 'bus') parts.push([it.provider, it.number].filter(Boolean).join(' '));
  else if (t === 'ferry') parts.push([it.provider, it.number].filter(Boolean).join(' · '));
  else if (t === 'lift') parts.push(it.provider ? `with ${it.provider}` : 'Lift');
  else if (t === 'stay') parts.push(it.provider ? `with ${it.provider}` : '');
  else if (t === 'hotel') parts.push(it.address ? it.address.split(',')[0] : '');
  else parts.push(it.provider || '');
  if (t === 'train') parts.push(it.class || '');
  return parts.filter(Boolean).join(' · ');
}

export const startOf = (it) => (it.date ? parseDate(it.date, it.time) : null);
export function endOf(it) {
  if (!it.endTime && !it.endDate) return null;
  return parseDate(it.endDate || it.date, it.endTime);
}

/* ---------- timeline ---------- */

/**
 * Days of the trip, each with ordered entries:
 *   item     – a transport / event card
 *   checkin  – first day of a hotel or stay
 *   night    – a middle night of a hotel or stay
 *   checkout – last day of a hotel or stay
 *   gap      – time between two timed legs ("47m connection", "7h in Kirkwall")
 */
export function buildDays(trip) {
  const items = (trip.items || []).filter(Boolean);
  let first = trip.start, last = trip.end;
  for (const it of items) {
    for (const d of [it.date, it.endDate]) {
      if (!d) continue;
      if (!first || d < first) first = d;
      if (!last || d > last) last = d;
    }
  }
  const days = new Map(dateRange(first, last).map((d) => [d, []]));
  const push = (d, e) => days.has(d) && days.get(d).push(e);

  items.forEach((it, idx) => {
    if (!it.date) return;
    if (isStay(it)) {
      const end = it.endDate && it.endDate > it.date ? it.endDate : it.date;
      const nights = Math.max(daysBetween(it.date, end), 0);
      push(it.date, { kind: 'checkin', item: it, idx, time: it.time, nights });
      for (let n = 1; n < nights; n++) {
        push(addDays(it.date, n), { kind: 'night', item: it, idx, time: '23:58', night: n + 1, nights });
      }
      if (end !== it.date) push(end, { kind: 'checkout', item: it, idx, time: it.endTime });
    } else {
      push(it.date, { kind: 'item', item: it, idx, time: it.time });
    }
  });

  // Gaps between consecutive transport legs that both carry times.
  const legs = items
    .map((it, idx) => ({ it, idx }))
    .filter(({ it }) => isTransport(it) && it.date && it.status !== 'cancelled')
    .sort((a, b) => (a.it.date + (a.it.time || '')).localeCompare(b.it.date + (b.it.time || '')) || a.idx - b.idx);
  for (let i = 0; i < legs.length - 1; i++) {
    const a = legs[i].it, b = legs[i + 1].it;
    const aEnd = a.endTime ? endOf(a) : null;
    const bStart = b.time ? startOf(b) : null;
    if (!aEnd || !bStart) continue;
    const ms = bStart - aEnd;
    if (ms < 10 * 60000 || ms > 20 * 3600000) continue;
    push(isoDate(aEnd), {
      kind: 'gap', idx: legs[i].idx + 0.5, time: a.endTime, ms,
      place: a.to || b.from || '', connection: ms <= 90 * 60000,
    });
  }

  // A check-in is not due before the day's last leg arrives.
  const lastArrival = {};
  for (const it of items) {
    if (isTransport(it) && it.endTime && it.status !== 'cancelled') {
      const d = it.endDate || it.date;
      if (!lastArrival[d] || it.endTime > lastArrival[d]) lastArrival[d] = it.endTime;
    }
  }
  for (const [date, entries] of days) {
    for (const e of entries) {
      // You leave a place before the day's travel, whatever the latest check-out time.
      if (e.kind === 'checkout') { e.time = '00:00'; e.idx = -1; }
      if (e.kind === 'checkin' && lastArrival[date] && (!e.time || lastArrival[date] > e.time)) e.time = lastArrival[date];
    }
  }

  const out = [];
  for (const [date, entries] of days) {
    // Untimed entries inherit the time of the entry before them in trip order,
    // so "lift → train (time TBC) → friends collect" stays in that order.
    const byIdx = [...entries].sort((a, b) => a.idx - b.idx);
    let last = '00:00';
    for (const e of byIdx) {
      if (e.time) last = e.time;
      e.key = e.time || last;
    }
    entries.sort((a, b) => a.key.localeCompare(b.key) || a.idx - b.idx);
    out.push({ date, entries });
  }
  return out;
}

/** Hotel / stay the traveller sleeps at on the night of `date`. */
export function tonight(trip, date) {
  return (trip.items || []).find(
    (it) => isStay(it) && it.status !== 'cancelled' && it.date <= date && (it.endDate || it.date) > date
  );
}

/** Timed moments used by the Today screen. */
export function moments(trip) {
  const out = [];
  const live = (trip.items || []).filter((it) => it.status !== 'cancelled' && it.date);
  for (const it of live) {
    if (isStay(it)) {
      // "Check in from 15:00" is not the next thing to do while you are still
      // travelling there: it becomes due when the day's last leg arrives.
      let at = it.time ? startOf(it) : null;
      for (const leg of live) {
        const end = isTransport(leg) ? endOf(leg) : null;
        if (end && leg.endTime && isoDate(end) === it.date && (!at || end > at)) at = end;
      }
      if (at) out.push({ at, label: typeOf(it).when[0], item: it });
      if (it.endDate && it.endTime) out.push({ at: endOf(it), label: typeOf(it).when[1], item: it, end: true });
    } else if (it.time) {
      out.push({ at: startOf(it), label: typeOf(it).when[0], item: it, until: endOf(it) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/* ---------- to-book, costs ---------- */

export const toBook = (trip) => (trip.items || []).filter((it) => it.status === 'tobook');

export function costs(trip) {
  const rows = (trip.items || []).filter((it) => it.cost && Number(it.cost.amount));
  const sum = (s) => rows.filter((r) => (r.cost.status || 'unknown') === s).reduce((t, r) => t + Number(r.cost.amount), 0);
  return { rows, paid: sum('paid'), due: sum('due'), unknown: sum('unknown') };
}

/* ---------- live status links ---------- */

const STATIONS = {
  aberdeen: 'ABD', 'edinburgh': 'EDB', 'edinburgh waverley': 'EDB', preston: 'PRE',
  'milton keynes': 'MKC', 'milton keynes central': 'MKC', 'bristol temple meads': 'BRI',
  'bristol parkway': 'BPW', 'london euston': 'EUS', euston: 'EUS', 'london paddington': 'PAD',
  paddington: 'PAD', 'london kings cross': 'KGX', "london king's cross": 'KGX', 'kings cross': 'KGX',
  'birmingham new street': 'BHM', reading: 'RDG', 'glasgow central': 'GLC', 'glasgow queen street': 'GLQ',
  inverness: 'INV', perth: 'PTH', dundee: 'DEE', 'york': 'YRK', 'manchester piccadilly': 'MAN',
  'crewe': 'CRE', 'oxford': 'OXF', 'bath spa': 'BTH', 'taunton': 'TAU', 'bicester village': 'BIV',
  'heathrow terminal 5': 'HWV', 'heathrow terminals 2 & 3': 'HXX', 'heathrow terminals 2 and 3': 'HXX',
};
export const stationCode = (name) => STATIONS[String(name || '').trim().toLowerCase()] || '';

const PROVIDER_SITES = [
  ['loganair', 'Loganair', 'https://www.loganair.co.uk/'],
  ['northlink', 'NorthLink', 'https://www.northlinkferries.co.uk/'],
  ['orkney ferries', 'Orkney Ferries', 'https://www.orkneyferries.co.uk/'],
  ['lner', 'LNER', 'https://www.lner.co.uk/'],
  ['transpennine', 'TransPennine Express', 'https://www.tpexpress.co.uk/'],
  ['premier inn', 'Premier Inn', 'https://www.premierinn.com/'],
  ['crosscountry', 'CrossCountry', 'https://www.crosscountrytrains.co.uk/'],
  ['cross country', 'CrossCountry', 'https://www.crosscountrytrains.co.uk/'],
  ['gwr', 'GWR', 'https://www.gwr.com/'],
  ['great western', 'GWR', 'https://www.gwr.com/'],
  ['avanti', 'Avanti West Coast', 'https://www.avantiwestcoast.co.uk/'],
  ['london northwestern', 'London Northwestern', 'https://www.londonnorthwesternrailway.co.uk/'],
];

/** Links that only make sense online. User-added links come first. */
export function liveLinks(it) {
  const links = [];
  for (const line of String(it.links || '').split('\n')) {
    const m = line.split('|');
    const url = (m[1] || m[0] || '').trim();
    if (/^https?:\/\//i.test(url)) links.push({ label: m[1] ? m[0].trim() : url.replace(/^https?:\/\//, ''), url });
  }
  if (it.type === 'flight' && it.number) {
    const code = it.number.replace(/\s+/g, '').toLowerCase().replace(/^([a-z]{2,3})0+(\d)/, '$1$2');
    links.push({ label: `Flight tracker · ${it.number.toUpperCase()}`, url: `https://www.flightradar24.com/data/flights/${code}` });
  }
  if (it.type === 'train') {
    const f = (it.fromCode || stationCode(it.from)).toUpperCase();
    const t = (it.toCode || stationCode(it.to)).toUpperCase();
    if (f && t) {
      links.push({ label: `Live departures ${f} → ${t} · National Rail`, url: `https://www.nationalrail.co.uk/live-trains/departures/${f}/${t}` });
      if (it.date && it.time)
        links.push({ label: 'This service · Realtime Trains', url: `https://www.realtimetrains.co.uk/search/simple/gb-nr:${f}/to/gb-nr:${t}/${it.date}/${it.time.replace(':', '')}` });
    }
    links.push({ label: 'Disruption & engineering works · National Rail', url: 'https://www.nationalrail.co.uk/status-and-disruptions/' });
  }
  const prov = String(it.provider || it.title || '').toLowerCase();
  const site = PROVIDER_SITES.find(([k]) => prov.includes(k));
  if (site) links.push({ label: `${site[1]} website`, url: site[2] });
  return links;
}


/* ---------- misc ---------- */

export function newTrip({ name, start, end }) {
  return {
    id: 'trip_' + Date.now().toString(36),
    name: name || 'New trip', start, end,
    items: [], people: [], checklist: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

export function mapsUrl(q) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

export function telHref(n) {
  return 'tel:' + String(n).replace(/[^\d+]/g, '');
}

/** wa.me wants an international number without +. Assumes UK for 0-prefixed. */
export function whatsappHref(n) {
  let d = String(n).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '44' + d.slice(1);
  return `https://wa.me/${d}`;
}
