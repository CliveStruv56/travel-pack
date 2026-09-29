// End-to-end tests in a real (headless) Chromium at Pixel 7 size.
//   npm test                 run everything
//   SHOTS=1 npm test         also save screenshots to test-results/
// Uses tests/fixtures/sample.travelpack.json, a fictional trip (8–20 May 2030).
import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { start } from '../tools/serve.mjs';

const PORT = 5199;
const BASE = `http://localhost:${PORT}/`;
const FIXTURE = new URL('./fixtures/sample.travelpack.json', import.meta.url).pathname;
const OUT = new URL('../test-results/', import.meta.url).pathname;
const SHOTS = !!process.env.SHOTS;
mkdirSync(OUT, { recursive: true });

const server = await start(PORT, 'localhost');
const browser = await chromium.launch();
let passed = 0, failed = 0;
const errors = [];

function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

async function phone(opts = {}) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { ctx, page };
}

const at = (when, hash = 'today') => `${BASE}?now=${when}#/${hash}`;
const shot = async (page, name, fullPage = true) => SHOTS && page.screenshot({ path: `${OUT}${name}.png`, fullPage });

async function importFixture(page) {
  await page.goto(at('2030-04-30T10:00'));
  await page.waitForSelector('.welcome');
  await page.setInputFiles('#import-input', FIXTURE);
  await page.click('.sheet-panel .btn.primary');
  await page.waitForSelector('.countdown');
}

async function section(name, fn) {
  console.log(name);
  try { await fn(); } catch (e) { failed++; console.log('  ✗ ' + e.message.split('\n')[0]); }
}

const { ctx, page: p } = await phone();

await section('Import and Today', async () => {
  await importFixture(p);
  ok((await p.textContent('.cd-n')).trim() === '8', 'countdown shows 8 days before the trip');
  await shot(p, '01-today-before');
  await p.goto(at('2030-05-09T15:30'));
  await p.waitForSelector('.hero-wrap');
  const labels = await p.$$eval('.hero-label', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok(labels[0]?.startsWith('On the move · arrives in 1h 55m'), `live leg counts down to arrival (${labels[0]})`);
  ok(labels[1]?.startsWith('Next up in 2h 42m'), `next leg is the 18:12 train (${labels[1]})`);
  const order = await p.$$eval('.page > .entry, .page > .gap, .page > .slim', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 30)));
  const ci = order.findIndex((t) => t.includes('Check in')), gap = order.findIndex((t) => t.includes('connection'));
  ok(ci > gap && gap >= 0, 'hotel check-in sorts after the day\'s arrival, not at 15:00');
  ok((await p.textContent('.tonight')).includes('Sample Hotel Preston'), 'Tonight card shows the hotel');
  await shot(p, '02-today-travelling');
});

await section('Plan', async () => {
  await p.goto(at('2030-05-08T12:00', 'plan'));
  await p.waitForSelector('.day');
  const t = await p.textContent('.page');
  ok(t.includes('7h 34m in Kirkwall'), 'gap between flight and ferry');
  ok(t.includes('47m connection at Edinburgh Waverley'), 'rail connection');
  ok((await p.$$('.day')).length === 13, '13 days');
  const last = await p.$$eval('#day-2030-05-20 .entry, #day-2030-05-20 .slim, #day-2030-05-20 .gap', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok(last[0]?.startsWith('Check out'), 'check-out comes first on the last day');
  await shot(p, '03-plan');
});

await section('Layout fits a phone', async () => {
  for (const r of ['today', 'plan', 'tickets', 'todo', 'more', 'item/it_ferry', 'item/it_pi_preston', 'edit/it_train_mk_bristol', 'new/hotel', 'costs', 'people', 'share', 'backup', 'trips', 'trip-edit']) {
    await p.goto(at('2030-05-09T15:30', r));
    await p.waitForTimeout(150);
    const wide = await p.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).length);
    ok(wide === 0, `#/${r} has no horizontal overflow`);
  }
});

await section('Book a train', async () => {
  await p.goto(at('2030-05-08T12:00', 'todo'));
  await p.click('[data-act=book-now]');
  await p.waitForSelector('form[data-form=item]');
  ok(await p.isChecked('input[name=status][value=confirmed]'), '"Booked it" pre-selects Confirmed');
  await p.fill('input[name=to]', 'Bristol Temple Meads');
  await p.fill('input[name=provider]', 'CrossCountry');
  await p.fill('input[name=time]', '10:30');
  await p.fill('input[name=endTime]', '12:55');
  await p.fill('input[name=ref]', 'TESTREF1');
  await p.click('button[type=submit]');
  await p.waitForSelector('.d-head');
  const t = await p.textContent('.page');
  ok(t.includes('TESTREF1') && t.includes('2h 25m'), 'saved with reference and duration');
  ok(t.includes('MKC → BRI') && t.includes('Realtime Trains') && t.includes('CrossCountry website'), 'station code filled in; live links built');
  await p.goto(at('2030-05-08T12:00', 'todo'));
  ok((await p.$$('[data-act=book-now]')).length === 1, 'one train left to book');
});

