'use strict';
const { execFileSync } = require('child_process');
const { cleanTitle, mlSkuFromUrl, urlToSku } = require('./utils');
const { runProgressiveScrape } = require('./engine');

const STORE        = 'Mercado Libre';
const BASE         = 'https://www.mercadolibre.com.pe';
const ML_API_BASE  = 'https://api.mercadolibre.com';
const ML_PAGE_SIZE = 50;
const UA           = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// /ofertas → HTML scraping via Nordic rendering context (verified working).
// api:MPExxx → ML public REST API; bypasses broken HTML layouts on category pages.
//   Pagination: offset=(pageNum-1)*50, supports up to maxPages pages.
const CATEGORIAS_BASE = [
  `${BASE}/ofertas`,
  'api:MPE1051',    // Celulares y Teléfonos
  'api:MPE1648',    // Computación
  'api:MPE1000',    // Electrónica, Audio y Video
  'api:MPE1246',    // Electrodomésticos
  'api:MPE10483',   // Herramientas y Construcción
  'api:MPE1430',    // Ropa y Accesorios
  'api:MPE1276',    // Deportes y Fitness
];

const HOME_MARKERS = ['<title>Mercado Libre Perú - Donde comprar y vender de todo</title>'];

function buildCurlArgs(url) {
  return [
    '-s', '-L', '--max-time', '25',
    '-H', `User-Agent: ${UA}`,
    '-H', 'Accept: text/html,application/xhtml+xml,*/*;q=0.9',
    '-H', 'Accept-Language: es-PE,es;q=0.9,en;q=0.8',
    '-H', 'Accept-Encoding: gzip, deflate, br',
    '-H', 'Referer: https://www.google.com.pe/',
    '-H', 'sec-ch-ua-mobile: ?1',
    '-H', 'sec-fetch-dest: document',
    '-H', 'sec-fetch-mode: navigate',
    '-H', 'upgrade-insecure-requests: 1',
    '--compressed',
    url,
  ];
}

function buildApiCurlArgs(url) {
  return [
    '-s', '--max-time', '15',
    '-H', 'Accept: application/json',
    '-H', 'Accept-Language: es-PE',
    url,
  ];
}

async function fetchWithCurl(url, attempt = 1) {
  try {
    return execFileSync('curl', buildCurlArgs(url), { maxBuffer: 15 * 1024 * 1024, timeout: 30000 }).toString();
  } catch (err) {
    if (attempt < 3) {
      await delay(Math.pow(2, attempt) * 1000 + Math.random() * 1000);
      return fetchWithCurl(url, attempt + 1);
    }
    return null;
  }
}

async function fetchApiJson(url, attempt = 1) {
  try {
    const raw = execFileSync('curl', buildApiCurlArgs(url), { maxBuffer: 5 * 1024 * 1024, timeout: 20000 }).toString();
    return JSON.parse(raw);
  } catch (err) {
    if (attempt < 3) {
      await delay(Math.pow(2, attempt) * 1000 + Math.random() * 500);
      return fetchApiJson(url, attempt + 1);
    }
    return null;
  }
}

async function fetchPage(url, pageNum) {
  if (url.startsWith('api:')) {
    const categoryId = url.slice(4);
    const offset     = (pageNum - 1) * ML_PAGE_SIZE;
    const apiUrl     = `${ML_API_BASE}/sites/MPE/search?category=${categoryId}&sort=price_desc&limit=${ML_PAGE_SIZE}&offset=${offset}`;
    return fetchApiJson(apiUrl);
  }
  // HTML path — ML listing pages don't support simple ?page=N pagination
  if (pageNum > 1) return null;
  return fetchWithCurl(url);
}

function extractItems(data, url) {
  if (url && url.startsWith('api:')) return extractFromApi(data);
  return extractFromHtml(data);
}

// ---- REST API path ----
function extractFromApi(data) {
  if (!data || !Array.isArray(data.results)) return [];
  const out  = [];
  const seen = new Set();
  for (const item of data.results) {
    try {
      const name = cleanTitle(item.title || '');
      if (!name || name.length < 4) continue;
      const current  = item.price || 0;
      if (!current || current <= 0) continue;
      const original = item.original_price || 0;
      if (!original || original <= current) continue;
      const discount = Math.round(((original - current) / original) * 100);
      if (discount < 1 || discount > 90) continue;
      const url = item.permalink || '';
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const imgRaw = item.thumbnail || '';
      const imgUrl = imgRaw.replace(/-I\.jpg$/, '-O.jpg').replace(/-I\.webp$/, '-O.webp') || imgRaw;
      out.push({
        store: STORE, name: name.substring(0, 120),
        sku: item.id || mlSkuFromUrl(url) || urlToSku(url),
        category: guessCategory(name), url,
        image_url: imgUrl,
        current_price: current, original_price: original,
        discount_percent: discount, stock_info: null,
      });
    } catch (_) {}
  }
  return out;
}

// ---- HTML path (Nordic rendering context + fallbacks) ----

