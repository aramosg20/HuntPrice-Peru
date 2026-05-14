'use strict';
/**
 * Falabella PE — Enterprise hybrid scraper (Playwright)
 *
 * Extraction strategy (applied in priority order per category):
 *
 *   A  Network interception  — captures XHR/Fetch JSON carrying product lists
 *      before the DOM even renders; yields clean API-native objects.
 *
 *   B  __NEXT_DATA__ parsing — the Next.js SSR state embedded in the HTML
 *      script tag is available immediately after DOMContentLoaded, no render
 *      needed. This is the primary path for page 1.
 *
 *   C  DOM fallback           — $$eval on product-card selectors when A+B
 *      both yield nothing (e.g. page structure changed).
 *
 * Pagination uses the Next.js /_next/data/{buildId}/*.json API so pages 2-N
 * are a single lightweight JSON fetch from inside the browser context
 * (inherits session cookies), not a full navigation.
 *
 * Category discovery: navigates to the homepage and extracts macro-category
 * hrefs from the nav DOM and/or __NEXT_DATA__ nav tree. Falls back to a
 * hardcoded seed list if the site structure changes.
 */

const { chromium } = require('playwright');
const { cleanTitle, urlToSku, cleanScene7Url } = require('./utils');

const STORE           = 'Falabella';
const BASE            = 'https://www.falabella.com.pe';
const MAX_PAGES       = 50;  // safety cap: pages per category
const MIN_DISCOUNT    = 5;   // % — skip trivial deals
const PAGE_SIZE       = 24;  // Falabella's default products-per-page
const CAT_CONCURRENCY = 3;   // categories scraped in parallel

// ── Mandatory categories ──────────────────────────────────────────────────────
// Always merged with dynamically-discovered paths so these areas can never
// be dropped by a discovery failure or URL-pattern change.
const MANDATORY_PATHS = [
  // Deal hubs
  '/falabella-pe/collection/descuentos',
  '/falabella-pe/collection/descuentos-cmr',
  // Main macro-categories (verified IDs)
  '/falabella-pe/category/cat6290005/Tecnologia',
  '/falabella-pe/category/cat6290004/Electrohogar',
  '/falabella-pe/category/cat6290001/Moda',
  '/falabella-pe/category/cat6290007/Muebles-y-Deco',
  '/falabella-pe/category/cat6290008/Deportes',
  '/falabella-pe/category/cat6290009/Mundo-Bebe',
  '/falabella-pe/category/cat6290002/Belleza',
  '/falabella-pe/category/cat6290006/Computacion',
  // High-value sub-areas that get missed when discovery caps early
  '/falabella-pe/category/cat6290003/Ninos',
  '/falabella-pe/category/cat6290010/Hogar',
  '/falabella-pe/collection/dormitorio',
  '/falabella-pe/collection/mundo-bebe',
  '/falabella-pe/collection/muebles',
  '/falabella-pe/collection/organizacion',
  '/falabella-pe/collection/colchones',
  '/falabella-pe/collection/comodas-y-cambiadores',
];

// ── Resource blocking ─────────────────────────────────────────────────────────
// Abort heavy/irrelevant resource types to cut memory usage by ~80 %.
const ABORT_TYPES   = new Set(['image', 'stylesheet', 'font', 'media']);
const ABORT_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'facebook.com',
  'doubleclick.net', 'hotjar.com', 'crazyegg.com', 'newrelic.com',
  'dynatrace.com', 'tealiumiq.com', 'bluecore.com', 'segment.io',
  'sharethis.com', 'addthis.com',
];

