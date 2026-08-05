/* Sales Coordination - read-only process-sheet delivery commitments */

const SC_PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
const SC_DEFAULT_PS_TYPES = ['APS', 'NPS', 'PPS'];

const scState = {
  lines: [],
  loading: false,
  search: '',
  psTypes: new Set(SC_DEFAULT_PS_TYPES),
  sortCol: 'commitment_date',
  sortDir: 'asc',
  _typesInitialized: false,
};

const SC_SORT_FALLBACK = {
  commitment_date: '9999-12-31',
  due_date: '9999-12-31',
  proposed_edd: '9999-12-31',
  week: '9999-12-31',
};

function scEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scFormatDate(value) {
  const text = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text || '-';
  const [y, m, d] = text.split('-');
  return `${d}/${m}/${y}`;
}

function scPsDisplay(row) {
  const ps = String(row?.process_sheet_no || row?.pp_voucher_no || '').trim();
  const partial = Number(row?.pp_partial_no);
  if (ps && Number.isFinite(partial) && partial > 1) return `${ps}/${partial}`;
  return ps || '-';
}

function scPsType(row) {
  const typed = String(row?.ps_type || '').trim().toUpperCase();
  if (typed) return typed;
  const ps = String(row?.process_sheet_no || row?.pp_voucher_no || '').trim().toUpperCase();
  if (ps.startsWith('[SR]') || ps.startsWith('SR')) return 'SR';
  for (const prefix of SC_PS_TYPES) {
    if (ps.startsWith(prefix)) return prefix;
  }
  return '';
}

function scEls() {
  return {
    search: document.getElementById('sc-search'),
    typeChips: document.getElementById('sc-type-chips'),
    meta: document.getElementById('sc-meta'),
    clearFilters: document.getElementById('sc-clear-filters'),
    loading: document.getElementById('sc-loading'),
    alert: document.getElementById('sc-alert'),
    panel: document.getElementById('sc-table-panel'),
    body: document.getElementById('sc-body'),
    empty: document.getElementById('sc-empty'),
    refresh: document.getElementById('sc-refresh'),
    table: document.getElementById('sc-table'),
  };
}

function scSetLoading(on) {
  const { loading, panel } = scEls();
  scState.loading = on;
  if (loading) loading.hidden = !on;
  if (panel && on) panel.hidden = true;
}

function scShowAlert(message) {
  const { alert } = scEls();
  if (!alert) return;
  if (!message) {
    alert.hidden = true;
    alert.textContent = '';
    return;
  }
  alert.hidden = false;
  alert.textContent = message;
}

function scRenderTypeChips() {
  const { typeChips } = scEls();
  if (!typeChips) return;
  typeChips.innerHTML = SC_PS_TYPES.map((type) => {
    const active = scState.psTypes.has(type) ? ' is-active' : '';
    return `<button type="button" class="sc-type-chip${active}" data-sc-type="${scEscape(type)}" aria-pressed="${scState.psTypes.has(type) ? 'true' : 'false'}">${scEscape(type)}</button>`;
  }).join('');
}

function scHasActiveFilters() {
  if (scState.search.trim()) return true;
  if (scState.psTypes.size !== SC_DEFAULT_PS_TYPES.length) return true;
  for (const type of SC_DEFAULT_PS_TYPES) {
    if (!scState.psTypes.has(type)) return true;
  }
  return false;
}

function scUpdateClearButton() {
  const { clearFilters } = scEls();
  if (clearFilters) clearFilters.hidden = !scHasActiveFilters();
}

function scMatchesSearch(row, needle) {
  if (!needle) return true;
  const hay = [
    row.process_sheet_no,
    row.pp_voucher_no,
    row.sales_order_no,
    row.part_no,
    row.part_desc,
    row.customer_po_no,
    row.customer_name,
    row.due_date,
    row.proposed_edd,
    row.week,
  ]
    .map((v) => String(v || '').toLowerCase())
    .join(' ');
  return hay.includes(needle);
}

function scFilteredLines() {
  const needle = scState.search.trim().toLowerCase();
  return (scState.lines || []).filter((row) => {
    const type = scPsType(row);
    if (scState.psTypes.size && !scState.psTypes.has(type)) return false;
    return scMatchesSearch(row, needle);
  });
}

function scSortValue(row, col) {
  if (col === 'week') return row.commitment_date || SC_SORT_FALLBACK.week;
  if (col === 'process_sheet_no') return scPsDisplay(row).toLowerCase();
  const raw = row?.[col];
  if (raw == null || raw === '') return SC_SORT_FALLBACK[col] ?? '';
  if (typeof raw === 'number') return raw;
  return String(raw).toLowerCase();
}

