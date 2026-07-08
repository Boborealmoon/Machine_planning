/**
 * Catalog operation rules — single source of truth for completion, visibility, and drag.
 *
 * Rule layers (evaluated in order for drag; do not mix across layers):
 *   1. PS kind     — [Temp] ignores ERP stage inheritance; rework uses planner qty only
 *   2. Quantity    — schedulable remaining, production-complete (qty-backed)
 *   3. ERP stage   — stage-passed / current-stage (standard PS only; never temp)
 *   4. Route order — earlier ops satisfied before later steps
 *   5. Queue state — fully queued / superseded by temp sibling
 */

const TRIAL_CATALOG_QTY_TOL = 0.0001;

function trialCatalogPsKind(ps) {
  if (!ps) return 'erp';
  if (ps.is_temp_ps || (typeof trialIsTempCatalogPs === 'function' && trialIsTempCatalogPs(ps))) {
    return 'temp';
  }
  return 'erp';
}

function trialCatalogIsTempPs(ps, card) {
  return trialCatalogPsKind(ps) === 'temp' || Boolean(card?.is_temp_ps);
}

function trialCatalogOpExecStatus(card) {
  return card?.execution_status || card?.op?.execution_status || '';
}

function trialCatalogOpErpProducedQty(card) {
  const op = card?.op || {};
  return Math.max(
    0,
    Number(card?.finished_qty ?? card?.erp_finished_qty ?? card?.wo_qty_produced ?? 0),
    Number(op?.erp_finished_qty ?? op?.finished_qty ?? op?.wo_qty_produced ?? 0),
  );
}

function trialCatalogOpIsManualBom(card) {
  if (!card) return false;
  const stageNo = Number(card.source_stage_no ?? card.op?.source_stage_no ?? 0);
  if (stageNo > 0) return false;
  if (card.is_manual_bom) return true;
  const kind = String(card.source_kind || card.op?.source_kind || '').trim().toUpperCase();
  return kind === 'MANUAL' && Boolean(String(card.operation_name || card.op?.op_type || '').trim());
}

function trialCatalogErpCurrentStageNo(ps) {
  const direct = Number(ps?.current_stage_no || 0);
  if (direct > 0) return direct;
  const desc = String(ps?.current_stage_desc || '').trim();
  const tail = desc.match(/(\d+)\s*$/);
  if (tail) return Number(tail[1]);
  const opToken = desc.match(/OP?\s*0*(\d+)/i);
  if (opToken) return Number(opToken[1]);
  return 0;
}

function trialCatalogOpNumericNo(card) {
  const normalized = typeof trialCatalogNormalizedOpNo === 'function'
    ? trialCatalogNormalizedOpNo(card)
    : '';
  if (normalized && /^\d+$/.test(String(normalized))) return Number(normalized);
  const sourceStage = Number(card?.source_stage_no ?? card?.op?.source_stage_no ?? 0);
  if (sourceStage > 0) return sourceStage;
  const seq = Number(card?.source_op_seq_id || 0);
  return seq > 0 ? seq : 0;
}

/** ERP advanced past this op — standard PS only; never applies to [Temp]. */
function trialCatalogOpIsBeforeCurrentErpStage(card, ps) {
  if (!card || !ps || trialCatalogIsTempPs(ps, card)) return false;
  const currentStageNo = Number(ps?.current_stage_no || 0);
  const opStageNo = Number(card?.source_stage_no ?? card?.op?.source_stage_no ?? 0);
  if (currentStageNo > 0 && opStageNo > 0) {
    return opStageNo < currentStageNo;
  }
  const stageNo = trialCatalogErpCurrentStageNo(ps);
  const opNo = trialCatalogOpNumericNo(card);
  return stageNo > 0 && opNo > 0 && opNo < stageNo;
}

