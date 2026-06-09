// Sales Orders — mfg_pp_vch → mfg_pp_partial_view, so_order_view header on sales_order_no.

const soState = {
  active: [],
  complete: [],
  view: 'active',
  search: '',
  cachedAt: '',
  cacheTtlSec: 300,
  ppCount: 0,
  partialCount: 0,
  missingHeaderCount: 0,
  collapsedGroups: new Set(),
  selectedKey: '',
};

function soPartialKey(order, pp, partial) {
  const so = String(order?.sales_order_no || '').trim();
  const ppNo = String(pp?.pp_voucher_no || '').trim();
  const partialNo = partial ? String(partial.pp_partial_no ?? '').trim() : '';
  return partial ? `${so}::${ppNo}::${partialNo}` : `${so}::${ppNo}`;
}

function soFormatDate(value) {
  if (!value) return '—';
  const text = String(value).trim();
  return text.length >= 10 ? text.slice(0, 10) : text || '—';
}

function soFormatDt(value) {
  return typeof trialFormatDt === 'function' ? trialFormatDt(value) : String(value || '—');
}

function soDetailField(label, value, { mono, fullWidth } = {}) {
  const text = value == null || value === '' ? '—' : String(value);
  const cls = mono ? ' new-orders-detail-value--mono' : '';
  const span = fullWidth ? ' style="grid-column:1/-1"' : '';
  return `
    <div class="new-orders-detail-field"${span}>
      <dt>${escapeHtml(label)}</dt>
      <dd class="new-orders-detail-value${cls}">${escapeHtml(text)}</dd>
    </div>
  `;
}

function soDetailSection(title, html) {
  if (!html) return '';
  return `
    <section class="new-orders-detail-section">
      <h3 class="new-orders-detail-section-title">${escapeHtml(title)}</h3>
      <dl class="new-orders-detail-grid">${html}</dl>
    </section>
  `;
}

function soRenderPartialDetail(order, pp, partial) {
  const partialHtml = [
    soDetailField('PP voucher', pp?.pp_voucher_no, { mono: true }),
    soDetailField('Partial no.', partial?.pp_partial_no),
    soDetailField('Part', partial?.inventory_code || pp?.inventory_code, { mono: true }),
    soDetailField('Customer', partial?.party_name),
    soDetailField('Customer code', partial?.customer_code, { mono: true }),
    soDetailField('Customer PO', partial?.customer_po_no, { mono: true }),
  ].join('');
  const ppHtml = [
    soDetailField('PP voucher', pp?.pp_voucher_no, { mono: true }),
    soDetailField('Part', pp?.inventory_code, { mono: true }),
    soDetailField('BOM', pp?.bom_code, { mono: true }),
    soDetailField('PP qty', pp?.pp_qty),
    soDetailField('SO line', pp?.source_line_item_no),
    soDetailField('PO due', soFormatDate(pp?.source_rsd)),
    soDetailField('Proposed EDD', soFormatDate(pp?.proposed_edd)),
    soDetailField('PP status', pp?.status),
    soDetailField('Segment', pp?.segment_1_code),
  ].join('');
  const orderHtml = [
    soDetailField('Sales order', order?.sales_order_no, { mono: true }),
    soDetailField('Customer', order?.customer_name || order?.customer_short_name),
    soDetailField('Customer PO', order?.customer_po_no, { mono: true }),
    soDetailField('Voucher status', order?.voucher_status, { mono: true }),
    soDetailField('Order date', soFormatDate(order?.order_date)),
  ].join('');
  return [
    soDetailSection('Partial', partialHtml),
    soDetailSection('PP voucher', ppHtml),
    soDetailSection('Sales order', orderHtml),
  ].join('');
}