function scSortedLines(lines) {
  const col = scState.sortCol || 'commitment_date';
  const dir = scState.sortDir === 'desc' ? -1 : 1;
  return [...lines].sort((a, b) => {
    const av = scSortValue(a, col);
    const bv = scSortValue(b, col);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return String(a.process_sheet_no || '').localeCompare(String(b.process_sheet_no || ''));
  });
}

function scRenderPartCell(row) {
  const part = String(row.part_no || '-');
  const badges = [];
  if (row.is_new_part) {
    badges.push('<span class="sc-new-badge" title="New part - no prior process sheet history">NEW</span>');
  }
  if (row.is_frame_agreement) {
    badges.push('<span class="sc-fa-badge" title="Frame agreement part">FA</span>');
  }
  return `<td class="sc-part-cell"><span class="sc-part-text">${scEscape(part)}</span>${badges.join('')}</td>`;
}

function scRenderPropEdd(row) {
  const value = String(row.proposed_edd || '').trim();
  if (!value) {
    return '<td class="sc-date sc-date--prop is-empty">-</td>';
  }
  return `<td class="sc-date sc-date--prop">${scEscape(scFormatDate(value))}</td>`;
}

function scUpdateSortHeaders() {
  const { table } = scEls();
  if (!table) return;
  table.querySelectorAll('th[data-sort]').forEach((th) => {
    const col = th.getAttribute('data-sort');
    th.classList.remove('is-sorted-asc', 'is-sorted-desc');
    if (col === scState.sortCol) {
      th.classList.add(scState.sortDir === 'desc' ? 'is-sorted-desc' : 'is-sorted-asc');
    }
  });
}

function scRenderTable() {
  const { body, empty, panel, meta } = scEls();
  if (!body) return;

  const filtered = scSortedLines(scFilteredLines());
  scUpdateSortHeaders();
  scUpdateClearButton();

  if (panel) panel.hidden = false;
  if (meta) {
    const total = scState.lines.length;
    meta.textContent = `${filtered.length.toLocaleString()} of ${total.toLocaleString()} process sheet line${total === 1 ? '' : 's'}`;
  }

  if (!filtered.length) {
    body.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  body.innerHTML = filtered.map((row) => `
    <tr>
      <td class="sc-mono">${scEscape(scPsDisplay(row))}</td>
      <td class="sc-mono">${scEscape(row.sales_order_no || '-')}</td>
      ${scRenderPartCell(row)}
      <td>${scEscape(row.part_desc || '-')}</td>
      <td class="sc-mono">${scEscape(row.customer_po_no || '-')}</td>
      <td class="sc-date">${scEscape(scFormatDate(row.due_date))}</td>
      ${scRenderPropEdd(row)}
      <td>${scEscape(row.week || '-')}</td>
    </tr>
  `).join('');
}

async function scLoad({ refresh = false } = {}) {
  const { refresh: refreshBtn } = scEls();
  scShowAlert('');
  scSetLoading(true);
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const url = refresh ? '/api/sales-coordination?refresh=1' : '/api/sales-coordination';
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    scState.lines = Array.isArray(data.lines) ? data.lines : [];
    if (!scState._typesInitialized) {
      scState._typesInitialized = true;
      scRenderTypeChips();
    }
    scRenderTable();
  } catch (err) {
    scShowAlert(err.message || 'Could not load sales coordination data.');
    const { panel, meta } = scEls();
    if (panel) panel.hidden = true;
    if (meta) meta.textContent = 'Failed to load';
  } finally {
    scSetLoading(false);
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function scBindEvents() {
  const els = scEls();

  els.search?.addEventListener('input', () => {
    scState.search = els.search.value || '';
    scRenderTable();
  });

  els.typeChips?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sc-type]');
    if (!btn) return;
    const type = btn.getAttribute('data-sc-type');
    if (!type) return;
    if (scState.psTypes.has(type)) scState.psTypes.delete(type);
    else scState.psTypes.add(type);
    scRenderTypeChips();
    scRenderTable();
  });

  els.clearFilters?.addEventListener('click', () => {
    scState.search = '';
    if (els.search) els.search.value = '';
    scState.psTypes = new Set(SC_DEFAULT_PS_TYPES);
    scRenderTypeChips();
    scRenderTable();
  });

  els.refresh?.addEventListener('click', () => scLoad({ refresh: true }));

  els.table?.querySelector('thead')?.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const col = th.getAttribute('data-sort');
    if (!col) return;
    if (scState.sortCol === col) {
      scState.sortDir = scState.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      scState.sortCol = col;
      scState.sortDir = 'asc';
    }
    scRenderTable();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  scRenderTypeChips();
  scBindEvents();
  scLoad();
});
