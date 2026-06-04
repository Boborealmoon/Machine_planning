// Material Inspection — QC job assignments (R outstanding, H historical).

const miState = {
  outstanding: [],
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

function miRowKey(row) {
  const insp = String(row?.inspection_voucher_no || '').trim();
  const seq = String(row?.job_assignment_seq_no ?? '').trim();
  const ship = String(row?.shipment_voucher_no || '').trim();
  const line = String(row?.shipment_line_item_no ?? '').trim();
  return `${insp}::${seq}::${ship}::${line}`;
}

function miStatusLabel(code) {
  const c = String(code || '').trim().toUpperCase();
  if (c === 'R') return 'Outstanding (R)';
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
  const desc = String(row.line_item_description || '').trim();
  const remarks = String(row.internal_remarks || '').trim();
  const qcHtml = [
    miDetailField('Inspection voucher', row.inspection_voucher_no, { mono: true }),
    miDetailField('Job assignment seq', row.job_assignment_seq_no),
    miDetailField('Status', miStatusLabel(row.status)),
    miDetailField('Inspector', row.inspector_code),
    miDetailField('Internal remarks', remarks || '—', { fullWidth: true }),
    miDetailField('Created by', row.created_by),
    miDetailField('Created', miFormatDt(row.created_datetime)),
    miDetailField('Last updated', miFormatDt(row.last_updated_datetime)),
  ].join('');
  const shipHtml = [
    miDetailField('Shipment voucher', row.shipment_voucher_no, { mono: true }),
    miDetailField('Shipment line', row.shipment_line_item_no),
    miDetailField('Source voucher', row.source_voucher_no, { mono: true }),
    miDetailField('GRN', row.grn_no, { mono: true }),
  ].join('');
  const partHtml = [
    miDetailField('Inventory / part', row.inventory_code, { mono: true }),
    miDetailField('Line description', desc || '—', { fullWidth: true }),
    miDetailField('DT type', row.dt_type),
  ].join('');
  return [
    miDetailSection('QC assignment', qcHtml),
    miDetailSection('Inbound shipment', shipHtml),
    miDetailSection('Material', partHtml),
  ].join('');
}

function miAllRows() {
  return [...(miState.outstanding || []), ...(miState.historical || [])];
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
  const seq = row.job_assignment_seq_no != null ? ` · seq ${row.job_assignment_seq_no}` : '';
  miOpenDetail({
    title: `${insp}${seq}`,
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

function miActiveRows() {
  return miState.view === 'historical' ? miState.historical : miState.outstanding;
}

function miRowSearchText(row) {
  const parts = [
    row.inspection_voucher_no,
    row.source_voucher_no,
    row.shipment_voucher_no,
    row.shipment_line_item_no,
    row.grn_no,
    row.inspector_code,
    row.inventory_code,
    row.line_item_description,
    row.dt_type,
    row.internal_remarks,
    row.created_by,
    row.job_assignment_seq_no,
  ];
  return parts.map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
}

function miFilterRows(rows) {
  const q = String(miState.search || '').trim().toLowerCase();
  if (!q) return rows || [];
  return (rows || []).filter(row => miRowSearchText(row).includes(q));
}

function miRenderRow(row) {
  const key = miRowKey(row);
  const selected = key === miState.selectedRowKey;
  const desc = String(row.line_item_description || '').trim();
  const remarks = String(row.internal_remarks || '').trim();
  return `
    <tr class="is-clickable${selected ? ' is-selected' : ''}" data-mi-row-key="${escapeHtml(key)}" tabindex="0" role="button" aria-label="View inspection detail">
      <td class="mi-cell--dt">${escapeHtml(miFormatDt(row.created_datetime))}</td>
      <td class="mi-cell--mono">${escapeHtml(String(row.inspection_voucher_no || '—'))}</td>
      <td class="mi-cell--mono">${escapeHtml(String(row.source_voucher_no || '—'))}</td>
      <td class="mi-cell--mono">${escapeHtml(String(row.job_assignment_seq_no ?? '—'))}</td>
      <td class="mi-cell--mono">${escapeHtml(String(row.shipment_voucher_no || '—'))}</td>
      <td>${escapeHtml(String(row.shipment_line_item_no ?? '—'))}</td>
      <td class="mi-cell--mono">${escapeHtml(String(row.grn_no || '—'))}</td>
      <td>${escapeHtml(String(row.inspector_code || '—'))}</td>
      <td class="mi-cell--mono">${escapeHtml(String(row.inventory_code || '—'))}</td>
      <td class="mi-cell--desc" title="${escapeHtml(desc)}">${escapeHtml(desc || '—')}</td>
      <td>${escapeHtml(String(row.dt_type || '—'))}</td>
      <td class="mi-cell--remarks" title="${escapeHtml(remarks)}">${escapeHtml(remarks || '—')}</td>
      <td>${escapeHtml(String(row.created_by || '—'))}</td>
      <td class="mi-cell--dt">${escapeHtml(miFormatDt(row.last_updated_datetime))}</td>
    </tr>
  `;
}

function miSetView(view) {
  const next = view === 'historical' ? 'historical' : 'outstanding';
  miState.view = next;
  miCloseDetail();
  document.querySelectorAll('[data-mi-view]').forEach(btn => {
    const active = btn.getAttribute('data-mi-view') === next;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const title = document.getElementById('mi-section-title');
  if (title) {
    title.textContent = next === 'historical' ? 'Historical' : 'Outstanding';
  }
  miRender();
}

function miUpdateStats() {
  const stats = document.getElementById('mi-stats');
  if (!stats) return;
  const active = miFilterRows(miActiveRows()).length;
  const outN = miFilterRows(miState.outstanding).length;
  const histN = miFilterRows(miState.historical).length;
  const label = miState.view === 'historical' ? 'Historical' : 'Outstanding';
  stats.textContent = `${label}: ${active} · R: ${outN} · H: ${histN}`;
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

  const hasData = (miState.outstanding?.length || 0) + (miState.historical?.length || 0) > 0;
  const viewEmpty = (rows?.length || 0) === 0;

  if (section) {
    section.hidden = !hasData || viewEmpty;
  }
  if (globalEmpty) {
    globalEmpty.hidden = !hasData || !viewEmpty;
    if (viewEmpty && hasData) {
      const label = miState.view === 'historical' ? 'historical' : 'outstanding';
      globalEmpty.querySelector('p').textContent = `No ${label} inspections in ERP.`;
    }
  }

  if (body) {
    body.innerHTML = filtered.map(miRenderRow).join('');
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
      meta.textContent = `Click a row for detail · Sorted by created (newest first) · cached ${miState.cachedAt || '—'} · TTL ${miState.cacheTtlSec}s`;
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
    const res = await fetch(`/api/material-inspection?${params}`);
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

  miState.outstanding = payload.outstanding || [];
  miState.historical = payload.historical || [];
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
