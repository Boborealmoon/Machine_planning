// Material Tracking - logistics view for material-in dates, PR enquiry, and POs.

(function () {
  'use strict';

  const MATERIAL_ARRIVED = 'ARRIVED';
  const PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
  const EM_DASH = '-';
  const PS_VIEWS = new Set(['active', 'no-wo']);
  const PR_PO_VIEWS = new Set(['pr-enquiry', 'purchase-order']);
  const BUCKET_LABELS = { ost: 'Outstanding', new: 'New', hst: 'History' };
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
  };

  function isPrPoView(view) {
    return PR_PO_VIEWS.has(view || state.view);
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

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
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

  function findPp(ppVoucherNo) {
    const target = String(ppVoucherNo || '').trim();
    for (const order of state.active) {
      const pp = (order.pp_vouchers || []).find(row => String(row.pp_voucher_no || '').trim() === target);
      if (pp) return { order, pp };
    }
    return { order: null, pp: null };
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
    });
  }

  function setDelayStatus(control, status, message) {
    const el = control?.closest('.sol-delay-cell')?.querySelector('.sol-delay-status');
    if (!el) return;
    el.className = `sol-delay-status${status ? ` is-${status}` : ''}`;
    el.textContent = message || '';
  }

  async function saveDelayFlag(input) {
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
        <td class="sol-desc" title="${escapeHtml(String(pp.description || ''))}">${escapeHtml(String(pp.description || EM_DASH))}</td>
        <td class="sol-date sol-col-due">${escapeHtml(formatDate(pp.due_date))}</td>
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
        <td class="sol-desc" title="${escapeHtml(desc)}">${escapeHtml(desc || EM_DASH)}</td>
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

  function setSaveStatus(control, status, message) {
    const el = control?.closest('.so-editable-cell, .so-material-subcon-cell')?.querySelector('.so-editable-status');
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

  async function saveMaterialCell(cell, nextValue) {
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
    const ppNo = String(control.dataset.ppVoucherNo || '').trim();
    const field = String(control.dataset.field || '').trim();
    if (!ppNo || field !== 'mtl_part_order') return;
    const key = `${ppNo}::${field}`;
    if (state.saveInFlight.has(key)) return;
    const nextValue = String(control.value || '').trim();
    const lastSaved = String(control.dataset.lastSaved || '');
    if (nextValue === lastSaved) return;

    state.saveInFlight.add(key);
    setSaveStatus(control, 'saving', 'Saving...');
    try {
      const data = await postJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, {
        [field]: nextValue,
      });
      const saved = String(data[field] || '').trim();
      control.value = saved;
      control.dataset.lastSaved = saved;
      const found = findPp(ppNo);
      if (found.pp) found.pp[field] = saved;
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
  }

  function updatePsStats(rows) {
    const subtitle = document.getElementById('sol-subtitle');
    const activeJobs = countActiveJobs();
    const noWoJobs = countNoWoJobs();
    const viewLabel = state.view === 'no-wo' ? 'No WO' : 'Active';

    setChipCount('sol-active-count', activeJobs);
    setChipCount('sol-no-wo-count', noWoJobs);
    updatePrPoChipCounts();

    if (subtitle) {
      subtitle.textContent = `${rows.length} ${viewLabel} rows shown | ${activeJobs} active PP | ${noWoJobs} awaiting WO`;
    }
  }

  function updatePrPoStats(rows) {
    const subtitle = document.getElementById('sol-subtitle');
    const scopeLabel = state.view === 'purchase-order' ? 'Purchase Order' : 'PR Enquiry';
    const bucketLabel = BUCKET_LABELS[state.prPoBucket] || state.prPoBucket;
    updatePrPoChipCounts();
    if (subtitle) {
      subtitle.textContent = `${rows.length} ${scopeLabel} · ${bucketLabel} rows shown`;
    }
  }

  function syncNavUi() {
    const prPo = isPrPoView();
    const bucketGroup = document.getElementById('sol-bucket-group');
    const newBucketBtn = document.querySelector('[data-sol-bucket="new"]');
    const search = document.getElementById('sol-search');
    const legend = document.getElementById('sol-legend');

    document.querySelectorAll('.sol-ps-only').forEach(el => {
      el.hidden = prPo;
    });

    if (bucketGroup) bucketGroup.hidden = !prPo;
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

    if (search) {
      search.placeholder = prPo
        ? 'Search PR, PO, item, supplier...'
        : 'Search SO, PP, part, customer...';
    }
    if (legend) legend.hidden = prPo;
  }

  function ensureTableHead() {
    const head = document.getElementById('sol-table-head');
    if (!head) return;
    const mode = isPrPoView() ? 'prpo' : 'ps';
    if (head.dataset.mode === mode) return;
    head.dataset.mode = mode;
    head.innerHTML = mode === 'prpo' ? PR_PO_TABLE_HEAD : PS_TABLE_HEAD;
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

  function render() {
    syncNavUi();
    if (isPrPoView()) renderPrPo();
    else renderPs();
  }

  function normalizeBucketForView(view, bucket) {
    if (view === 'purchase-order') {
      return bucket === 'hst' || bucket === 'new' ? bucket : 'ost';
    }
    return bucket === 'hst' ? 'hst' : 'ost';
  }

  function setView(view) {
    const next = PR_PO_VIEWS.has(view) || PS_VIEWS.has(view) ? view : 'active';
    const nextIsPrPo = isPrPoView(next);
    state.view = next;
    if (nextIsPrPo) {
      state.prPoBucket = normalizeBucketForView(next, state.prPoBucket);
    }
    syncNavUi();

    if (nextIsPrPo) {
      loadPrPo({ refresh: false });
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
      if (!textarea) return;
      saveNotesField(textarea);
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
    if (subtitle) {
      subtitle.textContent = refresh
        ? 'Refreshing from ERP (may take a minute)...'
        : 'Loading process sheets...';
    }

    const params = new URLSearchParams({ active_only: '1' });
    if (refresh) params.set('refresh', '1');

    try {
      const res = await fetch(`/api/sales-orders?${params}`, {
        cache: refresh ? 'no-store' : 'default',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      state.active = Array.isArray(payload.active) ? payload.active : [];
      state.cachedAt = payload.cached_at || '';
      state.ppCount = Number(payload.active_job_count || payload.pp_count) || 0;
      state.partialCount = Number(payload.partial_count) || 0;
      state.salesOrdersLoaded = true;
      if (!isPrPoView()) render();
    } catch (err) {
      showLoadError(err);
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

  async function load({ refresh = false } = {}) {
    if (isPrPoView()) {
      await loadPrPo({ refresh });
      return;
    }
    await loadSalesOrders({ refresh });
  }

  function init() {
    document.querySelectorAll('[data-sol-view]').forEach(btn => {
      btn.addEventListener('click', () => setView(btn.getAttribute('data-sol-view')));
    });

    document.querySelectorAll('[data-sol-bucket]').forEach(btn => {
      btn.addEventListener('click', () => setBucket(btn.getAttribute('data-sol-bucket')));
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
    syncNavUi();
    // Cache-first (same as Sales Orders). Use Refresh for a live ERP reload.
    load({ refresh: false });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
