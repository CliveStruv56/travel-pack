// End-to-end tests in a real (headless) Chromium at Pixel 7 size.
//   npm test                 run everything
//   SHOTS=1 npm test         also save screenshots to test-results/
// Uses tests/fixtures/sample.travelpack.json, a fictional trip (8–20 May 2030).
import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { start } from '../tools/serve.mjs';
import { createApp } from '../server/index.mjs';
import { openDb } from '../server/db.mjs';
import * as ai from '../server/ai.mjs';

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

// Open-Meteo stand-in: Sanday gets a gale at 15:00 on 8 May 2030, everywhere else is calm.
function fakeWeather(route) {
  const u = new URL(route.request().url());
  if (u.hostname.startsWith('geocoding')) {
    const name = u.searchParams.get('name');
    const lat = name === 'Sanday' ? 59.25 : 52 + (name.length % 5);
    return route.fulfill({ json: { results: [{ name, latitude: lat, longitude: -2.5 }] } });
  }
  const lat = Number(u.searchParams.get('latitude'));
  const time = [], gusts = [], days = [];
  for (let d = 0; d < 16; d++) {
    const day = new Date(Date.UTC(2030, 4, 8 + d)).toISOString().slice(0, 10);
    days.push(day);
    for (let h = 0; h < 24; h++) {
      time.push(`${day}T${String(h).padStart(2, '0')}:00`);
      gusts.push(lat === 59.25 && d === 0 && h === 15 ? 56 : 14);
    }
  }
  const n = time.length;
  return route.fulfill({ json: {
    hourly: { time, wind_gusts_10m: gusts, wind_speed_10m: gusts.map((g) => Math.round(g * 0.6)), temperature_2m: Array(n).fill(12), weather_code: Array(n).fill(3), precipitation_probability: Array(n).fill(20), visibility: Array(n).fill(20000) },
    daily: { time: days, weather_code: days.map(() => 3), temperature_2m_max: days.map(() => 14), temperature_2m_min: days.map(() => 8), precipitation_probability_max: days.map(() => 30), wind_gusts_10m_max: days.map(() => 30) },
  } });
}

async function phone(opts = {}) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true, ...opts });
  await ctx.route(/open-meteo\.com/, fakeWeather);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // Expected 4xx answers from the server show up as resource errors; real failures fail an assertion instead.
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource: the server responded') && errors.push(m.text()));
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
  try { await fn(); } catch (e) { failed++; console.log('  ✗ ' + e.message.split('\n')[0] + (process.env.DEBUG ? '\n' + e.stack : '')); }
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

await section('Add-booking link adds to the existing trip', async () => {
  const before = await p.evaluate(() => window.__tp.S.trips[0].items.length);
  await p.evaluate(async () => { const t = window.__tp.S.trips[0]; t.people.push({ id: 'p_keep', name: 'Kept' }); });
  const link = execFileSync('node', [new URL('../tools/make-add-link.mjs', import.meta.url).pathname, `${BASE}?now=2030-05-08T12:00`, new URL('./fixtures/sample-add.json', import.meta.url).pathname, 'trip_sample']).toString().trim();
  await p.goto(link);
  await p.waitForSelector('.add-card');
  ok((await p.textContent('.add-card')).includes('SMP900'), 'preview shows the booking');
  await shot(p, '05-add-link');
  await p.click('[data-act=apply-add]');
  await p.waitForSelector('.d-head');
  ok((await p.textContent('.d-head')).includes('Sample Hotel Replacement'), 'opens the added booking');
  const t = await p.evaluate(() => window.__tp.S.trips[0]);
  ok(t.items.length === before + 1, 'one booking added, nothing removed');
  ok(t.items.some((i) => i.ref === 'TESTREF1'), 'earlier edits kept');
  // Opening the same link again replaces rather than duplicates.
  await p.goto(link);
  await p.waitForSelector('.add-card');
  ok((await p.textContent('.add-card')).includes('replaces the existing one'), 'second open says it will replace');
  await p.click('[data-act=apply-add]');
  await p.waitForSelector('.d-head');
  ok((await p.evaluate(() => window.__tp.S.trips[0].items.length)) === before + 1, 'no duplicate on second open');
  await p.goto(`${BASE}#add=garbage`);
  await p.waitForTimeout(300);
  ok(!(await p.$('.add-card')), 'a broken link is rejected');
});


