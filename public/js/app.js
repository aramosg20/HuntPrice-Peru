'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let pendingAlertProduct = null; // producto activo para el modal de alerta

const state = {
  products: [],
  filters: { store: '', category: '', minDiscount: 0, maxPrice: '', search: '', sort: 'newest' },
  view: localStorage.getItem('hp_view') || 'grid',
  offset: 0,
  limit: 30,
  loading: false,
  userToken: localStorage.getItem('hp_token') || '',
  alertedProducts: new Set(JSON.parse(localStorage.getItem('hp_alerts') || '[]')),
  theme: localStorage.getItem('hp_theme') || 'dark',
  evtSource: null,
  streamSource: null
};

// ─── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTheme();
  applyView(state.view);
  loadStats();
  loadExclusivos();
  loadCategories();
  applyProfileFilters();
  loadProducts(true);
  initSSE();
  initStream();
  initUI();
  updateProfileNavBtn();
});

// ─── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme === 'light' ? 'light' : '');
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = state.theme === 'light' ? '🌙' : '☀️';
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('hp_theme', state.theme);
  applyTheme();
}

// ─── Stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const { data } = await apiFetch('/api/stats');
    document.getElementById('statTotal').textContent = data.total || 0;
    document.getElementById('statActive').textContent = data.active || 0;
    document.getElementById('statTopOffer').textContent = data.topOffer ? Math.round(data.topOffer) + '%' : '-';
    document.getElementById('statUsers').textContent = data.users || 0;
  } catch (_) {}
}

// ─── Top Exclusivos ────────────────────────────────────────────────────────────
async function loadExclusivos() {
  const section = document.getElementById('exclusivosSection');
  if (!section) return;
  try {
    const { data } = await apiFetch('/api/exclusivos');
    if (!data || data.length === 0) { section.style.display = 'none'; return; }
    section.style.display = '';
    document.getElementById('exclusivosCards').innerHTML = data.map(p => buildExclusivoCard(p)).join('');
  } catch (_) { section.style.display = 'none'; }
}

function buildExclusivoCard(p) {
  const discount = Math.round(p.discount_percent);
  const saving = (p.original_price - p.current_price).toFixed(2);
  const imgSrc = p.image_url || getPlaceholderImage(p.category);
  const isNew = p.first_seen_at && (Date.now() - new Date(p.first_seen_at).getTime()) < 24 * 60 * 60 * 1000;
  return `<div class="excl-card" onclick="openProductDetail(${p.id})" title="${escHtml(p.name)}">
    <div class="excl-img-wrap">
      <img src="${imgSrc}" alt="${escHtml(p.name)}" loading="lazy" onerror="this.src='${getPlaceholderImage(p.category)}'">
      <span class="excl-discount">-${discount}%</span>
      ${isNew ? '<span class="new-badge">NUEVO</span>' : ''}
    </div>
    <div class="excl-body">
      <div class="excl-store">${escHtml(p.store)}</div>
      <div class="excl-name">${escHtml(p.name)}</div>
      <div class="excl-prices">
        <span class="excl-current">S/. ${p.current_price.toFixed(2)}</span>
        <span class="excl-original">S/. ${p.original_price.toFixed(2)}</span>
      </div>
      <div class="excl-saving">💰 Ahorras S/. ${saving}</div>
      <a class="excl-btn" href="${escHtml(p.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">
        🛒 Ver oferta
      </a>
    </div>
  </div>`;
}

// ─── Categories ────────────────────────────────────────────────────────────────
async function loadCategories() {
  try {
    const { data } = await apiFetch('/api/categories');
    const container = document.getElementById('categoryFilters');
    if (!container) return;
    container.innerHTML = data.map(cat =>
      `<button class="chip" data-cat="${cat}" onclick="filterCategory('${cat}')">${cat}</button>`
    ).join('');
  } catch (_) {}
}

function filterCategory(cat) {
  state.filters.category = state.filters.category === cat ? '' : cat;
  document.querySelectorAll('[data-cat]').forEach(el => {
    if (el.dataset.cat === state.filters.category) el.classList.add('active');
    else el.classList.remove('active');
  });
  reloadProducts();
}

// ─── Store Filter ──────────────────────────────────────────────────────────────
function filterStore(store) {
  state.filters.store = state.filters.store === store ? '' : store;
  document.querySelectorAll('[data-store]').forEach(el => {
    if (el.dataset.store === state.filters.store) el.classList.add('active');
    else el.classList.remove('active');
  });
  reloadProducts();
}

// ─── Discount Slider ───────────────────────────────────────────────────────────
function updateDiscount(val) {
  state.filters.minDiscount = parseInt(val);
  const el = document.getElementById('discountValue');
  if (el) el.textContent = val + '%';
  reloadProducts();
}

// ─── Max Price ─────────────────────────────────────────────────────────────────
function updateMaxPrice(val) {
  state.filters.maxPrice = val;
  reloadProducts();
}

// ─── Search ────────────────────────────────────────────────────────────────────
let searchTimer;
function handleSearch(val) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filters.search = val.trim();
    reloadProducts();
  }, 400);
}

// ─── Sort ──────────────────────────────────────────────────────────────────────
function updateSort(val) {
  state.filters.sort = val;
  reloadProducts();
}

function resetFilters() {
  state.filters = { store: '', category: '', minDiscount: 0, maxPrice: '', search: '', sort: 'newest' };
  document.querySelectorAll('.chip.active').forEach(el => el.classList.remove('active'));
  const searchEl = document.getElementById('searchInput');
  if (searchEl) searchEl.value = '';
  const sortEl = document.getElementById('sortSelect');
  if (sortEl) sortEl.value = 'newest';
  const slider = document.getElementById('discountSlider');
  if (slider) { slider.value = 0; const dv = document.getElementById('discountValue'); if (dv) dv.textContent = '0%'; }
  const maxPrice = document.getElementById('maxPriceInput');
  if (maxPrice) maxPrice.value = '';
  return reloadProducts();
}

