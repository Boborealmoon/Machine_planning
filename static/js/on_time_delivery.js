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

function otdYearRows() {
  return (otdState.sourceRows || []).map((row) => {
    const delivery = otdDeliveryDate(row);
    if (!delivery || delivery.year !== otdState.year) return null;
    return {
      ...row,
      month: delivery.month,
      sales_person_label: otdSalespersonLabel(row),
    };
  }).filter(Boolean);
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
  const yearRows = otdYearRows();
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

function otdRenderKpis(summary, host = otdEl('otd-kpis')) {
  if (!host) return;
  const classified = summary.classified || 0;
  const onTime = (summary.early || 0) + (summary.on_time || 0);
  host.innerHTML = `
    <article class="sales-report-kpi otd-kpi--rate">
      <p class="sales-report-kpi-label">On-time rate</p>
      <p class="sales-report-kpi-value">${otdEscape(otdPct(summary.on_time_rate))}</p>
      <p class="sales-report-kpi-sub">${otdNum(onTime)} of ${otdNum(classified)} process sheets</p>
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
      <p class="sales-report-kpi-label">Avg days vs due</p>
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
  const max = Math.max(1, ...months.map((row) => (row.early || 0) + (row.on_time || 0) + (row.late || 0)));
  const W = 640;
  const H = 260;
  const left = 36;
  const right = 44;
  const top = 16;
  const bottom = 28;
  const innerW = W - left - right;
  const innerH = H - top - bottom;
  const gap = 6;
  const barW = Math.max(10, (innerW / months.length) - gap);
  const keys = ['early', 'on_time', 'late'];
  const columns = months.map((row, idx) => {
    const x = left + idx * (innerW / months.length) + gap / 2;
    let y = top + innerH;
    const stacks = keys.map((key) => {
      const val = row[key] || 0;
      const h = (val / max) * innerH;
      y -= h;
      if (h < 0.4) return '';
      const selected = interactive && otdState.selectedMonth === row.month;
      const chipClass = interactive ? 'otd-month-chip' : '';
      const monthAttr = interactive ? `data-month="${row.month}"` : '';
      return `<rect class="${chipClass}" ${monthAttr} x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${OTD_STATUS_COLORS[key]}" rx="1" opacity="${!interactive || selected || otdState.selectedMonth == null ? 1 : 0.45}">
        <title>${otdEscape(row.label)} ${otdEscape(OTD_STATUS_LABELS[key])}: ${val}</title>
      </rect>`;
    }).join('');
    const rate = row.classified ? row.on_time_rate : null;
    const rateX = x + barW / 2;
    const rateDot = rate == null ? '' : `<circle cx="${rateX.toFixed(1)}" cy="${(top + innerH - (rate * innerH)).toFixed(1)}" r="2.4" fill="#0f172a"/>`;
    return `${stacks}${rateDot}<text x="${rateX.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#64748b">${otdEscape(row.label)}</text>`;
  }).join('');
  const linePts = months.map((row, idx) => {
    if (!row.classified) return null;
    const x = left + idx * (innerW / months.length) + gap / 2 + barW / 2;
    const y = top + innerH - (row.on_time_rate * innerH);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean).join(' ');
  const line = linePts ? `<polyline fill="none" stroke="#0f172a" stroke-width="1.5" points="${linePts}"/>` : '';
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly on-time delivery">
    ${line}
    ${columns}
    <text x="${W - 6}" y="14" text-anchor="end" font-size="10" fill="#64748b">OTD %</text>
  </svg>${otdLegend([
    { color: OTD_STATUS_COLORS.early, label: 'Early' },
    { color: OTD_STATUS_COLORS.on_time, label: 'On time' },
    { color: OTD_STATUS_COLORS.late, label: 'Late' },
  ])}`;
}

function otdRenderPsChart(rows, host = otdEl('otd-ps-chart')) {
  if (!host) return;
  const items = (rows || []).filter((row) => (row.classified || 0) > 0);
  if (!items.length) {
    host.innerHTML = otdEmptyChart('No process sheets for the selected PS types.');
    return;
  }
  const rowH = 28;
  const left = 56;
  const right = 72;
  const top = 8;
  const W = 640;
  const H = top + items.length * rowH + 16;
  const innerW = W - left - right;
  const max = Math.max(1, ...items.map((row) => (row.early || 0) + (row.on_time || 0) + (row.late || 0)));
  const bars = items.map((row, idx) => {
    const y = top + idx * rowH;
    const onTime = (row.early || 0) + (row.on_time || 0);
    const late = row.late || 0;
    const onW = (onTime / max) * innerW;
    const lateW = (late / max) * innerW;
    const selected = otdState.selectedPs === row.id;
    const opacity = selected || otdState.selectedPs == null ? 1 : 0.45;
    return `<text x="${left - 8}" y="${y + 16}" text-anchor="end" font-size="12" font-weight="700" fill="#334155">${otdEscape(row.label)}</text>
      <rect class="otd-month-chip" data-ps="${otdEscape(row.id)}" x="${left}" y="${y + 6}" width="${Math.max(onW, 0).toFixed(1)}" height="14" rx="2" fill="#15803d" opacity="${opacity}">
        <title>${otdEscape(row.label)} on time: ${onTime}</title>
      </rect>
      <rect class="otd-month-chip" data-ps="${otdEscape(row.id)}" x="${(left + onW).toFixed(1)}" y="${y + 6}" width="${Math.max(lateW, 0).toFixed(1)}" height="14" rx="2" fill="#c2410c" opacity="${opacity}">
        <title>${otdEscape(row.label)} late: ${late}</title>
      </rect>
      <text x="${(left + onW + lateW + 8).toFixed(1)}" y="${y + 17}" font-size="11" fill="#64748b">${otdEscape(otdPct(row.on_time_rate))}</text>`;
  }).join('');
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="On-time delivery by PS type">${bars}</svg>
    ${otdLegend([
      { color: '#15803d', label: 'On time (incl. early)' },
      { color: '#c2410c', label: 'Late' },
    ])}`;
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
    return `<text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#64748b">${otdEscape(block.label)}</text>`;
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
  if (sub) {
    sub.textContent = payload.classified
      ? `On time (delivery on or before PO due): ${otdPct(payload.on_time_rate)} of ${payload.classified} process sheets`
      : 'Last delivery minus PO due (negative = early)';
  }
  const buckets = payload.buckets || [];
  const max = Math.max(0, ...buckets.map((bucket) => bucket.count));
  if (!max) {
    host.innerHTML = otdEmptyChart('No process sheets with both PO due and delivery dates.');
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
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Days versus PO due">${cols}</svg>`;
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
    hint.textContent = `${bits.join(' - ')}. Click a month or PS bar to filter the charts; click again to clear.`;
  }
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="10">No process sheets match this table filter.</td></tr>`;
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
      <td>${otdEscape(row.inventory_code || '-')}</td>
      <td>${otdEscape((row.po_due_date || '').slice(0, 10) || '-')}</td>
      <td>${otdEscape((row.delivery_date || '').slice(0, 10) || '-')}</td>
      <td class="${daysClass}">${otdEscape(otdDays(row.days))}</td>
      <td><span class="otd-status otd-status--${status}">${otdEscape(OTD_STATUS_LABELS[status] || status)}</span></td>
    </tr>`;
  }).join('');
}

