/* Sales Coordination - APS/NPS segments, compressed commitment sheet */

const SC_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
const SC_LEAD_TYPES = ['APS', 'NPS'];
const SC_DEFAULT_PS_TYPES = ['APS', 'NPS'];
const SC_TYPE_ORDER = ['APS', 'NPS', 'MPS', 'PPS', 'CPS', 'SR'];
const SC_LAYOUT_KEY = 'sales-coordination-layout-v1';
const SC_BLANK = '(Blank)';

const SC_COLUMNS = [
  { id: 'process_sheet_no', label: 'PS no', width: 118, min: 88, max: 280, title: 'Process sheet number' },
  { id: 'customer', label: 'Customer', width: 220, min: 160, max: 480, title: 'Customer code and customer name' },
  { id: 'po_date', label: 'PO date', width: 108, min: 96, max: 180, kind: 'date', title: 'Customer PO date' },
  { id: 'customer_po_no', label: 'PO number', width: 136, min: 100, max: 280, title: 'Customer PO number' },
  { id: 'line_item_no', label: 'Line item', width: 78, min: 68, max: 160, kind: 'num', title: 'Line item' },
  { id: 'part_no', label: 'Inventory code', width: 150, min: 110, max: 320, title: 'Inventory code' },
  { id: 'part_desc', label: 'Inventory description', width: 220, min: 140, max: 560, title: 'Inventory description' },
  { id: 'due_date', label: 'PO due date', width: 112, min: 100, max: 180, kind: 'date', title: 'PO due date' },
  { id: 'order_qty', label: 'Order qty', width: 84, min: 72, max: 160, kind: 'num', title: 'Order quantity' },
  { id: 'customer_remarks', label: 'Customer remarks', width: 360, min: 300, max: 960, remark: true, title: 'Customer remarks. Drag the right edge to make this wider.' },
  { id: 'coway_remarks', label: 'Coway remarks', width: 360, min: 300, max: 960, remark: true, title: 'Coway remarks. Drag the right edge to make this wider.' },
  { id: 'committed_schedule', label: 'Committed schedule', width: 156, min: 140, max: 260, kind: 'date', title: 'Committed schedule. Drag cells, then paste dates as dd/mm/yyyy.' },
];

const scState = {
  lines: [],
  loading: false,
  search: '',
  psTypes: new Set(SC_DEFAULT_PS_TYPES),
  sorts: [{ key: 'due_date', dir: 'asc' }],
  colFilters: {},
  hidden: new Set(),
  widths: {},
  filterKey: '',
  filterQuery: '',
  selected: new Set(),
};

const scGrid = {
  anchor: null,
  focus: null,
  pending: null,
  dragging: false,
};

const SC_SORT_FALLBACK = {
  due_date: '9999-12-31',
  po_date: '9999-12-31',
  committed_schedule: '9999-12-31',
  order_qty: Number.POSITIVE_INFINITY,
  line_item_no: Number.POSITIVE_INFINITY,
};

const SC_EXPORT_COLUMNS = [
  { id: 'process_sheet_no', label: 'PS no', width: 16 },
  { id: 'customer', label: 'Customer', width: 32 },
  { id: 'po_date', label: 'PO date', width: 14 },
  { id: 'customer_po_no', label: 'PO number', width: 18 },
  { id: 'line_item_no', label: 'Line item', width: 12 },
  { id: 'part_no', label: 'Inventory code', width: 20 },
  { id: 'part_desc', label: 'Inventory description', width: 36 },
  { id: 'due_date', label: 'PO due date', width: 14 },
  { id: 'order_qty', label: 'Order qty', width: 12 },
  { id: 'customer_remarks', label: 'Customer remarks', width: 42 },
  { id: 'coway_remarks', label: 'Coway remarks', width: 42 },
  { id: 'committed_schedule', label: 'Committed schedule', width: 18 },
];

function scEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scFormatDate(value) {
  const text = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text || '';
  const [y, m, d] = text.split('-');
  return `${d}/${m}/${y}`;
}

function scValidIso(iso) {
  const match = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() + 1 !== month || dt.getUTCDate() !== day) return '';
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function scParseDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const isoHead = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoHead) return scValidIso(isoHead[1]);
  const dmy = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (!dmy) return '';
  let year = Number(dmy[3]);
  if (year < 100) year += 2000;
  const month = String(Number(dmy[2])).padStart(2, '0');
  const day = String(Number(dmy[1])).padStart(2, '0');
  return scValidIso(`${String(year).padStart(4, '0')}-${month}-${day}`);
}

function scIsBlankToken(text) {
  const value = String(text ?? '').trim();
  return !value || /^[-–—−]+$/.test(value) || /^(none|n\/a|na|blank)$/i.test(value);
}

