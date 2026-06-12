// Inventory Enquiry — ic_inventory_enquiry_summary_view (grouped by inventory class).

const invState = {
  rows: [],
  classView: 'all',
  stockFilter: 'all',
  search: '',
  cachedAt: '',
  cacheTtlSec: 300,
  selectedCode: '',
  stockCounts: {},
};

const INV_CLASS_LABELS = {
  all: 'All inventory',
  raw_material: 'Raw material',
  fg_mfg_commercial: 'FG MFG commercial',
  fg_mro: 'FG MRO',
  cp: 'CP',
  cfm: 'CFM',
  other: 'Other',
};

const INV_GROUP_LABELS = {
  raw_material: 'Raw material',
  fg_mfg_commercial: 'FG MFG commercial',
  fg_mro: 'FG MRO',
  cp: 'CP',
  cfm: 'CFM',
  other: 'Other / unclassified',
};

const INV_CLASS_ORDER = [
  'raw_material',
  'fg_mfg_commercial',
  'fg_mro',
  'cp',
  'cfm',
  'other',
];

const INV_DETAIL_SECTIONS = [
  {
    title: 'Part',
    fields: [
      ['Part no', 'inventory_code', { mono: true }],
      ['Main description', 'main_desc', { fullWidth: true }],
      ['Short description', 'short_desc', { fullWidth: true }],
    ],
  },
  {
    title: 'Classification',
    fields: [
      ['Class', 'inventory_class_code'],
      ['Category', 'inventory_category_code'],
      ['Brand', 'inventory_brand_code'],
      ['UOM', 'uom_code'],
    ],
  },
  {
    title: 'Available quantities',
    numeric: true,
    fields: [
      ['QOH available', 'total_qoh_available'],
      ['QOO available', 'total_qoo_available'],
    ],
  },
  {
    title: 'Balances & allocation',
    numeric: true,
    fields: [
      ['Qty on hand', 'total_qty_on_hand'],
      ['Qty on order', 'total_qty_on_order'],
      ['Free balance', 'total_free_balance_qty'],
      ['Allocated in SQ', 'total_allocated_in_sq'],
      ['Unallocated qty', 'total_unallocated_qty'],
      ['Back order', 'total_qty_back_order'],
    ],
  },
];

const INV_TABLE_COL_COUNT = 12;

function invQty(row, key) {
  const n = Number(row?.[key]);
  return Number.isFinite(n) ? n : 0;
}

