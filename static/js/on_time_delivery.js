/* On-time delivery - process sheet PO due vs last delivery. */

const OTD_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
const OTD_PRESETS = {
  'aps-nps': ['APS', 'NPS'],
  aps: ['APS'],
  nps: ['NPS'],
  all: [...OTD_PS_TYPES],
};
const OTD_PP_COLORS = {
  MPS: '#475569',
  APS: '#0369a1',
  NPS: '#0f766e',
  PPS: '#7c3aed',
  CPS: '#c2410c',
  SR: '#db2777',
};
const OTD_STATUS_COLORS = {
  early: '#0369a1',
  on_time: '#15803d',
  late: '#c2410c',
};
const OTD_STATUS_LABELS = {
  early: 'Early',
  on_time: 'On time',
  late: 'Late',
  unclassified: 'No dates',
};
const OTD_HIST_COLORS = {
  le_neg_14: '#0369a1',
  neg_13_1: '#0ea5e9',
  on_time: '#15803d',
  d1_7: '#d97706',
  d8_14: '#ea580c',
  d15_30: '#c2410c',
  ge_31: '#7f1d1d',
};
const OTD_MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const OTD_HIST_BUCKETS = [
  { id: 'le_neg_14', label: '<=-14', lo: null, hi: -14 },
  { id: 'neg_13_1', label: '-13 to -1', lo: -13, hi: -1 },
  { id: 'on_time', label: '0', lo: 0, hi: 0 },
  { id: 'd1_7', label: '1-7', lo: 1, hi: 7 },
  { id: 'd8_14', label: '8-14', lo: 8, hi: 14 },
  { id: 'd15_30', label: '15-30', lo: 15, hi: 30 },
  { id: 'ge_31', label: '31+', lo: 31, hi: null },
];
const OTD_BLANK_PERSON = '(blank)';
const OTD_OVERVIEW_SECTIONS = [
  { id: 'aps', label: 'APS', ppTypes: ['APS'], salesContains: null, subtitle: 'All sales people' },
  { id: 'nps', label: 'NPS', ppTypes: ['NPS'], salesContains: null, subtitle: 'All sales people' },
  { id: 'pps', label: 'PPS', ppTypes: ['PPS'], salesContains: 'alice', subtitle: 'Alice only' },
];

const otdState = {
  year: new Date().getFullYear(),
  tab: 'detail',
  benchmark: 'po_due',
  segment: 'due',
  ppTypes: new Set(['APS', 'NPS']),
  salespersons: new Set(),
  salespersonOptions: [],
  sourceRows: [],
  data: null,
  overview: [],
  loading: false,
  statusFilter: 'all',
  search: '',
  selectedMonth: null,
  selectedPs: null,
  fetchGen: 0,
};

function otdEl(id) {
  return document.getElementById(id);
}

function otdEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function otdPct(value, digits = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return `${(num * 100).toLocaleString(undefined, { maximumFractionDigits: digits })}%`;
}

