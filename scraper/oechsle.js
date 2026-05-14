'use strict';
const axios = require('axios');
const { cleanTitle, normalizeVtexImage, urlToSku } = require('./utils');

const STORE = 'Oechsle';
const BASE = 'https://www.oechsle.pe';
const API_URL = `${BASE}/api/catalog_system/pub/products/search/`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'es-PE,es;q=0.9',
  'Referer': BASE + '/'
};

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
    console.error(`[${STORE}] fetch error (attempt ${attempt}):`, err.message);
    if (attempt < 3) {
      await delay(Math.pow(2, attempt) * 1500);
      return fetchVtex(url, params, attempt + 1);
    }
    return null;
  }
}

async function scrape() {
  const products = [];
  const seen = new Set();
  const pageSize = 48;

  for (let from = 0; from < 96; from += pageSize) {
    const data = await fetchVtex(API_URL, { O: 'OrderByBestDiscountDESC', _from: from, _to: from + pageSize - 1 });
    if (!Array.isArray(data) || data.length === 0) break;

    for (const p of data) {
      try {
        const name = cleanTitle(p.productName || '');
        const link = p.link || '';
        if (!name || !link) continue;
        if (seen.has(link)) continue;
        seen.add(link);

        const item = (p.items || [])[0] || {};
        const seller = (item.sellers || [])[0] || {};
        const offer = seller.commertialOffer || {};

        const current = offer.Price || 0;
        const original = offer.ListPrice || 0;
        if (!current || current <= 0 || !offer.IsAvailable) continue;
        if (original > current * 30 || original <= current) continue;

        const discount = Math.round(((original - current) / original) * 100);
        if (discount < 5) continue;

        // SKU: VTEX itemId is the variant-level identifier
        const sku = String(item.itemId || p.productId || '').trim() || urlToSku(link);
        const imageUrl = normalizeVtexImage(((item.images || [])[0] || {}).imageUrl || '');

        products.push({
          store: STORE,
          name: name.substring(0, 120),
          sku,
          category: guessCategory(name),
          url: link,
          image_url: imageUrl,
          current_price: current,
          original_price: original,
          discount_percent: discount,
          stock_info: null
        });
      } catch (_) {}
    }
    if (data.length < pageSize) break;
    await delay(2000 + Math.random() * 2000);
  }
  return products;
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/ropa|polo|camisa|pantalon|vestido|blusa|chompa/.test(n)) return 'Moda';
  if (/zapato|zapatill|bota|sandalia/.test(n)) return 'Calzado';
  if (/perfume|crema|maquillaje|labial|base|serum/.test(n)) return 'Belleza';
  if (/tv|televisor|laptop|tablet|celular|smartphone/.test(n)) return 'Electrónica';
  if (/juguete|muñeca|lego/.test(n)) return 'Juguetes';
  if (/sofa|cama|colchon|silla|mesa/.test(n)) return 'Muebles';
  return 'Hogar';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrape, STORE };
