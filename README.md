# Travel Pack

An offline trip app for Android, installed from the browser as a Progressive Web App.
Bookings, tickets and barcodes stay on your phone and open with no signal.
It has no server, no account and no third-party code.

**Live app:** https://clivestruv56.github.io/travel-pack/

## What it does
- **Today:** a countdown before the trip. During it, the next leg with a live countdown, key times
  (check-in opens, final boarding), a *Show ticket* button, anything still to book or pay, and where you sleep tonight.
- **Plan:** every day of the trip with status labels (Confirmed, Arranged, To book). Waits and connections are worked out for you.
- **Tickets:** add screenshots or PDFs to a booking. On Android the barcode is found automatically
  and shown large on white, with the screen kept on. Once installed, *Share → Travel Pack* works from Gmail or Photos.
- **To-do:** the checklist, plus every booking marked *To book*.
- **Editing:** add, change, duplicate or delete bookings of any type (flight, ferry, train, bus, lift, hotel, stay, other).
- **People:** call, text or WhatsApp in one tap.
- **Costs:** paid, still to pay, and amounts to check.
- **Calendar:** a calendar file for the whole trip with reminders, or add one booking to Google Calendar.
- **Live status:** flight tracker, National Rail, Realtime Trains and operator links, shown only when online.
- **Sharing:** a read-only link, a plain-text itinerary, or a full trip file with tickets.
- **Backup and restore:** everything, tickets included, in one file.
- **Several trips:** keep past trips and reuse the app for the next one.

### With the server (optional, see [docs-server.md](docs-server.md))
- **Live sharing** by invite: Share → Create invite link, send it to Jane, she taps Join and the trip installs on her phone. Both can edit; tickets, journal and photos sync too (personal documents never do).
- **Add from email, PDF or screenshot**: Claude reads it and fills in the booking for you to check.
- **Search Gmail** inside the app (read-only), then turn an email into bookings in one tap.
- **Ask Travel Pack**: questions about the trip, or changes in plain English, each one approved by you.

### Also
- **Documents**: passport, insurance, railcard, with expiry warnings. They stay on the phone and are never synced.
- **Journal**: a few lines and photos for each day.
- **Weather & Plan B**: forecasts for each day. Island flights and ferries are flagged when gusts or fog could
  disrupt them, with your Plan B shown alongside.

## Install on your phone
1. Open the live app in Chrome on Android, then ⋮ → **Install app**.
2. Load a trip: open a setup link (see below) and tap **Save to this phone**, or use **Import a trip file**.
3. Add your tickets, then try it in flight mode.

## Develop and test on your laptop
```bash
git clone https://github.com/CliveStruv56/travel-pack && cd travel-pack
npm install                      # only dev dependency: Playwright
npx playwright install chromium  # once
npm start                        # http://localhost:5173
npm test                         # static checks, server tests, 80 browser tests (Pixel 7 size)
npm run test:shots               # same, saving screenshots to test-results/
```
- Add `?now=2030-05-09T15:30` (any date and time) to the URL to see the app as it will look at that moment.
- Chrome DevTools → device toolbar (Pixel 7) gives the phone layout. The Application tab shows the stored data
  and the service worker. Tick *Offline* on the Network tab to test with no signal.
- To try it on your phone before deploying: `HOST=0.0.0.0 npm start` and open `http://<laptop-ip>:5173`.
  Offline mode needs HTTPS, so test that on the live site.

## Deploying
Every push to `main` runs the tests. If they pass, it deploys `app/` to GitHub Pages
(**Settings → Pages → Source: GitHub Actions** must be set once).
The service worker cache is stamped with the commit id, so phones show "A new version is ready".
Pull requests run the tests only. Screenshots are saved as a workflow artifact.

## Your trips stay out of this repo
The repository is public. Real trip files go in `trips/`, which is git-ignored,
and `npm run check` fails if one is ever committed. Tests use a fictional trip in `tests/fixtures/`.

Make a one-tap setup link for your phone from a trip file:
```bash
npm run link -- https://clivestruv56.github.io/travel-pack/ trips/october-2026.travelpack.json
```
The trip is carried in the part of the link after `#`, which browsers never send to a server.

To add or correct one or more bookings in a trip that's already on the phone, without touching
anything else in it, write the booking(s) as JSON (same fields as in a trip file) and make an add link:
```bash
npm run add-link -- https://clivestruv56.github.io/travel-pack/ trips/new-hotel.json trip_oct2026
```
Opening it shows the booking and an **Add to my trip** button. A booking whose `id` already exists
in the trip is replaced rather than duplicated.

## Layout
```
app/        the whole app (static files, served as-is)
  app.js      screens, actions, routing
  model.js    booking types, timeline, costs, live-status links
  db.js       IndexedDB storage
  share.js    share links, text itinerary, backup files
  ics.js      calendar export
  sw.js       offline cache + Android share target
tools/      dev server, checks, setup-link and icon generators
tests/      browser tests + fictional fixture
trips/      your real trips (git-ignored)
```