function otdNum(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function otdDays(value) {
  if (value == null || value === '') return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  if (num > 0) return `+${num}`;
  return String(num);
}

function otdPsLabel(ppType) {
  return ppType === 'SR' ? '[SR]' : (ppType || '-');
}

function otdCompact(value) {
  return String(value ?? '').trim();
}

function otdSalespersonKey(row) {
  const name = otdCompact(row?.sales_person_name).toLowerCase();
  if (name) return name;
  const code = otdCompact(row?.sales_person_code).toLowerCase();
  if (code) return code;
  return OTD_BLANK_PERSON;
}

function otdSalespersonLabel(row) {
  const name = otdCompact(row?.sales_person_name);
  const code = otdCompact(row?.sales_person_code);
  if (name && code && name !== code) return `${name} (${code})`;
  return name || code || '(Blank)';
}

function otdParseDateParts(value) {
  const text = otdCompact(value).slice(0, 10);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function otdDeliveryDate(row) {
  return otdParseDateParts(row?.delivery_date);
}

function otdBenchmarkName() {
  return otdState.benchmark === 'proposed_edd' ? 'proposed EDD' : 'PO due';
}

function otdDaysBetween(delivery, benchmarkDate) {
  const left = otdParseDateParts(delivery);
  const right = otdParseDateParts(benchmarkDate);
  if (!left || !right) return null;
  const utcLeft = Date.UTC(left.year, left.month - 1, left.day);
  const utcRight = Date.UTC(right.year, right.month - 1, right.day);
  return Math.round((utcLeft - utcRight) / 86400000);
}

function otdStatusFromDays(days) {
  if (days == null || !Number.isFinite(Number(days))) return 'unclassified';
  if (days < 0) return 'early';
  if (days === 0) return 'on_time';
  return 'late';
}

function otdBenchmarkDate(row, benchmark) {
  if (benchmark === 'proposed_edd') {
    const proposed = row?.proposed_edd || row?.coway_proposed_edd;
    if (otdCompact(proposed)) return proposed;
  }
  return row?.po_due_date;
}

function otdAsBenchmark(row, benchmark) {
  const days = otdDaysBetween(row?.delivery_date, otdBenchmarkDate(row, benchmark));
  const status = otdStatusFromDays(days);
  return {
    ...row,
    days,
    status,
    on_time: status === 'early' || status === 'on_time',
  };
}

function otdStatusLabel(status) {
  if (status === 'unclassified' && otdState.benchmark === 'proposed_edd') return 'No EDD';
  return OTD_STATUS_LABELS[status] || status;
}

function otdSalesContains(row, needle) {
  const text = otdCompact(needle).toLowerCase();
  if (!text) return true;
  const hay = `${otdCompact(row?.sales_person_name)} ${otdCompact(row?.sales_person_code)} ${otdSalespersonKey(row)}`.toLowerCase();
  return hay.includes(text);
}

function otdAllTypesSelected() {
  return otdState.ppTypes.size >= OTD_PS_TYPES.length;
}

function otdSelectedTypeList() {
  if (otdAllTypesSelected()) return [...OTD_PS_TYPES];
  return OTD_PS_TYPES.filter((item) => otdState.ppTypes.has(item));
}

function otdTypesQuery() {
  if (otdAllTypesSelected()) return 'ALL';
  return [...otdState.ppTypes].join(',');
}

function otdEmptyMonth(month) {
  return {
    month,
    label: OTD_MONTH_LABELS[month - 1],
    early: 0,
    on_time: 0,
    late: 0,
    unclassified: 0,
    classified: 0,
    on_time_rate: 0,
    avg_days: null,
    avg_late_days: null,
  };
}

function otdEmptyPs(ppType) {
  return {
    id: ppType,
    label: otdPsLabel(ppType),
    early: 0,
    on_time: 0,
    late: 0,
    unclassified: 0,
    classified: 0,
    on_time_rate: 0,
    avg_days: null,
  };
}

function otdApplyStatusCount(target, status) {
  if (status === 'early') {
    target.early = (target.early || 0) + 1;
    target.classified = (target.classified || 0) + 1;
  } else if (status === 'on_time') {
    target.on_time = (target.on_time || 0) + 1;
    target.classified = (target.classified || 0) + 1;
  } else if (status === 'late') {
    target.late = (target.late || 0) + 1;
    target.classified = (target.classified || 0) + 1;
  } else {
    target.unclassified = (target.unclassified || 0) + 1;
  }
}

function otdFinalizeCounts(target, daysValues, lateDays) {
  const classified = target.classified || 0;
  const onTime = (target.early || 0) + (target.on_time || 0);
  target.on_time_rate = classified ? onTime / classified : 0;
  if (daysValues.length) {
    target.avg_days = Math.round((daysValues.reduce((sum, item) => sum + item, 0) / daysValues.length) * 10) / 10;
  }
  if (lateDays.length) {
    target.avg_late_days = Math.round((lateDays.reduce((sum, item) => sum + item, 0) / lateDays.length) * 10) / 10;
  }
}

function otdHistBucketId(days) {
  for (const bucket of OTD_HIST_BUCKETS) {
    if (bucket.lo != null && days < bucket.lo) continue;
    if (bucket.hi != null && days > bucket.hi) continue;
    return bucket.id;
  }
  return 'ge_31';
}

function otdHistogram(rows) {
  const counts = Object.fromEntries(OTD_HIST_BUCKETS.map((bucket) => [bucket.id, 0]));
  let skipped = 0;
  let onTime = 0;
  rows.forEach((row) => {
    if (row.days == null || row.days === '') {
      skipped += 1;
      return;
    }
    const dayCount = Number(row.days);
    if (!Number.isFinite(dayCount)) {
      skipped += 1;
      return;
    }
    counts[otdHistBucketId(dayCount)] += 1;
    if (dayCount <= 0) onTime += 1;
  });
  const classified = Object.values(counts).reduce((sum, item) => sum + item, 0);
  return {
    buckets: OTD_HIST_BUCKETS.map((bucket) => ({ id: bucket.id, label: bucket.label, count: counts[bucket.id] })),
    classified,
    skipped,
    on_time: onTime,
    on_time_rate: classified ? onTime / classified : 0,
  };
}

function otdCollectSalespeople(rows) {
  const byKey = new Map();
  (rows || []).forEach((row) => {
    const key = otdSalespersonKey(row);
    if (byKey.has(key)) return;
    byKey.set(key, { id: key, label: otdSalespersonLabel(row) });
  });
  return [...byKey.values()].sort((a, b) => {
    if (a.id === OTD_BLANK_PERSON) return 1;
    if (b.id === OTD_BLANK_PERSON) return -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
}

function otdSegmentOf(row) {
  const delivery = otdDeliveryDate(row);
  const bench = otdParseDateParts(otdBenchmarkDate(row, otdState.benchmark));
  const year = otdState.year;
  if (bench && bench.year === year) return 'due';
  if (!delivery || delivery.year !== year) return null;
  if (!bench) return 'no_benchmark';
  if (bench.year < year) return 'carried_in';
  if (bench.year > year) return 'early_ship';
  return null;
}

function otdPrepareRow(row) {
  const segment = otdSegmentOf(row);
  if (!segment) return null;
  const delivery = otdDeliveryDate(row);
  return otdAsBenchmark({
    ...row,
    segment,
    delivery_year: delivery ? delivery.year : null,
    month: delivery && delivery.year === otdState.year ? delivery.month : null,
    sales_person_label: otdSalespersonLabel(row),
  }, otdState.benchmark);
}

function otdCandidateRows() {
  return (otdState.sourceRows || []).map(otdPrepareRow).filter(Boolean).filter((row) => {
    if (!otdAllTypesSelected() && !otdState.ppTypes.has(row.pp_type)) return false;
    return true;
  });
}

function otdInChart(row) {
  if (row.segment !== otdState.segment) return false;
  if (otdState.segment === 'due' && row.delivery_year !== otdState.year) return false;
  return true;
}

function otdYearRows() {
  return otdCandidateRows().filter((row) => {
    if (!otdInChart(row)) return false;
    if (otdState.salespersons.size && !otdState.salespersons.has(otdSalespersonKey(row))) return false;
    return true;
  });
}

function otdOutsideYearRows() {
  if (otdState.segment !== 'due') return [];
  return otdCandidateRows().filter((row) => {
    if (row.segment !== 'due' || row.delivery_year === otdState.year) return false;
    if (otdState.salespersons.size && !otdState.salespersons.has(otdSalespersonKey(row))) return false;
    return true;
  });
}

function otdScopedRows({ month = true, ps = true } = {}) {
  const allTypes = otdAllTypesSelected();
  const people = otdState.salespersons;
  return otdYearRows().filter((row) => {
    if (!allTypes && !otdState.ppTypes.has(row.pp_type)) return false;
    if (people.size && !people.has(otdSalespersonKey(row))) return false;
    if (month && otdState.selectedMonth && row.month !== otdState.selectedMonth) return false;
    if (ps && otdState.selectedPs && row.pp_type !== otdState.selectedPs) return false;
    return true;
  });
}

function otdApplyFilters() {
  if (otdState.segment === 'no_benchmark') otdState.segment = 'due';
  const yearRows = otdCandidateRows().filter(otdInChart);
  otdState.salespersonOptions = otdCollectSalespeople(yearRows);
  const validPeople = new Set(otdState.salespersonOptions.map((item) => item.id));
  [...otdState.salespersons].forEach((key) => {
    if (!validPeople.has(key)) otdState.salespersons.delete(key);
  });
  const selected = otdSelectedTypeList();
  const chartRows = otdScopedRows();
  const payload = otdAggregate(chartRows, selected);
  payload.by_month = otdAggregate(otdScopedRows({ month: false, ps: true }), selected).by_month;
  payload.by_ps = otdAggregate(otdScopedRows({ month: true, ps: false }), selected).by_ps;
  payload.by_month_ps = otdAggregate(otdScopedRows({ month: false, ps: false }), selected).by_month_ps;
  otdState.data = payload;
  otdState.overview = otdBuildOverview();
  otdSyncSalespersonDropdown();
  otdRender();
}

function otdSyncPsCheckboxes() {
  const panel = otdEl('otd-ps-type-panel');
  if (!panel) return;
  panel.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = otdState.ppTypes.has(input.value);
  });
  const btn = otdEl('otd-ps-type-btn');
  if (!btn) return;
  const selected = OTD_PS_TYPES.filter((item) => otdState.ppTypes.has(item)).map(otdPsLabel);
  if (!selected.length) btn.textContent = 'None \u25BE';
  else if (selected.length >= OTD_PS_TYPES.length) btn.textContent = 'All types \u25BE';
  else btn.textContent = `${selected.join(', ')} \u25BE`;
}

function otdSyncSalespersonDropdown() {
  const panel = otdEl('otd-salesperson-panel');
  const btn = otdEl('otd-salesperson-btn');
  const options = otdState.salespersonOptions || [];
  const selected = otdState.salespersons;
  if (btn) {
    if (!selected.size) btn.textContent = 'All sales people \u25BE';
    else if (selected.size === 1) {
      const match = options.find((item) => item.id === [...selected][0]);
      btn.textContent = `${match?.label || '1 selected'} \u25BE`;
    } else btn.textContent = `${selected.size} sales people \u25BE`;
    btn.classList.toggle('is-active', selected.size > 0);
  }
  if (!panel) return;
  if (!options.length) {
    panel.innerHTML = '<p class="sales-report-filter-empty">No sales people in this year.</p>';
    return;
  }
  panel.innerHTML = [
    '<button type="button" class="sales-report-filter-all" data-otd-sales-all>All sales people</button>',
    ...options.map((item) => {
      const checked = selected.has(item.id) ? 'checked' : '';
      return `<label class="filter-dropdown-item"><input type="checkbox" value="${otdEscape(item.id)}" ${checked} /> ${otdEscape(item.label)}</label>`;
    }),
  ].join('');
}

function otdAggregate(rows, ppTypes) {
  const selected = ppTypes.length ? ppTypes : [...OTD_PS_TYPES];
  const months = Array.from({ length: 12 }, (_, idx) => otdEmptyMonth(idx + 1));
  const monthDays = Array.from({ length: 12 }, () => []);
  const monthLateDays = Array.from({ length: 12 }, () => []);
  const byPs = Object.fromEntries(selected.map((ppType) => [ppType, otdEmptyPs(ppType)]));
  const psDays = Object.fromEntries(selected.map((ppType) => [ppType, []]));
  const monthPs = months.map((monthRow) => ({
    month: monthRow.month,
    label: monthRow.label,
    series: Object.fromEntries(selected.map((ppType) => [ppType, {
      early: 0, on_time: 0, late: 0, classified: 0, on_time_rate: 0,
    }])),
  }));
  const summary = {
    early: 0, on_time: 0, late: 0, unclassified: 0, classified: 0,
    on_time_rate: 0, avg_days: null, avg_late_days: null,
    qty: 0, value: 0, process_sheet_count: rows.length,
  };
  const allDays = [];
  const lateDays = [];
  rows.forEach((row) => {
    const status = row.status || 'unclassified';
    const month = Number(row.month) || 0;
    const ppType = row.pp_type;
    const days = row.days;
    otdApplyStatusCount(summary, status);
    summary.qty += Number(row.qty) || 0;
    summary.value += Number(row.value) || 0;
    if (Number.isInteger(days)) {
      allDays.push(days);
      if (days > 0) lateDays.push(days);
    }
    if (month >= 1 && month <= 12) {
      otdApplyStatusCount(months[month - 1], status);
      if (Number.isInteger(days)) {
        monthDays[month - 1].push(days);
        if (days > 0) monthLateDays[month - 1].push(days);
      }
      if (monthPs[month - 1].series[ppType]) {
        otdApplyStatusCount(monthPs[month - 1].series[ppType], status);
      }
    }
    if (byPs[ppType]) {
      otdApplyStatusCount(byPs[ppType], status);
      if (Number.isInteger(days)) psDays[ppType].push(days);
    }
  });
  otdFinalizeCounts(summary, allDays, lateDays);
  summary.qty = Math.round(summary.qty * 10000) / 10000;
  summary.value = Math.round(summary.value * 100) / 100;
  months.forEach((monthRow, idx) => otdFinalizeCounts(monthRow, monthDays[idx], monthLateDays[idx]));
  selected.forEach((ppType) => otdFinalizeCounts(byPs[ppType], psDays[ppType], []));
  monthPs.forEach((block) => {
    Object.values(block.series).forEach((series) => {
      const classified = series.classified || 0;
      const onTime = (series.early || 0) + (series.on_time || 0);
      series.on_time_rate = classified ? onTime / classified : 0;
    });
  });
  return {
    year: otdState.year,
    pp_types: selected,
    summary,
    by_month: months,
    by_ps: selected.map((ppType) => byPs[ppType]),
    by_month_ps: monthPs,
    histogram: otdHistogram(rows),
    rows,
  };
}

function otdSyncPresets() {
  const current = [...otdState.ppTypes].sort().join(',');
  document.querySelectorAll('[data-otd-preset]').forEach((btn) => {
    const preset = OTD_PRESETS[btn.getAttribute('data-otd-preset')] || [];
    btn.classList.toggle('is-active', [...preset].sort().join(',') === current);
  });
}

function otdSetAlert(message) {
  const el = otdEl('otd-alert');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function otdEmptyChart(text) {
  return `<div class="otd-chart-empty">${otdEscape(text)}</div>`;
}

function otdLegend(items) {
  return `<div class="otd-legend">${items.map((item) => `
    <span class="otd-legend-item">
      <span class="otd-swatch" style="background:${item.color}"></span>${otdEscape(item.label)}
    </span>`).join('')}</div>`;
}

function otdPolar(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function otdDonutArc(cx, cy, r, r0, start, end) {
  const sweep = end - start;
  if (sweep >= 359.9) {
    return `M ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy}
            M ${cx + r0} ${cy} A ${r0} ${r0} 0 1 0 ${cx - r0} ${cy} A ${r0} ${r0} 0 1 0 ${cx + r0} ${cy}`;
  }
  const [sx, sy] = otdPolar(cx, cy, r, start);
  const [ex, ey] = otdPolar(cx, cy, r, end);
  const [sx0, sy0] = otdPolar(cx, cy, r0, end);
  const [ex0, ey0] = otdPolar(cx, cy, r0, start);
  const large = sweep > 180 ? 1 : 0;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey} L ${sx0} ${sy0} A ${r0} ${r0} 0 ${large} 0 ${ex0} ${ey0} Z`;
}

function otdNewPartsMetric() {
  const now = new Date();
  const month = otdState.selectedMonth
    || (otdState.year === now.getFullYear() ? now.getMonth() + 1 : null);
  const count = (otdState.sourceRows || []).filter((row) => {
    if (row.is_new_part !== true) return false;
    const delivery = otdDeliveryDate(row);
    if (!delivery || delivery.year !== otdState.year) return false;
    return month == null || delivery.month === month;
  }).length;
  const label = month == null
    ? String(otdState.year)
    : `${OTD_MONTH_LABELS[month - 1]} ${otdState.year}`;
  return { count, label };
}

function otdRenderKpis(summary, host = otdEl('otd-kpis')) {
  if (!host) return;
  const classified = summary.classified || 0;
  const onTime = (summary.early || 0) + (summary.on_time || 0);
  const newParts = otdNewPartsMetric();
  host.innerHTML = `
    <article class="sales-report-kpi otd-kpi--rate">
      <p class="sales-report-kpi-label">On-time rate</p>
      <p class="sales-report-kpi-value">${otdEscape(otdPct(summary.on_time_rate))}</p>
      <p class="sales-report-kpi-sub">${otdNum(onTime)} of ${otdNum(classified)} process sheets</p>
    </article>
    <article class="sales-report-kpi otd-kpi--new">
      <p class="sales-report-kpi-label">New parts done</p>
      <p class="sales-report-kpi-value">${otdNum(newParts.count)}</p>
      <p class="sales-report-kpi-sub">${otdEscape(newParts.label)} · labelled NEW, all prefixes</p>
    </article>
    <article class="sales-report-kpi otd-kpi--on-time">
      <p class="sales-report-kpi-label">On time / early</p>
      <p class="sales-report-kpi-value">${otdNum(onTime)}</p>
      <p class="sales-report-kpi-sub">${otdNum(summary.early)} early - ${otdNum(summary.on_time)} exact</p>
    </article>
    <article class="sales-report-kpi otd-kpi--late">
      <p class="sales-report-kpi-label">Late</p>
      <p class="sales-report-kpi-value">${otdNum(summary.late)}</p>
      <p class="sales-report-kpi-sub">Avg late ${summary.avg_late_days == null ? '-' : `${summary.avg_late_days}d`}</p>
    </article>
    <article class="sales-report-kpi otd-kpi--count">
      <p class="sales-report-kpi-label">Delivered PS</p>
      <p class="sales-report-kpi-value">${otdNum(summary.process_sheet_count)}</p>
      <p class="sales-report-kpi-sub">${otdNum(summary.qty)} pcs</p>
    </article>
    <article class="sales-report-kpi otd-kpi--days">
      <p class="sales-report-kpi-label">${otdState.benchmark === 'proposed_edd' ? 'Avg days vs EDD' : 'Avg days vs PO due'}</p>
      <p class="sales-report-kpi-value">${summary.avg_days == null ? '-' : otdDays(summary.avg_days)}</p>
      <p class="sales-report-kpi-sub">Negative is early</p>
    </article>`;
}

function otdRenderDonut(summary, host = otdEl('otd-donut')) {
  if (!host) return;
  const slices = [
    { id: 'early', value: summary.early || 0 },
    { id: 'on_time', value: summary.on_time || 0 },
    { id: 'late', value: summary.late || 0 },
  ].filter((item) => item.value > 0);
  const total = slices.reduce((sum, item) => sum + item.value, 0);
  if (!total) {
    host.innerHTML = otdEmptyChart('No classified process sheets.');
    return;
  }
  let angle = 0;
  const arcs = slices.map((item) => {
    const sweep = (item.value / total) * 360;
    const start = angle;
    const end = angle + sweep;
    angle = end;
    return `<path d="${otdDonutArc(80, 80, 72, 42, start, end)}" fill="${OTD_STATUS_COLORS[item.id]}">
      <title>${otdEscape(OTD_STATUS_LABELS[item.id])}: ${item.value}</title>
    </path>`;
  }).join('');
  const legend = slices.map((item) => `
    <div class="otd-mix-legend-row">
      <span class="otd-swatch" style="background:${OTD_STATUS_COLORS[item.id]}"></span>
      <span>${otdEscape(OTD_STATUS_LABELS[item.id])}</span>
      <strong>${item.value}</strong>
    </div>`).join('');
  host.innerHTML = `<div class="otd-mix-layout">
    <svg viewBox="0 0 160 160" role="img" aria-label="On time versus late">${arcs}
      <text x="80" y="76" text-anchor="middle" font-size="11" fill="#64748b">OTD</text>
      <text x="80" y="96" text-anchor="middle" font-size="16" font-weight="800" fill="#0f172a">${otdEscape(otdPct(summary.on_time_rate))}</text>
    </svg>
    <div class="otd-mix-legend">${legend}</div>
  </div>`;
}

function otdRenderMonthChart(months, host = otdEl('otd-month-chart'), { interactive = true } = {}) {
  if (!host) return;
  const W = 640;
  const H = 260;
  const left = 40;
  const right = 12;
  const top = 22;
  const bottom = 28;
  const innerW = W - left - right;
  const innerH = H - top - bottom;
  const gap = 6;
  const barW = Math.max(10, (innerW / months.length) - gap);
  const keys = ['early', 'on_time', 'late'];
  const yForShare = (share) => top + innerH - (share * innerH);
  const grid = [1, 0.5, 0].map((share) => {
    const y = yForShare(share);
    return `<line x1="${left}" y1="${y.toFixed(1)}" x2="${W - right}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>
      <text x="${left - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#64748b">${Math.round(share * 100)}%</text>`;
  }).join('');
  const columns = months.map((row, idx) => {
    const x = left + idx * (innerW / months.length) + gap / 2;
    const total = (row.early || 0) + (row.on_time || 0) + (row.late || 0);
    const rateX = x + barW / 2;
    const tick = `${row.label} ${String(otdState.year).slice(-2)}`;
    const tickText = `<text x="${rateX.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9" fill="#334155">${otdEscape(tick)}</text>`;
    if (!total) return tickText;
    let cursor = top + innerH;
    let remaining = innerH;
    const present = keys.filter((key) => (row[key] || 0) > 0);
    const stacks = present.map((key, keyIdx) => {
      const val = row[key] || 0;
      const h = keyIdx === present.length - 1 ? remaining : (val / total) * innerH;
      remaining -= h;
      cursor -= h;
      if (h < 0.4) return '';
      const selected = interactive && otdState.selectedMonth === row.month;
      const chipClass = interactive ? 'otd-month-chip' : '';
      const monthAttr = interactive ? `data-month="${row.month}"` : '';
      return `<rect class="${chipClass}" ${monthAttr} x="${x.toFixed(1)}" y="${cursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${OTD_STATUS_COLORS[key]}" rx="1" opacity="${!interactive || selected || otdState.selectedMonth == null ? 1 : 0.45}">
        <title>${otdEscape(row.label)} ${otdEscape(OTD_STATUS_LABELS[key])}: ${otdEscape(otdPct(val / total))} (${val})</title>
      </rect>`;
    }).join('');
    const rate = row.on_time_rate;
    const rateDot = `<circle cx="${rateX.toFixed(1)}" cy="${yForShare(rate).toFixed(1)}" r="2.4" fill="#0f172a">
      <title>${otdEscape(row.label)} on time ${otdEscape(otdPct(rate))} (${(row.early || 0) + (row.on_time || 0)} of ${total})</title>
    </circle>`;
    const rateLabel = `<text x="${rateX.toFixed(1)}" y="12" text-anchor="middle" font-size="9" font-weight="700" fill="#0f172a">${Math.round(rate * 100)}%</text>`;
    return `${stacks}${rateDot}${rateLabel}${tickText}`;
  }).join('');
  const linePts = months.map((row, idx) => {
    const total = (row.early || 0) + (row.on_time || 0) + (row.late || 0);
    if (!total) return null;
    const x = left + idx * (innerW / months.length) + gap / 2 + barW / 2;
    return `${x.toFixed(1)},${yForShare(row.on_time_rate).toFixed(1)}`;
  }).filter(Boolean).join(' ');
  const line = linePts ? `<polyline fill="none" stroke="#0f172a" stroke-width="1.5" points="${linePts}"/>` : '';
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly on-time delivery share">
    ${grid}
    ${line}
    ${columns}
  </svg>${otdLegend([
    { color: OTD_STATUS_COLORS.early, label: 'Early' },
    { color: OTD_STATUS_COLORS.on_time, label: 'On time' },
    { color: OTD_STATUS_COLORS.late, label: 'Late' },
  ])}`;
}

function otdResultSentence(summary) {
  const onTime = (summary.early || 0) + (summary.on_time || 0);
  const classified = summary.classified || 0;
  const late = summary.late || 0;
  const lateBit = summary.avg_late_days == null ? '' : `, late by ${summary.avg_late_days} days on average`;
  return `${otdNum(onTime)} of ${otdNum(classified)} were on time (${otdPct(summary.on_time_rate)}). ${otdNum(late)} were late${lateBit}.`;
}

function otdRenderPsChart(rows, host = otdEl('otd-ps-chart')) {
  if (!host) return;
  const items = (rows || []).filter((row) => (row.classified || 0) > 0);
  const year = otdState.year;
  if (!items.length) {
    host.innerHTML = `<p class="otd-plain">No ${year} process sheets in this segment.</p>`;
    return;
  }
  host.innerHTML = `<ul class="otd-ps-sentences">${items.map((row) => {
    const onTime = (row.early || 0) + (row.on_time || 0);
    return `<li><button type="button" class="otd-ps-sentence" data-ps="${otdEscape(row.id)}">
      <strong>${otdEscape(row.label)}</strong> in ${year}: ${otdEscape(otdPct(row.on_time_rate))} on time,
      ${otdNum(onTime)} of ${otdNum(row.classified)}. ${otdNum(row.late)} late.
    </button></li>`;
  }).join('')}</ul>`;
}

function otdRenderMonthTable(months, host = otdEl('otd-month-table')) {
  if (!host) return;
  const filled = (months || []).filter((row) => (row.classified || 0) > 0);
  if (!filled.length) {
    host.innerHTML = '';
    return;
  }
  const body = filled.map((row) => {
    const onTime = (row.early || 0) + (row.on_time || 0);
    const active = otdState.selectedMonth === row.month ? ' is-active' : '';
    return `<tr>
      <td><button type="button" class="otd-month-link${active}" data-month="${row.month}">${otdEscape(row.label)} ${otdState.year}</button></td>
      <td>${otdNum(onTime)}</td>
      <td>${otdNum(row.late)}</td>
      <td>${otdNum(row.classified)}</td>
      <td>${otdEscape(otdPct(row.on_time_rate))}</td>
    </tr>`;
  }).join('');
  host.innerHTML = `<table class="otd-month-numbers">
    <thead><tr><th>Month</th><th>On time</th><th>Late</th><th>Shipped</th><th>On-time rate</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function otdRenderMonthPsChart(blocks, ppTypes, host = otdEl('otd-month-ps-chart')) {
  if (!host) return;
  const types = (ppTypes || []).filter((ppType) =>
    (blocks || []).some((block) => (block.series?.[ppType]?.classified || 0) > 0)
  );
  if (!types.length) {
    host.innerHTML = otdEmptyChart('No monthly PS-type rates for this filter.');
    return;
  }
  const W = 640;
  const H = 220;
  const left = 36;
  const right = 12;
  const top = 12;
  const bottom = 28;
  const innerW = W - left - right;
  const innerH = H - top - bottom;
  const months = blocks || [];
  const lines = types.map((ppType) => {
    const color = OTD_PP_COLORS[ppType] || '#64748b';
    const points = months.map((block, idx) => {
      const series = block.series?.[ppType] || {};
      if (!series.classified) return null;
      const x = left + (months.length === 1 ? innerW / 2 : (idx / (months.length - 1)) * innerW);
      const y = top + innerH - (series.on_time_rate * innerH);
      return { x, y };
    }).filter(Boolean);
    if (!points.length) return '';
    const pts = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    const line = points.length > 1
      ? `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/>`
      : '';
    const dots = points.map((point) =>
      `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3" fill="${color}"/>`
    ).join('');
    return `${line}${dots}`;
  }).join('');
  const ticks = months.map((block, idx) => {
    const x = left + (months.length === 1 ? innerW / 2 : (idx / (months.length - 1)) * innerW);
    const tick = `${block.label} ${String(otdState.year).slice(-2)}`;
    return `<text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#64748b">${otdEscape(tick)}</text>`;
  }).join('');
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly OTD rate by PS type">
    <line x1="${left}" x2="${W - right}" y1="${top}" y2="${top}" stroke="#e2e8f0"/>
    <line x1="${left}" x2="${W - right}" y1="${top + innerH / 2}" y2="${top + innerH / 2}" stroke="#e2e8f0"/>
    <line x1="${left}" x2="${W - right}" y1="${top + innerH}" y2="${top + innerH}" stroke="#e2e8f0"/>
    <text x="${left - 6}" y="${top + 4}" text-anchor="end" font-size="10" fill="#64748b">100%</text>
    <text x="${left - 6}" y="${top + innerH / 2 + 4}" text-anchor="end" font-size="10" fill="#64748b">50%</text>
    <text x="${left - 6}" y="${top + innerH + 4}" text-anchor="end" font-size="10" fill="#64748b">0%</text>
    ${lines}${ticks}
  </svg>${otdLegend(types.map((ppType) => ({ color: OTD_PP_COLORS[ppType], label: otdPsLabel(ppType) })))}`;
}

function otdRenderHist(payload, host = otdEl('otd-hist-chart'), sub = otdEl('otd-hist-sub')) {
  if (!host) return;
  const phrase = otdBenchmarkName();
  if (sub) {
    sub.textContent = payload.classified
      ? `On time (delivery on or before ${phrase}): ${otdPct(payload.on_time_rate)} of ${payload.classified} process sheets`
      : `Last delivery minus ${phrase} (negative = early)`;
  }
  const buckets = payload.buckets || [];
  const max = Math.max(0, ...buckets.map((bucket) => bucket.count));
  if (!max) {
    host.innerHTML = otdEmptyChart(`No process sheets with both ${otdBenchmarkName()} and a delivery date.`);
    return;
  }
  const W = 640;
  const H = 220;
  const left = 28;
  const right = 12;
  const top = 18;
  const bottom = 32;
  const innerW = W - left - right;
  const innerH = H - top - bottom;
  const gap = 10;
  const barW = Math.max(12, (innerW / buckets.length) - gap);
  const cols = buckets.map((bucket, idx) => {
    const x = left + idx * (innerW / buckets.length) + gap / 2;
    const h = (bucket.count / max) * innerH;
    const y = top + innerH - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 0).toFixed(1)}" rx="2" fill="${OTD_HIST_COLORS[bucket.id] || '#64748b'}">
        <title>${otdEscape(bucket.label)} days: ${bucket.count}</title>
      </rect>
      <text x="${(x + barW / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#64748b">${otdEscape(bucket.label)}</text>
      <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="#334155">${bucket.count ? bucket.count : ''}</text>`;
  }).join('');
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Days versus ${otdEscape(otdBenchmarkName())}">${cols}</svg>`;
}

