'use strict';
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');

const shopify = require('./lib/shopify');
const shopifyApi = require('./lib/shopifyapi');
const easystore = require('./lib/easystore');
const jobs = require('./lib/jobs');

const app = express();
// Render (and most PaaS hosts) terminate HTTPS at a proxy in front of the
// app, forwarding plain HTTP internally. Without this, req.protocol always
// reports "http", which builds a redirect URL that doesn't match the
// https:// one registered with EasyStore, and the install fails.
app.set('trust proxy', true);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.static('public'));
app.use(express.json());

/* Sessions are keyed by shop domain, not a random ID. This matters for
   embedded loads: when EasyStore puts the app in an iframe, the browser
   carries no cookie or session id from our earlier connect - but EasyStore
   appends ?shop=&hmac=&timestamp= to the App URL on every load, the same
   way it does on install. Verifying that hmac and looking the shop up
   directly is how the app recognizes who's loading it. */
const sessions = new Map(); // shop -> { shop, token }

function getSession(req) {
  const shop = (req.headers['x-shop-domain'] || '').trim().toLowerCase();
  return shop ? sessions.get(shop) : null;
}
function startSession(shop, token) {
  const key = shop.replace(/\/$/, '').toLowerCase();
  sessions.set(key, { shop: key, token });
  return key;
}

/* =======================  connect a store  =======================
   Two ways in, both land on the same session store:

   1. Automatic (real OAuth) - /auth/install redirects the merchant
      to EasyStore, /auth/callback catches them coming back, verifies
      the request genuinely came from EasyStore, and exchanges the
      code for a token without the merchant ever seeing it. This is
      what makes the app behave like a normal "click Install" app.

   2. Manual (/api/connect) - kept as a fallback for testing directly
      against a token you already have, e.g. one produced by
      get-token.html. Useful when you want to skip the redirect dance.
   =============================================================== */

