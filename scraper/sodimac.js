'use strict';
const { chromium } = require('playwright');
const { cleanTitle, cleanScene7Url, urlToSku } = require('./utils');
const { readCursor, writeCursor, runWithConcurrency, jitter, BATCH_SIZE, MAX_PAGES } = require('./engine');
const path = require('path');
const fs   = require('fs');

const STORE = 'Sodimac';
const BASE  = 'https://www.sodimac.com.pe';
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Used only if auto-discovery fails entirely
const CATEGORIAS_FALLBACK = [
  `${BASE}/sodimac-pe/lista/cat40485/Ropero`,
  `${BASE}/sodimac-pe/lista/cat10260/refrigeradoras`,
  `${BASE}/sodimac-pe/lista/cat10252/lavadoras`,
  `${BASE}/sodimac-pe/lista/cat10060/taladros`,
  `${BASE}/sodimac-pe/lista/cat10884/porcelanatos`,
  `${BASE}/sodimac-pe/lista/cat10050/iluminacion-interior`,
];

const CATEGORY_CACHE_FILE = path.join(__dirname, 'sodimac_categories.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const PE_COOKIES = [
  { name: 'userLocation',     value: 'PE',         domain: '.sodimac.com.pe', path: '/' },
  { name: 'locale',           value: 'es_PE',      domain: '.sodimac.com.pe', path: '/' },
  { name: 'region',           value: 'PE',         domain: '.sodimac.com.pe', path: '/' },
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

// ── Category cache ─────────────────────────────────────────────────────────────

function loadCategoryCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CATEGORY_CACHE_FILE, 'utf8'));
    const age = Date.now() - new Date(raw.updatedAt).getTime();
    if (age < CACHE_TTL_MS && Array.isArray(raw.categories) && raw.categories.length > 0) {
      return raw.categories;
    }
  } catch (_) {}
  return null;
}

function saveCategoryCache(categories) {
  try {
    fs.writeFileSync(CATEGORY_CACHE_FILE, JSON.stringify({
      categories,
      count: categories.length,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    console.error(`[${STORE}] cache write error: ${err.message}`);
  }
}

// ── Browser page setup (stealth) ───────────────────────────────────────────────

async function setupPage(ctx) {
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['es-PE', 'es', 'en'] });
    window.chrome = { runtime: {} };
  });
  await page.setExtraHTTPHeaders(STEALTH_HEADERS);
  return page;
}

// ── Auto-discovery ─────────────────────────────────────────────────────────────

async function discoverCategories(ctx) {
  const cached = loadCategoryCache();
  if (cached) {
    console.log(`[${STORE}] Usando caché de categorías (${cached.length} URLs)`);
    return cached;
  }

  console.log(`[${STORE}] Auto-descubriendo categorías desde el Mega Menú...`);
  const page = await setupPage(ctx);
  try {
    await page.goto(`${BASE}/sodimac-pe`, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await jitter(2500, 1000);

    // Hover over top-level nav items to trigger mega menu dropdowns
    const navHandles = await page.$$([
      'nav a', '[class*="MainMenu"] a', '[class*="megamenu"] a',
      '[class*="header"] nav a', '[class*="NavBar"] a',
    ].join(', '));
    for (const el of navHandles.slice(0, 12)) {
      try { await el.hover(); await page.waitForTimeout(350); } catch (_) {}
    }
    await jitter(600, 400);

    const hrefs = await page.$$eval('a[href]', anchors =>
      anchors
        .map(a => a.href)
        .filter(href =>
          href.includes('/categoria/') ||
          href.includes('/category/')  ||
          href.includes('/lista/')
        )
    );

    const seen = new Set();
    const urls = [];
    for (const href of hrefs) {
      try {
        const u     = new URL(href);
        if (!u.hostname.includes('sodimac.com.pe')) continue;
        const clean = u.origin + u.pathname.replace(/\/$/, '');
        if (seen.has(clean)) continue;
        seen.add(clean);
        urls.push(clean);
      } catch (_) {}
    }

    // Leaf-node filter: ≥3 non-empty path segments = subcategory page, not a root node.
    // /sodimac-pe/lista/cat10060/taladros → 4 parts → keep
    // /sodimac-pe/herramientas            → 2 parts → skip
    const leafUrls = urls.filter(url => {
      try { return new URL(url).pathname.split('/').filter(Boolean).length >= 3; }
      catch (_) { return false; }
    });

    const result = leafUrls.length >= 5 ? leafUrls : (urls.length >= 5 ? urls : null);
    if (result) {
      console.log(`[${STORE}] Descubiertas ${result.length} categorías hoja`);
      saveCategoryCache(result);
      return result;
    }

    console.warn(`[${STORE}] Muy pocas URLs descubiertas (${urls.length}) — usando fallback`);
  } catch (err) {
    console.error(`[${STORE}] discoverCategories error: ${err.message}`);
  } finally {
    await page.close();
  }

  return CATEGORIAS_FALLBACK;
}

// ── URL mutation & home detection ──────────────────────────────────────────────

function mutateUrl(url) {
  if (url.includes('/categoria/')) return url.replace('/categoria/', '/lista/');
  if (url.includes('/category/'))  return url.replace('/category/',  '/lista/');
  if (url.includes('/lista/'))     return url.replace('/lista/',     '/category/');
  return null;
}

function isHomeRedirect(html) {
  // Sodimac home title is "Sodimac | Todo para tu hogar" (case-insensitive)
  return html.toLowerCase().includes('sodimac | todo para tu hogar');
}

// ── Fetch with mutation contingency ───────────────────────────────────────────

async function fetchAndExtract(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  } catch (_) { return { items: [], resolvedUrl: url }; }

  const html     = await page.content();
  const redirect = isHomeRedirect(html);
  const items    = redirect ? [] : extractFromNextData(html);

  if (redirect || items.length === 0) {
    const alt = mutateUrl(url);
    if (alt) {
      try {
        await page.goto(alt, { waitUntil: 'domcontentloaded', timeout: 35000 });
        const altItems = extractFromNextData(await page.content());
        if (altItems.length > 0) {
          const reason = redirect ? 'redirect al home' : '0 items';
          try {
            console.log(
              `  [${STORE}] Mutación (${reason}): ` +
              `${new URL(url).pathname} → ${new URL(alt).pathname}`
            );
          } catch (_) {}
          return { items: altItems, resolvedUrl: alt };
        }
      } catch (_) {}
    }
  }

  return { items, resolvedUrl: url };
}

