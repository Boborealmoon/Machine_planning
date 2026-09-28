/* Sales Coordination - APS/NPS follow-up; buyer editable, material/WO read-only */

const SC_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
const SC_DEFAULT_PS_TYPES = ['APS', 'NPS'];
const SC_TYPE_ORDER = ['APS', 'NPS', 'MPS', 'PPS', 'CPS', 'SR'];
const SC_COL_COUNT = 17;

const scState = {
  lines: [],
  loading: false,
  search: '',
  psTypes: new Set(SC_DEFAULT_PS_TYPES),
  sortCol: 'due_date',
  sortDir: 'asc',
  selected: new Set(),
  _typesInitialized: false,
};

const SC_SORT_FALLBACK = {
  due_date: '9999-12-31',
  posted_date: '9999-12-31',
  proposed_edd: '9999-12-31',
  material_in_date: '9999-12-31',
  material_need_date: '9999-12-31',
  qty: Number.POSITIVE_INFINITY,
  partial_qty: Number.POSITIVE_INFINITY,
};

const SC_EXPORT_COLUMNS = [
  { id: 'process_sheet_no', label: 'Process sheet no', width: 18 },
  { id: 'sales_order_no', label: 'SO no', width: 16 },
  { id: 'customer_name', label: 'Customer', width: 22 },
  { id: 'customer_po_no', label: 'PO no', width: 16 },
  { id: 'part_no', label: 'Part no', width: 18 },
  { id: 'part_desc', label: 'Part description', width: 32 },
  { id: 'qty', label: 'Qty', width: 10 },
  { id: 'partial_qty', label: 'Partial qty', width: 12 },
  { id: 'posted_date', label: 'Posted date', width: 14 },
  { id: 'due_date', label: 'PO due date', width: 14 },
  { id: 'material_need_date', label: 'Need date', width: 14 },
  { id: 'material_in_date', label: 'Material in date', width: 16 },
  { id: 'proposed_edd', label: 'Proposed EDD', width: 14 },
  { id: 'buyer', label: 'Buyer', width: 16 },
  { id: 'order_status', label: 'Order status', width: 18 },
  { id: 'material', label: 'Material', width: 18 },
  { id: 'material_status', label: 'Material status', width: 16 },
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text || '-';
  const [y, m, d] = text.split('-');
  return `${d}/${m}/${y}`;
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

function scRenderTypeChips() {
  const { typeChips } = scEls();
  if (!typeChips) return;
  typeChips.innerHTML = SC_PS_TYPES.map((type) => {
    const active = scState.psTypes.has(type) ? ' is-active' : '';
    return `<button type="button" class="sc-type-chip${active}" data-sc-type="${scEscape(type)}" aria-pressed="${scState.psTypes.has(type) ? 'true' : 'false'}">${scEscape(type)}</button>`;
  }).join('');
}

function scHasActiveFilters() {
  if (scState.search.trim()) return true;
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
    row.customer_name,
    row.due_date,
    row.posted_date,
    row.proposed_edd,
    row.buyer,
    row.order_status,
    row.material,
    row.material_status,
    row.material_in_date,
    row.material_need_date,
  ]
    .map((v) => String(v || '').toLowerCase())
    .join(' ');
  return hay.includes(needle);
}

function scFilteredLines() {
  const needle = scState.search.trim().toLowerCase();
  return (scState.lines || []).filter((row) => {
    const type = scPsType(row);
    if (scState.psTypes.size && !scState.psTypes.has(type)) return false;
    return scMatchesSearch(row, needle);
  });
}

function scSortValue(row, col) {
  if (col === 'process_sheet_no') return scPsDisplay(row).toLowerCase();
  if (col === 'qty' || col === 'partial_qty') {
    const num = Number(row?.[col]);
    return Number.isFinite(num) ? num : SC_SORT_FALLBACK[col];
  }
  const raw = row?.[col];
  if (raw == null || raw === '') return SC_SORT_FALLBACK[col] ?? '';
  if (typeof raw === 'number') return raw;
  return String(raw).toLowerCase();
}