function otdVisibleRows() {
  const rows = otdState.data?.rows || [];
  const q = otdState.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (otdState.statusFilter === 'late' && row.status !== 'late') return false;
    if (otdState.statusFilter === 'on_time' && !row.on_time) return false;
    if (!q) return true;
    const hay = [
      row.process_sheet_no, row.sales_order_no, row.inventory_code,
      row.description, row.customer_name, row.customer_code, row.pp_type,
      row.sales_person_name, row.sales_person_code, row.sales_person_label,
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function otdStatusClass(status) {
  if (status === 'early' || status === 'on_time' || status === 'late') return status;
  return 'unclassified';
}

function otdRenderTable() {
  const body = otdEl('otd-table-body');
  const hint = otdEl('otd-table-hint');
  if (!body) return;
  const rows = otdVisibleRows();
  if (hint) {
    const bits = [`${rows.length} process sheet${rows.length === 1 ? '' : 's'}`];
    if (otdState.selectedMonth) bits.push(`month ${otdState.selectedMonth}`);
    if (otdState.selectedPs) bits.push(otdPsLabel(otdState.selectedPs));
    if (otdState.statusFilter !== 'all') bits.push(otdState.statusFilter === 'late' ? 'late only' : 'on time only');
    hint.textContent = `${bits.join(' - ')}. Click a month or process sheet type to filter; click again to clear.`;
  }
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="11">No process sheets match this table filter.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((row) => {
    const status = otdStatusClass(row.status);
    const daysClass = row.days > 0 ? 'otd-days--late' : (row.days < 0 ? 'otd-days--early' : '');
    return `<tr>
      <td><strong>${otdEscape(row.process_sheet_no || '-')}</strong></td>
      <td>${otdEscape(row.pp_type_label || otdPsLabel(row.pp_type))}</td>
      <td>${otdEscape(row.sales_order_no || '-')}</td>
      <td>${otdEscape(row.customer_name || row.customer_code || '-')}</td>
      <td>${otdEscape(row.sales_person_label || otdSalespersonLabel(row))}</td>
      <td>${otdEscape(row.inventory_code || '-')}${row.is_new_part ? ' <span class="otd-new-badge" title="No earlier process sheet for this part on another sales order">NEW</span>' : ''}</td>
      <td>${otdEscape((row.po_due_date || '').slice(0, 10) || '-')}</td>
      <td>${otdEscape((row.proposed_edd || row.coway_proposed_edd || '').slice(0, 10) || '-')}</td>
      <td>${otdEscape((row.delivery_date || '').slice(0, 10) || '-')}</td>
      <td class="${daysClass}">${otdEscape(otdDays(row.days))}</td>
      <td><span class="otd-status otd-status--${status}">${otdEscape(otdStatusLabel(status))}</span></td>
    </tr>`;
  }).join('');
}

function otdOverviewRows(spec) {
  const types = new Set(spec.ppTypes || []);
  return (otdState.sourceRows || []).map(otdPrepareRow).filter(Boolean).filter((row) => {
    if (row.segment !== 'due' || row.delivery_year !== otdState.year) return false;
    if (types.size && !types.has(row.pp_type)) return false;
    return otdSalesContains(row, spec.salesContains);
  });
}

function otdBuildOverview() {
  return OTD_OVERVIEW_SECTIONS.map((spec) => {
    const rows = otdOverviewRows(spec);
    const payload = otdAggregate(rows, spec.ppTypes);
    return {
      ...spec,
      ...payload,
    };
  });
}

function otdSetTab(tab) {
  otdState.tab = tab === 'overview' ? 'overview' : 'detail';
  const page = document.querySelector('.otd-page');
  page?.classList.toggle('is-overview', otdState.tab === 'overview');
  page?.classList.toggle('is-detail', otdState.tab === 'detail');
  document.querySelectorAll('[data-otd-tab]').forEach((btn) => {
    const active = btn.getAttribute('data-otd-tab') === otdState.tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const detail = otdEl('otd-detail-panel');
  const overview = otdEl('otd-overview-panel');
  const overviewContext = otdEl('otd-overview-context');
  if (detail) detail.hidden = otdState.loading || otdState.tab !== 'detail';
  if (overview) overview.hidden = otdState.loading || otdState.tab !== 'overview';
  if (overviewContext) overviewContext.hidden = otdState.tab !== 'overview';
}

function otdRenderOverviewCompare(sections) {
  const host = otdEl('otd-overview-compare');
  if (!host) return;
  host.innerHTML = sections.map((section) => {
    const summary = section.summary || {};
    const classified = summary.classified || 0;
    const onTime = (summary.early || 0) + (summary.on_time || 0);
    return `<article class="otd-overview-kpi otd-overview-kpi--${otdEscape(section.id)}">
      <p class="otd-overview-kpi-label">${otdEscape(section.subtitle)}</p>
      <p class="otd-overview-kpi-title">${otdEscape(section.label)}</p>
      <p class="otd-overview-kpi-value">${otdEscape(otdPct(summary.on_time_rate))}</p>
      <p class="otd-overview-kpi-sub">${otdNum(onTime)} of ${otdNum(classified)} due in ${otdState.year} and shipped in ${otdState.year}. ${otdNum(summary.late)} late.</p>
    </article>`;
  }).join('');
}

function otdRenderOverviewTrend(sections) {
  const wrap = otdEl('otd-overview-trend-wrap');
  const host = otdEl('otd-overview-trend');
  if (!wrap || !host) return;
  const months = Array.from({ length: 12 }, (_, idx) => ({
    month: idx + 1,
    label: OTD_MONTH_LABELS[idx],
    series: {},
  }));
  const types = [];
  sections.forEach((section) => {
    const ppType = section.ppTypes?.[0];
    if (!ppType) return;
    types.push(ppType);
    (section.by_month || []).forEach((row, idx) => {
      months[idx].series[ppType] = {
        classified: row.classified || 0,
        on_time_rate: row.on_time_rate || 0,
      };
    });
  });
  const hasData = types.some((ppType) =>
    months.some((block) => (block.series?.[ppType]?.classified || 0) > 0)
  );
  wrap.hidden = !hasData;
  if (!hasData) {
    host.innerHTML = '';
    return;
  }
  otdRenderMonthPsChart(months, types, host);
}

function otdRenderOverviewSections(sections) {
  const host = otdEl('otd-overview-sections');
  if (!host) return;
  host.innerHTML = sections.map((section) => {
    const classified = section.summary?.classified || 0;
    const onTime = (section.summary?.early || 0) + (section.summary?.on_time || 0);
    const body = classified
      ? `<p class="otd-plain">${otdEscape(section.label)} in ${otdState.year}: ${otdNum(onTime)} of ${otdNum(classified)} sheets whose ${otdEscape(otdBenchmarkName())} is in ${otdState.year}, and which were also shipped in ${otdState.year}, were on time (${otdEscape(otdPct(section.summary?.on_time_rate))}). ${otdNum(section.summary?.late)} were late.</p>
        <div data-otd-section-table></div>
        <div class="otd-chart-body otd-chart-body--tall" data-otd-section-month></div>`
      : `<div class="otd-overview-empty">No ${otdEscape(section.label)} sheets were both due in ${otdState.year} and shipped in ${otdState.year}${section.salesContains ? ` for ${otdEscape(section.subtitle)}` : ''}.</div>`;
    return `<section class="otd-overview-block" data-otd-section="${otdEscape(section.id)}">
      <header class="otd-overview-block-head">
        <h2 class="otd-overview-block-title">${otdEscape(section.label)}</h2>
        <p class="otd-overview-block-sub">${otdEscape(section.subtitle)} · due in ${otdState.year} and shipped in ${otdState.year} · ${otdNum(classified)} process sheets</p>
      </header>
      ${body}
    </section>`;
  }).join('');
  host.querySelectorAll('[data-otd-section]').forEach((block) => {
    const section = sections.find((item) => item.id === block.getAttribute('data-otd-section'));
    if (!section || !(section.summary?.classified)) return;
    otdRenderMonthTable(section.by_month || [], block.querySelector('[data-otd-section-table]'));
    otdRenderMonthChart(section.by_month || [], block.querySelector('[data-otd-section-month]'), { interactive: false });
  });
}

function otdRenderOverview() {
  const sections = otdState.overview || [];
  otdRenderOverviewCompare(sections);
  otdRenderOverviewTrend(sections);
  otdRenderOverviewSections(sections);
}

function otdRenderYearCopy() {
  const year = otdState.year;
  const phrase = otdBenchmarkName();
  const summary = otdState.data?.summary;
  const summaryEl = otdEl('otd-summary');
  const outsideEl = otdEl('otd-outside');
  const monthTitle = otdEl('otd-month-title');
  const monthSub = otdEl('otd-month-sub');
  if (monthTitle) {
    monthTitle.textContent = otdState.segment === 'due'
      ? `Shipped in ${year}, ${phrase} also in ${year}`
      : `Shipped in ${year}`;
  }
  if (monthSub) {
    const share = 'Each month is the share of early, on time, and late, so bars with deliveries are the same height. Hover a segment for the count.';
    monthSub.textContent = otdState.segment === 'due'
      ? `${share} ${year} shipments only. A sheet whose ${phrase} is in ${year} but which shipped in another year is left out of the bars.`
      : `${share} These were shipped in ${year}. Their ${phrase} is not in ${year}.`;
  }
  if (summaryEl) {
    if (!summary || !(summary.classified || summary.process_sheet_count)) {
      summaryEl.textContent = `No sheets in this ${year} segment.`;
    } else if (otdState.segment === 'due') {
      summaryEl.textContent = `In ${year}, for sheets whose ${phrase} is in ${year} and which were also shipped in ${year}: ${otdResultSentence(summary)}`;
    } else {
      summaryEl.textContent = `Shipped in ${year}, kept separate from the ${year} due-date result. ${otdResultSentence(summary)}`;
    }
  }
  if (outsideEl) {
    const outside = otdOutsideYearRows();
    if (!outside.length) {
      outsideEl.hidden = true;
      outsideEl.textContent = '';
    } else {
      const byYear = new Map();
      outside.forEach((row) => {
        const key = row.delivery_year || 'an unknown year';
        byYear.set(key, (byYear.get(key) || 0) + 1);
      });
      const bits = [...byYear.entries()]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([shipYear, count]) => `${count} shipped in ${shipYear}`);
      outsideEl.hidden = false;
      outsideEl.textContent = `${outside.length} other sheets have a ${phrase} in ${year} but were last shipped outside ${year} (${bits.join(', ')}). They are not in the chart or the table.`;
    }
  }
  const noBench = document.querySelector('[data-otd-segment="no_benchmark"]');
  if (noBench) noBench.hidden = true;
  document.querySelectorAll('[data-otd-segment]').forEach((btn) => {
    const id = btn.getAttribute('data-otd-segment');
    btn.classList.toggle('is-active', id === otdState.segment);
    const countEl = btn.querySelector('[data-otd-segment-count]');
    if (!countEl) return;
    const rows = otdCandidateRows().filter((row) => row.segment === id && (id !== 'due' || row.delivery_year === year));
    const classified = rows.filter((row) => row.status === 'early' || row.status === 'on_time' || row.status === 'late').length;
    const onTime = rows.filter((row) => row.on_time).length;
    countEl.textContent = classified ? `${otdPct(onTime / classified)} on time · ${onTime} of ${classified}` : `None in ${year}`;
  });
}

function otdRender() {
  const data = otdState.data;
  const hasRows = Boolean(data?.summary?.process_sheet_count);
  const overviewHasRows = (otdState.overview || []).some((section) => (section.summary?.classified || 0) > 0);
  const loading = otdEl('otd-loading');
  const empty = otdEl('otd-empty');
  const kpis = otdEl('otd-kpis');
  const charts = otdEl('otd-charts');
  const table = otdEl('otd-table-wrap');
  const meta = otdEl('otd-meta');
  const context = otdEl('otd-context');
  const showDetail = !otdState.loading && hasRows && otdState.tab === 'detail';
  const showOverviewEmpty = !otdState.loading && otdState.tab === 'overview' && !overviewHasRows;
  if (loading) loading.hidden = otdState.loading === false;
  if (empty) {
    empty.hidden = otdState.loading || Boolean(otdEl('otd-alert')?.textContent) || (otdState.tab === 'detail' ? hasRows : overviewHasRows);
    if (!empty.hidden && showOverviewEmpty) {
      empty.querySelector('p').textContent = 'No fully shipped APS, NPS, or PPS (Alice) process sheets for this year.';
    } else if (!empty.hidden) {
      empty.querySelector('p').textContent = 'No delivered process sheets match this filter.';
    }
  }
  if (kpis) kpis.hidden = !showDetail;
  if (charts) charts.hidden = !showDetail;
  if (table) table.hidden = !showDetail;
  const phrase = otdBenchmarkName();
  if (context) {
    const types = otdAllTypesSelected()
      ? 'All PS types'
      : OTD_PS_TYPES.filter((item) => otdState.ppTypes.has(item)).map(otdPsLabel).join(', ') || 'None';
    const people = !otdState.salespersons.size
      ? ''
      : (otdState.salespersons.size === 1
        ? (otdState.salespersonOptions.find((item) => otdState.salespersons.has(item.id))?.label || '1 sales person')
        : `${otdState.salespersons.size} sales people`);
    const segmentText = {
      due: `${phrase} in ${otdState.year}, shipped in ${otdState.year}`,
      carried_in: `shipped in ${otdState.year}, ${phrase} before ${otdState.year}`,
      early_ship: `shipped in ${otdState.year}, ${phrase} after ${otdState.year}`,
      no_benchmark: `shipped in ${otdState.year}, no ${phrase}`,
    }[otdState.segment] || phrase;
    context.textContent = people ? `${segmentText} - ${types} - ${people}` : `${segmentText} - ${types}`;
  }
  otdRenderYearCopy();
  const daysHead = otdEl('otd-days-head');
  if (daysHead) daysHead.textContent = otdState.benchmark === 'proposed_edd' ? 'Days vs EDD' : 'Days vs PO';
  const donutSub = otdEl('otd-donut-sub');
  if (donutSub) donutSub.textContent = `Share of process sheets delivered on or before ${phrase}`;
  const histTitle = otdEl('otd-hist-title');
  if (histTitle) histTitle.textContent = `Days vs ${phrase}`;
  const trendSub = otdEl('otd-overview-trend-sub');
  if (trendSub) trendSub.textContent = `${otdState.year} only. Due in ${otdState.year} and shipped in ${otdState.year}, for APS, NPS, and PPS (Alice).`;
  otdSyncBenchmark();
  otdRenderBenchmarkRef();
  if (meta) {
    meta.hidden = !data;
    if (data) {
      meta.textContent = `${otdState.year} only - ${otdNum(data.summary?.classified)} sheets in this segment`;
    }
  }
  otdSetTab(otdState.tab);
  if (otdState.tab === 'overview' && !otdState.loading) {
    otdRenderOverview();
    return;
  }
  if (!hasRows) return;
  otdRenderKpis(data.summary || {});
  otdRenderMonthChart(data.by_month || []);
  otdRenderMonthTable(data.by_month || []);
  otdRenderPsChart(data.by_ps || []);
  otdRenderTable();
}

async function otdFetch(refresh = false) {
  const gen = ++otdState.fetchGen;
  otdState.loading = true;
  otdSetAlert('');
  otdRender();
  const params = new URLSearchParams({
    year: String(otdState.year),
    pp_types: 'ALL',
  });
  if (refresh) params.set('refresh', '1');
  try {
    const resp = await (window.reportsApiFetch || fetch)(`/api/on-time-delivery/report?${params}`);
    const payload = await resp.json().catch(() => ({}));
    if (gen !== otdState.fetchGen) return;
    if (!resp.ok || !payload.ok) {
      throw new Error(payload.error || `Request failed (${resp.status})`);
    }
    otdState.sourceRows = payload.source_rows || payload.rows || [];
    otdState.selectedMonth = null;
    otdState.selectedPs = null;
    otdState.loading = false;
    otdApplyFilters();
  } catch (err) {
    if (gen !== otdState.fetchGen) return;
    otdState.sourceRows = [];
    otdState.data = null;
    otdState.loading = false;
    otdSetAlert(err?.message || 'Failed to load on-time delivery.');
    otdRender();
  }
}

function otdSyncBenchmark() {
  document.querySelectorAll('[data-otd-benchmark]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-otd-benchmark') === otdState.benchmark);
  });
}

