// Sales Orders — mfg_pp_vch → mfg_pp_partial_view, so_order_view header on sales_order_no.

const SO_NOTE_FIELDS = [
  'material_subcon',
  'mtl_part_order',
  'quality_doc',
  'ops_notes',
  'sales_notes',
];

const SO_NOTE_LABELS = {
  material_subcon: 'Material/Sub-con',
  mtl_part_order: 'Mtl / Part Order',
  quality_doc: 'Quality Doc',
  ops_notes: 'Ops',
  sales_notes: 'Sales',
};

const SO_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];

const SO_COLUMNS = [
  { id: '_so', label: 'SO', side: true, sortable: true, filterable: true },
  { id: 'pp_voucher_no', label: 'PP voucher', sortable: true, filterable: true, filterType: 'prefix' },
  { id: 'partial', label: 'Partial', sortable: true, filterable: true },
  { id: 'process_sheet_no', label: 'Process sheet', sortable: true, filterable: true },
  { id: 'order_date', label: 'Date', sortable: true, filterable: true },
  { id: 'part', label: 'Part', sortable: true, filterable: true },
  { id: 'description', label: 'Description', sortable: true, filterable: true },
  { id: 'customer_po_no', label: 'P/O No.', sortable: true, filterable: true },
  { id: 'due_date', label: 'Due date', sortable: true, filterable: true },
  { id: 'delivery_date', label: 'Del. date', sortable: true, filterable: true },
  { id: 'unit_selling_price', label: 'U/Price', sortable: true, filterable: true },
  { id: 'amount', label: 'Amount', sortable: true, filterable: true },
  { id: 'qty', label: 'Qty', sortable: true, filterable: true },
  { id: 'material_subcon', label: 'Material/Sub-con', sortable: true, filterable: true },
  { id: 'mtl_part_order', label: 'Mtl / Part Order', sortable: true, filterable: true },
  { id: 'quality_doc', label: 'Quality Doc', sortable: true, filterable: true },
  { id: 'ops_notes', label: 'Ops', sortable: true, filterable: true },
  { id: 'sales_notes', label: 'Sales', sortable: true, filterable: true },
];

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
  saveTimers: new Map(),
  ppTypes: new Set(['APS', 'NPS']),
  sortCol: '',
  sortDir: 'asc',
  colFilters: {},
  openFilterCol: '',
};

function soPartialKey(order, pp, partial) {
  const so = String(order?.sales_order_no || '').trim();
  const ppNo = String(pp?.pp_voucher_no || '').trim();
  const partialNo = partial ? String(partial.pp_partial_no ?? '').trim() : '';
  return partial ? `${so}::${ppNo}::${partialNo}` : `${so}::${ppNo}`;
}

async function soPostJson(url, body) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function soFormatDate(value) {
  if (!value) return '—';
  const text = String(value).trim();
  return text.length >= 10 ? text.slice(0, 10) : text || '—';
}

function soFormatMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function soFormatDt(value) {
  return typeof trialFormatDt === 'function' ? trialFormatDt(value) : String(value || '—');
}

function soIsReposted(order) {
  const first = String(order?.first_posted_datetime || '').trim();
  const latest = String(order?.latest_posted_datetime || '').trim();
  return Boolean(first && latest && first !== latest);
}

function soPostedDetailFields(order) {
  const fields = [
    soDetailField('First posted', soFormatDt(order?.first_posted_datetime)),
  ];
  if (soIsReposted(order)) {
    fields.push(soDetailField('Latest post', soFormatDt(order?.latest_posted_datetime)));
  }
  return fields.join('');
}

