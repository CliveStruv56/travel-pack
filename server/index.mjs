// Travel Pack server: live sync between phones, Gmail search and AI.
//
//   node server/index.mjs
//
// Environment:
//   USERS              "clive:<token>" (required): owners, who see every trip.
//                      Anyone else joins through a one-time invite link and
//                      sees only the trips they were invited to.
//   SESSION_SECRET     random string for signing the Google sign-in round trip
//   ALLOWED_ORIGINS    comma list of app origins (default: the GitHub Pages app)
//   APP_URL            where to send people back after Gmail sign-in
//   PUBLIC_URL         this server's public https URL (for the Google redirect)
//   DB_PATH            SQLite file (default ./data/travel-pack.db; /data/... on Railway)
//   ANTHROPIC_API_KEY  enables the AI features
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   enable Gmail search
import { createServer } from 'node:http';
import { openDb } from './db.mjs';
import { parseUsers, authenticate, signState, verifyState, rateLimiter, tokenHash, newToken, newCode } from './auth.mjs';
import { randomBytes } from 'node:crypto';
import { mergeTrips, forServer, sameContent } from '../app/merge.js';
import * as ai from './ai.mjs';
import * as gm from './gmail.mjs';

const JSON_LIMIT = 40 * 1024 * 1024;
const FILE_LIMIT = 20 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'Too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, JSON_LIMIT);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw httpError(400, 'Bad JSON'); }
}

