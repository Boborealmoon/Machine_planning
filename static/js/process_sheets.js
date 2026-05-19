(function () {
  const PAGE_SIZE = 100;

  const state = {
    items: [],
    details: new Map(),
    loading: false,
    page: 1,
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function getJson(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  function numberValue(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? num : 0;
  }

  function fmtQty(value) {
    return numberValue(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  function fmtDate(value) {
    if (!value) return '-';
    return String(value).slice(0, 10);
  }

  function firstQuantity(...values) {
    for (const value of values) {
      if (value !== null && value !== undefined && value !== '') return value;
    }
    return 0;
  }

  function boolValue(value) {
    if (value === true || value === 1) return true;
    const text = String(value || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(text);
  }

  function partialNo(item) {
    const direct = item?.pp_partial_no;
    if (direct !== null && direct !== undefined && direct !== '') return String(direct);
    const idPartial = String(item?.ps_id || '').split('::')[1];
    return idPartial || '1';
  }

  function partialLabel(item) {
    return `Partial ${partialNo(item)}`;
  }

  function woReqQty(item) {
    return firstQuantity(item?.wo_req_qty, item?.partial_qty, item?.display_qty);
  }

  function totalWoQty(item) {
    return firstQuantity(item?.total_wo_qty, item?.total_qty);
  }

  function soDetQty(item) {
    if (item?.so_det_qty === null || item?.so_det_qty === undefined || item?.so_det_qty === '') return null;
    return numberValue(item.so_det_qty);
  }

  function fmtSoQty(item) {
    if (item?.so_det_qty === null || item?.so_det_qty === undefined || item?.so_det_qty === '') return '—';
    return fmtQty(numberValue(item.so_det_qty));
  }

  const SHIPPED_QTY_TOLERANCE = 0.0001;

  function isShippedComplete(item) {
    const soQty = soDetQty(item);
    if (soQty === null) return false;
    const shipped = numberValue(item?.qty_shipped);
    return shipped >= soQty - SHIPPED_QTY_TOLERANCE;
  }

  function todayIso() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function normalizeStatus(value) {
    return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  }

  function displayStatus(value, fallback) {
    const raw = String(value || fallback || '').trim();
    if (!raw) return '-';
    return raw.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  function currentStagePill(item) {
    const desc = String(item?.current_stage_desc || '').trim();
    if (!desc) return '';
    const stageNo = item?.current_stage_no;
    const status = item?.current_stage_status ? displayExecutionStatus(item.current_stage_status) : '';
    const title = [stageNo ? `Stage ${stageNo}` : '', status].filter(Boolean).join(' · ');
    return `<span class="ps-stage-badge" title="${escapeHtml(title)}">${escapeHtml(desc)}</span>`;
  }

  function displayExecutionStatus(value) {
    const status = normalizeStatus(value);
    const labels = {
      P: 'Pending SI',
      R: 'Ready to Start',
      I: 'In Process',
      C: 'Completed',
      PENDING_SI: 'Pending SI',
      READY_TO_START: 'Ready to Start',
      IN_PROCESS: 'In Process',
      COMPLETED: 'Completed',
    };
    return labels[status] || displayStatus(value, '-');
  }

  function opExecutionStatus(op, item) {
    const directStatus = op?.execution_status || op?.erp_execution_status || '';
    if (directStatus) return directStatus;
    return item?.execution_status || item?.erp_execution_status || '';
  }

  function isExecutionCompletedStatus(value) {
    const status = normalizeStatus(value);
    return status === 'COMPLETED' || status === 'C';
  }

  function trackedExecutionStatuses(item) {
    const ops = Array.isArray(item?.ops) ? item.ops : [];
    const opStatuses = ops
      .map(op => opExecutionStatus(op, item))
      .filter(status => normalizeStatus(status));
    if (opStatuses.length) return opStatuses;
    const itemStatus = item?.execution_status || item?.erp_execution_status || '';
    return normalizeStatus(itemStatus) ? [itemStatus] : [];
  }

  function opStatusClass(value) {
    const status = normalizeStatus(value);
    if (status === 'I' || status === 'IN_PROCESS') return 'is-in-process';
    if (status === 'R' || status === 'READY_TO_START') return 'is-ready';
    if (status === 'P' || status === 'PENDING_SI') return 'is-pending';
    if (status === 'C' || status === 'COMPLETED') return 'is-completed';
    return 'is-unknown';
  }

  function renderOpStatusCell(op, item) {
    const status = opExecutionStatus(op, item);
    if (!normalizeStatus(status)) return '<span class="ps-row-muted">-</span>';
    return `<span class="ps-op-status ${opStatusClass(status)}">${escapeHtml(displayExecutionStatus(status))}</span>`;
  }

  function materialSeverity(item) {
    return String(item.material_status?.severity || '').toLowerCase();
  }

  function isMaterialShortage(item) {
    return ['late', 'warning', 'shortage'].includes(materialSeverity(item));
  }

  function isCompleted(item) {
    if (isShippedComplete(item)) return true;
    if (item && Object.prototype.hasOwnProperty.call(item, 'shipped_completed')) return boolValue(item.shipped_completed);
    if (item && Object.prototype.hasOwnProperty.call(item, 'is_completed')) return boolValue(item.is_completed);
    if (item && Object.prototype.hasOwnProperty.call(item, 'execution_completed')) return boolValue(item.execution_completed);
    const executionStatuses = trackedExecutionStatuses(item);
    return executionStatuses.length > 0 && executionStatuses.every(isExecutionCompletedStatus);
  }

  function isOverdue(item) {
    const due = fmtDate(item.due_date);
    return due !== '-' && due < todayIso() && !isCompleted(item);
  }

  function isDirectPp(item) {
    return normalizeStatus(item?.source_voucher_no) === 'DIRECT_PP';
  }

  function isSrTagged(item) {
    return [item?.ps_id, item?.source_ps_id, item?.display_ps_id]
      .some(value => /\[sr\]/i.test(String(value || '')));
  }

  function getPsType(item) {
    const raw = String(item.source_ps_id || item.display_ps_id || item.ps_id || '').split('::')[0].toUpperCase();
    const m = raw.match(/^([A-Z]+)/);
    if (!m) return null;
    const prefix = m[1];
    if (prefix === 'MPS') return 'MPS';
    if (prefix === 'APS') return 'APS';
    if (prefix === 'NPS') return 'NPS';
    if (prefix === 'PPS') return 'PPS';
    if (prefix === 'CPS') return 'CPS';
    return prefix;
  }

  function itemIdentityKey(item) {
    const sourcePsId = String(item.source_ps_id || item.display_ps_id || item.ps_id || '').split('::')[0];
    const partial = String(item.pp_partial_no || String(item.ps_id || '').split('::')[1] || '1');
    return `${sourcePsId}::${partial}`;
  }

  function itemSearchText(item) {
    return [
      item.ps_id,
      item.source_ps_id,
      item.display_ps_id,
      item.inventory_code,
      item.part_no,
      item.part_name,
      item.part_desc,
      partialLabel(item),
      item.selected_flow_code,
      item.selected_bom_code,
      item.status,
      item.planner_status,
      item.current_stage_desc,
      item.source_voucher_no,
      ...(Array.isArray(item.ops) ? item.ops.map(op => [
        op.op_no,
        op.source_op_no,
        op.stage_no,
        op.op_type,
        op.operation_name,
        opExecutionStatus(op, item),
      ].join(' ')) : []),
    ].join(' ').toLowerCase();
  }

  function parseSearchTerms(raw) {
    return String(raw || '')
      .split(/[,;]+/)
      .map(term => term.trim().toLowerCase())
      .filter(Boolean);
  }

  function matchesSearchTerms(item, terms) {
    if (!terms.length) return true;
    const haystack = itemSearchText(item);
    return terms.some(term => haystack.includes(term));
  }

  function normalizePlannerItem(item) {
    const shippedComplete = boolValue(item.shipped_completed) || isShippedComplete(item);
    return {
      ...item,
      ps_id: item.ps_id || item.display_ps_id || item.source_ps_id || '',
      display_ps_id: item.display_ps_id || item.source_ps_id || item.ps_id || '',
      source_ps_id: item.source_ps_id || item.display_ps_id || item.ps_id || '',
      pp_partial_no: partialNo(item),
      planner_status: item.planner_status || 'UNPLANNED',
      shipped_completed: shippedComplete,
      is_completed: shippedComplete || boolValue(item.is_completed),
      source: 'planner',
    };
  }

  function normalizeErpItem(item) {
    const ops = Array.isArray(item.op_cards) ? item.op_cards : (Array.isArray(item.ops) ? item.ops : []);
    return {
      ps_id: item.ps_id || '',
      display_ps_id: item.display_ps_id || String(item.ps_id || '').split('::')[0],
      source_ps_id: item.source_ps_id || item.ps_id || '',
      pp_partial_no: partialNo(item),
      inventory_code: item.inventory_code || item.part_no || '',
      part_name: item.part_name || item.part_no || '',
      part_no: item.part_no || item.inventory_code || '',
      part_desc: item.part_desc || '',
      due_date: item.due_date || '',
      order_date: item.order_date || '',
      total_qty: item.total_qty || 0,
      partial_qty: numberValue(item.partial_qty),
      wo_req_qty: firstQuantity(item.wo_req_qty, item.partial_qty, 0),
      total_wo_qty: firstQuantity(item.total_wo_qty, item.total_qty, 0),
      wo_qty_required: numberValue(item.wo_qty_required),
      display_qty: firstQuantity(item.display_qty, item.partial_qty, item.total_qty, item.wo_qty_required, 0),
      planned_qty: item.planned_qty || 0,
      finished_qty: item.finished_qty || 0,
      remaining_qty: firstQuantity(item.remaining_qty, item.wo_qty_required, item.display_qty, item.partial_qty, item.total_qty),
      status: item.status || '',
      execution_status: item.execution_status || '',
      execution_completed: item.execution_completed,
      shipped_completed: boolValue(item.shipped_completed) || isShippedComplete(item),
      is_completed: boolValue(item.shipped_completed) || isShippedComplete(item) || boolValue(item.is_completed),
      planner_status: item.planner_status || 'UNPLANNED',
      selected_flow_code: item.selected_flow_code || item.selected_bom_code || item.bom_code || '',
      route_label: item.route_label || item.selected_flow_code || item.selected_bom_code || item.bom_code || 'No flow selected',
      material_status: item.material_status || { severity: 'none', label: '' },
      warnings: item.warnings || [],
      source_voucher_no: item.source_voucher_no || '',
      qty_shipped: item.qty_shipped || 0,
      so_det_qty: item.so_det_qty,
      current_stage_no: item.current_stage_no,
      current_stage_desc: item.current_stage_desc || '',
      current_stage_status: item.current_stage_status || '',
      ops,
      source: 'erp',
    };
  }

  async function loadProcessSheets() {
    state.loading = true;
    setBusy(true, 'Loading process sheets...');
    try {
      const [plannerResult, erpResult] = await Promise.allSettled([
        getJson('/api/process-sheets?show_completed=1'),
        getJson('/api/pp-vouchers/with-ops'),
      ]);

      const plannerItems = plannerResult.status === 'fulfilled' && Array.isArray(plannerResult.value)
        ? plannerResult.value.map(normalizePlannerItem)
        : [];
      const plannerIds = new Set(plannerItems.map(itemIdentityKey));
      const erpItems = erpResult.status === 'fulfilled' && Array.isArray(erpResult.value)
        ? erpResult.value.map(normalizeErpItem).filter(item => item.ps_id && !plannerIds.has(itemIdentityKey(item)))
        : [];

      state.items = [...plannerItems, ...erpItems].sort((a, b) => {
        const due = String(a.due_date || '').localeCompare(String(b.due_date || ''));
        const source = String(a.source_ps_id || a.display_ps_id || a.ps_id || '')
          .localeCompare(String(b.source_ps_id || b.display_ps_id || b.ps_id || ''));
        const partial = Number(partialNo(a)) - Number(partialNo(b));
        return due || source || partial || String(a.ps_id || '').localeCompare(String(b.ps_id || ''));
      });

      if (plannerResult.status === 'rejected' && erpResult.status === 'rejected') {
        throw plannerResult.reason || erpResult.reason;
      }

      render();
    } catch (err) {
      console.error('process sheet load failed:', err);
      state.items = [];
      renderError(err.message || 'Could not load process sheets.');
    } finally {
      state.loading = false;
      setBusy(false);
    }
  }

  function describeActiveFilters() {
    const parts = [];
    const typeInputs = els.typePanel
      ? [...els.typePanel.querySelectorAll('input[type=checkbox]')]
      : [];
    const checkedTypes = typeInputs.filter(cb => cb.checked).map(cb => cb.value);
    if (typeInputs.length && checkedTypes.length < typeInputs.length) {
      parts.push(checkedTypes.length === 0
        ? 'no process sheet types selected'
        : `types: ${checkedTypes.join(', ')} only`);
    }
    if (els.hideSrTags?.checked) parts.push('hiding [SR]');
    if (els.hideDirectPp?.checked) parts.push('hiding Direct PP');
    if (els.completedOnly?.checked) parts.push('completed only');
    else if (!els.showCompleted?.checked) parts.push('hiding completed');
    if (els.overdueOnly?.checked) parts.push('overdue only');
    if (String(els.search?.value || '').trim()) parts.push('search active');
    if (els.plannerFilter?.value) parts.push(`planner: ${els.plannerFilter.value}`);
    if (els.materialFilter?.value === 'shortage') parts.push('material shortage only');
    return parts;
  }

  function resetFilters() {
    const defaults = new Set(['APS', 'NPS']);
    els.typePanel?.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = defaults.has(cb.value); });
    if (els.typeBtn) els.typeBtn.textContent = 'APS, NPS ▾';
    if (els.search) els.search.value = '';
    if (els.plannerFilter) els.plannerFilter.value = '';
    if (els.materialFilter) els.materialFilter.value = '';
    if (els.overdueOnly) els.overdueOnly.checked = false;
    if (els.completedOnly) els.completedOnly.checked = false;
    if (els.showCompleted) els.showCompleted.checked = false;
    state.page = 1;
    render();
  }

  function filteredItems() {
    const searchTerms = parseSearchTerms(els.search?.value);
    const planner = normalizeStatus(els.plannerFilter?.value || '');
    const material = String(els.materialFilter?.value || '').trim();
    const overdueOnly = Boolean(els.overdueOnly?.checked);
    const showCompleted = Boolean(els.showCompleted?.checked);
    const completedOnly = Boolean(els.completedOnly?.checked);
    const hideDirectPp = Boolean(els.hideDirectPp?.checked);
    const hideSrTags = Boolean(els.hideSrTags?.checked);
    const allTypeInputs = els.typePanel ? els.typePanel.querySelectorAll('input[type=checkbox]') : [];
    const checkedTypes = els.typePanel
      ? new Set([...els.typePanel.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value))
      : new Set(['APS', 'NPS']);
    const allTypesOn = checkedTypes.size === allTypeInputs.length;

    return state.items.filter(item => {
      if (hideDirectPp && !completedOnly && !searchTerms.length && isDirectPp(item)) return false;
      if (hideSrTags && !completedOnly && !searchTerms.length && isSrTagged(item)) return false;
      if (!allTypesOn) {
        const t = getPsType(item);
        if (t && !checkedTypes.has(t)) return false;
      }
      if (!matchesSearchTerms(item, searchTerms)) return false;
      if (planner && normalizeStatus(item.planner_status) !== planner) return false;
      if (material === 'shortage' && !isMaterialShortage(item)) return false;
      if (overdueOnly && !isOverdue(item)) return false;
      if (completedOnly && !isCompleted(item)) return false;
      if (!completedOnly && !showCompleted && isCompleted(item)) return false;
      return true;
    });
  }

  function render() {
    const items = filteredItems();
    renderCounts();
    renderQueue(items);
  }

  function renderCounts() {
    const visibleBase = state.items;
    const counts = {
      PARTIALLY_PLANNED: 0,
      PLANNED: 0,
      NEEDS_REVIEW: 0,
      COMPLETED: 0,
      OVERDUE: 0,
    };
    visibleBase.forEach(item => {
      const planner = normalizeStatus(item.planner_status || 'UNPLANNED');
      if (counts[planner] != null) counts[planner] += 1;
      if (isCompleted(item)) counts.COMPLETED += 1;
      if (isOverdue(item)) counts.OVERDUE += 1;
    });

    setText('ps-count-partially-planned', counts.PARTIALLY_PLANNED);
    setText('ps-count-planned', counts.PLANNED);
    setText('ps-count-needs-review', counts.NEEDS_REVIEW);
    setText('ps-count-completed', counts.COMPLETED);
    setText('ps-count-overdue', counts.OVERDUE);
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value);
  }

  function renderQueue(items) {
    if (!els.queue) return;
    if (!items.length) {
      if (state.loading) {
        els.queue.innerHTML = '<div class="queue-empty">Loading process sheets...</div>';
      } else if (state.items.length > 0) {
        const filterParts = describeActiveFilters();
        const filterLine = filterParts.length
          ? `<p class="queue-empty-filters">${escapeHtml(filterParts.join(' · '))}</p>`
          : '';
        els.queue.innerHTML = [
          '<div class="queue-empty">',
          '<p><strong>No process sheets match the current filters.</strong></p>',
          `<p class="queue-empty-meta">${escapeHtml(state.items.length)} loaded · 0 shown after filters</p>`,
          filterLine,
          '<p class="queue-empty-meta">ERP rows come from <code>pp_vouchers_cache</code> (sync rebuilds from <code>vw_pp_vouchers</code>).</p>',
          '<button class="btn btn-light btn-sm queue-empty-reset" type="button" data-action="reset-filters">Reset filters</button>',
          '</div>',
        ].join('');
      } else {
        els.queue.innerHTML = [
          '<div class="queue-empty">',
          '<p>No process sheets found.</p>',
          '<p class="queue-empty-meta">Run <strong>Sync ERP</strong> after applying the Supabase view migration, then refresh.</p>',
          '</div>',
        ].join('');
      }
      if (els.queueHint) {
        els.queueHint.textContent = state.items.length > 0
          ? `${state.items.length} loaded · 0 matched`
          : '0 loaded';
      }
      return;
    }

    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    state.page = Math.min(Math.max(state.page, 1), totalPages);

    const start = (state.page - 1) * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, items.length);
    const pageItems = items.slice(start, end);

    if (els.queueHint) {
      const erpOnly = items.filter(item => item.source === 'erp').length;
      els.queueHint.textContent = `${start + 1}-${end} shown from ${items.length} matched | ${state.items.length} loaded${erpOnly ? ` (${erpOnly} ERP-only)` : ''}`;
    }

    const openItems = pageItems.filter(item => !isCompleted(item));
    const completedItems = pageItems.filter(item => isCompleted(item));
    els.queue.innerHTML = [
      renderQueueGroup('Open Partials', openItems),
      renderQueueGroup('Completed Partials', completedItems),
      renderPagination(items.length, start, end, totalPages),
    ].filter(Boolean).join('');
  }

  function renderPagination(totalItems, start, end, totalPages) {
    if (totalItems <= PAGE_SIZE) return '';
    const prevDisabled = state.page <= 1 ? 'disabled' : '';
    const nextDisabled = state.page >= totalPages ? 'disabled' : '';
    return `
      <nav class="ps-pagination" aria-label="Process sheet pages">
        <span>Rows ${escapeHtml(start + 1)}-${escapeHtml(end)} of ${escapeHtml(totalItems)}</span>
        <div class="ps-pagination-actions">
          <button class="btn btn-light btn-sm" type="button" data-action="page-prev" ${prevDisabled}>Previous</button>
          <strong>Page ${escapeHtml(state.page)} of ${escapeHtml(totalPages)}</strong>
          <button class="btn btn-light btn-sm" type="button" data-action="page-next" ${nextDisabled}>Next</button>
        </div>
      </nav>
    `;
  }

  function renderQueueGroup(title, items) {
    if (!items.length) return '';
    return `
      <section class="ps-queue-group">
        <div class="ps-queue-group-title">
          <span>${escapeHtml(title)}</span>
          <strong>${escapeHtml(items.length)}</strong>
        </div>
        <div class="ps-queue-group-list">
          ${items.map(renderQueueItem).join('')}
        </div>
      </section>
    `;
  }

  function renderQueueItem(item) {
    const psId = item.ps_id || item.display_ps_id || '';
    const warnings = Array.isArray(item.warnings) ? item.warnings : [];
    const ops = Array.isArray(item.ops) ? item.ops : [];
    const badgeClass = `ps-badge--${normalizeStatus(item.planner_status || 'UNPLANNED').toLowerCase().replace(/_/g, '-')}`;
    const material = item.material_status?.label || (isMaterialShortage(item) ? 'Material risk' : 'Material OK');
    const dueClass = isOverdue(item) ? 'is-overdue' : '';
    const partial = `<span class="ps-partial-badge">${escapeHtml(partialLabel(item))}</span>`;
    const totalQty = `<span class="ps-total-qty-badge">Total WO Qty ${escapeHtml(fmtQty(totalWoQty(item)))}</span>`;
    const source = item.source === 'erp' ? '<span class="ps-source-badge">ERP</span>' : '';
    const voucher = item.source_voucher_no ? `<span class="ps-voucher-badge">${escapeHtml(item.source_voucher_no)}</span>` : '';
    const stagePill = currentStagePill(item);
    const titleBadges = [partial, totalQty, source, voucher, stagePill].filter(Boolean).join('\n            ');
    const opStatusStrip = renderOpStatusStrip(ops, item);
    const due = fmtDate(item.due_date);
    const route = item.route_label || item.erp_bom_code || item.selected_flow_code || item.selected_bom_code || 'No flow selected';
    const descriptor = item.part_desc || 'No description';

    return `
      <article class="ps-row ${dueClass}" data-ps-id="${escapeHtml(psId)}">
        <button class="ps-row-main" type="button" data-action="toggle-details" data-ps-id="${escapeHtml(psId)}">
          <div class="ps-row-title">
            <span class="ps-id">${escapeHtml(item.display_ps_id || psId)}</span>
            ${titleBadges}
          </div>
          <div class="ps-row-part">
            <strong>${escapeHtml(item.part_no || item.part_name || item.inventory_code || 'No part')}</strong>
            <span>${escapeHtml(descriptor)}</span>
          </div>
          <div class="ps-row-highlights">
            <span class="ps-highlight ps-highlight--due ${isOverdue(item) ? 'is-overdue' : ''}">
              <small>Due</small><strong>${escapeHtml(due)}</strong>
            </span>
            <span class="ps-highlight"><small>WO Req</small><strong>${escapeHtml(fmtQty(woReqQty(item)))}</strong></span>
            <span class="ps-highlight"><small>Total</small><strong>${escapeHtml(fmtQty(totalWoQty(item)))}</strong></span>
            ${isMaterialShortage(item) ? `<span class="ps-highlight ps-highlight--risk"><small>Material</small><strong>${escapeHtml(material)}</strong></span>` : ''}
            ${warnings.length ? `<span class="ps-highlight ps-highlight--risk"><small>Warnings</small><strong>${warnings.length}</strong></span>` : ''}
          </div>
          <div class="ps-row-route">
            <span>BOM / Route</span>
            <strong>${escapeHtml(route)}</strong>
          </div>
          ${opStatusStrip}
        </button>
        <div class="ps-row-side">
          <span class="ps-badge ${badgeClass}">${escapeHtml(displayStatus(item.planner_status, 'Unplanned'))}</span>
          <span class="ps-row-muted">${ops.length} op${ops.length === 1 ? '' : 's'}</span>
        </div>
        <div class="ps-details" id="ps-details-${escapeHtml(cssSafeId(psId))}" hidden></div>
      </article>
    `;
  }

  function renderOpStatusStrip(ops, item) {
    const visibleOps = (Array.isArray(ops) ? ops : [])
      .filter(op => op && normalizeStatus(opExecutionStatus(op, item)));
    if (!visibleOps.length) return '';

    const maxVisible = 6;
    const chips = visibleOps.slice(0, maxVisible).map(op => {
      const opNo = op.op_no || op.source_op_no || op.stage_no || op.operation_label || '-';
      const opName = op.op_type || op.operation_name || op.stage_desc || '';
      const status = opExecutionStatus(op, item);
      const label = displayExecutionStatus(status);
      return `
        <span class="ps-op-status ${opStatusClass(status)}" title="${escapeHtml(opName)}">
          <strong>${escapeHtml(opNo)}</strong>
          <span>${escapeHtml(label)}</span>
        </span>
      `;
    }).join('');
    const overflow = visibleOps.length > maxVisible
      ? `<span class="ps-op-status is-overflow">+${escapeHtml(visibleOps.length - maxVisible)} more</span>`
      : '';
    return `<div class="ps-op-status-strip">${chips}${overflow}</div>`;
  }

  function cssSafeId(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  async function toggleDetails(psId) {
    const item = state.items.find(row => String(row.ps_id || '') === String(psId));
    const detailsEl = $(`ps-details-${cssSafeId(psId)}`);
    if (!item || !detailsEl) return;

    if (!detailsEl.hidden) {
      detailsEl.hidden = true;
      return;
    }

    detailsEl.hidden = false;
    if (state.details.has(psId)) {
      detailsEl.innerHTML = renderDetails(state.details.get(psId), item);
      return;
    }

    if (item.source === 'erp') {
      const details = { summary: item, planned_blocks: [], cards: [], requirements: [], erp_only: true };
      state.details.set(psId, details);
      detailsEl.innerHTML = renderDetails(details, item);
      return;
    }

    detailsEl.innerHTML = '<div class="ps-details-loading">Loading details...</div>';
    try {
      const details = await getJson(`/api/process-sheets/${encodeURIComponent(psId)}/details`);
      state.details.set(psId, details);
      detailsEl.innerHTML = renderDetails(details, item);
    } catch (err) {
      detailsEl.innerHTML = `<div class="ps-details-error">Could not load details: ${escapeHtml(err.message)}</div>`;
    }
  }

  function collectDetailOps(summary, item) {
    const seen = new Set();
    const merged = [];
    for (const op of [
      ...(Array.isArray(summary?.ops) ? summary.ops : []),
      ...(Array.isArray(item?.ops) ? item.ops : []),
      ...(Array.isArray(item?.op_cards) ? item.op_cards : []),
    ]) {
      if (!op) continue;
      const key = [
        op.op_seq_id || op.source_op_seq_id || '',
        op.op_no || op.source_op_no || op.operation_label || '',
        op.stage_no || '',
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(op);
    }
    return merged;
  }

  function renderDetails(details, item) {
    const summary = details.summary || item;
    const ops = collectDetailOps(summary, item);
    const plannedBlocks = Array.isArray(details.planned_blocks) ? details.planned_blocks : [];
    const requirements = Array.isArray(details.requirements) ? details.requirements : [];

    const qtyShipped = Number(summary.qty_shipped || 0);
    const sourceVoucher = summary.source_voucher_no || '';
    return `
      <div class="ps-details-grid">
        <div class="ps-detail-card">
          <div class="ps-detail-label">Progress</div>
          <div class="ps-detail-stats">
            <span><small>WO Req</small><strong>${escapeHtml(fmtQty(woReqQty(summary)))}</strong></span>
            <span><small>Total Qty</small><strong>${escapeHtml(fmtQty(totalWoQty(summary)))}</strong></span>
            <span><small>Operations</small><strong>${escapeHtml(ops.length)} op${ops.length === 1 ? '' : 's'}</strong></span>
          </div>
        </div>
        <div class="ps-detail-card">
          <div class="ps-detail-label">Timing</div>
          <div class="ps-detail-stats ps-detail-stats--timing">
            <span><small>Due Date</small><strong>${escapeHtml(fmtDate(summary.due_date))}</strong></span>
            <span><small>Start</small><strong>${escapeHtml(summary.expected_start ? String(summary.expected_start).slice(0, 16) : '-')}</strong></span>
            <span><small>End</small><strong>${escapeHtml(summary.expected_end ? String(summary.expected_end).slice(0, 16) : '-')}</strong></span>
          </div>
        </div>
        ${(sourceVoucher || soDetQty(summary) !== null || qtyShipped > 0) ? `
        <div class="ps-detail-card ps-detail-card--voucher">
          <div class="ps-detail-label">Sales Order</div>
          <div class="ps-detail-stats">
            ${sourceVoucher ? `<span><small>Voucher No</small><strong>${escapeHtml(sourceVoucher)}</strong></span>` : ''}
            ${sourceVoucher ? `<span><small>SO Qty</small><strong>${escapeHtml(fmtSoQty(summary))}</strong></span>` : ''}
            <span><small>Shipped</small><strong>${escapeHtml(fmtQty(qtyShipped))}</strong></span>
          </div>
        </div>` : ''}
      </div>
      ${details.erp_only ? '<div class="ps-details-note">This row is from the ERP catalog and has not been materialized in planner state yet.</div>' : ''}
      ${renderOps(ops, summary, plannedBlocks)}
      ${renderBlocks(plannedBlocks)}
      ${renderRequirements(requirements)}
    `;
  }

  function renderOps(ops, summary, plannedBlocks) {
    const blocks = Array.isArray(plannedBlocks) ? plannedBlocks : [];
    if (!ops.length) {
      const hint = blocks.length
        ? '<p class="ps-details-empty-hint">No operation steps in BOM flow or ERP cache. Scheduled blocks are listed below.</p>'
        : '';
      return `
        <div class="ps-detail-section">
          <div class="ps-detail-label">Operation Steps</div>
          <div class="ps-details-empty">No operations found for this process sheet.</div>
          ${hint}
        </div>
      `;
    }
    return `
      <div class="ps-detail-section">
        <div class="ps-detail-label">Operation Steps</div>
        <div class="ps-table-wrap">
        <table class="ps-table">
          <thead>
            <tr>
              <th>Op</th>
              <th>Type</th>
              <th>Machine</th>
              <th>ERP Stage</th>
              <th>WO Req</th>
              <th>Planned</th>
              <th>Finished</th>
              <th>Rejected</th>
              <th>Remaining</th>
            </tr>
          </thead>
          <tbody>
            ${ops.map(op => `
              <tr>
                <td>${escapeHtml(op.op_no || op.source_op_no || op.operation_label || '-')}</td>
                <td>${escapeHtml(op.op_type || op.operation_name || op.stage_desc || '-')}</td>
                <td>${escapeHtml(op.preferred_machine || op.machine_code || op.compatible_machine_group || '-')}</td>
                <td>${renderOpStatusCell(op, summary)}</td>
                <td>${escapeHtml(fmtQty(firstQuantity(op.wo_qty_required, op.required_qty, op.target_qty)))}</td>
                <td>${escapeHtml(fmtQty(op.planned_qty))}</td>
                <td>${escapeHtml(fmtQty(op.finished_qty))}</td>
                <td>${escapeHtml(fmtQty(op.reject_qty))}</td>
                <td>${escapeHtml(fmtQty(firstQuantity(op.remaining_qty, op.target_qty, op.total_qty)))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        </div>
      </div>
    `;
  }

  function renderBlocks(blocks) {
    if (!blocks.length) return '';
    return `
      <div class="ps-detail-section">
        <div class="ps-detail-label">Planned Blocks</div>
        <div class="ps-chip-list">
          ${blocks.map(block => `
            <span class="ps-chip">
              ${escapeHtml(block.machine_code || block.machine_no || 'Machine TBD')}
              · ${escapeHtml(block.source_op_no || block.operation_label || 'Op')}
              · Qty ${escapeHtml(fmtQty(block.scheduled_qty))}
            </span>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderRequirements(requirements) {
    if (!requirements.length) return '';
    return `
      <div class="ps-detail-section">
        <div class="ps-detail-label">Material Requirements</div>
        <div class="ps-chip-list">
          ${requirements.map(req => `
            <span class="ps-chip">
              ${escapeHtml(req.material_code || req.inventory_code || 'Material')}
              · ${escapeHtml(req.status || req.requirement_status || 'Pending')}
            </span>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderError(message) {
    if (els.queue) {
      els.queue.innerHTML = `<div class="queue-empty">Failed to load process sheets: ${escapeHtml(message)}</div>`;
    }
    if (els.queueHint) els.queueHint.textContent = 'Load failed';
  }

  function setBusy(busy, hint) {
    if (els.refreshBtn) els.refreshBtn.disabled = busy;
    if (els.queueHint && hint) els.queueHint.textContent = hint;
  }

  function bind() {
    els.queue = $('ps-queue');
    els.queueHint = $('ps-queue-hint');
    els.search = $('ps-search');
    els.plannerFilter = $('ps-planner-filter');
    els.materialFilter = $('ps-material-filter');
    els.overdueOnly = $('ps-overdue-only');
    els.showCompleted = $('ps-show-completed');
    els.completedOnly = $('ps-completed-only');
    els.hideDirectPp = $('ps-hide-direct-pp');
    els.hideSrTags = $('ps-hide-sr-tags');
    els.typeBtn = $('ps-type-btn');
    els.typePanel = $('ps-type-panel');
    els.refreshBtn = $('ps-refresh-btn');

    // PS type dropdown toggle
    els.typeBtn?.addEventListener('click', e => {
      e.stopPropagation();
      els.typePanel.hidden = !els.typePanel.hidden;
    });
    document.addEventListener('click', e => {
      if (els.typePanel && !els.typePanel.hidden && !$('ps-type-dropdown')?.contains(e.target)) {
        els.typePanel.hidden = true;
      }
    });
    els.typePanel?.addEventListener('change', () => {
      const all = [...els.typePanel.querySelectorAll('input')];
      const checked = all.filter(cb => cb.checked).map(cb => cb.value);
      els.typeBtn.textContent = checked.length === all.length ? 'All Types ▾' : checked.length === 0 ? 'No Types ▾' : checked.join(', ') + ' ▾';
      state.page = 1;
      render();
    });

    [els.search, els.plannerFilter, els.materialFilter, els.overdueOnly, els.showCompleted, els.completedOnly, els.hideDirectPp, els.hideSrTags]
      .filter(Boolean)
      .forEach(el => el.addEventListener('input', () => {
        state.page = 1;
        render();
      }));

    els.refreshBtn?.addEventListener('click', () => {
      state.details.clear();
      loadProcessSheets();
    });
    els.queue?.addEventListener('click', event => {
      if (event.target.closest('[data-action="reset-filters"]')) {
        resetFilters();
        return;
      }

      const trigger = event.target.closest('[data-action="toggle-details"]');
      if (trigger) {
        toggleDetails(trigger.dataset.psId || '');
        return;
      }

      const pageButton = event.target.closest('[data-action="page-prev"], [data-action="page-next"]');
      if (!pageButton) return;
      state.page += pageButton.dataset.action === 'page-prev' ? -1 : 1;
      render();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    loadProcessSheets();
  });

  window.addEventListener('pp-vouchers-synced', () => {
    state.details.clear();
    setBusy(true, 'Refreshing process sheets...');
    loadProcessSheets().finally(() => setBusy(false));
  });
})();