/** Qty-backed production complete — the only definition of "actually done". */
function trialCatalogOpIsProductionComplete(card, ps) {
  if (!card || trialCatalogOpIsManualBom(card)) return false;
  const required = Number(card?.required_qty ?? card?.wo_qty_required ?? 0);
  const produced = trialCatalogOpErpProducedQty(card);
  if (required > TRIAL_CATALOG_QTY_TOL && produced >= required - TRIAL_CATALOG_QTY_TOL) return true;
  const schedRemaining = typeof trialCatalogSchedulableRemaining === 'function'
    ? trialCatalogSchedulableRemaining(card)
    : Math.max(0, Number(card?.remaining_qty ?? card?.target_qty ?? 0));
  if (schedRemaining <= TRIAL_CATALOG_QTY_TOL && produced > TRIAL_CATALOG_QTY_TOL) return true;
  const remaining = Number(card?.remaining_qty ?? card?.target_qty ?? 0);
  const hasWork = required > TRIAL_CATALOG_QTY_TOL || produced > TRIAL_CATALOG_QTY_TOL;
  if (remaining <= TRIAL_CATALOG_QTY_TOL && hasWork && produced > TRIAL_CATALOG_QTY_TOL) return true;
  const exec = trialNormalizeExecStatus(trialCatalogOpExecStatus(card));
  if (exec === 'C' || exec === 'COMPLETED') {
    if (required > TRIAL_CATALOG_QTY_TOL) return produced >= required - TRIAL_CATALOG_QTY_TOL;
    return produced > TRIAL_CATALOG_QTY_TOL;
  }
  return false;
}

/** Closed for catalog/drag on standard PS when qty-done OR ERP stage passed. Never on [Temp]. */
function trialCatalogOpIsComplete(card, ps) {
  if (trialCatalogOpIsProductionComplete(card, ps)) return true;
  if (trialCatalogIsTempPs(ps, card)) return false;
  return trialCatalogOpIsBeforeCurrentErpStage(card, ps);
}

function trialCatalogOpDisplayExecStatus(card, ps) {
  if (trialCatalogOpIsProductionComplete(card, ps)) return 'C';
  const raw = trialCatalogOpExecStatus(card);
  const norm = trialNormalizeExecStatus(raw);
  if (norm === 'C' || norm === 'COMPLETED') return '';
  return raw;
}

function trialCatalogOpIsOpen(card, ps) {
  if (trialCatalogOpIsManualBom(card)) return true;
  if (trialCatalogOpIsComplete(card, ps)) return false;
  const exec = trialNormalizeExecStatus(trialCatalogOpExecStatus(card));
  const remaining = Number(card?.remaining_qty ?? card?.target_qty ?? 0);
  if (remaining > TRIAL_CATALOG_QTY_TOL) return true;
  const schedRemaining = typeof trialCatalogSchedulableRemaining === 'function'
    ? trialCatalogSchedulableRemaining(card)
    : remaining;
  if (schedRemaining > TRIAL_CATALOG_QTY_TOL) return true;
  const required = Number(card?.wo_qty_required ?? card?.required_qty ?? 0);
  const produced = trialCatalogOpErpProducedQty(card);
  if (required > TRIAL_CATALOG_QTY_TOL && produced >= required - TRIAL_CATALOG_QTY_TOL) return false;
  if (produced > TRIAL_CATALOG_QTY_TOL && schedRemaining <= TRIAL_CATALOG_QTY_TOL) return false;
  const hasWoOutput = required > TRIAL_CATALOG_QTY_TOL || produced > TRIAL_CATALOG_QTY_TOL || Boolean(exec);
  if (!hasWoOutput) return false;
  return exec !== 'C' && exec !== 'COMPLETED';
}

function trialCatalogOpOpenProbe(op, ps) {
  if (!op || typeof op !== 'object') return false;
  if (String(op.source_kind || '').toUpperCase() === 'MANUAL') return true;
  const card = {
    execution_status: op.execution_status || op.op?.execution_status || '',
    remaining_qty: op.remaining_qty,
    target_qty: op.total_qty ?? op.remaining_qty,
    required_qty: op.required_qty,
    wo_qty_required: op.required_qty,
    finished_qty: op.finished_qty ?? op.erp_finished_qty,
    wo_qty_produced: op.wo_qty_produced ?? op.erp_finished_qty,
    erp_finished_qty: op.erp_finished_qty,
    source_stage_no: op.source_stage_no,
    source_op_no: op.source_op_no || op.op_no,
    source_kind: op.source_kind,
    op,
  };
  return trialCatalogOpIsOpen(card, ps);
}

function trialCatalogPsPoolsFallback() {
  if (typeof trialCatalogPsPools === 'function') return trialCatalogPsPools().all;
  return [
    ...(Array.isArray(trialState?.catalog) ? trialState.catalog : []),
    ...(Array.isArray(trialState?.planned) ? trialState.planned : []),
  ];
}

