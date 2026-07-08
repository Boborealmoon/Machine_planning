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
  if (!trialToolingForBlockLeader(leader)) return 'tooling-no';
  return trialMaterialInForBlockLeader(leader) ? 'material-in-yes' : 'material-in-no';
}

function trialToolingKey(operationId, psId, sourceOpSeqId) {
  const opId = Number(operationId || 0);
  if (opId > 0) return `op:${opId}`;
  const psKey = String(psId || '').trim();
  const seqId = Number(sourceOpSeqId || 0);
  if (psKey && seqId > 0) return `ps:${psKey}|${seqId}`;
  return '';
}

function trialToolingFromScheduleBlocks(leader) {
  const opId = Number(leader?.operation_id || 0);
  if (opId > 0) {
    const block = (Array.isArray(trialState.blocks) ? trialState.blocks : [])
      .find(row => Number(row.operation_id) === opId);
    if (block && Object.prototype.hasOwnProperty.call(block, 'tooling_ready')) {
      return Boolean(block.tooling_ready);
    }
  }
  const psKey = String(
    leader?.planner_ps_id || leader?.source_ps_id || leader?.job_no || '',
  ).trim();
  const seqId = Number(leader?.source_op_seq_id || 0);
  if (!psKey || seqId <= 0) return null;
  for (const block of (Array.isArray(trialState.blocks) ? trialState.blocks : [])) {
    if (!Object.prototype.hasOwnProperty.call(block, 'tooling_ready')) continue;
    const blockPs = String(block.planner_ps_id || block.source_ps_id || block.job_no || '').trim();
    if (blockPs === psKey && Number(block.source_op_seq_id || 0) === seqId) {
      return Boolean(block.tooling_ready);
    }
  }
  return null;
}

function trialToolingForLeader(leader) {
  const key = trialToolingKey(
    leader?.operation_id,
    leader?.planner_ps_id || leader?.source_ps_id || leader?.job_no,
    leader?.source_op_seq_id,
  );
  if (key && trialToolingOverrides.has(key)) {
    return Boolean(trialToolingOverrides.get(key));
  }
  if (leader && Object.prototype.hasOwnProperty.call(leader, 'tooling_ready')) {
    return Boolean(leader.tooling_ready);
  }
  const fromBlocks = trialToolingFromScheduleBlocks(leader);
  if (fromBlocks !== null) return fromBlocks;
  return true;
}

function trialToolingForBlockLeader(leader) {
  return trialToolingForLeader(leader);
}

function trialToolingForCatalogCard(card) {
  const leader = {
    operation_id: card?.operation_id,
    planner_ps_id: card?.ps_id || card?.source_ps_id,
    source_ps_id: card?.source_ps_id || card?.ps_id,
    source_op_seq_id: card?.source_op_seq_id,
    tooling_ready: card?.tooling_ready,
  };
  return trialToolingForLeader(leader);
}

function trialToolingPillMeta(toolingReady) {
  if (toolingReady) {
    return {
      stateClass: 'is-in',
      label: 'Tooling OK',
      title: 'Assumed ready — click to flag missing tooling',
    };
  }
  return {
    stateClass: 'is-out',
    label: 'Missing tooling',
    title: 'Tooling exception flagged — click to clear',
  };
}

function trialToolingPillSync(pill, toolingReady) {
  if (!pill) return;
  const meta = trialToolingPillMeta(toolingReady);
  pill.classList.toggle('is-in', Boolean(toolingReady));
  pill.classList.toggle('is-out', !toolingReady);
  pill.setAttribute('aria-pressed', toolingReady ? 'true' : 'false');
  pill.title = meta.title;
  const textEl = pill.querySelector('.trial-tooling-text');
  if (textEl) textEl.textContent = meta.label;
}

function trialBlockToolingCheckboxHtml(leader) {
  const operationId = Number(leader?.operation_id || 0);
  const psId = String(
    leader?.planner_ps_id || leader?.source_ps_id || leader?.job_no || '',
  ).trim();
  const sourceOpSeqId = Number(leader?.source_op_seq_id || 0);
  if (!operationId && (!psId || sourceOpSeqId <= 0)) return '';
  const checked = trialToolingForLeader(leader);
  const meta = trialToolingPillMeta(checked);
  return `
    <label class="trial-tooling-pill ${meta.stateClass}"
      title="${escapeHtml(meta.title)}"
      aria-pressed="${checked ? 'true' : 'false'}"
      aria-label="${escapeHtml(meta.label)}"
      onclick="event.stopPropagation()">
      <input type="checkbox" class="trial-tooling-input"
        data-operation-id="${operationId || ''}"
        data-ps-id="${escapeHtml(psId)}"
        data-source-op-seq-id="${sourceOpSeqId || ''}"
        ${checked ? 'checked' : ''}
        tabindex="-1"
        aria-hidden="true"
        onchange="trialSetTooling(event, this)">
      <span class="trial-tooling-dot" aria-hidden="true"></span>
      <span class="trial-tooling-text">${escapeHtml(meta.label)}</span>
    </label>
  `;
}

function trialOpReadinessTogglesHtml(ps, leader) {
  const materialHtml = ps ? trialCatalogMaterialInCheckboxHtml(ps) : '';
  const toolingHtml = leader ? trialBlockToolingCheckboxHtml(leader) : '';
  if (!materialHtml && !toolingHtml) return '';
  return `
    <div class="trial-op-detail-section">
      <div class="trial-op-detail-section-title">Readiness</div>
      <div class="trial-readiness-toggles">
        ${materialHtml}
        ${toolingHtml}
      </div>
    </div>
  `;
}

async function trialSetTooling(event, input) {
  if (event) event.stopPropagation();
  const operationId = Number(input?.dataset?.operationId || 0);
  const psId = String(input?.dataset?.psId || '').trim();
  const sourceOpSeqId = Number(input?.dataset?.sourceOpSeqId || 0);
  const key = trialToolingKey(operationId, psId, sourceOpSeqId);
  if (!key || input.disabled) return;
  const leader = {
    operation_id: operationId,
    planner_ps_id: psId,
    source_ps_id: psId,
    source_op_seq_id: sourceOpSeqId,
  };
  const previous = trialToolingForLeader(leader);
  const toolingReady = Boolean(input.checked);
  const pill = input.closest('.trial-tooling-pill');
  trialToolingOverrides.set(key, toolingReady);
  trialApplyToolingToBlocks({ operationId, psId, sourceOpSeqId, toolingReady });
  trialToolingPillSync(pill, toolingReady);
  input.disabled = true;
  if (pill) pill.classList.add('is-saving');
  try {
    await POST('/api/operations/tooling-flag', {
      operation_id: operationId || undefined,
      ps_id: psId || undefined,
      source_op_seq_id: sourceOpSeqId || undefined,
      tooling_ready: toolingReady,
    });
    if (typeof renderTrial === 'function') renderTrial();
    if (typeof renderTrialCatalog === 'function') renderTrialCatalog();
  } catch (err) {
    trialToolingOverrides.set(key, previous);
    trialApplyToolingToBlocks({ operationId, psId, sourceOpSeqId, toolingReady: previous });
    input.checked = previous;
    trialToolingPillSync(pill, previous);
    window.alert(err?.message || 'Could not save tooling flag');
  } finally {
    input.disabled = false;
    if (pill) pill.classList.remove('is-saving');
  }
}

function trialApplyToolingToBlocks({ operationId, psId, sourceOpSeqId, toolingReady }) {
  const opId = Number(operationId || 0);
  const psKey = String(psId || '').trim();
  const seqId = Number(sourceOpSeqId || 0);
  (Array.isArray(trialState.blocks) ? trialState.blocks : []).forEach(block => {
    if (opId > 0 && Number(block.operation_id) === opId) {
      block.tooling_ready = Boolean(toolingReady);
      return;
    }
    const blockPs = String(block.planner_ps_id || block.source_ps_id || block.job_no || '').trim();
    if (psKey && seqId > 0 && blockPs === psKey && Number(block.source_op_seq_id || 0) === seqId) {
      block.tooling_ready = Boolean(toolingReady);
    }
  });
  const pools = [
    ...(Array.isArray(trialState.catalog) ? trialState.catalog : []),
    ...(Array.isArray(trialState.planned) ? trialState.planned : []),
  ];
  pools.forEach(ps => {
    (ps.op_cards || []).forEach(card => {
      if (opId > 0 && Number(card.operation_id) === opId) {
        card.tooling_ready = Boolean(toolingReady);
        return;
      }
      const cardPs = String(card.ps_id || card.source_ps_id || '').trim();
      const cardSeq = Number(card.source_op_seq_id || 0);
      if (psKey && seqId > 0 && cardPs === psKey && cardSeq === seqId) {
        card.tooling_ready = Boolean(toolingReady);
      }
    });
  });
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
    if (typeof renderTrial === 'function') renderTrial();
    if (typeof renderTrialCatalog === 'function') renderTrialCatalog();
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
      const erpRoute = !Number(flow.bom_id || 0) && String(flow.source_kind || '').toUpperCase() === 'ERP';
      const label = `${code}${flow.is_default ? ' (default)' : ''}${erpBom && code.toUpperCase() === String(erpBom).toUpperCase() ? ' · voucher' : erpRoute ? ' · ERP route' : ''}`;
      options.push(`<option value="${escapeHtml(code)}" ${code.toUpperCase() === selectedFlowCode.toUpperCase() ? 'selected' : ''}>${escapeHtml(label)}</option>`);
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
      const erpRoute = !Number(flow.bom_id || 0) && String(flow.source_kind || '').toUpperCase() === 'ERP';
      const label = `${code}${flow.is_default ? ' *' : ''}${erpBom && code.toUpperCase() === String(erpBom).toUpperCase() ? ' · voucher' : erpRoute ? ' · ERP route' : ''}`;
      options.push(`<option value="${escapeHtml(code)}" ${code.toUpperCase() === selectedFlowCode.toUpperCase() ? 'selected' : ''}>${escapeHtml(label)}</option>`);
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
      <label class="trial-ps-type-checkbox trial-ps-type-completed" title="Include ops-complete and shipped PS">
        <input id="trial-show-completed" type="checkbox" ${trialShowCompleted ? 'checked' : ''}
          onchange="onTrialShowCompletedChange(this.checked)">
        <span>Show completed</span>
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

/** True when a [Temp] line still has queue work or open schedulable ops (not a stale cache row). */
function trialCatalogTempPsIsActive(tempRow) {
  if (!tempRow) return false;
  const isTemp = Boolean(tempRow.is_temp_ps)
    || (typeof trialIsTempCatalogPs === 'function' && trialIsTempCatalogPs(tempRow));
  if (!isTemp) return false;
  return typeof trialPsHasQueuedBlocks === 'function' && trialPsHasQueuedBlocks(tempRow);
}

/** Matching [Temp] reject/rework row for the same ERP source partial, if any. */
function trialCatalogFindTempSiblingRow(ps, pool) {
  if (!ps || (typeof trialIsTempCatalogPs === 'function' && trialIsTempCatalogPs(ps))) return null;
  const sourceKey = String(
    ps?.source_ps_id || trialSplitPsId(String(ps?.ps_id || '')).base || '',
  ).trim();
  if (!sourceKey || sourceKey.startsWith('[Temp]')) return null;
  const partial = trialCatalogPartialIndex(ps);
  const rows = pool || (typeof trialCatalogPsPools === 'function'
    ? trialCatalogPsPools().all
    : [...(trialState?.catalog || []), ...(trialState?.planned || [])]);
  return rows.find(row => {
    if (!row?.is_temp_ps && !(typeof trialIsTempCatalogPs === 'function' && trialIsTempCatalogPs(row))) {
      return false;
    }
    if (String(row?.source_ps_id || '').trim() !== sourceKey) return false;
    const tempPartial = Number(row?.source_pp_partial_no || row?.pp_partial_no || 1);
    return tempPartial === partial;
  }) || null;
}

function trialIsCatalogOpAllocatedOnPs(card, psRow) {
  if (!card || !psRow) return false;
  const enriched = typeof trialCatalogOpForPs === 'function'
    ? trialCatalogOpForPs(card, psRow)
    : card;
  return typeof trialIsCatalogOpAllocated === 'function' && trialIsCatalogOpAllocated(enriched);
}

/** Queue blocks on the paired [Temp] line count for the same op no on the ERP card. */
function trialIsCatalogOpAllocatedIncludingTemp(card, ps, pool) {
  if (trialIsCatalogOpAllocatedOnPs(card, ps)) return true;
  const tempSibling = trialCatalogFindTempSiblingRow(ps, pool);
  if (!tempSibling) return false;
  return trialIsCatalogOpAllocatedOnPs(card, tempSibling);
}

function trialCatalogPsHasQueuedBlocksIncludingTemp(ps, pool) {
  if (typeof trialPsHasQueuedBlocks === 'function' && trialPsHasQueuedBlocks(ps)) return true;
  const tempSibling = trialCatalogFindTempSiblingRow(ps, pool);
  if (!tempSibling) return false;
  return typeof trialPsHasQueuedBlocks === 'function' && trialPsHasQueuedBlocks(tempSibling);
}

/** Hide the ERP source PS when an active [Temp] reject/rework line covers the same partial. */
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
    if (!row?.is_temp_ps && !(typeof trialIsTempCatalogPs === 'function' && trialIsTempCatalogPs(row))) {
      return false;
    }
    if (!trialCatalogTempPsIsActive(row)) return false;
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
    const pool = typeof trialCatalogPsPools === 'function' ? trialCatalogPsPools().all : [];
    const allocated = typeof trialIsCatalogOpAllocatedIncludingTemp === 'function'
      ? trialIsCatalogOpAllocatedIncludingTemp(card, ps, pool)
      : trialIsCatalogOpAllocated(card);
    if (!allocated) return;
    trialQueuedMachineCodesForCatalogOpIncludingTemp(card, ps).forEach(code => codes.add(code));
  });
  return [...codes].sort();
}

function trialQueuedMachineCodesForCatalogOpIncludingTemp(card, ps) {
  const fromSelf = typeof trialQueuedMachineCodesForCatalogOp === 'function'
    ? trialQueuedMachineCodesForCatalogOp(card)
    : [];
  if (fromSelf.length) return fromSelf;
  if (!ps) return fromSelf;
  const pool = typeof trialCatalogPsPools === 'function' ? trialCatalogPsPools().all : [];
  const tempSibling = typeof trialCatalogFindTempSiblingRow === 'function'
    ? trialCatalogFindTempSiblingRow(ps, pool)
    : null;
  if (!tempSibling) return fromSelf;
  const tempCard = typeof trialCatalogOpForPs === 'function'
    ? trialCatalogOpForPs(card, tempSibling)
    : card;
  return typeof trialQueuedMachineCodesForCatalogOp === 'function'
    ? trialQueuedMachineCodesForCatalogOp(tempCard)
    : fromSelf;
}

