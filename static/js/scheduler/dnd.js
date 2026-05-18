// Drag-and-drop, pointer events, sortables, and scheduling operations.

function planningCardTargetQty(ops) {
  return Math.max(...(ops || []).map(op => Number(op.total_qty || op.remaining_qty || 0)));
}

function trialCatalogCombineSummary(source, target) {
  const ops = [source, target];
  return {
    target_qty: Math.max(...ops.map(op => Number(op.total_qty || 0))),
    setup_minutes: Math.max(...ops.map(op => Number(op.setup_minutes || 0))),
    cycle_minutes_per_qty: ops.reduce((sum, op) => sum + Number(op.cycle_minutes_per_qty || 0), 0),
  };
}

function trialOpCardPayloadFromElement(el) {
  if (!el) return null;

  const rawPayload = el.dataset.trialPayload || '';
  if (rawPayload) {
    try {
      const parsed = JSON.parse(rawPayload);
      if (parsed && parsed.type === 'op-card') {
        if (parsed.card_kind === 'single' && !parsed.op) {
          parsed.op = {
            job_no: parsed.job_no || parsed.source_ps_id || '',
            operation_name: parsed.operation_name || '',
            op_type: parsed.op_type || '',
            total_qty: Number(parsed.total_qty || parsed.remaining_qty || parsed.target_qty || 0),
            remaining_qty: Number(parsed.remaining_qty || parsed.total_qty || parsed.target_qty || 0),
            setup_time: Number(parsed.setup_time || parsed.setup_minutes || 0),
            cycle_time: Number(parsed.cycle_time || parsed.cycle_minutes_per_qty || 0),
            compatible_machine_group: parsed.compatible_machine_group || '',
            source_ps_id: parsed.source_ps_id || parsed.ps_id || '',
            source_op_seq_id: Number(parsed.source_op_seq_id || 0),
            source_op_no: parsed.source_op_no || '',
          };
        }
        return parsed;
      }
    } catch (err) {
      console.warn('Bad trial payload', err, rawPayload);
    }
  }

  const cardKind = el.dataset.cardKind || (el.dataset.cardId ? 'group' : 'single');
  const payload = {
    type: 'op-card',
    card_kind: cardKind,
    card_id: Number(el.dataset.cardId || 0) || null,
    ps_id: el.dataset.psId || '',
    operation_label: el.dataset.operationLabel || '',
    target_qty: Number(el.dataset.targetQty || 0),
    remaining_qty: Number(el.dataset.remainingQty || el.dataset.targetQty || 0),
    planning_status: el.dataset.planningStatus || '',
    card_type: el.dataset.cardType || '',
    is_scheduled: String(el.dataset.isScheduled || '').toLowerCase() === 'true',
    machine_id: Number(el.dataset.machineId || 0),
    machine_code: el.dataset.machineCode || '',
    setup_minutes: Number(el.dataset.setupMinutes || 0),
    cycle_minutes_per_qty: Number(el.dataset.cycleMinutesPerQty || el.dataset.cycleminutesPerQty || 0),
    compatible_machine_group: el.dataset.compatibleMachineGroup || '',
    source_ps_id: el.dataset.sourcePsId || '',
    source_op_seq_id: Number(el.dataset.sourceStepId || 0),
    source_op_no: el.dataset.sourceOpNo || '',
    job_no: el.dataset.jobNo || '',
    op_type: el.dataset.opType || '',
    operation_name: el.dataset.operationName || '',
    total_qty: Number(el.dataset.totalQty || 0),
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
  return payload;
}

function trialCatalogOpAtPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest('.trial-catalog-op') : null;
}

