// Post-machining queue — synced staging + planner QA overlays.
window.__fqPageScriptLoaded = true;

function fqApiUrl(key) {
  const cfg = window.__FQ_CONFIG__ || {};
  const urls = {
    queue: cfg.apiQueue || '/api/finishing-queue',
    overlay: cfg.apiOverlay || '/api/finishing-queue/overlay',
    inspectors: cfg.apiInspectors || '/api/finishing-queue/inspectors',
    woStatusSync: cfg.apiWoStatusSync || '/api/mfg-wo-status/sync',
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

const FQ_TABLE_COL_COUNT = 10;

const FQ_PS_TYPE_ORDER = ['APS', 'NPS', 'MPS', 'PPS', 'CPS', 'SR', 'TEMP'];
const FQ_PS_TYPES_DEFAULT = new Set(['APS', 'NPS']);

const fqState = {
  items: [],
  materialIssueItems: [],
  materialIssueHint: '',
  inspectors: [],
  inspectorBusy: false,
  assignmentCounts: {},
  screen: 'queue',
  stage: 'final_inspection',
  assignee: 'all',
  hideDone: false,
  psTypes: new Set(FQ_PS_TYPES_DEFAULT),
  sortCol: '',
  sortDir: 'asc',
  cachedAt: '',
  cacheTtlSec: 60,
  weekRanges: null,
  selectedKey: '',
  savingKeys: new Set(),
  dataSource: 'sync',
  loadHint: '',
  mi: {
    view: 'outstanding',
    search: '',
    outstanding: [],
    ready: [],
    historical: [],
    loaded: false,
    loading: false,
    error: '',
    cachedAt: '',
    savingVouchers: new Set(),
  },
  qcq: {
    view: 'outstanding',
    search: '',
    segments: new Set(FQ_PS_TYPES_DEFAULT),
    outstanding: [],
    historical: [],
    loaded: false,
    loading: false,
    error: '',
    cachedAt: '',
    totalCount: 0,
  },
};

function fqDateInputValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.slice(0, 10);
}

function fqParseDateOnlyUtc(value) {
  const text = fqDateInputValue(value);
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function fqParseDateOnly(value) {
  return fqParseDateOnlyUtc(value);
}

function fqCommitmentDate(itemOrValue) {
  if (itemOrValue && typeof itemOrValue === 'object') {
    return fqDateInputValue(itemOrValue.coway_proposed_edd)
      || fqDateInputValue(itemOrValue.commitment_date)
      || fqDateInputValue(itemOrValue.due_date);
  }
  return fqDateInputValue(itemOrValue);
}

function fqIsoCalendarWeek(value) {
  const date = fqParseDateOnlyUtc(value);
  if (!date) return '';
  const dayNum = date.getUTCDay() || 7;
  const thursday = new Date(date);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNum);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNo = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(weekNo).padStart(2, '0')}`;
}

const FQ_WEEKDAY_SHORT = ['Sun', 'Mon', 'Tues', 'Wed', 'Thu', 'Fri', 'Sat'];

function fqWeekNo(value) {
  const date = fqParseDateOnlyUtc(value);
  if (!date) return null;
  const dayNum = date.getUTCDay() || 7;
  const thursday = new Date(date);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
}

function fqWeekLabel(itemOrValue) {
  const commitment = fqCommitmentDate(itemOrValue);
  const weekNo = fqWeekNo(commitment);
  if (!weekNo) return '—';
  const date = fqParseDateOnlyUtc(commitment);
  const weekday = date
    ? ((typeof fqWeekdayShort === 'function') ? fqWeekdayShort(date.getUTCDay()) : FQ_WEEKDAY_SHORT[date.getUTCDay()])
    : '';
  if (!weekday) return (typeof fqT === 'function') ? fqT('week_label', { n: weekNo }) : `Week ${weekNo}`;
  return (typeof fqT === 'function')
    ? fqT('week_day', { n: weekNo, day: weekday })
    : `Week ${weekNo} - ${weekday}`;
}

function fqWeekCellMeta(item) {
  const coway = fqDateInputValue(item?.coway_proposed_edd);
  const due = fqDateInputValue(item?.due_date);
  const label = fqWeekLabel(item);
  if (label === '—') return { label, title: '' };
  const title = coway
    ? ((typeof fqT === 'function') ? fqT('from_coway_edd', { date: coway }) : `From Coway EDD (${coway})`)
    : due
      ? ((typeof fqT === 'function') ? fqT('from_po_due', { date: due }) : `From PO due (${due})`)
      : '';
  return { label, title };
}

function fqStartOfDay(value) {
  const d = value instanceof Date ? value : new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function fqImplicitAssigneeSort() {
  return fqState.screen === 'assignments' && fqState.assignee === 'all' && !fqState.sortCol;
}

function fqEffectiveSortCol() {
  if (fqState.sortCol) return fqState.sortCol;
  if (fqImplicitAssigneeSort()) return 'inspector_name';
  return '';
}

function fqEffectiveSortDir() {
  if (fqState.sortCol) return fqState.sortDir;
  return 'asc';
}

function fqShouldGroupByAssignee() {
  return fqState.screen === 'assignments'
    && fqState.assignee === 'all'
    && (!fqState.sortCol || fqState.sortCol === 'inspector_name');
}

function fqUnassignedLabel() {
  return (typeof fqT === 'function') ? fqT('unassigned_label') : 'Unassigned';
}

function fqAssigneeSortRank(label) {
  if (label === fqUnassignedLabel() || label === 'Unassigned') return 1;
  return 0;
}

function fqCompareAssigneeLabels(a, b, dir) {
  const desc = dir === 'desc';
  const rankA = fqAssigneeSortRank(a);
  const rankB = fqAssigneeSortRank(b);
  if (rankA !== rankB) return desc ? rankB - rankA : rankA - rankB;
  const cmp = a.localeCompare(b, undefined, { sensitivity: 'base' });
  return desc ? -cmp : cmp;
}

function fqRenderGroupRow(label, { count = 0, exceptions = 0, nextQa = '' } = {}) {
  const initial = (label === fqUnassignedLabel() || label === 'Unassigned') ? '?' : (label.trim().charAt(0).toUpperCase() || '?');
  const meta = [];
  if (count) {
    meta.push(typeof fqPlural === 'function'
      ? fqPlural('jobs_count', count)
      : `${count} job${count === 1 ? '' : 's'}`);
  }
  if (exceptions) {
    meta.push(typeof fqPlural === 'function'
      ? fqPlural('exceptions_count', exceptions)
      : `${exceptions} exception${exceptions === 1 ? '' : 's'}`);
  }
  if (nextQa && nextQa !== '—') {
    meta.push(typeof fqT === 'function' ? fqT('next_qa', { date: nextQa }) : `next QA ${nextQa}`);
  }
  const metaHtml = meta.length
    ? `<span class="fq-group-row-meta">${meta.map((m) => escapeHtml(m)).join(' · ')}</span>`
    : '';
  return `
    <tr class="fq-group-row">
      <td colspan="${FQ_TABLE_COL_COUNT}">
        <div class="fq-group-row-inner">
          <span class="fq-group-row-avatar" aria-hidden="true">${escapeHtml(initial)}</span>
          <span class="fq-group-row-name">${escapeHtml(label)}</span>
          ${metaHtml}
        </div>
      </td>
    </tr>
  `;
}

function fqActiveSourceItems() {
  if (fqState.screen === 'material_issue') {
    return fqState.materialIssueItems || [];
  }
  return fqState.items || [];
}

function fqIsMaterialIssueScreen() {
  return fqState.screen === 'material_issue';
}

function fqIsMaterialInspectionScreen() {
  return fqState.screen === 'material_inspection';
}

function fqIsQcQueueScreen() {
  return fqState.screen === 'qc_queue';
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

function fqFormatQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

function fqExecutionLabel(code) {
  if (typeof fqExecutionLabelI18n === 'function') return fqExecutionLabelI18n(code);
  const c = String(code || '').trim().toUpperCase();
  if (c === 'I' || c === 'IN_PROCESS') return 'In Process';
  if (c === 'R' || c === 'READY_TO_START') return 'Ready to Start';
  if (c === 'P' || c === 'PENDING_SI') return 'Pending SI';
  if (c === 'C' || c === 'COMPLETED') return 'Completed';
  return c || '—';
}

function fqStatusPill(code) {
  const c = String(code || '').trim().toUpperCase();
  let dotCls = 'fq-status-dot';
  if (c === 'I') dotCls += ' fq-status-dot--i';
  else if (c === 'R') dotCls += ' fq-status-dot--r';
  else if (c === 'P') dotCls += ' fq-status-dot--p';
  const label = fqExecutionLabel(c);
  return `<span class="fq-status-label" title="${escapeHtml(label)}"><span class="${dotCls}" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

function fqStageBadge(item) {
  const desc = (typeof fqStageDescI18n === 'function')
    ? fqStageDescI18n(item?.current_stage_desc)
    : (String(item?.current_stage_desc || '—').trim() || '—');
  const bucket = String(item?.stage_bucket || '').trim();
  const cls = bucket ? ` fq-stage-badge--${bucket}` : '';
  return `<span class="fq-stage-badge${cls}">${escapeHtml(desc)}</span>`;
}

function fqRowStatusClass(code) {
  const c = String(code || '').trim().toLowerCase();
  if (c === 'i' || c === 'r' || c === 'p') return ` fq-row--status-${c}`;
  return '';
}

function fqStageProgress(item) {
  const produced = Number(item?.stage_qty_produced);
  const required = Number(item?.stage_qty_required ?? item?.qty);
  if (!Number.isFinite(required) || required <= 0) return '—';
  const done = Number.isFinite(produced) ? produced : 0;
  return `${fqFormatQty(done)} / ${fqFormatQty(required)}`;
}

function fqStatusSortRank(code) {
  const c = String(code || '').trim().toUpperCase();
  if (c === 'P' || c === 'PENDING_SI') return 0;
  if (c === 'R' || c === 'READY_TO_START') return 1;
  if (c === 'I' || c === 'IN_PROCESS') return 2;
  if (c === 'C' || c === 'COMPLETED') return 3;
  return 9;
}

function fqSortValue(item, col) {
  if (col === 'pp_partial_no') return Number(item?.pp_partial_no || 0);
  if (col === 'ps_id') return String(item?.ps_id || '').trim();
  if (col === 'current_stage_desc') return String(item?.current_stage_desc || '').trim();
  if (col === 'current_stage_status') return fqStatusSortRank(item?.current_stage_status);
  if (col === 'inspector_name') return fqAssigneeLabel(item).toLowerCase();
  if (col === 'part_no') return String(item?.part_no || '').trim().toLowerCase();
  if (col === 'part_desc') return String(item?.part_desc || '').trim().toLowerCase();
  if (col === 'due_date' || col === 'coway_proposed_edd' || col === 'qa_due_date' || col === 'commitment_date') {
    if (col === 'commitment_date') {
      return fqCommitmentDate(item) || '';
    }
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
  if (fqEffectiveSortCol() !== col) return '↕';
  return fqEffectiveSortDir() === 'desc' ? '↓' : '↑';
}

function fqUpdateSortHeaders() {
  const activeCol = fqEffectiveSortCol();
  document.querySelectorAll('[data-fq-sort-col]').forEach((th) => {
    const col = th.dataset.fqSortCol || '';
    th.classList.toggle('is-sorted', col && col === activeCol);
  });
  document.querySelectorAll('[data-fq-sort-icon]').forEach((icon) => {
    const col = icon.dataset.fqSortIcon || '';
    icon.textContent = fqSortIcon(col);
  });
}

function fqIsTempPs(item) {
  const psId = String(item?.planner_ps_id || item?.ps_id || '').trim();
  return /^\[temp\]/i.test(psId);
}

function fqGetPsType(item) {
  if (fqIsTempPs(item)) return 'TEMP';
  const raw = String(item?.ps_id || '').split('::')[0];
  if (/\[sr\]|\(sr\)/i.test(raw) || raw.includes('[SR]')) return 'SR';
  const m = raw.toUpperCase().match(/^([A-Z]+)/);
  if (!m) return null;
  return m[1];
}

function fqMatchesPsType(item) {
  const types = fqState.psTypes;
  if (!types?.size) return false;
  if (types.size >= FQ_PS_TYPE_ORDER.length) return true;
  const psType = fqGetPsType(item);
  if (!psType) return false;
  return types.has(psType);
}

function fqQueueItemsMatchingPsTypes() {
  return (fqState.items || []).filter(fqMatchesPsType);
}

function fqMaterialIssueItemsMatchingPsTypes() {
  return (fqState.materialIssueItems || []).filter(fqMatchesPsType);
}

function fqItemsMatchingPsTypes() {
  if (fqState.screen === 'material_issue') {
    return fqMaterialIssueItemsMatchingPsTypes();
  }
  return fqQueueItemsMatchingPsTypes();
}

function fqFilteredItems() {
  const source = fqActiveSourceItems();

  const filtered = (source || []).filter((item) => {
    if (!fqMatchesPsType(item)) return false;
    if (!fqIsMaterialIssueScreen() && fqState.hideDone && item.checklist_done) return false;
    if (fqState.screen !== 'assignments' && !fqIsMaterialIssueScreen() && fqState.stage !== 'all' && item.stage_bucket !== fqState.stage) {
      return false;
    }
    if (fqState.screen === 'assignments' && fqState.assignee !== 'all') {
      const name = fqAssigneeLabel(item);
        if (fqState.assignee === '__unassigned__') {
        if (name !== fqUnassignedLabel() && name !== 'Unassigned') return false;
      } else if (name !== fqState.assignee) return false;
    }
    return true;
  });

  const sortCol = fqEffectiveSortCol();
  const sortDir = fqEffectiveSortDir();

  if (!sortCol) {
    return filtered.sort((a, b) => {
      const edd = fqCompareValues(
        fqSortValue(a, 'coway_proposed_edd'),
        fqSortValue(b, 'coway_proposed_edd'),
        'asc',
      );
      if (edd !== 0) return edd;
      const psCmp = fqCompareValues(fqSortValue(a, 'ps_id'), fqSortValue(b, 'ps_id'), 'asc');
      if (psCmp !== 0) return psCmp;
      return Number(a.pp_partial_no || 0) - Number(b.pp_partial_no || 0);
    });
  }

  return filtered.sort((a, b) => {
    if (sortCol === 'inspector_name') {
      const assigneeCmp = fqCompareAssigneeLabels(fqAssigneeLabel(a), fqAssigneeLabel(b), sortDir);
      if (assigneeCmp !== 0) return assigneeCmp;
    } else {
      const primary = fqCompareValues(
        fqSortValue(a, sortCol),
        fqSortValue(b, sortCol),
        sortDir,
      );
      if (primary !== 0) return primary;
    }
    const edd = fqCompareValues(
      fqSortValue(a, 'coway_proposed_edd'),
      fqSortValue(b, 'coway_proposed_edd'),
      'asc',
    );
    if (edd !== 0) return edd;
    const psCmp = fqCompareValues(fqSortValue(a, 'ps_id'), fqSortValue(b, 'ps_id'), 'asc');
    if (psCmp !== 0) return psCmp;
    return Number(a.pp_partial_no || 0) - Number(b.pp_partial_no || 0);
  });
}

function fqToast(message, type = 'info') {
  let el = document.getElementById('fq-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fq-toast';
    el.className = 'fq-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `fq-toast fq-toast--${type} is-visible`;
  clearTimeout(fqToast._timer);
  fqToast._timer = setTimeout(() => {
    el.classList.remove('is-visible');
  }, 2800);
}

function fqSetInspectorStatus(message, type = '') {
  const el = document.getElementById('fq-inspector-status');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    el.className = 'fq-inspector-status';
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = `fq-inspector-status fq-inspector-status--${type || 'info'}`;
}

async function fqReloadInspectors() {
  const res = await fetch(fqApiUrl('inspectors'));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  fqState.inspectors = data.inspectors || [];
  window.__FQ_INLINE_INSPECTORS__ = fqState.inspectors.slice();
  fqRenderInspectorPanel();
  return fqState.inspectors;
}

window.fqReloadInspectors = fqReloadInspectors;
window.fqToast = fqToast;
window.fqSetInspectorStatus = fqSetInspectorStatus;

function fqInspectorOptions(selectedId) {
  const opts = [`<option value="">${escapeHtml((typeof fqT === 'function') ? fqT('unassigned') : '— Unassigned —')}</option>`];
  for (const insp of fqState.inspectors || []) {
    const id = String(insp.inspector_id);
    const sel = String(selectedId || '') === id ? ' selected' : '';
    opts.push(`<option value="${escapeHtml(id)}"${sel}>${escapeHtml(insp.name || id)}</option>`);
  }
  return opts.join('');
}

function fqOverlayPayload(item, patch) {
  let partial = item.pp_partial_no;
  if (partial == null || partial === '') partial = 1;
  return {
    ps_id: item.ps_id,
    pp_partial_no: partial,
    stage_desc: item.current_stage_desc,
    ...patch,
  };
}

function fqOverlayContextFromEl(el) {
  if (!el) return null;
  const psId = String(el.dataset.fqPsId || '').trim();
  const stage = String(el.dataset.fqStageDesc || '').trim();
  const partialRaw = el.dataset.fqPartialNo;
  const ppPartialNo = partialRaw == null || partialRaw === '' ? 1 : Number(partialRaw) || 1;
  if (!psId || !stage) return null;
  return { ps_id: psId, pp_partial_no: ppPartialNo, current_stage_desc: stage };
}

function fqOverlayRowKey(ctx) {
  return `${ctx.ps_id}::${ctx.pp_partial_no}::${ctx.current_stage_desc}`;
}

function fqOverlayFieldAttrs(item) {
  const key = fqItemKey(item);
  const psId = escapeHtml(String(item?.ps_id || '').trim());
  const partial = escapeHtml(String(item?.pp_partial_no ?? 1));
  const stage = escapeHtml(String(item?.current_stage_desc || '').trim());
  return `data-key="${escapeHtml(key)}" data-fq-ps-id="${psId}" data-fq-partial-no="${partial}" data-fq-stage-desc="${stage}"`;
}

function fqOverlayControlHandlers(field) {
  if (field === 'remarks') {
    return 'onblur="window.fqHandleOverlayField&&window.fqHandleOverlayField(event,\'blur\')"';
  }
  return 'onchange="window.fqHandleOverlayField&&window.fqHandleOverlayField(event)"';
}

function fqSetFieldSaveStatus(el, status) {
  const wrap = el?.closest('.fq-field-wrap');
  const hint = wrap?.querySelector('.fq-save-hint');
  if (!hint) return;
  hint.className = `fq-save-hint${status ? ` fq-save-hint--${status}` : ''}`;
  if (status === 'saving') hint.textContent = (typeof fqT === 'function') ? fqT('saving') : 'Saving…';
  else if (status === 'saved') hint.textContent = (typeof fqT === 'function') ? fqT('saved') : 'Saved ✓';
  else if (status === 'error') hint.textContent = (typeof fqT === 'function') ? fqT('failed') : 'Failed';
  else hint.textContent = '';
  if (status === 'saved') {
    window.setTimeout(() => {
      if (hint.classList.contains('fq-save-hint--saved')) fqSetFieldSaveStatus(el, '');
    }, 2200);
  }
}

function fqSetDetailSaveStatus(message, type = 'info') {
  const el = document.getElementById('fq-detail-save-status');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    el.className = 'fq-detail-save-status';
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = `fq-detail-save-status fq-detail-save-status--${type}`;
}

function fqWrapEditableField(innerHtml, field) {
  return `<div class="fq-field-wrap" data-fq-field-wrap="${escapeHtml(field)}">${innerHtml}<span class="fq-save-hint" aria-live="polite"></span></div>`;
}

function fqJobCell(item) {
  const ps = escapeHtml(item.ps_id || '—');
  const partial = Number(item.pp_partial_no) > 1
    ? `<span class="fq-partial-tag">p${escapeHtml(String(item.pp_partial_no))}</span>`
    : '';
  const part = item.part_no
    ? `<span class="fq-part-sub">${escapeHtml(item.part_no)}</span>`
    : '';
  const qty = fqStageProgress(item);
  const qtyHtml = qty !== '—'
    ? `<span class="fq-qty-sub">${escapeHtml(qty)} ${(typeof fqT === 'function') ? fqT('pcs') : 'pcs'}</span>`
    : '';
  return `<div class="fq-job-cell"><span class="fq-job-ps">${ps}${partial}</span>${part}${qtyHtml}</div>`;
}

function fqResolveOverlayItem(el) {
  const ctx = fqOverlayContextFromEl(el);
  if (!ctx) {
    const key = String(el?.dataset?.key || '').trim();
    return key ? fqFindItemByKey(key) : null;
  }
  return fqFindItemByKey(fqOverlayRowKey(ctx)) || ctx;
}

function fqSyncOverlayToState(key, overlay) {
  const live = fqFindItemByKey(key);
  if (live) {
    Object.assign(live, {
      remarks: overlay.remarks ?? live.remarks,
      inspector_id: overlay.inspector_id ?? live.inspector_id,
      inspector_name: overlay.inspector_name ?? live.inspector_name,
      qa_due_date: overlay.qa_due_date ?? live.qa_due_date,
      checklist_done: overlay.checklist_done ?? live.checklist_done,
      exception_flag: overlay.exception_flag ?? live.exception_flag,
    });
  }
  const boot = window.__FQ_BOOTSTRAP__;
  if (boot?.items) {
    const bootItem = boot.items.find((row) => fqItemKey(row) === key);
    if (bootItem) {
      Object.assign(bootItem, {
        remarks: overlay.remarks ?? bootItem.remarks,
        inspector_id: overlay.inspector_id ?? bootItem.inspector_id,
        inspector_name: overlay.inspector_name ?? bootItem.inspector_name,
        qa_due_date: overlay.qa_due_date ?? bootItem.qa_due_date,
        checklist_done: overlay.checklist_done ?? bootItem.checklist_done,
        exception_flag: overlay.exception_flag ?? bootItem.exception_flag,
      });
    }
  }
}

async function fqParseJsonResponse(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 240) || `HTTP ${res.status}`);
  }
}

