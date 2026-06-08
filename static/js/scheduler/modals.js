// Modal helpers, block editors, capacity modal, and queue reorder.

function trialModalShell(html) {
  const shell = document.getElementById('trial-modal-shell');
  shell.innerHTML = html;
}

function closeModal() {
  trialOpenQueueMachineId = 0;
  if (typeof destroyTrialQueueSortable === 'function') destroyTrialQueueSortable();
  document.querySelector('.trial-modal-panel')?.classList.remove('trial-modal-panel--temp-ps');
  trialModalShell('');
  document.body.classList.remove('trial-modal-open');
}

function trialSetPlannerBusy(title, detail = '') {
  trialPlannerBusyDepth += 1;
  let bar = document.getElementById('trial-planner-busy');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'trial-planner-busy';
    bar.className = 'trial-planner-busy';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    bar.setAttribute('aria-busy', 'true');
    bar.innerHTML = `
      <div class="trial-planner-busy-spinner" aria-hidden="true"></div>
      <div class="trial-planner-busy-text">
        <span class="trial-planner-busy-title" data-trial-planner-busy-title></span>
        <span class="trial-planner-busy-detail" data-trial-planner-busy-detail></span>
      </div>
    `;
    document.body.appendChild(bar);
  }
  bar.querySelector('[data-trial-planner-busy-title]').textContent = title || 'Working…';
  const detailEl = bar.querySelector('[data-trial-planner-busy-detail]');
  detailEl.textContent = detail ? ` · ${detail}` : '';
  detailEl.hidden = !detail;
  document.body.classList.add('trial-planner-busy-open');
}

function trialUpdatePlannerBusy(title, detail = '') {
  const overlay = document.getElementById('trial-planner-busy');
  if (!overlay) return;
  if (title) overlay.querySelector('[data-trial-planner-busy-title]').textContent = title;
  const detailEl = overlay.querySelector('[data-trial-planner-busy-detail]');
  if (detailEl) {
    detailEl.textContent = detail || '';
    detailEl.hidden = !detail;
  }
}

function trialClearPlannerBusy() {
  trialPlannerBusyDepth = Math.max(0, trialPlannerBusyDepth - 1);
  if (trialPlannerBusyDepth > 0) return;
  document.getElementById('trial-planner-busy')?.remove();
  document.body.classList.remove('trial-planner-busy-open');
}

async function trialRunWithPlannerBusy(task, title, detail = '') {
  trialPlannerBusyLock += 1;
  let showTimer = null;
  let visible = false;
  showTimer = window.setTimeout(() => {
    visible = true;
    trialSetPlannerBusy(title, detail);
  }, 140);
  try {
    return await task();
  } finally {
    window.clearTimeout(showTimer);
    if (visible) trialClearPlannerBusy();
    trialPlannerBusyLock = Math.max(0, trialPlannerBusyLock - 1);
  }
}

function openModal(title, bodyHtml, size = '') {
  const sizeClass = size ? ` trial-modal-panel-${String(size).trim()}` : '';
  trialModalShell(`
    <div class="trial-modal-backdrop" data-trial-modal-backdrop="1">
      <div class="trial-modal-panel${sizeClass}" role="dialog" aria-modal="true" aria-labelledby="trial-modal-title">
        <div class="trial-modal-head">
          <div id="trial-modal-title" class="trial-modal-title">${escapeHtml(title || '')}</div>
          <button type="button" class="trial-modal-close" aria-label="Close modal" data-trial-modal-close="1">×</button>
        </div>
        <div class="trial-modal-body">${bodyHtml || ''}</div>
      </div>
    </div>
  `);
  document.body.classList.add('trial-modal-open');
  setTimeout(() => {
    const shell = document.getElementById('trial-modal-shell');
    shell?.querySelector('[data-trial-modal-close="1"]')?.addEventListener('click', closeModal);
    shell?.querySelector('[data-trial-modal-backdrop="1"]')?.addEventListener('click', event => {
      if (event.target?.dataset?.trialModalBackdrop === '1') closeModal();
    });
    shell?.querySelector('input, select, textarea, button')?.focus();
  }, 0);
}

function trialParsePayload(dt) {
  if (!dt) return null;
  try {
    const text = dt.getData('text/plain');
    return text ? JSON.parse(text) : null;
  } catch (e) {
    return trialDragPayload;
  }
}

function trialSetDragPayload(payload, dt) {
  trialDragPayload = payload;
  if (dt) {
    try {
      dt.setData('text/plain', JSON.stringify(payload));
      dt.effectAllowed = payload.type === 'op-card' || payload.type === 'block' ? 'move' : 'copyMove';
    } catch (e) {
      // Ignore drag data errors in older browsers.
    }
  }
}

function openTrialForm(title, bodyHtml, onSaveLabel, onSave, extraActionsHtml = '') {
  openModal(title, `
    <div class="trial-modal-form">
      ${bodyHtml}
      <div class="trial-modal-actions">
        ${extraActionsHtml}
        <button type="button" class="btn btn-ghost btn-sm" id="trial-cancel-btn">Cancel</button>
        ${onSaveLabel ? `<button type="button" class="btn btn-primary btn-sm" id="trial-save-btn">${onSaveLabel}</button>` : ''}
      </div>
    </div>
  `);
  setTimeout(() => {
    document.getElementById('trial-cancel-btn')?.addEventListener('click', closeModal);
    if (onSaveLabel && onSave) document.getElementById('trial-save-btn')?.addEventListener('click', onSave);
  }, 0);
}

