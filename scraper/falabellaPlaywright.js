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
 *   C  DOM fallback          — $$eval on product-card selectors when A+B
 *      both yield nothing (e.g. page structure changed).
 *
 * Modes:
 *   fast (default) — MANDATORY_PATHS only, max 5 pages/cat, ~3-5 min total.
 *                    Designed for the every-15-min cron job.
 *   full           — all discovered categories, max 50 pages/cat, ~30-60 min.
 *                    Designed for the nightly deep-crawl.
 *
 * Polite scraping:
 *   - Queue-based concurrency pool (2 workers), never bursts more than 2
 *     simultaneous page loads.
 *   - Randomised inter-page and inter-category delays calibrated per mode.
 *   - User-Agent rotated from a pool of 5 real browser signatures.
 *   - All images/fonts/styles/analytics blocked — ~80 % memory saving.
 */

const { chromium } = require('playwright');
const { cleanTitle, urlToSku, cleanScene7Url } = require('./utils');

const STORE            = 'Falabella';
const BASE             = 'https://www.falabella.com.pe';
const MAX_PAGES_FAST   = 5;   // fast mode: cap per category (cron every 15 min)
const MAX_PAGES_FULL   = 50;  // full mode: cap per category (nightly deep-crawl)
const CAT_CONCURRENCY  = 2;   // max parallel categories — polite scraping
const MIN_DISCOUNT     = 5;   // % — skip trivial deals
const PAGE_SIZE        = 24;  // Falabella's default products-per-page

// ── User-Agent pool ────────────────────────────────────────────────────────────
// Rotated per scrape run so repeated calls don't share an identical fingerprint.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

// ── Mandatory categories ───────────────────────────────────────────────────────
// Scanned in BOTH modes. Fast mode uses ONLY this list (skips discovery).
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
  // High-value sub-areas
  '/falabella-pe/category/cat6290003/Ninos',
  '/falabella-pe/category/cat6290010/Hogar',
  '/falabella-pe/collection/dormitorio',
  '/falabella-pe/collection/mundo-bebe',
  '/falabella-pe/collection/muebles',
  '/falabella-pe/collection/organizacion',
  '/falabella-pe/collection/colchones',
  '/falabella-pe/collection/comodas-y-cambiadores',
];

// ── Resource blocking ──────────────────────────────────────────────────────────
const ABORT_TYPES   = new Set(['image', 'stylesheet', 'font', 'media']);
const ABORT_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'facebook.com',
  'doubleclick.net', 'hotjar.com', 'crazyegg.com', 'newrelic.com',
  'dynatrace.com', 'tealiumiq.com', 'bluecore.com', 'segment.io',
  'sharethis.com', 'addthis.com',
];

// ── Main entry point ───────────────────────────────────────────────────────────
/**
 * @param {'fast'|'full'} mode
 *   'fast' (default) — MANDATORY_PATHS, max 5 pages/cat. For cron every 15 min.
 *   'full'           — all discovered categories, max 50 pages/cat. For nightly.
 */
