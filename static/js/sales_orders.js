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

function soEffectiveMaterialSubcon(pp) {
  return String(pp?.assembly_material_subcon || pp?.material_subcon || '');
}

function soMaterialSubconDisplay(raw) {
  const parsed = soParseMaterialSubcon(raw);
  if (parsed.arrived) return 'Arrived';
  if (parsed.date) return soFormatDate(parsed.date);
  if (parsed.legacy) return parsed.legacy;
  return '';
}

function soMaterialSubconTitle(pp) {
  const pending = Number(pp?.assembly_material_pending_child_count || 0);
  if (String(pp?.assembly_material_source || '') !== 'assembly_parts') return '';
  if (pending > 0) {
    return `Latest Assembly Parts Tracker child arrival (${pending} part${pending === 1 ? '' : 's'} still outstanding)`;
  }
  return 'All Assembly Parts Tracker children have arrived';
}

function soMaterialSubconSortValue(raw) {
  const parsed = soParseMaterialSubcon(raw);
  if (parsed.arrived) return '0-arrived';
  if (parsed.date) return `1-${parsed.date}`;
  if (parsed.legacy) return `2-${parsed.legacy.toLowerCase()}`;
  return '9-empty';
}

function soMaterialSubconHasDate(parsed) {
  return Boolean(parsed?.date) && !parsed?.arrived;
}

