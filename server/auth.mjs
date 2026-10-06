// Who may use the server. USERS="clive:<token>,jane:<token>" in the
// environment; each phone holds its own token (given to it by a connect link).
import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const sha = (s) => createHash('sha256').update(String(s)).digest();

export function parseUsers(spec = process.env.USERS || '') {
  return spec.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf(':');
    return { name: p.slice(0, i).trim(), hash: sha(p.slice(i + 1).trim()) };
  }).filter((u) => u.name && u.hash);
}

export const tokenHash = (token) => sha(token).toString('hex');

/**
 * Who is calling. People in USERS see every trip on the server. People who
 * joined through an invite (db members) see only the trips they were invited
 * to, plus any they create themselves.
 */
export function authenticate(header, users, db) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  if (!m) return null;
  const h = sha(m[1]);
  let found = null;
  for (const u of users) if (timingSafeEqual(h, u.hash)) found = u.name;
  if (found) return { id: found, name: found, all: true, trips: [] };
  const member = db?.memberByHash(h.toString('hex'));
  return member ? { ...member, all: false } : null;
}

export const newToken = () => randomBytes(24).toString('hex');
export const newCode = () => randomBytes(16).toString('base64url');

/** Signed, expiring state for the Google sign-in round trip. */
export function signState(user, secret, ttlMs = 10 * 60000) {
  const body = Buffer.from(JSON.stringify({ u: user, e: Date.now() + ttlMs, n: randomBytes(8).toString('hex') })).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyState(state, secret) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString());
  return data.e > Date.now() ? data.u : null;
}

/** Simple per-user rate limit: `limit` calls per rolling hour. */
export function rateLimiter(limit) {
  const hits = new Map();
  return (user) => {
    const now = Date.now();
    const list = (hits.get(user) || []).filter((t) => now - t < 3600000);
    if (list.length >= limit) { hits.set(user, list); return false; }
    list.push(now);
    hits.set(user, list);
    return true;
  };
}