async function fqSaveOverlay(item, patch) {
  const key = fqItemKey(item);
  if (fqState.savingKeys.has(key)) return null;
  fqState.savingKeys.add(key);
  try {
    const payload = fqOverlayPayload(item, patch);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20000);
    const requestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
      signal: controller.signal,
    };
    let res = await fetch(fqApiUrl('overlay'), requestInit);
    if (res.status === 405 || res.status === 501) {
      res = await fetch(fqApiUrl('overlay'), { ...requestInit, method: 'PUT', signal: controller.signal });
    }
    window.clearTimeout(timer);
    const data = await fqParseJsonResponse(res);
    if (!res.ok) throw new Error(data.error || `Save failed (HTTP ${res.status})`);
    const overlay = data.overlay || {};
    fqSyncOverlayToState(key, overlay);
    fqRecalcAssignmentCounts();
    if (fqState.screen === 'assignments') fqRenderAssigneeBoard();
    return overlay;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Save timed out — try again');
    }
    throw err;
  } finally {
    fqState.savingKeys.delete(key);
  }
}

async function fqPersistOverlayField(el) {
  const field = el?.dataset?.fqField;
  if (!field) return;
  const ctx = fqOverlayContextFromEl(el);
  if (!ctx) {
    fqToast('Could not match this row — refresh the page', 'error');
    return;
  }
  const item = fqResolveOverlayItem(el);
  if (!item) {
    fqToast('Could not match this row — refresh the page', 'error');
    return;
  }

  let patch = {};
  let nextValue = '';
  if (field === 'inspector_id') {
    patch = { inspector_id: el.value ? el.value : null };
    nextValue = String(el.value || '');
    const prev = String(item.inspector_id || '');
    if (prev === nextValue) return;
  } else if (field === 'qa_due_date') {
    patch = { qa_due_date: el.value || null };
    nextValue = String(el.value || '');
    const prev = fqDateInputValue(item.qa_due_date);
    if (prev === nextValue) return;
  } else if (field === 'remarks') {
    patch = { remarks: el.value || '' };
    nextValue = String(el.value || '');
    if (String(item.remarks || '') === nextValue) return;
  } else {
    return;
  }

  try {
    fqSetFieldSaveStatus(el, 'saving');
    el.classList.add('fq-cell-saving');
    await fqSaveOverlay(item, patch);
    el.dataset.fqLastSaved = nextValue;
    el.classList.remove('fq-cell-saving');
    el.classList.add('fq-cell-saved');
    fqSetFieldSaveStatus(el, 'saved');
    window.setTimeout(() => el.classList.remove('fq-cell-saved'), 1400);
    const inDetail = Boolean(el.closest('#fq-detail-body'));
    if (inDetail) {
      fqSetDetailSaveStatus(
        field === 'inspector_id' ? 'Assignment saved ✓'
          : field === 'qa_due_date' ? 'QA due date saved ✓'
            : 'Remarks saved ✓',
        'success',
      );
      window.setTimeout(() => fqSetDetailSaveStatus('', ''), 2200);
    }
  } catch (err) {
    el.classList.remove('fq-cell-saving');
    fqSetFieldSaveStatus(el, 'error');
    if (el.closest('#fq-detail-body')) fqSetDetailSaveStatus(err.message || 'Save failed', 'error');
    console.error('overlay save failed:', err);
    fqToast(err.message || 'Save failed', 'error');
  }
}

window.fqHandleOverlayField = function fqHandleOverlayField(event, mode) {
  const el = event?.target;
  if (!el || el.disabled || !el.matches('[data-fq-field]')) return;
  const field = el.dataset.fqField;
  if (field === 'remarks') {
    if (mode !== 'blur') return;
  } else if (event.type === 'blur') {
    return;
  }
  void fqPersistOverlayField(el);
};

window.fqSaveOverlay = fqSaveOverlay;

