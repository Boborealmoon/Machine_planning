(function () {
  'use strict';

  const JOB_SLOTS = 6;

  const COLUMN_DEFS = [
    { key: 'ps', short: 'PS', long: 'Part', tip: 'Process sheet / part number', auto: true },
    { key: 'opn', short: 'Opn', long: 'Opn', tip: 'Operation', auto: true },
    { key: 'ct', short: 'C/T', long: 'Cycle', tip: 'Cycle time (minutes)', auto: true },
    { key: 'tgt', short: 'Tgt', long: 'Target', tip: 'Target output for the shift', auto: true },
    { key: 'out', short: 'Out', long: 'Output', tip: 'Actual output (manual)', auto: false },
    { key: 'fpce', short: 'F/pce', long: 'F/pce', tip: 'Finish per piece (manual)', auto: false },
    { key: 'inpro', short: 'In-pro', long: 'In prog', tip: 'In progress (manual)', auto: false },
    { key: 'quahis', short: 'Qua/his', long: 'Quality', tip: 'Quality history (manual)', auto: false },
    { key: 'rejects', short: 'Rej', long: 'Reject', tip: 'Rejects (manual)', auto: false },
  ];

  const state = {
    workDate: '',
    sheetId: null,
    shiftStart: '08:30',
    shiftEnd: '20:00',
    effectiveMinutes: 0,
    planLocked: false,
    isToday: true,
    canEditPlan: false,
    editUnlocked: false,
    requiresPasscode: false,
    sections: [],
    snapshots: [],
    compactSlots: false,
    collapseIdle: true,
    fullLabels: false,
    showMcFields: false,
    readOnly: false,
  };

  let saveTimer = null;
  let pendingPatch = null;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatPct(ratio) {
    if (!Number.isFinite(ratio)) return '—';
    return `${(ratio * 100).toFixed(1)}%`;
  }

  function pctTone(ratio, target) {
    if (!Number.isFinite(ratio) || !Number.isFinite(target)) return '';
    if (ratio >= target) return 'do-pct--ok';
    if (ratio >= target * 0.9) return 'do-pct--mid';
    return 'do-pct--low';
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function jobHasContent(job) {
    return Boolean(
      compact(job.ps)
      || compact(job.opn)
      || compact(job.ct)
      || compact(job.tgt)
      || compact(job.out)
      || compact(job.fpce)
      || compact(job.inpro)
      || compact(job.quahis)
      || compact(job.rejects)
    );
  }

  function compact(value) {
    return String(value ?? '').trim();
  }

  function visibleJobs(jobs) {
    const list = jobs || [];
    if (!state.compactSlots) return list;
    const filled = list.filter(jobHasContent);
    const hasTrailingBlank = filled.length < list.length;
    if (!filled.length) return [list[0] || {}];
    if (hasTrailingBlank && filled.length < 6) {
      const nextBlank = list.find((job) => !jobHasContent(job));
      return nextBlank ? [...filled, nextBlank] : filled;
    }
    return filled;
  }

  function machineIsIdle(machine) {
    return !(machine.jobs || []).some(jobHasContent) && !compact(machine.mcAm) && !compact(machine.mcOt);
  }

  function setAlert(message, tone = 'info') {
    const el = $('do-alert');
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.className = `do-alert do-alert--${tone}`;
    el.textContent = message;
  }

  function setStatusText() {
    const el = $('do-status-text');
    if (!el) return;
    const parts = [];
    if (state.planLocked) parts.push('Plan locked after 11:00 snapshot');
    else if (state.canEditPlan) parts.push('Plan refreshes from schedule until 11:00');
    else if (!state.isToday) parts.push(state.readOnly ? 'Past day — unlock to edit' : 'Past day');
    if (state.snapshots.length) parts.push(`${state.snapshots.length} snapshot(s)`);
    el.textContent = parts.join(' · ') || 'Live board';
  }

  function renderSnapshots() {
    const panel = $('do-snapshots-panel');
    const list = $('do-snapshot-list');
    const count = $('do-snapshot-count');
    if (!panel || !list) return;
    if (!state.snapshots.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    if (count) count.textContent = `(${state.snapshots.length})`;
    list.innerHTML = state.snapshots.map((snap) => `
      <li>
        <strong>${escapeHtml(snap.label || snap.snapshot_type)}</strong>
        <span>${escapeHtml(String(snap.snapshot_at || '').replace('T', ' ').slice(0, 19))}</span>
      </li>
    `).join('');
  }

  function fieldAttrs(readOnly) {
    return readOnly ? 'readonly tabindex="-1"' : '';
  }

  function columnLabel(col) {
    return state.fullLabels ? col.long : col.short;
  }

  function jobRowTitle(job) {
    const parts = COLUMN_DEFS
      .map((col) => {
        const value = compact(job[col.key]);
        return value ? `${col.tip}: ${value}` : '';
      })
      .filter(Boolean);
    return parts.join(' · ');
  }

  function renderJobRow(sectionIdx, machineIdx, job, readOnly) {
    const ro = readOnly ? 'do-input--auto' : 'do-input--manual';
    const autoRo = 'readonly tabindex="-1"';
    const inproActive = compact(job.inpro) ? ' do-inpro-active' : '';
    const rowTitle = jobRowTitle(job);
    const cells = COLUMN_DEFS.map((col) => {
      const isAuto = col.auto;
      const cellClass = isAuto ? 'do-cell--auto' : 'do-cell--manual';
      const extraClass = col.key === 'fpce' ? ' do-cell--fpce' : col.key === 'inpro' ? ' do-cell--inpro' : col.key === 'rejects' ? ' do-cell--rej' : '';
      const inputClass = isAuto ? 'do-input--auto' : ro;
      const fieldAttr = isAuto ? autoRo : fieldAttrs(readOnly);
      const dataField = isAuto ? '' : ` data-field="${col.key === 'rejects' ? 'rejects' : col.key}"`;
      const titleAttr = compact(job[col.key]) ? ` title="${escapeHtml(job[col.key])}"` : '';
      const inproClass = col.key === 'inpro' ? inproActive : '';
      return `<td class="do-cell ${cellClass}${extraClass}"><input class="do-input ${inputClass}${inproClass}"${dataField} value="${escapeHtml(job[col.key])}"${fieldAttr}${titleAttr} /></td>`;
    }).join('');
    return `
      <tr class="do-job-row" data-line-id="${escapeHtml(job.line_id || '')}"${rowTitle ? ` title="${escapeHtml(rowTitle)}"` : ''}>
        ${cells}
      </tr>
    `;
  }

  function renderMetricPill(label, value, toneClass, tip) {
    return `
      <span class="do-metric-pill ${toneClass}" title="${escapeHtml(tip)}">
        <span class="do-metric-pill-label">${escapeHtml(label)}</span>
        <strong class="do-metric-pill-value">${escapeHtml(value)}</strong>
      </span>
    `;
  }

  function renderMachine(section, sectionIdx, machine, machineIdx, readOnly) {
    const jobs = visibleJobs(machine.jobs || []);
    const idle = machineIsIdle(machine);
    const collapsed = state.collapseIdle && idle;
    const utilClass = pctTone(machine.utilisation, section.oeeTarget);
    const actualClass = pctTone(machine.actual, section.oeeTarget);
    const statusClass = idle ? 'do-machine-card--idle' : utilClass ? `do-machine-card--${utilClass.replace('do-pct--', '')}` : '';

    if (collapsed) {
      return `
        <article class="do-machine-card do-machine-card--collapsed" data-section="${sectionIdx}" data-machine="${machineIdx}" data-machine-id="${machine.machine_id}">
          <button type="button" class="do-expand-idle" data-section="${sectionIdx}" data-machine="${machineIdx}">
            <span class="do-machine-name">${escapeHtml(machine.name)}</span>
            <span class="do-idle-tag">Idle — click to expand</span>
          </button>
        </article>
      `;
    }

    const jobRows = jobs.map((job) => renderJobRow(sectionIdx, machineIdx, job, readOnly)).join('');
    const headerCells = COLUMN_DEFS.map((col) =>
      `<th scope="col" title="${escapeHtml(col.tip)}">${escapeHtml(columnLabel(col))}</th>`
    ).join('');
    const fullLabelsClass = state.fullLabels ? ' do-job-table--full-labels' : '';
    const hasMc = Boolean(compact(machine.mcAm) || compact(machine.mcOt));
    const showMc = state.showMcFields || hasMc;
    const truncatedNote = machine.jobs_truncated
      ? `<p class="do-truncated-note" title="Only the first ${JOB_SLOTS} scheduled jobs fit on this board">+${machine.scheduled_total - JOB_SLOTS} more on schedule (max ${JOB_SLOTS} shown)</p>`
      : '';
    const mcToggle = !showMc
      ? `<button type="button" class="do-mc-toggle" data-section="${sectionIdx}" data-machine="${machineIdx}" title="Machinist initials — optional">MC</button>`
      : '';
    const mcFields = showMc
      ? `
          <div class="do-machine-mc">
            <label class="do-mc-field" title="Machinist initials — morning shift (optional)">
              <span>AM</span>
              <input type="text" class="do-input do-input--manual" data-mc="am" value="${escapeHtml(machine.mcAm)}" placeholder="—" ${fieldAttrs(readOnly)} />
            </label>
            <label class="do-mc-field" title="Machinist initials — overtime (optional)">
              <span>OT</span>
              <input type="text" class="do-input do-input--manual" data-mc="ot" value="${escapeHtml(machine.mcOt)}" placeholder="—" ${fieldAttrs(readOnly)} />
            </label>
          </div>
        `
      : '';

    return `
      <article class="do-machine-card ${statusClass}" data-section="${sectionIdx}" data-machine="${machineIdx}" data-machine-id="${machine.machine_id}">
        <header class="do-machine-head">
          <h3 class="do-machine-name">${escapeHtml(machine.name)}</h3>
          <div class="do-machine-metrics">
            ${renderMetricPill('Util', formatPct(machine.utilisation), utilClass, 'Planned load: sum of cycle time × target ÷ effective minutes')}
            ${renderMetricPill('Out eff', formatPct(machine.actual), actualClass, 'Actual load: sum of cycle time × output ÷ effective minutes (fill Out or use production actuals)')}
          </div>
          ${mcToggle}
          ${mcFields}
        </header>
        ${truncatedNote}
        <div class="do-job-table-wrap">
          <table class="do-job-table${fullLabelsClass}">
            <colgroup>
              <col class="do-col-part" />
              <col class="do-col-opn" />
              <col class="do-col-ct" />
              <col class="do-col-num" />
              <col class="do-col-num" />
              <col class="do-col-num" />
              <col class="do-col-num" />
              <col class="do-col-text" />
              <col class="do-col-num" />
            </colgroup>
            <thead>
              <tr>${headerCells}</tr>
            </thead>
            <tbody>
              ${jobRows}
            </tbody>
          </table>
        </div>
      </article>
    `;
  }

  function renderSection(section, sectionIdx, readOnly) {
    const machines = (section.machines || []).map((machine, machineIdx) =>
      renderMachine(section, sectionIdx, machine, machineIdx, readOnly)
    ).join('');
    return `
      <section class="do-area" aria-label="${escapeHtml(section.label)}">
        <div class="do-area-head">${escapeHtml(section.label)}</div>
        <div class="do-area-oee"><span>OEE target</span><strong>${formatPct(section.oeeTarget || 0)}</strong></div>
        <div class="do-area-machines">
          ${machines}
        </div>
      </section>
    `;
  }

  function renderBoard() {
    const board = $('do-board');
    if (!board) return;
    const readOnly = state.readOnly;
    board.classList.toggle('do-board--full-labels', state.fullLabels);
    board.innerHTML = (state.sections || []).map((section, idx) => renderSection(section, idx, readOnly)).join('');
  }

  function applyPayload(payload) {
    state.sheetId = payload.sheet_id;
    state.workDate = payload.work_date;
    state.shiftStart = payload.shiftStart || '08:30';
    state.shiftEnd = payload.shiftEnd || '20:00';
    state.effectiveMinutes = payload.effectiveMinutes || 0;
    state.planLocked = Boolean(payload.plan_locked);
    state.isToday = Boolean(payload.is_today);
    state.canEditPlan = Boolean(payload.can_edit_plan);
    state.editUnlocked = Boolean(payload.edit_unlocked);
    state.requiresPasscode = Boolean(payload.requires_passcode);
    state.sections = payload.sections || [];
    state.snapshots = payload.snapshots || [];
    state.readOnly = state.requiresPasscode && !state.editUnlocked;

    $('do-week-label').textContent = payload.weekLabel || '—';
    $('do-day-label').textContent = payload.dayLabel || '—';
    $('do-work-date').value = state.workDate || todayIso();
    $('do-shift-start').value = state.shiftStart;
    $('do-shift-end').value = state.shiftEnd;
    $('do-effective-mins').textContent = String(state.effectiveMinutes);
    $('do-refresh-plan').hidden = !state.canEditPlan || state.readOnly;
    $('do-unlock-btn').hidden = !state.requiresPasscode || state.editUnlocked;

    setStatusText();
    renderSnapshots();
    renderBoard();
  }

  async function parseJsonResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      if (response.status === 404) {
        throw new Error('Daily output API not found — restart the Flask server to load new routes.');
      }
      throw new Error(`Server returned non-JSON (${response.status}). ${text.slice(0, 120)}`);
    }
    return response.json();
  }

  async function loadBoard(dateText) {
    setAlert('');
    try {
      const response = await fetch(`/api/daily-output?date=${encodeURIComponent(dateText || todayIso())}`);
      const payload = await parseJsonResponse(response);
      if (!response.ok) throw new Error(payload.error || `Load failed (${response.status})`);
      applyPayload(payload);
    } catch (err) {
      setAlert(err.message || 'Failed to load board', 'error');
    }
  }

  function queueSave() {
    if (state.readOnly) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 500);
  }

  function collectPatch() {
    const lines = [];
    const machines = [];
    document.querySelectorAll('.do-machine-card[data-machine-id]').forEach((block) => {
      const machineId = Number(block.dataset.machineId || 0);
      if (!machineId) return;
      const am = block.querySelector('[data-mc="am"]');
      const ot = block.querySelector('[data-mc="ot"]');
      if (am || ot) {
        machines.push({ machine_id: machineId, mcAm: am?.value || '', mcOt: ot?.value || '' });
      }
      block.querySelectorAll('.do-job-row').forEach((row) => {
        const lineId = Number(row.dataset.lineId || 0);
        if (!lineId) return;
        const get = (field) => row.querySelector(`[data-field="${field}"]`)?.value ?? '';
        lines.push({
          line_id: lineId,
          out: get('out'),
          fpce: get('fpce'),
          inpro: get('inpro'),
          quahis: get('quahis'),
          rejects: get('rejects'),
        });
      });
    });
    return {
      work_date: state.workDate,
      shift_start: $('do-shift-start')?.value,
      shift_end: $('do-shift-end')?.value,
      lines,
      machines,
    };
  }

  async function flushSave() {
    if (state.readOnly) return;
    const body = collectPatch();
    try {
      const response = await fetch('/api/daily-output', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await parseJsonResponse(response);
      if (response.status === 403 && payload.requires_passcode) {
        openUnlockDialog();
        return;
      }
      if (!response.ok) throw new Error(payload.error || 'Save failed');
      applyPayload(payload);
    } catch (err) {
      setAlert(err.message || 'Save failed', 'error');
    }
  }

  async function refreshPlan() {
    try {
      const response = await fetch('/api/daily-output/refresh-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_date: state.workDate }),
      });
      const payload = await parseJsonResponse(response);
      if (!response.ok) throw new Error(payload.error || 'Refresh failed');
      applyPayload(payload);
      setAlert('Plan refreshed from schedule.', 'ok');
    } catch (err) {
      setAlert(err.message || 'Refresh failed', 'error');
    }
  }

  function openUnlockDialog() {
    const dialog = $('do-unlock-dialog');
    if (!dialog) return;
    $('do-unlock-error').hidden = true;
    $('do-unlock-passcode').value = '';
    dialog.showModal();
  }

  async function submitUnlock(event) {
    event.preventDefault();
    const passcode = $('do-unlock-passcode').value;
    try {
      const response = await fetch('/api/daily-output/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode }),
      });
      const payload = await parseJsonResponse(response);
      if (!response.ok) {
        $('do-unlock-error').hidden = false;
        $('do-unlock-error').textContent = payload.error || 'Invalid passcode';
        return;
      }
      $('do-unlock-dialog').close();
      await loadBoard(state.workDate);
    } catch (err) {
      $('do-unlock-error').hidden = false;
      $('do-unlock-error').textContent = err.message || 'Unlock failed';
    }
  }

  function bindEvents() {
    $('do-work-date')?.addEventListener('change', (e) => loadBoard(e.target.value));
    $('do-shift-start')?.addEventListener('change', queueSave);
    $('do-shift-end')?.addEventListener('change', queueSave);
    $('do-refresh-plan')?.addEventListener('click', refreshPlan);
    $('do-unlock-btn')?.addEventListener('click', openUnlockDialog);
    $('do-unlock-form')?.addEventListener('submit', submitUnlock);
    $('do-unlock-cancel')?.addEventListener('click', () => $('do-unlock-dialog')?.close());

    $('do-compact-slots')?.addEventListener('change', (e) => {
      state.compactSlots = e.target.checked;
      renderBoard();
    });
    $('do-collapse-idle')?.addEventListener('change', (e) => {
      state.collapseIdle = e.target.checked;
      renderBoard();
    });
    $('do-full-labels')?.addEventListener('change', (e) => {
      state.fullLabels = e.target.checked;
      renderBoard();
    });

    $('do-board')?.addEventListener('input', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.classList.contains('do-input--manual')) return;
      queueSave();
    });

    $('do-board')?.addEventListener('click', (event) => {
      const expandIdle = event.target.closest('.do-expand-idle');
      if (expandIdle) {
        const sectionIdx = Number(expandIdle.dataset.section);
        const machineIdx = Number(expandIdle.dataset.machine);
        state.collapseIdle = false;
        $('do-collapse-idle').checked = false;
        renderBoard();
        const block = document.querySelector(
          `.do-machine-card[data-section="${sectionIdx}"][data-machine="${machineIdx}"]`
        );
        block?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const mcToggle = event.target.closest('.do-mc-toggle');
      if (mcToggle) {
        state.showMcFields = true;
        renderBoard();
        const sectionIdx = Number(mcToggle.dataset.section);
        const machineIdx = Number(mcToggle.dataset.machine);
        const block = document.querySelector(
          `.do-machine-card[data-section="${sectionIdx}"][data-machine="${machineIdx}"]`
        );
        block?.querySelector('[data-mc="am"]')?.focus();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    state.compactSlots = $('do-compact-slots')?.checked === true;
    state.collapseIdle = $('do-collapse-idle')?.checked !== false;
    state.fullLabels = $('do-full-labels')?.checked === true;
    bindEvents();
    loadBoard(todayIso());
  });
})();
