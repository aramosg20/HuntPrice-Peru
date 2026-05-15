'use strict';
// Uses Node.js 22.5+ built-in sqlite (no native compilation needed)
const { DatabaseSync: Database } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'huntprice.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'General',
      url TEXT,
      image_url TEXT,
      slug TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      current_price REAL NOT NULL,
      original_price REAL NOT NULL,
      discount_percent REAL NOT NULL,
      stock_info TEXT,
      flash_end TEXT,
      urgency_score INTEGER DEFAULT 5,
      is_historical_min INTEGER DEFAULT 0,
      detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      whatsapp TEXT,
      min_discount INTEGER DEFAULT 30,
      max_budget REAL DEFAULT 0,
      categories TEXT DEFAULT '[]',
      stores TEXT DEFAULT '[]',
      active INTEGER DEFAULT 1,
      token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_id INTEGER,
      target_price REAL,
      alert_type TEXT DEFAULT 'product',
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      product_id INTEGER,
      type TEXT,
      status TEXT,
      message TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scrape_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store TEXT NOT NULL,
      status TEXT NOT NULL,
      products_found INTEGER DEFAULT 0,
      error_message TEXT,
      started_at DATETIME,
      finished_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_prices_product ON prices(product_id);
    CREATE INDEX IF NOT EXISTS idx_prices_discount ON prices(discount_percent);
    CREATE INDEX IF NOT EXISTS idx_prices_detected ON prices(detected_at);
    CREATE INDEX IF NOT EXISTS idx_products_store ON products(store);
  `);

  // Migraciones: agregar columnas si no existen (idempotentes)
  const migrations = [
    // users
    "ALTER TABLE users ADD COLUMN min_price REAL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN max_discount INTEGER DEFAULT 100",
    "ALTER TABLE users ADD COLUMN notify_email INTEGER DEFAULT 1",
    "ALTER TABLE users ADD COLUMN notify_whatsapp INTEGER DEFAULT 1",
    // products — control de calidad y exclusividad
    // NOTE: ALTER TABLE in SQLite only accepts constant literals as DEFAULT,
    // not CURRENT_TIMESTAMP. Columns are added with NULL default and backfilled below.
    "ALTER TABLE products ADD COLUMN sku TEXT",
    "ALTER TABLE products ADD COLUMN first_seen_at TEXT DEFAULT NULL",
    "ALTER TABLE products ADD COLUMN last_seen_at TEXT DEFAULT NULL",
    "ALTER TABLE products ADD COLUMN active INTEGER DEFAULT 1",
    "ALTER TABLE products ADD COLUMN price_updated_at TEXT DEFAULT NULL",
    // índices nuevos
    "CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku, store)",
    "CREATE INDEX IF NOT EXISTS idx_products_last_seen ON products(last_seen_at)",
    "CREATE INDEX IF NOT EXISTS idx_products_active ON products(active)",
    "CREATE INDEX IF NOT EXISTS idx_products_price_updated ON products(price_updated_at)",
    // auth columns (users)
    "ALTER TABLE users ADD COLUMN username TEXT",
    "ALTER TABLE users ADD COLUMN password_hash TEXT",
    "ALTER TABLE users ADD COLUMN phone TEXT",
    // audit / lifecycle columns (users)
    "ALTER TABLE users ADD COLUMN public_id TEXT",
    "ALTER TABLE users ADD COLUMN fecha_afiliacion TEXT",
    "ALTER TABLE users ADD COLUMN fecha_modificacion TEXT",
    "ALTER TABLE users ADD COLUMN fecha_baja TEXT",
    "ALTER TABLE users ADD COLUMN baja_definitiva INTEGER DEFAULT 0",
    "CREATE INDEX IF NOT EXISTS idx_users_public_id ON users(public_id)"
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (_) { /* ya existe */ }
  }

  // Backfill audit dates
  db.exec(`
    UPDATE users SET fecha_afiliacion = created_at   WHERE fecha_afiliacion    IS NULL;
    UPDATE users SET fecha_modificacion = created_at WHERE fecha_modificacion IS NULL;
  `);
  // Generate public_id for existing users that don't have one
  const _withoutPid = db.prepare('SELECT id FROM users WHERE public_id IS NULL').all();
  if (_withoutPid.length > 0) {
    const _pidStmt = db.prepare('UPDATE users SET public_id = ? WHERE id = ?');
    for (const _row of _withoutPid) {
      _pidStmt.run(require('crypto').randomUUID(), _row.id);
    }
  }

  // Backfill: existing rows get first_seen_at = created_at, last_seen_at = updated_at
  // price_updated_at backfills to updated_at (best proxy for last price change).
  // Runs only on rows where the columns are still NULL (first migration pass).
  db.exec(`
    UPDATE products SET first_seen_at = created_at   WHERE first_seen_at    IS NULL;
    UPDATE products SET last_seen_at  = updated_at   WHERE last_seen_at     IS NULL;
    UPDATE products SET price_updated_at = updated_at WHERE price_updated_at IS NULL;
  `);
}

// ─── Products ────────────────────────────────────────────────────────────────

function upsertProduct(data) {
  const d = getDb();

  // Lookup: SKU+store takes priority over URL (handles URL rotations)
  let existing = null;
  if (data.sku) {
    existing = d.prepare(
      'SELECT id FROM products WHERE sku = ? AND store = ?'
    ).get(data.sku, data.store);
  }
  if (!existing && data.url) {
    existing = d.prepare('SELECT id FROM products WHERE url = ?').get(data.url);
  }

  if (existing) {
    // Check if the price changed since the last recorded price row
    const lastPrice = d.prepare(
      'SELECT current_price FROM prices WHERE product_id = ? ORDER BY detected_at DESC LIMIT 1'
    ).get(existing.id);
    const priceChanged = !lastPrice || lastPrice.current_price !== data.current_price;

    d.prepare(`
      UPDATE products
      SET name=?, category=?, image_url=?, url=?,
          last_seen_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP,
          price_updated_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE price_updated_at END,
          active=1
      WHERE id=?
    `).run(
      data.name, data.category || 'General', data.image_url, data.url,
      priceChanged ? 1 : 0,
      existing.id
    );
    return existing.id;
  }

  // New product: stamp all timestamps now
  const result = d.prepare(`
    INSERT INTO products
      (store, name, category, url, image_url, slug, sku,
       first_seen_at, last_seen_at, price_updated_at, active)
    VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)
  `).run(
    data.store, data.name, data.category || 'General', data.url,
    data.image_url, data.slug || slugify(data.name), data.sku || null
  );
  return result.lastInsertRowid;
}

function insertPrice(productId, data) {
  const d = getDb();
  const minPrice = d.prepare(
    'SELECT MIN(current_price) as min FROM prices WHERE product_id = ?'
  ).get(productId);
  const isMin = !minPrice.min || data.current_price <= minPrice.min ? 1 : 0;

  const urgency = calcUrgency(data.discount_percent, data.stock_info, data.flash_end);

  d.prepare(
    `INSERT INTO prices (product_id, current_price, original_price, discount_percent, stock_info, flash_end, urgency_score, is_historical_min)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(productId, data.current_price, data.original_price, data.discount_percent,
    data.stock_info || null, data.flash_end || null, urgency, isMin);

  if (isMin && minPrice.min) {
    d.prepare('UPDATE prices SET is_historical_min=0 WHERE product_id=? AND id != last_insert_rowid()').run(productId);
  }
}