// ── Main entry point ──────────────────────────────────────────────────────────
async function scrape() {
  const products = [];
  const seen     = new Set();
  let   browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--disable-gpu',
        '--disable-extensions',
        '--blink-settings=imagesEnabled=false',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale:    'es-PE',
      viewport:  { width: 1280, height: 800 },
    });

    // Step 1 — discover category paths (dynamic) ───────────────────────────
    const paths = await discoverCategories(context);
    console.log(`[${STORE}] ${paths.length} categorías a procesar`);

    // Step 2 — scrape categories in batches of CAT_CONCURRENCY ─────────────
    for (let i = 0; i < paths.length; i += CAT_CONCURRENCY) {
      const chunk   = paths.slice(i, i + CAT_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map(catPath =>
          scrapeCategory(context, BASE + catPath, seen)
            .then(batch => ({ catPath, batch }))
        )
      );
      for (const res of settled) {
        if (res.status === 'fulfilled') {
          const { catPath, batch } = res.value;
          products.push(...batch);
          console.log(`[${STORE}] ${catPath} → ${batch.length} prods (acum. ${products.length})`);
        } else {
          console.error(`[${STORE}] Error en categoría: ${res.reason?.message}`);
        }
      }
      if (i + CAT_CONCURRENCY < paths.length) {
        await delay(2000 + Math.random() * 1500);
      }
    }

  } catch (err) {
    console.error(`[${STORE}] Fatal — ${err.message}`);
    // Graceful fallback: if Chromium isn't installed, use the legacy axios scraper
    if (err.message.includes('Executable doesn') || err.message.includes('browser')) {
      console.warn(`[${STORE}] Fallback al scraper legacy (ejecuta: npx playwright install chromium)`);
      try {
        return require('./falabella').scrape();
      } catch (_) {}
    }
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }

  console.log(`[${STORE}] Scrape completo — ${products.length} productos`);
  return products;
}

// ── Category auto-discovery ───────────────────────────────────────────────────
async function discoverCategories(context) {
  const page = await openPage(context);
  try {
    await page.goto(`${BASE}/falabella-pe`, {
      waitUntil: 'domcontentloaded',
      timeout:   30000,
    });

    // Attempt A: __NEXT_DATA__ nav tree ─────────────────────────────────────
    const nd       = await extractNextData(page);
    const navPaths = navPathsFromNextData(nd);
    if (navPaths.length >= 4) {
      console.log(`[${STORE}] Discovery via __NEXT_DATA__: ${navPaths.length} paths`);
      const merged = dedupe([...MANDATORY_PATHS, ...navPaths]);
      console.log(`[${STORE}] Total tras fusión con obligatorias: ${merged.length} paths`);
      return merged;
    }

    // Attempt B: crawl <a href> links in nav DOM ────────────────────────────
    const domPaths = await page.$$eval('a[href]', anchors =>
      anchors
        .map(a => a.getAttribute('href') || '')
        .filter(h => (h.includes('/category/') || h.includes('/collection/')) && !h.includes('/product/'))
        .map(h => {
          try { return new URL(h, 'https://www.falabella.com.pe').pathname; }
          catch (_) { return h.startsWith('/') ? h : null; }
        })
        .filter(Boolean)
    ).catch(() => []);

    if (domPaths.length >= 2) {
      console.log(`[${STORE}] Discovery via DOM: ${domPaths.length} paths`);
      const merged = dedupe([...MANDATORY_PATHS, ...domPaths]);
      console.log(`[${STORE}] Total tras fusión con obligatorias: ${merged.length} paths`);
      return merged;
    }

  } catch (err) {
    console.error(`[${STORE}] Auto-discovery error: ${err.message}`);
  } finally {
    try { await page.close(); } catch (_) {}
  }

  console.warn(`[${STORE}] Discovery falló — usando paths obligatorios`);
  return MANDATORY_PATHS;
}

/** Walk known key paths in __NEXT_DATA__ looking for nav/category arrays (3 levels deep). */
function navPathsFromNextData(nd) {
  if (!nd) return [];
  const paths  = [];
  const pp     = nd?.props?.pageProps || {};
  const navRoots = [
    pp?.header?.menuCategories,
    pp?.header?.categories,
    pp?.menuItems,
    pp?.categories,
    pp?.navItems,
  ];
  for (const root of navRoots) {
    if (!Array.isArray(root)) continue;
    for (const item of root) {
      const p = toPathname(item?.url || item?.path || item?.href || '');
      if (isValidCategoryPath(p)) paths.push(p);
      const children = item?.children || item?.subcategories || [];
      for (const child of children) {
        const cp = toPathname(child?.url || child?.path || '');
        if (isValidCategoryPath(cp)) paths.push(cp);
        // Level 3: e.g. Mundo Bebé → Dormitorio Bebé → Cómodas y Cambiadores
        const grandchildren = child?.children || child?.subcategories || [];
        for (const grand of grandchildren) {
          const gp = toPathname(grand?.url || grand?.path || '');
          if (isValidCategoryPath(gp)) paths.push(gp);
        }
      }
    }
  }
  return paths;
}