function soRenderPostedSideRail(order) {
  const first = soFormatDt(order?.first_posted_datetime);
  const reposted = soIsReposted(order);
  const latestBlock = reposted
    ? `<div class="new-orders-side-reposted"><span class="new-orders-side-posted-label">Latest post</span> ${escapeHtml(soFormatDt(order.latest_posted_datetime))}</div>`
    : '';
  return `
    <div class="new-orders-side-posted"><span class="new-orders-side-posted-label">First posted</span> ${escapeHtml(first)}</div>
    ${latestBlock}
  `;
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
    soDetailField('Process sheet', pp?.process_sheet_no, { mono: true }),
    soDetailField('Part', pp?.inventory_code, { mono: true }),
    soDetailField('Description', pp?.description),
    soDetailField('P/O No.', pp?.customer_po_no, { mono: true }),
    soDetailField('PP qty', pp?.pp_qty),
    soDetailField('SO line', pp?.source_line_item_no),
    soDetailField('Due date', soFormatDate(pp?.due_date)),
    soDetailField('Del. date', soFormatDate(pp?.delivery_date)),
    soDetailField('U/Price', soFormatMoney(pp?.unit_selling_price)),
    soDetailField('Amount', soFormatMoney(pp?.amount)),
    soDetailField('PP status', pp?.status),
    ...SO_NOTE_FIELDS.map(field => soDetailField(SO_NOTE_LABELS[field], pp?.[field])),
  ].join('');
  const orderHtml = [
    soDetailField('Sales order', order?.sales_order_no, { mono: true }),
    soDetailField('Customer', order?.customer_name || order?.customer_short_name),
    soDetailField('Customer PO', order?.customer_po_no, { mono: true }),
    soDetailField('Voucher status', order?.voucher_status, { mono: true }),
    soDetailField('Order date', soFormatDate(order?.order_date)),
    soPostedDetailFields(order),
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
    soDetailField('Process sheet', pp?.process_sheet_no, { mono: true }),
    soDetailField('Part', pp?.inventory_code, { mono: true }),
    soDetailField('BOM', pp?.bom_code, { mono: true }),
    soDetailField('Description', pp?.description, { fullWidth: true }),
    soDetailField('P/O No.', pp?.customer_po_no, { mono: true }),
    soDetailField('PP qty', pp?.pp_qty),
    soDetailField('SO line', pp?.source_line_item_no),
    soDetailField('Due date', soFormatDate(pp?.due_date)),
    soDetailField('Del. date', soFormatDate(pp?.delivery_date)),
    soDetailField('U/Price', soFormatMoney(pp?.unit_selling_price)),
    soDetailField('Amount', soFormatMoney(pp?.amount)),
    soDetailField('PP status', pp?.status),
    ...SO_NOTE_FIELDS.map(field => soDetailField(SO_NOTE_LABELS[field], pp?.[field])),
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
    soPostedDetailFields(order),
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

function soFindPp(ppVoucherNo) {
  const target = String(ppVoucherNo || '').trim();
  for (const order of soAllOrders()) {
    const pp = (order.pp_vouchers || []).find(row => String(row.pp_voucher_no || '').trim() === target);
    if (pp) return { order, pp };
  }
  return { order: null, pp: null };
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
    if (e.target.closest('.so-editable-input, .so-editable-cell')) return;

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
      pp.process_sheet_no,
      pp.inventory_code,
      pp.bom_code,
      pp.description,
      pp.customer_po_no,
      pp.status,
      pp.source_line_item_no,
      pp.segment_1_code,
      ...SO_NOTE_FIELDS.map(field => pp[field]),
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

function soGetPsType(pp) {
  const raw = String(pp?.process_sheet_no || pp?.pp_voucher_no || '').split('::')[0];
  if (/\[sr\]/i.test(raw)) return 'SR';
  const match = raw.toUpperCase().match(/^([A-Z]+)/);
  if (!match) return null;
  const prefix = match[1];
  return SO_PS_TYPES.includes(prefix) ? prefix : prefix;
}

function soPpTypesAllSelected() {
  return soState.ppTypes.size >= SO_PS_TYPES.length;
}

function soPsTypeLabel() {
  const panel = document.getElementById('so-ps-type-panel');
  if (!panel) return 'APS, NPS';
  const checked = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value);
  if (!checked.length) return 'None';
  if (checked.length >= SO_PS_TYPES.length) return 'All types';
  return checked.map(v => (v === 'SR' ? '[SR]' : v)).join(', ');
}

function soSyncPsTypeCheckboxes() {
  const panel = document.getElementById('so-ps-type-panel');
  if (!panel) return;
  panel.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.checked = soState.ppTypes.has(input.value);
  });
  const btn = document.getElementById('so-ps-type-btn');
  if (btn) btn.textContent = `${soPsTypeLabel()} ▾`;
}

