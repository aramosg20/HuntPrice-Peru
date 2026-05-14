'use strict';
const { execFileSync } = require('child_process');

// DESHABILITADO: Samsung PE carga productos 100% client-side (AEM + JS).
// El endpoint AJAX (/pe/common/ajax/getAllGalleryProductList.do) fue eliminado (HTTP 404).
// searchapi.samsung.com/v6 y esapi.samsung.com no tienen endpoints accesibles sin sesión.
// Requiere Playwright para interceptar la llamada XHR real.
// TODO: implementar en producción (Railway) donde hay RAM suficiente para Playwright.
//       En desarrollo (Termux) la RAM no alcanza para correr un browser headless.
const ENABLED = false;

const STORE = 'Samsung';
const BASE = 'https://www.samsung.com';
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const HTML_URLS = [
  `${BASE}/pe/offer/`,
  `${BASE}/pe/smartphones/all-smartphones/`,
  `${BASE}/pe/televisions/all-televisions/`,
  `${BASE}/pe/tablets/all-tablets/`,
  `${BASE}/pe/laptops/all-laptops/`,
];

// Samsung PE public product listing API (returns JSON with price data)
const SAMSUNG_API_URLS = [
  `${BASE}/pe/common/ajax/getAllGalleryProductList.do?type=2&category=MN&listType=list&prd_sort=PD0014&start=0&end=30`,
  `${BASE}/pe/common/ajax/getAllGalleryProductList.do?type=2&category=SM&listType=list&prd_sort=PD0014&start=0&end=30`,
  `${BASE}/pe/common/ajax/getAllGalleryProductList.do?type=2&category=TV&listType=list&prd_sort=PD0014&start=0&end=30`,
];

function log(event, data = {}) {
  console.log(JSON.stringify({ level: 'info', store: STORE, event, timestamp: new Date().toISOString(), ...data }));
}

async function ping(state, extra = '') {
  const key = process.env.CRONITOR_API_KEY;
  if (!key) return;
  try { await fetch(`https://cronitor.link/p/${key}/huntprice-scraper-samsung?state=${state}${extra}`); } catch (_) {}
}

function isBlocked(html) {
  const lower = (html || '').toLowerCase();
  return ['captcha', 'are you a robot', 'cf-browser-verification', 'cf_chl_', 'just a moment...', 'checking your browser', 'access denied'].some(s => lower.includes(s));
}

function buildHtmlArgs(url) {
  return [
    '-s', '-L', '--max-time', '30',
    '-H', `User-Agent: ${UA}`,
    '-H', 'Accept: text/html,application/xhtml+xml,*/*;q=0.9',
    '-H', 'Accept-Language: es-PE,es;q=0.9,en;q=0.8',
    '-H', 'Accept-Encoding: gzip, deflate, br',
    '-H', `Referer: ${BASE}/pe/`,
    '-H', 'sec-ch-ua: "Chromium";v="124", "Not-A.Brand";v="99"',
    '-H', 'sec-ch-ua-mobile: ?1',
    '-H', 'sec-ch-ua-platform: "Android"',
    '-H', 'sec-fetch-dest: document',
    '-H', 'sec-fetch-mode: navigate',
    '-H', 'sec-fetch-site: same-origin',
    '-H', 'sec-fetch-user: ?1',
    '-H', 'upgrade-insecure-requests: 1',
    '--compressed',
    url,
  ];
}

function buildApiArgs(url) {
  return [
    '-s', '-L', '--max-time', '20',
    '-H', `User-Agent: ${UA}`,
    '-H', 'Accept: application/json, */*',
    '-H', 'Accept-Language: es-PE,es;q=0.9',
    '-H', 'Accept-Encoding: gzip, deflate, br',
    '-H', `Referer: ${BASE}/pe/offer/`,
    '-H', 'sec-ch-ua: "Chromium";v="124", "Not-A.Brand";v="99"',
    '-H', 'sec-ch-ua-mobile: ?1',
    '-H', 'sec-fetch-dest: empty',
    '-H', 'sec-fetch-mode: cors',
    '-H', 'sec-fetch-site: same-origin',
    '--compressed',
    url,
  ];
}

async function fetchHtml(url, attempt = 1) {
  try {
    const raw = execFileSync('curl', buildHtmlArgs(url), { maxBuffer: 15 * 1024 * 1024, timeout: 35000 }).toString();
    log('scrape_response', { url, bytes: raw.length, attempt });
    return raw;
  } catch (err) {
    log('scrape_fetch_error', { url, message: err.message, attempt });
    if (attempt < 3) {
      await delay(Math.pow(2, attempt) * 1000 + Math.random() * 1000);
      return fetchHtml(url, attempt + 1);
    }
    return null;
  }
}

