// Preferred machines archive — live planner sync + completion history.

const pmState = {
  items: [],
  filter: 'all',
  sortCol: 'part_no',
  sortDir: 'asc',
  search: '',
  cachedAt: '',
  cacheTtlSec: 60,
  selectedKey: '',
  stats: null,
};

function pmRowKey(row) {
  return `${row?.part_no || ''}::${row?.bom_code || ''}`;
}

function pmSearchHaystack(row) {
  return [
    row.part_no,
    row.part_desc,
    row.bom_code,
    row.bom_desc,
    row.preferred_summary,
    row.history_summary,
    row.process_sheets_text,
    ...(row.unique_machines || []),
    ...(row.process_sheets || []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function pmFilteredItems() {
  const search = pmState.search.trim().toLowerCase();
  return pmState.items.filter((row) => {
    if (pmState.filter === 'missing' && !(row.missing_preferred_count > 0)) return false;
    if (pmState.filter === 'history' && !(row.history_machine_count > 0)) return false;
    if (pmState.filter === 'mismatch' && !(row.erp_mismatch_count > 0)) return false;
    if (search && !pmSearchHaystack(row).includes(search)) return false;
    return true;
  });
}

function pmSortValue(row, col) {
  if (col === 'ps_count') return Number(row.ps_count || 0);
  if (col === 'bom_code') return String(row.bom_code || '').toLowerCase();
  return String(row.part_no || '').toLowerCase();
}

function pmSortedItems(items) {
  const col = pmState.sortCol;
  const dir = pmState.sortDir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const av = pmSortValue(a, col);
    const bv = pmSortValue(b, col);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    const bomCmp = String(a.bom_code || '').localeCompare(String(b.bom_code || ''));
    if (bomCmp !== 0) return bomCmp;
    return String(a.part_no || '').localeCompare(String(b.part_no || ''));
  });
}

function pmUpdateSortIcons() {
  document.querySelectorAll('[data-pm-sort-icon]').forEach((el) => {
    const col = el.getAttribute('data-pm-sort-icon');
    if (col === pmState.sortCol) {
      el.textContent = pmState.sortDir === 'asc' ? '↑' : '↓';
      el.classList.add('is-active');
    } else {
      el.textContent = '↕';
      el.classList.remove('is-active');
    }
  });
}

function pmRenderStats() {
  const statsEl = document.getElementById('pm-stats');
  if (!statsEl) return;
  const visible = pmFilteredItems().length;
  const total = pmState.items.length;
  const s = pmState.stats || {};
  statsEl.innerHTML = `
    <span class="new-orders-stat"><strong>${visible}</strong> shown</span>
    <span class="new-orders-stat"><strong>${total}</strong> groups</span>
    <span class="new-orders-stat"><strong>${s.history_groups || 0}</strong> with history</span>
  `;

  const setCount = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(value);
    el.hidden = false;
  };
  setCount('pm-count-all', pmState.items.length);
  setCount('pm-count-missing', pmState.items.filter((r) => r.missing_preferred_count > 0).length);
  setCount('pm-count-history', pmState.items.filter((r) => r.history_machine_count > 0).length);
  setCount('pm-count-mismatch', pmState.items.filter((r) => r.erp_mismatch_count > 0).length);
}

function pmRenderMeta() {
  const meta = document.getElementById('pm-meta');
  if (!meta) return;
  if (!pmState.cachedAt) {
    meta.hidden = true;
    return;
  }
  meta.hidden = false;
  meta.textContent = `Synced from planner · cached ${pmState.cachedAt.replace('T', ' ')} · TTL ${pmState.cacheTtlSec}s`;
}

