'use strict';
process.env.PORT = '4100';
const http = require('http');

let created = [];
const fakeStore = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/3.0/products.json') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const payload = JSON.parse(body).product;
      if (payload.title === 'FAIL ME') {
        res.writeHead(422, { 'Content-Type': 'application/json', 'x-ratelimit-remaining': '38', 'x-ratelimit-limit': '40' });
        return res.end(JSON.stringify({ errors: 'simulated failure' }));
      }
      const id = 1000 + created.length;
      created.push(payload);
      res.writeHead(201, { 'Content-Type': 'application/json', 'x-ratelimit-remaining': '38', 'x-ratelimit-limit': '40' });
      res.end(JSON.stringify({ product: { id, ...payload } }));
    });
    return;
  }
  res.writeHead(404); res.end('{}');
});

const csv = `Handle,Title,Body (HTML),Vendor,Type,Tags,Published,Option1 Name,Option1 Value,Variant SKU,Variant Grams,Variant Inventory Qty,Variant Inventory Policy,Variant Price,Variant Compare At Price,Image Src,Image Position,Status
curtain,Lace Curtain,"<p>Soft lace</p>",Deco Homie,Curtains,lace,TRUE,Size,Small,RL-S,800,12,deny,179.00,199.00,https://picsum.photos/seed/1/800,1,active
curtain,,,,,,,,Medium,RL-M,1100,5,deny,199.00,,https://picsum.photos/seed/2/800,2,
lamp,Brass Lamp,"<p>Warm</p>",Deco Homie,Lighting,lighting,TRUE,,,LMP-1,2400,7,deny,249.00,,https://picsum.photos/seed/3/800,1,active
willfail,FAIL ME,"<p>test</p>",Deco Homie,Test,,TRUE,,,FAIL-1,100,1,deny,10.00,,https://picsum.photos/seed/4/800,1,active`;

async function main() {
  await new Promise(r => fakeStore.listen(4101, r));
  console.log('fake EasyStore listening on :4101');

  // require the real server in-process — its app.listen(4100) runs immediately
  require('../server.js');
  await new Promise(r => setTimeout(r, 400));

  const base = 'http://localhost:4100';
  const j = async (url, opts) => {
    const r = await fetch(base + url, opts);
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  console.log('\n1. connect');
  const conn = await j('/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shop: 'http://localhost:4101', token: 'fake-token-123' }) });
  console.log('  ', conn.status, conn.body);
  const sessionId = conn.body.sessionId;

  console.log('\n2. upload');
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'shopify_products_export.csv');
  const upRes = await fetch(base + '/api/upload', { method: 'POST', body: form });
  const upload = await upRes.json();
  console.log('  ', upRes.status, upload);

  console.log('\n3. migrate');
  const mig = await j('/api/migrate', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
    body: JSON.stringify({ uploadId: upload.uploadId }) });
  console.log('  ', mig.status, mig.body);
  const jobId = mig.body.jobId;

  console.log('\n4. poll until done');
  let final;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 400));
    const st = await j('/api/migrate/' + jobId);
    process.stdout.write(`   done=${st.body.done} failed=${st.body.failed} pending=${st.body.pending}\n`);
    if (st.body.pending === 0) { final = st.body; break; }
  }

  console.log('\n═══ CHECKS ═══');
  console.log('  3 products in file, all attempted                 :', final.total === 3);
  console.log('  curtain + lamp succeeded                          :', final.done === 2);
  console.log('  poison-pill product failed, others unaffected     :', final.failed === 1);
  const failedItem = final.items.find(i => i.status === 'failed');
  console.log('  failure carries EasyStore\'s error message         :', failedItem && failedItem.error && failedItem.error.includes('simulated failure'));
  console.log('  EasyStore received 2 created products             :', created.length === 2);
  const curtain = created.find(p => p.title === 'Lace Curtain');
  console.log('  curtain has 2 variants                            :', curtain && curtain.variants.length === 2);
  console.log('  curtain has 1 option (Size)                       :', curtain && curtain.options.length === 1 && curtain.options[0].name === 'Size');
  console.log('  curtain has 2 images                              :', curtain && curtain.images.length === 2);
  console.log('  variant price parsed as number 179                :', curtain && curtain.variants[0].price === 179);
  console.log('  weight in grams carried through (800)             :', curtain && curtain.variants[0].weight === 800);
  console.log('  published boolean true for active status          :', curtain && curtain.published === true);

  process.exit(0);
}

main().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