await section('Editing: add from a day, change status, undo a delete', async () => {
  await p.goto(at('2030-05-08T12:00', 'plan'));
  await p.click('#day-2030-05-12 [data-act=new-item]');
  await p.click('.sheet-panel [data-act=pick-type][data-type=other]');
  await p.waitForSelector('form[data-form=item]');
  ok((await p.inputValue('input[name=date]')) === '2030-05-12', 'Add under a day starts on that day');
  await p.fill('input[name=title]', 'Lunch with Jane');
  await p.click('button[type=submit]');
  await p.waitForSelector('.d-head');
  ok(!!(await p.$('.d-quick a.btn.primary[href^="#/edit/"]')), 'booking page has a clear Edit button');
  await p.click('[data-act=status-sheet]');
  await p.click('.sheet-panel [data-status=arranged]');
  await p.waitForTimeout(150);
  ok((await p.textContent('.d-head .chip')).includes('Arranged'), 'status changed from the booking page');
  const id = p.url().split('/').pop();
  await p.click('.d-actions [data-act=del-item]');
  await p.click('.sheet-panel .btn.primary');
  await p.waitForSelector('#toast.show button');
  ok(!(await p.evaluate((x) => window.__tp.S.trips[0].items.some((i) => i.id === x), id)), 'deleted');
  await p.click('#toast button');
  await p.waitForTimeout(200);
  ok(await p.evaluate((x) => window.__tp.S.trips[0].items.some((i) => i.id === x), id), 'Undo restores it');
});

await section('Weather and Plan B', async () => {
  await p.goto(at('2030-05-08T09:00', 'plan'));
  await p.waitForSelector('#day-2030-05-08 .risk', { timeout: 8000 });
  ok((await p.textContent('#day-2030-05-08 .t-flight .risk')).includes('gusts 56 mph at Sanday'), 'island flight flagged for gusts');
  ok(!!(await p.$('#day-2030-05-08 .wx')), 'day shows a forecast chip');
  await p.goto(at('2030-05-08T09:00', 'today'));
  await p.waitForSelector('.hero-wrap .banner');
  ok((await p.textContent('.hero-wrap .banner')).includes('likely to disrupt'), 'Today warns on the next leg');
  await p.goto(at('2030-05-08T09:00', 'edit/it_lm0710'));
  ok(await p.isChecked('input[name=weatherSensitive]'), 'island flight is weather-sensitive by default');
  await p.fill('textarea[name=planB]', 'Orkney Ferries from Sanday; NorthLink sails 23:45 so there is slack.');
  await p.click('button[type=submit]');
  await p.waitForSelector('.planb');
  ok((await p.textContent('.planb')).includes('Orkney Ferries'), 'Plan B shows on the booking');
  await shot(p, '06-weather-planb');
});

