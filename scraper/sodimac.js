'use strict';
const { chromium } = require('playwright');
const { cleanTitle, cleanScene7Url, urlToSku } = require('./utils');
const { readCursor, writeCursor, runWithConcurrency, jitter, BATCH_SIZE, MAX_PAGES } = require('./engine');

const STORE = 'Sodimac';
const BASE  = 'https://www.sodimac.com.pe';
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// /lista/ routes are standard SSR catalog views — __NEXT_DATA__ carries the full
// product grid on the first HTML response, no JavaScript execution required.
const CATEGORIAS_BASE = [
  `${BASE}/sodimac-pe/lista/cat40485/Ropero`,
  `${BASE}/sodimac-pe/lista/cat10260/refrigeradoras`,
  `${BASE}/sodimac-pe/lista/cat10252/lavadoras`,
  `${BASE}/sodimac-pe/lista/cat10060/taladros`,
  `${BASE}/sodimac-pe/lista/cat10884/porcelanatos`,
  `${BASE}/sodimac-pe/lista/cat10050/iluminacion-interior`,
];

const PE_COOKIES = [
  { name: 'userLocation',     value: 'PE',        domain: '.sodimac.com.pe', path: '/' },
  { name: 'locale',           value: 'es_PE',     domain: '.sodimac.com.pe', path: '/' },
  { name: 'region',           value: 'PE',        domain: '.sodimac.com.pe', path: '/' },
  { name: 'currentStoreSlug', value: 'sodimac-pe', domain: '.sodimac.com.pe', path: '/' },
];

const STEALTH_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'es-PE,es-419;q=0.9,es;q=0.8,en;q=0.7',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

async function scrapeCategory(ctx, categoryUrl) {
  const page = await ctx.newPage();
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['es-PE', 'es', 'en'] });
      window.chrome = { runtime: {} };
    });
    await page.setExtraHTTPHeaders(STEALTH_HEADERS);

    const allProducts = [];
    const seen        = new Set();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const pageUrl = pageNum > 1 ? `${categoryUrl}?page=${pageNum}` : categoryUrl;
      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      } catch (_) { break; }

      const html  = await page.content();
      const items = extractFromNextData(html);

      if (items.length === 0) {
        if (pageNum === 1) {
          console.warn(`[${STORE}] 0 items en p1 — posible redirect/WAF: ${categoryUrl}`);
        }
        break;
      }

      let added = 0;
      for (const item of items) {
        if (!item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        allProducts.push(item);
        added++;
      }
      console.log(`  [${STORE}] ${new URL(categoryUrl).pathname} p${pageNum} → +${added}`);
      if (added === 0) break;
      if (pageNum < MAX_PAGES) await jitter(1000, 500);
    }
    return allProducts;
  } finally {
    await page.close();
  }
}

function extractFromNextData(html) {
  const match = html && html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];
  let data;
  try { data = JSON.parse(match[1]); } catch (_) { return []; }

  const pp = data?.props?.pageProps;
  const results = (
    pp?.results ||
    pp?.initialState?.results ||
    pp?.initialState?.search?.results ||
    pp?.searchResults?.results ||
    pp?.initialData?.data?.results ||
    pp?.data?.results ||
    []
  );
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
      userAgent: UA,
      locale: 'es-PE',
      extraHTTPHeaders: { 'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8' },
    });
    await ctx.addCookies(PE_COOKIES);

    const allRaw = [];
    await runWithConcurrency(batch, 2, async url => {
      try {
        const items = await scrapeCategory(ctx, url);
        console.log(`[${STORE}] ${new URL(url).pathname} → ${items.length} productos`);
        allRaw.push(...items);
      } catch (err) {
        console.error(`[${STORE}] Error en ${url}: ${err.message}`);
      }
      await jitter(2000, 1500);
    });

    const seen     = new Set();
    const products = [];
    for (const item of allRaw) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      products.push(item);
    }

    console.log(`[${STORE}] Lote completo — ${products.length} productos`);
    return products;
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
  if (/sofa|cama|colchon|mesa|silla|mueble|closet|ropero/.test(n)) return 'Muebles';
  if (/jardin|planta|maceta|manguera/.test(n))              return 'Jardín';
  if (/lavadora|refriger|cocina|horno|microond/.test(n))    return 'Electrohogar';
  if (/lamp|foco|iluminacion/.test(n))                      return 'Iluminación';
  if (/piso|ceramica|porcelanato/.test(n))                  return 'Pisos';
  if (/tv|televisor|smart tv/.test(n))                      return 'Electrónica';
  return 'Hogar';
}

module.exports = { scrape, STORE };

if (require.main === module) {
  scrape().then(p => { console.log(`\n--- RESULTADO ---\nProductos: ${p.length}`); console.log(JSON.stringify(p.slice(0, 3), null, 2)); })
         .catch(err => { console.error('Error:', err.message); process.exit(1); });
}