function scTypeRank(type) {
  const idx = SC_TYPE_ORDER.indexOf(String(type || '').toUpperCase());
  return idx >= 0 ? idx : SC_TYPE_ORDER.length;
}

function scSortedLines(lines) {
  const col = scState.sortCol || 'due_date';
  const dir = scState.sortDir === 'desc' ? -1 : 1;
  return [...lines].sort((a, b) => {
    const typeCmp = scTypeRank(scPsType(a)) - scTypeRank(scPsType(b));
    if (typeCmp) return typeCmp;
    const av = scSortValue(a, col);
    const bv = scSortValue(b, col);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return String(a.process_sheet_no || '').localeCompare(String(b.process_sheet_no || ''));
  });
}

function scRenderPartCell(row) {
  const part = String(row.part_no || '-');
  const badges = [];
  if (row.is_new_part) {
    badges.push('<span class="sc-new-badge" title="New part - no prior process sheet history">NEW</span>');
  }
  if (row.is_frame_agreement) {
    badges.push('<span class="sc-fa-badge" title="Frame agreement part">FA</span>');
  }
  return `<td class="sc-part-cell"><span class="sc-part-text">${scEscape(part)}</span>${badges.join('')}</td>`;
}

function scRenderDateCell(value) {
  const text = String(value || '').trim();
  if (!text) return '<td class="sc-date is-empty">-</td>';
  return `<td class="sc-date">${scEscape(scFormatDate(text))}</td>`;
}

function scExecutionLabel(code) {
  const c = String(code || '').trim().toUpperCase();
  if (c === 'I' || c === 'IN_PROCESS') return 'In Process';
  if (c === 'R' || c === 'READY_TO_START') return 'Ready to Start';
  if (c === 'P' || c === 'PENDING_SI') return 'Pending SI';
  if (c === 'C' || c === 'COMPLETED') return 'Completed';
  return c || '';
}

function scStatusPill(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return '';
  let cls = 'sc-status-pill';
  if (c === 'I') cls += ' sc-status-pill--o';
  else if (c === 'R') cls += ' sc-status-pill--r';
  return `<span class="${cls}" title="${scEscape(scExecutionLabel(c))}">${scEscape(c)}</span>`;
}

function scRenderOrderStatus(row) {
  const desc = String(row.current_stage_desc || '').trim();
  const status = String(row.current_stage_status || '').trim();
  const mode = String(row.erp_stage_mode || '').trim();
  const label = String(row.order_status || '').trim();
  let inner = '';
  if (desc || status) {
    inner = `${desc ? `<span class="sc-stage-desc">${scEscape(desc)}</span>` : ''}${scStatusPill(status)}`;
  } else if (mode === 'unassigned') {
    inner = '<span class="sc-stage-mode sc-stage-mode--unassigned">No WO</span>';
  } else if (mode === 'completed') {
    inner = '<span class="sc-stage-mode sc-stage-mode--completed">All complete</span>';
  } else if (label) {
    inner = scEscape(label);
  } else {
    inner = '-';
  }
  return `<td class="sc-stage-cell"><div class="sc-stage-stack">${inner}</div></td>`;
}

function scRenderMaterialStatus(row) {
  const status = String(row.material_status || '').trim();
  if (!status) return '<td><span class="sc-mtl-status sc-mtl-status--empty">-</span></td>';
  const key = status.toLowerCase();
  let cls = 'sc-mtl-status';
  if (key === 'arrived') cls += ' sc-mtl-status--arrived';
  else if (key === 'expected') cls += ' sc-mtl-status--expected';
  return `<td><span class="${cls}">${scEscape(status)}</span></td>`;
}

function scRenderBuyerCell(row) {
  const value = String(row.buyer || '');
  const ppNo = String(row.pp_voucher_no || '').trim();
  return `
    <td class="sc-buyer-cell">
      <input type="text"
        class="sc-buyer-input"
        data-pp-voucher-no="${scEscape(ppNo)}"
        data-last-saved="${scEscape(value)}"
        value="${scEscape(value)}"
        placeholder="Add buyer..."
        aria-label="Buyer"
        autocomplete="off">
    </td>`;
}

