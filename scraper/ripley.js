'use strict';
const { execFileSync } = require('child_process');
const { cleanTitle, urlToSku } = require('./utils');
const { runProgressiveScrape } = require('./engine');

const STORE = 'Ripley';
const BASE  = 'https://simple.ripley.com.pe';

// Subcategory URLs with sortBy=discount_desc — direct product grids (no landing pages).
// curl bypasses Ripley/Cloudflare TLS fingerprint check.
const CATEGORIAS_BASE = [
  `${BASE}/tecnologia/computacion/laptops?sortBy=discount_desc`,
  `${BASE}/tecnologia/computacion/pc-escritorio?sortBy=discount_desc`,
  `${BASE}/tecnologia/celulares-y-telefonos?sortBy=discount_desc`,
  `${BASE}/tecnologia/tv-y-video?sortBy=discount_desc`,
  `${BASE}/electrohogar/refrigeracion/refrigeradoras?sortBy=discount_desc`,
  `${BASE}/electrohogar/lavado/lavadoras?sortBy=discount_desc`,
  `${BASE}/electrohogar/audio-y-video?sortBy=discount_desc`,
  `${BASE}/moda/calzado?sortBy=discount_desc`,
  `${BASE}/moda/ofertas`,
  `${BASE}/hogar/ofertas`,
  `${BASE}/deportes?sortBy=discount_desc`,
  `${BASE}/juguetes?sortBy=discount_desc`,
];

// Home-redirect marker: Ripley shows this title when we hit the homepage instead of a category
const HOME_MARKERS = ['<title>Ripley - Todo lo que necesitas', '<title>Ripley | '];

function buildCurlArgs(url) {
  return [
    '-s', '-L', '--max-time', '20',
    '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: es-PE,es;q=0.9',
    '-H', `Referer: ${BASE}/`,
    '--compressed',
    url,
  ];
}

async function fetchWithCurl(url, attempt = 1) {
  try {
    return execFileSync('curl', buildCurlArgs(url), { maxBuffer: 10 * 1024 * 1024, timeout: 25000 }).toString();
  } catch (err) {
    if (attempt < 3) {
      await delay(Math.pow(2, attempt) * 1500 + Math.random() * 1000);
      return fetchWithCurl(url, attempt + 1);
    }
    return null;
  }
}

async function fetchPage(url, pageNum) {
  try {
    const u = new URL(url);
    if (pageNum > 1) u.searchParams.set('page', String(pageNum));
    return fetchWithCurl(u.href);
  } catch (_) { return null; }
}

function extractItems(html, sourceUrl) {
  const match = html && html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];
  try {
    const data = JSON.parse(match[1]);
    const raw  = data?.props?.pageProps?.findabilityProps?.data?.products || [];
    return raw.map(item => {
      const name = cleanTitle(item.name || '');
      if (!name || name.length < 3) return null;

      const current  = item.priceNumber || 0;
      if (!current || current <= 0) return null;

      const original = parseRipleyPrice(item.oldPrice) || Math.round(current * 1.3);
      const discount = item.discount || (original > current
        ? Math.round(((original - current) / original) * 100) : 0);
      if (discount < 5) return null;

      const productUrl = buildProductUrl(item.name, item.parentProductID);
      return {
        store: STORE, name: name.substring(0, 120),
        sku: String(item.parentProductID || '').trim() || urlToSku(productUrl),
        category: guessCategory(name),
        url: productUrl,
        image_url: item.primaryImage || '',
        current_price: current, original_price: original,
        discount_percent: discount, stock_info: null,
      };
    }).filter(Boolean);
  } catch (_) { return []; }
}

async function scrape() {
  return runProgressiveScrape({
    store: STORE, categorias: CATEGORIAS_BASE,
    homeMarkers: HOME_MARKERS,
    fetchPage, extractItems,
  });
}

function parseRipleyPrice(str) {
  if (!str) return 0;
  const clean = String(str).replace(/[^\d,.]/g, '').replace(/,(?=\d{3})/g, '');
  return parseFloat(clean.replace(',', '.')) || 0;
}

function buildProductUrl(name, parentProductID) {
  if (!parentProductID) return BASE;
  const slug = (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '').trim()
    .replace(/\s+/g, '-').replace(/-+/g, '-').substring(0, 80);
  return `${BASE}/${slug}-${String(parentProductID).toLowerCase()}`;
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/tv|televisor|monitor|led|qled|oled/.test(n)) return 'Electrónica';
  if (/laptop|computador|notebook|tablet/.test(n))  return 'Computación';
  if (/celular|smartphone|iphone|samsung/.test(n))  return 'Celulares';
  if (/refriger|lavadora|cocina|microond/.test(n))  return 'Electrohogar';
  if (/zapatill|zapato|ropa|polo|camisa/.test(n))   return 'Moda';
  if (/juguete|lego|muñeca|juego/.test(n))          return 'Juguetes';
  if (/sofa|cama|colchon|mesa|silla/.test(n))       return 'Muebles';
  if (/perfume|crema|maquillaje/.test(n))           return 'Belleza';
  if (/bicicleta|pesa|deporte/.test(n))             return 'Deportes';
  return 'Hogar';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrape, STORE };
