'use strict';
const { chromium } = require('playwright');
const { cleanTitle, cleanScene7Url, urlToSku } = require('./utils');
const { readCursor, writeCursor, runWithConcurrency, jitter, BATCH_SIZE } = require('./engine');

const STORE = 'Sodimac';
const BASE  = 'https://www.sodimac.com.pe';
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BLOCKED_TYPES = new Set(['image', 'stylesheet', 'font', 'media']);

// Tracker / analytics domains that keep the network busy without providing
// product data — blocking them prevents networkidle from hanging indefinitely.
const BLOCKED_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'hotjar.com', 'newrelic.com', 'nr-data.net', 'tealiumiq.com',
  'segment.io', 'amplitude.com', 'bat.bing.com', 'omtrdc.net',
  'demdex.net', 'adobedtm.com', 'scorecardresearch.com', 'fbcdn.net',
];

function isTrackerUrl(url) {
  for (const d of BLOCKED_DOMAINS) {
    if (url.includes(d)) return true;
  }
  return false;
}

// Direct category paths — these serve real product grids with __NEXT_DATA__ intact.
// /search?Ntt= routes have inconsistent behaviour on the Falabella-stack Sodimac site.
const CATEGORIAS_BASE = [
  `${BASE}/sodimac-pe/category/cat10020/herramientas-electricas`,
  `${BASE}/sodimac-pe/category/cat10032/pisos`,
  `${BASE}/sodimac-pe/category/cat10048/muebles`,
  `${BASE}/sodimac-pe/category/cat10050/iluminacion`,
  `${BASE}/sodimac-pe/category/cat10154/electrohogar`,
  `${BASE}/sodimac-pe/category/cat10214/banos`,
  `${BASE}/sodimac-pe/category/cat10188/jardin`,
  `${BASE}/sodimac-pe/category/cat10052/pinturas`,
];

// PE localization cookies prevent the Falabella-stack from redirecting to a
// generic landing page instead of serving actual product grids.
const PE_COOKIES = [
  { name: 'userLocation',     value: 'PE',          domain: '.sodimac.com.pe', path: '/' },
  { name: 'locale',           value: 'es_PE',        domain: '.sodimac.com.pe', path: '/' },
  { name: 'region',           value: 'PE',           domain: '.sodimac.com.pe', path: '/' },
  { name: 'currentStoreSlug', value: 'sodimac-pe',   domain: '.sodimac.com.pe', path: '/' },
];

function log(event, data = {}) {
  console.log(JSON.stringify({ level: 'info', store: STORE, event, timestamp: new Date().toISOString(), ...data }));
}

