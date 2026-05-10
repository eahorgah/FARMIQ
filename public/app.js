'use strict';

// ── State ─────────────────────────────────────────────────────
let token        = localStorage.getItem('fiq_token');
let currentUser  = JSON.parse(localStorage.getItem('fiq_user') || 'null');
let flockBatches = [];
let editingUserId = null;
let editingAgeBatchId = null;

// ── Feed Types — single source of truth ───────────────────────
const FEED_TYPES = {
  chick_starter:      'Chick Starter',
  broiler_starter:    'Broiler Starter',
  broiler_finisher:   'Broiler Finisher',
  layers_mash:        'Layers Mash',
  layers_concentrate: 'Layers Concentrate',
  grower_mash:        'Grower Mash',
  custom:             'Custom',
};
const feedLabel = key => FEED_TYPES[key] || key.replace(/_/g, ' ');

// ── API Helper ────────────────────────────────────────────────
let _refreshing = false;

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch('/api' + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    // Never try to refresh on auth routes themselves
    if (path.startsWith('/auth/')) {
      throw new Error(data.error || 'Invalid email or password');
    }
    // Try refresh token before giving up
    if (!_refreshing) {
      const refreshed = await tryRefresh();
      if (refreshed) return api(method, path, body); // retry with new token
    }
    logout();
    throw new Error('Session expired — please sign in again');
  }

  if (!res.ok) throw new Error(data.detail || data.error || data.errors?.[0]?.msg || `Request failed (${res.status})`);
  return data;
}

async function tryRefresh() {
  const refreshToken = localStorage.getItem('fiq_refresh');
  if (!refreshToken) return false;
  try {
    _refreshing = true;
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    token = data.accessToken;
    localStorage.setItem('fiq_token', token);
    if (data.refreshToken) localStorage.setItem('fiq_refresh', data.refreshToken);
    return true;
  } catch { return false; }
  finally { _refreshing = false; }
}

// ── Auth ──────────────────────────────────────────────────────
async function loadUserPermissions() {
  try {
    const { user, permissions } = await api('GET', '/auth/me');
    currentUser = { ...currentUser, ...user, permissions: permissions || {} };
    localStorage.setItem('fiq_user', JSON.stringify(currentUser));
  } catch { /* non-blocking — proceed with no permissions if fails */ }
}

async function login(email, password) {
  const data = await api('POST', '/auth/login', { email, password });
  saveSession(data);
  await loadUserPermissions();
  showApp();
}
async function register(org_name, full_name, email, password, phone) {
  const body = { org_name, full_name, email, password };
  if (phone) body.phone = phone;
  const data = await api('POST', '/auth/register', body);
  saveSession(data);
  await loadUserPermissions();
  showApp();
}
function saveSession(data) {
  token = data.accessToken;
  currentUser = data.user;
  localStorage.setItem('fiq_token', token);
  localStorage.setItem('fiq_user', JSON.stringify(currentUser));
  if (data.refreshToken) localStorage.setItem('fiq_refresh', data.refreshToken);
}
function logout() {
  token = null; currentUser = null;
  localStorage.removeItem('fiq_token');
  localStorage.removeItem('fiq_user');
  localStorage.removeItem('fiq_refresh');
  showAuth();
}

// ── Permission helper ─────────────────────────────────────────
function canAccess(module, action = 'view') {
  if (!currentUser) return false;
  if (currentUser.role === 'super_admin') return true;
  return currentUser.permissions?.[module]?.[action] === true;
}

// ── Page Switching ────────────────────────────────────────────
function showApp() {
  el('auth-page').classList.add('hidden');
  el('app-page').classList.remove('hidden');
  el('user-name').textContent = currentUser?.full_name || 'User';
  el('user-initials').textContent = (currentUser?.full_name || 'U').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
  const roleBadge = el('user-role-badge');
  if (roleBadge) {
    roleBadge.className = `badge role-${currentUser?.role}`;
    roleBadge.textContent = (currentUser?.role || '').replace(/_/g, ' ');
  }

  // Gate nav links by permission — only dashboard and expenditure are explicitly controlled
  const navGates = {
    dashboard:   () => canAccess('dashboard'),
    expenditure: () => canAccess('expenditure'),
  };
  document.querySelectorAll('.nav-link[data-section]').forEach(link => {
    const section = link.dataset.section;
    if (navGates[section]) {
      link.style.display = navGates[section]() ? '' : 'none';
    }
  });

  // Navigate to dashboard if accessible, otherwise first available section
  const startSection = canAccess('dashboard') ? 'dashboard' : 'flock';
  navigateTo(startSection);

  // Fetch unread alert count to populate the sidebar badge
  api('GET', '/alerts/unread-count').then(d => updateAlertBadge(d.count)).catch(() => {});
}
function showAuth() {
  el('auth-page').classList.remove('hidden');
  el('app-page').classList.add('hidden');
}

// ── Navigation ────────────────────────────────────────────────
function navigateTo(section) {
  // Block access to gated sections if user lacks permission
  const accessMap = { dashboard: 'dashboard', expenditure: 'expenditure' };
  if (accessMap[section] && !canAccess(accessMap[section])) {
    toast('You do not have permission to access this section.', 'error');
    return;
  }

  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.querySelector(`[data-section="${section}"]`)?.classList.add('active');
  document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
  el('section-' + section)?.classList.remove('hidden');
  const loaders = { dashboard: loadDashboard, flock: loadFlock, eggs: filterEggs, health: loadHealth, feed: loadFeed, income: loadIncome, expenditure: loadExpenditure, transactions: loadTransactions, ledger: loadLedger, reports: loadReports, users: loadUsers, alerts: loadAlerts, audit: loadAudit };
  loaders[section]?.();
}

// ── Dashboard ─────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const d = await api('GET', '/reports/dashboard');
    el('stat-birds').textContent    = Number(d.total_birds    || 0).toLocaleString();
    el('stat-batches').textContent  = Number(d.active_batches || 0).toLocaleString();
    el('stat-eggs').textContent     = Number(d.eggs_week  || 0).toLocaleString();
    const todaySub = el('stat-eggs-today');
    if (todaySub) todaySub.textContent = d.eggs_today > 0 ? `Today: ${Number(d.eggs_today).toLocaleString()}` : 'None logged today';
    el('stat-income').textContent   = 'GHS ' + fmt(d.monthly_income);
    el('stat-expenses').textContent = 'GHS ' + fmt(d.monthly_expenses);
    el('stat-profit').textContent   = 'GHS ' + fmt(d.monthly_profit);
    el('stat-pending').textContent  = d.pending_approvals || 0;
  } catch (e) { toast(e.message, 'error'); }
}

// ── Flock ─────────────────────────────────────────────────────
async function loadFlock() {
  try {
    const [bd, pd] = await Promise.all([api('GET', '/flock/batches'), api('GET', '/flock/pens')]);
    flockBatches = bd.batches;

    const canEdit = currentUser?.role === 'super_admin' || currentUser?.role === 'farm_owner'
      || currentUser?.role === 'farm_manager'
      || (currentUser?.permissions?.flock?.edit);

    tbody('batches-tbody', flockBatches, b => {
      const purposeColor = { layers:'b-green', broilers:'b-orange', breeders:'b-purple', dual_purpose:'b-cyan' };
      const statusColor  = { brooding:'b-blue', growing:'b-cyan', laying:'b-green', peak_lay:'b-green', declining:'b-yellow', sold:'b-gray', culled:'b-gray' };
      const ageWks = b.age_weeks != null ? Math.round(b.age_weeks) : null;
      return `<td><span class="code">${b.batch_code}</span></td>
              <td><strong>${b.breed}</strong></td>
              <td><span class="badge ${purposeColor[b.purpose]||'b-gray'}">${b.purpose}</span></td>
              <td><span class="badge ${statusColor[b.status]||'b-gray'}">${b.status}</span></td>
              <td><strong>${b.current_count}</strong></td>
              <td>${ageWks != null ? `<span class="age-badge">${ageWks} wks</span>` : '—'}</td>
              <td>${b.pen_name || '—'}</td>
              <td>${b.eggs_last_7d || 0}</td>
              <td>${canEdit
                ? `<button class="btn btn-age btn-xs" onclick="openUpdateAge('${b.id}','${b.batch_code}','${b.doc_date}',${ageWks ?? 0})">Update Age</button>`
                : '—'}</td>`;
    }, 9, 'No batches yet — create your first batch');

    tbody('pens-tbody', pd.pens, p =>
      `<td><strong>${p.name}</strong></td>
       <td>${p.capacity}</td>
       <td>${p.pen_type ? p.pen_type.replace(/_/g,' ') : '—'}</td>
       <td>${p.active_batches || 0}</td>
       <td>${p.total_birds || 0}</td>`,
      5, 'No pens yet — create your first pen'
    );

    el('batch-pen').innerHTML = '<option value="">No pen</option>' +
      pd.pens.map(p => `<option value="${p.id}">${p.name} (cap: ${p.capacity})</option>`).join('');

    refreshBatchDropdowns();
  } catch (e) { toast(e.message, 'error'); }
}

