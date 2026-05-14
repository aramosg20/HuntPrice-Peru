'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const db = require('./database/db');

// Keywords extracted from user message for semantic product search
const STOP_WORDS = new Set([
  'el','la','los','las','un','una','me','te','se','de','en','a','y','o','que',
  'con','para','por','hay','tiene','como','es','son','del','al','su','sus',
  'ver','dame','muéstrame','mostrar','quiero','busco','necesito','cuanto','cuantos',
  'cual','cuales','precio','oferta','ofertas','descuento','tienda','producto','productos',
  'comprar','buscar','encontrar','conseguir','obtener'
]);

// Synonym expansion — returns all search terms including synonyms for common categories
const SYNONYM_MAP = {
  'cuatrimoto': ['cuatri','atv','quad','vehiculo','moto'],
  'cuatri':     ['cuatrimoto','atv','quad'],
  'atv':        ['cuatrimoto','cuatri','quad'],
  'juguete':    ['niño','niña','infantil','educativo','peluche','muñeca','control remoto','kids'],
  'juguetes':   ['niño','niña','infantil','educativo','peluche','muñeca','control remoto','kids'],
  'celular':    ['smartphone','telefono','movil','iphone','galaxy','xiaomi'],
  'celulares':  ['smartphone','telefono','movil','iphone','galaxy','xiaomi'],
  'smartphone': ['celular','telefono','movil'],
  'laptop':     ['notebook','computadora','portatil'],
  'laptops':    ['notebook','computadora','portatil'],
  'notebook':   ['laptop','computadora','portatil'],
  'televisor':  ['tv','smart tv','qled','oled','pantalla'],
  'television': ['tv','smart tv','qled','oled','pantalla'],
  'audifonos':  ['auricular','earphone','headphone','tws','airpods','bluetooth'],
  'auricular':  ['audifonos','earphone','headphone','tws'],
  'tablet':     ['ipad','tab','slate'],
  'moto':       ['motocicleta','scooter'],
  'refrigerador': ['refrigeradora','nevera','heladera'],
  'lavadora':   ['lavasecadora','lavarropa'],
};

function extractSearchKeywords(message) {
  const base = message.toLowerCase()
    .replace(/[¿?¡!.,;:()\-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
  // Expand with synonyms, deduplicate
  const expanded = new Set(base);
  for (const word of base) {
    const syns = SYNONYM_MAP[word];
    if (syns) syns.forEach(s => expanded.add(s));
  }
  return [...expanded];
}

function maskEmail(email) {
  const [user, domain] = email.split('@');
  return (user.length > 2 ? user.slice(0, 2) + '***' : '***') + '@' + domain;
}
function maskPhone(phone) {
  const d = phone.replace(/\D/g, '');
  return d.length >= 6 ? d.slice(0, 3) + '****' + d.slice(-2) : '****';
}
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const scraper = require('./scraper/index');
const { notifyUsers, testEmail, resetTransporter, sendAlertConfirmation, sendOfferEmail,
        sendWelcomeEmail, sendGoodbyeEmail } = require('./notifications/email');
const { handleIncomingMessage, testWhatsApp, resetClient, notifyWhatsApp,
        sendWelcomeWhatsApp, sendGoodbyeWhatsApp } = require('./notifications/whatsapp');
const https = require('https');

function getJwtSecret() {
  let s = process.env.JWT_SECRET || db.getConfig('jwt_secret');
  if (!s) {
    s = require('crypto').randomBytes(64).toString('hex');
    db.setConfig('jwt_secret', s);
  }
  return s;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'No autenticado' });
  try {
    req.authUser = jwt.verify(token, getJwtSecret());
    next();
  } catch (_) {
    res.status(401).json({ ok: false, error: 'Sesión expirada. Vuelve a ingresar.' });
  }
}

async function sendAuthWelcome(user) {
  if (user.email) {
    try { await sendWelcomeEmail(user); } catch (e) { console.warn('[Auth] Welcome email:', e.message); }
  }
  if (user.phone) {
    try { await sendWelcomeWhatsApp(user); } catch (e) { console.warn('[Auth] Welcome WA:', e.message); }
  }
}

async function sendAuthGoodbye(user) {
  if (user.email) {
    try { await sendGoodbyeEmail(user); } catch (e) { console.warn('[Auth] Goodbye email:', e.message); }
  }
  if (user.phone) {
    try { await sendGoodbyeWhatsApp(user); } catch (e) { console.warn('[Auth] Goodbye WA:', e.message); }
  }
}