/** Earlier route step satisfied — temp uses queue/qty only; ERP may use stage-passed. */
function trialCatalogPriorOpSatisfiedForRoute(prior, ps, pool) {
  if (!prior) return true;
  if (trialCatalogOpIsManualBom(prior)) return true;
  if (trialCatalogOpIsProductionComplete(prior, ps)) return true;

  if (trialCatalogIsTempPs(ps)) {
    if (typeof trialIsCatalogOpAllocated === 'function' && trialIsCatalogOpAllocated(prior)) return true;
    if (typeof trialIsCatalogOpFullyQueued === 'function' && trialIsCatalogOpFullyQueued(prior)) return true;
    return false;
  }

  if (trialCatalogOpIsBeforeCurrentErpStage(prior, ps)) return true;
  if (typeof trialIsCatalogOpAllocatedIncludingTemp === 'function'
    && trialIsCatalogOpAllocatedIncludingTemp(prior, ps, pool)) {
    return true;
  }
  if (typeof trialIsCatalogOpFullyQueued === 'function' && trialIsCatalogOpFullyQueued(prior)) {
    return true;
  }
  return false;
}

function trialCatalogImmediatePriorRouteSatisfied(card, ps, pool) {
  if (typeof trialCatalogRouteOpsForPs !== 'function') return false;
  const cards = trialCatalogRouteOpsForPs(ps);
  const myKey = typeof trialCatalogOpCardKey === 'function' ? trialCatalogOpCardKey(card) : '';
  const myIdx = cards.findIndex(row => (
    typeof trialCatalogOpCardKey === 'function' && trialCatalogOpCardKey(row) === myKey
  ));
  if (myIdx <= 0) return false;
  return trialCatalogPriorOpSatisfiedForRoute(cards[myIdx - 1], ps, pool);
}

function trialCatalogPriorRouteOpsSatisfied(card, ps) {
  if (!ps || !card || typeof trialCatalogRouteOpsForPs !== 'function') return false;
  const pool = trialCatalogPsPoolsFallback();
  const cards = trialCatalogRouteOpsForPs(ps);
  const myKey = typeof trialCatalogOpCardKey === 'function' ? trialCatalogOpCardKey(card) : '';
  if (!myKey) return false;
  let sawPrior = false;
  for (const prior of cards) {
    if (typeof trialCatalogOpCardKey === 'function' && trialCatalogOpCardKey(prior) === myKey) {
      return sawPrior;
    }
    sawPrior = true;
    if (!trialCatalogPriorOpSatisfiedForRoute(prior, ps, pool)) return false;
  }
  return false;
}

function trialCatalogOpBypassesStageForRouteProgress(card, ps) {
  if (trialCatalogPriorRouteOpsSatisfied(card, ps)) return true;
  const pool = trialCatalogPsPoolsFallback();
  if (typeof trialCatalogPsHasQueuedBlocksIncludingTemp !== 'function'
    || !trialCatalogPsHasQueuedBlocksIncludingTemp(ps, pool)) {
    return false;
  }
  return trialCatalogImmediatePriorRouteSatisfied(card, ps, pool);
}

function trialCatalogOpQueueBlockReason(card) {
  if (typeof trialIsCatalogOpFullyQueued !== 'function' || !trialIsCatalogOpFullyQueued(card)) {
    return null;
  }
  const machines = typeof trialQueuedMachineCodesForCatalogOp === 'function'
    ? trialQueuedMachineCodesForCatalogOp(card)
    : [];
  return machines.length
    ? `Fully queued on ${machines.join(', ')} — remove a run block to reschedule.`
    : 'This operation is already fully queued.';
}

/**
 * Single drag gate — all pointer/drop paths must use this (render + dnd).
 * Returns { ok, reason, code }.
 */