// ─── Products ─────────────────────────────────────────────────────────────────
function reloadProducts() {
  state.offset = 0;
  state.products = [];
  return loadProducts(true);
}

async function loadProducts(reset = false) {
  if (state.loading) return;
  state.loading = true;

  const grid = document.getElementById('productsGrid');
  if (reset && grid) {
    grid.innerHTML = buildSkeletons(8);
  }

  try {
    const params = new URLSearchParams({
      sort: state.filters.sort,
      limit: state.limit,
      offset: state.offset
    });
    if (state.filters.store) params.set('store', state.filters.store);
    if (state.filters.category) params.set('category', state.filters.category);
    if (state.filters.minDiscount) params.set('minDiscount', state.filters.minDiscount);
    if (state.filters.maxPrice) params.set('maxPrice', state.filters.maxPrice);
    if (state.filters.search) params.set('q', state.filters.search);

    const { data, count } = await apiFetch('/api/products?' + params.toString());

    if (reset) {
      state.products = data;
      if (grid) grid.innerHTML = '';
    } else {
      state.products = [...state.products, ...data];
    }

    state.offset += data.length;
    renderProducts(data, reset);

    const countEl = document.getElementById('resultsCount');
    if (countEl) countEl.textContent = `${state.products.length} ofertas`;

    const loadMoreBtn = document.getElementById('loadMoreBtn');
    if (loadMoreBtn) loadMoreBtn.style.display = count >= state.limit ? 'inline-block' : 'none';
  } catch (e) {
    if (grid && reset) grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">⚠️</div>
      <h3>Error al cargar</h3><p>${e.message}</p>
    </div>`;
  } finally {
    state.loading = false;
  }
}

function renderProducts(products, replace = false) {
  const grid = document.getElementById('productsGrid');
  if (!grid) return;

  if (products.length === 0 && replace) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">🔍</div>
      <h3>No hay ofertas</h3>
      <p>Intenta ajustar los filtros o espera el próximo escaneo</p>
    </div>`;
    return;
  }

  const html = products.map(buildProductCard).join('');
  if (replace) {
    grid.innerHTML = html;
  } else {
    grid.insertAdjacentHTML('beforeend', html);
  }
}

function buildProductCard(p) {
  const discount = Math.round(p.discount_percent);
  const isMega = discount >= 70;
  const isNew = p.first_seen_at && (Date.now() - new Date(p.first_seen_at).getTime()) < 24 * 60 * 60 * 1000;
  const isJustDetected = (Date.now() - new Date(p.detected_at).getTime()) < 10 * 60 * 1000;
  const isAlerted = state.alertedProducts.has(p.id);
  const saving = (p.original_price - p.current_price).toFixed(2);

  const minutesAgo = Math.round((Date.now() - new Date(p.detected_at).getTime()) / 60000);
  const timeStr = minutesAgo < 1 ? 'justo ahora' :
                  minutesAgo < 60 ? `hace ${minutesAgo}m` :
                  `hace ${Math.round(minutesAgo/60)}h`;

  const imgSrc = p.image_url || getPlaceholderImage(p.category);
  const skuText = p.sku ? `<span class="card-sku" title="SKU">${escHtml(p.sku)}</span>` : '';

  return `<div class="product-card${isJustDetected ? ' new-offer' : ''}" onclick="openProductDetail(${p.id})" data-id="${p.id}">
    <div class="card-image-wrapper">
      <img src="${imgSrc}" alt="${escHtml(p.name)}" loading="lazy" onerror="this.src='${getPlaceholderImage(p.category)}'">
      <span class="discount-badge ${isMega ? 'mega' : ''}">-${discount}%</span>
      <span class="store-badge">${escHtml(p.store)}</span>
      ${p.is_historical_min ? '<span class="historical-badge">🏆 MÍN. HISTÓRICO</span>' : ''}
      ${isNew ? '<span class="new-badge">NUEVO</span>' : ''}
    </div>
    <div class="card-body">
      <div class="card-category">${escHtml(p.category || 'General')}${skuText}</div>
      <div class="card-name">${escHtml(p.name)}</div>
      <div class="card-prices">
        <div class="original-price">Antes: S/. ${p.original_price.toFixed(2)}</div>
        <div class="current-price"><span class="currency">S/. </span>${p.current_price.toFixed(2)}</div>
      </div>
      <div class="card-meta">
        <span title="Score de urgencia">🔥 ${p.urgency_score}/10</span>
        <span title="Detectado">${timeStr}</span>
        <span title="Ahorro">💰 S/.${saving}</span>
      </div>
      <div class="card-actions" onclick="event.stopPropagation()">
        <a class="btn-buy" href="${escHtml(p.url)}" target="_blank" rel="noopener">🛒 VER OFERTA</a>
        <button class="btn-alert ${isAlerted ? 'active' : ''}" onclick="toggleAlert(${p.id}, event)" title="Alertarme">
          ${isAlerted ? '🔔' : '🔕'}
        </button>
      </div>
    </div>
  </div>`;
}

function buildSkeletons(n) {
  return Array.from({ length: n }, () => `
    <div class="skeleton-card">
      <div class="skeleton skeleton-img"></div>
      <div style="padding:14px">
        <div class="skeleton skeleton-line short" style="margin:0 0 8px"></div>
        <div class="skeleton skeleton-line" style="margin:0 0 6px"></div>
        <div class="skeleton skeleton-line short" style="margin:0 0 16px"></div>
        <div class="skeleton skeleton-line" style="height:36px;border-radius:8px"></div>
      </div>
    </div>`).join('');
}