function otdRenderBenchmarkRef() {
  const host = otdEl('otd-benchmark-ref');
  if (!host) return;
  const population = otdScopedRows();
  if (!population.length) {
    host.textContent = `No ${otdState.year} sheets in this segment yet.`;
    return;
  }
  const selected = otdSelectedTypeList();
  const po = otdAggregate(population.map((row) => otdAsBenchmark(row, 'po_due')), selected).summary;
  const edd = otdAggregate(population.map((row) => otdAsBenchmark(row, 'proposed_edd')), selected).summary;
  const missing = population.filter((row) => !otdCompact(row.proposed_edd || row.coway_proposed_edd)).length;
  const poOn = (po.early || 0) + (po.on_time || 0);
  const eddOn = (edd.early || 0) + (edd.on_time || 0);
  const poActive = otdState.benchmark !== 'proposed_edd';
  const missingNote = missing ? ` · ${otdNum(missing)} blank, scored on PO due` : '';
  host.innerHTML = `
    <span class="${poActive ? 'is-active' : ''}"><strong>PO due</strong> ${otdEscape(otdPct(po.on_time_rate))} on time (${otdNum(poOn)} / ${otdNum(po.classified)})</span>
    <span class="otd-benchmark-sep">·</span>
    <span class="${poActive ? '' : 'is-active'}"><strong>Proposed EDD</strong> ${otdEscape(otdPct(edd.on_time_rate))} on time (${otdNum(eddOn)} / ${otdNum(edd.classified)})${otdEscape(missingNote)}</span>`;
}

