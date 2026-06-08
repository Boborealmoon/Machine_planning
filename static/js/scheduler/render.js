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

function trialCatalogPsRecord(psId) {
  const needle = String(psId || '').trim();
  if (!needle) return null;
  const pools = [
    ...(Array.isArray(trialState.catalog) ? trialState.catalog : []),
    ...(Array.isArray(trialState.planned) ? trialState.planned : []),
  ];
  return pools.find(ps => String(ps.ps_id || '').trim() === needle) || null;
}

function trialMaterialInFromScheduleBlocks(psId) {
  const needle = String(psId || '').trim();
  if (!needle) return null;
  const parts = trialSplitPsId(needle);
  const base = String(parts.base || needle).trim();
  const partial = String(parts.partial || '').trim();
  for (const block of (Array.isArray(trialState.blocks) ? trialState.blocks : [])) {
    if (!Object.prototype.hasOwnProperty.call(block, 'material_in')) continue;
    const blockKey = String(block.planner_ps_id || block.source_ps_id || block.job_no || '').trim();
    if (!blockKey) continue;
    const blockParts = trialSplitPsId(blockKey);
    const blockBase = String(blockParts.base || blockKey).trim();
    const blockPartial = String(blockParts.partial || '').trim();
    if (blockKey === needle) return Boolean(block.material_in);
    if (blockBase === base && (!partial || !blockPartial || partial === blockPartial)) {
      return Boolean(block.material_in);
    }
  }
  return null;
}

function trialMaterialInForPsId(psId) {
  const key = String(psId || '').trim();
  if (!key) return false;
  if (trialMaterialInOverrides.has(key)) {
    return Boolean(trialMaterialInOverrides.get(key));
  }
  const fromBlocks = trialMaterialInFromScheduleBlocks(key);
  if (fromBlocks !== null) return fromBlocks;
  const ps = trialCatalogPsRecord(key);
  return Boolean(ps?.material_in);
}

function trialMaterialInForBlockLeader(leader) {
  if (leader && Object.prototype.hasOwnProperty.call(leader, 'material_in')) {
    return Boolean(leader.material_in);
  }
  const candidates = [leader?.planner_ps_id, leader?.source_ps_id, leader?.job_no]
    .map(v => String(v || '').trim())
    .filter(Boolean);
  const psKey = candidates.find(v => v.includes('::')) || candidates[0] || '';
  return trialMaterialInForPsId(psKey);
}

function trialMaterialInLaneClass(leader) {
  if (!leader?.block_id) return '';
  return trialMaterialInForBlockLeader(leader) ? 'material-in-yes' : 'material-in-no';
}

function trialMaterialInPillMeta(materialIn) {
  if (materialIn) {
    return {
      stateClass: 'is-in',
      label: 'In stock',
      title: 'Raw material is in — click to mark as awaiting',
    };
  }
  return {
    stateClass: 'is-out',
    label: 'Awaiting',
    title: 'Raw material not in yet — click when stock arrives',
  };
}

function trialMaterialInPillSync(pill, materialIn) {
  if (!pill) return;
  const meta = trialMaterialInPillMeta(materialIn);
  pill.classList.toggle('is-in', Boolean(materialIn));
  pill.classList.toggle('is-out', !materialIn);
  pill.setAttribute('aria-pressed', materialIn ? 'true' : 'false');
  pill.title = meta.title;
  const textEl = pill.querySelector('.trial-material-in-text');
  if (textEl) textEl.textContent = meta.label;
}

function trialCatalogMaterialInCheckboxHtml(ps) {
  const psId = String(ps.ps_id || '').trim();
  if (!psId) return '';
  const checked = trialMaterialInForPsId(psId);
  const meta = trialMaterialInPillMeta(checked);
  return `
    <label class="trial-material-in-pill ${meta.stateClass}"
      title="${escapeHtml(meta.title)}"
      aria-pressed="${checked ? 'true' : 'false'}"
      aria-label="${escapeHtml(meta.label)}"
      onclick="event.stopPropagation()">
      <input type="checkbox" class="trial-material-in-input"
        data-ps-id="${escapeHtml(psId)}"
        ${checked ? 'checked' : ''}
        tabindex="-1"
        aria-hidden="true"
        onchange="trialSetMaterialIn(event, this)">
      <span class="trial-material-in-dot" aria-hidden="true"></span>
      <span class="trial-material-in-text">${escapeHtml(meta.label)}</span>
    </label>
  `;
}

async function trialSetMaterialIn(event, input) {
  if (event) event.stopPropagation();
  const psId = String(input?.dataset?.psId || '').trim();
  if (!psId || input.disabled) return;
  const materialIn = Boolean(input.checked);
  const previous = trialMaterialInForPsId(psId);
  const pill = input.closest('.trial-material-in-pill');
  trialMaterialInOverrides.set(psId, materialIn);
  trialApplyMaterialInToCatalogPs(psId, materialIn);
  trialMaterialInPillSync(pill, materialIn);
  input.disabled = true;
  if (pill) pill.classList.add('is-saving');
  try {
    await POST('/api/process-sheets/stock-in-flag', { ps_id: psId, material_in: materialIn });
    if (typeof trialInvalidateCatalogCache === 'function') trialInvalidateCatalogCache();
    if (typeof renderTrial === 'function') renderTrial({ preserveScroll: true });
  } catch (err) {
    trialMaterialInOverrides.set(psId, previous);
    trialApplyMaterialInToCatalogPs(psId, previous);
    input.checked = previous;
    trialMaterialInPillSync(pill, previous);
    window.alert(err?.message || 'Could not save material-in flag');
  } finally {
    input.disabled = false;
    if (pill) pill.classList.remove('is-saving');
  }
}

function trialApplyMaterialInToCatalogPs(psId, materialIn) {
  const key = String(psId || '').trim();
  if (!key) return;
  const pools = [
    ...(Array.isArray(trialState.catalog) ? trialState.catalog : []),
    ...(Array.isArray(trialState.planned) ? trialState.planned : []),
  ];
  pools.forEach(ps => {
    if (String(ps.ps_id || '').trim() === key) ps.material_in = Boolean(materialIn);
  });
}

function trialProfileOptions(selected) {
  return (trialState.profiles || []).map(profile => {
    const sel = String(profile.profile_name) === String(selected) ? 'selected' : '';
    return `<option value="${profile.profile_name}" ${sel}>${profile.profile_name} (${profile.capacity_minutes}m)</option>`;
  }).join('');
}