async function fetchApi(url, attempt = 1) {
  try {
    const raw = execFileSync('curl', buildApiArgs(url), { maxBuffer: 5 * 1024 * 1024, timeout: 25000 }).toString();
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      log('scrape_api_ok', { url });
      return JSON.parse(trimmed);
    }
    log('scrape_api_non_json', { url, preview: trimmed.substring(0, 120) });
    return null;
  } catch (err) {
    log('scrape_api_error', { url, message: err.message, attempt });
    if (attempt < 3) {
      await delay(Math.pow(2, attempt) * 1000);
      return fetchApi(url, attempt + 1);
    }
    return null;
  }
}

async function scrape() {
  if (!ENABLED) {
    log('scrape_skipped', { reason: 'disabled — requiere Playwright en producción' });
    return [];
  }
  log('scrape_started', {});
  await ping('run');
  const products = [];
  const seen = new Set();

  // Attempt 1: Samsung PE internal JSON API
  for (const apiUrl of SAMSUNG_API_URLS) {
    const data = await fetchApi(apiUrl);
    if (data) {
      const list = data?.productList || data?.modelList || data?.response?.modelList || [];
      log('scrape_api_items', { url: apiUrl, count: list.length });
      for (const item of list.slice(0, 40)) tryPushItem(item, products, seen, apiUrl);
      if (products.length >= 10) break;
    }
    await delay(800);
  }

  // Attempt 2: Next.js pages — __NEXT_DATA__, JSON-LD, digitalData, productList patterns
  for (const url of HTML_URLS) {
    if (products.length >= 15) break;
    try {
      const html = await fetchHtml(url);
      if (!html) continue;

      if (isBlocked(html)) {
        log('scrape_blocked', { url, preview: html.substring(0, 200) });
        continue;
      }

      const before = products.length;

      // __NEXT_DATA__
      const nextMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (nextMatch) {
        try {
          const nd = JSON.parse(nextMatch[1]);
          extractFromNextData(nd, products, seen, url);
          log('scrape_next_data', { url, productsAfter: products.length });
        } catch (e) { log('scrape_next_data_error', { url, message: e.message }); }
      }

      // JSON-LD
      for (const m of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
        try {
          const schema = JSON.parse(m[1]);
          extractFromSchema(schema, products, seen, url);
        } catch (_) {}
      }

      // Samsung-specific patterns
      const patterns = [
        /"productList"\s*:\s*(\[[\s\S]{10,10000}?\])/,
        /"modelList"\s*:\s*(\[[\s\S]{10,10000}?\])/,
        /"products"\s*:\s*(\[[\s\S]{10,10000}?\])/,
        /window\.digitalData\s*=\s*({[\s\S]{50,}?});\s*(?:<\/script>|window\.)/,
      ];
      for (const pat of patterns) {
        const m = html.match(pat);
        if (m) {
          try {
            const obj = JSON.parse(m[1]);
            if (Array.isArray(obj)) {
              for (const item of obj.slice(0, 40)) tryPushItem(item, products, seen, url);
            } else {
              extractDeep(obj, products, seen, url);
            }
          } catch (_) {}
        }
      }

      log('scrape_html_done', { url, newProducts: products.length - before });
    } catch (err) {
      log('scrape_html_error', { url, message: err.message });
    }
    await delay(2000);
  }

  log('scrape_completed', { productsCount: products.length });
  await ping(products.length > 0 ? 'complete' : 'fail', `&metric=count:${products.length}`);
  return products;
}

function extractFromNextData(nd, products, seen, pageUrl) {
  if (!nd) return;
  const pageProps = nd?.props?.pageProps || {};
  const candidates = [
    pageProps.productList, pageProps.modelList, pageProps.products,
    pageProps.data?.productList, pageProps.data?.models, pageProps.data?.modelList,
    pageProps.initialData?.productList, pageProps.initialData?.modelList,
    pageProps.componentProps?.modelList,
  ];
  for (const list of candidates) {
    if (Array.isArray(list) && list.length > 0) {
      for (const item of list.slice(0, 40)) tryPushItem(item, products, seen, pageUrl);
      if (products.length > 0) return;
    }
  }
  extractDeep(pageProps, products, seen, pageUrl);
}

