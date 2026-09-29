# CLAUDE.md

Travel Pack is a zero-dependency offline PWA (vanilla ES modules, no build step) for keeping trip
bookings and ticket barcodes on an Android phone. See README.md for features and commands.

## Commands
- `npm start`: dev server on http://localhost:5173 (stamps the service worker per run).
- `npm test`: `tools/check.mjs` static checks, then `tests/e2e.mjs` (Playwright, Pixel 7). Run it before every push.
- `npm run test:shots`: saves screenshots to `test-results/`. Look at them after UI changes.
- `?now=YYYY-MM-DDTHH:MM` on any URL fakes the clock (the Today screen depends on it).

## Rules
- **No real trip data in git.** The repo is public, and trip files hold booking references. Real trips live in
  `trips/` (git-ignored). Tests use the fictional `tests/fixtures/sample.travelpack.json` (8–20 May 2030).
  Never copy real references, names or phone numbers into fixtures, tests, docs or commit messages.
- **It must work offline.** Nothing in `app/` may load from another origin (no CDNs, fonts or analytics).
  Every file in `app/` must be listed in `ASSETS` in `app/sw.js`, or it will be missing offline.
  `npm run check` enforces both.
- **Leave `VERSION = 'tp-__BUILD__'` alone** in `app/sw.js`. Deploy replaces it with the commit id.
  That is how phones learn about updates.
- **Stored data is the user's only copy.** Trips in IndexedDB and backup files use format `version: 1`.
  When changing the shape of a trip or item, keep old data readable (migrate on load). Do not rename fields in place.
  Backup and restore must round-trip, and the e2e test covers it.
- **Render through `html```** (in `util.js`). It escapes interpolated values. Use `raw()` only for markup you built.
- Headless Linux Chromium has no `BarcodeDetector`, so tests fake the detected box. Barcode detection itself
  can only be verified on an Android phone.
- Deploy is `.github/workflows/ci.yml`: tests on every push and PR, then GitHub Pages from `main`.