function getPlaceholderImage(category) {
  const imgs = {
    'Electrónica': 'https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=400',
    'Computación': 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=400',
    'Celulares': 'https://images.unsplash.com/photo-1598327105666-5b89351aff97?w=400',
    'Electrohogar': 'https://images.unsplash.com/photo-1584568694244-14fbdf83bd30?w=400',
    'Calzado': 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400',
    'Moda': 'https://images.unsplash.com/photo-1445205170230-053b83016050?w=400',
    'Muebles': 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400',
    'Herramientas': 'https://images.unsplash.com/photo-1586864387789-628af9feed72?w=400',
    'Belleza': 'https://images.unsplash.com/photo-1512496015851-a90fb38ba796?w=400',
    'Deportes': 'https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=400',
    'Juguetes': 'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=400',
  };
  return imgs[category] || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400';
}

// ─── Product Detail Modal ──────────────────────────────────────────────────────
async function openProductDetail(id) {
  const modal = document.getElementById('productModal');
  if (!modal) return;

  openModal('productModal');
  document.getElementById('productModalBody').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text2)">Cargando...</div>';

  try {
    const { data } = await apiFetch(`/api/products/${id}`);
    const latest = data.prices[data.prices.length - 1] || {};
    const discount = Math.round(latest.discount_percent || 0);

    document.getElementById('productModalBody').innerHTML = `
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <img src="${data.image_url || getPlaceholderImage(data.category)}" style="width:140px;height:140px;object-fit:contain;border-radius:12px;background:var(--bg3)" onerror="this.style.display='none'">
        <div style="flex:1;min-width:200px">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">${escHtml(data.store)} • ${escHtml(data.category)}</div>
          <h3 style="font-size:16px;font-weight:700;margin-bottom:12px">${escHtml(data.name)}</h3>
          <div style="font-size:13px;color:var(--text3);text-decoration:line-through">S/. ${(latest.original_price||0).toFixed(2)}</div>
          <div style="font-size:28px;font-weight:900;color:var(--green-bright)">S/. ${(latest.current_price||0).toFixed(2)}</div>
          <div style="display:inline-block;background:var(--red);color:#fff;padding:3px 10px;border-radius:20px;font-weight:800;font-size:13px;margin-top:6px">-${discount}%</div>
          ${latest.is_historical_min ? '<div style="font-size:12px;color:var(--yellow);margin-top:8px">🏆 ¡Precio mínimo histórico!</div>' : ''}
        </div>
      </div>
      ${buildPriceChart(data.prices)}
      <div style="margin-top:20px;display:flex;gap:10px">
        <a href="${escHtml(data.url)}" target="_blank" class="btn-buy" style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:12px">🛒 IR A COMPRAR</a>
        <button class="btn-alert" onclick="openProductAlertModal(${data.id},${escHtml(JSON.stringify(data.name))},${latest.current_price||0})" style="width:auto;padding:0 16px;white-space:nowrap">🔔 ALERTARME</button>
      </div>
      <div style="margin-top:16px">
        <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:8px">HISTORIAL DE PRECIOS</div>
        <div style="overflow-x:auto">
          <table style="width:100%;font-size:12px">
            <thead><tr><th>Fecha</th><th>Precio</th><th>Descuento</th></tr></thead>
            <tbody>${data.prices.slice(-8).reverse().map(pr => `
              <tr>
                <td>${new Date(pr.detected_at).toLocaleString('es-PE', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
                <td style="color:var(--green-bright)">S/. ${pr.current_price.toFixed(2)}</td>
                <td><span style="background:var(--red);color:#fff;padding:2px 6px;border-radius:10px;font-size:10px">-${Math.round(pr.discount_percent)}%</span></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  } catch (e) {
    document.getElementById('productModalBody').innerHTML = `<p style="color:var(--red)">Error: ${e.message}</p>`;
  }
}

function buildPriceChart(prices) {
  if (prices.length < 2) return '';
  const vals = prices.map(p => p.current_price);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const w = 100 / (vals.length - 1);
  const points = vals.map((v, i) => `${i * w},${100 - ((v - min) / range) * 80}`).join(' ');
  return `<div style="margin-top:16px">
    <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:8px">GRÁFICO DE PRECIO</div>
    <div style="background:var(--bg3);border-radius:8px;padding:12px">
      <svg viewBox="0 0 100 100" style="width:100%;height:80px">
        <polyline points="${points}" fill="none" stroke="var(--orange)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        ${vals.map((v, i) => `<circle cx="${i * w}" cy="${100 - ((v - min) / range) * 80}" r="2" fill="var(--orange)"/>`).join('')}
      </svg>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3)">
        <span>S/. ${min.toFixed(0)}</span><span>S/. ${max.toFixed(0)}</span>
      </div>
    </div>
  </div>`;
}

// ─── Alert Toggle ──────────────────────────────────────────────────────────────
function toggleAlert(productId, event) {
  if (event) event.stopPropagation();

  if (!state.userToken) {
    openModal('alertModal');
    localStorage.setItem('hp_pending_alert', productId);
    return;
  }

  if (state.alertedProducts.has(productId)) {
    state.alertedProducts.delete(productId);
    showToast('🔕', 'Alerta eliminada', 'Ya no recibirás notificaciones de este producto');
  } else {
    state.alertedProducts.add(productId);
    apiFetch('/api/alerts', {
      method: 'POST',
      body: { user_token: state.userToken, product_id: productId, alert_type: 'product' }
    }).catch(() => {});
    showToast('🔔', '¡Alerta creada!', 'Te notificaremos si el precio baja más');
  }

  localStorage.setItem('hp_alerts', JSON.stringify([...state.alertedProducts]));

  // Update button in DOM
  document.querySelectorAll(`[data-id="${productId}"] .btn-alert`).forEach(btn => {
    const active = state.alertedProducts.has(productId);
    btn.classList.toggle('active', active);
    btn.textContent = active ? '🔔' : '🔕';
  });
}

// ─── Register User ─────────────────────────────────────────────────────────────
async function registerUser(event) {
  event.preventDefault();
  const btn = event.target.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Registrando...';

  const form = new FormData(event.target);
  const categories = [...document.querySelectorAll('#catCheckboxes input:checked')].map(el => el.value);
  const stores = [...document.querySelectorAll('#storeCheckboxes input:checked')].map(el => el.value);

  try {
    const { data, message } = await apiFetch('/api/users', {
      method: 'POST',
      body: {
        name: form.get('name'),
        email: form.get('email'),
        whatsapp: form.get('whatsapp'),
        min_discount: parseInt(form.get('min_discount') || '30'),
        categories,
        stores
      }
    });
    state.userToken = data.token;
    localStorage.setItem('hp_token', data.token);
    // Cache name so the navbar avatar shows the initial immediately
    const existingProfile = JSON.parse(localStorage.getItem('hp_profile') || 'null');
    localStorage.setItem('hp_profile', JSON.stringify({ ...(existingProfile || {}), name: form.get('name') }));
    updateProfileNavBtn();

    // If there was a pending alert
    const pendingAlert = localStorage.getItem('hp_pending_alert');
    if (pendingAlert) {
      await apiFetch('/api/alerts', {
        method: 'POST',
        body: { user_token: data.token, product_id: parseInt(pendingAlert), alert_type: 'product' }
      });
      state.alertedProducts.add(parseInt(pendingAlert));
      localStorage.removeItem('hp_pending_alert');
    }

    closeModal('alertModal');
    showToast('🎉', '¡Registro exitoso!', message || 'Recibirás alertas de ofertas');
  } catch (e) {
    showToast('❌', 'Error', e.message, 'error');
    btn.disabled = false;
    btn.textContent = '¡Suscribirme!';
  }
}

// ─── SSE Real-time ─────────────────────────────────────────────────────────────
function initSSE() {
  if (state.evtSource) state.evtSource.close();

  const es = new EventSource('/api/events');
  state.evtSource = es;

  es.addEventListener('new_offers', (e) => {
    const { count, store, demo } = JSON.parse(e.data);
    loadStats();
    if (!demo) {
      showToast('🔥', `${count} nueva${count > 1 ? 's' : ''} oferta${count > 1 ? 's' : ''}`, `En ${store}`, 'success');
    }
    reloadProducts();
  });

  es.addEventListener('scan_done', () => loadStats());

  es.addEventListener('scraper_status', (e) => {
    const { store, status } = JSON.parse(e.data);
    if (status === 'error') {
      // Only show error toasts in admin context
    }
  });

  es.onerror = () => {
    setTimeout(initSSE, 5000);
  };
}

// ─── SSE Stream (/api/stream — plain onmessage, triggers full product refresh) ──
function initStream() {
  if (state.streamSource) state.streamSource.close();

  const src = new EventSource('/api/stream');
  state.streamSource = src;

  src.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'PRODUCTS_UPDATED') {
        reloadProducts();
        loadStats();
        loadExclusivos();
      }
    } catch (_) {}
  };

  src.onerror = () => {
    src.close();
    state.streamSource = null;
    setTimeout(initStream, 5000);
  };
}

