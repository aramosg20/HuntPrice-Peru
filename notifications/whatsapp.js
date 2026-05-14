'use strict';
require('dotenv').config();
const db = require('../database/db');

let twilioClient = null;

function getClient() {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID || db.getConfig('twilio_sid');
  const token = process.env.TWILIO_AUTH_TOKEN || db.getConfig('twilio_token');
  if (!sid || !token) return null;
  const twilio = require('twilio');
  twilioClient = twilio(sid, token);
  return twilioClient;
}

function resetClient() { twilioClient = null; }

function getFromNumber() {
  const n = process.env.TWILIO_WHATSAPP_FROM || db.getConfig('twilio_from') || '+14155238886';
  return `whatsapp:${n}`;
}

async function notifyWhatsApp(user, product) {
  const client = getClient();
  if (!client) { console.warn('[WhatsApp] No Twilio config'); return; }
  if (!user.whatsapp) return;

  const discount = Math.round(product.discount_percent);
  const urgencyEmoji = product.urgency_score >= 8 ? '🚨' : product.urgency_score >= 6 ? '🔥' : '💰';
  const minutesAgo = Math.round((Date.now() - new Date(product.detected_at).getTime()) / 60000);
  const timeStr = minutesAgo < 1 ? 'justo ahora' : `hace ${minutesAgo} min`;

  const body = `${urgencyEmoji} *OFERTA FLASH en ${product.store.toUpperCase()}*

📦 ${product.name}

~~S/. ${product.original_price.toFixed(2)}~~ → *S/. ${product.current_price.toFixed(2)}* (-${discount}%)

⏰ Detectado ${timeStr}
🛒 ${product.url}

_Responde *MÁS* para detalles o *STOP* para darte de baja_`;

  const to = `whatsapp:${user.whatsapp}`;
  await client.messages.create({ from: getFromNumber(), to, body });
}

async function sendDigestWhatsApp(user, offers) {
  const client = getClient();
  if (!client || !user.whatsapp) return;

  const lines = offers.slice(0, 5).map((p, i) =>
    `${i + 1}. *${p.name.substring(0, 45)}*\n   S/. ${p.current_price.toFixed(2)} (-${Math.round(p.discount_percent)}%) en ${p.store}`
  ).join('\n\n');

  const body = `🌅 *Resumen matutino HuntPrice*\n\n${lines}\n\n_Ver todas: localhost:3000_`;
  await client.messages.create({ from: getFromNumber(), to: `whatsapp:${user.whatsapp}`, body });
}

async function handleIncomingMessage(from, body) {
  const client = getClient();
  if (!client) return;

  const normalized = from.replace('whatsapp:', '');
  const command = (body || '').toUpperCase().trim();

  if (command === 'STOP') {
    const d = db.getDb();
    d.prepare("UPDATE users SET active=0 WHERE whatsapp=?").run(normalized);
    await client.messages.create({
      from: getFromNumber(),
      to: from,
      body: '✅ Te has dado de baja de HuntPrice Perú. Responde *REACTIVAR* para volver.'
    });
  } else if (command === 'REACTIVAR') {
    const d = db.getDb();
    d.prepare("UPDATE users SET active=1 WHERE whatsapp=?").run(normalized);
    await client.messages.create({
      from: getFromNumber(),
      to: from,
      body: '🎉 ¡Bienvenido de vuelta! Volverás a recibir alertas de ofertas.'
    });
  } else if (command === 'MÁS' || command === 'MAS') {
    const offers = db.getActiveOffers().slice(0, 3);
    if (offers.length === 0) {
      await client.messages.create({ from: getFromNumber(), to: from, body: '😔 No hay ofertas activas en este momento.' });
    } else {
      const lines = offers.map(p =>
        `🔥 *${p.name.substring(0, 50)}*\nS/. ${p.current_price.toFixed(2)} (-${Math.round(p.discount_percent)}%)\n${p.url}`
      ).join('\n\n');
      await client.messages.create({ from: getFromNumber(), to: from, body: `Las mejores ofertas ahora:\n\n${lines}` });
    }
  }
}

async function testWhatsApp(to) {
  const client = getClient();
  if (!client) throw new Error('Sin configuración Twilio');
  await client.messages.create({
    from: getFromNumber(),
    to: `whatsapp:${to}`,
    body: '✅ *HuntPrice Perú* - ¡Configuración exitosa!\n\nRecibirás alertas de ofertas aquí. 🔥'
  });
}

async function sendWelcomeWhatsApp(user) {
  const client = getClient();
  if (!client || !user.phone) return;
  const name = user.username || user.name || 'cazador de ofertas';
  const to = `whatsapp:+51${user.phone}`;
  await client.messages.create({
    from: getFromNumber(), to,
    body: `🔥 *¡Bienvenido a HuntPrice Perú, ${name}!*\n\nYa eres parte de la comunidad de cazadores de ofertas más activa del país.\n\n💬 Puedes chatear con HuntBot para encontrar las mejores ofertas en tiempo real.\n\n👉 https://huntprice.pe`
  });
}

async function sendGoodbyeWhatsApp(user) {
  const client = getClient();
  if (!client || !user.phone) return;
  const name = user.username || user.name || 'amigo';
  const to = `whatsapp:+51${user.phone}`;
  await client.messages.create({
    from: getFromNumber(), to,
    body: `😢 *Qué pena que nos dejes, ${name}.*\n\nTu cuenta en HuntPrice Perú ha sido dada de baja. Esperamos verte pronto.\n\nSi cambias de opinión, siempre puedes registrarte de nuevo. ¡Hasta pronto!`
  });
}

async function sendReactivationWhatsApp(user) {
  const client = getClient();
  if (!client || !user.phone) return;
  const name = user.username || user.name || 'amigo';
  const to = `whatsapp:+51${user.phone}`;
  await client.messages.create({
    from: getFromNumber(), to,
    body: `🎉 *¡Bienvenido de vuelta a HuntPrice Perú, ${name}!*\n\nNos alegra que hayas vuelto. Tu cuenta ha sido reactivada.\n\n🔥 Ya puedes recibir alertas de ofertas nuevamente.\n\n👉 https://huntprice.pe`
  });
}

module.exports = { notifyWhatsApp, sendDigestWhatsApp, handleIncomingMessage, testWhatsApp, resetClient, sendWelcomeWhatsApp, sendGoodbyeWhatsApp, sendReactivationWhatsApp };
