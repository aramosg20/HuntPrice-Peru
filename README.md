# 🔥 HuntPrice Perú

Monitor automático de ofertas flash y descuentos extremos de tiendas por departamento peruanas.

**Tiendas monitoreadas:** Falabella · Ripley · Oechsle · Sodimac · Promart · PlazaVea

---

## ⚡ Inicio Rápido (Termux)

```bash
# 1. Instalar dependencias de sistema
pkg update && pkg install nodejs

# 2. Ir al directorio
cd ~/huntprice

# 3. Dar permisos al script e iniciar
chmod +x start.sh
./start.sh

# 4. Abrir en el navegador
# → http://localhost:3000
```

---

## 📱 Instalación en Termux desde cero

```bash
# Actualizar paquetes
pkg update && pkg upgrade

# Instalar Node.js
pkg install nodejs

# Navegar al proyecto
cd ~/huntprice

# Instalar dependencias npm
npm install

# Crear archivo de configuración
cp .env.example .env

# Iniciar
node server.js
```

---

## ⚙️ Configuración

### Opción 1: Wizard de Setup (recomendado)
Al iniciar por primera vez, visita **http://localhost:3000/setup.html** y completa el formulario.

### Opción 2: Editar .env manualmente
```bash
nano .env
```

Variables disponibles:
```env
PORT=3000
ADMIN_PASSWORD=huntprice2024
DEMO_MODE=true              # true = datos de ejemplo, false = scraping real

# Email (Gmail)
GMAIL_USER=tu@gmail.com
GMAIL_APP_PASSWORD=xxxx_xxxx_xxxx_xxxx

# WhatsApp (Twilio)
TWILIO_ACCOUNT_SID=ACxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_WHATSAPP_FROM=+14155238886

# Scraping
SCAN_INTERVAL_MINUTES=15
MIN_DISCOUNT_ALERT=30
```

---

## 📧 Configurar Gmail SMTP

1. Ve a [myaccount.google.com](https://myaccount.google.com)
2. Seguridad → Verificación en 2 pasos (activar)
3. Contraseñas de aplicación → Crear una para "HuntPrice"
4. Copia los 16 caracteres en `GMAIL_APP_PASSWORD`

---

## 💬 Configurar WhatsApp (Twilio)

1. Crea cuenta en [twilio.com](https://www.twilio.com) (gratis)
2. Ve a **Messaging → Try it out → Send a WhatsApp message**
3. Activa el sandbox siguiendo las instrucciones
4. Copia Account SID y Auth Token al `.env`
5. Los usuarios deben enviar el código de activación al número del sandbox

---

## 🌐 Páginas

| URL | Descripción |
|-----|-------------|
| `http://localhost:3000` | Dashboard de ofertas |
| `http://localhost:3000/admin` | Panel de administración |
| `http://localhost:3000/setup.html` | Wizard de configuración |

---

## 📂 Estructura del Proyecto

```
huntprice/
├── server.js              # Servidor Express principal
├── database/
│   └── db.js              # SQLite + esquema + consultas
├── scraper/
│   ├── index.js           # Orquestador + cron scheduler
│   ├── falabella.js       # Scraper Falabella
│   ├── ripley.js          # Scraper Ripley
│   ├── oechsle.js         # Scraper Oechsle
│   ├── sodimac.js         # Scraper Sodimac
│   ├── promart.js         # Scraper Promart
│   └── plazavea.js        # Scraper PlazaVea
├── notifications/
│   ├── email.js           # Nodemailer + templates HTML
│   └── whatsapp.js        # Twilio WhatsApp
├── public/
│   ├── index.html         # Dashboard principal (PWA)
│   ├── admin.html         # Panel de administración
│   ├── setup.html         # Wizard de configuración
│   ├── manifest.json      # PWA manifest
│   ├── sw.js              # Service Worker
│   ├── css/styles.css     # Estilos dark theme
│   └── js/app.js          # JavaScript frontend
├── .env.example           # Plantilla de variables
├── start.sh               # Script de inicio
└── package.json
```

---

## 🔧 API REST

```
GET  /api/products          # Listar ofertas (con filtros)
GET  /api/products/:id      # Detalle + historial de precios
GET  /api/stats             # Estadísticas generales
GET  /api/categories        # Categorías disponibles
POST /api/users             # Registrar usuario para alertas
POST /api/alerts            # Crear alerta de producto
GET  /api/events            # SSE para actualizaciones en tiempo real

# Admin (requiere X-Admin-Password header)
GET  /api/admin/stats
GET  /api/admin/users
GET  /api/admin/scrape-logs
POST /api/admin/scrape      # Forzar escaneo
POST /api/admin/config      # Actualizar configuración

# WhatsApp webhook
POST /webhook/whatsapp
```

### Filtros disponibles para /api/products
```
?store=Falabella            # Filtrar por tienda
?category=Electrónica       # Filtrar por categoría
?minDiscount=50             # Descuento mínimo %
?maxPrice=500               # Precio máximo en soles
?q=samsung                  # Búsqueda por texto
?sort=discount|price|recent|urgency
?limit=30&offset=0          # Paginación
```

---

## 🤖 Modo Demo vs Scraping Real

**Modo Demo** (`DEMO_MODE=true`): Carga 25 productos de ejemplo con precios y descuentos realistas. Ideal para probar la app sin configurar scrapers.

**Scraping Real** (`DEMO_MODE=false`): Hace scraping real de las tiendas cada N minutos. Nota: los selectores HTML pueden necesitar ajuste si las tiendas cambian su estructura web.

---

## 🛠️ Solución de Problemas

**better-sqlite3 no compila:**
```bash
pkg install python make clang
npm install --build-from-source
```

**Puerto en uso:**
```bash
# Ver qué usa el puerto 3000
lsof -i :3000
# Cambiar puerto en .env: PORT=3001
```

**El scraping no funciona:**
- Las tiendas pueden bloquear scrapers automáticos
- Activa DEMO_MODE=true para datos de ejemplo
- Verifica que tengas conexión a internet

---

## 📊 Funcionalidades

- ✅ Dashboard con grid de ofertas en tiempo real
- ✅ Filtros: tienda, categoría, % descuento, precio máximo
- ✅ Búsqueda en tiempo real
- ✅ Historial de precios por producto (gráfico SVG)
- ✅ Badge "MÍNIMO HISTÓRICO"
- ✅ Score de urgencia 1-10
- ✅ Alertas personalizadas por email y WhatsApp
- ✅ Resumen diario a las 8am
- ✅ Admin panel con stats y logs en tiempo real
- ✅ SSE para actualizaciones live sin recarga
- ✅ PWA instalable (Service Worker + manifest)
- ✅ Modo oscuro / claro
- ✅ Confetti para ofertas >80%
- ✅ Diseño mobile-first (optimizado para tablets)

---

*HuntPrice Perú – Caza las mejores ofertas 🔥*