function fqRecalcAssignmentCounts() {
  const counts = {};
  for (const item of fqItemsMatchingPsTypes()) {
    const name = String(item.inspector_name || '').trim() || fqUnassignedLabel();
    counts[name] = (counts[name] || 0) + 1;
  }
  fqState.assignmentCounts = counts;
}

function fqAssigneeLabel(item) {
  return String(item?.inspector_name || '').trim() || fqUnassignedLabel();
}

function fqIsAssignmentsView() {
  return fqState.screen === 'assignments';
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
  const fieldAttrs = fqOverlayFieldAttrs(item);
  const qaValue = escapeHtml(fqDateInputValue(item.qa_due_date));
  const remarksValue = escapeHtml(item.remarks || '');
  const t = (typeof fqT === 'function') ? fqT : (k) => k;
  const editHtml = `
    <section class="fq-detail-edit card">
      <h3 class="fq-detail-edit-title">${escapeHtml(t('detail_quick_edit'))}</h3>
      <div class="fq-detail-edit-grid">
        <label class="fq-detail-edit-field">
          <span>${escapeHtml(t('detail_qa_due'))}</span>
          ${fqWrapEditableField(`<input type="date" class="fq-cell-input fq-cell-date" data-fq-field="qa_due_date" ${fieldAttrs} ${fqOverlayControlHandlers('qa_due_date')} value="${qaValue}">`, 'qa_due_date')}
        </label>
        <label class="fq-detail-edit-field">
          <span>${escapeHtml(t('detail_assigned'))}</span>
          ${fqWrapEditableField(`<select class="fq-cell-input fq-cell-select" data-fq-field="inspector_id" ${fieldAttrs} ${fqOverlayControlHandlers('inspector_id')}>${fqInspectorOptions(item.inspector_id)}</select>`, 'inspector_id')}
        </label>
        <label class="fq-detail-edit-field fq-detail-edit-field--full">
          <span>${escapeHtml(t('detail_remarks'))}</span>
          ${fqWrapEditableField(`<textarea class="fq-cell-input fq-cell-remarks" rows="3" data-fq-field="remarks" ${fieldAttrs} ${fqOverlayControlHandlers('remarks')} placeholder="${escapeHtml(t('detail_remarks_placeholder'))}">${remarksValue}</textarea>`, 'remarks')}
        </label>
      </div>
    </section>
  `;
  const stageHtml = [
    fqDetailField(t('detail_field_stage'), (typeof fqStageDescI18n === 'function') ? fqStageDescI18n(item.current_stage_desc) : item.current_stage_desc),
    fqDetailField(t('detail_field_status'), fqExecutionLabel(item.current_stage_status)),
    fqDetailField(t('detail_field_progress'), fqStageProgress(item)),
    fqDetailField(t('detail_field_stage_required'), fqFormatQty(item.stage_qty_required)),
    fqDetailField(t('detail_field_stage_produced'), fqFormatQty(item.stage_qty_produced)),
    fqDetailField(t('detail_field_stage_rejected'), fqFormatQty(item.stage_qty_rejected)),
  ].join('');
  const psHtml = [
    fqDetailField(t('detail_field_ps'), item.ps_id, { mono: true }),
    fqDetailField(t('detail_field_partial'), item.pp_partial_no),
    fqDetailField(t('detail_field_part'), item.part_no, { mono: true }),
    fqDetailField(t('detail_field_description'), item.part_desc, { fullWidth: true }),
    fqDetailField(t('detail_field_po_due'), fqFormatDate(item.due_date)),
    fqDetailField(t('detail_field_coway_edd'), fqFormatDate(item.coway_proposed_edd)),
    fqDetailField(t('detail_field_delivery'), fqWeekLabel(item)),
    fqDetailField(t('detail_field_checklist'), item.checklist_done ? t('yes') : t('no')),
    fqDetailField(t('detail_field_exception'), item.exception_flag ? t('yes') : t('no')),
  ].join('');
  return [
    editHtml,
    fqDetailSection(t('detail_section_stage'), stageHtml),
    fqDetailSection(t('detail_section_job'), psHtml),
  ].join('');
}

function fqOpenDetail(item) {
  const panel = document.getElementById('fq-detail');
  const title = document.getElementById('fq-detail-title');
  const body = document.getElementById('fq-detail-body');
  if (!panel || !title || !body) return;
  fqState.selectedKey = fqItemKey(item);
  const partialLabel = Number(item.pp_partial_no) > 1
    ? ` · ${(typeof fqT === 'function') ? fqT('partial', { n: item.pp_partial_no }) : `partial ${item.pp_partial_no}`}`
    : '';
  title.textContent = `${item.ps_id || '—'}${partialLabel}`;
  body.innerHTML = fqRenderDetail(item);
  fqSetDetailSaveStatus('', '');
  panel.hidden = false;
  document.body.classList.add('new-orders-detail-open');
  fqRenderTable();
}

function fqCloseDetail() {
  const panel = document.getElementById('fq-detail');
  if (!panel) return;
  panel.hidden = true;
  fqState.selectedKey = '';
  document.body.classList.remove('new-orders-detail-open');
}

function fqSetNavCount(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  const n = Number(count) || 0;
  el.textContent = String(n);
  el.hidden = n <= 0;
}

function fqUpdateNavCounts() {
  const queueItems = fqQueueItemsMatchingPsTypes();
  const stageCounts = {
    deburring: 0,
    final_inspection: 0,
    packing: 0,
    engraving_packing: 0,
  };
  for (const item of queueItems) {
    const bucket = item.stage_bucket;
    if (bucket in stageCounts) stageCounts[bucket] += 1;
  }

  fqSetNavCount('fq-count-all', queueItems.length);
  fqSetNavCount('fq-count-deburring', stageCounts.deburring);
  fqSetNavCount('fq-count-final_inspection', stageCounts.final_inspection);
  fqSetNavCount('fq-count-packing', stageCounts.packing);
  fqSetNavCount('fq-count-engraving_packing', stageCounts.engraving_packing);
  fqSetNavCount('fq-count-material_issue', fqMaterialIssueItemsMatchingPsTypes().length);

  const miOutstanding = (fqState.mi.outstanding || []).length;
  const miReady = (fqState.mi.ready || []).length;
  const miHistorical = (fqState.mi.historical || []).length;
  fqSetNavCount('fq-count-material_inspection', miOutstanding);
  fqSetNavCount('fq-count-mi-outstanding', miOutstanding);
  fqSetNavCount('fq-count-mi-ready', miReady);
  fqSetNavCount('fq-count-mi-historical', miHistorical);

  const qcqOutstanding = fqQcqRowsMatchingSegments(fqState.qcq.outstanding || []).length;
  const qcqHistorical = fqQcqRowsMatchingSegments(fqState.qcq.historical || []).length;
  fqSetNavCount('fq-count-qc_queue', qcqOutstanding);
  fqSetNavCount('fq-count-qcq-outstanding', qcqOutstanding);
  fqSetNavCount('fq-count-qcq-historical', qcqHistorical);
}

function fqRecalcCounts() {
  fqUpdateNavCounts();
}

function fqUpdateCounts() {
  fqRecalcCounts();
}

