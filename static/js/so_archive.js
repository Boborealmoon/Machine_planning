/* SO Line Archive - APS / NPS / Other + recent SO notifications */

const SOA_LINES_SUBTITLE = 'Sales order / process sheet / shipment lines - APS, NPS, and other PS. Columns match the Power Query export order.';
const SOA_ANALYTICS_SUBTITLE = 'Sample visual analytics from the sales-report year payload: composition, PP mix, customer concentration, and OTIF vs PO due.';

const soaState = {
  tab: 'lines',
  loading: false,
  data: null,
  buckets: new Set(['APS', 'NPS']),
  lookback: '60',
  search: '',
  collapsed: new Set(),
  openLines: new Set(),
  focusSo: '',
};

function soaReadTab() {
  try {
    const tab = new URLSearchParams(window.location.search).get('tab');
    if (tab === 'analytics') return 'analytics';
  } catch (err) {
    /* ignore */
  }
  return 'lines';
}

function soaWriteTab(tab) {
  try {
    const url = new URL(window.location.href);
    if (tab === 'analytics') url.searchParams.set('tab', 'analytics');
    else url.searchParams.delete('tab');
    history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (err) {
    /* ignore */
  }
}

function soaApplyTab(tab, options = {}) {
  const next = tab === 'analytics' ? 'analytics' : 'lines';
  const changed = soaState.tab !== next;
  soaState.tab = next;
  soaWriteTab(next);

  document.querySelectorAll('.soa-tab').forEach((btn) => {
    const on = btn.dataset.tab === next;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  const linesPanel = soaEl('soa-panel-lines');
  const analyticsPanel = soaEl('soa-panel-analytics');
  const layout = soaEl('soa-layout');
  const subtitle = soaEl('soa-subtitle');
  const exportBtn = soaEl('soa-export');
  if (linesPanel) linesPanel.hidden = next !== 'lines';
  if (analyticsPanel) analyticsPanel.hidden = next !== 'analytics';
  layout?.classList.toggle('is-analytics', next === 'analytics');
  if (subtitle) subtitle.textContent = next === 'analytics' ? SOA_ANALYTICS_SUBTITLE : SOA_LINES_SUBTITLE;
  if (exportBtn && next === 'analytics') exportBtn.hidden = true;
  else if (exportBtn && next === 'lines') exportBtn.hidden = !(soaState.data?.rows && soaState.data.rows.length);

  if (next === 'analytics') {
    window.soaAnalytics?.ensureLoaded();
    return;
  }
  if (options.initial || !soaState.data) {
    loadArchive();
  }
  if (changed && options.scroll !== false) {
    linesPanel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

const SOA_DETAIL_FIELDS = [
  ['source_voucher_line_item_no', 'Line'],
  ['process_sheet_no', 'Process sheet'],
  ['inventory_code', 'Inventory'],
  ['main_desc', 'Description'],
  ['po_due_date', 'PO due'],
  ['qty', 'Qty'],
  ['customer_po_no', 'Customer PO'],
  ['customer_po_line_item_no', 'Cust PO line'],
  ['status', 'Status'],
  ['qty_issued', 'Qty issued'],
  ['invoice_no', 'Invoice'],
  ['invoice_line_item_no', 'Invoice line'],
  ['shipment_voucher_no', 'Shipment'],
  ['unit_selling_price', 'Unit price'],
  ['line_item_description', 'Line desc'],
  ['arrival_date', 'Arrival'],
  ['exch_rate', 'Exch rate'],
  ['do_no', 'DO no'],
  ['do_generation_datetime', 'DO datetime'],
  ['proposed_edd', 'Proposed EDD'],
  ['reference_no', 'Reference'],
  ['sales_order_date', 'SO date'],
  ['customer_code', 'Customer'],
  ['total_home_amt', 'Home amt'],
];

function soaEl(id) {
  return document.getElementById(id);
}

function soaEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function soaFormatDate(value) {
  const text = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text || '-';
  const [y, m, d] = text.split('-');
  return `${d}/${m}/${y}`;
}

function soaFormatNum(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return num.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(num) ? 0 : Math.min(digits, 2),
    maximumFractionDigits: digits,
  });
}

function soaFormatPosted(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  const datePart = text.slice(0, 10);
  const timePart = text.length >= 16 ? text.slice(11, 16) : '';
  return timePart ? `${soaFormatDate(datePart)} ${timePart}` : soaFormatDate(datePart);
}

function soaAuthHeaders() {
  const headers = { Accept: 'application/json' };
  if (window.__reportsAuthToken) {
    headers['X-Reports-Token'] = window.__reportsAuthToken;
  }
  return headers;
}

function soaLineKey(line) {
  return [
    line?.source_voucher_no || '',
    line?.source_voucher_line_item_no || '',
    line?.process_sheet_no || '',
  ].join('|');
}

function soaMatchesSearch(group, query) {
  if (!query) return true;
  const hay = [
    group.source_voucher_no,
    group.customer_code,
    group.customer_po_no,
    group.reference_no,
    ...(group.lines || []).flatMap((line) => [
      line.process_sheet_no,
      line.inventory_code,
      line.main_desc,
      line.status,
      line.invoice_no,
      line.do_no,
      line.customer_po_no,
    ]),
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(query);
}

function soaVisibleGroups() {
  const data = soaState.data;
  if (!data?.groups) return [];
  const query = soaState.search.trim().toLowerCase();
  return data.groups
    .map((group) => {
      const lines = (group.lines || []).filter(soaLineMatchesFilter);
      if (!lines.length) return null;
      const buckets = [...new Set(lines.map(soaLineBucket))];
      const openCount = lines.filter((line) => {
        const status = String(line.status || '').trim().toLowerCase();
        return !status || status === 'open';
      }).length;
      return {
        ...group,
        lines,
        line_count: lines.length,
        open_count: openCount,
        buckets,
        ps_bucket: buckets.length === 1 ? buckets[0] : 'MIXED',
      };
    })
    .filter((group) => group && soaMatchesSearch(group, query));
}

function soaPsBucketFromPs(processSheetNo) {
  const raw = String(processSheetNo || '').trim().split('::')[0].toUpperCase();
  if (!raw) return 'OTHER';
  if (raw.includes('[SR]') || /^SR\b/.test(raw) || raw.startsWith('SR')) {
    // SR is not APS/NPS
    if (raw.startsWith('APS')) return 'APS';
    if (raw.startsWith('NPS')) return 'NPS';
    return 'OTHER';
  }
  if (raw.startsWith('APS')) return 'APS';
  if (raw.startsWith('NPS')) return 'NPS';
  return 'OTHER';
}

function soaLineBucket(line) {
  const ps = line?.process_sheet_no || line?.pp_voucher_no || '';
  if (String(ps).trim()) return soaPsBucketFromPs(ps);
  // Blank PS must never pass as APS/NPS
  return 'OTHER';
}

function soaLineMatchesFilter(line) {
  return soaState.buckets.has(soaLineBucket(line));
}

function soaBucketLabel(buckets) {
  const list = [...(buckets || [])].sort();
  if (!list.length || list.length === 3) return 'all PS';
  if (list.length === 2 && list.includes('APS') && list.includes('NPS')) return 'APS + NPS';
  return list.join(' + ');
}

function soaPillClass(bucket) {
  if (bucket === 'APS') return 'soa-pill soa-pill--aps';
  if (bucket === 'NPS') return 'soa-pill soa-pill--nps';
  if (bucket === 'OTHER') return 'soa-pill soa-pill--other';
  return 'soa-pill';
}

function soaStatusPill(status) {
  const raw = String(status || 'Open').trim() || 'Open';
  const lower = raw.toLowerCase();
  const cls =
    lower === 'open'
      ? 'soa-pill soa-pill--open'
      : lower.includes('history') || lower.includes('ship')
        ? 'soa-pill soa-pill--shipped'
        : 'soa-pill soa-pill--muted';
  return `<span class="${cls}">${soaEscape(raw)}</span>`;
}

function renderKpi(groups, counts) {
  const el = soaEl('soa-kpi');
  if (!el) return;
  const lines = groups.reduce((sum, g) => sum + (g.line_count || 0), 0);
  const open = groups.reduce((sum, g) => sum + (g.open_count || 0), 0);
  el.hidden = false;
  el.innerHTML = `
    <div class="soa-kpi-card">
      <span class="soa-kpi-label">Sales orders</span>
      <strong class="soa-kpi-value">${groups.length}</strong>
    </div>
    <div class="soa-kpi-card">
      <span class="soa-kpi-label">Lines</span>
      <strong class="soa-kpi-value">${lines}</strong>
    </div>
    <div class="soa-kpi-card">
      <span class="soa-kpi-label">Open lines</span>
      <strong class="soa-kpi-value">${open}</strong>
    </div>
    <div class="soa-kpi-card">
      <span class="soa-kpi-label">APS / NPS / Other</span>
      <strong class="soa-kpi-value">${counts?.APS || 0} / ${counts?.NPS || 0} / ${counts?.OTHER || 0}</strong>
    </div>
  `;
}

function renderLineDetail(line) {
  const items = SOA_DETAIL_FIELDS.map(([key, label]) => {
    let value = line?.[key];
    if (key.endsWith('_date') || key === 'po_due_date' || key === 'proposed_edd' || key === 'arrival_date') {
      value = soaFormatDate(value);
    } else if (key === 'do_generation_datetime') {
      value = soaFormatPosted(value);
    } else if (key === 'qty' || key === 'qty_issued' || key === 'exch_rate') {
      value = soaFormatNum(value, 4);
    } else if (key === 'unit_selling_price' || key === 'total_home_amt') {
      value = soaFormatNum(value, 2);
    } else {
      value = value == null || value === '' ? '-' : String(value);
    }
    return `
      <div class="soa-detail-item">
        <dt>${soaEscape(label)}</dt>
        <dd>${soaEscape(value)}</dd>
      </div>
    `;
  }).join('');
  return `<dl class="soa-detail-grid">${items}</dl>`;
}

function renderLine(line) {
  const key = soaLineKey(line);
  const open = soaState.openLines.has(key);
  const bucket = String(line.ps_bucket || 'OTHER').toUpperCase();
  return `
    <article class="soa-line ${open ? 'is-open' : ''}" data-line-key="${soaEscape(key)}">
      <button type="button" class="soa-line-toggle" data-action="toggle-line" data-line-key="${soaEscape(key)}">
        <span class="${soaPillClass(bucket)}">${soaEscape(bucket)}</span>
        <span class="soa-line-ps">${soaEscape(line.process_sheet_no || '-')}</span>
        <span class="soa-line-part">
          <strong>${soaEscape(line.inventory_code || '-')}</strong>
          <span>${soaEscape(line.main_desc || line.line_item_description || 'No description')}</span>
        </span>
        <span class="soa-line-meta">
          ${soaStatusPill(line.status)}
          <span class="soa-pill soa-pill--muted">Qty ${soaEscape(soaFormatNum(line.qty, 4))}</span>
          <span class="soa-pill soa-pill--muted">Due ${soaEscape(soaFormatDate(line.po_due_date))}</span>
        </span>
      </button>
      <div class="soa-line-detail">${renderLineDetail(line)}</div>
    </article>
  `;
}

function renderGroup(group) {
  const so = group.source_voucher_no;
  const collapsed = soaState.collapsed.has(so);
  const bucketPills = (group.buckets || [])
    .map((b) => `<span class="${soaPillClass(b)}">${soaEscape(b)}</span>`)
    .join('');
  const focusCls = soaState.focusSo === so ? ' is-focused' : '';
  return `
    <article class="soa-group ${collapsed ? 'is-collapsed' : ''}${focusCls}" id="soa-group-${soaEscape(so)}" data-so="${soaEscape(so)}">
      <button type="button" class="soa-group-toggle" data-action="toggle-group" data-so="${soaEscape(so)}">
        <svg class="soa-group-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path fill="currentColor" d="M4.2 6.2a.75.75 0 0 1 1.06 0L8 8.94l2.74-2.74a.75.75 0 1 1 1.06 1.06l-3.27 3.27a.75.75 0 0 1-1.06 0L4.2 7.26a.75.75 0 0 1 0-1.06z"/>
        </svg>
        <span class="soa-group-id">${soaEscape(so)}</span>
        <span class="soa-group-pills">
          ${bucketPills}
          <span class="soa-pill soa-pill--muted">${soaEscape(group.customer_code || 'No customer')}</span>
          ${group.customer_po_no ? `<span class="soa-pill soa-pill--muted">PO ${soaEscape(group.customer_po_no)}</span>` : ''}
          <span class="soa-pill soa-pill--open">${Number(group.open_count || 0)} open</span>
          <span class="soa-pill">${Number(group.line_count || 0)} lines</span>
          <span class="soa-pill soa-pill--muted">${soaEscape(soaFormatPosted(group.first_posted_datetime || group.sales_order_date))}</span>
        </span>
      </button>
      <div class="soa-group-body">
        ${(group.lines || []).map(renderLine).join('')}
      </div>
    </article>
  `;
}

function renderGroups() {
  const wrap = soaEl('soa-groups');
  const empty = soaEl('soa-empty');
  const groups = soaVisibleGroups();
  if (!wrap || !empty) return;

  if (!groups.length) {
    wrap.hidden = true;
    wrap.innerHTML = '';
    empty.hidden = false;
    return;
  }

  empty.hidden = true;
  wrap.hidden = false;
  wrap.innerHTML = groups.map(renderGroup).join('');
}

function renderNotifications() {
  const list = soaEl('soa-notify-list');
  const badge = soaEl('soa-notify-badge');
  const sub = soaEl('soa-notify-sub');
  if (!list || !badge || !sub) return;

  // Build from filtered groups so MPS / blank-PS never leak past APS+NPS.
  const recent = soaVisibleGroups().slice(0, 10).map((group) => {
    const line = (group.lines || []).find((row) => String(row.process_sheet_no || '').trim())
      || (group.lines || [])[0]
      || {};
    return {
      source_voucher_no: group.source_voucher_no,
      process_sheet_no: line.process_sheet_no || '',
      inventory_code: line.inventory_code || line.sample_part || '',
      main_desc: line.main_desc || line.sample_desc || '',
    };
  });

  badge.textContent = String(recent.length);
  sub.textContent = `Last ${recent.length || 10} for ${soaBucketLabel(soaState.buckets)}.`;

  if (!recent.length) {
    list.innerHTML = '<div class="soa-notify-empty">No new sales orders for this filter.</div>';
    return;
  }

  list.innerHTML = recent
    .map((item) => {
      const active = soaState.focusSo === item.source_voucher_no ? ' is-active' : '';
      const ps = item.process_sheet_no || '-';
      const part = item.inventory_code || '-';
      const desc = item.main_desc || 'No description';
      return `
        <button type="button" class="soa-notify-card${active}" data-action="focus-so" data-so="${soaEscape(item.source_voucher_no)}">
          <p class="soa-notify-so">${soaEscape(item.source_voucher_no)}</p>
          <p class="soa-notify-ps">${soaEscape(ps)}</p>
          <p class="soa-notify-part">${soaEscape(part)}</p>
          <p class="soa-notify-desc">${soaEscape(desc)}</p>
        </button>
      `;
    })
    .join('');
}

function updateMeta() {
  const meta = soaEl('soa-meta');
  const data = soaState.data;
  if (!meta || !data) return;
  const groups = soaVisibleGroups();
  const lines = groups.reduce((sum, g) => sum + (g.line_count || 0), 0);
  meta.innerHTML = `<strong>${groups.length}</strong> orders / <strong>${lines}</strong> lines / ${soaEscape(data.from)} to ${soaEscape(data.to)}`;
}

function updateLookbackVisibility() {
  const custom = soaState.lookback === 'custom';
  const fromWrap = soaEl('soa-from-wrap');
  const toWrap = soaEl('soa-to-wrap');
  if (fromWrap) fromWrap.hidden = !custom;
  if (toWrap) toWrap.hidden = !custom;
}

function updateBucketChips() {
  document.querySelectorAll('.soa-bucket-chip').forEach((btn) => {
    const key = btn.dataset.bucket || '';
    const active = soaState.buckets.has(key);
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function setAlert(message) {
  const el = soaEl('soa-alert');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function setLoading(loading) {
  soaState.loading = loading;
  const el = soaEl('soa-loading');
  if (el) el.hidden = !loading;
}

async function loadArchive({ refresh = false } = {}) {
  setLoading(true);
  setAlert('');
  updateLookbackVisibility();
  updateBucketChips();

  const params = new URLSearchParams();
  params.set('buckets', [...soaState.buckets].join(','));
  if (refresh) params.set('refresh', '1');

  if (soaState.lookback === 'custom') {
    const from = soaEl('soa-from')?.value || '';
    const to = soaEl('soa-to')?.value || '';
    if (!from || !to) {
      setLoading(false);
      setAlert('Choose both From and To dates for a custom range.');
      return;
    }
    params.set('from', from);
    params.set('to', to);
  } else {
    params.set('days', soaState.lookback);
  }

  try {
    const res = await fetch(`/api/archive/so-lines?${params.toString()}`, {
      headers: soaAuthHeaders(),
      credentials: 'same-origin',
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload.ok === false) {
      throw new Error(payload.error || `Request failed (${res.status})`);
    }
    soaState.data = payload;
    if (!soaState.collapsed.size && payload.groups?.length) {
      // Start with groups expanded; keep any existing collapse prefs.
    }
    renderKpi(soaVisibleGroups(), payload.counts);
    renderGroups();
    renderNotifications();
    updateMeta();
    const exportBtn = soaEl('soa-export');
    if (exportBtn) exportBtn.hidden = !(payload.rows && payload.rows.length);
  } catch (err) {
    soaState.data = null;
    setAlert(err?.message || 'Failed to load SO line archive.');
    const groups = soaEl('soa-groups');
    const empty = soaEl('soa-empty');
    const kpi = soaEl('soa-kpi');
    if (groups) {
      groups.hidden = true;
      groups.innerHTML = '';
    }
    if (empty) empty.hidden = true;
    if (kpi) kpi.hidden = true;
    renderNotifications();
  } finally {
    setLoading(false);
  }
}

function exportCsv() {
  const rows = soaState.data?.rows || [];
  if (!rows.length) return;
  const columns = soaState.data?.columns || Object.keys(rows[0] || {});
  const esc = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    columns.join(','),
    ...rows.map((row) => columns.map((col) => esc(row[col])).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `so-line-archive-${[...soaState.buckets].sort().join('-').toLowerCase() || 'all'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function focusSalesOrder(soNo) {
  soaState.focusSo = soNo || '';
  if (soNo) {
    soaState.collapsed.delete(soNo);
    soaState.search = '';
    const search = soaEl('soa-search');
    if (search) search.value = '';
  }
  renderGroups();
  renderNotifications();
  updateMeta();
  if (!soNo) return;
  const target = document.getElementById(`soa-group-${soNo}`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function bindEvents() {
  document.querySelectorAll('.soa-bucket-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.bucket || '';
      if (!key) return;
      if (soaState.buckets.has(key)) {
        if (soaState.buckets.size === 1) return; // keep at least one filter on
        soaState.buckets.delete(key);
      } else {
        soaState.buckets.add(key);
      }
      soaState.focusSo = '';
      loadArchive();
    });
  });

  soaEl('soa-lookback')?.addEventListener('change', (event) => {
    soaState.lookback = event.target.value || '60';
    updateLookbackVisibility();
    if (soaState.lookback !== 'custom') loadArchive();
  });

  ['soa-from', 'soa-to'].forEach((id) => {
    soaEl(id)?.addEventListener('change', () => {
      if (soaState.lookback === 'custom') loadArchive();
    });
  });

  let searchTimer = null;
  soaEl('soa-search')?.addEventListener('input', (event) => {
    soaState.search = event.target.value || '';
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      renderKpi(soaVisibleGroups(), soaState.data?.counts);
      renderGroups();
      updateMeta();
    }, 120);
  });

  soaEl('soa-refresh')?.addEventListener('click', () => {
    if (soaState.tab === 'analytics') {
      window.soaAnalytics?.load({ refresh: true, force: true });
      return;
    }
    loadArchive({ refresh: true });
  });
  soaEl('soa-export')?.addEventListener('click', exportCsv);

  document.querySelectorAll('.soa-tab').forEach((btn) => {
    btn.addEventListener('click', () => soaApplyTab(btn.dataset.tab || 'lines'));
  });

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'toggle-group') {
      const so = btn.dataset.so || '';
      if (!so) return;
      if (soaState.collapsed.has(so)) soaState.collapsed.delete(so);
      else soaState.collapsed.add(so);
      renderGroups();
    } else if (action === 'toggle-line') {
      const key = btn.dataset.lineKey || '';
      if (!key) return;
      if (soaState.openLines.has(key)) soaState.openLines.delete(key);
      else soaState.openLines.add(key);
      renderGroups();
    } else if (action === 'focus-so') {
      focusSalesOrder(btn.dataset.so || '');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  updateLookbackVisibility();
  soaApplyTab(soaReadTab(), { initial: true, scroll: false });
});
