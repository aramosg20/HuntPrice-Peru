'use strict';
require('dotenv').config();
const nodemailer = require('nodemailer');
const db = require('../database/db');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const gmailUser = process.env.GMAIL_USER || db.getConfig('gmail_user');
  const gmailPass = process.env.GMAIL_APP_PASSWORD || db.getConfig('gmail_app_password');
  if (!gmailUser || !gmailPass) return null;

  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailPass }
  });
  return transporter;
}

function resetTransporter() { transporter = null; }

async function notifyUsers(users, product, opts = {}) {
  const t = getTransporter();
  if (!t) { console.warn('[Email] No SMTP config'); return; }

  for (const user of users) {
    if (!user.email) continue;
    try {
      if (opts.digest) {
        await t.sendMail(buildDigestEmail(user, opts.offers));
      } else if (product) {
        await t.sendMail(buildProductEmail(user, product));
      }
    } catch (e) {
      console.error('[Email] Error sending to', user.email, e.message);
    }
  }
}

async function sendLastChance(user, product) {
  const t = getTransporter();
  if (!t) return;
  await t.sendMail(buildLastChanceEmail(user, product));
}

async function testEmail(to) {
  const t = getTransporter();
  if (!t) throw new Error('Sin configuración SMTP');
  await t.sendMail({
    from: `"HuntPrice Perú 🔥" <${process.env.GMAIL_USER}>`,
    to,
    subject: '✅ HuntPrice Perú - Conexión exitosa',
    html: `<div style="font-family:Inter,sans-serif;background:#0d0d0d;color:#fff;padding:30px;border-radius:12px">
      <h2 style="color:#FF6600">🎉 ¡Configuración exitosa!</h2>
      <p>Tu cuenta de email está conectada a <strong>HuntPrice Perú</strong>.</p>
      <p>Recibirás notificaciones de ofertas aquí.</p>
    </div>`
  });
}

// ─── Templates ────────────────────────────────────────────────────────────────

function buildProductEmail(user, product) {
  const discount = Math.round(product.discount_percent);
  const badgeColor = discount >= 70 ? '#FF3333' : discount >= 50 ? '#FF6600' : '#FFB800';
  const saving = (product.original_price - product.current_price).toFixed(2);

  return {
    from: `"HuntPrice Perú 🔥" <${process.env.GMAIL_USER || db.getConfig('gmail_user')}>`,
    to: user.email,
    subject: `🔥 -${discount}% en ${product.name.substring(0, 50)} | HuntPrice Perú`,
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:'Inter',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:20px">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border-radius:16px;overflow:hidden;border:1px solid #2a2a2a">
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#FF6600,#FF4400);padding:24px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:28px;font-weight:800">🔥 HUNTPRICE PERÚ</h1>
          <p style="color:rgba(255,255,255,0.9);margin:6px 0 0;font-size:14px">Monitor de Ofertas Flash</p>
        </td></tr>
        <!-- Alert badge -->
        <tr><td style="padding:20px;text-align:center">
          <span style="background:${badgeColor};color:#fff;font-size:42px;font-weight:900;padding:12px 32px;border-radius:50px;display:inline-block">-${discount}%</span>
          <p style="color:#888;font-size:12px;margin:12px 0 0">¡OFERTA DETECTADA!</p>
        </td></tr>
        <!-- Product image -->
        ${product.image_url ? `<tr><td style="padding:0 30px;text-align:center">
          <img src="${product.image_url}" alt="${product.name}" style="max-width:280px;max-height:220px;object-fit:contain;border-radius:12px;background:#222">
        </td></tr>` : ''}
        <!-- Product info -->
        <tr><td style="padding:24px 30px">
          <p style="color:#888;font-size:12px;margin:0 0 8px;text-transform:uppercase">${product.store} • ${product.category || 'General'}</p>
          <h2 style="color:#fff;margin:0 0 20px;font-size:20px;line-height:1.4">${product.name}</h2>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="background:#222;border-radius:12px;padding:20px;text-align:center">
                <p style="color:#888;font-size:13px;margin:0 0 4px">Precio anterior</p>
                <p style="color:#666;font-size:22px;margin:0;text-decoration:line-through">S/. ${product.original_price.toFixed(2)}</p>
              </td>
              <td width="20"></td>
              <td style="background:#0a2a1a;border:2px solid #00CC66;border-radius:12px;padding:20px;text-align:center">
                <p style="color:#00CC66;font-size:13px;margin:0 0 4px">¡Precio AHORA!</p>
                <p style="color:#00FF88;font-size:34px;font-weight:800;margin:0">S/. ${product.current_price.toFixed(2)}</p>
              </td>
            </tr>
          </table>
          <p style="color:#FF6600;font-size:16px;font-weight:700;text-align:center;margin:16px 0">💰 Ahorras S/. ${saving}</p>
          ${product.urgency_score >= 8 ? '<p style="color:#FF3333;font-size:13px;text-align:center;background:#2a1a1a;padding:8px;border-radius:8px;margin:0 0 16px">⚡ ¡URGENTE! Pocas unidades disponibles</p>' : ''}
        </td></tr>
        <!-- CTA button -->
        <tr><td style="padding:0 30px 30px;text-align:center">
          <a href="${product.url}" style="display:inline-block;background:linear-gradient(135deg,#FF6600,#FF4400);color:#fff;text-decoration:none;padding:16px 48px;border-radius:50px;font-size:18px;font-weight:800;letter-spacing:0.5px">🛒 COMPRAR AHORA</a>
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:#111;padding:20px 30px;text-align:center;border-top:1px solid #222">
          <p style="color:#555;font-size:12px;margin:0">Hola ${user.name} · Detectado el ${new Date().toLocaleString('es-PE')}</p>
          <p style="color:#555;font-size:12px;margin:8px 0 0">HuntPrice Perú – Monitor automático de precios · <a href="#" style="color:#FF6600">Darse de baja</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
  };
}

