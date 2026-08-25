/* SO outstanding balance - Reports */

const SOB_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR', 'NOPP'];
const SOB_DEFAULT_PS_TYPES = ['APS', 'NPS', 'PPS', 'NOPP'];
const SOB_OPEN_QTY_TOLERANCE = 0.0001;

const sobState = {
  data: null,
  loading: false,
  search: '',
  psTypes: new Set(SOB_DEFAULT_PS_TYPES),
  customerFilter: '',
  /** null = all values; Set = only these categorical values */
  catFilters: {
    customer_name: null,
    status: null,
  },
  openFilterCol: '',
  filterSearch: '',
  selected: new Set(),
  sortCol: 'week',
  sortDir: 'asc',
  custSortCol: 'outstanding_balance_home',
  custSortDir: 'desc',
  _typesInitialized: false,
};

const SOB_CAT_FILTER_COLS = {
  customer_name: { label: 'Customer', valueFn: (row) => sobCustomerKey(row) },
  status: { label: 'Status', valueFn: (row) => String(row?.status || '').trim() || '(Blank)' },
};

const SOB_SORT_FALLBACK = {
  commitment_date: '9999-12-31',
  due_date: '9999-12-31',
  week: '9999-12-31',
};

function sobEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sobFormatMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function sobFormatQty(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return Number.isInteger(num)
    ? String(num)
    : num.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function sobFormatRate(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function sobFormatDate(value) {
  const text = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text || '-';
  const [y, m, d] = text.split('-');
  return `${d}/${m}/${y}`;
}

function sobRowId(row) {
  if (row?.row_id) return String(row.row_id);
  const ps = String(row?.pp_voucher_no || row?.process_sheet_no || '').trim();
  const partial = row?.pp_partial_no || 1;
  return `${ps}|${partial}`;
}

function sobPsTypeLabel(type) {
  return type === 'NOPP' ? 'No PP' : type;
}

function sobPsDisplay(row) {
  if (sobPsType(row) === 'NOPP') return 'No PP';
  const ps = String(row?.process_sheet_no || row?.pp_voucher_no || '').trim();
  const partial = Number(row?.pp_partial_no);
  if (ps && Number.isFinite(partial) && partial > 1) return `${ps}/${partial}`;
  return ps || '-';
}

function sobPsType(row) {
  const typed = String(row?.ps_type || '').trim().toUpperCase();
  if (typed) return typed === 'NONE' ? 'NOPP' : typed;
  const mode = String(row?.erp_stage_mode || '').trim().toLowerCase();
  if (mode === 'no_pp') return 'NOPP';
  const ps = String(row?.process_sheet_no || row?.pp_voucher_no || '').trim().toUpperCase();
  if (ps.startsWith('[SR]') || ps.startsWith('SR')) return 'SR';
  for (const prefix of SOB_PS_TYPES) {
    if (prefix !== 'NOPP' && ps.startsWith(prefix)) return prefix;
  }
  return '';
}

function sobCustomerKey(row) {
  return String(row?.customer_name || '').trim() || '(No customer)';
}

function sobSoLineKey(row) {
  const so = String(row?.sales_order_no || '').trim();
  const line = String(row?.source_line_item_no || row?.pp_voucher_no || '').trim();
  return `${so}|${line}`;
}

function sobSumUniqueSoValues(lines) {
  const seen = new Set();
  let total = 0;
  for (const row of lines) {
    const so = String(row?.sales_order_no || '').trim();
    const key = sobSoLineKey(row);
    if (!so || seen.has(key)) continue;
    seen.add(key);
    total += Number(row.line_value_home) || 0;
  }
  return total;
}

function sobSetAlert(message) {
  const el = document.getElementById('sob-alert');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function sobSetLoading(loading) {
  sobState.loading = loading;
  const el = document.getElementById('sob-loading');
  if (el) el.hidden = !loading;
  const refresh = document.getElementById('sob-refresh');
  if (refresh) refresh.disabled = loading;
}

function sobCompare(a, b, col, dir) {
  let av = a?.[col];
  let bv = b?.[col];
  if (col === 'week') {
    av = a?.commitment_date || SOB_SORT_FALLBACK.week;
    bv = b?.commitment_date || SOB_SORT_FALLBACK.week;
  }
  if (av == null || av === '') av = SOB_SORT_FALLBACK[col] ?? '';
  if (bv == null || bv === '') bv = SOB_SORT_FALLBACK[col] ?? '';
  const sign = dir === 'desc' ? -1 : 1;
  if (typeof av === 'number' || typeof bv === 'number') {
    const an = Number(av);
    const bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * sign;
  }
  return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * sign;
}

function sobCatValue(colId, row) {
  const conf = SOB_CAT_FILTER_COLS[colId];
  return conf ? conf.valueFn(row) : '';
}

function sobCatFilterActive(colId) {
  return sobState.catFilters[colId] instanceof Set;
}

function sobPassesCatFilters(row, skipCol = '') {
  for (const colId of Object.keys(SOB_CAT_FILTER_COLS)) {
    if (colId === skipCol) continue;
    const selected = sobState.catFilters[colId];
    if (!(selected instanceof Set)) continue;
    if (!selected.has(sobCatValue(colId, row))) return false;
  }
  return true;
}

function sobBaseFilteredLines(skipCatCol = '') {
  const lines = sobState.data?.lines || [];
  const q = sobState.search.trim().toLowerCase();
  const customer = sobState.customerFilter;
  return lines.filter((row) => {
    if (sobState.psTypes.size && !sobState.psTypes.has(sobPsType(row))) return false;
    if (!sobPassesCatFilters(row, skipCatCol)) return false;
    if (customer && sobCustomerKey(row) !== customer) return false;
    if (!q) return true;
    const hay = [
      row.sales_order_no,
      row.customer_name,
      row.process_sheet_no,
      row.pp_voucher_no,
      row.part_no,
      row.part_desc,
      row.status,
      row.week,
      row.ps_type,
    ].map((v) => String(v || '').toLowerCase()).join(' ');
    return hay.includes(q);
  });
}

function sobUniqueCatValues(colId) {
  const counts = new Map();
  for (const row of sobBaseFilteredLines(colId)) {
    const value = sobCatValue(colId, row);
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base', numeric: true }))
    .map(([value, count]) => ({ value, count }));
}

function sobVisibleLines() {
  const filtered = sobBaseFilteredLines();
  return [...filtered].sort((a, b) => sobCompare(a, b, sobState.sortCol, sobState.sortDir));
}

function sobCustomerRows() {
  const source = sobBaseFilteredLines('customer_name');

  const buckets = new Map();
  const seenSoLines = new Map();
  for (const row of source) {
    const name = sobCustomerKey(row);
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = {
        customer_name: name,
        line_count: 0,
        pp_qty: 0,
        remaining_qty: 0,
        line_value_home: 0,
        outstanding_balance_home: 0,
      };
      buckets.set(name, bucket);
      seenSoLines.set(name, new Set());
    }
    bucket.line_count += 1;
    bucket.pp_qty += Number(row.pp_qty) || 0;
    bucket.remaining_qty += Number(row.remaining_qty) || 0;
    const soKey = sobSoLineKey(row);
    const so = String(row?.sales_order_no || '').trim();
    const seen = seenSoLines.get(name);
    if (so && !seen.has(soKey)) {
      seen.add(soKey);
      bucket.line_value_home += Number(row.line_value_home) || 0;
    }
    bucket.outstanding_balance_home += Number(row.outstanding_balance_home) || 0;
  }

  return [...buckets.values()].sort((a, b) => (
    sobCompare(a, b, sobState.custSortCol, sobState.custSortDir)
  ));
}

function sobStatusKind(status) {
  const text = String(status || '').toLowerCase();
  if (!text || text === '(blank)' || text === '-') return 'blank';
  if (text.includes('no pp')) return 'nowo';
  if (text.includes('no wo')) return 'nowo';
  if (text.includes('all stages complete')) return 'done';
  if (text.includes('in process')) return 'process';
  if (text.includes('released')) return 'released';
  if (text.includes('pending')) return 'pending';
  return 'other';
}

function sobStatusBadge(status) {
  const label = String(status || '').trim() || '-';
  const kind = sobStatusKind(label);
  return `<span class="sob-status-badge sob-status-badge--${kind}" title="${sobEscape(label)}">${sobEscape(label)}</span>`;
}

function sobActiveFilterChips() {
  const chips = [];
  if (sobState.psTypes.size && sobState.psTypes.size < SOB_PS_TYPES.length) {
    chips.push({
      id: 'ps',
      label: `PS: ${[...sobState.psTypes].map(sobPsTypeLabel).join(', ')}`,
      clear: 'ps',
    });
  }
  if (sobState.customerFilter) {
    chips.push({
      id: 'focus',
      label: `Focus: ${sobState.customerFilter}`,
      clear: 'focus',
    });
  }
  for (const [colId, conf] of Object.entries(SOB_CAT_FILTER_COLS)) {
    const selected = sobState.catFilters[colId];
    if (!(selected instanceof Set)) continue;
    const n = selected.size;
    const preview = [...selected].slice(0, 2).join(', ');
    const more = n > 2 ? ` +${n - 2}` : '';
    chips.push({
      id: colId,
      label: `${conf.label}: ${preview}${more || (n ? '' : 'none')}`,
      clear: colId,
      count: n,
    });
  }
  if (sobState.search.trim()) {
    chips.push({
      id: 'search',
      label: `Search: ${sobState.search.trim()}`,
      clear: 'search',
    });
  }
  return chips;
}

function sobHasActiveFilters() {
  return sobActiveFilterChips().length > 0;
}

function sobClearFilter(kind) {
  if (kind === 'ps') sobState.psTypes = new Set(SOB_DEFAULT_PS_TYPES);
  else if (kind === 'focus') sobState.customerFilter = '';
  else if (kind === 'search') {
    sobState.search = '';
    const input = document.getElementById('sob-search');
    if (input) input.value = '';
  } else if (SOB_CAT_FILTER_COLS[kind]) {
    sobState.catFilters[kind] = null;
  }
  sobRender();
}

function sobClearAllFilters() {
  sobState.psTypes = new Set(SOB_DEFAULT_PS_TYPES);
  sobState.customerFilter = '';
  sobState.catFilters = { customer_name: null, status: null };
  sobState.search = '';
  const input = document.getElementById('sob-search');
  if (input) input.value = '';
  sobCloseCatFilter();
  sobRender();
}

function sobRenderFilterChips() {
  const el = document.getElementById('sob-filter-chips');
  const clearBtn = document.getElementById('sob-clear-filters');
  if (!el) return;
  const chips = sobActiveFilterChips();
  if (clearBtn) clearBtn.hidden = !chips.length;
  if (!chips.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = chips.map((chip) => `
    <button type="button" class="sob-filter-chip" data-clear-filter="${sobEscape(chip.clear)}" title="Remove filter">
      <span>${sobEscape(chip.label)}</span>
      <span class="sob-filter-chip-x" aria-hidden="true">x</span>
    </button>
  `).join('');
}

function sobSyncExportButtons() {
  const btn = document.getElementById('sob-export-selected');
  const meta = document.getElementById('sob-selection-meta');
  const count = sobState.selected.size;
  if (btn) btn.disabled = count === 0;
  if (meta) {
    if (!count) {
      meta.hidden = true;
      meta.textContent = '';
    } else {
      meta.hidden = false;
      meta.textContent = `${count} selected`;
    }
  }
}

function sobCloseCatFilter() {
  const pop = document.getElementById('sob-col-filter-popover');
  if (pop) {
    pop.hidden = true;
    pop.innerHTML = '';
  }
  sobState.openFilterCol = '';
  sobState.filterSearch = '';
}

function sobRepositionCatFilter() {
  const pop = document.getElementById('sob-col-filter-popover');
  if (!pop || pop.hidden || !sobState.openFilterCol) return;
  const btn = document.querySelector(`[data-sob-filter="${CSS.escape(sobState.openFilterCol)}"]`);
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const width = pop.offsetWidth || 240;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${rect.bottom + 4}px`;
}

function sobRenderCatFilterPopover() {
  const pop = document.getElementById('sob-col-filter-popover');
  const colId = sobState.openFilterCol;
  const conf = SOB_CAT_FILTER_COLS[colId];
  if (!pop || !conf) return;

  const values = sobUniqueCatValues(colId);
  const active = sobState.catFilters[colId];
  const q = sobState.filterSearch.trim().toLowerCase();
  const visible = q
    ? values.filter((row) => row.value.toLowerCase().includes(q))
    : values;
  const selectedCount = active instanceof Set
    ? values.filter((row) => active.has(row.value)).length
    : values.length;

  const checks = visible.map((row) => {
    const checked = !(active instanceof Set) || active.has(row.value) ? ' checked' : '';
    return `
      <label class="sob-col-filter-check" title="${sobEscape(row.value)}">
        <input type="checkbox" data-sob-cat-value="${sobEscape(row.value)}"${checked}>
        <span class="sob-col-filter-check-label">${sobEscape(row.value)}</span>
        <span class="sob-col-filter-count">${row.count}</span>
      </label>
    `;
  }).join('') || '<div class="sob-col-filter-empty">No values</div>';

  pop.hidden = false;
  pop.innerHTML = `
    <div class="sob-col-filter-title">Filter: ${sobEscape(conf.label)}</div>
    <input type="search" class="sob-col-filter-search" id="sob-col-filter-search" placeholder="Search values..." value="${sobEscape(sobState.filterSearch)}" autocomplete="off">
    <div class="sob-col-filter-toolbar">
      <button type="button" class="btn btn-ghost btn-sm" data-sob-cat-action="all">Select all</button>
      <button type="button" class="btn btn-ghost btn-sm" data-sob-cat-action="none">Clear</button>
    </div>
    <div class="sob-col-filter-checks">${checks}</div>
    <div class="sob-col-filter-actions">
      <span class="sob-col-filter-meta">${selectedCount} of ${values.length}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-sob-cat-action="reset">Reset filter</button>
    </div>
  `;
  sobRepositionCatFilter();
  document.getElementById('sob-col-filter-search')?.focus();
}

function sobOpenCatFilter(colId, btn) {
  if (!SOB_CAT_FILTER_COLS[colId]) return;
  if (sobState.openFilterCol === colId) {
    sobCloseCatFilter();
    return;
  }
  sobState.openFilterCol = colId;
  sobState.filterSearch = '';
  sobRenderCatFilterPopover();
}

function sobApplyCatSelection(colId, nextSet, allValues) {
  if (!(nextSet instanceof Set) || nextSet.size >= allValues.length) {
    sobState.catFilters[colId] = null;
  } else {
    sobState.catFilters[colId] = nextSet;
  }
  sobRender();
  if (sobState.openFilterCol === colId) sobRenderCatFilterPopover();
}

function sobRenderTypeChips() {
  const el = document.getElementById('sob-type-chips');
  if (!el) return;
  el.innerHTML = SOB_PS_TYPES.map((type) => {
    const active = sobState.psTypes.has(type) ? ' is-active' : '';
    return `<button type="button" class="sob-type-chip${active}" data-ps-type="${type}">${sobPsTypeLabel(type)}</button>`;
  }).join('');
}

function sobSyncFilterButtons() {
  document.querySelectorAll('[data-sob-filter]').forEach((btn) => {
    const colId = btn.dataset.sobFilter;
    const active = sobCatFilterActive(colId);
    const selected = sobState.catFilters[colId];
    const badge = btn.querySelector('.sob-filter-badge');
    btn.classList.toggle('is-active', active);
    const th = btn.closest('th');
    if (th) th.classList.toggle('is-filtered', active);
    if (badge) {
      if (active && selected instanceof Set) {
        badge.hidden = false;
        badge.textContent = String(selected.size);
      } else {
        badge.hidden = true;
        badge.textContent = '';
      }
    }
  });
}

function sobRenderMeta() {
  const el = document.getElementById('sob-meta');
  const sub = document.getElementById('sob-lines-sub');
  if (!el) return;
  const data = sobState.data;
  if (!data) {
    el.textContent = '';
    return;
  }
  const visible = sobVisibleLines().length;
  const total = (data.lines || []).length;
  el.innerHTML = `<strong>${visible}</strong> shown <span class="sob-meta-sep">/</span> ${total} total`;
  if (sub) {
    sub.textContent = sobHasActiveFilters()
      ? 'Filters apply to this table and KPIs. Export all includes every currently open S/O line.'
      : 'Select rows to export a subset. Export all includes every currently open line.';
  }
}

function sobRenderKpis() {
  const el = document.getElementById('sob-kpi');
  if (!el || !sobState.data) {
    if (el) el.hidden = true;
    return;
  }
  const lines = sobVisibleLines();
  const lineCount = lines.length;
  const remainingQty = lines.reduce((sum, row) => sum + (Number(row.remaining_qty) || 0), 0);
  const ppQty = lines.reduce((sum, row) => sum + (Number(row.pp_qty) || 0), 0);
  const lineValue = sobSumUniqueSoValues(lines);
  const outstanding = lines.reduce((sum, row) => sum + (Number(row.outstanding_balance_home) || 0), 0);
  const customers = new Set(lines.map(sobCustomerKey)).size;
  const filtered = sobHasActiveFilters();

  el.hidden = false;
  el.innerHTML = `
    <div class="sob-kpi sob-kpi--balance">
      <span class="sob-kpi-label">Outstanding</span>
      <div class="sob-kpi-value">$${sobEscape(sobFormatMoney(outstanding))}</div>
      <div class="sob-kpi-sub">${filtered ? 'Filtered view' : 'Open qty x rate'}</div>
    </div>
    <div class="sob-kpi sob-kpi--line">
      <span class="sob-kpi-label">SO value</span>
      <div class="sob-kpi-value">$${sobEscape(sobFormatMoney(lineValue))}</div>
      <div class="sob-kpi-sub">Unit x SO qty x exch</div>
    </div>
    <div class="sob-kpi sob-kpi--qty">
      <span class="sob-kpi-label">PP qty</span>
      <div class="sob-kpi-value">${sobEscape(sobFormatQty(ppQty))}</div>
      <div class="sob-kpi-sub">${sobEscape(sobFormatQty(remainingQty))} still open</div>
    </div>
    <div class="sob-kpi">
      <span class="sob-kpi-label">Lines / customers</span>
      <div class="sob-kpi-value">${sobEscape(String(lineCount))} / ${sobEscape(String(customers))}</div>
      <div class="sob-kpi-sub">Not fully shipped</div>
    </div>
  `;
}

function sobSyncSortHeaders(selector, activeCol, activeDir) {
  document.querySelectorAll(selector).forEach((th) => {
    const col = th.dataset.sort || th.dataset.custSort;
    const active = col === activeCol;
    th.classList.toggle('is-sorted', active);
    if (active) th.dataset.dir = activeDir === 'asc' ? '^' : 'v';
    else delete th.dataset.dir;
  });
}

function sobRenderCustomerTable() {
  const panel = document.getElementById('sob-customer-panel');
  const body = document.getElementById('sob-customer-body');
  const empty = document.getElementById('sob-customer-empty');
  const clearBtn = document.getElementById('sob-clear-customer');
  if (!panel || !body || !sobState.data) return;

  panel.hidden = false;
  if (clearBtn) clearBtn.hidden = !sobState.customerFilter;
  sobSyncSortHeaders('.sob-table--customer th[data-cust-sort]', sobState.custSortCol, sobState.custSortDir);

  const rows = sobCustomerRows();
  if (!rows.length) {
    body.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  body.innerHTML = rows.map((row) => {
    const active = sobState.customerFilter === row.customer_name ? ' is-active' : '';
    return `
      <tr class="${active}" data-customer="${sobEscape(row.customer_name)}">
        <td class="sob-customer-cell" title="${sobEscape(row.customer_name)}">${sobEscape(row.customer_name)}</td>
        <td class="sob-num">${sobEscape(String(row.line_count))}</td>
        <td class="sob-num">${sobEscape(sobFormatQty(row.pp_qty))}</td>
        <td class="sob-num">${sobEscape(sobFormatQty(row.remaining_qty))}</td>
        <td class="sob-num">${sobEscape(sobFormatMoney(row.line_value_home))}</td>
        <td class="sob-num sob-money-strong">${sobEscape(sobFormatMoney(row.outstanding_balance_home))}</td>
      </tr>
    `;
  }).join('');
}

function sobRenderTable() {
  const panel = document.getElementById('sob-table-panel');
  const body = document.getElementById('sob-body');
  const empty = document.getElementById('sob-empty');
  const selectAll = document.getElementById('sob-select-all');
  if (!panel || !body || !sobState.data) return;

  panel.hidden = false;
  const lines = sobVisibleLines();
  sobSyncSortHeaders('.sob-table--lines th[data-sort]', sobState.sortCol, sobState.sortDir);

  const visibleIds = lines.map(sobRowId);
  const selectedVisible = visibleIds.filter((id) => sobState.selected.has(id));
  if (selectAll) {
    selectAll.checked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
    selectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.length;
  }

  if (!lines.length) {
    body.innerHTML = '';
    if (empty) empty.hidden = false;
    sobSyncExportButtons();
    return;
  }
  if (empty) empty.hidden = true;

  body.innerHTML = lines.map((row) => {
    const id = sobRowId(row);
    const checked = sobState.selected.has(id) ? ' checked' : '';
    const selectedCls = sobState.selected.has(id) ? ' is-selected' : '';
    const partTitle = sobEscape(row.part_no || '');
    const descTitle = sobEscape(row.part_desc || '');
    return `
      <tr class="${selectedCls}" data-row-id="${sobEscape(id)}">
        <td class="sob-check-col">
          <input type="checkbox" class="sob-row-check" data-row-id="${sobEscape(id)}" aria-label="Select line"${checked}>
        </td>
        <td class="sob-mono">${sobEscape(row.sales_order_no || '-')}</td>
        <td class="sob-customer-cell" title="${sobEscape(row.customer_name || '')}">${sobEscape(row.customer_name || '-')}</td>
        <td class="sob-mono">${sobEscape(sobPsDisplay(row))}</td>
        <td class="sob-part-cell" title="${partTitle}">${sobEscape(row.part_no || '-')}</td>
        <td class="sob-desc-cell" title="${descTitle}">${sobEscape(row.part_desc || '-')}</td>
        <td class="sob-num">${sobEscape(sobFormatMoney(row.unit_selling_price))}</td>
        <td class="sob-num">${sobEscape(sobFormatRate(row.exch_rate))}</td>
        <td class="sob-num">${sobEscape(sobFormatQty(row.pp_qty))}</td>
        <td class="sob-num">${sobEscape(sobFormatQty(row.so_qty))}</td>
        <td class="sob-num">${sobEscape(sobFormatQty(row.remaining_qty))}</td>
        <td class="sob-num">${sobEscape(sobFormatMoney(row.line_value_home))}</td>
        <td class="sob-num sob-money-strong">${sobEscape(sobFormatMoney(row.outstanding_balance_home))}</td>
        <td class="sob-status-cell">${sobStatusBadge(row.status)}</td>
        <td class="sob-date-cell">${sobEscape(sobFormatDate(row.due_date))}</td>
        <td class="sob-date-cell">${sobEscape(sobFormatDate(row.coway_edd))}</td>
        <td class="sob-week-cell">${sobEscape(row.week || '-')}</td>
      </tr>
    `;
  }).join('');
  sobSyncExportButtons();
}

function sobRender() {
  sobRenderTypeChips();
  sobRenderFilterChips();
  sobRenderMeta();
  sobRenderKpis();
  sobRenderCustomerTable();
  sobRenderTable();
  sobSyncFilterButtons();
  if (sobState.openFilterCol) sobRepositionCatFilter();
}

function sobCsvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function sobAllActiveLines() {
  const lines = (sobState.data?.lines || []).filter(
    (row) => (Number(row.remaining_qty) || 0) > SOB_OPEN_QTY_TOLERANCE,
  );
  return [...lines].sort((a, b) => sobCompare(a, b, sobState.sortCol, sobState.sortDir));
}

function sobExportLines(lines, filenameSuffix) {
  const headers = [
    'sales_order_no',
    'customer_name',
    'process_sheet_no',
    'pp_partial_no',
    'ps_type',
    'part_no',
    'part_desc',
    'unit_selling_price',
    'exch_rate',
    'pp_qty',
    'so_qty',
    'qty_shipped',
    'remaining_qty',
    'line_value_home',
    'outstanding_balance_home',
    'status',
    'due_date',
    'coway_edd',
    'week',
    'commitment_date',
  ];
  const rows = [headers.join(',')];
  for (const line of lines) {
    rows.push(headers.map((key) => sobCsvEscape(line[key] ?? '')).join(','));
  }
  const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `so-outstanding-balance-${filenameSuffix}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function sobLoad(refresh = false) {
  sobSetAlert('');
  sobSetLoading(true);
  try {
    const qs = refresh ? '?refresh=1' : '';
    const fetcher = window.reportsApiFetch || fetch;
    const res = await fetcher(`/api/so-outstanding-balance${qs}`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    sobState.data = data;
    sobState.selected = new Set();
    sobState.catFilters = { customer_name: null, status: null };
    sobCloseCatFilter();
    const defaults = Array.isArray(data.default_ps_types) && data.default_ps_types.length
      ? data.default_ps_types
      : SOB_DEFAULT_PS_TYPES;
    if (!sobState._typesInitialized) {
      sobState.psTypes = new Set(defaults);
      sobState._typesInitialized = true;
    }
    sobRender();
  } catch (err) {
    sobState.data = null;
    sobSetAlert(err.message || 'Failed to load outstanding balance');
    const panel = document.getElementById('sob-table-panel');
    const customers = document.getElementById('sob-customer-panel');
    const kpi = document.getElementById('sob-kpi');
    if (panel) panel.hidden = true;
    if (customers) customers.hidden = true;
    if (kpi) kpi.hidden = true;
  } finally {
    sobSetLoading(false);
  }
}

function sobBind() {
  document.getElementById('sob-refresh')?.addEventListener('click', () => sobLoad(true));
  document.getElementById('sob-export')?.addEventListener('click', () => {
    sobExportLines(sobAllActiveLines(), 'all');
  });
  document.getElementById('sob-export-selected')?.addEventListener('click', () => {
    const selected = sobVisibleLines().filter((row) => sobState.selected.has(sobRowId(row)));
    if (!selected.length) return;
    sobExportLines(selected, 'selected');
  });
  document.getElementById('sob-search')?.addEventListener('input', (ev) => {
    sobState.search = ev.target.value || '';
    sobRender();
  });
  document.getElementById('sob-clear-customer')?.addEventListener('click', () => {
    sobState.customerFilter = '';
    sobRender();
  });
  document.getElementById('sob-clear-filters')?.addEventListener('click', () => sobClearAllFilters());
  document.getElementById('sob-filter-chips')?.addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-clear-filter]');
    if (!chip) return;
    sobClearFilter(chip.dataset.clearFilter);
  });
  document.getElementById('sob-type-chips')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-ps-type]');
    if (!btn) return;
    const type = btn.dataset.psType;
    if (!type) return;
    if (sobState.psTypes.has(type)) sobState.psTypes.delete(type);
    else sobState.psTypes.add(type);
    sobRender();
  });
  document.getElementById('sob-customer-body')?.addEventListener('click', (ev) => {
    const row = ev.target.closest('tr[data-customer]');
    if (!row) return;
    const name = row.dataset.customer || '';
    sobState.customerFilter = sobState.customerFilter === name ? '' : name;
    sobRender();
  });
  document.getElementById('sob-select-all')?.addEventListener('change', (ev) => {
    const checked = Boolean(ev.target.checked);
    const lines = sobVisibleLines();
    for (const row of lines) {
      const id = sobRowId(row);
      if (checked) sobState.selected.add(id);
      else sobState.selected.delete(id);
    }
    sobRenderTable();
  });
  document.getElementById('sob-body')?.addEventListener('change', (ev) => {
    const input = ev.target.closest('.sob-row-check');
    if (!input) return;
    const id = input.dataset.rowId;
    if (!id) return;
    if (input.checked) sobState.selected.add(id);
    else sobState.selected.delete(id);
    sobRenderTable();
  });
  document.querySelectorAll('.sob-table--lines th[data-sort]').forEach((th) => {
    th.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-sob-filter]')) return;
      const col = th.dataset.sort;
      if (!col) return;
      if (sobState.sortCol === col) {
        sobState.sortDir = sobState.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sobState.sortCol = col;
        sobState.sortDir = 'asc';
      }
      sobRender();
    });
  });
  document.querySelectorAll('[data-sob-filter]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      sobOpenCatFilter(btn.dataset.sobFilter, btn);
    });
  });
  document.getElementById('sob-col-filter-popover')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const colId = sobState.openFilterCol;
    if (!colId) return;

    const actionBtn = ev.target.closest('[data-sob-cat-action]');
    if (!actionBtn) return;
    const action = actionBtn.dataset.sobCatAction;
    const allValues = sobUniqueCatValues(colId).map((row) => row.value);
    if (action === 'all') {
      sobApplyCatSelection(colId, new Set(allValues), allValues);
    } else if (action === 'none') {
      sobApplyCatSelection(colId, new Set(), allValues);
    } else if (action === 'reset') {
      sobState.catFilters[colId] = null;
      sobRender();
      sobRenderCatFilterPopover();
    }
  });
  document.getElementById('sob-col-filter-popover')?.addEventListener('change', (ev) => {
    const check = ev.target.closest('input[data-sob-cat-value]');
    const colId = sobState.openFilterCol;
    if (!check || !colId) return;
    const allValues = sobUniqueCatValues(colId).map((row) => row.value);
    const current = sobState.catFilters[colId] instanceof Set
      ? new Set(sobState.catFilters[colId])
      : new Set(allValues);
    const value = check.dataset.sobCatValue;
    if (check.checked) current.add(value);
    else current.delete(value);
    sobApplyCatSelection(colId, current, allValues);
  });
  document.getElementById('sob-col-filter-popover')?.addEventListener('input', (ev) => {
    if (!ev.target.matches('#sob-col-filter-search')) return;
    sobState.filterSearch = ev.target.value || '';
    sobRenderCatFilterPopover();
  });
  document.addEventListener('click', (ev) => {
    if (!sobState.openFilterCol) return;
    if (ev.target.closest('#sob-col-filter-popover') || ev.target.closest('[data-sob-filter]')) return;
    sobCloseCatFilter();
  });
  window.addEventListener('resize', () => sobRepositionCatFilter());
  document.querySelector('.sob-table-wrap')?.addEventListener('scroll', () => sobRepositionCatFilter(), { passive: true });
  document.querySelectorAll('.sob-table--customer th[data-cust-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.custSort;
      if (!col) return;
      if (sobState.custSortCol === col) {
        sobState.custSortDir = sobState.custSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sobState.custSortCol = col;
        sobState.custSortDir = col === 'customer_name' ? 'asc' : 'desc';
      }
      sobRender();
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  sobBind();
  sobLoad(false);
});
