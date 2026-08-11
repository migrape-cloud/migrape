'use strict';
const fetch = require('node-fetch');

/* ════════════════════════════════════════════════════════════════════
   EVERYTHING IN THIS BLOCK IS UNCONFIRMED.
   It's built from EasyStore's published docs (auth header name, OAuth
   token URL, rate-limit header names) plus reasonable guesses for the
   parts the docs don't publish in plain text (the product endpoint
   path, whether variants nest inside the product or are separate calls).

   Run easystore-probe.js against a real development store, then update
   the three lines marked TODO below. Nothing else in this server needs
   to change.
   ════════════════════════════════════════════════════════════════════ */

const origin = shop => /^https?:\/\//.test(shop) ? shop : `https://${shop}`;

const ENDPOINTS = {
  oauthToken:      shop => `${origin(shop)}/api/3.0/oauth/access_token.json`, // documented
  createProduct:   shop => `${origin(shop)}/api/3.0/products.json`,           // TODO confirm
  listProducts:    shop => `${origin(shop)}/api/3.0/products.json`,           // TODO confirm
  createCollection:shop => `${origin(shop)}/api/3.0/collections.json`,        // TODO confirm
};

async function exchangeToken(shop, clientId, clientSecret, code) {
  const res = await fetch(ENDPOINTS.oauthToken(shop), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(body)}`);
  return body.access_token || body.token; // TODO confirm the exact response key
}

async function createProduct(shop, token, payload) {
  const res = await fetch(ENDPOINTS.createProduct(shop), {
    method: 'POST',
    headers: {
      'EasyStore-Access-Token': token,   // documented header name
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ product: payload }), // TODO confirm nested vs flat
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
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

module.exports = { ENDPOINTS, exchangeToken, createProduct };
