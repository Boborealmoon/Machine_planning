// New Orders — posted sales orders by working week (live ERP, short cache).

const newOrdersState = {
  rows: [],
  week: 'this_week',
  from: '',
  to: '',
  search: '',
  psTypes: new Set(['APS', 'NPS']),
  rangeLabel: '',
  cachedAt: '',
  cacheTtlSec: 300,
  collapsedGroups: new Set(),
  hideHistory: true,
};

function newOrdersLineKey(row) {
  const so = String(row?.source_voucher_no || '').trim();
  const line = String(row?.source_voucher_line_item_no ?? '').trim();
  return `${so}::${line}`;
}

function newOrdersFormatMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function newOrdersDetailField(label, value, { mono } = {}) {
  const text = value == null || value === '' ? '—' : String(value);
  const cls = mono ? ' new-orders-detail-value--mono' : '';
  return `
    <div class="new-orders-detail-field">
      <dt>${escapeHtml(label)}</dt>
      <dd class="new-orders-detail-value${cls}">${escapeHtml(text)}</dd>
    </div>
  `;
}

function newOrdersDetailSection(title, html) {
  if (!html) return '';
  return `
    <section class="new-orders-detail-section">
      <h3 class="new-orders-detail-section-title">${escapeHtml(title)}</h3>
      <dl class="new-orders-detail-grid">${html}</dl>
    </section>
  `;
}

function newOrdersRenderLineDetail(row) {
  const desc = String(row.line_item_description || row.main_desc || '').trim() || '—';
  const html = [
    newOrdersDetailField('Sales order', row.source_voucher_no, { mono: true }),
    newOrdersDetailField('Line', row.source_voucher_line_item_no),
    newOrdersPostedDetailFields(row),
    newOrdersDetailField('Customer', row.customer_code),
    newOrdersDetailField('Customer PO', row.customer_po_no),
    newOrdersDetailField('Customer PO line', row.customer_po_line_item_no),
    newOrdersDetailField('Reference no.', row.reference_no, { mono: true }),
  ].join('');
  const lineHtml = [
    newOrdersDetailField('Process sheet', row.process_sheet_no, { mono: true }),
    newOrdersDetailField('Part / inventory', row.inventory_code, { mono: true }),
    newOrdersDetailField('Main description', row.main_desc),
    newOrdersDetailField('Line description', desc),
    newOrdersDetailField('PO due date', newOrdersDateOnly(row.po_due_date)),
    newOrdersDetailField('Proposed EDD', newOrdersDateOnly(row.proposed_edd)),
    newOrdersDetailField('Qty ordered', row.qty),
    newOrdersDetailField('Qty issued', row.qty_issued),
    newOrdersDetailField('Status', row.status),
  ].join('');
  const shipHtml = [
    newOrdersDetailField('Shipment voucher', row.shipment_voucher_no, { mono: true }),
    newOrdersDetailField('Invoice no.', row.invoice_no, { mono: true }),
    newOrdersDetailField('Invoice line', row.invoice_line_item_no),
    newOrdersDetailField('DO no.', row.do_no, { mono: true }),
    newOrdersDetailField('DO generated', newOrdersFormatPosted(row.do_generation_datetime)),
    newOrdersDetailField('Arrival date', newOrdersDateOnly(row.arrival_date)),
  ].join('');
  const priceHtml = [
    newOrdersDetailField('Unit selling price', newOrdersFormatMoney(row.unit_selling_price)),
    newOrdersDetailField('Exchange rate', row.exch_rate),
    newOrdersDetailField('Total home amount', newOrdersFormatMoney(row.total_home_amt)),
  ].join('');
  return [
    newOrdersDetailSection('Order', html),
    newOrdersDetailSection('Line & PS', lineHtml),
    newOrdersDetailSection('Shipment / DO', shipHtml),
    newOrdersDetailSection('Pricing', priceHtml),
  ].join('');
}

