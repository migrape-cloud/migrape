'use strict';
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');

const shopify = require('./lib/shopify');
const easystore = require('./lib/easystore');
const jobs = require('./lib/jobs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.static('public'));
app.use(express.json());

const sessions = new Map();

function getSession(req) {
   const sid = req.headers['x-session-id'];
   return sid ? sessions.get(sid) : null;
}
function startSession(shop, token) {
   const sid = crypto.randomBytes(12).toString('hex');
   sessions.set(sid, { shop: shop.replace(/\/$/, ''), token });
   return sid;
}

app.get('/auth/install', (req, res) => {
   const clientId = process.env.EASYSTORE_CLIENT_ID;
   const shop = req.query.shop;
   if (!clientId) return res.status(500).send('EASYSTORE_CLIENT_ID is not set on the server.');
   if (!shop) return res.status(400).send('Missing shop parameter.');

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
   if (!code || !shop) return res.status(400).send('Missing code or shop.');

        const validHmac = easystore.verifyCallbackHmac(req.query, clientSecret);
   if (!validHmac) {
      console.warn(`[auth] HMAC did not verify for shop=${shop}`);
   }

        try {
           const token = await easystore.exchangeToken(shop, clientId, clientSecret, code);
           const sid = startSession(shop, token);
           res.redirect(`/?connected=1&sessionId=${sid}&shop=${encodeURIComponent(shop)}`);
        } catch (e) {
           res.status(502).send(`Could not exchange the code for a token: ${e.message}`);
        }
});

app.post('/api/connect', (req, res) => {
   const { shop, token } = req.body || {};
   if (!shop || !token) return res.status(400).json({ error: 'shop and token are required' });
   const sid = startSession(shop, token);
   res.json({ sessionId: sid, shop });
});

const PARSERS = {
   products: text => shopify.groupShopifyProducts(text),
   customers: text => shopify.parseShopifyCustomers(text),
   orders: text => shopify.groupShopifyOrders(text),
};

app.post('/api/upload', upload.single('file'), (req, res) => {
   const type = req.query.type || 'products';
   if (!PARSERS[type]) return res.status(400).json({ error: `unknown type "${type}"` });
   if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

         const text = req.file.buffer.toString('utf8');
   let records;
   try {
      records = PARSERS[type](text);
   } catch (e) {
      return res.status(400).json({ error: `could not parse that file as a Shopify ${type} export: ${e.message}` });
   }
   if (!records.length) return res.status(400).json({ error: `no ${type} found` });

         const uploadId = crypto.randomBytes(8).toString('hex');
   fs.writeFileSync(`data/upload-${uploadId}.json`, JSON.stringify({ type, records }));

         const flags = [];
   let itemCount = records.length;

         if (type === 'products') {
            const manyImages = records.filter(p => p.images.length > 3).length;
            const threeOptions = records.filter(p => (p.head['Option3 Name'] || '').trim()).length;
            const noPrice = records.filter(p => p.variants.some(v => !(v['Variant Price'] || '').trim())).length;
            if (manyImages) flags.push({ level: 'warn', text: `${manyImages} product(s) have more than 3 images` });
            if (threeOptions) flags.push({ level: 'warn', text: `${threeOptions} product(s) use 3 option types` });
            if (noPrice) flags.push({ level: 'stop', text: `${noPrice} product(s) have a variant with no price` });
            itemCount = records.reduce((n, p) => n + p.variants.length, 0);
         }
   if (type === 'orders') {
      flags.push({ level: 'warn', text: 'Orders need customer codes — upload an EasyStore customer export on the Orders tab.' });
      itemCount = records.reduce((n, o) => n + o.items.length, 0);
   }

         res.json({ uploadId, type, recordCount: records.length, itemCount, flags });
});

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

app.post('/api/migrate', async (req, res) => {
   const session = getSession(req);
   if (!session) return res.status(401).json({ error: 'connect a store first' });
   const { uploadId, lookupId } = req.body || {};
   if (!uploadId) return res.status(400).json({ error: 'uploadId is required' });

         const uploadFile = `data/upload-${uploadId}.json`;
   if (!fs.existsSync(uploadFile)) return res.status(404).json({ error: 'upload not found' });
   const { type, records } = JSON.parse(fs.readFileSync(uploadFile, 'utf8'));

         let customerLookup = null;
   if (type === 'orders' && lookupId) {
      const lookupFile = `data/lookup-${lookupId}.json`;
      if (fs.existsSync(lookupFile)) customerLookup = new Map(Object.entries(JSON.parse(fs.readFileSync(lookupFile, 'utf8'))));
   }

         const jobId = crypto.randomBytes(8).toString('hex');
   const job = jobs.createJob(jobId, labelsFor(type, records));
   res.json({ jobId });

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
