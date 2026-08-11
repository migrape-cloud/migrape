'use strict';
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');

const { groupShopifyProducts, toEasyStorePayload } = require('./lib/shopify');
const { createProduct } = require('./lib/easystore');
const jobs = require('./lib/jobs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.static('public'));
app.use(express.json());

/* In-memory store of connected shops, keyed by a short session id kept in a
   cookie. Good enough to run this yourself; a real multi-merchant deployment
   would swap this for a proper database — see README. */
const sessions = new Map(); // sessionId -> { shop, token }

function getSession(req) {
  const sid = req.headers['x-session-id'];
  return sid ? sessions.get(sid) : null;
}

/* ─────────────────────────  connect a store  ───────────────────────── */

// For now: paste-a-token flow (the shortcut discussed earlier — no Shopify
// Partner review needed, and works before EasyStore OAuth is wired up too).
// A merchant creates a private app in their own EasyStore admin
// (or you paste a development-store token while testing) and pastes it here.
app.post('/api/connect', (req, res) => {
  const { shop, token } = req.body || {};
  if (!shop || !token) return res.status(400).json({ error: 'shop and token are required' });
  const sid = crypto.randomBytes(12).toString('hex');
  sessions.set(sid, { shop: shop.replace(/\/$/, ''), token });
  res.json({ sessionId: sid, shop });
});

/* ─────────────────────────  upload + preview  ───────────────────────── */

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  const text = req.file.buffer.toString('utf8');
  let products;
  try {
    products = groupShopifyProducts(text);
  } catch (e) {
    return res.status(400).json({ error: 'could not parse that file as a Shopify product export: ' + e.message });
  }
  if (!products.length) return res.status(400).json({ error: 'no products found — is this a Shopify product export?' });

  // stash the parsed products against an upload id so /api/migrate can use them
  const uploadId = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(`data/upload-${uploadId}.json`, JSON.stringify(products));

  const manyImages = products.filter(p => p.images.length > 3).length;
  const threeOptions = products.filter(p => [p.head['Option3 Name']].some(v => (v || '').trim())).length;
  const noPrice = products.filter(p => p.variants.some(v => !(v['Variant Price'] || '').trim())).length;

  res.json({
    uploadId,
    productCount: products.length,
    variantCount: products.reduce((n, p) => n + p.variants.length, 0),
    flags: [
      manyImages && { level: 'warn', text: `${manyImages} product(s) have more than 3 images — only the first 3 will transfer` },
      threeOptions && { level: 'warn', text: `${threeOptions} product(s) use 3 option types — confirm EasyStore accepts this` },
      noPrice && { level: 'stop', text: `${noPrice} product(s) have a variant with no price — fix in Shopify and re-export` },
    ].filter(Boolean),
  });
});

/* ─────────────────────────  run the migration  ───────────────────────── */

app.post('/api/migrate', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'connect a store first' });
  const { uploadId } = req.body || {};
  if (!uploadId) return res.status(400).json({ error: 'uploadId is required' });

  const uploadFile = `data/upload-${uploadId}.json`;
  if (!fs.existsSync(uploadFile)) return res.status(404).json({ error: 'upload not found — it may have expired, re-upload the file' });
  const products = JSON.parse(fs.readFileSync(uploadFile, 'utf8'));

  const jobId = crypto.randomBytes(8).toString('hex');
  const job = jobs.createJob(jobId, products);
  res.json({ jobId }); // respond immediately; the run happens in the background

  runMigration(jobId, products, session).catch(e => {
    console.error(`[job ${jobId}] crashed:`, e);
  });
});

async function runMigration(jobId, products, session) {
  const job = jobs.load(jobId);
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const item = job.items[i];
    try {
      const payload = toEasyStorePayload(p);
      const result = await createProduct(session.shop, session.token, payload);
      if (result.ok) {
        item.status = 'done';
        item.easystoreId = (result.body && result.body.product && result.body.product.id) || null;
      } else {
        item.status = 'failed';
        item.error = `HTTP ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`;
      }
      // basic rate-limit courtesy: if EasyStore says we're close to the ceiling, pause
      const remaining = parseInt(result.rateLimit && result.rateLimit.remaining, 10);
      if (!Number.isNaN(remaining) && remaining < 3) await sleep(2000);
    } catch (e) {
      item.status = 'failed';
      item.error = e.message;
    }
    jobs.save(job);
    await sleep(300); // gentle pacing regardless of rate-limit headers
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Resume a job that was interrupted (server restart, connection drop, etc). */
app.post('/api/migrate/:jobId/resume', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'connect a store first' });
  const job = jobs.load(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const uploadId = req.body && req.body.uploadId;
  const uploadFile = `data/upload-${uploadId}.json`;
  if (!fs.existsSync(uploadFile)) return res.status(400).json({ error: 'need the original uploadId to resume' });
  const products = JSON.parse(fs.readFileSync(uploadFile, 'utf8'));

  // only re-attempt items that never succeeded
  const pending = products.filter((_, i) => job.items[i].status !== 'done');
  res.json({ resuming: pending.length, alreadyDone: products.length - pending.length });

  const remap = products.map((_, i) => i).filter(i => job.items[i].status !== 'done');
  (async () => {
    for (const idx of remap) {
      const p = products[idx];
      const item = job.items[idx];
      try {
        const payload = toEasyStorePayload(p);
        const result = await createProduct(session.shop, session.token, payload);
        item.status = result.ok ? 'done' : 'failed';
        item.error = result.ok ? null : `HTTP ${result.status}`;
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