function fqSyncPsTypeChips() {
  document.querySelectorAll('[data-fq-ps-type]').forEach((btn) => {
    const type = btn.dataset.fqPsType || '';
    const active = fqState.psTypes.has(type);
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function fqInitPsTypes() {
  try {
    const raw = localStorage.getItem('fq-ps-types-v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        fqState.psTypes = new Set(parsed.filter((t) => FQ_PS_TYPE_ORDER.includes(t)));
      }
    }
  } catch (_) {}
  if (!fqState.psTypes?.size) {
    fqState.psTypes = new Set(FQ_PS_TYPES_DEFAULT);
  }
  fqSyncPsTypeChips();
}

function fqTogglePsType(type) {
  if (!type || !FQ_PS_TYPE_ORDER.includes(type)) return;
  const next = new Set(fqState.psTypes);
  if (next.has(type)) {
    if (next.size <= 1) return;
    next.delete(type);
  } else {
    next.add(type);
  }
  fqState.psTypes = next;
  try {
    localStorage.setItem('fq-ps-types-v1', JSON.stringify([...fqState.psTypes]));
  } catch (_) {}
  fqSyncPsTypeChips();
  fqRecalcAssignmentCounts();
  fqRenderAssigneeBoard();
  fqRecalcCounts();
  fqRenderTable();
}

function fqFindItemByKey(key) {
  return fqState.items.find((rowItem) => fqItemKey(rowItem) === key);
}

function fqEditableCells(item) {
  const fieldAttrs = fqOverlayFieldAttrs(item);
  const qaValue = escapeHtml(fqDateInputValue(item.qa_due_date));
  return {
    qaDue: fqWrapEditableField(
      `<input type="date" class="fq-cell-input fq-cell-date fq-cell-date--compact" data-fq-field="qa_due_date" ${fieldAttrs} ${fqOverlayControlHandlers('qa_due_date')} value="${qaValue}">`,
      'qa_due_date',
    ),
    assignee: fqWrapEditableField(
      `<select class="fq-cell-input fq-cell-select fq-cell-select--compact" data-fq-field="inspector_id" ${fieldAttrs} ${fqOverlayControlHandlers('inspector_id')}>${fqInspectorOptions(item.inspector_id)}</select>`,
      'inspector_id',
    ),
  };
}

function fqRowActionCells(item) {
  const attrs = fqOverlayFieldAttrs(item);
  const done = Boolean(item.checklist_done);
  const flagged = Boolean(item.exception_flag);
  return `<div class="fq-row-actions">
    <button type="button" class="fq-icon-btn fq-icon-btn--done${done ? ' is-on' : ''}" data-fq-toggle="checklist_done" ${attrs} aria-pressed="${done ? 'true' : 'false'}" title="${done ? ((typeof fqT === 'function') ? fqT('mark_not_done') : 'Mark not done') : ((typeof fqT === 'function') ? fqT('mark_done') : 'Mark done')}">✓</button>
    <button type="button" class="fq-icon-btn fq-icon-btn--flag${flagged ? ' is-on' : ''}" data-fq-toggle="exception_flag" ${attrs} aria-pressed="${flagged ? 'true' : 'false'}" title="${flagged ? ((typeof fqT === 'function') ? fqT('clear_exception') : 'Clear exception') : ((typeof fqT === 'function') ? fqT('flag_exception') : 'Flag exception')}">!</button>
  </div>`;
}

function fqMaterialInPill(item) {
  const yes = Boolean(item?.material_in);
  return `<span class="fq-mia-pill ${yes ? 'fq-mia-pill--yes' : 'fq-mia-pill--no'}">${yes ? ((typeof fqT === 'function') ? fqT('yes') : 'Yes') : ((typeof fqT === 'function') ? fqT('no') : 'No')}</span>`;
}

function fqRenderMaterialIssueRow(item) {
  const psId = String(item?.ps_id || '').trim() || '—';
  const partial = Number(item?.pp_partial_no) > 1 ? item.pp_partial_no : null;
  return `
    <tr class="fq-row fq-row--material-issue">
      <td class="fq-col-sticky fq-col-sticky--job">
        <div class="fq-job-cell">
          <span class="fq-job-ps">${escapeHtml(psId)}</span>
          ${partial ? `<span class="fq-partial-tag">P${escapeHtml(partial)}</span>` : ''}
        </div>
        <span class="fq-stage-badge fq-stage-badge--material_issue">${escapeHtml((typeof fqStageDescI18n === 'function') ? fqStageDescI18n(item?.current_stage_desc || 'Material Issue & Assembly') : (item?.current_stage_desc || 'Material Issue & Assembly'))}</span>
      </td>
      <td class="fq-col-mono">${escapeHtml(item?.part_no || '—')}</td>
      <td>${escapeHtml(item?.part_desc || '—')}</td>
      <td>${fqStatusPill(item?.current_stage_status)}</td>
      <td class="fq-col-num">${escapeHtml(fqFormatQty(item?.qty))}</td>
      <td class="fq-col-num">${escapeHtml(fqFormatQty(item?.so_det_qty))}</td>
      <td class="fq-col-num">${escapeHtml(fqFormatQty(item?.qty_shipped))}</td>
      <td class="fq-col-date">${escapeHtml(fqFormatDate(item?.due_date))}</td>
      <td class="fq-col-date">${escapeHtml(fqFormatDate(item?.coway_proposed_edd))}</td>
      <td>${fqMaterialInPill(item)}</td>
      <td class="fq-col-remarks">${escapeHtml(item?.remarks || '—')}</td>
    </tr>
  `;
}

function fqRenderMaterialIssueTable() {
  fqUpdateScreenChrome();
  const filtered = fqFilteredItems();
  const miaWrap = document.getElementById('fq-mia-table-wrap');
  const qaWrap = document.getElementById('fq-table-wrap');
  const empty = document.getElementById('fq-empty');
  const emptyText = document.getElementById('fq-empty-text');
  const stats = document.getElementById('fq-stats');
  const meta = document.getElementById('fq-meta');
  const tbody = document.getElementById('fq-mia-table-body');

  if (qaWrap) qaWrap.hidden = true;
  fqHideLoading();

  if (!tbody || !miaWrap || !empty) {
    fqShowLoadError('Material issue table markup is missing from the page — hard refresh or restart the app.');
    return;
  }

  const hasAny = (fqState.materialIssueItems || []).length > 0;
  const hasPsFiltered = fqItemsMatchingPsTypes().length > 0;

  if (!hasAny) {
    miaWrap.hidden = true;
    empty.hidden = false;
    if (emptyText) {
      emptyText.textContent = fqState.materialIssueHint
        || ((typeof fqT === 'function') ? fqT('empty_mia') : 'No open jobs with an assembly WO stage (SO qty not fully shipped).');
    }
    if (stats) stats.textContent = '';
    if (meta) meta.hidden = true;
    fqUpdateNavCounts();
    return;
  }

  if (!hasPsFiltered) {
    miaWrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = (typeof fqT === 'function') ? fqT('empty_ps_types') : 'No jobs match the selected PS types.';
    if (stats) stats.textContent = '';
    fqUpdateNavCounts();
    return;
  }

  if (!filtered.length) {
    miaWrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = (typeof fqT === 'function') ? fqT('empty_ps_types') : 'No jobs match the selected PS types.';
  } else {
    miaWrap.hidden = false;
    empty.hidden = true;
    tbody.innerHTML = filtered.map((item) => fqRenderMaterialIssueRow(item)).join('');
  }

  if (stats) {
    stats.textContent = typeof fqPlural === 'function'
      ? fqPlural('stats_mia', filtered.length)
      : `${filtered.length} job${filtered.length === 1 ? '' : 's'} with assembly stage`;
  }
  if (meta) meta.hidden = true;
  fqUpdateNavCounts();
}

/* ── Material inspection screen (ERP QC inspections + QC-team assignment) ── */

function fqMiApiUrl() {
  const cfg = window.__FQ_CONFIG__ || {};
  return cfg.apiMaterialInspection || '/api/material-inspection';
}

function fqMiOverlayUrl() {
  const cfg = window.__FQ_CONFIG__ || {};
  return cfg.apiMaterialInspectionOverlay || '/api/material-inspection/overlay';
}

function fqMiVoucher(row) {
  return String(row?.inspection_voucher_no || '').trim();
}

function fqMiRowKey(row) {
  const insp = fqMiVoucher(row);
  const ship = String(row?.shipment_voucher_no || '').trim();
  const line = String(row?.shipment_line_item_no ?? '').trim();
  return `${insp}::${ship}::${line}`;
}

function fqMiActiveRows() {
  const view = fqState.mi.view;
  if (view === 'ready') return fqState.mi.ready || [];
  if (view === 'historical') return fqState.mi.historical || [];
  return fqState.mi.outstanding || [];
}

function fqMiViewLabel(view) {
  if (typeof window.fqMiViewLabelI18n === 'function') return window.fqMiViewLabelI18n(view);
  if (typeof fqT === 'function') {
    if (view === 'ready') return fqT('mi_ready');
    if (view === 'historical') return fqT('mi_historical');
    return fqT('mi_outstanding');
  }
  if (view === 'ready') return 'Ready';
  if (view === 'historical') return 'Historical';
  return 'Outstanding';
}

function fqMiStatusLabel(code) {
  const c = String(code || '').trim().toUpperCase();
  if (c === 'O') return (typeof fqT === 'function') ? fqT('mi_outstanding') : 'Outstanding';
  if (c === 'R') return (typeof fqT === 'function') ? fqT('status_ready_short') : 'Ready';
  if (c === 'H') return (typeof fqT === 'function') ? fqT('mi_historical') : 'Historical';
  return c || '—';
}

function fqMiCreatedTime(row) {
  const raw = row?.created_datetime;
  if (!raw) return 0;
  const t = new Date(String(raw).replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function fqMiSortRows(rows) {
  return [...(rows || [])].sort((a, b) => fqMiCreatedTime(b) - fqMiCreatedTime(a));
}

function fqMiRowSearchText(row) {
  return [
    row.inspection_voucher_no, row.po_no, row.supplier_name, row.shipment_voucher_no,
    row.shipment_line_item_no, row.grn_no, row.inspector_code, row.inspector_name,
    row.inventory_code, row.inventory_desc, row.assigned_inspector_name,
  ].map((v) => String(v == null ? '' : v).toLowerCase()).join(' ');
}

function fqMiFilterRows(rows) {
  const q = String(fqState.mi.search || '').trim().toLowerCase();
  if (!q) return rows || [];
  return (rows || []).filter((row) => fqMiRowSearchText(row).includes(q));
}

function fqMiFormatDate(value) {
  if (!value) return '—';
  const text = String(value).trim();
  return text.length >= 10 ? text.slice(0, 10) : text || '—';
}

function fqMiStatusPill(code) {
  const c = String(code || '').trim().toUpperCase();
  const cls = c === 'O' ? 'o' : c === 'R' ? 'r' : c === 'H' ? 'h' : '';
  const label = fqMiStatusLabel(c);
  return `<span class="fq-mi-status"><span class="fq-mi-pill fq-mi-pill--${cls}">${escapeHtml(c || '—')}</span>${escapeHtml(label)}</span>`;
}

function fqMiErpInspectorLabel(row) {
  return String(row?.inspector_name || row?.inspector_code || '').trim() || '—';
}

function fqMiRenderRow(row) {
  const voucher = fqMiVoucher(row);
  const isHistorical = fqState.mi.view === 'historical';
  const done = Boolean(row.assignment_done);
  const assigneeCell = isHistorical
    ? `<span class="fq-mi-inspector-stated">${escapeHtml(fqMiErpInspectorLabel(row))}</span>`
    : `<select class="fq-cell-input fq-cell-select fq-cell-select--compact" data-fq-mi-field="inspector_id" data-fq-mi-voucher="${escapeHtml(voucher)}">${fqInspectorOptions(row.assigned_inspector_id)}</select>`;
  const doneBtn = isHistorical
    ? ''
    : `<button type="button" class="fq-icon-btn fq-icon-btn--done${done ? ' is-on' : ''}" data-fq-mi-toggle="done" data-fq-mi-voucher="${escapeHtml(voucher)}" aria-pressed="${done ? 'true' : 'false'}" title="${done ? ((typeof fqT === 'function') ? fqT('mark_not_done') : 'Mark not done') : ((typeof fqT === 'function') ? fqT('mark_inspection_done') : 'Mark inspection done')}">✓</button>`;
  const desc = String(row.inventory_desc || '').trim();
  return `
    <tr class="fq-row fq-row--mi${!isHistorical && done ? ' fq-row--done' : ''}" data-mi-key="${escapeHtml(fqMiRowKey(row))}">
      <td class="fq-col-sticky fq-col-sticky--mi fq-col-mono">${escapeHtml(voucher || '—')}</td>
      <td class="fq-col-mono">${escapeHtml(String(row.po_no || '—'))}</td>
      <td>${escapeHtml(String(row.supplier_name || '—'))}</td>
      <td class="fq-col-mono">${escapeHtml(String(row.shipment_voucher_no || '—'))}</td>
      <td class="fq-col-mono">${escapeHtml(String(row.grn_no || '—'))}</td>
      <td class="fq-col-date">${escapeHtml(fqMiFormatDate(row.actual_arrival_date || row.goods_receipt_date))}</td>
      <td class="fq-col-mono">${escapeHtml(String(row.inventory_code || '—'))}</td>
      <td class="fq-col-desc" title="${escapeHtml(desc)}">${escapeHtml(desc || '—')}</td>
      <td class="fq-col-num">${escapeHtml(row.receiving_qty == null ? '—' : String(row.receiving_qty))}</td>
      <td>${fqMiStatusPill(row.status)}</td>
      <td class="fq-col-mi-assignee${isHistorical ? ' fq-col-mi-assignee--stated' : ' fq-col-edit'}">${assigneeCell}</td>
      <td class="fq-col-mi-done">${doneBtn}</td>
    </tr>
  `;
}

function fqMiSyncToolbarChrome() {
  const toolbar = document.getElementById('fq-mi-toolbar');
  if (toolbar) toolbar.hidden = !fqIsMaterialInspectionScreen();
  document.querySelectorAll('[data-fq-mi-view]').forEach((btn) => {
    const active = btn.dataset.fqMiView === fqState.mi.view;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  fqUpdateNavCounts();
}

function fqRenderMaterialInspectionTable() {
  fqUpdateScreenChrome();
  fqMiSyncToolbarChrome();

  const wrap = document.getElementById('fq-mi-table-wrap');
  const tbody = document.getElementById('fq-mi-table-body');
  const empty = document.getElementById('fq-empty');
  const emptyText = document.getElementById('fq-empty-text');
  const stats = document.getElementById('fq-stats');
  const meta = document.getElementById('fq-meta');

  document.getElementById('fq-table-wrap')?.setAttribute('hidden', '');
  document.getElementById('fq-mia-table-wrap')?.setAttribute('hidden', '');
  fqHideLoading();

  if (!wrap || !tbody || !empty) {
    fqShowLoadError('Material inspection table markup is missing — hard refresh the page.');
    return;
  }

  if (fqState.mi.loading && !fqState.mi.loaded) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = (typeof fqT === 'function') ? fqT('loading_mi') : 'Loading material inspections…';
    if (stats) stats.textContent = (typeof fqT === 'function') ? fqT('loading_short') : 'Loading…';
    if (meta) meta.hidden = true;
    fqUpdateNavCounts();
    return;
  }

  if (fqState.mi.error) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = fqState.mi.error;
    if (stats) stats.textContent = '';
    if (meta) meta.hidden = true;
    fqUpdateNavCounts();
    return;
  }

  const filtered = fqMiSortRows(fqMiFilterRows(fqMiActiveRows()));
  const viewLabel = fqMiViewLabel(fqState.mi.view);
  const isHistorical = fqState.mi.view === 'historical';

  wrap.classList.toggle('fq-table-card--mi-historical', isHistorical);
  const assigneeHead = wrap.querySelector('th.fq-col-mi-assignee');
  const doneHead = wrap.querySelector('th.fq-col-mi-done');
  if (assigneeHead) {
    assigneeHead.textContent = isHistorical
      ? ((typeof fqT === 'function') ? fqT('mi_col_inspector') : 'Inspector')
      : ((typeof fqT === 'function') ? fqT('mi_col_assigned_to') : 'Assigned to');
  }
  if (doneHead) doneHead.hidden = isHistorical;

  if (!filtered.length) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) {
      emptyText.textContent = fqState.mi.search
        ? ((typeof fqT === 'function') ? fqT('empty_mi_search') : 'No inspections match your search in this view.')
        : ((typeof fqT === 'function') ? fqT('empty_mi_none', { view: viewLabel }) : `No ${viewLabel.toLowerCase()} inspections right now.`);
    }
  } else {
    wrap.hidden = false;
    empty.hidden = true;
    tbody.innerHTML = filtered.map((row) => fqMiRenderRow(row)).join('');
  }

  if (stats) {
    const o = (fqState.mi.outstanding || []).length;
    const r = (fqState.mi.ready || []).length;
    const h = (fqState.mi.historical || []).length;
    stats.textContent = (typeof fqT === 'function')
      ? fqT('stats_mi', { view: viewLabel, n: filtered.length, o, r, h })
      : `${viewLabel}: ${filtered.length} · O ${o} · R ${r} · H ${h}`;
  }
  if (meta) {
    meta.hidden = !fqState.mi.cachedAt;
    meta.textContent = fqState.mi.cachedAt
      ? ((typeof fqT === 'function')
        ? fqT('meta_mi', { at: fqState.mi.cachedAt })
        : `Material inspection · live COMAIN ERP read · cached ${fqState.mi.cachedAt} · assign a QC team member to plan the work`)
      : '';
  }
  fqUpdateNavCounts();
}

function fqMiApplyRows(payload) {
  const collect = (list) => (Array.isArray(list) ? list : []);
  fqState.mi.outstanding = collect(payload.outstanding);
  fqState.mi.ready = collect(payload.ready);
  fqState.mi.historical = collect(payload.historical);
  fqState.mi.cachedAt = payload.cached_at || '';
  if (Array.isArray(payload.inspectors) && payload.inspectors.length) {
    fqState.inspectors = payload.inspectors;
    window.__FQ_INLINE_INSPECTORS__ = fqState.inspectors.slice();
  }
}

async function fqLoadMaterialInspection({ refresh = false } = {}) {
  if (fqState.mi.loading) return;
  fqState.mi.loading = true;
  fqState.mi.error = '';
  if (fqIsMaterialInspectionScreen()) fqRenderMaterialInspectionTable();
  try {
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');
    const qs = params.toString();
    const url = qs ? `${fqMiApiUrl()}?${qs}` : fqMiApiUrl();
    const payload = await fqFetchJson(url);
    fqMiApplyRows(payload);
    fqState.mi.loaded = true;
  } catch (err) {
    fqState.mi.error = `Failed to load material inspections: ${err.message || err}`;
  } finally {
    fqState.mi.loading = false;
    fqUpdateNavCounts();
    if (fqIsMaterialInspectionScreen()) {
      fqRenderMaterialInspectionTable();
    }
  }
}

function fqMiEachVoucherRow(voucher, fn) {
  const target = String(voucher || '').trim();
  if (!target) return;
  for (const list of [fqState.mi.outstanding, fqState.mi.ready, fqState.mi.historical]) {
    for (const row of list || []) {
      if (fqMiVoucher(row) === target) fn(row);
    }
  }
}

async function fqSaveMiOverlay(voucher, patch) {
  const target = String(voucher || '').trim();
  if (!target || fqState.mi.savingVouchers.has(target)) return null;
  fqState.mi.savingVouchers.add(target);
  try {
    const body = JSON.stringify({ inspection_voucher_no: target, ...patch });
    const requestInit = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body,
    };
    let res = await fetch(fqMiOverlayUrl(), requestInit);
    if (res.status === 405 || res.status === 501) {
      res = await fetch(fqMiOverlayUrl(), { ...requestInit, method: 'POST' });
    }
    const data = await fqParseJsonResponse(res);
    if (!res.ok) throw new Error(data.error || `Save failed (HTTP ${res.status})`);
    const overlay = data.overlay || {};
    fqMiEachVoucherRow(target, (row) => {
      row.assigned_inspector_id = overlay.inspector_id ?? null;
      row.assigned_inspector_name = overlay.inspector_name ?? '';
      row.assignment_done = Boolean(overlay.done);
      row.assignment_remarks = overlay.remarks ?? '';
    });
    return overlay;
  } finally {
    fqState.mi.savingVouchers.delete(target);
  }
}

function fqSetMiView(view) {
  const next = ['ready', 'historical'].includes(view) ? view : 'outstanding';
  fqState.mi.view = next;
  fqRenderMaterialInspectionTable();
}

function fqBindMaterialInspection() {
  if (window.__fqMiBound) return;
  window.__fqMiBound = true;

  document.querySelectorAll('[data-fq-mi-view]').forEach((btn) => {
    btn.addEventListener('click', () => fqSetMiView(btn.dataset.fqMiView || 'outstanding'));
  });

  const search = document.getElementById('fq-mi-search');
  if (search) {
    search.addEventListener('input', () => {
      fqState.mi.search = search.value;
      if (fqIsMaterialInspectionScreen()) fqRenderMaterialInspectionTable();
    });
  }

  const tbody = document.getElementById('fq-mi-table-body');
  if (tbody) {
    tbody.addEventListener('change', async (e) => {
      const el = e.target.closest('[data-fq-mi-field="inspector_id"]');
      if (!el) return;
      const voucher = el.dataset.fqMiVoucher || '';
      el.classList.add('fq-cell-saving');
      try {
        await fqSaveMiOverlay(voucher, { inspector_id: el.value || '' });
        el.classList.remove('fq-cell-saving');
        el.classList.add('fq-cell-saved');
        window.setTimeout(() => el.classList.remove('fq-cell-saved'), 1400);
        fqRenderMaterialInspectionTable();
        fqToast((typeof fqT === 'function') ? fqT('toast_assignment_saved') : 'Assignment saved', 'success');
      } catch (err) {
        el.classList.remove('fq-cell-saving');
        fqToast(err.message || 'Save failed', 'error');
      }
    });

    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-fq-mi-toggle="done"]');
      if (!btn) return;
      const voucher = btn.dataset.fqMiVoucher || '';
      let nextDone = true;
      fqMiEachVoucherRow(voucher, (row) => { nextDone = !row.assignment_done; });
      btn.disabled = true;
      try {
        await fqSaveMiOverlay(voucher, { done: nextDone });
        fqRenderMaterialInspectionTable();
        fqToast(nextDone
          ? ((typeof fqT === 'function') ? fqT('toast_inspection_done') : 'Marked inspection done ✓')
          : ((typeof fqT === 'function') ? fqT('toast_unmarked') : 'Unmarked'), nextDone ? 'success' : 'info');
      } catch (err) {
        fqToast(err.message || 'Save failed', 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }
}

/* ── QC queue screen (ERP qc_quality_inspection · type M · status O/H) ── */

const FQ_QCQ_DISPLAY_CAP = 500;

function fqQcqApiUrl() {
  const cfg = window.__FQ_CONFIG__ || {};
  return cfg.apiQcQualityQueue || '/api/qc-quality-queue';
}

function fqQcqVoucher(row) {
  return String(row?.inspection_voucher_no || '').trim();
}

function fqQcqViewLabel(view) {
  return fqMiViewLabel(view === 'historical' ? 'historical' : 'outstanding');
}

function fqQcqActiveRows() {
  return fqState.qcq.view === 'historical'
    ? (fqState.qcq.historical || [])
    : (fqState.qcq.outstanding || []);
}

function fqQcqFormatDate(value) {
  if (!value) return '—';
  const text = String(value).trim();
  if (text.length >= 16) return text.slice(0, 16).replace('T', ' ');
  return text.length >= 10 ? text.slice(0, 10) : text || '—';
}

function fqQcqPartLabel(row) {
  return String(
    row?.wo_part_no || row?.job_lot_part_no || row?.alloc_wo_part_no || row?.inventory_code || '',
  ).trim() || '—';
}

function fqQcqWoNo(row) {
  return String(row?.wo_voucher_no || row?.work_order_no || row?.header_work_order_no || '').trim() || '—';
}

function fqQcqMpsNo(row) {
  return String(row?.mps_no || row?.alloc_source_mps_no || '').trim() || '—';
}

function fqQcqProcessSheetNo(row) {
  return String(row?.process_sheet_no || '').trim() || '—';
}

function fqQcqSegmentCode(row) {
  const code = String(row?.wo_segment_code || '').trim().toUpperCase();
  return FQ_PS_TYPE_ORDER.includes(code) ? code : null;
}

function fqQcqMatchesSegment(row) {
  const segments = fqState.qcq.segments;
  if (!segments?.size) return false;
  if (segments.size >= FQ_PS_TYPE_ORDER.length) return true;
  const code = fqQcqSegmentCode(row);
  if (!code) return false;
  return segments.has(code);
}

function fqQcqRowsMatchingSegments(rows) {
  return (rows || []).filter(fqQcqMatchesSegment);
}

function fqQcqSegmentLabel() {
  const checked = FQ_PS_TYPE_ORDER.filter((t) => fqState.qcq.segments.has(t));
  if (!checked.length) return 'None';
  if (checked.length >= FQ_PS_TYPE_ORDER.length) return 'All segments';
  return checked.join(', ');
}

function fqInitQcqSegments() {
  try {
    const raw = localStorage.getItem('fq-qcq-segments-v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        fqState.qcq.segments = new Set(parsed.filter((t) => FQ_PS_TYPE_ORDER.includes(t)));
      }
    }
  } catch (_) {}
  if (!fqState.qcq.segments?.size) {
    fqState.qcq.segments = new Set(FQ_PS_TYPES_DEFAULT);
  }
  fqQcqSyncSegmentDropdown();
}

function fqQcqPersistSegments() {
  try {
    localStorage.setItem('fq-qcq-segments-v1', JSON.stringify([...fqState.qcq.segments]));
  } catch (_) {}
}

function fqQcqSyncSegmentDropdown() {
  const btn = document.getElementById('fq-qcq-segment-btn');
  const panel = document.getElementById('fq-qcq-segment-panel');
  if (!btn || !panel) return;
  btn.textContent = `${fqQcqSegmentLabel()} ▾`;
  panel.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = fqState.qcq.segments.has(input.value);
  });
}

