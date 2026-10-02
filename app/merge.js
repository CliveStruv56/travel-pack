// Merging two copies of the same trip (this phone's and the server's).
//
// Every record in a collection carries `updatedAt`; the newer copy of a record
// wins. Deletions are kept as tombstones in `trip.deleted` ({ id: timestamp }),
// so a record deleted on one phone is not resurrected by the other. Trip-level
// fields (name, dates, notes) are compared as one unit using `metaUpdatedAt`.
//
// The same file runs in the browser and on the server, so both sides always
// agree on what "merged" means.

export const COLLECTIONS = ['items', 'people', 'checklist', 'journal'];
export const META_FIELDS = ['name', 'start', 'end', 'notes'];

// Fields that belong to one phone and are never sent to the server.
export const LOCAL_FIELDS = ['readOnly', 'sourceId', 'sharedFrom', 'sharedAt', 'sync'];

const ts = (x) => (x && x.updatedAt) || '';

function strip(rec) {
  const { updatedAt, ...rest } = rec;
  return rest;
}

/** Stable JSON so key order never counts as a change. */
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * Stamp `updatedAt` on every record that changed since `before`, and record a
 * tombstone for every record that disappeared. Called on each local save, so
 * no editing code has to remember to stamp anything.
 */
export function stampChanges(before, after, now = new Date().toISOString()) {
  after.deleted = { ...(before?.deleted || {}), ...(after.deleted || {}) };
  for (const c of COLLECTIONS) {
    const prev = new Map((before?.[c] || []).map((r) => [r.id, r]));
    const next = after[c] || (after[c] = []);
    for (const r of next) {
      const p = prev.get(r.id);
      if (!p || canon(strip(p)) !== canon(strip(r))) r.updatedAt = now;
      else r.updatedAt = p.updatedAt || r.updatedAt || now;
      delete after.deleted[r.id];
    }
    const ids = new Set(next.map((r) => r.id));
    for (const id of prev.keys()) if (!ids.has(id)) after.deleted[id] = now;
  }
  const metaChanged = !before || META_FIELDS.some((k) => canon(before[k]) !== canon(after[k]));
  after.metaUpdatedAt = metaChanged ? now : before.metaUpdatedAt || now;
  return after;
}

/** Record a deletion of something that lives outside the collections (a file). */
export function tombstone(trip, id, now = new Date().toISOString()) {
  trip.deleted = { ...(trip.deleted || {}), [id]: now };
}

function mergeList(a = [], b = [], deleted) {
  const byId = new Map();
  const order = [];
  for (const r of [...b, ...a]) {
    if (!r || !r.id) continue;
    const cur = byId.get(r.id);
    if (!cur) { byId.set(r.id, r); order.push(r.id); }
    else if (ts(r) > ts(cur)) byId.set(r.id, r);
  }
  return order
    .map((id) => byId.get(id))
    .filter((r) => !(deleted[r.id] && deleted[r.id] >= ts(r)));
}

/** Items keep date order; records without a date stay where they were. */
function sortItems(items) {
  return items
    .map((it, i) => ({ it, i }))
    .sort((x, y) => (x.it.date || '').localeCompare(y.it.date || '') || x.i - y.i)
    .map((x) => x.it);
}

/**
 * Merge two copies of one trip. Neither input is modified. Local-only fields
 * are taken from `local` (pass the phone's copy as `local`).
 */
export function mergeTrips(local, remote) {
  if (!remote) return structuredClone(local);
  if (!local) return structuredClone(remote);
  const deleted = { ...(remote.deleted || {}) };
  for (const [id, t] of Object.entries(local.deleted || {})) if (!deleted[id] || t > deleted[id]) deleted[id] = t;

  const metaFrom = (local.metaUpdatedAt || '') > (remote.metaUpdatedAt || '') ? local : remote;
  const out = structuredClone({ ...remote, ...local });
  for (const k of META_FIELDS) {
    if (metaFrom[k] === undefined) delete out[k];
    else out[k] = structuredClone(metaFrom[k]);
  }
  out.metaUpdatedAt = metaFrom.metaUpdatedAt;
  out.deleted = deleted;
  for (const c of COLLECTIONS) out[c] = structuredClone(mergeList(local[c], remote[c], deleted));
  out.items = sortItems(out.items);
  // Prune tombstones older than 90 days so the record does not grow forever.
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  for (const [id, t] of Object.entries(out.deleted)) if (t < cutoff) delete out.deleted[id];
  return out;
}

/** The copy of a trip that is sent to the server. */
export function forServer(trip) {
  const t = structuredClone(trip);
  for (const k of LOCAL_FIELDS) delete t[k];
  return t;
}

/** True when two trips hold the same shared content. */
export function sameContent(a, b) {
  return canon(forServer(a)) === canon(forServer(b));
}