function soRenderPpDetail(order, pp) {
  const ppHtml = [
    soDetailField('PP voucher', pp?.pp_voucher_no, { mono: true }),
    soDetailField('Part', pp?.inventory_code, { mono: true }),
    soDetailField('BOM', pp?.bom_code, { mono: true }),
    soDetailField('BOM desc', pp?.bom_desc, { fullWidth: true }),
    soDetailField('PP qty', pp?.pp_qty),
    soDetailField('SO line', pp?.source_line_item_no),
    soDetailField('PO due', soFormatDate(pp?.source_rsd)),
    soDetailField('Production due', soFormatDate(pp?.production_due_date)),
    soDetailField('Proposed EDD', soFormatDate(pp?.proposed_edd)),
    soDetailField('PP status', pp?.status),
    soDetailField('Segment', pp?.segment_1_code),
    soDetailField('Remarks', pp?.remarks, { fullWidth: true }),
  ].join('');
  const partials = Array.isArray(pp?.partials) ? pp.partials : [];
  const partialList = partials.map(partial => {
    const key = soPartialKey(order, pp, partial);
    return `
      <button type="button" class="new-orders-detail-line-pick" data-detail-key="${escapeHtml(key)}">
        <span class="new-orders-detail-line-pick-no">Partial ${escapeHtml(String(partial.pp_partial_no ?? '—'))}</span>
        <span class="new-orders-detail-line-pick-part">${escapeHtml(String(partial.inventory_code || '—'))}</span>
        <span class="new-orders-detail-line-pick-desc">${escapeHtml(String(partial.customer_po_no || partial.party_name || '—'))}</span>
      </button>
    `;
  }).join('');
  const orderHtml = [
    soDetailField('Sales order', order?.sales_order_no, { mono: true }),
    soDetailField('Customer', order?.customer_name || order?.customer_short_name),
    soDetailField('Customer PO', order?.customer_po_no, { mono: true }),
    soDetailField('Status', order?.status),
    soDetailField('Voucher status', order?.voucher_status, { mono: true }),
  ].join('');
  return `
    ${soDetailSection('PP voucher', ppHtml)}
    <section class="new-orders-detail-section">
      <h3 class="new-orders-detail-section-title">Partials — click for detail</h3>
      <div class="new-orders-detail-line-list">${partialList || '<p class="new-orders-muted">No partial rows for this PP voucher.</p>'}</div>
    </section>
    ${soDetailSection('Sales order', orderHtml)}
  `;
}

function soRenderOrderDetail(order) {
  const headerHtml = [
    soDetailField('Sales order', order.sales_order_no, { mono: true }),
    soDetailField('Order date', soFormatDate(order.order_date)),
    soDetailField('Status', order.status),
    soDetailField('Voucher status', order.voucher_status, { mono: true }),
    soDetailField('Customer', order.customer_name || order.customer_short_name),
    soDetailField('Customer code', order.customer_code, { mono: true }),
    soDetailField('Customer PO', order.customer_po_no, { mono: true }),
    soDetailField('Sales person', order.sales_person_name || order.sales_person_code),
    soDetailField('SBU', order.sbu_desc || order.sbu_code),
    soDetailField('Reference', order.reference_no, { mono: true }),
    soDetailField('After tax (home)', order.total_after_tax_home_amt),
    soDetailField('PP vouchers', order.pp_count),
    soDetailField('Partials', order.partial_count),
  ].join('');
  const ppList = (order.pp_vouchers || []).map(pp => {
    const key = soPartialKey(order, pp, null);
    return `
      <button type="button" class="new-orders-detail-line-pick" data-detail-key="${escapeHtml(key)}">
        <span class="new-orders-detail-line-pick-no">${escapeHtml(String(pp.pp_voucher_no || '—'))}</span>
        <span class="new-orders-detail-line-pick-part">${escapeHtml(String(pp.inventory_code || '—'))}</span>
        <span class="new-orders-detail-line-pick-desc">${escapeHtml(String(pp.partial_count || 0))} partial(s) · qty ${escapeHtml(String(pp.pp_qty ?? '—'))}</span>
      </button>
    `;
  }).join('');
  return `
    ${soDetailSection('Sales order', headerHtml)}
    <section class="new-orders-detail-section">
      <h3 class="new-orders-detail-section-title">PP vouchers — click for detail</h3>
      <div class="new-orders-detail-line-list">${ppList || '<p class="new-orders-muted">No PP vouchers linked.</p>'}</div>
    </section>
  `;
}

function soAllOrders() {
  return [...(soState.active || []), ...(soState.complete || [])];
}

function soFindOrder(soNo) {
  const target = String(soNo || '').trim();
  if (!target) return null;
  return soAllOrders().find(row => String(row.sales_order_no || '').trim() === target) || null;
}