function newOrdersRenderGroupDetail(group) {
  const headerHtml = [
    newOrdersDetailField('Sales order', group.sales_order_no, { mono: true }),
    newOrdersPostedDetailFields(group),
    newOrdersDetailField('Customer', group.customer_code),
    newOrdersDetailField('Customer PO', group.customer_po_no),
    newOrdersDetailField('Reference no.', group.reference_no, { mono: true }),
    newOrdersDetailField('Lines', group.children.length),
  ].join('');
  const linesHtml = (group.children || []).map(row => {
    const key = newOrdersLineKey(row);
    const desc = String(row.line_item_description || row.main_desc || '').trim();
    return `
      <button type="button" class="new-orders-detail-line-pick" data-line-key="${escapeHtml(key)}">
        <span class="new-orders-detail-line-pick-no">Line ${escapeHtml(String(row.source_voucher_line_item_no ?? '—'))}</span>
        <span class="new-orders-detail-line-pick-ps">${escapeHtml(String(row.process_sheet_no || '—'))}</span>
        <span class="new-orders-detail-line-pick-part">${escapeHtml(String(row.inventory_code || '—'))}</span>
        <span class="new-orders-detail-line-pick-desc">${escapeHtml(desc || '—')}</span>
      </button>
    `;
  }).join('');
  return `
    ${newOrdersDetailSection('Sales order', headerHtml)}
    <section class="new-orders-detail-section">
      <h3 class="new-orders-detail-section-title">Lines — click for full detail</h3>
      <div class="new-orders-detail-line-list">${linesHtml}</div>
    </section>
  `;
}

function newOrdersFindRowByKey(key) {
  return (newOrdersState.rows || []).find(row => newOrdersLineKey(row) === key) || null;
}

function newOrdersFindGroupBySo(soNo) {
  const filtered = newOrdersFilteredRows();
  const groups = newOrdersBuildGroups(filtered);
  return groups.find(group => group.sales_order_no === soNo) || null;
}

function newOrdersOpenDetail({ title, bodyHtml }) {
  const shell = document.getElementById('new-orders-detail');
  const titleEl = document.getElementById('new-orders-detail-title');
  const bodyEl = document.getElementById('new-orders-detail-body');
  if (!shell || !titleEl || !bodyEl) return;
  titleEl.textContent = title || 'Order detail';
  bodyEl.innerHTML = bodyHtml || '';
  shell.hidden = false;
  document.body.classList.add('new-orders-detail-open');
}

function newOrdersCloseDetail() {
  const shell = document.getElementById('new-orders-detail');
  if (!shell) return;
  shell.hidden = true;
  document.body.classList.remove('new-orders-detail-open');
}

function newOrdersOpenLineDetail(row) {
  if (!row) return;
  const so = String(row.source_voucher_no || '').trim();
  const line = String(row.source_voucher_line_item_no ?? '').trim();
  newOrdersOpenDetail({
    title: line ? `${so} · line ${line}` : so,
    bodyHtml: newOrdersRenderLineDetail(row),
  });
}

function newOrdersOpenGroupDetail(group) {
  if (!group) return;
  newOrdersOpenDetail({
    title: group.sales_order_no,
    bodyHtml: newOrdersRenderGroupDetail(group),
  });
}

function newOrdersBindDetailPanel() {
  const shell = document.getElementById('new-orders-detail');
  const closeBtn = document.getElementById('new-orders-detail-close');
  const bodyEl = document.getElementById('new-orders-detail-body');
  if (!shell) return;

  shell.querySelector('[data-action="close-detail"]')?.addEventListener('click', newOrdersCloseDetail);
  closeBtn?.addEventListener('click', newOrdersCloseDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !shell.hidden) newOrdersCloseDetail();
  });

  bodyEl?.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-line-key]');
    if (!pick || !bodyEl.contains(pick)) return;
    e.preventDefault();
    const row = newOrdersFindRowByKey(pick.dataset.lineKey);
    if (row) newOrdersOpenLineDetail(row);
  });
}

