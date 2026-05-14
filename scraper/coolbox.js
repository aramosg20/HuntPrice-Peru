'use strict';
const axios = require('axios');
const { cleanTitle, normalizeVtexImage, urlToSku } = require('./utils');
const { runProgressiveScrape } = require('./engine');

const STORE = 'Coolbox';
const BASE  = 'https://www.coolbox.pe';

// VTEX catalog API — category paths for a tech-focused retailer.
// Paths that don't exist in Coolbox's VTEX catalog return [] silently.
const CATEGORIAS_BASE = [
  `${BASE}/api/catalog_system/pub/products/search/`,
  `${BASE}/api/catalog_system/pub/products/search/Celulares/`,
  `${BASE}/api/catalog_system/pub/products/search/Laptops/`,
  `${BASE}/api/catalog_system/pub/products/search/Tablets/`,
  `${BASE}/api/catalog_system/pub/products/search/Gaming/`,
  `${BASE}/api/catalog_system/pub/products/search/Audio/`,
  `${BASE}/api/catalog_system/pub/products/search/Accesorios/`,
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'application/json, */*;q=0.8',
  'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
  'Referer': `${BASE}/`,
  'Origin': BASE,
  'sec-ch-ua-mobile': '?1',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

const VTEX_IO_URL = `${BASE}/_v/api/intelligent-search/product_search/`;
const PAGE_SIZE   = 48;

async function fetchVtex(url, params, attempt = 1) {
  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: 25000, params, validateStatus: () => true });
    if (resp.status === 200 || resp.status === 206) return resp.data;
    if ([403, 429, 503].includes(resp.status) && attempt < 3) {
      await delay(Math.pow(2, attempt) * 1500 + Math.random() * 1000);
      return fetchVtex(url, params, attempt + 1);
    }
    return null;
  } catch (err) {
    if (attempt < 3) {
      await delay(Math.pow(2, attempt) * 1500);
      return fetchVtex(url, params, attempt + 1);
    }
    return null;
  }
}

async function fetchPage(url, pageNum) {
  const from = (pageNum - 1) * PAGE_SIZE;
  const data = await fetchVtex(url, { O: 'OrderByBestDiscountDESC', _from: from, _to: from + PAGE_SIZE - 1 });
  // Plan B: VTEX IO intelligent-search if legacy returns nothing on p1
  if ((!data || !Array.isArray(data) || data.length === 0) && pageNum === 1) {
    const io = await fetchVtex(VTEX_IO_URL, { query: '', sort: 'discount_desc', page: 1, count: PAGE_SIZE, fuzzy: '0', locale: 'es-PE' });
    return io?.products || io?.data?.products || null;
  }
  return data;
}

function extractItems(data) {
  if (!data) return [];
  const rows = Array.isArray(data) ? data : (data.products || data.data?.products || []);
  if (!rows.length) return [];
  const out = [];
  for (const p of rows) {
    try {
      const name = cleanTitle(p.productName || p.name || '');
      const link = p.link || p.url || '';
      if (!name || !link) continue;

      const item   = (p.items || [])[0] || {};
      const seller = (item.sellers || [])[0] || {};
      const offer  = seller.commertialOffer || {};

      const current  = offer.Price || 0;
      const original = offer.ListPrice || 0;
      if (!current || current <= 0) continue;
      if (offer.IsAvailable === false) continue;
      if (original <= current || original > current * 30) continue;

      const discount = Math.round(((original - current) / original) * 100);
      if (discount < 1) continue;

      const sku      = String(item.itemId || p.productId || '').trim() || urlToSku(link);
      const imageUrl = normalizeVtexImage(((item.images || [])[0] || {}).imageUrl || '');

      out.push({
        store: STORE, name: name.substring(0, 120), sku,
        category: guessCategory(name),
        url: link.startsWith('http') ? link : BASE + link,
        image_url: imageUrl, current_price: current, original_price: original,
        discount_percent: discount, stock_info: null,
      });
    } catch (_) {}
  }
  return out;
}

async function scrape() {
  return runProgressiveScrape({ store: STORE, categorias: CATEGORIAS_BASE, fetchPage, extractItems });
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/celular|smartphone|iphone|xiaomi|motorola|galaxy/.test(n)) return 'Celulares';
  if (/laptop|notebook|computad|tablet|ipad/.test(n))             return 'Computación';
  if (/tv|televisor|smart tv|monitor/.test(n))                    return 'Electrónica';
  if (/audifonos|auricular|bluetooth|airpods/.test(n))            return 'Electrónica';
  if (/gaming|gamer|consola|playstation|xbox|nintendo/.test(n))   return 'Gaming';
  if (/impresora|camara/.test(n))                                 return 'Computación';
  if (/lavadora|refrigerador|microondas/.test(n))                 return 'Electrohogar';
  return 'Tecnología';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrape, STORE };

if (require.main === module) {
  scrape().then(p => { console.log(`\n--- RESULTADO ---\nProductos: ${p.length}`); console.log(JSON.stringify(p.slice(0, 3), null, 2)); });
}
