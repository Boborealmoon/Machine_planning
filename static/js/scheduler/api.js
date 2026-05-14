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
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
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

async function loadTrial() {
  const resolved = trialNormalizeScheduleDates(trialScheduleDateFilter.start, trialScheduleDateFilter.end);
  trialScheduleDateFilter = resolved;
  trialSyncScheduleUrl();

  const rows = await GET('/api/pp-vouchers');

  const catalog = rows.map(row => ({
    ps_id: Number(row.pp_partial_no) > 1 ? `${row.ps_id}::${row.pp_partial_no}` : row.ps_id,
    part_no:        row.part_no,
    part_name:      row.part_no,
    part_desc:      row.description,
    due_date:       row.due_date,
    order_date:     row.order_date,
    bom_code:       row.bom_code,
    total_qty:      row.total_qty,
    partial_qty:    row.partial_qty,
    status:         row.status,
    execution_status: row.execution_status || null,
    planner_status: null,
    ops:            [],
    op_cards:       [],
    flow_options:   [],
  }));

  trialState = {
    machines:       trialState.machines       || [],
    blocks:         trialState.blocks         || [],
    block_groups:   trialState.block_groups   || [],
    segments:       trialState.segments       || [],
    actuals:        trialState.actuals        || [],
    capacities:     trialState.capacities     || [],
    profiles:       trialState.profiles       || [],
    catalog,
    planned:        trialState.planned        || [],
    planning_cards: trialState.planning_cards || [],
  };
  renderTrial();
}