export function createApp(opts = {}) {
  const db = opts.db || openDb();
  const users = parseUsers(opts.users ?? process.env.USERS);
  const secret = opts.secret || process.env.SESSION_SECRET || '';
  const origins = (opts.origins || process.env.ALLOWED_ORIGINS || 'https://clivestruv56.github.io').split(',').map((s) => s.trim()).filter(Boolean);
  const appUrl = opts.appUrl || process.env.APP_URL || 'https://clivestruv56.github.io/travel-pack/';
  const aiLimit = rateLimiter(Number(process.env.AI_CALLS_PER_HOUR || 60));
  const redeemLimit = rateLimiter(20);
  const INVITE_DAYS = 7;
  if (!users.length) console.warn('USERS is empty: every request will be refused.');

  const send = (res, status, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    res.writeHead(status, { 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(isBuf ? body : JSON.stringify(body));
  };

  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => routes.push({ method, pattern, handler, auth });

  route('GET', /^\/health$/, () => ({ ok: true }), { auth: false });

  // Owners (USERS) see every trip; invited people only their own.
  const canSee = (who, tripId) => who.all || who.trips.includes(tripId);
  const visible = (who, tripId) => { if (!canSee(who, tripId)) throw httpError(404, 'No such trip'); };

  route('GET', /^\/api\/me$/, ({ user, who }) => ({
    id: user,
    name: who.name,
    owner: who.all,
    ai: ai.aiConfigured(),
    gmail: { available: gm.gmailConfigured(), connected: !!db.getGmail(user), email: db.getGmail(user)?.email || '' },
  }));

  /* ---------- trips ---------- */

  route('GET', /^\/api\/trips$/, ({ who }) => db.listTrips().filter(({ trip }) => canSee(who, trip.id)).map(({ trip, rev, updatedAt }) => ({
    id: trip.id, name: trip.name, start: trip.start, end: trip.end, items: (trip.items || []).length, rev, updatedAt,
  })));

  route('GET', /^\/api\/trips\/([^/]+)$/, ({ m, who }) => {
    visible(who, m[1]);
    const row = db.getTrip(m[1]);
    if (!row) throw httpError(404, 'No such trip');
    return row;
  });

  route('POST', /^\/api\/trips\/([^/]+)\/sync$/, async ({ m, req, who }) => {
    const id = m[1];
    const { trip } = await readJson(req);
    if (!trip || trip.id !== id || !ID.test(id)) throw httpError(400, 'Trip id mismatch');
    const row = db.getTrip(id);
    if (row) visible(who, id);
    // A trip an invited person creates themselves is theirs to see.
    else if (!who.all) db.grantTrip(who.id, id);
    const merged = forServer(mergeTrips(forServer(trip), row?.trip));
    let rev = row?.rev || 0;
    if (!row || !sameContent(merged, row.trip)) {
      rev += 1;
      db.putTrip(id, merged, rev);
    }
    for (const fid of Object.keys(merged.deleted || {})) if (fid.startsWith('f_')) db.deleteFile(fid);
    return { trip: merged, rev };
  });

  route('DELETE', /^\/api\/trips\/([^/]+)$/, ({ m, who }) => {
    if (!who.all) throw httpError(403, 'Only the trip owner can remove a trip from the server.');
    db.deleteTrip(m[1]);
    return { ok: true };
  });

  /* ---------- files (tickets, journal photos) ---------- */

  route('GET', /^\/api\/trips\/([^/]+)\/files$/, ({ m, who }) => {
    visible(who, m[1]);
    const row = db.getTrip(m[1]);
    const gone = row?.trip?.deleted || {};
    return db.listFiles(m[1]).filter((f) => !gone[f.id]);
  });

  route('PUT', /^\/api\/files\/([^/]+)$/, async ({ m, req, url, who }) => {
    const id = m[1];
    const tripId = url.searchParams.get('trip') || '';
    if (!ID.test(id) || !ID.test(tripId)) throw httpError(400, 'Bad id');
    visible(who, tripId);
    const old = db.getFile(id);
    if (old) visible(who, old.tripId);
    let meta = {};
    try { meta = JSON.parse(Buffer.from(req.headers['x-file-meta'] || '', 'base64').toString('utf8') || '{}'); } catch { throw httpError(400, 'Bad meta'); }
    const blob = await readBody(req, FILE_LIMIT);
    if (!blob.length) throw httpError(400, 'Empty file');
    db.putFile(id, tripId, meta, req.headers['content-type'] || 'application/octet-stream', blob);
    return { ok: true };
  });

  route('PATCH', /^\/api\/files\/([^/]+)$/, async ({ m, req, who }) => {
    const f = db.getFile(m[1]);
    if (!f || !canSee(who, f.tripId)) throw httpError(404, 'No such file');
    const { meta } = await readJson(req);
    db.setFileMeta(m[1], { ...f.meta, ...(meta || {}) });
    return { ok: true };
  });

  route('GET', /^\/api\/files\/([^/]+)$/, ({ m, res, who }) => {
    const f = db.getFile(m[1]);
    if (!f || !canSee(who, f.tripId)) throw httpError(404, 'No such file');
    send(res, 200, f.blob, { 'Content-Type': f.type || 'application/octet-stream' });
    return undefined;
  });

  /* ---------- invites ---------- */

  // Anyone who can see a trip can invite someone else to it. The link carries
  // a one-time code; only its hash is stored. Redeeming it gives the new phone
  // its own token, scoped to that trip.
  route('POST', /^\/api\/trips\/([^/]+)\/invites$/, async ({ m, req, who }) => {
    visible(who, m[1]);
    if (!db.getTrip(m[1])) throw httpError(409, 'Sync this trip before inviting anyone.');
    const { name } = await readJson(req);
    const code = newCode();
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86400000).toISOString();
    db.addInvite(tokenHash(code), m[1], String(name || '').trim().slice(0, 40) || 'Guest', who.id, expiresAt);
    return { code, expiresAt };
  });

  route('POST', /^\/api\/invites\/redeem$/, async ({ req }) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!redeemLimit(`ip:${ip}`)) throw httpError(429, 'Too many attempts. Try again later.');
    const { code, name } = await readJson(req);
    const hash = tokenHash(String(code || ''));
    const inv = db.getInvite(hash);
    if (!inv) throw httpError(404, 'This invite link is not valid.');
    if (inv.usedAt) throw httpError(410, 'This invite has already been used. Ask for a new one.');
    if (inv.expiresAt < new Date().toISOString()) throw httpError(410, 'This invite has expired. Ask for a new one.');
    const row = db.getTrip(inv.tripId);
    if (!row) throw httpError(410, 'That trip is no longer on the server.');
    // A phone already connected to this server keeps its own identity.
    const who = authenticate(req.headers.authorization, users, db);
    let token = null;
    let id;
    if (who) {
      id = who.id;
    } else {
      id = `u_${randomBytes(6).toString('hex')}`;
      token = newToken();
    }
    if (!db.useInvite(hash, id)) throw httpError(410, 'This invite has already been used. Ask for a new one.');
    if (!who) db.addMember(id, String(name || '').trim().slice(0, 40) || inv.name, tokenHash(token), [inv.tripId]);
    else if (!who.all) db.grantTrip(id, inv.tripId);
    return { token, name: who?.name || String(name || '').trim().slice(0, 40) || inv.name, tripId: inv.tripId, tripName: row.trip.name || '' };
  }, { auth: false });

  /* ---------- AI ---------- */

  const guardAi = (user) => {
    if (!aiLimit(user)) throw httpError(429, 'Too many AI requests this hour. Try again later.');
  };

  route('POST', /^\/api\/ai\/extract$/, async ({ req, user }) => {
    guardAi(user);
    return ai.extractBookings(await readJson(req));
  });

  // Read a Gmail message (body, PDF and image attachments) straight into the
  // extractor, so attachments never travel to the phone and back.
  route('POST', /^\/api\/ai\/extract-email$/, async ({ req, user }) => {
    needGmail();
    guardAi(user);
    const { messageId, trip } = await readJson(req);
    const msg = await gm.message(user, db, String(messageId || ''));
    const attachments = [];
    for (const a of msg.attachments.filter((x) => /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(x.type) && x.size < 8e6).slice(0, 4)) {
      attachments.push({ type: a.type, data: (await gm.attachment(user, db, msg.id, a.id)).toString('base64') });
    }
    const text = `From: ${msg.from}\nDate: ${msg.date}\nSubject: ${msg.subject}\n\n${msg.text}`;
    return ai.extractBookings({ text, attachments, trip, source: 'email' });
  });

  route('POST', /^\/api\/ai\/chat$/, async ({ req, user }) => {
    guardAi(user);
    return ai.chatAboutTrip(await readJson(req));
  });

  /* ---------- Gmail ---------- */

  const needGmail = () => { if (!gm.gmailConfigured()) throw httpError(503, 'Gmail is not set up on the server.'); };

  route('GET', /^\/api\/gmail\/start$/, ({ user, url }) => {
    needGmail();
    if (!secret) throw httpError(503, 'SESSION_SECRET is not set on the server.');
    return { url: gm.authUrl(signState(user, secret), url.searchParams.get('hint') || '') };
  });

  route('GET', /^\/api\/gmail\/callback$/, async ({ url, res }) => {
    needGmail();
    const back = (q) => { res.writeHead(302, { Location: `${appUrl}#/email?${q}` }); res.end(); };
    const user = verifyState(url.searchParams.get('state'), secret);
    if (!user || !(users.some((u) => u.name === user) || db.getMember(user))) return back('gmail=error&why=state');
    if (url.searchParams.get('error')) return back(`gmail=error&why=${encodeURIComponent(url.searchParams.get('error'))}`);
    try {
      const t = await gm.exchangeCode(url.searchParams.get('code'));
      if (!t.refresh_token) return back('gmail=error&why=no_refresh_token');
      const email = await gm.profileEmail(t.access_token).catch(() => '');
      db.putGmail(user, t.refresh_token, email);
      gm.forget(user);
      return back('gmail=connected');
    } catch {
      return back('gmail=error&why=exchange');
    }
  }, { auth: false });

  route('DELETE', /^\/api\/gmail$/, ({ user }) => { db.deleteGmail(user); gm.forget(user); return { ok: true }; });

  route('GET', /^\/api\/gmail\/search$/, ({ user, url }) => { needGmail(); return gm.search(user, db, url.searchParams.get('q') || ''); });

  route('GET', /^\/api\/gmail\/messages\/([^/]+)$/, ({ user, m }) => { needGmail(); return gm.message(user, db, m[1]); });

  route('GET', /^\/api\/gmail\/messages\/([^/]+)\/attachments\/([^/]+)$/, async ({ user, m, res, url }) => {
    needGmail();
    const buf = await gm.attachment(user, db, m[1], m[2]);
    send(res, 200, buf, { 'Content-Type': url.searchParams.get('type') || 'application/octet-stream' });
    return undefined;
  });

  /* ---------- dispatch ---------- */

  async function handle(req, res) {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Meta');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, 'http://x');
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        let who = null;
        if (r.auth) {
          who = authenticate(req.headers.authorization, users, db);
          if (!who) throw httpError(401, 'Not signed in');
        }
        const out = await r.handler({ req, res, url, m, user: who?.id || null, who });
        if (out !== undefined && !res.headersSent) send(res, 200, out);
        return;
      }
      throw httpError(404, 'Not found');
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: status >= 500 && !e.status ? 'Server error' : e.message });
    }
  }

  return { handle, db };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  const port = Number(process.env.PORT || 8787);
  createServer(app.handle).listen(port, () => console.log(`Travel Pack server on :${port}`));
}
