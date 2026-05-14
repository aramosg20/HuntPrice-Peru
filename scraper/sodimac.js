'use strict';
const { chromium } = require('playwright');
const { cleanScene7Url, urlToSku } = require('./utils');
const { readCursor, writeCursor, runWithConcurrency, jitter, BATCH_SIZE } = require('./engine');

const STORE = 'Sodimac';
const BASE  = 'https://www.sodimac.com.pe';
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Direct category paths — validated to serve rendered product grids.
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

// PE localization cookies keep the Falabella-stack from showing a generic hub page.
const PE_COOKIES = [
  { name: 'userLocation',     value: 'PE',          domain: '.sodimac.com.pe', path: '/' },
  { name: 'locale',           value: 'es_PE',        domain: '.sodimac.com.pe', path: '/' },
  { name: 'region',           value: 'PE',           domain: '.sodimac.com.pe', path: '/' },
  { name: 'currentStoreSlug', value: 'sodimac-pe',   domain: '.sodimac.com.pe', path: '/' },
];

// Broad selector covering Sodimac's known pod class variants.
const CARD_SEL = [
  '[data-pod="catalogo"]',
  '[data-pod="product"]',
  '[class*="jsx-product"]',
  '[class*="product-card-wrapper"]',
  '[class*="pod-link"]',
].join(', ');

function log(event, data = {}) {
  console.log(JSON.stringify({ level: 'info', store: STORE, event, timestamp: new Date().toISOString(), ...data }));
}

async function scrapeCategory(ctx, categoryUrl) {
  const page = await ctx.newPage();
  try {
    // No resource blocking — all scripts must execute so Intersection Observers fire.
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Progressive scroll: 5 × 800 px with 500 ms pauses triggers lazy-loading observers.
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(500);
    }
    // Final scroll to absolute bottom catches any remaining deferred content.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);

    // Smart wait: block until >10 product cards are in the DOM or 10 s elapses.
    await page.waitForFunction(
      sel => document.querySelectorAll(sel).length > 10,
      CARD_SEL,
      { timeout: 10000 }
    ).catch(() => {});

    // Visual extraction from the fully-rendered DOM via $$eval.
    const raw = await page.$$eval(CARD_SEL, (pods, base) => {
      const results = [];
      const seen    = new Set();
      for (const pod of pods.slice(0, 60)) {
        try {
          const linkEl = pod.querySelector('a[href]');
          const href   = linkEl?.getAttribute('href') || '';
          const url    = href.startsWith('http') ? href : (href ? base + href : '');
          if (!url || seen.has(url)) continue;
          seen.add(url);

          const name = (
            pod.querySelector('[class*="title"]')?.textContent    ||
            pod.querySelector('[class*="name"]')?.textContent     ||
            pod.querySelector('h3, h2, h4')?.textContent         ||
            ''
          ).trim().replace(/\s+/g, ' ');
          if (!name || name.length < 3) continue;

          const saleEl  = pod.querySelector(
            '[class*="price-sale"], [class*="sale-price"], [class*="price--sale"], [class*="price_sale"]'
          );
          const current = parseFloat(
            (saleEl?.textContent || '').replace(/[^\d,.]/g, '').replace(',', '.')
          ) || 0;
          if (!current || current < 5) continue;

          const origEl  = pod.querySelector(
            '[class*="price-original"], [class*="price-crossed"], [class*="crossed"], [class*="price--original"]'
          );
          const original = parseFloat(
            (origEl?.textContent || '').replace(/[^\d,.]/g, '').replace(',', '.')
          ) || 0;
          if (!original || original <= current) continue;

          const discount = Math.round(((original - current) / original) * 100);
          if (discount < 1 || discount > 95) continue;

          const imgEl  = pod.querySelector('img[data-src], img[src]');
          const imgSrc = imgEl?.getAttribute('data-src') || imgEl?.getAttribute('src') || '';
          results.push({ name, url, imgSrc, current, original, discount });
        } catch (_) {}
      }
      return results;
    }, BASE);

    if (raw.length > 0) {
      log('scrape_dom_extracted', { url: categoryUrl, count: raw.length });
      return raw.map(p => ({
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
    }

    log('scrape_no_products', { url: categoryUrl });
    return [];
  } finally {
    await page.close();
  }
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
