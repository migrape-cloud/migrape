'use strict';
const fetch = require('node-fetch');

/* Converts a Shopify Admin API product object into the exact same shape
   groupShopifyProducts() builds from a CSV export - same string keys
   ('Title', 'Variant SKU', etc.) - so toEasyStorePayload() in shopify.js
   works completely unchanged regardless of whether the data came from a
   file or the API. */
function shopifyProductToInternal(p) {
  const opts = p.options || [];
  const head = {
    'Title': p.title || '',
    'Body (HTML)': p.body_html || '',
    'Vendor': p.vendor || '',
    'Tags': p.tags || '',
    'Status': p.status || '',
    'Published': p.status === 'active' ? 'TRUE' : 'FALSE',
    'Option1 Name': opts[0] ? opts[0].name : '',
    'Option2 Name': opts[1] ? opts[1].name : '',
    'Option3 Name': opts[2] ? opts[2].name : '',
    'SEO Description': '',
  };
  const images = (p.images || [])
    .map(img => ({ src: img.src, pos: img.position || 0 }))
    .sort((a, b) => a.pos - b.pos);
  const variants = (p.variants || []).map(v => ({
    'Variant SKU': v.sku || '',
    'Variant Barcode': v.barcode || '',
    'Variant Price': v.price != null ? String(v.price) : '0',
    'Variant Compare At Price': v.compare_at_price != null ? String(v.compare_at_price) : '',
    'Cost per item': '', // not exposed on the REST product/variant object
    'Variant Inventory Qty': v.inventory_quantity != null ? String(v.inventory_quantity) : '0',
    'Variant Inventory Policy': v.inventory_policy === 'continue' ? 'continue' : 'deny',
    'Variant Grams': v.grams != null ? String(v.grams) : '0',
    'Option1 Value': v.option1 || '',
    'Option2 Value': v.option2 || '',
    'Option3 Value': v.option3 || '',
  }));
  return { handle: p.handle, head, variants: variants.length ? variants : [head], images };
}

/* Pulls every product from a Shopify store, following Shopify's cursor
   pagination (the Link response header) until there's no next page.
   Shopify's REST rate limit is small (roughly 2 requests/sec on a
   standard plan), so a short pause between pages avoids tripping it on
   a large catalog. */
async function fetchAllProductsFromShopify(shopDomain, token) {
  const cleaned = shopDomain.replace(/\/$/, '');
  const origin = /^https?:\/\//.test(cleaned) ? cleaned : `https://${cleaned}`;
  let url = `${origin}/admin/api/2024-01/products.json?limit=250`;
  const all = [];

  while (url) {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify API error ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    all.push(...(json.products || []));

    const link = res.headers.get('link') || res.headers.get('Link');
    const next = link && /<([^>]+)>;\s*rel="next"/.exec(link);
    url = next ? next[1] : null;
    if (url) await new Promise(r => setTimeout(r, 500));
  }

  return all.map(shopifyProductToInternal);
}

module.exports = { fetchAllProductsFromShopify, shopifyProductToInternal };
