// Actuals entry — saving per-segment/date outputs and modal UIs.

async function saveSegmentActual(segmentId, patch, options = {}) {
  if (!segmentId) throw new Error('Planned segment is missing. Refresh the page and try again.');
  const data = await POST(`/api/trial/segments/${segmentId}/actual`, patch);
  if (!options.silent && data.message) toast(data.message, 'success');
  if (options.reload !== false) {
    await loadTrial();
  }
  return data;
}

async function trialSaveActualDateInput(blockId, reportDate, field, value) {
  const actual = trialActualForBlockDate(blockId, reportDate) || {};
  const payload = {
    daily_actuals: [{
      report_date: reportDate,
      output_qty: field === 'output_qty' ? value : (actual.output_qty ?? ''),
      reject_qty: field === 'reject_qty' ? value : (actual.reject_qty ?? ''),
      remarks: field === 'remarks' ? value : (actual.remarks || ''),
    }],
  };
  await POST(`/api/trial/blocks/${blockId}/actual`, payload);
  await loadTrial();
}

function trialSetActualDraftValue(reportDate, field, value) {
  if (!trialActualDraft.rows[reportDate]) {
    trialActualDraft.rows[reportDate] = { good: null, reject: null };
  }
  const normalized = String(value ?? '').trim() === '' ? null : Number(value);
  trialActualDraft.rows[reportDate][field] = Number.isFinite(normalized) ? normalized : null;
  const shell = document.getElementById('trial-modal-shell');
  if (!shell) return;
  shell.querySelectorAll(`[data-trial-actual-date="${CSS.escape(reportDate)}"][data-trial-actual-field="${field}"]`).forEach(input => {
    const nextValue = normalized == null ? '' : String(normalized);
    if (String(input.value) !== nextValue) input.value = nextValue;
  });
}

async function trialDeleteActualDraftDate(reportDate, blockId) {
  if (!blockId) return;
  if (!trialActualDraft.deletedDates) {
    trialActualDraft.deletedDates = new Set();
  }
  trialActualDraft.deletedDates.add(reportDate);
  delete trialActualDraft.rows[reportDate];
  const shell = document.getElementById('trial-modal-shell');
  if (!shell) return;
  shell.querySelectorAll(`[data-trial-actual-date-row="${CSS.escape(reportDate)}"]`).forEach(node => node.remove());
  shell.querySelectorAll(`[data-trial-actual-date="${CSS.escape(reportDate)}"]`).forEach(input => {
    input.value = '';
  });
  try {
    await trialSubmitActualDraft(blockId);
    closeModal();
    await loadTrial();
    openTrialActualModal(blockId);
    toast('Actual saved', 'success');
  } catch (e) {
    toast('Actual failed: ' + e.message, 'error');
  }
}

async function trialSubmitActualDraft(blockId, action = null) {
  const block = trialState.blocks.find(item => String(item.block_id) === String(blockId));
  if (!block) throw new Error('Run block not found');
  const segmentMap = new Map(
    trialSegmentsForBlock(blockId)
      .filter(seg => String(seg.segment_type || '') === 'production')
      .map(seg => [String(seg.segment_date || ''), seg])
  );
  const deletedActualDates = Array.from(trialActualDraft.deletedDates || []);
  const actualRemarks = String(trialActualDraft.remarks || '');
  const patches = [];
  for (const [reportDate, row] of Object.entries(trialActualDraft.rows || {})) {
    const seg = segmentMap.get(String(reportDate || ''));
    if (!seg) continue;
    patches.push({
      segmentId: seg.segment_id,
      patch: {
        output_qty: row.good === null ? '' : String(row.good),
        reject_qty: row.reject === null ? '' : String(row.reject),
        remarks: actualRemarks,
      },
    });
  }
  for (const reportDate of deletedActualDates) {
    const seg = segmentMap.get(String(reportDate || ''));
    if (!seg) continue;
    patches.push({
      segmentId: seg.segment_id,
      patch: { output_qty: '', reject_qty: '', remarks: '' },
    });
  }
  if (!patches.length) return { ok: true };
  const results = [];
  for (const item of patches) {
    const res = await saveSegmentActual(item.segmentId, item.patch, { reload: false });
    results.push(res);
  }
  await loadTrial();
  return results[results.length - 1] || { ok: true };
}

