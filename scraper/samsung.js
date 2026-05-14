'use strict';
const { chromium } = require('playwright');

const STORE = 'Samsung';
const BASE  = 'https://www.samsung.com';
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Resource types that waste bandwidth — only HTML/scripts pass through
const BLOCKED_TYPES = new Set(['image', 'stylesheet', 'font', 'media']);

const CATEGORY_URLS = [
  `${BASE}/pe/smartphones/all-smartphones/`,
  `${BASE}/pe/tablets/all-tablets/`,
];

const MAX_PER_CATEGORY = 40;

function log(event, data = {}) {
  console.log(JSON.stringify({ level: 'info', store: STORE, event, timestamp: new Date().toISOString(), ...data }));
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/galaxy s|galaxy a|celular|smartphone/.test(n)) return 'Celulares';
  if (/galaxy tab|tablet/.test(n))                   return 'Computación';
  if (/qled|neo qled|oled|frame|tv|televisor/.test(n)) return 'Electrónica';
  if (/galaxy book|laptop/.test(n))                  return 'Computación';
  if (/galaxy buds|audifonos|auricular|soundbar/.test(n)) return 'Electrónica';
  if (/lavadora|refrigerador|microondas/.test(n))    return 'Electrohogar';
  return 'Tecnología';
}

// Parse "S/ 6,899.00" or "s/ 383.28" → 6899 / 383.28
function parseSoles(text) {
  const matches = [...text.matchAll(/[Ss]\/\s*([\d,]+(?:\.\d{1,2})?)/g)];
  return matches.map(m => parseFloat(m[1].replace(/,/g, '')) || 0).filter(v => v > 0);
}

async function scrapeCategory(ctx, categoryUrl) {
  const page = await ctx.newPage();
  try {
    // Intercept and abort heavy resources
    await page.route('**/*', (route) => {
      if (BLOCKED_TYPES.has(route.request().resourceType())) return route.abort();
      return route.continue();
    });

    // Capture JSON API responses (Samsung sometimes exposes product data via XHR)
    const apiProducts = [];
    page.on('response', async (resp) => {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (!ct.includes('json') || !resp.url().includes('samsung.com')) return;
        const json = await resp.json().catch(() => null);
        if (json) extractFromApiJson(json, apiProducts);
      } catch (_) {}
    });

    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    if (apiProducts.length > 0) {
      log('scrape_api_captured', { url: categoryUrl, count: apiProducts.length });
      return apiProducts;
    }

    log('scrape_dom_fallback', { url: categoryUrl });

    // ── DOM extraction with exact Samsung PE selectors ──────────────────────
    const products = await page.evaluate(({ base, max }) => {
      const results = [];
      const seen    = new Set();

      // Samsung PE uses pd21-product-card__item for every product card
      const cards = [...document.querySelectorAll('.pd21-product-card__item')].slice(0, max);
      if (cards.length === 0) return results;

      for (const card of cards) {
        try {
          // Title — class name confirmed from live DOM inspection
          const titulo = card.querySelector('.pd21-product-card__name-wrap')
            ?.textContent?.trim() || '';
          if (!titulo || titulo.length < 3) continue;

          // URL — the image CTA anchor contains the product href
          const linkEl = card.querySelector('a.pd21-product-card__image-cta[href]');
          const href   = linkEl?.getAttribute('href') || '';
          const url    = href.startsWith('http') ? href : (href ? base + href : '');
          if (!url || seen.has(url)) continue;
          seen.add(url);

          // Image — lazy-loaded; real URL is always in data-src (not src)
          // image__main is the primary product image; image__preview is a thumbnail
          const imgEl  = card.querySelector('img.image__main[data-src]') ||
                         card.querySelector('img[data-src]');
          let imagen   = imgEl?.getAttribute('data-src') || '';
          // Fix protocol-relative URLs
          if (imagen.startsWith('//')) imagen = 'https:' + imagen;

          // Prices — Samsung shows: "Desde s/ 383.28 en 18 cuotas* o S/ 6,899.00"
          // The LAST S/ value is the full sale price (the installment is the first)
          const priceEl = card.querySelector('.pd21-product-card__price');
          const priceText = priceEl?.textContent || '';
          const prices  = parseSoles(priceText);

          // Also check for explicit original-price element (shown when discounted)
          const origEl  = card.querySelector('.price-ux__price-before, .price-original, [class*="before-price"], [class*="original-price"], s, del');
          const origText = origEl?.textContent || '';
          const origPrices = parseSoles(origText);

          // Full sale price is the last (largest by position, not necessarily value) S/ match
          const precio_actual = prices[prices.length - 1] || 0;
          if (!precio_actual || precio_actual < 50) continue;

          // Original price: use explicit element if present; otherwise equal to sale price
          const precio_normal = origPrices[0] || precio_actual;

          results.push({ titulo, precio_actual, precio_normal, url, imagen });
        } catch (_) {}
      }
      return results;

      // Inline helper — must live inside page.evaluate
      function parseSoles(text) {
        const matches = [...text.matchAll(/[Ss]\/\s*([\d,]+(?:\.\d{1,2})?)/g)];
        return matches.map(m => parseFloat(m[1].replace(/,/g, '')) || 0).filter(v => v > 0);
      }
    }, { base: BASE, max: MAX_PER_CATEGORY });

    log('scrape_dom_extracted', { url: categoryUrl, count: products.length });
    return products;
  } finally {
    await page.close();
  }
}