function fqQcqInspector(row) {
  return String(row?.inspector_code || row?.job_inspector_code || '').trim() || '—';
}

function fqQcqWoStatusPill(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return '—';
  const label = c === 'I' ? 'In process' : c === 'R' ? 'Ready' : c === 'C' ? 'Completed' : c === 'P' ? 'Pending' : c;
  return `<span class="fq-mi-pill fq-mi-pill--${c === 'R' ? 'r' : c === 'C' || c === 'H' ? 'h' : 'o'}">${escapeHtml(label)}</span>`;
}

function fqQcqRowKey(row) {
  const voucher = fqQcqVoucher(row);
  const lotSeq = String(row?.job_lot_seq_no ?? row?.lot_seq_no ?? '').trim();
  return lotSeq ? `${voucher}::${lotSeq}` : voucher;
}

function fqQcqRowSearchText(row) {
  return [
    row.inspection_voucher_no, row.wo_voucher_no, row.work_order_no, row.mps_no,
    row.alloc_source_mps_no, row.process_sheet_no, row.wo_part_no, row.job_lot_part_no, row.so_no,
    row.wo_stage_desc, row.inspector_code, row.job_inspector_code, row.ncr_voucher_no,
    row.reference_no, row.alloc_wo_voucher_no, row.wo_segment_code,
  ].map((v) => String(v == null ? '' : v).toLowerCase()).join(' ');
}

function fqQcqSortRows(rows) {
  const list = [...(rows || [])];
  if (fqState.qcq.view === 'outstanding') {
    return list.sort((a, b) => fqQcqVoucher(b).localeCompare(fqQcqVoucher(a)));
  }
  return list;
}

function fqQcqFilterRows(rows) {
  const q = String(fqState.qcq.search || '').trim().toLowerCase();
  if (!q) return rows || [];
  return (rows || []).filter((row) => fqQcqRowSearchText(row).includes(q));
}

function fqQcqVisibleRows(rows) {
  return fqQcqFilterRows(fqQcqRowsMatchingSegments(rows || []));
}

function fqQcqStatusPill(code) {
  const c = String(code || '').trim().toUpperCase();
  const cls = c === 'O' ? 'o' : c === 'R' ? 'r' : c === 'H' ? 'h' : '';
  const label = fqMiStatusLabel(c);
  return `<span class="fq-mi-status"><span class="fq-mi-pill fq-mi-pill--${cls}">${escapeHtml(c || '—')}</span>${escapeHtml(label)}</span>`;
}

function fqQcqRenderRow(row) {
  const voucher = fqQcqVoucher(row);
  const part = fqQcqPartLabel(row);
  return `
    <tr class="fq-row fq-row--qcq" data-qcq-key="${escapeHtml(fqQcqRowKey(row))}">
      <td class="fq-col-sticky fq-col-sticky--mi fq-col-mono">${escapeHtml(voucher || '—')}</td>
      <td class="fq-col-mono">${escapeHtml(fqQcqWoNo(row))}</td>
      <td class="fq-col-mono">${escapeHtml(fqQcqMpsNo(row))}</td>
      <td class="fq-col-ps">${escapeHtml(fqQcqProcessSheetNo(row))}</td>
      <td class="fq-col-mono">${escapeHtml(fqQcqSegmentCode(row) || '—')}</td>
      <td class="fq-col-mono" title="${escapeHtml(part)}">${escapeHtml(part)}</td>
      <td>${escapeHtml(String(row.wo_stage_desc || row.alloc_wo_stage_desc || '—'))}</td>
      <td class="fq-col-mono">${escapeHtml(String(row.so_no || '—'))}</td>
      <td class="fq-col-num">${escapeHtml(row.wo_qty_required == null ? '—' : String(row.wo_qty_required))}</td>
      <td class="fq-col-num">${escapeHtml(row.job_qty_assigned == null ? '—' : String(row.job_qty_assigned))}</td>
      <td>${fqQcqStatusPill(row.status)}</td>
      <td>${fqQcqWoStatusPill(row.wo_execution_status)}</td>
      <td>${escapeHtml(fqQcqInspector(row))}</td>
      <td class="fq-col-date">${escapeHtml(fqQcqFormatDate(row.actual_start_date))}</td>
      <td class="fq-col-date">${escapeHtml(fqQcqFormatDate(row.actual_end_date))}</td>
      <td class="fq-col-mono">${escapeHtml(String(row.ncr_voucher_no || '—'))}</td>
    </tr>
  `;
}