function otdOverviewRows(spec) {
  const types = new Set(spec.ppTypes || []);
  return otdYearRows().filter((row) => {
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
      <p class="otd-overview-kpi-sub">${otdNum(onTime)} of ${otdNum(classified)} process sheets · ${otdNum(summary.late)} late</p>
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
    const body = classified
      ? `<section class="sales-report-kpi-grid card otd-kpi-grid" data-otd-section-kpis></section>
        <section class="otd-charts otd-charts--overview">
          <article class="otd-chart-card">
            <header class="otd-chart-head">
              <h2 class="otd-chart-title">On time vs late</h2>
              <p class="otd-chart-sub">Share delivered on or before PO due</p>
            </header>
            <div class="otd-chart-body" data-otd-section-donut></div>
          </article>
          <article class="otd-chart-card">
            <header class="otd-chart-head">
              <h2 class="otd-chart-title">By month</h2>
              <p class="otd-chart-sub">Early / on-time / late by delivery month</p>
            </header>
            <div class="otd-chart-body otd-chart-body--tall" data-otd-section-month></div>
          </article>
          <article class="otd-chart-card">
            <header class="otd-chart-head">
              <h2 class="otd-chart-title">Days vs PO due</h2>
              <p class="otd-chart-sub">Last delivery minus PO due</p>
            </header>
            <div class="otd-chart-body" data-otd-section-hist></div>
          </article>
        </section>`
      : `<div class="otd-overview-empty">No fully shipped ${otdEscape(section.label)} process sheets${section.salesContains ? ` for ${otdEscape(section.subtitle)}` : ''} in ${otdState.year}.</div>`;
    return `<section class="otd-overview-block" data-otd-section="${otdEscape(section.id)}">
      <header class="otd-overview-block-head">
        <h2 class="otd-overview-block-title">${otdEscape(section.label)}</h2>
        <p class="otd-overview-block-sub">${otdEscape(section.subtitle)} · ${otdNum(classified)} process sheets</p>
      </header>
      ${body}
    </section>`;
  }).join('');
  host.querySelectorAll('[data-otd-section]').forEach((block) => {
    const section = sections.find((item) => item.id === block.getAttribute('data-otd-section'));
    if (!section || !(section.summary?.classified)) return;
    otdRenderKpis(section.summary, block.querySelector('[data-otd-section-kpis]'));
    otdRenderDonut(section.summary, block.querySelector('[data-otd-section-donut]'));
    otdRenderMonthChart(section.by_month || [], block.querySelector('[data-otd-section-month]'), { interactive: false });
    otdRenderHist(section.histogram || {}, block.querySelector('[data-otd-section-hist]'), null);
  });
}