function trialCatalogPsQueuePillHtml(ps) {
  const pool = typeof trialCatalogPsPools === 'function' ? trialCatalogPsPools().all : [];
  const queued = typeof trialCatalogPsHasQueuedBlocksIncludingTemp === 'function'
    ? trialCatalogPsHasQueuedBlocksIncludingTemp(ps, pool)
    : trialPsHasQueuedBlocks(ps);
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

function trialIsFinishingOpCard(card) {
  if (!card) return false;
  if (card.is_finishing || card.op?.is_finishing) return true;
  const desc = String(
    card?.stage_desc || card?.op?.stage_desc
    || card?.op_type || card?.op?.op_type
    || card?.operation_name || card?.op?.operation_name
    || '',
  ).trim();
  if (!desc) return false;
  const lowered = desc.toLowerCase();
  if (lowered === 'deburring' || lowered === 'final inspection' || lowered === 'packing') return true;
  return lowered.includes('engraving') && lowered.includes('packing');
}

/** True when a catalog op matches the PS partial's active ERP WO stage. */
function trialCatalogOpMatchesCurrentStage(card, ps) {
  const stageNo = Number(ps?.current_stage_no || 0);
  const stageDesc = String(ps?.current_stage_desc || '').trim();
  if (!stageNo && !stageDesc) return true;

  const opNo = String(card?.source_op_no || card?.operation_label || '').trim();
  const opType = String(card?.operation_name || card?.op_type || card?.op?.op_type || '').trim();
  const sourceStageNo = Number(card?.source_stage_no ?? card?.op?.source_stage_no ?? 0);

  if (stageNo > 0) {
    if (sourceStageNo > 0 && sourceStageNo === stageNo) return true;
    if (opNo && opNo === String(stageNo)) return true;
  }
  if (stageDesc) {
    const descLower = stageDesc.toLowerCase();
    const typeLower = opType.toLowerCase();
    if (typeLower && (typeLower === descLower || typeLower.includes(descLower) || descLower.includes(typeLower))) {
      return true;
    }
    if (opNo && stageDesc.includes(opNo)) return true;
  }
  return false;
}

/** Mirror planning/catalog.py _is_machining_plannable_op — scheduler sidebar machining ops only. */
function trialCatalogOpIsMachiningPlannable(opType, machineCategory, sourceKind, preferredMachine) {
  if (String(preferredMachine || '').trim()) return true;
  const cat = String(machineCategory || '').trim().toUpperCase();
  if (cat === 'TURNING' || cat === 'MILLING' || cat === 'TURNMILL' || cat === 'PLACEHOLDER') return true;
  const opUpper = String(opType || '').trim().toUpperCase();
  if (opUpper === 'PLACEHOLDER') return true;
  const opText = String(opType || '').trim();
  if (/^(BOM|MATERIAL|MAT\b|SUBCON|SUB\s*CON|SMP[\s-]*MAT|KITTING|PACK)\b/i.test(opText)) return false;
  if (/^(Turning|Milling|Turnmill)\b/i.test(opText)) return true;
  if (String(sourceKind || '').toUpperCase() === 'MANUAL' && opText) return true;
  return false;
}

function trialCatalogOpIsRelevant(card) {
  if (!card) return false;
  if (trialCatalogOpIsManualBom(card)) return true;
  if (trialIsFinishingOpCard(card)) return false;
  const opRef = card.op || {};
  const stageNo = Number(card.source_stage_no ?? opRef.source_stage_no ?? 0);
  const sourceKind = String(card.source_kind || opRef.source_kind || '').trim().toUpperCase();
  if (stageNo > 0 && sourceKind === 'ERP_WO') {
    const cat = String(card.compatible_machine_group || opRef.machine_category || '').trim().toUpperCase();
    if (cat === 'FINISHING') return false;
  }
  const opType = String(
    card.operation_name || card.op_type || opRef.op_type || card.stage_desc || opRef.stage_desc || '',
  ).trim();
  const machineCat = String(card.compatible_machine_group || opRef.machine_category || '').trim();
  const preferred = String(card.preferred_machine || opRef.preferred_machine || '').trim();
  return trialCatalogOpIsMachiningPlannable(opType, machineCat, sourceKind, preferred);
}

function trialCatalogPsPools() {
  const catalog = typeof trialMergedCatalogRows === 'function'
    ? trialMergedCatalogRows()
    : (Array.isArray(trialState?.catalog) ? trialState.catalog : []);
  const planned = Array.isArray(trialState?.planned) ? trialState.planned : [];
  return { catalog, planned, all: [...catalog, ...planned] };
}

function trialCatalogFindPsRow(psId, partialNo = '') {
  const needle = String(psId || '').trim();
  if (!needle) return null;
  const { catalog, planned } = trialCatalogPsPools();
  const direct = [...catalog, ...planned].find(row => String(row?.ps_id || '') === needle);
  if (direct) return direct;
  const parts = typeof trialSplitPsId === 'function'
    ? trialSplitPsId(needle)
    : { base: needle, partial: '' };
  const base = String(parts.base || needle).trim();
  const wantPartial = String(partialNo || parts.partial || '').trim() || '1';
  const matcher = ps => {
    if (String(ps?.ps_id || '') === needle) return true;
    if (typeof trialIsTempCatalogPs === 'function' && trialIsTempCatalogPs(ps)) {
      return String(ps?.ps_id || '').trim() === needle
        || (typeof trialCatalogSourceBase === 'function' && trialCatalogSourceBase(ps) === base);
    }
    const rowBase = typeof trialCatalogSourceBase === 'function'
      ? trialCatalogSourceBase(ps)
      : String(trialSplitPsId(ps?.ps_id || '').base || '').trim();
    if (rowBase !== base) return false;
    const rowPartial = String(
      ps?.pp_partial_no ?? trialSplitPsId(ps?.ps_id || '').partial ?? '1',
    ).trim();
    return rowPartial === wantPartial;
  };
  return catalog.find(matcher) || planned.find(matcher) || null;
}

function trialCatalogPsFromElement(opEl) {
  const psEl = opEl?.closest?.('.trial-catalog-ps, .trial-catalog-planned-ps');
  if (!psEl) return null;
  const psId = String(psEl.dataset?.psId || '').trim();
  if (!psId) return null;
  const partialNo = Number(opEl?.dataset?.ppPartialNo || 0) || '';
  return trialCatalogFindPsRow(psId, partialNo);
}

function trialCatalogDragContextFromElement(el) {
  if (!el) return null;
  const sourcePayload = typeof trialEnrichOpCardPayload === 'function'
    ? trialEnrichOpCardPayload(el, trialOpCardPayloadFromElement(el))
    : trialOpCardPayloadFromElement(el);
  if (!sourcePayload || sourcePayload.type !== 'op-card') return null;
  const psRow = trialCatalogPsFromElement(el);
  const catalogCard = typeof trialCatalogCardFromPayload === 'function'
    ? trialCatalogCardFromPayload(sourcePayload)
    : sourcePayload;
  const workCard = typeof trialCatalogOpForPs === 'function'
    ? trialCatalogOpForPs(catalogCard, psRow)
    : catalogCard;
  const ui = typeof trialCatalogOpCardUiState === 'function'
    ? trialCatalogOpCardUiState(workCard, psRow)
    : null;
  const canDrag = ui ? ui.canDrag : trialCatalogOpCanDrag(workCard, psRow);
  const dragBlockReason = ui ? (ui.dragBlockReason || '') : (
    trialCatalogOpDragEligibility(workCard, psRow).reason || ''
  );
  return { sourcePayload, psRow, workCard, canDrag, dragBlockReason };
}

function trialCatalogOpBypassesStageInQueuedOp40View(card, ps) {
  if (!trialCatalogQueuedOp40PendingFilterActive() || !ps || !card) return false;
  if (!trialCatalogOpIsOp40(card)) return false;
  const pool = typeof trialCatalogPsPools === 'function' ? trialCatalogPsPools().all : [];
  if (!trialCatalogPsHasQueuedBlocksIncludingTemp(ps, pool)) return false;
  if (trialCatalogOpIsProductionComplete(card, ps)) return false;
  if (trialIsCatalogOpAllocatedIncludingTemp(card, ps, pool)) return false;
  if (trialCatalogSchedulableRemaining(card) <= 0.0001) return false;
  return true;
}

function trialCatalogRouteOpsForPs(ps) {
  return trialResolvedOpCardsForPs(ps)
    .map(row => (typeof trialCatalogOpForPs === 'function' ? trialCatalogOpForPs(row, ps) : row))
    .filter(row => String(row.card_kind || 'single') !== 'group')
    .filter(row => trialCatalogOpIsRelevant(row))
    .sort((a, b) => (
      Number(a.source_op_seq_id || 0) - Number(b.source_op_seq_id || 0)
      || Number(trialCatalogNormalizedOpNo(a) || 0) - Number(trialCatalogNormalizedOpNo(b) || 0)
      || String(a.source_op_no || a.operation_label || '').localeCompare(String(b.source_op_no || b.operation_label || ''))
    ));
}

function trialResolvedOpCardsForPs(ps) {
  const stampPs = (card) => ({
    ...card,
    ps_id: card?.ps_id || ps?.ps_id || '',
    pp_partial_no: card?.pp_partial_no ?? ps?.pp_partial_no,
  });
  const baseCards = (Array.isArray(ps?.op_cards) ? ps.op_cards : [])
    .filter(card => trialCatalogOpIsRelevant(card))
    .map(card => {
      const stamped = stampPs(card);
      if (typeof trialHasLiveBlockQueueIndex === 'function' && trialHasLiveBlockQueueIndex()) {
        const liveAllocated = typeof trialIsCatalogOpAllocated === 'function'
          && trialIsCatalogOpAllocated(stamped);
        return {
          ...stamped,
          is_allocated: liveAllocated,
          queued_machines: liveAllocated ? (stamped.queued_machines || []) : [],
        };
      }
      return stamped;
    });
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
    if (!trialCatalogOpIsRelevant(card)) return;
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
    if (!trialCatalogOpIsRelevant(card)) return;
    if (!trialCatalogOpShouldShow(card, () => false, ps)) return;
    merged.push(card);
    seen.add(key);
  });
  return merged.sort((a, b) =>
    Number(a.source_op_seq_id || 0) - Number(b.source_op_seq_id || 0) ||
    String(a.source_op_no || a.operation_label || '').localeCompare(String(b.source_op_no || b.operation_label || ''))
  );
}

function trialCatalogOpShouldShow(card, isOpAllocated, ps) {
  return trialCatalogOpIsOpen(card, ps)
    || trialCatalogOpIsComplete(card, ps)
    || trialCatalogOpIsManualBom(card)
    || isOpAllocated(card)
    || trialCatalogOpHasQueuedBlocks(card);
}

function trialPsIsUnassignedCatalog(ps) {
  if (typeof trialIsTempCatalogPs === 'function' && trialIsTempCatalogPs(ps)) {
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
  if (cards.some(card => trialCatalogOpIsOpen(card, ps))) return false;
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
  renderTrialPsTypeFilter();
  renderTrialCatalog();
}

// ── Filters ───────────────────────────────────────────────────────────────────

function trialMachinistBoardCategories() {
  return ['ALL', 'MPP', 'MILLING', 'TURNING', 'TURNMILL'];
}

function trialMachineFilterButtonLabel() {
  if (typeof trialIsMachinistBoard === 'function' && trialIsMachinistBoard()
    && typeof trialMachinistFilterButtonLabel === 'function') {
    return trialMachinistFilterButtonLabel();
  }
  const machines = trialMachinesInCategory();
  if (!machines.length) return 'No machines';
  const selectedCount = machines.filter(m => !trialMachineHiddenSet.has(m.machine_code)).length;
  if (selectedCount === machines.length) return 'All machines';
  if (selectedCount === 0) return 'No machines selected';
  return `${selectedCount}/${machines.length} machines`;
}

function trialMachineFilterDomIds(scope) {
  const s = String(scope || 'planner');
  return {
    dropdownId: `${s}-machine-filter-dropdown`,
    btnId: `${s}-machine-filter-btn`,
    panelId: `${s}-machine-filter-panel`,
  };
}

function trialUsesInlineMachineFilterPanel() {
  try {
    return window.matchMedia('(max-width: 900px)').matches;
  } catch (_) {
    return false;
  }
}

function trialResetMachineFilterPanelPosition(scope) {
  const { panelId } = trialMachineFilterDomIds(scope);
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.style.position = '';
  panel.style.top = '';
  panel.style.left = '';
  panel.style.right = '';
  panel.style.width = '';
  panel.style.maxHeight = '';
}

function trialSyncMachineFilterPanelPosition(scope) {
  const { dropdownId, btnId, panelId } = trialMachineFilterDomIds(scope);
  const dropdown = document.getElementById(dropdownId);
  const btn = document.getElementById(btnId);
  const panel = document.getElementById(panelId);
  if (!dropdown || !btn || !panel || panel.hidden) {
    trialResetMachineFilterPanelPosition(scope);
    return;
  }

  dropdown.classList.add('is-open');
  if (trialUsesInlineMachineFilterPanel()) {
    trialResetMachineFilterPanelPosition(scope);
    return;
  }

  const margin = 8;
  const panelWidth = Math.min(260, Math.max(168, window.innerWidth - margin * 2));
  const rect = btn.getBoundingClientRect();
  let left = rect.right - panelWidth;
  if (left < margin) left = margin;
  if (left + panelWidth > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - panelWidth - margin);
  }
  const maxHeight = Math.min(320, Math.max(120, window.innerHeight - rect.bottom - margin - 4));

  panel.style.position = 'fixed';
  panel.style.top = `${Math.round(rect.bottom + 4)}px`;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.right = 'auto';
  panel.style.width = `${Math.round(panelWidth)}px`;
  panel.style.maxHeight = `${Math.round(maxHeight)}px`;
}

function trialToggleMachineFilterPanel(scope) {
  const { dropdownId, panelId } = trialMachineFilterDomIds(scope);
  const dropdown = document.getElementById(dropdownId);
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (panel.hidden) {
    if (trialMachineFilterPanelOpenScope === scope) trialMachineFilterPanelOpenScope = null;
    dropdown?.classList.remove('is-open');
    trialResetMachineFilterPanelPosition(scope);
  } else {
    trialMachineFilterPanelOpenScope = scope;
    trialSyncMachineFilterPanelPosition(scope);
  }
}

function trialCloseMachineFilterPanel(scope) {
  const { dropdownId, panelId } = trialMachineFilterDomIds(scope);
  const dropdown = document.getElementById(dropdownId);
  const panel = document.getElementById(panelId);
  if (panel) panel.hidden = true;
  if (trialMachineFilterPanelOpenScope === scope) trialMachineFilterPanelOpenScope = null;
  dropdown?.classList.remove('is-open');
  trialResetMachineFilterPanelPosition(scope);
}

function trialCloseAllMachineFilterPanels() {
  trialMachineFilterPanelOpenScope = null;
  trialCloseMachineFilterPanel('machinist');
  trialCloseMachineFilterPanel('planner');
}

function trialSyncMachineFilterButtonLabel(scope) {
  const { btnId } = trialMachineFilterDomIds(scope);
  const btn = document.getElementById(btnId);
  if (btn) btn.textContent = `${trialMachineFilterButtonLabel()} ▾`;
}

function trialMachineFilterPanelWasOpen(scope) {
  const { panelId } = trialMachineFilterDomIds(scope);
  const panel = document.getElementById(panelId);
  return panel && !panel.hidden;
}

function trialRestoreMachineFilterPanelIfOpen(scope) {
  if (trialMachineFilterPanelOpenScope !== scope && !trialMachineFilterPanelWasOpen(scope)) return;
  const { panelId } = trialMachineFilterDomIds(scope);
  const panel = document.getElementById(panelId);
  if (panel) {
    panel.hidden = false;
    trialMachineFilterPanelOpenScope = scope;
    trialSyncMachineFilterPanelPosition(scope);
  }
}

let trialMachineFilterBindingsBound = false;

function trialBindMachineFilterDropdowns() {
  if (trialMachineFilterBindingsBound) return;
  trialMachineFilterBindingsBound = true;
  document.addEventListener('click', (event) => {
    ['machinist', 'planner'].forEach(scope => {
      const { dropdownId, panelId } = trialMachineFilterDomIds(scope);
      const panel = document.getElementById(panelId);
      if (!panel || panel.hidden) return;
      const dropdown = document.getElementById(dropdownId);
      if (dropdown?.contains(event.target)) return;
      trialCloseMachineFilterPanel(scope);
    });
  });
  window.addEventListener('resize', () => {
    ['machinist', 'planner'].forEach(scope => {
      const { panelId } = trialMachineFilterDomIds(scope);
      const panel = document.getElementById(panelId);
      if (panel && !panel.hidden) trialSyncMachineFilterPanelPosition(scope);
    });
  });
}

