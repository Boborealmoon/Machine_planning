// Material Inspection — inbound logistic shipment QC lines (O / R / H).

const miPageConfig = window.__MI_PAGE__ || {};
const miApiUrl = String(miPageConfig.apiUrl || '/api/material-inspection');
const miShowShipmentColumn = miPageConfig.showShipmentColumn !== false;

const miState = {
  outstanding: [],
  ready: [],
  historical: [],
  view: 'outstanding',
  search: '',
  cachedAt: '',
  cacheTtlSec: 300,
  selectedRowKey: '',
};

function miFormatDt(value) {
  return trialFormatDt(value);
}

function miFormatDate(value) {
  if (!value) return '—';
  const text = String(value).trim();
  if (!text) return '—';
  const d = new Date(text.includes('T') ? text : text.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return text;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function miStartOfDay(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Mon–Sat working week (matches planner / new orders). */
function miWorkingWeekRange(forDate = new Date(), offsetWeeks = 0) {
  const anchor = miStartOfDay(forDate);
  if (!anchor) return { start: null, end: null };
  const day = anchor.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(anchor);
  start.setDate(anchor.getDate() + mondayOffset + offsetWeeks * 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 5);
  return { start, end };
}

function miFormatWeekRangeLabel(range) {
  if (!range?.start || !range?.end) return '';
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${fmt(range.start)} – ${fmt(range.end)}`;
}

function miArrivalDate(row) {
  const raw = row?.actual_arrival_date || row?.goods_receipt_date;
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  return miStartOfDay(text.includes('T') ? text : text.replace(' ', 'T'));
}

function miCreatedTime(row) {
  const raw = row?.created_datetime;
  if (!raw) return 0;
  const t = new Date(String(raw).replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function miHistoricalArrivalBucket(arrival, thisWeek, lastWeek) {
  if (!arrival) return 3;
  const t = arrival.getTime();
  if (t >= thisWeek.start.getTime() && t <= thisWeek.end.getTime()) return 0;
  if (t >= lastWeek.start.getTime() && t <= lastWeek.end.getTime()) return 1;
  return 2;
}

function miHistoricalGroupLabel(bucket, thisWeek, lastWeek) {
  if (bucket === 0) return `Arrived this week (${miFormatWeekRangeLabel(thisWeek)})`;
  if (bucket === 1) return `Arrived last week (${miFormatWeekRangeLabel(lastWeek)})`;
  if (bucket === 2) return 'Earlier arrivals';
  return 'No arrival date';
}

function miSortHistoricalRows(rows) {
  const thisWeek = miWorkingWeekRange(new Date(), 0);
  const lastWeek = miWorkingWeekRange(new Date(), -1);
  return [...(rows || [])].sort((a, b) => {
    const ba = miHistoricalArrivalBucket(miArrivalDate(a), thisWeek, lastWeek);
    const bb = miHistoricalArrivalBucket(miArrivalDate(b), thisWeek, lastWeek);
    if (ba !== bb) return ba - bb;
    const ad = miArrivalDate(a)?.getTime() || 0;
    const bd = miArrivalDate(b)?.getTime() || 0;
    if (ad !== bd) return bd - ad;
    return miCreatedTime(b) - miCreatedTime(a);
  });
}

function miSortActiveRows(rows) {
  return [...(rows || [])].sort((a, b) => miCreatedTime(b) - miCreatedTime(a));
}

function miRowKey(row) {
  const insp = String(row?.inspection_voucher_no || '').trim();
  const ship = String(row?.shipment_voucher_no || '').trim();
  const line = String(row?.shipment_line_item_no ?? '').trim();
  return `${insp}::${ship}::${line}`;
}

function miRowStatus(row) {
  return String(row?.status || '').trim().toUpperCase();
}

/** ERP material inspection vouchers: QI + digits only (e.g. QI00015980). Excludes legacy QAQC…QI. */
function miIsQiVoucher(row) {
  return /^QI\d+$/.test(String(row?.inspection_voucher_no || '').trim());
}

/** Always bucket by ERP status (O / R / H), even if API still merges O+R. */
function miSplitByStatus(rows) {
  const outstanding = [];
  const ready = [];
  const historical = [];
  for (const row of rows || []) {
    if (!miIsQiVoucher(row)) continue;
    const code = miRowStatus(row);
    if (code === 'H') historical.push(row);
    else if (code === 'R') ready.push(row);
    else if (code === 'O') outstanding.push(row);
  }
  return { outstanding, ready, historical };
}

function miCollectPayloadRows(payload) {
  const seen = new Set();
  const rows = [];
  for (const list of [payload.outstanding, payload.ready, payload.historical]) {
    for (const row of list || []) {
      const key = miRowKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return rows;
}

function miStatusLabel(code) {
  const c = String(code || '').trim().toUpperCase();
  if (c === 'O') return 'Outstanding (O)';
  if (c === 'R') return 'Ready (R)';
  if (c === 'H') return 'Historical (H)';
  return c || '—';
}

function miDetailField(label, value, { mono, fullWidth } = {}) {
  const text = value == null || value === '' ? '—' : String(value);
  const cls = mono ? ' mi-detail-value--mono' : '';
  const span = fullWidth ? ' mi-detail-field--full' : '';
  return `
    <div class="mi-detail-field${span}">
      <dt>${escapeHtml(label)}</dt>
      <dd class="mi-detail-value${cls}">${escapeHtml(text)}</dd>
    </div>
  `;
}

function miDetailSection(title, html) {
  if (!html) return '';
  return `
    <section class="mi-detail-section">
      <h3 class="mi-detail-section-title">${escapeHtml(title)}</h3>
      <dl class="mi-detail-grid">${html}</dl>
    </section>
  `;
}

function miRenderDetail(row) {
  const remarks = String(row.internal_remarks || '').trim();
  const lineRemarks = String(row.line_item_remarks || '').trim();
  const qcHtml = [
    miDetailField('Inspection voucher', row.inspection_voucher_no, { mono: true }),
    miDetailField('Status', miStatusLabel(row.status)),
    miDetailField('Inspector', row.inspector_name || row.inspector_code),
    miDetailField('NCR voucher', row.ncr_voucher_no, { mono: true }),
    miDetailField('Generate NCR', row.generate_ncr),
    miDetailField('Internal remarks', remarks || '—', { fullWidth: true }),
    miDetailField('Created by', row.created_by_employee_name || row.created_by_employee_code),
    miDetailField('Created', miFormatDt(row.created_datetime)),
    miDetailField('Last updated by', row.last_updated_by_employee_name || row.last_updated_by_employee_code),
    miDetailField('Last updated', miFormatDt(row.last_updated_datetime)),
  ].join('');
  const shipHtml = [
    miDetailField('Shipment voucher', row.shipment_voucher_no, { mono: true }),
    miDetailField('Shipment line', row.shipment_line_item_no),
    miDetailField('PO', row.po_no, { mono: true }),
    miDetailField('Supplier', row.supplier_name),
    miDetailField('GRN', row.grn_no, { mono: true }),
    miDetailField('Arrival date', miFormatDate(row.actual_arrival_date)),
    miDetailField('Goods receipt date', miFormatDate(row.goods_receipt_date)),
    miDetailField('Receiving location', row.shipment_receiving_location_name),
    miDetailField('Contact', row.contact_person_name),
  ].join('');
  const partHtml = [
    miDetailField('Inventory / part', row.inventory_code, { mono: true }),
    miDetailField('Description', row.inventory_desc || '—', { fullWidth: true }),
    miDetailField('Line remarks', lineRemarks || '—', { fullWidth: true }),
    miDetailField('UOM', row.uom),
    miDetailField('Receiving qty', row.receiving_qty),
    miDetailField('Inspected qty', row.inspected_qty),
    miDetailField('Accepted qty', row.accepted_qty),
    miDetailField('Rejected qty', row.rejected_qty),
  ].join('');
  return [
    miDetailSection('QC inspection', qcHtml),
    miDetailSection('Inbound shipment', shipHtml),
    miDetailSection('Material', partHtml),
  ].join('');
}

function miAllRows() {
  return [
    ...(miState.outstanding || []),
    ...(miState.ready || []),
    ...(miState.historical || []),
  ];
}

function miFindRowByKey(key) {
  const target = String(key || '').trim();
  if (!target) return null;
  return miAllRows().find(row => miRowKey(row) === target) || null;
}

function miOpenDetail({ title, bodyHtml }) {
  const shell = document.getElementById('mi-detail');
  const titleEl = document.getElementById('mi-detail-title');
  const bodyEl = document.getElementById('mi-detail-body');
  if (!shell || !titleEl || !bodyEl) return;
  titleEl.textContent = title || 'Inspection detail';
  bodyEl.innerHTML = bodyHtml || '';
  shell.hidden = false;
  document.body.classList.add('mi-detail-open');
}

function miCloseDetail() {
  const shell = document.getElementById('mi-detail');
  if (!shell) return;
  shell.hidden = true;
  document.body.classList.remove('mi-detail-open');
  miState.selectedRowKey = '';
  document.querySelectorAll('#mi-table-body tr.is-selected').forEach(tr => {
    tr.classList.remove('is-selected');
  });
}

function miOpenRowDetail(row) {
  if (!row) return;
  const key = miRowKey(row);
  miState.selectedRowKey = key;
  const insp = String(row.inspection_voucher_no || '').trim() || 'Inspection';
  const line = row.shipment_line_item_no != null ? ` · line ${row.shipment_line_item_no}` : '';
  miOpenDetail({
    title: `${insp}${line}`,
    bodyHtml: miRenderDetail(row),
  });
  document.querySelectorAll('#mi-table-body tr[data-mi-row-key]').forEach(tr => {
    tr.classList.toggle('is-selected', tr.dataset.miRowKey === key);
  });
}

function miBindDetailPanel() {
  const shell = document.getElementById('mi-detail');
  const closeBtn = document.getElementById('mi-detail-close');
  if (!shell) return;

  shell.querySelector('[data-action="close-detail"]')?.addEventListener('click', miCloseDetail);
  closeBtn?.addEventListener('click', miCloseDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !shell.hidden) miCloseDetail();
  });
}

function miBindTableClicks() {
  const wrap = document.querySelector('.mi-table-wrap');
  if (!wrap || wrap.dataset.detailBound === '1') return;
  wrap.dataset.detailBound = '1';

  wrap.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-mi-row-key]');
    if (!tr) return;
    const row = miFindRowByKey(tr.dataset.miRowKey);
    if (row) miOpenRowDetail(row);
  });
}

function miViewLabel(view) {
  if (view === 'ready') return 'Ready';
  if (view === 'historical') return 'Historical';
  return 'Outstanding';
}

function miActiveRows() {
  if (miState.view === 'ready') return miState.ready;
  if (miState.view === 'historical') return miState.historical;
  return miState.outstanding;
}

function miRowSearchText(row) {
  const parts = [
    row.inspection_voucher_no,
    row.po_no,
    row.supplier_name,
    row.shipment_voucher_no,
    row.shipment_line_item_no,
    row.grn_no,
    row.inspector_code,
    row.inspector_name,
    row.inventory_code,
    row.inventory_desc,
    row.uom,
    row.internal_remarks,
    row.line_item_remarks,
    row.created_by_employee_name,
    row.ncr_voucher_no,
  ];
  return parts.map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
}

function miFilterRows(rows) {
  const q = String(miState.search || '').trim().toLowerCase();
  if (!q) return rows || [];
  return (rows || []).filter(row => miRowSearchText(row).includes(q));
}

const MI_TABLE_COL_COUNT = miShowShipmentColumn ? 16 : 15;

function miRenderGroupRow(label) {
  return `
    <tr class="mi-group-row" aria-hidden="true">
      <td colspan="${MI_TABLE_COL_COUNT}">${escapeHtml(label)}</td>
    </tr>
  `;
}

function miRenderHistoricalBody(rows) {
  const thisWeek = miWorkingWeekRange(new Date(), 0);
  const lastWeek = miWorkingWeekRange(new Date(), -1);
  const sorted = miSortHistoricalRows(rows);
  const parts = [];
  let lastBucket = null;
  for (const row of sorted) {
    const bucket = miHistoricalArrivalBucket(miArrivalDate(row), thisWeek, lastWeek);
    if (bucket !== lastBucket) {
      parts.push(miRenderGroupRow(miHistoricalGroupLabel(bucket, thisWeek, lastWeek)));
      lastBucket = bucket;
    }
    parts.push(miRenderRow(row));
  }
  return parts.join('');
}

function miRenderRow(row) {
  const key = miRowKey(row);
  const selected = key === miState.selectedRowKey;
  const desc = String(row.inventory_desc || '').trim();
  const shipmentCell = miShowShipmentColumn
    ? `<td class="mi-cell--mono">${escapeHtml(String(row.shipment_voucher_no || '—'))}</td>`
    : '';
  return `
    <tr class="is-clickable${selected ? ' is-selected' : ''}" data-mi-row-key="${escapeHtml(key)}" tabindex="0" role="button" aria-label="View inspection detail">
      <td class="mi-cell--mono">${escapeHtml(String(row.inspection_voucher_no || '—'))}</td>
      <td>${escapeHtml(String(row.inspector_name || row.inspector_code || '—'))}</td>
      <td class="mi-cell--mono">${escapeHtml(String(row.po_no || '—'))}</td>
      <td>${escapeHtml(String(row.supplier_name || '—'))}</td>
      ${shipmentCell}
      <td class="mi-cell--mono">${escapeHtml(String(row.grn_no || '—'))}</td>
      <td class="mi-cell--dt">${escapeHtml(miFormatDate(row.actual_arrival_date || row.goods_receipt_date))}</td>
      <td>${escapeHtml(String(row.shipment_line_item_no ?? '—'))}</td>
      <td class="mi-cell--mono">${escapeHtml(String(row.inventory_code || '—'))}</td>
      <td class="mi-cell--desc" title="${escapeHtml(desc)}">${escapeHtml(desc || '—')}</td>
      <td>${escapeHtml(String(row.uom || '—'))}</td>
      <td class="mi-cell--num">${escapeHtml(row.receiving_qty == null ? '—' : String(row.receiving_qty))}</td>
      <td>${escapeHtml(String(row.created_by_employee_name || row.created_by_employee_code || '—'))}</td>
      <td class="mi-cell--dt">${escapeHtml(miFormatDt(row.created_datetime))}</td>
      <td>${escapeHtml(String(row.last_updated_by_employee_name || row.last_updated_by_employee_code || '—'))}</td>
      <td class="mi-cell--dt">${escapeHtml(miFormatDt(row.last_updated_datetime))}</td>
    </tr>
  `;
}

function miSetView(view) {
  const next = ['ready', 'historical'].includes(view) ? view : 'outstanding';
  miState.view = next;
  miCloseDetail();
  document.querySelectorAll('[data-mi-view]').forEach(btn => {
    const active = btn.getAttribute('data-mi-view') === next;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const title = document.getElementById('mi-section-title');
  if (title) {
    title.textContent = miViewLabel(next);
  }
  miRender();
}

function miUpdateStats() {
  const stats = document.getElementById('mi-stats');
  if (!stats) return;
  const active = miFilterRows(miActiveRows()).length;
  const outN = miFilterRows(miState.outstanding).length;
  const readyN = miFilterRows(miState.ready).length;
  const histN = miFilterRows(miState.historical).length;
  const label = miViewLabel(miState.view);
  stats.textContent = `${label}: ${active} · O: ${outN} · R: ${readyN} · H: ${histN}`;
}

function miRender() {
  const rows = miActiveRows();
  const filtered = miFilterRows(rows);
  const body = document.getElementById('mi-table-body');
  const emptyEl = document.getElementById('mi-table-empty');
  const countEl = document.getElementById('mi-row-count');
  const section = document.getElementById('mi-table-section');
  const globalEmpty = document.getElementById('mi-global-empty');
  const loading = document.getElementById('mi-loading');

  if (loading) loading.hidden = true;

  const hasData = (miState.outstanding?.length || 0)
    + (miState.ready?.length || 0)
    + (miState.historical?.length || 0) > 0;
  const viewEmpty = (rows?.length || 0) === 0;

  if (section) {
    section.hidden = !hasData || viewEmpty;
  }
  if (globalEmpty) {
    if (!hasData) {
      globalEmpty.hidden = false;
      globalEmpty.querySelector('p').textContent = 'No material inspection rows in ERP.';
    } else if (viewEmpty) {
      globalEmpty.hidden = false;
      globalEmpty.querySelector('p').textContent = `No ${miViewLabel(miState.view).toLowerCase()} inspections in ERP.`;
    } else {
      globalEmpty.hidden = true;
    }
  }

  if (body) {
    body.innerHTML = miState.view === 'historical'
      ? miRenderHistoricalBody(filtered)
      : miSortActiveRows(filtered).map(miRenderRow).join('');
    body.querySelectorAll('tr[data-mi-row-key]').forEach(tr => {
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const row = miFindRowByKey(tr.dataset.miRowKey);
          if (row) miOpenRowDetail(row);
        }
      });
    });
  }
  if (countEl) {
    countEl.textContent = `${filtered.length} row${filtered.length === 1 ? '' : 's'}`;
  }
  if (emptyEl) {
    emptyEl.hidden = filtered.length > 0 || viewEmpty;
  }

  const meta = document.getElementById('mi-meta');
  if (meta) {
    if (hasData) {
      meta.hidden = false;
      const sortHint = miState.view === 'historical'
        ? 'Historical grouped by arrival week (this week, last week, then earlier)'
        : 'Sorted by created (newest first)';
      meta.textContent = `Click a row for detail · ${sortHint} · cached ${miState.cachedAt || '—'} · TTL ${miState.cacheTtlSec}s`;
    } else {
      meta.hidden = true;
    }
  }

  miUpdateStats();
}

async function miLoad({ refresh = false } = {}) {
  const loading = document.getElementById('mi-loading');
  const section = document.getElementById('mi-table-section');
  if (loading) loading.hidden = false;
  if (section) section.hidden = true;
  miCloseDetail();

  const params = new URLSearchParams();
  if (refresh) params.set('refresh', '1');

  let payload;
  try {
    const res = await fetch(`${miApiUrl}?${params}`);
    payload = await res.json();
    if (!res.ok) {
      throw new Error(payload?.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    if (loading) loading.hidden = true;
    const globalEmpty = document.getElementById('mi-global-empty');
    if (globalEmpty) {
      globalEmpty.hidden = false;
      globalEmpty.querySelector('p').textContent = `Failed to load: ${err.message}`;
    }
    return;
  }

  const split = miSplitByStatus(miCollectPayloadRows(payload));
  miState.outstanding = split.outstanding;
  miState.ready = split.ready;
  miState.historical = split.historical;
  miState.cachedAt = payload.cached_at || '';
  miState.cacheTtlSec = payload.cache_ttl_sec || 300;
  miRender();
}

function miBind() {
  const search = document.getElementById('mi-search');
  if (search) {
    search.addEventListener('input', () => {
      miState.search = search.value;
      miRender();
    });
  }

  document.querySelectorAll('[data-mi-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      miSetView(btn.getAttribute('data-mi-view'));
    });
  });

  const refreshBtn = document.getElementById('mi-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => miLoad({ refresh: true }));
  }

  miBindDetailPanel();
  miBindTableClicks();
}

document.addEventListener('DOMContentLoaded', () => {
  miBind();
  miLoad();
});