function soLeafColumnValue(leaf, colId) {
  const { order, pp, partial } = leaf;
  switch (colId) {
    case '_so': return order?.sales_order_no;
    case 'pp_voucher_no': return pp?.pp_voucher_no;
    case 'partial': return partial?.pp_partial_no ?? '';
    case 'process_sheet_no': return pp?.process_sheet_no;
    case 'order_date': return pp?.order_date;
    case 'part': return partial?.inventory_code || pp?.inventory_code;
    case 'description': return pp?.description;
    case 'customer_po_no': return pp?.customer_po_no;
    case 'due_date': return pp?.due_date;
    case 'delivery_date': return pp?.delivery_date;
    case 'unit_selling_price': return pp?.unit_selling_price;
    case 'amount': return pp?.amount;
    case 'qty': return pp?.pp_qty;
    default:
      if (SO_NOTE_FIELDS.includes(colId)) return pp?.[colId];
      return '';
  }
}

function soCompareValues(a, b, dir) {
  const desc = dir === 'desc';
  const aEmpty = a == null || a === '';
  const bEmpty = b == null || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) {
    return desc ? bn - an : an - bn;
  }
  const cmp = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return desc ? -cmp : cmp;
}

function soLeafPassesPrefixFilter(pp) {
  if (soPpTypesAllSelected()) return true;
  if (!soState.ppTypes.size) return false;
  const psType = soGetPsType(pp);
  if (!psType) return true;
  return soState.ppTypes.has(psType);
}

function soLeafPassesColumnFilters(leaf) {
  for (const [colId, text] of Object.entries(soState.colFilters)) {
    const q = String(text || '').trim().toLowerCase();
    if (!q) continue;
    const val = String(soLeafColumnValue(leaf, colId) ?? '').toLowerCase();
    if (!val.includes(q)) return false;
  }
  return true;
}

function soLeafPassesFilters(leaf) {
  if (!soLeafPassesPrefixFilter(leaf.pp)) return false;
  return soLeafPassesColumnFilters(leaf);
}

function soVisibleLeaves(order) {
  let leaves = soLeafRows(order).filter(soLeafPassesFilters);
  if (soState.sortCol) {
    leaves = [...leaves].sort((a, b) => soCompareValues(
      soLeafColumnValue(a, soState.sortCol),
      soLeafColumnValue(b, soState.sortCol),
      soState.sortDir,
    ));
  }
  return leaves;
}

function soVisibleOrders(orders) {
  let list = soFilterOrders(orders).filter(order => soVisibleLeaves(order).length > 0);
  if (soState.sortCol) {
    list = [...list].sort((a, b) => {
      const av = soState.sortCol === '_so'
        ? a.sales_order_no
        : soLeafColumnValue(soVisibleLeaves(a)[0], soState.sortCol);
      const bv = soState.sortCol === '_so'
        ? b.sales_order_no
        : soLeafColumnValue(soVisibleLeaves(b)[0], soState.sortCol);
      return soCompareValues(av, bv, soState.sortDir);
    });
  }
  return list;
}

function soColumnFilterActive(colId) {
  if (colId === 'pp_voucher_no' && !soPpTypesAllSelected()) return true;
  return Boolean(String(soState.colFilters[colId] || '').trim());
}

function soSortIcon(colId) {
  if (soState.sortCol !== colId) return '↕';
  return soState.sortDir === 'desc' ? '↓' : '↑';
}

function soRenderTableHead() {
  const row = document.getElementById('so-table-head-row');
  if (!row) return;
  row.innerHTML = SO_COLUMNS.map(col => {
    const sideCls = col.side ? ' new-orders-side-head' : '';
    const activeFilter = soColumnFilterActive(col.id);
    const filterCls = activeFilter ? ' is-active' : '';
    const sortCls = soState.sortCol === col.id ? ' is-sorted' : '';
    if (!col.sortable && !col.filterable) {
      return `<th class="${sideCls.trim()}">${escapeHtml(col.label)}</th>`;
    }
    return `
      <th class="so-col-head${sideCls}${sortCls}" data-so-col="${escapeHtml(col.id)}">
        <div class="so-col-head-inner">
          <button type="button" class="so-col-sort-btn" data-action="sort-col" data-so-col="${escapeHtml(col.id)}" title="Sort">
            <span class="so-col-label">${escapeHtml(col.label)}</span>
            <span class="so-col-sort-icon">${soSortIcon(col.id)}</span>
          </button>
          ${col.filterable ? `<button type="button" class="so-col-filter-btn${filterCls}" data-action="filter-col" data-so-col="${escapeHtml(col.id)}" title="Filter">▾</button>` : ''}
        </div>
      </th>
    `;
  }).join('');
}

