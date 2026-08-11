'use strict';
const fetch = require('node-fetch');

/* EVERYTHING IN THIS BLOCK IS UNCONFIRMED.
It's built from EasyStore's published docs (auth header name, OAuth
token URL, rate-limit header names) plus reasonable guesses for the
parts the docs don't publish in plain text (the product endpoint
path, whether variants nest inside the product or are separate calls).
Run easystore-probe.js against a real development store, then update
the TODO lines below. */

const origin = shop => /^https?:\/\//.test(shop) ? shop : `https://${shop}`;

const ENDPOINTS = {
   oauthToken: shop => `${origin(shop)}/api/3.0/oauth/access_token.json`,
   createProduct: shop => `${origin(shop)}/api/3.0/products.json`,
   listProducts: shop => `${origin(shop)}/api/3.0/products.json`,
   createCollection: shop => `${origin(shop)}/api/3.0/collections.json`,
   createCustomer: shop => `${origin(shop)}/api/3.0/customers.json`,
   listCustomers: shop => `${origin(shop)}/api/3.0/customers.json`,
   createOrder: shop => `${origin(shop)}/api/3.0/orders.json`,
};

async function exchangeToken(shop, clientId, clientSecret, code) {
   const res = await fetch(ENDPOINTS.oauthToken(shop), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
   });
   const body = await res.json().catch(() => ({}));
   if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(body)}`);
   return body.access_token || body.token;
}

async function easystoreRequest(shop, token, url, body, wrapKey) {
   const res = await fetch(url, {
      method: 'POST',
      headers: {
         'EasyStore-Access-Token': token,
         'Content-Type': 'application/json',
         'Accept': 'application/json',
      },
      body: JSON.stringify(wrapKey ? { [wrapKey]: body } : body),
   });
   const text = await res.text();
   let json = null;
   try { json = JSON.parse(text); } catch { }
   return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      body: json || text,
      rateLimit: {
         remaining: res.headers.get('x-ratelimit-remaining'),
         limit: res.headers.get('x-ratelimit-limit'),
      },
   };
}

async function createProduct(shop, token, payload) {
   return easystoreRequest(shop, token, ENDPOINTS.createProduct(shop), payload, 'product');
}

async function createCustomer(shop, token, payload) {
   return easystoreRequest(shop, token, ENDPOINTS.createCustomer(shop), payload, 'customer');
}

async function createOrder(shop, token, payload) {
   return easystoreRequest(shop, token, ENDPOINTS.createOrder(shop), payload, 'order');
}

async function listAllCustomers(shop, token) {
   const res = await fetch(ENDPOINTS.listCustomers(shop), {
      headers: { 'EasyStore-Access-Token': token, 'Accept': 'application/json' },
   });
   if (!res.ok) return { ok: false, status: res.status, customers: [] };
   const json = await res.json().catch(() => ({}));
   const list = Array.isArray(json) ? json : (json.customers || json.data || []);
   return { ok: true, customers: list };
}

function verifyCallbackHmac(query, clientSecret) {
   const crypto = require('crypto');
   const { hmac, ...rest } = query;
   if (!hmac) return false;
   const message = Object.keys(rest).sort()
   .map(k => `${k}=${Array.isArray(rest[k]) ? rest[k][0] : rest[k]}`)
   .join('&');
   const digest = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
   try {
      return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(hmac)));
   } catch {
      return false;
   }
}

module.exports = {
   ENDPOINTS, exchangeToken, createProduct,
   createCustomer, createOrder, listAllCustomers, verifyCallbackHmac,
};