function trialSetFormModalBusy(title, detail = '') {
  const panel = document.querySelector('.trial-modal-panel');
  if (!panel) return;
  panel.classList.add('is-busy');
  let overlay = panel.querySelector('[data-trial-modal-busy]');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'trial-modal-busy';
    overlay.dataset.trialModalBusy = '1';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML = `
      <div class="trial-modal-busy-card">
        <div class="trial-modal-busy-spinner" aria-hidden="true"></div>
        <p class="trial-modal-busy-title" data-trial-modal-busy-title></p>
        <p class="trial-modal-busy-detail" data-trial-modal-busy-detail></p>
      </div>
    `;
    panel.appendChild(overlay);
  }
  overlay.querySelector('[data-trial-modal-busy-title]').textContent = title || 'Please wait…';
  const detailEl = overlay.querySelector('[data-trial-modal-busy-detail]');
  detailEl.textContent = detail || '';
  detailEl.hidden = !detail;
  panel.querySelectorAll('input, select, textarea, button').forEach(node => {
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.trialBusyPrevDisabled === undefined) {
      node.dataset.trialBusyPrevDisabled = node.disabled ? '1' : '0';
    }
    if ('disabled' in node) node.disabled = true;
  });
}

function trialUpdateFormModalBusy(title, detail = '') {
  trialSetFormModalBusy(title, detail);
}

function trialClearFormModalBusy() {
  const panel = document.querySelector('.trial-modal-panel');
  if (!panel) return;
  panel.classList.remove('is-busy');
  panel.querySelector('[data-trial-modal-busy]')?.remove();
  panel.querySelectorAll('[data-trial-busy-prev-disabled]').forEach(node => {
    if (!(node instanceof HTMLElement) || !('disabled' in node)) return;
    node.disabled = node.dataset.trialBusyPrevDisabled === '1';
    delete node.dataset.trialBusyPrevDisabled;
  });
}

function openTrialCreateModal(defaultMachineId = '') {
  const machineOptions = (trialState.machines || []).map(machine =>
    `<option value="${machine.machine_id}" ${String(machine.machine_id) === String(defaultMachineId) ? 'selected' : ''}>${machine.machine_code}</option>`
  ).join('');
  openTrialForm('Add Run Block', `
    <div class="trial-modal-grid">
      <label>Job No <input id="trial-job-no" placeholder="J1001"></label>
      <label>Operation Name <input id="trial-operation-name" placeholder="Cutting"></label>
      <label>Total Qty <input id="trial-total-qty" type="number" min="0" step="1" value="100"></label>
      <label>Scheduled Qty <input id="trial-scheduled-qty" type="number" min="0" step="1" value="100"></label>
      <label>Setup Minutes <input id="trial-setup-minutes" type="number" min="0" step="1" value="30"></label>
      <label>Cycle Minutes / Qty <input id="trial-cycle-minutes" type="number" min="0" step="0.1" value="2"></label>
      <label>Machine <select id="trial-machine-id">${machineOptions}</select></label>
      <label>Queue Position <input id="trial-queue-position" type="number" min="1" step="1" value="0"></label>
      <label>Include Setup <select id="trial-include-setup"><option value="1" selected>Yes</option><option value="0">No</option></select></label>
      <label>Anchor Datetime <input id="trial-anchor-datetime" type="datetime-local"></label>
      <label class="full">Remarks <textarea id="trial-remarks" rows="3" placeholder="Optional note"></textarea></label>
    </div>
  `, 'Create', async () => {
    try {
      const _newMachineId = Number(document.getElementById('trial-machine-id')?.value || 0);
      await POST('/api/trial/operations', {
        job_no: document.getElementById('trial-job-no').value,
        operation_name: document.getElementById('trial-operation-name').value,
        total_qty: Number(document.getElementById('trial-total-qty').value || 0),
        scheduled_qty: Number(document.getElementById('trial-scheduled-qty').value || 0),
        setup_minutes: Number(document.getElementById('trial-setup-minutes').value || 0),
        cycle_minutes_per_qty: Number(document.getElementById('trial-cycle-minutes').value || 0),
        machine_id: Number(document.getElementById('trial-machine-id').value || 0),
        queue_position: Number(document.getElementById('trial-queue-position').value || 0),
        include_setup: document.getElementById('trial-include-setup').value === '1',
        anchor_datetime: trialDatetimeLocalToStorage(document.getElementById('trial-anchor-datetime').value),
        remarks: document.getElementById('trial-remarks').value,
      });
      closeModal();
      await refreshMachines([_newMachineId]);
      toast('Run block created', 'success');
    } catch (e) {
      toast('Create failed: ' + e.message, 'error');
    }
  });
}

