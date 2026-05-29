// HTTP helpers and the main data-load function.

async function GET(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
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
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
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

async function syncPpVouchers() {
  try {
    await (window.syncErpPpVouchers ? window.syncErpPpVouchers() : POST('/api/pp-vouchers/sync', {}));
    trialInvalidateCatalogCache();
    const erpVouchers = await GET(trialCatalogUrl(true));
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
  GET(trialCatalogUrl(true))
    .then(erpVouchers => {
      const cacheKey = trialCatalogCacheKey();
      trialLoadCache[cacheKey] = Array.isArray(erpVouchers) ? erpVouchers : [];
      trialLoadCache[`${cacheKey}ExpiresAt`] = Date.now() + 60000;
      trialState.catalog = trialLoadCache[cacheKey];
      trialScheduleRender();
    })
    .catch(err => console.error('catalog refresh after ERP sync failed:', err));
});

async function syncTrialQueueState() {
  const queueStates = await GET('/api/trial/queue-state').catch(() => []);
  if (!Array.isArray(queueStates) || !queueStates.length) return;

  const stateByBlockId = new Map(queueStates.map(qs => [String(qs.block_id), qs]));
  let changed = false;

  (trialState.blocks || []).forEach(block => {
    const qs = stateByBlockId.get(String(block.block_id));
    if (!qs) return;
    if (qs.execution_status) block.execution_status = qs.execution_status;
    if (qs.schedule_status) block.planning_status = qs.schedule_status;
    if (qs.predicted_start_at) {
      block.calculated_start_datetime = qs.predicted_start_at;
      block.visual_start_datetime = qs.predicted_start_at;
    }
    if (qs.predicted_end_at) {
      block.calculated_end_datetime = qs.predicted_end_at;
      block.visual_end_datetime = qs.predicted_end_at;
    }
    changed = true;
  });

  if (changed) trialScheduleRender();
}

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
}

function trialPinBlock(block, ttlMs = 30000) {
  const normalized = trialNormalizeBlockFromApi(block);
  if (!normalized || !normalized.block_id) return;
  const blockId = String(normalized.block_id);
  trialPinnedBlocks.set(blockId, normalized);
  window.setTimeout(() => trialPinnedBlocks.delete(blockId), ttlMs);
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
}

async function loadTrial(options = {}) {
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
    trialLoadCache.machines = null;
    trialLoadCache.machinesExpiresAt = 0;
  }

  const [scheduleOutcome, erpVouchers, machinesResult, programToolsLookup] = await Promise.all([
    GET(`/api/trial/schedule${startParam}`).catch(err => {
      console.error('Failed to load trial schedule:', err);
      return { error: err };
    }),
    trialCachedGET(trialCatalogCacheKey(), 60000, trialCatalogUrl()).catch(() => []),
    trialCachedGET('machines', 300000, '/api/planner/machines').catch(() => ({ machines: [] })),
    GET('/api/program-tool-list/lookup').catch(() => null),
  ]);

  const scheduleError = scheduleOutcome?.error || null;
  const scheduleData = scheduleError ? {} : (scheduleOutcome || {});

  if (scheduleError && !scheduleData.blocks?.length) {
    toast('Could not refresh machine queue: ' + scheduleError.message, 'error');
  }

  const machinesPayload = (!scheduleData.machines?.length && machinesResult?.machines?.length)
    ? machinesResult
    : { machines: [] };

  trialApplySchedulePayload(
    scheduleData,
    machinesPayload,
    programToolsLookup,
  );
  trialState.catalog = Array.isArray(erpVouchers) ? erpVouchers : [];
  trialScheduleRender();
}

function trialScheduleRender() {
  if (typeof window.trialScheduleRenderHook === 'function') {
    window.trialScheduleRenderHook();
    return;
  }
  if (typeof renderTrial === 'function') renderTrial();
}

// Lightweight refresh for a subset of machines after a mutation.
// Replaces loadTrial() for block create/update/delete/reorder/actuals.
// Falls back to loadTrial() on error.
async function refreshMachines(machineIds) {
  const ids = [...new Set((machineIds || []).map(Number).filter(Boolean))];
  if (!ids.length) { trialScheduleRender(); return; }

  const params = new URLSearchParams({ machine_ids: ids.join(','), lite: '1' });
  const data = await GET(`/api/trial/schedule?${params}`).catch(err => {
    console.error('refreshMachines failed, falling back to full reload:', err);
    return null;
  });
  if (!data) { await loadTrial(); return; }

  const machineSet = new Set(ids.map(String));

  // Replace blocks and segments for the affected machines only (keep pinned / just-created blocks)
  const keptBlocks = (trialState.blocks || []).filter(b => !machineSet.has(String(b.machine_id)));
  const refreshedBlocks = trialMergeBlocksWithSchedule(data.blocks || []);
  trialState.blocks = [...keptBlocks, ...refreshedBlocks];

  if (Array.isArray(data.block_groups) && data.block_groups.length) {
    const refreshedGroupIds = new Set(
      data.block_groups.map(g => String(g.group_id || 0)).filter(id => id !== '0')
    );
    trialState.block_groups = [
      ...(trialState.block_groups || []).filter(g => {
        const onMachine = machineSet.has(String(g.machine_id || 0));
        const groupId = String(g.group_id || 0);
        return !(onMachine || refreshedGroupIds.has(groupId));
      }),
      ...data.block_groups,
    ];
  }
  trialState.segments = [
    ...(trialState.segments || []).filter(s => !machineSet.has(String(s.machine_id))),
    ...(data.segments || []),
  ];

  // Merge actuals for the affected block ids
  if ((data.actuals || []).length > 0) {
    const affectedBlockIds = new Set(
      (trialState.blocks || [])
        .filter(b => machineSet.has(String(b.machine_id)))
        .map(b => String(b.block_id))
    );
    trialState.actuals = [
      ...(trialState.actuals || []).filter(a => !affectedBlockIds.has(String(a.block_id))),
      ...(data.actuals || []),
    ];
  }

  trialScheduleRender();
}
