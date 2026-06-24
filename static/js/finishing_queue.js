// Post-machining queue — synced staging + planner QA overlays.
window.__fqPageScriptLoaded = true;

function fqApiUrl(key) {
  const cfg = window.__FQ_CONFIG__ || {};
  const urls = {
    queue: cfg.apiQueue || '/api/finishing-queue',
    recentlyPacked: cfg.apiRecentlyPacked || '/api/finishing-queue/recently-packed',
    overlay: cfg.apiOverlay || '/api/finishing-queue/overlay',
    inspectors: cfg.apiInspectors || '/api/finishing-queue/inspectors',
  };
  return urls[key] || urls.queue;
}
if (typeof escapeHtml !== 'function') {
  window.escapeHtml = function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
}

function fqHideLoading() {
  const loading = document.getElementById('fq-loading');
  if (loading) loading.hidden = true;
}

function fqShowLoadError(message) {
  fqHideLoading();
  const empty = document.getElementById('fq-empty');
  const emptyText = document.getElementById('fq-empty-text');
  const wrap = document.getElementById('fq-table-wrap');
  if (wrap) wrap.hidden = true;
  if (empty) empty.hidden = false;
  if (emptyText) emptyText.textContent = message;
}

const FQ_PS_TYPE_ORDER = ['MPS', 'APS', 'NPS', 'SR', 'PPS', 'CPS'];
const FQ_TABLE_COL_COUNT = 17;

const fqState = {
  items: [],
  recentlyPacked: [],
  inspectors: [],
  assignmentCounts: {},
  screen: 'queue',
  view: 'active',
  stage: 'all',
  status: 'all',
  assignee: 'all',
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
  savingKeys: new Set(),
  dataSource: 'sync',
  packedLoaded: false,
  packedLoading: false,
  loadHint: '',
};

