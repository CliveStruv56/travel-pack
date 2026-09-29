// Sharing and backup formats.
//
// Share link: the plan is compressed into the part of the URL after '#'.
// Browsers never send that part to the web server, so the plan goes only to
// the person you send the link to.
//
// Trip / backup file: JSON with every attachment embedded as base64, so one
// file restores everything on a new phone.
import { buildDays, itemTitle, itemSubtitle, isStay, typeOf, STATUS } from './model.js';
import { fmtDay, blobToBase64, base64ToBlob } from './util.js';

const PRIVATE_FIELDS = { refs: ['ref', 'eticket'], costs: ['cost'], contacts: ['phone'], notes: ['notes', 'links'] };

/** Copy of a trip with the parts the sender chose to leave out removed. */
export function redact(trip, opts) {
  const t = structuredClone(trip);
  delete t.checklist;
  t.items = (t.items || []).map((it) => {
    const c = { ...it };
    for (const [k, fields] of Object.entries(PRIVATE_FIELDS)) if (!opts[k]) for (const f of fields) delete c[f];
    if (!opts.contacts) delete c.people;
    return c;
  });
  if (!opts.contacts) t.people = [];
  return t;
}

async function compress(str) {
  const cs = new Blob([str]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(cs).arrayBuffer());
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decompress(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(ds).text();
}

export async function shareLink(trip, opts, from) {
  const payload = { v: 1, from: from || '', sharedAt: new Date().toISOString(), trip: redact(trip, opts) };
  const base = location.href.split('#')[0].split('?')[0];
  return `${base}#share=${await compress(JSON.stringify(payload))}`;
}

export async function readShareLink(fragment) {
  const data = fragment.replace(/^#?share=/, '');
  const payload = JSON.parse(await decompress(data));
  if (!payload || payload.v !== 1 || !payload.trip) throw new Error('Not a Travel Pack link');
  return payload;
}

/** Plain-text itinerary for WhatsApp / SMS / email. */
export function shareText(trip, opts) {
  const t = redact(trip, opts);
  const out = [`${t.name}`];
  for (const day of buildDays(t)) {
    const lines = [];
    for (const e of day.entries) {
      if (e.kind === 'gap' || e.kind === 'night') continue;
      const it = e.item;
      if (it.status === 'cancelled') continue;
      const flag = it.status === 'tobook' ? ' (not booked yet)' : '';
      if (e.kind === 'checkin') {
        lines.push(`• ${isStay(it) && it.type === 'hotel' ? 'Hotel' : 'Staying'}: ${itemTitle(it)}${it.time ? ` (from ${it.time})` : ''}${it.address ? ` – ${it.address}` : ''}${flag}`);
      } else if (e.kind === 'checkout') {
        if (it.type === 'hotel') lines.push(`• Check out ${itemTitle(it)}${it.endTime ? ` by ${it.endTime}` : ''}`);
      } else {
        const times = it.time ? `${it.time}${it.endTime ? `–${it.endTime}` : ''} ` : '';
        const sub = itemSubtitle(it);
        lines.push(`• ${times}${typeOf(it).label}: ${itemTitle(it)}${sub ? ` (${sub})` : ''}${flag}`);
        if (opts.refs && it.ref) lines.push(`   Ref ${it.ref}`);
      }
    }
    if (lines.length) out.push('', fmtDay(day.date), ...lines);
  }
  return out.join('\n');
}

/* ---------- files ---------- */

export async function exportBundle(kind, trips, files) {
  const outFiles = [];
  for (const f of files) {
    const { blob, ...meta } = f;
    outFiles.push({ ...meta, data: await blobToBase64(blob) });
  }
  return JSON.stringify({ format: 'travel-pack', version: 1, kind, exportedAt: new Date().toISOString(), trips, files: outFiles });
}

export function parseBundle(text) {
  const b = JSON.parse(text);
  if (b.format !== 'travel-pack' || !Array.isArray(b.trips)) throw new Error('This is not a Travel Pack file.');
  b.files = (b.files || []).map(({ data, ...meta }) => ({ ...meta, blob: base64ToBlob(data, meta.type || 'application/octet-stream') }));
  return b;
}

export const statusLabel = (s) => (STATUS[s] || STATUS.confirmed).label;
