// Inventory Enquiry — mt_inventory master (grouped by inventory class).

const invState = {
  rows: [],
  classView: 'all',
  statusFilter: 'active',
  search: '',
  cachedAt: '',
  cacheTtlSec: 300,
  selectedCode: '',
  classCounts: {},
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
    title: 'Identity',
    fields: [
      ['Part no', 'inventory_code', { mono: true }],
      ['Main description', 'main_desc', { fullWidth: true }],
      ['Short description', 'short_desc', { fullWidth: true }],
      ['Internal description', 'internal_desc', { fullWidth: true }],
      ['Main description (CN)', 'main_desc_cn', { fullWidth: true }],
      ['Short description (CN)', 'short_desc_cn'],
      ['Detail spec', 'det_spec', { fullWidth: true }],
      ['Detail spec (CN)', 'det_spec_cn', { fullWidth: true }],
      ['Barcode', 'barcode', { mono: true }],
      ['Retail barcode', 'retail_barcode', { mono: true }],
    ],
  },
  {
    title: 'Classification',
    fields: [
      ['Inventory type', 'inventory_type'],
      ['Class', 'inventory_class_code'],
      ['Category', 'inventory_category_code'],
      ['Brand', 'inventory_brand_code'],
      ['Sub-category', 'inventory_sub_categ_code'],
      ['Model', 'inventory_model_code'],
      ['Report grouping', 'report_grouping_code'],
      ['Stock type', 'stock_type'],
      ['Product type', 'product_type'],
      ['Production type', 'production_type'],
      ['Segment 1', 'segment_1_code'],
      ['Segment 2', 'segment_2_code'],
      ['Segment 3', 'segment_3_code'],
      ['Segment 4', 'segment_4_code'],
      ['Country of origin', 'country_of_origin'],
      ['HS code', 'hs_code', { mono: true }],
    ],
  },
  {
    title: 'Units & dimensions',
    fields: [
      ['UOM', 'uom_code'],
      ['Second UOM', 'second_uom'],
      ['Packing UOM', 'packing_uom'],
      ['Reporting UOM', 'reporting_uom'],
      ['Default bill UOM', 'default_bill_uom'],
      ['Weight UOM', 'weight_uom'],
      ['Length', 'length'],
      ['Height', 'height'],
      ['Breadth', 'breadth'],
      ['Gross weight', 'gross_weight'],
      ['Nett weight', 'nett_weight'],
      ['Thickness', 'thickness'],
      ['Thickness 2', 'thickness2'],
      ['Volume', 'volume'],
      ['Area', 'area'],
      ['Inner dimension', 'inner_dimension'],
      ['Outer dimension', 'outer_dimension'],
    ],
  },
  {
    title: 'Production & BOM',
    fields: [
      ['Has BOM', 'has_bom'],
      ['In-house production', 'in_house_production'],
      ['Requires cutting', 'requires_cutting'],
      ['Route to QAQC', 'route_to_qaqc'],
      ['Production lead time', 'production_lead_time'],
      ['Customer raw mat', 'cust_raw_mat'],
      ['Parent part', 'parent_inventory_code', { mono: true }],
      ['PRD inventory', 'prd_inventory_code', { mono: true }],
      ['Nesting material', 'is_nesting_material'],
      ['Batch completion', 'is_batch_completion'],
    ],
  },
  {
    title: 'Costing & lead time',
    fields: [
      ['Base cost', 'base_cost'],
      ['Cost price', 'cost_price'],
      ['Resale base price', 'resale_base_price'],
      ['Lead time (days)', 'lead_time'],
      ['Lead time (months)', 'lead_time_month'],
      ['MOQ (loose)', 'moq_in_loose'],
      ['Markup %', 'markup_percentage'],
      ['Budget category', 'budget_category_code'],
      ['COGS budget category', 'cogs_budget_category_code'],
    ],
  },
  {
    title: 'Flags & compliance',
    fields: [
      ['Suspended', 'is_suspend'],
      ['Restricted', 'restricted_item'],
      ['Special item', 'is_special_item'],
      ['Require inspection', 'require_inspection'],
      ['Require in-house inspection', 'require_in_house_inspection'],
      ['Require BP number', 'require_bp_number'],
      ['Enable lot no', 'enable_lot_no'],
      ['Enable serial no', 'enable_serial_no'],
      ['Flammable', 'flammable'],
      ['API status', 'api_status'],
      ['Import', 'is_import'],
      ['Billable', 'is_billable'],
    ],
  },
  {
    title: 'Remarks',
    fields: [
      ['Inventory remarks', 'inventory_remarks', { fullWidth: true }],
      ['End client', 'end_client_name'],
      ['Market segment', 'market_segment'],
      ['Base material', 'base_material'],
      ['Customer paint specs', 'customer_paint_specs', { fullWidth: true }],
    ],
  },
  {
    title: 'Audit',
    fields: [
      ['Created by', 'created_by'],
      ['Created', 'created_datetime'],
      ['Last updated by', 'last_updated_by'],
      ['Last updated', 'last_updated_datetime'],
      ['Last modified by', 'last_modified_by'],
      ['Last modified', 'last_modified_datetime'],
      ['Object version', 'object_version'],
    ],
  },
];