function openTrialBlockEditor(blockId) {
  const block = trialState.blocks.find(item => String(item.block_id) === String(blockId));
  if (!block) return;
  const machineOptions = (trialState.machines || []).map(machine =>
    `<option value="${machine.machine_id}" ${String(machine.machine_id) === String(block.machine_id) ? 'selected' : ''}>${machine.machine_code}</option>`
  ).join('');
  openTrialForm('Edit Run Block', `
    <div class="trial-modal-grid">
      <label>Job No <input id="trial-edit-job-no" value="${block.job_no || ''}"></label>
      <label>Operation Name <input id="trial-edit-operation-name" value="${block.operation_name || ''}"></label>
      <label>Total Qty <input id="trial-edit-total-qty" type="number" min="0" step="1" value="${block.total_qty || 0}"></label>
      <label>Scheduled Qty <input id="trial-edit-scheduled-qty" type="number" min="0" step="1" value="${block.scheduled_qty || 0}"></label>
      <label>Setup Minutes <input id="trial-edit-setup-minutes" type="number" min="0" step="1" value="${block.setup_minutes || 0}"></label>
      <label>Cycle Minutes / Qty <input id="trial-edit-cycle-minutes" type="number" min="0" step="0.1" value="${block.cycle_minutes_per_qty || 0}"></label>
      <label>Machine <select id="trial-edit-machine-id">${machineOptions}</select></label>
      <label>Queue Position <input id="trial-edit-queue-position" type="number" min="1" step="1" value="${block.queue_position || 1}"></label>
      <label>Include Setup <select id="trial-edit-include-setup">
        <option value="1" ${Number(block.include_setup || 0) === 1 ? 'selected' : ''}>Yes</option>
        <option value="0" ${Number(block.include_setup || 0) === 0 ? 'selected' : ''}>No</option>
      </select></label>
      <label>Anchor Datetime
        <input id="trial-edit-anchor-datetime" type="datetime-local" value="${escapeHtml(trialAnchorDefaultDatetimeLocal(block))}">
      </label>
      <p class="trial-modal-hint full">Planning reference start. Without an anchor, the job chains from the previous queue job end; with an anchor, scheduling uses this date/time unless a prior job or dependency finishes later.</p>
      <label class="full">Remarks <textarea id="trial-edit-remarks" rows="3">${block.remarks || ''}</textarea></label>
    </div>
  `, 'Save', async () => {
    if (openTrialBlockEditor._saveInFlight) return;
    openTrialBlockEditor._saveInFlight = true;
    const saveBtn = document.getElementById('trial-save-btn');
    const originalSaveLabel = saveBtn ? saveBtn.textContent : 'Save';
    try {
      const _editedMachineId = Number(document.getElementById('trial-edit-machine-id')?.value || 0);
      trialSetFormModalBusy(
        'Saving run block…',
        'Writing changes and syncing with the planner schedule.'
      );
      if (saveBtn) {
        saveBtn.textContent = 'Saving…';
        saveBtn.setAttribute('aria-busy', 'true');
      }
      const catalogRef = typeof trialPlanningCardFromBlock === 'function'
        ? trialPlanningCardFromBlock(block)
        : null;
      const siblingMachineIds = catalogRef && typeof trialBlocksForCatalogOp === 'function'
        ? trialBlocksForCatalogOp(catalogRef).map(row => Number(row.machine_id || 0)).filter(Boolean)
        : [];
      const affectedIds = [...new Set([block.machine_id, _editedMachineId, ...siblingMachineIds].filter(Boolean))];
      const result = await PUT(`/api/trial/blocks/${block.block_id}`, {
        job_no: document.getElementById('trial-edit-job-no').value,
        operation_name: document.getElementById('trial-edit-operation-name').value,
        total_qty: Number(document.getElementById('trial-edit-total-qty').value || 0),
        scheduled_qty: Number(document.getElementById('trial-edit-scheduled-qty').value || 0),
        setup_minutes: Number(document.getElementById('trial-edit-setup-minutes').value || 0),
        cycle_minutes_per_qty: Number(document.getElementById('trial-edit-cycle-minutes').value || 0),
        machine_id: _editedMachineId,
        queue_position: Number(document.getElementById('trial-edit-queue-position').value || 1),
        include_setup: document.getElementById('trial-edit-include-setup').value === '1',
        anchor_datetime: trialDatetimeLocalToStorage(document.getElementById('trial-edit-anchor-datetime').value),
        remarks: document.getElementById('trial-edit-remarks').value,
        recalculate: false,
      });
      trialMarkDirtyMachines(affectedIds);
      trialUpdateFormModalBusy(
        'Refreshing lane…',
        'Updating the board with your saved changes.'
      );
      if (saveBtn) saveBtn.textContent = 'Syncing…';
      if (!trialApplyMachineRefreshFromResponse(affectedIds, result)) {
        await refreshMachines(affectedIds, { response: result });
      }
      openTrialBlockEditor._saveInFlight = false;
      closeModal();
      toast('Run block saved — click Recalculate schedules to refresh times', 'success');
    } catch (e) {
      trialClearFormModalBusy();
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = originalSaveLabel;
        saveBtn.removeAttribute('aria-busy');
      }
      toast('Update failed: ' + e.message, 'error');
      openTrialBlockEditor._saveInFlight = false;
    }
  }, `
    <button type="button" class="btn btn-ghost btn-sm" id="trial-actual-output">Actual Output</button>
    <button type="button" class="btn btn-ghost btn-sm" id="trial-delete-block">Delete</button>
  `);
  setTimeout(() => {
    document.getElementById('trial-actual-output')?.addEventListener('click', () => openTrialActualModal(block.block_id));
    document.getElementById('trial-delete-block')?.addEventListener('click', async () => {
      if (!confirm(`Delete ${block.job_no} - ${block.operation_name}?`)) return;
      try {
        const _delMachineId = block.machine_id;
        await DEL(`/api/trial/blocks/${block.block_id}`);
        closeModal();
        await refreshMachines([_delMachineId].filter(Boolean));
        if (typeof trialRefreshCatalogSidebar === 'function') {
          trialRefreshCatalogSidebar();
        }
        toast('Run block deleted', 'success');
      } catch (e) {
        toast('Delete failed: ' + e.message, 'error');
      }
    });
  }, 0);
}

