(function () {
  const PS_TYPE_ORDER = ['MPS', 'APS', 'NPS', 'SR', 'PPS', 'CPS', 'OTHER'];

  const state = {
    rows: [],
    stats: {},
    search: '',
    repeatsOnly: false,
    expandedKey: '',
    psTypes: new Set(['APS', 'NPS', 'SR']),
    sort: 'orders_desc',
  };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtDate(value) {
    const text = String(value || '').trim();
    if (!text) return '—';
    return text.length >= 10 ? text.slice(0, 10) : text;
  }

  function rowKey(row) {
    return `${String(row.part_no || '').trim()}::${String(row.bom_code || '').trim()}`;
  }

  function getPsType(psId) {
    const raw = String(psId || '').split('::')[0];
    if (/\[sr\]/i.test(raw)) return 'SR';
    const match = raw.toUpperCase().match(/^([A-Z]+)/);
    if (!match) return 'OTHER';
    const prefix = match[1];
    if (prefix === 'MPS' || prefix === 'APS' || prefix === 'NPS' || prefix === 'PPS' || prefix === 'CPS' || prefix === 'SR') {
      return prefix;
    }
    return prefix;
  }

  function typeTagHtml(psType, count) {
    const t = String(psType || 'OTHER');
    const cls = `ro-type-tag ro-type-tag--${t.toLowerCase()}`;
    const label = count != null ? `${t} ${count}` : t;
    return `<span class="${cls}">${esc(label)}</span>`;
  }

  function typeTagsHtml(typeCounts, { activeOnly } = {}) {
    const entries = Object.entries(typeCounts || {})
      .filter(([type, count]) => count > 0 && (!activeOnly || state.psTypes.has(type)))
      .sort((a, b) => {
        const ai = PS_TYPE_ORDER.indexOf(a[0]);
        const bi = PS_TYPE_ORDER.indexOf(b[0]);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      });
    if (!entries.length) return '<span class="ro-dash">—</span>';
    return `<span class="ro-type-tags">${entries.map(([t, c]) => typeTagHtml(t, c)).join('')}</span>`;
  }

  function viewForRow(row) {
    const orders = (row.orders || []).filter((order) => state.psTypes.has(getPsType(order.ps_id)));
    const typeCounts = {};
    orders.forEach((order) => {
      const t = order.ps_type || getPsType(order.ps_id);
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    });
    const orderCount = orders.length;
    return {
      ...row,
      orders,
      type_counts: typeCounts,
      order_count: orderCount,
      is_repeat: orderCount >= 2,
    };
  }

  function haystack(row) {
    return [
      row.part_no,
      row.part_desc,
      row.bom_code,
      row.program_no,
      row.program_file,
      row.tool_list_file,
      ...(row.orders || []).map((o) => [o.ps_id, o.ps_type, o.status].join(' ')),
    ]
      .join(' ')
      .toLowerCase();
  }

  function filteredRows() {
    const q = state.search.trim().toLowerCase();
    return state.rows
      .map(viewForRow)
      .filter((row) => {
        if (row.order_count <= 0) return false;
        if (state.repeatsOnly && !row.is_repeat) return false;
        if (!q) return true;
        return haystack(row).includes(q);
      });
  }

  function typeCount(row, psType) {
    return Number((row.type_counts || {})[psType] || 0);
  }

  function sortedRows(rows) {
    const list = [...rows];
    const sort = state.sort || 'orders_desc';
    list.sort((a, b) => {
      if (sort === 'orders_asc') {
        return (a.order_count || 0) - (b.order_count || 0) || String(a.part_no).localeCompare(String(b.part_no));
      }
      if (sort === 'part_asc') {
        return String(a.part_no).localeCompare(String(b.part_no)) || String(a.bom_code).localeCompare(String(b.bom_code));
      }
      if (sort === 'part_desc') {
        return String(b.part_no).localeCompare(String(a.part_no)) || String(b.bom_code).localeCompare(String(a.bom_code));
      }
      if (sort === 'mps_desc') {
        return typeCount(b, 'MPS') - typeCount(a, 'MPS') || (b.order_count || 0) - (a.order_count || 0);
      }
      if (sort === 'aps_desc') {
        return typeCount(b, 'APS') - typeCount(a, 'APS') || (b.order_count || 0) - (a.order_count || 0);
      }
      if (sort === 'nps_desc') {
        return typeCount(b, 'NPS') - typeCount(a, 'NPS') || (b.order_count || 0) - (a.order_count || 0);
      }
      return (b.order_count || 0) - (a.order_count || 0) || String(a.part_no).localeCompare(String(b.part_no));
    });
    return list;
  }

  function psTypeLabel() {
    const panel = document.getElementById('ro-type-panel');
    if (!panel) return 'APS, NPS, [SR]';
    const checked = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value);
    if (!checked.length) return 'None';
    if (checked.length >= 6) return 'All types';
    return checked.join(', ');
  }

  function fileLinkHtml(value, label, titleText) {
    const text = String(value || '').trim();
    if (!text) return '<span class="ro-dash">—</span>';
    const href = text.startsWith('http') || text.startsWith('file:') || text.startsWith('\\\\')
      ? text
      : `file:///${text.replace(/\\/g, '/')}`;
    const title = String(titleText || text).trim();
    return `<a class="ro-file-link" href="${esc(href)}" title="${esc(title)}">${esc(label || text)}</a>`;
  }

  function programNoHtml(value) {
    const text = String(value || '').trim();
    if (!text) return '<span class="ro-dash">—</span>';
    return `<span class="ro-program-no" title="${esc(text)}">${esc(text)}</span>`;
  }

  function renderStats() {
    const el = document.getElementById('ro-stats');
    if (!el) return;
    const visible = sortedRows(filteredRows());
    const visibleOrders = visible.reduce((sum, row) => sum + (row.order_count || 0), 0);
    const typesLabel = psTypeLabel();
    el.innerHTML = [
      `<span class="ro-chip"><strong>${visible.length}</strong> groups shown</span>`,
      `<span class="ro-chip"><strong>${visibleOrders}</strong> process sheets (${esc(typesLabel)})</span>`,
      `<span class="ro-chip"><strong>${state.stats.repeat_groups || 0}</strong> repeat groups total</span>`,
    ].join('');
  }

  function psLabel(order) {
    return String(order.ps_id || '—').trim();
  }

  function qtyLabel(order) {
    const partials = Number(order.partial_count) || 1;
    const qty = order.partial_qty ?? order.total_qty ?? '—';
    if (partials > 1) {
      return `${qty} (${partials} partials)`;
    }
    return String(qty);
  }

  function statusPill(status) {
    const text = String(status || '—').trim() || '—';
    const lower = text.toLowerCase();
    let cls = 'ro-pill';
    if (lower === 'history') cls += ' ro-pill--history';
    else if (lower === 'released' || lower === 'r') cls += ' ro-pill--open';
    return `<span class="${cls}">${esc(text)}</span>`;
  }

  function renderLineTable(headers, rowsHtml, extraClass) {
    return `
      <div class="ro-lines-wrap ${extraClass || ''}">
        <table class="ro-lines">
          <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  function renderOrdersDetail(row) {
    const orders = row.orders || [];
    if (!orders.length) {
      return '<p class="ro-dash">No process sheets for selected types.</p>';
    }
    const rowsHtml = orders
      .map(
        (order) => `
        <tr>
          <td class="ro-lines-type">${typeTagHtml(order.ps_type || getPsType(order.ps_id))}</td>
          <td class="ro-lines-ps">${esc(psLabel(order))}</td>
          <td>${esc(fmtDate(order.order_date))}</td>
          <td>${esc(fmtDate(order.due_date))}</td>
          <td>${statusPill(order.status)}</td>
          <td class="ro-lines-qty">${esc(qtyLabel(order))}</td>
        </tr>
      `
      )
      .join('');
    return renderLineTable(
      ['Type', 'Process sheet', 'Order', 'Due', 'Status', 'Qty'],
      rowsHtml,
      'ro-lines-wrap--orders'
    );
  }

  function renderProgramsDetail(row) {
    const programs = row.programs || [];
    if (!programs.length) {
      return '<p class="ro-dash">No programme rows in master cycle times for this part + BOM.</p>';
    }
    const rowsHtml = programs
      .map(
        (prog) => `
        <tr>
          <td class="ro-lines-stage">${esc(prog.stage_no || '—')}</td>
          <td>${esc(prog.stage_name || prog.op_type || '—')}</td>
          <td class="ro-lines-mono">${esc(prog.program_no || '—')}</td>
          <td class="ro-lines-mono ro-lines-file" title="${esc(prog.program_file || '')}">${esc(prog.program_file || '—')}</td>
          <td class="ro-lines-mono ro-lines-file" title="${esc(prog.tool_list_file || '')}">${esc(prog.tool_list_file || '—')}</td>
        </tr>
      `
      )
      .join('');
    return renderLineTable(
      ['Stg', 'Stage', 'Programme', 'Program file', 'Tool list'],
      rowsHtml,
      'ro-lines-wrap--programs'
    );
  }

  function renderTable() {
    const body = document.getElementById('ro-table-body');
    const wrap = document.getElementById('ro-table-wrap');
    const empty = document.getElementById('ro-empty');
    if (!body || !wrap || !empty) return;

    const rows = sortedRows(filteredRows());
    renderStats();

    if (!rows.length) {
      body.innerHTML = '';
      wrap.hidden = true;
      empty.hidden = false;
      const noneTypes = state.psTypes.size === 0;
      empty.textContent = noneTypes
        ? 'Select at least one process sheet type (MPS, APS, NPS, …).'
        : 'No rows match your filters.';
      return;
    }

    wrap.hidden = false;
    empty.hidden = true;

    body.innerHTML = rows
      .map((row) => {
        const key = rowKey(row);
        const expanded = state.expandedKey === key;
        const countClass = row.is_repeat ? 'ro-count is-repeat' : 'ro-count';
        const toolLabel = row.tool_list_file ? 'Tools' : '';
        return `
          <tr class="${expanded ? 'is-expanded' : ''}" data-key="${esc(key)}">
            <td>
              <button type="button" class="ro-expand-btn" data-expand="${esc(key)}" aria-expanded="${expanded}" aria-label="${expanded ? 'Collapse details' : 'Expand details'}">
                ${expanded ? '▾' : '▸'}
              </button>
            </td>
            <td class="ro-part-no" title="${esc(row.part_no || '')}">${esc(row.part_no || '—')}</td>
            <td class="ro-desc" title="${esc(row.part_desc || '')}">${esc(row.part_desc || '—')}</td>
            <td class="ro-bom" title="${esc(row.bom_code || '')}">${esc(row.bom_code || '—')}</td>
            <td>${typeTagsHtml(row.type_counts, { activeOnly: true })}</td>
            <td class="ro-col-orders"><span class="${countClass}">${esc(row.order_count || 0)}</span></td>
            <td>${programNoHtml(row.program_no)}</td>
            <td>${fileLinkHtml(row.program_file, row.program_file ? 'Program' : '')}</td>
            <td>${fileLinkHtml(row.tool_list_file, toolLabel, 'Tool list')}</td>
          </tr>
          ${
            expanded
              ? `<tr class="ro-detail-row"><td colspan="9">
                  <div class="ro-detail-panels">
                    <section class="ro-detail-panel">
                      <div class="ro-detail-panel-head">Process sheets <span class="ro-detail-count">${esc(row.order_count || 0)}</span> ${typeTagsHtml(row.type_counts, { activeOnly: true })}</div>
                      ${renderOrdersDetail(row)}
                    </section>
                    <section class="ro-detail-panel">
                      <div class="ro-detail-panel-head">Programme</div>
                      ${renderProgramsDetail(row)}
                    </section>
                  </div>
                </td></tr>`
              : ''
          }
        `;
      })
      .join('');
  }

  async function loadRows(refresh) {
    const loading = document.getElementById('ro-loading');
    const wrap = document.getElementById('ro-table-wrap');
    const empty = document.getElementById('ro-empty');
    if (loading) loading.hidden = false;
    if (wrap) wrap.hidden = true;
    if (empty) empty.hidden = true;

    const params = new URLSearchParams();
    if (state.repeatsOnly) params.set('repeats_only', '1');
    if (refresh) params.set('refresh', '1');

    try {
      const res = await fetch(`/api/planning-data/repeat-orders?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
      state.rows = data.rows || [];
      state.stats = data.stats || {};
      renderTable();
    } catch (err) {
      if (empty) {
        empty.hidden = false;
        empty.textContent = `Failed to load repeat orders: ${err.message || err}`;
      }
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function bindPsTypeDropdown() {
    const dropdown = document.getElementById('ro-type-dropdown');
    const btn = document.getElementById('ro-type-btn');
    const panel = document.getElementById('ro-type-panel');
    if (!dropdown || !btn || !panel) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
    });

    document.addEventListener('click', () => {
      panel.hidden = true;
    });

    panel.addEventListener('click', (e) => e.stopPropagation());

    panel.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', () => {
        state.psTypes = new Set(
          [...panel.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value)
        );
        btn.textContent = `${psTypeLabel()} ▾`;
        renderTable();
      });
    });

    btn.textContent = `${psTypeLabel()} ▾`;
  }

  function bindEvents() {
    bindPsTypeDropdown();

    document.getElementById('ro-search')?.addEventListener('input', (event) => {
      state.search = event.target.value || '';
      renderTable();
    });

    document.getElementById('ro-sort')?.addEventListener('change', (event) => {
      state.sort = event.target.value || 'orders_desc';
      renderTable();
    });

    document.getElementById('ro-repeats-only')?.addEventListener('change', (event) => {
      state.repeatsOnly = !!event.target.checked;
      loadRows(false);
    });

    document.getElementById('ro-refresh')?.addEventListener('click', () => loadRows(true));

    document.getElementById('ro-table-body')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-expand]');
      if (!btn) return;
      const key = btn.getAttribute('data-expand') || '';
      state.expandedKey = state.expandedKey === key ? '' : key;
      renderTable();
    });
  }

  bindEvents();
  loadRows(false);
})();
