// Material Tracking - logistics view for material-in dates and part-order notes.

(function () {
  'use strict';

  const MATERIAL_ARRIVED = 'ARRIVED';
  const PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
  const EM_DASH = '-';

  const state = {
    active: [],
    view: 'active',
    search: '',
    materialFilter: 'all',
    ppTypes: new Set(['APS', 'NPS']),
    saveInFlight: new Set(),
    cachedAt: '',
    ppCount: 0,
    partialCount: 0,
  };

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
      stageHtml = `<span class="so-dash">${EM_DASH}</span>`;
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
    const title = bomCode
      ? `BOM materials and inventory for ${partNo}`
      : `BOM materials and inventory for ${partNo}`;
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

  function renderRow(leaf) {
    const { order, pp, partial } = leaf;
    const customer = order.customer_name || order.customer_short_name || order.customer_code || EM_DASH;
    const part = partNoForRow(pp, partial) || EM_DASH;
    const psType = getPsType(pp);
    const rowCls = ppIsNoWo(pp) ? 'is-no-wo' : '';
    return `
      <tr class="${rowCls}">
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
      if (found.pp) found.pp.material_subcon = saved;
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

  function updateStats(rows) {
    const subtitle = document.getElementById('sol-subtitle');
    const activeCountEl = document.getElementById('sol-active-count');
    const noWoCountEl = document.getElementById('sol-no-wo-count');
    const activeJobs = countActiveJobs();
    const noWoJobs = countNoWoJobs();
    const viewLabel = state.view === 'no-wo' ? 'No WO' : 'Active';

    if (activeCountEl) {
      activeCountEl.textContent = String(activeJobs);
      activeCountEl.hidden = activeJobs === 0;
    }
    if (noWoCountEl) {
      noWoCountEl.textContent = String(noWoJobs);
      noWoCountEl.hidden = noWoJobs === 0;
    }
    if (subtitle) {
      subtitle.textContent = `${rows.length} ${viewLabel} rows shown | ${activeJobs} active PP | ${noWoJobs} awaiting WO`;
    }
  }

  function render() {
    const rows = visibleLeaves();
    const body = document.getElementById('sol-table-body');
    const host = document.getElementById('sol-table-host');
    const empty = document.getElementById('sol-empty');
    const loading = document.getElementById('sol-loading');
    const meta = document.getElementById('sol-meta');

    if (loading) loading.hidden = true;

    updateStats(rows);

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

  function setView(view) {
    state.view = view === 'no-wo' ? 'no-wo' : 'active';
    document.querySelectorAll('[data-sol-view]').forEach(btn => {
      const active = btn.getAttribute('data-sol-view') === state.view;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    render();
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
      const dateInput = e.target.closest('.so-material-subcon-date');
      if (!dateInput || dateInput.disabled) return;
      e.stopPropagation();
      const cell = dateInput.closest('.so-material-subcon-cell');
      if (!cell) return;
      const date = String(dateInput.value || '').trim();
      applyMaterialCellState(cell, { arrived: false, date });
      saveMaterialCell(cell, serializeMaterialSubcon({ arrived: false, date }));
    });

    body.addEventListener('blur', e => {
      const textarea = e.target.closest('.so-editable-input');
      if (!textarea) return;
      saveNotesField(textarea);
    }, true);
  }

  async function load({ refresh = false } = {}) {
    const loading = document.getElementById('sol-loading');
    const host = document.getElementById('sol-table-host');
    if (loading) loading.hidden = false;
    if (host) host.hidden = true;

    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');

    try {
      const res = await fetch(`/api/sales-orders?${params}`, {
        cache: refresh ? 'no-store' : 'default',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      state.active = Array.isArray(payload.active) ? payload.active : [];
      state.cachedAt = payload.cached_at || '';
      state.ppCount = Number(payload.pp_count) || 0;
      state.partialCount = Number(payload.partial_count) || 0;
      render();
    } catch (err) {
      if (loading) loading.hidden = true;
      const empty = document.getElementById('sol-empty');
      if (empty) {
        empty.hidden = false;
        empty.textContent = `Failed to load: ${err.message}`;
      }
    }
  }

  function init() {
    document.querySelectorAll('[data-sol-view]').forEach(btn => {
      btn.addEventListener('click', () => setView(btn.getAttribute('data-sol-view')));
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
    // Bust server cache on every page load / browser refresh (same as Refresh button).
    load({ refresh: true });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
