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
};

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
  },
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
  const text = String(row?.due_date || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(text)) return '(Blank)';
  return mdpMonthKeyLabel(text);
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
  if (el) el.hidden = !loading;
}

function mdpCurrentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function mdpPlanTokens(row) {
  const tokens = (row.slices || []).map((slice) => mdpMonthKeyLabel(slice.plan_month));
  if (!row.no_longer_open && Number(row.left_qty) > MDP_QTY_TOLERANCE) tokens.push('Unassigned');
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

function mdpBaseLines(exceptCol) {
  return (mdpState.data?.lines || []).filter(
    (row) => mdpPsOk(row) && mdpSearchOk(row) && mdpFocusOk(row) && mdpCatOk(row, exceptCol),
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

function mdpDisplayAmount(line) {
  const focus = mdpState.focus || 'all';
  if (focus === 'unassigned') return mdpMoney(line.unit_cost, line.left_qty, line.exch_rate);
  if (focus !== 'all') {
    const slice = (line.slices || []).find((item) => item.plan_month === focus);
    return mdpMoney(line.unit_cost, slice ? slice.qty : 0, line.exch_rate);
  }
  return Number(line.amount) || 0;
}

function mdpDisplayQty(line) {
  const focus = mdpState.focus || 'all';
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

function mdpScopeSlices(line) {
  const focus = mdpState.focus || 'all';
  const slices = line.slices || [];
  if (focus === 'all') return slices;
  if (focus === 'unassigned') return [];
  return slices.filter((slice) => slice.plan_month === focus);
}

function mdpPsLabel(line) {
  const sheet = String(line.process_sheet_no || line.pp_voucher_no || '').trim();
  const partial = line.pp_partial_no ? ` #${line.pp_partial_no}` : '';
  if (sheet) return `${sheet}${partial}`;
  return line.ps_type === 'NOPP' ? 'No PP' : '-';
}

function mdpHasColumnFilters() {
  return Object.values(mdpState.catFilters).some((value) => value instanceof Set);
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
      sub.textContent = 'Amount is the assigned value, or the open value when nothing is assigned yet.';
    } else if (focus === 'unassigned') {
      sub.textContent = 'Lines that still have quantity left to place.';
    } else {
      sub.textContent = `${mdpMonthKeyLabel(focus)} totals count only the quantity assigned to that month.`;
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
    const active = mdpState.catFilters[colId] instanceof Set;
    const badge = btn.querySelector('.mdp-filter-badge');
    btn.classList.toggle('is-filtering', active);
    btn.classList.toggle('is-active', mdpState.openFilterCol === colId);
    if (badge) {
      badge.hidden = !active;
      badge.textContent = active ? String(mdpState.catFilters[colId].size) : '';
    }
  });
  document.querySelectorAll('.mdp-table th[data-sort]').forEach((th) => {
    th.classList.toggle('is-sorted', th.dataset.sort === mdpState.sortCol);
  });
}

function mdpSyncActions() {
  const selected = mdpSelectedVisible();
  const focus = mdpState.focus || 'all';
  const monthReady = Boolean(mdp$('mdp-assign-month')?.value);
  const canSlice = focus !== 'unassigned' && selected.some((line) => mdpScopeSlices(line).length);
  const assign = mdp$('mdp-assign');
  const move = mdp$('mdp-move');
  const clear = mdp$('mdp-clear');
  if (assign) assign.disabled = mdpState.saving || !selected.length || !monthReady;
  if (move) move.disabled = mdpState.saving || !canSlice || !monthReady;
  if (clear) clear.disabled = mdpState.saving || !canSlice;
  const meta = mdp$('mdp-selection-meta');
  if (meta) {
    if (!selected.length) {
      meta.textContent = 'Select lines, then assign them to a month. Leave qty blank to use what is left.';
    } else if (focus !== 'all' && focus !== 'unassigned') {
      meta.textContent = `${selected.length} selected. Assign adds quantity. Move and Clear affect ${mdpMonthKeyLabel(focus)} only.`;
    } else {
      meta.textContent = `${selected.length} selected. Assign adds quantity. Move and Clear apply to every saved month on those lines.`;
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

function mdpSliceHtml(slice) {
  const label = mdpMonthKeyLabel(slice.plan_month);
  const id = slice.commitment_id;
  return `
    <span class="mdp-slice">
      <span class="mdp-slice-label">${mdpEscape(label)}</span>
      <input type="number" class="mdp-slice-qty" min="0" step="any" value="${mdpEscape(slice.qty)}"
        data-commitment-id="${mdpEscape(id)}" aria-label="${mdpEscape(label)} quantity" ${id == null ? 'disabled' : ''}>
      <button type="button" class="mdp-slice-remove" data-commitment-id="${mdpEscape(id)}" aria-label="Remove ${mdpEscape(label)}" ${id == null ? 'disabled' : ''}>×</button>
    </span>
  `;
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
    const flags = [
      line.over_allocated ? '<span class="mdp-flag mdp-flag--over">Over</span>' : '',
      line.no_longer_open ? '<span class="mdp-flag mdp-flag--closed">Closed</span>' : '',
    ].join('');
    const slices = (line.slices || []).map(mdpSliceHtml).join('');
    const plan = slices
      ? `<div class="mdp-slices">${slices}${flags}</div>`
      : `<span class="mdp-muted">—</span>${flags}`;
    const rowClass = [
      mdpState.selected.has(line.row_id) ? 'is-selected' : '',
      line.over_allocated ? 'mdp-row--over' : '',
      line.no_longer_open ? 'mdp-row--closed' : '',
    ].filter(Boolean).join(' ');
    return `
      <tr class="${rowClass}" data-row-id="${mdpEscape(line.row_id)}">
        <td class="mdp-check-col"><input type="checkbox" class="mdp-row-check" data-line-id="${mdpEscape(line.row_id)}"${checked} aria-label="Select line"></td>
        <td>${plan}</td>
        <td>${mdpEscape(line.sales_order_no || '-')}</td>
        <td>${mdpEscape(mdpPsLabel(line))}</td>
        <td>${mdpEscape(line.part_no || '-')}</td>
        <td class="mdp-desc">${mdpEscape(line.part_desc || '-')}</td>
        <td class="mdp-num">${mdpFormatQty(line.open_qty)}</td>
        <td class="mdp-num">${mdpFormatQty(line.allocated_qty)}</td>
        <td class="mdp-num">${mdpFormatQty(line.left_qty)}</td>
        <td class="mdp-num">${line.unit_cost == null ? '-' : mdpFormatMoney(line.unit_cost)}</td>
        <td class="mdp-num">${mdpFormatMoney(mdpDisplayAmount(line))}</td>
        <td>${mdpEscape(line.status || '-')}</td>
        <td>${mdpEscape(mdpFormatDate(line.due_date))}</td>
        <td>${mdpEscape(mdpFormatDate(line.coway_edd))}</td>
        <td>${mdpEscape(line.week || '-')}</td>
      </tr>
    `;
  }).join('');
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
  pop.hidden = false;
  pop.innerHTML = `
    <div class="mdp-col-filter-title">Filter: ${mdpEscape(conf.label)}</div>
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
    'status', 'due_date', 'coway_edd', 'week',
  ];
  const rows = [headers.join(',')];
  for (const line of lines) {
    const record = {
      plan_month: line.plan_month_label || '',
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
      due_date: line.due_date || '',
      coway_edd: line.coway_edd || '',
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

async function mdpAssign() {
  const month = mdp$('mdp-assign-month')?.value || '';
  if (!month) {
    mdpSetAlert('Choose a delivery month.');
    return;
  }
  const raw = (mdp$('mdp-assign-qty')?.value || '').trim();
  const typed = raw === '' ? null : Number(raw);
  if (typed != null && (!Number.isFinite(typed) || typed <= 0)) {
    mdpSetAlert('Quantity must be greater than zero.');
    return;
  }
  const selected = mdpSelectedVisible();
  const items = [];
  for (const line of selected) {
    if (line.no_longer_open) continue;
    if (typed == null && Number(line.left_qty) <= MDP_QTY_TOLERANCE) continue;
    const item = { row_id: line.row_id };
    if (typed != null) item.qty = typed;
    items.push(item);
  }
  if (!items.length) {
    mdpSetAlert('Nothing left to assign on the selected lines.');
    return;
  }
  mdpState.saving = true;
  mdpSyncActions();
  mdpSetAlert('');
  try {
    await mdpApi('/api/monthly-delivery-plan/slices', {
      method: 'POST',
      body: JSON.stringify({ plan_month: month, items }),
    });
    const qty = mdp$('mdp-assign-qty');
    if (qty) qty.value = '';
    await mdpLoad();
  } catch (err) {
    mdpSetAlert(err?.message || String(err));
  } finally {
    mdpState.saving = false;
    mdpSyncActions();
  }
}

async function mdpMove() {
  const month = mdp$('mdp-assign-month')?.value || '';
  if (!month) {
    mdpSetAlert('Choose a delivery month.');
    return;
  }
  const ids = [];
  for (const line of mdpSelectedVisible()) {
    for (const slice of mdpScopeSlices(line)) {
      if (slice.commitment_id == null || slice.plan_month === month) continue;
      ids.push(slice.commitment_id);
    }
  }
  if (!ids.length) {
    mdpSetAlert('Those lines are already in that month.');
    return;
  }
  mdpState.saving = true;
  mdpSyncActions();
  mdpSetAlert('');
  try {
    for (const id of ids) {
      await mdpApi(`/api/monthly-delivery-plan/slices/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ plan_month: month }),
      });
    }
    await mdpLoad();
  } catch (err) {
    mdpSetAlert(err?.message || String(err));
    await mdpLoad();
  } finally {
    mdpState.saving = false;
    mdpSyncActions();
  }
}