async function scrapeCategory(ctx, categoryUrl) {
  const page = await ctx.newPage();
  try {
    // Block heavy resources AND known trackers — avoids networkidle hangs.
    await page.route('**/*', route => {
      const req = route.request();
      if (BLOCKED_TYPES.has(req.resourceType())) return route.abort();
      if (isTrackerUrl(req.url())) return route.abort();
      return route.continue();
    });

    // Plan A: intercept Falabella-stack internal API calls that carry product JSON.
    const apiProducts = [];
    page.on('response', async resp => {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (!ct.includes('json') || !resp.url().includes('sodimac.com')) return;
        const json = await resp.json().catch(() => null);
        if (json) extractFromApiJson(json, apiProducts);
      } catch (_) {}
    });

    // domcontentloaded is fast; SPA fires API calls shortly after.
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Allow initial XHR calls to resolve without waiting for full network idle.
    await page.waitForTimeout(4000);

    if (apiProducts.length > 0) {
      log('scrape_api_captured', { url: categoryUrl, count: apiProducts.length });
      return apiProducts;
    }

    // Plan B: __NEXT_DATA__ injected by Next.js SSR — no extra wait needed.
    const html = await page.content();
    const nextDataProducts = extractFromNextData(html);
    if (nextDataProducts.length > 0) {
      log('scrape_nextdata_found', { url: categoryUrl, count: nextDataProducts.length });
      return nextDataProducts;
    }

    // Plan C: live DOM evaluation with a short selector timeout as last resort.
    log('scrape_dom_fallback', { url: categoryUrl });
    try {
      await page.waitForSelector('a.pod-link, [data-pod], [class*="pod-link"]', { timeout: 5000 });
    } catch (_) {}

    const domProducts = await page.evaluate(({ base }) => {
      const results = [];
      const seen    = new Set();
      const links   = [
        ...document.querySelectorAll('a.pod-link[href]'),
        ...document.querySelectorAll('[data-pod] a[href]'),
        ...document.querySelectorAll('[class*="pod-link"][href]'),
      ];
      for (const link of links.slice(0, 48)) {
        try {
          const href = link.getAttribute('href') || '';
          const url  = href.startsWith('http') ? href : (href ? base + href : '');
          if (!url || seen.has(url)) continue;
          seen.add(url);

          const pod  = link.closest('[class*="pod"], [data-pod]') || link;
          const name = (
            pod.querySelector('[class*="title"]')?.textContent ||
            pod.querySelector('[class*="name"]')?.textContent  ||
            link.title || ''
          ).trim();
          if (!name || name.length < 3) continue;

          const saleEl  = pod.querySelector('[class*="price-sale"], [class*="sale-price"], [class*="price--sale"]');
          const origEl  = pod.querySelector('[class*="price-crossed"], [class*="crossed"], [class*="price--normal"]');
          const current  = parseFloat((saleEl?.textContent || '').replace(/[^\d,.]/g, '').replace(',', '.')) || 0;
          const original = parseFloat((origEl?.textContent || '').replace(/[^\d,.]/g, '').replace(',', '.')) || 0;
          if (!current || current < 5 || !original || original <= current) continue;

          const discount = Math.round(((original - current) / original) * 100);
          if (discount < 1 || discount > 100) continue;

          const imgEl  = pod.querySelector('img[data-src], img[src]');
          const imgSrc = imgEl?.getAttribute('data-src') || imgEl?.getAttribute('src') || '';
          results.push({ name, url, imgSrc, current, original, discount });
        } catch (_) {}
      }
      return results;
    }, { base: BASE });

    if (domProducts.length === 0) {
      log('scrape_no_products', { url: categoryUrl });
      return [];
    }
    log('scrape_dom_extracted', { url: categoryUrl, count: domProducts.length });
    return domProducts.map(p => ({
      store: STORE, name: p.name.substring(0, 120),
      sku: urlToSku(p.url),
      category: guessCategory(p.name),
      url: p.url,
      image_url: cleanScene7Url(p.imgSrc),
      current_price: p.current,
      original_price: Math.round(p.original * 100) / 100,
      discount_percent: p.discount,
      stock_info: null,
    }));
  } finally {
    await page.close();
  }
}

function extractFromApiJson(json, out) {
  const results = (
    json?.results ||
    json?.data?.results ||
    json?.searchResults?.results ||
    json?.props?.pageProps?.results ||
    []
  );
  if (!Array.isArray(results) || results.length === 0) return;
  for (const item of results.slice(0, 48)) {
    try {
      const name = cleanTitle(item.displayName || '');
      if (!name || name.length < 3) continue;
      const rawUrl = item.url || '';
      if (!rawUrl) continue;
      const prices   = item.prices || [];
      const saleObj  = prices.find(p => !p.crossed);
      const normObj  = prices.find(p =>  p.crossed);
      const current  = parsePrice(saleObj?.price);
      const original = parsePrice(normObj?.price);
      if (!current || !original || original <= current) continue;
      const discount = Math.round(((original - current) / original) * 100);
      if (discount < 1 || discount > 100) continue;
      const fullUrl = rawUrl.startsWith('http') ? rawUrl : BASE + rawUrl;
      out.push({
        store: STORE, name: name.substring(0, 120),
        sku: urlToSku(fullUrl),
        category: guessCategory(name),
        url: fullUrl,
        image_url: cleanScene7Url((item.mediaUrls || [])[0] || ''),
        current_price: current,
        original_price: Math.round(original * 100) / 100,
        discount_percent: discount,
        stock_info: null,
      });
    } catch (_) {}
  }
}