function soCloseColumnFilter() {
  const pop = document.getElementById('so-col-filter-popover');
  if (pop) pop.hidden = true;
  soState.openFilterCol = '';
}

function soRenderPrefixFilterPanel(colId) {
  const checks = SO_PS_TYPES.map(type => {
    const label = type === 'SR' ? '[SR]' : type;
    const checked = soState.ppTypes.has(type) ? ' checked' : '';
    return `<label class="so-col-filter-check"><input type="checkbox" data-so-prefix="${escapeHtml(type)}"${checked} /> ${escapeHtml(label)}</label>`;
  }).join('');
  const textVal = escapeHtml(soState.colFilters[colId] || '');
  return `
    <div class="so-col-filter-title">PP voucher prefix</div>
    <div class="so-col-filter-checks">${checks}</div>
    <label class="so-col-filter-text-label">Contains</label>
    <input type="search" class="so-col-filter-input" data-so-filter-input="${escapeHtml(colId)}" value="${textVal}" placeholder="e.g. NPS25-0274" autocomplete="off" />
    <div class="so-col-filter-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-action="clear-col-filter" data-so-col="${escapeHtml(colId)}">Clear</button>
    </div>
  `;
}

function soRenderTextFilterPanel(colId, label) {
  const textVal = escapeHtml(soState.colFilters[colId] || '');
  return `
    <div class="so-col-filter-title">Filter: ${escapeHtml(label)}</div>
    <input type="search" class="so-col-filter-input" data-so-filter-input="${escapeHtml(colId)}" value="${textVal}" placeholder="Contains…" autocomplete="off" />
    <div class="so-col-filter-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-action="clear-col-filter" data-so-col="${escapeHtml(colId)}">Clear</button>
    </div>
  `;
}

function soOpenColumnFilter(btn, colId) {
  const pop = document.getElementById('so-col-filter-popover');
  const col = SO_COLUMNS.find(c => c.id === colId);
  if (!pop || !col) return;

  if (soState.openFilterCol === colId && !pop.hidden) {
    soCloseColumnFilter();
    return;
  }

  soState.openFilterCol = colId;
  pop.innerHTML = col.filterType === 'prefix'
    ? soRenderPrefixFilterPanel(colId)
    : soRenderTextFilterPanel(colId, col.label);

  const rect = btn.getBoundingClientRect();
  const wrap = document.getElementById('so-table-wrap');
  const wrapRect = wrap?.getBoundingClientRect();
  if (wrapRect) {
    pop.style.left = `${Math.max(8, rect.left - wrapRect.left)}px`;
    pop.style.top = `${rect.bottom - wrapRect.top + 4}px`;
  }
  pop.hidden = false;
}

function soApplyPrefixFilterFromPanel(panel) {
  const next = new Set();
  panel.querySelectorAll('input[data-so-prefix]').forEach(input => {
    if (input.checked) next.add(input.getAttribute('data-so-prefix'));
  });
  soState.ppTypes = next;
  soSyncPsTypeCheckboxes();
}

