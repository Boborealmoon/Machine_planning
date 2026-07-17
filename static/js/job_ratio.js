// Job ratio report — booked SO line volume mix.

const JOB_RATIO_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
const JOB_RATIO_BUCKETS = ['proto', 'micro', 'low'];

const jobRatioState = {
  data: null,
  view: 'matrix',
  search: '',
  year: new Date().getFullYear(),
  ppTypes: new Set(['NPS']),
  loading: false,
  customerMonth: null,
  customerBucket: null,
  jobsMonth: null,
  jobsBucket: null,
  jobsSort: 'volume',
  jobsRows: null,
  jobsTotalValue: null,
  jobsLoading: false,
  partsCustomer: '',
  partsMonth: null,
  partsMinQty: 0,
  partsMinValue: 0,
  partsScoreMode: 'volume_value',
  partsSort: 'score',
  partsData: null,
  partsLoading: false,
  expandedJobGroups: new Set(),
  expandedCustomers: new Set(),
  customerLines: new Map(),
  customerLinesLoading: new Set(),
  linesGroupBy: 'month',
  expandedLineGroups: new Set(),
  error: '',
};

function jobRatioFormatMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function jobRatioFormatMoneyFull(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function jobRatioFormatQty(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  if (Number.isInteger(num)) return String(num);
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function jobRatioFormatPct(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toFixed(0)}%`;
}

function jobRatioFormatDate(value) {
  const text = String(value || '').trim();
  if (!text) return '—';
  return text.slice(0, 10);
}

function jobRatioFormatDt(value) {
  const text = String(value || '').trim();
  if (!text) return '—';
  return text.replace('T', ' ').slice(0, 19);
}

function jobRatioPpTypesAllSelected() {
  return jobRatioState.ppTypes.size >= JOB_RATIO_PS_TYPES.length;
}

function jobRatioPsTypeLabel() {
  const panel = document.getElementById('job-ratio-ps-type-panel');
  if (!panel) return 'NPS';
  const checked = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value);
  if (!checked.length) return 'None';
  if (checked.length >= JOB_RATIO_PS_TYPES.length) return 'All types';
  return checked.map(v => (v === 'SR' ? '[SR]' : v)).join(', ');
}

function jobRatioSyncPsTypeCheckboxes() {
  const panel = document.getElementById('job-ratio-ps-type-panel');
  if (!panel) return;
  panel.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.checked = jobRatioState.ppTypes.has(input.value);
  });
  const btn = document.getElementById('job-ratio-ps-type-btn');
  if (btn) btn.textContent = `${jobRatioPsTypeLabel()} ▾`;
}

function jobRatioPpTypesQuery() {
  if (jobRatioPpTypesAllSelected()) return 'ALL';
  return [...jobRatioState.ppTypes].join(',');
}

function jobRatioNoPsTypesSelected() {
  return !jobRatioPpTypesAllSelected() && jobRatioState.ppTypes.size === 0;
}

function jobRatioBucketLabel(bucketId) {
  const meta = jobRatioState.data?.bucket_meta?.[bucketId];
  return meta?.label || bucketId;
}

function jobRatioFormatPpTypes(row) {
  const types = row?.pp_types_on_line;
  if (Array.isArray(types) && types.length) return types.map(t => escapeHtml(t)).join(', ');
  return escapeHtml(row?.pp_type || '—');
}

function jobRatioFormatProcessSheets(row) {
  const sheets = row?.process_sheets_on_line;
  if (Array.isArray(sheets) && sheets.length) {
    return sheets.map(s => `<span class="new-orders-mono">${escapeHtml(s)}</span>`).join('<br>');
  }
  const one = row?.process_sheet_no;
  return one ? `<span class="new-orders-mono">${escapeHtml(one)}</span>` : '—';
}

function jobRatioReportData() {
  const data = jobRatioState.data;
  if (!data) return null;
  if (data.matrix) return data;
  if (data.portions?.po_due) {
    const portion = data.portions.po_due;
    return {
      ...data,
      matrix: portion.matrix,
      customers: portion.customers,
      line_count: portion.line_count,
      classified_line_count: portion.classified_line_count,
      unclassified_count: portion.unclassified_count,
      pp_excluded_count: portion.pp_excluded_count,
      month_basis: portion.month_basis,
    };
  }
  return data;
}

function jobRatioMonthBasisLabel() {
  return jobRatioReportData()?.month_basis || 'PO due date';
}

function jobRatioClassifiedCount(report) {
  const p = report || jobRatioReportData();
  const n = Number(p?.classified_line_count);
  return Number.isFinite(n) ? n : Number(p?.line_count) || 0;
}

function jobRatioSetLoading(on) {
  jobRatioState.loading = on;
  const el = document.getElementById('job-ratio-loading');
  if (el) el.hidden = !on;
  const stats = document.getElementById('job-ratio-stats');
  if (stats && on) stats.hidden = true;
}

function jobRatioHideSections() {
  ['job-ratio-matrix-wrap', 'job-ratio-jobs-wrap', 'job-ratio-customers-wrap', 'job-ratio-parts-wrap', 'job-ratio-empty'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
}

function jobRatioMonthCellClass(monthIndex, edge) {
  const band = monthIndex % 2 === 0 ? 'job-ratio-month-band-a' : 'job-ratio-month-band-b';
  const edgeCls = edge === 'start' ? 'job-ratio-month-start' : 'job-ratio-month-end';
  return `${band} ${edgeCls}`;
}

function jobRatioYtdCellClass(edge) {
  const edgeCls = edge === 'start' ? 'job-ratio-month-start job-ratio-ytd-start' : 'job-ratio-month-end job-ratio-ytd-end';
  return `job-ratio-ytd-col ${edgeCls}`;
}

function jobRatioRenderMatrix() {
  const table = document.getElementById('job-ratio-matrix-table');
  const sub = document.getElementById('job-ratio-matrix-sub');
  const wrap = document.getElementById('job-ratio-matrix-wrap');
  const data = jobRatioReportData();
  if (!table || !wrap || !data?.matrix) return;

  const months = data.matrix.months || [];
  const ytd = data.matrix.ytd;
  const bucketMeta = data.bucket_meta || {};

  if (sub) {
    sub.textContent = [
      'Month = PO / SO required shipment date.',
      'One job = one process sheet (partials deduped). Qty = SO qty per process sheet; value is home $ retained per SO line.',
      'Value basis uses ERP home amount (pre_tax_extended_home_amt); exchange rate is already included on the SO line.',
      `Targets: proto >${data.targets?.proto || 20}% · micro >${data.targets?.micro || 30}% · low >${data.targets?.low || 50}%`,
      'Click a count or value to drill into jobs.',
    ].join(' · ');
  }

  const monthHeaders = months.map((m, idx) => {
    const band = idx % 2 === 0 ? 'job-ratio-month-band-a' : 'job-ratio-month-band-b';
    return `<th colspan="2" class="job-ratio-month-head job-ratio-month-start job-ratio-month-end ${band}">${escapeHtml(m.label)}</th>`;
  }).join('');
  const ytdHeader = '<th colspan="2" class="job-ratio-month-head job-ratio-ytd-head job-ratio-month-start job-ratio-month-end">Year to date</th>';

  const subHeaders = months.map((_, idx) => {
    const startCls = jobRatioMonthCellClass(idx, 'start');
    const endCls = jobRatioMonthCellClass(idx, 'end');
    return `<th class="job-ratio-sub-head ${startCls}">Jobs</th><th class="job-ratio-sub-head ${endCls}">Value ($)</th>`;
  }).join('') + `<th class="job-ratio-sub-head ${jobRatioYtdCellClass('start')}">Jobs</th><th class="job-ratio-sub-head ${jobRatioYtdCellClass('end')}">Value ($)</th>`;

  let body = '';

  JOB_RATIO_BUCKETS.forEach(bucketId => {
    const label = bucketMeta[bucketId]?.label || bucketId;
    body += `<tr class="job-ratio-data-row">
      <th scope="row" class="job-ratio-row-label">${escapeHtml(label)}</th>`;
    months.forEach((m, idx) => {
      const b = m.buckets?.[bucketId] || {};
      body += `<td class="job-ratio-num job-ratio-clickable ${jobRatioMonthCellClass(idx, 'start')}" data-jr-drill="1" data-month="${m.month}" data-bucket="${bucketId}">${jobRatioFormatQty(b.count)}</td>`;
      body += `<td class="job-ratio-num job-ratio-money job-ratio-clickable ${jobRatioMonthCellClass(idx, 'end')}" data-jr-drill="1" data-month="${m.month}" data-bucket="${bucketId}">${jobRatioFormatMoney(b.value)}</td>`;
    });
    const yb = ytd?.buckets?.[bucketId] || {};
    body += `<td class="job-ratio-num job-ratio-clickable ${jobRatioYtdCellClass('start')}" data-jr-drill="1" data-bucket="${bucketId}">${jobRatioFormatQty(yb.count)}</td>`;
    body += `<td class="job-ratio-num job-ratio-money ${jobRatioYtdCellClass('end')}">${jobRatioFormatMoney(yb.value)}</td>`;
    body += '</tr>';
  });

  body += '<tr class="job-ratio-total-row"><th scope="row" class="job-ratio-row-label">Total</th>';
  months.forEach((m, idx) => {
    body += `<td class="job-ratio-num ${jobRatioMonthCellClass(idx, 'start')}">${jobRatioFormatQty(m.total?.count)}</td>`;
    body += `<td class="job-ratio-num job-ratio-money ${jobRatioMonthCellClass(idx, 'end')}">${jobRatioFormatMoney(m.total?.value)}</td>`;
  });
  body += `<td class="job-ratio-num ${jobRatioYtdCellClass('start')}">${jobRatioFormatQty(ytd?.total?.count)}</td>`;
  body += `<td class="job-ratio-num job-ratio-money ${jobRatioYtdCellClass('end')}">${jobRatioFormatMoney(ytd?.total?.value)}</td></tr>`;

  JOB_RATIO_BUCKETS.forEach(bucketId => {
    const target = data.targets?.[bucketId] || 0;
    const label = bucketMeta[bucketId]?.label || bucketId;
    body += `<tr class="job-ratio-ratio-row"><th scope="row" class="job-ratio-row-label">${escapeHtml(label)} — share of jobs &amp; value (target &gt;${target}%)</th>`;
    months.forEach((m, idx) => {
      const b = m.buckets?.[bucketId] || {};
      body += `<td class="job-ratio-num ${jobRatioTargetClass(b.count_ok)} ${jobRatioMonthCellClass(idx, 'start')}">${jobRatioFormatPct(b.count_pct)}</td>`;
      body += `<td class="job-ratio-num ${jobRatioTargetClass(b.value_ok)} ${jobRatioMonthCellClass(idx, 'end')}">${jobRatioFormatPct(b.value_pct)}</td>`;
    });
    const yb = ytd?.buckets?.[bucketId] || {};
    body += `<td class="job-ratio-num ${jobRatioYtdCellClass('start')} ${jobRatioTargetClass(yb.count_ok)}">${jobRatioFormatPct(yb.count_pct)}</td>`;
    body += `<td class="job-ratio-num ${jobRatioYtdCellClass('end')} ${jobRatioTargetClass(yb.value_ok)}">${jobRatioFormatPct(yb.value_pct)}</td>`;
    body += '</tr>';
  });

  table.innerHTML = `
    <thead>
      <tr><th rowspan="2" class="job-ratio-corner">Volume category</th>${monthHeaders}${ytdHeader}</tr>
      <tr>${subHeaders}</tr>
    </thead>
    <tbody>${body}</tbody>`;
  wrap.hidden = false;
}

function jobRatioTargetClass(ok) {
  return ok ? 'job-ratio-ok' : 'job-ratio-miss';
}

function jobRatioSyncCustomerFilters() {
  const monthEl = document.getElementById('job-ratio-customer-month');
  const bucketEl = document.getElementById('job-ratio-customer-bucket');
  if (monthEl) monthEl.value = jobRatioState.customerMonth ? String(jobRatioState.customerMonth) : '';
  if (bucketEl) bucketEl.value = jobRatioState.customerBucket || '';
  const filtersWrap = document.getElementById('job-ratio-customer-filters');
  if (filtersWrap) filtersWrap.hidden = jobRatioState.view !== 'customers';
}

function jobRatioSyncJobsFilters() {
  const monthEl = document.getElementById('job-ratio-jobs-month');
  const bucketEl = document.getElementById('job-ratio-jobs-bucket');
  const sortEl = document.getElementById('job-ratio-jobs-sort');
  if (monthEl) monthEl.value = jobRatioState.jobsMonth ? String(jobRatioState.jobsMonth) : '';
  if (bucketEl) bucketEl.value = jobRatioState.jobsBucket || '';
  if (sortEl) sortEl.value = jobRatioState.jobsSort || 'volume';
  const filtersWrap = document.getElementById('job-ratio-jobs-filters');
  if (filtersWrap) filtersWrap.hidden = jobRatioState.view !== 'jobs';
}

function jobRatioSyncPartsFilters() {
  const values = {
    'job-ratio-parts-customer': jobRatioState.partsCustomer,
    'job-ratio-parts-month': jobRatioState.partsMonth ? String(jobRatioState.partsMonth) : '',
    'job-ratio-parts-min-qty': jobRatioState.partsMinQty || '',
    'job-ratio-parts-min-value': jobRatioState.partsMinValue || '',
    'job-ratio-parts-score-mode': jobRatioState.partsScoreMode,
    'job-ratio-parts-sort': jobRatioState.partsSort,
  };
  Object.entries(values).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  });
  const wrap = document.getElementById('job-ratio-parts-filters');
  if (wrap) wrap.hidden = jobRatioState.view !== 'parts';
}

function jobRatioJobGroupKey(type, id) {
  return `${type}|${id}`;
}

function jobRatioFilterJobRows(rows) {
  const q = String(jobRatioState.search || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(row =>
    [
      row.sales_order_no, row.line_item_no, row.inventory_code, row.description,
      row.customer_code, row.customer_name, row.process_sheet_no,
    ].map(v => String(v || '').toLowerCase()).join(' ').includes(q)
  );
}

function jobRatioRenderJobDetailTable(rows) {
  const body = rows.map(row => {
    const desc = String(row.description || '—').trim();
    const bucketShort = (jobRatioBucketLabel(row.volume_bucket) || '—').replace(/\s*\(.*/, '');
    return `<tr class="job-ratio-line-row">
      <td class="new-orders-mono">${escapeHtml(row.sales_order_no || '—')}</td>
      <td class="new-orders-mono">${escapeHtml(row.line_item_no || '—')}</td>
      <td>${escapeHtml(row.customer_name || '—')}</td>
      <td class="new-orders-mono job-ratio-line-part" title="${escapeHtml(row.inventory_code || '')}">${escapeHtml(row.inventory_code || '—')}</td>
      <td class="job-ratio-num">${jobRatioFormatQty(row.qty)}</td>
      <td class="job-ratio-line-bucket" title="${escapeHtml(jobRatioBucketLabel(row.volume_bucket) || '')}">${escapeHtml(bucketShort)}</td>
      <td class="job-ratio-num">${jobRatioFormatMoneyFull(row.line_amount)}</td>
      <td>${jobRatioFormatDate(row.pp_due_date || row.report_date)}</td>
      <td class="job-ratio-line-desc" title="${escapeHtml(desc)}">${escapeHtml(jobRatioTruncate(desc, 48))}</td>
      <td>${jobRatioFormatPpTypes(row)}</td>
      <td class="job-ratio-ps-cell">${jobRatioFormatProcessSheets(row)}</td>
    </tr>`;
  }).join('');

  return `<table class="job-ratio-cust-lines-table job-ratio-jobs-table">
    <thead>
      <tr>
        <th>SO</th>
        <th>Line</th>
        <th>Customer</th>
        <th>Part</th>
        <th>Qty</th>
        <th>Category</th>
        <th>Value ($)</th>
        <th>PP due</th>
        <th>Description</th>
        <th>PP</th>
        <th>Process sheet</th>
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`;
}

function jobRatioGroupJobsForDisplay(rows) {
  const byMonth = new Map();
  rows.forEach(row => {
    const month = jobRatioLineReportMonth(row) || 0;
    const bucket = row.volume_bucket || 'unknown';
    if (!byMonth.has(month)) byMonth.set(month, new Map());
    const monthBuckets = byMonth.get(month);
    if (!monthBuckets.has(bucket)) monthBuckets.set(bucket, []);
    monthBuckets.get(bucket).push(row);
  });

  const months = [...byMonth.entries()].sort((a, b) => a[0] - b[0]);
  return months.map(([month, bucketMap]) => {
    const bucketOrder = jobRatioState.jobsBucket
      ? [jobRatioState.jobsBucket]
      : JOB_RATIO_BUCKETS;
    const buckets = bucketOrder
      .filter(bid => bucketMap.has(bid))
      .map(bid => {
        const jobs = bucketMap.get(bid) || [];
        const value = jobs.reduce((sum, r) => sum + (Number(r.line_amount) || 0), 0);
        return { bucket: bid, jobs, count: jobs.length, value };
      });
    const totalCount = buckets.reduce((sum, b) => sum + b.count, 0);
    const totalValue = buckets.reduce((sum, b) => sum + b.value, 0);
    return { month, buckets, totalCount, totalValue };
  });
}

function jobRatioRenderJobsGrouped(rows) {
  const groups = jobRatioGroupJobsForDisplay(rows);
  if (!groups.length) {
    return '<p class="job-ratio-cust-empty">No jobs match the current filters.</p>';
  }

  return groups.map(({ month, buckets, totalCount, totalValue }) => {
    const monthKey = jobRatioJobGroupKey('month', month);
    const monthOpen = jobRatioState.expandedJobGroups.has(monthKey)
      || Boolean(jobRatioState.jobsMonth);
    const monthLabel = month ? jobRatioMonthLabel(month, jobRatioState.year) : 'Unknown month';

    const bucketHtml = buckets.map(({ bucket, jobs, count, value }) => {
      const bucketKey = jobRatioJobGroupKey('bucket', `${month}:${bucket}`);
      const bucketOpen = jobRatioState.expandedJobGroups.has(bucketKey)
        || Boolean(jobRatioState.jobsBucket);
      const label = jobRatioBucketLabel(bucket);
      return `<div class="job-ratio-line-subgroup">
        <button type="button" class="job-ratio-line-subgroup-head" data-jr-job-group="bucket" data-month="${month}" data-bucket="${escapeHtml(bucket)}" aria-expanded="${bucketOpen ? 'true' : 'false'}">
          <span class="job-ratio-line-group-chevron" aria-hidden="true">${bucketOpen ? '▼' : '▶'}</span>
          <span class="job-ratio-line-group-title">${escapeHtml(label)}</span>
          <span class="job-ratio-line-group-meta">${jobRatioFormatQty(count)} job${count === 1 ? '' : 's'} · $${jobRatioFormatMoneyFull(value)}</span>
        </button>
        <div class="job-ratio-line-subgroup-body" ${bucketOpen ? '' : 'hidden'}>
          ${jobRatioRenderJobDetailTable(jobs)}
        </div>
      </div>`;
    }).join('');

    return `<div class="job-ratio-line-group">
      <button type="button" class="job-ratio-line-group-head" data-jr-job-group="month" data-month="${month}" aria-expanded="${monthOpen ? 'true' : 'false'}">
        <span class="job-ratio-line-group-chevron" aria-hidden="true">${monthOpen ? '▼' : '▶'}</span>
        <span class="job-ratio-line-group-title">${escapeHtml(monthLabel)}</span>
        <span class="job-ratio-line-group-meta">${jobRatioFormatQty(totalCount)} jobs · $${jobRatioFormatMoneyFull(totalValue)}</span>
      </button>
      <div class="job-ratio-line-group-body" ${monthOpen ? '' : 'hidden'}>${bucketHtml}</div>
    </div>`;
  }).join('');
}

function jobRatioRenderJobs() {
  const wrap = document.getElementById('job-ratio-jobs-wrap');
  const content = document.getElementById('job-ratio-jobs-content');
  if (!wrap || !content) return;

  if (jobRatioState.jobsLoading) {
    content.innerHTML = '<p class="job-ratio-cust-loading">Loading jobs…</p>';
    wrap.hidden = false;
    return;
  }

  const rows = jobRatioFilterJobRows(jobRatioState.jobsRows || []);
  const note = document.getElementById('job-ratio-jobs-filter-note');
  if (note) {
    const parts = [];
    if (jobRatioState.jobsMonth) {
      parts.push(jobRatioMonthLabel(jobRatioState.jobsMonth, jobRatioState.year));
    }
    if (jobRatioState.jobsBucket) {
      parts.push(jobRatioBucketLabel(jobRatioState.jobsBucket));
    }
    const totalVal = rows.reduce((sum, r) => sum + (Number(r.line_amount) || 0), 0);
    note.textContent = parts.length
      ? `${jobRatioFormatQty(rows.length)} jobs · $${jobRatioFormatMoneyFull(totalVal)} total value — filtered by ${parts.join(' · ')}.`
      : `${jobRatioFormatQty(rows.length)} jobs · $${jobRatioFormatMoneyFull(totalVal)} total value. Grouped by month and volume category.`;
    note.hidden = false;
  }

  if (!rows.length) {
    content.innerHTML = '<p class="job-ratio-cust-empty">No jobs match the current filters.</p>';
    wrap.hidden = false;
    return;
  }

  content.innerHTML = `
    <div class="job-ratio-lines-toolbar">
      <button type="button" class="btn btn-ghost btn-sm" id="job-ratio-jobs-expand-all">Expand all</button>
      <button type="button" class="btn btn-ghost btn-sm" id="job-ratio-jobs-collapse-all">Collapse all</button>
      <span class="job-ratio-lines-count">${jobRatioFormatQty(rows.length)} jobs</span>
    </div>
    <div class="job-ratio-cust-lines-scroll job-ratio-cust-lines-scroll--grouped">
      ${jobRatioRenderJobsGrouped(rows)}
    </div>`;

  wrap.hidden = false;
}

function jobRatioCustomerMatchesFilters(row) {
  const month = jobRatioState.customerMonth;
  const bucket = jobRatioState.customerBucket;
  if (!month && !bucket) return true;

  if (month && bucket) {
    const m = (row.months || []).find(item => item.month === month);
    if (!m) return false;
    const b = m.buckets?.[bucket];
    return (b?.count || 0) > 0;
  }
  if (month) {
    return (row.months || []).some(item => item.month === month);
  }
  const b = row.buckets?.[bucket];
  return (b?.count || 0) > 0;
}

function jobRatioFilterCustomers(customers) {
  const q = String(jobRatioState.search || '').trim().toLowerCase();
  return (customers || []).filter(row => {
    if (!jobRatioCustomerMatchesFilters(row)) return false;
    if (!q) return true;
    const code = String(row.customer_code || '').toLowerCase();
    const name = String(row.customer_name || '').toLowerCase();
    if (`${code} ${name}`.includes(q)) return true;
    const cacheKey = jobRatioCustomerLinesCacheKey(row.customer_code);
    const lines = jobRatioState.customerLines.get(cacheKey);
    if (!lines) return false;
    return lines.some(line =>
      [
        line.sales_order_no, line.line_item_no, line.inventory_code, line.description,
      ].map(v => String(v || '').toLowerCase()).join(' ').includes(q)
    );
  });
}

function jobRatioLineReportMonth(line) {
  const m = line?.report_month ?? line?.booked_month;
  return Number.isFinite(Number(m)) ? Number(m) : null;
}

function jobRatioLineReportYear(line) {
  const y = line?.report_year ?? line?.booked_year;
  return Number.isFinite(Number(y)) ? Number(y) : null;
}

function jobRatioTruncate(text, max = 80) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function jobRatioMonthLabel(month, year) {
  if (!month) return 'Unknown month';
  return new Date(year, month - 1, 1).toLocaleString(undefined, { month: 'short', year: 'numeric' });
}

function jobRatioLineGroupKey(customerCode, type, id) {
  return `${customerCode}|${type}|${id}`;
}

function jobRatioBuildMonthsFromLines(lines, year) {
  const byMonth = new Map();

  lines.forEach(line => {
    const month = jobRatioLineReportMonth(line);
    if (!month) return;
    const bid = line.volume_bucket;
    if (!bid) return;
    const entry = byMonth.get(month) || {
      month,
      label: jobRatioMonthLabel(month, year),
      buckets: Object.fromEntries(JOB_RATIO_BUCKETS.map(b => [b, { count: 0, value: 0 }])),
      total: { count: 0, value: 0 },
    };
    const amount = Number(line.line_amount) || 0;
    entry.buckets[bid].count += 1;
    entry.buckets[bid].value += amount;
    entry.total.count += 1;
    entry.total.value += amount;
    byMonth.set(month, entry);
  });

  return [...byMonth.values()]
    .sort((a, b) => a.month - b.month)
    .map(m => {
      const bucketStats = {};
      JOB_RATIO_BUCKETS.forEach(bid => {
        const b = m.buckets[bid];
        const countPct = m.total.count ? (b.count / m.total.count * 100) : 0;
        const valuePct = m.total.value ? (b.value / m.total.value * 100) : 0;
        bucketStats[bid] = {
          count: b.count,
          value: b.value,
          count_pct: Math.round(countPct * 10) / 10,
          value_pct: Math.round(valuePct * 10) / 10,
        };
      });
      return { ...m, buckets: bucketStats };
    });
}

function jobRatioGetCustomerMonths(customer, customerCode) {
  let months = customer.months || [];
  if (!months.length) {
    const lines = jobRatioState.customerLines.get(jobRatioCustomerLinesCacheKey(customerCode)) || [];
    if (lines.length) months = jobRatioBuildMonthsFromLines(lines, jobRatioState.year);
  }
  return months;
}

function jobRatioCustomerDisplayStats(customer) {
  const month = jobRatioState.customerMonth;
  const bucket = jobRatioState.customerBucket;

  if (month && bucket) {
    const m = (customer.months || []).find(item => item.month === month);
    const b = m?.buckets?.[bucket] || {};
    return {
      total_count: b.count || 0,
      total_qty: null,
      total_value: b.value || 0,
      buckets: { [bucket]: b },
      months: m ? [m] : [],
    };
  }
  if (month) {
    const m = (customer.months || []).find(item => item.month === month);
    if (!m) return { total_count: 0, total_qty: null, total_value: 0, buckets: {}, months: [] };
    return {
      total_count: m.total?.count || 0,
      total_qty: null,
      total_value: m.total?.value || 0,
      buckets: m.buckets || {},
      months: [m],
    };
  }
  if (bucket) {
    const b = customer.buckets?.[bucket] || {};
    return {
      total_count: b.count || 0,
      total_qty: null,
      total_value: b.value || 0,
      buckets: { [bucket]: b },
      months: customer.months || [],
    };
  }
  return {
    total_count: customer.total_count,
    total_qty: customer.total_qty,
    total_value: customer.total_value,
    buckets: customer.buckets || {},
    months: customer.months || [],
  };
}

function jobRatioBucketTarget(bucketId) {
  return jobRatioState.data?.targets?.[bucketId] || 0;
}

function jobRatioRenderCustomerMonthTable(customer, customerCode) {
  const months = jobRatioGetCustomerMonths(customer, customerCode);
  if (!months.length) {
    const loading = jobRatioState.customerLinesLoading.has(customerCode);
    if (loading) {
      return '<p class="job-ratio-cust-loading">Loading monthly breakdown…</p>';
    }
    return '<p class="job-ratio-cust-empty">No monthly data for this customer yet. Expand loads order lines — try Refresh if this persists.</p>';
  }

  const bucketCols = jobRatioState.customerBucket
    ? [jobRatioState.customerBucket]
    : JOB_RATIO_BUCKETS;

  const bucketHeaders = bucketCols.map(bucketId => {
    const label = jobRatioBucketLabel(bucketId);
    return `<th colspan="2" class="job-ratio-cust-month-bucket-head">${escapeHtml(label)}</th>`;
  }).join('');

  const subHeaders = bucketCols.map(() =>
    '<th class="job-ratio-sub-head">Jobs</th><th class="job-ratio-sub-head">Value ($)</th>'
  ).join('');

  const body = months.map(m => {
    const cells = bucketCols.flatMap(bucketId => {
      const b = m.buckets?.[bucketId] || {};
      return [
        `<td class="job-ratio-num">${jobRatioFormatQty(b.count)}</td>`,
        `<td class="job-ratio-num">${jobRatioFormatMoney(b.value)}</td>`,
      ];
    }).join('');
    return `<tr>
      <th scope="row">${escapeHtml(m.label)}</th>
      <td class="job-ratio-num">${jobRatioFormatQty(m.total?.count)}</td>
      <td class="job-ratio-num">${jobRatioFormatMoney(m.total?.value)}</td>
      ${cells}
    </tr>`;
  }).join('');

  const ytdCount = months.reduce((sum, m) => sum + (m.total?.count || 0), 0);
  const ytdValue = months.reduce((sum, m) => sum + (m.total?.value || 0), 0);
  const ytdCells = bucketCols.flatMap(bucketId => {
    let count = 0;
    let value = 0;
    months.forEach(m => {
      const b = m.buckets?.[bucketId] || {};
      count += b.count || 0;
      value += b.value || 0;
    });
    return [
      `<td class="job-ratio-num job-ratio-month-total">${jobRatioFormatQty(count)}</td>`,
      `<td class="job-ratio-num job-ratio-month-total">${jobRatioFormatMoney(value)}</td>`,
    ];
  }).join('');

  return `<div class="job-ratio-cust-month-scroll">
    <table class="job-ratio-cust-month-table">
      <thead>
        <tr>
          <th rowspan="2">Month (PP due date)</th>
          <th colspan="2">Total</th>
          ${bucketHeaders}
        </tr>
        <tr>
          <th class="job-ratio-sub-head">Jobs</th>
          <th class="job-ratio-sub-head">Value ($)</th>
          ${subHeaders}
        </tr>
      </thead>
      <tbody>
        ${body}
        <tr class="job-ratio-month-ytd-row">
          <th scope="row">Year total</th>
          <td class="job-ratio-num">${jobRatioFormatQty(ytdCount)}</td>
          <td class="job-ratio-num">${jobRatioFormatMoney(ytdValue)}</td>
          ${ytdCells}
        </tr>
      </tbody>
    </table>
  </div>`;
}

function jobRatioRenderCompactLinesTable(lines) {
  const rows = lines.map(row => {
    const desc = String(row.description || '—').trim();
    const bucketShort = (jobRatioBucketLabel(row.volume_bucket) || '—').replace(/\s*\(.*/, '');
    return `<tr class="job-ratio-line-row">
      <td class="new-orders-mono">${escapeHtml(row.line_item_no || '—')}</td>
      <td class="new-orders-mono job-ratio-line-part" title="${escapeHtml(row.inventory_code || '')}">${escapeHtml(row.inventory_code || '—')}</td>
      <td class="job-ratio-num">${jobRatioFormatQty(row.qty)}</td>
      <td class="job-ratio-line-bucket" title="${escapeHtml(jobRatioBucketLabel(row.volume_bucket) || '')}">${escapeHtml(bucketShort)}</td>
      <td class="job-ratio-num">${jobRatioFormatMoneyFull(row.line_amount)}</td>
      <td class="job-ratio-line-desc" title="${escapeHtml(desc)}">${escapeHtml(jobRatioTruncate(desc, 64))}</td>
      <td>${jobRatioFormatPpTypes(row)}</td>
      <td class="job-ratio-ps-cell">${jobRatioFormatProcessSheets(row)}</td>
    </tr>`;
  }).join('');

  return `<table class="job-ratio-cust-lines-table job-ratio-cust-lines-table--compact">
    <thead>
      <tr>
        <th>Line</th>
        <th>Part</th>
        <th>Qty</th>
        <th>Category</th>
        <th>Amount</th>
        <th>Description</th>
        <th>PP</th>
        <th>Process sheet</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function jobRatioLineGroupMeta(lines) {
  const count = lines.length;
  const value = lines.reduce((sum, row) => sum + (Number(row.line_amount) || 0), 0);
  return `${jobRatioFormatQty(count)} line${count === 1 ? '' : 's'} · $${jobRatioFormatMoneyFull(value)}`;
}

function jobRatioRenderLinesByMonth(customerCode, lines) {
  const byMonth = new Map();
  lines.forEach(line => {
    const month = jobRatioLineReportMonth(line) || 0;
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(line);
  });
  const months = [...byMonth.entries()].sort((a, b) => a[0] - b[0]);

  return months.map(([month, monthLines]) => {
    const groupKey = jobRatioLineGroupKey(customerCode, 'month', month);
    const open = jobRatioState.expandedLineGroups.has(groupKey);
    const bySo = new Map();
    monthLines.forEach(line => {
      const so = line.sales_order_no || '—';
      if (!bySo.has(so)) bySo.set(so, []);
      bySo.get(so).push(line);
    });
    const soGroups = [...bySo.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    const soHtml = soGroups.map(([so, soLines]) => {
      const soKey = jobRatioLineGroupKey(customerCode, 'so', `${month}:${so}`);
      const soOpen = jobRatioState.expandedLineGroups.has(soKey);
      return `<div class="job-ratio-line-subgroup">
        <button type="button" class="job-ratio-line-subgroup-head" data-jr-line-group="so" data-customer="${escapeHtml(customerCode)}" data-month="${month}" data-so="${escapeHtml(so)}" aria-expanded="${soOpen ? 'true' : 'false'}">
          <span class="job-ratio-line-group-chevron" aria-hidden="true">${soOpen ? '▼' : '▶'}</span>
          <span class="new-orders-mono">${escapeHtml(so)}</span>
          <span class="job-ratio-line-group-meta">${jobRatioLineGroupMeta(soLines)}</span>
        </button>
        <div class="job-ratio-line-subgroup-body" ${soOpen ? '' : 'hidden'}>
          ${jobRatioRenderCompactLinesTable(soLines)}
        </div>
      </div>`;
    }).join('');

    return `<div class="job-ratio-line-group">
      <button type="button" class="job-ratio-line-group-head" data-jr-line-group="month" data-customer="${escapeHtml(customerCode)}" data-month="${month}" aria-expanded="${open ? 'true' : 'false'}">
        <span class="job-ratio-line-group-chevron" aria-hidden="true">${open ? '▼' : '▶'}</span>
        <span class="job-ratio-line-group-title">${escapeHtml(jobRatioMonthLabel(month, jobRatioState.year))}</span>
        <span class="job-ratio-line-group-meta">${jobRatioLineGroupMeta(monthLines)}</span>
      </button>
      <div class="job-ratio-line-group-body" ${open ? '' : 'hidden'}>${soHtml}</div>
    </div>`;
  }).join('');
}

function jobRatioRenderLinesBySo(customerCode, lines) {
  const bySo = new Map();
  lines.forEach(line => {
    const so = line.sales_order_no || '—';
    if (!bySo.has(so)) bySo.set(so, []);
    bySo.get(so).push(line);
  });
  return [...bySo.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([so, soLines]) => {
    const groupKey = jobRatioLineGroupKey(customerCode, 'so', so);
    const open = jobRatioState.expandedLineGroups.has(groupKey);
    const months = [...new Set(soLines.map(l => jobRatioLineReportMonth(l)).filter(Boolean))]
      .map(m => jobRatioMonthLabel(m, jobRatioState.year))
      .join(', ');
    return `<div class="job-ratio-line-group">
      <button type="button" class="job-ratio-line-group-head" data-jr-line-group="so" data-customer="${escapeHtml(customerCode)}" data-so="${escapeHtml(so)}" aria-expanded="${open ? 'true' : 'false'}">
        <span class="job-ratio-line-group-chevron" aria-hidden="true">${open ? '▼' : '▶'}</span>
        <span class="new-orders-mono job-ratio-line-group-title">${escapeHtml(so)}</span>
        <span class="job-ratio-line-group-meta">${jobRatioLineGroupMeta(soLines)}</span>
        ${months ? `<span class="job-ratio-line-group-dates">${escapeHtml(months)}</span>` : ''}
      </button>
      <div class="job-ratio-line-group-body" ${open ? '' : 'hidden'}>
        ${jobRatioRenderCompactLinesTable(soLines)}
      </div>
    </div>`;
  }).join('');
}

function jobRatioRenderCustomerLinesTable(customerCode) {
  const loading = jobRatioState.customerLinesLoading.has(customerCode);
  if (loading) {
    return '<p class="job-ratio-cust-loading">Loading order lines…</p>';
  }

  let lines = jobRatioState.customerLines.get(jobRatioCustomerLinesCacheKey(customerCode)) || [];
  const q = String(jobRatioState.search || '').trim().toLowerCase();
  if (q) {
    lines = lines.filter(row =>
      [
        row.sales_order_no, row.line_item_no, row.inventory_code, row.description,
        row.customer_code, row.customer_name,
      ].map(v => String(v || '').toLowerCase()).join(' ').includes(q)
    );
  }

  if (!lines.length) {
    return '<p class="job-ratio-cust-empty">No order lines match the current filters.</p>';
  }

  const groupBy = jobRatioState.linesGroupBy;
  const grouped = groupBy === 'so'
    ? jobRatioRenderLinesBySo(customerCode, lines)
    : jobRatioRenderLinesByMonth(customerCode, lines);

  return `<div class="job-ratio-lines-toolbar">
      <span class="job-ratio-lines-toolbar-label">Organise by</span>
      <div class="mi-view-toggle job-ratio-lines-group-toggle" role="group" aria-label="Group order lines">
        <button type="button" class="mi-view-btn${groupBy === 'month' ? ' is-active' : ''}" data-jr-lines-group="month">Month → SO</button>
        <button type="button" class="mi-view-btn${groupBy === 'so' ? ' is-active' : ''}" data-jr-lines-group="so">Sales order</button>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-jr-lines-expand-all="${escapeHtml(customerCode)}">Expand all</button>
      <button type="button" class="btn btn-ghost btn-sm" data-jr-lines-collapse-all="${escapeHtml(customerCode)}">Collapse all</button>
      <span class="job-ratio-lines-count">${jobRatioFormatQty(lines.length)} lines</span>
    </div>
    <div class="job-ratio-cust-lines-scroll job-ratio-cust-lines-scroll--grouped">
      ${grouped}
    </div>`;
}

function jobRatioRenderCustomerExpanded(customer) {
  const code = customer.customer_code;
  const filterParts = [];
  if (jobRatioState.customerMonth) {
    filterParts.push(new Date(jobRatioState.year, jobRatioState.customerMonth - 1, 1).toLocaleString(undefined, { month: 'long' }));
  }
  if (jobRatioState.customerBucket) {
    filterParts.push(jobRatioBucketLabel(jobRatioState.customerBucket));
  }
  const filterNote = filterParts.length
    ? `Toolbar filters active (${filterParts.join(' · ')}) — order lines are filtered; monthly table shows full year for this customer.`
    : '';

  return `<div class="job-ratio-cust-expanded">
    <div class="job-ratio-cust-expanded-section">
      <h3 class="job-ratio-cust-expanded-title">Monthly breakdown</h3>
      <p class="job-ratio-cust-expanded-hint">Jobs and value by volume category for each PP due month (full year for this customer).</p>
      ${jobRatioRenderCustomerMonthTable(customer, code)}
    </div>
    <div class="job-ratio-cust-expanded-section">
      <h3 class="job-ratio-cust-expanded-title">Order lines</h3>
      <p class="job-ratio-cust-expanded-hint">${filterNote || 'Grouped and collapsed by default — expand a month or sales order to see line details.'}</p>
      ${jobRatioRenderCustomerLinesTable(code)}
    </div>
  </div>`;
}

function jobRatioRenderCustomers() {
  const wrap = document.getElementById('job-ratio-customers-wrap');
  const list = document.getElementById('job-ratio-customers-list');
  const data = jobRatioState.data;
  if (!wrap || !list || !data) return;

  const report = jobRatioReportData();
  const rows = jobRatioFilterCustomers(report?.customers);
  if (!rows.length) {
    wrap.hidden = true;
    jobRatioShowEmpty('No customers match your filters.');
    return;
  }

  const filterNote = document.getElementById('job-ratio-customers-filter-note');
  if (filterNote) {
    const parts = [];
    if (jobRatioState.customerMonth) {
      parts.push(new Date(jobRatioState.year, jobRatioState.customerMonth - 1, 1).toLocaleString(undefined, { month: 'long' }));
    }
    if (jobRatioState.customerBucket) {
      parts.push(jobRatioBucketLabel(jobRatioState.customerBucket));
    }
    filterNote.textContent = parts.length
      ? `Showing customers with activity in: ${parts.join(' · ')}. Click a customer to see monthly breakdown and order lines.`
      : 'Click a customer row to expand monthly breakdown and order lines.';
    filterNote.hidden = false;
  }

  list.innerHTML = rows.map(customer => {
    const code = customer.customer_code;
    const expanded = jobRatioState.expandedCustomers.has(code);
    const chevron = expanded ? '▼' : '▶';
    const stats = jobRatioCustomerDisplayStats(customer);
    const mixBuckets = jobRatioState.customerBucket
      ? [jobRatioState.customerBucket]
      : JOB_RATIO_BUCKETS;
    const qtyLabel = stats.total_qty != null
      ? jobRatioFormatQty(stats.total_qty)
      : '—';
    return `<article class="job-ratio-cust-card${expanded ? ' is-expanded' : ''}" data-customer="${escapeHtml(code)}">
      <button type="button" class="job-ratio-cust-summary" aria-expanded="${expanded ? 'true' : 'false'}">
        <span class="job-ratio-cust-chevron" aria-hidden="true">${chevron}</span>
        <span class="job-ratio-cust-name">${escapeHtml(customer.customer_name || '—')}</span>
        <span class="job-ratio-cust-code new-orders-mono">${escapeHtml(code)}</span>
        <span class="job-ratio-cust-stat"><span class="job-ratio-cust-stat-label">Jobs</span> ${jobRatioFormatQty(stats.total_count)}</span>
        <span class="job-ratio-cust-stat"><span class="job-ratio-cust-stat-label">Total qty</span> ${qtyLabel}</span>
        <span class="job-ratio-cust-stat"><span class="job-ratio-cust-stat-label">Total value</span> $${jobRatioFormatMoneyFull(stats.total_value)}</span>
      </button>
      <div class="job-ratio-cust-mix">
        ${mixBuckets.map(bucketId => {
          const b = stats.buckets?.[bucketId] || customer.buckets?.[bucketId] || {};
          const label = jobRatioBucketLabel(bucketId);
          const target = jobRatioBucketTarget(bucketId);
          return `<div class="job-ratio-cust-mix-item">
            <span class="job-ratio-cust-mix-name">${escapeHtml(label)}</span>
            <span class="job-ratio-mix-stat ${jobRatioTargetClass(b.count_ok)}">
              <span class="job-ratio-mix-stat-label">Jobs</span> ${jobRatioFormatPct(b.count_pct)}
            </span>
            <span class="job-ratio-mix-stat ${jobRatioTargetClass(b.value_ok)}">
              <span class="job-ratio-mix-stat-label">Value</span> ${jobRatioFormatPct(b.value_pct)}
            </span>
            <span class="job-ratio-cust-mix-target">target &gt;${target}%</span>
          </div>`;
        }).join('')}
      </div>
      <div class="job-ratio-cust-detail" ${expanded ? '' : 'hidden'}>
        ${expanded ? jobRatioRenderCustomerExpanded(customer) : ''}
      </div>
    </article>`;
  }).join('');

  wrap.hidden = false;
}

function jobRatioFilteredParts() {
  const rows = jobRatioState.partsData?.rows || [];
  const q = String(jobRatioState.search || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(row =>
    [
      row.customer_code, row.customer_name, row.part_no, row.description,
    ].map(value => String(value || '').toLowerCase()).join(' ').includes(q)
  );
}

function jobRatioRenderParts() {
  const wrap = document.getElementById('job-ratio-parts-wrap');
  const content = document.getElementById('job-ratio-parts-content');
  const note = document.getElementById('job-ratio-parts-note');
  if (!wrap || !content) return;

  if (jobRatioState.partsLoading) {
    content.innerHTML = '<p class="job-ratio-cust-loading">Loading ranked parts…</p>';
    wrap.hidden = false;
    return;
  }
  if (!jobRatioState.partsData) {
    content.innerHTML = '<p class="job-ratio-cust-empty">No parts analysis loaded.</p>';
    wrap.hidden = false;
    return;
  }

  const rows = jobRatioFilteredParts();
  if (note) {
    const data = jobRatioState.partsData;
    const scoreText = jobRatioState.partsScoreMode === 'repeat_demand'
      ? 'Repeat demand score: 30% quantity, 40% value, 30% distinct orders.'
      : 'Volume + value score: geometric mean of quantity and value percentiles.';
    note.textContent = `${jobRatioFormatQty(rows.length)} customer-part combinations · ${jobRatioFormatQty(data.total_qty)} total qty · $${jobRatioFormatMoneyFull(data.total_value)} booked value. ${scoreText}`;
  }
  if (!rows.length) {
    content.innerHTML = '<p class="job-ratio-cust-empty">No parts match the current filters.</p>';
    wrap.hidden = false;
    return;
  }

  const body = rows.map(row => `<tr>
    <td class="job-ratio-num job-ratio-parts-rank">${jobRatioFormatQty(row.rank)}</td>
    <td class="job-ratio-num"><strong>${jobRatioFormatQty(row.score)}</strong></td>
    <td>${escapeHtml(row.customer_name || '—')}<br><span class="new-orders-mono job-ratio-parts-muted">${escapeHtml(row.customer_code || '—')}</span></td>
    <td class="new-orders-mono">${escapeHtml(row.part_no || '—')}</td>
    <td class="job-ratio-line-desc" title="${escapeHtml(row.description || '')}">${escapeHtml(jobRatioTruncate(row.description || '—', 64))}</td>
    <td class="job-ratio-num">${jobRatioFormatQty(row.total_qty)}</td>
    <td class="job-ratio-num">$${jobRatioFormatMoneyFull(row.total_value)}</td>
    <td class="job-ratio-num">$${jobRatioFormatMoneyFull(row.average_unit_value)}</td>
    <td class="job-ratio-num">${jobRatioFormatQty(row.process_sheet_count)}</td>
    <td class="job-ratio-num">${jobRatioFormatQty(row.order_count)}</td>
    <td class="job-ratio-num">${jobRatioFormatPct(row.volume_percentile)}</td>
    <td class="job-ratio-num">${jobRatioFormatPct(row.value_percentile)}</td>
    <td class="job-ratio-num">${jobRatioFormatPct(row.order_percentile)}</td>
  </tr>`).join('');

  content.innerHTML = `<div class="job-ratio-parts-scroll">
    <table class="job-ratio-parts-table">
      <thead><tr>
        <th>Rank</th><th><button type="button" data-jr-parts-sort="score">Score</button></th>
        <th>Customer</th><th><button type="button" data-jr-parts-sort="part">Part</button></th><th>Description</th>
        <th><button type="button" data-jr-parts-sort="volume">Qty</button></th>
        <th><button type="button" data-jr-parts-sort="value">Booked value</button></th>
        <th>Avg unit value</th><th>PS</th><th><button type="button" data-jr-parts-sort="orders">Orders</button></th>
        <th>Volume pct.</th><th>Value pct.</th><th>Order pct.</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
  wrap.hidden = false;
}

function jobRatioShowEmpty(text) {
  const empty = document.getElementById('job-ratio-empty');
  const textEl = document.getElementById('job-ratio-empty-text');
  if (textEl) textEl.textContent = text;
  if (empty) empty.hidden = false;
}

function jobRatioRenderStats() {
  const el = document.getElementById('job-ratio-stats');
  const data = jobRatioState.data;
  if (!el) return;
  if (!data) {
    el.hidden = true;
    return;
  }
  const report = jobRatioReportData();
  const customerCount = jobRatioFilterCustomers(report?.customers).length;
  const pills = [
    `<span class="sales-report-stat-pill">${jobRatioFormatQty(jobRatioClassifiedCount(report))} classified jobs</span>`,
    `<span class="sales-report-stat-pill">${escapeHtml(jobRatioMonthBasisLabel())}</span>`,
    `<span class="sales-report-stat-pill">PP: ${escapeHtml(jobRatioPsTypeLabel())}</span>`,
  ];
  if (jobRatioState.view === 'customers') {
    pills.push(`<span class="sales-report-stat-pill">${customerCount} customers</span>`);
  }
  if (jobRatioState.view === 'jobs' && jobRatioState.jobsRows) {
    const val = jobRatioState.jobsTotalValue;
    pills.push(`<span class="sales-report-stat-pill">${jobRatioFormatQty(jobRatioState.jobsRows.length)} jobs</span>`);
    if (val != null) {
      pills.push(`<span class="sales-report-stat-pill">$${jobRatioFormatMoneyFull(val)} value</span>`);
    }
  }
  if (jobRatioState.view === 'parts' && jobRatioState.partsData) {
    pills.push(`<span class="sales-report-stat-pill">${jobRatioFormatQty(jobRatioState.partsData.count)} ranked parts</span>`);
    pills.push(`<span class="sales-report-stat-pill">${jobRatioFormatQty(jobRatioState.partsData.total_qty)} qty</span>`);
    pills.push(`<span class="sales-report-stat-pill">$${jobRatioFormatMoneyFull(jobRatioState.partsData.total_value)} booked value</span>`);
  }
  if (Number(report?.unclassified_count) > 0) {
    pills.push(`<span class="sales-report-stat-pill job-ratio-stat-warn">${jobRatioFormatQty(report.unclassified_count)} unclassified (qty ≤ 0)</span>`);
  }
  if (Number(report?.pp_excluded_count) > 0) {
    pills.push(`<span class="sales-report-stat-pill job-ratio-stat-muted">${jobRatioFormatQty(report.pp_excluded_count)} excluded by PP filter</span>`);
  }
  el.innerHTML = pills.join('');
  el.hidden = false;
}

function jobRatioRenderMeta() {
  const el = document.getElementById('job-ratio-meta');
  const data = jobRatioState.data;
  if (!el || !data) return;
  el.textContent = [
    `Year ${data.year}`,
    `PP: ${jobRatioPsTypeLabel()}`,
    'Value basis: ERP home amount (FX included)',
    data.cached_at ? `Cached ${data.cached_at}` : '',
  ].filter(Boolean).join(' · ');
  el.hidden = false;
}

function jobRatioRender() {
  if (jobRatioState.loading) return;
  jobRatioHideSections();
  jobRatioSyncCustomerFilters();
  jobRatioSyncJobsFilters();
  jobRatioSyncPartsFilters();

  if (jobRatioNoPsTypesSelected()) {
    jobRatioShowEmpty('Select at least one PP prefix.');
    return;
  }
  if (!jobRatioState.data) {
    jobRatioShowEmpty(jobRatioState.error || 'No data loaded.');
    return;
  }
  jobRatioState.error = '';

  jobRatioRenderStats();
  jobRatioRenderMeta();

  const searchWrap = document.getElementById('job-ratio-search-wrap');
  if (searchWrap) searchWrap.hidden = jobRatioState.view === 'matrix';

  if (jobRatioState.view === 'matrix') {
    jobRatioRenderMatrix();
  } else if (jobRatioState.view === 'jobs') {
    jobRatioRenderJobs();
  } else if (jobRatioState.view === 'parts') {
    jobRatioRenderParts();
  } else {
    jobRatioRenderCustomers();
  }
}

async function jobRatioFetchJson(url, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await (window.reportsApiFetch || fetch)(url, { signal: controller.signal });
    let payload = {};
    try {
      payload = await resp.json();
    } catch (_) {
      throw new Error(resp.ok ? 'Invalid server response' : `Server error (${resp.status})`);
    }
    if (!resp.ok || !payload.ok) {
      throw new Error(payload.error || `Request failed (${resp.status})`);
    }
    return payload;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out — ERP may be slow. Try Refresh.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function jobRatioCustomerLinesCacheKey(customerCode) {
  return `${customerCode}|${jobRatioState.customerMonth || ''}|${jobRatioState.customerBucket || ''}`;
}

async function jobRatioLoadJobs() {
  if (jobRatioNoPsTypesSelected()) return;

  jobRatioState.jobsLoading = true;
  if (jobRatioState.view === 'jobs') jobRatioRenderJobs();

  const params = new URLSearchParams({
    year: String(jobRatioState.year),
    pp_types: jobRatioPpTypesQuery(),
    sort: jobRatioState.jobsSort || 'volume',
  });
  if (jobRatioState.jobsMonth) params.set('month', String(jobRatioState.jobsMonth));
  if (jobRatioState.jobsBucket) params.set('bucket', jobRatioState.jobsBucket);

  try {
    const payload = await jobRatioFetchJson(`/api/job-ratio/detail?${params}`);
    jobRatioState.jobsRows = payload.rows || [];
    jobRatioState.jobsTotalValue = payload.total_value ?? null;
  } catch (err) {
    jobRatioState.jobsRows = [];
    jobRatioState.jobsTotalValue = null;
    jobRatioState.error = String(err.message || err);
    console.error(err);
  } finally {
    jobRatioState.jobsLoading = false;
    if (jobRatioState.view === 'jobs') jobRatioRender();
  }
}

function jobRatioPopulatePartsCustomerOptions(options) {
  const el = document.getElementById('job-ratio-parts-customer');
  if (!el) return;
  const current = jobRatioState.partsCustomer;
  const items = ['<option value="">All customers</option>'];
  (options || []).forEach(customer => {
    const code = String(customer.customer_code || '');
    const name = String(customer.customer_name || code);
    items.push(`<option value="${escapeHtml(code)}">${escapeHtml(name)} (${escapeHtml(code)})</option>`);
  });
  el.innerHTML = items.join('');
  el.value = current;
}

async function jobRatioLoadParts(refresh = false) {
  if (jobRatioNoPsTypesSelected()) return;
  jobRatioState.partsLoading = true;
  if (jobRatioState.view === 'parts') jobRatioRenderParts();

  const params = new URLSearchParams({
    year: String(jobRatioState.year),
    pp_types: jobRatioPpTypesQuery(),
    score_mode: jobRatioState.partsScoreMode,
    sort: jobRatioState.partsSort || 'score',
  });
  if (jobRatioState.partsCustomer) params.set('customer_code', jobRatioState.partsCustomer);
  if (jobRatioState.partsMonth) params.set('month', String(jobRatioState.partsMonth));
  if (jobRatioState.partsMinQty > 0) params.set('min_qty', String(jobRatioState.partsMinQty));
  if (jobRatioState.partsMinValue > 0) params.set('min_value', String(jobRatioState.partsMinValue));
  if (refresh) params.set('refresh', '1');

  try {
    const payload = await jobRatioFetchJson(`/api/job-ratio/parts?${params}`);
    jobRatioState.partsData = payload;
    jobRatioPopulatePartsCustomerOptions(payload.customer_options);
    jobRatioState.error = '';
  } catch (err) {
    jobRatioState.partsData = null;
    jobRatioState.error = String(err.message || err);
    console.error(err);
  } finally {
    jobRatioState.partsLoading = false;
    if (jobRatioState.view === 'parts') jobRatioRender();
  }
}

async function jobRatioLoadCustomerLines(customerCode) {
  const cacheKey = jobRatioCustomerLinesCacheKey(customerCode);
  if (jobRatioState.customerLines.has(cacheKey)) return;

  jobRatioState.customerLinesLoading.add(customerCode);
  if (jobRatioState.view === 'customers') jobRatioRenderCustomers();

  const params = new URLSearchParams({
    year: String(jobRatioState.year),
    pp_types: jobRatioPpTypesQuery(),
    customer_code: customerCode,
  });
  if (jobRatioState.customerMonth) params.set('month', String(jobRatioState.customerMonth));
  if (jobRatioState.customerBucket) params.set('bucket', jobRatioState.customerBucket);

  try {
    const payload = await jobRatioFetchJson(`/api/job-ratio/detail?${params}`);
    jobRatioState.customerLines.set(cacheKey, payload.rows || []);
  } catch (err) {
    jobRatioState.customerLines.set(cacheKey, []);
    console.error(err);
  } finally {
    jobRatioState.customerLinesLoading.delete(customerCode);
    if (jobRatioState.view === 'customers') jobRatioRenderCustomers();
  }
}

async function jobRatioToggleCustomer(customerCode) {
  if (jobRatioState.expandedCustomers.has(customerCode)) {
    jobRatioState.expandedCustomers.delete(customerCode);
    jobRatioRenderCustomers();
    return;
  }
  jobRatioState.expandedCustomers.add(customerCode);
  jobRatioRenderCustomers();
  await jobRatioLoadCustomerLines(customerCode);
}

async function jobRatioLoad(refresh = false) {
  if (jobRatioNoPsTypesSelected()) {
    jobRatioState.data = null;
    jobRatioRender();
    return;
  }

  jobRatioSetLoading(true);
  const params = new URLSearchParams({
    year: String(jobRatioState.year),
    pp_types: jobRatioPpTypesQuery(),
  });
  if (refresh) params.set('refresh', '1');

  try {
    const payload = await jobRatioFetchJson(`/api/job-ratio/report?${params}`);
    jobRatioState.data = payload;
    jobRatioState.customerLines.clear();
    jobRatioState.expandedCustomers.clear();
    jobRatioState.expandedLineGroups.clear();
    jobRatioState.jobsRows = null;
    jobRatioState.jobsTotalValue = null;
    jobRatioState.partsData = null;
    jobRatioState.expandedJobGroups.clear();
    jobRatioState.error = '';
    jobRatioPopulateFilterOptions();
  } catch (err) {
    jobRatioState.data = null;
    jobRatioState.error = String(err.message || err);
    console.error(err);
  } finally {
    jobRatioSetLoading(false);
    jobRatioRender();
  }
  if (jobRatioState.view === 'parts' && jobRatioState.data) {
    await jobRatioLoadParts(false);
  }
}

function jobRatioSetView(view) {
  jobRatioState.view = view;
  document.querySelectorAll('[data-jr-view]').forEach(btn => {
    const active = btn.dataset.jrView === view;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (view === 'jobs' && jobRatioState.jobsRows === null) {
    jobRatioLoadJobs();
  } else if (view === 'parts' && jobRatioState.partsData === null) {
    jobRatioLoadParts();
  } else {
    jobRatioRender();
  }
}

function jobRatioApplyPartsFilters(options = {}) {
  if (options.customer !== undefined) jobRatioState.partsCustomer = options.customer;
  if (options.month !== undefined) jobRatioState.partsMonth = options.month;
  if (options.minQty !== undefined) jobRatioState.partsMinQty = options.minQty;
  if (options.minValue !== undefined) jobRatioState.partsMinValue = options.minValue;
  if (options.scoreMode !== undefined) jobRatioState.partsScoreMode = options.scoreMode;
  if (options.sort !== undefined) jobRatioState.partsSort = options.sort;
  jobRatioState.partsData = null;
  jobRatioSyncPartsFilters();
  if (jobRatioState.view === 'parts') jobRatioLoadParts();
  else jobRatioRender();
}

function jobRatioApplyJobsFilters(options = {}) {
  if (options.month !== undefined) jobRatioState.jobsMonth = options.month;
  if (options.bucket !== undefined) jobRatioState.jobsBucket = options.bucket;
  if (options.sort !== undefined) jobRatioState.jobsSort = options.sort;
  jobRatioState.jobsRows = null;
  jobRatioState.jobsTotalValue = null;
  jobRatioState.expandedJobGroups.clear();
  jobRatioSyncJobsFilters();
  if (jobRatioState.view === 'jobs') jobRatioLoadJobs();
  else jobRatioRender();
}

function jobRatioApplyCustomerFilters(options = {}) {
  if (options.month !== undefined) jobRatioState.customerMonth = options.month;
  if (options.bucket !== undefined) jobRatioState.customerBucket = options.bucket;
  jobRatioState.customerLines.clear();
  jobRatioState.expandedCustomers.clear();
  jobRatioState.expandedLineGroups.clear();
  jobRatioSyncCustomerFilters();
  jobRatioRender();
}

function jobRatioToggleJobGroup(btn) {
  const type = btn.dataset.jrJobGroup;
  let id;
  if (type === 'month') id = btn.dataset.month;
  else id = `${btn.dataset.month}:${btn.dataset.bucket}`;
  const key = jobRatioJobGroupKey(type, id);
  if (jobRatioState.expandedJobGroups.has(key)) jobRatioState.expandedJobGroups.delete(key);
  else jobRatioState.expandedJobGroups.add(key);
  jobRatioRenderJobs();
}

function jobRatioExpandAllJobGroups() {
  const rows = jobRatioState.jobsRows || [];
  const months = [...new Set(rows.map(l => jobRatioLineReportMonth(l) || 0))];
  months.forEach(month => {
    jobRatioState.expandedJobGroups.add(jobRatioJobGroupKey('month', month));
    JOB_RATIO_BUCKETS.forEach(bucket => {
      if (rows.some(r => (jobRatioLineReportMonth(r) || 0) === month && r.volume_bucket === bucket)) {
        jobRatioState.expandedJobGroups.add(jobRatioJobGroupKey('bucket', `${month}:${bucket}`));
      }
    });
  });
  jobRatioRenderJobs();
}

function jobRatioCollapseAllJobGroups() {
  jobRatioState.expandedJobGroups.clear();
  jobRatioRenderJobs();
}

function jobRatioToggleLineGroup(btn) {
  const customerCode = btn.dataset.customer;
  const type = btn.dataset.jrLineGroup;
  let id;
  if (type === 'month') id = btn.dataset.month;
  else if (btn.dataset.month) id = `${btn.dataset.month}:${btn.dataset.so}`;
  else id = btn.dataset.so;
  const key = jobRatioLineGroupKey(customerCode, type, id);
  if (jobRatioState.expandedLineGroups.has(key)) jobRatioState.expandedLineGroups.delete(key);
  else jobRatioState.expandedLineGroups.add(key);
  jobRatioRenderCustomers();
}

function jobRatioExpandAllLineGroups(customerCode) {
  const lines = jobRatioState.customerLines.get(jobRatioCustomerLinesCacheKey(customerCode)) || [];
  if (jobRatioState.linesGroupBy === 'month') {
    const months = [...new Set(lines.map(l => jobRatioLineReportMonth(l) || 0))];
    months.forEach(month => {
      jobRatioState.expandedLineGroups.add(jobRatioLineGroupKey(customerCode, 'month', month));
      lines.filter(l => (jobRatioLineReportMonth(l) || 0) === month).forEach(l => {
        jobRatioState.expandedLineGroups.add(
          jobRatioLineGroupKey(customerCode, 'so', `${month}:${l.sales_order_no || '—'}`)
        );
      });
    });
  } else {
    [...new Set(lines.map(l => l.sales_order_no || '—'))].forEach(so => {
      jobRatioState.expandedLineGroups.add(jobRatioLineGroupKey(customerCode, 'so', so));
    });
  }
  jobRatioRenderCustomers();
}

function jobRatioCollapseAllLineGroups(customerCode) {
  [...jobRatioState.expandedLineGroups].forEach(key => {
    if (key.startsWith(`${customerCode}|`)) jobRatioState.expandedLineGroups.delete(key);
  });
  jobRatioRenderCustomers();
}

function jobRatioApplyPreset(preset) {
  document.querySelectorAll('[data-jr-preset]').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.jrPreset === preset);
  });
  if (preset === 'all') {
    jobRatioState.ppTypes = new Set(JOB_RATIO_PS_TYPES);
  } else if (preset === 'aps') {
    jobRatioState.ppTypes = new Set(['APS']);
  } else if (preset === 'nps') {
    jobRatioState.ppTypes = new Set(['NPS']);
  } else {
    jobRatioState.ppTypes = new Set(['APS', 'NPS']);
  }
  jobRatioSyncPsTypeCheckboxes();
  jobRatioLoad(true);
}

function jobRatioExportCsv() {
  const data = jobRatioState.data;
  if (!data) return;

  let rows = [];
  let filename = `job-ratio-${data.year}.csv`;

  if (jobRatioState.view === 'matrix') {
    const report = jobRatioReportData();
    if (report?.matrix) {
      rows.push(['Category', ...report.matrix.months.flatMap(m => [`${m.label} Jobs`, `${m.label} $`]), 'YTD Jobs', 'YTD $']);
      JOB_RATIO_BUCKETS.forEach(bid => {
        const label = data.bucket_meta?.[bid]?.label || bid;
        const line = [label];
        report.matrix.months.forEach(m => {
          const b = m.buckets?.[bid] || {};
          line.push(b.count ?? '', b.value ?? '');
        });
        const yb = report.matrix.ytd?.buckets?.[bid] || {};
        line.push(yb.count ?? '', yb.value ?? '');
        rows.push(line);
      });
    }
    filename = `job-ratio-${data.year}.csv`;
  } else if (jobRatioState.view === 'jobs') {
    rows.push([
      'Month', 'Volume category', 'SO', 'Line', 'Customer', 'Part', 'Qty', 'Value ($)',
      'PO due', 'Description', 'PP type', 'Process sheet',
    ]);
    (jobRatioState.jobsRows || []).forEach(row => {
      const month = jobRatioLineReportMonth(row);
      rows.push([
        month ? jobRatioMonthLabel(month, data.year) : '',
        jobRatioBucketLabel(row.volume_bucket) || '',
        row.sales_order_no, row.line_item_no, row.customer_name, row.inventory_code,
        row.qty, row.line_amount, row.po_due_date || row.pp_due_date,
        row.description, (row.pp_types_on_line || []).join('; ') || row.pp_type,
        (row.process_sheets_on_line || []).join('; ') || row.process_sheet_no,
      ]);
    });
    filename = `job-ratio-jobs-${data.year}.csv`;
  } else if (jobRatioState.view === 'parts') {
    rows.push([
      'Rank', 'Active score', 'Volume + value score', 'Repeat demand score',
      'Customer', 'Customer code', 'Part', 'Description',
      'Total qty', 'Booked value ($)', 'Average unit value ($)', 'Process sheets',
      'Sales orders', 'Volume percentile', 'Value percentile', 'Order percentile',
    ]);
    jobRatioFilteredParts().forEach(row => {
      rows.push([
        row.rank, row.score, row.volume_value_score, row.repeat_demand_score,
        row.customer_name, row.customer_code, row.part_no, row.description,
        row.total_qty, row.total_value, row.average_unit_value, row.process_sheet_count,
        row.order_count, row.volume_percentile, row.value_percentile, row.order_percentile,
      ]);
    });
    filename = `job-ratio-parts-${data.year}.csv`;
  } else {
    const report = jobRatioReportData();
    rows.push([
      'Customer', 'Code', 'Jobs', 'Total qty', 'Total $',
      ...JOB_RATIO_BUCKETS.flatMap(bid => {
        const label = data.bucket_meta?.[bid]?.label || bid;
        return [`${label} jobs %`, `${label} value %`];
      }),
    ]);
    jobRatioFilterCustomers(report?.customers).forEach(row => {
      const bucketCols = JOB_RATIO_BUCKETS.flatMap(bid => {
        const b = row.buckets?.[bid] || {};
        return [b.count_pct, b.value_pct];
      });
      rows.push([
        row.customer_name, row.customer_code, row.total_count, row.total_qty, row.total_value,
        ...bucketCols,
      ]);
    });
    filename = `job-ratio-customers-${data.year}.csv`;
  }

  const csv = rows.map(cols => cols.map(val => {
    const text = val == null ? '' : String(val);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',')).join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function jobRatioPopulateFilterOptions() {
  const monthOpts = ['<option value="">All months</option>'];
  for (let m = 1; m <= 12; m += 1) {
    const label = new Date(jobRatioState.year, m - 1, 1).toLocaleString(undefined, { month: 'long' });
    monthOpts.push(`<option value="${m}">${label}</option>`);
  }

  const bucketOpts = ['<option value="">All volume categories</option>'];
  JOB_RATIO_BUCKETS.forEach(bid => {
    const label = jobRatioBucketLabel(bid);
    bucketOpts.push(`<option value="${bid}">${escapeHtml(label)}</option>`);
  });

  ['job-ratio-customer-month', 'job-ratio-jobs-month', 'job-ratio-parts-month'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = monthOpts.join('');
  });
  ['job-ratio-customer-bucket', 'job-ratio-jobs-bucket'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = bucketOpts.join('');
  });

  const monthEl = document.getElementById('job-ratio-customer-month');
  const bucketEl = document.getElementById('job-ratio-customer-bucket');
  if (monthEl) monthEl.value = jobRatioState.customerMonth ? String(jobRatioState.customerMonth) : '';
  if (bucketEl) bucketEl.value = jobRatioState.customerBucket || '';

  const jobsMonthEl = document.getElementById('job-ratio-jobs-month');
  const jobsBucketEl = document.getElementById('job-ratio-jobs-bucket');
  const jobsSortEl = document.getElementById('job-ratio-jobs-sort');
  if (jobsMonthEl) jobsMonthEl.value = jobRatioState.jobsMonth ? String(jobRatioState.jobsMonth) : '';
  if (jobsBucketEl) jobsBucketEl.value = jobRatioState.jobsBucket || '';
  if (jobsSortEl) jobsSortEl.value = jobRatioState.jobsSort || 'volume';
  jobRatioSyncPartsFilters();
}

function jobRatioPopulateCustomerFilterOptions() {
  jobRatioPopulateFilterOptions();
}

function jobRatioInit() {
  const yearInput = document.getElementById('job-ratio-year');
  if (yearInput) {
    yearInput.value = String(jobRatioState.year);
    yearInput.addEventListener('change', () => {
      const y = parseInt(yearInput.value, 10);
      if (Number.isFinite(y)) {
        jobRatioState.year = y;
        jobRatioLoad(true);
      }
    });
  }

  document.getElementById('job-ratio-refresh')?.addEventListener('click', () => jobRatioLoad(true));
  document.getElementById('job-ratio-export')?.addEventListener('click', jobRatioExportCsv);

  document.querySelectorAll('[data-jr-view]').forEach(btn => {
    btn.addEventListener('click', () => jobRatioSetView(btn.dataset.jrView));
  });

  document.querySelectorAll('[data-jr-preset]').forEach(btn => {
    btn.addEventListener('click', () => jobRatioApplyPreset(btn.dataset.jrPreset));
  });

  const psBtn = document.getElementById('job-ratio-ps-type-btn');
  const psPanel = document.getElementById('job-ratio-ps-type-panel');
  psBtn?.addEventListener('click', () => {
    if (psPanel) psPanel.hidden = !psPanel.hidden;
  });
  psPanel?.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) jobRatioState.ppTypes.add(input.value);
      else jobRatioState.ppTypes.delete(input.value);
      document.querySelectorAll('[data-jr-preset]').forEach(btn => btn.classList.remove('is-active'));
      jobRatioSyncPsTypeCheckboxes();
      jobRatioLoad(true);
    });
  });

  document.getElementById('job-ratio-search')?.addEventListener('input', (ev) => {
    jobRatioState.search = ev.target.value;
    if (jobRatioState.view === 'jobs') jobRatioRenderJobs();
    else jobRatioRender();
  });

  document.getElementById('job-ratio-customer-month')?.addEventListener('change', (ev) => {
    const month = ev.target.value ? parseInt(ev.target.value, 10) : null;
    jobRatioApplyCustomerFilters({ month: Number.isFinite(month) ? month : null });
  });

  document.getElementById('job-ratio-customer-bucket')?.addEventListener('change', (ev) => {
    jobRatioApplyCustomerFilters({ bucket: ev.target.value || null });
  });

  document.getElementById('job-ratio-clear-customer-filters')?.addEventListener('click', () => {
    jobRatioApplyCustomerFilters({ month: null, bucket: null });
  });

  document.getElementById('job-ratio-jobs-month')?.addEventListener('change', (ev) => {
    const month = ev.target.value ? parseInt(ev.target.value, 10) : null;
    jobRatioApplyJobsFilters({ month: Number.isFinite(month) ? month : null });
  });

  document.getElementById('job-ratio-jobs-bucket')?.addEventListener('change', (ev) => {
    jobRatioApplyJobsFilters({ bucket: ev.target.value || null });
  });

  document.getElementById('job-ratio-jobs-sort')?.addEventListener('change', (ev) => {
    jobRatioApplyJobsFilters({ sort: ev.target.value || 'volume' });
  });

  document.getElementById('job-ratio-clear-jobs-filters')?.addEventListener('click', () => {
    jobRatioApplyJobsFilters({ month: null, bucket: null, sort: 'volume' });
  });

  document.getElementById('job-ratio-parts-customer')?.addEventListener('change', (ev) => {
    jobRatioApplyPartsFilters({ customer: ev.target.value || '' });
  });
  document.getElementById('job-ratio-parts-month')?.addEventListener('change', (ev) => {
    const month = ev.target.value ? parseInt(ev.target.value, 10) : null;
    jobRatioApplyPartsFilters({ month: Number.isFinite(month) ? month : null });
  });
  document.getElementById('job-ratio-parts-min-qty')?.addEventListener('change', (ev) => {
    const value = Number(ev.target.value);
    jobRatioApplyPartsFilters({ minQty: Number.isFinite(value) && value > 0 ? value : 0 });
  });
  document.getElementById('job-ratio-parts-min-value')?.addEventListener('change', (ev) => {
    const value = Number(ev.target.value);
    jobRatioApplyPartsFilters({ minValue: Number.isFinite(value) && value > 0 ? value : 0 });
  });
  document.getElementById('job-ratio-parts-score-mode')?.addEventListener('change', (ev) => {
    jobRatioApplyPartsFilters({ scoreMode: ev.target.value || 'volume_value' });
  });
  document.getElementById('job-ratio-parts-sort')?.addEventListener('change', (ev) => {
    jobRatioApplyPartsFilters({ sort: ev.target.value || 'score' });
  });
  document.getElementById('job-ratio-clear-parts-filters')?.addEventListener('click', () => {
    jobRatioApplyPartsFilters({
      customer: '',
      month: null,
      minQty: 0,
      minValue: 0,
      scoreMode: 'volume_value',
      sort: 'score',
    });
  });
  document.getElementById('job-ratio-parts-content')?.addEventListener('click', (ev) => {
    const sortButton = ev.target.closest('[data-jr-parts-sort]');
    if (sortButton) jobRatioApplyPartsFilters({ sort: sortButton.dataset.jrPartsSort });
  });

  document.getElementById('job-ratio-matrix-wrap')?.addEventListener('click', (ev) => {
    const cell = ev.target.closest('[data-jr-drill]');
    if (!cell) return;
    const month = cell.dataset.month ? parseInt(cell.dataset.month, 10) : null;
    const bucket = cell.dataset.bucket || null;
    jobRatioState.view = 'jobs';
    document.querySelectorAll('[data-jr-view]').forEach(btn => {
      const active = btn.dataset.jrView === 'jobs';
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    jobRatioState.jobsMonth = Number.isFinite(month) ? month : null;
    jobRatioState.jobsBucket = bucket || null;
    jobRatioState.jobsRows = null;
    jobRatioState.jobsTotalValue = null;
    jobRatioState.expandedJobGroups.clear();
    jobRatioSyncJobsFilters();
    jobRatioLoadJobs();
  });

  document.getElementById('job-ratio-jobs-content')?.addEventListener('click', (ev) => {
    const groupBtn = ev.target.closest('[data-jr-job-group]');
    if (groupBtn) {
      ev.preventDefault();
      jobRatioToggleJobGroup(groupBtn);
      return;
    }
    if (ev.target.closest('#job-ratio-jobs-expand-all')) {
      jobRatioExpandAllJobGroups();
      return;
    }
    if (ev.target.closest('#job-ratio-jobs-collapse-all')) {
      jobRatioCollapseAllJobGroups();
    }
  });

  document.getElementById('job-ratio-customers-list')?.addEventListener('click', (ev) => {
    const groupBtn = ev.target.closest('[data-jr-line-group]');
    if (groupBtn) {
      ev.preventDefault();
      jobRatioToggleLineGroup(groupBtn);
      return;
    }
    const groupByBtn = ev.target.closest('[data-jr-lines-group]');
    if (groupByBtn) {
      jobRatioState.linesGroupBy = groupByBtn.dataset.jrLinesGroup;
      jobRatioState.expandedLineGroups.clear();
      jobRatioRenderCustomers();
      return;
    }
    const expandAllBtn = ev.target.closest('[data-jr-lines-expand-all]');
    if (expandAllBtn) {
      jobRatioExpandAllLineGroups(expandAllBtn.dataset.jrLinesExpandAll);
      return;
    }
    const collapseAllBtn = ev.target.closest('[data-jr-lines-collapse-all]');
    if (collapseAllBtn) {
      jobRatioCollapseAllLineGroups(collapseAllBtn.dataset.jrLinesCollapseAll);
      return;
    }
    const summary = ev.target.closest('.job-ratio-cust-summary');
    if (!summary) return;
    const card = summary.closest('[data-customer]');
    if (!card) return;
    jobRatioToggleCustomer(card.dataset.customer);
  });

  document.addEventListener('click', (ev) => {
    const dropdown = document.getElementById('job-ratio-ps-type-dropdown');
    if (dropdown && !dropdown.contains(ev.target) && psPanel) psPanel.hidden = true;
  });

  jobRatioSyncPsTypeCheckboxes();
  jobRatioPopulateFilterOptions();
  jobRatioLoad(false);
}

document.addEventListener('DOMContentLoaded', jobRatioInit);