// ─── Confetti ──────────────────────────────────────────────────────────────────
function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  canvas.style.display = 'block';
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const pieces = Array.from({ length: 120 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height - canvas.height,
    r: 4 + Math.random() * 6,
    d: 2 + Math.random() * 3,
    color: ['#FF6600','#00CC66','#FFB800','#FF3333','#00AAFF'][Math.floor(Math.random() * 5)],
    tilt: Math.random() * 10 - 5,
    tiltAngle: 0,
    tiltAngleIncrement: Math.random() * 0.07 + 0.05
  }));

  let frame;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach(p => {
      p.tiltAngle += p.tiltAngleIncrement;
      p.y += p.d;
      p.tilt = Math.sin(p.tiltAngle) * 12;
      ctx.beginPath();
      ctx.fillStyle = p.color;
      ctx.ellipse(p.x + p.tilt, p.y, p.r, p.r * 0.4, p.tilt, 0, Math.PI * 2);
      ctx.fill();
    });
    if (pieces.some(p => p.y < canvas.height)) {
      frame = requestAnimationFrame(draw);
    } else {
      canvas.style.display = 'none';
    }
  }
  draw();
  setTimeout(() => { cancelAnimationFrame(frame); canvas.style.display = 'none'; }, 4000);
}

// ─── Modals ────────────────────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
  document.body.style.overflow = '';
}

// ─── Toast ─────────────────────────────────────────────────────────────────────
function showToast(icon, title, body, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const id = 'toast_' + Date.now();
  const colors = { info: 'var(--orange)', success: 'var(--green)', error: 'var(--red)' };

  container.insertAdjacentHTML('beforeend', `
    <div id="${id}" class="toast" style="border-left-color:${colors[type]||colors.info}">
      <span class="toast-icon">${icon}</span>
      <div class="toast-content">
        <div class="toast-title">${escHtml(title)}</div>
        <div class="toast-body">${escHtml(body)}</div>
      </div>
      <button class="toast-close" onclick="dismissToast('${id}')">✕</button>
    </div>`);

  // Check if it's a >80% offer — launch confetti!
  if (icon === '🔥' && body && body.includes('80')) launchConfetti();

  setTimeout(() => dismissToast(id), 6000);
}

function dismissToast(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('exit');
  setTimeout(() => el.remove(), 300);
}

// ─── Misc UI ───────────────────────────────────────────────────────────────────
function initUI() {
  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Discount slider label
  const slider = document.getElementById('discountSlider');
  if (slider) slider.addEventListener('input', e => updateDiscount(e.target.value));

  // Max price input with debounce
  const maxPrice = document.getElementById('maxPriceInput');
  if (maxPrice) {
    let t;
    maxPrice.addEventListener('input', e => {
      clearTimeout(t);
      t = setTimeout(() => updateMaxPrice(e.target.value), 500);
    });
  }
}