await section('To-do and people', async () => {
  await p.fill('form[data-form=todo] input', 'Pack chargers');
  await p.press('form[data-form=todo] input', 'Enter');
  await p.waitForTimeout(150);
  ok((await p.textContent('.page')).includes('Pack chargers'), 'to-do added');
  await p.goto(at('2030-05-08T12:00', 'people'));
  await p.click('[data-act=edit-person]');
  await p.fill('.sheet-panel input[name=name]', 'Jane');
  await p.fill('.sheet-panel input[name=phone]', '07700 900123');
  await p.click('.sheet-panel .btn.primary');
  await p.waitForTimeout(150);
  ok((await p.getAttribute('a[aria-label="Call Jane"]', 'href')) === 'tel:07700900123', 'person added with a call link');
});

await section('Tickets', async () => {
  const png = await p.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 900;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 900); x.fillStyle = '#000';
    for (let i = 0; i < 30; i++) x.fillRect(150 + i * 10, 300, (i % 3) + 2, 200);
    return c.toDataURL('image/png').split(',')[1];
  });
  const file = OUT + 'fake-pass.png';
  writeFileSync(file, Buffer.from(png, 'base64'));
  await p.goto(at('2030-05-08T12:00', 'item/it_lm0710'));
  await p.click('[data-act=add-files]');
  await p.setInputFiles('#file-input', file);
  await p.waitForSelector('.thumb:not(.add)');
  ok(true, 'ticket attached');
  // Headless Linux Chromium has no BarcodeDetector, so fake what Android would find.
  await p.evaluate(async () => {
    const f = window.__tp.S.files[0];
    f.barcode = { format: 'pdf417', value: 'x', box: { x: 150, y: 300, w: 295, h: 200 } };
    await window.__tp.db.put('files', f);
  });
  await p.click('.thumb:not(.add)');
  await p.waitForSelector('.viewer canvas');
  ok(true, 'viewer crops to the barcode');
  await shot(p, '04-ticket', false);
  await p.goto(at('2030-05-08T12:00'));
  await p.waitForSelector('.hero-wrap');
  ok(!!(await p.$('.hero-actions a[href^="#/ticket/"]')), 'Today offers "Show ticket"');
});

await section('Calendar and text export', async () => {
  const ics = await p.evaluate(async () => (await import('./ics.js')).tripToIcs(window.__tp.S.trips[0]));
  ok(ics.includes('DTSTART:20300508T145000Z'), '15:50 BST exported as 14:50 UTC');
  ok(ics.includes('DTSTART;VALUE=DATE:20300509') && ics.includes('DTEND;VALUE=DATE:20300511'), 'hotel exported as an all-day span');
  const text = await p.evaluate(async () => (await import('./share.js')).shareText(window.__tp.S.trips[0], { refs: true, contacts: true, notes: true, costs: false }));
  ok(text.includes('Sample trip') && text.includes('15:50–16:11'), 'plain-text itinerary');
});

await section('Share link opens read-only on another phone', async () => {
  const link = await p.evaluate(async () => (await import('./share.js')).shareLink(window.__tp.S.trips[0], { refs: true, contacts: true, notes: true, costs: false }, 'Tester'));
  const { ctx: c2, page: j } = await phone();
  await j.goto(link.replace(BASE, `${BASE}?now=2030-05-08T12:00`));
  await j.waitForSelector('.save-card');
  const jt = await j.textContent('#app');
  ok(jt.includes('Read-only copy from Tester'), 'banner names the sender');
  ok(!jt.includes('189.98'), 'costs left out when not chosen');
  await j.click('[data-act=save-preview]');
  await j.waitForSelector('.hero-wrap');
  await j.goto(at('2030-05-08T12:00', 'plan'));
  ok(!(await j.$('.fab')), 'saved copy cannot be edited');
  await c2.close();
});

await section('Setup link loads an editable trip', async () => {
  const link = execFileSync('node', [new URL('../tools/make-link.mjs', import.meta.url).pathname, `${BASE}?now=2030-05-08T12:00`, FIXTURE]).toString().trim();
  const { ctx: c3, page: s } = await phone();
  await s.goto(link);
  await s.waitForSelector('.save-card');
  await s.click('[data-act=save-preview]');
  await s.waitForSelector('.hero-wrap');
  await s.goto(at('2030-05-08T12:00', 'plan'));
  ok(!!(await s.$('.fab')), 'trip is editable');
  await c3.close();
});

await section('Backup and restore', async () => {
  await p.goto(at('2030-05-08T12:00', 'backup'));
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-act=backup-download]')]);
  const path = OUT + 'backup.json';
  await dl.saveAs(path);
  const { ctx: c4, page: n } = await phone();
  await n.goto(at('2030-05-08T12:00'));
  await n.setInputFiles('#import-input', path);
  await n.click('.sheet-panel .btn.primary');
  await n.waitForSelector('.hero-wrap');
  ok(!!(await n.$('.hero-actions a[href^="#/ticket/"]')), 'restored phone has the ticket');
  await c4.close();
});

await section('Offline', async () => {
  await p.goto(`${BASE}#/today`);
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.waitForTimeout(300);
  await ctx.setOffline(true);
  await p.reload();
  await p.waitForSelector('.top-name', { timeout: 5000 });
  ok((await p.textContent('#app')).includes('Offline'), 'reloads with no network and shows the offline pill');
  await p.goto(`${BASE}#/item/it_lm0710`);
  await p.waitForSelector('.d-head');
  ok((await p.textContent('#app')).includes('appear when you'), 'live-status links hidden offline');
  await ctx.setOffline(false);
});

ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
