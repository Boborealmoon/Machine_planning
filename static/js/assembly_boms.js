(() => {
  'use strict';

  const state = {
    items: [],
    search: '',
    anomaliesOnly: false,
    flag: '',
    includeHistory: true,
    types: new Set(['APS', 'NPS', 'SR']),
  };

  const FLAG_META = {
    nested_assembly: ['Assembly', 'info'],
    deep_nested: ['Nested BOM', 'info'],
    multiple_boms: ['Multiple BOMs', 'warn'],
    missing_bom: ['Missing child BOM', 'danger'],
    unresolved_bom: ['Unresolved BOM', 'danger'],
    bom_alias: ['BOM alias', 'warn'],
    repeated_component: ['Repeated component', 'info'],
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
    return `<span class="ab-badge ab-badge--${tone}">${escapeHtml(label)}</span>`;
  }

  function routeBadge(child) {
    const meta = {
      ok: ['Route OK', 'ok'],
      alias: ['Alias match', 'warn'],
      missing: ['BOM missing', 'danger'],
      unresolved: ['BOM unresolved', 'danger'],
      history: ['Staged route history', 'ok'],
    };
    const [label, tone] = meta[child.route_status] || ['Unknown', 'warn'];
    return `<span class="ab-route ab-route--${tone}">${label}</span>`;
  }

  function childRow(child) {
    const routes = (child.available_bom_codes || []).length
      ? child.available_bom_codes.map((code) => `<code>${escapeHtml(code)}</code>`).join('<br>')
      : '<span class="ab-muted">None found</span>';
    const materials = (child.leaf_materials || []).length
      ? child.leaf_materials.map(escapeHtml).join('<br>')
      : '<span class="ab-muted">No leaf material found</span>';
    return `
      <tr>
        <td>
          <strong>${escapeHtml(child.process_sheet_no || '-')}</strong>
          <span class="ab-cell-sub">Seq ${escapeHtml(child.component_seq_no || '-')}${child.component_link_no ? ` / Link ${escapeHtml(child.component_link_no)}` : ''}</span>
        </td>
        <td>
          <strong class="ab-mono">${escapeHtml(child.part_no)}</strong>
          <span class="ab-cell-sub">${escapeHtml(child.description || '-')}</span>
        </td>
        <td class="ab-number">${escapeHtml(fmtQty(child.qty))}</td>
        <td>${child.in_house === true ? '<span class="ab-route ab-route--ok">In-house</span>' : (child.in_house === false ? '<span class="ab-muted">External / untagged</span>' : '<span class="ab-muted">Not synced</span>')}</td>
        <td>
          <code>${escapeHtml(child.selected_bom_code || '-')}</code>
          <div class="ab-cell-sub">${routeBadge(child)}</div>
        </td>
        <td>${routes}</td>
        <td>${materials}</td>
      </tr>`;
  }

  function jobType(job) {
    const explicit = text(job.ps_type).toUpperCase();
    if (explicit) return explicit;
    const id = text(job.ps_id);
    if (/\[sr\]/i.test(id)) return 'SR';
    return id.slice(0, 3).toUpperCase();
  }

  function jobCard(job) {
    const flags = (job.flags || []).map(flagBadge).join('');
    const partial = Number(job.pp_partial_no) > 1 ? `<span class="ab-partial">P${escapeHtml(job.pp_partial_no)}</span>` : '';
    const srBadge = jobType(job) === 'SR' ? '<span class="ab-sr-badge">[SR]</span>' : '';
    return `
      <details class="ab-job card" data-ps-id="${escapeHtml(job.ps_id)}">
        <summary>
          <div class="ab-job-main">
            <div class="ab-job-id">${escapeHtml(job.ps_id)} ${partial}${srBadge}</div>
            <div class="ab-job-part"><span class="ab-mono">${escapeHtml(job.part_no)}</span> / ${escapeHtml(job.part_desc || '-')}</div>
            <div class="ab-badges">${flags}</div>
          </div>
          <div class="ab-metric">
            <span>Components</span>
            <strong>${escapeHtml(job.component_count)}</strong>
            <small>${escapeHtml(job.distinct_child_count)} distinct</small>
          </div>
          <div class="ab-metric">
            <span>Depth</span>
            <strong>${escapeHtml(job.max_depth)}</strong>
            <small>${escapeHtml(job.bom_code || 'No parent BOM')}</small>
          </div>
          <div class="ab-job-order">
            <span>${escapeHtml(job.sales_order_no || 'No sales order')}</span>
            <strong>Due ${escapeHtml(fmtDate(job.due_date))}</strong>
            <small>${escapeHtml(fmtQty(job.qty))} pcs / ${escapeHtml(job.current_stage_desc || job.status || '-')}</small>
          </div>
          <span class="ab-chevron" aria-hidden="true"></span>
        </summary>
        <div class="ab-job-detail">
          <div class="ab-detail-meta">
            <span><b>Customer</b> ${escapeHtml(job.customer_code || '-')}</span>
            <span><b>Customer PO</b> ${escapeHtml(job.customer_po_no || '-')}</span>
            <span><b>Parent BOM</b> <code>${escapeHtml(job.bom_code || '-')}</code></span>
            <span><b>Shipped</b> ${escapeHtml(fmtQty(job.qty_shipped))}</span>
          </div>
          <div class="ab-table-scroll">
            <table class="ab-child-table">
              <thead>
                <tr>
                  <th>Child process sheet</th>
                  <th>Manufactured part</th>
                  <th>Qty</th>
                  <th>Production</th>
                  <th>Selected BOM</th>
                  <th>Available BOM routes</th>
                  <th>Leaf material</th>
                </tr>
              </thead>
              <tbody>${(job.children || []).map(childRow).join('')}</tbody>
            </table>
          </div>
        </div>
      </details>`;
  }

  function searchBlob(job) {
    return [
      job.ps_id,
      job.part_no,
      job.part_desc,
      job.sales_order_no,
      job.customer_po_no,
      job.bom_code,
      ...(job.children || []).flatMap((child) => [
        child.process_sheet_no,
        child.part_no,
        child.description,
        child.selected_bom_code,
        ...(child.available_bom_codes || []),
      ]),
    ].map(text).join(' ').toLowerCase();
  }

  function filteredItems() {
    const query = state.search.toLowerCase();
    return state.items.filter((job) => {
      const type = jobType(job);
      if (!state.types.has(type)) return false;
      if (state.anomaliesOnly && !job.has_anomaly) return false;
      if (state.flag && !(job.flags || []).includes(state.flag)) return false;
      return !query || searchBlob(job).includes(query);
    });
  }

  function render() {
    const list = document.getElementById('ab-list');
    const empty = document.getElementById('ab-empty');
    const summary = document.getElementById('ab-summary');
    const items = filteredItems();
    list.innerHTML = items.map(jobCard).join('');
    empty.hidden = items.length > 0;
    list.hidden = items.length === 0;
    const anomalies = state.items.filter((item) => item.has_anomaly).length;
    const scope = state.includeHistory ? 'assembly process sheets' : 'open nested assemblies';
    summary.textContent = `${items.length} shown / ${state.items.length} ${scope} / ${anomalies} with BOM warnings`;
  }

  function showError(message) {
    document.getElementById('ab-loading').hidden = true;
    const error = document.getElementById('ab-error');
    error.textContent = message;
    error.hidden = false;
    document.getElementById('ab-list').hidden = true;
    document.getElementById('ab-empty').hidden = true;
    document.getElementById('ab-summary').textContent = 'Assembly BOM data could not be loaded.';
  }

  async function load({ refresh = false } = {}) {
    const button = document.getElementById('ab-refresh');
    button.disabled = true;
    document.getElementById('ab-error').hidden = true;
    document.getElementById('ab-loading').hidden = false;
    try {
      const params = new URLSearchParams({
        include_history: state.includeHistory ? '1' : '0',
      });
      if (refresh) params.set('refresh', '1');
      const response = await fetch(`/api/assembly-boms?${params.toString()}`, {
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      state.items = Array.isArray(payload.items) ? payload.items : [];
      document.getElementById('ab-loading').hidden = true;
      render();
    } catch (error) {
      showError(error?.message || 'Unknown ERP error');
    } finally {
      button.disabled = false;
    }
  }

  document.getElementById('ab-search')?.addEventListener('input', (event) => {
    state.search = event.target.value.trim();
    render();
  });
  document.getElementById('ab-anomalies-only')?.addEventListener('change', (event) => {
    state.anomaliesOnly = event.target.checked;
    render();
  });
  document.getElementById('ab-include-history')?.addEventListener('change', (event) => {
    state.includeHistory = event.target.checked;
    load();
  });
  document.getElementById('ab-flag-filter')?.addEventListener('change', (event) => {
    state.flag = event.target.value;
    render();
  });
  document.querySelectorAll('[data-ab-type]').forEach((button) => {
    button.addEventListener('click', () => {
      const type = button.dataset.abType;
      if (state.types.has(type)) state.types.delete(type);
      else state.types.add(type);
      const active = state.types.has(type);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
      render();
    });
  });
  document.getElementById('ab-refresh')?.addEventListener('click', () => load({ refresh: true }));

  load();
})();