function renderTrialMachineDropdownFilter(scope = 'planner') {
  const machines = trialMachinesInCategory();
  const machineBtnLabel = trialMachineFilterButtonLabel();
  const machinistScope = scope === 'machinist';
  const machineLabel = machinistScope && typeof trialMachinistT === 'function'
    ? trialMachinistT('machine')
    : 'Machine';
  const allLabel = machinistScope && typeof trialMachinistT === 'function'
    ? trialMachinistT('all')
    : 'All';
  const noneLabel = machinistScope && typeof trialMachinistT === 'function'
    ? trialMachinistT('none')
    : 'None';
  const emptyMachinesLabel = machinistScope && typeof trialMachinistT === 'function'
    ? trialMachinistT('no_machines_in_group')
    : 'No machines in this group';
  const { dropdownId, btnId, panelId } = trialMachineFilterDomIds(scope);
  const machineCheckboxes = machines.map(m => {
    const code = m.machine_code || '';
    const checked = !trialMachineHiddenSet.has(code);
    return `<label class="filter-dropdown-item" onclick="event.stopPropagation()">
        <input type="checkbox" ${checked ? 'checked' : ''}
          onclick="event.stopPropagation()"
          onchange="toggleTrialMachineFilter('${escapeHtml(code)}', this.checked)">
        <span>${escapeHtml(code)}</span>
      </label>`;
  }).join('');
  const scopeAttr = escapeHtml(scope);
  return `
    <div class="trial-filter-inline trial-filter-section-machines">
      <span class="trial-filter-label">${escapeHtml(machineLabel)}</span>
      <div class="filter-dropdown trial-board-machine-filter-dropdown" id="${dropdownId}">
        <button type="button" class="filter-dropdown-btn" id="${btnId}"
          onclick="event.stopPropagation(); trialToggleMachineFilterPanel('${scopeAttr}')">
          ${escapeHtml(machineBtnLabel)} ▾
        </button>
        <div class="filter-dropdown-panel trial-board-machine-filter-panel" id="${panelId}" hidden
          onclick="event.stopPropagation()">
          <div class="trial-board-machine-filter-panel-head">
            <button type="button" class="trial-machine-toggle-btn"
              onclick="event.stopPropagation(); setAllTrialMachinesVisible(true)">${escapeHtml(allLabel)}</button>
            <button type="button" class="trial-machine-toggle-btn"
              onclick="event.stopPropagation(); setAllTrialMachinesVisible(false)">${escapeHtml(noneLabel)}</button>
          </div>
          ${machineCheckboxes || `<div class="trial-board-machine-filter-empty">${escapeHtml(emptyMachinesLabel)}</div>`}
        </div>
      </div>
    </div>
  `;
}

function renderTrialMachinistJobSearchBar() {
  const query = escapeHtml(trialMachinistJobSearch || '');
  const t = typeof trialMachinistT === 'function' ? trialMachinistT : (key) => key;
  return `
    <div class="machinist-job-search" id="machinist-job-search-wrap">
      <label class="machinist-job-search-label" for="machinist-job-search-input">${escapeHtml(t('find_job'))}</label>
      <input type="search"
        id="machinist-job-search-input"
        class="machinist-job-search-input"
        placeholder="${escapeHtml(t('job_placeholder'))}"
        value="${query}"
        autocomplete="off"
        enterkeyhint="search"
        oninput="scheduleTrialMachinistJobSearch()"
        onkeydown="trialMachinistJobSearchKeydown(event)"
        onfocus="trialRefreshMachinistJobSearchResults()">
      <span class="machinist-job-search-warning" role="alert">${escapeHtml(t('unsure_warning'))}</span>
      <div id="machinist-job-search-results" class="machinist-job-search-results" hidden></div>
    </div>
  `;
}

function scheduleTrialMachinistJobSearch() {
  clearTimeout(trialMachinistJobSearchTimer);
  trialMachinistJobSearchTimer = window.setTimeout(() => {
    trialMachinistJobSearchTimer = null;
    trialRefreshMachinistJobSearchResults();
  }, 150);
}

function trialMachinistJobSearchKeydown(event) {
  if (!event) return;
  if (event.key === 'Escape') {
    const panel = document.getElementById('machinist-job-search-results');
    if (panel) panel.hidden = true;
    event.target?.blur?.();
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (trialMachinistJobSearchHits.length) trialNavigateToMachinistJobHit(0);
  }
}

function trialRefreshMachinistJobSearchResults() {
  const input = document.getElementById('machinist-job-search-input');
  const panel = document.getElementById('machinist-job-search-results');
  if (!input || !panel) return;
  const query = String(input.value || '').trim();
  trialMachinistJobSearch = query;
  if (query.length < 2) {
    panel.hidden = true;
    panel.innerHTML = '';
    trialMachinistJobSearchHits = [];
    return;
  }
  trialMachinistJobSearchHits = typeof trialSearchMachinistQueues === 'function'
    ? trialSearchMachinistQueues(query)
    : [];
  if (!trialMachinistJobSearchHits.length) {
    panel.hidden = false;
    panel.innerHTML = `<div class="machinist-job-search-empty">${escapeHtml(
      typeof trialMachinistT === 'function' ? trialMachinistT('no_jobs_match') : 'No queued jobs match.',
    )}</div>`;
    return;
  }
  panel.hidden = false;
  panel.innerHTML = trialMachinistJobSearchHits.map((hit, idx) => {
    const posLabel = hit.queuePosition === 1
      ? (typeof trialMachinistT === 'function' ? trialMachinistT('job_pos_head') : '#1 · head')
      : (typeof trialMachinistT === 'function'
        ? trialMachinistT('job_pos', { n: hit.queuePosition })
        : `#${hit.queuePosition}`);
    const partialNote = hit.partial ? ` · P${hit.partial}` : '';
    return `<button type="button" class="machinist-job-search-hit"
      onclick="trialNavigateToMachinistJobHit(${idx})">
      <span class="machinist-job-search-hit-main">
        <span class="machinist-job-search-hit-machine">${escapeHtml(hit.machineCode)}</span>
        <span class="machinist-job-search-hit-pos">${escapeHtml(posLabel)}</span>
      </span>
      <span class="machinist-job-search-hit-detail">
        <span class="machinist-job-search-hit-job">${escapeHtml(hit.psDisplay)}${escapeHtml(partialNote)}</span>
        <span class="machinist-job-search-hit-op">${escapeHtml(hit.operationLine)}</span>
      </span>
    </button>`;
  }).join('');
}

function trialHighlightMachinistJobCard(machineId, groupId, blockId) {
  const machineRoot = document.querySelector(`.trial-machine[data-machine-id="${machineId}"]`);
  if (!machineRoot) return false;
  let card = null;
  if (groupId > 0) {
    card = machineRoot.querySelector(`[data-group-id="${groupId}"]`);
  }
  if (!card && blockId > 0) {
    card = machineRoot.querySelector(`[data-block-id="${blockId}"]`);
  }
  if (!card) return false;
  const lane = machineRoot.querySelector('.trial-lane');
  if (lane && lane.scrollHeight > lane.clientHeight) {
    const laneRect = lane.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    lane.scrollTop += cardRect.top - laneRect.top - (laneRect.height / 2) + (cardRect.height / 2);
  }
  card.classList.add('trial-job-search-hit');
  window.setTimeout(() => card.classList.remove('trial-job-search-hit'), 3200);
  return true;
}

function trialScrollMachinistMachineIntoView(machineId) {
  const machineRoot = document.querySelector(`.trial-machine[data-machine-id="${machineId}"]`);
  if (!machineRoot) return;
  const gridScroll = document.querySelector('.trial-grid-scroll');
  if (!gridScroll || gridScroll.scrollWidth <= gridScroll.clientWidth) {
    machineRoot.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    return;
  }
  const hostRect = gridScroll.getBoundingClientRect();
  const machineRect = machineRoot.getBoundingClientRect();
  const delta = (machineRect.left + machineRect.width / 2)
    - (hostRect.left + hostRect.width / 2);
  gridScroll.scrollTo({ left: gridScroll.scrollLeft + delta, behavior: 'smooth' });
}

function trialNavigateToMachinistJobHit(idx) {
  const hit = trialMachinistJobSearchHits[Number(idx)];
  if (!hit) return;
  const machine = (trialState.machines || []).find(row => Number(row.machine_id) === hit.machineId);
  const panel = document.getElementById('machinist-job-search-results');
  if (panel) panel.hidden = true;

  const finishNavigate = () => {
    window.requestAnimationFrame(() => {
      trialScrollMachinistMachineIntoView(hit.machineId);
      window.setTimeout(() => {
        const highlighted = trialHighlightMachinistJobCard(hit.machineId, hit.groupId, hit.blockId);
        if (!highlighted) {
          const msg = typeof trialMachinistT === 'function'
            ? trialMachinistT('job_on_machine', {
              ps: hit.psDisplay,
              pos: hit.queuePosition,
              machine: hit.machineCode,
            })
            : `${hit.psDisplay} is #${hit.queuePosition} on ${hit.machineCode}`;
          if (typeof toast === 'function') toast(msg, 'info');
        }
      }, 280);
    });
  };

  let needsRender = false;
  if (machine && typeof trialEnsureMachineLaneVisibleForSearch === 'function') {
    needsRender = trialEnsureMachineLaneVisibleForSearch(machine);
  }
  if (typeof trialEnsureMachinistFocusMachineSelected === 'function') {
    needsRender = trialEnsureMachinistFocusMachineSelected(hit.machineId) || needsRender;
  }
  if (needsRender) {
    renderTrial({ skipCatalog: true, preserveScroll: true });
    finishNavigate();
    return;
  }
  finishNavigate();
}

let trialMachinistJobSearchDismissBound = false;

function trialBindMachinistJobSearchDismiss() {
  if (trialMachinistJobSearchDismissBound) return;
  trialMachinistJobSearchDismissBound = true;
  document.addEventListener('click', (event) => {
    const wrap = document.getElementById('machinist-job-search-wrap');
    if (!wrap || wrap.contains(event.target)) return;
    const panel = document.getElementById('machinist-job-search-results');
    if (panel) panel.hidden = true;
  });
}

function renderTrialMachinistFocusWarning() {
  return `
    <div class="machinist-focus-warning" role="alert">
      IF UNSURE PLEASE ASK PRODUCTION CONTROLLER
    </div>
  `;
}

function renderTrialMachinistFocusMachinePicker() {
  const t = typeof trialMachinistT === 'function' ? trialMachinistT : (key, vars) => key;
  const machines = typeof trialMachinesForFocusGrid === 'function'
    ? trialMachinesForFocusGrid()
    : [];
  const selectedIds = typeof trialGetMachinistFocusMachineIds === 'function'
    ? trialGetMachinistFocusMachineIds()
    : [];
  const maxMachines = typeof trialMachinistFocusMaxMachines === 'function'
    ? trialMachinistFocusMaxMachines()
    : 4;
  const atMax = selectedIds.length >= maxMachines;
  if (!machines.length) {
    return `<div class="machinist-focus-picker machinist-focus-picker--empty">${escapeHtml(t('no_active_jobs'))}</div>`;
  }

  const GROUP_ORDER = ['MPP', 'MILLING', 'TURNING', 'TURNMILL'];
  const grouped = new Map();
  machines.forEach(machine => {
    const cat = String(machine.machine_category || '').trim().toUpperCase() || 'OTHER';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(machine);
  });
  const sortedCats = [
    ...GROUP_ORDER.filter(g => grouped.has(g)),
    ...[...grouped.keys()].filter(g => !GROUP_ORDER.includes(g)).sort(),
  ];

  const makeChip = machine => {
    const machineId = Number(machine.machine_id || 0);
    const active = selectedIds.includes(machineId);
    const disabled = !active && atMax;
    const clickAttr = disabled ? '' : ` onclick="trialToggleMachinistFocusMachine(${machineId})"`;
    return `<button type="button"
      class="machinist-focus-machine-chip${active ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}"
      aria-pressed="${active ? 'true' : 'false'}"
      ${disabled ? 'disabled tabindex="-1"' : ''}${clickAttr}>
      ${escapeHtml(machine.machine_code || '')}
    </button>`;
  };

  const groupsHtml = sortedCats.map(cat => {
    const label = typeof trialMachineCategoryLabel === 'function' ? trialMachineCategoryLabel(cat) : cat;
    const chips = (grouped.get(cat) || []).map(makeChip).join('');
    return `
      <div class="machinist-focus-machine-group">
        <span class="machinist-focus-machine-group-label">${escapeHtml(label)}</span>
        <div class="machinist-focus-machine-chips">${chips}</div>
      </div>`;
  }).join('');

  const countLabel = selectedIds.length
    ? `${selectedIds.length}/${maxMachines}`
    : t('none');
  const clearBtn = selectedIds.length
    ? `<button type="button" class="machinist-focus-clear-btn" onclick="trialClearMachinistFocusMachines()">${escapeHtml(t('clear'))}</button>`
    : '';
  return `
    <div class="machinist-focus-picker">
      <div class="machinist-focus-picker-meta">
        <span class="machinist-focus-picker-prompt">${escapeHtml(t('select_machines', { max: maxMachines }))}</span>
        <span class="machinist-focus-picker-count">${escapeHtml(countLabel)}</span>
      </div>
      <div class="machinist-focus-machine-groups" role="group" aria-label="${escapeHtml(t('machines_active_aria'))}">
        ${groupsHtml}
      </div>
      ${clearBtn}
    </div>
  `;
}

function renderTrialMachinistBoardFilters() {
  const searchBar = renderTrialMachinistJobSearchBar();
  const focusLayout = typeof trialMachinistFocusLayoutActive === 'function'
    && trialMachinistFocusLayoutActive();
  if (focusLayout) {
    return `${searchBar}${renderTrialMachinistFocusMachinePicker()}`;
  }
  const categories = trialMachinistBoardCategories();
  const groupLabel = typeof trialMachinistT === 'function' ? trialMachinistT('group') : 'Group';
  return `${searchBar}
    <div class="machinist-board-filters">
      <div class="trial-filter-inline trial-filter-section-type">
        <span class="trial-filter-label">${escapeHtml(groupLabel)}</span>
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
      ${renderTrialMachineDropdownFilter('machinist')}
    </div>
  `;
}

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

function renderTrialMppMachinesToggle() {
  const visible = typeof trialIsMppMachinesVisible === 'function' && trialIsMppMachinesVisible();
  return `
    <div class="trial-filter-inline trial-filter-section-mpp">
      <span class="trial-filter-label">MPP</span>
      <button type="button"
        class="trial-machine-filter-btn trial-mpp-machines-toggle${visible ? ' active' : ''}"
        onclick="trialToggleMppMachinesVisible()"
        aria-pressed="${visible ? 'true' : 'false'}"
        title="${visible ? 'Hide CNC 35, 36, and 41 lanes (use MPP planner tab)' : 'Show CNC 35, 36, and 41 lanes on this board'}">
        ${visible ? 'MPP lanes on' : 'Show MPP lanes'}
      </button>
    </div>
  `;
}

function setTrialMachineCategoryFilter(category) {
  trialMachineCategoryFilter = String(category || 'ALL').toUpperCase();
  trialCloseAllMachineFilterPanels();
  renderTrial();
}