function soBindColumnControls() {
  const wrap = document.getElementById('so-table-wrap');
  if (!wrap || wrap.dataset.colControlsBound === '1') return;
  wrap.dataset.colControlsBound = '1';

  wrap.addEventListener('click', e => {
    const sortBtn = e.target.closest('[data-action="sort-col"]');
    if (sortBtn) {
      e.stopPropagation();
      const colId = sortBtn.getAttribute('data-so-col');
      if (!colId) return;
      if (soState.sortCol === colId) {
        soState.sortDir = soState.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        soState.sortCol = colId;
        soState.sortDir = 'asc';
      }
      soCloseColumnFilter();
      soRender();
      return;
    }

    const filterBtn = e.target.closest('[data-action="filter-col"]');
    if (filterBtn) {
      e.stopPropagation();
      soOpenColumnFilter(filterBtn, filterBtn.getAttribute('data-so-col'));
      return;
    }
  });

  document.addEventListener('click', e => {
    const pop = document.getElementById('so-col-filter-popover');
    if (!pop || pop.hidden) return;
    if (pop.contains(e.target) || e.target.closest('[data-action="filter-col"]')) return;
    soCloseColumnFilter();
  });

  const pop = document.getElementById('so-col-filter-popover');
  pop?.addEventListener('click', e => {
    const clearBtn = e.target.closest('[data-action="clear-col-filter"]');
    if (clearBtn) {
      const colId = clearBtn.getAttribute('data-so-col');
      if (colId === 'pp_voucher_no') {
        soState.ppTypes = new Set(['APS', 'NPS']);
        soSyncPsTypeCheckboxes();
      }
      delete soState.colFilters[colId];
      soCloseColumnFilter();
      soRender();
      return;
    }
    e.stopPropagation();
  });

  pop?.addEventListener('input', e => {
    const prefixInput = e.target.closest('input[data-so-prefix]');
    if (prefixInput) {
      soApplyPrefixFilterFromPanel(pop);
      soRender();
      return;
    }
    const textInput = e.target.closest('[data-so-filter-input]');
    if (textInput) {
      const colId = textInput.getAttribute('data-so-filter-input');
      if (!colId) return;
      soState.colFilters[colId] = textInput.value || '';
      soRender();
    }
  });
}

function soBindPsTypeDropdown() {
  const dropdown = document.getElementById('so-ps-type-dropdown');
  const btn = document.getElementById('so-ps-type-btn');
  const panel = document.getElementById('so-ps-type-panel');
  if (!dropdown || !btn || !panel) return;

  soSyncPsTypeCheckboxes();

  btn.addEventListener('click', e => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });

  document.addEventListener('click', () => {
    panel.hidden = true;
  });

  panel.addEventListener('click', e => e.stopPropagation());

  panel.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', () => {
      soState.ppTypes = new Set(
        [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value),
      );
      btn.textContent = `${soPsTypeLabel()} ▾`;
      soRender();
    });
  });
}

function soRenderSideRail(order, rowSpan) {
  const soNo = String(order.sales_order_no || '').trim();
  const collapsed = soState.collapsedGroups.has(soNo);
  const chevron = collapsed ? '▸' : '▾';
  const ppCount = order.pp_count || (order.pp_vouchers || []).length;
  const partialCount = order.partial_count || 0;
  const customer = order.customer_name || order.customer_short_name || order.customer_code
    || (order.has_header === false ? '(no so_order_view header)' : '—');
  const railTitle = [
    soNo,
    customer,
    `PO ${order.customer_po_no || '—'}`,
    order.status || '—',
    `Posted ${soFormatDt(order.first_posted_datetime)}`,
    `${ppCount} PP · ${partialCount} partial(s)`,
    'Click for detail',
  ].join(' · ');

  const posted = soFormatDt(order.first_posted_datetime);
  const postedShort = posted.length >= 10 ? posted.slice(0, 10) : posted;

  return `
    <td class="new-orders-side-rail new-orders-side-rail--compact" rowspan="${rowSpan}" data-sales-order="${escapeHtml(soNo)}" title="${escapeHtml(railTitle)}">
      <div class="new-orders-side-rail-inner">
        <div class="new-orders-side-rail-top">
          <button type="button" class="new-orders-group-toggle" data-action="toggle-group" data-sales-order="${escapeHtml(soNo)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} PP vouchers">${chevron}</button>
        </div>
        <strong class="new-orders-side-so">${escapeHtml(soNo || '—')}</strong>
        <span class="new-orders-side-posted-compact" title="${escapeHtml(posted)}">${escapeHtml(postedShort)}</span>
        <span class="new-orders-side-customer-compact" title="${escapeHtml(customer)}">${escapeHtml(customer)}</span>
      </div>
    </td>
  `;
}

function soRenderPpVoucherCell(pp, rowSpan) {
  return `<td class="mi-cell--mono" rowspan="${rowSpan}">${escapeHtml(String(pp.pp_voucher_no || '—'))}</td>`;
}

