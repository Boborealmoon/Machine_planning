// Actual production entry — daily rows, schedule tail reflection, combined-run segment actuals.

async function saveSegmentActual(segmentId, patch, options = {}) {
  if (!segmentId) throw new Error('Planned segment is missing. Refresh the page and try again.');
  const data = await POST(`/api/trial/segments/${segmentId}/actual`, patch);
  if (!options.silent && data.message) toast(data.message, 'success');
  if (options.reload !== false) {
    const _seg = (trialState.segments || []).find(s => String(s.segment_id) === String(segmentId));
    const _segBlock = _seg ? (trialState.blocks || []).find(b => String(b.block_id) === String(_seg.block_id)) : null;
    await refreshMachines([Number(_segBlock?.machine_id || 0)].filter(Boolean));
  }
  return data;
}

function trialActualAutosaveEnabled() {
  return false;
}

function trialActualExplicitSaveEnabled() {
  return Boolean(window.ACTUAL_PRODUCTION_PAGE);
}

function trialActualRecordOnlyEnabled() {
  return Boolean(window.ACTUAL_PRODUCTION_PAGE);
}

function trialActualApiPayloadExtras() {
  return trialActualRecordOnlyEnabled() ? { record_only: true } : {};
}

function trialCanDeleteActualDailyDate(row) {
  return !Boolean(row?.is_planned_row);
}

function trialActualDailyDeleteButtonHtml(blockId, rowSelector, { explicitSave = false, isPlannedRow = false } = {}) {
  const plannedTitle = 'This date is from the schedule. Change it in the Planner.';
  if (isPlannedRow) {
    return `<button type="button" class="btn btn-ghost btn-xs is-locked-action" disabled title="${escapeHtml(plannedTitle)}">Delete Date</button>`;
  }
  if (explicitSave) {
    return `<button type="button" class="btn btn-ghost btn-xs" onmousedown="event.preventDefault()" onclick="trialDeleteActualDailyRow(${rowSelector}, ${Number(blockId) || 0})">Delete Date</button>`;
  }
  return `<button type="button" class="btn btn-ghost btn-xs" onclick="trialRemoveActualDailyRow(${rowSelector})">Delete Date</button>`;
}

function trialActualQtyDisplay(value) {
  if (value === null || value === undefined || value === '') return '';
  const num = Number(value);
  if (Number.isFinite(num) && Math.abs(num - Math.round(num)) < 1e-9) return String(Math.round(num));
  return String(value);
}

function trialDisplayQtyForDailyRow(row, field) {
  const displayKey = field === 'reject_qty' ? 'display_reject_qty' : 'display_output_qty';
  const displayValue = row?.[displayKey];
  if (displayValue !== undefined && displayValue !== null && displayValue !== '') {
    return trialActualQtyDisplay(displayValue);
  }
  const raw = row?.[field];
  if (raw === null || raw === undefined || raw === '') return '';
  return trialActualQtyDisplay(raw);
}

function trialActualEntryHost(blockId) {
  const numericId = Number(blockId || 0);
  if (numericId) {
    const pageHost = document.querySelector(`[data-actual-entry-host="${numericId}"]`);
    if (pageHost) return pageHost;
  }
  return document.querySelector('.trial-modal-body') || document.getElementById('trial-modal-shell');
}

function trialActualDailyRowRenderOptions(blockId, overrides = {}) {
  const shell = trialActualEntryHost(blockId);
  const showErpReconcile = Boolean(shell?.querySelector('.actual-production-daily-table table'));
  return {
    explicitSave: showErpReconcile || trialActualExplicitSaveEnabled(),
    showErpReconcile,
    ...overrides,
  };
}

function trialActualDailyGridElement(blockId) {
  const shell = trialActualEntryHost(blockId);
  if (!shell) return null;
  return shell.querySelector(`[data-trial-actual-daily-grid="${String(blockId)}"]`);
}

function trialUsesActualProductionTable(blockId) {
  return Boolean(trialActualEntryHost(blockId)?.querySelector('.actual-production-daily-table table'));
}

function trialRenderActualDailyRow(blockId, row, options = {}) {
  const opts = { ...trialActualDailyRowRenderOptions(blockId), ...options };
  if (opts.showErpReconcile) {
    return trialActualDailyRowTableHtml(blockId, row, opts);
  }
  return trialActualDailyRowHtml(blockId, row, opts);
}

function trialActualModalHost() {
  return trialActualEntryHost(trialActualDraft.blockId);
}

function trialAfterActualSaved(machineId, blockId) {
  if (typeof actualProductionRefreshBlock === 'function' && blockId) {
    actualProductionRefreshBlock(blockId);
    return Promise.resolve();
  }
  if (typeof renderActualProduction === 'function') {
    renderActualProduction();
    return Promise.resolve();
  }
  return refreshMachines([Number(machineId || 0)].filter(Boolean));
}

function trialActualRowFieldElement(rowEl, field) {
  return rowEl?.querySelector?.(`[data-trial-actual-field="${field}"]`) || null;
}

function trialActualRowFieldValue(rowEl, field) {
  const el = trialActualRowFieldElement(rowEl, field);
  return el ? String(el.value ?? '') : '';
}

function trialActualRowFieldLastSaved(rowEl, field) {
  const el = trialActualRowFieldElement(rowEl, field);
  return el ? String(el.dataset.lastSavedValue ?? '') : '';
}

function trialActualRowSetFieldLastSaved(rowEl, field, value) {
  const el = trialActualRowFieldElement(rowEl, field);
  if (!el) return;
  el.dataset.lastSavedValue = String(value ?? '');
}

function trialActualRowSetStatus(rowEl, text, tone = '') {
  const statusEl = rowEl?.querySelector?.('[data-trial-actual-row-status]');
  if (!statusEl) return;
  statusEl.textContent = text || '';
  statusEl.classList.remove('is-saving', 'is-saved', 'is-error');
  if (tone) statusEl.classList.add(tone);
}

function trialActualRowSetSaving(rowEl, saving) {
  if (!rowEl) return;
  rowEl.dataset.saving = saving ? '1' : '0';
  rowEl.querySelectorAll('input, textarea, button').forEach(node => {
    if (!(node instanceof HTMLElement)) return;
    node.disabled = Boolean(saving);
  });
  if (saving) trialActualRowSetStatus(rowEl, 'Saving...', 'is-saving');
}

function trialActualFieldFocus(rowEl, field) {
  const el = trialActualRowFieldElement(rowEl, field);
  if (!el) return;
  el.dataset.focusValue = String(el.value ?? '');
}

function trialActualFieldChanged(rowEl, field) {
  return trialActualRowFieldValue(rowEl, field) !== trialActualRowFieldLastSaved(rowEl, field);
}

function trialActualRowPayloadFromElement(rowEl) {
  return {
    report_date: String(rowEl?.querySelector?.('[data-trial-actual-field="report_date"]')?.value || rowEl?.dataset?.originalReportDate || rowEl?.dataset?.rowDate || '').trim(),
    target_qty: Number(rowEl?.dataset?.targetQty || 0),
    output_qty: trialActualRowFieldValue(rowEl, 'output_qty').trim(),
    reject_qty: trialActualRowFieldValue(rowEl, 'reject_qty').trim(),
    remarks: trialActualRowFieldValue(rowEl, 'remarks').trim(),
  };
}

