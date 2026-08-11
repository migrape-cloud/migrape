'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

function jobPath(id) { return path.join(DIR, `job-${id}.json`); }

function createJob(id, labeledItems) {
    const job = {
          id,
          createdAt: new Date().toISOString(),
          total: labeledItems.length,
          items: labeledItems.map(({ handle, title }) => ({ handle, title,
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