// Try to pull products out of a JSON API response (XHR interception fallback)
function extractFromApiJson(json, out) {
  if (!json || typeof json !== 'object') return;
  const lists = [
    json.productList, json.modelList, json.products, json.items,
    json.response?.productList, json.data?.productList, json.data?.modelList,
  ];
  for (const list of lists) {
    if (!Array.isArray(list) || list.length === 0) continue;
    for (const item of list.slice(0, 40)) {
      const titulo = (item.displayName || item.modelName || item.productName || item.name || '').trim();
      if (!titulo) continue;
      const precio_actual = parseFloat(String(item.salePrice || item.price || 0).replace(/[^\d.]/g, '')) || 0;
      if (!precio_actual) continue;
      const precio_normal = parseFloat(String(item.regularPrice || item.listPrice || 0).replace(/[^\d.]/g, '')) || precio_actual;
      const rawUrl = item.url || item.pdpUrl || item.productUrl || '';
      const url = rawUrl.startsWith('http') ? rawUrl : (rawUrl ? BASE + rawUrl : '');
      let imagen = item.thumbUrl || item.imageUrl || item.image || '';
      if (imagen.startsWith('//')) imagen = 'https:' + imagen;
      out.push({ titulo, precio_actual, precio_normal, url, imagen });
    }
    if (out.length > 0) return;
  }
  for (const key of Object.keys(json)) {
    const v = json[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      extractFromApiJson(v, out);
      if (out.length > 0) return;
    }
  }
}

async function scrape() {
  log('scrape_started', {});
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: UA,
      locale: 'es-PE',
      extraHTTPHeaders: { 'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8' },
    });

    const allRaw = [];
    for (const url of CATEGORY_URLS) {
      try {
        const items = await scrapeCategory(ctx, url);
        log('scrape_category_done', { url, count: items.length });
        allRaw.push(...items);
        await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        log('scrape_category_error', { url, message: err.message });
      }
    }

    // Deduplicate and convert to HuntPrice standard format
    const seen     = new Set();
    const products = [];
    for (const r of allRaw) {
      if (!r.titulo || !r.precio_actual || !r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      const discount = r.precio_normal > r.precio_actual
        ? Math.round(((r.precio_normal - r.precio_actual) / r.precio_normal) * 100)
        : 0;
      products.push({
        store:            STORE,
        name:             r.titulo.substring(0, 120),
        category:         guessCategory(r.titulo),
        url:              r.url,
        image_url:        r.imagen,
        current_price:    r.precio_actual,
        original_price:   r.precio_normal,
        discount_percent: discount,
        stock_info:       null,
      });
    }

    log('scrape_completed', { productsCount: products.length });
    return products;
  } finally {
    await browser.close();
  }
}

module.exports = { scrape, STORE };

if (require.main === module) {
  scrape()
    .then(p => {
      console.log(`\n--- RESULTADO ---\nProductos: ${p.length}`);
      console.log(JSON.stringify(p.slice(0, 5), null, 2));
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