function extractFromNextData(html) {
  const match = html && html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];
  let data;
  try { data = JSON.parse(match[1]); } catch (_) { return []; }
  const pp      = data?.props?.pageProps;
  const results = pp?.results || pp?.searchResults?.results || pp?.initialData?.data?.results || [];
  if (!Array.isArray(results) || results.length === 0) return [];
  const out  = [];
  const seen = new Set();
  for (const item of results) {
    try {
      const name = cleanTitle(item.displayName || '');
      if (!name || name.length < 3) continue;
      const rawUrl = item.url || '';
      if (!rawUrl || seen.has(rawUrl)) continue;
      seen.add(rawUrl);
      const prices   = item.prices || [];
      const saleObj  = prices.find(p => !p.crossed);
      const normObj  = prices.find(p =>  p.crossed);
      const current  = parsePrice(saleObj?.price);
      const original = parsePrice(normObj?.price);
      if (!current || !original || original <= current) continue;
      const discount = Math.round(((original - current) / original) * 100);
      if (discount < 1 || discount > 100) continue;
      const fullUrl = rawUrl.startsWith('http') ? rawUrl : BASE + rawUrl;
      out.push({
        store: STORE, name: name.substring(0, 120),
        sku: urlToSku(fullUrl),
        category: guessCategory(name),
        url: fullUrl,
        image_url: cleanScene7Url((item.mediaUrls || [])[0] || ''),
        current_price: current,
        original_price: Math.round(original * 100) / 100,
        discount_percent: discount,
        stock_info: null,
      });
    } catch (_) {}
  }
  return out;
}

async function scrape() {
  log('scrape_started', {});

  const cursor   = readCursor(STORE);
  const total    = CATEGORIAS_BASE.length;
  const startIdx = cursor.lastCategoryIndex % total;
  const batch    = Array.from({ length: Math.min(BATCH_SIZE, total) }, (_, i) =>
    CATEGORIAS_BASE[(startIdx + i) % total]
  );
  const nextIdx  = (startIdx + BATCH_SIZE) % total;

  console.log(`[${STORE}] Lote progresivo [${startIdx + 1}–${Math.min(startIdx + BATCH_SIZE, total)}] de ${total}`);

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: UA, locale: 'es-PE',
      extraHTTPHeaders: { 'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8' },
    });
    await ctx.addCookies(PE_COOKIES);

    const allProducts = [];
    await runWithConcurrency(batch, 2, async url => {
      try {
        const items = await scrapeCategory(ctx, url);
        log('scrape_category_done', { url, count: items.length });
        allProducts.push(...items);
      } catch (err) {
        log('scrape_category_error', { url, message: err.message });
      }
      await jitter(1500, 1000);
    });

    log('scrape_completed', { productsCount: allProducts.length });
    return allProducts;
  } finally {
    await browser.close();
    writeCursor(STORE, nextIdx);
  }
}

function parsePrice(val) {
  if (!val) return 0;
  if (Array.isArray(val)) val = val[0];
  return parseFloat(String(val).replace(/[^\d.]/g, '')) || 0;
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/pintura|brocha|rodillo/.test(n))                     return 'Construcción';
  if (/taladro|sierra|martillo|llave|herramienta/.test(n))  return 'Herramientas';
  if (/sofa|cama|colchon|mesa|silla|mueble|closet/.test(n)) return 'Muebles';
  if (/jardin|planta|maceta|manguera/.test(n))              return 'Jardín';
  if (/lavadora|refriger|cocina|horno|microond/.test(n))    return 'Electrohogar';
  if (/lamp|foco|iluminacion/.test(n))                      return 'Iluminación';
  if (/piso|ceramica|porcelanato/.test(n))                  return 'Pisos';
  if (/tv|televisor|smart tv/.test(n))                      return 'Electrónica';
  return 'Hogar';
}

module.exports = { scrape, STORE };

if (require.main === module) {
  scrape()
    .then(p => { console.log(`\n--- RESULTADO ---\nProductos: ${p.length}`); console.log(JSON.stringify(p.slice(0, 3), null, 2)); })
    .catch(err => { console.error('Error:', err.message); process.exit(1); });
}
