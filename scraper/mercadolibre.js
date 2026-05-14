'use strict';
const { execFileSync } = require('child_process');
const { cleanTitle, mlSkuFromUrl, urlToSku } = require('./utils');

const STORE = 'Mercado Libre';
const BASE = 'https://www.mercadolibre.com.pe';
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const OFFER_URLS = [
  `${BASE}/ofertas`,
  `${BASE}/celulares-telefonos`,
  `${BASE}/computacion`,
  `${BASE}/electrodomesticos`,
];

function log(event, data = {}) {
  console.log(JSON.stringify({ level: 'info', store: STORE, event, timestamp: new Date().toISOString(), ...data }));
}

async function ping(state, extra = '') {
  const key = process.env.CRONITOR_API_KEY;
  if (!key) return;
  try { await fetch(`https://cronitor.link/p/${key}/huntprice-scraper-mercadolibre?state=${state}${extra}`); } catch (_) {}
}

function isBlocked(html) {
  const lower = (html || '').toLowerCase();
  // Specific challenge phrases only — avoids false positives from CDN URLs
  return ['captcha', 'are you a robot', 'cf-browser-verification', 'cf_chl_', 'just a moment...', 'checking your browser', 'access denied', 'unusual traffic'].some(s => lower.includes(s));
}

function buildArgs(url) {
  return [
    '-s', '-L', '--max-time', '25',
    '-H', `User-Agent: ${UA}`,
    '-H', 'Accept: text/html,application/xhtml+xml,*/*;q=0.9',
    '-H', 'Accept-Language: es-PE,es;q=0.9,en;q=0.8',
    '-H', 'Accept-Encoding: gzip, deflate, br',
    '-H', 'Referer: https://www.google.com.pe/',
    '-H', 'sec-ch-ua: "Chromium";v="124", "Not-A.Brand";v="99"',
    '-H', 'sec-ch-ua-mobile: ?1',
    '-H', 'sec-ch-ua-platform: "Android"',
    '-H', 'sec-fetch-dest: document',
    '-H', 'sec-fetch-mode: navigate',
    '-H', 'sec-fetch-site: cross-site',
    '-H', 'sec-fetch-user: ?1',
    '-H', 'upgrade-insecure-requests: 1',
    '--compressed',
    url,
  ];
}

async function fetchWithCurl(url, attempt = 1) {
  try {
    const raw = execFileSync('curl', buildArgs(url), { maxBuffer: 15 * 1024 * 1024, timeout: 30000 }).toString();
    log('scrape_response', { url, bytes: raw.length, attempt });
    return raw;
  } catch (err) {
    log('scrape_fetch_error', { url, message: err.message, attempt });
    if (attempt < 3) {
      await delay(Math.pow(2, attempt) * 1000 + Math.random() * 1000);
      return fetchWithCurl(url, attempt + 1);
    }
    return null;
  }
}

// Balanced-brace JSON extractor — avoids regex lazy-quantifier truncation bug
function extractJsonAt(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf('{', idx + marker.length);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch (_) { return null; } } }
  }
  return null;
}

async function scrape() {
  log('scrape_started', { urlCount: OFFER_URLS.length });
  await ping('run');
  const products = [];
  const seen = new Set();

  for (const url of OFFER_URLS) {
    try {
      const html = await fetchWithCurl(url);
      if (!html) continue;

      if (isBlocked(html)) {
        log('scrape_blocked', { url, preview: html.substring(0, 200) });
        continue;
      }

      const before = products.length;

      // Primary: Nordic rendering context (_n.ctx.r={...})
      const nordicData = extractJsonAt(html, '_n.ctx.r=');
      if (nordicData) {
        log('scrape_nordic_found', { url });
        const items = nordicData?.appProps?.pageProps?.data?.items
          || nordicData?.appProps?.pageProps?.items
          || nordicData?.initialState?.results?.items
          || [];
        for (const item of items.slice(0, 60)) {
          extractMlCard(item?.card || item, products, seen);
        }
        log('scrape_nordic_parsed', { url, itemsFound: items.length, productsAfter: products.length });
      }

      // Fallback A: __NEXT_DATA__
      if (products.length === before) {
        const nextMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (nextMatch) {
          try {
            const nd = JSON.parse(nextMatch[1]);
            const items = nd?.props?.pageProps?.data?.items
              || nd?.props?.pageProps?.results?.items
              || nd?.props?.pageProps?.items
              || [];
            for (const item of items.slice(0, 60)) extractMlCard(item?.card || item, products, seen);
            log('scrape_next_data', { url, productsAfter: products.length });
          } catch (_) {}
        }
      }

      // Fallback B: __PRELOADED_STATE__
      if (products.length === before) {
        const stateData = extractJsonAt(html, 'window.__PRELOADED_STATE__=');
        if (stateData) {
          const items = stateData?.initialState?.results?.items
            || stateData?.results?.items
            || [];
          for (const item of items.slice(0, 60)) extractMlCard(item?.card || item, products, seen);
          log('scrape_preloaded_state', { url, productsAfter: products.length });
        }
      }

      log('scrape_url_done', { url, newProducts: products.length - before });
      if (products.length >= 30) break;
    } catch (err) {
      log('scrape_url_error', { url, message: err.message });
    }
    await delay(2000 + Math.random() * 1000);
  }

  log('scrape_completed', { productsCount: products.length });
  await ping(products.length > 0 ? 'complete' : 'fail', `&metric=count:${products.length}`);
  return products;
}