// ─── Utils ─────────────────────────────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Error del servidor');
  return json;
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Alerta de producto específico ────────────────────────────────────────────

function openProductAlertModal(productId, productName, currentPrice) {
  pendingAlertProduct = { id: productId, name: productName, price: currentPrice };

  const infoEl = document.getElementById('alertProductInfo');
  if (infoEl) {
    infoEl.innerHTML = `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:18px">
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Producto seleccionado</div>
        <div style="font-size:14px;font-weight:600;line-height:1.4;margin-bottom:6px">${escHtml(productName)}</div>
        <div style="font-size:20px;font-weight:900;color:var(--green-bright)">S/. ${Number(currentPrice).toFixed(2)}
          <span style="font-size:12px;font-weight:400;color:var(--text3)"> precio actual</span>
        </div>
      </div>`;
  }

  // Sugerir 10% menos que el precio actual
  const suggested = (Number(currentPrice) * 0.9).toFixed(2);
  const priceInput = document.getElementById('alertTargetPrice');
  if (priceInput) priceInput.value = suggested;
  const hint = document.getElementById('alertPriceHint');
  if (hint) hint.textContent = `Sugerido: S/. ${suggested} (10% bajo el precio actual)`;

  // Resetear el form
  const form = document.getElementById('productAlertForm');
  if (form) { const emailInput = form.querySelector('[name=email]'); if (emailInput) emailInput.value = ''; }
  const btn = document.getElementById('productAlertSubmitBtn');
  if (btn) { btn.disabled = false; btn.textContent = '🔔 Crear alerta'; }

  // Cerrar detalle si está abierto y abrir este
  closeModal('productModal');
  openModal('productAlertModal');
}

async function submitProductAlert(event) {
  event.preventDefault();
  const btn = document.getElementById('productAlertSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Creando alerta...';

  const form = new FormData(event.target);
  const targetVal = form.get('target_price');

  try {
    const { message } = await apiFetch('/api/alerts/subscribe', {
      method: 'POST',
      body: {
        email: form.get('email'),
        product_id: pendingAlertProduct.id,
        target_price: targetVal ? parseFloat(targetVal) : null
      }
    });

    // Marcar como alertado localmente
    if (pendingAlertProduct) {
      state.alertedProducts.add(pendingAlertProduct.id);
      localStorage.setItem('hp_alerts', JSON.stringify([...state.alertedProducts]));
      document.querySelectorAll(`[data-id="${pendingAlertProduct.id}"] .btn-alert`).forEach(b => {
        b.classList.add('active');
        b.textContent = '🔔';
      });
    }

    closeModal('productAlertModal');
    showToast('🔔', '¡Alerta creada!', message, 'success');
    event.target.reset();
    pendingAlertProduct = null;
  } catch (e) {
    showToast('❌', 'Error al crear alerta', e.message, 'error');
    btn.disabled = false;
    btn.textContent = '🔔 Crear alerta';
  }
}

// ─── Profile auto-filter ───────────────────────────────────────────────────────
function applyProfileFilters() {
  const profile = JSON.parse(localStorage.getItem('hp_profile') || 'null');
  if (!profile) return;
  const fromProfile = new URLSearchParams(window.location.search).get('fromProfile');
  if (!fromProfile && !localStorage.getItem('hp_profile_auto')) return;

  if (profile.min_discount > 0) {
    state.filters.minDiscount = profile.min_discount;
    const slider = document.getElementById('discountSlider');
    if (slider) { slider.value = profile.min_discount; }
    const el = document.getElementById('discountValue');
    if (el) el.textContent = profile.min_discount + '%';
  }
  if (profile.max_budget > 0) {
    state.filters.maxPrice = profile.max_budget;
    const inp = document.getElementById('maxPriceInput');
    if (inp) inp.value = profile.max_budget;
  }
  localStorage.setItem('hp_profile_auto', '1');
}

// ─── HuntBot Chatbot ───────────────────────────────────────────────────────────
let chatHistory = [];
let chatOpen = false;
let chatLastProduct = null; // last product mentioned, used for notifications

function toggleChat() {
  chatOpen = !chatOpen;
  const panel = document.getElementById('chatPanel');
  if (panel) panel.classList.toggle('open', chatOpen);
  const badge = document.getElementById('chatBadge');
  if (badge) badge.style.display = 'none';
  if (chatOpen) {
    setTimeout(() => {
      const input = document.getElementById('chatInput');
      if (input) input.focus();
    }, 300);
  }
}

function sendChatSuggestion(text) {
  const input = document.getElementById('chatInput');
  if (input) input.value = text;
  sendChat();
}

async function sendChat() {
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSendBtn');
  const messages = document.getElementById('chatMessages');
  const suggestions = document.getElementById('chatSuggestions');
  if (!input || !messages) return;

  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  if (sendBtn) sendBtn.disabled = true;
  if (suggestions) suggestions.style.display = 'none';

  messages.insertAdjacentHTML('beforeend', `<div class="chat-msg user">${escHtml(message)}</div>`);
  scrollChatToBottom();

  const typingId = 'typing_' + Date.now();
  messages.insertAdjacentHTML('beforeend', `
    <div class="chat-msg typing" id="${typingId}">
      <div class="typing-dots"><span></span><span></span><span></span></div>
    </div>`);
  scrollChatToBottom();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        history: chatHistory.slice(-10),
        token: localStorage.getItem('hp_token') || ''
      })
    });
    const json = await res.json();
    document.getElementById(typingId)?.remove();

    if (!json.ok) {
      messages.insertAdjacentHTML('beforeend', `
        <div class="chat-msg bot" style="border-color:var(--red);color:var(--red)">
          ⚠️ ${escHtml(json.error || 'Error al procesar mensaje')}
        </div>`);
    } else {
      chatHistory.push({ role: 'user', content: message });
      chatHistory.push({ role: 'assistant', content: json.reply });
      if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);

      // Render bot reply with bold formatting (**text** → <strong>)
      const formattedReply = escHtml(json.reply)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
      messages.insertAdjacentHTML('beforeend', `
        <div class="chat-msg bot">${formattedReply}</div>`);

      // Render product cards and track last mentioned product
      if (json.cards?.length) {
        chatLastProduct = json.cards[0]; // most prominent product for notifications
        for (const card of json.cards) {
          messages.insertAdjacentHTML('beforeend', renderChatProductCard(card));
        }
      }

      // Execute dashboard action — await so we can report results back in chat
      if (json.dashboardAction) {
        const actionMsg = await executeDashboardAction(json.dashboardAction);
        if (actionMsg) {
          messages.insertAdjacentHTML('beforeend',
            `<div class="chat-msg bot" style="font-size:12px;color:var(--text2);padding:8px 14px">${actionMsg}</div>`);
        }
      }

      // Auto-apply keyword filter from chat context
      if (json.filterAction) {
        const actionMsg = await executeFilterAction(json.filterAction);
        if (actionMsg) {
          messages.insertAdjacentHTML('beforeend',
            `<div class="chat-msg bot" style="font-size:12px;color:var(--text2);padding:8px 14px">${escHtml(actionMsg)}</div>`);
        }
      }

      // Handle notification action
      if (json.action?.type === 'notify') {
        handleChatNotify(json.action, messages);
      }
    }
  } catch (e) {
    document.getElementById(typingId)?.remove();
    messages.insertAdjacentHTML('beforeend', `
      <div class="chat-msg bot" style="border-color:var(--red);color:var(--red)">
        ⚠️ Error de conexión. Inténtalo nuevamente.
      </div>`);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    scrollChatToBottom();
    input.focus();
  }
}

