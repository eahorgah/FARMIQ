'use strict';

// ── HTML escaping — prevents XSS when inserting user content into innerHTML ──
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

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
  if (['super_admin', 'farm_owner'].includes(currentUser.role)) return true;
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

  // Gate nav links by permission
  const isAdmin = ['super_admin','farm_owner'].includes(currentUser?.role);
  const navGates = {
    dashboard:   () => isAdmin || canAccess('dashboard'),
    expenditure: () => canAccess('expenditure'),
    settings:    () => isAdmin,
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

  // Apply farm branding (name + logo) to header immediately after login
  api('GET', '/settings/org').then(({ org }) => applyBranding(org.name, org.logo_url)).catch(() => {});
}
function showAuth() {
  el('auth-page').classList.remove('hidden');
  el('app-page').classList.add('hidden');
}

// ── Navigation ────────────────────────────────────────────────
function navigateTo(section) {
  // Block access to gated sections if user lacks permission
  const isAdmin = ['super_admin', 'farm_owner'].includes(currentUser?.role);
  const accessMap = { dashboard: 'dashboard', expenditure: 'expenditure' };
  if (accessMap[section] && !isAdmin && !canAccess(accessMap[section])) {
    toast('You do not have permission to access this section.', 'error');
    return;
  }

  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.querySelector(`[data-section="${section}"]`)?.classList.add('active');
  document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
  el('section-' + section)?.classList.remove('hidden');
  const loaders = { dashboard: loadDashboard, flock: loadFlock, eggs: filterEggs, health: loadHealth, feed: loadFeed, income: loadIncome, expenditure: loadExpenditure, transactions: loadTransactions, ledger: loadLedger, reports: loadReports, users: loadUsers, alerts: loadAlerts, audit: loadAudit, settings: loadSettings };
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
    const [bd, pd, cd] = await Promise.all([api('GET', '/flock/batches'), api('GET', '/flock/pens'), api('GET', '/flock/culled-pen')]);
    flockBatches = bd.batches;
    loadMortality();

    const canCreate = canAccess('flock', 'create');
    const canEdit   = canAccess('flock', 'edit');

    // Show action buttons only when the user has the right permission
    const show = (id, visible) => { const b = el(id); if (b) b.classList.toggle('hidden', !visible); };
    show('btn-new-pen',       canCreate);
    show('btn-record-deaths', canCreate);
    show('btn-new-batch',     canCreate);

    tbody('batches-tbody', flockBatches, b => {
      const purposeColor = { layers:'b-green', broilers:'b-orange', breeders:'b-purple', dual_purpose:'b-cyan' };
      const statusColor  = { brooding:'b-blue', growing:'b-cyan', laying:'b-green', peak_lay:'b-green', declining:'b-yellow', sold:'b-gray', culled:'b-gray' };
      const ageWks = b.age_weeks != null ? Math.round(b.age_weeks) : null;
      const ageDays = b.doc_date ? Math.floor((Date.now() - new Date(b.doc_date)) / 86400000) : null;
      return `<td><span class="code">${b.batch_code}</span></td>
              <td><strong>${b.breed}</strong></td>
              <td><span class="badge ${purposeColor[b.purpose]||'b-gray'}">${b.purpose}</span></td>
              <td><span class="badge ${statusColor[b.status]||'b-gray'}">${b.status}</span></td>
              <td><strong>${(+b.current_count||0).toLocaleString()}</strong></td>
              <td style="color:var(--red,#ef4444)">${(+b.total_mortalities||0).toLocaleString()}</td>
              <td style="color:var(--orange,#f97316)">${(+b.total_culled||0).toLocaleString()}</td>
              <td style="color:var(--green,#22c55e)">${(+b.total_sold||0).toLocaleString()}</td>
              <td>${ageWks != null ? `<span class="age-badge">${ageWks} wks</span><br><small style="color:var(--gray-400);font-size:10px">${ageDays} days</small>` : '—'}</td>
              <td>${b.pen_name || '—'}</td>
              <td>${b.eggs_last_7d || 0}</td>
              <td style="color:var(--gray-400);font-size:12px">${b.doc_date ? fmtDate(b.doc_date) : '—'}</td>`;
    }, 12, 'No batches yet — create your first batch');

    // Totals row for batch table
    if (flockBatches.length) {
      const totalBirds = flockBatches.reduce((s, b) => s + (+b.current_count || 0), 0);
      const totalDeaths = flockBatches.reduce((s, b) => s + (+b.total_mortalities || 0), 0);
      const totalCulled = flockBatches.reduce((s, b) => s + (+b.total_culled || 0), 0);
      const totalSold   = flockBatches.reduce((s, b) => s + (+b.total_sold || 0), 0);
      const totalEggs7d = flockBatches.reduce((s, b) => s + (+b.eggs_last_7d || 0), 0);
      const tb = el('batches-tbody');
      if (tb) tb.insertAdjacentHTML('beforeend',
        `<tr style="background:#f0fdf4;font-weight:700;border-top:2px solid #bbf7d0">
           <td colspan="4" style="text-align:right;color:var(--gray-500)">TOTAL</td>
           <td>${totalBirds.toLocaleString()}</td>
           <td style="color:var(--red,#ef4444)">${totalDeaths.toLocaleString()}</td>
           <td style="color:var(--orange,#f97316)">${totalCulled.toLocaleString()}</td>
           <td style="color:var(--green,#22c55e)">${totalSold.toLocaleString()}</td>
           <td colspan="3"></td>
           <td>${totalEggs7d.toLocaleString()}</td>
           <td></td>
         </tr>`
      );
    }

    // Inject virtual Culled Pen row
    const cp = cd.culled_pen;
    const culledRow = cp.total_culled > 0
      ? `<tr style="background:#fef9ec">
           <td><strong>🔴 Culled Pen</strong> <span class="badge b-orange" style="font-size:10px;margin-left:4px">virtual</span></td>
           <td>—</td>
           <td>culled</td>
           <td>${cp.batches_with_culled || 0}</td>
           <td><strong>${cp.total_culled}</strong></td>
         </tr>`
      : '';
    tbody('pens-tbody', pd.pens, p =>
      `<td><strong>${p.name}</strong></td>
       <td>${p.capacity}</td>
       <td>${p.pen_type ? p.pen_type.replace(/_/g,' ') : '—'}</td>
       <td>${p.active_batches || 0}</td>
       <td>${p.total_birds || 0}</td>`,
      5, 'No pens yet — create your first pen'
    );
    // Append the culled pen virtual row
    if (culledRow) {
      const tb = document.querySelector('#pens-tbody');
      if (tb) tb.insertAdjacentHTML('beforeend', culledRow);
    }

    el('batch-pen').innerHTML = '<option value="">No pen</option>' +
      pd.pens.map(p => `<option value="${p.id}">${p.name} (cap: ${p.capacity})</option>`).join('');

    refreshBatchDropdowns();
  } catch (e) { toast(e.message, 'error'); }
}

function refreshBatchDropdowns() {
  const eggOpts = '<option value="">Select batch number</option>' +
    flockBatches.map(b => `<option value="${b.id}" data-breed="${b.breed||''}" data-purpose="${b.purpose||''}" data-count="${b.current_count||0}">${b.batch_code}</option>`).join('');
  const healthOpts = '<option value="">Select batch</option>' +
    flockBatches.map(b => `<option value="${b.id}">${b.batch_code} — ${b.breed}</option>`).join('');
  const mortOpts = '<option value="">Select batch</option>' +
    flockBatches.map(b => {
      const soldOut = ['sold','culled'].includes(b.status) ? ' [sold/culled]' : '';
      return `<option value="${b.id}" data-count="${b.current_count||0}">${b.batch_code} — ${b.breed} (${(+b.current_count||0).toLocaleString()} birds)${soldOut}</option>`;
    }).join('');
  const mortFilterOpts = '<option value="">All Batches</option>' +
    flockBatches.map(b => `<option value="${b.id}">${b.batch_code}</option>`).join('');

  const eggSel = el('egg-batch'); if (eggSel) eggSel.innerHTML = eggOpts;
  const hSel = el('health-batch'); if (hSel) hSel.innerHTML = healthOpts;
  const mortSel = el('mort-batch-sel'); if (mortSel) mortSel.innerHTML = mortOpts;
  const mortFilter = el('mort-filter-batch'); if (mortFilter) mortFilter.innerHTML = mortFilterOpts;
}