function trialCanCombinePayloads(sourcePayload, targetPayload) {
  if (!sourcePayload || !targetPayload) {
    return { ok: false, message: 'No operation selected to combine.' };
  }
  if (sourcePayload.type !== 'op-card' || targetPayload.type !== 'op-card') {
    return { ok: false, message: 'No operation selected to combine.' };
  }
  if (sourcePayload.card_kind !== 'single' || targetPayload.card_kind !== 'single') {
    return { ok: false, message: 'Uncombine first to change this combined operation.' };
  }

  const sourcePsId = String(sourcePayload.source_ps_id || sourcePayload.ps_id || '').trim();
  const targetPsId = String(targetPayload.source_ps_id || targetPayload.ps_id || '').trim();
  if (!sourcePsId || !targetPsId || sourcePsId !== targetPsId) {
    return { ok: false, message: 'Combine operations from the same process sheet.' };
  }

  const sourceStepId = Number(sourcePayload.source_op_seq_id || 0);
  const targetStepId = Number(targetPayload.source_op_seq_id || 0);
  const sourceOpNo = String(sourcePayload.source_op_no || '').trim();
  const targetOpNo = String(targetPayload.source_op_no || '').trim();
  const sameStep = sourceStepId > 0 && targetStepId > 0 && sourceStepId === targetStepId;
  const sameOpNo = sourceOpNo && targetOpNo && sourceOpNo === targetOpNo;

  if (sameStep || sameOpNo || sourcePayload === targetPayload) {
    return { ok: false, message: 'Pick a different operation to combine.' };
  }

  return { ok: true, ps_id: sourcePsId };
}

function trialCatalogResetPointerDrag(state = trialCatalogPointerDrag) {
  if (!state) return;
  if (state.currentTargetEl) {
    state.currentTargetEl.classList.remove('drop-target');
  }
  if (state.currentLaneEl) {
    state.currentLaneEl.classList.remove('drop-target-lane');
  }
  if (state.sourceEl) {
    state.sourceEl.classList.remove('dragging');
    try {
      if (state.pointerId != null && typeof state.sourceEl.releasePointerCapture === 'function') {
        state.sourceEl.releasePointerCapture(state.pointerId);
      }
    } catch (e) {
      // Ignore capture teardown errors.
    }
  }
  if (state.ghostEl && state.ghostEl.parentNode) {
    state.ghostEl.parentNode.removeChild(state.ghostEl);
  }
  trialDragPayload = null;
  trialCatalogPointerDrag = null;
}

function trialCatalogEnsurePointerGhost(state, e) {
  if (!state || !state.sourceEl) return;
  if (!state.ghostEl) {
    const ghost = state.sourceEl.cloneNode(true);
    ghost.classList.add('trial-catalog-drag-ghost');
    ghost.classList.remove('dragging', 'drop-target');
    ghost.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    ghost.querySelectorAll('button, a, input, select, textarea').forEach(node => {
      node.removeAttribute('onclick');
      node.removeAttribute('oninput');
      node.removeAttribute('onchange');
    });
    document.body.appendChild(ghost);
    state.ghostEl = ghost;
  }
  state.ghostEl.style.left = `${e.clientX}px`;
  state.ghostEl.style.top = `${e.clientY}px`;
}

function trialCatalogHandlePointerMove(e) {
  const state = trialCatalogPointerDrag;
  if (!state || state.pointerId !== e.pointerId || !state.sourceEl) return;

  const distance = Math.hypot(e.clientX - state.startX, e.clientY - state.startY);
  if (!state.hasMoved && distance < 5) return;
  if (!state.hasMoved) {
    state.hasMoved = true;
    state.sourceEl.classList.add('dragging');
  }
  trialCatalogEnsurePointerGhost(state, e);

  const targetEl = trialCatalogOpAtPoint(e.clientX, e.clientY);
  const nextTarget = targetEl && targetEl !== state.sourceEl ? targetEl : null;
  if (state.currentTargetEl && state.currentTargetEl !== nextTarget) {
    state.currentTargetEl.classList.remove('drop-target');
    state.currentTargetEl = null;
  }
  if (nextTarget) {
    const targetPayload = trialOpCardPayloadFromElement(nextTarget);
    const validation = trialCanCombinePayloads(state.sourcePayload, targetPayload);
    if (validation.ok) {
      nextTarget.classList.add('drop-target');
      state.currentTargetEl = nextTarget;
    }
  }

  // Highlight lane as drop target when not hovering a combine target
  const laneEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.trial-lane');
  const activeLane = !state.currentTargetEl ? laneEl : null;
  if (state.currentLaneEl && state.currentLaneEl !== activeLane) {
    state.currentLaneEl.classList.remove('drop-target-lane');
    state.currentLaneEl = null;
  }
  if (activeLane) {
    activeLane.classList.add('drop-target-lane');
    state.currentLaneEl = activeLane;
  }
}

