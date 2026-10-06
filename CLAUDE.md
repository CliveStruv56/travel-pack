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
- **It must work offline.** Nothing in `app/` may load code or styles from another origin (no CDNs, fonts or analytics).
  The only network calls are data: the user's own server (`api.js`) and Open-Meteo weather (`weather.js`), both cached or optional.
  Every file in `app/` must be listed in `ASSETS` in `app/sw.js`, or it will be missing offline.
  `npm run check` enforces both.
- **Leave `VERSION = 'tp-__BUILD__'` alone** in `app/sw.js`. Deploy replaces it with the commit id.
  That is how phones learn about updates.
- **Stored data is the user's only copy.** Trips in IndexedDB and backup files use format `version: 1`.
  When changing the shape of a trip or item, keep old data readable (migrate on load). Do not rename fields in place.
  Backup and restore must round-trip, and the e2e test covers it.
- **Render through `html```** (in `util.js`). It escapes interpolated values. Use `raw()` only for markup you built.
- Links: `#share=` opens a whole trip (read-only unless the payload says `editable`), `#add=` merges bookings
  into an existing trip by item `id` (`npm run add-link`). Both are deflate-raw + base64url after the `#`,
  so the data never reaches the server. Never make a link that replaces a whole trip the user already has:
  it would wipe their people, ticked to-dos and edits.
- Headless Linux Chromium has no `BarcodeDetector`, so tests fake the detected box. Barcode detection itself
  can only be verified on an Android phone.
- **Server (`server/`)**: see docs-server.md. Keep these rules:
  - `app/merge.js` is shared by the phone and the server. Every record carries `updatedAt`, set by `stampChanges` on save
    (never by hand), and deletions are tombstones in `trip.deleted`. Don't add collections without adding them to `COLLECTIONS`.
  - **AI output is never applied without a tap.** Extraction goes to a review screen; chat changes need Apply. Tests assert this.
  - The model is `claude-opus-5-5`, called through the official SDK with structured outputs and `fallbacks: "default"`.
    `server/sdk.test.mjs` checks the real SDK's wire format in CI.
  - Access: `USERS` owners see every trip; invited members (one-time `#join=` codes, `/api/invites/redeem`) see only
    their trips. Every trip and file route checks `canSee`; `server.test.mjs` asserts the scoping.
  - Documents (`tripId: '__docs'`) are personal and never synced. Secrets live only in server environment variables.
- Deploy is `.github/workflows/ci.yml`: tests on every push and PR, then GitHub Pages from `main`.
