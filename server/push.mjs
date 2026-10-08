// Web Push with no dependencies: message encryption (RFC 8291, aes128gcm) and
// VAPID sender identification (RFC 8292). The server's VAPID key pair is made
// on first start and kept in the database, so there is nothing to configure.
import { createECDH, createHmac, createCipheriv, randomBytes, generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');

/**
 * Encrypt one push message for one subscription. `asPrivate` and `salt` are
 * only passed by tests (RFC 8291 Appendix A); normally both are fresh.
 */
export function encrypt(plaintext, { p256dh, auth }, { asPrivate, salt } = {}) {
  const ecdh = createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const uaPublic = unb64u(p256dh);
  // computeSecret rejects a point that is not on P-256.
  const secret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(unb64u(auth), secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const s = salt || randomBytes(16);
  const prk = hmac(s, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const header = Buffer.alloc(21);
  s.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** The server's VAPID key pair, created once and stored. */
export function vapidKeys(db) {
  let jwk = db.getKv('vapid');
  if (!jwk) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    jwk = privateKey.export({ format: 'jwk' });
    db.setKv('vapid', jwk);
  }
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
  return { jwk, publicKey };
}

/** VAPID Authorization header for a push service origin. */
export function vapidHeader(endpoint, { jwk, publicKey }, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const enc = (o) => b64u(JSON.stringify(o));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const sig = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${publicKey}`;
}

/**
 * Send one message. Resolves to 'sent', 'gone' (the subscription has expired
 * or been revoked, so it should be deleted) or 'failed'.
 */
export async function send(sub, payload, keys, { subject, ttl = 6 * 3600, urgency = 'high' } = {}) {
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(ttl), Urgency: urgency, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        Authorization: vapidHeader(sub.endpoint, keys, subject),
      },
      body: encrypt(JSON.stringify(payload), sub.keys),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    if (!res.ok) { console.warn(`Push failed ${res.status}: ${await res.text().catch(() => '')}`); return 'failed'; }
    return 'sent';
  } catch (e) {
    console.warn(`Push failed: ${e.message}`);
    return 'failed';
  }
}