async function trialCatalogHandlePointerUp(e) {
  const state = trialCatalogPointerDrag;
  if (!state || state.pointerId !== e.pointerId || !state.sourceEl) return;

  // Consume state immediately before any await so re-entrant pointerup events are ignored.
  trialCatalogPointerDrag = null;
  trialDragPayload = null;

  const sourcePayload = state.sourcePayload;
  const targetEl = trialCatalogOpAtPoint(e.clientX, e.clientY);
  const targetPayload = targetEl && targetEl !== state.sourceEl ? trialOpCardPayloadFromElement(targetEl) : null;
  const lane = document.elementFromPoint(e.clientX, e.clientY)?.closest('.trial-lane');

  try {
    if (state.sourceEl && typeof state.sourceEl.releasePointerCapture === 'function') {
      state.sourceEl.releasePointerCapture(e.pointerId);
    }
  } catch (err) {
    // Ignore capture release errors.
  }

  try {
    if (!state.hasMoved) {
      return;
    }

    if (targetEl && targetEl !== state.sourceEl) {
      const validation = trialCanCombinePayloads(sourcePayload, targetPayload);
      if (!validation.ok) {
        toast(validation.message, 'error');
        return;
      }
      await openTrialCatalogCombineModal(validation.ps_id, [trialOpFromPayload(sourcePayload), trialOpFromPayload(targetPayload)]);
      return;
    }

    const machineId = Number(lane?.dataset.machineId || 0);
    if (machineId) {
      const queuePosition = trialLaneInsertPosition(lane, e.clientY);
      try {
        if (sourcePayload.card_kind === 'group') {
          await scheduleTrialCombinedOpCard(sourcePayload.card_id, machineId, queuePosition);
        } else if (sourcePayload.card_kind === 'single') {
          const existing = trialFindBlockForCatalogOp(sourcePayload);
          if (existing) {
            await moveTrialBlockToMachine(existing.block_id, machineId, queuePosition);
          } else {
            await scheduleTrialSingleOpCard(sourcePayload, machineId, queuePosition);
          }
        }
      } catch (err) {
        toast('Schedule failed: ' + err.message, 'error');
        await loadTrial();
      }
    }
  } finally {
    trialCatalogResetPointerDrag(state);
  }
}

function trialCatalogHandlePointerCancel(e) {
  const state = trialCatalogPointerDrag;
  if (!state || state.pointerId !== e.pointerId) return;
  trialCatalogResetPointerDrag(state);
}

function trialEnsureCatalogPointerListeners() {
  if (trialCatalogPointerListenersBound) return;
  trialCatalogPointerListenersBound = true;
  document.addEventListener('pointermove', trialCatalogHandlePointerMove, true);
  document.addEventListener('pointerup', trialCatalogHandlePointerUp, true);
  document.addEventListener('pointercancel', trialCatalogHandlePointerCancel, true);
}