async function scrape(mode = 'fast') {
  const products       = [];
  const seen           = new Set();
  const maxPagesPerCat = mode === 'full' ? MAX_PAGES_FULL : MAX_PAGES_FAST;
  let   browser;

  console.log(`[${STORE}] Modo: ${mode.toUpperCase()} — máx ${maxPagesPerCat} pág/cat, ${CAT_CONCURRENCY} workers`);

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
      userAgent: pickUa(),
      locale:    'es-PE',
      viewport:  { width: 1280, height: 800 },
    });

    // Fast mode skips discovery and uses the known-good mandatory list directly,
    // saving one extra homepage navigation per cron run.
    const paths = mode === 'full'
      ? await discoverCategories(context)
      : MANDATORY_PATHS;
    console.log(`[${STORE}] ${paths.length} categorías a procesar`);

    // Queue-based worker pool — CAT_CONCURRENCY workers pull from a shared queue.
    // Unlike batch Promise.allSettled, idle workers immediately pick up the next
    // task without waiting for the slowest sibling in the batch.
    await runWithConcurrency(paths, CAT_CONCURRENCY, async catPath => {
      const catUrl = BASE + catPath;
      try {
        const batch = await scrapeCategory(context, catUrl, seen, maxPagesPerCat, mode);
        // push is synchronous — safe under JS single-threaded concurrency
        products.push(...batch);
        console.log(`[${STORE}] ${catPath} → ${batch.length} prods (acum. ${products.length})`);
      } catch (err) {
        console.error(`[${STORE}] Error en ${catPath}: ${err.message}`);
      }
      // Polite inter-category pause before this worker picks up the next path
      await (mode === 'full' ? jitter(4000, 4000) : jitter(2500, 2500));
    });

  } catch (err) {
    console.error(`[${STORE}] Fatal — ${err.message}`);
    if (err.message.includes('Executable doesn') || err.message.includes('browser')) {
      console.warn(`[${STORE}] Fallback al scraper legacy (npx playwright install chromium)`);
      try { return require('./falabella').scrape(); } catch (_) {}
    }
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }

  console.log(`[${STORE}] Scrape completo — ${products.length} productos`);
  return products;
}

// ── Category auto-discovery ────────────────────────────────────────────────────
async function discoverCategories(context) {
  const page = await openPage(context);
  try {
    await page.goto(`${BASE}/falabella-pe`, {
      waitUntil: 'domcontentloaded',
      timeout:   30000,
    });

    // Attempt A: __NEXT_DATA__ nav tree ────────────────────────────────────
    const nd       = await extractNextData(page);
    const navPaths = navPathsFromNextData(nd);
    if (navPaths.length >= 4) {
      console.log(`[${STORE}] Discovery via __NEXT_DATA__: ${navPaths.length} paths`);
      const merged = dedupe([...MANDATORY_PATHS, ...navPaths]);
      console.log(`[${STORE}] Total tras fusión: ${merged.length} paths`);
      return merged;
    }

    // Attempt B: crawl <a href> links in the full page DOM ─────────────────
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
      console.log(`[${STORE}] Total tras fusión: ${merged.length} paths`);
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
  const paths    = [];
  const pp       = nd?.props?.pageProps || {};
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
        for (const grand of child?.children || child?.subcategories || []) {
          const gp = toPathname(grand?.url || grand?.path || '');
          if (isValidCategoryPath(gp)) paths.push(gp);
        }
      }
    }
  }
  return paths;
}