async function trialSaveActualInput(segmentId, field, value) {
  const patch = {};
  patch[field] = value;
  try {
    await saveSegmentActual(segmentId, patch);
    const blockId = (trialState.segments || []).find(seg => String(seg.segment_id) === String(segmentId))?.block_id;
    if (blockId) openTrialActualModal(blockId);
  } catch (e) {
    toast('Actual failed: ' + e.message, 'error');
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
  const cardPsId = String((groupSummary && groupSummary.ps_id) || block.job_no || block.source_ps_id || '').trim();
  const cardOperationLabel = String(
    (groupSummary && groupSummary.operation_label)
    || (groupBlocks.length > 1 ? groupBlocks.map(item => String(item.source_op_no || item.operation_name || '')).filter(Boolean).join(' & ') : (block.source_op_no || block.operation_name || ''))
  ).trim();
  const cardMachineCode = String((groupSummary && groupSummary.machine_code) || block.machine_code || '').trim();
  const cardSummaryLine = `Qty ${fmt((groupSummary && groupSummary.target_qty) || block.scheduled_qty || 0, 0)}${cardMachineCode ? ` · ${cardMachineCode}` : ''}`;

  if (groupBlocks.length > 1 && Number(block.group_id || 0)) {
    openTrialGroupActualModal(block.group_id);
    return;
  }

  const actualRows = trialActualRowsForBlock(blockId);
  const outputTotal = (trialState.actuals || [])
    .filter(row => String(row.block_id) === String(blockId) && row.output_qty !== null && row.output_qty !== undefined)
    .reduce((sum, row) => sum + Number(row.output_qty || 0), 0);
  const rejectTotal = (trialState.actuals || [])
    .filter(row => String(row.block_id) === String(blockId) && row.reject_qty !== null && row.reject_qty !== undefined)
    .reduce((sum, row) => sum + Number(row.reject_qty || 0), 0);
  const remainingQty = Math.max(0, Number(block.scheduled_qty || 0) - outputTotal);
  const remainingLoad = remainingQty * Number(block.cycle_minutes_per_qty || 0);
  const rowsHtml = actualRows.length ? actualRows.map(row => {
    const seg = row.segment;
    const actual = row.actual || {};
    const outputValue = actual.output_qty === null || actual.output_qty === undefined ? '' : String(actual.output_qty);
    const rejectValue = actual.reject_qty === null || actual.reject_qty === undefined ? '' : String(actual.reject_qty);
    const remarksValue = actual.remarks || '';
    const outputHandler = seg
      ? `trialSaveActualInput(${seg.segment_id}, 'output_qty', this.value)`
      : `trialSaveActualDateInput(${blockId}, '${escapeHtml(row.report_date)}', 'output_qty', this.value)`;
    const rejectHandler = seg
      ? `trialSaveActualInput(${seg.segment_id}, 'reject_qty', this.value)`
      : `trialSaveActualDateInput(${blockId}, '${escapeHtml(row.report_date)}', 'reject_qty', this.value)`;
    const remarksHandler = seg
      ? `trialSaveActualInput(${seg.segment_id}, 'remarks', this.value)`
      : `trialSaveActualDateInput(${blockId}, '${escapeHtml(row.report_date)}', 'remarks', this.value)`;
    return `
      <div class="trial-actual-row" ${seg ? `data-segment-id="${seg.segment_id}"` : `data-actual-date="${escapeHtml(row.report_date)}"`}>
        <div class="trial-actual-date">${escapeHtml(row.report_date || '')}</div>
        <div class="trial-actual-target">${fmt(row.target_qty || 0, 0)} target${row.actual_only ? ' actual' : ''}</div>
        <label class="trial-actual-cell"><span>Output</span><input type="number" min="0" step="1" value="${escapeHtml(outputValue)}" onkeydown="if(event.key === 'Enter') this.blur()" onblur="${outputHandler}"></label>
        <label class="trial-actual-cell"><span>Reject</span><input type="number" min="0" step="1" value="${escapeHtml(rejectValue)}" onkeydown="if(event.key === 'Enter') this.blur()" onblur="${rejectHandler}"></label>
        <label class="trial-actual-cell"><span>Remarks</span><textarea rows="1" onkeydown="if(event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.blur(); }" onblur="${remarksHandler}">${escapeHtml(remarksValue)}</textarea></label>
      </div>
    `;
  }).join('') : `<div class="trial-catalog-empty">No planned production segments yet.</div>`;

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
        <div class="trial-actual-section-title">Planned rows</div>
        <div class="trial-actual-section-note">Edits save automatically per row. Blank stays unreported; 0 is saved as zero.</div>
        <div class="trial-actual-grid-head">
          <span>Date</span>
          <span>Target</span>
          <span>Output</span>
          <span>Reject</span>
          <span>Remarks</span>
        </div>
        ${rowsHtml}
      </div>
    </div>
  `, '', null);
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
      await loadTrial();
      toast('Combined actuals saved', 'success');
    } catch (e) {
      toast('Actual save failed: ' + e.message, 'error');
    }
  });
}
