/* Monthly delivery plan - ARCHIVE */

const MDP_PS_TYPES = ['APS', 'NPS', 'PPS'];
const MDP_PS_TYPES_DEFAULT = new Set(['APS', 'NPS']);

const mdpState = {
  year: new Date().getFullYear(),
  focusMonth: null,
  data: null,
  loading: false,
  psTypes: new Set(MDP_PS_TYPES_DEFAULT),
  selected: new Set(),
};

function mdpEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mdpFormatMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function mdpFormatQty(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return Number.isInteger(num)
    ? String(num)
    : num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function mdpFormatDate(value) {
  const text = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text || '-';
  const [y, m, d] = text.split('-');
  return `${d}/${m}/${y}`;
}

function mdpMonthLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

function mdpMonthShortLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleString(undefined, {
    month: 'short',
    year: 'numeric',
  });
}

function mdpCurrentMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function mdpLineId(line) {
  const voucher = String(line.pp_voucher_no || line.process_sheet_no || '').trim();
  const partial = line.pp_partial_no == null ? '' : String(line.pp_partial_no);
  return `${voucher}::${partial}`;
}

function mdpLineMatchesPsType(line) {
  const type = String(line.ps_type || '').trim().toUpperCase();
  return mdpState.psTypes.has(type);
}

function mdpFilterLines(lines) {
  return (lines || []).filter(mdpLineMatchesPsType);
}

function mdpSumLines(lines) {
  let revenue = 0;
  let qty = 0;
  for (const line of lines) {
    revenue += Number(line.amount) || 0;
    qty += Number(line.qty) || 0;
  }
  return {
    target_revenue: Math.round(revenue * 100) / 100,
    qty: Math.round(qty * 10000) / 10000,
    line_count: lines.length,
  };
}

function mdpSelectedMonthBucket() {
  if (!mdpState.data || !mdpState.focusMonth) return null;
  return (mdpState.data.months || []).find((m) => m.month === mdpState.focusMonth) || null;
}

function mdpYearLines() {
  const months = mdpState.data?.months || [];
  const lines = [];
  for (const month of months) {
    for (const line of mdpFilterLines(month.lines || [])) {
      lines.push({
        ...line,
        _month: month.month,
        _month_label: month.label || mdpMonthShortLabel(mdpState.year, month.month),
      });
    }
  }
  lines.sort((a, b) => {
    const da = a.commitment_date || '9999-12-31';
    const db = b.commitment_date || '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    const pa = a.process_sheet_no || '';
    const pb = b.process_sheet_no || '';
    if (pa !== pb) return pa < pb ? -1 : 1;
    return (a.pp_partial_no || 0) - (b.pp_partial_no || 0);
  });
  return lines;
}

function mdpVisibleLines() {
  if (mdpState.focusMonth) {
    const month = mdpSelectedMonthBucket();
    return mdpFilterLines(month?.lines || []);
  }
  return mdpYearLines();
}

function mdpSelectedVisibleLines() {
  return mdpVisibleLines().filter((line) => mdpState.selected.has(mdpLineId(line)));
}

function mdpSelectAllVisible() {
  mdpState.selected = new Set(mdpVisibleLines().map(mdpLineId));
}

function mdpMonthTotalsForPsFilter(month) {
  return mdpSumLines(mdpFilterLines(month?.lines || []));
}

function mdpSetAlert(message) {
  const el = document.getElementById('mdp-alert');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function mdpSetLoading(loading) {
  mdpState.loading = loading;
  const el = document.getElementById('mdp-loading');
  if (el) el.hidden = !loading;
}

function mdpPsTypeLabel() {
  const checked = [...mdpState.psTypes];
  if (!checked.length) return 'None';
  if (checked.length >= MDP_PS_TYPES.length) return 'All types';
  return checked.join(', ');
}

function mdpSyncPsTypeUi() {
  const panel = document.getElementById('mdp-ps-type-panel');
  if (panel) {
    panel.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.checked = mdpState.psTypes.has(input.value);
    });
  }
  const btn = document.getElementById('mdp-ps-type-btn');
  if (btn) btn.textContent = `${mdpPsTypeLabel()} ▾`;
}

function mdpSyncChips() {
  const current = mdpCurrentMonth();
  document.querySelectorAll('.mdp-month-chip').forEach((btn) => {
    const raw = btn.dataset.month;
    const monthNum = raw ? Number(raw) : null;
    const active = mdpState.focusMonth
      ? monthNum === mdpState.focusMonth
      : !raw;
    btn.classList.toggle('is-active', active);
    btn.classList.toggle(
      'is-current',
      Boolean(monthNum)
        && monthNum === current.month
        && mdpState.year === current.year,
    );
  });
  const yearInput = document.getElementById('mdp-year');
  if (yearInput) yearInput.value = String(mdpState.year);
  const exportBtn = document.getElementById('mdp-export');
  if (exportBtn) exportBtn.hidden = !mdpState.data;
  mdpSyncPsTypeUi();
}