function renderChatProductCard(p) {
  const discount = Math.round(p.discount_percent);
  const imgSrc = p.image_url || '';
  const placeholderSvg = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Crect width='72' height='72' fill='%23333'/%3E%3Ctext x='36' y='42' font-size='28' text-anchor='middle' fill='%23666'%3E📦%3C/text%3E%3C/svg%3E`;
  const safeName = escHtml((p.name || '').substring(0, 80));
  const safeStore = escHtml(p.store || '');
  const safeUrl = escHtml(p.url || '#');
  const productId = p.id || 0;
  const currentPrice = Number(p.current_price).toFixed(2);
  const origPrice = Number(p.original_price).toFixed(2);

  return `<div class="chat-product-card">
    <img class="cpc-img" src="${imgSrc || placeholderSvg}" alt="${safeName}"
      onerror="this.src='${placeholderSvg}'">
    <div class="cpc-body">
      <div class="cpc-store">${safeStore}</div>
      <div class="cpc-name">${safeName}</div>
      <div class="cpc-prices">
        <span class="cpc-orig">S/. ${origPrice}</span>
        <span class="cpc-curr">S/. ${currentPrice}</span>
      </div>
      <span class="cpc-badge">-${discount}%</span>
      <div class="cpc-actions">
        <a class="cpc-btn-buy" href="${safeUrl}" target="_blank" rel="noopener">🛒 Ver oferta</a>
        <button class="cpc-btn-alert" onclick="openProductAlertModal(${productId},'${safeName.replace(/'/g, "\\'")}',${currentPrice})">🔔 Alertarme</button>
      </div>
    </div>
  </div>`;
}

async function executeDashboardAction(action) {
  if (action.type === 'filter_store') {
    state.filters = { store: action.value, category: '', minDiscount: 0, maxPrice: '', search: '', sort: 'newest' };
    document.querySelectorAll('.chip.active').forEach(el => el.classList.remove('active'));
    document.querySelectorAll(`[data-store="${action.value}"]`).forEach(el => el.classList.add('active'));
    const searchEl = document.getElementById('searchInput'); if (searchEl) searchEl.value = '';
    await reloadProducts();
    const count = document.querySelectorAll('.product-card').length;
    showToast('🔍', 'Filtro aplicado', `${count} oferta${count !== 1 ? 's' : ''} de ${action.value}`);
    scrollToFirstProduct();
    return `🔍 Encontré ${count} oferta${count !== 1 ? 's' : ''} de ${action.value} en el dashboard.`;

  } else if (action.type === 'filter_category') {
    state.filters = { store: '', category: action.value, minDiscount: 0, maxPrice: '', search: '', sort: 'newest' };
    document.querySelectorAll('.chip.active').forEach(el => el.classList.remove('active'));
    document.querySelectorAll(`[data-cat="${action.value}"]`).forEach(el => el.classList.add('active'));
    const searchEl = document.getElementById('searchInput'); if (searchEl) searchEl.value = '';
    await reloadProducts();
    const count = document.querySelectorAll('.product-card').length;
    showToast('🔍', 'Filtro aplicado', `${count} resultado${count !== 1 ? 's' : ''} en ${action.value}`);
    scrollToFirstProduct();
    return `🔍 Encontré ${count} resultado${count !== 1 ? 's' : ''} en ${action.value} en el dashboard.`;

  } else if (action.type === 'show_product') {
    state.filters = { store: '', category: '', minDiscount: 0, maxPrice: '', search: '', sort: 'newest' };
    document.querySelectorAll('.chip.active').forEach(el => el.classList.remove('active'));
    const searchTerm = (action.productName || '').split(' ').slice(0, 4).join(' ');
    state.filters.search = searchTerm;
    const searchEl = document.getElementById('searchInput');
    if (searchEl) searchEl.value = searchTerm;
    await reloadProducts();
    const count = document.querySelectorAll('.product-card').length;
    showToast('🔍', 'Buscando en dashboard', `${count} resultado${count !== 1 ? 's' : ''}`);
    setTimeout(() => highlightDashboardProduct(action.productId), 300);
    const linkPart = action.productUrl ? ` — <a href="${escHtml(action.productUrl)}" target="_blank" rel="noopener" style="color:var(--orange)">Ver en tienda ↗</a>` : '';
    return `🔍 Encontré ${count} resultado${count !== 1 ? 's' : ''} en el dashboard${linkPart}`;
  }
  return null;
}

async function executeFilterAction(fa) {
  if (!fa || !fa.query) return null;
  // Clear active chips and set the search filter directly
  state.filters = { store: '', category: '', minDiscount: 0, maxPrice: '', search: fa.query, sort: 'newest' };
  document.querySelectorAll('.chip.active').forEach(el => el.classList.remove('active'));

  // Write to the search input and dispatch input event so it visually activates
  const searchEl = document.getElementById('searchInput');
  if (searchEl) {
    searchEl.value = fa.query;
    // Clear the debounce timer so our direct reloadProducts() call wins
    clearTimeout(searchTimer);
  }

  await reloadProducts();
  const count = document.querySelectorAll('.product-card').length;

  // Scroll dashboard into view (the products grid, not just first card)
  const grid = document.getElementById('productsGrid');
  if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (count > 0) {
    showToast('🔍', 'Resultados en dashboard', `${count} producto${count !== 1 ? 's' : ''} encontrados`);
    return `🔍 Mostrando ${count} resultado${count !== 1 ? 's' : ''} en el dashboard ↑`;
  }
  return `🔍 No encontré productos con "${fa.query}" en este momento.`;
}

function highlightDashboardProduct(productId) {
  if (!productId) return;
  const card = document.querySelector(`.product-card[data-id="${productId}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('highlighted');
    setTimeout(() => card.classList.remove('highlighted'), 5000);
  }
}

