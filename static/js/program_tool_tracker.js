// Program / Tool Tracker — outstanding PS programme/tool-list coverage.

const pttState = {
  view: 'tracker',
  items: [],
  summary: {},
  filters: {},
  lastSynced: '',
  toolListRows: 0,
  search: '',
  matchFilter: '',
  psType: 'NPS',
  showCompleted: false,
  expanded: new Set(),
};

const PTT_QUICK_FILTERS = [
  { id: 'nps_all', label: 'NPS open PS', psType: 'NPS', matchFilter: '', showCompleted: false },
  { id: 'nps_gaps', label: 'NPS gaps', psType: 'NPS', matchFilter: 'any_gap', showCompleted: false },
  { id: 'nps_missing', label: 'NPS missing', psType: 'NPS', matchFilter: 'missing', showCompleted: false },
  { id: 'all_gaps', label: 'All types gaps', psType: '', matchFilter: 'any_gap', showCompleted: false },
];

function pttBoolIcon(value) {
  return value
    ? '<span class="ptt-check" title="Yes">✓</span>'
    : '<span class="ptt-cross" title="No">✗</span>';
}

function pttStatusBadge(status) {
  const label = {
    full: 'Matched',
    partial: 'Partial',
    missing: 'Missing',
    na: 'N/A',
  }[status] || status;
  return `<span class="ptt-badge ptt-badge--${status || 'na'}">${escapeHtml(label)}</span>`;
}

function pttCoverageBadge(coverage) {
  const label = {
    full: 'Covered',
    partial: 'Partial',
    none: 'Gaps',
    na: 'No CNC',
  }[coverage] || coverage;
  const cls = coverage === 'full' ? 'full' : coverage === 'partial' ? 'partial' : coverage === 'none' ? 'missing' : 'na';
  return `<span class="ptt-badge ptt-badge--${cls}">${escapeHtml(label)}</span>`;
}

