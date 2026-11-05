/* Sales Coordination - APS/NPS segments, compressed commitment sheet */

const SC_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
const SC_LEAD_TYPES = ['APS', 'NPS'];
const SC_DEFAULT_PS_TYPES = ['APS', 'NPS'];
const SC_TYPE_ORDER = ['APS', 'NPS', 'MPS', 'PPS', 'CPS', 'SR'];
const SC_COL_COUNT = 12;

const scState = {
  lines: [],
  loading: false,
  search: '',
  psTypes: new Set(SC_DEFAULT_PS_TYPES),
  sortCol: 'due_date',
  sortDir: 'asc',
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
  { id: 'po_date', label: 'PO date', width: 14 },
  { id: 'customer_po_no', label: 'PO number', width: 18 },
  { id: 'line_item_no', label: 'Line item', width: 12 },
  { id: 'part_no', label: 'Inventory code', width: 20 },
  { id: 'part_desc', label: 'Inventory description', width: 36 },
  { id: 'due_date', label: 'PO due date', width: 14 },
  { id: 'order_qty', label: 'Order qty', width: 12 },
  { id: 'customer_remarks', label: 'Customer remarks', width: 28 },
  { id: 'coway_remarks', label: 'Coway remarks', width: 28 },
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
    row.line_item_no,
    row.customer_name,
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
    <td class="sc-grid-cell" data-sc-grid="${field}">
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

function scRenderRow(row) {
  const id = scRowId(row);
  const checked = scState.selected.has(id);
  const desc = String(row.part_desc || '');
  const line = String(row.line_item_no || '').trim();
  return `
    <tr class="${checked ? 'is-selected' : ''}" data-row-id="${scEscape(id)}" data-pp-voucher-no="${scEscape(row.pp_voucher_no || '')}">
      <td class="sc-check-col">
        <input type="checkbox" class="sc-row-check" data-row-id="${scEscape(id)}" aria-label="Select ${scEscape(scPsDisplay(row))}"${checked ? ' checked' : ''}>
      </td>
      <td class="sc-mono" title="${scEscape(scPsDisplay(row))}">${scEscape(scPsDisplay(row))}</td>
      ${scRenderDateCell(row.po_date)}
      <td class="sc-mono" title="${scEscape(row.customer_po_no || '')}">${scEscape(row.customer_po_no || '-')}</td>
      <td class="sc-line">${scEscape(line || '-')}</td>
      ${scRenderPartCell(row)}
      <td class="sc-desc" title="${scEscape(desc)}">${scEscape(desc || '-')}</td>
      ${scRenderDateCell(row.due_date)}
      <td class="sc-num">${scEscape(scFormatQty(row.order_qty))}</td>
      ${scRemarkInput(row, 'customer_remarks', 'Customer remarks')}
      ${scRemarkInput(row, 'coway_remarks', 'Coway remarks')}
      ${scCommitInput(row)}
    </tr>`;
}

function scColCount() {
  const count = document.querySelectorAll('#sc-table thead th').length;
  return count || SC_COL_COUNT;
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
  scUpdateSortHeaders();
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
}

function scExportCellValue(row, colId) {
  if (colId === 'process_sheet_no') return scPsDisplay(row) === '-' ? '' : scPsDisplay(row);
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
    scRenderTable();
  });

  els.refresh?.addEventListener('click', () => scLoad({ refresh: true }));
  els.exportBtn?.addEventListener('click', () => scExportSelected());

  els.selectAll?.addEventListener('change', (e) => {
    const checked = Boolean(e.target.checked);
    scSortedLines(scFilteredLines()).forEach((row) => {
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
  scRenderTypeChips();
  scBindEvents();
  scBindGrid();
  scLoad();
});