// ── Mortality / Death Records ──────────────────────────────────
async function loadMortality() {
  try {
    const batchId = el('mort-filter-batch')?.value || '';
    const from    = el('mort-filter-from')?.value  || '';
    const to      = el('mort-filter-to')?.value    || '';
    let qs = '';
    if (batchId) qs += `&batch_id=${batchId}`;
    if (from)    qs += `&date_from=${from}`;
    if (to)      qs += `&date_to=${to}`;

    const data = await api('GET', `/flock/daily-records?limit=200${qs}`);
    const records = data.records || [];

    // Summary stats (last 30 days)
    const today = new Date().toISOString().split('T')[0];
    const d30   = new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const recent = records.filter(r => r.record_date >= d30 || String(r.record_date).split('T')[0] >= d30);
    const todayRecs = records.filter(r => String(r.record_date).split('T')[0] === today);

    const totalDeaths  = recent.reduce((s,r) => s + (+r.mortalities||0), 0);
    const totalCulled  = recent.reduce((s,r) => s + (+r.culled||0), 0);
    const totalSold    = recent.reduce((s,r) => s + (+r.sold||0), 0);
    const todayLoss    = todayRecs.reduce((s,r) => s + (+r.mortalities||0) + (+r.culled||0), 0);

    if (el('mort-stat-total'))  el('mort-stat-total').textContent  = totalDeaths.toLocaleString();
    if (el('mort-stat-culled')) el('mort-stat-culled').textContent = totalCulled.toLocaleString();
    if (el('mort-stat-sold'))   el('mort-stat-sold').textContent   = totalSold.toLocaleString();
    if (el('mort-stat-today'))  el('mort-stat-today').textContent  = todayLoss.toLocaleString();

    tbody('mortality-tbody', records, r => {
      const deaths  = +r.mortalities || 0;
      const culled  = +r.culled      || 0;
      const sold    = +r.sold        || 0;
      const closing = +r.closing_count;
      const opening = +r.opening_count;
      return `
        <td>${fmtDate(r.record_date)}</td>
        <td><span class="code">${r.batch_code||'—'}</span><br><small style="color:var(--gray-400)">${r.breed||''}</small></td>
        <td style="text-align:right">${opening.toLocaleString()}</td>
        <td style="text-align:right;font-weight:700;color:#ef4444">${deaths > 0 ? '-'+deaths.toLocaleString() : '<span style="color:var(--gray-400)">0</span>'}</td>
        <td style="text-align:right;color:#f97316">${culled > 0 ? '-'+culled.toLocaleString() : '<span style="color:var(--gray-400)">0</span>'}</td>
        <td style="text-align:right;color:#3b82f6">${sold > 0 ? sold.toLocaleString() : '<span style="color:var(--gray-400)">0</span>'}</td>
        <td style="text-align:right;font-weight:700;color:#22c55e">${closing.toLocaleString()}</td>
        <td style="max-width:200px;font-size:12px">${r.notes||'—'}</td>
        <td style="font-size:12px;color:var(--gray-400)">${r.recorded_by_name||'—'}</td>`;
    }, 9, 'No death records yet');
  } catch (e) { console.error('loadMortality:', e); }
}

function onMortBatchChange() {
  const sel = el('mort-batch-sel');
  if (!sel || !sel.value) {
    el('mort-count-preview')?.classList.add('hidden');
    return;
  }
  const opt = sel.options[sel.selectedIndex];
  const count = +(opt?.dataset.count || 0);
  el('mort-live-count').textContent = count.toLocaleString();
  el('mort-count-preview')?.classList.remove('hidden');
  updateMortPreview();
}

function updateMortPreview() {
  const sel = el('mort-batch-sel');
  if (!sel?.value) return;
  const opt     = sel.options[sel.selectedIndex];
  const live    = +(opt?.dataset.count || 0);
  const deaths  = +(el('mort-deaths')?.value || 0);
  const culled  = +(el('mort-culled')?.value || 0);
  const sold    = +(el('mort-sold')?.value   || 0);
  const closing = Math.max(0, live - deaths - culled - sold);
  const prev = el('mort-closing-preview');
  if (prev) {
    prev.textContent = closing.toLocaleString() + ' birds';
    prev.style.color = closing === 0 ? '#ef4444' : closing < live * 0.8 ? '#f97316' : '#22c55e';
  }
}