function otdRenderOverview() {
  const sections = otdState.overview || [];
  otdRenderOverviewCompare(sections);
  otdRenderOverviewTrend(sections);
  otdRenderOverviewSections(sections);
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
  if (context) {
    const types = otdAllTypesSelected()
      ? 'All PS types'
      : OTD_PS_TYPES.filter((item) => otdState.ppTypes.has(item)).map(otdPsLabel).join(', ') || 'None';
    const people = !otdState.salespersons.size
      ? ''
      : (otdState.salespersons.size === 1
        ? (otdState.salespersonOptions.find((item) => otdState.salespersons.has(item.id))?.label || '1 sales person')
        : `${otdState.salespersons.size} sales people`);
    context.textContent = people ? `Delivery date vs PO due - ${types} - ${people}` : `Delivery date vs PO due - ${types}`;
  }
  if (meta) {
    meta.hidden = !data;
    if (data) {
      meta.textContent = `${data.year} - last delivery vs PO due - ${otdNum(data.summary?.classified)} classified`;
    }
  }
  otdSetTab(otdState.tab);
  if (otdState.tab === 'overview' && !otdState.loading) {
    otdRenderOverview();
    return;
  }
  if (!hasRows) return;
  otdRenderKpis(data.summary || {});
  otdRenderDonut(data.summary || {});
  otdRenderMonthChart(data.by_month || []);
  otdRenderPsChart(data.by_ps || []);
  otdRenderMonthPsChart(data.by_month_ps || [], data.pp_types || []);
  otdRenderHist(data.histogram || {});
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

function otdExportCsv() {
  const rows = otdVisibleRows();
  const header = ['process_sheet', 'ps_type', 'sales_order', 'customer', 'sales_person', 'part', 'po_due', 'delivery', 'days', 'status'];
  const lines = [header.join(',')];
  rows.forEach((row) => {
    const cells = [
      row.process_sheet_no, row.pp_type, row.sales_order_no,
      row.customer_name || row.customer_code,
      row.sales_person_label || row.sales_person_name || row.sales_person_code,
      row.inventory_code,
      row.po_due_date, row.delivery_date, row.days, row.status,
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
  otdEl('otd-refresh')?.addEventListener('click', () => otdFetch(true));
  otdEl('otd-export')?.addEventListener('click', otdExportCsv);
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