function trialBlockPsDisplay(group, leader) {
  const row = leader || {};
  if (typeof trialCatalogPartialIndex === 'function' && typeof trialCatalogSourceBase === 'function') {
    const base = trialCatalogSourceBase({
      planner_ps_id: row.planner_ps_id,
      ps_id: group?.ps_id,
      source_ps_id: row.source_ps_id,
      job_no: row.job_no,
    });
    if (base) {
      if (base.startsWith('[Temp]')) {
        return { base: trialTempPsDisplayId(base), partial: '' };
      }
      const partialNo = trialCatalogPartialIndex({
        planner_ps_id: row.planner_ps_id,
        pp_partial_no: row.pp_partial_no,
        ps_id: group?.ps_id,
        source_ps_id: row.source_ps_id,
        job_no: row.job_no,
      });
      return {
        base,
        partial: partialNo > 1 ? String(partialNo) : '',
      };
    }
  }
  const candidates = [leader?.planner_ps_id, leader?.job_no, group?.ps_id, leader?.source_ps_id]
    .map(v => String(v || '').trim())
    .filter(Boolean);
  const raw = candidates.find(v => v.includes('::')) || candidates[0] || '';
  if (raw.startsWith('[Temp]')) {
    return { base: trialTempPsDisplayId(raw), partial: '' };
  }
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
  { key: 'T', label: '[Temp]' },
];

function trialGetPsType(psId) {
  const raw = String(psId || '').trim();
  if (/^\[Temp\]/i.test(raw) || raw.toUpperCase().startsWith('[TEMP]')) return 'T';
  return raw.toUpperCase()[0] || '?';
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
  if (typeof trialIsTempCatalogPs === 'function' && trialIsTempCatalogPs(ps)) {
    const raw = String(ps?.ps_id || ps?.source_ps_id || ps?.job_no || '').trim();
    if (raw.startsWith('[Temp]')) return trialSplitPsId(raw).base || raw;
    return String(ps?.ps_id || '').trim();
  }
  const raw = String(ps?.source_ps_id || ps?.ps_id || ps?.job_no || '').trim();
  if (!raw) return '';
  return trialSplitPsId(raw).base || raw;
}

/** Hide the ERP source PS when a [Temp] reject/rework line covers the same partial. */
function trialCatalogSupersededByTempSibling(ps, pool) {
  if (ps?.is_temp_ps || (typeof trialIsTempCatalogPs === 'function' && trialIsTempCatalogPs(ps))) {
    return false;
  }
  const sourceKey = String(
    ps?.source_ps_id || trialSplitPsId(String(ps?.ps_id || '')).base || '',
  ).trim();
  if (!sourceKey || sourceKey.startsWith('[Temp]')) return false;
  const partial = trialCatalogPartialIndex(ps);
  return (pool || []).some(row => {
    if (!row?.is_temp_ps) return false;
    if (String(row?.source_ps_id || '').trim() !== sourceKey) return false;
    const tempPartial = Number(row?.source_pp_partial_no || row?.pp_partial_no || 1);
    return tempPartial === partial;
  });
}

let trialCatalogDueDateIndex = null;
let trialQueueBlocksIndex = null;
let trialQueueBlockSourceSet = null;

function trialResetRenderIndexes() {
  trialCatalogDueDateIndex = null;
  trialQueueBlocksIndex = null;
  trialQueueBlockSourceSet = null;
}

