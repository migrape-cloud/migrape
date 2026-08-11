# Shopify -> EasyStore migration server

A small web app: a merchant pastes an EasyStore access token, uploads a Shopify
product export, and clicks Start. Products are created in EasyStore one at a
time, with progress shown live and failures logged without stopping the rest.

This covers **products, customers, and orders**, with real automatic OAuth -
a merchant clicks "Connect with EasyStore" and never sees a token.

## Before you deploy: one thing needs confirming

`lib/easystore.js` has a block at the top marked in capital letters. It
contains the parts of the EasyStore API I could not verify myself - the exact
endpoint path, and whether a product's data is wrapped in `{"product": {...}}`
or sent flat. Everything else in this app is tested and working.

Run `easystore-probe.js` (from earlier) against a real development store
first. It will tell you directly whether the guessed shape is right. If it's
wrong, the fix is changing the three lines marked `TODO` in that one file -
nothing else needs to change.

## Running it yourself, right now

You need [Node.js](https://nodejs.org) (the LTS version) installed. Then, in
a terminal, inside this folder:

```
npm install
npm start
```

Open **http://localhost:3000** in a browser. That's the whole dashboard.

## Putting it on the internet (so a merchant can actually use it)

Right now it only runs on your own computer. To let anyone else reach it, it
needs to live on a server that's always on. The easiest free way to do that:

1. Create a free account at **render.com**.
2. Push this folder to a new GitHub repository (Render deploys from GitHub).
3. In Render, choose **New -> Web Service**, point it at that repository.
4. Build command: `npm install`. Start command: `npm start`.
5. Click deploy. Render gives you a public URL in a couple of minutes -
   something like `https://your-app.onrender.com`.

That's it - no server administration, no command line on the server side.
Free tier is enough for testing; it sleeps after inactivity and takes a few
seconds to wake up, which is fine for occasional migrations but worth
upgrading if merchants will use this regularly.

## How a merchant connects their store

Clicking "Connect with EasyStore" sends the merchant to EasyStore's own
install screen - the same flow any real app uses. Once they approve it,
they land back on the dashboard already connected, with no token ever
visible to them. This needs the environment variables set up below.

There's also a manual "paste a token directly" option on the same screen,
kept as a fast path for your own testing - useful when you already have a
token from get-token.html and don't want to click through the redirect.

## What happens when you click Start

1. The Shopify file is parsed and grouped into products (same logic as the
   browser-based converter, so results match).
2. Each product is sent to EasyStore's product-creation endpoint, one at a
   time, with a small pause between requests and a longer pause if EasyStore's
   own rate-limit headers say we're close to the ceiling.
3. Progress is written to a file per migration (`data/job-<id>.json`), so if
   the app restarts partway through, `/api/migrate/:jobId/resume` picks up
   only the products that haven't succeeded yet - nothing is duplicated.
4. Anything that fails is logged with EasyStore's own error message, and does
   not stop the rest of the catalogue from continuing.

## What's already handled, carried over from the file-based tool

- Variant grouping (one Shopify row per variant, extra rows for extra images)
- The three-image cap
- Weight in grams
- Stock policy (`deny` / `continue`)
- Published as a true boolean, from Shopify's Status or Published column

## Setting up automatic connect (do this once)

The "Connect with EasyStore" button needs two environment variables on Render:

1. Render dashboard -> your service -> **Environment**
2. Add `EASYSTORE_CLIENT_ID` - the Client ID from your app's page in the Partner Portal
3. Add `EASYSTORE_CLIENT_SECRET` - the Client Secret from the same page (click the eye icon to reveal it, then copy)
4. Render redeploys automatically after you save

Without these, the "Connect with EasyStore" button errors - but the manual
token-paste option (under "Or paste a token directly") still works either way.

## What's not here yet

- **Embedded mode** - this opens in its own tab rather than inside
  EasyStore's admin panel. EasyStore does support running apps embedded
  (there's a toggle for it on the app's Partner Portal page), but the exact
  session-token handshake it requires isn't documented in enough detail to
  implement without guessing - the kind of guess that fails silently rather
  than loudly. Worth revisiting once the rest is proven solid.
- **Collections** - the API can create these, unlike the CSV route, but that
  wiring isn't built yet.
- **A real database** - sessions and jobs currently live in memory and on
  disk, which is fine for one person testing, but should move to a proper
  database (Postgres is the common choice on Render) before multiple
  merchants use this at once.
- **The HMAC verification algorithm** (in `lib/easystore.js`) is an educated
  guess at the standard pattern - EasyStore's docs don't spell out the exact
  fields and ordering. It logs a warning rather than blocking the install if
  it doesn't match, so testing isn't affected, but it's worth tightening
  before this goes near a stranger's store.

## Files

```
server.js           the whole app: routes, upload handling, the migration loop
lib/csv.js           CSV read/write (identical to the browser tool)
lib/shopify.js        groups Shopify rows into products, builds the EasyStore payload
lib/easystore.js       the API client - the ONE file to fix once you have real endpoint shapes
lib/jobs.js            tracks progress per migration, on disk, so it survives a restart
public/index.html       the dashboard
test/e2e2.js            a working test against a fake EasyStore - run with: node test/e2e2.js
```
