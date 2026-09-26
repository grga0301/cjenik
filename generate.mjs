#!/usr/bin/env node
// Generator javnog cjenika (CSV) iz Shopifyja.
// Čita aktivne proizvode objavljene u Online Storeu i zapisuje u OUTPUT_DIR:
//   cjenik.csv            – uvijek aktualni cjenik (stabilan URL za footer / automatsko preuzimanje)
//   arhiva/cjenik_*.csv   – snimka pri svakoj promjeni, čuva se ARCHIVE_DAYS dana
//   index.html            – stranica s aktualnim cjenikom i arhivom
//   .state/history.json   – povijest cijena za "najnižu cijenu u zadnjih 30 dana"
// Bez vanjskih paketa, treba Node 18+.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

loadEnv(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '.env'));

const cfg = {
  shop: normalizeShop(process.env.SHOPIFY_SHOP),        // npr. mojshop.myshopify.com
  token: process.env.SHOPIFY_ACCESS_TOKEN,              // stari custom app (shpat_...)
  clientId: process.env.SHOPIFY_CLIENT_ID,              // ili Dev Dashboard app (client credentials)
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
  apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
  outputDir: process.env.OUTPUT_DIR || './public',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  shopName: process.env.SHOP_NAME || 'Web shop',
  // Gdje je sidrena cijena: "variant:custom.sidrena_cijena", "product:custom.sidrena_cijena" ili "none"
  anchor: process.env.ANCHOR_METAFIELD || 'variant:custom.sidrena_cijena',
  // Ako je compare-at cijena veća od cijene, artikl se tretira kao snižen (poseban oblik prodaje)
  saleFromCompareAt: (process.env.SALE_FROM_COMPARE_AT || 'true') === 'true',
  defaultUnit: process.env.DEFAULT_UNIT || 'kom',
  delimiter: process.env.CSV_DELIMITER || ';',
  decimal: process.env.CSV_DECIMAL || ',',
  archiveDays: Number(process.env.ARCHIVE_DAYS || 35),
  mockFile: process.env.MOCK_FILE,                      // za lokalni test bez Shopifyja
};

const COLUMNS = [
  ['Naziv proizvoda', r => r.title],
  ['Šifra proizvoda', r => r.sku],
  ['Marka proizvoda', r => r.vendor],
  ['Neto količina', r => r.netQty],
  ['Jedinica mjere', r => r.unit],
  ['Maloprodajna cijena', r => money(r.regularPrice)],
  ['Cijena za jedinicu mjere', r => money(r.unitPrice)],
  ['MPC za vrijeme posebnog oblika prodaje', r => money(r.salePrice)],
  ['Poseban oblik prodaje', r => r.saleLabel],
  ['Najniža cijena u posljednjih 30 dana', r => money(r.lowest30)],
  ['Sidrena cijena', r => money(r.anchorPrice)],
  ['Barkod', r => r.barcode],
  ['Kategorija proizvoda', r => r.category],
  ['Dostupnost', r => (r.available ? 'DA' : 'NE')],
  ['Valuta', () => 'EUR'],
];

const UNIT_FACTORS = { // prema baznoj jedinici (g, ml, m, m2, m3)
  MG: ['g', 0.001], G: ['g', 1], KG: ['g', 1000],
  ML: ['ml', 1], CL: ['ml', 10], L: ['ml', 1000], M3: ['ml', 1e6],
  MM: ['m', 0.001], CM: ['m', 0.01], M: ['m', 1], M2: ['m2', 1],
};
const UNIT_LABELS = { MG: 'mg', G: 'g', KG: 'kg', ML: 'ml', CL: 'cl', L: 'l', M3: 'm3', MM: 'mm', CM: 'cm', M: 'm', M2: 'm2', ITEM: 'kom' };

main().catch(err => {
  console.error('GREŠKA:', err.message, err.cause ? `(${err.cause.code || err.cause.message})` : '');
  if (err.message === 'fetch failed') console.error(`Provjeri SHOPIFY_SHOP – skripta se spaja na: ${cfg.shop}`);
  process.exit(1);
});

