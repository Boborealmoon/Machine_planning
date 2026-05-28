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

function trialActualModalHost() {
  return document.querySelector('.trial-modal-body') || document.getElementById('trial-modal-shell');
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
    output_qty: row.output_qty === null || row.output_qty === undefined ? '' : String(row.output_qty),
    reject_qty: row.reject_qty === null || row.reject_qty === undefined ? '' : String(row.reject_qty),
    remarks: String(row.remarks || ''),
    is_planned_row: Boolean(row.is_planned_row),
    is_existing_actual: Boolean(row.is_existing_actual),
    locked_date: row.locked_date !== false,
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
  const shell = trialActualModalHost();
  if (!shell) return;
  const grid = shell.querySelector(`[data-trial-actual-daily-grid="${String(blockId)}"]`);
  if (!grid) return;
  const dailyRows = Array.isArray(rows) ? rows : [];
  grid.innerHTML = dailyRows.map(row => trialActualDailyRowHtml(blockId, row)).join('')
    || '<div class="trial-catalog-empty">No scheduled target rows. Recalculate schedule or add a date manually.</div>';
}

function trialActualDailyRowHtml(blockId, row, options = {}) {
  const reportDate = String(row?.report_date || trialTodayISO()).trim();
  const originalReportDate = String(row?.original_report_date || row?.report_date || '').trim();
  const targetQty = Number(row?.target_qty || 0);
  const outputValue = row?.output_qty === null || row?.output_qty === undefined ? '' : String(row.output_qty);
  const rejectValue = row?.reject_qty === null || row?.reject_qty === undefined ? '' : String(row.reject_qty);
  const remarksValue = String(row?.remarks || '');
  const isPlannedRow = Boolean(row?.is_planned_row);
  const isExistingActual = Boolean(row?.is_existing_actual);
  const lockedDate = row?.locked_date !== false;
  const isRemoved = Boolean(options.removed);
  const canRemove = options.canRemove !== false;
  return `
    <div
      class="trial-actual-row trial-actual-daily-row"
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
        <input data-trial-actual-field="output_qty" type="number" min="0" step="1" value="${escapeHtml(outputValue)}" oninput="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, this.closest('.trial-actual-daily-row'))" onchange="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, this.closest('.trial-actual-daily-row'))" onblur="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, this.closest('.trial-actual-daily-row'))" onkeydown="trialActualInputKeydown(event, ${Number(blockId) || 0})">
      </label>
      <label class="trial-actual-cell">
        <span>Reject Qty</span>
        <input data-trial-actual-field="reject_qty" type="number" min="0" step="1" value="${escapeHtml(rejectValue)}" oninput="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, this.closest('.trial-actual-daily-row'))" onchange="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, this.closest('.trial-actual-daily-row'))" onblur="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, this.closest('.trial-actual-daily-row'))" onkeydown="trialActualInputKeydown(event, ${Number(blockId) || 0})">
      </label>
      <label class="trial-actual-cell">
        <span>Remarks</span>
        <textarea data-trial-actual-field="remarks" rows="1" oninput="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, this.closest('.trial-actual-daily-row'))" onchange="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, this.closest('.trial-actual-daily-row'))" onblur="trialSyncActualDailyRowDraft(${Number(blockId) || 0}, this.closest('.trial-actual-daily-row'))" onkeydown="trialActualInputKeydown(event, ${Number(blockId) || 0})">${escapeHtml(remarksValue)}</textarea>
      </label>
      <div class="trial-actual-delete-cell">
        ${canRemove ? `<button type="button" class="btn btn-ghost btn-xs" onclick="trialRemoveActualDailyRow(this.closest('.trial-actual-daily-row'))">Delete Date</button>` : ''}
      </div>
    </div>
  `;
}

function trialRemoveActualDailyRow(rowEl) {
  if (!rowEl) return;
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
  const shell = trialActualModalHost();
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
  grid.insertAdjacentHTML('beforeend', trialActualDailyRowHtml(blockId, row));
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
  const shell = trialActualModalHost();
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
  const shell = trialActualModalHost();
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

function trialActualInputKeydown(event, blockId) {
  if (!event || event.key !== 'Enter') return;
  const tag = String(event.target?.tagName || '').toLowerCase();
  if (tag === 'textarea' && !event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  trialSaveActualDailyRows(blockId);
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
    closeModal();
    await refreshMachines([machineId].filter(Boolean));
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

function openTrialActualModal(blockId) {
  const block = trialState.blocks.find(item => String(item.block_id) === String(blockId));
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
    ? dailyRows.map(row => trialActualDailyRowHtml(blockId, row)).join('')
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
        <div class="trial-actual-section-note">Planned dates load automatically. Delete Date removes the plan for that day and moves target qty to the tail when you save. Over/under target adjusts the remaining schedule.</div>
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
