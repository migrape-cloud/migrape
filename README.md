# Shopify → EasyStore migration server

A small web app: a merchant pastes an EasyStore access token, uploads a Shopify
product export, and clicks Start. Products are created in EasyStore one at a
time, with progress shown live and failures logged without stopping the rest.

This is **products only** for now. Customers and orders use the file-based
tool from before — see "What's not here yet" below.

## Before you deploy: one thing needs confirming

`lib/easystore.js` has a block at the top marked in capital letters. It
contains the parts of the EasyStore API I could not verify myself — the exact
endpoint path, and whether a product's data is wrapped in `{"product": {...}}`
or sent flat. Everything else in this app is tested and working.

Run `easystore-probe.js` (from earlier) against a real development store
first. It will tell you directly whether the guessed shape is right. If it's
wrong, the fix is changing the three lines marked `TODO` in that one file —
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
3. In Render, choose **New → Web Service**, point it at that repository.
4. Build command: `npm install`. Start command: `npm start`.
5. Click deploy. Render gives you a public URL in a couple of minutes —
   something like `https://your-app.onrender.com`.

That's it — no server administration, no command line on the server side.
Free tier is enough for testing; it sleeps after inactivity and takes a few
seconds to wake up, which is fine for occasional migrations but worth
upgrading if merchants will use this regularly.

## How a merchant connects their store

The dashboard asks for a domain and a token. For now, that token has to come
from a private app the merchant creates inside their own EasyStore admin —
the same shortcut discussed earlier, which avoids needing an EasyStore Partner
account or app review before you can test this for real. A proper "Connect to
EasyStore" button (full OAuth) is a later step, once the paste-a-token version
is proven to work end to end.

## What happens when you click Start

1. The Shopify file is parsed and grouped into products (same logic as the
   browser-based converter, so results match).
2. Each product is sent to EasyStore's product-creation endpoint, one at a
   time, with a small pause between requests and a longer pause if EasyStore's
   own rate-limit headers say we're close to the ceiling.
3. Progress is written to a file per migration (`data/job-<id>.json`), so if
   the app restarts partway through, `/api/migrate/:jobId/resume` picks up
   only the products that haven't succeeded yet — nothing is duplicated.
4. Anything that fails is logged with EasyStore's own error message, and does
   not stop the rest of the catalogue from continuing.

## What's already handled, carried over from the file-based tool

- Variant grouping (one Shopify row per variant, extra rows for extra images)
- The three-image cap
- Weight in grams
- Stock policy (`deny` / `continue`)
- Published as a true boolean, from Shopify's Status or Published column

## What's not here yet

- **Customers and orders** — use the spreadsheet tool for these until this
  server grows the same passes. The mapping logic already exists in the
  browser converter; porting it here is mechanical, not a redesign.
- **Collections** — the API can create these, unlike the CSV route, but that
  wiring isn't built yet.
- **OAuth install flow** — currently a pasted token. Needed before this can
  go in the EasyStore App Store.
- **A real database** — sessions and jobs currently live in memory and on
  disk, which is fine for one person testing, but should move to a proper
  database (Postgres is the common choice on Render) before multiple
  merchants use this at once.

## Files

```
server.js           the whole app: routes, upload handling, the migration loop
lib/csv.js           CSV read/write (identical to the browser tool)
lib/shopify.js        groups Shopify rows into products, builds the EasyStore payload
lib/easystore.js       the API client — the ONE file to fix once you have real endpoint shapes
lib/jobs.js            tracks progress per migration, on disk, so it survives a restart
public/index.html       the dashboard
test/e2e2.js            a working test against a fake EasyStore — run with: node test/e2e2.js
```