function soFindByKey(key) {
  const target = String(key || '').trim();
  if (!target) return { order: null, pp: null, partial: null };
  const parts = target.split('::');
  const order = soFindOrder(parts[0]);
  if (!order) return { order: null, pp: null, partial: null };
  const pp = (order.pp_vouchers || []).find(row => String(row.pp_voucher_no || '').trim() === parts[1]) || null;
  if (!pp) return { order, pp: null, partial: null };
  if (parts.length < 3 || parts[2] === '') return { order, pp, partial: null };
  const partial = (pp.partials || []).find(row => String(row.pp_partial_no ?? '').trim() === parts[2]) || null;
  return { order, pp, partial };
}

function soOpenDetail({ title, bodyHtml }) {
  const shell = document.getElementById('so-detail');
  const titleEl = document.getElementById('so-detail-title');
  const bodyEl = document.getElementById('so-detail-body');
  if (!shell || !titleEl || !bodyEl) return;
  titleEl.textContent = title || 'Sales order';
  bodyEl.innerHTML = bodyHtml || '';
  shell.hidden = false;
  document.body.classList.add('new-orders-detail-open');
}

function soCloseDetail() {
  const shell = document.getElementById('so-detail');
  if (!shell) return;
  shell.hidden = true;
  document.body.classList.remove('new-orders-detail-open');
  soState.selectedKey = '';
}

function soOpenPartialDetail(order, pp, partial) {
  const key = soPartialKey(order, pp, partial);
  soState.selectedKey = key;
  soOpenDetail({
    title: `${pp.pp_voucher_no} · partial ${partial.pp_partial_no}`,
    bodyHtml: soRenderPartialDetail(order, pp, partial),
  });
}

function soOpenPpDetail(order, pp) {
  const key = soPartialKey(order, pp, null);
  soState.selectedKey = key;
  soOpenDetail({
    title: String(pp.pp_voucher_no || 'PP voucher'),
    bodyHtml: soRenderPpDetail(order, pp),
  });
}

function soOpenOrderDetail(order) {
  soState.selectedKey = String(order.sales_order_no || '');
  soOpenDetail({
    title: String(order.sales_order_no || 'Sales order'),
    bodyHtml: soRenderOrderDetail(order),
  });
}

function soBindDetailPanel() {
  const shell = document.getElementById('so-detail');
  const closeBtn = document.getElementById('so-detail-close');
  const bodyEl = document.getElementById('so-detail-body');
  if (!shell) return;
  shell.querySelector('[data-action="close-detail"]')?.addEventListener('click', soCloseDetail);
  closeBtn?.addEventListener('click', soCloseDetail);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !shell.hidden) soCloseDetail();
  });
  bodyEl?.addEventListener('click', e => {
    const btn = e.target.closest('[data-detail-key]');
    if (!btn) return;
    const { order, pp, partial } = soFindByKey(btn.getAttribute('data-detail-key'));
    if (order && pp && partial) soOpenPartialDetail(order, pp, partial);
    else if (order && pp) soOpenPpDetail(order, pp);
  });
}

function soBindTableClicks() {
  const wrap = document.getElementById('so-table-wrap');
  if (!wrap || wrap.dataset.detailBound === '1') return;
  wrap.dataset.detailBound = '1';

  wrap.addEventListener('click', e => {
    const toggle = e.target.closest('[data-action="toggle-group"]');
    if (toggle) {
      e.stopPropagation();
      const soNo = toggle.getAttribute('data-sales-order');
      if (!soNo) return;
      if (soState.collapsedGroups.has(soNo)) soState.collapsedGroups.delete(soNo);
      else soState.collapsedGroups.add(soNo);
      soRender();
      return;
    }

    const leaf = e.target.closest('tr[data-detail-key]');
    if (leaf) {
      const { order, pp, partial } = soFindByKey(leaf.dataset.detailKey);
      if (order && pp && partial) soOpenPartialDetail(order, pp, partial);
      else if (order && pp) soOpenPpDetail(order, pp);
      return;
    }

    const sideRail = e.target.closest('.new-orders-side-rail');
    if (sideRail) {
      const order = soFindOrder(sideRail.getAttribute('data-sales-order'));
      if (order) soOpenOrderDetail(order);
      return;
    }

    const group = e.target.closest('tr.new-orders-group-row[data-sales-order]');
    if (group) {
      const order = soFindOrder(group.getAttribute('data-sales-order'));
      if (order) soOpenOrderDetail(order);
    }
  });
}

function soActiveOrders() {
  return soState.view === 'complete' ? soState.complete : soState.active;
}