function buildDigestEmail(user, offers) {
  const offerRows = offers.map(p => {
    const discount = Math.round(p.discount_percent);
    const color = discount >= 70 ? '#FF3333' : discount >= 50 ? '#FF6600' : '#FFB800';
    return `
    <tr>
      <td style="padding:12px;border-bottom:1px solid #222">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="50" style="vertical-align:middle">
              <span style="background:${color};color:#fff;font-size:14px;font-weight:800;padding:4px 8px;border-radius:20px">-${discount}%</span>
            </td>
            <td style="padding-left:12px;vertical-align:middle">
              <p style="color:#fff;margin:0;font-size:14px">${p.name.substring(0, 60)}</p>
              <p style="color:#888;margin:2px 0 0;font-size:12px">${p.store}</p>
            </td>
            <td style="text-align:right;vertical-align:middle;white-space:nowrap">
              <p style="color:#00FF88;margin:0;font-size:18px;font-weight:800">S/. ${p.current_price.toFixed(2)}</p>
              <p style="color:#555;margin:0;font-size:11px;text-decoration:line-through">S/. ${p.original_price.toFixed(2)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }).join('');

  return {
    from: `"HuntPrice Perú 🔥" <${process.env.GMAIL_USER || db.getConfig('gmail_user')}>`,
    to: user.email,
    subject: `🔥 Las ${offers.length} mejores ofertas del día | HuntPrice Perú`,
    html: `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0d0d0d;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:20px">
<table width="600" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border-radius:16px;overflow:hidden">
  <tr><td style="background:linear-gradient(135deg,#FF6600,#FF4400);padding:24px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:24px">🌅 RESUMEN MATUTINO</h1>
    <p style="color:rgba(255,255,255,0.9);margin:6px 0 0;font-size:13px">${new Date().toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
  </td></tr>
  <tr><td style="padding:20px 30px">
    <p style="color:#888;font-size:14px;margin:0 0 16px">Hola ${user.name}, estas son las mejores ofertas detectadas hoy:</p>
    <table width="100%" cellpadding="0" cellspacing="0">${offerRows}</table>
    <div style="text-align:center;margin-top:24px">
      <a href="http://localhost:3000" style="display:inline-block;background:linear-gradient(135deg,#FF6600,#FF4400);color:#fff;text-decoration:none;padding:14px 40px;border-radius:50px;font-size:16px;font-weight:800">VER TODAS LAS OFERTAS</a>
    </div>
  </td></tr>
  <tr><td style="background:#111;padding:16px;text-align:center;border-top:1px solid #222">
    <p style="color:#555;font-size:11px;margin:0">HuntPrice Perú · <a href="#" style="color:#FF6600">Darse de baja</a></p>
  </td></tr>
</table></td></tr></table>
</body></html>`
  };
}

function buildLastChanceEmail(user, product) {
  return {
    from: `"HuntPrice Perú 🔥" <${process.env.GMAIL_USER || db.getConfig('gmail_user')}>`,
    to: user.email,
    subject: `⚠️ ÚLTIMA OPORTUNIDAD: ${product.name.substring(0, 40)}`,
    html: `<div style="font-family:Arial;background:#0d0d0d;color:#fff;padding:30px;max-width:500px;border-radius:12px">
      <h2 style="color:#FF3333">⚠️ ¡ÚLTIMA OPORTUNIDAD!</h2>
      <p>El stock de <strong>${product.name}</strong> está por agotarse.</p>
      <p style="font-size:24px;color:#00FF88">S/. ${product.current_price.toFixed(2)}</p>
      <a href="${product.url}" style="background:#FF6600;color:#fff;padding:12px 30px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:16px">🛒 COMPRAR YA</a>
    </div>`
  };
}

async function sendAlertConfirmation(email, product, targetPrice) {
  const t = getTransporter();
  if (!t) {
    console.warn('[Email] SMTP no configurado – se omite email de confirmación de alerta');
    return;
  }

  const latest = product.prices?.[product.prices.length - 1] || {};
  const currentPrice = latest.current_price || 0;
  const discount = Math.round(latest.discount_percent || 0);
  const fromEmail = process.env.GMAIL_USER || db.getConfig('gmail_user');
  const target = targetPrice ? parseFloat(targetPrice) : null;

  await t.sendMail({
    from: `"HuntPrice Perú 🔥" <${fromEmail}>`,
    to: email,
    subject: `🔔 Alerta activada: ${product.name.substring(0, 50)} | HuntPrice Perú`,
    html: `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0d0d0d;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:20px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border-radius:16px;overflow:hidden;border:1px solid #2a2a2a">

  <!-- Header -->
  <tr><td style="background:linear-gradient(135deg,#0d1a0d,#141414);padding:28px;text-align:center;border-bottom:1px solid #2a2a2a">
    <div style="font-size:48px;margin-bottom:8px">🔔</div>
    <h2 style="color:#00FF88;margin:0;font-size:22px;font-weight:800">¡Alerta activada!</h2>
    <p style="color:#666;font-size:13px;margin:8px 0 0">Te avisaremos cuando el precio baje</p>
  </td></tr>

  <!-- Product info -->
  <tr><td style="padding:24px">
    <p style="color:#666;font-size:11px;margin:0 0 4px;text-transform:uppercase;letter-spacing:0.5px">${escStr(product.store)} · ${escStr(product.category || 'General')}</p>
    <h3 style="color:#fff;font-size:17px;font-weight:700;margin:0 0 20px;line-height:1.4">${escStr(product.name)}</h3>

    <!-- Prices -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">
      <tr>
        <td style="background:#222;border-radius:10px;padding:16px;text-align:center">
          <div style="color:#888;font-size:11px;margin-bottom:6px">PRECIO ACTUAL</div>
          <div style="color:#fff;font-size:24px;font-weight:900">S/. ${currentPrice.toFixed(2)}</div>
          <div style="display:inline-block;background:#FF3333;color:#fff;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:800;margin-top:6px">-${discount}%</div>
        </td>
        ${target ? `
        <td width="12"></td>
        <td style="background:#0a2a1a;border:2px solid #00CC66;border-radius:10px;padding:16px;text-align:center">
          <div style="color:#00CC66;font-size:11px;margin-bottom:6px">TU PRECIO OBJETIVO</div>
          <div style="color:#00FF88;font-size:24px;font-weight:900">S/. ${target.toFixed(2)}</div>
          <div style="color:#888;font-size:11px;margin-top:6px">Notificamos al llegar aquí</div>
        </td>` : ''}
      </tr>
    </table>

    <!-- Info box -->
    <div style="background:#1a1400;border:1px solid #3a3000;border-radius:8px;padding:14px;margin-bottom:20px">
      <p style="color:#FFB800;font-size:13px;margin:0">
        ⚡ Recibirás un email inmediatamente cuando detectemos que el precio bajó${target ? ` a S/. ${target.toFixed(2)} o menos` : ''}.
      </p>
    </div>

    <!-- CTA -->
    <div style="text-align:center">
      <a href="${escStr(product.url)}" style="display:inline-block;background:linear-gradient(135deg,#FF6600,#CC4400);color:#fff;text-decoration:none;padding:14px 36px;border-radius:50px;font-size:15px;font-weight:800">
        🛒 Ver oferta
      </a>
    </div>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#111;padding:16px 24px;text-align:center;border-top:1px solid #1e1e1e">
    <p style="color:#444;font-size:11px;margin:0">HuntPrice Perú — Monitor automático de precios</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`
  });
}

// Sends a single offer email and THROWS on any failure (for use in /api/chat/notify)
async function sendOfferEmail(user, product) {
  const t = getTransporter();
  if (!t) throw new Error('SMTP no configurado. Ve a /admin → Notificaciones Email y completa los datos.');
  console.log(`[Email] sendOfferEmail → ${user.email} | "${product.name}"`);
  await t.sendMail(buildProductEmail(user, product));
  console.log(`[Email] sendOfferEmail OK → ${user.email}`);
}

function escStr(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function sendWelcomeEmail(user) {
  const t = getTransporter();
  if (!t) return;
  const name = user.username || user.name || 'cazador de ofertas';
  await t.sendMail({
    from: `"HuntPrice Perú 🔥" <${process.env.GMAIL_USER || db.getConfig('gmail_user')}>`,
    to: user.email,
    subject: '🎉 ¡Bienvenido a HuntPrice Perú!',
    html: `<div style="font-family:Inter,Arial,sans-serif;background:#0d0d0d;color:#fff;padding:32px;border-radius:14px;max-width:520px;margin:auto">
      <div style="font-size:48px;text-align:center;margin-bottom:12px">🔥</div>
      <h2 style="color:#FF6600;text-align:center;margin:0 0 8px">¡Bienvenido, ${name}!</h2>
      <p style="color:#ccc;text-align:center;margin:0 0 24px;font-size:14px">Ya eres parte de la comunidad de cazadores de ofertas más activa de Perú.</p>
      <div style="background:#1a1a1a;border-radius:10px;padding:20px;margin-bottom:20px">
        <p style="margin:0 0 8px;font-size:14px;color:#fff">Con tu cuenta puedes:</p>
        <ul style="color:#ccc;font-size:13px;margin:0;padding-left:20px;line-height:1.8">
          <li>💬 Chatear con HuntBot para encontrar las mejores ofertas</li>
          <li>🔔 Crear alertas personalizadas de precio</li>
          <li>📊 Ver el historial de precios de cualquier producto</li>
        </ul>
      </div>
      <a href="https://huntprice.pe" style="display:block;background:#FF6600;color:#fff;text-align:center;padding:13px;border-radius:9px;text-decoration:none;font-weight:700;font-size:15px">Ver ofertas ahora →</a>
      <p style="color:#555;font-size:11px;text-align:center;margin-top:20px">HuntPrice Perú · Monitor automático de precios</p>
    </div>`
  });
}

async function sendGoodbyeEmail(user) {
  const t = getTransporter();
  if (!t) return;
  const name = user.username || user.name || 'amigo';
  await t.sendMail({
    from: `"HuntPrice Perú 🔥" <${process.env.GMAIL_USER || db.getConfig('gmail_user')}>`,
    to: user.email,
    subject: '😢 Qué pena que nos dejes, HuntPrice Perú',
    html: `<div style="font-family:Inter,Arial,sans-serif;background:#0d0d0d;color:#fff;padding:32px;border-radius:14px;max-width:520px;margin:auto">
      <div style="font-size:48px;text-align:center;margin-bottom:12px">😢</div>
      <h2 style="color:#FF6600;text-align:center;margin:0 0 8px">Qué pena que nos dejes, ${name}</h2>
      <p style="color:#ccc;text-align:center;margin:0 0 20px;font-size:14px">Tu cuenta ha sido dada de baja exitosamente. Esperamos verte pronto.</p>
      <p style="color:#888;font-size:13px;text-align:center">Si cambiás de opinión, siempre puedes crear una cuenta nueva en HuntPrice Perú.</p>
      <p style="color:#555;font-size:11px;text-align:center;margin-top:24px">HuntPrice Perú · Monitor automático de precios</p>
    </div>`
  });
}

module.exports = { notifyUsers, sendLastChance, testEmail, sendAlertConfirmation, sendOfferEmail, resetTransporter, sendWelcomeEmail, sendGoodbyeEmail };
