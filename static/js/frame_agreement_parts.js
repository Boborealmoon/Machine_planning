(function frameAgreementPartsInit() {
  'use strict';

  const state = {
    rows: [],
    search: '',
    loading: false,
    saving: new Set(),
    opsCache: {},
    opsLoading: new Set(),
    partSearch: {
      query: '',
      hits: [],
      open: false,
      activeIndex: -1,
      loading: false,
    },
    pendingPart: null,
    pendingPreview: null,
    selectedBomByPart: {},
    confirmModal: { partNo: '', selectedBom: '' },
    materialModal: { partNo: '', bomCodes: [], selectedBom: '' },
    stepsModal: { partNo: '', bomCodes: [], selectedBom: '' },
    mppModal: { partNo: '', bomCodes: [], selectedBom: '' },
  };

  const FA_MPP_MACHINES = ['CNC 35', 'CNC 36', 'CNC 41'];

  function inferFaMppMachine(description, notes) {
    const blob = `${description || ''} ${notes || ''}`.toUpperCase();
    if (blob.includes('END CAP')) return 'CNC 35';
    if (blob.includes('VALVE BODY')) return 'CNC 36';
    for (const code of FA_MPP_MACHINES) {
      if (blob.includes(code.toUpperCase())) return code;
    }
    return '';
  }

  function faMppMachineOptions(selected) {
    const sel = String(selected || '');
    return ['<option value="">—</option>']
      .concat(FA_MPP_MACHINES.map((code) => (
        `<option value="${escapeHtml(code)}"${sel === code ? ' selected' : ''}>${escapeHtml(code)}</option>`
      )))
      .join('');
  }

  function faMppNumValue(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return '';
    return String(num);
  }

  function faMppIntValue(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return '';
    return String(Math.round(num));
  }

  function faOpsCacheKey(partNo, bomCode) {
    return `${String(partNo || '').trim()}::${String(bomCode || '').trim()}`;
  }

  function faOpNoLabel(op) {
    const raw = op?.op_no ?? op?.opNo;
    if (raw === 0) return '0';
    const text = String(raw ?? '').trim();
    return text || '—';
  }

  function faOpProcessLabel(op) {
    const full = String(op?.stage_desc || '').trim();
    if (!full) return '';
    const stripped = full.replace(/^(Turning|Milling|Turnmill)\s+(?:OP)?\d+\s*/i, '').trim();
    return stripped || full;
  }

  function faSortOps(ops) {
    return [...ops].sort((a, b) => {
      const aNum = Number.parseInt(String(a?.op_no ?? ''), 10);
      const bNum = Number.parseInt(String(b?.op_no ?? ''), 10);
      const aOk = Number.isFinite(aNum);
      const bOk = Number.isFinite(bNum);
      if (aOk && bOk && aNum !== bNum) return aNum - bNum;
      if (aOk !== bOk) return aOk ? -1 : 1;
      return Number(a?.stage_no || 0) - Number(b?.stage_no || 0);
    });
  }

  function faDerivedRunMinPerPallet(cyclePc, pcs, runPal) {
    const run = Number(runPal);
    if (Number.isFinite(run) && run > 0) return run;
    const cycle = Number(cyclePc);
    const pieces = Number(pcs);
    if (Number.isFinite(cycle) && cycle > 0 && Number.isFinite(pieces) && pieces > 0) {
      return cycle * pieces;
    }
    return 0;
  }

  function faFormatCalcPal(cyclePc, pcs, runPal) {
    const val = faDerivedRunMinPerPallet(cyclePc, pcs, runPal);
    if (!Number.isFinite(val) || val <= 0) return '—';
    return Number.isInteger(val) ? String(val) : val.toFixed(2).replace(/\.?0+$/, '');
  }

  function faLineSaveKey(partNo, bomCode, opNo) {
    return `${partNo}::${bomCode}::${opNo}`;
  }

  async function faEnsureOpsLoaded(partNo, bomCode, row) {
    const part = String(partNo || '').trim();
    const bom = String(bomCode || '').trim();
    if (!part || !bom) return [];
    const key = faOpsCacheKey(part, bom);
    if (Array.isArray(state.opsCache[key])) return state.opsCache[key];
    if (state.opsLoading.has(key)) return [];
    state.opsLoading.add(key);
    try {
      const params = new URLSearchParams({ action: 'operations', part_no: part, bom });
      const res = await fetch(`/api/planning-data/frame-agreement-parts?${params}`);
      const payload = await parseJsonResponse(res);
      if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      const items = faSortOps(
        (Array.isArray(payload.rows) ? payload.rows : [])
          .filter((op) => String(op?.op_no ?? '').trim())
      );
      state.opsCache[key] = items;
      return items;
    } catch (err) {
      state.opsCache[key] = [];
      if (row) row.ops_error = err.message;
      return [];
    } finally {
      state.opsLoading.delete(key);
      if (document.getElementById('fa-mpp-modal')?.hidden === false) {
        faRenderMppModalBody();
      }
    }
  }

  function faConfiguredOpCount(row, bomCode) {
    const bom = String(bomCode || '').trim();
    const configs = row?.op_configs?.[bom];
    if (!configs || typeof configs !== 'object') return 0;
    return Object.keys(configs).length;
  }

  function faMppConfigBtnLabel(row, bomCode) {
    const count = faConfiguredOpCount(row, bomCode);
    return count > 0 ? `MPP config (${count})` : 'MPP config';
  }

  function readFaOpRowSettings(partNo, bomCode, opNo) {
    const root = document.getElementById('fa-mpp-modal');
    const part = String(partNo || '').trim();
    const bom = String(bomCode || '').trim();
    const op = String(opNo || '').trim();
    const sel = (cls) => (root || document).querySelector(
      `${cls}[data-part-no="${CSS.escape(part)}"][data-bom-code="${CSS.escape(bom)}"][data-op-no="${CSS.escape(op)}"]`
    );
    const cycle = sel('.fa-op-cycle-input');
    const pcs = sel('.fa-op-pcs-input');
    const run = sel('.fa-op-run-input');
    const pallets = sel('.fa-op-pallets-input');
    const machine = sel('.fa-op-machine-select');
    const setup = sel('.fa-op-setup-input');
    const process = sel('.fa-op-process-input');
    return {
      bom_code: bom,
      op_no: op,
      cycle_min_per_piece: Number(cycle?.value || 0),
      pcs_per_pallet: Number(pcs?.value || 0),
      run_min_per_pallet: Number(run?.value || 0),
      pallets_count: Number(pallets?.value || 0),
      mpp_machine_no: String(machine?.value || '').trim(),
      setup_minutes: Number(setup?.value || 0),
      stage_desc: String(process?.value || '').trim(),
    };
  }

  function readFaPartNotes(partNo) {
    const notes = document.querySelector(`.fa-notes-input[data-part-no="${CSS.escape(partNo)}"]`);
    return String(notes?.value || '').trim();
  }

  function escapeHtml(raw) {
    return String(raw ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatUpdated(value) {
    if (!value) return '—';
    const text = String(value).trim();
    if (!text) return '—';
    return text.length > 16 ? text.slice(0, 16) : text;
  }

  function setAddStatus(message, kind) {
    const el = document.getElementById('fa-add-status');
    if (!el) return;
    el.textContent = message || '';
    el.className = 'fa-toolbar-status';
    if (kind) el.classList.add(`is-${kind}`);
  }

  async function parseJsonResponse(res) {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_err) {
      const snippet = text.trim().slice(0, 120);
      const html = snippet.toLowerCase().startsWith('<!doctype') || snippet.toLowerCase().startsWith('<html');
      const hint = html
        ? 'Server returned an HTML page instead of JSON — restart the app server and hard-refresh the page.'
        : snippet;
      throw new Error(`Invalid server response (${res.status}): ${hint}`);
    }
  }

  function faBomCodesForRow(row) {
    const fromList = Array.isArray(row?.bom_codes)
      ? row.bom_codes.map((c) => String(c || '').trim()).filter(Boolean)
      : [];
    if (fromList.length) return fromList;
    const single = String(row?.bom_code || '').trim();
    return single ? [single] : [];
  }

  function faSelectedBom(partNo, row) {
    const stored = String(state.selectedBomByPart[partNo] || '').trim();
    if (stored) return stored;
    const codes = faBomCodesForRow(row);
    const fromRow = String(row?.bom_code || '').trim();
    if (fromRow) return fromRow;
    return codes[0] || '';
  }

  function faBomVariant(row, bomCode) {
    const code = String(bomCode || '').trim();
    const variants = Array.isArray(row?.bom_variants) ? row.bom_variants : [];
    const hit = variants.find((v) => String(v?.bom_code || '').trim() === code);
    if (hit) return hit;
    if (String(row?.bom_code || '').trim() === code) {
      return {
        bom_code: code,
        primary_material: row.primary_material,
        primary_material_desc: row.primary_material_desc,
        qty_per_fg: row.qty_per_fg,
      };
    }
    return null;
  }

  function faRowMaterialFields(row, bomCode) {
    const variant = faBomVariant(row, bomCode);
    if (variant) {
      return {
        material: String(variant.primary_material || '—'),
        materialDesc: String(variant.primary_material_desc || variant.primary_material || '—'),
        qtyFg: String(variant.qty_per_fg || '—'),
      };
    }
    return {
      material: String(row?.primary_material || '—'),
      materialDesc: String(row?.primary_material_desc || row?.primary_material || '—'),
      qtyFg: String(row?.qty_per_fg || '—'),
    };
  }

  function faRenderBomToggle({ partNo, bomCodes, selectedBom, context }) {
    const codes = (bomCodes || []).map((c) => String(c || '').trim()).filter(Boolean);
    const active = String(selectedBom || '').trim() || codes[0] || '';
    if (!codes.length) return '<span class="fa-dash">—</span>';
    if (codes.length === 1) {
      return `<span class="new-orders-mono fa-bom-single" title="${escapeHtml(codes[0])}">${escapeHtml(codes[0])}</span>`;
    }
    return `
      <div class="fa-bom-tabs" role="tablist" aria-label="BOM routes for ${escapeHtml(partNo)}">
        ${codes.map((code) => {
          const isActive = code === active;
          return `
            <button type="button"
              class="fa-bom-tab${isActive ? ' fa-bom-tab--active' : ''}"
              role="tab"
              aria-selected="${isActive ? 'true' : 'false'}"
              data-action="select-bom"
              data-context="${escapeHtml(context)}"
              data-part-no="${escapeHtml(partNo)}"
              data-bom-code="${escapeHtml(code)}"
              title="Show ${escapeHtml(code)}">${escapeHtml(code)}</button>
          `;
        }).join('')}
      </div>
    `;
  }

  function faRenderBomTabsBar(hostId, { partNo, bomCodes, selectedBom, context }) {
    const host = document.getElementById(hostId);
    if (!host) return;
    const codes = (bomCodes || []).map((c) => String(c || '').trim()).filter(Boolean);
    if (codes.length <= 1) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    host.hidden = false;
    host.innerHTML = `
      <div class="fa-bom-tabs-bar">
        <span class="fa-bom-tabs-label">BOM route</span>
        ${faRenderBomToggle({ partNo, bomCodes: codes, selectedBom, context })}
      </div>
    `;
  }

  function faSetSelectedBom(partNo, bomCode, { rerender = true } = {}) {
    const part = String(partNo || '').trim();
    const bom = String(bomCode || '').trim();
    if (!part || !bom) return;
    state.selectedBomByPart[part] = bom;
    const idx = state.rows.findIndex((r) => r.part_no === part);
    if (idx >= 0) {
      const fields = faRowMaterialFields(state.rows[idx], bom);
      state.rows[idx] = {
        ...state.rows[idx],
        bom_code: bom,
        primary_material: fields.material === '—' ? '' : fields.material,
        primary_material_desc: fields.materialDesc === '—' ? '' : fields.materialDesc,
        qty_per_fg: fields.qtyFg === '—' ? '' : fields.qtyFg,
      };
    }
    delete state.opsCache[faOpsCacheKey(part, bom)];
    if (rerender) render();
  }

  function faRenderMppOpRow(row, partNo, bomCode, op) {
    const desc = String(row?.description || '');
    const opNo = faOpNoLabel(op);
    const opKey = String(op?.op_no ?? '').trim();
    const saveKey = faLineSaveKey(partNo, bomCode, opKey);
    const lineSaving = state.saving.has(saveKey);
    const cycle = Number(op.cycle_min_per_piece || 0);
    const pcs = Number(op.pcs_per_pallet || 0);
    const runPal = Number(op.run_min_per_pallet || 0);
    const calcPal = faFormatCalcPal(cycle, pcs, runPal);
    const processDesc = faOpProcessLabel(op);
    return `
      <tr data-part-no="${escapeHtml(partNo)}" data-bom-code="${escapeHtml(bomCode)}" data-op-no="${escapeHtml(opKey)}">
        <td class="fa-op-cell">${escapeHtml(opNo)}</td>
        <td class="fa-process-cell">
          <input type="text" class="fa-op-process-input" data-part-no="${escapeHtml(partNo)}" data-bom-code="${escapeHtml(bomCode)}" data-op-no="${escapeHtml(opKey)}" value="${escapeHtml(processDesc)}" placeholder="${escapeHtml(String(op.stage_desc || '').trim())}" ${lineSaving ? 'disabled' : ''} />
        </td>
        <td class="fa-mpp-num-cell">
          <input type="number" class="fa-mpp-num-input fa-op-cycle-input" data-part-no="${escapeHtml(partNo)}" data-bom-code="${escapeHtml(bomCode)}" data-op-no="${escapeHtml(opKey)}" min="0" step="0.01" value="${escapeHtml(faMppNumValue(cycle))}" placeholder="—" ${lineSaving ? 'disabled' : ''} />
        </td>
        <td class="fa-mpp-num-cell">
          <input type="number" class="fa-mpp-num-input fa-op-pcs-input" data-part-no="${escapeHtml(partNo)}" data-bom-code="${escapeHtml(bomCode)}" data-op-no="${escapeHtml(opKey)}" min="1" step="1" value="${escapeHtml(faMppIntValue(pcs))}" placeholder="—" ${lineSaving ? 'disabled' : ''} />
        </td>
        <td class="fa-mpp-num-cell">
          <input type="number" class="fa-mpp-num-input fa-op-run-input" data-part-no="${escapeHtml(partNo)}" data-bom-code="${escapeHtml(bomCode)}" data-op-no="${escapeHtml(opKey)}" min="0" step="0.01" value="${escapeHtml(faMppNumValue(runPal))}" placeholder="${escapeHtml(calcPal === '—' ? 'auto' : calcPal)}" title="Auto: min/pc × pcs/pal = ${escapeHtml(calcPal)}" ${lineSaving ? 'disabled' : ''} />
        </td>
        <td class="fa-mpp-num-cell">
          <input type="number" class="fa-mpp-num-input fa-op-pallets-input" data-part-no="${escapeHtml(partNo)}" data-bom-code="${escapeHtml(bomCode)}" data-op-no="${escapeHtml(opKey)}" min="1" step="1" value="${escapeHtml(faMppIntValue(op.pallets_count))}" placeholder="—" ${lineSaving ? 'disabled' : ''} />
        </td>
        <td class="fa-mpp-machine-cell">
          <select class="fa-mpp-machine-select fa-op-machine-select" data-part-no="${escapeHtml(partNo)}" data-bom-code="${escapeHtml(bomCode)}" data-op-no="${escapeHtml(opKey)}" ${lineSaving ? 'disabled' : ''}>
            ${faMppMachineOptions(op.mpp_machine_no || inferFaMppMachine(desc, row?.notes))}
          </select>
        </td>
        <td class="fa-mpp-num-cell">
          <input type="number" class="fa-mpp-num-input fa-op-setup-input" data-part-no="${escapeHtml(partNo)}" data-bom-code="${escapeHtml(bomCode)}" data-op-no="${escapeHtml(opKey)}" min="0" step="0.1" value="${escapeHtml(faMppNumValue(op.setup_minutes))}" placeholder="—" ${lineSaving ? 'disabled' : ''} />
        </td>
        <td class="fa-col-actions">
          <button type="button" class="btn btn-ghost btn-sm fa-save-op-btn" data-part-no="${escapeHtml(partNo)}" data-bom-code="${escapeHtml(bomCode)}" data-op-no="${escapeHtml(opKey)}" data-stage-no="${escapeHtml(String(op.stage_no ?? ''))}" ${lineSaving || !opKey ? 'disabled' : ''}>Save</button>
        </td>
      </tr>
    `;
  }

  function faRenderMppModalBody() {
    const bodyEl = document.getElementById('fa-mpp-modal-body');
    const { partNo, selectedBom } = state.mppModal;
    const row = state.rows.find((r) => r.part_no === partNo);
    if (!bodyEl || !partNo || !row) return;

    const bom = String(selectedBom || '').trim();
    if (!bom) {
      bodyEl.innerHTML = '<p class="so-material-modal-empty">Select a BOM route to configure operation pallet settings.</p>';
      return;
    }

    const key = faOpsCacheKey(partNo, bom);
    if (state.opsLoading.has(key)) {
      bodyEl.innerHTML = '<div class="so-material-modal-loading"><div class="spinner"></div> Loading operations…</div>';
      return;
    }

    const ops = state.opsCache[key];
    if (!Array.isArray(ops)) {
      bodyEl.innerHTML = '<div class="so-material-modal-loading"><div class="spinner"></div> Loading operations…</div>';
      faEnsureOpsLoaded(partNo, bom, row);
      return;
    }

    if (!ops.length) {
      bodyEl.innerHTML = `<p class="so-material-modal-empty">No machining operations found for ${escapeHtml(bom)}.</p>`;
      return;
    }

    bodyEl.innerHTML = `
      <p class="fa-mpp-modal-hint">Each operation can have its own fixture profile — min/pc, pcs per pallet, pallets per cycle, and machine. These apply when a process sheet matches this part, BOM, and op.</p>
      <div class="fa-mpp-modal-table-wrap">
        <table class="fa-mpp-modal-table">
          <thead>
            <tr>
              <th>Op</th>
              <th>Process</th>
              <th>Min / pc</th>
              <th>Pcs / pal</th>
              <th>Min / pal</th>
              <th>Pallets</th>
              <th>MPP machine</th>
              <th>Setup</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${ops.map((op) => faRenderMppOpRow(row, partNo, bom, op)).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function faOpenMppModal({ partNo, bomCode, bomCodes } = {}) {
    const shell = document.getElementById('fa-mpp-modal');
    if (!shell) return;
    const part = String(partNo || '').trim();
    if (!part) return;
    const row = state.rows.find((r) => r.part_no === part);
    const codes = (bomCodes && bomCodes.length) ? bomCodes : (row ? faBomCodesForRow(row) : []);
    const selectedBom = String(bomCode || '').trim() || (row ? faSelectedBom(part, row) : codes[0] || '');
    state.mppModal = { partNo: part, bomCodes: codes, selectedBom };

    const titleEl = document.getElementById('fa-mpp-modal-title');
    if (titleEl) {
      titleEl.innerHTML = `
        <div class="so-material-modal-id-row"><span class="so-material-modal-id-label">Part no</span><span class="so-material-modal-id-value so-material-modal-id-value--mono">${escapeHtml(part)}</span></div>
        ${row?.description ? `<div class="so-material-modal-id-row"><span class="so-material-modal-id-label">Description</span><span class="so-material-modal-id-value">${escapeHtml(row.description)}</span></div>` : ''}
      `;
    }
    faRenderBomTabsBar('fa-mpp-modal-bom-tabs', {
      partNo: part,
      bomCodes: codes,
      selectedBom,
      context: 'mpp',
    });
    shell.hidden = false;
    document.body.classList.add('so-material-modal-open');
    faRenderMppModalBody();
    if (!state.opsCache[faOpsCacheKey(part, selectedBom)]) {
      faEnsureOpsLoaded(part, selectedBom, row);
    }
  }

  function faCloseMppModal() {
    const shell = document.getElementById('fa-mpp-modal');
    if (!shell) return;
    shell.hidden = true;
    const bodyEl = document.getElementById('fa-mpp-modal-body');
    const titleEl = document.getElementById('fa-mpp-modal-title');
    const tabsEl = document.getElementById('fa-mpp-modal-bom-tabs');
    if (bodyEl) bodyEl.innerHTML = '';
    if (titleEl) titleEl.innerHTML = '';
    if (tabsEl) { tabsEl.innerHTML = ''; tabsEl.hidden = true; }
    state.mppModal = { partNo: '', bomCodes: [], selectedBom: '' };
    const confirmShell = document.getElementById('fa-confirm-modal');
    const materialShell = document.getElementById('fa-material-modal');
    const stepsShell = document.getElementById('fa-steps-modal');
    if ((!confirmShell || confirmShell.hidden)
      && (!materialShell || materialShell.hidden)
      && (!stepsShell || stepsShell.hidden)) {
      document.body.classList.remove('so-material-modal-open');
    }
  }

  function renderMppConfigBtn(partNo, bomCode, row) {
    const bom = String(bomCode || '').trim();
    if (!bom) {
      return '<button type="button" class="btn btn-ghost btn-sm" disabled title="Select a BOM route first">MPP config</button>';
    }
    const label = faMppConfigBtnLabel(row, bom);
    return `
      <button type="button" class="btn btn-ghost btn-sm"
        data-action="open-mpp-config"
        data-part-no="${escapeHtml(partNo)}"
        data-bom-code="${escapeHtml(bom)}"
        title="Configure pallet settings per operation for ${escapeHtml(partNo)} · ${escapeHtml(bom)}">${escapeHtml(label)}</button>
    `;
  }

  function filteredRows() {
    const q = state.search.trim().toLowerCase();
    if (!q) return state.rows;
    return state.rows.filter((row) => {
      const hay = [
        row.part_no,
        row.notes,
        row.description,
        row.bom_code,
        row.primary_material,
        row.primary_material_desc,
      ].map((v) => String(v || '').toLowerCase()).join(' ');
      return hay.includes(q);
    });
  }

  function renderBomDetailBtns(partNo, bomCode) {
    const part = String(partNo || '').trim();
    if (!part) return '<span class="fa-dash">—</span>';
    const bom = String(bomCode || '').trim();
    const materialsTitle = bom ? `View BOM materials for ${part} · ${bom}` : `View BOM materials for ${part}`;
    const stepsTitle = bom ? `View BOM steps for ${part} · ${bom}` : `View BOM steps for ${part}`;
    const stepsDisabled = bom ? '' : ' disabled';
    return `
      <div class="fa-bom-detail-btns">
        <button type="button" class="so-stage-material-btn btn btn-ghost btn-sm"
          data-action="open-material"
          data-part-no="${escapeHtml(part)}"
          data-bom-code="${escapeHtml(bom)}"
          title="${escapeHtml(materialsTitle)}">Materials</button>
        <button type="button" class="btn btn-ghost btn-sm"
          data-action="open-steps"
          data-part-no="${escapeHtml(part)}"
          data-bom-code="${escapeHtml(bom)}"
          title="${escapeHtml(stepsTitle)}"${stepsDisabled}>Steps</button>
      </div>
    `;
  }

  function render() {
    const tbody = document.getElementById('fa-tbody');
    const table = document.getElementById('fa-table');
    const empty = document.getElementById('fa-empty');
    const loading = document.getElementById('fa-loading');
    const countEl = document.getElementById('fa-count');
    const rows = filteredRows();

    if (loading) loading.hidden = !state.loading;
    if (countEl) {
      const total = state.rows.length;
      countEl.textContent = rows.length === total
        ? `${total} part${total === 1 ? '' : 's'}`
        : `${rows.length} of ${total} parts`;
    }

    if (state.loading) {
      if (table) table.hidden = true;
      if (empty) empty.hidden = true;
      return;
    }

    if (!rows.length) {
      if (table) table.hidden = true;
      if (empty) empty.hidden = false;
      if (tbody) tbody.innerHTML = '';
      return;
    }

    if (table) table.hidden = false;
    if (empty) empty.hidden = true;
    if (!tbody) return;

    tbody.innerHTML = rows.map((row) => {
      const partNo = String(row.part_no || '');
      const saving = state.saving.has(partNo);
      const desc = String(row.description || '—');
      const bomCodes = faBomCodesForRow(row);
      const selectedBom = faSelectedBom(partNo, row);
      const fields = faRowMaterialFields(row, selectedBom);
      return `
        <tr data-part-no="${escapeHtml(partNo)}">
          <td class="fa-part-cell">
            <span class="fa-part-no">${escapeHtml(partNo)}</span>
            <span class="fa-badge-demo" title="Shows as FA in S/O management">FA</span>
          </td>
          <td class="fa-desc-cell" title="${escapeHtml(desc)}">${escapeHtml(desc)}</td>
          <td class="fa-bom-cell">${faRenderBomToggle({ partNo, bomCodes, selectedBom, context: 'table' })}</td>
          <td class="new-orders-mono fa-material-cell" title="${escapeHtml(fields.materialDesc)}">${escapeHtml(fields.material)}</td>
          <td class="new-orders-num fa-qty-cell">${escapeHtml(fields.qtyFg)}</td>
          <td class="fa-materials-cell">${renderBomDetailBtns(partNo, selectedBom)}</td>
          <td class="fa-mpp-config-cell">${renderMppConfigBtn(partNo, selectedBom, row)}</td>
          <td class="fa-notes-cell">
            <input type="text" class="fa-notes-input" data-part-no="${escapeHtml(partNo)}" value="${escapeHtml(row.notes || '')}" ${saving ? 'disabled' : ''} />
          </td>
          <td class="fa-updated">${escapeHtml(formatUpdated(row.updated_at))}</td>
          <td class="fa-col-actions">
            <div class="fa-actions">
              <button type="button" class="btn btn-ghost btn-sm fa-save-part-btn" data-part-no="${escapeHtml(partNo)}" ${saving ? 'disabled' : ''}>Save</button>
              <button type="button" class="btn btn-ghost btn-sm fa-delete-btn" data-part-no="${escapeHtml(partNo)}" ${saving ? 'disabled' : ''}>Remove</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function loadRows() {
    state.loading = true;
    render();
    try {
      const res = await fetch('/api/planning-data/frame-agreement-parts?enrich=1');
      const payload = await parseJsonResponse(res);
      if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      state.rows = Array.isArray(payload.rows) ? payload.rows : [];
      for (const row of state.rows) {
        const partNo = String(row.part_no || '').trim();
        if (!partNo) continue;
        const selected = faSelectedBom(partNo, row);
        if (selected) {
          const fields = faRowMaterialFields(row, selected);
          row.bom_code = selected;
          row.primary_material = fields.material === '—' ? '' : fields.material;
          row.primary_material_desc = fields.materialDesc === '—' ? '' : fields.materialDesc;
          row.qty_per_fg = fields.qtyFg === '—' ? '' : fields.qtyFg;
        }
      }
    } catch (err) {
      setAddStatus(`Failed to load: ${err.message}`, 'error');
      state.rows = [];
    } finally {
      state.loading = false;
      render();
    }
  }

  async function saveOpSettings(partNo, payload, notes) {
    const body = { ...payload };
    if (notes !== undefined) body.notes = notes;
    const res = await fetch(`/api/planning-data/frame-agreement-parts/${encodeURIComponent(partNo)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await parseJsonResponse(res);
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data.row;
  }

  async function addPart(partNo, payload) {
    const res = await fetch('/api/planning-data/frame-agreement-parts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ part_no: partNo, ...payload }),
    });
    const data = await parseJsonResponse(res);
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data.row;
  }

  async function savePartSettings(partNo, payload) {
    return saveOpSettings(partNo, payload);
  }

  async function removePart(partNo) {
    const res = await fetch(`/api/planning-data/frame-agreement-parts/${encodeURIComponent(partNo)}`, {
      method: 'DELETE',
    });
    const payload = await parseJsonResponse(res);
    if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  }

  async function fetchPartSearch(query) {
    const params = new URLSearchParams({ action: 'search', q: query });
    const res = await fetch(`/api/planning-data/frame-agreement-parts?${params}`);
    const payload = await parseJsonResponse(res);
    if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    return Array.isArray(payload.rows) ? payload.rows : [];
  }

  async function fetchPartPreview(partNo, bomCode) {
    const params = new URLSearchParams({ action: 'preview', part_no: partNo });
    const bom = String(bomCode || '').trim();
    if (bom) params.set('bom', bom);
    const res = await fetch(`/api/planning-data/frame-agreement-parts?${params}`);
    const payload = await parseJsonResponse(res);
    if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    return payload.preview;
  }

  function closePartSearchResults() {
    state.partSearch.open = false;
    state.partSearch.activeIndex = -1;
    const list = document.getElementById('fa-part-search-results');
    const input = document.getElementById('fa-part-input');
    if (list) list.hidden = true;
    if (input) input.setAttribute('aria-expanded', 'false');
  }

  function renderPartSearchResults() {
    const list = document.getElementById('fa-part-search-results');
    const input = document.getElementById('fa-part-input');
    if (!list || !input) return;

    const { hits, loading, open } = state.partSearch;
    if (!open || (!loading && !hits.length && !state.partSearch.query.trim())) {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      return;
    }

    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');

    if (loading) {
      list.innerHTML = '<div class="fa-part-search-status">Searching…</div>';
      return;
    }

    if (!hits.length) {
      list.innerHTML = '<div class="fa-part-search-status">No matching inventory codes.</div>';
      return;
    }

    list.innerHTML = hits.map((hit, index) => {
      const active = index === state.partSearch.activeIndex ? ' is-active' : '';
      const desc = hit.description ? `<span class="fa-part-search-desc">${escapeHtml(hit.description)}</span>` : '';
      const boms = hit.bom_count ? `<span class="fa-part-search-meta">${hit.bom_count} BOM${hit.bom_count === 1 ? '' : 's'}</span>` : '';
      return `
        <button type="button" class="fa-part-search-item${active}" role="option" data-index="${index}">
          <span class="fa-part-search-part">${escapeHtml(hit.part_no)}</span>
          ${desc}
          ${boms}
        </button>
      `;
    }).join('');
  }

  let partSearchTimer;
  function schedulePartSearch(query) {
    state.partSearch.query = query;
    clearTimeout(partSearchTimer);
    if (!query.trim()) {
      state.partSearch.hits = [];
      state.partSearch.loading = false;
      closePartSearchResults();
      renderPartSearchResults();
      updateAddButtonState();
      return;
    }
    state.partSearch.open = true;
    state.partSearch.loading = true;
    renderPartSearchResults();
    partSearchTimer = setTimeout(async () => {
      try {
        state.partSearch.hits = await fetchPartSearch(query.trim());
        state.partSearch.activeIndex = state.partSearch.hits.length ? 0 : -1;
      } catch (err) {
        state.partSearch.hits = [];
        setAddStatus(err.message, 'error');
      } finally {
        state.partSearch.loading = false;
        renderPartSearchResults();
      }
    }, 220);
  }

  function updateAddButtonState() {
    const btn = document.getElementById('fa-add-btn');
    if (!btn) return;
    btn.disabled = !state.pendingPart;
  }

  async function selectPartForConfirm(partNo) {
    const part = String(partNo || '').trim();
    if (!part) return;
    closePartSearchResults();
    const input = document.getElementById('fa-part-input');
    if (input) input.value = part;
    state.pendingPart = part;
    state.pendingPreview = null;
    updateAddButtonState();
    await openConfirmModal(part);
  }

  function renderConfirmHeader(preview) {
    const rows = [
      preview.part_no ? `<div class="so-material-modal-id-row"><span class="so-material-modal-id-label">Part no</span><span class="so-material-modal-id-value so-material-modal-id-value--mono">${escapeHtml(preview.part_no)}</span></div>` : '',
      preview.description ? `<div class="so-material-modal-id-row"><span class="so-material-modal-id-label">Description</span><span class="so-material-modal-id-value">${escapeHtml(preview.description)}</span></div>` : '',
      preview.inventory_class ? `<div class="so-material-modal-id-row"><span class="so-material-modal-id-label">Class</span><span class="so-material-modal-id-value">${escapeHtml(preview.inventory_class)}</span></div>` : '',
    ].filter(Boolean).join('');
    return rows || escapeHtml(preview.part_no || '');
  }

  function faFormatMaterialQtyPerFg(row) {
    const fromApi = Number(row.qty_per_fg);
    if (Number.isFinite(fromApi) && fromApi > 0) {
      return Number.isInteger(fromApi) ? String(fromApi) : fromApi.toFixed(4).replace(/\.?0+$/, '');
    }
    const parent = Number(row.qty_parent);
    const fg = Number(row.qty_fg);
    if (!Number.isFinite(parent) || parent <= 0) return '—';
    if (!Number.isFinite(fg) || fg <= 0 || Math.abs(parent - fg) < 1e-9) {
      return Number.isInteger(parent) ? String(parent) : parent.toFixed(4).replace(/\.?0+$/, '');
    }
    const val = parent / fg;
    return Number.isInteger(val) ? String(val) : val.toFixed(4).replace(/\.?0+$/, '');
  }

  function renderPreviewBomTable(materials, notice, { showRoute = true } = {}) {
    if (!Array.isArray(materials) || !materials.length) {
      return `<p class="so-material-modal-empty">${notice ? escapeHtml(notice) : 'No BOM materials found for this part.'}</p>`;
    }
    const body = materials.map((row) => `
      <tr>
        ${showRoute ? `<td class="new-orders-mono">${escapeHtml(row.bom_code || '—')}</td>` : ''}
        <td class="new-orders-mono">${escapeHtml(row.material_inventory_code || '—')}</td>
        <td>${escapeHtml(row.description || '—')}</td>
        <td class="new-orders-num">${escapeHtml(faFormatMaterialQtyPerFg(row))}</td>
        <td>${escapeHtml(row.uom_code || '—')}</td>
      </tr>
    `).join('');
    const noticeHtml = notice
      ? `<div class="so-material-modal-notice so-material-modal-notice--info">${escapeHtml(notice)}</div>`
      : '';
    return `
      ${noticeHtml}
      <section class="so-material-modal-section">
        <h3 class="so-material-modal-section-title">BOM materials</h3>
        <div class="so-material-modal-table-wrap">
          <table class="so-material-modal-table">
            <thead>
              <tr>
                ${showRoute ? '<th>BOM route</th>' : ''}
                <th>Material</th>
                <th>Description</th>
                <th>Qty / FG</th>
                <th>UOM</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderPreviewStock(preview) {
    const onHand = preview.stock_on_hand;
    const onOrder = preview.stock_on_order;
    const free = preview.stock_free_balance;
    if (onHand == null && onOrder == null && free == null) return '';
    return `
      <section class="so-material-modal-section">
        <h3 class="so-material-modal-section-title">Inventory snapshot</h3>
        <div class="fa-preview-stock-grid">
          <div><span class="fa-preview-stock-label">On hand</span><span class="fa-preview-stock-value">${escapeHtml(String(onHand ?? '—'))}</span></div>
          <div><span class="fa-preview-stock-label">On order</span><span class="fa-preview-stock-value">${escapeHtml(String(onOrder ?? '—'))}</span></div>
          <div><span class="fa-preview-stock-label">Free balance</span><span class="fa-preview-stock-value">${escapeHtml(String(free ?? '—'))}</span></div>
        </div>
      </section>
    `;
  }

  function renderConfirmBody(preview) {
    const bomCodes = Array.isArray(preview.bom_codes) ? preview.bom_codes : [];
    const showRoute = bomCodes.length > 1;
    return `
      ${renderPreviewStock(preview)}
      ${renderPreviewBomTable(preview.materials, preview.notice, { showRoute })}
    `;
  }

  function applyConfirmPreview(preview) {
    const partNo = String(preview?.part_no || state.confirmModal.partNo || '').trim();
    const bomCodes = Array.isArray(preview?.bom_codes) ? preview.bom_codes : [];
    const selectedBom = String(preview?.bom_code || bomCodes[0] || '').trim();
    state.pendingPreview = preview;
    state.confirmModal = { partNo, selectedBom };

    const titleEl = document.getElementById('fa-confirm-modal-title');
    const bodyEl = document.getElementById('fa-confirm-modal-body');
    const addBtn = document.getElementById('fa-confirm-add-btn');
    if (titleEl) titleEl.innerHTML = renderConfirmHeader(preview);
    if (bodyEl) bodyEl.innerHTML = renderConfirmBody(preview);
    faRenderBomTabsBar('fa-confirm-modal-bom-tabs', {
      partNo,
      bomCodes,
      selectedBom,
      context: 'confirm',
    });
    if (addBtn) addBtn.disabled = false;

    const machineEl = document.getElementById('fa-confirm-mpp-machine');
    const runEl = document.getElementById('fa-confirm-mpp-run');
    const setupEl = document.getElementById('fa-confirm-mpp-setup');
    const pcsEl = document.getElementById('fa-confirm-mpp-pcs');
    const palletsEl = document.getElementById('fa-confirm-mpp-pallets');
    const desc = String(preview?.description || '');
    if (machineEl && !machineEl.value) {
      machineEl.value = inferFaMppMachine(desc, '');
    }
    if (runEl && !runEl.value) runEl.value = '';
    if (setupEl && !setupEl.value) setupEl.value = '';
    if (pcsEl && !pcsEl.value) pcsEl.value = '';
    if (palletsEl && !palletsEl.value) palletsEl.value = '';
  }

  async function reloadConfirmPreview(partNo, bomCode) {
    const bodyEl = document.getElementById('fa-confirm-modal-body');
    if (bodyEl) {
      bodyEl.innerHTML = '<div class="so-material-modal-loading"><div class="spinner"></div> Loading BOM materials…</div>';
    }
    const preview = await fetchPartPreview(partNo, bomCode);
    applyConfirmPreview(preview);
  }

  function openConfirmModal(partNo, bomCode) {
    const shell = document.getElementById('fa-confirm-modal');
    const titleEl = document.getElementById('fa-confirm-modal-title');
    const bodyEl = document.getElementById('fa-confirm-modal-body');
    const addBtn = document.getElementById('fa-confirm-add-btn');
    if (!shell || !titleEl || !bodyEl || !addBtn) return;

    state.confirmModal = { partNo, selectedBom: String(bomCode || '').trim() };
    const confirmNotes = document.getElementById('fa-confirm-notes-input');
    const machineEl = document.getElementById('fa-confirm-mpp-machine');
    const runEl = document.getElementById('fa-confirm-mpp-run');
    const setupEl = document.getElementById('fa-confirm-mpp-setup');
    const pcsEl = document.getElementById('fa-confirm-mpp-pcs');
    const palletsEl = document.getElementById('fa-confirm-mpp-pallets');
    if (confirmNotes) confirmNotes.value = '';
    if (machineEl) machineEl.value = '';
    if (runEl) runEl.value = '';
    if (setupEl) setupEl.value = '';
    if (pcsEl) pcsEl.value = '';
    if (palletsEl) palletsEl.value = '';
    titleEl.innerHTML = `<span class="so-material-modal-id-value so-material-modal-id-value--mono">${escapeHtml(partNo)}</span>`;
    bodyEl.innerHTML = '<div class="so-material-modal-loading"><div class="spinner"></div> Loading part details…</div>';
    faRenderBomTabsBar('fa-confirm-modal-bom-tabs', { partNo, bomCodes: [], selectedBom: '', context: 'confirm' });
    addBtn.disabled = true;
    shell.hidden = false;
    document.body.classList.add('so-material-modal-open');

    fetchPartPreview(partNo, bomCode)
      .then((preview) => applyConfirmPreview(preview))
      .catch((err) => {
        bodyEl.innerHTML = `<p class="so-material-modal-error">Could not load part details: ${escapeHtml(err.message)}</p>`;
      });
  }

  function closeConfirmModal() {
    const shell = document.getElementById('fa-confirm-modal');
    if (!shell) return;
    shell.hidden = true;
    document.body.classList.remove('so-material-modal-open');
    const bodyEl = document.getElementById('fa-confirm-modal-body');
    const titleEl = document.getElementById('fa-confirm-modal-title');
    const tabsEl = document.getElementById('fa-confirm-modal-bom-tabs');
    if (bodyEl) bodyEl.innerHTML = '';
    if (titleEl) titleEl.innerHTML = '';
    if (tabsEl) {
      tabsEl.innerHTML = '';
      tabsEl.hidden = true;
    }
    state.confirmModal = { partNo: '', selectedBom: '' };
  }

  async function confirmAddPart() {
    const partNo = state.pendingPart;
    if (!partNo) return;
    const notesInput = document.getElementById('fa-confirm-notes-input');
    const machineEl = document.getElementById('fa-confirm-mpp-machine');
    const runEl = document.getElementById('fa-confirm-mpp-run');
    const setupEl = document.getElementById('fa-confirm-mpp-setup');
    const pcsEl = document.getElementById('fa-confirm-mpp-pcs');
    const palletsEl = document.getElementById('fa-confirm-mpp-pallets');
    const notes = String(notesInput?.value || '').trim();
    const description = String(state.pendingPreview?.description || '');
    const selectedBom = String(state.confirmModal.selectedBom || state.pendingPreview?.bom_code || '').trim();
    const addBtn = document.getElementById('fa-confirm-add-btn');
    if (addBtn) addBtn.disabled = true;
    setAddStatus('Saving…', '');
    try {
      await addPart(partNo, {
        notes,
        description,
      });
      closeConfirmModal();
      state.pendingPart = null;
      state.pendingPreview = null;
      if (notesInput) notesInput.value = '';
      if (machineEl) machineEl.value = '';
      if (runEl) runEl.value = '';
      if (setupEl) setupEl.value = '';
      if (pcsEl) pcsEl.value = '';
      if (palletsEl) palletsEl.value = '';
      const partInput = document.getElementById('fa-part-input');
      if (partInput) partInput.value = '';
      updateAddButtonState();
      setAddStatus(`Added ${partNo}.`, 'success');
      await loadRows();
    } catch (err) {
      setAddStatus(err.message, 'error');
      if (addBtn) addBtn.disabled = false;
    }
  }

  // ── Materials modal (same pattern as S/O management) ─────────────────────

  function faBomMaterialCodes(bomRows) {
    const codes = [];
    const seen = new Set();
    for (const row of bomRows || []) {
      const code = String(row.material_inventory_code || '').trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      codes.push(code);
    }
    return codes;
  }

  function faParseBomMaterialsResponse(data) {
    if (Array.isArray(data)) return { bomRows: data, meta: null };
    if (data && Array.isArray(data.rows)) {
      return {
        bomRows: data.rows,
        meta: {
          requested_bom_code: data.requested_bom_code || '',
          resolved_bom_code: data.resolved_bom_code || '',
          match_mode: data.match_mode || '',
          alternate_bom_codes: data.alternate_bom_codes || [],
          notice: data.notice || '',
        },
      };
    }
    if (data?.error) throw new Error(data.error);
    return { bomRows: [], meta: null };
  }

  function faRenderMaterialModalHeader(partNo, bomCode) {
    const rows = [
      partNo ? `<div class="so-material-modal-id-row"><span class="so-material-modal-id-label">Part no</span><span class="so-material-modal-id-value so-material-modal-id-value--mono">${escapeHtml(partNo)}</span></div>` : '',
      bomCode ? `<div class="so-material-modal-id-row"><span class="so-material-modal-id-label">BOM code</span><span class="so-material-modal-id-value so-material-modal-id-value--mono">${escapeHtml(bomCode)}</span></div>` : '',
    ].filter(Boolean).join('');
    return rows || escapeHtml(partNo || '');
  }

  function faRenderMaterialModalNotice(meta) {
    const text = String(meta?.notice || '').trim();
    if (!text) return '';
    const mode = String(meta?.match_mode || '');
    const cls = mode === 'not_found' ? ' so-material-modal-notice--warn' : ' so-material-modal-notice--info';
    return `<div class="so-material-modal-notice${cls}">${escapeHtml(text)}</div>`;
  }

  function faShouldShowBomRouteColumn(rows, meta) {
    if (meta?.match_mode === 'any_bom_for_part') return true;
    const codes = new Set((rows || []).map((r) => String(r.bom_code || '').trim()).filter(Boolean));
    return codes.size > 1;
  }

  function faRenderMaterialModalBomTable(rows, meta = null) {
    if (!Array.isArray(rows) || !rows.length) {
      return '<p class="so-material-modal-empty">No BOM materials found for this part.</p>';
    }
    const showRoute = faShouldShowBomRouteColumn(rows, meta);
    const body = rows.map((row) => `
      <tr>
        ${showRoute ? `<td class="new-orders-mono">${escapeHtml(String(row.bom_code || '—'))}</td>` : ''}
        <td class="new-orders-mono">${escapeHtml(row.material_inventory_code || '—')}</td>
        <td>${escapeHtml(row.description || '—')}</td>
        <td class="new-orders-num">${escapeHtml(faFormatMaterialQtyPerFg(row))}</td>
        <td>${escapeHtml(row.uom_code || '—')}</td>
      </tr>
    `).join('');
    return `
      <section class="so-material-modal-section">
        <h3 class="so-material-modal-section-title">BOM materials</h3>
        <div class="so-material-modal-table-wrap">
          <table class="so-material-modal-table">
            <thead>
              <tr>
                ${showRoute ? '<th>BOM route</th>' : ''}
                <th>Material</th>
                <th>Description</th>
                <th>Qty / FG</th>
                <th>UOM</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </section>
    `;
  }

  function faRenderMaterialModalInventoryTable(bomRows, invRows) {
    const byBom = new Map();
    for (const row of bomRows || []) {
      const bom = String(row.bom_code || '').trim() || '—';
      if (!byBom.has(bom)) byBom.set(bom, []);
      byBom.get(bom).push(row);
    }
    const invByCode = new Map();
    for (const row of invRows || []) {
      const code = String(row.inventory_code || '').trim();
      if (code) invByCode.set(code, row);
    }

    const bodyParts = [];
    for (const [bomCode, materials] of byBom.entries()) {
      for (const mat of materials) {
        const matCode = String(mat.material_inventory_code || '').trim();
        const inv = invByCode.get(matCode);
        if (!inv) {
          bodyParts.push(`
            <tr class="so-material-modal-inv-missing">
              <td class="new-orders-mono so-material-modal-bom-ref">${escapeHtml(bomCode)}</td>
              <td class="new-orders-mono">${escapeHtml(matCode || '—')}</td>
              <td colspan="11" class="so-material-modal-inv-missing-note">Not found in inventory enquiry</td>
            </tr>
          `);
          continue;
        }
        const desc = String(inv.main_desc || inv.short_desc || '').trim();
        bodyParts.push(`
          <tr>
            <td class="new-orders-mono so-material-modal-bom-ref">${escapeHtml(bomCode)}</td>
            <td class="new-orders-mono"><span class="so-material-modal-inv-code">${escapeHtml(matCode)}</span></td>
            <td class="so-material-modal-desc" title="${escapeHtml(desc)}">${escapeHtml(desc || '—')}</td>
            <td class="new-orders-num">${escapeHtml(String(inv.total_qty_on_hand ?? '—'))}</td>
            <td class="new-orders-num">${escapeHtml(String(inv.total_qty_on_order ?? '—'))}</td>
            <td class="new-orders-num">${escapeHtml(String(inv.total_qty_allocated ?? '—'))}</td>
            <td class="new-orders-num">${escapeHtml(String(inv.total_qty_back_order ?? '—'))}</td>
            <td class="new-orders-num">${escapeHtml(String(inv.total_free_balance_qty ?? '—'))}</td>
          </tr>
        `);
      }
    }

    if (!bodyParts.length) return '';

    return `
      <section class="so-material-modal-section">
        <h3 class="so-material-modal-section-title">Inventory enquiry</h3>
        <p class="so-material-modal-section-hint">Live stock for each BOM material.</p>
        <div class="so-material-modal-table-wrap so-material-modal-table-wrap--wide">
          <table class="so-material-modal-table so-material-modal-table--inventory">
            <thead>
              <tr>
                <th>BOM</th>
                <th>Material</th>
                <th>Description</th>
                <th>On hand</th>
                <th>On order</th>
                <th>Allocated</th>
                <th>Back order</th>
                <th>Free bal.</th>
              </tr>
            </thead>
            <tbody>${bodyParts.join('')}</tbody>
          </table>
        </div>
      </section>
    `;
  }

  function faRenderMaterialModalContent(bomRows, invRows, meta = null) {
    return [
      faRenderMaterialModalNotice(meta),
      faRenderMaterialModalBomTable(bomRows, meta),
      faRenderMaterialModalInventoryTable(bomRows, invRows),
    ].join('');
  }

  function faCloseMaterialModal() {
    const shell = document.getElementById('fa-material-modal');
    const confirmShell = document.getElementById('fa-confirm-modal');
    if (!shell) return;
    shell.hidden = true;
    const bodyEl = document.getElementById('fa-material-modal-body');
    const titleEl = document.getElementById('fa-material-modal-title');
    const tabsEl = document.getElementById('fa-material-modal-bom-tabs');
    if (bodyEl) bodyEl.innerHTML = '';
    if (titleEl) titleEl.innerHTML = '';
    if (tabsEl) {
      tabsEl.innerHTML = '';
      tabsEl.hidden = true;
    }
    state.materialModal = { partNo: '', bomCodes: [], selectedBom: '' };
    if (!confirmShell || confirmShell.hidden) {
      document.body.classList.remove('so-material-modal-open');
    }
  }

  async function faLoadMaterialModalContent(partNo, bomCode, bomCodes) {
    const titleEl = document.getElementById('fa-material-modal-title');
    const bodyEl = document.getElementById('fa-material-modal-body');
    if (!titleEl || !bodyEl) return;

    const part = String(partNo || '').trim();
    const bom = String(bomCode || '').trim();
    if (!part) return;

    titleEl.innerHTML = faRenderMaterialModalHeader(part, bom);
    bodyEl.innerHTML = '<div class="so-material-modal-loading"><div class="spinner"></div> Loading BOM materials and inventory…</div>';
    faRenderBomTabsBar('fa-material-modal-bom-tabs', {
      partNo: part,
      bomCodes: bomCodes || [],
      selectedBom: bom,
      context: 'material',
    });

    const bomParams = new URLSearchParams({ source: part, fallback: '1' });
    if (bom) bomParams.set('bom', bom);

    try {
      const res = await fetch(`/api/bom/materials?${bomParams}`);
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data?.error || 'Failed to load BOM materials');
      const { bomRows, meta } = faParseBomMaterialsResponse(data);
      const resolvedCodes = (bomCodes && bomCodes.length)
        ? bomCodes
        : [...new Set((bomRows || []).map((r) => String(r.bom_code || '').trim()).filter(Boolean))];
      if (resolvedCodes.length > 1) {
        faRenderBomTabsBar('fa-material-modal-bom-tabs', {
          partNo: part,
          bomCodes: resolvedCodes,
          selectedBom: bom || meta?.resolved_bom_code || resolvedCodes[0],
          context: 'material',
        });
        state.materialModal = {
          partNo: part,
          bomCodes: resolvedCodes,
          selectedBom: bom || meta?.resolved_bom_code || resolvedCodes[0],
        };
      }
      const codes = faBomMaterialCodes(bomRows);
      let invRows = [];
      if (codes.length) {
        const invParams = new URLSearchParams({ codes: codes.join(','), loose: '1' });
        const invRes = await fetch(`/api/inventory-enquiry?${invParams}`);
        const invData = await parseJsonResponse(invRes);
        if (!invRes.ok || invData?.error) {
          throw new Error(invData?.error || 'Failed to load inventory enquiry');
        }
        invRows = Array.isArray(invData.rows) ? invData.rows : [];
      }
      bodyEl.innerHTML = faRenderMaterialModalContent(bomRows, invRows, meta);
    } catch (err) {
      bodyEl.innerHTML = `<p class="so-material-modal-error">Could not load materials: ${escapeHtml(err.message || 'Unknown error')}</p>`;
    }
  }

  function faOpenMaterialModal({ partNo, bomCode, bomCodes } = {}) {
    const shell = document.getElementById('fa-material-modal');
    if (!shell) return;

    const part = String(partNo || '').trim();
    const bom = String(bomCode || '').trim();
    if (!part) return;

    const row = state.rows.find((r) => r.part_no === part);
    const codes = (bomCodes && bomCodes.length)
      ? bomCodes
      : (row ? faBomCodesForRow(row) : []);
    const selectedBom = bom || (row ? faSelectedBom(part, row) : codes[0] || '');

    state.materialModal = { partNo: part, bomCodes: codes, selectedBom };
    shell.hidden = false;
    document.body.classList.add('so-material-modal-open');
    faLoadMaterialModalContent(part, selectedBom, codes);
  }

  // ── BOM steps modal ───────────────────────────────────────────────────────

  function faRenderStepsModalHeader(partNo, bomCode) {
    const rows = [
      partNo ? `<div class="so-material-modal-id-row"><span class="so-material-modal-id-label">Part no</span><span class="so-material-modal-id-value so-material-modal-id-value--mono">${escapeHtml(partNo)}</span></div>` : '',
      bomCode ? `<div class="so-material-modal-id-row"><span class="so-material-modal-id-label">BOM code</span><span class="so-material-modal-id-value so-material-modal-id-value--mono">${escapeHtml(bomCode)}</span></div>` : '',
    ].filter(Boolean).join('');
    return rows || escapeHtml(partNo || '');
  }

  function faRenderStepsModalTable(rows) {
    if (!Array.isArray(rows) || !rows.length) {
      return '<p class="so-material-modal-empty">No machining operations found for this BOM route.</p>';
    }
    const body = rows.map((row) => `
      <tr>
        <td class="new-orders-num">${escapeHtml(String(row.stage_no ?? '—'))}</td>
        <td class="new-orders-num">${row.op_no != null ? escapeHtml(String(row.op_no)) : '—'}</td>
        <td>${escapeHtml(row.stage_desc || '—')}</td>
        <td class="new-orders-mono">${escapeHtml(row.machine_no || '—')}</td>
      </tr>
    `).join('');
    return `
      <section class="so-material-modal-section">
        <h3 class="so-material-modal-section-title">Machining operations</h3>
        <div class="so-material-modal-table-wrap">
          <table class="so-material-modal-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Op no.</th>
                <th>Description</th>
                <th>Machine</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </section>
    `;
  }

  function faCloseStepsModal() {
    const shell = document.getElementById('fa-steps-modal');
    const confirmShell = document.getElementById('fa-confirm-modal');
    const materialShell = document.getElementById('fa-material-modal');
    if (!shell) return;
    shell.hidden = true;
    const bodyEl = document.getElementById('fa-steps-modal-body');
    const titleEl = document.getElementById('fa-steps-modal-title');
    const tabsEl = document.getElementById('fa-steps-modal-bom-tabs');
    if (bodyEl) bodyEl.innerHTML = '';
    if (titleEl) titleEl.innerHTML = '';
    if (tabsEl) {
      tabsEl.innerHTML = '';
      tabsEl.hidden = true;
    }
    state.stepsModal = { partNo: '', bomCodes: [], selectedBom: '' };
    if ((!confirmShell || confirmShell.hidden) && (!materialShell || materialShell.hidden)) {
      document.body.classList.remove('so-material-modal-open');
    }
  }

  async function faLoadStepsModalContent(partNo, bomCode, bomCodes) {
    const titleEl = document.getElementById('fa-steps-modal-title');
    const bodyEl = document.getElementById('fa-steps-modal-body');
    if (!titleEl || !bodyEl) return;

    const part = String(partNo || '').trim();
    const bom = String(bomCode || '').trim();
    if (!part || !bom) return;

    titleEl.innerHTML = faRenderStepsModalHeader(part, bom);
    bodyEl.innerHTML = '<div class="so-material-modal-loading"><div class="spinner"></div> Loading BOM steps…</div>';
    faRenderBomTabsBar('fa-steps-modal-bom-tabs', {
      partNo: part,
      bomCodes: bomCodes || [],
      selectedBom: bom,
      context: 'steps',
    });

    try {
      const params = new URLSearchParams({ source: part, bom });
      const res = await fetch(`/api/bom/operations?${params}`);
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data?.error || 'Failed to load BOM steps');
      if (data?.error) throw new Error(data.error);
      const rows = Array.isArray(data) ? data : [];
      bodyEl.innerHTML = faRenderStepsModalTable(rows);
    } catch (err) {
      bodyEl.innerHTML = `<p class="so-material-modal-error">Could not load BOM steps: ${escapeHtml(err.message || 'Unknown error')}</p>`;
    }
  }

  function faOpenStepsModal({ partNo, bomCode, bomCodes } = {}) {
    const shell = document.getElementById('fa-steps-modal');
    if (!shell) return;

    const part = String(partNo || '').trim();
    const bom = String(bomCode || '').trim();
    if (!part || !bom) return;

    const row = state.rows.find((r) => r.part_no === part);
    const codes = (bomCodes && bomCodes.length)
      ? bomCodes
      : (row ? faBomCodesForRow(row) : []);
    const selectedBom = bom || (row ? faSelectedBom(part, row) : codes[0] || '');
    if (!selectedBom) return;

    state.stepsModal = { partNo: part, bomCodes: codes, selectedBom };
    shell.hidden = false;
    document.body.classList.add('so-material-modal-open');
    faLoadStepsModalContent(part, selectedBom, codes);
  }

  async function faHandleBomSelect(btn) {
    const context = btn.getAttribute('data-context');
    const partNo = btn.getAttribute('data-part-no');
    const bomCode = btn.getAttribute('data-bom-code');
    if (!partNo || !bomCode) return;

    if (context === 'table') {
      faSetSelectedBom(partNo, bomCode);
      return;
    }
    if (context === 'mpp') {
      state.mppModal = { ...state.mppModal, partNo, selectedBom: bomCode };
      delete state.opsCache[faOpsCacheKey(partNo, bomCode)];
      faRenderBomTabsBar('fa-mpp-modal-bom-tabs', {
        partNo,
        bomCodes: state.mppModal.bomCodes || [],
        selectedBom: bomCode,
        context: 'mpp',
      });
      await faEnsureOpsLoaded(partNo, bomCode, state.rows.find((r) => r.part_no === partNo));
      faRenderMppModalBody();
      return;
    }
    if (context === 'confirm') {
      state.confirmModal = { partNo, selectedBom: bomCode };
      try {
        await reloadConfirmPreview(partNo, bomCode);
      } catch (err) {
        const bodyEl = document.getElementById('fa-confirm-modal-body');
        if (bodyEl) {
          bodyEl.innerHTML = `<p class="so-material-modal-error">Could not load BOM: ${escapeHtml(err.message)}</p>`;
        }
      }
      return;
    }
    if (context === 'material') {
      state.materialModal = {
        ...state.materialModal,
        partNo,
        selectedBom: bomCode,
      };
      await faLoadMaterialModalContent(partNo, bomCode, state.materialModal.bomCodes);
      return;
    }
    if (context === 'steps') {
      state.stepsModal = {
        ...state.stepsModal,
        partNo,
        selectedBom: bomCode,
      };
      await faLoadStepsModalContent(partNo, bomCode, state.stepsModal.bomCodes);
    }
  }

  function bindEvents() {
    const partInput = document.getElementById('fa-part-input');
    const searchWrap = document.getElementById('fa-part-search-wrap');
    const resultsList = document.getElementById('fa-part-search-results');

    partInput?.addEventListener('input', (e) => {
      state.pendingPart = null;
      state.pendingPreview = null;
      updateAddButtonState();
      schedulePartSearch(e.target.value || '');
    });

    partInput?.addEventListener('focus', () => {
      if (state.partSearch.hits.length) {
        state.partSearch.open = true;
        renderPartSearchResults();
      }
    });

    partInput?.addEventListener('keydown', (e) => {
      const { hits, activeIndex, open } = state.partSearch;
      if (!open || !hits.length) {
        if (e.key === 'Enter' && state.pendingPart) {
          e.preventDefault();
          openConfirmModal(state.pendingPart);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.partSearch.activeIndex = Math.min(activeIndex + 1, hits.length - 1);
        renderPartSearchResults();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.partSearch.activeIndex = Math.max(activeIndex - 1, 0);
        renderPartSearchResults();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const hit = hits[activeIndex >= 0 ? activeIndex : 0];
        if (hit) selectPartForConfirm(hit.part_no);
      } else if (e.key === 'Escape') {
        closePartSearchResults();
      }
    });

    resultsList?.addEventListener('click', (e) => {
      const btn = e.target.closest('.fa-part-search-item');
      if (!btn) return;
      const index = Number(btn.getAttribute('data-index'));
      const hit = state.partSearch.hits[index];
      if (hit) selectPartForConfirm(hit.part_no);
    });

    document.addEventListener('click', (e) => {
      if (!searchWrap?.contains(e.target)) closePartSearchResults();
    });

    document.getElementById('fa-add-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (state.pendingPart) {
        openConfirmModal(state.pendingPart);
        return;
      }
      const typed = String(partInput?.value || '').trim();
      if (typed) {
        selectPartForConfirm(typed);
        return;
      }
      setAddStatus('Search and select a part number.', 'error');
      partInput?.focus();
    });

    let searchTimer;
    document.getElementById('fa-search')?.addEventListener('input', (e) => {
      state.search = e.target.value || '';
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => render(), 120);
    });

    document.getElementById('fa-refresh')?.addEventListener('click', () => loadRows());

    document.getElementById('fa-tbody')?.addEventListener('click', async (e) => {
      const bomBtn = e.target.closest('[data-action="select-bom"]');
      if (bomBtn) {
        e.stopPropagation();
        await faHandleBomSelect(bomBtn);
        return;
      }

      const materialBtn = e.target.closest('[data-action="open-material"]');
      if (materialBtn) {
        e.stopPropagation();
        const partNo = materialBtn.getAttribute('data-part-no');
        const row = state.rows.find((r) => r.part_no === partNo);
        faOpenMaterialModal({
          partNo,
          bomCode: materialBtn.getAttribute('data-bom-code'),
          bomCodes: row ? faBomCodesForRow(row) : [],
        });
        return;
      }

      const stepsBtn = e.target.closest('[data-action="open-steps"]');
      if (stepsBtn) {
        e.stopPropagation();
        const partNo = stepsBtn.getAttribute('data-part-no');
        const row = state.rows.find((r) => r.part_no === partNo);
        faOpenStepsModal({
          partNo,
          bomCode: stepsBtn.getAttribute('data-bom-code'),
          bomCodes: row ? faBomCodesForRow(row) : [],
        });
        return;
      }

      const mppBtn = e.target.closest('[data-action="open-mpp-config"]');
      if (mppBtn) {
        e.stopPropagation();
        const partNo = mppBtn.getAttribute('data-part-no');
        const row = state.rows.find((r) => r.part_no === partNo);
        faOpenMppModal({
          partNo,
          bomCode: mppBtn.getAttribute('data-bom-code'),
          bomCodes: row ? faBomCodesForRow(row) : [],
        });
        return;
      }

      const savePartBtn = e.target.closest('.fa-save-part-btn');
      const deleteBtn = e.target.closest('.fa-delete-btn');
      if (savePartBtn) {
        const partNo = savePartBtn.getAttribute('data-part-no');
        if (!partNo) return;
        const notes = readFaPartNotes(partNo);
        state.saving.add(partNo);
        render();
        try {
          const row = await saveOpSettings(partNo, { notes });
          const idx = state.rows.findIndex((r) => r.part_no === partNo);
          if (idx >= 0 && row) state.rows[idx] = { ...state.rows[idx], ...row, notes };
          setAddStatus(`Saved notes for ${partNo}.`, 'success');
        } catch (err) {
          setAddStatus(err.message, 'error');
        } finally {
          state.saving.delete(partNo);
          render();
        }
        return;
      }
      if (deleteBtn) {
        const partNo = deleteBtn.getAttribute('data-part-no');
        if (!partNo) return;
        if (!window.confirm(`Remove ${partNo} from frame agreement parts?`)) return;
        state.saving.add(partNo);
        render();
        try {
          await removePart(partNo);
          state.rows = state.rows.filter((r) => r.part_no !== partNo);
          setAddStatus(`Removed ${partNo}.`, 'success');
        } catch (err) {
          setAddStatus(err.message, 'error');
        } finally {
          state.saving.delete(partNo);
          render();
        }
      }
    });

    const confirmModal = document.getElementById('fa-confirm-modal');
    confirmModal?.querySelectorAll('[data-action="close-confirm-modal"]').forEach((el) => {
      el.addEventListener('click', closeConfirmModal);
    });
    confirmModal?.addEventListener('click', async (e) => {
      const bomBtn = e.target.closest('[data-action="select-bom"]');
      if (bomBtn) {
        e.stopPropagation();
        await faHandleBomSelect(bomBtn);
      }
    });
    document.getElementById('fa-confirm-modal-close')?.addEventListener('click', closeConfirmModal);
    document.getElementById('fa-confirm-add-btn')?.addEventListener('click', () => confirmAddPart());

    const materialModal = document.getElementById('fa-material-modal');
    materialModal?.querySelector('[data-action="close-material-modal"]')?.addEventListener('click', faCloseMaterialModal);
    document.getElementById('fa-material-modal-close')?.addEventListener('click', faCloseMaterialModal);
    materialModal?.addEventListener('click', async (e) => {
      const bomBtn = e.target.closest('[data-action="select-bom"]');
      if (bomBtn) {
        e.stopPropagation();
        await faHandleBomSelect(bomBtn);
      }
    });

    const mppModal = document.getElementById('fa-mpp-modal');
    mppModal?.querySelector('[data-action="close-mpp-modal"]')?.addEventListener('click', faCloseMppModal);
    document.getElementById('fa-mpp-modal-close')?.addEventListener('click', faCloseMppModal);
    mppModal?.addEventListener('click', async (e) => {
      const bomBtn = e.target.closest('[data-action="select-bom"]');
      if (bomBtn) {
        e.stopPropagation();
        await faHandleBomSelect(bomBtn);
        return;
      }
      const saveBtn = e.target.closest('.fa-save-op-btn');
      if (!saveBtn) return;
      const partNo = saveBtn.getAttribute('data-part-no');
      const bomCode = saveBtn.getAttribute('data-bom-code');
      const opNo = saveBtn.getAttribute('data-op-no');
      if (!partNo || !bomCode || !opNo) return;
      const payload = readFaOpRowSettings(partNo, bomCode, opNo);
      const stageNo = Number(saveBtn.getAttribute('data-stage-no') || 0);
      if (stageNo > 0) payload.stage_no = stageNo;
      const saveKey = faLineSaveKey(partNo, bomCode, opNo);
      state.saving.add(saveKey);
      faRenderMppModalBody();
      try {
        const row = await saveOpSettings(partNo, payload);
        const idx = state.rows.findIndex((r) => r.part_no === partNo);
        if (idx >= 0 && row) {
          const merged = { ...state.rows[idx], ...row };
          if (row.op_configs) merged.op_configs = row.op_configs;
          if (row.saved_op_config && row.saved_bom_code && row.saved_op_no) {
            merged.op_configs = merged.op_configs || {};
            merged.op_configs[row.saved_bom_code] = merged.op_configs[row.saved_bom_code] || {};
            merged.op_configs[row.saved_bom_code][row.saved_op_no] = row.saved_op_config;
          }
          state.rows[idx] = merged;
        }
        delete state.opsCache[faOpsCacheKey(partNo, bomCode)];
        await faEnsureOpsLoaded(partNo, bomCode, state.rows[idx]);
        setAddStatus(`Saved op ${opNo} for ${partNo} · ${bomCode}.`, 'success');
        render();
      } catch (err) {
        setAddStatus(err.message, 'error');
      } finally {
        state.saving.delete(saveKey);
        faRenderMppModalBody();
      }
    });

    const stepsModal = document.getElementById('fa-steps-modal');
    stepsModal?.querySelector('[data-action="close-steps-modal"]')?.addEventListener('click', faCloseStepsModal);
    document.getElementById('fa-steps-modal-close')?.addEventListener('click', faCloseStepsModal);
    stepsModal?.addEventListener('click', async (e) => {
      const bomBtn = e.target.closest('[data-action="select-bom"]');
      if (bomBtn) {
        e.stopPropagation();
        await faHandleBomSelect(bomBtn);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!document.getElementById('fa-mpp-modal')?.hidden) faCloseMppModal();
      else if (!document.getElementById('fa-steps-modal')?.hidden) faCloseStepsModal();
      else if (!document.getElementById('fa-material-modal')?.hidden) faCloseMaterialModal();
      else if (!document.getElementById('fa-confirm-modal')?.hidden) closeConfirmModal();
    });
  }

  bindEvents();
  loadRows();
}());