// ── Per-category scraper ───────────────────────────────────────────────────────
async function scrapeCategory(context, categoryUrl, seen, maxPagesPerCat, mode) {
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
        url.includes('/s/browse/')        ||
        url.includes('/s/search')         ||
        url.includes('/api/listing')      ||
        url.includes('/api/products')     ||
        url.includes('/api/catalog')      ||
        url.includes('catalog-detail')    ||
        url.includes('search/v1')         ||
        url.includes('listing-page')      ||
        url.includes('/products/search')  ||
        // Catch-all for Falabella's versioned internal listing APIs
        (url.includes('falabella.com') && /\/v\d+\/(product|catalog|listing|search)/.test(url));
      if (!isListingApi) return;
      const json = await response.json().catch(() => null);
      if (json) intercepted.push(json);
    } catch (_) {}
  };
  page.on('response', onResponse);

  try {
    // ── Page 1: full navigation ─────────────────────────────────────────────
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // /category/ pages hydrate the product grid client-side after SSR.
    // Wait up to 8 s for any recognisable pod element before reading the DOM.
    if (categoryUrl.includes('/category/')) {
      await page.waitForSelector(
        '[data-pod], [class*="pod-capsule"], [class*="pod--sku"], [class*="grid-pod"]',
        { timeout: 8000 }
      ).catch(() => {});
    }

    const nd      = await extractNextData(page);
    const buildId = nd?.buildId || null;
    let rawItems  = resultsFromNd(nd);          // Level B: __NEXT_DATA__

    // Level A: prefer intercepted API data if richer than __NEXT_DATA__
    if (intercepted.length > 0) {
      for (const data of intercepted) {
        const apiItems = resultsFromApiResponse(data);
        if (apiItems.length > rawItems.length) rawItems = apiItems;
      }
    }

    // Level C: DOM extraction
    if (rawItems.length === 0) {
      rawItems = await extractFromDom(page, categoryUrl);
    }

    // Diagnostics — explain exactly WHY we got nothing before giving up
    if (rawItems.length === 0) {
      const pp         = nd?.props?.pageProps || {};
      const ppKeys     = Object.keys(pp).slice(0, 15).join(', ') || '(sin pageProps)';
      const currentUrl = page.url();
      const isCaptcha  = /captcha|challenge|robot/i.test(currentUrl);
      console.warn(
        `[${STORE}] 0 items | ruta: ${new URL(categoryUrl).pathname} | ` +
        `pageProps keys: [${ppKeys}] | XHR: ${intercepted.length} | ` +
        (isCaptcha ? '⚠ CAPTCHA detectado' : `url actual: ${currentUrl.slice(0, 80)}`)
      );
    }

    parseAndAdd(rawItems, products, seen, categoryUrl);
    const p1Count = rawItems.length;

    if (p1Count === 0) return products; // nothing on page 1 → skip pagination

    // ── Multi-strategy pagination ───────────────────────────────────────────
    // Upper bound: use totalCount when known; otherwise probe until empty.
    // maxPagesPerCat is the per-mode safety cap (5 fast / 50 full).
    const total    = totalCountFromNd(nd);
    const maxPages = total > 0
      ? Math.min(Math.ceil(total / PAGE_SIZE), maxPagesPerCat)
      : maxPagesPerCat;

    if (buildId) {
      // Strategy A: _next/data lightweight fetches (no page navigation)
      const gotMore = await paginateViaNextData(page, categoryUrl, buildId, maxPages, mode, products, seen);
      if (!gotMore) {
        // _next/data returned nothing → fall back to ?page=N URL navigation
        await paginateViaUrl(page, categoryUrl, maxPages, mode, products, seen);
      }
    } else {
      // No buildId → go straight to URL-based pagination
      await paginateViaUrl(page, categoryUrl, maxPages, mode, products, seen);
    }

  } finally {
    page.removeListener('response', onResponse);
    try { await page.close(); } catch (_) {}
  }

  return products;
}

/**
 * Fast pagination via Next.js /_next/data/{buildId}/path.json?page=N
 * Fetched sequentially (not in parallel) with a polite delay between pages.
 * Returns true if at least one additional page was retrieved.
 */
async function paginateViaNextData(page, categoryUrl, buildId, maxPages, mode, products, seen) {
  const urlObj = new URL(categoryUrl);
  const ndPath = urlObj.pathname.replace(/\/$/, '') + '.json';
  const ndBase = `${urlObj.origin}/_next/data/${buildId}${ndPath}`;
  let   gotAny = false;

  for (let p = 2; p <= maxPages; p++) {
    const pData  = await fetchNdPage(page, ndBase, p);
    const pItems = resultsFromNd(pData);

    if (pItems.length === 0) break; // natural end of catalog

    gotAny = true;
    parseAndAdd(pItems, products, seen, categoryUrl);
    console.log(`  [${STORE}] nd ?page=${p} → ${products.length} acum.`);

    // Polite delay — full mode is slower; fast mode stays nimble
    await (mode === 'full' ? jitter(2000, 2000) : jitter(1000, 1500));
  }

  return gotAny;
}

/**
 * URL-based pagination: navigates to categoryUrl?page=N, extracts __NEXT_DATA__
 * (or DOM fallback). Used when buildId is unavailable or _next/data returns nothing.
 */
