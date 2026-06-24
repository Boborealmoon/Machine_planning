// S/O Management — mfg_pp_vch → mfg_pp_partial_view, so_order_view header on sales_order_no.

const SO_NOTE_FIELDS = [
  'material_subcon',
  'mtl_part_order',
  'quality_doc',
  'ops_notes',
  'sales_notes',
];

const SO_NOTE_LABELS = {
  material_subcon: 'Material in / Sub-con',
  mtl_part_order: 'Mtl / Part Order',
  quality_doc: 'Quality Doc',
  ops_notes: 'Ops',
  sales_notes: 'Sales',
};

const SO_MATERIAL_SUBCON_ARRIVED = 'ARRIVED';

function soParseMaterialSubcon(raw) {
  const text = String(raw || '').trim();
  if (!text) return { arrived: false, date: '', legacy: '' };
  if (/^arrived$/i.test(text)) return { arrived: true, date: '', legacy: '' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { arrived: false, date: text, legacy: '' };
  const dmy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const parsed = Date.parse(`${iso}T00:00:00`);
      if (!Number.isNaN(parsed)) return { arrived: false, date: iso, legacy: '' };
    }
  }
  return { arrived: false, date: '', legacy: text };
}

function soSerializeMaterialSubcon({ arrived, date }) {
  if (arrived) return SO_MATERIAL_SUBCON_ARRIVED;
  const iso = String(date || '').trim();
  return iso || '';
}

function soMaterialSubconDisplay(raw) {
  const parsed = soParseMaterialSubcon(raw);
  if (parsed.arrived) return 'Arrived';
  if (parsed.date) return soFormatDate(parsed.date);
  if (parsed.legacy) return parsed.legacy;
  return '';
}

function soMaterialSubconSortValue(raw) {
  const parsed = soParseMaterialSubcon(raw);
  if (parsed.arrived) return '0-arrived';
  if (parsed.date) return `1-${parsed.date}`;
  if (parsed.legacy) return `2-${parsed.legacy.toLowerCase()}`;
  return '9-empty';
}

const SO_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];

const SO_COLUMNS = [
  { id: '_so', label: 'SO', side: true, sortable: true, filterable: true },
  { id: 'process_sheet_no', label: 'Process sheet', sortable: true, filterable: true, filterType: 'prefix', stickyAfterSide: true },
  { id: 'partial', label: 'Partial', sortable: true, filterable: true },
  { id: 'exception', label: 'Exception', sortable: true, filterable: false },
  { id: 'queued_cnc', label: 'Queued CNC', sortable: true, filterable: true },
  { id: 'erp_stage', label: 'Stage', sortable: true, filterable: true },
  { id: 'qty', label: 'Qty', sortable: true, filterable: true },
  { id: 'order_date', label: 'Date', sortable: true, filterable: true },
  { id: 'part', label: 'Part', sortable: true, filterable: true },
  { id: 'description', label: 'Description', sortable: true, filterable: true },
  { id: 'customer_po_no', label: 'P/O No.', sortable: true, filterable: true },
  { id: 'due_date', label: 'Due date', sortable: true, filterable: true },
  { id: 'delivery_date', label: 'Del. date', sortable: true, filterable: true },
  { id: 'unit_selling_price', label: 'U/Price', sortable: true, filterable: true },
  { id: 'amount', label: 'Amount', sortable: true, filterable: true },
  { id: 'material_subcon', label: 'Material in / Sub-con', sortable: true, filterable: true },
  { id: 'mtl_part_order', label: 'Mtl / Part Order', sortable: true, filterable: true },
  { id: 'quality_doc', label: 'Quality Doc', sortable: true, filterable: true },
  { id: 'ops_notes', label: 'Ops', sortable: true, filterable: true },
  { id: 'sales_notes', label: 'Sales', sortable: true, filterable: true },
];

const SO_REPEAT_KEYS = {
  soKey: row => row.source_voucher_no,
  partKey: row => row.inventory_code,
  bomKey: row => row.bom_code,
  psKey: row => row.process_sheet_no,
};

const soState = {
  active: [],
  complete: [],
  repeatGroups: [],
  view: 'active',
  search: '',
  cachedAt: '',
  cacheTtlSec: 300,
  ppCount: 0,
  partialCount: 0,
  missingHeaderCount: 0,
  collapsedGroups: new Set(),
  selectedKey: '',
  saveInFlight: new Set(),
  ppTypes: new Set(['APS', 'NPS']),
  sortCol: '',
  sortDir: 'asc',
  colFilters: {},
  openFilterCol: '',
};

function soAllPpItems() {
  const items = [];
  soAllOrders().forEach(order => {
    (order.pp_vouchers || []).forEach(pp => {
      items.push({
        source_voucher_no: order.sales_order_no,
        inventory_code: pp.inventory_code,
        bom_code: pp.bom_code,
        process_sheet_no: pp.process_sheet_no,
        pp,
        order,
      });
    });
  });
  return items;
}

function soRepeatRow(order, pp) {
  return {
    source_voucher_no: order?.sales_order_no,
    inventory_code: pp?.inventory_code,
    bom_code: pp?.bom_code,
    process_sheet_no: pp?.process_sheet_no,
  };
}

function soRepeatSoPsMap() {
  return repeatOrderBuildSoPsMap(
    soAllPpItems(),
    item => item.source_voucher_no,
    item => item.process_sheet_no,
  );
}

function soSimilarPsForPp(order, pp) {
  return repeatOrderSimilarList(
    soRepeatRow(order, pp),
    soState.repeatGroups,
    soRepeatSoPsMap(),
    SO_REPEAT_KEYS,
  );
}

function soRenderRepeatPill(order, pp) {
  return repeatOrderRenderPill(soSimilarPsForPp(order, pp));
}

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

function soPsDisplayId(pp) {
  const ppNo = String(pp?.pp_voucher_no || '').trim();
  const psNo = String(pp?.process_sheet_no || '').trim();
  if (psNo && ppNo && psNo !== ppNo) return `${ppNo} · ${psNo}`;
  return psNo || ppNo || '—';
}

function soPsDisplayLabel(pp) {
  const ppNo = String(pp?.pp_voucher_no || '').trim();
  const psNo = String(pp?.process_sheet_no || '').trim();
  if (psNo && ppNo && psNo !== ppNo) return 'PP / Process sheet';
  return 'Process sheet';
}