function openTrialSplitModal(blockId) {
  const block = trialState.blocks.find(item => String(item.block_id) === String(blockId));
  if (!block) return;
  let splitInFlight = false;
  openTrialForm('Split Run Block', `
    <div class="trial-modal-grid">
      <label class="full">Split quantity for <strong>${block.job_no} - ${block.operation_name}</strong>
        <input id="trial-split-qty" type="number" min="1" step="1" value="${Math.max(1, Math.floor(Number(block.scheduled_qty || 0) / 2))}">
      </label>
      <div id="trial-split-status" class="trial-modal-hint" style="display:none">Splitting block...</div>
    </div>
  `, 'Split', async () => {
    if (splitInFlight) return;
    splitInFlight = true;
    const saveBtn = document.getElementById('trial-save-btn');
    const cancelBtn = document.getElementById('trial-cancel-btn');
    const qtyInput = document.getElementById('trial-split-qty');
    const statusEl = document.getElementById('trial-split-status');
    const originalLabel = saveBtn ? saveBtn.textContent : 'Split';
    try {
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Splitting...';
        saveBtn.setAttribute('aria-busy', 'true');
      }
      if (cancelBtn) cancelBtn.disabled = true;
      if (qtyInput) qtyInput.disabled = true;
      if (statusEl) statusEl.style.display = 'block';
      const machineId = Number(block.machine_id || 0);
      const result = await POST(`/api/trial/blocks/${block.block_id}/split`, {
        split_qty: Number(document.getElementById('trial-split-qty').value || 0),
      });
      closeModal();
      if (result?.block && typeof trialMergeBlockFromApi === 'function') {
        trialMergeBlockFromApi(result.block);
      }
      if (result?.new_block) {
        if (typeof trialPinBlock === 'function') trialPinBlock(result.new_block);
        if (typeof trialMergeBlockFromApi === 'function') trialMergeBlockFromApi(result.new_block);
      }
      if (typeof trialMarkDirtyMachines === 'function') {
        trialMarkDirtyMachines([machineId].filter(Boolean), { skipRender: true });
      }
      const refreshed = machineId
        && typeof trialApplyMachineRefreshFromResponse === 'function'
        && trialApplyMachineRefreshFromResponse([machineId], result);
      if (!refreshed && machineId) {
        await refreshMachines([machineId], { response: result });
      }
      if (typeof trialRefreshCatalogSidebar === 'function') {
        trialRefreshCatalogSidebar();
      }
      toast('Block split — click Recalculate schedules for times', 'success');
    } catch (e) {
      toast('Split failed: ' + e.message, 'error');
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = originalLabel || 'Split';
        saveBtn.removeAttribute('aria-busy');
      }
      if (cancelBtn) cancelBtn.disabled = false;
      if (qtyInput) qtyInput.disabled = false;
      if (statusEl) statusEl.style.display = 'none';
      splitInFlight = false;
    }
  });
}

let trialCapacitySaveInFlight = 0;

function trialSetCapacityModalBusy(message = '') {
  const modal = document.querySelector('.trial-capacity-modal');
  const banner = document.getElementById('trial-cap-busy-banner');
  const textEl = document.getElementById('trial-cap-busy-text');
  const busy = Boolean(message);
  if (modal) modal.classList.toggle('is-busy', busy);
  if (banner) banner.hidden = !busy;
  if (textEl) textEl.textContent = message || '';
  document.querySelectorAll('.trial-capacity-modal .trial-cap-save-btn').forEach((btn) => {
    if (!btn.closest('.trial-capacity-row.is-public-holiday')) {
      btn.disabled = busy || btn.dataset.lockedHoliday === '1';
    }
  });
  document.querySelectorAll('.trial-capacity-modal-controls button, #trial-cap-refresh-holidays').forEach((btn) => {
    btn.disabled = busy;
  });
  document.querySelectorAll('.trial-capacity-modal input, .trial-capacity-modal select').forEach((el) => {
    if (busy) {
      el.dataset.busyPrevDisabled = el.disabled ? '1' : '0';
      el.disabled = true;
      return;
    }
    if (el.dataset.busyPrevDisabled === '0') el.disabled = false;
    delete el.dataset.busyPrevDisabled;
  });
}

function trialMarkCapacityRowState(workDate, state) {
  const row = document.querySelector(`.trial-capacity-row[data-work-date="${workDate}"]`);
  if (!row) return;
  row.classList.remove('is-saving', 'is-saved', 'is-save-error');
  if (state) row.classList.add(state);
  const btn = row.querySelector('.trial-cap-save-btn');
  if (!btn) return;
  if (state === 'is-saving') {
    btn.textContent = 'Saving…';
    btn.setAttribute('aria-busy', 'true');
  } else if (state === 'is-saved') {
    btn.textContent = 'Saved';
    btn.removeAttribute('aria-busy');
  } else if (state === 'is-save-error') {
    btn.textContent = 'Retry';
    btn.removeAttribute('aria-busy');
  } else {
    btn.textContent = 'Save';
    btn.removeAttribute('aria-busy');
  }
}

function openTrialCapacityModal(startDate = '', dayCount = 14) {
  trialEnsureCapacityData(startDate, dayCount).then(() => {
    trialOpenCapacityModalBody(startDate, dayCount);
  }).catch(err => {
    console.error('capacity load failed:', err);
    toast('Could not load shop calendar: ' + err.message, 'error');
  });
}