function scUpdateSortHeaders() {
  const { table } = scEls();
  if (!table) return;
  table.querySelectorAll('th[data-sort]').forEach((th) => {
    const col = th.getAttribute('data-sort');
    th.classList.remove('is-sorted-asc', 'is-sorted-desc');
    if (col === scState.sortCol) {
      th.classList.add(scState.sortDir === 'desc' ? 'is-sorted-desc' : 'is-sorted-asc');
      th.setAttribute('aria-sort', scState.sortDir === 'desc' ? 'descending' : 'ascending');
    } else {
      th.setAttribute('aria-sort', 'none');
    }
  });
}

function scSyncExportButton() {
  const { exportBtn, selectionMeta } = scEls();
  const count = scState.selected.size;
  if (exportBtn) {
    exportBtn.disabled = count === 0;
    exportBtn.textContent = count
      ? `Export Excel (${count})`
      : 'Export Excel';
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

function scRenderRow(row) {
  const id = scRowId(row);
  const checked = scState.selected.has(id);
  return `
    <tr class="${checked ? 'is-selected' : ''}" data-row-id="${scEscape(id)}" data-pp-voucher-no="${scEscape(row.pp_voucher_no || '')}">
      <td class="sc-check-col">
        <input type="checkbox" class="sc-row-check" data-row-id="${scEscape(id)}" aria-label="Select ${scEscape(scPsDisplay(row))}"${checked ? ' checked' : ''}>
      </td>
      <td class="sc-mono">${scEscape(scPsDisplay(row))}</td>
      <td class="sc-mono">${scEscape(row.sales_order_no || '-')}</td>
      <td class="sc-mono">${scEscape(row.customer_po_no || '-')}</td>
      ${scRenderPartCell(row)}
      <td>${scEscape(row.part_desc || '-')}</td>
      <td class="sc-num">${scEscape(scFormatQty(row.qty))}</td>
      <td class="sc-num">${scEscape(scFormatQty(row.partial_qty))}</td>
      ${scRenderDateCell(row.posted_date)}
      ${scRenderDateCell(row.due_date)}
      ${scRenderDateCell(row.material_need_date)}
      ${scRenderDateCell(row.material_in_date)}
      ${scRenderDateCell(row.proposed_edd)}
      ${scRenderBuyerCell(row)}
      ${scRenderOrderStatus(row)}
      <td class="sc-mono">${scEscape(row.material || '-')}</td>
      ${scRenderMaterialStatus(row)}
    </tr>`;
}

function scColCount() {
  const count = document.querySelectorAll('#sc-table thead th').length;
  return count || SC_COL_COUNT;
}

function scGroupHeader(type) {
  return `<tr class="sc-group-row"><td colspan="${scColCount()}">${scEscape(type || 'Other')}</td></tr>`;
}

function scRenderTable() {
  const { body, empty, panel, meta } = scEls();
  if (!body) return;

  const filtered = scSortedLines(scFilteredLines());
  scUpdateSortHeaders();
  scUpdateClearButton();

  if (panel) panel.hidden = false;
  if (meta) {
    const total = scState.lines.length;
    meta.textContent = `${filtered.length.toLocaleString()} of ${total.toLocaleString()} process sheet line${total === 1 ? '' : 's'}`;
  }

  if (!filtered.length) {
    body.innerHTML = '';
    if (empty) empty.hidden = false;
    scSyncSelectAll();
    scSyncExportButton();
    return;
  }
  if (empty) empty.hidden = true;

  const chunks = [];
  let lastType = null;
  for (const row of filtered) {
    const type = scPsType(row) || 'Other';
    if (type !== lastType) {
      chunks.push(scGroupHeader(type));
      lastType = type;
    }
    chunks.push(scRenderRow(row));
  }
  body.innerHTML = chunks.join('');
  scSyncSelectAll();
  scSyncExportButton();
}

function scOrderStatusExport(row) {
  const desc = String(row.current_stage_desc || '').trim();
  const status = String(row.current_stage_status || '').trim();
  const mode = String(row.erp_stage_mode || '').trim();
  const label = String(row.order_status || '').trim();
  if (desc || status) {
    return [desc, scExecutionLabel(status) || status].filter(Boolean).join(' ');
  }
  if (mode === 'unassigned') return 'No WO';
  if (mode === 'completed') return 'All complete';
  return label;
}

function scExportCellValue(row, colId) {
  if (colId === 'process_sheet_no') return scPsDisplay(row) === '-' ? '' : scPsDisplay(row);
  if (colId === 'qty' || colId === 'partial_qty') {
    const num = Number(row?.[colId]);
    return Number.isFinite(num) ? num : '';
  }
  if (
    colId === 'due_date'
    || colId === 'posted_date'
    || colId === 'proposed_edd'
    || colId === 'material_in_date'
    || colId === 'material_need_date'
  ) {
    const formatted = scFormatDate(row?.[colId]);
    return formatted === '-' ? '' : formatted;
  }
  if (colId === 'order_status') return scOrderStatusExport(row);
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

function scSyncBuyerInputs(ppNo, value) {
  const { body } = scEls();
  if (!body || !ppNo) return;
  const saved = String(value ?? '');
  body.querySelectorAll('.sc-buyer-input').forEach((input) => {
    if (String(input.dataset.ppVoucherNo || '') !== ppNo) return;
    input.value = saved;
    input.dataset.lastSaved = saved;
  });
  (scState.lines || []).forEach((row) => {
    if (String(row.pp_voucher_no || '') === ppNo) row.buyer = saved;
  });
}

async function scSaveBuyer(input) {
  const ppNo = String(input?.dataset?.ppVoucherNo || '').trim();
  if (!ppNo) return;
  const next = String(input.value || '').trim();
  const previous = String(input.dataset.lastSaved || '');
  if (next === previous) return;
  input.classList.remove('is-error', 'is-saved');
  input.classList.add('is-saving');
  input.disabled = true;
  try {
    const res = await fetch(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyer: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const saved = String(data.buyer ?? next);
    scSyncBuyerInputs(ppNo, saved);
    input.classList.add('is-saved');
    window.setTimeout(() => input.classList.remove('is-saved'), 1200);
  } catch (err) {
    input.value = previous;
    input.classList.add('is-error');
    scShowAlert(err.message || 'Could not save buyer.');
  } finally {
    input.classList.remove('is-saving');
    input.disabled = false;
  }
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
    if (!scState._typesInitialized) {
      scState._typesInitialized = true;
      scRenderTypeChips();
    }
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
    scRenderTypeChips();
    scRenderTable();
  });

  els.clearFilters?.addEventListener('click', () => {
    scState.search = '';
    if (els.search) els.search.value = '';
    scState.psTypes = new Set(SC_DEFAULT_PS_TYPES);
    scRenderTypeChips();
    scRenderTable();
  });

  els.refresh?.addEventListener('click', () => scLoad({ refresh: true }));
  els.exportBtn?.addEventListener('click', () => scExportSelected());

  els.selectAll?.addEventListener('change', (e) => {
    const checked = Boolean(e.target.checked);
    const visible = scSortedLines(scFilteredLines());
    visible.forEach((row) => {
      const id = scRowId(row);
      if (checked) scState.selected.add(id);
      else scState.selected.delete(id);
    });
    scRenderTable();
  });

  els.table?.querySelector('thead')?.addEventListener('click', (e) => {
    if (e.target.closest('.sc-check-col')) return;
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const col = th.getAttribute('data-sort');
    if (!col) return;
    if (scState.sortCol === col) {
      scState.sortDir = scState.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      scState.sortCol = col;
      scState.sortDir = 'asc';
    }
    scRenderTable();
  });

  els.body?.addEventListener('change', (e) => {
    const check = e.target.closest('.sc-row-check');
    if (check) {
      scSetRowSelected(check.getAttribute('data-row-id'), check.checked);
      return;
    }
    const input = e.target.closest('.sc-buyer-input');
    if (input) scSaveBuyer(input);
  });

  els.body?.addEventListener('keydown', (e) => {
    const input = e.target.closest('.sc-buyer-input');
    if (!input) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  scRenderTypeChips();
  scBindEvents();
  scLoad();
});