// ── Per-category scraper ──────────────────────────────────────────────────────
async function scrapeCategory(context, categoryUrl, seen) {
  const products    = [];
  const intercepted = [];
  const page        = await openPage(context);

  // Level A: register BEFORE goto() to capture page-1 API responses
  const onResponse = async response => {
    try {
      const url = response.url();
      if (!url.includes('falabella.com')) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const isListingApi =
        url.includes('/s/browse/')     ||
        url.includes('/api/listing')   ||
        url.includes('catalog-detail') ||
        url.includes('search/v1')      ||
        url.includes('listing-page');
      if (!isListingApi) return;
      const json = await response.json().catch(() => null);
      if (json) intercepted.push(json);
    } catch (_) {}
  };
  page.on('response', onResponse);

  try {
    // ── Page 1: full navigation ────────────────────────────────────────────
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const nd      = await extractNextData(page);
    const buildId = nd?.buildId || null;
    let rawItems  = resultsFromNd(nd);

    // Level A: prefer intercepted API data if richer than __NEXT_DATA__
    if (intercepted.length > 0) {
      for (const data of intercepted) {
        const apiItems = resultsFromApiResponse(data);
        if (apiItems.length > rawItems.length) rawItems = apiItems;
      }
    }

    // Level C: DOM fallback
    if (rawItems.length === 0) {
      console.warn(`[${STORE}] Fallback DOM en ${categoryUrl}`);
      rawItems = await extractFromDom(page, categoryUrl);
    }

    parseAndAdd(rawItems, products, seen, categoryUrl);
    const p1Count = rawItems.length;

    // Nothing on page 1 → skip pagination
    if (p1Count === 0) return products;

    // ── Multi-strategy pagination ──────────────────────────────────────────
    // Upper bound: use totalCount when known; otherwise probe until empty.
    // NEVER gate on total > p1Count — totalCount can be 0 if pageProps shape
    // is unknown, which was silently skipping pagination on every category.
    const total    = totalCountFromNd(nd);
    const maxPages = total > 0
      ? Math.min(Math.ceil(total / PAGE_SIZE), MAX_PAGES)
      : MAX_PAGES;

    if (buildId) {
      // Strategy A: _next/data lightweight fetches (no page navigation)
      const gotMore = await paginateViaNextData(page, categoryUrl, buildId, maxPages, products, seen);
      if (!gotMore) {
        // _next/data returned nothing → fall back to ?page=N URL navigation
        await paginateViaUrl(page, categoryUrl, maxPages, products, seen);
      }
    } else {
      // No buildId → go straight to URL-based pagination
      await paginateViaUrl(page, categoryUrl, maxPages, products, seen);
    }

  } finally {
    page.removeListener('response', onResponse);
    try { await page.close(); } catch (_) {}
  }

  return products;
}

/**
 * Fast pagination via Next.js /_next/data/{buildId}/path.json?page=N
 * Fetched from inside the browser context (inherits cookies + TLS fingerprint).
 * Returns true if at least one additional page was retrieved.
 */
async function paginateViaNextData(page, categoryUrl, buildId, maxPages, products, seen) {
  const urlObj = new URL(categoryUrl);
  const ndPath = urlObj.pathname.replace(/\/$/, '') + '.json';
  const ndBase = `${urlObj.origin}/_next/data/${buildId}${ndPath}`;
  let   gotAny = false;

  for (let p = 2; p <= maxPages; p += 3) {
    const batch    = [p, p + 1, p + 2].filter(n => n <= maxPages);
    const fetched  = await Promise.all(batch.map(n => fetchNdPage(page, ndBase, n)));
    let   batchHit = false;

    for (const pData of fetched) {
      const pItems = resultsFromNd(pData);
      if (pItems.length === 0) continue;
      batchHit = true;
      gotAny   = true;
      parseAndAdd(pItems, products, seen, categoryUrl);
    }

    if (!batchHit) break; // consecutive empty batch → natural end of catalog
    console.log(`  [${STORE}] nd p${batch[0]}–${batch[batch.length - 1]} → ${products.length} acum.`);
    await delay(600 + Math.random() * 400);
  }

  return gotAny;
}

/**
 * URL-based pagination: navigates to categoryUrl?page=N, extracts __NEXT_DATA__
 * (or DOM fallback). Used when buildId is unavailable or _next/data returns nothing.
 */
