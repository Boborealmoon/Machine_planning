// Monthly sales report — due-date backlog logic + YTD grid.

const SALES_REPORT_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
const SALES_REPORT_YTD_TYPES = ['APS', 'NPS', 'PPS'];

const salesReportState = {
  year: new Date().getFullYear(),
  focusMonth: null,
  data: null,
  ytdData: null,
  search: '',
  month: '',
  ppTypes: new Set(['APS', 'NPS']),
  loading: false,
  ytdCellSelection: new Set(),
};

function salesReportMonthValue(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function salesReportFocusMonthLabel() {
  if (!salesReportState.focusMonth) return '';
  return salesReportMonthLabel(salesReportMonthValue(salesReportState.year, salesReportState.focusMonth));
}

function salesReportSyncPeriodUI() {
  const hasMonth = Boolean(salesReportState.focusMonth);
  const searchWrap = document.getElementById('sales-report-search-wrap');
  const exportBtn = document.getElementById('sales-report-export');
  const monthPanel = document.getElementById('sales-report-month-panel');
  const overview = document.getElementById('sales-report-overview');
  if (searchWrap) searchWrap.hidden = !hasMonth;
  if (exportBtn) exportBtn.hidden = !hasMonth;
  if (monthPanel) monthPanel.hidden = !hasMonth;
  if (overview) overview.classList.toggle('is-compact', hasMonth);

  document.querySelectorAll('.sales-report-month-chip').forEach(btn => {
    const raw = btn.dataset.month;
    const monthNum = raw ? Number(raw) : null;
    const [curY, curM] = salesReportCurrentMonthValue().split('-').map(Number);
    const active = salesReportState.focusMonth
      ? monthNum === salesReportState.focusMonth
      : !raw;
    btn.classList.toggle('is-active', active);
    btn.classList.toggle('is-current', Boolean(monthNum) && monthNum === curM && salesReportState.year === curY);
    if (monthNum) {
      btn.disabled = hasMonth;
      btn.classList.toggle('is-disabled', hasMonth);
    }
  });

  const yearInput = document.getElementById('sales-report-year');
  if (yearInput) yearInput.value = String(salesReportState.year);
}

function salesReportRenderContext() {
  const el = document.getElementById('sales-report-context');
  if (!el) return;
  const segment = salesReportPsTypeLabel();
  if (salesReportState.focusMonth) {
    el.textContent = `${salesReportFocusMonthLabel()} · ${segment}`;
    return;
  }
  el.textContent = `${salesReportState.year} full year · ${segment}`;
}

function salesReportSetFocusMonth(month, options = {}) {
  const next = month ? Number(month) : null;
  if (next && (next < 1 || next > 12)) return;
  if (salesReportState.focusMonth === next) return;
  salesReportState.focusMonth = next;
  salesReportSyncPeriodUI();
  if (next) {
    salesReportState.month = salesReportMonthValue(salesReportState.year, next);
    const monthInput = document.getElementById('sales-report-month');
    if (monthInput) monthInput.value = salesReportState.month;
    const [y, mo] = salesReportState.month.split('-').map(Number);
    const needsLoad = !salesReportState.data
      || salesReportState.data.year !== y
      || salesReportState.data.month !== mo;
    if (needsLoad) {
      salesReportLoadMonthly({ scroll: options.scroll !== false });
      return;
    }
  }
  salesReportRender();
  if (next && options.scroll !== false) {
    document.getElementById('sales-report-month-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function salesReportClearFocusMonth() {
  salesReportState.focusMonth = null;
  salesReportState.search = '';
  const search = document.getElementById('sales-report-search');
  if (search) search.value = '';
  salesReportSyncPeriodUI();
  salesReportRender();
  document.getElementById('sales-report-overview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function salesReportFormatMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function salesReportFormatQty(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  if (Number.isInteger(num)) return String(num);
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function salesReportFormatDate(value) {
  const text = String(value || '').trim();
  if (!text) return '—';
  return text.slice(0, 10);
}

function salesReportFormatDt(value) {
  const text = String(value || '').trim();
  if (!text) return '—';
  return text.replace('T', ' ').slice(0, 19);
}

function salesReportCurrentYear() {
  return new Date().getFullYear();
}

function salesReportCurrentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function salesReportMonthLabel(monthValue) {
  const text = String(monthValue || '').trim();
  if (!/^\d{4}-\d{2}$/.test(text)) return text || '—';
  const [y, m] = text.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

function salesReportParseDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const d = new Date(`${text.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function salesReportMonthBounds(year, month) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  return { start, end };
}

function salesReportIsPastMonth(year, month) {
  const now = new Date();
  if (year < now.getFullYear()) return true;
  if (year > now.getFullYear()) return false;
  return month < now.getMonth() + 1;
}

function salesReportGetPsType(row) {
  if (row?.pp_type) return String(row.pp_type);
  const raw = String(row?.process_sheet_no || '').split('::')[0];
  if (/\[sr\]/i.test(raw)) return 'SR';
  const match = raw.toUpperCase().match(/^([A-Z]+)/);
  if (!match) return null;
  return match[1];
}

function salesReportOpenQty(row) {
  const alloc = Number(row?.allocated_remaining_qty);
  if (Number.isFinite(alloc)) return alloc;
  const rem = Number(row?.remaining_qty);
  return Number.isFinite(rem) ? rem : 0;
}

function salesReportOpenValue(row) {
  const alloc = Number(row?.allocated_remaining_value);
  if (Number.isFinite(alloc)) return alloc;
  const rem = Number(row?.remaining_value);
  return Number.isFinite(rem) ? rem : 0;
}

function salesReportPpTypesAllSelected() {
  return salesReportState.ppTypes.size >= SALES_REPORT_PS_TYPES.length;
}

function salesReportPsTypeLabel() {
  const panel = document.getElementById('sales-report-ps-type-panel');
  if (!panel) return 'APS, NPS';
  const checked = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value);
  if (!checked.length) return 'None';
  if (checked.length >= SALES_REPORT_PS_TYPES.length) return 'All types';
  return checked.map(v => (v === 'SR' ? '[SR]' : v)).join(', ');
}

function salesReportSyncPsTypeCheckboxes() {
  const panel = document.getElementById('sales-report-ps-type-panel');
  if (!panel) return;
  panel.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.checked = salesReportState.ppTypes.has(input.value);
  });
  const btn = document.getElementById('sales-report-ps-type-btn');
  if (btn) btn.textContent = `${salesReportPsTypeLabel()} ▾`;
}

function salesReportPassesPsFilter(row) {
  if (salesReportPpTypesAllSelected()) return true;
  if (!salesReportState.ppTypes.size) return false;
  const psType = salesReportGetPsType(row);
  if (!psType) return false;
  return salesReportState.ppTypes.has(psType);
}

function salesReportActivePpTypes() {
  if (salesReportPpTypesAllSelected()) return [...SALES_REPORT_PS_TYPES];
  return SALES_REPORT_PS_TYPES.filter(type => salesReportState.ppTypes.has(type));
}

function salesReportTypeTagHtml(type, count) {
  const key = String(type || 'other').toLowerCase();
  const label = type === 'SR' ? '[SR]' : (type || '—');
  const text = count != null ? `${label} · ${count} lines` : label;
  return `<span class="so-type-tag so-type-tag--${escapeHtml(key)}">${escapeHtml(text)}</span>`;
}

function salesReportSumField(rows, field) {
  return (rows || []).reduce((sum, row) => {
    const num = Number(row?.[field]);
    return sum + (Number.isFinite(num) ? num : 0);
  }, 0);
}

function salesReportFilterBySearch(rows) {
  const q = String(salesReportState.search || '').trim().toLowerCase();
  if (!q) return rows || [];
  return (rows || []).filter(row => salesReportSearchHaystack(row).includes(q));
}

function salesReportFilteredSection(rows) {
  return salesReportFilterBySearch((rows || []).filter(salesReportPassesPsFilter));
}

function salesReportSearchHaystack(row) {
  return [
    row.sales_order_no, row.line_item_no, row.process_sheet_no, row.inventory_code,
    row.description, row.customer_code, row.customer_name, row.sales_person_name,
    row.sbu_desc, row.shipment_voucher_no, row.invoice_no,
  ].map(v => String(v || '').toLowerCase()).join(' ');
}

function salesReportNoPsTypesSelected() {
  return !salesReportPpTypesAllSelected() && salesReportState.ppTypes.size === 0;
}

function salesReportDueInMonth(row, start, end) {
  const due = salesReportParseDate(row?.due_date);
  if (!due) return false;
  return due >= start && due <= end;
}

function salesReportDueBeforeMonth(row, start) {
  const due = salesReportParseDate(row?.due_date);
  if (!due) return false;
  return due < start;
}

function salesReportDueAfterMonth(row, end) {
  const due = salesReportParseDate(row?.due_date);
  if (!due) return false;
  return due > end;
}

function salesReportShipmentBucketDue(row) {
  return salesReportParseDate(row?.so_due_date) || salesReportParseDate(row?.due_date);
}

function salesReportShipmentDueInMonth(row, start, end) {
  const due = salesReportShipmentBucketDue(row);
  if (!due) return false;
  return due >= start && due <= end;
}

function salesReportShipmentDueBeforeMonth(row, start) {
  const due = salesReportShipmentBucketDue(row);
  if (!due) return false;
  return due < start;
}

function salesReportShipmentDueAfterMonth(row, end) {
  const due = salesReportShipmentBucketDue(row);
  if (!due) return false;
  return due > end;
}

function salesReportOutstandingRest(row, start, end) {
  const due = salesReportParseDate(row?.due_date);
  if (!due) return true;
  return due > end;
}

function salesReportShipmentInMonth(row, start, end) {
  const ship = salesReportParseDate(row?.shipment_date || row?.shipment_datetime);
  if (!ship) return false;
  return ship >= start && ship <= end;
}

function salesReportBuildOpenMonthSummary(openLines, start, end) {
  const dueLines = openLines.filter(row => salesReportDueInMonth(row, start, end));
  const overdueLines = openLines.filter(row => salesReportDueBeforeMonth(row, start));
  const restLines = openLines.filter(row => salesReportOutstandingRest(row, start, end));
  const dueSummary = {
    line_count: dueLines.length,
    remaining_qty: dueLines.reduce((sum, row) => sum + salesReportOpenQty(row), 0),
    remaining_value: dueLines.reduce((sum, row) => sum + salesReportOpenValue(row), 0),
  };
  const overdueSummary = {
    line_count: overdueLines.length,
    remaining_qty: overdueLines.reduce((sum, row) => sum + salesReportOpenQty(row), 0),
    remaining_value: overdueLines.reduce((sum, row) => sum + salesReportOpenValue(row), 0),
  };
  const restSummary = {
    line_count: restLines.length,
    remaining_qty: restLines.reduce((sum, row) => sum + salesReportOpenQty(row), 0),
    remaining_value: restLines.reduce((sum, row) => sum + salesReportOpenValue(row), 0),
  };
  return {
    mode: 'open',
    due_this_month: dueSummary,
    overdue: overdueSummary,
    outstanding_rest: restSummary,
    on_hand: dueSummary,
    backlog: overdueSummary,
    on_hand_lines: dueLines,
    backlog_lines: overdueLines,
    outstanding_rest_lines: restLines,
  };
}

function salesReportYtdMonthColspan(meta) {
  if (meta.mode === 'past') return 3;
  if (meta.is_current) return 2;
  return 1;
}

function salesReportYtdMonthHeaderClass(meta, idx, firstFutureIdx) {
  return [
    'sales-report-ytd-month-cell',
    meta.is_current ? 'is-current' : '',
    meta.mode === 'past' ? 'is-past' : (meta.is_current ? 'is-open-current' : 'is-future'),
    idx === firstFutureIdx ? 'is-future-start' : '',
    salesReportState.focusMonth === meta.month ? 'is-selected' : '',
  ].filter(Boolean).join(' ');
}

function salesReportYtdMonthButtonClass(meta) {
  return [
    'sales-report-ytd-month-btn',
    meta.is_current ? 'is-current' : '',
    meta.mode === 'past' ? 'is-past' : (meta.is_current ? 'is-open-current' : 'is-future'),
  ].filter(Boolean).join(' ');
}

function salesReportScrollToYtdMonth(month) {
  const btn = document.querySelector(`#sales-report-ytd-table .sales-report-ytd-month-btn[data-ytd-month="${month}"]`);
  const scroll = document.querySelector('.sales-report-ytd-scroll');
  if (!btn || !scroll) return;
  const th = btn.closest('th');
  btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  th?.classList.add('is-scroll-flash');
  window.setTimeout(() => th?.classList.remove('is-scroll-flash'), 1400);
}

function salesReportYtdSubheadCells(meta) {
  if (meta.mode === 'past') {
    return [
      { label: 'Backlog', cls: 'is-shipped-backlog' },
      { label: 'On-time', cls: 'is-shipped-ontime' },
      { label: 'Early', cls: 'is-shipped-early' },
    ];
  }
  if (meta.is_current) {
    return [
      { label: 'Backlog', cls: 'is-overdue' },
      { label: 'Onhand', cls: 'is-due' },
    ];
  }
  return [{ label: 'Onhand', cls: 'is-due' }];
}

function salesReportYtdCellKey(rowId, month, colKey) {
  return `${rowId}|${month}|${colKey}`;
}

function salesReportYtdNumTd(value, rowId, month, colKey, extraCls = '') {
  const num = Number(value);
  const safeNum = Number.isFinite(num) ? num : 0;
  const key = salesReportYtdCellKey(rowId, month, colKey);
  const selected = salesReportState.ytdCellSelection.has(key);
  const cls = [
    'sales-report-ytd-num',
    'sales-report-ytd-num--selectable',
    extraCls,
    selected ? 'is-selected' : '',
  ].filter(Boolean).join(' ');
  return `<td class="${cls}" data-ytd-row="${escapeHtml(rowId)}" data-ytd-month="${month}" data-ytd-col="${escapeHtml(colKey)}" data-ytd-value="${safeNum}" tabindex="0" role="gridcell" aria-selected="${selected ? 'true' : 'false'}" title="Click to add to sum">${salesReportFormatMoney(safeNum)}</td>`;
}

function salesReportYtdCellHtml(cell, meta, rowId) {
  if (meta.mode === 'past') {
    return [
      salesReportYtdNumTd(cell.backlog_delivered, rowId, meta.month, 'backlog_delivered'),
      salesReportYtdNumTd(cell.delivered, rowId, meta.month, 'delivered'),
      salesReportYtdNumTd(cell.early_delivered, rowId, meta.month, 'early_delivered'),
    ].join('');
  }
  if (meta.is_current) {
    const backlog = cell.backlog ?? cell.overdue ?? 0;
    const onHand = cell.on_hand ?? cell.due_this_month ?? 0;
    return [
      salesReportYtdNumTd(backlog, rowId, meta.month, 'backlog', 'sales-report-ytd-num--overdue'),
      salesReportYtdNumTd(onHand, rowId, meta.month, 'on_hand', 'sales-report-ytd-num--due'),
    ].join('');
  }
  const due = cell.due_this_month ?? cell.on_hand ?? 0;
  return salesReportYtdNumTd(due, rowId, meta.month, 'due_this_month', 'sales-report-ytd-num--due');
}

function salesReportPruneYtdSelection(validKeys) {
  salesReportState.ytdCellSelection.forEach(key => {
    if (!validKeys.has(key)) salesReportState.ytdCellSelection.delete(key);
  });
}

function salesReportToggleYtdCell(td) {
  const rowId = td.dataset.ytdRow;
  const month = Number(td.dataset.ytdMonth);
  const colKey = td.dataset.ytdCol;
  if (!rowId || !colKey || !Number.isFinite(month)) return;
  const key = salesReportYtdCellKey(rowId, month, colKey);
  const selected = salesReportState.ytdCellSelection.has(key);
  if (selected) {
    salesReportState.ytdCellSelection.delete(key);
    td.classList.remove('is-selected');
    td.setAttribute('aria-selected', 'false');
  } else {
    salesReportState.ytdCellSelection.add(key);
    td.classList.add('is-selected');
    td.setAttribute('aria-selected', 'true');
  }
  salesReportRenderYtdAggregate();
}

function salesReportClearYtdSelection() {
  if (!salesReportState.ytdCellSelection.size) return;
  salesReportState.ytdCellSelection.clear();
  document.querySelectorAll('#sales-report-ytd-table td.is-selected').forEach(td => {
    td.classList.remove('is-selected');
    td.setAttribute('aria-selected', 'false');
  });
  salesReportRenderYtdAggregate();
}

function salesReportRenderYtdAggregate() {
  const el = document.getElementById('sales-report-ytd-aggregate');
  const row = document.getElementById('sales-report-ytd-aggregate-row');
  if (!el) return;

  const table = document.getElementById('sales-report-ytd-table');
  const selected = table
    ? [...table.querySelectorAll('td.sales-report-ytd-num--selectable.is-selected')]
    : [];
  if (!selected.length) {
    el.hidden = true;
    el.innerHTML = '';
    if (row) row.hidden = true;
    return;
  }

  const values = selected.map(td => Number(td.dataset.ytdValue)).filter(Number.isFinite);
  const count = values.length;
  const sum = values.reduce((total, n) => total + n, 0);
  const avg = count ? sum / count : 0;

  el.innerHTML = `
    <div class="sales-report-ytd-aggregate-inner">
      <span class="sales-report-ytd-aggregate-pill sales-report-ytd-aggregate-pill--count">
        <span class="sales-report-ytd-aggregate-label">Selected</span>
        <strong>${count}</strong>
        <span class="sales-report-ytd-aggregate-unit">${count === 1 ? 'cell' : 'cells'}</span>
      </span>
      <span class="sales-report-ytd-aggregate-pill sales-report-ytd-aggregate-pill--sum">
        <span class="sales-report-ytd-aggregate-label">Sum</span>
        <strong>${salesReportFormatMoney(sum)}</strong>
      </span>
      <span class="sales-report-ytd-aggregate-pill sales-report-ytd-aggregate-pill--avg">
        <span class="sales-report-ytd-aggregate-label">Average</span>
        <strong>${salesReportFormatMoney(avg)}</strong>
      </span>
      <button type="button" class="sales-report-ytd-aggregate-clear btn btn-ghost btn-sm">Clear sum</button>
    </div>`;
  el.hidden = false;
  if (row) row.hidden = false;
  el.querySelector('.sales-report-ytd-aggregate-clear')?.addEventListener('click', salesReportClearYtdSelection);
}

function salesReportBindYtdMonthHeaders(table) {
  if (!table || table.dataset.ytdMonthBound) return;
  table.dataset.ytdMonthBound = '1';
  table.addEventListener('click', (e) => {
    const btn = e.target.closest('.sales-report-ytd-month-btn[data-ytd-month]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    salesReportSetFocusMonth(btn.dataset.ytdMonth);
  });
}

function salesReportBindYtdCellSelection(table) {
  if (!table || table.dataset.ytdSelectBound) return;
  table.dataset.ytdSelectBound = '1';
  table.addEventListener('click', (e) => {
    const td = e.target.closest('td.sales-report-ytd-num--selectable');
    if (!td) return;
    if (e.target.closest('.sales-report-ytd-month-btn')) return;
    e.preventDefault();
    e.stopPropagation();
    salesReportToggleYtdCell(td);
  });
  table.addEventListener('keydown', (e) => {
    const td = e.target.closest('td.sales-report-ytd-num--selectable');
    if (!td) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      salesReportToggleYtdCell(td);
    }
  });
}

function salesReportBuildPastMonthSummary(shipments, start, end) {
  const monthShipments = shipments.filter(row => salesReportShipmentInMonth(row, start, end));
  const delivered = monthShipments.filter(row => salesReportShipmentDueInMonth(row, start, end));
  const backlogDelivered = monthShipments.filter(row => salesReportShipmentDueBeforeMonth(row, start));
  const earlyDelivered = monthShipments.filter(row => salesReportShipmentDueAfterMonth(row, end));
  return {
    mode: 'past',
    delivered: {
      line_count: delivered.length,
      qty_issued: salesReportSumField(delivered, 'qty_issued'),
      total_home_amt: salesReportSumField(delivered, 'total_home_amt'),
    },
    backlog_delivered: {
      line_count: backlogDelivered.length,
      qty_issued: salesReportSumField(backlogDelivered, 'qty_issued'),
      total_home_amt: salesReportSumField(backlogDelivered, 'total_home_amt'),
    },
    early_delivered: {
      line_count: earlyDelivered.length,
      qty_issued: salesReportSumField(earlyDelivered, 'qty_issued'),
      total_home_amt: salesReportSumField(earlyDelivered, 'total_home_amt'),
    },
    delivered_lines: delivered,
    backlog_delivered_lines: backlogDelivered,
    early_delivered_lines: earlyDelivered,
  };
}

function salesReportBuildYtdGrid(openLines, shipments, year) {
  const now = new Date();
  const monthsMeta = [];
  for (let month = 1; month <= 12; month += 1) {
    const { start, end } = salesReportMonthBounds(year, month);
    const mode = salesReportIsPastMonth(year, month) ? 'past' : 'open';
    monthsMeta.push({
      month,
      label: new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' }).replace(' ', '-'),
      mode,
      open_kind: mode === 'open' ? (year === now.getFullYear() && month === now.getMonth() + 1 ? 'current' : 'future') : null,
      is_current: year === now.getFullYear() && month === now.getMonth() + 1,
      start,
      end,
    });
  }

  const cellsForType = (ppType) => {
    const typeOpen = openLines.filter(row => !ppType || salesReportGetPsType(row) === ppType);
    const typeShipments = shipments.filter(row => !ppType || salesReportGetPsType(row) === ppType);
    const cells = monthsMeta.map(meta => {
      if (meta.mode === 'past') {
        const past = salesReportBuildPastMonthSummary(typeShipments, meta.start, meta.end);
        return {
          month: meta.month,
          mode: 'past',
          backlog_delivered: past.backlog_delivered.total_home_amt,
          delivered: past.delivered.total_home_amt,
          early_delivered: past.early_delivered.total_home_amt,
        };
      }
      const open = salesReportBuildOpenMonthSummary(typeOpen, meta.start, meta.end);
      const dueVal = open.due_this_month.remaining_value;
      if (meta.is_current) {
        return {
          month: meta.month,
          mode: 'open',
          open_kind: 'current',
          backlog: open.backlog.remaining_value,
          on_hand: dueVal,
        };
      }
      return {
        month: meta.month,
        mode: 'open',
        open_kind: 'future',
        due_this_month: dueVal,
      };
    });
    return cells;
  };

  const sumCells = (cellLists) => monthsMeta.map((meta, idx) => {
    if (meta.mode === 'past') {
      return {
        month: meta.month,
        mode: 'past',
        backlog_delivered: cellLists.reduce((sum, list) => sum + Number(list[idx]?.backlog_delivered || 0), 0),
        delivered: cellLists.reduce((sum, list) => sum + Number(list[idx]?.delivered || 0), 0),
        early_delivered: cellLists.reduce((sum, list) => sum + Number(list[idx]?.early_delivered || 0), 0),
      };
    }
    return {
      month: meta.month,
      mode: 'open',
      open_kind: meta.is_current ? 'current' : 'future',
      ...(meta.is_current
        ? {
          backlog: cellLists.reduce((sum, list) => sum + Number(list[idx]?.backlog || 0), 0),
          on_hand: cellLists.reduce((sum, list) => sum + Number(list[idx]?.on_hand || 0), 0),
        }
        : {
          due_this_month: cellLists.reduce((sum, list) => sum + Number(list[idx]?.due_this_month || 0), 0),
        }),
    };
  });

  const rowCells = {};
  SALES_REPORT_YTD_TYPES.forEach(type => {
    rowCells[type] = cellsForType(type);
  });

  const rows = SALES_REPORT_YTD_TYPES.map(type => ({
    id: type,
    label: type,
    cells: rowCells[type],
  }));

  const activeTypes = salesReportActivePpTypes().filter(type => SALES_REPORT_YTD_TYPES.includes(type));
  const activeCellLists = activeTypes.map(type => rowCells[type]);

  if (activeCellLists.length) {
    rows.push({
      id: 'TOTAL',
      label: 'Total (selected)',
      cells: sumCells(activeCellLists),
      emphasis: 'total',
    });
  }

  return {
    year,
    current_month: year === now.getFullYear() ? now.getMonth() + 1 : (year < now.getFullYear() ? 12 : 1),
    months: monthsMeta,
    rows: rows.filter(row => {
      if (row.id === 'TOTAL') return true;
      return activeTypes.includes(row.id);
    }),
  };
}

function salesReportFilteredPayload() {
  const data = salesReportState.data;
  if (!data) return null;

  const openSource = data.allocated_open_lines || data.open_lines || data.backlog || [];
  const shipSource = data.shipments_attributed || data.shipped || [];
  const openLines = salesReportFilteredSection(openSource);
  const shipped = salesReportFilteredSection(shipSource);
  const booked = salesReportFilteredSection(data.booked || []);
  const summary = data.summary || {};
  const mode = summary.mode || (salesReportIsPastMonth(data.year, data.month) ? 'past' : 'open');

  let backlogRows = [];
  let onHandRows = [];
  let earlyRows = [];
  if (mode === 'past') {
    backlogRows = salesReportFilteredSection(summary.backlog_delivered_lines || []);
    onHandRows = salesReportFilteredSection(summary.delivered_lines || []);
    earlyRows = salesReportFilteredSection(summary.early_delivered_lines || data.early_delivered || []);
  } else {
    backlogRows = salesReportFilteredSection(summary.backlog_lines || data.backlog || []);
    onHandRows = salesReportFilteredSection(summary.on_hand_lines || data.on_hand || []);
  }

  const breakdown = salesReportActivePpTypes().map(type => ({
    type,
    summary: (() => {
      const b = salesReportRowsForType(backlogRows, type);
      const o = salesReportRowsForType(onHandRows, type);
      const e = salesReportRowsForType(earlyRows, type);
      const s = salesReportRowsForType(shipped, type);
      if (mode === 'past') {
        return {
          mode,
          backlog_delivered: { line_count: b.length, total_home_amt: salesReportSumField(b, 'total_home_amt') },
          delivered: { line_count: o.length, total_home_amt: salesReportSumField(o, 'total_home_amt') },
          early_delivered: { line_count: e.length, total_home_amt: salesReportSumField(e, 'total_home_amt') },
          shipped: { line_count: s.length, total_home_amt: salesReportSumField(s, 'total_home_amt') },
        };
      }
      const bk = salesReportRowsForType(booked, type);
      return {
        mode,
        backlog: { line_count: b.length, remaining_value: b.reduce((s, r) => s + salesReportOpenValue(r), 0) },
        on_hand: { line_count: o.length, remaining_value: o.reduce((s, r) => s + salesReportOpenValue(r), 0) },
        shipped: { line_count: s.length, total_home_amt: salesReportSumField(s, 'total_home_amt') },
        booked: { line_count: bk.length, line_amount: salesReportSumField(bk, 'line_amount') },
      };
    })(),
  }));

  const filteredSummary = (() => {
    if (mode === 'past') {
      return {
        mode,
        delivered: {
          line_count: onHandRows.length,
          total_home_amt: salesReportSumField(onHandRows, 'total_home_amt'),
        },
        backlog_delivered: {
          line_count: backlogRows.length,
          total_home_amt: salesReportSumField(backlogRows, 'total_home_amt'),
        },
        early_delivered: {
          line_count: earlyRows.length,
          total_home_amt: salesReportSumField(earlyRows, 'total_home_amt'),
        },
        shipped: {
          line_count: shipped.length,
          total_home_amt: salesReportSumField(shipped, 'total_home_amt'),
        },
      };
    }
    return {
      mode,
      on_hand: {
        line_count: onHandRows.length,
        remaining_qty: onHandRows.reduce((s, r) => s + salesReportOpenQty(r), 0),
        remaining_value: onHandRows.reduce((s, r) => s + salesReportOpenValue(r), 0),
      },
      backlog: {
        line_count: backlogRows.length,
        remaining_qty: backlogRows.reduce((s, r) => s + salesReportOpenQty(r), 0),
        remaining_value: backlogRows.reduce((s, r) => s + salesReportOpenValue(r), 0),
      },
      booked: {
        line_count: booked.length,
        line_amount: salesReportSumField(booked, 'line_amount'),
      },
      shipped: {
        line_count: shipped.length,
        total_home_amt: salesReportSumField(shipped, 'total_home_amt'),
      },
    };
  })();

  return {
    ...data,
    summary: filteredSummary,
    breakdown,
    backlog: backlogRows,
    on_hand: onHandRows,
    early_delivered: earlyRows,
    shipped,
    booked,
  };
}

function salesReportRowsForType(rows, type) {
  return (rows || []).filter(row => salesReportGetPsType(row) === type);
}

function salesReportRenderIntegrity(integrity) {
  const el = document.getElementById('sales-report-integrity');
  if (!el || !integrity) {
    if (el) el.hidden = true;
    return;
  }
  const ok = Boolean(integrity.ok);
  const gap = Number(integrity.remaining_allocation_gap || 0);
  const dedupSavings = Number(integrity.shipment_dedup_savings || 0);
  const rawRows = integrity.shipment_rows_raw;
  const dedupRows = integrity.shipment_rows_deduped;
  el.className = `sales-report-integrity card ${ok ? 'is-ok' : 'is-warn'}`;
  el.hidden = false;
  el.innerHTML = `
    <div class="sales-report-integrity-head">
      <strong>${ok ? 'Reconciliation OK' : 'Reconciliation check'}</strong>
      <span class="sales-report-integrity-badge">${ok ? 'Balanced' : 'Review'}</span>
    </div>
    <p class="sales-report-integrity-body">
      Open $ uses one SO-line total split across process sheets by quantity — never duplicated per PS.
      Shipped $ uses deduped DO/invoice lines (${dedupRows} rows${rawRows !== dedupRows ? `, ${rawRows - dedupRows} join duplicates removed` : ''}).
      All grid and breakdown amounts are <strong>home currency</strong> (foreign unit × exch rate, or ERP pre_tax_extended_home_amt).
      ${!ok ? `Allocation gap ${salesReportFormatMoney(gap)} · shipment dedup delta ${salesReportFormatMoney(dedupSavings)}.` : ''}
    </p>
    <dl class="sales-report-integrity-metrics">
      <div><dt>SO remaining (authoritative)</dt><dd>${salesReportFormatMoney(integrity.so_line_remaining_total)}</dd></div>
      <div><dt>PP-allocated remaining</dt><dd>${salesReportFormatMoney(integrity.pp_allocated_remaining_total)}</dd></div>
      <div><dt>Shipped (deduped)</dt><dd>${salesReportFormatMoney(integrity.shipment_amt_deduped)}</dd></div>
    </dl>`;
}

function salesReportSetLoadingContext(message) {
  const el = document.getElementById('sales-report-context');
  if (el) el.textContent = message || 'Loading…';
}

function salesReportBeginLoad(message, options = {}) {
  salesReportState.loading = true;
  const monthOnly = Boolean(options.monthOnly ?? (salesReportState.focusMonth && salesReportState.ytdData));
  const overview = document.getElementById('sales-report-overview');
  const monthPanel = document.getElementById('sales-report-month-panel');
  const overviewOverlay = document.getElementById('sales-report-overview-loading');
  const monthOverlay = document.getElementById('sales-report-month-loading');
  const overviewText = document.getElementById('sales-report-overview-loading-text');
  const monthText = document.getElementById('sales-report-month-loading-text');
  const integrity = document.getElementById('sales-report-integrity');
  const empty = document.getElementById('sales-report-empty');
  const meta = document.getElementById('sales-report-meta');
  const pageLoading = document.getElementById('sales-report-loading');
  const pageText = document.getElementById('sales-report-loading-text');
  const label = message || 'Loading report…';

  salesReportSetLoadingContext(label);

  if (pageLoading) pageLoading.hidden = true;
  if (overviewOverlay) overviewOverlay.hidden = true;
  if (monthOverlay) monthOverlay.hidden = true;
  overview?.classList.remove('is-loading');
  monthPanel?.classList.remove('is-loading');

  if (monthOnly) {
    if (monthPanel) monthPanel.hidden = false;
    if (monthOverlay) monthOverlay.hidden = false;
    if (monthText) monthText.textContent = label;
    monthPanel?.classList.add('is-loading');
    salesReportSyncPeriodUI();
    return;
  }

  if (overview) overview.hidden = false;
  if (overviewOverlay) overviewOverlay.hidden = false;
  if (overviewText) overviewText.textContent = label;
  overview?.classList.add('is-loading');
  if (integrity) integrity.hidden = true;
  if (empty) empty.hidden = true;
  if (meta) meta.hidden = true;
}

function salesReportEndLoad() {
  salesReportState.loading = false;
  const overview = document.getElementById('sales-report-overview');
  const monthPanel = document.getElementById('sales-report-month-panel');
  const overviewOverlay = document.getElementById('sales-report-overview-loading');
  const monthOverlay = document.getElementById('sales-report-month-loading');
  const pageLoading = document.getElementById('sales-report-loading');

  overview?.classList.remove('is-loading');
  monthPanel?.classList.remove('is-loading');
  if (overviewOverlay) overviewOverlay.hidden = true;
  if (monthOverlay) monthOverlay.hidden = true;
  if (pageLoading) pageLoading.hidden = true;
}

function salesReportRenderStats(summary) {
  const el = document.getElementById('sales-report-stats');
  if (!el || !summary) return;
  const parts = [`<span class="new-orders-stat sales-report-stat-pill">${escapeHtml(salesReportPsTypeLabel())}</span>`];
  if (summary.mode === 'past') {
    parts.push(`<span class="new-orders-stat">Delivered <strong>${salesReportFormatMoney(summary.delivered?.total_home_amt)}</strong></span>`);
    parts.push(`<span class="new-orders-stat">Backlog del. <strong>${salesReportFormatMoney(summary.backlog_delivered?.total_home_amt)}</strong></span>`);
    parts.push(`<span class="new-orders-stat">Early <strong>${salesReportFormatMoney(summary.early_delivered?.total_home_amt)}</strong></span>`);
    parts.push(`<span class="new-orders-stat">All shipped <strong>${salesReportFormatMoney(summary.shipped?.total_home_amt)}</strong></span>`);
  } else {
    parts.push(`<span class="new-orders-stat">Backlog <strong>${salesReportFormatMoney(summary.backlog?.remaining_value)}</strong></span>`);
    parts.push(`<span class="new-orders-stat">Onhand <strong>${salesReportFormatMoney(summary.on_hand?.remaining_value)}</strong></span>`);
    parts.push(`<span class="new-orders-stat">Booked <strong>${salesReportFormatMoney(summary.booked?.line_amount)}</strong></span>`);
  }
  el.innerHTML = parts.join('');
}

function salesReportRenderSummary(summary) {
  const el = document.getElementById('sales-report-summary');
  if (!el || !summary) return;

  const cards = summary.mode === 'past'
    ? [
      { title: 'Delivered (on time)', tone: 'shipped', value: summary.delivered?.total_home_amt, sub: `${summary.delivered?.line_count || 0} shipment lines`, hint: 'Shipped in month · original PO due date also in this month' },
      { title: 'Backlog delivered', tone: 'cleared', value: summary.backlog_delivered?.total_home_amt, sub: `${summary.backlog_delivered?.line_count || 0} shipment lines`, hint: 'Shipped in month · original PO due was before month start' },
      { title: 'Early delivered', tone: 'early', value: summary.early_delivered?.total_home_amt, sub: `${summary.early_delivered?.line_count || 0} shipment lines`, hint: 'Shipped in month · original PO due after month end' },
      { title: 'All shipments', tone: 'booked', value: summary.shipped?.total_home_amt, sub: `${summary.shipped?.line_count || 0} lines`, hint: 'On-time + backlog + early (every DO dated in month)' },
    ]
    : (() => {
      const openCards = [
        { title: 'Backlog', tone: 'cleared', value: summary.backlog?.remaining_value, sub: `${salesReportFormatQty(summary.backlog?.remaining_qty)} pcs · ${summary.backlog?.line_count || 0} lines`, hint: 'Still open · PO due before this month' },
        { title: 'Onhand', tone: 'on-hand', value: summary.on_hand?.remaining_value, sub: `${salesReportFormatQty(summary.on_hand?.remaining_qty)} pcs · ${summary.on_hand?.line_count || 0} lines`, hint: 'Unfinished open $ · PO due this month' },
      ];
      openCards.push(
        { title: 'Shipped this month', tone: 'shipped', value: summary.shipped?.total_home_amt, sub: `${summary.shipped?.line_count || 0} lines`, hint: 'DO/shipment dated in month' },
        { title: 'Booked this month', tone: 'booked', value: summary.booked?.line_amount, sub: `${summary.booked?.line_count || 0} lines`, hint: 'First-posted in month' },
      );
      return openCards;
    })();

  el.innerHTML = cards.map(card => `
    <article class="sales-report-kpi sales-report-kpi--${card.tone}">
      <p class="sales-report-kpi-label">${escapeHtml(card.title)}</p>
      <p class="sales-report-kpi-value">${salesReportFormatMoney(card.value)}</p>
      <p class="sales-report-kpi-sub">${escapeHtml(card.sub)}</p>
      <p class="sales-report-kpi-hint">${escapeHtml(card.hint)}</p>
    </article>
  `).join('');
}

function salesReportRenderBreakdown(breakdown, summary) {
  const el = document.getElementById('sales-report-breakdown');
  if (!el) return;
  const mode = summary?.mode || 'open';
  const headers = mode === 'past'
    ? ['PP type', 'Backlog del. $', 'On-time $', 'Early $', 'All shipped $']
    : ['PP type', 'Backlog $', 'Onhand $', 'Shipped $', 'Booked $'];

  const rows = (breakdown || []).filter(entry => {
    const s = entry.summary || {};
    if (mode === 'past') {
      return (s.backlog_delivered?.line_count || 0) + (s.delivered?.line_count || 0)
        + (s.early_delivered?.line_count || 0) + (s.shipped?.line_count || 0) > 0;
    }
    return (s.on_hand?.line_count || 0) + (s.backlog?.line_count || 0) + (s.shipped?.line_count || 0) > 0;
  }).map(entry => {
    const s = entry.summary || {};
    if (mode === 'past') {
      return `<tr>
        <td>${salesReportTypeTagHtml(entry.type)}</td>
        <td class="sales-report-breakdown-num">${salesReportFormatMoney(s.backlog_delivered?.total_home_amt)}</td>
        <td class="sales-report-breakdown-num">${salesReportFormatMoney(s.delivered?.total_home_amt)}</td>
        <td class="sales-report-breakdown-num">${salesReportFormatMoney(s.early_delivered?.total_home_amt)}</td>
        <td class="sales-report-breakdown-num">${salesReportFormatMoney(s.shipped?.total_home_amt)}</td>
      </tr>`;
    }
    return `<tr>
      <td>${salesReportTypeTagHtml(entry.type)}</td>
      <td class="sales-report-breakdown-num">${salesReportFormatMoney(s.backlog?.remaining_value)}</td>
      <td class="sales-report-breakdown-num">${salesReportFormatMoney(s.on_hand?.remaining_value)}</td>
      <td class="sales-report-breakdown-num">${salesReportFormatMoney(s.shipped?.total_home_amt)}</td>
      <td class="sales-report-breakdown-num">${salesReportFormatMoney(s.booked?.line_amount)}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="sales-report-breakdown-head">
      <h2 class="sales-report-breakdown-title">Breakdown by PP type</h2>
      <p class="sales-report-breakdown-sub">${mode === 'past' ? 'Past month — shipment outcomes' : 'Open month — backlog + onhand by PO due date'} for <strong>${escapeHtml(salesReportPsTypeLabel())}</strong></p>
    </div>
    <div class="sales-report-breakdown-scroll">
      <table class="sales-report-breakdown-table">
        <thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${headers.length}" class="sales-report-breakdown-empty">No data for selected PP types.</td></tr>`}</tbody>
      </table>
    </div>`;
}

function salesReportRenderTypeCards(breakdown, summary) {
  const el = document.getElementById('sales-report-type-cards');
  if (!el) return;
  const mode = summary?.mode || 'open';
  const cards = (breakdown || []).map(entry => {
    const s = entry.summary || {};
    const metrics = mode === 'past'
      ? [
        ['Backlog del.', s.backlog_delivered?.total_home_amt],
        ['On-time', s.delivered?.total_home_amt],
        ['Early', s.early_delivered?.total_home_amt],
        ['All shipped', s.shipped?.total_home_amt],
      ]
      : [
        ['Backlog', s.backlog?.remaining_value],
        ['Onhand', s.on_hand?.remaining_value],
        ['Shipped', s.shipped?.total_home_amt],
        ['Booked', s.booked?.line_amount],
      ];
    return `
      <article class="sales-report-type-card">
        <div class="sales-report-type-card-head">${salesReportTypeTagHtml(entry.type)}</div>
        <dl class="sales-report-type-card-metrics">
          ${metrics.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${salesReportFormatMoney(value)}</dd></div>`).join('')}
        </dl>
      </article>`;
  }).join('');
  el.innerHTML = cards;
  el.hidden = !cards;
}

function salesReportRenderYtdSummary(grid) {
  const el = document.getElementById('sales-report-ytd-summary');
  if (!el) return;
  if (!grid || salesReportState.focusMonth) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

  const totalRow = grid.rows.find(row => row.emphasis === 'total')
    || grid.rows.find(row => row.id === 'TOTAL')
    || grid.rows[grid.rows.length - 1];
  if (!totalRow) {
    el.hidden = true;
    return;
  }

  let ytdShipped = 0;
  let ytdBacklogDel = 0;
  let backlogNow = 0;
  let onHandNow = 0;
  let forwardDue = 0;

  grid.months.forEach((meta, idx) => {
    const cell = totalRow.cells[idx] || {};
    if (meta.mode === 'past') {
      ytdShipped += Number(cell.backlog_delivered || 0) + Number(cell.delivered || 0) + Number(cell.early_delivered || 0);
      ytdBacklogDel += Number(cell.backlog_delivered || 0);
    } else if (meta.is_current) {
      backlogNow += Number(cell.backlog || 0);
      onHandNow += Number(cell.on_hand || 0);
    } else {
      forwardDue += Number(cell.due_this_month || 0);
    }
  });

  const openRemaining = salesReportState.ytdData?.integrity?.pp_allocated_remaining_total;

  const cards = [
    { title: 'YTD shipped', tone: 'shipped', value: ytdShipped, sub: `Includes ${salesReportFormatMoney(ytdBacklogDel)} backlog cleared`, hint: 'All DO lines in past months' },
    { title: 'Backlog now', tone: 'cleared', value: backlogNow, sub: 'Still open · PO due before this month', hint: 'Backlog column in current month' },
    { title: 'Onhand now', tone: 'on-hand', value: onHandNow, sub: 'Unfinished · PO due in current month', hint: 'Onhand column in current month' },
    { title: 'Forward onhand', tone: 'early', value: forwardDue, sub: 'Unfinished · PO due in future months', hint: 'Sum of onhand $ in future month columns' },
  ];
  if (openRemaining != null) {
    cards.push({ title: 'Total open remaining', tone: 'booked', value: openRemaining, sub: 'All unfinished open $ (filtered)', hint: 'Authoritative PP-allocated remaining' });
  }

  el.innerHTML = `
    <div class="sales-report-ytd-summary-head">
      <h3 class="sales-report-ytd-summary-title">Year at a glance</h3>
      <p class="sales-report-ytd-summary-sub">Summary for <strong>${escapeHtml(salesReportPsTypeLabel())}</strong> — use <strong>View breakdown</strong> on a month header for line detail.</p>
    </div>
    <div class="sales-report-kpi-grid sales-report-kpi-grid--ytd card">
      ${cards.map(card => `
        <article class="sales-report-kpi sales-report-kpi--${card.tone}">
          <p class="sales-report-kpi-label">${escapeHtml(card.title)}</p>
          <p class="sales-report-kpi-value">${salesReportFormatMoney(card.value)}</p>
          <p class="sales-report-kpi-sub">${escapeHtml(card.sub)}</p>
          <p class="sales-report-kpi-hint">${escapeHtml(card.hint)}</p>
        </article>
      `).join('')}
    </div>`;
  el.hidden = false;
}

function salesReportRenderYtd() {
  const overview = document.getElementById('sales-report-overview');
  const table = document.getElementById('sales-report-ytd-table');
  const sub = document.getElementById('sales-report-ytd-sub');
  const ytd = salesReportState.ytdData;
  if (!overview || !table || !ytd) return;

  const openLines = salesReportFilteredSection(ytd.allocated_open_lines || ytd.open_lines || []);
  const shipments = salesReportFilteredSection(ytd.shipments_attributed || ytd.shipments || []);
  const grid = salesReportBuildYtdGrid(openLines, shipments, ytd.year);

  const firstFutureIdx = grid.months.findIndex(meta => meta.mode === 'open' && !meta.is_current);

  const monthTopRow = grid.months.map((meta, idx) => {
    const cls = salesReportYtdMonthHeaderClass(meta, idx, firstFutureIdx);
    const btnCls = salesReportYtdMonthButtonClass(meta);
    const colspan = salesReportYtdMonthColspan(meta);
    const title = meta.mode === 'past'
      ? `Shipments in ${meta.label}`
      : meta.is_current
        ? `Backlog + onhand in ${meta.label}`
        : `Onhand with PO due in ${meta.label}`;
    return `<th colspan="${colspan}" class="${cls}">
      <button type="button" class="${btnCls}" data-ytd-month="${meta.month}" title="${escapeHtml(title)} — view breakdown">
        <span class="sales-report-ytd-month-label">${escapeHtml(meta.label)}</span>
        <span class="sales-report-ytd-month-action">View breakdown<span class="sales-report-ytd-month-arrow" aria-hidden="true">→</span></span>
      </button>
    </th>`;
  }).join('');

  const subRow = grid.months.map(meta => (
    salesReportYtdSubheadCells(meta).map(sub => (
      `<th class="sales-report-ytd-subcol ${sub.cls}">${escapeHtml(sub.label)}</th>`
    )).join('')
  )).join('');

  const validKeys = new Set();

  const body = grid.rows.map(row => {
    const rowCls = row.emphasis === 'total' ? 'sales-report-ytd-row--total' : (row.emphasis === 'subtotal' ? 'sales-report-ytd-row--subtotal' : '');
    const cells = row.cells.map((cell, idx) => {
      const meta = grid.months[idx];
      if (meta.mode === 'past') {
        ['backlog_delivered', 'delivered', 'early_delivered'].forEach(col => {
          validKeys.add(salesReportYtdCellKey(row.id, meta.month, col));
        });
      } else if (meta.is_current) {
        ['backlog', 'on_hand'].forEach(col => {
          validKeys.add(salesReportYtdCellKey(row.id, meta.month, col));
        });
      } else {
        validKeys.add(salesReportYtdCellKey(row.id, meta.month, 'due_this_month'));
      }
      return salesReportYtdCellHtml(cell, meta, row.id);
    }).join('');
    return `<tr class="${rowCls}"><th class="sales-report-ytd-row-label">${escapeHtml(row.label)}</th>${cells}</tr>`;
  }).join('');

  salesReportPruneYtdSelection(validKeys);

  table.innerHTML = `
    <thead>
      <tr>
        <th class="sales-report-ytd-corner" rowspan="2" scope="rowgroup">Segment</th>
        ${monthTopRow}
      </tr>
      <tr>${subRow}</tr>
    </thead>
    <tbody>${body}</tbody>`;

  salesReportBindYtdMonthHeaders(table);
  salesReportBindYtdCellSelection(table);
  salesReportRenderYtdAggregate();

  salesReportRenderYtdSummary(grid);

  const legend = document.getElementById('sales-report-ytd-legend');
  if (legend) legend.hidden = Boolean(salesReportState.focusMonth);

  if (sub) {
    sub.textContent = salesReportState.focusMonth
      ? 'Line detail for the month you opened from the grid. Use Overview to return.'
      : 'Past = shipped · current = backlog + onhand · future = onhand by PO due month.';
  }
  overview.hidden = false;
}

function salesReportFormatExchRate(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function salesReportFormatCurrency(value) {
  const text = String(value || '').trim();
  return text || '—';
}

function salesReportOpenLineColumns() {
  return [
    { id: 'sales_order_no', label: 'Sales order' },
    { id: 'line_item_no', label: 'Line' },
    { id: 'process_sheet_no', label: 'PS' },
    { id: 'inventory_code', label: 'Part' },
    { id: 'description', label: 'Description' },
    { id: 'customer_name', label: 'Customer' },
    { id: 'due_date', label: 'Due', fmt: salesReportFormatDate },
    { id: 'order_currency_code', label: 'Curr', fmt: salesReportFormatCurrency },
    { id: 'unit_selling_price_fc', label: 'FC U/Price', fmt: salesReportFormatMoney },
    { id: 'exch_rate', label: 'Exch', fmt: salesReportFormatExchRate },
    { id: 'unit_selling_price', label: 'Home U/Price', fmt: salesReportFormatMoney },
    { id: 'remaining_qty', label: 'Remaining', fmt: (v, row) => salesReportFormatQty(salesReportOpenQty(row)) },
    { id: 'remaining_value', label: 'Home amt', fmt: (v, row) => salesReportFormatMoney(salesReportOpenValue(row)) },
  ];
}

function salesReportShippedLineColumns() {
  return [
    { id: 'sales_order_no', label: 'Sales order' },
    { id: 'line_item_no', label: 'Line' },
    { id: 'process_sheet_no', label: 'PS' },
    { id: 'pp_partial_no', label: 'Partial' },
    { id: 'due_date', label: 'Due', fmt: salesReportFormatDate },
    { id: 'shipment_datetime', label: 'Shipped', fmt: salesReportFormatDt },
    { id: 'order_currency_code', label: 'Curr', fmt: salesReportFormatCurrency },
    { id: 'unit_selling_price_fc', label: 'FC U/Price', fmt: salesReportFormatMoney },
    { id: 'exch_rate', label: 'Exch', fmt: salesReportFormatExchRate },
    { id: 'qty_issued', label: 'Qty', fmt: salesReportFormatQty },
    { id: 'total_home_amt', label: 'Home amt', fmt: salesReportFormatMoney },
    { id: 'shipment_voucher_no', label: 'Shipment' },
    { id: 'invoice_no', label: 'Invoice' },
  ];
}

function salesReportBookedLineColumns() {
  return [
    { id: 'sales_order_no', label: 'Sales order' },
    { id: 'line_item_no', label: 'Line' },
    { id: 'inventory_code', label: 'Part' },
    { id: 'due_date', label: 'Due', fmt: salesReportFormatDate },
    { id: 'first_posted_datetime', label: 'First post', fmt: salesReportFormatDt },
    { id: 'order_currency_code', label: 'Curr', fmt: salesReportFormatCurrency },
    { id: 'unit_selling_price_fc', label: 'FC U/Price', fmt: salesReportFormatMoney },
    { id: 'exch_rate', label: 'Exch', fmt: salesReportFormatExchRate },
    { id: 'qty', label: 'Qty', fmt: salesReportFormatQty },
    { id: 'unit_selling_price', label: 'Home U/Price', fmt: salesReportFormatMoney },
    { id: 'line_amount', label: 'Home amt', fmt: salesReportFormatMoney },
  ];
}

const SALES_REPORT_COLUMNS = {
  on_hand: salesReportOpenLineColumns(),
  backlog: salesReportOpenLineColumns(),
  shipped: salesReportShippedLineColumns(),
  booked: salesReportBookedLineColumns(),
};
SALES_REPORT_COLUMNS.early_delivered = SALES_REPORT_COLUMNS.shipped;

function salesReportIsPastMode() {
  const data = salesReportState.data;
  if (!data) return false;
  return (data.summary?.mode || (salesReportIsPastMonth(data.year, data.month) ? 'past' : 'open')) === 'past';
}

function salesReportColumnsForSection(sectionId) {
  if (salesReportIsPastMode() && (sectionId === 'on_hand' || sectionId === 'backlog' || sectionId === 'early_delivered')) {
    return SALES_REPORT_COLUMNS.shipped;
  }
  return SALES_REPORT_COLUMNS[sectionId] || [];
}

function salesReportDetailSectionDefs(data) {
  const past = data.summary?.mode === 'past';
  if (past) {
    return [
      { id: 'on_hand', title: 'On-time delivered', hint: 'Shipped this month · original PO due in same month', rows: data.on_hand || [] },
      { id: 'backlog', title: 'Backlog delivered', hint: 'Shipped this month · original PO due before month start', rows: data.backlog || [] },
      { id: 'early_delivered', title: 'Early delivered', hint: 'Shipped this month · original PO due after month end', rows: data.early_delivered || [] },
      { id: 'shipped', title: 'All shipments', hint: 'Every DO/shipment dated this month', rows: data.shipped || [] },
    ];
  }
  return [
    { id: 'backlog', title: 'Backlog', hint: 'Still open · PO due before this month', rows: data.backlog || [] },
    { id: 'on_hand', title: 'Onhand', hint: 'Unfinished open $ · PO due in this month', rows: data.on_hand || [] },
    { id: 'shipped', title: 'Shipped this month', hint: 'DO/shipment dated this month', rows: data.shipped || [] },
    { id: 'booked', title: 'Booked this month', hint: 'SO lines first-posted this month', rows: data.booked || [] },
  ];
}

function salesReportBuildTableHtml(rows, cols) {
  if (!rows.length) return '';
  const groups = salesReportActivePpTypes().map(type => ({
    type,
    rows: salesReportRowsForType(rows, type),
  })).filter(group => group.rows.length);
  const bodyParts = [];
  if (groups.length > 1) {
    groups.forEach(group => {
      bodyParts.push(`<tr class="sales-report-group-head"><td colspan="${cols.length}"><div class="sales-report-group-head-inner">${salesReportTypeTagHtml(group.type, group.rows.length)}</div></td></tr>`);
      group.rows.forEach(row => bodyParts.push(salesReportRenderTableRow(row, cols)));
    });
  } else {
    rows.forEach(row => bodyParts.push(salesReportRenderTableRow(row, cols)));
  }
  return `
    <table class="new-orders-table sales-report-table">
      <thead><tr>${cols.map(col => `<th>${escapeHtml(col.label)}</th>`).join('')}</tr></thead>
      <tbody>${bodyParts.join('')}</tbody>
    </table>`;
}

function salesReportRenderDetails(data) {
  const wrap = document.getElementById('sales-report-details');
  if (!wrap || !data) return;
  const sections = salesReportDetailSectionDefs(data).filter(section => section.rows.length > 0);
  if (!sections.length) {
    wrap.hidden = true;
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = sections.map(section => {
    const cols = salesReportColumnsForSection(section.id);
    return `
      <section class="sales-report-detail-section card">
        <div class="sales-report-detail-head">
          <h2 class="sales-report-detail-title">${escapeHtml(section.title)}</h2>
          <p class="sales-report-detail-hint">${escapeHtml(section.hint)} · ${section.rows.length} lines</p>
        </div>
        <div class="new-orders-table-wrap sales-report-detail-table-wrap">
          ${salesReportBuildTableHtml(section.rows, cols)}
        </div>
      </section>`;
  }).join('');
  wrap.hidden = false;
}

function salesReportRenderTableRow(row, cols) {
  return `<tr>${cols.map(col => {
    const raw = row[col.id];
    const text = col.fmt ? col.fmt(raw, row) : (raw == null || raw === '' ? '—' : String(raw));
    const mono = ['sales_order_no', 'inventory_code', 'process_sheet_no', 'shipment_voucher_no', 'invoice_no', 'order_currency_code'].includes(col.id);
    return `<td${mono ? ' class="new-orders-mono"' : ''}>${escapeHtml(text)}</td>`;
  }).join('')}</tr>`;
}

function salesReportRenderMonthPanel() {
  const data = salesReportFilteredPayload();
  const panel = document.getElementById('sales-report-month-panel');
  if (!panel || !data) return;

  const title = document.getElementById('sales-report-month-title');
  const sub = document.getElementById('sales-report-month-sub');
  if (title) title.textContent = salesReportFocusMonthLabel();
  if (sub) {
    sub.textContent = data.summary?.mode === 'past'
      ? 'How shipments in this month relate to their original due dates.'
      : 'Unfinished open value by PO due date.';
  }

  salesReportRenderIntegrity(data.integrity);
  salesReportRenderSummary(data.summary);
  salesReportRenderBreakdown(data.breakdown, data.summary);
  salesReportRenderDetails(data);
  panel.hidden = false;
}

function salesReportRenderMeta() {
  const el = document.getElementById('sales-report-meta');
  if (!el) return;
  const parts = [`${salesReportState.year}`];
  if (salesReportState.focusMonth) {
    const data = salesReportState.data;
    parts.push(salesReportFocusMonthLabel());
    parts.push(data?.summary?.mode === 'past' ? 'past month' : 'open month');
    if (data?.cached_at) parts.push(`Cached ${data.cached_at}`);
  } else {
    parts.push('year overview');
    if (salesReportState.ytdData?.cached_at) parts.push(`Cached ${salesReportState.ytdData.cached_at}`);
  }
  parts.push(`PP: ${salesReportPsTypeLabel()}`);
  el.textContent = parts.join(' · ');
  el.hidden = false;
}

function salesReportRender() {
  if (salesReportState.loading) return;

  if (salesReportNoPsTypesSelected()) {
    salesReportEndLoad();
    const ctx = document.getElementById('sales-report-context');
    if (ctx) ctx.textContent = 'Select at least one PP segment.';
    ['sales-report-overview', 'sales-report-month-panel', 'sales-report-integrity'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    const empty = document.getElementById('sales-report-empty');
    if (empty) {
      empty.hidden = false;
      document.getElementById('sales-report-empty-text').textContent = 'Select at least one PP prefix to show report figures.';
    }
    return;
  }

  salesReportEndLoad();
  salesReportSyncPeriodUI();
  salesReportRenderContext();

  const empty = document.getElementById('sales-report-empty');
  if (empty) empty.hidden = true;

  if (salesReportState.ytdData) {
    if (!salesReportState.focusMonth) {
      salesReportRenderIntegrity(salesReportState.ytdData.integrity);
    }
    salesReportRenderYtd();
  }

  if (salesReportState.focusMonth) {
    if (salesReportState.data) {
      salesReportRenderMonthPanel();
    }
  } else {
    const monthPanel = document.getElementById('sales-report-month-panel');
    if (monthPanel) monthPanel.hidden = true;
    const integrityEl = document.getElementById('sales-report-integrity');
    if (integrityEl && salesReportState.ytdData?.integrity) integrityEl.hidden = false;
  }

  salesReportRenderMeta();
}

async function salesReportLoadMonthly(options = {}) {
  const month = salesReportState.month || salesReportCurrentMonthValue();
  const [year, monthNum] = month.split('-');
  if (salesReportState.focusMonth) {
    salesReportBeginLoad(`Loading ${salesReportMonthLabel(month)}…`, { monthOnly: true });
  }

  const qs = new URLSearchParams({ year, month: monthNum });
  if (options.force) qs.set('refresh', '1');

  try {
    const res = await fetch(`/api/sales-report/monthly?${qs.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    salesReportState.data = data;
    salesReportState.month = month;
    salesReportState.year = Number(year);
    salesReportEndLoad();
    salesReportRender();
    if (options.scroll !== false && salesReportState.focusMonth) {
      document.getElementById('sales-report-month-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (err) {
    salesReportEndLoad();
    const empty = document.getElementById('sales-report-empty');
    if (empty) {
      empty.hidden = false;
      document.getElementById('sales-report-empty-text').textContent = `Could not load report: ${err.message}`;
    }
    if (typeof toast === 'function') toast(err.message, 'error');
  }
}

async function salesReportLoadYtd(options = {}) {
  const year = Number(salesReportState.year) || salesReportCurrentYear();
  salesReportState.year = year;
  if (!options.quiet) salesReportBeginLoad(`Loading ${year} overview…`);

  const qs = new URLSearchParams({ year: String(year) });
  if (options.force) qs.set('refresh', '1');

  try {
    const res = await fetch(`/api/sales-report/ytd?${qs.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    salesReportState.ytdData = data;
    salesReportEndLoad();
    salesReportRender();
  } catch (err) {
    salesReportEndLoad();
    const empty = document.getElementById('sales-report-empty');
    if (empty) {
      empty.hidden = false;
      document.getElementById('sales-report-empty-text').textContent = `Could not load YTD: ${err.message}`;
    }
    if (typeof toast === 'function') toast(err.message, 'error');
  }
}

function salesReportSetPpTypes(types) {
  salesReportState.ppTypes = new Set(types);
  salesReportSyncPsTypeCheckboxes();
  salesReportSyncPresetButtons();
  salesReportRender();
}

function salesReportSyncPresetButtons() {
  const presets = { 'aps-nps': ['APS', 'NPS'], aps: ['APS'], nps: ['NPS'], all: [...SALES_REPORT_PS_TYPES] };
  document.querySelectorAll('[data-pp-preset]').forEach(btn => {
    const want = [...(presets[btn.dataset.ppPreset] || [])].sort().join(',');
    const current = [...salesReportState.ppTypes].sort().join(',');
    btn.classList.toggle('is-active', current === want);
  });
}

function salesReportBindPresets() {
  document.querySelectorAll('[data-pp-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.ppPreset;
      if (key === 'aps-nps') salesReportSetPpTypes(['APS', 'NPS']);
      else if (key === 'aps') salesReportSetPpTypes(['APS']);
      else if (key === 'nps') salesReportSetPpTypes(['NPS']);
      else if (key === 'all') salesReportSetPpTypes([...SALES_REPORT_PS_TYPES]);
    });
  });
}

function salesReportBindPsTypeDropdown() {
  const btn = document.getElementById('sales-report-ps-type-btn');
  const panel = document.getElementById('sales-report-ps-type-panel');
  if (!btn || !panel) return;
  salesReportSyncPsTypeCheckboxes();
  btn.addEventListener('click', (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; });
  document.addEventListener('click', () => { panel.hidden = true; });
  panel.addEventListener('click', e => e.stopPropagation());
  panel.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', () => {
      salesReportState.ppTypes = new Set([...panel.querySelectorAll('input:checked')].map(el => el.value));
      btn.textContent = `${salesReportPsTypeLabel()} ▾`;
      salesReportSyncPresetButtons();
      salesReportRender();
    });
  });
  salesReportSyncPresetButtons();
}

function salesReportBindControls() {
  const yearInput = document.getElementById('sales-report-year');
  salesReportState.year = salesReportCurrentYear();
  if (yearInput) {
    yearInput.value = String(salesReportState.year);
    yearInput.addEventListener('change', async () => {
      const year = Number(yearInput.value) || salesReportCurrentYear();
      salesReportState.year = year;
      salesReportState.ytdData = null;
      salesReportState.data = null;
      if (salesReportState.focusMonth) {
        salesReportState.month = salesReportMonthValue(year, salesReportState.focusMonth);
      }
      await salesReportLoadYtd();
      if (salesReportState.focusMonth) {
        await salesReportLoadMonthly({ quiet: true });
      }
    });
  }

  document.querySelectorAll('.sales-report-month-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.month;
      if (!raw) {
        salesReportClearFocusMonth();
        return;
      }
      if (salesReportState.focusMonth) return;
      salesReportScrollToYtdMonth(Number(raw));
    });
  });

  document.getElementById('sales-report-back-overview')?.addEventListener('click', salesReportClearFocusMonth);

  document.getElementById('sales-report-search')?.addEventListener('input', (e) => {
    salesReportState.search = e.target.value;
    salesReportRender();
  });

  document.getElementById('sales-report-refresh')?.addEventListener('click', async () => {
    salesReportState.ytdData = null;
    if (salesReportState.focusMonth) salesReportState.data = null;
    await salesReportLoadYtd({ force: true });
    if (salesReportState.focusMonth) {
      await salesReportLoadMonthly({ force: true, quiet: true });
    }
  });

  document.getElementById('sales-report-export')?.addEventListener('click', salesReportExportCsv);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (salesReportState.ytdCellSelection.size) {
        salesReportClearYtdSelection();
        return;
      }
      if (salesReportState.focusMonth) salesReportClearFocusMonth();
    }
  });
  salesReportSyncPeriodUI();
}

function salesReportExportCsv() {
  const data = salesReportFilteredPayload();
  if (!data || salesReportNoPsTypesSelected()) return;
  const sections = salesReportDetailSectionDefs(data).filter(section => section.rows.length > 0);
  if (!sections.length) return;
  const lines = [];
  sections.forEach(section => {
    const cols = salesReportColumnsForSection(section.id);
    lines.push(`# ${section.title}`);
    lines.push(cols.map(col => col.label).join(','));
    section.rows.forEach(row => {
      lines.push(cols.map(col => {
        const raw = row[col.id];
        const text = col.fmt ? col.fmt(raw, row) : (raw == null ? '' : String(raw));
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      }).join(','));
    });
    lines.push('');
  });
  const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sales-report-${salesReportState.month}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.addEventListener('DOMContentLoaded', () => {
  salesReportBindControls();
  salesReportBindPresets();
  salesReportBindPsTypeDropdown();
  salesReportLoadYtd();
});
