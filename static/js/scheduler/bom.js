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

function trialCatalogItemForBOMEditor(psId) {
  const requested = String(psId || '');
  const requestedBase = requested.split('::')[0] || requested;
  return [].concat(trialState.catalog || [], trialState.planned || []).find(item => {
    const itemPsId = String(item.ps_id || '');
    const itemBase = itemPsId.split('::')[0] || itemPsId;
    return itemPsId === requested || itemBase === requestedBase;
  }) || null;
}

function trialBOMStepsFromCatalogItem(item) {
  const cards = Array.isArray(item?.all_ops) && item.all_ops.length
    ? item.all_ops
    : (Array.isArray(item?.op_cards) ? item.op_cards : []);
  const seen = new Set();
  return cards.map((card, idx) => {
    const opNo = String(card.source_op_no || card.op_no || card.operation_label || '').trim();
    const opName = String(card.op_type || card.operation_name || '').trim();
    const opType = opNo
      ? opName.replace(new RegExp(`^${trialEscapeRegExp(opNo)}\\s*[-: ]*`, 'i'), '').trim() || opName
      : opName;
    const key = `${opNo}|${opType}|${card.source_op_seq_id || ''}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      op_no: opNo || String((idx + 1) * 10),
      op_type: opType || opName || opNo,
      machine_category: card.compatible_machine_group || card.machine_category || '',
      preferred_machine: card.preferred_machine || card.machine_code || '',
      cycle_time: Number(card.cycle_minutes_per_qty || card.cycle_time || 20),
      setup_time: Number(card.setup_minutes || card.setup_time || 180),
      is_last_op: idx === cards.length - 1 ? 1 : 0,
      source_kind: 'ERP',
      op_seq_id: Number(card.source_op_seq_id || card.op_seq_id || 0) || null,
      source_stage_no: Number(card.source_stage_no || card.stage_no || 0) || null,
    };
  }).filter(step => step && String(step.op_type || '').trim());
}

async function openTrialBOMEditor(psId) {
  try {
    const ps = await GET(`/api/trial/process-sheets/${encodeURIComponent(psId)}`);
    const inventoryCode = String(ps.inventory_code || ps.part_no || '').trim();
    if (!inventoryCode) {
      toast('No inventory code found for this PS', 'error');
      return;
    }
    const flows = await GET(`/api/trial/inventory/${encodeURIComponent(inventoryCode)}/flows`);
    const basePsId = String(ps.ps_id || psId || '').split('::')[0] || ps.ps_id || psId;
    const selectedFlowId = Number(ps.selected_bom_id || 0);
    const flow = flows.find(item => Number(item.bom_id) === selectedFlowId) ||
                 flows.find(item => item.is_default) ||
                 flows[0];
    const catalogItem = trialCatalogItemForBOMEditor(psId);
    const fallbackSteps = (!flow || !(flow.steps || []).length)
      ? trialBOMStepsFromCatalogItem(catalogItem)
      : [];
    const hasPlannerFlow = !!flow;
    const hasFallbackSteps = fallbackSteps.length > 0;
    trialBOMMeta = {
      bom_id: Number(flow?.bom_id || 0),
      flow_code: flow?.flow_code || catalogItem?.erp_bom_code || catalogItem?.selected_bom_code || catalogItem?.selected_flow_code || catalogItem?.bom_code || 'MANUAL',
      source_kind: String(flow?.source_kind || '').trim().toUpperCase(),
      is_default: flow ? !!flow.is_default : true,
      ps_id: ps.ps_id,
      inventory_code: inventoryCode,
      part_name: ps.part_name || ps.part_no || '',
      part_desc: ps.part_desc || '',
    };
    trialBOMEditing = hasFallbackSteps
      ? fallbackSteps.map(step => ({ ...step }))
      : (flow?.steps || []).map(step => ({ ...step }));
    const stageHint = hasPlannerFlow
      ? ''
      : (hasFallbackSteps
        ? '<div style="font-size:12px;color:var(--text3);font-weight:700">Loaded ERP stages from this PS. Save BOM to persist them for planning.</div>'
        : '<div style="font-size:12px;color:var(--text3);font-weight:700">No ERP BOM stages found. Add manual stages below.</div>');
    openModal('Edit BOM', `
      <div style="display:grid;gap:12px">
        <div style="display:grid;gap:4px">
          <div style="font-size:18px;font-weight:900;letter-spacing:-0.03em">${escapeHtml(trialBOMMeta.part_name || basePsId)}</div>
          <div style="font-size:12px;color:var(--text3);line-height:1.35">${escapeHtml(trialBOMMeta.part_desc || 'No description')}</div>
          <div style="font-size:12px;color:var(--text3);font-weight:700">PS No: ${escapeHtml(basePsId)}</div>
          ${stageHint}
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

function trialBOMStepSourceLabel(step) {
  const kind = String(step.source_kind || '').toUpperCase();
  if (kind === 'MANUAL') return 'Manual';
  if (kind === 'ERP') return 'ERP';
  return step.op_seq_id ? 'ERP' : 'Manual';
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
        <div class="field field-source">
          <label>Source</label>
          <span class="trial-bom-source-badge">${escapeHtml(trialBOMStepSourceLabel(step))}</span>
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
        <div class="field field-remove">
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
  trialBOMEditing.forEach(step => { step.is_last_op = 0; });
  trialBOMEditing.push({
    op_no: nextOp,
    op_type: 'Turning',
    machine_category: '',
    preferred_machine: '',
    cycle_time: 1,
    setup_time: 0,
    is_last_op: 1,
    source_kind: 'MANUAL',
  });
  renderTrialBOMEditor();
}

function removeTrialBOMStep(idx) {
  trialBOMEditing.splice(idx, 1);
  if (trialBOMEditing.length) {
    trialBOMEditing.forEach((step, i) => {
      step.is_last_op = i === trialBOMEditing.length - 1 ? 1 : 0;
    });
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
      const explicitKind = String(step.source_kind || '').trim().toUpperCase();
      const hasErpLink = Number(step.source_stage_no || 0) > 0 || Number(step.op_seq_id || 0) > 0;
      const sourceKind = explicitKind === 'MANUAL' && !hasErpLink
        ? 'MANUAL'
        : (explicitKind === 'ERP' || hasErpLink ? 'ERP' : 'MANUAL');
      return {
        ...step,
        preferred_machine: preferredMachine,
        machine_category: preferredMachine ? trialMachineCategoryFor(preferredMachine) : 'UNKNOWN',
        is_last_op: idx === trialBOMEditing.length - 1 ? 1 : 0,
        source_kind: sourceKind,
      };
    });
    const payload = {
      flow_code: document.getElementById('trial-bom-flow-code').value,
      is_default: document.getElementById('trial-bom-flow-default').value === '1',
      steps,
    };
    let savedFlowId = Number(trialBOMMeta.bom_id || 0);
    let saveResult = null;
    if (savedFlowId > 0) {
      saveResult = await PUT(`/api/trial/flows/${savedFlowId}`, payload);
      savedFlowId = Number(saveResult?.bom_id || saveResult?.flow?.bom_id || savedFlowId);
    } else {
      saveResult = await POST(`/api/trial/process-sheets/${encodeURIComponent(psId)}/flows`, {
        ...payload,
        source_kind: steps.some(step => String(step.source_kind || '').toUpperCase() === 'MANUAL') ? 'MIXED' : 'MANUAL',
      });
      savedFlowId = Number(saveResult?.flow?.bom_id || 0);
    }
    if (savedFlowId > 0) {
      await PUT(`/api/trial/process-sheets/${encodeURIComponent(psId)}/flow`, { bom_id: savedFlowId });
    }
    closeModal();
    if (typeof trialInvalidateCatalogCache === 'function') trialInvalidateCatalogCache();
    if (typeof trialRefreshCatalogSidebar === 'function') {
      await trialRefreshCatalogSidebar();
    } else if (typeof loadTrial === 'function') {
      await loadTrial({ force: true });
    }
    const forked = !!saveResult?.forked;
    const flowLabel = String(saveResult?.flow_code || payload.flow_code || '').trim();
    toast(
      forked
        ? `Saved planner BOM variation ${flowLabel || ''} (ERP route unchanged)`
        : `BOM saved for ${psId}`,
      'success',
    );
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