function mdpRenderMeta() {
  const el = document.getElementById('mdp-meta');
  if (!el) return;
  const data = mdpState.data;
  if (!data) {
    el.textContent = '';
    return;
  }
  const parts = [`${mdpState.year}`, mdpPsTypeLabel()];
  if (data.active_job_count != null) parts.push(`${data.active_job_count} open jobs`);
  el.textContent = parts.join(' · ');
}

function mdpUpdateSubtitle(subId, totals, visibleCount) {
  const sub = document.getElementById(subId);
  if (!sub) return;
  sub.textContent = `Target $${mdpFormatMoney(totals.target_revenue)} · ${totals.line_count} selected · qty ${mdpFormatQty(totals.qty)} · ${visibleCount} visible`;
}

function mdpRenderKpis() {
  const el = document.getElementById('mdp-kpi');
  if (!el || !mdpState.data) {
    if (el) el.hidden = true;
    return;
  }

  const selected = mdpSelectedVisibleLines();
  const totals = mdpSumLines(selected);
  const undated = mdpFilterLines(mdpState.data.undated || []).length;
  const scope = mdpState.focusMonth
    ? `${mdpMonthLabel(mdpState.year, mdpState.focusMonth)} · ${selected.length} selected`
    : `${mdpState.year} · ${selected.length} selected`;

  el.hidden = false;
  el.innerHTML = `
    <div class="mdp-kpi mdp-kpi--revenue">
      <span class="mdp-kpi-label">Target revenue</span>
      <div class="mdp-kpi-value">$${mdpEscape(mdpFormatMoney(totals.target_revenue))}</div>
      <div class="mdp-kpi-sub">${mdpEscape(scope)}</div>
    </div>
    <div class="mdp-kpi mdp-kpi--qty">
      <span class="mdp-kpi-label">Delivery qty</span>
      <div class="mdp-kpi-value">${mdpEscape(mdpFormatQty(totals.qty))}</div>
      <div class="mdp-kpi-sub">${mdpEscape(String(totals.line_count))} line${totals.line_count === 1 ? '' : 's'}</div>
    </div>
    <div class="mdp-kpi">
      <span class="mdp-kpi-label">Undated</span>
      <div class="mdp-kpi-value">${mdpEscape(String(undated || 0))}</div>
      <div class="mdp-kpi-sub">No Coway EDD or PO due</div>
    </div>
  `;
}

function mdpPsDisplay(line) {
  const ps = String(line.process_sheet_no || line.pp_voucher_no || '').trim();
  const partial = line.pp_partial_no;
  if (ps && partial && partial > 1) return `${ps}/${partial}`;
  return ps || '-';
}

function mdpRowCells(line, { includeMonth = false } = {}) {
  const id = mdpLineId(line);
  const checked = mdpState.selected.has(id);
  const monthCell = includeMonth
    ? `<td>${mdpEscape(line._month_label || '-')}</td>`
    : '';
  return `
    <tr data-line-id="${mdpEscape(id)}">
      <td class="mdp-check-col">
        <input type="checkbox" class="mdp-row-check" data-line-id="${mdpEscape(id)}" ${checked ? 'checked' : ''} aria-label="Select row">
      </td>
      ${monthCell}
      <td>${mdpEscape(line.sales_order_no || '-')}</td>
      <td>${mdpEscape(line.customer_name || '-')}</td>
      <td>${mdpEscape(mdpPsDisplay(line))}</td>
      <td class="mdp-part-cell">
        <span class="mdp-part-no">${mdpEscape(line.part_no || '-')}</span>
        <span class="mdp-part-desc">${mdpEscape(line.part_desc || '')}</span>
      </td>
      <td class="mdp-num">${mdpEscape(mdpFormatQty(line.qty))}</td>
      <td class="mdp-num">${mdpEscape(mdpFormatMoney(line.unit_cost))}</td>
      <td class="mdp-num">${mdpEscape(mdpFormatMoney(line.amount))}</td>
      <td>${mdpEscape(line.current_stage_desc || '-')}</td>
      <td>${mdpEscape(mdpFormatDate(line.due_date))}</td>
      <td>${mdpEscape(mdpFormatDate(line.coway_edd))}</td>
      <td>${mdpEscape(line.week || '-')}</td>
    </tr>
  `;
}

function mdpSyncSelectAllCheckbox(selectAllId) {
  const selectAll = document.getElementById(selectAllId);
  if (!selectAll) return;
  const visible = mdpVisibleLines();
  if (!visible.length) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }
  const selectedCount = visible.filter((line) => mdpState.selected.has(mdpLineId(line))).length;
  selectAll.checked = selectedCount === visible.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < visible.length;
}

