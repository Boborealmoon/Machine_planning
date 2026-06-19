// Post-machining queue — Deburring / Final Inspection / Packing / Engraving & Packing.

const FQ_PS_TYPE_ORDER = ['MPS', 'APS', 'NPS', 'SR', 'PPS', 'CPS'];
const FQ_TABLE_COL_COUNT = 12;

const fqState = {
  items: [],
  recentlyPacked: [],
  view: 'active',
  stage: 'all',
  status: 'all',
  psTypes: new Set(['APS', 'NPS']),
  sortCol: '',
  sortDir: 'asc',
  search: '',
  cachedAt: '',
  packedCachedAt: '',
  cacheTtlSec: 60,
  packedCacheTtlSec: 300,
  weekRanges: null,
  selectedKey: '',
};

function fqStartOfDay(value) {
  const d = value instanceof Date ? value : new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Mon–Sat working week (matches material inspection). */
function fqWorkingWeekRange(forDate = new Date(), offsetWeeks = 0) {
  const anchor = fqStartOfDay(forDate);
  if (!anchor) return { start: null, end: null };
  const day = anchor.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(anchor);
  start.setDate(anchor.getDate() + mondayOffset + offsetWeeks * 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 5);
  return { start, end };
}

function fqFormatWeekRangeLabel(range) {
  if (!range?.start || !range?.end) return '';
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${fmt(range.start)} – ${fmt(range.end)}`;
}

function fqPackedDate(item) {
  const raw = item?.packed_on;
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  return fqStartOfDay(text.includes('T') ? text : text.replace(' ', 'T'));
}

function fqPackedWeekBucket(item, thisWeek, lastWeek) {
  const packed = fqPackedDate(item);
  if (!packed) return 3;
  const t = packed.getTime();
  if (t >= thisWeek.start.getTime() && t <= thisWeek.end.getTime()) return 0;
  if (t >= lastWeek.start.getTime() && t <= lastWeek.end.getTime()) return 1;
  return 2;
}

function fqPackedGroupLabel(bucket, thisWeek, lastWeek) {
  if (bucket === 0) return `Packed this week (${fqFormatWeekRangeLabel(thisWeek)})`;
  if (bucket === 1) return `Packed last week (${fqFormatWeekRangeLabel(lastWeek)})`;
  if (bucket === 2) return 'Packed earlier (within range)';
  return 'No pack date';
}

function fqRenderGroupRow(label) {
  return `
    <tr class="mi-group-row" aria-hidden="true">
      <td colspan="${FQ_TABLE_COL_COUNT}">${escapeHtml(label)}</td>
    </tr>
  `;
}

function fqActiveSourceItems() {
  return fqState.view === 'recently_packed' ? (fqState.recentlyPacked || []) : (fqState.items || []);
}

function fqIsRecentlyPackedView() {
  return fqState.view === 'recently_packed';
}

function fqItemKey(item) {
  return `${String(item?.ps_id || '').trim()}::${String(item?.pp_partial_no ?? '').trim()}`;
}

function fqFormatDate(value) {
  if (!value) return '—';
  const text = String(value).trim();
  return text.length >= 10 ? text.slice(0, 10) : text || '—';
}

function fqFormatQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

function fqExecutionLabel(code) {
  const c = String(code || '').trim().toUpperCase();
  if (c === 'I' || c === 'IN_PROCESS') return 'In Process';
  if (c === 'R' || c === 'READY_TO_START') return 'Ready to Start';
  if (c === 'P' || c === 'PENDING_SI') return 'Pending SI';
  if (c === 'C' || c === 'COMPLETED') return 'Completed';
  return c || '—';
}

function fqStatusPill(code) {
  const c = String(code || '').trim().toUpperCase();
  let cls = 'mi-status-pill';
  if (c === 'I') cls += ' mi-status-pill--o';
  else if (c === 'R') cls += ' mi-status-pill--r';
  else if (c === 'P') cls += ' mi-status-pill--h';
  const label = c || '—';
  return `<span class="${cls}" title="${escapeHtml(fqExecutionLabel(c))}">${escapeHtml(label)}</span>`;
}

function fqStageProgress(item) {
  const produced = Number(item?.stage_qty_produced);
  const required = Number(item?.stage_qty_required ?? item?.qty);
  if (!Number.isFinite(required) || required <= 0) return '—';
  const done = Number.isFinite(produced) ? produced : 0;
  return `${fqFormatQty(done)} / ${fqFormatQty(required)}`;
}

function fqGetPsType(item) {
  const raw = String(item?.ps_id || '').split('::')[0];
  if (/\[sr\]|\(sr\)/i.test(raw)) return 'SR';
  const m = raw.toUpperCase().match(/^([A-Z]+)/);
  if (!m) return null;
  const prefix = m[1];
  if (FQ_PS_TYPE_ORDER.includes(prefix)) return prefix;
  return prefix;
}

function fqPsTypeLabel() {
  const panel = document.getElementById('fq-ps-type-panel');
  if (!panel) return 'APS, NPS';
  const checked = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value);
  if (!checked.length) return 'None';
  if (checked.length >= FQ_PS_TYPE_ORDER.length) return 'All types';
  return checked.join(', ');
}

function fqSortValue(item, col) {
  if (col === 'ps_id') return String(item?.ps_id || '').trim();
  if (col === 'due_date') {
    const text = String(item?.due_date || '').trim();
    return text.length >= 10 ? text.slice(0, 10) : text;
  }
  return '';
}

function fqCompareValues(a, b, dir) {
  const desc = dir === 'desc';
  const aEmpty = a == null || a === '';
  const bEmpty = b == null || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const cmp = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return desc ? -cmp : cmp;
}

function fqSortIcon(col) {
  if (fqState.sortCol !== col) return '↕';
  return fqState.sortDir === 'desc' ? '↓' : '↑';
}

function fqUpdateSortHeaders() {
  document.querySelectorAll('[data-fq-sort-col]').forEach((th) => {
    const col = th.dataset.fqSortCol || '';
    th.classList.toggle('is-sorted', col && col === fqState.sortCol);
  });
  document.querySelectorAll('[data-fq-sort-icon]').forEach((icon) => {
    const col = icon.dataset.fqSortIcon || '';
    icon.textContent = fqSortIcon(col);
  });
}

function fqMatchesSearch(item, term) {
  const hay = [
    item?.ps_id,
    item?.pp_partial_no,
    item?.part_no,
    item?.part_desc,
    item?.bom_code,
    item?.sales_order_no,
    item?.sales_order_line,
    item?.current_stage_desc,
    item?.pp_status,
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(term);
}

function fqFilteredItems() {
  const term = String(fqState.search || '').trim().toLowerCase();
  const types = fqState.psTypes;
  const allTypes = types.size >= FQ_PS_TYPE_ORDER.length;
  const source = fqActiveSourceItems();
  const recentlyPacked = fqIsRecentlyPackedView();

  const filtered = (source || []).filter((item) => {
    if (!recentlyPacked) {
      if (fqState.stage !== 'all' && item.stage_bucket !== fqState.stage) return false;
      if (fqState.status !== 'all') {
        const code = String(item.current_stage_status || '').trim().toUpperCase();
        if (code !== fqState.status) return false;
      }
    }
    if (!allTypes) {
      const psType = fqGetPsType(item);
      if (psType && !types.has(psType)) return false;
      if (!psType && types.size > 0) return false;
    }
    if (term && !fqMatchesSearch(item, term)) return false;
    return true;
  });

  if (recentlyPacked) {
    const thisWeek = fqWorkingWeekRange(new Date(), 0);
    const lastWeek = fqWorkingWeekRange(new Date(), -1);
    return filtered.sort((a, b) => {
      const ba = fqPackedWeekBucket(a, thisWeek, lastWeek);
      const bb = fqPackedWeekBucket(b, thisWeek, lastWeek);
      if (ba !== bb) return ba - bb;
      const ad = fqPackedDate(a)?.getTime() || 0;
      const bd = fqPackedDate(b)?.getTime() || 0;
      if (ad !== bd) return bd - ad;
      return fqCompareValues(fqSortValue(a, 'ps_id'), fqSortValue(b, 'ps_id'), 'asc');
    });
  }

  if (!fqState.sortCol) return filtered;

  return filtered.sort((a, b) => {
    const primary = fqCompareValues(
      fqSortValue(a, fqState.sortCol),
      fqSortValue(b, fqState.sortCol),
      fqState.sortDir
    );
    if (primary !== 0) return primary;
    const psCmp = fqCompareValues(fqSortValue(a, 'ps_id'), fqSortValue(b, 'ps_id'), 'asc');
    if (psCmp !== 0) return psCmp;
    return Number(a.pp_partial_no || 0) - Number(b.pp_partial_no || 0);
  });
}

function fqDetailField(label, value, { mono, fullWidth } = {}) {
  const text = value == null || value === '' ? '—' : String(value);
  const cls = mono ? ' new-orders-detail-value--mono' : '';
  const span = fullWidth ? ' style="grid-column:1/-1"' : '';
  return `
    <div class="new-orders-detail-field"${span}>
      <dt>${escapeHtml(label)}</dt>
      <dd class="new-orders-detail-value${cls}">${escapeHtml(text)}</dd>
    </div>
  `;
}

function fqDetailSection(title, html) {
  if (!html) return '';
  return `
    <section class="new-orders-detail-section">
      <h3 class="new-orders-detail-section-title">${escapeHtml(title)}</h3>
      <dl class="new-orders-detail-grid">${html}</dl>
    </section>
  `;
}

function fqRenderDetail(item) {
  const stageHtml = [
    fqDetailField('Stage', item.current_stage_desc),
    fqDetailField('Stage no.', item.current_stage_no),
    fqDetailField('Status', fqExecutionLabel(item.current_stage_status)),
    fqDetailField('Packed on', fqFormatDate(item.packed_on)),
    fqDetailField('Stage required', fqFormatQty(item.stage_qty_required)),
    fqDetailField('Stage produced', fqFormatQty(item.stage_qty_produced)),
    fqDetailField('Stage rejected', fqFormatQty(item.stage_qty_rejected)),
    fqDetailField('Stage remaining', fqFormatQty(item.stage_qty_remaining)),
  ].join('');
  const psHtml = [
    fqDetailField('Process sheet', item.ps_id, { mono: true }),
    fqDetailField('Partial', item.pp_partial_no),
    fqDetailField('Part', item.part_no, { mono: true }),
    fqDetailField('Description', item.part_desc, { fullWidth: true }),
    fqDetailField('BOM', item.bom_code, { mono: true }),
    fqDetailField('Work qty', fqFormatQty(item.qty)),
    fqDetailField('PP status', item.pp_status),
    fqDetailField('Due date', fqFormatDate(item.due_date)),
  ].join('');
  const orderHtml = [
    fqDetailField('Sales order', item.sales_order_no, { mono: true }),
    fqDetailField('SO line', item.sales_order_line, { mono: true }),
    fqDetailField('SO qty', fqFormatQty(item.so_det_qty)),
    fqDetailField('Qty shipped', fqFormatQty(item.qty_shipped)),
  ].join('');
  return [
    fqDetailSection('Current stage', stageHtml),
    fqDetailSection('Process sheet', psHtml),
    fqDetailSection('Sales order', orderHtml),
  ].join('');
}

function fqOpenDetail(item) {
  const panel = document.getElementById('fq-detail');
  const title = document.getElementById('fq-detail-title');
  const body = document.getElementById('fq-detail-body');
  if (!panel || !title || !body) return;
  fqState.selectedKey = fqItemKey(item);
  const partialLabel = Number(item.pp_partial_no) > 1 ? ` · partial ${item.pp_partial_no}` : '';
  title.textContent = `${item.ps_id || '—'}${partialLabel}`;
  body.innerHTML = fqRenderDetail(item);
  panel.hidden = false;
  document.body.classList.add('new-orders-detail-open');
}

function fqCloseDetail() {
  const panel = document.getElementById('fq-detail');
  if (!panel) return;
  panel.hidden = true;
  fqState.selectedKey = '';
  document.body.classList.remove('new-orders-detail-open');
}

function fqUpdateCounts(payload) {
  const stageCounts = payload?.stage_counts || {};
  const setCount = (id, n) => {
    const el = document.getElementById(id);
    if (!el) return;
    const count = Number(n) || 0;
    el.textContent = String(count);
    el.hidden = count <= 0;
  };
  const total = Number(payload?.count) || 0;
  setCount('fq-count-active', total);
  setCount('fq-count-all', total);
  setCount('fq-count-deburring', stageCounts.deburring);
  setCount('fq-count-final_inspection', stageCounts.final_inspection);
  setCount('fq-count-packing', stageCounts.packing);
  setCount('fq-count-engraving_packing', stageCounts.engraving_packing);
  setCount('fq-count-recently-packed', payload?.recently_packed_count);
}

function fqFindItemByKey(key) {
  const active = fqState.items.find((rowItem) => fqItemKey(rowItem) === key);
  if (active) return active;
  return fqState.recentlyPacked.find((rowItem) => fqItemKey(rowItem) === key);
}

function fqRenderDataRow(item) {
  const key = fqItemKey(item);
  const selected = key === fqState.selectedKey ? ' is-selected' : '';
  const partial = Number(item.pp_partial_no) > 1 ? item.pp_partial_no : '—';
  const progressCell = fqIsRecentlyPackedView()
    ? fqFormatDate(item.packed_on)
    : fqStageProgress(item);
  return `
    <tr class="new-orders-row fq-row${selected}" data-key="${escapeHtml(key)}" tabindex="0" role="button">
      <td class="new-orders-mono">${escapeHtml(item.ps_id || '—')}</td>
      <td>${escapeHtml(String(partial))}</td>
      <td>${escapeHtml(item.current_stage_desc || '—')}</td>
      <td>${fqStatusPill(item.current_stage_status)}</td>
      <td class="new-orders-mono">${escapeHtml(item.part_no || '—')}</td>
      <td>${escapeHtml(item.part_desc || '—')}</td>
      <td class="new-orders-mono">${escapeHtml(item.bom_code || '—')}</td>
      <td>${escapeHtml(fqFormatQty(item.qty))}</td>
      <td>${escapeHtml(progressCell)}</td>
      <td class="new-orders-mono">${escapeHtml(item.sales_order_no || '—')}</td>
      <td>${escapeHtml(fqFormatDate(item.due_date))}</td>
      <td>${escapeHtml(item.pp_status || '—')}</td>
    </tr>
  `;
}

function fqRenderRecentlyPackedBody(filtered) {
  const thisWeek = fqWorkingWeekRange(new Date(), 0);
  const lastWeek = fqWorkingWeekRange(new Date(), -1);
  const parts = [];
  let lastBucket = null;
  for (const item of filtered) {
    const bucket = fqPackedWeekBucket(item, thisWeek, lastWeek);
    if (bucket !== lastBucket) {
      parts.push(fqRenderGroupRow(fqPackedGroupLabel(bucket, thisWeek, lastWeek)));
      lastBucket = bucket;
    }
    parts.push(fqRenderDataRow(item));
  }
  return parts.join('');
}

function fqUpdateViewChrome() {
  const recentlyPacked = fqIsRecentlyPackedView();
  document.getElementById('fq-stage-filter-wrap')?.classList.toggle('is-hidden', recentlyPacked);
  document.getElementById('fq-status-filter-wrap')?.classList.toggle('is-hidden', recentlyPacked);
  const progressCol = document.getElementById('fq-col-progress');
  if (progressCol) progressCol.textContent = recentlyPacked ? 'Packed on' : 'Stage progress';
}

function fqRenderTable() {
  fqUpdateViewChrome();
  const filtered = fqFilteredItems();
  const tbody = document.getElementById('fq-table-body');
  const wrap = document.getElementById('fq-table-wrap');
  const empty = document.getElementById('fq-empty');
  const emptyText = document.getElementById('fq-empty-text');
  const stats = document.getElementById('fq-stats');
  const meta = document.getElementById('fq-meta');
  const recentlyPacked = fqIsRecentlyPackedView();
  const hasActive = (fqState.items || []).length > 0;
  const hasPacked = (fqState.recentlyPacked || []).length > 0;
  const hasCurrentViewData = recentlyPacked ? hasPacked : hasActive;

  if (!tbody || !wrap || !empty) return;

  if (!hasActive && !hasPacked) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = 'No partials are currently at a post-machining stage.';
    if (stats) stats.textContent = '';
    if (meta) meta.hidden = true;
    return;
  }

  if (!hasCurrentViewData || !filtered.length) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) {
      emptyText.textContent = !hasCurrentViewData
        ? (recentlyPacked ? 'No packing completions this week or last week.' : 'No partials are currently at a post-machining stage.')
        : 'No rows match your filters.';
    }
  } else {
    wrap.hidden = false;
    empty.hidden = true;
    tbody.innerHTML = recentlyPacked
      ? fqRenderRecentlyPackedBody(filtered)
      : filtered.map((item) => fqRenderDataRow(item)).join('');
  }

  if (stats) {
    if (recentlyPacked) {
      const thisWeek = fqWorkingWeekRange(new Date(), 0);
      const lastWeek = fqWorkingWeekRange(new Date(), -1);
      let thisCount = 0;
      let lastCount = 0;
      for (const item of filtered) {
        const bucket = fqPackedWeekBucket(item, thisWeek, lastWeek);
        if (bucket === 0) thisCount += 1;
        else if (bucket === 1) lastCount += 1;
      }
      stats.textContent = `${filtered.length} shown · ${thisCount} this week · ${lastCount} last week`;
    } else {
      const statusCounts = { I: 0, R: 0, P: 0 };
      for (const item of filtered) {
        const code = String(item.current_stage_status || '').trim().toUpperCase();
        if (code in statusCounts) statusCounts[code] += 1;
      }
      stats.textContent = `${filtered.length} shown · ${statusCounts.I} in process · ${statusCounts.R} ready`;
    }
  }

  if (meta) {
    meta.hidden = !fqState.cachedAt;
    const packedHint = recentlyPacked
      ? `Grouped by pack week · ERP actual_end_date · cached ${fqState.packedCachedAt || fqState.cachedAt || '—'} · TTL ${fqState.packedCacheTtlSec || 300}s`
      : `Cached ${fqState.cachedAt || '—'} · TTL ${fqState.cacheTtlSec}s`;
    meta.textContent = fqState.cachedAt ? packedHint : '';
  }

  fqUpdateSortHeaders();
}

async function fqLoad({ refresh = false } = {}) {
  const loading = document.getElementById('fq-loading');
  if (loading) loading.hidden = false;
  try {
    const url = refresh ? '/api/finishing-queue?refresh=1' : '/api/finishing-queue';
    const res = await fetch(url);
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    fqState.items = payload.items || [];
    fqState.recentlyPacked = payload.recently_packed || [];
    fqState.cachedAt = payload.cached_at || '';
    fqState.packedCachedAt = payload.packed_cached_at || payload.cached_at || '';
    fqState.cacheTtlSec = payload.cache_ttl_sec || 60;
    fqState.packedCacheTtlSec = payload.packed_cache_ttl_sec || 300;
    fqState.weekRanges = payload.week_ranges || null;
    fqUpdateCounts(payload);
    fqRenderTable();
  } catch (err) {
    const empty = document.getElementById('fq-empty');
    const emptyText = document.getElementById('fq-empty-text');
    const wrap = document.getElementById('fq-table-wrap');
    if (wrap) wrap.hidden = true;
    if (empty) empty.hidden = false;
    if (emptyText) emptyText.textContent = `Failed to load: ${err.message || err}`;
  } finally {
    if (loading) loading.hidden = true;
  }
}

function fqSetView(view) {
  fqState.view = view;
  document.querySelectorAll('[data-fq-view]').forEach((btn) => {
    const active = btn.dataset.fqView === view;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  fqCloseDetail();
  fqRenderTable();
}

function fqSetStage(stage) {
  fqState.stage = stage;
  document.querySelectorAll('[data-fq-stage]').forEach((btn) => {
    const active = btn.dataset.fqStage === stage;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  fqRenderTable();
}

function fqSetStatus(status) {
  fqState.status = status;
  document.querySelectorAll('[data-fq-status]').forEach((btn) => {
    const active = btn.dataset.fqStatus === status;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  fqRenderTable();
}

function fqBindPsTypeDropdown() {
  const dropdown = document.getElementById('fq-ps-type-dropdown');
  const btn = document.getElementById('fq-ps-type-btn');
  const panel = document.getElementById('fq-ps-type-panel');
  if (!dropdown || !btn || !panel) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });

  document.addEventListener('click', () => {
    panel.hidden = true;
  });

  panel.addEventListener('click', (e) => e.stopPropagation());

  panel.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      fqState.psTypes = new Set(
        [...panel.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value)
      );
      btn.textContent = `${fqPsTypeLabel()} ▾`;
      fqRenderTable();
    });
  });

  btn.textContent = `${fqPsTypeLabel()} ▾`;
}

function fqSetSort(col) {
  if (!col) return;
  if (fqState.sortCol === col) {
    fqState.sortDir = fqState.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    fqState.sortCol = col;
    fqState.sortDir = 'asc';
  }
  fqRenderTable();
}

function fqBindEvents() {
  document.getElementById('fq-refresh')?.addEventListener('click', () => fqLoad({ refresh: true }));

  document.querySelectorAll('[data-fq-sort]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      fqSetSort(btn.dataset.fqSort || '');
    });
  });

  document.querySelectorAll('[data-fq-stage]').forEach((btn) => {
    btn.addEventListener('click', () => fqSetStage(btn.dataset.fqStage || 'all'));
  });
  document.querySelectorAll('[data-fq-status]').forEach((btn) => {
    btn.addEventListener('click', () => fqSetStatus(btn.dataset.fqStatus || 'all'));
  });

  document.getElementById('fq-search')?.addEventListener('input', (e) => {
    fqState.search = e.target.value || '';
    fqRenderTable();
  });

  document.querySelectorAll('[data-fq-view]').forEach((btn) => {
    btn.addEventListener('click', () => fqSetView(btn.dataset.fqView || 'active'));
  });

  document.getElementById('fq-table-body')?.addEventListener('click', (e) => {
    const row = e.target.closest('.fq-row');
    if (!row) return;
    const key = row.dataset.key || '';
    const item = fqFindItemByKey(key);
    if (item) fqOpenDetail(item);
  });

  document.getElementById('fq-table-body')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.fq-row');
    if (!row) return;
    e.preventDefault();
    const key = row.dataset.key || '';
    const item = fqFindItemByKey(key);
    if (item) fqOpenDetail(item);
  });

  document.getElementById('fq-detail-close')?.addEventListener('click', fqCloseDetail);
  document.querySelector('#fq-detail [data-action="close-detail"]')?.addEventListener('click', fqCloseDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') fqCloseDetail();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  fqBindPsTypeDropdown();
  fqBindEvents();
  fqLoad();
});