// Prihvaća "mojshop", "mojshop.myshopify.com", "https://mojshop.myshopify.com/" i
// "https://admin.shopify.com/store/mojshop/..." – uvijek vraća "mojshop.myshopify.com"
function normalizeShop(value) {
  if (!value) return value;
  let s = value.trim().toLowerCase().replace(/^https?:\/\//, '');
  const admin = s.match(/^admin\.shopify\.com\/store\/([^/?#]+)/);
  if (admin) return `${admin[1]}.myshopify.com`;
  s = s.split(/[/?#]/)[0];
  return s.includes('.') ? s : `${s}.myshopify.com`;
}

async function main() {
  const now = new Date();
  const variants = cfg.mockFile
    ? JSON.parse(fs.readFileSync(cfg.mockFile, 'utf8').replace(/^﻿/, ''))
    : await fetchVariants();

  const stateDir = path.join(cfg.outputDir, '.state');
  const archiveDir = path.join(cfg.outputDir, 'arhiva');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  const historyFile = path.join(stateDir, 'history.json');
  const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : {};
  const today = zagrebDate(now);

  const rows = variants
    .filter(v => v.product.status === 'ACTIVE' && v.product.onlineStoreUrl && !v.product.isGiftCard)
    .map(v => toRow(v, history, today))
    .sort((a, b) => a.title.localeCompare(b.title, 'hr') || a.sku.localeCompare(b.sku));

  pruneHistory(history, today);
  fs.writeFileSync(historyFile, JSON.stringify(history));

  const csv = toCsv(rows);
  const hash = crypto.createHash('sha256').update(csv).digest('hex');
  const hashFile = path.join(stateDir, 'last.sha256');
  const changed = !fs.existsSync(hashFile) || fs.readFileSync(hashFile, 'utf8') !== hash;

  writeAtomic(path.join(cfg.outputDir, 'cjenik.csv'), csv);
  if (changed) {
    writeAtomic(path.join(archiveDir, `cjenik_${today}_${zagrebTime(now).replace(':', '')}.csv`), csv);
    fs.writeFileSync(hashFile, hash);
  }
  pruneArchive(archiveDir, now);
  writeAtomic(path.join(cfg.outputDir, 'index.html'), renderIndex(now, rows.length, archiveDir));

  console.log(`${new Date().toISOString()} ok: ${rows.length} artikala, ${changed ? 'nova verzija arhivirana' : 'bez promjena'}`);
}

// ---------- Shopify ----------

async function getToken() {
  if (cfg.token) return cfg.token;
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('Postavi SHOPIFY_ACCESS_TOKEN ili SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
  const res = await fetch(`https://${cfg.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret }),
  });
  if (!res.ok) throw new Error(`Dohvat tokena nije uspio: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const VARIANTS_QUERY = `
query ($cursor: String, $ns: String!, $key: String!) {
  productVariants(first: 250, after: $cursor, query: "product_status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id sku barcode price compareAtPrice availableForSale title
      unitPriceMeasurement { quantityValue quantityUnit referenceValue referenceUnit }
      anchor: metafield(namespace: $ns, key: $key) { value }
      product {
        id title vendor productType status onlineStoreUrl isGiftCard
        category { name }
        anchor: metafield(namespace: $ns, key: $key) { value }
      }
    }
  }
}`;

async function fetchVariants() {
  if (!cfg.shop) throw new Error('Postavi SHOPIFY_SHOP (npr. mojshop.myshopify.com)');
  const token = await getToken();
  const [, ns = 'custom', key = 'sidrena_cijena'] = cfg.anchor.match(/^\w+:([^.]+)\.(.+)$/) || [];
  const all = [];
  let cursor = null;
  do {
    const data = await gql(token, VARIANTS_QUERY, { cursor, ns, key });
    all.push(...data.productVariants.nodes);
    cursor = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

async function gql(token, query, variables, attempt = 1) {
  const res = await fetch(`https://${cfg.shop}/admin/api/${cfg.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  const throttled = res.status === 429 || body.errors?.some?.(e => e.extensions?.code === 'THROTTLED');
  if (throttled && attempt < 6) {
    await new Promise(r => setTimeout(r, 2000 * attempt));
    return gql(token, query, variables, attempt + 1);
  }
  if (!res.ok || body.errors) throw new Error(`Shopify API: ${res.status} ${JSON.stringify(body.errors || body)}`);
  return body.data;
}

// ---------- Pretvorba ----------

function toRow(v, history, today) {
  const price = num(v.price);
  const compareAt = num(v.compareAtPrice);
  const onSale = cfg.saleFromCompareAt && compareAt != null && compareAt > price;
  const upm = v.unitPriceMeasurement;

  // Povijest bilježi stvarnu prodajnu cijenu po danu
  const h = (history[v.id] ||= {});
  h[today] = h[today] == null ? price : Math.min(h[today], price);
  const lowest30 = Math.min(...Object.values(h));

  const title = v.title && v.title !== 'Default Title' ? `${v.product.title} - ${v.title}` : v.product.title;
  return {
    title,
    sku: v.sku || '',
    vendor: v.product.vendor || '',
    netQty: upm?.quantityValue ? `${fmtNum(upm.quantityValue)} ${UNIT_LABELS[upm.quantityUnit] || upm.quantityUnit.toLowerCase()}` : '',
    unit: upm?.referenceUnit ? `${upm.referenceValue > 1 ? upm.referenceValue + ' ' : ''}${UNIT_LABELS[upm.referenceUnit] || upm.referenceUnit.toLowerCase()}` : cfg.defaultUnit,
    regularPrice: onSale ? compareAt : price,
    salePrice: onSale ? price : null,
    saleLabel: onSale ? 'Sniženje' : '',
    unitPrice: unitPrice(price, upm),
    lowest30,
    anchorPrice: cfg.anchor === 'none' ? null : parseMetafieldMoney(v.anchor?.value ?? v.product.anchor?.value),
    barcode: v.barcode || '',
    category: v.product.productType || v.product.category?.name || '',
    available: !!v.availableForSale,
  };
}

function unitPrice(price, upm) {
  if (!upm?.quantityValue || !upm.referenceUnit) return null;
  const q = UNIT_FACTORS[upm.quantityUnit], r = UNIT_FACTORS[upm.referenceUnit];
  if (!q || !r || q[0] !== r[0]) return null;
  return price / (upm.quantityValue * q[1]) * ((upm.referenceValue || 1) * r[1]);
}

function parseMetafieldMoney(value) {
  if (value == null || value === '') return null;
  try {
    const parsed = JSON.parse(value);           // tip "money": {"amount":"49.99","currency_code":"EUR"}
    if (parsed && typeof parsed === 'object') return num(parsed.amount);
    return num(parsed);                         // tip "number_decimal"
  } catch {
    return num(String(value).replace(',', '.')); // tip "single_line_text"
  }
}

function pruneHistory(history, today) {
  const cutoff = shiftDate(today, -30);
  for (const id of Object.keys(history)) {
    for (const d of Object.keys(history[id])) if (d < cutoff) delete history[id][d];
    if (!Object.keys(history[id]).length) delete history[id];
  }
}

function pruneArchive(dir, now) {
  const cutoff = shiftDate(zagrebDate(now), -cfg.archiveDays);
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^cjenik_(\d{4}-\d{2}-\d{2})_/);
    if (m && m[1] < cutoff) fs.unlinkSync(path.join(dir, f));
  }
}

// ---------- Izlaz ----------

function toCsv(rows) {
  const d = cfg.delimiter;
  const esc = s => {
    s = String(s ?? '');
    return /["\r\n]/.test(s) || s.includes(d) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [COLUMNS.map(c => esc(c[0])).join(d)];
  for (const r of rows) lines.push(COLUMNS.map(c => esc(c[1](r))).join(d));
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM da Excel ispravno prikaže č/ć/š/ž
}

function renderIndex(now, count, archiveDir) {
  const base = cfg.publicUrl || '.';
  const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.csv')).sort().reverse();
  const items = files.map(f => {
    const m = f.match(/^cjenik_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})\.csv$/);
    const label = m ? `${m[3]}.${m[2]}.${m[1]}. ${m[4]}:${m[5]}` : f;
    return `<li><a href="${base}/arhiva/${f}" download>${label}</a></li>`;
  }).join('\n      ');
  return `<!doctype html>
<html lang="hr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cjenik proizvoda – ${escHtml(cfg.shopName)}</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#222;line-height:1.5}
    .btn{display:inline-block;padding:10px 18px;background:#222;color:#fff;border-radius:6px;text-decoration:none}
    ul{padding-left:18px} li{margin:2px 0} small{color:#666}
  </style>
</head>
<body>
  <h1>Cjenik proizvoda</h1>
  <p>${escHtml(cfg.shopName)} – aktualni cjenik svih artikala u CSV formatu (UTF-8, razdjelnik "${cfg.delimiter}").</p>
  <p><strong>Posljednje ažuriranje:</strong> ${zagrebDate(now).split('-').reverse().join('.')}. ${zagrebTime(now)}<br>
     <small>Broj artikala: ${count}</small></p>
  <p><a class="btn" href="${base}/cjenik.csv" download>Preuzmi aktualni cjenik (CSV)</a></p>
  ${cfg.publicUrl ? `<p><small>Stalna adresa za automatsko preuzimanje: <code>${cfg.publicUrl}/cjenik.csv</code></small></p>` : ''}
  <h2>Arhiva cjenika (posljednjih ${cfg.archiveDays} dana)</h2>
  <ul>
      ${items || '<li>Još nema arhiviranih verzija.</li>'}
  </ul>
</body>
</html>
`;
}

// ---------- Pomoćne ----------

function writeAtomic(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(v) {
  return v == null ? '' : v.toFixed(2).replace('.', cfg.decimal);
}

function fmtNum(v) {
  return String(Number(v)).replace('.', cfg.decimal);
}

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function zagrebDate(d) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zagreb' }).format(d); // YYYY-MM-DD
}

function zagrebTime(d) {
  return new Intl.DateTimeFormat('hr-HR', { timeZone: 'Europe/Zagreb', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

function shiftDate(ymd, days) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
