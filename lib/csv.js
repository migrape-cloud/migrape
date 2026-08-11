'use strict';
/* Same parser used in the browser converter, so behaviour matches exactly
   between the file-based tool and this server. No dependency needed. */

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter(r => r.some(v => v !== '' && v != null));
  if (!clean.length) return { headers: [], rows: [] };
  const headers = clean[0].map(h => h.trim());
  const out = clean.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i] != null ? r[i] : ''; });
    return o;
  });
  return { headers, rows: out };
}

function toCSV(headers, rows) {
  const esc = v => {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = [headers.map(esc).join(',')];
  rows.forEach(r => lines.push(headers.map(h => esc(r[h])).join(',')));
  return '\uFEFF' + lines.join('\r\n');
}

module.exports = { parseCSV, toCSV };