// Balanced-brace JSON extractor avoids regex lazy-quantifier truncation
function extractJsonAt(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf('{', idx + marker.length);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch (_) { return null; } }
    }
  }
  return null;
}

function extractFromHtml(html) {
  if (!html) return [];
  const out  = [];
  const seen = new Set();

  // Plan A: Nordic rendering context — primary path
  const nordicData = extractJsonAt(html, '_n.ctx.r=');
  if (nordicData) {
    const items = nordicData?.appProps?.pageProps?.data?.items
      || nordicData?.appProps?.pageProps?.items
      || nordicData?.initialState?.results?.items
      || [];
    for (const item of items.slice(0, 60)) extractMlCard(item?.card || item, out, seen);
  }

  // Plan B: __NEXT_DATA__
  if (out.length === 0) {
    const ndMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (ndMatch) {
      try {
        const nd = JSON.parse(ndMatch[1]);
        const items = nd?.props?.pageProps?.data?.items
          || nd?.props?.pageProps?.results?.items
          || nd?.props?.pageProps?.items
          || [];
        for (const item of items.slice(0, 60)) extractMlCard(item?.card || item, out, seen);
      } catch (_) {}
    }
  }

  // Plan C: __PRELOADED_STATE__
  if (out.length === 0) {
    const stateData = extractJsonAt(html, 'window.__PRELOADED_STATE__=');
    if (stateData) {
      const items = stateData?.initialState?.results?.items || stateData?.results?.items || [];
      for (const item of items.slice(0, 60)) extractMlCard(item?.card || item, out, seen);
    }
  }

  return out;
}

function extractMlCard(card, out, seen) {
  if (!card) return;
  try {
    const meta  = card.metadata || {};
    const comps = card.components || [];

    const rawName = (
      comps.find(c => c.type === 'title')?.title?.text
      || comps.find(c => c.type === 'product_title')?.product_title?.text
      || card.title || meta.title || ''
    );
    const name = cleanTitle(rawName);
    if (!name || name.length < 4) return;

    const rawUrl = meta.url || card.url || '';
    const url    = rawUrl ? (rawUrl.startsWith('http') ? rawUrl.split('#')[0] : 'https://' + rawUrl.split('#')[0]) : '';
    if (!url || seen.has(url)) return;
    seen.add(url);

    const priceComp   = comps.find(c => c.type === 'price' || c.id === 'price');
    const priceData   = priceComp?.price || {};
    const current     = priceData.current_price?.value || priceData.amount?.value || 0;
    const original    = priceData.previous_price?.value || priceData.original_price?.value || 0;
    const discountPct = priceData.discount?.value || 0;
    if (!current || current <= 0) return;

    const orig = original > current ? original
      : (discountPct > 0 ? Math.round(current / (1 - discountPct / 100)) : 0);
    if (!orig || orig <= current) return;

    const discount = discountPct || Math.round(((orig - current) / orig) * 100);
    if (discount < 1 || discount > 100) return;

    const pics   = card.pictures?.pictures || [];
    const imgId  = pics[0]?.id || '';
    const imgUrl = imgId ? `https://http2.mlstatic.com/D_NQ_NP_${imgId}-O.webp` : (card.thumbnail || '');

    out.push({
      store: STORE, name: name.substring(0, 120),
      sku: mlSkuFromUrl(url) || urlToSku(url),
      category: guessCategory(name), url,
      image_url: imgUrl, current_price: current, original_price: orig,
      discount_percent: discount, stock_info: null,
    });
  } catch (_) {}
}

async function scrape() {
  return runProgressiveScrape({
    store: STORE, categorias: CATEGORIAS_BASE,
    maxPages: 3,            // API paths support 3×50=150 items; HTML path breaks at page 2
    homeMarkers: HOME_MARKERS,
    pageDelay: [1000, 500],
    catDelay: [2000, 1500],
    fetchPage, extractItems,
  });
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/celular|smartphone|iphone|xiaomi|motorola/.test(n)) return 'Celulares';
  if (/laptop|notebook|computad|tablet|ipad/.test(n))      return 'Computación';
  if (/tv|televisor|smart tv|monitor/.test(n))             return 'Electrónica';
  if (/zapatill|zapato|nike|adidas/.test(n))               return 'Calzado';
  if (/refriger|lavadora|microond|cocina/.test(n))         return 'Electrohogar';
  if (/perfume|crema|maquillaje/.test(n))                  return 'Belleza';
  if (/ropa|polo|camisa|vestido|jeans/.test(n))            return 'Moda';
  if (/juguete|lego|muñeca/.test(n))                       return 'Juguetes';
  if (/bicicleta|pesa|deporte|gym/.test(n))                return 'Deportes';
  if (/audifonos|auricular|bluetooth|parlante/.test(n))    return 'Electrónica';
  return 'General';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrape, STORE };

if (require.main === module) {
  scrape().then(p => { console.log(`\n--- RESULTADO ---\nProductos: ${p.length}`); console.log(JSON.stringify(p.slice(0, 3), null, 2)); });
}
