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

function trialPsErpBomCode(ps) {
  return String(ps?.erp_bom_code || ps?.bom_code || '').trim();
}

function trialPsBomDisplay(ps) {
  if (!ps) return '';
  const selected = String(ps.selected_bom_code || ps.selected_flow_code || '').trim();
  if (selected) return selected;
  return trialPsErpBomCode(ps);
}

function trialNormalizeExecLabel(value) {
  return trialExecStatusLabel(value);
}

function trialBomStageBadgeHtml(ps) {
  const status = String(ps.bom_stage_status || '').toLowerCase();
  const inv = String(ps.inventory_code || ps.part_no || '').trim();
  const erp = trialPsErpBomCode(ps);
  if (!status) return '';
  const labels = {
    ok: 'Matches bom_op_stage',
    planner_mismatch: 'Planner BOM differs from ERP',
    not_in_stage: 'Not in bom_op_stage',
    missing_erp: 'No ERP BOM on voucher',
  };
  const label = labels[status] || status;
  return `<span class="trial-bom-stage-badge is-${escapeHtml(status)}" title="${escapeHtml(`${inv} + ${erp || '?'}`)}">${escapeHtml(label)}</span>`;
}

function trialErpBomHtml(ps) {
  const erp = trialPsErpBomCode(ps);
  const inv = String(ps.inventory_code || ps.part_no || '').trim();
  const code = erp || '-';
  return (
    '<div class="trial-catalog-erp-bom">' +
    '<span class="trial-catalog-section-note">ERP BOM (pp_voucher)</span>' +
    '<div class="trial-catalog-erp-bom-row">' +
    `<strong class="trial-catalog-erp-bom-code" title="${escapeHtml(`${inv} - ${erp || 'missing'}`)}">${escapeHtml(code)}</strong>` +
    trialBomStageBadgeHtml(ps) +
    '</div></div>'
  );
}

function trialFlowSelectHtml(ps) {
  const flows = Array.isArray(ps.flow_options) ? ps.flow_options : [];
  const selectedFlowCode = String(ps.selected_bom_code || ps.selected_flow_code || '');
  const erpBom = trialPsErpBomCode(ps);
  const options = [];
  if (!flows.length) {
    const hint = erpBom ? `Use ERP: ${erpBom}` : 'No planner BOM routes yet';
    options.push(`<option value="">${escapeHtml(hint)}</option>`);
  } else {
    options.push('<option value="">Select planner BOM</option>');
    flows.forEach(flow => {
      const code = String(flow.bom_code || flow.flow_code || '');
      const label = `${code}${flow.is_default ? ' (default)' : ''}${erpBom && code === erpBom ? ' · ERP' : ''}`;
      options.push(`<option value="${escapeHtml(code)}" ${code === selectedFlowCode ? 'selected' : ''}>${escapeHtml(label)}</option>`);
    });
  }
  const label = selectedFlowCode || '';
  return `
    <div class="trial-catalog-bom-controls">
      ${trialErpBomHtml(ps)}
      <label class="trial-catalog-planner-bom">
        <span class="trial-catalog-section-note">Planner BOM${label ? ` · ${escapeHtml(label)}` : ''}</span>
        <select class="trial-catalog-flow-select" data-ps-id="${escapeHtml(ps.ps_id || '')}"
          ${flows.length ? '' : 'disabled'}
          onchange="setTrialSelectedFlow(this.dataset.psId, this.value)">
          ${options.join('')}
        </select>
      </label>
    </div>
  `;
}

function trialCatalogBomBarHtml(ps) {
  const flows = Array.isArray(ps.flow_options) ? ps.flow_options : [];
  const selectedFlowCode = String(ps.selected_bom_code || ps.selected_flow_code || '');
  const erpBom = trialPsErpBomCode(ps) || '-';
  const options = [];
  if (!flows.length) {
    const hint = erpBom && erpBom !== '-' ? `ERP ${erpBom}` : 'No BOM routes';
    options.push(`<option value="">${escapeHtml(hint)}</option>`);
  } else {
    options.push('<option value="">Planner BOM…</option>');
    flows.forEach(flow => {
      const code = String(flow.bom_code || flow.flow_code || '');
      const label = `${code}${flow.is_default ? ' *' : ''}${erpBom && code === erpBom ? ' · ERP' : ''}`;
      options.push(`<option value="${escapeHtml(code)}" ${code === selectedFlowCode ? 'selected' : ''}>${escapeHtml(label)}</option>`);
    });
  }
  return `
    <div class="trial-catalog-bom-bar trial-catalog-bom-bar--compact">
      <span class="trial-catalog-bom-erp" title="ERP BOM (pp_voucher)">ERP ${escapeHtml(erpBom)}</span>
      ${trialBomStageBadgeHtml(ps)}
      <select class="trial-catalog-flow-select" data-ps-id="${escapeHtml(ps.ps_id || '')}"
        ${flows.length ? '' : 'disabled'}
        onchange="setTrialSelectedFlow(this.dataset.psId, this.value)">
        ${options.join('')}
      </select>
      <button class="btn btn-ghost btn-sm trial-catalog-bom-btn" type="button"
        onclick="openTrialBOMEditor('${escapeHtml(ps.ps_id)}')">BOM</button>
    </div>
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
      <label class="trial-ps-type-checkbox trial-ps-type-sr">
        <input type="checkbox" ${trialShowSrOrders ? 'checked' : ''}
          onchange="toggleTrialSrFilter(this.checked)">
        <span>[SR]</span>
      </label>
      <label class="trial-ps-type-checkbox trial-ps-type-hide-pending-do" title="Hide PS where all production stages are done and the SO is awaiting full shipment">
        <input type="checkbox" ${trialHidePendingDo ? 'checked' : ''}
          onchange="toggleTrialHidePendingDo(this.checked)">
        <span>Hide Pending DO</span>
      </label>
      <label class="trial-ps-type-checkbox trial-ps-type-hide-blank" title="Hide PS with no work orders assigned yet">
        <input type="checkbox" ${trialHideBlankPs ? 'checked' : ''}
          onchange="toggleTrialHideBlankPs(this.checked)">
        <span>Hide unassigned</span>
      </label>
      <div class="trial-machine-checkbox-actions">
        <button type="button" class="trial-machine-toggle-btn" onclick="setAllTrialPsTypesVisible(true)">All</button>
        <button type="button" class="trial-machine-toggle-btn" onclick="setAllTrialPsTypesVisible(false)">None</button>
      </div>
    </div>
  `;
}

function toggleTrialSrFilter(visible) {
  trialShowSrOrders = visible;
  renderTrialCatalog();
}

function toggleTrialHidePendingDo(hide) {
  trialHidePendingDo = hide;
  renderTrialCatalog();
}

function toggleTrialHideBlankPs(hide) {
  trialHideBlankPs = hide;
  renderTrialCatalog();
}

/** Status chips / badges shown on a catalog PS header (matches render output). */
function trialPsHasCatalogTags(ps) {
  if (trialPsPendingDo(ps)) return true;
  if (String(ps?.current_stage_desc || '').trim()) return true;
  if (trialNormalizeExecStatus(trialPsRollupExecStatus(ps))) return true;
  return (ps?.op_cards || []).some(card => trialNormalizeExecStatus(trialCatalogOpExecStatus(card)));
}

/**
 * Unassigned / blank PS: no manufacturing work orders yet, or no visible status tags.
 * ERP catalog rows often have op_cards from stage_desc but still look blank in the UI.
 */
function trialCatalogSourceBase(ps) {
  const base = String(ps?.source_ps_id || '').trim();
  if (base) return base;
  return trialSplitPsId(String(ps?.ps_id || '')).base || '';
}

let trialCatalogDueDateIndex = null;
let trialQueueBlocksIndex = null;
let trialQueueBlockSourceSet = null;

function trialResetRenderIndexes() {
  trialCatalogDueDateIndex = null;
  trialQueueBlocksIndex = null;
  trialQueueBlockSourceSet = null;
}

function trialBuildDueDateIndex() {
  const rows = [
    ...(Array.isArray(trialState.catalog) ? trialState.catalog : []),
    ...(Array.isArray(trialState.planned) ? trialState.planned : []),
  ];
  const index = new Map();
  rows.forEach(row => {
    const dueDate = row?.due_date ? String(row.due_date) : '';
    if (!dueDate) return;
    const rowId = String(row?.ps_id || '').trim();
    const rowSrc = String(row?.source_ps_id || row?.display_ps_id || '').trim();
    const rowParts = trialSplitPsId(rowId);
    const rowBase = String(rowParts.base || rowSrc || rowId).trim();
    const rowPartial = String(rowParts.partial || row?.pp_partial_no || '').trim();
    [rowId, rowSrc, rowBase].filter(Boolean).forEach(key => {
      if (!index.has(key)) index.set(key, dueDate);
    });
    if (rowBase) {
      const baseKey = rowPartial ? `${rowBase}::${rowPartial}` : rowBase;
      if (!index.has(baseKey)) index.set(baseKey, dueDate);
    }
  });
  trialCatalogDueDateIndex = index;
}

function trialEnsureDueDateIndex() {
  if (!trialCatalogDueDateIndex) {
    trialBuildDueDateIndex();
  }
  return trialCatalogDueDateIndex;
}

