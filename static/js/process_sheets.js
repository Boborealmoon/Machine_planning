(function () {
  const state = {
    items: [],
    details: new Map(),
    loading: false,
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

  function materialSeverity(item) {
    return String(item.material_status?.severity || '').toLowerCase();
  }

  function isMaterialShortage(item) {
    return ['late', 'warning', 'shortage'].includes(materialSeverity(item));
  }

  function isCompleted(item) {
    const planner = normalizeStatus(item.planner_status);
    const status = normalizeStatus(item.status);
    return planner === 'COMPLETED' || status === 'COMPLETED' || status === 'HISTORY';
  }

  function isOverdue(item) {
    const due = fmtDate(item.due_date);
    return due !== '-' && due < todayIso() && !isCompleted(item);
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
      item.selected_flow_code,
      item.selected_bom_code,
      item.status,
      item.planner_status,
    ].join(' ').toLowerCase();
  }

  function normalizePlannerItem(item) {
    return {
      ...item,
      ps_id: item.ps_id || item.display_ps_id || item.source_ps_id || '',
      display_ps_id: item.display_ps_id || item.source_ps_id || item.ps_id || '',
      source_ps_id: item.source_ps_id || item.display_ps_id || item.ps_id || '',
      planner_status: item.planner_status || 'UNPLANNED',
      source: 'planner',
    };
  }

  function normalizeErpItem(item) {
    const ops = Array.isArray(item.op_cards) ? item.op_cards : (Array.isArray(item.ops) ? item.ops : []);
    return {
      ps_id: item.ps_id || '',
      display_ps_id: item.display_ps_id || String(item.ps_id || '').split('::')[0],
      source_ps_id: item.source_ps_id || item.ps_id || '',
      pp_partial_no: item.pp_partial_no || String(item.ps_id || '').split('::')[1] || '',
      inventory_code: item.inventory_code || item.part_no || '',
      part_name: item.part_name || item.part_no || '',
      part_no: item.part_no || item.inventory_code || '',
      part_desc: item.part_desc || '',
      due_date: item.due_date || '',
      order_date: item.order_date || '',
      total_qty: item.total_qty || item.partial_qty || 0,
      planned_qty: item.planned_qty || 0,
      finished_qty: item.finished_qty || 0,
      remaining_qty: item.remaining_qty || item.total_qty || item.partial_qty || 0,
      status: item.status || '',
      execution_status: item.execution_status || '',
      planner_status: item.planner_status || 'UNPLANNED',
      selected_flow_code: item.selected_flow_code || item.selected_bom_code || item.bom_code || '',
      route_label: item.route_label || item.selected_flow_code || item.selected_bom_code || item.bom_code || 'No flow selected',
      material_status: item.material_status || { severity: 'none', label: '' },
      warnings: item.warnings || [],
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
      const plannerIds = new Set(plannerItems.map(item => String(item.ps_id || '')));
      const erpItems = erpResult.status === 'fulfilled' && Array.isArray(erpResult.value)
        ? erpResult.value.map(normalizeErpItem).filter(item => item.ps_id && !plannerIds.has(String(item.ps_id)))
        : [];

      state.items = [...plannerItems, ...erpItems].sort((a, b) => {
        const due = String(a.due_date || '').localeCompare(String(b.due_date || ''));
        return due || String(a.ps_id || '').localeCompare(String(b.ps_id || ''));
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

  function filteredItems() {
    const search = String(els.search?.value || '').trim().toLowerCase();
    const status = normalizeStatus(els.statusFilter?.value || '');
    const planner = normalizeStatus(els.plannerFilter?.value || '');
    const material = String(els.materialFilter?.value || '').trim();
    const overdueOnly = Boolean(els.overdueOnly?.checked);
    const showCompleted = Boolean(els.showCompleted?.checked);

    return state.items.filter(item => {
      if (search && !itemSearchText(item).includes(search)) return false;
      if (status && normalizeStatus(item.status) !== status) return false;
      if (planner && normalizeStatus(item.planner_status) !== planner) return false;
      if (material === 'shortage' && !isMaterialShortage(item)) return false;
      if (overdueOnly && !isOverdue(item)) return false;
      if (!showCompleted && isCompleted(item)) return false;
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
      UNPLANNED: 0,
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

    setText('ps-count-unplanned', counts.UNPLANNED);
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
      els.queue.innerHTML = `<div class="queue-empty">${state.loading ? 'Loading process sheets...' : 'No process sheets found.'}</div>`;
      if (els.queueHint) els.queueHint.textContent = `${state.items.length} loaded`;
      return;
    }

    if (els.queueHint) {
      const erpOnly = items.filter(item => item.source === 'erp').length;
      els.queueHint.textContent = `${items.length} shown from ${state.items.length} loaded${erpOnly ? ` (${erpOnly} ERP-only)` : ''}`;
    }

    els.queue.innerHTML = items.map(renderQueueItem).join('');
  }

  function renderQueueItem(item) {
    const psId = item.ps_id || item.display_ps_id || '';
    const warnings = Array.isArray(item.warnings) ? item.warnings : [];
    const ops = Array.isArray(item.ops) ? item.ops : [];
    const badgeClass = `ps-badge--${normalizeStatus(item.planner_status || 'UNPLANNED').toLowerCase().replace(/_/g, '-')}`;
    const material = item.material_status?.label || (isMaterialShortage(item) ? 'Material risk' : 'Material OK');
    const dueClass = isOverdue(item) ? 'is-overdue' : '';
    const partial = item.pp_partial_no ? `<span class="ps-row-muted">Partial ${escapeHtml(item.pp_partial_no)}</span>` : '';
    const source = item.source === 'erp' ? '<span class="ps-source-badge">ERP</span>' : '';

    return `
      <article class="ps-row ${dueClass}" data-ps-id="${escapeHtml(psId)}">
        <button class="ps-row-main" type="button" data-action="toggle-details" data-ps-id="${escapeHtml(psId)}">
          <div class="ps-row-title">
            <span class="ps-id">${escapeHtml(item.display_ps_id || psId)}</span>
            ${partial}
            ${source}
          </div>
          <div class="ps-row-part">
            <strong>${escapeHtml(item.part_no || item.part_name || item.inventory_code || 'No part')}</strong>
            <span>${escapeHtml(item.part_desc || 'No description')}</span>
          </div>
          <div class="ps-row-meta">
            <span>Due ${escapeHtml(fmtDate(item.due_date))}</span>
            <span>Qty ${escapeHtml(fmtQty(item.total_qty))}</span>
            <span>Route ${escapeHtml(item.route_label || item.selected_flow_code || item.selected_bom_code || 'No flow selected')}</span>
            <span>${escapeHtml(material)}</span>
            ${warnings.length ? `<span>${warnings.length} warning${warnings.length === 1 ? '' : 's'}</span>` : ''}
          </div>
        </button>
        <div class="ps-row-side">
          <span class="ps-badge ${badgeClass}">${escapeHtml(displayStatus(item.planner_status, 'Unplanned'))}</span>
          <span class="ps-row-muted">${escapeHtml(displayStatus(item.status, item.execution_status))}</span>
          <span class="ps-row-muted">${ops.length} op${ops.length === 1 ? '' : 's'}</span>
        </div>
        <div class="ps-details" id="ps-details-${escapeHtml(cssSafeId(psId))}" hidden></div>
      </article>
    `;
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

  function renderDetails(details, item) {
    const summary = details.summary || item;
    const ops = Array.isArray(summary.ops) && summary.ops.length ? summary.ops : (Array.isArray(item.ops) ? item.ops : []);
    const plannedBlocks = Array.isArray(details.planned_blocks) ? details.planned_blocks : [];
    const requirements = Array.isArray(details.requirements) ? details.requirements : [];

    return `
      <div class="ps-details-grid">
        <div class="ps-detail-card">
          <div class="ps-detail-label">Progress</div>
          <div class="ps-progress">
            <span>Planned ${escapeHtml(fmtQty(summary.planned_qty))}</span>
            <span>Finished ${escapeHtml(fmtQty(summary.finished_qty))}</span>
            <span>Remaining ${escapeHtml(fmtQty(summary.remaining_qty))}</span>
          </div>
        </div>
        <div class="ps-detail-card">
          <div class="ps-detail-label">Timing</div>
          <div class="ps-progress">
            <span>Start ${escapeHtml(summary.expected_start ? String(summary.expected_start).slice(0, 16) : '-')}</span>
            <span>End ${escapeHtml(summary.expected_end ? String(summary.expected_end).slice(0, 16) : '-')}</span>
          </div>
        </div>
      </div>
      ${details.erp_only ? '<div class="ps-details-note">This row is from the ERP catalog and has not been materialized in planner state yet.</div>' : ''}
      ${renderOps(ops)}
      ${renderBlocks(plannedBlocks)}
      ${renderRequirements(requirements)}
    `;
  }

  function renderOps(ops) {
    if (!ops.length) return '<div class="ps-details-empty">No operations found for this process sheet.</div>';
    return `
      <div class="ps-table-wrap">
        <table class="ps-table">
          <thead>
            <tr>
              <th>Op</th>
              <th>Type</th>
              <th>Machine</th>
              <th>Planned</th>
              <th>Finished</th>
              <th>Remaining</th>
            </tr>
          </thead>
          <tbody>
            ${ops.map(op => `
              <tr>
                <td>${escapeHtml(op.op_no || op.source_op_no || op.operation_label || '-')}</td>
                <td>${escapeHtml(op.op_type || op.operation_name || '-')}</td>
                <td>${escapeHtml(op.preferred_machine || op.machine_code || op.compatible_machine_group || '-')}</td>
                <td>${escapeHtml(fmtQty(op.planned_qty))}</td>
                <td>${escapeHtml(fmtQty(op.finished_qty))}</td>
                <td>${escapeHtml(fmtQty(op.remaining_qty || op.target_qty || op.total_qty))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
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
    if (els.syncBtn) els.syncBtn.disabled = busy;
    if (els.queueHint && hint) els.queueHint.textContent = hint;
  }

  async function syncErp() {
    if (!els.syncBtn) return;
    const original = els.syncBtn.textContent;
    els.syncBtn.textContent = 'Syncing...';
    setBusy(true, 'Syncing ERP staging tables...');
    try {
      await postJson('/api/pp-staging/sync', {});
      state.details.clear();
      await loadProcessSheets();
      els.syncBtn.textContent = 'Synced';
      window.setTimeout(() => { els.syncBtn.textContent = original; }, 1500);
    } catch (err) {
      console.error('ERP sync failed:', err);
      renderError(err.message || 'ERP sync failed.');
      els.syncBtn.textContent = 'Sync failed';
      window.setTimeout(() => { els.syncBtn.textContent = original; }, 2500);
    } finally {
      setBusy(false);
    }
  }

  function bind() {
    els.queue = $('ps-queue');
    els.queueHint = $('ps-queue-hint');
    els.search = $('ps-search');
    els.statusFilter = $('ps-status-filter');
    els.plannerFilter = $('ps-planner-filter');
    els.materialFilter = $('ps-material-filter');
    els.overdueOnly = $('ps-overdue-only');
    els.showCompleted = $('ps-show-completed');
    els.refreshBtn = $('ps-refresh-btn');
    els.syncBtn = $('ps-sync-btn');

    [els.search, els.statusFilter, els.plannerFilter, els.materialFilter, els.overdueOnly, els.showCompleted]
      .filter(Boolean)
      .forEach(el => el.addEventListener('input', render));

    els.refreshBtn?.addEventListener('click', () => {
      state.details.clear();
      loadProcessSheets();
    });
    els.syncBtn?.addEventListener('click', syncErp);
    els.queue?.addEventListener('click', event => {
      const trigger = event.target.closest('[data-action="toggle-details"]');
      if (trigger) toggleDetails(trigger.dataset.psId || '');
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    loadProcessSheets();
  });
})();