function newOrdersBindTableClicks() {
  const wrap = document.getElementById('new-orders-table-wrap');
  if (!wrap || wrap.dataset.detailBound === '1') return;
  wrap.dataset.detailBound = '1';

  wrap.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-action="toggle-group"]');
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();
      const so = String(toggle.dataset.salesOrder || '').trim();
      if (!so) return;
      if (newOrdersState.collapsedGroups.has(so)) {
        newOrdersState.collapsedGroups.delete(so);
      } else {
        newOrdersState.collapsedGroups.add(so);
      }
      newOrdersRenderTable();
      return;
    }

    const child = e.target.closest('tr.new-orders-child-row[data-line-key]');
    if (child) {
      const row = newOrdersFindRowByKey(child.dataset.lineKey);
      if (row) newOrdersOpenLineDetail(row);
      return;
    }

    const sideRail = e.target.closest('.new-orders-side-rail');
    if (sideRail && !e.target.closest('[data-action="toggle-group"]')) {
      const detail = newOrdersFindGroupBySo(sideRail.dataset.salesOrder);
      if (detail) newOrdersOpenGroupDetail(detail);
      return;
    }

    const group = e.target.closest('tr.new-orders-group-row[data-sales-order]');
    if (group) {
      const detail = newOrdersFindGroupBySo(group.dataset.salesOrder);
      if (detail) newOrdersOpenGroupDetail(detail);
    }
  });
}

function newOrdersDateOnly(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.slice(0, 10);
}

function newOrdersFormatPosted(value) {
  const text = String(value || '').trim();
  if (!text) return '—';
  return trialFormatDt(text);
}

function newOrdersIsReposted(rowOrGroup) {
  const first = String(rowOrGroup?.first_posted_datetime || '').trim();
  const latest = String(rowOrGroup?.latest_posted_datetime || '').trim();
  return Boolean(first && latest && first !== latest);
}

function newOrdersPostedDetailFields(rowOrGroup) {
  const fields = [
    newOrdersDetailField('First posted', newOrdersFormatPosted(rowOrGroup.first_posted_datetime)),
  ];
  if (newOrdersIsReposted(rowOrGroup)) {
    fields.push(newOrdersDetailField('Latest post', newOrdersFormatPosted(rowOrGroup.latest_posted_datetime)));
  }
  return fields.join('');
}

function newOrdersRenderPostedSideRail(rowOrGroup) {
  const first = newOrdersFormatPosted(rowOrGroup.first_posted_datetime);
  const reposted = newOrdersIsReposted(rowOrGroup);
  const latestBlock = reposted
    ? `<div class="new-orders-side-reposted"><span class="new-orders-side-posted-label">Latest post</span> ${escapeHtml(newOrdersFormatPosted(rowOrGroup.latest_posted_datetime))}</div>`
    : '';
  return `
    <div class="new-orders-side-posted"><span class="new-orders-side-posted-label">First posted</span> ${escapeHtml(first)}</div>
    ${latestBlock}
  `;
}

function newOrdersGetPsType(row) {
  const raw = String(row.process_sheet_no || '').split('::')[0];
  if (/\[sr\]/i.test(raw)) return 'SR';
  const m = raw.toUpperCase().match(/^([A-Z]+)/);
  if (!m) return null;
  const prefix = m[1];
  if (prefix === 'MPS') return 'MPS';
  if (prefix === 'APS') return 'APS';
  if (prefix === 'NPS') return 'NPS';
  if (prefix === 'PPS') return 'PPS';
  if (prefix === 'CPS') return 'CPS';
  if (prefix === 'SR') return 'SR';
  return prefix;
}

function newOrdersPsTypeLabel() {
  const panel = document.getElementById('no-ps-type-panel');
  if (!panel) return 'APS, NPS';
  const checked = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value);
  if (!checked.length) return 'None';
  if (checked.length >= 6) return 'All types';
  return checked.join(', ');
}

function newOrdersSearchText(row) {
  return [
    row.source_voucher_no,
    row.source_voucher_line_item_no,
    row.process_sheet_no,
    row.inventory_code,
    row.main_desc,
    row.line_item_description,
    row.customer_po_no,
    row.customer_po_line_item_no,
    row.customer_code,
    row.reference_no,
    row.status,
    row.invoice_no,
    row.shipment_voucher_no,
  ].join(' ').toLowerCase();
}