function extractMlCard(card, products, seen) {
  if (!card) return;
  try {
    const meta = card.metadata || {};
    const comps = card.components || [];

    // Title from various component shapes
    const rawName = (
      comps.find(c => c.type === 'title')?.title?.text
      || comps.find(c => c.type === 'product_title')?.product_title?.text
      || comps.find(c => c.type === 'label' && c.label?.type === 'title')?.label?.text
      || card.title || meta.title || ''
    );
    const name = cleanTitle(rawName);
    if (!name || name.length < 4) return;

    const rawUrl = meta.url || card.url || '';
    const url = rawUrl ? (rawUrl.startsWith('http') ? rawUrl.split('#')[0] : 'https://' + rawUrl.split('#')[0]) : '';
    if (!url || seen.has(url)) return;
    seen.add(url);

    const priceComp = comps.find(c => c.type === 'price' || c.id === 'price');
    const priceData = priceComp?.price || {};
    const current = priceData.current_price?.value || priceData.amount?.value || 0;
    const original = priceData.previous_price?.value || priceData.original_price?.value || 0;
    const discountPct = priceData.discount?.value || 0;
    if (!current || current <= 0) return;

    const orig = original > current ? original
      : (discountPct > 0 ? Math.round(current / (1 - discountPct / 100)) : 0);
    if (!orig || orig <= current) return;
    const discount = discountPct || Math.round(((orig - current) / orig) * 100);
    if (discount < 1 || discount > 100) return;

    // Image: prefer pictures array (original quality), fallback to card.thumbnail
    const pics = card.pictures?.pictures || [];
    const imgId = pics[0]?.id || '';
    const imageUrl = imgId
      ? `https://http2.mlstatic.com/D_NQ_NP_${imgId}-O.webp`
      : (card.thumbnail || '');

    // SKU: extract ML item ID from URL (e.g. MPE123456789); fallback to URL hash
    const sku = mlSkuFromUrl(url) || urlToSku(url);

    products.push({
      store: STORE,
      name: name.substring(0, 120),
      sku,
      category: guessCategory(name),
      url,
      image_url: imageUrl,
      current_price: current,
      original_price: orig,
      discount_percent: discount,
      stock_info: null,
    });
  } catch (_) {}
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/celular|smartphone|iphone|xiaomi|motorola/.test(n)) return 'Celulares';
  if (/laptop|notebook|computad|tablet|ipad/.test(n)) return 'Computación';
  if (/tv|televisor|smart tv|monitor/.test(n)) return 'Electrónica';
  if (/zapatill|zapato|nike|adidas/.test(n)) return 'Calzado';
  if (/refriger|lavadora|microond|cocina/.test(n)) return 'Electrohogar';
  if (/perfume|crema|maquillaje/.test(n)) return 'Belleza';
  if (/ropa|polo|camisa|vestido|jeans/.test(n)) return 'Moda';
  if (/juguete|lego|muñeca/.test(n)) return 'Juguetes';
  if (/bicicleta|pesa|deporte|gym/.test(n)) return 'Deportes';
  if (/audifonos|auricular|bluetooth|parlante/.test(n)) return 'Electrónica';
  return 'General';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrape, STORE };

if (require.main === module) {
  scrape().then(p => { console.log(`\n--- RESULTADO ---\nProductos: ${p.length}`); console.log(JSON.stringify(p.slice(0, 3), null, 2)); });
}
