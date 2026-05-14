'use strict';
const axios = require('axios');
const { cleanTitle, normalizeVtexImage, urlToSku } = require('./utils');
const { runProgressiveScrape } = require('./engine');

const STORE = 'Oechsle';
const BASE  = 'https://www.oechsle.pe';

// VTEX catalog API paths — each scoped to a department for progressive coverage.
// Paths that don't exist in Oechsle's VTEX catalog return [] silently.
const CATEGORIAS_BASE = [
  `${BASE}/api/catalog_system/pub/products/search/`,
  `${BASE}/api/catalog_system/pub/products/search/Calzado/`,
  `${BASE}/api/catalog_system/pub/products/search/Moda/`,
  `${BASE}/api/catalog_system/pub/products/search/Belleza/`,
  `${BASE}/api/catalog_system/pub/products/search/Electrodomesticos/`,
  `${BASE}/api/catalog_system/pub/products/search/Juguetes/`,
  `${BASE}/api/catalog_system/pub/products/search/Hogar/`,
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'es-PE,es;q=0.9',
  'Referer': `${BASE}/`,
};

const PAGE_SIZE = 48;

async function fetchVtex(url, params, attempt = 1) {
  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: 20000, params, validateStatus: () => true });
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
  return fetchVtex(url, { O: 'OrderByBestDiscountDESC', _from: from, _to: from + PAGE_SIZE - 1 });
}

function extractItems(data) {
  if (!Array.isArray(data) || data.length === 0) return [];
  const out = [];
  for (const p of data) {
    try {
      const name = cleanTitle(p.productName || '');
      const link = p.link || '';
      if (!name || !link) continue;

      const item   = (p.items || [])[0] || {};
      const seller = (item.sellers || [])[0] || {};
      const offer  = seller.commertialOffer || {};

      const current  = offer.Price || 0;
      const original = offer.ListPrice || 0;
      if (!current || current <= 0 || !offer.IsAvailable) continue;
      if (original <= current || original > current * 30) continue;

      const discount = Math.round(((original - current) / original) * 100);
      if (discount < 5) continue;

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
  if (/ropa|polo|camisa|pantalon|vestido|blusa|chompa/.test(n)) return 'Moda';
  if (/zapato|zapatill|bota|sandalia/.test(n))                  return 'Calzado';
  if (/perfume|crema|maquillaje|labial|base|serum/.test(n))     return 'Belleza';
  if (/tv|televisor|laptop|tablet|celular|smartphone/.test(n))  return 'Electrónica';
  if (/juguete|muñeca|lego/.test(n))                            return 'Juguetes';
  if (/sofa|cama|colchon|silla|mesa/.test(n))                   return 'Muebles';
  return 'Hogar';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrape, STORE };
