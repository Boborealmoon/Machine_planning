// Delivery Schedule — flat Excel-like view of open PS + partial rows.

const DELIVERY_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR', 'TEMP'];
const DELIVERY_PS_TYPES_DEFAULT = new Set(['APS', 'NPS', 'TEMP']);
const DELIVERY_SCHEDULE_DISMISSED_KEY = 'delivery-schedule-dismissed-v1';
const DELIVERY_SCHEDULE_EXCEPTIONS_KEY = 'delivery-schedule-exceptions-v1';
const DELIVERY_SCHEDULE_FLAGS_MIGRATED_KEY = 'delivery-schedule-flags-migrated-v2';

const DELIVERY_EXPORT_COLUMNS = [
  { id: 'ps', label: 'PS no.', value: item => String(item.ps_display || item.ps_id || '') },
  { id: 'part_no', label: 'Part no.', value: item => String(item.part_no || '') },
  { id: 'part_desc', label: 'Part description', value: item => String(item.part_desc || '') },
  { id: 'stage', label: 'Stage', value: item => deliveryScheduleStageLabel(item) },
  { id: 'so_qty', label: 'SO qty', value: item => deliveryScheduleFormatQty(item.so_qty) },
  { id: 'due_date', label: 'PO due date', value: item => deliveryScheduleFormatDate(item.due_date) },
  { id: 'coway_edd', label: 'Coway EDD', value: item => deliveryScheduleFormatDate(item.coway_edd) },
  { id: 'week', label: 'Week', value: item => deliveryScheduleWeekLabel(item) },
  { id: 'exception', label: 'Exception', value: item => (deliveryScheduleIsException(deliverySchedulePlannerPsId(item)) ? 'Yes' : '') },
  { id: 'remarks', label: 'Remarks', value: item => String(item.remarks || '') },
];

const deliveryScheduleState = {
  items: [],
  loading: false,
  loaded: false,
  sortBy: 'coway_edd',
  sortDir: 'asc',
  search: '',
  ppTypes: new Set(DELIVERY_PS_TYPES_DEFAULT),
  weekKeys: new Set(),
  weekGroups: [],
  selected: new Set(),
  dismissed: new Set(),
  exceptions: new Set(),
  hideDismissed: false,
};

let deliveryScheduleLoadSeq = 0;
let deliveryScheduleFetchController = null;

function deliveryScheduleSearchNeedle() {
  return String(deliveryScheduleState.search || '').trim().toLowerCase();
}

function deliveryScheduleMatchesSearch(item) {
  const needle = deliveryScheduleSearchNeedle();
  if (!needle) return true;

  const psDisplay = String(item.ps_display || '').toLowerCase();
  const psId = String(item.ps_id || '').toLowerCase();
  const plannerPsId = String(item.planner_ps_id || '').toLowerCase();
  const psBase = psDisplay.split('::')[0];

  if (psBase.includes(needle) || psId.includes(needle) || plannerPsId.includes(needle)) {
    return true;
  }

  const partNo = String(item.part_no || '').toLowerCase();
  const partDesc = String(item.part_desc || '').toLowerCase();
  return partNo.includes(needle) || partDesc.includes(needle);
}

function deliveryScheduleApplySearch(rawSearch) {
  deliveryScheduleState.search = String(rawSearch || '').trim();
  renderDeliveryScheduleBody();
}

