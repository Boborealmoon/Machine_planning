// Temp (reject) process sheet — clone BOM/ops from an ERP PS with manual qty.

let _tempPsSearchTimer = 0;
let _tempPsSearchSeq = 0;
let _tempPsSelected = null;
let _tempPsPreview = null;
let _tempPsDropdownItems = [];
let _tempPsDropdownIndex = -1;
let _tempPsPlaceholderMode = false;

function tempPsOnSchedulerPage() {
  if (document.getElementById('trial-catalog')) return true;
  const path = String(window.location.pathname || '').toLowerCase();
  return /\/(scheduler|machinist|trial|planner)(\/|$)/.test(path);
}

function tempPsNormalizeEntry(raw) {
  const psId = String(raw?.ps_id || raw?.source_ps_id || '').trim();
  const partial = Number(raw?.pp_partial_no || 1) || 1;
  return {
    source_ps_id: psId,
    pp_partial_no: partial,
    part_no: String(raw?.part_no || raw?.part_name || raw?.inventory_code || '').trim(),
    part_desc: String(raw?.part_desc || raw?.description || '').trim(),
    due_date: String(raw?.due_date || '').trim(),
    display_qty: Number(raw?.display_qty ?? raw?.partial_qty ?? raw?.total_qty ?? 0) || 0,
    bom_code: String(raw?.bom_code || raw?.erp_bom_code || '').trim(),
    match_source: String(raw?.match_source || 'pp_vouchers_cache').trim(),
  };
}

function tempPsSearchLocalBoard(needle) {
  if (typeof window.psBoardItemsForTempSearch !== 'function') return [];
  const n = String(needle || '').trim().toLowerCase();
  if (!n) return [];
  return window.psBoardItemsForTempSearch()
    .filter(item => {
      const psId = String(item.ps_id || '').toLowerCase();
      const hay = [
        psId,
        item.part_no,
        item.part_desc,
        item.bom_code,
      ].join(' ').toLowerCase();
      return psId.includes(n) || hay.includes(n);
    })
    .map(tempPsNormalizeEntry)
    .slice(0, 25);
}

async function tempPsFetchSearch(query) {
  const needle = String(query || '').trim();
  if (!needle) return [];

  const local = tempPsSearchLocalBoard(needle);
  if (local.length) return local;

  const urls = [
    `/api/pp-vouchers/with-ops?search=${encodeURIComponent(needle)}`,
    `/api/temp-process-sheets/search?q=${encodeURIComponent(needle)}&limit=20`,
    `/api/trial/temp-process-sheets/search?q=${encodeURIComponent(needle)}&limit=20`,
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const data = await (typeof GET === 'function' ? GET(url) : tempPsFetchJson(url));
      if (Array.isArray(data)) {
        const items = data.map(tempPsNormalizeEntry).filter(item => item.source_ps_id);
        if (items.length) return items;
      }
      const items = Array.isArray(data?.items) ? data.items : [];
      if (items.length) return items.map(tempPsNormalizeEntry).filter(item => item.source_ps_id);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return [];
}

async function tempPsFetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch (_) {
      // ignore parse errors
    }
    throw new Error(msg);
  }
  return res.json();
}

function tempPsCloseDropdown() {
  const list = document.getElementById('temp-ps-dropdown');
  if (list) {
    list.hidden = true;
    list.innerHTML = '';
  }
  _tempPsDropdownIndex = -1;
}

function tempPsRenderDropdown(items, message = '') {
  const list = document.getElementById('temp-ps-dropdown');
  if (!list) return;
  _tempPsDropdownItems = items;
  _tempPsDropdownIndex = items.length ? 0 : -1;
  if (!items.length) {
    list.hidden = false;
    list.innerHTML = `<div class="temp-ps-dropdown-empty">${escapeHtml(message || 'No process sheets match. Try Sync ERP if this PS is new.')}</div>`;
    return;
  }
  list.hidden = false;
  list.innerHTML = items.map((item, idx) => {
    const partialLabel = item.pp_partial_no > 1 ? ` · Partial ${item.pp_partial_no}` : '';
    const stagingNote = item.match_source === 'erp_staging'
      ? '<span class="temp-ps-dropdown-staging">ERP staging only — run Sync ERP for full details</span>'
      : '';
    return `
      <button type="button" class="temp-ps-dropdown-option${idx === _tempPsDropdownIndex ? ' is-active' : ''}"
        data-index="${idx}" role="option">
        <span class="temp-ps-dropdown-option-id">${escapeHtml(item.source_ps_id)}${escapeHtml(partialLabel)}</span>
        <span class="temp-ps-dropdown-option-meta">${escapeHtml(item.part_no || 'No part')} · Qty ${fmt(item.display_qty, 0)}</span>
        ${item.due_date ? `<span class="temp-ps-dropdown-option-due">Due ${escapeHtml(item.due_date)}</span>` : ''}
        ${stagingNote}
      </button>
    `;
  }).join('');
  list.querySelectorAll('.temp-ps-dropdown-option').forEach(btn => {
    btn.addEventListener('mousedown', event => {
      event.preventDefault();
      tempPsSelectIndex(Number(btn.dataset.index || 0));
    });
  });
}