function scFormatQty(value) {
  if (value == null || value === '') return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return Number.isInteger(num)
    ? String(num)
    : num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function scPsDisplay(row) {
  const ps = String(row?.process_sheet_no || row?.pp_voucher_no || '').trim();
  const partial = Number(row?.pp_partial_no);
  if (ps && Number.isFinite(partial) && partial > 1) return `${ps}/${partial}`;
  return ps || '-';
}

function scPsType(row) {
  const typed = String(row?.ps_type || '').trim().toUpperCase();
  if (typed) return typed;
  const ps = String(row?.process_sheet_no || row?.pp_voucher_no || '').trim().toUpperCase();
  if (ps.startsWith('[SR]') || ps.startsWith('SR')) return 'SR';
  for (const prefix of SC_PS_TYPES) {
    if (ps.startsWith(prefix)) return prefix;
  }
  return '';
}

function scCustomerParts(row) {
  const code = String(row?.customer_code || '').trim();
  const name = String(row?.customer_name || '').trim();
  return { code, name };
}

function scCustomerLabel(row) {
  const { code, name } = scCustomerParts(row);
  if (code && name && code.toLowerCase() !== name.toLowerCase()) return `${code} — ${name}`;
  return code || name || '';
}

function scColumnById(id) {
  return SC_COLUMNS.find((col) => col.id === id) || null;
}

function scVisibleColumns() {
  return SC_COLUMNS.filter((col) => !scState.hidden.has(col.id));
}

function scColWidth(col) {
  const saved = Number(scState.widths[col.id]);
  const width = Number.isFinite(saved) && saved > 0 ? saved : col.width;
  return Math.round(Math.min(col.max, Math.max(col.min, width)));
}

function scEnsureSorts() {
  const visible = new Set(scVisibleColumns().map((col) => col.id));
  scState.sorts = (scState.sorts || []).filter((sort) => (
    sort && visible.has(sort.key) && (sort.dir === 'asc' || sort.dir === 'desc')
  ));
  if (!scState.sorts.length) {
    const fallback = visible.has('due_date') ? 'due_date' : scVisibleColumns()[0]?.id;
    if (fallback) scState.sorts = [{ key: fallback, dir: 'asc' }];
  }
}

function scLoadLayout() {
  try {
    const raw = JSON.parse(localStorage.getItem(SC_LAYOUT_KEY) || '{}');
    const known = new Set(SC_COLUMNS.map((col) => col.id));
    if (Array.isArray(raw.hidden)) {
      raw.hidden.forEach((id) => {
        if (known.has(id)) scState.hidden.add(id);
      });
    }
    if (scState.hidden.size >= SC_COLUMNS.length) scState.hidden.clear();
    if (raw.widths && typeof raw.widths === 'object') {
      Object.entries(raw.widths).forEach(([id, width]) => {
        const col = scColumnById(id);
        const num = Number(width);
        if (!col || !Number.isFinite(num)) return;
        scState.widths[id] = Math.round(Math.min(col.max, Math.max(col.min, num)));
      });
    }
    if (Array.isArray(raw.sorts)) {
      const sorts = raw.sorts
        .filter((sort) => sort && known.has(sort.key) && (sort.dir === 'asc' || sort.dir === 'desc'))
        .map((sort) => ({ key: sort.key, dir: sort.dir }));
      if (sorts.length) scState.sorts = sorts;
    }
  } catch (err) {
    scState.hidden.clear();
    scState.widths = {};
    scState.sorts = [{ key: 'due_date', dir: 'asc' }];
  }
  scEnsureSorts();
}

function scSaveLayout() {
  try {
    localStorage.setItem(SC_LAYOUT_KEY, JSON.stringify({
      hidden: [...scState.hidden],
      widths: scState.widths,
      sorts: scState.sorts,
    }));
  } catch (err) {
    /* Private mode can block storage. The sheet still works for this visit. */
  }
}

function scEls() {
  return {
    search: document.getElementById('sc-search'),
    typeChips: document.getElementById('sc-type-chips'),
    meta: document.getElementById('sc-meta'),
    selectionMeta: document.getElementById('sc-selection-meta'),
    clearFilters: document.getElementById('sc-clear-filters'),
    loading: document.getElementById('sc-loading'),
    alert: document.getElementById('sc-alert'),
    panel: document.getElementById('sc-table-panel'),
    body: document.getElementById('sc-body'),
    empty: document.getElementById('sc-empty'),
    refresh: document.getElementById('sc-refresh'),
    exportBtn: document.getElementById('sc-export'),
    selectAll: document.getElementById('sc-select-all'),
    table: document.getElementById('sc-table'),
  };
}

function scRowId(row) {
  return String(row?.row_id || `${row?.pp_voucher_no || ''}|${row?.pp_partial_no || 1}`);
}

function scSetLoading(on) {
  const { loading, panel } = scEls();
  scState.loading = on;
  if (loading) loading.hidden = !on;
  if (panel && on) panel.hidden = true;
}

function scShowAlert(message) {
  const { alert } = scEls();
  if (!alert) return;
  if (!message) {
    alert.hidden = true;
    alert.textContent = '';
    return;
  }
  alert.hidden = false;
  alert.textContent = message;
}

function scTypeCounts() {
  const counts = {};
  (scState.lines || []).forEach((row) => {
    const type = scPsType(row) || 'Other';
    counts[type] = (counts[type] || 0) + 1;
  });
  return counts;
}

function scRenderTypeChips() {
  const { typeChips } = scEls();
  if (!typeChips) return;
  const counts = scTypeCounts();
  const button = (type, lead) => {
    const active = scState.psTypes.has(type);
    const count = counts[type] || 0;
    return `<button type="button" class="sc-type-chip${lead ? ' sc-type-chip--lead' : ''}${active ? ' is-active' : ''}" data-sc-type="${scEscape(type)}" aria-pressed="${active ? 'true' : 'false'}">${scEscape(type)} <span class="sc-type-count">${count.toLocaleString()}</span></button>`;
  };
  const leads = SC_LEAD_TYPES.map((type) => button(type, true)).join('');
  const rest = SC_PS_TYPES.filter((type) => !SC_LEAD_TYPES.includes(type)).map((type) => button(type, false)).join('');
  typeChips.innerHTML = `${leads}<span class="sc-type-divider" aria-hidden="true"></span>${rest}`;
}

function scHasColumnFilters() {
  return Object.entries(scState.colFilters).some(([colId, selected]) => (
    selected instanceof Set && !scState.hidden.has(colId)
  ));
}

function scHasActiveFilters() {
  if (scState.search.trim()) return true;
  if (scHasColumnFilters()) return true;
  if (scState.psTypes.size !== SC_DEFAULT_PS_TYPES.length) return true;
  for (const type of SC_DEFAULT_PS_TYPES) {
    if (!scState.psTypes.has(type)) return true;
  }
  return false;
}

function scUpdateClearButton() {
  const { clearFilters } = scEls();
  if (clearFilters) clearFilters.hidden = !scHasActiveFilters();
}

function scMatchesSearch(row, needle) {
  if (!needle) return true;
  const hay = [
    row.process_sheet_no,
    row.pp_voucher_no,
    row.sales_order_no,
    row.part_no,
    row.part_desc,
    row.customer_po_no,
    row.line_item_no,
    row.customer_code,
    row.customer_name,
    scCustomerLabel(row),
    row.due_date,
    row.po_date,
    row.customer_remarks,
    row.coway_remarks,
    row.committed_schedule,
  ]
    .map((v) => String(v || '').toLowerCase())
    .join(' ');
  return hay.includes(needle);
}

function scFilterText(row, colId) {
  if (colId === 'process_sheet_no') {
    const text = scPsDisplay(row);
    return text === '-' ? '' : text;
  }
  if (colId === 'customer') return scCustomerLabel(row);
  if (colId === 'po_date' || colId === 'due_date' || colId === 'committed_schedule') {
    return scFormatDate(row?.[colId]) || '';
  }
  if (colId === 'order_qty') {
    const text = scFormatQty(row?.order_qty);
    return text === '-' ? '' : text;
  }
  if (colId === 'line_item_no') return String(row?.line_item_no || '').trim();
  if (colId === 'part_no') return String(row?.part_no || '').trim();
  return String(row?.[colId] || '').trim();
}

function scFilterKey(row, colId) {
  return scFilterText(row, colId) || SC_BLANK;
}

function scPassesColumnFilters(row) {
  return Object.entries(scState.colFilters).every(([colId, selected]) => {
    if (!(selected instanceof Set) || scState.hidden.has(colId)) return true;
    return selected.has(scFilterKey(row, colId));
  });
}

function scFilteredLines() {
  const needle = scState.search.trim().toLowerCase();
  return (scState.lines || []).filter((row) => {
    const type = scPsType(row);
    if (scState.psTypes.size && !scState.psTypes.has(type)) return false;
    if (!scMatchesSearch(row, needle)) return false;
    return scPassesColumnFilters(row);
  });
}

function scRowsForFilterOptions(colId) {
  const needle = scState.search.trim().toLowerCase();
  return (scState.lines || []).filter((row) => {
    const type = scPsType(row);
    if (scState.psTypes.size && !scState.psTypes.has(type)) return false;
    if (!scMatchesSearch(row, needle)) return false;
    return Object.entries(scState.colFilters).every(([otherId, selected]) => {
      if (otherId === colId || !(selected instanceof Set) || scState.hidden.has(otherId)) return true;
      return selected.has(scFilterKey(row, otherId));
    });
  });
}

function scSortValue(row, col) {
  if (col === 'process_sheet_no') return scPsDisplay(row).toLowerCase();
  if (col === 'customer') return scCustomerLabel(row).toLowerCase();
  if (col === 'order_qty' || col === 'line_item_no') {
    const num = Number(row?.[col]);
    if (col === 'line_item_no' && String(row?.[col] ?? '').trim() === '') return SC_SORT_FALLBACK.line_item_no;
    return Number.isFinite(num) ? num : SC_SORT_FALLBACK[col];
  }
  const raw = row?.[col];
  if (raw == null || raw === '') return SC_SORT_FALLBACK[col] ?? '';
  if (typeof raw === 'number') return raw;
  return String(raw).toLowerCase();
}

function scIsEmptySort(col, value) {
  if (value == null || value === '') return true;
  return SC_SORT_FALLBACK[col] !== undefined && value === SC_SORT_FALLBACK[col];
}

function scTypeRank(type) {
  const idx = SC_TYPE_ORDER.indexOf(String(type || '').toUpperCase());
  return idx >= 0 ? idx : SC_TYPE_ORDER.length;
}

function scCompareSortValues(av, bv) {
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
}

function scSortedLines(lines) {
  const sorts = scState.sorts.length ? scState.sorts : [{ key: 'due_date', dir: 'asc' }];
  return [...lines].sort((a, b) => {
    const typeCmp = scTypeRank(scPsType(a)) - scTypeRank(scPsType(b));
    if (typeCmp) return typeCmp;
    for (const sort of sorts) {
      const dir = sort.dir === 'desc' ? -1 : 1;
      const av = scSortValue(a, sort.key);
      const bv = scSortValue(b, sort.key);
      const aEmpty = scIsEmptySort(sort.key, av);
      const bEmpty = scIsEmptySort(sort.key, bv);
      if (aEmpty || bEmpty) {
        if (aEmpty && bEmpty) continue;
        return aEmpty ? 1 : -1;
      }
      const cmp = scCompareSortValues(av, bv);
      if (cmp) return cmp * dir;
    }
    return String(a.process_sheet_no || '').localeCompare(String(b.process_sheet_no || ''), undefined, { numeric: true });
  });
}

function scCycleSort(key, stack) {
  const sorts = (scState.sorts || []).slice();
  const index = sorts.findIndex((sort) => sort.key === key);
  if (stack) {
    if (index >= 0) sorts[index] = { key, dir: sorts[index].dir === 'asc' ? 'desc' : 'asc' };
    else sorts.push({ key, dir: 'asc' });
    scState.sorts = sorts;
  } else if (sorts.length === 1 && sorts[0].key === key) {
    scState.sorts = [{ key, dir: sorts[0].dir === 'asc' ? 'desc' : 'asc' }];
  } else {
    scState.sorts = [{ key, dir: 'asc' }];
  }
  scEnsureSorts();
  scSaveLayout();
}

function scRenderPartCell(row) {
  const part = String(row.part_no || '-');
  const badges = [];
  if (row.is_new_part) {
    badges.push('<span class="sc-new-badge" title="New part">NEW</span>');
  }
  if (row.is_frame_agreement) {
    badges.push('<span class="sc-fa-badge" title="Frame agreement part">FA</span>');
  }
  return `<td class="sc-part-cell" title="${scEscape(part)}"><span class="sc-part-text">${scEscape(part)}</span>${badges.join('')}</td>`;
}

function scRenderDateCell(value) {
  const text = String(value || '').trim();
  if (!text) return '<td class="sc-date is-empty">-</td>';
  return `<td class="sc-date">${scEscape(scFormatDate(text))}</td>`;
}

function scRemarkInput(row, field, label) {
  const value = String(row?.[field] || '');
  return `
    <td class="sc-grid-cell sc-remark-cell" data-sc-grid="${field}">
      <input type="text"
        class="sc-remark-input"
        data-sc-field="${field}"
        data-last-saved="${scEscape(value)}"
        value="${scEscape(value)}"
        placeholder="${scEscape(label)}"
        title="${scEscape(value)}"
        aria-label="${scEscape(label)}"
        autocomplete="off"
        spellcheck="false">
    </td>`;
}

function scCommitInput(row) {
  const iso = scParseDate(row?.committed_schedule) || '';
  return `
    <td class="sc-grid-cell sc-commit-cell" data-sc-grid="committed_schedule">
      <div class="sc-date-field">
        <input type="text"
          class="sc-date-input"
          data-sc-field="committed_schedule"
          data-last-saved="${scEscape(iso)}"
          value="${scEscape(iso ? scFormatDate(iso) : '')}"
          placeholder="dd/mm/yyyy"
          aria-label="Committed schedule"
          autocomplete="off"
          spellcheck="false">
        <input type="date"
          class="sc-date-picker"
          tabindex="-1"
          value="${scEscape(iso)}"
          aria-label="Pick committed schedule">
      </div>
    </td>`;
}

function scSyncColumnsButton() {
  const btn = document.getElementById('sc-columns');
  if (!btn) return;
  const hidden = scState.hidden.size;
  btn.textContent = hidden ? `Columns (${hidden} hidden)` : 'Columns';
}

function scSyncStickyOffset() {
  const th = document.querySelector('#sc-table thead th');
  const height = th ? Math.ceil(th.getBoundingClientRect().height) : 36;
  document.documentElement.style.setProperty('--sc-head-h', `${Math.max(height, 32)}px`);
}

function scSyncTableWidth() {
  const { table } = scEls();
  if (!table) return;
  const width = scVisibleColumns().reduce((total, col) => total + scColWidth(col), 36);
  table.style.width = `${width}px`;
}

function scRenderHead() {
  const { table } = scEls();
  if (!table) return;
  const colgroup = table.querySelector('colgroup');
  const headRow = table.querySelector('thead tr');
  if (!colgroup || !headRow) return;
  const visible = scVisibleColumns();
  const sorts = scState.sorts || [];
  colgroup.innerHTML = [
    '<col class="sc-col-check" style="width:36px">',
    ...visible.map((col) => `<col data-col="${scEscape(col.id)}" style="width:${scColWidth(col)}px">`),
  ].join('');
  const heads = visible.map((col) => {
    const index = sorts.findIndex((sort) => sort.key === col.id);
    const sorted = index >= 0;
    const dir = sorted ? sorts[index].dir : '';
    const rank = sorts.length > 1 && sorted ? String(index + 1) : '';
    const filtering = scState.colFilters[col.id] instanceof Set;
    const classes = [
      col.remark ? 'sc-remark-col' : '',
      col.id === 'customer' ? 'sc-customer-col' : '',
      'is-sortable',
      sorted ? `is-sorted is-sorted-${dir === 'desc' ? 'desc' : 'asc'}` : '',
      filtering ? 'has-filter' : '',
    ].filter(Boolean).join(' ');
    const aria = sorted ? (dir === 'desc' ? 'descending' : 'ascending') : 'none';
    const ind = sorted
      ? `<span class="sc-th-ind" aria-hidden="true">${dir === 'desc' ? '↓' : '↑'}${rank ? `<span class="sc-th-rank">${rank}</span>` : ''}</span>`
      : '';
    const title = `${col.title || col.label}. Click to sort. Shift-click to add another sort. Drag the right edge to resize.`;
    const filterLabel = filtering ? `${col.label} filter is on` : `Filter ${col.label}`;
    const expanded = scState.filterKey === col.id ? 'true' : 'false';
    return `<th class="${classes}" data-col="${scEscape(col.id)}" data-sort="${scEscape(col.id)}" aria-sort="${aria}" title="${scEscape(title)}"><span class="sc-th-row"><span class="sc-th-label">${scEscape(col.label)}</span>${ind}<button type="button" class="sc-th-filter${filtering ? ' is-active' : ''}" data-col-filter="${scEscape(col.id)}" aria-label="${scEscape(filterLabel)}" aria-expanded="${expanded}" title="${scEscape(filterLabel)}"><svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M1.5 2.5h13l-5 6.1V13.2l-3-1.4V8.6l-5-6.1z"/></svg></button></span><span class="sc-col-resizer" data-col-resize="${scEscape(col.id)}" role="separator" aria-orientation="vertical" aria-valuemin="${col.min}" aria-valuemax="${col.max}" aria-valuenow="${scColWidth(col)}" aria-label="Resize ${scEscape(col.label)}" tabindex="0"></span></th>`;
  }).join('');
  headRow.innerHTML = `<th class="sc-check-col" title="Select all visible"><input type="checkbox" id="sc-select-all" aria-label="Select all visible process sheets"></th>${heads}`;
  scSyncTableWidth();
  scSyncColumnsButton();
  scSyncStickyOffset();
}

function scSyncExportButton() {
  const { exportBtn, selectionMeta } = scEls();
  const count = scState.selected.size;
  if (exportBtn) {
    exportBtn.disabled = count === 0;
    exportBtn.textContent = count ? `Export Excel (${count})` : 'Export Excel';
  }
  if (selectionMeta) {
    if (!count) {
      selectionMeta.hidden = true;
      selectionMeta.textContent = '';
    } else {
      selectionMeta.hidden = false;
      selectionMeta.textContent = `${count} selected`;
    }
  }
}

function scSyncSelectAll() {
  const { selectAll } = scEls();
  if (!selectAll) return;
  const visibleIds = scSortedLines(scFilteredLines()).map(scRowId);
  const selectedVisible = visibleIds.filter((id) => scState.selected.has(id));
  selectAll.checked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
  selectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.length;
}

function scSetRowSelected(id, checked) {
  if (!id) return;
  if (checked) scState.selected.add(id);
  else scState.selected.delete(id);
  const { body } = scEls();
  const row = body?.querySelector(`tr[data-row-id="${CSS.escape(id)}"]`);
  if (row) {
    row.classList.toggle('is-selected', checked);
    const box = row.querySelector('.sc-row-check');
    if (box) box.checked = checked;
  }
  scSyncSelectAll();
  scSyncExportButton();
}

function scRenderCustomerCell(row) {
  const label = scCustomerLabel(row);
  const { code, name } = scCustomerParts(row);
  if (!label) return '<td class="sc-customer is-empty">-</td>';
  const showName = name && name.toLowerCase() !== code.toLowerCase();
  const codeHtml = code ? `<span class="sc-customer-code">${scEscape(code)}</span>` : '';
  const nameHtml = showName ? `<span class="sc-customer-name">${scEscape(name)}</span>` : (!code ? `<span class="sc-customer-name">${scEscape(name)}</span>` : '');
  return `<td class="sc-customer" title="${scEscape(label)}">${codeHtml}${nameHtml}</td>`;
}

function scRenderDataCell(row, col) {
  switch (col.id) {
    case 'process_sheet_no': {
      const text = scPsDisplay(row);
      return `<td class="sc-mono" title="${scEscape(text)}">${scEscape(text)}</td>`;
    }
    case 'customer':
      return scRenderCustomerCell(row);
    case 'po_date':
      return scRenderDateCell(row.po_date);
    case 'customer_po_no':
      return `<td class="sc-mono" title="${scEscape(row.customer_po_no || '')}">${scEscape(row.customer_po_no || '-')}</td>`;
    case 'line_item_no': {
      const line = String(row.line_item_no || '').trim();
      return `<td class="sc-line">${scEscape(line || '-')}</td>`;
    }
    case 'part_no':
      return scRenderPartCell(row);
    case 'part_desc': {
      const desc = String(row.part_desc || '');
      return `<td class="sc-desc" title="${scEscape(desc)}">${scEscape(desc || '-')}</td>`;
    }
    case 'due_date':
      return scRenderDateCell(row.due_date);
    case 'order_qty':
      return `<td class="sc-num">${scEscape(scFormatQty(row.order_qty))}</td>`;
    case 'customer_remarks':
      return scRemarkInput(row, 'customer_remarks', 'Customer remarks');
    case 'coway_remarks':
      return scRemarkInput(row, 'coway_remarks', 'Coway remarks');
    case 'committed_schedule':
      return scCommitInput(row);
    default:
      return '<td></td>';
  }
}

function scRenderRow(row) {
  const id = scRowId(row);
  const checked = scState.selected.has(id);
  const cells = scVisibleColumns().map((col) => scRenderDataCell(row, col)).join('');
  return `
    <tr class="${checked ? 'is-selected' : ''}" data-row-id="${scEscape(id)}" data-pp-voucher-no="${scEscape(row.pp_voucher_no || '')}">
      <td class="sc-check-col">
        <input type="checkbox" class="sc-row-check" data-row-id="${scEscape(id)}" aria-label="Select ${scEscape(scPsDisplay(row))}"${checked ? ' checked' : ''}>
      </td>
      ${cells}
    </tr>`;
}

function scColCount() {
  return scVisibleColumns().length + 1;
}

function scGroupHeader(type, count) {
  const label = type || 'Other';
  return `<tr class="sc-group-row"><td colspan="${scColCount()}"><span>${scEscape(label)}</span><span class="sc-group-count">${count.toLocaleString()} line${count === 1 ? '' : 's'}</span></td></tr>`;
}

function scResetGrid() {
  scGrid.anchor = null;
  scGrid.focus = null;
  scGrid.pending = null;
  scGrid.dragging = false;
}

function scRenderTable() {
  const { body, empty, panel, meta } = scEls();
  if (!body) return;
  scResetGrid();

  const filtered = scSortedLines(scFilteredLines());
  scRenderHead();
  scUpdateClearButton();
  scRenderTypeChips();

  if (panel) panel.hidden = false;
  if (meta) {
    const total = scState.lines.length;
    const segments = SC_LEAD_TYPES.filter((type) => scState.psTypes.has(type));
    const segmentLabel = segments.length ? segments.join(' + ') : 'selected types';
    meta.textContent = `${filtered.length.toLocaleString()} of ${total.toLocaleString()} · ${segmentLabel}`;
  }

  if (!filtered.length) {
    body.innerHTML = '';
    if (empty) empty.hidden = false;
    scSyncSelectAll();
    scSyncExportButton();
    scPaintGrid();
    scSyncFilterPopover();
    return;
  }
  if (empty) empty.hidden = true;

  const groups = [];
  filtered.forEach((row) => {
    const type = scPsType(row) || 'Other';
    if (!groups.length || groups[groups.length - 1].type !== type) {
      groups.push({ type, rows: [] });
    }
    groups[groups.length - 1].rows.push(row);
  });
  body.innerHTML = groups.map((group) => (
    scGroupHeader(group.type, group.rows.length) + group.rows.map(scRenderRow).join('')
  )).join('');
  scSyncSelectAll();
  scSyncExportButton();
  scPaintGrid();
  scSyncFilterPopover();
}

function scExportCellValue(row, colId) {
  if (colId === 'process_sheet_no') return scPsDisplay(row) === '-' ? '' : scPsDisplay(row);
  if (colId === 'customer') return scCustomerLabel(row);
  if (colId === 'order_qty') {
    const num = Number(row?.order_qty);
    return Number.isFinite(num) ? num : '';
  }
  if (colId === 'due_date' || colId === 'po_date' || colId === 'committed_schedule') {
    const formatted = scFormatDate(row?.[colId]);
    return formatted || '';
  }
  const value = String(row?.[colId] ?? '').trim();
  return value === '-' ? '' : value;
}

function scSelectedLines() {
  if (!scState.selected.size) return [];
  const byId = new Map((scState.lines || []).map((row) => [scRowId(row), row]));
  const ordered = scSortedLines(scFilteredLines()).filter((row) => scState.selected.has(scRowId(row)));
  const seen = new Set(ordered.map(scRowId));
  for (const id of scState.selected) {
    if (seen.has(id)) continue;
    const row = byId.get(id);
    if (row) ordered.push(row);
  }
  return ordered;
}

function scExportFilename() {
  const stamp = new Date().toISOString().slice(0, 10);
  return `sales-coordination-${stamp}.xlsx`;
}

async function scEnsureExcelJs() {
  if (window.ExcelJS) return window.ExcelJS;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load Excel export library'));
    document.head.appendChild(script);
  });
  return window.ExcelJS;
}