function toggleTrialMachineFilter(machineCode, visible) {
  if (visible) {
    trialMachineHiddenSet.delete(machineCode);
  } else {
    trialMachineHiddenSet.add(machineCode);
  }
  const openScope = trialMachineFilterPanelOpenScope;
  if (openScope) trialSyncMachineFilterButtonLabel(openScope);
  renderTrial({
    skipFilterShell: Boolean(openScope),
    skipCatalog: true,
  });
}

function setAllTrialMachinesVisible(visible) {
  const machines = trialMachinesInCategory();
  if (visible) {
    machines.forEach(m => trialMachineHiddenSet.delete(m.machine_code));
  } else {
    machines.forEach(m => trialMachineHiddenSet.add(m.machine_code));
  }
  const openScope = trialMachineFilterPanelOpenScope;
  if (openScope) {
    const { panelId } = trialMachineFilterDomIds(openScope);
    const panel = document.getElementById(panelId);
    panel?.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = visible;
    });
    trialSyncMachineFilterButtonLabel(openScope);
  }
  renderTrial({
    skipFilterShell: Boolean(openScope),
    skipCatalog: true,
  });
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
      ${trialOpReadinessTogglesHtml(ps, {
        operation_id: allocatedBlock?.operation_id,
        planner_ps_id: psId,
        source_ps_id: psId,
        source_op_seq_id: Number(card.source_op_seq_id || 0),
        tooling_ready: card.tooling_ready,
      })}
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

