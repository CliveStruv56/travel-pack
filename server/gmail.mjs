// Read-only Gmail access for one or more users.
//
// The user signs in with Google once (gmail.readonly). The server keeps the
// refresh token and trades it for short-lived access tokens, so the phone never
// holds Google credentials. Endpoints are configurable so tests can point them
// at a local fake.
import { htmlToText } from './html-text.mjs';

const env = (k, d) => process.env[k] || d;
const AUTH_URL = () => env('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth');
const TOKEN_URL = () => env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token');
const API = () => env('GMAIL_API_BASE', 'https://gmail.googleapis.com/gmail/v1/users/me');
export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export function gmailConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.PUBLIC_URL);
}

const redirectUri = () => `${process.env.PUBLIC_URL.replace(/\/$/, '')}/api/gmail/callback`;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function authUrl(state, loginHint) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `${AUTH_URL()}?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status === 400 ? 401 : 502, data.error_description || data.error || 'Google sign-in failed');
  return data;
}

export async function exchangeCode(code) {
  return tokenRequest({ code, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
}

const accessCache = new Map();

export function forget(user) { accessCache.delete(user); }

async function accessToken(user, db) {
  const hit = accessCache.get(user);
  if (hit && hit.exp > Date.now() + 30000) return hit.token;
  const row = db.getGmail(user);
  if (!row) throw httpError(409, 'Gmail is not connected.');
  try {
    const t = await tokenRequest({ refresh_token: row.refresh_token, grant_type: 'refresh_token' });
    accessCache.set(user, { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 });
    return t.access_token;
  } catch (e) {
    if (e.status === 401) { db.deleteGmail(user); throw httpError(409, 'Gmail access has expired. Connect Gmail again.'); }
    throw e;
  }
}

async function gmail(user, db, path, token) {
  const tok = token || (await accessToken(user, db));
  const res = await fetch(`${API()}${path}`, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(20000) });
  if (res.status === 401) { forget(user); throw httpError(409, 'Gmail access has expired. Connect Gmail again.'); }
  if (!res.ok) throw httpError(502, `Gmail error ${res.status}`);
  return res.json();
}

export async function profileEmail(accessTok) {
  const p = await gmail(null, null, '/profile', accessTok);
  return p.emailAddress || '';
}

const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

export async function search(user, db, q, max = 20) {
  const list = await gmail(user, db, `/messages?${new URLSearchParams({ q: q || '', maxResults: String(Math.min(max, 30)) })}`);
  const ids = (list.messages || []).map((m) => m.id);
  const out = await Promise.all(ids.map(async (id) => {
    const m = await gmail(user, db, `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
    return {
      id: m.id, threadId: m.threadId, subject: header(m, 'Subject'), from: header(m, 'From'),
      date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(m, 'Date'),
      snippet: htmlToText(m.snippet || '').slice(0, 200),
      hasAttachments: false,
    };
  }));
  return out;
}

const b64 = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function walk(part, acc) {
  if (!part) return acc;
  const mime = (part.mimeType || '').toLowerCase();
  if (part.filename && part.body?.attachmentId) {
    acc.attachments.push({ id: part.body.attachmentId, name: part.filename, type: mime, size: part.body.size || 0 });
  } else if (mime === 'text/plain' && part.body?.data) {
    acc.plain.push(b64(part.body.data).toString('utf8'));
  } else if (mime === 'text/html' && part.body?.data) {
    acc.html.push(b64(part.body.data).toString('utf8'));
  }
  for (const p of part.parts || []) walk(p, acc);
  return acc;
}

export async function message(user, db, id) {
  const m = await gmail(user, db, `/messages/${encodeURIComponent(id)}?format=full`);
  const acc = walk(m.payload, { plain: [], html: [], attachments: [] });
  // Booking emails' plain parts are often a stub ("view in browser"); prefer
  // the HTML when it carries much more text.
  const plain = acc.plain.join('\n\n').trim();
  const fromHtml = htmlToText(acc.html.join('\n'));
  const text = plain.length > fromHtml.length * 0.6 ? plain : fromHtml;
  return {
    id: m.id, threadId: m.threadId, subject: header(m, 'Subject'), from: header(m, 'From'),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(m, 'Date'),
    text: text.slice(0, 100000),
    attachments: acc.attachments,
  };
}

export async function attachment(user, db, msgId, attId) {
  const a = await gmail(user, db, `/messages/${encodeURIComponent(msgId)}/attachments/${encodeURIComponent(attId)}`);
  return b64(a.data);
}