function newOrdersIsHistoryStatus(row) {
  return String(row?.status || '').trim().toLowerCase() === 'history';
}

function newOrdersFilteredRows() {
  const search = String(newOrdersState.search || '').trim().toLowerCase();
  const types = newOrdersState.psTypes;
  const allTypes = types.size >= 6;

  return (newOrdersState.rows || []).filter(row => {
    if (newOrdersState.hideHistory && newOrdersIsHistoryStatus(row)) return false;
    if (!allTypes) {
      const t = newOrdersGetPsType(row);
      if (t && !types.has(t)) return false;
    }
    if (search && !newOrdersSearchText(row).includes(search)) return false;
    return true;
  });
}

function newOrdersBuildGroups(rows) {
  const order = [];
  const map = new Map();

  (rows || []).forEach(row => {
    const key = String(row.source_voucher_no || '').trim() || '(no SO)';
    if (!map.has(key)) {
      const group = {
        sales_order_no: key,
        first_posted_datetime: row.first_posted_datetime,
        latest_posted_datetime: row.latest_posted_datetime,
        customer_po_no: row.customer_po_no,
        customer_code: row.customer_code,
        reference_no: row.reference_no,
        children: [],
      };
      map.set(key, group);
      order.push(group);
    }
    map.get(key).children.push(row);
  });

  return order;
}

function newOrdersRenderSideRail(group, rowSpan) {
  const collapsed = newOrdersState.collapsedGroups.has(group.sales_order_no);
  const chevron = collapsed ? '▸' : '▾';
  const lineCount = group.children.length;
  const lineLabel = lineCount === 1 ? '1 line' : `${lineCount} lines`;

  return `
    <td class="new-orders-side-rail" rowspan="${rowSpan}" data-sales-order="${escapeHtml(group.sales_order_no)}" title="Click for order detail">
      <div class="new-orders-side-rail-inner">
        <div class="new-orders-side-rail-top">
          <button type="button" class="new-orders-group-toggle" data-action="toggle-group" data-sales-order="${escapeHtml(group.sales_order_no)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} lines">${chevron}</button>
          <span class="new-orders-row-hint">Detail</span>
        </div>
        <div class="new-orders-side-posted-wrap">${newOrdersRenderPostedSideRail(group)}</div>
        <strong class="new-orders-side-so">${escapeHtml(group.sales_order_no)}</strong>
        <span class="new-orders-group-meta">${escapeHtml(lineLabel)}</span>
        <dl class="new-orders-side-facts">
          <div><dt>Customer PO</dt><dd>${escapeHtml(String(group.customer_po_no || '—'))}</dd></div>
          <div><dt>Customer</dt><dd>${escapeHtml(String(group.customer_code || '—'))}</dd></div>
          <div><dt>Ref no.</dt><dd>${escapeHtml(String(group.reference_no || '—'))}</dd></div>
        </dl>
      </div>
    </td>
  `;
}

function newOrdersRenderLineCells(row) {
  const desc = String(row.line_item_description || row.main_desc || '').trim();
  return `
    <td class="new-orders-num">${escapeHtml(String(row.source_voucher_line_item_no ?? '—'))}</td>
    <td>${escapeHtml(String(row.process_sheet_no || '—'))}</td>
    <td>${escapeHtml(String(row.inventory_code || '—'))}</td>
    <td class="new-orders-desc" title="${escapeHtml(desc)}">${escapeHtml(desc || '—')}</td>
    <td class="new-orders-date">${escapeHtml(newOrdersDateOnly(row.po_due_date) || '—')}</td>
    <td class="new-orders-num">${escapeHtml(String(row.qty ?? '—'))}</td>
    <td class="new-orders-num">${escapeHtml(String(row.qty_issued ?? '—'))}</td>
    <td>${escapeHtml(String(row.status || '—'))}</td>
    <td class="new-orders-date">${escapeHtml(newOrdersDateOnly(row.proposed_edd) || '—')}</td>
  `;
}