function pmFlagPills(row) {
  const pills = [];
  if (row.is_default) {
    pills.push('<span class="mi-status-pill mi-status-pill--r" title="Default BOM for part">Default</span>');
  }
  if (row.missing_preferred_count > 0) {
    pills.push(`<span class="mi-status-pill mi-status-pill--o" title="${row.missing_preferred_count} machining op(s) without preferred machine">Missing ${row.missing_preferred_count}</span>`);
  }
  if (row.history_machine_count > 0) {
    pills.push(`<span class="mi-status-pill mi-status-pill--history" title="Completed on ${row.history_machine_count} machine(s)">History ${row.history_machine_count}</span>`);
  }
  if (row.erp_mismatch_count > 0) {
    pills.push(`<span class="mi-status-pill mi-status-pill--warn" title="${row.erp_mismatch_count} op(s) where planner preferred != ERP machine_no">ERP Δ ${row.erp_mismatch_count}</span>`);
  }
  return pills.length ? pills.join(' ') : '—';
}

function pmTruncCell(text, wasTruncated, fullText) {
  const display = escapeHtml(text || '—');
  if (!wasTruncated) return display;
  return `<span class="pm-trunc" title="${escapeHtml(fullText || text || '')}">${display}</span>`;
}

function pmFormatHistoryList(history) {
  if (!Array.isArray(history) || !history.length) return '—';
  return history
    .map((item) => {
      const machine = escapeHtml(item.machine_no || '—');
      const qty = Number(item.good_qty || 0);
      const count = Number(item.completion_count || 0);
      const when = String(item.last_completed_at || '').replace('T', ' ').slice(0, 16);
      const suffix = qty > 0 ? ` · ${qty} good` : '';
      const runs = count > 1 ? ` · ${count} runs` : '';
      return `<span class="pm-pill pm-pill--history" title="${when}">${machine}${suffix}${runs}</span>`;
    })
    .join(' ');
}

function pmRenderTable() {
  const loading = document.getElementById('pm-loading');
  const wrap = document.getElementById('pm-table-wrap');
  const empty = document.getElementById('pm-empty');
  const body = document.getElementById('pm-table-body');
  if (!body) return;

  const items = pmSortedItems(pmFilteredItems());
  pmRenderStats();
  pmUpdateSortIcons();
  pmRenderMeta();

  if (loading) loading.hidden = true;

  if (!items.length) {
    if (wrap) wrap.hidden = true;
    if (empty) {
      empty.hidden = false;
      const text = document.getElementById('pm-empty-text');
      if (text) {
        text.textContent = pmState.items.length
          ? 'No part + BOM groups match the current filter.'
          : 'No planner BOM flows found.';
      }
    }
    body.innerHTML = '';
    return;
  }

  if (wrap) wrap.hidden = false;
  if (empty) empty.hidden = true;

  body.innerHTML = items
    .map((row) => {
      const key = pmRowKey(row);
      const selected = key === pmState.selectedKey ? ' is-selected' : '';
      const bomLabel = row.bom_desc
        ? `${escapeHtml(row.bom_code)}<span class="pm-bom-desc"> · ${escapeHtml(row.bom_desc)}</span>`
        : escapeHtml(row.bom_code || '—');
      return `
        <tr class="pm-row${selected}" data-pm-key="${escapeHtml(key)}" tabindex="0" role="button" aria-label="Open detail for ${escapeHtml(row.part_no)} ${escapeHtml(row.bom_code)}">
          <td class="pm-part-cell"><code>${escapeHtml(row.part_no || '—')}</code></td>
          <td class="pm-desc-cell">${escapeHtml(row.part_desc || '—')}</td>
          <td class="pm-bom-cell">${bomLabel}</td>
          <td class="pm-pref-cell">${pmTruncCell(row.preferred_summary_truncated, row.preferred_summary_was_truncated, row.preferred_summary)}</td>
          <td class="pm-history-cell">${pmTruncCell(row.history_summary_truncated, row.history_summary_was_truncated, row.history_summary)}</td>
          <td class="pm-ps-cell">${pmTruncCell(row.process_sheets_truncated, row.process_sheets_was_truncated, row.process_sheets_text)}</td>
          <td class="pm-count-cell">${Number(row.ps_count || 0)}</td>
          <td class="pm-flags-cell">${pmFlagPills(row)}</td>
        </tr>
      `;
    })
    .join('');
}

