// Offline cache for the app shell, plus Android share-target handling.
// __BUILD__ is replaced with the commit id when deployed (and a timestamp by
// tools/serve.mjs), so every release gets a fresh cache. Every file in app/
// must be listed in ASSETS; `npm run check` enforces it.
const VERSION = 'tp-__BUILD__';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './util.js', './db.js', './model.js',
  './icons.js', './ics.js', './share.js', './api.js', './merge.js', './weather.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)));
  // First install activates at once; updates wait until the app says so.
  if (!self.registration.active) self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

function inboxDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('travel-pack-inbox', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('inbox', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll('files').filter((f) => f && f.size);
  const text = [form.get('text'), form.get('url')].filter(Boolean).join('\n').trim();
  const title = String(form.get('title') || '').trim();
  const db = await inboxDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('inbox', 'readwrite');
    const s = tx.objectStore('inbox');
    if (text) s.put({ id: 'in_' + Date.now().toString(36) + 't', name: title || 'Shared text', text, at: Date.now() });
    for (const f of files) {
      s.put({ id: 'in_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), name: f.name || 'shared file', type: f.type, blob: f, at: Date.now() });
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return Response.redirect('./#/inbox', 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request).catch(() => Response.redirect('./#/tickets', 303)));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then((r) => r || fetch(e.request)));
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }))
  );
});