function fqQcqSyncToolbarChrome() {
  const toolbar = document.getElementById('fq-qcq-toolbar');
  if (toolbar) toolbar.hidden = !fqIsQcQueueScreen();
  document.querySelectorAll('[data-fq-qcq-view]').forEach((btn) => {
    const active = btn.dataset.fqQcqView === fqState.qcq.view;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  fqUpdateNavCounts();
}

function fqQcqRowsForDisplay() {
  const filtered = fqQcqSortRows(fqQcqVisibleRows(fqQcqActiveRows()));
  const q = String(fqState.qcq.search || '').trim();
  if (q || fqState.qcq.view !== 'historical') return filtered;
  if (filtered.length <= FQ_QCQ_DISPLAY_CAP) return filtered;
  return filtered.slice(-FQ_QCQ_DISPLAY_CAP);
}

function fqRenderQcQueueTable() {
  fqUpdateScreenChrome();
  fqQcqSyncToolbarChrome();

  const wrap = document.getElementById('fq-qcq-table-wrap');
  const tbody = document.getElementById('fq-qcq-table-body');
  const empty = document.getElementById('fq-empty');
  const emptyText = document.getElementById('fq-empty-text');
  const stats = document.getElementById('fq-stats');
  const meta = document.getElementById('fq-meta');

  document.getElementById('fq-table-wrap')?.setAttribute('hidden', '');
  document.getElementById('fq-mia-table-wrap')?.setAttribute('hidden', '');
  document.getElementById('fq-mi-table-wrap')?.setAttribute('hidden', '');

  fqHideLoading();

  if (!wrap || !tbody || !empty) {
    fqShowLoadError('QC queue table markup is missing from the page — hard refresh or restart the app.');
    return;
  }

  if (fqState.qcq.loading && !fqState.qcq.loaded) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = (typeof fqT === 'function') ? fqT('loading_qcq') : 'Loading ERP QC queue…';
    if (stats) stats.textContent = '';
    if (meta) meta.hidden = true;
    fqUpdateNavCounts();
    return;
  }

  if (fqState.qcq.error) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = fqState.qcq.error;
    if (stats) stats.textContent = '';
    if (meta) meta.hidden = true;
    fqUpdateNavCounts();
    return;
  }

  const viewLabel = fqQcqViewLabel(fqState.qcq.view);
  const sourceRows = fqQcqActiveRows();
  const segmentRows = fqQcqRowsMatchingSegments(sourceRows);
  const filtered = fqQcqVisibleRows(sourceRows);
  const displayRows = fqQcqRowsForDisplay();
  const capped = fqState.qcq.view === 'historical'
    && !String(fqState.qcq.search || '').trim()
    && filtered.length > FQ_QCQ_DISPLAY_CAP;

  if (!displayRows.length) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) {
      if (fqState.qcq.search) {
        emptyText.textContent = (typeof fqT === 'function')
          ? fqT('empty_qcq_search', { view: viewLabel })
          : `No ${viewLabel.toLowerCase()} QC records match your search.`;
      } else if (sourceRows.length && !segmentRows.length) {
        emptyText.textContent = (typeof fqT === 'function')
          ? fqT('empty_qcq_segment', { view: viewLabel })
          : `No ${viewLabel.toLowerCase()} records match the selected segment filter.`;
      } else {
        emptyText.textContent = (typeof fqT === 'function')
          ? fqT('empty_qcq_none', { view: viewLabel })
          : `No ${viewLabel.toLowerCase()} records in the ERP QC queue.`;
      }
    }
  } else {
    wrap.hidden = false;
    empty.hidden = true;
    tbody.innerHTML = displayRows.map((row) => fqQcqRenderRow(row)).join('');
  }

  if (stats) {
    const o = (fqState.qcq.outstanding || []).length;
    const h = (fqState.qcq.historical || []).length;
    const segO = fqQcqRowsMatchingSegments(fqState.qcq.outstanding || []).length;
    const segH = fqQcqRowsMatchingSegments(fqState.qcq.historical || []).length;
    const segmentNote = (segO !== o || segH !== h)
      ? ` · ${fqQcqSegmentLabel()}`
      : '';
    stats.textContent = ((typeof fqT === 'function')
      ? fqT('stats_qcq', { view: viewLabel, n: filtered.length, o: segO, h: segH, total: fqState.qcq.totalCount || o + h })
      : `${viewLabel}: ${filtered.length} shown · ${segO} O · ${segH} H · ${fqState.qcq.totalCount || o + h} total ERP records`) + segmentNote;
  }

  if (meta) {
    meta.hidden = !fqState.qcq.cachedAt;
    let text = fqState.qcq.cachedAt
      ? ((typeof fqT === 'function')
        ? fqT('meta_qcq', { at: fqState.qcq.cachedAt })
        : `QC queue · live COMAIN ERP · inspection + job assignment + mfg WO · cached ${fqState.qcq.cachedAt}`)
      : '';
    if (capped) {
      text += ` · showing ${FQ_QCQ_DISPLAY_CAP} most recent of ${filtered.length}`;
    }
    meta.textContent = text;
    meta.hidden = !text;
  }
  fqUpdateNavCounts();
}

function fqQcqApplyRows(payload) {
  const collect = (rows) => (Array.isArray(rows) ? rows : []);
  fqState.qcq.outstanding = collect(payload.outstanding);
  fqState.qcq.historical = collect(payload.historical);
  fqState.qcq.totalCount = Number(payload.count)
    || fqState.qcq.outstanding.length + fqState.qcq.historical.length;
  fqState.qcq.cachedAt = payload.cached_at || '';
}

async function fqLoadQcQueue({ refresh = false } = {}) {
  if (fqState.qcq.loading) return;
  fqState.qcq.loading = true;
  fqState.qcq.error = '';
  if (fqIsQcQueueScreen()) fqRenderQcQueueTable();
  try {
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');
    const qs = params.toString();
    const url = qs ? `${fqQcqApiUrl()}?${qs}` : fqQcqApiUrl();
    const payload = await fqFetchJson(url, { timeoutMs: 120000 });
    fqQcqApplyRows(payload);
    fqState.qcq.loaded = true;
  } catch (err) {
    fqState.qcq.error = `Failed to load QC queue: ${err.message || err}`;
  } finally {
    fqState.qcq.loading = false;
    fqUpdateNavCounts();
    if (fqIsQcQueueScreen()) {
      fqRenderQcQueueTable();
    }
  }
}

function fqSetQcqView(view) {
  fqState.qcq.view = view === 'historical' ? 'historical' : 'outstanding';
  fqRenderQcQueueTable();
}

function fqBindQcQueueSegmentDropdown() {
  const btn = document.getElementById('fq-qcq-segment-btn');
  const panel = document.getElementById('fq-qcq-segment-panel');
  if (!btn || !panel) return;

  fqQcqSyncSegmentDropdown();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) {
      panel.hidden = true;
    }
  });
  panel.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      const checked = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value);
      if (!checked.length) {
        input.checked = true;
        return;
      }
      fqState.qcq.segments = new Set(checked);
      fqQcqPersistSegments();
      fqQcqSyncSegmentDropdown();
      fqUpdateNavCounts();
      if (fqIsQcQueueScreen()) fqRenderQcQueueTable();
    });
  });
}

function fqBindQcQueue() {
  if (window.__fqQcqBound) return;
  window.__fqQcqBound = true;

  fqBindQcQueueSegmentDropdown();

  document.querySelectorAll('[data-fq-qcq-view]').forEach((btn) => {
    btn.addEventListener('click', () => fqSetQcqView(btn.dataset.fqQcqView || 'outstanding'));
  });

  const search = document.getElementById('fq-qcq-search');
  if (search) {
    search.addEventListener('input', () => {
      fqState.qcq.search = search.value;
      if (fqIsQcQueueScreen()) fqRenderQcQueueTable();
    });
  }
}

function fqRenderDataRow(item) {
  const key = fqItemKey(item);
  const selected = key === fqState.selectedKey ? ' is-selected' : '';
  const statusCls = fqRowStatusClass(item.current_stage_status);
  const doneCls = item.checklist_done ? ' fq-row--done' : '';
  const exceptionCls = item.exception_flag ? ' fq-row--exception' : '';
  const cells = fqEditableCells(item);
  const attrs = fqOverlayFieldAttrs(item);
  const schedule = fqWeekCellMeta(item);
  return `
    <tr class="fq-row${selected}${statusCls}${doneCls}${exceptionCls}" data-key="${escapeHtml(key)}" tabindex="0">
      <td class="fq-col-actions fq-col-sticky">${fqRowActionCells(item)}</td>
      <td class="fq-col-sticky fq-col-sticky--job fq-open-detail">${fqJobCell(item)}</td>
      <td class="fq-open-detail">${fqStageBadge(item)}</td>
      <td class="fq-open-detail">${fqStatusPill(item.current_stage_status)}</td>
      <td class="fq-open-detail fq-col-date">${escapeHtml(fqFormatDate(item.due_date))}</td>
      <td class="fq-open-detail fq-col-date">${escapeHtml(fqFormatDate(item.coway_proposed_edd))}</td>
      <td class="fq-open-detail fq-col-schedule"${schedule.title ? ` title="${escapeHtml(schedule.title)}"` : ''}>${escapeHtml(schedule.label)}</td>
      <td class="fq-col-edit">${cells.qaDue}</td>
      <td class="fq-col-edit fq-col-assignee">${cells.assignee}</td>
      <td class="fq-col-more">
        <button type="button" class="fq-more-btn" data-fq-open-detail ${attrs} title="${(typeof fqT === 'function') ? fqT('open_details') : 'Open full details'}">⋯</button>
      </td>
    </tr>
  `;
}

function fqSyncHideDoneChrome() {
  const btn = document.getElementById('fq-hide-done');
  if (!btn) return;
  btn.classList.toggle('is-active', fqState.hideDone);
  btn.setAttribute('aria-pressed', fqState.hideDone ? 'true' : 'false');
}

function fqToggleHideDone() {
  fqState.hideDone = !fqState.hideDone;
  try {
    localStorage.setItem('fq-hide-done-v1', fqState.hideDone ? '1' : '0');
  } catch (_) {}
  fqSyncHideDoneChrome();
  fqRenderTable();
}

function fqInitHideDone() {
  try {
    fqState.hideDone = localStorage.getItem('fq-hide-done-v1') === '1';
  } catch (_) {}
  fqSyncHideDoneChrome();
}

async function fqToggleRowFlag(item, field) {
  const live = fqFindItemByKey(fqItemKey(item)) || item;
  const patch = {};
  if (field === 'checklist_done') {
    patch.checklist_done = !live.checklist_done;
  } else if (field === 'exception_flag') {
    patch.exception_flag = !live.exception_flag;
  } else {
    return;
  }
  await fqSaveOverlay(live, patch);
  fqRenderTable();
  if (field === 'checklist_done') {
    fqToast(patch.checklist_done
      ? ((typeof fqT === 'function') ? fqT('toast_marked_done') : 'Marked done ✓')
      : ((typeof fqT === 'function') ? fqT('toast_unmarked') : 'Unmarked'), 'success');
  } else if (field === 'exception_flag') {
    fqToast(patch.exception_flag
      ? ((typeof fqT === 'function') ? fqT('toast_exception_flagged') : 'Exception flagged')
      : ((typeof fqT === 'function') ? fqT('toast_exception_cleared') : 'Exception cleared'), 'info');
  }
}

function fqAssigneeBoardItems() {
  return fqItemsMatchingPsTypes().filter((item) => !(fqState.hideDone && item.checklist_done));
}

function fqAssigneeBoardStats(items) {
  const byLabel = new Map();
  for (const item of items) {
    const label = fqAssigneeLabel(item);
    if (!byLabel.has(label)) {
      byLabel.set(label, { label, count: 0, exceptions: 0, qaDates: [] });
    }
    const row = byLabel.get(label);
    row.count += 1;
    if (item.exception_flag) row.exceptions += 1;
    const qa = fqSortValue(item, 'qa_due_date');
    if (qa) row.qaDates.push(qa);
  }
  return [...byLabel.values()].sort((a, b) => fqCompareAssigneeLabels(a.label, b.label, 'asc'));
}

function fqRenderAssigneeBoard() {
  const board = document.getElementById('fq-assignee-board');
  if (!board) return;
  const show = fqState.screen === 'assignments';
  board.hidden = !show;
  if (!show) {
    board.innerHTML = '';
    return;
  }

  const stats = fqAssigneeBoardStats(fqAssigneeBoardItems());
  const totalJobs = stats.reduce((sum, row) => sum + row.count, 0);
  const allActive = fqState.assignee === 'all';
  const allCard = `
    <button type="button" class="fq-assignee-card fq-assignee-card--all${allActive ? ' is-active' : ''}" data-fq-assignee-card="all" aria-pressed="${allActive ? 'true' : 'false'}">
      <span class="fq-assignee-card-avatar fq-assignee-card-avatar--all" aria-hidden="true">∑</span>
      <span class="fq-assignee-card-body">
        <span class="fq-assignee-card-name">${escapeHtml((typeof fqT === 'function') ? fqT('everyone') : 'Everyone')}</span>
        <span class="fq-assignee-card-meta">
          <span class="fq-assignee-card-stat">${typeof fqPlural === 'function' ? fqPlural('jobs_total', totalJobs) : `${totalJobs} job${totalJobs === 1 ? '' : 's'} total`}</span>
          <span class="fq-assignee-card-stat">${typeof fqPlural === 'function' ? fqPlural('assignees_count', stats.length) : `${stats.length} assignee${stats.length === 1 ? '' : 's'}`}</span>
        </span>
      </span>
    </button>
  `;

  if (!stats.length) {
    board.innerHTML = allCard;
    return;
  }

  board.innerHTML = allCard + stats.map((row) => {
    const id = (row.label === fqUnassignedLabel() || row.label === 'Unassigned') ? '__unassigned__' : row.label;
    const isActive = fqState.assignee === id;
    const initial = (row.label === fqUnassignedLabel() || row.label === 'Unassigned') ? '?' : (row.label.trim().charAt(0).toUpperCase() || '?');
    const qaSorted = row.qaDates.sort();
    const nextQa = qaSorted.length ? fqFormatDate(qaSorted[0]) : '—';
    const excHtml = row.exceptions
      ? `<span class="fq-assignee-card-stat fq-assignee-card-stat--warn">${typeof fqT === 'function' ? fqT('flagged', { n: row.exceptions }) : `${row.exceptions} flagged`}</span>`
      : '';
    return `
      <button type="button" class="fq-assignee-card${isActive ? ' is-active' : ''}" data-fq-assignee-card="${escapeHtml(id)}" aria-pressed="${isActive ? 'true' : 'false'}">
        <span class="fq-assignee-card-avatar" aria-hidden="true">${escapeHtml(initial)}</span>
        <span class="fq-assignee-card-body">
          <span class="fq-assignee-card-name">${escapeHtml(row.label)}</span>
          <span class="fq-assignee-card-meta">
            <span class="fq-assignee-card-stat">${typeof fqPlural === 'function' ? fqPlural('jobs_count', row.count) : `${row.count} job${row.count === 1 ? '' : 's'}`}</span>
            <span class="fq-assignee-card-stat">${escapeHtml(typeof fqT === 'function' ? fqT('qa_from', { date: nextQa }) : `QA from ${nextQa}`)}</span>
            ${excHtml}
          </span>
        </span>
      </button>
    `;
  }).join('');
}

