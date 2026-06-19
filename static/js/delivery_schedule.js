// Delivery Schedule — flat Excel-like view of open PS + partial rows.

const DELIVERY_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR', 'TEMP'];
const DELIVERY_PS_TYPES_DEFAULT = new Set(['APS', 'NPS', 'TEMP']);

const deliveryScheduleState = {
  items: [],
  sortBy: 'coway_edd',
  sortDir: 'asc',
  search: '',
  ppTypes: new Set(DELIVERY_PS_TYPES_DEFAULT),
};

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
      renderDeliveryScheduleBody();
    });
  });
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
    item.part_no,
    item.part_desc,
    item.remarks,
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

function deliveryScheduleVisibleItems() {
  const needle = String(deliveryScheduleState.search || '').trim().toLowerCase();
  let items = [...(deliveryScheduleState.items || [])].filter(deliveryScheduleMatchesPsType);
  if (needle) {
    items = items.filter(item => deliveryScheduleSearchHaystack(item).includes(needle));
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
  const items = deliveryScheduleVisibleItems();

  if (stats) {
    stats.textContent = `${items.length} PS`;
  }

  if (loading) loading.hidden = true;
  if (!items.length) {
    if (wrap) wrap.hidden = true;
    if (empty) empty.hidden = false;
    if (emptyText) {
      if (!deliveryScheduleState.ppTypes.size) {
        emptyText.textContent = 'Select at least one PP type to show process sheets.';
      } else {
        emptyText.textContent = deliveryScheduleState.search
          ? 'No open process sheets match your search.'
          : 'No open process sheets match your PP type filter.';
      }
    }
    return;
  }

  if (empty) empty.hidden = true;
  if (wrap) wrap.hidden = false;
  body.innerHTML = items.map(deliveryScheduleRowHtml).join('');
  deliveryScheduleBindInputs();
}

function renderDeliverySchedule() {
  renderDeliveryScheduleBody();
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
  return `
    <tr class="delivery-schedule-row" data-ps-id="${escapeHtml(item.planner_ps_id || '')}">
      <td class="delivery-schedule-ps"><strong>${escapeHtml(item.ps_display || item.ps_id || '—')}</strong></td>
      <td>${escapeHtml(item.part_no || '—')}</td>
      <td class="delivery-schedule-desc">${escapeHtml(item.part_desc || '—')}</td>
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
    if (deliveryScheduleState.sortBy === 'coway_edd' || deliveryScheduleState.sortBy === 'week') {
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

  body.addEventListener('blur', (event) => {
    const remarksInput = event.target.closest('[data-action="remarks"]');
    if (remarksInput) {
      deliveryScheduleSaveRemarks(remarksInput.dataset.psId || '', remarksInput.value, remarksInput);
    }
  }, true);
}

async function loadDeliverySchedule(options = {}) {
  const loading = document.getElementById('delivery-schedule-loading');
  const wrap = document.getElementById('delivery-schedule-table-wrap');
  const empty = document.getElementById('delivery-schedule-empty');
  if (loading) loading.hidden = false;
  if (wrap) wrap.hidden = true;
  if (empty) empty.hidden = true;

  const url = options.force ? `/api/trial/delivery-schedule?_=${Date.now()}` : '/api/trial/delivery-schedule';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    deliveryScheduleState.items = Array.isArray(data.items) ? data.items : [];
    renderDeliverySchedule();
  } catch (err) {
    if (loading) loading.hidden = true;
    toast('Could not load delivery schedule: ' + err.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('delivery-schedule-body')) return;

  deliveryScheduleBindPsTypeDropdown();
  deliveryScheduleUpdateSortHeaders();

  document.getElementById('delivery-schedule-table-wrap')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action="sort-col"]');
    if (!btn) return;
    event.preventDefault();
    deliveryScheduleSetSort(btn.dataset.sortCol || '');
  });

  document.getElementById('delivery-schedule-search')?.addEventListener('input', (event) => {
    deliveryScheduleState.search = String(event.target.value || '');
    renderDeliveryScheduleBody();
  });
});
