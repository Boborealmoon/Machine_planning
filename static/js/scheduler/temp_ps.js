// Temp (reject) process sheet — clone BOM/ops from an ERP PS with manual qty.

let _tempPsSearchTimer = 0;
let _tempPsSearchSeq = 0;
let _tempPsSelected = null;
let _tempPsPreview = null;
let _tempPsDropdownItems = [];
let _tempPsDropdownIndex = -1;

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

function openTempProcessSheetModal() {
  _tempPsSelected = null;
  _tempPsPreview = null;
  _tempPsDropdownItems = [];
  openTrialForm(
    'Create temp process sheet',
    `
      <p class="trial-modal-hint">
        Search uses ERP cache (<code>pp_vouchers_cache</code>). After you create, the temp PS is
        <strong>saved permanently</strong> in Supabase (<code>SUPA_DB_URL</code>):
        <code>planner_process_sheet</code> (scheduling) plus
        <code>planner_temp_process_sheet</code> (reject qty, source PS, part, route snapshot).
      </p>
      <label class="trial-modal-field temp-ps-combobox">
        <span class="trial-modal-label">Process sheet</span>
        <div class="temp-ps-combobox-shell">
          <input id="temp-ps-search" class="trial-modal-input temp-ps-combobox-input" type="text"
            placeholder="Start typing PS no., part, description…"
            autocomplete="off" autocapitalize="off" spellcheck="false"
            role="combobox" aria-expanded="false" aria-controls="temp-ps-dropdown" aria-autocomplete="list">
          <div id="temp-ps-dropdown" class="temp-ps-dropdown" role="listbox" hidden></div>
        </div>
        <span id="temp-ps-search-status" class="temp-ps-search-status">Type to search ERP process sheets</span>
      </label>
      <div id="temp-ps-preview" class="temp-ps-preview" hidden></div>
      <label class="trial-modal-field">
        <span class="trial-modal-label">Reject / rework qty</span>
        <input id="temp-ps-qty" class="trial-modal-input" type="number" min="0" step="1"
          placeholder="e.g. 12">
      </label>
      <label class="trial-modal-field">
        <span class="trial-modal-label">Remarks (optional)</span>
        <input id="temp-ps-remarks" class="trial-modal-input" type="text"
          placeholder="Reason or note">
      </label>
    `,
    'Create temp PS',
    saveTempProcessSheet
  );
  setTimeout(() => {
    document.querySelector('.trial-modal-panel')?.classList.add('trial-modal-panel--temp-ps');
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
  if (!_tempPsSelected?.source_ps_id) {
    window.alert('Pick a process sheet from the dropdown list first (don’t only type the number).');
    return;
  }
  const qty = Number(document.getElementById('temp-ps-qty')?.value || 0);
  if (!Number.isFinite(qty) || qty <= 0) {
    window.alert('Enter a quantity greater than zero.');
    return;
  }
  const remarks = String(document.getElementById('temp-ps-remarks')?.value || '').trim();
  const saveBtn = document.getElementById('trial-save-btn');
  if (saveBtn) saveBtn.disabled = true;
  trialSetFormModalBusy('Creating temp PS…');
  const bodies = [
    '/api/temp-process-sheets',
    '/api/trial/temp-process-sheets',
  ];
  try {
    let result = null;
    let lastError = null;
    for (const url of bodies) {
      try {
        result = await POST(url, {
          source_ps_id: _tempPsSelected.source_ps_id,
          pp_partial_no: _tempPsSelected.pp_partial_no,
          qty,
          remarks,
        });
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!result) throw lastError || new Error('Could not create temp process sheet');
    closeModal();
    if (typeof trialToast === 'function') {
      trialToast(
        `Created ${result.display_ps_id || trialTempPsDisplayId(result.planner_ps_id)} · qty ${fmt(qty, 0)}`,
        'success'
      );
    }
    if (typeof loadTrial === 'function') {
      await loadTrial({ force: true });
      const search = document.getElementById('trial-catalog-search');
      const label = result.display_ps_id || result.planner_ps_id || '';
      if (search && label) {
        search.value = label;
        if (typeof renderTrialCatalog === 'function') renderTrialCatalog();
      }
    }
    window.dispatchEvent(new CustomEvent('temp-ps-created', { detail: result }));
  } catch (err) {
    window.alert(err.message || 'Could not create temp process sheet');
  } finally {
    trialClearFormModalBusy();
    if (saveBtn) saveBtn.disabled = false;
  }
}