function soPartialNo(partial) {
  const n = Number(partial?.pp_partial_no);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function soPartialQueuedMachines(pp, partial) {
  if (Array.isArray(partial?.queued_machines)) {
    return partial.queued_machines.filter(Boolean);
  }
  const pno = String(soPartialNo(partial));
  const byPartial = pp?.queued_machines_by_partial;
  if (byPartial && Array.isArray(byPartial[pno])) return byPartial[pno].filter(Boolean);
  const fromList = (pp?.partials || []).find(row => String(soPartialNo(row)) === pno);
  if (Array.isArray(fromList?.queued_machines)) return fromList.queued_machines.filter(Boolean);
  if (pno === '1' && Array.isArray(pp?.queued_machines)) return pp.queued_machines.filter(Boolean);
  return [];
}

function soQueuedMachinesLabel(pp, partial) {
  const machines = partial ? soPartialQueuedMachines(pp, partial) : (pp?.queued_machines || []);
  return machines.length ? machines.join(', ') : '—';
}

function soRenderQueuedMachinesHtml(machines) {
  const list = Array.isArray(machines) ? machines.filter(Boolean) : [];
  if (!list.length) return '<span class="so-dash">—</span>';
  const pills = list.map(machine => (
    `<span class="so-queue-machine-pill">${escapeHtml(String(machine))}</span>`
  )).join('');
  return `<span class="so-queue-machines" title="Queued on planner CNC lanes (this partial)">${pills}</span>`;
}

function soIsPartialQueued(pp, partial) {
  if (soState.view !== 'active' || pp?.shipped_completed) return false;
  return soPartialQueuedMachines(pp, partial).length > 0;
}

function soExecutionLabel(code) {
  const c = String(code || '').trim().toUpperCase();
  if (c === 'I' || c === 'IN_PROCESS') return 'In Process';
  if (c === 'R' || c === 'READY_TO_START') return 'Ready to Start';
  if (c === 'P' || c === 'PENDING_SI') return 'Pending SI';
  if (c === 'C' || c === 'COMPLETED') return 'Completed';
  return c || '—';
}

function soStatusPill(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return '';
  let cls = 'mi-status-pill';
  if (c === 'I') cls += ' mi-status-pill--o';
  else if (c === 'R') cls += ' mi-status-pill--r';
  else if (c === 'P') cls += ' mi-status-pill--h';
  return `<span class="${cls}" title="${escapeHtml(soExecutionLabel(c))}">${escapeHtml(c)}</span>`;
}

function soPartialStage(partial) {
  return {
    desc: String(partial?.current_stage_desc || '').trim(),
    status: String(partial?.current_stage_status || '').trim(),
    no: partial?.current_stage_no,
    mode: String(partial?.erp_stage_mode || 'unassigned').trim() || 'unassigned',
    lastDesc: String(partial?.erp_last_stage_desc || '').trim(),
    lastStatus: String(partial?.erp_last_stage_status || '').trim(),
    woCount: Number(partial?.erp_wo_stage_count) || 0,
  };
}

function soStageModeLabel(mode) {
  if (mode === 'unassigned') return 'No WO assigned';
  if (mode === 'completed') return 'All stages complete';
  return '';
}

function soStageSortValue(partial) {
  const stage = soPartialStage(partial);
  if (stage.desc || stage.status) {
    const statusRank = { P: 1, R: 2, I: 3 }[String(stage.status).toUpperCase()] || 0;
    return `0|${String(statusRank).padStart(2, '0')}|${stage.desc}|${stage.status}`;
  }
  if (stage.mode === 'unassigned') return '1|no wo assigned';
  if (stage.mode === 'completed') return `2|${stage.lastDesc || 'all stages complete'}`;
  return '1|';
}

function soStageLabel(partial) {
  const stage = soPartialStage(partial);
  if (stage.desc || stage.status) {
    const parts = [];
    if (stage.desc) parts.push(stage.desc);
    if (stage.status) parts.push(soExecutionLabel(stage.status));
    return parts.join(' · ');
  }
  if (stage.mode === 'unassigned') return soStageModeLabel('unassigned');
  if (stage.mode === 'completed') {
    if (stage.lastDesc) return `All stages complete · ${stage.lastDesc}`;
    return soStageModeLabel('completed');
  }
  return '';
}

function soPartialIsNoWo(partial) {
  const stage = soPartialStage(partial);
  return !stage.desc && !stage.status && stage.mode === 'unassigned';
}

function soCollectNoWoProcessSheets() {
  const sheets = [];
  soVisibleOrders(soActiveOrders()).forEach(order => {
    soVisibleLeaves(order).forEach(leaf => {
      if (!soPartialIsNoWo(leaf.partial)) return;
      const ps = soPsDisplayForPartial(leaf.pp, leaf.partial);
      if (!ps || ps === '—') return;
      sheets.push(ps);
    });
  });
  return sheets;
}

function soCopyNoWoProcessSheets() {
  const btn = document.getElementById('so-copy-no-wo-ps');
  const sheets = soCollectNoWoProcessSheets();
  if (!sheets.length) {
    if (!btn) return;
    const defaultLabel = btn.dataset.defaultLabel || btn.textContent;
    btn.dataset.defaultLabel = defaultLabel;
    btn.textContent = 'None found';
    window.setTimeout(() => {
      btn.textContent = btn.dataset.defaultLabel || 'Copy No WO PS';
    }, 1600);
    return;
  }
  const text = sheets.join('\n');
  const defaultLabel = btn?.dataset.defaultLabel || btn?.textContent || 'Copy No WO PS';
  if (btn) btn.dataset.defaultLabel = defaultLabel;
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    btn.textContent = `Copied ${sheets.length}`;
    window.setTimeout(() => {
      btn.textContent = btn.dataset.defaultLabel || 'Copy No WO PS';
    }, 1600);
  }).catch(() => {
    if (!btn) return;
    btn.textContent = 'Copy failed';
    window.setTimeout(() => {
      btn.textContent = btn.dataset.defaultLabel || 'Copy No WO PS';
    }, 1600);
  });
}

function soPsDisplayForPartial(pp, partial) {
  const base = soPsDisplayId(pp);
  const partialCount = Math.max(1, (pp?.partials || []).length);
  const pno = soPartialNo(partial);
  if (partialCount > 1) return `${base} · p${pno}`;
  return base;
}

function soRenderJobDetailFields(order, pp, partial) {
  const similar = soSimilarPsForPp(order, pp);
  return [
    soDetailField('Sales order', order?.sales_order_no, { mono: true }),
    soDetailField('Partial', partial?.pp_partial_no ?? '—'),
    soDetailField(soPsDisplayLabel(pp), soPsDisplayId(pp), { mono: true }),
    typeof repeatOrderDetailHtml === 'function' ? repeatOrderDetailHtml(similar) : '',
    soDetailField('Queued CNC', soQueuedMachinesLabel(pp, partial), { mono: true }),
    ...(soPartialStage(partial).desc ? [soDetailField('Stage', soPartialStage(partial).desc)] : []),
    ...(soPartialStage(partial).status ? [soDetailField('Stage status', soExecutionLabel(soPartialStage(partial).status))] : []),
    ...(!soPartialStage(partial).desc && !soPartialStage(partial).status
      ? [soDetailField('WO assignment', soStageLabel(partial))]
      : []),
    soDetailField('Part', partial?.inventory_code || pp?.inventory_code, { mono: true }),
    soDetailField('Description', pp?.description, { fullWidth: true }),
    soDetailField('Customer PO', partial?.customer_po_no || pp?.customer_po_no || order?.customer_po_no, { mono: true }),
    soDetailField('SO line', pp?.source_line_item_no),
    soDetailField('Due date', soFormatDate(pp?.due_date)),
    soDetailField('Del. date', soFormatDate(pp?.delivery_date)),
    soDetailField('Qty', pp?.pp_qty),
    soDetailField('U/Price', soFormatMoney(pp?.unit_selling_price)),
    soDetailField('Amount', soFormatMoney(pp?.amount)),
    soDetailField('PP status', pp?.status),
    ...SO_NOTE_FIELDS.map(field => soDetailField(
      SO_NOTE_LABELS[field],
      field === 'material_subcon' ? soMaterialSubconDisplay(pp?.[field]) : pp?.[field],
    )),
  ].join('');
}

function soRenderPartialDetail(order, pp, partial) {
  const lineHtml = soRenderJobDetailFields(order, pp, partial);
  const orderHtml = [
    soDetailField('Customer', partial?.party_name || order?.customer_name || order?.customer_short_name),
    soDetailField('Customer code', partial?.customer_code || order?.customer_code, { mono: true }),
    soDetailField('Order date', soFormatDate(order?.order_date)),
    soPostedDetailFields(order),
    soDetailField('Voucher status', order?.voucher_status, { mono: true }),
  ].join('');
  return [
    soDetailSection('Line detail', lineHtml),
    soDetailSection('Sales order', orderHtml),
  ].join('');
}