async function scExportSelected() {
  const rows = scSelectedLines();
  if (!rows.length) {
    scShowAlert('Select process sheets with the checkboxes, then export.');
    return;
  }
  const { exportBtn } = scEls();
  if (exportBtn) exportBtn.disabled = true;
  scShowAlert('');
  try {
    const ExcelJS = await scEnsureExcelJs();
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sales Coordination';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Process sheets');
    const headerRow = sheet.addRow(SC_EXPORT_COLUMNS.map((col) => col.label));
    headerRow.font = { bold: true, size: 11 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4EEEA' } };
    headerRow.alignment = { vertical: 'middle' };
    rows.forEach((row) => {
      sheet.addRow(SC_EXPORT_COLUMNS.map((col) => scExportCellValue(row, col.id)));
    });
    SC_EXPORT_COLUMNS.forEach((col, index) => {
      sheet.getColumn(index + 1).width = col.width;
    });
    sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 0, activeCell: 'A2' }];
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = scExportFilename();
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    scShowAlert(err.message || 'Could not export Excel.');
  } finally {
    scSyncExportButton();
  }
}

function scLineById(rowId) {
  return (scState.lines || []).find((row) => scRowId(row) === rowId) || null;
}

async function scPostEdits(updates) {
  const res = await fetch('/api/sales-coordination/lines', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function scReadInput(input) {
  const field = input?.dataset?.scField || '';
  const text = String(input?.value || '').trim();
  if (field === 'committed_schedule') {
    if (scIsBlankToken(text)) return '';
    const iso = scParseDate(text);
    if (!iso) {
      const err = new Error('Committed schedule needs a date like 30/09/2026.');
      err.invalid = true;
      throw err;
    }
    return iso;
  }
  return text;
}

function scPaintField(td, field, value) {
  const input = td?.querySelector(`[data-sc-field="${field}"]`);
  if (!input) return;
  if (field === 'committed_schedule') {
    const iso = value ? scParseDate(value) : '';
    input.value = iso ? scFormatDate(iso) : '';
    input.dataset.lastSaved = iso || '';
    const picker = td.querySelector('.sc-date-picker');
    if (picker) picker.value = iso || '';
    input.classList.remove('is-invalid');
    return;
  }
  input.value = value || '';
  input.dataset.lastSaved = value || '';
}

async function scSaveInput(input) {
  if (!input) return;
  const field = input.dataset.scField || '';
  const tr = input.closest('tr');
  const rowId = tr?.getAttribute('data-row-id') || '';
  const row = scLineById(rowId);
  if (!field || !row) return;
  let next = '';
  try {
    next = scReadInput(input);
  } catch (err) {
    input.classList.add('is-invalid');
    scShowAlert(err.message || 'Could not read that cell.');
    return;
  }
  const previous = String(input.dataset.lastSaved || '');
  if (next === previous) {
    input.classList.remove('is-invalid');
    if (field === 'committed_schedule') input.value = next ? scFormatDate(next) : '';
    return;
  }
  input.classList.remove('is-invalid');
  input.classList.add('is-saving');
  const prior = row[field] ?? '';
  row[field] = next;
  scPaintField(input.closest('td'), field, next);
  try {
    await scPostEdits([{
      pp_voucher_no: row.pp_voucher_no || '',
      pp_partial_no: Number(row.pp_partial_no) || 1,
      [field]: next,
    }]);
    scShowAlert('');
  } catch (err) {
    row[field] = prior;
    scPaintField(input.closest('td'), field, prior || '');
    input.classList.add('is-invalid');
    scShowAlert(err.message || 'Could not save.');
  } finally {
    input.classList.remove('is-saving');
  }
}

function scGridRows() {
  const { body } = scEls();
  if (!body) return [];
  return [...body.querySelectorAll('tr')].filter((tr) => tr.querySelector('td[data-sc-grid]'));
}

function scCellPos(td) {
  const tr = td?.closest('tr');
  if (!tr) return { row: -1, col: -1 };
  const row = scGridRows().indexOf(tr);
  const col = [...tr.querySelectorAll('td[data-sc-grid]')].indexOf(td);
  return { row, col };
}

function scSelectedCells() {
  const { table } = scEls();
  if (!table || !scGrid.anchor || !scGrid.focus) return [];
  const rows = scGridRows();
  const r1 = Math.min(scGrid.anchor.row, scGrid.focus.row);
  const r2 = Math.max(scGrid.anchor.row, scGrid.focus.row);
  const c1 = Math.min(scGrid.anchor.col, scGrid.focus.col);
  const c2 = Math.max(scGrid.anchor.col, scGrid.focus.col);
  const out = [];
  for (let r = r1; r <= r2; r += 1) {
    const cells = [...(rows[r]?.querySelectorAll('td[data-sc-grid]') || [])];
    for (let c = c1; c <= c2; c += 1) {
      if (cells[c]) out.push(cells[c]);
    }
  }
  return out;
}

function scPaintGrid() {
  document.querySelectorAll('#sc-table td.sc-grid-cell.is-grid-selected, #sc-table td.sc-grid-cell.is-grid-active').forEach((td) => {
    td.classList.remove('is-grid-selected', 'is-grid-active');
  });
  const cells = scSelectedCells();
  cells.forEach((td) => td.classList.add('is-grid-selected'));
  const rows = scGridRows();
  const focusTd = rows[scGrid.focus?.row]?.querySelectorAll('td[data-sc-grid]')[scGrid.focus?.col];
  if (focusTd) focusTd.classList.add('is-grid-active');
}

function scGridCellText(td) {
  const input = td.querySelector('[data-sc-field]');
  return String(input?.value || '').trim();
}

function scCellsToTsv(cells) {
  const byRow = new Map();
  cells.forEach((td) => {
    const pos = scCellPos(td);
    if (!byRow.has(pos.row)) byRow.set(pos.row, []);
    byRow.get(pos.row).push({ col: pos.col, text: scGridCellText(td) });
  });
  return [...byRow.keys()].sort((a, b) => a - b).map((rowIndex) => {
    const items = byRow.get(rowIndex).sort((a, b) => a.col - b.col);
    const minCol = items[0].col;
    const maxCol = items[items.length - 1].col;
    const line = [];
    for (let col = minCol; col <= maxCol; col += 1) {
      const found = items.find((item) => item.col === col);
      line.push(found ? found.text : '');
    }
    return line.join('\t');
  }).join('\n');
}

function scClipboardMatrix(text) {
  let raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (raw.endsWith('\n')) raw = raw.slice(0, -1);
  if (!raw) return [['']];
  return raw.split('\n').map((line) => line.split('\t'));
}

function scInterpretCell(field, raw) {
  let text = String(raw ?? '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).replace(/""/g, '"').trim();
  }
  if (field === 'committed_schedule') {
    if (scIsBlankToken(text)) return '';
    const iso = scParseDate(text);
    if (!iso) throw new Error(`"${text}" is not a date (dd/mm/yyyy)`);
    return iso;
  }
  if (field === 'customer_remarks' || field === 'coway_remarks') {
    return scIsBlankToken(text) ? '' : text;
  }
  throw new Error('That column cannot be pasted');
}

function scPasteTargets(matrix) {
  const rows = scGridRows();
  const selected = scSelectedCells();
  const single = matrix.length === 1 && matrix[0].length === 1;
  if (single && selected.length > 1) {
    return selected.map((td) => ({ td, raw: matrix[0][0] }));
  }
  const originRow = Math.min(scGrid.anchor.row, scGrid.focus.row);
  const originCol = Math.min(scGrid.anchor.col, scGrid.focus.col);
  const out = [];
  matrix.forEach((line, r) => {
    line.forEach((raw, c) => {
      const cells = [...(rows[originRow + r]?.querySelectorAll('td[data-sc-grid]') || [])];
      const td = cells[originCol + c];
      if (td) out.push({ td, raw });
    });
  });
  return out;
}

function scPasteAlert(errors) {
  const sample = String(errors[0] || '');
  if (/not a date/i.test(sample)) return 'Paste not saved. Committed schedule dates need to look like 30/09/2026.';
  return 'Paste not saved.';
}

async function scApplyGrid(pairs) {
  const errors = [];
  const byRow = new Map();
  pairs.forEach(({ td, raw }) => {
    const field = td.getAttribute('data-sc-grid');
    let value;
    try {
      value = scInterpretCell(field, raw);
    } catch (err) {
      errors.push(err.message || 'Could not paste');
      return;
    }
    const tr = td.closest('tr');
    const rowId = tr?.getAttribute('data-row-id') || '';
    const row = scLineById(rowId);
    if (!rowId || !row) return;
    const entry = byRow.get(rowId) || { tr, patches: {}, previous: {} };
    if (!(field in entry.previous)) entry.previous[field] = row[field] ?? '';
    entry.patches[field] = value;
    byRow.set(rowId, entry);
    row[field] = value;
    scPaintField(td, field, value);
  });
  if (!byRow.size) {
    if (errors.length) scShowAlert(scPasteAlert(errors));
    return;
  }
  const updates = [...byRow.entries()].map(([rowId, entry]) => {
    const row = scLineById(rowId);
    return {
      pp_voucher_no: row?.pp_voucher_no || '',
      pp_partial_no: Number(row?.pp_partial_no) || 1,
      ...entry.patches,
    };
  });
  try {
    await scPostEdits(updates);
    scShowAlert(errors.length ? scPasteAlert(errors) : '');
    scPaintGrid();
  } catch (err) {
    byRow.forEach((entry, rowId) => {
      const row = scLineById(rowId);
      if (row) Object.assign(row, entry.previous);
      Object.entries(entry.previous).forEach(([field, value]) => {
        const td = entry.tr?.querySelector(`td[data-sc-grid="${field}"]`);
        if (td) scPaintField(td, field, value || '');
      });
    });
    const message = errors.length ? scPasteAlert(errors) : '';
    scShowAlert(`${message} ${err.message || 'Could not save the paste.'}`.trim());
  }
}

function scEditorHasTextSelection() {
  const el = document.activeElement;
  if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return false;
  if (el.type === 'date') return false;
  return typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd;
}

function scShouldGridPaste(event) {
  const origin = event.target?.closest?.('td[data-sc-grid]');
  const { table } = scEls();
  const active = document.activeElement;
  const inGrid = !!(table && active && (active === table || table.contains(active)));
  if (!scGrid.anchor || !table) return false;
  if (!inGrid && !origin) return false;
  if (origin && !origin.closest('#sc-table')) return false;
  const text = event.clipboardData?.getData('text/plain') ?? '';
  const multi = scSelectedCells().length > 1;
  const structured = /[\t\n]/.test(String(text));
  if (multi || structured) return true;
  if (event.target?.closest?.('[data-sc-field]')) return false;
  return !!((origin || scSelectedCells()[0])?.getAttribute('data-sc-grid'));
}

function scBindGrid() {
  const { table } = scEls();
  if (table) table.tabIndex = -1;

  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest?.('.sc-col-resizer, .sc-th-filter, .sc-col-filter, .sc-columns-menu, #sc-columns')) return;
    const cell = event.target.closest?.('td[data-sc-grid]');
    if (!cell || !cell.closest('#sc-table')) {
      const keep = event.target.closest?.('#sc-table input, #sc-table button, #sc-table a, #sc-table label');
      if (!keep) {
        scResetGrid();
        scPaintGrid();
      }
      return;
    }
    const pos = scCellPos(cell);
    if (pos.row < 0 || pos.col < 0) return;
    if (event.shiftKey && scGrid.anchor) {
      event.preventDefault();
      scGrid.focus = pos;
      scPaintGrid();
      return;
    }
    scGrid.anchor = pos;
    scGrid.focus = pos;
    scGrid.pending = { x: event.clientX, y: event.clientY };
    scGrid.dragging = false;
    scPaintGrid();
  });

  document.addEventListener('mousemove', (event) => {
    if (!scGrid.pending || !scGrid.anchor) return;
    const dx = Math.abs(event.clientX - scGrid.pending.x);
    const dy = Math.abs(event.clientY - scGrid.pending.y);
    if (!scGrid.dragging && dx + dy < 5) return;
    scGrid.dragging = true;
    document.body.classList.add('sc-grid-dragging');
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const cell = under?.closest?.('td[data-sc-grid]');
    if (!cell || !cell.closest('#sc-table')) return;
    const pos = scCellPos(cell);
    if (pos.row < 0 || pos.col < 0) return;
    scGrid.focus = pos;
    scPaintGrid();
    const selection = window.getSelection?.();
    if (selection && selection.rangeCount) selection.removeAllRanges();
  });

  document.addEventListener('mouseup', () => {
    if (!scGrid.pending && !scGrid.dragging) return;
    if (scGrid.dragging) {
      const active = document.activeElement;
      if (active && active.closest?.('td[data-sc-grid]')) active.blur();
      scEls().table?.focus({ preventScroll: true });
    }
    scGrid.pending = null;
    scGrid.dragging = false;
    document.body.classList.remove('sc-grid-dragging');
  });

  document.addEventListener('copy', (event) => {
    if (scEditorHasTextSelection()) return;
    const cells = scSelectedCells();
    if (!cells.length) return;
    const active = document.activeElement;
    const { table } = scEls();
    if (active && !active.closest?.('td[data-sc-grid]') && active !== table) return;
    event.preventDefault();
    event.clipboardData?.setData('text/plain', scCellsToTsv(cells));
  }, true);

  document.addEventListener('paste', (event) => {
    if (!scShouldGridPaste(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    scApplyGrid(scPasteTargets(scClipboardMatrix(text))).catch((err) => {
      scShowAlert(err.message || 'Paste failed');
    });
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    if (!scSelectedCells().length) return;
    const active = document.activeElement;
    if (active && active.closest?.('input, textarea, select, button')) return;
    const { table } = scEls();
    if (active && !active.closest?.('td[data-sc-grid]') && active !== table) return;
    event.preventDefault();
    scApplyGrid(scSelectedCells().map((td) => ({ td, raw: '' }))).catch((err) => {
      scShowAlert(err.message || 'Could not clear cells');
    });
  });
}

async function scLoad({ refresh = false } = {}) {
  const { refresh: refreshBtn } = scEls();
  scShowAlert('');
  scSetLoading(true);
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const url = refresh ? '/api/sales-coordination?refresh=1' : '/api/sales-coordination';
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    scState.lines = Array.isArray(data.lines) ? data.lines : [];
    scState.selected = new Set();
    scRenderTable();
  } catch (err) {
    scShowAlert(err.message || 'Could not load sales coordination data.');
    const { panel, meta } = scEls();
    if (panel) panel.hidden = true;
    if (meta) meta.textContent = 'Failed to load';
  } finally {
    scSetLoading(false);
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

let scResize = null;
let scIgnoreHeaderClick = false;

function scCloseFilter() {
  scState.filterKey = '';
  scState.filterQuery = '';
  const pop = document.getElementById('sc-col-filter');
  if (pop) pop.hidden = true;
  document.querySelectorAll('#sc-table [data-col-filter][aria-expanded="true"]').forEach((btn) => {
    btn.setAttribute('aria-expanded', 'false');
  });
}

function scCloseColumnsMenu() {
  const menu = document.getElementById('sc-columns-menu');
  const btn = document.getElementById('sc-columns');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function scPlacePopover(pop, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = pop.offsetWidth || 300;
  const height = pop.offsetHeight || 320;
  let left = rect.right - width;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function scSortActionLabels(col) {
  if (col?.kind === 'date') return ['Oldest first', 'Newest first'];
  if (col?.kind === 'num') return ['Smallest first', 'Largest first'];
  return ['Sort A → Z', 'Sort Z → A'];
}

function scCompareFilterValues(col, a, b) {
  if (a === SC_BLANK) return -1;
  if (b === SC_BLANK) return 1;
  if (col.kind === 'date') return (scParseDate(a) || '').localeCompare(scParseDate(b) || '');
  if (col.kind === 'num') {
    const an = Number(String(a).replace(/,/g, ''));
    const bn = Number(String(b).replace(/,/g, ''));
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function scFillFilterList() {
  const col = scColumnById(scState.filterKey);
  const list = document.getElementById('sc-col-filter-list');
  if (!col || !list) return;
  const counts = new Map();
  scRowsForFilterOptions(col.id).forEach((row) => {
    const key = scFilterKey(row, col.id);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const query = scState.filterQuery.trim().toLowerCase();
  const values = [...counts.keys()].sort((a, b) => scCompareFilterValues(col, a, b));
  const visibleValues = values.filter((value) => !query || value.toLowerCase().includes(query));
  const selected = scState.colFilters[col.id];
  const isChecked = (value) => !(selected instanceof Set) || selected.has(value);
  const checkedCount = visibleValues.filter(isChecked).length;
  const allOn = visibleValues.length > 0 && checkedCount === visibleValues.length;
  const someOn = checkedCount > 0 && !allOn;
  const items = visibleValues.map((value) => {
    const count = counts.get(value) || 0;
    return `<label class="sc-col-filter-item"><input type="checkbox" data-sc-filter-value="${scEscape(value)}"${isChecked(value) ? ' checked' : ''}><span class="sc-col-filter-value" title="${scEscape(value)}">${scEscape(value)}</span><span class="sc-col-filter-count">${count.toLocaleString()}</span></label>`;
  }).join('');
  const empty = visibleValues.length ? '' : '<p class="sc-col-filter-empty">No matching values</p>';
  list.innerHTML = `<label class="sc-col-filter-item sc-col-filter-item--all"><input type="checkbox" data-sc-filter-all${allOn ? ' checked' : ''}>Select all<span class="sc-col-filter-count">${visibleValues.length.toLocaleString()}</span></label>${items}${empty}`;
  const allBox = list.querySelector('[data-sc-filter-all]');
  if (allBox) allBox.indeterminate = someOn;
  const labels = scSortActionLabels(col);
  const asc = document.querySelector('#sc-col-filter [data-sc-sort-dir="asc"]');
  const desc = document.querySelector('#sc-col-filter [data-sc-sort-dir="desc"]');
  const clearSort = document.querySelector('#sc-col-filter [data-sc-sort-clear]');
  const title = document.getElementById('sc-col-filter-title');
  const only = scState.sorts.length === 1 ? scState.sorts[0] : null;
  if (asc) {
    asc.textContent = labels[0];
    asc.setAttribute('aria-pressed', only && only.key === col.id && only.dir === 'asc' ? 'true' : 'false');
  }
  if (desc) {
    desc.textContent = labels[1];
    desc.setAttribute('aria-pressed', only && only.key === col.id && only.dir === 'desc' ? 'true' : 'false');
  }
  if (clearSort) clearSort.hidden = !scState.sorts.some((sort) => sort.key === col.id);
  if (title) title.textContent = col.label;
}

function scSyncFilterPopover() {
  const pop = document.getElementById('sc-col-filter');
  if (!pop || pop.hidden || !scState.filterKey) return;
  const btn = document.querySelector(`#sc-table [data-col-filter="${CSS.escape(scState.filterKey)}"]`);
  if (!btn) {
    scCloseFilter();
    return;
  }
  scFillFilterList();
  btn.setAttribute('aria-expanded', 'true');
  scPlacePopover(pop, btn);
}

function scOpenFilter(key, anchor) {
  const pop = document.getElementById('sc-col-filter');
  if (!pop || !scColumnById(key)) return;
  scCloseColumnsMenu();
  scState.filterKey = key;
  scState.filterQuery = '';
  const input = document.getElementById('sc-col-filter-search');
  if (input) input.value = '';
  pop.hidden = false;
  scFillFilterList();
  scPlacePopover(pop, anchor);
  document.querySelectorAll('#sc-table [data-col-filter]').forEach((btn) => {
    btn.setAttribute('aria-expanded', btn === anchor ? 'true' : 'false');
  });
}

function scFilterUniverse(colId) {
  const all = new Set();
  scRowsForFilterOptions(colId).forEach((row) => all.add(scFilterKey(row, colId)));
  return all;
}

function scCommitColumnFilter(colId, next, all) {
  if (!(next instanceof Set) || next.size === all.size) delete scState.colFilters[colId];
  else scState.colFilters[colId] = next;
  scRenderTable();
}

function scCurrentFilterSet(colId, all) {
  const selected = scState.colFilters[colId];
  if (!(selected instanceof Set)) return new Set(all);
  return new Set([...selected].filter((value) => all.has(value)));
}

function scToggleFilterValue(colId, value, checked) {
  const all = scFilterUniverse(colId);
  const next = scCurrentFilterSet(colId, all);
  if (checked) next.add(value);
  else next.delete(value);
  scCommitColumnFilter(colId, next, all);
}

function scToggleVisibleFilterValues(colId, checked) {
  const all = scFilterUniverse(colId);
  const next = scCurrentFilterSet(colId, all);
  const query = scState.filterQuery.trim().toLowerCase();
  [...all].filter((value) => !query || value.toLowerCase().includes(query)).forEach((value) => {
    if (checked) next.add(value);
    else next.delete(value);
  });
  scCommitColumnFilter(colId, next, all);
}

function scSetOnlySort(key, dir) {
  scState.sorts = [{ key, dir }];
  scEnsureSorts();
  scSaveLayout();
  scCloseFilter();
  scRenderTable();
}

function scClearSortKey(key) {
  scState.sorts = (scState.sorts || []).filter((sort) => sort.key !== key);
  scEnsureSorts();
  scSaveLayout();
  scCloseFilter();
  scRenderTable();
}

function scRenderColumnsMenu() {
  const menu = document.getElementById('sc-columns-menu');
  if (!menu) return;
  const visibleCount = scVisibleColumns().length;
  const items = SC_COLUMNS.map((col) => {
    const on = !scState.hidden.has(col.id);
    const disable = on && visibleCount <= 1;
    return `<label class="sc-columns-item"><input type="checkbox" data-sc-col-toggle="${scEscape(col.id)}"${on ? ' checked' : ''}${disable ? ' disabled' : ''}>${scEscape(col.label)}</label>`;
  }).join('');
  menu.innerHTML = `${items}<div class="sc-columns-actions"><button type="button" data-sc-cols-show>Show all</button><button type="button" data-sc-cols-reset>Reset widths</button></div>`;
}

function scSetColumnVisible(id, show) {
  if (!scColumnById(id)) return;
  if (show) {
    scState.hidden.delete(id);
  } else {
    if (scVisibleColumns().length <= 1) return;
    scState.hidden.add(id);
    delete scState.colFilters[id];
    scState.sorts = (scState.sorts || []).filter((sort) => sort.key !== id);
    if (scState.filterKey === id) scCloseFilter();
  }
  scEnsureSorts();
  scSaveLayout();
  scRenderColumnsMenu();
  scRenderTable();
}

function scApplyColumnWidth(id, width) {
  const col = scColumnById(id);
  if (!col) return;
  const next = Math.round(Math.min(col.max, Math.max(col.min, width)));
  scState.widths[id] = next;
  const colEl = document.querySelector(`#sc-table col[data-col="${CSS.escape(id)}"]`);
  if (colEl) colEl.style.width = `${next}px`;
  const handle = document.querySelector(`#sc-table [data-col-resize="${CSS.escape(id)}"]`);
  if (handle) handle.setAttribute('aria-valuenow', String(next));
  scSyncTableWidth();
}

function scBindColumns() {
  const columnsBtn = document.getElementById('sc-columns');
  const menu = document.getElementById('sc-columns-menu');
  const pop = document.getElementById('sc-col-filter');
  const thead = document.querySelector('#sc-table thead');

  columnsBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!menu) return;
    if (menu.hidden) {
      scCloseFilter();
      scRenderColumnsMenu();
      menu.hidden = false;
      columnsBtn.setAttribute('aria-expanded', 'true');
    } else {
      scCloseColumnsMenu();
    }
  });

  menu?.addEventListener('change', (event) => {
    const box = event.target.closest('[data-sc-col-toggle]');
    if (!box) return;
    scSetColumnVisible(box.getAttribute('data-sc-col-toggle'), box.checked);
  });

  menu?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.target.closest('[data-sc-cols-show]')) {
      scState.hidden.clear();
      scEnsureSorts();
      scSaveLayout();
      scRenderColumnsMenu();
      scRenderTable();
      return;
    }
    if (event.target.closest('[data-sc-cols-reset]')) {
      scState.widths = {};
      scSaveLayout();
      scRenderHead();
      scSyncFilterPopover();
    }
  });

  thead?.addEventListener('change', (event) => {
    if (event.target?.id !== 'sc-select-all') return;
    const checked = Boolean(event.target.checked);
    scSortedLines(scFilteredLines()).forEach((row) => {
      const id = scRowId(row);
      if (checked) scState.selected.add(id);
      else scState.selected.delete(id);
    });
    scRenderTable();
  });

  thead?.addEventListener('click', (event) => {
    const filterBtn = event.target.closest('[data-col-filter]');
    if (filterBtn) {
      event.preventDefault();
      event.stopPropagation();
      const key = filterBtn.getAttribute('data-col-filter') || '';
      if (scState.filterKey === key && pop && !pop.hidden) scCloseFilter();
      else scOpenFilter(key, filterBtn);
      return;
    }
    if (event.target.closest('.sc-col-resizer, .sc-check-col, button, input')) return;
    const th = event.target.closest('th[data-sort]');
    if (!th) return;
    const col = th.getAttribute('data-sort');
    if (!col) return;
    scCycleSort(col, event.shiftKey);
    scRenderTable();
  });

  thead?.addEventListener('dblclick', (event) => {
    const handle = event.target.closest('.sc-col-resizer');
    if (!handle) return;
    event.preventDefault();
    const id = handle.getAttribute('data-col-resize');
    delete scState.widths[id];
    scSaveLayout();
    scRenderHead();
    scSyncFilterPopover();
  });

  thead?.addEventListener('keydown', (event) => {
    const handle = event.target.closest?.('.sc-col-resizer');
    if (!handle) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const id = handle.getAttribute('data-col-resize');
    const col = scColumnById(id);
    if (!col) return;
    const step = event.shiftKey ? 48 : 16;
    scApplyColumnWidth(id, scColWidth(col) + (event.key === 'ArrowRight' ? step : -step));
    scSaveLayout();
  });

  document.addEventListener('mousedown', (event) => {
    const handle = event.target.closest?.('.sc-col-resizer');
    if (!handle || event.button !== 0) return;
    const id = handle.getAttribute('data-col-resize');
    const col = scColumnById(id);
    if (!col) return;
    event.preventDefault();
    scIgnoreHeaderClick = true;
    scCloseFilter();
    scCloseColumnsMenu();
    scResize = { id, startX: event.clientX, startW: scColWidth(col) };
    document.body.classList.add('sc-col-resizing');
  });

  document.addEventListener('mousemove', (event) => {
    if (!scResize) return;
    scApplyColumnWidth(scResize.id, scResize.startW + (event.clientX - scResize.startX));
  });

  document.addEventListener('mouseup', () => {
    if (!scResize) return;
    scResize = null;
    document.body.classList.remove('sc-col-resizing');
    scSaveLayout();
  });

  document.addEventListener('click', (event) => {
    if (!scIgnoreHeaderClick) return;
    scIgnoreHeaderClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  pop?.addEventListener('input', (event) => {
    if (event.target?.id !== 'sc-col-filter-search') return;
    scState.filterQuery = event.target.value || '';
    scFillFilterList();
    const anchor = document.querySelector(`#sc-table [data-col-filter="${CSS.escape(scState.filterKey)}"]`);
    if (anchor && pop) scPlacePopover(pop, anchor);
  });

  pop?.addEventListener('change', (event) => {
    const colId = scState.filterKey;
    if (!colId) return;
    if (event.target.matches('[data-sc-filter-all]')) {
      scToggleVisibleFilterValues(colId, event.target.checked);
      return;
    }
    const valueBox = event.target.closest('[data-sc-filter-value]');
    if (!valueBox) return;
    scToggleFilterValue(colId, valueBox.getAttribute('data-sc-filter-value') || '', valueBox.checked);
  });

  pop?.addEventListener('click', (event) => {
    const dirBtn = event.target.closest('[data-sc-sort-dir]');
    if (dirBtn && scState.filterKey) {
      scSetOnlySort(scState.filterKey, dirBtn.getAttribute('data-sc-sort-dir') === 'desc' ? 'desc' : 'asc');
      return;
    }
    if (event.target.closest('[data-sc-sort-clear]') && scState.filterKey) {
      scClearSortKey(scState.filterKey);
      return;
    }
    if (event.target.closest('[data-sc-col-hide]') && scState.filterKey) {
      scSetColumnVisible(scState.filterKey, false);
      return;
    }
    if (event.target.closest('#sc-col-filter-clear') && scState.filterKey) {
      delete scState.colFilters[scState.filterKey];
      scRenderTable();
    }
  });

  document.addEventListener('click', (event) => {
    if (menu && !menu.hidden && !menu.contains(event.target) && event.target !== columnsBtn && !columnsBtn?.contains(event.target)) {
      scCloseColumnsMenu();
    }
    if (pop && !pop.hidden && !pop.contains(event.target) && !event.target.closest?.('[data-col-filter]')) {
      scCloseFilter();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (scState.filterKey) {
      scCloseFilter();
      return;
    }
    if (menu && !menu.hidden) scCloseColumnsMenu();
  });

  window.addEventListener('resize', () => {
    scSyncStickyOffset();
    if (!scState.filterKey || !pop || pop.hidden) return;
    const anchor = document.querySelector(`#sc-table [data-col-filter="${CSS.escape(scState.filterKey)}"]`);
    if (anchor) scPlacePopover(pop, anchor);
  });

  document.querySelector('.sc-table-scroll')?.addEventListener('scroll', () => {
    if (scState.filterKey) scCloseFilter();
  }, { passive: true });
}

function scBindEvents() {
  const els = scEls();

  els.search?.addEventListener('input', () => {
    scState.search = els.search.value || '';
    scRenderTable();
  });

  els.typeChips?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sc-type]');
    if (!btn) return;
    const type = btn.getAttribute('data-sc-type');
    if (!type) return;
    if (scState.psTypes.has(type)) scState.psTypes.delete(type);
    else scState.psTypes.add(type);
    scRenderTable();
  });

  els.clearFilters?.addEventListener('click', () => {
    scState.search = '';
    if (els.search) els.search.value = '';
    scState.psTypes = new Set(SC_DEFAULT_PS_TYPES);
    scState.colFilters = {};
    scCloseFilter();
    scRenderTable();
  });

  els.refresh?.addEventListener('click', () => scLoad({ refresh: true }));
  els.exportBtn?.addEventListener('click', () => scExportSelected());

  els.body?.addEventListener('change', (e) => {
    const check = e.target.closest('.sc-row-check');
    if (check) {
      scSetRowSelected(check.getAttribute('data-row-id'), check.checked);
      return;
    }
    const picker = e.target.closest('.sc-date-picker');
    if (picker) {
      const input = picker.parentElement?.querySelector('.sc-date-input');
      if (input) {
        input.value = picker.value ? scFormatDate(picker.value) : '';
        scSaveInput(input);
      }
    }
  });

  els.body?.addEventListener('focusout', (e) => {
    const input = e.target.closest?.('.sc-remark-input, .sc-date-input');
    if (!input) return;
    const next = e.relatedTarget;
    if (next && next.closest?.('.sc-date-field') === input.closest('.sc-date-field')) return;
    scSaveInput(input);
  });

  els.body?.addEventListener('keydown', (e) => {
    const input = e.target.closest('.sc-remark-input, .sc-date-input');
    if (!input) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  scLoadLayout();
  scRenderHead();
  scRenderTypeChips();
  scBindEvents();
  scBindColumns();
  scBindGrid();
  scLoad();
});
