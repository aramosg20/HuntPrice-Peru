'use strict';
/**
 * HuntPrice — Progressive Scraper Engine
 *
 * Provides store-agnostic queue management:
 *   • Cursor persistence  — round-robin JSON file per store
 *   • Batch selection     — BATCH_SIZE categories per cron run
 *   • Concurrency pool    — max CONCURRENCY workers simultaneously
 *   • Pagination loop     — up to MAX_PAGES per URL in fast mode
 *   • Jitter delays       — polite rate limiting between requests
 *   • Anti-bot guards     — captcha + home-redirect detection
 *
 * Each scraper adapter exposes:
 *   STORE           — store display name (used for cursor file name)
 *   CATEGORIAS_BASE — string[] of safe, verified URLs (no landing-page redirects)
 *   fetchPage(url, pageNum) → rawData | null
 *   extractItems(rawData, url, pageNum) → HuntPrice Product[]
 */

const path = require('path');
const fs   = require('fs');

const BATCH_SIZE  = 5;
const MAX_PAGES   = 5;
const CONCURRENCY = 3;

const CAPTCHA_MARKERS = [
  'captcha', 'cf-challenge', 'cf_chl_', 'ddos-guard',
  'are you a robot', 'checking your browser',
  'access denied', 'unusual traffic', 'just a moment',
];

// ── Cursor I/O ─────────────────────────────────────────────────────────────────

function cursorPath(store) {
  const slug = store.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  return path.join(__dirname, `${slug}_cursor.json`);
}

function readCursor(store) {
  try { return JSON.parse(fs.readFileSync(cursorPath(store), 'utf8')); }
  catch (_) { return { lastCategoryIndex: 0 }; }
}

function writeCursor(store, nextIndex) {
  try {
    fs.writeFileSync(cursorPath(store),
      JSON.stringify({ lastCategoryIndex: nextIndex, updatedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error(`[Engine/${store}] cursor write error: ${err.message}`);
  }
}

// ── Batch selection (round-robin) ──────────────────────────────────────────────

function selectBatch(categorias, store, batchSize) {
  const cursor   = readCursor(store);
  const total    = categorias.length;
  const startIdx = cursor.lastCategoryIndex % total;
  const batch    = Array.from({ length: batchSize }, (_, i) =>
    categorias[(startIdx + i) % total]
  );
  const nextIdx  = (startIdx + batchSize) % total;
  return { batch, startIdx, nextIdx };
}

// ── Concurrency pool ───────────────────────────────────────────────────────────

async function runWithConcurrency(items, limit, fn) {
  const queue = items.slice();
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item !== undefined) await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ── Delays ─────────────────────────────────────────────────────────────────────

function jitter(base, extra = 0) {
  return new Promise(r => setTimeout(r, base + Math.random() * extra));
}

// ── Anti-bot detection ─────────────────────────────────────────────────────────

function isCaptcha(content) {
  if (typeof content !== 'string') return false;
  const lower = content.toLowerCase();
  return CAPTCHA_MARKERS.some(m => lower.includes(m));
}

function isHomePage(content, markers) {
  if (!markers || !markers.length || typeof content !== 'string') return false;
  const lower = content.toLowerCase();
  return markers.some(m => lower.includes(m.toLowerCase()));
}

// ── Main progressive runner ────────────────────────────────────────────────────

/**
 * @param {object}   cfg
 * @param {string}   cfg.store
 * @param {string[]} cfg.categorias
 * @param {number}   [cfg.batchSize=5]       URLs per cron run
 * @param {number}   [cfg.maxPages=5]        pages per URL
 * @param {number}   [cfg.concurrency=3]     workers in parallel
 * @param {number[]} [cfg.pageDelay]         [base, jitter] ms between pages
 * @param {number[]} [cfg.catDelay]          [base, jitter] ms between categories
 * @param {string[]} [cfg.homeMarkers]       HTML markers indicating a home redirect
 * @param {Function} cfg.fetchPage           async (url, pageNum) → rawData | null
 * @param {Function} cfg.extractItems        (rawData, url, pageNum) → Product[]
 */
async function runProgressiveScrape(cfg) {
  const {
    store,
    categorias,
    batchSize   = BATCH_SIZE,
    maxPages    = MAX_PAGES,
    concurrency = CONCURRENCY,
    pageDelay   = [1000, 1500],
    catDelay    = [2500, 2000],
    homeMarkers = [],
    fetchPage,
    extractItems,
  } = cfg;

  const products = [];
  const seen     = new Set();
  const { batch, startIdx, nextIdx } = selectBatch(categorias, store, batchSize);

  const endDisplay = ((startIdx + batchSize - 1) % categorias.length) + 1;
  console.log(
    `[${store}] Lote progresivo [${startIdx + 1}–${endDisplay}] ` +
    `de ${categorias.length}, máx ${maxPages} pág/cat, ${concurrency} workers`
  );

  try {
    await runWithConcurrency(batch, concurrency, async url => {
      let urlLabel;
      try { urlLabel = new URL(url).pathname; } catch (_) { urlLabel = url; }

      for (let page = 1; page <= maxPages; page++) {
        let rawData;
        try {
          rawData = await fetchPage(url, page);
        } catch (err) {
          console.error(`[${store}] fetchPage ${urlLabel} p${page}: ${err.message}`);
          break;
        }

        if (rawData == null) { break; }

        // Anti-bot guards — only applies to HTML string responses
        if (typeof rawData === 'string') {
          if (isCaptcha(rawData)) {
            console.warn(`[${store}] ⚠ CAPTCHA detectado — saltando ${urlLabel}`);
            break;
          }
          if (isHomePage(rawData, homeMarkers)) {
            console.warn(`[${store}] ⚠ Redirigido al Home — saltando ${urlLabel}`);
            break;
          }
        }

        let items;
        try {
          items = extractItems(rawData, url, page) || [];
        } catch (err) {
          console.error(`[${store}] extractItems ${urlLabel} p${page}: ${err.message}`);
          break;
        }

        if (items.length === 0) {
          if (page === 1) {
            console.warn(`[${store}] 0 items en p1 — posible redirect/formato cambiado: ${urlLabel}`);
          }
          break;
        }

        let added = 0;
        for (const item of items) {
          if (!item || !item.url || seen.has(item.url)) continue;
          seen.add(item.url);
          products.push(item);
          added++;
        }
        console.log(`  [${store}] ${urlLabel} p${page} → +${added} (total ${products.length})`);

        if (page < maxPages) await jitter(pageDelay[0], pageDelay[1]);
      }

      await jitter(catDelay[0], catDelay[1]);
    });
  } finally {
    writeCursor(store, nextIdx);
  }

  console.log(`[${store}] Lote completo — ${products.length} productos`);
  return products;
}

module.exports = {
  runProgressiveScrape,
  readCursor,
  writeCursor,
  selectBatch,
  runWithConcurrency,
  jitter,
  isCaptcha,
  isHomePage,
  BATCH_SIZE,
  MAX_PAGES,
  CONCURRENCY,
};