async function paginateViaUrl(page, categoryUrl, maxPages, mode, products, seen) {
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
      console.log(`  [${STORE}] url ?page=${p} → ${products.length} acum.`);

      await (mode === 'full' ? jitter(2500, 2000) : jitter(1200, 1500));
    } catch (err) {
      console.error(`  [${STORE}] Error pag. URL p${p}: ${err.message}`);
      break;
    }
  }
}

// ── Data extraction helpers ────────────────────────────────────────────────────

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

/**
 * Try all known paths where Falabella puts the products array in pageProps.
 * /collection/ pages tend to use shallow paths (pp.results).
 * /category/   pages tend to use deeper paths (pp.initialData.data.results, etc.)
 */
function resultsFromNd(nd) {
  if (!nd) return [];
  const pp = nd?.props?.pageProps;
  if (!pp) return [];

  // ── /collection/ shapes ───────────────────────────────────────────────────
  if (pp.results?.length)                         return pp.results;
  if (pp.searchResults?.results?.length)          return pp.searchResults.results;
  if (pp.listingData?.results?.length)            return pp.listingData.results;
  if (pp.pageData?.results?.length)               return pp.pageData.results;

  // ── /category/ shapes ─────────────────────────────────────────────────────
  if (pp.initialData?.results?.length)            return pp.initialData.results;
  if (pp.initialData?.data?.results?.length)      return pp.initialData.data.results;
  if (pp.initialData?.products?.length)           return pp.initialData.products;
  if (pp.initialData?.data?.products?.length)     return pp.initialData.data.products;
  if (pp.categoryData?.results?.length)           return pp.categoryData.results;
  if (pp.categoryData?.products?.length)          return pp.categoryData.products;
  if (pp.data?.results?.length)                   return pp.data.results;
  if (pp.data?.products?.length)                  return pp.data.products;
  if (pp.products?.length)                        return pp.products;
  if (pp.page?.results?.length)                   return pp.page.results;
  if (pp.page?.products?.length)                  return pp.page.products;

  // ── Last resort: walk the whole pageProps tree ────────────────────────────
  return deepFindProducts(pp) || [];
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
      || pp.initialData?.pagination?.total
      || pp.initialData?.data?.pagination?.total
      || pp.categoryData?.pagination?.total
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
 * Fetch one paginated Next.js data endpoint from inside the browser context.
 * Using page.evaluate's fetch() inherits session cookies and Chromium's TLS
 * fingerprint — no extra HTTP client needed.
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

/**
 * Level C fallback: scrape product card DOM elements directly.
 * Uses a layered selector list ordered from most-specific to broadest so the
 * first successful match wins without needing the exact class name.
 */
async function extractFromDom(page, sourceUrl) {
  // Ordered from most stable (data-attrs) to most fragile (class partials)
  const CARD_SELECTORS = [
    '[data-pod]',
    '[data-id][data-name]',
    '[class*="pod-capsule"]',
    '[class*="grid-pod"]',
    '[class*="pod--sku"]',
    'article[class*="pod"]',
    'li[class*="pod"]',
    '[class*="product-item"]',
    '[class*="product-card"]',
  ].join(', ');

  try {
    // Give the page up to 8 s to render the grid (covers client-side hydration)
    const found = await page.waitForSelector(CARD_SELECTORS, { timeout: 8000 })
      .catch(() => null);

    if (!found) {
      console.warn(`[${STORE}] DOM: ningún selector de tarjetas encontró elementos en ${new URL(sourceUrl).pathname}`);
      return [];
    }

    const cards = await page.$$eval(
      CARD_SELECTORS,
      (nodes, src) => nodes.map(card => {
        const nameEl  = card.querySelector(
          '[class*="pod-title"], [class*="pod-header"], [class*="display-name"], [class*="product-title"]'
        );
        const priceEl = card.querySelector(
          '[class*="buy-price"], [class*="price--best"], [class*="subprice__bulk"], [class*="prices-0"], [class*="price_main"]'
        );
        const origEl  = card.querySelector(
          '[class*="crossed"], [class*="normal-price"], [class*="prices-1"], [class*="line-through"]'
        );
        const imgEl   = card.querySelector('img[src], img[data-src], img[srcset]');
        const linkEl  = card.querySelector('a[href*="/product/"], a[href]');
        return {
          displayName: nameEl?.textContent?.trim() || '',
          prices: [
            origEl?.textContent  ? { label: 'normal', price: [origEl.textContent.trim()],  crossed: true  } : null,
            priceEl?.textContent ? { label: 'oferta', price: [priceEl.textContent.trim()], crossed: false } : null,
          ].filter(Boolean),
          mediaUrls: [imgEl?.src || imgEl?.dataset?.src || ''].filter(Boolean),
          url: linkEl ? new URL(linkEl.href, 'https://www.falabella.com.pe').href : src,
        };
      }),
      sourceUrl
    ).catch(() => []);

    if (cards.length === 0) {
      console.warn(`[${STORE}] DOM: selector matcheó pero $$eval devolvió 0 tarjetas — posible layout diferente en ${new URL(sourceUrl).pathname}`);
    }
    return cards;
  } catch (_) { return []; }
}

// ── Price extraction ───────────────────────────────────────────────────────────

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

// ── Product normalizer ─────────────────────────────────────────────────────────

function parseAndAdd(rawItems, out, seen, catUrl) {
  for (const item of rawItems) {
    try {
      const name = cleanTitle(item.displayName || item.name || '');
      if (!name || name.length < 3) continue;

      const { current, original } = extractPrices(item.prices || []);
      if (!current || current <= 0) continue;

      const effectiveOrig = original > current
        ? original
        : Math.round(current * 1.3); // synthesise if only sale price present
      const discountPct   = Math.round(((effectiveOrig - current) / effectiveOrig) * 100);
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

// ── Utilities ──────────────────────────────────────────────────────────────────

/** Open a new page with resource blocking already configured. */
async function openPage(context) {
  const page = await context.newPage();
  await page.route('**/*', route => {
    const req  = route.request();
    const type = req.resourceType();
    const url  = req.url();
    if (ABORT_TYPES.has(type))                     return route.abort();
    if (ABORT_DOMAINS.some(d => url.includes(d))) return route.abort();
    route.continue();
  });
  return page;
}

/**
 * Queue-based concurrency pool.
 * Creates `limit` long-running workers that each pull tasks from a shared
 * queue until exhausted — unlike batch Promise.allSettled, idle workers
 * immediately pick up the next task without waiting for slower siblings.
 */
async function runWithConcurrency(items, limit, fn) {
  const queue = items.slice(); // shallow copy so we can shift() safely
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (item !== undefined) await fn(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
}

/**
 * Recursively walk a pageProps sub-tree looking for the first array whose
 * items look like Falabella product objects.  Used as last-resort fallback
 * when none of the known static paths match.
 */
function deepFindProducts(obj, depth = 0) {
  if (depth > 7 || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    if (obj.length >= 2 && isProductLike(obj[0])) return obj;
    return null;
  }
  const SKIP_KEYS = new Set(['query', 'variables', 'errors', '__typename', 'headers', 'cookies']);
  for (const [key, val] of Object.entries(obj)) {
    if (SKIP_KEYS.has(key)) continue;
    const found = deepFindProducts(val, depth + 1);
    if (found) return found;
  }
  return null;
}

function isProductLike(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const hasName  = !!(item.displayName || item.name || item.title);
  const hasPrice = !!(item.prices || item.price || item.currentPrice || item.normalPrice);
  return hasName && hasPrice;
}

/** Pick a random User-Agent from the pool. */
function pickUa() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/** Random delay: base + up to extra milliseconds. */
function jitter(base, extra) {
  return new Promise(r => setTimeout(r, base + Math.random() * extra));
}

function dedupe(paths) {
  return [...new Set(paths)];
}

function toPathname(href) {
  if (!href) return '';
  try { return new URL(href, BASE).pathname; }
  catch (_) { return href.startsWith('/') ? href : ''; }
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

module.exports = { scrape, STORE };