async function trialLoadPublicHolidaysForRange(fromDate, toDate) {
  const from = String(fromDate || '').trim();
  const to = String(toDate || '').trim();
  if (!from || !to) return [];
  const holidayData = await GET(`/api/trial/public-holidays?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  if (Array.isArray(holidayData?.holidays)) {
    trialState.public_holidays = holidayData.holidays;
    return holidayData.holidays;
  }
  trialState.public_holidays = [];
  return [];
}

async function trialEnsureCapacityData(startDate = '', dayCount = 14) {
  if (!trialState.capacityBundleLoaded) {
    const data = await GET('/api/trial/schedule?lite=1&include=capacities');
    if (Array.isArray(data?.capacities)) trialState.capacities = data.capacities;
    if (Array.isArray(data?.profiles)) trialState.profiles = data.profiles;
    trialState.capacityBundleLoaded = true;
  }
  const start = startDate || trialTodayLocal();
  const days = Math.max(1, Number(dayCount || 14));
  const end = trialShiftDate(start, days - 1);
  const from = trialShiftDate(start, -14);
  const to = trialShiftDate(end, 14);
  await trialLoadPublicHolidaysForRange(from, to);
}

async function refreshSgPublicHolidays(options = {}) {
  const startYear = Number(options.fromYear);
  const endYear = Number(options.toYear ?? options.endYear);
  const body = {};
  if (Number.isFinite(startYear)) body.from_year = startYear;
  if (Number.isFinite(endYear)) body.to_year = endYear;
  let result;
  try {
    result = await POST('/api/trial/refresh-public-holidays', body);
  } catch (primaryErr) {
    result = await POST('/api/trial/public-holidays/refresh', body);
  }
  if (Array.isArray(result?.holidays)) {
    const byDate = new Map((trialState.public_holidays || []).map((row) => [row.holiday_date, row]));
    result.holidays.forEach((row) => {
      byDate.set(row.holiday_date, {
        holiday_date: row.holiday_date,
        note: row.note || '',
        source: 'sg_mom',
        fetched_at: result.fetched_at || '',
      });
    });
    trialState.public_holidays = Array.from(byDate.values()).sort((a, b) =>
      String(a.holiday_date).localeCompare(String(b.holiday_date))
    );
  }
  trialState.capacityBundleLoaded = false;
  await loadTrial();
  return result;
}

function trialOpenCapacityModalBody(startDate = '', dayCount = 14) {
  const referenceMachineId = (trialState.machines && trialState.machines[0] && trialState.machines[0].machine_id)
    ? trialState.machines[0].machine_id : 0;
  const capMap = trialCapacityByKey();
  const days = Math.max(1, Number(dayCount || 14));
  const start = startDate || trialTodayLocal();
  const rows = [];
  const holidayMap = trialPublicHolidayMap();
  for (let i = 0; i < days; i += 1) {
    const workDate = trialShiftDate(start, i);
    const cap = capMap.get(trialCapacityKey(referenceMachineId, workDate)) || {};
    const publicHoliday = holidayMap.get(workDate) || null;
    const defaultProfile = trialDefaultProfileNameForDate(workDate);
    const lockedHoliday = Boolean(publicHoliday);
    const profileValue = lockedHoliday ? 'OFF' : (cap.profile_name || defaultProfile);
    const holidayBadge = publicHoliday
      ? `<span class="trial-capacity-holiday-badge" title="${escapeHtml(publicHoliday.note || 'Public holiday')}">SG holiday</span>`
      : '';
    const holidayNote = publicHoliday
      ? `<div class="trial-capacity-holiday-note">${escapeHtml(publicHoliday.note || 'Public holiday')}</div>`
      : '';
    rows.push(`
      <div class="trial-capacity-row${lockedHoliday ? ' is-public-holiday' : ''}" data-work-date="${workDate}">
        <label>${workDate}${holidayBadge}${holidayNote}</label>
        <select id="trial-cap-profile-${workDate}" ${lockedHoliday ? 'disabled' : ''}>
          ${trialProfileOptions(profileValue)}
        </select>
        <input id="trial-cap-note-${workDate}" type="text" value="${cap.note ? String(cap.note).replace(/"/g, '&quot;') : ''}" placeholder="Note" ${lockedHoliday ? 'disabled' : ''}>
        <button class="btn btn-ghost btn-sm trial-cap-save-btn" type="button" data-locked-holiday="${lockedHoliday ? '1' : '0'}" ${lockedHoliday ? 'disabled title="Public holiday — machines are OFF"' : ''} onclick="saveTrialCapacity(this)">Save</button>
      </div>
    `);
  }
  const holidayCount = (trialState.public_holidays || []).length;
  const bodyHtml = `
    <div class="trial-capacity-modal">
      <div id="trial-cap-busy-banner" class="trial-cap-busy-banner" hidden>
        <span class="trial-cap-busy-spinner" aria-hidden="true"></span>
        <span id="trial-cap-busy-text" class="trial-cap-busy-text">Saving…</span>
      </div>
      <div class="trial-capacity-modal-head">
        <div>
          <div style="font-size:18px;font-weight:900;letter-spacing:-0.03em">Shop Calendar</div>
          <div style="font-size:12px;color:var(--text3)">Shared across all machines</div>
        </div>
        <div style="font-size:12px;color:var(--text3);max-width:280px;text-align:right">
          Set the daily profile here. The same calendar is applied to every machine.
          <span class="trial-capacity-holiday-badge" style="margin-left:6px">SG holiday</span> = imported from data.gov.sg (MOM).
        </div>
      </div>
      <div class="trial-capacity-modal-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="trial-cap-refresh-holidays">Refresh SG holidays</button>
        <span id="trial-cap-holiday-status" class="trial-capacity-holiday-status">${holidayCount ? `${holidayCount} holiday(s) loaded for this window` : 'No holidays loaded — click Refresh or restart the app server'}</span>
      </div>
      <div class="trial-capacity-modal-controls">
        <button type="button" class="btn btn-ghost btn-sm" onclick="openTrialCapacityModal(trialShiftDate(document.getElementById('trial-cap-start').value, -Number(document.getElementById('trial-cap-days').value || 14)), document.getElementById('trial-cap-days').value)">Prev</button>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);font-weight:700">Start <input id="trial-cap-start" type="date" value="${start}"></label>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);font-weight:700">Days
          <select id="trial-cap-days">
            <option value="7" ${days === 7 ? 'selected' : ''}>7</option>
            <option value="14" ${days === 14 ? 'selected' : ''}>14</option>
            <option value="28" ${days === 28 ? 'selected' : ''}>28</option>
          </select>
        </label>
        <button type="button" class="btn btn-ghost btn-sm" onclick="openTrialCapacityModal(trialShiftDate(document.getElementById('trial-cap-start').value, Number(document.getElementById('trial-cap-days').value || 14)), document.getElementById('trial-cap-days').value)">Next</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="openTrialCapacityModal(trialTodayLocal(), document.getElementById('trial-cap-days').value)">Today</button>
        <span style="margin-left:auto;color:var(--text3);font-size:12px">Showing ${days} day(s)</span>
      </div>
      <div class="trial-capacity-modal-body">
        ${rows.join('')}
      </div>
    </div>
  `;
  openModal('Shop Calendar', bodyHtml, 'lg');
  const refreshBtn = document.getElementById('trial-cap-refresh-holidays');
  const statusEl = document.getElementById('trial-cap-holiday-status');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const viewStart = document.getElementById('trial-cap-start')?.value || start;
      const viewEnd = trialShiftDate(viewStart, Math.max(0, days - 1));
      const fromYear = Number(String(viewStart).slice(0, 4));
      const toYear = Number(String(viewEnd).slice(0, 4));
      trialCapacitySaveInFlight += 1;
      trialSetCapacityModalBusy('Fetching SG holidays from data.gov.sg…');
      if (statusEl) statusEl.textContent = '';
      try {
        trialSetCapacityModalBusy('Importing holidays and rescheduling machines…');
        const result = await refreshSgPublicHolidays({ fromYear, toYear });
        toast(`SG holidays updated (${result.upserted_count || 0} dates)`, 'success');
        await trialEnsureCapacityData(viewStart, days);
        trialOpenCapacityModalBody(viewStart, days);
        if (statusEl) statusEl.textContent = `Last refresh: ${result.upserted_count || 0} date(s)`;
      } catch (e) {
        const hint = String(e.message || '').includes('404')
          ? ' Restart the Flask app so new API routes load, then try again.'
          : '';
        toast('SG holiday refresh failed: ' + e.message + hint, 'error');
        if (statusEl) statusEl.textContent = 'Refresh failed';
      } finally {
        trialCapacitySaveInFlight = Math.max(0, trialCapacitySaveInFlight - 1);
        if (trialCapacitySaveInFlight === 0) trialSetCapacityModalBusy('');
      }
    });
  }
}

function trialAnchorDefaultDatetimeLocal(block) {
  return trialDatetimeLocalValue(block?.anchor_datetime || '');
}

function editTrialAnchor(blockId) {
  const block = trialState.blocks.find(item => String(item.block_id) === String(blockId));
  if (!block) return;
  const defaultValue = trialAnchorDefaultDatetimeLocal(block);
  openTrialForm('Set Anchor', `
    <p class="trial-modal-hint">Planning reference start. Without an anchor, the job chains from the previous queue job end; with an anchor, scheduling uses this date/time unless a prior job or dependency finishes later.</p>
    <div class="trial-modal-grid">
      <label class="full">Anchor Datetime <input id="trial-anchor-input" type="datetime-local" value="${escapeHtml(defaultValue)}"></label>
    </div>
  `, 'Save', async () => {
    try {
      await PUT(`/api/trial/blocks/${block.block_id}`, {
        anchor_datetime: trialDatetimeLocalToStorage(document.getElementById('trial-anchor-input').value),
      });
      closeModal();
      await refreshMachines([block.machine_id].filter(Boolean));
      toast('Anchor updated', 'success');
    } catch (e) {
      toast('Anchor update failed: ' + e.message, 'error');
    }
  });
}

async function toggleTrialSetup(blockId) {
  const block = trialState.blocks.find(item => String(item.block_id) === String(blockId));
  if (!block) return;
  try {
    const machineId = Number(block.machine_id || 0);
    const result = await PUT(`/api/trial/blocks/${block.block_id}`, {
      include_setup: Number(block.include_setup || 0) === 1 ? 0 : 1,
      recalculate: false,
    });
    trialMarkDirtyMachines([machineId].filter(Boolean));
    await refreshMachines([machineId].filter(Boolean), { response: result });
    toast('Setup updated — click Recalculate schedules to refresh times', 'success');
  } catch (e) {
    toast('Setup toggle failed: ' + e.message, 'error');
  }
}

async function saveTrialCapacity(triggerOrDate, profileName, note = '') {
  let workDate = '';
  let profile = '';
  let noteText = '';
  if (triggerOrDate && typeof triggerOrDate === 'object' && triggerOrDate.tagName) {
    const row = triggerOrDate.closest('.trial-capacity-row');
    workDate = row?.dataset?.workDate || '';
    profile = row?.querySelector('select')?.value || '';
    noteText = row?.querySelector('input[type="text"]')?.value || '';
  } else {
    workDate = String(triggerOrDate || '');
    profile = profileName || '';
    noteText = note || '';
  }
  if (!workDate || trialCapacitySaveInFlight > 0) return;

  trialCapacitySaveInFlight += 1;
  trialMarkCapacityRowState(workDate, 'is-saving');
  trialSetCapacityModalBusy(`Saving ${workDate}…`);
  const statusEl = document.getElementById('trial-cap-holiday-status');
  const startedAt = Date.now();

  try {
    trialSetCapacityModalBusy(`Saving ${workDate} — rescheduling all machines (may take a minute)…`);
    await POST('/api/trial/capacity', {
      work_date: workDate,
      profile_name: profile,
      note: noteText,
    });
    trialSetCapacityModalBusy('Refreshing planner board…');
    trialState.capacityBundleLoaded = false;
    await loadTrial();
    const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    trialMarkCapacityRowState(workDate, 'is-saved');
    if (statusEl) {
      statusEl.textContent = `Saved ${workDate} · queues updated (${elapsedSec}s)`;
    }
    toast(`Capacity saved for ${workDate} — schedules updated`, 'success');
    window.setTimeout(() => {
      if (trialCapacitySaveInFlight === 0) trialMarkCapacityRowState(workDate, '');
    }, 2500);
  } catch (e) {
    trialMarkCapacityRowState(workDate, 'is-save-error');
    if (statusEl) statusEl.textContent = `Save failed for ${workDate}`;
    toast('Capacity save failed: ' + e.message, 'error');
  } finally {
    trialCapacitySaveInFlight = Math.max(0, trialCapacitySaveInFlight - 1);
    if (trialCapacitySaveInFlight === 0) trialSetCapacityModalBusy('');
  }
}

async function saveTrialOrder(lane, reload = true) {
  const order = trialLaneOrderFromElement(lane);
  if (!order) return;
  try {
    const result = await postTrialQueueReorder([order], { recalculate: false });
    trialMarkDirtyMachines([order.machine_id]);
    if (reload) {
      await refreshMachines([order.machine_id], { response: result });
      toast('Queue order saved — recalculate schedules when ready', 'success');
    }
  } catch (e) {
    toast('Reorder failed: ' + e.message, 'error');
  }
}

function openTrialMachineQueue(machineId) {
  const id = Number(machineId || 0);
  if (!id) return;
  const machine = (trialState.machines || []).find(row => Number(row.machine_id) === id);
  if (!machine) return;
  trialOpenQueueMachineId = id;
  const allGroups = trialBlocksGroupedForMachine(id);
  const groups = allGroups.filter(trialGroupRunsInsideDateFilter);
  const availabilityEnd = trialMachineAvailabilityEnd(
    trialHasActiveDateFilter() ? groups : allGroups
  );
  const firstLeader = (groups[0] || allGroups[0])?.leader;
  const firstBlockId = Number(firstLeader?.block_id || 0);
  const firstAnchor = String(firstLeader?.anchor_datetime || '').trim();
  const firstAnchorText = firstAnchor ? trialFormatDt(firstAnchor) : '';
  const anchorTitle = firstAnchor
    ? `Anchor ${firstAnchorText} — tap to change`
    : 'Tap to set anchor for first job in queue';
  const availabilityText = availabilityEnd
    ? `Next available ${escapeHtml(trialFormatDt(availabilityEnd))}`
    : 'Queued jobs';
  const anchorMeta = firstAnchorText
    ? `Anchor ${escapeHtml(firstAnchorText)}`
    : 'Tap to set anchor';
  const availabilityNote = (availabilityEnd || firstBlockId)
    ? (firstBlockId
      ? `<button type="button" class="trial-queue-panel-meta trial-queue-panel-availability trial-machine-availability is-anchorable"
              onclick="editTrialAnchor(${firstBlockId})"
              title="${escapeHtml(anchorTitle)}">
              <span class="trial-machine-availability-stack">
                <span class="trial-machine-availability-text">${availabilityText}</span>
                <span class="trial-machine-anchor-meta is-clickable ${firstAnchorText ? 'is-set' : 'is-unset'}">
                  <span class="trial-machine-anchor-meta-text">${anchorMeta}</span>
                  <span class="trial-anchor-edit-icon" aria-hidden="true">✎</span>
                </span>
              </span>
            </button>`
      : `<div class="trial-queue-panel-meta trial-queue-panel-availability">
              <span class="trial-machine-availability-stack">
                <span class="trial-machine-availability-text">${availabilityText}</span>
                ${firstAnchorText ? `<span class="trial-machine-anchor-meta is-set">Anchor ${escapeHtml(firstAnchorText)}</span>` : ''}
              </span>
            </div>`)
    : '';
  const staleNote = trialDirtyMachineIds.has(id)
    ? `<div class="trial-queue-panel-stale">Schedule times may be outdated. <button type="button" class="btn btn-primary btn-sm" onclick="trialRecalculateSingleMachine(${id})">Recalculate</button></div>`
    : '';
  const duplicateCount = typeof trialMachineDuplicateQueueCount === 'function'
    ? trialMachineDuplicateQueueCount(id)
    : 0;
  const dedupeNote = duplicateCount > 0
    ? `<div class="trial-queue-panel-stale">Found ${duplicateCount} duplicate queue ${duplicateCount === 1 ? 'entry' : 'entries'}.
      <button type="button" class="btn btn-primary btn-sm" onclick="trialDedupeMachineQueue(${id})">Remove duplicates</button></div>`
    : '';
  const rowsHtml = groups.length
    ? groups.map((group, idx) => trialRenderQueueDetailRow(group, idx + 1)).join('')
    : `<div class="trial-empty">${escapeHtml(trialMachineLaneEmptyMessage(allGroups.length, groups.length))}</div>`;
  const listHtml = groups.length
    ? `<div class="trial-queue-panel-list trial-lane" id="trial-queue-list-${id}" data-machine-id="${id}">${trialRenderQueueListHeader()}${rowsHtml}</div>`
    : rowsHtml;
  openModal(
    `${machine.machine_code} — Queue`,
    `
      <div class="trial-queue-panel">
        <div class="trial-queue-panel-head">
          <div>
            <div class="trial-queue-panel-subtitle">${escapeHtml(machine.machine_category)} · ${escapeHtml(machine.shift_profile || 'STANDARD')}</div>
            ${availabilityNote}
            ${staleNote}
            ${dedupeNote}
          </div>
          <button class="btn btn-primary btn-sm" type="button" onclick="openTrialCreateModal(${id})">Add</button>
        </div>
        <p class="trial-queue-panel-hint">Drag ⋮⋮ to reorder · row buttons to edit</p>
        ${listHtml}
      </div>
    `,
    'lg',
  );
  if (typeof initTrialQueuePanelSortable === 'function') initTrialQueuePanelSortable();
}

async function toggleTrialCompletedCatalog() {
  trialShowCompleted = !trialShowCompleted;
  updateTrialCompletedButton();
  const cacheKey = trialCatalogCacheKey();
  trialLoadCache[cacheKey] = null;
  trialLoadCache[`${cacheKey}ExpiresAt`] = 0;
  const catalogRoot = document.getElementById('trial-catalog');
  if (catalogRoot) {
    catalogRoot.innerHTML = '<div class="trial-catalog-empty">Loading catalog...</div>';
  }
  try {
    const erpVouchers = await GET(trialCatalogUrl(true));
    trialLoadCache[cacheKey] = Array.isArray(erpVouchers) ? erpVouchers : [];
    trialLoadCache[`${cacheKey}ExpiresAt`] = Date.now() + 60000;
    trialState.catalog = trialLoadCache[cacheKey];
  } catch (err) {
    console.error('catalog reload failed:', err);
    toast('Could not load completed history: ' + err.message, 'error');
  }
  renderTrialCatalog();
}

function trialDuplicateQueueBlockIds(machineId) {
  const id = Number(machineId || 0);
  if (!id) return [];
  const groups = (typeof trialBlocksGroupedForMachine === 'function' ? trialBlocksGroupedForMachine(id) : []);
  const seen = new Set();
  const removeIds = [];
  groups.forEach(group => {
    const leader = group?.leader || group?.blocks?.[0];
    const blockId = Number(leader?.block_id || 0);
    if (!blockId) return;
    const key = typeof trialQueueIdentityKey === 'function'
      ? trialQueueIdentityKey({
        source_ps_id: leader.source_ps_id || leader.job_no,
        job_no: leader.job_no || leader.source_ps_id,
        source_op_no: leader.source_op_no,
        source_op_seq_id: leader.source_op_seq_id,
        pp_partial_no: leader.pp_partial_no,
        card_kind: Number(group?.group_id || 0) > 0 ? 'group' : 'single',
        card_id: group?.group_id || 0,
      })
      : String(blockId);
    if (seen.has(key)) removeIds.push(blockId);
    else seen.add(key);
  });
  return removeIds;
}

async function trialDedupeMachineQueue(machineId) {
  const id = Number(machineId || 0);
  if (!id) return;
  const removeIds = trialDuplicateQueueBlockIds(id);
  if (!removeIds.length) {
    toast('No duplicate queue entries found.', 'info');
    return;
  }
  if (!confirm(
    `Remove ${removeIds.length} duplicate queue ${removeIds.length === 1 ? 'entry' : 'entries'}? The earliest copy of each job is kept.`
  )) {
    return;
  }
  try {
    await trialRunWithPlannerBusy(async () => {
      for (const blockId of removeIds) {
        try {
          await DEL(`/api/trial/blocks/${blockId}`);
        } catch (e) {
          if (!/not found/i.test(String(e.message || ''))) throw e;
        }
      }
      const lane = document.getElementById(`trial-queue-list-${id}`)
        || document.getElementById(`trial-lane-${id}`);
      const orderedIds = (typeof trialLaneOrderedBlockIds === 'function' ? trialLaneOrderedBlockIds(lane) : [])
        .filter(blockId => !removeIds.includes(blockId));
      if (orderedIds.length && typeof postTrialQueueReorder === 'function') {
        const result = await postTrialQueueReorder(
          [{ machine_id: id, ordered_ids: orderedIds }],
          { recalculate: false },
        );
        if (typeof trialMarkDirtyMachines === 'function') trialMarkDirtyMachines([id]);
        await refreshMachines([id], { response: result });
        return;
      }
      if (typeof trialMarkDirtyMachines === 'function') trialMarkDirtyMachines([id]);
      await refreshMachines([id]);
    }, 'Removing duplicates…');
    toast('Duplicate queue entries removed', 'success');
    if (trialOpenQueueMachineId === id) openTrialMachineQueue(id);
  } catch (e) {
    toast('Could not remove duplicates: ' + e.message, 'error');
    await loadTrial();
  }
}

function trialRemoveBlockPsLabel(block) {
  if (!block) return '';
  if (typeof trialBlockPsDisplay === 'function') {
    const ps = trialBlockPsDisplay(null, block);
    const base = String(ps?.base || '').trim();
    if (!base) return '';
    const partial = String(ps?.partial || '').trim();
    return partial ? `${base} P${partial}` : base;
  }
  const raw = String(block.source_ps_id || block.job_no || '').trim();
  if (!raw) return '';
  if (typeof trialSplitPsId === 'function') {
    const parts = trialSplitPsId(raw);
    const base = String(parts?.base || '').trim();
    if (!base) return raw.split('::')[0] || raw;
    const partial = String(parts?.partial || '').trim();
    return partial && partial !== '1' ? `${base} P${partial}` : base;
  }
  const split = raw.split('::');
  return split.length > 1 && split[1] && split[1] !== '1'
    ? `${split[0]} P${split[1]}`
    : (split[0] || raw);
}

async function removeTrialBlock(blockId, groupId) {
  const numericBlockId = Number(blockId || 0);
  if (!numericBlockId) return;
  if (removeTrialBlock._inFlight) return;
  const _rmBlock = (trialState.blocks || []).find(b => String(b.block_id) === String(numericBlockId));
  const psLabel = trialRemoveBlockPsLabel(_rmBlock);
  const psPart = psLabel ? ` (process sheet ${psLabel})` : '';
  const isCombined = Number(groupId || 0) > 0;
  const msg = isCombined
    ? `Remove this combined operation${psPart} from the machine? All ops in the group will be returned to the side panel.`
    : `Remove this operation${psPart} from the machine? It will return to the side panel for re-allocation.`;
  if (!confirm(msg)) return;
  const _rmMachineId = _rmBlock ? Number(_rmBlock.machine_id || 0) : 0;
  const queueRow = document.querySelector(`.trial-queue-row[data-block-id="${numericBlockId}"]`);

  removeTrialBlock._inFlight = true;
  try {
    await trialRunWithPlannerBusy(async () => {
      trialSetFormModalBusy('Removing from queue…');
      queueRow?.classList.add('is-removing');
      try {
        await DEL(`/api/trial/blocks/${numericBlockId}`);
      } catch (e) {
        if (!/not found/i.test(String(e.message || ''))) throw e;
      }
      queueRow?.remove();
      await refreshMachines([_rmMachineId].filter(Boolean));
    }, 'Removing from queue…');
    if (typeof closeModal === 'function') closeModal();
    toast('Removed from machine — returned to side panel', 'success');
  } catch (e) {
    queueRow?.classList.remove('is-removing');
    toast('Remove failed: ' + e.message, 'error');
  } finally {
    removeTrialBlock._inFlight = false;
    trialClearFormModalBusy();
  }
}
