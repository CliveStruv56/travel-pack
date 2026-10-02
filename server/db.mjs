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
  };
  const now = () => new Date().toISOString();
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
    close: () => db.close(),
  };
}
