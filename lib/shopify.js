'use strict';
const { parseCSV } = require('./csv');

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

function isPublished(head) {
   const status = String(head['Status'] || '').toLowerCase();
   if (status) return status === 'active';
   return String(head['Published'] || '').toUpperCase() === 'TRUE';
}

function toEasyStorePayload(p) {
   const head = p.head;
   return {
      title: head['Title'] || '',
      meta_description: head['SEO Description'] || '',
      body_html: head['Body (HTML)'] || '',
      published: isPublished(head),
      vendor: head['Vendor'] || '',
      tags: head['Tags'] || '',
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

function parseShopifyCustomers(csvText) {
   const { rows } = parseCSV(csvText);
   const seen = new Set();
   const out = [];
   rows.forEach(r => {
      const email = (r.Email || '').trim().toLowerCase();
      if (!email || seen.has(email)) return;
      seen.add(email);
      out.push(r);
   });
   return out;
}

function todayUS() {
   const d = new Date(), p = n => String(n).padStart(2, '0');
   return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

function toEasyStoreCustomerPayload(row) {
   const marketing = String(row['Accepts Email Marketing'] || '').toLowerCase();
   return {
      email: row.Email || '',
      first_name: row['First Name'] || '',
      last_name: row['Last Name'] || '',
      phone: row.Phone || '',
      accepts_marketing: marketing === 'yes' || marketing === 'true',
      company: row['Default Address Company'] || '',
      address1: row['Default Address Address1'] || '',
      address2: row['Default Address Address2'] || '',
      city: row['Default Address City'] || '',
      zip: row['Default Address Zip'] || '',
      country_code: row['Default Address Country Code'] || '',
      note: row.Note || '',
      blacklist_customer: false,
      credit_balance: 0,
      point_balance: 0,
      total_spent_adjustment_legacy: parseFloat(row['Total Spent'] || '0') || 0,
      total_orders_adjustment_legacy: parseInt(row['Total Orders'] || '0', 10) || 0,
      sales_adjustment_legacy_cut_off_date: todayUS(),
   };
}

function groupShopifyOrders(csvText) {
   const { rows } = parseCSV(csvText);
   const map = new Map();
   rows.forEach(r => {
      const name = (r.Name || '').trim();
      if (!name) return;
      if (!map.has(name)) map.set(name, { name, head: null, items: [] });
      const o = map.get(name);
      if (!o.head && (r['Created at'] || r['Financial Status'] || r.Total)) o.head = r;
      if ((r['Lineitem name'] || '').trim()) o.items.push(r);
   });
   const out = [];
   map.forEach(o => {
      if (!o.head) o.head = o.items[0] || {};
      if (!o.items.length) o.items = [o.head];
      out.push(o);
   });
   return out;
}

function orderDateParts(s) {
   const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
   return m ? { y: m[1], mo: m[2], d: m[3] } : null;
}

function toEasyStoreOrderPayload(order, customerLookup) {
   const head = order.head;
   const email = String(head.Email || '').trim().toLowerCase();
   const customerCode = customerLookup ? (customerLookup.get(email) || null) : null;
   const dp = orderDateParts(head['Created at']);

return {
   order_number: head.Name || order.name,
   customer_code: customerCode,
   customer_email: email,
   date: dp ? `${dp.y}-${dp.mo}-${dp.d}` : '',
   currency: head.Currency || '',
   subtotal: parseFloat(head.Subtotal || '0') || 0,
   total_tax: parseFloat(head.Taxes || '0') || 0,
   total_amount: parseFloat(head.Total || '0') || 0,
   remark: head.Notes || '',
   items: order.items.map(it => ({
      item_type: 'Purchase',
      item_name: it['Lineitem name'] || '',
      item_sku: it['Lineitem sku'] || '',
      item_price: parseFloat(it['Lineitem price'] || '0') || 0,
      quantity: parseInt(it['Lineitem quantity'] || '1', 10) || 1,
      item_is_reward_points: false,
   })),
};
}

module.exports = {
   groupShopifyProducts, toEasyStorePayload, isPublished,
   parseShopifyCustomers, toEasyStoreCustomerPayload,
   groupShopifyOrders, toEasyStoreOrderPayload,
};
