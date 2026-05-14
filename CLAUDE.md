# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the server (requires Node.js 22.5+)
node server.js
# or
./start.sh

# Install dependencies
npm install

# Verify a scraper works in isolation (replace with any scraper name)
node -e "require('./scraper/mercadolibre').scrape().then(p => console.log(p.length, p[0]?.name))"

# Check JS syntax for a file without running it
node --check scraper/sodimac.js

# Inspect the SQLite database directly
node -e "const db = require('./database/db'); const d = db.getDb(); console.log(d.prepare('SELECT store, COUNT(*) as n FROM products GROUP BY store').all())"

# Reset demo data (deletes all products and re-seeds)
node -e "const db = require('./database/db'); db.getDb().exec('DELETE FROM products; DELETE FROM prices'); require('./scraper/index').seedDemoData()"
```

No lint, build, or test commands exist — this project has no test suite or bundler.

**Node.js 22.5+ is strictly required** — `database/db.js` uses the built-in `node:sqlite` module (`DatabaseSync`), which was added in Node 22.5. This avoids native compilation of `better-sqlite3`.

## Architecture

### Request flow

```
Browser → Express (server.js)
            ├── Static files  → public/
            ├── /api/*        → db.js queries
            ├── /api/chat     → Anthropic SDK → Claude
            └── Admin routes  → requireAdmin middleware (X-Admin-Password header)

Cron (node-cron) → scraper/index.js → each scraper → db.upsertProduct + db.insertPrice
                                                    → sendAlerts → email.js / whatsapp.js
                                                    → SSE broadcast to connected browsers
```

### Database (`database/db.js`)

Single SQLite file at `huntprice.db`. All queries are synchronous (`DatabaseSync`). Key design decisions:

- **Products are upserted by URL** — same URL = update name/image, never duplicate.
- **Prices are append-only** — every scrape creates a new `prices` row, enabling price history charts.
- **`is_historical_min`** is set on the cheapest-ever price row for a product; old rows are unset.
- **`urgency_score` (1–10)** is calculated from discount %, stock count, and flash deadline.
- **`app_config`** table is a key/value store for all runtime settings (Gmail, Twilio, Anthropic key, scan interval, admin password, demo mode). Settings can be set via `/admin` and are read at runtime — no restart needed for most settings.
- Schema migrations run at startup via `ALTER TABLE … ADD COLUMN` wrapped in try/catch (idempotent).

### Scraper system (`scraper/`)

Each scraper exports `{ scrape(), STORE }`. `scrape()` returns an array of product objects:

```js
{
  store, name, category, url, image_url,
  current_price, original_price, discount_percent, stock_info
}
```

**To add a new store:** create `scraper/newstore.js`, add it to the `scrapers` array in `scraper/index.js`, and add the store name to the hardcoded list in `server.js` (`/api/stores`). Also add a demo product and a base URL to `seedDemoData()` in `scraper/index.js`.

#### Scraping strategies by store

| Store | Method | Why |
|---|---|---|
| Falabella | `axios` + parse `__NEXT_DATA__` | Next.js SSR embeds full product JSON |
| Ripley | `curl` + parse `__NEXT_DATA__` | Cloudflare blocks Node.js TLS fingerprint; curl bypasses it |
| Oechsle | `axios` → VTEX catalog API | VTEX exposes a public JSON REST API |
| Promart | `axios` → VTEX catalog API | Same as Oechsle |
| PlazaVea | `axios` → VTEX catalog API | Same as Oechsle |
| Sodimac | `curl` + multi-pattern JSON extraction | Custom ATG/Endeca platform, JS-rendered; tries API, `__NEXT_DATA__`, state vars, and HTML data attrs |
| Mercado Libre | `curl` + parse `_n.ctx.r={…}` | Public API returns 403; data is in the `__NORDIC_RENDERING_CTX__` script tag as `_n.ctx.r={…}` |
| Coolbox | `curl` + JSON-LD / Shopify patterns | Standard e-commerce schemas |
| Samsung | `curl` + internal API + Next.js + `digitalData` | Multiple fallback patterns |

`curl` is used (via `child_process.execFileSync`) instead of `axios` on sites that block Node.js's TLS fingerprint. The 2–3s `delay()` between requests is intentional rate-limiting.

### Real-time updates (SSE)

`GET /api/events` keeps an open connection. `scraper/index.js` holds a reference to the `sseClients` array (set via `setSseClients()` at startup) and calls `broadcast(event, data)` to push events: `scraper_status`, `new_offers`, `scan_start`, `scan_done`. The frontend (`app.js`) listens with `EventSource` and calls `reloadProducts()` / `loadStats()` on relevant events.

### HuntBot chatbot (`POST /api/chat`)

Uses Node's built-in `https` module — no SDK dependency. The API key is read from `process.env.GEMINI_API_KEY` or `db.getConfig('gemini_api_key')` (set via admin panel under "Google Gemini API Key"). Each request fetches the top 25 discounted products from the DB as context, constructs a system prompt as "HuntBot" (expert on Peruvian store deals), and calls `gemini-2.5-flash` via `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`. Conversation history (last 10 turns) is passed in from the frontend mapped to Gemini's `user`/`model` roles and is session-only (not persisted).

### User profiles (`/perfil.html`, `GET/PUT /api/profile/:token`)

Users are identified by a random hex `token` stored in `localStorage` as `hp_token`. Profile preferences (`categories`, `min_discount`, `max_discount`, `min_price`, `max_budget`, `notify_email`, `notify_whatsapp`) are stored in the `users` table. The frontend also caches preferences in `localStorage` as `hp_profile` and applies them as default filters on the dashboard.

### Frontend (`public/`)

Pure vanilla JS — no framework, no build step. `app.js` is loaded as a regular script. State is a plain object. All API calls go through `apiFetch()` (wraps `fetch`, throws on `!json.ok`). The dark/light theme is toggled by setting `data-theme=""` on `<html>` and persisted in `localStorage`.

CSS variables (`--bg`, `--orange`, `--green`, `--red`, etc.) defined in `styles.css` are used everywhere. `[data-theme="light"]` overrides the dark defaults.

### Configuration precedence

At runtime, settings are read in this order: `.env` file (loaded by `dotenv`) → `app_config` table in SQLite. The setup wizard and admin panel write to both the DB and re-write `.env`. Calling `resetTransporter()` / `resetClient()` after a config change forces re-initialization of the email/WhatsApp clients.

### Demo mode

When `DEMO_MODE=true`, `runAll()` skips real scraping and calls `seedDemoData()` instead, which inserts 34 fake products with synthetic price history. This is the default for new installs. Set `DEMO_MODE=false` in the admin panel or `.env` to enable real scraping.

## What has been completed

- ✅ 9-store scraper system with SSE-based real-time dashboard
- ✅ Price history tracking with historical-minimum detection
- ✅ Email (Gmail SMTP) and WhatsApp (Twilio) alert notifications with daily digest
- ✅ User registration, per-product alerts, and profile preferences
- ✅ `/perfil.html` — double-range sliders for price/discount, category listbox, notification toggles
- ✅ HuntBot AI chatbot (floating button, session history, product context injection)
- ✅ Admin panel with scraper status, force-scan, config, user management
- ✅ PWA (Service Worker + manifest), dark/light theme, confetti for >80% off

## What needs live testing / may need fixes

- **Sodimac scraper** — returns 0 in practice. The ATG platform renders client-side; the multi-strategy extractor may still fail if the site structure changes. A headless browser (Puppeteer) would be the reliable fix.
- **Coolbox scraper** — untested against live site. If Coolbox uses a standard Shopify storefront, the `extractFromGeneric()` path should work; otherwise the JSON-LD path is the fallback.
- **Samsung scraper** — the internal API endpoint (`/common/ajax/getAllGalleryProductList.do`) is untested; may return 403 or a different structure on the PE locale.
- **MercadoLibre scraper** — verified working (43 products) using the `_n.ctx.r={…}` Nordic pattern. This pattern may break if MercadoLibre updates their SSR framework.
- **HuntBot** — requires a valid `gemini_api_key` set in admin config before the chat button works. Get a free key at aistudio.google.com/apikey.
- **WhatsApp** — Twilio sandbox requires each user to manually opt in by sending a code to the sandbox number before they receive messages.