function trialActualRowHasSaveableValues(rowEl) {
  const outputValue = trialActualRowFieldValue(rowEl, 'output_qty').trim();
  const rejectValue = trialActualRowFieldValue(rowEl, 'reject_qty').trim();
  const remarksValue = trialActualRowFieldValue(rowEl, 'remarks').trim();
  return outputValue !== '' || rejectValue !== '' || remarksValue !== '';
}

function trialPlannedTargetQtyForDate(blockId, reportDate) {
  const plannedRows = trialActualRowsForBlock(blockId).filter(row => String(row.report_date || '') === String(reportDate || ''));
  if (plannedRows.length) {
    return plannedRows.reduce((sum, row) => sum + Number(row.target_qty || 0), 0);
  }
  return trialSegmentsForBlock(blockId)
    .filter(seg => String(seg.segment_type || '') === 'production' && String(seg.segment_date || '') === String(reportDate || ''))
    .reduce((sum, seg) => sum + Number(seg.qty_done || seg.planned_qty || 0), 0);
}

function trialActualDailyRowsForBlock(block) {
  let rows = Array.isArray(block?.actual_daily_rows) ? block.actual_daily_rows : [];
  if (!rows.length && block?.block_id) {
    rows = trialActualRowsForBlock(block.block_id).map(row => ({
      report_date: row.report_date,
      original_report_date: row.actual_only ? row.report_date : '',
      target_qty: Number(row.target_qty || 0),
      output_qty: row.actual?.output_qty ?? '',
      reject_qty: row.actual?.reject_qty ?? '',
      remarks: row.actual?.remarks ?? '',
      is_planned_row: !row.actual_only,
      is_existing_actual: Boolean(row.actual),
      locked_date: true,
    }));
  }
  return rows.map(row => ({
    report_date: String(row.report_date || '').trim(),
    original_report_date: String(row.original_report_date || row.report_date || '').trim(),
    target_qty: Number(row.target_qty || 0),
    output_qty: row.output_qty === null || row.output_qty === undefined ? '' : trialActualQtyDisplay(row.output_qty),
    reject_qty: row.reject_qty === null || row.reject_qty === undefined ? '' : trialActualQtyDisplay(row.reject_qty),
    remarks: String(row.remarks || ''),
    is_planned_row: Boolean(row.is_planned_row),
    is_existing_actual: Boolean(row.is_existing_actual),
    locked_date: row.locked_date !== false,
    erp_daily_qty: row.erp_daily_qty,
    erp_daily_reject: row.erp_daily_reject,
    erp_acc_qty: row.erp_acc_qty,
    erp_snapshot_at: String(row.erp_snapshot_at || ''),
    shop_good_qty: row.shop_good_qty,
    shop_output_qty: row.shop_output_qty,
    shop_reject_qty: row.shop_reject_qty,
    display_output_qty: row.display_output_qty,
    display_reject_qty: row.display_reject_qty,
    display_good_qty: row.display_good_qty,
    output_source: row.output_source,
    reject_source: row.reject_source,
    good_source: row.good_source,
    reconcile_status: String(row.reconcile_status || ''),
  }));
}

function trialResetActualDraft(blockId, block) {
  trialActualDraft = {
    blockId: Number(blockId || 0) || null,
    rows: {},
    deletedDates: new Set(),
    removedTargetDates: new Set(),
  };
  trialActualDailyRowsForBlock(block).forEach(row => {
    trialActualDraft.rows[String(row.report_date || '')] = {
      ...row,
      is_new_row: !row.is_existing_actual && !row.is_planned_row,
    };
  });
}

function trialRenderActualDailyRows(blockId, rows) {
  const grid = trialActualDailyGridElement(blockId);
  if (!grid) return;
  const dailyRows = Array.isArray(rows) ? rows : [];
  const emptyMsg = 'No scheduled target rows. Recalculate schedule or add a date manually.';
  const emptyHtml = trialUsesActualProductionTable(blockId)
    ? `<tr><td colspan="8" class="trial-catalog-empty">${emptyMsg}</td></tr>`
    : `<div class="trial-catalog-empty">${emptyMsg}</div>`;
  grid.innerHTML = dailyRows.length
    ? dailyRows.map(row => trialRenderActualDailyRow(blockId, row)).join('')
    : emptyHtml;
}