async function mdpClear() {
  const ids = [];
  for (const line of mdpSelectedVisible()) {
    for (const slice of mdpScopeSlices(line)) {
      if (slice.commitment_id != null) ids.push(slice.commitment_id);
    }
  }
  if (!ids.length) return;
  const label = mdpState.focus && mdpState.focus !== 'all' && mdpState.focus !== 'unassigned'
    ? mdpMonthKeyLabel(mdpState.focus)
    : 'all months';
  if (!window.confirm(`Clear ${ids.length} assignment${ids.length === 1 ? '' : 's'} for ${label}?`)) return;
  mdpState.saving = true;
  mdpSyncActions();
  mdpSetAlert('');
  try {
    for (const id of ids) {
      await mdpApi(`/api/monthly-delivery-plan/slices/${id}`, { method: 'DELETE' });
    }
    await mdpLoad();
  } catch (err) {
    mdpSetAlert(err?.message || String(err));
    await mdpLoad();
  } finally {
    mdpState.saving = false;
    mdpSyncActions();
  }
}

async function mdpUpdateSliceQty(commitmentId, raw) {
  const qty = Number(raw);
  if (!Number.isFinite(qty)) return;
  mdpState.saving = true;
  mdpSetAlert('');
  try {
    if (qty <= MDP_QTY_TOLERANCE) {
      await mdpApi(`/api/monthly-delivery-plan/slices/${commitmentId}`, { method: 'DELETE' });
    } else {
      await mdpApi(`/api/monthly-delivery-plan/slices/${commitmentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ qty }),
      });
    }
    await mdpLoad();
  } catch (err) {
    mdpSetAlert(err?.message || String(err));
    await mdpLoad();
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
  document.addEventListener('click', (ev) => {
    if (dropdown && !dropdown.contains(ev.target)) {
      if (panel) panel.hidden = true;
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
    mdpRender();
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
  mdp$('mdp-move')?.addEventListener('click', mdpMove);
  mdp$('mdp-clear')?.addEventListener('click', mdpClear);
  mdp$('mdp-assign-month')?.addEventListener('change', mdpSyncActions);
  mdp$('mdp-clear-filters')?.addEventListener('click', () => {
    mdpState.search = '';
    const input = mdp$('mdp-search');
    if (input) input.value = '';
    for (const key of Object.keys(mdpState.catFilters)) mdpState.catFilters[key] = null;
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
      return;
    }
    const qty = ev.target.closest('.mdp-slice-qty');
    if (qty && qty.dataset.commitmentId) {
      mdpUpdateSliceQty(qty.dataset.commitmentId, qty.value);
    }
  });
  mdp$('mdp-body')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.mdp-slice-remove');
    if (!btn || !btn.dataset.commitmentId) return;
    mdpUpdateSliceQty(btn.dataset.commitmentId, 0);
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
      mdpRender();
      mdpRenderFilterPopover();
      return;
    }
    mdpApplyCat(colId, action === 'all' ? new Set(allValues) : new Set(), allValues);
  });
  pop?.addEventListener('change', (ev) => {
    const check = ev.target.closest('input[data-mdp-cat-value]');
    const colId = mdpState.openFilterCol;
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
