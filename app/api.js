// Talking to the Travel Pack server (sync, Gmail, AI). The phone stores the
// server address and its own access token; nothing here runs without them.
import { db } from './db.js';

let server = null;

export async function loadServer() {
  server = (await db.get('meta', 'server')) || null;
  return server;
}

export const getServer = () => server;

export async function setServer(s) {
  server = s;
  if (s) await db.put('meta', s, 'server');
  else await db.del('meta', 'server');
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(path, { method = 'GET', body, headers = {}, raw = false, timeout = 30000 } = {}) {
  if (!server) throw new ApiError(0, 'This phone is not connected to a Travel Pack server.');
  if (!navigator.onLine) throw new ApiError(0, 'No signal. Try again when you are online.');
  const isBlob = body instanceof Blob;
  let res;
  try {
    res = await fetch(server.url.replace(/\/$/, '') + path, {
      method,
      headers: { Authorization: `Bearer ${server.token}`, ...(body && !isBlob ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? (isBlob ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new ApiError(0, e.name === 'TimeoutError' ? 'The server took too long to answer.' : 'Could not reach the server.');
  }
  if (!res.ok) {
    let msg = `Server error ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new ApiError(res.status, msg);
  }
  return raw ? res : res.json();
}

/** "#connect=…" links carry { u: server url, t: token, n: name }. */
export function readConnectLink(fragment) {
  const b64 = fragment.replace(/^#?connect=/, '').replace(/-/g, '+').replace(/_/g, '/');
  const data = JSON.parse(decodeURIComponent(escape(atob(b64))));
  if (!data || !/^https?:\/\//.test(data.u || '') || !data.t || !data.n) throw new Error('Not a Travel Pack connect link');
  return { url: data.u.replace(/\/$/, ''), token: data.t, name: data.n };
}

const b64url = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * "#join=…" links invite someone to share one trip live. They carry the server
 * address and a one-time code (never a long-lived token), plus names to show.
 */
export function joinLink(appUrl, { url, code, trip, from, name }) {
  return `${appUrl}#join=${b64url({ u: url, c: code, t: trip, f: from, n: name })}`;
}

export function readJoinLink(fragment) {
  const b64 = fragment.replace(/^#?join=/, '').replace(/-/g, '+').replace(/_/g, '/');
  const data = JSON.parse(decodeURIComponent(escape(atob(b64))));
  if (!data || !/^https?:\/\//.test(data.u || '') || !data.c) throw new Error('Not a Travel Pack invite link');
  return { url: data.u.replace(/\/$/, ''), code: data.c, trip: data.t || '', from: data.f || '', name: data.n || '' };
}

/** Trade an invite code for access. Works before this phone has any server. */
export async function redeemInvite(url, code, name, token) {
  if (!navigator.onLine) throw new ApiError(0, 'No signal. Try again when you are online.');
  let res;
  try {
    res = await fetch(`${url.replace(/\/$/, '')}/api/invites/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ code, name }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Server error ${res.status}`);
  return data;
}