async function saveMortality(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  data.mortalities = +(data.mortalities || 0);
  data.culled      = +(data.culled      || 0);
  data.sold        = +(data.sold        || 0);

  const live  = +(el('mort-batch-sel')?.options[el('mort-batch-sel').selectedIndex]?.dataset.count || 0);
  const total = data.mortalities + data.culled + data.sold;
  if (total === 0) { toast('Enter at least one value (deaths, culled, or sold)', 'error'); return; }
  if (live > 0 && total > live) { toast(`Total losses (${total}) exceed current live count (${live})`, 'error'); return; }

  try {
    await api('POST', '/flock/daily-records', data);
    form.reset();
    // reset date to today
    const d = el('mort-date'); if (d) d.value = new Date().toISOString().split('T')[0];
    el('mort-count-preview')?.classList.add('hidden');
    if (el('mort-closing-preview')) el('mort-closing-preview').textContent = '—';
    hideModal('modal-mortality');
    toast('Death record saved — live count updated');
    loadFlock();
  } catch (err) { toast(err.message, 'error'); }
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

const EGGS_PER_CRATE = 30;

function calcEggsFromCrates() {
  const crates = parseInt(el('egg-crates')?.value) || 0;
  const looseInput = el('egg-loose');
  let loose = parseInt(looseInput?.value) || 0;
  if (loose >= EGGS_PER_CRATE) {
    loose = EGGS_PER_CRATE - 1;
    if (looseInput) looseInput.value = loose;
    toast('Pieces must be less than 30 — add a full crate instead', 'error');
  }
  const total = crates * EGGS_PER_CRATE + loose;
  const inp = el('egg-collected');
  if (inp) inp.value = total;
  calcLayingRate();
}

function toCrates(pieces) {
  const crates = Math.floor(pieces / EGGS_PER_CRATE);
  const loose  = pieces % EGGS_PER_CRATE;
  if (!pieces) return '—';
  return crates > 0 ? `${crates} crate${crates>1?'s':''}${loose ? ` + ${loose}` : ''}` : `${loose} pcs`;
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
  if (el('egg-stat-today'))    el('egg-stat-today').textContent    = toCrates(todayEggs);
  if (el('egg-stat-saleable')) el('egg-stat-saleable').textContent = toCrates(todaySaleable);
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
            <td><strong>${toCrates(collected)}</strong><br><small style="color:var(--gray-400)">${collected} pcs</small></td>
            <td>${broken}</td>
            <td>${toCrates(saleable)}<br><small style="color:var(--gray-400)">${saleable} pcs</small></td>
            <td>${rateCell}</td>`;
  }, 10, 'No egg records yet — log your first collection');

  // Totals row for eggs table
  if (records && records.length) {
    const totCollected = records.reduce((s, r) => s + (+r.eggs_collected || 0), 0);
    const totBroken    = records.reduce((s, r) => s + (+r.broken_eggs   || 0), 0);
    const totSaleable  = totCollected - totBroken;
    const tb = el('eggs-tbody');
    if (tb) tb.insertAdjacentHTML('beforeend',
      `<tr style="background:#f0fdf4;font-weight:700;border-top:2px solid #bbf7d0">
         <td colspan="6" style="text-align:right;color:var(--gray-500)">TOTAL</td>
         <td><strong>${toCrates(totCollected)}</strong><br><small style="color:var(--gray-400)">${totCollected} pcs</small></td>
         <td>${totBroken}</td>
         <td>${toCrates(totSaleable)}<br><small style="color:var(--gray-400)">${totSaleable} pcs</small></td>
         <td></td>
       </tr>`
    );
  }
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
  // Reset crate/loose inputs
  if (el('egg-crates')) el('egg-crates').value = '';
  if (el('egg-loose'))  el('egg-loose').value  = '0';
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
    const canEdit = canAccess('feed', 'edit');

    tbody('inventory-tbody', inv.inventory, i => {
      const stock    = +i.current_stock_kg || 0;
      const minStock = +i.minimum_stock_kg || 0;
      const pct      = minStock > 0 ? Math.min(100, Math.round((stock / minStock) * 100)) : 100;
      const isLow    = i.low_stock_alert;
      const isCrit   = stock === 0;
      const barColor = isCrit ? '#ef4444' : isLow ? '#f97316' : '#22c55e';
      return `
        <td><strong>${i.feed_type.replace(/_/g,' ')}</strong>${i.brand ? `<br><small style="color:var(--gray-400)">${i.brand}</small>` : ''}</td>
        <td>
          <span style="font-size:15px;font-weight:700;color:${isCrit?'#ef4444':isLow?'#f97316':'inherit'}">${stock.toLocaleString()} kg</span>
          <div class="stock-bar-wrap">
            <div class="stock-bar" style="width:${pct}%;background:${barColor}"></div>
          </div>
        </td>
        <td>
          <span class="stock-limit-val">${minStock.toLocaleString()} kg</span>
          ${canEdit ? `<button class="btn btn-outline btn-xs" style="margin-left:6px" onclick="openSetLimit('${i.id}','${i.feed_type}',${minStock},${i.unit_cost_per_kg||0},'${i.brand||''}','${i.supplier||''}')">✏ Edit</button>` : ''}
        </td>
        <td>${i.unit_cost_per_kg ? 'GHS '+fmt(i.unit_cost_per_kg)+'/kg' : '—'}</td>
        <td>${i.supplier||'—'}</td>
        <td>
          ${isCrit
            ? '<span class="badge b-red">🚨 Out of Stock</span>'
            : isLow
              ? '<span class="badge b-orange">⚠ Low Stock</span>'
              : '<span class="badge b-green">✓ OK</span>'}
        </td>`;
    }, 6, 'No inventory — log a purchase first');

    tbody('feed-tx-tbody', txs.transactions, t =>
      `<td>${fmtDate(t.transaction_date)}</td>
       <td><span class="badge ${t.transaction_type==='purchase'?'b-green':'b-orange'}">${t.transaction_type}</span></td>
       <td>${t.feed_type.replace(/_/g,' ')}</td>
       <td>${(+t.quantity_kg||0).toLocaleString()} kg</td>
       <td>${t.total_cost ? 'GHS '+fmt(t.total_cost) : '—'}</td>
       <td>${t.supplier||'—'}</td>`,
      6
    );
  } catch (e) { toast(e.message, 'error'); }
}

function openSetLimit(id, feedType, currentMin, unitCost, brand, supplier) {
  el('limit-inv-id').value        = id;
  el('limit-feed-type').textContent = feedType.replace(/_/g,' ');
  el('limit-min-stock').value     = currentMin || '';
  el('limit-unit-cost').value     = unitCost   || '';
  el('limit-brand').value         = brand      || '';
  el('limit-supplier').value      = supplier   || '';
  showModal('modal-stock-limit');
}

async function saveStockLimit(e) {
  e.preventDefault();
  const id       = el('limit-inv-id').value;
  const minStock = el('limit-min-stock').value;
  const unitCost = el('limit-unit-cost').value;
  const brand    = el('limit-brand').value;
  const supplier = el('limit-supplier').value;
  try {
    await api('PATCH', `/feed/inventory/${id}`, {
      minimum_stock_kg: +minStock,
      unit_cost_per_kg: unitCost ? +unitCost : null,
      brand:    brand    || null,
      supplier: supplier || null,
    });
    hideModal('modal-stock-limit');
    toast('Order limit updated!');
    loadFeed();
  } catch (err) { toast(err.message, 'error'); }
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

async function onIncomeCategoryChange() {
  const cat = el('income-category')?.value;
  const block = el('sale-details-block');
  if (!block) return;
  const isProduct = PRODUCT_CATEGORIES.includes(cat);
  block.style.display = isProduct ? '' : 'none';

  // Show egg type dropdown only for egg sales
  const eggTypeGroup = el('egg-type-group');
  if (eggTypeGroup) eggTypeGroup.style.display = cat === 'egg_sales' ? '' : 'none';

  // Fetch egg inventory and populate stock hints
  if (cat === 'egg_sales') {
    try {
      const { inventory } = await api('GET', '/eggs/inventory');
      const eggSel = el('income-egg-type');
      const hint   = el('egg-stock-hint');
      const byType = {};
      inventory.forEach(r => { byType[r.egg_type] = r; });
      if (eggSel) {
        eggSel.innerHTML = '<option value="">Select egg type</option>' +
          ['jumbo','extra_large','large','medium','pullet'].map(t => {
            const inv = byType[t];
            const avail = inv ? +inv.available : 0;
            const label = t.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());
            return `<option value="${t}" ${avail <= 0 ? 'disabled' : ''}>${label} — ${toCrates(avail)} available</option>`;
          }).join('');
        eggSel.onchange = () => {
          const inv = byType[eggSel.value];
          if (hint) hint.textContent = inv ? `Available: ${toCrates(+inv.available)} (${inv.available} pcs)` : '';
        };
      }
    } catch { /* non-blocking */ }
  }

  // Auto-set unit
  const unitSel = el('income-unit');
  if (unitSel && CATEGORY_UNIT_MAP[cat]) unitSel.value = CATEGORY_UNIT_MAP[cat];

  // Batch selector hint
  const batchHint = el('income-batch-hint');
  if (batchHint) batchHint.textContent = BIRD_CATEGORIES.includes(cat) ? '(required — birds deducted from batch)' : '(optional)';

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
      _receiptMap[t.id] = t;
      const hasQty = t.sale_qty && t.sale_unit;
      const eggTypeLabel = t.sale_egg_type ? t.sale_egg_type.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()) : '—';
      return `<td>${fmtDate(t.transaction_date)}</td>
       <td>${t.category.replace(/_/g,' ')}</td>
       <td style="font-size:12px">${t.category === 'egg_sales' ? eggTypeLabel : '—'}</td>
       <td style="font-size:12px">${hasQty ? `${t.sale_qty} ${t.sale_unit}` : '—'}</td>
       <td style="font-size:12px">${t.sale_unit_price ? 'GHS '+fmt(t.sale_unit_price) : '—'}</td>
       <td><strong class="amount-positive">GHS ${fmt(t.amount)}</strong></td>
       <td>${t.counterparty_name || '—'}</td>
       <td><span class="badge ${sColor[t.approval_status]||'b-gray'}">${t.approval_status}</span></td>
       <td><button class="btn btn-outline btn-xs" onclick="printReceipt(_receiptMap['${t.id}'])">🧾 Receipt</button></td>`;
    }, 8, 'No income recorded yet — add your first income entry');
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

async function printReceipt(t) {
  let org = { name: 'FarmIQ', address: '', phone: '', email: '', logo_url: '', region: '', country: '' };
  try { const d = await api('GET', '/settings/org'); org = { ...org, ...d.org }; } catch {}

  const effectiveLogo = org.logo_url || _logoDataUrl || '';

  const logoHtml = effectiveLogo
    ? `<img src="${effectiveLogo}" alt="logo" style="max-height:72px;max-width:180px;object-fit:contain;margin-bottom:8px"/>`
    : `<div style="font-size:42px;margin-bottom:8px">🌱</div>`;

  const watermarkStyle = effectiveLogo
    ? `background-image:url('${effectiveLogo}');background-repeat:no-repeat;background-position:center center;background-size:260px 260px;`
    : '';

  const addressLines = [org.address, org.region, org.country].filter(Boolean).join(', ');
  const contactLines = [org.phone ? `Tel: ${org.phone}` : '', org.email ? `Email: ${org.email}` : ''].filter(Boolean).join('  |  ');

  const hasQty = t.sale_qty && t.sale_unit && t.sale_unit_price;
  const itemsHtml = hasQty
    ? `<tr>
         <td>${(t.category||'').replace(/_/g,' ')}</td>
         <td style="text-align:center">${t.sale_qty} ${t.sale_unit}</td>
         <td style="text-align:right">GHS ${fmt(t.sale_unit_price)}</td>
         <td style="text-align:right"><strong>GHS ${fmt(t.amount)}</strong></td>
       </tr>`
    : `<tr>
         <td colspan="3">${t.description}</td>
         <td style="text-align:right"><strong>GHS ${fmt(t.amount)}</strong></td>
       </tr>`;

  const statusColor = { approved:'#16a34a', pending:'#d97706', rejected:'#dc2626' };
  const sColor = statusColor[t.approval_status] || '#6b7280';
  const paid = t.approval_status === 'approved';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
  <title>Receipt ${t.transaction_ref||''}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'Inter',Arial,sans-serif; background:#e5e7eb; display:flex; justify-content:center; align-items:flex-start; padding:32px 12px; min-height:100vh; }
    .receipt {
      position:relative; overflow:hidden;
      background:#fff; width:460px; padding:36px 32px 28px;
      border-radius:16px; box-shadow:0 4px 32px rgba(0,0,0,.15);
    }
    /* Watermark layer */
    .receipt::before {
      content:''; position:absolute; inset:0; z-index:0;
      ${watermarkStyle}
      opacity:0.06; pointer-events:none;
    }
    .receipt > * { position:relative; z-index:1; }
    /* Header */
    .header { text-align:center; padding-bottom:20px; margin-bottom:20px; border-bottom:2px solid #e5e7eb; }
    .company-name { font-size:24px; font-weight:800; color:#111; margin-bottom:3px; }
    .company-meta { font-size:12px; color:#6b7280; line-height:1.7; margin-top:4px; }
    .badge-title { display:inline-block; background:#16a34a; color:#fff; font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; padding:4px 16px; border-radius:20px; margin:14px 0 6px; }
    .ref { font-size:11px; color:#9ca3af; letter-spacing:.04em; }
    /* Meta rows */
    .meta { margin-bottom:16px; }
    .meta-row { display:flex; justify-content:space-between; align-items:center; font-size:13px; padding:6px 0; border-bottom:1px solid #f3f4f6; }
    .meta-row .lbl { color:#6b7280; }
    .meta-row .val { font-weight:600; color:#111; text-align:right; }
    .status-badge { display:inline-block; padding:2px 10px; border-radius:20px; font-size:11px; font-weight:700; color:#fff; background:${sColor}; }
    /* Items table */
    table { width:100%; border-collapse:collapse; font-size:13px; margin:16px 0 8px; }
    thead th { background:#f9fafb; padding:9px 6px; text-align:left; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:#6b7280; border-bottom:2px solid #e5e7eb; }
    thead th:nth-child(2) { text-align:center; }
    thead th:nth-child(3), thead th:nth-child(4) { text-align:right; }
    tbody td { padding:9px 6px; border-bottom:1px solid #f3f4f6; color:#374151; }
    tbody td:nth-child(2) { text-align:center; }
    tbody td:nth-child(3), tbody td:nth-child(4) { text-align:right; }
    .total-row td { padding:12px 6px; font-weight:700; font-size:15px; border-top:2px solid #e5e7eb; border-bottom:none; }
    .total-row td:last-child { color:#16a34a; font-size:17px; }
    /* Footer */
    .footer { text-align:center; margin-top:20px; padding-top:16px; border-top:1px dashed #d1d5db; font-size:11px; color:#9ca3af; line-height:2; }
    .paid-stamp {
      display:inline-block; border:3px solid #16a34a; color:#16a34a;
      font-size:22px; font-weight:800; letter-spacing:.15em; padding:4px 18px;
      border-radius:6px; transform:rotate(-8deg); margin:10px 0 6px;
      text-transform:uppercase; opacity:.85;
    }
    /* Print */
    @media print {
      body { background:#fff; padding:0; }
      .receipt { box-shadow:none; border-radius:0; width:100%; }
      .no-print { display:none !important; }
    }
  </style></head>
  <body>
  <div class="receipt">
    <div class="header">
      ${logoHtml}
      <div class="company-name">${org.name}</div>
      <div class="company-meta">
        ${addressLines ? `<div>${addressLines}</div>` : ''}
        ${contactLines ? `<div>${contactLines}</div>` : ''}
      </div>
      <div class="badge-title">Sales Receipt</div><br/>
      <div class="ref"># ${t.transaction_ref || 'N/A'}</div>
    </div>

    <div class="meta">
      <div class="meta-row"><span class="lbl">Date</span><span class="val">${fmtDate(t.transaction_date)}</span></div>
      ${t.counterparty_name ? `<div class="meta-row"><span class="lbl">Customer</span><span class="val">${t.counterparty_name}</span></div>` : ''}
      ${t.counterparty_phone ? `<div class="meta-row"><span class="lbl">Phone</span><span class="val">${t.counterparty_phone}</span></div>` : ''}
      ${t.invoice_number ? `<div class="meta-row"><span class="lbl">Invoice #</span><span class="val">${t.invoice_number}</span></div>` : ''}
      <div class="meta-row"><span class="lbl">Payment Method</span><span class="val">${(t.payment_method||'cash').replace(/_/g,' ')}</span></div>
      <div class="meta-row"><span class="lbl">Status</span><span class="val"><span class="status-badge">${t.approval_status}</span></span></div>
    </div>

    <table>
      <thead><tr>
        <th>Description</th><th>Qty</th><th>Unit Price</th><th>Amount</th>
      </tr></thead>
      <tbody>
        ${itemsHtml}
        <tr class="total-row">
          <td colspan="3" style="text-align:right;color:#6b7280;font-size:13px;font-weight:600">TOTAL</td>
          <td>GHS ${fmt(t.amount)}</td>
        </tr>
      </tbody>
    </table>

    ${t.description && hasQty ? `<div style="font-size:12px;color:#6b7280;margin-bottom:10px">Note: ${t.description}</div>` : ''}

    <div style="text-align:center;margin:14px 0 4px">
      ${paid ? `<div class="paid-stamp">PAID</div>` : `<div style="font-size:12px;color:#d97706;font-weight:600">⏳ Pending Approval</div>`}
    </div>

    <div class="footer">
      Thank you for your business!<br/>
      ${org.name}${addressLines ? ' · ' + addressLines : ''}<br/>
      Generated: ${new Date().toLocaleString()}
    </div>

    <div class="no-print" style="text-align:center;margin-top:24px;display:flex;gap:10px;justify-content:center">
      <button onclick="window.print()" style="background:#16a34a;color:#fff;border:none;padding:11px 30px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px">🖨 Print / Save PDF</button>
      <button onclick="window.close()" style="background:#f3f4f6;color:#374151;border:1px solid #e5e7eb;padding:11px 22px;border-radius:8px;font-size:14px;cursor:pointer">Close</button>
    </div>
  </div>
  </body></html>`;

  const w = window.open('', '_blank', 'width=560,height=800,scrollbars=yes');
  w.document.write(html);
  w.document.close();
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
function switchReportTab(tab) {
  document.querySelectorAll('.rpt-tab').forEach((btn, i) => {
    const tabs = ['financial','transactions','eggs','flock','health','feed'];
    btn.classList.toggle('active', tabs[i] === tab);
  });
  ['financial','transactions','eggs','flock','health','feed'].forEach(t => {
    const panel = el('rpt-tab-' + t);
    if (panel) panel.classList.toggle('hidden', t !== tab);
  });
}

async function loadReports() {
  // Year filter
  const yearSel = el('rpt-year');
  if (yearSel && !yearSel.options.length) {
    const cur = new Date().getFullYear();
    for (let y = cur; y >= cur - 4; y--) {
      const o = document.createElement('option'); o.value = y; o.textContent = y;
      yearSel.appendChild(o);
    }
  }
  const year  = yearSel?.value || new Date().getFullYear();
  const month = el('rpt-month')?.value || '';
  const qs    = `year=${year}${month ? '&month=' + month : ''}`;
  const dateFrom = month ? `${year}-${String(month).padStart(2,'0')}-01` : `${year}-01-01`;
  const dateTo   = month
    ? `${year}-${String(month).padStart(2,'0')}-${new Date(year, month, 0).getDate()}`
    : `${year}-12-31`;

  try {
    const [pl, prod, txData, eggsData, flockData, healthData, feedData] = await Promise.all([
      api('GET', `/reports/profit-loss?${qs}`),
      api('GET', `/reports/production-summary?${qs}`),
      api('GET', `/transactions/export?date_from=${dateFrom}&date_to=${dateTo}`),
      api('GET', `/eggs?date_from=${dateFrom}&date_to=${dateTo}`),
      api('GET', `/flock/batches`),
      api('GET', `/health`),
      api('GET', `/feed/transactions`),
    ]);

    _reportSnapshot = { pl, prod, txData, eggsData, flockData, healthData, feedData, year, month };

    // ── Summary stats ──
    el('pl-income').textContent   = 'GHS ' + fmt(pl.totals.income);
    el('pl-expenses').textContent = 'GHS ' + fmt(pl.totals.expenses);
    el('pl-profit').textContent   = 'GHS ' + fmt(pl.totals.net_profit);
    el('pl-margin').textContent   = pl.totals.margin + '%';

    // ── Financial tab ──
    tbody('pl-income-tbody', pl.income, r =>
      `<td>${r.category.replace(/_/g,' ')}</td><td style="color:var(--gray-400)">${r.count}</td><td><strong>GHS ${fmt(r.total)}</strong></td>`, 3, 'No income recorded');
    tbody('pl-expense-tbody', pl.expenses, r =>
      `<td>${r.category.replace(/_/g,' ')}</td><td style="color:var(--gray-400)">${r.count}</td><td><strong>GHS ${fmt(r.total)}</strong></td>`, 3, 'No expenses recorded');
    tbody('prod-tbody', prod.production, r =>
      `<td>${fmtDate(r.week)}</td><td>${(+r.total_eggs||0).toLocaleString()}</td><td>${(+r.saleable_eggs||0).toLocaleString()}</td>
       <td>${r.avg_laying_rate ? (+r.avg_laying_rate).toFixed(1)+'%' : '—'}</td>`, 4, 'No production data');

    // ── Transactions tab ──
    const txs = txData.transactions || [];
    const sColor = { approved:'b-green', pending:'b-yellow', rejected:'b-red', flagged:'b-orange' };
    const tColor = { income:'b-green', expense:'b-red' };
    if (el('rpt-tx-count')) el('rpt-tx-count').textContent = `${txs.length} records`;
    tbody('rpt-tx-tbody', txs, r =>
      `<td>${fmtDate(r.transaction_date)}</td>
       <td><span class="code">${r.transaction_ref||'—'}</span></td>
       <td><span class="badge ${tColor[r.type]||'b-gray'}">${r.type}</span></td>
       <td>${(r.category||'').replace(/_/g,' ')}</td>
       <td style="max-width:200px">${r.description||'—'}</td>
       <td>${r.counterparty_name||'—'}</td>
       <td>${r.payment_method||'—'}</td>
       <td style="font-weight:700;color:${r.type==='income'?'#15803d':'#b91c1c'}">GHS ${fmt(r.amount)}</td>
       <td><span class="badge ${sColor[r.approval_status]||'b-gray'}">${r.approval_status||'—'}</span></td>`,
      9, 'No transactions in this period');

    // ── Eggs tab ──
    const eggs = eggsData.records || [];
    const etColors = { jumbo:'b-purple', extra_large:'b-blue', large:'b-cyan', medium:'b-green', pullet:'b-yellow' };
    const etLabels = { jumbo:'Jumbo', extra_large:'Extra Large', large:'Large', medium:'Medium', pullet:'Pullet' };
    if (el('rpt-eggs-count')) el('rpt-eggs-count').textContent = `${eggs.length} records`;
    tbody('rpt-eggs-tbody', eggs, r =>
      `<td>${fmtDate(r.record_date)}</td>
       <td><strong>${r.batch_code||'—'}</strong></td>
       <td>${r.egg_type ? `<span class="badge ${etColors[r.egg_type]||'b-gray'}">${etLabels[r.egg_type]||r.egg_type}</span>` : '—'}</td>
       <td>${(+r.eggs_collected||0).toLocaleString()}</td>
       <td>${+r.broken_eggs||0}</td>
       <td>${(+r.saleable_eggs||0).toLocaleString()}</td>
       <td>${r.laying_rate ? `<span class="badge ${+r.laying_rate>=70?'b-green':+r.laying_rate>=50?'b-yellow':'b-red'}">${(+r.laying_rate).toFixed(1)}%</span>` : '—'}</td>`,
      7, 'No egg records in this period');

    // Totals row for report eggs table
    if (eggs.length) {
      const rptTotCollected = eggs.reduce((s, r) => s + (+r.eggs_collected || 0), 0);
      const rptTotBroken    = eggs.reduce((s, r) => s + (+r.broken_eggs   || 0), 0);
      const rptTotSaleable  = eggs.reduce((s, r) => s + (+r.saleable_eggs || 0), 0);
      const rptEggTb = el('rpt-eggs-tbody');
      if (rptEggTb) rptEggTb.insertAdjacentHTML('beforeend',
        `<tr style="background:#f0fdf4;font-weight:700;border-top:2px solid #bbf7d0">
           <td colspan="3" style="text-align:right;color:var(--gray-500)">TOTAL</td>
           <td>${toCrates(rptTotCollected)}<br><small style="color:var(--gray-400);font-weight:400">${rptTotCollected} pcs</small></td>
           <td>${rptTotBroken}</td>
           <td>${toCrates(rptTotSaleable)}<br><small style="color:var(--gray-400);font-weight:400">${rptTotSaleable} pcs</small></td>
           <td></td>
         </tr>`
      );
    }

    // ── Flock tab ──
    const batches = flockData.batches || [];
    const pColor  = { layers:'b-green', broilers:'b-orange', breeders:'b-purple', dual_purpose:'b-cyan' };
    const stColor = { brooding:'b-blue', growing:'b-cyan', laying:'b-green', peak_lay:'b-green', declining:'b-yellow', sold:'b-gray', culled:'b-gray' };
    tbody('rpt-flock-tbody', batches, b =>
      `<td><span class="code">${b.batch_code}</span></td>
       <td>${b.breed||'—'}</td>
       <td><span class="badge ${pColor[b.purpose]||'b-gray'}">${(b.purpose||'').replace(/_/g,' ')}</span></td>
       <td><span class="badge ${stColor[b.status]||'b-gray'}">${b.status||'—'}</span></td>
       <td><strong>${(+b.current_count||0).toLocaleString()}</strong></td>
       <td>${b.age_weeks != null ? Math.round(b.age_weeks)+' wks' : '—'}</td>
       <td>${b.pen_name||'—'}</td>
       <td>${fmtDate(b.doc_date)}</td>`,
      8, 'No batches found');

    // Totals row for report flock table
    if (batches.length) {
      const rptTotalBirds = batches.reduce((s, b) => s + (+b.current_count || 0), 0);
      const rptTb = el('rpt-flock-tbody');
      if (rptTb) rptTb.insertAdjacentHTML('beforeend',
        `<tr style="background:#f0fdf4;font-weight:700;border-top:2px solid #bbf7d0">
           <td colspan="4" style="text-align:right;color:var(--gray-500)">TOTAL</td>
           <td>${rptTotalBirds.toLocaleString()}</td>
           <td colspan="3"></td>
         </tr>`
      );
    }

    // ── Health tab ──
    const health = healthData.records || [];
    const sevColor = { low:'b-green', medium:'b-yellow', high:'b-orange', critical:'b-red' };
    const staColor = { completed:'b-green', ongoing:'b-orange', monitoring:'b-blue' };
    if (el('rpt-health-count')) el('rpt-health-count').textContent = `${health.length} records`;
    tbody('rpt-health-tbody', health, r =>
      `<td>${fmtDate(r.event_date)}</td>
       <td>${r.batch_code||'—'}</td>
       <td>${(r.event_type||'').replace(/_/g,' ')}</td>
       <td>${r.diagnosis||'—'}</td>
       <td><span class="badge ${sevColor[r.severity]||'b-gray'}">${r.severity||'—'}</span></td>
       <td>${r.affected_count||'—'}</td>
       <td>${r.mortality_count||0}</td>
       <td><span class="badge ${staColor[r.status]||'b-gray'}">${r.status||'—'}</span></td>
       <td>${r.veterinarian_name||'—'}</td>`,
      9, 'No health records');

    // ── Feed tab ──
    const feed = feedData.transactions || [];
    if (el('rpt-feed-count')) el('rpt-feed-count').textContent = `${feed.length} records`;
    tbody('rpt-feed-tbody', feed, r =>
      `<td>${fmtDate(r.transaction_date)}</td>
       <td>${r.feed_type||'—'}</td>
       <td><span class="badge ${r.transaction_type==='purchase'?'b-blue':r.transaction_type==='usage'?'b-orange':'b-gray'}">${r.transaction_type||'—'}</span></td>
       <td>${(+r.quantity_kg||0).toLocaleString()} kg</td>
       <td>${r.cost ? 'GHS '+fmt(r.cost) : '—'}</td>
       <td>${r.batch_code||'—'}</td>
       <td>${r.recorded_by_name||'—'}</td>`,
      7, 'No feed transactions');

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
        <div class="alert-card-title">${esc(a.title)}</div>
        <span class="badge b-gray" style="font-size:10px;text-transform:uppercase">${esc(a.category)}</span>
      </div>
      <div class="alert-card-msg">${esc(a.message)}</div>
      <div class="alert-card-foot">
        <span style="color:var(--gray-400);font-size:11px">By ${esc(a.created_by_name || '—')} · ${fmtDate(a.created_at)}</span>
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
       <td><span class="badge ${sColor[a.severity]||'b-gray'}">${esc(a.severity)}</span></td>
       <td style="font-weight:600;max-width:260px">${esc(a.title)}</td>
       <td><span class="badge b-gray">${esc(a.category)}</span></td>
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

// ── Settings ──────────────────────────────────────────────────
const MONTH_NAMES = ['','January','February','March','April','May','June','July','August','September','October','November','December'];

let _logoDataUrl = null; // holds the base64 data URL of the selected logo
const _receiptMap = {}; // id → transaction object, avoids JSON injection in onclick

function applyBranding(name, logoUrl) {
  if (logoUrl) _logoDataUrl = logoUrl;
  const nameEl = el('header-farm-name');
  const iconEl = el('header-icon');
  if (nameEl && name) nameEl.textContent = name;
  if (iconEl) {
    if (logoUrl) {
      iconEl.innerHTML = `<img src="${logoUrl}" alt="logo" style="height:32px;width:32px;border-radius:8px;object-fit:contain;background:#fff;padding:2px"/>`;
    } else {
      iconEl.textContent = '🌱';
    }
  }
}

function handleLogoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 500 * 1024) {
    toast('Image too large — maximum 500 KB', 'error');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    _logoDataUrl = e.target.result;
    const wrap = el('logo-preview-wrap');
    const img  = el('logo-preview-img');
    const placeholder = el('logo-upload-placeholder');
    const nameEl = el('logo-file-name');
    const removeBtn = el('logo-remove-btn');
    if (img)  img.src = _logoDataUrl;
    if (wrap) wrap.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
    if (nameEl) nameEl.textContent = file.name;
    if (removeBtn) removeBtn.style.display = 'inline-block';
    updateOrgPreview();
  };
  reader.readAsDataURL(file);
}

function clearLogo() {
  _logoDataUrl = null;
  const input = el('logo-file-input');
  if (input) input.value = '';
  const wrap = el('logo-preview-wrap');
  const placeholder = el('logo-upload-placeholder');
  const removeBtn = el('logo-remove-btn');
  if (wrap) wrap.style.display = 'none';
  if (placeholder) placeholder.style.display = 'block';
  if (removeBtn) removeBtn.style.display = 'none';
  updateOrgPreview();
}

function previewLogo(dataUrl) {
  if (!dataUrl) { clearLogo(); return; }
  _logoDataUrl = dataUrl;
  const wrap = el('logo-preview-wrap');
  const img  = el('logo-preview-img');
  const placeholder = el('logo-upload-placeholder');
  const removeBtn = el('logo-remove-btn');
  if (img)  img.src = dataUrl;
  if (wrap) wrap.style.display = 'block';
  if (placeholder) placeholder.style.display = 'none';
  if (removeBtn) removeBtn.style.display = 'inline-block';
  updateOrgPreview();
}

function updateOrgPreview() {
  const name    = el('org-name')?.value || '—';
  const country = el('org-country')?.value || '';
  const region  = el('org-region')?.value  || '';
  const phone   = el('org-phone')?.value   || '';
  const email   = el('org-email')?.value   || '';
  const address = el('org-address')?.value || '';

  if (el('org-preview-name'))    el('org-preview-name').textContent    = name;
  if (el('org-preview-country')) el('org-preview-country').textContent = [region, country].filter(Boolean).join(', ') || '—';

  const logoWrap = el('org-preview-logo');
  if (logoWrap) {
    if (_logoDataUrl) {
      logoWrap.innerHTML = `<img src="${_logoDataUrl}" alt="Logo"
        style="max-height:72px;max-width:160px;border-radius:12px;object-fit:contain;border:1px solid var(--gray-200);padding:6px;background:#fff"/>`;
    } else {
      logoWrap.innerHTML = `<div style="width:72px;height:72px;background:linear-gradient(135deg,#16a34a,#15803d);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;font-size:32px">🌱</div>`;
    }
  }

  const details = el('org-preview-details');
  if (details) {
    const rows = [
      phone   ? `📞 ${phone}`   : '',
      email   ? `✉️ ${email}`   : '',
      address ? `📍 ${address}` : '',
    ].filter(Boolean);
    details.innerHTML = rows.join('<br>') || '<span style="color:var(--gray-300)">No contact details yet</span>';
  }
}

async function loadOrgSettings() {
  try {
    const { org } = await api('GET', '/settings/org');
    if (el('org-name'))     el('org-name').value     = org.name     || '';
    if (el('org-phone'))    el('org-phone').value    = org.phone    || '';
    if (el('org-email'))    el('org-email').value    = org.email    || '';
    if (el('org-address'))  el('org-address').value  = org.address  || '';
    if (el('org-region'))   el('org-region').value   = org.region   || '';
    if (el('org-country'))  el('org-country').value  = org.country  || '';
    if (el('org-currency')) el('org-currency').value = org.currency || 'GHS';
    previewLogo(org.logo_url || '');
    updateOrgPreview();
    applyBranding(org.name, org.logo_url);

    // Wire live preview updates
    ['org-name','org-country','org-region','org-phone','org-email','org-address'].forEach(id => {
      el(id)?.addEventListener('input', updateOrgPreview);
    });
  } catch (e) { /* non-blocking */ }
}

async function saveOrgSettings(e) {
  e.preventDefault();
  const btn = e.target.querySelector('[type=submit]');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const body = {
      name:     el('org-name')?.value.trim()    || undefined,
      logo_url: _logoDataUrl,
      phone:    el('org-phone')?.value.trim()   || null,
      email:    el('org-email')?.value.trim()   || null,
      address:  el('org-address')?.value.trim() || null,
      region:   el('org-region')?.value.trim()  || null,
      country:  el('org-country')?.value.trim() || undefined,
      currency: el('org-currency')?.value       || undefined,
    };
    await api('PUT', '/settings/org', body);
    toast('Farm profile updated', 'success');
    updateOrgPreview();
    applyBranding(body.name, body.logo_url);
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

async function loadSettings() {
  loadOrgSettings();
  try {
    const { settings } = await api('GET', '/settings/finance');
    const s = settings;

    // Populate form
    if (el('setting-threshold')) el('setting-threshold').value = s.approval_threshold ?? 500;
    if (el('setting-fiscal'))    el('setting-fiscal').value    = s.fiscal_year_start   ?? 1;
    if (el('setting-tax'))       el('setting-tax').value       = s.tax_rate            ?? 0;

    // Auto-approve role checkboxes
    const autoRoles = s.auto_approve_roles || ['farm_owner'];
    document.querySelectorAll('#auto-approve-roles input[type=checkbox]:not([disabled])').forEach(cb => {
      cb.checked = autoRoles.includes(cb.value);
    });

    // Update live preview on threshold input
    updateThresholdPreview(s.approval_threshold ?? 500);
    el('setting-threshold')?.addEventListener('input', function() { updateThresholdPreview(+this.value); });

    // Summary panel
    const threshold = +s.approval_threshold || 500;
    if (el('sum-threshold')) el('sum-threshold').textContent = `GHS ${fmt(threshold)}`;
    if (el('sum-roles'))     el('sum-roles').textContent     = autoRoles.join(', ') || 'None';
    if (el('sum-fiscal'))    el('sum-fiscal').textContent    = MONTH_NAMES[+s.fiscal_year_start || 1];
    if (el('sum-tax'))       el('sum-tax').textContent       = (s.tax_rate || 0) + '%';

    const ruleBox = el('sum-rule-box');
    const ruleText = el('sum-rule-text');
    if (ruleText) {
      ruleText.innerHTML = threshold === 0
        ? '⚠ <strong>All transactions</strong> require approval regardless of amount.'
        : `Transactions above <strong>GHS ${fmt(threshold)}</strong> need approval unless the user is in an auto-approved role.`;
    }
    if (ruleBox) ruleBox.className = `settings-rule-box ${threshold === 0 ? 'rule-warn' : 'rule-info'}`;

  } catch (e) { toast(e.message, 'error'); }
}

function updateThresholdPreview(val) {
  const p = el('threshold-preview');
  if (!p) return;
  if (val === 0) {
    p.textContent  = 'All transactions will require approval.';
    p.className    = 'settings-preview settings-preview-warn';
  } else {
    p.textContent  = `Transactions above GHS ${fmt(val)} need approval.`;
    p.className    = 'settings-preview settings-preview-info';
  }
}

async function saveFinanceSettings(e) {
  e.preventDefault();
  const threshold = +(el('setting-threshold')?.value ?? 500);
  const fiscal    = +(el('setting-fiscal')?.value ?? 1);
  const tax       = +(el('setting-tax')?.value ?? 0);

  const autoRoles = Array.from(
    document.querySelectorAll('#auto-approve-roles input[type=checkbox]:checked')
  ).map(cb => cb.value);

  // Always include super_admin
  if (!autoRoles.includes('super_admin')) autoRoles.unshift('super_admin');

  try {
    await api('PUT', '/settings/finance', {
      approval_threshold: threshold,
      auto_approve_roles: autoRoles,
      fiscal_year_start:  fiscal,
      tax_rate:           tax,
    });
    toast('Settings saved!');
    loadSettings();
  } catch (err) { toast(err.message, 'error'); }
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
let _reportSnapshot = null;

function _pdfSectionHeader(doc, title, y, color) {
  if (y > 255) { doc.addPage(); y = 20; }
  doc.setFillColor(...color);
  doc.rect(0, y - 6, 210, 10, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11); doc.setFont('helvetica', 'bold');
  doc.text(title, 14, y);
  doc.setTextColor(0, 0, 0);
  return y + 4;
}

async function exportPDF() {
  if (!window.jspdf) { toast('PDF library not loaded — try again in a moment', 'error'); return; }
  const snap = _reportSnapshot;
  if (!snap) { toast('Load the Reports page first', 'error'); return; }

  const { jsPDF } = window.jspdf;
  const doc  = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const { year, month } = snap;
  const period = month ? `${year}-${String(month).padStart(2,'0')}` : String(year);
  const genDate = new Date().toLocaleDateString('en-GH', { dateStyle: 'long' });

  const addHeader = (doc) => {
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, 297, 18, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(14); doc.setFont('helvetica', 'bold');
    doc.text('FarmIQ — Comprehensive Farm Report', 14, 11);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text(`Period: ${period}   |   Generated: ${genDate}`, 190, 11, { align: 'right' });
    doc.setTextColor(0, 0, 0);
  };

  addHeader(doc);

  // ── 1. P&L Summary ──────────────────────────────────────────
  const totals = snap.pl.totals || {};
  let y = _pdfSectionHeader(doc, '1. Profit & Loss Summary', 28, [22, 163, 74]);
  doc.autoTable({
    startY: y,
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
    margin: { left: 14, right: 14 },
    tableWidth: 120,
  });

  // ── 2. Income Breakdown ──────────────────────────────────────
  y = doc.lastAutoTable.finalY + 10;
  y = _pdfSectionHeader(doc, '2. Income Breakdown', y, [22, 163, 74]);
  doc.autoTable({
    startY: y,
    head: [['Category', 'Transactions', 'Amount (GHS)']],
    body: (snap.pl.income || []).map(r => [r.category.replace(/_/g,' '), r.count, 'GHS ' + fmt(r.total)]),
    theme: 'striped',
    headStyles: { fillColor: [22, 163, 74] },
    columnStyles: { 1: { halign: 'center' }, 2: { halign: 'right' } },
    margin: { left: 14, right: 14 },
    tableWidth: 160,
  });

  // ── 3. Expense Breakdown ─────────────────────────────────────
  y = doc.lastAutoTable.finalY + 10;
  y = _pdfSectionHeader(doc, '3. Expense Breakdown', y, [220, 38, 38]);
  doc.autoTable({
    startY: y,
    head: [['Category', 'Transactions', 'Amount (GHS)']],
    body: (snap.pl.expenses || []).map(r => [r.category.replace(/_/g,' '), r.count, 'GHS ' + fmt(r.total)]),
    theme: 'striped',
    headStyles: { fillColor: [220, 38, 38] },
    columnStyles: { 1: { halign: 'center' }, 2: { halign: 'right' } },
    margin: { left: 14, right: 14 },
    tableWidth: 160,
  });

  // ── 4. All Transactions ──────────────────────────────────────
  doc.addPage(); addHeader(doc);
  y = _pdfSectionHeader(doc, '4. All Transactions', 28, [37, 99, 235]);
  const txs = snap.txData?.transactions || [];
  doc.autoTable({
    startY: y,
    head: [['Date', 'Ref', 'Type', 'Category', 'Description', 'Counterparty', 'Payment', 'Amount (GHS)', 'Status']],
    body: txs.map(r => [
      fmtDate(r.transaction_date), r.transaction_ref || '—', r.type,
      (r.category||'').replace(/_/g,' '), r.description||'—', r.counterparty_name||'—',
      r.payment_method||'—', 'GHS ' + fmt(r.amount), r.approval_status||'—',
    ]),
    theme: 'striped',
    headStyles: { fillColor: [37, 99, 235], fontSize: 7 },
    bodyStyles: { fontSize: 7 },
    columnStyles: { 7: { halign: 'right' } },
    margin: { left: 7, right: 7 },
  });

  // ── 5. Egg Production Records ────────────────────────────────
  doc.addPage(); addHeader(doc);
  y = _pdfSectionHeader(doc, '5. Egg Production Records', 28, [202, 138, 4]);
  const eggs = snap.eggsData?.records || [];
  doc.autoTable({
    startY: y,
    head: [['Date', 'Batch', 'Egg Type', 'Collected', 'Broken', 'Saleable', 'Laying Rate']],
    body: eggs.map(r => [
      fmtDate(r.record_date), r.batch_code||'—',
      r.egg_type ? r.egg_type.replace(/_/g,' ') : '—',
      +r.eggs_collected||0, +r.broken_eggs||0, +r.saleable_eggs||0,
      r.laying_rate ? (+r.laying_rate).toFixed(1)+'%' : '—',
    ]),
    theme: 'striped',
    headStyles: { fillColor: [202, 138, 4] },
    columnStyles: { 3:{halign:'right'}, 4:{halign:'right'}, 5:{halign:'right'}, 6:{halign:'right'} },
    margin: { left: 14, right: 14 },
  });

  // ── 6. Weekly Production Summary ─────────────────────────────
  y = doc.lastAutoTable.finalY + 10;
  y = _pdfSectionHeader(doc, '6. Weekly Production Summary', y, [202, 138, 4]);
  doc.autoTable({
    startY: y,
    head: [['Week', 'Total Eggs', 'Saleable', 'Avg Laying Rate']],
    body: (snap.prod.production || []).map(r => [
      fmtDate(r.week), +r.total_eggs, +r.saleable_eggs,
      r.avg_laying_rate ? (+r.avg_laying_rate).toFixed(1)+'%' : '—',
    ]),
    theme: 'striped',
    headStyles: { fillColor: [202, 138, 4] },
    columnStyles: { 1:{halign:'right'}, 2:{halign:'right'}, 3:{halign:'right'} },
    margin: { left: 14, right: 14 },
    tableWidth: 160,
  });

  // ── 7. Flock Status ──────────────────────────────────────────
  doc.addPage(); addHeader(doc);
  y = _pdfSectionHeader(doc, '7. Flock / Batch Status', 28, [124, 58, 237]);
  const batches = snap.flockData?.batches || [];
  doc.autoTable({
    startY: y,
    head: [['Batch Code', 'Breed', 'Purpose', 'Status', 'Current Count', 'Age (Wks)', 'Pen', 'DOC Date']],
    body: batches.map(b => [
      b.batch_code, b.breed||'—', (b.purpose||'').replace(/_/g,' '), b.status||'—',
      (+b.current_count||0).toLocaleString(),
      b.age_weeks != null ? Math.round(b.age_weeks) : '—',
      b.pen_name||'—', fmtDate(b.doc_date),
    ]),
    theme: 'striped',
    headStyles: { fillColor: [124, 58, 237] },
    columnStyles: { 4:{halign:'right'}, 5:{halign:'center'} },
    margin: { left: 14, right: 14 },
  });

  // ── 8. Health Records ────────────────────────────────────────
  y = doc.lastAutoTable.finalY + 10;
  y = _pdfSectionHeader(doc, '8. Health Records', y, [239, 68, 68]);
  const health = snap.healthData?.records || [];
  doc.autoTable({
    startY: y,
    head: [['Date', 'Batch', 'Event Type', 'Diagnosis', 'Severity', 'Affected', 'Mortality', 'Status', 'Veterinarian']],
    body: health.map(r => [
      fmtDate(r.event_date), r.batch_code||'—', (r.event_type||'').replace(/_/g,' '),
      r.diagnosis||'—', r.severity||'—', r.affected_count||'—', r.mortality_count||0,
      r.status||'—', r.veterinarian_name||'—',
    ]),
    theme: 'striped',
    headStyles: { fillColor: [239, 68, 68], fontSize: 7 },
    bodyStyles: { fontSize: 7 },
    margin: { left: 7, right: 7 },
  });

  // ── 9. Feed Transactions ─────────────────────────────────────
  doc.addPage(); addHeader(doc);
  y = _pdfSectionHeader(doc, '9. Feed Transactions', 28, [16, 185, 129]);
  const feed = snap.feedData?.transactions || [];
  doc.autoTable({
    startY: y,
    head: [['Date', 'Feed Type', 'Transaction', 'Quantity (kg)', 'Cost (GHS)', 'Batch', 'Recorded By']],
    body: feed.map(r => [
      fmtDate(r.transaction_date), r.feed_type||'—', r.transaction_type||'—',
      (+r.quantity_kg||0).toLocaleString(), r.cost ? fmt(r.cost) : '—',
      r.batch_code||'—', r.recorded_by_name||'—',
    ]),
    theme: 'striped',
    headStyles: { fillColor: [16, 185, 129] },
    columnStyles: { 3:{halign:'right'}, 4:{halign:'right'} },
    margin: { left: 14, right: 14 },
  });

  doc.save(`FarmIQ-Report-${period}.pdf`);
  toast('PDF downloaded!');
}

async function exportExcel() {
  if (!window.XLSX) { toast('Excel library not loaded — try again in a moment', 'error'); return; }
  const snap = _reportSnapshot;
  if (!snap) { toast('Load the Reports page first', 'error'); return; }
  const XLSX = window.XLSX;
  const { year, month } = snap;
  const period = month ? `${year}-${String(month).padStart(2,'0')}` : String(year);

  const wb = XLSX.utils.book_new();
  const addSheet = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);

  // Sheet 1: P&L Summary
  const totals = snap.pl.totals || {};
  addSheet('PL Summary', [
    [`FarmIQ Farm Report — ${period}`],
    [`Generated: ${new Date().toLocaleDateString('en-GH', { dateStyle: 'long' })}`],
    [],
    ['Metric', 'Amount (GHS)'],
    ['Total Income',   +totals.income   || 0],
    ['Total Expenses', +totals.expenses || 0],
    ['Net Profit',     +totals.net_profit || 0],
    ['Profit Margin',  (totals.margin || 0) + '%'],
  ]);

  // Sheet 2: Income Breakdown
  addSheet('Income', [
    ['Category', 'Transactions', 'Amount (GHS)'],
    ...(snap.pl.income || []).map(r => [r.category.replace(/_/g,' '), +r.count, +r.total]),
  ]);

  // Sheet 3: Expense Breakdown
  addSheet('Expenses', [
    ['Category', 'Transactions', 'Amount (GHS)'],
    ...(snap.pl.expenses || []).map(r => [r.category.replace(/_/g,' '), +r.count, +r.total]),
  ]);

  // Sheet 4: All Transactions
  addSheet('Transactions', [
    ['Date', 'Ref', 'Type', 'Category', 'Description', 'Counterparty', 'Payment Method', 'Amount (GHS)', 'Status'],
    ...(snap.txData?.transactions || []).map(r => [
      fmtDate(r.transaction_date), r.transaction_ref||'', r.type,
      (r.category||'').replace(/_/g,' '), r.description||'', r.counterparty_name||'',
      r.payment_method||'', +r.amount, r.approval_status||'',
    ]),
  ]);

  // Sheet 5: Egg Production Records
  addSheet('Egg Records', [
    ['Date', 'Batch Code', 'Egg Type', 'Eggs Collected', 'Broken', 'Saleable', 'Laying Rate (%)'],
    ...(snap.eggsData?.records || []).map(r => [
      fmtDate(r.record_date), r.batch_code||'', (r.egg_type||'').replace(/_/g,' '),
      +r.eggs_collected||0, +r.broken_eggs||0, +r.saleable_eggs||0,
      r.laying_rate ? (+r.laying_rate).toFixed(1) : '',
    ]),
  ]);

  // Sheet 6: Weekly Production Summary
  addSheet('Weekly Production', [
    ['Week', 'Total Eggs', 'Saleable Eggs', 'Avg Laying Rate (%)'],
    ...(snap.prod.production || []).map(r => [
      fmtDate(r.week), +r.total_eggs, +r.saleable_eggs,
      r.avg_laying_rate ? (+r.avg_laying_rate).toFixed(1) : '',
    ]),
  ]);

  // Sheet 7: Flock Status
  addSheet('Flock Status', [
    ['Batch Code', 'Breed', 'Purpose', 'Status', 'Current Count', 'Age (Weeks)', 'Pen', 'DOC Date'],
    ...(snap.flockData?.batches || []).map(b => [
      b.batch_code, b.breed||'', (b.purpose||'').replace(/_/g,' '), b.status||'',
      +b.current_count||0,
      b.age_weeks != null ? Math.round(b.age_weeks) : '',
      b.pen_name||'', fmtDate(b.doc_date),
    ]),
  ]);

  // Sheet 8: Health Records
  addSheet('Health Records', [
    ['Date', 'Batch', 'Event Type', 'Diagnosis', 'Severity', 'Affected', 'Mortality', 'Status', 'Veterinarian'],
    ...(snap.healthData?.records || []).map(r => [
      fmtDate(r.event_date), r.batch_code||'', (r.event_type||'').replace(/_/g,' '),
      r.diagnosis||'', r.severity||'', r.affected_count||'', r.mortality_count||0,
      r.status||'', r.veterinarian_name||'',
    ]),
  ]);

  // Sheet 9: Feed Transactions
  addSheet('Feed Transactions', [
    ['Date', 'Feed Type', 'Transaction Type', 'Quantity (kg)', 'Cost (GHS)', 'Batch', 'Recorded By'],
    ...(snap.feedData?.transactions || []).map(r => [
      fmtDate(r.transaction_date), r.feed_type||'', r.transaction_type||'',
      +r.quantity_kg||0, r.cost ? +r.cost : '',
      r.batch_code||'', r.recorded_by_name||'',
    ]),
  ]);

  XLSX.writeFile(wb, `FarmIQ-Report-${period}.xlsx`);
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

  // Mobile sidebar
  function setSidebarOpen(open) {
    el('sidebar')?.classList.toggle('sidebar-open', open);
    el('sidebar-overlay')?.classList.toggle('open', open);
  }
  el('btn-hamburger')?.addEventListener('click', () =>
    setSidebarOpen(!el('sidebar').classList.contains('sidebar-open'))
  );
  el('sidebar-overlay')?.addEventListener('click', () => setSidebarOpen(false));

  // Nav
  document.querySelectorAll('.nav-link').forEach(link => {
    link.onclick = () => {
      navigateTo(link.dataset.section);
      if (window.innerWidth <= 768) setSidebarOpen(false);
    };
  });

  el('btn-logout').onclick = logout;

  // Auto-suggest batch code when modal opens
  document.querySelector('[onclick="showModal(\'modal-batch\')"]')
    ?.addEventListener('click', () => setTimeout(suggestBatchCode, 50));

  // Mortality modal: batch change + set today's date
  el('mort-batch-sel')?.addEventListener('change', onMortBatchChange);
  const mortDate = el('mort-date');
  if (mortDate) mortDate.value = new Date().toISOString().split('T')[0];

  // Forms
  const formMap = {
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
