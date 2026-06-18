// HTTP helpers and the main data-load function.

async function GET(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data && data.error) msg = data.error;
    } catch (_) {
      // ignore JSON parse errors
    }
    throw new Error(msg);
  }
  return res.json();
}

function trialNoCacheUrl(url) {
  const u = new URL(String(url || ''), window.location.origin);
  u.searchParams.set('_ts', String(Date.now()));
  return `${u.pathname}?${u.searchParams.toString()}`;
}

async function POST(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

async function PUT(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

async function DEL(url) {
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function trialLaneOrderFromElement(laneEl) {
  if (!laneEl) return null;
  const machineId = Number(laneEl.dataset.machineId || 0);
  const orderedIds = Array.from(
    laneEl.querySelectorAll(':scope > .trial-block-card[data-block-id], :scope > .trial-queue-row[data-block-id]')
  ).map(card => Number(card.dataset.blockId)).filter(Boolean);
  if (!machineId || !orderedIds.length) return null;
  return { machine_id: machineId, ordered_ids: orderedIds };
}

function trialRecalcStartIndex(existingIds, orderedIds) {
  const existing = (existingIds || []).map(Number).filter(Boolean);
  const ordered = (orderedIds || []).map(Number).filter(Boolean);
  if (!ordered.length) return 0;
  let prefix = 0;
  for (let idx = 0; idx < Math.min(existing.length, ordered.length); idx += 1) {
    if (ordered[idx] === existing[idx]) prefix = idx + 1;
    else break;
  }
  if (prefix >= ordered.length && ordered.length === existing.length) return ordered.length;
  return prefix;
}

function trialMachineBlockOrder(machineId) {
  const mid = Number(machineId || 0);
  if (!mid) return [];
  return (trialState.blocks || [])
    .filter(block => Number(block.machine_id) === mid && block.active !== false)
    .sort((a, b) => (
      Number(a.queue_position || 0) - Number(b.queue_position || 0)
      || Number(a.block_id || 0) - Number(b.block_id || 0)
    ))
    .map(block => Number(block.block_id))
    .filter(Boolean);
}

function trialSyncRecalcBaseline(machineIds = null) {
  const targets = machineIds == null
    ? (trialState.machines || []).map(row => Number(row.machine_id || 0)).filter(Boolean)
    : (machineIds || []).map(Number).filter(Boolean);
  targets.forEach(mid => {
    trialRecalcBaselineByMachine.set(mid, trialMachineBlockOrder(mid));
  });
}

function trialMergeDirtyTailBlock(machineId, blockId) {
  const mid = Number(machineId || 0);
  const bid = Number(blockId || 0);
  if (!mid || !bid) return;
  const order = trialMachineBlockOrder(mid);
  const newIdx = order.indexOf(bid);
  if (newIdx < 0) {
    trialDirtyTailByMachine.delete(mid);
    return;
  }
  const existing = trialDirtyTailByMachine.get(mid);
  if (!existing) {
    trialDirtyTailByMachine.set(mid, bid);
    return;
  }
  const existingIdx = order.indexOf(existing);
  if (existingIdx < 0 || newIdx < existingIdx) {
    trialDirtyTailByMachine.set(mid, bid);
  }
}

function trialTailBlockIdFromQueueDelta(machineId, orderedIds = null) {
  const mid = Number(machineId || 0);
  if (!mid) return null;
  const baseline = trialRecalcBaselineByMachine.get(mid);
  if (!baseline || !baseline.length) return null;
  const current = orderedIds || trialMachineBlockOrder(mid);
  const idx = trialRecalcStartIndex(baseline, current);
  if (idx >= current.length) return null;
  return current[idx];
}

function trialDirtyTailByMachinePayload(machineIds) {
  const payload = {};
  (machineIds || []).forEach(id => {
    const mid = Number(id || 0);
    const blockId = trialDirtyTailByMachine.get(mid);
    if (mid && blockId) payload[String(mid)] = Number(blockId);
  });
  return payload;
}

function trialMarkDirtyMachines(machineIds, options = {}) {
  const queueOrders = options.queueOrders || {};
  (machineIds || []).forEach(id => {
    const numeric = Number(id || 0);
    if (!numeric) return;
    trialDirtyMachineIds.add(numeric);
    if (options.tailFromBlockId) {
      const orderedIds = queueOrders[numeric] || queueOrders[String(numeric)] || null;
      const blockId = Number(options.tailFromBlockId);
      const currentOrder = orderedIds || trialMachineBlockOrder(numeric);
      if (currentOrder.includes(blockId)) {
        trialMergeDirtyTailBlock(numeric, blockId);
      } else {
        const tailId = trialTailBlockIdFromQueueDelta(numeric, orderedIds);
        if (tailId) trialMergeDirtyTailBlock(numeric, tailId);
      }
    } else if (!options.skipTailUpdate) {
      const orderedIds = queueOrders[numeric] || queueOrders[String(numeric)] || null;
      const tailId = trialTailBlockIdFromQueueDelta(numeric, orderedIds);
      if (tailId) trialMergeDirtyTailBlock(numeric, tailId);
    }
  });
  trialUpdateStaleScheduleUi(options);
}

function trialClearDirtyMachines(machineIds) {
  if (machineIds == null) {
    trialDirtyMachineIds.clear();
    trialDirtyTailByMachine.clear();
  } else {
    (machineIds || []).forEach(id => {
      const numeric = Number(id || 0);
      if (!numeric) return;
      trialDirtyMachineIds.delete(numeric);
      trialDirtyTailByMachine.delete(numeric);
      trialSyncRecalcBaseline([numeric]);
    });
  }
  trialUpdateStaleScheduleUi();
}

function trialUpdateStaleScheduleUi(options = {}) {
  let banner = document.getElementById('trial-stale-schedule-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'trial-stale-schedule-banner';
    banner.className = 'trial-stale-schedule-banner';
    banner.setAttribute('role', 'status');
    const anchor = document.getElementById('trial-machine-filter-shell')
      || document.querySelector('.trial-main');
    if (anchor?.parentNode) {
      anchor.parentNode.insertBefore(banner, anchor);
    }
  }
  const count = trialDirtyMachineIds.size;
  if (!count) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `
    <span class="trial-stale-schedule-banner-text">
      ${count} machine${count === 1 ? '' : 's'}: schedule times may be outdated after queue changes.
    </span>
    <button type="button" class="btn btn-primary btn-sm" onclick="trialRecalculateDirtySchedules()">
      Recalculate schedules
    </button>
  `;
  if (typeof trialSyncStaleMachineBadges === 'function') {
    trialSyncStaleMachineBadges();
  }
  if (options.rerenderMachines && typeof trialScheduleRender === 'function') {
    trialScheduleRender([...trialDirtyMachineIds], { deferCatalog: true, skipCatalog: true });
  }
}

async function postTrialQueueReorder(lanes, options = {}) {
  const recalculate = options.recalculate !== false;
  const normalized = (lanes || [])
    .map(lane => ({
      machine_id: Number(lane.machine_id || 0),
      ordered_ids: (lane.ordered_ids || []).map(Number).filter(Boolean),
    }))
    .filter(lane => lane.machine_id && lane.ordered_ids.length);
  if (!normalized.length) return null;
  const body = { recalculate };
  if (normalized.length === 1) {
    const lane = normalized[0];
    return POST(`/api/trial/blocks/${lane.ordered_ids[0]}/reorder`, {
      machine_id: lane.machine_id,
      ordered_ids: lane.ordered_ids,
      ...body,
    });
  }
  return POST('/api/trial/queue/reorder-batch', { lanes: normalized, ...body });
}

async function postTrialQueueRecalculate(machineIds) {
  const ids = [...new Set((machineIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return null;
  const tailByMachine = trialDirtyTailByMachinePayload(ids);
  const body = { machine_ids: ids };
  if (Object.keys(tailByMachine).length) body.tail_by_machine = tailByMachine;
  return POST('/api/trial/queue/recalculate', body);
}

async function trialRecalculateDirtySchedules() {
  const ids = [...trialDirtyMachineIds];
  if (!ids.length) return;
  try {
    await trialRunWithPlannerBusy(async () => {
      const result = await postTrialQueueRecalculate(ids);
      trialClearDirtyMachines(ids);
      await refreshMachines(ids, { response: result });
      toast('Schedules recalculated', 'success');
    }, 'Recalculating schedules…', `${ids.length} machine${ids.length === 1 ? '' : 's'}`);
  } catch (err) {
    toast('Recalculate failed: ' + err.message, 'error');
  }
}

async function trialRecalculateSingleMachine(machineId) {
  const id = Number(machineId || 0);
  if (!id) return;
  try {
    await trialRunWithPlannerBusy(async () => {
      const result = await postTrialQueueRecalculate([id]);
      trialDirtyMachineIds.delete(id);
      trialUpdateStaleScheduleUi();
      await refreshMachines([id], { response: result });
      toast('Schedule recalculated', 'success');
    }, 'Recalculating…', '');
  } catch (err) {
    toast('Recalculate failed: ' + err.message, 'error');
  }
}

window.trialRecalculateDirtySchedules = trialRecalculateDirtySchedules;
window.trialRecalculateSingleMachine = trialRecalculateSingleMachine;

function trialShowCompletedFlag() {
  return typeof trialShowCompleted !== 'undefined' ? !!trialShowCompleted : false;
}

function trialCatalogUrl(refresh = false) {
  const params = new URLSearchParams();
  if (trialShowCompletedFlag()) params.set('show_completed', '1');
  if (refresh) params.set('refresh', '1');
  const qs = params.toString();
  return `/api/pp-vouchers/with-ops${qs ? `?${qs}` : ''}`;
}

function trialCatalogCacheKey() {
  return trialShowCompletedFlag() ? 'catalogAll' : 'catalog';
}

function trialInvalidateCatalogCache() {
  ['catalog', 'catalogAll'].forEach(key => {
    trialLoadCache[key] = null;
    trialLoadCache[`${key}ExpiresAt`] = 0;
  });
  if (typeof trialInvalidateCatalogSearchIndex === 'function') trialInvalidateCatalogSearchIndex();
}

function trialAssignCatalogRows(rows) {
  trialState.catalog = Array.isArray(rows) ? rows : [];
  if (typeof trialInvalidateCatalogSearchIndex === 'function') trialInvalidateCatalogSearchIndex();
}

let _trialMissingTempCatalogRefreshTimer = 0;
let _trialMissingTempCatalogRefreshInFlight = false;

/** Debounced refresh when queued [Temp] lines are on the board but not in /with-ops yet. */
function trialScheduleMissingTempCatalogRefresh() {
  if (_trialMissingTempCatalogRefreshInFlight) return;
  clearTimeout(_trialMissingTempCatalogRefreshTimer);
  _trialMissingTempCatalogRefreshTimer = window.setTimeout(() => {
    _trialMissingTempCatalogRefreshTimer = 0;
    if (typeof trialBoardTempPsIdsMissingFromCatalog !== 'function') return;
    if (!trialBoardTempPsIdsMissingFromCatalog().length) return;
    if (typeof trialRefreshCatalogSidebar !== 'function') return;
    _trialMissingTempCatalogRefreshInFlight = true;
    trialRefreshCatalogSidebar()
      .catch(err => console.error('catalog refresh for board-only temp PS failed:', err))
      .finally(() => {
        _trialMissingTempCatalogRefreshInFlight = false;
      });
  }, 1500);
}

function trialCatalogClientCacheMs() {
  return 300000;
}

/** Re-render catalog sidebar from in-memory blocks (no /with-ops round trip). */
function trialRerenderCatalogFromBlocks() {
  if (typeof renderTrialCatalog === 'function') renderTrialCatalog();
  if (typeof bindTrialCatalogDnD === 'function') bindTrialCatalogDnD();
}

/** Reload PS/Ops sidebar after queue mutations (split, delete, schedule). */
async function trialRefreshCatalogSidebar() {
  trialInvalidateCatalogCache();
  try {
    const erpVouchers = await GET(trialNoCacheUrl(trialCatalogUrl(false)));
    const cacheKey = trialCatalogCacheKey();
    trialLoadCache[cacheKey] = Array.isArray(erpVouchers) ? erpVouchers : [];
    trialLoadCache[`${cacheKey}ExpiresAt`] = Date.now() + trialCatalogClientCacheMs();
    trialAssignCatalogRows(trialLoadCache[cacheKey]);
    if (typeof trialMaterialInOverrides !== 'undefined') trialMaterialInOverrides.clear();
    if (typeof renderTrialCatalog === 'function') renderTrialCatalog();
    if (typeof bindTrialCatalogDnD === 'function') bindTrialCatalogDnD();
  } catch (err) {
    console.error('trialRefreshCatalogSidebar failed:', err);
  }
}

async function syncPpVouchers() {
  try {
    await (window.syncErpPpVouchers ? window.syncErpPpVouchers() : POST('/api/pp-vouchers/sync', {}));
    trialInvalidateCatalogCache();
    const erpVouchers = await GET(trialNoCacheUrl(trialCatalogUrl(true)));
    const cacheKey = trialCatalogCacheKey();
    trialLoadCache[cacheKey] = Array.isArray(erpVouchers) ? erpVouchers : [];
    trialLoadCache[`${cacheKey}ExpiresAt`] = Date.now() + 60000;
    trialAssignCatalogRows(trialLoadCache[cacheKey]);
    trialScheduleRender();
  } catch (err) {
    console.error('pp-vouchers sync failed:', err);
  }
}

window.addEventListener('pp-vouchers-synced', () => {
  trialInvalidateCatalogCache();
  GET(trialNoCacheUrl(trialCatalogUrl(true)))
    .then(erpVouchers => {
      const cacheKey = trialCatalogCacheKey();
      trialLoadCache[cacheKey] = Array.isArray(erpVouchers) ? erpVouchers : [];
      trialLoadCache[`${cacheKey}ExpiresAt`] = Date.now() + 60000;
      trialAssignCatalogRows(trialLoadCache[cacheKey]);
      trialScheduleRender();
    })
    .catch(err => console.error('catalog refresh after ERP sync failed:', err));
});

async function trialRefreshCatalogAfterTempPsChange(event) {
  if (!document.getElementById('trial-catalog') || typeof loadTrial !== 'function') return;
  await loadTrial({ force: true });
  const detail = event?.detail || {};
  const search = document.getElementById('trial-catalog-search');
  const label = detail.display_ps_id || detail.planner_ps_id || '';
  if (search && label) {
    search.value = label;
    if (typeof renderTrialCatalog === 'function') renderTrialCatalog();
  }
}

window.addEventListener('temp-ps-created', event => {
  trialRefreshCatalogAfterTempPsChange(event).catch(err => {
    console.error('catalog refresh after temp PS create failed:', err);
  });
});

window.addEventListener('temp-ps-updated', () => {
  if (!document.getElementById('trial-catalog') || typeof trialRefreshCatalogSidebar !== 'function') return;
  trialRefreshCatalogSidebar().catch(err => {
    console.error('catalog refresh after temp PS update failed:', err);
  });
});

function trialNormalizeBlockFromApi(block) {
  if (!block) return null;
  return {
    ...block,
    visual_start_datetime: block.visual_start_datetime ||
      block.calculated_start_datetime ||
      block.predicted_start_at ||
      '',
    visual_end_datetime: block.visual_end_datetime ||
      block.calculated_end_datetime ||
      block.predicted_end_at ||
      '',
  };
}

function trialMergeBlockFromApi(block) {
  const normalized = trialNormalizeBlockFromApi(block);
  if (!normalized || !normalized.block_id) return;
  const blocks = Array.isArray(trialState.blocks) ? [...trialState.blocks] : [];
  const idx = blocks.findIndex(b => String(b.block_id) === String(normalized.block_id));
  if (idx >= 0) blocks[idx] = { ...blocks[idx], ...normalized };
  else blocks.push(normalized);
  trialState.blocks = blocks;
  if (typeof trialResetDataIndexes === 'function') trialResetDataIndexes();
}

function trialPinBlock(block, ttlMs = 30000) {
  const normalized = trialNormalizeBlockFromApi(block);
  if (!normalized || !normalized.block_id) return;
  const blockId = String(normalized.block_id);
  trialPinnedBlocks.set(blockId, normalized);
  window.setTimeout(() => trialPinnedBlocks.delete(blockId), ttlMs);
}

function trialApplyMachineRefreshPayload(machineIds, payload) {
  if (!payload || !Array.isArray(payload.blocks)) return false;
  const machineSet = new Set((machineIds || []).map(id => String(Number(id))).filter(id => id !== '0'));
  if (!machineSet.size) return false;

  const keptBlocks = (trialState.blocks || []).filter(b => !machineSet.has(String(b.machine_id)));
  const refreshedBlocks = trialMergeBlocksWithSchedule(payload.blocks);
  trialState.blocks = [...keptBlocks, ...refreshedBlocks];

  if (Array.isArray(payload.block_groups) && payload.block_groups.length) {
    const refreshedGroupIds = new Set(
      payload.block_groups.map(g => String(g.group_id || 0)).filter(id => id !== '0')
    );
    trialState.block_groups = [
      ...(trialState.block_groups || []).filter(g => {
        const onMachine = machineSet.has(String(g.machine_id || 0));
        const groupId = String(g.group_id || 0);
        return !(onMachine || refreshedGroupIds.has(groupId));
      }),
      ...payload.block_groups,
    ];
  }

  if (typeof trialResetDataIndexes === 'function') trialResetDataIndexes();
  return true;
}

function trialApplyMachineRefreshFromResponse(machineIds, response) {
  let applied = trialApplyMachineRefreshPayload(machineIds, response?.machine_refresh);
  if (!applied && response?.block) {
    trialMergeBlockFromApi(response.block);
    applied = true;
  }
  if (!applied) return false;
  trialScheduleRender(machineIds, { deferCatalog: true });
  return true;
}

function trialLaneShowsBlock(block, machineId) {
  if (!block || Number(block.machine_id) !== Number(machineId)) return false;
  const blockId = String(block.block_id || '');
  if (!blockId) return false;
  const groups = typeof trialBlocksGroupedForMachine === 'function'
    ? trialBlocksGroupedForMachine(machineId)
    : [];
  const group = (groups || []).find(row => {
    const leaderId = String(row?.leader?.block_id || '');
    if (leaderId === blockId) return true;
    return (row?.blocks || []).some(b => String(b.block_id) === blockId);
  });
  if (!group) return true;
  if (typeof trialHasActiveDateFilter === 'function' && trialHasActiveDateFilter()
    && typeof trialGroupRunsInsideDateFilter === 'function') {
    return trialGroupRunsInsideDateFilter(group);
  }
  return true;
}

/** POST queue row; canonical PS id; retry once if server matched another partial. */
async function trialPostCatalogQueueOperation(body, catalogCard) {
  const build = typeof trialCanonicalQueuePayload === 'function'
    ? trialCanonicalQueuePayload
    : (b) => ({ ...b });
  const resolve = typeof trialResolveQueueCard === 'function'
    ? trialResolveQueueCard(catalogCard || body)
    : null;
  const buildPayload = (seed = body) => {
    const card = resolve?.catalogCard || catalogCard || {};
    const built = build({ ...seed }, card);
    const wantPartial = resolve?.ppPartialNo
      ?? (typeof trialCatalogPartialIndex === 'function' ? trialCatalogPartialIndex(catalogCard || seed) : 1);
    const plannerId = resolve?.plannerPsId
      || (typeof trialFormatPlannerPsId === 'function'
        ? trialFormatPlannerPsId(
          typeof trialCatalogSourceBase === 'function' ? trialCatalogSourceBase(card) : '',
          wantPartial,
        )
        : '');
    if (plannerId) {
      built.job_no = plannerId;
      built.source_ps_id = plannerId;
    }
    if (wantPartial > 0) built.pp_partial_no = wantPartial;
    return built;
  };
  let payload = buildPayload();
  let result = await POST('/api/trial/operations', payload);
  if (!result?.duplicate || !result?.block) return result;
  const want = Number(payload.pp_partial_no)
    || Number(result?.requested_partial_no)
    || 1;
  const got = Number(result?.matched_partial_no)
    || (typeof trialCatalogPartialIndex === 'function' ? trialCatalogPartialIndex(result.block) : 1);
  if (got === want) return result;
  console.warn('trialPostCatalogQueueOperation: duplicate partial mismatch — retrying with forced planner id', {
    sent: payload,
    want,
    got,
    response: result,
  });
  payload = buildPayload({
    ...body,
    pp_partial_no: want,
    job_no: typeof trialFormatPlannerPsId === 'function'
      ? trialFormatPlannerPsId(
        typeof trialCatalogSourceBase === 'function'
          ? trialCatalogSourceBase(resolve?.catalogCard || catalogCard || body)
          : '',
        want,
      )
      : body.job_no,
    source_ps_id: typeof trialFormatPlannerPsId === 'function'
      ? trialFormatPlannerPsId(
        typeof trialCatalogSourceBase === 'function'
          ? trialCatalogSourceBase(resolve?.catalogCard || catalogCard || body)
          : '',
        want,
      )
      : body.source_ps_id,
  });
  result = await POST('/api/trial/operations', payload);
  return result;
}

function trialCatalogOpOnLane(catalogCard, machineId, resultBlock) {
  const mid = Number(machineId || 0);
  if (!mid) return false;
  const block = resultBlock ? trialNormalizeBlockFromApi(resultBlock) : null;
  if (block && typeof trialBlockMatchesCatalogCard === 'function'
    && trialBlockMatchesCatalogCard(block, catalogCard)
    && trialLaneShowsBlock(block, mid)) {
    return true;
  }
  return typeof trialCatalogOpVisibleOnMachineLane === 'function'
    && trialCatalogOpVisibleOnMachineLane(catalogCard, mid);
}

/** After POST /api/trial/operations — sync lane + sidebar and verify the block exists. */
async function trialFinalizeCatalogQueueSchedule({ catalogCard, machineId, result, qtyLabel }) {
  const numericMachineId = Number(machineId || 0);
  const affectedIds = [numericMachineId].filter(Boolean);
  const resultBlock = result?.block ? trialNormalizeBlockFromApi(result.block) : null;
  if (result?.block) {
    trialPinBlock(result.block);
    trialMergeBlockFromApi(result.block);
  }
  const queueOrders = {};
  if (numericMachineId && result?.block?.block_id) {
    queueOrders[numericMachineId] = trialMachineBlockOrder(numericMachineId);
    if (!queueOrders[numericMachineId].includes(Number(result.block.block_id))) {
      queueOrders[numericMachineId].push(Number(result.block.block_id));
    }
  }
  await refreshMachines(affectedIds, { response: result });
  trialMarkDirtyMachines(affectedIds, {
    skipRender: true,
    queueOrders,
    tailFromBlockId: result?.block?.block_id,
  });
  if (typeof trialRerenderCatalogFromBlocks === 'function') {
    trialRerenderCatalogFromBlocks();
  }
  const machine = (trialState.machines || []).find(row => Number(row.machine_id) === numericMachineId);
  const label = machine?.machine_code || `Machine ${numericMachineId}`;
  const onLane = trialCatalogOpOnLane(catalogCard, numericMachineId, resultBlock);
  if (result?.duplicate) {
    const partialLabel = typeof trialCatalogPartialIndex === 'function'
      ? trialCatalogPartialIndex(catalogCard)
      : 1;
    const blockPartial = resultBlock && typeof trialCatalogPartialIndex === 'function'
      ? trialCatalogPartialIndex(resultBlock)
      : partialLabel;
    const serverWant = Number(result?.requested_partial_no);
    const serverGot = Number(result?.matched_partial_no);
    if (resultBlock && blockPartial !== partialLabel
      && (Number.isFinite(serverGot) && serverGot !== partialLabel
        || !Number.isFinite(serverWant) || serverWant !== partialLabel)) {
      console.error('Partial queue identity mismatch', {
        catalogPartial: partialLabel,
        blockPartial,
        requested_partial_no: result?.requested_partial_no,
        matched_partial_no: result?.matched_partial_no,
        requested_source_ps_id: result?.requested_source_ps_id,
        block: resultBlock,
        catalogCard,
      });
      toast(
        `Could not add Partial ${partialLabel} on ${label} — request used Partial ${blockPartial}'s id. Hard-refresh (Ctrl+F5) and try again.`,
        'error',
      );
      return { ok: false, duplicate: false };
    }
    const opMatches = !resultBlock || (
      typeof trialBlockMatchesCatalogCard === 'function'
      && trialBlockMatchesCatalogCard(resultBlock, catalogCard)
    );
    if (resultBlock && !opMatches) {
      toast(`Partial ${partialLabel} already on ${label} for a different operation.`, 'info');
      return { ok: onLane, duplicate: true };
    }
    toast(
      onLane
        ? `Partial ${partialLabel} already on ${label} — queue order updated.`
        : `Partial ${partialLabel} is on ${label} but hidden by the date filter — clear dates or reload.`,
      onLane ? 'info' : 'error',
    );
    return { ok: onLane, duplicate: true };
  }
  if (onLane) {
    const qtyText = qtyLabel ? ` ${qtyLabel}` : '';
    toast(`Queued${qtyText} on ${label} — click Recalculate schedules for times`, 'success');
    return { ok: true, duplicate: false };
  }
  toast(
    `Queue saved but the card did not appear on ${label}. Clear the date filter or reload the board.`,
    'error',
  );
  return { ok: false, duplicate: false };
}

function trialMergeBlocksWithSchedule(scheduleBlocks) {
  const merged = new Map();
  (scheduleBlocks || []).forEach(block => {
    const normalized = trialNormalizeBlockFromApi(block);
    if (normalized?.block_id) {
      merged.set(String(normalized.block_id), normalized);
    }
  });
  trialPinnedBlocks.forEach((pinned, blockId) => {
    if (!merged.has(blockId)) {
      merged.set(blockId, pinned);
      return;
    }
    merged.set(blockId, { ...pinned, ...merged.get(blockId) });
    trialPinnedBlocks.delete(blockId);
  });
  return Array.from(merged.values());
}

async function trialCachedGET(cacheKey, ttlMs, url) {
  const now = Date.now();
  const valueKey = cacheKey;
  const expiresKey = `${cacheKey}ExpiresAt`;
  if (trialLoadCache[valueKey] && now < Number(trialLoadCache[expiresKey] || 0)) {
    return trialLoadCache[valueKey];
  }
  const data = await GET(url);
  trialLoadCache[valueKey] = data;
  trialLoadCache[expiresKey] = now + Number(ttlMs || 0);
  return data;
}

function trialApplySchedulePayload(scheduleData, machinesResult, programToolsLookup) {
  const schedule = scheduleData || {};
  const rawMachines = (schedule.machines && schedule.machines.length)
    ? schedule.machines
    : (machinesResult?.machines || []);
  const machines = rawMachines
    .filter(m => m.active !== false)
    .map(m => ({ ...m, machine_code: m.machine_no || m.machine_code }));

  trialState = {
    ...trialState,
    machines,
    blocks: trialMergeBlocksWithSchedule(schedule.blocks || []),
    block_groups: schedule.block_groups || [],
    segments: schedule.segments || [],
    actuals: schedule.actuals || [],
    capacities: schedule.capacities || [],
    profiles: schedule.profiles || [],
    planned: schedule.planned || [],
    planning_cards: schedule.planning_cards || [],
    program_tools_lookup: programToolsLookup ?? trialState.program_tools_lookup ?? null,
  };
  if (typeof trialResetDataIndexes === 'function') trialResetDataIndexes();
  if (typeof trialInvalidateCatalogSearchIndex === 'function') trialInvalidateCatalogSearchIndex();
}

let loadTrialInFlight = null;

const TRIAL_LOAD_STAGES = {
  connect: { label: 'Connecting…', percent: 5, ceiling: 11 },
  shell: { label: 'Laying out machines…', percent: 12, ceiling: 21 },
  shellDone: { percent: 22, ceiling: 27 },
  schedule: { label: 'Loading machine queues…', percent: 28, ceiling: 47 },
  scheduleDone: { percent: 48, ceiling: 51 },
  renderBoard: { label: 'Rendering board…', percent: 52, ceiling: 61 },
  catalog: { label: 'Loading process sheets…', percent: 62, ceiling: 81 },
  catalogDone: { percent: 82, ceiling: 93 },
  finish: { label: 'Finishing…', percent: 94, ceiling: 99 },
  done: { percent: 100, ceiling: 100 },
};

let trialLoadingSim = null;

function trialLoadingStopSim() {
  if (trialLoadingSim?.timer) window.clearInterval(trialLoadingSim.timer);
  trialLoadingSim = null;
}

function trialLoadingPaintBar(percent) {
  const bar = trialLoadingBarEl();
  if (bar) bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
}

function trialLoadingStartSim() {
  trialLoadingStopSim();
  const connect = TRIAL_LOAD_STAGES.connect;
  trialLoadingSim = {
    floor: connect.percent,
    ceiling: connect.ceiling,
    display: connect.percent,
    timer: null,
  };
  trialLoadingPaintBar(connect.percent);
  trialLoadingSim.timer = window.setInterval(() => {
    const sim = trialLoadingSim;
    if (!sim) return;
    if (sim.display >= sim.ceiling - 0.05) return;
    const gap = sim.ceiling - sim.display;
    const step = Math.max(0.06, Math.min(0.45, gap * 0.035));
    sim.display = Math.min(sim.ceiling, sim.display + step);
    trialLoadingPaintBar(sim.display);
  }, 55);
}

function trialLoadingEl() {
  return document.getElementById('trial-loading');
}

function trialLoadingBarEl() {
  return document.getElementById('trial-load-bar');
}

function trialLoadingLabelEl() {
  return document.getElementById('trial-load-label');
}

function trialLoadingReset(options = {}) {
  trialLoadingStopSim();
  const panel = trialLoadingEl();
  if (!panel) return;
  panel.hidden = false;
  panel.classList.remove('trial-load-panel--compact', 'trial-load-panel--error');
  panel.setAttribute('aria-busy', 'true');
  if (options.compact) panel.classList.add('trial-load-panel--compact');
  trialLoadingStage('connect');
  trialLoadingStartSim();
}

function trialLoadingStage(stageKey, overrides = {}) {
  const stage = { ...(TRIAL_LOAD_STAGES[stageKey] || {}), ...overrides };
  const labelEl = trialLoadingLabelEl();
  if (labelEl && stage.label) labelEl.textContent = stage.label;
  if (!Number.isFinite(stage.percent)) return;

  const pct = stage.percent;
  const ceiling = Number.isFinite(stage.ceiling) ? stage.ceiling : pct + 6;

  if (trialLoadingSim) {
    trialLoadingSim.floor = Math.max(trialLoadingSim.floor, pct);
    trialLoadingSim.ceiling = Math.max(trialLoadingSim.ceiling, ceiling);
    trialLoadingSim.display = Math.max(trialLoadingSim.display, trialLoadingSim.floor);
    if (stageKey === 'done') {
      trialLoadingSim.ceiling = 100;
      trialLoadingSim.display = 100;
    }
    trialLoadingPaintBar(trialLoadingSim.display);
    return;
  }
  trialLoadingPaintBar(pct);
}

function trialLoadingCompact() {
  const panel = trialLoadingEl();
  if (!panel || panel.hidden) return;
  panel.classList.add('trial-load-panel--compact');
}

function trialLoadingHide() {
  const panel = trialLoadingEl();
  if (!panel) return;
  trialLoadingStopSim();
  trialLoadingStage('done');
  window.setTimeout(() => {
    panel.hidden = true;
    panel.classList.remove('trial-load-panel--compact', 'trial-load-panel--error');
    panel.removeAttribute('aria-busy');
  }, 180);
}

function trialLoadingError(message) {
  trialLoadingStopSim();
  const panel = trialLoadingEl();
  const labelEl = trialLoadingLabelEl();
  if (!panel) return;
  panel.classList.add('trial-load-panel--error');
  panel.classList.remove('trial-load-panel--compact');
  if (labelEl) labelEl.textContent = message || 'Could not load planner';
  panel.setAttribute('aria-busy', 'false');
}

window.trialLoadingHide = trialLoadingHide;

async function loadTrial(options = {}) {
  if (loadTrialInFlight) {
    return loadTrialInFlight;
  }
  loadTrialInFlight = loadTrialImpl(options).finally(() => {
    loadTrialInFlight = null;
  });
  return loadTrialInFlight;
}

async function loadTrialImpl(options = {}) {
  const perf = (typeof trialPerfStart === 'function')
    ? trialPerfStart('load-trial', {
      force: !!options?.force,
      show_completed: trialShowCompletedFlag(),
    })
    : null;
  const boardAlreadyPainted = Boolean(document.getElementById('trial-grid')?.childElementCount);
  const showLoadUi = !boardAlreadyPainted || !!options.force;
  if (showLoadUi) trialLoadingReset({ compact: boardAlreadyPainted });
  try {
  const resolved = trialNormalizeScheduleDates(trialScheduleDateFilter.start, trialScheduleDateFilter.end);
  trialScheduleDateFilter = resolved;
  if (typeof trialSyncScheduleUrl === 'function') trialSyncScheduleUrl();
  const force = !!options.force;

  const machinistBoard = typeof trialIsMachinistBoard === 'function' && trialIsMachinistBoard();
  const params = new URLSearchParams();
  params.set('lite', '1');
  if (machinistBoard) params.set('include', 'segments');
  if (trialScheduleDateFilter.start) params.set('start', trialScheduleDateFilter.start);
  if (trialScheduleDateFilter.end) params.set('end', trialScheduleDateFilter.end);
  const startParam = params.toString() ? `?${params.toString()}` : '';

  if (force) {
    trialInvalidateCatalogCache();
  }
  const scheduleUrl = (force || machinistBoard)
    ? trialNoCacheUrl(`/api/trial/schedule${startParam}`)
    : `/api/trial/schedule${startParam}`;
  const shellParams = new URLSearchParams(params);
  shellParams.set('shell', '1');
  const shellUrl = (force || machinistBoard)
    ? trialNoCacheUrl(`/api/trial/schedule?${shellParams}`)
    : `/api/trial/schedule?${shellParams}`;
  const skipCatalog = typeof trialIsMachinistBoard === 'function' && trialIsMachinistBoard();
  if (!skipCatalog && typeof trialShowCatalogLoadingPlaceholder === 'function') {
    trialShowCatalogLoadingPlaceholder();
  }

  const catalogCacheMs = trialCatalogClientCacheMs();
  const catalogPromise = skipCatalog
    ? Promise.resolve([])
    : trialCachedGET(trialCatalogCacheKey(), catalogCacheMs, trialCatalogUrl(false)).catch(() => []);

  if (!machinistBoard && !boardAlreadyPainted) {
    if (showLoadUi) trialLoadingStage('shell');
    const shellOutcome = await GET(shellUrl).catch(err => {
      console.error('Failed to load trial schedule shell:', err);
      return { error: err };
    });
    if (!shellOutcome?.error && Array.isArray(shellOutcome?.machines) && shellOutcome.machines.length) {
      trialApplySchedulePayload(shellOutcome, {}, null);
      if (showLoadUi) trialLoadingStage('shellDone');
      trialScheduleRender(null, { skipCatalog: true });
      if (showLoadUi) trialLoadingCompact();
    }
  }

  if (showLoadUi) trialLoadingStage('schedule');
  if (showLoadUi && !skipCatalog) trialLoadingStage('catalog');
  const schedulePromise = GET(scheduleUrl).catch(err => {
    console.error('Failed to load trial schedule:', err);
    return { error: err };
  });
  const [scheduleOutcome, erpVouchers] = await Promise.all([schedulePromise, catalogPromise]);
  if (typeof trialPerfMark === 'function') {
    trialPerfMark(perf, 'fetch-schedule');
  }

  const scheduleError = scheduleOutcome?.error || null;
  const scheduleData = scheduleError ? {} : (scheduleOutcome || {});

  if (scheduleError && !scheduleData.blocks?.length) {
    toast('Could not refresh machine queue: ' + scheduleError.message, 'error');
    if (showLoadUi) {
      trialLoadingError('Could not load machine queues');
      window.setTimeout(() => trialLoadingHide(), 1400);
    }
    return;
  }

  if (showLoadUi) trialLoadingStage('scheduleDone');
  trialApplySchedulePayload(scheduleData, {}, null);
  if (typeof trialSyncRecalcBaseline === 'function') trialSyncRecalcBaseline();
  if (typeof trialPerfMark === 'function') {
    trialPerfMark(perf, 'apply-schedule-payload', {
      machines: Array.isArray(trialState.machines) ? trialState.machines.length : 0,
      blocks: Array.isArray(trialState.blocks) ? trialState.blocks.length : 0,
    });
  }
  if (showLoadUi) trialLoadingStage('renderBoard');
  trialScheduleRender(null, { skipCatalog: true });
  if (showLoadUi) trialLoadingCompact();

  if (skipCatalog) {
    if (showLoadUi) trialLoadingHide();
    if (typeof trialPerfEnd === 'function') {
      trialPerfEnd(perf, { schedule_error: Boolean(scheduleError), skip_catalog: true });
    }
    return;
  }

  if (typeof trialPerfMark === 'function') {
    trialPerfMark(perf, 'fetch-catalog');
  }

  const cacheKey = trialCatalogCacheKey();
  trialLoadCache[cacheKey] = Array.isArray(erpVouchers) ? erpVouchers : [];
  trialLoadCache[`${cacheKey}ExpiresAt`] = Date.now() + catalogCacheMs;
  trialAssignCatalogRows(trialLoadCache[cacheKey]);
  if (typeof trialMaterialInOverrides !== 'undefined') trialMaterialInOverrides.clear();
  if (typeof trialBoardTempPsIdsMissingFromCatalog === 'function'
    && trialBoardTempPsIdsMissingFromCatalog().length) {
    trialInvalidateCatalogCache();
    if (typeof trialScheduleMissingTempCatalogRefresh === 'function') {
      trialScheduleMissingTempCatalogRefresh();
    }
  }
  if (showLoadUi) {
    trialLoadingStage('catalogDone');
    trialLoadingStage('finish');
  }
  trialScheduleRender(null, {
    deferCatalog: true,
    skipFilterShell: true,
    preserveScroll: true,
    dismissLoading: showLoadUi,
  });

  trialCachedGET('programToolsLookup', 300000, '/api/program-tool-list/lookup')
    .then(programToolsLookup => {
      if (!programToolsLookup) return;
      trialState.program_tools_lookup = programToolsLookup;
      if (typeof renderTrialCatalog === 'function') renderTrialCatalog();
    })
    .catch(() => {});

  if (typeof trialPerfMark === 'function') {
    trialPerfMark(perf, 'schedule-render-dispatch');
  }
  if (typeof trialPerfEnd === 'function') {
    trialPerfEnd(perf, {
      schedule_error: Boolean(scheduleError),
    });
  }
  } catch (err) {
    console.error('loadTrial failed:', err);
    toast('Could not load planner: ' + (err?.message || err), 'error');
    if (showLoadUi) {
      trialLoadingError('Could not load planner');
      window.setTimeout(() => trialLoadingHide(), 1400);
    }
    trialScheduleRender();
  }
}

function trialScheduleRender(machineIds = null, options = {}) {
  if (typeof window.trialScheduleRenderHook === 'function') {
    window.trialScheduleRenderHook(machineIds, options);
    return;
  }
  if (machineIds && typeof renderTrialMachines === 'function') {
    renderTrialMachines(machineIds, options);
    return;
  }
  if (typeof renderTrial === 'function') renderTrial(options);
}

// Lightweight refresh for a subset of machines after a mutation.
// Replaces loadTrial() for block create/update/delete/reorder/actuals.
// Falls back to loadTrial() on error.
let refreshMachinesQueue = Promise.resolve();

async function refreshMachinesImpl(machineIds, options = {}) {
  const perf = (typeof trialPerfStart === 'function')
    ? trialPerfStart('refresh-machines', {
      requested: (machineIds || []).length,
    })
    : null;
  const ids = [...new Set((machineIds || []).map(Number).filter(Boolean))];
  if (!ids.length) { trialScheduleRender(); return; }

  if (options.response && trialApplyMachineRefreshFromResponse(ids, options.response)) {
    if (typeof trialPerfEnd === 'function') {
      trialPerfEnd(perf, { source: 'mutation-payload' });
    }
    return;
  }

  const params = new URLSearchParams({
    machine_ids: ids.join(','),
    lite: '1',
    include: 'blocks',
  });
  const data = await GET(trialNoCacheUrl(`/api/trial/schedule?${params}`)).catch(err => {
    console.error('refreshMachines failed, falling back to full reload:', err);
    return null;
  });
  if (typeof trialPerfMark === 'function') {
    trialPerfMark(perf, 'fetch-machine-slice', { ids: ids.join(',') });
  }
  if (!data) { await loadTrial(); return; }

  trialApplyMachineRefreshPayload(ids, data);
  trialScheduleRender(ids, {
    deferCatalog: true,
    skipFilterShell: true,
    preserveScroll: true,
  });
  if (typeof trialPerfMark === 'function') {
    trialPerfMark(perf, 'merge-and-render');
  }
  if (typeof trialPerfEnd === 'function') {
    trialPerfEnd(perf, {
      refreshed_blocks: Array.isArray(data.blocks) ? data.blocks.length : 0,
      refreshed_segments: Array.isArray(data.segments) ? data.segments.length : 0,
      refreshed_actuals: Array.isArray(data.actuals) ? data.actuals.length : 0,
    });
  }
}

async function refreshMachines(machineIds, options = {}) {
  const job = () => refreshMachinesImpl(machineIds, options);
  const result = refreshMachinesQueue.then(job, job);
  refreshMachinesQueue = result.catch(() => {});
  return result;
}