const app = express();
const PORT = parseInt(process.env.PORT) || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── SSE Clients ─────────────────────────────────────────────────────────────

const sseClients = [];
scraper.setSseClients(sseClients);

const streamClients = [];
scraper.setStreamClients(streamClients);

// ─── Routes ───────────────────────────────────────────────────────────────────

// Redirect to setup if not configured
app.use((req, res, next) => {
  const setupPaths = ['/setup', '/setup.html', '/api/setup', '/perfil', '/perfil.html'];
  const staticPaths = ['.js', '.css', '.json', '.png', '.ico', '.svg', '.webmanifest'];
  const isStatic = staticPaths.some(ext => req.path.endsWith(ext));
  if (!db.isSetupDone() && !setupPaths.includes(req.path) && !isStatic) {
    if (req.path.startsWith('/api/')) return next();
    return res.redirect('/setup.html');
  }
  next();
});

// ── SSE ──────────────────────────────────────────────────────────────────────

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = Date.now();
  const client = { id: clientId, res };
  sseClients.push(client);

  res.write(`event: connected\ndata: {"id":${clientId}}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(`:heartbeat\n\n`);
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const idx = sseClients.findIndex(c => c.id === clientId);
    if (idx > -1) sseClients.splice(idx, 1);
  });
});

// ── SSE Stream (plain onmessage format) ──────────────────────────────────────

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const client = { id: Date.now(), res };
  streamClients.push(client);

  // Confirm connection
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED' })}\n\n`);

  const heartbeat = setInterval(() => res.write(':\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const idx = streamClients.findIndex(c => c.id === client.id);
    if (idx > -1) streamClients.splice(idx, 1);
  });
});

// ── Products ─────────────────────────────────────────────────────────────────