function newOrdersRenderChildRow(row, { includeSideRail, group, rowSpan, groupStart }) {
  const lineKey = newOrdersLineKey(row);
  const sideRail = includeSideRail ? newOrdersRenderSideRail(group, rowSpan) : '';
  const startClass = groupStart ? ' new-orders-group-start' : '';
  return `
    <tr class="new-orders-child-row is-clickable${startClass}" data-sales-order="${escapeHtml(String(row.source_voucher_no || ''))}" data-line-key="${escapeHtml(lineKey)}" title="Click for line detail">
      ${sideRail}
      ${newOrdersRenderLineCells(row)}
    </tr>
  `;
}

function newOrdersRenderGroup(group) {
  const children = group.children || [];
  const collapsed = newOrdersState.collapsedGroups.has(group.sales_order_no);
  if (!children.length) return '';

  if (collapsed) {
    const lineLabel = children.length === 1 ? '1 line hidden' : `${children.length} lines hidden`;
    return `
      <tr class="new-orders-group-row is-clickable" data-sales-order="${escapeHtml(group.sales_order_no)}" title="Click for order detail">
        ${newOrdersRenderSideRail(group, 1)}
        <td colspan="9" class="new-orders-collapsed-summary">${escapeHtml(lineLabel)} — expand to view</td>
      </tr>
    `;
  }

  return children.map((row, index) => newOrdersRenderChildRow(row, {
    includeSideRail: index === 0,
    group,
    rowSpan: children.length,
    groupStart: index === 0,
  })).join('');
}

function newOrdersRenderTable() {
  const filtered = newOrdersFilteredRows();
  const groups = newOrdersBuildGroups(filtered);
  const body = document.getElementById('new-orders-body');
  const wrap = document.getElementById('new-orders-table-wrap');
  const empty = document.getElementById('new-orders-empty');
  const stats = document.getElementById('new-orders-stats');
  const emptyText = document.getElementById('new-orders-empty-text');

  if (!body || !wrap || !empty) return;

  if (!filtered.length) {
    body.innerHTML = '';
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) {
      emptyText.textContent = newOrdersState.rows.length
        ? 'No rows match your filters.'
        : `No orders first posted ${newOrdersState.rangeLabel || 'for this range'}.`;
    }
  } else {
    empty.hidden = true;
    wrap.hidden = false;
    body.innerHTML = groups.map(group => newOrdersRenderGroup(group)).join('');
    newOrdersBindTableClicks();
  }

  if (stats) {
    const totalRows = newOrdersState.rows.length;
    const orderLabel = `${groups.length} order${groups.length === 1 ? '' : 's'}`;
    const lineLabel = `${filtered.length} line${filtered.length === 1 ? '' : 's'}`;
    if (filtered.length === totalRows) {
      stats.textContent = `${orderLabel} · ${lineLabel}`;
    } else {
      stats.textContent = `${orderLabel} · ${lineLabel} shown`;
    }
  }
}

function newOrdersUpdateMeta(payload) {
  const meta = document.getElementById('new-orders-meta');
  if (!meta || !payload) return;
  const from = payload.from || '';
  const to = payload.to || '';
  newOrdersState.rangeLabel = from && to ? `from ${from} to ${to}` : '';
  newOrdersState.cachedAt = payload.cached_at || '';
  newOrdersState.cacheTtlSec = Number(payload.cache_ttl_sec) || 300;
  const parts = [];
  if (from && to) parts.push(`Range: ${from} → ${to}`);
  if (payload.cached_at) {
    parts.push(`Live ERP · cached ${trialFormatDt(payload.cached_at)} (${newOrdersState.cacheTtlSec}s TTL)`);
  }
  meta.textContent = parts.join(' · ');
  meta.hidden = !parts.length;
}

function newOrdersSetLoading(loading) {
  const el = document.getElementById('new-orders-loading');
  if (el) el.hidden = !loading;
}

