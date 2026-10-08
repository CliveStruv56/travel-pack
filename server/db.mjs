// SQLite storage for the sync server (node:sqlite, no dependencies).
// On Railway the database lives on a volume mounted at /data.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path = process.env.DB_PATH || './data/travel-pack.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS trips (id TEXT PRIMARY KEY, data TEXT NOT NULL, rev INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, meta TEXT NOT NULL, type TEXT, size INTEGER, blob BLOB NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS files_trip ON files(trip_id);
    CREATE TABLE IF NOT EXISTS gmail (user TEXT PRIMARY KEY, refresh_token TEXT NOT NULL, email TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, trips TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invites (code_hash TEXT PRIMARY KEY, trip_id TEXT NOT NULL, name TEXT NOT NULL, created_by TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT);
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, keys TEXT NOT NULL, prefs TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_sent (key TEXT PRIMARY KEY, at TEXT NOT NULL);
  `);
  const q = {
    tripList: db.prepare('SELECT id, data, rev, updated_at FROM trips ORDER BY updated_at DESC'),
    tripGet: db.prepare('SELECT data, rev FROM trips WHERE id = ?'),
    tripPut: db.prepare('INSERT INTO trips (id, data, rev, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at'),
    tripDel: db.prepare('DELETE FROM trips WHERE id = ?'),
    fileList: db.prepare('SELECT id, meta, type, size, updated_at FROM files WHERE trip_id = ?'),
    fileGet: db.prepare('SELECT id, trip_id, meta, type, size, blob FROM files WHERE id = ?'),
    filePut: db.prepare('INSERT INTO files (id, trip_id, meta, type, size, blob, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET trip_id = excluded.trip_id, meta = excluded.meta, type = excluded.type, size = excluded.size, blob = excluded.blob, updated_at = excluded.updated_at'),
    fileMeta: db.prepare('UPDATE files SET meta = ?, updated_at = ? WHERE id = ?'),
    fileDel: db.prepare('DELETE FROM files WHERE id = ?'),
    fileDelTrip: db.prepare('DELETE FROM files WHERE trip_id = ?'),
    gmailGet: db.prepare('SELECT refresh_token, email FROM gmail WHERE user = ?'),
    gmailPut: db.prepare('INSERT INTO gmail (user, refresh_token, email, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user) DO UPDATE SET refresh_token = excluded.refresh_token, email = excluded.email, updated_at = excluded.updated_at'),
    gmailDel: db.prepare('DELETE FROM gmail WHERE user = ?'),
    memberByHash: db.prepare('SELECT id, name, trips FROM members WHERE token_hash = ?'),
    memberById: db.prepare('SELECT id, name, trips FROM members WHERE id = ?'),
    memberAdd: db.prepare('INSERT INTO members (id, name, token_hash, trips, created_at) VALUES (?, ?, ?, ?, ?)'),
    memberTrips: db.prepare('UPDATE members SET trips = ? WHERE id = ?'),
    inviteAdd: db.prepare('INSERT INTO invites (code_hash, trip_id, name, created_by, expires_at) VALUES (?, ?, ?, ?, ?)'),
    inviteGet: db.prepare('SELECT trip_id, name, created_by, expires_at, used_at FROM invites WHERE code_hash = ?'),
    kvGet: db.prepare('SELECT value FROM kv WHERE key = ?'),
    kvSet: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    subPut: db.prepare('INSERT INTO push_subs (endpoint, user_id, keys, prefs, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys, prefs = excluded.prefs'),
    subGet: db.prepare('SELECT endpoint, user_id, keys, prefs FROM push_subs WHERE endpoint = ?'),
    subList: db.prepare('SELECT endpoint, user_id, keys, prefs FROM push_subs'),
    subDel: db.prepare('DELETE FROM push_subs WHERE endpoint = ?'),
    sentGet: db.prepare('SELECT 1 FROM push_sent WHERE key = ?'),
    sentPut: db.prepare('INSERT OR IGNORE INTO push_sent (key, at) VALUES (?, ?)'),
    sentPrune: db.prepare('DELETE FROM push_sent WHERE at < ?'),
    inviteUse: db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL'),
  };
  const member = (r) => (r ? { id: r.id, name: r.name, trips: JSON.parse(r.trips) } : null);
  const now = () => new Date().toISOString();
  const sub = (r) => (r ? { endpoint: r.endpoint, userId: r.user_id, keys: JSON.parse(r.keys), prefs: JSON.parse(r.prefs) } : null);
  return {
    listTrips: () => q.tripList.all().map((r) => ({ trip: JSON.parse(r.data), rev: r.rev, updatedAt: r.updated_at })),
    getTrip(id) {
      const r = q.tripGet.get(id);
      return r ? { trip: JSON.parse(r.data), rev: r.rev } : null;
    },
    putTrip: (id, trip, rev) => q.tripPut.run(id, JSON.stringify(trip), rev, now()),
    deleteTrip(id) { q.tripDel.run(id); q.fileDelTrip.run(id); },
    listFiles: (tripId) => q.fileList.all(tripId).map((r) => ({ id: r.id, meta: JSON.parse(r.meta), type: r.type, size: r.size, updatedAt: r.updated_at })),
    getFile(id) {
      const r = q.fileGet.get(id);
      return r ? { id: r.id, tripId: r.trip_id, meta: JSON.parse(r.meta), type: r.type, size: r.size, blob: Buffer.from(r.blob) } : null;
    },
    putFile: (id, tripId, meta, type, blob) => q.filePut.run(id, tripId, JSON.stringify(meta), type, blob.length, blob, now()),
    setFileMeta: (id, meta) => q.fileMeta.run(JSON.stringify(meta), now(), id),
    deleteFile: (id) => q.fileDel.run(id),
    getGmail: (user) => q.gmailGet.get(user) || null,
    putGmail: (user, token, email) => q.gmailPut.run(user, token, email || '', now()),
    deleteGmail: (user) => q.gmailDel.run(user),
    memberByHash: (h) => member(q.memberByHash.get(h)),
    getMember: (id) => member(q.memberById.get(id)),
    addMember: (id, name, hash, trips) => q.memberAdd.run(id, name, hash, JSON.stringify(trips), now()),
    grantTrip(id, tripId) {
      const m = member(q.memberById.get(id));
      if (m && !m.trips.includes(tripId)) q.memberTrips.run(JSON.stringify([...m.trips, tripId]), id);
    },
    addInvite: (hash, tripId, name, by, expires) => q.inviteAdd.run(hash, tripId, name, by, expires),
    getInvite(hash) {
      const r = q.inviteGet.get(hash);
      return r ? { tripId: r.trip_id, name: r.name, createdBy: r.created_by, expiresAt: r.expires_at, usedAt: r.used_at } : null;
    },
    /** True only for the first caller: an invite can be used once. */
    useInvite: (hash, by) => q.inviteUse.run(now(), by, hash).changes === 1,
    getKv: (k) => { const r = q.kvGet.get(k); return r ? JSON.parse(r.value) : null; },
    setKv: (k, v) => q.kvSet.run(k, JSON.stringify(v)),
    putSub: (endpoint, userId, keys, prefs) => q.subPut.run(endpoint, userId, JSON.stringify(keys), JSON.stringify(prefs), now()),
    getSub: (endpoint) => sub(q.subGet.get(endpoint)),
    listSubs: () => q.subList.all().map(sub),
    deleteSub: (endpoint) => q.subDel.run(endpoint),
    wasSent: (key) => !!q.sentGet.get(key),
    markSent: (key, at = now()) => q.sentPut.run(key, at),
    pruneSent: (before) => q.sentPrune.run(before),
    close: () => db.close(),
  };
}
