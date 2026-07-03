// Kobelco MPS archive — ERP read matching Power Query export columns.

const kmaState = {
  rows: [],
  search: '',
  cachedAt: '',
  cacheTtlSec: 300,
};

function kmaFormatDate(value) {
  if (!value) return '—';
  const text = String(value).trim();
  if (!text) return '—';
  const d = new Date(text.includes('T') ? text : text.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return text;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function kmaFormatQty(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return escapeHtml(String(value));
  return Number.isInteger(n) ? String(n) : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function kmaSearchHaystack(row) {
  return [
    row.pk_so,
    row.posted_date,
    row.ps_number,
    row.sales_quotation_no,
    row.customer_code,
    row.line_item_no,
    row.dwg_pn,
    row.sn,
    row.description,
    row.customer_po_no,
    row.qty,
    row.due_date,
    row.inspection_report_no,
    row.coc_no,
    row.line_item_description,
    row.segment_1_code,
  ]
    .filter((v) => v != null && String(v).trim() !== '')
    .join(' ')
    .toLowerCase();
}

function kmaFilteredRows() {
  const search = kmaState.search.trim().toLowerCase();
  if (!search) return kmaState.rows;
  return kmaState.rows.filter((row) => kmaSearchHaystack(row).includes(search));
}

function kmaRenderStats() {
  const statsEl = document.getElementById('kma-stats');
  if (!statsEl) return;
  const visible = kmaFilteredRows().length;
  const total = kmaState.rows.length;
  statsEl.innerHTML = `
    <span class="new-orders-stat"><strong>${visible}</strong> shown</span>
    <span class="new-orders-stat"><strong>${total}</strong> total</span>
  `;
}

function kmaRenderMeta() {
  const meta = document.getElementById('kma-meta');
  if (!meta) return;
  if (!kmaState.cachedAt) {
    meta.hidden = true;
    return;
  }
  meta.hidden = false;
  meta.textContent = `Source: synced ERP staging · cached ${kmaState.cachedAt} · TTL ${kmaState.cacheTtlSec}s · run Sync ERP to refresh`;
}

function kmaCell(text, className = '') {
  const display = text == null || String(text).trim() === '' ? '—' : escapeHtml(String(text));
  return className ? `<td class="${className}">${display}</td>` : `<td>${display}</td>`;
}

function kmaRenderTable() {
  const wrap = document.getElementById('kma-table-wrap');
  const body = document.getElementById('kma-table-body');
  const empty = document.getElementById('kma-empty');
  const emptyText = document.getElementById('kma-empty-text');
  if (!wrap || !body || !empty) return;

  const rows = kmaFilteredRows();
  kmaRenderStats();

  if (!kmaState.rows.length) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = 'No Kobelco MPS rows returned from ERP.';
    return;
  }

  if (!rows.length) {
    wrap.hidden = true;
    empty.hidden = false;
    if (emptyText) emptyText.textContent = 'No rows match your search.';
    return;
  }

  wrap.hidden = false;
  empty.hidden = true;
  body.innerHTML = rows.map((row) => `
    <tr>
      ${kmaCell(row.pk_so)}
      ${kmaCell(kmaFormatDate(row.posted_date))}
      ${kmaCell(row.ps_number)}
      ${kmaCell(row.sales_quotation_no)}
      ${kmaCell(row.customer_code)}
      ${kmaCell(row.line_item_no)}
      ${kmaCell(row.dwg_pn)}
      ${kmaCell(row.sn)}
      ${kmaCell(row.description, 'kma-desc')}
      ${kmaCell(row.customer_po_no)}
      <td>${kmaFormatQty(row.qty)}</td>
      ${kmaCell(kmaFormatDate(row.due_date))}
      ${kmaCell(row.blank1)}
      ${kmaCell(row.blank2)}
      ${kmaCell(row.inspection_report_no)}
      ${kmaCell(row.coc_no)}
      ${kmaCell(row.line_item_description, 'kma-line-desc')}
      ${kmaCell(row.segment_1_code)}
    </tr>
  `).join('');
}

async function kmaLoad({ force = false } = {}) {
  const loading = document.getElementById('kma-loading');
  if (loading) loading.hidden = false;

  try {
    const url = force ? '/api/kobelco-mps-archive?refresh=1' : '/api/kobelco-mps-archive';
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    kmaState.rows = Array.isArray(data.rows) ? data.rows : [];
    kmaState.cachedAt = data.cached_at || '';
    kmaState.cacheTtlSec = data.cache_ttl_sec || 300;
    kmaRenderMeta();
    kmaRenderTable();
  } catch (err) {
    kmaState.rows = [];
    kmaRenderTable();
    const empty = document.getElementById('kma-empty');
    const emptyText = document.getElementById('kma-empty-text');
    if (empty) empty.hidden = false;
    if (emptyText) emptyText.textContent = `Failed to load: ${err.message || err}`;
  } finally {
    if (loading) loading.hidden = true;
  }
}

function kmaCopyVisiblePs() {
  const psList = kmaFilteredRows()
    .map((row) => String(row.ps_number || '').trim())
    .filter(Boolean);
  const unique = [...new Set(psList)];
  if (!unique.length) return;
  const text = unique.join('\n');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

document.getElementById('kma-search')?.addEventListener('input', (event) => {
  kmaState.search = event.target.value || '';
  kmaRenderTable();
});

document.getElementById('kma-refresh')?.addEventListener('click', () => kmaLoad({ force: true }));
document.getElementById('kma-copy-ps')?.addEventListener('click', kmaCopyVisiblePs);

kmaLoad();
