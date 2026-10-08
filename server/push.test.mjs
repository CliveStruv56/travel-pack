// Reminders: Web Push encryption and signing, subscriptions, and the ticker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createECDH, createHmac, createDecipheriv, createPublicKey, verify, randomBytes } from 'node:crypto';
import { createApp } from './index.mjs';
import { openDb } from './db.mjs';
import * as push from './push.mjs';
import { plan, due, localToUtc, LEAD_MIN } from './reminders.mjs';
import { stampChanges } from '../app/merge.js';

const u = (s) => Buffer.from(s.replace(/\s/g, ''), 'base64url');

test('encryption matches the worked example in RFC 8291', () => {
  const out = push.encrypt(u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'), {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, { asPrivate: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: u('DGv6ra1nlYgDCS1FRnbzlw') });
  assert.equal(out.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

/** The receiving browser's half: decrypt an aes128gcm push body. */
function decrypt(body, uaEcdh, auth) {
  const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const uaPublic = uaEcdh.getPublicKey();
  const ikm = hmac(hmac(auth, uaEcdh.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const d = createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2, 'padding delimiter');
  return JSON.parse(pt.subarray(0, -1).toString());
}

let pushSvc, received = [], gone = new Set();
let app, server, base;
const OWNER = 'Bearer owner-tok';
const call = (path, { auth = OWNER, method = 'GET', body } = {}) =>
  fetch(base + path, { method, headers: { ...(auth ? { Authorization: auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

function phoneKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

before(async () => {
  // A fake push service: records what arrives, answers 410 for revoked endpoints.
  pushSvc = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (gone.has(req.url)) { res.writeHead(410); return res.end(); }
    received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(201); res.end();
  });
  await new Promise((r) => pushSvc.listen(0, r));
  app = createApp({ db: openDb(':memory:'), users: 'owner:owner-tok', secret: 's', origins: 'https://app.example', appUrl: 'https://app.example/tp/', pushHosts: /^localhost$/ });
  server = createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(() => { server.close(); pushSvc.close(); });

const endpoint = (name) => `http://localhost:${pushSvc.address().port}/push/${name}`;

function trip() {
  return stampChanges(null, {
    id: 'trip_r', name: 'Islands', start: '2030-05-08', end: '2030-05-09', items: [
      { id: 'f1', type: 'flight', date: '2030-05-08', time: '15:50', from: 'Sanday', to: 'Kirkwall', provider: 'Loganair', number: 'LM0710', ref: 'SMP001' },
      { id: 'h1', type: 'hotel', title: 'Harbour Hotel', date: '2030-05-08', endDate: '2030-05-09', endTime: '11:00' },
      { id: 'x1', type: 'ferry', status: 'cancelled', date: '2030-05-08', time: '09:00' },
    ], people: [], checklist: [], journal: [],
  }, '2030-01-01T00:00:00.000Z');
}

test('reminder plan: departures by type, check-out, briefing; cancelled skipped; BST respected', () => {
  const list = plan(trip());
  const dep = list.find((r) => r.key.startsWith('dep:'));
  // 15:50 BST = 14:50Z; two hours before a flight.
  assert.equal(new Date(dep.at).toISOString(), '2030-05-08T12:50:00.000Z');
  assert.equal(LEAD_MIN.flight, 120);
  assert.match(dep.title, /Flight at 15:50: Sanday → Kirkwall/);
  assert.match(dep.body, /Ref SMP001/);
  assert.ok(!list.some((r) => r.key.includes('x1')), 'cancelled booking has no reminder');
  assert.ok(list.some((r) => r.key.startsWith('out:') && r.title === 'Check out by 11:00'));
  const briefs = list.filter((r) => r.key.startsWith('brief:'));
  assert.equal(briefs.length, 2);
  assert.equal(new Date(briefs[0].at).toISOString(), '2030-05-08T06:30:00.000Z');
  assert.equal(plan(trip(), { departures: false, briefing: false }).length, 0);
  assert.equal(new Date(localToUtc('2030-12-01', '09:00')).toISOString(), '2030-12-01T09:00:00.000Z', 'GMT in winter');
  assert.deepEqual(due(list, dep.at + 31 * 60000).map((r) => r.key).filter((k) => k === dep.key), [], 'stale reminders are skipped');
});

test('subscribe only to real push services', async () => {
  const k = phoneKeys();
  const bad = await call('/api/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'http://169.254.169.254/latest', keys: k.keys } } });
  assert.equal(bad.status, 400);
  const prod = createApp({ db: openDb(':memory:'), users: 'a:b' });
  const s2 = createServer(prod.handle); await new Promise((r) => s2.listen(0, r));
  const r = await fetch(`http://localhost:${s2.address().port}/api/push/subscribe`, { method: 'POST', headers: { Authorization: 'Bearer b', 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: { endpoint: 'https://evil.example/x', keys: k.keys } }) });
  assert.equal(r.status, 400);
  const ok = await fetch(`http://localhost:${s2.address().port}/api/push/subscribe`, { method: 'POST', headers: { Authorization: 'Bearer b', 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: k.keys } }) });
  assert.equal(ok.status, 200);
  s2.close();
});

test('test message arrives encrypted and VAPID-signed; ticker sends each reminder once', async () => {
  const k = phoneKeys();
  const ep = endpoint('clive');
  assert.equal((await call('/api/push/subscribe', { method: 'POST', body: { subscription: { endpoint: ep, keys: k.keys }, prefs: { briefingTime: '07:00' } } })).status, 200);
  const { publicKey } = await (await call('/api/push/key')).json();

  assert.equal((await call('/api/push/test', { method: 'POST', body: { endpoint: ep } })).status, 200);
  const msg = received.pop();
  assert.equal(msg.headers['content-encoding'], 'aes128gcm');
  assert.equal(decrypt(msg.body, k.ecdh, k.auth).title, 'Travel Pack reminders are on');
  // The VAPID token is signed by the key the phone subscribed with.
  const [, t, kk] = /^vapid t=([^,]+), k=(.+)$/.exec(msg.headers.authorization);
  assert.equal(kk, publicKey);
  const [h, p, sig] = t.split('.');
  const pub = u(publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') };
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, u(sig)));
  assert.equal(JSON.parse(u(p)).aud, new URL(ep).origin);

  await call('/api/trips/trip_r/sync', { method: 'POST', body: { trip: trip() } });
  const up = await (await call('/api/push/upcoming', { method: 'POST', body: { endpoint: ep } })).json();
  void up; // trip is in 2030, so everything is upcoming
  assert.ok(Array.isArray(up) && up.length >= 3);

  const depAt = Date.parse('2030-05-08T12:50:00.000Z');
  received = [];
  assert.equal(await app.tick(depAt + 60000), 1);
  assert.match(decrypt(received[0].body, k.ecdh, k.auth).title, /Flight at 15:50/);
  assert.equal(await app.tick(depAt + 120000), 0, 'not sent twice');
  // Briefing at the person's chosen time (07:00 BST = 06:00Z).
  assert.equal(await app.tick(Date.parse('2030-05-08T06:00:30.000Z')), 1);
  assert.match(decrypt(received[1].body, k.ecdh, k.auth).body, /15:50 Sanday → Kirkwall/);

  // A revoked subscription is forgotten.
  gone.add('/push/clive');
  await call('/api/push/test', { method: 'POST', body: { endpoint: ep } });
  assert.equal((await call('/api/push/upcoming', { method: 'POST', body: { endpoint: ep } })).status, 404);
});

test('reminders only cover trips the person can see', async () => {
  const { code } = await (await call('/api/trips/trip_r/invites', { method: 'POST', body: { name: 'Sam' } })).json();
  const { token } = await (await call('/api/invites/redeem', { auth: null, method: 'POST', body: { code, name: 'Sam' } })).json();
  const other = { ...trip(), id: 'trip_secret', name: 'Secret', items: [{ id: 's1', type: 'flight', date: '2030-05-08', time: '15:50', from: 'A', to: 'B' }] };
  await call('/api/trips/trip_secret/sync', { method: 'POST', body: { trip: other } });
  const k = phoneKeys();
  const ep = endpoint('sam');
  await call('/api/push/subscribe', { auth: `Bearer ${token}`, method: 'POST', body: { subscription: { endpoint: ep, keys: k.keys }, prefs: { briefing: false } } });
  received = [];
  await app.tick(Date.parse('2030-05-08T12:50:30.000Z'));
  const titles = received.filter((m) => m.path === '/push/sam').map((m) => decrypt(m.body, k.ecdh, k.auth).title);
  assert.deepEqual(titles, ['Flight at 15:50: Sanday → Kirkwall']);
  // Someone else's phone cannot use or remove Sam's subscription.
  assert.equal((await call('/api/push/test', { method: 'POST', body: { endpoint: ep } })).status, 404);
});