function trialCatalogOpDragEligibility(card, ps) {
  if (!card) return { ok: false, reason: 'Operation not found.', code: 'missing' };

  const kind = trialCatalogPsKind(ps);
  const schedRemaining = typeof trialCatalogSchedulableRemaining === 'function'
    ? trialCatalogSchedulableRemaining(card)
    : Math.max(0, Number(card?.remaining_qty ?? card?.target_qty ?? 0));

  const queueReason = trialCatalogOpQueueBlockReason(card);
  if (queueReason) {
    return { ok: false, reason: queueReason, code: 'fully_queued' };
  }

  if (schedRemaining <= TRIAL_CATALOG_QTY_TOL) {
    return { ok: false, reason: 'No remaining quantity to schedule.', code: 'no_qty' };
  }

  // Layer 1 — [Temp]: planner rework qty only; no ERP stage / completion inheritance
  if (kind === 'temp') {
    return { ok: true, reason: '', code: 'temp' };
  }

  // Layer 2 — production complete (qty-backed)
  if (trialCatalogOpIsProductionComplete(card, ps)) {
    return { ok: false, reason: 'This operation is already complete.', code: 'production_complete' };
  }

  // Layer 3 — ERP stage passed (do not re-queue earlier stages)
  if (trialCatalogOpIsBeforeCurrentErpStage(card, ps)) {
    return {
      ok: false,
      reason: 'ERP has already advanced past this operation.',
      code: 'stage_passed',
    };
  }

  if (trialCatalogOpIsManualBom(card)) {
    return { ok: true, reason: '', code: 'manual_bom' };
  }

  const exec = trialNormalizeExecStatus(trialCatalogOpExecStatus(card));
  if (exec === 'I' || exec === 'IN_PROCESS') {
    return {
      ok: false,
      reason: 'This operation is already in progress in ERP.',
      code: 'erp_in_progress',
    };
  }

  const pool = trialCatalogPsPoolsFallback();
  const bypassStage = (typeof trialCatalogOpBypassesStageInQueuedOp40View === 'function'
    && trialCatalogOpBypassesStageInQueuedOp40View(card, ps))
    || trialCatalogOpBypassesStageForRouteProgress(card, ps);

  if (!bypassStage && ps && typeof trialCatalogSupersededByTempSibling === 'function'
    && trialCatalogSupersededByTempSibling(ps, pool)) {
    return {
      ok: false,
      reason: 'This process sheet was superseded by a [Temp] line.',
      code: 'temp_supersede',
    };
  }

  if (!bypassStage && typeof trialCatalogOpMatchesCurrentStage === 'function'
    && !trialCatalogOpMatchesCurrentStage(card, ps)) {
    const routeOps = typeof trialCatalogRouteOpsForPs === 'function'
      ? trialCatalogRouteOpsForPs(ps)
      : [];
    const myKey = typeof trialCatalogOpCardKey === 'function' ? trialCatalogOpCardKey(card) : '';
    const myIdx = routeOps.findIndex(row => (
      typeof trialCatalogOpCardKey === 'function' && trialCatalogOpCardKey(row) === myKey
    ));
    let blockingPrior = null;
    if (myIdx > 0) {
      for (let i = 0; i < myIdx; i += 1) {
        const prior = routeOps[i];
        if (!trialCatalogPriorOpSatisfiedForRoute(prior, ps, pool)) {
          blockingPrior = prior;
          break;
        }
      }
    }
    const priorLabel = blockingPrior
      ? String(blockingPrior.source_op_no || blockingPrior.operation_label || '').trim()
      : '';
    const reason = myIdx <= 0
      ? 'Only the current ERP stage can be queued for this process sheet.'
      : (priorLabel
        ? `Queue op ${priorLabel} on a machine before scheduling this step.`
        : 'Queue earlier route operations on a machine before scheduling this step.');
    return { ok: false, reason, code: 'route_order' };
  }

  return { ok: true, reason: '', code: 'ok' };
}

function trialCatalogOpCanDrag(card, ps) {
  return trialCatalogOpDragEligibility(card, ps).ok;
}

/** UI bundle for catalog op cards — keeps render/dnd in sync. */
function trialCatalogOpCardUiState(card, ps) {
  const eligibility = trialCatalogOpDragEligibility(card, ps);
  const isProductionComplete = trialCatalogOpIsProductionComplete(card, ps);
  const isStagePassed = trialCatalogOpIsBeforeCurrentErpStage(card, ps);
  const isComplete = trialCatalogOpIsComplete(card, ps);
  return {
    canDrag: eligibility.ok,
    dragBlockReason: eligibility.reason || '',
    dragBlockCode: eligibility.code || '',
    isProductionComplete,
    isStagePassed,
    isComplete,
    execStatus: trialCatalogOpDisplayExecStatus(card, ps),
    schedulableRemaining: typeof trialCatalogSchedulableRemaining === 'function'
      ? trialCatalogSchedulableRemaining(card)
      : Math.max(0, Number(card?.remaining_qty ?? card?.target_qty ?? 0)),
  };
}
