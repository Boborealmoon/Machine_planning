(function () {
  'use strict';

  const state = {
    data: null,
    loading: false,
    view: 'overview',
    breakdownMonth: 'year',
    expandedPools: new Set(),
    expandedGroups: new Set(),
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function fmtHours(hours) {
    const value = Number(hours || 0);
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;
  }

  function fmtMinutesAsHours(minutes) {
    return fmtHours(Number(minutes || 0) / 60);
  }

  function fmtPct(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return `${num.toFixed(1)}%`;
  }

  function pctClass(value, capacity) {
    if (Number(capacity || 0) <= 0 && Number(value || 0) <= 0) return 'pc-pct--na';
    const num = Number(value || 0);
    if (num >= 95) return 'pc-pct--high';
    if (num >= 75) return 'pc-pct--med';
    return 'pc-pct--low';
  }

  function utilBarHtml(pct) {
    const width = Math.min(100, Math.max(0, Number(pct || 0)));
    return `<span class="pc-row-bar" aria-hidden="true"><span style="width:${width}%"></span></span>`;
  }

  function satPctCell(row, prefix) {
    const cap = Number(row[`${prefix}_capacity_minutes`] || 0);
    const sched = Number(row[`${prefix}_scheduled_minutes`] || 0);
    const pct = row[`${prefix}_utilization_pct`];
    if (cap <= 0 && sched <= 0) return '—';
    return fmtPct(pct);
  }

  function periodRow(entity) {
    if (state.breakdownMonth === 'year') {
      return entity.totals || {};
    }
    const month = Number(state.breakdownMonth);
    return (entity.months || []).find((row) => Number(row.month) === month) || {};
  }

  function showAlert(message) {
    if (!els.alert) return;
    if (!message) {
      els.alert.hidden = true;
      els.alert.textContent = '';
      return;
    }
    els.alert.hidden = false;
    els.alert.textContent = message;
  }

  function setLoading(isLoading) {
    state.loading = isLoading;
    if (els.refresh) els.refresh.disabled = isLoading;
    if (els.meta && isLoading) els.meta.textContent = 'Loading…';
  }

  function populateCategories(types) {
    if (!els.category) return;
    const current = els.category.value || 'all';
    els.category.innerHTML = '<option value="all">All machines</option>';
    (types || []).forEach((type) => {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type;
      els.category.appendChild(opt);
    });
    if ([...els.category.options].some((opt) => opt.value === current)) {
      els.category.value = current;
    }
  }

  function populateBreakdownMonths(months) {
    if (!els.breakdownMonth) return;
    const current = els.breakdownMonth.value || 'year';
    els.breakdownMonth.innerHTML = '<option value="year">Full year</option>';
    (months || []).forEach((row) => {
      const opt = document.createElement('option');
      opt.value = String(row.month);
      opt.textContent = row.month_label;
      els.breakdownMonth.appendChild(opt);
    });
    if ([...els.breakdownMonth.options].some((opt) => opt.value === current)) {
      els.breakdownMonth.value = current;
    } else {
      els.breakdownMonth.value = 'year';
      state.breakdownMonth = 'year';
    }
  }

  function renderSummary(totals, poolTotals) {
    if (!totals) return;
    $('pc-stat-weekday-sched').textContent = fmtHours(totals.weekday_scheduled_hours);
    $('pc-stat-weekday-sched-sub').textContent = `${Math.round(totals.weekday_scheduled_minutes).toLocaleString()} min scheduled`;
    $('pc-stat-weekday-cap').textContent = fmtHours(totals.weekday_capacity_hours);
    $('pc-stat-weekday-cap-sub').textContent = `${Math.round(totals.weekday_capacity_minutes).toLocaleString()} min available`;
    $('pc-stat-weekday-util').textContent = fmtPct(totals.weekday_utilization_pct);
    const bar = $('pc-stat-weekday-util-bar');
    if (bar) bar.style.width = `${Math.min(100, totals.weekday_utilization_pct || 0)}%`;
    $('pc-stat-sat-sched').textContent = fmtHours(totals.saturday_scheduled_hours);
    $('pc-stat-sat-sched-sub').textContent = `${Math.round(totals.saturday_scheduled_minutes).toLocaleString()} min · cap ${fmtHours(totals.saturday_capacity_hours)}`;

    const hr24 = poolTotals?.['24HR'];
    const std = poolTotals?.STANDARD;
    $('pc-stat-24hr-util').textContent = hr24 ? fmtPct(hr24.weekday_utilization_pct) : '—';
    $('pc-stat-24hr-sub').textContent = hr24
      ? `${fmtHours(hr24.weekday_scheduled_hours)} / ${fmtHours(hr24.weekday_capacity_hours)} weekday`
      : 'No 24-hour machines';
    $('pc-stat-std-util').textContent = std ? fmtPct(std.weekday_utilization_pct) : '—';
    $('pc-stat-std-sub').textContent = std
      ? `${fmtHours(std.weekday_scheduled_hours)} / ${fmtHours(std.weekday_capacity_hours)} weekday`
      : 'No standard-shift machines';
  }

  function renderMetricCells(row) {
    return `
      <td>${fmtMinutesAsHours(row.weekday_scheduled_minutes)}</td>
      <td>${fmtMinutesAsHours(row.weekday_capacity_minutes)}</td>
      <td class="pc-pct ${pctClass(row.weekday_utilization_pct, row.weekday_capacity_minutes)}">
        ${fmtPct(row.weekday_utilization_pct)}${utilBarHtml(row.weekday_utilization_pct)}
      </td>
      <td class="pc-col-sat">${fmtMinutesAsHours(row.saturday_scheduled_minutes)}</td>
      <td class="pc-col-sat">${fmtMinutesAsHours(row.saturday_capacity_minutes)}</td>
      <td class="pc-col-sat pc-pct ${pctClass(row.saturday_utilization_pct, row.saturday_capacity_minutes)}">
        ${satPctCell(row, 'saturday')}
      </td>
      <td>${fmtMinutesAsHours(row.total_scheduled_minutes)}</td>
      <td>${fmtMinutesAsHours(row.total_capacity_minutes)}</td>
      <td class="pc-pct ${pctClass(row.total_utilization_pct, row.total_capacity_minutes)}">
        ${fmtPct(row.total_utilization_pct)}${utilBarHtml(row.total_utilization_pct)}
      </td>`;
  }

  function renderTable(months, totals) {
    const body = els.tableBody;
    const foot = els.tableFoot;
    if (!body) return;

    if (!months || !months.length) {
      body.innerHTML = '<tr><td colspan="11" class="pc-empty">No data for this year.</td></tr>';
      if (foot) foot.innerHTML = '';
      return;
    }

    body.innerHTML = months.map((row) => {
      const daysLabel = `${row.working_days} wd${row.saturday_days ? ` · ${row.saturday_days} sat` : ''}`;
      return `
        <tr>
          <td>${row.month_label}</td>
          <td>${daysLabel}</td>
          ${renderMetricCells(row)}
        </tr>`;
    }).join('');

    if (foot && totals) {
      foot.innerHTML = `
        <tr>
          <td>Year total</td>
          <td>—</td>
          ${renderMetricCells(totals)}
        </tr>`;
    }
  }

  function renderBreakdownRow(label, row, options = {}) {
    const {
      level = 0,
      rowKey = '',
      parentKey = '',
      isPool = false,
      isGroup = false,
      isExpanded = false,
      machineCount = 0,
      groupCount = 0,
      description = '',
      shiftBadge = '',
    } = options;
    const indent = level > 0 ? `style="padding-left:${12 + level * 18}px"` : '';
    const canToggle = isPool || isGroup;
    const toggle = canToggle
      ? `<button type="button" class="pc-breakdown-toggle" data-toggle-key="${rowKey}" data-toggle-type="${isPool ? 'pool' : 'group'}" aria-expanded="${isExpanded ? 'true' : 'false'}">${isExpanded ? '▾' : '▸'}</button>`
      : '<span class="pc-breakdown-toggle-spacer" aria-hidden="true"></span>';

    let meta = '';
    if (isPool && groupCount) meta = `<span class="pc-breakdown-meta">${groupCount} groups · ${machineCount} machines</span>`;
    else if (isGroup && machineCount) meta = `<span class="pc-breakdown-meta">${machineCount} machines</span>`;
    else if (description) meta = `<span class="pc-breakdown-meta">${description}</span>`;

    const badge = shiftBadge ? `<span class="pc-shift-badge">${shiftBadge}</span>` : '';
    let rowClass = 'pc-breakdown-row';
    if (isPool) rowClass += ' pc-breakdown-row--pool';
    else if (isGroup) rowClass += ' pc-breakdown-row--group';
    else rowClass += ' pc-breakdown-row--machine';

    return `
      <tr class="${rowClass}" data-row-key="${rowKey}" data-parent-key="${parentKey}">
        <td class="pc-td-name" ${indent}>
          ${toggle}
          <span class="pc-breakdown-label">${label}</span>
          ${badge}
          ${meta}
        </td>
        <td>${fmtMinutesAsHours(row.weekday_scheduled_minutes)}</td>
        <td>${fmtMinutesAsHours(row.weekday_capacity_minutes)}</td>
        <td class="pc-pct ${pctClass(row.weekday_utilization_pct, row.weekday_capacity_minutes)}">${fmtPct(row.weekday_utilization_pct)}</td>
        <td class="pc-col-sat">${fmtMinutesAsHours(row.saturday_scheduled_minutes)}</td>
        <td class="pc-col-sat">${fmtMinutesAsHours(row.saturday_capacity_minutes)}</td>
        <td class="pc-col-sat pc-pct ${pctClass(row.saturday_utilization_pct, row.saturday_capacity_minutes)}">${satPctCell(row, 'saturday')}</td>
        <td>${fmtMinutesAsHours(row.total_scheduled_minutes)}</td>
        <td>${fmtMinutesAsHours(row.total_capacity_minutes)}</td>
        <td class="pc-pct ${pctClass(row.total_utilization_pct, row.total_capacity_minutes)}">${fmtPct(row.total_utilization_pct)}</td>
      </tr>`;
  }

  function renderBreakdown() {
    const body = els.breakdownBody;
    if (!body) return;
    const data = state.data;
    const pools = data?.shift_pools || [];
    if (!pools.length) {
      body.innerHTML = '<tr><td colspan="10" class="pc-empty">No breakdown data.</td></tr>';
      return;
    }

    const rows = [];
    pools.forEach((pool) => {
      const poolKey = pool.key || pool.label;
      const poolExpanded = state.expandedPools.has(poolKey);
      const poolRow = periodRow(pool);
      rows.push(renderBreakdownRow(pool.label, poolRow, {
        level: 0,
        rowKey: poolKey,
        isPool: true,
        isExpanded: poolExpanded,
        machineCount: pool.machine_count || 0,
        groupCount: pool.group_count || (pool.groups || []).length,
        description: pool.description || '',
        shiftBadge: pool.shift_profile === '24HR' ? '24/7' : 'Day shift',
      }));

      if (!poolExpanded) return;

      (pool.groups || []).forEach((group) => {
        const groupKey = `${poolKey}::${group.key || group.label}`;
        const groupExpanded = state.expandedGroups.has(groupKey);
        const groupRow = periodRow(group);
        rows.push(renderBreakdownRow(group.label, groupRow, {
          level: 1,
          rowKey: groupKey,
          parentKey: poolKey,
          isGroup: true,
          isExpanded: groupExpanded,
          machineCount: group.machine_count || (group.machines || []).length,
        }));

        if (!groupExpanded) return;

        (group.machines || []).forEach((machine) => {
          const machineRow = periodRow(machine);
          const shiftBadge = machine.shift_profile === '24HR' ? '24/7' : '';
          rows.push(renderBreakdownRow(machine.machine_code || machine.label, machineRow, {
            level: 2,
            rowKey: `${groupKey}::${machine.key || machine.machine_id}`,
            parentKey: groupKey,
            shiftBadge,
          }));
        });
      });
    });

    body.innerHTML = rows.join('');
  }

  function renderNotes(notes) {
    const list = els.notesList;
    if (!list) return;
    list.innerHTML = (notes || []).map((note) => `<li>${note}</li>`).join('');
  }

  function updateSaturdayVisibility() {
    const hide = els.showSaturday && !els.showSaturday.checked;
    document.querySelectorAll('#pc-table, #pc-breakdown-table').forEach((table) => {
      table.classList.toggle('pc-hide-sat', hide);
    });
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll('[data-pc-view]').forEach((btn) => {
      const active = btn.getAttribute('data-pc-view') === view;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (els.overviewPanel) els.overviewPanel.hidden = view !== 'overview';
    if (els.breakdownPanel) els.breakdownPanel.hidden = view !== 'breakdown';
    if (view === 'breakdown') renderBreakdown();
  }

  function renderMeta(data) {
    if (!els.meta || !data) return;
    const cat = data.category && data.category !== 'all' ? data.category : 'all machines';
    const groupCount = (data.shift_pools || []).length;
    const modeLabel = data.schedule_mode_label || data.schedule_mode || 'plan';
    const asOf = data.as_of_date ? ` · from ${data.as_of_date}` : '';
    els.meta.textContent = `${data.machine_count} machines · ${groupCount} shift pools · ${cat} · ${modeLabel}${asOf}`;
  }

  function renderAll(data) {
    state.data = data;
    populateCategories(data.machine_types);
    populateBreakdownMonths(data.months);
    renderSummary(data.totals, data.pool_totals);
    renderTable(data.months, data.totals);
    renderBreakdown();
    renderNotes(data.notes);
    renderMeta(data);
    updateSaturdayVisibility();
    if (data.shift_pools?.length && state.expandedPools.size === 0) {
      data.shift_pools.forEach((pool) => state.expandedPools.add(pool.key || pool.label));
    }
    setView(state.view);
  }

  async function loadData() {
    const year = Number(els.year?.value || new Date().getFullYear());
    const category = els.category?.value || 'all';
    const mode = els.mode?.value || 'forecast';
    setLoading(true);
    showAlert('');
    try {
      const params = new URLSearchParams({ year: String(year), category, mode });
      const res = await fetch(`/api/production-capacity?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      state.expandedPools.clear();
      state.expandedGroups.clear();
      renderAll(data);
    } catch (err) {
      showAlert(err.message || 'Failed to load capacity data.');
      if (els.tableBody) {
        els.tableBody.innerHTML = '<tr><td colspan="11" class="pc-empty">Could not load data.</td></tr>';
      }
      if (els.breakdownBody) {
        els.breakdownBody.innerHTML = '<tr><td colspan="10" class="pc-empty">Could not load data.</td></tr>';
      }
    } finally {
      setLoading(false);
    }
  }

  function breakdownCsvRows(entity, prefix) {
    const showSat = els.showSaturday?.checked !== false;
    const row = periodRow(entity);
    const cells = [
      prefix + (entity.label || ''),
      row.weekday_scheduled_hours,
      row.weekday_capacity_hours,
      row.weekday_utilization_pct,
    ];
    if (showSat) {
      cells.push(row.saturday_scheduled_hours, row.saturday_capacity_hours, row.saturday_utilization_pct);
    }
    cells.push(row.total_scheduled_hours, row.total_capacity_hours, row.total_utilization_pct);
    return cells.join(',');
  }

  function exportCsv() {
    const data = state.data;
    if (!data) return;

    const showSat = els.showSaturday?.checked !== false;
    const periodLabel = state.breakdownMonth === 'year'
      ? 'full-year'
      : (data.months || []).find((m) => String(m.month) === state.breakdownMonth)?.month_key || state.breakdownMonth;

    if (state.view === 'breakdown' && (data.shift_pools?.length || data.groups?.length)) {
      const headers = ['Shift pool / group / machine', 'Weekday scheduled (h)', 'Weekday capacity (h)', 'Weekday load %'];
      if (showSat) headers.push('Saturday scheduled (h)', 'Saturday capacity (h)', 'Saturday load %');
      headers.push('Total scheduled (h)', 'Total capacity (h)', 'Total load %');
      const lines = [headers.join(',')];
      (data.shift_pools || []).forEach((pool) => {
        lines.push(breakdownCsvRows(pool, ''));
        (pool.groups || []).forEach((group) => {
          lines.push(breakdownCsvRows(group, '  '));
          (group.machines || []).forEach((machine) => {
            lines.push(breakdownCsvRows(machine, '    '));
          });
        });
      });
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `production-capacity-breakdown-${data.year}-${periodLabel}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      return;
    }

    if (!data.months?.length) return;
    const headers = ['Month', 'Working days', 'Saturday days'];
    headers.push('Weekday scheduled (h)', 'Weekday capacity (h)', 'Weekday load %');
    if (showSat) headers.push('Saturday scheduled (h)', 'Saturday capacity (h)', 'Saturday load %');
    headers.push('Total scheduled (h)', 'Total capacity (h)', 'Total load %');

    const lines = [headers.join(',')];
    data.months.forEach((row) => {
      const cells = [
        row.month_label,
        row.working_days,
        row.saturday_days,
        row.weekday_scheduled_hours,
        row.weekday_capacity_hours,
        row.weekday_utilization_pct,
      ];
      if (showSat) {
        cells.push(row.saturday_scheduled_hours, row.saturday_capacity_hours, row.saturday_utilization_pct);
      }
      cells.push(row.total_scheduled_hours, row.total_capacity_hours, row.total_utilization_pct);
      lines.push(cells.join(','));
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `production-capacity-${data.year}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function bindEvents() {
    els.refresh?.addEventListener('click', loadData);
    els.year?.addEventListener('change', loadData);
    els.category?.addEventListener('change', loadData);
    els.mode?.addEventListener('change', loadData);
    els.showSaturday?.addEventListener('change', updateSaturdayVisibility);
    els.export?.addEventListener('click', exportCsv);
    els.breakdownMonth?.addEventListener('change', () => {
      state.breakdownMonth = els.breakdownMonth.value || 'year';
      renderBreakdown();
    });

    document.querySelectorAll('[data-pc-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setView(btn.getAttribute('data-pc-view') || 'overview');
      });
    });

    els.breakdownBody?.addEventListener('click', (event) => {
      const toggle = event.target.closest('.pc-breakdown-toggle');
      if (!toggle) return;
      const key = toggle.getAttribute('data-toggle-key');
      const type = toggle.getAttribute('data-toggle-type');
      if (!key) return;
      if (type === 'pool') {
        if (state.expandedPools.has(key)) state.expandedPools.delete(key);
        else state.expandedPools.add(key);
      } else {
        if (state.expandedGroups.has(key)) state.expandedGroups.delete(key);
        else state.expandedGroups.add(key);
      }
      renderBreakdown();
    });
  }

  function init() {
    els.year = $('pc-year');
    els.mode = $('pc-mode');
    els.category = $('pc-category');
    els.showSaturday = $('pc-show-saturday');
    els.refresh = $('pc-refresh');
    els.export = $('pc-export');
    els.alert = $('pc-alert');
    els.meta = $('pc-meta');
    els.table = $('pc-table');
    els.tableBody = $('pc-table-body');
    els.tableFoot = $('pc-table-foot');
    els.notesList = $('pc-notes-list');
    els.overviewPanel = $('pc-overview-panel');
    els.breakdownPanel = $('pc-breakdown-panel');
    els.breakdownBody = $('pc-breakdown-body');
    els.breakdownMonth = $('pc-breakdown-month');

    if (els.year) els.year.value = String(new Date().getFullYear());
    bindEvents();
    loadData();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