function bindTrialCatalogDnD() {
  trialEnsureCatalogPointerListeners();
  document.querySelectorAll('.trial-catalog-op').forEach(el => {
    if (el.dataset.catalogDndBound === '1') return;
    el.dataset.catalogDndBound = '1';
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !e.isPrimary) return;
      const interactive = e.target && e.target.closest('button, a, input, select, textarea, label, [contenteditable="true"]');
      if (interactive) return;
      const sourcePayload = trialOpCardPayloadFromElement(el);
      if (!sourcePayload || sourcePayload.type !== 'op-card') return;
      trialCatalogPointerDrag = {
        sourceEl: el,
        sourcePayload,
        ghostEl: null,
        currentTargetEl: null,
        currentLaneEl: null,
        startX: e.clientX,
        startY: e.clientY,
        hasMoved: false,
        pointerId: e.pointerId,
      };
      trialDragPayload = sourcePayload;
      try {
        if (typeof el.setPointerCapture === 'function') {
          el.setPointerCapture(e.pointerId);
        }
      } catch (err) {
        // Ignore capture setup errors.
      }
      e.preventDefault();
    });
  });
}

function trialLaneInsertPosition(lane, clientY) {
  if (!lane) return 0;
  const cards = Array.from(lane.querySelectorAll(':scope > .trial-block-card'));
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    const midY = rect.top + (rect.height / 2);
    if (clientY < midY) return i + 1;
  }
  return cards.length + 1;
}

function trialLaneOrderedBlockIds(lane, movedBlockId = 0) {
  const orderedIds = [];
  if (!lane) return orderedIds;
  Array.from(lane.querySelectorAll(':scope > .trial-block-card')).forEach(card => {
    const id = Number(card.dataset.blockId || 0);
    if (id) orderedIds.push(id);
  });
  const numericMovedId = Number(movedBlockId || 0);
  if (!numericMovedId || orderedIds.includes(numericMovedId)) {
    return orderedIds;
  }
  return orderedIds;
}

async function moveTrialBlockToMachine(blockId, machineId, queuePosition = 0) {
  const numericBlockId = Number(blockId || 0);
  const numericMachineId = Number(machineId || 0);
  if (!numericBlockId || !numericMachineId) {
    toast('Missing block or machine for move.', 'error');
    return;
  }
  const lane = document.getElementById(`trial-lane-${numericMachineId}`);
  let orderedIds = trialLaneOrderedBlockIds(lane).filter(id => id !== numericBlockId);
  const insertIdx = queuePosition > 0
    ? Math.min(Math.max(0, queuePosition - 1), orderedIds.length)
    : orderedIds.length;
  orderedIds.splice(insertIdx, 0, numericBlockId);
  try {
    const result = await POST(`/api/trial/blocks/${numericBlockId}/reorder`, {
      machine_id: numericMachineId,
      ordered_ids: orderedIds,
    });
    const seq = result && result.sequences ? result.sequences[String(numericBlockId)] : null;
    if (seq) {
      trialPinBlock({
        block_id: numericBlockId,
        machine_id: numericMachineId,
        operation_sequence_id: seq.operation_sequence_id,
        sequence_no: seq.sequence_no,
        queue_position: seq.sequence_no,
      });
    }
    await loadTrial();
    toast('Job moved', 'success');
  } catch (e) {
    toast('Move failed: ' + e.message, 'error');
    await loadTrial();
  }
}