const INV_TABLE_COL_COUNT = 11;

function invYn(value) {
  const c = String(value || '').trim().toUpperCase();
  if (c === 'Y') return 'Y';
  if (c === 'N') return 'N';
  return '—';
}

function invFormatNum(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  if (Math.abs(n) < 0.0001 && n !== 0) return String(value);
  if (Number.isInteger(n)) return String(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function invIsSuspended(row) {
  return String(row?.is_suspend || '').trim().toUpperCase() === 'Y';
}

function invMatchesStatus(row) {
  if (invState.statusFilter === 'all') return true;
  if (invState.statusFilter === 'suspended') return invIsSuspended(row);
  return !invIsSuspended(row);
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
    row.internal_desc,
    row.inventory_class_code,
    row.inventory_category_code,
    row.uom_code,
    row.stock_type,
    row.inventory_remarks,
    row.barcode,
    row.parent_inventory_code,
  ];
  return parts.map((v) => String(v == null ? '' : v).toLowerCase()).join(' ');
}

function invFilterRows(rows) {
  const q = String(invState.search || '').trim().toLowerCase();
  return (rows || []).filter((row) => {
    if (!invMatchesClass(row)) return false;
    if (!invMatchesStatus(row)) return false;
    if (q && !invRowSearchText(row).includes(q)) return false;
    return true;
  });
}

function invDetailField(label, value, { mono, fullWidth } = {}) {
  if (value == null || value === '') return '';
  const text = String(value);
  const cls = mono ? ' mi-detail-value--mono' : '';
  const span = fullWidth ? ' mi-detail-field--full' : '';
  return `
    <div class="mi-detail-field${span}">
      <dt>${escapeHtml(label)}</dt>
      <dd class="mi-detail-value${cls}">${escapeHtml(text)}</dd>
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
      .map(([label, key, opts]) => invDetailField(label, row[key], opts || {}))
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

function invRenderRow(row) {
  const code = String(row.inventory_code || '').trim();
  const selected = code === invState.selectedCode;
  const desc = String(row.main_desc || '').trim();
  return `
    <tr class="is-clickable${selected ? ' is-selected' : ''}" data-inv-code="${escapeHtml(code)}" tabindex="0" role="button" aria-label="View inventory detail">
      <td class="mi-cell--mono">${escapeHtml(code || '—')}</td>
      <td class="mi-cell--desc" title="${escapeHtml(desc)}">${escapeHtml(desc || '—')}</td>
      <td>${escapeHtml(String(row.inventory_class_code || '—'))}</td>
      <td>${escapeHtml(String(row.uom_code || '—'))}</td>
      <td>${escapeHtml(invYn(row.has_bom))}</td>
      <td>${escapeHtml(invYn(row.in_house_production))}</td>
      <td>${escapeHtml(String(row.stock_type || '—'))}</td>
      <td class="mi-cell--num">${escapeHtml(invFormatNum(row.lead_time))}</td>
      <td class="mi-cell--num">${escapeHtml(invFormatNum(row.base_cost))}</td>
      <td>${escapeHtml(invYn(row.is_suspend))}</td>
      <td class="mi-cell--dt">${escapeHtml(trialFormatDt(row.last_updated_datetime || row.created_datetime))}</td>
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

function invUpdateTabCounts() {
  const baseRows = invState.rows.filter(invMatchesStatus);
  const search = String(invState.search || '').trim().toLowerCase();
  const countFor = (classKey) => baseRows.filter((row) => {
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
  const active = invState.rows.filter((r) => !invIsSuspended(r)).length;
  const suspended = invState.rows.length - active;
  stats.textContent = `${filtered.length} shown · ${active} active · ${suspended} suspended`;
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
    invState.classCounts = data.class_counts || {};
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

  const statusFilter = document.getElementById('inv-status-filter');
  statusFilter?.addEventListener('change', () => {
    invState.statusFilter = statusFilter.value || 'active';
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
