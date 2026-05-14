'use strict';
const { execFileSync } = require('child_process');
const { cleanTitle, urlToSku } = require('./utils');

const STORE = 'Ripley';
const URLS = [
  'https://simple.ripley.com.pe/tecnologia/computacion/laptops?sortBy=discount_desc',
  'https://simple.ripley.com.pe/tecnologia/celulares-y-telefonos?sortBy=discount_desc',
  'https://simple.ripley.com.pe/electrohogar/refrigeracion/refrigeradoras?sortBy=discount_desc',
  'https://simple.ripley.com.pe/electrohogar/lavado/lavadoras?sortBy=discount_desc',
  'https://simple.ripley.com.pe/moda/ofertas',
  'https://simple.ripley.com.pe/hogar/ofertas'
];

// curl bypasses Ripley/Cloudflare TLS fingerprint check
function buildArgs(url) {
  return [
    '-s', '-L', '--max-time', '20',
    '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: es-PE,es;q=0.9',
    '-H', 'Referer: https://simple.ripley.com.pe/',
    '--compressed',
    url,
  ];
}

async function fetchWithCurl(url, attempt = 1) {
  try {
    return execFileSync('curl', buildArgs(url), { maxBuffer: 10 * 1024 * 1024, timeout: 25000 }).toString();
  } catch (err) {
    console.error(`[${STORE}] curl error (attempt ${attempt}): ${err.message}`);
    if (attempt < 3) {
      await delay(Math.pow(2, attempt) * 1500 + Math.random() * 1000);
      return fetchWithCurl(url, attempt + 1);
    }
    return null;
  }
}

async function scrape() {
  const products = [];
  const seen = new Set();

  for (const url of URLS) {
    try {
      const html = await fetchWithCurl(url);
      if (!html) continue;

      const items = extractProducts(html);

      for (const item of items) {
        try {
          const name = cleanTitle(item.name || '');
          if (!name || name.length < 3) continue;

          const current = item.priceNumber || 0;
          if (!current || current <= 0) continue;

          const original = parseRipleyPrice(item.oldPrice) || current * 1.3;
          const discount = item.discount || (original > current
            ? Math.round(((original - current) / original) * 100)
            : 0);
          if (discount < 5) continue;

          // SKU: parentProductID is the stable product identifier used to build URLs
          const sku = String(item.parentProductID || '').trim() || null;
          const productUrl = buildUrl(item.name || name, item.parentProductID);
          if (seen.has(productUrl)) continue;
          seen.add(productUrl);

          products.push({
            store: STORE,
            name: name.substring(0, 120),
            sku: sku || urlToSku(productUrl),
            category: guessCategory(name),
            url: productUrl,
            image_url: item.primaryImage || '',
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

function extractProducts(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];
  try {
    const data = JSON.parse(match[1]);
    const fp = data?.props?.pageProps?.findabilityProps;
    return fp?.data?.products || [];
  } catch (_) {
    return [];
  }
}

function parseRipleyPrice(str) {
  if (!str) return 0;
  const clean = String(str).replace(/[^\d,.]/g, '').replace(/,(?=\d{3})/g, '');
  return parseFloat(clean.replace(',', '.')) || 0;
}

function buildUrl(name, parentProductID) {
  if (!parentProductID) return 'https://simple.ripley.com.pe';
  const slug = name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 80);
  return `https://simple.ripley.com.pe/${slug}-${parentProductID.toLowerCase()}`;
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/tv|televisor|monitor|led|qled|oled/.test(n)) return 'Electrónica';
  if (/laptop|computador|notebook|tablet/.test(n)) return 'Computación';
  if (/celular|smartphone|iphone|samsung/.test(n)) return 'Celulares';
  if (/refriger|lavadora|cocina|microond/.test(n)) return 'Electrohogar';
  if (/zapatill|zapato|ropa|polo|camisa/.test(n)) return 'Moda';
  if (/juguete|lego|muñeca|juego/.test(n)) return 'Juguetes';
  if (/sofa|cama|colchon|mesa|silla/.test(n)) return 'Muebles';
  if (/perfume|crema|maquillaje/.test(n)) return 'Belleza';
  if (/bicicleta|pesa|deporte/.test(n)) return 'Deportes';
  return 'Hogar';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrape, STORE };
