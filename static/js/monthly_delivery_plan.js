/* Monthly delivery plan — outstanding list, column filters, assign to a month. */

const MDP_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR', 'NOPP'];
const MDP_PS_DEFAULT = ['APS', 'NPS'];
const MDP_QTY_TOLERANCE = 0.0001;

const MDP_CAT_FILTERS = {
  plan_month: { label: 'Plan month' },
  sales_order_no: { label: 'S/O', value: (row) => mdpBlank(row.sales_order_no) },
  ps_type: { label: 'PS type', value: (row) => mdpBlank(row.ps_type) },
  part_no: { label: 'Part', value: (row) => mdpBlank(row.part_no) },
  status: { label: 'Stage', value: (row) => mdpBlank(row.status) },
  due_month: { label: 'Due month', value: (row) => mdpDueMonthLabel(row) },
  material_need_month: { label: 'Need month', value: (row) => mdpMonthLabelFromDate(row.material_need_date) },
  material_in_month: { label: 'In month', value: (row) => mdpMonthLabelFromDate(row.material_in_date) },
};

const MDP_DATE_RANGES = {
  material_need_month: { field: 'material_need_date', label: 'Need date' },
  material_in_month: { field: 'material_in_date', label: 'In date' },
};

const MDP_COLUMNS = [
  { id: 'plan_month', label: 'Plan month' },
  { id: 'sales_order_no', label: 'S/O' },
  { id: 'process_sheet_no', label: 'PS' },
  { id: 'part_no', label: 'Part' },
  { id: 'part_desc', label: 'Description' },
  { id: 'open_qty', label: 'Open qty' },
  { id: 'allocated_qty', label: 'Allocated' },
  { id: 'left_qty', label: 'Left' },
  { id: 'unit_cost', label: 'U/Cost' },
  { id: 'amount', label: 'Amount' },
  { id: 'status', label: 'Stage' },
  { id: 'material_need_date', label: 'Need date' },
  { id: 'material_in_date', label: 'In date' },
  { id: 'due_date', label: 'PO due' },
  { id: 'coway_edd', label: 'Coway EDD' },
  { id: 'delivery_date', label: 'Delivered' },
  { id: 'week', label: 'Week' },
];

const MDP_HIDDEN_KEY = 'mdp-hidden-columns';

const mdpState = {
  year: new Date().getFullYear(),
  focus: 'all',
  data: null,
  loading: false,
  saving: false,
  search: '',
  psTypes: new Set(MDP_PS_DEFAULT),
  typesReady: false,
  catFilters: {
    plan_month: null,
    sales_order_no: null,
    ps_type: null,
    part_no: null,
    status: null,
    due_month: null,
    material_need_month: null,
    material_in_month: null,
  },
  dateRanges: {
    material_need_date: { from: '', to: '' },
    material_in_date: { from: '', to: '' },
  },
  hiddenCols: mdpLoadHiddenCols(),
  openFilterCol: '',
  filterSearch: '',
  selected: new Set(),
  sortCol: 'due_date',
  sortDir: 'asc',
};

function mdpEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mdpBlank(value) {
  const text = String(value ?? '').trim();
  return text || '(Blank)';
}

function mdpFormatMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function mdpFormatQty(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  if (Math.abs(num - Math.round(num)) <= MDP_QTY_TOLERANCE) return String(Math.round(num));
  return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function mdpFormatDate(value) {
  const text = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text || '-';
  const [y, m, d] = text.split('-');
  return `${d}/${m}/${y}`;
}

function mdpMonthKeyLabel(key) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!match) return String(key || '');
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return date.toLocaleString(undefined, { month: 'short', year: 'numeric' });
}

function mdpDueMonthLabel(row) {
  return mdpMonthLabelFromDate(row?.due_date);
}

function mdpMonthLabelFromDate(value) {
  const text = String(value || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(text)) return '(Blank)';
  return mdpMonthKeyLabel(text);
}

function mdpLoadHiddenCols() {
  try {
    const raw = JSON.parse(localStorage.getItem(MDP_HIDDEN_KEY) || '[]');
    if (!Array.isArray(raw)) return new Set();
    const allowed = new Set(MDP_COLUMNS.map((col) => col.id));
    return new Set(raw.filter((id) => allowed.has(id)));
  } catch (_err) {
    return new Set();
  }
}

function mdpSaveHiddenCols() {
  try {
    localStorage.setItem(MDP_HIDDEN_KEY, JSON.stringify([...mdpState.hiddenCols]));
  } catch (_err) {
    /* keep the choice for this visit */
  }
}

function mdpMoney(unit, qty, exch) {
  const rate = Number(exch) > 0 ? Number(exch) : 1;
  const price = Number(unit);
  if (!Number.isFinite(price)) return 0;
  return Math.round(price * (Number(qty) || 0) * rate * 100) / 100;
}