function deliveryScheduleNormalizeStatus(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function deliveryScheduleIsExecutionCompleted(value) {
  const status = deliveryScheduleNormalizeStatus(value);
  return status === 'COMPLETED' || status === 'C';
}

function deliveryScheduleOpExecutionStatus(op) {
  return String(op?.execution_status || '').trim();
}

function deliveryScheduleOpRemainingQty(op) {
  const direct = Number(op?.remaining_qty || 0);
  if (Number.isFinite(direct) && direct > 0.0001) return direct;
  const required = Number(op?.wo_qty_required || 0);
  const finished = Number(op?.finished_qty || 0);
  return Math.max(0, required - finished);
}

function deliveryScheduleOpHasWorkOrderEvidence(op) {
  const required = Number(op?.wo_qty_required || 0);
  const produced = Number(op?.finished_qty || 0);
  const status = deliveryScheduleNormalizeStatus(deliveryScheduleOpExecutionStatus(op));
  return required > 0.0001 || produced > 0.0001 || Boolean(status);
}

function deliveryScheduleExecutionStatusRank(value) {
  const status = deliveryScheduleNormalizeStatus(value);
  if (status === 'I' || status === 'IN_PROCESS') return 0;
  if (status === 'R' || status === 'READY_TO_START') return 1;
  if (status === 'P' || status === 'PENDING_SI') return 2;
  if (status === 'C' || status === 'COMPLETED') return 3;
  return 4;
}

function deliveryScheduleStageDescFromOp(op) {
  const desc = String(op?.stage_desc || '').trim();
  if (desc) return desc;
  const opNo = String(op?.op_no || '').trim();
  return opNo ? `Op ${opNo}` : '';
}

function deliveryScheduleSortedOps(item) {
  const ops = Array.isArray(item?.ops) ? item.ops : [];
  return [...ops].sort((a, b) => {
    const stageA = Number(a.stage_no || 0);
    const stageB = Number(b.stage_no || 0);
    if (stageA !== stageB) return stageA - stageB;
    return String(a.op_no || '').localeCompare(String(b.op_no || ''));
  });
}

function deliveryScheduleResolveCurrentStage(item) {
  const headerDesc = String(item?.current_stage_desc || '').trim();
  if (headerDesc) {
    return {
      desc: headerDesc,
      status: item?.current_stage_status || item?.execution_status || '',
      stageNo: Number(item?.current_stage_no || 0) || null,
      allComplete: deliveryScheduleIsExecutionCompleted(item?.current_stage_status),
    };
  }

  const trackedOps = deliveryScheduleSortedOps(item).filter(deliveryScheduleOpHasWorkOrderEvidence);
  if (!trackedOps.length) return null;

  const inProcessOps = trackedOps.filter((op) => {
    const status = deliveryScheduleNormalizeStatus(deliveryScheduleOpExecutionStatus(op));
    return status === 'I' || status === 'IN_PROCESS';
  });
  if (inProcessOps.length) {
    const active = inProcessOps.sort((a, b) => (
      Number(b?.finished_qty || 0) - Number(a?.finished_qty || 0)
    ))[0];
    const desc = deliveryScheduleStageDescFromOp(active);
    if (desc) {
      return {
        desc,
        status: deliveryScheduleOpExecutionStatus(active),
        stageNo: Number(active?.stage_no || 0) || null,
        allComplete: false,
      };
    }
  }

  const openOp = trackedOps.find(op => deliveryScheduleOpRemainingQty(op) > 0.0001
    || !deliveryScheduleIsExecutionCompleted(deliveryScheduleOpExecutionStatus(op)));
  if (openOp) {
    const desc = deliveryScheduleStageDescFromOp(openOp);
    if (desc) {
      return {
        desc,
        status: deliveryScheduleOpExecutionStatus(openOp),
        stageNo: Number(openOp?.stage_no || 0) || null,
        allComplete: false,
      };
    }
  }

  const pendingOps = trackedOps.filter(op => !deliveryScheduleIsExecutionCompleted(deliveryScheduleOpExecutionStatus(op)));
  if (pendingOps.length) {
    const nextOp = pendingOps.sort((a, b) => (
      deliveryScheduleExecutionStatusRank(deliveryScheduleOpExecutionStatus(a))
      - deliveryScheduleExecutionStatusRank(deliveryScheduleOpExecutionStatus(b))
    ))[0];
    const desc = deliveryScheduleStageDescFromOp(nextOp);
    if (desc) {
      return {
        desc,
        status: deliveryScheduleOpExecutionStatus(nextOp),
        stageNo: Number(nextOp?.stage_no || 0) || null,
        allComplete: false,
      };
    }
  }

  const lastOp = trackedOps[trackedOps.length - 1];
  const lastDesc = deliveryScheduleStageDescFromOp(lastOp);
  if (lastDesc) {
    return {
      desc: lastDesc,
      status: deliveryScheduleOpExecutionStatus(lastOp),
      stageNo: Number(lastOp?.stage_no || 0) || null,
      allComplete: trackedOps.every(op => deliveryScheduleIsExecutionCompleted(deliveryScheduleOpExecutionStatus(op))),
    };
  }
  return null;
}

function deliveryScheduleStageLabel(item) {
  if (item?.shipped_completed) return '—';
  const stage = deliveryScheduleResolveCurrentStage(item);
  const label = String(stage?.desc || '').trim();
  return label || '—';
}

function deliveryScheduleStageSortValue(item) {
  const label = deliveryScheduleStageLabel(item);
  return label === '—' ? '\uffff' : label.toLowerCase();
}

function deliveryScheduleStageCellHtml(item) {
  const label = deliveryScheduleStageLabel(item);
  if (label === '—') {
    return '<span class="delivery-schedule-stage delivery-schedule-stage--empty">—</span>';
  }
  const stage = deliveryScheduleResolveCurrentStage(item);
  const title = stage?.stageNo ? `Stage ${stage.stageNo}` : label;
  return `<span class="delivery-schedule-stage" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

function deliverySchedulePlannerPsId(item) {
  return String(item?.planner_ps_id || item?.ps_id || '').trim();
}

function deliveryScheduleApplyItemFlags(items) {
  deliveryScheduleState.dismissed = new Set();
  deliveryScheduleState.exceptions = new Set();
  (items || []).forEach((item) => {
    const id = deliverySchedulePlannerPsId(item);
    if (!id) return;
    if (item.dismissed) deliveryScheduleState.dismissed.add(id);
    if (item.exception) deliveryScheduleState.exceptions.add(id);
  });
}

function deliveryScheduleApplyFlagsPayload(payload) {
  const id = String(payload?.planner_ps_id || '').trim();
  if (!id) return;
  if (payload.dismissed) deliveryScheduleState.dismissed.add(id);
  else deliveryScheduleState.dismissed.delete(id);
  if (payload.exception) deliveryScheduleState.exceptions.add(id);
  else deliveryScheduleState.exceptions.delete(id);
  deliveryScheduleUpdateItem(id, {
    dismissed: Boolean(payload.dismissed),
    exception: Boolean(payload.exception),
  });
}

function deliveryScheduleIsDismissed(plannerPsId) {
  const id = String(plannerPsId || '').trim();
  return id && deliveryScheduleState.dismissed.has(id);
}

function deliveryScheduleIsException(plannerPsId) {
  const id = String(plannerPsId || '').trim();
  return id && deliveryScheduleState.exceptions.has(id);
}

async function deliveryScheduleSaveFlags(plannerPsId, patch) {
  const psId = String(plannerPsId || '').trim();
  if (!psId) throw new Error('Missing PS id');
  const res = await fetch('/api/process-sheets/delivery-flags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      planner_ps_id: psId,
      ...patch,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

async function deliveryScheduleToggleDismissed(plannerPsId, dismissed, inputEl) {
  const id = String(plannerPsId || '').trim();
  if (!id) return;
  const previous = deliveryScheduleIsDismissed(id);
  if (dismissed) deliveryScheduleState.dismissed.add(id);
  else deliveryScheduleState.dismissed.delete(id);
  renderDeliveryScheduleBody();
  if (inputEl) inputEl.disabled = true;
  try {
    const data = await deliveryScheduleSaveFlags(id, { dismissed: Boolean(dismissed) });
    deliveryScheduleApplyFlagsPayload(data);
    renderDeliveryScheduleBody();
  } catch (err) {
    if (previous) deliveryScheduleState.dismissed.add(id);
    else deliveryScheduleState.dismissed.delete(id);
    renderDeliveryScheduleBody();
    if (inputEl) inputEl.checked = previous;
    toast('Could not save OK flag: ' + err.message, 'error');
  } finally {
    if (inputEl) inputEl.disabled = false;
  }
}

async function deliveryScheduleToggleException(plannerPsId, flagged, buttonEl) {
  const id = String(plannerPsId || '').trim();
  if (!id) return;
  const previous = deliveryScheduleIsException(id);
  if (flagged) deliveryScheduleState.exceptions.add(id);
  else deliveryScheduleState.exceptions.delete(id);
  renderDeliveryScheduleBody();
  if (buttonEl) buttonEl.disabled = true;
  try {
    const data = await deliveryScheduleSaveFlags(id, { exception: Boolean(flagged) });
    deliveryScheduleApplyFlagsPayload(data);
    renderDeliveryScheduleBody();
  } catch (err) {
    if (previous) deliveryScheduleState.exceptions.add(id);
    else deliveryScheduleState.exceptions.delete(id);
    renderDeliveryScheduleBody();
    toast('Could not save exception flag: ' + err.message, 'error');
  } finally {
    if (buttonEl) buttonEl.disabled = false;
  }
}

async function deliveryScheduleMigrateLocalFlags() {
  if (localStorage.getItem(DELIVERY_SCHEDULE_FLAGS_MIGRATED_KEY) === '1') return;

  let dismissed = [];
  let exceptions = [];
  try {
    const rawDismissed = localStorage.getItem(DELIVERY_SCHEDULE_DISMISSED_KEY);
    const rawExceptions = localStorage.getItem(DELIVERY_SCHEDULE_EXCEPTIONS_KEY);
    dismissed = rawDismissed ? JSON.parse(rawDismissed) : [];
    exceptions = rawExceptions ? JSON.parse(rawExceptions) : [];
  } catch (_err) {
    localStorage.setItem(DELIVERY_SCHEDULE_FLAGS_MIGRATED_KEY, '1');
    return;
  }

  const byId = new Map();
  (Array.isArray(dismissed) ? dismissed : []).forEach((rawId) => {
    const key = String(rawId || '').trim();
    if (!key) return;
    byId.set(key, { planner_ps_id: key, dismissed: true });
  });
  (Array.isArray(exceptions) ? exceptions : []).forEach((rawId) => {
    const key = String(rawId || '').trim();
    if (!key) return;
    const row = byId.get(key) || { planner_ps_id: key };
    row.exception = true;
    byId.set(key, row);
  });

  const items = [...byId.values()];
  if (!items.length) {
    localStorage.setItem(DELIVERY_SCHEDULE_FLAGS_MIGRATED_KEY, '1');
    localStorage.removeItem(DELIVERY_SCHEDULE_DISMISSED_KEY);
    localStorage.removeItem(DELIVERY_SCHEDULE_EXCEPTIONS_KEY);
    return;
  }

  try {
    const res = await fetch('/api/process-sheets/delivery-flags/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) return;
    localStorage.setItem(DELIVERY_SCHEDULE_FLAGS_MIGRATED_KEY, '1');
    localStorage.removeItem(DELIVERY_SCHEDULE_DISMISSED_KEY);
    localStorage.removeItem(DELIVERY_SCHEDULE_EXCEPTIONS_KEY);
  } catch (_err) {
    // Keep local keys if migration fails; user can retry on next visit.
  }
}

function deliveryScheduleToggleSelected(plannerPsId, selected) {
  const id = String(plannerPsId || '').trim();
  if (!id) return;
  if (selected) deliveryScheduleState.selected.add(id);
  else deliveryScheduleState.selected.delete(id);
  deliveryScheduleUpdateSelectionUi();
}

function deliveryScheduleSelectedItems() {
  const selected = deliveryScheduleState.selected;
  return deliveryScheduleVisibleItems().filter(item => selected.has(deliverySchedulePlannerPsId(item)));
}

function deliveryScheduleUpdateSelectionUi() {
  const viewBtn = document.getElementById('delivery-schedule-view-selected');
  const count = deliveryScheduleState.selected.size;
  if (viewBtn) {
    viewBtn.disabled = count === 0;
    viewBtn.textContent = count ? `View selected (${count})` : 'View selected';
  }

  const visible = deliveryScheduleVisibleItems();
  const visibleIds = new Set(visible.map(deliverySchedulePlannerPsId));
  const allVisibleSelected = visible.length > 0
    && visible.every(item => deliveryScheduleState.selected.has(deliverySchedulePlannerPsId(item)));
  const selectAll = document.getElementById('delivery-schedule-select-all');
  if (selectAll) {
    selectAll.checked = allVisibleSelected;
    selectAll.indeterminate = !allVisibleSelected
      && visible.some(item => deliveryScheduleState.selected.has(deliverySchedulePlannerPsId(item)));
  }

  document.querySelectorAll('.delivery-schedule-row-select').forEach((input) => {
    const rowId = String(input.dataset.psId || '').trim();
    if (!visibleIds.has(rowId)) return;
    input.checked = deliveryScheduleState.selected.has(rowId);
  });
}

function deliveryScheduleSelectAllVisible(checked) {
  deliveryScheduleVisibleItems().forEach((item) => {
    const id = deliverySchedulePlannerPsId(item);
    if (!id) return;
    if (checked) deliveryScheduleState.selected.add(id);
    else deliveryScheduleState.selected.delete(id);
  });
  deliveryScheduleUpdateSelectionUi();
}

function deliveryScheduleExportCsv(items, columns, filename) {
  if (!items.length || !columns.length) return;
  const header = columns.map(col => `"${String(col.label).replace(/"/g, '""')}"`).join(',');
  const lines = items.map(item => columns.map(col => {
    const raw = col.value(item);
    const val = raw === '—' ? '' : String(raw ?? '');
    return `"${val.replace(/"/g, '""')}"`;
  }).join(','));
  const csv = [header, ...lines].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function deliveryScheduleCloseModal() {
  const shell = document.getElementById('delivery-schedule-modal-shell');
  if (shell) shell.innerHTML = '';
  document.body.classList.remove('trial-modal-open');
}

