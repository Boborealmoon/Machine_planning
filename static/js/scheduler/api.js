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
  const btn = document.getElementById('trial-sync-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    await POST('/api/pp-vouchers/sync', {});
    const erpVouchers = await GET('/api/pp-vouchers/with-ops');
    trialState.catalog = Array.isArray(erpVouchers) ? erpVouchers : [];
    renderTrialCatalog();
    if (btn) btn.textContent = 'Synced ✓';
    setTimeout(() => { if (btn) btn.textContent = 'Sync ERP'; }, 2000);
  } catch (err) {
    if (btn) btn.textContent = 'Sync failed';
    setTimeout(() => { if (btn) btn.textContent = 'Sync ERP'; }, 3000);
    console.error('pp-vouchers sync failed:', err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

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

async function loadTrial() {
  const resolved = trialNormalizeScheduleDates(trialScheduleDateFilter.start, trialScheduleDateFilter.end);
  trialScheduleDateFilter = resolved;
  trialSyncScheduleUrl();

  const startParam = trialScheduleDateFilter.start ? `?start=${trialScheduleDateFilter.start}&end=${trialScheduleDateFilter.end}` : '';

  const [scheduleResult, erpVouchers, machinesResult] = await Promise.all([
    GET(`/api/trial/schedule${startParam}`).catch(() => null),
    GET('/api/pp-vouchers/with-ops').catch(() => []),
    GET('/api/planner/machines').catch(() => ({ machines: [] })),
  ]);

  const scheduleData = scheduleResult || {};

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
    blocks:         scheduleData.blocks         || [],
    block_groups:   scheduleData.block_groups   || [],
    segments:       scheduleData.segments       || [],
    actuals:        scheduleData.actuals        || [],
    capacities:     scheduleData.capacities     || [],
    profiles:       scheduleData.profiles       || [],
    catalog,
    planned:        scheduleData.planned        || [],
    planning_cards: scheduleData.planning_cards || [],
  };
  renderTrial();
}