async function openTrialCatalogOpDetail(payload) {
  if (trialPlannerBusyLock > 0) return;
  const { ps, card: foundCard } = trialFindCatalogOpContext(payload);
  if (!foundCard) {
    toast('Operation details not found.', 'error');
    return;
  }
  let card = { ...foundCard };
  const partNo = String(ps?.part_no || ps?.inventory_code || ps?.part_name || '').trim();
  const bomCode = trialPsBomDisplay(ps);
  const opNo = String(card.source_op_no || card.operation_label || '').trim();
  const opType = String(card.operation_name || card.op_type || '').trim();
  if (partNo) {
    try {
      const q = new URLSearchParams({
        part_no: partNo,
        bom_code: bomCode || '',
        op_no: opNo,
        op_type: opType,
        stage_no: String(card.source_op_seq_id || card.op?.source_stage_no || 0),
        fallback_cycle: String(card.cycle_minutes_per_qty || card.op?.cycle_time || 0),
        fallback_setup: String(card.setup_minutes || card.op?.setup_time || 0),
        inventory_code: String(ps?.inventory_code || '').trim(),
        part_desc: String(ps?.part_desc || '').trim(),
      });
      const resolved = await GET(`/api/trial/cycle-times/resolve?${q.toString()}`);
      if (resolved?.source === 'master') {
        if (Number(resolved.cycle_time || 0) > 0) {
          card.cycle_minutes_per_qty = Number(resolved.cycle_time);
        }
        if (Number(resolved.set_up_time || 0) > 0) {
          card.setup_minutes = Number(resolved.set_up_time);
        }
        if (card.op) {
          card.op = {
            ...card.op,
            cycle_time: card.cycle_minutes_per_qty,
            setup_time: card.setup_minutes,
          };
        }
      }
    } catch (err) {
      console.warn('cycle-time resolve failed:', err);
    }
  }
  const basePs = String(ps?.ps_id || card.ps_id || '').split('::')[0] || 'PS';
  const opDisp = trialBlockOpDisplay({
    source_op_no: card.source_op_no || card.operation_label,
    operation_name: card.operation_name || card.op_type || '',
  });
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

function trialCatalogQueueAllBtnHtml(ps) {
  const psId = String(ps?.ps_id || '').trim();
  if (!psId) return '';
  const count = typeof trialSchedulableOpCardsForPs === 'function'
    ? trialSchedulableOpCardsForPs(ps).length
    : 0;
  if (!count) return '';
  return `
    <button
      type="button"
      class="trial-catalog-queue-all-btn"
      onclick="event.stopPropagation(); openTrialQueuePsAllModal('${escapeHtml(psId)}')"
      title="Queue all ${count} open operation${count === 1 ? '' : 's'} — choose machine lane per op"
    >Queue all</button>
  `;
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
        ${(() => {
          const schedulable = typeof trialSchedulableOpCardsForPs === 'function'
            ? trialSchedulableOpCardsForPs(ps)
            : [];
          return schedulable.length
            ? `<button type="button" class="btn btn-primary btn-sm" onclick="closeModal(); openTrialQueuePsAllModal('${escapeHtml(psId)}')">Queue all ops (${schedulable.length})</button>`
            : '';
        })()}
        ${(typeof trialIsTempCatalogPs === 'function' && trialIsTempCatalogPs(ps))
          ? `<button type="button" class="btn btn-ghost btn-sm trial-op-detail-remove" onclick="deleteTempProcessSheetFromScheduler('${escapeHtml(psId)}')">Delete temp PS</button>`
          : ''}
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
  const psRow = typeof trialCatalogPsFromPayload === 'function'
    ? trialCatalogPsFromPayload(block)
    : null;
  const basePs = typeof trialCatalogSourceBase === 'function'
    ? trialCatalogSourceBase(psRow || block)
    : String(block.source_ps_id || block.job_no || '').trim().split('::')[0];
  return {
    ps_id: psRow?.ps_id || block.source_ps_id || block.job_no || '',
    source_ps_id: basePs || block.source_ps_id || block.job_no || '',
    source_op_no: block.source_op_no || block.operation_label || '',
    source_op_seq_id: Number(block.source_op_seq_id || 0),
    operation_label: block.operation_label || block.source_op_no || '',
    operation_name: block.operation_name || block.op_type || '',
    op_type: block.op_type || '',
    part_no: block.part_no || block.part_name || psRow?.part_no || psRow?.part_name || psRow?.inventory_code || '',
    part_name: block.part_name || block.part_no || psRow?.part_name || psRow?.part_no || psRow?.inventory_code || '',
    job_no: block.job_no || block.source_ps_id || '',
  };
}

function trialRenderDummyBlockDetailBody(group, block, machine) {
  const vm = trialBlockGroupViewModel(group);
  const leader = vm.leader || block;
  const blockId = Number(leader?.block_id || block?.block_id || 0);
  const machineLine = machine
    ? `${escapeHtml(machine.machine_code || '')} · ${escapeHtml(machine.machine_category || '')}`
    : '—';
  const description = String(leader?.operation_name || leader?.remarks || '').trim();
  const isCycle = typeof trialIsCycleDummyBlock === 'function' && trialIsCycleDummyBlock(leader);
  return `
    <div class="trial-op-detail trial-op-detail--dummy">
      <div class="trial-op-detail-head">
        <div class="trial-op-detail-title">${escapeHtml(vm.psDisplay.base || leader?.job_no || '')}</div>
        ${description ? `<div class="trial-op-detail-sub">${escapeHtml(description)}</div>` : ''}
        <div class="trial-op-detail-badges"><span class="trial-badge trial-badge--dummy">Dummy card</span></div>
      </div>
      <dl class="trial-op-detail-grid">
        ${trialRenderCatalogOpDetailRow('Machine', machineLine)}
        ${vm.sequenceNo ? trialRenderCatalogOpDetailRow('Queue #', escapeHtml(String(vm.sequenceNo))) : ''}
        ${isCycle ? trialRenderCatalogOpDetailRow('Cycle', escapeHtml(`${vm.cycleMinutesPerQty} min`)) : ''}
        ${trialRenderCatalogOpDetailRow(isCycle ? 'Queued' : 'Start', escapeHtml(vm.scheduleTimeText || '—'))}
        ${trialRenderCatalogOpDetailRow(isCycle ? 'Scheduled end' : 'End', escapeHtml(vm.outputText || '—'))}
      </dl>
      <div class="trial-op-detail-actions">
        <button type="button" class="btn btn-primary btn-sm" onclick="closeModal(); openTrialDummyCardEditor(${blockId})">Edit</button>
        <button type="button" class="btn btn-ghost btn-sm trial-op-detail-remove"
          onclick="removeTrialBlock(${blockId}, ${Number(group.group_id || 0)})">Delete</button>
      </div>
    </div>
  `;
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
  const psIdForDue = leader?.source_ps_id || leader?.job_no || vm.psDisplay.base || '';
  const isTempPs = String(psIdForDue).trim().startsWith('[Temp]');
  const dueDateText = String(trialDueDateForPs(vm.psDueKey) || '—');
  const dueRowLabel = isTempPs ? 'PO due' : 'Due';
  const dueEditBtn = isTempPs && typeof openTempPsPoDueModal === 'function'
    ? `<button type="button" class="btn btn-ghost btn-sm" onclick="openTempPsPoDueModal(${JSON.stringify(psIdForDue)}, ${JSON.stringify(dueDateText === '—' ? '' : dueDateText)})">Set PO due</button>`
    : '';

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
        ${trialRenderCatalogOpDetailRow(dueRowLabel, escapeHtml(dueDateText))}
        ${trialRenderCatalogOpDetailRow('Queued', escapeHtml(vm.queuedText))}
        ${trialRenderCatalogOpDetailRow('End', escapeHtml(vm.outputText))}
        ${trialRenderCatalogOpDetailRow('Setup', leader?.include_setup ? 'Included' : 'Excluded')}
      </dl>
      ${trialOpReadinessTogglesHtml(
        trialCatalogPsRecord(leader?.planner_ps_id || leader?.source_ps_id || leader?.job_no || vm.psDisplay.base || ''),
        leader || block,
      )}
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
                <span>${fmt(member.outputTotal || member.netOutput || 0, 0)} / ${fmt(member.scheduled_qty || 0, 0)} done</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      <div class="trial-op-detail-actions">
        <button type="button" class="btn btn-primary btn-sm" onclick="closeModal(); openTrialMachineQueue(${Number(machine?.machine_id || block?.machine_id || 0)})">Open machine queue</button>
        ${dueEditBtn}
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
  if (vm.isDummy) {
    openModal(`${vm.psDisplay.base || 'Dummy card'} · ${machine?.machine_code || 'Machine'}`, trialRenderDummyBlockDetailBody(group, block, machine), 'md');
    return;
  }
  const title = `${vm.psDisplay.base || 'Run block'} · ${machine?.machine_code || 'Machine'}`;
  openModal(title, trialRenderRunBlockDetailBody(group, block, machine), 'lg');
}

function renderTrialOpCardHtml(card, ps) {
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
  const isAllocated = typeof trialIsCatalogOpAllocatedIncludingTemp === 'function'
    ? trialIsCatalogOpAllocatedIncludingTemp(catalogOpRef, ps, typeof trialCatalogPsPools === 'function' ? trialCatalogPsPools().all : [])
    : (typeof trialIsCatalogOpAllocated === 'function'
      ? trialIsCatalogOpAllocated(catalogOpRef)
      : (!!card.is_allocated || trialCatalogOpHasQueuedBlocks(catalogOpRef)));
  const ui = typeof trialCatalogOpCardUiState === 'function'
    ? trialCatalogOpCardUiState(card, ps)
    : {
      isProductionComplete: trialCatalogOpIsProductionComplete(card, ps),
      isStagePassed: trialCatalogOpIsBeforeCurrentErpStage(card, ps),
      isComplete: trialCatalogOpIsComplete(card, ps),
      execStatus: trialCatalogOpDisplayExecStatus(card, ps),
      canDrag: trialCatalogOpCanDrag(card, ps),
      dragBlockReason: '',
      schedulableRemaining: trialCatalogSchedulableRemaining(card),
    };
  const schedulableRemaining = Number(ui.schedulableRemaining ?? trialCatalogSchedulableRemaining(card));
  const isPartiallyAllocated = isAllocated && schedulableRemaining > 0.0001;
  const displayQty = isAllocated
    ? schedulableRemaining
    : Math.max(schedulableRemaining, Number(card.remaining_qty || card.target_qty || 0));
  const remainingQty = fmt(displayQty, 0);
  const setupMinutes = fmt(card.setup_minutes || 0, 0);
  const cycleMinutes = fmt(card.cycle_minutes_per_qty || 0, 0);
  const opName = String(card.operation_name || '').trim();
  const {
    isProductionComplete,
    isStagePassed,
    isComplete,
    execStatus,
    canDrag,
    dragBlockReason,
  } = ui;
  const execStatusHtml = trialOpStatusHtml(execStatus, {
    opNo: card.operation_label || card.source_op_no || '',
    title: opName,
    compact: true,
  });
  const queuedMachines = typeof trialQueuedMachineCodesForCatalogOpIncludingTemp === 'function'
    ? trialQueuedMachineCodesForCatalogOpIncludingTemp(catalogOpRef, ps)
    : trialQueuedMachineCodesForCatalogOp(catalogOpRef);
  const allocatedBlock = isAllocated
    ? (() => {
      const direct = trialFindBlockForCatalogOp(catalogOpRef);
      if (direct) return direct;
      const pool = typeof trialCatalogPsPools === 'function' ? trialCatalogPsPools().all : [];
      const tempSibling = typeof trialCatalogFindTempSiblingRow === 'function'
        ? trialCatalogFindTempSiblingRow(ps, pool)
        : null;
      if (!tempSibling) return null;
      const tempRef = typeof trialCatalogOpForPs === 'function'
        ? trialCatalogOpForPs(catalogOpRef, tempSibling)
        : catalogOpRef;
      return trialFindBlockForCatalogOp(tempRef);
    })()
    : null;
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
  const canDragFinal = Boolean(canDrag);
  const dragBlockReasonFinal = String(dragBlockReason || '').trim();
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
    <div class="trial-catalog-op trial-planning-card trial-catalog-op--compact trial-catalog-op--clickable ${isScheduled ? 'is-scheduled' : ''} ${isAllocated ? 'is-allocated' : ''} ${isPartiallyAllocated ? 'is-partially-allocated' : ''} ${isManualBom ? 'is-manual-bom' : ''} ${isComplete ? 'is-completed' : ''} ${canDragFinal ? '' : 'is-not-draggable'}"
      draggable="false"
      data-can-drag="${canDragFinal ? '1' : '0'}"
      data-is-complete="${isComplete ? 'true' : 'false'}"
      title="${isProductionComplete
        ? 'Completed — click for details'
        : (isStagePassed
          ? 'ERP stage passed — click for details'
          : (!canDragFinal
          ? (dragBlockReasonFinal ? `Not draggable — ${escapeHtml(dragBlockReasonFinal)}` : 'Click for details — not draggable')
          : (isPartiallyAllocated
            ? `Click for details · drag remainder (${schedulableRemaining} pcs) to another machine`
            : 'Click for details · drag to schedule or combine')))}"
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
  const isDummy = typeof trialIsDummyBlock === 'function' && trialIsDummyBlock(leader);
  const isFixedDummy = isDummy && typeof trialIsFixedDummyBlock === 'function' && trialIsFixedDummyBlock(leader);
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
  const scheduleTimeLabel = isFixedDummy ? 'Start' : (anchored ? 'Anchor' : 'Queued');
  const scheduleTimeText = isFixedDummy
    ? trialFormatDt(trialBlockQueuedAt(leader))
    : (anchored ? anchorText : trialFormatDt(queuedAt));
  const queuedTitle = isFixedDummy
    ? `Start ${trialFormatDt(trialBlockQueuedAt(leader)) || '—'}`
    : (anchored
      ? `Anchor ${anchorText} · Queued ${trialFormatDt(queuedAt)} — tap to edit`
      : `Queued ${trialFormatDt(queuedAt) || '—'} — tap to set anchor`);
  const outputTitle = isFixedDummy ? 'End time' : trialBlockOutputTitle(leader || group);
  const outputPillClass = leader?.actual_end_at ? 'green' : (leader?.actual_start_at ? 'yellow' : '');
  const cycleMinutesPerQty = group.blocks.length > 1
    ? group.blocks.reduce((sum, block) => sum + Number(block.cycle_minutes_per_qty || 0), 0)
    : Number(leader?.cycle_minutes_per_qty || 0);
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
    pairedOutput: fmt(Number(group.paired_output_qty ?? group.output_qty ?? 0), 0),
    cycleMinutesPerQty: fmt(cycleMinutesPerQty, cycleMinutesPerQty % 1 === 0 ? 0 : 2),
    queuedText: trialFormatDt(queuedAt),
    anchorText,
    scheduleTimeLabel,
    scheduleTimeText,
    outputText: trialFormatDt(outputAt),
    queuedTitle,
    outputTitle,
    outputPillClass,
    anchored,
    isDummy,
    isFixedDummy,
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

function trialRenderFocusBlockCard(vm, options = {}) {
  const leader = vm.leader;
  const dueDate = String(trialDueDateForPs(vm.psDueKey) || leader?.due_date || '').trim();
  const dayDiff = dueDate ? trialDateDiffDays(dueDate) : null;
  const dueClass = dayDiff == null ? '' : (dayDiff < 0 ? 'is-overdue' : (dayDiff <= 7 ? 'is-due-soon' : 'is-normal'));
  const isCurrent = !!options.isCurrent;
  const upcomingIdx = Number(options.upcomingIdx || 0);
  const todayTarget = typeof trialFocusTargetForGroup === 'function'
    ? trialFocusTargetForGroup(vm.group)
    : (typeof trialTodayTargetForGroup === 'function' ? trialTodayTargetForGroup(vm.group) : 0);
  const materialInClass = trialMaterialInLaneClass(leader);
  const partialFromKey = String(vm.psDueKey || '').includes('::')
    ? String(vm.psDueKey.split('::')[1] || '').trim()
    : '';
  const partialFromLeader = typeof trialSplitPsId === 'function'
    ? String(trialSplitPsId(leader?.planner_ps_id || leader?.job_no || leader?.source_ps_id || '').partial || '').trim()
    : '';
  const partialNo = String(vm.psDisplay.partial || partialFromKey || partialFromLeader || '').trim();
  const hasPartial = !!partialNo;
  const t = typeof trialMachinistT === 'function' ? trialMachinistT : (key, vars) => key;
  let seqLabel = t('now');
  let seqClass = 'is-now';
  if (!isCurrent) {
    seqLabel = upcomingIdx === 1 ? t('next') : t('then');
    seqClass = upcomingIdx === 1 ? 'is-next' : 'is-later';
  }
  const scheduleLabel = typeof trialMachinistScheduleLabel === 'function'
    ? trialMachinistScheduleLabel(vm.anchored)
    : vm.scheduleTimeLabel;
  const partialBadge = hasPartial
    ? `<span class="trial-focus-partial-badge" title="${escapeHtml(t('partial_title'))}">${escapeHtml(t('partial', { n: partialNo }))}</span>`
    : '';
  return `
    <article class="trial-focus-card ${materialInClass}${isCurrent ? ' is-current' : ''}${hasPartial ? ' has-partial' : ''}"
      data-block-id="${leader?.block_id || ''}"
      data-group-id="${vm.group.group_id || 0}">
      <div class="trial-focus-card-top">
        <span class="trial-focus-seq ${seqClass}">${escapeHtml(seqLabel)}</span>
        <span class="trial-focus-metrics">
          <span class="trial-focus-metric"><span class="trial-pill-label">${escapeHtml(t('qty'))}</span>${vm.targetQty}</span>
          <span class="trial-focus-metric"><span class="trial-pill-label">${escapeHtml(t('out'))}</span>${vm.pairedOutput}</span>
          <span class="trial-focus-metric trial-focus-metric--target"><span class="trial-pill-label">${escapeHtml(t('target'))}</span>${fmt(todayTarget, 0)}</span>
          <span class="trial-focus-metric"><span class="trial-pill-label">${escapeHtml(t('cycle'))}</span>${vm.cycleMinutesPerQty}m</span>
        </span>
      </div>
      <div class="trial-focus-ps-row">
        <div class="trial-focus-ps">${escapeHtml(vm.psDisplay.base || vm.group.title || '')}</div>
        ${partialBadge}
      </div>
      ${hasPartial ? `<div class="trial-focus-partial-note">${escapeHtml(t('partial_note', { n: partialNo }))}</div>` : ''}
      <div class="trial-focus-op">${escapeHtml(vm.operationLine)}</div>
      <div class="trial-focus-dates">
        <span class="trial-focus-date ${dueClass}"><span class="trial-pill-label">${escapeHtml(t('due'))}</span>${escapeHtml(dueDate || '—')}</span>
        <span class="trial-focus-date${vm.anchored ? ' is-anchored' : ''}"><span class="trial-pill-label">${escapeHtml(scheduleLabel)}</span>${escapeHtml(vm.scheduleTimeText || '—')}</span>
        <span class="trial-focus-date is-end ${vm.outputPillClass}"><span class="trial-pill-label">${escapeHtml(t('end'))}</span>${escapeHtml(vm.outputText || '—')}</span>
      </div>
    </article>
  `;
}

function trialRenderCompactBlockCard(vm, options = {}) {
  const leader = vm.leader;
  const dueDate = String(trialDueDateForPs(vm.psDueKey) || leader?.due_date || '').trim();
  const dayDiff = dueDate ? trialDateDiffDays(dueDate) : null;
  const dueClass = dayDiff == null ? '' : (dayDiff < 0 ? 'is-overdue' : (dayDiff <= 7 ? 'is-due-soon' : 'is-normal'));
  const readOnly = typeof trialIsReadOnlyBoard === 'function' && trialIsReadOnlyBoard();
  const focusMode = options.focusMode === true
    || (options.focusMode !== false
      && typeof trialIsMachinistFocusEnabled === 'function'
      && trialIsMachinistFocusEnabled());
  const isCurrent = !!options.isCurrent;
  const todayTarget = focusMode && typeof trialTodayTargetForGroup === 'function'
    ? trialTodayTargetForGroup(vm.group)
    : null;
  const clickableClass = readOnly ? '' : ' trial-block-card--clickable';
  const cardTitle = vm.isDummy
    ? 'Dummy card · click for details'
    : (readOnly ? 'Scheduled job' : 'Click for details · drag edge to move');
  const dragHtml = readOnly
    ? ''
    : '<div class="trial-block-compact-drag" title="Drag to reorder or move to another machine" aria-label="Drag to reorder">⋮⋮</div>';
  const removeBtn = readOnly
    ? ''
    : trialRenderQueueRemoveBtn(leader?.block_id, vm.group.group_id, { className: 'trial-block-remove' });
  const materialInClass = trialMaterialInLaneClass(leader);
  const currentClass = isCurrent ? ' trial-block-card--current' : '';
  const focusClass = focusMode ? ' trial-block-card--focus' : '';
  const dummyClass = vm.isDummy ? ' trial-block-card--dummy' : '';
  const mb = (key, vars) => {
    if (readOnly && typeof trialMachinistT === 'function') return trialMachinistT(key, vars);
    const labels = { qty: 'Qty', out: 'Out', target: 'Target', cycle: 'Cycle', due: 'Due', end: 'End', now: 'Now' };
    if (key === 'partial' && vars?.n) return `Partial ${vars.n}`;
    return labels[key] || key;
  };
  const scheduleLabel = readOnly && typeof trialMachinistScheduleLabel === 'function'
    ? trialMachinistScheduleLabel(vm.anchored)
    : vm.scheduleTimeLabel;
  const targetHtml = focusMode
    ? `<span class="trial-block-compact-date trial-block-compact-target" title="Today's scheduled production target">
            <span class="trial-pill-label">${escapeHtml(mb('target'))}</span>
            <span>${todayTarget != null ? fmt(todayTarget, 0) : '—'}</span>
          </span>`
    : '';
  const metricsHtml = vm.isFixedDummy
    ? ''
    : `<span class="trial-block-compact-metrics" title="Qty / Output / Cycle">
              <span class="trial-block-compact-metric"><span class="trial-pill-label">${escapeHtml(mb('qty'))}</span>${vm.targetQty}</span>
              <span class="trial-block-compact-metric"><span class="trial-pill-label">${escapeHtml(mb('out'))}</span>${vm.pairedOutput}</span>
              ${readOnly ? `<span class="trial-block-compact-metric trial-block-compact-metric--cycle" title="Cycle time per piece"><span class="trial-pill-label">${escapeHtml(mb('cycle'))}</span>${vm.cycleMinutesPerQty}m</span>` : ''}
            </span>`;
  return `
    <div class="trial-block-card trial-block-card--compact${clickableClass}${readOnly ? ' trial-block-card--readonly' : ''}${focusClass}${currentClass}${dummyClass} ${vm.isCombined ? 'combined' : ''} ${materialInClass}"
      data-block-id="${leader?.block_id || ''}"
      data-group-id="${vm.group.group_id || 0}"
      data-block-ids="${vm.groupBlockIds}"
      title="${escapeHtml(cardTitle)}">
      ${dragHtml}
      <div class="trial-block-compact-body">
        <div class="trial-block-compact-top">
          ${vm.sequenceNo ? `<span class="trial-block-seq${isCurrent ? ' is-current' : ''}">${isCurrent ? escapeHtml(mb('now')) : `#${vm.sequenceNo}`}</span>` : ''}
          <div class="trial-block-compact-top-end">
            ${metricsHtml}
            ${removeBtn}
          </div>
        </div>
        <div class="trial-block-title">${escapeHtml(vm.psDisplay.base || vm.group.title || '')}</div>
        ${vm.psDisplay.partial
    ? `<div class="trial-block-partial">${escapeHtml(mb('partial', { n: vm.psDisplay.partial }))}</div>`
    : ''}
        <div class="trial-block-op">${escapeHtml(vm.operationLine)}</div>
        ${vm.splitAllocationHtml ? `<div class="trial-block-split-machines">${vm.splitAllocationHtml}</div>` : ''}
        <div class="trial-block-compact-dates">
          ${vm.isDummy ? '' : `<span class="trial-block-compact-date ${dueClass}" title="Due">
            <span class="trial-pill-label">${escapeHtml(mb('due'))}</span>
            <span>${escapeHtml(dueDate || '—')}</span>
          </span>`}
          ${vm.isDummy
    ? `<span class="trial-block-compact-date" title="Start time">
            <span class="trial-pill-label">${escapeHtml(vm.scheduleTimeLabel)}</span>
            <span>${escapeHtml(vm.scheduleTimeText || '—')}</span>
          </span>`
    : (readOnly
      ? `<span class="trial-block-compact-date ${vm.anchored ? 'is-anchored' : ''}" title="${escapeHtml(vm.queuedTitle)}">
            <span class="trial-pill-label">${escapeHtml(scheduleLabel)}</span>
            <span>${escapeHtml(vm.scheduleTimeText || '—')}</span>
          </span>`
      : `<button type="button" class="trial-block-compact-date is-queued is-clickable ${vm.anchored ? 'is-anchored' : ''}"
            onclick="event.stopPropagation(); editTrialAnchor(${leader?.block_id || 0})"
            aria-label="${escapeHtml(vm.anchored ? `Change anchor ${vm.anchorText}` : 'Set anchor time')}"
            title="${escapeHtml(vm.queuedTitle)}">
            <span class="trial-pill-label">${escapeHtml(vm.scheduleTimeLabel)}</span>
            <span class="trial-anchor-time-value">${escapeHtml(vm.scheduleTimeText || '—')}</span>
            <span class="trial-anchor-edit-icon" aria-hidden="true">✎</span>
          </button>`)}
          <span class="trial-block-compact-date is-end ${vm.outputPillClass}" title="${escapeHtml(vm.outputTitle)}">
            <span class="trial-pill-label">${escapeHtml(mb('end'))}</span>
            <span>${escapeHtml(vm.outputText)}</span>
          </span>
          ${targetHtml}
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

function trialRenderQueueHeadsPanel() {
  const heads = typeof trialFirstQueueHeads === 'function' ? trialFirstQueueHeads() : [];
  const withJobs = heads.filter(head => head.firstGroup);
  const emptyCount = heads.length - withJobs.length;
  const rows = heads.map(head => {
    if (!head.firstGroup) {
      return `
        <tr class="trial-queue-heads-row is-empty" data-machine-id="${head.machine_id}">
          <td><strong>${escapeHtml(head.machine_code)}</strong></td>
          <td class="trial-queue-heads-muted">${escapeHtml(head.machine_category || '—')}</td>
          <td colspan="5" class="trial-queue-heads-empty">Empty queue</td>
        </tr>
      `;
    }
    const vm = trialBlockGroupViewModel(head.firstGroup, { displaySequenceNo: 1 });
    const leader = vm.leader;
    const dueClass = trialQueueDueClass(vm.psDueKey);
    const dueDate = String(trialDueDateForPs(vm.psDueKey) || leader?.due_date || '').trim() || '—';
    const partialNote = vm.psDisplay.partial
      ? ` <span class="trial-queue-partial">P${escapeHtml(vm.psDisplay.partial)}</span>`
      : '';
    const materialInClass = trialMaterialInLaneClass(leader);
    const depthNote = head.queue_depth > 1
      ? `<span class="trial-queue-heads-depth" title="${head.queue_depth} jobs in queue">+${head.queue_depth - 1}</span>`
      : '';
    return `
      <tr class="trial-queue-heads-row ${materialInClass}"
        data-machine-id="${head.machine_id}"
        role="button"
        tabindex="0"
        title="Open ${escapeHtml(head.machine_code)} queue">
        <td>
          <strong>${escapeHtml(head.machine_code)}</strong>
          ${depthNote}
        </td>
        <td class="trial-queue-heads-muted">${escapeHtml(head.machine_category || '—')}</td>
        <td class="trial-queue-heads-ps">${escapeHtml(vm.psDisplay.base || vm.group.title || '—')}${partialNote}</td>
        <td>${escapeHtml(vm.operationLine || '—')}</td>
        <td class="trial-queue-heads-qty">${vm.targetQty}</td>
        <td class="trial-queue-heads-date ${dueClass}">${escapeHtml(dueDate)}</td>
        <td class="trial-queue-heads-start">${escapeHtml(vm.scheduleTimeText || '—')}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="trial-queue-heads-panel">
      <div class="trial-queue-heads-summary">
        <span><strong>${withJobs.length}</strong> machine${withJobs.length === 1 ? '' : 's'} with a current operation</span>
        ${emptyCount ? `<span>${emptyCount} empty</span>` : ''}
      </div>
      <div class="trial-queue-heads-table-wrap">
        <table class="trial-queue-heads-table">
          <thead>
            <tr>
              <th>Machine</th>
              <th>Type</th>
              <th>Process sheet</th>
              <th>Operation</th>
              <th>Qty</th>
              <th>Due</th>
              <th>Start / anchor</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="trial-queue-heads-hint">Click a row to open that machine&apos;s full queue.</p>
    </div>
  `;
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
        <button type="button" class="trial-queue-date is-queued is-clickable ${vm.anchored ? 'is-anchored' : ''}"
          onclick="editTrialAnchor(${blockId})" title="${escapeHtml(vm.queuedTitle)}">
          <span class="trial-anchor-time-value">${escapeHtml(vm.scheduleTimeText || '—')}</span>
          <span class="trial-anchor-edit-icon" aria-hidden="true">✎</span>
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
      <span class="trial-queue-dates-head">
        <span>Due</span>
        <span>Queued</span>
        <span>End</span>
      </span>
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

function renderTrialMachinistFocusLandingHtml() {
  const text = typeof trialMachinistT === 'function'
    ? trialMachinistT('select_machines_landing')
    : 'Select machines above to show lanes.';
  return `
    <div class="trial-focus-landing">
      <p class="trial-focus-landing-text">${escapeHtml(text)}</p>
    </div>
  `;
}

function renderTrialMachineGridHtml() {
  const focusLayout = typeof trialMachinistFocusLayoutActive === 'function'
    && trialMachinistFocusLayoutActive();
  if (focusLayout) {
    const candidates = typeof trialMachinesForFocusGrid === 'function'
      ? trialMachinesForFocusGrid()
      : [];
    if (!candidates.length) return '';
    const machines = typeof trialResolveMachinistFocusMachines === 'function'
      ? trialResolveMachinistFocusMachines()
      : [];
    if (!machines.length) return renderTrialMachinistFocusLandingHtml();
    return machines.map(renderTrialMachine).join('');
  }
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
  const readOnlyMachinist = typeof trialIsReadOnlyBoard === 'function' && trialIsReadOnlyBoard();
  const t = readOnlyMachinist && typeof trialMachinistT === 'function' ? trialMachinistT : null;
  const queueSummary = blockCount
    ? (t ? t('in_queue', { n: blockCount }) : `${blockCount} in queue`)
    : (t ? t('empty_queue') : 'Empty queue');
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
    ? (t ? t('next_available', { dt: trialFormatDt(availabilityEnd) }) : `Next available ${trialFormatDt(availabilityEnd)}`)
    : (t ? t('queued_jobs') : 'Queued jobs');
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
              <span class="trial-machine-anchor-meta is-clickable ${firstAnchorText ? 'is-set' : 'is-unset'}">
                <span class="trial-machine-anchor-meta-text">${anchorMeta}</span>
                <span class="trial-anchor-edit-icon" aria-hidden="true">✎</span>
              </span>
            </span>
          </button>`
      : `<div class="trial-machine-availability">
            <span class="trial-machine-availability-text">${availabilityText}</span>
          </div>`)
    : '';

  const focusMode = typeof trialMachinistFocusLayoutActive === 'function'
    && trialMachinistFocusLayoutActive();
  const displayGroups = focusMode && typeof trialMachinistFocusGroups === 'function'
    ? trialMachinistFocusGroups(groups)
    : groups;
  const blockHtml = displayGroups.length
    ? displayGroups.map((group, idx) => {
      const queueIndex = groups.indexOf(group);
      const sequenceNo = queueIndex >= 0 ? queueIndex + 1 : idx + 1;
      const vm = trialBlockGroupViewModel(group, { displaySequenceNo: sequenceNo });
      if (focusMode) {
        return trialRenderFocusBlockCard(vm, { isCurrent: idx === 0, upcomingIdx: idx });
      }
      return trialRenderCompactBlockCard(vm, { focusMode: false, isCurrent: idx === 0 });
    }).join('')
    : `<div class="trial-empty">${escapeHtml(trialMachineLaneEmptyMessage(allGroups.length, groups.length))}</div>`;

  if (focusMode) {
    return `
    <section class="trial-machine trial-machine--focus trial-machine--focus-lane" data-machine-id="${machine.machine_id}">
      <header class="trial-machine-head trial-machine-head--focus">
        <div class="trial-machine-title">${escapeHtml(machine.machine_code)}</div>
        <span class="trial-machine-focus-hint">${escapeHtml(
          typeof trialMachinistT === 'function'
            ? trialMachinistT('focus_hint', { n: trialMachinistFocusMaxJobs() - 1 })
            : `Now + next ${trialMachinistFocusMaxJobs() - 1} · scroll for more`,
        )}</span>
      </header>
      <div class="trial-lane trial-lane--focus" id="${laneId}" data-machine-id="${machine.machine_id}">
        ${blockHtml}
      </div>
    </section>
  `;
  }

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
          ${staleBadge ? `<button class="btn btn-primary btn-sm" type="button" data-trial-recalc-btn="1" onclick="event.stopPropagation(); trialRecalculateSingleMachine(${machine.machine_id})">Recalc</button>` : ''}
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

function trialSyncStaleMachineBadges() {
  if (typeof trialIsReadOnlyBoard === 'function' && trialIsReadOnlyBoard()) return;
  document.querySelectorAll('.trial-machine[data-machine-id]').forEach(section => {
    const machineId = Number(section.dataset.machineId || 0);
    if (!machineId) return;
    const stale = trialDirtyMachineIds.has(machineId);
    const headMain = section.querySelector('.trial-machine-head-main');
    if (!headMain) return;
    let badge = section.querySelector('.trial-machine-stale-badge');
    const actions = section.querySelector('.trial-machine-head-actions');
    if (stale) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'trial-machine-stale-badge';
        badge.title = 'Queue changed; schedule times may be outdated';
        badge.textContent = 'Schedule outdated';
        headMain.appendChild(badge);
      }
      if (actions && !actions.querySelector('[data-trial-recalc-btn]')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary btn-sm';
        btn.dataset.trialRecalcBtn = '1';
        btn.textContent = 'Recalc';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (typeof trialRecalculateSingleMachine === 'function') {
            trialRecalculateSingleMachine(machineId);
          }
        });
        actions.appendChild(btn);
      }
    } else {
      badge?.remove();
      actions?.querySelector('[data-trial-recalc-btn]')?.remove();
    }
  });
}

