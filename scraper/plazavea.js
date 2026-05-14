'use strict';
const axios = require('axios');
const { cleanTitle, normalizeVtexImage, urlToSku } = require('./utils');

const STORE = 'PlazaVea';
const BASE = 'https://www.plazavea.com.pe';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'application/json, */*;q=0.8',
  'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': `${BASE}/ofertas`,
  'Origin': BASE,
  'sec-ch-ua': '"Chromium";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

const VTEX_SEARCH_URL = `${BASE}/api/catalog_system/pub/products/search/`;
const VTEX_IO_URL = `${BASE}/_v/api/intelligent-search/product_search/`;

// PlazaVea search terms for supermarket categories with discounts
const SEARCH_TERMS = ['', 'oferta', 'tecnologia', 'bebidas', 'lacteos'];

function log(event, data = {}) {
  console.log(JSON.stringify({ level: 'info', store: STORE, event, timestamp: new Date().toISOString(), ...data }));
}

async function ping(state, extra = '') {
  const key = process.env.CRONITOR_API_KEY;
  if (!key) return;
  try { await fetch(`https://cronitor.link/p/${key}/huntprice-scraper-plazavea?state=${state}${extra}`); } catch (_) {}
}

async function fetchVtex(url, params, attempt = 1) {
  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: 25000, params, validateStatus: () => true });
    log('scrape_response', { url, status: resp.status, attempt });
    // VTEX returns 206 Partial Content for paginated responses — that's valid data
    if (resp.status === 200 || resp.status === 206) return resp.data;
    if ([403, 429, 503].includes(resp.status) && attempt < 3) {
      const ms = Math.pow(2, attempt) * 1500 + Math.random() * 1000;
      log('scrape_retry', { status: resp.status, attempt, delayMs: Math.round(ms) });
      await delay(ms);
      return fetchVtex(url, params, attempt + 1);
    }
    log('scrape_bad_status', { url, status: resp.status, preview: String(resp.data).substring(0, 300) });
    return null;
  } catch (err) {
    log('scrape_fetch_error', { url, message: err.message, attempt });
    if (attempt < 3) {
      await delay(Math.pow(2, attempt) * 1500);
      return fetchVtex(url, params, attempt + 1);
    }
    return null;
  }
}

async function scrape() {
  log('scrape_started', { url: VTEX_SEARCH_URL });
  await ping('run');
  const products = [];
  const seen = new Set();
  const pageSize = 48;

  // Attempt 1: Legacy VTEX catalog API sorted by best discount
  for (let from = 0; from < 96; from += pageSize) {
    const params = { O: 'OrderByBestDiscountDESC', _from: from, _to: from + pageSize - 1 };
    const data = await fetchVtex(VTEX_SEARCH_URL, params);

    if (!Array.isArray(data) || data.length === 0) {
      log('scrape_vtex_empty', { from });
      break;
    }

    log('scrape_parsed', { from, itemsFound: data.length });
    for (const p of data) {
      try {
        const name = cleanTitle(p.productName || '');
        const link = p.link || '';
        if (!name || !link || seen.has(link)) continue;
        seen.add(link);

        const item = (p.items || [])[0] || {};
        const seller = (item.sellers || [])[0] || {};
        const offer = seller.commertialOffer || {};

        const current = offer.Price || 0;
        const original = offer.ListPrice || 0;
        if (!current || current <= 0) continue;
        if (offer.IsAvailable === false) continue;
        if (original > current * 30 || original <= current) continue;

        const discount = Math.round(((original - current) / original) * 100);
        if (discount < 1 || discount > 100) continue;

        const sku = String(item.itemId || p.productId || '').trim() || urlToSku(link);
        const imageUrl = normalizeVtexImage(((item.images || [])[0] || {}).imageUrl || '');
        products.push({
          store: STORE,
          name: name.substring(0, 120),
          sku,
          category: guessCategory(name),
          url: link.startsWith('http') ? link : BASE + link,
          image_url: imageUrl,
          current_price: current,
          original_price: original,
          discount_percent: discount,
          stock_info: null,
        });
      } catch (_) {}
    }
    if (data.length < pageSize) break;
    await delay(2500 + Math.random() * 1500);
  }

  // Attempt 2: VTEX IO intelligent-search fallback
  if (products.length < 5) {
    log('scrape_fallback_vtex_io', {});
    try {
      const ioParams = { query: '', sort: 'discount_desc', page: 1, count: 48, fuzzy: '0', locale: 'es-PE' };
      const data = await fetchVtex(VTEX_IO_URL, ioParams);
      const items = data?.products || data?.data?.products || [];
      log('scrape_vtex_io_items', { count: items.length });
      for (const p of items) {
        try {
          const name = cleanTitle(p.productName || p.name || '');
          const link = p.link || p.url || '';
          if (!name || !link || seen.has(link)) continue;
          seen.add(link);
          const offers = p.items?.[0]?.sellers?.[0]?.commertialOffer || {};
          const current = offers.Price || 0;
          const original = offers.ListPrice || 0;
          if (!current || original <= current) continue;
          const discount = Math.round(((original - current) / original) * 100);
          if (discount < 1 || discount > 100) continue;
          const sku = String(p.items?.[0]?.itemId || p.productId || '').trim() || urlToSku(link);
          const imageUrl = normalizeVtexImage(p.items?.[0]?.images?.[0]?.imageUrl || '');
          products.push({
            store: STORE, name: name.substring(0, 120), sku, category: guessCategory(name),
            url: link.startsWith('http') ? link : BASE + link,
            image_url: imageUrl, current_price: current, original_price: original,
            discount_percent: discount, stock_info: null,
          });
        } catch (_) {}
      }
    } catch (err) {
      log('scrape_vtex_io_error', { message: err.message });
    }
  }

  log('scrape_completed', { productsCount: products.length });
  await ping(products.length > 0 ? 'complete' : 'fail', `&metric=count:${products.length}`);
  return products;
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/leche|yogur|queso|mantequilla/.test(n)) return 'Lácteos';
  if (/arroz|fideos|azucar|aceite|harina/.test(n)) return 'Abarrotes';
  if (/shampoo|jabon|crema|dental/.test(n)) return 'Cuidado Personal';
  if (/detergente|limpiador|lejia/.test(n)) return 'Limpieza';
  if (/cerveza|vino|bebida|gaseosa/.test(n)) return 'Bebidas';
  if (/pañal|toalla|papel/.test(n)) return 'Bebé';
  if (/snack|galleta|chocolate/.test(n)) return 'Snacks';
  if (/tv|laptop|celular|tablet/.test(n)) return 'Tecnología';
  return 'Supermercado';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrape, STORE };

if (require.main === module) {
  scrape().then(p => { console.log(`\n--- RESULTADO ---\nProductos: ${p.length}`); console.log(JSON.stringify(p.slice(0, 3), null, 2)); });
}