function fqBindAssigneeBoard() {
  const board = document.getElementById('fq-assignee-board');
  if (!board || board.dataset.bound === '1') return;
  board.dataset.bound = '1';
  board.addEventListener('click', (e) => {
    const card = e.target.closest('[data-fq-assignee-card]');
    if (!card) return;
    const id = card.dataset.fqAssigneeCard || 'all';
    const next = fqState.assignee === id ? 'all' : id;
    fqSetAssignee(next);
  });
}

function fqGroupRowStats(items) {
  const exceptions = items.filter((item) => item.exception_flag).length;
  const qaDates = items.map((item) => fqSortValue(item, 'qa_due_date')).filter(Boolean).sort();
  return {
    count: items.length,
    exceptions,
    nextQa: qaDates.length ? fqFormatDate(qaDates[0]) : '',
  };
}

function fqRenderAssignmentsBody(filtered) {
  if (!fqShouldGroupByAssignee()) {
    return filtered.map((item) => fqRenderDataRow(item)).join('');
  }

  const parts = [];
  let lastLabel = null;
  let groupItems = [];
  const flushGroup = (label) => {
    if (!label) return;
    parts.push(fqRenderGroupRow(label, fqGroupRowStats(groupItems)));
    for (const item of groupItems) parts.push(fqRenderDataRow(item));
    groupItems = [];
  };

  for (const item of filtered) {
    const label = fqAssigneeLabel(item);
    if (label !== lastLabel) {
      flushGroup(lastLabel);
      lastLabel = label;
    }
    groupItems.push(item);
  }
  flushGroup(lastLabel);
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
  const busy = fqState.inspectorBusy ? ' disabled' : '';
  list.innerHTML = inspectors.map((insp) => `
    <li class="fq-inspector-item">
      <span>${escapeHtml(insp.name || '')}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-fq-remove-inspector="${insp.inspector_id}"${busy}>${(typeof fqT === 'function') ? fqT('inspectors_remove') : 'Remove'}</button>
    </li>
  `).join('');
}