function extractDeep(obj, products, seen, pageUrl, depth = 0) {
  if (!obj || depth > 5 || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj.slice(0, 40)) {
      if (typeof item === 'object') {
        tryPushItem(item, products, seen, pageUrl);
        if (products.length < 30) extractDeep(item, products, seen, pageUrl, depth + 1);
      }
    }
  } else {
    tryPushItem(obj, products, seen, pageUrl);
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
        extractDeep(val, products, seen, pageUrl, depth + 1);
        if (products.length >= 30) return;
      } else if (val && typeof val === 'object' && !Array.isArray(val)) {
        extractDeep(val, products, seen, pageUrl, depth + 1);
      }
    }
  }
}

function extractFromSchema(schema, products, seen, pageUrl) {
  if (!schema) return;
  if (Array.isArray(schema)) { for (const s of schema) extractFromSchema(s, products, seen, pageUrl); return; }
  if (schema['@type'] === 'Product') {
    try {
      const name = (schema.name || '').trim();
      const url = schema.url || pageUrl;
      if (!name || seen.has(url)) return;
      seen.add(url);
      const offer = Array.isArray(schema.offers) ? schema.offers[0] : (schema.offers || {});
      const current = parsePrice(offer.price || 0);
      if (!current) return;
      const original = parsePrice(offer.highPrice || 0);
      if (!original || original <= current) return;
      const discount = Math.round(((original - current) / original) * 100);
      if (discount < 1 || discount > 100) return;
      products.push({
        store: STORE, name: name.substring(0, 120), category: guessCategory(name),
        url: url.startsWith('http') ? url : BASE + url,
        image_url: Array.isArray(schema.image) ? schema.image[0] : (schema.image || ''),
        current_price: current, original_price: original, discount_percent: discount, stock_info: null,
      });
    } catch (_) {}
  }
  if (schema['@graph']) { for (const s of schema['@graph']) extractFromSchema(s, products, seen, pageUrl); }
}

function tryPushItem(item, products, seen, pageUrl) {
  if (!item || typeof item !== 'object') return;
  try {
    const name = (
      item.displayName || item.productName || item.modelName ||
      item.name || item.title || item.productTitle || ''
    ).trim();
    if (!name || name.length < 3) return;

    const modelCode = item.modelCode || item.modelId || item.sku || '';
    const rawPath = item.url || item.pdpUrl || item.productUrl || item.link || '';
    let url;
    if (rawPath.startsWith('http')) url = rawPath;
    else if (rawPath) url = BASE + rawPath;
    else if (modelCode) url = `${BASE}/pe/search/?searchvalue=${encodeURIComponent(modelCode)}`;
    else url = `${BASE}/pe/search/?searchvalue=${encodeURIComponent(name.substring(0, 40))}`;

    if (seen.has(url)) return;
    seen.add(url);

    const current = parsePrice(item.salePrice || item.discountedPrice || item.currentPrice || item.price || item.offerPrice || 0);
    if (!current || current <= 0) return;

    const original = parsePrice(item.regularPrice || item.listPrice || item.originalPrice || item.normalPrice || item.priceBeforeDiscount || 0);
    if (!original || original <= current) return;
    const discount = Math.round(((original - current) / original) * 100);
    if (discount < 1 || discount > 100) return;

    products.push({
      store: STORE, name: name.substring(0, 120), category: guessCategory(name), url,
      image_url: item.thumbUrl || item.imageUrl || item.image || item.thumbnailUrl || '',
      current_price: current, original_price: Math.round(original * 100) / 100,
      discount_percent: discount, stock_info: null,
    });
  } catch (_) {}
}

function parsePrice(val) {
  if (!val) return 0;
  return parseFloat(String(val).replace(/[^\d.]/g, '')) || 0;
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/galaxy s|galaxy a|celular|smartphone/.test(n)) return 'Celulares';
  if (/galaxy tab|tablet/.test(n)) return 'Computación';
  if (/qled|neo qled|oled|frame|tv|televisor/.test(n)) return 'Electrónica';
  if (/galaxy book|laptop/.test(n)) return 'Computación';
  if (/galaxy buds|audifonos|auricular|soundbar/.test(n)) return 'Electrónica';
  if (/lavadora|refrigerador|microondas/.test(n)) return 'Electrohogar';
  return 'Tecnología';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrape, STORE };

if (require.main === module) {
  scrape().then(p => { console.log(`\n--- RESULTADO ---\nProductos: ${p.length}`); console.log(JSON.stringify(p.slice(0, 3), null, 2)); });
}