function scrollToFirstProduct() {
  const first = document.querySelector('.product-card');
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function handleChatNotify(action, messages) {
  const { channel, registered, hasEmail, hasWhatsapp, maskedEmail, maskedWhatsapp } = action;
  const notifId = 'notif_' + Date.now();
  const hasContact = channel === 'email' ? hasEmail : hasWhatsapp;
  const masked = channel === 'email' ? maskedEmail : maskedWhatsapp;

  if (registered && hasContact && masked) {
    // User is registered and has this contact — show confirmation with product name
    const productLine = chatLastProduct
      ? `<div style="margin-bottom:6px;font-size:11px;color:var(--text3);line-height:1.4">Producto: <strong style="color:var(--text1)">${escHtml((chatLastProduct.name || '').substring(0, 60))}</strong></div>`
      : '';
    messages.insertAdjacentHTML('beforeend', `
      <div class="chat-msg bot" id="${notifId}" style="padding:12px">
        ${productLine}
        <div style="margin-bottom:10px;font-size:13px">
          ¿Envío los detalles a <strong>${escHtml(masked)}</strong>?
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="confirmChatNotify('${channel}','yes','${notifId}')"
            style="flex:1;padding:6px 0;border-radius:8px;background:var(--orange);color:#fff;border:none;cursor:pointer;font-size:13px;font-weight:600">
            ✅ Sí, enviar
          </button>
          <button onclick="confirmChatNotify('${channel}','no','${notifId}')"
            style="flex:1;padding:6px 0;border-radius:8px;background:var(--bg3);color:var(--text1);border:1px solid var(--border);cursor:pointer;font-size:13px">
            📝 Otro dato
          </button>
        </div>
      </div>`);
    scrollChatToBottom();
    return;
  }

  if (registered && !hasContact) {
    // Registered but no contact configured
    const label = channel === 'email' ? 'correo electrónico' : 'número de WhatsApp';
    messages.insertAdjacentHTML('beforeend', `
      <div class="chat-msg bot" id="${notifId}" style="padding:12px;font-size:13px">
        <div style="margin-bottom:8px">Tu cuenta no tiene un ${label} configurado. ¿Deseas agregarlo?</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a href="/perfil.html" style="padding:6px 12px;border-radius:8px;background:var(--orange);color:#fff;font-size:12px;text-decoration:none;font-weight:600">
            Ir a mi perfil →
          </a>
          <button onclick="showChatContactForm('${channel}','${notifId}')"
            style="padding:6px 12px;border-radius:8px;background:var(--bg3);color:var(--text1);border:1px solid var(--border);cursor:pointer;font-size:12px">
            Ingresar ahora
          </button>
        </div>
      </div>`);
    scrollChatToBottom();
    return;
  }

  // Not registered — ask once, offer registration afterwards
  showChatContactForm(channel, notifId, messages, true);
}

async function confirmChatNotify(channel, answer, notifId) {
  const container = document.getElementById(notifId);
  if (answer === 'no') {
    if (container) {
      container.innerHTML = '';
      showChatContactForm(channel, notifId, null, false);
    }
    return;
  }
  if (container) container.innerHTML = '<div style="font-size:13px">⏳ Enviando...</div>';
  try {
    const res = await fetch('/api/chat/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel,
        token: localStorage.getItem('hp_token') || '',
        product_id: chatLastProduct?.id || null
      })
    });
    const json = await res.json();
    if (container) {
      container.innerHTML = json.ok
        ? `<span style="color:var(--green)">✅ ${escHtml(json.message)}</span>`
        : `<span style="color:var(--red)">⚠️ ${escHtml(json.error || 'Error al enviar')}</span>`;
    }
  } catch (e) {
    if (container) container.innerHTML = '<span style="color:var(--red)">⚠️ Error de conexión</span>';
  }
  scrollChatToBottom();
}

