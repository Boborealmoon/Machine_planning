// Job ratio report — booked SO line volume mix.

const JOB_RATIO_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
const JOB_RATIO_BUCKETS = ['proto', 'micro', 'low'];

const jobRatioState = {
  data: null,
  view: 'matrix',
  search: '',
  year: new Date().getFullYear(),
  ppTypes: new Set(['APS', 'NPS']),
  loading: false,
  detailMonth: null,
  detailBucket: null,
  detailRows: null,
  detailLoading: false,
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
  if (!panel) return 'APS, NPS';
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

function jobRatioSetLoading(on) {
  jobRatioState.loading = on;
  const el = document.getElementById('job-ratio-loading');
  if (el) el.hidden = !on;
}

function jobRatioHideSections() {
  ['job-ratio-matrix-wrap', 'job-ratio-customers-wrap', 'job-ratio-detail-wrap', 'job-ratio-empty'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
}

function jobRatioTargetClass(ok) {
  return ok ? 'job-ratio-ok' : 'job-ratio-miss';
}

function jobRatioRenderMatrix() {
  const wrap = document.getElementById('job-ratio-matrix-wrap');
  const table = document.getElementById('job-ratio-matrix-table');
  const sub = document.getElementById('job-ratio-matrix-sub');
  const data = jobRatioState.data;
  if (!wrap || !table || !data?.matrix) return;

  const months = data.matrix.months || [];
  const ytd = data.matrix.ytd;
  const bucketMeta = data.bucket_meta || {};

  if (sub) {
    sub.textContent = [
      `Lens: booked (first posted) · Grain: SO line`,
      `Targets: proto >${data.targets?.proto || 20}% · micro >${data.targets?.micro || 30}% · low >${data.targets?.low || 50}%`,
    ].join(' · ');
  }

  const monthHeaders = months.flatMap(m => [
    `<th colspan="2" class="job-ratio-month-head">${escapeHtml(m.label)}</th>`,
  ]).join('');
  const ytdHeader = `<th colspan="2" class="job-ratio-month-head job-ratio-ytd-head">YTD</th>`;

  const subHeaders = [...months, { label: 'YTD' }].map(() =>
    '<th class="job-ratio-sub-head">Count</th><th class="job-ratio-sub-head">$</th>'
  ).join('');

  let body = '';

  JOB_RATIO_BUCKETS.forEach(bucketId => {
    const label = bucketMeta[bucketId]?.label || bucketId;
    body += `<tr class="job-ratio-data-row">
      <th scope="row" class="job-ratio-row-label">${escapeHtml(label)}</th>`;
    months.forEach(m => {
      const b = m.buckets?.[bucketId] || {};
      body += `<td class="job-ratio-num job-ratio-clickable" data-jr-drill="1" data-month="${m.month}" data-bucket="${bucketId}">${jobRatioFormatQty(b.count)}</td>`;
      body += `<td class="job-ratio-num job-ratio-money">${jobRatioFormatMoney(b.value)}</td>`;
    });
    const yb = ytd?.buckets?.[bucketId] || {};
    body += `<td class="job-ratio-num job-ratio-clickable job-ratio-ytd-col" data-jr-drill="1" data-bucket="${bucketId}">${jobRatioFormatQty(yb.count)}</td>`;
    body += `<td class="job-ratio-num job-ratio-money job-ratio-ytd-col">${jobRatioFormatMoney(yb.value)}</td>`;
    body += '</tr>';
  });

  // Total row
  body += `<tr class="job-ratio-total-row"><th scope="row" class="job-ratio-row-label">Total</th>`;
  months.forEach(m => {
    body += `<td class="job-ratio-num">${jobRatioFormatQty(m.total?.count)}</td>`;
    body += `<td class="job-ratio-num job-ratio-money">${jobRatioFormatMoney(m.total?.value)}</td>`;
  });
  body += `<td class="job-ratio-num job-ratio-ytd-col">${jobRatioFormatQty(ytd?.total?.count)}</td>`;
  body += `<td class="job-ratio-num job-ratio-money job-ratio-ytd-col">${jobRatioFormatMoney(ytd?.total?.value)}</td></tr>`;

  // Ratio rows
  JOB_RATIO_BUCKETS.forEach(bucketId => {
    const target = data.targets?.[bucketId] || 0;
    const short = bucketMeta[bucketId]?.short_label || bucketId;
    body += `<tr class="job-ratio-ratio-row"><th scope="row" class="job-ratio-row-label">${escapeHtml(short)} (%) &gt;${target}%</th>`;
    months.forEach(m => {
      const b = m.buckets?.[bucketId] || {};
      body += `<td class="job-ratio-num ${jobRatioTargetClass(b.count_ok)}">${jobRatioFormatPct(b.count_pct)}</td>`;
      body += `<td class="job-ratio-num ${jobRatioTargetClass(b.value_ok)}">${jobRatioFormatPct(b.value_pct)}</td>`;
    });
    const yb = ytd?.buckets?.[bucketId] || {};
    body += `<td class="job-ratio-num job-ratio-ytd-col ${jobRatioTargetClass(yb.count_ok)}">${jobRatioFormatPct(yb.count_pct)}</td>`;
    body += `<td class="job-ratio-num job-ratio-ytd-col ${jobRatioTargetClass(yb.value_ok)}">${jobRatioFormatPct(yb.value_pct)}</td>`;
    body += '</tr>';
  });

  table.innerHTML = `
    <thead>
      <tr><th rowspan="2" class="job-ratio-corner">Category</th>${monthHeaders}${ytdHeader}</tr>
      <tr>${subHeaders}</tr>
    </thead>
    <tbody>${body}</tbody>`;

  wrap.hidden = false;
}

function jobRatioFilterCustomers(customers) {
  const q = String(jobRatioState.search || '').trim().toLowerCase();
  if (!q) return customers || [];
  return (customers || []).filter(row =>
    [row.customer_code, row.customer_name].map(v => String(v || '').toLowerCase()).join(' ').includes(q)
  );
}

function jobRatioRenderCustomers() {
  const wrap = document.getElementById('job-ratio-customers-wrap');
  const thead = document.getElementById('job-ratio-customers-thead');
  const tbody = document.getElementById('job-ratio-customers-body');
  const data = jobRatioState.data;
  if (!wrap || !thead || !tbody || !data) return;

  const rows = jobRatioFilterCustomers(data.customers);
  if (!rows.length) {
    wrap.hidden = true;
    jobRatioShowEmpty('No customers match your filters.');
    return;
  }

  thead.innerHTML = `<tr>
    <th>Customer</th>
    <th>Code</th>
    <th>Jobs</th>
    <th>Total qty</th>
    <th>Total $</th>
    <th>Proto cnt%</th>
    <th>Proto $%</th>
    <th>Micro cnt%</th>
    <th>Micro $%</th>
    <th>Low cnt%</th>
    <th>Low $%</th>
  </tr>`;

  tbody.innerHTML = rows.map(row => {
    const p = row.buckets?.proto || {};
    const m = row.buckets?.micro || {};
    const l = row.buckets?.low || {};
    return `<tr>
      <td>${escapeHtml(row.customer_name || '—')}</td>
      <td class="new-orders-mono">${escapeHtml(row.customer_code || '—')}</td>
      <td class="job-ratio-num">${jobRatioFormatQty(row.total_count)}</td>
      <td class="job-ratio-num">${jobRatioFormatQty(row.total_qty)}</td>
      <td class="job-ratio-num">${jobRatioFormatMoneyFull(row.total_value)}</td>
      <td class="job-ratio-num ${jobRatioTargetClass(p.count_ok)}">${jobRatioFormatPct(p.count_pct)}</td>
      <td class="job-ratio-num ${jobRatioTargetClass(p.value_ok)}">${jobRatioFormatPct(p.value_pct)}</td>
      <td class="job-ratio-num ${jobRatioTargetClass(m.count_ok)}">${jobRatioFormatPct(m.count_pct)}</td>
      <td class="job-ratio-num ${jobRatioTargetClass(m.value_ok)}">${jobRatioFormatPct(m.value_pct)}</td>
      <td class="job-ratio-num ${jobRatioTargetClass(l.count_ok)}">${jobRatioFormatPct(l.count_pct)}</td>
      <td class="job-ratio-num ${jobRatioTargetClass(l.value_ok)}">${jobRatioFormatPct(l.value_pct)}</td>
    </tr>`;
  }).join('');

  wrap.hidden = false;
}

function jobRatioRenderDetailFilters() {
  const el = document.getElementById('job-ratio-detail-filters');
  if (!el) return;
  const monthOpts = ['<option value="">All months</option>'];
  for (let m = 1; m <= 12; m += 1) {
    const label = new Date(jobRatioState.year, m - 1, 1).toLocaleString(undefined, { month: 'short' });
    const sel = jobRatioState.detailMonth === m ? ' selected' : '';
    monthOpts.push(`<option value="${m}"${sel}>${label}</option>`);
  }
  const bucketOpts = ['<option value="">All buckets</option>'];
  JOB_RATIO_BUCKETS.forEach(bid => {
    const sel = jobRatioState.detailBucket === bid ? ' selected' : '';
    bucketOpts.push(`<option value="${bid}"${sel}>${escapeHtml(jobRatioBucketLabel(bid))}</option>`);
  });
  el.innerHTML = `
    <label>Month <select id="job-ratio-detail-month">${monthOpts.join('')}</select></label>
    <label>Bucket <select id="job-ratio-detail-bucket">${bucketOpts.join('')}</select></label>
    <button type="button" class="btn btn-ghost btn-sm" id="job-ratio-detail-reload">Reload lines</button>`;
}

function jobRatioFilterDetailRows(rows) {
  const q = String(jobRatioState.search || '').trim().toLowerCase();
  if (!q) return rows || [];
  return (rows || []).filter(row =>
    [
      row.sales_order_no, row.line_item_no, row.inventory_code, row.description,
      row.customer_code, row.customer_name, row.process_sheet_no,
    ].map(v => String(v || '').toLowerCase()).join(' ').includes(q)
  );
}

function jobRatioRenderDetail() {
  const wrap = document.getElementById('job-ratio-detail-wrap');
  const thead = document.getElementById('job-ratio-detail-thead');
  const tbody = document.getElementById('job-ratio-detail-body');
  if (!wrap || !thead || !tbody) return;

  jobRatioRenderDetailFilters();
  const rows = jobRatioFilterDetailRows(jobRatioState.detailRows);

  thead.innerHTML = `<tr>
    <th>SO</th><th>Line</th><th>Part</th><th>Description</th><th>Customer</th>
    <th>Qty</th><th>Bucket</th><th>Amount</th><th>First posted</th><th>Due</th><th>PS</th>
  </tr>`;

  if (!rows.length) {
    tbody.innerHTML = '';
    wrap.hidden = false;
    if (!jobRatioState.detailLoading) {
      jobRatioShowEmpty(jobRatioState.detailRows ? 'No lines match your filters.' : 'Click a count in the matrix or reload to load lines.');
    }
    return;
  }

  tbody.innerHTML = rows.map(row => `<tr>
    <td class="new-orders-mono">${escapeHtml(row.sales_order_no || '—')}</td>
    <td>${escapeHtml(row.line_item_no || '—')}</td>
    <td class="new-orders-mono">${escapeHtml(row.inventory_code || '—')}</td>
    <td>${escapeHtml(row.description || '—')}</td>
    <td>${escapeHtml(row.customer_name || row.customer_code || '—')}</td>
    <td class="job-ratio-num">${jobRatioFormatQty(row.qty)}</td>
    <td>${escapeHtml(jobRatioBucketLabel(row.volume_bucket) || '—')}</td>
    <td class="job-ratio-num">${jobRatioFormatMoneyFull(row.line_amount)}</td>
    <td>${jobRatioFormatDt(row.first_posted_datetime)}</td>
    <td>${jobRatioFormatDate(row.due_date)}</td>
    <td class="new-orders-mono">${escapeHtml(row.process_sheet_no || '—')}</td>
  </tr>`).join('');

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
  if (!el || !data) return;
  el.innerHTML = `
    <span class="sales-report-stat-pill">${jobRatioFormatQty(data.line_count)} jobs</span>
    <span class="sales-report-stat-pill">PP: ${escapeHtml(jobRatioPsTypeLabel())}</span>`;
}

function jobRatioRenderMeta() {
  const el = document.getElementById('job-ratio-meta');
  const data = jobRatioState.data;
  if (!el || !data) return;
  el.textContent = [
    `Year ${data.year}`,
    `PP: ${jobRatioPsTypeLabel()}`,
    data.cached_at ? `Cached ${data.cached_at}` : '',
  ].filter(Boolean).join(' · ');
  el.hidden = false;
}

function jobRatioRender() {
  if (jobRatioState.loading) return;
  jobRatioHideSections();

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

  if (jobRatioState.view === 'matrix') {
    jobRatioRenderMatrix();
  } else if (jobRatioState.view === 'customers') {
    jobRatioRenderCustomers();
  } else {
    jobRatioRenderDetail();
  }
}

async function jobRatioFetchJson(url, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
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

async function jobRatioLoadDetail(options = {}) {
  if (options.month !== undefined) jobRatioState.detailMonth = options.month;
  if (options.bucket !== undefined) jobRatioState.detailBucket = options.bucket;

  jobRatioState.detailLoading = true;
  const params = new URLSearchParams({
    year: String(jobRatioState.year),
    pp_types: jobRatioPpTypesQuery(),
  });
  if (jobRatioState.detailMonth) params.set('month', String(jobRatioState.detailMonth));
  if (jobRatioState.detailBucket) params.set('bucket', jobRatioState.detailBucket);

  try {
    const payload = await jobRatioFetchJson(`/api/job-ratio/detail?${params}`);
    jobRatioState.detailRows = payload.rows || [];
  } catch (err) {
    jobRatioState.detailRows = [];
    console.error(err);
  } finally {
    jobRatioState.detailLoading = false;
    if (jobRatioState.view === 'detail') jobRatioRender();
  }
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
    jobRatioState.detailRows = null;
    jobRatioState.error = '';
  } catch (err) {
    jobRatioState.data = null;
    jobRatioState.error = String(err.message || err);
    console.error(err);
  } finally {
    jobRatioSetLoading(false);
    jobRatioRender();
  }
}

function jobRatioSetView(view) {
  jobRatioState.view = view;
  document.querySelectorAll('[data-jr-view]').forEach(btn => {
    const active = btn.dataset.jrView === view;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const searchWrap = document.getElementById('job-ratio-search-wrap');
  if (searchWrap) searchWrap.hidden = view === 'matrix';
  if (view === 'detail' && !jobRatioState.detailRows) {
    jobRatioLoadDetail({});
  } else {
    jobRatioRender();
  }
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
    rows.push(['Category', ...data.matrix.months.flatMap(m => [`${m.label} Count`, `${m.label} $`]), 'YTD Count', 'YTD $']);
    JOB_RATIO_BUCKETS.forEach(bid => {
      const label = data.bucket_meta?.[bid]?.label || bid;
      const line = [label];
      data.matrix.months.forEach(m => {
        const b = m.buckets?.[bid] || {};
        line.push(b.count ?? '', b.value ?? '');
      });
      const yb = data.matrix.ytd?.buckets?.[bid] || {};
      line.push(yb.count ?? '', yb.value ?? '');
      rows.push(line);
    });
  } else if (jobRatioState.view === 'customers') {
    rows.push(['Customer', 'Code', 'Jobs', 'Total qty', 'Total $', 'Proto cnt%', 'Proto $%', 'Micro cnt%', 'Micro $%', 'Low cnt%', 'Low $%']);
    jobRatioFilterCustomers(data.customers).forEach(row => {
      const p = row.buckets?.proto || {};
      const m = row.buckets?.micro || {};
      const l = row.buckets?.low || {};
      rows.push([
        row.customer_name, row.customer_code, row.total_count, row.total_qty, row.total_value,
        p.count_pct, p.value_pct, m.count_pct, m.value_pct, l.count_pct, l.value_pct,
      ]);
    });
    filename = `job-ratio-customers-${data.year}.csv`;
  } else {
    rows.push(['SO', 'Line', 'Part', 'Description', 'Customer', 'Qty', 'Bucket', 'Amount', 'First posted', 'Due', 'PS']);
    jobRatioFilterDetailRows(jobRatioState.detailRows).forEach(row => {
      rows.push([
        row.sales_order_no, row.line_item_no, row.inventory_code, row.description,
        row.customer_name || row.customer_code, row.qty, row.volume_bucket, row.line_amount,
        row.first_posted_datetime, row.due_date, row.process_sheet_no,
      ]);
    });
    filename = `job-ratio-detail-${data.year}.csv`;
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
    jobRatioRender();
  });

  document.getElementById('job-ratio-matrix-table')?.addEventListener('click', (ev) => {
    const cell = ev.target.closest('[data-jr-drill]');
    if (!cell) return;
    const month = cell.dataset.month ? parseInt(cell.dataset.month, 10) : null;
    const bucket = cell.dataset.bucket || null;
    jobRatioSetView('detail');
    jobRatioLoadDetail({ month: Number.isFinite(month) ? month : null, bucket });
  });

  document.getElementById('job-ratio-detail-wrap')?.addEventListener('click', (ev) => {
    if (ev.target.id === 'job-ratio-detail-reload') {
      const monthEl = document.getElementById('job-ratio-detail-month');
      const bucketEl = document.getElementById('job-ratio-detail-bucket');
      jobRatioLoadDetail({
        month: monthEl?.value ? parseInt(monthEl.value, 10) : null,
        bucket: bucketEl?.value || null,
      });
    }
  });

  document.addEventListener('click', (ev) => {
    const dropdown = document.getElementById('job-ratio-ps-type-dropdown');
    if (dropdown && !dropdown.contains(ev.target) && psPanel) psPanel.hidden = true;
  });

  jobRatioSyncPsTypeCheckboxes();
  jobRatioLoad(false);
}

document.addEventListener('DOMContentLoaded', jobRatioInit);