function soOrderSearchText(order) {
  const parts = [
    order.sales_order_no,
    order.status,
    order.voucher_status,
    order.customer_code,
    order.customer_name,
    order.customer_short_name,
    order.customer_po_no,
    order.reference_no,
    order.sales_person_name,
    order.sbu_code,
    order.sbu_desc,
  ];
  (order.pp_vouchers || []).forEach(pp => {
    parts.push(
      pp.pp_voucher_no,
      pp.inventory_code,
      pp.bom_code,
      pp.status,
      pp.source_line_item_no,
      pp.segment_1_code,
    );
    (pp.partials || []).forEach(partial => {
      parts.push(
        partial.pp_partial_no,
        partial.inventory_code,
        partial.party_name,
        partial.customer_po_no,
        partial.customer_code,
      );
    });
  });
  return parts.map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
}

function soFilterOrders(orders) {
  const q = String(soState.search || '').trim().toLowerCase();
  if (!q) return orders || [];
  return (orders || []).filter(order => soOrderSearchText(order).includes(q));
}

function soLeafRows(order) {
  const leaves = [];
  (order.pp_vouchers || []).forEach(pp => {
    const partials = pp.partials || [];
    if (!partials.length) {
      leaves.push({ order, pp, partial: null });
      return;
    }
    partials.forEach(partial => leaves.push({ order, pp, partial }));
  });
  return leaves;
}

function soRenderSideRail(order, rowSpan) {
  const soNo = String(order.sales_order_no || '').trim();
  const collapsed = soState.collapsedGroups.has(soNo);
  const chevron = collapsed ? '▸' : '▾';
  const ppCount = order.pp_count || (order.pp_vouchers || []).length;
  const partialCount = order.partial_count || 0;
  const customer = order.customer_name || order.customer_short_name || order.customer_code
    || (order.has_header === false ? '(no so_order_view header)' : '—');

  return `
    <td class="new-orders-side-rail" rowspan="${rowSpan}" data-sales-order="${escapeHtml(soNo)}" title="Click for order detail">
      <div class="new-orders-side-rail-inner">
        <div class="new-orders-side-rail-top">
          <button type="button" class="new-orders-group-toggle" data-action="toggle-group" data-sales-order="${escapeHtml(soNo)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} PP vouchers">${chevron}</button>
          <span class="new-orders-row-hint">Detail</span>
        </div>
        <div class="new-orders-side-posted"><span class="new-orders-side-posted-label">Order date</span> ${escapeHtml(soFormatDate(order.order_date))}</div>
        <strong class="new-orders-side-so">${escapeHtml(soNo || '—')}</strong>
        <span class="new-orders-group-meta">${escapeHtml(String(ppCount))} PP · ${escapeHtml(String(partialCount))} partial(s) · ${escapeHtml(String(order.voucher_status || '—'))}</span>
        <dl class="new-orders-side-facts">
          <div><dt>Customer</dt><dd title="${escapeHtml(customer)}">${escapeHtml(customer)}</dd></div>
          <div><dt>Customer PO</dt><dd>${escapeHtml(String(order.customer_po_no || '—'))}</dd></div>
          <div><dt>Status</dt><dd>${escapeHtml(String(order.status || '—'))}</dd></div>
        </dl>
      </div>
    </td>
  `;
}

function soRenderLeafCells(pp, partial) {
  const part = partial?.inventory_code || pp?.inventory_code || '—';
  return `
    <td class="new-orders-num">${escapeHtml(partial ? String(partial.pp_partial_no ?? '—') : '—')}</td>
    <td class="new-orders-num">${escapeHtml(String(part))}</td>
    <td>${escapeHtml(String(pp?.bom_code || '—'))}</td>
    <td class="new-orders-num">${escapeHtml(String(pp?.pp_qty ?? '—'))}</td>
    <td class="new-orders-num">${escapeHtml(String(pp?.source_line_item_no ?? '—'))}</td>
    <td class="new-orders-date">${escapeHtml(soFormatDate(pp?.source_rsd))}</td>
    <td class="new-orders-date">${escapeHtml(soFormatDate(pp?.proposed_edd))}</td>
    <td>${escapeHtml(String(pp?.status || '—'))}</td>
  `;
}