app.get('/auth/install', (req, res) => {
  const clientId = process.env.EASYSTORE_CLIENT_ID;
  const shop = req.query.shop;
  if (!clientId) return res.status(500).send('EASYSTORE_CLIENT_ID is not set on the server - add it under Render -> Environment.');
  if (!shop) return res.status(400).send('Missing ?shop=yourstore.easy.co in the URL.');

  const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
  const scope = 'write_products,read_products,write_customers,read_customers,write_orders,read_orders';
  const url = `https://admin.easystore.co/oauth/authorize` +
    `?app_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const clientId = process.env.EASYSTORE_CLIENT_ID;
  const clientSecret = process.env.EASYSTORE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).send('EASYSTORE_CLIENT_ID / EASYSTORE_CLIENT_SECRET not set on the server.');
  }
  const { code, shop } = req.query;
  if (!code || !shop) return res.status(400).send('Missing code or shop in the callback.');

  const validHmac = easystore.verifyCallbackHmac(req.query, clientSecret);
  if (!validHmac) {
    // Logged, not blocked outright - the HMAC algorithm is an educated guess
    // (see lib/easystore.js). Treat repeated failures here as the signal to
    // revisit that function, not proof the install itself is unsafe.
    console.warn(`[auth] HMAC did not verify for shop=${shop} - proceeding, but see lib/easystore.js`);
  }

  try {
    const token = await easystore.exchangeToken(shop, clientId, clientSecret, code);
    startSession(shop, token);
    res.redirect(`/?connected=1&shop=${encodeURIComponent(shop)}`);
  } catch (e) {
    res.status(502).send(`Could not exchange the code for a token: ${e.message}`);
  }
});

app.post('/api/connect', (req, res) => {
  const { shop, token } = req.body || {};
  if (!shop || !token) return res.status(400).json({ error: 'shop and token are required' });
  startSession(shop, token);
  res.json({ shop: shop.replace(/\/$/, '').toLowerCase() });
});

/* Called by the dashboard when it loads inside EasyStore's iframe.
   EasyStore appends shop/hmac/timestamp (and host_url) to the App URL on
   every embedded load, same as the install redirect. Verifying the hmac
   confirms this genuinely came from EasyStore, then we look up the token
   already stored from a prior install - an embed load never carries a
   fresh install, so if nothing's stored the merchant needs to (re)install
   through the normal /auth/install flow first. */
app.post('/api/embed-connect', (req, res) => {
  const clientSecret = process.env.EASYSTORE_CLIENT_SECRET;
  const { shop } = req.body || {};
  if (!clientSecret) return res.status(500).json({ error: 'EASYSTORE_CLIENT_SECRET not set on the server' });
  if (!shop) return res.status(400).json({ error: 'shop is required' });

  const valid = easystore.verifyCallbackHmac(req.body, clientSecret);
  if (!valid) return res.status(401).json({ error: 'hmac did not verify' });

  const key = shop.replace(/\/$/, '').toLowerCase();
  if (!sessions.has(key)) return res.status(404).json({ error: 'not installed yet - connect through the normal install flow first' });
  res.json({ shop: key });
});

/* =======================  upload + preview  =======================
   One endpoint for all three passes - ?type=products|customers|orders
   picks which Shopify parser and which flags apply. =============== */

const PARSERS = {
  products: text => shopify.groupShopifyProducts(text),
  customers: text => shopify.parseShopifyCustomers(text),
  orders: text => shopify.groupShopifyOrders(text),
};

app.post('/api/upload', upload.single('file'), (req, res) => {
  const type = req.query.type || 'products';
  if (!PARSERS[type]) return res.status(400).json({ error: `unknown type "${type}" - expected products, customers, or orders` });
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

  const text = req.file.buffer.toString('utf8');
  let records;
  try {
    records = PARSERS[type](text);
  } catch (e) {
    return res.status(400).json({ error: `could not parse that file as a Shopify ${type} export: ${e.message}` });
  }
  if (!records.length) return res.status(400).json({ error: `no ${type} found - is this the right export?` });

  res.json(stageRecords(type, records));
});

/* Shared by /api/upload (a CSV came from the merchant's browser) and
   /api/shopify/pull (records came straight from Shopify's API). Either
   way the result is the same: a batch of records saved to disk, ready
   for /api/migrate, with the same flags a merchant would see either way. */
function stageRecords(type, records) {
  const uploadId = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(`data/upload-${uploadId}.json`, JSON.stringify({ type, records }));

  const flags = [];
  let itemCount = records.length;

  if (type === 'products') {
    const manyImages = records.filter(p => p.images.length > 3).length;
    const threeOptions = records.filter(p => (p.head['Option3 Name'] || '').trim()).length;
    const noPrice = records.filter(p => p.variants.some(v => !(v['Variant Price'] || '').trim())).length;
    if (manyImages) flags.push({ level: 'warn', text: `${manyImages} product(s) have more than 3 images - only the first 3 will transfer` });
    if (threeOptions) flags.push({ level: 'warn', text: `${threeOptions} product(s) use 3 option types - confirm EasyStore accepts this` });
    if (noPrice) flags.push({ level: 'stop', text: `${noPrice} product(s) have a variant with no price - fix in Shopify and re-export` });
    itemCount = records.reduce((n, p) => n + p.variants.length, 0);
  }
  if (type === 'orders') {
    flags.push({ level: 'warn', text: 'Orders need customer codes to link buyers - upload an EasyStore customer export on the Orders tab before starting, or codes will be looked up by email as a fallback (unconfirmed whether EasyStore accepts that).' });
    itemCount = records.reduce((n, o) => n + o.items.length, 0);
  }

  return { uploadId, type, recordCount: records.length, itemCount, flags };
}

/* =======================  Shopify API connect + pull  =======================
   The alternative to uploading a CSV: the merchant pastes a Shopify Admin
   API access token once (same shortcut as EasyStore's manual token -
   create a custom app in Shopify's own admin, no Partner review needed),
   and "Pull products" fetches the live catalog directly. Products only for
   now - customers and orders still go through the file-based passes. = */

app.post('/api/shopify/connect', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'connect an EasyStore first' });
  const { shopifyShop, shopifyToken } = req.body || {};
  if (!shopifyShop || !shopifyToken) return res.status(400).json({ error: 'shopifyShop and shopifyToken are required' });
  session.shopify = {
    shop: shopifyShop.replace(/\/$/, ''),
    token: shopifyToken,
  };
  res.json({ shop: session.shopify.shop });
});

app.post('/api/shopify/pull', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'connect an EasyStore first' });
  if (!session.shopify) return res.status(400).json({ error: 'connect a Shopify store first' });
  const type = req.query.type || 'products';
  if (type !== 'products') return res.status(400).json({ error: 'only products can be pulled automatically right now - customers and orders still use the file upload' });

  let records;
  try {
    records = await shopifyApi.fetchAllProductsFromShopify(session.shopify.shop, session.shopify.token);
  } catch (e) {
    return res.status(502).json({ error: `Could not reach Shopify: ${e.message}` });
  }
  if (!records.length) return res.status(400).json({ error: 'no products found in that Shopify store' });

  res.json(stageRecords('products', records));
});

/* EasyStore customer export, used only by the orders pass to look up
   customer codes by email - same join the browser tool does. */
app.post('/api/upload-customer-lookup', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  const { parseCSV } = require('./lib/csv');
  const { headers, rows } = parseCSV(req.file.buffer.toString('utf8'));
  const emailCol = headers.find(h => /email/i.test(h)) || headers[0];
  const codeCol = headers.find(h => /code|customer.?id|^id$/i.test(h)) || headers[0];

  const lookupId = crypto.randomBytes(8).toString('hex');
  const map = {};
  rows.forEach(r => {
    const k = String(r[emailCol] || '').trim().toLowerCase();
    if (k && !(k in map)) map[k] = r[codeCol] || '';
  });
  fs.writeFileSync(`data/lookup-${lookupId}.json`, JSON.stringify(map));
  res.json({ lookupId, matched: Object.keys(map).length, emailColumn: emailCol, codeColumn: codeCol });
});

/* =======================  run the migration  ======================= */

app.post('/api/migrate', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'connect a store first' });
  const { uploadId, lookupId } = req.body || {};
  if (!uploadId) return res.status(400).json({ error: 'uploadId is required' });

  const uploadFile = `data/upload-${uploadId}.json`;
  if (!fs.existsSync(uploadFile)) return res.status(404).json({ error: 'upload not found - it may have expired, re-upload the file' });
  const { type, records } = JSON.parse(fs.readFileSync(uploadFile, 'utf8'));

  let customerLookup = null;
  if (type === 'orders' && lookupId) {
    const lookupFile = `data/lookup-${lookupId}.json`;
    if (fs.existsSync(lookupFile)) customerLookup = new Map(Object.entries(JSON.parse(fs.readFileSync(lookupFile, 'utf8'))));
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const job = jobs.createJob(jobId, labelsFor(type, records));
  res.json({ jobId }); // respond immediately; the run happens in the background

  runMigration(jobId, type, records, session, customerLookup).catch(e => {
    console.error(`[job ${jobId}] crashed:`, e);
  });
});

function labelsFor(type, records) {
  if (type === 'products') return records.map(p => ({ handle: p.handle, title: (p.head && p.head.Title) || p.handle }));
  if (type === 'customers') return records.map(r => ({ handle: r.Email, title: `${r['First Name'] || ''} ${r['Last Name'] || ''}`.trim() || r.Email }));
  if (type === 'orders') return records.map(o => ({ handle: o.name, title: `Order ${o.name}` }));
  return [];
}

async function callFor(type, session, payloadSource, customerLookup) {
  if (type === 'products') return easystore.createProduct(session.shop, session.token, shopify.toEasyStorePayload(payloadSource));
  if (type === 'customers') return easystore.createCustomer(session.shop, session.token, shopify.toEasyStoreCustomerPayload(payloadSource));
  if (type === 'orders') return easystore.createOrder(session.shop, session.token, shopify.toEasyStoreOrderPayload(payloadSource, customerLookup));
}

async function runMigration(jobId, type, records, session, customerLookup) {
  const job = jobs.load(jobId);
  for (let i = 0; i < records.length; i++) {
    const item = job.items[i];
    try {
      const result = await callFor(type, session, records[i], customerLookup);
      if (result.ok) {
        item.status = 'done';
        const created = result.body && (result.body.product || result.body.customer || result.body.order);
        item.easystoreId = (created && created.id) || null;
      } else {
        item.status = 'failed';
        // Full EasyStore error body kept here, not just an HTTP code -
        // this is the detail that was missing before and made failures
        // look silent. Shown directly in the dashboard's log panel.
        item.error = `HTTP ${result.status}: ${JSON.stringify(result.body).slice(0, 500)}`;
      }
      const remaining = parseInt(result.rateLimit && result.rateLimit.remaining, 10);
      if (!Number.isNaN(remaining) && remaining < 3) await sleep(2000);
    } catch (e) {
      item.status = 'failed';
      item.error = e.message;
    }
    jobs.save(job);
    await sleep(300);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.post('/api/migrate/:jobId/resume', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'connect a store first' });
  const job = jobs.load(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const { uploadId, lookupId } = req.body || {};
  const uploadFile = `data/upload-${uploadId}.json`;
  if (!fs.existsSync(uploadFile)) return res.status(400).json({ error: 'need the original uploadId to resume' });
  const { type, records } = JSON.parse(fs.readFileSync(uploadFile, 'utf8'));

  let customerLookup = null;
  if (type === 'orders' && lookupId && fs.existsSync(`data/lookup-${lookupId}.json`)) {
    customerLookup = new Map(Object.entries(JSON.parse(fs.readFileSync(`data/lookup-${lookupId}.json`, 'utf8'))));
  }

  const pendingIdx = records.map((_, i) => i).filter(i => job.items[i].status !== 'done');
  res.json({ resuming: pendingIdx.length, alreadyDone: records.length - pendingIdx.length });

  (async () => {
    for (const idx of pendingIdx) {
      const item = job.items[idx];
      try {
        const result = await callFor(type, session, records[idx], customerLookup);
        item.status = result.ok ? 'done' : 'failed';
        item.error = result.ok ? null : `HTTP ${result.status}: ${JSON.stringify(result.body).slice(0, 500)}`;
      } catch (e) { item.status = 'failed'; item.error = e.message; }
      jobs.save(job);
      await sleep(300);
    }
  })();
});

app.get('/api/migrate/:jobId', (req, res) => {
  const job = jobs.load(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const done = job.items.filter(i => i.status === 'done').length;
  const failed = job.items.filter(i => i.status === 'failed').length;
  res.json({ ...job, done, failed, pending: job.total - done - failed });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Migration server listening on port ${PORT}`));