function tempPsHighlightDropdown() {
  const list = document.getElementById('temp-ps-dropdown');
  if (!list) return;
  list.querySelectorAll('.temp-ps-dropdown-option').forEach((btn, idx) => {
    btn.classList.toggle('is-active', idx === _tempPsDropdownIndex);
  });
  const active = list.querySelector('.temp-ps-dropdown-option.is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function tempPsSelectIndex(index) {
  const item = _tempPsDropdownItems[index];
  if (!item) return;
  _tempPsSelected = {
    source_ps_id: item.source_ps_id,
    pp_partial_no: item.pp_partial_no,
  };
  const input = document.getElementById('temp-ps-search');
  if (input) input.value = item.source_ps_id;
  tempPsCloseDropdown();
  loadTempPsPreview(_tempPsSelected);
}

async function runTempPsSearch(query, options = {}) {
  const status = document.getElementById('temp-ps-search-status');
  const needle = String(query || '').trim();
  if (needle.length < 1) {
    tempPsCloseDropdown();
    if (status) status.textContent = 'Type a PS number, part, or description.';
    return;
  }
  const seq = ++_tempPsSearchSeq;
  if (status) status.textContent = 'Searching…';
  try {
    const items = await tempPsFetchSearch(needle);
    if (seq !== _tempPsSearchSeq) return;
    tempPsRenderDropdown(items);
    if (status) {
      const fromBoard = items.some(item => item.match_source === 'loaded_board');
      status.textContent = items.length
        ? `${items.length} match${items.length === 1 ? '' : 'es'}${fromBoard ? ' (from loaded queue)' : ''} — click to select`
        : 'No matches. Wait for the queue to finish loading, run Sync ERP, or check the PS number.';
    }
    const exact = items.filter(item => item.source_ps_id.toLowerCase() === needle.toLowerCase());
    if (options.autoSelect && exact.length === 1) {
      const idx = items.indexOf(exact[0]);
      if (idx >= 0) tempPsSelectIndex(idx);
    }
  } catch (err) {
    if (seq !== _tempPsSearchSeq) return;
    tempPsCloseDropdown();
    if (status) status.textContent = err.message || 'Search failed';
  }
}

function tempPsNormalizeReferenceLabel(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  if (/^\[Temp\]/i.test(text)) text = text.replace(/^\[Temp\]\s*/i, '').trim();
  return text;
}

function tempPsUpdateNamePreview() {
  const preview = document.getElementById('temp-ps-name-preview');
  const input = document.getElementById('temp-ps-reference');
  if (!preview) return;
  const ref = tempPsNormalizeReferenceLabel(input?.value || '');
  const label = ref
    ? (typeof trialTempPsDisplayId === 'function'
      ? trialTempPsDisplayId(`[Temp]${ref}`)
      : `[Temp] ${ref}`)
    : '[Temp] …';
  preview.innerHTML = `Will create <strong>${escapeHtml(label)}</strong>`;
}

function tempPsSetMode(mode) {
  const isPlaceholder = mode === 'placeholder';
  _tempPsPlaceholderMode = isPlaceholder;
  _tempPsSelected = null;
  _tempPsPreview = null;
  tempPsCloseDropdown();
  document.querySelectorAll('.temp-ps-mode-btn').forEach(btn => {
    const active = btn.dataset.tempPsMode === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const reworkPanel = document.getElementById('temp-ps-mode-rework');
  const placeholderPanel = document.getElementById('temp-ps-mode-placeholder');
  if (reworkPanel) reworkPanel.hidden = isPlaceholder;
  if (placeholderPanel) placeholderPanel.hidden = !isPlaceholder;
  const previewEl = document.getElementById('temp-ps-preview');
  if (previewEl) previewEl.hidden = true;
  if (isPlaceholder) tempPsUpdateNamePreview();
}

function openTempProcessSheetModal() {
  _tempPsSelected = null;
  _tempPsPreview = null;
  _tempPsDropdownItems = [];
  _tempPsPlaceholderMode = false;
  openTrialForm(
    'Create temp process sheet',
    `
      <div class="temp-ps-mode-switch" role="tablist" aria-label="Temp PS type">
        <button type="button" class="temp-ps-mode-btn is-active" data-temp-ps-mode="rework"
          role="tab" aria-selected="true">Rework from ERP PS</button>
        <button type="button" class="temp-ps-mode-btn" data-temp-ps-mode="placeholder"
          role="tab" aria-selected="false">Placeholder (no PS yet)</button>
      </div>

      <div id="temp-ps-mode-rework" class="temp-ps-mode-panel">
        <p class="temp-ps-mode-desc">Pick the source process sheet. Creates <strong>[Temp] NPS…</strong> and copies its route.</p>
        <label class="trial-modal-field temp-ps-combobox">
          <span class="trial-modal-label">Source process sheet</span>
          <div class="temp-ps-combobox-shell">
            <input id="temp-ps-search" class="trial-modal-input temp-ps-combobox-input" type="text"
              placeholder="Search PS no., part, description…"
              autocomplete="off" autocapitalize="off" spellcheck="false"
              role="combobox" aria-expanded="false" aria-controls="temp-ps-dropdown" aria-autocomplete="list">
            <div id="temp-ps-dropdown" class="temp-ps-dropdown" role="listbox" hidden></div>
          </div>
          <span id="temp-ps-search-status" class="temp-ps-search-status">Search ERP — click a result to select</span>
        </label>
        <div id="temp-ps-preview" class="temp-ps-preview" hidden></div>
      </div>

      <div id="temp-ps-mode-placeholder" class="temp-ps-mode-panel" hidden>
        <p class="temp-ps-mode-desc">Hold a lane with a <code>PLACEHOLDER</code> op until the real ERP PS exists.</p>
        <div id="temp-ps-name-preview" class="temp-ps-name-preview">Will create <strong>[Temp] …</strong></div>
        <label class="trial-modal-field">
          <span class="trial-modal-label">Process sheet no.</span>
          <input id="temp-ps-reference" class="trial-modal-input" type="text"
            placeholder="NPS25-0205" autocomplete="off">
        </label>
        <p class="temp-ps-field-hint">PS number only — not the part code.</p>
        <label class="trial-modal-field">
          <span class="trial-modal-label">Part number</span>
          <input id="temp-ps-part-no" class="trial-modal-input" type="text"
            placeholder="BB18-KS1712-02 REV 04" autocomplete="off">
        </label>
        <label class="trial-modal-field">
          <span class="trial-modal-label">Description</span>
          <input id="temp-ps-part-desc" class="trial-modal-input" type="text"
            placeholder="Optional" autocomplete="off">
        </label>
      </div>

      <div class="temp-ps-shared-fields">
        <label class="trial-modal-field">
          <span class="trial-modal-label">PO due date</span>
          <input id="temp-ps-due-date" class="trial-modal-input" type="date">
        </label>
        <label class="trial-modal-field">
          <span class="trial-modal-label">Qty</span>
          <input id="temp-ps-qty" class="trial-modal-input" type="number" min="0" step="1"
            placeholder="e.g. 12">
        </label>
        <label class="trial-modal-field">
          <span class="trial-modal-label">Remarks</span>
          <input id="temp-ps-remarks" class="trial-modal-input" type="text"
            placeholder="Optional" autocomplete="off">
        </label>
      </div>
    `,
    'Create temp PS',
    saveTempProcessSheet
  );
  setTimeout(() => {
    document.querySelector('.trial-modal-panel')?.classList.add('trial-modal-panel--temp-ps');
    document.querySelectorAll('.temp-ps-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => tempPsSetMode(btn.dataset.tempPsMode || 'rework'));
    });
    document.getElementById('temp-ps-reference')?.addEventListener('input', tempPsUpdateNamePreview);
    tempPsSetMode('rework');
    const input = document.getElementById('temp-ps-search');
    const shell = input?.closest('.temp-ps-combobox-shell');
    input?.addEventListener('input', () => {
      _tempPsSelected = null;
      _tempPsPreview = null;
      const previewEl = document.getElementById('temp-ps-preview');
      if (previewEl) previewEl.hidden = true;
      window.clearTimeout(_tempPsSearchTimer);
      _tempPsSearchTimer = window.setTimeout(() => runTempPsSearch(input.value), 180);
      input.setAttribute('aria-expanded', 'true');
    });
    input?.addEventListener('focus', () => {
      if (String(input.value || '').trim().length >= 2) runTempPsSearch(input.value);
    });
    input?.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (_tempPsDropdownItems.length) {
          _tempPsDropdownIndex = Math.min(_tempPsDropdownItems.length - 1, _tempPsDropdownIndex + 1);
          tempPsHighlightDropdown();
        } else {
          runTempPsSearch(input.value);
        }
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (_tempPsDropdownItems.length) {
          _tempPsDropdownIndex = Math.max(0, _tempPsDropdownIndex - 1);
          tempPsHighlightDropdown();
        }
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (_tempPsDropdownIndex >= 0 && _tempPsDropdownItems[_tempPsDropdownIndex]) {
          tempPsSelectIndex(_tempPsDropdownIndex);
        } else {
          runTempPsSearch(input.value, { autoSelect: true });
        }
        return;
      }
      if (event.key === 'Escape') {
        tempPsCloseDropdown();
        input.setAttribute('aria-expanded', 'false');
      }
    });
    input?.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (!shell?.contains(document.activeElement)) {
          tempPsCloseDropdown();
          input?.setAttribute('aria-expanded', 'false');
        }
      }, 120);
    });
    document.addEventListener('click', event => {
      if (!shell?.contains(event.target)) tempPsCloseDropdown();
    }, { once: false });
    input?.focus();
  }, 0);
}