function trialActualDailyRowHtml(blockId, row, options = {}) {
  const reportDate = String(row?.report_date || trialTodayISO()).trim();
  const originalReportDate = String(row?.original_report_date || row?.report_date || '').trim();
  const targetQty = Number(row?.target_qty || 0);
  const outputValue = trialDisplayQtyForDailyRow(row, 'output_qty');
  const rejectValue = trialDisplayQtyForDailyRow(row, 'reject_qty');
  const qtySourceHint = [row?.output_source, row?.reject_source].filter(source => source && source !== 'none').join(' / ');
  const remarksValue = String(row?.remarks || '');
  const isPlannedRow = Boolean(row?.is_planned_row);
  const isExistingActual = Boolean(row?.is_existing_actual);
  const lockedDate = row?.locked_date !== false;
  const isRemoved = Boolean(options.removed);
  const canRemove = options.canRemove !== false;
  const explicitSave = Boolean(options.explicitSave || trialActualExplicitSaveEnabled());
  const autosave = Boolean(options.autosave && !explicitSave && trialActualAutosaveEnabled());
  const rowSelector = 'this.closest(\'.trial-actual-daily-row\')';
  const draftFieldHandlers = (field, value) => (
    explicitSave
      ? `data-last-saved-value="${escapeHtml(value)}" oninput="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, ${rowSelector})" onkeydown="trialActualInputKeydown(event, ${Number(blockId) || 0}, ${rowSelector}, '${field}')"`
      : `oninput="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, ${rowSelector})" onchange="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, ${rowSelector})" onblur="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, ${rowSelector})" onkeydown="trialActualInputKeydown(event, ${Number(blockId) || 0})"`
  );
  const outputHandlers = autosave
    ? `data-last-saved-value="${escapeHtml(outputValue)}" onfocus="trialActualFieldFocus(${rowSelector}, 'output_qty')" onblur="trialActualFieldBlur(event, ${Number(blockId) || 0}, ${rowSelector}, 'output_qty')" onkeydown="trialActualInputKeydown(event, ${Number(blockId) || 0}, ${rowSelector}, 'output_qty')"`
    : draftFieldHandlers('output_qty', outputValue);
  const rejectHandlers = autosave
    ? `data-last-saved-value="${escapeHtml(rejectValue)}" onfocus="trialActualFieldFocus(${rowSelector}, 'reject_qty')" onblur="trialActualFieldBlur(event, ${Number(blockId) || 0}, ${rowSelector}, 'reject_qty')" onkeydown="trialActualInputKeydown(event, ${Number(blockId) || 0}, ${rowSelector}, 'reject_qty')"`
    : draftFieldHandlers('reject_qty', rejectValue);
  const remarksHandlers = autosave
    ? `data-last-saved-value="${escapeHtml(remarksValue)}" onfocus="trialActualFieldFocus(${rowSelector}, 'remarks')" onblur="trialActualFieldBlur(event, ${Number(blockId) || 0}, ${rowSelector}, 'remarks')" onkeydown="trialActualInputKeydown(event, ${Number(blockId) || 0}, ${rowSelector}, 'remarks')"`
    : draftFieldHandlers('remarks', remarksValue);
  const deleteButton = canRemove
    ? trialActualDailyDeleteButtonHtml(blockId, rowSelector, { explicitSave, isPlannedRow })
    : '';
  const explicitActions = explicitSave ? `
        <div class="trial-actual-row-action-buttons">
          <button type="button" class="btn btn-primary btn-xs" onmousedown="event.preventDefault()" onclick="trialSaveActualDailyRowExplicit(${Number(blockId) || 0}, ${rowSelector})">Save</button>
          <button type="button" class="btn btn-ghost btn-xs" onmousedown="event.preventDefault()" onclick="trialCancelActualDailyRowEdit(${rowSelector})">Cancel</button>
          ${deleteButton}
        </div>
  ` : deleteButton;
  const showErpReconcile = Boolean(options.showErpReconcile);
  const erpDailyQty = row?.erp_daily_qty;
  const erpDailyDisplay = erpDailyQty === null || erpDailyQty === undefined ? '—' : fmt(erpDailyQty, 0);
  const reconcileStatus = String(row?.reconcile_status || '').toLowerCase();
  const reconcileLabels = {
    match: 'Match',
    shop_only: 'Shop only',
    erp_only: 'ERP only',
    shop_ahead: 'Shop ahead',
    erp_ahead: 'ERP ahead',
    no_data: 'No ERP data',
  };
  const reconcileLabel = reconcileLabels[reconcileStatus] || '';
  const reconcileClass = reconcileStatus === 'match'
    ? 'is-match'
    : (reconcileStatus === 'shop_only' || reconcileStatus === 'shop_ahead')
      ? 'is-shop'
      : (reconcileStatus === 'erp_only' || reconcileStatus === 'erp_ahead')
        ? 'is-erp'
        : 'is-muted';
  const erpColumnsHtml = showErpReconcile ? `
      <div class="trial-actual-cell actual-production-erp-daily">
        <span>ERP today</span>
        <strong>${escapeHtml(String(erpDailyDisplay))}</strong>
      </div>
      <div class="actual-production-reconcile-cell">
        ${reconcileLabel
          ? `<span class="actual-production-reconcile-pill ${reconcileClass}">${escapeHtml(reconcileLabel)}</span>`
          : '<span class="actual-production-reconcile-pill is-muted">—</span>'}
      </div>
  ` : '';
  const rowClassNames = [
    'trial-actual-row',
    'trial-actual-daily-row',
    explicitSave ? 'is-explicit-save' : '',
    showErpReconcile ? 'has-erp-columns' : '',
    isPlannedRow ? '' : 'is-actual-only-row',
  ].filter(Boolean).join(' ');
  return `
    <div
      class="${rowClassNames}"
      data-trial-actual-row="1"
      data-row-date="${escapeHtml(reportDate)}"
      data-original-report-date="${escapeHtml(originalReportDate)}"
      data-is-planned-row="${isPlannedRow ? '1' : '0'}"
      data-is-existing-actual="${isExistingActual ? '1' : '0'}"
      data-locked-date="${lockedDate ? '1' : '0'}"
      data-target-qty="${escapeHtml(String(targetQty))}"
      data-removed="${isRemoved ? '1' : '0'}"
      style="${isRemoved ? 'display:none;' : ''}"
    >
      <label class="trial-actual-cell">
        <span>Date</span>
        <span class="trial-actual-date-text">${escapeHtml(reportDate)}</span>
        <input data-trial-actual-field="report_date" type="hidden" value="${escapeHtml(reportDate)}">
      </label>
      <div class="trial-actual-target">Target ${fmt(targetQty, 0)}</div>
      <label class="trial-actual-cell">
        <span>Output Qty</span>
        <input data-trial-actual-field="output_qty" type="number" min="0" step="1" value="${escapeHtml(outputValue)}" ${outputHandlers}>
      </label>
      <label class="trial-actual-cell">
        <span>Reject Qty</span>
        <input data-trial-actual-field="reject_qty" type="number" min="0" step="1" value="${escapeHtml(rejectValue)}" ${rejectHandlers}>
      </label>
      <label class="trial-actual-cell">
        <span>Remarks</span>
        <textarea data-trial-actual-field="remarks" rows="1" ${remarksHandlers}>${escapeHtml(remarksValue)}</textarea>
      </label>
      ${erpColumnsHtml}
      <div class="trial-actual-delete-cell${explicitSave ? ' trial-actual-row-actions' : ''}">
        ${explicitSave || autosave ? `<div class="trial-actual-row-status" data-trial-actual-row-status></div>` : ''}
        ${explicitSave ? explicitActions : deleteButton}
      </div>
    </div>
  `;
}