function getProducts(filters = {}) {
  const d = getDb();
  let where = [];
  let params = [];

  where.push('p.active = 1');
  if (filters.store) { where.push('p.store = ?'); params.push(filters.store); }
  if (filters.category) { where.push('p.category = ?'); params.push(filters.category); }
  // Multi-value preference filters (only used when no single store/category is set)
  if (!filters.store && filters.storeList && filters.storeList.length) {
    where.push(`p.store IN (${filters.storeList.map(() => '?').join(',')})`);
    params.push(...filters.storeList);
  }
  if (!filters.category && filters.categoryList && filters.categoryList.length) {
    where.push(`p.category IN (${filters.categoryList.map(() => '?').join(',')})`);
    params.push(...filters.categoryList);
  }
  if (filters.minDiscount) { where.push('pr.discount_percent >= ?'); params.push(filters.minDiscount); }
  if (filters.maxPrice) { where.push('pr.current_price <= ?'); params.push(filters.maxPrice); }
  if (filters.search) {
    where.push("(' ' || LOWER(p.name) || ' ') LIKE ?");
    params.push(`% ${filters.search.toLowerCase()} %`);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orderMap = {
    newest:        'p.first_seen_at DESC',
    price_updated: 'p.price_updated_at DESC',
    discount:      'pr.discount_percent DESC',
    price:         'pr.current_price ASC',
    recent:        'pr.detected_at DESC',
    urgency:       'pr.urgency_score DESC'
  };
  const orderBy = orderMap[filters.sort] || 'pr.discount_percent DESC';
  const limit = parseInt(filters.limit) || 50;
  const offset = parseInt(filters.offset) || 0;

  const sql = `
    SELECT p.id, p.store, p.name, p.category, p.url, p.image_url,
           p.sku, p.first_seen_at, p.price_updated_at,
           pr.current_price, pr.original_price, pr.discount_percent,
           pr.stock_info, pr.flash_end, pr.urgency_score, pr.is_historical_min,
           pr.detected_at,
           (SELECT MIN(current_price) FROM prices WHERE product_id = p.id) as historical_min
    FROM products p
    INNER JOIN prices pr ON pr.id = (
      SELECT id FROM prices WHERE product_id = p.id ORDER BY detected_at DESC LIMIT 1
    )
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);
  return d.prepare(sql).all(...params);
}

function getProductDetail(id) {
  const d = getDb();
  const product = d.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) return null;
  const prices = d.prepare(
    'SELECT * FROM prices WHERE product_id = ? ORDER BY detected_at ASC'
  ).all(id);
  return { ...product, prices };
}

function getActiveOffers() {
  const d = getDb();
  return d.prepare(`
    SELECT p.id, p.store, p.name, p.category, p.url, p.image_url,
           pr.current_price, pr.original_price, pr.discount_percent,
           pr.urgency_score, pr.detected_at
    FROM products p
    INNER JOIN prices pr ON pr.id = (
      SELECT id FROM prices WHERE product_id = p.id ORDER BY detected_at DESC LIMIT 1
    )
    WHERE p.active = 1
      AND pr.discount_percent >= ?
    ORDER BY pr.discount_percent DESC
  `).all(parseInt(process.env.MIN_DISCOUNT_ALERT) || 30);
}

function getStats() {
  const d = getDb();
  const total = d.prepare('SELECT COUNT(*) as n FROM products WHERE active = 1').get().n;
  const active = d.prepare(`
    SELECT COUNT(*) as n FROM (
      SELECT DISTINCT product_id FROM prices
      WHERE detected_at > datetime('now', '-1 hour')
    )`).get().n;
  const topOffer = d.prepare(`
    SELECT MAX(discount_percent) as n FROM prices
    WHERE detected_at > datetime('now', '-24 hours')`).get().n || 0;
  const users = d.prepare('SELECT COUNT(*) as n FROM users WHERE active=1').get().n;
  const notifToday = d.prepare(`
    SELECT COUNT(*) as n FROM notifications_log
    WHERE sent_at > date('now')`).get().n;
  const byStore = d.prepare(`
    SELECT p.store, COUNT(*) as count FROM products p
    GROUP BY p.store ORDER BY count DESC`).all();
  const byHour = d.prepare(`
    SELECT strftime('%H', detected_at) as hour, COUNT(*) as count
    FROM prices WHERE detected_at > datetime('now', '-7 days')
    GROUP BY hour ORDER BY hour`).all();

  return { total, active, topOffer, users, notifToday, byStore, byHour };
}

// ─── Users ───────────────────────────────────────────────────────────────────

function createUser(data) {
  const d = getDb();
  const token = require('crypto').randomBytes(16).toString('hex');
  try {
    const result = d.prepare(
      `INSERT INTO users (name, email, whatsapp, min_discount, max_budget, categories, stores, token)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(data.name, data.email, data.whatsapp || null, data.min_discount || 30,
      data.max_budget || 0, JSON.stringify(data.categories || []),
      JSON.stringify(data.stores || []), token);
    return { id: result.lastInsertRowid, token };
  } catch (e) {
    if (e.message.includes('UNIQUE')) throw new Error('Email ya registrado');
    throw e;
  }
}