function soRenderPpSpanCells(pp, rowSpan) {
  return `
    <td rowspan="${rowSpan}">${escapeHtml(String(pp.process_sheet_no || '—'))}</td>
    <td class="new-orders-date" rowspan="${rowSpan}">${escapeHtml(soFormatDate(pp.order_date))}</td>
    <td class="new-orders-desc" rowspan="${rowSpan}" title="${escapeHtml(String(pp.description || ''))}">${escapeHtml(String(pp.description || '—'))}</td>
    <td class="new-orders-mono" rowspan="${rowSpan}">${escapeHtml(String(pp.customer_po_no || '—'))}</td>
    <td class="new-orders-date" rowspan="${rowSpan}">${escapeHtml(soFormatDate(pp.due_date))}</td>
    <td class="new-orders-date" rowspan="${rowSpan}">${escapeHtml(soFormatDate(pp.delivery_date))}</td>
    <td class="new-orders-num" rowspan="${rowSpan}">${escapeHtml(soFormatMoney(pp.unit_selling_price))}</td>
    <td class="new-orders-num" rowspan="${rowSpan}">${escapeHtml(soFormatMoney(pp.amount))}</td>
    <td class="new-orders-num" rowspan="${rowSpan}">${escapeHtml(String(pp.pp_qty ?? '—'))}</td>
    ${SO_NOTE_FIELDS.map(field => soRenderEditableCell(pp, field, rowSpan)).join('')}
  `;
}

function soRenderEditableCell(pp, field, rowSpan) {
  const ppNo = String(pp.pp_voucher_no || '').trim();
  const value = String(pp[field] || '');
  const label = SO_NOTE_LABELS[field] || field;
  return `
    <td class="so-editable-cell" rowspan="${rowSpan}">
      <textarea
        class="so-editable-input"
        rows="2"
        data-pp-voucher-no="${escapeHtml(ppNo)}"
        data-field="${escapeHtml(field)}"
        data-last-saved="${escapeHtml(value)}"
        aria-label="${escapeHtml(label)}"
        placeholder="—"
      >${escapeHtml(value)}</textarea>
      <span class="so-editable-status" aria-live="polite"></span>
    </td>
  `;
}

function soRenderLeafCells(pp, partial) {
  const part = partial?.inventory_code || pp?.inventory_code || '—';
  return `
    <td class="new-orders-num">${escapeHtml(partial ? String(partial.pp_partial_no ?? '—') : '—')}</td>
    <td class="new-orders-num">${escapeHtml(String(part))}</td>
  `;
}

function soRenderLeafRow(leaf, { includeSideRail, sideRowSpan, groupStart, includePpCells, ppRowSpan, ppStart }) {
  const { order, pp, partial } = leaf;
  const key = soPartialKey(order, pp, partial);
  const selected = key === soState.selectedKey;
  const sideRail = includeSideRail ? soRenderSideRail(order, sideRowSpan) : '';
  const ppVoucherCell = includePpCells ? soRenderPpVoucherCell(pp, ppRowSpan) : '';
  const ppCells = includePpCells ? soRenderPpSpanCells(pp, ppRowSpan) : '';
  const startClass = groupStart ? ' new-orders-group-start' : '';
  const ppStartClass = ppStart ? ' so-pp-group-start' : '';
  return `
    <tr class="new-orders-child-row is-clickable${startClass}${ppStartClass}${selected ? ' is-selected' : ''}" data-sales-order="${escapeHtml(String(order.sales_order_no || ''))}" data-detail-key="${escapeHtml(key)}" title="Click for detail">
      ${sideRail}
      ${ppVoucherCell}
      ${soRenderLeafCells(pp, partial)}
      ${ppCells}
    </tr>
  `;
}

