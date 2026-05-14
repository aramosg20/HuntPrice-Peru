'use strict';
const axios = require('axios');
const { cleanTitle, cleanScene7Url, urlToSku } = require('./utils');

const STORE = 'Falabella';
const URLS = [
  'https://www.falabella.com.pe/falabella-pe/collection/descuentos',
  'https://www.falabella.com.pe/falabella-pe/collection/descuentos-cmr'
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-PE,es;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.falabella.com.pe/'
};

// Exponential-backoff axios wrapper (3 attempts)
async function axiosFetch(url, attempt = 1) {
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
    return data;
  } catch (err) {
    const status = err.response?.status;
    const retriable = !status || status >= 500 || status === 429 ||
      err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED';
    if (retriable && attempt < 3) {
      await delay(Math.pow(2, attempt) * 1500 + Math.random() * 1000);
      return axiosFetch(url, attempt + 1);
    }
    throw err;
  }
}

async function scrape() {
  const products = [];
  const seen = new Set();

  for (const url of URLS) {
    try {
      const html = await axiosFetch(url);
      const results = extractNextData(html);

      for (const item of results) {
        try {
          const name = cleanTitle(item.displayName || '');
          if (!name || name.length < 3) continue;

          const prices = item.prices || [];
          const salePriceObj  = prices.find(p => !p.crossed);
          const normalPriceObj = prices.find(p => p.crossed);
          const current  = parsePrice((salePriceObj?.price  || [])[0]);
          const original = parsePrice((normalPriceObj?.price || [])[0]) || current * 1.3;
          if (!current || current <= 0) continue;

          const discount = original > current
            ? Math.round(((original - current) / original) * 100)
            : 0;
          if (discount < 5) continue;

          const productUrl = item.url || url;
          if (seen.has(productUrl)) continue;
          seen.add(productUrl);

          // SKU: prefer item.id (product ID from NEXT_DATA), fallback to URL hash
          const sku = String(item.id || item.skuId || '').trim() || urlToSku(productUrl);

          // Image: scene7 URLs — strip resize query params for full resolution
          const rawImage = (item.mediaUrls || [])[0] || (item.images || [])[0]?.url || '';
          const imageUrl = cleanScene7Url(rawImage);

          products.push({
            store: STORE,
            name: name.substring(0, 120),
            sku,
            category: guessCategory(name),
            url: productUrl,
            image_url: imageUrl,
            current_price: current,
            original_price: original,
            discount_percent: discount,
            stock_info: null
          });
        } catch (_) {}
      }
    } catch (err) {
      console.error(`[${STORE}] Error en ${url}:`, err.message);
    }
    await delay(2000 + Math.random() * 2000);
  }
  return products;
}

function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];
  try {
    const data = JSON.parse(match[1]);
    return data?.props?.pageProps?.results || [];
  } catch (_) {
    return [];
  }
}

function parsePrice(str) {
  if (!str && str !== 0) return 0;
  return parseFloat(String(str).replace(/[^\d.]/g, '')) || 0;
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/tv|televisor|pantalla|monitor|led|qled|oled/.test(n)) return 'Electrónica';
  if (/laptop|computador|pc|notebook|tablet|ipad/.test(n)) return 'Computación';
  if (/celular|smartphone|iphone|samsung|xiaomi|motorola/.test(n)) return 'Celulares';
  if (/refriger|lavadora|secadora|cocina|microond|horno/.test(n)) return 'Electrohogar';
  if (/zapatill|zapato|ropa|polo|camisa|pantalon|vestido/.test(n)) return 'Moda';
  if (/juguete|lego|muñeca|juego/.test(n)) return 'Juguetes';
  if (/sofa|cama|colchon|mesa|silla|mueble/.test(n)) return 'Muebles';
  if (/perfume|crema|maquillaje|labial/.test(n)) return 'Belleza';
  if (/bicicleta|pesa|deporte|tenis/.test(n)) return 'Deportes';
  return 'Hogar';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrape, STORE };