function refreshBatchDropdowns() {
  // egg-batch shows batch code only (product name auto-fills separately)
  const eggOpts = '<option value="">Select batch number</option>' +
    flockBatches.map(b => `<option value="${b.id}" data-breed="${b.breed||''}" data-purpose="${b.purpose||''}" data-count="${b.current_count||0}">${b.batch_code}</option>`).join('');
  const healthOpts = '<option value="">Select batch</option>' +
    flockBatches.map(b => `<option value="${b.id}">${b.batch_code} — ${b.breed}</option>`).join('');
  const eggSel = el('egg-batch'); if (eggSel) eggSel.innerHTML = eggOpts;
  const hSel = el('health-batch'); if (hSel) hSel.innerHTML = healthOpts;
}

function onEggBatchChange() {
  const sel = el('egg-batch');
  if (!sel) return;
  const opt    = sel.options[sel.selectedIndex];
  const batchId = sel.value;
  const breed   = opt?.dataset.breed   || '';
  const purpose = opt?.dataset.purpose || '';
  const count   = parseInt(opt?.dataset.count || '0') || 0;
  const batchCode = opt?.text || '';

  // Update hidden-compat fields (used by logEggs reset)
  const set = (id, v) => { const e = el(id); if (e) e.textContent = v; };
  set('egg-product-name', breed);
  set('egg-purpose', purpose ? purpose.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');

  // Store count as a data attribute on the panel for calcLayingRate
  const panel = el('egg-info-detail');
  if (panel) panel.dataset.birdCount = count;

  if (batchId && breed) {
    // Show info panel
    el('egg-info-placeholder')?.style && (el('egg-info-placeholder').style.display = 'none');
    if (panel) panel.style.display = 'block';

    const purposeLabel = purpose
      ? purpose.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      : '—';
    const target70 = Math.round(count * 0.70);

    // Populate panel
    const set2 = (id, v) => { const e = el(id); if (e) e.textContent = v; };
    set2('egg-info-batch-code', batchCode);
    set2('egg-info-breed', breed || '—');
    set2('egg-bird-count', count ? count.toLocaleString() : '—');
    set2('egg-info-target', target70 ? target70.toLocaleString() + ' eggs' : '—');
    set2('egg-product-name', breed || '—');
    set2('egg-purpose', purposeLabel);

    // Purpose badge colour
    const badge = el('egg-info-purpose-badge');
    if (badge) {
      badge.textContent = purposeLabel;
      badge.className = 'badge ' + (
        purpose === 'layers'       ? 'b-green'  :
        purpose === 'broilers'     ? 'b-orange' :
        purpose === 'breeders'     ? 'b-purple' : 'b-blue'
      );
    }
    set2('egg-info-tip-text', `Enter eggs collected to see today's laying rate.`);
  } else {
    // No batch — show placeholder
    if (el('egg-info-placeholder')) el('egg-info-placeholder').style.display = 'block';
    if (panel) panel.style.display = 'none';
  }
  calcLayingRate();
}

function calcLayingRate() {
  const collected = parseInt(el('egg-collected')?.value) || 0;
  const broken    = parseInt(el('egg-broken')?.value)    || 0;
  const panel     = el('egg-info-detail');
  const birds     = parseInt(panel?.dataset.birdCount || '0') || 0;

  const rateBox   = el('egg-rate-box');
  const rateFill  = el('egg-rate-fill');
  const ratePct   = el('egg-laying-preview');
  const saleablePrev = el('egg-saleable-preview');
  const tipText   = el('egg-info-tip-text');

  if (collected > 0 && birds > 0) {
    const rate     = (collected / birds) * 100;
    const saleable = Math.max(0, collected - broken);
    const rateStr  = rate.toFixed(1) + '%';
    const colour   = rate >= 70 ? '#16a34a' : rate >= 50 ? '#f59e0b' : '#dc2626';

    if (rateBox)  rateBox.style.display = 'block';
    if (ratePct)  { ratePct.textContent = rateStr; ratePct.style.color = colour; }
    if (rateFill) { rateFill.style.width = Math.min(rate, 100) + '%'; }
    if (saleablePrev) saleablePrev.textContent = saleable.toLocaleString() + ' eggs';
    if (tipText) {
      tipText.textContent = rate >= 70
        ? `Great! ${rateStr} laying rate is above the 70% target.`
        : rate >= 50
        ? `${rateStr} laying rate — below target (70%). Monitor closely.`
        : `${rateStr} laying rate is low. Check flock health.`;
    }
  } else {
    if (rateBox)  rateBox.style.display = 'none';
    if (ratePct)  ratePct.textContent = '—';
    if (saleablePrev) saleablePrev.textContent = '—';
  }
}

async function createBatch(form) {
  const data = fdata(form);
  data.initial_count = parseInt(data.initial_count);
  if (data.purchase_cost) data.purchase_cost = parseFloat(data.purchase_cost); else delete data.purchase_cost;
  if (!data.pen_id) delete data.pen_id;
  if (!data.supplier) delete data.supplier;
  await api('POST', '/flock/batches', data);
  form.reset(); el('batch-code-hint').textContent = '';
  hideModal('modal-batch'); toast('Batch created!'); loadFlock();
}

function suggestBatchCode() {
  const hint = el('batch-code-hint');
  const input = el('batch-code-input');
  if (!hint || !input || input.value) return;
  const existing = flockBatches.map(b => b.batch_code);
  let n = existing.length + 1;
  let suggested;
  do { suggested = 'BAT-' + String(n).padStart(3, '0'); n++; }
  while (existing.includes(suggested));
  hint.textContent = `Suggested: ${suggested}`;
  hint.onclick = () => { input.value = suggested; hint.textContent = ''; };
  hint.style.cursor = 'pointer';
}

async function createPen(form) {
  const data = fdata(form);
  data.capacity = parseInt(data.capacity);
  if (!data.pen_type) delete data.pen_type;
  if (!data.location) delete data.location;
  await api('POST', '/flock/pens', data);
  form.reset(); hideModal('modal-pen'); toast('Pen created! 🏠'); loadFlock();
}

// ── Eggs ──────────────────────────────────────────────────────
let _eggRecords = [];

async function loadEggs() {
  await ensureBatches();
  const data = await api('GET', '/eggs');
  _eggRecords = data.records || [];
  // Populate filter batch dropdown (preserve current selection)
  const filterSel = el('egg-filter-batch');
  if (filterSel) {
    const prevVal = filterSel.value;
    const seen = new Set();
    const filterOpts = _eggRecords
      .filter(r => r.batch_id && !seen.has(r.batch_id) && seen.add(r.batch_id))
      .map(r => `<option value="${r.batch_id}">${r.batch_code}</option>`)
      .join('');
    filterSel.innerHTML = '<option value="">All Batches</option>' + filterOpts;
    if (prevVal) filterSel.value = prevVal;
  }
  // Update summary bar
  const today = new Date().toISOString().slice(0, 10);
  const todayRecs = _eggRecords.filter(r => r.record_date?.slice(0, 10) === today);
  const todayEggs     = todayRecs.reduce((s, r) => s + (+r.eggs_collected || 0), 0);
  const todaySaleable = todayRecs.reduce((s, r) => s + ((+r.eggs_collected || 0) - (+r.broken_eggs || 0)), 0);
  const rates = _eggRecords.filter(r => r.laying_rate).map(r => +r.laying_rate);
  const avgRate = rates.length ? (rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1) : '—';
  if (el('egg-stat-today'))    el('egg-stat-today').textContent    = todayEggs.toLocaleString();
  if (el('egg-stat-saleable')) el('egg-stat-saleable').textContent = todaySaleable.toLocaleString();
  if (el('egg-stat-rate'))     el('egg-stat-rate').textContent     = avgRate + (rates.length ? '%' : '');
}

function renderEggsTable(records) {
  tbody('eggs-tbody', records, r => {
    // Fallback to cached batch list if the JOIN didn't return breed/purpose/bird_count
    const batch     = (r.breed == null && r.batch_id)
      ? flockBatches.find(b => b.id === r.batch_id)
      : null;
    const breed     = r.breed      || batch?.breed      || '—';
    const purpose   = r.purpose    || batch?.purpose    || null;
    const birdCount = r.bird_count != null ? r.bird_count
                    : batch?.current_count != null ? batch.current_count
                    : null;
    const batchCode = r.batch_code || batch?.batch_code || '—';

    const collected = +r.eggs_collected || 0;
    const broken    = +r.broken_eggs   || 0;
    const saleable  = r.saleable_eggs != null ? +r.saleable_eggs : (collected - broken);
    const rate      = +r.laying_rate || 0;
    const rateCell  = r.laying_rate
      ? `<span class="badge ${rate >= 70 ? 'b-green' : rate >= 50 ? 'b-yellow' : 'b-red'}">${r.laying_rate}%</span>`
      : '—';
    const purposeLabel = purpose
      ? purpose.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      : '—';
    const eggTypeLabels = { jumbo:'Jumbo', extra_large:'Extra Large', large:'Large', medium:'Medium', pullet:'Pullet' };
    const eggTypeColors = { jumbo:'b-purple', extra_large:'b-blue', large:'b-cyan', medium:'b-green', pullet:'b-yellow' };
    const eggTypeCell = r.egg_type
      ? `<span class="badge ${eggTypeColors[r.egg_type]||'b-gray'}">${eggTypeLabels[r.egg_type]||r.egg_type}</span>`
      : '—';
    return `<td>${fmtDate(r.record_date)}</td>
            <td><strong>${batchCode}</strong></td>
            <td>${eggTypeCell}</td>
            <td>${breed}</td>
            <td>${purposeLabel}</td>
            <td>${birdCount != null ? Number(birdCount).toLocaleString() : '—'}</td>
            <td><strong>${collected.toLocaleString()}</strong></td>
            <td>${broken}</td>
            <td>${saleable.toLocaleString()}</td>
            <td>${rateCell}</td>`;
  }, 10, 'No egg records yet — log your first collection');
}

async function filterEggs() {
  // Read filter values BEFORE loadEggs (which rebuilds the batch dropdown)
  const batchId  = el('egg-filter-batch')?.value  || '';
  const dateFrom = el('egg-filter-from')?.value   || '';
  const dateTo   = el('egg-filter-to')?.value     || '';
  try {
    await loadEggs(); // fetches fresh data, preserves dropdown selection
    let filtered = _eggRecords;
    if (batchId)  filtered = filtered.filter(r => String(r.batch_id) === batchId);
    if (dateFrom) filtered = filtered.filter(r => r.record_date?.slice(0, 10) >= dateFrom);
    if (dateTo)   filtered = filtered.filter(r => r.record_date?.slice(0, 10) <= dateTo);
    renderEggsTable(filtered);
  } catch (e) { toast(e.message, 'error'); }
}

function clearEggFilters() {
  ['egg-filter-batch', 'egg-filter-from', 'egg-filter-to'].forEach(id => {
    const el2 = el(id); if (el2) el2.value = '';
  });
  renderEggsTable(_eggRecords);
}

async function logEggs(form) {
  const data = fdata(form);
  data.eggs_collected = parseInt(data.eggs_collected);
  data.broken_eggs    = parseInt(data.broken_eggs || 0);
  if (!data.notes) delete data.notes;
  await api('POST', '/eggs', data);
  form.reset();
  // Reset info panel back to placeholder state
  if (el('egg-info-placeholder')) el('egg-info-placeholder').style.display = 'block';
  if (el('egg-info-detail'))      el('egg-info-detail').style.display = 'none';
  if (el('egg-rate-box'))         el('egg-rate-box').style.display = 'none';
  setToday();
  toast('Egg record saved! 🥚');
  filterEggs();
}

// ── Health ────────────────────────────────────────────────────
async function loadHealth() {
  await ensureBatches();
  try {
    const data = await api('GET', '/health');
    const sevColor = { low:'b-green', medium:'b-yellow', high:'b-orange', critical:'b-red' };
    const staColor = { completed:'b-green', ongoing:'b-orange', monitoring:'b-blue' };
    tbody('health-tbody', data.records, r =>
      `<td>${fmtDate(r.event_date)}</td>
       <td>${r.batch_code || '—'}</td>
       <td><span class="badge b-blue">${r.event_type}</span></td>
       <td><span class="badge ${sevColor[r.severity]||'b-gray'}">${r.severity}</span></td>
       <td>${r.birds_affected}</td>
       <td><span class="badge ${staColor[r.status]||'b-gray'}">${r.status}</span></td>`,
      6, 'No health events yet'
    );
  } catch (e) { toast(e.message, 'error'); }
}

async function logHealth(form) {
  const data = fdata(form);
  data.birds_affected = parseInt(data.birds_affected || 0);
  data.birds_treated  = parseInt(data.birds_treated  || 0);
  data.cost = parseFloat(data.cost || 0);
  if (!data.diagnosis) delete data.diagnosis;
  if (!data.notes) delete data.notes;
  await api('POST', '/health', data);
  form.reset(); setToday(); toast('Health event logged! 💊'); loadHealth();
}

// ── Feed ──────────────────────────────────────────────────────
async function loadFeed() {
  try {
    const [inv, txs] = await Promise.all([api('GET', '/feed/inventory'), api('GET', '/feed/transactions')]);
    tbody('inventory-tbody', inv.inventory, i =>
      `<td><strong>${i.feed_type.replace(/_/g,' ')}</strong></td>
       <td>${i.current_stock_kg} kg</td>
       <td>${i.minimum_stock_kg} kg</td>
       <td>${i.unit_cost_per_kg ? 'GHS '+i.unit_cost_per_kg : '—'}</td>
       <td>${i.low_stock_alert ? '<span class="badge b-red">⚠ Low Stock</span>' : '<span class="badge b-green">✓ OK</span>'}</td>`,
      5, 'No inventory — log a purchase first'
    );
    tbody('feed-tx-tbody', txs.transactions, t =>
      `<td>${fmtDate(t.transaction_date)}</td>
       <td><span class="badge ${t.transaction_type==='purchase'?'b-green':'b-orange'}">${t.transaction_type}</span></td>
       <td>${t.feed_type.replace(/_/g,' ')}</td>
       <td>${t.quantity_kg} kg</td>
       <td>${t.total_cost ? 'GHS '+fmt(t.total_cost) : '—'}</td>`,
      5
    );
  } catch (e) { toast(e.message, 'error'); }
}

function calcFeedKg() {
  const bags   = parseFloat(el('feed-bags')?.value) || 0;
  const kgBag  = parseFloat(el('feed-kg-per-bag')?.value) || 0;
  const total  = bags && kgBag ? bags * kgBag : 0;
  const disp   = el('feed-kg-display');
  const qty    = el('feed-qty-kg');
  const hidden = el('feed-bags-hidden');
  if (disp) disp.value = total || '';
  if (total && qty)    qty.value = total;
  if (hidden) hidden.value = bags || '';
}

async function logFeedTx(form) {
  const data = fdata(form);
  data.quantity_kg = parseFloat(data.quantity_kg);
  if (data.unit_cost)  data.unit_cost  = parseFloat(data.unit_cost);  else delete data.unit_cost;
  if (data.bags_count) data.bags_count = parseFloat(data.bags_count); else delete data.bags_count;
  if (data.kg_per_bag) data.kg_per_bag = parseFloat(data.kg_per_bag); else delete data.kg_per_bag;
  if (!data.supplier) delete data.supplier;
  await api('POST', '/feed/transactions', data);
  // Reset bag inputs
  ['feed-bags','feed-kg-per-bag','feed-kg-display'].forEach(id => { const e = el(id); if (e) e.value = ''; });
  form.reset(); setToday(); toast('Feed transaction logged!'); loadFeed();
}

// ── Income Category Helpers ───────────────────────────────────
const PRODUCT_CATEGORIES  = ['egg_sales','broiler_sales','day_old_chick_sales','layer_sales','manure_sales'];
const BIRD_CATEGORIES     = ['broiler_sales','day_old_chick_sales','layer_sales'];
const CATEGORY_UNIT_MAP   = { egg_sales:'tray', broiler_sales:'bird', day_old_chick_sales:'chick', layer_sales:'bird', manure_sales:'bag', other_income:'unit' };

function onIncomeCategoryChange() {
  const cat = el('income-category')?.value;
  const block = el('sale-details-block');
  if (!block) return;
  const isProduct = PRODUCT_CATEGORIES.includes(cat);
  block.style.display = isProduct ? '' : 'none';

  // Auto-set unit
  const unitSel = el('income-unit');
  if (unitSel && CATEGORY_UNIT_MAP[cat]) unitSel.value = CATEGORY_UNIT_MAP[cat];

  // Batch selector hint
  const hint = el('income-batch-hint');
  if (hint) hint.textContent = BIRD_CATEGORIES.includes(cat) ? '(required — birds deducted from batch)' : '(optional)';

  // Populate batch dropdown
  const batchSel = el('income-batch-select');
  if (batchSel && flockBatches.length) {
    const relevant = BIRD_CATEGORIES.includes(cat)
      ? flockBatches.filter(b => !['sold','culled'].includes(b.status))
      : flockBatches;
    batchSel.innerHTML = '<option value="">Select batch (optional for eggs)</option>' +
      relevant.map(b => `<option value="${b.id}">${b.batch_code} — ${b.breed} (${b.current_count} birds)</option>`).join('');
  }
  calcIncomeAmount();
}

function calcIncomeAmount() {
  const qty   = parseFloat(el('income-qty')?.value) || 0;
  const price = parseFloat(el('income-unit-price')?.value) || 0;
  const total = qty && price ? qty * price : 0;
  const amtEl = el('income-amount');
  const prev  = el('income-amount-preview');
  const unit  = el('income-unit')?.value || 'unit';
  if (total) {
    if (amtEl) amtEl.value = total.toFixed(2);
    if (prev) { prev.style.display = ''; prev.textContent = `${qty} ${unit}(s) × GHS ${price} = GHS ${fmt(total)}`; }
    // Auto-fill description
    const descEl = el('income-desc');
    if (descEl && !descEl.dataset.userEdited) {
      const cat = (el('income-category')?.value || '').replace(/_/g,' ');
      descEl.value = `Sold ${qty} ${unit}(s) of ${cat}`;
    }
  } else {
    if (prev) prev.style.display = 'none';
  }
}

// ── Income ────────────────────────────────────────────────────
async function loadIncome() {
  await ensureBatches();
  onIncomeCategoryChange(); // set initial state of sale block
  try {
    const data = await api('GET', '/transactions/export?type=income&limit=50');
    const sColor = { approved:'b-green', pending:'b-yellow', rejected:'b-red', flagged:'b-orange' };
    tbody('income-tbody', data.transactions, t => {
      const hasQty = t.sale_qty && t.sale_unit;
      return `<td>${fmtDate(t.transaction_date)}</td>
       <td>${t.category.replace(/_/g,' ')}</td>
       <td style="font-size:12px">${hasQty ? `${t.sale_qty} ${t.sale_unit}` : '—'}</td>
       <td style="font-size:12px">${t.sale_unit_price ? 'GHS '+fmt(t.sale_unit_price) : '—'}</td>
       <td><strong class="amount-positive">GHS ${fmt(t.amount)}</strong></td>
       <td>${t.counterparty_name || '—'}</td>
       <td><span class="badge ${sColor[t.approval_status]||'b-gray'}">${t.approval_status}</span></td>`;
    }, 7, 'No income recorded yet — add your first income entry');
  } catch (e) { toast(e.message, 'error'); }
}

async function createIncome(form) {
  const data = fdata(form);
  data.amount = parseFloat(data.amount);
  data.type   = 'income';
  if (data.sale_quantity)  data.sale_quantity  = parseFloat(data.sale_quantity);
  if (data.sale_unit_price) data.sale_unit_price = parseFloat(data.sale_unit_price);
  if (!data.sale_quantity || !data.sale_unit_price) { delete data.sale_quantity; delete data.sale_unit_price; delete data.sale_unit; }
  if (!data.sale_batch_id) delete data.sale_batch_id;
  if (!data.counterparty_name) delete data.counterparty_name;
  const res = await api('POST', '/transactions', data);
  form.reset();
  el('income-amount-preview') && (el('income-amount-preview').style.display = 'none');
  onIncomeCategoryChange();
  setToday();
  toast('Income recorded!');
  if (BIRD_CATEGORIES.includes(data.category)) toast('Bird count updated in batch', 'info');
  loadIncome();
  // Refresh flock so updated bird count shows immediately
  if (BIRD_CATEGORIES.includes(data.category)) { flockBatches = []; }
}

// ── Expenditure ───────────────────────────────────────────────
async function loadExpenditure() {
  try {
    const data = await api('GET', '/transactions?type=expense');
    const sColor = { approved:'b-green', pending:'b-yellow', rejected:'b-red', flagged:'b-orange' };
    tbody('expenditure-tbody', data.transactions, t =>
      `<td>${fmtDate(t.transaction_date)}</td>
       <td>${t.category.replace(/_/g,' ')}</td>
       <td><strong class="amount-negative">GHS ${fmt(t.amount)}</strong></td>
       <td>${t.description}</td>
       <td>${t.counterparty_name || '—'}</td>
       <td><span class="badge ${sColor[t.approval_status]||'b-gray'}">${t.approval_status}</span></td>`,
      6, 'No expenses recorded yet — add your first expense entry'
    );
  } catch (e) { toast(e.message, 'error'); }
}

async function createExpense(form) {
  const data = fdata(form);
  data.amount = parseFloat(data.amount);
  data.type = 'expense';
  if (!data.counterparty_name) delete data.counterparty_name;
  if (!data.notes) delete data.notes;
  await api('POST', '/transactions', data);
  form.reset(); setToday(); toast('Expense recorded! 📤'); loadExpenditure();
}

// ── Stock Ledger ──────────────────────────────────────────────
async function loadLedger() { await filterLedger(); }

async function filterLedger() {
  const filterFeed = el('ledger-filter')?.value || '';
  try {
    const [invRes, txRes] = await Promise.all([
      api('GET', '/feed/inventory'),
      api('GET', '/feed/transactions'),
    ]);

    const allTx = txRes.transactions || [];
    const filtered = filterFeed ? allTx.filter(t => t.feed_type === filterFeed) : allTx;

    // Sort by feed_type then date
    filtered.sort((a, b) => {
      if (a.feed_type < b.feed_type) return -1;
      if (a.feed_type > b.feed_type) return  1;
      return new Date(a.transaction_date) - new Date(b.transaction_date);
    });

    // Compute running balance per feed type
    const balances = {};
    const rows = filtered.map(t => {
      const ft = t.feed_type;
      if (!balances[ft]) balances[ft] = 0;
      const isPurchase = t.transaction_type === 'purchase';
      const qtyIn  = isPurchase ? +t.quantity_kg : 0;
      const qtyOut = isPurchase ? 0 : +t.quantity_kg;
      balances[ft] += qtyIn - qtyOut;
      const bal = balances[ft];
      const balClass = bal < 0 ? 'amount-negative' : bal < 50 ? 'ledger-low' : 'amount-positive';
      const unitCost = t.unit_cost ? 'GHS '+fmt(t.unit_cost) : '—';
      const totalVal = t.total_cost ? 'GHS '+fmt(t.total_cost) : (t.unit_cost ? 'GHS '+fmt(t.unit_cost * t.quantity_kg) : '—');
      const bagsCell = t.bags_count ? `${t.bags_count} bag${t.bags_count>1?'s':''}` : '—';
      return `<td>${fmtDate(t.transaction_date)}</td>
              <td><strong>${feedLabel(ft)}</strong></td>
              <td><span class="badge ${isPurchase?'b-green':'b-orange'}">${t.transaction_type}</span></td>
              <td style="font-size:12px;color:var(--gray-500)">${bagsCell}</td>
              <td class="qty-in">${qtyIn > 0 ? '+'+qtyIn+' kg' : '—'}</td>
              <td class="qty-out">${qtyOut > 0 ? qtyOut+' kg' : '—'}</td>
              <td>${unitCost}</td>
              <td>${totalVal}</td>
              <td><strong class="${balClass}">${bal.toFixed(1)} kg</strong></td>
              <td>${t.supplier || t.notes || '—'}</td>`;
    });

    const b = el('ledger-tbody');
    if (b) {
      if (!rows.length) {
        b.innerHTML = `<tr><td colspan="10" class="empty"><span class="empty-icon">📭</span>No feed transactions yet — log a purchase or usage</td></tr>`;
      } else {
        b.innerHTML = rows.map(r => `<tr>${r}</tr>`).join('');
      }
    }

    // Summary cards per feed type
    const inv = invRes.inventory || [];
    const summaryFeed = filterFeed ? inv.filter(i => i.feed_type === filterFeed) : inv;
    const summaryEl = el('stock-summary');
    if (summaryEl) {
      summaryEl.innerHTML = summaryFeed.map(i => {
        const isLow = i.low_stock_alert;
        return `<div class="stat-card stat-feed" style="${isLow ? 'border:2px solid #dc2626' : ''}">
          <div class="stat-label">${i.feed_type.replace(/_/g,' ')}</div>
          <div class="stat-value">${i.current_stock_kg} kg</div>
          <div class="stat-sub">${isLow ? '<span style="color:#dc2626;font-weight:700">⚠ Low Stock</span>' : 'Min: '+i.minimum_stock_kg+' kg'}</div>
        </div>`;
      }).join('') || '<p style="color:var(--gray-400);font-size:13px;padding:12px">No inventory data yet.</p>';
    }
  } catch (e) { toast(e.message, 'error'); }
}

// ── Transactions ──────────────────────────────────────────────
async function loadTransactions() { filterTransactions(); }

async function filterTransactions() {
  const type   = el('filter-tx-type')?.value;
  const status = el('filter-tx-status')?.value;
  const from   = el('filter-tx-from')?.value;
  const to     = el('filter-tx-to')?.value;
  const params = new URLSearchParams();
  if (type)   params.set('type', type);
  if (status) params.set('approval_status', status);
  if (from)   params.set('date_from', from);
  if (to)     params.set('date_to', to);
  try {
    const data = await api('GET', '/transactions?' + params);
    const total = data.pagination?.total || data.transactions?.length || 0;
    const countEl = el('tx-count');
    if (countEl) countEl.textContent = `${total.toLocaleString()} record${total !== 1 ? 's' : ''}`;

    const tColor = { income:'b-green', expense:'b-red' };
    const sColor = { approved:'b-green', pending:'b-yellow', rejected:'b-red', flagged:'b-orange' };
    tbody('tx-tbody', data.transactions, t =>
      `<td style="white-space:nowrap">${fmtDate(t.transaction_date)}</td>
       <td style="font-size:11px;font-family:monospace;color:var(--gray-400)">${t.transaction_ref || '—'}</td>
       <td><span class="badge ${tColor[t.type]||'b-gray'}">${t.type}</span></td>
       <td>${t.category.replace(/_/g,' ')}</td>
       <td style="font-size:12px">${t.sale_qty ? `${t.sale_qty} ${t.sale_unit||''}` : '—'}</td>
       <td><strong class="${t.type==='income'?'amount-positive':'amount-negative'}">GHS ${fmt(t.amount)}</strong></td>
       <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.description}</td>
       <td><span class="badge ${sColor[t.approval_status]||'b-gray'}">${t.approval_status}</span></td>
       <td style="display:flex;gap:4px">${t.approval_status==='pending'
         ? `<button class="btn btn-success btn-xs" onclick="approveTx('${t.id}')">✓</button>
            <button class="btn btn-danger btn-xs" onclick="rejectTx('${t.id}')">✕</button>`
         : '—'}</td>`,
      9, 'No transactions yet'
    );
  } catch (e) { toast(e.message, 'error'); }
}

function clearTxFilters() {
  ['filter-tx-type','filter-tx-status','filter-tx-from','filter-tx-to'].forEach(id => { const e = el(id); if (e) e.value = ''; });
  filterTransactions();
}

async function exportTxPDF() {
  if (!window.jspdf) { toast('PDF library not loaded — try again shortly', 'error'); return; }
  const rows = await fetchTxForExport();
  if (!rows) return;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const from = el('filter-tx-from')?.value || '';
  const to   = el('filter-tx-to')?.value   || '';
  const label = from || to ? ` (${from || '…'} → ${to || 'now'})` : ' — All Dates';

  doc.setFillColor(15,23,42); doc.rect(0,0,297,24,'F');
  doc.setTextColor(255,255,255); doc.setFontSize(14); doc.setFont('helvetica','bold');
  doc.text('FarmIQ — Transaction Report' + label, 10, 10);
  doc.setFontSize(9); doc.setFont('helvetica','normal');
  doc.text(`Generated: ${new Date().toLocaleString()}   Total records: ${rows.length}`, 10, 18);

  const tColor = r => r.type === 'income' ? [22,163,74] : [220,38,38];
  doc.autoTable({
    startY: 28,
    head: [['Date','Ref','Type','Category','Qty / Unit','Amt (GHS)','Description','Buyer / Supplier','Status']],
    body: rows.map(r => [
      fmtDate(r.transaction_date),
      r.transaction_ref || '',
      r.type,
      r.category.replace(/_/g,' '),
      r.sale_qty ? `${r.sale_qty} ${r.sale_unit||''}` : '—',
      fmt(r.amount),
      r.description,
      r.counterparty_name || '—',
      r.approval_status,
    ]),
    theme: 'striped',
    headStyles: { fillColor: [15,23,42], fontSize: 8 },
    bodyStyles: { fontSize: 8 },
    didParseCell: (d) => {
      if (d.section === 'body' && d.column.index === 1) {
        const row = rows[d.row.index];
        d.cell.styles.textColor = tColor(row);
        d.cell.styles.fontStyle = 'bold';
      }
    },
    columnStyles: { 5: { halign:'right' } },
  });

  const year = new Date().getFullYear();
  doc.save(`FarmIQ-Transactions-${from||year}-${to||year}.pdf`);
  toast('Transaction report PDF downloaded!');
}

async function exportTxExcel() {
  if (!window.XLSX) { toast('Excel library not loaded — try again shortly', 'error'); return; }
  const rows = await fetchTxForExport();
  if (!rows) return;
  const XLSX = window.XLSX;
  const from = el('filter-tx-from')?.value || '';
  const to   = el('filter-tx-to')?.value   || '';

  const headers = ['Date','Transaction Ref','Type','Category','Qty Sold','Unit','Unit Price (GHS)','Amount (GHS)','Description','Buyer/Supplier','Payment','Status','Batch Code','Recorded By'];
  const data = rows.map(r => [
    fmtDate(r.transaction_date), r.transaction_ref, r.type,
    r.category.replace(/_/g,' '),
    r.sale_qty || '', r.sale_unit || '', r.sale_unit_price || '',
    +r.amount, r.description, r.counterparty_name || '',
    r.payment_method || '', r.approval_status, r.batch_code || '', r.recorded_by || '',
  ]);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  ws['!cols'] = headers.map((_, i) => ({ wch: [12,16,8,18,8,8,12,12,30,20,12,10,10,16][i] || 12 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Transactions');

  // Summary sheet
  const incomeTotal  = rows.filter(r => r.type==='income').reduce((s,r) => s + +r.amount, 0);
  const expenseTotal = rows.filter(r => r.type==='expense').reduce((s,r) => s + +r.amount, 0);
  const sumWs = XLSX.utils.aoa_to_sheet([
    ['FarmIQ Transaction Summary'],
    ['Period', `${from||'All'} to ${to||'now'}`],
    [],
    ['Total Records',  rows.length],
    ['Total Income',   incomeTotal],
    ['Total Expenses', expenseTotal],
    ['Net',            incomeTotal - expenseTotal],
  ]);
  XLSX.utils.book_append_sheet(wb, sumWs, 'Summary');

  XLSX.writeFile(wb, `FarmIQ-Transactions-${from||'all'}-${to||'now'}.xlsx`);
  toast('Transaction report Excel downloaded!');
}

async function fetchTxForExport() {
  const from   = el('filter-tx-from')?.value;
  const to     = el('filter-tx-to')?.value;
  const type   = el('filter-tx-type')?.value;
  const status = el('filter-tx-status')?.value;
  const params = new URLSearchParams();
  if (type)   params.set('type', type);
  if (status) params.set('approval_status', status);
  if (from)   params.set('date_from', from);
  if (to)     params.set('date_to', to);
  try {
    const data = await api('GET', '/transactions/export?' + params);
    if (!data.transactions?.length) { toast('No transactions found for selected filters', 'info'); return null; }
    return data.transactions;
  } catch (e) { toast(e.message, 'error'); return null; }
}

async function createTransaction(form) {
  const data = fdata(form);
  data.amount = parseFloat(data.amount);
  if (!data.counterparty_name) delete data.counterparty_name;
  await api('POST', '/transactions', data);
  form.reset(); setToday(); hideModal('modal-tx'); toast('Transaction recorded! 💰'); loadTransactions();
}

async function approveTx(id) {
  try { await api('POST', `/transactions/${id}/approve`); toast('Transaction approved! ✓'); loadTransactions(); }
  catch (e) { toast(e.message, 'error'); }
}
async function rejectTx(id) {
  const reason = prompt('Enter rejection reason:');
  if (!reason) return;
  try { await api('POST', `/transactions/${id}/reject`, { reason }); toast('Transaction rejected'); loadTransactions(); }
  catch (e) { toast(e.message, 'error'); }
}

// ── Reports ───────────────────────────────────────────────────
async function loadReports() {
  const year = new Date().getFullYear();
  el('report-year').textContent = year;
  try {
    const [pl, prod] = await Promise.all([
      api('GET', `/reports/profit-loss?year=${year}`),
      api('GET', `/reports/production-summary?year=${year}`),
    ]);
    captureReportSnapshot(pl, prod);
    el('pl-income').textContent   = 'GHS ' + fmt(pl.totals.income);
    el('pl-expenses').textContent = 'GHS ' + fmt(pl.totals.expenses);
    el('pl-profit').textContent   = 'GHS ' + fmt(pl.totals.net_profit);
    el('pl-margin').textContent   = pl.totals.margin + '%';
    tbody('pl-income-tbody',  pl.income,   r => `<td>${r.category.replace(/_/g,' ')}</td><td><strong>GHS ${fmt(r.total)}</strong></td>`, 2, 'No income recorded yet');
    tbody('pl-expense-tbody', pl.expenses, r => `<td>${r.category.replace(/_/g,' ')}</td><td><strong>GHS ${fmt(r.total)}</strong></td>`, 2, 'No expenses recorded yet');
    tbody('prod-tbody', prod.production, r =>
      `<td>${fmtDate(r.week)}</td><td>${r.total_eggs}</td><td>${r.saleable_eggs}</td>
       <td>${r.avg_laying_rate ? (+r.avg_laying_rate).toFixed(1)+'%' : '—'}</td>`,
      4, 'No production data yet'
    );
  } catch (e) { toast(e.message, 'error'); }
}

// ── Staff Alerts ──────────────────────────────────────────────
const ALERT_MANAGER_ROLES = ['super_admin', 'farm_owner', 'farm_manager'];

async function loadAlerts() {
  const isManager = ALERT_MANAGER_ROLES.includes(currentUser?.role);

  // Show create form and history table for managers
  const formCard = el('alert-form-card');
  const histCard = el('alerts-history-card');
  const btnNew   = el('btn-new-alert');
  if (formCard) formCard.style.display = isManager ? '' : 'none';
  if (histCard) histCard.style.display = isManager ? '' : 'none';
  if (btnNew)   btnNew.style.display   = isManager ? '' : 'none';

  try {
    const data = await api('GET', '/alerts');
    renderAlertCards(data.alerts);
    updateAlertBadge(data.alerts.filter(a => !a.is_read).length);
    if (isManager) loadAllAlerts();
  } catch (e) { toast(e.message, 'error'); }
}

function renderAlertCards(alerts) {
  const grid = el('alerts-grid');
  if (!grid) return;
  if (!alerts.length) {
    grid.innerHTML = '<div class="empty" style="padding:60px 0;text-align:center"><span class="empty-icon">🔔</span>No active alerts</div>';
    return;
  }
  const sevIcon = { info: 'ℹ', warning: '⚠', critical: '🚨' };
  const sevClass = { info: 'alert-info', warning: 'alert-warning', critical: 'alert-critical' };
  grid.innerHTML = alerts.map(a => `
    <div class="alert-card ${sevClass[a.severity] || 'alert-info'} ${a.is_read ? 'alert-read' : ''}">
      <div class="alert-card-head">
        <span class="alert-sev-icon">${sevIcon[a.severity] || 'ℹ'}</span>
        <div class="alert-card-title">${a.title}</div>
        <span class="badge b-gray" style="font-size:10px;text-transform:uppercase">${a.category}</span>
      </div>
      <div class="alert-card-msg">${a.message}</div>
      <div class="alert-card-foot">
        <span style="color:var(--gray-400);font-size:11px">By ${a.created_by_name || '—'} · ${fmtDate(a.created_at)}</span>
        ${!a.is_read
          ? `<button class="btn btn-outline btn-xs" onclick="markAlertRead('${a.id}')">✓ Mark read</button>`
          : '<span style="color:var(--gray-400);font-size:11px">✓ Read</span>'}
      </div>
    </div>
  `).join('');
}

async function loadAllAlerts() {
  try {
    const data = await api('GET', '/alerts/all');
    const sColor = { info:'b-blue', warning:'b-yellow', critical:'b-red' };
    tbody('alerts-history-tbody', data.alerts, a =>
      `<td style="font-size:12px;color:var(--gray-400)">${fmtDate(a.created_at)}</td>
       <td><span class="badge ${sColor[a.severity]||'b-gray'}">${a.severity}</span></td>
       <td style="font-weight:600;max-width:260px">${a.title}</td>
       <td><span class="badge b-gray">${a.category}</span></td>
       <td style="font-size:11px">${a.target_roles ? a.target_roles.join(', ') : 'All staff'}</td>
       <td style="text-align:center">${a.read_count || 0}</td>
       <td>${a.is_active ? '<span class="badge b-green">Active</span>' : '<span class="badge b-gray">Inactive</span>'}</td>
       <td>${a.is_active
         ? `<button class="btn btn-danger btn-xs" onclick="deactivateAlert('${a.id}')">Deactivate</button>`
         : '—'}
       </td>`,
      8, 'No alerts yet'
    );
  } catch (e) { /* non-blocking */ }
}

async function createAlert(form) {
  const data = fdata(form);
  // Multi-select returns only last value via FormData — collect properly
  const sel = form.querySelector('[name="target_roles"]');
  const roles = sel ? Array.from(sel.selectedOptions).map(o => o.value).filter(Boolean) : [];
  data.target_roles = roles;
  if (!data.expires_at) delete data.expires_at;
  await api('POST', '/alerts', data);
  form.reset(); toast('Alert broadcast to staff! 📢'); loadAlerts();
}

async function markAlertRead(id) {
  try {
    await api('POST', `/alerts/${id}/read`);
    loadAlerts();
  } catch (e) { toast(e.message, 'error'); }
}

async function deactivateAlert(id) {
  if (!confirm('Deactivate this alert?')) return;
  try {
    await api('DELETE', `/alerts/${id}`);
    toast('Alert deactivated'); loadAlerts();
  } catch (e) { toast(e.message, 'error'); }
}

function updateAlertBadge(count) {
  const badge = el('alert-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ── Audit Trail ───────────────────────────────────────────────
let auditPage = 1;

async function loadAudit() {
  auditPage = 1;
  // Populate user + action dropdowns on first load
  try {
    const [usersRes, actionsRes] = await Promise.all([
      api('GET', '/audit/users'),
      api('GET', '/audit/actions'),
    ]);
    const userSel = el('audit-filter-user');
    if (userSel && userSel.options.length <= 1) {
      usersRes.users.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u.id; opt.textContent = `${u.full_name} (${u.email})`;
        userSel.appendChild(opt);
      });
    }
    const actionSel = el('audit-filter-action');
    if (actionSel && actionSel.options.length <= 1) {
      actionsRes.actions.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a; opt.textContent = a.replace(/_/g, ' ');
        actionSel.appendChild(opt);
      });
    }
  } catch { /* non-blocking */ }
  await filterAudit();
}

async function filterAudit() {
  const params = new URLSearchParams({ page: auditPage, limit: 50 });
  const uid   = el('audit-filter-user')?.value;
  const act   = el('audit-filter-action')?.value;
  const res   = el('audit-filter-resource')?.value;
  const from  = el('audit-date-from')?.value;
  const to    = el('audit-date-to')?.value;
  if (uid)  params.set('user_id', uid);
  if (act)  params.set('action', act);
  if (res)  params.set('resource_type', res);
  if (from) params.set('date_from', from);
  if (to)   params.set('date_to', to);

  try {
    const data = await api('GET', '/audit/logs?' + params);
    const logs = data.logs;
    const total = data.pagination?.total || 0;
    const countEl = el('audit-count');
    if (countEl) countEl.textContent = `${total.toLocaleString()} record${total !== 1 ? 's' : ''}`;

    const actionColor = (a) => {
      if (a.startsWith('create'))  return 'b-green';
      if (a.startsWith('update') || a.startsWith('approve')) return 'b-blue';
      if (a.startsWith('delete') || a.startsWith('reject'))  return 'b-red';
      if (a.startsWith('login'))   return 'b-purple';
      return 'b-gray';
    };
    tbody('audit-tbody', logs, l =>
      `<td style="font-size:12px;white-space:nowrap;color:var(--gray-500)">${l.created_at ? new Date(l.created_at).toLocaleString() : '—'}</td>
       <td>
         <div style="font-weight:600;font-size:13px">${l.full_name}</div>
         <div style="font-size:11px;color:var(--gray-400)">${l.email}</div>
       </td>
       <td><span class="badge role-${l.role}" style="font-size:10px">${l.role.replace(/_/g,' ')}</span></td>
       <td><span class="badge ${actionColor(l.action)}">${l.action.replace(/_/g,' ')}</span></td>
       <td>${l.resource_type
         ? `<span style="font-size:12px;color:var(--gray-600)">${l.resource_type.replace(/_/g,' ')}</span>`
         : '—'}
       </td>
       <td style="font-size:12px;color:var(--gray-400);font-family:monospace">${l.ip_address || '—'}</td>`,
      6, 'No audit logs yet — actions will appear here'
    );

    renderAuditPagination(data.pagination);
  } catch (e) { toast(e.message, 'error'); }
}

function renderAuditPagination(p) {
  const pg = el('audit-pagination');
  if (!pg || !p) return;
  const pages = Math.ceil(p.total / p.limit);
  if (pages <= 1) { pg.innerHTML = ''; return; }
  pg.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:16px">
      <button class="btn btn-outline btn-sm" ${p.page <= 1 ? 'disabled' : ''} onclick="auditPage=${p.page-1};filterAudit()">← Prev</button>
      <span style="font-size:13px;color:var(--gray-500)">Page ${p.page} of ${pages}</span>
      <button class="btn btn-outline btn-sm" ${p.page >= pages ? 'disabled' : ''} onclick="auditPage=${p.page+1};filterAudit()">Next →</button>
    </div>`;
}

function clearAuditFilters() {
  ['audit-filter-user','audit-filter-action','audit-filter-resource','audit-date-from','audit-date-to']
    .forEach(id => { const e = el(id); if (e) e.value = ''; });
  auditPage = 1;
  filterAudit();
}

// ── Users & Access Control ────────────────────────────────────
function openCreateUser() {
  const isSuperAdmin = currentUser?.role === 'super_admin';
  const isFarmOwner  = currentUser?.role === 'farm_owner' || isSuperAdmin;
  document.querySelectorAll('.role-opt-super').forEach(o => o.style.display = isSuperAdmin ? '' : 'none');
  document.querySelectorAll('.role-opt-owner').forEach(o => o.style.display = isFarmOwner  ? '' : 'none');
  // Reset the select so placeholder shows
  const sel = document.querySelector('#modal-user select[name="role"]');
  if (sel) sel.value = '';
  showModal('modal-user');
}

async function loadUsers() {
  try {
    const data = await api('GET', '/users');
    tbody('users-tbody', data.users, u => {
      const initials = u.full_name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
      const lastLogin = u.last_login_at ? fmtDate(u.last_login_at) : 'Never';
      return `
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#16a34a,#0891b2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:white;flex-shrink:0">${initials}</div>
            <div>
              <div style="font-weight:700">${u.full_name}</div>
              ${u.phone ? `<div style="font-size:11px;color:var(--gray-400)">${u.phone}</div>` : ''}
            </div>
          </div>
        </td>
        <td>${u.email}</td>
        <td><span class="badge role-${u.role}">${u.role.replace(/_/g,' ')}</span></td>
        <td>${u.is_active ? '<span class="user-status-active" style="color:var(--brand);font-weight:600;font-size:12px">Active</span>' : '<span style="color:var(--gray-400);font-size:12px">Inactive</span>'}</td>
        <td style="color:var(--gray-400);font-size:12px">${lastLogin}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap">
          ${['farm_owner','super_admin'].includes(currentUser?.role)
            ? `<button class="btn btn-info btn-xs" onclick="openPermissions('${u.id}', '${u.full_name}', ${JSON.stringify(u.permissions || {}).replace(/"/g,'&quot;')})">🔐 Permissions</button>`
            : ''}
          <button class="btn btn-audit btn-xs" onclick="viewUserAudit('${u.id}', '${u.full_name}')">🔍 Activity</button>
        </td>`;
    }, 6, 'No users found');
  } catch (e) { toast(e.message, 'error'); }
}

async function createUser(form) {
  const data = fdata(form);
  if (!data.phone) delete data.phone;
  await api('POST', '/users', data);
  form.reset(); hideModal('modal-user'); toast('User created! 👤'); loadUsers();
}

async function viewUserAudit(userId, userName) {
  // Navigate to audit section first so the DOM elements exist
  navigateTo('audit');

  // Populate dropdowns if not yet done
  const userSel = el('audit-filter-user');
  if (userSel && userSel.options.length <= 1) {
    try {
      const [usersRes, actionsRes] = await Promise.all([
        api('GET', '/audit/users'),
        api('GET', '/audit/actions'),
      ]);
      usersRes.users.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u.id; opt.textContent = `${u.full_name} (${u.email})`;
        userSel.appendChild(opt);
      });
      const actionSel = el('audit-filter-action');
      if (actionSel) {
        actionsRes.actions.forEach(a => {
          const opt = document.createElement('option');
          opt.value = a; opt.textContent = a.replace(/_/g, ' ');
          actionSel.appendChild(opt);
        });
      }
    } catch { /* non-blocking */ }
  }

  // Set the user filter and apply
  if (userSel) userSel.value = userId;
  auditPage = 1;
  await filterAudit();
  toast(`Showing activity for ${userName}`, 'info');
}

// ── Permission Matrix ─────────────────────────────────────────
const MODULES = [
  { key: 'dashboard',    label: 'Dashboard',    icon: '📊', color: '#f0fdf4' },
  { key: 'flock',        label: 'Flock',        icon: '🐔', color: '#fef3c7' },
  { key: 'health',       label: 'Health',        icon: '💊', color: '#fee2e2' },
  { key: 'feed',         label: 'Feed',          icon: '🌾', color: '#dcfce7' },
  { key: 'transactions', label: 'Transactions',  icon: '💰', color: '#dbeafe' },
  { key: 'expenditure',  label: 'Expenditure',   icon: '📤', color: '#fef2f2' },
  { key: 'reports',      label: 'Reports',       icon: '📈', color: '#f3e8ff' },
  { key: 'users',        label: 'Users',         icon: '👥', color: '#cffafe' },
];
const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve'];

function openPermissions(userId, name, perms) {
  editingUserId = userId;
  el('perm-user-name').textContent = name;

  const rows = MODULES.map(m => {
    const mp = perms[m.key] || {};
    const checks = ACTIONS.map(a =>
      `<td><input type="checkbox" data-module="${m.key}" data-action="${a}" ${mp[a] ? 'checked' : ''}/></td>`
    ).join('');
    return `<tr>
      <td><span class="perm-module-icon" style="background:${m.color}">${m.icon}</span>${m.label}</td>
      ${checks}
    </tr>`;
  }).join('');

  el('perm-tbody').innerHTML = rows;
  showModal('modal-perms');
}

async function savePermissions() {
  const permissions = {};
  MODULES.forEach(m => {
    permissions[m.key] = {};
    ACTIONS.forEach(a => {
      const cb = document.querySelector(`[data-module="${m.key}"][data-action="${a}"]`);
      permissions[m.key][a] = cb?.checked || false;
    });
  });
  try {
    await api('PUT', `/users/${editingUserId}/permissions`, { permissions });
    hideModal('modal-perms');
    toast('Permissions saved! 🔐');
    loadUsers();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Update Bird Age ───────────────────────────────────────────
function openUpdateAge(batchId, batchCode, docDate, ageWeeks) {
  editingAgeBatchId = batchId;
  el('age-batch-id').value = batchId;
  el('age-doc-date').value = docDate ? String(docDate).split('T')[0] : '';
  el('age-weeks-input').value = ageWeeks || '';
  el('age-preview').style.display = 'none';
  const info = el('age-batch-info');
  if (info) info.innerHTML = `
    <strong>${batchCode}</strong> &nbsp;·&nbsp;
    Current DOC: <strong>${docDate ? String(docDate).split('T')[0] : '—'}</strong> &nbsp;·&nbsp;
    Age: <strong>${ageWeeks != null ? ageWeeks + ' weeks' : '—'}</strong>`;
  showModal('modal-age');
}

function calcDocFromWeeks() {
  const weeks = parseInt(el('age-weeks-input')?.value);
  if (!weeks && weeks !== 0) return;
  const doc = new Date();
  doc.setDate(doc.getDate() - weeks * 7);
  const iso = doc.toISOString().split('T')[0];
  el('age-doc-date').value = iso;
  showAgePreview(weeks, iso);
}

function calcWeeksFromDoc() {
  const docVal = el('age-doc-date')?.value;
  if (!docVal) return;
  const weeks = Math.floor((Date.now() - new Date(docVal)) / (7 * 24 * 60 * 60 * 1000));
  el('age-weeks-input').value = weeks >= 0 ? weeks : 0;
  showAgePreview(weeks, docVal);
}

function showAgePreview(weeks, docDate) {
  const p = el('age-preview');
  if (!p) return;
  p.style.display = '';
  p.textContent = `Will set age to ${weeks} week${weeks !== 1 ? 's' : ''} (DOC: ${docDate})`;
}

async function saveAgeUpdate(form) {
  const docDate = el('age-doc-date')?.value;
  if (!docDate) { toast('Please enter a DOC date or age in weeks', 'error'); return; }
  await api('PATCH', `/flock/batches/${editingAgeBatchId}`, { doc_date: docDate });
  hideModal('modal-age');
  toast('Bird age updated!');
  loadFlock();
}

// ── Report Export ─────────────────────────────────────────────
// Snapshot the last loaded report data so exports work offline
let _reportSnapshot = null;

function captureReportSnapshot(pl, prod) { _reportSnapshot = { pl, prod }; }

async function exportPDF() {
  if (!window.jspdf) { toast('PDF library not loaded yet — try again in a moment', 'error'); return; }
  const snap = _reportSnapshot;
  if (!snap) { toast('Load the Reports page first', 'error'); return; }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const year = new Date().getFullYear();
  const org  = currentUser?.org_id ? '' : '';

  // Header
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, 210, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18); doc.setFont('helvetica', 'bold');
  doc.text('FarmIQ — Financial Report', 14, 12);
  doc.setFontSize(10); doc.setFont('helvetica', 'normal');
  doc.text(`Year: ${year}   Generated: ${new Date().toLocaleDateString()}`, 14, 22);

  // P&L Summary
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(13); doc.setFont('helvetica', 'bold');
  doc.text('Profit & Loss Summary', 14, 38);

  const totals = snap.pl.totals || {};
  doc.autoTable({
    startY: 42,
    head: [['Metric', 'Amount (GHS)']],
    body: [
      ['Total Income',   'GHS ' + fmt(totals.income)],
      ['Total Expenses', 'GHS ' + fmt(totals.expenses)],
      ['Net Profit',     'GHS ' + fmt(totals.net_profit)],
      ['Profit Margin',  (totals.margin || 0) + '%'],
    ],
    theme: 'striped',
    headStyles: { fillColor: [22, 163, 74] },
    columnStyles: { 1: { halign: 'right' } },
  });

  // Income Breakdown
  let y = doc.lastAutoTable.finalY + 10;
  doc.setFontSize(12); doc.setFont('helvetica', 'bold');
  doc.text('Income Breakdown', 14, y);
  doc.autoTable({
    startY: y + 4,
    head: [['Category', 'Amount (GHS)']],
    body: (snap.pl.income || []).map(r => [r.category.replace(/_/g,' '), 'GHS ' + fmt(r.total)]),
    theme: 'striped',
    headStyles: { fillColor: [22, 163, 74] },
    columnStyles: { 1: { halign: 'right' } },
  });

  // Expense Breakdown
  y = doc.lastAutoTable.finalY + 10;
  doc.setFontSize(12); doc.setFont('helvetica', 'bold');
  doc.text('Expense Breakdown', 14, y);
  doc.autoTable({
    startY: y + 4,
    head: [['Category', 'Amount (GHS)']],
    body: (snap.pl.expenses || []).map(r => [r.category.replace(/_/g,' '), 'GHS ' + fmt(r.total)]),
    theme: 'striped',
    headStyles: { fillColor: [220, 38, 38] },
    columnStyles: { 1: { halign: 'right' } },
  });

  // Production Summary
  y = doc.lastAutoTable.finalY + 10;
  if (y > 240) { doc.addPage(); y = 20; }
  doc.setFontSize(12); doc.setFont('helvetica', 'bold');
  doc.text('Weekly Egg Production', 14, y);
  doc.autoTable({
    startY: y + 4,
    head: [['Week', 'Total Eggs', 'Saleable', 'Avg Lay Rate']],
    body: (snap.prod.production || []).map(r => [
      fmtDate(r.week), r.total_eggs, r.saleable_eggs,
      r.avg_laying_rate ? (+r.avg_laying_rate).toFixed(1) + '%' : '—',
    ]),
    theme: 'striped',
    headStyles: { fillColor: [202, 138, 4] },
  });

  doc.save(`FarmIQ-Report-${year}.pdf`);
  toast('PDF downloaded!');
}

async function exportExcel() {
  if (!window.XLSX) { toast('Excel library not loaded yet — try again in a moment', 'error'); return; }
  const snap = _reportSnapshot;
  if (!snap) { toast('Load the Reports page first', 'error'); return; }
  const year = new Date().getFullYear();
  const XLSX = window.XLSX;

  const wb = XLSX.utils.book_new();

  // Sheet 1: P&L Summary
  const totals = snap.pl.totals || {};
  const summary = [
    ['FarmIQ Financial Report', year],
    [],
    ['Metric', 'Amount (GHS)'],
    ['Total Income',   +totals.income   || 0],
    ['Total Expenses', +totals.expenses || 0],
    ['Net Profit',     +totals.net_profit || 0],
    ['Profit Margin',  (totals.margin || 0) + '%'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'PL Summary');

  // Sheet 2: Income
  const incomeRows = [['Category', 'Amount (GHS)'],
    ...(snap.pl.income || []).map(r => [r.category.replace(/_/g,' '), +r.total])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(incomeRows), 'Income');

  // Sheet 3: Expenses
  const expRows = [['Category', 'Amount (GHS)'],
    ...(snap.pl.expenses || []).map(r => [r.category.replace(/_/g,' '), +r.total])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(expRows), 'Expenses');

  // Sheet 4: Egg Production
  const prodRows = [['Week', 'Total Eggs', 'Saleable Eggs', 'Avg Laying Rate (%)'],
    ...(snap.prod.production || []).map(r => [
      fmtDate(r.week), +r.total_eggs, +r.saleable_eggs,
      r.avg_laying_rate ? (+r.avg_laying_rate).toFixed(1) : '',
    ])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(prodRows), 'Egg Production');

  XLSX.writeFile(wb, `FarmIQ-Report-${year}.xlsx`);
  toast('Excel downloaded!');
}

// ── Utilities ─────────────────────────────────────────────────
const el = id => document.getElementById(id);
const fdata = form => Object.fromEntries(new FormData(form));
const fmt = n => (+n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = d => d ? String(d).split('T')[0] : '—';

function tbody(id, rows, rowFn, cols, emptyMsg = 'No records yet') {
  const b = el(id);
  if (!b) return;
  if (!rows || !rows.length) {
    b.innerHTML = `<tr><td colspan="${cols}" class="empty"><span class="empty-icon">📭</span>${emptyMsg}</td></tr>`;
    return;
  }
  b.innerHTML = rows.map(r => `<tr>${rowFn(r)}</tr>`).join('');
}

function showModal(id) { el(id)?.classList.remove('hidden'); }
function hideModal(id) { el(id)?.classList.add('hidden'); }

function toast(msg, type = 'success') {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<span>${icons[type]||'✓'}</span><span>${msg}</span>`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function setToday() {
  const today = new Date().toISOString().split('T')[0];
  document.querySelectorAll('input[type=date]').forEach(i => { if (!i.value) i.value = today; });
}

async function ensureBatches() {
  if (!flockBatches.length) {
    const d = await api('GET', '/flock/batches');
    flockBatches = d.batches;
    refreshBatchDropdowns();
  }
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (token && currentUser) {
    loadUserPermissions().finally(() => showApp());
  } else {
    showAuth();
  }

  // Auth tabs
  el('tab-login').onclick = () => {
    el('tab-login').classList.add('active'); el('tab-register').classList.remove('active');
    el('login-form-wrap').classList.remove('hidden'); el('register-form-wrap').classList.add('hidden');
  };
  el('tab-register').onclick = () => {
    el('tab-register').classList.add('active'); el('tab-login').classList.remove('active');
    el('register-form-wrap').classList.remove('hidden'); el('login-form-wrap').classList.add('hidden');
  };

  // Login
  el('login-form').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Signing in…';
    try { await login(e.target.email.value, e.target.password.value); }
    catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Sign In →'; }
  };

  // Register
  el('register-form').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Creating…';
    try { await register(e.target.org_name.value, e.target.full_name.value, e.target.email.value, e.target.password.value, e.target.phone?.value); }
    catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Create Farm Account →'; }
  };

  // Nav
  document.querySelectorAll('.nav-link').forEach(link => {
    link.onclick = () => navigateTo(link.dataset.section);
  });

  el('btn-logout').onclick = logout;

  // Auto-suggest batch code when modal opens
  document.querySelector('[onclick="showModal(\'modal-batch\')"]')
    ?.addEventListener('click', () => setTimeout(suggestBatchCode, 50));

  // Forms
  const formMap = {
    'form-age':          saveAgeUpdate,
    'form-batch':        createBatch,
    'form-pen':          createPen,
    'form-eggs':         logEggs,
    'form-health':       logHealth,
    'form-feed':         logFeedTx,
    'form-income':       createIncome,
    'form-expenditure':  createExpense,
    'form-tx':           createTransaction,
    'form-user':         createUser,
    'form-alert':        createAlert,
  };
  Object.entries(formMap).forEach(([id, fn]) => {
    el(id)?.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = e.target.querySelector('[type=submit]');
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Saving…';
      try { await fn(e.target); }
      catch (err) { toast(err.message, 'error'); }
      finally { btn.disabled = false; btn.textContent = orig; }
    });
  });

  // Close modal on backdrop click
  document.querySelectorAll('.modal').forEach(m => {
    m.onclick = e => { if (e.target === m) m.classList.add('hidden'); };
  });

  setToday();
});