function trialBuildQueueBlocksIndex() {
  const index = new Map();
  const sourceSet = new Set();
  (Array.isArray(trialState.blocks) ? trialState.blocks : []).forEach(block => {
    const blockSource = trialCatalogSourceBase({ source_ps_id: block.source_ps_id || block.job_no });
    if (!blockSource) return;
    sourceSet.add(blockSource);
    const blockPartial = String(trialSplitPsId(block.source_ps_id || block.job_no).partial || '').trim() || '1';
    const key = `${blockSource}::${blockPartial}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(block);
  });
  trialQueueBlocksIndex = index;
  trialQueueBlockSourceSet = sourceSet;
}

function trialEnsureQueueBlocksIndex() {
  if (!trialQueueBlocksIndex) {
    trialBuildQueueBlocksIndex();
  }
  return trialQueueBlocksIndex;
}

function trialPsHasQueuedBlocks(ps) {
  const cards = trialResolvedOpCardsForPs(ps);
  if (cards.some(card => trialIsCatalogOpAllocated(card))) return true;
  const source = trialCatalogSourceBase(ps);
  if (!source) return false;
  const wantPartial = trialCatalogPartialIndex(
    String(ps?.ps_id || '').includes('::')
      ? ps.ps_id
      : `${source}::${Number(ps?.pp_partial_no) || 1}`,
  );
  const { blocksBySourceBase } = trialEnsureDataIndexes();
  const blocks = blocksBySourceBase.get(source) || [];
  if (!blocks.length) return false;
  if (blocks.some(block => trialCatalogPartialIndex(block.source_ps_id || block.job_no) === wantPartial)) {
    return true;
  }
  const legacyCount = blocks.filter(block => {
    const raw = String(block.source_ps_id || block.job_no || '');
    return !raw.includes('::') && trialCatalogPartialIndex(raw) === 1;
  }).length;
  return legacyCount >= wantPartial;
}

function trialQueuedMachineCodesForPs(ps) {
  const codes = new Set();
  trialResolvedOpCardsForPs(ps).forEach(card => {
    if (!trialIsCatalogOpAllocated(card)) return;
    trialQueuedMachineCodesForCatalogOp(card).forEach(code => codes.add(code));
  });
  return [...codes].sort();
}

function trialCatalogPsQueuePillHtml(ps) {
  const queued = trialPsHasQueuedBlocks(ps);
  const machines = queued ? trialQueuedMachineCodesForPs(ps) : [];
  const title = queued
    ? (machines.length ? `Queued on ${machines.join(', ')}` : 'On machine queue')
    : 'Not on any machine queue';
  const label = queued ? 'Queued' : 'Not queued';
  return `<span class="trial-catalog-queue-pill ${queued ? 'is-queued' : 'is-not-queued'}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

function trialQueuedOpCardsForPs(ps) {
  const psId = String(ps?.ps_id || '').trim();
  const source = trialCatalogSourceBase(ps);
  const partial = String(trialSplitPsId(psId).partial || ps?.pp_partial_no || '').trim() || '1';
  if (!source) return [];
  const index = trialEnsureQueueBlocksIndex();
  const blocks = index.get(`${source}::${partial}`) || [];
  if (!blocks.length) return [];
  const opMap = new Map();
  blocks.forEach(block => {
    const opNo = String(block.source_op_no || '').trim() || String(block.operation_name || '').trim();
    const opSeq = Number(block.source_op_seq_id || 0);
    const key = `${opNo}::${opSeq}`;
    const metrics = trialBlockMemberMetrics(block);
    const existing = opMap.get(key) || {
      card_kind: 'single',
      card_id: null,
      ps_id: ps.ps_id || block.source_ps_id || '',
      source_ps_id: block.source_ps_id || ps.ps_id || '',
      source_op_no: opNo,
      source_op_seq_id: opSeq,
      operation_label: opNo || String(opSeq || ''),
      operation_name: String(block.operation_name || '').trim() || opNo,
      target_qty: 0,
      remaining_qty: 0,
      total_qty: 0,
      planning_status: 'SCHEDULED',
      card_type: 'SINGLE',
      is_scheduled: true,
      setup_minutes: Number(block.setup_minutes || 0),
      cycle_minutes_per_qty: Number(block.cycle_minutes_per_qty || 0),
      compatible_machine_group: String(block.compatible_machine_group || '').trim(),
      execution_status: String(block.execution_status || block.status || '').trim(),
      machine_id: Number(block.machine_id || 0),
      machine_code: String(block.machine_code || '').trim(),
    };
    existing.target_qty += Number(block.scheduled_qty || 0);
    existing.total_qty += Number(block.scheduled_qty || 0);
    existing.remaining_qty += Number(metrics.remainingQty || 0);
    const machineCode = String(block.machine_code || '').trim();
    if (machineCode) {
      existing.queued_machines = existing.queued_machines || [];
      if (!existing.queued_machines.includes(machineCode)) {
        existing.queued_machines.push(machineCode);
      }
    }
    opMap.set(key, existing);
  });
  opMap.forEach(entry => {
    if (Array.isArray(entry.queued_machines)) {
      entry.queued_machines.sort();
    }
    entry.is_allocated = (entry.queued_machines || []).length > 0;
  });
  return Array.from(opMap.values()).sort((a, b) =>
    Number(a.source_op_seq_id || 0) - Number(b.source_op_seq_id || 0) ||
    String(a.source_op_no || '').localeCompare(String(b.source_op_no || ''))
  );
}

function trialResolvedOpCardsForPs(ps) {
  if (Array.isArray(ps?.op_cards) && ps.op_cards.length) return ps.op_cards;
  const queuedCards = trialQueuedOpCardsForPs(ps);
  if (queuedCards.length) return queuedCards;
  return [];
}

function trialPsIsUnassignedCatalog(ps) {
  const cards = trialResolvedOpCardsForPs(ps);
  if (!cards.length) {
    // Keep queued/scheduled partials visible even without sidebar op cards.
    if (trialPsHasQueuedBlocks(ps)) return false;
    return true;
  }
  // ERP partials without WO status codes still have open stage rows — not blank.
  if (cards.some(card => trialCatalogOpIsOpen(card))) return false;
  const workQty = Number(ps?.partial_qty ?? ps?.display_qty ?? ps?.wo_req_qty ?? 0);
  if (workQty > 0.0001 && !trialPsShippedComplete(ps)) return false;
  return !trialPsHasCatalogTags(ps);
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

function renderTrialMachineTypeFilter() {
  const categories = trialMachineCategories();
  return `
    <div class="trial-filter-inline trial-filter-section-type">
      <span class="trial-filter-label">Type</span>
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
  `;
}

function renderTrialMachineCheckboxFilter() {
  const machines = trialMachinesInCategory();
  if (!machines.length) return '';
  const selectedMachineCount = machines.filter(m => !trialMachineHiddenSet.has(m.machine_code)).length;
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
    <div class="trial-filter-section trial-filter-section-machines">
      <div class="trial-filter-section-head">
        <span class="trial-filter-label">Machine <span class="trial-filter-subtle">${selectedMachineCount}/${machines.length}</span></span>
        <div class="trial-machine-checkbox-actions">
          <button type="button" class="trial-machine-toggle-btn" onclick="setAllTrialMachinesVisible(true)">All</button>
          <button type="button" class="trial-machine-toggle-btn" onclick="setAllTrialMachinesVisible(false)">None</button>
        </div>
      </div>
      <div class="trial-machine-checkbox-list">
        ${machineCheckboxes}
      </div>
    </div>
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
    <div class="trial-filter-inline trial-filter-section-date">
      <span class="trial-filter-label">Date</span>
      <div class="trial-date-filter">
        <input type="date" aria-label="Start date" value="${escapeHtml(trialScheduleDateFilter.start || '')}"
          onchange="setTrialScheduleDateFilter('start', this.value)">
        <span class="trial-date-filter-separator">–</span>
        <input type="date" aria-label="End date" value="${escapeHtml(trialScheduleDateFilter.end || '')}"
          onchange="setTrialScheduleDateFilter('end', this.value)">
        <button type="button" class="btn btn-ghost btn-sm trial-date-clear" onclick="clearTrialScheduleDateFilter()">Clear</button>
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
  trialScheduleDateFilter = trialDefaultScheduleDateFilter();
  trialSyncScheduleUrl();
  renderTrial();
}

// ── Op card HTML ──────────────────────────────────────────────────────────────

function trialFindCatalogOpContext(payload) {
  if (!payload) return { ps: null, card: null };
  const psId = String(payload.ps_id || payload.source_ps_id || '').trim();
  const basePs = psId.split('::')[0] || psId;
  const opNo = String(payload.source_op_no || payload.operation_label || '').trim();
  const stepId = Number(payload.source_op_seq_id || 0);
  const cardId = Number(payload.card_id || 0);
  const pools = [...(trialState.catalog || []), ...(trialState.planned || [])];
  for (const ps of pools) {
    const rowPsId = String(ps.ps_id || '').trim();
    const rowBase = rowPsId.split('::')[0] || rowPsId;
    if (psId && rowPsId !== psId && rowBase !== basePs) continue;
    for (const card of ps.op_cards || []) {
      if (cardId && Number(card.card_id || 0) === cardId) {
        return { ps, card };
      }
      if (stepId > 0 && Number(card.source_op_seq_id || 0) === stepId) {
        return { ps, card };
      }
      const cardOp = String(card.source_op_no || card.operation_label || '').trim();
      if (opNo && cardOp === opNo) {
        return { ps, card };
      }
    }
  }
  const fallback = trialCatalogCardFromPayload(payload);
  return { ps: null, card: fallback };
}

function trialRenderQueuedMachinePills(machineCodes, options = {}) {
  const codes = (machineCodes || []).filter(Boolean);
  if (!codes.length) return '';
  const compact = options.compact !== false;
  const title = options.title || `Queued on: ${codes.join(', ')}`;
  return `
    <span class="trial-queued-machines${compact ? ' trial-queued-machines--compact' : ''}" title="${escapeHtml(title)}">
      ${codes.map(code => `<span class="trial-machine-pill">${escapeHtml(code)}</span>`).join('')}
    </span>
  `;
}

function trialRenderCatalogOpDetailRow(label, valueHtml) {
  if (!valueHtml && valueHtml !== 0) return '';
  return `
    <div class="trial-op-detail-row">
      <dt>${escapeHtml(label)}</dt>
      <dd>${valueHtml}</dd>
    </div>
  `;
}

function trialRenderCatalogOpDetailBody(ps, card) {
  const cardKind = String(card.card_kind || 'single');
  const isGroup = cardKind === 'group';
  const opName = String(card.operation_name || '').trim();
  const execStatus = card.execution_status || card.op?.execution_status || '';
  const catalogCard = {
    ...card,
    ps_id: card.ps_id || ps?.ps_id || '',
    source_ps_id: card.source_ps_id || ps?.ps_id || '',
    part_no: card.part_no || ps?.part_no || ps?.part_name || '',
  };
  const allocatedBlock = trialAllocatedBlockForOp(
    catalogCard.source_ps_id || catalogCard.ps_id,
    catalogCard.source_op_no || catalogCard.operation_label,
    Number(catalogCard.source_op_seq_id || 0),
  );
  const isAllocated = Boolean(allocatedBlock) || trialIsCatalogOpAllocated(catalogCard);
  const queuedMachines = trialQueuedMachineCodesForCatalogOp(catalogCard);
  const schedulableRemaining = trialCatalogSchedulableRemaining(card);
  const psId = String(ps?.ps_id || card.ps_id || '').trim();
  const basePs = psId.split('::')[0] || psId;
  const partial = psId.includes('::') ? psId.split('::')[1] : '';
  const opDisp = trialBlockOpDisplay({
    source_op_no: card.source_op_no || card.operation_label,
    operation_name: card.operation_name || card.op_type || '',
  });
  const bomCode = trialPsBomDisplay(ps);
  const headSub = [bomCode, opDisp.op_no, basePs].filter(Boolean).join(' · ');
  const execHtml = trialOpStatusHtml(execStatus, {
    title: opDisp.op_name || opName,
    compact: true,
  });
  const machineGroup = String(card.compatible_machine_group || card.op?.compatible_machine_group || '').trim();
  const queueLine = queuedMachines.length
    ? `${trialRenderQueuedMachinePills(queuedMachines, { compact: false })}${schedulableRemaining > 0.0001
      ? ` <span class="trial-remaining-hint">${escapeHtml(fmt(schedulableRemaining, 0))} pcs unscheduled</span>`
      : ''}`
    : '<span class="trial-ptl-muted">Not on a machine queue</span>';

  return `
    <div class="trial-op-detail">
      <div class="trial-op-detail-head">
        <div class="trial-op-detail-title">${escapeHtml(opDisp.op_name || 'Operation')}</div>
        ${headSub ? `<div class="trial-op-detail-sub">${escapeHtml(headSub)}</div>` : ''}
        <div class="trial-op-detail-badges">${execHtml}</div>
      </div>
      <dl class="trial-op-detail-grid">
        ${trialRenderCatalogOpDetailRow('Process sheet', escapeHtml(basePs))}
        ${partial ? trialRenderCatalogOpDetailRow('Partial', escapeHtml(partial)) : ''}
        ${ps?.part_name || ps?.part_no
          ? trialRenderCatalogOpDetailRow('Part', escapeHtml([ps.part_name || ps.part_no, ps.part_desc].filter(Boolean).join(' · ')))
          : ''}
        ${ps?.due_date ? trialRenderCatalogOpDetailRow('PS due', escapeHtml(ps.due_date)) : ''}
        ${trialRenderCatalogOpDetailRow('Planning status', escapeHtml(card.planning_status || '—'))}
        ${trialRenderCatalogOpDetailRow('Target qty', escapeHtml(fmt(card.target_qty || 0, 0)))}
        ${trialRenderCatalogOpDetailRow('Remaining', escapeHtml(fmt(card.remaining_qty || 0, 0)))}
        ${trialRenderCatalogOpDetailRow('Total qty', escapeHtml(fmt(card.total_qty || card.remaining_qty || 0, 0)))}
        ${trialRenderCatalogOpDetailRow('Setup', `${escapeHtml(fmt(card.setup_minutes || 0, 0))} min`)}
        ${trialRenderCatalogOpDetailRow('Cycle', `${escapeHtml(fmt(card.cycle_minutes_per_qty || 0, 2))} min/pc`)}
        ${machineGroup ? trialRenderCatalogOpDetailRow('Machine group', escapeHtml(machineGroup)) : ''}
        ${trialRenderCatalogOpDetailRow('Queue', queueLine)}
      </dl>
      <div class="trial-op-detail-section">
        <div class="trial-op-detail-section-title">Program / tool list</div>
        ${trialProgramToolsBlockHtml(catalogCard)}
      </div>
      <div class="trial-op-detail-actions">
        ${isAllocated && allocatedBlock?.machine_id
          ? `<button type="button" class="btn btn-primary btn-sm" onclick="closeModal(); openTrialMachineQueue(${Number(allocatedBlock.machine_id)})">Open machine queue</button>`
          : ''}
        ${allocatedBlock?.block_id
          ? `<button type="button" class="btn btn-ghost btn-sm" onclick="closeModal(); openTrialBlockEditor(${Number(allocatedBlock.block_id)})">Edit run block</button>`
          : ''}
        ${isGroup && !card.is_scheduled
          ? `<button type="button" class="btn btn-ghost btn-sm" onclick="closeModal(); deleteTrialPlanningCard(${Number(card.card_id || 0)})">Uncombine</button>`
          : ''}
      </div>
    </div>
  `;
}

function openTrialCatalogOpDetail(payload) {
  if (trialPlannerBusyLock > 0) return;
  const { ps, card } = trialFindCatalogOpContext(payload);
  if (!card) {
    toast('Operation details not found.', 'error');
    return;
  }
  const basePs = String(ps?.ps_id || card.ps_id || '').split('::')[0] || 'PS';
  const opDisp = trialBlockOpDisplay({
    source_op_no: card.source_op_no || card.operation_label,
    operation_name: card.operation_name || card.op_type || '',
  });
  const bomCode = trialPsBomDisplay(ps);
  const title = [basePs, bomCode, opDisp.op_no || opDisp.op_name].filter(Boolean).join(' · ') || 'Operation';
  openModal(title, trialRenderCatalogOpDetailBody(ps, card), 'lg');
}

function trialPlanningCardFromBlock(block) {
  if (!block) return null;
  return {
    ps_id: block.source_ps_id || block.job_no || '',
    source_ps_id: block.source_ps_id || block.job_no || '',
    source_op_no: block.source_op_no || block.operation_label || '',
    source_op_seq_id: Number(block.source_op_seq_id || 0),
    operation_label: block.operation_label || block.source_op_no || '',
    operation_name: block.operation_name || block.op_type || '',
    part_no: block.part_no || block.part_name || '',
    job_no: block.job_no || block.source_ps_id || '',
  };
}

function trialRenderRunBlockDetailBody(group, block, machine) {
  const vm = trialBlockGroupViewModel(group);
  const leader = vm.leader || block;
  const blockId = Number(leader?.block_id || block?.block_id || 0);
  const ptlCard = trialPlanningCardFromBlock(leader || block);
  const execHtml = vm.isCombined
    ? vm.executionStatusHtml
    : trialOpStatusHtml(leader?.execution_status, {
      opNo: leader?.source_op_no || leader?.operation_label,
      title: leader?.operation_name,
      compact: false,
    });
  const machineLine = machine
    ? `${escapeHtml(machine.machine_code || '')} · ${escapeHtml(machine.machine_category || '')}`
    : '—';

  return `
    <div class="trial-op-detail">
      <div class="trial-op-detail-head">
        <div class="trial-op-detail-title">${escapeHtml(vm.psDisplay.base || group.title || '')}</div>
        <div class="trial-op-detail-sub">${escapeHtml(vm.operationLine)}</div>
        <div class="trial-op-detail-badges">${execHtml}</div>
      </div>
      <dl class="trial-op-detail-grid">
        ${trialRenderCatalogOpDetailRow('Machine', escapeHtml(machineLine))}
        ${vm.sequenceNo ? trialRenderCatalogOpDetailRow('Queue #', escapeHtml(String(vm.sequenceNo))) : ''}
        ${trialRenderCatalogOpDetailRow('Target qty', vm.targetQty)}
        ${trialRenderCatalogOpDetailRow('Output', vm.pairedOutput)}
        ${trialRenderCatalogOpDetailRow('Due', escapeHtml(String(trialDueDateForPs(vm.psDueKey) || '—')))}
        ${trialRenderCatalogOpDetailRow('Queued', escapeHtml(vm.queuedText))}
        ${trialRenderCatalogOpDetailRow('End', escapeHtml(vm.outputText))}
        ${trialRenderCatalogOpDetailRow('Setup', leader?.include_setup ? 'Included' : 'Excluded')}
      </dl>
      ${ptlCard ? `
        <div class="trial-op-detail-section">
          <div class="trial-op-detail-section-title">Program / tool list</div>
          ${trialProgramToolsBlockHtml(ptlCard)}
        </div>
      ` : ''}
      ${vm.isCombined ? `
        <div class="trial-op-detail-section">
          <div class="trial-op-detail-section-title">Combined operations</div>
          <div class="trial-block-member-progress">
            ${vm.memberMetrics.map(member => `
              <div class="trial-block-member-line">
                <span>${escapeHtml(member.source_op_no || member.operation_name || '')}</span>
                <span>${fmt(member.netOutput || member.outputTotal || 0, 0)} / ${fmt(member.scheduled_qty || 0, 0)} done</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      <div class="trial-op-detail-actions">
        <button type="button" class="btn btn-primary btn-sm" onclick="closeModal(); openTrialMachineQueue(${Number(machine?.machine_id || block?.machine_id || 0)})">Open machine queue</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="closeModal(); openTrialBlockEditor(${blockId})">Edit</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="closeModal(); openTrialSplitModal(${blockId})">Split</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="closeModal(); ${vm.isCombined ? `openTrialGroupActualModal(${Number(group.group_id || 0)})` : `openTrialActualModal(${blockId})`}">Actual</button>
      </div>
    </div>
  `;
}

function openTrialRunBlockDetail(blockId) {
  if (trialPlannerBusyLock > 0) return;
  const id = Number(blockId || 0);
  if (!id) return;
  const block = (trialState.blocks || []).find(row => Number(row.block_id) === id);
  if (!block) {
    toast('Run block not found.', 'error');
    return;
  }
  const machineId = Number(block.machine_id || 0);
  const groups = trialBlocksGroupedForMachine(machineId);
  const group = groups.find(row => (row.blocks || []).some(b => Number(b.block_id) === id));
  if (!group) {
    toast('Queue group not found.', 'error');
    return;
  }
  const machine = (trialState.machines || []).find(row => Number(row.machine_id) === machineId);
  const vm = trialBlockGroupViewModel(group);
  const title = `${vm.psDisplay.base || 'Run block'} · ${machine?.machine_code || 'Machine'}`;
  openModal(title, trialRenderRunBlockDetailBody(group, block, machine), 'lg');
}

function renderTrialOpCardHtml(card) {
  const cardKind = String(card.card_kind || 'single');
  const isGroup = cardKind === 'group';
  const isScheduled = !!card.is_scheduled;
  const catalogOpRef = {
    source_ps_id: card.source_ps_id || card.ps_id || '',
    source_op_no: card.source_op_no || card.operation_label || '',
    source_op_seq_id: Number(card.source_op_seq_id || 0),
    ps_id: card.ps_id || '',
    queued_machines: card.queued_machines,
    remaining_qty: card.remaining_qty,
  };
  const isAllocated = !!card.is_allocated || trialCatalogOpHasQueuedBlocks(catalogOpRef);
  const schedulableRemaining = trialCatalogSchedulableRemaining(card);
  const isPartiallyAllocated = isAllocated && schedulableRemaining > 0.0001;
  const remainingQty = fmt(
    isPartiallyAllocated ? schedulableRemaining : (card.remaining_qty || 0),
    0,
  );
  const setupMinutes = fmt(card.setup_minutes || 0, 0);
  const cycleMinutes = fmt(card.cycle_minutes_per_qty || 0, 0);
  const opName = String(card.operation_name || '').trim();
  const execStatus = card.execution_status || card.op?.execution_status || '';
  const execStatusHtml = trialOpStatusHtml(execStatus, {
    opNo: card.operation_label || card.source_op_no || '',
    title: opName,
    compact: true,
  });
  const queuedMachines = trialQueuedMachineCodesForCatalogOp(catalogOpRef);
  const allocatedBlock = isAllocated ? trialAllocatedBlockForOp(card.source_ps_id || card.ps_id, card.source_op_no) : null;
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
    const opRef = card.op || {};
    payload.required_qty = Number(card.required_qty ?? opRef.required_qty ?? 0);
    payload.planned_qty = Number(card.planned_qty ?? opRef.planned_qty ?? 0);
    payload.erp_finished_qty = Number(card.erp_finished_qty ?? opRef.erp_finished_qty ?? 0);
    payload.op = {
      job_no: payload.job_no,
      operation_name: payload.operation_name,
      op_type: payload.op_type,
      total_qty: payload.total_qty || payload.remaining_qty || 0,
      remaining_qty: isPartiallyAllocated
        ? schedulableRemaining
        : (payload.remaining_qty || payload.total_qty || 0),
      required_qty: payload.required_qty,
      planned_qty: payload.planned_qty,
      erp_finished_qty: payload.erp_finished_qty,
      setup_time: payload.setup_minutes,
      cycle_time: payload.cycle_minutes_per_qty,
      compatible_machine_group: payload.compatible_machine_group,
      source_ps_id: payload.source_ps_id,
      source_op_seq_id: payload.source_op_seq_id,
      source_op_no: payload.source_op_no,
    };
  }
  const opLabel = String(card.operation_label || '').trim();
  const showOpName = opName && opName !== opLabel;
  const uncombineBtn = isGroup && !isScheduled
    ? `<button class="trial-catalog-op-uncombine" type="button" aria-label="Uncombine" title="Uncombine"
        onclick="deleteTrialPlanningCard(${Number(card.card_id || 0)})">×</button>`
    : '';
  return `
    <div class="trial-catalog-op trial-planning-card trial-catalog-op--compact trial-catalog-op--clickable ${isScheduled ? 'is-scheduled' : ''} ${isAllocated ? 'is-allocated' : ''} ${isPartiallyAllocated ? 'is-partially-allocated' : ''}"
      draggable="false"
      title="${isPartiallyAllocated
        ? `Click for details · drag remainder (${schedulableRemaining} pcs) to another machine`
        : 'Click for details · drag to schedule or combine'}"
      data-trial-payload="${trialPayloadToAttr(payload)}"
      data-card-kind="${escapeHtml(cardKind)}"
      data-card-id="${escapeHtml(card.card_id || '')}"
      data-ps-id="${escapeHtml(card.ps_id || '')}"
      data-operation-label="${escapeHtml(card.operation_label || '')}"
      data-target-qty="${escapeHtml(card.target_qty || 0)}"
      data-remaining-qty="${escapeHtml(isPartiallyAllocated ? schedulableRemaining : (card.remaining_qty || 0))}"
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
      <div class="trial-catalog-op-line">
        <div class="trial-catalog-op-lead">
          <span class="trial-catalog-op-label">${escapeHtml(opLabel)}</span>
          ${execStatusHtml}
        </div>
        <div class="trial-catalog-op-side">
          <span class="trial-catalog-op-qty" title="Remaining quantity">${remainingQty} pcs</span>
          <span class="trial-catalog-op-time" title="Setup / cycle per pc">${setupMinutes}/${cycleMinutes}m</span>
        </div>
        ${uncombineBtn}
      </div>
      ${showOpName ? `<div class="trial-catalog-op-detail">${escapeHtml(opName)}</div>` : ''}
      <div class="trial-catalog-op-footer">
        ${trialProgramToolsCompactHtml(card)}
        ${isAllocated
          ? `${trialRenderQueuedMachinePills(queuedMachines, {
            title: queuedMachines.length
              ? `Queued on: ${queuedMachines.join(', ')}`
              : 'On machine queue',
          })}${isPartiallyAllocated
            ? `<span class="trial-remaining-badge" title="Quantity not yet assigned to a machine">${escapeHtml(fmt(schedulableRemaining, 0))} left</span>`
            : ''}`
          : ''}
      </div>
    </div>
  `;
}

// ── Machine lane ──────────────────────────────────────────────────────────────

function trialGroupEndForAvailability(group) {
  return String(
    group?.visual_end_datetime ||
    group?.group_end ||
    group?.leader?.visual_end_datetime ||
    group?.leader?.calculated_end_datetime ||
    ''
  ).trim();
}

function trialMachineAvailabilityEnd(groups) {
  const ends = (groups || []).map(trialGroupEndForAvailability).filter(Boolean).sort();
  return ends[ends.length - 1] || '';
}

function trialCatalogRowMatchesPsKey(row, needle, sourceBase, sourcePartial) {
  const id = String(row?.ps_id || '').trim();
  const src = String(row?.source_ps_id || row?.display_ps_id || '').trim();
  if (id === needle || src === needle) return true;
  const idParts = trialSplitPsId(id);
  if (String(idParts.base || '').trim() !== sourceBase) {
    return src === sourceBase && (!sourcePartial || String(row?.pp_partial_no || '') === sourcePartial);
  }
  if (!sourcePartial) return true;
  if (String(idParts.partial || '').trim() === sourcePartial) return true;
  return String(row?.pp_partial_no || '') === sourcePartial;
}

function trialDueDateForPs(psId) {
  const needle = String(psId || '').trim();
  if (!needle) return '';
  const sourceParts = trialSplitPsId(needle);
  const sourceBase = String(sourceParts.base || needle).trim();
  const sourcePartial = String(sourceParts.partial || '').trim();
  const exactKey = sourcePartial ? `${sourceBase}::${sourcePartial}` : sourceBase;
  const index = trialEnsureDueDateIndex();
  if (index.has(needle)) return String(index.get(needle) || '');
  if (index.has(exactKey)) return String(index.get(exactKey) || '');
  if (index.has(sourceBase)) return String(index.get(sourceBase) || '');
  const rows = [
    ...(Array.isArray(trialState.catalog) ? trialState.catalog : []),
    ...(Array.isArray(trialState.planned) ? trialState.planned : []),
  ];
  const hit = rows.find(row => trialCatalogRowMatchesPsKey(row, needle, sourceBase, sourcePartial));
  return hit?.due_date ? String(hit.due_date) : '';
}

function trialDuePillHtml(psId) {
  const dueDate = String(trialDueDateForPs(psId) || '').trim();
  if (!dueDate) {
    return `
      <span class="trial-pill trial-time-pill trial-due-pill is-empty" title="No due date found for this PS">
        <span class="trial-pill-label">Due</span>
        <span class="trial-pill-value">No due date</span>
      </span>
    `;
  }
  const dayDiff = trialDateDiffDays(dueDate);
  const dueClass = dayDiff == null ? '' : (dayDiff < 0 ? 'is-overdue' : (dayDiff <= 7 ? 'is-due-soon' : 'is-normal'));
  return `
    <span class="trial-pill trial-time-pill trial-due-pill ${dueClass}" title="PS due date">
      <span class="trial-pill-label">Due</span>
      <span class="trial-pill-value">${escapeHtml(dueDate)}</span>
    </span>
  `;
}

function trialBlockGroupViewModel(group, options = {}) {
  const leader = group.leader;
  const psDisplay = trialBlockPsDisplay(group, leader);
  const psDueKey = psDisplay.partial ? `${psDisplay.base}::${psDisplay.partial}` : psDisplay.base;
  const opDisplay = trialBlockOpDisplay(leader);
  const operationLine = group.blocks.length > 1
    ? String(group.operation_label || group.group_label || '').trim()
    : [opDisplay.op_no, opDisplay.op_name].filter(Boolean).join(' ');
  const queuedAt = trialBlockQueuedAt(leader || group);
  const outputAt = trialBlockOutputAt(leader || group);
  const materialStatus = group.material_status || leader?.material_status || {};
  const setupOn = Number(leader?.include_setup || 0) === 1;
  const setupTitle = setupOn ? 'Setup time is included. Click to turn it off.' : 'Setup time is excluded. Click to turn it on.';
  const anchored = !!leader?.anchor_datetime;
  const queuedTitle = anchored
    ? `Queued ${trialFormatDt(queuedAt)} · Anchor ${trialFormatDt(leader?.anchor_datetime)}`
    : `Scheduled queue start · ${queuedAt || '—'}`;
  const outputTitle = trialBlockOutputTitle(leader || group);
  const outputPillClass = leader?.actual_end_at ? 'green' : (leader?.actual_start_at ? 'yellow' : '');
  const queuedMachines = trialQueuedMachineCodesForCatalogOp({
    source_ps_id: leader?.source_ps_id || leader?.job_no || '',
    source_op_no: leader?.source_op_no || leader?.operation_label || '',
    source_op_seq_id: Number(leader?.source_op_seq_id || 0),
  });
  const actualButton = group.blocks.length > 1
    ? `<button class="btn btn-ghost btn-sm" type="button" onclick="openTrialGroupActualModal(${Number(group.group_id || 0)})">Actual</button>`
    : `<button class="btn btn-ghost btn-sm" type="button" onclick="openTrialActualModal(${leader?.block_id || 0})">Actual</button>`;
  return {
    group,
    leader,
    groupBlockIds: group.blocks.map(b => b.block_id).join(','),
    psDisplay,
    psDueKey,
    operationLine,
    sequenceNo: Number(
      options.displaySequenceNo ??
      leader?.sequence_no ??
      leader?.queue_position ??
      0
    ),
    targetQty: fmt(group.target_qty || 0, 0),
    pairedOutput: fmt(Number(group.paired_output_qty ?? trialBlockNetOutput(group.output_qty, group.reject_qty) ?? 0), 0),
    queuedText: trialFormatDt(queuedAt),
    outputText: trialFormatDt(outputAt),
    queuedTitle,
    outputTitle,
    outputPillClass,
    anchored,
    materialStatus,
    materialChipClass: trialMaterialStatusClass(materialStatus),
    combinedLine: group.blocks.length > 1 ? `${group.blocks.length} ops combined` : '',
    setupOn,
    setupLabel: setupOn ? 'Setup: ON' : 'Setup: OFF',
    setupTitle,
    actualButton,
    isCombined: group.blocks.length > 1,
    memberMetrics: group.member_metrics || [],
    executionStatusHtml: group.blocks.length > 1
      ? group.member_metrics.map(member => trialOpStatusHtml(member.execution_status, {
        opNo: member.source_op_no || member.operation_name,
        title: member.operation_name,
        compact: true,
      })).join('')
      : trialOpStatusHtml(leader?.execution_status, { compact: true }),
    queuedMachines,
    splitAllocationHtml: queuedMachines.length > 1
      ? trialRenderQueuedMachinePills(queuedMachines, { title: `Split across: ${queuedMachines.join(', ')}` })
      : '',
  };
}

function trialRenderCompactBlockCard(vm) {
  const leader = vm.leader;
  const dueDate = String(trialDueDateForPs(vm.psDueKey) || '').trim();
  const dayDiff = dueDate ? trialDateDiffDays(dueDate) : null;
  const dueClass = dayDiff == null ? '' : (dayDiff < 0 ? 'is-overdue' : (dayDiff <= 7 ? 'is-due-soon' : 'is-normal'));
  return `
    <div class="trial-block-card trial-block-card--compact trial-block-card--clickable ${vm.isCombined ? 'combined' : ''}"
      data-block-id="${leader?.block_id || ''}"
      data-group-id="${vm.group.group_id || 0}"
      data-block-ids="${vm.groupBlockIds}"
      title="Click for details · drag edge to move">
      <div class="trial-block-compact-drag" title="Drag to reorder or move to another machine"></div>
      <div class="trial-block-compact-body">
        <div class="trial-block-compact-top">
          ${vm.sequenceNo ? `<span class="trial-block-seq">#${vm.sequenceNo}</span>` : ''}
          <span class="trial-block-compact-metrics" title="Qty / Output">
            <span class="trial-block-compact-metric"><span class="trial-pill-label">Qty</span>${vm.targetQty}</span>
            <span class="trial-block-compact-metric"><span class="trial-pill-label">Out</span>${vm.pairedOutput}</span>
          </span>
        </div>
        <div class="trial-block-title">${escapeHtml(vm.psDisplay.base || vm.group.title || '')}</div>
        ${vm.psDisplay.partial ? `<div class="trial-block-partial">Partial ${escapeHtml(vm.psDisplay.partial)}</div>` : ''}
        <div class="trial-block-op">${escapeHtml(vm.operationLine)}</div>
        ${vm.splitAllocationHtml ? `<div class="trial-block-split-machines">${vm.splitAllocationHtml}</div>` : ''}
        <div class="trial-block-compact-dates">
          <span class="trial-block-compact-date ${dueClass}" title="Due">
            <span class="trial-pill-label">Due</span>
            <span>${escapeHtml(dueDate || '—')}</span>
          </span>
          <span class="trial-block-compact-date" title="${escapeHtml(vm.queuedTitle)}">
            <span class="trial-pill-label">Queued</span>
            <span>${escapeHtml(vm.queuedText)}</span>
          </span>
          <span class="trial-block-compact-date is-end ${vm.outputPillClass}" title="${escapeHtml(vm.outputTitle)}">
            <span class="trial-pill-label">End</span>
            <span>${escapeHtml(vm.outputText)}</span>
          </span>
        </div>
      </div>
    </div>
  `;
}

function trialQueueDueClass(psDueKey) {
  const dueDate = String(trialDueDateForPs(psDueKey) || '').trim();
  if (!dueDate) return '';
  const dayDiff = trialDateDiffDays(dueDate);
  if (dayDiff == null) return '';
  if (dayDiff < 0) return 'is-overdue';
  if (dayDiff <= 7) return 'is-due-soon';
  return 'is-normal';
}

function trialRenderQueueDetailRow(group, displaySequenceNo = 0) {
  const vm = trialBlockGroupViewModel(group, {
    displaySequenceNo: displaySequenceNo > 0 ? displaySequenceNo : undefined,
  });
  const leader = vm.leader;
  const blockId = leader?.block_id || 0;
  const dueDate = String(trialDueDateForPs(vm.psDueKey) || '').trim() || '—';
  const dueClass = trialQueueDueClass(vm.psDueKey);
  const partialNote = vm.psDisplay.partial
    ? `<span class="trial-queue-partial">P${escapeHtml(vm.psDisplay.partial)}</span>`
    : '';
  const combinedNote = vm.combinedLine
    ? `<span class="trial-queue-combined">${escapeHtml(vm.combinedLine)}</span>`
    : '';
  const materialNote = vm.materialStatus?.label
    ? `<span class="trial-queue-material ${vm.materialChipClass}" title="${escapeHtml(vm.materialStatus.label)}">Mat</span>`
    : '';
  const actualOnClick = vm.isCombined
    ? `openTrialGroupActualModal(${Number(vm.group.group_id || 0)})`
    : `openTrialActualModal(${blockId})`;
  return `
    <div class="trial-queue-row trial-block-card ${vm.isCombined ? 'combined' : ''}"
      data-block-id="${blockId}"
      data-group-id="${vm.group.group_id || 0}"
      data-block-ids="${vm.groupBlockIds}">
      <button class="trial-queue-row-grip" type="button" aria-label="Drag to reorder" title="Drag to reorder">⋮⋮</button>
      <span class="trial-queue-seq">${vm.sequenceNo ? `#${vm.sequenceNo}` : '—'}</span>
      <div class="trial-queue-job" title="${escapeHtml(vm.operationLine)}">
        <span class="trial-queue-job-id">${escapeHtml(vm.psDisplay.base || vm.group.title || '')}</span>
        ${partialNote}
        <span class="trial-queue-job-op">${escapeHtml(vm.operationLine)}</span>
        ${combinedNote}
        ${materialNote}
      </div>
      <div class="trial-queue-qty" title="Qty / Output">
        <span>${vm.targetQty}</span><span class="trial-queue-qty-sep">/</span><span>${vm.pairedOutput}</span>
      </div>
      <div class="trial-queue-dates">
        <span class="trial-queue-date ${dueClass}" title="Due ${escapeHtml(dueDate)}">${escapeHtml(dueDate)}</span>
        <button type="button" class="trial-queue-date is-queued ${vm.anchored ? 'is-anchored' : ''}"
          onclick="editTrialAnchor(${blockId})" title="${escapeHtml(vm.queuedTitle || 'Edit queued time')}">
          ${escapeHtml(vm.queuedText)}
        </button>
        <span class="trial-queue-date is-end ${vm.outputPillClass}" title="${escapeHtml(vm.outputTitle)}">
          ${escapeHtml(vm.outputText)}
        </span>
      </div>
      <div class="trial-queue-actions">
        <button type="button" class="trial-queue-act" onclick="openTrialBlockEditor(${blockId})">Edit</button>
        <button type="button" class="trial-queue-act" onclick="openTrialSplitModal(${blockId})">Split</button>
        <button type="button" class="trial-queue-act" onclick="${actualOnClick}">Actual</button>
        <button type="button" class="trial-queue-act trial-queue-act-setup ${vm.setupOn ? 'is-on' : ''}"
          onclick="toggleTrialSetup(${blockId})" aria-pressed="${vm.setupOn ? 'true' : 'false'}"
          title="${escapeHtml(vm.setupTitle)}">${vm.setupOn ? 'Setup' : 'No setup'}</button>
        <button type="button" class="trial-queue-act is-danger"
          onclick="removeTrialBlock(${blockId}, ${Number(vm.group.group_id || 0)})"
          title="Remove from machine">Del</button>
      </div>
    </div>
  `;
}

function trialRenderQueueListHeader() {
  return `
    <div class="trial-queue-list-head" aria-hidden="true">
      <span></span>
      <span>#</span>
      <span>Job</span>
      <span>Qty/Out</span>
      <span>Due · Queued · End</span>
      <span>Actions</span>
    </div>
  `;
}

function renderTrialMachine(machine) {
  const allGroups = trialBlocksGroupedForMachine(machine.machine_id)
    .filter(group => !trialGroupCompletedForQueue(group));
  const groups = allGroups.filter(trialGroupRunsInsideDateFilter);
  const laneId = `trial-lane-${machine.machine_id}`;
  const blockCount = allGroups.length;
  const queueSummary = blockCount
    ? `${blockCount} in queue`
    : 'Empty queue';
  const staleBadge = trialDirtyMachineIds.has(Number(machine.machine_id))
    ? '<span class="trial-machine-stale-badge" title="Queue changed; schedule times may be outdated">Schedule outdated</span>'
    : '';
  const availabilityEnd = trialMachineAvailabilityEnd(
    trialHasActiveDateFilter() ? groups : allGroups
  );
  const availabilityTag = allGroups.length > 1 && availabilityEnd
    ? `<div class="trial-machine-availability">Next available ${trialFormatDt(availabilityEnd)}</div>`
    : '';

  const blockHtml = groups.length
    ? groups.map((group, idx) => trialRenderCompactBlockCard(
      trialBlockGroupViewModel(group, { displaySequenceNo: idx + 1 })
    )).join('')
    : `<div class="trial-empty">${escapeHtml(trialMachineLaneEmptyMessage(allGroups.length, groups.length))}</div>`;

  return `
    <section class="trial-machine" data-machine-id="${machine.machine_id}">
      <div class="trial-machine-head">
        <div class="trial-machine-head-main" role="button" tabindex="0"
          onclick="openTrialMachineQueue(${machine.machine_id})"
          onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTrialMachineQueue(${machine.machine_id}); }"
          title="Open full queue">
          <div class="trial-machine-title">${machine.machine_code}</div>
          <div class="trial-machine-meta">${machine.machine_category} - ${machine.shift_profile || 'STANDARD'}</div>
          <div class="trial-machine-queue-summary">${queueSummary}</div>
          ${staleBadge}
        </div>
        <div class="trial-machine-head-actions">
          <button class="btn btn-ghost btn-sm" type="button" onclick="event.stopPropagation(); openTrialMachineQueue(${machine.machine_id})">Queue</button>
          ${staleBadge ? `<button class="btn btn-primary btn-sm" type="button" onclick="event.stopPropagation(); trialRecalculateSingleMachine(${machine.machine_id})">Recalc</button>` : ''}
        </div>
      </div>
      ${availabilityTag}
      <div class="trial-lane" id="${laneId}" data-machine-id="${machine.machine_id}">
        ${blockHtml}
      </div>
    </section>
  `;
}

// ── Main board render ─────────────────────────────────────────────────────────

let trialMachineGridScrollResizeObserver = null;

function trialSyncMachineGridScrollWidth() {
  const host = document.querySelector('.trial-grid-scroll-host');
  if (!host) return;
  const topInner = host.querySelector('.trial-grid-scroll-top-inner');
  const grid = document.getElementById('trial-grid');
  const main = host.querySelector('.trial-grid-scroll');
  if (!topInner || !grid || !main) return;
  const w = Math.max(grid.scrollWidth, main.clientWidth, 1);
  topInner.style.width = `${w}px`;
}

function trialLaneAbsorbsVerticalWheel(lane, deltaY) {
  if (!lane || !deltaY) return false;
  const maxScroll = lane.scrollHeight - lane.clientHeight;
  if (maxScroll <= 1) return false;
  if (deltaY > 0) return lane.scrollTop < maxScroll - 1;
  return lane.scrollTop > 0;
}

function trialBindMachineGridScroll() {
  const host = document.querySelector('.trial-grid-scroll-host');
  const mainArea = document.querySelector('.trial-main');
  if (!host) return;
  const top = host.querySelector('.trial-grid-scroll-top');
  const main = host.querySelector('.trial-grid-scroll');
  if (!top || !main) return;

  if (host.dataset.scrollBound !== '1') {
    host.dataset.scrollBound = '1';
    let syncing = false;
    const syncFromMain = () => {
      if (syncing) return;
      syncing = true;
      top.scrollLeft = main.scrollLeft;
      syncing = false;
    };
    const syncFromTop = () => {
      if (syncing) return;
      syncing = true;
      main.scrollLeft = top.scrollLeft;
      syncing = false;
    };
    main.addEventListener('scroll', syncFromMain, { passive: true });
    top.addEventListener('scroll', syncFromTop, { passive: true });

    const onBoardWheel = (e) => {
      if (e.shiftKey) {
        const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (!delta || main.scrollWidth <= main.clientWidth) return;
        e.preventDefault();
        main.scrollLeft += delta;
        syncFromMain();
        return;
      }
      const deltaY = e.deltaY;
      if (!deltaY) return;
      const lane = e.target.closest?.('.trial-lane');
      if (trialLaneAbsorbsVerticalWheel(lane, deltaY)) return;
      const root = document.scrollingElement;
      if (!root) return;
      const before = root.scrollTop;
      root.scrollTop += deltaY;
      if (root.scrollTop !== before) e.preventDefault();
    };
    (mainArea || host).addEventListener('wheel', onBoardWheel, { passive: false });
  }

  const grid = document.getElementById('trial-grid');
  if (grid && !trialMachineGridScrollResizeObserver) {
    trialMachineGridScrollResizeObserver = new ResizeObserver(() => trialSyncMachineGridScrollWidth());
    trialMachineGridScrollResizeObserver.observe(grid);
  }
  trialSyncMachineGridScrollWidth();
  window.requestAnimationFrame(trialSyncMachineGridScrollWidth);
}

let trialDeferredCatalogRenderTimer = 0;

function trialDeferCatalogRender() {
  if (trialDeferredCatalogRenderTimer) {
    clearTimeout(trialDeferredCatalogRenderTimer);
  }
  trialDeferredCatalogRenderTimer = window.setTimeout(() => {
    trialDeferredCatalogRenderTimer = 0;
    renderTrialCatalog();
  }, 180);
}

function renderTrial(options = {}) {
  const perf = (typeof trialPerfStart === 'function')
    ? trialPerfStart('render-trial', {
      machines_total: Array.isArray(trialState.machines) ? trialState.machines.length : 0,
    })
    : null;
  trialResetRenderIndexes();
  const grid = document.getElementById('trial-grid');
  if (!grid) {
    if (typeof renderActualProduction === 'function') renderActualProduction();
    if (typeof trialPerfEnd === 'function') trialPerfEnd(perf, { skipped: 'no-grid' });
    return;
  }
  if (typeof destroyTrialSortables === 'function') destroyTrialSortables();
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'destroy-sortables');
  const filterShell = document.getElementById('trial-machine-filter-shell');
  if (filterShell) {
    filterShell.innerHTML = `
      <div class="trial-board-filter-card">
        <div class="trial-board-filter-row trial-board-filter-row--primary">
          ${renderTrialMachineTypeFilter()}
          ${renderTrialScheduleDateFilter()}
          <button type="button" class="btn btn-ghost btn-sm trial-shop-calendar-btn"
            onclick="openTrialCapacityModal()"
            title="Shop working hours, holidays, and capacity overrides">
            Shop calendar
          </button>
        </div>
        ${renderTrialMachineCheckboxFilter()}
      </div>
    `;
  }
  const visibleMachines = trialVisibleMachines();
  if (typeof trialPerfMark === 'function') {
    trialPerfMark(perf, 'compute-visible-machines', { visible_machines: visibleMachines.length });
  }
  grid.innerHTML = visibleMachines.length
    ? visibleMachines.map(renderTrialMachine).join('')
    : `<div class="trial-empty">No machines found for ${escapeHtml(trialMachineCategoryFilter)}.</div>`;
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'render-machine-grid-html');
  const layout = document.getElementById('trial-layout');
  if (layout) layout.style.display = 'grid';
  const loading = document.getElementById('trial-loading');
  if (loading) loading.style.display = 'none';
  updateTrialCompletedButton();
  if (options.skipCatalog) {
    // Board-only update; catalog loads in a follow-up fetch.
  } else if (options.deferCatalog) trialDeferCatalogRender();
  else renderTrialCatalog();
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'render-catalog');
  if (typeof initTrialMachineSortables === 'function') initTrialMachineSortables();
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'init-machine-sortables');
  if (typeof bindTrialLaneOpDrops === 'function') bindTrialLaneOpDrops();
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'bind-lane-op-drops');
  if (typeof bindTrialLaneBlockClicks === 'function') bindTrialLaneBlockClicks();
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'bind-lane-block-clicks');
  trialBindMachineGridScroll();
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'bind-grid-scroll');
  const reopenQueueId = trialOpenQueueMachineId;
  if (reopenQueueId && typeof openTrialMachineQueue === 'function') {
    window.requestAnimationFrame(() => openTrialMachineQueue(reopenQueueId));
  }
  if (typeof trialPerfEnd === 'function') {
    trialPerfEnd(perf, {
      visible_machines: visibleMachines.length,
    });
  }
}

function renderTrialMachines(machineIds, options = {}) {
  const perf = (typeof trialPerfStart === 'function')
    ? trialPerfStart('render-trial-machines', {
      requested: Array.isArray(machineIds) ? machineIds.length : 0,
    })
    : null;
  trialResetRenderIndexes();
  const grid = document.getElementById('trial-grid');
  if (!grid) {
    if (typeof trialPerfEnd === 'function') trialPerfEnd(perf, { skipped: 'no-grid' });
    return;
  }
  const ids = [...new Set((machineIds || []).map(Number).filter(Boolean))];
  if (!ids.length) {
    renderTrial();
    if (typeof trialPerfEnd === 'function') trialPerfEnd(perf, { fallback: 'full-render' });
    return;
  }
  const visible = trialVisibleMachines();
  ids.forEach(machineId => {
    const machine = visible.find(row => Number(row.machine_id) === machineId);
    const existing = grid.querySelector(`.trial-machine[data-machine-id="${machineId}"]`);
    if (!machine || !existing) return;
    const oldLane = existing.querySelector('.trial-lane');
    if (typeof destroyTrialSortableForLane === 'function') destroyTrialSortableForLane(oldLane);
    existing.outerHTML = renderTrialMachine(machine);
    if (typeof initTrialMachineSortables === 'function') initTrialMachineSortables([machineId]);
    if (typeof bindTrialLaneOpDrops === 'function') bindTrialLaneOpDrops();
    if (typeof bindTrialLaneBlockClicks === 'function') bindTrialLaneBlockClicks();
  });
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'replace-machine-html', { ids: ids.join(',') });
  if (options.skipCatalog) {
    // Lane-only update.
  } else if (options.deferCatalog) {
    trialDeferCatalogRender();
  } else {
    renderTrialCatalog();
  }
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'render-catalog');
  const reopenQueueId = trialOpenQueueMachineId;
  if (reopenQueueId && ids.includes(reopenQueueId) && typeof openTrialMachineQueue === 'function') {
    window.requestAnimationFrame(() => openTrialMachineQueue(reopenQueueId));
  }
  trialSyncMachineGridScrollWidth();
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'sync-grid-scroll-width');
  if (typeof trialPerfEnd === 'function') {
    trialPerfEnd(perf, {
      rendered_ids: ids.length,
    });
  }
}

function trialCatalogOpExecStatus(card) {
  return card?.execution_status || card?.op?.execution_status || '';
}

function trialPsRollupExecStatus(ps) {
  const cards = ps?.op_cards || [];
  if (cards.some(card => Number(card?.remaining_qty ?? 0) > 0.0001)) {
    const open = cards.find(card => Number(card?.remaining_qty ?? 0) > 0.0001);
    const openStatus = trialNormalizeExecStatus(trialCatalogOpExecStatus(open));
    if (openStatus && openStatus !== 'C' && openStatus !== 'COMPLETED') return openStatus;
    return 'P';
  }
  const statuses = cards
    .map(card => trialCatalogOpExecStatus(card))
    .map(s => trialNormalizeExecStatus(s))
    .filter(Boolean);
  if (!statuses.length) {
    return ps?.current_stage_status || ps?.execution_status || '';
  }
  if (statuses.some(s => s === 'P' || s === 'PENDING_SI')) return 'P';
  if (statuses.some(s => s === 'I' || s === 'IN_PROCESS')) return 'I';
  if (statuses.some(s => s === 'R' || s === 'READY_TO_START')) return 'R';
  if (statuses.length === cards.length && statuses.every(s => s === 'C' || s === 'COMPLETED')) {
    const current = trialNormalizeExecStatus(ps?.current_stage_status || ps?.execution_status || '');
    if (current && current !== 'C' && current !== 'COMPLETED') return current;
    return 'C';
  }
  return ps?.current_stage_status || ps?.execution_status || statuses[0] || '';
}

/** True when an op card still belongs in the planner catalog (not fully done). */
function trialCatalogOpIsOpen(card) {
  const exec = trialNormalizeExecStatus(trialCatalogOpExecStatus(card));
  const remaining = Number(card?.remaining_qty ?? card?.target_qty ?? 0);
  if (remaining > 0.0001) return true;
  const required = Number(card?.wo_qty_required ?? card?.required_qty ?? 0);
  const produced = Number(card?.finished_qty ?? card?.wo_qty_produced ?? 0);
  const hasWoOutput = required > 0.0001 || produced > 0.0001 || Boolean(exec);
  if (!hasWoOutput) return false;
  return exec !== 'C' && exec !== 'COMPLETED';
}

function trialCatalogOpOpenProbe(op) {
  if (!op || typeof op !== 'object') return false;
  return trialCatalogOpIsOpen({
    execution_status: op.execution_status || op.op?.execution_status || '',
    remaining_qty: op.remaining_qty,
    target_qty: op.total_qty ?? op.remaining_qty,
    required_qty: op.required_qty,
    wo_qty_required: op.required_qty,
    finished_qty: op.finished_qty ?? op.erp_finished_qty,
    wo_qty_produced: op.wo_qty_produced ?? op.erp_finished_qty,
    op,
  });
}

function trialCatalogPsHasOpenOps(ps) {
  const cards = ps?.op_cards || [];
  if (cards.some(card => trialCatalogOpIsOpen(card))) return true;
  const allOps = ps?.all_ops || [];
  if (allOps.some(op => trialCatalogOpOpenProbe(op))) return true;
  const current = trialNormalizeExecStatus(ps?.current_stage_status || ps?.execution_status || '');
  return Boolean(current) && current !== 'C' && current !== 'COMPLETED';
}

function trialCatalogPsDueClass(ps) {
  if (trialPsShippedComplete(ps)) return '';
  const dayDiff = trialDateDiffDays(ps?.due_date || '');
  if (dayDiff == null) return '';
  if (dayDiff < 0) return 'overdue';
  if (dayDiff <= 7) return 'due-soon';
  return '';
}

function trialRenderCatalogOpStatusStrip(ps) {
  const chips = (ps?.op_cards || [])
    .map(card => ({
      opNo: card.operation_label || card.source_op_no || '',
      opName: card.operation_name || card.op_type || '',
      status: trialCatalogOpExecStatus(card),
    }))
    .filter(row => trialNormalizeExecStatus(row.status));
  if (!chips.length) return '';
  const maxVisible = 6;
  const visible = chips.slice(0, maxVisible);
  const overflow = chips.length - visible.length;
  return `
    <div class="ps-op-status-strip trial-catalog-op-status-strip">
      ${visible.map(row => trialOpStatusHtml(row.status, { opNo: row.opNo, title: row.opName })).join('')}
      ${overflow > 0 ? `<span class="ps-op-status is-overflow">+${overflow} more</span>` : ''}
    </div>
  `;
}

function trialCatalogPartialLabel(ps, siblingCountByBase) {
  const psId = String(ps.ps_id || '');
  let partialNo = Number(ps.pp_partial_no);
  if (!Number.isFinite(partialNo) || partialNo < 1) {
    partialNo = psId.includes('::') ? Number(psId.split('::')[1]) || 1 : 1;
  }
  const base = trialCatalogSourceBase(ps);
  const siblingCount = base ? Number(siblingCountByBase?.get(base) || 0) : 0;
  if (siblingCount <= 1 && partialNo <= 1 && !psId.includes('::')) return '';
  return `Partial ${partialNo}`;
}

function trialCatalogPsSummaryHtml(ps, siblingCountByBase) {
  const basePsId = String(ps.ps_id || '').split('::')[0] || ps.ps_id || '';
  const partialText = trialCatalogPartialLabel(ps, siblingCountByBase);
  const dueDate = ps.due_date || 'No due date';
  const execStatus = trialPsRollupExecStatus(ps);
  const stageDesc = String(ps.current_stage_desc || '').trim();
  const stageBadge = stageDesc
    ? `<span class="ps-stage-badge" title="${escapeHtml(stageDesc)}">${escapeHtml(stageDesc)}</span>`
    : '';
  const _tipPartNo = ps.part_no || ps.part_name || '';
  const _tipDesc = ps.part_desc || '';
  const _tipHtml = [
    _tipPartNo ? `<span class="tip-part-no">${escapeHtml(_tipPartNo)}</span>` : '',
    _tipDesc ? `<span class="tip-desc">${escapeHtml(_tipDesc)}</span>` : '',
  ].filter(Boolean).join('');
  const _copyText = [_tipPartNo, _tipDesc].filter(Boolean).join('\n');
  return `
    <div class="trial-catalog-ps-main">
      <div class="trial-catalog-ps-id">${escapeHtml(basePsId)}</div>
      ${partialText ? `<div class="trial-catalog-ps-partial">${escapeHtml(partialText)}</div>` : ''}
      ${stageBadge}
      ${trialPendingDoBadgeHtml(ps)}
      ${trialOpStatusHtml(execStatus, { compact: true })}
      ${trialCatalogPsQueuePillHtml(ps)}
    </div>
    <div class="trial-catalog-ps-right">
      <span class="trial-catalog-ps-meta trial-catalog-ps-date">${escapeHtml(dueDate)}</span>
      ${_tipHtml ? `<button class="trial-catalog-info-btn" type="button" onclick="trialCopyInvDesc(event, this)" data-copy-text="${escapeHtml(_copyText)}" aria-label="Copy inventory description"><span class="trial-catalog-info-tip">${_tipHtml}</span></button>` : ''}
    </div>
  `;
}

function trialExecStatusBadge(execStatus) {
  return trialOpStatusHtml(execStatus, { compact: true });
}

function trialPsShippedComplete(ps) {
  if (ps && Object.prototype.hasOwnProperty.call(ps, 'shipped_completed')) {
    return Boolean(ps.shipped_completed);
  }
  const soQty = ps?.so_det_qty;
  if (soQty === null || soQty === undefined || soQty === '') return false;
  const shipped = Number(ps?.qty_shipped || 0);
  return shipped >= Number(soQty) - 0.0001;
}

function trialPsHasComparableSoQty(ps) {
  const soQty = ps?.so_det_qty;
  if (soQty === null || soQty === undefined || soQty === '') return false;
  return Number(soQty) > 0.0001;
}

function trialPsRequiredQty(ps) {
  const direct = Number(ps?.partial_qty ?? ps?.display_qty ?? ps?.wo_req_qty ?? 0);
  if (direct > 0.0001) return direct;
  return 0;
}

function trialPsShippedCoveredByPartial(ps) {
  // Never auto-complete a partial that is still actively queued on machine lanes.
  if (trialPsHasQueuedBlocks(ps)) return false;
  if (trialCatalogPsHasOpenOps(ps)) return false;
  const base = trialCatalogSourceBase(ps);
  if (!base) return false;
  const pools = [
    ...(Array.isArray(trialState.catalog) ? trialState.catalog : []),
    ...(Array.isArray(trialState.planned) ? trialState.planned : []),
  ];
  const siblings = pools
    .filter(item => trialCatalogSourceBase(item) === base)
    .slice()
    .sort((a, b) => {
      const pa = Number(trialSplitPsId(a?.ps_id || '').partial || a?.pp_partial_no || 1);
      const pb = Number(trialSplitPsId(b?.ps_id || '').partial || b?.pp_partial_no || 1);
      return pa - pb;
    });
  if (!siblings.length) return false;
  const tol = 0.0001;
  const directReqs = siblings.map(item => Math.max(0, trialPsRequiredQty(item)));
  const positiveReqs = directReqs.filter(value => value > tol);
  const sourceTotal = Math.max(
    0,
    ...siblings.map(item => Number(item?.total_qty ?? 0)),
  );
  const inferredUnitReq = positiveReqs.length
    ? (positiveReqs.reduce((sum, value) => sum + value, 0) / positiveReqs.length)
    : (siblings.length > 0 ? (sourceTotal / siblings.length) : 0);
  let shippedLeft = Math.max(
    0,
    ...siblings.map(item => Number(item?.qty_shipped || 0)),
  );
  for (const item of siblings) {
    const directReq = Math.max(0, trialPsRequiredQty(item));
    const req = directReq > tol ? directReq : Math.max(0, inferredUnitReq);
    if (req <= tol) continue;
    const covered = Math.min(req, shippedLeft);
    const same = String(item?.ps_id || '') === String(ps?.ps_id || '');
    shippedLeft = Math.max(0, shippedLeft - covered);
    if (!same) continue;
    return covered >= (req - tol);
  }
  return false;
}

function trialPsProductionComplete(ps) {
  const cards = (ps?.op_cards && ps.op_cards.length) ? ps.op_cards : (ps?.ops || []);
  if (!cards.length) {
    const exec = trialNormalizeExecStatus(trialPsRollupExecStatus(ps));
    return exec === 'C' || exec === 'COMPLETED';
  }
  const tracked = cards.filter(card => {
    const exec = trialNormalizeExecStatus(trialCatalogOpExecStatus(card));
    const required = Number(card?.wo_qty_required ?? card?.required_qty ?? 0);
    const produced = Number(card?.finished_qty ?? card?.wo_qty_produced ?? 0);
    return required > 0.0001 || produced > 0.0001 || Boolean(exec);
  });
  if (!tracked.length) {
    const exec = trialNormalizeExecStatus(ps?.current_stage_status || ps?.execution_status || '');
    return exec === 'C' || exec === 'COMPLETED';
  }
  return tracked.every(card => {
    const remaining = Number(card?.remaining_qty ?? card?.target_qty ?? 0);
    const exec = trialNormalizeExecStatus(trialCatalogOpExecStatus(card));
    return (exec === 'C' || exec === 'COMPLETED') && remaining <= 0.0001;
  });
}

/** True when the PS should be treated as completed for Show completed (catalog sidebar). */
function trialPsCatalogCompleted(ps) {
  if (trialPsHasQueuedBlocks(ps)) return false;
  if (trialCatalogPsHasOpenOps(ps)) return false;
  if (trialPsShippedCoveredByPartial(ps)) return true;
  if (trialPsShippedComplete(ps)) return true;
  if (trialPsPendingDo(ps)) return false;
  if (ps && Object.prototype.hasOwnProperty.call(ps, 'erp_all_wo_complete')) {
    return Boolean(ps.erp_all_wo_complete);
  }
  return trialPsProductionComplete(ps);
}

/** Production done on all stages; SO line not fully shipped yet. */
function trialPsPendingDo(ps) {
  if (ps && Object.prototype.hasOwnProperty.call(ps, 'pending_do')) {
    return Boolean(ps.pending_do);
  }
  if (!trialPsHasComparableSoQty(ps) || trialPsShippedComplete(ps)) return false;
  return trialPsProductionComplete(ps);
}

function trialPendingDoBadgeHtml(ps) {
  if (!trialPsPendingDo(ps)) return '';
  const shipped = Number(ps?.qty_shipped || 0);
  const soQty = Number(ps?.so_det_qty || 0);
  const title = soQty > 0
    ? `All stages completed · Shipped ${shipped} / SO ${soQty}`
    : 'All stages completed · awaiting full SO shipment';
  return `<span class="ps-pending-do-badge" title="${escapeHtml(title)}">Pending DO</span>`;
}

function trialPsCatalogExecStatus(ps) {
  return trialPsRollupExecStatus(ps);
}

// ── Catalog render ────────────────────────────────────────────────────────────

const _PS_TYPE_ORDER = { A: 0, M: 1, N: 2 };

function trialCatalogDueDateSortKey(ps) {
  const dueDate = String(ps?.due_date || '').trim().slice(0, 10);
  if (!dueDate) return Number.POSITIVE_INFINITY;
  const ts = new Date(`${dueDate}T00:00:00`).getTime();
  return Number.isNaN(ts) ? Number.POSITIVE_INFINITY : ts;
}

function trialCompareCatalogPs(a, b) {
  if (trialCatalogSortByDueDate) {
    const da = trialCatalogDueDateSortKey(a);
    const db = trialCatalogDueDateSortKey(b);
    if (da !== db) return da - db;
  }
  const ta = _PS_TYPE_ORDER[trialGetPsType(a.ps_id)] ?? 9;
  const tb = _PS_TYPE_ORDER[trialGetPsType(b.ps_id)] ?? 9;
  return ta !== tb ? ta - tb : String(a.ps_id).localeCompare(String(b.ps_id));
}

function updateTrialCatalogDueDateSortButton() {
  const btn = document.getElementById('trial-catalog-due-sort-btn');
  if (!btn) return;
  btn.classList.toggle('is-active', trialCatalogSortByDueDate);
  btn.setAttribute('aria-pressed', trialCatalogSortByDueDate ? 'true' : 'false');
  btn.textContent = trialCatalogSortByDueDate ? 'Due date ↑' : 'Sort by due';
}

function toggleTrialCatalogDueDateSort() {
  trialCatalogSortByDueDate = !trialCatalogSortByDueDate;
  updateTrialCatalogDueDateSortButton();
  renderTrialCatalog();
}

function trialNormalizeSearchText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function trialSearchableTokens(values) {
  const raw = values
    .map(value => String(value == null ? '' : value).trim())
    .filter(Boolean);
  const normalized = raw.map(trialNormalizeSearchText).filter(Boolean);
  return [...raw, ...normalized];
}

function trialCatalogHaystack(ps) {
  const psId = String(ps.ps_id || '');
  const psParts = trialSplitPsId(psId);
  const opCards = ps.op_cards || [];
  const opRows = ps.ops || [];
  return trialSearchableTokens([
    psId,
    psParts.base,
    psParts.partial ? `partial ${psParts.partial}` : '',
    ps.source_ps_id,
    ps.display_ps_id,
    ps.pp_partial_no,
    ps.part_name,
    ps.part_no,
    ps.part_desc,
    ps.due_date,
    ps.status,
    ps.execution_status,
    ps.current_stage_desc,
    trialPsErpBomCode(ps),
    ps.bom_code,
    ps.selected_bom_code,
    ps.inventory_code,
    ...opRows.flatMap(op => [op.op_no, op.op_type, op.machine_category, op.preferred_machine, op.source_op_no]),
    ...opCards.flatMap(card => [card.operation_label, card.operation_name, card.source_op_no, card.source_op_seq_id]),
  ]).join(' ');
}

function trialPlannedHaystack(ps) {
  const psId = String(ps.ps_id || '');
  const psParts = trialSplitPsId(psId);
  const opCards = ps.op_cards || [];
  return trialSearchableTokens([
    psId,
    psParts.base,
    psParts.partial ? `partial ${psParts.partial}` : '',
    ps.source_ps_id,
    ps.display_ps_id,
    ps.pp_partial_no,
    ps.part_name,
    ps.part_no,
    ps.part_desc,
    ps.due_date,
    ps.status,
    ps.planner_status,
    ps.execution_status,
    ps.current_stage_desc,
    ps.inventory_code,
    ...opCards.flatMap(card => [card.operation_label, card.operation_name, card.source_op_no, card.source_op_seq_id]),
  ]).join(' ');
}

function renderTrialCatalog() {
  const perf = (typeof trialPerfStart === 'function')
    ? trialPerfStart('render-trial-catalog', {
      catalog_rows: Array.isArray(trialState.catalog) ? trialState.catalog.length : 0,
      planned_rows: Array.isArray(trialState.planned) ? trialState.planned.length : 0,
    })
    : null;
  trialResetRenderIndexes();
  renderTrialPsTypeFilter();
  updateTrialCatalogDueDateSortButton();
  const root = document.getElementById('trial-catalog');
  if (!root) {
    if (typeof trialPerfEnd === 'function') trialPerfEnd(perf, { skipped: 'no-catalog-root' });
    return;
  }
  const queryInput = document.getElementById('trial-catalog-search');
  const rawQuery = String(queryInput ? queryInput.value : trialCatalogSearch || '').trim().toLowerCase();
  const normalizedQuery = trialNormalizeSearchText(rawQuery);
  trialCatalogSearch = rawQuery;
  const catalogHaystackCache = new WeakMap();
  const plannedHaystackCache = new WeakMap();
  const resolvedCardsCache = new WeakMap();
  const allocatedCardCache = new Map();
  const siblingCountByBase = new Map();
  (trialState.catalog || []).forEach(ps => {
    const base = trialCatalogSourceBase(ps);
    if (!base) return;
    siblingCountByBase.set(base, Number(siblingCountByBase.get(base) || 0) + 1);
  });

  const cachedCatalogHaystack = ps => {
    if (catalogHaystackCache.has(ps)) return catalogHaystackCache.get(ps);
    const haystack = trialCatalogHaystack(ps);
    catalogHaystackCache.set(ps, haystack);
    return haystack;
  };

  const cachedPlannedHaystack = ps => {
    if (plannedHaystackCache.has(ps)) return plannedHaystackCache.get(ps);
    const haystack = trialPlannedHaystack(ps);
    plannedHaystackCache.set(ps, haystack);
    return haystack;
  };

  const cachedResolvedCards = ps => {
    if (resolvedCardsCache.has(ps)) return resolvedCardsCache.get(ps);
    const cards = trialResolvedOpCardsForPs(ps);
    resolvedCardsCache.set(ps, cards);
    return cards;
  };

  const cachedIsOpAllocated = card => {
    const key = [
      String(card?.source_ps_id || card?.ps_id || '').trim(),
      String(card?.source_op_no || card?.operation_label || '').trim(),
      String(card?.source_op_seq_id || card?.source_step_id || '').trim(),
      String(card?.card_id || '').trim(),
    ].join('|');
    if (allocatedCardCache.has(key)) return allocatedCardCache.get(key);
    const allocated = trialIsCatalogOpAllocated(card);
    allocatedCardCache.set(key, allocated);
    return allocated;
  };

  const catalogMatchesSearch = ps => {
    if (!rawQuery) return true;
    const haystack = cachedCatalogHaystack(ps);
    if (haystack.includes(rawQuery)) return true;
    return normalizedQuery ? haystack.includes(normalizedQuery) : false;
  };

  const catalog = (trialState.catalog || []).filter(ps => {
    const psType = trialGetPsType(ps.ps_id);
    if (!trialPsTypeFilter.has(psType)) return false;
    if (!trialShowSrOrders && String(ps.ps_id || '').includes('[SR]')) return false;
    if (trialHidePendingDo && trialPsPendingDo(ps)) return false;
    if (trialHideBlankPs && trialPsIsUnassignedCatalog(ps)) return false;
    if (!trialShowCompleted && trialPsCatalogCompleted(ps)) return false;
    return catalogMatchesSearch(ps);
  });
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'filter-catalog', { kept: catalog.length });

  if (rawQuery) {
    const matchedBases = new Set(
      catalog.map(ps => trialCatalogSourceBase(ps).toLowerCase()).filter(Boolean),
    );
    const seen = new Set(catalog.map(ps => String(ps.ps_id || '')));
    for (const ps of trialState.catalog || []) {
      const base = trialCatalogSourceBase(ps).toLowerCase();
      const psId = String(ps.ps_id || '');
      if (!base || !matchedBases.has(base) || seen.has(psId)) continue;
      if (!trialPsTypeFilter.has(trialGetPsType(ps.ps_id))) continue;
      if (!trialShowSrOrders && psId.includes('[SR]')) continue;
      if (trialHidePendingDo && trialPsPendingDo(ps)) continue;
      if (trialHideBlankPs && trialPsIsUnassignedCatalog(ps)) continue;
      if (!trialShowCompleted && trialPsCatalogCompleted(ps)) continue;
      catalog.push(ps);
      seen.add(psId);
    }
  }

  catalog.sort(trialCompareCatalogPs);

  const plannedCatalog = (trialState.planned || []).filter(ps => {
    const psType = trialGetPsType(ps.ps_id);
    if (!trialPsTypeFilter.has(psType)) return false;
    if (!trialShowSrOrders && String(ps.ps_id || '').includes('[SR]')) return false;
    if (trialHidePendingDo && trialPsPendingDo(ps)) return false;
    if (trialHideBlankPs && trialPsIsUnassignedCatalog(ps)) return false;
    if (!trialShowCompleted && trialPsCatalogCompleted(ps)) return false;
    if (!rawQuery) return true;
    const haystack = cachedPlannedHaystack(ps);
    if (haystack.includes(rawQuery)) return true;
    return normalizedQuery ? haystack.includes(normalizedQuery) : false;
  }).sort(trialCompareCatalogPs);
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'filter-planned', { kept: plannedCatalog.length });

  if (!catalog.length && !plannedCatalog.length) {
    root.innerHTML = `<div class="trial-catalog-empty">No available PS / ops match this search.</div>`;
    if (typeof trialPerfEnd === 'function') trialPerfEnd(perf, { empty: true });
    return;
  }

  const isOpAllocated = card => cachedIsOpAllocated(card);

  const catalogWithOpenOps = catalog.filter(ps => {
    if (trialHideBlankPs && trialPsIsUnassignedCatalog(ps)) return false;
    const cards = cachedResolvedCards(ps);
    const hasOpenOps = cards.some(card => trialCatalogOpIsOpen(card) || isOpAllocated(card))
      || trialCatalogPsHasOpenOps(ps);
    if (!trialShowCompleted) return hasOpenOps;
    // Show completed on: include shipped jobs and any PS with stage rows for reference.
    if (!trialPsShippedComplete(ps) && (ps.op_cards || []).length) return true;
    return hasOpenOps;
  });

  const availableHtml = catalogWithOpenOps.map(ps => {
    const psIdParts = String(ps.ps_id || '').split('::');
    const basePsId = psIdParts[0] || ps.ps_id || '';
    const cards = cachedResolvedCards(ps);
    const opCardsHtml = cards
      .filter(card => trialCatalogOpIsOpen(card) || isOpAllocated(card))
      .map(card => renderTrialOpCardHtml({
        ...card,
        is_allocated: isOpAllocated(card),
        part_no: card.part_no || ps.part_no || ps.part_name || '',
        source_ps_id: card.source_ps_id || ps.ps_id || basePsId,
      }))
      .join('');
    const dueClass = trialCatalogPsDueClass(ps);
    return `
      <details class="trial-catalog-ps ${dueClass}" ${rawQuery ? 'open' : ''}
        data-ps-id="${escapeHtml(ps.ps_id || '')}">
        <summary>${trialCatalogPsSummaryHtml(ps, siblingCountByBase)}</summary>
        ${trialRenderCatalogOpStatusStrip(ps)}
        ${trialCatalogBomBarHtml(ps)}
        <div class="trial-catalog-oplist">${opCardsHtml}</div>
      </details>
    `;
  }).join('');
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'build-available-html', { ps: catalogWithOpenOps.length });

  const plannedWithOpenOps = plannedCatalog.filter(ps => {
    if (trialHideBlankPs && trialPsIsUnassignedCatalog(ps)) return false;
    const cards = cachedResolvedCards(ps);
    const hasOpenOps = cards.some(card => trialCatalogOpIsOpen(card) || isOpAllocated(card));
    if (hasOpenOps) return true;
    // Other PS: show header-only rows (no work orders) when not hiding unassigned.
    return !trialHideBlankPs && !(ps.op_cards || []).length;
  });

  const plannedHtml = plannedWithOpenOps.map(ps => `
    <div class="trial-catalog-ps trial-catalog-planned-ps" data-ps-id="${escapeHtml(ps.ps_id || '')}">
      <div class="trial-catalog-planned-head">
        <div class="trial-catalog-ps-main">
          <div class="trial-catalog-ps-id">${escapeHtml(String(ps.ps_id || '').split('::')[0] || ps.ps_id || '')}</div>
          ${trialCatalogPsQueuePillHtml(ps)}
        </div>
        <div class="trial-catalog-planned-right">
          <span class="trial-catalog-planned-badge">Planned</span>
          <span class="trial-catalog-ps-meta trial-catalog-ps-date">${escapeHtml(ps.due_date || 'No due date')}</span>
          ${(ps.part_name || ps.part_no || ps.part_desc) ? (() => { const _pn = ps.part_name || ps.part_no || ''; const _pd = ps.part_desc || ''; const _ct = [_pn, _pd].filter(Boolean).join('\n'); return `<button class="trial-catalog-info-btn" type="button" onclick="trialCopyInvDesc(event, this)" data-copy-text="${escapeHtml(_ct)}" aria-label="Copy inventory description"><span class="trial-catalog-info-tip">${_pn ? `<span class="tip-part-no">${escapeHtml(_pn)}</span>` : ''}${_pd ? `<span class="tip-desc">${escapeHtml(_pd)}</span>` : ''}</span></button>`; })() : ''}
        </div>
      </div>
      ${trialCatalogBomBarHtml(ps)}
      <div class="trial-catalog-oplist">
        ${cachedResolvedCards(ps)
          .filter(card => trialCatalogOpIsOpen(card) || isOpAllocated(card))
          .map(card => renderTrialOpCardHtml({
            ...card,
            is_allocated: isOpAllocated(card),
            part_no: card.part_no || ps.part_no || ps.part_name || '',
            source_ps_id: card.source_ps_id || ps.ps_id || '',
          }))
          .join('')}
      </div>
    </div>
  `).join('');
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'build-planned-html', { ps: plannedWithOpenOps.length });

  root.innerHTML = `
    <div class="trial-catalog-section">
      <div class="trial-catalog-section-head">
        <div class="trial-catalog-section-title">Operations</div>
      </div>
      <div class="trial-catalog-section-body">
        ${availableHtml || `<div class="trial-catalog-empty">No available PS / ops match this search.</div>`}
      </div>
    </div>
    <div class="trial-catalog-section">
      <div class="trial-catalog-section-head">
        <div class="trial-catalog-section-title">Other PS</div>
      </div>
      <div class="trial-catalog-section-body">
        ${plannedHtml || `<div class="trial-catalog-empty">No other PS match this search.</div>`}
      </div>
    </div>
  `;
  decorateTrialCatalogCards();
  bindTrialCatalogDnD();
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'bind-catalog-dnd');
  if (typeof trialPerfEnd === 'function') {
    trialPerfEnd(perf, {
      available_ps: catalogWithOpenOps.length,
      planned_ps: plannedWithOpenOps.length,
      query: rawQuery || '',
    });
  }
}

function trialCopyInvDesc(event, btn) {
  event.stopPropagation();
  const text = btn.dataset.copyText || '';
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  }).catch(() => {});
}

function decorateTrialCatalogCards() {
  // Inline in renderTrialCatalog.
}

function updateTrialCompletedButton() {
  const btn = document.getElementById('trial-completed-toggle');
  if (btn) btn.textContent = trialShowCompleted ? 'Hide completed' : 'Show completed';
}