function deliveryScheduleOpenExportModal() {
  const items = deliveryScheduleSelectedItems();
  if (!items.length) {
    toast('Select at least one row to view or export.', 'error');
    return;
  }

  const previewRows = items.map(item => `
    <tr>
      ${DELIVERY_EXPORT_COLUMNS.map(col => `<td>${escapeHtml(col.value(item))}</td>`).join('')}
    </tr>
  `).join('');

  const exportButtons = DELIVERY_EXPORT_COLUMNS.map(col => `
    <button type="button" class="btn btn-ghost btn-sm" data-action="export-col" data-col-id="${escapeHtml(col.id)}">
      Export ${escapeHtml(col.label)}
    </button>
  `).join('');

  const shell = document.getElementById('delivery-schedule-modal-shell');
  if (!shell) return;

  shell.innerHTML = `
    <div class="trial-modal-backdrop" data-delivery-modal-backdrop="1">
      <div class="trial-modal-panel trial-modal-panel-xl delivery-schedule-export-modal" role="dialog" aria-modal="true" aria-labelledby="delivery-export-modal-title">
        <div class="trial-modal-head">
          <div id="delivery-export-modal-title" class="trial-modal-title">Selected delivery entries (${items.length})</div>
          <button type="button" class="trial-modal-close" aria-label="Close modal" data-delivery-modal-close="1">×</button>
        </div>
        <div class="trial-modal-body">
          <div class="delivery-schedule-export-actions">
            <button type="button" class="btn btn-primary btn-sm" data-action="export-all">Export all columns (CSV)</button>
            ${exportButtons}
          </div>
          <div class="delivery-schedule-export-preview">
            <table class="delivery-schedule-export-table">
              <thead>
                <tr>
                  ${DELIVERY_EXPORT_COLUMNS.map(col => `<th>${escapeHtml(col.label)}</th>`).join('')}
                </tr>
              </thead>
              <tbody>${previewRows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.classList.add('trial-modal-open');

  shell.querySelector('[data-delivery-modal-close="1"]')?.addEventListener('click', deliveryScheduleCloseModal);
  shell.querySelector('[data-delivery-modal-backdrop="1"]')?.addEventListener('click', (event) => {
    if (event.target?.dataset?.deliveryModalBackdrop === '1') deliveryScheduleCloseModal();
  });
  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      deliveryScheduleCloseModal();
      document.removeEventListener('keydown', onKeydown);
    }
  };
  document.addEventListener('keydown', onKeydown);
  shell.querySelector('[data-action="export-all"]')?.addEventListener('click', () => {
    deliveryScheduleExportCsv(items, DELIVERY_EXPORT_COLUMNS, `delivery-selected-${items.length}.csv`);
  });
  shell.querySelectorAll('[data-action="export-col"]').forEach((button) => {
    button.addEventListener('click', () => {
      const colId = String(button.dataset.colId || '').trim();
      const column = DELIVERY_EXPORT_COLUMNS.find(col => col.id === colId);
      if (!column) return;
      const slug = colId.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'column';
      deliveryScheduleExportCsv(items, [column], `delivery-${slug}-${items.length}.csv`);
    });
  });
}

function deliveryScheduleIsTempPs(item) {
  const psId = String(item?.planner_ps_id || item?.ps_display || item?.ps_id || '').trim();
  return psId.startsWith('[Temp]');
}

function deliverySchedulePsType(item) {
  if (deliveryScheduleIsTempPs(item)) return 'TEMP';
  const raw = String(item?.ps_display || item?.ps_id || '').split('::')[0];
  if (/\[sr\]/i.test(raw)) return 'SR';
  const match = raw.toUpperCase().match(/^([A-Z]+)/);
  if (!match) return null;
  const prefix = match[1];
  return DELIVERY_PS_TYPES.includes(prefix) ? prefix : prefix;
}

function deliverySchedulePsTypeLabel() {
  const panel = document.getElementById('delivery-ps-type-panel');
  if (!panel) return 'PP type';
  const checked = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value);
  if (!checked.length) return 'None';
  if (checked.length >= DELIVERY_PS_TYPES.length) return 'All types';
  return checked.map(value => (value === 'SR' ? '[SR]' : value === 'TEMP' ? '[Temp]' : value)).join(', ');
}

function deliveryScheduleSyncPsTypeCheckboxes() {
  const panel = document.getElementById('delivery-ps-type-panel');
  if (!panel) return;
  panel.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = deliveryScheduleState.ppTypes.has(input.value);
  });
  const btn = document.getElementById('delivery-ps-type-btn');
  if (btn) btn.textContent = `${deliverySchedulePsTypeLabel()} ▾`;
}

function deliveryScheduleBindPsTypeDropdown() {
  const dropdown = document.getElementById('delivery-ps-type-dropdown');
  const btn = document.getElementById('delivery-ps-type-btn');
  const panel = document.getElementById('delivery-ps-type-panel');
  if (!dropdown || !btn || !panel || dropdown.dataset.bound === '1') return;
  dropdown.dataset.bound = '1';

  deliveryScheduleSyncPsTypeCheckboxes();

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    panel.hidden = !panel.hidden;
  });

  document.addEventListener('click', () => {
    panel.hidden = true;
  });

  panel.addEventListener('click', (event) => event.stopPropagation());

  panel.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      deliveryScheduleState.ppTypes = new Set(
        [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value),
      );
      btn.textContent = `${deliverySchedulePsTypeLabel()} ▾`;
      deliveryScheduleRebuildWeekDropdown();
      renderDeliveryScheduleBody();
    });
  });
}

function deliveryScheduleCollectWeekGroups(items) {
  const map = new Map();
  (items || []).forEach((item) => {
    const commitment = deliveryScheduleCommitmentDate(item);
    const key = deliveryScheduleItemWeekKey(item);
    let group = map.get(key);
    if (!group) {
      const weekNo = key === DELIVERY_WEEK_NONE_KEY ? null : Number(String(key.split('-W')[1] || 0));
      group = {
        key,
        weekNo,
        label: key === DELIVERY_WEEK_NONE_KEY ? 'No date' : `Week ${weekNo}`,
        sortKey: commitment || '9999-12-31',
        minDate: commitment || null,
        maxDate: commitment || null,
        count: 0,
      };
      map.set(key, group);
    }
    group.count += 1;
    if (commitment) {
      if (!group.minDate || commitment < group.minDate) group.minDate = commitment;
      if (!group.maxDate || commitment > group.maxDate) group.maxDate = commitment;
      group.sortKey = group.minDate;
    }
  });
  return [...map.values()].sort((left, right) => {
    if (left.key === DELIVERY_WEEK_NONE_KEY) return 1;
    if (right.key === DELIVERY_WEEK_NONE_KEY) return -1;
    return left.sortKey.localeCompare(right.sortKey);
  });
}

function deliveryScheduleWeekFilterLabel() {
  const groups = deliveryScheduleState.weekGroups;
  const allKeys = groups.map(group => group.key);
  const checked = [...deliveryScheduleState.weekKeys];
  if (!allKeys.length) return 'No weeks';
  if (!checked.length) return 'None';
  if (checked.length >= allKeys.length) return 'All weeks';
  const labels = groups
    .filter(group => deliveryScheduleState.weekKeys.has(group.key))
    .map(group => group.label);
  if (labels.length <= 2) return labels.join(', ');
  return `${labels.length} weeks`;
}

function deliveryScheduleSyncWeekCheckboxes() {
  const panel = document.getElementById('delivery-week-panel');
  if (!panel) return;
  panel.querySelectorAll('.delivery-week-filter-input').forEach((input) => {
    input.checked = deliveryScheduleState.weekKeys.has(input.value);
  });
  const btn = document.getElementById('delivery-week-btn');
  if (btn) btn.textContent = `${deliveryScheduleWeekFilterLabel()} ▾`;
}

function deliveryScheduleApplyWeekFilterSelection(keys) {
  deliveryScheduleState.weekKeys = new Set(keys);
  deliveryScheduleSyncWeekCheckboxes();
  const btn = document.getElementById('delivery-week-btn');
  if (btn) btn.textContent = `${deliveryScheduleWeekFilterLabel()} ▾`;
  renderDeliveryScheduleBody();
}

function deliveryScheduleRebuildWeekDropdown() {
  const panel = document.getElementById('delivery-week-panel');
  if (!panel) return;

  const baseItems = (deliveryScheduleState.items || []).filter(deliveryScheduleMatchesPsType);
  const groups = deliveryScheduleCollectWeekGroups(baseItems);
  deliveryScheduleState.weekGroups = groups;

  const allKeys = new Set(groups.map(group => group.key));
  const prevSelected = deliveryScheduleState.weekKeys;
  if (!prevSelected.size) {
    deliveryScheduleState.weekKeys = new Set(allKeys);
  } else {
    const next = new Set([...prevSelected].filter(key => allKeys.has(key)));
    groups.forEach((group) => {
      if (!prevSelected.has(group.key)) next.add(group.key);
    });
    deliveryScheduleState.weekKeys = next;
  }

  const actionsHtml = groups.length ? `
    <div class="delivery-week-filter-actions">
      <button type="button" class="delivery-week-filter-action" data-week-action="select-all">Select all</button>
      <button type="button" class="delivery-week-filter-action" data-week-action="clear-all">Clear all</button>
    </div>
  ` : '';

  panel.innerHTML = `${actionsHtml}${groups.map((group) => {
    const range = deliveryScheduleFormatWeekGroupRange(group.minDate, group.maxDate);
    const meta = range
      ? `<span class="delivery-week-filter-item-meta">${escapeHtml(range)}</span>`
      : '';
    return `
      <label class="delivery-week-filter-item filter-dropdown-item">
        <input
          type="checkbox"
          class="delivery-week-filter-input"
          value="${escapeHtml(group.key)}"
          ${deliveryScheduleState.weekKeys.has(group.key) ? 'checked' : ''}
        />
        <span class="delivery-week-filter-item-body">
          <span class="delivery-week-filter-item-title">${escapeHtml(group.label)}</span>
          ${meta}
        </span>
        <span class="delivery-week-filter-item-count">${group.count}</span>
      </label>
    `;
  }).join('')}`;

  deliveryScheduleSyncWeekCheckboxes();
}

function deliveryScheduleBindWeekDropdown() {
  const dropdown = document.getElementById('delivery-week-dropdown');
  const btn = document.getElementById('delivery-week-btn');
  const panel = document.getElementById('delivery-week-panel');
  if (!dropdown || !btn || !panel || dropdown.dataset.bound === '1') return;
  dropdown.dataset.bound = '1';

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    panel.hidden = !panel.hidden;
  });

  document.addEventListener('click', () => {
    panel.hidden = true;
  });

  panel.addEventListener('click', (event) => {
    event.stopPropagation();
    const actionBtn = event.target.closest('[data-week-action]');
    if (!actionBtn) return;
    const allKeys = deliveryScheduleState.weekGroups.map(group => group.key);
    if (actionBtn.dataset.weekAction === 'select-all') {
      deliveryScheduleApplyWeekFilterSelection(allKeys);
      return;
    }
    if (actionBtn.dataset.weekAction === 'clear-all') {
      deliveryScheduleApplyWeekFilterSelection([]);
    }
  });

  panel.addEventListener('change', (event) => {
    const input = event.target.closest('.delivery-week-filter-input');
    if (!input) return;
    deliveryScheduleApplyWeekFilterSelection(
      [...panel.querySelectorAll('.delivery-week-filter-input:checked')].map(el => el.value),
    );
  });
}

function deliveryScheduleMatchesWeek(item) {
  const groups = deliveryScheduleState.weekGroups;
  if (!groups.length) return true;
  if (!deliveryScheduleState.weekKeys.size) return false;
  if (deliveryScheduleState.weekKeys.size >= groups.length) return true;
  return deliveryScheduleState.weekKeys.has(deliveryScheduleItemWeekKey(item));
}

function deliveryScheduleMatchesPsType(item) {
  if (!deliveryScheduleState.ppTypes.size) return false;
  if (deliveryScheduleState.ppTypes.size >= DELIVERY_PS_TYPES.length) return true;
  const psType = deliverySchedulePsType(item);
  if (!psType) return true;
  return deliveryScheduleState.ppTypes.has(psType);
}
function deliveryScheduleSortIcon(colId) {
  if (deliveryScheduleState.sortBy !== colId) return '↕';
  return deliveryScheduleState.sortDir === 'desc' ? '↓' : '↑';
}

function deliveryScheduleSetSort(colId) {
  const nextCol = String(colId || '').trim();
  if (!nextCol) return;
  if (deliveryScheduleState.sortBy === nextCol) {
    deliveryScheduleState.sortDir = deliveryScheduleState.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    deliveryScheduleState.sortBy = nextCol;
    deliveryScheduleState.sortDir = 'asc';
  }
  deliveryScheduleUpdateSortHeaders();
  renderDeliveryScheduleBody();
}

function deliveryScheduleUpdateSortHeaders() {
  document.querySelectorAll('.delivery-schedule-sort-head').forEach((head) => {
    const colId = head.dataset.sortCol || '';
    const active = deliveryScheduleState.sortBy === colId;
    head.classList.toggle('is-sorted', active);
    head.setAttribute('aria-sort', active
      ? (deliveryScheduleState.sortDir === 'desc' ? 'descending' : 'ascending')
      : 'none');
    const icon = head.querySelector('.delivery-schedule-sort-icon');
    if (icon) icon.textContent = deliveryScheduleSortIcon(colId);
  });
}

function deliveryScheduleDateInputValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.slice(0, 10);
}

function deliveryScheduleParseDateOnly(value) {
  const text = deliveryScheduleDateInputValue(value);
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

function deliveryScheduleWeekNo(value) {
  const date = deliveryScheduleParseDateOnly(value);
  if (!date) return null;
  const dayNum = date.getUTCDay() || 7;
  const thursday = new Date(date);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
}

const DELIVERY_WEEK_NONE_KEY = '__none__';
const DELIVERY_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function deliveryScheduleIsoWeekKey(value) {
  const date = deliveryScheduleParseDateOnly(value);
  if (!date) return null;
  const dayNum = date.getUTCDay() || 7;
  const thursday = new Date(date);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNum);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNo = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(weekNo).padStart(2, '0')}`;
}