async function loadTempPsPreview(selection) {
  const previewEl = document.getElementById('temp-ps-preview');
  const status = document.getElementById('temp-ps-search-status');
  if (!previewEl || !selection?.source_ps_id) return;
  previewEl.hidden = false;
  previewEl.innerHTML = '<div class="temp-ps-search-loading">Loading details…</div>';
  if (status) status.textContent = `Loading ${selection.source_ps_id}…`;
  const urls = [
    `/api/temp-process-sheets/source?${new URLSearchParams({
      source_ps_id: selection.source_ps_id,
      pp_partial_no: String(selection.pp_partial_no || 1),
    })}`,
    `/api/trial/temp-process-sheets/source?${new URLSearchParams({
      source_ps_id: selection.source_ps_id,
      pp_partial_no: String(selection.pp_partial_no || 1),
    })}`,
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const data = typeof GET === 'function' ? await GET(url) : await tempPsFetchJson(url);
      _tempPsPreview = data;
      const ops = Array.isArray(data.ops_preview) ? data.ops_preview : [];
      const opsHtml = ops.length
        ? `<ul class="temp-ps-preview-ops">${ops.map(op => `<li>${escapeHtml(op.label || '')}</li>`).join('')}</ul>`
        : '<div class="temp-ps-preview-muted">No BOM route found — assign a flow on Process Sheets first.</div>';
      previewEl.innerHTML = `
        <div class="temp-ps-preview-card">
          <div class="temp-ps-preview-head">
            <span class="temp-ps-preview-label">Will create</span>
            <strong class="temp-ps-preview-temp-id">${escapeHtml(data.temp_name_preview || trialTempPsDisplayId(`[Temp]${data.source_ps_id}`))}</strong>
          </div>
          <div class="temp-ps-preview-grid">
            <span>Source PS</span><span>${escapeHtml(data.source_ps_id || '')}${Number(data.pp_partial_no) > 1 ? ` (partial ${data.pp_partial_no})` : ''}</span>
            <span>Part</span><span>${escapeHtml(data.part_no || '—')}</span>
            <span>Description</span><span>${escapeHtml(data.part_desc || '—')}</span>
            <span>ERP qty</span><span>${fmt(Number(data.display_qty || 0), 0)}</span>
            <span>Route</span><span>${escapeHtml(data.selected_bom_code || data.erp_bom_code || '—')}</span>
            <span>Due</span><span>${escapeHtml(data.due_date || '—')}</span>
          </div>
          <div class="temp-ps-preview-route">
            <span class="temp-ps-preview-label">Operations (from source)</span>
            ${opsHtml}
          </div>
        </div>
      `;
      const qtyInput = document.getElementById('temp-ps-qty');
      if (qtyInput && !String(qtyInput.value || '').trim()) {
        qtyInput.placeholder = `e.g. reject qty (ERP ${fmt(Number(data.display_qty || 0), 0)})`;
      }
      if (status) status.textContent = `Selected ${data.source_ps_id} — enter reject qty below`;
      const dueInput = document.getElementById('temp-ps-due-date');
      if (dueInput && !String(dueInput.value || '').trim() && data.due_date) {
        dueInput.value = String(data.due_date).trim().slice(0, 10);
      }
      return;
    } catch (err) {
      lastError = err;
    }
  }
  previewEl.innerHTML = `<div class="temp-ps-search-empty">${escapeHtml(lastError?.message || 'Could not load details')}</div>`;
  _tempPsPreview = null;
  if (status) status.textContent = lastError?.message || 'Could not load details';
}