function soMaterialSubconCellClasses(parsed) {
  const parts = [];
  if (soMaterialSubconHasDate(parsed)) parts.push('has-material-date');
  if (parsed?.arrived) parts.push('has-material-arrived');
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function soApplyMaterialSubconCellState(cell, parsed) {
  if (!cell) return;
  cell.classList.toggle('has-material-date', soMaterialSubconHasDate(parsed));
  cell.classList.toggle('has-material-arrived', Boolean(parsed?.arrived));
}

const SO_EXCEPTION_ISSUES = [
  { id: 'supply_chain', label: 'Supply Chain' },
  { id: 'process_engr', label: 'Process / Engr' },
  { id: 'qlty', label: 'Qlty' },
  { id: 'sales', label: 'Sales' },
  { id: 'others', label: 'Others' },
];
const SO_EXCEPTION_ISSUE_IDS = new Set(SO_EXCEPTION_ISSUES.map(item => item.id));
const SO_EXCEPTION_ISSUE_ALIASES = {
  'supply chain': 'supply_chain',
  supply_chain: 'supply_chain',
  sc: 'supply_chain',
  'process / engr': 'process_engr',
  'process/engr': 'process_engr',
  process_engr: 'process_engr',
  process: 'process_engr',
  engr: 'process_engr',
  engineering: 'process_engr',
  qlty: 'qlty',
  quality: 'qlty',
  qa: 'qlty',
  qc: 'qlty',
  sales: 'sales',
  others: 'others',
  other: 'others',
  flagged: 'others',
  exception: 'others',
};

function soNormalizeExceptionIssue(raw) {
  const key = String(raw || '').trim().toLowerCase().replace(/-/g, '_').replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ');
  if (!key) return '';
  if (SO_EXCEPTION_ISSUE_IDS.has(key)) return key;
  return SO_EXCEPTION_ISSUE_ALIASES[key] || '';
}

function soExceptionIssueLabel(id) {
  const issue = soNormalizeExceptionIssue(id);
  return SO_EXCEPTION_ISSUES.find(item => item.id === issue)?.label || '';
}

function soNormalizeExceptionIssues(raw) {
  if (Array.isArray(raw)) {
    const seen = new Set();
    const out = [];
    raw.forEach(item => {
      const id = soNormalizeExceptionIssue(item);
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push(id);
    });
    return SO_EXCEPTION_ISSUES.map(item => item.id).filter(id => seen.has(id));
  }
  const single = soNormalizeExceptionIssue(raw);
  return single ? [single] : [];
}

function soExceptionIssuesLabel(ids) {
  return soNormalizeExceptionIssues(ids).map(soExceptionIssueLabel).filter(Boolean).join(', ');
}

const SO_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
const SO_STAGE_EXCLUDE_ALL_COMPLETE = 'all complete';

const SO_COLUMNS = [
  { id: '_so', label: 'SO', side: true, sortable: true, filterable: true },
  { id: 'process_sheet_no', label: 'Process sheet', sortable: true, filterable: true, filterType: 'prefix', stickyAfterSide: true },
  { id: 'partial', label: 'Partial', sortable: true, filterable: true },
  { id: 'partial_qty', label: 'Partial qty', sortable: true, filterable: true },
  { id: 'exception', label: 'Exception', sortable: true, filterable: true },
  { id: 'queued_cnc', label: 'Queued CNC', sortable: true, filterable: true },
  { id: 'proposed_cnc', label: 'Proposed CNC', sortable: true, filterable: true },
  { id: 'erp_stage', label: 'Stage', sortable: true, filterable: true },
  { id: 'qty', label: 'Qty', sortable: true, filterable: true },
  { id: 'order_date', label: 'Date', sortable: true, filterable: true },
  { id: 'part', label: 'Part', sortable: true, filterable: true },
  { id: 'description', label: 'Description', sortable: true, filterable: true },
  { id: 'due_date', label: 'Due date', sortable: true, filterable: true },
  { id: 'material_need_date', label: 'Need date', sortable: true, filterable: true, tone: 'need' },
  { id: 'material_subcon', label: 'Material in / Sub-con', sortable: true, filterable: true, tone: 'material' },
  { id: 'program_finish_at', label: 'Programme finish', sortable: true, filterable: true, tone: 'finish' },
  { id: 'proposed_edd', label: 'Prop. EDD', sortable: true, filterable: true, tone: 'edd' },
  { id: 'week', label: 'Week', sortable: true, filterable: true },
  { id: 'delivery_date', label: 'Delivered', sortable: true, filterable: true },
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
  completeLoaded: false,
  repeatGroups: [],
  view: 'active',
  search: '',
  cachedAt: '',
  cacheTtlSec: 300,
  ppCount: 0,
  partialCount: 0,
  missingHeaderCount: 0,
  activeJobCount: 0,
  completeJobCount: 0,
  collapsedGroups: new Set(),
  selectedKey: '',
  saveInFlight: new Set(),
  ppTypes: new Set(['APS', 'NPS']),
  sortCol: '',
  sortDir: 'asc',
  colFilters: {},
  colExcludeFilters: {},
  colEmptyFilters: {},
  openFilterCol: '',
  frameAgreementParts: new Set(),
  assemblyJobs: new Map(),
  cncMachines: [],
  openProposedCncPp: '',
  proposedCncQuery: '',
  openExceptionKey: '',
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

function soNormalizePartKey(partNo) {
  return String(partNo || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function soIsFrameAgreement(pp, partial) {
  if (partial?.is_frame_agreement || pp?.is_frame_agreement) return true;
  const code = soNormalizePartKey(partial?.inventory_code || pp?.inventory_code);
  return code && soState.frameAgreementParts.has(code);
}

function soRenderFrameAgreementBadge(pp, partial) {
  if (!soIsFrameAgreement(pp, partial)) return '';
  return '<span class="so-fa-badge" title="Frame agreement part">FA</span>';
}

function soRepeatRow(order, pp) {
  return {
    source_voucher_no: order?.sales_order_no,
    inventory_code: pp?.inventory_code,
    bom_code: pp?.bom_code,
    process_sheet_no: pp?.process_sheet_no,
    similar_ps: pp?.similar_ps,
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
  return repeatOrderRenderPill(soSimilarPsForPp(order, pp), {
    totalCount: pp?.similar_ps_count,
  });
}

function soIsNewPart(order, pp) {
  if (typeof pp?.is_new_part === 'boolean') return pp.is_new_part;
  if (Number(pp?.similar_ps_count) > 0) return false;
  const partNo = String(pp?.inventory_code || '').trim();
  if (!partNo) return false;
  return soSimilarPsForPp(order, pp).length === 0;
}

function soRenderNewPartBadge(order, pp) {
  if (!soIsNewPart(order, pp)) return '';
  return '<span class="so-new-part-badge" title="New part — no prior process sheet history">NEW</span>';
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
  return typeof trialFormatDate === 'function' ? trialFormatDate(value) : String(value || '—');
}

function soProposedEddDisplay(pp, partial) {
  return String(partial?.coway_proposed_edd || pp?.coway_proposed_edd || '').trim();
}

function soProgramFinishDisplay(pp) {
  return soDateInputValue(pp?.program_finish_at);
}

const SO_WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function soDateInputValue(value) {
  const text = String(value == null ? '' : value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return soParseMaterialSubcon(text).date || '';
}

function soParseDateOnly(value) {
  const text = soDateInputValue(value);
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** Prop. EDD if set, else PO due date — same commitment rule as Delivery Schedule. */
function soCommitmentDate(pp, partial) {
  return soDateInputValue(soProposedEddDisplay(pp, partial))
    || soDateInputValue(pp?.due_date);
}

function soIsoWeekNo(value) {
  const date = soParseDateOnly(value);
  if (!date) return null;
  const dayNum = date.getUTCDay() || 7;
  const thursday = new Date(date);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
}

function soWeekdayName(value) {
  const date = soParseDateOnly(value);
  if (!date) return '';
  return SO_WEEKDAY_NAMES[date.getUTCDay()] || '';
}

function soWeekLabel(pp, partial) {
  const commitment = soCommitmentDate(pp, partial);
  const weekNo = soIsoWeekNo(commitment);
  if (!weekNo) return '—';
  const weekday = soWeekdayName(commitment);
  if (!weekday) return `Week ${weekNo}`;
  return `Week ${weekNo} - ${weekday}`;
}

function soFormatMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function soFormatQty(value) {
  if (value == null || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return Number.isInteger(num)
    ? String(num)
    : num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function soPartialQtyValue(pp, partial) {
  const raw = partial?.partial_qty;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  const fallback = Number(pp?.pp_qty);
  return Number.isFinite(fallback) ? fallback : null;
}

function soFormatDt(value) {
  return typeof trialFormatDt === 'function' ? trialFormatDt(value) : String(value || '—');
}

function soIsReposted(order) {
  const first = String(order?.first_posted_datetime || '').trim();
  const latest = String(order?.latest_posted_datetime || '').trim();
  return Boolean(first && latest && first !== latest);
}

function soWorkingWeekRange(offsetWeeks = 0) {
  const anchor = new Date();
  const weekday = anchor.getDay();
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  const monday = new Date(anchor);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(anchor.getDate() + diffToMonday + offsetWeeks * 7);
  const saturday = new Date(monday);
  saturday.setDate(monday.getDate() + 5);
  saturday.setHours(23, 59, 59, 999);
  return { from: monday, to: saturday };
}

function soParseOrderDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const d = new Date(text.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function soIsNewOrder(order) {
  const posted = soParseOrderDate(order?.first_posted_datetime);
  if (!posted) return false;
  const { from, to } = soWorkingWeekRange();
  return posted >= from && posted <= to;
}

function soRenderNewOrderBadge(order) {
  if (!soIsNewOrder(order)) return '';
  return '<span class="so-new-order-badge" title="First posted this working week (Mon–Sat)">New</span>';
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
  const displayPp = ppNo.includes('#fg') ? psNo : ppNo;
  if (psNo && displayPp && psNo !== displayPp) return `${displayPp} · ${psNo}`;
  return psNo || displayPp || '—';
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
  if (Array.isArray(partial?.queued_machines) && partial.queued_machines.length) {
    return partial.queued_machines.filter(Boolean);
  }
  const pno = String(soPartialNo(partial));
  const byPartial = pp?.queued_machines_by_partial;
  if (byPartial && Array.isArray(byPartial[pno]) && byPartial[pno].length) {
    return byPartial[pno].filter(Boolean);
  }
  const fromList = (pp?.partials || []).find(row => String(soPartialNo(row)) === pno);
  if (Array.isArray(fromList?.queued_machines) && fromList.queued_machines.length) {
    return fromList.queued_machines.filter(Boolean);
  }
  if (pno === '1' && Array.isArray(pp?.queued_machines)) return pp.queued_machines.filter(Boolean);
  return [];
}

function soQueuedMachinesLabel(pp, partial) {
  const machines = partial ? soPartialQueuedMachines(pp, partial) : (pp?.queued_machines || []);
  return machines.length ? machines.join(', ') : '—';
}

function soProposedCncMachines(pp, partial) {
  if (partial && Array.isArray(partial.proposed_cnc)) {
    return partial.proposed_cnc.filter(Boolean);
  }
  if (Array.isArray(pp?.proposed_cnc)) return pp.proposed_cnc.filter(Boolean);
  return [];
}

function soProposedCncLabel(pp, partial) {
  const machines = soProposedCncMachines(pp, partial);
  return machines.length ? machines.join(', ') : '—';
}

function soRenderMachinePillsHtml(machines, { title, pillClass } = {}) {
  const list = Array.isArray(machines) ? machines.filter(Boolean) : [];
  if (!list.length) return '<span class="so-dash">—</span>';
  const extraCls = pillClass ? ` ${pillClass}` : '';
  const pills = list.map(machine => (
    `<span class="so-queue-machine-pill${extraCls}">${escapeHtml(String(machine))}</span>`
  )).join('');
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<span class="so-queue-machines"${titleAttr}>${pills}</span>`;
}

function soRenderQueuedMachinesHtml(machines) {
  return soRenderMachinePillsHtml(machines, {
    title: 'Queued on planner CNC lanes (this partial)',
  });
}

function soRenderProposedCncHtml(machines) {
  return soRenderMachinePillsHtml(machines, {
    title: 'Proposed CNC — click to choose machines',
    pillClass: 'so-proposed-cnc-pill',
  });
}

function soCncMachineNumber(code) {
  const match = String(code || '').trim().match(/(\d+)\s*$/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function soNormalizeCncMachine(raw) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  if (/^\d+$/.test(text)) return `CNC ${text}`;
  return text;
}

function soCncMachineCatalog(selected) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const name = soNormalizeCncMachine(raw);
    const key = name.toUpperCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  (soState.cncMachines || []).forEach(add);
  (selected || []).forEach(add);
  out.sort((a, b) => {
    const an = soCncMachineNumber(a);
    const bn = soCncMachineNumber(b);
    if (an !== bn) return an - bn;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
  return out;
}

function soProposedCncSelectedSet(machines) {
  return new Set((machines || []).map(item => soNormalizeCncMachine(item).toUpperCase()).filter(Boolean));
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

function soStageFilterText(partial) {
  const stage = soPartialStage(partial);
  const parts = [soStageLabel(partial)];
  if (stage.mode === 'completed') parts.push('All complete');
  if (stage.mode === 'unassigned') parts.push('No WO');
  return parts.filter(Boolean).join(' ');
}

/** SO-linked PP with qty still awaiting WO voucher issuance (incl. partial batches). */
function soPpPendingWoQty(pp) {
  const pending = Number(pp?.erp_pending_wo_qty);
  if (Number.isFinite(pending) && pending > 0.0001) return pending;
  const ppQty = Number(pp?.pp_qty);
  const issued = Number(pp?.erp_wo_issued_qty);
  if (Number.isFinite(ppQty) && Number.isFinite(issued) && ppQty - issued > 0.0001) {
    return ppQty - issued;
  }
  return 0;
}

function soPpIsNoWo(pp) {
  const soNo = String(pp?.source_voucher_no || '').trim();
  if (!soNo.startsWith('SO/')) return false;

  if (typeof pp?.erp_pending_no_wo === 'boolean') return pp.erp_pending_no_wo;

  const pendingQty = soPpPendingWoQty(pp);
  if (pendingQty > 0.0001) return true;

  if (typeof pp?.erp_has_wo === 'boolean') return !pp.erp_has_wo;

  const partials = Array.isArray(pp?.partials) && pp.partials.length ? pp.partials : [pp];
  const hasWoRaised = partials.some(p => (Number(p?.erp_wo_stage_count) || 0) > 0);
  return !hasWoRaised;
}

function soCollectNoWoProcessSheets() {
  const sheets = [];
  soVisibleOrders(soActiveOrders()).forEach(order => {
    soVisibleLeaves(order).forEach(leaf => {
      if (leaf.assemblyChild) return;
      if (!soPpIsNoWo(leaf.pp)) return;
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

const SO_EXPORT_COLUMNS = [
  { id: '_so', label: 'SO', width: 16 },
  { id: '_customer', label: 'Customer', width: 22 },
  { id: 'process_sheet_no', label: 'Process sheet', width: 18 },
  { id: 'partial', label: 'Partial', width: 10 },
  { id: 'partial_qty', label: 'Partial qty', width: 12 },
  { id: 'exception', label: 'Exception', width: 18 },
  { id: 'queued_cnc', label: 'Queued CNC', width: 16 },
  { id: 'proposed_cnc', label: 'Proposed CNC', width: 16 },
  { id: 'erp_stage', label: 'Stage', width: 18 },
  { id: 'qty', label: 'Qty', width: 8 },
  { id: 'order_date', label: 'Date', width: 12 },
  { id: 'part', label: 'Part', width: 22 },
  { id: 'description', label: 'Description', width: 32 },
  { id: 'customer_po_no', label: 'P/O No.', width: 16 },
  { id: 'due_date', label: 'Due date', width: 12 },
  { id: 'material_need_date', label: 'Need date', width: 12 },
  { id: 'material_subcon', label: 'Material in / Sub-con', width: 18 },
  { id: 'program_finish_at', label: 'Programme finish', width: 14 },
  { id: 'proposed_edd', label: 'Prop. EDD', width: 12 },
  { id: 'week', label: 'Week', width: 18 },
  { id: 'delivery_date', label: 'Delivered', width: 12 },
  { id: 'unit_selling_price', label: 'U/Price', width: 12 },
  { id: 'amount', label: 'Amount', width: 12 },
  { id: 'mtl_part_order', label: 'Mtl / Part Order', width: 18 },
  { id: 'quality_doc', label: 'Quality Doc', width: 16 },
  { id: 'ops_notes', label: 'Ops remarks', width: 28 },
  { id: 'sales_notes', label: 'Sales remarks', width: 28 },
  { id: 'remarks', label: 'PP remarks', width: 28 },
  { id: '_so_remarks', label: 'SO remarks', width: 28 },
  { id: '_external_remarks', label: 'External remarks', width: 28 },
];

const SO_EXPORT_VIEW_COLUMN = { id: '_view', label: 'View', width: 12 };
const SO_EXPORT_WRAP_IDS = new Set([
  'description',
  'exception',
  'mtl_part_order',
  'quality_doc',
  'ops_notes',
  'sales_notes',
  'remarks',
  '_so_remarks',
  '_external_remarks',
]);
const SO_EXPORT_EXCEPTION_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };

let soExportView = 'exceptions';

function soNormalizeExportView(view) {
  if (view === 'no-wo' || view === 'exceptions' || view === 'all') return view;
  return 'active';
}

function soExportColumnsForSheet(view) {
  if (view === 'exceptions') return [SO_EXPORT_VIEW_COLUMN, ...SO_EXPORT_COLUMNS];
  return SO_EXPORT_COLUMNS;
}

function soExportOrderCustomer(order) {
  return order?.customer_name || order?.customer_short_name || order?.customer_code || '';
}

function soExportBlankDash(value) {
  const text = String(value ?? '').trim();
  return !text || text === '—' ? '' : text;
}

function soExportDateValue(value) {
  const formatted = soFormatDate(value);
  return soExportBlankDash(formatted);
}

function soExportCellValue(leaf, colId) {
  const { order, pp, partial } = leaf;
  switch (colId) {
    case '_view':
      return soExportBlankDash(leaf.exportView);
    case '_so':
      return soExportBlankDash(order?.sales_order_no);
    case '_customer':
      return soExportBlankDash(soExportOrderCustomer(order));
    case 'process_sheet_no':
      return soExportBlankDash(soPsDisplayForPartial(pp, partial));
    case 'exception':
      return soExceptionIssuesLabel(soPartialExceptionIssues(pp, partial));
    case 'remarks':
      return soExportBlankDash(pp?.remarks);
    case '_so_remarks':
      return soExportBlankDash(order?.remarks);
    case '_external_remarks':
      return soExportBlankDash(order?.external_remarks);
    case 'order_date':
    case 'due_date':
    case 'material_need_date':
    case 'proposed_edd':
    case 'program_finish_at':
    case 'delivery_date': {
      let raw = pp?.[colId];
      if (colId === 'proposed_edd') raw = soProposedEddDisplay(pp, partial);
      else if (colId === 'program_finish_at') raw = soProgramFinishDisplay(pp);
      else if (colId === 'material_need_date') raw = soDateInputValue(pp?.material_need_date);
      return soExportDateValue(raw);
    }
    case 'week':
      return soExportBlankDash(soWeekLabel(pp, partial));
    case 'qty': {
      const num = Number(pp?.pp_qty);
      return Number.isFinite(num) ? num : soExportBlankDash(pp?.pp_qty);
    }
    case 'partial_qty': {
      const num = soPartialQtyValue(pp, partial);
      return num == null ? '' : num;
    }
    case 'unit_selling_price':
    case 'amount': {
      const num = Number(pp?.[colId]);
      return Number.isFinite(num) ? num : '';
    }
    case 'part':
      return soExportBlankDash(partial?.inventory_code || pp?.inventory_code);
    case 'customer_po_no':
      return soExportBlankDash(partial?.customer_po_no || pp?.customer_po_no || order?.customer_po_no);
    default: {
      const value = soLeafColumnValue(leaf, colId);
      return soExportBlankDash(value);
    }
  }
}

function soCollectFilteredLeaves(tableView) {
  const next = tableView === 'no-wo' ? 'no-wo' : (tableView === 'complete' ? 'complete' : 'active');
  const prevView = soState.view;
  soState.view = next;
  try {
    const leaves = [];
    soVisibleOrders(soActiveOrders()).forEach(order => {
      soVisibleLeaves(order).forEach(leaf => leaves.push(leaf));
    });
    return leaves;
  } finally {
    soState.view = prevView;
  }
}

function soCollectExceptionLeaves() {
  const leaves = [];
  [
    { label: 'Active', orders: soState.active || [] },
    { label: 'Complete', orders: soState.complete || [] },
  ].forEach(({ label, orders }) => {
    orders.forEach(order => {
      soNestAndExplodeLeaves(soLeafRows(order)).forEach(leaf => {
        if (leaf.assemblyChild || leaf.pp?.assembly_synthetic) return;
        if (!soLeafPassesPrefixFilter(leaf.pp)) return;
        if (!soPartialExceptionIssues(leaf.pp, leaf.partial).length) return;
        leaves.push({ ...leaf, exportView: label });
      });
    });
  });
  return leaves;
}

function soExportSheets(view) {
  const next = soNormalizeExportView(view);
  if (next === 'all') {
    return [
      { name: 'Exceptions', view: 'exceptions', leaves: soCollectExceptionLeaves() },
      { name: 'Active', view: 'active', leaves: soCollectFilteredLeaves('active') },
      { name: 'No WO', view: 'no-wo', leaves: soCollectFilteredLeaves('no-wo') },
    ];
  }
  if (next === 'exceptions') {
    return [{ name: 'Exceptions', view: 'exceptions', leaves: soCollectExceptionLeaves() }];
  }
  if (next === 'no-wo') {
    return [{ name: 'No WO', view: 'no-wo', leaves: soCollectFilteredLeaves('no-wo') }];
  }
  return [{ name: 'Active', view: 'active', leaves: soCollectFilteredLeaves('active') }];
}

function soExportFilename(view) {
  const stamp = new Date().toISOString().slice(0, 10);
  const next = soNormalizeExportView(view);
  const label = next === 'no-wo' ? 'no-wo' : (next === 'exceptions' ? 'exceptions' : (next === 'all' ? 'all' : 'active'));
  return `so-management-${label}-${stamp}.xlsx`;
}

function soExportEmptyMessage(view) {
  const next = soNormalizeExportView(view);
  if (next === 'exceptions') {
    return 'No exception rows to export. Flag Exception on a partial first. Complete-tab rows are included after that tab has been loaded.';
  }
  if (next === 'all') return 'No rows to export with the current filters.';
  return `No ${next === 'no-wo' ? 'No WO' : 'Active'} rows to export with the current filters.`;
}

async function soEnsureExcelJs() {
  if (window.ExcelJS) return window.ExcelJS;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load Excel export library'));
    document.head.appendChild(script);
  });
  return window.ExcelJS;
}

function soWriteExportSheet(workbook, sheetName, view, leaves) {
  const columns = soExportColumnsForSheet(view);
  const sheet = workbook.addWorksheet(sheetName);
  const headerRow = sheet.addRow(columns.map(col => col.label));
  headerRow.font = { bold: true, size: 11 };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
  headerRow.alignment = { vertical: 'middle', wrapText: true };

  leaves.forEach(leaf => {
    const row = sheet.addRow(columns.map(col => soExportCellValue(leaf, col.id)));
    row.alignment = { vertical: 'top', wrapText: true };
    if (soPartialExceptionIssues(leaf.pp, leaf.partial).length) {
      row.fill = SO_EXPORT_EXCEPTION_FILL;
    }
  });

  columns.forEach((col, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = col.width;
    if (SO_EXPORT_WRAP_IDS.has(col.id)) {
      column.alignment = { vertical: 'top', wrapText: true };
    }
  });
  sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 0, activeCell: 'A2' }];
  return sheet;
}

async function soDownloadWorkbook(workbook, filename) {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function soExportToExcel(view) {
  const exportView = soNormalizeExportView(view);
  const sheets = soExportSheets(exportView);
  const total = sheets.reduce((sum, sheet) => sum + sheet.leaves.length, 0);
  if (!total) {
    window.alert(soExportEmptyMessage(exportView));
    return;
  }

  const ExcelJS = await soEnsureExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Production Planner';
  workbook.created = new Date();
  sheets.forEach(sheet => {
    if (!sheet.leaves.length) return;
    soWriteExportSheet(workbook, sheet.name, sheet.view, sheet.leaves);
  });
  await soDownloadWorkbook(workbook, soExportFilename(exportView));
}

function soUpdateExportModalCount() {
  const el = document.getElementById('so-export-modal-count');
  if (!el) return;
  const sheets = soExportSheets(soExportView);
  if (soExportView === 'all') {
    el.textContent = `${sheets.map(sheet => `${sheet.leaves.length} ${sheet.name}`).join(' · ')} will be exported in one workbook.`;
    return;
  }
  const count = sheets[0]?.leaves.length || 0;
  if (soExportView === 'exceptions') {
    el.textContent = `${count} exception row${count === 1 ? '' : 's'} will be exported.`;
    return;
  }
  const label = sheets[0]?.name || 'Active';
  el.textContent = `${count} ${label} row${count === 1 ? '' : 's'} will be exported.`;
}

function soSetExportView(view) {
  soExportView = soNormalizeExportView(view);
  document.querySelectorAll('[data-so-export-view]').forEach(btn => {
    const active = btn.getAttribute('data-so-export-view') === soExportView;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  soUpdateExportModalCount();
}

function soCloseExportModal() {
  const modal = document.getElementById('so-export-modal');
  if (modal) modal.hidden = true;
  document.body.classList.remove('so-export-modal-open');
}

function soOpenExportModal() {
  const hasData = (soState.active?.length || 0) + (soState.complete?.length || 0) > 0;
  if (!hasData) {
    window.alert('Load S/O data first, then export.');
    return;
  }
  const modal = document.getElementById('so-export-modal');
  if (!modal) return;
  soSetExportView('exceptions');
  modal.hidden = false;
  document.body.classList.add('so-export-modal-open');
}

async function soConfirmExportExcel() {
  const btn = document.getElementById('so-export-confirm');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Exporting…';
  }
  try {
    await soExportToExcel(soExportView);
    soCloseExportModal();
  } catch (err) {
    console.error(err);
    window.alert(`Export failed: ${err.message || err}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Export Excel';
    }
  }
}

function soBindExportModal() {
  document.getElementById('so-export')?.addEventListener('click', soOpenExportModal);
  document.getElementById('so-export-modal-close')?.addEventListener('click', soCloseExportModal);
  document.getElementById('so-export-confirm')?.addEventListener('click', () => {
    soConfirmExportExcel();
  });
  document.querySelectorAll('[data-action="close-export-modal"]').forEach(node => {
    node.addEventListener('click', soCloseExportModal);
  });
  document.querySelectorAll('[data-so-export-view]').forEach(btn => {
    btn.addEventListener('click', () => soSetExportView(btn.getAttribute('data-so-export-view')));
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('so-export-modal');
    if (modal && !modal.hidden) soCloseExportModal();
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
    soDetailField('Partial qty', soFormatQty(soPartialQtyValue(pp, partial))),
    soDetailField(soPsDisplayLabel(pp), soPsDisplayId(pp), { mono: true }),
    typeof repeatOrderDetailHtml === 'function' ? repeatOrderDetailHtml(similar) : '',
    soDetailField('Queued CNC', soQueuedMachinesLabel(pp, partial), { mono: true }),
    soDetailField('Proposed CNC', soProposedCncLabel(pp, partial), { mono: true }),
    ...(soPartialStage(partial).desc ? [soDetailField('Stage', soPartialStage(partial).desc)] : []),
    ...(soPartialStage(partial).status ? [soDetailField('Stage status', soExecutionLabel(soPartialStage(partial).status))] : []),
    ...(!soPartialStage(partial).desc && !soPartialStage(partial).status
      ? [soDetailField('WO assignment', soStageLabel(partial))]
      : []),
    soDetailField('Part', partial?.inventory_code || pp?.inventory_code, { mono: true }),
    soDetailField('Description', pp?.description, { fullWidth: true }),
    ...(pp?.remarks ? [soDetailField('PP remarks', pp.remarks, { fullWidth: true })] : []),
    ...(order?.remarks ? [soDetailField('SO remarks', order.remarks, { fullWidth: true })] : []),
    ...(order?.external_remarks ? [soDetailField('External remarks', order.external_remarks, { fullWidth: true })] : []),
    soDetailField('Customer PO', partial?.customer_po_no || pp?.customer_po_no || order?.customer_po_no, { mono: true }),
    soDetailField('SO line', pp?.source_line_item_no),
    soDetailField('Due date', soFormatDate(pp?.due_date)),
    ...(soDateInputValue(pp?.material_need_date) ? [soDetailField('Need date', soFormatDate(pp?.material_need_date))] : []),
    ...(soProposedEddDisplay(pp, partial) ? [soDetailField('Prop. EDD', soFormatDate(soProposedEddDisplay(pp, partial)))] : []),
    ...(soProgramFinishDisplay(pp) ? [soDetailField('Programme finish', soFormatDate(soProgramFinishDisplay(pp)))] : []),
    soDetailField('Week', soWeekLabel(pp, partial)),
    ...(pp?.delivery_date ? [soDetailField('Delivered', soFormatDate(pp?.delivery_date))] : []),
    soDetailField('Qty', pp?.pp_qty),
    soDetailField('U/Price', soFormatMoney(pp?.unit_selling_price)),
    soDetailField('Amount', soFormatMoney(pp?.amount)),
    soDetailField('PP status', pp?.status),
    ...SO_NOTE_FIELDS.map(field => soDetailField(
      SO_NOTE_LABELS[field],
      field === 'material_subcon' ? soMaterialSubconDisplay(soEffectiveMaterialSubcon(pp)) : pp?.[field],
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
    ...(order?.remarks ? [soDetailField('SO remarks', order.remarks, { fullWidth: true })] : []),
    ...(order?.external_remarks ? [soDetailField('External remarks', order.external_remarks, { fullWidth: true })] : []),
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
        <span class="new-orders-detail-line-pick-no">Partial ${escapeHtml(String(partial.pp_partial_no ?? '—'))} · qty ${escapeHtml(soFormatQty(soPartialQtyValue(pp, partial)))}</span>
        <span class="new-orders-detail-line-pick-part">${escapeHtml(String(partial.inventory_code || '—'))}</span>
        <span class="new-orders-detail-line-pick-desc">${escapeHtml(soQueuedMachinesLabel(pp, partial))}</span>
        <span class="new-orders-detail-line-pick-queue">${queueHtml}</span>
      </button>
    `;
  }).join('');
  const lineHtml = [
    soDetailField(soPsDisplayLabel(pp), soPsDisplayId(pp), { mono: true }),
    soDetailField('Queued CNC (all)', soQueuedMachinesLabel(pp), { mono: true }),
    soDetailField('Proposed CNC', soProposedCncLabel(pp), { mono: true }),
    soDetailField('Part', pp?.inventory_code, { mono: true }),
    soDetailField('BOM', pp?.bom_code, { mono: true }),
    soDetailField('Description', pp?.description, { fullWidth: true }),
    ...(pp?.remarks ? [soDetailField('PP remarks', pp.remarks, { fullWidth: true })] : []),
    soDetailField('Customer PO', pp?.customer_po_no, { mono: true }),
    soDetailField('Qty', pp?.pp_qty),
    soDetailField('Due date', soFormatDate(pp?.due_date)),
    ...(soDateInputValue(pp?.material_need_date) ? [soDetailField('Need date', soFormatDate(pp?.material_need_date))] : []),
    ...(soProgramFinishDisplay(pp) ? [soDetailField('Programme finish', soFormatDate(soProgramFinishDisplay(pp)))] : []),
    ...SO_NOTE_FIELDS.map(field => soDetailField(
      SO_NOTE_LABELS[field],
      field === 'material_subcon' ? soMaterialSubconDisplay(soEffectiveMaterialSubcon(pp)) : pp?.[field],
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
    ...(order.remarks ? [soDetailField('Remarks', order.remarks, { fullWidth: true })] : []),
    ...(order.external_remarks ? [soDetailField('External remarks', order.external_remarks, { fullWidth: true })] : []),
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
  let pp = (order.pp_vouchers || []).find(row => String(row.pp_voucher_no || '').trim() === parts[1]) || null;
  if (!pp) {
    const found = soFindPp(parts[1]);
    if (found.pp && String(found.order?.sales_order_no || '').trim() === String(order.sales_order_no || '').trim()) {
      pp = found.pp;
    }
  }
  if (!pp) return { order, pp: null, partial: null };
  if (parts.length < 3 || parts[2] === '') return { order, pp, partial: null };
  const partial = (pp.partials || []).find(row => String(row.pp_partial_no ?? '').trim() === parts[2])
    || (pp.assembly_synthetic ? { pp_partial_no: parts[2], inventory_code: pp.inventory_code, partial_qty: pp.pp_qty } : null);
  return { order, pp, partial };
}

function soFindPp(ppVoucherNo) {
  const target = String(ppVoucherNo || '').trim();
  for (const order of soAllOrders()) {
    const pp = (order.pp_vouchers || []).find(row => String(row.pp_voucher_no || '').trim() === target);
    if (pp) return { order, pp };
  }
  const asm = soFindAssemblyChild(target);
  if (!asm) return { order: null, pp: null };
  const parentId = String(asm.job?.ps_id || '').trim();
  const parent = parentId && soPsBaseKey(parentId) !== soPsBaseKey(target)
    ? soFindPp(parentId)
    : { order: null, pp: null };
  const order = parent.order || soFindOrder(asm.job.sales_order_no);
  return { order, pp: soBomChildPp(parent.pp || {}, asm.child, { synthetic: !parent.pp }) };
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

function soSetLoading(loading, { overlay = false, message = '' } = {}) {
  const initial = document.getElementById('so-loading');
  const overlayEl = document.getElementById('so-loading-overlay');
  const host = soTableHost();
  const empty = document.getElementById('so-empty');
  const refreshBtn = document.getElementById('so-refresh');
  const loadingText = document.getElementById('so-loading-text');

  if (refreshBtn) refreshBtn.disabled = loading;

  if (loading) {
    const hasVisibleTable = host && !host.hidden;
    if (overlay && hasVisibleTable) {
      if (initial) initial.hidden = true;
      if (empty) empty.hidden = true;
      if (overlayEl) overlayEl.hidden = false;
      if (host) host.classList.add('is-loading');
    } else {
      if (initial) {
        initial.hidden = false;
        if (message && loadingText) loadingText.textContent = message;
      }
      if (host) {
        host.hidden = true;
        host.classList.remove('is-loading');
      }
      if (empty) empty.hidden = true;
      if (overlayEl) overlayEl.hidden = true;
    }
    return;
  }

  if (initial) initial.hidden = true;
  if (overlayEl) overlayEl.hidden = true;
  if (host) host.classList.remove('is-loading');
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
    if (e.target.closest('.so-editable-input, .so-editable-cell, .so-material-subcon-cell, .so-need-date-cell, .so-exception-cell, .so-coway-edd-cell, .so-program-finish-cell, .so-proposed-cnc-cell')) return;

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
  // The "no-wo" view is scoped to active (not fully shipped) jobs, matching the
  // Outstanding PS "Has PP · no WO" tab which excludes fully-shipped lines.
  return soState.view === 'complete' ? soState.complete : soState.active;
}

function soStripSrTag(value) {
  return String(value == null ? '' : value).replace(/\[sr\]/gi, '');
}

/** Match haystack against query, treating `[SR]` as optional (N26-[SR]22 ≡ n26-22). */
function soTextMatchesQuery(value, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const raw = String(value == null ? '' : value).toLowerCase();
  if (raw.includes(q)) return true;
  const strippedQ = soStripSrTag(q).replace(/\s+/g, '');
  if (!strippedQ) return false;
  const strippedVal = soStripSrTag(raw).toLowerCase();
  if (strippedVal.includes(strippedQ)) return true;
  return strippedVal.replace(/\s+/g, '').includes(strippedQ);
}

function soLeafSearchText(leaf) {
  const { order, pp, partial } = leaf;
  const parts = [
    order?.sales_order_no,
    order?.status,
    order?.voucher_status,
    order?.customer_code,
    order?.customer_name,
    order?.customer_short_name,
    order?.customer_po_no,
    order?.reference_no,
    order?.sales_person_name,
    order?.sbu_code,
    order?.sbu_desc,
    order?.remarks,
    order?.external_remarks,
    pp?.pp_voucher_no,
    pp?.process_sheet_no,
    soPsDisplayId(pp),
    soPsDisplayForPartial(pp, partial),
    pp?.inventory_code,
    pp?.bom_code,
    pp?.description,
    pp?.remarks,
    pp?.customer_po_no,
    pp?.material_need_date,
    soFormatDate(pp?.material_need_date),
    pp?.status,
    pp?.source_line_item_no,
    pp?.segment_1_code,
    ...(pp?.queued_machines || []),
    ...(pp?.proposed_cnc || []),
    ...SO_NOTE_FIELDS.map(field => (
      field === 'material_subcon' ? soMaterialSubconDisplay(soEffectiveMaterialSubcon(pp)) : pp?.[field]
    )),
    partial?.pp_partial_no,
    partial?.partial_qty,
    partial?.inventory_code,
    partial?.party_name,
    partial?.customer_po_no,
    partial?.customer_code,
    partial?.current_stage_desc,
    partial?.current_stage_status,
    partial?.erp_stage_mode,
    partial?.erp_last_stage_desc,
    ...(soPartialQueuedMachines(pp, partial)),
    ...(soProposedCncMachines(pp, partial)),
    ...soAssemblySearchBits(pp, leaf.assemblyChild),
  ];
  return parts.map(v => String(v == null ? '' : v)).join(' ');
}

function soLeafPassesSearch(leaf) {
  const q = String(soState.search || '').trim();
  if (!q) return true;
  return soTextMatchesQuery(soLeafSearchText(leaf), q);
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
          partial_qty: pp.pp_qty,
          inventory_code: pp.inventory_code,
          queued_machines: Array.isArray(byPartial[String(pno)])
            ? byPartial[String(pno)]
            : (pp.queued_machines || []),
          proposed_cnc: Array.isArray(pp.proposed_cnc) ? pp.proposed_cnc : [],
          current_stage_no: pp.current_stage_no,
          current_stage_desc: pp.current_stage_desc,
          current_stage_status: pp.current_stage_status,
          erp_stage_mode: pp.erp_stage_mode,
          erp_wo_stage_count: pp.erp_wo_stage_count,
          erp_all_wo_complete: pp.erp_all_wo_complete,
          erp_last_stage_no: pp.erp_last_stage_no,
          erp_last_stage_desc: pp.erp_last_stage_desc,
          erp_last_stage_status: pp.erp_last_stage_status,
          coway_proposed_edd: pp.coway_proposed_edd,
        },
      });
      return;
    }
    partials.forEach(partial => leaves.push({ order, pp, partial }));
  });
  return leaves;
}

function soGetPsType(pp) {
  const ps = String(pp?.process_sheet_no || '').split('::')[0];
  const voucher = String(pp?.pp_voucher_no || '').split('::')[0];
  if (/\[sr\]/i.test(ps) || /\[sr\]/i.test(voucher)) return 'SR';
  const raw = ps || voucher;
  const match = raw.toUpperCase().match(/^([A-Z]+)/);
  if (!match) return null;
  const prefix = match[1];
  return SO_PS_TYPES.includes(prefix) ? prefix : prefix;
}

function soPsBaseKey(value) {
  return String(value || '').split('::')[0].trim().toUpperCase();
}

function soPartKeyOf(value) {
  return String(value || '').trim().toUpperCase();
}

function soIsComponentChildPs(value) {
  const raw = soPsBaseKey(value);
  return (raw.match(/-/g) || []).length >= 2 && /-\d+$/.test(raw);
}

function soParentPsIdFromChild(value) {
  const raw = soPsBaseKey(value);
  return soIsComponentChildPs(raw) ? raw.replace(/-\d+$/, '') : '';
}

function soPsIdOfLeaf(leaf) {
  return soPsBaseKey(leaf?.pp?.process_sheet_no || leaf?.pp?.pp_voucher_no);
}

function soIndexAssemblyJobs(items) {
  const map = new Map();
  (items || []).forEach(item => {
    const psId = soPsBaseKey(item?.ps_id);
    if (psId) map.set(psId, item);
    const part = soPartKeyOf(item?.part_no);
    if (part && !map.has(`part:${part}`)) map.set(`part:${part}`, item);
  });
  return map;
}

function soAssemblyForPp(pp) {
  if (!soState.assemblyJobs.size) return null;
  for (const key of [pp?.process_sheet_no, pp?.pp_voucher_no]) {
    const id = soPsBaseKey(key);
    if (!id) continue;
    if (soState.assemblyJobs.has(id)) return soState.assemblyJobs.get(id);
    const parent = soParentPsIdFromChild(id);
    if (parent && soState.assemblyJobs.has(parent)) return soState.assemblyJobs.get(parent);
  }
  const part = soPartKeyOf(pp?.inventory_code);
  if (part && soState.assemblyJobs.has(`part:${part}`)) return soState.assemblyJobs.get(`part:${part}`);
  return null;
}

function soAssemblyLineItems(pp) {
  const job = soAssemblyForPp(pp);
  if (!job) return [];
  return (job.children || []).filter(child => String(child.part_no || '').trim());
}

function soBomChildPp(parentPp, child, { synthetic = true } = {}) {
  const childPs = String(child?.process_sheet_no || '').trim();
  const out = {
    ...parentPp,
    pp_voucher_no: childPs || parentPp?.pp_voucher_no,
    process_sheet_no: childPs || parentPp?.process_sheet_no,
    inventory_code: child.part_no || parentPp?.inventory_code,
    description: child.description || parentPp?.description,
    pp_qty: child.qty == null ? parentPp?.pp_qty : child.qty,
    bom_code: child.selected_bom_code || child.resolved_bom_code || parentPp?.bom_code || '',
  };
  if (childPs) {
    out.material_subcon = child.material_subcon || '';
    out.mtl_part_order = child.mtl_part_order || '';
    out.material_need_date = child.material_need_date || '';
    out.material_need_date_history_count = Number(child.material_need_date_history_count || 0);
    out.material_in_date_history_count = Number(child.material_in_date_history_count || 0);
    out.material_delay = Boolean(child.material_delay);
  } else {
    if (child.material_subcon) out.material_subcon = child.material_subcon;
    if (child.mtl_part_order) out.mtl_part_order = child.mtl_part_order;
    if (child.material_need_date) out.material_need_date = child.material_need_date;
    if (child.material_delay != null) out.material_delay = Boolean(child.material_delay);
  }
  if (!synthetic) {
    out.assembly_synthetic = false;
    return out;
  }
  out.assembly_synthetic = true;
  out.partials = [];
  out.partial_count = 0;
  out.queued_machines = [];
  out.queued_machines_by_partial = {};
  out.proposed_cnc = [];
  out.current_stage_no = null;
  out.current_stage_desc = '';
  out.current_stage_status = '';
  out.erp_stage_mode = 'subassembly';
  out.erp_wo_stage_count = 0;
  out.erp_all_wo_complete = false;
  out.erp_pending_no_wo = false;
  out.erp_has_wo = true;
  out.erp_pending_wo_qty = 0;
  out.erp_wo_issued_qty = null;
  out.highlighted_partials = [];
  out.ps_highlighted = false;
  out.exception_issues = {};
  out.is_new_part = false;
  out.similar_ps_count = 0;
  out.coway_proposed_edd = '';
  out.program_finish_at = '';
  return out;
}

function soAsBomChildRow(parentLeaf, child, index, count) {
  const pp = soBomChildPp(parentLeaf.pp, child, { synthetic: true });
  if (!String(child?.process_sheet_no || '').trim()) {
    const parentNo = String(parentLeaf.pp?.pp_voucher_no || 'FG').trim();
    pp.pp_voucher_no = `${parentNo}#fg${index + 1}`;
    pp.process_sheet_no = String(parentLeaf.pp?.process_sheet_no || parentNo);
  }
  return {
    ...parentLeaf,
    pp,
    partial: {
      pp_partial_no: 1,
      partial_qty: child.qty == null ? parentLeaf.partial?.partial_qty : child.qty,
      inventory_code: child.part_no || parentLeaf.partial?.inventory_code,
      queued_machines: [],
      proposed_cnc: [],
      erp_stage_mode: 'subassembly',
      erp_wo_stage_count: 0,
      current_stage_desc: '',
      current_stage_status: '',
    },
    assemblyChild: child,
    assemblyChildIndex: index,
    assemblyChildCount: count,
  };
}

function soAsNestedChildRow(parentLeaf, childLeaf, child, index, count) {
  const part = String(
    child?.part_no || childLeaf.partial?.inventory_code || childLeaf.pp?.inventory_code || ''
  ).trim();
  const assemblyChild = child && String(child.process_sheet_no || '').trim()
    ? child
    : {
      part_no: part,
      description: childLeaf.pp?.description || '',
      qty: childLeaf.partial?.partial_qty ?? childLeaf.pp?.pp_qty,
      process_sheet_no: soPsIdOfLeaf(childLeaf) || String(childLeaf.pp?.process_sheet_no || '').trim(),
      selected_bom_code: childLeaf.pp?.bom_code || '',
      is_subassembly: true,
      material_subcon: childLeaf.pp?.material_subcon || '',
      mtl_part_order: childLeaf.pp?.mtl_part_order || '',
      material_need_date: childLeaf.pp?.material_need_date || '',
      material_delay: Boolean(childLeaf.pp?.material_delay),
    };
  return {
    ...childLeaf,
    pp: soBomChildPp(childLeaf.pp, assemblyChild, { synthetic: false }),
    partial: {
      ...(childLeaf.partial || {}),
      inventory_code: assemblyChild.part_no || childLeaf.partial?.inventory_code,
      partial_qty: assemblyChild.qty == null ? childLeaf.partial?.partial_qty : assemblyChild.qty,
    },
    assemblyChild,
    assemblyChildIndex: index,
    assemblyChildCount: count,
  };
}

function soNestAndExplodeLeaves(leaves) {
  const parentKeys = new Set();
  leaves.forEach(leaf => {
    const ps = soPsIdOfLeaf(leaf);
    if (ps && !soIsComponentChildPs(ps)) parentKeys.add(ps);
  });

  const nestedByParent = new Map();
  const roots = [];
  const orphans = [];
  leaves.forEach(leaf => {
    const ps = soPsIdOfLeaf(leaf);
    if (soIsComponentChildPs(ps)) {
      const parent = soParentPsIdFromChild(ps);
      if (parent && parentKeys.has(parent)) {
        const list = nestedByParent.get(parent) || [];
        list.push(leaf);
        nestedByParent.set(parent, list);
        return;
      }
      orphans.push(leaf);
      return;
    }
    roots.push(leaf);
  });

  const out = [];
  roots.forEach(leaf => {
    const ps = soPsIdOfLeaf(leaf);
    const nested = (nestedByParent.get(ps) || []).slice().sort((a, b) => {
      const psCmp = soPsIdOfLeaf(a).localeCompare(soPsIdOfLeaf(b), undefined, { numeric: true });
      if (psCmp) return psCmp;
      return soPartialNo(a.partial) - soPartialNo(b.partial);
    });
    const items = soAssemblyLineItems(leaf.pp);
    const nestedByPs = new Map();
    const nestedByPart = new Map();
    nested.forEach(childLeaf => {
      const childPs = soPsIdOfLeaf(childLeaf);
      if (childPs && !nestedByPs.has(childPs)) nestedByPs.set(childPs, childLeaf);
      const part = soPartKeyOf(childLeaf.partial?.inventory_code || childLeaf.pp?.inventory_code);
      if (part && !nestedByPart.has(part)) nestedByPart.set(part, childLeaf);
    });
    const usedNested = new Set();
    const childRows = items.map((child, index) => {
      const childPs = soPsBaseKey(child.process_sheet_no);
      const nestedLeaf = (childPs && nestedByPs.get(childPs))
        || nestedByPart.get(soPartKeyOf(child.part_no))
        || null;
      if (nestedLeaf) usedNested.add(nestedLeaf);
      if (nestedLeaf) return soAsNestedChildRow(leaf, nestedLeaf, child, index, 0);
      return soAsBomChildRow(leaf, child, index, 0);
    });
    nested.forEach(childLeaf => {
      if (usedNested.has(childLeaf)) return;
      childRows.push(soAsNestedChildRow(leaf, childLeaf, null, childRows.length, 0));
    });
    if (!childRows.length) {
      out.push(leaf);
      return;
    }
    childRows.forEach((row, index) => {
      row.assemblyChildIndex = index;
      row.assemblyChildCount = childRows.length;
    });
    out.push({ ...leaf, assemblyChildCount: childRows.length });
    out.push(...childRows);
  });
  orphans.forEach(leaf => out.push(leaf));
  return out;
}

function soAssemblySearchBits(pp, assemblyChild) {
  const job = soAssemblyForPp(pp);
  if (!job) {
    if (!assemblyChild) return [];
    return [
      assemblyChild.part_no,
      assemblyChild.description,
      assemblyChild.process_sheet_no,
    ];
  }
  if (assemblyChild) {
    return [
      job.ps_id,
      job.part_no,
      assemblyChild.part_no,
      assemblyChild.description,
      assemblyChild.process_sheet_no,
    ];
  }
  const bits = [job.ps_id, job.part_no];
  (job.children || []).forEach(child => {
    bits.push(child.part_no, child.description, child.process_sheet_no);
  });
  return bits;
}

function soFindAssemblyChild(ppVoucherNo) {
  const key = soPsBaseKey(ppVoucherNo);
  if (!key || !soState.assemblyJobs.size) return null;
  for (const [mapKey, job] of soState.assemblyJobs) {
    if (String(mapKey).startsWith('part:')) continue;
    for (const child of job.children || []) {
      if (soPsBaseKey(child.process_sheet_no) === key) return { job, child };
    }
  }
  return null;
}

function soPatchAssemblyChildNotes(ppNo, patch) {
  const key = soPsBaseKey(ppNo);
  if (!key || !soState.assemblyJobs.size) return;
  soState.assemblyJobs.forEach((job, mapKey) => {
    if (String(mapKey).startsWith('part:')) return;
    (job.children || []).forEach(child => {
      if (soPsBaseKey(child.process_sheet_no) !== key) return;
      Object.assign(child, patch);
    });
  });
}

function soSortLeavesKeepingAssembly(leaves, colId, dir) {
  const groups = [];
  let current = null;
  leaves.forEach(leaf => {
    if (leaf.assemblyChild) {
      if (!current) {
        current = { root: null, children: [leaf] };
        groups.push(current);
        return;
      }
      current.children.push(leaf);
      return;
    }
    current = { root: leaf, children: [] };
    groups.push(current);
  });
  groups.sort((a, b) => {
    const left = a.root || a.children[0];
    const right = b.root || b.children[0];
    return soCompareValues(soLeafSortValue(left, colId), soLeafSortValue(right, colId), dir);
  });
  const out = [];
  groups.forEach(group => {
    if (group.root) out.push(group.root);
    out.push(...group.children);
  });
  return out;
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
      if (leaf.assemblyChild) return;
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
    case 'partial_qty': return soPartialQtyValue(pp, partial);
    case 'exception': return soExceptionIssuesLabel(soPartialExceptionIssues(pp, partial));
    case 'process_sheet_no': return soPsDisplayId(pp);
    case 'queued_cnc': return soQueuedMachinesLabel(pp, partial);
    case 'proposed_cnc': return soProposedCncLabel(pp, partial);
    case 'erp_stage': return soStageFilterText(partial);
    case 'order_date': return pp?.order_date;
    case 'part': {
      const code = partial?.inventory_code || pp?.inventory_code;
      return soIsFrameAgreement(pp, partial) ? `${code} FA` : code;
    }
    case 'description': return pp?.description;
    case 'customer_po_no': return pp?.customer_po_no;
    case 'due_date': return pp?.due_date;
    case 'material_need_date': return soDateInputValue(pp?.material_need_date);
    case 'proposed_edd': return soProposedEddDisplay(pp, partial);
    case 'program_finish_at': return soProgramFinishDisplay(pp);
    case 'week': return soWeekLabel(pp, partial);
    case 'delivery_date': return pp?.delivery_date;
    case 'unit_selling_price': return pp?.unit_selling_price;
    case 'amount': return pp?.amount;
    case 'qty': return pp?.pp_qty;
    case 'material_subcon':
      return soMaterialSubconDisplay(soEffectiveMaterialSubcon(pp));
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

function soLeafColumnIsEmpty(leaf, colId) {
  const { order, pp, partial } = leaf;
  switch (colId) {
    case '_so':
      return !String(order?.sales_order_no || '').trim();
    case 'process_sheet_no': {
      const v = soPsDisplayId(pp);
      return !v || v === '—';
    }
    case 'partial':
      return partial?.pp_partial_no == null || partial?.pp_partial_no === '';
    case 'partial_qty':
      return soPartialQtyValue(pp, partial) == null;
    case 'exception':
      return !soPartialExceptionIssues(pp, partial).length;
    case 'queued_cnc':
      return soPartialQueuedMachines(pp, partial).length === 0;
    case 'proposed_cnc':
      return soProposedCncMachines(pp, partial).length === 0;
    case 'erp_stage': {
      const stage = soPartialStage(partial);
      return !stage.desc && !stage.status && stage.mode !== 'unassigned' && stage.mode !== 'completed';
    }
    case 'order_date':
      return !String(pp?.order_date || '').trim();
    case 'part':
      return !String(partial?.inventory_code || pp?.inventory_code || '').trim();
    case 'description':
      return !String(pp?.description || '').trim();
    case 'customer_po_no':
      return !String(pp?.customer_po_no || '').trim();
    case 'due_date':
      return !String(pp?.due_date || '').trim();
    case 'material_need_date':
      return !soDateInputValue(pp?.material_need_date);
    case 'proposed_edd':
      return !soProposedEddDisplay(pp, partial);
    case 'program_finish_at':
      return !soProgramFinishDisplay(pp);
    case 'week':
      return soWeekLabel(pp, partial) === '—';
    case 'delivery_date':
      return !String(pp?.delivery_date || '').trim();
    case 'unit_selling_price':
      return !Number.isFinite(Number(pp?.unit_selling_price));
    case 'amount':
      return !Number.isFinite(Number(pp?.amount));
    case 'qty':
      return pp?.pp_qty == null || pp?.pp_qty === '';
    case 'material_subcon':
      return !soMaterialSubconDisplay(soEffectiveMaterialSubcon(pp));
    default:
      if (SO_NOTE_FIELDS.includes(colId)) return !String(pp?.[colId] || '').trim();
      return false;
  }
}

function soLeafPassesColumnFilters(leaf) {
  for (const [colId, emptyOnly] of Object.entries(soState.colEmptyFilters)) {
    if (!emptyOnly) continue;
    if (!soLeafColumnIsEmpty(leaf, colId)) return false;
  }
  for (const [colId, text] of Object.entries(soState.colFilters)) {
    if (soState.colEmptyFilters[colId]) continue;
    const q = String(text || '').trim().toLowerCase();
    if (!q) continue;
    const val = String(soLeafColumnValue(leaf, colId) ?? '');
    if (!soTextMatchesQuery(val, q)) return false;
  }
  for (const [colId, text] of Object.entries(soState.colExcludeFilters)) {
    if (soState.colEmptyFilters[colId]) continue;
    const q = String(text || '').trim();
    if (!q) continue;
    const val = String(soLeafColumnValue(leaf, colId) ?? '');
    if (soTextMatchesQuery(val, q)) return false;
  }
  return true;
}

function soLeafPassesFilters(leaf) {
  if (leaf.assemblyChild && soState.view === 'no-wo') return false;
  if (soState.view === 'no-wo' && !soPpIsNoWo(leaf.pp)) return false;
  if (!soLeafPassesPrefixFilter(leaf.pp)) return false;
  if (!soLeafPassesSearch(leaf)) return false;
  return soLeafPassesColumnFilters(leaf);
}

function soLeafSortValue(leaf, colId) {
  if (colId === 'erp_stage') return soStageSortValue(leaf.partial);
  if (colId === 'material_subcon') return soMaterialSubconSortValue(soEffectiveMaterialSubcon(leaf.pp));
  if (colId === 'week') return soCommitmentDate(leaf.pp, leaf.partial) || '9999-12-31';
  return soLeafColumnValue(leaf, colId);
}

function soVisibleLeaves(order) {
  let leaves = soNestAndExplodeLeaves(soLeafRows(order)).filter(soLeafPassesFilters);
  if (soState.sortCol) {
    leaves = soSortLeavesKeepingAssembly(leaves, soState.sortCol, soState.sortDir);
  }
  return leaves;
}

function soVisibleOrders(orders) {
  let list = (orders || []).filter(order => soVisibleLeaves(order).length > 0);
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
  if (soState.colEmptyFilters[colId]) return true;
  if (String(soState.colExcludeFilters[colId] || '').trim()) return true;
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
    const toneCls = col.tone ? ` so-col-tone so-col-tone--${col.tone}` : '';
    if (!col.sortable && !col.filterable) {
      return `<th class="${sideCls}${stickyCls}${toneCls}">${escapeHtml(col.label)}</th>`;
    }
    return `
      <th class="so-col-head${sideCls}${stickyCls}${toneCls}${sortCls}" data-so-col="${escapeHtml(col.id)}">
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

function soStageExcludeAllCompleteActive() {
  const exclude = String(soState.colExcludeFilters.erp_stage || '').trim().toLowerCase();
  return exclude === SO_STAGE_EXCLUDE_ALL_COMPLETE;
}

function soSyncStageExcludeInputs(panel, colId, emptyOnly) {
  const disabled = emptyOnly ? ' disabled' : '';
  panel.querySelectorAll(`[data-so-filter-input="${CSS.escape(colId)}"], [data-so-filter-exclude-input="${CSS.escape(colId)}"], [data-so-filter-exclude-preset="${CSS.escape(colId)}"]`).forEach(input => {
    input.disabled = emptyOnly;
  });
}

function soRenderTextFilterPanel(colId, label) {
  const textVal = escapeHtml(soState.colFilters[colId] || '');
  const emptyOnly = soState.colEmptyFilters[colId] ? ' checked' : '';
  const textDisabled = soState.colEmptyFilters[colId] ? ' disabled' : '';
  return `
    <div class="so-col-filter-title">Filter: ${escapeHtml(label)}</div>
    <label class="so-col-filter-check so-col-filter-empty-only">
      <input type="checkbox" data-so-filter-empty="${escapeHtml(colId)}"${emptyOnly} />
      Empty only
    </label>
    <label class="so-col-filter-text-label">Contains</label>
    <input type="search" class="so-col-filter-input" data-so-filter-input="${escapeHtml(colId)}" value="${textVal}" placeholder="Contains…" autocomplete="off"${textDisabled} />
    <div class="so-col-filter-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-action="clear-col-filter" data-so-col="${escapeHtml(colId)}">Clear</button>
    </div>
  `;
}

function soRenderStageFilterPanel(colId, label) {
  const textVal = escapeHtml(soState.colFilters[colId] || '');
  const excludeVal = escapeHtml(soState.colExcludeFilters[colId] || '');
  const emptyOnly = soState.colEmptyFilters[colId] ? ' checked' : '';
  const textDisabled = soState.colEmptyFilters[colId] ? ' disabled' : '';
  const excludeAllComplete = soStageExcludeAllCompleteActive() ? ' checked' : '';
  return `
    <div class="so-col-filter-title">Filter: ${escapeHtml(label)}</div>
    <label class="so-col-filter-check so-col-filter-empty-only">
      <input type="checkbox" data-so-filter-empty="${escapeHtml(colId)}"${emptyOnly} />
      Empty only
    </label>
    <label class="so-col-filter-text-label">Contains</label>
    <input type="search" class="so-col-filter-input" data-so-filter-input="${escapeHtml(colId)}" value="${textVal}" placeholder="Contains…" autocomplete="off"${textDisabled} />
    <label class="so-col-filter-text-label">Does not contain</label>
    <input type="search" class="so-col-filter-input" data-so-filter-exclude-input="${escapeHtml(colId)}" value="${excludeVal}" placeholder="Does not contain…" autocomplete="off"${textDisabled} />
    <label class="so-col-filter-check so-col-filter-exclude-preset">
      <input type="checkbox" data-so-filter-exclude-preset="${escapeHtml(colId)}" data-so-exclude-preset-value="${escapeHtml(SO_STAGE_EXCLUDE_ALL_COMPLETE)}"${excludeAllComplete}${textDisabled} />
      All complete
    </label>
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

  soCloseProposedCncPopover();
  soCloseExceptionPopover();
  soState.openFilterCol = colId;
  pop.innerHTML = col.filterType === 'prefix'
    ? soRenderPrefixFilterPanel(colId)
    : colId === 'erp_stage'
      ? soRenderStageFilterPanel(colId, col.label)
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
      delete soState.colExcludeFilters[colId];
      delete soState.colEmptyFilters[colId];
      soCloseColumnFilter();
      soRender();
      return;
    }
    e.stopPropagation();
  });

  pop?.addEventListener('change', e => {
    const emptyInput = e.target.closest('input[data-so-filter-empty]');
    if (!emptyInput) return;
    const colId = emptyInput.getAttribute('data-so-filter-empty');
    if (!colId) return;
    if (emptyInput.checked) {
      soState.colEmptyFilters[colId] = true;
    } else {
      delete soState.colEmptyFilters[colId];
    }
    const textInput = pop.querySelector(`[data-so-filter-input="${CSS.escape(colId)}"]`);
    if (textInput) textInput.disabled = emptyInput.checked;
    soSyncStageExcludeInputs(pop, colId, emptyInput.checked);
    soRender();
  });

  pop?.addEventListener('change', e => {
    const presetInput = e.target.closest('input[data-so-filter-exclude-preset]');
    if (!presetInput) return;
    const colId = presetInput.getAttribute('data-so-filter-exclude-preset');
    if (!colId || soState.colEmptyFilters[colId]) return;
    const presetVal = String(presetInput.getAttribute('data-so-exclude-preset-value') || '').trim();
    const excludeInput = pop.querySelector(`[data-so-filter-exclude-input="${CSS.escape(colId)}"]`);
    if (presetInput.checked) {
      soState.colExcludeFilters[colId] = presetVal;
      if (excludeInput) excludeInput.value = presetVal;
    } else if (String(soState.colExcludeFilters[colId] || '').trim().toLowerCase() === presetVal.toLowerCase()) {
      delete soState.colExcludeFilters[colId];
      if (excludeInput) excludeInput.value = '';
    }
    soRender();
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
      if (!colId || soState.colEmptyFilters[colId]) return;
      soState.colFilters[colId] = textInput.value || '';
      soRender();
      return;
    }
    const excludeInput = e.target.closest('[data-so-filter-exclude-input]');
    if (excludeInput) {
      const colId = excludeInput.getAttribute('data-so-filter-exclude-input');
      if (!colId || soState.colEmptyFilters[colId]) return;
      const val = String(excludeInput.value || '').trim();
      if (val) soState.colExcludeFilters[colId] = val;
      else delete soState.colExcludeFilters[colId];
      const presetInput = pop.querySelector(`[data-so-filter-exclude-preset="${CSS.escape(colId)}"]`);
      if (presetInput) {
        const presetVal = String(presetInput.getAttribute('data-so-exclude-preset-value') || '').trim().toLowerCase();
        presetInput.checked = val.toLowerCase() === presetVal;
      }
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
        <strong class="new-orders-side-so">${escapeHtml(soNo || '—')}${soRenderNewOrderBadge(order)}</strong>
        <span class="new-orders-side-posted-compact" title="${escapeHtml(posted)}">${escapeHtml(postedShort)}</span>
        <span class="new-orders-side-customer-compact" title="${escapeHtml(customer)}">${escapeHtml(customer)}</span>
      </div>
    </td>
  `;
}

function soRenderSubasmPill(leaf) {
  if (!leaf) return '';
  if (leaf.assemblyChild) {
    const lineNo = Number(leaf.assemblyChildIndex) + 1;
    const lineCount = Number(leaf.assemblyChildCount) || 0;
    const label = lineCount > 0 ? `${lineNo}/${lineCount}` : String(lineNo);
    return `<span class="so-subasm-pill" title="Sub-assembly finished good ${escapeHtml(label)} on this line item">${escapeHtml(label)}</span>`;
  }
  const count = Number(leaf.assemblyChildCount) || 0;
  if (count <= 0) return '';
  return `<span class="so-subasm-pill" title="${escapeHtml(String(count))} sub-assembly finished goods on this line item">${escapeHtml(String(count))} FG</span>`;
}

function soRenderProcessSheetCell(order, pp, partial, leaf) {
  const psCode = soPsDisplayForPartial(pp, partial);
  const repeatPill = leaf?.assemblyChild ? '' : soRenderRepeatPill(order, pp);
  const psType = soGetPsType(pp);
  const tag = psType ? soTypeTagHtml(psType) : '';
  return `
    <td class="new-orders-ps-cell so-process-sheet-cell so-sticky-ps-cell">
      <div class="so-ps-headline">
        ${tag}
        <span class="new-orders-ps-code">${escapeHtml(psCode)}</span>
        ${soRenderSubasmPill(leaf)}
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

function soRenderProposedCncCell(pp, partial) {
  if (pp?.assembly_synthetic) {
    return `<td class="so-queued-cnc-cell so-proposed-cnc-cell"><span class="so-dash">—</span></td>`;
  }
  const ppNo = String(pp?.pp_voucher_no || '').trim();
  const machines = soProposedCncMachines(pp, partial);
  const open = soState.openProposedCncPp === ppNo;
  return `
    <td class="so-queued-cnc-cell so-proposed-cnc-cell">
      <button type="button"
        class="so-proposed-cnc-btn${machines.length ? ' has-value' : ''}${open ? ' is-open' : ''}"
        data-pp-voucher-no="${escapeHtml(ppNo)}"
        aria-haspopup="listbox"
        aria-expanded="${open ? 'true' : 'false'}"
        title="Choose proposed CNC machines">
        <span class="so-proposed-cnc-btn-value">${
          machines.length
            ? soRenderProposedCncHtml(machines)
            : '<span class="so-dash">—</span>'
        }</span>
        <span class="so-proposed-cnc-btn-caret" aria-hidden="true">▾</span>
      </button>
      <span class="so-proposed-cnc-status so-editable-status" aria-live="polite"></span>
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
  if (pp?.assembly_synthetic) {
    return `
    <td class="so-stage-cell">
      <div class="so-stage-stack">
        <span class="so-dash">—</span>
        ${soRenderStageMaterialBtn(pp, partial)}
      </div>
    </td>`;
  }
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
  const pendingWo = soPpPendingWoQty(pp);
  const pendingHtml = pendingWo > 0.0001
    ? `<span class="so-stage-mode so-stage-mode--pending-wo" title="${escapeHtml(`${pendingWo} PP qty awaiting WO voucher issuance`)}">${escapeHtml(String(pendingWo))} awaiting WO</span>`
    : '';
  return `
    <td class="so-stage-cell">
      <div class="so-stage-stack">
        ${stageHtml}
        ${pendingHtml}
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
  const cls = (mode === 'not_found' || mode === 'route_no_materials')
    ? ' so-material-modal-notice--warn'
    : ' so-material-modal-notice--info';
  return `<div class="so-material-modal-notice${cls}">${escapeHtml(text)}</div>`;
}

function soRenderMatchedBomStages(meta) {
  const stages = Array.isArray(meta?.matched_stages) ? meta.matched_stages : [];
  if (!stages.length) return '';
  const route = String(meta?.matched_bom_code || meta?.resolved_bom_code || '').trim();
  const desc = String(meta?.matched_bom_desc || '').trim();
  const title = route
    ? `Matched BOM op stages · ${route}${desc ? ` · ${desc}` : ''}`
    : 'Matched BOM op stages';
  const body = stages.map(stage => {
    const no = stage?.stage_no != null && stage.stage_no !== '' ? String(stage.stage_no) : '—';
    const stageDesc = String(stage?.stage_desc || '—');
    return `
      <tr>
        <td class="new-orders-num">${escapeHtml(no)}</td>
        <td>${escapeHtml(stageDesc)}</td>
      </tr>
    `;
  }).join('');
  return `
    <section class="so-material-modal-section">
      <h3 class="so-material-modal-section-title">${escapeHtml(title)}</h3>
      <div class="so-material-modal-table-wrap">
        <table class="so-material-modal-table">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>
  `;
}

function soRenderMaterialModalBomTable(rows, meta = null) {
  if (!Array.isArray(rows) || !rows.length) {
    const stagesHtml = soRenderMatchedBomStages(meta);
    if (stagesHtml) {
      return `${stagesHtml}<p class="so-material-modal-empty">No raw-material lines on this BOM route.</p>`;
    }
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
        matched_bom_code: data.matched_bom_code || data.resolved_bom_code || '',
        matched_bom_desc: data.matched_bom_desc || '',
        matched_stages: Array.isArray(data.matched_stages) ? data.matched_stages : [],
        route_matched: Boolean(data.route_matched),
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

function soRenderPartialQtyCell(pp, partial) {
  return `<td class="new-orders-num so-partial-qty-cell">${escapeHtml(soFormatQty(soPartialQtyValue(pp, partial)))}</td>`;
}

function soRenderWeekCell(pp, partial) {
  return `<td class="new-orders-date so-week-cell">${escapeHtml(soWeekLabel(pp, partial))}</td>`;
}

function soRenderPpCells(pp, partial) {
  return `
    <td class="new-orders-desc" title="${escapeHtml(String(pp.description || ''))}">${escapeHtml(String(pp.description || '—'))}</td>
    <td class="new-orders-date">${escapeHtml(soFormatDate(pp.due_date))}</td>
    ${soRenderNeedDateCell(pp)}
    ${soRenderMaterialSubconCell(pp)}
    ${soRenderProgramFinishCell(pp, partial)}
    ${soRenderProposedEddCell(pp, partial)}
    ${soRenderWeekCell(pp, partial)}
    <td class="new-orders-date">${escapeHtml(soFormatDate(pp.delivery_date))}</td>
    ${SO_NOTE_FIELDS.filter(field => field !== 'material_subcon').map(field => soRenderEditableCell(pp, field)).join('')}
  `;
}

function soRenderNeedDateCell(pp) {
  const ppNo = String(pp?.pp_voucher_no || '').trim();
  const value = soDateInputValue(pp?.material_need_date);
  const editable = Boolean(ppNo) && !pp?.assembly_synthetic;
  if (!editable) {
    return `<td class="new-orders-date so-need-date-cell${value ? ' has-need-date' : ''}"><span class="so-need-date-static">${escapeHtml(soFormatDate(value))}</span></td>`;
  }
  return `
    <td class="new-orders-date so-need-date-cell${value ? ' has-need-date' : ''}">
      <input type="date"
        class="so-need-date-input"
        value="${escapeHtml(value)}"
        data-pp-voucher-no="${escapeHtml(ppNo)}"
        data-last-saved="${escapeHtml(value)}"
        aria-label="Need date"
        title="Same Need date as Supply Chain View — saved per PP voucher">
      <span class="so-editable-status" aria-live="polite"></span>
    </td>
  `;
}

function soRenderMaterialSubconCell(pp) {
  const ppNo = String(pp.pp_voucher_no || '').trim();
  const raw = soEffectiveMaterialSubcon(pp);
  const parsed = soParseMaterialSubcon(raw);
  const arrivedCls = parsed.arrived ? ' is-active' : '';
  const dateHiddenCls = parsed.arrived ? ' is-hidden' : '';
  const cellStateCls = soMaterialSubconCellClasses(parsed);
  const trackerTitle = soMaterialSubconTitle(pp);
  const legacyHtml = parsed.legacy
    ? `<span class="so-material-subcon-legacy" title="Previous note">${escapeHtml(parsed.legacy)}</span>`
    : '';
  return `
    <td class="so-material-subcon-cell${cellStateCls}" data-pp-voucher-no="${escapeHtml(ppNo)}" data-last-saved="${escapeHtml(raw)}"${trackerTitle ? ` title="${escapeHtml(trackerTitle)}"` : ''}>
      <div class="so-material-subcon-controls">
        <button type="button"
          class="so-material-subcon-arrived${arrivedCls}"
          data-action="toggle-subcon-arrived"
          aria-pressed="${parsed.arrived ? 'true' : 'false'}"
          title="${trackerTitle || (parsed.arrived ? 'Material arrived — click to clear (updates planner)' : 'Mark material as arrived (updates planner)')}">
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

function soProposedEddPsBase(pp) {
  return String(pp?.process_sheet_no || pp?.pp_voucher_no || '').split('::')[0].trim();
}

function soProposedEddPsId(pp, partial) {
  const base = soProposedEddPsBase(pp);
  if (!base) return '';
  const partialNo = soPartialNo(partial);
  return partialNo > 1 ? `${base}::${partialNo}` : base;
}

function soRenderProposedEddCell(pp, partial) {
  const ppNo = String(pp?.pp_voucher_no || '').trim();
  const psId = soProposedEddPsId(pp, partial);
  const value = String(soProposedEddDisplay(pp, partial) || '').slice(0, 10);
  const editable = Boolean(psId) && !pp?.assembly_synthetic;
  if (!editable) {
    return `<td class="new-orders-date so-coway-edd-cell"><span class="so-coway-edd-static">${escapeHtml(soFormatDate(value))}</span></td>`;
  }
  return `
    <td class="new-orders-date so-coway-edd-cell">
      <input type="date"
        class="so-coway-edd-input"
        value="${escapeHtml(value)}"
        data-pp-voucher-no="${escapeHtml(ppNo)}"
        data-ps-id="${escapeHtml(psId)}"
        data-partial-no="${escapeHtml(String(soPartialNo(partial)))}"
        data-last-saved="${escapeHtml(value)}"
        aria-label="Proposed EDD">
      <span class="so-editable-status" aria-live="polite"></span>
    </td>
  `;
}

function soRenderProgramFinishCell(pp, _partial) {
  const ppNo = String(pp?.pp_voucher_no || '').trim();
  const psBase = soProposedEddPsBase(pp);
  const value = soProgramFinishDisplay(pp);
  const editable = Boolean(psBase) && !pp?.assembly_synthetic;
  if (!editable) {
    return `<td class="new-orders-date so-program-finish-cell"><span class="so-program-finish-static">${escapeHtml(soFormatDate(value))}</span></td>`;
  }
  return `
    <td class="new-orders-date so-program-finish-cell">
      <input type="date"
        class="so-program-finish-input"
        value="${escapeHtml(value)}"
        data-pp-voucher-no="${escapeHtml(ppNo)}"
        data-ps-base="${escapeHtml(psBase)}"
        data-last-saved="${escapeHtml(value)}"
        aria-label="Programme finish"
        title="Same date as Finish on NPI/FA Management — New parts">
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

function soExceptionIssuesMap(pp) {
  const raw = pp?.exception_issues;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function soPartialExceptionIssues(pp, partial) {
  const partialNo = soPartialNo(partial);
  const issues = soExceptionIssuesMap(pp);
  const fromMap = soNormalizeExceptionIssues(issues[partialNo] ?? issues[String(partialNo)]);
  if (fromMap.length) return fromMap;
  return soIsPartialException(pp, partial) ? ['others'] : [];
}

function soPartialExceptionIssue(pp, partial) {
  return soPartialExceptionIssues(pp, partial)[0] || '';
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

function soSetPartialExceptionIssues(pp, partialNo, issueIds) {
  if (!pp) return;
  const next = soNormalizeExceptionIssues(issueIds);
  const issues = { ...soExceptionIssuesMap(pp) };
  delete issues[partialNo];
  delete issues[String(partialNo)];
  if (next.length) issues[String(partialNo)] = next;
  pp.exception_issues = issues;
  soSetPartialException(pp, partialNo, next.length > 0);
}

function soExceptionKey(ppNo, partialNo) {
  return `${String(ppNo || '').trim()}::${Math.max(1, Number(partialNo) || 1)}`;
}

function soExceptionChipsHtml(ids) {
  const selected = soNormalizeExceptionIssues(ids);
  if (!selected.length) return '<span class="so-dash">—</span>';
  return selected.map(id => (
    `<span class="so-exception-chip so-exception-chip--${escapeHtml(id)}">${escapeHtml(soExceptionIssueLabel(id))}</span>`
  )).join('');
}

function soRenderExceptionCell(pp, partial) {
  if (pp?.assembly_synthetic) {
    return `<td class="so-exception-cell"><span class="so-dash">—</span></td>`;
  }
  const ppNo = String(pp?.pp_voucher_no || '').trim();
  const partialNo = soPartialNo(partial);
  const issues = soPartialExceptionIssues(pp, partial);
  const open = soState.openExceptionKey === soExceptionKey(ppNo, partialNo);
  const label = soExceptionIssuesLabel(issues);
  const title = label ? `${label} — click to change` : 'Choose exception categories';
  return `
    <td class="so-exception-cell${issues.length ? ' is-active' : ''}" data-issues="${escapeHtml(issues.join(','))}">
      <button type="button"
        class="so-exception-btn${issues.length ? ' has-value' : ''}${open ? ' is-open' : ''}"
        data-pp-voucher-no="${escapeHtml(ppNo)}"
        data-partial-no="${partialNo}"
        aria-haspopup="listbox"
        aria-expanded="${open ? 'true' : 'false'}"
        aria-label="Exception issues"
        title="${escapeHtml(title)}">
        <span class="so-exception-btn-value">${soExceptionChipsHtml(issues)}</span>
        <span class="so-exception-btn-caret" aria-hidden="true">▾</span>
      </button>
      <span class="so-exception-status" aria-live="polite"></span>
    </td>
  `;
}

function soRenderPartialCell(partial) {
  return `<td class="new-orders-num so-partial-cell">${escapeHtml(String(partial?.pp_partial_no ?? '—'))}</td>`;
}

function soRenderPartCell(order, pp, partial, leaf) {
  const part = partial?.inventory_code || pp?.inventory_code || '—';
  const faBadge = soRenderFrameAgreementBadge(pp, partial);
  const newBadge = leaf?.assemblyChild ? '' : soRenderNewPartBadge(order, pp);
  const faClass = faBadge ? ' so-part-cell--fa' : '';
  return `<td class="new-orders-num so-part-cell${faClass}"><span class="so-part-text">${escapeHtml(String(part))}</span>${newBadge}${faBadge}</td>`;
}

function soRenderLeafRow(leaf, { includeSideRail, sideRowSpan, groupStart, shadeAlt }) {
  const { order, pp, partial, assemblyChild, assemblyChildCount } = leaf;
  const key = soPartialKey(order, pp, partial);
  const selected = key === soState.selectedKey;
  const sideRail = includeSideRail ? soRenderSideRail(order, sideRowSpan, { shadeAlt }) : '';
  const processSheetCell = soRenderProcessSheetCell(order, pp, partial, leaf);
  const orderDateCell = soRenderOrderDateCell(pp);
  const startClass = groupStart ? ' new-orders-group-start' : '';
  const queuedMark = soIsPartialQueued(pp, partial) ? ' is-ps-queued-mark' : '';
  const exceptionMark = soPartialExceptionIssues(pp, partial).length ? ' is-so-exception' : '';
  const asmMark = assemblyChild
    ? ' is-so-asm-child'
    : (Number(assemblyChildCount) > 0 ? ' is-so-asm-parent' : '');
  return `
    <tr class="new-orders-child-row is-clickable${startClass}${queuedMark}${exceptionMark}${asmMark}${selected ? ' is-selected' : ''}" data-sales-order="${escapeHtml(String(order.sales_order_no || ''))}" data-detail-key="${escapeHtml(key)}" title="Click for detail">
      ${sideRail}
      ${processSheetCell}
      ${soRenderPartialCell(partial)}
      ${soRenderPartialQtyCell(pp, partial)}
      ${soRenderExceptionCell(pp, partial)}
      ${soRenderQueuedCncCell(pp, partial)}
      ${soRenderProposedCncCell(pp, partial)}
      ${soRenderStageCell(pp, partial)}
      ${soRenderQtyCell(pp)}
      ${orderDateCell}
      ${soRenderPartCell(order, pp, partial, leaf)}
      ${soRenderPpCells(pp, partial)}
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
  const status = control?.closest('.so-editable-cell, .so-material-subcon-cell, .so-need-date-cell, .so-coway-edd-cell, .so-program-finish-cell')?.querySelector('.so-editable-status');
  if (!status) return;
  status.className = `so-editable-status${state ? ` is-${state}` : ''}`;
  status.textContent = message || '';
}

function soSyncMaterialSubconCell(cell, raw) {
  if (!cell) return;
  const parsed = soParseMaterialSubcon(raw);
  soApplyMaterialSubconCellState(cell, parsed);
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
      found.pp.assembly_material_subcon = saved;
      if (Object.prototype.hasOwnProperty.call(data, 'material_in')) {
        found.pp.material_in = Boolean(data.material_in);
        found.pp.material_in_date = data.material_in_date || null;
      } else {
        const parsed = soParseMaterialSubcon(saved);
        found.pp.material_in = parsed.arrived;
        if (!parsed.arrived) found.pp.material_in_date = null;
      }
    }
    soPatchAssemblyChildNotes(ppNo, { material_subcon: saved });
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

function soUpdateProposedEddModel(ppNo, partialNo, savedValue) {
  const found = soFindPp(ppNo);
  if (!found.pp) return;
  const target = Math.max(1, Number(partialNo) || 1);
  const partials = Array.isArray(found.pp.partials) ? found.pp.partials : [];
  const match = partials.find(row => soPartialNo(row) === target);
  if (match) match.coway_proposed_edd = savedValue;
  if (!partials.length || target === 1) found.pp.coway_proposed_edd = savedValue;
}

async function soSaveProposedEdd(input) {
  const cell = input?.closest('.so-coway-edd-cell');
  const ppNo = String(input?.dataset?.ppVoucherNo || '').trim();
  const psId = String(input?.dataset?.psId || '').trim();
  const partialNo = Math.max(1, Number(input?.dataset?.partialNo) || 1);
  if (!psId) return;

  const nextValue = String(input.value || '').slice(0, 10);
  const lastSaved = String(input.dataset.lastSaved || '');
  if (nextValue === lastSaved) return;

  const key = `${psId}::coway_proposed_edd`;
  if (soState.saveInFlight.has(key)) return;

  soState.saveInFlight.add(key);
  input.disabled = true;
  soSetSaveStatus(input, 'saving', 'Saving…');
  try {
    const res = await fetch('/api/process-sheets/coway-proposed-edd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ps_id: psId, coway_proposed_edd: nextValue || null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const saved = String(data.coway_proposed_edd || '').slice(0, 10);
    input.value = saved;
    input.dataset.lastSaved = saved;
    soUpdateProposedEddModel(ppNo, partialNo, saved);
    const found = soFindPp(ppNo);
    const weekCell = input.closest('tr')?.querySelector('.so-week-cell');
    if (weekCell && found.pp) {
      const partial = (Array.isArray(found.pp.partials) ? found.pp.partials : [])
        .find(row => soPartialNo(row) === partialNo) || null;
      weekCell.textContent = soWeekLabel(found.pp, partial);
    }
    soSetSaveStatus(input, 'saved', 'Saved');
    window.setTimeout(() => {
      if (input.dataset.lastSaved === saved) soSetSaveStatus(input, '', '');
    }, 1500);
  } catch (err) {
    input.value = lastSaved;
    soSetSaveStatus(input, 'error', err.message || 'Save failed');
  } finally {
    input.disabled = false;
    soState.saveInFlight.delete(key);
  }
}

function soUpdateProgramFinishModel(psBase, savedValue) {
  const target = String(psBase || '').trim().toUpperCase();
  if (!target) return;
  soAllOrders().forEach(order => {
    (order.pp_vouchers || []).forEach(pp => {
      if (soProposedEddPsBase(pp).toUpperCase() === target) {
        pp.program_finish_at = savedValue;
      }
    });
  });
}

function soSyncProgramFinishInputs(psBase, savedValue) {
  const target = String(psBase || '').trim();
  document.querySelectorAll('.so-program-finish-input').forEach(input => {
    if (String(input.dataset.psBase || '').trim() !== target) return;
    input.value = savedValue;
    input.dataset.lastSaved = savedValue;
  });
}

async function soSaveProgramFinish(input) {
  const cell = input?.closest('.so-program-finish-cell');
  const ppNo = String(input?.dataset?.ppVoucherNo || '').trim();
  const psBase = String(input?.dataset?.psBase || '').trim();
  if (!psBase) return;

  const nextValue = String(input.value || '').slice(0, 10);
  const lastSaved = String(input.dataset.lastSaved || '');
  if (nextValue === lastSaved) return;

  const key = `${psBase}::program_finish_at`;
  if (soState.saveInFlight.has(key)) return;

  soState.saveInFlight.add(key);
  input.disabled = true;
  soSetSaveStatus(input, 'saving', 'Saving…');
  try {
    const data = await soPostJson('/api/first-article/new-parts', {
      process_sheet_no: psBase,
      pp_voucher_no: ppNo || undefined,
      program_finish_at: nextValue || '',
    });
    const saved = soDateInputValue(data.row?.program_finish_at ?? data.program_finish_at);
    soSyncProgramFinishInputs(psBase, saved);
    soUpdateProgramFinishModel(psBase, saved);
    soSetSaveStatus(cell || input, 'saved', 'Saved');
    window.setTimeout(() => {
      if (String(input.dataset.lastSaved || '') === saved) soSetSaveStatus(input, '', '');
    }, 1500);
  } catch (err) {
    input.value = lastSaved;
    soSetSaveStatus(input, 'error', err.message || 'Save failed');
  } finally {
    input.disabled = false;
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
    soPatchAssemblyChildNotes(ppNo, { [field]: saved });
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

function soExceptionPopover() {
  return document.getElementById('so-exception-popover');
}

function soCloseExceptionPopover() {
  const key = soState.openExceptionKey;
  const pop = soExceptionPopover();
  if (pop) pop.hidden = true;
  soState.openExceptionKey = '';
  document.querySelectorAll('.so-exception-btn.is-open').forEach(btn => {
    btn.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
  });
  if (!key) return;
  const [ppNo, partialRaw] = key.split('::');
  const partialNo = Math.max(1, Number(partialRaw) || 1);
  const found = soFindPp(ppNo);
  soSyncExceptionButtons(ppNo, partialNo, soPartialExceptionIssues(found?.pp, { pp_partial_no: partialNo }));
  soFlushExceptionSaveNow(ppNo, partialNo);
}

function soRepositionExceptionPopover() {
  const pop = soExceptionPopover();
  if (!pop || pop.hidden || !soState.openExceptionKey) return;
  const [ppNo, partialRaw] = soState.openExceptionKey.split('::');
  const btn = document.querySelector(
    `.so-exception-btn[data-pp-voucher-no="${CSS.escape(ppNo)}"][data-partial-no="${CSS.escape(partialRaw)}"]`
  );
  if (!btn) {
    soCloseExceptionPopover();
    return;
  }
  const rect = btn.getBoundingClientRect();
  const width = Math.max(200, Math.min(240, window.innerWidth - 16));
  let left = rect.left;
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
  let top = rect.bottom + 4;
  if (top + 220 > window.innerHeight && rect.top > 180) {
    top = Math.max(8, rect.top - 220);
  }
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.width = `${width}px`;
}

function soSetExceptionStatus(ppNo, partialNo, state, message) {
  document.querySelectorAll(
    `.so-exception-btn[data-pp-voucher-no="${CSS.escape(ppNo)}"][data-partial-no="${CSS.escape(String(partialNo))}"]`
  ).forEach(btn => {
    const status = btn.closest('.so-exception-cell')?.querySelector('.so-exception-status');
    if (!status) return;
    status.className = `so-exception-status${state ? ` is-${state}` : ''}`;
    status.textContent = message || '';
  });
}

function soSyncExceptionButtons(ppNo, partialNo, issueIds) {
  const selected = soNormalizeExceptionIssues(issueIds);
  const flagged = selected.length > 0;
  const key = soExceptionKey(ppNo, partialNo);
  const label = soExceptionIssuesLabel(selected);
  document.querySelectorAll(
    `.so-exception-btn[data-pp-voucher-no="${CSS.escape(ppNo)}"][data-partial-no="${CSS.escape(String(partialNo))}"]`
  ).forEach(btn => {
    const value = btn.querySelector('.so-exception-btn-value');
    btn.classList.toggle('has-value', flagged);
    btn.classList.toggle('is-open', soState.openExceptionKey === key);
    btn.setAttribute('aria-expanded', soState.openExceptionKey === key ? 'true' : 'false');
    btn.title = label ? `${label} — click to change` : 'Choose exception categories';
    const cell = btn.closest('.so-exception-cell');
    if (cell) {
      cell.classList.toggle('is-active', flagged);
      cell.dataset.issues = selected.join(',');
    }
    const row = btn.closest('tr');
    if (row) row.classList.toggle('is-so-exception', flagged);
    if (value && soState.openExceptionKey !== key) {
      value.innerHTML = soExceptionChipsHtml(selected);
    }
  });
}

function soSavedExceptionIssues(data, partialNo, fallback) {
  const issues = data?.exception_issues && typeof data.exception_issues === 'object'
    ? data.exception_issues
    : {};
  const fromMap = soNormalizeExceptionIssues(issues[partialNo] ?? issues[String(partialNo)]);
  if (fromMap.length) return fromMap;
  const highlighted = Array.isArray(data?.highlighted_partials)
    ? data.highlighted_partials.includes(partialNo)
    : false;
  if (highlighted) return ['others'];
  return soNormalizeExceptionIssues(fallback);
}

function soRenderExceptionPopover() {
  const pop = soExceptionPopover();
  const key = soState.openExceptionKey;
  if (!pop || !key) return;
  const [ppNo, partialRaw] = key.split('::');
  const partialNo = Math.max(1, Number(partialRaw) || 1);
  const found = soFindPp(ppNo);
  const selected = new Set(soPartialExceptionIssues(found?.pp, { pp_partial_no: partialNo }));
  const checks = SO_EXCEPTION_ISSUES.map(item => {
    const checked = selected.has(item.id) ? ' checked' : '';
    return `<label class="so-col-filter-check so-exception-check">
      <input type="checkbox" data-so-exception-issue="${escapeHtml(item.id)}"${checked} />
      ${escapeHtml(item.label)}
    </label>`;
  }).join('');
  pop.innerHTML = `
    <div class="so-col-filter-title">Exception</div>
    <div class="so-exception-checks">${checks}</div>
    <div class="so-col-filter-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-action="clear-exception">Clear</button>
    </div>
  `;
  pop.hidden = false;
  soRepositionExceptionPopover();
}

function soOpenExceptionPopover(btn) {
  const ppNo = String(btn?.dataset?.ppVoucherNo || '').trim();
  const partialNo = Math.max(1, Number(btn?.dataset?.partialNo) || 1);
  const key = soExceptionKey(ppNo, partialNo);
  if (!ppNo) return;
  if (soState.openExceptionKey === key && soExceptionPopover() && !soExceptionPopover().hidden) {
    soCloseExceptionPopover();
    return;
  }
  if (soState.openExceptionKey) soCloseExceptionPopover();
  soCloseColumnFilter();
  soCloseProposedCncPopover();
  soState.openExceptionKey = key;
  document.querySelectorAll('.so-exception-btn.is-open').forEach(el => {
    el.classList.remove('is-open');
    el.setAttribute('aria-expanded', 'false');
  });
  btn.classList.add('is-open');
  btn.setAttribute('aria-expanded', 'true');
  soRenderExceptionPopover();
}

const SO_PICKER_SAVE_DELAY_MS = 140;
const soExceptionSavePending = new Map();
const soExceptionSaveTimers = new Map();
const soExceptionStatusToken = new Map();
const soProposedCncSavePending = new Map();
const soProposedCncSaveTimers = new Map();
const soProposedCncStatusToken = new Map();

function soBumpPickerStatus(tokens, key) {
  const token = (tokens.get(key) || 0) + 1;
  tokens.set(key, token);
  return token;
}

function soSyncExceptionPopoverChecks(issueIds) {
  const pop = soExceptionPopover();
  if (!pop || pop.hidden) return;
  const selected = new Set(soNormalizeExceptionIssues(issueIds));
  pop.querySelectorAll('[data-so-exception-issue]').forEach(input => {
    const on = selected.has(input.getAttribute('data-so-exception-issue'));
    if (input.checked !== on) input.checked = on;
  });
}

function soQueueExceptionSave(ppNo, partialNo, issueIds) {
  const next = soNormalizeExceptionIssues(issueIds);
  const saveKey = `${ppNo}::exception::${partialNo}`;
  if (!ppNo) return;
  const found = soFindPp(ppNo);
  soSetPartialExceptionIssues(found?.pp, partialNo, next);
  soSyncExceptionButtons(ppNo, partialNo, next);
  if (soState.openExceptionKey === soExceptionKey(ppNo, partialNo)) {
    soSyncExceptionPopoverChecks(next);
  }
  soExceptionSavePending.set(saveKey, next.slice());
  const prev = soExceptionSaveTimers.get(saveKey);
  if (prev) window.clearTimeout(prev);
  soExceptionSaveTimers.set(saveKey, window.setTimeout(() => {
    soExceptionSaveTimers.delete(saveKey);
    soFlushExceptionSave(ppNo, partialNo);
  }, SO_PICKER_SAVE_DELAY_MS));
}

async function soFlushExceptionSave(ppNo, partialNo) {
  const saveKey = `${ppNo}::exception::${partialNo}`;
  if (soState.saveInFlight.has(saveKey) || !soExceptionSavePending.has(saveKey)) return;
  const next = soExceptionSavePending.get(saveKey).slice();
  soExceptionSavePending.delete(saveKey);
  soState.saveInFlight.add(saveKey);
  const statusToken = soBumpPickerStatus(soExceptionStatusToken, saveKey);
  soSetExceptionStatus(ppNo, partialNo, 'saving', 'Saving…');
  try {
    const data = await soPostJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, {
      partial_highlight: {
        pp_partial_no: partialNo,
        highlighted: next.length > 0,
        issues: next,
      },
    });
    if (soExceptionSavePending.has(saveKey)) return;
    const found = soFindPp(ppNo);
    if (found?.pp) {
      found.pp.highlighted_partials = Array.isArray(data.highlighted_partials)
        ? data.highlighted_partials
        : [];
      found.pp.ps_highlighted = Boolean(data.ps_highlighted);
      found.pp.exception_issues = data.exception_issues && typeof data.exception_issues === 'object'
        ? data.exception_issues
        : {};
    }
    const saved = soSavedExceptionIssues(data, partialNo, next);
    soSetPartialExceptionIssues(found?.pp, partialNo, saved);
    soSyncExceptionButtons(ppNo, partialNo, saved);
    if (soState.openExceptionKey === soExceptionKey(ppNo, partialNo)) {
      soSyncExceptionPopoverChecks(saved);
    }
    if (soExceptionStatusToken.get(saveKey) !== statusToken) return;
    soSetExceptionStatus(ppNo, partialNo, 'saved', saved.length ? soExceptionIssuesLabel(saved) : 'Cleared');
    window.setTimeout(() => {
      if (soExceptionStatusToken.get(saveKey) !== statusToken) return;
      soSetExceptionStatus(ppNo, partialNo, '', '');
    }, 1500);
  } catch (err) {
    if (soExceptionSavePending.has(saveKey) || soExceptionStatusToken.get(saveKey) !== statusToken) return;
    soSetExceptionStatus(ppNo, partialNo, 'error', err.message || 'Save failed');
  } finally {
    soState.saveInFlight.delete(saveKey);
    if (soExceptionSavePending.has(saveKey)) soFlushExceptionSave(ppNo, partialNo);
  }
}

function soFlushExceptionSaveNow(ppNo, partialNo) {
  const saveKey = `${ppNo}::exception::${partialNo}`;
  const prev = soExceptionSaveTimers.get(saveKey);
  if (prev) {
    window.clearTimeout(prev);
    soExceptionSaveTimers.delete(saveKey);
  }
  soFlushExceptionSave(ppNo, partialNo);
}

function soSaveExceptionIssues(ppNo, partialNo, issueIds) {
  soQueueExceptionSave(ppNo, partialNo, issueIds);
}

function soToggleExceptionIssue(ppNo, partialNo, issue, checked) {
  const found = soFindPp(ppNo);
  const current = soPartialExceptionIssues(found?.pp, { pp_partial_no: partialNo });
  const next = new Set(current);
  const id = soNormalizeExceptionIssue(issue);
  if (!id) return;
  if (checked) next.add(id);
  else next.delete(id);
  soSaveExceptionIssues(ppNo, partialNo, [...next]);
}

function soBindExceptionFlags() {
  const body = document.getElementById('so-table-body');
  if (body && body.dataset.exceptionBound !== '1') {
    body.dataset.exceptionBound = '1';
    body.addEventListener('click', e => {
      const btn = e.target.closest('.so-exception-btn');
      if (!btn) {
        if (e.target.closest('.so-exception-cell')) e.stopPropagation();
        return;
      }
      e.stopPropagation();
      soOpenExceptionPopover(btn);
    });
  }

  const pop = soExceptionPopover();
  if (!pop || pop.dataset.bound === '1') return;
  pop.dataset.bound = '1';
  pop.addEventListener('click', e => e.stopPropagation());
  pop.addEventListener('change', e => {
    const input = e.target.closest('[data-so-exception-issue]');
    if (!input) return;
    const key = soState.openExceptionKey;
    if (!key) return;
    const [ppNo, partialRaw] = key.split('::');
    soToggleExceptionIssue(ppNo, Math.max(1, Number(partialRaw) || 1), input.getAttribute('data-so-exception-issue'), input.checked);
  });
  pop.addEventListener('click', e => {
    const clearBtn = e.target.closest('[data-action="clear-exception"]');
    if (!clearBtn) return;
    const key = soState.openExceptionKey;
    if (!key) return;
    const [ppNo, partialRaw] = key.split('::');
    soSaveExceptionIssues(ppNo, Math.max(1, Number(partialRaw) || 1), []);
  });
  document.addEventListener('click', e => {
    const popEl = soExceptionPopover();
    if (!popEl || popEl.hidden) return;
    if (popEl.contains(e.target) || e.target.closest('.so-exception-btn')) return;
    soCloseExceptionPopover();
  });
  window.addEventListener('resize', soRepositionExceptionPopover);
  document.getElementById('so-table-wrap')?.addEventListener('scroll', soRepositionExceptionPopover, { passive: true });
}

function soProposedCncPopover() {
  return document.getElementById('so-proposed-cnc-popover');
}

function soCloseProposedCncPopover() {
  const ppNo = soState.openProposedCncPp;
  const pop = soProposedCncPopover();
  if (pop) pop.hidden = true;
  soState.openProposedCncPp = '';
  soState.proposedCncQuery = '';
  document.querySelectorAll('.so-proposed-cnc-btn.is-open').forEach(btn => {
    btn.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
  });
  if (!ppNo) return;
  const found = soFindPp(ppNo);
  soSyncProposedCncButtons(ppNo, soProposedCncMachines(found?.pp));
  soFlushProposedCncNow(ppNo);
}

function soRepositionProposedCncPopover() {
  const pop = soProposedCncPopover();
  if (!pop || pop.hidden || !soState.openProposedCncPp) return;
  const btn = document.querySelector(
    `.so-proposed-cnc-btn[data-pp-voucher-no="${CSS.escape(soState.openProposedCncPp)}"]`
  );
  if (!btn) {
    soCloseProposedCncPopover();
    return;
  }
  const rect = btn.getBoundingClientRect();
  const width = Math.max(220, Math.min(280, window.innerWidth - 16));
  let left = rect.left;
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
  let top = rect.bottom + 4;
  const maxHeight = 320;
  if (top + 180 > window.innerHeight && rect.top > 200) {
    top = Math.max(8, rect.top - Math.min(maxHeight, 280) - 4);
  }
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.width = `${width}px`;
}

function soSetProposedCncStatus(ppNo, state, message) {
  document.querySelectorAll(`.so-proposed-cnc-btn[data-pp-voucher-no="${CSS.escape(ppNo)}"]`).forEach(btn => {
    const status = btn.closest('.so-proposed-cnc-cell')?.querySelector('.so-proposed-cnc-status');
    if (!status) return;
    status.className = `so-proposed-cnc-status so-editable-status${state ? ` is-${state}` : ''}`;
    status.textContent = message || '';
  });
}

function soSyncProposedCncButtons(ppNo, machines) {
  const menuOpen = soState.openProposedCncPp === ppNo;
  document.querySelectorAll(`.so-proposed-cnc-btn[data-pp-voucher-no="${CSS.escape(ppNo)}"]`).forEach(btn => {
    const value = btn.querySelector('.so-proposed-cnc-btn-value');
    if (value && !menuOpen) {
      value.innerHTML = machines.length
        ? soRenderProposedCncHtml(machines)
        : '<span class="so-dash">—</span>';
    }
    btn.classList.toggle('has-value', machines.length > 0);
    btn.classList.toggle('is-open', menuOpen);
    btn.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
  });
}

function soApplyProposedCncLocal(ppNo, machines) {
  const found = soFindPp(ppNo);
  if (found?.pp) {
    found.pp.proposed_cnc = machines;
    found.pp.proposed_cnc_saved = machines;
    (found.pp.partials || []).forEach(partial => {
      partial.proposed_cnc = [...machines];
    });
  }
  soSyncProposedCncButtons(ppNo, machines);
}

function soRenderProposedCncPopover() {
  const pop = soProposedCncPopover();
  const ppNo = soState.openProposedCncPp;
  if (!pop || !ppNo) return;
  const found = soFindPp(ppNo);
  const selected = soProposedCncMachines(found?.pp);
  const selectedSet = soProposedCncSelectedSet(selected);
  const query = String(soState.proposedCncQuery || '').trim().toLowerCase();
  const catalog = soCncMachineCatalog(selected).filter(name => (
    !query || name.toLowerCase().includes(query) || soCncMachineNumber(name).toString() === query
  ));
  const checks = catalog.length
    ? catalog.map(name => {
      const checked = selectedSet.has(name.toUpperCase()) ? ' checked' : '';
      return `<label class="so-col-filter-check so-proposed-cnc-check">
        <input type="checkbox" data-so-cnc-machine="${escapeHtml(name)}"${checked} />
        ${escapeHtml(name)}
      </label>`;
    }).join('')
    : '<p class="so-proposed-cnc-empty">No matching CNC machines</p>';
  pop.innerHTML = `
    <div class="so-col-filter-title">Proposed CNC</div>
    <input type="search" class="so-col-filter-input so-proposed-cnc-search" value="${escapeHtml(soState.proposedCncQuery || '')}" placeholder="Search or type CNC…" autocomplete="off" />
    <div class="so-proposed-cnc-checks">${checks}</div>
    <form class="so-proposed-cnc-add" data-action="add-proposed-cnc">
      <input type="text" class="so-col-filter-input so-proposed-cnc-add-input" placeholder="Add CNC 22" autocomplete="off" />
      <button type="submit" class="btn btn-ghost btn-sm">Add</button>
    </form>
    <div class="so-col-filter-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-action="clear-proposed-cnc">Clear</button>
    </div>
  `;
  pop.hidden = false;
  soRepositionProposedCncPopover();
}

function soOpenProposedCncPopover(btn) {
  const ppNo = String(btn?.dataset?.ppVoucherNo || '').trim();
  if (!ppNo) return;
  if (soState.openProposedCncPp === ppNo && soProposedCncPopover() && !soProposedCncPopover().hidden) {
    soCloseProposedCncPopover();
    return;
  }
  if (soState.openProposedCncPp) soCloseProposedCncPopover();
  soCloseColumnFilter();
  soCloseExceptionPopover();
  soState.openProposedCncPp = ppNo;
  soState.proposedCncQuery = '';
  document.querySelectorAll('.so-proposed-cnc-btn.is-open').forEach(el => {
    el.classList.remove('is-open');
    el.setAttribute('aria-expanded', 'false');
  });
  btn.classList.add('is-open');
  btn.setAttribute('aria-expanded', 'true');
  soRenderProposedCncPopover();
  soProposedCncPopover()?.querySelector('.so-proposed-cnc-search')?.focus();
}

function soSyncProposedCncPopoverChecks(machines) {
  const pop = soProposedCncPopover();
  if (!pop || pop.hidden) return;
  const selected = soProposedCncSelectedSet(machines);
  pop.querySelectorAll('[data-so-cnc-machine]').forEach(input => {
    const key = soNormalizeCncMachine(input.getAttribute('data-so-cnc-machine')).toUpperCase();
    const on = selected.has(key);
    if (input.checked !== on) input.checked = on;
  });
}

function soRevealProposedCncMachine(name) {
  const pop = soProposedCncPopover();
  if (!pop || pop.hidden) return;
  const normalized = soNormalizeCncMachine(name);
  if (!normalized) return;
  const query = String(soState.proposedCncQuery || '').trim().toLowerCase();
  const visible = !query
    || normalized.toLowerCase().includes(query)
    || String(soCncMachineNumber(normalized)) === query;
  const key = normalized.toUpperCase();
  const exists = [...pop.querySelectorAll('[data-so-cnc-machine]')].some(input => (
    soNormalizeCncMachine(input.getAttribute('data-so-cnc-machine')).toUpperCase() === key
  ));
  if (exists && visible) return;
  if (!visible) soState.proposedCncQuery = '';
  soRenderProposedCncPopover();
}

function soQueueProposedCnc(ppNo, machines, reveal) {
  const next = (machines || []).map(soNormalizeCncMachine).filter(Boolean);
  const saveKey = `${ppNo}::proposed_cnc`;
  if (!ppNo) return;
  soApplyProposedCncLocal(ppNo, next);
  if (soState.openProposedCncPp === ppNo) {
    soSyncProposedCncPopoverChecks(next);
    if (reveal) soRevealProposedCncMachine(reveal);
  }
  soProposedCncSavePending.set(saveKey, next.slice());
  const prev = soProposedCncSaveTimers.get(saveKey);
  if (prev) window.clearTimeout(prev);
  soProposedCncSaveTimers.set(saveKey, window.setTimeout(() => {
    soProposedCncSaveTimers.delete(saveKey);
    soFlushProposedCnc(ppNo);
  }, SO_PICKER_SAVE_DELAY_MS));
}

async function soFlushProposedCnc(ppNo) {
  const saveKey = `${ppNo}::proposed_cnc`;
  if (soState.saveInFlight.has(saveKey) || !soProposedCncSavePending.has(saveKey)) return;
  const next = soProposedCncSavePending.get(saveKey).slice();
  soProposedCncSavePending.delete(saveKey);
  soState.saveInFlight.add(saveKey);
  const statusToken = soBumpPickerStatus(soProposedCncStatusToken, saveKey);
  soSetProposedCncStatus(ppNo, 'saving', 'Saving…');
  try {
    const data = await soPostJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, {
      proposed_cnc: next,
    });
    if (soProposedCncSavePending.has(saveKey)) return;
    const saved = Array.isArray(data.proposed_cnc) ? data.proposed_cnc.filter(Boolean) : next;
    soApplyProposedCncLocal(ppNo, saved);
    if (soState.openProposedCncPp === ppNo) soSyncProposedCncPopoverChecks(saved);
    if (soProposedCncStatusToken.get(saveKey) !== statusToken) return;
    soSetProposedCncStatus(ppNo, 'saved', 'Saved');
    window.setTimeout(() => {
      if (soProposedCncStatusToken.get(saveKey) !== statusToken) return;
      soSetProposedCncStatus(ppNo, '', '');
    }, 1500);
  } catch (err) {
    if (soProposedCncSavePending.has(saveKey) || soProposedCncStatusToken.get(saveKey) !== statusToken) return;
    soSetProposedCncStatus(ppNo, 'error', err.message || 'Save failed');
  } finally {
    soState.saveInFlight.delete(saveKey);
    if (soProposedCncSavePending.has(saveKey)) soFlushProposedCnc(ppNo);
  }
}

function soFlushProposedCncNow(ppNo) {
  const saveKey = `${ppNo}::proposed_cnc`;
  const prev = soProposedCncSaveTimers.get(saveKey);
  if (prev) {
    window.clearTimeout(prev);
    soProposedCncSaveTimers.delete(saveKey);
  }
  soFlushProposedCnc(ppNo);
}

function soSaveProposedCnc(ppNo, machines, reveal) {
  soQueueProposedCnc(ppNo, machines, reveal);
}

function soToggleProposedCncMachine(ppNo, machine, checked) {
  const found = soFindPp(ppNo);
  const current = soProposedCncMachines(found?.pp);
  const next = [];
  const seen = new Set();
  current.forEach(item => {
    const name = soNormalizeCncMachine(item);
    const key = name.toUpperCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    next.push(name);
  });
  const added = soNormalizeCncMachine(machine);
  const key = added.toUpperCase();
  if (checked && added && !seen.has(key)) next.push(added);
  if (!checked) {
    soSaveProposedCnc(ppNo, next.filter(item => item.toUpperCase() !== key));
    return;
  }
  soSaveProposedCnc(ppNo, next, added);
}

function soBindProposedCncPicker() {
  const body = document.getElementById('so-table-body');
  if (body && body.dataset.proposedCncBound !== '1') {
    body.dataset.proposedCncBound = '1';
    body.addEventListener('click', e => {
      const btn = e.target.closest('.so-proposed-cnc-btn');
      if (!btn) return;
      e.stopPropagation();
      soOpenProposedCncPopover(btn);
    });
  }

  const pop = soProposedCncPopover();
  if (!pop || pop.dataset.bound === '1') return;
  pop.dataset.bound = '1';

  pop.addEventListener('click', e => e.stopPropagation());
  pop.addEventListener('change', e => {
    const input = e.target.closest('[data-so-cnc-machine]');
    if (!input) return;
    const ppNo = soState.openProposedCncPp;
    if (!ppNo) return;
    soToggleProposedCncMachine(ppNo, input.getAttribute('data-so-cnc-machine'), input.checked);
  });
  pop.addEventListener('input', e => {
    const search = e.target.closest('.so-proposed-cnc-search');
    if (!search) return;
    soState.proposedCncQuery = search.value || '';
    const active = document.activeElement === search;
    const start = search.selectionStart;
    soRenderProposedCncPopover();
    if (!active) return;
    const next = soProposedCncPopover()?.querySelector('.so-proposed-cnc-search');
    if (!next) return;
    next.focus();
    const pos = typeof start === 'number' ? start : next.value.length;
    next.setSelectionRange(pos, pos);
  });
  pop.addEventListener('submit', e => {
    const form = e.target.closest('[data-action="add-proposed-cnc"]');
    if (!form) return;
    e.preventDefault();
    const ppNo = soState.openProposedCncPp;
    const input = form.querySelector('.so-proposed-cnc-add-input');
    const typed = soNormalizeCncMachine(input?.value);
    if (!ppNo || !typed) return;
    soToggleProposedCncMachine(ppNo, typed, true);
    if (input) input.value = '';
  });
  pop.addEventListener('click', e => {
    const clearBtn = e.target.closest('[data-action="clear-proposed-cnc"]');
    if (!clearBtn) return;
    const ppNo = soState.openProposedCncPp;
    if (ppNo) soSaveProposedCnc(ppNo, []);
  });

  document.addEventListener('click', e => {
    const popEl = soProposedCncPopover();
    if (!popEl || popEl.hidden) return;
    if (popEl.contains(e.target) || e.target.closest('.so-proposed-cnc-btn')) return;
    soCloseProposedCncPopover();
  });
  window.addEventListener('resize', soRepositionProposedCncPopover);
  document.getElementById('so-table-wrap')?.addEventListener('scroll', soRepositionProposedCncPopover, { passive: true });
}

function soSyncNeedDateRows(ppNo, value) {
  const target = String(ppNo || '').trim();
  const saved = soDateInputValue(value);
  if (!target) return;
  document.querySelectorAll('.so-need-date-input').forEach(input => {
    if (String(input.dataset.ppVoucherNo || '').trim() !== target) return;
    input.value = saved;
    input.dataset.lastSaved = saved;
    const cell = input.closest('.so-need-date-cell');
    if (cell) cell.classList.toggle('has-need-date', Boolean(saved));
  });
}

async function soSaveNeedDate(input) {
  const ppNo = String(input?.dataset?.ppVoucherNo || '').trim();
  if (!ppNo) return;

  const nextValue = soDateInputValue(input.value);
  const lastSaved = String(input.dataset.lastSaved || '');
  const key = `${ppNo}::material_need_date`;
  if (nextValue === lastSaved || soState.saveInFlight.has(key)) return;

  soState.saveInFlight.add(key);
  soSetSaveStatus(input, 'saving', 'Saving…');
  try {
    const data = await soPostJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, {
      material_need_date: nextValue,
    });
    const saved = soDateInputValue(data.material_need_date);
    const found = soFindPp(ppNo);
    if (found.pp) found.pp.material_need_date = saved;
    soPatchAssemblyChildNotes(ppNo, { material_need_date: saved });
    soSyncNeedDateRows(ppNo, saved);
    soSetSaveStatus(input, 'saved', saved ? 'Saved' : 'Cleared');
    window.setTimeout(() => soSetSaveStatus(input, '', ''), 1500);
  } catch (err) {
    input.value = lastSaved;
    soSetSaveStatus(input, 'error', err.message || 'Save failed');
  } finally {
    soState.saveInFlight.delete(key);
  }
}

function soBindNeedDateInputs() {
  const body = document.getElementById('so-table-body');
  if (!body || body.dataset.needDateBound === '1') return;
  body.dataset.needDateBound = '1';

  body.addEventListener('change', e => {
    const input = e.target.closest('.so-need-date-input');
    if (!input || input.disabled) return;
    e.stopPropagation();
    soSaveNeedDate(input);
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
    soApplyMaterialSubconCellState(cell, { arrived: nextArrived, date });
    soSaveMaterialSubconCell(cell, soSerializeMaterialSubcon({ arrived: nextArrived, date }));
  });

  body.addEventListener('change', e => {
    const dateInput = e.target.closest('.so-material-subcon-date');
    if (!dateInput || dateInput.disabled) return;
    e.stopPropagation();
    const cell = dateInput.closest('.so-material-subcon-cell');
    if (!cell) return;
    const date = String(dateInput.value || '').trim();
    soApplyMaterialSubconCellState(cell, { arrived: false, date });
    soSaveMaterialSubconCell(cell, soSerializeMaterialSubcon({
      arrived: false,
      date,
    }));
  });
}

function soBindProposedEddInputs() {
  const body = document.getElementById('so-table-body');
  if (!body || body.dataset.cowayEddBound === '1') return;
  body.dataset.cowayEddBound = '1';

  body.addEventListener('change', e => {
    const input = e.target.closest('.so-coway-edd-input');
    if (!input || input.disabled) return;
    e.stopPropagation();
    soSaveProposedEdd(input);
  });
}

function soBindProgramFinishInputs() {
  const body = document.getElementById('so-table-body');
  if (!body || body.dataset.programFinishBound === '1') return;
  body.dataset.programFinishBound = '1';

  body.addEventListener('change', e => {
    const input = e.target.closest('.so-program-finish-input');
    if (!input || input.disabled) return;
    e.stopPropagation();
    soSaveProgramFinish(input);
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

/** No-WO job count for the tab badge — active PP vouchers with no WO raised (PP-level). */
function soFilteredNoWoJobCount(orders) {
  const seen = new Set();
  (orders || []).forEach(order => {
    soLeafRows(order).forEach(leaf => {
      if (!soLeafPassesPrefixFilter(leaf.pp)) return;
      if (!soPpIsNoWo(leaf.pp)) return;
      const key = `${order.sales_order_no}::${leaf.pp?.pp_voucher_no || ''}`;
      seen.add(key);
    });
  });
  return seen.size;
}

function soUpdateTabCounts() {
  const activeEl = document.getElementById('so-active-tab-count');
  const completeEl = document.getElementById('so-complete-tab-count');
  const noWoEl = document.getElementById('so-no-wo-tab-count');
  const activeJobs = soFilteredJobCount(soState.active);
  const completeJobs = soState.completeLoaded
    ? soFilteredJobCount(soState.complete)
    : (Number(soState.completeJobCount) || 0);
  const noWoJobs = soFilteredNoWoJobCount(soState.active);
  if (activeEl) {
    activeEl.textContent = String(activeJobs);
    activeEl.hidden = activeJobs === 0;
  }
  if (completeEl) {
    completeEl.textContent = String(completeJobs);
    completeEl.hidden = completeJobs === 0;
  }
  if (noWoEl) {
    noWoEl.textContent = String(noWoJobs);
    noWoEl.hidden = noWoJobs === 0;
  }
}

function soSetView(view) {
  const next = ['complete', 'no-wo'].includes(view) ? view : 'active';
  soState.view = next;
  soCloseDetail();
  soCloseMaterialModal();
  document.querySelectorAll('[data-so-view]').forEach(btn => {
    const active = btn.getAttribute('data-so-view') === next;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (next === 'complete' && !soState.completeLoaded) {
    soLoad({ refresh: false, includeComplete: true });
    return;
  }
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
  const viewLabel = soState.view === 'complete'
    ? 'Complete'
    : (soState.view === 'no-wo' ? 'No WO' : 'Active');
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
  const meta = document.getElementById('so-meta');

  const hasData = (soState.active?.length || 0) + (soState.complete?.length || 0) > 0;

  if (!orders.length) {
    let emptyMsg;
    if (!hasData) {
      emptyMsg = `No ${soState.view === 'complete' ? 'complete' : 'active'} sales orders in ERP.`;
    } else if (soState.ppTypes.size === 0) {
      emptyMsg = 'Select at least one PP prefix (APS, NPS, …).';
    } else if (soState.view === 'no-wo') {
      emptyMsg = 'No PP vouchers have qty awaiting WO issuance — every process sheet in view is fully issued.';
    } else {
      emptyMsg = 'No rows match your search or column filters — adjust filters in the column headers above.';
    }
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
    soBindEditableInputs();
    soBindExceptionFlags();
    soBindProposedCncPicker();
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
  soRepositionProposedCncPopover();
  soRepositionExceptionPopover();
  soSyncTableScrollWidth();
}

async function soLoad({ refresh = false, bustCache = false, includeComplete = false } = {}) {
  const wantsComplete = includeComplete || soState.view === 'complete';
  const hasData = wantsComplete
    ? ((soState.active?.length || 0) + (soState.complete?.length || 0) > 0)
    : ((soState.active?.length || 0) > 0);
  soSetLoading(true, {
    overlay: refresh && hasData,
    message: wantsComplete
      ? (refresh ? 'Refreshing complete S/O data…' : 'Loading complete S/O data…')
      : (refresh ? 'Refreshing S/O data from ERP…' : 'Loading S/O data from ERP…'),
  });
  soCloseDetail();
  soCloseMaterialModal();
  soCloseProposedCncPopover();
  soCloseExceptionPopover();

  const params = new URLSearchParams();
  if (refresh) params.set('refresh', '1');
  if (bustCache) params.set('_ts', String(Date.now()));
  // Active / No WO only need open jobs (~1MB). Complete is deferred until that tab opens.
  if (!wantsComplete) params.set('active_only', '1');

  let payload;
  try {
    const ordersRes = await fetch(`/api/sales-orders?${params}`);
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
    soState.repeatGroups = [];
  } catch (err) {
    soSetLoading(false);
    const empty = document.getElementById('so-empty');
    const emptyText = document.getElementById('so-empty-text');
    if (empty) empty.hidden = false;
    if (emptyText) emptyText.textContent = `Failed to load: ${err.message}`;
    return;
  }

  soState.active = Array.isArray(payload.active) ? payload.active : [];
  if (wantsComplete) {
    soState.complete = Array.isArray(payload.complete) ? payload.complete : [];
    soState.completeLoaded = true;
  } else if (refresh) {
    // Active refresh should not keep stale complete rows.
    soState.complete = [];
    soState.completeLoaded = false;
  }
  soState.cachedAt = payload.cached_at || '';
  soState.cacheTtlSec = Number(payload.cache_ttl_sec) || 300;
  soState.activeJobCount = Number(payload.active_job_count) || soBucketJobCount(soState.active);
  soState.completeJobCount = Number(payload.complete_job_count) || (
    soState.completeLoaded ? soBucketJobCount(soState.complete) : soState.completeJobCount
  );
  soState.ppCount = Number(payload.pp_count) || (soState.activeJobCount + soState.completeJobCount);
  soState.partialCount = Number(payload.partial_count) || 0;
  soState.missingHeaderCount = Number(payload.missing_header_count) || 0;
  const faParts = Array.isArray(payload.frame_agreement_parts) ? payload.frame_agreement_parts : [];
  soState.frameAgreementParts = new Set(faParts.map(soNormalizePartKey).filter(Boolean));
  if (Array.isArray(payload.cnc_machines) && payload.cnc_machines.length) {
    soState.cncMachines = payload.cnc_machines.filter(Boolean);
  }

  const orderTotal = soState.active.length + (soState.completeLoaded ? soState.complete.length : 0);
  const nestedPp = soState.active.concat(soState.completeLoaded ? soState.complete : [])
    .reduce((sum, order) => sum + (Array.isArray(order.pp_vouchers) ? order.pp_vouchers.length : 0), 0);
  if (orderTotal > 0 && (soState.ppCount === 0 || nestedPp === 0)) {
    const empty = document.getElementById('so-empty');
    const emptyText = document.getElementById('so-empty-text');
    if (empty) empty.hidden = false;
    if (emptyText) {
      emptyText.textContent = 'Sales orders loaded but PP voucher data is missing — restart Flask, click Refresh, then hard-reload the page (Ctrl+Shift+R).';
    }
    soSetLoading(false);
    return;
  }

  soSetLoading(false);
  soRender();
  soLoadAssemblyJobs({ refresh });
}

async function soLoadAssemblyJobs({ refresh = false } = {}) {
  try {
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');
    const qs = params.toString();
    const res = await fetch(`/api/material-tracking/sr-assemblies${qs ? `?${qs}` : ''}`, {
      cache: refresh ? 'no-store' : 'default',
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return;
    soState.assemblyJobs = soIndexAssemblyJobs(payload.items);
    soRender();
  } catch (_err) {
    soState.assemblyJobs = soState.assemblyJobs.size ? soState.assemblyJobs : new Map();
  }
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
  document.getElementById('so-refresh')?.addEventListener('click', () => soLoad({
    refresh: true,
    bustCache: true,
    includeComplete: soState.view === 'complete' || soState.completeLoaded,
  }));
  soBindExportModal();
  soBindDetailPanel();
  soBindMaterialModal();
  soBindTableClicks();
  soBindTableScroll();
  soBindColumnControls();
  soBindNeedDateInputs();
  soBindMaterialSubconInputs();
  soBindProposedEddInputs();
  soBindProgramFinishInputs();
  soBindExceptionFlags();
  soBindProposedCncPicker();
  soBindPsTypeDropdown();
  soRenderTableHead();

  window.addEventListener('pp-vouchers-synced', () => {
    soLoad({
      refresh: true,
      bustCache: true,
      includeComplete: soState.view === 'complete' || soState.completeLoaded,
    });
  });

  soLoad({ refresh: false });
}

document.addEventListener('DOMContentLoaded', soInit);