function fqParseDateOnly(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const d = new Date(text.includes('T') ? text : `${text.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fqIsoCalendarWeek(value) {
  const date = fqParseDateOnly(value);
  if (!date) return '';
  const dayNum = date.getUTCDay() || 7;
  const thursday = new Date(date);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function fqStartOfDay(value) {
  const d = value instanceof Date ? value : new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

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
  return fqState.screen === 'queue' && fqState.view === 'recently_packed';
}

function fqIsQueueTableVisible() {
  return fqState.screen === 'queue' || fqState.screen === 'assignments';
}

function fqItemKey(item) {
  const stage = String(item?.current_stage_desc || '').trim();
  return `${String(item?.ps_id || '').trim()}::${String(item?.pp_partial_no ?? '').trim()}::${stage}`;
}

function fqFormatDate(value) {
  if (!value) return '—';
  const text = String(value).trim();
  return text.length >= 10 ? text.slice(0, 10) : text || '—';
}

function fqDateInputValue(value) {
  const text = fqFormatDate(value);
  return text === '—' ? '' : text;
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
  if (col === 'pp_partial_no') return Number(item?.pp_partial_no || 0);
  if (col === 'ps_id') return String(item?.ps_id || '').trim();
  if (col === 'current_stage_desc') return String(item?.current_stage_desc || '').trim();
  if (col === 'current_stage_status') return String(item?.current_stage_status || '').trim().toUpperCase();
  if (col === 'inspector_name') return String(item?.inspector_name || '').trim().toLowerCase();
  if (col === 'due_date' || col === 'coway_proposed_edd' || col === 'qa_due_date') {
    const text = String(item?.[col] || '').trim();
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
  if (typeof a === 'number' && typeof b === 'number') {
    return desc ? b - a : a - b;
  }
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
    item?.inspector_name,
    item?.remarks,
    item?.coway_proposed_edd,
    fqIsoCalendarWeek(item?.coway_proposed_edd),
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
      if (fqState.screen === 'assignments' && fqState.assignee !== 'all') {
        const name = String(item.inspector_name || '').trim() || 'Unassigned';
        if (fqState.assignee === '__unassigned__') {
          if (name !== 'Unassigned') return false;
        } else if (name !== fqState.assignee) return false;
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

function fqInspectorOptions(selectedId) {
  const opts = ['<option value="">— Unassigned —</option>'];
  for (const insp of fqState.inspectors || []) {
    const id = String(insp.inspector_id);
    const sel = String(selectedId || '') === id ? ' selected' : '';
    opts.push(`<option value="${escapeHtml(id)}"${sel}>${escapeHtml(insp.name || id)}</option>`);
  }
  return opts.join('');
}

function fqOverlayPayload(item, patch) {
  return {
    ps_id: item.ps_id,
    pp_partial_no: item.pp_partial_no,
    stage_desc: item.current_stage_desc,
    ...patch,
  };
}

async function fqSaveOverlay(item, patch) {
  const key = fqItemKey(item);
  if (fqState.savingKeys.has(key)) return null;
  fqState.savingKeys.add(key);
  try {
    const res = await fetch(fqApiUrl('overlay'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fqOverlayPayload(item, patch)),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const overlay = data.overlay || {};
    Object.assign(item, {
      remarks: overlay.remarks ?? item.remarks,
      inspector_id: overlay.inspector_id ?? item.inspector_id,
      inspector_name: overlay.inspector_name ?? item.inspector_name,
      qa_due_date: overlay.qa_due_date ?? item.qa_due_date,
    });
    fqRecalcAssignmentCounts();
    fqRenderAssigneeTabs();
    return overlay;
  } finally {
    fqState.savingKeys.delete(key);
  }
}

function fqRecalcAssignmentCounts() {
  const counts = {};
  for (const item of fqState.items || []) {
    const name = String(item.inspector_name || '').trim() || 'Unassigned';
    counts[name] = (counts[name] || 0) + 1;
  }
  fqState.assignmentCounts = counts;
}

function fqRenderAssigneeTabs() {
  const wrap = document.getElementById('fq-assignee-tabs');
  if (!wrap) return;
  const counts = fqState.assignmentCounts || {};
  const names = Object.keys(counts).sort((a, b) => {
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return a.localeCompare(b);
  });
  const buttons = [
    { id: 'all', label: 'All', count: fqState.items.length },
    ...names.map((name) => ({
      id: name === 'Unassigned' ? '__unassigned__' : name,
      label: name,
      count: counts[name] || 0,
    })),
  ];
  wrap.innerHTML = buttons.map((btn) => {
    const active = fqState.assignee === btn.id ? ' is-active' : '';
    const selected = fqState.assignee === btn.id ? 'true' : 'false';
    const countHtml = btn.count > 0 ? ` <span class="ps-view-tab-count">${btn.count}</span>` : '';
    return `<button type="button" class="mi-view-btn${active}" data-fq-assignee="${escapeHtml(btn.id)}" role="tab" aria-selected="${selected}">${escapeHtml(btn.label)}${countHtml}</button>`;
  }).join('');
  wrap.querySelectorAll('[data-fq-assignee]').forEach((el) => {
    el.addEventListener('click', () => fqSetAssignee(el.dataset.fqAssignee || 'all'));
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
    fqDetailField('PO due', fqFormatDate(item.due_date)),
    fqDetailField('Coway EDD', fqFormatDate(item.coway_proposed_edd)),
    fqDetailField('Coway week', fqIsoCalendarWeek(item.coway_proposed_edd) || '—'),
    fqDetailField('QA due', fqFormatDate(item.qa_due_date)),
    fqDetailField('Assigned to', item.inspector_name || '—'),
    fqDetailField('Remarks', item.remarks, { fullWidth: true }),
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

function fqEditableCells(item) {
  const key = fqItemKey(item);
  const disabled = fqIsRecentlyPackedView() ? ' disabled' : '';
  const cowayWeek = fqIsoCalendarWeek(item.coway_proposed_edd) || '—';
  return {
    qaDue: `<input type="date" class="fq-cell-input fq-cell-date" data-fq-field="qa_due_date" data-key="${escapeHtml(key)}" value="${escapeHtml(fqDateInputValue(item.qa_due_date))}"${disabled}>`,
    assignee: `<select class="fq-cell-input fq-cell-select" data-fq-field="inspector_id" data-key="${escapeHtml(key)}"${disabled}>${fqInspectorOptions(item.inspector_id)}</select>`,
    remarks: `<input type="text" class="fq-cell-input fq-cell-text" data-fq-field="remarks" data-key="${escapeHtml(key)}" value="${escapeHtml(item.remarks || '')}" placeholder="Remarks"${disabled}>`,
    cowayWeek,
  };
}

function fqRenderDataRow(item) {
  const key = fqItemKey(item);
  const selected = key === fqState.selectedKey ? ' is-selected' : '';
  const partial = Number(item.pp_partial_no) > 1 ? item.pp_partial_no : '—';
  const progressCell = fqIsRecentlyPackedView() ? fqFormatDate(item.packed_on) : fqStageProgress(item);
  const cells = fqEditableCells(item);
  return `
    <tr class="new-orders-row fq-row${selected}" data-key="${escapeHtml(key)}" tabindex="0">
      <td class="new-orders-mono fq-open-detail">${escapeHtml(item.ps_id || '—')}</td>
      <td class="fq-open-detail">${escapeHtml(String(partial))}</td>
      <td class="fq-open-detail">${escapeHtml(item.current_stage_desc || '—')}</td>
      <td class="fq-open-detail">${fqStatusPill(item.current_stage_status)}</td>
      <td class="new-orders-mono fq-open-detail">${escapeHtml(item.part_no || '—')}</td>
      <td class="fq-open-detail">${escapeHtml(item.part_desc || '—')}</td>
      <td class="new-orders-mono fq-open-detail">${escapeHtml(item.bom_code || '—')}</td>
      <td class="fq-open-detail">${escapeHtml(fqFormatQty(item.qty))}</td>
      <td class="fq-open-detail">${escapeHtml(progressCell)}</td>
      <td class="new-orders-mono fq-open-detail">${escapeHtml(item.sales_order_no || '—')}</td>
      <td class="fq-open-detail">${escapeHtml(fqFormatDate(item.due_date))}</td>
      <td class="fq-open-detail">${escapeHtml(fqFormatDate(item.coway_proposed_edd))}</td>
      <td class="fq-open-detail">${escapeHtml(cells.cowayWeek)}</td>
      <td>${cells.qaDue}</td>
      <td>${cells.assignee}</td>
      <td>${cells.remarks}</td>
      <td class="fq-open-detail">${escapeHtml(item.pp_status || '—')}</td>
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

function fqRenderInspectorPanel() {
  const list = document.getElementById('fq-inspector-list');
  const empty = document.getElementById('fq-inspector-empty');
  if (!list || !empty) return;
  const inspectors = fqState.inspectors || [];
  if (!inspectors.length) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = inspectors.map((insp) => `
    <li class="fq-inspector-item">
      <span>${escapeHtml(insp.name || '')}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-fq-remove-inspector="${insp.inspector_id}">Remove</button>
    </li>
  `).join('');
}

function fqUpdateScreenChrome() {
  const screen = fqState.screen;
  const queueMode = screen === 'queue';
  const assignMode = screen === 'assignments';
  const inspectorMode = screen === 'inspectors';

  document.getElementById('fq-queue-view-wrap')?.classList.toggle('is-hidden', !queueMode);
  document.getElementById('fq-stage-filter-wrap')?.classList.toggle('is-hidden', !queueMode && !assignMode);
  document.getElementById('fq-status-filter-wrap')?.classList.toggle('is-hidden', !queueMode && !assignMode);
  document.getElementById('fq-assignee-filter-wrap')?.hidden = !assignMode;
  document.getElementById('fq-ps-type-filter')?.classList.toggle('is-hidden', inspectorMode);
  document.getElementById('fq-search-wrap')?.classList.toggle('is-hidden', inspectorMode);

  document.getElementById('fq-table-wrap')?.classList.toggle('is-hidden', inspectorMode);
  document.getElementById('fq-inspectors-panel')?.hidden = !inspectorMode;

  document.querySelectorAll('[data-fq-screen]').forEach((btn) => {
    const active = btn.dataset.fqScreen === screen;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  if (assignMode) {
    fqState.view = 'active';
    document.querySelectorAll('[data-fq-view]').forEach((btn) => {
      const active = btn.dataset.fqView === 'active';
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }
}

function fqUpdateViewChrome() {
  const recentlyPacked = fqIsRecentlyPackedView();
  document.getElementById('fq-stage-filter-wrap')?.classList.toggle('is-hidden', recentlyPacked);
  document.getElementById('fq-status-filter-wrap')?.classList.toggle('is-hidden', recentlyPacked);
  const progressCol = document.getElementById('fq-col-progress');
  if (progressCol) progressCol.textContent = recentlyPacked ? 'Packed on' : 'Stage progress';
}

function fqRenderTable() {
  fqUpdateScreenChrome();
  if (fqState.screen === 'inspectors') {
    fqRenderInspectorPanel();
    document.getElementById('fq-empty')?.hidden = true;
    document.getElementById('fq-loading')?.hidden = true;
    const meta = document.getElementById('fq-meta');
    if (meta) {
      meta.hidden = !fqState.cachedAt;
      meta.textContent = fqState.cachedAt ? `ERP cached ${fqState.cachedAt} · TTL ${fqState.cacheTtlSec}s` : '';
    }
    return;
  }

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

  if (!tbody || !wrap || !empty) {
    fqShowLoadError('Queue table markup is missing from the page — hard refresh or restart the app.');
    return;
  }

  fqHideLoading();

  if (!hasActive && !hasPacked) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = 'No partials are currently at a post-machining stage.';
    if (emptyText && fqState.loadHint) emptyText.textContent = fqState.loadHint;
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
    } else if (fqState.screen === 'assignments') {
      stats.textContent = `${filtered.length} assigned jobs shown`;
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
      ? `Grouped by pack week · plan end date · cached ${fqState.packedCachedAt || fqState.cachedAt || '—'} · TTL ${fqState.packedCacheTtlSec || 300}s`
      : `Source: synced staging (mfg_wo_status + pp_vouchers_cache) · cached ${fqState.cachedAt || '—'} · TTL ${fqState.cacheTtlSec}s · Sync ERP for fresh data`;
    meta.textContent = fqState.cachedAt ? packedHint : '';
  }

  fqUpdateSortHeaders();
}

async function fqFetchJson(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    return payload;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Request timed out — try again or run Sync ERP then Refresh');
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

function fqApplyPayload(payload) {
  fqState.items = payload.items || [];
  fqState.inspectors = payload.inspectors || [];
  fqState.assignmentCounts = payload.assignment_counts || {};
  fqState.cachedAt = payload.cached_at || '';
  fqState.packedCachedAt = payload.packed_cached_at || payload.cached_at || '';
  fqState.cacheTtlSec = payload.cache_ttl_sec || 180;
  fqState.packedCacheTtlSec = payload.packed_cache_ttl_sec || 300;
  fqState.weekRanges = payload.week_ranges || null;
  fqState.dataSource = payload.source || 'sync';
  fqState.loadHint = (!fqState.items.length && payload.hint) ? payload.hint : '';
  fqRecalcAssignmentCounts();
  fqUpdateCounts(payload);
  fqRenderAssigneeTabs();
  fqRenderTable();
}

window.fqApplyPayload = fqApplyPayload;

async function fqLoad({ refresh = false, includePacked = false } = {}) {
  const loading = document.getElementById('fq-loading');
  if (loading) loading.hidden = false;
  const empty = document.getElementById('fq-empty');
  if (empty) empty.hidden = true;
  try {
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');
    if (includePacked) params.set('include_packed', '1');
    const qs = params.toString();
    const url = qs ? `${fqApiUrl('queue')}?${qs}` : fqApiUrl('queue');
    const payload = await fqFetchJson(url);
    if (includePacked) {
      fqState.recentlyPacked = payload.recently_packed || [];
      fqState.packedLoaded = true;
    }
    fqApplyPayload(payload);
  } catch (err) {
    fqShowLoadError(`Failed to load: ${err.message || err}`);
  } finally {
    fqHideLoading();
  }
}

window.fqLoad = fqLoad;

async function fqLoadRecentlyPacked({ refresh = false } = {}) {
  if (fqState.packedLoading) return;
  if (fqState.packedLoaded && !refresh) {
    fqRenderTable();
    return;
  }
  fqState.packedLoading = true;
  const loading = document.getElementById('fq-loading');
  if (loading) loading.hidden = false;
  try {
    const url = refresh
      ? `${fqApiUrl('recentlyPacked')}?refresh=1`
      : fqApiUrl('recentlyPacked');
    const payload = await fqFetchJson(url);
    fqState.recentlyPacked = payload.recently_packed || [];
    fqState.packedLoaded = true;
    fqState.packedCachedAt = payload.packed_cached_at || '';
    fqState.packedCacheTtlSec = payload.packed_cache_ttl_sec || 300;
    fqState.weekRanges = payload.week_ranges || fqState.weekRanges;
    const countEl = document.getElementById('fq-count-recently-packed');
    if (countEl) {
      const count = Number(payload.recently_packed_count) || fqState.recentlyPacked.length;
      countEl.textContent = String(count);
      countEl.hidden = count <= 0;
    }
    fqRenderTable();
  } catch (err) {
    const empty = document.getElementById('fq-empty');
    const emptyText = document.getElementById('fq-empty-text');
    if (empty) empty.hidden = false;
    if (emptyText) emptyText.textContent = `Failed to load recently packed: ${err.message || err}`;
  } finally {
    fqState.packedLoading = false;
    if (loading) loading.hidden = true;
  }
}

function fqSetScreen(screen) {
  fqState.screen = screen;
  fqCloseDetail();
  fqRenderTable();
}

function fqSetView(view) {
  fqState.view = view;
  document.querySelectorAll('[data-fq-view]').forEach((btn) => {
    const active = btn.dataset.fqView === view;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  fqCloseDetail();
  if (view === 'recently_packed') {
    fqLoadRecentlyPacked();
    return;
  }
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

function fqSetAssignee(assignee) {
  fqState.assignee = assignee || 'all';
  fqRenderAssigneeTabs();
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
  document.addEventListener('click', () => { panel.hidden = true; });
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      fqState.psTypes = new Set([...panel.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value));
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

async function fqAddInspector(name) {
  const res = await fetch(fqApiUrl('inspectors'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (data.inspector) fqState.inspectors.push(data.inspector);
  fqState.inspectors.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  fqRenderInspectorPanel();
  fqRenderTable();
}

async function fqRemoveInspector(inspectorId) {
  const res = await fetch(`${fqApiUrl('inspectors')}/${inspectorId}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  fqState.inspectors = fqState.inspectors.filter((row) => String(row.inspector_id) !== String(inspectorId));
  for (const item of fqState.items) {
    if (String(item.inspector_id) === String(inspectorId)) {
      item.inspector_id = null;
      item.inspector_name = '';
    }
  }
  fqRecalcAssignmentCounts();
  fqRenderAssigneeTabs();
  fqRenderInspectorPanel();
  fqRenderTable();
}

function fqBindOverlayEditors() {
  const tbody = document.getElementById('fq-table-body');
  if (!tbody) return;

  tbody.addEventListener('change', async (e) => {
    const el = e.target.closest('[data-fq-field]');
    if (!el) return;
    const key = el.dataset.key || '';
    const item = fqFindItemByKey(key);
    if (!item) return;
    const field = el.dataset.fqField;
    try {
      if (field === 'inspector_id') {
        await fqSaveOverlay(item, { inspector_id: el.value || null });
      } else if (field === 'qa_due_date') {
        await fqSaveOverlay(item, { qa_due_date: el.value || null });
      }
    } catch (err) {
      console.error('overlay save failed:', err);
    }
  });

  tbody.addEventListener('blur', async (e) => {
    const el = e.target.closest('[data-fq-field="remarks"]');
    if (!el) return;
    const key = el.dataset.key || '';
    const item = fqFindItemByKey(key);
    if (!item || String(item.remarks || '') === String(el.value || '')) return;
    try {
      await fqSaveOverlay(item, { remarks: el.value || '' });
    } catch (err) {
      console.error('remarks save failed:', err);
    }
  }, true);
}

function fqBindEvents() {
  document.getElementById('fq-refresh')?.addEventListener('click', () => {
    const refreshPacked = fqState.view === 'recently_packed';
    if (refreshPacked) {
      fqLoadRecentlyPacked({ refresh: true });
      return;
    }
    fqLoad({ refresh: true, includePacked: false });
  });

  document.querySelectorAll('[data-fq-sort]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      fqSetSort(btn.dataset.fqSort || '');
    });
  });

  document.querySelectorAll('[data-fq-screen]').forEach((btn) => {
    btn.addEventListener('click', () => fqSetScreen(btn.dataset.fqScreen || 'queue'));
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
    if (e.target.closest('[data-fq-field]')) return;
    const cell = e.target.closest('.fq-open-detail');
    if (!cell) return;
    const row = e.target.closest('.fq-row');
    if (!row) return;
    const key = row.dataset.key || '';
    const item = fqFindItemByKey(key);
    if (item) fqOpenDetail(item);
  });

  document.getElementById('fq-table-body')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.fq-row');
    if (!row || e.target.closest('[data-fq-field]')) return;
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

  document.getElementById('fq-inspector-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('fq-inspector-name');
    const name = String(input?.value || '').trim();
    if (!name) return;
    try {
      await fqAddInspector(name);
      if (input) input.value = '';
    } catch (err) {
      alert(err.message || err);
    }
  });

  document.getElementById('fq-inspector-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-fq-remove-inspector]');
    if (!btn) return;
    const id = btn.dataset.fqRemoveInspector;
    if (!id || !window.confirm('Remove this inspector from the QC team?')) return;
    try {
      await fqRemoveInspector(id);
    } catch (err) {
      alert(err.message || err);
    }
  });

  fqBindOverlayEditors();
}

function fqInit() {
  try {
    fqBindPsTypeDropdown();
    fqBindEvents();
    if (window.__fqBootDone && window.__FQ_BOOTSTRAP_ERROR__) {
      return;
    }
    const bootErr = window.__FQ_BOOTSTRAP_ERROR__;
    if (bootErr) {
      fqShowLoadError(`Server could not load queue: ${bootErr}`);
      window.__fqBootDone = true;
      return;
    }
    const boot = window.__FQ_BOOTSTRAP__;
    if (boot && Array.isArray(boot.items)) {
      try {
        fqApplyPayload(boot);
        fqHideLoading();
      } catch (renderErr) {
        console.error('finishing queue render failed:', renderErr);
        fqShowLoadError(`Failed to render queue: ${renderErr.message || renderErr}`);
      }
      window.__fqBootDone = true;
      return;
    }
    fqLoad().finally(() => {
      window.__fqBootDone = true;
    });
  } catch (err) {
    console.error('finishing queue init failed:', err);
    fqShowLoadError(`Page setup failed: ${err.message || err}`);
    window.__fqBootDone = true;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', fqInit);
} else {
  fqInit();
}

window.addEventListener('error', (event) => {
  if (String(event?.filename || '').includes('finishing_queue.js')) {
    fqShowLoadError(`Script error: ${event.message || 'unknown error'}`);
  }
});
