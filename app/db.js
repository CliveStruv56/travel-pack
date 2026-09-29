// IndexedDB storage. Everything lives on the phone; nothing is sent anywhere.
//   trips  – one record per trip (items, people, checklist inside)
//   files  – ticket images / PDFs as Blobs, linked to a trip and an item
//   meta   – small key/value settings (current trip id, etc.)

const DB_NAME = 'travel-pack';
const DB_VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('trips')) db.createObjectStore('trips', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) {
        const s = db.createObjectStore('files', { keyPath: 'id' });
        s.createIndex('tripId', 'tripId');
        s.createIndex('itemId', 'itemId');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  getAll: (store) => open().then((d) => reqP(d.transaction(store).objectStore(store).getAll())),
  get: (store, key) => open().then((d) => reqP(d.transaction(store).objectStore(store).get(key))),
  put: (store, value, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  byIndex: (store, index, value) =>
    open().then((d) => reqP(d.transaction(store).objectStore(store).index(index).getAll(value))),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  async delWhere(store, index, value) {
    const rows = await db.byIndex(store, index, value);
    for (const r of rows) await db.del(store, r.id);
    return rows.length;
  },
};

// Files that arrived through Android's share sheet are parked by the service
// worker in a separate tiny database until the app attaches them to a booking.
export async function takeInbox() {
  const d = await new Promise((resolve, reject) => {
    const r = indexedDB.open('travel-pack-inbox', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('inbox', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const rows = await reqP(d.transaction('inbox').objectStore('inbox').getAll());
  return {
    rows,
    clear: () => reqP(d.transaction('inbox', 'readwrite').objectStore('inbox').clear()),
    remove: (id) => reqP(d.transaction('inbox', 'readwrite').objectStore('inbox').delete(id)),
  };
}