function newOrdersBuildUrl(refresh) {
  const params = new URLSearchParams();
  if (newOrdersState.week === 'custom') {
    if (newOrdersState.from) params.set('from', newOrdersState.from);
    if (newOrdersState.to) params.set('to', newOrdersState.to);
  } else {
    params.set('week', newOrdersState.week);
  }
  if (refresh) params.set('refresh', '1');
  return `/api/new-orders?${params.toString()}`;
}

async function newOrdersLoad(refresh) {
  newOrdersSetLoading(true);
  try {
    const res = await fetch(newOrdersBuildUrl(refresh));
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    newOrdersState.rows = Array.isArray(payload.rows) ? payload.rows : [];
    newOrdersUpdateMeta(payload);
    newOrdersRenderTable();
  } catch (err) {
    newOrdersState.rows = [];
    newOrdersRenderTable();
    const emptyText = document.getElementById('new-orders-empty-text');
    const empty = document.getElementById('new-orders-empty');
    const wrap = document.getElementById('new-orders-table-wrap');
    if (wrap) wrap.hidden = true;
    if (empty) empty.hidden = false;
    if (emptyText) emptyText.textContent = `Could not load orders: ${err.message || err}`;
  } finally {
    newOrdersSetLoading(false);
  }
}

function newOrdersSyncCustomVisibility() {
  const custom = newOrdersState.week === 'custom';
  const fromWrap = document.getElementById('new-orders-from-wrap');
  const toWrap = document.getElementById('new-orders-to-wrap');
  if (fromWrap) fromWrap.hidden = !custom;
  if (toWrap) toWrap.hidden = !custom;
}

function newOrdersBindPsTypeDropdown() {
  const dropdown = document.getElementById('no-ps-type-dropdown');
  const btn = document.getElementById('no-ps-type-btn');
  const panel = document.getElementById('no-ps-type-panel');
  if (!dropdown || !btn || !panel) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });

  document.addEventListener('click', () => {
    panel.hidden = true;
  });

  panel.addEventListener('click', (e) => e.stopPropagation());

  panel.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', () => {
      newOrdersState.psTypes = new Set(
        [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value)
      );
      btn.textContent = `${newOrdersPsTypeLabel()} ▾`;
      newOrdersRenderTable();
    });
  });

  btn.textContent = `${newOrdersPsTypeLabel()} ▾`;
}

function newOrdersInit() {
  const weekSel = document.getElementById('new-orders-week');
  const fromInput = document.getElementById('new-orders-from');
  const toInput = document.getElementById('new-orders-to');
  const searchInput = document.getElementById('new-orders-search');
  const refreshBtn = document.getElementById('new-orders-refresh');

  if (weekSel) {
    weekSel.addEventListener('change', () => {
      newOrdersState.week = weekSel.value || 'this_week';
      newOrdersSyncCustomVisibility();
      if (newOrdersState.week !== 'custom') newOrdersLoad(false);
    });
  }

  const onCustomChange = () => {
    if (fromInput) newOrdersState.from = fromInput.value || '';
    if (toInput) newOrdersState.to = toInput.value || '';
    if (newOrdersState.week === 'custom' && newOrdersState.from && newOrdersState.to) {
      newOrdersLoad(false);
    }
  };
  fromInput?.addEventListener('change', onCustomChange);
  toInput?.addEventListener('change', onCustomChange);

  searchInput?.addEventListener('input', () => {
    newOrdersState.search = searchInput.value || '';
    newOrdersRenderTable();
  });

  const hideHistoryInput = document.getElementById('new-orders-hide-history');
  hideHistoryInput?.addEventListener('change', () => {
    newOrdersState.hideHistory = Boolean(hideHistoryInput.checked);
    newOrdersRenderTable();
  });

  refreshBtn?.addEventListener('click', () => newOrdersLoad(true));

  newOrdersBindPsTypeDropdown();
  newOrdersBindDetailPanel();
  newOrdersSyncCustomVisibility();
  newOrdersLoad(false);
}

document.addEventListener('DOMContentLoaded', newOrdersInit);
