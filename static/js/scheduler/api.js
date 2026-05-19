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

async function syncPpVouchers() {
  try {
    await (window.syncErpPpVouchers ? window.syncErpPpVouchers() : POST('/api/pp-vouchers/sync', {}));
    trialLoadCache.catalog = null;
    trialLoadCache.catalogExpiresAt = 0;
    const erpVouchers = await GET('/api/pp-vouchers/with-ops?refresh=1');
    trialLoadCache.catalog = Array.isArray(erpVouchers) ? erpVouchers : [];
    trialLoadCache.catalogExpiresAt = Date.now() + 30000;
    trialState.catalog = Array.isArray(erpVouchers) ? erpVouchers : [];
    renderTrialCatalog();
  } catch (err) {
    console.error('pp-vouchers sync failed:', err);
  }
}

window.addEventListener('pp-vouchers-synced', () => {
  if (typeof renderTrialCatalog !== 'function') return;
  trialLoadCache.catalog = null;
  trialLoadCache.catalogExpiresAt = 0;
  GET('/api/pp-vouchers/with-ops?refresh=1')
    .then(erpVouchers => {
      trialLoadCache.catalog = Array.isArray(erpVouchers) ? erpVouchers : [];
      trialLoadCache.catalogExpiresAt = Date.now() + 30000;
      trialState.catalog = Array.isArray(erpVouchers) ? erpVouchers : [];
      renderTrialCatalog();
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

  if (changed) renderTrial();
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

  let scheduleResult = null;
  let scheduleError = null;
  try {
    scheduleResult = await GET(`/api/trial/schedule${startParam}`);
  } catch (err) {
    scheduleError = err;
    console.error('Failed to load trial schedule:', err);
  }

  if (force) {
    trialLoadCache.catalog = null;
    trialLoadCache.catalogExpiresAt = 0;
    trialLoadCache.machines = null;
    trialLoadCache.machinesExpiresAt = 0;
  }

  const [erpVouchers, machinesResult, programToolsLookup] = await Promise.all([
    trialCachedGET('catalog', 30000, '/api/pp-vouchers/with-ops').catch(() => []),
    trialCachedGET('machines', 300000, '/api/planner/machines').catch(() => ({ machines: [] })),
    GET('/api/program-tool-list/lookup').catch(() => null),
  ]);

  const scheduleData = scheduleResult || {};
  if (scheduleError && !scheduleData.blocks?.length) {
    toast('Could not refresh machine queue: ' + scheduleError.message, 'error');
  }

  // Prefer schedule machines (richer); fall back to /api/planner/machines
  const rawMachines = (scheduleData.machines && scheduleData.machines.length)
    ? scheduleData.machines
    : (machinesResult.machines || []);
  const machines = rawMachines
    .filter(m => m.active !== false)
    .map(m => ({ ...m, machine_code: m.machine_no || m.machine_code }));

  // Available panel is sourced entirely from pp_vouchers_cache (ERP truth)
  const catalog = Array.isArray(erpVouchers) ? erpVouchers : [];

  trialState = {
    machines,
    blocks:         trialMergeBlocksWithSchedule(scheduleData.blocks || []),
    block_groups:   scheduleData.block_groups   || [],
    segments:       scheduleData.segments       || [],
    actuals:        scheduleData.actuals        || [],
    capacities:     scheduleData.capacities     || [],
    profiles:       scheduleData.profiles       || [],
    catalog,
    planned:        scheduleData.planned        || [],
    planning_cards: scheduleData.planning_cards || [],
    program_tools_lookup: programToolsLookup,
  };
  renderTrial();
}

// Lightweight refresh for a subset of machines after a mutation.
// Replaces loadTrial() for block create/update/delete/reorder/actuals.
// Falls back to loadTrial() on error.
async function refreshMachines(machineIds) {
  const ids = [...new Set((machineIds || []).map(Number).filter(Boolean))];
  if (!ids.length) { renderTrial(); return; }

  const params = new URLSearchParams({ machine_ids: ids.join(','), lite: '1' });
  const data = await GET(`/api/trial/schedule?${params}`).catch(err => {
    console.error('refreshMachines failed, falling back to full reload:', err);
    return null;
  });
  if (!data) { await loadTrial(); return; }

  const machineSet = new Set(ids.map(String));

  // Replace blocks and segments for the affected machines only
  trialState.blocks = [
    ...(trialState.blocks || []).filter(b => !machineSet.has(String(b.machine_id))),
    ...(data.blocks || []),
  ];
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

  renderTrial();
}
