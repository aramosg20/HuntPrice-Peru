'use strict';
const { execFileSync } = require('child_process');
const { cleanTitle, cleanScene7Url, urlToSku } = require('./utils');
const { runProgressiveScrape } = require('./engine');

const STORE = 'Sodimac';
const BASE  = 'https://www.sodimac.com.pe';
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// /lista/ routes are standard SSR catalog views — __NEXT_DATA__ carries the full
// product grid on the first HTML response, no JavaScript execution required.
const CATEGORIAS_BASE = [
  `${BASE}/sodimac-pe/lista/cat40485/Ropero`,
  `${BASE}/sodimac-pe/lista/cat10260/refrigeradoras`,
  `${BASE}/sodimac-pe/lista/cat10252/lavadoras`,
  `${BASE}/sodimac-pe/lista/cat10060/taladros`,
  `${BASE}/sodimac-pe/lista/cat10884/porcelanatos`,
  `${BASE}/sodimac-pe/lista/cat10050/iluminacion-interior`,
];

const HOME_MARKERS = ['<title>Sodimac | Todo para tu hogar</title>', '"sodimac-pe"'];

function buildCurlArgs(url) {
  return [
    '-s', '-L', '--max-time', '30',
    '-H', `User-Agent: ${UA}`,
    '-H', 'Accept: text/html,application/xhtml+xml,*/*;q=0.9',
    '-H', 'Accept-Language: es-PE,es;q=0.9,en;q=0.8',
    '-H', 'Accept-Encoding: gzip, deflate, br',
    '-H', `Referer: ${BASE}/sodimac-pe`,
    '--compressed',
    url,
  ];
}

async function fetchWithCurl(url, attempt = 1) {
  try {
    return execFileSync('curl', buildCurlArgs(url), { maxBuffer: 15 * 1024 * 1024, timeout: 35000 }).toString();
  } catch (err) {
    if (attempt < 3) {
      await delay(Math.pow(2, attempt) * 1000 + Math.random() * 1000);
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

function extractItems(html) {
  const match = html && html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];
  let data;
  try { data = JSON.parse(match[1]); } catch (_) { return []; }

  const pp = data?.props?.pageProps;
  // Try all known Falabella/Sodimac stack shapes
  const results = (
    pp?.results ||
    pp?.initialState?.results ||
    pp?.initialState?.search?.results ||
    pp?.searchResults?.results ||
    pp?.initialData?.data?.results ||
    pp?.data?.results ||
    []
  );
  if (!Array.isArray(results) || results.length === 0) return [];

  const out  = [];
  const seen = new Set();
  for (const item of results) {
    try {
      const name = cleanTitle(item.displayName || '');
      if (!name || name.length < 3) continue;

      const rawUrl = item.url || '';
      if (!rawUrl || seen.has(rawUrl)) continue;
      seen.add(rawUrl);

      const prices   = item.prices || [];
      const saleObj  = prices.find(p => !p.crossed);
      const normObj  = prices.find(p =>  p.crossed);
      const current  = parsePrice(saleObj?.price);
      const original = parsePrice(normObj?.price);
      if (!current || !original || original <= current) continue;

      const discount = Math.round(((original - current) / original) * 100);
      if (discount < 1 || discount > 100) continue;

      const fullUrl = rawUrl.startsWith('http') ? rawUrl : BASE + rawUrl;
      out.push({
        store: STORE, name: name.substring(0, 120),
        sku: urlToSku(fullUrl),
        category: guessCategory(name),
        url: fullUrl,
        image_url: cleanScene7Url((item.mediaUrls || [])[0] || ''),
        current_price: current,
        original_price: Math.round(original * 100) / 100,
        discount_percent: discount,
        stock_info: null,
      });
    } catch (_) {}
  }
  return out;
}

async function scrape() {
  return runProgressiveScrape({
    store: STORE, categorias: CATEGORIAS_BASE,
    homeMarkers: HOME_MARKERS,
    fetchPage, extractItems,
  });
}

function parsePrice(val) {
  if (!val) return 0;
  if (Array.isArray(val)) val = val[0];
  return parseFloat(String(val).replace(/[^\d.]/g, '')) || 0;
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/pintura|brocha|rodillo/.test(n))                     return 'Construcción';
  if (/taladro|sierra|martillo|llave|herramienta/.test(n))  return 'Herramientas';
  if (/sofa|cama|colchon|mesa|silla|mueble|closet|ropero/.test(n)) return 'Muebles';
  if (/jardin|planta|maceta|manguera/.test(n))              return 'Jardín';
  if (/lavadora|refriger|cocina|horno|microond/.test(n))    return 'Electrohogar';
  if (/lamp|foco|iluminacion/.test(n))                      return 'Iluminación';
  if (/piso|ceramica|porcelanato/.test(n))                  return 'Pisos';
  if (/tv|televisor|smart tv/.test(n))                      return 'Electrónica';
  return 'Hogar';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrape, STORE };

if (require.main === module) {
  scrape().then(p => { console.log(`\n--- RESULTADO ---\nProductos: ${p.length}`); console.log(JSON.stringify(p.slice(0, 3), null, 2)); });
}
