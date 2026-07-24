(function driverViewInit() {
  'use strict';

  const MAX_WEEKS = 4;
  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const state = {
    items: [],
    loading: false,
    weekOptions: [],
    selectedWeekKeys: new Set(),
  };

  const els = {
    stats: document.getElementById('dv-stats'),
    weekFilters: document.getElementById('dv-week-filters'),
    loading: document.getElementById('dv-loading'),
    tableWrap: document.getElementById('dv-table-wrap'),
    tableBody: document.getElementById('dv-table-body'),
    empty: document.getElementById('dv-empty'),
    refresh: document.getElementById('dv-refresh'),
    exportBtn: document.getElementById('dv-export'),
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseDateOnly(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day
    ) {
      return null;
    }
    return date;
  }

  function dateInputValue(value) {
    const date = parseDateOnly(value);
    if (!date) return '';
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function commitmentDate(item) {
    return dateInputValue(item.coway_edd) || dateInputValue(item.due_date);
  }

  function isoWeekNo(value) {
    const date = parseDateOnly(value);
    if (!date) return null;
    const dayNum = date.getUTCDay() || 7;
    const thursday = new Date(date);
    thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    return Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
  }

  function isoWeekKey(value) {
    const date = parseDateOnly(value);
    if (!date) return null;
    const dayNum = date.getUTCDay() || 7;
    const thursday = new Date(date);
    thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNum);
    const isoYear = thursday.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const weekNo = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
    return `${isoYear}-W${String(weekNo).padStart(2, '0')}`;
  }

  function itemWeekKey(item) {
    return isoWeekKey(commitmentDate(item));
  }

  function weekdayName(value) {
    const date = parseDateOnly(value);
    if (!date) return '';
    return WEEKDAY_NAMES[date.getUTCDay()] || '';
  }

  function weekLabel(item) {
    const commitment = commitmentDate(item);
    const weekNo = isoWeekNo(commitment);
    if (!weekNo) return '—';
    const weekday = weekdayName(commitment);
    return weekday ? `Week ${weekNo} - ${weekday}` : `Week ${weekNo}`;
  }

  function formatDate(value) {
    const text = dateInputValue(value);
    if (!text) return '—';
    const parts = text.split('-');
    if (parts.length !== 3) return text;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }

  function formatQty(value) {
    if (value === null || value === undefined || value === '') return '—';
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    if (Number.isInteger(num)) return String(num);
    return String(num);
  }

  function formatPartialNo(item) {
    const value = item?.partial_no ?? item?.pp_partial_no;
    if (value === null || value === undefined || value === '') return '—';
    const num = Number(value);
    return Number.isFinite(num) ? String(num) : '—';
  }

  function formatShortDay(iso) {
    const parts = String(iso || '').split('-');
    if (parts.length !== 3) return String(iso || '');
    const month = MONTH_NAMES[Number(parts[1]) - 1] || parts[1];
    return `${Number(parts[2])} ${month}`;
  }

  function mondayOfIsoWeek(isoYear, weekNo) {
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4);
    week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
    const monday = new Date(week1Monday);
    monday.setUTCDate(week1Monday.getUTCDate() + (weekNo - 1) * 7);
    return monday;
  }

  function weekRangeLabel(isoYear, weekNo) {
    const start = mondayOfIsoWeek(isoYear, weekNo);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    const startIso = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-${String(start.getUTCDate()).padStart(2, '0')}`;
    const endIso = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-${String(end.getUTCDate()).padStart(2, '0')}`;
    if (startIso.slice(0, 7) === endIso.slice(0, 7)) {
      const month = MONTH_NAMES[start.getUTCMonth()] || '';
      return `${start.getUTCDate()}–${end.getUTCDate()} ${month}`;
    }
    return `${formatShortDay(startIso)} – ${formatShortDay(endIso)}`;
  }

  function stageLabel(item) {
    const desc = String(item?.current_stage_desc || '').trim();
    if (desc) return desc;
    if (isWoComplete(item)) return 'Complete';
    return '—';
  }

  function isPackingStage(stageDesc) {
    const text = String(stageDesc || '').trim();
    if (!text) return false;
    const lowered = text.toLowerCase();
    if (lowered === 'packing') return true;
    return lowered.includes('engraving') && lowered.includes('packing');
  }

  function isWoComplete(item) {
    return Boolean(item?.execution_completed)
      || Boolean(item?.erp_all_wo_complete)
      || Boolean(item?.production_completed);
  }

  function isFullyScanned(item) {
    if (Boolean(item?.shipped_completed)) return true;
    const stage = stageLabel(item);
    // Fully scanned only at the last BOM stage (packing) or when all stages are done.
    if (stage === 'Complete') return isWoComplete(item);
    return isPackingStage(stage) && isWoComplete(item);
  }

  function isRowReady(item) {
    return Boolean(item?.coc_done) && Boolean(item?.qaqc_report_ready) && isFullyScanned(item);
  }

  function isException(item) {
    return Boolean(item?.exception);
  }

  function rowClasses(item) {
    const classes = ['dv-row'];
    if (isException(item)) classes.push('is-exception');
    return classes.join(' ');
  }

  function exceptionHtml(item) {
    if (!isException(item)) {
      return '<span class="dv-exception-empty" aria-hidden="true">—</span>';
    }
    const remarks = String(item.remarks || '').trim();
    const title = remarks
      ? `Exception — ${remarks}`
      : 'Exception — important delivery / needs attention';
    return `<span class="dv-exception-flag" title="${escapeHtml(title)}" aria-label="Exception delivery">!</span>`;
  }

  function scanStatusHtml(item) {
    const stage = stageLabel(item);
    const scanned = isFullyScanned(item);
    const badgeClass = scanned ? 'dv-badge dv-badge--ok' : 'dv-badge dv-badge--warn';
    const badgeText = scanned ? 'Fully scanned' : 'Not fully scanned';
    return `
      <div class="dv-status-cell">
        <span class="dv-stage">${escapeHtml(stage)}</span>
        <span class="${badgeClass}">${badgeText}</span>
      </div>`;
  }

  function flagToggleHtml(item, field, label) {
    const psId = escapeHtml(item.planner_ps_id || '');
    const checked = item[field] ? ' checked' : '';
    const displayId = escapeHtml(item.ps_display || item.planner_ps_id || '');
    return `
      <label class="dv-flag-toggle" title="${escapeHtml(label)}">
        <input
          type="checkbox"
          class="dv-flag-input"
          data-action="flag"
          data-flag-field="${escapeHtml(field)}"
          data-ps-id="${psId}"
          aria-label="${escapeHtml(label)} for ${displayId}"
          ${checked}
        >
        <span class="dv-flag-switch" aria-hidden="true"></span>
      </label>
    `;
  }

  function findItem(plannerPsId) {
    const needle = String(plannerPsId || '').trim();
    return (state.items || []).find((row) => String(row.planner_ps_id || '').trim() === needle) || null;
  }

  function updateItem(plannerPsId, patch) {
    const item = findItem(plannerPsId);
    if (!item) return null;
    Object.assign(item, patch);
    return item;
  }

  async function saveFlag(plannerPsId, field, checked, inputEl) {
    const psId = String(plannerPsId || '').trim();
    if (!psId || !field) return;
    const item = findItem(psId);
    const previous = Boolean(item?.[field]);
    const toggle = inputEl?.closest('.dv-flag-toggle') || null;
    if (inputEl) inputEl.disabled = true;
    if (toggle) toggle.classList.add('is-saving');

    const body = {
      planner_ps_id: psId,
      [field]: Boolean(checked),
    };
    if (field === 'qaqc_report_ready') {
      body.stage_desc = String(item?.current_stage_desc || '').trim();
    }

    try {
      const response = await fetch('/api/process-sheets/delivery-flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

      const savedPsId = String(data.planner_ps_id || psId).trim() || psId;
      updateItem(savedPsId, {
        coc_done: Boolean(data.coc_done),
        qaqc_report_ready: Boolean(data.qaqc_report_ready),
      });
      if (inputEl) inputEl.checked = Boolean(data[field]);
      renderTable();
    } catch (err) {
      if (inputEl) inputEl.checked = previous;
      window.alert(`Could not save ${labelForField(field)}: ${err.message}`);
    } finally {
      if (inputEl) inputEl.disabled = false;
      if (toggle) toggle.classList.remove('is-saving');
    }
  }

  function labelForField(field) {
    if (field === 'coc_done') return 'COC done';
    if (field === 'qaqc_report_ready') return 'QAQC report';
    return 'flag';
  }

  function bindFlagInputs() {
    if (!els.tableBody || els.tableBody.dataset.flagsBound === '1') return;
    els.tableBody.dataset.flagsBound = '1';
    els.tableBody.addEventListener('change', (event) => {
      const input = event.target.closest('[data-action="flag"]');
      if (!input) return;
      saveFlag(
        input.dataset.psId || '',
        input.dataset.flagField || '',
        input.checked,
        input,
      );
    });
  }

  function remarksReadonlyHtml(item) {
    const value = String(item.remarks || '').trim();
    if (!value) return '<span class="dv-remarks-empty">—</span>';
    return `<span class="dv-remarks-text">${escapeHtml(value)}</span>`;
  }

  function buildWeekOptions() {
    const todayKey = isoWeekKey(new Date().toISOString().slice(0, 10));
    const options = [];
    let cursor = new Date();
    const seen = new Set();

    for (let i = 0; i < MAX_WEEKS; i += 1) {
      const key = isoWeekKey(cursor.toISOString().slice(0, 10));
      if (!key || seen.has(key)) {
        cursor = new Date(cursor);
        cursor.setUTCDate(cursor.getUTCDate() + 7);
        continue;
      }
      seen.add(key);
      const match = /^(\d{4})-W(\d{2})$/.exec(key);
      const isoYear = match ? Number(match[1]) : cursor.getUTCFullYear();
      const weekNo = match ? Number(match[2]) : isoWeekNo(cursor.toISOString().slice(0, 10));
      options.push({
        key,
        weekNo,
        isoYear,
        isCurrent: key === todayKey,
        rangeLabel: weekRangeLabel(isoYear, weekNo),
        defaultOn: key === todayKey,
      });
      cursor = new Date(cursor);
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }

    return options;
  }

  function initWeekFilters() {
    state.weekOptions = buildWeekOptions();
    state.selectedWeekKeys = new Set(
      state.weekOptions.filter((opt) => opt.defaultOn).map((opt) => opt.key),
    );
    renderWeekFilters();
  }

  function renderWeekFilters() {
    if (!els.weekFilters) return;
    els.weekFilters.innerHTML = state.weekOptions.map((opt) => {
      const active = state.selectedWeekKeys.has(opt.key);
      const classes = ['dv-week-chip'];
      if (active) classes.push('is-active');
      if (opt.isCurrent) classes.push('is-current');
      return `
        <button type="button"
                class="${classes.join(' ')}"
                data-week-key="${escapeHtml(opt.key)}"
                aria-pressed="${active ? 'true' : 'false'}">
          <span class="dv-week-chip-label">Week ${opt.weekNo}</span>
          <span class="dv-week-chip-range">${escapeHtml(opt.rangeLabel)}</span>
        </button>`;
    }).join('');
  }

  function visibleItems() {
    if (!state.selectedWeekKeys.size) return [];
    return (state.items || [])
      .filter((item) => {
        const key = itemWeekKey(item);
        return key && state.selectedWeekKeys.has(key);
      })
      .sort((a, b) => {
        const dateA = commitmentDate(a) || '9999-12-31';
        const dateB = commitmentDate(b) || '9999-12-31';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return String(a.ps_display || a.ps_id || '').localeCompare(String(b.ps_display || b.ps_id || ''));
      });
  }

  function renderTable() {
    const items = visibleItems();
    const total = state.items.length;

    if (els.stats) {
      const weekCount = state.selectedWeekKeys.size;
      const readyCount = items.filter(isRowReady).length;
      const exceptionCount = items.filter(isException).length;
      const exceptionPart = exceptionCount
        ? ` · ${exceptionCount} exception${exceptionCount === 1 ? '' : 's'}`
        : '';
      els.stats.textContent = items.length
        ? `${items.length} deliver${items.length === 1 ? 'y' : 'ies'} across ${weekCount} week${weekCount === 1 ? '' : 's'} · ${readyCount} ready${exceptionPart} · ${total} total`
        : `No deliveries in selected weeks · ${total} total on schedule`;
    }

    if (els.tableBody) {
      els.tableBody.innerHTML = items.map((item) => `
        <tr class="${rowClasses(item)}" data-ps-id="${escapeHtml(item.planner_ps_id || '')}">
          <td class="dv-exception-cell">${exceptionHtml(item)}</td>
          <td class="dv-ps">${escapeHtml(item.ps_display || item.ps_id || '—')}</td>
          <td>${escapeHtml(item.part_desc || '—')}</td>
          <td class="dv-num">${escapeHtml(formatPartialNo(item))}</td>
          <td class="dv-num">${escapeHtml(formatQty(item.so_qty))}</td>
          <td class="dv-num">${escapeHtml(formatQty(item.pp_partial_qty))}</td>
          <td>${escapeHtml(formatDate(item.coway_edd))}</td>
          <td>${escapeHtml(weekLabel(item))}</td>
          <td>${scanStatusHtml(item)}</td>
          <td class="dv-flag-cell">${flagToggleHtml(item, 'coc_done', 'COC done')}</td>
          <td class="dv-flag-cell">${flagToggleHtml(item, 'qaqc_report_ready', 'QAQC report ready')}</td>
          <td class="dv-remarks">${remarksReadonlyHtml(item)}</td>
        </tr>
      `).join('');
    }

    const hasRows = items.length > 0;
    if (els.tableWrap) els.tableWrap.hidden = !hasRows;
    if (els.empty) els.empty.hidden = hasRows || state.loading;
    bindFlagInputs();
  }

  function setLoading(loading) {
    state.loading = loading;
    if (els.loading) els.loading.hidden = !loading;
    if (els.refresh) els.refresh.disabled = loading;
  }

  async function loadSchedule() {
    setLoading(true);
    if (els.tableWrap) els.tableWrap.hidden = true;
    if (els.empty) els.empty.hidden = true;

    try {
      // refresh=1 + no-store: always rebuild on page load / Refresh (never reuse HTTP/memory cache).
      const response = await fetch('/api/trial/delivery-schedule?full=1&refresh=1', {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.items = Array.isArray(data.items) ? data.items : [];
      renderTable();
    } catch (err) {
      console.error(err);
      if (els.stats) els.stats.textContent = 'Failed to load delivery schedule — try Refresh';
      if (els.empty) {
        els.empty.hidden = false;
        els.empty.textContent = 'Could not load delivery schedule. Check connection and try again.';
      }
    } finally {
      setLoading(false);
    }
  }

  async function ensureExcelJs() {
    if (window.ExcelJS) return window.ExcelJS;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load Excel export library'));
      document.head.appendChild(script);
    });
    return window.ExcelJS;
  }

  function selectedWeekNumbers() {
    return state.weekOptions
      .filter((opt) => state.selectedWeekKeys.has(opt.key))
      .map((opt) => opt.weekNo)
      .sort((a, b) => a - b);
  }

  function exportFilename() {
    const stamp = new Date().toISOString().slice(0, 10);
    const weeks = selectedWeekNumbers();
    const weekPart = weeks.length ? `-wk${weeks.join('-')}` : '';
    return `delivery-schedule${weekPart}-${stamp}.xlsx`;
  }

  async function exportToExcel() {
    const items = visibleItems();
    if (!items.length) {
      window.alert('No deliveries in the selected weeks to export.');
      return;
    }
    if (els.exportBtn) els.exportBtn.disabled = true;
    try {
      const ExcelJS = await ensureExcelJs();
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Production Planner';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Delivery schedule');

      const headers = [
        'Exception', 'PS no.', 'Part description', 'PP partial', 'SO qty', 'PP partial qty', 'Coway EDD', 'Week',
        'Current stage', 'Fully scanned', 'COC done', 'QAQC report', 'Remarks',
      ];
      const headerRow = sheet.addRow(headers);
      headerRow.font = { bold: true, size: 11 };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      headerRow.alignment = { vertical: 'middle' };

      items.forEach((item) => {
        sheet.addRow([
          isException(item) ? 'Yes' : '',
          item.ps_display || item.ps_id || '',
          item.part_desc || '',
          formatPartialNo(item) === '—' ? '' : formatPartialNo(item),
          Number.isFinite(Number(item.so_qty)) ? Number(item.so_qty) : '',
          Number.isFinite(Number(item.pp_partial_qty)) ? Number(item.pp_partial_qty) : '',
          formatDate(item.coway_edd) === '—' ? '' : formatDate(item.coway_edd),
          weekLabel(item) === '—' ? '' : weekLabel(item),
          stageLabel(item) === '—' ? '' : stageLabel(item),
          isFullyScanned(item) ? 'Yes' : 'No',
          item.coc_done ? 'Yes' : 'No',
          item.qaqc_report_ready ? 'Yes' : 'No',
          String(item.remarks || '').trim(),
        ]);
      });

      sheet.columns.forEach((col, i) => {
        let max = headers[i]?.length || 10;
        col.eachCell({ includeEmpty: false }, (cell) => {
          const len = String(cell.value ?? '').length;
          if (len > max) max = len;
        });
        col.width = Math.min(Math.max(max + 2, 10), 48);
      });
      sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 0, activeCell: 'A2' }];

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFilename();
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      window.alert(`Export failed: ${err.message}`);
    } finally {
      if (els.exportBtn) els.exportBtn.disabled = false;
    }
  }

  function onWeekChipClick(event) {
    const btn = event.target.closest('[data-week-key]');
    if (!btn) return;
    const key = btn.getAttribute('data-week-key');
    if (!key) return;

    if (state.selectedWeekKeys.has(key)) {
      if (state.selectedWeekKeys.size <= 1) return;
      state.selectedWeekKeys.delete(key);
    } else {
      state.selectedWeekKeys.add(key);
    }
    renderWeekFilters();
    renderTable();
  }

  if (els.weekFilters) {
    els.weekFilters.addEventListener('click', onWeekChipClick);
  }
  if (els.refresh) {
    els.refresh.addEventListener('click', () => loadSchedule());
  }
  if (els.exportBtn) {
    els.exportBtn.addEventListener('click', () => exportToExcel());
  }

  initWeekFilters();
  loadSchedule();
})();
