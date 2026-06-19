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

function salesReportShipmentInMonth(row, start, end) {
  const ship = salesReportParseDate(row?.shipment_date || row?.shipment_datetime);
  if (!ship) return false;
  return ship >= start && ship <= end;
}

function salesReportBuildOpenMonthSummary(openLines, start, end) {
  const dueLines = openLines.filter(row => salesReportDueInMonth(row, start, end));
  const overdueLines = openLines.filter(row => salesReportDueBeforeMonth(row, start));
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
  return {
    mode: 'open',
    due_this_month: dueSummary,
    overdue: overdueSummary,
    on_hand: dueSummary,
    backlog: overdueSummary,
    on_hand_lines: dueLines,
    backlog_lines: overdueLines,
  };
}

function salesReportYtdMonthColspan(meta) {
  if (meta.mode === 'past') return 3;
  if (meta.is_current) return 2;
  return 1;
}

function salesReportYtdMonthHeaderClass(meta, idx, firstFutureIdx) {
  return [
    'sales-report-ytd-month',
    'sales-report-ytd-month--clickable',
    meta.is_current ? 'is-current' : '',
    meta.mode === 'past' ? 'is-past' : (meta.is_current ? 'is-open-current' : 'is-future'),
    idx === firstFutureIdx ? 'is-future-start' : '',
    salesReportState.focusMonth === meta.month ? 'is-selected' : '',
  ].filter(Boolean).join(' ');
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
      { label: 'Overdue', cls: 'is-overdue' },
      { label: 'Due this month', cls: 'is-due' },
    ];
  }
  return [{ label: 'Open due', cls: 'is-due' }];
}

function salesReportYtdCellHtml(cell, meta) {
  if (meta.mode === 'past') {
    return `<td class="sales-report-ytd-num">${salesReportFormatMoney(cell.backlog_delivered)}</td><td class="sales-report-ytd-num">${salesReportFormatMoney(cell.delivered)}</td><td class="sales-report-ytd-num">${salesReportFormatMoney(cell.early_delivered)}</td>`;
  }
  if (meta.is_current) {
    const overdue = cell.overdue ?? cell.backlog ?? 0;
    const due = cell.due_this_month ?? cell.on_hand ?? 0;
    return `<td class="sales-report-ytd-num sales-report-ytd-num--overdue">${salesReportFormatMoney(overdue)}</td><td class="sales-report-ytd-num sales-report-ytd-num--due">${salesReportFormatMoney(due)}</td>`;
  }
  const due = cell.due_this_month ?? cell.on_hand ?? 0;
  return `<td class="sales-report-ytd-num sales-report-ytd-num--due" colspan="1">${salesReportFormatMoney(due)}</td>`;
}

function salesReportBuildPastMonthSummary(shipments, start, end) {
  const monthShipments = shipments.filter(row => salesReportShipmentInMonth(row, start, end));
  const delivered = monthShipments.filter(row => salesReportDueInMonth(row, start, end));
  const backlogDelivered = monthShipments.filter(row => salesReportDueBeforeMonth(row, start));
  const earlyDelivered = monthShipments.filter(row => salesReportDueAfterMonth(row, end));
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
          overdue: open.overdue.remaining_value,
          due_this_month: dueVal,
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
          overdue: cellLists.reduce((sum, list) => sum + Number(list[idx]?.overdue || 0), 0),
          due_this_month: cellLists.reduce((sum, list) => sum + Number(list[idx]?.due_this_month || 0), 0),
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

  if (activeTypes.includes('APS') && activeTypes.includes('NPS')) {
    rows.push({
      id: 'SUB_APS_NPS',
      label: 'Sub-Total (APS+NPS)',
      cells: sumCells([rowCells.APS, rowCells.NPS]),
      emphasis: 'subtotal',
    });
  }

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
      if (row.id === 'SUB_APS_NPS' || row.id === 'TOTAL') return true;
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
    parts.push(`<span class="new-orders-stat">On hand <strong>${salesReportFormatMoney(summary.on_hand?.remaining_value)}</strong></span>`);
    parts.push(`<span class="new-orders-stat">Backlog <strong>${salesReportFormatMoney(summary.backlog?.remaining_value)}</strong></span>`);
    parts.push(`<span class="new-orders-stat">Booked <strong>${salesReportFormatMoney(summary.booked?.line_amount)}</strong></span>`);
  }
  el.innerHTML = parts.join('');
}