async function paginateViaUrl(page, categoryUrl, maxPages, products, seen) {
  const baseUrl = categoryUrl.split('?')[0];

  for (let p = 2; p <= maxPages; p++) {
    const pageUrl = `${baseUrl}?page=${p}`;
    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      const nd = await extractNextData(page);
      let pItems = resultsFromNd(nd);
      if (pItems.length === 0) pItems = await extractFromDom(page, pageUrl);
      if (pItems.length === 0) break; // natural end of catalog
      parseAndAdd(pItems, products, seen, categoryUrl);
      console.log(`  [${STORE}] ?page=${p} → ${products.length} acum.`);
      await delay(1500 + Math.random() * 1000);
    } catch (err) {
      console.error(`  [${STORE}] Error pag. URL p${p}: ${err.message}`);
      break;
    }
  }
}

// ── Data extraction helpers ───────────────────────────────────────────────────

/** Read and parse the __NEXT_DATA__ JSON embedded in the page HTML. */
async function extractNextData(page) {
  try {
    return await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      try { return JSON.parse(el.textContent); } catch (_) { return null; }
    });
  } catch (_) { return null; }
}

/** Try all known paths where Falabella puts the products array in pageProps. */
function resultsFromNd(nd) {
  if (!nd) return [];
  const pp = nd?.props?.pageProps;
  if (!pp) return [];
  return pp.results
      || pp.searchResults?.results
      || pp.initialData?.results
      || pp.data?.results
      || pp.pageData?.results
      || pp.listingData?.results
      || [];
}

function totalCountFromNd(nd) {
  if (!nd) return 0;
  const pp = nd?.props?.pageProps;
  if (!pp) return 0;
  return pp.totalCount
      || pp.pagination?.total
      || pp.pagination?.count
      || pp.searchResults?.pagination?.total
      || pp.pageData?.pagination?.total
      || 0;
}

/** Try common shapes returned by Falabella's internal listing APIs. */
function resultsFromApiResponse(data) {
  return data?.data?.results
      || data?.results
      || data?.products
      || data?.data?.products
      || data?.response?.products
      || data?.data?.items
      || [];
}

/**
 * Fetch a paginated Next.js data endpoint from inside the browser context.
 * Using page.evaluate's fetch() inherits session cookies and the correct
 * Chromium TLS fingerprint — no extra HTTP client needed.
 */
async function fetchNdPage(page, ndBase, pageNum) {
  const url = `${ndBase}?page=${pageNum}`;
  try {
    return await page.evaluate(async fetchUrl => {
      try {
        const r = await fetch(fetchUrl, {
          headers: { 'x-nextjs-data': '1', Accept: 'application/json' },
          credentials: 'include',
        });
        if (!r.ok) return null;
        return r.json();
      } catch (_) { return null; }
    }, url);
  } catch (_) { return null; }
}

/** Level C fallback: scrape product card DOM elements directly. */
async function extractFromDom(page, sourceUrl) {
  try {
    await page.waitForSelector(
      '[class*="pod"][class*="sku"], .pod--sku, [data-pod="pod"]',
      { timeout: 5000 }
    ).catch(() => {});

    return await page.$$eval(
      '[class*="pod"][class*="sku"], .pod--sku, [data-pod="pod"]',
      (cards, src) => cards.map(card => {
        const nameEl    = card.querySelector('[class*="pod-title"], [class*="pod-header"]');
        const priceEl   = card.querySelector('[class*="buy-price"], [class*="price--best"], [class*="subprice__bulk"]');
        const origEl    = card.querySelector('[class*="crossed"], [class*="normal-price"]');
        const imgEl     = card.querySelector('img[src], img[data-src]');
        const linkEl    = card.querySelector('a[href*="/product/"]');
        return {
          displayName: nameEl?.textContent?.trim() || '',
          prices: [
            origEl?.textContent  ? { label: 'normal',  price: [origEl.textContent.trim()],   crossed: true  } : null,
            priceEl?.textContent ? { label: 'oferta',  price: [priceEl.textContent.trim()],  crossed: false } : null,
          ].filter(Boolean),
          mediaUrls: [imgEl?.src || imgEl?.dataset?.src || ''].filter(Boolean),
          url: linkEl ? new URL(linkEl.href, 'https://www.falabella.com.pe').href : src,
        };
      }),
      sourceUrl
    ).catch(() => []);
  } catch (_) { return []; }
}

// ── Price extraction ──────────────────────────────────────────────────────────

