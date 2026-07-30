/* Monthly delivery plan - ARCHIVE */

const mdpState = {
  year: new Date().getFullYear(),
  focusMonth: null,
  data: null,
  loading: false,
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

function mdpCurrentMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
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
  if (exportBtn) exportBtn.hidden = !mdpState.focusMonth;
}

function mdpSelectedMonthBucket() {
  if (!mdpState.data || !mdpState.focusMonth) return null;
  return (mdpState.data.months || []).find((m) => m.month === mdpState.focusMonth) || null;
}

function mdpRenderMeta() {
  const el = document.getElementById('mdp-meta');
  if (!el) return;
  const data = mdpState.data;
  if (!data) {
    el.textContent = '';
    return;
  }
  const parts = [`${mdpState.year}`];
  if (data.active_job_count != null) parts.push(`${data.active_job_count} open jobs`);
  el.textContent = parts.join(' | ');
}

function mdpRenderKpis() {
  const el = document.getElementById('mdp-kpi');
  if (!el || !mdpState.data) {
    if (el) el.hidden = true;
    return;
  }
  const summary = mdpState.data.year_summary || {};
  const month = mdpSelectedMonthBucket();
  const revenue = month ? month.target_revenue : summary.target_revenue;
  const qty = month ? month.qty : summary.qty;
  const lines = month ? month.line_count : summary.line_count;
  const scope = month ? mdpMonthLabel(mdpState.year, month.month) : `${mdpState.year} total`;

  el.hidden = false;
  el.innerHTML = `
    <div class="mdp-kpi mdp-kpi--revenue">
      <span class="mdp-kpi-label">Target revenue</span>
      <div class="mdp-kpi-value">$${mdpEscape(mdpFormatMoney(revenue))}</div>
      <div class="mdp-kpi-sub">${mdpEscape(scope)}</div>
    </div>
    <div class="mdp-kpi mdp-kpi--qty">
      <span class="mdp-kpi-label">Delivery qty</span>
      <div class="mdp-kpi-value">${mdpEscape(mdpFormatQty(qty))}</div>
      <div class="mdp-kpi-sub">${mdpEscape(String(lines))} line${lines === 1 ? '' : 's'}</div>
    </div>
    <div class="mdp-kpi">
      <span class="mdp-kpi-label">Undated</span>
      <div class="mdp-kpi-value">${mdpEscape(String(summary.undated_count || 0))}</div>
      <div class="mdp-kpi-sub">No Coway EDD or PO due</div>
    </div>
  `;
}

function mdpRenderOverview() {
  const section = document.getElementById('mdp-overview');
  const grid = document.getElementById('mdp-overview-grid');
  const monthPanel = document.getElementById('mdp-month-panel');
  if (!section || !grid || !mdpState.data) return;

  const showOverview = !mdpState.focusMonth;
  section.hidden = !showOverview;
  if (monthPanel) monthPanel.hidden = showOverview;
  if (!showOverview) return;

  const current = mdpCurrentMonth();
  grid.innerHTML = (mdpState.data.months || []).map((month) => {
    const isCurrent = month.month === current.month && mdpState.year === current.year;
    const isEmpty = !month.line_count;
    return `
      <button type="button" class="mdp-month-card${isCurrent ? ' is-current' : ''}${isEmpty ? ' is-empty' : ''}" data-month="${month.month}">
        <span class="mdp-month-card-label">${mdpEscape(month.label)}</span>
        <span class="mdp-month-card-revenue">$${mdpEscape(mdpFormatMoney(month.target_revenue))}</span>
        <span class="mdp-month-card-meta">${mdpEscape(String(month.line_count))} lines � qty ${mdpEscape(mdpFormatQty(month.qty))}</span>
      </button>
    `;
  }).join('');
}

function mdpPsDisplay(line) {
  const ps = String(line.process_sheet_no || line.pp_voucher_no || '').trim();
  const partial = line.pp_partial_no;
  if (ps && partial && partial > 1) return `${ps}/${partial}`;
  return ps || '-';
}

function mdpRenderMonthDetail() {
  const panel = document.getElementById('mdp-month-panel');
  const body = document.getElementById('mdp-month-body');
  const empty = document.getElementById('mdp-month-empty');
  const title = document.getElementById('mdp-month-title');
  const sub = document.getElementById('mdp-month-sub');
  if (!panel || !body || !mdpState.focusMonth || !mdpState.data) return;

  panel.hidden = false;
  const month = mdpSelectedMonthBucket();
  const lines = month?.lines || [];
  if (title) title.textContent = mdpMonthLabel(mdpState.year, mdpState.focusMonth);
  if (sub) {
    sub.textContent = month
      ? `Target $${mdpFormatMoney(month.target_revenue)} � ${month.line_count} lines � qty ${mdpFormatQty(month.qty)}`
      : '';
  }

  if (!lines.length) {
    body.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  body.innerHTML = lines.map((line) => `
    <tr>
      <td>${mdpEscape(line.sales_order_no || '-')}</td>
      <td>${mdpEscape(line.customer_name || '-')}</td>
      <td>${mdpEscape(mdpPsDisplay(line))}</td>
      <td class="mdp-part-cell">
        <span class="mdp-part-no">${mdpEscape(line.part_no || '-')}</span>
        <span class="mdp-part-desc">${mdpEscape(line.part_desc || '')}</span>
      </td>
      <td class="mdp-num">${mdpEscape(mdpFormatQty(line.qty))}</td>
      <td class="mdp-num">${mdpEscape(mdpFormatMoney(line.unit_selling_price))}</td>
      <td class="mdp-num">${mdpEscape(mdpFormatMoney(line.amount))}</td>
      <td>${mdpEscape(mdpFormatDate(line.due_date))}</td>
      <td>${mdpEscape(mdpFormatDate(line.coway_edd))}</td>
      <td>${mdpEscape(mdpFormatDate(line.commitment_date))}</td>
      <td>${mdpEscape(line.current_stage_desc || '-')}</td>
    </tr>
  `).join('');
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

function mdpSetFocusMonth(month) {
  const next = month ? Number(month) : null;
  if (next && (next < 1 || next > 12)) return;
  mdpState.focusMonth = next;
  mdpRender();
  if (next) {
    document.getElementById('mdp-month-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
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
    mdpRender();
  } catch (err) {
    mdpState.data = null;
    mdpSetAlert(err?.message || String(err));
    mdpRender();
  } finally {
    mdpSetLoading(false);
  }
}

function mdpExportCsv() {
  const month = mdpSelectedMonthBucket();
  if (!month) return;
  const headers = [
    'sales_order_no', 'customer_name', 'process_sheet_no', 'pp_partial_no',
    'part_no', 'part_desc', 'qty', 'unit_selling_price', 'amount',
    'due_date', 'coway_edd', 'commitment_date', 'current_stage_desc',
  ];
  const rows = [headers.join(',')];
  for (const line of month.lines || []) {
    rows.push(headers.map((key) => {
      const raw = line[key] == null ? '' : String(line[key]);
      return `"${raw.replace(/"/g, '""')}"`;
    }).join(','));
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `monthly-delivery-plan-${month.key}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function mdpBind() {
  document.getElementById('mdp-year')?.addEventListener('change', (ev) => {
    const next = Number(ev.target.value);
    if (!Number.isFinite(next)) return;
    mdpState.year = Math.max(2000, Math.min(2100, next));
    mdpState.focusMonth = null;
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