function salesReportRenderSummary(summary) {
  const el = document.getElementById('sales-report-summary');
  if (!el || !summary) return;

  const cards = summary.mode === 'past'
    ? [
      { title: 'Delivered (on time)', tone: 'shipped', value: summary.delivered?.total_home_amt, sub: `${summary.delivered?.line_count || 0} shipment lines`, hint: 'Shipped in month · due date also in this month' },
      { title: 'Backlog delivered', tone: 'cleared', value: summary.backlog_delivered?.total_home_amt, sub: `${summary.backlog_delivered?.line_count || 0} shipment lines`, hint: 'Shipped in month · was overdue (due before month start)' },
      { title: 'Early delivered', tone: 'early', value: summary.early_delivered?.total_home_amt, sub: `${summary.early_delivered?.line_count || 0} shipment lines`, hint: 'Shipped in month · due date after month end' },
      { title: 'All shipments', tone: 'booked', value: summary.shipped?.total_home_amt, sub: `${summary.shipped?.line_count || 0} lines`, hint: 'On-time + backlog + early (every DO dated in month)' },
    ]
    : [
      { title: 'Due this month', tone: 'on-hand', value: summary.on_hand?.remaining_value, sub: `${salesReportFormatQty(summary.on_hand?.remaining_qty)} pcs · ${summary.on_hand?.line_count || 0} lines`, hint: 'Unfinished open $ · PO/PP due date falls in this month' },
      { title: 'Overdue (open)', tone: 'cleared', value: summary.backlog?.remaining_value, sub: `${salesReportFormatQty(summary.backlog?.remaining_qty)} pcs · ${summary.backlog?.line_count || 0} lines`, hint: 'Still open · PO due date was before this month' },
      { title: 'Shipped this month', tone: 'shipped', value: summary.shipped?.total_home_amt, sub: `${summary.shipped?.line_count || 0} lines`, hint: 'DO/shipment dated in month' },
      { title: 'Booked this month', tone: 'booked', value: summary.booked?.line_amount, sub: `${summary.booked?.line_count || 0} lines`, hint: 'First-posted in month' },
    ];

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
    : ['PP type', 'Due this month $', 'Overdue $', 'Shipped $', 'Booked $'];

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
      <td class="sales-report-breakdown-num">${salesReportFormatMoney(s.on_hand?.remaining_value)}</td>
      <td class="sales-report-breakdown-num">${salesReportFormatMoney(s.backlog?.remaining_value)}</td>
      <td class="sales-report-breakdown-num">${salesReportFormatMoney(s.shipped?.total_home_amt)}</td>
      <td class="sales-report-breakdown-num">${salesReportFormatMoney(s.booked?.line_amount)}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="sales-report-breakdown-head">
      <h2 class="sales-report-breakdown-title">Breakdown by PP type</h2>
      <p class="sales-report-breakdown-sub">${mode === 'past' ? 'Past month — shipment outcomes' : 'Open month — unfinished $ by PO due date'} for <strong>${escapeHtml(salesReportPsTypeLabel())}</strong></p>
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
        ['On hand', s.on_hand?.remaining_value],
        ['Backlog', s.backlog?.remaining_value],
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
  let overdueNow = 0;
  let dueNow = 0;
  let forwardDue = 0;

  grid.months.forEach((meta, idx) => {
    const cell = totalRow.cells[idx] || {};
    if (meta.mode === 'past') {
      ytdShipped += Number(cell.backlog_delivered || 0) + Number(cell.delivered || 0) + Number(cell.early_delivered || 0);
      ytdBacklogDel += Number(cell.backlog_delivered || 0);
    } else if (meta.is_current) {
      overdueNow += Number(cell.overdue || 0);
      dueNow += Number(cell.due_this_month || 0);
    } else {
      forwardDue += Number(cell.due_this_month || 0);
    }
  });

  const openRemaining = salesReportState.ytdData?.integrity?.pp_allocated_remaining_total;

  const cards = [
    { title: 'YTD shipped', tone: 'shipped', value: ytdShipped, sub: `Includes ${salesReportFormatMoney(ytdBacklogDel)} backlog cleared`, hint: 'All DO lines in past months' },
    { title: 'Overdue now', tone: 'cleared', value: overdueNow, sub: 'Still open · due before this month', hint: 'Shown once in current month column' },
    { title: 'Due this month', tone: 'on-hand', value: dueNow, sub: 'Unfinished · PO due in current month', hint: 'Open $ with due date this month' },
    { title: 'Forward schedule', tone: 'early', value: forwardDue, sub: 'Unfinished · PO due in future months', hint: 'Sum of open $ by future due month' },
  ];
  if (openRemaining != null) {
    cards.push({ title: 'Total open remaining', tone: 'booked', value: openRemaining, sub: 'All unfinished open $ (filtered)', hint: 'Authoritative PP-allocated remaining' });
  }

  el.innerHTML = `
    <div class="sales-report-ytd-summary-head">
      <h3 class="sales-report-ytd-summary-title">Year at a glance</h3>
      <p class="sales-report-ytd-summary-sub">Summary for <strong>${escapeHtml(salesReportPsTypeLabel())}</strong> — click any month in the grid for line detail.</p>
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
    const colspan = salesReportYtdMonthColspan(meta);
    const title = meta.mode === 'past'
      ? `Shipments in ${meta.label}`
      : meta.is_current
        ? `Overdue + due in ${meta.label}`
        : `Unfinished jobs with PO due in ${meta.label}`;
    return `<th colspan="${colspan}" class="${cls}" data-ytd-month="${meta.month}" title="${escapeHtml(title)}">${escapeHtml(meta.label)}</th>`;
  }).join('');

  const subRow = grid.months.map(meta => (
    salesReportYtdSubheadCells(meta).map(sub => (
      `<th class="sales-report-ytd-subcol ${sub.cls}">${escapeHtml(sub.label)}</th>`
    )).join('')
  )).join('');

  const body = grid.rows.map(row => {
    const rowCls = row.emphasis === 'total' ? 'sales-report-ytd-row--total' : (row.emphasis === 'subtotal' ? 'sales-report-ytd-row--subtotal' : '');
    const cells = row.cells.map((cell, idx) => salesReportYtdCellHtml(cell, grid.months[idx])).join('');
    return `<tr class="${rowCls}"><th class="sales-report-ytd-row-label">${escapeHtml(row.label)}</th>${cells}</tr>`;
  }).join('');

  table.innerHTML = `
    <thead>
      <tr>
        <th class="sales-report-ytd-corner" rowspan="2" scope="rowgroup">Segment</th>
        ${monthTopRow}
      </tr>
      <tr>${subRow}</tr>
    </thead>
    <tbody>${body}</tbody>`;

  table.querySelectorAll('[data-ytd-month]').forEach(th => {
    th.addEventListener('click', () => salesReportSetFocusMonth(th.dataset.ytdMonth));
  });

  salesReportRenderYtdSummary(grid);

  if (sub) {
    sub.textContent = salesReportState.focusMonth
      ? 'Overview for selected year — open another month from the chips above or column headers.'
      : 'Past months = what shipped · current month = overdue + due now · future months = unfinished open $ by PO due date (one value per month).';
  }
  overview.hidden = false;
}

const SALES_REPORT_COLUMNS = {
  on_hand: [
    { id: 'sales_order_no', label: 'Sales order' },
    { id: 'line_item_no', label: 'Line' },
    { id: 'process_sheet_no', label: 'PS' },
    { id: 'inventory_code', label: 'Part' },
    { id: 'description', label: 'Description' },
    { id: 'customer_name', label: 'Customer' },
    { id: 'due_date', label: 'Due', fmt: salesReportFormatDate },
    { id: 'remaining_qty', label: 'Remaining', fmt: (v, row) => salesReportFormatQty(salesReportOpenQty(row)) },
    { id: 'unit_selling_price', label: 'U/Price', fmt: salesReportFormatMoney },
    { id: 'remaining_value', label: 'Value', fmt: (v, row) => salesReportFormatMoney(salesReportOpenValue(row)) },
  ],
  backlog: [
    { id: 'sales_order_no', label: 'Sales order' },
    { id: 'line_item_no', label: 'Line' },
    { id: 'process_sheet_no', label: 'PS' },
    { id: 'inventory_code', label: 'Part' },
    { id: 'description', label: 'Description' },
    { id: 'customer_name', label: 'Customer' },
    { id: 'due_date', label: 'Due', fmt: salesReportFormatDate },
    { id: 'remaining_qty', label: 'Remaining', fmt: (v, row) => salesReportFormatQty(salesReportOpenQty(row)) },
    { id: 'unit_selling_price', label: 'U/Price', fmt: salesReportFormatMoney },
    { id: 'remaining_value', label: 'Value', fmt: (v, row) => salesReportFormatMoney(salesReportOpenValue(row)) },
  ],
  shipped: [
    { id: 'sales_order_no', label: 'Sales order' },
    { id: 'line_item_no', label: 'Line' },
    { id: 'process_sheet_no', label: 'PS' },
    { id: 'due_date', label: 'Due', fmt: salesReportFormatDate },
    { id: 'shipment_datetime', label: 'Shipped', fmt: salesReportFormatDt },
    { id: 'qty_issued', label: 'Qty', fmt: salesReportFormatQty },
    { id: 'total_home_amt', label: 'Home amt', fmt: salesReportFormatMoney },
    { id: 'shipment_voucher_no', label: 'Shipment' },
    { id: 'invoice_no', label: 'Invoice' },
  ],
  booked: [
    { id: 'sales_order_no', label: 'Sales order' },
    { id: 'line_item_no', label: 'Line' },
    { id: 'process_sheet_no', label: 'PS' },
    { id: 'due_date', label: 'Due', fmt: salesReportFormatDate },
    { id: 'first_posted_datetime', label: 'First post', fmt: salesReportFormatDt },
    { id: 'qty', label: 'Qty', fmt: salesReportFormatQty },
    { id: 'line_amount', label: 'Amount', fmt: salesReportFormatMoney },
  ],
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
      { id: 'on_hand', title: 'On-time delivered', hint: 'Shipped this month · due date in same month', rows: data.on_hand || [] },
      { id: 'backlog', title: 'Backlog delivered', hint: 'Shipped this month · was overdue before month start', rows: data.backlog || [] },
      { id: 'early_delivered', title: 'Early delivered', hint: 'Shipped this month · due date after month end', rows: data.early_delivered || [] },
      { id: 'shipped', title: 'All shipments', hint: 'Every DO/shipment dated this month', rows: data.shipped || [] },
    ];
  }
  return [
    { id: 'on_hand', title: 'Due this month', hint: 'Unfinished open $ · PO/PP due in this month', rows: data.on_hand || [] },
    { id: 'backlog', title: 'Overdue (still open)', hint: 'PO due before month start · not yet shipped', rows: data.backlog || [] },
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
    const mono = ['sales_order_no', 'inventory_code', 'process_sheet_no', 'shipment_voucher_no', 'invoice_no'].includes(col.id);
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
      : 'Unfinished open value by PO/PP due date — click a month column to see line detail.';
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
      if (!raw) salesReportClearFocusMonth();
      else salesReportSetFocusMonth(raw);
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
