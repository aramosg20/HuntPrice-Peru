'use strict';
require('dotenv').config();
const cron = require('node-cron');
const db = require('../database/db');
const { filterDeadUrls } = require('./utils');
const { notifyUsers } = require('../notifications/email');
const { notifyWhatsApp } = require('../notifications/whatsapp');

const scrapers = [
  require('./falabellaPlaywright'),
  require('./ripley'),
  require('./oechsle'),
  require('./sodimac'),
  require('./promart'),
  require('./plazavea'),
  require('./mercadolibre'),
  require('./coolbox'),
  require('./samsung')
];

let isRunning = false;
let sseClients = [];
let streamClients = [];
let lastResults = {};

function setSseClients(clients) { sseClients = clients; }
function setStreamClients(clients) { streamClients = clients; }

function broadcast(event, data) {
  sseClients.forEach(client => {
    try { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch (_) {}
  });
}

// Plain-data broadcast for /api/stream clients (onmessage compatible)
function broadcastUpdate(data) {
  streamClients.forEach(client => {
    try { client.res.write(`data: ${JSON.stringify(data)}\n\n`); }
    catch (_) {}
  });
}

async function runScraper(scraperModule) {
  const { STORE } = scraperModule;
  const startedAt = new Date().toISOString();
  broadcast('scraper_status', { store: STORE, status: 'running' });

  try {
    const raw = await scraperModule.scrape();
    // HEAD-filter dead URLs — only active when VALIDATE_URLS=true env var is set
    const products = await filterDeadUrls(raw);
    const newOffers = [];

    for (const p of products) {
      try {
        const productId = db.upsertProduct(p);
        db.insertPrice(productId, p);

        if (p.discount_percent >= (parseInt(process.env.MIN_DISCOUNT_ALERT) || 30)) {
          newOffers.push({ ...p, id: productId });
        }
      } catch (e) {
        console.error(`[${STORE}] DB error:`, e.message);
      }
    }

    db.logScrape({ store: STORE, status: 'ok', products_found: products.length, started_at: startedAt });
    lastResults[STORE] = { status: 'ok', count: products.length, ts: new Date().toISOString() };
    broadcast('scraper_status', { store: STORE, status: 'ok', count: products.length });

    if (newOffers.length > 0) {
      broadcast('new_offers', { count: newOffers.length, store: STORE, sample: newOffers.slice(0, 3) });
      await sendAlerts(newOffers);
    }

    return { store: STORE, status: 'ok', count: products.length };
  } catch (err) {
    console.error(`[${STORE}] Scraper failed:`, err.message);
    db.logScrape({ store: STORE, status: 'error', error: err.message, started_at: startedAt });
    lastResults[STORE] = { status: 'error', error: err.message, ts: new Date().toISOString() };
    broadcast('scraper_status', { store: STORE, status: 'error', error: err.message });
    return { store: STORE, status: 'error', error: err.message };
  }
}

async function runAll() {
  if (isRunning) {
    console.log('[Scraper] Already running, skipping...');
    return;
  }
  isRunning = true;
  console.log('[Scraper] Starting full scan at', new Date().toLocaleString('es-PE'));
  broadcast('scan_start', { ts: new Date().toISOString() });

  const demoMode = process.env.DEMO_MODE === 'true';
  if (demoMode) {
    await seedDemoData();
    isRunning = false;
    broadcast('scan_done', { ts: new Date().toISOString(), demo: true });
    broadcast('products_updated', { type: 'PRODUCTS_UPDATED', ts: new Date().toISOString() });
    broadcastUpdate({ type: 'PRODUCTS_UPDATED' });
    return;
  }

  const results = [];
  for (const scraper of scrapers) {
    const result = await runScraper(scraper);
    results.push(result);
    await new Promise(r => setTimeout(r, 3000));
  }

  isRunning = false;
  console.log('[Scraper] Scan complete:', results.map(r => `${r.store}:${r.status}`).join(', '));
  broadcast('scan_done', { ts: new Date().toISOString(), results });
  broadcast('products_updated', { type: 'PRODUCTS_UPDATED', ts: new Date().toISOString() });
  broadcastUpdate({ type: 'PRODUCTS_UPDATED' });
}

async function sendAlerts(offers) {
  // Group all matching products per user first — avoids N emails per user per scan
  const userOffers = new Map(); // userId → { user, products[] }
  for (const product of offers) {
    try {
      const users = db.getUsersForAlert(product);
      for (const user of users) {
        if (!userOffers.has(user.id)) userOffers.set(user.id, { user, products: [] });
        userOffers.get(user.id).products.push(product);
      }
    } catch (e) {
      console.error('[Alerts] Error building user map:', e.message);
    }
  }

  // One email digest + up to 3 WhatsApp messages per user per scan cycle
  for (const { user, products } of userOffers.values()) {
    const wantsEmail = user.email && (user.notify_email == null || user.notify_email !== 0);
    const wantsWA    = user.whatsapp && (user.notify_whatsapp == null || user.notify_whatsapp !== 0);

    if (wantsEmail) {
      try {
        await notifyUsers([user], null, { digest: true, offers: products });
        for (const p of products) {
          db.logNotification({ user_id: user.id, product_id: p.id, type: 'email', status: 'sent' });
        }
      } catch (e) {
        for (const p of products) {
          db.logNotification({ user_id: user.id, product_id: p.id, type: 'email', status: 'error', message: e.message });
        }
      }
    }

    if (wantsWA) {
      // Sort by discount desc, cap at 3 to avoid WhatsApp spam
      const top3 = [...products].sort((a, b) => b.discount_percent - a.discount_percent).slice(0, 3);
      for (const product of top3) {
        try {
          await notifyWhatsApp(user, product);
          db.logNotification({ user_id: user.id, product_id: product.id, type: 'whatsapp', status: 'sent' });
        } catch (e) {
          db.logNotification({ user_id: user.id, product_id: product.id, type: 'whatsapp', status: 'error', message: e.message });
        }
      }
    }
  }
}

function startScheduler() {
  const interval = parseInt(process.env.SCAN_INTERVAL_MINUTES) || 15;
  const cronExpr = `*/${interval} * * * *`;
  console.log(`[Scheduler] Running every ${interval} minutes (${cronExpr})`);

  cron.schedule(cronExpr, () => {
    runAll().catch(console.error);
  });

  // Purge offers not seen in the last 24 h — runs every hour
  cron.schedule('0 * * * *', () => {
    try { db.purgeExpiredOffers(); }
    catch (e) { console.error('[Purge] Error:', e.message); }
  });

  // Daily digest at 8am
  cron.schedule('0 8 * * *', async () => {
    try {
      const offers = db.getActiveOffers();
      if (offers.length === 0) return;
      // Only send to active users who have email notifications enabled
      const users = db.getUsers().filter(u =>
        u.active && u.email && (u.notify_email == null || u.notify_email !== 0)
      );
      for (const user of users) {
        await notifyUsers([user], null, { digest: true, offers: offers.slice(0, 10) });
      }
    } catch (e) {
      console.error('[Digest] Error:', e.message);
    }
  });

  // Run immediately on start if DB is empty or demo mode
  setTimeout(() => runAll().catch(console.error), 3000);
}

// ─── Demo Data ────────────────────────────────────────────────────────────────

async function seedDemoData() {
  const d = db.getDb();
  const count = d.prepare('SELECT COUNT(*) as n FROM products').get().n;
  if (count > 20) return;

  console.log('[Demo] Seeding demo products...');

  const demoProducts = [
    { store: 'Falabella', name: 'Televisor Samsung 65" QLED 4K Smart TV QN65Q80C', category: 'Electrónica', current_price: 1999, original_price: 5499, image_url: 'https://falabella.scene7.com/is/image/FalabellaPE/prod_default' },
    { store: 'Falabella', name: 'Laptop HP Pavilion 15 Core i7 16GB RAM 512GB SSD', category: 'Computación', current_price: 1649, original_price: 3299, image_url: '' },
    { store: 'Ripley', name: 'Smartphone Samsung Galaxy S24 256GB Negro', category: 'Celulares', current_price: 1499, original_price: 3799, image_url: '' },
    { store: 'Ripley', name: 'Refrigeradora LG No Frost 311L Acero Inoxidable', category: 'Electrohogar', current_price: 1249, original_price: 2499, image_url: '' },
    { store: 'Oechsle', name: 'Zapatillas Nike Air Max 270 Hombre Negro/Blanco', category: 'Calzado', current_price: 149, original_price: 499, image_url: '' },
    { store: 'Oechsle', name: 'Perfume Calvin Klein Eternity EDP 100ml', category: 'Belleza', current_price: 89, original_price: 349, image_url: '' },
    { store: 'Sodimac', name: 'Sofá 3 Cuerpos Tela Lino Gris Claro Milano', category: 'Muebles', current_price: 699, original_price: 1999, image_url: '' },
    { store: 'Sodimac', name: 'Taladro Inalámbrico Dewalt 20V 2 Baterías', category: 'Herramientas', current_price: 389, original_price: 799, image_url: '' },
    { store: 'Promart', name: 'Colchón Paraíso Premier Doble 2 Plazas', category: 'Muebles', current_price: 499, original_price: 1299, image_url: '' },
    { store: 'Promart', name: 'Pintura Sherwin Williams Látex Blanco 5gl', category: 'Construcción', current_price: 89, original_price: 189, image_url: '' },
    { store: 'PlazaVea', name: 'Pack Leche Gloria Entera 1L x 6 unidades', category: 'Lácteos', current_price: 18, original_price: 35, image_url: '' },
    { store: 'Falabella', name: 'PlayStation 5 Slim + 2 Joysticks + FIFA 24', category: 'Electrónica', current_price: 1799, original_price: 2999, image_url: '' },
    { store: 'Ripley', name: 'Lavadora Electrolux 10KG Carga Frontal Inverter', category: 'Electrohogar', current_price: 999, original_price: 2299, image_url: '' },
    { store: 'Falabella', name: 'iPad Pro M2 11" 256GB WiFi + Apple Pencil', category: 'Computación', current_price: 2999, original_price: 5499, image_url: '' },
    { store: 'Oechsle', name: 'Vestido Midi Floral Manga Corta Talla M', category: 'Moda', current_price: 29, original_price: 119, image_url: '' },
    { store: 'Sodimac', name: 'Aspiradora Robot Samsung Jet Bot AI+ Con Estación', category: 'Electrohogar', current_price: 899, original_price: 2499, image_url: '' },
    { store: 'Promart', name: 'Kit de Herramientas Stanley 92 piezas Cromo Vanadio', category: 'Herramientas', current_price: 149, original_price: 349, image_url: '' },
    { store: 'Ripley', name: 'Auriculares Sony WH-1000XM5 Noise Cancelling', category: 'Electrónica', current_price: 699, original_price: 1599, image_url: '' },
    { store: 'Falabella', name: 'Zapatillas Adidas Ultraboost 22 Mujer Blanco', category: 'Calzado', current_price: 199, original_price: 599, image_url: '' },
    { store: 'PlazaVea', name: 'Detergente Ariel Pods 3en1 x 50 cápsulas', category: 'Limpieza', current_price: 45, original_price: 99, image_url: '' },
    { store: 'Sodimac', name: 'Mesa de Comedor 6 Sillas Madera Roble 180cm', category: 'Muebles', current_price: 1499, original_price: 3999, image_url: '' },
    { store: 'Ripley', name: 'Microondas Panasonic 32L Inverter Negro', category: 'Electrohogar', current_price: 349, original_price: 799, image_url: '' },
    { store: 'Falabella', name: 'Cámara Canon EOS R50 Kit 18-45mm Mirrorless', category: 'Electrónica', current_price: 2299, original_price: 3999, image_url: '' },
    { store: 'Oechsle', name: 'Mochila Samsonite ProDLX 15.6" Negra', category: 'Moda', current_price: 149, original_price: 449, image_url: '' },
    { store: 'Promart', name: 'Lámpara LED Philips E27 9W Luz Cálida x 4', category: 'Iluminación', current_price: 19, original_price: 55, image_url: '' },
    { store: 'Mercado Libre', name: 'Xiaomi Redmi Note 13 Pro 256GB 8GB RAM NFC', category: 'Celulares', current_price: 699, original_price: 1299, image_url: 'https://images.unsplash.com/photo-1598327105666-5b89351aff97?w=400' },
    { store: 'Mercado Libre', name: 'Laptop Lenovo IdeaPad 5 Ryzen 5 16GB 512GB SSD', category: 'Computación', current_price: 1299, original_price: 2499, image_url: 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=400' },
    { store: 'Mercado Libre', name: 'Samsung Galaxy A55 5G 256GB Azul Oscuro', category: 'Celulares', current_price: 899, original_price: 1799, image_url: 'https://images.unsplash.com/photo-1598327105666-5b89351aff97?w=400' },
    { store: 'Coolbox', name: 'Xiaomi Redmi Note 14 Pro 5G 512GB Camera 200MP', category: 'Celulares', current_price: 999, original_price: 1999, image_url: 'https://images.unsplash.com/photo-1598327105666-5b89351aff97?w=400' },
    { store: 'Coolbox', name: 'ASUS ROG Strix G16 Intel Core i7 RTX 4060 16GB', category: 'Gaming', current_price: 3299, original_price: 5999, image_url: 'https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=400' },
    { store: 'Samsung', name: 'Samsung Galaxy S24 Ultra 256GB Titanium Black', category: 'Celulares', current_price: 2999, original_price: 5499, image_url: 'https://images.unsplash.com/photo-1598327105666-5b89351aff97?w=400' },
    { store: 'Samsung', name: 'Samsung QLED 4K 65" Q80C Smart TV 2024', category: 'Electrónica', current_price: 2499, original_price: 5999, image_url: 'https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=400' },
    { store: 'Samsung', name: 'Samsung Galaxy Tab S9 FE 5G 128GB Grafite', category: 'Computación', current_price: 999, original_price: 1999, image_url: 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=400' }
  ];

  const storeUrls = {
    'Falabella': 'https://www.falabella.com.pe',
    'Ripley': 'https://simple.ripley.com.pe',
    'Oechsle': 'https://www.oechsle.pe',
    'Sodimac': 'https://www.sodimac.com.pe',
    'Promart': 'https://www.promart.pe',
    'PlazaVea': 'https://www.plazavea.com.pe',
    'Mercado Libre': 'https://www.mercadolibre.com.pe',
    'Coolbox': 'https://www.coolbox.pe',
    'Samsung': 'https://www.samsung.com/pe'
  };

  const demoImages = {
    'Electrónica': 'https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=400',
    'Computación': 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=400',
    'Celulares': 'https://images.unsplash.com/photo-1598327105666-5b89351aff97?w=400',
    'Electrohogar': 'https://images.unsplash.com/photo-1584568694244-14fbdf83bd30?w=400',
    'Calzado': 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400',
    'Belleza': 'https://images.unsplash.com/photo-1512496015851-a90fb38ba796?w=400',
    'Muebles': 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400',
    'Herramientas': 'https://images.unsplash.com/photo-1586864387789-628af9feed72?w=400',
    'Construcción': 'https://images.unsplash.com/photo-1581578731548-c64695cc6952?w=400',
    'Moda': 'https://images.unsplash.com/photo-1445205170230-053b83016050?w=400',
    'Lácteos': 'https://images.unsplash.com/photo-1563636619-e9143da7973b?w=400',
    'Limpieza': 'https://images.unsplash.com/photo-1563453392212-326f5e854473?w=400',
    'Iluminación': 'https://images.unsplash.com/photo-1565814329452-e1efa11c5b89?w=400',
    'Supermercado': 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=400'
  };

  for (const p of demoProducts) {
    try {
      const baseUrl = storeUrls[p.store];
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60);
      const productUrl = `${baseUrl}/producto/${slug}`;
      const imageUrl = p.image_url || demoImages[p.category] || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400';
      const discount = Math.round(((p.original_price - p.current_price) / p.original_price) * 100);

      const productId = db.upsertProduct({ ...p, url: productUrl, image_url: imageUrl });

      // Add some price history
      const historyPoints = 3 + Math.floor(Math.random() * 5);
      const now = Date.now();
      for (let i = historyPoints; i >= 0; i--) {
        const factor = 1 + (i * 0.05) + (Math.random() * 0.1);
        const histPrice = Math.round(p.current_price * factor);
        const histDiscount = Math.round(((p.original_price - histPrice) / p.original_price) * 100);
        const ts = new Date(now - i * 4 * 3600000).toISOString();
        d.prepare(
          `INSERT INTO prices (product_id, current_price, original_price, discount_percent, urgency_score, detected_at)
           VALUES (?,?,?,?,?,?)`
        ).run(productId, histPrice, p.original_price, Math.max(histDiscount, 5),
          Math.min(10, Math.floor(discount / 10) + 3), ts);
      }
    } catch (e) {
      console.error('[Demo] Error seeding product:', e.message);
    }
  }

  console.log(`[Demo] Seeded ${demoProducts.length} products`);
  broadcast('new_offers', { count: demoProducts.length, demo: true });
}

function getLastResults() { return lastResults; }

module.exports = { runAll, startScheduler, setSseClients, setStreamClients, getLastResults, seedDemoData };
