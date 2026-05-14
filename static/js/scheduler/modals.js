// Modal helpers, block editors, capacity modal, and queue reorder.

function trialModalShell(html) {
  const shell = document.getElementById('trial-modal-shell');
  shell.innerHTML = html;
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
        anchor_datetime: document.getElementById('trial-anchor-datetime').value,
        remarks: document.getElementById('trial-remarks').value,
      });
      closeModal();
      await loadTrial();
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
      <label>Anchor Datetime <input id="trial-edit-anchor-datetime" type="datetime-local" value="${String(block.anchor_datetime || '').replace(' ', 'T').slice(0, 16)}"></label>
      <label class="full">Remarks <textarea id="trial-edit-remarks" rows="3">${block.remarks || ''}</textarea></label>
    </div>
  `, 'Save', async () => {
    try {
      await PUT(`/api/trial/blocks/${block.block_id}`, {
        job_no: document.getElementById('trial-edit-job-no').value,
        operation_name: document.getElementById('trial-edit-operation-name').value,
        total_qty: Number(document.getElementById('trial-edit-total-qty').value || 0),
        scheduled_qty: Number(document.getElementById('trial-edit-scheduled-qty').value || 0),
        setup_minutes: Number(document.getElementById('trial-edit-setup-minutes').value || 0),
        cycle_minutes_per_qty: Number(document.getElementById('trial-edit-cycle-minutes').value || 0),
        machine_id: Number(document.getElementById('trial-edit-machine-id').value || 0),
        queue_position: Number(document.getElementById('trial-edit-queue-position').value || 1),
        include_setup: document.getElementById('trial-edit-include-setup').value === '1',
        anchor_datetime: document.getElementById('trial-edit-anchor-datetime').value,
        remarks: document.getElementById('trial-edit-remarks').value,
      });
      closeModal();
      await loadTrial();
      toast('Run block updated', 'success');
    } catch (e) {
      toast('Update failed: ' + e.message, 'error');
    }
  }, `<button type="button" class="btn btn-ghost btn-sm" id="trial-delete-block">Delete</button>`);
  setTimeout(() => {
    document.getElementById('trial-delete-block')?.addEventListener('click', async () => {
      if (!confirm(`Delete ${block.job_no} - ${block.operation_name}?`)) return;
      try {
        await DEL(`/api/trial/blocks/${block.block_id}`);
        closeModal();
        await loadTrial();
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
  openTrialForm('Split Run Block', `
    <div class="trial-modal-grid">
      <label class="full">Split quantity for <strong>${block.job_no} - ${block.operation_name}</strong>
        <input id="trial-split-qty" type="number" min="1" step="1" value="${Math.max(1, Math.floor(Number(block.scheduled_qty || 0) / 2))}">
      </label>
    </div>
  `, 'Split', async () => {
    try {
      await POST(`/api/trial/blocks/${block.block_id}/split`, {
        split_qty: Number(document.getElementById('trial-split-qty').value || 0),
      });
      closeModal();
      await loadTrial();
      toast('Block split', 'success');
    } catch (e) {
      toast('Split failed: ' + e.message, 'error');
    }
  });
}

function openTrialCapacityModal(startDate = '', dayCount = 14) {
  const referenceMachineId = (trialState.machines && trialState.machines[0] && trialState.machines[0].machine_id)
    ? trialState.machines[0].machine_id : 0;
  const capMap = trialCapacityByKey();
  const days = Math.max(1, Number(dayCount || 14));
  const start = startDate || trialTodayLocal();
  const rows = [];
  for (let i = 0; i < days; i += 1) {
    const workDate = trialShiftDate(start, i);
    const cap = capMap.get(trialCapacityKey(referenceMachineId, workDate)) || {};
    const defaultProfile = trialDefaultProfileNameForDate(workDate);
    rows.push(`
      <div class="trial-capacity-row">
        <label>${workDate}</label>
        <select id="trial-cap-profile-${workDate}">
          ${trialProfileOptions(cap.profile_name || defaultProfile)}
        </select>
        <input id="trial-cap-note-${workDate}" type="text" value="${cap.note ? String(cap.note).replace(/"/g, '&quot;') : ''}" placeholder="Note">
        <button class="btn btn-ghost btn-sm" type="button" onclick="saveTrialCapacity('${workDate}', document.getElementById('trial-cap-profile-${workDate}').value, document.getElementById('trial-cap-note-${workDate}').value)">Save</button>
      </div>
    `);
  }
  const bodyHtml = `
    <div class="trial-capacity-modal">
      <div class="trial-capacity-modal-head">
        <div>
          <div style="font-size:18px;font-weight:900;letter-spacing:-0.03em">Shop Calendar</div>
          <div style="font-size:12px;color:var(--text3)">Shared across all machines</div>
        </div>
        <div style="font-size:12px;color:var(--text3);max-width:260px;text-align:right">
          Set the daily profile here. The same calendar is applied to every machine in the trial scheduler.
        </div>
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
}

function editTrialAnchor(blockId) {
  const block = trialState.blocks.find(item => String(item.block_id) === String(blockId));
  if (!block) return;
  openTrialForm('Set Anchor', `
    <div class="trial-modal-grid">
      <label class="full">Anchor Datetime <input id="trial-anchor-input" type="datetime-local" value="${String(block.anchor_datetime || '').replace(' ', 'T').slice(0, 16)}"></label>
    </div>
  `, 'Save', async () => {
    try {
      await PUT(`/api/trial/blocks/${block.block_id}`, {
        anchor_datetime: document.getElementById('trial-anchor-input').value,
      });
      closeModal();
      await loadTrial();
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
    await PUT(`/api/trial/blocks/${block.block_id}`, { include_setup: Number(block.include_setup || 0) === 1 ? 0 : 1 });
    await loadTrial();
  } catch (e) {
    toast('Setup toggle failed: ' + e.message, 'error');
  }
}

async function saveTrialCapacity(workDate, profileName, note = '') {
  try {
    await POST('/api/trial/capacity', {
      work_date: workDate,
      profile_name: profileName,
      note: note,
    });
    await loadTrial();
    toast(`Capacity saved for ${workDate}`, 'success');
  } catch (e) {
    toast('Capacity save failed: ' + e.message, 'error');
  }
}

async function saveTrialOrder(lane, reload = true) {
  const cards = Array.from(lane.querySelectorAll('.trial-block-card'));
  const machineId = Number(lane.dataset.machineId || 0);
  if (!machineId) return;
  const orderedIds = cards.map(card => Number(card.dataset.blockId));
  if (!orderedIds.length) return;
  try {
    await POST(`/api/trial/blocks/${orderedIds[0]}/reorder`, {
      machine_id: machineId,
      ordered_ids: orderedIds,
    });
    if (reload) {
      await loadTrial();
      toast('Queue order saved', 'success');
    }
  } catch (e) {
    toast('Reorder failed: ' + e.message, 'error');
  }
}

async function toggleTrialCompletedCatalog() {
  trialShowCompleted = !trialShowCompleted;
  await loadTrial();
}
