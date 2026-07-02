(function () {
  'use strict';

  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const state = {
    page: 'sheet',
    sheetData: null,
    monthlyData: null,
    sheetLoading: false,
    monthlyLoading: false,
    sheetBreakdown: false,
    monthlyView: 'overview',
    breakdownMonth: 'year',
    expandedPools: new Set(),
    expandedGroups: new Set(),
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      const snippet = (await res.text()).trim().slice(0, 120);
      if (snippet.toLowerCase().startsWith('<!doctype') || snippet.toLowerCase().startsWith('<html')) {
        throw new Error(
          res.status === 404
            ? 'Capacity API not found — restart the Flask server so the new route is loaded.'
            : `Server returned HTML instead of JSON (HTTP ${res.status}). Restart the Flask server and try again.`,
        );
      }
      throw new Error(`Unexpected response (HTTP ${res.status}): ${snippet || 'empty body'}`);
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function fmtHours(hours) {
    const value = Number(hours || 0);
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}`;
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
    if (num >= 80) return 'pc-pct--green';
    if (num >= 50) return 'pc-pct--yellow';
    if (num >= 30) return 'pc-pct--orange';
    return 'pc-pct--red';
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

  function showAlert(target, message) {
    const el = target || els.alert;
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = message;
  }

  function setLoading(kind, isLoading) {
    if (kind === 'sheet') {
      state.sheetLoading = isLoading;
      if (els.refresh) els.refresh.disabled = isLoading;
      if (els.sheetMeta && isLoading) els.sheetMeta.textContent = 'Loading…';
      return;
    }
    state.monthlyLoading = isLoading;
    if (els.refresh) els.refresh.disabled = isLoading;
    if (els.meta && isLoading) els.meta.textContent = 'Loading…';
  }

  function currentCalendarMonth() {
    const today = new Date();
    return { year: today.getFullYear(), month: today.getMonth() + 1 };
  }

  function nextCalendarMonth(from = currentCalendarMonth()) {
    if (from.month === 12) return { year: from.year + 1, month: 1 };
    return { year: from.year, month: from.month + 1 };
  }

  function defaultSheetMonth(basis) {
    if (basis === 'rest_of_month') return currentCalendarMonth();
    if (basis === 'calendar_month') return nextCalendarMonth();
    return defaultPlanningMonth();
  }

  function applyBasisMonthDefaults(basis) {
    const picked = defaultSheetMonth(basis || els.sheetMode?.value || 'rest_of_month');
    if (els.sheetYear) els.sheetYear.value = String(picked.year);
    if (els.sheetMonth) els.sheetMonth.value = String(picked.month);
  }

  function defaultPlanningMonth() {
    const today = new Date();
    if (today.getDate() >= 23) {
      if (today.getMonth() === 11) return { year: today.getFullYear() + 1, month: 1 };
      return { year: today.getFullYear(), month: today.getMonth() + 2 };
    }
    return { year: today.getFullYear(), month: today.getMonth() + 1 };
  }

  function populateSheetMonthSelect() {
    if (!els.sheetMonth) return;
    els.sheetMonth.innerHTML = MONTH_NAMES.map((name, index) => {
      const month = index + 1;
      return `<option value="${month}">${name}</option>`;
    }).join('');
  }

  function setPage(page) {
    state.page = page;
    document.querySelectorAll('[data-pc-page]').forEach((btn) => {
      const active = btn.getAttribute('data-pc-page') === page;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (els.sheetPanel) els.sheetPanel.hidden = page !== 'sheet';
    if (els.monthlyPanel) els.monthlyPanel.hidden = page !== 'monthly';
    const subtitle = $('pc-subtitle');
    if (subtitle) {
      subtitle.textContent = page === 'sheet'
        ? 'Machine capacity by group — pick a capacity basis (rest of month, calendar month, or rolling 23rd→22nd period).'
        : 'Compare scheduled machine time (from planner segments) against available machine capacity by calendar month.';
    }
    if (page === 'monthly' && !state.monthlyData) loadMonthlyData();
    if (page === 'sheet' && !state.sheetData) loadSheetData();
  }

  function renderDefinitions(definitions) {
    if (!els.definitions) return;
    if (!definitions?.length) {
      els.definitions.innerHTML = '<p class="pc-definitions-loading">No definitions available.</p>';
      return;
    }
    els.definitions.innerHTML = definitions.map((item) => (
      `<p><strong>${item.term}:</strong> ${item.text}</p>`
    )).join('');
  }

  function renderWorkHours(rows) {
    if (!els.workHoursBody) return;
    els.workHoursBody.innerHTML = (rows || []).map((row) => (
      `<tr><td>${row.label}</td><td>${row.hours}</td></tr>`
    )).join('');
  }

  function sheetGroupHeader(groups) {
    const labelTh = '<th class="pc-sheet-th-label"></th>';
    const groupThs = (groups || []).map((group) => (
      `<th><span>${group.label}</span><br><small>(${group.header_subtitle})</small></th>`
    )).join('');
    return `<tr>${labelTh}${groupThs}</tr>`;
  }

  function sheetValueCells(groups, field, cellClass) {
    return (groups || []).map((group) => {
      const value = group[field];
      const display = value == null ? '—' : fmtHours(value);
      const cls = cellClass ? ` class="${cellClass}"` : '';
      return `<td${cls}>${display}</td>`;
    }).join('');
  }

  function sheetPctCells(groups, field) {
    return (groups || []).map((group) => {
      const pct = group[field];
      const cls = `pc-sheet-cell--pct ${pctClass(pct, 1)}`;
      return `<td class="${cls}">${fmtPct(pct)}</td>`;
    }).join('');
  }

  function renderSheetTableBody(groups, section) {
    if (section === 'effective') {
      return `
        <tr>
          <td class="pc-sheet-label">Machine hour / machine per day</td>
          ${sheetValueCells(groups, 'hours_per_machine_per_day', 'pc-sheet-cell--input')}
        </tr>
        <tr>
          <td class="pc-sheet-label">Machine hour / weekday</td>
          ${sheetValueCells(groups, 'hours_per_weekday', 'pc-sheet-cell--calc')}
        </tr>
        <tr>
          <td class="pc-sheet-label">Machine capacity (groups)</td>
          ${sheetValueCells(groups, 'effective_capacity_hours', 'pc-sheet-cell--calc')}
        </tr>
        <tr>
          <td class="pc-sheet-label">Machine plan usage</td>
          ${sheetValueCells(groups, 'plan_usage_hours', 'pc-sheet-cell--usage')}
        </tr>
        <tr>
          <td class="pc-sheet-label">Machine capacity (%)</td>
          ${sheetPctCells(groups, 'effective_utilization_pct')}
        </tr>`;
    }

    return `
      <tr>
        <td class="pc-sheet-label">Overtime on ONE Saturday</td>
        ${sheetValueCells(groups, 'overtime_one_saturday_hours', 'pc-sheet-cell--calc')}
      </tr>
      <tr>
        <td class="pc-sheet-label">Over-time capacity</td>
        ${sheetValueCells(groups, 'overtime_capacity_hours', 'pc-sheet-cell--calc')}
      </tr>
      <tr>
        <td class="pc-sheet-label">Maximum capacity</td>
        ${sheetValueCells(groups, 'maximum_capacity_hours', 'pc-sheet-cell--calc')}
      </tr>
      <tr>
        <td class="pc-sheet-label">Machine plan usage</td>
        ${sheetValueCells(groups, 'plan_usage_hours', 'pc-sheet-cell--usage')}
      </tr>
      <tr>
        <td class="pc-sheet-label">Machine capacity (%)</td>
        ${sheetPctCells(groups, 'maximum_utilization_pct')}
      </tr>`;
  }

  function renderMachineBreakdownRows(groups, section) {
    if (!state.sheetBreakdown) return '';
    const lines = [];
    groups.forEach((group, groupIndex) => {
      (group.machines || []).forEach((machine) => {
        const capField = section === 'effective' ? 'effective_capacity_hours' : 'maximum_capacity_hours';
        const pctField = section === 'effective' ? 'effective_utilization_pct' : 'maximum_utilization_pct';
        const cells = groups.map((_, colIndex) => {
          if (colIndex !== groupIndex) return '<td></td>';
          const cap = fmtHours(machine[capField]);
          const usage = fmtHours(machine.plan_usage_hours);
          const pct = fmtPct(machine[pctField]);
          return `<td class="pc-sheet-cell--usage" title="${usage} h planned / ${cap} h capacity">${usage} / ${cap} <span class="pc-sheet-cell--pct ${pctClass(machine[pctField], 1)}">(${pct})</span></td>`;
        }).join('');
        lines.push(`
          <tr class="pc-sheet-row--machine">
            <td class="pc-sheet-label">${machine.machine_code}</td>
            ${cells}
          </tr>`);
      });
    });
    return lines.join('');
  }

  function renderSheetTables(data) {
    const groups = data?.groups || [];
    if (els.effectiveHead) els.effectiveHead.innerHTML = sheetGroupHeader(groups);
    if (els.maximumHead) els.maximumHead.innerHTML = sheetGroupHeader(groups);

    if (!groups.length) {
      const empty = `<tr><td colspan="${groups.length + 1}" class="pc-empty">No machine groups found.</td></tr>`;
      if (els.effectiveBody) els.effectiveBody.innerHTML = empty;
      if (els.maximumBody) els.maximumBody.innerHTML = empty;
      return;
    }

    if (els.effectiveBody) {
      els.effectiveBody.innerHTML = renderSheetTableBody(groups, 'effective')
        + renderMachineBreakdownRows(groups, 'effective');
    }
    if (els.maximumBody) {
      els.maximumBody.innerHTML = renderSheetTableBody(groups, 'maximum')
        + renderMachineBreakdownRows(groups, 'maximum');
    }
  }

  function sheetActiveWindow(data) {
    if (!data) return { start: '', end: '' };
    const start = data.active_period_start || data.capacity_window_start || '';
    const end = data.active_period_end || data.capacity_window_end || '';
    if (start && end) return { start, end };
    if (data.capacity_basis === 'calendar_month') {
      return {
        start: data.calendar_month_start || '',
        end: data.calendar_month_end || '',
      };
    }
    return { start: '', end: '' };
  }

  function renderSheetGlobals(data) {
    if (!data) return;
    const basis = data.capacity_basis || data.schedule_mode || 'rolling_period';
    const isRestRemaining = basis === 'rest_of_month' && data.capacity_window_mode === 'remaining';
    const { start: activeStart, end: activeEnd } = sheetActiveWindow(data);
    const weekdaysLabel = $('pc-global-weekdays-label');
    const saturdaysLabel = $('pc-global-saturdays-label');
    const periodLabel = $('pc-global-period-label');
    if (weekdaysLabel) {
      weekdaysLabel.textContent = isRestRemaining ? 'Week days left (less PH)' : 'Week days less PH';
    }
    if (saturdaysLabel) {
      saturdaysLabel.textContent = isRestRemaining ? 'Saturdays left' : 'No. of Sat';
    }
    if (periodLabel) {
      if (basis === 'calendar_month') periodLabel.textContent = 'Calendar period';
      else if (isRestRemaining) periodLabel.textContent = 'Active window';
      else if (basis === 'rolling_period') periodLabel.textContent = 'Rolling period';
      else periodLabel.textContent = 'Period';
    }
    if (els.globalMonth) els.globalMonth.textContent = data.planning_month_label || '—';
    if (els.globalWeekdays) {
      els.globalWeekdays.textContent = String(data.weekdays_less_ph ?? '—');
      if (data.weekdays_less_ph_full != null && Number(data.weekdays_less_ph_full) !== Number(data.weekdays_less_ph)) {
        els.globalWeekdays.title = `${data.weekdays_less_ph_full} weekdays in full reference window`;
      } else if (els.globalWeekdays) {
        els.globalWeekdays.removeAttribute('title');
      }
    }
    if (els.globalSaturdays) {
      els.globalSaturdays.textContent = String(data.saturday_count ?? '—');
      if (data.saturday_count_full != null && Number(data.saturday_count_full) !== Number(data.saturday_count)) {
        els.globalSaturdays.title = `${data.saturday_count_full} Saturdays in full reference window`;
      } else if (els.globalSaturdays) {
        els.globalSaturdays.removeAttribute('title');
      }
    }
    if (els.globalPeriod) {
      if (activeStart && activeEnd) {
        els.globalPeriod.textContent = `${activeStart} → ${activeEnd}`;
      } else {
        els.globalPeriod.textContent = '— (restart server to load capacity basis)';
      }
      if (basis === 'rolling_period' && data.period_start && data.period_end) {
        els.globalPeriod.title = `Rolling reference: ${data.period_start} → ${data.period_end}`;
      } else if (basis === 'calendar_month' && data.calendar_month_start) {
        els.globalPeriod.title = `Calendar month ${data.calendar_month_start} → ${data.calendar_month_end}`;
      } else {
        els.globalPeriod.removeAttribute('title');
      }
    }
  }

  function renderSheetMeta(data) {
    if (!els.sheetMeta || !data) return;
    const ph = data.public_holiday_count ? ` · ${data.public_holiday_count} PH` : '';
    const { start, end } = sheetActiveWindow(data);
    const windowRange = start && end ? `${start} → ${end}` : '—';
    els.sheetMeta.textContent = `${data.capacity_basis_label || data.schedule_mode_label || 'Capacity'} · ${windowRange}${ph}`;
  }

  function renderSheetNotes(data) {
    const list = els.sheetNotesList;
    if (list) list.innerHTML = (data?.notes || []).map((note) => `<li>${note}</li>`).join('');

    const holidaysWrap = els.sheetHolidays;
    const holidaysList = els.sheetHolidaysList;
    const holidays = data?.public_holidays || [];
    if (holidaysWrap && holidaysList) {
      if (holidays.length) {
        holidaysWrap.hidden = false;
        holidaysList.innerHTML = holidays.map((row) => (
          `<li>${row.holiday_date} (${row.weekday})</li>`
        )).join('');
      } else {
        holidaysWrap.hidden = true;
        holidaysList.innerHTML = '';
      }
    }
  }

  function renderSheetAll(data) {
    state.sheetData = data;
    renderDefinitions(data.definitions);
    renderWorkHours(data.work_hours_reference);
    renderSheetGlobals(data);
    renderSheetTables(data);
    renderSheetMeta(data);
    renderSheetNotes(data);
    if (data.basis_warning) {
      showAlert(els.sheetAlert, data.basis_warning);
    } else {
      showAlert(els.sheetAlert, '');
    }
  }

  async function loadSheetData() {
    const basis = els.sheetMode?.value || 'rest_of_month';
    const year = Number(els.sheetYear?.value || defaultSheetMonth(basis).year);
    const month = Number(els.sheetMonth?.value || defaultSheetMonth(basis).month);
    setLoading('sheet', true);
    showAlert(els.sheetAlert, '');
    try {
      const params = new URLSearchParams({
        view: 'sheet',
        year: String(year),
        month: String(month),
        basis,
        mode: basis,
      });
      const data = await fetchJson(`/api/production-capacity?${params.toString()}`);
      renderSheetAll(data);
    } catch (err) {
      showAlert(els.sheetAlert, err.message || 'Failed to load capacity sheet.');
      if (els.effectiveBody) {
        els.effectiveBody.innerHTML = '<tr><td class="pc-empty">Could not load data.</td></tr>';
      }
      if (els.maximumBody) {
        els.maximumBody.innerHTML = '<tr><td class="pc-empty">Could not load data.</td></tr>';
      }
    } finally {
      setLoading('sheet', false);
    }
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
    $('pc-stat-weekday-sched').textContent = `${fmtHours(totals.weekday_scheduled_hours)} h`;
    $('pc-stat-weekday-sched-sub').textContent = `${Math.round(totals.weekday_scheduled_minutes).toLocaleString()} min scheduled`;
    $('pc-stat-weekday-cap').textContent = `${fmtHours(totals.weekday_capacity_hours)} h`;
    $('pc-stat-weekday-cap-sub').textContent = `${Math.round(totals.weekday_capacity_minutes).toLocaleString()} min available`;
    $('pc-stat-weekday-util').textContent = fmtPct(totals.weekday_utilization_pct);
    const bar = $('pc-stat-weekday-util-bar');
    if (bar) bar.style.width = `${Math.min(100, totals.weekday_utilization_pct || 0)}%`;
    $('pc-stat-sat-sched').textContent = `${fmtHours(totals.saturday_scheduled_hours)} h`;
    $('pc-stat-sat-sched-sub').textContent = `${Math.round(totals.saturday_scheduled_minutes).toLocaleString()} min · cap ${fmtHours(totals.saturday_capacity_hours)} h`;

    const hr24 = poolTotals?.['24HR'];
    const std = poolTotals?.STANDARD;
    $('pc-stat-24hr-util').textContent = hr24 ? fmtPct(hr24.weekday_utilization_pct) : '—';
    $('pc-stat-24hr-sub').textContent = hr24
      ? `${fmtHours(hr24.weekday_scheduled_hours)} / ${fmtHours(hr24.weekday_capacity_hours)} h weekday`
      : 'No 24-hour machines';
    $('pc-stat-std-util').textContent = std ? fmtPct(std.weekday_utilization_pct) : '—';
    $('pc-stat-std-sub').textContent = std
      ? `${fmtHours(std.weekday_scheduled_hours)} / ${fmtHours(std.weekday_capacity_hours)} h weekday`
      : 'No standard-shift machines';
  }

  function renderMetricCells(row) {
    return `
      <td>${fmtMinutesAsHours(row.weekday_scheduled_minutes)} h</td>
      <td>${fmtMinutesAsHours(row.weekday_capacity_minutes)} h</td>
      <td class="pc-pct ${pctClass(row.weekday_utilization_pct, row.weekday_capacity_minutes)}">
        ${fmtPct(row.weekday_utilization_pct)}${utilBarHtml(row.weekday_utilization_pct)}
      </td>
      <td class="pc-col-sat">${fmtMinutesAsHours(row.saturday_scheduled_minutes)} h</td>
      <td class="pc-col-sat">${fmtMinutesAsHours(row.saturday_capacity_minutes)} h</td>
      <td class="pc-col-sat pc-pct ${pctClass(row.saturday_utilization_pct, row.saturday_capacity_minutes)}">
        ${satPctCell(row, 'saturday')}
      </td>
      <td>${fmtMinutesAsHours(row.total_scheduled_minutes)} h</td>
      <td>${fmtMinutesAsHours(row.total_capacity_minutes)} h</td>
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
        <td>${fmtMinutesAsHours(row.weekday_scheduled_minutes)} h</td>
        <td>${fmtMinutesAsHours(row.weekday_capacity_minutes)} h</td>
        <td class="pc-pct ${pctClass(row.weekday_utilization_pct, row.weekday_capacity_minutes)}">${fmtPct(row.weekday_utilization_pct)}</td>
        <td class="pc-col-sat">${fmtMinutesAsHours(row.saturday_scheduled_minutes)} h</td>
        <td class="pc-col-sat">${fmtMinutesAsHours(row.saturday_capacity_minutes)} h</td>
        <td class="pc-col-sat pc-pct ${pctClass(row.saturday_utilization_pct, row.saturday_capacity_minutes)}">${satPctCell(row, 'saturday')}</td>
        <td>${fmtMinutesAsHours(row.total_scheduled_minutes)} h</td>
        <td>${fmtMinutesAsHours(row.total_capacity_minutes)} h</td>
        <td class="pc-pct ${pctClass(row.total_utilization_pct, row.total_capacity_minutes)}">${fmtPct(row.total_utilization_pct)}</td>
      </tr>`;
  }

  function renderBreakdown() {
    const body = els.breakdownBody;
    if (!body) return;
    const data = state.monthlyData;
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

  function setMonthlyView(view) {
    state.monthlyView = view;
    document.querySelectorAll('[data-pc-view]').forEach((btn) => {
      const active = btn.getAttribute('data-pc-view') === view;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (els.overviewPanel) els.overviewPanel.hidden = view !== 'overview';
    if (els.breakdownPanel) els.breakdownPanel.hidden = view !== 'breakdown';
    if (view === 'breakdown') renderBreakdown();
  }

  function renderMonthlyMeta(data) {
    if (!els.meta || !data) return;
    const cat = data.category && data.category !== 'all' ? data.category : 'all machines';
    const groupCount = (data.shift_pools || []).length;
    const modeLabel = data.schedule_mode_label || data.schedule_mode || 'plan';
    const asOf = data.as_of_date ? ` · from ${data.as_of_date}` : '';
    els.meta.textContent = `${data.machine_count} machines · ${groupCount} shift pools · ${cat} · ${modeLabel}${asOf}`;
  }

  function renderMonthlyAll(data) {
    state.monthlyData = data;
    populateCategories(data.machine_types);
    populateBreakdownMonths(data.months);
    renderSummary(data.totals, data.pool_totals);
    renderTable(data.months, data.totals);
    renderBreakdown();
    renderNotes(data.notes);
    renderMonthlyMeta(data);
    updateSaturdayVisibility();
    if (data.shift_pools?.length && state.expandedPools.size === 0) {
      data.shift_pools.forEach((pool) => state.expandedPools.add(pool.key || pool.label));
    }
    setMonthlyView(state.monthlyView);
  }

  async function loadMonthlyData() {
    const year = Number(els.year?.value || new Date().getFullYear());
    const category = els.category?.value || 'all';
    const mode = els.mode?.value || 'forecast';
    setLoading('monthly', true);
    showAlert(els.alert, '');
    try {
      const params = new URLSearchParams({ year: String(year), category, mode });
      const data = await fetchJson(`/api/production-capacity?${params.toString()}`);
      state.expandedPools.clear();
      state.expandedGroups.clear();
      renderMonthlyAll(data);
    } catch (err) {
      showAlert(els.alert, err.message || 'Failed to load capacity data.');
      if (els.tableBody) {
        els.tableBody.innerHTML = '<tr><td colspan="11" class="pc-empty">Could not load data.</td></tr>';
      }
      if (els.breakdownBody) {
        els.breakdownBody.innerHTML = '<tr><td colspan="10" class="pc-empty">Could not load data.</td></tr>';
      }
    } finally {
      setLoading('monthly', false);
    }
  }

  function refreshActive() {
    if (state.page === 'sheet') loadSheetData();
    else loadMonthlyData();
  }

  function exportSheetCsv() {
    const data = state.sheetData;
    if (!data?.groups?.length) return;
    const headers = ['Metric', ...data.groups.map((g) => `${g.label} (${g.header_subtitle})`)];
    const lines = [headers.join(',')];

    const effectiveRows = [
      ['Machine hour / machine per day', 'hours_per_machine_per_day'],
      ['Machine hour / weekday', 'hours_per_weekday'],
      ['Machine capacity (groups)', 'effective_capacity_hours'],
      ['Machine plan usage', 'plan_usage_hours'],
      ['Machine capacity (%)', 'effective_utilization_pct'],
    ];
    lines.push('Effective Machine Capacity');
    effectiveRows.forEach(([label, field]) => {
      lines.push([label, ...data.groups.map((g) => g[field])].join(','));
    });

    lines.push('');
    lines.push('Maximum (Design) Capacity');
    const maxRows = [
      ['Overtime on ONE Saturday', 'overtime_one_saturday_hours'],
      ['Over-time capacity', 'overtime_capacity_hours'],
      ['Maximum capacity', 'maximum_capacity_hours'],
      ['Machine plan usage', 'plan_usage_hours'],
      ['Machine capacity (%)', 'maximum_utilization_pct'],
    ];
    maxRows.forEach(([label, field]) => {
      lines.push([label, ...data.groups.map((g) => g[field])].join(','));
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `machine-capacity-${data.planning_month_label || 'sheet'}.csv`;
    link.click();
    URL.revokeObjectURL(url);
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

  function exportMonthlyCsv() {
    const data = state.monthlyData;
    if (!data) return;

    const showSat = els.showSaturday?.checked !== false;
    const periodLabel = state.breakdownMonth === 'year'
      ? 'full-year'
      : (data.months || []).find((m) => String(m.month) === state.breakdownMonth)?.month_key || state.breakdownMonth;

    if (state.monthlyView === 'breakdown' && (data.shift_pools?.length || data.groups?.length)) {
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

  function exportCsv() {
    if (state.page === 'sheet') exportSheetCsv();
    else exportMonthlyCsv();
  }

  function bindEvents() {
    els.refresh?.addEventListener('click', refreshActive);

    document.querySelectorAll('[data-pc-page]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setPage(btn.getAttribute('data-pc-page') || 'sheet');
      });
    });

    els.sheetYear?.addEventListener('change', loadSheetData);
    els.sheetMonth?.addEventListener('change', loadSheetData);
    els.sheetMode?.addEventListener('change', () => {
      applyBasisMonthDefaults(els.sheetMode?.value);
      loadSheetData();
    });
    els.sheetBreakdown?.addEventListener('change', () => {
      state.sheetBreakdown = Boolean(els.sheetBreakdown?.checked);
      if (state.sheetData) renderSheetTables(state.sheetData);
    });

    els.year?.addEventListener('change', loadMonthlyData);
    els.category?.addEventListener('change', loadMonthlyData);
    els.mode?.addEventListener('change', loadMonthlyData);
    els.showSaturday?.addEventListener('change', updateSaturdayVisibility);
    els.export?.addEventListener('click', exportCsv);
    els.breakdownMonth?.addEventListener('change', () => {
      state.breakdownMonth = els.breakdownMonth.value || 'year';
      renderBreakdown();
    });

    document.querySelectorAll('[data-pc-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setMonthlyView(btn.getAttribute('data-pc-view') || 'overview');
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
    els.refresh = $('pc-refresh');
    els.export = $('pc-export');
    els.sheetPanel = $('pc-sheet-panel');
    els.monthlyPanel = $('pc-monthly-panel');
    els.definitions = $('pc-definitions');
    els.sheetYear = $('pc-sheet-year');
    els.sheetMonth = $('pc-sheet-month');
    els.sheetMode = $('pc-sheet-mode');
    els.sheetBreakdown = $('pc-sheet-breakdown');
    els.sheetMeta = $('pc-sheet-meta');
    els.sheetAlert = $('pc-sheet-alert');
    els.globalMonth = $('pc-global-month');
    els.globalWeekdays = $('pc-global-weekdays');
    els.globalSaturdays = $('pc-global-saturdays');
    els.globalPeriod = $('pc-global-period');
    els.effectiveHead = $('pc-effective-head');
    els.effectiveBody = $('pc-effective-body');
    els.maximumHead = $('pc-maximum-head');
    els.maximumBody = $('pc-maximum-body');
    els.workHoursBody = $('pc-work-hours-body');
    els.sheetNotesList = $('pc-sheet-notes-list');
    els.sheetHolidays = $('pc-sheet-holidays');
    els.sheetHolidaysList = $('pc-sheet-holidays-list');

    els.year = $('pc-year');
    els.mode = $('pc-mode');
    els.category = $('pc-category');
    els.showSaturday = $('pc-show-saturday');
    els.alert = $('pc-alert');
    els.meta = $('pc-meta');
    els.tableBody = $('pc-table-body');
    els.tableFoot = $('pc-table-foot');
    els.notesList = $('pc-notes-list');
    els.overviewPanel = $('pc-overview-panel');
    els.breakdownPanel = $('pc-breakdown-panel');
    els.breakdownBody = $('pc-breakdown-body');
    els.breakdownMonth = $('pc-breakdown-month');

    const defaultMonth = defaultSheetMonth('rest_of_month');
    populateSheetMonthSelect();
    if (els.sheetYear) els.sheetYear.value = String(defaultMonth.year);
    if (els.sheetMonth) els.sheetMonth.value = String(defaultMonth.month);
    if (els.year) els.year.value = String(new Date().getFullYear());

    bindEvents();
    setPage('sheet');
    loadSheetData();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
