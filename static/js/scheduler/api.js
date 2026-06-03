// HTTP helpers and the main data-load function.

async function GET(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
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

function trialMarkDirtyMachines(machineIds, options = {}) {
  (machineIds || []).forEach(id => {
    const numeric = Number(id || 0);
    if (numeric) trialDirtyMachineIds.add(numeric);
  });
  trialUpdateStaleScheduleUi(options);
}

function trialClearDirtyMachines(machineIds) {
  if (machineIds == null) {
    trialDirtyMachineIds.clear();
  } else {
    (machineIds || []).forEach(id => trialDirtyMachineIds.delete(Number(id || 0)));
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
  if (!options.skipRender && typeof trialScheduleRender === 'function') {
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
  return POST('/api/trial/queue/recalculate', { machine_ids: ids });
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

function trialCatalogUrl(refresh = false) {
  const params = new URLSearchParams();
  if (trialShowCompleted) params.set('show_completed', '1');
  if (refresh) params.set('refresh', '1');
  const qs = params.toString();
  return `/api/pp-vouchers/with-ops${qs ? `?${qs}` : ''}`;
}

function trialCatalogCacheKey() {
  return trialShowCompleted ? 'catalogAll' : 'catalog';
}

function trialInvalidateCatalogCache() {
  ['catalog', 'catalogAll'].forEach(key => {
    trialLoadCache[key] = null;
    trialLoadCache[`${key}ExpiresAt`] = 0;
  });
}

/** Reload PS/Ops sidebar after queue mutations (split, delete, schedule). */
async function trialRefreshCatalogSidebar() {
  trialInvalidateCatalogCache();
  try {
    const erpVouchers = await GET(trialNoCacheUrl(trialCatalogUrl(true)));
    const cacheKey = trialCatalogCacheKey();
    trialLoadCache[cacheKey] = Array.isArray(erpVouchers) ? erpVouchers : [];
    trialLoadCache[`${cacheKey}ExpiresAt`] = Date.now() + 10000;
    trialState.catalog = trialLoadCache[cacheKey];
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
    trialState.catalog = trialLoadCache[cacheKey];
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
      trialState.catalog = trialLoadCache[cacheKey];
      trialScheduleRender();
    })
    .catch(err => console.error('catalog refresh after ERP sync failed:', err));
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
  if (!trialApplyMachineRefreshPayload(machineIds, response?.machine_refresh)) return false;
  trialScheduleRender(machineIds, { deferCatalog: true });
  return true;
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
}

async function loadTrial(options = {}) {
  const perf = (typeof trialPerfStart === 'function')
    ? trialPerfStart('load-trial', {
      force: !!options?.force,
      show_completed: !!trialShowCompleted,
    })
    : null;
  try {
  const resolved = trialNormalizeScheduleDates(trialScheduleDateFilter.start, trialScheduleDateFilter.end);
  trialScheduleDateFilter = resolved;
  trialSyncScheduleUrl();
  const force = !!options.force;

  const params = new URLSearchParams();
  params.set('lite', '1');
  if (trialScheduleDateFilter.start) params.set('start', trialScheduleDateFilter.start);
  if (trialScheduleDateFilter.end) params.set('end', trialScheduleDateFilter.end);
  const startParam = params.toString() ? `?${params.toString()}` : '';

  if (force) {
    trialInvalidateCatalogCache();
  }

  const scheduleUrl = force
    ? trialNoCacheUrl(`/api/trial/schedule${startParam}`)
    : `/api/trial/schedule${startParam}`;
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
  }

  trialApplySchedulePayload(scheduleData, {}, null);
  if (typeof trialPerfMark === 'function') {
    trialPerfMark(perf, 'apply-schedule-payload', {
      machines: Array.isArray(trialState.machines) ? trialState.machines.length : 0,
      blocks: Array.isArray(trialState.blocks) ? trialState.blocks.length : 0,
    });
  }
  trialScheduleRender(null, { skipCatalog: true });

  const catalogFetch = force
    ? GET(trialNoCacheUrl(trialCatalogUrl(true))).catch(() => [])
    : trialCachedGET(trialCatalogCacheKey(), 60000, trialCatalogUrl(false)).catch(() => []);
  const [erpVouchers, programToolsLookup] = await Promise.all([
    catalogFetch,
    trialCachedGET('programToolsLookup', 300000, '/api/program-tool-list/lookup').catch(() => null),
  ]);
  if (typeof trialPerfMark === 'function') {
    trialPerfMark(perf, 'fetch-secondary');
  }

  trialApplySchedulePayload(scheduleData, {}, programToolsLookup);
  const cacheKey = trialCatalogCacheKey();
  trialLoadCache[cacheKey] = Array.isArray(erpVouchers) ? erpVouchers : [];
  trialLoadCache[`${cacheKey}ExpiresAt`] = Date.now() + 10000;
  trialState.catalog = trialLoadCache[cacheKey];
  trialScheduleRender(null, { deferCatalog: true });
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
  trialScheduleRender(ids, { deferCatalog: true });
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