function soRenderLeafRow(leaf, { includeSideRail, sideRowSpan, groupStart, includePpCell, ppRowSpan, ppStart }) {
  const { order, pp, partial } = leaf;
  const key = soPartialKey(order, pp, partial);
  const selected = key === soState.selectedKey;
  const sideRail = includeSideRail ? soRenderSideRail(order, sideRowSpan) : '';
  const ppCell = includePpCell
    ? `<td class="mi-cell--mono" rowspan="${ppRowSpan}">${escapeHtml(String(pp.pp_voucher_no || '—'))}</td>`
    : '';
  const startClass = groupStart ? ' new-orders-group-start' : '';
  const ppStartClass = ppStart ? ' so-pp-group-start' : '';
  return `
    <tr class="new-orders-child-row is-clickable${startClass}${ppStartClass}${selected ? ' is-selected' : ''}" data-sales-order="${escapeHtml(String(order.sales_order_no || ''))}" data-detail-key="${escapeHtml(key)}" title="Click for detail">
      ${sideRail}
      ${ppCell}
      ${soRenderLeafCells(pp, partial)}
    </tr>
  `;
}

function soRenderOrderGroup(order) {
  const soNo = String(order.sales_order_no || '').trim();
  const collapsed = soState.collapsedGroups.has(soNo);
  const leaves = soLeafRows(order);

  if (!leaves.length) {
    return `
      <tr class="new-orders-group-row is-clickable" data-sales-order="${escapeHtml(soNo)}" title="Click for order detail">
        ${soRenderSideRail(order, 1)}
        <td colspan="9" class="new-orders-collapsed-summary new-orders-muted">No PP vouchers for this sales order</td>
      </tr>
    `;
  }

  if (collapsed) {
    const label = `${leaves.length} row(s) hidden`;
    return `
      <tr class="new-orders-group-row is-clickable" data-sales-order="${escapeHtml(soNo)}" title="Click for order detail">
        ${soRenderSideRail(order, 1)}
        <td colspan="9" class="new-orders-collapsed-summary">${escapeHtml(label)} — expand to view</td>
      </tr>
    `;
  }

  const html = [];
  let leafIndex = 0;
  const ppGroups = new Map();
  leaves.forEach(leaf => {
    const ppNo = String(leaf.pp.pp_voucher_no || '');
    if (!ppGroups.has(ppNo)) ppGroups.set(ppNo, []);
    ppGroups.get(ppNo).push(leaf);
  });

  let firstOrderRow = true;
  for (const groupLeaves of ppGroups.values()) {
    let firstPpRow = true;
    groupLeaves.forEach(leaf => {
      html.push(soRenderLeafRow(leaf, {
        includeSideRail: firstOrderRow && leafIndex === 0,
        sideRowSpan: leaves.length,
        groupStart: firstOrderRow && leafIndex === 0,
        includePpCell: firstPpRow,
        ppRowSpan: groupLeaves.length,
        ppStart: firstPpRow,
      }));
      firstPpRow = false;
      leafIndex += 1;
      firstOrderRow = false;
    });
  }
  return html.join('');
}

function soUpdateTabCounts() {
  const activeEl = document.getElementById('so-active-tab-count');
  const completeEl = document.getElementById('so-complete-tab-count');
  if (activeEl) {
    activeEl.textContent = String(soState.active.length);
    activeEl.hidden = soState.active.length === 0;
  }
  if (completeEl) {
    completeEl.textContent = String(soState.complete.length);
    completeEl.hidden = soState.complete.length === 0;
  }
}

