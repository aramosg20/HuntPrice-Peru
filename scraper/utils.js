'use strict';
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ─── Title cleanup ────────────────────────────────────────────────────────────

// Promo noise patterns common in Peruvian e-commerce titles
const PROMO_PATTERNS = [
  /\s*[\(\[](NUEVO|OUTLET|OFERTA|REMATE|LIQUIDACI[OÓ]N|EXCLUSIVO|IMPERDIBLE|DESCUENTO|PROMOCIÓN|PROMO)[\)\]]/gi,
  /[¡!]+[A-ZÁÉÍÓÚÑÜ\s]{3,}[!¡]+/g,   // ¡GRAN OFERTA!
  /^[-–—!¡¿\s]+/,                      // leading punctuation noise
  /[-–—!¡\s]+$/,                       // trailing punctuation noise
];

function cleanTitle(str) {
  if (!str) return '';
  let s = str.trim().replace(/\s+/g, ' ');
  for (const re of PROMO_PATTERNS) s = s.replace(re, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  // Fallback to original if cleaning removed too much
  return (s.length >= 4 ? s : str.trim()).substring(0, 120);
}

// ─── SKU utilities ────────────────────────────────────────────────────────────

// Deterministic hash SKU from URL — stable across scrape cycles
function urlToSku(url) {
  if (!url) return null;
  return 'u_' + crypto.createHash('md5').update(url).digest('hex').substring(0, 12);
}

// Extract MercadoLibre item ID from product URL (MPE123456789, MLA, etc.)
function mlSkuFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/(M(?:PE|LA|LB|LC|CO|LM|LU|LE|EC|DO|PA|GT|SV|HN|NI|CR|BO|PY|UY|VE)\d+)/i);
  return m ? m[1] : null;
}

// ─── Image URL normalization ──────────────────────────────────────────────────

// Strip scene7 resize query params → full resolution
// e.g. https://falabella.scene7.com/.../image?wid=800&hei=800&qlt=70 → strip ?...
function cleanScene7Url(url) {
  if (!url) return url;
  const q = url.indexOf('?');
  return q !== -1 ? url.substring(0, q) : url;
}

// Normalize VTEX image URL to 1000×1000 (replaces -NNN-NNN suffix in the path)
// e.g. https://store.vtexassets.com/arquivos/ids/123456-500-500/img.jpg
//    → https://store.vtexassets.com/arquivos/ids/123456-1000-1000/img.jpg
function normalizeVtexImage(url) {
  if (!url) return url;
  return url.replace(/(-\d+)-(\d+)(\/[^/?]+)/, '-1000-1000$3');
}

// ─── Structural URL validation (no network) ───────────────────────────────────

function isValidProductUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const p = new URL(url);
    if (!['http:', 'https:'].includes(p.protocol)) return false;
    // Must have a path deeper than just /
    if (p.pathname.replace(/\/+$/, '').length < 2) return false;
    return true;
  } catch (_) {
    return false;
  }
}

// ─── HEAD check (curl, opt-in via VALIDATE_URLS=true) ────────────────────────

async function headCheck(url, timeoutSecs = 6) {
  try {
    const code = execFileSync('curl', [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '--max-time', String(timeoutSecs),
      '-L', '--max-redirs', '3',
      '-X', 'HEAD',
      '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      url,
    ], { timeout: (timeoutSecs + 2) * 1000, maxBuffer: 512 }).toString().trim();
    const status = parseInt(code, 10);
    return status >= 200 && status < 400;
  } catch (_) {
    return false;
  }
}

// Batch HEAD-filter — only runs when VALIDATE_URLS=true env var is set.
// concurrency: parallel checks per batch.
async function filterDeadUrls(products, concurrency = 6) {
  if (process.env.VALIDATE_URLS !== 'true') return products;
  if (!products.length) return products;
  console.log(`[URLFilter] Checking ${products.length} URLs (concurrency=${concurrency})…`);
  const alive = [];
  for (let i = 0; i < products.length; i += concurrency) {
    const batch = products.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(p => headCheck(p.url)));
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) alive.push(batch[j]);
      else console.log(`[URLFilter] Dead URL discarded: ${batch[j].url}`);
    }
  }
  console.log(`[URLFilter] ${alive.length}/${products.length} URLs alive`);
  return alive;
}

module.exports = { cleanTitle, urlToSku, mlSkuFromUrl, cleanScene7Url, normalizeVtexImage, isValidProductUrl, headCheck, filterDeadUrls };
