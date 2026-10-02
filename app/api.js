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
