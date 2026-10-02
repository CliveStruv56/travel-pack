// Zero-dependency static server for app/.
//   npm start                 → http://localhost:5173
//   PORT=8080 HOST=0.0.0.0 npm start   (reachable from a phone on the same Wi-Fi;
//   note the service worker / offline mode only runs on localhost or HTTPS)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../app/', import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || 'localhost';
const BUILD = 'dev' + Date.now().toString(36);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

export function start(port = PORT, host = HOST, { build = BUILD } = {}) {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      let body = await readFile(file);
      if (path.endsWith('/sw.js')) body = body.toString().replaceAll('__BUILD__', build);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await start();
  console.log(`Travel Pack on http://${HOST}:${PORT}/  (add ?now=2030-05-08T12:00 to preview a date)`);
}
