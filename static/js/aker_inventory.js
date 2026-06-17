// Aker Inventory — local Excel workbook (all sheets via /api/local-excel).

const akerState = {
  path: '',
  sheetNames: [],
  sheets: {},
  sheetMeta: {},
  activeSheet: '',
  search: '',
};

function akerEscapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function akerFormatLabel(key) {
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function akerFormatCell(value) {
  if (value == null || value === '') return '—';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return String(value);
}

function akerActiveSheetMeta() {
  return akerState.sheetMeta[akerState.activeSheet] || {};
}

function akerActiveColumns(allRows) {
  const metaCols = akerActiveSheetMeta().columns;
  if (Array.isArray(metaCols) && metaCols.length) {
    return metaCols.map((col) => ({
      key: col.key,
      label: col.label || akerFormatLabel(col.key),
    }));
  }
  return akerColumnKeys(allRows).map((key) => ({ key, label: akerFormatLabel(key) }));
}

function akerSheetRows(sheetName) {
  return akerState.sheets[sheetName] || [];
}

function akerColumnKeys(rows) {
  const keys = [];
  const seen = new Set();
  rows.forEach((row) => {
    Object.keys(row || {}).forEach((key) => {
      if (!key || seen.has(key)) return;
      seen.add(key);
      keys.push(key);
    });
  });
  return keys;
}

function akerRowMatchesSearch(row, query) {
  if (!query) return true;
  const hay = Object.values(row || {})
    .map((value) => (value == null ? '' : String(value)))
    .join(' ')
    .toLowerCase();
  return hay.includes(query.toLowerCase());
}

function akerFilteredRows() {
  const rows = akerSheetRows(akerState.activeSheet);
  const query = akerState.search.trim();
  if (!query) return rows;
  return rows.filter((row) => akerRowMatchesSearch(row, query));
}

function akerSyncTabButtons() {
  document.querySelectorAll('[data-aker-sheet]').forEach((btn) => {
    const active = btn.getAttribute('data-aker-sheet') === akerState.activeSheet;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function akerSetActiveSheet(sheetName) {
  if (!sheetName || !akerState.sheetNames.includes(sheetName)) return;
  akerState.activeSheet = sheetName;
  akerSyncTabButtons();
  akerRenderTable();
}

function akerRenderSheetTabs() {
  const host = document.getElementById('aker-sheet-tabs');
  if (!host) return;
  host.innerHTML = '';
  akerState.sheetNames.forEach((name) => {
    const count = akerSheetRows(name).length;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mi-view-btn';
    btn.setAttribute('data-aker-sheet', name);
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.innerHTML = `${akerEscapeHtml(name)} <span class="inv-enq-tab-count">${count}</span>`;
    btn.addEventListener('click', () => akerSetActiveSheet(name));
    host.appendChild(btn);
  });
  akerSyncTabButtons();
}

function akerUpdateStats() {
  const stats = document.getElementById('aker-stats');
  if (!stats) return;
  const totalRows = akerState.sheetNames.reduce(
    (sum, name) => sum + akerSheetRows(name).length,
    0,
  );
  stats.textContent = `${akerState.sheetNames.length} sheet${akerState.sheetNames.length === 1 ? '' : 's'} · ${totalRows} row${totalRows === 1 ? '' : 's'}`;
}

function akerRenderTable() {
  const loading = document.getElementById('aker-loading');
  const section = document.getElementById('aker-table-section');
  const globalEmpty = document.getElementById('aker-global-empty');
  const hasSheets = akerState.sheetNames.length > 0;

  if (loading) loading.hidden = true;
  if (globalEmpty) globalEmpty.hidden = hasSheets;

  if (!hasSheets) {
    if (section) section.hidden = true;
    return;
  }

  const filtered = akerFilteredRows();
  const allRows = akerSheetRows(akerState.activeSheet);
  const columns = akerActiveColumns(allRows);
  const sheetMeta = akerActiveSheetMeta().meta || {};

  const title = document.getElementById('aker-section-title');
  if (title) {
    const materialType = sheetMeta.material_type ? ` · ${sheetMeta.material_type}` : '';
    title.textContent = `${akerState.activeSheet || 'Sheet'}${materialType}`;
  }

  const countEl = document.getElementById('aker-row-count');
  if (countEl) {
    countEl.textContent = `${filtered.length} row${filtered.length === 1 ? '' : 's'}`;
  }

  const emptyEl = document.getElementById('aker-table-empty');
  if (emptyEl) emptyEl.hidden = filtered.length > 0;

  const thead = document.getElementById('aker-table-head');
  const tbody = document.getElementById('aker-table-body');
  if (!thead || !tbody) return;

  thead.innerHTML = `<tr>${columns.map((col) => `<th>${akerEscapeHtml(col.label)}</th>`).join('')}</tr>`;

  if (!filtered.length) {
    tbody.innerHTML = '';
  } else {
    tbody.innerHTML = filtered.map((row) => {
      const cells = columns.map((col) => {
        const raw = row?.[col.key];
        const text = akerFormatCell(raw);
        const mono = typeof raw === 'number' || /^\d/.test(String(raw || ''));
        return `<td${mono ? ' class="aker-inv-cell--num"' : ''}>${akerEscapeHtml(text)}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
  }

  if (section) section.hidden = false;

  const meta = document.getElementById('aker-meta');
  if (meta) {
    meta.hidden = false;
    const fileName = akerState.path ? akerState.path.split(/[/\\]/).pop() : 'workbook';
    meta.textContent = `Source: ${fileName} · path set via LOCAL_EXCEL_PATH`;
  }
}

function akerRender() {
  akerRenderSheetTabs();
  akerUpdateStats();
  akerRenderTable();
}

async function akerLoad({ refresh = false } = {}) {
  const loading = document.getElementById('aker-loading');
  const globalEmpty = document.getElementById('aker-global-empty');
  if (loading) loading.hidden = false;
  if (globalEmpty) globalEmpty.hidden = true;

  try {
    const url = '/api/local-excel?all_sheets=1' + (refresh ? '&refresh=1' : '');
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

    akerState.path = data.path || '';
    akerState.sheetNames = data.sheet_names || Object.keys(data.sheets || {});
    akerState.sheets = data.sheets || {};
    akerState.sheetMeta = data.sheet_meta || {};

    const prev = akerState.activeSheet;
    if (!prev || !akerState.sheetNames.includes(prev)) {
      akerState.activeSheet = akerState.sheetNames[0] || '';
    }

    akerRender();
    if (refresh && typeof toast === 'function') toast('Workbook refreshed', 'success');
  } catch (err) {
    if (loading) loading.hidden = true;
    const section = document.getElementById('aker-table-section');
    if (section) section.hidden = true;
    if (globalEmpty) {
      globalEmpty.hidden = false;
      const p = globalEmpty.querySelector('p');
      if (p) p.textContent = `Failed to load workbook: ${err.message}`;
    }
    if (typeof toast === 'function') toast(err.message, 'error');
  }
}

function akerBindEvents() {
  document.getElementById('aker-refresh')?.addEventListener('click', () => akerLoad({ refresh: true }));

  const search = document.getElementById('aker-search');
  let debounce = null;
  search?.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      akerState.search = search.value.trim();
      akerRenderTable();
    }, 200);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  akerBindEvents();
  akerLoad();
});