function deliveryScheduleItemWeekKey(item) {
  return deliveryScheduleIsoWeekKey(deliveryScheduleCommitmentDate(item)) || DELIVERY_WEEK_NONE_KEY;
}

function deliveryScheduleFormatShortDay(iso) {
  const parts = String(iso || '').split('-');
  if (parts.length !== 3) return String(iso || '');
  const month = DELIVERY_MONTH_NAMES[Number(parts[1]) - 1] || parts[1];
  return `${Number(parts[2])} ${month}`;
}

function deliveryScheduleFormatWeekGroupRange(minDate, maxDate) {
  if (!minDate) return '';
  if (!maxDate || minDate === maxDate) return deliveryScheduleFormatShortDay(minDate);
  const minParts = minDate.split('-');
  const maxParts = maxDate.split('-');
  if (minParts[0] === maxParts[0] && minParts[1] === maxParts[1]) {
    const month = DELIVERY_MONTH_NAMES[Number(minParts[1]) - 1] || minParts[1];
    return `${Number(minParts[2])}–${Number(maxParts[2])} ${month}`;
  }
  return `${deliveryScheduleFormatShortDay(minDate)} – ${deliveryScheduleFormatShortDay(maxDate)}`;
}

function deliveryScheduleCommitmentDate(itemOrValue) {
  if (itemOrValue && typeof itemOrValue === 'object') {
    return deliveryScheduleDateInputValue(itemOrValue.coway_edd)
      || deliveryScheduleDateInputValue(itemOrValue.due_date);
  }
  return deliveryScheduleDateInputValue(itemOrValue);
}