let trialMachineGridScrollResizeObserver = null;

function trialSyncMachineGridScrollWidth() {
  const host = document.querySelector('.trial-grid-scroll-host');
  if (!host) return;
  const topInner = host.querySelector('.trial-grid-scroll-top-inner');
  const grid = document.getElementById('trial-grid');
  const main = host.querySelector('.trial-grid-scroll');
  if (!topInner || !grid || !main) return;
  const w = Math.max(main.scrollWidth, grid.scrollWidth, main.clientWidth, 1);
  topInner.style.width = `${w}px`;
}

function trialLaneAbsorbsVerticalWheel(lane, deltaY) {
  if (!lane || !deltaY) return false;
  const maxScroll = lane.scrollHeight - lane.clientHeight;
  if (maxScroll <= 1) return false;
  if (deltaY > 0) return lane.scrollTop < maxScroll - 1;
  return lane.scrollTop > 0;
}

function trialBoardTouchScrollTarget(touch) {
  if (!touch) return null;
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  if (!el) return null;
  const lane = el.closest?.('.trial-lane');
  if (lane) return lane;
  const machine = el.closest?.('.trial-machine, .trial-machine--focus-lane');
  return machine?.querySelector?.('.trial-lane') || null;
}

function trialBoardTouchScrollBlocked(target) {
  return !!target?.closest?.(
    '.trial-block-compact-drag, .trial-catalog-op--clickable:not(.is-completed), '
    + 'button, a, input, select, textarea, label, [contenteditable="true"]',
  );
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

    let touchStartX = 0;
    let touchStartY = 0;
    let touchScrollLeft = 0;
    let touchScrollTop = 0;
    let touchLaneEl = null;
    let touchPanAxis = null;
    let touchPanDisabled = false;
    const resetTouchPan = () => {
      touchPanAxis = null;
      touchLaneEl = null;
      touchPanDisabled = false;
    };
    const onTouchStart = (e) => {
      if (e.touches.length !== 1) {
        resetTouchPan();
        return;
      }
      if (trialBoardTouchScrollBlocked(e.target)) {
        touchPanDisabled = true;
        return;
      }
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchScrollLeft = main.scrollLeft;
      touchLaneEl = trialBoardTouchScrollTarget(e.touches[0]);
      touchScrollTop = touchLaneEl ? touchLaneEl.scrollTop : 0;
      touchPanAxis = null;
      touchPanDisabled = false;
    };
    const onTouchMove = (e) => {
      if (touchPanDisabled || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;
      if (!touchPanAxis && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        touchPanAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      }
      if (touchPanAxis === 'x') {
        if (main.scrollWidth <= main.clientWidth) return;
        e.preventDefault();
        main.scrollLeft = touchScrollLeft - dx;
        syncFromMain();
        return;
      }
      if (touchPanAxis !== 'y') return;
      const lane = touchLaneEl || trialBoardTouchScrollTarget(e.touches[0]);
      if (!lane || lane.scrollHeight <= lane.clientHeight + 1) return;
      e.preventDefault();
      lane.scrollTop = touchScrollTop - dy;
    };
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('touchmove', onTouchMove, { passive: false });
    host.addEventListener('touchend', resetTouchPan, { passive: true });
    host.addEventListener('touchcancel', resetTouchPan, { passive: true });

    const onBoardWheel = (e) => {
      if (e.ctrlKey || e.metaKey) return;
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

function trialCancelDeferredCatalogRender() {
  if (trialDeferredCatalogRenderTimer) {
    clearTimeout(trialDeferredCatalogRenderTimer);
    trialDeferredCatalogRenderTimer = 0;
  }
}

function trialDeferCatalogRender() {
  trialCancelDeferredCatalogRender();
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
  const scrollHost = document.querySelector('.trial-grid-scroll');
  const savedScrollLeft = options.preserveScroll && scrollHost ? scrollHost.scrollLeft : null;
  const savedPageScroll = options.preserveScroll && document.scrollingElement
    ? document.scrollingElement.scrollTop
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
  const machinistPanelWasOpen = machinist && (
    trialMachineFilterPanelOpenScope === 'machinist' || trialMachineFilterPanelWasOpen('machinist')
  );
  const plannerPanelWasOpen = !machinist && (
    trialMachineFilterPanelOpenScope === 'planner' || trialMachineFilterPanelWasOpen('planner')
  );
  if (filterShell && !options.skipFilterShell) {
    if (machinist) {
      filterShell.innerHTML = renderTrialMachinistBoardFilters();
      trialBindMachineFilterDropdowns();
      trialBindMachinistJobSearchDismiss();
      if (typeof trialRefreshMachinistJobSearchResults === 'function') {
        trialRefreshMachinistJobSearchResults();
      }
      if (machinistPanelWasOpen) trialRestoreMachineFilterPanelIfOpen('machinist');
    } else {
      filterShell.innerHTML = `
        <div class="trial-board-filter-body">
          <div class="trial-board-filter-row trial-board-filter-row--filters">
            <div class="trial-board-filter-group">
              ${renderTrialMachineTypeFilter()}
              ${renderTrialMppMachinesToggle()}
              ${renderTrialMachineDropdownFilter('planner')}
              ${renderTrialScheduleDateFilter()}
            </div>
            <button type="button" class="btn btn-primary btn-sm trial-queue-heads-btn"
              onclick="openTrialQueueHeadsModal()"
              title="View the current operation at the front of every machine queue">
              View current Operations
            </button>
          </div>
          <div class="trial-board-filter-row trial-board-filter-row--actions">
            <span class="trial-board-filter-actions-label">Tools</span>
            <button type="button" class="btn btn-ghost btn-sm trial-dummy-card-btn"
              onclick="openTrialDummyCardModal()"
              title="Add a placeholder note card with fixed start and end times">
              Dummy card
            </button>
            <button type="button" class="btn btn-ghost btn-sm trial-shop-calendar-btn"
              onclick="openTrialCapacityModal()"
              title="Shop working hours, holidays, and capacity overrides">
              Shop calendar
            </button>
            <button type="button" class="btn btn-ghost btn-sm trial-floor-layout-btn"
              onclick="openTrialFloorLayoutModal()"
              title="View physical machine positions on the factory floor">
              Floor layout
            </button>
            <button type="button" class="btn btn-ghost btn-sm"
              onclick="trialExportBoardToExcel()"
              title="Download lane board as Excel (matches shop-floor layout)">
              Export Excel
            </button>
            <a href="${String(window.trialFinishingQueueUrl || '/qaqc-view').trim()}"
              class="btn btn-ghost btn-sm trial-finishing-queue-link"
              title="Open QAQC view (Deburring, Final Inspection, Packing)">
              QAQC view
            </a>
            ${String(window.trialMachinistBoardUrl || '').trim() ? `
            <a href="${String(window.trialMachinistBoardUrl).trim()}" target="_blank" rel="noopener noreferrer"
              class="btn btn-ghost btn-sm trial-machinist-view-link"
              title="Open read-only lane board for shop floor">
              Machinist view
            </a>` : ''}
          </div>
        </div>
      `;
      trialBindMachineFilterDropdowns();
      if (plannerPanelWasOpen) trialRestoreMachineFilterPanelIfOpen('planner');
    }
  }
  const visibleMachines = trialVisibleMachines();
  if (typeof trialPerfMark === 'function') {
    trialPerfMark(perf, 'compute-visible-machines', { visible_machines: visibleMachines.length });
  }
  const focusLayout = machinist && typeof trialMachinistFocusLayoutActive === 'function'
    && trialMachinistFocusLayoutActive();
  const focusCandidates = focusLayout && typeof trialMachinesForFocusGrid === 'function'
    ? trialMachinesForFocusGrid()
    : [];
  if (focusLayout && typeof trialSyncMachinistFocusMachineIds === 'function') {
    trialSyncMachinistFocusMachineIds();
  }
  grid.classList.toggle('trial-grid--focus', focusLayout);
  grid.classList.toggle('trial-grid--grouped', !focusLayout && trialShouldGroupMachineLanes());
  if (focusLayout) {
    if (!focusCandidates.length) {
      grid.innerHTML = '<div class="trial-empty">No active jobs right now.</div>';
    } else {
      grid.innerHTML = renderTrialMachineGridHtml();
    }
  } else {
    grid.innerHTML = visibleMachines.length
      ? renderTrialMachineGridHtml()
      : `<div class="trial-empty">No machines found for ${escapeHtml(trialMachineCategoryFilter)}.</div>`;
  }
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'render-machine-grid-html');
  const layout = document.getElementById('trial-layout');
  if (layout) layout.style.display = 'grid';
  if (options.dismissLoading) {
    if (typeof trialLoadingHide === 'function') trialLoadingHide();
    else {
      const loading = document.getElementById('trial-loading');
      if (loading) loading.hidden = true;
    }
  }
  updateTrialCompletedCheckbox();
  if (options.skipCatalog) {
    // Board-only update; catalog loads in a follow-up fetch.
  } else {
    renderTrialPsTypeFilter();
    if (options.deferCatalog) trialDeferCatalogRender();
    else renderTrialCatalog();
  }
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
  if (savedScrollLeft != null && scrollHost) {
    scrollHost.scrollLeft = savedScrollLeft;
    const topScroll = document.querySelector('.trial-grid-scroll-top');
    if (topScroll) topScroll.scrollLeft = savedScrollLeft;
  }
  if (savedPageScroll != null && document.scrollingElement) {
    document.scrollingElement.scrollTop = savedPageScroll;
  }
  if (typeof trialSyncStaleMachineBadges === 'function') trialSyncStaleMachineBadges();
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
  if (typeof trialSyncStaleMachineBadges === 'function') trialSyncStaleMachineBadges();
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'sync-grid-scroll-width');
  if (typeof trialPerfEnd === 'function') {
    trialPerfEnd(perf, {
      rendered_ids: ids.length,
    });
  }
}

function trialPsRollupExecStatus(ps) {
  const stageStatus = trialNormalizeExecStatus(ps?.current_stage_status || ps?.execution_status || '');
  const cards = (ps && typeof trialResolvedOpCardsForPs === 'function')
    ? trialResolvedOpCardsForPs(ps)
    : (Array.isArray(ps?.op_cards) ? ps.op_cards : []);
  const openCards = cards.filter(card => (
    typeof trialCatalogOpIsOpen === 'function'
      ? trialCatalogOpIsOpen(card, ps)
      : Number(card?.remaining_qty ?? 0) > 0.0001
  ));
  if (openCards.length) {
    const currentOpen = (ps && typeof trialCatalogOpMatchesCurrentStage === 'function'
      ? openCards.find(card => trialCatalogOpMatchesCurrentStage(card, ps))
      : null) || openCards[0];
    const openStatus = trialNormalizeExecStatus(
      (typeof trialCatalogOpDisplayExecStatus === 'function'
        ? trialCatalogOpDisplayExecStatus(currentOpen, ps)
        : '')
      || trialCatalogOpExecStatus(currentOpen),
    );
    if (openStatus && openStatus !== 'C' && openStatus !== 'COMPLETED') return openStatus;
    if (stageStatus && stageStatus !== 'C' && stageStatus !== 'COMPLETED') return stageStatus;
    return 'P';
  }
  const statuses = cards
    .map(card => {
      if (typeof trialCatalogOpIsProductionComplete === 'function'
        && trialCatalogOpIsProductionComplete(card, ps)) {
        return 'C';
      }
      const display = typeof trialCatalogOpDisplayExecStatus === 'function'
        ? trialCatalogOpDisplayExecStatus(card, ps)
        : '';
      return display || trialCatalogOpExecStatus(card);
    })
    .map(s => trialNormalizeExecStatus(s))
    .filter(Boolean);
  if (!statuses.length) {
    return stageStatus;
  }
  if (statuses.some(s => s === 'P' || s === 'PENDING_SI')) return 'P';
  if (statuses.some(s => s === 'I' || s === 'IN_PROCESS')) return 'I';
  if (statuses.some(s => s === 'R' || s === 'READY_TO_START')) return 'R';
  if (statuses.length === cards.length && statuses.every(s => s === 'C' || s === 'COMPLETED')) {
    if (stageStatus && stageStatus !== 'C' && stageStatus !== 'COMPLETED') return stageStatus;
    return 'C';
  }
  return stageStatus || statuses[0] || '';
}

function trialCatalogPsHasOpenOps(ps) {
  const cards = (ps && typeof trialResolvedOpCardsForPs === 'function')
    ? trialResolvedOpCardsForPs(ps)
    : (ps?.op_cards || []);
  if (cards.some(card => trialCatalogOpIsOpen(card, ps))) return true;
  const allOps = ps?.all_ops || [];
  if (allOps.some(op => trialCatalogOpOpenProbe(op, ps))) return true;
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
    .filter(card => trialCatalogOpIsRelevant(card))
    .map(card => ({
      opNo: card.operation_label || card.source_op_no || '',
      opName: card.operation_name || card.op_type || '',
      status: trialCatalogOpDisplayExecStatus(card, ps),
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
      ${trialCatalogQueueAllBtnHtml(ps)}
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
  return tracked.every(card => trialCatalogOpIsProductionComplete(card, ps));
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
  if (trialPsPendingDo(ps)) return true;
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
    ? `All operations complete · Shipped ${shipped} / SO ${soQty}`
    : 'All operations complete · awaiting full SO shipment';
  return `<span class="ps-pending-do-badge" title="${escapeHtml(title)}">Ops Complete</span>`;
}

function trialPsCatalogExecStatus(ps) {
  return trialPsRollupExecStatus(ps);
}

// ── Catalog render ────────────────────────────────────────────────────────────

/** PS cards the user left expanded — survives sidebar re-renders after queue/drop. */
function trialCatalogPsExpandedSet() {
  if (!window._trialCatalogPsExpanded) {
    window._trialCatalogPsExpanded = new Set();
  }
  return window._trialCatalogPsExpanded;
}

function trialSyncCatalogPsExpandedFromDom(root) {
  if (!root) return;
  const set = trialCatalogPsExpandedSet();
  root.querySelectorAll('details.trial-catalog-ps[data-ps-id]').forEach(el => {
    const psId = String(el.getAttribute('data-ps-id') || '').trim();
    if (!psId) return;
    if (el.open) set.add(psId);
    else set.delete(psId);
  });
}

function trialIsCatalogPsExpanded(psId) {
  return trialCatalogPsExpandedSet().has(String(psId || '').trim());
}

function trialBindCatalogPsExpandState() {
  const root = document.getElementById('trial-catalog');
  if (!root || root.dataset.catalogPsExpandBound === '1') return;
  root.dataset.catalogPsExpandBound = '1';
  root.addEventListener('toggle', event => {
    const details = event.target.closest?.('details.trial-catalog-ps[data-ps-id]');
    if (!details || !root.contains(details)) return;
    const psId = String(details.getAttribute('data-ps-id') || '').trim();
    if (!psId) return;
    const set = trialCatalogPsExpandedSet();
    if (details.open) set.add(psId);
    else set.delete(psId);
  });
}

let trialCatalogSearchIndex = null;

function trialInvalidateCatalogSearchIndex() {
  trialCatalogSearchIndex = null;
}

function trialEnsureCatalogSearchIndex() {
  if (trialCatalogSearchIndex) return trialCatalogSearchIndex;
  const catalog = new Map();
  const planned = new Map();
  (trialState.catalog || []).forEach(ps => {
    const id = String(ps.ps_id || '');
    if (id) catalog.set(id, trialCatalogSearchTokens(ps, false));
  });
  (trialState.planned || []).forEach(ps => {
    const id = String(ps.ps_id || '');
    if (id) planned.set(id, trialCatalogSearchTokens(ps, true));
  });
  trialCatalogSearchIndex = { catalog, planned };
  return trialCatalogSearchIndex;
}

function trialCatalogSearchRowEls(root = document.getElementById('trial-catalog')) {
  if (!root) return [];
  return [...root.querySelectorAll('details.trial-catalog-ps[data-ps-id], .trial-catalog-planned-ps[data-ps-id]')];
}

function trialCatalogSearchTokensForPsId(psId, planned = false) {
  const id = String(psId || '').trim();
  if (!id) return [];
  const searchIndex = trialEnsureCatalogSearchIndex();
  const map = planned ? searchIndex.planned : searchIndex.catalog;
  if (map.has(id)) return map.get(id);
  const ps = typeof trialCatalogFindPsRow === 'function' ? trialCatalogFindPsRow(id) : null;
  if (!ps) return [];
  return trialCatalogSearchTokens(ps, planned);
}

function trialCatalogSearchHasVisibleMatches(root = document.getElementById('trial-catalog')) {
  return trialCatalogSearchRowEls(root).some(el => !el.hidden);
}

function trialSyncCatalogSearchEmptyState(root, rawQuery, anyVisible) {
  if (!root) return;
  const interim = root.querySelector('.trial-catalog-search-empty');
  if (anyVisible) {
    interim?.remove();
    return;
  }
  let emptyEl = interim;
  if (!emptyEl) {
    emptyEl = document.createElement('div');
    emptyEl.className = 'trial-catalog-empty trial-catalog-search-empty';
    root.appendChild(emptyEl);
  }
  emptyEl.textContent = rawQuery ? 'Searching…' : 'No available PS / ops match this search.';
}

/** Fast in-place sidebar filter — avoids rebuilding hundreds of op cards on each keystroke. */
function trialApplyCatalogSearchFilter(rawQuery) {
  const root = document.getElementById('trial-catalog');
  const rawLower = String(rawQuery || '').trim().toLowerCase();
  if (!root || !rawLower) return false;

  const psEls = trialCatalogSearchRowEls(root);
  if (!psEls.length) return false;

  const matchedBases = new Set();
  psEls.forEach(el => {
    const psId = String(el.dataset.psId || '').trim();
    const planned = el.classList.contains('trial-catalog-planned-ps');
    const tokens = trialCatalogSearchTokensForPsId(psId, planned);
    const match = trialQueryMatchesSearchTokens(tokens, rawLower);
    el.hidden = !match;
    if (match) {
      if (el.tagName === 'DETAILS') el.open = true;
      const ps = typeof trialCatalogFindPsRow === 'function' ? trialCatalogFindPsRow(psId) : null;
      if (ps) trialCatalogSearchBaseKeys(ps).forEach(key => matchedBases.add(key));
    }
  });

  psEls.forEach(el => {
    if (!el.hidden) return;
    const psId = String(el.dataset.psId || '').trim();
    const ps = typeof trialCatalogFindPsRow === 'function' ? trialCatalogFindPsRow(psId) : null;
    if (!ps) return;
    const keys = trialCatalogSearchBaseKeys(ps);
    if ([...keys].some(key => matchedBases.has(key))) {
      el.hidden = false;
      if (el.tagName === 'DETAILS') el.open = true;
    }
  });

  const anyVisible = psEls.some(el => !el.hidden);
  trialSyncCatalogSearchEmptyState(root, rawQuery, anyVisible);
  return true;
}

function scheduleTrialCatalogSearchRender() {
  clearTimeout(trialCatalogSearchTimer);
  const input = document.getElementById('trial-catalog-search');
  const rawQuery = String(input?.value || '').trim();
  trialCatalogSearch = rawQuery.toLowerCase();

  // Instant in-place filter while typing; full render remains authoritative.
  if (rawQuery) {
    trialApplyCatalogSearchFilter(rawQuery);
  }

  const delay = rawQuery ? 320 : 100;
  trialCatalogSearchTimer = window.setTimeout(() => {
    trialCatalogSearchTimer = null;
    renderTrialCatalog();
  }, delay);
}

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

function trialCatalogUnqueuedFilterActive() {
  return String(trialCatalogQueueFilter || '').trim().toLowerCase() === 'unqueued';
}

function trialCatalogQueuedOp40PendingFilterActive() {
  return String(trialCatalogQueueFilter || '').trim() === 'queued-op40-pending';
}

function trialCatalogNormalizedOpNo(card) {
  const raw = String(card?.source_op_no || card?.operation_label || card?.op_no || '').trim();
  if (!raw) return '';
  const prefixed = raw.match(/^OP?\s*0*(\d+)\s*$/i);
  if (prefixed) return String(parseInt(prefixed[1], 10));
  const plain = raw.match(/^(\d+)$/);
  if (plain) return String(parseInt(plain[1], 10));
  return raw;
}

function trialCatalogOpIsOp40(card) {
  return trialCatalogNormalizedOpNo(card) === '40';
}

function trialCatalogOp40CardsForPs(ps) {
  const cards = trialResolvedOpCardsForPs(ps).filter(trialCatalogOpIsOp40);
  if (cards.length) return cards;
  const pool = [
    ...(Array.isArray(ps?.op_cards) ? ps.op_cards : []),
    ...(Array.isArray(ps?.all_ops) ? ps.all_ops.map(op => ({
      source_op_no: op.source_op_no || op.op_no || '',
      operation_label: op.source_op_no || op.op_no || '',
      remaining_qty: op.remaining_qty,
      target_qty: op.total_qty ?? op.remaining_qty,
      required_qty: op.required_qty,
      finished_qty: op.finished_qty ?? op.erp_finished_qty,
      execution_status: op.execution_status || '',
      source_kind: op.source_kind || '',
      op,
    })) : []),
  ];
  return pool.filter(trialCatalogOpIsOp40);
}

function trialCatalogOpMatchesUnqueuedFilter(card, isOpAllocated, ps) {
  if (trialCatalogOpIsComplete(card, ps)) return false;
  if (isOpAllocated(card)) return false;
  return trialCatalogOpIsOpen(card, ps) || trialCatalogOpIsManualBom(card);
}

function trialCatalogOpMatchesQueuedOp40PendingFilter(card, isOpAllocated, ps) {
  if (!trialCatalogOpIsOp40(card)) return false;
  return trialCatalogOpMatchesUnqueuedFilter(card, isOpAllocated, ps);
}

function trialCatalogPsHasUnqueuedWork(ps, isOpAllocated) {
  if (trialPsHasQueuedBlocks(ps)) return false;
  if (trialPsCatalogCompleted(ps)) return false;
  const cards = trialResolvedOpCardsForPs(ps);
  const allocated = typeof isOpAllocated === 'function'
    ? isOpAllocated
    : card => trialIsCatalogOpAllocated(card);
  if (!cards.length) return trialCatalogPsHasOpenOps(ps);
  return cards.some(card => trialCatalogOpMatchesUnqueuedFilter(card, allocated, ps));
}

function trialCatalogPsQueuedWithUnqueuedOp40(ps, isOpAllocated) {
  const pool = typeof trialCatalogPsPools === 'function' ? trialCatalogPsPools().all : [];
  if (!trialCatalogPsHasQueuedBlocksIncludingTemp(ps, pool)) return false;
  if (trialPsCatalogCompleted(ps)) return false;
  const allocated = typeof isOpAllocated === 'function'
    ? isOpAllocated
    : card => trialIsCatalogOpAllocatedIncludingTemp(card, ps, pool);
  return trialCatalogOp40CardsForPs(ps)
    .some(card => trialCatalogOpMatchesQueuedOp40PendingFilter(card, allocated, ps));
}

function trialCatalogOpVisibleInList(card, isOpAllocated, ps) {
  if (!trialCatalogOpIsRelevant(card)) return false;
  if (trialCatalogUnqueuedFilterActive()) {
    return trialCatalogOpMatchesUnqueuedFilter(card, isOpAllocated, ps);
  }
  return trialCatalogOpShouldShow(card, isOpAllocated, ps);
}

function trialCatalogMatchesQueueFilter(ps) {
  const filter = String(trialCatalogQueueFilter || '').trim();
  if (!filter) return true;
  if (filter === 'unqueued') return trialCatalogPsHasUnqueuedWork(ps);
  if (filter === 'queued-op40-pending') return trialCatalogPsQueuedWithUnqueuedOp40(ps);
  const lowered = filter.toLowerCase();
  if (lowered === 'queued') return trialPsHasQueuedBlocks(ps);
  return true;
}

function updateTrialCatalogQueueFilterButton() {
  const unqueuedBtn = document.getElementById('trial-catalog-queue-filter-btn');
  const op40Btn = document.getElementById('trial-catalog-queued-op40-btn');
  if (unqueuedBtn) {
    const active = trialCatalogQueueFilter === 'unqueued';
    unqueuedBtn.classList.toggle('is-active', active);
    unqueuedBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  if (op40Btn) {
    const active = trialCatalogQueueFilter === 'queued-op40-pending';
    op40Btn.classList.toggle('is-active', active);
    op40Btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function toggleTrialCatalogUnqueuedOnly() {
  trialCatalogQueueFilter = trialCatalogQueueFilter === 'unqueued' ? '' : 'unqueued';
  updateTrialCatalogQueueFilterButton();
  renderTrialCatalog();
}

function toggleTrialCatalogQueuedOp40Pending() {
  trialCatalogQueueFilter = trialCatalogQueueFilter === 'queued-op40-pending'
    ? ''
    : 'queued-op40-pending';
  updateTrialCatalogQueueFilterButton();
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

const _PS_SERIAL_SEARCH_RE = /^(?:APS|NPS|PPS|CPS|MPS|SR)(\d{2})-(\d+)/i;

/** Extra tokens so "0234" matches NPS26-0234 (and unpadded serials). */
function trialPsSerialSearchTokens(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const extras = [];
  const body = raw.replace(/^\[Temp\]\s*/i, '').trim();
  const m = body.match(_PS_SERIAL_SEARCH_RE);
  if (m) {
    const serial = m[2];
    extras.push(serial, `${m[1]}-${serial}`, `${m[1]}${serial}`);
    if (serial.length < 4) extras.push(serial.padStart(4, '0'));
  }
  if (body !== raw) extras.push(...trialPsSerialSearchTokens(body));
  return extras;
}

function trialQueryMatchesSearchTokens(tokens, rawQuery) {
  const rawLower = String(rawQuery || '').trim().toLowerCase();
  if (!rawLower) return true;
  const normalizedQuery = trialNormalizeSearchText(rawLower);
  return (tokens || []).some(token => {
    const text = String(token || '').toLowerCase();
    if (!text) return false;
    const normalized = trialNormalizeSearchText(token);
    return text.includes(rawLower)
      || (normalizedQuery && normalized.includes(normalizedQuery));
  });
}

/** Source ERP PS number stripped from a [Temp] planner id (for sidebar search). */
function trialCatalogTempSourceRef(ps) {
  const raw = String(ps?.ps_id || ps?.source_ps_id || '').trim();
  if (!/^\[Temp\]/i.test(raw)) return '';
  return raw.replace(/^\[Temp\]\s*/i, '').trim();
}

/** Lowercase keys used to pull sibling partials/temp lines into an active search. */
function trialCatalogSearchBaseKeys(ps) {
  const keys = new Set();
  const base = String(trialCatalogSourceBase(ps) || '').trim().toLowerCase();
  if (base) keys.add(base);
  const src = String(ps?.source_ps_id || '').split('::')[0].trim().toLowerCase();
  if (src) keys.add(src);
  const tempRef = String(trialCatalogTempSourceRef(ps) || '').trim().toLowerCase();
  if (tempRef) keys.add(tempRef);
  if (base.startsWith('[temp]')) {
    const stripped = base.replace(/^\[temp\]\s*/i, '').trim();
    if (stripped) keys.add(stripped);
  }
  return keys;
}

function trialCatalogSearchTokens(ps, planned = false) {
  const psId = String(ps.ps_id || '');
  const psParts = trialSplitPsId(psId);
  const opCards = ps.op_cards || [];
  const baseValues = planned
    ? [
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
    ]
    : [
      psId,
      psParts.base,
      trialCatalogTempSourceRef(ps),
      psParts.partial ? `partial ${psParts.partial}` : '',
      ps.source_ps_id,
      ps.display_ps_id,
      ps.temp_source_ps_id,
      ps.temp_source_label,
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
      ...(ps.ops || []).flatMap(op => [op.op_no, op.op_type, op.machine_category, op.preferred_machine, op.source_op_no]),
      ...opCards.flatMap(card => [card.operation_label, card.operation_name, card.source_op_no, card.source_op_seq_id]),
    ];
  return trialSearchableTokens(baseValues)
    .flatMap(token => [token, ...trialPsSerialSearchTokens(token)]);
}

function trialCatalogHaystack(ps) {
  return trialCatalogSearchTokens(ps, false);
}

function trialPlannedHaystack(ps) {
  return trialCatalogSearchTokens(ps, true);
}

function renderTrialCatalogBoardSearchFallback(rawQuery) {
  const hits = typeof trialSearchMachinistQueues === 'function'
    ? trialSearchMachinistQueues(rawQuery)
    : [];
  if (!hits.length) {
    return '<div class="trial-catalog-empty">No available PS / ops match this search.</div>';
  }
  trialMachinistJobSearchHits = hits;
  const list = hits.slice(0, 10).map((hit, idx) => {
    const partialNote = hit.partial && hit.partial !== '1' ? ` · p${hit.partial}` : '';
    const opNote = hit.operationLine ? ` · ${hit.operationLine}` : '';
    return `
      <button type="button" class="trial-catalog-board-hit"
        onclick="trialNavigateToMachinistJobHit(${idx})">
        <span class="trial-catalog-board-hit-machine">${escapeHtml(hit.machineCode)}</span>
        <span class="trial-catalog-board-hit-detail">
          ${escapeHtml(hit.psDisplay)}${escapeHtml(partialNote)} · #${hit.queuePosition}${escapeHtml(opNote)}
        </span>
      </button>`;
  }).join('');
  return `
    <div class="trial-catalog-board-search">
      <div class="trial-catalog-empty">Not in PS / Ops — already queued on the board:</div>
      <div class="trial-catalog-board-hits">${list}</div>
    </div>`;
}

function trialShowCatalogLoadingPlaceholder() {
  const root = document.getElementById('trial-catalog');
  if (!root) return;
  root.innerHTML = '<div class="trial-catalog-empty trial-catalog-loading">Loading jobs…</div>';
}

function renderTrialCatalog() {
  clearTimeout(trialCatalogSearchTimer);
  trialCatalogSearchTimer = null;
  if (trialCatalogPointerDrag) {
    trialCatalogResetPointerDrag(trialCatalogPointerDrag);
  }
  const perf = (typeof trialPerfStart === 'function')
    ? trialPerfStart('render-trial-catalog', {
      catalog_rows: Array.isArray(trialState.catalog) ? trialState.catalog.length : 0,
      planned_rows: Array.isArray(trialState.planned) ? trialState.planned.length : 0,
    })
    : null;
  updateTrialCatalogDueDateSortButton();
  updateTrialCatalogQueueFilterButton();
  const root = document.getElementById('trial-catalog');
  if (!root) {
    if (typeof trialPerfEnd === 'function') trialPerfEnd(perf, { skipped: 'no-catalog-root' });
    return;
  }
  trialSyncCatalogPsExpandedFromDom(root);
  const queryInput = document.getElementById('trial-catalog-search');
  const rawQuery = String(queryInput ? queryInput.value : trialCatalogSearch || '').trim().toLowerCase();
  trialCatalogSearch = rawQuery;
  const catalogSource = typeof trialMergedCatalogRows === 'function'
    ? trialMergedCatalogRows()
    : (trialState.catalog || []);
  const hadBoardOnlyTemp = catalogSource.length > (trialState.catalog || []).length;
  const searchIndex = trialEnsureCatalogSearchIndex();
  const resolvedCardsCache = new WeakMap();
  const allocatedCardCache = new Map();
  const siblingCountByBase = new Map();
  catalogSource.forEach(ps => {
    const base = trialCatalogSourceBase(ps);
    if (!base) return;
    siblingCountByBase.set(base, Number(siblingCountByBase.get(base) || 0) + 1);
  });

  const cachedCatalogHaystack = ps => {
    const id = String(ps.ps_id || '');
    return searchIndex.catalog.get(id) || trialCatalogSearchTokens(ps, false);
  };

  const cachedPlannedHaystack = ps => {
    const id = String(ps.ps_id || '');
    return searchIndex.planned.get(id) || trialCatalogSearchTokens(ps, true);
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
      'temp-sib',
    ].join('|');
    if (allocatedCardCache.has(key)) return allocatedCardCache.get(key);
    const allocated = typeof trialIsCatalogOpAllocatedIncludingTemp === 'function'
      ? trialIsCatalogOpAllocatedIncludingTemp(ctx, ps, catalogSource)
      : trialIsCatalogOpAllocated(ctx);
    allocatedCardCache.set(key, allocated);
    return allocated;
  };

  const catalogMatchesSearch = ps => trialQueryMatchesSearchTokens(cachedCatalogHaystack(ps), rawQuery);

  const catalog = catalogSource.filter(ps => {
    const psType = trialGetPsType(ps.ps_id);
    if (!trialPsTypeFilter.has(psType)) return false;
    if (!trialShowSrOrders && String(ps.ps_id || '').includes('[SR]')) return false;
    if (!trialShowCompleted && trialPsCatalogCompleted(ps)) return false;
    if (!rawQuery && trialCatalogSupersededByTempSibling(ps, catalogSource)) return false;
    if (!rawQuery && !trialCatalogMatchesQueueFilter(ps)) return false;
    return catalogMatchesSearch(ps);
  });
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'filter-catalog', { kept: catalog.length });

  if (rawQuery) {
    const matchedBases = new Set();
    catalog.forEach(ps => {
      trialCatalogSearchBaseKeys(ps).forEach(key => matchedBases.add(key));
    });
    const seen = new Set(catalog.map(ps => String(ps.ps_id || '')));
    for (const ps of catalogSource) {
      const psId = String(ps.ps_id || '');
      if (seen.has(psId)) continue;
      const keys = trialCatalogSearchBaseKeys(ps);
      if (!keys.size || ![...keys].some(key => matchedBases.has(key))) continue;
      if (!rawQuery && trialCatalogSupersededByTempSibling(ps, catalogSource)) continue;
      if (!trialPsTypeFilter.has(trialGetPsType(ps.ps_id))) continue;
      if (!trialShowSrOrders && psId.includes('[SR]')) continue;
      if (!trialShowCompleted && trialPsCatalogCompleted(ps)) continue;
      if (!rawQuery && !trialCatalogMatchesQueueFilter(ps)) continue;
      catalog.push(ps);
      seen.add(psId);
    }
  }

  catalog.sort(trialCompareCatalogPs);

  const plannedCatalog = (trialState.planned || []).filter(ps => {
    const psType = trialGetPsType(ps.ps_id);
    if (!trialPsTypeFilter.has(psType)) return false;
    if (!trialShowSrOrders && String(ps.ps_id || '').includes('[SR]')) return false;
    if (!trialShowCompleted && trialPsCatalogCompleted(ps)) return false;
    if (!rawQuery && trialCatalogSupersededByTempSibling(ps, catalogSource)) return false;
    if (!rawQuery && !trialCatalogMatchesQueueFilter(ps)) return false;
    return trialQueryMatchesSearchTokens(cachedPlannedHaystack(ps), rawQuery);
  }).sort(trialCompareCatalogPs);
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'filter-planned', { kept: plannedCatalog.length });

  if (!catalog.length && !plannedCatalog.length) {
    root.innerHTML = rawQuery
      ? renderTrialCatalogBoardSearchFallback(rawQuery)
      : '<div class="trial-catalog-empty">No available PS / ops match this search.</div>';
    if (typeof trialPerfEnd === 'function') trialPerfEnd(perf, { empty: true, board_fallback: Boolean(rawQuery) });
    return;
  }

  const catalogWithOpenOps = catalog.filter(ps => {
    if (rawQuery) return true;
    const isOpAllocated = card => cachedIsOpAllocated(card, ps);
    if (trialCatalogUnqueuedFilterActive()) {
      return trialCatalogPsHasUnqueuedWork(ps, isOpAllocated);
    }
    if (trialCatalogQueuedOp40PendingFilterActive()) {
      return trialCatalogPsQueuedWithUnqueuedOp40(ps, isOpAllocated);
    }
    if (typeof trialIsTempCatalogPs === 'function' ? trialIsTempCatalogPs(ps) : ps?.is_temp_ps) {
      return true;
    }
    const cards = cachedResolvedCards(ps);
    const hasActiveWork = cards.some(card =>
      trialCatalogOpIsOpen(card, ps) || trialCatalogOpIsManualBom(card) || isOpAllocated(card))
      || trialCatalogPsHasOpenOps(ps);
    if (!trialShowCompleted) return hasActiveWork;
    // Show completed on: include shipped jobs and any PS with stage rows for reference.
    if (!trialPsShippedComplete(ps) && (ps.op_cards || []).length) return true;
    return hasActiveWork;
  });

  const availableHtml = catalogWithOpenOps.map(ps => {
    const psIdParts = String(ps.ps_id || '').split('::');
    const basePsId = psIdParts[0] || ps.ps_id || '';
    const cards = cachedResolvedCards(ps);
    const isOpAllocated = card => cachedIsOpAllocated(card, ps);
    const opCardsHtml = cards
      .filter(card => trialCatalogOpVisibleInList(card, isOpAllocated, ps))
      .map(card => {
        const ctx = typeof trialCatalogOpForPs === 'function' ? trialCatalogOpForPs(card, ps) : card;
        return renderTrialOpCardHtml({
          ...ctx,
          is_allocated: isOpAllocated(card),
          part_no: ctx.part_no || ps.part_no || ps.part_name || '',
        }, ps);
      })
      .join('');
    const dueClass = trialCatalogPsDueClass(ps);
    const psKey = String(ps.ps_id || '');
    const psOpen = trialIsCatalogPsExpanded(psKey) || Boolean(rawQuery);
    return `
      <details class="trial-catalog-ps ${dueClass}"${psOpen ? ' open' : ''}
        data-ps-id="${escapeHtml(psKey)}">
        <summary>${trialCatalogPsSummaryHtml(ps, siblingCountByBase)}</summary>
        ${trialRenderCatalogOpStatusStrip(ps)}
        ${trialCatalogBomBarHtml(ps)}
        <div class="trial-catalog-oplist">${opCardsHtml}</div>
      </details>
    `;
  }).join('');
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'build-available-html', { ps: catalogWithOpenOps.length });

  const plannedWithOpenOps = plannedCatalog.filter(ps => {
    if (rawQuery) return true;
    const isOpAllocated = card => cachedIsOpAllocated(card, ps);
    if (trialCatalogUnqueuedFilterActive()) {
      return trialCatalogPsHasUnqueuedWork(ps, isOpAllocated);
    }
    if (trialCatalogQueuedOp40PendingFilterActive()) {
      return trialCatalogPsQueuedWithUnqueuedOp40(ps, isOpAllocated);
    }
    if (typeof trialIsTempCatalogPs === 'function' ? trialIsTempCatalogPs(ps) : ps?.is_temp_ps) {
      return true;
    }
    const cards = cachedResolvedCards(ps);
    const hasOpenOps = cards.some(card => trialCatalogOpShouldShow(card, isOpAllocated, ps));
    if (hasOpenOps) return true;
    // Other PS: show header-only rows (no work orders).
    return !(ps.op_cards || []).length;
  });

  const plannedHtml = plannedWithOpenOps.map(ps => `
    <div class="trial-catalog-ps trial-catalog-planned-ps" data-ps-id="${escapeHtml(ps.ps_id || '')}">
      <div class="trial-catalog-planned-head">
        <div class="trial-catalog-ps-main">
          <div class="trial-catalog-ps-id">${escapeHtml(String(ps.ps_id || '').split('::')[0] || ps.ps_id || '')}</div>
          ${trialCatalogPsQueuePillHtml(ps)}
        </div>
        <div class="trial-catalog-planned-right">
          ${trialCatalogQueueAllBtnHtml(ps)}
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
            .filter(card => trialCatalogOpVisibleInList(card, isOpAllocated, ps))
            .map(card => {
              const ctx = typeof trialCatalogOpForPs === 'function' ? trialCatalogOpForPs(card, ps) : card;
              return renderTrialOpCardHtml({
                ...ctx,
                is_allocated: isOpAllocated(card),
                part_no: ctx.part_no || ps.part_no || ps.part_name || '',
              }, ps);
            })
            .join('');
        })()}
      </div>
    </div>
  `).join('');
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'build-planned-html', { ps: plannedWithOpenOps.length });

  const catalogHtml = [availableHtml, plannedHtml].filter(Boolean).join('');
  root.innerHTML = catalogHtml || `<div class="trial-catalog-empty">No available PS / ops match this search.</div>`;
  decorateTrialCatalogCards();
  trialBindCatalogPsExpandState();
  bindTrialCatalogDnD();
  if (hadBoardOnlyTemp && typeof trialScheduleMissingTempCatalogRefresh === 'function') {
    trialScheduleMissingTempCatalogRefresh();
  }
  if (typeof trialPerfMark === 'function') trialPerfMark(perf, 'bind-catalog-dnd');
  if (typeof trialPerfEnd === 'function') {
    trialPerfEnd(perf, {
      available_ps: catalogWithOpenOps.length,
      planned_ps: plannedWithOpenOps.length,
      query: rawQuery || '',
      board_only_temp: hadBoardOnlyTemp,
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

function updateTrialCompletedCheckbox() {
  const el = document.getElementById('trial-show-completed');
  if (el) el.checked = !!trialShowCompleted;
}