function soSetView(view) {
  const next = view === 'complete' ? 'complete' : 'active';
  soState.view = next;
  soCloseDetail();
  document.querySelectorAll('[data-so-view]').forEach(btn => {
    const active = btn.getAttribute('data-so-view') === next;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  soRender();
}

function soUpdateStats() {
  const stats = document.getElementById('so-stats');
  if (!stats) return;
  const orders = soFilterOrders(soActiveOrders());
  const ppRows = orders.reduce((sum, order) => sum + (order.pp_count || 0), 0);
  const partialRows = orders.reduce((sum, order) => sum + (order.partial_count || 0), 0);
  const activeN = soFilterOrders(soState.active).length;
  const completeN = soFilterOrders(soState.complete).length;
  const label = soState.view === 'complete' ? 'Complete' : 'Active';
  stats.textContent = `${label}: ${orders.length} SO · ${ppRows} PP · ${partialRows} partials · Active: ${activeN} · Complete: ${completeN}`;
}

function soRender() {
  const orders = soFilterOrders(soActiveOrders());
  const body = document.getElementById('so-table-body');
  const wrap = document.getElementById('so-table-wrap');
  const empty = document.getElementById('so-empty');
  const emptyText = document.getElementById('so-empty-text');
  const loading = document.getElementById('so-loading');
  const meta = document.getElementById('so-meta');

  if (loading) loading.hidden = true;

  const hasData = (soState.active?.length || 0) + (soState.complete?.length || 0) > 0;

  if (!orders.length) {
    if (body) body.innerHTML = '';
    if (wrap) wrap.hidden = true;
    if (empty) {
      empty.hidden = false;
      if (emptyText) {
        emptyText.textContent = hasData
          ? 'No sales orders match your search in this view.'
          : `No ${soState.view === 'complete' ? 'complete' : 'active'} sales orders in ERP.`;
      }
    }
    if (meta) meta.hidden = !hasData;
    soUpdateStats();
    soUpdateTabCounts();
    return;
  }

  if (wrap) wrap.hidden = false;
  if (empty) empty.hidden = true;
  if (body) body.innerHTML = orders.map(soRenderOrderGroup).join('');
  if (meta) {
    meta.hidden = false;
    const missing = Number(soState.missingHeaderCount) || 0;
    const missingNote = missing > 0 ? ` · ${missing} without so_order_view header` : '';
    meta.textContent = `Click a row for detail · ${soState.ppCount || 0} PP vouchers · ${soState.partialCount || 0} partials · cached ${soState.cachedAt || '—'} · TTL ${soState.cacheTtlSec}s${missingNote}`;
  }

  soUpdateStats();
  soUpdateTabCounts();
}

async function soLoad({ refresh = false, bustCache = false } = {}) {
  const loading = document.getElementById('so-loading');
  const wrap = document.getElementById('so-table-wrap');
  if (loading) loading.hidden = false;
  if (wrap) wrap.hidden = true;
  soCloseDetail();

  const params = new URLSearchParams();
  if (refresh) params.set('refresh', '1');
  if (bustCache) params.set('_ts', String(Date.now()));

  let payload;
  try {
    const res = await fetch(`/api/sales-orders?${params}`);
    payload = await res.json();
    if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  } catch (err) {
    if (loading) loading.hidden = true;
    const empty = document.getElementById('so-empty');
    const emptyText = document.getElementById('so-empty-text');
    if (empty) empty.hidden = false;
    if (emptyText) emptyText.textContent = `Failed to load: ${err.message}`;
    return;
  }

  soState.active = Array.isArray(payload.active) ? payload.active : [];
  soState.complete = Array.isArray(payload.complete) ? payload.complete : [];
  soState.cachedAt = payload.cached_at || '';
  soState.cacheTtlSec = Number(payload.cache_ttl_sec) || 300;
  soState.ppCount = Number(payload.pp_count) || 0;
  soState.partialCount = Number(payload.partial_count) || 0;
  soState.missingHeaderCount = Number(payload.missing_header_count) || 0;
  soState.schemaVersion = Number(payload.schema_version) || 0;
  soState.apiSource = String(payload.source || '');

  const orderTotal = soState.active.length + soState.complete.length;
  const nestedPp = soState.active.concat(soState.complete)
    .reduce((sum, order) => sum + (Array.isArray(order.pp_vouchers) ? order.pp_vouchers.length : 0), 0);
  if (orderTotal > 0 && (soState.ppCount === 0 || nestedPp === 0)) {
    const empty = document.getElementById('so-empty');
    const emptyText = document.getElementById('so-empty-text');
    if (empty) empty.hidden = false;
    if (emptyText) {
      emptyText.textContent = 'Sales orders loaded but PP voucher data is missing — restart Flask, click Refresh, then hard-reload the page (Ctrl+Shift+R).';
    }
    if (loading) loading.hidden = true;
    return;
  }

  soRender();
}

function soInit() {
  document.querySelectorAll('[data-so-view]').forEach(btn => {
    btn.addEventListener('click', () => soSetView(btn.getAttribute('data-so-view')));
  });

  const search = document.getElementById('so-search');
  search?.addEventListener('input', () => {
    soState.search = search.value || '';
    soRender();
  });

  document.getElementById('so-refresh')?.addEventListener('click', () => soLoad({ refresh: true, bustCache: true }));
  soBindDetailPanel();
  soBindTableClicks();
  soLoad({ refresh: false });
}

document.addEventListener('DOMContentLoaded', soInit);
