(() => {
  'use strict';

  const state = {
    items: [],
    search: '',
    issuesOnly: false,
    flag: '',
    view: 'active',
    types: new Set(['APS', 'NPS']),
    expanded: new Set(),
  };

  const FLAG_META = {
    nested_assembly: ['Assembly', 'info'],
    deep_nested: ['Nested BOM', 'info'],
    leaf_component: ['Leaf component', 'info'],
    multiple_boms: ['Multiple BOMs', 'warn'],
    missing_bom: ['Missing child BOM', 'danger'],
    unresolved_bom: ['Unresolved BOM', 'danger'],
    bom_alias: ['BOM alias', 'warn'],
    repeated_component: ['Repeated component', 'info'],
    qty_mismatch: ['Qty mismatch', 'warn'],
    orphan_comp: ['Orphan component', 'warn'],
    missing_comp_sheet: ['Missing COMP sheet', 'danger'],
    stalled_child: ['Stalled', 'warn'],
  };

  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const text = (value) => String(value ?? '').trim();

  function fmtQty(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '-';
    return Number.isInteger(number) ? String(number) : number.toLocaleString(undefined, { maximumFractionDigits: 3 });
  }

  function fmtDate(value) {
    const raw = text(value);
    return raw ? raw.slice(0, 10) : '-';
  }

  function flagBadge(flag) {
    const [label, tone] = FLAG_META[flag] || [flag.replaceAll('_', ' '), 'info'];
    const cls = tone === 'danger' ? 'ap-chip--danger' : (tone === 'warn' ? 'ap-chip--warn' : 'ap-chip');
    return `<span class="ap-chip ${cls}">${escapeHtml(label)}</span>`;
  }

  function routePill(child) {
    if (!child.is_subassembly && !child.missing_comp_sheet) {
      return '<span class="ap-pill ap-pill--muted">Leaf</span>';
    }
    const meta = {
      ok: ['Route OK', 'ok'],
      alias: ['Alias', 'warn'],
      missing: ['BOM missing', 'danger'],
      unresolved: ['Unresolved', 'danger'],
      history: ['History', 'ok'],
    };
    const [label, tone] = meta[child.route_status] || ['Unknown', 'warn'];
    return `<span class="ap-pill ap-pill--${tone}">${label}</span>`;
  }

  function stagePill(child) {
    const stage = text(child.current_stage_desc) || text(child.status) || '-';
    const st = text(child.current_stage_status).toUpperCase();
    let tone = 'muted';
    if (st === 'C' || /complete/i.test(stage)) tone = 'ok';
    else if (child.stalled) tone = 'warn';
    else if (stage !== '-') tone = 'ok';
    return `<span class="ap-pill ap-pill--${tone}" title="${escapeHtml(stage)}">${escapeHtml(stage.length > 28 ? `${stage.slice(0, 26)}ù` : stage)}</span>`;
  }

  function materialPill(child) {
    if (child.material_in) {
      return `<span class="ap-pill ap-pill--ok">In${child.material_in_date ? ` ù ${escapeHtml(fmtDate(child.material_in_date))}` : ''}</span>`;
    }
    if (child.in_house === false) {
      return '<span class="ap-pill ap-pill--muted">N/A</span>';
    }
    return '<span class="ap-pill ap-pill--warn">Pending</span>';
  }

  function queuePill(child) {
    const machines = child.queued_machines || [];
    if (machines.length) {
      return `<span class="ap-pill ap-pill--ok" title="${escapeHtml(machines.join(', '))}">Queued ù ${escapeHtml(machines.length)}</span>`;
    }
    if (child.needs_scheduling) {
      return '<span class="ap-pill ap-pill--warn">Needs sched.</span>';
    }
    if (child.ready) {
      return '<span class="ap-pill ap-pill--ok">Ready</span>';
    }
    return '<span class="ap-pill ap-pill--muted">ù</span>';
  }

  function inHouseLabel(child) {
    if (child.in_house === true) return '<span class="ap-pill ap-pill--ok">In-house</span>';
    if (child.in_house === false) return '<span class="ap-pill ap-pill--muted">External</span>';
    return '<span class="ap-pill ap-pill--muted">ù</span>';
  }

  function issueChips(child) {
    const flags = (child.flags || []).filter((f) => !['nested_assembly', 'deep_nested', 'leaf_component', 'repeated_component'].includes(f));
    if (!flags.length && child.repeated) {
      return flagBadge('repeated_component');
    }
    if (!flags.length) return '<span class="ap-sub">ù</span>';
    return `<div class="ap-issues">${flags.map(flagBadge).join('')}</div>`;
  }

  function parentCell(job, rowspan) {
    const flags = (job.flags || [])
      .filter((f) => f !== 'nested_assembly')
      .slice(0, 4)
      .map(flagBadge)
      .join('');
    return `
      <td class="ap-parent-cell" rowspan="${rowspan}">
        <div class="ap-parent-block">
          <div class="ap-parent-id">${escapeHtml(job.ps_id)}</div>
          <div class="ap-parent-part">
            <span class="ap-mono">${escapeHtml(job.part_no || '-')}</span>
            <span class="ap-sub">${escapeHtml(job.part_desc || '-')}</span>
          </div>
          <div class="ap-parent-meta">
            <span class="ap-chip ap-chip--muted">${escapeHtml(job.sales_order_no || 'No SO')}</span>
            <span class="ap-chip ap-chip--muted">Due ${escapeHtml(fmtDate(job.due_date))}</span>
            <span class="ap-chip">${escapeHtml(job.readiness_label || '0/0')} ready</span>
          </div>
          <div class="ap-parent-meta">${flags}</div>
        </div>
      </td>`;
  }

  function detailHtml(job, child) {
    const materials = (child.leaf_materials || []).length
      ? `<ul>${child.leaf_materials.map((m) => `<li class="ap-mono">${escapeHtml(m)}</li>`).join('')}</ul>`
      : '<span class="ap-sub">No leaf materials</span>';
    const routes = (child.available_bom_codes || []).length
      ? `<ul>${child.available_bom_codes.map((c) => `<li><code>${escapeHtml(c)}</code></li>`).join('')}</ul>`
      : '<span class="ap-sub">No child BOM routes</span>';
    const expected = child.expected_qty != null ? fmtQty(child.expected_qty) : '-';
    return `
      <tr class="ap-detail-row" data-detail-for="${escapeHtml(job.ps_id)}::${escapeHtml(child.process_sheet_no || child.part_no)}">
        <td colspan="10">
          <div class="ap-detail">
            <div>
              <h4>BOM route</h4>
              <div><code>${escapeHtml(child.selected_bom_code || '-')}</code> ? <code>${escapeHtml(child.resolved_bom_code || '-')}</code></div>
              <div class="ap-sub">Expected qty ${escapeHtml(expected)} ù Actual ${escapeHtml(fmtQty(child.qty))}</div>
              ${routes}
              <div class="ap-detail-actions">
                <a href="${escapeHtml(child.process_sheets_url || '/process-sheets')}" target="_blank" rel="noopener">Open Process Sheet</a>
                <a href="${escapeHtml(child.sales_orders_url || '/sales-orders')}" target="_blank" rel="noopener">Open S/O</a>
                <a href="${escapeHtml(job.process_sheets_url || '/process-sheets')}" target="_blank" rel="noopener">Parent PS</a>
              </div>
            </div>
            <div>
              <h4>Leaf materials</h4>
              ${materials}
            </div>
            <div>
              <h4>Status</h4>
              <div>${stagePill(child)}</div>
              <div class="ap-sub" style="margin-top:6px">Queue: ${escapeHtml((child.queued_machines || []).join(', ') || 'none')}</div>
              <div class="ap-sub">Material in: ${child.material_in ? 'yes' : 'no'}</div>
              <div class="ap-sub">In-house: ${child.in_house === true ? 'yes' : (child.in_house === false ? 'no' : 'unknown')}</div>
            </div>
          </div>
        </td>
      </tr>`;
  }

  function childRow(job, child, isFirst, rowspan, expanded) {
    const key = `${job.ps_id}::${child.process_sheet_no || child.part_no}`;
    const parent = isFirst ? parentCell(job, rowspan) : '';
    const psLabel = text(child.process_sheet_no) || '<span class="ap-sub">Missing sheet</span>';
    return `
      <tr class="ap-row ${expanded ? 'is-expanded' : ''}" data-row-key="${escapeHtml(key)}">
        ${parent}
        <td>
          <strong>${psLabel}</strong>
          <span class="ap-sub">Seq ${escapeHtml(child.component_seq_no || '-')}</span>
        </td>
        <td>
          <strong class="ap-mono">${escapeHtml(child.part_no || '-')}</strong>
          <span class="ap-sub">${escapeHtml(child.description || '-')}</span>
        </td>
        <td class="ap-num">${escapeHtml(fmtQty(child.qty))}</td>
        <td>${inHouseLabel(child)}</td>
        <td>${stagePill(child)}</td>
        <td>${materialPill(child)}</td>
        <td>${queuePill(child)}</td>
        <td>${routePill(child)}</td>
        <td>${issueChips(child)}</td>
        <td>
          <button type="button" class="ap-expand-btn" data-expand="${escapeHtml(key)}" aria-expanded="${expanded ? 'true' : 'false'}" aria-label="Toggle details">?</button>
        </td>
      </tr>
      ${expanded ? detailHtml(job, child) : ''}`;
  }

  function visibleJobs() {
    const q = state.search.toLowerCase();
    return state.items.filter((job) => {
      const type = text(job.ps_id).slice(0, 3).toUpperCase();
      if (!state.types.has(type)) return false;
      if (state.issuesOnly && !job.has_issues && !job.has_anomaly) return false;
      if (state.flag) {
        const jobFlags = new Set(job.flags || []);
        const childHit = (job.children || []).some((c) => (c.flags || []).includes(state.flag));
        if (!jobFlags.has(state.flag) && !childHit) return false;
      }
      if (!q) return true;
      const blob = [
        job.ps_id,
        job.part_no,
        job.part_desc,
        job.sales_order_no,
        job.bom_code,
        ...(job.children || []).flatMap((c) => [
          c.process_sheet_no,
          c.part_no,
          c.description,
          c.selected_bom_code,
          ...(c.leaf_materials || []),
        ]),
      ].join(' ').toLowerCase();
      return blob.includes(q);
    });
  }

  function render() {
    const list = visibleJobs();
    const tbody = document.getElementById('ap-tbody');
    const wrap = document.getElementById('ap-table-wrap');
    const empty = document.getElementById('ap-empty');
    const summary = document.getElementById('ap-summary');

    const childCount = list.reduce((n, job) => n + (job.children || []).length, 0);
    const issueCount = list.filter((j) => j.has_issues || j.has_anomaly).length;
    summary.textContent = `${list.length} parents / ${childCount} child parts ù ${issueCount} with issues ù view ${state.view}`;

    if (!list.length) {
      tbody.innerHTML = '';
      wrap.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    wrap.hidden = false;

    const html = [];
    for (const job of list) {
      const children = job.children || [];
      let rowspan = Math.max(children.length, 1);
      for (const child of children) {
        const key = `${job.ps_id}::${child.process_sheet_no || child.part_no}`;
        if (state.expanded.has(key)) rowspan += 1;
      }
      children.forEach((child, idx) => {
        const key = `${job.ps_id}::${child.process_sheet_no || child.part_no}`;
        html.push(childRow(job, child, idx === 0, rowspan, state.expanded.has(key)));
      });
    }
    tbody.innerHTML = html.join('');
  }

  async function load(refresh = false) {
    const loading = document.getElementById('ap-loading');
    const error = document.getElementById('ap-error');
    loading.hidden = false;
    error.hidden = true;
    document.getElementById('ap-table-wrap').hidden = true;
    document.getElementById('ap-empty').hidden = true;

    const params = new URLSearchParams({ view: state.view });
    if (refresh) params.set('refresh', '1');
    try {
      const res = await fetch(`/api/assembly-parts?${params.toString()}`);
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      state.items = payload.items || [];
      loading.hidden = true;
      render();
    } catch (err) {
      loading.hidden = true;
      error.hidden = false;
      error.textContent = err.message || String(err);
    }
  }

  function bind() {
    document.getElementById('ap-search').addEventListener('input', (e) => {
      state.search = e.target.value || '';
      render();
    });
    document.getElementById('ap-issues-only').addEventListener('change', (e) => {
      state.issuesOnly = !!e.target.checked;
      render();
    });
    document.getElementById('ap-flag-filter').addEventListener('change', (e) => {
      state.flag = e.target.value || '';
      render();
    });
    document.getElementById('ap-refresh').addEventListener('click', () => load(true));

    document.querySelectorAll('[data-ap-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-ap-type');
        if (state.types.has(type)) {
          if (state.types.size === 1) return;
          state.types.delete(type);
          btn.classList.remove('is-active');
          btn.setAttribute('aria-pressed', 'false');
        } else {
          state.types.add(type);
          btn.classList.add('is-active');
          btn.setAttribute('aria-pressed', 'true');
        }
        render();
      });
    });

    document.querySelectorAll('[data-ap-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = btn.getAttribute('data-ap-view');
        if (view === state.view) return;
        state.view = view;
        document.querySelectorAll('[data-ap-view]').forEach((b) => {
          const on = b.getAttribute('data-ap-view') === view;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        load(false);
      });
    });

    document.getElementById('ap-tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-expand]');
      if (!btn) return;
      const key = btn.getAttribute('data-expand');
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      render();
    });
  }

  bind();
  load(false);
})();
