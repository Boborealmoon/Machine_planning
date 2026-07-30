(function () {
  const PAGE_SIZE = 100;

  const state = {
    items: [],
    details: new Map(),
    loading: false,
    page: 1,
    erpIncludeCompleted: false,
    psView: 'queue',
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

  const PS_COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5" y="4" width="8" height="10" rx="1"/><path d="M4 4V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1"/></svg>';

  function renderCopyBtn(text, label) {
    const value = String(text || '').trim();
    if (!value) return '';
    const aria = escapeHtml(label || 'text');
    return `
      <button type="button" class="ps-copy-btn"
        data-action="copy-text"
        data-copy-json="${escapeHtml(JSON.stringify(value))}"
        title="Copy ${aria}"
        aria-label="Copy ${aria}">
        ${PS_COPY_ICON}
      </button>
    `;
  }

  function copyTextFromButton(btn) {
    if (!btn) return;
    let value = '';
    try {
      value = JSON.parse(btn.dataset.copyJson || '""');
    } catch (_err) {
      value = btn.dataset.copyJson || '';
    }
    value = String(value || '').trim();
    if (!value) return;
    const label = String(btn.getAttribute('aria-label') || 'Copied').replace(/^Copy\s+/i, '');
    navigator.clipboard.writeText(value).then(() => {
      if (typeof toast === 'function') toast(`${label} copied.`, 'success');
    }).catch(() => {
      if (typeof toast === 'function') toast('Could not copy to clipboard.', 'error');
    });
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

  function parseDateOnly(value) {
    const text = String(value || '').trim().slice(0, 10);
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
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

  function isoCalendarWeek(value) {
    const date = parseDateOnly(value);
    if (!date) return '';
    const dayNum = date.getUTCDay() || 7;
    const thursday = new Date(date);
    thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
    return `${thursday.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
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

  function itemRejectQty(item) {
    const top = Math.max(
      numberValue(item?.reject_qty),
      numberValue(item?.erp_reject_qty),
      numberValue(item?.wo_qty_rejected),
      numberValue(item?.output_debug?.erp_reject_qty),
    );
    const ops = Array.isArray(item?.ops) ? item.ops : [];
    const fromOps = ops.reduce((sum, op) => {
      return sum + Math.max(numberValue(op?.reject_qty), numberValue(op?.wo_qty_rejected));
    }, 0);
    return Math.max(top, fromOps);
  }

  function hasActiveRejectQty(item) {
    return !isCompleted(item) && !isTempPs(item) && itemRejectQty(item) > 0;
  }

  function renderRejectQtyBadge(item) {
    const qty = itemRejectQty(item);
    if (qty <= 0) return '';
    return `
      <span class="ps-qty-badge ps-qty-badge--reject" title="Rejected quantity reported">
        <small>Rej</small>
        <strong>${escapeHtml(fmtQty(qty))}</strong>
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

  function fmtExportDateTime(value) {
    if (!value) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
      return raw.replace('T', ' ').slice(0, 16);
    }
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

  function hasPoDueDate(item) {
    return Boolean(String(item?.due_date || '').trim().slice(0, 10));
  }

  function compareDueAscending(a, b) {
    const da = poDueSortKey(a);
    const db = poDueSortKey(b);
    const aMissing = da === '9999-99-99';
    const bMissing = db === '9999-99-99';
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    if (!aMissing && da !== db) return da.localeCompare(db);
    return comparePlanningPriority(a, b);
  }

  function sortsByPoDue() {
    const mode = currentSortMode();
    return mode === 'due_asc' || mode === 'due_desc';
  }

  function currentSortMode() {
    return String(els.sortBy?.value || 'planning').trim().toLowerCase();
  }

  function sortQueueItems(items) {
    const mode = currentSortMode();
    const list = [...items];
    if (mode === 'due_asc') {
      return list.sort(compareDueAscending);
    }
    if (mode === 'due_desc') {
      return list.sort((a, b) => {
        const da = poDueSortKey(a);
        const db = poDueSortKey(b);
        const aMissing = da === '9999-99-99';
        const bMissing = db === '9999-99-99';
        if (aMissing !== bMissing) return aMissing ? 1 : -1;
        if (!aMissing && da !== db) return db.localeCompare(da);
        return comparePlanningPriority(a, b);
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

  function isExecutionCompletedStatus(value) {
    const status = normalizeStatus(value);
    return status === 'COMPLETED' || status === 'C';
  }

  function opErpProducedQty(op) {
    return Math.max(
      numberValue(op?.finished_qty ?? op?.wo_qty_produced),
      numberValue(op?.erp_finished_qty),
    );
  }

  function opIsBeforeCurrentErpStage(op, item) {
    if (!op || !item) return false;
    const currentStage = Number(item?.current_stage_no || 0);
    const opStage = Number(op?.source_stage_no ?? op?.stage_no ?? 0);
    if (currentStage > 0 && opStage > 0) return opStage < currentStage;
    const currentDesc = compactText(item?.current_stage_desc);
    const tail = currentDesc.match(/(\d+)\s*$/);
    const currentOpNo = tail ? Number(tail[1]) : 0;
    const opNo = Number(op?.op_no || op?.source_op_no || 0);
    return currentOpNo > 0 && opNo > 0 && opNo < currentOpNo;
  }

  function opRemainingQty(op) {
    const direct = numberValue(op?.remaining_qty);
    if (direct > SHIPPED_QTY_TOLERANCE) return direct;
    const required = numberValue(op?.wo_qty_required ?? op?.required_qty ?? 0);
    const finished = opErpProducedQty(op);
    return Math.max(0, required - finished);
  }

  function opHasWorkOrderEvidence(op) {
    const required = numberValue(op?.wo_qty_required ?? op?.required_qty ?? 0);
    const produced = opErpProducedQty(op);
    const status = normalizeStatus(opExecutionStatus(op));
    return required > SHIPPED_QTY_TOLERANCE || produced > SHIPPED_QTY_TOLERANCE || Boolean(status);
  }

  function isOpProductionComplete(op, item) {
    if (!opHasWorkOrderEvidence(op)) return true;
    const finished = opErpProducedQty(op);
    const required = numberValue(op?.wo_qty_required ?? op?.required_qty ?? 0);
    if (required > SHIPPED_QTY_TOLERANCE && finished >= required - SHIPPED_QTY_TOLERANCE) return true;
    if (opRemainingQty(op) > SHIPPED_QTY_TOLERANCE) return false;
    if (finished > SHIPPED_QTY_TOLERANCE) return true;
    if (isExecutionCompletedStatus(opExecutionStatus(op))) {
      if (required > SHIPPED_QTY_TOLERANCE) return finished >= required - SHIPPED_QTY_TOLERANCE;
      return finished > SHIPPED_QTY_TOLERANCE;
    }
    return false;
  }

  function opDisplayExecutionStatus(op, item) {
    const status = opExecutionStatus(op);
    const norm = normalizeStatus(status);
    if (!norm) return '';
    if (isExecutionCompletedStatus(norm) && !isOpProductionComplete(op, item)) return '';
    return status;
  }

  function isOpRouteSatisfied(op, item) {
    if (item && opIsBeforeCurrentErpStage(op, item)) return true;
    return isOpProductionComplete(op, item);
  }

  function rollupExecutionStatus(item) {
    const stageStatus = normalizeStatus(item?.current_stage_status || item?.execution_status || '');
    const ops = sortedOpsForStage(item);
    const openOps = ops.filter(op => !isOpProductionComplete(op, item));
    if (openOps.length) {
      const currentOpen = openOps.find(op => {
        const stageDesc = compactText(item?.current_stage_desc);
        const opNo = compactText(op?.op_no || op?.source_op_no);
        const opType = compactText(op?.op_type || op?.operation_name);
        if (stageDesc && opNo && stageDesc.includes(opNo)) return true;
        if (stageDesc && opType && stageDesc.toLowerCase().includes(opType.toLowerCase())) return true;
        const currentStage = Number(item?.current_stage_no || 0);
        const opStage = Number(op?.source_stage_no ?? op?.stage_no ?? 0);
        return currentStage > 0 && opStage > 0 && opStage === currentStage;
      }) || openOps[0];
      const openStatus = normalizeStatus(opExecutionStatus(currentOpen));
      if (openStatus && !isExecutionCompletedStatus(openStatus)) return opExecutionStatus(currentOpen);
      if (stageStatus && !isExecutionCompletedStatus(stageStatus)) {
        return item?.current_stage_status || item?.execution_status || '';
      }
    }
    const statuses = ops
      .map(op => opExecutionStatus(op))
      .filter(status => normalizeStatus(status));
    if (statuses.length) {
      const pending = statuses.find(status => !isExecutionCompletedStatus(status));
      if (pending) return pending;
      return statuses[0];
    }
    return item?.current_stage_status || item?.execution_status || item?.erp_execution_status || '';
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
    const desc = compactText(op?.stage_desc || op?.op_type || op?.operation_name);
    if (desc) return desc;
    const opNo = compactText(op?.op_no || op?.source_op_no || op?.operation_label);
    return opNo ? `Op ${opNo}` : '';
  }

  function stageFromOp(op, options = {}) {
    const desc = stageDescFromOp(op);
    if (!desc) return null;
    const item = options.item || null;
    return {
      stageNo: Number(op?.stage_no || op?.source_stage_no || 0) || null,
      opNo: compactText(op?.op_no || op?.source_op_no || op?.operation_label),
      desc,
      status: item ? opDisplayExecutionStatus(op, item) : opExecutionStatus(op),
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
      const resolved = stageFromOp(active, { item });
      if (resolved) {
        resolved.source = 'derived';
        return resolved;
      }
    }

    const openOp = trackedOps.find(op => !isOpProductionComplete(op, item));
    if (openOp) {
      const resolved = stageFromOp(openOp, { item });
      if (resolved) {
        resolved.source = 'derived';
        return resolved;
      }
    }

    const pendingOps = trackedOps.filter(op => !isOpProductionComplete(op, item));
    if (pendingOps.length) {
      const nextOp = pendingOps.sort((a, b) => (
        executionStatusRank(opExecutionStatus(a)) - executionStatusRank(opExecutionStatus(b))
      ))[0];
      const resolved = stageFromOp(nextOp, { item });
      if (resolved) {
        resolved.source = 'derived';
        return resolved;
      }
    }

    if (trackedOps.every(op => isOpProductionComplete(op, item))) {
      const lastOp = trackedOps[trackedOps.length - 1];
      const resolved = stageFromOp(lastOp, { item, allComplete: true });
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
      .map(op => opDisplayExecutionStatus(op, item))
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

  function renderOpStatusCell(op, item) {
    const status = opDisplayExecutionStatus(op, item);
    if (!normalizeStatus(status)) return '<span class="ps-row-muted">-</span>';
    return `<span class="ps-op-status ${opStatusClass(status)}">${escapeHtml(displayExecutionStatus(status))}</span>`;
  }

  function materialSeverity(item) {
    return String(item.material_status?.severity || '').toLowerCase();
  }

  function isMaterialShortage(item) {
    return ['late', 'warning', 'shortage'].includes(materialSeverity(item));
  }

  function isPendingDo(item) {
    if (item && Object.prototype.hasOwnProperty.call(item, 'pending_do')) {
      return Boolean(item.pending_do);
    }
    return false;
  }

  function isCompleted(item) {
    if (isPendingDo(item)) return false;
    const ops = Array.isArray(item?.ops) ? item.ops : [];
    const trackedOps = ops.filter(op => opHasWorkOrderEvidence(op));
    if (trackedOps.some(op => !isOpProductionComplete(op, item))) return false;
    if (isShippedComplete(item)) return true;
    if (trackedOps.length) {
      return trackedOps.every(op => isOpProductionComplete(op, item));
    }
    const remaining = numberValue(item?.remaining_qty);
    const finished = numberValue(item?.finished_qty);
    const required = numberValue(firstQuantity(item?.wo_req_qty, item?.display_qty, item?.partial_qty, item?.total_qty, 0));
    const executionDone = boolValue(item?.execution_completed)
      || (trackedOps.length > 0 && trackedOps.every(op => isOpProductionComplete(op, item)));
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
      item.material_inventory_code,
      ...(Array.isArray(item.material_inventory_codes) ? item.material_inventory_codes : []),
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

  function parseBulkLookupTerms(raw) {
    return String(raw || '')
      .split(/[\s,;]+/)
      .map(term => term.trim().toLowerCase())
      .filter(Boolean);
  }

  const PS_BASE_ID_RE = /^(?:aps|nps|pps|cps|mps|sr)\d{2}-\d{4}$/i;
  const PS_DASH_PARTIAL_RE = /^((?:aps|nps|pps|cps|mps|sr)\d{2}-\d{4})-(\d+)$/i;

  function isPsBaseId(value) {
    return PS_BASE_ID_RE.test(String(value || '').trim());
  }

  function parseBulkLookupPsTerm(term) {
    const raw = String(term || '').trim().toLowerCase();
    if (!raw) return null;
    if (raw.includes('::')) {
      const [base, partialText] = raw.split('::');
      const partial = Number(partialText) || 1;
      const normalizedBase = String(base || '').trim();
      return {
        raw,
        base: normalizedBase,
        partial,
        canonical: partial > 1 ? `${normalizedBase}::${partial}` : normalizedBase,
      };
    }
    const dashMatch = raw.match(PS_DASH_PARTIAL_RE);
    if (dashMatch) {
      const base = dashMatch[1].toLowerCase();
      const partial = Number(dashMatch[2]) || 1;
      return {
        raw,
        base,
        partial,
        canonical: partial > 1 ? `${base}::${partial}` : base,
      };
    }
    return { raw, base: raw, partial: null, canonical: raw };
  }

  function itemPsBaseAndPartial(item) {
    const source = String(item?.source_ps_id || item?.display_ps_id || item?.ps_id || '')
      .split('::')[0]
      .trim()
      .toLowerCase();
    return { source, partial: Number(partialNo(item)) || 1 };
  }

  function itemMatchesBulkLookupTerm(item, parsed) {
    if (!parsed) return false;
    const { source, partial } = itemPsBaseAndPartial(item);
    if (parsed.partial !== null && isPsBaseId(parsed.base)) {
      return source === parsed.base && partial === parsed.partial;
    }
    const haystack = itemSearchText(item);
    return haystack.includes(parsed.raw)
      || haystack.includes(parsed.canonical)
      || (isPsBaseId(parsed.base) && source === parsed.base);
  }

  function matchesSearchTerms(item, terms) {
    if (!terms.length) return true;
    const haystack = itemSearchText(item);
    return terms.some(term => {
      if (haystack.includes(term)) return true;
      const serial = term.replace(/^0+/, '');
      return serial && serial !== term && haystack.includes(serial);
    });
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
        if (existing && prefer && normalized.source !== 'erp' && !normalized.customer_po_no) {
          normalized.customer_po_no = existing.customer_po_no || '';
        }
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

  function unmatchedBulkLookupTerms(parsedTerms, items) {
    return parsedTerms
      .filter(parsed => !items.some(item => itemMatchesBulkLookupTerm(item, parsed)))
      .map(parsed => parsed.raw);
  }

  function bulkLookupQueueLabel(item) {
    if (isCompleted(item)) return 'Completed';
    if (isQueued(item)) {
      const machines = queuedMachines(item);
      return machines.length ? `Queued (${machines.join(', ')})` : 'Queued';
    }
    return 'Needs scheduling';
  }

  function fmtDateTimeExport(value) {
    if (!value) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return raw.slice(0, 16).replace('T', ' ');
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function bulkLookupScheduleFields(item) {
    const start = item?.expected_start || '';
    const end = item?.expected_end || '';
    return {
      scheduled_start: start ? fmtDateTimeExport(start) : '',
      scheduled_end: end ? fmtDateTimeExport(end) : '',
      scheduled_start_display: start ? fmtBlockDateTime(start) : '—',
      scheduled_end_display: end ? fmtBlockDateTime(end) : '—',
    };
  }

  function bulkLookupPlannerPoolItems() {
    const byKey = new Map();
    const ingest = item => {
      if (!item) return;
      const key = itemIdentityKey(item);
      if (!key) return;
      byKey.set(key, item);
    };
    state.items.forEach(ingest);
    if (Array.isArray(bulkLookupExportState.boardItems)) {
      bulkLookupExportState.boardItems.forEach(ingest);
    }
    return [...byKey.values()];
  }

  function buildPlannerScheduleMap(plannerRows) {
    const map = new Map();
    (Array.isArray(plannerRows) ? plannerRows : []).forEach(row => {
      const key = itemIdentityKey(row);
      if (key) map.set(key, row);
    });
    return map;
  }

  function enrichBulkLookupPlannerFields(item, plannerByKey) {
    const normalized = item?.source ? item : normalizeErpItem(item);
    const planner = plannerByKey.get(itemIdentityKey(normalized));
    if (!planner) return normalized;
    return {
      ...normalized,
      expected_start: planner.expected_start || normalized.expected_start || '',
      expected_end: planner.expected_end || normalized.expected_end || '',
      queued_machines: planner.queued_machines?.length ? planner.queued_machines : (normalized.queued_machines || []),
      queued_machine_details: planner.queued_machine_details?.length
        ? planner.queued_machine_details
        : (normalized.queued_machine_details || []),
      planned_qty: planner.planned_qty ?? normalized.planned_qty,
      finished_qty: planner.finished_qty ?? normalized.finished_qty,
      remaining_qty: planner.remaining_qty ?? normalized.remaining_qty,
      coway_proposed_edd: planner.coway_proposed_edd || normalized.coway_proposed_edd,
      remarks: planner.remarks || normalized.remarks,
      planner_status: planner.planner_status || normalized.planner_status,
      ops: planner.ops?.length ? planner.ops : normalized.ops,
      order_date: planner.order_date || normalized.order_date,
    };
  }

  function bulkLookupStageLabel(item) {
    const stage = resolveCurrentStage(item);
    if (!stage?.desc) return '—';
    const status = stage.status ? displayExecutionStatus(stage.status) : '';
    return status ? `${stage.desc} · ${status}` : stage.desc;
  }

  function bulkLookupScheduleStartLabel(item) {
    const { scheduled_start_display } = bulkLookupScheduleFields(item);
    return scheduled_start_display;
  }

  function bulkLookupScheduleEndLabel(item) {
    const { scheduled_end_display } = bulkLookupScheduleFields(item);
    return scheduled_end_display;
  }

  function bulkIncludePricing() {
    return Boolean(els.bulkIncludePricing?.checked);
  }

  function fmtBulkPricingCell(value) {
    if (value === '' || value == null) return '—';
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  function renderBulkLookupTable(items, includePricing = false) {
    if (!items.length) {
      return '<div class="ps-details-empty">No process sheets matched your search terms.</div>';
    }
    const pricingHeaders = includePricing
      ? '<th>Unit value</th><th>Exchange rate</th><th>Total value</th>'
      : '';
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
                <th>Material</th>
                <th>Qty</th>
                ${pricingHeaders}
                <th>PO due</th>
                <th>Coway EDD</th>
                <th>Coway week</th>
                <th>Current stage</th>
                <th>Queue</th>
                <th>Machines</th>
                <th>Scheduled start</th>
                <th>Scheduled end</th>
                <th>Planned qty</th>
                <th>Finished qty</th>
                <th>SO / PO</th>
                <th>Customer PO no</th>
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
                const cowayWeek = isoCalendarWeek(item.coway_proposed_edd) || '—';
                const so = item.source_voucher_no || '—';
                const customerPo = item.customer_po_no || '—';
                const shipped = fmtQty(item.qty_shipped || 0);
                const soQty = fmtSoQty(item);
                const queueClass = isQueued(item) ? 'ps-badge--queued' : 'ps-badge--needs-scheduling';
                const tempBadge = isTempPs(item) ? '<span class="ps-temp-badge">[Temp]</span> ' : '';
                const machines = queuedMachines(item);
                const plannedQty = isQueued(item) ? fmtQty(item.planned_qty || 0) : '—';
                const finishedQty = isQueued(item) ? fmtQty(item.finished_qty || 0) : '—';
                const pricing = includePricing ? bulkLookupPricingExportFields(item) : null;
                const pricingCells = includePricing
                  ? `<td>${escapeHtml(fmtBulkPricingCell(pricing.unit_cost))}</td>
                    <td>${escapeHtml(fmtBulkPricingCell(pricing.exchange_rate))}</td>
                    <td>${escapeHtml(fmtBulkPricingCell(pricing.final_amount))}</td>`
                  : '';
                return `
                  <tr data-action="bulk-lookup-open" data-ps-id="${escapeHtml(psId)}" title="Click to open in queue">
                    <td>${tempBadge}<button type="button" class="ps-bulk-lookup-row-btn" data-action="bulk-lookup-open" data-ps-id="${escapeHtml(psId)}">${escapeHtml(displayId)}</button></td>
                    <td>${escapeHtml(partialLabel(item))}</td>
                    <td>${escapeHtml(part)}</td>
                    <td>${escapeHtml(item.part_desc || '—')}</td>
                    <td>${escapeHtml(materialInventoryLabel(item) || '—')}</td>
                    <td>${escapeHtml(qty)}</td>
                    ${pricingCells}
                    <td class="${due !== '-' && isOverdue(item) ? 'is-overdue' : ''}">${escapeHtml(due)}</td>
                    <td>${escapeHtml(coway)}</td>
                    <td>${escapeHtml(cowayWeek)}</td>
                    <td>${escapeHtml(bulkLookupStageLabel(item))}</td>
                    <td><span class="ps-badge ${queueClass}">${escapeHtml(bulkLookupQueueLabel(item))}</span></td>
                    <td>${escapeHtml(machines.length ? machines.join(', ') : '—')}</td>
                    <td>${escapeHtml(bulkLookupScheduleStartLabel(item))}</td>
                    <td>${escapeHtml(bulkLookupScheduleEndLabel(item))}</td>
                    <td>${escapeHtml(plannedQty)}</td>
                    <td>${escapeHtml(finishedQty)}</td>
                    <td>${escapeHtml(so)}</td>
                    <td>${escapeHtml(customerPo)}</td>
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
      <div class="ps-details-loading">Loading process sheets and planner schedule…</div>
    `, 'xl');
  }

  const bulkLookupExportState = {
    items: [],
    missedTerms: [],
    terms: [],
    boardItems: [],
    includePricing: false,
  };

  function sortBulkLookupItemsByInputOrder(items, parsedTerms) {
    function matchIndex(item) {
      const idx = parsedTerms.findIndex(parsed => itemMatchesBulkLookupTerm(item, parsed));
      return idx >= 0 ? idx : parsedTerms.length;
    }
    return [...items].sort((a, b) => {
      const orderDiff = matchIndex(a) - matchIndex(b);
      if (orderDiff) return orderDiff;
      const psDiff = String(a.display_ps_id || a.ps_id || '').localeCompare(String(b.display_ps_id || b.ps_id || ''));
      if (psDiff) return psDiff;
      return Number(partialNo(a)) - Number(partialNo(b));
    });
  }

  function bulkLookupPricingKey(item) {
    const so = String(item?.source_voucher_no || '').trim();
    const line = String(item?.source_line_item_no || '').trim().replace(/\.0+$/, '');
    return so && line ? `${so}|${line}` : '';
  }

  async function enrichBulkLookupPricing(items) {
    const keys = [];
    const seen = new Set();
    (Array.isArray(items) ? items : []).forEach(item => {
      const key = bulkLookupPricingKey(item);
      if (!key || seen.has(key)) return;
      seen.add(key);
      const [salesOrderNo, lineItemNo] = key.split('|');
      keys.push({ sales_order_no: salesOrderNo, line_item_no: lineItemNo });
    });
    if (!keys.length) return items;
    const data = await postJson('/api/process-sheets/so-line-pricing', { keys }).catch(() => null);
    const pricing = data?.pricing || {};
    if (!Object.keys(pricing).length) return items;
    return items.map(item => {
      const key = bulkLookupPricingKey(item);
      const row = key ? pricing[key] : null;
      if (!row) return item;
      return {
        ...item,
        unit_cost: row.unit_cost,
        exch_rate: row.exch_rate,
        unit_cost_home: row.unit_cost_home,
      };
    });
  }

  function bulkLookupPricingExportFields(item) {
    const qty = firstQuantity(item.display_qty, item.partial_qty, item.wo_req_qty, item.total_qty, 0);
    const unitCost = numberValue(item.unit_cost);
    const exchRate = numberValue(item.exch_rate);
    if (!unitCost) {
      return { unit_cost: '', exchange_rate: '', final_amount: '' };
    }
    const rate = exchRate > 0 ? exchRate : 1;
    const finalAmount = qty > 0 ? Math.round(unitCost * qty * rate * 100) / 100 : '';
    return {
      unit_cost: unitCost,
      exchange_rate: exchRate > 0 ? exchRate : '',
      final_amount: finalAmount,
    };
  }

  async function fetchBulkLookupResults(raw, options = {}) {
    const includePricing = Boolean(options.includePricing);
    const terms = parseBulkLookupTerms(raw);
    const parsedTerms = terms.map(parseBulkLookupPsTerm).filter(Boolean);
    if (!parsedTerms.length) {
      throw new Error('Enter one or more process sheet numbers separated by commas, spaces, or newlines.');
    }
    const apiBases = [...new Set(parsedTerms.map(parsed => parsed.base).filter(Boolean))];
    const searchParam = encodeURIComponent(apiBases.join(','));
    const [apiRows, boardPayload] = await Promise.all([
      getJson(
        `/api/pp-vouchers/with-ops?search=${searchParam}&show_completed=1`,
        { timeoutMs: 120000 },
      ).catch(() => []),
      getJson('/api/process-sheets/board?show_completed=1', { timeoutMs: 120000 }).catch(() => null),
    ]);
    bulkLookupExportState.boardItems = boardPayload ? mergeBoardItems(boardPayload) : [];
    const plannerByKey = buildPlannerScheduleMap(bulkLookupPlannerPoolItems());
    const plannerMatches = bulkLookupPlannerPoolItems().filter(item =>
      parsedTerms.some(parsed => itemMatchesBulkLookupTerm(item, parsed)),
    );
    const items = sortBulkLookupItemsByInputOrder(
      mergeBulkLookupItems(apiRows, plannerMatches)
        .filter(item => parsedTerms.some(parsed => itemMatchesBulkLookupTerm(item, parsed)))
        .map(item => enrichBulkLookupPlannerFields(item, plannerByKey)),
      parsedTerms,
    );
    const pricedItems = includePricing ? await enrichBulkLookupPricing(items) : items;
    const missedTerms = unmatchedBulkLookupTerms(parsedTerms, items);
    return { terms, parsedTerms, items: pricedItems, missedTerms, includePricing };
  }

  const PS_EXPORT_PRICING_COLUMNS = [
    { key: 'unit_cost', header: 'Unit value', width: 12 },
    { key: 'exchange_rate', header: 'Exchange rate', width: 12 },
    { key: 'final_amount', header: 'Total value', width: 14 },
  ];

  const PS_EXPORT_COLUMNS = [
    { key: 'process_sheet', header: 'Process sheet', width: 16 },
    { key: 'partial', header: 'Partial', width: 8 },
    { key: 'part_no', header: 'Part no', width: 14 },
    { key: 'description', header: 'Description', width: 28 },
    { key: 'material', header: 'Material', width: 18 },
    { key: 'qty', header: 'Qty', width: 10 },
    { key: 'po_due', header: 'PO due', width: 12 },
    { key: 'coway_edd', header: 'Coway EDD', width: 12 },
    { key: 'coway_week', header: 'Coway week', width: 12 },
    { key: 'current_stage', header: 'Current stage', width: 22 },
    { key: 'stage_status', header: 'Stage status', width: 14 },
    { key: 'queue_status', header: 'Queue', width: 18 },
    { key: 'queued_machines', header: 'Queued machines', width: 18 },
    { key: 'scheduled_start', header: 'Scheduled start', width: 20 },
    { key: 'scheduled_end', header: 'Scheduled end', width: 20 },
    { key: 'planned_qty', header: 'Planned qty', width: 12 },
    { key: 'finished_qty', header: 'Finished qty', width: 12 },
    { key: 'remaining_qty', header: 'Remaining qty', width: 12 },
    { key: 'order_posted', header: 'Order posted', width: 12 },
    { key: 'so_po', header: 'SO / PO', width: 16 },
    { key: 'customer_po_no', header: 'Customer PO no', width: 16 },
    { key: 'shipped_qty', header: 'Shipped qty', width: 12 },
    { key: 'so_qty', header: 'SO qty', width: 10 },
    { key: 'bom_route', header: 'BOM / route', width: 16 },
    { key: 'remarks', header: 'Remarks', width: 24 },
    { key: 'erp_status', header: 'ERP status', width: 12 },
  ];

  function psExportColumns(includePricing = false) {
    if (!includePricing) return PS_EXPORT_COLUMNS;
    const qtyIndex = PS_EXPORT_COLUMNS.findIndex(col => col.key === 'qty');
    const insertAt = qtyIndex >= 0 ? qtyIndex + 1 : 6;
    return [
      ...PS_EXPORT_COLUMNS.slice(0, insertAt),
      ...PS_EXPORT_PRICING_COLUMNS,
      ...PS_EXPORT_COLUMNS.slice(insertAt),
    ];
  }

  function bulkLookupExportRow(item, includePricing = false) {
    const stage = resolveCurrentStage(item);
    const stageStatus = stage?.status ? displayExecutionStatus(stage.status) : '';
    const machines = queuedMachines(item);
    const schedule = bulkLookupScheduleFields(item);
    const pricing = includePricing ? bulkLookupPricingExportFields(item) : null;
    const row = {
      process_sheet: tempPsDisplayId(item) || item.display_ps_id || item.ps_id || '',
      partial: partialLabel(item),
      part_no: item.part_no || item.part_name || item.inventory_code || '',
      description: item.part_desc || '',
      material: materialInventoryLabel(item),
      qty: firstQuantity(item.display_qty, item.partial_qty, item.wo_req_qty, item.total_qty, 0),
      po_due: fmtDate(item.due_date) === '-' ? '' : fmtDate(item.due_date),
      coway_edd: fmtDate(item.coway_proposed_edd) === '-' ? '' : fmtDate(item.coway_proposed_edd),
      coway_week: isoCalendarWeek(item.coway_proposed_edd),
      current_stage: stage?.desc || '',
      stage_status: stageStatus,
      queue_status: bulkLookupQueueLabel(item),
      queued_machines: machines.join(', '),
      scheduled_start: schedule.scheduled_start,
      scheduled_end: schedule.scheduled_end,
      planned_qty: isQueued(item) ? numberValue(item.planned_qty) : '',
      finished_qty: numberValue(item.finished_qty),
      remaining_qty: numberValue(item.remaining_qty),
      order_posted: fmtDate(item.order_date) === '-' ? '' : fmtDate(item.order_date),
      so_po: item.source_voucher_no || '',
      customer_po_no: item.customer_po_no || '',
      shipped_qty: numberValue(item.qty_shipped),
      so_qty: item.so_det_qty != null ? numberValue(item.so_det_qty) : '',
      bom_route: item.selected_flow_code || item.route_label || item.erp_bom_code || '',
      remarks: item.remarks || '',
      erp_status: item.status || item.execution_status || '',
    };
    if (pricing) {
      row.unit_cost = pricing.unit_cost;
      row.exchange_rate = pricing.exchange_rate;
      row.final_amount = pricing.final_amount;
    }
    return row;
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

  function bulkExportFilename() {
    const stamp = new Date().toISOString().slice(0, 10);
    return `process-sheets-export-${stamp}.xlsx`;
  }

  async function exportBulkLookupToExcel(items, missedTerms, terms, includePricing = false) {
    if (!items.length && !missedTerms.length) {
      throw new Error('No process sheets matched your list.');
    }
    const ExcelJS = await ensureExcelJs();
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Production Planner';
    workbook.created = new Date();

    const columns = psExportColumns(includePricing);
    const sheet = workbook.addWorksheet('Process sheets');
    const headers = columns.map(col => col.header);
    const headerRow = sheet.addRow(headers);
    headerRow.font = { bold: true, size: 11 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    headerRow.alignment = { vertical: 'middle' };

    items.forEach(item => {
      const row = bulkLookupExportRow(item, includePricing);
      sheet.addRow(columns.map(col => row[col.key] ?? ''));
    });

    columns.forEach((col, index) => {
      sheet.getColumn(index + 1).width = col.width;
    });
    sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 0, activeCell: 'A2' }];

    if (missedTerms.length) {
      const missedSheet = workbook.addWorksheet('No matches');
      const missedHeader = missedSheet.addRow(['Requested value', 'Note']);
      missedHeader.font = { bold: true, size: 11 };
      missedHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF2F2' } };
      missedTerms.forEach(term => {
        missedSheet.addRow([term, 'No matching process sheet found']);
      });
      missedSheet.getColumn(1).width = 24;
      missedSheet.getColumn(2).width = 36;
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = bulkExportFilename();
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    const summaryParts = [`Exported ${items.length} process sheet${items.length === 1 ? '' : 's'}`];
    if (includePricing) summaryParts.push('with unit / total value');
    if (missedTerms.length) summaryParts.push(`${missedTerms.length} not found`);
    if (typeof toast === 'function') toast(summaryParts.join(' · '), missedTerms.length ? 'info' : 'success');
  }

  function openBulkLookupModalResults(terms, items, missedTerms, includePricing = false) {
    if (typeof openModal !== 'function') return;
    bulkLookupExportState.items = items;
    bulkLookupExportState.missedTerms = missedTerms;
    bulkLookupExportState.terms = terms;
    bulkLookupExportState.includePricing = includePricing;
    const missedHtml = missedTerms.length
      ? `<div class="ps-bulk-lookup-missed"><strong>No matches</strong>${escapeHtml(missedTerms.join(', '))}</div>`
      : '';
    const pricingNote = includePricing
      ? '<span>Includes unit value, exchange rate, and total value</span>'
      : '';
    openModal('Bulk lookup results', `
      <div class="ps-bulk-lookup-summary">
        <span><strong>${escapeHtml(items.length)}</strong> process sheet${items.length === 1 ? '' : 's'} found</span>
        <span>Searched: ${escapeHtml(terms.join(', '))}</span>
        ${pricingNote}
        <button type="button" class="btn btn-dark btn-sm" data-action="bulk-lookup-export">Export Excel</button>
      </div>
      ${renderBulkLookupTable(items, includePricing)}
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
    shell.querySelector('[data-action="bulk-lookup-export"]')?.addEventListener('click', event => {
      event.preventDefault();
      runBulkExport({
        items: bulkLookupExportState.items,
        missedTerms: bulkLookupExportState.missedTerms,
        terms: bulkLookupExportState.terms,
        includePricing: bulkLookupExportState.includePricing,
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
    if (!raw) {
      window.alert('Enter one or more process sheet numbers separated by commas, spaces, or newlines.');
      els.bulkLookupInput?.focus();
      return;
    }
    const includePricing = bulkIncludePricing();
    openBulkLookupModalLoading(parseBulkLookupTerms(raw));
    try {
      const { terms, items, missedTerms } = await fetchBulkLookupResults(raw, { includePricing });
      openBulkLookupModalResults(terms, items, missedTerms, includePricing);
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

  async function runBulkExport(prefetched) {
    const btn = els.bulkExportBtn;
    const raw = String(els.bulkLookupInput?.value || '').trim();
    if (!prefetched && !raw) {
      window.alert('Enter one or more process sheet numbers separated by commas, spaces, or newlines.');
      els.bulkLookupInput?.focus();
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Exporting…';
    }
    try {
      const includePricing = prefetched
        ? Boolean(prefetched.includePricing)
        : bulkIncludePricing();
      let result = prefetched;
      if (!result) {
        result = await fetchBulkLookupResults(raw, { includePricing });
      } else if (includePricing && !(result.items || []).some(item => item.unit_cost != null || item.exch_rate != null)) {
        result = {
          ...result,
          items: await enrichBulkLookupPricing(result.items || []),
          includePricing: true,
        };
      }
      await exportBulkLookupToExcel(
        result.items,
        result.missedTerms,
        result.terms,
        includePricing,
      );
    } catch (err) {
      if (typeof toast === 'function') {
        toast(err.message || 'Export failed.', 'error');
      } else {
        window.alert(err.message || 'Export failed.');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Export Excel';
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
      is_completed: isPendingDo(item) ? false : (shippedComplete || boolValue(item.is_completed)),
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
      reject_qty: numberValue(item.reject_qty),
      wo_qty_rejected: numberValue(item.wo_qty_rejected),
      erp_reject_qty: numberValue(item.erp_reject_qty),
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
      source_line_item_no: item.source_line_item_no || '',
      customer_po_no: item.customer_po_no || '',
      qty_shipped: item.qty_shipped || 0,
      so_det_qty: item.so_det_qty,
      current_stage_no: item.current_stage_no,
      current_stage_desc: item.current_stage_desc || '',
      current_stage_status: item.current_stage_status || '',
      pending_do: boolValue(item.pending_do),
      material_inventory_code: item.material_inventory_code || '',
      material_inventory_codes: Array.isArray(item.material_inventory_codes)
        ? item.material_inventory_codes
        : (item.material_inventory_code ? [item.material_inventory_code] : []),
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
    if (sortMode === 'due_asc') parts.push('open only · PO due (overdue first, then soonest)');
    if (sortMode === 'due_desc') parts.push('open only · PO due (latest)');
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
    const dueSortActive = sortsByPoDue();

    return state.items.filter(item => {
      if (state.psView === 'rejects') {
        if (!hasActiveRejectQty(item)) return false;
      }
      if (dueSortActive && !completedOnly && isCompleted(item)) return false;
      if (dueSortActive && !hasPoDueDate(item)) return false;
      if (tempFilter === 'temp_only' && !isTempPs(item)) return false;
      if (tempFilter === 'hide_temp' && isTempPs(item)) return false;
      if (hideSrTags && !completedOnly && !searchTerms.length && isSrTagged(item)) return false;
      if (!allTypesOn) {
        const t = getPsType(item);
        if (t && !checkedTypes.has(t)) return false;
      }
      if (!matchesSearchTerms(item, searchTerms)) return false;
      if (!searchTerms.length) {
        if (queueFilter === 'queued' && !isQueued(item)) return false;
        if (queueFilter === 'unqueued' && isQueued(item)) return false;
      }
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
    updateRejectsTabCount();
    updateTempTabCount();
    updateQueueViewHeading();
  }

  function updateQueueViewHeading() {
    const title = $('ps-queue-section-title');
    const desc = $('ps-queue-section-desc');
    if (!title || !desc) return;
    if (state.psView === 'rejects') {
      title.textContent = 'Rejected qty';
      desc.innerHTML = 'Active process sheets with <strong>rejected quantity</strong> reported and not yet fully completed. Use <strong>Create temp PS</strong> to spin up a rework copy.';
      return;
    }
    title.textContent = 'Active Job Control';
    desc.innerHTML = 'ERP and planner lines including <strong>[Temp]</strong> when enabled in filters below. Use filter <strong>[Temp] only</strong> to focus reject/rework copies in this queue.';
  }

  function updateRejectsTabCount() {
    const pill = $('ps-rejects-tab-count');
    if (!pill) return;
    const count = state.items.filter(hasActiveRejectQty).length;
    if (count <= 0) {
      pill.hidden = true;
      return;
    }
    pill.hidden = false;
    pill.textContent = String(count);
  }

  function updateTempTabCount() {
    const pill = $('ps-temp-tab-count');
    if (!pill) return;
    const unresolved = tempState.items.filter(item => !item.is_resolved).length;
    const fromQueue = state.items.filter(item => isTempPs(item) && !isCompleted(item)).length;
    const count = tempState.items.length ? unresolved : fromQueue;
    if (count <= 0) {
      pill.hidden = true;
      return;
    }
    pill.hidden = false;
    pill.textContent = String(count);
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
        const rejectView = state.psView === 'rejects';
        els.queue.innerHTML = [
          '<div class="queue-empty">',
          `<p><strong>${rejectView ? 'No active process sheets with rejected qty match.' : 'No results.'}</strong></p>`,
          rejectView
            ? '<p class="queue-empty-meta">Rejected qty is read from ERP WO reporting. Try clearing search or queue filters.</p>'
            : '',
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
      const loadingNote = state.loading ? ' | refreshing from cache…' : '';
      if (state.psView === 'rejects') {
        els.queueHint.textContent = `${sortedItems.length} active with rejected qty · showing ${start + 1}-${end}${loadingNote}`;
      } else {
        const erpOnly = items.filter(item => item.source === 'erp').length;
        const sortNote = currentSortMode() === 'planning' ? '' : ' | sorted';
        const refreshed = state.lastRefreshedAt
          ? ` | refreshed ${new Date(state.lastRefreshedAt).toLocaleTimeString()}`
          : '';
        els.queueHint.textContent = `${start + 1}-${end} shown from ${sortedItems.length} matched | ${state.items.length} loaded${erpOnly ? ` (${erpOnly} ERP-only)` : ''}${sortNote}${refreshed}${loadingNote}`;
      }
    }

    const sortMode = currentSortMode();
    const sortByDue = sortsByPoDue();
    let queueHtml;
    if (sortByDue) {
      const dueTitle = sortMode === 'due_asc'
        ? 'Open · PO due (overdue first, then soonest)'
        : 'Open · PO due (latest)';
      queueHtml = [
        renderQueueGroup(dueTitle, pageItems),
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

  function materialInventoryLabel(item) {
    const codes = Array.isArray(item?.material_inventory_codes)
      ? item.material_inventory_codes.map(code => compactText(code)).filter(Boolean)
      : [];
    if (!codes.length && compactText(item?.material_inventory_code)) {
      codes.push(compactText(item.material_inventory_code));
    }
    return codes.join(', ');
  }

  function renderMaterialCodes(item) {
    const label = materialInventoryLabel(item);
    if (!label) return '';
    return `
      <div class="ps-row-route ps-row-material">
        <span>Material</span>
        <div class="ps-copy-line">
          <strong>${escapeHtml(label)}</strong>
          ${renderCopyBtn(label, 'material inventory code')}
        </div>
      </div>
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
    const rejectBadge = renderRejectQtyBadge(item);
    const warningsPill = renderWarningsPill(warnings);
    const titleBadges = [tempBadge, partial, qtyBadge, rejectBadge, srBadge, warningsPill].filter(Boolean).join('\n              ');
    const currentStageStrip = renderCurrentStageStrip(item);
    const opStatusStrip = renderOpStatusStrip(ops, item);
    const partNo = compactText(item.part_no || item.part_name || item.inventory_code || '');
    const partDesc = compactText(item.part_desc || '');
    const descriptor = partDesc || 'No description';
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
            ${currentStageStrip}
            ${opStatusStrip}
          </button>
          <div class="ps-row-part">
            <div class="ps-copy-line">
              <strong>${escapeHtml(partNo || 'No part')}</strong>
              ${renderCopyBtn(partNo, 'part number')}
            </div>
            <div class="ps-copy-line">
              <span>${escapeHtml(descriptor)}</span>
              ${renderCopyBtn(partDesc, 'part name')}
            </div>
            ${renderMaterialCodes(item)}
          </div>
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
      .filter(op => op && normalizeStatus(opDisplayExecutionStatus(op, item)));
    if (!visibleOps.length) return '';

    const maxVisible = 6;
    const chips = visibleOps.slice(0, maxVisible).map(op => {
      const opNo = op.op_no || op.source_op_no || op.stage_no || op.operation_label || '-';
      const opName = op.op_type || op.operation_name || op.stage_desc || '';
      const status = opDisplayExecutionStatus(op, item);
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
        <div class="ps-copy-line">
          <strong>${escapeHtml(route)}</strong>
          ${route && route !== 'No flow selected' ? renderCopyBtn(route, 'BOM code') : ''}
        </div>
      </div>
      ${renderDetailsMeta(summary, item, ops)}
      ${renderMaterialCodes(summary) || renderMaterialCodes(item)}
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
                  || compactText(op.preferred_machine)
                  || '-'
                )}</td>
                <td>${renderOpStatusCell(op, summary)}</td>
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
    if (window.location.hash === '#rejects') {
      return 'rejects';
    }
    return 'queue';
  }

  function setPsView(view) {
    state.psView = view || 'queue';
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
    const hash = view === 'rejects' ? '#rejects' : (view === 'temp' ? '#temp' : '');
    const path = `/process-sheets${hash}`;
    if (`${window.location.pathname}${window.location.hash}` !== path && window.location.pathname !== '/temp-process-sheets') {
      history.replaceState(null, '', path);
    }
    if (isTemp) {
      loadTempTracker();
      return;
    }
    state.page = 1;
    render();
  }

  function filteredTempItems() {
    const needle = String(els.tempSearch?.value || '').trim().toLowerCase();
    const queueFilter = String(els.tempQueueFilter?.value || '').trim().toLowerCase();
    const hideResolved = els.tempHideResolved?.checked !== false;
    return tempState.items.filter(item => {
      if (hideResolved && item.is_resolved) return false;
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
        item.current_stage_desc,
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
              <th>PO due</th>
              <th>Route</th>
              <th>Stage</th>
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

  function tempPlannerQueueLabel(item) {
    if (item.is_resolved) return 'Resolved';
    if (item.is_queued) {
      return `On planner${item.queued_machines?.length ? `: ${item.queued_machines.join(', ')}` : ''}`;
    }
    return 'Needs scheduling';
  }

  function renderTempStageDropdown(item) {
    const psId = item.planner_ps_id || '';
    const stages = Array.isArray(item.bom_stages) ? item.bom_stages : [];
    const currentId = Number(item.current_stage_seq_no || item.current_stage_op_seq_id || 0);
    const disabled = item.is_resolved ? ' disabled' : '';
    const options = [
      '<option value="">— Not set —</option>',
      ...stages.map(stage => {
        const stageId = Number(stage.stage_no || stage.op_seq_id || 0);
        const selected = stageId > 0 && stageId === currentId ? ' selected' : '';
        const label = stage.label || stage.stage_desc || `Step ${stage.seq_no || ''}`;
        return `<option value="${escapeHtml(String(stageId))}"${selected}>${escapeHtml(label)}</option>`;
      }),
    ];
    if (!stages.length) {
      options.push('<option value="" disabled>No source PS stages</option>');
    }
    return `
      <select class="ps-temp-stage-select" data-ps-id="${escapeHtml(psId)}"${disabled}
        title="Current stage from the source process sheet (${escapeHtml(item.source_label || item.source_ps_id || '')})">
        ${options.join('')}
      </select>
    `;
  }

  function renderTempTrackerRow(item) {
    const psId = item.planner_ps_id || '';
    const queueClass = item.is_resolved ? 'is-resolved' : (item.is_queued ? 'is-queued' : 'is-needs');
    const queueLabel = tempPlannerQueueLabel(item);
    const created = item.created_at
      ? new Date(item.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
      : '—';
    const rejectQty = numberValue(item.reject_qty);
    const finishedQty = numberValue(item.finished_qty);
    const progressLabel = `${fmtQty(finishedQty)} / ${fmtQty(rejectQty)}`;
    const dueDate = fmtDate(item.due_date);
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
        <td class="ps-temp-due-cell">
          <span>${escapeHtml(dueDate)}</span>
        </td>
        <td>${escapeHtml(item.selected_bom_code || item.erp_bom_code || '—')}</td>
        <td class="ps-temp-stage-cell">
          ${renderTempStageDropdown(item)}
          <div class="ps-temp-tracker-sub ps-temp-planner-label">
            <span class="ps-planning-flag ${queueClass}" aria-hidden="true"></span>
            ${escapeHtml(queueLabel)}
          </div>
        </td>
        <td>${escapeHtml(created)}</td>
        <td class="ps-temp-tracker-actions">
          <button type="button" class="btn btn-light btn-sm"
            data-action="edit-temp-ps" data-ps-id="${escapeHtml(psId)}"
            title="Edit qty, due date, remarks, and part details">
            Edit
          </button>
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
        window.dispatchEvent(new CustomEvent('temp-ps-deleted', {
          detail: { planner_ps_id: canonical, ps_id: canonical },
        }));
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

  async function saveTempPsStage(psId, opSeqId) {
    const canonical = String(psId || '').trim();
    if (!canonical) return;
    const item = tempState.items.find(row => row.planner_ps_id === canonical);
    const previousSeq = item?.current_stage_seq_no ?? null;
    const previousOp = item?.current_stage_op_seq_id ?? null;
    const payload = {
      current_stage_op_seq_id: opSeqId ? Number(opSeqId) : null,
    };
    const urls = [
      `/api/temp-process-sheets/${encodeURIComponent(canonical)}`,
      `/api/trial/temp-process-sheets/${encodeURIComponent(canonical)}`,
    ];
    let lastError = null;
    for (const url of urls) {
      try {
        const data = await patchJson(url, payload);
        if (item) {
          item.current_stage_op_seq_id = data.current_stage_op_seq_id ?? null;
          item.current_stage_seq_no = data.current_stage_seq_no ?? null;
          item.current_stage_desc = data.current_stage_desc || '';
          item.current_stage_status = data.current_stage_status || '';
          if (Array.isArray(data.bom_stages) && data.bom_stages.length) {
            item.bom_stages = data.bom_stages;
          }
        }
        return;
      } catch (err) {
        lastError = err;
      }
    }
    if (item) {
      item.current_stage_op_seq_id = previousOp;
      item.current_stage_seq_no = previousSeq;
    }
    renderTempTracker();
    window.alert(lastError?.message || 'Could not update temp PS stage');
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
    els.tempHideResolved = $('ps-temp-hide-resolved');
    els.tempRefreshBtn = $('ps-temp-refresh-btn');
    els.tempCreateBtn = $('ps-temp-create-btn');
    els.bulkLookupInput = $('ps-bulk-lookup-input');
    els.bulkLookupBtn = $('ps-bulk-lookup-btn');
    els.bulkExportBtn = $('ps-bulk-export-btn');
    els.bulkIncludePricing = $('ps-bulk-include-pricing');

    document.querySelectorAll('.ps-view-tab').forEach(tab => {
      tab.addEventListener('click', () => setPsView(tab.dataset.psView || 'queue'));
    });
    els.tempSearch?.addEventListener('input', () => renderTempTracker());
    els.tempQueueFilter?.addEventListener('change', () => renderTempTracker());
    els.tempHideResolved?.addEventListener('change', () => renderTempTracker());
    els.tempRefreshBtn?.addEventListener('click', () => loadTempTracker());
    els.tempCreateBtn?.addEventListener('click', () => {
      if (typeof openTempProcessSheetModal === 'function') openTempProcessSheetModal();
    });
    els.tempTracker?.addEventListener('change', event => {
      const select = event.target.closest('.ps-temp-stage-select');
      if (!select) return;
      const psId = select.dataset.psId || '';
      const value = String(select.value || '').trim();
      saveTempPsStage(psId, value);
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
      const editBtn = event.target.closest('[data-action="edit-temp-ps"]');
      if (editBtn && typeof openTempPsEditModal === 'function') {
        event.preventDefault();
        const psId = editBtn.dataset.psId || '';
        const item = tempState.items.find(row => row.planner_ps_id === psId);
        if (item) {
          openTempPsEditModal(item, { onSaved: () => loadTempTracker() });
        }
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
    els.bulkExportBtn?.addEventListener('click', () => runBulkExport());
    els.bulkLookupInput?.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (event.shiftKey) {
        runBulkExport();
      } else {
        runBulkLookup();
      }
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
      const copyBtn = event.target.closest('[data-action="copy-text"]');
      if (copyBtn) {
        event.preventDefault();
        event.stopPropagation();
        copyTextFromButton(copyBtn);
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
    if (resolveInitialPsView() !== 'queue') setPsView(resolveInitialPsView());
    window.addEventListener('hashchange', () => {
      if (window.location.hash === '#temp') setPsView('temp');
      else if (window.location.hash === '#rejects') setPsView('rejects');
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

  window.addEventListener('temp-ps-updated', () => {
    loadTempTracker();
    setBusy(true);
    loadProcessSheets({ refresh: true }).finally(() => setBusy(false));
  });
})();
