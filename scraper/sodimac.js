'use strict';
const { execFileSync } = require('child_process');
const { cleanTitle, cleanScene7Url, urlToSku } = require('./utils');

const STORE = 'Sodimac';
const BASE = 'https://www.sodimac.com.pe';
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// Sodimac PE migró de ATG/Endeca al stack Next.js del grupo Falabella (mayo 2026).
// Las URLs antiguas (/category/, /collection/, ?format=json) devuelven 301 al homepage.
// La nueva URL de ofertas expone __NEXT_DATA__ con estructura idéntica a Falabella.
const OFFERS_URL = `${BASE}/sodimac-pe/seleccion/ofertas-sodimac`;

function log(event, data = {}) {
  console.log(JSON.stringify({ level: 'info', store: STORE, event, timestamp: new Date().toISOString(), ...data }));
}

async function ping(state, extra = '') {
  const key = process.env.CRONITOR_API_KEY;
  if (!key) return;
  try { await fetch(`https://cronitor.link/p/${key}/huntprice-scraper-sodimac?state=${state}${extra}`); } catch (_) {}
}

function buildArgs(url) {
  return [
    '-s', '-L', '--max-time', '30',
    '-H', `User-Agent: ${UA}`,
    '-H', 'Accept: text/html,application/xhtml+xml,*/*;q=0.9',
    '-H', 'Accept-Language: es-PE,es;q=0.9,en;q=0.8',
    '-H', 'Accept-Encoding: gzip, deflate, br',
    '-H', `Referer: ${BASE}/sodimac-pe`,
    '-H', 'sec-ch-ua: "Chromium";v="124", "Not-A.Brand";v="99"',
    '-H', 'sec-ch-ua-mobile: ?1',
    '-H', 'sec-ch-ua-platform: "Android"',
    '-H', 'sec-fetch-dest: document',
    '-H', 'sec-fetch-mode: navigate',
    '-H', 'sec-fetch-site: same-origin',
    '-H', 'sec-fetch-user: ?1',
    '-H', 'upgrade-insecure-requests: 1',
    '--compressed',
    url,
  ];
}

async function fetchPage(url, attempt = 1) {
  try {
    const raw = execFileSync('curl', buildArgs(url), { maxBuffer: 15 * 1024 * 1024, timeout: 35000 }).toString();
    log('scrape_response', { url, bytes: raw.length, attempt });
    return raw;
  } catch (err) {
    log('scrape_fetch_error', { url, message: err.message, attempt });
    if (attempt < 3) {
      await delay(Math.pow(2, attempt) * 1000 + Math.random() * 1000);
      return fetchPage(url, attempt + 1);
    }
    return null;
  }
}

function parsePrice(val) {
  if (!val) return 0;
  if (Array.isArray(val)) val = val[0];
  return parseFloat(String(val).replace(/[^\d.]/g, '')) || 0;
}

function extractProducts(results) {
  const products = [];
  const seen = new Set();

  for (const item of results) {
    try {
      const name = cleanTitle(item.displayName || '');
      if (!name || name.length < 3) continue;

      const url = item.url || '';
      if (!url || seen.has(url)) continue;
      seen.add(url);

      const prices = item.prices || [];
      const saleObj = prices.find(p => !p.crossed);
      const normalObj = prices.find(p => p.crossed);
      const current = parsePrice(saleObj?.price);
      const original = parsePrice(normalObj?.price);
      if (!current || current <= 0) continue;
      if (!original || original <= current) continue;

      const discount = Math.round(((original - current) / original) * 100);
      if (discount < 1 || discount > 100) continue;

      // Sodimac uses same scene7 CDN as Falabella — strip resize query params
      const image = cleanScene7Url((item.mediaUrls || [])[0] || '');
      const sku = urlToSku(url.startsWith('http') ? url : BASE + url);

      products.push({
        store: STORE,
        name: name.substring(0, 120),
        sku,
        category: guessCategory(name),
        url: url.startsWith('http') ? url : BASE + url,
        image_url: image,
        current_price: current,
        original_price: Math.round(original * 100) / 100,
        discount_percent: discount,
        stock_info: null,
      });
    } catch (_) {}
  }
  return products;
}

async function scrape() {
  log('scrape_started', { url: OFFERS_URL });
  await ping('run');

  try {
    const html = await fetchPage(OFFERS_URL);
    if (!html) {
      log('scrape_failed', { message: 'no_html' });
      await ping('fail', '&message=no_html');
      return [];
    }

    const nextMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!nextMatch) {
      log('scrape_no_next_data', { preview: html.substring(0, 300).replace(/\n/g, ' ') });
      await ping('fail', '&message=no_next_data');
      return [];
    }

    let data;
    try {
      data = JSON.parse(nextMatch[1]);
    } catch (e) {
      log('scrape_parse_error', { message: e.message });
      await ping('fail', '&message=json_parse_error');
      return [];
    }

    const results = data?.props?.pageProps?.results;
    if (!Array.isArray(results) || results.length === 0) {
      log('scrape_no_results', { keys: Object.keys(data?.props?.pageProps || {}).join(',') });
      await ping('fail', '&message=no_results_array');
      return [];
    }

    log('scrape_parsed', { itemsFound: results.length });
    const products = extractProducts(results);
    log('scrape_completed', { productsCount: products.length, rawItems: results.length });
    await ping('complete', `&metric=count:${products.length}`);
    return products;
  } catch (err) {
    log('scrape_failed', { message: err.message });
    await ping('fail', `&message=${encodeURIComponent(err.message.substring(0, 100))}`);
    return [];
  }
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/pintura|brocha|rodillo/.test(n)) return 'Construcción';
  if (/taladro|sierra|martillo|llave|herramienta/.test(n)) return 'Herramientas';
  if (/sofa|cama|colchon|mesa|silla|mueble|closet/.test(n)) return 'Muebles';
  if (/jardin|planta|maceta|manguera/.test(n)) return 'Jardín';
  if (/lavadora|refriger|cocina|horno|microond/.test(n)) return 'Electrohogar';
  if (/lamp|foco|iluminacion/.test(n)) return 'Iluminación';
  if (/piso|ceramica|porcelanato/.test(n)) return 'Pisos';
  if (/tv|televisor|smart tv/.test(n)) return 'Electrónica';
  return 'Hogar';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrape, STORE };

if (require.main === module) {
  scrape().then(p => { console.log(`\n--- RESULTADO ---\nProductos: ${p.length}`); console.log(JSON.stringify(p.slice(0, 3), null, 2)); });
}