function soRenderOrderGroup(order) {
  const soNo = String(order.sales_order_no || '').trim();
  const collapsed = soState.collapsedGroups.has(soNo);
  const leaves = soVisibleLeaves(order);
  const colSpan = 17;

  if (!leaves.length) return '';

  if (collapsed) {
    const label = `${leaves.length} row(s) hidden`;
    return `
      <tr class="new-orders-group-row is-clickable" data-sales-order="${escapeHtml(soNo)}" title="Click for order detail">
        ${soRenderSideRail(order, 1)}
        <td colspan="${colSpan}" class="new-orders-collapsed-summary">${escapeHtml(label)} — expand to view</td>
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
        includePpCells: firstPpRow,
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

function soSetSaveStatus(textarea, state, message) {
  const status = textarea?.closest('.so-editable-cell')?.querySelector('.so-editable-status');
  if (!status) return;
  status.className = `so-editable-status${state ? ` is-${state}` : ''}`;
  status.textContent = message || '';
}

async function soSaveField(textarea) {
  const ppNo = String(textarea.dataset.ppVoucherNo || '').trim();
  const field = String(textarea.dataset.field || '').trim();
  if (!ppNo || !field) return;

  const nextValue = String(textarea.value || '').trim();
  const lastSaved = String(textarea.dataset.lastSaved || '');
  if (nextValue === lastSaved) return;

  textarea.disabled = true;
  soSetSaveStatus(textarea, 'saving', 'Saving…');
  try {
    const data = await soPostJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, {
      [field]: nextValue,
    });
    const saved = String(data[field] || '').trim();
    textarea.value = saved;
    textarea.dataset.lastSaved = saved;
    const found = soFindPp(ppNo);
    if (found.pp) found.pp[field] = saved;
    soSetSaveStatus(textarea, 'saved', 'Saved');
    window.setTimeout(() => {
      if (textarea.dataset.lastSaved === saved) soSetSaveStatus(textarea, '', '');
    }, 1500);
  } catch (err) {
    soSetSaveStatus(textarea, 'error', err.message || 'Save failed');
  } finally {
    textarea.disabled = false;
  }
}

function soScheduleSave(textarea) {
  const key = `${textarea.dataset.ppVoucherNo}::${textarea.dataset.field}`;
  const existing = soState.saveTimers.get(key);
  if (existing) window.clearTimeout(existing);
  soState.saveTimers.set(key, window.setTimeout(() => {
    soState.saveTimers.delete(key);
    soSaveField(textarea);
  }, 500));
}

function soBindEditableInputs() {
  const body = document.getElementById('so-table-body');
  if (!body || body.dataset.editableBound === '1') return;
  body.dataset.editableBound = '1';

  body.addEventListener('input', e => {
    const textarea = e.target.closest('.so-editable-input');
    if (!textarea) return;
    e.stopPropagation();
    soScheduleSave(textarea);
  });

  body.addEventListener('blur', e => {
    const textarea = e.target.closest('.so-editable-input');
    if (!textarea) return;
    const key = `${textarea.dataset.ppVoucherNo}::${textarea.dataset.field}`;
    const pending = soState.saveTimers.get(key);
    if (pending) {
      window.clearTimeout(pending);
      soState.saveTimers.delete(key);
    }
    soSaveField(textarea);
  }, true);

  body.addEventListener('keydown', e => {
    const textarea = e.target.closest('.so-editable-input');
    if (!textarea) return;
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      textarea.blur();
    }
  });
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
  const orders = soVisibleOrders(soActiveOrders());
  let leafCount = 0;
  orders.forEach(order => { leafCount += soVisibleLeaves(order).length; });
  const activeN = soVisibleOrders(soState.active).length;
  const completeN = soVisibleOrders(soState.complete).length;
  const label = soState.view === 'complete' ? 'Complete' : 'Active';
  stats.textContent = `${label}: ${orders.length} SO · ${leafCount} rows · Active: ${activeN} · Complete: ${completeN}`;
}

function soRender() {
  soRenderTableHead();
  const orders = soVisibleOrders(soActiveOrders());
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
          ? (soState.ppTypes.size === 0
            ? 'Select at least one PP prefix (APS, NPS, …).'
            : 'No rows match your search or column filters in this view.')
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
  if (body) {
    body.innerHTML = orders.map(soRenderOrderGroup).filter(Boolean).join('');
    delete body.dataset.editableBound;
    soBindEditableInputs();
  }
  if (meta) {
    meta.hidden = false;
    const missing = Number(soState.missingHeaderCount) || 0;
    const missingNote = missing > 0 ? ` · ${missing} without so_order_view header` : '';
    meta.textContent = `Planner notes autosave on blur · per PP voucher in Supabase · Click a row for detail · ${soState.ppCount || 0} PP · ${soState.partialCount || 0} partials · cached ${soState.cachedAt || '—'} · TTL ${soState.cacheTtlSec}s${missingNote}`;
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
  soBindColumnControls();
  soBindPsTypeDropdown();
  soRenderTableHead();
  soLoad({ refresh: false });
}

document.addEventListener('DOMContentLoaded', soInit);
