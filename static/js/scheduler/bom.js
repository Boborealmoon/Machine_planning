// BOM / flow editor — open, render, edit, save.

function trialBOMMachineOptions(selected) {
  return [''].concat(
    (trialState.machines || []).map(m => String(m.machine_code || ''))
  ).filter((v, i, arr) => arr.indexOf(v) === i).map(code => {
    if (!code) return `<option value="" ${!selected ? 'selected' : ''}>Select machine</option>`;
    const machine = (trialState.machines || []).find(m => String(m.machine_code || '') === code);
    const label = machine ? `${machine.machine_code} (${machine.machine_category || 'UNKNOWN'})` : code;
    return `<option value="${escapeHtml(code)}" ${String(selected || '') === code ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

function trialMachineCategoryFor(machineCode) {
  const machine = (trialState.machines || []).find(m => String(m.machine_code || '') === String(machineCode || ''));
  return machine ? String(machine.machine_category || '').toUpperCase() : 'UNKNOWN';
}

async function openTrialBOMEditor(psId) {
  try {
    const ps = await GET(`/api/trial/process-sheets/${encodeURIComponent(psId)}`);
    const flows = await GET(`/api/trial/parts/${ps.part_id}/flows`);
    const basePsId = String(ps.ps_id || psId || '').split('::')[0] || ps.ps_id || psId;
    const selectedFlowId = Number(ps.selected_bom_id || 0);
    const flow = flows.find(item => Number(item.bom_id) === selectedFlowId) ||
                 flows.find(item => item.is_default) ||
                 flows[0];
    if (!flow) {
      toast('No flow found for this PS', 'error');
      return;
    }
    trialBOMMeta = {
      bom_id: Number(flow.bom_id),
      flow_code: flow.flow_code || `FLOW-${flow.bom_id}`,
      is_default: !!flow.is_default,
      ps_id: ps.ps_id,
      part_name: ps.part_name || ps.part_no || '',
      part_desc: ps.part_desc || '',
    };
    trialBOMEditing = (flow.steps || []).map(step => ({ ...step }));
    openModal('Edit BOM', `
      <div style="display:grid;gap:12px">
        <div style="display:grid;gap:4px">
          <div style="font-size:18px;font-weight:900;letter-spacing:-0.03em">${escapeHtml(trialBOMMeta.part_name || basePsId)}</div>
          <div style="font-size:12px;color:var(--text3);line-height:1.35">${escapeHtml(trialBOMMeta.part_desc || 'No description')}</div>
          <div style="font-size:12px;color:var(--text3);font-weight:700">PS No: ${escapeHtml(basePsId)}</div>
        </div>
        <div class="trial-modal-grid">
          <label>BOM Code <input id="trial-bom-flow-code" value="${escapeHtml(trialBOMMeta.flow_code)}"></label>
          <label>Default
            <select id="trial-bom-flow-default">
              <option value="0" ${trialBOMMeta.is_default ? '' : 'selected'}>No</option>
              <option value="1" ${trialBOMMeta.is_default ? 'selected' : ''}>Yes</option>
            </select>
          </label>
        </div>
        <div id="trial-bom-editor"></div>
        <button type="button" class="btn btn-ghost btn-sm" onclick="addTrialBOMStep()">Add Step</button>
        <div class="trial-modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" id="trial-bom-cancel">Cancel</button>
          <button type="button" class="btn btn-primary btn-sm" id="trial-bom-save">Save BOM</button>
        </div>
      </div>
    `, 'xl');
    setTimeout(() => {
      document.getElementById('trial-bom-cancel')?.addEventListener('click', closeModal);
      document.getElementById('trial-bom-save')?.addEventListener('click', () => saveTrialBOMEditor(ps.ps_id));
      renderTrialBOMEditor();
    }, 0);
  } catch (e) {
    toast('Edit BOM failed: ' + e.message, 'error');
  }
}

function renderTrialBOMEditor() {
  const el = document.getElementById('trial-bom-editor');
  if (!el) return;
  el.innerHTML = trialBOMEditing.map((step, idx) => `
    <div class="trial-bom-step" draggable="true" data-idx="${idx}">
      <div class="field-row">
        <div class="field field-handle">
          <label>&nbsp;</label>
          <div class="trial-bom-handle" title="Drag to reorder">::</div>
        </div>
        <div class="field field-op-no">
          <label>Op No</label>
          <input value="${escapeHtml(step.op_no || '')}" onchange="editTrialBOMStep(${idx}, 'op_no', this.value)">
        </div>
        <div class="field field-op-type">
          <label>Op Type</label>
          <input value="${escapeHtml(step.op_type || '')}" onchange="editTrialBOMStep(${idx}, 'op_type', this.value)">
        </div>
        <div class="field field-machine">
          <label>Preferred Machine</label>
          <select onchange="editTrialBOMStep(${idx}, 'preferred_machine', this.value)">
            ${trialBOMMachineOptions(step.preferred_machine || '')}
          </select>
        </div>
        <div class="field field-cycle">
          <label>Cycle Time</label>
          <input type="number" step="0.1" min="0" value="${Number(step.cycle_time || 1)}"
            onchange="editTrialBOMStep(${idx}, 'cycle_time', parseFloat(this.value) || 1)">
        </div>
        <div class="field field-setup">
          <label>Setup Time</label>
          <input type="number" step="1" min="0" value="${Number(step.setup_time || 0)}"
            onchange="editTrialBOMStep(${idx}, 'setup_time', parseFloat(this.value) || 0)">
        </div>
        <div class="field" style="flex:0 0 auto;min-width:auto">
          <label>&nbsp;</label>
          <button class="btn btn-ghost btn-sm" type="button" onclick="removeTrialBOMStep(${idx})">Remove</button>
        </div>
      </div>
    </div>
  `).join('');
  makeSortable(el, () => {
    const reordered = [];
    el.querySelectorAll('.trial-bom-step[data-idx]').forEach(stepEl => {
      reordered.push(trialBOMEditing[parseInt(stepEl.dataset.idx, 10)]);
    });
    trialBOMEditing = reordered;
    renderTrialBOMEditor();
  });
}

function editTrialBOMStep(idx, field, value) {
  if (!trialBOMEditing[idx]) return;
  trialBOMEditing[idx][field] = value;
  if (field === 'preferred_machine') {
    trialBOMEditing[idx].machine_category = value ? trialMachineCategoryFor(value) : 'UNKNOWN';
    renderTrialBOMEditor();
  }
}

function addTrialBOMStep() {
  const nextOp = trialBOMEditing.length
    ? String((parseInt(trialBOMEditing[trialBOMEditing.length - 1].op_no, 10) || trialBOMEditing.length * 10) + 10)
    : '10';
  trialBOMEditing.push({
    op_no: nextOp,
    op_type: '',
    machine_category: '',
    preferred_machine: '',
    cycle_time: 1,
    setup_time: 0,
    is_last_op: trialBOMEditing.length === 0 ? 1 : 0,
  });
  renderTrialBOMEditor();
}

function removeTrialBOMStep(idx) {
  trialBOMEditing.splice(idx, 1);
  if (trialBOMEditing.length && !trialBOMEditing.some(step => Number(step.is_last_op || 0) === 1)) {
    trialBOMEditing[trialBOMEditing.length - 1].is_last_op = 1;
  }
  renderTrialBOMEditor();
}

async function saveTrialBOMEditor(psId) {
  if (trialBOMEditing.some(step => !String(step.op_type || '').trim())) {
    toast('Operation type is required', 'error');
    return;
  }
  try {
    const steps = trialBOMEditing.map((step, idx) => {
      const preferredMachine = String(step.preferred_machine || '').trim();
      return {
        ...step,
        preferred_machine: preferredMachine,
        machine_category: preferredMachine ? trialMachineCategoryFor(preferredMachine) : 'UNKNOWN',
        is_last_op: idx === trialBOMEditing.length - 1 ? 1 : 0,
      };
    });
    await PUT(`/api/trial/flows/${trialBOMMeta.bom_id}`, {
      flow_code: document.getElementById('trial-bom-flow-code').value,
      is_default: document.getElementById('trial-bom-flow-default').value === '1',
      steps,
    });
    closeModal();
    await loadTrial();
    toast(`BOM saved for ${psId}`, 'success');
  } catch (e) {
    toast('Save BOM failed: ' + e.message, 'error');
  }
}

async function setTrialSelectedFlow(psId, flowCode) {
  const code = String(flowCode || '').trim();
  if (!code) return;
  try {
    await PUT(`/api/trial/process-sheets/${encodeURIComponent(psId)}/flow`, { flow_code: code });
    await loadTrial();
    toast(`Flow updated for ${psId}`, 'success');
  } catch (e) {
    toast('Flow update failed: ' + e.message, 'error');
  }
}