// ── Per-category scraper ───────────────────────────────────────────────────────

async function scrapeCategory(ctx, categoryUrl) {
  const page = await setupPage(ctx);
  try {
    const allProducts = [];
    const seen        = new Set();
    let   resolvedBase = categoryUrl; // updated on first-page mutation; drives pagination

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const pageUrl = pageNum > 1 ? `${resolvedBase}?page=${pageNum}` : categoryUrl;

      let items;
      if (pageNum === 1) {
        const result = await fetchAndExtract(page, pageUrl);
        items        = result.items;
        resolvedBase = result.resolvedUrl;
      } else {
        try {
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
          items = extractFromNextData(await page.content());
        } catch (_) { items = []; }
      }

      if (items.length === 0) {
        if (pageNum === 1) {
          try {
            console.warn(`[${STORE}] 0 items p1 — saltando: ${new URL(categoryUrl).pathname}`);
          } catch (_) {}
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
      try {
        console.log(`  [${STORE}] ${new URL(resolvedBase).pathname} p${pageNum} → +${added}`);
      } catch (_) {}
      if (added === 0) break;
      if (pageNum < MAX_PAGES) await jitter(1000, 500);
    }
    return allProducts;
  } finally {
    await page.close();
  }
}

// ── __NEXT_DATA__ extraction ───────────────────────────────────────────────────

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

// ── Main scrape ────────────────────────────────────────────────────────────────

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  let nextIdx = 0;

  try {
    const ctx = await browser.newContext({
      userAgent: UA,
      locale: 'es-PE',
      extraHTTPHeaders: { 'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8' },
    });
    await ctx.addCookies(PE_COOKIES);

    const categorias = await discoverCategories(ctx);
    const cursor     = readCursor(STORE);
    const total      = categorias.length;
    const startIdx   = cursor.lastCategoryIndex % total;
    const batch      = Array.from({ length: Math.min(BATCH_SIZE, total) }, (_, i) =>
      categorias[(startIdx + i) % total]
    );
    nextIdx = (startIdx + BATCH_SIZE) % total;

    console.log(
      `[${STORE}] Lote progresivo [${startIdx + 1}–${Math.min(startIdx + BATCH_SIZE, total)}] ` +
      `de ${total}`
    );

    const allRaw = [];
    await runWithConcurrency(batch, 2, async url => {
      try {
        const items = await scrapeCategory(ctx, url);
        try { console.log(`[${STORE}] ${new URL(url).pathname} → ${items.length} productos`); } catch (_) {}
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

// ── Helpers ────────────────────────────────────────────────────────────────────

function parsePrice(val) {
  if (!val) return 0;
  if (Array.isArray(val)) val = val[0];
  return parseFloat(String(val).replace(/[^\d.]/g, '')) || 0;
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/pintura|brocha|rodillo/.test(n))                          return 'Construcción';
  if (/taladro|sierra|martillo|llave|herramienta/.test(n))       return 'Herramientas';
  if (/sofa|cama|colchon|mesa|silla|mueble|closet|ropero/.test(n)) return 'Muebles';
  if (/jardin|planta|maceta|manguera/.test(n))                   return 'Jardín';
  if (/lavadora|refriger|cocina|horno|microond/.test(n))         return 'Electrohogar';
  if (/lamp|foco|iluminacion/.test(n))                           return 'Iluminación';
  if (/piso|ceramica|porcelanato/.test(n))                       return 'Pisos';
  if (/tv|televisor|smart tv/.test(n))                           return 'Electrónica';
  return 'Hogar';
}

module.exports = { scrape, STORE };

if (require.main === module) {
  scrape()
    .then(p => { console.log(`\n--- RESULTADO ---\nProductos: ${p.length}`); console.log(JSON.stringify(p.slice(0, 3), null, 2)); })
    .catch(err => { console.error('Error:', err.message); process.exit(1); });
}