app.get('/api/products', (req, res) => {
  try {
    const products = db.getProducts({
      store: req.query.store,
      category: req.query.category,
      minDiscount: req.query.minDiscount,
      maxPrice: req.query.maxPrice,
      search: req.query.q,
      sort: req.query.sort,
      limit: req.query.limit || 60,
      offset: req.query.offset || 0
    });
    res.json({ ok: true, data: products, count: products.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/products/:id', (req, res) => {
  try {
    const product = db.getProductDetail(parseInt(req.params.id));
    if (!product) return res.status(404).json({ ok: false, error: 'Producto no encontrado' });
    res.json({ ok: true, data: product });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    res.json({ ok: true, data: db.getStats() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/categories', (req, res) => {
  try {
    const d = db.getDb();
    const cats = d.prepare('SELECT DISTINCT category FROM products ORDER BY category').all();
    res.json({ ok: true, data: cats.map(c => c.category) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/exclusivos', (req, res) => {
  try {
    res.json({ ok: true, data: db.getTopExclusivos() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/stores', (req, res) => {
  const stores = ['Falabella', 'Ripley', 'Oechsle', 'Sodimac', 'Promart', 'PlazaVea',
                  'Mercado Libre', 'Coolbox', 'Samsung'];
  res.json({ ok: true, data: stores });
});

// ── Users & Alerts ────────────────────────────────────────────────────────────

app.post('/api/users', (req, res) => {
  try {
    const { name, email, whatsapp, min_discount, max_budget, categories, stores } = req.body;
    if (!name || !email) return res.status(400).json({ ok: false, error: 'Nombre y email requeridos' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Email inválido' });
    }
    const result = db.createUser({ name, email, whatsapp, min_discount, max_budget, categories, stores });
    res.json({ ok: true, data: result, message: '¡Registro exitoso! Recibirás alertas pronto.' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/users/:token/alerts', (req, res) => {
  try {
    const d = db.getDb();
    const user = d.prepare('SELECT * FROM users WHERE token = ?').get(req.params.token);
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    const alerts = db.getUserAlerts(user.id);
    res.json({ ok: true, data: alerts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/alerts', (req, res) => {
  try {
    const { user_token, product_id, target_price, alert_type } = req.body;
    if (!user_token) return res.status(400).json({ ok: false, error: 'Token requerido' });
    const d = db.getDb();
    const user = d.prepare('SELECT * FROM users WHERE token = ?').get(user_token);
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });

    const alertId = db.createAlert({ user_id: user.id, product_id, target_price, alert_type });
    res.json({ ok: true, data: { id: alertId }, message: 'Alerta creada exitosamente' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/alerts/:id', (req, res) => {
  try {
    const { user_token } = req.body;
    const d = db.getDb();
    const user = d.prepare('SELECT * FROM users WHERE token = ?').get(user_token);
    if (!user) return res.status(403).json({ ok: false, error: 'No autorizado' });
    d.prepare('UPDATE user_alerts SET active=0 WHERE id=? AND user_id=?').run(parseInt(req.params.id), user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Suscripción rápida a alerta de un producto específico (solo email + precio objetivo)
app.post('/api/alerts/subscribe', async (req, res) => {
  try {
    const { email, product_id, target_price } = req.body;
    if (!email) return res.status(400).json({ ok: false, error: 'Email requerido' });
    if (!product_id) return res.status(400).json({ ok: false, error: 'Producto requerido' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Email inválido' });
    }

    const d = db.getDb();
    const crypto = require('crypto');

    // Buscar o crear usuario mínimo por email
    let user = d.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      const token = crypto.randomBytes(16).toString('hex');
      const result = d.prepare(
        'INSERT INTO users (name, email, min_discount, token, active) VALUES (?,?,30,?,1)'
      ).run(email.split('@')[0], email, token);
      user = d.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    } else if (!user.active) {
      d.prepare('UPDATE users SET active=1 WHERE id=?').run(user.id);
      user = d.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }

    // Evitar duplicados
    const existing = d.prepare(
      'SELECT id FROM user_alerts WHERE user_id=? AND product_id=? AND active=1'
    ).get(user.id, parseInt(product_id));

    let message;
    if (!existing) {
      db.createAlert({
        user_id: user.id,
        product_id: parseInt(product_id),
        target_price: target_price ? parseFloat(target_price) : null,
        alert_type: 'product'
      });
      message = 'Alerta creada. Revisa tu email de confirmación.';
    } else {
      message = 'Ya tenías esta alerta. Email de confirmación reenviado.';
    }

    // Email de confirmación (no bloquea la respuesta)
    const product = db.getProductDetail(parseInt(product_id));
    if (product) {
      sendAlertConfirmation(email, product, target_price).catch(e =>
        console.warn('[Alerta email]', e.message)
      );
    }

    res.json({ ok: true, message });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── User Profile ─────────────────────────────────────────────────────────────

app.get('/api/profile/:token', (req, res) => {
  try {
    const user = db.getUserByToken(req.params.token);
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    // No exponer token ni datos sensibles innecesarios
    const { token, ...safe } = user;
    res.json({ ok: true, data: safe });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/profile/:token', (req, res) => {
  try {
    const updated = db.updateUserProfile(req.params.token, req.body);
    const { token, ...safe } = updated;
    res.json({ ok: true, data: safe, message: 'Perfil guardado' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── HuntBot Chat ──────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [], token = '' } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ ok: false, error: 'Mensaje requerido' });
    }

    const apiKey = process.env.GEMINI_API_KEY || db.getConfig('gemini_api_key');
    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        error: 'API key de Google Gemini no configurada. Configúrala en el panel Admin.'
      });
    }

    // Top products by discount (up to 200)
    const { products, stats } = db.getProductsForChat(200);

    // Keyword search with synonym expansion — merge extras not already in top list
    const recentUserHistory = Array.isArray(history)
      ? history.filter(m => m.role === 'user').slice(-3).map(m => m.content).join(' ')
      : '';
    const keywords = extractSearchKeywords((recentUserHistory + ' ' + message).trim());
    const keywordHits = keywords.length > 0 ? db.searchProductsByKeyword(keywords, 100) : [];
    const topIds = new Set(products.map(p => p.id));
    const extraHits = keywordHits.filter(p => !topIds.has(p.id));

    // Final indexed context — all top-discount + all keyword extras (no artificial cap)
    const contextProducts = [...products, ...extraHits];

    // Build compact context for Gemini prompt: ID|Name|Store|SalePrice|OrigPrice|Discount%|URL
    const mainContext = contextProducts.map((p, i) =>
      `[${i + 1}] ID:${p.id} | ${p.store} | "${p.name}" | S/.${p.current_price} (antes S/.${p.original_price}, -${Math.round(p.discount_percent)}%) | ${p.url}`
    ).join('\n');

    // filter_action: if keyword search found specific products, return them for dashboard filter
    let filterAction = null;
    if (keywordHits.length > 0) {
      const primaryKeyword = keywords.find(k => SYNONYM_MAP[k]) || keywords.join(' ');
      filterAction = {
        type: 'search',
        query: primaryKeyword,
        product_ids: keywordHits.map(p => p.id)
      };
    }

    // Look up registered user for notification pre-check
    let notifInfo = { registered: false, hasEmail: false, hasWhatsapp: false };
    if (token) {
      const regUser = db.getUserByToken(token);
      if (regUser) {
        notifInfo = {
          registered: true,
          hasEmail: !!regUser.email,
          hasWhatsapp: !!regUser.whatsapp,
          maskedEmail: regUser.email ? maskEmail(regUser.email) : null,
          maskedWhatsapp: regUser.whatsapp ? maskPhone(regUser.whatsapp) : null
        };
      }
    }

    const systemPrompt = `Eres HuntBot, el asistente de compras inteligente de HuntPrice Perú. Ayudas a los usuarios a encontrar las mejores ofertas y tomar decisiones de compra informadas.

CATÁLOGO COMPLETO DE OFERTAS (${contextProducts.length} productos — busca aquí SIEMPRE antes de responder):
${mainContext || 'No hay ofertas disponibles en este momento.'}

ESTADÍSTICAS:
- Total productos: ${stats.total} | Mejor descuento: ${Math.round(stats.topOffer || 0)}%
- Tiendas: Falabella, Ripley, Oechsle, Sodimac, Promart, PlazaVea, Mercado Libre, Coolbox, Samsung

INSTRUCCIONES CRÍTICAS:
1. BUSCA EN TODO EL CATÁLOGO antes de decir que no hay un producto. Usa el ID para referenciar productos.
2. CONSISTENCIA: Si ya mencionaste un producto en esta conversación, usa el MISMO producto y MISMO ID al dar seguimiento (link, precio, etc.). NO cambies de producto entre mensajes.
3. Si el usuario dice "dame el link", "ese producto", "eso que mencionaste" → usa el mismo producto de tu respuesta anterior.
4. Responde en español. S/. para soles. Máximo 3 párrafos. Termina con pregunta de seguimiento.

TARJETAS DE PRODUCTO:
- Al mencionar un producto del catálogo, añade [[P:N]] (N = número en la lista). Ejemplo: "TV Samsung [[P:5]] con 46% off"
- SIEMPRE incluye [[P:N]] cuando recomiendes un producto

CONTROL DEL DASHBOARD:
- "muéstrame", "ver en el dashboard", "dame el link" → [[ACTION:show_product:N]]
- "ver ofertas de [tienda]" → [[ACTION:filter_store:NombreTienda]]
- "filtrar por [categoría]" → [[ACTION:filter_category:NombreCategoria]]
- Solo un ACTION por respuesta

NOTIFICACIONES — MUY IMPORTANTE:
- Cuando el usuario pida envío por WhatsApp o email, NO preguntes datos adicionales
- Confirma: "Procederé a enviarle la oferta vía [canal]." y añade [[NOTIF:whatsapp]] o [[NOTIF:email]]
- Solo añade [[NOTIF:...]] cuando el usuario lo pida explícitamente

INSTRUCCIÓN CRÍTICA Y OBLIGATORIA — CONTROL DEL BUSCADOR:
- Siempre que recomiendes un producto o respondas a una búsqueda del usuario, DEBES incluir al final de tu mensaje una etiqueta oculta con el término de búsqueda más preciso y corto (1 o 2 palabras) que identifique al producto en el catálogo.
- Usa el formato exacto: [BUSCAR: termino] (ejemplo: [BUSCAR: cuatrimoto] o [BUSCAR: ipad]).
- Si el usuario busca una cuatrimoto a batería, pon [BUSCAR: cuatrimoto]. Si busca un iPad, pon [BUSCAR: ipad].
- Si tu respuesta es una comparativa general sin recomendación específica, omite la etiqueta.`;

    // Construir historial en formato Gemini (role: user/model)
    const validHistory = (Array.isArray(history) ? history : [])
      .filter(m => m.role && m.content && typeof m.content === 'string')
      .slice(-10)
      .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const geminiBody = JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [
        ...validHistory,
        { role: 'user', parts: [{ text: message.substring(0, 2000) }] }
      ],
      generationConfig: { maxOutputTokens: 2048, temperature: 0.2 }
    });

    const reply = await new Promise((resolve, reject) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(geminiBody) }
      };
      const req2 = https.request(options, (r) => {
        let data = '';
        r.on('data', chunk => { data += chunk; });
        r.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (r.statusCode === 401 || r.statusCode === 403) {
              return reject(Object.assign(new Error('API key de Google Gemini inválida'), { status: r.statusCode }));
            }
            if (r.statusCode !== 200) {
              const msg = json?.error?.message || `HTTP ${r.statusCode}`;
              return reject(new Error(msg));
            }
            const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || 'Lo siento, no pude generar una respuesta.';
            resolve(text);
          } catch (e) { reject(e); }
        });
      });
      req2.on('error', reject);
      req2.setTimeout(30000, () => { req2.destroy(new Error('Timeout')); });
      req2.write(geminiBody);
      req2.end();
    });

    // Extract [[P:N]] product card references
    const productCards = [];
    const seenCardIdx = new Set();
    for (const m of reply.matchAll(/\[\[P:(\d+)\]\]/gi)) {
      const idx = parseInt(m[1]) - 1;
      if (!seenCardIdx.has(idx) && contextProducts[idx]) {
        seenCardIdx.add(idx);
        productCards.push(contextProducts[idx]);
      }
    }

    // Extract [[ACTION:type:value]]
    const actionMatch = reply.match(/\[\[ACTION:(filter_store|filter_category|highlight|show_product):([^\]]+)\]\]/i);
    let dashboardAction = null;
    if (actionMatch) {
      const type = actionMatch[1];
      const value = actionMatch[2].trim();
      if (type === 'highlight' || type === 'show_product') {
        const idx = parseInt(value) - 1;
        const p = contextProducts[idx];
        if (p) {
          dashboardAction = {
            type: 'show_product',
            productId: p.id,
            productName: p.name,
            productUrl: p.url
          };
        }
      } else {
        dashboardAction = { type, value };
      }
    }

    // Extract [[NOTIF:channel]]
    const notifMatch = reply.match(/\[\[NOTIF:(whatsapp|email)\]\]/i);

    // Extract [BUSCAR: keyword] — AI-driven search term overrides user keyword extraction
    const buscarMatch = reply.match(/\[BUSCAR:\s*(.*?)\]/i);
    let searchQuery = filterAction?.query || '';
    if (buscarMatch) {
      searchQuery = buscarMatch[1].trim();
      // AI keyword takes highest priority — override or create filterAction
      if (filterAction) {
        filterAction.query = searchQuery;
      } else {
        filterAction = { type: 'search', query: searchQuery, product_ids: [] };
      }
    }

    // Clean all markers from the reply
    const cleanReply = reply
      .replace(/\[\[P:\d+\]\]/gi, '')
      .replace(/\[\[ACTION:[^\]]+\]\]/gi, '')
      .replace(/\[\[NOTIF:[^\]]+\]\]/gi, '')
      .replace(/\[BUSCAR:\s*.*?\]/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const response = { ok: true, reply: cleanReply };
    if (productCards.length > 0) response.cards = productCards;
    if (dashboardAction) response.dashboardAction = dashboardAction;
    if (filterAction && !dashboardAction) response.filterAction = filterAction;
    if (notifMatch) {
      const channel = notifMatch[1].toLowerCase();
      response.action = { type: 'notify', channel, ...notifInfo };
    }
    res.json(response);
  } catch (e) {
    console.error('[Chat] Error:', e.message);
    if (e.status === 401 || e.status === 403) {
      return res.status(400).json({ ok: false, error: 'API key de Google Gemini inválida' });
    }
    res.status(500).json({ ok: false, error: 'Error al procesar el mensaje: ' + e.message });
  }
});

// ── HuntBot Chat Notify ───────────────────────────────────────────────────────

app.post('/api/chat/notify', async (req, res) => {
  try {
    const { channel, contact, product_hint, token, product_id } = req.body;
    if (!channel) return res.status(400).json({ ok: false, error: 'canal requerido' });

    // Pre-check: SMTP / Twilio configured?
    if (channel === 'email') {
      const gmailUser = process.env.GMAIL_USER || db.getConfig('gmail_user');
      const gmailPass = process.env.GMAIL_APP_PASSWORD || db.getConfig('gmail_app_password');
      if (!gmailUser || !gmailPass) {
        console.warn('[ChatNotify] SMTP not configured');
        return res.json({ ok: false, error: 'SMTP no configurado. Configura tu email en /admin o /setup.' });
      }
    } else {
      const sid = process.env.TWILIO_ACCOUNT_SID || db.getConfig('twilio_sid');
      const token2 = process.env.TWILIO_AUTH_TOKEN || db.getConfig('twilio_token');
      if (!sid || !token2) {
        console.warn('[ChatNotify] Twilio not configured');
        return res.json({ ok: false, error: 'WhatsApp (Twilio) no configurado. Configura en /admin.' });
      }
    }

    // Resolve user
    let user = null;
    if (token) user = db.getUserByToken(token);

    if (user) {
      const hasContact = channel === 'email' ? !!user.email : !!user.whatsapp;
      if (!hasContact) {
        return res.json({
          ok: false, code: 'no_contact', channel,
          message: channel === 'email'
            ? 'Tu cuenta no tiene un correo registrado.'
            : 'Tu cuenta no tiene un número de WhatsApp configurado.',
          profile_url: '/perfil.html'
        });
      }
    } else {
      if (!contact) return res.json({ ok: false, code: 'need_contact', channel });
      user = channel === 'email'
        ? { email: contact.trim(), name: 'Usuario' }
        : { whatsapp: contact.replace(/\D/g, '').replace(/^51/, ''), name: 'Usuario' };
    }

    // Resolve the specific product — prefer product_id sent by frontend
    let product = null;
    if (product_id) {
      const detail = db.getProductDetail(parseInt(product_id));
      if (detail) {
        const latestPrice = (detail.prices || []).slice(-1)[0] || {};
        product = {
          store: detail.store, name: detail.name, url: detail.url, image_url: detail.image_url,
          current_price: latestPrice.current_price || 0,
          original_price: latestPrice.original_price || 0,
          discount_percent: latestPrice.discount_percent || 0,
          urgency_score: latestPrice.urgency_score || 5,
          detected_at: latestPrice.detected_at || new Date().toISOString()
        };
      }
    }
    if (!product) {
      const { products } = db.getProductsForChat(10);
      if (product_hint) {
        const hint = product_hint.toLowerCase();
        product = products.find(p => p.name.toLowerCase().includes(hint)) || products[0];
      } else {
        product = products[0];
      }
    }
    if (!product) return res.json({ ok: false, error: 'No hay productos disponibles para enviar' });

    const productPayload = {
      store: product.store, name: product.name, url: product.url,
      current_price: product.current_price, original_price: product.original_price,
      discount_percent: product.discount_percent,
      urgency_score: product.urgency_score || 5,
      detected_at: product.detected_at || new Date().toISOString()
    };

    const dest = channel === 'email' ? user.email : user.whatsapp;
    console.log(`[ChatNotify] channel=${channel} dest=${dest} product="${product.name}" id=${product_id || 'top'}`);

    if (channel === 'email') {
      const gmailUser = process.env.GMAIL_USER || db.getConfig('gmail_user');
      const gmailPass = process.env.GMAIL_APP_PASSWORD || db.getConfig('gmail_app_password');
      console.log(`[EMAIL CHAT] Iniciando envío...`);
      console.log(`[EMAIL CHAT] SMTP config: user=${gmailUser || 'SIN USER'} pass=${gmailPass ? 'OK' : 'SIN PASS'}`);
      console.log(`[EMAIL CHAT] Enviando a: ${user.email}`);
      // sendOfferEmail throws on any failure so errors surface to the catch block
      await sendOfferEmail(user, productPayload);
      console.log(`[EMAIL CHAT] Enviado OK a ${user.email}`);
      res.json({ ok: true, message: `✅ Oferta enviada a ${user.email}` });
    } else {
      console.log(`[ChatNotify] Calling notifyWhatsApp to: ${user.whatsapp}`);
      await notifyWhatsApp(user, productPayload);
      console.log(`[ChatNotify] WhatsApp sent OK to ${user.whatsapp}`);
      res.json({ ok: true, message: '✅ Oferta enviada a tu WhatsApp' });
    }
  } catch (e) {
    console.error('[ChatNotify] Send failed:', e.message);
    if (e.message?.includes('EAUTH') || e.message?.includes('Invalid login') || e.message?.includes('535')) {
      return res.json({ ok: false, error: '⚠️ Error de autenticación SMTP. Verifica tu contraseña de aplicación Gmail en /admin → Notificaciones Email.' });
    }
    if (e.message?.includes('SMTP no configurado')) {
      return res.json({ ok: false, error: '⚠️ ' + e.message });
    }
    if (e.message?.includes('ENOTFOUND') || e.message?.includes('ECONNREFUSED')) {
      return res.json({ ok: false, error: '⚠️ No se pudo conectar al servidor de email. Verifica tu conexión y config SMTP en /admin.' });
    }
    res.status(500).json({ ok: false, error: `⚠️ Error al enviar: ${e.message}` });
  }
});

// ── WhatsApp Webhook ──────────────────────────────────────────────────────────

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const from = req.body.From || '';
    const body = req.body.Body || '';
    await handleIncomingMessage(from, body);
    res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (e) {
    res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, confirm_email, password, confirm_password, phone } = req.body;

    if (!username?.trim())          return res.status(400).json({ ok: false, error: 'Nombre de usuario requerido' });
    if (!email?.trim())             return res.status(400).json({ ok: false, error: 'Correo requerido' });
    if (email !== confirm_email)    return res.status(400).json({ ok: false, error: 'Los correos no coinciden' });
    if (!password || password.length < 8)
                                    return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 8 caracteres' });
    if (password !== confirm_password)
                                    return res.status(400).json({ ok: false, error: 'Las contraseñas no coinciden' });
    if (!phone || !/^\d{9}$/.test(phone))
                                    return res.status(400).json({ ok: false, error: 'El celular debe tener exactamente 9 dígitos' });

    const emailNorm = email.toLowerCase().trim();
    if (db.getUserByEmail(emailNorm))
      return res.status(409).json({ ok: false, field: 'email', error: 'Este correo ya está registrado. Intenta iniciar sesión.' });
    if (db.isPhoneTaken(phone))
      return res.status(409).json({ ok: false, field: 'phone', error: 'Este número de celular ya está registrado.' });

    const password_hash = await bcrypt.hash(password, 10);
    const userId = db.createAuthUser({ username: username.trim(), email: emailNorm, password_hash, phone });
    const user   = db.getUserById(userId);
    const token  = jwt.sign({ id: user.id, email: user.email, username: user.username }, getJwtSecret(), { expiresIn: '30d' });

    sendAuthWelcome(user).catch(() => {});

    res.json({
      ok: true, token,
      user: { id: user.id, username: user.username, email: user.email, phone: user.phone },
      message: '¡Bienvenido a HuntPrice Perú!'
    });
  } catch (e) {
    console.error('[Auth] Register:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, remember_me } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Correo y contraseña requeridos' });

    const user = db.getUserByEmail(email.toLowerCase().trim());
    if (!user || !user.password_hash)
      return res.status(401).json({ ok: false, error: 'Correo o contraseña incorrectos' });
    if (!user.active)
      return res.status(401).json({ ok: false, error: 'Esta cuenta ha sido desactivada' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: 'Correo o contraseña incorrectos' });

    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username },
      getJwtSecret(),
      { expiresIn: remember_me ? '30d' : '8h' }
    );

    res.json({
      ok: true, token,
      user: { id: user.id, username: user.username, email: user.email, phone: user.phone }
    });
  } catch (e) {
    console.error('[Auth] Login:', e.message);
    res.status(500).json({ ok: false, error: 'Error al iniciar sesión' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  try {
    const user = db.getUserById(req.authUser.id);
    if (!user || !user.active) return res.status(401).json({ ok: false, error: 'Sesión inválida' });
    res.json({ ok: true, user: { id: user.id, username: user.username, email: user.email, phone: user.phone } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/auth/account', requireAuth, async (req, res) => {
  try {
    const user = db.getUserById(req.authUser.id);
    if (!user || !user.active) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    db.softDeleteUser(user.id);
    sendAuthGoodbye(user).catch(() => {});
    res.json({ ok: true, message: '¡Hasta pronto! Tu cuenta ha sido dada de baja.' });
  } catch (e) {
    console.error('[Auth] Delete account:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'] || req.query.pass;
  const expected = process.env.ADMIN_PASSWORD || db.getConfig('admin_password') || 'huntprice2024';
  if (pass !== expected) return res.status(401).json({ ok: false, error: 'No autorizado' });
  next();
}

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, data: db.getStats() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, data: db.getUsers() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  try {
    db.getDb().prepare('UPDATE users SET active=0 WHERE id=?').run(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/scrape-logs', requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, data: db.getScrapeLogs(100) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/scrape', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, message: 'Escaneo iniciado' });
    scraper.runAll().catch(console.error);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/scraper-status', requireAdmin, (req, res) => {
  res.json({ ok: true, data: scraper.getLastResults() });
});

app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ ok: false, error: 'Email requerido' });
    await testEmail(email);
    res.json({ ok: true, message: 'Email de prueba enviado' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/test-whatsapp', requireAdmin, async (req, res) => {
  try {
    const { whatsapp } = req.body;
    if (!whatsapp) return res.status(400).json({ ok: false, error: 'Número requerido' });
    await testWhatsApp(whatsapp);
    res.json({ ok: true, message: 'WhatsApp de prueba enviado' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  const keys = ['gmail_user', 'twilio_sid', 'twilio_from', 'scan_interval', 'admin_password', 'gemini_api_key'];
  const config = {};
  keys.forEach(k => { config[k] = db.getConfig(k) || ''; });
  config.demo_mode = process.env.DEMO_MODE === 'true' || db.getConfig('demo_mode') === 'true';
  res.json({ ok: true, data: config });
});

app.post('/api/admin/config', requireAdmin, (req, res) => {
  try {
    const allowed = ['gmail_user', 'gmail_app_password', 'twilio_sid', 'twilio_token',
                     'twilio_from', 'scan_interval', 'admin_password', 'min_discount',
                     'demo_mode', 'gemini_api_key'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        db.setConfig(key, req.body[key]);
        if (key === 'gmail_user' || key === 'gmail_app_password') resetTransporter();
        if (key === 'twilio_sid' || key === 'twilio_token') resetClient();
      }
    }
    res.json({ ok: true, message: 'Configuración guardada' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Setup Wizard ──────────────────────────────────────────────────────────────

app.post('/api/setup', (req, res) => {
  try {
    const { gmail_user, gmail_app_password, twilio_sid, twilio_token, twilio_from,
            scan_interval, admin_password, demo_mode } = req.body;

    if (gmail_user) db.setConfig('gmail_user', gmail_user);
    if (gmail_app_password) db.setConfig('gmail_app_password', gmail_app_password);
    if (twilio_sid) db.setConfig('twilio_sid', twilio_sid);
    if (twilio_token) db.setConfig('twilio_token', twilio_token);
    if (twilio_from) db.setConfig('twilio_from', twilio_from);
    if (scan_interval) db.setConfig('scan_interval', scan_interval);
    if (admin_password) db.setConfig('admin_password', admin_password);
    db.setConfig('demo_mode', demo_mode ? 'true' : 'false');

    // Write to .env
    const envPath = path.join(__dirname, '.env');
    const envLines = [
      `PORT=${PORT}`,
      `ADMIN_PASSWORD=${admin_password || 'huntprice2024'}`,
      `GMAIL_USER=${gmail_user || ''}`,
      `GMAIL_APP_PASSWORD=${gmail_app_password || ''}`,
      `TWILIO_ACCOUNT_SID=${twilio_sid || ''}`,
      `TWILIO_AUTH_TOKEN=${twilio_token || ''}`,
      `TWILIO_WHATSAPP_FROM=${twilio_from || '+14155238886'}`,
      `SCAN_INTERVAL_MINUTES=${scan_interval || 15}`,
      `DEMO_MODE=${demo_mode ? 'true' : 'false'}`,
      `MIN_DISCOUNT_ALERT=30`
    ];
    fs.writeFileSync(envPath, envLines.join('\n'));

    db.setConfig('setup_done', 'true');
    resetTransporter();
    resetClient();

    res.json({ ok: true, message: '¡Configuración guardada! Redirigiendo...' });

    // Start scraper after setup
    setTimeout(() => scraper.runAll().catch(console.error), 2000);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/setup/status', (req, res) => {
  res.json({ ok: true, done: db.isSetupDone() });
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/perfil', (req, res) => res.sendFile(path.join(__dirname, 'public', 'perfil.html')));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║        🔥  HUNTPRICE PERÚ  v1.0.0               ║
╠══════════════════════════════════════════════════╣
║  Servidor:   http://localhost:${PORT}              ║
║  Admin:      http://localhost:${PORT}/admin        ║
║  Setup:      http://localhost:${PORT}/setup.html   ║
╚══════════════════════════════════════════════════╝
  `);

  // Init database
  db.getDb();

  if (db.isSetupDone()) {
    scraper.startScheduler();
  } else {
    console.log('⚙️  Primera ejecución: visita http://localhost:' + PORT + '/setup.html');
    // Seed demo data anyway for preview
    setTimeout(() => {
      const { seedDemoData } = require('./scraper/index');
      seedDemoData().catch(console.error);
    }, 1000);
  }
});

module.exports = app;