function mdpRoundQty(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function mdp$(id) {
  return document.getElementById(id);
}

function mdpSetAlert(message) {
  const el = mdp$('mdp-alert');
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || '';
}

function mdpSetLoading(loading) {
  mdpState.loading = loading;
  const el = mdp$('mdp-loading');
  if (el) el.hidden = !loading || Boolean(mdpState.data);
}

function mdpCurrentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function mdpDeliveryMonth(row) {
  return String(row?.delivery_date || '').slice(0, 7);
}

function mdpPlanTokens(row) {
  const tokens = (row.slices || []).map((slice) => mdpMonthKeyLabel(slice.plan_month));
  if (row.delivered && !tokens.length) tokens.push('Delivered');
  if (!row.delivered && !row.no_longer_open && Number(row.left_qty) > MDP_QTY_TOLERANCE) tokens.push('Unassigned');
  if (!tokens.length) tokens.push(row.no_longer_open ? '(Closed)' : 'Unassigned');
  return tokens;
}

function mdpCatTokens(row, colId) {
  if (colId === 'plan_month') return mdpPlanTokens(row);
  const conf = MDP_CAT_FILTERS[colId];
  return [conf ? conf.value(row) : ''];
}

function mdpPsOk(row) {
  return mdpState.psTypes.has(String(row.ps_type || '').trim().toUpperCase());
}

function mdpSearchOk(row) {
  const q = mdpState.search.trim().toLowerCase();
  if (!q) return true;
  const hay = [row.sales_order_no, row.process_sheet_no, row.pp_voucher_no, row.part_no, row.part_desc]
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

function mdpFocusOk(row) {
  const focus = mdpState.focus || 'all';
  if (row.delivered) {
    const month = mdpDeliveryMonth(row);
    if (focus === 'unassigned') return false;
    if (focus === 'all') return month === mdpCurrentMonthValue();
    return month === focus || (row.slices || []).some((slice) => slice.plan_month === focus);
  }
  if (focus === 'all') return true;
  if (focus === 'unassigned') {
    return !row.no_longer_open && Number(row.left_qty) > MDP_QTY_TOLERANCE;
  }
  return (row.slices || []).some((slice) => slice.plan_month === focus);
}

function mdpCatOk(row, exceptCol) {
  for (const [colId, selected] of Object.entries(mdpState.catFilters)) {
    if (colId === exceptCol || !(selected instanceof Set)) continue;
    const tokens = mdpCatTokens(row, colId);
    if (!tokens.some((token) => selected.has(token))) return false;
  }
  return true;
}

function mdpDateOk(row) {
  for (const [field, range] of Object.entries(mdpState.dateRanges)) {
    const from = String(range?.from || '');
    const to = String(range?.to || '');
    if (!from && !to) continue;
    const value = String(row?.[field] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    if (from && value < from) return false;
    if (to && value > to) return false;
  }
  return true;
}

function mdpBaseLines(exceptCol) {
  return (mdpState.data?.lines || []).filter(
    (row) => mdpPsOk(row) && mdpSearchOk(row) && mdpFocusOk(row) && mdpCatOk(row, exceptCol) && mdpDateOk(row),
  );
}

function mdpSortValue(row, col) {
  if (col === 'plan_month') return (row.plan_months || [])[0] || '9999-12';
  if (col === 'amount') return mdpDisplayAmount(row);
  const value = row[col];
  if (value == null || value === '') {
    if (['open_qty', 'allocated_qty', 'left_qty', 'unit_cost', 'amount', 'pp_partial_no'].includes(col)) return -1;
    return '9999-12-31';
  }
  return value;
}

function mdpVisibleLines() {
  const lines = mdpBaseLines(null);
  const dir = mdpState.sortDir === 'desc' ? -1 : 1;
  const col = mdpState.sortCol;
  lines.sort((a, b) => {
    const av = mdpSortValue(a, col);
    const bv = mdpSortValue(b, col);
    if (typeof av === 'number' || typeof bv === 'number') {
      return (Number(av) - Number(bv)) * dir;
    }
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
  });
  return lines;
}

function mdpShowsDeliveredQty(line) {
  if (!line.delivered) return false;
  const focus = mdpState.focus || 'all';
  const month = mdpDeliveryMonth(line);
  return focus === 'all' || month === focus;
}

function mdpDisplayAmount(line) {
  const focus = mdpState.focus || 'all';
  if (mdpShowsDeliveredQty(line)) return Number(line.amount) || 0;
  if (focus === 'unassigned') return mdpMoney(line.unit_cost, line.left_qty, line.exch_rate);
  if (focus !== 'all') {
    const slice = (line.slices || []).find((item) => item.plan_month === focus);
    return mdpMoney(line.unit_cost, slice ? slice.qty : 0, line.exch_rate);
  }
  return Number(line.amount) || 0;
}

function mdpDisplayQty(line) {
  const focus = mdpState.focus || 'all';
  if (mdpShowsDeliveredQty(line)) return Number(line.open_qty) || 0;
  if (focus === 'unassigned') return Number(line.left_qty) || 0;
  if (focus !== 'all') {
    const slice = (line.slices || []).find((item) => item.plan_month === focus);
    return slice ? Number(slice.qty) || 0 : 0;
  }
  return (line.slices || []).length ? Number(line.allocated_qty) || 0 : Number(line.open_qty) || 0;
}

function mdpSelectedVisible() {
  return mdpVisibleLines().filter((line) => mdpState.selected.has(line.row_id));
}

function mdpPsLabel(line) {
  const sheet = String(line.process_sheet_no || line.pp_voucher_no || '').trim();
  const partial = line.pp_partial_no ? ` #${line.pp_partial_no}` : '';
  if (sheet) return `${sheet}${partial}`;
  return line.ps_type === 'NOPP' ? 'No PP' : '-';
}

function mdpRangeActive(range) {
  return Boolean(range && (range.from || range.to));
}

function mdpFilterActive(colId) {
  if (mdpState.catFilters[colId] instanceof Set) return true;
  const spec = MDP_DATE_RANGES[colId];
  return Boolean(spec && mdpRangeActive(mdpState.dateRanges[spec.field]));
}

function mdpHasColumnFilters() {
  if (Object.values(mdpState.catFilters).some((value) => value instanceof Set)) return true;
  return Object.values(mdpState.dateRanges).some((range) => mdpRangeActive(range));
}

function mdpRenderPsPanel() {
  const panel = mdp$('mdp-ps-type-panel');
  const btn = mdp$('mdp-ps-type-btn');
  if (!panel || !btn) return;
  const open = !panel.hidden;
  panel.innerHTML = MDP_PS_TYPES.map((type) => {
    const checked = mdpState.psTypes.has(type) ? ' checked' : '';
    return `<label class="filter-dropdown-item"><input type="checkbox" value="${type}"${checked}> ${type}</label>`;
  }).join('');
  panel.hidden = !open;
  const picked = MDP_PS_TYPES.filter((type) => mdpState.psTypes.has(type));
  btn.textContent = !picked.length || picked.length === MDP_PS_TYPES.length
    ? (picked.length ? 'All types ▾' : 'None ▾')
    : `${picked.join(', ')} ▾`;
}

function mdpRenderChips() {
  const nav = mdp$('mdp-month-nav');
  if (!nav) return;
  const now = new Date();
  const chips = [
    { key: 'all', label: 'All' },
    { key: 'unassigned', label: 'Unassigned' },
  ];
  for (let month = 1; month <= 12; month += 1) {
    const key = `${mdpState.year}-${String(month).padStart(2, '0')}`;
    const label = new Date(mdpState.year, month - 1, 1).toLocaleString(undefined, { month: 'short' });
    chips.push({ key, label, current: now.getFullYear() === mdpState.year && now.getMonth() + 1 === month });
  }
  nav.innerHTML = chips.map((chip) => {
    const active = mdpState.focus === chip.key ? ' is-active' : '';
    const current = chip.current ? ' is-current' : '';
    return `<button type="button" class="mdp-month-chip${active}${current}" data-focus="${chip.key}">${chip.label}</button>`;
  }).join('');
}

function mdpRenderKpis() {
  const el = mdp$('mdp-kpi');
  if (!el) return;
  const lines = mdpVisibleLines();
  if (!mdpState.data) {
    el.hidden = true;
    return;
  }
  let qty = 0;
  let amount = 0;
  for (const line of lines) {
    qty += mdpDisplayQty(line);
    amount += mdpDisplayAmount(line);
  }
  const focus = mdpState.focus || 'all';
  const qtyLabel = focus === 'unassigned' ? 'Left qty' : (focus === 'all' ? 'Qty' : 'Month qty');
  const amountLabel = focus === 'all' ? 'Amount' : (focus === 'unassigned' ? 'Left amount' : 'Month amount');
  el.hidden = false;
  el.innerHTML = `
    <article class="mdp-kpi">
      <span class="mdp-kpi-label">Lines</span>
      <div class="mdp-kpi-value">${lines.length}</div>
      <div class="mdp-kpi-sub">${mdpState.selected.size} selected</div>
    </article>
    <article class="mdp-kpi mdp-kpi--qty">
      <span class="mdp-kpi-label">${qtyLabel}</span>
      <div class="mdp-kpi-value">${mdpFormatQty(mdpRoundQty(qty))}</div>
    </article>
    <article class="mdp-kpi mdp-kpi--amount">
      <span class="mdp-kpi-label">${amountLabel}</span>
      <div class="mdp-kpi-value">${mdpFormatMoney(Math.round(amount * 100) / 100)}</div>
    </article>
  `;
}

function mdpRenderMeta() {
  const meta = mdp$('mdp-meta');
  const sub = mdp$('mdp-list-sub');
  const lines = mdpState.data?.lines || [];
  const visible = mdpState.data ? mdpVisibleLines().length : 0;
  if (meta) {
    const jobs = mdpState.data?.active_job_count;
    meta.textContent = mdpState.data
      ? `${visible} shown / ${lines.length} lines${jobs != null ? ` · ${jobs} open jobs` : ''}`
      : '';
  }
  if (sub) {
    const focus = mdpState.focus || 'all';
    if (focus === 'all') {
      sub.textContent = 'Open lines, plus anything delivered this month.';
    } else if (focus === 'unassigned') {
      sub.textContent = 'Lines that are not assigned to a month yet.';
    } else {
      sub.textContent = `Lines assigned to ${mdpMonthKeyLabel(focus)}, plus lines delivered in that month.`;
    }
  }
}

function mdpFilterChips() {
  const chips = [];
  if (mdpState.search.trim()) chips.push({ label: `Search: ${mdpState.search.trim()}`, clear: 'search' });
  for (const [colId, selected] of Object.entries(mdpState.catFilters)) {
    if (!(selected instanceof Set)) continue;
    const conf = MDP_CAT_FILTERS[colId];
    chips.push({ label: `${conf.label}: ${selected.size}`, clear: colId });
  }
  for (const [field, range] of Object.entries(mdpState.dateRanges)) {
    if (!mdpRangeActive(range)) continue;
    const spec = Object.values(MDP_DATE_RANGES).find((item) => item.field === field);
    const from = range.from ? mdpFormatDate(range.from) : '…';
    const to = range.to ? mdpFormatDate(range.to) : '…';
    chips.push({ label: `${spec?.label || field}: ${from} – ${to}`, clear: `range:${field}` });
  }
  return chips;
}

function mdpRenderFilterChips() {
  const el = mdp$('mdp-filter-chips');
  const clearBtn = mdp$('mdp-clear-filters');
  const chips = mdpFilterChips();
  if (clearBtn) clearBtn.hidden = !chips.length;
  if (!el) return;
  if (!chips.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = chips.map((chip) => `
    <button type="button" class="mdp-filter-chip" data-clear-filter="${mdpEscape(chip.clear)}">
      <span>${mdpEscape(chip.label)}</span>
      <span aria-hidden="true">×</span>
    </button>
  `).join('');
}

function mdpSyncFilterButtons() {
  document.querySelectorAll('[data-mdp-filter]').forEach((btn) => {
    const colId = btn.dataset.mdpFilter;
    const selected = mdpState.catFilters[colId];
    const spec = MDP_DATE_RANGES[colId];
    const rangeOn = Boolean(spec && mdpRangeActive(mdpState.dateRanges[spec.field]));
    const active = selected instanceof Set || rangeOn;
    const badge = btn.querySelector('.mdp-filter-badge');
    btn.classList.toggle('is-filtering', active);
    btn.classList.toggle('is-active', mdpState.openFilterCol === colId);
    if (badge) {
      badge.hidden = !active;
      if (selected instanceof Set) badge.textContent = String(selected.size);
      else badge.textContent = rangeOn ? '1' : '';
    }
  });
  document.querySelectorAll('.mdp-table th[data-sort]').forEach((th) => {
    th.classList.toggle('is-sorted', th.dataset.sort === mdpState.sortCol);
  });
}

function mdpSyncActions() {
  const selected = mdpSelectedVisible();
  const monthReady = Boolean(mdp$('mdp-assign-month')?.value);
  const canClear = selected.some((line) => (line.slices || []).some((slice) => slice.commitment_id != null));
  const assign = mdp$('mdp-assign');
  const clear = mdp$('mdp-clear');
  if (assign) assign.disabled = mdpState.saving || !selected.length || !monthReady;
  if (clear) clear.disabled = mdpState.saving || !canClear;
  const meta = mdp$('mdp-selection-meta');
  if (meta) {
    if (!selected.length) {
      meta.textContent = 'Select lines, then assign them to a month.';
    } else {
      meta.textContent = `${selected.length} selected. Assign puts the whole open quantity in that month.`;
    }
  }
  const visible = mdpVisibleLines();
  const box = mdp$('mdp-select-all');
  if (box) {
    const selectedCount = visible.filter((line) => mdpState.selected.has(line.row_id)).length;
    box.checked = visible.length > 0 && selectedCount === visible.length;
    box.indeterminate = selectedCount > 0 && selectedCount < visible.length;
  }
  const exportBtn = mdp$('mdp-export');
  if (exportBtn) exportBtn.hidden = !mdpState.data;
}

function mdpPlanHtml(line) {
  const labels = (line.slices || []).map((slice) => mdpMonthKeyLabel(slice.plan_month));
  const flags = [
    line.delivered ? '<span class="mdp-flag mdp-flag--delivered">Delivered</span>' : '',
    line.over_allocated ? '<span class="mdp-flag mdp-flag--over">Over</span>' : '',
    line.no_longer_open ? '<span class="mdp-flag mdp-flag--closed">Closed</span>' : '',
  ].join('');
  const text = labels.length
    ? `<span class="mdp-plan-month">${labels.map((label) => mdpEscape(label)).join(' · ')}</span>`
    : '<span class="mdp-muted">—</span>';
  return `${text}${flags}`;
}

function mdpRenderTable() {
  const body = mdp$('mdp-body');
  const empty = mdp$('mdp-empty');
  const list = mdp$('mdp-list');
  if (!body) return;
  const lines = mdpState.data ? mdpVisibleLines() : [];
  if (list) list.hidden = !mdpState.data;
  if (empty) empty.hidden = !mdpState.data || lines.length > 0;
  body.innerHTML = lines.map((line) => {
    const checked = mdpState.selected.has(line.row_id) ? ' checked' : '';
    const plan = mdpPlanHtml(line);
    const rowClass = [
      mdpState.selected.has(line.row_id) ? 'is-selected' : '',
      line.over_allocated ? 'mdp-row--over' : '',
      line.no_longer_open ? 'mdp-row--closed' : '',
    ].filter(Boolean).join(' ');
    return `
      <tr class="${rowClass}" data-row-id="${mdpEscape(line.row_id)}">
        <td class="mdp-check-col"><input type="checkbox" class="mdp-row-check" data-line-id="${mdpEscape(line.row_id)}"${checked} aria-label="Select line"></td>
        ${mdpTd('plan_month', plan)}
        ${mdpTd('sales_order_no', mdpEscape(line.sales_order_no || '-'))}
        ${mdpTd('process_sheet_no', mdpEscape(mdpPsLabel(line)))}
        ${mdpTd('part_no', mdpEscape(line.part_no || '-'))}
        ${mdpTd('part_desc', mdpEscape(line.part_desc || '-'), 'mdp-desc')}
        ${mdpTd('open_qty', mdpFormatQty(line.open_qty), 'mdp-num')}
        ${mdpTd('allocated_qty', mdpFormatQty(line.allocated_qty), 'mdp-num')}
        ${mdpTd('left_qty', mdpFormatQty(line.left_qty), 'mdp-num')}
        ${mdpTd('unit_cost', line.unit_cost == null ? '-' : mdpFormatMoney(line.unit_cost), 'mdp-num')}
        ${mdpTd('amount', mdpFormatMoney(mdpDisplayAmount(line)), 'mdp-num')}
        ${mdpTd('status', mdpEscape(line.status || '-'))}
        ${mdpTd('material_need_date', mdpEscape(mdpFormatDate(line.material_need_date)))}
        ${mdpTd('material_in_date', mdpEscape(mdpFormatDate(line.material_in_date)))}
        ${mdpTd('due_date', mdpEscape(mdpFormatDate(line.due_date)))}
        ${mdpTd('coway_edd', mdpEscape(mdpFormatDate(line.coway_edd)))}
        ${mdpTd('delivery_date', mdpEscape(mdpFormatDate(line.delivery_date)))}
        ${mdpTd('week', mdpEscape(line.week || '-'))}
      </tr>
    `;
  }).join('');
  mdpApplyHiddenColumns();
}

function mdpTd(colId, html, extraClass) {
  const hidden = mdpState.hiddenCols.has(colId) ? ' mdp-col--hidden' : '';
  const cls = `${extraClass || ''}${hidden}`.trim();
  return `<td data-col="${colId}"${cls ? ` class="${cls}"` : ''}>${html}</td>`;
}

function mdpApplyHiddenColumns() {
  document.querySelectorAll('.mdp-table [data-col]').forEach((el) => {
    el.classList.toggle('mdp-col--hidden', mdpState.hiddenCols.has(el.dataset.col));
  });
}

function mdpRenderColumnsPanel() {
  const panel = mdp$('mdp-columns-panel');
  const btn = mdp$('mdp-columns-btn');
  if (!panel || !btn) return;
  const open = !panel.hidden;
  const hiddenCount = mdpState.hiddenCols.size;
  btn.textContent = hiddenCount ? `Columns (${MDP_COLUMNS.length - hiddenCount})` : 'Columns';
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  panel.innerHTML = `
    <div class="mdp-columns-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-mdp-cols="show">Show all</button>
    </div>
    ${MDP_COLUMNS.map((col) => {
      const checked = mdpState.hiddenCols.has(col.id) ? '' : ' checked';
      return `<label class="filter-dropdown-item"><input type="checkbox" data-mdp-col="${col.id}"${checked}> ${mdpEscape(col.label)}</label>`;
    }).join('')}
  `;
  panel.hidden = !open;
}

function mdpUniqueValues(colId) {
  const counts = new Map();
  for (const row of mdpBaseLines(colId)) {
    for (const token of mdpCatTokens(row, colId)) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));
}

function mdpCloseFilter() {
  const pop = mdp$('mdp-col-filter-popover');
  if (pop) {
    pop.hidden = true;
    pop.innerHTML = '';
  }
  mdpState.openFilterCol = '';
  mdpState.filterSearch = '';
  mdpSyncFilterButtons();
}

function mdpPositionFilter() {
  const pop = mdp$('mdp-col-filter-popover');
  if (!pop || pop.hidden || !mdpState.openFilterCol) return;
  const btn = document.querySelector(`[data-mdp-filter="${CSS.escape(mdpState.openFilterCol)}"]`);
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const width = pop.offsetWidth || 260;
  pop.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)}px`;
  pop.style.top = `${rect.bottom + 4}px`;
}

function mdpRenderFilterPopover() {
  const pop = mdp$('mdp-col-filter-popover');
  const colId = mdpState.openFilterCol;
  const conf = MDP_CAT_FILTERS[colId];
  if (!pop || !conf) return;
  const values = mdpUniqueValues(colId);
  const active = mdpState.catFilters[colId];
  const q = mdpState.filterSearch.trim().toLowerCase();
  const visible = q ? values.filter((row) => row.value.toLowerCase().includes(q)) : values;
  const selectedCount = active instanceof Set
    ? values.filter((row) => active.has(row.value)).length
    : values.length;
  const checks = visible.map((row) => {
    const checked = !(active instanceof Set) || active.has(row.value) ? ' checked' : '';
    return `
      <label class="mdp-col-filter-check" title="${mdpEscape(row.value)}">
        <input type="checkbox" data-mdp-cat-value="${mdpEscape(row.value)}"${checked}>
        <span class="mdp-col-filter-check-label">${mdpEscape(row.value)}</span>
        <span class="mdp-col-filter-count">${row.count}</span>
      </label>
    `;
  }).join('') || '<div class="mdp-col-filter-meta">No values</div>';
  const rangeSpec = MDP_DATE_RANGES[colId];
  const range = rangeSpec ? mdpState.dateRanges[rangeSpec.field] : null;
  const rangeHtml = rangeSpec ? `
    <div class="mdp-date-range">
      <label>From <input type="date" data-mdp-range="from" value="${mdpEscape(range?.from || '')}"></label>
      <label>To <input type="date" data-mdp-range="to" value="${mdpEscape(range?.to || '')}"></label>
    </div>
  ` : '';
  pop.hidden = false;
  pop.innerHTML = `
    <div class="mdp-col-filter-title">Filter: ${mdpEscape(conf.label)}</div>
    ${rangeHtml}
    <input type="search" class="mdp-col-filter-search" id="mdp-col-filter-search" placeholder="Search values" value="${mdpEscape(mdpState.filterSearch)}">
    <div class="mdp-col-filter-toolbar">
      <button type="button" class="btn btn-ghost btn-sm" data-mdp-cat-action="all">Select all</button>
      <button type="button" class="btn btn-ghost btn-sm" data-mdp-cat-action="none">Clear</button>
    </div>
    <div class="mdp-col-filter-checks">${checks}</div>
    <div class="mdp-col-filter-actions">
      <span class="mdp-col-filter-meta">${selectedCount} of ${values.length}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-mdp-cat-action="reset">Reset filter</button>
    </div>
  `;
  mdpPositionFilter();
  mdp$('mdp-col-filter-search')?.focus();
}

function mdpApplyCat(colId, nextSet, allValues) {
  if (!(nextSet instanceof Set) || nextSet.size >= allValues.length) mdpState.catFilters[colId] = null;
  else mdpState.catFilters[colId] = nextSet;
  mdpRender();
  if (mdpState.openFilterCol === colId) mdpRenderFilterPopover();
}

function mdpRender() {
  mdpRenderPsPanel();
  mdpRenderColumnsPanel();
  mdpApplyHiddenColumns();
  mdpRenderChips();
  mdpRenderMeta();
  mdpRenderFilterChips();
  mdpRenderKpis();
  mdpRenderTable();
  mdpSyncFilterButtons();
  mdpSyncActions();
}

async function mdpApi(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = {};
  try {
    data = await res.json();
  } catch (_err) {
    data = {};
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

async function mdpLoad({ refresh = false } = {}) {
  mdpSetLoading(true);
  mdpSetAlert('');
  try {
    const params = new URLSearchParams({ year: String(mdpState.year) });
    if (refresh) params.set('refresh', '1');
    const data = await mdpApi(`/api/monthly-delivery-plan?${params}`);
    if (!mdpState.typesReady) {
      const defaults = Array.isArray(data.default_ps_types) && data.default_ps_types.length
        ? data.default_ps_types
        : MDP_PS_DEFAULT;
      mdpState.psTypes = new Set(defaults);
      mdpState.typesReady = true;
    }
    mdpState.data = data;
    const live = new Set((data.lines || []).map((line) => line.row_id));
    for (const id of [...mdpState.selected]) {
      if (!live.has(id)) mdpState.selected.delete(id);
    }
    mdpRender();
  } catch (err) {
    mdpState.data = null;
    mdpSetAlert(err?.message || String(err));
    mdpRender();
  } finally {
    mdpSetLoading(false);
  }
}

function mdpCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function mdpExportCsv() {
  const lines = mdpVisibleLines();
  if (!mdpState.data) return;
  const headers = [
    'plan_month', 'sales_order_no', 'process_sheet_no', 'part_no', 'part_desc',
    'open_qty', 'allocated_qty', 'left_qty', 'unit_cost', 'exch_rate', 'amount',
    'status', 'material_need_date', 'material_in_date', 'due_date', 'coway_edd', 'delivery_date', 'week',
  ].filter((key) => key === 'exch_rate' || !mdpState.hiddenCols.has(key));
  const rows = [headers.join(',')];
  for (const line of lines) {
    const record = {
      plan_month: (line.plan_months || []).map((key) => mdpMonthKeyLabel(key)).join(' · '),
      sales_order_no: line.sales_order_no || '',
      process_sheet_no: mdpPsLabel(line),
      part_no: line.part_no || '',
      part_desc: line.part_desc || '',
      open_qty: line.open_qty ?? '',
      allocated_qty: line.allocated_qty ?? '',
      left_qty: line.left_qty ?? '',
      unit_cost: line.unit_cost ?? '',
      exch_rate: line.exch_rate ?? '',
      amount: mdpDisplayAmount(line),
      status: line.status || '',
      material_need_date: line.material_need_date || '',
      material_in_date: line.material_in_date || '',
      due_date: line.due_date || '',
      coway_edd: line.coway_edd || '',
      delivery_date: line.delivery_date || '',
      week: line.week || '',
    };
    rows.push(headers.map((key) => mdpCsvCell(record[key])).join(','));
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `monthly-delivery-plan-${mdpState.focus || 'all'}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function mdpAssignItem(line) {
  return {
    row_id: line.row_id,
    open_qty: line.open_qty,
    sales_order_no: line.sales_order_no,
    source_line_item_no: line.source_line_item_no,
    pp_voucher_no: line.pp_voucher_no,
    process_sheet_no: line.process_sheet_no,
    pp_partial_no: line.pp_partial_no,
    ps_type: line.ps_type,
    part_no: line.part_no,
    part_desc: line.part_desc,
    unit_cost: line.unit_cost,
    exch_rate: line.exch_rate,
    status: line.status,
    due_date: line.due_date,
    coway_edd: line.coway_edd,
    week: line.week,
  };
}

function mdpApplyAssigned(saved) {
  const byId = new Map((saved || []).map((row) => [row.row_id, row]));
  for (const line of mdpState.data?.lines || []) {
    const hit = byId.get(line.row_id);
    if (!hit) continue;
    const qty = Number(hit.qty) || 0;
    line.slices = [{
      plan_month: hit.plan_month,
      qty,
      commitment_id: hit.commitment_id,
    }];
    line.plan_months = [hit.plan_month];
    line.allocated_qty = qty;
    line.left_qty = line.delivered ? 0 : Math.max(0, mdpRoundQty(Number(line.open_qty) - qty));
    line.plan_month_label = mdpMonthKeyLabel(hit.plan_month);
    line.amount = mdpMoney(line.unit_cost, line.delivered ? line.open_qty : qty, line.exch_rate);
  }
  mdpRender();
}

function mdpForgetCommitments(ids) {
  const drop = new Set(ids.map((id) => String(id)));
  for (const line of mdpState.data?.lines || []) {
    const slices = (line.slices || []).filter((slice) => !drop.has(String(slice.commitment_id)));
    if (slices.length === (line.slices || []).length) continue;
    const allocated = slices.reduce((sum, slice) => sum + (Number(slice.qty) || 0), 0);
    line.slices = slices;
    line.plan_months = slices.map((slice) => slice.plan_month);
    line.allocated_qty = mdpRoundQty(allocated);
    line.left_qty = line.delivered ? 0 : Math.max(0, mdpRoundQty(Number(line.open_qty) - allocated));
    line.plan_month_label = slices.map((slice) => mdpMonthKeyLabel(slice.plan_month)).join(' · ');
    const qty = slices.length ? allocated : Number(line.open_qty) || 0;
    line.amount = mdpMoney(line.unit_cost, line.delivered ? line.open_qty : qty, line.exch_rate);
  }
  mdpRender();
}

async function mdpAssign() {
  const month = mdp$('mdp-assign-month')?.value || '';
  if (!month) {
    mdpSetAlert('Choose a delivery month.');
    return;
  }
  const items = [];
  for (const line of mdpSelectedVisible()) {
    if (line.no_longer_open) continue;
    if (Number(line.open_qty) <= MDP_QTY_TOLERANCE) continue;
    items.push(mdpAssignItem(line));
  }
  if (!items.length) {
    mdpSetAlert('Nothing to assign on the selected lines.');
    return;
  }
  mdpState.saving = true;
  mdpSyncActions();
  mdpSetAlert('');
  try {
    const saved = await mdpApi('/api/monthly-delivery-plan/slices', {
      method: 'POST',
      body: JSON.stringify({ plan_month: month, whole: true, items }),
    });
    mdpApplyAssigned(saved.assigned);
  } catch (err) {
    mdpSetAlert(err?.message || String(err));
  } finally {
    mdpState.saving = false;
    mdpSyncActions();
  }
}

async function mdpClear() {
  const selected = mdpSelectedVisible().filter((line) =>
    (line.slices || []).some((slice) => slice.commitment_id != null),
  );
  const ids = [];
  for (const line of selected) {
    for (const slice of line.slices || []) {
      if (slice.commitment_id != null) ids.push(slice.commitment_id);
    }
  }
  if (!ids.length) return;
  const noun = selected.length === 1 ? 'line' : 'lines';
  if (!window.confirm(`Clear the month on ${selected.length} ${noun}?`)) return;
  mdpState.saving = true;
  mdpSyncActions();
  mdpSetAlert('');
  try {
    await mdpApi('/api/monthly-delivery-plan/slices/clear', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
    mdpForgetCommitments(ids);
  } catch (err) {
    mdpSetAlert(err?.message || String(err));
  } finally {
    mdpState.saving = false;
    mdpSyncActions();
  }
}

function mdpClearFilter(name) {
  if (name === 'search') {
    mdpState.search = '';
    const input = mdp$('mdp-search');
    if (input) input.value = '';
  } else if (name.startsWith('range:')) {
    const field = name.slice('range:'.length);
    if (mdpState.dateRanges[field]) mdpState.dateRanges[field] = { from: '', to: '' };
  } else if (mdpState.catFilters[name] instanceof Set) {
    mdpState.catFilters[name] = null;
  }
  mdpCloseFilter();
  mdpRender();
}

function mdpBind() {
  const dropdown = mdp$('mdp-ps-type-dropdown');
  const psBtn = mdp$('mdp-ps-type-btn');
  const panel = mdp$('mdp-ps-type-panel');
  psBtn?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (panel) panel.hidden = !panel.hidden;
  });
  panel?.addEventListener('change', (ev) => {
    const input = ev.target.closest('input[type="checkbox"]');
    if (!input) return;
    if (input.checked) mdpState.psTypes.add(input.value);
    else mdpState.psTypes.delete(input.value);
    mdpRender();
  });
  const colsDropdown = mdp$('mdp-columns-dropdown');
  const colsBtn = mdp$('mdp-columns-btn');
  const colsPanel = mdp$('mdp-columns-panel');
  colsBtn?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (colsPanel) colsPanel.hidden = !colsPanel.hidden;
    mdpRenderColumnsPanel();
  });
  colsPanel?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!ev.target.closest('[data-mdp-cols="show"]')) return;
    mdpState.hiddenCols = new Set();
    mdpSaveHiddenCols();
    mdpRender();
  });
  colsPanel?.addEventListener('change', (ev) => {
    const input = ev.target.closest('input[data-mdp-col]');
    if (!input) return;
    const colId = input.dataset.mdpCol;
    if (input.checked) mdpState.hiddenCols.delete(colId);
    else if (mdpState.hiddenCols.size < MDP_COLUMNS.length - 1) mdpState.hiddenCols.add(colId);
    else input.checked = true;
    mdpSaveHiddenCols();
    mdpRender();
  });
  document.addEventListener('click', (ev) => {
    if (dropdown && !dropdown.contains(ev.target)) {
      if (panel) panel.hidden = true;
    }
    if (colsDropdown && !colsDropdown.contains(ev.target)) {
      if (colsPanel) colsPanel.hidden = true;
    }
    if (ev.target.closest('#mdp-col-filter-popover') || ev.target.closest('[data-mdp-filter]')) return;
    if (mdpState.openFilterCol) mdpCloseFilter();
  });

  mdp$('mdp-search')?.addEventListener('input', (ev) => {
    mdpState.search = ev.target.value || '';
    mdpRender();
  });
  mdp$('mdp-year')?.addEventListener('change', (ev) => {
    const next = Number(ev.target.value);
    if (!Number.isFinite(next)) return;
    mdpState.year = Math.max(2000, Math.min(2100, next));
    if (/^\d{4}-\d{2}$/.test(mdpState.focus)) {
      mdpState.focus = `${mdpState.year}-${mdpState.focus.slice(5)}`;
    }
    mdpLoad();
  });
  mdp$('mdp-month-nav')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-focus]');
    if (!btn) return;
    mdpState.focus = btn.dataset.focus || 'all';
    mdpRender();
  });
  mdp$('mdp-refresh')?.addEventListener('click', () => mdpLoad({ refresh: true }));
  mdp$('mdp-export')?.addEventListener('click', mdpExportCsv);
  mdp$('mdp-assign')?.addEventListener('click', mdpAssign);
  mdp$('mdp-clear')?.addEventListener('click', mdpClear);
  mdp$('mdp-assign-month')?.addEventListener('change', mdpSyncActions);
  mdp$('mdp-clear-filters')?.addEventListener('click', () => {
    mdpState.search = '';
    const input = mdp$('mdp-search');
    if (input) input.value = '';
    for (const key of Object.keys(mdpState.catFilters)) mdpState.catFilters[key] = null;
    for (const field of Object.keys(mdpState.dateRanges)) {
      mdpState.dateRanges[field] = { from: '', to: '' };
    }
    mdpCloseFilter();
    mdpRender();
  });
  mdp$('mdp-filter-chips')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-clear-filter]');
    if (!btn) return;
    mdpClearFilter(btn.dataset.clearFilter);
  });
  mdp$('mdp-select-all')?.addEventListener('change', (ev) => {
    const checked = Boolean(ev.target.checked);
    for (const line of mdpVisibleLines()) {
      if (checked) mdpState.selected.add(line.row_id);
      else mdpState.selected.delete(line.row_id);
    }
    mdpRenderTable();
    mdpRenderKpis();
    mdpSyncActions();
  });
  mdp$('mdp-body')?.addEventListener('change', (ev) => {
    const check = ev.target.closest('.mdp-row-check');
    if (check) {
      const id = check.dataset.lineId;
      if (!id) return;
      if (check.checked) mdpState.selected.add(id);
      else mdpState.selected.delete(id);
      check.closest('tr')?.classList.toggle('is-selected', check.checked);
      mdpRenderKpis();
      mdpSyncActions();
    }
  });
  document.querySelector('.mdp-table')?.addEventListener('click', (ev) => {
    const th = ev.target.closest('th[data-sort]');
    if (!th || ev.target.closest('[data-mdp-filter]')) return;
    const col = th.dataset.sort;
    if (!col) return;
    if (mdpState.sortCol === col) mdpState.sortDir = mdpState.sortDir === 'asc' ? 'desc' : 'asc';
    else {
      mdpState.sortCol = col;
      mdpState.sortDir = 'asc';
    }
    mdpRender();
  });
  document.querySelectorAll('[data-mdp-filter]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const colId = btn.dataset.mdpFilter;
      if (mdpState.openFilterCol === colId) {
        mdpCloseFilter();
        return;
      }
      mdpState.openFilterCol = colId;
      mdpState.filterSearch = '';
      mdpSyncFilterButtons();
      mdpRenderFilterPopover();
    });
  });
  const pop = mdp$('mdp-col-filter-popover');
  pop?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const actionBtn = ev.target.closest('[data-mdp-cat-action]');
    const colId = mdpState.openFilterCol;
    if (!actionBtn || !colId) return;
    const allValues = mdpUniqueValues(colId).map((row) => row.value);
    const action = actionBtn.dataset.mdpCatAction;
    if (action === 'reset') {
      mdpState.catFilters[colId] = null;
      const spec = MDP_DATE_RANGES[colId];
      if (spec) mdpState.dateRanges[spec.field] = { from: '', to: '' };
      mdpRender();
      mdpRenderFilterPopover();
      return;
    }
    mdpApplyCat(colId, action === 'all' ? new Set(allValues) : new Set(), allValues);
  });
  pop?.addEventListener('change', (ev) => {
    const rangeInput = ev.target.closest('input[data-mdp-range]');
    const colId = mdpState.openFilterCol;
    if (rangeInput && colId && MDP_DATE_RANGES[colId]) {
      const field = MDP_DATE_RANGES[colId].field;
      mdpState.dateRanges[field][rangeInput.dataset.mdpRange] = rangeInput.value || '';
      mdpRender();
      mdpRenderFilterPopover();
      return;
    }
    const check = ev.target.closest('input[data-mdp-cat-value]');
    if (!check || !colId) return;
    const allValues = mdpUniqueValues(colId).map((row) => row.value);
    const current = mdpState.catFilters[colId] instanceof Set
      ? new Set(mdpState.catFilters[colId])
      : new Set(allValues);
    if (check.checked) current.add(check.dataset.mdpCatValue);
    else current.delete(check.dataset.mdpCatValue);
    mdpApplyCat(colId, current, allValues);
  });
  pop?.addEventListener('input', (ev) => {
    if (!ev.target.matches('#mdp-col-filter-search')) return;
    mdpState.filterSearch = ev.target.value || '';
    mdpRenderFilterPopover();
  });
  window.addEventListener('resize', mdpPositionFilter);
  window.addEventListener('scroll', mdpPositionFilter, true);
}

document.addEventListener('DOMContentLoaded', () => {
  const now = new Date();
  mdpState.year = now.getFullYear();
  const year = mdp$('mdp-year');
  if (year) year.value = String(mdpState.year);
  const month = mdp$('mdp-assign-month');
  if (month && !month.value) month.value = mdpCurrentMonthValue();
  mdpBind();
  mdpRender();
  mdpLoad();
});