/**
 * Extract (original, current) prices from Falabella's prices array.
 *
 * Falabella price shapes (crossed=true → original/tachado):
 *   { label: 'Precio normal', price: ['S/ 1,299.90'], crossed: true  }
 *   { label: 'Precio oferta', price: ['S/ 999.90'],   crossed: false }
 *   { label: 'Con CMR',       price: ['S/ 899.90'],   crossed: false }
 *
 * Rule: current_price = MIN of all active (non-crossed) prices so that the
 * CMR/card price is used when present — it's the actual checkout price.
 */
function extractPrices(prices = []) {
  const crossed = [];
  const active  = [];
  for (const p of prices) {
    const vals = (p.price || []).map(parsePrice).filter(v => v > 0);
    (p.crossed ? crossed : active).push(...vals);
  }
  const original = crossed.length ? Math.max(...crossed) : 0;
  const current  = active.length  ? Math.min(...active)  : 0;
  return { original, current };
}

function parsePrice(str) {
  if (str == null) return 0;
  return parseFloat(String(str).replace(/[^\d.]/g, '')) || 0;
}

// ── Product normalizer ────────────────────────────────────────────────────────

function parseAndAdd(rawItems, out, seen, catUrl) {
  for (const item of rawItems) {
    try {
      const name = cleanTitle(item.displayName || item.name || '');
      if (!name || name.length < 3) continue;

      const { current, original } = extractPrices(item.prices || []);
      if (!current || current <= 0) continue;

      const effectiveOrig  = original > current
        ? original
        : Math.round(current * 1.3); // synthesise if only sale price present
      const discountPct    = Math.round(((effectiveOrig - current) / effectiveOrig) * 100);
      if (discountPct < MIN_DISCOUNT) continue;

      const productUrl = item.url || catUrl;
      if (!productUrl || seen.has(productUrl)) continue;
      seen.add(productUrl);

      const sku      = String(item.id || item.skuId || '').trim() || urlToSku(productUrl);
      const rawImg   = (item.mediaUrls || [])[0] || (item.images || [])[0]?.url || '';
      const imageUrl = cleanScene7Url(rawImg);

      out.push({
        store:            STORE,
        name:             name.substring(0, 120),
        sku,
        category:         guessCategory(name, catUrl),
        url:              productUrl,
        image_url:        imageUrl,
        current_price:    current,
        original_price:   effectiveOrig,
        discount_percent: discountPct,
        stock_info:       null,
      });
    } catch (_) {}
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Open a new page with resource blocking already configured. */
async function openPage(context) {
  const page = await context.newPage();
  await page.route('**/*', route => {
    const req  = route.request();
    const type = req.resourceType();
    const url  = req.url();
    if (ABORT_TYPES.has(type))                            return route.abort();
    if (ABORT_DOMAINS.some(d => url.includes(d)))        return route.abort();
    route.continue();
  });
  return page;
}

function dedupe(paths) {
  return [...new Set(paths)];
}

function toPathname(href) {
  if (!href) return '';
  try { return new URL(href, BASE).pathname; } catch (_) { return href.startsWith('/') ? href : ''; }
}

function isValidCategoryPath(p) {
  if (!p) return false;
  return (p.includes('/category/') || p.includes('/collection/')) && !p.includes('/product/');
}

function guessCategory(name, url = '') {
  const n = (name + ' ' + url).toLowerCase();
  if (/\btv\b|televisor|pantalla|monitor|led\b|qled|oled/.test(n)) return 'Electrónica';
  if (/laptop|notebook|computador|tablet|ipad/.test(n))             return 'Computación';
  if (/celular|smartphone|iphone|galaxy/.test(n))                   return 'Celulares';
  if (/refriger|lavadora|secadora|microond|cocina|horno/.test(n))   return 'Electrohogar';
  if (/zapatill|zapato|ropa|polo|camisa|pantalon|vestido/.test(n))  return 'Moda';
  if (/juguete|lego|muñeca|juego|bebe|bebé/.test(n))               return 'Juguetes';
  if (/sofa|sofá|cama|colchón|mesa|silla|mueble/.test(n))          return 'Muebles';
  if (/perfume|crema|maquillaje|labial|belleza/.test(n))            return 'Belleza';
  if (/bicicleta|pesa|deporte|tenis|camping/.test(n))               return 'Deportes';
  return 'Hogar';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrape, STORE };
