'use strict';
const { parseCSV } = require('./csv');

/* Groups a Shopify product-export CSV (one row per variant, extra rows for
   extra images) into one object per product. Same rules as the browser tool,
   so a merchant sees identical results whether they use the file or the
   one-click path. */
function groupShopifyProducts(csvText) {
  const { rows } = parseCSV(csvText);
  const map = new Map();

  rows.forEach(r => {
    const handle = (r['Handle'] || '').trim();
    if (!handle) return;
    if (!map.has(handle)) map.set(handle, { handle, head: null, variants: [], images: [] });
    const p = map.get(handle);

    if (!p.head && (r['Title'] || '').trim()) p.head = r;

    const img = (r['Image Src'] || '').trim();
    if (img && !p.images.some(i => i.src === img)) {
      p.images.push({ src: img, pos: parseInt(r['Image Position'] || '0', 10) || p.images.length + 1 });
    }

    const looksLikeVariant = (r['Variant Price'] || '').trim() !== '' ||
      (r['Option1 Value'] || '').trim() !== '' || (r['Variant SKU'] || '').trim() !== '';
    if (looksLikeVariant) p.variants.push(r);
  });

  const out = [];
  map.forEach(p => {
    if (!p.head) p.head = p.variants[0] || { Handle: p.handle };
    if (!p.variants.length) p.variants = [p.head];
    p.images.sort((a, b) => a.pos - b.pos);
    out.push(p);
  });
  return out;
}

/* Shopify's Published/Status -> a plain boolean, matching EasyStore's Yes/No
   convention discovered from the real product template. */
function isPublished(head) {
  const status = String(head['Status'] || '').toLowerCase();
  if (status) return status === 'active';
  return String(head['Published'] || '').toUpperCase() === 'TRUE';
}

/* Builds the payload this server will send to EasyStore for one product.
   Field names on the left are EasyStore's (confirmed from the real import
   template); everything on the right is read straight from Shopify. */
function toEasyStorePayload(p) {
  const head = p.head;
  return {
    title: head['Title'] || '',
    meta_description: head['SEO Description'] || '',
    body_html: head['Body (HTML)'] || '',
    published: isPublished(head),
    vendor: head['Vendor'] || '',
    tags: head['Tags'] || '',
    // EasyStore's own template caps at 3 images per product (confirmed).
    images: p.images.slice(0, 3).map(i => ({ src: i.src })),
    options: [head['Option1 Name'], head['Option2 Name'], head['Option3 Name']]
      .filter(Boolean).map(name => ({ name })),
    variants: p.variants.map(v => ({
      sku: v['Variant SKU'] || '',
      barcode: v['Variant Barcode'] || '',
      price: parseFloat(v['Variant Price'] || '0') || 0,
      compare_at_price: v['Variant Compare At Price'] ? parseFloat(v['Variant Compare At Price']) : null,
      cost_price: v['Cost per item'] ? parseFloat(v['Cost per item']) : null,
      inventory: parseInt(v['Variant Inventory Qty'] || '0', 10) || 0,
      inventory_policy: v['Variant Inventory Policy'] === 'continue' ? 'continue' : 'deny',
      weight: parseInt(v['Variant Grams'] || '0', 10) || 0,
      weight_unit: 'g',
      option1: v['Option1 Value'] || undefined,
      option2: v['Option2 Value'] || undefined,
      option3: v['Option3 Value'] || undefined,
    })),
  };
}

module.exports = { groupShopifyProducts, toEasyStorePayload, isPublished };