function pmRenderDetail(row) {
  const panel = document.getElementById('pm-detail');
  const title = document.getElementById('pm-detail-title');
  const body = document.getElementById('pm-detail-body');
  if (!panel || !title || !body || !row) return;

  title.textContent = `${row.part_no || '—'} · ${row.bom_code || '—'}`;
  const ops = row.machining_ops || [];
  const allOps = row.operations || [];
  const psList = (row.process_sheets || []).map((ps) => `<li><code>${escapeHtml(ps)}</code></li>`).join('');

  const opRows = ops.length
    ? ops
        .map((op) => {
          const preferred = escapeHtml(op.preferred_machine || '—');
          const erp = escapeHtml(op.erp_machine_no || '—');
          const history = op.completion_history || [];
          const historyCell = pmFormatHistoryList(history);
          const mismatch =
            op.preferred_machine && op.erp_machine_no && op.preferred_machine !== op.erp_machine_no
              ? ' pm-op-row--mismatch'
              : '';
          const missing = !op.preferred_machine ? ' pm-op-row--missing' : '';
          const hasHistory = Array.isArray(history) && history.length ? ' pm-op-row--history' : '';
          return `
            <tr class="${mismatch}${missing}${hasHistory}">
              <td>${escapeHtml(String(op.seq_no || ''))}</td>
              <td><code>${escapeHtml(op.op_no || '—')}</code></td>
              <td>${escapeHtml(op.op_type || '—')}</td>
              <td><strong>${preferred}</strong></td>
              <td>${historyCell}</td>
              <td>${erp}</td>
            </tr>
          `;
        })
        .join('')
    : `<tr><td colspan="6">No machining operations on this BOM.</td></tr>`;

  body.innerHTML = `
    <section class="new-orders-detail-section">
      <h3 class="new-orders-detail-section-title">Part</h3>
      <dl class="new-orders-detail-grid">
        <div class="new-orders-detail-field"><dt>Part no</dt><dd class="new-orders-detail-value new-orders-detail-value--mono">${escapeHtml(row.part_no || '—')}</dd></div>
        <div class="new-orders-detail-field"><dt>Description</dt><dd class="new-orders-detail-value">${escapeHtml(row.part_desc || '—')}</dd></div>
        <div class="new-orders-detail-field"><dt>BOM</dt><dd class="new-orders-detail-value">${escapeHtml(row.bom_code || '—')}${row.bom_desc ? ` — ${escapeHtml(row.bom_desc)}` : ''}</dd></div>
        <div class="new-orders-detail-field"><dt>Source</dt><dd class="new-orders-detail-value">${escapeHtml(row.bom_source_kind || 'ERP')}${row.is_default ? ' · default BOM' : ''}</dd></div>
      </dl>
    </section>
    <section class="new-orders-detail-section">
      <h3 class="new-orders-detail-section-title">Routing (${ops.length} machining / ${allOps.length} total ops)</h3>
      <div class="pm-detail-summary">
        <div><span class="pm-pill pm-pill--live">Live</span> <code>${escapeHtml(row.preferred_summary || '—')}</code></div>
        <div style="margin-top:8px"><span class="pm-pill pm-pill--history">History</span> <code>${escapeHtml(row.history_summary || '—')}</code></div>
      </div>
      <div class="new-orders-table-wrap pm-detail-table-wrap">
        <table class="new-orders-table pm-detail-table">
          <thead>
            <tr>
              <th>Seq</th>
              <th>Op</th>
              <th>Type</th>
              <th>Preferred (live)</th>
              <th>Completed on</th>
              <th>ERP machine</th>
            </tr>
          </thead>
          <tbody>${opRows}</tbody>
        </table>
      </div>
    </section>
    <section class="new-orders-detail-section">
      <h3 class="new-orders-detail-section-title">Process sheets (${row.ps_count || 0})</h3>
      ${psList ? `<ul class="pm-ps-list">${psList}</ul>` : '<p class="pm-detail-empty">No process sheets linked in pp_vouchers_cache for this part + BOM.</p>'}
    </section>
  `;

  document.body.classList.add('new-orders-detail-open');
  panel.hidden = false;
}