function fqUpdateScreenChrome() {
  const screen = fqState.screen;
  const queueMode = screen === 'queue';
  const assignMode = screen === 'assignments';
  const miaMode = screen === 'material_issue';
  const miMode = screen === 'material_inspection';
  const qcqMode = screen === 'qc_queue';

  document.getElementById('fq-stage-filter-wrap')?.classList.toggle('is-hidden', !queueMode);
  document.querySelector('.fq-nav-group--ps-types')?.classList.toggle('is-hidden', miaMode || miMode || qcqMode);
  document.getElementById('fq-hide-done')?.classList.toggle('is-hidden', miaMode || miMode || qcqMode);
  // QC team is shared with material inspection assignment, so keep it available there.
  document.getElementById('fq-manage-inspectors')?.classList.toggle('is-hidden', miaMode || qcqMode);
  const miToolbar = document.getElementById('fq-mi-toolbar');
  if (miToolbar) miToolbar.hidden = !miMode;
  const qcqToolbar = document.getElementById('fq-qcq-toolbar');
  if (qcqToolbar) qcqToolbar.hidden = !qcqMode;
  if (!miMode) {
    document.getElementById('fq-mi-table-wrap')?.setAttribute('hidden', '');
  }
  if (!qcqMode) {
    document.getElementById('fq-qcq-table-wrap')?.setAttribute('hidden', '');
  }

  document.querySelectorAll('[data-fq-stage]').forEach((btn) => {
    const active = btn.dataset.fqStage === fqState.stage;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  document.querySelectorAll('[data-fq-screen]').forEach((btn) => {
    const active = btn.dataset.fqScreen === screen;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const tableWrap = document.getElementById('fq-table-wrap');
  tableWrap?.classList.toggle('fq-table-card--assignments', assignMode);
  tableWrap?.classList.toggle('fq-table-card--queue', queueMode);
  tableWrap?.classList.toggle('fq-table-card--assignee-filtered', assignMode && fqState.assignee !== 'all');
  if ((miaMode || miMode || qcqMode) && tableWrap) tableWrap.hidden = true;

  const miaWrap = document.getElementById('fq-mia-table-wrap');
  if (miaWrap && !miaMode) miaWrap.hidden = true;

  if (assignMode) {
    fqRenderAssigneeBoard();
  } else {
    const board = document.getElementById('fq-assignee-board');
    if (board) {
      board.hidden = true;
      board.innerHTML = '';
    }
  }
}

function fqRenderTable() {
  if (fqIsMaterialInspectionScreen()) {
    fqRenderMaterialInspectionTable();
    return;
  }
  if (fqIsQcQueueScreen()) {
    fqRenderQcQueueTable();
    return;
  }
  if (fqIsMaterialIssueScreen()) {
    fqRenderMaterialIssueTable();
    return;
  }
  fqUpdateScreenChrome();
  const filtered = fqFilteredItems();
  const tbody = document.getElementById('fq-table-body');
  const wrap = document.getElementById('fq-table-wrap');
  const empty = document.getElementById('fq-empty');
  const emptyText = document.getElementById('fq-empty-text');
  const stats = document.getElementById('fq-stats');
  const meta = document.getElementById('fq-meta');
  const hasActive = (fqState.items || []).length > 0;
  const hasPsFiltered = fqItemsMatchingPsTypes().length > 0;

  if (!tbody || !wrap || !empty) {
    fqShowLoadError('Queue table markup is missing from the page — hard refresh or restart the app.');
    return;
  }

  fqHideLoading();

  if (!hasActive) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = (typeof fqT === 'function') ? fqT('empty_post_machining') : 'No partials are currently at a post-machining stage.';
    if (emptyText && fqState.loadHint) emptyText.textContent = fqState.loadHint;
    if (stats) stats.textContent = '';
    if (meta) meta.hidden = true;
    fqUpdateNavCounts();
    return;
  }

  if (!hasPsFiltered) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = (typeof fqT === 'function') ? fqT('empty_ps_types') : 'No jobs match the selected PS types.';
    if (stats) stats.textContent = '';
    fqUpdateNavCounts();
    return;
  }

  if (!filtered.length) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = (typeof fqT === 'function') ? fqT('empty_stage') : 'Nothing in this stage right now.';
  } else {
    wrap.hidden = false;
    empty.hidden = true;
    tbody.innerHTML = fqIsAssignmentsView()
      ? fqRenderAssignmentsBody(filtered)
      : filtered.map((item) => fqRenderDataRow(item)).join('');
  }

  if (stats) {
    if (fqState.screen === 'assignments') {
      if (fqShouldGroupByAssignee()) {
        const groups = new Set(filtered.map((item) => fqAssigneeLabel(item))).size;
        stats.textContent = typeof fqPlural === 'function'
          ? fqPlural('stats_jobs_assignees', filtered.length, { groups })
          : `${filtered.length} job${filtered.length === 1 ? '' : 's'} across ${groups} assignee${groups === 1 ? '' : 's'} · grouped workload`;
      } else if (fqState.assignee === '__unassigned__') {
        stats.textContent = typeof fqPlural === 'function'
          ? fqPlural('stats_unassigned', filtered.length)
          : `${filtered.length} unassigned job${filtered.length === 1 ? '' : 's'}`;
      } else if (fqState.assignee !== 'all') {
        stats.textContent = typeof fqPlural === 'function'
          ? fqPlural('stats_for_assignee', filtered.length, { name: fqState.assignee })
          : `${filtered.length} job${filtered.length === 1 ? '' : 's'} for ${fqState.assignee}`;
      } else {
        stats.textContent = typeof fqPlural === 'function'
          ? fqPlural('stats_sorted', filtered.length)
          : `${filtered.length} job${filtered.length === 1 ? '' : 's'} · sorted by column`;
      }
    } else {
      const statusCounts = { I: 0, R: 0, P: 0 };
      let exceptionCount = 0;
      for (const item of filtered) {
        const code = String(item.current_stage_status || '').trim().toUpperCase();
        if (code in statusCounts) statusCounts[code] += 1;
        if (item.exception_flag) exceptionCount += 1;
      }
      const stageLabel = (typeof fqStageBucketLabel === 'function')
        ? fqStageBucketLabel(fqState.stage)
        : (fqState.stage === 'all' ? 'all stages' : fqState.stage.replace(/_/g, ' '));
      const excText = exceptionCount
        ? ((typeof fqT === 'function')
          ? fqT(exceptionCount === 1 ? 'stats_exceptions' : 'stats_exceptions_plural', { n: exceptionCount })
          : ` · ${exceptionCount} exception${exceptionCount === 1 ? '' : 's'}`)
        : '';
      stats.textContent = (typeof fqT === 'function')
        ? fqT('stats_queue', { n: filtered.length, i: statusCounts.I, r: statusCounts.R, stage: stageLabel }) + excText
        : `${filtered.length} in queue · ${statusCounts.I} in process · ${statusCounts.R} ready · ${stageLabel}${excText}`;
    }
  }

  if (meta) {
    meta.hidden = !fqState.cachedAt;
    meta.textContent = fqState.cachedAt
      ? ((typeof fqT === 'function')
        ? fqT('meta_queue', { at: fqState.cachedAt, ttl: fqState.cacheTtlSec })
        : `Source: synced staging (mfg_wo_status + pp_vouchers_cache) · cached ${fqState.cachedAt} · TTL ${fqState.cacheTtlSec}s · Sync ERP for fresh data`)
      : '';
  }

  fqUpdateNavCounts();
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
  fqState.materialIssueItems = payload.material_issue_items || [];
  fqState.materialIssueHint = (!fqState.materialIssueItems.length && payload.material_issue_hint)
    ? payload.material_issue_hint
    : '';
  fqState.inspectors = payload.inspectors || [];
  fqState.assignmentCounts = payload.assignment_counts || {};
  fqState.cachedAt = payload.cached_at || '';
  fqState.cacheTtlSec = payload.cache_ttl_sec || 180;
  fqState.weekRanges = payload.week_ranges || null;
  fqState.dataSource = payload.source || 'sync';
  fqState.loadHint = (!fqState.items.length && payload.hint) ? payload.hint : '';
  fqRecalcAssignmentCounts();
  fqUpdateCounts();
  fqRenderTable();
  if (fqIsMaterialIssueScreen() && !fqState.materialIssueItems.length) {
    void fqReloadMaterialIssueItems();
  }
}

window.fqApplyPayload = fqApplyPayload;

async function fqSyncWoStatus() {
  const res = await fetch(fqApiUrl('woStatusSync'), {
    method: 'POST',
    credentials: 'same-origin',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (data.skipped) {
    throw new Error(data.reason || 'WO status sync was skipped');
  }
  return data;
}

async function fqLoad({ refresh = false } = {}) {
  const loading = document.getElementById('fq-loading');
  if (loading) loading.hidden = false;
  const empty = document.getElementById('fq-empty');
  if (empty) empty.hidden = true;
  try {
    if (refresh) {
      fqToast((typeof fqT === 'function') ? fqT('toast_syncing') : 'Syncing WO status from ERP…', 'info');
      try {
        await fqSyncWoStatus();
      } catch (syncErr) {
        fqToast(`${syncErr.message || syncErr} — showing last synced data`, 'error');
      }
    }
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');
    const qs = params.toString();
    const url = qs ? `${fqApiUrl('queue')}?${qs}` : fqApiUrl('queue');
    const payload = await fqFetchJson(url);
    fqApplyPayload(payload);
  } catch (err) {
    fqShowLoadError(`Failed to load: ${err.message || err}`);
  } finally {
    fqHideLoading();
  }
}

window.fqLoad = fqLoad;

function fqSetScreen(screen) {
  fqState.screen = screen || 'queue';
  if (fqState.screen === 'assignments') {
    if (!fqState.assignee) fqState.assignee = 'all';
  } else {
    fqState.assignee = 'all';
    if (fqState.sortCol === 'inspector_name') {
      fqState.sortCol = '';
      fqState.sortDir = 'asc';
    }
  }
  fqCloseDetail();
  fqRenderTable();
  fqUpdateNavCounts();
  if (fqState.screen === 'material_issue' && !(fqState.materialIssueItems || []).length) {
    void fqReloadMaterialIssueItems();
  }
  if (fqState.screen === 'material_inspection' && !fqState.mi.loaded && !fqState.mi.loading) {
    void fqLoadMaterialInspection({ refresh: true });
  }
  if (fqState.screen === 'qc_queue' && !fqState.qcq.loaded && !fqState.qcq.loading) {
    void fqLoadQcQueue({ refresh: true });
  }
}

async function fqReloadMaterialIssueItems() {
  try {
    const payload = await fqFetchJson(fqApiUrl('queue'));
    fqState.materialIssueItems = payload.material_issue_items || [];
    fqState.materialIssueHint = (!fqState.materialIssueItems.length && payload.material_issue_hint)
      ? payload.material_issue_hint
      : '';
    fqRecalcCounts();
    if (fqIsMaterialIssueScreen()) fqRenderMaterialIssueTable();
  } catch (err) {
    if (fqIsMaterialIssueScreen()) {
      fqShowLoadError(`Failed to load material issue jobs: ${err.message || err}`);
    }
  }
}

function fqInitScreenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  let screen = null;
  if (tab === 'material_issue') screen = 'material_issue';
  else if (tab === 'material_inspection') screen = 'material_inspection';
  else if (tab === 'qc_queue') screen = 'qc_queue';
  if (!screen) return;
  // Apply tab chrome only — page init owns the cache-busting fetch so we don't
  // double-start loads (and so refreshCurrent always returns a real Promise).
  fqState.screen = screen;
  if (screen === 'assignments') {
    if (!fqState.assignee) fqState.assignee = 'all';
  } else {
    fqState.assignee = 'all';
    if (fqState.sortCol === 'inspector_name') {
      fqState.sortCol = '';
      fqState.sortDir = 'asc';
    }
  }
  fqCloseDetail();
  fqRenderTable();
  fqUpdateNavCounts();
}

window.fqSetScreen = fqSetScreen;

function fqSetStage(stage) {
  fqState.stage = stage;
  document.querySelectorAll('[data-fq-stage]').forEach((btn) => {
    const active = btn.dataset.fqStage === stage;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  fqRenderTable();
}

function fqSetAssignee(assignee) {
  fqState.assignee = assignee || 'all';
  fqRenderAssigneeBoard();
  fqRenderTable();
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
  const form = document.getElementById('fq-inspector-form');
  const submitBtn = form?.querySelector('button[type="submit"]');
  fqState.inspectorBusy = true;
  if (submitBtn) submitBtn.disabled = true;
  fqSetInspectorStatus('Saving…', 'pending');
  fqRenderInspectorPanel();
  try {
    const res = await fetch(fqApiUrl('inspectors'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await fqReloadInspectors();
    fqRecalcAssignmentCounts();
    if (fqState.screen === 'assignments') fqRenderAssigneeBoard();
    fqRenderTable();
    const msg = data.message || (data.created ? `Added ${name}` : `${name} is already on the team`);
    fqSetInspectorStatus(msg, data.created ? 'success' : 'info');
    fqToast(msg, data.created ? 'success' : 'info');
    return data;
  } catch (err) {
    fqSetInspectorStatus(err.message || 'Could not save inspector', 'error');
    fqToast(err.message || 'Could not save inspector', 'error');
    throw err;
  } finally {
    fqState.inspectorBusy = false;
    if (submitBtn) submitBtn.disabled = false;
    fqRenderInspectorPanel();
  }
}

async function fqOpenInspectorModal() {
  const modal = document.getElementById('fq-inspector-modal');
  if (!modal) return;
  fqSetInspectorStatus('');
  modal.hidden = false;
  modal.classList.add('is-open');
  document.body.classList.add('fq-inspector-modal-open');
  try {
    await fqReloadInspectors();
  } catch (err) {
    console.error('inspector reload failed:', err);
    fqRenderInspectorPanel();
    fqSetInspectorStatus('Could not refresh inspector list', 'error');
  }
  document.getElementById('fq-inspector-name')?.focus();
}

function fqCloseInspectorModal() {
  const modal = document.getElementById('fq-inspector-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove('is-open');
  document.body.classList.remove('fq-inspector-modal-open');
  fqRenderTable();
}

window.fqOpenInspectorModal = fqOpenInspectorModal;
window.fqCloseInspectorModal = fqCloseInspectorModal;

async function fqRemoveInspector(inspectorId) {
  fqState.inspectorBusy = true;
  fqSetInspectorStatus('Removing…', 'pending');
  fqRenderInspectorPanel();
  try {
    const res = await fetch(`${fqApiUrl('inspectors')}/${inspectorId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const removedName = String(data.name || '').trim().toLowerCase();
    for (const item of fqState.items) {
      const sameId = String(item.inspector_id) === String(inspectorId);
      const sameName = removedName && String(item.inspector_name || '').trim().toLowerCase() === removedName;
      if (sameId || sameName) {
        item.inspector_id = null;
        item.inspector_name = '';
      }
    }
    await fqReloadInspectors();
    fqRecalcAssignmentCounts();
    if (fqState.screen === 'assignments') fqRenderAssigneeBoard();
    fqRenderTable();
    const msg = data.message || `Removed ${data.name || 'inspector'}`;
    fqSetInspectorStatus(msg, 'success');
    fqToast(msg, 'success');
    return data;
  } catch (err) {
    fqSetInspectorStatus(err.message || 'Could not remove inspector', 'error');
    fqToast(err.message || 'Could not remove inspector', 'error');
    throw err;
  } finally {
    fqState.inspectorBusy = false;
    fqRenderInspectorPanel();
  }
}

function fqBindOverlayEditors() {
  if (window.__fqOverlayEditorsBound) return;
  window.__fqOverlayEditorsBound = true;
  // Inline onchange/onblur on cells is primary; this is a backup for older cached rows.
  document.addEventListener('change', (e) => {
    const el = e.target.closest('#fq-table-body [data-fq-field]');
    if (!el || el.disabled || el.getAttribute('onchange')) return;
    void fqPersistOverlayField(el);
  }, true);
  document.addEventListener('focusout', (e) => {
    const el = e.target.closest('#fq-table-body [data-fq-field="remarks"]');
    if (!el || el.disabled || el.getAttribute('onblur')) return;
    void fqPersistOverlayField(el);
  }, true);
}

function fqBindEvents() {
  if (window.__fqMainEventsBound) return;
  window.__fqMainEventsBound = true;

  document.getElementById('fq-table-wrap')?.addEventListener('click', (e) => {
    const sortBtn = e.target.closest('[data-fq-sort]');
    if (!sortBtn) return;
    e.stopPropagation();
    fqSetSort(sortBtn.dataset.fqSort || '');
  });

  document.getElementById('fq-refresh')?.addEventListener('click', async () => {
    try {
      if (fqIsMaterialInspectionScreen()) {
        await fqLoadMaterialInspection({ refresh: true });
        fqToast((typeof fqT === 'function') ? fqT('toast_mi_refreshed') : 'Material inspection refreshed from ERP', 'success');
        return;
      }
      if (fqIsQcQueueScreen()) {
        await fqLoadQcQueue({ refresh: true });
        fqToast((typeof fqT === 'function') ? fqT('toast_qcq_refreshed') : 'QC queue refreshed from ERP', 'success');
        return;
      }
      await fqLoad({ refresh: true });
      fqToast((typeof fqT === 'function') ? fqT('toast_queue_refreshed') : 'Queue refreshed from ERP', 'success');
    } catch (err) {
      // load handlers already surface errors
    }
  });

  document.querySelectorAll('[data-fq-screen]').forEach((btn) => {
    btn.addEventListener('click', () => fqSetScreen(btn.dataset.fqScreen || 'queue'));
  });

  document.querySelectorAll('[data-fq-stage]').forEach((btn) => {
    btn.addEventListener('click', () => fqSetStage(btn.dataset.fqStage || 'all'));
  });

  document.querySelectorAll('[data-fq-ps-type]').forEach((btn) => {
    btn.addEventListener('click', () => fqTogglePsType(btn.dataset.fqPsType || ''));
  });

  document.getElementById('fq-hide-done')?.addEventListener('click', () => fqToggleHideDone());

  document.getElementById('fq-table-body')?.addEventListener('click', async (e) => {
    const toggle = e.target.closest('[data-fq-toggle]');
    if (toggle) {
      e.stopPropagation();
      const item = fqResolveOverlayItem(toggle);
      if (!item) {
        fqToast('Could not match this row — refresh the page', 'error');
        return;
      }
      const field = toggle.dataset.fqToggle;
      try {
        await fqToggleRowFlag(item, field);
      } catch (err) {
        fqToast(err.message || 'Save failed', 'error');
      }
      return;
    }
    if (e.target.closest('[data-fq-field]')) return;
    const moreBtn = e.target.closest('[data-fq-open-detail]');
    if (moreBtn) {
      e.stopPropagation();
      const item = fqResolveOverlayItem(moreBtn);
      if (item) fqOpenDetail(item);
      return;
    }
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
    if (e.key !== 'Escape') return;
    const inspectorModal = document.getElementById('fq-inspector-modal');
    if (inspectorModal && !inspectorModal.hidden) {
      fqCloseInspectorModal();
      return;
    }
    fqCloseDetail();
  });

  document.getElementById('fq-inspector-form')?.addEventListener('submit', async (e) => {
    if (!window.__fqInteractive) return;
    e.preventDefault();
    const input = document.getElementById('fq-inspector-name');
    const name = String(input?.value || '').trim();
    if (!name || fqState.inspectorBusy) return;
    try {
      await fqAddInspector(name);
      if (input) input.value = '';
    } catch (err) {
      // fqAddInspector already surfaced the error
    }
  });

  document.getElementById('fq-inspector-list')?.addEventListener('click', async (e) => {
    if (!window.__fqInteractive) return;
    const btn = e.target.closest('[data-fq-remove-inspector]');
    if (!btn || btn.disabled || fqState.inspectorBusy) return;
    const id = btn.dataset.fqRemoveInspector;
    if (!id || !window.confirm((typeof fqT === 'function') ? fqT('inspectors_confirm_remove') : 'Remove this inspector from the QC team?')) return;
    try {
      await fqRemoveInspector(id);
    } catch (err) {
      // fqRemoveInspector already surfaced the error
    }
  });

  fqBindOverlayEditors();
  fqBindAssigneeBoard();
  fqBindMaterialInspection();
  fqBindQcQueue();
}

function fqInit() {
  try {
    if (typeof fqBindLocaleToggle === 'function') fqBindLocaleToggle();
    fqInitHideDone();
    fqInitPsTypes();
    fqInitQcqSegments();
    if (!window.__fqEventsBound) {
      fqBindEvents();
      window.__fqEventsBound = true;
    }

    const bootErr = window.__FQ_BOOTSTRAP_ERROR__;
    if (bootErr) {
      fqShowLoadError(`Server could not load queue: ${bootErr}`);
      window.__fqBootDone = true;
      return;
    }

    const boot = window.__FQ_BOOTSTRAP__;
    if (boot && (Array.isArray(boot.items) || Array.isArray(boot.material_issue_items))) {
      try {
        fqApplyPayload(boot);
        fqHideLoading();
        window.__fqInteractive = true;
        document.body.classList.add('fq-interactive-ready');
      } catch (renderErr) {
        console.error('finishing queue render failed:', renderErr);
        fqShowLoadError(`Failed to render queue: ${renderErr.message || renderErr}`);
        window.__fqBootDone = true;
        return;
      }
    }

    // Resolve tab from URL after bootstrap paint so the active screen gets a fresh fetch.
    fqInitScreenFromUrl();

    // Always reload-fetch on page load / browser refresh (same as Refresh button),
    // so server TTL caches are not re-served until the user clicks Refresh.
    if (!window.__fqLoadStarted) {
      window.__fqLoadStarted = true;
      const refreshCurrent = () => {
        if (fqIsMaterialInspectionScreen()) return fqLoadMaterialInspection({ refresh: true });
        if (fqIsQcQueueScreen()) return fqLoadQcQueue({ refresh: true });
        return fqLoad({ refresh: true });
      };
      refreshCurrent().finally(() => {
        window.__fqBootDone = true;
        window.__fqInteractive = true;
        document.body.classList.add('fq-interactive-ready');
        if (!fqIsMaterialInspectionScreen() && !fqState.mi.loaded && !fqState.mi.loading) {
          void fqLoadMaterialInspection({ refresh: true });
        }
      });
    }
  } catch (err) {
    console.error('finishing queue init failed:', err);
    fqShowLoadError(`Page setup failed: ${err.message || err}`);
    window.__fqBootDone = true;
  }
}

window.fqInit = fqInit;

try {
  fqInit();
} catch (bootErr) {
  console.error('finishing queue boot failed:', bootErr);
}

window.addEventListener('error', (event) => {
  if (String(event?.filename || '').includes('finishing_queue.js')) {
    fqShowLoadError(`Script error: ${event.message || 'unknown error'}`);
  }
});
