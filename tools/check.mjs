// Static checks that don't need a browser:
//  - every file in app/ is precached by the service worker (or offline breaks)
//  - no file in app/ loads anything from another origin (the app must work offline)
//  - no real trip data has been committed
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';

const APP = new URL('../app/', import.meta.url).pathname;
let failed = 0;
const fail = (m) => { console.error('✗ ' + m); failed++; };

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = walk(APP).map((f) => relative(APP, f)).filter((f) => f !== 'sw.js');

const sw = readFileSync(join(APP, 'sw.js'), 'utf8');
const assets = [...sw.match(/const ASSETS = \[([\s\S]*?)\];/)?.[1].matchAll(/'\.\/([^']*)'/g) ?? []].map((m) => m[1]).filter(Boolean);
if (!assets.length) fail('Could not find the ASSETS list in app/sw.js');
for (const f of files) if (!assets.includes(f)) fail(`app/${f} is not in ASSETS in app/sw.js, so it will not work offline`);
for (const a of assets) if (!files.includes(a)) fail(`ASSETS lists ./${a} but app/${a} does not exist (install would fail)`);
if (!sw.includes("'tp-__BUILD__'")) fail("app/sw.js VERSION must stay 'tp-__BUILD__' (it is filled in at deploy)");

for (const f of files.filter((f) => /\.(js|html|css|webmanifest)$/.test(f))) {
  const src = readFileSync(join(APP, f), 'utf8');
  for (const m of src.matchAll(/(?:src|href)=["'](https?:)?\/\/[^"']+["']|@import\s+url\(\s*["']?https?:|import\s[^;]*from\s+["']https?:/g)) {
    fail(`app/${f} loads a remote resource (${m[0].slice(0, 60)}); the app must be self-contained`);
  }
}

try {
  const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n');
  for (const t of tracked) if (t.startsWith('trips/') && t !== 'trips/README.md') fail(`${t} is committed; real trips must stay out of the repo`);
} catch { /* not a git checkout */ }

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log(`✓ ${assets.length} assets precached, no remote resources, no trip data committed`);