function bindTrialLaneOpDrops() {
  document.querySelectorAll('.trial-lane').forEach(lane => {
    if (lane.dataset.laneDropBound === '1') return;
    lane.dataset.laneDropBound = '1';
    lane.addEventListener('dragover', e => {
      // Only accept genuine HTML5 drag transfers — not pointer-based catalog drags.
      const payload = trialParsePayload(e.dataTransfer);
      if (!payload || payload.type !== 'op-card') return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    lane.addEventListener('drop', async e => {
      e.preventDefault();
      // Only use data-transfer payload — trialDragPayload is handled by the pointer system.
      const payload = trialParsePayload(e.dataTransfer);
      const machineId = Number(lane.dataset.machineId || 0);
      if (!machineId || !payload || payload.type !== 'op-card') return;
      try {
        if (payload.card_kind === 'group') {
          await scheduleTrialCombinedOpCard(payload.card_id, machineId);
        } else if (payload.card_kind === 'single') {
          await scheduleTrialSingleOpCard(payload, machineId);
        }
      } catch (err) {
        toast('Schedule failed: ' + err.message, 'error');
        await loadTrial();
      }
    });
  });
}

function destroyTrialSortables() {
  (trialMachineSortables || []).forEach(instance => {
    try {
      instance.destroy();
    } catch (e) {
      // Ignore teardown errors from already-detached nodes.
    }
  });
  trialMachineSortables = [];
}

function initTrialMachineSortables() {
  if (typeof Sortable === 'undefined') return;
  document.querySelectorAll('.trial-lane').forEach(lane => {
    const sortable = new Sortable(lane, {
      group: {
        name: 'trial-machine-blocks',
        pull: true,
        put: ['trial-machine-blocks'],
      },
      draggable: '.trial-block-card',
      handle: '.trial-op-card-header',
      animation: 150,
      disabled: !trialCanReorderMachineQueue(),
      ghostClass: 'trial-drag-ghost',
      chosenClass: 'trial-drag-chosen',
      dragClass: 'trial-drag-active',
      fallbackOnBody: true,
      swapThreshold: 0.65,
      onStart: () => {
        trialDragPayload = null;
      },
      onEnd: async evt => {
        if (!evt.item || !evt.item.classList.contains('trial-block-card')) return;
        const fromLane = evt.from;
        const toLane = evt.to;
        if (!fromLane || !toLane) return;
        try {
          if (fromLane !== toLane) {
            await saveTrialOrder(fromLane, false);
          }
          await saveTrialOrder(toLane, false);
          await loadTrial();
        } catch (e) {
          toast('Reorder failed: ' + e.message, 'error');
          await loadTrial();
        }
      },
    });
    trialMachineSortables.push(sortable);
  });
}

async function scheduleTrialSingleOpCard(card, machineId, queuePosition = 0) {
  const op = card && card.op;
  if (!op) {
    toast('Missing operation data for this card.', 'error');
    return;
  }
  const existing = trialFindBlockForCatalogOp(card);
  if (existing) {
    await moveTrialBlockToMachine(existing.block_id, machineId, queuePosition);
    return;
  }
  try {
    const result = await POST('/api/trial/operations', {
      job_no: op.job_no || op.source_ps_id || '',
      operation_name: op.operation_name || op.op_type || op.source_op_no || '',
      total_qty: Number(op.remaining_qty || op.total_qty || 0),
      scheduled_qty: Number(op.remaining_qty || op.total_qty || 0),
      setup_minutes: Number(op.setup_time || op.setup_minutes || 0),
      cycle_minutes_per_qty: Number(op.cycle_time || op.cycle_minutes_per_qty || 0),
      compatible_machine_group: op.compatible_machine_group || '',
      source_ps_id: op.source_ps_id || '',
      source_op_seq_id: Number(op.source_op_seq_id || 0),
      source_op_no: String(op.source_op_no || card?.operation_label || '').trim(),
      machine_id: Number(machineId || 0),
      queue_position: Number(queuePosition || 0),
      planning_status: 'PLANNED',
      execution_status: 'NOT_STARTED',
      include_setup: 1,
    });
    if (result && result.block) {
      trialPinBlock(result.block);
    }
    await loadTrial();
    await syncTrialQueueState();
    toast('Operation scheduled', 'success');
  } catch (e) {
    console.error('scheduleTrialSingleOpCard failed:', e);
    toast('Schedule failed: ' + e.message, 'error');
  }
}

async function scheduleTrialCombinedOpCard(cardId, machineId, queuePosition = 0) {
  const numericCardId = Number(cardId || 0);
  if (!numericCardId) {
    toast('Missing combined operation card.', 'error');
    return;
  }
  try {
    await POST(`/api/trial/planning-cards/${numericCardId}/schedule`, {
      machine_id: Number(machineId || 0),
      queue_position: Number(queuePosition || 0),
    });
    await loadTrial();
    toast('Operations scheduled', 'success');
  } catch (e) {
    toast('Schedule failed: ' + e.message, 'error');
  }
}

function openTrialCatalogCombineModal(psId, ops) {
  const selection = Array.isArray(ops) ? ops.filter(Boolean) : [];
  if (selection.length < 2) {
    toast('Choose at least two operations.', 'error');
    return;
  }
  const targetQtyDefault = planningCardTargetQty(selection);
  const summary = {
    target_qty: targetQtyDefault,
    setup_minutes: selection.reduce((sum, op) => Math.max(sum, Number(op.setup_minutes || op.setup_time || 0)), 0),
    cycle_minutes_per_qty: selection.reduce((sum, op) => sum + Number(op.cycle_minutes_per_qty || op.cycle_time || 0), 0),
  };
  const opRows = selection.map(op => `
    <div style="display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,0.62)">
      <div style="min-width:0">
        <div style="font-weight:800;overflow-wrap:anywhere">${escapeHtml(op.source_op_no || op.op_type || op.operation_name || op.job_no || '')}</div>
        <div style="font-size:11px;color:var(--text3);overflow-wrap:anywhere">${escapeHtml(op.operation_name || '')}</div>
      </div>
      <div style="font-size:11px;color:var(--text3);white-space:nowrap">Setup ${fmt(op.setup_minutes || op.setup_time || 0, 0)}m</div>
      <div style="font-size:11px;color:var(--text3);white-space:nowrap">Cycle ${fmt(op.cycle_minutes_per_qty || op.cycle_time || 0, 2)}m/pc</div>
    </div>
  `).join('');
  const label = selection.map(op => String(op.source_op_no || op.op_type || op.operation_name || '')).filter(Boolean).join(' & ');

  openTrialForm('Combine operations', `
    <div style="display:grid;gap:12px">
      <div style="display:grid;gap:4px">
        <div style="font-size:18px;font-weight:900;letter-spacing:-0.03em">${escapeHtml(psId || '')}</div>
        <div style="font-size:13px;font-weight:800;color:var(--text2)">${escapeHtml(label)}</div>
      </div>
      <div style="display:grid;gap:8px;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,0.6)">
        ${opRows}
      </div>
      <label style="display:grid;gap:4px">
        <span class="field-hint">Target qty</span>
        <input id="trial-catalog-combine-target-qty" type="number" min="0" step="1" value="${escapeHtml(String(targetQtyDefault || 0))}">
      </label>
      <div style="display:grid;gap:4px;font-size:12px;color:var(--text3)">
        <div>Setup: max ${fmt(summary.setup_minutes || 0, 0)} min</div>
        <div>Cycle: sum ${fmt(summary.cycle_minutes_per_qty || 0, 2)} min/pc</div>
      </div>
    </div>
  `, 'Combine', async () => {
    try {
      const targetQty = Number(document.getElementById('trial-catalog-combine-target-qty')?.value || targetQtyDefault || 0);
      if (targetQty <= 0) {
        toast('Target qty is required', 'error');
        return;
      }
      await POST('/api/trial/planning-cards', {
        ps_id: psId,
        target_qty: targetQty,
        ops: selection.map(op => ({
          source_ps_id: op.source_ps_id || '',
          source_op_seq_id: Number(op.source_op_seq_id || 0),
          source_op_no: op.source_op_no || '',
        })),
      });
      closeModal();
      await loadTrial();
      toast('Operations combined', 'success');
    } catch (e) {
      toast('Combine failed: ' + e.message, 'error');
    }
  });
}

async function deleteTrialPlanningCard(cardId) {
  const numericCardId = Number(cardId || 0);
  if (!numericCardId) return;
  if (!confirm('Uncombine this op card?')) return;
  try {
    await DEL(`/api/trial/planning-cards/${numericCardId}`);
    await loadTrial();
    toast('Op card uncombined', 'success');
  } catch (e) {
    toast('Uncombine failed: ' + e.message, 'error');
  }
}