function mdpRenderOverview() {
  const section = document.getElementById('mdp-overview');
  const grid = document.getElementById('mdp-overview-grid');
  const monthPanel = document.getElementById('mdp-month-panel');
  const body = document.getElementById('mdp-overview-body');
  const empty = document.getElementById('mdp-overview-empty');
  if (!section || !grid || !mdpState.data) return;

  const showOverview = !mdpState.focusMonth;
  section.hidden = !showOverview;
  if (monthPanel) monthPanel.hidden = showOverview;
  if (!showOverview) return;

  const current = mdpCurrentMonth();
  grid.innerHTML = (mdpState.data.months || []).map((month) => {
    const totals = mdpMonthTotalsForPsFilter(month);
    const isCurrent = month.month === current.month && mdpState.year === current.year;
    const isEmpty = !totals.line_count;
    return `
      <button type="button" class="mdp-month-card${isCurrent ? ' is-current' : ''}${isEmpty ? ' is-empty' : ''}" data-month="${month.month}">
        <span class="mdp-month-card-label">${mdpEscape(month.label)}</span>
        <span class="mdp-month-card-revenue">$${mdpEscape(mdpFormatMoney(totals.target_revenue))}</span>
        <span class="mdp-month-card-meta">${mdpEscape(String(totals.line_count))} lines · qty ${mdpEscape(mdpFormatQty(totals.qty))}</span>
      </button>
    `;
  }).join('');

  const lines = mdpVisibleLines();
  const selected = mdpSelectedVisibleLines();
  const totals = mdpSumLines(selected);
  mdpUpdateSubtitle('mdp-overview-sub', totals, lines.length);

  if (!body) return;
  if (!lines.length) {
    body.innerHTML = '';
    if (empty) empty.hidden = false;
    mdpSyncSelectAllCheckbox('mdp-overview-select-all');
    return;
  }
  if (empty) empty.hidden = true;
  body.innerHTML = lines.map((line) => mdpRowCells(line, { includeMonth: true })).join('');
  mdpSyncSelectAllCheckbox('mdp-overview-select-all');
}

function mdpRenderMonthDetail() {
  const panel = document.getElementById('mdp-month-panel');
  const body = document.getElementById('mdp-month-body');
  const empty = document.getElementById('mdp-month-empty');
  const title = document.getElementById('mdp-month-title');
  if (!panel || !body || !mdpState.focusMonth || !mdpState.data) return;

  panel.hidden = false;
  const lines = mdpVisibleLines();
  const selected = mdpSelectedVisibleLines();
  const totals = mdpSumLines(selected);
  if (title) title.textContent = mdpMonthLabel(mdpState.year, mdpState.focusMonth);
  mdpUpdateSubtitle('mdp-month-sub', totals, lines.length);

  if (!lines.length) {
    body.innerHTML = '';
    if (empty) empty.hidden = false;
    mdpSyncSelectAllCheckbox('mdp-select-all');
    return;
  }
  if (empty) empty.hidden = true;
  body.innerHTML = lines.map((line) => mdpRowCells(line, { includeMonth: false })).join('');
  mdpSyncSelectAllCheckbox('mdp-select-all');
}

function mdpRender() {
  mdpSyncChips();
  mdpRenderMeta();
  mdpRenderKpis();
  mdpRenderOverview();
  if (mdpState.focusMonth) mdpRenderMonthDetail();
  else {
    const panel = document.getElementById('mdp-month-panel');
    if (panel) panel.hidden = true;
  }
}

