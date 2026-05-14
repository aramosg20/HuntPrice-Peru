'use strict';
const { execFileSync } = require('child_process');
const { cleanTitle, mlSkuFromUrl, urlToSku } = require('./utils');
const { runProgressiveScrape } = require('./engine');

const STORE = 'Mercado Libre';
const BASE  = 'https://www.mercadolibre.com.pe';
const UA    = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// Section URLs — each page embeds the Nordic rendering context with product cards.
// ML doesn't support a simple ?page=N on these listing pages, so maxPages=1.
const CATEGORIAS_BASE = [
  `${BASE}/ofertas`,
  `${BASE}/celulares-telefonos`,
  `${BASE}/computacion`,
  `${BASE}/electrodomesticos`,
  `${BASE}/tv-audio-video`,
  `${BASE}/herramientas`,
  `${BASE}/ropa-calzado-accesorios`,
  `${BASE}/deportes-fitness`,
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

// ML listing pages don't support clean pagination — one pass per URL
async function fetchPage(url, pageNum) {
  if (pageNum > 1) return null;
  return fetchWithCurl(url);
}

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

function extractItems(html) {
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

    const priceComp  = comps.find(c => c.type === 'price' || c.id === 'price');
    const priceData  = priceComp?.price || {};
    const current    = priceData.current_price?.value || priceData.amount?.value || 0;
    const original   = priceData.previous_price?.value || priceData.original_price?.value || 0;
    const discountPct = priceData.discount?.value || 0;
    if (!current || current <= 0) return;

    const orig = original > current ? original
      : (discountPct > 0 ? Math.round(current / (1 - discountPct / 100)) : 0);
    if (!orig || orig <= current) return;

    const discount = discountPct || Math.round(((orig - current) / orig) * 100);
    if (discount < 1 || discount > 100) return;

    const pics    = card.pictures?.pictures || [];
    const imgId   = pics[0]?.id || '';
    const imgUrl  = imgId ? `https://http2.mlstatic.com/D_NQ_NP_${imgId}-O.webp` : (card.thumbnail || '');

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
    maxPages: 1,           // ML pages don't support simple ?page=N pagination
    homeMarkers: HOME_MARKERS,
    pageDelay: [0, 0],     // No intra-URL pagination delay needed
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