function getUsers() {
  return getDb().prepare('SELECT * FROM users ORDER BY created_at DESC').all();
}

function getUsersForAlert(product) {
  const d = getDb();
  // Only include users who want at least one notification channel
  const users = d.prepare(
    'SELECT * FROM users WHERE active = 1 AND (COALESCE(notify_email,1) != 0 OR COALESCE(notify_whatsapp,1) != 0)'
  ).all();
  return users.filter(u => {
    const cats = JSON.parse(u.categories || '[]');
    const stores = JSON.parse(u.stores || '[]');
    const discountOk = product.discount_percent >= (u.min_discount || 30);
    const budgetOk = !u.max_budget || product.current_price <= u.max_budget;
    const catOk = !cats.length || cats.includes(product.category);
    const storeOk = !stores.length || stores.includes(product.store);
    return discountOk && budgetOk && catOk && storeOk;
  });
}

function createAlert(data) {
  const d = getDb();
  const result = d.prepare(
    `INSERT INTO user_alerts (user_id, product_id, target_price, alert_type) VALUES (?,?,?,?)`
  ).run(data.user_id, data.product_id || null, data.target_price || null, data.alert_type || 'product');
  return result.lastInsertRowid;
}

function getUserAlerts(userId) {
  return getDb().prepare(`
    SELECT ua.*, p.name, p.store, p.image_url,
           (SELECT current_price FROM prices WHERE product_id = p.id ORDER BY detected_at DESC LIMIT 1) as current_price
    FROM user_alerts ua
    LEFT JOIN products p ON p.id = ua.product_id
    WHERE ua.user_id = ? AND ua.active = 1
  `).all(userId);
}