async function saveTempProcessSheet() {
  const placeholderMode = _tempPsPlaceholderMode
    || !document.getElementById('temp-ps-mode-placeholder')?.hidden;
  if (!placeholderMode && !_tempPsSelected?.source_ps_id) {
    window.alert('Pick a process sheet from the dropdown list first (don’t only type the number).');
    return;
  }
  const qty = Number(document.getElementById('temp-ps-qty')?.value || 0);
  if (!Number.isFinite(qty) || qty <= 0) {
    window.alert('Enter a quantity greater than zero.');
    return;
  }
  const remarks = String(document.getElementById('temp-ps-remarks')?.value || '').trim();
  const dueDate = String(document.getElementById('temp-ps-due-date')?.value || '').trim().slice(0, 10);
  const partNo = String(document.getElementById('temp-ps-part-no')?.value || '').trim();
  const partDesc = String(document.getElementById('temp-ps-part-desc')?.value || '').trim();
  const referenceLabel = tempPsNormalizeReferenceLabel(
    document.getElementById('temp-ps-reference')?.value || ''
  );
  if (placeholderMode && !referenceLabel) {
    window.alert('Enter the process sheet number (e.g. NPS25-0205).');
    return;
  }
  if (placeholderMode && !partNo) {
    window.alert('Enter the part / inventory code for this placeholder temp PS.');
    return;
  }
  const saveBtn = document.getElementById('trial-save-btn');
  if (saveBtn) saveBtn.disabled = true;
  trialSetFormModalBusy('Creating temp PS…');
  const bodies = [
    '/api/temp-process-sheets',
    '/api/trial/temp-process-sheets',
  ];
  const payload = placeholderMode
    ? {
        mode: 'placeholder',
        placeholder: true,
        reference_ps_id: referenceLabel,
        part_no: partNo,
        part_desc: partDesc,
        qty,
        remarks,
        due_date: dueDate,
      }
    : {
        source_ps_id: _tempPsSelected.source_ps_id,
        pp_partial_no: _tempPsSelected.pp_partial_no,
        qty,
        remarks,
        due_date: dueDate,
      };
  try {
    let result = null;
    let lastError = null;
    for (const url of bodies) {
      try {
        result = await POST(url, payload);
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!result) throw lastError || new Error('Could not create temp process sheet');
    closeModal();
    window.dispatchEvent(new CustomEvent('temp-ps-created', { detail: result }));
    if (typeof trialToast === 'function') {
      trialToast(
        `Created ${result.display_ps_id || trialTempPsDisplayId(result.planner_ps_id)} · qty ${fmt(qty, 0)}`,
        'success'
      );
    }
  } catch (err) {
    window.alert(err.message || 'Could not create temp process sheet');
  } finally {
    trialClearFormModalBusy();
    if (saveBtn) saveBtn.disabled = false;
  }
}

function tempPsDateInputValue(raw) {
  const text = String(raw || '').trim();
  return text.length >= 10 ? text.slice(0, 10) : '';
}

async function patchTempProcessSheet(psId, updates, { onSuccess } = {}) {
  const canonical = String(psId || '').trim();
  if (!canonical) throw new Error('Temp PS id is required');
  const body = { ...(updates || {}) };
  if (!Object.keys(body).length) throw new Error('No fields to update');
  const urls = [
    `/api/temp-process-sheets/${encodeURIComponent(canonical)}`,
    `/api/trial/temp-process-sheets/${encodeURIComponent(canonical)}`,
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (typeof onSuccess === 'function') await onSuccess(data);
      return data;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Could not update temp process sheet');
}

async function patchTempPsPoDue(psId, dueDate, { onSuccess } = {}) {
  return patchTempProcessSheet(psId, {
    due_date: String(dueDate || '').trim().slice(0, 10),
  }, { onSuccess });
}

function tempPsIsPlaceholderItem(item) {
  if (!item) return false;
  if (item.is_placeholder) return true;
  const route = String(item.selected_bom_code || item.erp_bom_code || '').trim().toUpperCase();
  const source = String(item.source_ps_id || item.source_label || '').trim().toUpperCase();
  return route === 'PLACEHOLDER' || source === 'PLACEHOLDER';
}

function openTempPsEditModal(item, options = {}) {
  const psId = String(item?.planner_ps_id || item?.ps_id || '').trim();
  if (!psId || typeof openTrialForm !== 'function') return;
  const label = typeof trialTempPsDisplayId === 'function'
    ? trialTempPsDisplayId(psId)
    : (item?.display_ps_id || psId);
  const isPlaceholder = tempPsIsPlaceholderItem(item);
  const finishedQty = Math.max(0, Number(item?.finished_qty || 0));
  const rejectQty = Math.max(0, Number(item?.reject_qty ?? item?.planned_qty ?? 0));
  const sourceLabel = String(item?.source_label || item?.source_ps_id || '').trim();
  openTrialForm(`Edit temp PS · ${label}`, `
    <p class="trial-modal-hint">Update source PS label, reject qty, due date, remarks, and part details for this temp process sheet.</p>
    <div class="trial-actual-summary">
      <div><span class="field-hint">Finished</span><strong>${escapeHtml(fmt(finishedQty, 0))}</strong></div>
    </div>
    <label class="trial-modal-field">
      <span class="trial-modal-label">Source PS no.</span>
      <input id="temp-ps-edit-source" class="trial-modal-input" type="text"
        placeholder="e.g. NPS26-0006 or NPS26-0006::2"
        value="${escapeHtml(sourceLabel)}" autocomplete="off">
    </label>
    <p class="temp-ps-field-hint">Display label only — use <code>::2</code> suffix for partial no.</p>
    <label class="trial-modal-field">
      <span class="trial-modal-label">Reject qty</span>
      <input id="temp-ps-edit-qty" class="trial-modal-input" type="number" min="${finishedQty > 0 ? finishedQty : 1}" step="1"
        value="${Number.isFinite(rejectQty) ? rejectQty : 0}">
    </label>
    <label class="trial-modal-field">
      <span class="trial-modal-label">PO due date</span>
      <input id="temp-ps-edit-due-date" class="trial-modal-input" type="date"
        value="${escapeHtml(tempPsDateInputValue(item?.due_date))}">
    </label>
    <button type="button" class="btn btn-ghost btn-sm" id="temp-ps-edit-clear-due-date">Clear due date</button>
    <label class="trial-modal-field">
      <span class="trial-modal-label">Part number${isPlaceholder ? '' : ' <span class="field-hint">(from source PS)</span>'}</span>
      <input id="temp-ps-edit-part-no" class="trial-modal-input" type="text"
        value="${escapeHtml(String(item?.part_no || ''))}" ${isPlaceholder ? '' : 'readonly'}>
    </label>
    <label class="trial-modal-field">
      <span class="trial-modal-label">Description</span>
      <input id="temp-ps-edit-part-desc" class="trial-modal-input" type="text"
        value="${escapeHtml(String(item?.part_desc || ''))}" autocomplete="off">
    </label>
    <label class="trial-modal-field">
      <span class="trial-modal-label">Remarks</span>
      <input id="temp-ps-edit-remarks" class="trial-modal-input" type="text"
        value="${escapeHtml(String(item?.remarks || ''))}" autocomplete="off">
    </label>
  `, 'Save', async () => {
    const qty = Math.max(0, Number(document.getElementById('temp-ps-edit-qty')?.value || 0));
    if (!Number.isFinite(qty) || qty <= 0) {
      window.alert('Enter a quantity greater than zero.');
      return;
    }
    if (qty + 1e-9 < finishedQty) {
      window.alert(`Quantity cannot be less than finished qty (${fmt(finishedQty, 0)}).`);
      return;
    }
    const sourcePs = String(document.getElementById('temp-ps-edit-source')?.value || '').trim();
    const dueDate = String(document.getElementById('temp-ps-edit-due-date')?.value || '').trim().slice(0, 10);
    const partNo = String(document.getElementById('temp-ps-edit-part-no')?.value || '').trim();
    const partDesc = String(document.getElementById('temp-ps-edit-part-desc')?.value || '').trim();
    const remarks = String(document.getElementById('temp-ps-edit-remarks')?.value || '').trim();
    if (!sourcePs) {
      window.alert('Enter a source PS number.');
      return;
    }
    if (isPlaceholder && !partNo) {
      window.alert('Part number is required for placeholder temp PS.');
      return;
    }
    const updates = {
      source_ps_id: sourcePs,
      qty,
      due_date: dueDate,
      part_desc: partDesc,
      remarks,
    };
    if (isPlaceholder) updates.part_no = partNo;
    trialSetFormModalBusy('Saving temp PS…');
    try {
      await patchTempProcessSheet(psId, updates, {
        onSuccess: async () => {
          closeModal();
          if (typeof trialToast === 'function') {
            trialToast(`Updated ${label}`, 'success');
          }
          if (typeof options.onSaved === 'function') {
            await options.onSaved();
          }
          window.dispatchEvent(new CustomEvent('temp-ps-updated', { detail: { ps_id: psId, ...updates } }));
        },
      });
    } catch (err) {
      window.alert(err.message || 'Could not save temp process sheet');
    } finally {
      trialClearFormModalBusy();
    }
  });
  setTimeout(() => {
    document.getElementById('temp-ps-edit-clear-due-date')?.addEventListener('click', () => {
      const input = document.getElementById('temp-ps-edit-due-date');
      if (input) input.value = '';
    });
    document.getElementById('temp-ps-edit-qty')?.focus();
  }, 0);
}

function openTempPsPoDueModal(psId, currentDue, options = {}) {
  const label = typeof trialTempPsDisplayId === 'function'
    ? trialTempPsDisplayId(psId)
    : psId;
  const defaultValue = tempPsDateInputValue(currentDue);
  openTrialForm(`PO due · ${label}`, `
    <p class="trial-modal-hint">Customer PO due date for this temp process sheet. Shown as Due on machine queues and the planner catalog.</p>
    <label class="trial-modal-field">
      <span class="trial-modal-label">PO due date</span>
      <input id="temp-ps-edit-due-date" class="trial-modal-input" type="date" value="${escapeHtml(defaultValue)}">
    </label>
    <button type="button" class="btn btn-ghost btn-sm" id="temp-ps-clear-due-date">Clear due date</button>
  `, 'Save', async () => {
    const dueDate = String(document.getElementById('temp-ps-edit-due-date')?.value || '').trim();
    trialSetFormModalBusy('Saving PO due…');
    try {
      await patchTempPsPoDue(psId, dueDate, {
        onSuccess: async () => {
          closeModal();
          if (typeof trialToast === 'function') {
            trialToast(dueDate ? `PO due set to ${dueDate}` : 'PO due cleared', 'success');
          }
          if (typeof options.onSaved === 'function') {
            await options.onSaved(dueDate);
          }
          window.dispatchEvent(new CustomEvent('temp-ps-updated', { detail: { ps_id: psId, due_date: dueDate } }));
        },
      });
    } catch (err) {
      window.alert(err.message || 'Could not save PO due date');
    } finally {
      trialClearFormModalBusy();
    }
  });
  setTimeout(() => {
    document.getElementById('temp-ps-clear-due-date')?.addEventListener('click', () => {
      const input = document.getElementById('temp-ps-edit-due-date');
      if (input) input.value = '';
    });
    document.getElementById('temp-ps-edit-due-date')?.focus();
  }, 0);
}