function mdpSetFocusMonth(month, { resetSelection = true } = {}) {
  const next = month ? Number(month) : null;
  if (next && (next < 1 || next > 12)) return;
  mdpState.focusMonth = next;
  if (resetSelection) mdpSelectAllVisible();
  mdpRender();
  if (next) {
    document.getElementById('mdp-month-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function mdpApplyPsTypes(types, { reselect = true } = {}) {
  mdpState.psTypes = new Set(types);
  if (reselect) mdpSelectAllVisible();
  mdpRender();
}

async function mdpLoad({ refresh = false } = {}) {
  mdpSetLoading(true);
  mdpSetAlert('');
  try {
    const params = new URLSearchParams({ year: String(mdpState.year) });
    if (refresh) params.set('refresh', '1');
    const res = await fetch(`/api/monthly-delivery-plan?${params}`);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    mdpState.data = data;
    mdpSelectAllVisible();
    mdpRender();
  } catch (err) {
    mdpState.data = null;
    mdpState.selected.clear();
    mdpSetAlert(err?.message || String(err));
    mdpRender();
  } finally {
    mdpSetLoading(false);
  }
}

function mdpExportCsv() {
  const lines = mdpSelectedVisibleLines();
  if (!mdpState.data) return;
  const headers = [
    'sales_order_no', 'customer_name', 'process_sheet_no', 'pp_partial_no', 'ps_type',
    'part_no', 'part_desc', 'qty', 'unit_cost', 'exch_rate', 'amount',
    'current_stage_desc', 'due_date', 'coway_edd', 'week', 'commitment_date',
  ];
  if (!mdpState.focusMonth) headers.unshift('month');
  const rows = [headers.join(',')];
  for (const line of lines) {
    rows.push(headers.map((key) => {
      const raw = key === 'month'
        ? (line._month_label || line.commitment_month || '')
        : (line[key] == null ? '' : String(line[key]));
      return `"${raw.replace(/"/g, '""')}"`;
    }).join(','));
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const month = mdpSelectedMonthBucket();
  const key = month?.key || String(mdpState.year);
  a.download = `monthly-delivery-plan-${key}-selected.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function mdpOnSelectionChanged() {
  const selected = mdpSelectedVisibleLines();
  const totals = mdpSumLines(selected);
  const visible = mdpVisibleLines();
  if (mdpState.focusMonth) {
    mdpUpdateSubtitle('mdp-month-sub', totals, visible.length);
    mdpSyncSelectAllCheckbox('mdp-select-all');
  } else {
    mdpUpdateSubtitle('mdp-overview-sub', totals, visible.length);
    mdpSyncSelectAllCheckbox('mdp-overview-select-all');
  }
  mdpRenderKpis();
}

function mdpBindSelectAll(selectAllId) {
  document.getElementById(selectAllId)?.addEventListener('change', (ev) => {
    const checked = Boolean(ev.target.checked);
    const visible = mdpVisibleLines();
    if (checked) {
      visible.forEach((line) => mdpState.selected.add(mdpLineId(line)));
    } else {
      visible.forEach((line) => mdpState.selected.delete(mdpLineId(line)));
    }
    if (mdpState.focusMonth) mdpRenderMonthDetail();
    else mdpRenderOverview();
    mdpRenderKpis();
  });
}

function mdpBindRowChecks(tbodyId) {
  document.getElementById(tbodyId)?.addEventListener('change', (ev) => {
    const input = ev.target.closest('.mdp-row-check');
    if (!input) return;
    const id = input.dataset.lineId;
    if (!id) return;
    if (input.checked) mdpState.selected.add(id);
    else mdpState.selected.delete(id);
    mdpOnSelectionChanged();
  });
}

function mdpBindPsTypeDropdown() {
  const dropdown = document.getElementById('mdp-ps-type-dropdown');
  const btn = document.getElementById('mdp-ps-type-btn');
  const panel = document.getElementById('mdp-ps-type-panel');
  if (!dropdown || !btn || !panel || dropdown.dataset.bound === '1') return;
  dropdown.dataset.bound = '1';

  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
  });

  panel.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      const checked = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value);
      mdpApplyPsTypes(checked);
    });
  });

  document.addEventListener('click', (ev) => {
    if (!dropdown.contains(ev.target)) panel.hidden = true;
  });
}

function mdpBind() {
  mdpBindPsTypeDropdown();
  mdpBindSelectAll('mdp-select-all');
  mdpBindSelectAll('mdp-overview-select-all');
  mdpBindRowChecks('mdp-month-body');
  mdpBindRowChecks('mdp-overview-body');

  document.getElementById('mdp-year')?.addEventListener('change', (ev) => {
    const next = Number(ev.target.value);
    if (!Number.isFinite(next)) return;
    mdpState.year = Math.max(2000, Math.min(2100, next));
    mdpState.focusMonth = null;
    mdpState.selected.clear();
    mdpLoad();
  });

  document.getElementById('mdp-month-nav')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.mdp-month-chip');
    if (!btn) return;
    const raw = btn.dataset.month;
    mdpSetFocusMonth(raw ? Number(raw) : null);
  });

  document.getElementById('mdp-overview-grid')?.addEventListener('click', (ev) => {
    const card = ev.target.closest('.mdp-month-card');
    if (!card) return;
    mdpSetFocusMonth(Number(card.dataset.month));
  });

  document.getElementById('mdp-back-overview')?.addEventListener('click', () => {
    mdpSetFocusMonth(null);
  });

  document.getElementById('mdp-refresh')?.addEventListener('click', () => {
    mdpLoad({ refresh: true });
  });

  document.getElementById('mdp-export')?.addEventListener('click', mdpExportCsv);
}

document.addEventListener('DOMContentLoaded', () => {
  const current = mdpCurrentMonth();
  mdpState.year = current.year;
  mdpBind();
  mdpSyncChips();
  mdpLoad();
});