// ─── Auth Users ──────────────────────────────────────────────────────────────

function createAuthUser({ username, email, password_hash, phone }) {
  const d = getDb();
  const publicId = require('crypto').randomUUID();
  try {
    const result = d.prepare(
      `INSERT INTO users (name, username, email, password_hash, phone, active, public_id, fecha_afiliacion, fecha_modificacion)
       VALUES (?,?,?,?,?,1,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
    ).run(username.trim(), username.trim(), email, password_hash, phone || null, publicId);
    return result.lastInsertRowid;
  } catch (e) {
    if (e.message.includes('UNIQUE')) throw new Error('Email ya registrado');
    throw e;
  }
}

function getUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function isPhoneTaken(phone) {
  return !!getDb().prepare('SELECT id FROM users WHERE phone = ? AND active = 1').get(phone);
}

function softDeleteUser(id) {
  getDb().prepare(
    'UPDATE users SET active = 0, password_hash = NULL WHERE id = ?'
  ).run(id);
}

function findUserByPhoneAny(phone) {
  return getDb().prepare('SELECT * FROM users WHERE phone = ?').get(phone) || null;
}

function reactivateUser(id, data) {
  const d = getDb();
  d.prepare(`
    UPDATE users SET
      username = ?, email = ?, phone = ?, password_hash = ?,
      active = 1, fecha_modificacion = CURRENT_TIMESTAMP,
      fecha_baja = NULL, baja_definitiva = 0
    WHERE id = ?
  `).run(data.username, data.email, data.phone, data.password_hash, id);
  return d.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function updateAuthUserProfile(id, data) {
  const d = getDb();
  const fields = [];
  const vals   = [];
  if (data.username      !== undefined) { fields.push('username = ?');      vals.push(data.username); }
  if (data.email         !== undefined) { fields.push('email = ?');          vals.push(data.email); }
  if (data.phone         !== undefined) { fields.push('phone = ?');          vals.push(data.phone); }
  if (data.password_hash !== undefined) { fields.push('password_hash = ?'); vals.push(data.password_hash); }
  fields.push('fecha_modificacion = CURRENT_TIMESTAMP');
  vals.push(id);
  d.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return d.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function adminDeactivateUser(id) {
  getDb().prepare(
    'UPDATE users SET active = 0, fecha_baja = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(id);
}

function adminPermanentBanUser(id) {
  getDb().prepare(
    'UPDATE users SET active = 0, baja_definitiva = 1, fecha_baja = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(id);
}

function adminResetPasswordHash(id, hash) {
  getDb().prepare(
    'UPDATE users SET password_hash = ?, fecha_modificacion = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(hash, id);
}

function adminActivateUser(id) {
  getDb().prepare(
    'UPDATE users SET active = 1, fecha_baja = NULL WHERE id = ?'
  ).run(id);
}

function updateAuthUserPreferences(userId, data) {
  getDb().prepare(`
    UPDATE users SET
      notify_email = ?,
      notify_whatsapp = ?,
      categories = ?,
      stores = ?
    WHERE id = ?
  `).run(
    data.notify_email ? 1 : 0,
    data.notify_whatsapp ? 1 : 0,
    JSON.stringify(data.categories || []),
    JSON.stringify(data.stores || []),
    userId
  );
}

// ─── Logs ────────────────────────────────────────────────────────────────────

function logScrape(data) {
  getDb().prepare(
    `INSERT INTO scrape_logs (store, status, products_found, error_message, started_at, finished_at)
     VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)`
  ).run(data.store, data.status, data.products_found || 0, data.error || null, data.started_at || null);
}

function getScrapeLogs(limit = 50) {
  return getDb().prepare(
    'SELECT * FROM scrape_logs ORDER BY finished_at DESC LIMIT ?'
  ).all(limit);
}

function logNotification(data) {
  getDb().prepare(
    `INSERT INTO notifications_log (user_id, product_id, type, status, message) VALUES (?,?,?,?,?)`
  ).run(data.user_id || null, data.product_id || null, data.type, data.status, data.message || null);
}

// ─── Config ──────────────────────────────────────────────────────────────────

function getConfig(key) {
  const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  getDb().prepare(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`
  ).run(key, String(value));
}