const DELIVERY_WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function deliveryScheduleWeekdayName(value) {
  const date = deliveryScheduleParseDateOnly(value);
  if (!date) return '';
  return DELIVERY_WEEKDAY_NAMES[date.getUTCDay()] || '';
}

function deliveryScheduleWeekLabel(itemOrValue) {
  const commitment = deliveryScheduleCommitmentDate(itemOrValue);
  const weekNo = deliveryScheduleWeekNo(commitment);
  if (!weekNo) return '—';
  const weekday = deliveryScheduleWeekdayName(commitment);
  if (!weekday) return `Week ${weekNo}`;
  return `Week ${weekNo} - ${weekday}`;
}

function deliveryScheduleFormatDate(value) {
  const text = deliveryScheduleDateInputValue(value);
  if (!text) return '—';
  const parts = text.split('-');
  if (parts.length !== 3) return text;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function deliveryScheduleFormatQty(value) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return Number.isInteger(num) ? String(num) : num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function deliveryScheduleSearchHaystack(item) {
  return [
    item.ps_display,
    item.ps_id,
    item.planner_ps_id,
    item.partial_no,
    item.part_no,
    item.part_desc,
    item.remarks,
    deliveryScheduleStageLabel(item),
    item.current_stage_desc,
    deliveryScheduleWeekLabel(item),
  ].join(' ').toLowerCase();
}

function deliveryScheduleSortValue(item, sortBy) {
  switch (sortBy) {
    case 'ps':
      return String(item.ps_display || item.ps_id || '').toLowerCase();
    case 'part_no':
      return String(item.part_no || '').toLowerCase();
    case 'part_desc':
      return String(item.part_desc || '').toLowerCase();
    case 'stage':
    case 'status':
      return deliveryScheduleStageSortValue(item);
    case 'so_qty':
      return item.so_qty == null ? -1 : Number(item.so_qty);
    case 'due_date':
      return deliveryScheduleDateInputValue(item.due_date) || '9999-12-31';
    case 'week':
      return deliveryScheduleCommitmentDate(item) || '9999-12-31';
    case 'remarks':
      return String(item.remarks || '').toLowerCase();
    case 'coway_edd':
    default:
      return deliveryScheduleDateInputValue(item.coway_edd) || '9999-12-31';
  }
}

function deliveryScheduleCancelInFlight() {
  deliveryScheduleLoadSeq += 1;
  if (deliveryScheduleFetchController) {
    deliveryScheduleFetchController.abort();
    deliveryScheduleFetchController = null;
  }
}

function deliveryScheduleVisibleItems() {
  let items = [...(deliveryScheduleState.items || [])];
  items = items.filter(deliveryScheduleMatchesPsType);
  items = items.filter(deliveryScheduleMatchesWeek);
  items = items.filter(deliveryScheduleMatchesSearch);
  if (deliveryScheduleState.hideDismissed) {
    items = items.filter(item => !deliveryScheduleIsDismissed(deliverySchedulePlannerPsId(item)));
  }
  const sortBy = deliveryScheduleState.sortBy;
  const dir = deliveryScheduleState.sortDir === 'desc' ? -1 : 1;
  items.sort((left, right) => {
    const a = deliveryScheduleSortValue(left, sortBy);
    const b = deliveryScheduleSortValue(right, sortBy);
    if (a < b) return -1 * dir;
    if (a > b) return 1 * dir;
    return String(left.ps_display || '').localeCompare(String(right.ps_display || ''));
  });
  return items;
}

function renderDeliveryScheduleBody() {
  const loading = document.getElementById('delivery-schedule-loading');
  const wrap = document.getElementById('delivery-schedule-table-wrap');
  const body = document.getElementById('delivery-schedule-body');
  const empty = document.getElementById('delivery-schedule-empty');
  const emptyText = document.getElementById('delivery-schedule-empty-text');
  const stats = document.getElementById('delivery-schedule-stats');
  if (!body) return;

  deliveryScheduleUpdateSortHeaders();

  if (deliveryScheduleState.loading) {
    if (loading) loading.hidden = false;
    if (wrap) wrap.hidden = true;
    if (empty) empty.hidden = true;
    if (stats) stats.textContent = '';
    return;
  }

  const items = deliveryScheduleVisibleItems();

  if (stats) {
    const total = (deliveryScheduleState.items || []).length;
    const visible = items.length;
    const needle = deliveryScheduleSearchNeedle();
    if (needle && total) {
      stats.textContent = visible === total
        ? `${visible} PS`
        : `${visible} of ${total} PS`;
    } else {
      stats.textContent = `${visible} PS`;
    }
  }

  if (loading) loading.hidden = true;
  if (!items.length) {
    if (wrap) wrap.hidden = true;
    if (empty) empty.hidden = false;
    if (emptyText) {
      if (!deliveryScheduleState.ppTypes.size) {
        emptyText.textContent = 'Select at least one PP type to show process sheets.';
      } else if (!deliveryScheduleState.weekKeys.size && deliveryScheduleState.weekGroups.length) {
        emptyText.textContent = 'Select at least one week to show process sheets.';
      } else if (deliveryScheduleSearchNeedle()) {
        emptyText.textContent = 'No open partials match your search.';
      } else if (!deliveryScheduleState.loaded) {
        emptyText.textContent = 'Loading open partials…';
      } else {
        emptyText.textContent = 'No open partials match your filters.';
      }
    }
    deliveryScheduleUpdateSelectionUi();
    return;
  }

  if (empty) empty.hidden = true;
  if (wrap) wrap.hidden = false;
  body.innerHTML = items.map(deliveryScheduleRowHtml).join('');
  deliveryScheduleBindInputs();
  deliveryScheduleUpdateSelectionUi();
}

function renderDeliverySchedule() {
  renderDeliveryScheduleBody();
}

function deliveryScheduleDismissToggleHtml(item) {
  const psId = deliverySchedulePlannerPsId(item);
  const escapedPsId = escapeHtml(psId);
  const checked = deliveryScheduleIsDismissed(psId) ? ' checked' : '';
  return `
    <label class="delivery-schedule-dismiss-toggle" title="Don't worry about it">
      <input
        type="checkbox"
        class="delivery-schedule-dismiss-input"
        data-action="dismiss"
        data-ps-id="${escapedPsId}"
        aria-label="Don't worry about ${escapedPsId}"
        ${checked}
      >
      <span class="delivery-schedule-dismiss-switch" aria-hidden="true"></span>
    </label>
  `;
}

function deliveryScheduleExceptionBtnHtml(item) {
  const psId = deliverySchedulePlannerPsId(item);
  const escapedPsId = escapeHtml(psId);
  const active = deliveryScheduleIsException(psId);
  const activeClass = active ? ' is-active' : '';
  const pressed = active ? 'true' : 'false';
  return `
    <button
      type="button"
      class="delivery-schedule-exception-btn${activeClass}"
      data-action="exception"
      data-ps-id="${escapedPsId}"
      aria-pressed="${pressed}"
      aria-label="${active ? 'Clear exception for' : 'Mark exception for'} ${escapedPsId}"
      title="${active ? 'Clear exception' : 'Mark as exception'}"
    >!</button>
  `;
}

function deliveryScheduleSelectCheckboxHtml(item) {
  const psId = deliverySchedulePlannerPsId(item);
  const escapedPsId = escapeHtml(psId);
  const checked = deliveryScheduleState.selected.has(psId) ? ' checked' : '';
  return `
    <input
      type="checkbox"
      class="delivery-schedule-row-select"
      data-action="select-row"
      data-ps-id="${escapedPsId}"
      aria-label="Select ${escapedPsId}"
      ${checked}
    >
  `;
}

function deliveryScheduleCowayInputHtml(item) {
  const psId = escapeHtml(item.planner_ps_id || '');
  const value = escapeHtml(deliveryScheduleDateInputValue(item.coway_edd));
  return `
    <div class="delivery-schedule-coway-wrap" data-action="coway-edd-wrap">
      <input
        type="date"
        class="delivery-schedule-coway-input"
        data-action="coway-edd"
        data-ps-id="${psId}"
        value="${value}"
        data-last-saved="${value}"
      >
      <span class="delivery-schedule-field-status delivery-schedule-coway-status" hidden></span>
    </div>
  `;
}

function deliveryScheduleRemarksInputHtml(item) {
  const psId = escapeHtml(item.planner_ps_id || '');
  const value = escapeHtml(item.remarks || '');
  return `
    <div class="delivery-schedule-remarks-wrap" data-action="remarks-wrap">
      <input
        type="text"
        class="delivery-schedule-remarks-input"
        data-action="remarks"
        data-ps-id="${psId}"
        value="${value}"
        data-last-saved="${value}"
        placeholder="Remarks"
      >
      <span class="delivery-schedule-field-status delivery-schedule-remarks-status" hidden></span>
    </div>
  `;
}

function deliveryScheduleRowHtml(item) {
  const psId = deliverySchedulePlannerPsId(item);
  const rowClasses = [
    'delivery-schedule-row',
    deliveryScheduleIsDismissed(psId) ? 'is-dismissed' : '',
    deliveryScheduleIsException(psId) ? 'is-exception' : '',
  ].filter(Boolean).join(' ');
  return `
    <tr class="${rowClasses}" data-ps-id="${escapeHtml(psId)}">
      <td class="delivery-schedule-check">${deliveryScheduleSelectCheckboxHtml(item)}</td>
      <td class="delivery-schedule-dismiss">${deliveryScheduleDismissToggleHtml(item)}</td>
      <td class="delivery-schedule-exception">${deliveryScheduleExceptionBtnHtml(item)}</td>
      <td class="delivery-schedule-ps"><strong>${escapeHtml(item.ps_display || item.ps_id || '—')}</strong></td>
      <td>${escapeHtml(item.part_no || '—')}</td>
      <td class="delivery-schedule-desc">${escapeHtml(item.part_desc || '—')}</td>
      <td class="delivery-schedule-stage-col">${deliveryScheduleStageCellHtml(item)}</td>
      <td class="delivery-schedule-num">${escapeHtml(deliveryScheduleFormatQty(item.so_qty))}</td>
      <td class="delivery-schedule-date">${escapeHtml(deliveryScheduleFormatDate(item.due_date))}</td>
      <td class="delivery-schedule-coway">${deliveryScheduleCowayInputHtml(item)}</td>
      <td class="delivery-schedule-week" data-week-for="${escapeHtml(item.planner_ps_id || '')}">${escapeHtml(deliveryScheduleWeekLabel(item))}</td>
      <td class="delivery-schedule-remarks">${deliveryScheduleRemarksInputHtml(item)}</td>
    </tr>
  `;
}

function deliveryScheduleSetFieldStatus(wrap, status, message) {
  if (!wrap) return;
  wrap.classList.remove('is-saving', 'is-saved', 'is-error');
  if (status) wrap.classList.add(status);
  const note = wrap.querySelector('.delivery-schedule-field-status');
  if (!note) return;
  if (!message) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  note.hidden = false;
  note.textContent = message;
}

function deliveryScheduleUpdateItem(plannerPsId, patch) {
  const needle = String(plannerPsId || '').trim();
  const item = (deliveryScheduleState.items || []).find(row => String(row.planner_ps_id || '').trim() === needle);
  if (!item) return null;
  Object.assign(item, patch);
  return item;
}

function deliveryScheduleUpdateWeekCell(plannerPsId, item) {
  const cell = document.querySelector(`.delivery-schedule-week[data-week-for="${CSS.escape(String(plannerPsId || ''))}"]`);
  if (!cell) return;
  const rowItem = item || (deliveryScheduleState.items || []).find(
    row => String(row.planner_ps_id || '').trim() === String(plannerPsId || '').trim(),
  );
  cell.textContent = deliveryScheduleWeekLabel(rowItem || {});
}

async function deliveryScheduleSaveCoway(plannerPsId, value, inputEl) {
  const psId = String(plannerPsId || '').trim();
  if (!psId) return;
  const nextValue = deliveryScheduleDateInputValue(value);
  if (inputEl && inputEl.dataset.lastSaved === nextValue) return;

  const wrap = inputEl?.closest('[data-action="coway-edd-wrap"]') || null;
  if (inputEl) {
    inputEl.disabled = true;
    deliveryScheduleSetFieldStatus(wrap, 'is-saving', 'Saving…');
  }

  try {
    const res = await fetch('/api/process-sheets/coway-proposed-edd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ps_id: psId,
        coway_proposed_edd: nextValue || null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);

    const saved = deliveryScheduleDateInputValue(data.coway_proposed_edd);
    const savedPsId = String(data.ps_id || psId).trim() || psId;
    const updated = deliveryScheduleUpdateItem(savedPsId, { coway_edd: saved, planner_ps_id: savedPsId });
    if (inputEl) {
      inputEl.value = saved;
      inputEl.dataset.lastSaved = saved;
      inputEl.disabled = false;
      deliveryScheduleSetFieldStatus(wrap, 'is-saved', 'Saved');
      window.setTimeout(() => {
        if (inputEl.dataset.lastSaved === saved) {
          deliveryScheduleSetFieldStatus(wrap, '', '');
        }
      }, 1600);
    }
    deliveryScheduleUpdateWeekCell(savedPsId, updated);
    const weekFilterActive = deliveryScheduleState.weekGroups.length > 0
      && deliveryScheduleState.weekKeys.size < deliveryScheduleState.weekGroups.length;
    if (deliveryScheduleState.sortBy === 'coway_edd' || deliveryScheduleState.sortBy === 'week' || weekFilterActive) {
      if (weekFilterActive) deliveryScheduleRebuildWeekDropdown();
      renderDeliveryScheduleBody();
    }
  } catch (err) {
    if (inputEl) {
      inputEl.disabled = false;
      deliveryScheduleSetFieldStatus(wrap, 'is-error', 'Save failed');
    }
    toast('Could not save Coway EDD: ' + err.message, 'error');
  }
}

async function deliveryScheduleSaveRemarks(plannerPsId, value, inputEl) {
  const psId = String(plannerPsId || '').trim();
  if (!psId) return;
  const nextValue = String(value || '').trim();
  if (inputEl && inputEl.dataset.lastSaved === nextValue) return;

  const wrap = inputEl?.closest('[data-action="remarks-wrap"]') || null;
  if (inputEl) {
    inputEl.disabled = true;
    deliveryScheduleSetFieldStatus(wrap, 'is-saving', 'Saving…');
  }

  try {
    const res = await fetch('/api/process-sheets/remarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ps_id: psId,
        remarks: nextValue,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);

    const saved = String(data.remarks || '').trim();
    const savedPsId = String(data.ps_id || psId).trim() || psId;
    deliveryScheduleUpdateItem(savedPsId, { remarks: saved, planner_ps_id: savedPsId });
    if (inputEl) {
      inputEl.value = saved;
      inputEl.dataset.lastSaved = saved;
      inputEl.disabled = false;
      deliveryScheduleSetFieldStatus(wrap, 'is-saved', saved ? 'Saved' : 'Cleared');
      window.setTimeout(() => {
        if (inputEl.dataset.lastSaved === saved) {
          deliveryScheduleSetFieldStatus(wrap, '', '');
        }
      }, 1600);
    }
  } catch (err) {
    if (inputEl) {
      inputEl.disabled = false;
      deliveryScheduleSetFieldStatus(wrap, 'is-error', 'Save failed');
    }
    toast('Could not save remarks: ' + err.message, 'error');
  }
}

function deliveryScheduleBindInputs() {
  const body = document.getElementById('delivery-schedule-body');
  if (!body || body.dataset.bound === '1') return;
  body.dataset.bound = '1';

  body.addEventListener('change', (event) => {
    const selectInput = event.target.closest('[data-action="select-row"]');
    if (selectInput) {
      deliveryScheduleToggleSelected(selectInput.dataset.psId || '', selectInput.checked);
      return;
    }
    const dismissInput = event.target.closest('[data-action="dismiss"]');
    if (dismissInput) {
      deliveryScheduleToggleDismissed(dismissInput.dataset.psId || '', dismissInput.checked, dismissInput);
      return;
    }
    const cowayInput = event.target.closest('[data-action="coway-edd"]');
    if (cowayInput) {
      deliveryScheduleSaveCoway(cowayInput.dataset.psId || '', cowayInput.value, cowayInput);
      return;
    }
    const remarksInput = event.target.closest('[data-action="remarks"]');
    if (remarksInput) {
      deliveryScheduleSaveRemarks(remarksInput.dataset.psId || '', remarksInput.value, remarksInput);
    }
  });

  body.addEventListener('click', (event) => {
    const exceptionBtn = event.target.closest('[data-action="exception"]');
    if (!exceptionBtn) return;
    event.preventDefault();
    const psId = exceptionBtn.dataset.psId || '';
    deliveryScheduleToggleException(psId, !deliveryScheduleIsException(psId), exceptionBtn);
  });

  body.addEventListener('blur', (event) => {
    const remarksInput = event.target.closest('[data-action="remarks"]');
    if (remarksInput) {
      deliveryScheduleSaveRemarks(remarksInput.dataset.psId || '', remarksInput.value, remarksInput);
    }
  }, true);
}

async function loadDeliverySchedule(options = {}) {
  await deliveryScheduleMigrateLocalFlags();

  const seq = ++deliveryScheduleLoadSeq;
  if (deliveryScheduleFetchController) {
    deliveryScheduleFetchController.abort();
  }
  deliveryScheduleFetchController = new AbortController();
  const signal = deliveryScheduleFetchController.signal;

  const loading = document.getElementById('delivery-schedule-loading');
  const wrap = document.getElementById('delivery-schedule-table-wrap');
  const empty = document.getElementById('delivery-schedule-empty');
  const loadingText = loading?.querySelector('.delivery-schedule-loading-text');

  deliveryScheduleState.loading = true;
  renderDeliveryScheduleBody();
  if (loading) loading.hidden = false;
  if (wrap) wrap.hidden = true;
  if (empty) empty.hidden = true;
  if (loadingText) loadingText.textContent = 'Loading open partials...';

  const params = new URLSearchParams();
  params.set('full', '1');
  if (options.force) params.set('_', String(Date.now()));
  const url = `/api/trial/delivery-schedule?${params.toString()}`;
  try {
    const res = await fetch(url, { signal });
    if (seq !== deliveryScheduleLoadSeq) return;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    if (seq !== deliveryScheduleLoadSeq) return;
    deliveryScheduleState.items = Array.isArray(data.items) ? data.items : [];
    deliveryScheduleApplyItemFlags(deliveryScheduleState.items);
    deliveryScheduleState.loading = false;
    deliveryScheduleState.loaded = true;
    deliveryScheduleRebuildWeekDropdown();
    renderDeliverySchedule();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq !== deliveryScheduleLoadSeq) return;
    deliveryScheduleState.loading = false;
    if (loading) loading.hidden = true;
    toast('Could not load delivery schedule: ' + err.message, 'error');
    renderDeliveryScheduleBody();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('delivery-schedule-body')) return;

  deliveryScheduleBindPsTypeDropdown();
  deliveryScheduleBindWeekDropdown();
  deliveryScheduleUpdateSortHeaders();
  renderDeliveryScheduleBody();

  document.getElementById('delivery-schedule-select-all')?.addEventListener('change', (event) => {
    deliveryScheduleSelectAllVisible(event.target.checked);
  });

  document.getElementById('delivery-schedule-view-selected')?.addEventListener('click', () => {
    deliveryScheduleOpenExportModal();
  });

  document.getElementById('delivery-schedule-hide-dismissed')?.addEventListener('change', (event) => {
    deliveryScheduleState.hideDismissed = Boolean(event.target.checked);
    renderDeliveryScheduleBody();
  });

  document.getElementById('delivery-schedule-table-wrap')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action="sort-col"]');
    if (!btn) return;
    event.preventDefault();
    deliveryScheduleSetSort(btn.dataset.sortCol || '');
  });

  const searchInput = document.getElementById('delivery-schedule-search');
  searchInput?.addEventListener('input', (event) => {
    deliveryScheduleApplySearch(event.target.value);
  });
});