function pttFormatQty(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return escapeHtml(String(value));
  return Number.isInteger(n) ? String(n) : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function pttShippedCell(item) {
  const shipped = pttFormatQty(item.qty_shipped);
  const soQty = item.so_det_qty;
  if (soQty == null) return shipped;
  const open = Number(soQty) > Number(item.qty_shipped || 0) + 0.0001;
  return open
    ? `<span title="SO ${pttFormatQty(soQty)}">${shipped}</span>`
    : shipped;
}

function pttLink(url, label) {
  const href = String(url || '').trim();
  if (href && /^https?:\/\//i.test(href)) {
    return `<a class="ptt-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${escapeHtml(label)}</a>`;
  }
  return '<span class="ptt-muted">—</span>';
}

function pttPartialLabel(item) {
  const partial = Number(item.pp_partial_no || 1);
  return partial > 1 ? `P${partial}` : '';
}

function pttItemKey(item) {
  return String(item.ps_id || item.display_ps_id || '');
}

function pttFormatDate(value) {
  if (!value) return '—';
  const text = String(value).trim().slice(0, 10);
  return text || '—';
}

function pttSearchHaystack(item) {
  return [
    item.ps_id,
    item.source_ps_id,
    item.display_ps_id,
    item.ps_type,
    item.part_no,
    item.inventory_code,
    item.part_desc,
    item.route_label,
    item.selected_flow_code,
    item.erp_bom_code,
    item.planner_status,
    item.current_stage_desc,
    ...(item.ops || []).flatMap((op) => [
      op.op_no,
      op.op_type,
      op.stage_desc,
      op.match?.program_no,
      op.match?.programmer_name,
    ]),
  ]
    .filter((v) => v != null && String(v).trim() !== '')
    .join(' ')
    .toLowerCase();
}

function pttFilteredItems() {
  const search = pttState.search.trim().toLowerCase();
  if (!search) return pttState.items;
  return pttState.items.filter((item) => pttSearchHaystack(item).includes(search));
}

function pttVisibleSummary(items) {
  const summary = {
    process_sheets: items.length,
    cnc_ops: 0,
    programme_ready: 0,
    tool_list_ready: 0,
    fully_matched: 0,
    partial_matched: 0,
    missing: 0,
    with_gaps: 0,
    outstanding: 0,
  };

  items.forEach((item) => {
    if (item.is_outstanding) summary.outstanding += 1;
    if (item.cnc_ops_missing > 0 || item.cnc_ops_partial > 0) summary.with_gaps += 1;
    (item.ops || []).forEach((op) => {
      summary.cnc_ops += 1;
      if (op.match?.programme_ready) summary.programme_ready += 1;
      if (op.match?.tool_list_ready) summary.tool_list_ready += 1;
      const status = op.match?.status;
      if (status === 'full') summary.fully_matched += 1;
      else if (status === 'partial') summary.partial_matched += 1;
      else if (status === 'missing') summary.missing += 1;
    });
  });

  return summary;
}

function pttRenderSummary() {
  const el = document.getElementById('ptt-summary');
  if (!el) return;
  const items = pttFilteredItems();
  if (!items.length) {
    el.hidden = true;
    return;
  }
  const s = pttVisibleSummary(items);
  el.hidden = false;
  el.innerHTML = `
    <div class="ptt-summary-card"><strong>${s.process_sheets}</strong><span>Shown PS</span></div>
    <div class="ptt-summary-card"><strong>${s.outstanding}</strong><span>Outstanding</span></div>
    <div class="ptt-summary-card"><strong>${s.with_gaps}</strong><span>With gaps</span></div>
    <div class="ptt-summary-card"><strong>${s.cnc_ops}</strong><span>CNC ops</span></div>
    <div class="ptt-summary-card"><strong>${s.fully_matched}</strong><span>Fully matched</span></div>
    <div class="ptt-summary-card"><strong>${s.partial_matched}</strong><span>Partial</span></div>
    <div class="ptt-summary-card"><strong>${s.missing}</strong><span>Missing</span></div>
  `;
}

function pttRenderStats() {
  const statsEl = document.getElementById('ptt-stats');
  if (!statsEl) return;
  const visible = pttFilteredItems().length;
  const total = pttState.items.length;
  statsEl.innerHTML = `
    <span class="new-orders-stat"><strong>${visible}</strong> shown</span>
    <span class="new-orders-stat"><strong>${total}</strong> loaded</span>
  `;
}

function pttRenderFilterNote() {
  const note = document.getElementById('ptt-filter-note');
  if (!note) return;
  const psType = pttState.psType || 'All types';
  const matchLabels = {
    '': 'all PS',
    any_gap: 'gaps only',
    missing: 'missing programme/tools',
    partial: 'partial matches',
    full: 'fully matched CNC ops',
  };
  const scope = pttState.showCompleted
    ? 'all PS including completed'
    : 'active PS only (SO qty > shipped / production open)';
  note.textContent = `Showing ${scope} · PS type: ${psType} · Match: ${matchLabels[pttState.matchFilter] || pttState.matchFilter}`;
}

function pttRenderQuickFilters() {
  const row = document.getElementById('ptt-quick-filters');
  if (!row) return;
  row.innerHTML = PTT_QUICK_FILTERS.map((chip) => {
    const active = chip.psType === pttState.psType
      && chip.matchFilter === pttState.matchFilter
      && chip.showCompleted === pttState.showCompleted;
    return `<button type="button" class="ptt-chip ${active ? 'ptt-chip--active' : ''}" data-chip-id="${chip.id}">${escapeHtml(chip.label)}</button>`;
  }).join('');
}

function pttRenderMeta() {
  const meta = document.getElementById('ptt-meta');
  if (!meta) return;
  if (!pttState.lastSynced && !pttState.toolListRows) {
    meta.hidden = true;
    return;
  }
  meta.hidden = false;
  meta.textContent = `Tool list synced ${pttState.lastSynced || '—'} · ${pttState.toolListRows} sheet row(s) · Turning/Milling/Turnmill only · Match = Part + BOM op + programme + tool list`;
}

function pttRenderOpsTable(item) {
  const ops = Array.isArray(item.ops) ? item.ops : [];
  if (!ops.length) {
    return '<div class="ptt-muted" style="padding:12px 16px">No route operations on this process sheet.</div>';
  }

  const rows = ops.map((op) => {
    const m = op.match || {};
    return `
      <tr>
        <td><strong>${escapeHtml(op.op_no || '—')}</strong></td>
        <td>${escapeHtml(op.op_type || '—')}</td>
        <td>${escapeHtml(op.stage_desc || '—')}</td>
        <td>${escapeHtml(op.execution_status || '—')}</td>
        <td>${pttStatusBadge(m.status)}</td>
        <td>${pttBoolIcon(m.part_match)}</td>
        <td>${pttBoolIcon(m.bom_aligned)}</td>
        <td>${pttBoolIcon(m.programme_ready)}</td>
        <td>${pttBoolIcon(m.tool_list_ready)}</td>
        <td>${escapeHtml(m.program_no || '—')}</td>
        <td>${pttLink(m.program_file, 'Programme')}</td>
        <td>${pttLink(m.tool_list_files, 'Tool list')}</td>
        <td>${escapeHtml(m.programmer_name || '—')}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="ptt-ops-wrap">
      <table class="ptt-ops-table">
        <thead>
          <tr>
            <th>OP</th>
            <th>Type</th>
            <th>Stage</th>
            <th>ERP status</th>
            <th>Match</th>
            <th>Part</th>
            <th>BOM op</th>
            <th>Prog</th>
            <th>Tools</th>
            <th>Program no.</th>
            <th>Programme</th>
            <th>Tool list</th>
            <th>Programmer</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function pttGapLabel(item) {
  const parts = [];
  if (item.cnc_ops_missing > 0) parts.push(`${item.cnc_ops_missing} missing`);
  if (item.cnc_ops_partial > 0) parts.push(`${item.cnc_ops_partial} partial`);
  if (!parts.length) return '<span class="ptt-muted">—</span>';
  const cls = item.cnc_ops_missing > 0 ? 'missing' : 'partial';
  return `<span class="ptt-badge ptt-badge--${cls}">${escapeHtml(parts.join(' · '))}</span>`;
}

function pttRenderTable() {
  const wrap = document.getElementById('ptt-table-wrap');
  const body = document.getElementById('ptt-table-body');
  const empty = document.getElementById('ptt-empty');
  const emptyText = document.getElementById('ptt-empty-text');
  if (!wrap || !body || !empty) return;

  const items = pttFilteredItems();
  pttRenderStats();
  pttRenderSummary();
  pttRenderMeta();
  pttRenderFilterNote();
  pttRenderQuickFilters();

  if (!pttState.items.length) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = 'No process sheets returned for the current server filters.';
    return;
  }

  if (!items.length) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = 'No process sheets match your search.';
    return;
  }

  empty.hidden = true;
  wrap.hidden = false;

  body.innerHTML = items.map((item) => {
    const key = pttItemKey(item);
    const expanded = pttState.expanded.has(key);
    const partial = pttPartialLabel(item);
    const psTitle = item.display_ps_id || item.ps_id || '—';
    const part = item.part_no || item.inventory_code || '—';
    const bom = item.route_label || item.selected_flow_code || item.erp_bom_code || '—';
    const hasGap = item.cnc_ops_missing > 0 || item.cnc_ops_partial > 0;
    const rowClass = [
      'ptt-row',
      hasGap ? 'ptt-row--gap' : '',
      expanded ? 'ptt-row--expanded' : '',
    ].filter(Boolean).join(' ');

    const mainRow = `
      <tr class="${rowClass}" data-action="toggle" data-ps-key="${escapeHtml(key)}">
        <td class="ptt-ps-cell">
          <strong>${escapeHtml(psTitle)}</strong>
          ${partial ? `<small>${escapeHtml(partial)}</small>` : ''}
          <small>${escapeHtml(item.ps_type || '')}</small>
        </td>
        <td class="ptt-part-cell">
          <strong>${escapeHtml(part)}</strong>
          ${item.part_desc ? `<span>${escapeHtml(item.part_desc)}</span>` : ''}
        </td>
        <td>${escapeHtml(bom)}</td>
        <td>${escapeHtml(String(item.display_qty ?? '—'))}</td>
        <td>${pttShippedCell(item)}</td>
        <td>${escapeHtml(pttFormatDate(item.due_date))}</td>
        <td>${item.cnc_ops_total || 0}</td>
        <td>${pttCoverageBadge(item.bom_tool_coverage)}</td>
        <td>${pttGapLabel(item)}</td>
        <td class="ptt-muted">${expanded ? '▾' : '▸'}</td>
      </tr>
    `;

    const detailRow = expanded
      ? `<tr class="ptt-detail-row"><td colspan="10">${pttRenderOpsTable(item)}</td></tr>`
      : '';

    return mainRow + detailRow;
  }).join('');
}

async function pttLoad({ refresh = false } = {}) {
  const loading = document.getElementById('ptt-loading');
  const wrap = document.getElementById('ptt-table-wrap');
  const empty = document.getElementById('ptt-empty');
  if (loading) loading.hidden = false;
  if (wrap) wrap.hidden = true;
  if (empty) empty.hidden = true;

  const params = new URLSearchParams();
  if (pttState.search.trim()) params.set('search', pttState.search.trim());
  if (pttState.matchFilter) params.set('match', pttState.matchFilter);
  if (pttState.psType) params.set('ps_type', pttState.psType);
  if (pttState.showCompleted) params.set('show_completed', '1');
  if (refresh) params.set('refresh', '1');

  try {
    const res = await fetch(`/api/archive/program-tool-tracker?${params.toString()}`);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      throw new Error(`Server returned ${res.status} (expected JSON). Restart Flask if you recently updated routes. ${text.slice(0, 120)}`);
    }
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    pttState.items = data.items || [];
    pttState.summary = data.summary || {};
    pttState.filters = data.filters || {};
    pttState.lastSynced = data.last_synced || '';
    pttState.toolListRows = data.tool_list_rows || 0;
    pttRenderTable();
  } catch (err) {
    pttState.items = [];
    pttState.summary = {};
    if (empty) {
      empty.hidden = false;
      const emptyText = document.getElementById('ptt-empty-text');
      if (emptyText) emptyText.textContent = `Failed to load tracker: ${err.message || err}`;
    }
  } finally {
    if (loading) loading.hidden = true;
  }
}

let pttSearchTimer = null;

const PTT_SUBTITLES = {
  tracker: 'Outstanding process sheet tracker for programme / tool-list coverage. Outstanding = active PS still open (SO qty > shipped, production not complete). Defaults to NPS.',
  catalogue: 'Full synced programme / tool list from Google Sheets. P/S NO. resolves part + ERP BOM route. Sync to refresh local data and upsert to Supabase.',
};

function pttSetView(view) {
  pttState.view = view === 'catalogue' ? 'catalogue' : 'tracker';
  document.querySelectorAll('.ptt-view-tab').forEach((tab) => {
    const active = tab.dataset.view === pttState.view;
    tab.classList.toggle('ptt-view-tab--active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.getElementById('ptt-panel-tracker').hidden = pttState.view !== 'tracker';
  document.getElementById('ptt-panel-catalogue').hidden = pttState.view !== 'catalogue';
  document.querySelectorAll('.ptt-tracker-only').forEach((el) => {
    el.hidden = pttState.view !== 'tracker';
  });
  document.querySelectorAll('.ptt-catalogue-only').forEach((el) => {
    el.hidden = pttState.view !== 'catalogue';
  });
  const subtitle = document.getElementById('ptt-subtitle');
  if (subtitle) subtitle.textContent = PTT_SUBTITLES[pttState.view];
}

function pttSyncControlsFromState() {
  const psTypeEl = document.getElementById('ptt-ps-type');
  const matchEl = document.getElementById('ptt-match-filter');
  const completedEl = document.getElementById('ptt-show-completed');
  if (psTypeEl) psTypeEl.value = pttState.psType;
  if (matchEl) matchEl.value = pttState.matchFilter;
  if (completedEl) completedEl.checked = pttState.showCompleted;
}

document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('ptt-table-body')) return;

  pttSyncControlsFromState();
  const urlView = new URLSearchParams(window.location.search).get('view');
  const initialView = window.PTT_INITIAL_VIEW || urlView || 'tracker';
  pttSetView(initialView === 'catalogue' || initialView === 'list' ? 'catalogue' : 'tracker');

  document.querySelectorAll('.ptt-view-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view || 'tracker';
      pttSetView(view);
      const params = new URLSearchParams(window.location.search);
      if (view === 'catalogue') params.set('view', 'catalogue');
      else params.delete('view');
      const qs = params.toString();
      const next = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
      window.history.replaceState({}, '', next);
    });
  });

  document.getElementById('ptt-refresh')?.addEventListener('click', () => pttLoad({ refresh: true }));

  document.getElementById('ptt-search')?.addEventListener('input', (e) => {
    clearTimeout(pttSearchTimer);
    pttSearchTimer = setTimeout(() => {
      pttState.search = e.target.value;
      const serverSearch = pttState.search.trim().length >= 3;
      if (serverSearch) {
        pttLoad();
      } else {
        pttRenderTable();
      }
    }, 280);
  });

  document.getElementById('ptt-ps-type')?.addEventListener('change', (e) => {
    pttState.psType = e.target.value;
    pttLoad();
  });

  document.getElementById('ptt-match-filter')?.addEventListener('change', (e) => {
    pttState.matchFilter = e.target.value;
    pttLoad();
  });

  document.getElementById('ptt-show-completed')?.addEventListener('change', (e) => {
    pttState.showCompleted = !!e.target.checked;
    pttLoad();
  });

  document.getElementById('ptt-quick-filters')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-chip-id]');
    if (!chip) return;
    const preset = PTT_QUICK_FILTERS.find((item) => item.id === chip.dataset.chipId);
    if (!preset) return;
    pttState.psType = preset.psType;
    pttState.matchFilter = preset.matchFilter;
    pttState.showCompleted = preset.showCompleted;
    pttSyncControlsFromState();
    pttLoad();
  });

  document.getElementById('ptt-table-body')?.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-action="toggle"]');
    if (!toggle) return;
    const key = toggle.getAttribute('data-ps-key') || '';
    if (!key) return;
    if (pttState.expanded.has(key)) pttState.expanded.delete(key);
    else pttState.expanded.add(key);
    pttRenderTable();
  });

  pttLoad();
});