function soRenderPpDetail(order, pp) {
  const partials = Array.isArray(pp?.partials) ? pp.partials : [];
  const partialList = partials.map(partial => {
    const key = soPartialKey(order, pp, partial);
    const queueHtml = soRenderQueuedMachinesHtml(soPartialQueuedMachines(pp, partial));
    return `
      <button type="button" class="new-orders-detail-line-pick" data-detail-key="${escapeHtml(key)}">
        <span class="new-orders-detail-line-pick-no">Partial ${escapeHtml(String(partial.pp_partial_no ?? '—'))}</span>
        <span class="new-orders-detail-line-pick-part">${escapeHtml(String(partial.inventory_code || '—'))}</span>
        <span class="new-orders-detail-line-pick-desc">${escapeHtml(soQueuedMachinesLabel(pp, partial))}</span>
        <span class="new-orders-detail-line-pick-queue">${queueHtml}</span>
      </button>
    `;
  }).join('');
  const lineHtml = [
    soDetailField(soPsDisplayLabel(pp), soPsDisplayId(pp), { mono: true }),
    soDetailField('Queued CNC (all)', soQueuedMachinesLabel(pp), { mono: true }),
    soDetailField('Part', pp?.inventory_code, { mono: true }),
    soDetailField('BOM', pp?.bom_code, { mono: true }),
    soDetailField('Description', pp?.description, { fullWidth: true }),
    soDetailField('Customer PO', pp?.customer_po_no, { mono: true }),
    soDetailField('Qty', pp?.pp_qty),
    soDetailField('Due date', soFormatDate(pp?.due_date)),
    ...SO_NOTE_FIELDS.map(field => soDetailField(
      SO_NOTE_LABELS[field],
      field === 'material_subcon' ? soMaterialSubconDisplay(pp?.[field]) : pp?.[field],
    )),
  ].join('');
  const orderHtml = [
    soDetailField('Sales order', order?.sales_order_no, { mono: true }),
    soDetailField('Customer', order?.customer_name || order?.customer_short_name),
    soDetailField('Order date', soFormatDate(order?.order_date)),
    soDetailField('Status', order?.status),
  ].join('');
  return `
    ${soDetailSection('Job', lineHtml)}
    <section class="new-orders-detail-section">
      <h3 class="new-orders-detail-section-title">Partials — click for detail</h3>
      <div class="new-orders-detail-line-list">${partialList || '<p class="new-orders-muted">No partial rows.</p>'}</div>
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
    const repeatPill = soRenderRepeatPill(order, pp);
    return `
      <button type="button" class="new-orders-detail-line-pick" data-detail-key="${escapeHtml(key)}">
        <span class="new-orders-detail-line-pick-no">${escapeHtml(soPsDisplayId(pp))}</span>
        <span class="new-orders-detail-line-pick-ps">
          ${repeatPill}
          ${soRenderQueuedMachinesHtml(pp.queued_machines)}
        </span>
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

function soTableHost() {
  return document.getElementById('so-table-host');
}

let soTableScrollResizeObserver = null;

function soSyncTableScrollWidth() {
  const topInner = document.querySelector('.so-table-scroll-top-inner');
  const wrap = document.getElementById('so-table-wrap');
  const table = wrap?.querySelector('.so-table--wide');
  if (!topInner || !wrap || !table) return;
  const w = Math.max(table.scrollWidth, wrap.clientWidth, 1);
  topInner.style.width = `${w}px`;
}

function soBindTableScroll() {
  const top = document.getElementById('so-table-scroll-top');
  const wrap = document.getElementById('so-table-wrap');
  if (!top || !wrap || top.dataset.scrollBound === '1') return;
  top.dataset.scrollBound = '1';

  let syncing = false;
  const syncFromWrap = () => {
    if (syncing) return;
    syncing = true;
    top.scrollLeft = wrap.scrollLeft;
    syncing = false;
  };
  const syncFromTop = () => {
    if (syncing) return;
    syncing = true;
    wrap.scrollLeft = top.scrollLeft;
    syncing = false;
  };
  wrap.addEventListener('scroll', syncFromWrap, { passive: true });
  top.addEventListener('scroll', syncFromTop, { passive: true });

  if (!soTableScrollResizeObserver) {
    soTableScrollResizeObserver = new ResizeObserver(() => soSyncTableScrollWidth());
  }
  const table = wrap.querySelector('.so-table--wide');
  if (table) soTableScrollResizeObserver.observe(table);
  soTableScrollResizeObserver.observe(wrap);
  soSyncTableScrollWidth();
}

function soBindTableClicks() {
  const wrap = document.getElementById('so-table-wrap');
  if (!wrap || wrap.dataset.detailBound === '1') return;
  wrap.dataset.detailBound = '1';

  wrap.addEventListener('click', e => {
    if (e.target.closest('.so-editable-input, .so-editable-cell, .so-material-subcon-cell, .so-exception-cell')) return;

    const materialBtn = e.target.closest('[data-action="open-material"]');
    if (materialBtn) {
      e.stopPropagation();
      soOpenMaterialModal({
        partNo: materialBtn.getAttribute('data-part-no'),
        bomCode: materialBtn.getAttribute('data-bom-code'),
        processSheetNo: materialBtn.getAttribute('data-process-sheet'),
      });
      return;
    }

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
      ...(pp.queued_machines || []),
      ...((pp.partials || []).flatMap(p => p.queued_machines || [])),
      ...SO_NOTE_FIELDS.map(field => (
        field === 'material_subcon' ? soMaterialSubconDisplay(pp[field]) : pp[field]
      )),
    );
    (pp.partials || []).forEach(partial => {
      parts.push(
        partial.pp_partial_no,
        partial.inventory_code,
        partial.party_name,
        partial.customer_po_no,
        partial.customer_code,
        partial.current_stage_desc,
        partial.current_stage_status,
        partial.erp_stage_mode,
        partial.erp_last_stage_desc,
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
      // No mfg_pp_partial_view rows — show as partial 1 (same as implicit single partial on PP).
      const pno = 1;
      const byPartial = pp.queued_machines_by_partial || {};
      leaves.push({
        order,
        pp,
        partial: {
          pp_partial_no: pno,
          inventory_code: pp.inventory_code,
          queued_machines: Array.isArray(byPartial[String(pno)])
            ? byPartial[String(pno)]
            : (pp.queued_machines || []),
          current_stage_no: pp.current_stage_no,
          current_stage_desc: pp.current_stage_desc,
          current_stage_status: pp.current_stage_status,
          erp_stage_mode: pp.erp_stage_mode,
          erp_wo_stage_count: pp.erp_wo_stage_count,
          erp_all_wo_complete: pp.erp_all_wo_complete,
          erp_last_stage_no: pp.erp_last_stage_no,
          erp_last_stage_desc: pp.erp_last_stage_desc,
          erp_last_stage_status: pp.erp_last_stage_status,
        },
      });
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

function soTypeTagLabel(psType) {
  const t = String(psType || 'OTHER');
  return t === 'SR' ? '[SR]' : t;
}

function soTypeTagHtml(psType, count) {
  const t = String(psType || 'OTHER');
  const cls = `so-type-tag so-type-tag--${t.toLowerCase()}`;
  const label = soTypeTagLabel(t);
  const text = count != null ? `${label} ${count}` : label;
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function soTypeTagsHtml(typeCounts) {
  const entries = Object.entries(typeCounts || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => {
      const ai = SO_PS_TYPES.indexOf(a[0]);
      const bi = SO_PS_TYPES.indexOf(b[0]);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  if (!entries.length) return '<span class="so-dash">—</span>';
  return `<span class="so-type-tags">${entries.map(([t, c]) => soTypeTagHtml(t, c)).join('')}</span>`;
}

function soVisibleTypeCounts() {
  const typeCounts = {};
  const ppSeen = new Set();
  soVisibleOrders(soActiveOrders()).forEach(order => {
    soVisibleLeaves(order).forEach(leaf => {
      const ppNo = String(leaf.pp?.pp_voucher_no || '').trim();
      if (ppNo && !ppSeen.has(ppNo)) {
        ppSeen.add(ppNo);
        const t = soGetPsType(leaf.pp) || 'OTHER';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      }
    });
  });
  return { typeCounts, ppCount: ppSeen.size };
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
    case 'partial': return partial?.pp_partial_no ?? '';
    case 'exception': return soIsPartialException(pp, partial) ? 'flagged' : '';
    case 'process_sheet_no': return soPsDisplayId(pp);
    case 'queued_cnc': return soQueuedMachinesLabel(pp, partial);
    case 'erp_stage': return soStageLabel(partial);
    case 'order_date': return pp?.order_date;
    case 'part': return partial?.inventory_code || pp?.inventory_code;
    case 'description': return pp?.description;
    case 'customer_po_no': return pp?.customer_po_no;
    case 'due_date': return pp?.due_date;
    case 'delivery_date': return pp?.delivery_date;
    case 'unit_selling_price': return pp?.unit_selling_price;
    case 'amount': return pp?.amount;
    case 'qty': return pp?.pp_qty;
    case 'material_subcon':
      return soMaterialSubconDisplay(pp?.material_subcon);
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

function soLeafSortValue(leaf, colId) {
  if (colId === 'erp_stage') return soStageSortValue(leaf.partial);
  if (colId === 'material_subcon') return soMaterialSubconSortValue(leaf.pp?.material_subcon);
  return soLeafColumnValue(leaf, colId);
}

function soVisibleLeaves(order) {
  let leaves = soLeafRows(order).filter(soLeafPassesFilters);
  if (soState.sortCol) {
    leaves = [...leaves].sort((a, b) => soCompareValues(
      soLeafSortValue(a, soState.sortCol),
      soLeafSortValue(b, soState.sortCol),
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
        : soLeafSortValue(soVisibleLeaves(a)[0], soState.sortCol);
      const bv = soState.sortCol === '_so'
        ? b.sales_order_no
        : soLeafSortValue(soVisibleLeaves(b)[0], soState.sortCol);
      return soCompareValues(av, bv, soState.sortDir);
    });
  }
  return list;
}

function soColumnFilterActive(colId) {
  if (colId === 'process_sheet_no' && !soPpTypesAllSelected()) return true;
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
    const stickyCls = col.stickyAfterSide ? ' so-sticky-ps-head' : '';
    if (!col.sortable && !col.filterable) {
      return `<th class="${sideCls}${stickyCls}">${escapeHtml(col.label)}</th>`;
    }
    return `
      <th class="so-col-head${sideCls}${stickyCls}${sortCls}" data-so-col="${escapeHtml(col.id)}">
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

function soColumnFilterBtn(colId) {
  const wrap = document.getElementById('so-table-wrap');
  if (!wrap || !colId) return null;
  return wrap.querySelector(`[data-action="filter-col"][data-so-col="${CSS.escape(colId)}"]`);
}

function soRepositionColumnFilter() {
  const pop = document.getElementById('so-col-filter-popover');
  if (!pop || pop.hidden || !soState.openFilterCol) return;
  const btn = soColumnFilterBtn(soState.openFilterCol);
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  pop.style.left = `${Math.max(8, rect.left)}px`;
  pop.style.top = `${rect.bottom + 4}px`;
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

  pop.hidden = false;
  soRepositionColumnFilter();
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

  wrap.addEventListener('scroll', soRepositionColumnFilter, { passive: true });
  window.addEventListener('resize', soRepositionColumnFilter);

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
      if (colId === 'process_sheet_no') {
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

function soRenderSideRail(order, rowSpan, { shadeAlt = false } = {}) {
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
    <td class="new-orders-side-rail new-orders-side-rail--compact${shadeAlt ? ' new-orders-side-rail--shade-alt' : ''}" rowspan="${rowSpan}" data-sales-order="${escapeHtml(soNo)}" title="${escapeHtml(railTitle)}">
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

function soRenderProcessSheetCell(order, pp, partial) {
  const psCode = soPsDisplayForPartial(pp, partial);
  const repeatPill = soRenderRepeatPill(order, pp);
  const psType = soGetPsType(pp);
  const tag = psType ? soTypeTagHtml(psType) : '';
  return `
    <td class="new-orders-ps-cell so-process-sheet-cell so-sticky-ps-cell">
      <div class="so-ps-headline">
        ${tag}
        <span class="new-orders-ps-code">${escapeHtml(psCode)}</span>
      </div>
      ${repeatPill}
    </td>
  `;
}

function soRenderQueuedCncCell(pp, partial) {
  return `
    <td class="so-queued-cnc-cell">
      ${soRenderQueuedMachinesHtml(soPartialQueuedMachines(pp, partial))}
    </td>
  `;
}

function soPartNoForRow(pp, partial) {
  return String(partial?.inventory_code || pp?.inventory_code || '').trim();
}

function soRenderStageMaterialBtn(pp, partial) {
  const partNo = soPartNoForRow(pp, partial);
  if (!partNo) return '';
  const bomCode = String(pp?.bom_code || '').trim();
  const processSheetNo = soPsDisplayForPartial(pp, partial);
  const title = bomCode
    ? `View BOM materials for ${partNo} · ${bomCode}`
    : `View BOM materials for ${partNo}`;
  return `
    <button type="button" class="so-stage-material-btn btn btn-ghost btn-sm"
      data-action="open-material"
      data-part-no="${escapeHtml(partNo)}"
      data-bom-code="${escapeHtml(bomCode)}"
      data-process-sheet="${escapeHtml(processSheetNo)}"
      title="${escapeHtml(title)}">Materials</button>
  `;
}

function soRenderStageCell(pp, partial) {
  const stage = soPartialStage(partial);
  let stageHtml = '';
  if (stage.desc || stage.status) {
    const descHtml = stage.desc
      ? `<span class="so-stage-desc" title="${escapeHtml(stage.desc)}">${escapeHtml(stage.desc)}</span>`
      : '';
    const statusHtml = stage.status ? soStatusPill(stage.status) : '';
    stageHtml = `${descHtml}${statusHtml}`;
  } else if (stage.mode === 'unassigned') {
    const title = 'No work-order stages in ERP (mfg_wo_status) for this partial';
    stageHtml = `<span class="so-stage-mode so-stage-mode--unassigned" title="${escapeHtml(title)}">No WO</span>`;
  } else if (stage.mode === 'completed') {
    const last = stage.lastDesc
      ? `Last stage: ${stage.lastDesc}${stage.lastStatus ? ` (${soExecutionLabel(stage.lastStatus)})` : ''}`
      : 'All manufacturing stages marked complete in ERP';
    const countNote = stage.woCount ? ` · ${stage.woCount} stage${stage.woCount === 1 ? '' : 's'}` : '';
    stageHtml = `<span class="so-stage-mode so-stage-mode--completed" title="${escapeHtml(last + countNote)}">All complete</span>`;
  } else {
    stageHtml = '<span class="so-dash">—</span>';
  }
  return `
    <td class="so-stage-cell">
      <div class="so-stage-stack">
        ${stageHtml}
        ${soRenderStageMaterialBtn(pp, partial)}
      </div>
    </td>`;
}

const SO_COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5" y="4" width="8" height="10" rx="1"/><path d="M4 4V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1"/></svg>';

function soCopyBtn(text, label) {
  const value = String(text || '').trim();
  if (!value) return '';
  const aria = escapeHtml(label || 'text');
  return `
    <button type="button" class="so-copy-btn"
      data-action="copy-text"
      data-copy-json="${escapeHtml(JSON.stringify(value))}"
      title="Copy ${aria}"
      aria-label="Copy ${aria}">
      ${SO_COPY_ICON}
    </button>
  `;
}

function soCopyableLine(label, text, { mono = false } = {}) {
  const value = String(text || '').trim();
  if (!value) return '';
  const cls = mono ? ' so-material-modal-id-value--mono' : '';
  return `
    <div class="so-copy-line so-material-modal-id-row">
      <span class="so-material-modal-id-label">${escapeHtml(label)}</span>
      <span class="so-material-modal-id-value${cls}">${escapeHtml(value)}</span>
      ${soCopyBtn(value, label)}
    </div>
  `;
}

function soCopyableCell(text, label) {
  const value = String(text || '').trim();
  if (!value || value === '—') return escapeHtml(text || '—');
  return `
    <span class="so-copy-line so-copy-line--cell">
      <span class="so-copy-line-text">${escapeHtml(value)}</span>
      ${soCopyBtn(value, label)}
    </span>
  `;
}

function soRenderMaterialModalHeader(partNo, bomCode, processSheetNo) {
  const rows = [
    soCopyableLine('Part no', partNo, { mono: true }),
    soCopyableLine('BOM code', bomCode, { mono: true }),
    soCopyableLine('PS number', processSheetNo, { mono: true }),
  ].filter(Boolean).join('');
  const part = String(partNo || '').trim();
  if (rows) return rows;
  return part
    ? `<div class="so-copy-line so-material-modal-id-row"><span class="so-material-modal-id-value so-material-modal-id-value--mono">${escapeHtml(part)}</span>${soCopyBtn(part, 'Part no')}</div>`
    : '';
}

function soCopyTextFromButton(btn) {
  if (!btn) return;
  let value = '';
  try {
    value = JSON.parse(btn.dataset.copyJson || '""');
  } catch (_err) {
    value = btn.dataset.copyJson || '';
  }
  value = String(value || '').trim();
  if (!value) return;
  const defaultTitle = btn.title || '';
  navigator.clipboard.writeText(value).then(() => {
    btn.classList.add('is-copied');
    btn.title = 'Copied!';
    window.setTimeout(() => {
      btn.classList.remove('is-copied');
      btn.title = defaultTitle;
    }, 1200);
  }).catch(() => {
    btn.classList.add('is-copy-error');
    btn.title = 'Copy failed';
    window.setTimeout(() => {
      btn.classList.remove('is-copy-error');
      btn.title = defaultTitle;
    }, 1200);
  });
}

function soBomQtyPerFg(qtyParent, qtyFg) {
  const parent = Number(qtyParent);
  const fg = Number(qtyFg);
  if (!Number.isFinite(parent) || parent <= 0) return null;
  if (!Number.isFinite(fg) || fg <= 0) return parent;
  if (Math.abs(parent - fg) < 1e-9) return parent;
  return parent / fg;
}

function soFormatMaterialQtyPerFg(row) {
  const fromApi = Number(row.qty_per_fg);
  if (Number.isFinite(fromApi) && fromApi > 0) {
    return Number.isInteger(fromApi) ? String(fromApi) : fromApi.toFixed(4).replace(/\.?0+$/, '');
  }
  const perFg = soBomQtyPerFg(row.qty_parent, row.qty_fg);
  if (perFg == null) return '—';
  return Number.isInteger(perFg) ? String(perFg) : perFg.toFixed(4).replace(/\.?0+$/, '');
}

function soFormatInvNum(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  if (Math.abs(n) < 0.0001 && n !== 0) return String(value);
  if (Number.isInteger(n)) return String(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function soInvQtyCell(value) {
  const n = Number(value);
  const cls = Number.isFinite(n) && n > 0 ? ' inv-enq-qty--pos' : '';
  return `<td class="new-orders-num${cls}">${escapeHtml(soFormatInvNum(value))}</td>`;
}

function soInventoryMatchesBomCode(bomCode, invRows) {
  const bom = String(bomCode || '').trim();
  if (!bom) return [];
  const matches = (invRows || []).filter(row => {
    const matchedBom = String(row.matched_bom_material_code || '').trim();
    if (matchedBom && matchedBom === bom) return true;
    const inv = String(row.inventory_code || '').trim();
    return inv === bom || inv.startsWith(`${bom}_`);
  });
  return matches.sort((a, b) => {
    const ac = String(a.inventory_code || '');
    const bc = String(b.inventory_code || '');
    if (ac === bom && bc !== bom) return -1;
    if (bc === bom && ac !== bom) return 1;
    return ac.localeCompare(bc, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function soRenderMaterialModalInventoryDataRow(bomCode, row, { showBomCell = true, rowSpan = 1 } = {}) {
  const invCode = String(row.inventory_code || '').trim();
  const bom = String(bomCode || '').trim();
  const isVariant = invCode && bom && invCode !== bom;
  const desc = String(row.main_desc || '').trim();
  const variantBadge = isVariant
    ? '<span class="so-material-modal-match-pill" title="Matched from BOM material header with dimension suffix">variant</span>'
    : '';
  const bomCell = showBomCell
    ? `<td class="new-orders-mono so-material-modal-bom-ref"${rowSpan > 1 ? ` rowspan="${rowSpan}"` : ''}>${escapeHtml(bom)}</td>`
    : '';
  return `
    <tr${isVariant ? ' class="so-material-modal-inv-variant"' : ''}>
      ${bomCell}
      <td class="new-orders-mono">
        <span class="so-material-modal-inv-code">${escapeHtml(invCode || bom)}${variantBadge}</span>
      </td>
      <td class="so-material-modal-desc" title="${escapeHtml(desc)}">${escapeHtml(desc || '—')}</td>
      <td>${escapeHtml(String(row.inventory_class_code || '—'))}</td>
      <td>${escapeHtml(String(row.inventory_category_code || '—'))}</td>
      <td>${escapeHtml(String(row.uom_code || '—'))}</td>
      ${soInvQtyCell(row.total_qoh_available)}
      ${soInvQtyCell(row.total_qty_on_hand)}
      ${soInvQtyCell(row.total_qty_on_order)}
      ${soInvQtyCell(row.total_allocated_in_sq)}
      ${soInvQtyCell(row.total_unallocated_qty)}
      ${soInvQtyCell(row.total_free_balance_qty)}
      ${soInvQtyCell(row.total_qty_back_order)}
    </tr>
  `;
}

function soRenderMaterialModalInventoryTable(bomRows, invRows) {
  const codes = soBomMaterialCodes(bomRows);
  if (!codes.length) {
    return '';
  }
  const bodyParts = [];
  codes.forEach(bomCode => {
    const matches = soInventoryMatchesBomCode(bomCode, invRows);
    if (!matches.length) {
      bodyParts.push(`
        <tr class="so-material-modal-inv-missing">
          <td class="new-orders-mono so-material-modal-bom-ref">${escapeHtml(bomCode)}</td>
          <td class="new-orders-mono">${escapeHtml(bomCode)}</td>
          <td colspan="11" class="so-material-modal-inv-missing-note">Not found in inventory enquiry (exact or dimension suffix)</td>
        </tr>
      `);
      return;
    }
    matches.forEach((row, idx) => {
      bodyParts.push(soRenderMaterialModalInventoryDataRow(bomCode, row, {
        showBomCell: idx === 0,
        rowSpan: matches.length,
      }));
    });
  });
  return `
    <section class="so-material-modal-section">
      <h3 class="so-material-modal-section-title">Inventory enquiry</h3>
      <p class="so-material-modal-section-hint">Live stock for each BOM material. Dimension variants (e.g. <code>NITRONIC 50(HS)*3_D50.8_39.1</code>) are matched when they share the same BOM header.</p>
      <div class="so-material-modal-table-wrap so-material-modal-table-wrap--wide">
        <table class="so-material-modal-table so-material-modal-table--inventory">
          <thead>
            <tr>
              <th>BOM material</th>
              <th>Part no</th>
              <th>Description</th>
              <th>Class</th>
              <th>Cat</th>
              <th>UOM</th>
              <th>QOH avail</th>
              <th>On hand</th>
              <th>On order</th>
              <th>Alloc (SQ)</th>
              <th>Unalloc</th>
              <th>Free bal</th>
              <th>Back order</th>
            </tr>
          </thead>
          <tbody>${bodyParts.join('')}</tbody>
        </table>
      </div>
    </section>
  `;
}

function soBomMaterialCodes(bomRows) {
  return [...new Set(
    (bomRows || [])
      .map(row => String(row.material_inventory_code || '').trim())
      .filter(Boolean),
  )];
}

function soShouldShowBomRouteColumn(bomRows, meta) {
  const mode = String(meta?.match_mode || '').trim();
  if (mode && mode !== 'exact') return true;
  const codes = new Set(
    (bomRows || []).map(row => String(row.bom_code || '').trim()).filter(Boolean),
  );
  return codes.size > 1;
}

function soRenderMaterialModalNotice(meta) {
  const text = String(meta?.notice || '').trim();
  if (!text) return '';
  const mode = String(meta?.match_mode || '');
  const cls = mode === 'not_found'
    ? ' so-material-modal-notice--warn'
    : ' so-material-modal-notice--info';
  return `<div class="so-material-modal-notice${cls}">${escapeHtml(text)}</div>`;
}

function soRenderMaterialModalBomTable(rows, meta = null) {
  if (!Array.isArray(rows) || !rows.length) {
    return '<p class="so-material-modal-empty">No BOM materials found for this part and route.</p>';
  }
  const showRoute = soShouldShowBomRouteColumn(rows, meta);
  const body = rows.map(row => `
    <tr>
      ${showRoute ? `<td class="new-orders-mono">${escapeHtml(String(row.bom_code || '—'))}</td>` : ''}
      <td class="new-orders-mono">${soCopyableCell(row.material_inventory_code, 'material name')}</td>
      <td>${escapeHtml(row.description || '—')}</td>
      <td class="new-orders-num">${escapeHtml(soFormatMaterialQtyPerFg(row))}</td>
      <td>${escapeHtml(row.uom_code || '—')}</td>
    </tr>
  `).join('');
  return `
    <section class="so-material-modal-section">
      <h3 class="so-material-modal-section-title">BOM materials</h3>
      <div class="so-material-modal-table-wrap">
        <table class="so-material-modal-table">
          <thead>
            <tr>
              ${showRoute ? '<th>BOM route</th>' : ''}
              <th>Material</th>
              <th>Description</th>
              <th>Qty / FG</th>
              <th>UOM</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>
  `;
}

function soRenderMaterialModalContent(bomRows, invRows, meta = null) {
  return [
    soRenderMaterialModalNotice(meta),
    soRenderMaterialModalBomTable(bomRows, meta),
    soRenderMaterialModalInventoryTable(bomRows, invRows),
  ].join('');
}

function soRenderMaterialModalTable(rows) {
  return soRenderMaterialModalContent(rows, [], null);
}

function soParseBomMaterialsResponse(data) {
  if (Array.isArray(data)) {
    return { bomRows: data, meta: null };
  }
  if (data && Array.isArray(data.rows)) {
    return {
      bomRows: data.rows,
      meta: {
        requested_bom_code: data.requested_bom_code || '',
        resolved_bom_code: data.resolved_bom_code || '',
        match_mode: data.match_mode || '',
        alternate_bom_codes: data.alternate_bom_codes || [],
        notice: data.notice || '',
      },
    };
  }
  if (data?.error) {
    throw new Error(data.error);
  }
  return { bomRows: [], meta: null };
}

function soCloseMaterialModal() {
  const shell = document.getElementById('so-material-modal');
  if (!shell) return;
  shell.hidden = true;
  document.body.classList.remove('so-material-modal-open');
  const bodyEl = document.getElementById('so-material-modal-body');
  if (bodyEl) bodyEl.innerHTML = '';
  const titleEl = document.getElementById('so-material-modal-title');
  if (titleEl) titleEl.innerHTML = '';
}

function soOpenMaterialModal({ partNo, bomCode, processSheetNo } = {}) {
  const shell = document.getElementById('so-material-modal');
  const titleEl = document.getElementById('so-material-modal-title');
  const bodyEl = document.getElementById('so-material-modal-body');
  if (!shell || !titleEl || !bodyEl) return;

  const part = String(partNo || '').trim();
  const bom = String(bomCode || '').trim();
  const psNo = String(processSheetNo || '').trim();
  if (!part) return;

  titleEl.innerHTML = soRenderMaterialModalHeader(part, bom, psNo);
  bodyEl.innerHTML = '<div class="so-material-modal-loading"><div class="spinner"></div> Loading BOM materials and inventory…</div>';
  shell.hidden = false;
  document.body.classList.add('so-material-modal-open');

  const bomParams = new URLSearchParams({ source: part, fallback: '1' });
  if (bom) bomParams.set('bom', bom);

  fetch(`/api/bom/materials?${bomParams}`)
    .then(res => res.json().then(data => ({ ok: res.ok, data })))
    .then(async ({ ok, data }) => {
      if (!ok) throw new Error(data?.error || 'Failed to load BOM materials');
      const { bomRows, meta } = soParseBomMaterialsResponse(data);
      const codes = soBomMaterialCodes(bomRows);
      let invRows = [];
      if (codes.length) {
        const invParams = new URLSearchParams({ codes: codes.join(','), loose: '1' });
        const invRes = await fetch(`/api/inventory-enquiry?${invParams}`);
        const invData = await invRes.json();
        if (!invRes.ok || invData?.error) {
          throw new Error(invData?.error || 'Failed to load inventory enquiry');
        }
        invRows = Array.isArray(invData.rows) ? invData.rows : [];
      }
      bodyEl.innerHTML = soRenderMaterialModalContent(bomRows, invRows, meta);
    })
    .catch(err => {
      bodyEl.innerHTML = `<p class="so-material-modal-error">Could not load materials: ${escapeHtml(err.message || 'Unknown error')}</p>`;
    });
}

function soBindMaterialModal() {
  const shell = document.getElementById('so-material-modal');
  if (!shell || shell.dataset.bound === '1') return;
  shell.dataset.bound = '1';

  shell.querySelector('[data-action="close-material-modal"]')?.addEventListener('click', soCloseMaterialModal);
  document.getElementById('so-material-modal-close')?.addEventListener('click', soCloseMaterialModal);
  shell.addEventListener('click', e => {
    const btn = e.target.closest('[data-action="copy-text"]');
    if (!btn || !shell.contains(btn)) return;
    e.stopPropagation();
    soCopyTextFromButton(btn);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !shell.hidden) soCloseMaterialModal();
  });
}

function soRenderOrderDateCell(pp) {
  return `<td class="new-orders-date">${escapeHtml(soFormatDate(pp.order_date))}</td>`;
}

function soRenderQtyCell(pp) {
  return `<td class="new-orders-num so-qty-cell">${escapeHtml(String(pp?.pp_qty ?? '—'))}</td>`;
}

function soRenderPpCells(pp) {
  return `
    <td class="new-orders-desc" title="${escapeHtml(String(pp.description || ''))}">${escapeHtml(String(pp.description || '—'))}</td>
    <td class="new-orders-mono">${escapeHtml(String(pp.customer_po_no || '—'))}</td>
    <td class="new-orders-date">${escapeHtml(soFormatDate(pp.due_date))}</td>
    <td class="new-orders-date">${escapeHtml(soFormatDate(pp.delivery_date))}</td>
    <td class="new-orders-num">${escapeHtml(soFormatMoney(pp.unit_selling_price))}</td>
    <td class="new-orders-num">${escapeHtml(soFormatMoney(pp.amount))}</td>
    ${soRenderMaterialSubconCell(pp)}
    ${SO_NOTE_FIELDS.filter(field => field !== 'material_subcon').map(field => soRenderEditableCell(pp, field)).join('')}
  `;
}

function soRenderMaterialSubconCell(pp) {
  const ppNo = String(pp.pp_voucher_no || '').trim();
  const raw = String(pp.material_subcon || '');
  const parsed = soParseMaterialSubcon(raw);
  const arrivedCls = parsed.arrived ? ' is-active' : '';
  const dateHiddenCls = parsed.arrived ? ' is-hidden' : '';
  const legacyHtml = parsed.legacy
    ? `<span class="so-material-subcon-legacy" title="Previous note">${escapeHtml(parsed.legacy)}</span>`
    : '';
  return `
    <td class="so-material-subcon-cell" data-pp-voucher-no="${escapeHtml(ppNo)}" data-last-saved="${escapeHtml(raw)}">
      <div class="so-material-subcon-controls">
        <button type="button"
          class="so-material-subcon-arrived${arrivedCls}"
          data-action="toggle-subcon-arrived"
          aria-pressed="${parsed.arrived ? 'true' : 'false'}"
          title="${parsed.arrived ? 'Material arrived — click to clear (updates planner)' : 'Mark material as arrived (updates planner)'}">
          <span class="so-material-subcon-arrived-dot" aria-hidden="true"></span>
          Arrived
        </button>
        <input type="date"
          class="so-material-subcon-date${dateHiddenCls}"
          value="${escapeHtml(parsed.date)}"
          ${parsed.arrived ? 'disabled' : ''}
          aria-label="Material/Sub-con expected date">
        ${legacyHtml}
      </div>
      <span class="so-editable-status" aria-live="polite"></span>
    </td>
  `;
}

function soRenderEditableCell(pp, field) {
  const ppNo = String(pp.pp_voucher_no || '').trim();
  const value = String(pp[field] || '');
  const label = SO_NOTE_LABELS[field] || field;
  return `
    <td class="so-editable-cell">
      <textarea
        class="so-editable-input"
        rows="1"
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

function soPartialNo(partial) {
  const n = Number(partial?.pp_partial_no);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function soIsPartialException(pp, partial) {
  const partials = Array.isArray(pp?.highlighted_partials) ? pp.highlighted_partials : [];
  return partials.includes(soPartialNo(partial));
}

function soSetPartialException(pp, partialNo, on) {
  if (!pp) return;
  const set = new Set(Array.isArray(pp.highlighted_partials) ? pp.highlighted_partials : []);
  if (on) set.add(partialNo);
  else set.delete(partialNo);
  const sorted = [...set].sort((a, b) => a - b);
  pp.highlighted_partials = sorted;
  pp.ps_highlighted = sorted.length > 0;
}

function soSyncExceptionRow(row, flagged) {
  if (!row) return;
  row.classList.toggle('is-so-exception', Boolean(flagged));
  const cell = row.querySelector('.so-exception-cell');
  const input = cell?.querySelector('.so-exception-input');
  const label = cell?.querySelector('.so-exception-flag');
  if (input) input.checked = Boolean(flagged);
  if (label) {
    label.classList.toggle('is-active', Boolean(flagged));
    label.setAttribute('aria-pressed', flagged ? 'true' : 'false');
    label.title = flagged ? 'Exception raised — click to clear' : 'Raise exception for this line';
  }
}

function soRenderExceptionCell(pp, partial) {
  const ppNo = String(pp?.pp_voucher_no || '').trim();
  const partialNo = soPartialNo(partial);
  const flagged = soIsPartialException(pp, partial);
  return `
    <td class="so-exception-cell">
      <label class="so-exception-flag${flagged ? ' is-active' : ''}"
        title="${flagged ? 'Exception raised — click to clear' : 'Raise exception for this line'}"
        aria-pressed="${flagged ? 'true' : 'false'}"
        aria-label="${flagged ? 'Exception raised' : 'Raise exception'}">
        <input type="checkbox"
          class="so-exception-input"
          data-pp-voucher-no="${escapeHtml(ppNo)}"
          data-partial-no="${partialNo}"
          ${flagged ? 'checked' : ''}
          tabindex="-1"
          aria-hidden="true">
        <span class="so-exception-mark" aria-hidden="true">!</span>
      </label>
      <span class="so-exception-status" aria-live="polite"></span>
    </td>
  `;
}

function soRenderPartialCell(partial) {
  return `<td class="new-orders-num so-partial-cell">${escapeHtml(String(partial?.pp_partial_no ?? '—'))}</td>`;
}

function soRenderPartCell(pp, partial) {
  const part = partial?.inventory_code || pp?.inventory_code || '—';
  return `<td class="new-orders-num so-part-cell">${escapeHtml(String(part))}</td>`;
}

function soRenderLeafRow(leaf, { includeSideRail, sideRowSpan, groupStart, shadeAlt }) {
  const { order, pp, partial } = leaf;
  const key = soPartialKey(order, pp, partial);
  const selected = key === soState.selectedKey;
  const sideRail = includeSideRail ? soRenderSideRail(order, sideRowSpan, { shadeAlt }) : '';
  const processSheetCell = soRenderProcessSheetCell(order, pp, partial);
  const orderDateCell = soRenderOrderDateCell(pp);
  const startClass = groupStart ? ' new-orders-group-start' : '';
  const queuedMark = soIsPartialQueued(pp, partial) ? ' is-ps-queued-mark' : '';
  const exceptionMark = soIsPartialException(pp, partial) ? ' is-so-exception' : '';
  return `
    <tr class="new-orders-child-row is-clickable${startClass}${queuedMark}${exceptionMark}${selected ? ' is-selected' : ''}" data-sales-order="${escapeHtml(String(order.sales_order_no || ''))}" data-detail-key="${escapeHtml(key)}" title="Click for detail">
      ${sideRail}
      ${processSheetCell}
      ${soRenderPartialCell(partial)}
      ${soRenderExceptionCell(pp, partial)}
      ${soRenderQueuedCncCell(pp, partial)}
      ${soRenderStageCell(pp, partial)}
      ${soRenderQtyCell(pp)}
      ${orderDateCell}
      ${soRenderPartCell(pp, partial)}
      ${soRenderPpCells(pp)}
    </tr>
  `;
}

function soRenderOrderGroup(order, soGroupIndex = 0) {
  const soNo = String(order.sales_order_no || '').trim();
  const collapsed = soState.collapsedGroups.has(soNo);
  const leaves = soVisibleLeaves(order);
  const colSpan = SO_COLUMNS.filter(col => !col.side).length;
  const shadeAlt = soGroupIndex % 2 === 1;

  if (!leaves.length) return '';

  if (collapsed) {
    const label = `${leaves.length} row(s) hidden`;
    return `
      <tr class="new-orders-group-row is-clickable" data-sales-order="${escapeHtml(soNo)}" title="Click for order detail">
        ${soRenderSideRail(order, 1, { shadeAlt })}
        <td colspan="${colSpan}" class="new-orders-collapsed-summary">${escapeHtml(label)} — expand to view</td>
      </tr>
    `;
  }

  const html = [];
  leaves.forEach((leaf, leafIndex) => {
    html.push(soRenderLeafRow(leaf, {
      includeSideRail: leafIndex === 0,
      sideRowSpan: leaves.length,
      groupStart: leafIndex === 0,
      shadeAlt,
    }));
  });
  return html.join('');
}

function soSetSaveStatus(control, state, message) {
  const status = control?.closest('.so-editable-cell, .so-material-subcon-cell')?.querySelector('.so-editable-status');
  if (!status) return;
  status.className = `so-editable-status${state ? ` is-${state}` : ''}`;
  status.textContent = message || '';
}

function soSyncMaterialSubconCell(cell, raw) {
  if (!cell) return;
  const parsed = soParseMaterialSubcon(raw);
  cell.dataset.lastSaved = String(raw || '');
  const btn = cell.querySelector('.so-material-subcon-arrived');
  const dateInput = cell.querySelector('.so-material-subcon-date');
  if (btn) {
    btn.classList.toggle('is-active', parsed.arrived);
    btn.setAttribute('aria-pressed', parsed.arrived ? 'true' : 'false');
    btn.title = parsed.arrived ? 'Material arrived — click to clear' : 'Mark material as arrived';
  }
  if (dateInput) {
    dateInput.value = parsed.date || '';
    dateInput.disabled = parsed.arrived;
    dateInput.classList.toggle('is-hidden', parsed.arrived);
  }
  const controls = cell.querySelector('.so-material-subcon-controls');
  let legacyEl = cell.querySelector('.so-material-subcon-legacy');
  if (parsed.legacy) {
    if (!legacyEl && controls) {
      legacyEl = document.createElement('span');
      legacyEl.className = 'so-material-subcon-legacy';
      legacyEl.title = 'Previous note';
      controls.appendChild(legacyEl);
    }
    if (legacyEl) legacyEl.textContent = parsed.legacy;
  } else if (legacyEl) {
    legacyEl.remove();
  }
}

async function soSaveMaterialSubconCell(cell, nextValue) {
  const ppNo = String(cell?.dataset?.ppVoucherNo || '').trim();
  if (!ppNo || !cell) return;

  const key = `${ppNo}::material_subcon`;
  if (soState.saveInFlight.has(key)) return;

  const savedValue = String(nextValue || '').trim();
  const lastSaved = String(cell.dataset.lastSaved || '').trim();
  if (savedValue === lastSaved) return;

  soState.saveInFlight.add(key);
  soSetSaveStatus(cell, 'saving', 'Saving…');
  try {
    const data = await soPostJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, {
      material_subcon: savedValue,
    });
    const saved = String(data.material_subcon || '').trim();
    soSyncMaterialSubconCell(cell, saved);
    const found = soFindPp(ppNo);
    if (found.pp) {
      found.pp.material_subcon = saved;
      if (Object.prototype.hasOwnProperty.call(data, 'material_in')) {
        found.pp.material_in = Boolean(data.material_in);
        found.pp.material_in_date = data.material_in_date || null;
      } else {
        const parsed = soParseMaterialSubcon(saved);
        found.pp.material_in = parsed.arrived;
        if (!parsed.arrived) found.pp.material_in_date = null;
      }
    }
    soSetSaveStatus(cell, 'saved', 'Saved');
    window.setTimeout(() => {
      if (String(cell.dataset.lastSaved || '').trim() === saved) soSetSaveStatus(cell, '', '');
    }, 1500);
  } catch (err) {
    soSyncMaterialSubconCell(cell, lastSaved);
    soSetSaveStatus(cell, 'error', err.message || 'Save failed');
  } finally {
    soState.saveInFlight.delete(key);
  }
}

async function soSaveField(control) {
  const ppNo = String(control.dataset.ppVoucherNo || '').trim();
  const field = String(control.dataset.field || '').trim();
  if (!ppNo || !field) return;

  const key = `${ppNo}::${field}`;
  if (soState.saveInFlight.has(key)) return;

  const nextValue = String(control.value || '').trim();
  const lastSaved = String(control.dataset.lastSaved || '');
  if (nextValue === lastSaved) return;

  soState.saveInFlight.add(key);
  soSetSaveStatus(control, 'saving', 'Saving…');
  try {
    const data = await soPostJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, {
      [field]: nextValue,
    });
    const saved = String(data[field] || '').trim();
    control.value = saved;
    control.dataset.lastSaved = saved;
    const found = soFindPp(ppNo);
    if (found.pp) found.pp[field] = saved;
    soSetSaveStatus(control, 'saved', 'Saved');
    window.setTimeout(() => {
      if (control.dataset.lastSaved === saved) soSetSaveStatus(control, '', '');
    }, 1500);
  } catch (err) {
    control.value = lastSaved;
    soSetSaveStatus(control, 'error', err.message || 'Save failed');
  } finally {
    soState.saveInFlight.delete(key);
  }
}

function soSetExceptionStatus(control, state, message) {
  const status = control?.closest('.so-exception-cell')?.querySelector('.so-exception-status');
  if (!status) return;
  status.className = `so-exception-status${state ? ` is-${state}` : ''}`;
  status.textContent = message || '';
}

async function soSaveExceptionFlag(input) {
  const ppNo = String(input?.dataset?.ppVoucherNo || '').trim();
  const partialNo = Math.max(1, Number(input?.dataset?.partialNo) || 1);
  if (!ppNo || input.disabled) return;

  const flagged = Boolean(input.checked);
  const row = input.closest('tr');
  const label = input.closest('.so-exception-flag');
  const found = soFindPp(ppNo);
  const previous = found?.pp ? soIsPartialException(found.pp, { pp_partial_no: partialNo }) : false;

  soSyncExceptionRow(row, flagged);
  input.disabled = true;
  if (label) label.classList.add('is-saving');
  soSetExceptionStatus(input, 'saving', 'Saving…');
  try {
    const data = await soPostJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, {
      partial_highlight: {
        pp_partial_no: partialNo,
        highlighted: flagged,
      },
    });
    if (found?.pp) {
      found.pp.highlighted_partials = Array.isArray(data.highlighted_partials)
        ? data.highlighted_partials
        : [];
      found.pp.ps_highlighted = Boolean(data.ps_highlighted);
    }
    const saved = Array.isArray(data.highlighted_partials)
      ? data.highlighted_partials.includes(partialNo)
      : flagged;
    soSyncExceptionRow(row, saved);
    soSetExceptionStatus(input, 'saved', saved ? 'Flagged' : 'Cleared');
    window.setTimeout(() => soSetExceptionStatus(input, '', ''), 1500);
  } catch (err) {
    if (found?.pp) soSetPartialException(found.pp, partialNo, previous);
    soSyncExceptionRow(row, previous);
    soSetExceptionStatus(input, 'error', err.message || 'Save failed');
  } finally {
    input.disabled = false;
    if (label) label.classList.remove('is-saving');
  }
}

function soBindExceptionFlags() {
  const body = document.getElementById('so-table-body');
  if (!body || body.dataset.exceptionBound === '1') return;
  body.dataset.exceptionBound = '1';

  body.addEventListener('change', e => {
    const input = e.target.closest('.so-exception-input');
    if (!input) return;
    e.stopPropagation();
    soSaveExceptionFlag(input);
  });

  body.addEventListener('click', e => {
    const flag = e.target.closest('.so-exception-flag');
    if (!flag) return;
    e.stopPropagation();
  });
}

function soBindMaterialSubconInputs() {
  const body = document.getElementById('so-table-body');
  if (!body || body.dataset.subconBound === '1') return;
  body.dataset.subconBound = '1';

  body.addEventListener('click', e => {
    const btn = e.target.closest('[data-action="toggle-subcon-arrived"]');
    if (!btn) return;
    e.stopPropagation();
    const cell = btn.closest('.so-material-subcon-cell');
    if (!cell) return;
    const parsed = soParseMaterialSubcon(cell.dataset.lastSaved);
    const nextArrived = !parsed.arrived;
    const dateInput = cell.querySelector('.so-material-subcon-date');
    const date = nextArrived ? '' : String(dateInput?.value || '').trim();
    soSaveMaterialSubconCell(cell, soSerializeMaterialSubcon({ arrived: nextArrived, date }));
  });

  body.addEventListener('change', e => {
    const dateInput = e.target.closest('.so-material-subcon-date');
    if (!dateInput || dateInput.disabled) return;
    e.stopPropagation();
    const cell = dateInput.closest('.so-material-subcon-cell');
    if (!cell) return;
    soSaveMaterialSubconCell(cell, soSerializeMaterialSubcon({
      arrived: false,
      date: dateInput.value,
    }));
  });
}

function soBindEditableInputs() {
  const body = document.getElementById('so-table-body');
  if (!body || body.dataset.editableBound === '1') return;
  body.dataset.editableBound = '1';

  body.addEventListener('input', e => {
    const textarea = e.target.closest('.so-editable-input');
    if (!textarea) return;
    e.stopPropagation();
  });

  body.addEventListener('blur', e => {
    const textarea = e.target.closest('.so-editable-input');
    if (!textarea) return;
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

function soBucketJobCount(orders) {
  return (orders || []).reduce((sum, order) => sum + (order.pp_vouchers?.length || 0), 0);
}

/** Job count for tab badges — respects the PP prefix filter (APS/NPS default). */
function soFilteredJobCount(orders) {
  let count = 0;
  (orders || []).forEach(order => {
    (order.pp_vouchers || []).forEach(pp => {
      if (soLeafPassesPrefixFilter(pp)) count += 1;
    });
  });
  return count;
}

function soUpdateTabCounts() {
  const activeEl = document.getElementById('so-active-tab-count');
  const completeEl = document.getElementById('so-complete-tab-count');
  const activeJobs = soFilteredJobCount(soState.active);
  const completeJobs = soFilteredJobCount(soState.complete);
  if (activeEl) {
    activeEl.textContent = String(activeJobs);
    activeEl.hidden = activeJobs === 0;
  }
  if (completeEl) {
    completeEl.textContent = String(completeJobs);
    completeEl.hidden = completeJobs === 0;
  }
}

function soSetView(view) {
  const next = view === 'complete' ? 'complete' : 'active';
  soState.view = next;
  soCloseDetail();
  soCloseMaterialModal();
  document.querySelectorAll('[data-so-view]').forEach(btn => {
    const active = btn.getAttribute('data-so-view') === next;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  soRender();
}

function soUpdateStats() {
  const el = document.getElementById('so-stats-chips');
  if (!el) return;
  const orders = soVisibleOrders(soActiveOrders());
  let leafCount = 0;
  orders.forEach(order => {
    leafCount += soVisibleLeaves(order).length;
  });
  const activeN = soVisibleOrders(soState.active).length;
  const completeN = soVisibleOrders(soState.complete).length;
  const viewLabel = soState.view === 'complete' ? 'Complete' : 'Active';
  const { typeCounts, ppCount } = soVisibleTypeCounts();
  const hasLoaded = (soState.active?.length || 0) + (soState.complete?.length || 0) > 0;
  if (!hasLoaded) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = [
    `<span class="so-header-pill"><strong>${orders.length}</strong> ${escapeHtml(viewLabel)} S/O</span>`,
    `<span class="so-header-pill"><strong>${leafCount}</strong> rows</span>`,
    `<span class="so-header-pill"><strong>${ppCount}</strong> PP</span>`,
    soTypeTagsHtml(typeCounts),
    `<span class="so-header-pill so-header-pill--muted"><strong>${activeN}</strong> active · <strong>${completeN}</strong> complete</span>`,
  ].join('');
}

function soRender() {
  soRenderTableHead();
  const orders = soVisibleOrders(soActiveOrders());
  const body = document.getElementById('so-table-body');
  const host = soTableHost();
  const wrap = document.getElementById('so-table-wrap');
  const empty = document.getElementById('so-empty');
  const emptyText = document.getElementById('so-empty-text');
  const loading = document.getElementById('so-loading');
  const meta = document.getElementById('so-meta');

  if (loading) loading.hidden = true;

  const hasData = (soState.active?.length || 0) + (soState.complete?.length || 0) > 0;

  if (!orders.length) {
    const emptyMsg = !hasData
      ? `No ${soState.view === 'complete' ? 'complete' : 'active'} sales orders in ERP.`
      : (soState.ppTypes.size === 0
        ? 'Select at least one PP prefix (APS, NPS, …).'
        : 'No rows match your search or column filters — adjust filters in the column headers above.');
    if (hasData) {
      if (host) host.hidden = false;
      if (empty) empty.hidden = true;
      if (body) {
        body.innerHTML = `
          <tr class="so-table-empty-row">
            <td colspan="${SO_COLUMNS.length}">${escapeHtml(emptyMsg)}</td>
          </tr>
        `;
      }
    } else {
      if (body) body.innerHTML = '';
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        if (emptyText) emptyText.textContent = emptyMsg;
      }
    }
    if (meta) meta.hidden = !hasData;
    soUpdateStats();
    soUpdateTabCounts();
    soRepositionColumnFilter();
    soSyncTableScrollWidth();
    return;
  }

  if (host) host.hidden = false;
  if (empty) empty.hidden = true;
  if (body) {
    body.innerHTML = orders.map((order, idx) => soRenderOrderGroup(order, idx)).filter(Boolean).join('');
    delete body.dataset.editableBound;
    delete body.dataset.exceptionBound;
    soBindEditableInputs();
    soBindExceptionFlags();
  }
  if (meta) {
    meta.hidden = false;
    const missing = Number(soState.missingHeaderCount) || 0;
    const missingNote = missing > 0 ? ` · ${missing} without so_order_view header` : '';
    meta.textContent = `Planner notes autosave on blur · per PP voucher in Supabase · Click a row for detail · ${soState.ppCount || 0} PP · ${soState.partialCount || 0} partials · cached ${soState.cachedAt || '—'} · TTL ${soState.cacheTtlSec}s${missingNote}`;
  }

  soUpdateStats();
  soUpdateTabCounts();
  soRepositionColumnFilter();
  soSyncTableScrollWidth();
}

async function soLoad({ refresh = false, bustCache = false } = {}) {
  const loading = document.getElementById('so-loading');
  const host = soTableHost();
  if (loading) loading.hidden = false;
  if (host) host.hidden = true;
  soCloseDetail();
  soCloseMaterialModal();

  const params = new URLSearchParams();
  if (refresh) params.set('refresh', '1');
  if (bustCache) params.set('_ts', String(Date.now()));

  let payload;
  try {
    const [ordersRes, repeatRes] = await Promise.all([
      fetch(`/api/sales-orders?${params}`),
      fetch('/api/planning-data/repeat-orders'),
    ]);
    const raw = await ordersRes.text();
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(
        ordersRes.ok
          ? 'Server returned invalid JSON — restart Flask and refresh.'
          : `Server error (HTTP ${ordersRes.status}) — restart Flask and refresh.`,
      );
    }
    if (!ordersRes.ok) throw new Error(payload?.error || `HTTP ${ordersRes.status}`);
    if (repeatRes.ok) {
      const repeatPayload = await repeatRes.json();
      soState.repeatGroups = Array.isArray(repeatPayload.rows) ? repeatPayload.rows : [];
    } else {
      soState.repeatGroups = [];
    }
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
  soState.activeJobCount = Number(payload.active_job_count) || soBucketJobCount(soState.active);
  soState.completeJobCount = Number(payload.complete_job_count) || soBucketJobCount(soState.complete);
  soState.ppCount = Number(payload.pp_count) || (soState.activeJobCount + soState.completeJobCount);
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

  document.getElementById('so-copy-no-wo-ps')?.addEventListener('click', soCopyNoWoProcessSheets);
  document.getElementById('so-refresh')?.addEventListener('click', () => soLoad({ refresh: true, bustCache: true }));
  soBindDetailPanel();
  soBindMaterialModal();
  soBindTableClicks();
  soBindTableScroll();
  soBindColumnControls();
  soBindMaterialSubconInputs();
  soBindExceptionFlags();
  soBindPsTypeDropdown();
  soRenderTableHead();

  window.addEventListener('pp-vouchers-synced', () => {
    soLoad({ refresh: true, bustCache: true });
  });

  soLoad({ refresh: false });
}

document.addEventListener('DOMContentLoaded', soInit);