function trialIndexDueDateKeys(index, psKey, dueDate) {
  const text = String(dueDate || '').trim();
  if (!text || !psKey) return;
  const parts = trialSplitPsId(psKey);
  const base = String(parts.base || psKey).trim();
  const partial = String(parts.partial || '').trim();
  [psKey, base].filter(Boolean).forEach(key => {
    if (!index.has(key)) index.set(key, text);
  });
  if (base) {
    const exactKey = partial ? `${base}::${partial}` : base;
    if (!index.has(exactKey)) index.set(exactKey, text);
  }
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
  (Array.isArray(trialState.blocks) ? trialState.blocks : []).forEach(block => {
    const psKey = String(block?.planner_ps_id || block?.source_ps_id || block?.job_no || '').trim();
    trialIndexDueDateKeys(index, psKey, block?.due_date);
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
    const blockSource = trialCatalogSourceBase({
      planner_ps_id: block.planner_ps_id,
      source_ps_id: block.source_ps_id || block.job_no,
    });
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
  return blocks.some(block => {
    const raw = String(block.source_ps_id || block.job_no || '');
    if (raw.includes('::')) {
      return trialCatalogPartialIndex(raw) === wantPartial;
    }
    return wantPartial === 1;
  });
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

function trialCatalogOpCardKey(card) {
  const opNo = String(card?.source_op_no || card?.operation_label || '').trim();
  // BOM saves replace planner_operation_seq rows; queued blocks may still carry stale seq ids.
  if (opNo) return opNo;
  const opSeq = Number(card?.source_op_seq_id || 0);
  return opSeq > 0 ? `step:${opSeq}` : '';
}

function trialQueuedOpCardsForPs(ps) {
  const blocks = (typeof trialBlocksForCatalogPs === 'function')
    ? trialBlocksForCatalogPs(ps)
    : [];
  if (!blocks.length) return [];
  const opMap = new Map();
  blocks.forEach(block => {
    const opNo = String(block.source_op_no || '').trim() || String(block.operation_name || '').trim();
    const opSeq = Number(block.source_op_seq_id || 0);
    const key = opNo || (opSeq > 0 ? `step:${opSeq}` : '');
    if (!key) return;
    const metrics = trialBlockMemberMetrics(block);
    const existing = opMap.get(key) || {
      card_kind: 'single',
      card_id: null,
      ps_id: ps.ps_id || block.source_ps_id || '',
      pp_partial_no: trialCatalogPartialIndex(ps),
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
  const stampPs = (card) => ({
    ...card,
    ps_id: card?.ps_id || ps?.ps_id || '',
    pp_partial_no: card?.pp_partial_no ?? ps?.pp_partial_no,
  });
  const baseCards = (Array.isArray(ps?.op_cards) ? ps.op_cards : []).map(stampPs);
  const queuedCards = trialQueuedOpCardsForPs(ps);
  const seen = new Set(baseCards.map(trialCatalogOpCardKey));
  const merged = [...baseCards];
  queuedCards.forEach(card => {
    const key = trialCatalogOpCardKey(card);
    if (seen.has(key)) {
      const idx = merged.findIndex(row => trialCatalogOpCardKey(row) === key);
      if (idx >= 0) {
        const base = merged[idx];
        const queuedQty = Number(card.total_qty || card.target_qty || 0);
        merged[idx] = {
          ...base,
          is_allocated: true,
          is_scheduled: card.is_scheduled || base.is_scheduled,
          queued_machines: card.queued_machines || base.queued_machines,
          machine_id: card.machine_id || base.machine_id,
          machine_code: card.machine_code || base.machine_code,
          planned_qty: Math.max(Number(base.planned_qty || 0), queuedQty),
        };
      }
      return;
    }
    merged.push(card);
    seen.add(key);
  });
  const allOps = Array.isArray(ps?.all_ops) ? ps.all_ops : [];
  allOps.forEach(op => {
    const card = {
      card_kind: 'single',
      card_id: null,
      ps_id: op.source_ps_id || ps?.ps_id || '',
      pp_partial_no: op.pp_partial_no ?? ps?.pp_partial_no,
      source_ps_id: op.source_ps_id || ps?.ps_id || '',
      operation_label: op.source_op_no || op.operation_name || op.op_no || '',
      operation_name: op.op_type || op.operation_name || '',
      target_qty: Number(op.remaining_qty || 0),
      remaining_qty: Number(op.remaining_qty || 0),
      required_qty: Number(op.required_qty || 0),
      planned_qty: Number(op.planned_qty || 0),
      erp_finished_qty: Number(op.erp_finished_qty || 0),
      source_op_seq_id: Number(op.source_op_seq_id || 0),
      source_op_no: op.source_op_no || '',
      source_kind: op.source_kind || '',
      is_manual_bom: trialCatalogOpIsManualBom(op),
      execution_status: op.execution_status || '',
      queued_machines: op.queued_machines || [],
      is_allocated: Boolean(op.is_allocated),
      setup_minutes: Number(op.setup_time || 0),
      cycle_minutes_per_qty: Number(op.cycle_time || 0),
      compatible_machine_group: op.compatible_machine_group || op.machine_category || '',
      op,
    };
    const key = trialCatalogOpCardKey(card);
    if (seen.has(key)) return;
    if (!trialCatalogOpShouldShow(card, () => false)) return;
    merged.push(card);
    seen.add(key);
  });
  return merged.sort((a, b) =>
    Number(a.source_op_seq_id || 0) - Number(b.source_op_seq_id || 0) ||
    String(a.source_op_no || a.operation_label || '').localeCompare(String(b.source_op_no || b.operation_label || ''))
  );
}

function trialCatalogOpIsComplete(card) {
  if (!card || trialCatalogOpIsManualBom(card)) return false;
  if (trialCatalogOpIsOpen(card)) return false;
  const exec = trialNormalizeExecStatus(trialCatalogOpExecStatus(card));
  if (exec === 'C' || exec === 'COMPLETED') return true;
  const required = Number(card?.required_qty ?? card?.wo_qty_required ?? 0);
  const produced = Number(card?.finished_qty ?? card?.erp_finished_qty ?? card?.wo_qty_produced ?? 0);
  if (required > 0.0001 && produced >= required - 0.0001) return true;
  const remaining = Number(card?.remaining_qty ?? card?.target_qty ?? 0);
  const hasWork = required > 0.0001 || produced > 0.0001;
  return remaining <= 0.0001 && hasWork;
}

function trialCatalogOpShouldShow(card, isOpAllocated) {
  return trialCatalogOpIsOpen(card)
    || trialCatalogOpIsComplete(card)
    || trialCatalogOpIsManualBom(card)
    || isOpAllocated(card)
    || trialCatalogOpHasQueuedBlocks(card);
}

function trialPsIsUnassignedCatalog(ps) {
  if (ps?.is_temp_ps) {
    const cards = trialResolvedOpCardsForPs(ps);
    if (cards.length) return false;
  }
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
        ${allocatedBlock?.block_id
          ? `<button type="button" class="btn btn-ghost btn-sm trial-op-detail-remove"
            onclick="removeTrialBlock(${Number(allocatedBlock.block_id)}, ${Number(allocatedBlock.group_id || 0)})">Remove from queue</button>`
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

function openTrialCatalogOpDetailFromPs(psId, sourceOpNo, sourceOpSeqId, cardId) {
  openTrialCatalogOpDetail({
    ps_id: String(psId || '').trim(),
    source_ps_id: String(psId || '').trim(),
    source_op_no: String(sourceOpNo || '').trim(),
    source_op_seq_id: Number(sourceOpSeqId || 0),
    card_id: Number(cardId || 0),
  });
}

function trialCatalogInfoBtnHtml(ps) {
  const psId = String(ps?.ps_id || '').trim();
  if (!psId) return '';
  const tipPartNo = ps.part_no || ps.part_name || '';
  const tipDesc = ps.part_desc || '';
  const tipHtml = [
    tipPartNo ? `<span class="tip-part-no">${escapeHtml(tipPartNo)}</span>` : '',
    tipDesc ? `<span class="tip-desc">${escapeHtml(tipDesc)}</span>` : '',
  ].filter(Boolean).join('');
  return `
    <button class="trial-catalog-info-btn" type="button"
      onclick="openTrialCatalogPsDetail(event, '${escapeHtml(psId)}')"
      aria-label="View PS / partial details"
      title="View PS / partial details">
      ${tipHtml ? `<span class="trial-catalog-info-tip">${tipHtml}</span>` : ''}
    </button>
  `;
}

function trialRenderCatalogPsDetailOpRow(ps, card) {
  const ctx = typeof trialCatalogOpForPs === 'function' ? trialCatalogOpForPs(card, ps) : card;
  const opDisp = trialBlockOpDisplay({
    source_op_no: ctx.source_op_no || ctx.operation_label,
    operation_name: ctx.operation_name || ctx.op_type || '',
  });
  const execStatus = ctx.execution_status || ctx.op?.execution_status || '';
  const execHtml = trialOpStatusHtml(execStatus, {
    opNo: opDisp.op_no,
    title: opDisp.op_name,
    compact: true,
  });
  const psId = String(ps.ps_id || '').trim();
  const opNo = String(ctx.source_op_no || ctx.operation_label || '').trim();
  const stepId = Number(ctx.source_op_seq_id || 0);
  const cardId = Number(ctx.card_id || 0);
  const produced = Number(ctx.finished_qty ?? ctx.erp_finished_qty ?? ctx.wo_qty_produced ?? 0);
  const required = Number(ctx.required_qty ?? ctx.wo_qty_required ?? ctx.target_qty ?? 0);
  const qtyLine = required > 0.0001
    ? `${fmt(produced, 0)} / ${fmt(required, 0)} pcs`
    : (produced > 0.0001 ? `${fmt(produced, 0)} pcs` : '');
  const opLabel = [opDisp.op_no, opDisp.op_name].filter(Boolean).join(' · ') || 'Operation';
  return `
    <button type="button" class="trial-ps-detail-op-row"
      onclick="closeModal(); openTrialCatalogOpDetailFromPs('${escapeHtml(psId)}', '${escapeHtml(opNo)}', ${stepId}, ${cardId})">
      <span class="trial-ps-detail-op-label">${escapeHtml(opLabel)}</span>
      <span class="trial-ps-detail-op-meta">
        <span class="trial-ps-detail-op-badges">${execHtml}</span>
        ${qtyLine ? `<span class="trial-ps-detail-op-qty">${escapeHtml(qtyLine)}</span>` : ''}
      </span>
    </button>
  `;
}

function trialRenderCatalogPsDetailBody(ps) {
  const psId = String(ps.ps_id || '').trim();
  const basePs = psId.split('::')[0] || psId;
  const partial = psId.includes('::')
    ? psId.split('::')[1]
    : (Number(ps.pp_partial_no) > 1 ? String(ps.pp_partial_no) : '');
  const execStatus = trialPsRollupExecStatus(ps);
  const execHtml = trialOpStatusHtml(execStatus, { compact: true });
  const bomCode = trialPsBomDisplay(ps);
  const erpBom = trialPsErpBomCode(ps);
  const partialQty = Number(ps.partial_qty ?? ps.display_qty ?? ps.wo_req_qty ?? 0);
  const soQty = ps.so_det_qty;
  const shipped = Number(ps.qty_shipped || 0);
  const stageDesc = String(ps.current_stage_desc || '').trim();
  const cards = trialResolvedOpCardsForPs(ps);
  const opsHtml = cards.length
    ? cards.map(card => trialRenderCatalogPsDetailOpRow(ps, card)).join('')
    : '<div class="trial-ptl-muted">No operations on this partial.</div>';
  const partLine = [ps.part_name || ps.part_no, ps.part_desc].filter(Boolean).join(' · ');
  const copyText = [ps.part_name || ps.part_no || '', ps.part_desc || ''].filter(Boolean).join('\n');
  const soLine = (soQty !== null && soQty !== undefined && soQty !== '')
    ? `${fmt(shipped, 0)} / ${fmt(Number(soQty), 0)}`
    : '';

  return `
    <div class="trial-op-detail">
      <div class="trial-op-detail-head">
        <div class="trial-op-detail-title">${escapeHtml(basePs)}</div>
        ${partial ? `<div class="trial-op-detail-sub">Partial ${escapeHtml(partial)}</div>` : ''}
        <div class="trial-op-detail-badges">
          ${execHtml}
          ${trialPendingDoBadgeHtml(ps)}
          ${stageDesc ? `<span class="ps-stage-badge" title="${escapeHtml(stageDesc)}">${escapeHtml(stageDesc)}</span>` : ''}
        </div>
      </div>
      <dl class="trial-op-detail-grid">
        ${partLine ? trialRenderCatalogOpDetailRow('Part', escapeHtml(partLine)) : ''}
        ${ps.due_date ? trialRenderCatalogOpDetailRow('Due', escapeHtml(ps.due_date)) : ''}
        ${partialQty > 0.0001 ? trialRenderCatalogOpDetailRow('Partial qty', escapeHtml(fmt(partialQty, 0))) : ''}
        ${soLine ? trialRenderCatalogOpDetailRow('Shipped / SO', escapeHtml(soLine)) : ''}
        ${bomCode ? trialRenderCatalogOpDetailRow('Planner BOM', escapeHtml(bomCode)) : ''}
        ${erpBom && erpBom !== bomCode ? trialRenderCatalogOpDetailRow('ERP BOM', escapeHtml(erpBom)) : ''}
        ${ps.inventory_code ? trialRenderCatalogOpDetailRow('Inventory', escapeHtml(ps.inventory_code)) : ''}
        ${ps.source_voucher ? trialRenderCatalogOpDetailRow('SO voucher', escapeHtml(ps.source_voucher)) : ''}
      </dl>
      <div class="trial-op-detail-section">
        <div class="trial-op-detail-section-title">Operations</div>
        <div class="trial-ps-detail-op-list">${opsHtml}</div>
      </div>
      <div class="trial-op-detail-actions">
        ${copyText
          ? `<button type="button" class="btn btn-ghost btn-sm" data-copy-json="${escapeHtml(JSON.stringify(copyText))}" onclick="trialCopyPartText(JSON.parse(this.dataset.copyJson))">Copy part description</button>`
          : ''}
      </div>
    </div>
  `;
}

function openTrialCatalogPsDetail(event, psId) {
  if (event) event.stopPropagation();
  if (trialPlannerBusyLock > 0) return;
  const ps = trialCatalogPsRecord(psId);
  if (!ps) {
    toast('PS / partial not found.', 'error');
    return;
  }
  const basePs = String(ps.ps_id || '').split('::')[0] || ps.ps_id || 'PS';
  const partialNo = String(ps.ps_id || '').includes('::')
    ? String(ps.ps_id).split('::')[1]
    : (Number(ps.pp_partial_no) > 1 ? String(ps.pp_partial_no) : '');
  const title = [basePs, partialNo ? `Partial ${partialNo}` : ''].filter(Boolean).join(' · ');
  openModal(title, trialRenderCatalogPsDetailBody(ps), 'lg');
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
        <button type="button" class="btn btn-ghost btn-sm trial-op-detail-remove"
          onclick="removeTrialBlock(${blockId}, ${Number(group.group_id || 0)})">Remove from queue</button>
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
    pp_partial_no: card.pp_partial_no,
    queued_machines: card.queued_machines,
    remaining_qty: card.remaining_qty,
  };
  const isAllocated = !!card.is_allocated || trialCatalogOpHasQueuedBlocks(catalogOpRef);
  const schedulableRemaining = trialCatalogSchedulableRemaining(card);
  const isPartiallyAllocated = isAllocated && schedulableRemaining > 0.0001;
  const displayQty = isAllocated
    ? schedulableRemaining
    : Math.max(schedulableRemaining, Number(card.remaining_qty || card.target_qty || 0));
  const remainingQty = fmt(displayQty, 0);
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
  const allocatedBlock = isAllocated ? trialFindBlockForCatalogOp(catalogOpRef) : null;
  const plannerPsId = typeof trialCatalogPlannerPsId === 'function'
    ? trialCatalogPlannerPsId(catalogOpRef)
    : String(catalogOpRef.ps_id || catalogOpRef.source_ps_id || '').trim();
  const partialNo = typeof trialCatalogPartialIndex === 'function'
    ? trialCatalogPartialIndex(catalogOpRef)
    : 1;
  const payload = {
    type: 'op-card',
    card_kind: cardKind,
    card_id: Number(card.card_id || 0) || null,
    ps_id: plannerPsId || card.ps_id || '',
    pp_partial_no: partialNo,
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
    source_ps_id: plannerPsId || card.source_ps_id || card.ps_id || '',
    source_op_seq_id: Number(card.source_op_seq_id || 0),
    source_op_no: card.source_op_no || '',
    job_no: plannerPsId || card.job_no || card.ps_id || '',
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
      job_no: payload.job_no || payload.source_ps_id,
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
  const isManualBom = trialCatalogOpIsManualBom(card);
  const isComplete = trialCatalogOpIsComplete(card);
  const manualBomBadge = isManualBom
    ? '<span class="trial-catalog-manual-bom-badge" title="Manual BOM step — always shown in catalog">Manual</span>'
    : '';
  const removeBtn = allocatedBlock?.block_id
    ? trialRenderQueueRemoveBtn(allocatedBlock.block_id, allocatedBlock.group_id, {
      className: 'trial-catalog-op-remove',
      title: 'Remove from machine queue',
    })
    : '';
  const uncombineBtn = isGroup && !isScheduled
    ? `<button class="trial-catalog-op-uncombine" type="button" aria-label="Uncombine" title="Uncombine"
        onclick="deleteTrialPlanningCard(${Number(card.card_id || 0)})">×</button>`
    : '';
  return `
    <div class="trial-catalog-op trial-planning-card trial-catalog-op--compact trial-catalog-op--clickable ${isScheduled ? 'is-scheduled' : ''} ${isAllocated ? 'is-allocated' : ''} ${isPartiallyAllocated ? 'is-partially-allocated' : ''} ${isManualBom ? 'is-manual-bom' : ''} ${isComplete ? 'is-completed' : ''}"
      draggable="false"
      data-is-complete="${isComplete ? 'true' : 'false'}"
      title="${isComplete
        ? 'Completed — click for details'
        : (isPartiallyAllocated
          ? `Click for details · drag remainder (${schedulableRemaining} pcs) to another machine`
          : 'Click for details · drag to schedule or combine')}"
      data-trial-payload="${trialPayloadToAttr(payload)}"
      data-card-kind="${escapeHtml(cardKind)}"
      data-card-id="${escapeHtml(card.card_id || '')}"
      data-ps-id="${escapeHtml(plannerPsId || card.ps_id || '')}"
      data-pp-partial-no="${escapeHtml(partialNo ?? '')}"
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
        ${removeBtn}
        ${uncombineBtn}
      </div>
      ${showOpName ? `<div class="trial-catalog-op-detail">${escapeHtml(opName)}</div>` : ''}
      <div class="trial-catalog-op-footer">
        ${manualBomBadge}
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
  const leader = group?.leader;
  return String(
    group?.visual_end_datetime ||
    group?.group_end ||
    leader?.visual_end_datetime ||
    leader?.predicted_end_at ||
    leader?.calculated_end_datetime ||
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
  const anchorText = anchored ? trialFormatDt(leader.anchor_datetime) : '';
  const scheduleTimeLabel = anchored ? 'Anchor' : 'Queued';
  const scheduleTimeText = anchored ? anchorText : trialFormatDt(queuedAt);
  const queuedTitle = anchored
    ? `Anchor ${anchorText} · Queued ${trialFormatDt(queuedAt)} — tap to edit`
    : `Queued ${trialFormatDt(queuedAt) || '—'} — tap to set anchor`;
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
    anchorText,
    scheduleTimeLabel,
    scheduleTimeText,
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

function trialRenderQueueRemoveBtn(blockId, groupId, options = {}) {
  const bid = Number(blockId || 0);
  if (!bid) return '';
  const gid = Number(groupId || 0);
  const className = String(options.className || 'trial-queue-remove').trim();
  const label = options.label != null ? String(options.label) : '×';
  const title = String(options.title || 'Remove from queue').trim();
  return `<button type="button" class="${escapeHtml(className)}"
    onclick="event.stopPropagation(); removeTrialBlock(${bid}, ${gid})"
    aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}">${label}</button>`;
}

function trialRenderCompactBlockCard(vm) {
  const leader = vm.leader;
  const dueDate = String(trialDueDateForPs(vm.psDueKey) || leader?.due_date || '').trim();
  const dayDiff = dueDate ? trialDateDiffDays(dueDate) : null;
  const dueClass = dayDiff == null ? '' : (dayDiff < 0 ? 'is-overdue' : (dayDiff <= 7 ? 'is-due-soon' : 'is-normal'));
  const readOnly = typeof trialIsReadOnlyBoard === 'function' && trialIsReadOnlyBoard();
  const clickableClass = readOnly ? '' : ' trial-block-card--clickable';
  const cardTitle = readOnly ? 'Scheduled job' : 'Click for details · drag edge to move';
  const dragHtml = readOnly
    ? ''
    : '<div class="trial-block-compact-drag" title="Drag to reorder or move to another machine" aria-label="Drag to reorder">⋮⋮</div>';
  const removeBtn = readOnly
    ? ''
    : trialRenderQueueRemoveBtn(leader?.block_id, vm.group.group_id, { className: 'trial-block-remove' });
  const materialInClass = trialMaterialInLaneClass(leader);
  return `
    <div class="trial-block-card trial-block-card--compact${clickableClass}${readOnly ? ' trial-block-card--readonly' : ''} ${vm.isCombined ? 'combined' : ''} ${materialInClass}"
      data-block-id="${leader?.block_id || ''}"
      data-group-id="${vm.group.group_id || 0}"
      data-block-ids="${vm.groupBlockIds}"
      title="${escapeHtml(cardTitle)}">
      ${dragHtml}
      <div class="trial-block-compact-body">
        <div class="trial-block-compact-top">
          ${vm.sequenceNo ? `<span class="trial-block-seq">#${vm.sequenceNo}</span>` : ''}
          <div class="trial-block-compact-top-end">
            <span class="trial-block-compact-metrics" title="Qty / Output">
              <span class="trial-block-compact-metric"><span class="trial-pill-label">Qty</span>${vm.targetQty}</span>
              <span class="trial-block-compact-metric"><span class="trial-pill-label">Out</span>${vm.pairedOutput}</span>
            </span>
            ${removeBtn}
          </div>
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
          ${readOnly
    ? `<span class="trial-block-compact-date ${vm.anchored ? 'is-anchored' : ''}" title="${escapeHtml(vm.queuedTitle)}">
            <span class="trial-pill-label">${escapeHtml(vm.scheduleTimeLabel)}</span>
            <span>${escapeHtml(vm.scheduleTimeText || '—')}</span>
          </span>`
    : `<button type="button" class="trial-block-compact-date is-queued ${vm.anchored ? 'is-anchored' : ''}"
            onclick="event.stopPropagation(); editTrialAnchor(${leader?.block_id || 0})"
            aria-label="${escapeHtml(vm.anchored ? `Change anchor ${vm.anchorText}` : 'Set anchor time')}"
            title="${escapeHtml(vm.queuedTitle)}">
            <span class="trial-pill-label">${escapeHtml(vm.scheduleTimeLabel)}</span>
            <span>${escapeHtml(vm.scheduleTimeText || '—')}</span>
          </button>`}
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
  const materialInClass = trialMaterialInLaneClass(leader);
  return `
    <div class="trial-queue-row trial-block-card ${vm.isCombined ? 'combined' : ''} ${materialInClass}"
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
          onclick="editTrialAnchor(${blockId})" title="${escapeHtml(vm.queuedTitle)}">
          ${escapeHtml(vm.scheduleTimeText || '—')}
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

function renderTrialMachineBoardSubgroup(subgroup) {
  if (!subgroup?.machines?.length) return '';
  const hint = String(subgroup.hint || '').trim();
  const title = String(subgroup.title || '').trim();
  const showHint = hint && hint.toLowerCase() !== title.toLowerCase();
  return `
    <div class="trial-machine-board-subgroup${subgroup.fallback ? ' is-fallback' : ''}"
      data-board-subgroup="${escapeHtml(subgroup.id)}">
      <div class="trial-machine-board-subgroup-head" title="${escapeHtml(hint || title)}">
        <span class="trial-machine-board-subgroup-title">${escapeHtml(title || 'Subgroup')}</span>
        ${showHint ? `<span class="trial-machine-board-subgroup-hint">${escapeHtml(hint)}</span>` : ''}
      </div>
      <div class="trial-machine-board-subgroup-lanes">
        ${subgroup.machines.map(renderTrialMachine).join('')}
      </div>
    </div>
  `;
}

function renderTrialMachineLaneGroup(group) {
  const flatMachines = group?.machines || [];
  const subgroups = Array.isArray(group?.subgroups) ? group.subgroups : [];
  if (!group?.grouped || !group.label) {
    return flatMachines.map(renderTrialMachine).join('');
  }
  const laneHtml = subgroups.length
    ? subgroups.map(renderTrialMachineBoardSubgroup).join('')
    : flatMachines.map(renderTrialMachine).join('');
  const subgroupedClass = subgroups.length ? ' trial-machine-board-group-lanes--subgrouped' : '';
  const chromeExpanded = typeof trialIsBoardGroupChromeExpanded === 'function'
    && trialIsBoardGroupChromeExpanded(group.id);
  const machineCount = typeof trialBoardGroupMachineCount === 'function'
    ? trialBoardGroupMachineCount(group)
    : 0;
  const countLabel = machineCount
    ? `${machineCount} machine${machineCount === 1 ? '' : 's'}`
    : '';
  return `
    <div class="trial-machine-board-group${chromeExpanded ? ' is-chrome-expanded' : ''}" data-board-group="${escapeHtml(group.id)}">
      <button type="button" class="trial-machine-board-group-head"
        data-board-group-toggle="${escapeHtml(group.id)}"
        aria-expanded="${chromeExpanded ? 'true' : 'false'}"
        title="${escapeHtml(chromeExpanded ? `Hide ${group.label} section labels` : `Show ${group.label} section labels`)}">
        <span class="trial-machine-board-group-caret" aria-hidden="true"></span>
        <span class="trial-machine-board-group-label">${escapeHtml(group.label)}</span>
        ${countLabel ? `<span class="trial-machine-board-group-count">${escapeHtml(countLabel)}</span>` : ''}
      </button>
      <div class="trial-machine-board-group-lanes${subgroupedClass}">
        ${laneHtml}
      </div>
    </div>
  `;
}

function trialApplyBoardGroupChrome(groupEl, chromeExpanded) {
  if (!groupEl) return;
  const btn = groupEl.querySelector('[data-board-group-toggle]');
  groupEl.classList.toggle('is-chrome-expanded', chromeExpanded);
  if (btn) {
    btn.setAttribute('aria-expanded', chromeExpanded ? 'true' : 'false');
    const label = groupEl.querySelector('.trial-machine-board-group-label')?.textContent?.trim() || 'group';
    btn.title = chromeExpanded ? `Hide ${label} section labels` : `Show ${label} section labels`;
  }
}

function trialBindBoardGroupCollapse() {
  const grid = document.getElementById('trial-grid');
  if (!grid || grid.dataset.boardGroupCollapseBound === '1') return;
  grid.dataset.boardGroupCollapseBound = '1';
  grid.addEventListener('click', e => {
    const btn = e.target.closest('[data-board-group-toggle]');
    if (!btn || !grid.contains(btn)) return;
    e.preventDefault();
    const groupId = btn.dataset.boardGroupToggle || '';
    const chromeExpanded = typeof trialToggleBoardGroupChromeExpanded === 'function'
      ? trialToggleBoardGroupChromeExpanded(groupId)
      : false;
    trialApplyBoardGroupChrome(btn.closest('.trial-machine-board-group'), chromeExpanded);
    if (typeof trialSyncMachineGridScrollWidth === 'function') {
      window.requestAnimationFrame(trialSyncMachineGridScrollWidth);
    }
  });
}

function renderTrialMachineGridHtml() {
  const groups = trialVisibleMachinesGrouped();
  const useGroupedLayout = trialShouldGroupMachineLanes()
    && groups.some(group => group.grouped && group.label);
  if (!useGroupedLayout) {
    const flat = groups[0]?.machines || trialVisibleMachines();
    return flat.map(renderTrialMachine).join('');
  }
  return groups.map(renderTrialMachineLaneGroup).join('');
}

function renderTrialMachine(machine) {
  // Completed groups are filtered server-side in /api/trial/schedule.
  const allGroups = trialBlocksGroupedForMachine(machine.machine_id);
  const groups = allGroups.filter(trialGroupRunsInsideDateFilter);
  const laneId = `trial-lane-${machine.machine_id}`;
  const blockCount = allGroups.length;
  const queueSummary = blockCount
    ? `${blockCount} in queue`
    : 'Empty queue';
  const staleBadge = trialDirtyMachineIds.has(Number(machine.machine_id))
    ? '<span class="trial-machine-stale-badge" title="Queue changed; schedule times may be outdated">Schedule outdated</span>'
    : '';
  const readOnly = typeof trialIsReadOnlyBoard === 'function' && trialIsReadOnlyBoard();
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
    ? `Next available ${trialFormatDt(availabilityEnd)}`
    : 'Queued jobs';
  const anchorMeta = firstAnchorText
    ? `Anchor ${firstAnchorText}`
    : 'Tap to set anchor';
  const showAvailabilityBar = allGroups.length >= 1 && (availabilityEnd || (!readOnly && firstBlockId));
  const availabilityTag = showAvailabilityBar
    ? (!readOnly && firstBlockId
      ? `<button type="button" class="trial-machine-availability is-anchorable"
            onclick="event.stopPropagation(); editTrialAnchor(${firstBlockId})"
            title="${escapeHtml(anchorTitle)}">
            <span class="trial-machine-availability-stack">
              <span class="trial-machine-availability-text">${availabilityText}</span>
              <span class="trial-machine-anchor-meta ${firstAnchorText ? 'is-set' : 'is-unset'}">${anchorMeta}</span>
            </span>
          </button>`
      : `<div class="trial-machine-availability">
            <span class="trial-machine-availability-stack">
              <span class="trial-machine-availability-text">${availabilityText}</span>
              ${firstAnchorText ? `<span class="trial-machine-anchor-meta is-set">Anchor ${firstAnchorText}</span>` : ''}
            </span>
          </div>`)
    : '';

  const blockHtml = groups.length
    ? groups.map((group, idx) => trialRenderCompactBlockCard(
      trialBlockGroupViewModel(group, { displaySequenceNo: idx + 1 })
    )).join('')
    : `<div class="trial-empty">${escapeHtml(trialMachineLaneEmptyMessage(allGroups.length, groups.length))}</div>`;

  const headMainAttrs = readOnly
    ? ''
    : ` role="button" tabindex="0"
          onclick="openTrialMachineQueue(${machine.machine_id})"
          onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTrialMachineQueue(${machine.machine_id}); }"
          title="Open full queue"`;
  const headActionsHtml = readOnly
    ? ''
    : `<div class="trial-machine-head-actions">
          <button class="btn btn-ghost btn-sm" type="button" onclick="event.stopPropagation(); openTrialMachineQueue(${machine.machine_id})">Queue</button>
          ${staleBadge ? `<button class="btn btn-primary btn-sm" type="button" onclick="event.stopPropagation(); trialRecalculateSingleMachine(${machine.machine_id})">Recalc</button>` : ''}
        </div>`;
  return `
    <section class="trial-machine" data-machine-id="${machine.machine_id}">
      <div class="trial-machine-head">
        <div class="trial-machine-head-main"${headMainAttrs}>
          <div class="trial-machine-title">${machine.machine_code}</div>
          <div class="trial-machine-meta">${machine.machine_category} - ${machine.shift_profile || 'STANDARD'}</div>
          <div class="trial-machine-queue-summary">${queueSummary}</div>
          ${readOnly ? '' : staleBadge}
        </div>
        ${headActionsHtml}
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

function trialPreferNativeGridTouchScroll() {
  if (typeof trialIsMachinistBoard !== 'function' || !trialIsMachinistBoard()) return false;
  try {
    return window.matchMedia('(max-width: 900px), (pointer: coarse)').matches;
  } catch (_) {
    return false;
  }
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

    if (!trialPreferNativeGridTouchScroll()) {
      let touchStartX = 0;
      let touchStartY = 0;
      let touchScrollLeft = 0;
      let touchPanAxis = null;
      const resetTouchPan = () => {
        touchPanAxis = null;
      };
      main.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) {
          resetTouchPan();
          return;
        }
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchScrollLeft = main.scrollLeft;
        touchPanAxis = null;
      }, { passive: true });
      main.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 1 || main.scrollWidth <= main.clientWidth) return;
        const dx = e.touches[0].clientX - touchStartX;
        const dy = e.touches[0].clientY - touchStartY;
        if (!touchPanAxis && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
          touchPanAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        }
        if (touchPanAxis !== 'x') return;
        e.preventDefault();
        main.scrollLeft = touchScrollLeft - dx;
        syncFromMain();
      }, { passive: false });
      main.addEventListener('touchend', resetTouchPan, { passive: true });
      main.addEventListener('touchcancel', resetTouchPan, { passive: true });
    }

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
  const machinist = typeof trialIsMachinistBoard === 'function' && trialIsMachinistBoard();
  if (filterShell) {
    if (machinist) {
      filterShell.innerHTML = '';
    } else {
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
            <button type="button" class="btn btn-ghost btn-sm"
              onclick="trialExportBoardToExcel()"
              title="Download lane board as Excel (matches shop-floor layout)">
              Export Excel
            </button>
            ${String(window.trialMachinistBoardUrl || '').trim() ? `
            <a href="${String(window.trialMachinistBoardUrl).trim()}" target="_blank" rel="noopener noreferrer"
              class="btn btn-ghost btn-sm trial-machinist-view-link"
              title="Open read-only lane board for shop floor">
              Machinist view
            </a>` : ''}
          </div>
          ${renderTrialMachineCheckboxFilter()}
        </div>
      `;
    }
  }
  const visibleMachines = trialVisibleMachines();
  if (typeof trialPerfMark === 'function') {
    trialPerfMark(perf, 'compute-visible-machines', { visible_machines: visibleMachines.length });
  }
  grid.classList.toggle('trial-grid--grouped', trialShouldGroupMachineLanes());
  grid.innerHTML = visibleMachines.length
    ? renderTrialMachineGridHtml()
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
  trialBindBoardGroupCollapse();
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
    if (!machine || !existing) {
      if (!machine && typeof trialBlocksForMachine === 'function' && trialBlocksForMachine(machineId).length) {
        renderTrial(options);
      }
      return;
    }
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

function trialCatalogOpIsManualBom(card) {
  if (!card) return false;
  const stageNo = Number(card.source_stage_no ?? card.op?.source_stage_no ?? 0);
  if (stageNo > 0) return false;
  if (card.is_manual_bom) return true;
  const kind = String(card.source_kind || card.op?.source_kind || '').trim().toUpperCase();
  return kind === 'MANUAL' && Boolean(String(card.operation_name || card.op?.op_type || '').trim());
}

/** True when an op card still belongs in the planner catalog (not fully done). */
function trialCatalogOpIsOpen(card) {
  if (trialCatalogOpIsManualBom(card)) return true;
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
  if (String(op.source_kind || '').toUpperCase() === 'MANUAL') return true;
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
  const cards = typeof trialResolvedOpCardsForPs === 'function'
    ? trialResolvedOpCardsForPs(ps)
    : (ps?.op_cards || []);
  const chips = cards
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
  if (ps?.is_temp_ps) return 'Reject rework';
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
  const basePsId = String(ps.display_ps_id || ps.ps_id || '').split('::')[0] || ps.ps_id || '';
  const partialText = trialCatalogPartialLabel(ps, siblingCountByBase);
  const dueDate = ps.due_date || 'No due date';
  const execStatus = trialPsRollupExecStatus(ps);
  const stageDesc = String(ps.current_stage_desc || '').trim();
  const stageBadge = stageDesc
    ? `<span class="ps-stage-badge" title="${escapeHtml(stageDesc)}">${escapeHtml(stageDesc)}</span>`
    : '';
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
      ${trialCatalogMaterialInCheckboxHtml(ps)}
      <span class="trial-catalog-ps-meta trial-catalog-ps-date">${escapeHtml(dueDate)}</span>
      ${trialCatalogInfoBtnHtml(ps)}
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
  if (ps?.is_temp_ps) {
    if (trialPsHasQueuedBlocks(ps)) return false;
    if (trialCatalogPsHasOpenOps(ps)) return false;
    return false;
  }
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
    ps.is_temp_ps ? 'temp reject rework' : '',
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

  const cachedIsOpAllocated = (card, ps) => {
    const ctx = typeof trialCatalogOpForPs === 'function' ? trialCatalogOpForPs(card, ps) : card;
    const key = [
      String(ctx?.source_ps_id || ctx?.ps_id || '').trim(),
      String(ctx?.pp_partial_no ?? trialCatalogPartialIndex(ctx?.ps_id || ctx?.source_ps_id || '')),
      String(ctx?.source_op_no || ctx?.operation_label || '').trim(),
      String(ctx?.source_op_seq_id || ctx?.source_step_id || '').trim(),
      String(ctx?.card_id || '').trim(),
    ].join('|');
    if (allocatedCardCache.has(key)) return allocatedCardCache.get(key);
    const allocated = trialIsCatalogOpAllocated(ctx);
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
    if (trialCatalogSupersededByTempSibling(ps, trialState.catalog)) return false;
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
      if (trialCatalogSupersededByTempSibling(ps, trialState.catalog)) continue;
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
    if (trialCatalogSupersededByTempSibling(ps, trialState.catalog)) return false;
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

  const catalogWithOpenOps = catalog.filter(ps => {
    if (ps?.is_temp_ps) return true;
    if (trialHideBlankPs && trialPsIsUnassignedCatalog(ps)) return false;
    const cards = cachedResolvedCards(ps);
    const isOpAllocated = card => cachedIsOpAllocated(card, ps);
    const hasOpenOps = cards.some(card => trialCatalogOpShouldShow(card, isOpAllocated))
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
    const isOpAllocated = card => cachedIsOpAllocated(card, ps);
    const opCardsHtml = cards
      .filter(card => trialCatalogOpShouldShow(card, isOpAllocated))
      .map(card => {
        const ctx = typeof trialCatalogOpForPs === 'function' ? trialCatalogOpForPs(card, ps) : card;
        return renderTrialOpCardHtml({
          ...ctx,
          is_allocated: isOpAllocated(card),
          part_no: ctx.part_no || ps.part_no || ps.part_name || '',
        });
      })
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
    const isOpAllocated = card => cachedIsOpAllocated(card, ps);
    const hasOpenOps = cards.some(card => trialCatalogOpShouldShow(card, isOpAllocated));
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
          ${trialCatalogMaterialInCheckboxHtml(ps)}
          <span class="trial-catalog-planned-badge">Planned</span>
          <span class="trial-catalog-ps-meta trial-catalog-ps-date">${escapeHtml(ps.due_date || 'No due date')}</span>
          ${trialCatalogInfoBtnHtml(ps)}
        </div>
      </div>
      ${trialCatalogBomBarHtml(ps)}
      <div class="trial-catalog-oplist">
        ${(() => {
          const isOpAllocated = card => cachedIsOpAllocated(card, ps);
          return cachedResolvedCards(ps)
            .filter(card => trialCatalogOpShouldShow(card, isOpAllocated))
            .map(card => {
              const ctx = typeof trialCatalogOpForPs === 'function' ? trialCatalogOpForPs(card, ps) : card;
              return renderTrialOpCardHtml({
                ...ctx,
                is_allocated: isOpAllocated(card),
                part_no: ctx.part_no || ps.part_no || ps.part_name || '',
              });
            })
            .join('');
        })()}
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

function trialCopyPartText(text) {
  const value = String(text || '').trim();
  if (!value) return;
  navigator.clipboard.writeText(value).then(() => {
    toast('Part description copied.', 'success');
  }).catch(() => {
    toast('Could not copy to clipboard.', 'error');
  });
}

function decorateTrialCatalogCards() {
  // Inline in renderTrialCatalog.
}

function updateTrialCompletedButton() {
  const btn = document.getElementById('trial-completed-toggle');
  if (btn) btn.textContent = trialShowCompleted ? 'Hide completed' : 'Show completed';
}