function showChatContactForm(channel, notifId, messages, offerRegister = false) {
  const label = channel === 'email' ? 'correo electrónico' : 'número de WhatsApp';
  const placeholder = channel === 'email' ? 'ejemplo@correo.com' : '+51 999 999 999';
  const inputType = channel === 'email' ? 'email' : 'tel';
  const registerNote = offerRegister
    ? `<div style="margin-top:8px;font-size:11px;color:var(--text3)">
        💡 <a href="/perfil.html" style="color:var(--orange)">Regístrate</a> para no tener que ingresarlo cada vez.
       </div>`
    : '';
  const html = `
    <div class="chat-msg bot" id="${notifId}" style="padding:12px">
      <div style="margin-bottom:8px;font-size:13px">Ingresa tu ${label}:</div>
      <div style="display:flex;gap:6px">
        <input type="${inputType}" id="notifContact_${notifId}" placeholder="${placeholder}"
          style="flex:1;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);color:var(--text1);font-size:13px"
          onkeydown="if(event.key==='Enter')submitChatNotify('${channel}','${notifId}')">
        <button onclick="submitChatNotify('${channel}','${notifId}')"
          style="padding:6px 12px;border-radius:8px;background:var(--orange);color:#fff;border:none;cursor:pointer;font-size:13px;font-weight:600">
          Enviar
        </button>
      </div>
      ${registerNote}
    </div>`;
  if (messages) {
    messages.insertAdjacentHTML('beforeend', html);
    scrollChatToBottom();
    setTimeout(() => document.getElementById(`notifContact_${notifId}`)?.focus(), 50);
  } else {
    const container = document.getElementById(notifId);
    if (container) {
      container.outerHTML = html;
      setTimeout(() => document.getElementById(`notifContact_${notifId}`)?.focus(), 50);
    }
  }
}

async function submitChatNotify(channel, notifId) {
  const input = document.getElementById(`notifContact_${notifId}`);
  const contact = input?.value?.trim();
  if (!contact) { input?.focus(); return; }

  const container = document.getElementById(notifId);
  if (container) container.innerHTML = '<div style="font-size:13px">⏳ Enviando...</div>';

  try {
    const res = await fetch('/api/chat/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, contact, token: localStorage.getItem('hp_token') || '', product_id: chatLastProduct?.id || null })
    });
    const json = await res.json();
    if (container) {
      container.innerHTML = json.ok
        ? `<div style="font-size:13px;color:var(--green)">✅ ${escHtml(json.message)}</div>`
        : `<div style="font-size:13px;color:var(--red)">⚠️ ${escHtml(json.error || json.message || 'Error al enviar')}</div>`;
    }
  } catch (e) {
    if (container) container.innerHTML = '<div style="font-size:13px;color:var(--red)">⚠️ Error de conexión</div>';
  }
  scrollChatToBottom();
}

function scrollChatToBottom() {
  const el = document.getElementById('chatMessages');
  if (el) el.scrollTop = el.scrollHeight;
}

// Renderiza el estado de sesión en el navbar: avatar si hay sesión, botón "Ingresar" si no
function updateProfileNavBtn() {
  const container = document.getElementById('profileNavBtn');
  if (!container) return;

  const token = localStorage.getItem('hp_token');

  if (token) {
    const profile = JSON.parse(localStorage.getItem('hp_profile') || 'null');
    const name = profile?.name || '';
    const initial = name ? name.charAt(0).toUpperCase() : '';
    container.innerHTML = initial
      ? `<a href="/perfil.html" title="Mi perfil — ${escHtml(name)}"
           style="display:inline-flex;align-items:center;justify-content:center;
                  width:32px;height:32px;border-radius:50%;
                  background:var(--orange);color:#fff;
                  font-weight:800;font-size:14px;text-decoration:none;flex-shrink:0"
         >${escHtml(initial)}</a>`
      : `<a href="/perfil.html" class="btn-icon" title="Mi perfil"
           style="display:inline-flex">👤</a>`;
  } else {
    container.innerHTML =
      `<button onclick="openModal('alertModal')" title="Suscribirse o ingresar"
         style="display:inline-flex;align-items:center;gap:5px;
                border:1px solid var(--orange);border-radius:20px;
                padding:5px 11px;background:rgba(255,102,0,.08);
                color:var(--orange);font-size:12px;font-weight:600;
                cursor:pointer;white-space:nowrap;line-height:1">
         👤 Ingresar
       </button>`;
  }
}

// ─── View Toggle ───────────────────────────────────────────────────────────────
function applyView(mode) {
  const grid = document.getElementById('productsGrid');
  if (!grid) return;
  if (mode === 'list') grid.classList.add('list-view');
  else grid.classList.remove('list-view');
  document.querySelectorAll('.view-btn').forEach(btn => {
    if (btn.dataset.view === mode) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}

function setView(mode) {
  state.view = mode;
  localStorage.setItem('hp_view', mode);
  applyView(mode);
}

// ─── Global exports ────────────────────────────────────────────────────────────
window.toggleTheme = toggleTheme;
window.filterStore = filterStore;
window.filterCategory = filterCategory;
window.updateSort = updateSort;
window.handleSearch = handleSearch;
window.resetFilters = resetFilters;
window.openModal = openModal;
window.closeModal = closeModal;
window.openProductDetail = openProductDetail;
window.toggleAlert = toggleAlert;
window.openProductAlertModal = openProductAlertModal;
window.submitProductAlert = submitProductAlert;
window.registerUser = registerUser;
window.loadProducts = loadProducts;
window.toggleChat = toggleChat;
window.sendChat = sendChat;
window.submitChatNotify = submitChatNotify;
window.confirmChatNotify = confirmChatNotify;
window.showChatContactForm = showChatContactForm;
window.highlightDashboardProduct = highlightDashboardProduct;
window.sendChatSuggestion = sendChatSuggestion;
window.setView = setView;