function pmCloseDetail() {
  const panel = document.getElementById('pm-detail');
  if (panel) panel.hidden = true;
  document.body.classList.remove('new-orders-detail-open');
  pmState.selectedKey = '';
  pmRenderTable();
}

function pmOpenDetailByKey(key) {
  const row = pmState.items.find((item) => pmRowKey(item) === key);
  if (!row) return;
  pmState.selectedKey = key;
  pmRenderTable();
  pmRenderDetail(row);
}

async function pmLoad({ refresh = false } = {}) {
  const loading = document.getElementById('pm-loading');
  const wrap = document.getElementById('pm-table-wrap');
  const empty = document.getElementById('pm-empty');
  if (loading) loading.hidden = false;
  if (wrap) wrap.hidden = true;
  if (empty) empty.hidden = true;

  try {
    const params = new URLSearchParams();
    if (refresh) {
      params.set('refresh', '1');
      params.set('reconcile', '1');
    }
    const url = params.toString() ? `/api/preferred-machines?${params}` : '/api/preferred-machines';
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    pmState.items = Array.isArray(data.rows) ? data.rows : [];
    pmState.stats = data.stats || null;
    pmState.cachedAt = data.cached_at || '';
    pmState.cacheTtlSec = Number(data.cache_ttl_sec || 60);
    pmRenderTable();
  } catch (err) {
    if (loading) loading.hidden = true;
    if (empty) {
      empty.hidden = false;
      const text = document.getElementById('pm-empty-text');
      if (text) text.textContent = `Failed to load preferred machines: ${err.message || err}`;
    }
  }
}

function pmExportCsv() {
  const items = pmSortedItems(pmFilteredItems());
  if (!items.length) return;
  const headers = [
    'Part No',
    'Part Description',
    'BOM Code',
    'BOM Description',
    'Preferred Machines (Live)',
    'Completion History',
    'Process Sheets',
    'PS Count',
    'Missing Preferred Ops',
    'ERP Mismatch Ops',
    'Default BOM',
  ];
  const lines = [headers.join(',')];
  items.forEach((row) => {
    const cells = [
      row.part_no,
      row.part_desc,
      row.bom_code,
      row.bom_desc,
      row.preferred_summary,
      row.history_summary,
      row.process_sheets_text,
      row.ps_count,
      row.missing_preferred_count,
      row.erp_mismatch_count,
      row.is_default ? 'Y' : 'N',
    ].map((value) => {
      const text = String(value ?? '');
      if (text.includes(',') || text.includes('"') || text.includes('\n')) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    });
    lines.push(cells.join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `preferred-machines-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function pmBindEvents() {
  document.getElementById('pm-refresh')?.addEventListener('click', () => pmLoad({ refresh: true }));
  document.getElementById('pm-export')?.addEventListener('click', pmExportCsv);
  document.getElementById('pm-detail-close')?.addEventListener('click', pmCloseDetail);
  document.querySelector('#pm-detail [data-action="close-detail"]')?.addEventListener('click', pmCloseDetail);

  document.getElementById('pm-search')?.addEventListener('input', (event) => {
    pmState.search = event.target.value || '';
    pmRenderTable();
  });

  document.querySelectorAll('[data-pm-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-pm-filter]').forEach((el) => {
        const active = el === btn;
        el.classList.toggle('is-active', active);
        el.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      pmState.filter = btn.getAttribute('data-pm-filter') || 'all';
      pmRenderTable();
    });
  });

  document.querySelectorAll('[data-pm-sort]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const col = btn.getAttribute('data-pm-sort') || 'part_no';
      if (pmState.sortCol === col) {
        pmState.sortDir = pmState.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        pmState.sortCol = col;
        pmState.sortDir = 'asc';
      }
      pmRenderTable();
    });
  });

  document.getElementById('pm-table-body')?.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-pm-key]');
    if (!row) return;
    pmOpenDetailByKey(row.getAttribute('data-pm-key') || '');
  });

  document.getElementById('pm-table-body')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-pm-key]');
    if (!row) return;
    event.preventDefault();
    pmOpenDetailByKey(row.getAttribute('data-pm-key') || '');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') pmCloseDetail();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  pmBindEvents();
  pmLoad();
});