function isSetupDone() {
  return getConfig('setup_done') === 'true';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcUrgency(discount, stock, flashEnd) {
  let score = 0;
  if (discount >= 90) score += 5;
  else if (discount >= 70) score += 4;
  else if (discount >= 50) score += 3;
  else if (discount >= 30) score += 2;
  else score += 1;

  if (stock) {
    const n = parseInt(stock);
    if (!isNaN(n)) {
      if (n <= 5) score += 3;
      else if (n <= 20) score += 2;
      else score += 1;
    } else score += 1;
  }

  if (flashEnd) score += 2;
  return Math.min(score, 10);
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e')
    .replace(/[íìï]/g, 'i').replace(/[óòö]/g, 'o')
    .replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .substring(0, 80);
}

// ─── User Profile ────────────────────────────────────────────────────────────

function getUserByToken(token) {
  return getDb().prepare('SELECT * FROM users WHERE token = ?').get(token) || null;
}

function updateUserProfile(token, data) {
  const d = getDb();
  const user = d.prepare('SELECT id FROM users WHERE token = ?').get(token);
  if (!user) throw new Error('Usuario no encontrado');
  d.prepare(`
    UPDATE users SET
      categories = ?,
      stores = ?,
      min_discount = ?,
      max_discount = ?,
      min_price = ?,
      max_budget = ?,
      notify_email = ?,
      notify_whatsapp = ?
    WHERE token = ?
  `).run(
    JSON.stringify(data.categories || []),
    JSON.stringify(data.stores || []),
    data.min_discount ?? 0,
    data.max_discount ?? 100,
    data.min_price ?? 0,
    data.max_budget ?? 0,
    data.notify_email ? 1 : 0,
    data.notify_whatsapp ? 1 : 0,
    token
  );
  return d.prepare('SELECT * FROM users WHERE token = ?').get(token);
}

// Retorna contexto resumido para el chatbot
function getProductsForChat(limit = 200) {
  const d = getDb();
  const products = d.prepare(`
    SELECT p.id, p.store, p.name, p.category, p.url, p.image_url,
           pr.current_price, pr.original_price, pr.discount_percent,
           pr.urgency_score, pr.detected_at
    FROM products p
    INNER JOIN prices pr ON pr.id = (
      SELECT id FROM prices WHERE product_id = p.id ORDER BY detected_at DESC LIMIT 1
    )
    WHERE p.active = 1
      AND pr.discount_percent >= 5
    ORDER BY pr.discount_percent DESC
    LIMIT ?
  `).all(limit);

  const stats = getStats();
  return { products, stats };
}

function searchProductsByKeyword(keywords, limit = 100) {
  const d = getDb();
  if (!keywords || keywords.length === 0) return [];
  // Pad the name with spaces and search for ' term ' so 'tab' never matches 'tabla'
  const conditions = keywords.map(() => "(' ' || LOWER(p.name) || ' ') LIKE ?").join(' OR ');
  const likeParams = keywords.map(k => `% ${k.toLowerCase()} %`);
  return d.prepare(`
    SELECT p.id, p.store, p.name, p.category, p.url, p.image_url,
           pr.current_price, pr.original_price, pr.discount_percent,
           pr.urgency_score, pr.detected_at
    FROM products p
    INNER JOIN prices pr ON pr.id = (
      SELECT id FROM prices WHERE product_id = p.id ORDER BY detected_at DESC LIMIT 1
    )
    WHERE p.active = 1
      AND (${conditions})
    ORDER BY pr.discount_percent DESC
    LIMIT ?
  `).all(...likeParams, limit);
}

// ─── Limpieza de ofertas expiradas ────────────────────────────────────────────

// Marca como inactivos los productos no vistos en las últimas 24 h.
// No borra: preserva historial de precios. El scheduler lo llama cada hora.
// En modo demo no purga — los datos sintéticos no se re-escanean.
function purgeExpiredOffers() {
  if (process.env.DEMO_MODE === 'true' || getConfig('demo_mode') === 'true') {
    return 0;
  }
  const d = getDb();
  const result = d.prepare(`
    UPDATE products
    SET active = 0
    WHERE active = 1
      AND last_seen_at < datetime('now', '-24 hours')
  `).run();
  if (result.changes > 0) {
    console.log(`[DB] purgeExpiredOffers: ${result.changes} producto(s) marcados inactivos`);
  }
  return result.changes;
}

// ─── Top Exclusivos ───────────────────────────────────────────────────────────

// Filtra por Ahorro Neto > S/.100 Y descuento > 30 % para evitar
// ofertas engañosas de artículos baratos con descuento alto.
// Devuelve el Top 3 ordenado por Ahorro Neto descendente.
function getTopExclusivos() {
  const d = getDb();
  return d.prepare(`
    SELECT p.id, p.store, p.name, p.category, p.url, p.image_url,
           p.first_seen_at, p.last_seen_at,
           pr.current_price, pr.original_price, pr.discount_percent,
           pr.urgency_score, pr.detected_at,
           (pr.original_price - pr.current_price) AS net_saving
    FROM products p
    INNER JOIN prices pr ON pr.id = (
      SELECT id FROM prices WHERE product_id = p.id ORDER BY detected_at DESC LIMIT 1
    )
    WHERE p.active = 1
      AND (pr.original_price - pr.current_price) > 100
      AND pr.discount_percent > 30
    ORDER BY net_saving DESC
    LIMIT 10
  `).all();
}

module.exports = {
  getDb, upsertProduct, insertPrice, getProducts, getProductDetail,
  getActiveOffers, getStats, createUser, getUsers, getUsersForAlert,
  createAlert, getUserAlerts, logScrape, getScrapeLogs,
  logNotification, getConfig, setConfig, isSetupDone,
  getUserByToken, updateUserProfile, getProductsForChat, searchProductsByKeyword,
  purgeExpiredOffers, getTopExclusivos,
  // auth
  createAuthUser, getUserByEmail, getUserById, isPhoneTaken, softDeleteUser,
  updateAuthUserPreferences,
  findUserByPhoneAny, reactivateUser, updateAuthUserProfile,
  adminDeactivateUser, adminPermanentBanUser, adminResetPasswordHash, adminActivateUser
};