function trialActualDailyRowTableHtml(blockId, row, options = {}) {
  const reportDate = String(row?.report_date || trialTodayISO()).trim();
  const originalReportDate = String(row?.original_report_date || row?.report_date || '').trim();
  const targetQty = Number(row?.target_qty || 0);
  const outputValue = trialDisplayQtyForDailyRow(row, 'output_qty');
  const rejectValue = trialDisplayQtyForDailyRow(row, 'reject_qty');
  const qtySourceTitle = [row?.output_source, row?.reject_source]
    .filter(source => source && source !== 'none')
    .map(source => (source === 'erp' ? 'ERP' : source === 'shop' ? 'Shop' : 'Match'))
    .join(' · ');
  const qtySourceAttr = qtySourceTitle
    ? ` title="Showing ${escapeHtml(qtySourceTitle)} (ERP first; shop wins if higher)"`
    : '';
  const remarksValue = String(row?.remarks || '');
  const isPlannedRow = Boolean(row?.is_planned_row);
  const isExistingActual = Boolean(row?.is_existing_actual);
  const lockedDate = row?.locked_date !== false;
  const isRemoved = Boolean(options.removed);
  const explicitSave = Boolean(options.explicitSave || trialActualExplicitSaveEnabled());
  const rowSelector = 'this.closest(\'.trial-actual-daily-row\')';
  const draftFieldHandlers = (field, value) => (
    `data-last-saved-value="${escapeHtml(value)}" oninput="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, ${rowSelector})" onkeydown="trialActualInputKeydown(event, ${Number(blockId) || 0}, ${rowSelector}, '${field}')"`
  );
  const outputHandlers = draftFieldHandlers('output_qty', outputValue);
  const rejectHandlers = draftFieldHandlers('reject_qty', rejectValue);
  const remarksHandlers = draftFieldHandlers('remarks', remarksValue);
  const deleteButton = trialActualDailyDeleteButtonHtml(blockId, rowSelector, { explicitSave: true, isPlannedRow });
  const erpDailyQty = row?.erp_daily_qty;
  const erpDailyDisplay = erpDailyQty === null || erpDailyQty === undefined ? '—' : fmt(erpDailyQty, 0);
  const reconcileStatus = String(row?.reconcile_status || '').toLowerCase();
  const reconcileLabels = {
    match: 'Match',
    shop_only: 'Shop only',
    erp_only: 'ERP only',
    shop_ahead: 'Shop ahead',
    erp_ahead: 'ERP ahead',
    no_data: 'No ERP data',
  };
  const reconcileLabel = reconcileLabels[reconcileStatus] || '';
  const reconcileClass = reconcileStatus === 'match'
    ? 'is-match'
    : (reconcileStatus === 'shop_only' || reconcileStatus === 'shop_ahead')
      ? 'is-shop'
      : (reconcileStatus === 'erp_only' || reconcileStatus === 'erp_ahead')
        ? 'is-erp'
        : 'is-muted';
  const rowClassNames = [
    'trial-actual-daily-row',
    'is-explicit-save',
    isPlannedRow ? '' : 'is-actual-only-row',
  ].filter(Boolean).join(' ');
  return `
    <tr
      class="${rowClassNames}"
      data-trial-actual-row="1"
      data-row-date="${escapeHtml(reportDate)}"
      data-original-report-date="${escapeHtml(originalReportDate)}"
      data-is-planned-row="${isPlannedRow ? '1' : '0'}"
      data-is-existing-actual="${isExistingActual ? '1' : '0'}"
      data-locked-date="${lockedDate ? '1' : '0'}"
      data-target-qty="${escapeHtml(String(targetQty))}"
      data-removed="${isRemoved ? '1' : '0'}"
      ${isRemoved ? 'hidden' : ''}
    >
      <td class="ap-daily-date">
        <span class="trial-actual-date-text">${escapeHtml(reportDate)}</span>
        <input data-trial-actual-field="report_date" type="hidden" value="${escapeHtml(reportDate)}">
      </td>
      <td class="ap-daily-target">${fmt(targetQty, 0)}</td>
      <td class="ap-daily-input">
        <input data-trial-actual-field="output_qty" type="number" min="0" step="1" value="${escapeHtml(outputValue)}"${qtySourceAttr} ${outputHandlers}>
      </td>
      <td class="ap-daily-input">
        <input data-trial-actual-field="reject_qty" type="number" min="0" step="1" value="${escapeHtml(rejectValue)}"${qtySourceAttr} ${rejectHandlers}>
      </td>
      <td class="ap-daily-input ap-daily-remarks">
        <textarea data-trial-actual-field="remarks" rows="1" ${remarksHandlers}>${escapeHtml(remarksValue)}</textarea>
      </td>
      <td class="ap-daily-erp">${escapeHtml(String(erpDailyDisplay))}</td>
      <td class="ap-daily-status">
        ${reconcileLabel
          ? `<span class="actual-production-reconcile-pill ${reconcileClass}">${escapeHtml(reconcileLabel)}</span>`
          : '<span class="actual-production-reconcile-pill is-muted">—</span>'}
      </td>
      <td class="ap-daily-actions">
        <div class="trial-actual-row-status" data-trial-actual-row-status></div>
        <div class="trial-actual-row-action-buttons">
          <button type="button" class="btn btn-primary btn-xs" onmousedown="event.preventDefault()" onclick="trialSaveActualDailyRowExplicit(${Number(blockId) || 0}, ${rowSelector})">Save</button>
          <button type="button" class="btn btn-ghost btn-xs" onmousedown="event.preventDefault()" onclick="trialCancelActualDailyRowEdit(${rowSelector})">Cancel</button>
          ${deleteButton}
        </div>
      </td>
    </tr>
  `;
}

function trialRemoveActualDailyRow(rowEl) {
  if (!rowEl) return;
  if (String(rowEl.dataset.isPlannedRow || '0') === '1') {
    toast('Planned dates cannot be removed here. Use the Planner.', 'warning');
    return;
  }
  const reportDate = String(rowEl.querySelector('[data-trial-actual-field="report_date"]')?.value || rowEl.dataset.originalReportDate || rowEl.dataset.rowDate || '').trim();
  const hasSavedActual = String(rowEl.dataset.isExistingActual || '0') === '1';
  const hasPlannedRow = String(rowEl.dataset.isPlannedRow || '0') === '1';
  const targetQty = Number(rowEl.dataset.targetQty || 0);
  const shouldRemoveTarget = hasPlannedRow || targetQty > 0;
  if (hasSavedActual) {
    if (reportDate) {
      trialActualDraft.deletedDates.add(reportDate);
      if (shouldRemoveTarget) trialActualDraft.removedTargetDates.add(reportDate);
      if (trialActualDraft.rows[reportDate]) {
        trialActualDraft.rows[reportDate].removed = true;
      }
    }
    rowEl.dataset.removed = '1';
    rowEl.style.display = 'none';
    return;
  }
  if (hasPlannedRow) {
    if (reportDate && shouldRemoveTarget) {
      trialActualDraft.removedTargetDates.add(reportDate);
    }
    rowEl.dataset.removed = '1';
    rowEl.style.display = 'none';
    return;
  }
  if (reportDate && trialActualDraft.rows[reportDate]) {
    delete trialActualDraft.rows[reportDate];
  }
  rowEl.remove();
}

function trialAddActualDailyRow(blockId, reportDate = '') {
  const shell = trialActualEntryHost(blockId);
  if (!shell) return;
  const grid = shell.querySelector(`[data-trial-actual-daily-grid="${String(blockId)}"]`);
  if (!grid) return;
  let chosenDate = String(reportDate || '').trim() || trialTodayISO();
  let existing = Array.from(grid.querySelectorAll('.trial-actual-daily-row')).find(row => String(row.dataset.rowDate || '') === chosenDate);
  let guard = 0;
  while (existing && guard < 60) {
    chosenDate = trialAddDaysISO(chosenDate, 1);
    existing = Array.from(grid.querySelectorAll('.trial-actual-daily-row')).find(row => String(row.dataset.rowDate || '') === chosenDate);
    guard += 1;
  }
  if (existing) {
    existing.dataset.removed = '0';
    existing.style.display = '';
    trialActualDraft.deletedDates.delete(String(existing.dataset.rowDate || chosenDate));
    trialActualDraft.removedTargetDates.delete(String(existing.dataset.rowDate || chosenDate));
    existing.scrollIntoView({ block: 'center', behavior: 'smooth' });
    existing.querySelector('[data-trial-actual-field="output_qty"]')?.focus();
    return;
  }
  const targetQty = trialPlannedTargetQtyForDate(blockId, chosenDate);
  const row = {
    report_date: chosenDate,
    original_report_date: '',
    target_qty: targetQty,
    output_qty: '',
    reject_qty: '',
    remarks: '',
    is_planned_row: false,
    is_existing_actual: false,
    locked_date: true,
    is_new_row: true,
  };
  trialActualDraft.rows[chosenDate] = row;
  grid.insertAdjacentHTML('beforeend', trialRenderActualDailyRow(blockId, row));
  const added = Array.from(grid.querySelectorAll('.trial-actual-daily-row')).find(row => String(row.dataset.rowDate || '') === chosenDate && String(row.dataset.removed || '0') !== '1');
  added?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  added?.querySelector('[data-trial-actual-field="output_qty"]')?.focus();
}

