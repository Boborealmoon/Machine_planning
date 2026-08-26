// Material Tracking - logistics view for material-in dates, PR enquiry, and POs.

(function () {
  'use strict';

  const MATERIAL_ARRIVED = 'ARRIVED';
  const PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
  const EM_DASH = '-';
  const PS_VIEWS = new Set(['active', 'no-wo']);
  const PR_PO_VIEWS = new Set(['pr-enquiry', 'purchase-order']);
  const REQUEST_VIEW = 'part-requests';
  const QC_VIEW = 'qc-checklist';
  const BUCKET_LABELS = { ost: 'Outstanding', new: 'New', hst: 'History' };
  const QC_BUCKET_LABELS = {
    ready_qc: 'Ready for QC',
    awaiting_grn: 'Awaiting GRN',
  };
  const PS_TABLE_HEAD = `
    <tr>
      <th class="sol-col-delay" title="Material arrival delay">Flag</th>
      <th>S/O</th>
      <th>Customer</th>
      <th>Process sheet</th>
      <th class="sol-col-partial">Ptl</th>
      <th class="sol-col-qty">SO qty</th>
      <th class="sol-col-qty">Partial qty</th>
      <th>Stage</th>
      <th>Part</th>
      <th>Description</th>
      <th class="sol-col-due">Due</th>
      <th class="sol-col-due" title="Material need date">Material need</th>
      <th class="sol-col-bom">BOM</th>
      <th class="sol-col-material">Material in</th>
      <th class="sol-col-notes">Mtl / Part Order</th>
    </tr>`;
  const PR_PO_TABLE_HEAD = `
    <tr>
      <th>Status</th>
      <th>PR No</th>
      <th>PR Date</th>
      <th>Item</th>
      <th>Description</th>
      <th class="sol-col-qty">Qty</th>
      <th>Required arrival</th>
      <th>PO No</th>
      <th>PO Date</th>
      <th>Est. arrival</th>
      <th>Supplier</th>
      <th>Project</th>
      <th>SBU</th>
      <th>Created by</th>
      <th>GRN</th>
      <th>Actual arrival</th>
    </tr>`;
  const REQUEST_TABLE_HEAD = `
    <tr>
      <th class="sol-col-delay" title="Material arrival delay">Flag</th>
      <th>Part no</th>
      <th>Inventory code</th>
      <th>Description</th>
      <th class="sol-col-qty">Qty</th>
      <th class="sol-col-material">Material EDD</th>
      <th class="sol-col-notes">Remarks</th>
      <th class="sol-col-bom">BOM</th>
      <th class="sol-col-actions"></th>
    </tr>`;
  const QC_TABLE_HEAD = `
    <tr>
      <th>Status</th>
      <th>Shipment</th>
      <th>PO</th>
      <th>Supplier</th>
      <th>Item</th>
      <th>Description</th>
      <th class="sol-col-qty">Qty</th>
      <th class="sol-col-qty">Received</th>
      <th>UOM</th>
      <th>GRN</th>
      <th>GRN date</th>
      <th>Supplier DO</th>
      <th>QI</th>
      <th>Location</th>
    </tr>`;

  const state = {
    active: [],
    prPoRows: [],
    prPoCounts: { pr: {}, po: {} },
    prPoSource: '',
    view: 'active',
    prPoBucket: 'ost',
    search: '',
    materialFilter: 'all',
    ppTypes: new Set(['APS', 'NPS']),
    saveInFlight: new Set(),
    cachedAt: '',
    ppCount: 0,
    partialCount: 0,
    salesOrdersLoaded: false,
    requests: [],
    requestsLoaded: false,
    addSearch: {
      part_no: { hits: [], loading: false, open: false, activeIndex: -1, timer: 0 },
      inventory_code: { hits: [], loading: false, open: false, activeIndex: -1, timer: 0 },
    },
    qcRows: [],
    qcCounts: { ready_qc: 0, awaiting_grn: 0 },
    qcSource: '',
    qcBucket: 'ready_qc',
    qcLoaded: false,
  };

  function isPrPoView(view) {
    return PR_PO_VIEWS.has(view || state.view);
  }

  function isRequestView(view) {
    return (view || state.view) === REQUEST_VIEW;
  }

  function isQcView(view) {
    return (view || state.view) === QC_VIEW;
  }

  function isPsView(view) {
    return PS_VIEWS.has(view || state.view);
  }

  function scopeForView(view) {
    return (view || state.view) === 'purchase-order' ? 'po' : 'pr';
  }

  function formatDate(value) {
    return typeof trialFormatDate === 'function' ? trialFormatDate(value) : String(value || EM_DASH);
  }

  function formatQty(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return EM_DASH;
    return Number.isInteger(num)
      ? String(num)
      : num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function cellText(value) {
    const text = String(value == null ? '' : value).trim();
    return text || EM_DASH;
  }

  function renderDescCell(value) {
    const text = cellText(value);
    return `<td class="sol-desc" title="${escapeHtml(text)}"><span class="sol-desc-text">${escapeHtml(text)}</span></td>`;
  }

  function soQtyDisplay(pp) {
    return formatQty(pp?.so_det_qty);
  }

  function partialQtyDisplay(partial, pp) {
    const qty = partial?.partial_qty ?? pp?.pp_qty;
    return formatQty(qty);
  }

  function parseMaterialSubcon(raw) {
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
        if (!Number.isNaN(Date.parse(`${iso}T00:00:00`))) {
          return { arrived: false, date: iso, legacy: '' };
        }
      }
    }
    return { arrived: false, date: '', legacy: text };
  }

  function serializeMaterialSubcon({ arrived, date }) {
    if (arrived) return MATERIAL_ARRIVED;
    return String(date || '').trim();
  }

  function materialSubconDisplay(raw) {
    const parsed = parseMaterialSubcon(raw);
    if (parsed.arrived) return 'Arrived';
    if (parsed.date) return formatDate(parsed.date);
    if (parsed.legacy) return parsed.legacy;
    return '';
  }

  async function requestJson(url, { method = 'GET', body } = {}) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function postJson(url, body) {
    return requestJson(url, { method: 'PATCH', body });
  }

  function partialNo(partial) {
    const n = Number(partial?.pp_partial_no);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function getPsType(pp) {
    const raw = String(pp?.process_sheet_no || pp?.pp_voucher_no || '').split('::')[0];
    if (/\[sr\]/i.test(raw)) return 'SR';
    const match = raw.toUpperCase().match(/^([A-Z]+)/);
    return match ? match[1] : null;
  }

  function psDisplayForPartial(pp, partial) {
    const base = String(pp?.process_sheet_no || pp?.pp_voucher_no || EM_DASH).split('::')[0].trim();
    const partialCount = Math.max(1, (pp?.partials || []).length);
    const pno = partialNo(partial);
    return partialCount > 1 ? `${base} - p${pno}` : base;
  }

  function typeTagHtml(psType) {
    if (!psType) return '';
    const label = psType === 'SR' ? '[SR]' : psType;
    return `<span class="so-type-tag so-type-tag--${String(psType).toLowerCase()}">${escapeHtml(label)}</span>`;
  }

  function partialStage(partial) {
    return {
      desc: String(partial?.current_stage_desc || '').trim(),
      status: String(partial?.current_stage_status || '').trim(),
      mode: String(partial?.erp_stage_mode || 'unassigned').trim() || 'unassigned',
      lastDesc: String(partial?.erp_last_stage_desc || '').trim(),
      lastStatus: String(partial?.erp_last_stage_status || '').trim(),
      woCount: Number(partial?.erp_wo_stage_count) || 0,
    };
  }

  function executionLabel(code) {
    const c = String(code || '').trim().toUpperCase();
    if (c === 'I') return 'In Process';
    if (c === 'R') return 'Ready to Start';
    if (c === 'P') return 'Pending SI';
    return c || EM_DASH;
  }

  function statusPill(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!c) return '';
    let cls = 'mi-status-pill';
    if (c === 'I') cls += ' mi-status-pill--o';
    else if (c === 'R') cls += ' mi-status-pill--r';
    else if (c === 'P') cls += ' mi-status-pill--h';
    return `<span class="${cls}" title="${escapeHtml(executionLabel(c))}">${escapeHtml(c)}</span>`;
  }

  function prPoStatusPill(status) {
    const text = String(status || '').trim();
    if (!text) return `<span class="sol-dash">${EM_DASH}</span>`;
    let cls = 'sol-status-pill';
    const lower = text.toLowerCase();
    if (lower.includes('outstanding') || lower.includes('pending')) cls += ' sol-status-pill--ost';
    else if (lower.includes('approval') || lower.includes('new')) cls += ' sol-status-pill--new';
    else if (lower.includes('complete') || lower.includes('grn')) cls += ' sol-status-pill--ok';
    else if (lower.includes('cancel') || lower.includes('history')) cls += ' sol-status-pill--hst';
    return `<span class="${cls}">${escapeHtml(text)}</span>`;
  }

  function ppPendingWoQty(pp) {
    const pending = Number(pp?.erp_pending_wo_qty);
    if (Number.isFinite(pending) && pending > 0.0001) return pending;
    const ppQty = Number(pp?.pp_qty);
    const issued = Number(pp?.erp_wo_issued_qty);
    if (Number.isFinite(ppQty) && Number.isFinite(issued) && ppQty - issued > 0.0001) {
      return ppQty - issued;
    }
    return 0;
  }

  function ppIsNoWo(pp) {
    const soNo = String(pp?.source_voucher_no || '').trim();
    if (!soNo.startsWith('SO/')) return false;
    if (typeof pp?.erp_pending_no_wo === 'boolean') return pp.erp_pending_no_wo;
    if (ppPendingWoQty(pp) > 0.0001) return true;
    if (typeof pp?.erp_has_wo === 'boolean') return !pp.erp_has_wo;
    const partials = Array.isArray(pp?.partials) && pp.partials.length ? pp.partials : [pp];
    return !partials.some(p => (Number(p?.erp_wo_stage_count) || 0) > 0);
  }

  function leafRows(order) {
    const leaves = [];
    (order.pp_vouchers || []).forEach(pp => {
      const partials = pp.partials || [];
      if (!partials.length) {
        const byPartial = pp.queued_machines_by_partial || {};
        leaves.push({
          order,
          pp,
          partial: {
            pp_partial_no: 1,
            inventory_code: pp.inventory_code,
            partial_qty: pp.pp_qty,
            current_stage_desc: pp.current_stage_desc,
            current_stage_status: pp.current_stage_status,
            erp_stage_mode: pp.erp_stage_mode,
            erp_wo_stage_count: pp.erp_wo_stage_count,
            erp_last_stage_desc: pp.erp_last_stage_desc,
            erp_last_stage_status: pp.erp_last_stage_status,
            queued_machines: Array.isArray(byPartial['1']) ? byPartial['1'] : (pp.queued_machines || []),
          },
        });
        return;
      }
      partials.forEach(partial => leaves.push({ order, pp, partial }));
    });
    return leaves;
  }

  function searchText(order, pp, partial) {
    const parts = [
      order.sales_order_no,
      order.customer_name,
      order.customer_short_name,
      order.customer_po_no,
      pp.pp_voucher_no,
      pp.process_sheet_no,
      pp.inventory_code,
      pp.description,
      partial?.inventory_code,
      pp.material_subcon,
      pp.mtl_part_order,
      pp.material_need_date,
      formatDate(pp.material_need_date),
      materialSubconDisplay(pp.material_subcon),
    ];
    return parts.map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
  }

  function prPoSearchText(row) {
    const parts = [
      row.status,
      row.purchase_requisition_no,
      row.item_code,
      row.item_description,
      row.line_item_description,
      row.purchase_order_no,
      row.supplier_code,
      row.supplier_name,
      row.project_no,
      row.sbu_code,
      row.created_by,
      row.grn_no,
      row.shipment_voucher_no,
    ];
    return parts.map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
  }

  function passesPrefixFilter(pp) {
    if (!state.ppTypes.size || state.ppTypes.size === PS_TYPES.length) return true;
    const psType = getPsType(pp);
    if (!psType) return true;
    return state.ppTypes.has(psType);
  }

  function passesMaterialFilter(pp) {
    const parsed = parseMaterialSubcon(pp?.material_subcon);
    switch (state.materialFilter) {
      case 'empty':
        return !parsed.arrived && !parsed.date && !parsed.legacy;
      case 'expected':
        return Boolean(parsed.date) && !parsed.arrived;
      case 'arrived':
        return parsed.arrived;
      default:
        return true;
    }
  }

  function passesFilters(leaf) {
    const { order, pp, partial } = leaf;
    if (state.view === 'no-wo' && !ppIsNoWo(pp)) return false;
    if (!passesPrefixFilter(pp)) return false;
    if (!passesMaterialFilter(pp)) return false;
    const q = String(state.search || '').trim().toLowerCase();
    if (q && !searchText(order, pp, partial).includes(q)) return false;
    return true;
  }

  function visibleLeaves() {
    const rows = [];
    state.active.forEach(order => {
      leafRows(order).forEach(leaf => {
        if (passesFilters(leaf)) rows.push(leaf);
      });
    });
    rows.sort((a, b) => {
      const soCmp = String(a.order.sales_order_no || '').localeCompare(String(b.order.sales_order_no || ''));
      if (soCmp) return soCmp;
      const psCmp = psDisplayForPartial(a.pp, a.partial).localeCompare(psDisplayForPartial(b.pp, b.partial));
      if (psCmp) return psCmp;
      return partialNo(a.partial) - partialNo(b.partial);
    });
    return rows;
  }

  function visiblePrPoRows() {
    const q = String(state.search || '').trim().toLowerCase();
    if (!q) return state.prPoRows.slice();
    return state.prPoRows.filter(row => prPoSearchText(row).includes(q));
  }

  function qcSearchText(row) {
    const parts = [
      row.shipment_voucher_no,
      row.po_no,
      row.supplier_code,
      row.supplier_name,
      row.item_code,
      row.inventory_code,
      row.service_code,
      row.line_item_description,
      row.grn_no,
      row.supplier_do_no,
      row.qi_voucher_no,
      row.receiving_location_code,
    ];
    return parts.map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
  }

  function visibleQcRows() {
    const q = String(state.search || '').trim().toLowerCase();
    if (!q) return state.qcRows.slice();
    return state.qcRows.filter(row => qcSearchText(row).includes(q));
  }

  function findPp(ppVoucherNo) {
    const target = String(ppVoucherNo || '').trim();
    for (const order of state.active) {
      const pp = (order.pp_vouchers || []).find(row => String(row.pp_voucher_no || '').trim() === target);
      if (pp) return { order, pp };
    }
    return { order: null, pp: null };
  }

  function findRequest(requestId) {
    const id = Number(requestId);
    if (!Number.isFinite(id) || id <= 0) return null;
    return state.requests.find(row => Number(row.request_id) === id) || null;
  }

  function requestSearchText(row) {
    const parts = [
      row.part_no,
      row.inventory_code,
      row.description,
      row.qty,
      row.remarks,
      row.material_subcon,
      materialSubconDisplay(row.material_subcon),
    ];
    return parts.map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
  }

  function passesRequestFilters(row) {
    if (!passesMaterialFilter(row)) return false;
    const q = String(state.search || '').trim().toLowerCase();
    if (q && !requestSearchText(row).includes(q)) return false;
    return true;
  }

  function visibleRequestRows() {
    return state.requests.filter(passesRequestFilters);
  }

  function requestIdOf(el) {
    const raw = el?.dataset?.requestId || el?.closest?.('[data-request-id]')?.dataset?.requestId;
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : 0;
  }

  function partNoForRow(pp, partial) {
    return String(partial?.inventory_code || pp?.inventory_code || '').trim();
  }

  function renderStageCell(pp, partial) {
    const stage = partialStage(partial);
    let stageHtml = '';
    if (stage.desc || stage.status) {
      const descHtml = stage.desc
        ? `<span class="so-stage-desc" title="${escapeHtml(stage.desc)}">${escapeHtml(stage.desc)}</span>`
        : '';
      const statusHtml = stage.status ? statusPill(stage.status) : '';
      stageHtml = `${descHtml}${statusHtml}`;
    } else if (stage.mode === 'unassigned') {
      stageHtml = '<span class="so-stage-mode so-stage-mode--unassigned" title="No work order raised yet">No WO</span>';
    } else if (stage.mode === 'completed') {
      stageHtml = '<span class="so-stage-mode so-stage-mode--completed" title="All stages complete">All complete</span>';
    } else {
      stageHtml = `<span class="sol-dash">${EM_DASH}</span>`;
    }
    const pendingWo = ppPendingWoQty(pp);
    const pendingHtml = pendingWo > 0.0001
      ? `<span class="so-stage-mode so-stage-mode--pending-wo" title="${escapeHtml(`${pendingWo} qty awaiting WO`)}">${escapeHtml(String(pendingWo))} awaiting WO</span>`
      : '';
    return `<td class="sol-stage so-stage-cell"><div class="so-stage-stack">${stageHtml}${pendingHtml}</div></td>`;
  }

  function renderMaterialsCell(pp, partial) {
    const partNo = partNoForRow(pp, partial);
    if (!partNo) return `<td class="sol-col-bom">${EM_DASH}</td>`;
    const bomCode = String(pp?.bom_code || '').trim();
    const processSheetNo = psDisplayForPartial(pp, partial);
    const title = `BOM materials and inventory for ${partNo}`;
    return `
      <td class="sol-col-bom">
        <button type="button" class="sol-materials-btn"
          data-action="open-material"
          data-part-no="${escapeHtml(partNo)}"
          data-bom-code="${escapeHtml(bomCode)}"
          data-process-sheet="${escapeHtml(processSheetNo)}"
          title="${escapeHtml(title)}">Materials</button>
      </td>
    `;
  }

  function applyMaterialCellState(cell, parsed) {
    if (!cell) return;
    cell.classList.toggle('has-material-date', Boolean(parsed.date) && !parsed.arrived);
    cell.classList.toggle('has-material-arrived', Boolean(parsed.arrived));
  }

  function renderMaterialCell(pp) {
    const ppNo = String(pp.pp_voucher_no || '').trim();
    const raw = String(pp.material_subcon || '');
    const parsed = parseMaterialSubcon(raw);
    const arrivedCls = parsed.arrived ? ' is-active' : '';
    const dateHiddenCls = parsed.arrived ? ' is-hidden' : '';
    const cellStateCls = parsed.arrived ? ' has-material-arrived' : (parsed.date ? ' has-material-date' : '');
    const legacyHtml = parsed.legacy
      ? `<span class="so-material-subcon-legacy" title="Previous note">${escapeHtml(parsed.legacy)}</span>`
      : '';
    return `
      <td class="so-material-subcon-cell${cellStateCls}" data-pp-voucher-no="${escapeHtml(ppNo)}" data-last-saved="${escapeHtml(raw)}">
        <div class="so-material-subcon-controls">
          <button type="button"
            class="so-material-subcon-arrived${arrivedCls}"
            data-action="toggle-subcon-arrived"
            aria-pressed="${parsed.arrived ? 'true' : 'false'}"
            title="${parsed.arrived ? 'Material arrived - click to clear' : 'Mark material as arrived'}">
            <span class="so-material-subcon-arrived-dot" aria-hidden="true"></span>
            Arrived
          </button>
          <input type="date"
            class="so-material-subcon-date${dateHiddenCls}"
            value="${escapeHtml(parsed.date)}"
            ${parsed.arrived ? 'disabled' : ''}
            aria-label="Material expected / arrival date">
          ${legacyHtml}
        </div>
        <span class="so-editable-status" aria-live="polite"></span>
      </td>
    `;
  }

  function isoDateValue(value) {
    const text = String(value == null ? '' : value).trim();
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
  }

  function renderNeedDateCell(pp) {
    const ppNo = String(pp.pp_voucher_no || '').trim();
    const value = isoDateValue(pp.material_need_date);
    const cellStateCls = value ? ' has-need-date' : '';
    return `
      <td class="sol-need-date-cell${cellStateCls}">
        <input type="date"
          class="sol-need-date-input"
          data-pp-voucher-no="${escapeHtml(ppNo)}"
          data-field="material_need_date"
          data-last-saved="${escapeHtml(value)}"
          value="${escapeHtml(value)}"
          aria-label="Material need date"
          title="Material need date">
        <span class="so-editable-status" aria-live="polite"></span>
      </td>
    `;
  }

  function renderNotesCell(pp) {
    const ppNo = String(pp.pp_voucher_no || '').trim();
    const value = String(pp.mtl_part_order || '');
    return `
      <td class="so-editable-cell">
        <textarea
          class="so-editable-input"
          rows="2"
          data-pp-voucher-no="${escapeHtml(ppNo)}"
          data-field="mtl_part_order"
          data-last-saved="${escapeHtml(value)}"
          aria-label="Mtl / Part Order"
          placeholder="Part order notes..."
        >${escapeHtml(value)}</textarea>
        <span class="so-editable-status" aria-live="polite"></span>
      </td>
    `;
  }

  function renderDelayCell(pp) {
    const ppNo = String(pp.pp_voucher_no || '').trim();
    const flagged = Boolean(pp.material_delay);
    return `
      <td class="sol-delay-cell">
        <label class="sol-delay-flag${flagged ? ' is-active' : ''}"
          title="${flagged ? 'Material delay flagged — click to clear' : 'Flag material arrival delay'}"
          aria-pressed="${flagged ? 'true' : 'false'}"
          aria-label="${flagged ? 'Material delay flagged' : 'Flag material arrival delay'}">
          <input type="checkbox"
            class="sol-delay-input"
            data-pp-voucher-no="${escapeHtml(ppNo)}"
            ${flagged ? 'checked' : ''}
            tabindex="-1"
            aria-hidden="true">
          <span class="sol-delay-mark" aria-hidden="true">⚑</span>
        </label>
        <span class="sol-delay-status" aria-live="polite"></span>
      </td>
    `;
  }

  function syncDelayRows(ppNo, flagged) {
    const body = document.getElementById('sol-table-body');
    if (!body || !ppNo) return;
    body.querySelectorAll('.sol-delay-input').forEach(input => {
      if (String(input.dataset.ppVoucherNo || '') !== ppNo) return;
      applyDelayUi(input, flagged);
    });
  }

  function syncNeedDateRows(ppNo, value) {
    const body = document.getElementById('sol-table-body');
    if (!body || !ppNo) return;
    const saved = isoDateValue(value);
    body.querySelectorAll('.sol-need-date-input').forEach(input => {
      if (String(input.dataset.ppVoucherNo || '') !== ppNo) return;
      input.value = saved;
      input.dataset.lastSaved = saved;
      const cell = input.closest('.sol-need-date-cell');
      if (cell) cell.classList.toggle('has-need-date', Boolean(saved));
    });
  }

  function syncRequestDelayRows(requestId, flagged) {
    const body = document.getElementById('sol-table-body');
    const id = Number(requestId);
    if (!body || !id) return;
    body.querySelectorAll('.sol-delay-input').forEach(input => {
      if (Number(input.dataset.requestId) !== id) return;
      applyDelayUi(input, flagged);
    });
  }

  function applyDelayUi(input, flagged) {
    const row = input.closest('tr');
    const label = input.closest('.sol-delay-flag');
    input.checked = Boolean(flagged);
    if (row) row.classList.toggle('is-material-delay', Boolean(flagged));
    if (label) {
      label.classList.toggle('is-active', Boolean(flagged));
      label.setAttribute('aria-pressed', flagged ? 'true' : 'false');
      label.title = flagged
        ? 'Material delay flagged — click to clear'
        : 'Flag material arrival delay';
    }
  }

  function setDelayStatus(control, status, message) {
    const el = control?.closest('.sol-delay-cell')?.querySelector('.sol-delay-status');
    if (!el) return;
    el.className = `sol-delay-status${status ? ` is-${status}` : ''}`;
    el.textContent = message || '';
  }

  async function saveDelayFlag(input) {
    const requestId = requestIdOf(input);
    if (requestId) {
      await saveRequestDelayFlag(input, requestId);
      return;
    }
    const ppNo = String(input?.dataset?.ppVoucherNo || '').trim();
    if (!ppNo || input.disabled) return;

    const flagged = Boolean(input.checked);
    const label = input.closest('.sol-delay-flag');
    const found = findPp(ppNo);
    const previous = Boolean(found?.pp?.material_delay);
    const key = `${ppNo}::material_delay`;
    if (state.saveInFlight.has(key)) {
      input.checked = previous;
      return;
    }

    if (found?.pp) found.pp.material_delay = flagged;
    syncDelayRows(ppNo, flagged);
    state.saveInFlight.add(key);
    input.disabled = true;
    if (label) label.classList.add('is-saving');
    setDelayStatus(input, 'saving', 'Saving...');
    try {
      const data = await postJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, {
        material_delay: flagged,
      });
      const saved = Boolean(data.material_delay);
      if (found?.pp) found.pp.material_delay = saved;
      syncDelayRows(ppNo, saved);
      setDelayStatus(input, 'saved', saved ? 'Flagged' : 'Cleared');
      window.setTimeout(() => setDelayStatus(input, '', ''), 1500);
    } catch (err) {
      if (found?.pp) found.pp.material_delay = previous;
      syncDelayRows(ppNo, previous);
      setDelayStatus(input, 'error', err.message || 'Save failed');
    } finally {
      input.disabled = false;
      if (label) label.classList.remove('is-saving');
      state.saveInFlight.delete(key);
    }
  }

  async function saveRequestDelayFlag(input, requestId) {
    if (!requestId || input.disabled) return;
    const flagged = Boolean(input.checked);
    const label = input.closest('.sol-delay-flag');
    const found = findRequest(requestId);
    const previous = Boolean(found?.material_delay);
    const key = `req:${requestId}::material_delay`;
    if (state.saveInFlight.has(key)) {
      input.checked = previous;
      return;
    }
    if (found) found.material_delay = flagged;
    syncRequestDelayRows(requestId, flagged);
    state.saveInFlight.add(key);
    input.disabled = true;
    if (label) label.classList.add('is-saving');
    setDelayStatus(input, 'saving', 'Saving...');
    try {
      const data = await postJson(`/api/material-tracking/requests/${requestId}`, {
        material_delay: flagged,
      });
      const saved = Boolean(data.row?.material_delay);
      if (found) found.material_delay = saved;
      syncRequestDelayRows(requestId, saved);
      setDelayStatus(input, 'saved', saved ? 'Flagged' : 'Cleared');
      window.setTimeout(() => setDelayStatus(input, '', ''), 1500);
    } catch (err) {
      if (found) found.material_delay = previous;
      syncRequestDelayRows(requestId, previous);
      setDelayStatus(input, 'error', err.message || 'Save failed');
    } finally {
      input.disabled = false;
      if (label) label.classList.remove('is-saving');
      state.saveInFlight.delete(key);
    }
  }

  function renderRow(leaf) {
    const { order, pp, partial } = leaf;
    const customer = order.customer_name || order.customer_short_name || order.customer_code || EM_DASH;
    const part = partNoForRow(pp, partial) || EM_DASH;
    const psType = getPsType(pp);
    const classes = [];
    if (ppIsNoWo(pp)) classes.push('is-no-wo');
    if (pp.material_delay) classes.push('is-material-delay');
    const rowCls = classes.join(' ');
    return `
      <tr class="${rowCls}">
        ${renderDelayCell(pp)}
        <td class="sol-mono">${escapeHtml(String(order.sales_order_no || EM_DASH))}</td>
        <td title="${escapeHtml(customer)}">${escapeHtml(customer)}</td>
        <td class="sol-mono">
          <div class="sol-ps-line">${typeTagHtml(psType)}<span>${escapeHtml(psDisplayForPartial(pp, partial))}</span></div>
        </td>
        <td class="sol-mono sol-col-partial">${escapeHtml(String(partialNo(partial)))}</td>
        <td class="sol-col-qty">${escapeHtml(soQtyDisplay(pp))}</td>
        <td class="sol-col-qty">${escapeHtml(partialQtyDisplay(partial, pp))}</td>
        ${renderStageCell(pp, partial)}
        <td class="sol-mono">${escapeHtml(String(part))}</td>
        ${renderDescCell(pp.description)}
        <td class="sol-date sol-col-due">${escapeHtml(formatDate(pp.due_date))}</td>
        ${renderNeedDateCell(pp)}
        ${renderMaterialsCell(pp, partial)}
        ${renderMaterialCell(pp)}
        ${renderNotesCell(pp)}
      </tr>
    `;
  }

  function renderPrPoRow(row) {
    const desc = String(row.line_item_description || row.item_description || '').trim();
    const supplier = String(row.supplier_name || row.supplier_code || '').trim() || EM_DASH;
    return `
      <tr>
        <td>${prPoStatusPill(row.status)}</td>
        <td class="sol-mono">${escapeHtml(cellText(row.purchase_requisition_no))}</td>
        <td class="sol-date">${escapeHtml(formatDate(row.pr_date))}</td>
        <td class="sol-mono">${escapeHtml(cellText(row.item_code))}</td>
        ${renderDescCell(desc)}
        <td class="sol-col-qty">${escapeHtml(formatQty(row.qty))}</td>
        <td class="sol-date">${escapeHtml(formatDate(row.required_arrival_date))}</td>
        <td class="sol-mono">${escapeHtml(cellText(row.purchase_order_no))}</td>
        <td class="sol-date">${escapeHtml(formatDate(row.po_date))}</td>
        <td class="sol-date">${escapeHtml(formatDate(row.estimated_arrival_date))}</td>
        <td title="${escapeHtml(supplier)}">${escapeHtml(supplier)}</td>
        <td class="sol-mono">${escapeHtml(cellText(row.project_no))}</td>
        <td>${escapeHtml(cellText(row.sbu_code))}</td>
        <td>${escapeHtml(cellText(row.created_by))}</td>
        <td class="sol-mono">${escapeHtml(cellText(row.grn_no))}</td>
        <td class="sol-date">${escapeHtml(formatDate(row.actual_arrival_date))}</td>
      </tr>
    `;
  }

  function renderQcRow(row) {
    const hasGrn = Boolean(String(row.grn_no || '').trim());
    const desc = String(row.line_item_description || '').trim();
    const supplier = String(row.supplier_name || row.supplier_code || '').trim() || EM_DASH;
    const item = String(row.item_code || row.inventory_code || row.service_code || '').trim();
    const qi = String(row.qi_voucher_no || '').trim();
    const qiStatus = String(row.qi_status || '').trim().toUpperCase();
    const doNo = String(row.supplier_do_no || '').trim();
    const statusCls = hasGrn ? 'sol-qc-pill sol-qc-pill--ready' : 'sol-qc-pill sol-qc-pill--awaiting';
    const statusLabel = hasGrn ? 'Ready for QC' : 'Awaiting GRN';
    const rowCls = hasGrn ? 'is-qc-ready' : 'is-qc-awaiting';
    return `
      <tr class="${rowCls}">
        <td><span class="${statusCls}">${escapeHtml(statusLabel)}</span></td>
        <td class="sol-mono">${escapeHtml(cellText(row.shipment_voucher_no))}</td>
        <td class="sol-mono">${escapeHtml(cellText(row.po_no))}</td>
        <td title="${escapeHtml(supplier)}">${escapeHtml(supplier)}</td>
        <td class="sol-mono">${escapeHtml(item || EM_DASH)}</td>
        ${renderDescCell(desc)}
        <td class="sol-col-qty">${escapeHtml(formatQty(row.qty))}</td>
        <td class="sol-col-qty">${escapeHtml(formatQty(row.qty_received))}</td>
        <td>${escapeHtml(cellText(row.uom_code))}</td>
        <td class="sol-mono">${hasGrn ? `<span class="sol-qc-grn">${escapeHtml(row.grn_no)}</span>` : EM_DASH}</td>
        <td class="sol-date">${escapeHtml(formatDate(row.goods_receipt_date))}</td>
        <td class="sol-mono" title="${escapeHtml(doNo)}">${escapeHtml(doNo || EM_DASH)}</td>
        <td class="sol-mono">${qi ? `${escapeHtml(qi)}${qiStatus ? ` · ${escapeHtml(qiStatus)}` : ''}` : EM_DASH}</td>
        <td>${escapeHtml(cellText(row.receiving_location_code))}</td>
      </tr>
    `;
  }

  function renderRequestDelayCell(row) {
    const id = Number(row.request_id) || 0;
    const flagged = Boolean(row.material_delay);
    return `
      <td class="sol-delay-cell">
        <label class="sol-delay-flag${flagged ? ' is-active' : ''}"
          title="${flagged ? 'Material delay flagged — click to clear' : 'Flag material arrival delay'}"
          aria-pressed="${flagged ? 'true' : 'false'}"
          aria-label="${flagged ? 'Material delay flagged' : 'Flag material arrival delay'}">
          <input type="checkbox"
            class="sol-delay-input"
            data-request-id="${escapeHtml(String(id))}"
            ${flagged ? 'checked' : ''}
            tabindex="-1"
            aria-hidden="true">
          <span class="sol-delay-mark" aria-hidden="true">⚑</span>
        </label>
        <span class="sol-delay-status" aria-live="polite"></span>
      </td>
    `;
  }

  function renderRequestMaterialCell(row) {
    const id = Number(row.request_id) || 0;
    const raw = String(row.material_subcon || '');
    const parsed = parseMaterialSubcon(raw);
    const arrivedCls = parsed.arrived ? ' is-active' : '';
    const dateHiddenCls = parsed.arrived ? ' is-hidden' : '';
    const cellStateCls = parsed.arrived ? ' has-material-arrived' : (parsed.date ? ' has-material-date' : '');
    return `
      <td class="so-material-subcon-cell${cellStateCls}" data-request-id="${escapeHtml(String(id))}" data-last-saved="${escapeHtml(raw)}">
        <div class="so-material-subcon-controls">
          <button type="button"
            class="so-material-subcon-arrived${arrivedCls}"
            data-action="toggle-subcon-arrived"
            aria-pressed="${parsed.arrived ? 'true' : 'false'}"
            title="${parsed.arrived ? 'Material arrived - click to clear' : 'Mark material as arrived'}">
            <span class="so-material-subcon-arrived-dot" aria-hidden="true"></span>
            Arrived
          </button>
          <input type="date"
            class="so-material-subcon-date${dateHiddenCls}"
            value="${escapeHtml(parsed.date)}"
            ${parsed.arrived ? 'disabled' : ''}
            aria-label="Material EDD date">
        </div>
        <span class="so-editable-status" aria-live="polite"></span>
      </td>
    `;
  }

  function renderRequestNotesCell(row) {
    const id = Number(row.request_id) || 0;
    const value = String(row.remarks || '');
    return `
      <td class="so-editable-cell">
        <textarea
          class="so-editable-input"
          rows="2"
          data-request-id="${escapeHtml(String(id))}"
          data-field="remarks"
          data-last-saved="${escapeHtml(value)}"
          aria-label="Remarks"
          placeholder="Remarks..."
        >${escapeHtml(value)}</textarea>
        <span class="so-editable-status" aria-live="polite"></span>
      </td>
    `;
  }

  function renderRequestRow(row) {
    const id = Number(row.request_id) || 0;
    const part = String(row.part_no || '').trim();
    const inv = String(row.inventory_code || '').trim();
    const bomPart = part || inv;
    const qtyVal = row.qty == null || row.qty === '' ? '' : String(row.qty);
    const classes = row.material_delay ? 'is-material-delay' : '';
    return `
      <tr class="${classes}" data-request-id="${escapeHtml(String(id))}">
        ${renderRequestDelayCell(row)}
        <td class="sol-mono">${escapeHtml(part || EM_DASH)}</td>
        <td class="sol-mono">${escapeHtml(inv || EM_DASH)}</td>
        ${renderDescCell(row.description)}
        <td class="sol-col-qty">
          <input type="number" min="0" step="any"
            class="sol-qty-cell-input"
            data-request-id="${escapeHtml(String(id))}"
            data-field="qty"
            data-last-saved="${escapeHtml(qtyVal)}"
            value="${escapeHtml(qtyVal)}"
            aria-label="Qty">
        </td>
        ${renderRequestMaterialCell(row)}
        ${renderRequestNotesCell(row)}
        <td class="sol-col-bom">
          ${bomPart ? `
            <button type="button" class="sol-materials-btn"
              data-action="open-material"
              data-part-no="${escapeHtml(bomPart)}"
              data-bom-code=""
              data-process-sheet=""
              title="BOM materials and inventory for ${escapeHtml(bomPart)}">Materials</button>
          ` : EM_DASH}
        </td>
        <td class="sol-col-actions">
          <button type="button" class="sol-btn sol-btn--ghost sol-delete-btn"
            data-action="delete-request"
            data-request-id="${escapeHtml(String(id))}">Remove</button>
        </td>
      </tr>
    `;
  }

  function setSaveStatus(control, status, message) {
    const el = control?.closest('.so-editable-cell, .so-material-subcon-cell, .sol-need-date-cell')?.querySelector('.so-editable-status');
    if (!el) return;
    el.className = `so-editable-status${status ? ` is-${status}` : ''}`;
    el.textContent = message || '';
  }

  function syncMaterialCell(cell, raw) {
    if (!cell) return;
    const parsed = parseMaterialSubcon(raw);
    applyMaterialCellState(cell, parsed);
    cell.dataset.lastSaved = String(raw || '');
    const btn = cell.querySelector('.so-material-subcon-arrived');
    const dateInput = cell.querySelector('.so-material-subcon-date');
    if (btn) {
      btn.classList.toggle('is-active', parsed.arrived);
      btn.setAttribute('aria-pressed', parsed.arrived ? 'true' : 'false');
    }
    if (dateInput) {
      dateInput.value = parsed.date || '';
      dateInput.disabled = parsed.arrived;
      dateInput.classList.toggle('is-hidden', parsed.arrived);
    }
  }

  async function saveRequestPatch(requestId, patch, { cell, onSaved, onRevert, lastSaved, key }) {
    if (!requestId || !cell) return;
    const nextValue = Object.values(patch)[0];
    const nextText = nextValue == null ? '' : String(nextValue).trim();
    if (state.saveInFlight.has(key)) return;
    if (nextText === String(lastSaved || '').trim() && !('material_delay' in patch)) return;

    state.saveInFlight.add(key);
    setSaveStatus(cell, 'saving', 'Saving...');
    try {
      const data = await postJson(`/api/material-tracking/requests/${requestId}`, patch);
      const row = data.row || {};
      const found = findRequest(requestId);
      if (found) Object.assign(found, row);
      if (onSaved) onSaved(row);
      setSaveStatus(cell, 'saved', 'Saved');
      window.setTimeout(() => {
        if (cell.isConnected) setSaveStatus(cell, '', '');
      }, 1500);
    } catch (err) {
      if (onRevert) onRevert(lastSaved);
      setSaveStatus(cell, 'error', err.message || 'Save failed');
    } finally {
      state.saveInFlight.delete(key);
    }
  }

  async function saveMaterialCell(cell, nextValue) {
    const requestId = requestIdOf(cell);
    if (requestId) {
      await saveRequestPatch(requestId, { material_subcon: String(nextValue || '').trim() }, {
        cell,
        onSaved(row) {
          syncMaterialCell(cell, String(row.material_subcon || ''));
          if (Object.prototype.hasOwnProperty.call(row, 'material_delay')) {
            syncRequestDelayRows(requestId, Boolean(row.material_delay));
          }
        },
        onRevert(lastSaved) {
          syncMaterialCell(cell, lastSaved);
        },
        lastSaved: String(cell.dataset.lastSaved || '').trim(),
        key: `req:${requestId}::material_subcon`,
      });
      return;
    }
    const ppNo = String(cell?.dataset?.ppVoucherNo || '').trim();
    if (!ppNo || !cell) return;
    const key = `${ppNo}::material_subcon`;
    if (state.saveInFlight.has(key)) return;
    const savedValue = String(nextValue || '').trim();
    const lastSaved = String(cell.dataset.lastSaved || '').trim();
    if (savedValue === lastSaved) return;

    state.saveInFlight.add(key);
    setSaveStatus(cell, 'saving', 'Saving...');
    try {
      const data = await postJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, {
        material_subcon: savedValue,
      });
      const saved = String(data.material_subcon || '').trim();
      syncMaterialCell(cell, saved);
      const found = findPp(ppNo);
      if (found.pp) {
        found.pp.material_subcon = saved;
        if (Object.prototype.hasOwnProperty.call(data, 'material_delay')) {
          found.pp.material_delay = Boolean(data.material_delay);
          syncDelayRows(ppNo, found.pp.material_delay);
        }
      }
      setSaveStatus(cell, 'saved', 'Saved');
      window.setTimeout(() => {
        if (String(cell.dataset.lastSaved || '').trim() === saved) setSaveStatus(cell, '', '');
      }, 1500);
    } catch (err) {
      syncMaterialCell(cell, lastSaved);
      setSaveStatus(cell, 'error', err.message || 'Save failed');
    } finally {
      state.saveInFlight.delete(key);
    }
  }

  async function saveNotesField(control) {
    const requestId = requestIdOf(control);
    const field = String(control.dataset.field || '').trim();
    if (requestId && (field === 'remarks' || field === 'qty')) {
      const nextValue = String(control.value || '').trim();
      await saveRequestPatch(requestId, { [field]: nextValue }, {
        cell: control,
        onSaved(row) {
          const saved = row[field] == null ? '' : String(row[field]).trim();
          control.value = saved;
          control.dataset.lastSaved = saved;
        },
        onRevert(lastSaved) {
          control.value = lastSaved;
        },
        lastSaved: String(control.dataset.lastSaved || ''),
        key: `req:${requestId}::${field}`,
      });
      return;
    }
    const ppNo = String(control.dataset.ppVoucherNo || '').trim();
    const saveable = field === 'mtl_part_order' || field === 'material_need_date';
    if (!ppNo || !saveable) return;
    const key = `${ppNo}::${field}`;
    if (state.saveInFlight.has(key)) return;
    const nextValue = field === 'material_need_date'
      ? isoDateValue(control.value)
      : String(control.value || '').trim();
    const lastSaved = String(control.dataset.lastSaved || '');
    if (nextValue === lastSaved) return;

    state.saveInFlight.add(key);
    setSaveStatus(control, 'saving', 'Saving...');
    try {
      const payload = field === 'material_need_date'
        ? { material_need_date: nextValue }
        : { [field]: nextValue };
      const data = await postJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, payload);
      const saved = field === 'material_need_date'
        ? isoDateValue(data.material_need_date)
        : String(data[field] || '').trim();
      control.value = saved;
      control.dataset.lastSaved = saved;
      const found = findPp(ppNo);
      if (found.pp) found.pp[field] = saved;
      if (field === 'material_need_date') syncNeedDateRows(ppNo, saved);
      setSaveStatus(control, 'saved', 'Saved');
      window.setTimeout(() => {
        if (control.dataset.lastSaved === saved) setSaveStatus(control, '', '');
      }, 1500);
    } catch (err) {
      control.value = lastSaved;
      setSaveStatus(control, 'error', err.message || 'Save failed');
    } finally {
      state.saveInFlight.delete(key);
    }
  }

  function countNoWoJobs() {
    const seen = new Set();
    let count = 0;
    state.active.forEach(order => {
      leafRows(order).forEach(leaf => {
        const ppNo = String(leaf.pp?.pp_voucher_no || '').trim();
        if (!ppNo || seen.has(ppNo) || !ppIsNoWo(leaf.pp)) return;
        seen.add(ppNo);
        count += 1;
      });
    });
    return count;
  }

  function countActiveJobs() {
    const seen = new Set();
    let count = 0;
    state.active.forEach(order => {
      (order.pp_vouchers || []).forEach(pp => {
        const ppNo = String(pp.pp_voucher_no || '').trim();
        if (!ppNo || seen.has(ppNo)) return;
        seen.add(ppNo);
        count += 1;
      });
    });
    return count;
  }

  function setChipCount(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const n = Number(value) || 0;
    el.textContent = String(n);
    el.hidden = n === 0;
  }

  function updatePrPoChipCounts() {
    const pr = state.prPoCounts.pr || {};
    const po = state.prPoCounts.po || {};
    const prOst = Number(pr.ost) || 0;
    const poOst = Number(po.ost) || 0;
    setChipCount('sol-pr-count', prOst);
    setChipCount('sol-po-count', poOst);

    const scopeCounts = state.view === 'purchase-order' ? po : pr;
    setChipCount('sol-bucket-ost-count', scopeCounts.ost);
    setChipCount('sol-bucket-new-count', scopeCounts.new);
    setChipCount('sol-bucket-hst-count', scopeCounts.hst);
    updateQcChipCounts();
  }

  function updateQcChipCounts() {
    const ready = Number(state.qcCounts.ready_qc) || 0;
    const awaiting = Number(state.qcCounts.awaiting_grn) || 0;
    setChipCount('sol-qc-ready-count', ready);
    setChipCount('sol-qc-awaiting-count', awaiting);
    setChipCount('sol-qc-count', ready + awaiting);
  }

  function setStatPills(items) {
    const host = document.getElementById('sol-stat-pills');
    if (!host) return;
    host.innerHTML = (items || []).map(item => `
      <div class="sol-stat-pill">
        <span class="sol-stat-pill-label">${escapeHtml(item.label)}</span>
        <span class="sol-stat-pill-value">${escapeHtml(String(item.value))}</span>
      </div>
    `).join('');
  }

  function updatePsStats(rows) {
    const subtitle = document.getElementById('sol-subtitle');
    const activeJobs = countActiveJobs();
    const noWoJobs = countNoWoJobs();
    const viewLabel = state.view === 'no-wo' ? 'No WO' : 'Active';

    setChipCount('sol-active-count', activeJobs);
    setChipCount('sol-no-wo-count', noWoJobs);
    updatePrPoChipCounts();
    setStatPills([
      { label: 'Shown', value: rows.length },
      { label: 'Active PP', value: activeJobs },
      { label: 'Awaiting WO', value: noWoJobs },
    ]);

    if (subtitle) {
      subtitle.textContent = `${rows.length} ${viewLabel} rows shown | ${activeJobs} active PP | ${noWoJobs} awaiting WO`;
    }
  }

  function updatePrPoStats(rows) {
    const subtitle = document.getElementById('sol-subtitle');
    const scopeLabel = state.view === 'purchase-order' ? 'Purchase Order' : 'PR Enquiry';
    const bucketLabel = BUCKET_LABELS[state.prPoBucket] || state.prPoBucket;
    const scopeCounts = state.view === 'purchase-order'
      ? (state.prPoCounts.po || {})
      : (state.prPoCounts.pr || {});
    updatePrPoChipCounts();
    if (subtitle) {
      subtitle.textContent = `${rows.length} ${scopeLabel} · ${bucketLabel} rows shown`;
    }
    setStatPills([
      { label: 'Shown', value: rows.length },
      { label: 'Outstanding', value: Number(scopeCounts.ost) || 0 },
      { label: 'History', value: Number(scopeCounts.hst) || 0 },
    ]);
  }

  function updateQcStats(rows) {
    const subtitle = document.getElementById('sol-subtitle');
    const bucketLabel = QC_BUCKET_LABELS[state.qcBucket] || state.qcBucket;
    updateQcChipCounts();
    if (subtitle) {
      subtitle.textContent = `${rows.length} ${bucketLabel} inbound lines shown`;
    }
    setStatPills([
      { label: 'Shown', value: rows.length },
      { label: 'Ready for QC', value: Number(state.qcCounts.ready_qc) || 0 },
      { label: 'Awaiting GRN', value: Number(state.qcCounts.awaiting_grn) || 0 },
    ]);
  }

  function syncNavUi() {
    const prPo = isPrPoView();
    const requests = isRequestView();
    const qc = isQcView();
    const bucketGroup = document.getElementById('sol-bucket-group');
    const qcBucketGroup = document.getElementById('sol-qc-bucket-group');
    const newBucketBtn = document.querySelector('[data-sol-bucket="new"]');
    const search = document.getElementById('sol-search');
    const legend = document.getElementById('sol-legend');

    document.querySelectorAll('.sol-ps-only').forEach(el => {
      el.hidden = !isPsView();
    });
    document.querySelectorAll('.sol-req-only').forEach(el => {
      el.hidden = !requests;
    });
    document.querySelectorAll('.sol-edd-filter').forEach(el => {
      el.hidden = prPo || qc;
    });

    if (bucketGroup) bucketGroup.hidden = !prPo;
    if (qcBucketGroup) qcBucketGroup.hidden = !qc;
    if (newBucketBtn) newBucketBtn.hidden = state.view !== 'purchase-order';

    document.querySelectorAll('[data-sol-view]').forEach(btn => {
      const active = btn.getAttribute('data-sol-view') === state.view;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    document.querySelectorAll('[data-sol-bucket]').forEach(btn => {
      const active = btn.getAttribute('data-sol-bucket') === state.prPoBucket;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    document.querySelectorAll('[data-sol-qc-bucket]').forEach(btn => {
      const active = btn.getAttribute('data-sol-qc-bucket') === state.qcBucket;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    if (search) {
      search.placeholder = prPo
        ? 'Search PR, PO, item, supplier...'
        : requests
          ? 'Search part no, inventory code, remarks...'
          : qc
            ? 'Search shipment, PO, GRN, supplier, item...'
            : 'Search SO, PP, part, customer...';
    }
    if (legend) {
      legend.hidden = prPo;
      if (qc) {
        legend.innerHTML = `
          <span class="sol-legend-item sol-legend-item--qc-ready">Green GRN</span> material ready for QC &middot;
          <span class="sol-legend-item sol-legend-item--qc-awaiting">Amber row</span> received, GRN not generated in ERP &middot;
          Source: outstanding inbound shipments (<code>lg_in_shm_ost</code>)
        `;
      } else if (requests) {
        legend.innerHTML = `
          <span class="sol-legend-item sol-legend-item--delay">Rose row</span> material delay &middot;
          <span class="sol-legend-item sol-legend-item--date">Blue cell</span> material EDD &middot;
          <span class="sol-legend-item sol-legend-item--arrived">Green cell</span> material arrived &middot;
          Not tagged to a process sheet &middot;
          Click <strong>Materials</strong> for BOM + inventory enquiry
        `;
      } else {
        legend.innerHTML = `
          <span class="sol-legend-item sol-legend-item--delay">Rose row</span> material delay &middot;
          <span class="sol-legend-item sol-legend-item--no-wo">Amber row</span> awaiting WO &middot;
          <span class="sol-legend-item sol-legend-item--date">Blue cell</span> expected date &middot;
          <span class="sol-legend-item sol-legend-item--arrived">Green cell</span> material arrived &middot;
          Click <strong>Flag</strong> for material arrival delay &middot;
          Click <strong>Materials</strong> for BOM + inventory enquiry
        `;
      }
    }
  }

  function ensureTableHead() {
    const head = document.getElementById('sol-table-head');
    if (!head) return;
    const mode = isPrPoView()
      ? 'prpo'
      : (isRequestView() ? 'req' : (isQcView() ? 'qc' : 'ps'));
    if (head.dataset.mode === mode) return;
    head.dataset.mode = mode;
    head.innerHTML = mode === 'prpo'
      ? PR_PO_TABLE_HEAD
      : mode === 'req'
        ? REQUEST_TABLE_HEAD
        : mode === 'qc'
          ? QC_TABLE_HEAD
          : PS_TABLE_HEAD;
  }

  function renderPs() {
    const rows = visibleLeaves();
    const body = document.getElementById('sol-table-body');
    const host = document.getElementById('sol-table-host');
    const empty = document.getElementById('sol-empty');
    const loading = document.getElementById('sol-loading');
    const meta = document.getElementById('sol-meta');

    if (loading) loading.hidden = true;
    ensureTableHead();
    updatePsStats(rows);

    if (!rows.length) {
      let msg = 'No rows match your filters.';
      if (!state.active.length) msg = 'No active process sheets in ERP.';
      else if (state.view === 'no-wo') msg = 'No process sheets awaiting work order issuance.';
      else if (state.materialFilter === 'empty') msg = 'No rows without a material date or arrival flag.';
      if (body) body.innerHTML = '';
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = msg;
      }
    } else {
      if (host) host.hidden = false;
      if (empty) empty.hidden = true;
      if (body) {
        body.innerHTML = rows.map(renderRow).join('');
        delete body.dataset.bound;
        bindInputs();
      }
    }

    if (meta) {
      meta.hidden = !state.active.length;
      meta.textContent = `Autosave on blur | ${state.ppCount || 0} PP | ${state.partialCount || 0} partials | cached ${state.cachedAt || EM_DASH}`;
    }
  }

  function renderPrPo() {
    const rows = visiblePrPoRows();
    const body = document.getElementById('sol-table-body');
    const host = document.getElementById('sol-table-host');
    const empty = document.getElementById('sol-empty');
    const loading = document.getElementById('sol-loading');
    const meta = document.getElementById('sol-meta');
    const bucketLabel = BUCKET_LABELS[state.prPoBucket] || state.prPoBucket;

    if (loading) loading.hidden = true;
    ensureTableHead();
    updatePrPoStats(rows);

    if (!rows.length) {
      let msg = 'No rows match your filters.';
      if (!state.prPoRows.length) msg = `No ${bucketLabel.toLowerCase()} rows in ERP.`;
      if (body) body.innerHTML = '';
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = msg;
      }
    } else {
      if (host) host.hidden = false;
      if (empty) empty.hidden = true;
      if (body) {
        body.innerHTML = rows.map(renderPrPoRow).join('');
        delete body.dataset.bound;
      }
    }

    if (meta) {
      meta.hidden = !state.prPoRows.length && !state.prPoSource;
      meta.textContent = `${state.prPoSource || 'PR/PO'} | ${state.prPoRows.length} rows | cached ${state.cachedAt || EM_DASH}`;
    }
  }

  function updateRequestStats(rows) {
    const subtitle = document.getElementById('sol-subtitle');
    setChipCount('sol-req-count', state.requests.length);
    if (subtitle) {
      subtitle.textContent = `${rows.length} part request${rows.length === 1 ? '' : 's'} shown | ${state.requests.length} saved`;
    }
    setStatPills([
      { label: 'Shown', value: rows.length },
      { label: 'Saved', value: state.requests.length },
    ]);
  }

  function renderRequests() {
    const rows = visibleRequestRows();
    const body = document.getElementById('sol-table-body');
    const host = document.getElementById('sol-table-host');
    const empty = document.getElementById('sol-empty');
    const loading = document.getElementById('sol-loading');
    const meta = document.getElementById('sol-meta');

    if (loading) loading.hidden = true;
    ensureTableHead();
    updateRequestStats(rows);

    if (!rows.length) {
      let msg = 'No rows match your filters.';
      if (!state.requests.length) {
        msg = 'No part requests yet. Search a part no or inventory code and click Add request.';
      }
      if (body) body.innerHTML = '';
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = msg;
      }
    } else {
      if (host) host.hidden = false;
      if (empty) empty.hidden = true;
      if (body) {
        body.innerHTML = rows.map(renderRequestRow).join('');
        delete body.dataset.bound;
        bindInputs();
      }
    }

    if (meta) {
      meta.hidden = false;
      meta.textContent = `Autosave on blur | ${state.requests.length} requests | not tagged to a process sheet`;
    }
  }

  function renderQc() {
    const rows = visibleQcRows();
    const body = document.getElementById('sol-table-body');
    const host = document.getElementById('sol-table-host');
    const empty = document.getElementById('sol-empty');
    const loading = document.getElementById('sol-loading');
    const meta = document.getElementById('sol-meta');
    const bucketLabel = QC_BUCKET_LABELS[state.qcBucket] || state.qcBucket;

    if (loading) loading.hidden = true;
    ensureTableHead();
    updateQcStats(rows);

    if (!rows.length) {
      let msg = 'No rows match your filters.';
      if (!state.qcRows.length) {
        msg = state.qcBucket === 'awaiting_grn'
          ? 'No inbound lines are received without a GRN.'
          : 'No inbound lines currently have a GRN ready for QC.';
      }
      if (body) body.innerHTML = '';
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = msg;
      }
    } else {
      if (host) host.hidden = false;
      if (empty) empty.hidden = true;
      if (body) {
        body.innerHTML = rows.map(renderQcRow).join('');
        delete body.dataset.bound;
      }
    }

    if (meta) {
      meta.hidden = !state.qcRows.length && !state.qcSource;
      meta.textContent = `${state.qcSource || 'Inbound shipments'} | ${bucketLabel} | cached ${state.cachedAt || EM_DASH}`;
    }
  }

  function render() {
    syncNavUi();
    setChipCount('sol-req-count', state.requests.length);
    updateQcChipCounts();
    if (isPrPoView()) renderPrPo();
    else if (isRequestView()) renderRequests();
    else if (isQcView()) renderQc();
    else renderPs();
  }

  function normalizeBucketForView(view, bucket) {
    if (view === 'purchase-order') {
      return bucket === 'hst' || bucket === 'new' ? bucket : 'ost';
    }
    return bucket === 'hst' ? 'hst' : 'ost';
  }

  function setView(view) {
    const next = PR_PO_VIEWS.has(view) || PS_VIEWS.has(view) || view === REQUEST_VIEW || view === QC_VIEW
      ? view
      : 'active';
    const nextIsPrPo = isPrPoView(next);
    const nextIsRequest = isRequestView(next);
    const nextIsQc = isQcView(next);
    state.view = next;
    if (nextIsPrPo) {
      state.prPoBucket = normalizeBucketForView(next, state.prPoBucket);
    }
    syncNavUi();

    if (nextIsPrPo) {
      loadPrPo({ refresh: false });
      return;
    }
    if (nextIsRequest) {
      if (!state.requestsLoaded) loadRequests({ refresh: false });
      else render();
      return;
    }
    if (nextIsQc) {
      if (!state.qcLoaded) loadQcChecklist({ refresh: false });
      else render();
      return;
    }
    if (!state.salesOrdersLoaded) {
      loadSalesOrders({ refresh: false });
      return;
    }
    render();
  }

  function setBucket(bucket) {
    if (!isPrPoView()) return;
    const next = normalizeBucketForView(state.view, bucket);
    if (next === state.prPoBucket) return;
    state.prPoBucket = next;
    syncNavUi();
    loadPrPo({ refresh: false });
  }

  function setQcBucket(bucket) {
    if (!isQcView()) return;
    const next = bucket === 'awaiting_grn' ? 'awaiting_grn' : 'ready_qc';
    if (next === state.qcBucket) return;
    state.qcBucket = next;
    syncNavUi();
    loadQcChecklist({ refresh: false });
  }

  function psTypeLabel() {
    if (!state.ppTypes.size) return 'None';
    if (state.ppTypes.size === PS_TYPES.length) return 'All';
    const labels = PS_TYPES.filter(t => state.ppTypes.has(t)).map(t => (t === 'SR' ? '[SR]' : t));
    return labels.length <= 2 ? labels.join(', ') : `${labels.length} types`;
  }

  function bindPsTypeDropdown() {
    const btn = document.getElementById('sol-ps-type-btn');
    const panel = document.getElementById('sol-ps-type-panel');
    if (!btn || !panel || panel.dataset.bound === '1') return;
    panel.dataset.bound = '1';

    btn.addEventListener('click', e => {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
    });

    document.addEventListener('click', e => {
      if (!panel.contains(e.target) && e.target !== btn) panel.hidden = true;
    });

    panel.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.addEventListener('change', () => {
        state.ppTypes = new Set(
          [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value),
        );
        btn.textContent = `${psTypeLabel()} v`;
        render();
      });
    });

    btn.textContent = `${psTypeLabel()} v`;
  }

  function bindMaterialButtons() {
    const host = document.getElementById('sol-table-host');
    if (!host || host.dataset.materialBound === '1') return;
    host.dataset.materialBound = '1';

    host.addEventListener('click', e => {
      const btn = e.target.closest('[data-action="open-material"]');
      if (!btn) return;
      e.stopPropagation();
      if (typeof window.openMaterialModal !== 'function') return;
      window.openMaterialModal({
        partNo: btn.getAttribute('data-part-no'),
        bomCode: btn.getAttribute('data-bom-code'),
        processSheetNo: btn.getAttribute('data-process-sheet'),
      });
    });
  }

  function bindInputs() {
    const body = document.getElementById('sol-table-body');
    if (!body || body.dataset.bound === '1') return;
    body.dataset.bound = '1';

    body.addEventListener('click', e => {
      const deleteBtn = e.target.closest('[data-action="delete-request"]');
      if (deleteBtn) {
        e.stopPropagation();
        deleteRequestRow(deleteBtn);
        return;
      }
      const btn = e.target.closest('[data-action="toggle-subcon-arrived"]');
      if (!btn) return;
      e.stopPropagation();
      const cell = btn.closest('.so-material-subcon-cell');
      if (!cell) return;
      const parsed = parseMaterialSubcon(cell.dataset.lastSaved);
      const nextArrived = !parsed.arrived;
      const dateInput = cell.querySelector('.so-material-subcon-date');
      const date = nextArrived ? '' : String(dateInput?.value || '').trim();
      applyMaterialCellState(cell, { arrived: nextArrived, date });
      saveMaterialCell(cell, serializeMaterialSubcon({ arrived: nextArrived, date }));
    });

    body.addEventListener('change', e => {
      const delayInput = e.target.closest('.sol-delay-input');
      if (delayInput) {
        e.stopPropagation();
        saveDelayFlag(delayInput);
        return;
      }
      const needDateInput = e.target.closest('.sol-need-date-input');
      if (needDateInput) {
        e.stopPropagation();
        saveNotesField(needDateInput);
        return;
      }
      const dateInput = e.target.closest('.so-material-subcon-date');
      if (!dateInput || dateInput.disabled) return;
      e.stopPropagation();
      const cell = dateInput.closest('.so-material-subcon-cell');
      if (!cell) return;
      const date = String(dateInput.value || '').trim();
      applyMaterialCellState(cell, { arrived: false, date });
      saveMaterialCell(cell, serializeMaterialSubcon({ arrived: false, date }));
    });

    body.addEventListener('click', e => {
      const flag = e.target.closest('.sol-delay-flag');
      if (!flag) return;
      e.stopPropagation();
    });

    body.addEventListener('blur', e => {
      const textarea = e.target.closest('.so-editable-input');
      if (textarea) {
        saveNotesField(textarea);
        return;
      }
      const qtyInput = e.target.closest('.sol-qty-cell-input');
      if (qtyInput) saveNotesField(qtyInput);
    }, true);
  }

  function showLoadError(err) {
    const loading = document.getElementById('sol-loading');
    const subtitle = document.getElementById('sol-subtitle');
    const empty = document.getElementById('sol-empty');
    const host = document.getElementById('sol-table-host');
    if (loading) loading.hidden = true;
    if (host) host.hidden = true;
    if (subtitle) subtitle.textContent = 'Failed to load';
    if (empty) {
      empty.hidden = false;
      empty.textContent = `Failed to load: ${err.message}`;
    }
  }

  async function loadSalesOrders({ refresh = false } = {}) {
    const loading = document.getElementById('sol-loading');
    const host = document.getElementById('sol-table-host');
    const subtitle = document.getElementById('sol-subtitle');
    if (loading) loading.hidden = false;
    if (host) host.hidden = true;
    const baseLabel = refresh
      ? 'Refreshing...'
      : 'Loading process sheets...';
    if (subtitle) subtitle.textContent = baseLabel;

    const params = new URLSearchParams({ active_only: '1', lite: '1' });
    if (refresh) params.set('refresh', '1');

    const ac = new AbortController();
    const timeoutMs = refresh ? 180000 : 120000;
    const timeoutId = window.setTimeout(() => ac.abort(), timeoutMs);
    let elapsed = 0;
    const tickId = window.setInterval(() => {
      elapsed += 1;
      if (subtitle) subtitle.textContent = `${baseLabel} ${elapsed}s`;
    }, 1000);

    try {
      const res = await fetch(`/api/sales-orders?${params}`, {
        cache: refresh ? 'no-store' : 'default',
        signal: ac.signal,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      state.active = Array.isArray(payload.active) ? payload.active : [];
      state.cachedAt = payload.cached_at || '';
      state.ppCount = Number(payload.active_job_count || payload.pp_count) || 0;
      state.partialCount = Number(payload.partial_count) || 0;
      state.salesOrdersLoaded = true;
      if (isPsView()) render();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        showLoadError(new Error('Timed out waiting for ERP. Click Refresh to retry.'));
        return;
      }
      showLoadError(err);
    } finally {
      window.clearTimeout(timeoutId);
      window.clearInterval(tickId);
    }
  }

  async function loadPrPo({ refresh = false } = {}) {
    const loading = document.getElementById('sol-loading');
    const host = document.getElementById('sol-table-host');
    const subtitle = document.getElementById('sol-subtitle');
    const scope = scopeForView();
    const bucket = state.prPoBucket;
    const bucketLabel = BUCKET_LABELS[bucket] || bucket;

    if (loading) loading.hidden = false;
    if (host) host.hidden = true;
    if (subtitle) {
      subtitle.textContent = refresh
        ? `Refreshing ${bucketLabel} from ERP...`
        : `Loading ${bucketLabel}...`;
    }

    const params = new URLSearchParams({ scope, bucket });
    if (refresh) params.set('refresh', '1');

    try {
      const res = await fetch(`/api/material-tracking/pr-po?${params}`, {
        cache: refresh ? 'no-store' : 'default',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      state.prPoRows = Array.isArray(payload.rows) ? payload.rows : [];
      state.prPoCounts = payload.counts || { pr: {}, po: {} };
      state.prPoSource = payload.source || '';
      state.cachedAt = payload.cached_at || '';
      if (isPrPoView()) render();
    } catch (err) {
      showLoadError(err);
    }
  }

  async function loadRequests({ refresh = false, silent = false } = {}) {
    const loading = document.getElementById('sol-loading');
    const host = document.getElementById('sol-table-host');
    const subtitle = document.getElementById('sol-subtitle');
    const showUi = isRequestView() && !silent;
    if (showUi) {
      if (loading) loading.hidden = false;
      if (host) host.hidden = true;
      if (subtitle) subtitle.textContent = refresh ? 'Refreshing part requests...' : 'Loading part requests...';
    }
    try {
      const data = await requestJson('/api/material-tracking/requests');
      state.requests = Array.isArray(data.rows) ? data.rows : [];
      state.requestsLoaded = true;
      setChipCount('sol-req-count', state.requests.length);
      if (isRequestView()) render();
    } catch (err) {
      if (showUi) showLoadError(err);
    }
  }

  async function loadQcChecklist({ refresh = false, silent = false } = {}) {
    const loading = document.getElementById('sol-loading');
    const host = document.getElementById('sol-table-host');
    const subtitle = document.getElementById('sol-subtitle');
    const showUi = isQcView() && !silent;
    const bucketLabel = QC_BUCKET_LABELS[state.qcBucket] || state.qcBucket;
    if (showUi) {
      if (loading) loading.hidden = false;
      if (host) host.hidden = true;
      if (subtitle) {
        subtitle.textContent = refresh
          ? `Refreshing ${bucketLabel} from ERP...`
          : `Loading ${bucketLabel}...`;
      }
    }

    const params = new URLSearchParams({ bucket: state.qcBucket });
    if (refresh) params.set('refresh', '1');

    try {
      const res = await fetch(`/api/material-tracking/qc-checklist?${params}`, {
        cache: refresh ? 'no-store' : 'default',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      state.qcRows = Array.isArray(payload.rows) ? payload.rows : [];
      state.qcCounts = payload.counts || { ready_qc: 0, awaiting_grn: 0 };
      state.qcSource = payload.source || '';
      state.cachedAt = payload.cached_at || state.cachedAt;
      state.qcLoaded = true;
      updateQcChipCounts();
      if (isQcView()) render();
    } catch (err) {
      if (showUi) showLoadError(err);
    }
  }

  async function load({ refresh = false } = {}) {
    if (isPrPoView()) {
      await loadPrPo({ refresh });
      return;
    }
    if (isRequestView()) {
      await loadRequests({ refresh });
      return;
    }
    if (isQcView()) {
      await loadQcChecklist({ refresh });
      return;
    }
    await loadSalesOrders({ refresh });
  }

  function setAddStatus(status, message) {
    const el = document.getElementById('sol-add-status');
    if (!el) return;
    el.className = `sol-add-status${status ? ` is-${status}` : ''}`;
    el.textContent = message || '';
  }

  function closeTypeahead(field) {
    const box = state.addSearch[field];
    if (!box) return;
    box.open = false;
    box.activeIndex = -1;
    const wrap = document.querySelector(`.sol-typeahead[data-sol-field="${field}"]`);
    const input = wrap?.querySelector('input');
    const list = wrap?.querySelector('.sol-typeahead-results');
    if (list) list.hidden = true;
    if (input) input.setAttribute('aria-expanded', 'false');
  }

  function closeAllTypeaheads() {
    closeTypeahead('part_no');
    closeTypeahead('inventory_code');
  }

  function renderTypeahead(field) {
    const box = state.addSearch[field];
    const wrap = document.querySelector(`.sol-typeahead[data-sol-field="${field}"]`);
    const input = wrap?.querySelector('input');
    const list = wrap?.querySelector('.sol-typeahead-results');
    if (!box || !list || !input) return;
    if (!box.open) {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      return;
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (box.loading) {
      list.innerHTML = '<div class="sol-typeahead-status">Searching...</div>';
      return;
    }
    if (!box.hits.length) {
      list.innerHTML = '<div class="sol-typeahead-status">No matching part / inventory code. You can still add the typed value.</div>';
      return;
    }
    list.innerHTML = box.hits.map((hit, index) => {
      const active = index === box.activeIndex ? ' is-active' : '';
      const desc = hit.description
        ? `<span class="sol-typeahead-desc">${escapeHtml(hit.description)}</span>`
        : '';
      const code = hit.inventory_code || hit.part_no || '';
      return `
        <button type="button" class="sol-typeahead-item${active}" role="option" data-index="${index}">
          <span class="sol-typeahead-code">${escapeHtml(code)}</span>
          ${desc}
        </button>`;
    }).join('');
  }

  function applyTypeaheadHit(field, hit) {
    const code = String(hit?.inventory_code || hit?.part_no || '').trim();
    if (!code) return;
    const wrap = document.querySelector(`.sol-typeahead[data-sol-field="${field}"]`);
    const input = wrap?.querySelector('input');
    if (input) input.value = code;
    const otherField = field === 'part_no' ? 'inventory_code' : 'part_no';
    const otherInput = document.querySelector(`.sol-typeahead[data-sol-field="${otherField}"] input`);
    if (otherInput && !String(otherInput.value || '').trim()) {
      otherInput.value = code;
    }
    closeTypeahead(field);
  }

  async function runTypeaheadSearch(field, query) {
    const box = state.addSearch[field];
    if (!box) return;
    const needle = String(query || '').trim();
    if (needle.length < 2) {
      box.hits = [];
      box.loading = false;
      box.open = Boolean(needle);
      renderTypeahead(field);
      return;
    }
    box.loading = true;
    box.open = true;
    renderTypeahead(field);
    try {
      const data = await requestJson(
        `/api/material-tracking/requests/search?q=${encodeURIComponent(needle)}&limit=20`,
      );
      if (String(document.querySelector(`.sol-typeahead[data-sol-field="${field}"] input`)?.value || '').trim() !== needle) {
        return;
      }
      box.hits = Array.isArray(data.rows) ? data.rows : [];
      box.activeIndex = box.hits.length ? 0 : -1;
    } catch (err) {
      box.hits = [];
      setAddStatus('error', err.message || 'Search failed');
    } finally {
      box.loading = false;
      renderTypeahead(field);
    }
  }

  function bindTypeahead(field) {
    const wrap = document.querySelector(`.sol-typeahead[data-sol-field="${field}"]`);
    const input = wrap?.querySelector('input');
    const list = wrap?.querySelector('.sol-typeahead-results');
    const box = state.addSearch[field];
    if (!wrap || !input || !list || !box || wrap.dataset.bound === '1') return;
    wrap.dataset.bound = '1';

    input.addEventListener('input', () => {
      window.clearTimeout(box.timer);
      box.timer = window.setTimeout(() => runTypeaheadSearch(field, input.value), 220);
    });

    input.addEventListener('focus', () => {
      if (String(input.value || '').trim().length >= 2) {
        box.open = true;
        renderTypeahead(field);
      }
    });

    input.addEventListener('keydown', e => {
      if (!box.open) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        box.activeIndex = Math.min(box.hits.length - 1, box.activeIndex + 1);
        renderTypeahead(field);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        box.activeIndex = Math.max(0, box.activeIndex - 1);
        renderTypeahead(field);
      } else if (e.key === 'Enter') {
        if (box.activeIndex >= 0 && box.hits[box.activeIndex]) {
          e.preventDefault();
          applyTypeaheadHit(field, box.hits[box.activeIndex]);
        }
      } else if (e.key === 'Escape') {
        closeTypeahead(field);
      }
    });

    list.addEventListener('mousedown', e => {
      const btn = e.target.closest('.sol-typeahead-item');
      if (!btn) return;
      e.preventDefault();
      const hit = box.hits[Number(btn.dataset.index)];
      if (hit) applyTypeaheadHit(field, hit);
    });
  }

  async function addRequest() {
    const partNo = String(document.getElementById('sol-req-part')?.value || '').trim();
    const inventoryCode = String(document.getElementById('sol-req-inv')?.value || '').trim();
    const qty = String(document.getElementById('sol-req-qty')?.value || '').trim();
    const btn = document.getElementById('sol-req-add');
    if (!partNo && !inventoryCode) {
      setAddStatus('error', 'Enter a part no or inventory code.');
      return;
    }
    if (btn) btn.disabled = true;
    setAddStatus('', 'Adding...');
    try {
      const data = await requestJson('/api/material-tracking/requests', {
        method: 'POST',
        body: {
          part_no: partNo,
          inventory_code: inventoryCode,
          qty: qty || null,
        },
      });
      const row = data.row;
      if (row) state.requests.unshift(row);
      state.requestsLoaded = true;
      document.getElementById('sol-req-part').value = '';
      document.getElementById('sol-req-inv').value = '';
      document.getElementById('sol-req-qty').value = '';
      closeAllTypeaheads();
      setAddStatus('saved', 'Request added.');
      window.setTimeout(() => setAddStatus('', ''), 1600);
      render();
    } catch (err) {
      setAddStatus('error', err.message || 'Add failed');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function deleteRequestRow(btn) {
    const requestId = requestIdOf(btn);
    if (!requestId) return;
    const found = findRequest(requestId);
    const label = found?.part_no || found?.inventory_code || `#${requestId}`;
    if (!window.confirm(`Remove request for ${label}?`)) return;
    btn.disabled = true;
    try {
      await requestJson(`/api/material-tracking/requests/${requestId}`, { method: 'DELETE' });
      state.requests = state.requests.filter(row => Number(row.request_id) !== requestId);
      render();
    } catch (err) {
      btn.disabled = false;
      window.alert(err.message || 'Remove failed');
    }
  }

  function bindRequestAdd() {
    const addBtn = document.getElementById('sol-req-add');
    if (addBtn && addBtn.dataset.bound !== '1') {
      addBtn.dataset.bound = '1';
      addBtn.addEventListener('click', () => addRequest());
    }
    bindTypeahead('part_no');
    bindTypeahead('inventory_code');
    const qtyInput = document.getElementById('sol-req-qty');
    if (qtyInput && qtyInput.dataset.bound !== '1') {
      qtyInput.dataset.bound = '1';
      qtyInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addRequest();
        }
      });
    }
    document.addEventListener('click', e => {
      if (e.target.closest('.sol-typeahead')) return;
      closeAllTypeaheads();
    });
  }

  function init() {
    document.querySelectorAll('[data-sol-view]').forEach(btn => {
      btn.addEventListener('click', () => setView(btn.getAttribute('data-sol-view')));
    });

    document.querySelectorAll('[data-sol-bucket]').forEach(btn => {
      btn.addEventListener('click', () => setBucket(btn.getAttribute('data-sol-bucket')));
    });

    document.querySelectorAll('[data-sol-qc-bucket]').forEach(btn => {
      btn.addEventListener('click', () => setQcBucket(btn.getAttribute('data-sol-qc-bucket')));
    });

    document.getElementById('sol-search')?.addEventListener('input', e => {
      state.search = e.target.value || '';
      render();
    });

    document.getElementById('sol-material-filter')?.addEventListener('change', e => {
      state.materialFilter = e.target.value || 'all';
      render();
    });

    document.getElementById('sol-refresh')?.addEventListener('click', () => load({ refresh: true }));

    bindMaterialButtons();
    bindPsTypeDropdown();
    bindRequestAdd();
    syncNavUi();
    // Cache-first (same as Sales Orders). Use Refresh for a live ERP reload.
    load({ refresh: false });
    loadRequests({ refresh: false, silent: true });
    loadQcChecklist({ refresh: false, silent: true });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
