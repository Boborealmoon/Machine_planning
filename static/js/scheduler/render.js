// All DOM-rendering functions for the scheduler board and catalog.

function fmt(value, decimals) {
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function trialMaterialStatusClass(status) {
  const severity = String(status?.severity || '').toLowerCase();
  if (severity === 'pending') return 'material-pending';
  if (severity === 'late') return 'material-late';
  if (severity === 'warning') return 'material-warning';
  return '';
}

function trialProfileOptions(selected) {
  return (trialState.profiles || []).map(profile => {
    const sel = String(profile.profile_name) === String(selected) ? 'selected' : '';
    return `<option value="${profile.profile_name}" ${sel}>${profile.profile_name} (${profile.capacity_minutes}m)</option>`;
  }).join('');
}

function trialBlockPsDisplay(group, leader) {
  const candidates = [leader?.job_no, group?.ps_id, leader?.source_ps_id]
    .map(v => String(v || '').trim())
    .filter(Boolean);
  const raw = candidates.find(v => v.includes('::')) || candidates[0] || '';
  const parsed = trialSplitPsId(raw);
  return { base: parsed.base || raw, partial: parsed.partial || '' };
}

function trialBlockOpDisplay(leader) {
  const opNo = String(leader?.source_op_no || '').trim();
  const opNameRaw = String(leader?.operation_name || '').trim();
  const cleanName = opNo
    ? opNameRaw.replace(new RegExp(`^${trialEscapeRegExp(opNo)}\\s*[-: ]*`, 'i'), '').trim()
    : opNameRaw;
  return { op_no: opNo ? `OP${opNo}` : '', op_name: cleanName || opNameRaw || '' };
}

function trialFlowSelectHtml(ps) {
  const flows = Array.isArray(ps.flow_options) ? ps.flow_options : [];
  const selectedFlowCode = String(ps.selected_bom_code || ps.selected_flow_code || '');
  const options = [];
  if (!flows.length) {
    options.push('<option value="">No BOM code available</option>');
  } else {
    options.push('<option value="">Select BOM code</option>');
    flows.forEach(flow => {
      const code = String(flow.bom_code || flow.flow_code || '');
      const label = `${code}${flow.is_default ? ' (default)' : ''}`;
      options.push(`<option value="${escapeHtml(code)}" ${code === selectedFlowCode ? 'selected' : ''}>${escapeHtml(label)}</option>`);
    });
  }
  const label = selectedFlowCode || '';
  return `
    <label style="display:grid;gap:4px;justify-items:end">
      <span class="trial-catalog-section-note">BOM Code${label ? ` · ${escapeHtml(label)}` : ''}</span>
      <select class="trial-catalog-flow-select" data-ps-id="${escapeHtml(ps.ps_id || '')}"
        ${flows.length ? '' : 'disabled'}
        onchange="setTrialSelectedFlow(this.dataset.psId, this.value)">
        ${options.join('')}
      </select>
    </label>
  `;
}

function trialOpQtyLabel(op) {
  const remaining = Number(op.remaining_qty || op.total_qty || 0);
  const planned = Number(op.planned_qty || 0);
  const required = Number(op.required_qty || (planned + remaining) || 0);
  if (required <= 0) return '';
  if (planned > 0) return `Qty ${fmt(remaining, 0)} remaining of ${fmt(required, 0)}`;
  return `Qty ${fmt(remaining, 0)}`;
}

// ── PS type helpers ───────────────────────────────────────────────────────────

const _PS_TYPES = [
  { key: 'A', label: 'Aerospace' },
  { key: 'M', label: 'MRO' },
  { key: 'N', label: 'Non-Aerospace' },
];

function trialGetPsType(psId) {
  return String(psId || '').trim().toUpperCase()[0] || '?';
}

function renderTrialPsTypeFilter() {
  const shell = document.getElementById('trial-ps-type-filter');
  if (!shell) return;
  const checkboxes = _PS_TYPES.map(t => {
    const checked = trialPsTypeFilter.has(t.key);
    return `
      <label class="trial-ps-type-checkbox trial-ps-type-${t.key.toLowerCase()}">
        <input type="checkbox" ${checked ? 'checked' : ''}
          onchange="toggleTrialPsTypeFilter('${t.key}', this.checked)">
        <span>${escapeHtml(t.label)}</span>
      </label>`;
  }).join('');
  shell.innerHTML = `
    <div class="trial-ps-type-filter-row">
      ${checkboxes}
      <div class="trial-machine-checkbox-actions">
        <button type="button" class="trial-machine-toggle-btn" onclick="setAllTrialPsTypesVisible(true)">All</button>
        <button type="button" class="trial-machine-toggle-btn" onclick="setAllTrialPsTypesVisible(false)">None</button>
      </div>
    </div>
  `;
}

function toggleTrialPsTypeFilter(key, visible) {
  if (visible) trialPsTypeFilter.add(key);
  else trialPsTypeFilter.delete(key);
  renderTrialCatalog();
}

function setAllTrialPsTypesVisible(visible) {
  _PS_TYPES.forEach(t => visible ? trialPsTypeFilter.add(t.key) : trialPsTypeFilter.delete(t.key));
  renderTrialCatalog();
}

// ── Filters ───────────────────────────────────────────────────────────────────

function renderTrialMachineCategoryFilter() {
  const categories = trialMachineCategories();
  const machines = trialMachinesInCategory();

  const machineCheckboxes = machines.map(m => {
    const code = m.machine_code || '';
    const checked = !trialMachineHiddenSet.has(code);
    return `<label class="trial-machine-checkbox">
        <input type="checkbox" ${checked ? 'checked' : ''}
          onchange="toggleTrialMachineFilter('${escapeHtml(code)}', this.checked)">
        <span>${escapeHtml(code)}</span>
      </label>`;
  }).join('');

  return `
    <div class="trial-filter-section">
      <div class="trial-filter-label">Type</div>
      <div class="trial-machine-filter">
        ${categories.map(category => `
          <button type="button"
            class="trial-machine-filter-btn ${trialMachineCategoryFilter === category ? 'active' : ''}"
            onclick="setTrialMachineCategoryFilter('${escapeHtml(category)}')">
            ${escapeHtml(trialMachineCategoryLabel(category))}
          </button>
        `).join('')}
      </div>
    </div>
    ${machines.length > 0 ? `
    <div class="trial-filter-section">
      <div class="trial-filter-label">Machine</div>
      <div class="trial-machine-checkbox-list">
        ${machineCheckboxes}
        <div class="trial-machine-checkbox-actions">
          <button type="button" class="trial-machine-toggle-btn" onclick="setAllTrialMachinesVisible(true)">All</button>
          <button type="button" class="trial-machine-toggle-btn" onclick="setAllTrialMachinesVisible(false)">None</button>
        </div>
      </div>
    </div>
    ` : ''}
  `;
}

function setTrialMachineCategoryFilter(category) {
  trialMachineCategoryFilter = String(category || 'ALL').toUpperCase();
  renderTrial();
}

function toggleTrialMachineFilter(machineCode, visible) {
  if (visible) {
    trialMachineHiddenSet.delete(machineCode);
  } else {
    trialMachineHiddenSet.add(machineCode);
  }
  renderTrial();
}

function setAllTrialMachinesVisible(visible) {
  const machines = trialMachinesInCategory();
  if (visible) {
    machines.forEach(m => trialMachineHiddenSet.delete(m.machine_code));
  } else {
    machines.forEach(m => trialMachineHiddenSet.add(m.machine_code));
  }
  renderTrial();
}

function renderTrialScheduleDateFilter() {
  return `
    <div class="trial-filter-section trial-filter-section-date">
      <div class="trial-filter-label">Date</div>
      <div class="trial-date-filter">
        <label>
          <span>Start</span>
          <input type="date" value="${escapeHtml(trialScheduleDateFilter.start || '')}"
            onchange="setTrialScheduleDateFilter('start', this.value)">
        </label>
        <span class="trial-date-filter-separator">→</span>
        <label>
          <span>End</span>
          <input type="date" value="${escapeHtml(trialScheduleDateFilter.end || '')}"
            onchange="setTrialScheduleDateFilter('end', this.value)">
        </label>
        <button type="button" class="btn btn-ghost btn-sm" onclick="clearTrialScheduleDateFilter()">Clear</button>
      </div>
    </div>
  `;
}

function setTrialScheduleDateFilter(field, value) {
  if (field !== 'start' && field !== 'end') return;
  trialScheduleDateFilter[field] = String(value || '');
  trialScheduleDateFilter = trialNormalizeScheduleDates(trialScheduleDateFilter.start, trialScheduleDateFilter.end);
  trialSyncScheduleUrl();
  renderTrial();
}

function clearTrialScheduleDateFilter() {
  trialScheduleDateFilter = { start: '', end: '' };
  trialSyncScheduleUrl();
  renderTrial();
}

// ── Op card HTML ──────────────────────────────────────────────────────────────

function renderTrialOpCardHtml(card) {
  const cardKind = String(card.card_kind || 'single');
  const isGroup = cardKind === 'group';
  const isScheduled = !!card.is_scheduled;
  const isAllocated = !!card.is_allocated;
  const remainingQty = fmt(card.remaining_qty || 0, 0);
  const setupMinutes = fmt(card.setup_minutes || 0, 0);
  const cycleMinutes = fmt(card.cycle_minutes_per_qty || 0, 0);
  const opName = String(card.operation_name || '').trim();
  const allocatedBlock = isAllocated ? trialAllocatedBlockForOp(card.source_ps_id || card.ps_id, card.source_op_no) : null;
  const allocatedMachineCode = allocatedBlock ? (allocatedBlock.machine_code || '') : '';
  const payload = {
    type: 'op-card',
    card_kind: cardKind,
    card_id: Number(card.card_id || 0) || null,
    ps_id: card.ps_id || '',
    operation_label: card.operation_label || '',
    target_qty: Number(card.target_qty || 0),
    remaining_qty: Number(card.remaining_qty || card.target_qty || 0),
    planning_status: card.planning_status || '',
    card_type: card.card_type || '',
    is_scheduled: isScheduled,
    machine_id: Number(card.machine_id || 0),
    machine_code: card.machine_code || '',
    setup_minutes: Number(card.setup_minutes || 0),
    cycle_minutes_per_qty: Number(card.cycle_minutes_per_qty || 0),
    compatible_machine_group: card.compatible_machine_group || '',
    source_ps_id: card.source_ps_id || card.ps_id || '',
    source_op_seq_id: Number(card.source_op_seq_id || 0),
    source_op_no: card.source_op_no || '',
    job_no: card.job_no || '',
    op_type: card.op_type || '',
    operation_name: card.operation_name || '',
    total_qty: Number(card.total_qty || card.remaining_qty || 0),
  };
  if (cardKind === 'single') {
    payload.op = {
      job_no: payload.job_no,
      operation_name: payload.operation_name,
      op_type: payload.op_type,
      total_qty: payload.total_qty || payload.remaining_qty || 0,
      remaining_qty: payload.remaining_qty || payload.total_qty || 0,
      setup_time: payload.setup_minutes,
      cycle_time: payload.cycle_minutes_per_qty,
      compatible_machine_group: payload.compatible_machine_group,
      source_ps_id: payload.source_ps_id,
      source_op_seq_id: payload.source_op_seq_id,
      source_op_no: payload.source_op_no,
    };
  }
  return `
    <div class="trial-catalog-op trial-planning-card ${isScheduled ? 'is-scheduled' : ''} ${isAllocated ? 'is-allocated' : ''}"
      draggable="false"
      data-trial-payload="${trialPayloadToAttr(payload)}"
      data-card-kind="${escapeHtml(cardKind)}"
      data-card-id="${escapeHtml(card.card_id || '')}"
      data-ps-id="${escapeHtml(card.ps_id || '')}"
      data-operation-label="${escapeHtml(card.operation_label || '')}"
      data-target-qty="${escapeHtml(card.target_qty || 0)}"
      data-remaining-qty="${escapeHtml(card.remaining_qty || 0)}"
      data-planning-status="${escapeHtml(card.planning_status || '')}"
      data-card-type="${escapeHtml(card.card_type || '')}"
      data-is-scheduled="${isScheduled ? 'true' : 'false'}"
      data-machine-id="${escapeHtml(card.machine_id || 0)}"
      data-machine-code="${escapeHtml(card.machine_code || '')}"
      data-setup-minutes="${escapeHtml(card.setup_minutes || 0)}"
      data-cycle-minutes-per-qty="${escapeHtml(card.cycle_minutes_per_qty || 0)}"
      data-compatible-machine-group="${escapeHtml(card.compatible_machine_group || '')}"
      data-source-ps-id="${escapeHtml(card.source_ps_id || card.ps_id || '')}"
      data-source-step-id="${escapeHtml(card.source_op_seq_id || 0)}"
      data-source-op-no="${escapeHtml(card.source_op_no || '')}"
      data-job-no="${escapeHtml(card.job_no || '')}"
      data-op-type="${escapeHtml(card.op_type || '')}"
      data-operation-name="${escapeHtml(card.operation_name || '')}"
      data-total-qty="${escapeHtml(card.total_qty || card.remaining_qty || 0)}"
    >
      <div class="trial-planning-card-head">
        <div class="trial-planning-card-main">
          <div class="trial-planning-card-title">${escapeHtml(card.operation_label || '')}</div>
          <div class="trial-planning-card-sub">${escapeHtml(opName)}</div>
          <div class="trial-planning-card-sub">Remaining ${remainingQty} pcs</div>
          <div class="trial-planning-card-sub">Setup ${setupMinutes}m · Cycle ${cycleMinutes}m/pc</div>
          ${isAllocated
            ? `<div class="trial-allocated-badge">
                <span class="trial-allocated-dot"></span>
                In queue${allocatedMachineCode ? ' · ' + escapeHtml(allocatedMachineCode) : ''}
               </div>`
            : ''}
        </div>
        <div style="display:grid;gap:6px;justify-items:end">
          ${isGroup && !isScheduled
            ? `<button class="btn btn-ghost btn-sm" style="padding:2px 8px;line-height:1;min-height:0" type="button"
                aria-label="Uncombine" title="Uncombine"
                onclick="deleteTrialPlanningCard(${Number(card.card_id || 0)})">Uncombine</button>`
            : ''}
        </div>
      </div>
    </div>
  `;
}

// ── Machine lane ──────────────────────────────────────────────────────────────

function renderTrialMachine(machine) {
  const groups = trialBlocksGroupedForMachine(machine.machine_id).filter(trialGroupRunsInsideDateFilter);
  const laneId = `trial-lane-${machine.machine_id}`;

  const blockHtml = groups.length
    ? groups.map(group => {
        const leader = group.leader;
        const groupBlockIds = group.blocks.map(b => b.block_id).join(',');
        const psDisplay = trialBlockPsDisplay(group, leader);
        const opDisplay = trialBlockOpDisplay(leader);
        const netOutput = trialBlockNetOutput(group.output_qty, group.reject_qty);
        const anchored = !!leader?.anchor_datetime;
        const materialStatus = group.material_status || leader?.material_status || {};
        const materialChipClass = trialMaterialStatusClass(materialStatus);
        const combinedLine = group.blocks.length > 1 ? `${group.blocks.length} ops combined` : '';
        const operationLine = group.blocks.length > 1
          ? String(group.operation_label || group.group_label || '').trim()
          : [opDisplay.op_no, opDisplay.op_name].filter(Boolean).join(' ');
        const pairedOutput = Number(group.paired_output_qty ?? netOutput ?? 0);
        const actualButton = group.blocks.length > 1
          ? `<button class="btn btn-ghost btn-sm" type="button" onclick="openTrialGroupActualModal(${Number(group.group_id || 0)})">Actual</button>`
          : `<button class="btn btn-ghost btn-sm" type="button" onclick="openTrialActualModal(${leader?.block_id || 0})">Actual</button>`;
        return `
          <div class="trial-block-card ${group.blocks.length > 1 ? 'combined' : ''}"
            draggable="true"
            data-block-id="${leader?.block_id || ''}"
            data-group-id="${group.group_id || 0}"
            data-block-ids="${groupBlockIds}">
            <div class="trial-op-card-header">
              <div class="trial-block-top">
                <div class="trial-block-main">
                  <div class="trial-block-title">${escapeHtml(psDisplay.base || group.title || '')}</div>
                  ${psDisplay.partial ? `<div class="trial-block-partial">Partial ${escapeHtml(psDisplay.partial)}</div>` : ''}
                  <div class="trial-block-op">${escapeHtml(operationLine)}</div>
                  <div class="trial-block-qty">Qty ${fmt(group.target_qty || 0, 0)}</div>
                </div>
              </div>
              ${combinedLine ? `<div class="trial-block-combined-line">${escapeHtml(combinedLine)}</div>` : ''}
            </div>
            <div class="trial-op-card-statuses">
              <span class="trial-pill ${trialPlanningStatusClass(group.planning_status)}">Plan ${escapeHtml(group.planning_status || 'UNPLANNED')}</span>
              <span class="trial-pill ${trialStatusClass(group.status)}">Exec ${escapeHtml(group.status)}</span>
            </div>
            <div class="trial-op-card-info">
              <button class="trial-pill trial-pill-start clickable ${anchored ? 'yellow' : 'gray'}" type="button"
                onclick="editTrialAnchor(${leader?.block_id || 0})" title="Click to edit anchor">
                Start ${trialFormatDt(group.visual_start_datetime || group.group_start)}
              </button>
              <span class="trial-pill">End ${trialFormatDt(group.visual_end_datetime || group.group_end)}</span>
              <span class="trial-pill">Output: ${fmt(pairedOutput, 0)}</span>
              ${materialStatus?.label ? `<span class="trial-pill ${materialChipClass}">${escapeHtml(materialStatus.label)}</span>` : ''}
            </div>
            ${group.blocks.length > 1 ? `
              <div class="trial-block-member-progress">
                ${group.member_metrics.map(member => `
                  <div class="trial-block-member-line">
                    <span>${escapeHtml(member.source_op_no || member.operation_name || '')}</span>
                    <span>${fmt(member.netOutput || member.outputTotal || 0, 0)} / ${fmt(member.scheduled_qty || 0, 0)} done</span>
                  </div>
                `).join('')}
              </div>
            ` : ''}
            <div class="trial-op-card-actions">
              <button class="btn btn-ghost btn-sm" type="button" onclick="openTrialBlockEditor(${leader?.block_id || 0})">Edit</button>
              <button class="btn btn-ghost btn-sm" type="button" onclick="openTrialSplitModal(${leader?.block_id || 0})">Split</button>
              ${actualButton}
              <button class="btn btn-ghost btn-sm" type="button" onclick="toggleTrialSetup(${leader?.block_id || 0})">
                ${Number(leader?.include_setup || 0) === 1 ? 'Setup On' : 'Setup Off'}
              </button>
              <button class="btn btn-ghost btn-sm trial-remove-block-btn" type="button"
                onclick="removeTrialBlock(${leader?.block_id || 0}, ${Number(group.group_id || 0)})"
                title="Remove from machine — returns to side panel">Remove</button>
            </div>
          </div>
        `;
      }).join('')
    : `<div class="trial-empty">${escapeHtml(trialHasActiveDateFilter() ? 'No run blocks in this date range.' : 'No run blocks yet for this machine.')}</div>`;

  return `
    <section class="trial-machine">
      <div class="trial-machine-head">
        <div>
          <div class="trial-machine-title">${machine.machine_code}</div>
          <div class="trial-machine-meta">${machine.machine_category} - ${machine.shift_profile || 'STANDARD'}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" type="button" onclick="openTrialCreateModal(${machine.machine_id})">Add</button>
        </div>
      </div>
      <div class="trial-lane" id="${laneId}" data-machine-id="${machine.machine_id}">
        ${blockHtml}
      </div>
    </section>
  `;
}

// ── Main board render ─────────────────────────────────────────────────────────

function renderTrial() {
  destroyTrialSortables();
  const filterShell = document.getElementById('trial-machine-filter-shell');
  if (filterShell) {
    filterShell.innerHTML = `
      <div class="trial-board-filter-card">
        <div class="trial-board-filter-row">
          ${renderTrialMachineCategoryFilter()}
          ${renderTrialScheduleDateFilter()}
        </div>
        ${trialHasActiveDateFilter() ? `<div class="trial-board-filter-note">Date filter active — clear it to reorder.</div>` : ''}
      </div>
    `;
  }
  const grid = document.getElementById('trial-grid');
  const visibleMachines = trialVisibleMachines();
  grid.innerHTML = visibleMachines.length
    ? visibleMachines.map(renderTrialMachine).join('')
    : `<div class="trial-empty">No machines found for ${escapeHtml(trialMachineCategoryFilter)}.</div>`;
  document.getElementById('trial-layout').style.display = 'grid';
  document.getElementById('trial-loading').style.display = 'none';
  updateTrialCompletedButton();
  renderTrialCatalog();
  bindTrialCatalogDnD();
  initTrialMachineSortables();
  bindTrialLaneOpDrops();
}

function trialExecStatusBadge(execStatus) {
  const s = String(execStatus || '').toLowerCase();
  if (s === 'pending si')     return `<span class="exec-badge exec-badge-pending-si">Material pending</span>`;
  if (s === 'ready to start') return `<span class="exec-badge exec-badge-ready">Ready to start</span>`;
  if (s === 'in process')     return `<span class="exec-badge exec-badge-in-process">In Process</span>`;
  if (s === 'completed')      return `<span class="exec-badge exec-badge-completed">Completed</span>`;
  return '';
}

// ── Catalog render ────────────────────────────────────────────────────────────

const _PS_TYPE_ORDER = { A: 0, M: 1, N: 2 };

function renderTrialCatalog() {
  renderTrialPsTypeFilter();
  const root = document.getElementById('trial-catalog');
  if (!root) return;
  const queryInput = document.getElementById('trial-catalog-search');
  const rawQuery = String(queryInput ? queryInput.value : trialCatalogSearch || '').trim().toLowerCase();
  trialCatalogSearch = rawQuery;

  const catalog = (trialState.catalog || []).filter(ps => {
    const psType = trialGetPsType(ps.ps_id);
    if (!trialPsTypeFilter.has(psType)) return false;
    const psStatus = String(ps.status || '').toUpperCase();
    const execStatus = String(ps.execution_status || '').toUpperCase();
    if (!trialShowCompleted) {
      // execution_status is authoritative — only fall back to status when there's no exec signal
      const activeExec = execStatus && execStatus !== 'COMPLETED';
      if (!activeExec && (execStatus === 'COMPLETED' || psStatus === 'HISTORY')) return false;
    }
    if (!rawQuery) return true;
    const haystack = [
      ps.ps_id, ps.part_name, ps.part_no, ps.part_desc, ps.due_date, ps.status, ps.execution_status,
      ...(ps.ops || []).flatMap(op => [op.op_no, op.op_type, op.machine_category, op.preferred_machine, op.source_op_no]),
    ].join(' ').toLowerCase();
    return haystack.includes(rawQuery);
  }).sort((a, b) => {
    const ta = _PS_TYPE_ORDER[trialGetPsType(a.ps_id)] ?? 9;
    const tb = _PS_TYPE_ORDER[trialGetPsType(b.ps_id)] ?? 9;
    return ta !== tb ? ta - tb : String(a.ps_id).localeCompare(String(b.ps_id));
  });

  const plannedCatalog = (trialState.planned || []).filter(ps => {
    const psType = trialGetPsType(ps.ps_id);
    if (!trialPsTypeFilter.has(psType)) return false;
    const psStatus = String(ps.status || '').toUpperCase();
    const plannerStatus = String(ps.planner_status || '').toUpperCase();
    if (!trialShowCompleted && (psStatus === 'COMPLETED' || plannerStatus === 'COMPLETED')) return false;
    if (!rawQuery) return true;
    const haystack = [ps.ps_id, ps.part_name, ps.part_no, ps.part_desc, ps.due_date, ps.status, ps.planner_status].join(' ').toLowerCase();
    return haystack.includes(rawQuery);
  }).sort((a, b) => {
    const ta = _PS_TYPE_ORDER[trialGetPsType(a.ps_id)] ?? 9;
    const tb = _PS_TYPE_ORDER[trialGetPsType(b.ps_id)] ?? 9;
    return ta !== tb ? ta - tb : String(a.ps_id).localeCompare(String(b.ps_id));
  });

  if (!catalog.length && !plannedCatalog.length) {
    root.innerHTML = `<div class="trial-catalog-empty">No available PS / ops match this search.</div>`;
    return;
  }

  const allocatedKeys = trialAllocatedOpKeys();

  const availableHtml = catalog.map(ps => {
    const psIdParts = String(ps.ps_id || '').split('::');
    const basePsId = psIdParts[0] || ps.ps_id || '';
    const partialText = psIdParts[1] ? `Partial ${psIdParts[1]}` : '';
    const opCardsHtml = (ps.op_cards || []).map(card => {
      const psId = String(card.source_ps_id || card.ps_id || '').trim();
      const opNo = String(card.source_op_no || '').trim();
      const isAllocated = psId && opNo && allocatedKeys.has(`${psId}||${opNo}`);
      return renderTrialOpCardHtml({ ...card, is_allocated: isAllocated });
    }).join('');
    return `
      <details class="trial-catalog-ps" ${rawQuery ? 'open' : ''}
        data-ps-id="${escapeHtml(ps.ps_id || '')}"
        data-base-ps-id="${escapeHtml(basePsId)}"
        data-partial-text="${escapeHtml(partialText)}"
        data-part-name="${escapeHtml(ps.part_no || ps.part_name || '')}"
        data-inv-desc="${escapeHtml(ps.part_desc || '')}"
        data-due-date="${escapeHtml(ps.due_date || '')}"
        data-exec-status="${escapeHtml(ps.execution_status || '')}">
        <summary></summary>
        <div class="trial-catalog-bom-bar">
          ${trialFlowSelectHtml(ps)}
          <button class="btn btn-ghost btn-sm trial-catalog-bom-btn" type="button"
            onclick="openTrialBOMEditor('${escapeHtml(ps.ps_id)}')">Edit BOM</button>
        </div>
        <div class="trial-catalog-oplist">${opCardsHtml}</div>
      </details>
    `;
  }).join('');

  const plannedHtml = plannedCatalog.map(ps => `
    <div class="trial-catalog-ps trial-catalog-planned-ps" data-ps-id="${escapeHtml(ps.ps_id || '')}">
      <div class="trial-catalog-planned-head">
        <div class="trial-catalog-ps-main">
          <div class="trial-catalog-ps-id">${escapeHtml(String(ps.ps_id || '').split('::')[0] || ps.ps_id || '')}</div>
          <div class="trial-catalog-ps-part">${escapeHtml(ps.part_name || 'Part No')}</div>
          ${ps.part_desc ? `<div class="trial-catalog-ps-desc">${escapeHtml(ps.part_desc)}</div>` : ''}
        </div>
        <div class="trial-catalog-planned-right">
          <span class="trial-catalog-planned-badge">Planned</span>
          <span class="trial-catalog-ps-meta trial-catalog-ps-date">${escapeHtml(ps.due_date || 'No due date')}</span>
        </div>
      </div>
      <div class="trial-catalog-bom-bar">
        ${trialFlowSelectHtml(ps)}
        <button class="btn btn-ghost btn-sm trial-catalog-bom-btn" type="button"
          onclick="openTrialBOMEditor('${escapeHtml(ps.ps_id)}')">Edit BOM</button>
      </div>
      <div class="trial-catalog-oplist">
        ${(ps.op_cards || []).map(card => {
          const psId = String(card.source_ps_id || card.ps_id || '').trim();
          const opNo = String(card.source_op_no || '').trim();
          const isAllocated = psId && opNo && allocatedKeys.has(`${psId}||${opNo}`);
          return renderTrialOpCardHtml({ ...card, is_allocated: isAllocated });
        }).join('')}
      </div>
    </div>
  `).join('');

  root.innerHTML = `
    <div class="trial-catalog-section">
      <div class="trial-catalog-section-head">
        <div class="trial-catalog-section-title">Operations</div>
        <div class="trial-catalog-section-note">Drag one op onto another op in the same PS to combine it. Drag an op card to a machine lane to schedule it.</div>
      </div>
      <div class="trial-catalog-section-body">
        ${availableHtml || `<div class="trial-catalog-empty">No available PS / ops match this search.</div>`}
      </div>
    </div>
    <div class="trial-catalog-section">
      <div class="trial-catalog-section-head">
        <div class="trial-catalog-section-title">Other PS</div>
        <div class="trial-catalog-section-note">Any op cards on these sheets render inline the same way.</div>
      </div>
      <div class="trial-catalog-section-body">
        ${plannedHtml || `<div class="trial-catalog-empty">No other PS match this search.</div>`}
      </div>
    </div>
  `;
  decorateTrialCatalogCards();
  bindTrialCatalogDnD();
}

function decorateTrialCatalogCards() {
  document.querySelectorAll('.trial-catalog-ps').forEach(card => {
    const summary = card.querySelector('summary');
    if (!summary) return;
    const basePsId = card.dataset.basePsId || '';
    const partialText = card.dataset.partialText || '';
    const dueDate = card.dataset.dueDate || 'No due date';
    const execStatus = card.dataset.execStatus || '';
    const dayDiff = trialDateDiffDays(dueDate);
    card.classList.remove('overdue', 'due-soon');
    if (dayDiff != null) {
      if (dayDiff < 0) card.classList.add('overdue');
      else if (dayDiff <= 7) card.classList.add('due-soon');
    }
    summary.innerHTML = `
      <div class="trial-catalog-ps-main">
        <div class="trial-catalog-ps-id">${escapeHtml(basePsId)}</div>
        ${partialText ? `<div class="trial-catalog-ps-partial">${escapeHtml(partialText)}</div>` : ''}
        <div class="trial-catalog-ps-part">${escapeHtml(card.dataset.partName || '')}</div>
        ${card.dataset.invDesc ? `<div class="trial-catalog-ps-desc">${escapeHtml(card.dataset.invDesc)}</div>` : ''}
        ${trialExecStatusBadge(execStatus)}
      </div>
      <span class="trial-catalog-ps-meta trial-catalog-ps-date">${escapeHtml(dueDate)}</span>
    `;
  });
}

function updateTrialCompletedButton() {
  const btn = document.getElementById('trial-completed-toggle');
  if (btn) btn.textContent = trialShowCompleted ? 'Hide completed' : 'Show completed';
}