function trialSyncActualDailyRowDraft(blockId, rowEl) {
  if (!rowEl) return;
  const reportDate = String(rowEl.querySelector('[data-trial-actual-field="report_date"]')?.value || rowEl.dataset.originalReportDate || rowEl.dataset.rowDate || '').trim();
  if (!reportDate) return;
  trialActualDraft.rows[reportDate] = {
    report_date: reportDate,
    original_report_date: String(rowEl.dataset.originalReportDate || reportDate || '').trim(),
    target_qty: Number(rowEl.dataset.targetQty || 0),
    output_qty: String(rowEl.querySelector('[data-trial-actual-field="output_qty"]')?.value ?? '').trim(),
    reject_qty: String(rowEl.querySelector('[data-trial-actual-field="reject_qty"]')?.value ?? '').trim(),
    remarks: String(rowEl.querySelector('[data-trial-actual-field="remarks"]')?.value ?? '').trim(),
    removed: String(rowEl.dataset.removed || '0') === '1',
    is_existing_actual: String(rowEl.dataset.isExistingActual || '0') === '1',
  };
}

function trialSnapshotActualDailyRows(blockId) {
  const shell = trialActualEntryHost(blockId);
  const grid = shell ? shell.querySelector(`[data-trial-actual-daily-grid="${String(blockId)}"]`) : null;
  if (!grid) return [];
  const nextRows = {};
  const nextDeleteDates = new Set(trialActualDraft.deletedDates || []);
  const nextRemovedTargetDates = new Set(trialActualDraft.removedTargetDates || []);
  Array.from(grid.querySelectorAll('.trial-actual-daily-row')).forEach(rowEl => {
    const removed = String(rowEl.dataset.removed || '0') === '1';
    const reportDate = String(rowEl.querySelector('[data-trial-actual-field="report_date"]')?.value || rowEl.dataset.originalReportDate || rowEl.dataset.rowDate || '').trim();
    if (!reportDate) return;
    const originalReportDate = String(rowEl.dataset.originalReportDate || '').trim();
    const targetValue = String(rowEl.dataset.targetQty || '0').trim();
    const outputValue = String(rowEl.querySelector('[data-trial-actual-field="output_qty"]')?.value ?? '').trim();
    const rejectValue = String(rowEl.querySelector('[data-trial-actual-field="reject_qty"]')?.value ?? '').trim();
    const remarksValue = String(rowEl.querySelector('[data-trial-actual-field="remarks"]')?.value ?? '').trim();
    const isExistingActual = String(rowEl.dataset.isExistingActual || '0') === '1';
    const isPlannedRow = String(rowEl.dataset.isPlannedRow || '0') === '1';
    nextRows[reportDate] = {
      report_date: reportDate,
      original_report_date: originalReportDate || reportDate,
      target_qty: Number(targetValue || 0),
      output_qty: outputValue,
      reject_qty: rejectValue,
      remarks: remarksValue,
      removed,
      is_existing_actual: isExistingActual,
      is_planned_row: isPlannedRow,
      locked_date: String(rowEl.dataset.lockedDate || '1') !== '0',
      is_new_row: !isExistingActual && !isPlannedRow,
    };
    if (removed) {
      if (isExistingActual) nextDeleteDates.add(originalReportDate || reportDate);
      if ((isExistingActual || isPlannedRow || Number(targetValue || 0) > 0) && reportDate) nextRemovedTargetDates.add(reportDate);
      return;
    }
    if (isExistingActual && originalReportDate && reportDate !== originalReportDate) {
      nextDeleteDates.add(originalReportDate);
    }
  });
  trialActualDraft.rows = nextRows;
  trialActualDraft.deletedDates = nextDeleteDates;
  trialActualDraft.removedTargetDates = nextRemovedTargetDates;
  return Object.values(nextRows);
}

function trialCollectActualDailyRows(blockId) {
  const shell = trialActualEntryHost(blockId);
  const grid = shell ? shell.querySelector(`[data-trial-actual-daily-grid="${String(blockId)}"]`) : null;
  if (!grid) return { daily_actuals: [], delete_actual_dates: [], removed_target_dates: [] };
  const dailyActuals = [];
  const deleteDates = new Set(trialActualDraft.deletedDates || []);
  const removedTargetDates = new Set(trialActualDraft.removedTargetDates || []);
  const snapshotRows = trialSnapshotActualDailyRows(blockId);
  snapshotRows.forEach(rowState => {
    const reportDate = String(rowState.report_date || '').trim();
    if (!reportDate || rowState.removed) return;
    const nextOutputValue = String(rowState.output_qty ?? '').trim();
    const nextRejectValue = String(rowState.reject_qty ?? '').trim();
    const nextRemarksValue = String(rowState.remarks ?? '').trim();
    if (nextOutputValue === '' && nextRejectValue === '' && nextRemarksValue === '') return;
    dailyActuals.push({
      report_date: reportDate,
      target_qty: Number(rowState.target_qty || 0),
      output_qty: nextOutputValue,
      reject_qty: nextRejectValue,
      remarks: nextRemarksValue,
    });
  });
  if (dailyActuals.length === 0 && deleteDates.size === 0 && removedTargetDates.size === 0) {
    return { daily_actuals: [], delete_actual_dates: [], removed_target_dates: [] };
  }
  return {
    daily_actuals: dailyActuals,
    delete_actual_dates: Array.from(deleteDates),
    removed_target_dates: Array.from(removedTargetDates),
  };
}