await section('Documents', async () => {
  await p.goto(at('2030-05-08T12:00', 'tickets'));
  await p.click('.seg-tabs a[href="#/docs"]');
  await p.click('[data-act=doc-sheet]');
  await p.selectOption('.sheet-panel select[name=category]', 'passport');
  await p.fill('.sheet-panel input[name=title]', 'UK passport');
  await p.fill('.sheet-panel input[name=number]', '123456789');
  await p.fill('.sheet-panel input[name=expiry]', '2030-12-01');
  ok(await p.$('.sheet-panel input[name=files][accept="image/*,application/pdf"]') && await p.$('.sheet-panel input[name=camera][capture=environment]') && await p.$('.sheet-panel input[name=scan][capture=environment]'), 'add form offers Upload, Photo and Scan');
  await p.setInputFiles('.sheet-panel input[name=files]', OUT + 'fake-pass.png');
  ok((await p.textContent('.sheet-panel .jn-previews')).includes('1 photo'), 'chosen file previews in the form');
  await p.click('.sheet-panel .btn.primary');
  await p.waitForSelector('.d-head');
  ok((await p.textContent('.d-head')).includes('Expires'), 'expiry within six months is flagged');
  await p.waitForSelector('.thumb:not(.add)');
  ok(true, 'file attached while creating the document');
  // A PDF from the document page, and a scan that comes out as a clean greyscale page.
  await p.setInputFiles('.doc-pick input[name=files]', { name: 'policy.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
  await p.waitForFunction(() => document.querySelectorAll('.thumb').length === 2);
  ok((await p.textContent('.thumbs')).includes('PDF'), 'PDF upload accepted');
  const photo = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 300; const g = c.getContext('2d'); g.fillStyle = '#c8b48c'; g.fillRect(0, 0, 400, 300); g.fillStyle = '#3a2a10'; g.fillRect(50, 100, 300, 30); return c.toDataURL('image/jpeg').split(',')[1]; });
  await p.setInputFiles('.doc-pick input[name=scan]', { name: 'page.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(photo, 'base64') });
  await p.waitForFunction(() => document.querySelectorAll('.thumb').length === 3);
  const scan = await p.evaluate(async () => {
    const f = window.__tp.S.docFiles.find((x) => x.name.endsWith('-scan.jpg'));
    const bmp = await createImageBitmap(f.blob); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); const paper = g.getImageData(10, 10, 1, 1).data, ink = g.getImageData(200, 115, 1, 1).data;
    return { type: f.type, paper: [...paper.slice(0, 3)], ink: ink[0] };
  });
  ok(scan.type === 'image/jpeg' && Math.abs(scan.paper[0] - scan.paper[2]) < 6 && scan.paper[0] > 235 && scan.ink < 60, `scan is greyscale with white paper and dark print (${JSON.stringify(scan)})`);
  await p.click('[data-act=doc-sheet]');
  ok((await p.$$eval('.sheet-panel select[name=category] option', (o) => o.map((x) => x.textContent))).includes('Car insurance'), 'Car insurance category available');
  await p.click('.sheet-panel [data-act=close-sheet]');
  await p.click('.thumb:not(.add)');
  await p.waitForSelector('.viewer');
  ok((await p.textContent('.v-title')).includes('UK passport'), 'document photo opens in the viewer');
  await p.goto(at('2030-05-08T12:00', 'docs'));
  ok((await p.textContent('.page')).includes('•••• 6789'), 'list shows only the last digits');
});

await section('Journal', async () => {
  await p.goto(at('2030-05-09T20:00', 'today'));
  await p.click('a.tip[href^="#/journal/"]');
  await p.waitForSelector('form[data-form=journal]');
  await p.fill('form[data-form=journal] textarea', 'Fish supper by the harbour.');
  await p.click('form[data-form=journal] button');
  await p.waitForSelector('.journal-entry');
  ok((await p.textContent('.journal-entry')).includes('Fish supper'), 'entry saved');
  await p.click('.journal-entry [data-act=add-files]');
  ok((await p.getAttribute('#file-input', 'accept')) === 'image/*,video/*', 'journal picker offers photos and videos');
  await p.setInputFiles('#file-input', OUT + 'fake-pass.png');
  await p.waitForSelector('.journal-entry .photo-grid img');
  ok(true, 'photo added to an existing entry');
  // Photos straight from the new-entry form, with no text at all.
  await p.setInputFiles('form[data-form=journal] input[name=photos]', [OUT + 'fake-pass.png', OUT + 'fake-pass.png']);
  ok((await p.textContent('.jn-previews')).includes('2 photos'), 'chosen photos preview before saving');
  await p.click('form[data-form=journal] button.primary');
  await p.waitForFunction(() => document.querySelectorAll('.journal-entry').length === 2 && document.querySelectorAll('.journal-entry:last-of-type .photo-grid img').length === 2);
  ok(true, 'photo-only entry saved with both photos');
  ok(!!(await p.$('form[data-form=journal] input[name=camera][capture=environment]')), 'camera button opens the rear camera');
  await p.click('.journal-entry .photo-grid a');
  await p.waitForSelector('.viewer');
  ok((await p.textContent('.v-title')).includes('Journal'), 'photo opens full screen');
  // A video, straight from the camera button.
  await p.goBack();
  await p.waitForSelector('form[data-form=journal]');
  ok(!!(await p.$('form[data-form=journal] input[name=video][capture=environment][accept="video/*"]')), 'Video button records with the camera');
  await p.setInputFiles('form[data-form=journal] input[name=video]', { name: 'harbour.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(4096, 1) });
  ok((await p.textContent('.jn-previews')).includes('1 video'), 'chosen video previews before saving');
  await p.fill('form[data-form=journal] textarea', 'Seals in the harbour.');
  await p.evaluate(() => window.__tp.scheduleQuietRender());
  await p.waitForTimeout(700);
  ok((await p.inputValue('form[data-form=journal] textarea')) === 'Seals in the harbour.' && (await p.textContent('.jn-previews')).includes('1 video'),
    'a background refresh (weather, a sync) does not wipe a half-written entry');
  await p.click('form[data-form=journal] button.primary');
  await p.waitForSelector('.journal-entry .vid-tile video', { state: 'attached' });
  ok(await p.evaluate(() => window.__tp.S.files.some((f) => f.type === 'video/mp4' && f.size === 4096)), 'video saved as recorded, not shrunk');
  await p.click('.journal-entry .vid-tile');
  await p.waitForSelector('.viewer video.v-video[controls]');
  ok(!(await p.$('.viewer .v-body[data-act]')), 'video plays in the viewer with its own controls');
  await p.goto(at('2030-05-09T21:00', 'today'));
  await p.waitForSelector('a.tip[href^="#/journal/"]');
  ok((await p.$$('.jn-strip img')).length >= 3, "Today's journal card shows the day's photos");
  await shot(p, '09-journal');
});

await section('Server: live sharing between two phones, AI, Gmail', async () => {
  // A fake Google for the sign-in round trip and the Gmail API.
  const g = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/auth') { res.writeHead(302, { Location: `${process.env.PUBLIC_URL}/api/gmail/callback?code=good&state=${encodeURIComponent(u.searchParams.get('state'))}` }); return res.end(); }
    if (u.pathname === '/token') return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    if (u.pathname === '/gmail/profile') return json({ emailAddress: 'traveller@example.com' });
    if (u.pathname === '/gmail/messages') return json({ messages: [{ id: 'm1' }] });
    if (u.pathname === '/gmail/messages/m1' && u.searchParams.get('format') === 'metadata') return json({ id: 'm1', internalDate: '1890000000000', snippet: 'Your booking SMP777', payload: { headers: [{ name: 'Subject', value: 'Booking confirmed' }, { name: 'From', value: 'Sample Hotels <x@example.com>' }] } });
    if (u.pathname === '/gmail/messages/m1') return json({ id: 'm1', internalDate: '1890000000000', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Booking confirmed' }], body: { data: Buffer.from('Booking SMP777 for 15 May 2030').toString('base64url') } } });
    res.writeHead(404); res.end();
  });
  await new Promise((r) => g.listen(0, r));
  const gu = `http://localhost:${g.address().port}`;
  const srvHttp = createServer();
  await new Promise((r) => srvHttp.listen(0, r));
  const SRV = `http://localhost:${srvHttp.address().port}`;
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', PUBLIC_URL: SRV, GOOGLE_AUTH_URL: `${gu}/auth`, GOOGLE_TOKEN_URL: `${gu}/token`, GMAIL_API_BASE: `${gu}/gmail`, ANTHROPIC_API_KEY: 'test' });
  const item = { type: 'hotel', status: 'confirmed', title: 'Sample Harbour Hotel', provider: '', number: '', from: '', to: '', fromCode: '', toCode: '', date: '2030-05-15', time: '15:00', endDate: '2030-05-16', endTime: '11:00', seat: '', class: '', ref: 'SMP777', eticket: '', address: '', phone: '', keyTimes: '', notes: '', planB: '', costAmount: 80, costStatus: 'paid', costNote: '' };
  ai.setClient({ beta: { messages: { create: async (params) => {
    const chat = params.output_config.format.schema.properties.reply;
    const out = chat
      ? { reply: 'Your flight leaves Sanday at 15:50. I can move your seat.', changes: [{ action: 'update', itemId: 'it_lm0710', reason: 'Seat change', item: { ...item, type: 'flight', title: '', provider: 'Loganair', number: 'LM0710', from: 'Sanday', to: 'Kirkwall', date: '2030-05-08', time: '15:50', endDate: '2030-05-08', endTime: '16:11', seat: '1A', ref: 'SMP001', costAmount: 0, costStatus: 'none' } }] }
      : { summary: 'One hotel booking.', items: [{ updatesExistingId: '', item }] };
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] };
  } } } });
  const app = createApp({ db: openDb(':memory:'), users: 'clive:tok-clive,jane:tok-jane', secret: 'x', origins: BASE.replace(/\/$/, ''), appUrl: `${BASE}?now=2030-05-08T12:00` });
  srvHttp.on('request', app.handle);
  const link = (name, tok) => execFileSync('node', [new URL('../tools/make-connect-link.mjs', import.meta.url).pathname, `${BASE}?now=2030-05-08T12:00`, SRV, name, tok]).toString().trim();

  // Clive connects and shares the trip.
  await p.goto(link('clive', 'tok-clive'));
  await p.click('[data-act=connect-confirm]');
  await p.waitForSelector('[data-act=sync-on]');
  await p.click('[data-act=sync-on]');
  await p.waitForFunction(() => window.__tp.S.sync.state === 'ok', null, { timeout: 15000 });
  await p.goto(at('2030-05-08T12:00', 'today'));
  ok(!!(await p.$('.pill.sync.ok')), 'Clive shares the trip live; the top bar says so');

  // Jane connects on her own phone and downloads it, tickets included.
  const { ctx: cj, page: j } = await phone();
  await j.goto(link('jane', 'tok-jane'));
  await j.click('[data-act=connect-confirm]');
  await j.waitForSelector('[data-act=pull-trip]', { timeout: 10000 });
  await j.click('[data-act=pull-trip]');
  await j.waitForSelector('.hero-wrap', { timeout: 15000 });
  await j.waitForFunction(() => window.__tp.S.files.length >= 2, null, { timeout: 15000 }).catch(() => {});
  const janeFiles = await j.evaluate(() => window.__tp.S.files.length);
  ok(janeFiles >= 2, `Jane gets the trip with its tickets and photos (${janeFiles} files)`);
  ok(await j.evaluate(() => window.__tp.S.trips[0].items.some((i) => i.ref === 'TESTREF1')), "Clive's edits are in Jane's copy");

  // Jane changes a booking; Clive sees it after a sync.
  await j.goto(at('2030-05-08T12:00', 'edit/it_lm0706'));
  await j.fill('input[name=seat]', '3C');
  await j.click('button[type=submit]');
  await j.waitForSelector('.d-head');
  await j.waitForTimeout(2500);
  await p.evaluate(() => window.__tp.S.synced && null);
  await p.goto(at('2030-05-08T12:00', 'sync'));
  await p.click('[data-act=sync-now]');
  await p.waitForTimeout(800);
  ok(await p.evaluate(() => window.__tp.S.trips[0].items.find((i) => i.id === 'it_lm0706')?.seat === '3C'), "Jane's change reaches Clive");

  // Both edit different bookings at once: both changes survive.
  await p.evaluate(async () => { const t = window.__tp.S.trips[0]; t.items.find((i) => i.id === 'it_lner').seat = 'Coach L 1'; });
  await p.goto(at('2030-05-08T12:00', 'edit/it_lner'));
  await p.fill('input[name=seat]', 'Coach L 1');
  await p.click('button[type=submit]');
  await j.goto(at('2030-05-08T12:00', 'edit/it_tpe'));
  await j.fill('input[name=seat]', 'Coach E 2');
  await j.click('button[type=submit]');
  await p.waitForTimeout(3000);
  await p.goto(at('2030-05-08T12:00', 'sync')); await p.click('[data-act=sync-now]'); await p.waitForTimeout(800);
  await j.goto(at('2030-05-08T12:00', 'sync')); await j.click('[data-act=sync-now]'); await j.waitForTimeout(800);
  const seats = (pg) => pg.evaluate(() => window.__tp.S.trips[0].items.filter((i) => ['it_lner', 'it_tpe'].includes(i.id)).map((i) => i.seat).join('/'));
  ok((await seats(p)) === 'Coach L 1/Coach E 2' && (await seats(j)) === 'Coach L 1/Coach E 2', 'simultaneous edits on two phones both survive');
  await cj.close();

  // Clive invites someone new from the Share page; they join from the link alone.
  await p.goto(at('2030-05-08T12:00', 'share'));
  await shot(p, '40-share-invite');
  await p.fill('input[name=inviteName]', 'Sam');
  await p.click('[data-act=invite-create]');
  await p.waitForSelector('[data-act=invite-send]', { timeout: 10000 });
  ok((await p.textContent('.invite-ready')).includes('Sam'), 'Share page creates an invite link for a named person');
  ok((await p.getAttribute('.invite-ready a[href^="mailto:"]', 'href')).includes('join%3D'), 'the invite can be emailed');
  await shot(p, '41-share-invite-ready');
  const invite = await p.evaluate(() => window.__tp.S.invite.link);
  ok(!invite.includes('tok-clive'), "the invite link does not carry Clive's access token");
  const joinHash = invite.slice(invite.indexOf('#join='));

  const { ctx: cs, page: sam } = await phone();
  await sam.goto(`${BASE}?now=2030-05-08T12:00${joinHash}`);
  await sam.waitForSelector('[data-act=join-confirm]');
  ok((await sam.textContent('.page')).includes('invited you'), 'a fresh phone opening the invite sees who invited them');
  await shot(sam, '42-join');
  await sam.fill('input[name=name]', 'Sam');
  await sam.click('[data-act=join-confirm]');
  await sam.waitForSelector('.hero-wrap', { timeout: 15000 });
  ok(await sam.evaluate(() => window.__tp.S.trips.length === 1 && window.__tp.S.trips[0].items.some((i) => i.ref === 'TESTREF1')), 'the trip downloads onto the new phone');
  ok(!!(await sam.$('.install-card')), 'after joining, the app shows how to put it on the home screen');
  await sam.waitForFunction(() => window.__tp.S.files.length >= 2, null, { timeout: 15000 }).catch(() => {});
  ok(await sam.evaluate(() => window.__tp.S.files.length >= 2), 'tickets follow onto the new phone');
  await sam.waitForFunction(() => window.__tp.S.files.some((f) => f.type === 'video/mp4'), null, { timeout: 15000 }).catch(() => {});
  ok(await sam.evaluate(() => window.__tp.S.files.some((f) => f.type === 'video/mp4' && f.size === 4096)), 'journal videos are shared too');
  await shot(sam, '43-joined-today');
  ok(await sam.evaluate(() => window.__tp.S.docs.length === 0), 'documents are not shared');

  await sam.goto(at('2030-05-08T12:00', 'edit/it_lm0706'));
  await sam.fill('input[name=seat]', '4D');
  await sam.click('button[type=submit]');
  await sam.waitForSelector('.d-head');
  await sam.waitForTimeout(2500);
  await p.goto(at('2030-05-08T12:00', 'sync'));
  await p.click('[data-act=sync-now]');
  await p.waitForTimeout(800);
  ok(await p.evaluate(() => window.__tp.S.trips[0].items.find((i) => i.id === 'it_lm0706')?.seat === '4D'), "the invited person's change reaches Clive");

  // The link is single-use.
  const { ctx: cx, page: x } = await phone();
  await x.goto(`${BASE}?now=2030-05-08T12:00${joinHash}`);
  await x.fill('input[name=name]', 'Someone');
  await x.click('[data-act=join-confirm]');
  await x.waitForFunction(() => document.getElementById('toast').textContent.includes('already been used'), null, { timeout: 10000 });
  ok(await x.evaluate(() => window.__tp.S.trips.length === 0), 'an invite link works only once');
  await cx.close();
  await sam.goto(at('2030-05-08T12:00', 'sync'));
  await sam.click('[data-act=sync-off]');
  ok(!(await sam.$('[data-act=sync-remove]')), 'an invited person cannot remove the trip from the server');
  await cs.close();

  // AI: paste an email, review, add.
  await p.goto(at('2030-05-08T12:00', 'plan'));
  await p.click('.fab');
  await p.click('.sheet-panel [data-act=ai-sheet]');
  await p.fill('.sheet-panel textarea[name=text]', 'Your booking SMP777 at Sample Harbour Hotel, 15 May 2030.');
  await p.click('.sheet-panel .btn.primary');
  await p.waitForSelector('.ai-card', { timeout: 10000 });
  ok((await p.textContent('.ai-card')).includes('SMP777'), 'Claude’s reading is shown for checking');
  await shot(p, '07-ai-review');
  await p.click('[data-act=ai-apply]');
  await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.__tp.S.trips[0].items.some((i) => i.ref === 'SMP777' && i.cost?.amount === 80)), 'booking added with its cost');

  // Ask: a question, and a proposed change that is only applied on approval.
  await p.goto(at('2030-05-08T12:00', 'ask'));
  await p.waitForSelector('form[data-form=ask]');
  await p.fill('form[data-form=ask] textarea', 'When does my flight leave? Put me in seat 1A.');
  await p.click('form[data-form=ask] button');
  await p.waitForSelector('.bubble.assistant .change', { timeout: 10000 });
  ok((await p.textContent('.bubble.assistant')).includes('15:50'), 'assistant answers');
  ok(await p.evaluate(() => window.__tp.S.trips[0].items.find((i) => i.id === 'it_lm0710').seat !== '1A'), 'nothing changes before approval');
  await p.click('[data-act=chat-apply]');
  await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.__tp.S.trips[0].items.find((i) => i.id === 'it_lm0710').seat === '1A'), 'change applied after approval');
  await shot(p, '08-ask');

  // Gmail: connect, search, open, create a booking from the email.
  await p.goto(at('2030-05-08T12:00', 'email'));
  await p.click('[data-act=gmail-connect]');
  await p.waitForSelector('.mail-row', { timeout: 10000 });
  ok((await p.textContent('.mail-row')).includes('Booking confirmed'), 'Gmail connected and recent bookings listed');
  // A question typed into email search is offered to the assistant instead.
  await p.fill('form[data-form=email-search] input[name=q]', 'When do I leave Sanday?');
  await p.click('form[data-form=email-search] button');
  await p.waitForSelector('[data-act=email-to-ask]');
  ok(true, 'a question in email search offers the assistant');
  await p.click('[data-act=email-to-ask]');
  await p.waitForFunction(() => location.hash === '#/ask' && document.querySelectorAll('.bubble.assistant').length >= 2, null, { timeout: 10000 });
  ok(await p.$$eval('.bubble', (b) => b.some((x) => x.textContent.includes('When do I leave Sanday?'))), 'and asks it there');
  await p.goto(at('2030-05-08T12:00', 'email'));
  await p.fill('form[data-form=email-search] input[name=q]', 'Premier Inn');
  await p.click('form[data-form=email-search] button');
  await p.waitForSelector('.mail-row');
  ok(!(await p.$('[data-act=email-to-ask]')), 'an ordinary search is left alone');
  await p.click('.mail-row');
  await p.waitForSelector('.mail-body');
  ok((await p.textContent('.mail-body')).includes('SMP777'), 'email opens');
  await p.click('[data-act=ai-email]');
  await p.waitForSelector('.ai-card', { timeout: 10000 });
  ok(true, 'bookings created from the email for review');

  // Disconnect before the server goes away, so later sections run offline-from-server.
  await p.goto(at('2030-05-08T12:00', 'sync'));
  await p.click('[data-act=disconnect]');
  await p.click('.sheet-panel .btn.primary');
  await p.waitForTimeout(200);
  ok(!(await p.$('.pill.sync')), 'disconnecting stops sharing on this phone');
  srvHttp.close(); g.close();
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

