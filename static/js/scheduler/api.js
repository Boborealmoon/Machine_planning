// HTTP helpers and the main data-load function.

async function GET(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 120000);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
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

function trialCardOrderedBlockIds(card) {
  const grouped = String(card?.dataset?.blockIds || '')
    .split(/[\s,]+/)
    .map(Number)
    .filter(Boolean);
  if (grouped.length) return grouped;
  const one = Number(card?.dataset?.blockId || 0);
  return one ? [one] : [];
}

function trialMergeLaneOrder(existingIds, visibleOrderedIds) {
  const visible = (visibleOrderedIds || []).map(Number).filter(Boolean);
  const existing = (existingIds || []).map(Number).filter(Boolean);
  if (!visible.length) return existing;
  if (!existing.length) return visible;
  const visibleSet = new Set(visible);
  const merged = [];
  let next = 0;
  existing.forEach(id => {
    if (visibleSet.has(id)) {
      if (next < visible.length) merged.push(visible[next++]);
      return;
    }
    merged.push(id);
  });
  while (next < visible.length) merged.push(visible[next++]);
  const seen = new Set();
  return merged.filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function trialLaneOrderFromElement(laneEl) {
  if (!laneEl) return null;
  const machineId = Number(laneEl.dataset.machineId || 0);
  const visibleIds = [];
  Array.from(
    laneEl.querySelectorAll(':scope > .trial-block-card[data-block-id], :scope > .trial-queue-row[data-block-id]')
  ).forEach(card => {
    if (card.classList.contains('trial-drag-ghost')) return;
    trialCardOrderedBlockIds(card).forEach(id => {
      if (!visibleIds.includes(id)) visibleIds.push(id);
    });
  });
  if (!machineId || !visibleIds.length) return null;
  const existing = typeof trialMachineBlockOrder === 'function'
    ? trialMachineBlockOrder(machineId)
    : [];
  return {
    machine_id: machineId,
    ordered_ids: trialMergeLaneOrder(existing, visibleIds),
  };
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
  const blocks = typeof trialBlocksForMachine === 'function'
    ? trialBlocksForMachine(mid)
    : (trialState.blocks || []).filter(block =>
      Number(block.machine_id) === mid && block.active !== false
    );
  return blocks
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

function trialAfterQueueMutation(machineIds, result, options = {}) {
  const ids = [...new Set((machineIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return;
  if (result?.recalculated || result?.tail_recalculated) {
    trialClearDirtyMachines(ids);
    return;
  }
  trialMarkDirtyMachines(ids, options);
}

function trialApplyLocalLaneOrders(lanes) {
  (lanes || []).forEach(lane => {
    const machineId = Number(lane.machine_id || 0);
    const orderedIds = (lane.ordered_ids || []).map(Number).filter(Boolean);
    if (!machineId || !orderedIds.length) return;
    const posById = new Map(orderedIds.map((id, idx) => [id, idx + 1]));
    (trialState.blocks || []).forEach(block => {
      const pos = posById.get(Number(block.block_id || 0));
      if (pos == null) return;
      block.queue_position = pos;
      block.machine_id = machineId;
    });
  });
  if (typeof trialResetDataIndexes === 'function') trialResetDataIndexes();
}

function trialRenumberOpenQueuePanel() {
  const list = document.querySelector('.trial-queue-panel-list');
  if (!list) return;
  list.querySelectorAll(':scope > .trial-queue-row .trial-queue-seq').forEach((el, idx) => {
    el.textContent = `#${idx + 1}`;
  });
}

let trialQueueReorderChain = Promise.resolve();
let trialQueueReorderPendingLanes = null;

function trialCommitLocalQueueReorder(lanes, options = {}) {
  const normalized = (lanes || [])
    .map(lane => ({
      machine_id: Number(lane.machine_id || 0),
      ordered_ids: (lane.ordered_ids || []).map(Number).filter(Boolean),
    }))
    .filter(lane => lane.machine_id && lane.ordered_ids.length);
  if (!normalized.length) return [];
  trialApplyLocalLaneOrders(normalized);
  const affected = [...new Set(normalized.map(lane => lane.machine_id))];
  const queueOrders = {};
  normalized.forEach(lane => {
    queueOrders[lane.machine_id] = lane.ordered_ids;
  });
  const paint = () => {
    trialRenumberOpenQueuePanel();
    trialMarkDirtyMachines(affected, { queueOrders });
    if (options.render === true && typeof renderTrialMachines === 'function') {
      renderTrialMachines(affected, {
        skipQueueReopen: true,
        skipCatalog: true,
        deferCatalog: true,
      });
    }
  };
  if (options.immediate) paint();
  else window.setTimeout(paint, 180);
  return normalized;
}

function trialPersistQueueReorder(lanes) {
  trialQueueReorderPendingLanes = lanes;
  const run = async () => {
    while (trialQueueReorderPendingLanes) {
      const current = trialQueueReorderPendingLanes;
      trialQueueReorderPendingLanes = null;
      try {
        const result = await postTrialQueueReorder(current, { recalculate: false });
        const affected = [...new Set(current.map(lane => Number(lane.machine_id)).filter(Boolean))];
        const queueOrders = {};
        current.forEach(lane => {
          queueOrders[Number(lane.machine_id)] = lane.ordered_ids;
        });
        trialAfterQueueMutation(affected, result, { queueOrders });
      } catch (err) {
        trialQueueReorderPendingLanes = null;
        throw err;
      }
    }
  };
  const job = trialQueueReorderChain.then(run, run);
  trialQueueReorderChain = job.catch(() => {});
  return job;
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

function trialNormalizeTempPsKey(psId) {
  return String(psId || '').trim().replace(/^\[Temp\]\s*/i, '').trim();
}

function trialCatalogRowMatchesTempId(row, plannerPsId) {
  const needle = trialNormalizeTempPsKey(plannerPsId);
  if (!needle) return false;
  const rowId = String(row?.ps_id || '').trim();
  if (!rowId.startsWith('[Temp]')) return false;
  return trialNormalizeTempPsKey(rowId) === needle || rowId === String(plannerPsId || '').trim();
}

/** Drop a deleted [Temp] PS from in-memory catalog/planned rows and client cache. */
function trialPurgeCatalogTempPs(plannerPsId) {
  const canonical = String(plannerPsId || '').trim();
  if (!canonical) return;
  const keep = row => !trialCatalogRowMatchesTempId(row, canonical);
  if (Array.isArray(trialState?.catalog)) {
    trialState.catalog = trialState.catalog.filter(keep);
  }
  if (Array.isArray(trialState?.planned)) {
    trialState.planned = trialState.planned.filter(keep);
  }
  ['catalog', 'catalogAll'].forEach(key => {
    if (!Array.isArray(trialLoadCache?.[key])) return;
    trialLoadCache[key] = trialLoadCache[key].filter(keep);
  });
  const tempKey = trialNormalizeTempPsKey(canonical);
  if (Array.isArray(trialState?.blocks) && tempKey) {
    trialState.blocks = trialState.blocks.filter(block => {
      const blockPs = String(block.planner_ps_id || block.source_ps_id || block.job_no || '').trim();
      if (!blockPs.startsWith('[Temp]')) return true;
      return trialNormalizeTempPsKey(blockPs) !== tempKey;
    });
  }
  trialInvalidateCatalogCache();
  if (typeof trialResetDataIndexes === 'function') trialResetDataIndexes();
  if (typeof trialResetRenderIndexes === 'function') trialResetRenderIndexes();
}

async function trialRefreshCatalogAfterTempPsDeleted(event) {
  if (!document.getElementById('trial-catalog')) return;
  const detail = event?.detail || {};
  const psId = String(detail.planner_ps_id || detail.ps_id || '').trim();
  if (psId && typeof trialPurgeCatalogTempPs === 'function') {
    trialPurgeCatalogTempPs(psId);
  }
  if (typeof trialRerenderCatalogFromBlocks === 'function') {
    trialRerenderCatalogFromBlocks();
  }
  if (typeof loadTrial === 'function' && document.getElementById('trial-grid')) {
    try {
      await loadTrial({ force: true });
      return;
    } catch (err) {
      console.error('board refresh after temp PS delete failed:', err);
    }
  }
  if (typeof trialRefreshCatalogSidebar === 'function') {
    try {
      await trialRefreshCatalogSidebar();
    } catch (err) {
      console.error('catalog refresh after temp PS delete failed:', err);
    }
  }
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
  if (typeof trialCancelDeferredCatalogRender === 'function') trialCancelDeferredCatalogRender();
  if (typeof renderTrialCatalog === 'function') renderTrialCatalog();
  if (typeof bindTrialCatalogDnD === 'function') bindTrialCatalogDnD();
}

/** Reload PS/Ops sidebar after queue mutations (split, delete, schedule). */
async function trialRefreshCatalogSidebar() {
  trialInvalidateCatalogCache();
  try {
    const erpVouchers = await GET(trialNoCacheUrl(trialCatalogUrl(true)));
    const cacheKey = trialCatalogCacheKey();
    trialLoadCache[cacheKey] = Array.isArray(erpVouchers) ? erpVouchers : [];
    trialLoadCache[`${cacheKey}ExpiresAt`] = Date.now() + trialCatalogClientCacheMs();
    trialAssignCatalogRows(trialLoadCache[cacheKey]);
    if (typeof trialMaterialInOverrides !== 'undefined') trialMaterialInOverrides.clear();
    if (typeof trialToolingOverrides !== 'undefined') trialToolingOverrides.clear();
    if (typeof trialProgramOverrides !== 'undefined') trialProgramOverrides.clear();
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
  if (typeof loadTrial === 'function' && document.getElementById('trial-grid')) {
    loadTrial({ force: true }).catch(err => {
      console.error('board refresh after ERP sync failed:', err);
    });
    return;
  }
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

window.addEventListener('temp-ps-deleted', event => {
  trialRefreshCatalogAfterTempPsDeleted(event).catch(err => {
    console.error('catalog refresh after temp PS delete failed:', err);
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
  if (typeof trialIsMainPlannerLaneBlock === 'function' && !trialIsMainPlannerLaneBlock(normalized)) return;
  const blocks = Array.isArray(trialState.blocks) ? [...trialState.blocks] : [];
  const idx = blocks.findIndex(b => String(b.block_id) === String(normalized.block_id));
  if (idx >= 0) blocks[idx] = { ...blocks[idx], ...normalized };
  else blocks.push(normalized);
  trialState.blocks = blocks;
  if (typeof trialResetDataIndexes === 'function') trialResetDataIndexes();
}

/** Drop deleted queue blocks from in-memory state (sidebar remove has no lane row to update). */
function trialPurgeBlocksFromState(blockIds, options = {}) {
  const idSet = new Set(
    (blockIds || []).map(id => String(Number(id))).filter(id => id !== '0' && id !== 'NaN'),
  );
  const groupId = Number(options.groupId || 0);
  if (!idSet.size && !(groupId > 0)) return;
  if (!Array.isArray(trialState?.blocks)) return;
  trialState.blocks = trialState.blocks.filter(block => {
    if (idSet.has(String(block.block_id))) return false;
    if (groupId > 0 && Number(block.group_id || 0) === groupId) return false;
    return true;
  });
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
  if (!payload || payload.error || !Array.isArray(payload.blocks)) return false;
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

function trialApplyMachineRefreshFromResponse(machineIds, response, options = {}) {
  if (response?.block) {
    if (typeof trialPinBlock === 'function') trialPinBlock(response.block);
    trialMergeBlockFromApi(response.block);
  }
  const applied = trialApplyMachineRefreshPayload(machineIds, response?.machine_refresh)
    || Boolean(response?.block);
  if (!applied) return false;
  trialScheduleRender(machineIds, {
    deferCatalog: true,
    skipQueueReopen: Boolean(options.skipQueueReopen),
  });
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

/** Fill missing cycle/setup from master before queue POST (sub-assembly cards often cache 0). */
async function trialResolveQueueCycleTimes(body, catalogCard) {
  const payload = { ...(body || {}) };
  if (Number(payload.cycle_minutes_per_qty || 0) > 0) return payload;
  const partNo = String(
    payload.part_no || catalogCard?.part_no || catalogCard?.part_name || catalogCard?.inventory_code || '',
  ).trim();
  if (!partNo || typeof GET !== 'function') return payload;
  try {
    const q = new URLSearchParams({
      part_no: partNo,
      bom_code: String(
        payload.bom_code || catalogCard?.selected_bom_code || catalogCard?.erp_bom_code || '',
      ).trim(),
      op_no: String(payload.source_op_no || catalogCard?.source_op_no || '').trim(),
      op_type: String(payload.operation_name || catalogCard?.op_type || '').trim(),
      inventory_code: String(payload.inventory_code || catalogCard?.inventory_code || '').trim(),
      part_desc: String(catalogCard?.part_desc || '').trim(),
      erp_bom_code: String(payload.erp_bom_code || catalogCard?.erp_bom_code || '').trim(),
      fallback_cycle: String(payload.cycle_minutes_per_qty || 0),
      fallback_setup: String(payload.setup_minutes || 0),
    });
    const resolved = await GET(`/api/trial/cycle-times/resolve?${q.toString()}`);
    if (resolved?.source === 'master' && Number(resolved.cycle_time || 0) > 0) {
      payload.cycle_minutes_per_qty = Number(resolved.cycle_time);
      if (Number(resolved.set_up_time || 0) > 0) {
        payload.setup_minutes = Number(resolved.set_up_time);
      }
    }
  } catch (err) {
    console.warn('queue cycle-time resolve failed:', err);
  }
  return payload;
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
  payload = await trialResolveQueueCycleTimes(payload, resolve?.catalogCard || catalogCard);
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
    ...payload,
    pp_partial_no: want,
    job_no: typeof trialFormatPlannerPsId === 'function'
      ? trialFormatPlannerPsId(
        typeof trialCatalogSourceBase === 'function'
          ? trialCatalogSourceBase(resolve?.catalogCard || catalogCard || body)
          : '',
        want,
      )
      : payload.job_no,
    source_ps_id: typeof trialFormatPlannerPsId === 'function'
      ? trialFormatPlannerPsId(
        typeof trialCatalogSourceBase === 'function'
          ? trialCatalogSourceBase(resolve?.catalogCard || catalogCard || body)
          : '',
        want,
      )
      : payload.source_ps_id,
  });
  if (Number(payload.cycle_minutes_per_qty || 0) <= 0) {
    payload = await trialResolveQueueCycleTimes(payload, resolve?.catalogCard || catalogCard);
  }
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
  trialAfterQueueMutation(affectedIds, result, {
    skipRender: true,
    queueOrders,
    tailFromBlockId: result?.block?.block_id,
  });
  if (typeof trialRerenderCatalogFromBlocks === 'function') {
    trialRerenderCatalogFromBlocks();
  }
  if (typeof trialScheduleRender === 'function') {
    trialScheduleRender(affectedIds, { deferCatalog: true, preserveScroll: true });
  }
  const machine = (trialState.machines || []).find(row => Number(row.machine_id) === numericMachineId);
  const label = machine?.machine_code || `Machine ${numericMachineId}`;
  const savedOnMachine = Boolean(
    result?.ok
    && resultBlock
    && Number(resultBlock.machine_id) === numericMachineId,
  );
  if (!savedOnMachine) {
    toast(`Could not queue on ${label}. Try again.`, 'error');
    return { ok: false, duplicate: false };
  }
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
    `Queued on ${label} — hidden by the date filter. Clear dates to see it on the lane.`,
    'info',
  );
  return { ok: true, duplicate: false, hiddenByDateFilter: true };
}

function trialMergeBlocksWithSchedule(scheduleBlocks) {
  const merged = new Map();
  (scheduleBlocks || []).forEach(block => {
    const normalized = trialNormalizeBlockFromApi(block);
    if (!normalized?.block_id) return;
    if (typeof trialIsMainPlannerLaneBlock === 'function' && !trialIsMainPlannerLaneBlock(normalized)) return;
    merged.set(String(normalized.block_id), normalized);
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

function trialApplyCatalogPayload(erpVouchers, renderOptions = {}) {
  const catalogCacheMs = trialCatalogClientCacheMs();
  const cacheKey = trialCatalogCacheKey();
  trialLoadCache[cacheKey] = Array.isArray(erpVouchers) ? erpVouchers : [];
  trialLoadCache[`${cacheKey}ExpiresAt`] = Date.now() + catalogCacheMs;
  trialAssignCatalogRows(trialLoadCache[cacheKey]);
  if (typeof trialMaterialInOverrides !== 'undefined') trialMaterialInOverrides.clear();
  if (typeof trialToolingOverrides !== 'undefined') trialToolingOverrides.clear();
  if (typeof trialProgramOverrides !== 'undefined') trialProgramOverrides.clear();
  if (typeof trialBoardTempPsIdsMissingFromCatalog === 'function'
    && trialBoardTempPsIdsMissingFromCatalog().length) {
    trialInvalidateCatalogCache();
    if (typeof trialScheduleMissingTempCatalogRefresh === 'function') {
      trialScheduleMissingTempCatalogRefresh();
    }
    return;
  }
  trialScheduleRender(null, {
    deferCatalog: true,
    skipFilterShell: true,
    preserveScroll: true,
    ...renderOptions,
  });
}

function trialApplySchedulePayload(scheduleData, machinesResult, programToolsLookup) {
  const schedule = scheduleData || {};
  const rawMachines = (schedule.machines && schedule.machines.length)
    ? schedule.machines
    : (machinesResult?.machines || []);
  const machines = rawMachines
    .filter(m => m.active !== false)
    .map(m => ({ ...m, machine_code: m.machine_no || m.machine_code }));

  // Apply machines before merging blocks — trialIsMainPlannerLaneBlock reads trialState.machines
  // and leftover MPP_CYCLE rows must stay excluded from the indicated-plan lanes.
  trialState = {
    ...trialState,
    machines,
    block_groups: schedule.block_groups || [],
    segments: schedule.segments || [],
    actuals: schedule.actuals || [],
    capacities: schedule.capacities || [],
    profiles: schedule.profiles || [],
    planned: schedule.planned || [],
    planning_cards: schedule.planning_cards || [],
    program_tools_lookup: programToolsLookup ?? trialState.program_tools_lookup ?? null,
  };
  trialState.blocks = trialMergeBlocksWithSchedule(schedule.blocks || []);
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

function trialYieldForPaint() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
      return;
    }
    window.setTimeout(resolve, 0);
  });
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
  const loadCatalog = () => skipCatalog
    ? Promise.resolve([])
    : (force
      ? GET(trialNoCacheUrl(trialCatalogUrl(true))).catch(() => [])
      : trialCachedGET(trialCatalogCacheKey(), catalogCacheMs, trialCatalogUrl(false)).catch(() => []));

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
  const scheduleOutcome = await GET(scheduleUrl).catch(err => {
    console.error('Failed to load trial schedule:', err);
    return { error: err };
  });
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
  if (showLoadUi) await trialYieldForPaint();
  trialScheduleRender(null, {
    skipCatalog: true,
    dismissLoading: showLoadUi,
  });
  if (showLoadUi) trialLoadingCompact();

  trialCachedGET('programToolsLookup', 300000, '/api/program-tool-list/lookup')
    .then(programToolsLookup => {
      if (!programToolsLookup) return;
      trialState.program_tools_lookup = programToolsLookup;
      if (typeof renderTrialCatalog === 'function') renderTrialCatalog();
    })
    .catch(() => {});

  if (skipCatalog) {
    if (typeof trialPerfEnd === 'function') {
      trialPerfEnd(perf, { schedule_error: Boolean(scheduleError), skip_catalog: true });
    }
    return;
  }

  const applyCatalogWhenReady = erpVouchers => {
    if (typeof trialPerfMark === 'function') {
      trialPerfMark(perf, 'fetch-catalog');
    }
    trialApplyCatalogPayload(erpVouchers);
    if (typeof trialPerfEnd === 'function') {
      trialPerfEnd(perf, {
        schedule_error: Boolean(scheduleError),
        catalog_rows: Array.isArray(erpVouchers) ? erpVouchers.length : 0,
      });
    }
  };

  loadCatalog()
    .then(applyCatalogWhenReady)
    .catch(err => {
      console.error('Failed to load process sheet catalog:', err);
      toast('Could not load PS / Ops sidebar: ' + (err?.message || err), 'error');
      if (typeof renderTrialCatalog === 'function') renderTrialCatalog();
      if (typeof trialPerfEnd === 'function') {
        trialPerfEnd(perf, { schedule_error: Boolean(scheduleError), catalog_error: true });
      }
    });

  if (typeof trialPerfMark === 'function') {
    trialPerfMark(perf, 'schedule-render-dispatch');
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

  if (options.response && trialApplyMachineRefreshFromResponse(ids, options.response, options)) {
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