function trialActualInputKeydown(event, blockId, rowEl, field) {
  if (!event || event.key !== 'Enter') return;
  const isTextarea = String(event.target?.tagName || '').toLowerCase() === 'textarea';
  if (isTextarea && !event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  if (trialActualExplicitSaveEnabled() && rowEl) {
    trialSaveActualDailyRowExplicit(blockId, rowEl);
    return;
  }
  if (trialActualAutosaveEnabled() && rowEl) {
    if (isTextarea && (event.ctrlKey || event.metaKey)) {
      trialAutosaveActualRow(blockId, rowEl, 'ctrl-enter');
      return;
    }
    trialAutosaveActualRow(blockId, rowEl, 'enter');
    return;
  }
  trialSaveActualDailyRows(blockId);
}

function trialActualFieldBlur(event, blockId, rowEl, field) {
  if (!trialActualAutosaveEnabled() || !rowEl || String(rowEl.dataset.saving || '0') === '1') return;
  const current = trialActualRowFieldValue(rowEl, field);
  const previous = trialActualRowFieldLastSaved(rowEl, field);
  if (current === previous) return;
  trialAutosaveActualRow(blockId, rowEl, 'blur');
}

function trialCancelActualDailyRowEdit(rowEl) {
  if (!rowEl) return;
  ['output_qty', 'reject_qty', 'remarks'].forEach(fieldName => {
    const el = trialActualRowFieldElement(rowEl, fieldName);
    if (el) el.value = trialActualRowFieldLastSaved(rowEl, fieldName);
  });
  trialActualRowSetStatus(rowEl, '', '');
}

async function trialSaveActualDailyRowExplicit(blockId, rowEl) {
  return trialPersistActualDailyRow(blockId, rowEl);
}

async function trialPersistActualDailyRow(blockId, rowEl, options = {}) {
  if (!rowEl) return { ok: true, skipped: true };
  if (String(rowEl.dataset.saving || '0') === '1') return { ok: true, skipped: true };
  const reportDate = String(rowEl.querySelector('[data-trial-actual-field="report_date"]')?.value || rowEl.dataset.originalReportDate || rowEl.dataset.rowDate || '').trim();
  if (!reportDate) return { ok: true, skipped: true };

  trialSyncActualDailyRowDraft(blockId, rowEl);
  if (!trialActualRowHasSaveableValues(rowEl)) {
    toast('Enter output, reject, or remarks before saving.', 'warning');
    return { ok: true, skipped: true };
  }

  const rowValues = trialActualRowPayloadFromElement(rowEl);
  const payload = {
    ...trialActualApiPayloadExtras(),
    daily_actuals: [{
      report_date: reportDate,
      target_qty: rowValues.target_qty,
      output_qty: rowValues.output_qty,
      reject_qty: rowValues.reject_qty,
      remarks: rowValues.remarks,
    }],
  };
  const block = trialState.blocks.find(item => String(item.block_id) === String(blockId));
  const machineId = Number(block?.machine_id || 0);
  trialActualRowSetSaving(rowEl, true);
  try {
    const data = await POST(`/api/trial/blocks/${blockId}/actual`, payload);
    if (data && data.block) {
      trialState.blocks = (trialState.blocks || []).map(item => (
        String(item.block_id) === String(blockId) ? { ...item, ...data.block } : item
      ));
    }
    if (Array.isArray(data?.actuals)) {
      trialState.actuals = [
        ...(trialState.actuals || []).filter(row => String(row.block_id) !== String(blockId)),
        ...data.actuals,
      ];
    }
    if (Number(data?.changed_count || 0) <= 0) {
      toast('No actual rows were saved.', 'warning');
      return data;
    }
    trialResetActualDraft(blockId, data.block || block || null);
    if (!trialActualExplicitSaveEnabled()) {
      trialRenderActualDailyRows(blockId, data.actual_daily_rows || (data.block && data.block.actual_daily_rows) || []);
    }
    if (options.toastOnSuccess !== false) {
      toast(data?.schedule_adjusted ? 'Actual saved — schedule adjusted' : 'Actual saved', 'success');
    }
    await trialAfterActualSaved(machineId, blockId);
    return data;
  } catch (err) {
    if (rowEl.isConnected) trialActualRowSetStatus(rowEl, 'Error', 'is-error');
    toast('Actual save failed: ' + err.message, 'error');
    throw err;
  } finally {
    if (rowEl.isConnected) trialActualRowSetSaving(rowEl, false);
  }
}

async function trialAutosaveActualRow(blockId, rowEl, reason) {
  if (!rowEl) return { ok: true, skipped: true };
  if (String(rowEl.dataset.saving || '0') === '1') return { ok: true, skipped: true };
  trialSyncActualDailyRowDraft(blockId, rowEl);
  if (
    reason !== 'delete'
    && !trialActualFieldChanged(rowEl, 'output_qty')
    && !trialActualFieldChanged(rowEl, 'reject_qty')
    && !trialActualFieldChanged(rowEl, 'remarks')
  ) {
    return { ok: true, skipped: true };
  }
  if (!trialActualRowHasSaveableValues(rowEl)) {
    return { ok: true, skipped: true };
  }
  return trialPersistActualDailyRow(blockId, rowEl, { toastOnSuccess: false });
}

async function trialDeleteActualDailyRow(rowEl, blockId) {
  if (!rowEl) return { ok: true, skipped: true };
  const reportDate = String(rowEl.querySelector('[data-trial-actual-field="report_date"]')?.value || rowEl.dataset.originalReportDate || rowEl.dataset.rowDate || '').trim();
  if (!reportDate) return { ok: true, skipped: true };
  const hasSavedActual = String(rowEl.dataset.isExistingActual || '0') === '1';
  const hasPlannedRow = String(rowEl.dataset.isPlannedRow || '0') === '1';
  if (hasPlannedRow) {
    toast('Planned dates cannot be removed here. Use the Planner.', 'warning');
    return { ok: true, skipped: true };
  }
  const targetQty = Number(rowEl.dataset.targetQty || 0);
  const payload = { ...trialActualApiPayloadExtras() };
  if (hasSavedActual) payload.delete_actual_dates = [reportDate];
  if (hasPlannedRow || targetQty > 0) {
    payload.removed_target_dates = [reportDate];
  }
  if (!payload.delete_actual_dates && !payload.removed_target_dates) {
    trialRemoveActualDailyRow(rowEl);
    return { ok: true, skipped: true };
  }
  const block = trialState.blocks.find(item => String(item.block_id) === String(blockId));
  const machineId = Number(block?.machine_id || 0);
  trialActualRowSetSaving(rowEl, true);
  try {
    const data = await POST(`/api/trial/blocks/${blockId}/actual`, payload);
    if (data && data.block) {
      trialState.blocks = (trialState.blocks || []).map(item => (
        String(item.block_id) === String(blockId) ? { ...item, ...data.block } : item
      ));
    }
    if (Array.isArray(data?.actuals)) {
      trialState.actuals = [
        ...(trialState.actuals || []).filter(row => String(row.block_id) !== String(blockId)),
        ...data.actuals,
      ];
    }
    trialResetActualDraft(blockId, data.block || block || null);
    if (!trialActualExplicitSaveEnabled()) {
      trialRenderActualDailyRows(blockId, data.actual_daily_rows || (data.block && data.block.actual_daily_rows) || []);
    }
    toast('Date removed', 'success');
    await trialAfterActualSaved(machineId, blockId);
    return data;
  } catch (err) {
    if (rowEl.isConnected) trialActualRowSetStatus(rowEl, 'Error', 'is-error');
    toast('Delete failed: ' + err.message, 'error');
    throw err;
  } finally {
    trialActualRowSetSaving(rowEl, false);
  }
}

async function trialSaveActualDailyRows(blockId) {
  if (trialActualSaving) return;
  trialActualSaving = true;
  const block = trialState.blocks.find(item => String(item.block_id) === String(blockId));
  const machineId = Number(block?.machine_id || 0);
  const payload = trialCollectActualDailyRows(blockId);
  if ((payload.daily_actuals || []).length === 0 && (payload.delete_actual_dates || []).length === 0 && (payload.removed_target_dates || []).length === 0) {
    toast('No actual rows to save.', 'warning');
    trialActualSaving = false;
    return;
  }
  const saveBtn = document.getElementById('trial-save-btn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }
  try {
    const data = await POST(`/api/trial/blocks/${blockId}/actual`, payload);
    if (data && data.block) {
      trialState.blocks = (trialState.blocks || []).map(item => String(item.block_id) === String(blockId) ? { ...item, ...data.block } : item);
    }
    const changedCount = Number(data?.changed_count || 0);
    if (changedCount <= 0) {
      toast('No actual rows were saved. Enter output, reject, or remarks before saving.', 'warning');
      if (data && (data.block || data.actual_daily_rows)) {
        trialResetActualDraft(blockId, data.block || block || null);
        trialRenderActualDailyRows(blockId, data.actual_daily_rows || (data.block && data.block.actual_daily_rows) || []);
      }
      return;
    }
    if (data && (data.block || data.actual_daily_rows)) {
      trialResetActualDraft(blockId, data.block || block || null);
      trialRenderActualDailyRows(blockId, data.actual_daily_rows || (data.block && data.block.actual_daily_rows) || []);
    }
    if (document.body.classList.contains('trial-modal-open')) {
      closeModal();
    }
    await trialAfterActualSaved(machineId, blockId);
    if (data?.schedule_adjusted) {
      toast('Actual saved — schedule adjusted', 'success');
    } else {
      toast('Actual saved', 'success');
    }
  } catch (e) {
    toast('Actual save failed: ' + e.message, 'error');
  } finally {
    trialActualSaving = false;
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Actuals';
    }
  }
}

async function trialEnsureBlockActualDetail(blockId) {
  const block = (trialState.blocks || []).find(item => String(item.block_id) === String(blockId));
  if (!block) return null;
  if (Array.isArray(block.actual_daily_rows) && block.actual_daily_rows.length) return block;
  const machineId = Number(block.machine_id || 0);
  if (!machineId) return block;
  const data = await GET(`/api/trial/schedule?machine_ids=${machineId}`);
  const refreshedBlocks = Array.isArray(data?.blocks) ? data.blocks : [];
  const refreshedActuals = Array.isArray(data?.actuals) ? data.actuals : [];
  const refreshedSegments = Array.isArray(data?.segments) ? data.segments : [];
  const refreshedBlock = refreshedBlocks.find(item => String(item.block_id) === String(blockId));
  if (refreshedBlock) {
    trialState.blocks = (trialState.blocks || []).map(item => (
      String(item.block_id) === String(blockId) ? { ...item, ...refreshedBlock } : item
    ));
  }
  if (refreshedActuals.length) {
    const blockIds = new Set(refreshedBlocks.map(item => String(item.block_id)));
    trialState.actuals = [
      ...(trialState.actuals || []).filter(row => !blockIds.has(String(row.block_id))),
      ...refreshedActuals,
    ];
  }
  if (refreshedSegments.length) {
    const blockIds = new Set(refreshedBlocks.map(item => String(item.block_id)));
    trialState.segments = [
      ...(trialState.segments || []).filter(seg => !blockIds.has(String(seg.block_id))),
      ...refreshedSegments,
    ];
  }
  return (trialState.blocks || []).find(item => String(item.block_id) === String(blockId)) || refreshedBlock || block;
}

async function openTrialActualModal(blockId) {
  let block = await trialEnsureBlockActualDetail(blockId);
  if (!block) return;
  const groupSummary = block.group_id
    ? (trialState.block_groups || []).find(group => String(group.group_id || 0) === String(block.group_id))
    : null;
  const groupBlocks = block.group_id
    ? ((groupSummary && Array.isArray(groupSummary.blocks) && groupSummary.blocks.length) ? groupSummary.blocks : (trialState.blocks || [])
        .filter(item => String(item.group_id || 0) === String(block.group_id))
        .sort((a, b) => Number(a.queue_position || 0) - Number(b.queue_position || 0) || Number(a.block_id || 0) - Number(b.block_id || 0)))
    : [block];

  if (groupBlocks.length > 1 && Number(block.group_id || 0)) {
    openTrialGroupActualModal(block.group_id);
    return;
  }

  trialResetActualDraft(blockId, block);
  const outputTotal = (trialState.actuals || [])
    .filter(row => String(row.block_id) === String(blockId) && row.output_qty !== null && row.output_qty !== undefined)
    .reduce((sum, row) => sum + Number(row.output_qty || 0), 0);
  const rejectTotal = (trialState.actuals || [])
    .filter(row => String(row.block_id) === String(blockId) && row.reject_qty !== null && row.reject_qty !== undefined)
    .reduce((sum, row) => sum + Number(row.reject_qty || 0), 0);
  const remainingQty = Math.max(0, Number(block.scheduled_qty || 0) - outputTotal);
  const remainingLoad = remainingQty * Number(block.cycle_minutes_per_qty || 0);
  const dailyRows = trialActualDailyRowsForBlock(block);
  const rowsHtml = dailyRows.length
    ? dailyRows.map(row => trialRenderActualDailyRow(blockId, row)).join('')
    : '<div class="trial-catalog-empty">No scheduled target rows. Recalculate schedule or add a date manually.</div>';
  const cardPsId = String(block.job_no || block.source_ps_id || '').trim();
  const cardOperationLabel = String(block.source_op_no || block.operation_name || '').trim();
  const cardMachineCode = String(block.machine_code || '').trim();
  const cardSummaryLine = `Qty ${fmt(block.scheduled_qty || 0, 0)}${cardMachineCode ? ` · ${cardMachineCode}` : ''}`;

  openTrialForm('Actual Output', `
    <div style="display:grid;gap:12px">
      <div style="display:grid;gap:4px">
        <div style="font-size:18px;font-weight:900;letter-spacing:-0.03em">${escapeHtml(cardPsId || block.job_no || '')}</div>
        <div style="font-size:13px;font-weight:800;color:var(--text2)">${escapeHtml(cardOperationLabel || block.operation_name || block.source_op_no || '')}</div>
        <div style="font-size:12px;font-weight:800;color:var(--text3)">${escapeHtml(cardSummaryLine)}</div>
      </div>
      <div class="trial-actual-summary">
        <div><span class="field-hint">Scheduled</span><strong>${fmt(block.scheduled_qty || 0)}</strong></div>
        <div><span class="field-hint">Output</span><strong>${fmt(outputTotal)}</strong></div>
        <div><span class="field-hint">Reject</span><strong>${fmt(rejectTotal)}</strong></div>
        <div><span class="field-hint">Remaining</span><strong>${fmt(remainingQty)}</strong></div>
        <div><span class="field-hint">Load</span><strong>${fmt(remainingLoad, 0)}m</strong></div>
      </div>
      <div class="trial-actual-section">
        <div class="trial-actual-section-title">Daily rows</div>
        <div class="trial-actual-section-note">Planned dates load automatically. Delete Date is only available for dates you add manually. Over/under target adjusts the remaining schedule.</div>
        <div style="display:flex;flex-wrap:wrap;align-items:end;gap:8px;margin:8px 0 10px">
          <label class="trial-actual-cell" style="min-width:180px">
            <span>Add Date</span>
            <input id="trial-actual-add-date" type="date" value="${trialTodayISO()}">
          </label>
          <button type="button" class="btn btn-ghost btn-sm" onclick="trialAddActualDailyRow(${blockId}, document.getElementById('trial-actual-add-date').value)">Add Date</button>
        </div>
        <div class="trial-actual-daily-table">
        <div class="trial-actual-grid-head">
          <span>Date</span>
          <span>Target Qty</span>
          <span>Output Qty</span>
          <span>Reject Qty</span>
          <span>Remarks</span>
          <span>Delete Date</span>
        </div>
        <div data-trial-actual-daily-grid="${blockId}" style="display:grid;gap:8px">
          ${rowsHtml}
        </div>
        </div>
      </div>
    </div>
  `, 'Save Actuals', async () => {
    await trialSaveActualDailyRows(blockId);
  });
}

function openTrialGroupActualModal(groupId) {
  const groupSummary = trialFindGroupSummaryById(groupId);
  if (!groupSummary) {
    toast('Combined run block not found', 'error');
    return;
  }
  if (!Array.isArray(groupSummary.blocks) || groupSummary.blocks.length <= 1) {
    const fallbackBlockId = groupSummary.leader?.block_id || groupSummary.blocks?.[0]?.block_id || 0;
    if (fallbackBlockId) {
      openTrialActualModal(fallbackBlockId);
    }
    return;
  }

  const cardPsId = String(groupSummary.ps_id || groupSummary.leader?.job_no || groupSummary.leader?.source_ps_id || '').trim();
  const cardOperationLabel = String(groupSummary.operation_label || groupSummary.group_label || '').trim();
  const cardMachineCode = String(groupSummary.machine_code || groupSummary.leader?.machine_code || '').trim();
  const cardSummaryLine = `Qty ${fmt(groupSummary.target_qty || 0, 0)}${cardMachineCode ? ` · ${cardMachineCode}` : ''}`;
  const models = trialCombinedActualModels(groupSummary);
  const dateSet = new Set();
  models.forEach(model => model.segments.forEach(seg => dateSet.add(String(seg.segment_date || ''))));
  const dates = Array.from(dateSet).sort();

  const sectionsHtml = dates.length ? dates.map(reportDate => {
    const rowHtml = models.map(model => {
      const seg = model.segments.find(item => String(item.segment_date || '') === String(reportDate));
      const opLabel = String(model.source.source_op_no || model.source.operation_name || '').trim();
      if (!seg) {
        return `
          <div class="trial-actual-row" style="grid-template-columns:minmax(0,1.2fr) 100px 120px 120px minmax(0,1.6fr);">
            <div class="trial-actual-date">${escapeHtml(opLabel)}</div>
            <div class="trial-actual-target">Missing segment</div>
            <div class="trial-empty" style="min-height:0;padding:8px 10px">-</div>
            <div class="trial-empty" style="min-height:0;padding:8px 10px">-</div>
            <div class="trial-empty" style="min-height:0;padding:8px 10px">-</div>
          </div>
        `;
      }
      const actual = trialActualForSegment(seg.segment_id) || {};
      const outputValue = actual.output_qty === null || actual.output_qty === undefined ? '' : String(actual.output_qty);
      const rejectValue = actual.reject_qty === null || actual.reject_qty === undefined ? '' : String(actual.reject_qty);
      const remarksValue = actual.remarks || '';
      return `
        <div
          class="trial-actual-row"
          style="grid-template-columns:minmax(0,1.2fr) 100px 120px 120px minmax(0,1.6fr);"
          data-trial-combined-segment-row="1"
          data-segment-id="${seg.segment_id}"
          data-initial-output="${escapeHtml(outputValue)}"
          data-initial-reject="${escapeHtml(rejectValue)}"
          data-initial-remarks="${escapeHtml(remarksValue)}"
        >
          <div class="trial-actual-date">${escapeHtml(opLabel)}</div>
          <div class="trial-actual-target">${fmt(seg.qty_done || 0, 0)} target</div>
          <label class="trial-actual-cell">
            <span>Output</span>
            <input data-trial-combined-field="output_qty" type="number" min="0" step="1" value="${escapeHtml(outputValue)}">
          </label>
          <label class="trial-actual-cell">
            <span>Reject</span>
            <input data-trial-combined-field="reject_qty" type="number" min="0" step="1" value="${escapeHtml(rejectValue)}">
          </label>
          <label class="trial-actual-cell">
            <span>Remarks</span>
            <textarea data-trial-combined-field="remarks" rows="1">${escapeHtml(remarksValue)}</textarea>
          </label>
        </div>
      `;
    }).join('');
    return `
      <div class="trial-actual-section">
        <div class="trial-actual-section-title">${escapeHtml(reportDate)}</div>
        <div class="trial-actual-grid-head" style="grid-template-columns:minmax(0,1.2fr) 100px 120px 120px minmax(0,1.6fr);">
          <span>Operation</span>
          <span>Target</span>
          <span>Output</span>
          <span>Reject</span>
          <span>Remarks</span>
        </div>
        ${rowHtml}
      </div>
    `;
  }).join('') : `<div class="trial-catalog-empty">No planned production segments yet.</div>`;

  openTrialForm('Actual Entry', `
    <div style="display:grid;gap:12px">
      <div style="display:grid;gap:4px">
        <div style="font-size:18px;font-weight:900;letter-spacing:-0.03em">${escapeHtml(cardPsId || '')}</div>
        <div style="font-size:13px;font-weight:800;color:var(--text2)">${escapeHtml(cardOperationLabel || '')}</div>
        <div style="font-size:12px;font-weight:800;color:var(--text3)">${escapeHtml(cardSummaryLine)}</div>
      </div>
      <div class="trial-actual-summary">
        <div><span class="field-hint">Target qty</span><strong>${fmt(groupSummary.target_qty || 0)}</strong></div>
        <div><span class="field-hint">Output</span><strong>${fmt(groupSummary.paired_output_qty || 0)}</strong></div>
        <div><span class="field-hint">Reject</span><strong>${fmt(groupSummary.reject_qty || 0)}</strong></div>
        <div><span class="field-hint">Remaining</span><strong>${fmt(groupSummary.remaining_qty || 0)}</strong></div>
        <div><span class="field-hint">Load</span><strong>${fmt(groupSummary.remaining_minutes || 0, 0)}m</strong></div>
      </div>
      <div class="trial-actual-section">
        <div class="trial-actual-section-title">Planned rows by date</div>
        <div class="trial-actual-section-note">Each operation keeps its own actuals inside the combined card.</div>
        ${sectionsHtml}
      </div>
    </div>
  `, 'Save Actuals', async () => {
    try {
      const rowEls = Array.from(document.querySelectorAll('[data-trial-combined-segment-row="1"]'));
      let changedCount = 0;
      for (const rowEl of rowEls) {
        const segmentId = Number(rowEl.dataset.segmentId || 0);
        if (!segmentId) continue;
        const outputValue = rowEl.querySelector('[data-trial-combined-field="output_qty"]')?.value ?? '';
        const rejectValue = rowEl.querySelector('[data-trial-combined-field="reject_qty"]')?.value ?? '';
        const remarksValue = rowEl.querySelector('[data-trial-combined-field="remarks"]')?.value ?? '';
        const initialOutput = String(rowEl.dataset.initialOutput || '');
        const initialReject = String(rowEl.dataset.initialReject || '');
        const initialRemarks = String(rowEl.dataset.initialRemarks || '');
        if (String(outputValue) === initialOutput && String(rejectValue) === initialReject && String(remarksValue) === initialRemarks) continue;
        changedCount += 1;
        await saveSegmentActual(segmentId, {
          output_qty: outputValue,
          reject_qty: rejectValue,
          remarks: remarksValue,
        }, { reload: false, silent: true });
      }
      if (!changedCount) {
        toast('No actual changes to save.', 'success');
        return;
      }
      closeModal();
      const _groupBlockIds = new Set((groupSummary.blocks || []).map(b => String(b.block_id)));
      const _groupMachineId = Number(
        (trialState.blocks || []).find(b => _groupBlockIds.has(String(b.block_id)))?.machine_id || 0
      );
      await refreshMachines([_groupMachineId].filter(Boolean));
      toast('Combined actuals saved', 'success');
    } catch (e) {
      toast('Actual save failed: ' + e.message, 'error');
    }
  });
}