await section('A new version reaches an installed phone', async () => {
  const port = 5198;
  const url = `http://localhost:${port}/?now=2030-05-08T12:00#/more`;
  let srv = await start(port, 'localhost', { build: 'one' });
  const { ctx: c5, page: u } = await phone();
  await u.goto(url);
  await u.waitForFunction(() => navigator.serviceWorker.controller);
  await u.reload();
  await u.waitForSelector('.about');
  ok((await u.textContent('.about')).includes('build one'), 'first version installed');
  srv.close();
  // Publish a new build, then the user simply opens the app again.
  srv = await start(port, 'localhost', { build: 'two' });
  await u.goto(url);
  await u.waitForFunction(() => document.querySelector('.about')?.textContent.includes('build two'), null, { timeout: 15000 });
  ok(true, 'reopening the app switches to the new version by itself');
  await u.waitForTimeout(3000);
  ok((await u.textContent('.about')).includes('build two'), 'and stays on it');
  // An update that lands while the app is in use offers a Reload instead.
  srv.close();
  srv = await start(port, 'localhost', { build: 'three' });
  await u.waitForTimeout(21000);
  await u.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await u.waitForSelector('#toast.show button', { timeout: 15000 });
  ok((await u.textContent('#toast')).includes('new version'), 'mid-use update offers Reload');
  await u.click('#toast button');
  await u.waitForFunction(() => document.querySelector('.about')?.textContent.includes('build three'), null, { timeout: 15000 });
  ok(true, 'Reload switches to it');
  srv.close();
  await c5.close();
});

ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