function invFormatNum(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  if (Math.abs(n) < 0.0001 && n !== 0) return String(value);
  if (Number.isInteger(n)) return String(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function invMatchesStock(row) {
  const filter = invState.stockFilter;
  if (filter === 'on_hand') return invQty(row, 'total_qty_on_hand') > 0;
  if (filter === 'on_order') return invQty(row, 'total_qty_on_order') > 0;
  if (filter === 'free_balance') return invQty(row, 'total_free_balance_qty') > 0;
  if (filter === 'back_order') return invQty(row, 'total_qty_back_order') > 0;
  return true;
}

function invMatchesClass(row) {
  if (invState.classView === 'all') return true;
  return (row?.class_key || 'other') === invState.classView;
}

function invRowSearchText(row) {
  const parts = [
    row.inventory_code,
    row.main_desc,
    row.short_desc,
    row.inventory_class_code,
    row.inventory_category_code,
    row.inventory_brand_code,
    row.uom_code,
  ];
  return parts.map((v) => String(v == null ? '' : v).toLowerCase()).join(' ');
}

function invFilterRows(rows) {
  const q = String(invState.search || '').trim().toLowerCase();
  return (rows || []).filter((row) => {
    if (!invMatchesClass(row)) return false;
    if (!invMatchesStock(row)) return false;
    if (q && !invRowSearchText(row).includes(q)) return false;
    return true;
  });
}

function invDetailField(label, value, { mono, fullWidth, numeric } = {}) {
  if (!numeric && (value == null || value === '')) return '';
  if (numeric && (value == null || value === '')) value = 0;
  const text = numeric ? invFormatNum(value) : String(value);
  const cls = mono ? ' mi-detail-value--mono' : '';
  const span = fullWidth ? ' mi-detail-field--full' : '';
  return `
    <div class="mi-detail-field${span}">
      <dt>${escapeHtml(label)}</dt>
      <dd class="mi-detail-value${cls}${numeric ? ' mi-detail-value--num' : ''}">${escapeHtml(text)}</dd>
    </div>
  `;
}

function invDetailSection(title, html) {
  if (!html) return '';
  return `
    <section class="mi-detail-section">
      <h3 class="mi-detail-section-title">${escapeHtml(title)}</h3>
      <dl class="mi-detail-grid">${html}</dl>
    </section>
  `;
}

function invRenderDetail(row) {
  return INV_DETAIL_SECTIONS.map((section) => {
    const html = section.fields
      .map(([label, key, opts]) => invDetailField(
        label,
        row[key],
        { ...(opts || {}), numeric: section.numeric },
      ))
      .join('');
    return invDetailSection(section.title, html);
  }).join('');
}

function invFindRow(code) {
  const target = String(code || '').trim();
  if (!target) return null;
  return invState.rows.find((row) => String(row.inventory_code || '').trim() === target) || null;
}

function invOpenDetail({ title, bodyHtml }) {
  const shell = document.getElementById('inv-detail');
  const titleEl = document.getElementById('inv-detail-title');
  const bodyEl = document.getElementById('inv-detail-body');
  if (!shell || !titleEl || !bodyEl) return;
  titleEl.textContent = title || 'Inventory detail';
  bodyEl.innerHTML = bodyHtml || '';
  shell.hidden = false;
  document.body.classList.add('mi-detail-open');
}

function invCloseDetail() {
  const shell = document.getElementById('inv-detail');
  if (!shell) return;
  shell.hidden = true;
  document.body.classList.remove('mi-detail-open');
  invState.selectedCode = '';
  document.querySelectorAll('#inv-table-body tr.is-selected').forEach((tr) => {
    tr.classList.remove('is-selected');
  });
}

function invOpenRowDetail(row) {
  if (!row) return;
  const code = String(row.inventory_code || '').trim();
  invState.selectedCode = code;
  const desc = String(row.main_desc || '').trim();
  invOpenDetail({
    title: desc ? `${code} — ${desc}` : code,
    bodyHtml: invRenderDetail(row),
  });
  document.querySelectorAll('#inv-table-body tr[data-inv-code]').forEach((tr) => {
    tr.classList.toggle('is-selected', tr.dataset.invCode === code);
  });
}

function invRenderGroupRow(label) {
  return `
    <tr class="mi-group-row" aria-hidden="true">
      <td colspan="${INV_TABLE_COL_COUNT}">${escapeHtml(label)}</td>
    </tr>
  `;
}

function invQtyCell(value) {
  const n = Number(value);
  const cls = Number.isFinite(n) && n > 0 ? ' inv-enq-qty--pos' : '';
  return `<td class="mi-cell--num${cls}">${escapeHtml(invFormatNum(value))}</td>`;
}

function invRenderRow(row) {
  const code = String(row.inventory_code || '').trim();
  const selected = code === invState.selectedCode;
  const desc = String(row.main_desc || '').trim();
  return `
    <tr class="is-clickable${selected ? ' is-selected' : ''}" data-inv-code="${escapeHtml(code)}" tabindex="0" role="button" aria-label="View inventory detail">
      <td class="mi-cell--mono">${escapeHtml(code || '—')}</td>
      <td class="mi-cell--desc" title="${escapeHtml(desc)}">${escapeHtml(desc || '—')}</td>
      <td>${escapeHtml(String(row.inventory_class_code || '—'))}</td>
      <td>${escapeHtml(String(row.inventory_category_code || '—'))}</td>
      <td>${escapeHtml(String(row.uom_code || '—'))}</td>
      ${invQtyCell(row.total_qoh_available)}
      ${invQtyCell(row.total_qty_on_hand)}
      ${invQtyCell(row.total_qty_on_order)}
      ${invQtyCell(row.total_allocated_in_sq)}
      ${invQtyCell(row.total_unallocated_qty)}
      ${invQtyCell(row.total_free_balance_qty)}
      ${invQtyCell(row.total_qty_back_order)}
    </tr>
  `;
}

function invSortRows(rows) {
  return [...(rows || [])].sort((a, b) => {
    const ac = String(a.inventory_code || '');
    const bc = String(b.inventory_code || '');
    return ac.localeCompare(bc, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function invRenderBody(rows) {
  const sorted = invSortRows(rows);
  if (invState.classView !== 'all') {
    return sorted.map(invRenderRow).join('');
  }

  const parts = [];
  let lastClass = null;
  for (const row of sorted) {
    const classKey = row.class_key || 'other';
    if (classKey !== lastClass) {
      parts.push(invRenderGroupRow(INV_GROUP_LABELS[classKey] || INV_GROUP_LABELS.other));
      lastClass = classKey;
    }
    parts.push(invRenderRow(row));
  }
  return parts.join('');
}

function invPassesStockForCounts(row) {
  return invMatchesStock(row);
}

function invUpdateTabCounts() {
  const search = String(invState.search || '').trim().toLowerCase();
  const countFor = (classKey) => invState.rows.filter((row) => {
    if (!invPassesStockForCounts(row)) return false;
    if (classKey !== 'all' && (row.class_key || 'other') !== classKey) return false;
    if (search && !invRowSearchText(row).includes(search)) return false;
    return true;
  }).length;

  for (const key of ['all', ...INV_CLASS_ORDER]) {
    const el = document.getElementById(`inv-count-${key}`);
    if (el) el.textContent = String(countFor(key));
  }
}

function invUpdateStats() {
  const stats = document.getElementById('inv-stats');
  if (!stats) return;
  const filtered = invFilterRows(invState.rows);
  const sc = invState.stockCounts || {};
  stats.textContent = [
    `${filtered.length} shown`,
    `on hand: ${sc.on_hand ?? '—'}`,
    `on order: ${sc.on_order ?? '—'}`,
    `back order: ${sc.back_order ?? '—'}`,
  ].join(' · ');
}

function invSetClassView(classView) {
  const next = classView === 'all' || INV_CLASS_ORDER.includes(classView) ? classView : 'all';
  invState.classView = next;
  invCloseDetail();
  document.querySelectorAll('[data-inv-class]').forEach((btn) => {
    const active = btn.getAttribute('data-inv-class') === next;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const title = document.getElementById('inv-section-title');
  if (title) title.textContent = INV_CLASS_LABELS[next] || 'Inventory';
  invRender();
}

function invRender() {
  const filtered = invFilterRows(invState.rows);
  const body = document.getElementById('inv-table-body');
  const emptyEl = document.getElementById('inv-table-empty');
  const countEl = document.getElementById('inv-row-count');
  const section = document.getElementById('inv-table-section');
  const globalEmpty = document.getElementById('inv-global-empty');
  const loading = document.getElementById('inv-loading');

  if (loading) loading.hidden = true;

  const hasData = (invState.rows?.length || 0) > 0;
  if (section) section.hidden = !hasData;
  if (globalEmpty) globalEmpty.hidden = hasData;

  if (body) {
    body.innerHTML = invRenderBody(filtered);
    body.querySelectorAll('tr[data-inv-code]').forEach((tr) => {
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const row = invFindRow(tr.dataset.invCode);
          if (row) invOpenRowDetail(row);
        }
      });
    });
  }
  if (countEl) {
    countEl.textContent = `${filtered.length} row${filtered.length === 1 ? '' : 's'}`;
  }
  if (emptyEl) {
    emptyEl.hidden = filtered.length > 0 || !hasData;
  }

  const meta = document.getElementById('inv-meta');
  if (meta) {
    if (hasData) {
      meta.hidden = false;
      const groupHint = invState.classView === 'all'
        ? 'All view grouped by inventory class'
        : `Filtered to ${INV_CLASS_LABELS[invState.classView] || invState.classView}`;
      meta.textContent = `Click a row for grouped detail · ${groupHint} · cached ${invState.cachedAt || '—'} · TTL ${invState.cacheTtlSec}s`;
    } else {
      meta.hidden = true;
    }
  }

  invUpdateTabCounts();
  invUpdateStats();
}

async function invLoad({ refresh = false } = {}) {
  const loading = document.getElementById('inv-loading');
  if (loading) loading.hidden = false;
  try {
    const url = '/api/inventory-enquiry' + (refresh ? '?refresh=1' : '');
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    invState.rows = data.rows || [];
    invState.stockCounts = data.stock_counts || {};
    invState.cachedAt = data.cached_at || '';
    invState.cacheTtlSec = data.cache_ttl_sec || 300;
    invRender();
  } catch (err) {
    if (loading) loading.hidden = true;
    const globalEmpty = document.getElementById('inv-global-empty');
    if (globalEmpty) {
      globalEmpty.hidden = false;
      globalEmpty.querySelector('p').textContent = `Failed to load inventory: ${err.message}`;
    }
  }
}

function invBindEvents() {
  document.querySelectorAll('[data-inv-class]').forEach((btn) => {
    btn.addEventListener('click', () => invSetClassView(btn.getAttribute('data-inv-class')));
  });

  const stockFilter = document.getElementById('inv-stock-filter');
  stockFilter?.addEventListener('change', () => {
    invState.stockFilter = stockFilter.value || 'all';
    invCloseDetail();
    invRender();
  });

  const search = document.getElementById('inv-search');
  let debounce = null;
  search?.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      invState.search = search.value.trim();
      invCloseDetail();
      invRender();
    }, 200);
  });

  document.getElementById('inv-refresh')?.addEventListener('click', () => invLoad({ refresh: true }));

  const shell = document.getElementById('inv-detail');
  shell?.querySelector('[data-action="close-detail"]')?.addEventListener('click', invCloseDetail);
  document.getElementById('inv-detail-close')?.addEventListener('click', invCloseDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shell && !shell.hidden) invCloseDetail();
  });

  const wrap = document.querySelector('.inv-enq-table')?.closest('.mi-table-wrap');
  wrap?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-inv-code]');
    if (!tr) return;
    const row = invFindRow(tr.dataset.invCode);
    if (row) invOpenRowDetail(row);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  invBindEvents();
  invLoad();
});
