'use strict';
const { chromium } = require('playwright');
const { cleanTitle, cleanScene7Url, urlToSku } = require('./utils');
const { readCursor, writeCursor, runWithConcurrency, jitter, BATCH_SIZE } = require('./engine');

const STORE = 'Sodimac';
const BASE  = 'https://www.sodimac.com.pe';
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Direct category paths — validated to serve real product grids on the Falabella stack.
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

// PE localization cookies keep the Falabella-stack from serving a generic hub page.
const PE_COOKIES = [
  { name: 'userLocation',     value: 'PE',          domain: '.sodimac.com.pe', path: '/' },
  { name: 'locale',           value: 'es_PE',        domain: '.sodimac.com.pe', path: '/' },
  { name: 'region',           value: 'PE',           domain: '.sodimac.com.pe', path: '/' },
  { name: 'currentStoreSlug', value: 'sodimac-pe',   domain: '.sodimac.com.pe', path: '/' },
];

// Injected into the browser sandbox via addInitScript before any page script runs.
// Hides the webdriver fingerprint and monkey-patches fetch + XHR so every JSON
// response is inspected for product arrays and stored in window.__HUNT_DATA__.
const INIT_SCRIPT = `(function () {
  // ── Stealth ──────────────────────────────────────────────────────────────
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // ── Shared storage ───────────────────────────────────────────────────────
  window.__HUNT_DATA__ = null;

  function tryStore(json) {
    if (!json || typeof json !== 'object' || window.__HUNT_DATA__) return;
    // Known Falabella-stack REST shapes
    var candidates = [
      json.results,
      json.data && json.data.results,
      json.searchResults && json.searchResults.results,
      json.props && json.props.pageProps && json.props.pageProps.results,
    ];
    // GraphQL: walk json.data.* one level deep
    if (json.data && typeof json.data === 'object') {
      Object.values(json.data).forEach(function (node) {
        if (!node || typeof node !== 'object') return;
        var arr = node.results ||
                  (node.products && node.products.results) ||
                  node.items;
        if (arr) candidates.push(arr);
      });
    }
    for (var i = 0; i < candidates.length; i++) {
      var arr = candidates[i];
      if (Array.isArray(arr) && arr.length >= 4 &&
          arr[0] && (arr[0].displayName || arr[0].url)) {
        window.__HUNT_DATA__ = arr;
        return;
      }
    }
  }

  // ── fetch monkey-patch ───────────────────────────────────────────────────
  var _fetch = window.fetch;
  window.fetch = function () {
    var args = arguments;
    return _fetch.apply(this, args).then(function (resp) {
      try {
        var ct = resp.headers.get('content-type') || '';
        if (ct.indexOf('json') !== -1) {
          resp.clone().json().then(tryStore).catch(function () {});
        }
      } catch (_) {}
      return resp;
    });
  };

  // ── XMLHttpRequest monkey-patch ──────────────────────────────────────────
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__hurl__ = String(url || '');
    return _open.apply(this, arguments);
  };
  var _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        var ct = this.getResponseHeader('content-type') || '';
        if (ct.indexOf('json') === -1) return;
        tryStore(JSON.parse(this.responseText));
      } catch (_) {}
    });
    return _send.apply(this, arguments);
  };
})();`;

function log(event, data = {}) {
  console.log(JSON.stringify({ level: 'info', store: STORE, event, timestamp: new Date().toISOString(), ...data }));
}

async function scrapeCategory(ctx, categoryUrl) {
  const page = await ctx.newPage();
  try {
    // Inject stealth + spy before any page script loads.
    await page.addInitScript(INIT_SCRIPT);

    // No resource blocking — all scripts must run so the spy can intercept API calls.
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Block until the spy captures product data OR SSR __NEXT_DATA__ is present (max 15 s).
    await page.waitForFunction(() => {
      if (window.__HUNT_DATA__ && window.__HUNT_DATA__.length >= 4) return true;
      return !!document.getElementById('__NEXT_DATA__');
    }, { timeout: 15000 }).catch(() => {});

    // ── Priority 1: spy-intercepted API / GraphQL data ──────────────────────
    const huntItems = await page.evaluate(() => window.__HUNT_DATA__);
    if (Array.isArray(huntItems) && huntItems.length > 0) {
      const products = [];
      for (const item of huntItems.slice(0, 48)) extractSodimacItem(item, products);
      if (products.length > 0) {
        log('scrape_hunt_captured', { url: categoryUrl, count: products.length });
        return products;
      }
    }

    // ── Priority 2: SSR __NEXT_DATA__ embedded in the initial HTML ──────────
    const rawNextData = await page.evaluate(() => {
      try {
        const el = document.getElementById('__NEXT_DATA__');
        return el ? JSON.parse(el.textContent) : null;
      } catch (_) { return null; }
    });
    if (rawNextData) {
      const pp      = rawNextData?.props?.pageProps;
      const results = pp?.results || pp?.searchResults?.results || pp?.initialData?.data?.results || [];
      if (Array.isArray(results) && results.length > 0) {
        const products = [];
        for (const item of results) extractSodimacItem(item, products);
        if (products.length > 0) {
          log('scrape_nextdata_found', { url: categoryUrl, count: products.length });
          return products;
        }
      }
    }

    log('scrape_no_products', { url: categoryUrl });
    return [];
  } finally {
    await page.close();
  }
}

function extractSodimacItem(item, out) {
  try {
    const name = cleanTitle(item.displayName || '');
    if (!name || name.length < 3) return;
    const rawUrl = item.url || '';
    if (!rawUrl) return;
    const prices   = item.prices || [];
    const saleObj  = prices.find(p => !p.crossed);
    const normObj  = prices.find(p =>  p.crossed);
    const current  = parsePrice(saleObj?.price);
    const original = parsePrice(normObj?.price);
    if (!current || !original || original <= current) return;
    const discount = Math.round(((original - current) / original) * 100);
    if (discount < 1 || discount > 100) return;
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
