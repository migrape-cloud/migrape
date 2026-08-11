'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

function jobPath(id) { return path.join(DIR, `job-${id}.json`); }

function createJob(id, products) {
  const job = {
    id,
    createdAt: new Date().toISOString(),
    total: products.length,
    // one entry per product: pending -> done | failed, plus the EasyStore id once created
    items: products.map(p => ({ handle: p.handle, title: p.head.title || p.head.Title || p.handle,
      status: 'pending', easystoreId: null, error: null })),
  };
  save(job);
  return job;
}

function load(id) {
  const p = jobPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function save(job) {
  fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
}

module.exports = { createJob, load, save };
