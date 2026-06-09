(function () {
  const PAGE_SIZE = 100;

  const state = {
    items: [],
    details: new Map(),
    loading: false,
    page: 1,
    erpIncludeCompleted: false,
  };

  const tempState = {
    items: [],
    loading: false,
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function getJson(url, options = {}) {
    const timeoutMs = options.timeoutMs ?? 120000;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
      return data;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(
          'Request timed out. The board query may be slow, or planner_process_sheet may be locked by a stuck ALTER TABLE in Supabase — cancel that query, then restart the app and refresh.'
        );
      }
      throw err;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  async function patchJson(url, body) {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  async function deleteJson(url) {
    const res = await fetch(url, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  function dateInputValue(value) {
    const text = fmtDate(value);
    return text === '-' ? '' : text;
  }

  function canonicalPlannerPsId(itemOrId) {
    if (itemOrId && typeof itemOrId === 'object') {
      const psId = String(itemOrId.ps_id || '').trim();
      if (psId.startsWith('[Temp]')) return psId;
      const source = String(itemOrId.source_ps_id || itemOrId.display_ps_id || psId || '')
        .split('::')[0]
        .trim();
      const partial = Number(partialNo(itemOrId)) || 1;
      return partial > 1 ? `${source}::${partial}` : source;
    }
    const raw = String(itemOrId || '').trim();
    if (raw.startsWith('[Temp]')) return raw;
    if (!raw) return '';
    const source = raw.split('::')[0];
    const partial = Number(raw.split('::')[1] || 1) || 1;
    return partial > 1 ? `${source}::${partial}` : source;
  }

  function findQueueItem(psId) {
    const canonical = canonicalPlannerPsId(psId);
    return state.items.find(row => {
      const rowCanonical = canonicalPlannerPsId(row);
      return rowCanonical === canonical
        || String(row.ps_id || '') === String(psId)
        || String(row.ps_id || '') === canonical;
    });
  }

  function setCowayEddStatus(inputEl, status, message) {
    if (!inputEl) return;
    const label = inputEl.closest('[data-action="coway-edd-wrap"]');
    if (!label) return;
    label.classList.remove('is-saving', 'is-saved', 'is-error');
    if (status) label.classList.add(status);
    let note = label.querySelector('.ps-coway-edd-status');
    if (!message) {
      if (note) note.remove();
      return;
    }
    if (!note) {
      note = document.createElement('span');
      note.className = 'ps-coway-edd-status';
      label.appendChild(note);
    }
    note.textContent = message;
  }

  function cowayEddValue(item, psIdOverride) {
    const psId = canonicalPlannerPsId(psIdOverride || item);
    const cached = state.details.get(psId);
    const fromDetails = cached?.summary?.coway_proposed_edd;
    return dateInputValue(item?.coway_proposed_edd || fromDetails);
  }

  function applyCowayEddToRow(psId, value) {
    const saved = dateInputValue(value);
    const canonical = canonicalPlannerPsId(psId);
    const item = findQueueItem(canonical);
    if (item) item.coway_proposed_edd = saved;
    const cached = state.details.get(canonical) || state.details.get(psId);
    if (cached?.summary) cached.summary.coway_proposed_edd = saved;
    document.querySelectorAll('.ps-row').forEach(row => {
      if (row.dataset.psId !== canonical) return;
      row.querySelectorAll('[data-action="coway-edd"]').forEach(input => {
        input.value = saved;
        input.dataset.lastSaved = saved;
        input.classList.remove('is-error');
        input.removeAttribute('title');
      });
    });
  }

  function renderCowayEddInput(item, psIdOverride) {
    const psId = canonicalPlannerPsId(psIdOverride || item);
    const value = cowayEddValue(item, psId);
    return `
      <label class="ps-highlight ps-highlight--coway" data-action="coway-edd-wrap">
        <small>Coway EDD</small>
        <input
          type="date"
          class="ps-coway-edd-input"
          data-action="coway-edd"
          data-ps-id="${escapeHtml(psId)}"
          value="${escapeHtml(value)}"
          data-last-saved="${escapeHtml(value)}"
        />
      </label>
    `;
  }

  let cowaySaveTimer = null;

  function scheduleCowayEddSave(inputEl) {
    clearTimeout(cowaySaveTimer);
    cowaySaveTimer = setTimeout(() => {
      saveCowayProposedEdd(inputEl.dataset.psId || '', inputEl.value, inputEl);
    }, 250);
  }

  async function saveCowayProposedEdd(psId, value, inputEl) {
    const canonical = canonicalPlannerPsId(psId);
    if (!canonical) return;
    const nextValue = dateInputValue(value);
    if (inputEl && inputEl.dataset.lastSaved === nextValue) return;

    if (inputEl) {
      inputEl.disabled = true;
      setCowayEddStatus(inputEl, 'is-saving', 'Saving…');
    }
    try {
      const data = await postJson('/api/process-sheets/coway-proposed-edd', {
        ps_id: canonical,
        coway_proposed_edd: nextValue || null,
      });
      const saved = dateInputValue(data.coway_proposed_edd);
      const item = findQueueItem(canonical);
      if (item) {
        item.coway_proposed_edd = saved;
        item.ps_id = data.ps_id || canonical;
      }
      const cached = state.details.get(canonical) || state.details.get(psId);
      if (cached?.summary) cached.summary.coway_proposed_edd = saved;
      applyCowayEddToRow(canonical, saved);
      if (inputEl) {
        setCowayEddStatus(inputEl, 'is-saved', saved ? 'Saved' : 'Cleared');
        window.setTimeout(() => {
          if (inputEl.dataset.lastSaved === saved) {
            setCowayEddStatus(inputEl, '', '');
          }
        }, 1800);
      }
    } catch (err) {
      if (inputEl) {
        inputEl.classList.add('is-error');
        inputEl.title = err.message || 'Could not save Coway EDD';
        setCowayEddStatus(inputEl, 'is-error', 'Save failed');
      }
      console.error('coway proposed edd save failed:', err);
    } finally {
      if (inputEl) inputEl.disabled = false;
    }
  }

  function remarksValue(item, psIdOverride) {
    const psId = canonicalPlannerPsId(psIdOverride || item);
    const cached = state.details.get(psId);
    const fromDetails = cached?.summary?.remarks;
    return String(item?.remarks || fromDetails || '').trim();
  }

  function applyRemarksToRow(psId, value) {
    const saved = String(value || '').trim();
    const canonical = canonicalPlannerPsId(psId);
    const item = findQueueItem(canonical);
    if (item) item.remarks = saved;
    const cached = state.details.get(canonical) || state.details.get(psId);
    if (cached?.summary) cached.summary.remarks = saved;
    document.querySelectorAll('.ps-row').forEach(row => {
      if (row.dataset.psId !== canonical) return;
      row.querySelectorAll('[data-action="remarks"]').forEach(input => {
        input.value = saved;
        input.dataset.lastSaved = saved;
        input.classList.remove('is-error');
        input.removeAttribute('title');
        updateRemarksSaveButton(input);
      });
    });
  }

  function setRemarksStatus(inputEl, status, message) {
    if (!inputEl) return;
    const wrap = inputEl.closest('[data-action="remarks-wrap"]');
    if (!wrap) return;
    wrap.classList.remove('is-saving', 'is-saved', 'is-error');
    if (status) wrap.classList.add(status);
    let note = wrap.querySelector('.ps-remarks-status');
    if (!message) {
      if (note) note.remove();
      return;
    }
    if (!note) {
      note = document.createElement('span');
      note.className = 'ps-remarks-status';
      wrap.appendChild(note);
    }
    note.textContent = message;
  }

  function remarksIsDirty(inputEl) {
    if (!inputEl) return false;
    return String(inputEl.value || '').trim() !== String(inputEl.dataset.lastSaved || '').trim();
  }

  function updateRemarksSaveButton(inputEl) {
    if (!inputEl) return;
    const wrap = inputEl.closest('[data-action="remarks-wrap"]');
    if (!wrap) return;
    const btn = wrap.querySelector('[data-action="save-remarks"]');
    if (!btn) return;
    btn.disabled = !remarksIsDirty(inputEl);
  }

  function renderRemarksInput(item, psIdOverride) {
    const psId = canonicalPlannerPsId(psIdOverride || item);
    const value = remarksValue(item, psId);
    return `
      <div class="ps-remarks-wrap" data-action="remarks-wrap" data-ps-id="${escapeHtml(psId)}">
        <label class="ps-highlight ps-highlight--remarks">
          <small>Remarks</small>
          <input
            type="text"
            class="ps-remarks-input"
            data-action="remarks"
            data-ps-id="${escapeHtml(psId)}"
            value="${escapeHtml(value)}"
            data-last-saved="${escapeHtml(value)}"
            placeholder="Add note…"
            maxlength="500"
          />
        </label>
        <button
          type="button"
          class="ps-remarks-save btn btn-light btn-sm"
          data-action="save-remarks"
          data-ps-id="${escapeHtml(psId)}"
          disabled
        >Save</button>
      </div>
    `;
  }

  async function saveRemarks(psId, value, inputEl) {
    const canonical = canonicalPlannerPsId(psId);
    if (!canonical) return;
    const nextValue = String(value || '').trim();
    if (inputEl && inputEl.dataset.lastSaved === nextValue) return;

    if (inputEl) {
      inputEl.disabled = true;
      const wrap = inputEl.closest('[data-action="remarks-wrap"]');
      const btn = wrap?.querySelector('[data-action="save-remarks"]');
      if (btn) btn.disabled = true;
      setRemarksStatus(inputEl, 'is-saving', 'Saving…');
    }
    try {
      const data = await postJson('/api/process-sheets/remarks', {
        ps_id: canonical,
        remarks: nextValue,
      });
      const saved = String(data.remarks || '').trim();
      const item = findQueueItem(canonical);
      if (item) {
        item.remarks = saved;
        item.ps_id = data.ps_id || canonical;
      }
      const cached = state.details.get(canonical) || state.details.get(psId);
      if (cached?.summary) cached.summary.remarks = saved;
      applyRemarksToRow(canonical, saved);
      if (inputEl) {
        inputEl.dataset.lastSaved = saved;
        updateRemarksSaveButton(inputEl);
        setRemarksStatus(inputEl, 'is-saved', saved ? 'Saved' : 'Cleared');
        window.setTimeout(() => {
          if (inputEl.dataset.lastSaved === saved) {
            setRemarksStatus(inputEl, '', '');
          }
        }, 1800);
      }
    } catch (err) {
      if (inputEl) {
        inputEl.classList.add('is-error');
        inputEl.title = err.message || 'Could not save remarks';
        setRemarksStatus(inputEl, 'is-error', err.message || 'Save failed');
      }
      console.error('remarks save failed:', err);
    } finally {
      if (inputEl) {
        inputEl.disabled = false;
        updateRemarksSaveButton(inputEl);
      }
    }
  }

  function numberValue(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? num : 0;
  }

  function fmtQty(value) {
    return numberValue(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  function fmtDate(value) {
    if (!value) return '-';
    return String(value).slice(0, 10);
  }

  function firstQuantity(...values) {
    for (const value of values) {
      if (value !== null && value !== undefined && value !== '') return value;
    }
    return 0;
  }

  function boolValue(value) {
    if (value === true || value === 1) return true;
    const text = String(value || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(text);
  }

  function partialNo(item) {
    const direct = item?.pp_partial_no;
    if (direct !== null && direct !== undefined && direct !== '') return String(direct);
    const idPartial = String(item?.ps_id || '').split('::')[1];
    return idPartial || '1';
  }

  function partialLabel(item) {
    if (isTempPs(item)) {
      const source = String(item.temp_source_label || item.temp_source_ps_id || item.source_ps_id || '').trim();
      return source ? `From ${source}` : 'Reject rework';
    }
    return `Partial ${partialNo(item)}`;
  }

  function woReqQty(item) {
    return firstQuantity(item?.wo_req_qty, item?.partial_qty, item?.display_qty);
  }

  function totalWoQty(item) {
    return firstQuantity(item?.total_wo_qty, item?.total_qty);
  }

  function soDetQty(item) {
    if (item?.so_det_qty === null || item?.so_det_qty === undefined || item?.so_det_qty === '') return null;
    return numberValue(item.so_det_qty);
  }

  function fmtSoQty(item) {
    if (item?.so_det_qty === null || item?.so_det_qty === undefined || item?.so_det_qty === '') return '—';
    return fmtQty(numberValue(item.so_det_qty));
  }

  const SHIPPED_QTY_TOLERANCE = 0.0001;

  function isShippedComplete(item) {
    const soQty = soDetQty(item);
    if (soQty === null) return false;
    const shipped = numberValue(item?.qty_shipped);
    return shipped >= soQty - SHIPPED_QTY_TOLERANCE;
  }

  function todayIso() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function normalizeStatus(value) {
    return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  }

  function displayStatus(value, fallback) {
    const raw = String(value || fallback || '').trim();
    if (!raw) return '-';
    return raw.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  function warningMessage(code) {
    const labels = {
      OVERDUE: 'Past due date',
      NO_FLOW: 'No BOM / flow selected',
      MATERIAL: 'Material shortage or risk',
    };
    return labels[normalizeStatus(code)] || String(code || '').replace(/_/g, ' ');
  }

  function queuedMachines(item) {
    const fromDetails = Array.isArray(item?.queued_machine_details)
      ? item.queued_machine_details
          .map(row => String(row?.machine_code || '').trim())
          .filter(Boolean)
      : [];
    if (fromDetails.length) return fromDetails;
    const direct = Array.isArray(item?.queued_machines) ? item.queued_machines.filter(Boolean) : [];
    if (direct.length) return direct.map(code => String(code));
    const ops = Array.isArray(item?.ops) ? item.ops : [];
    const fromOps = new Set();
    ops.forEach(op => {
      (Array.isArray(op?.queued_machines) ? op.queued_machines : []).forEach(code => {
        if (code) fromOps.add(String(code));
      });
      const machine = op?.machine_code;
      if (machine) fromOps.add(String(machine));
    });
    return [...fromOps];
  }

  function queuedMachineDetails(item) {
    const direct = Array.isArray(item?.queued_machine_details) ? item.queued_machine_details : [];
    if (direct.length) {
      return direct
        .map(row => ({
          machine_code: String(row?.machine_code || '').trim(),
          machine_category: String(row?.machine_category || '').trim(),
        }))
        .filter(row => row.machine_code);
    }
    return queuedMachines(item).map(code => ({ machine_code: code, machine_category: '' }));
  }

  function isQueued(item) {
    if (queuedMachines(item).length) return true;
    const ops = Array.isArray(item?.ops) ? item.ops : [];
    return ops.some(op => Number(op?.block_count || 0) > 0);
  }

  function renderMachinePills(item) {
    const machines = queuedMachineDetails(item);
    if (!machines.length) return '';
    return `
      <div class="ps-machine-pills">
        ${machines.map(row => {
          const title = row.machine_category
            ? `${row.machine_code} · ${row.machine_category}`
            : row.machine_code;
          return `<span class="ps-machine-pill" title="${escapeHtml(title)}">${escapeHtml(row.machine_code)}</span>`;
        }).join('')}
      </div>
    `;
  }

  function renderWarningsPill(warnings) {
    if (!warnings.length) return '';
    const tooltip = warnings.map(warningMessage).join('\n');
    const label = warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`;
    return `
      <span
        class="ps-warnings-pill"
        tabindex="0"
        aria-label="${escapeHtml(tooltip)}"
        title="${escapeHtml(tooltip)}"
      >${escapeHtml(label)}</span>
    `;
  }

  function renderQtyBadge(qty) {
    return `
      <span class="ps-qty-badge">
        <small>Qty</small>
        <strong>${escapeHtml(qty)}</strong>
      </span>
    `;
  }

  function fmtBlockDateTime(value) {
    if (!value) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
      return raw.replace('T', ' ');
    }
    return date.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function blockPlannedTimes(block) {
    const start = block?.expected_start || block?.calculated_start_datetime || block?.planned_start_at;
    const end = block?.expected_end || block?.calculated_end_datetime || block?.planned_end_at;
    return {
      startFmt: fmtBlockDateTime(start),
      endFmt: fmtBlockDateTime(end),
    };
  }

  function findOpForBlock(block, ops) {
    const list = Array.isArray(ops) ? ops : [];
    const opNo = compactText(block?.source_op_no || block?.operation_label);
    const opSeq = Number(block?.source_op_seq_id || 0);
    return list.find(op => {
      const rowNo = compactText(op?.op_no || op?.source_op_no || op?.operation_label);
      const rowSeq = Number(op?.op_seq_id || op?.source_op_seq_id || 0);
      if (opNo && rowNo && opNo === rowNo) return true;
      if (opSeq && rowSeq && opSeq === rowSeq) return true;
      return false;
    });
  }

  function compactText(value) {
    return String(value || '').trim();
  }

  function blockOpLabel(block, ops) {
    const op = findOpForBlock(block, ops);
    const opNo = compactText(block?.source_op_no || op?.op_no || op?.source_op_no);
    const opType = compactText(op?.op_type || op?.operation_name || op?.stage_desc);
    if (opNo && opType) return `Op ${opNo} · ${opType}`;
    if (opNo) return `Op ${opNo}`;
    if (opType) return opType;
    return compactText(block?.operation_label) || 'Operation';
  }

  function blockPlannedRange(block) {
    const { startFmt, endFmt } = blockPlannedTimes(block);
    if (startFmt && endFmt) return `${startFmt} → ${endFmt}`;
    if (startFmt) return `from ${startFmt}`;
    if (endFmt) return `until ${endFmt}`;
    return '';
  }

  function renderDetailsMeta(summary, item, ops) {
    const sourceVoucher = summary.source_voucher_no || item.source_voucher_no || '';
    const qtyShipped = Number(summary.qty_shipped || item.qty_shipped || 0);
    const start = summary.expected_start || item.expected_start;
    const end = summary.expected_end || item.expected_end;
    const plannedRange = start && end
      ? `${String(start).slice(0, 16)} → ${String(end).slice(0, 16)}`
      : (start ? String(start).slice(0, 16) : '-');

    const groups = [
      [
        `<span class="ps-detail-meta-item"><small>WO Req</small><strong>${escapeHtml(fmtQty(woReqQty(summary)))}</strong></span>`,
        `<span class="ps-detail-meta-item"><small>Ops</small><strong>${escapeHtml(ops.length)}</strong></span>`,
      ],
    ];

    const stage = resolveCurrentStage(summary);
    if (stage?.desc) {
      const stageStatus = stage.status ? displayExecutionStatus(stage.status) : '';
      groups.push([
        `<span class="ps-detail-meta-item"><small>${stage.allComplete ? 'Final stage' : 'Current stage'}</small><strong>${escapeHtml(stage.desc)}</strong></span>`,
        stage.opNo ? `<span class="ps-detail-meta-item"><small>Op</small><strong>${escapeHtml(stage.opNo)}</strong></span>` : '',
        stageStatus ? `<span class="ps-detail-meta-item"><small>Stage status</small><strong>${escapeHtml(stageStatus)}</strong></span>` : '',
      ].filter(Boolean));
    }

    if (sourceVoucher || soDetQty(summary) !== null || qtyShipped > 0) {
      groups.push([
        sourceVoucher ? `<span class="ps-detail-meta-item"><small>SO</small><strong>${escapeHtml(sourceVoucher)}</strong></span>` : '',
        sourceVoucher ? `<span class="ps-detail-meta-item"><small>SO Qty</small><strong>${escapeHtml(fmtSoQty(summary))}</strong></span>` : '',
        `<span class="ps-detail-meta-item"><small>Shipped</small><strong>${escapeHtml(fmtQty(qtyShipped))}</strong></span>`,
      ].filter(Boolean));
    }

    groups.push([
      `<span class="ps-detail-meta-item"><small>Planned</small><strong>${escapeHtml(plannedRange)}</strong></span>`,
    ]);

    return `
      <div class="ps-detail-meta">
        ${groups.map(items => `<div class="ps-detail-meta-group">${items.join('')}</div>`).join('')}
      </div>
    `;
  }

  function renderSchedulingInline(item, ops) {
    const opsLabel = `<span class="ps-row-muted">${ops.length} op${ops.length === 1 ? '' : 's'}</span>`;
    if (!isQueued(item)) {
      return `
        <div class="ps-row-scheduling">
          <span class="ps-badge ps-badge--needs-scheduling">Needs scheduling</span>
          ${opsLabel}
        </div>
      `;
    }
    return `
      <div class="ps-row-scheduling">
        <span class="ps-badge ps-badge--queued">Queued</span>
        ${renderMachinePills(item)}
        ${opsLabel}
      </div>
    `;
  }

  function renderDateStrip(item, psId) {
    const due = fmtDate(item.due_date);
    const posted = fmtDate(item.order_date);
    const dueOverdue = isOverdue(item);
    const parts = [];
    if (posted !== '-') {
      parts.push(`<span class="ps-date-item"><small>Posted</small><strong>${escapeHtml(posted)}</strong></span>`);
    }
    parts.push(`
      <span class="ps-date-item ps-date-item--due ${dueOverdue ? 'is-overdue' : ''}">
        <small>PO Due</small><strong>${escapeHtml(due)}</strong>
      </span>
    `);
    parts.push(`<span class="ps-date-item ps-date-item--coway">${renderCowayEddInput(item, psId)}</span>`);
    return `<div class="ps-date-strip">${parts.join('')}</div>`;
  }

  function planningPriority(item) {
    const overdueUnqueued = isOverdue(item) && !isQueued(item) ? 0 : 1;
    const unqueued = !isQueued(item) ? 0 : 1;
    const due = String(item.due_date || '9999-99-99');
    const ps = String(item.display_ps_id || item.ps_id || '');
    return [overdueUnqueued, unqueued, due, ps];
  }

  function comparePlanningPriority(a, b) {
    const left = planningPriority(a);
    const right = planningPriority(b);
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] < right[i]) return -1;
      if (left[i] > right[i]) return 1;
    }
    return 0;
  }

  function poDueSortKey(item) {
    const due = String(item?.due_date || '').trim().slice(0, 10);
    return due || '9999-99-99';
  }

  function currentSortMode() {
    return String(els.sortBy?.value || 'planning').trim().toLowerCase();
  }

  function sortQueueItems(items) {
    const mode = currentSortMode();
    const list = [...items];
    if (mode === 'due_asc') {
      return list.sort((a, b) => {
        const due = poDueSortKey(a).localeCompare(poDueSortKey(b));
        if (due) return due;
        return String(a.display_ps_id || a.ps_id || '').localeCompare(String(b.display_ps_id || b.ps_id || ''));
      });
    }
    if (mode === 'due_desc') {
      return list.sort((a, b) => {
        const da = String(a?.due_date || '').trim().slice(0, 10);
        const db = String(b?.due_date || '').trim().slice(0, 10);
        const aMissing = !da;
        const bMissing = !db;
        if (aMissing !== bMissing) return aMissing ? 1 : -1;
        if (da !== db) return db.localeCompare(da);
        return String(a.display_ps_id || a.ps_id || '').localeCompare(String(b.display_ps_id || b.ps_id || ''));
      });
    }
    return list.sort(comparePlanningPriority);
  }

  function displayExecutionStatus(value) {
    const status = normalizeStatus(value);
    const labels = {
      P: 'Pending SI',
      R: 'Ready to Start',
      I: 'In Process',
      C: 'Completed',
      PENDING_SI: 'Pending SI',
      READY_TO_START: 'Ready to Start',
      IN_PROCESS: 'In Process',
      COMPLETED: 'Completed',
    };
    return labels[status] || displayStatus(value, '-');
  }

  function opExecutionStatus(op) {
    return op?.execution_status || op?.erp_execution_status || '';
  }

  function rollupExecutionStatus(item) {
    const ops = Array.isArray(item?.ops) ? item.ops : [];
    const statuses = ops.map(op => opExecutionStatus(op)).filter(status => normalizeStatus(status));
    if (statuses.length) return statuses[0];
    return item?.execution_status || item?.erp_execution_status || '';
  }

  function isExecutionCompletedStatus(value) {
    const status = normalizeStatus(value);
    return status === 'COMPLETED' || status === 'C';
  }

  function opRemainingQty(op) {
    const direct = numberValue(op?.remaining_qty);
    if (direct > SHIPPED_QTY_TOLERANCE) return direct;
    const required = numberValue(op?.wo_qty_required ?? op?.required_qty ?? 0);
    const finished = numberValue(op?.finished_qty ?? op?.wo_qty_produced ?? 0);
    return Math.max(0, required - finished);
  }

  function opHasWorkOrderEvidence(op) {
    const required = numberValue(op?.wo_qty_required ?? op?.required_qty ?? 0);
    const produced = numberValue(op?.finished_qty ?? op?.wo_qty_produced ?? 0);
    const status = normalizeStatus(opExecutionStatus(op));
    return required > SHIPPED_QTY_TOLERANCE || produced > SHIPPED_QTY_TOLERANCE || Boolean(status);
  }

  function isOpProductionComplete(op) {
    if (!opHasWorkOrderEvidence(op)) return true;
    if (opRemainingQty(op) > SHIPPED_QTY_TOLERANCE) return false;
    return isExecutionCompletedStatus(opExecutionStatus(op));
  }

  function executionStatusRank(value) {
    const status = normalizeStatus(value);
    if (status === 'I' || status === 'IN_PROCESS') return 0;
    if (status === 'R' || status === 'READY_TO_START') return 1;
    if (status === 'P' || status === 'PENDING_SI') return 2;
    if (status === 'C' || status === 'COMPLETED') return 3;
    return 4;
  }

  function sortedOpsForStage(item) {
    const ops = Array.isArray(item?.ops) ? item.ops : [];
    return [...ops].sort((a, b) => {
      const stageA = Number(a.stage_no || a.source_stage_no || 0);
      const stageB = Number(b.stage_no || b.source_stage_no || 0);
      if (stageA !== stageB) return stageA - stageB;
      const opA = Number(a.op_no || a.source_op_no || 0);
      const opB = Number(b.op_no || b.source_op_no || 0);
      if (Number.isFinite(opA) && Number.isFinite(opB) && opA !== opB) return opA - opB;
      return String(a.op_no || a.source_op_no || '').localeCompare(String(b.op_no || b.source_op_no || ''));
    });
  }

  function stageDescFromOp(op) {
    const desc = compactText(op?.op_type || op?.operation_name || op?.stage_desc);
    if (desc) return desc;
    const opNo = compactText(op?.op_no || op?.source_op_no || op?.operation_label);
    return opNo ? `Op ${opNo}` : '';
  }

  function stageFromOp(op, options = {}) {
    const desc = stageDescFromOp(op);
    if (!desc) return null;
    return {
      stageNo: Number(op?.stage_no || op?.source_stage_no || 0) || null,
      opNo: compactText(op?.op_no || op?.source_op_no || op?.operation_label),
      desc,
      status: opExecutionStatus(op),
      allComplete: Boolean(options.allComplete),
    };
  }

  function resolveCurrentStage(item) {
    const headerDesc = compactText(item?.current_stage_desc);
    if (headerDesc) {
      return {
        stageNo: Number(item?.current_stage_no || 0) || null,
        opNo: '',
        desc: headerDesc,
        status: item?.current_stage_status || '',
        allComplete: isExecutionCompletedStatus(item?.current_stage_status),
        source: 'erp',
      };
    }

    const ops = sortedOpsForStage(item);
    const trackedOps = ops.filter(op => opHasWorkOrderEvidence(op));
    if (!trackedOps.length) return null;

    const inProcessOps = trackedOps.filter(op => {
      const status = normalizeStatus(opExecutionStatus(op));
      return status === 'I' || status === 'IN_PROCESS';
    });
    if (inProcessOps.length) {
      const active = inProcessOps.sort((a, b) => (
        numberValue(b?.finished_qty ?? b?.wo_qty_produced)
        - numberValue(a?.finished_qty ?? a?.wo_qty_produced)
      ))[0];
      const resolved = stageFromOp(active);
      if (resolved) {
        resolved.source = 'derived';
        return resolved;
      }
    }

    const openOp = trackedOps.find(op => !isOpProductionComplete(op));
    if (openOp) {
      const resolved = stageFromOp(openOp);
      if (resolved) {
        resolved.source = 'derived';
        return resolved;
      }
    }

    const pendingOps = trackedOps.filter(op => !isExecutionCompletedStatus(opExecutionStatus(op)));
    if (pendingOps.length) {
      const nextOp = pendingOps.sort((a, b) => (
        executionStatusRank(opExecutionStatus(a)) - executionStatusRank(opExecutionStatus(b))
      ))[0];
      const resolved = stageFromOp(nextOp);
      if (resolved) {
        resolved.source = 'derived';
        return resolved;
      }
    }

    if (trackedOps.every(op => isOpProductionComplete(op))) {
      const lastOp = trackedOps[trackedOps.length - 1];
      const resolved = stageFromOp(lastOp, { allComplete: true });
      if (resolved) {
        resolved.source = 'derived';
        resolved.allComplete = true;
        return resolved;
      }
    }

    return null;
  }

  function renderCurrentStageStrip(item) {
    const stage = resolveCurrentStage(item);
    if (!stage?.desc) return '';
    const label = stage.allComplete ? 'Final stage' : 'Current stage';
    const opLabel = stage.opNo ? `<span class="ps-current-stage-op">Op ${escapeHtml(stage.opNo)}</span>` : '';
    const stageNoLabel = stage.stageNo
      ? `<span class="ps-current-stage-no">Stage ${escapeHtml(stage.stageNo)}</span>`
      : '';
    const status = stage.status ? displayExecutionStatus(stage.status) : '';
    const statusHtml = status
      ? `<span class="ps-op-status ${opStatusClass(stage.status)}">${escapeHtml(status)}</span>`
      : '';
    return `
      <div class="ps-current-stage" title="${escapeHtml([label, stage.desc, status].filter(Boolean).join(' · '))}">
        <span class="ps-current-stage-label">${escapeHtml(label)}</span>
        ${stageNoLabel}
        <strong class="ps-current-stage-name">${escapeHtml(stage.desc)}</strong>
        ${opLabel}
        ${statusHtml}
      </div>
    `;
  }

  function trackedExecutionStatuses(item) {
    const ops = Array.isArray(item?.ops) ? item.ops : [];
    const opStatuses = ops
      .map(op => opExecutionStatus(op))
      .filter(status => normalizeStatus(status));
    if (opStatuses.length) return opStatuses;
    const itemStatus = item?.execution_status || item?.erp_execution_status || '';
    return normalizeStatus(itemStatus) ? [itemStatus] : [];
  }

  function opStatusClass(value) {
    const status = normalizeStatus(value);
    if (status === 'I' || status === 'IN_PROCESS') return 'is-in-process';
    if (status === 'R' || status === 'READY_TO_START') return 'is-ready';
    if (status === 'P' || status === 'PENDING_SI') return 'is-pending';
    if (status === 'C' || status === 'COMPLETED') return 'is-completed';
    return 'is-unknown';
  }

  function renderOpStatusCell(op) {
    const status = opExecutionStatus(op);
    if (!normalizeStatus(status)) return '<span class="ps-row-muted">-</span>';
    return `<span class="ps-op-status ${opStatusClass(status)}">${escapeHtml(displayExecutionStatus(status))}</span>`;
  }

  function materialSeverity(item) {
    return String(item.material_status?.severity || '').toLowerCase();
  }

  function isMaterialShortage(item) {
    return ['late', 'warning', 'shortage'].includes(materialSeverity(item));
  }

  function isCompleted(item) {
    const ops = Array.isArray(item?.ops) ? item.ops : [];
    const trackedOps = ops.filter(op => opHasWorkOrderEvidence(op));
    if (trackedOps.some(op => !isOpProductionComplete(op))) return false;
    if (isShippedComplete(item)) return true;
    if (trackedOps.length) {
      return trackedOps.every(op => isOpProductionComplete(op));
    }
    const remaining = numberValue(item?.remaining_qty);
    const finished = numberValue(item?.finished_qty);
    const required = numberValue(firstQuantity(item?.wo_req_qty, item?.display_qty, item?.partial_qty, item?.total_qty, 0));
    const executionDone = boolValue(item?.execution_completed)
      || trackedExecutionStatuses(item).every(status => isExecutionCompletedStatus(status));
    const productionDone = (required > 0 && finished >= (required - SHIPPED_QTY_TOLERANCE))
      || (executionDone && remaining <= SHIPPED_QTY_TOLERANCE);
    if (productionDone) return true;
    if (item && Object.prototype.hasOwnProperty.call(item, 'shipped_completed')) {
      return boolValue(item.shipped_completed);
    }
    return false;
  }

  function isOverdue(item) {
    const due = fmtDate(item.due_date);
    return due !== '-' && due < todayIso() && !isCompleted(item);
  }

  function isSrTagged(item) {
    return [
      item?.ps_id,
      item?.source_ps_id,
      item?.display_ps_id,
      item?.inventory_code,
      item?.part_no,
      item?.part_name,
    ].some(value => /\[sr\]/i.test(String(value || '')));
  }

  function isTempPs(item) {
    return Boolean(item?.is_temp_ps) || String(item?.ps_id || '').startsWith('[Temp]');
  }

  function tempPsDisplayId(item) {
    const raw = String(item?.display_ps_id || item?.ps_id || '').trim();
    if (!raw.startsWith('[Temp]')) return raw;
    if (typeof trialTempPsDisplayId === 'function') return trialTempPsDisplayId(raw);
    const body = raw.slice('[Temp]'.length);
    return body ? `[Temp] ${body}` : raw;
  }

  function tempTrackerLinkLabel(item) {
    const raw = String(item?.display_ps_id || item?.planner_ps_id || '').trim();
    return raw.replace(/^\[Temp\]\s*/i, '') || raw;
  }

  function getPsType(item) {
    if (isTempPs(item)) return 'TEMP';
    const raw = String(item.source_ps_id || item.display_ps_id || item.ps_id || '').split('::')[0];
    if (/\[sr\]/i.test(raw)) return 'SR';
    const upper = raw.toUpperCase();
    const m = upper.match(/^([A-Z]+)/);
    if (!m) return null;
    const prefix = m[1];
    if (prefix === 'MPS') return 'MPS';
    if (prefix === 'APS') return 'APS';
    if (prefix === 'NPS') return 'NPS';
    if (prefix === 'PPS') return 'PPS';
    if (prefix === 'CPS') return 'CPS';
    if (prefix === 'SR') return 'SR';
    return prefix;
  }

  function itemIdentityKey(item) {
    const psId = String(item.ps_id || '').trim();
    if (psId.startsWith('[Temp]')) return psId;
    const sourcePsId = String(item.source_ps_id || item.display_ps_id || psId || '').split('::')[0];
    const partial = String(item.pp_partial_no || String(psId || '').split('::')[1] || '1');
    return `${sourcePsId}::${partial}`;
  }

  function itemSearchText(item) {
    return [
      item.ps_id,
      item.source_ps_id,
      item.display_ps_id,
      item.temp_source_ps_id,
      item.temp_source_label,
      isTempPs(item) ? 'temp reject rework' : '',
      item.inventory_code,
      item.part_no,
      item.part_name,
      item.part_desc,
      partialLabel(item),
      item.selected_flow_code,
      item.selected_bom_code,
      item.status,
      item.planner_status,
      item.current_stage_desc,
      item.source_voucher_no,
      ...(Array.isArray(item.ops) ? item.ops.map(op => [
        op.op_no,
        op.source_op_no,
        op.stage_no,
        op.op_type,
        op.operation_name,
        opExecutionStatus(op),
      ].join(' ')) : []),
    ].join(' ').toLowerCase();
  }

  function parseSearchTerms(raw) {
    return String(raw || '')
      .split(/[,;]+/)
      .map(term => term.trim().toLowerCase())
      .filter(Boolean);
  }

  function matchesSearchTerms(item, terms) {
    if (!terms.length) return true;
    const haystack = itemSearchText(item);
    return terms.some(term => haystack.includes(term));
  }

  function mergeBulkLookupItems(apiRows, localItems) {
    const byKey = new Map();
    const ingest = (item, prefer = false) => {
      if (!item) return;
      const normalized = item.source ? item : normalizeErpItem(item);
      const key = itemIdentityKey(normalized);
      if (!key) return;
      const existing = byKey.get(key);
      if (!existing || prefer || (existing.source === 'erp' && normalized.source !== 'erp')) {
        byKey.set(key, normalized);
      }
    };
    (Array.isArray(apiRows) ? apiRows : []).forEach(row => ingest(row));
    (Array.isArray(localItems) ? localItems : []).forEach(row => ingest(row, true));
    return [...byKey.values()].sort((a, b) => {
      const ps = String(a.display_ps_id || a.ps_id || '').localeCompare(String(b.display_ps_id || b.ps_id || ''));
      if (ps) return ps;
      return Number(partialNo(a)) - Number(partialNo(b));
    });
  }

  function unmatchedBulkLookupTerms(terms, items) {
    return terms.filter(term => !items.some(item => itemSearchText(item).includes(term)));
  }

  function bulkLookupQueueLabel(item) {
    if (isCompleted(item)) return 'Completed';
    if (isQueued(item)) {
      const machines = queuedMachines(item);
      return machines.length ? `Queued (${machines.join(', ')})` : 'Queued';
    }
    return 'Needs scheduling';
  }

  function bulkLookupStageLabel(item) {
    const stage = resolveCurrentStage(item);
    if (!stage?.desc) return '—';
    const status = stage.status ? displayExecutionStatus(stage.status) : '';
    return status ? `${stage.desc} · ${status}` : stage.desc;
  }

  function renderBulkLookupTable(items) {
    if (!items.length) {
      return '<div class="ps-details-empty">No process sheets matched your search terms.</div>';
    }
    return `
      <div class="ps-bulk-lookup-table">
        <div class="ps-table-wrap">
          <table class="ps-table">
            <thead>
              <tr>
                <th>Process sheet</th>
                <th>Partial</th>
                <th>Part</th>
                <th>Description</th>
                <th>Qty</th>
                <th>PO due</th>
                <th>Coway EDD</th>
                <th>Current stage</th>
                <th>Queue</th>
                <th>SO / PO</th>
                <th>Shipped</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(item => {
                const psId = canonicalPlannerPsId(item);
                const displayId = tempPsDisplayId(item) || item.display_ps_id || psId;
                const part = item.part_no || item.part_name || item.inventory_code || '—';
                const qty = fmtQty(firstQuantity(item.display_qty, item.partial_qty, item.wo_req_qty, item.total_qty, 0));
                const due = fmtDate(item.due_date);
                const coway = fmtDate(item.coway_proposed_edd);
                const so = item.source_voucher_no || '—';
                const shipped = fmtQty(item.qty_shipped || 0);
                const soQty = fmtSoQty(item);
                const queueClass = isQueued(item) ? 'ps-badge--queued' : 'ps-badge--needs-scheduling';
                const tempBadge = isTempPs(item) ? '<span class="ps-temp-badge">[Temp]</span> ' : '';
                return `
                  <tr data-action="bulk-lookup-open" data-ps-id="${escapeHtml(psId)}" title="Click to open in queue">
                    <td>${tempBadge}<button type="button" class="ps-bulk-lookup-row-btn" data-action="bulk-lookup-open" data-ps-id="${escapeHtml(psId)}">${escapeHtml(displayId)}</button></td>
                    <td>${escapeHtml(partialLabel(item))}</td>
                    <td>${escapeHtml(part)}</td>
                    <td>${escapeHtml(item.part_desc || '—')}</td>
                    <td>${escapeHtml(qty)}</td>
                    <td class="${due !== '-' && isOverdue(item) ? 'is-overdue' : ''}">${escapeHtml(due)}</td>
                    <td>${escapeHtml(coway)}</td>
                    <td>${escapeHtml(bulkLookupStageLabel(item))}</td>
                    <td><span class="ps-badge ${queueClass}">${escapeHtml(bulkLookupQueueLabel(item))}</span></td>
                    <td>${escapeHtml(so)}</td>
                    <td>${escapeHtml(shipped)}${soQty !== '—' ? ` / ${escapeHtml(soQty)}` : ''}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function openBulkLookupModalLoading(terms) {
    if (typeof openModal !== 'function') return;
    openModal('Bulk lookup', `
      <div class="ps-bulk-lookup-summary">
        <span>Searching for <strong>${escapeHtml(terms.length)}</strong> term${terms.length === 1 ? '' : 's'}…</span>
      </div>
      <div class="ps-details-loading">Loading process sheets from cache…</div>
    `, 'xl');
  }

  function openBulkLookupModalResults(terms, items, missedTerms) {
    if (typeof openModal !== 'function') return;
    const missedHtml = missedTerms.length
      ? `<div class="ps-bulk-lookup-missed"><strong>No matches</strong>${escapeHtml(missedTerms.join(', '))}</div>`
      : '';
    openModal('Bulk lookup results', `
      <div class="ps-bulk-lookup-summary">
        <span><strong>${escapeHtml(items.length)}</strong> process sheet${items.length === 1 ? '' : 's'} found</span>
        <span>Searched: ${escapeHtml(terms.join(', '))}</span>
      </div>
      ${renderBulkLookupTable(items)}
      ${missedHtml}
    `, 'xl');
    bindBulkLookupModalActions();
  }

  function bindBulkLookupModalActions() {
    const shell = document.getElementById('trial-modal-shell');
    if (!shell) return;
    shell.querySelectorAll('[data-action="bulk-lookup-open"]').forEach(node => {
      node.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openBulkLookupItemInQueue(node.dataset.psId || '');
      });
    });
  }

  function openBulkLookupItemInQueue(psId) {
    const canonical = canonicalPlannerPsId(psId);
    if (!canonical) return;
    if (typeof closeModal === 'function') closeModal();
    setPsView('queue');
    if (els.tempFilter && canonical.startsWith('[Temp]')) els.tempFilter.value = 'temp_only';
    if (els.queueFilter) els.queueFilter.value = '';
    if (els.showCompleted) els.showCompleted.checked = true;
    if (els.search) els.search.value = canonical.split('::')[0];
    state.page = 1;
    const reload = shouldIncludeErpCompleted() !== state.erpIncludeCompleted;
    const afterRender = () => {
      window.setTimeout(() => {
        const row = [...document.querySelectorAll('.ps-row')].find(el => el.dataset.psId === canonical);
        row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        row?.querySelector('[data-action="toggle-details"]')?.click();
      }, 120);
    };
    if (reload) {
      loadProcessSheets().then(afterRender);
    } else {
      render();
      afterRender();
    }
  }

  async function runBulkLookup() {
    const raw = String(els.bulkLookupInput?.value || '').trim();
    const terms = parseSearchTerms(raw);
    if (!terms.length) {
      window.alert('Enter one or more values separated by commas (process sheet, part, PO, SO, etc.).');
      els.bulkLookupInput?.focus();
      return;
    }
    openBulkLookupModalLoading(terms);
    try {
      const searchParam = encodeURIComponent(terms.join(','));
      const apiRows = await getJson(
        `/api/pp-vouchers/with-ops?search=${searchParam}&show_completed=1`,
        { timeoutMs: 120000 },
      ).catch(() => []);
      const localMatches = state.items.filter(item => matchesSearchTerms(item, terms));
      const items = mergeBulkLookupItems(apiRows, localMatches);
      const missedTerms = unmatchedBulkLookupTerms(terms, items);
      openBulkLookupModalResults(terms, items, missedTerms);
    } catch (err) {
      if (typeof openModal === 'function') {
        openModal('Bulk lookup failed', `
          <div class="ps-details-error">${escapeHtml(err.message || 'Could not run bulk lookup.')}</div>
        `, 'lg');
      } else {
        window.alert(err.message || 'Could not run bulk lookup.');
      }
    }
  }

  function normalizePlannerItem(item) {
    const shippedComplete = boolValue(item.shipped_completed) || isShippedComplete(item);
    const temp = Boolean(item.is_temp_ps) || String(item.ps_id || '').startsWith('[Temp]');
    const displayId = temp
      ? tempPsDisplayId(item)
      : (item.display_ps_id || item.source_ps_id || item.ps_id || '');
    return {
      ...item,
      is_temp_ps: temp,
      ps_id: item.ps_id || item.display_ps_id || item.source_ps_id || '',
      display_ps_id: displayId,
      source_ps_id: item.source_ps_id || item.display_ps_id || item.ps_id || '',
      pp_partial_no: partialNo(item),
      planner_status: item.planner_status || 'UNPLANNED',
      shipped_completed: shippedComplete,
      is_completed: shippedComplete || boolValue(item.is_completed),
      source: 'planner',
    };
  }

  function erpExecutionStatus(item) {
    const current = String(item?.current_stage_status || '').trim();
    if (current) return displayExecutionStatus(current);
    return String(item?.execution_status || '').trim();
  }

  function normalizeErpItem(item) {
    const ops = Array.isArray(item.op_cards) ? item.op_cards : (Array.isArray(item.ops) ? item.ops : []);
    const shippedComplete = boolValue(item.shipped_completed) || isShippedComplete(item);
    const executionStatus = erpExecutionStatus(item);
    return {
      ps_id: item.ps_id || '',
      display_ps_id: item.display_ps_id || String(item.ps_id || '').split('::')[0],
      source_ps_id: item.source_ps_id || item.ps_id || '',
      pp_partial_no: partialNo(item),
      inventory_code: item.inventory_code || item.part_no || '',
      part_name: item.part_name || item.part_no || '',
      part_no: item.part_no || item.inventory_code || '',
      part_desc: item.part_desc || '',
      due_date: item.due_date || '',
      coway_proposed_edd: item.coway_proposed_edd || '',
      remarks: item.remarks || '',
      order_date: item.order_date || '',
      total_qty: item.total_qty || 0,
      partial_qty: numberValue(item.partial_qty),
      wo_req_qty: firstQuantity(item.wo_req_qty, item.partial_qty, 0),
      total_wo_qty: firstQuantity(item.total_wo_qty, item.total_qty, 0),
      wo_qty_required: numberValue(item.wo_qty_required),
      display_qty: firstQuantity(item.display_qty, item.partial_qty, item.total_qty, item.wo_qty_required, 0),
      planned_qty: item.planned_qty || 0,
      finished_qty: item.finished_qty || 0,
      remaining_qty: firstQuantity(item.remaining_qty, item.wo_qty_required, item.display_qty, item.partial_qty, item.total_qty),
      status: item.status || '',
      execution_status: executionStatus,
      execution_completed: boolValue(item.execution_completed),
      shipped_completed: boolValue(item.shipped_completed) || isShippedComplete(item),
      is_completed: boolValue(item.is_completed),
      planner_status: item.planner_status || 'UNPLANNED',
      selected_flow_code: item.selected_flow_code || item.selected_bom_code || item.bom_code || '',
      route_label: item.route_label || item.selected_flow_code || item.selected_bom_code || item.bom_code || 'No flow selected',
      material_status: item.material_status || { severity: 'none', label: '' },
      warnings: item.warnings || [],
      source_voucher_no: item.source_voucher_no || '',
      qty_shipped: item.qty_shipped || 0,
      so_det_qty: item.so_det_qty,
      current_stage_no: item.current_stage_no,
      current_stage_desc: item.current_stage_desc || '',
      current_stage_status: item.current_stage_status || '',
      ops,
      source: 'erp',
    };
  }

  function shouldIncludeErpCompleted() {
    return Boolean(els.showCompleted?.checked) || Boolean(els.completedOnly?.checked);
  }

  function erpVouchersUrl(refresh = false) {
    const includeCompleted = shouldIncludeErpCompleted();
    state.erpIncludeCompleted = includeCompleted;
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');
    if (includeCompleted) params.set('show_completed', '1');
    const qs = params.toString();
    return qs ? `/api/pp-vouchers/with-ops?${qs}` : '/api/pp-vouchers/with-ops';
  }

  function plannerProcessSheetsUrl() {
    const params = new URLSearchParams();
    if (shouldIncludeErpCompleted()) params.set('show_completed', '1');
    const qs = params.toString();
    return qs ? `/api/process-sheets/board?${qs}` : '/api/process-sheets/board';
  }

  function mergeBoardItems(board) {
    const plannerItems = Array.isArray(board?.planner)
      ? board.planner.map(normalizePlannerItem)
      : [];
    const plannerIds = new Set(plannerItems.map(itemIdentityKey));
    const erpItems = Array.isArray(board?.erp_only)
      ? board.erp_only.map(normalizeErpItem).filter(item => item.ps_id && !plannerIds.has(itemIdentityKey(item)))
      : [];
    return [...plannerItems, ...erpItems].sort((a, b) => {
      const due = String(a.due_date || '').localeCompare(String(b.due_date || ''));
      const source = String(a.source_ps_id || a.display_ps_id || a.ps_id || '')
        .localeCompare(String(b.source_ps_id || b.display_ps_id || b.ps_id || ''));
      const partial = Number(partialNo(a)) - Number(partialNo(b));
      return due || source || partial || String(a.ps_id || '').localeCompare(String(b.ps_id || ''));
    });
  }

  let searchRenderTimer = null;
  let loadStatusTimer = null;
  let loadStartedAt = 0;

  function boardRequestUrl(refresh = false) {
    const url = plannerProcessSheetsUrl();
    if (!refresh) return url;
    return `${url}${url.includes('?') ? '&' : '?'}refresh=1`;
  }

  function plannerOnlyRequestUrl(refresh = false) {
    const params = new URLSearchParams();
    if (shouldIncludeErpCompleted()) params.set('show_completed', '1');
    if (refresh) params.set('refresh', '1');
    const qs = params.toString();
    return qs ? `/api/process-sheets?${qs}` : '/api/process-sheets';
  }

  function updateLoadStatusMessage() {
    if (!state.loading || !els.queueHint) return;
    const seconds = Math.max(1, Math.round((Date.now() - loadStartedAt) / 1000));
    els.queueHint.textContent = `Loading process sheets… ${seconds}s`;
  }

  function startLoadStatusTimer() {
    loadStartedAt = Date.now();
    clearInterval(loadStatusTimer);
    updateLoadStatusMessage();
    loadStatusTimer = window.setInterval(updateLoadStatusMessage, 1000);
  }

  function stopLoadStatusTimer() {
    clearInterval(loadStatusTimer);
    loadStatusTimer = null;
  }

  async function fetchBoardPayload(refresh = false) {
    return getJson(boardRequestUrl(refresh), { timeoutMs: 90000 });
  }

  async function fetchPlannerOnlyPayload(refresh = false) {
    const rows = await getJson(plannerOnlyRequestUrl(refresh), { timeoutMs: 60000 });
    return {
      planner: Array.isArray(rows) ? rows : [],
      erp_only: [],
    };
  }

  async function loadProcessSheets({ refresh = false } = {}) {
    state.loading = true;
    setBusy(true, refresh);
    startLoadStatusTimer();
    render();
    try {
      let board;
      try {
        board = await fetchBoardPayload(refresh);
      } catch (boardErr) {
        console.warn('process sheet board load failed, falling back to planner list:', boardErr);
        board = await fetchPlannerOnlyPayload(refresh);
      }
      state.items = mergeBoardItems(board);
      state.lastRefreshedAt = refresh ? Date.now() : state.lastRefreshedAt;
      state.loading = false;
      render();
    } catch (err) {
      console.error('process sheet load failed:', err);
      state.items = [];
      state.loading = false;
      renderError(err.message || 'Could not load process sheets.');
    } finally {
      state.loading = false;
      stopLoadStatusTimer();
      setBusy(false);
      loadTempTracker();
    }
  }

  function describeActiveFilters() {
    const parts = [];
    const typeInputs = els.typePanel
      ? [...els.typePanel.querySelectorAll('input[type=checkbox]')]
      : [];
    const checkedTypes = typeInputs.filter(cb => cb.checked).map(cb => cb.value);
    if (typeInputs.length && checkedTypes.length < typeInputs.length) {
      parts.push(checkedTypes.length === 0
        ? 'no process sheet types selected'
        : `types: ${checkedTypes.join(', ')} only`);
    }
    if (els.hideSrTags?.checked) parts.push('hiding [SR]');
    if (els.completedOnly?.checked) parts.push('completed only');
    else if (!els.showCompleted?.checked) parts.push('hiding completed');
    if (els.overdueOnly?.checked) parts.push('overdue only');
    if (String(els.search?.value || '').trim()) parts.push('search active');
    const queueFilter = String(els.queueFilter?.value || '').trim().toLowerCase();
    if (queueFilter === 'queued') parts.push('queued on planner');
    if (queueFilter === 'unqueued') parts.push('needs scheduling');
    const tempFilter = String(els.tempFilter?.value || 'all').trim().toLowerCase();
    if (tempFilter === 'temp_only') parts.push('[Temp] only');
    if (tempFilter === 'hide_temp') parts.push('hiding [Temp]');
    const sortMode = currentSortMode();
    if (sortMode === 'due_asc') parts.push('sorted by PO due (soonest)');
    if (sortMode === 'due_desc') parts.push('sorted by PO due (latest)');
    return parts;
  }

  function resetFilters() {
    const defaults = new Set(['APS', 'NPS', 'SR', 'TEMP']);
    els.typePanel?.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = defaults.has(cb.value); });
    if (els.typeBtn) els.typeBtn.textContent = 'APS, NPS, [SR], [Temp] ▾';
    if (els.search) els.search.value = '';
    if (els.tempFilter) els.tempFilter.value = 'all';
    if (els.queueFilter) els.queueFilter.value = '';
    if (els.sortBy) els.sortBy.value = 'planning';
    if (els.overdueOnly) els.overdueOnly.checked = false;
    if (els.hideSrTags) els.hideSrTags.checked = true;
    if (els.completedOnly) els.completedOnly.checked = false;
    if (els.showCompleted) els.showCompleted.checked = false;
    state.page = 1;
    loadProcessSheets();
  }

  function filteredItems() {
    const searchTerms = parseSearchTerms(els.search?.value);
    const queueFilter = String(els.queueFilter?.value || '').trim().toLowerCase();
    const overdueOnly = Boolean(els.overdueOnly?.checked);
    const showCompleted = Boolean(els.showCompleted?.checked);
    const completedOnly = Boolean(els.completedOnly?.checked);
    const hideSrTags = Boolean(els.hideSrTags?.checked);
    const allTypeInputs = els.typePanel ? els.typePanel.querySelectorAll('input[type=checkbox]') : [];
    const checkedTypes = els.typePanel
      ? new Set([...els.typePanel.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value))
      : new Set(['APS', 'NPS', 'SR', 'TEMP']);
    const allTypesOn = checkedTypes.size === allTypeInputs.length;
    const tempFilter = String(els.tempFilter?.value || 'all').trim().toLowerCase();

    return state.items.filter(item => {
      if (tempFilter === 'temp_only' && !isTempPs(item)) return false;
      if (tempFilter === 'hide_temp' && isTempPs(item)) return false;
      if (hideSrTags && !completedOnly && !searchTerms.length && isSrTagged(item)) return false;
      if (!allTypesOn) {
        const t = getPsType(item);
        if (t && !checkedTypes.has(t)) return false;
      }
      if (!matchesSearchTerms(item, searchTerms)) return false;
      if (queueFilter === 'queued' && !isQueued(item)) return false;
      if (queueFilter === 'unqueued' && isQueued(item)) return false;
      if (overdueOnly && !isOverdue(item)) return false;
      if (completedOnly && !isCompleted(item)) return false;
      if (!completedOnly && !showCompleted && isCompleted(item)) return false;
      return true;
    });
  }

  function render() {
    const items = filteredItems();
    renderCounts();
    renderQueue(items);
    updateTempTabCount();
  }

  function renderCounts() {
    let queued = 0;
    let needs = 0;
    state.items.forEach(item => {
      if (isCompleted(item)) return;
      if (isQueued(item)) queued += 1;
      else needs += 1;
    });
    setText('ps-count-queued', queued);
    setText('ps-count-needs', needs);
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value);
  }

  function renderQueue(items) {
    if (!els.queue) return;
    if (!items.length) {
      if (state.loading && !state.items.length) {
        els.queue.innerHTML = [
          '<div class="queue-empty">',
          '<p><strong>Loading process sheets…</strong></p>',
          '<p class="queue-empty-meta">If this takes more than a minute, ERP sync may be holding the database lock — wait for sync to finish, then click retry.</p>',
          '<button class="btn btn-light btn-sm" type="button" data-action="retry-load">Retry load</button>',
          '</div>',
        ].join('');
      } else if (state.items.length > 0) {
        els.queue.innerHTML = [
          '<div class="queue-empty">',
          '<p><strong>No results.</strong></p>',
          '<button class="btn btn-light btn-sm queue-empty-reset" type="button" data-action="reset-filters">Reset filters</button>',
          '</div>',
        ].join('');
      } else {
        els.queue.innerHTML = [
          '<div class="queue-empty">',
          '<p><strong>No results.</strong></p>',
          '<p class="queue-empty-meta">Run <strong>Sync ERP</strong>, then refresh.</p>',
          '</div>',
        ].join('');
      }
      if (els.queueHint) {
        els.queueHint.textContent = state.items.length > 0
          ? `${state.items.length} loaded · 0 matched`
          : '0 loaded';
      }
      return;
    }

    const sortedItems = sortQueueItems(items);
    const totalPages = Math.max(1, Math.ceil(sortedItems.length / PAGE_SIZE));
    state.page = Math.min(Math.max(state.page, 1), totalPages);

    const start = (state.page - 1) * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, sortedItems.length);
    const pageItems = sortedItems.slice(start, end);

    if (els.queueHint) {
      const erpOnly = items.filter(item => item.source === 'erp').length;
      const sortNote = currentSortMode() === 'planning' ? '' : ' | sorted';
      const refreshed = state.lastRefreshedAt
        ? ` | refreshed ${new Date(state.lastRefreshedAt).toLocaleTimeString()}`
        : '';
      const loadingNote = state.loading ? ' | refreshing from cache…' : '';
      els.queueHint.textContent = `${start + 1}-${end} shown from ${sortedItems.length} matched | ${state.items.length} loaded${erpOnly ? ` (${erpOnly} ERP-only)` : ''}${sortNote}${refreshed}${loadingNote}`;
    }

    const sortMode = currentSortMode();
    const sortByDue = sortMode === 'due_asc' || sortMode === 'due_desc';
    let queueHtml;
    if (sortByDue) {
      queueHtml = [
        renderQueueGroup('By PO due date', pageItems),
        renderPagination(sortedItems.length, start, end, totalPages),
      ].filter(Boolean).join('');
    } else {
      const openItems = pageItems.filter(item => !isCompleted(item));
      const completedItems = pageItems.filter(item => isCompleted(item));
      queueHtml = [
        renderQueueGroup('Open Partials', openItems),
        renderQueueGroup('Completed', completedItems),
        renderPagination(sortedItems.length, start, end, totalPages),
      ].filter(Boolean).join('');
    }
    els.queue.innerHTML = queueHtml;
  }

  function renderPagination(totalItems, start, end, totalPages) {
    if (totalItems <= PAGE_SIZE) return '';
    const prevDisabled = state.page <= 1 ? 'disabled' : '';
    const nextDisabled = state.page >= totalPages ? 'disabled' : '';
    return `
      <nav class="ps-pagination" aria-label="Process sheet pages">
        <span>Rows ${escapeHtml(start + 1)}-${escapeHtml(end)} of ${escapeHtml(totalItems)}</span>
        <div class="ps-pagination-actions">
          <button class="btn btn-light btn-sm" type="button" data-action="page-prev" ${prevDisabled}>Previous</button>
          <strong>Page ${escapeHtml(state.page)} of ${escapeHtml(totalPages)}</strong>
          <button class="btn btn-light btn-sm" type="button" data-action="page-next" ${nextDisabled}>Next</button>
        </div>
      </nav>
    `;
  }

  function renderQueueGroup(title, items) {
    if (!items.length) return '';
    return `
      <section class="ps-queue-group">
        <div class="ps-queue-group-title">
          <span>${escapeHtml(title)}</span>
          <strong>${escapeHtml(items.length)}</strong>
        </div>
        <div class="ps-queue-group-list">
          ${items.map(renderQueueItem).join('')}
        </div>
      </section>
    `;
  }

  function renderQueueItem(item) {
    const psId = canonicalPlannerPsId(item);
    const warnings = Array.isArray(item.warnings) ? item.warnings : [];
    const ops = Array.isArray(item.ops) ? item.ops : [];
    const dueClass = isOverdue(item) ? 'is-overdue' : '';
    const partial = `<span class="ps-partial-badge">${escapeHtml(partialLabel(item))}</span>`;
    const tempBadge = isTempPs(item) ? '<span class="ps-temp-badge">[Temp]</span>' : '';
    const srBadge = isSrTagged(item) && !isTempPs(item) ? '<span class="ps-sr-badge">[SR]</span>' : '';
    const qty = fmtQty(firstQuantity(item.display_qty, item.partial_qty, item.wo_req_qty, item.total_qty, 0));
    const qtyBadge = renderQtyBadge(qty);
    const warningsPill = renderWarningsPill(warnings);
    const titleBadges = [tempBadge, partial, qtyBadge, srBadge, warningsPill].filter(Boolean).join('\n              ');
    const currentStageStrip = renderCurrentStageStrip(item);
    const opStatusStrip = renderOpStatusStrip(ops, item);
    const descriptor = item.part_desc || 'No description';
    const queueClass = isQueued(item) ? 'is-queued' : 'is-needs';

    return `
      <article class="ps-row ${dueClass} ${queueClass}" data-ps-id="${escapeHtml(psId)}">
        <div class="ps-row-col">
          <button class="ps-row-main" type="button" data-action="toggle-details" data-ps-id="${escapeHtml(psId)}">
            <div class="ps-row-title">
              <div class="ps-row-title-left">
                <span class="ps-id">${escapeHtml(tempPsDisplayId(item) || item.display_ps_id || psId)}</span>
                ${titleBadges}
              </div>
              ${renderSchedulingInline(item, ops)}
            </div>
            <div class="ps-row-part">
              <strong>${escapeHtml(item.part_no || item.part_name || item.inventory_code || 'No part')}</strong>
              <span>${escapeHtml(descriptor)}</span>
            </div>
            ${currentStageStrip}
            ${opStatusStrip}
          </button>
          ${renderDateStrip(item, psId)}
          <div class="ps-row-highlights">
            ${renderRemarksInput(item, psId)}
            ${isTempPs(item) ? `
              <button type="button" class="btn btn-light btn-sm ps-temp-delete-btn"
                data-action="delete-temp-ps" data-ps-id="${escapeHtml(psId)}">
                Delete temp PS
              </button>` : ''}
          </div>
        </div>
        <div class="ps-details" id="ps-details-${escapeHtml(cssSafeId(psId))}" hidden></div>
      </article>
    `;
  }

  function renderOpStatusStrip(ops, item) {
    const visibleOps = (Array.isArray(ops) ? ops : [])
      .filter(op => op && normalizeStatus(opExecutionStatus(op)));
    if (!visibleOps.length) return '';

    const maxVisible = 6;
    const chips = visibleOps.slice(0, maxVisible).map(op => {
      const opNo = op.op_no || op.source_op_no || op.stage_no || op.operation_label || '-';
      const opName = op.op_type || op.operation_name || op.stage_desc || '';
      const status = opExecutionStatus(op);
      const label = displayExecutionStatus(status);
      return `
        <span class="ps-op-status ${opStatusClass(status)}" title="${escapeHtml(opName)}">
          <strong>${escapeHtml(opNo)}</strong>
          <span>${escapeHtml(label)}</span>
        </span>
      `;
    }).join('');
    const overflow = visibleOps.length > maxVisible
      ? `<span class="ps-op-status is-overflow">+${escapeHtml(visibleOps.length - maxVisible)} more</span>`
      : '';
    return `<div class="ps-op-status-strip">${chips}${overflow}</div>`;
  }

  function cssSafeId(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  async function toggleDetails(psId) {
    const item = state.items.find(row => String(row.ps_id || '') === String(psId));
    const detailsEl = $(`ps-details-${cssSafeId(psId)}`);
    if (!item || !detailsEl) return;

    if (!detailsEl.hidden) {
      detailsEl.hidden = true;
      return;
    }

    detailsEl.hidden = false;
    if (state.details.has(psId)) {
      const cached = state.details.get(psId);
      applyCowayEddToRow(psId, cached?.summary?.coway_proposed_edd || item.coway_proposed_edd);
      applyRemarksToRow(psId, cached?.summary?.remarks || item.remarks);
      detailsEl.innerHTML = renderDetails(cached, item);
      return;
    }

    detailsEl.innerHTML = '<div class="ps-details-loading">Loading details...</div>';
    try {
      const details = await getJson(`/api/process-sheets/${encodeURIComponent(psId)}/details`);
      state.details.set(psId, details);
      applyCowayEddToRow(psId, details.summary?.coway_proposed_edd || item.coway_proposed_edd);
      applyRemarksToRow(psId, details.summary?.remarks || item.remarks);
      detailsEl.innerHTML = renderDetails(details, item);
    } catch (err) {
      if (item.source === 'erp') {
        const workQty = woReqQty(item);
        const fallbackOps = enrichCatalogOpsForPartial(item, workQty);
        const details = {
          summary: { ...item, ops: fallbackOps },
          planned_blocks: [],
          cards: [],
          requirements: [],
          erp_only: true,
        };
        state.details.set(psId, details);
        applyCowayEddToRow(psId, details.summary?.coway_proposed_edd || item.coway_proposed_edd);
        applyRemarksToRow(psId, details.summary?.remarks || item.remarks);
        detailsEl.innerHTML = renderDetails(details, item);
        return;
      }
      detailsEl.innerHTML = `<div class="ps-details-error">Could not load details: ${escapeHtml(err.message)}</div>`;
    }
  }

  function enrichCatalogOpsForPartial(item, workQty) {
    const qty = Number(workQty || 0);
    return collectDetailOps(null, item).map(op => normalizeOpQuantities(op, qty));
  }

  function normalizeOpQuantities(op, workQty = 0) {
    const planned = Number(op?.planned_qty || 0);
    const finished = Number(op?.finished_qty || op?.erp_finished_qty || op?.wo_qty_produced || 0);
    const woReq = firstQuantity(op?.wo_qty_required, op?.required_qty, workQty, 0);
    const readyQty = firstQuantity(op?.ready_qty, woReq, 0);
    const woRemaining = Math.max(0, woReq - finished);
    const schedulableRemaining = Math.max(
      0,
      Number(firstQuantity(op?.schedulable_remaining_qty, readyQty - planned - finished, readyQty, 0))
    );
    return {
      ...op,
      wo_qty_required: woReq,
      required_qty: woReq,
      ready_qty: readyQty,
      remaining_qty: woRemaining,
      schedulable_remaining_qty: schedulableRemaining,
    };
  }

  function detailOpMergeKey(op) {
    const opNo = String(op?.op_no || op?.source_op_no || op?.operation_label || '').trim();
    if (opNo) return `op:${opNo}`;
    const seq = Number(op?.op_seq_id || op?.source_op_seq_id || 0);
    if (seq > 0) return `seq:${seq}`;
    const stage = Number(op?.stage_no || op?.source_stage_no || 0);
    const label = String(op?.op_type || op?.operation_name || op?.stage_desc || '').trim();
    return `fallback:${stage}|${label}`;
  }

  function mergeDetailOpFields(base, extra) {
    const merged = { ...base, ...extra };
    const status = [extra, base].map(opExecutionStatus).find(value => normalizeStatus(value)) || '';
    merged.execution_status = status;
    merged.erp_execution_status = compactText(
      extra?.erp_execution_status || base?.erp_execution_status || status,
    );
    ['planned_qty', 'finished_qty', 'wo_qty_produced', 'erp_finished_qty', 'reject_qty', 'wo_qty_rejected', 'erp_reject_qty', 'wo_qty_required', 'required_qty'].forEach((field) => {
      merged[field] = Math.max(Number(base?.[field] || 0), Number(extra?.[field] || 0));
    });
    merged.machine_code = compactText(base?.machine_code || extra?.machine_code || '');
    merged.preferred_machine = compactText(base?.preferred_machine || extra?.preferred_machine || '');
    merged.compatible_machine_group = compactText(
      base?.compatible_machine_group || extra?.compatible_machine_group || '',
    );
    const queued = [
      ...(Array.isArray(base?.queued_machines) ? base.queued_machines : []),
      ...(Array.isArray(extra?.queued_machines) ? extra.queued_machines : []),
    ].filter(Boolean);
    merged.queued_machines = [...new Set(queued)];
    if (!merged.machine_code && merged.queued_machines.length) {
      merged.machine_code = merged.queued_machines[0];
    }
    merged.stage_no = Number(
      base?.stage_no || base?.source_stage_no || extra?.stage_no || extra?.source_stage_no || 0,
    ) || 0;
    merged.op_type = compactText(base?.op_type || extra?.op_type || base?.operation_name || extra?.operation_name || base?.stage_desc || extra?.stage_desc || '');
    merged.operation_name = compactText(base?.operation_name || extra?.operation_name || merged.op_type);
    return merged;
  }

  function sortDetailOps(ops) {
    return [...ops].sort((a, b) => {
      const stageA = Number(a.stage_no || a.source_stage_no || 0);
      const stageB = Number(b.stage_no || b.source_stage_no || 0);
      if (stageA !== stageB) return stageA - stageB;
      const seqA = Number(a.seq_no || a.op_seq_id || a.source_op_seq_id || 0);
      const seqB = Number(b.seq_no || b.op_seq_id || b.source_op_seq_id || 0);
      if (seqA !== seqB) return seqA - seqB;
      const opA = Number(a.op_no || a.source_op_no || 0);
      const opB = Number(b.op_no || b.source_op_no || 0);
      if (Number.isFinite(opA) && Number.isFinite(opB) && opA !== opB) return opA - opB;
      return String(a.op_no || a.source_op_no || '').localeCompare(String(b.op_no || b.source_op_no || ''));
    });
  }

  function collectDetailOps(summary, item) {
    const byKey = new Map();
    for (const op of [
      ...(Array.isArray(summary?.ops) ? summary.ops : []),
      ...(Array.isArray(item?.ops) ? item.ops : []),
      ...(Array.isArray(item?.op_cards) ? item.op_cards : []),
      ...(Array.isArray(item?.all_ops) ? item.all_ops : []),
    ]) {
      if (!op) continue;
      const key = detailOpMergeKey(op);
      const existing = byKey.get(key);
      byKey.set(key, existing ? mergeDetailOpFields(existing, op) : { ...op });
    }
    return sortDetailOps([...byKey.values()]);
  }

  function renderDetails(details, item) {
    const summary = details.summary || item;
    const ops = collectDetailOps(summary, item);
    const plannedBlocks = Array.isArray(details.planned_blocks) ? details.planned_blocks : [];
    const requirements = Array.isArray(details.requirements) ? details.requirements : [];
    const machines = queuedMachines(summary).length ? queuedMachines(summary) : queuedMachines(item);
    const route = summary.route_label || summary.erp_bom_code || summary.selected_flow_code || summary.selected_bom_code
      || item.route_label || item.erp_bom_code || item.selected_flow_code || item.selected_bom_code || 'No flow selected';
    return `
      ${machines.length ? `
      <div class="ps-details-queue">
        <span class="ps-badge ps-badge--queued">Queued</span>
        ${renderMachinePills(summary.queued_machine_details?.length ? summary : item)}
      </div>` : ''}
      <div class="ps-detail-route">
        <span class="ps-detail-label">BOM / Route</span>
        <strong>${escapeHtml(route)}</strong>
      </div>
      ${renderDetailsMeta(summary, item, ops)}
      ${details.erp_only ? '<div class="ps-details-note">Planner row was created from ERP on open. Schedule ops from this partial to add planned blocks.</div>' : ''}
      ${renderOps(ops, summary, plannedBlocks)}
      ${renderBlocks(plannedBlocks, ops)}
      ${renderRequirements(requirements)}
    `;
  }

  function renderManualProducedCell(op, psId) {
    if (!op?.needs_manual_produced) {
      return escapeHtml(fmtQty(op?.finished_qty));
    }
    const opSeqId = Number(op?.op_seq_id || op?.source_op_seq_id || 0);
    const value = Number(op?.manual_produced_qty ?? op?.finished_qty ?? 0);
    return `
      <input type="number" class="ps-manual-produced-input" min="0" step="1"
        data-action="manual-produced"
        data-ps-id="${escapeHtml(canonicalPlannerPsId(psId))}"
        data-op-seq-id="${opSeqId}"
        value="${Number.isFinite(value) ? value : 0}"
        title="Planner produced qty (ERP does not track this BOM step)">
    `;
  }

  async function saveManualProducedQty(psId, opSeqId, qty, inputEl) {
    const canonical = canonicalPlannerPsId(psId);
    const opSeq = Number(opSeqId || 0);
    if (!canonical || opSeq <= 0) return;
    try {
      if (inputEl) inputEl.disabled = true;
      const data = await patchJson(
        `/api/process-sheets/${encodeURIComponent(canonical)}/bom-step-qty`,
        { op_seq_id: opSeq, qty_produced: Math.max(0, Number(qty) || 0) },
      );
      const item = findQueueItem(canonical);
      if (item && data?.summary) {
        item.finished_qty = data.summary.finished_qty;
        item.remaining_qty = data.summary.remaining_qty;
        item.planned_qty = data.summary.planned_qty;
      }
      state.details.delete(canonical);
      const detailsEl = $(`ps-details-${cssSafeId(canonical)}`);
      if (item && detailsEl && !detailsEl.hidden) {
        const details = await getJson(`/api/process-sheets/${encodeURIComponent(canonical)}/details`);
        state.details.set(canonical, details);
        if (details.summary) {
          ['finished_qty', 'remaining_qty', 'planned_qty', 'ops'].forEach(key => {
            if (details.summary[key] != null) item[key] = details.summary[key];
          });
        }
        detailsEl.innerHTML = renderDetails(details, item);
      }
      render();
    } catch (err) {
      window.alert(err.message || 'Failed to save produced qty');
    } finally {
      if (inputEl) inputEl.disabled = false;
    }
  }

  function renderOps(ops, summary, plannedBlocks) {
    const blocks = Array.isArray(plannedBlocks) ? plannedBlocks : [];
    const workQty = woReqQty(summary);
    const psId = canonicalPlannerPsId(summary);
    const displayOps = (Array.isArray(ops) ? ops : []).map(op => normalizeOpQuantities(op, workQty));
    if (!displayOps.length) {
      const hint = blocks.length
        ? '<p class="ps-details-empty-hint">No operation steps in BOM flow or ERP cache. Scheduled blocks are listed below.</p>'
        : '';
      return `
        <div class="ps-detail-section">
          <div class="ps-detail-label">Operation Steps</div>
          <div class="ps-details-empty">No operations found for this process sheet.</div>
          ${hint}
        </div>
      `;
    }
    return `
      <div class="ps-detail-section">
        <div class="ps-detail-label">Operation Steps</div>
        <div class="ps-table-wrap">
        <table class="ps-table">
          <thead>
            <tr>
              <th>Op</th>
              <th>Type</th>
              <th>Machine</th>
              <th>ERP Stage</th>
              <th title="ERP work-order quantity">WO Req</th>
              <th>Planned</th>
              <th>Finished / Produced</th>
              <th>Rejected</th>
              <th title="WO Req minus finished">Remaining</th>
            </tr>
          </thead>
          <tbody>
            ${displayOps.map(op => `
              <tr>
                <td>${escapeHtml(op.op_no || op.source_op_no || op.operation_label || '-')}</td>
                <td>${escapeHtml(op.op_type || op.operation_name || op.stage_desc || '-')}</td>
                <td>${escapeHtml(
                  op.machine_code
                  || (Array.isArray(op.queued_machines) && op.queued_machines.length ? op.queued_machines.join(', ') : '')
                  || op.preferred_machine
                  || op.compatible_machine_group
                  || '-'
                )}</td>
                <td>${renderOpStatusCell(op)}</td>
                <td>${escapeHtml(fmtQty(op.wo_qty_required))}</td>
                <td>${escapeHtml(fmtQty(op.planned_qty))}</td>
                <td>${renderManualProducedCell(op, psId)}</td>
                <td>${escapeHtml(fmtQty(op.reject_qty))}</td>
                <td>${escapeHtml(fmtQty(op.remaining_qty))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        </div>
      </div>
    `;
  }

  function renderBlocks(blocks, ops) {
    if (!blocks.length) return '';
    return `
      <div class="ps-detail-section">
        <div class="ps-detail-label">Planned Blocks</div>
        <div class="ps-block-chip-list">
          ${blocks.map(block => {
            const machine = block.machine_code || block.machine_no || 'Machine TBD';
            const opLabel = blockOpLabel(block, ops);
            const qty = fmtQty(block.scheduled_qty);
            const { startFmt, endFmt } = blockPlannedTimes(block);
            const title = [machine, opLabel, `Qty ${qty}`, blockPlannedRange(block)].filter(Boolean).join(' · ');
            return `
              <span class="ps-block-chip" title="${escapeHtml(title)}">
                <span class="ps-block-chip-head">
                  <strong>${escapeHtml(machine)}</strong>
                  <span>${escapeHtml(opLabel)}</span>
                  <span class="ps-block-chip-qty">Qty ${escapeHtml(qty)}</span>
                </span>
                ${(startFmt || endFmt) ? `
                <span class="ps-block-chip-schedule">
                  ${startFmt ? `<span class="ps-block-chip-time"><small>Start</small><strong>${escapeHtml(startFmt)}</strong></span>` : ''}
                  ${endFmt ? `<span class="ps-block-chip-time"><small>End</small><strong>${escapeHtml(endFmt)}</strong></span>` : ''}
                </span>` : ''}
              </span>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function renderRequirements(requirements) {
    if (!requirements.length) return '';
    return `
      <div class="ps-detail-section">
        <div class="ps-detail-label">Material Requirements</div>
        <div class="ps-chip-list">
          ${requirements.map(req => `
            <span class="ps-chip">
              ${escapeHtml(req.material_code || req.inventory_code || 'Material')}
              · ${escapeHtml(req.status || req.requirement_status || 'Pending')}
            </span>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderError(message) {
    if (els.queue) {
      els.queue.innerHTML = [
        '<div class="queue-empty">',
        `<p><strong>Failed to load process sheets.</strong></p>`,
        `<p class="queue-empty-meta">${escapeHtml(message)}</p>`,
        '<button class="btn btn-light btn-sm" type="button" data-action="retry-load">Retry load</button>',
        '</div>',
      ].join('');
    }
    if (els.queueHint) els.queueHint.textContent = 'Load failed';
  }

  function setBusy(busy, refreshing = false) {
    if (!els.refreshBtn) return;
    els.refreshBtn.disabled = busy;
    if (busy && refreshing) {
      els.refreshBtn.textContent = 'Refreshing…';
    } else if (!busy) {
      els.refreshBtn.textContent = 'Refresh From Cache';
    }
  }

  function scheduleSearchRender() {
    clearTimeout(searchRenderTimer);
    searchRenderTimer = setTimeout(() => {
      state.page = 1;
      render();
    }, 150);
  }

  function resolveInitialPsView() {
    if (window.location.pathname === '/temp-process-sheets' || window.location.hash === '#temp') {
      return 'temp';
    }
    return 'queue';
  }

  function updateTempTabCount() {
    const pill = $('ps-temp-tab-count');
    if (!pill) return;
    const fromQueue = state.items.filter(isTempPs).length;
    const count = Math.max(fromQueue, tempState.items.length);
    if (count <= 0) {
      pill.hidden = true;
      return;
    }
    pill.hidden = false;
    pill.textContent = String(count);
  }

  function setPsView(view) {
    const isTemp = view === 'temp';
    const queuePanel = $('ps-view-queue');
    const tempPanel = $('ps-view-temp');
    if (queuePanel) {
      queuePanel.hidden = isTemp;
      queuePanel.classList.toggle('is-ps-view-hidden', isTemp);
    }
    if (tempPanel) {
      tempPanel.hidden = !isTemp;
      tempPanel.classList.toggle('is-ps-view-hidden', !isTemp);
    }
    document.querySelectorAll('.ps-view-tab').forEach(tab => {
      tab.classList.toggle('is-active', tab.dataset.psView === view);
    });
    const path = isTemp ? '/process-sheets#temp' : '/process-sheets';
    if (`${window.location.pathname}${window.location.hash}` !== path && window.location.pathname !== '/temp-process-sheets') {
      history.replaceState(null, '', path);
    }
    if (isTemp) loadTempTracker();
  }

  function filteredTempItems() {
    const needle = String(els.tempSearch?.value || '').trim().toLowerCase();
    const queueFilter = String(els.tempQueueFilter?.value || '').trim().toLowerCase();
    return tempState.items.filter(item => {
      if (queueFilter === 'queued' && !item.is_queued) return false;
      if (queueFilter === 'unqueued' && item.is_queued) return false;
      if (!needle) return true;
      const hay = [
        item.display_ps_id,
        item.planner_ps_id,
        item.source_ps_id,
        item.source_label,
        item.part_no,
        item.part_desc,
        item.selected_bom_code,
        item.remarks,
      ].join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }

  function renderTempTracker() {
    const root = $('ps-temp-tracker');
    const hint = $('ps-temp-tracker-hint');
    if (!root) return;
    if (tempState.loading && !tempState.items.length) {
      root.innerHTML = '<div class="queue-empty">Loading temp process sheets…</div>';
      if (hint) hint.textContent = 'Loading…';
      return;
    }
    const items = filteredTempItems();
    updateTempTabCount();
    if (hint) {
      hint.textContent = tempState.items.length
        ? `${items.length} shown · ${tempState.items.length} saved in database`
        : 'No temp process sheets yet — create one to track reject/rework qty';
    }
    if (!items.length) {
      root.innerHTML = [
        '<div class="queue-empty">',
        '<p><strong>No temp process sheets match.</strong></p>',
        tempState.items.length
          ? '<p class="queue-empty-meta">Try clearing the search or queue filter.</p>'
          : '<p class="queue-empty-meta">Click <strong>Create temp PS</strong> to add a reject/rework copy from an ERP process sheet.</p>',
        '</div>',
      ].join('');
      return;
    }
    root.innerHTML = `
      <div class="ps-temp-tracker-table-wrap">
        <table class="ps-temp-tracker-table">
          <thead>
            <tr>
              <th>Temp PS</th>
              <th>Source PS</th>
              <th>Reject qty</th>
              <th>Progress</th>
              <th>Part</th>
              <th>Route</th>
              <th>Planner</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(renderTempTrackerRow).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderTempTrackerRow(item) {
    const psId = item.planner_ps_id || '';
    const queueClass = item.is_resolved ? 'is-resolved' : (item.is_queued ? 'is-queued' : 'is-needs');
    const queueLabel = item.is_resolved
      ? 'Resolved'
      : item.is_queued
        ? `On planner${item.queued_machines?.length ? `: ${item.queued_machines.join(', ')}` : ''}`
        : 'Needs scheduling';
    const created = item.created_at
      ? new Date(item.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
      : '—';
    const rejectQty = numberValue(item.reject_qty);
    const finishedQty = numberValue(item.finished_qty);
    const progressLabel = `${fmtQty(finishedQty)} / ${fmtQty(rejectQty)}`;
    const canResolve = !item.is_resolved;
    return `
      <tr class="ps-temp-tracker-row ${queueClass}">
        <td class="ps-temp-tracker-id-cell">
          <span class="ps-temp-badge">[Temp]</span>
          <button type="button" class="ps-temp-tracker-link" data-action="open-temp-detail" data-ps-id="${escapeHtml(psId)}">
            ${escapeHtml(tempTrackerLinkLabel(item))}
          </button>
        </td>
        <td>${escapeHtml(item.source_label || item.source_ps_id || '—')}</td>
        <td><strong>${escapeHtml(fmtQty(item.reject_qty))}</strong></td>
        <td>
          <strong>${escapeHtml(progressLabel)}</strong>
          ${item.is_resolved ? '<div class="ps-temp-tracker-sub">Complete</div>' : ''}
        </td>
        <td>
          <strong>${escapeHtml(item.part_no || '—')}</strong>
          <div class="ps-temp-tracker-sub">${escapeHtml(item.part_desc || '')}</div>
        </td>
        <td>${escapeHtml(item.selected_bom_code || item.erp_bom_code || '—')}</td>
        <td class="ps-temp-planner-cell">
          <span class="ps-planning-flag ${queueClass}" aria-hidden="true"></span>
          <span class="ps-temp-planner-label">${escapeHtml(queueLabel)}</span>
        </td>
        <td>${escapeHtml(created)}</td>
        <td class="ps-temp-tracker-actions">
          ${canResolve ? `
          <button type="button" class="btn btn-dark btn-sm"
            data-action="resolve-temp-ps" data-ps-id="${escapeHtml(psId)}"
            title="Record output qty and remove from planner queue when complete">
            Resolve
          </button>` : ''}
          <button type="button" class="btn btn-light btn-sm ps-temp-delete-btn"
            data-action="delete-temp-ps" data-ps-id="${escapeHtml(psId)}"
            title="Delete this temp process sheet">
            Delete
          </button>
        </td>
      </tr>
    `;
  }

  function openTempPsResolveModal(item) {
    const psId = item?.planner_ps_id || '';
    if (!psId || typeof openTrialForm !== 'function') return;
    const label = tempPsDisplayId(item) || psId;
    const rejectQty = numberValue(item.reject_qty);
    const finishedQty = numberValue(item.finished_qty);
    const remainingQty = Math.max(0, rejectQty - finishedQty);
    const defaultQty = remainingQty > 0 ? remainingQty : rejectQty;
    const queueNote = item.is_queued
      ? ' Queued jobs will pop off the planner when output meets the scheduled qty (same as saving actuals).'
      : '';
    openTrialForm('Resolve temp PS', `
      <div style="display:grid;gap:12px">
        <div>
          <div style="font-size:18px;font-weight:900;letter-spacing:-0.03em">${escapeHtml(label)}</div>
          <div style="font-size:12px;color:var(--text3,#6b7280);margin-top:4px">
            Record how many pcs of this reject/rework were completed.${escapeHtml(queueNote)}
          </div>
        </div>
        <div class="trial-actual-summary">
          <div><span class="field-hint">Reject qty</span><strong>${escapeHtml(fmtQty(rejectQty))}</strong></div>
          <div><span class="field-hint">Finished</span><strong>${escapeHtml(fmtQty(finishedQty))}</strong></div>
          <div><span class="field-hint">Remaining</span><strong>${escapeHtml(fmtQty(remainingQty))}</strong></div>
        </div>
        <label class="trial-modal-field">
          <span>Output qty</span>
          <input id="temp-ps-resolve-output" class="trial-modal-input" type="number" min="0" step="1"
            value="${Number.isFinite(defaultQty) ? defaultQty : 0}">
        </label>
        <label class="trial-modal-field">
          <span>Reject qty <span class="field-hint">(optional)</span></span>
          <input id="temp-ps-resolve-reject" class="trial-modal-input" type="number" min="0" step="1" value="0">
        </label>
        <label class="trial-modal-field">
          <span>Remarks <span class="field-hint">(optional)</span></span>
          <input id="temp-ps-resolve-remarks" class="trial-modal-input" type="text" placeholder="Resolve note">
        </label>
      </div>
    `, 'Save & resolve', async () => {
      const outputEl = document.getElementById('temp-ps-resolve-output');
      const rejectEl = document.getElementById('temp-ps-resolve-reject');
      const remarksEl = document.getElementById('temp-ps-resolve-remarks');
      const qtyProduced = Math.max(0, Number(outputEl?.value || 0));
      const qtyRejected = Math.max(0, Number(rejectEl?.value || 0));
      if (qtyProduced <= 0 && qtyRejected <= 0) {
        window.alert('Enter output or reject quantity.');
        outputEl?.focus();
        return;
      }
      const saveBtn = document.getElementById('trial-save-btn');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
      }
      try {
        const urls = [
          `/api/temp-process-sheets/${encodeURIComponent(psId)}/resolve`,
          `/api/trial/temp-process-sheets/${encodeURIComponent(psId)}/resolve`,
        ];
        let lastError = null;
        for (const url of urls) {
          try {
            await postJson(url, {
              qty_produced: qtyProduced,
              qty_rejected: qtyRejected,
              remarks: String(remarksEl?.value || '').trim(),
            });
            if (typeof closeModal === 'function') closeModal();
            state.details.delete(psId);
            await Promise.all([
              loadProcessSheets({ refresh: true }),
              loadTempTracker(),
            ]);
            return;
          } catch (err) {
            lastError = err;
          }
        }
        window.alert(lastError?.message || 'Could not resolve temp process sheet');
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save & resolve';
        }
      }
    });
    document.getElementById('temp-ps-resolve-output')?.focus();
  }

  async function deleteTempProcessSheet(psId) {
    const canonical = canonicalPlannerPsId({ ps_id: psId });
    if (!canonical) return;
    const label = tempPsDisplayId({ ps_id: canonical }) || canonical;
    const item = tempState.items.find(row => row.planner_ps_id === canonical);
    const queueNote = item?.is_queued
      ? ' It is on the planner queue — scheduled blocks will be removed too.'
      : '';
    if (!window.confirm(`Delete ${label}?${queueNote} This cannot be undone.`)) return;
    const urls = [
      `/api/temp-process-sheets/${encodeURIComponent(canonical)}`,
      `/api/trial/temp-process-sheets/${encodeURIComponent(canonical)}`,
    ];
    let lastError = null;
    for (const url of urls) {
      try {
        await deleteJson(url);
        state.details.delete(canonical);
        await Promise.all([
          loadProcessSheets({ refresh: true }),
          loadTempTracker(),
        ]);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    window.alert(lastError?.message || 'Could not delete temp process sheet');
  }

  async function loadTempTracker() {
    if (!els.tempTracker) return;
    tempState.loading = true;
    renderTempTracker();
    try {
      const data = await getJson('/api/temp-process-sheets?limit=500');
      tempState.items = Array.isArray(data?.items) ? data.items : [];
    } catch (err) {
      tempState.items = [];
      if (els.tempTracker) {
        els.tempTracker.innerHTML = `<div class="queue-empty">${escapeHtml(err.message || 'Could not load temp process sheets')}</div>`;
      }
      if (els.tempTrackerHint) els.tempTrackerHint.textContent = 'Load failed';
    } finally {
      tempState.loading = false;
      renderTempTracker();
    }
  }

  function bind() {
    els.queue = $('ps-queue');
    els.queueHint = $('ps-queue-hint');
    els.search = $('ps-search');
    els.queueFilter = $('ps-queue-filter');
    els.sortBy = $('ps-sort');
    els.overdueOnly = $('ps-overdue-only');
    els.showCompleted = $('ps-show-completed');
    els.completedOnly = $('ps-completed-only');
    els.hideSrTags = $('ps-hide-sr-tags');
    els.typeBtn = $('ps-type-btn');
    els.typePanel = $('ps-type-panel');
    els.tempFilter = $('ps-temp-filter');
    els.createTempBtn = $('ps-create-temp-btn');
    els.refreshBtn = $('ps-refresh-btn');
    els.tempTracker = $('ps-temp-tracker');
    els.tempTrackerHint = $('ps-temp-tracker-hint');
    els.tempSearch = $('ps-temp-search');
    els.tempQueueFilter = $('ps-temp-queue-filter');
    els.tempRefreshBtn = $('ps-temp-refresh-btn');
    els.tempCreateBtn = $('ps-temp-create-btn');
    els.bulkLookupInput = $('ps-bulk-lookup-input');
    els.bulkLookupBtn = $('ps-bulk-lookup-btn');

    document.querySelectorAll('.ps-view-tab').forEach(tab => {
      tab.addEventListener('click', () => setPsView(tab.dataset.psView || 'queue'));
    });
    els.tempSearch?.addEventListener('input', () => renderTempTracker());
    els.tempQueueFilter?.addEventListener('change', () => renderTempTracker());
    els.tempRefreshBtn?.addEventListener('click', () => loadTempTracker());
    els.tempCreateBtn?.addEventListener('click', () => {
      if (typeof openTempProcessSheetModal === 'function') openTempProcessSheetModal();
    });
    els.tempTracker?.addEventListener('click', event => {
      const resolveBtn = event.target.closest('[data-action="resolve-temp-ps"]');
      if (resolveBtn) {
        event.preventDefault();
        const psId = resolveBtn.dataset.psId || '';
        const item = tempState.items.find(row => row.planner_ps_id === psId);
        if (item) openTempPsResolveModal(item);
        return;
      }
      const deleteBtn = event.target.closest('[data-action="delete-temp-ps"]');
      if (deleteBtn) {
        event.preventDefault();
        deleteTempProcessSheet(deleteBtn.dataset.psId || '');
        return;
      }
      const btn = event.target.closest('[data-action="open-temp-detail"]');
      if (!btn) return;
      const psId = btn.dataset.psId || '';
      setPsView('queue');
      if (els.tempFilter) els.tempFilter.value = 'temp_only';
      if (els.queueFilter) els.queueFilter.value = '';
      if (els.search) els.search.value = psId;
      state.page = 1;
      render();
      window.setTimeout(() => {
        const row = [...document.querySelectorAll('.ps-row')].find(el => el.dataset.psId === psId);
        row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        row?.querySelector('[data-action="toggle-details"]')?.click();
      }, 80);
    });

    // PS type dropdown toggle
    els.typeBtn?.addEventListener('click', e => {
      e.stopPropagation();
      els.typePanel.hidden = !els.typePanel.hidden;
    });
    document.addEventListener('click', e => {
      if (els.typePanel && !els.typePanel.hidden && !$('ps-type-dropdown')?.contains(e.target)) {
        els.typePanel.hidden = true;
      }
    });
    els.typePanel?.addEventListener('change', () => {
      const all = [...els.typePanel.querySelectorAll('input')];
      const checked = all.filter(cb => cb.checked).map(cb => cb.value);
      const typeLabel = value => (value === 'TEMP' ? '[Temp]' : value);
      els.typeBtn.textContent = checked.length === all.length
        ? 'All Types ▾'
        : checked.length === 0
          ? 'No Types ▾'
          : `${checked.map(typeLabel).join(', ')} ▾`;
      state.page = 1;
      render();
    });

    els.search?.addEventListener('input', scheduleSearchRender);

    els.bulkLookupBtn?.addEventListener('click', () => runBulkLookup());
    els.bulkLookupInput?.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      runBulkLookup();
    });

    [els.queueFilter, els.sortBy, els.overdueOnly, els.hideSrTags, els.tempFilter]
      .filter(Boolean)
      .forEach(el => el.addEventListener('change', () => {
        state.page = 1;
        render();
      }));

    els.createTempBtn?.addEventListener('click', () => {
      if (typeof openTempProcessSheetModal === 'function') openTempProcessSheetModal();
    });

    [els.showCompleted, els.completedOnly].filter(Boolean).forEach(el => {
      el.addEventListener('change', () => {
        const wantCompleted = shouldIncludeErpCompleted();
        state.page = 1;
        if (wantCompleted !== state.erpIncludeCompleted) {
          loadProcessSheets();
        } else {
          render();
        }
      });
    });

    els.refreshBtn?.addEventListener('click', () => {
      state.details.clear();
      loadProcessSheets({ refresh: true });
    });
    els.queue?.addEventListener('click', event => {
      if (event.target.closest('[data-action="coway-edd"], [data-action="coway-edd-wrap"]')) {
        event.stopPropagation();
        return;
      }
      if (event.target.closest('[data-action="remarks-wrap"], [data-action="save-remarks"]')) {
        event.stopPropagation();
        const saveBtn = event.target.closest('[data-action="save-remarks"]');
        if (saveBtn) {
          const wrap = saveBtn.closest('[data-action="remarks-wrap"]');
          const input = wrap?.querySelector('[data-action="remarks"]');
          if (input) saveRemarks(input.dataset.psId || '', input.value, input);
        }
        return;
      }
      const deleteTempBtn = event.target.closest('[data-action="delete-temp-ps"]');
      if (deleteTempBtn) {
        event.preventDefault();
        event.stopPropagation();
        deleteTempProcessSheet(deleteTempBtn.dataset.psId || '');
        return;
      }
      if (event.target.closest('[data-action="reset-filters"]')) {
        resetFilters();
        return;
      }
      if (event.target.closest('[data-action="retry-load"]')) {
        loadProcessSheets({ refresh: true });
        return;
      }

      const trigger = event.target.closest('[data-action="toggle-details"]');
      if (trigger) {
        toggleDetails(trigger.dataset.psId || '');
        return;
      }

      const pageButton = event.target.closest('[data-action="page-prev"], [data-action="page-next"]');
      if (!pageButton) return;
      state.page += pageButton.dataset.action === 'page-prev' ? -1 : 1;
      render();
    });
    els.queue?.addEventListener('change', event => {
      const cowayInput = event.target.closest('[data-action="coway-edd"]');
      if (cowayInput) {
        event.stopPropagation();
        saveCowayProposedEdd(cowayInput.dataset.psId || '', cowayInput.value, cowayInput);
      }
    });
    els.queue?.addEventListener('input', event => {
      const cowayInput = event.target.closest('[data-action="coway-edd"]');
      if (cowayInput) {
        event.stopPropagation();
        scheduleCowayEddSave(cowayInput);
        return;
      }
      const remarksInput = event.target.closest('[data-action="remarks"]');
      if (remarksInput) {
        event.stopPropagation();
        updateRemarksSaveButton(remarksInput);
      }
    });
    els.queue?.addEventListener('keydown', event => {
      const remarksInput = event.target.closest('[data-action="remarks"]');
      if (!remarksInput || event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      if (remarksIsDirty(remarksInput)) {
        saveRemarks(remarksInput.dataset.psId || '', remarksInput.value, remarksInput);
      }
    });
    els.queue?.addEventListener('blur', event => {
      const cowayInput = event.target.closest('[data-action="coway-edd"]');
      if (cowayInput) {
        clearTimeout(cowaySaveTimer);
        saveCowayProposedEdd(cowayInput.dataset.psId || '', cowayInput.value, cowayInput);
        return;
      }
      const producedInput = event.target.closest('[data-action="manual-produced"]');
      if (producedInput) {
        saveManualProducedQty(
          producedInput.dataset.psId || '',
          producedInput.dataset.opSeqId || '',
          producedInput.value,
          producedInput,
        );
      }
    }, true);
    els.queue?.addEventListener('keydown', event => {
      const producedInput = event.target.closest('[data-action="manual-produced"]');
      if (!producedInput || event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      producedInput.blur();
    });
  }

  window.psBoardItemsForTempSearch = () => {
    const seen = new Set();
    const out = [];
    state.items.forEach(item => {
      const psId = String(item.ps_id || item.display_ps_id || '').trim();
      if (!psId || seen.has(psId)) return;
      seen.add(psId);
      out.push({
        ps_id: psId,
        source_ps_id: item.source_ps_id || psId,
        pp_partial_no: Number(item.pp_partial_no || 1),
        part_no: item.part_no || item.part_name || '',
        part_desc: item.part_desc || '',
        display_qty: Number(item.display_qty ?? item.partial_qty ?? item.wo_req_qty ?? 0),
        due_date: item.due_date || '',
        bom_code: item.selected_bom_code || item.erp_bom_code || '',
        match_source: 'loaded_board',
      });
    });
    return out;
  };

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    loadProcessSheets();
    if (resolveInitialPsView() === 'temp') setPsView('temp');
    window.addEventListener('hashchange', () => {
      if (window.location.hash === '#temp') setPsView('temp');
      else if (window.location.pathname !== '/temp-process-sheets') setPsView('queue');
    });
  });

  window.addEventListener('pp-vouchers-synced', () => {
    state.details.clear();
    setBusy(true);
    loadProcessSheets({ refresh: true }).finally(() => setBusy(false));
  });

  window.addEventListener('temp-ps-created', event => {
    state.details.clear();
    state.page = 1;
    if (els.tempFilter) els.tempFilter.value = 'temp_only';
    if (els.typePanel) {
      els.typePanel.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.checked = cb.value === 'TEMP';
      });
      if (els.typeBtn) els.typeBtn.textContent = 'TEMP ▾';
    }
    if (els.queueFilter) els.queueFilter.value = '';
    const label = event?.detail?.display_ps_id || event?.detail?.planner_ps_id || '';
    if (els.search && label) els.search.value = label;
    setBusy(true);
    loadProcessSheets({ refresh: true }).finally(() => setBusy(false));
    loadTempTracker();
    setPsView('temp');
  });
})();
