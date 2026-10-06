# Travel Pack server

A small Node service (no framework, SQLite storage) that adds:

- **Live sharing**: phones connected to the server sync shared trips (bookings, people,
  to-dos, journal, tickets and photos). Edits from two phones merge record by record,
  and the newer edit wins.
- **Gmail search** with read-only access, through Google sign-in. The refresh token
  stays on the server.
- **AI**: reading bookings out of emails, PDFs and screenshots, and the "Ask" assistant
  (Claude). The API key stays on the server. Nothing the model returns is applied
  without the traveller tapping to approve it.

Personal **documents** (passport, insurance…) never leave the phone and are never synced.

## Settings (environment variables)

| Variable | What |
| --- | --- |
| `USERS` | `clive:<token>`: the trip owners, one long random token each (`openssl rand -hex 24`). Owners see every trip on the server. Everyone else joins by invite (below). |
| `SESSION_SECRET` | random string, signs the Google sign-in round trip |
| `PUBLIC_URL` | this server's https address, e.g. `https://travel-pack.up.railway.app` |
| `APP_URL` | `https://clivestruv56.github.io/travel-pack/` |
| `ALLOWED_ORIGINS` | `https://clivestruv56.github.io` |
| `DB_PATH` | `/data/travel-pack.db` (put a volume on `/data`) |
| `ANTHROPIC_API_KEY` | enables the AI features |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | enable Gmail search (see below) |
| `AI_CALLS_PER_HOUR` | optional per-person cap on AI calls, default 60 |

On Railway also set `NPM_CONFIG_OMIT=dev` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, so the
build doesn't install the test browser.

## Connecting a phone

```bash
npm run connect-link -- https://clivestruv56.github.io/travel-pack/ https://<server> clive <clive's token>
```

Open the link on the phone and tap **Connect**. Treat the link like a password.
To revoke a phone, change that person's token in `USERS` and redeploy.

## Inviting someone to a trip (no server work needed)

In the app: **More → Share this trip → Create invite link**, then send it by WhatsApp,
text or email. The other person opens it on their phone, taps **Join**, and the trip
downloads; the app then shows how to add it to the home screen. From then on the trip
syncs both ways.

- The link carries a one-time code, never a token. It works once and expires after 7
  days; only its hash is stored. Redeeming gives that phone its own token.
- Invited people (the `members` table) see only the trips they were invited to, plus
  any they create. They cannot remove a trip from the server. Owners in `USERS` see all.
- Personal documents are never synced, so they are never shared.
- On iPhone the home-screen app has storage separate from Safari, so the join page asks
  them to install first and paste the link into the installed app.
- To revoke an invited phone: delete its row from `members`.

## Gmail: one-off Google setup (about 10 minutes)

1. Go to <https://console.cloud.google.com/> and create a project, e.g. "Travel Pack".
2. **APIs & Services → Library**: enable the **Gmail API**.
3. **Google Auth Platform** (formerly "OAuth consent screen") → **Get started**: app name
   "Travel Pack", your email, audience **External**.
4. **Audience**: add your Gmail address as a **test user**.
   - In *Testing*, Google expires the sign-in after 7 days, so you reconnect weekly.
   - **Publish app** (*In production*) avoids that. Because the app is unverified,
     Google shows an "unverified app" warning when you sign in; choose *Advanced →
     Go to Travel Pack*.
5. **Clients → Create client → Web application**. Under *Authorised redirect URIs* add
   `https://<server>/api/gmail/callback`.
6. Copy the client ID and client secret into the server's `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`.
7. In the app: **More → Search email → Connect Gmail**.

The app asks only for `gmail.readonly`: it can search and read, never send or delete.

## Running locally

```bash
USERS=me:devtoken SESSION_SECRET=dev ALLOWED_ORIGINS=http://localhost:5173 npm run server
npm start   # the app, in another terminal
npm run connect-link -- http://localhost:5173/ http://localhost:8787 me devtoken
```