function otdExportCsv() {
  const rows = otdVisibleRows();
  const header = [
    'process_sheet', 'ps_type', 'sales_order', 'customer', 'sales_person', 'part',
    'po_due', 'proposed_edd', 'delivery', 'days_vs_po', 'days_vs_edd', 'benchmark', 'status',
  ];
  const lines = [header.join(',')];
  rows.forEach((row) => {
    const poDays = otdDaysBetween(row.delivery_date, row.po_due_date);
    const eddDays = otdDaysBetween(row.delivery_date, row.proposed_edd || row.coway_proposed_edd);
    const cells = [
      row.process_sheet_no, row.pp_type, row.sales_order_no,
      row.customer_name || row.customer_code,
      row.sales_person_label || row.sales_person_name || row.sales_person_code,
      row.inventory_code,
      row.po_due_date,
      row.proposed_edd || row.coway_proposed_edd,
      row.delivery_date,
      poDays,
      eddDays,
      otdState.benchmark,
      row.status,
    ].map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`);
    lines.push(cells.join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `on-time-delivery-${otdState.year}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function otdExportPdf() {
  const btn = otdEl('otd-export-pdf');
  if (btn) btn.disabled = true;
  otdSetAlert('');
  const params = new URLSearchParams({
    year: String(otdState.year),
    pp_types: otdTypesQuery(),
    benchmark: otdState.benchmark,
    view: otdState.tab,
    segment: otdState.tab === 'overview' ? 'due' : otdState.segment,
  });
  if (otdState.salespersons.size) params.set('sales_persons', [...otdState.salespersons].join(','));
  if (otdState.tab === 'detail') {
    if (otdState.statusFilter && otdState.statusFilter !== 'all') params.set('status', otdState.statusFilter);
    if (otdState.search.trim()) params.set('q', otdState.search.trim());
    if (otdState.selectedMonth) params.set('month', String(otdState.selectedMonth));
    if (otdState.selectedPs) params.set('ps', otdState.selectedPs);
  }
  try {
    const resp = await (window.reportsApiFetch || fetch)(`/api/on-time-delivery/report.pdf?${params}`);
    if (!resp.ok) {
      const payload = await resp.json().catch(() => ({}));
      throw new Error(payload.error || `PDF failed (${resp.status})`);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const slug = otdState.benchmark === 'proposed_edd' ? 'proposed-edd' : 'po-due';
    link.download = `on-time-delivery-${otdState.year}-${slug}.pdf`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    otdSetAlert(err?.message || 'Failed to export PDF.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function otdHistorySheetRows(sheets) {
  if (!sheets.length) {
    return '<p class="otd-history-empty">No process sheets were labelled NEW in this month.</p>';
  }
  const body = sheets.map((row) => `<tr>
    <td>${otdEscape(row.process_sheet_no || '-')}</td>
    <td>${otdEscape(row.pp_type || '-')}</td>
    <td>${otdEscape(row.sales_order_no || '-')}</td>
    <td>${otdEscape(row.inventory_code || '-')}</td>
    <td>${otdEscape(row.customer_name || '-')}</td>
    <td>${otdEscape((row.delivery_date || '').slice(0, 10) || '-')}</td>
  </tr>`).join('');
  return `<table class="otd-history-table">
    <thead><tr><th>Process sheet</th><th>PS</th><th>Sales order</th><th>Part</th><th>Customer</th><th>Delivery</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function otdRenderHistory(snapshots) {
  const body = otdEl('otd-history-body');
  if (!body) return;
  if (!snapshots.length) {
    body.innerHTML = '<p class="otd-history-empty">No month has been saved yet. The previous month is written after it closes, the next time this app is running.</p>';
    return;
  }
  body.innerHTML = snapshots.map((item) => {
    const saved = item.snapshotted_at ? item.snapshotted_at.slice(0, 10) : '';
    const late = item.saved_late
      ? ' Saved after the month had already closed, so a repeat order raised before the save can drop a NEW label.'
      : '';
    return `<details class="otd-history-month">
      <summary>
        <strong>${otdEscape(item.label)}</strong>
        <span>${otdNum(item.new_part_count)} new parts</span>
        <span>${otdNum(item.delivered_count)} delivered</span>
        ${saved ? `<span>saved ${otdEscape(saved)}</span>` : ''}
      </summary>
      ${late ? `<p class="otd-history-late">${otdEscape(late.trim())}</p>` : ''}
      ${otdHistorySheetRows(item.sheets || [])}
    </details>`;
  }).join('');
}

async function otdToggleHistory() {
  const panel = otdEl('otd-history-panel');
  const button = otdEl('otd-history');
  if (!panel) return;
  const nextOpen = panel.hidden;
  panel.hidden = !nextOpen;
  button?.classList.toggle('is-active', nextOpen);
  button?.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  if (!nextOpen) return;
  const body = otdEl('otd-history-body');
  if (body) body.innerHTML = '<p class="otd-history-empty">Loading saved months...</p>';
  try {
    const resp = await (window.reportsApiFetch || fetch)('/api/on-time-delivery/new-parts/history');
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.ok) throw new Error(payload.error || `Request failed (${resp.status})`);
    otdRenderHistory(payload.snapshots || []);
  } catch (err) {
    if (body) body.innerHTML = `<p class="otd-history-empty">${otdEscape(err?.message || 'Could not load saved months.')}</p>`;
  }
}

function otdBind() {
  const yearInput = otdEl('otd-year');
  if (yearInput) {
    yearInput.value = String(otdState.year);
    yearInput.addEventListener('change', () => {
      const year = Number(yearInput.value);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) return;
      otdState.year = year;
      otdFetch();
    });
  }
  document.querySelectorAll('[data-otd-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      otdSetTab(btn.getAttribute('data-otd-tab'));
      otdRender();
    });
  });
  document.querySelectorAll('[data-otd-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = OTD_PRESETS[btn.getAttribute('data-otd-preset')] || ['APS', 'NPS'];
      otdState.ppTypes = new Set(preset);
      otdState.selectedMonth = null;
      otdState.selectedPs = null;
      otdSyncPsCheckboxes();
      otdSyncPresets();
      otdApplyFilters();
    });
  });
  const panel = otdEl('otd-ps-type-panel');
  const typeBtn = otdEl('otd-ps-type-btn');
  const salesPanel = otdEl('otd-salesperson-panel');
  const salesBtn = otdEl('otd-salesperson-btn');
  const closeOtdDropdowns = (except) => {
    if (panel && except !== panel) panel.hidden = true;
    if (salesPanel && except !== salesPanel) salesPanel.hidden = true;
  };
  typeBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!panel) return;
    const nextHidden = !panel.hidden;
    closeOtdDropdowns(panel);
    panel.hidden = nextHidden;
  });
  panel?.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) otdState.ppTypes.add(input.value);
      else otdState.ppTypes.delete(input.value);
      if (!otdState.ppTypes.size) otdState.ppTypes.add(input.value);
      otdState.selectedMonth = null;
      otdState.selectedPs = null;
      otdSyncPsCheckboxes();
      otdSyncPresets();
      otdApplyFilters();
    });
  });
  salesBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!salesPanel) return;
    const nextHidden = !salesPanel.hidden;
    closeOtdDropdowns(salesPanel);
    salesPanel.hidden = nextHidden;
  });
  salesPanel?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!event.target.closest?.('[data-otd-sales-all]')) return;
    otdState.salespersons.clear();
    otdState.selectedMonth = null;
    otdState.selectedPs = null;
    otdApplyFilters();
  });
  salesPanel?.addEventListener('change', (event) => {
    const input = event.target.closest?.('input[type="checkbox"]');
    if (!input) return;
    if (input.checked) otdState.salespersons.add(input.value);
    else otdState.salespersons.delete(input.value);
    otdState.selectedMonth = null;
    otdState.selectedPs = null;
    otdApplyFilters();
  });
  document.addEventListener('click', (event) => {
    const typeDropdown = otdEl('otd-ps-type-dropdown');
    const salesDropdown = otdEl('otd-salesperson-dropdown');
    if (typeDropdown && !typeDropdown.contains(event.target)) panel && (panel.hidden = true);
    if (salesDropdown && !salesDropdown.contains(event.target)) salesPanel && (salesPanel.hidden = true);
  });
  document.querySelectorAll('[data-otd-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      otdState.statusFilter = btn.getAttribute('data-otd-status') || 'all';
      document.querySelectorAll('[data-otd-status]').forEach((el) => {
        el.classList.toggle('is-active', el === btn);
      });
      otdRenderTable();
    });
  });
  otdEl('otd-search')?.addEventListener('input', (event) => {
    otdState.search = event.target.value || '';
    otdRenderTable();
  });
  document.querySelectorAll('[data-otd-benchmark]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-otd-benchmark') || 'po_due';
      if (next === otdState.benchmark) return;
      otdState.benchmark = next;
      if (next !== 'proposed_edd' && otdState.segment === 'no_benchmark') otdState.segment = 'due';
      otdState.selectedMonth = null;
      otdState.selectedPs = null;
      otdApplyFilters();
    });
  });
  document.querySelectorAll('[data-otd-segment]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-otd-segment') || 'due';
      if (next === otdState.segment) return;
      otdState.segment = next;
      otdState.selectedMonth = null;
      otdState.selectedPs = null;
      otdApplyFilters();
    });
  });
  otdEl('otd-refresh')?.addEventListener('click', () => otdFetch(true));
  otdEl('otd-export')?.addEventListener('click', otdExportCsv);
  otdEl('otd-export-pdf')?.addEventListener('click', otdExportPdf);
  otdEl('otd-history')?.addEventListener('click', () => otdToggleHistory());
  document.addEventListener('click', (event) => {
    const monthBtn = event.target.closest?.('[data-month]');
    if (monthBtn) {
      const month = Number(monthBtn.getAttribute('data-month'));
      otdState.selectedMonth = otdState.selectedMonth === month ? null : month;
      otdApplyFilters();
      return;
    }
    const psBtn = event.target.closest?.('[data-ps]');
    if (psBtn) {
      const ps = psBtn.getAttribute('data-ps');
      otdState.selectedPs = otdState.selectedPs === ps ? null : ps;
      otdApplyFilters();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  otdSyncPsCheckboxes();
  otdSyncPresets();
  otdSetTab('detail');
  otdBind();
  otdFetch();
});
