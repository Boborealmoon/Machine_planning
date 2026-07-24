(function materialBarCalcInit() {
  'use strict';

  const API = '/api/material-bar-calc';

  const state = {
    mode: 'idle', // idle | create | edit
    records: [],
    machines: [],
    selectedCalcId: null,
    searchTimer: null,
    hitIndex: -1,
    hits: [],
    bomCode: '',
    materialCode: '',
    bomQtyPerFg: null,
    batches: [{ batch_no: '', length_mm: '' }],
    materialEntries: [],
    selectedCncs: [],
    operations: [],
    opAssignments: {},
    uom: 'mm',
    qtyLabel: 'Length (mm)',
  };

  const $ = (id) => document.getElementById(id);

  function num(el, fallback = 0) {
    if (!el) return fallback;
    const raw = String(el.value ?? '').trim();
    if (raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  function fmt(n, digits = 2) {
    if (n === null || n === undefined || n === '') return '-';
    const x = Number(n);
    if (!Number.isFinite(x)) return '-';
    return x.toLocaleString(undefined, {
      maximumFractionDigits: digits,
      minimumFractionDigits: 0,
    });
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function setSlipDate(value) {
    const el = $('mbc-slip-date');
    if (!el) return;
    const text = String(value || '').trim().slice(0, 10);
    el.value = text || todayISO();
  }

  function readSlipDate() {
    const el = $('mbc-slip-date');
    const text = String(el?.value || '').trim().slice(0, 10);
    return text || todayISO();
  }

  function activeStatusEl() {
    if (state.mode === 'create') return $('mbc-modal-status');
    if (state.mode === 'edit') return $('mbc-edit-status');
    return $('mbc-page-status');
  }

  function setStatus(msg, kind) {
    ['mbc-modal-status', 'mbc-edit-status', 'mbc-page-status'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      if (el !== activeStatusEl()) {
        el.textContent = '';
        el.classList.remove('is-error', 'is-ok');
      }
    });
    const el = activeStatusEl();
    if (!el) return;
    el.textContent = msg || '';
    el.classList.remove('is-error', 'is-ok');
    if (kind) el.classList.add(kind === 'error' ? 'is-error' : 'is-ok');
  }

  async function json(url, options) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...options,
    });
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    if (!res.ok) {
      const err = new Error((body && body.error) || res.statusText || 'Request failed');
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  function uomKind(uom) {
    const u = String(uom || 'mm').toLowerCase();
    if (u === 'pcs' || u === 'pc' || u === 'ea') return 'count';
    if (u === 'kg' || u === 'g') return 'mass';
    if (u === 'mm' || u === 'm' || u === 'cm') return 'length';
    return 'other';
  }

  function qtyLabelFor(uom) {
    const kind = uomKind(uom);
    if (kind === 'count') return 'Qty (pcs)';
    if (kind === 'mass') return 'Weight (' + uom + ')';
    if (kind === 'length') return 'Length (' + uom + ')';
    return 'Qty (' + (uom || 'mm') + ')';
  }

  function perUnitLabelFor(uom) {
    const kind = uomKind(uom);
    if (kind === 'count') return 'Material used / unit (pcs)';
    return 'Material used / unit (' + (uom || 'mm') + ')';
  }

  function bufferLabelFor(uom) {
    const kind = uomKind(uom);
    if (kind === 'count') return 'Buffer pieces';
    if (kind === 'length') return 'Buffer length (' + uom + ')';
    return 'Buffer (' + (uom || 'mm') + ')';
  }

  function uomOptionsHtml(selected) {
    const opts = [
      ['mm', 'mm (length)'],
      ['pcs', 'pcs (pieces)'],
      ['kg', 'kg (weight)'],
      ['m', 'm (metres)'],
    ];
    const sel = String(selected || 'mm').trim() || 'mm';
    let html = opts
      .map(([value, label]) => {
        return (
          '<option value="' +
          value +
          '"' +
          (value === sel ? ' selected' : '') +
          '>' +
          label +
          '</option>'
        );
      })
      .join('');
    if (sel && !opts.some(([v]) => v === sel)) {
      html +=
        '<option value="' +
        escapeHtml(sel) +
        '" selected>' +
        escapeHtml(sel) +
        '</option>';
    }
    return html;
  }

  function emptyMaterialEntry(overrides) {
    return Object.assign(
      {
        key: 'mat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        calc_id: null,
        material_inventory_code: '',
        material_type_grade: '',
        material_uom: 'mm',
        material_per_unit_mm: '',
        buffer_length_mm: '',
        bom_qty_per_fg: null,
        batches: [{ batch_no: '', length_mm: '' }],
      },
      overrides || {}
    );
  }

  function materialKey(mat) {
    return String(
      mat.material_type_grade || mat.material_inventory_code || mat.key || ''
    )
      .trim()
      .toUpperCase();
  }

  function mountForm(slot) {
    const body = $('mbc-form-body');
    if (!body || !slot) return;
    body.hidden = false;
    if (body.parentElement !== slot) slot.appendChild(body);
  }

  function parkForm() {
    const body = $('mbc-form-body');
    const park = $('mbc-form-park');
    if (body && park && body.parentElement !== park) {
      body.hidden = true;
      park.appendChild(body);
    }
  }

  function readBatchesFromCard(card) {
    const rows = card.querySelectorAll('.mbc-batch-row');
    const out = [];
    rows.forEach((row) => {
      const batch_no = String(row.querySelector('[data-field="batch_no"]').value || '').trim();
      const lengthRaw = String(row.querySelector('[data-field="length_mm"]').value || '').trim();
      const length_mm = lengthRaw === '' ? 0 : Number(lengthRaw);
      if (!batch_no && !(Number.isFinite(length_mm) && length_mm > 0)) return;
      out.push({
        batch_no,
        length_mm: Number.isFinite(length_mm) ? Math.max(0, length_mm) : 0,
      });
    });
    return out;
  }

  function syncMaterialEntriesFromDom() {
    const cards = document.querySelectorAll('#mbc-mat-list .mbc-mat-block');
    if (!cards.length) return state.materialEntries;
    state.materialEntries = Array.from(cards).map((card, idx) => {
      const prev = state.materialEntries[idx] || emptyMaterialEntry();
      const uom = String(card.querySelector('[data-field="uom"]')?.value || prev.material_uom || 'mm').trim() || 'mm';
      const perRaw = String(card.querySelector('[data-field="per_unit"]')?.value || '').trim();
      const bufRaw = String(card.querySelector('[data-field="buffer"]')?.value || '').trim();
      const draftBatches = Array.from(card.querySelectorAll('.mbc-batch-row')).map((row) => ({
        batch_no: row.querySelector('[data-field="batch_no"]').value,
        length_mm: row.querySelector('[data-field="length_mm"]').value,
      }));
      return {
        ...prev,
        key: card.getAttribute('data-mat-key') || prev.key,
        calc_id: card.getAttribute('data-calc-id') || prev.calc_id || null,
        material_type_grade: String(
          card.querySelector('[data-field="material"]')?.value || prev.material_type_grade || ''
        ).trim(),
        material_uom: uom,
        material_per_unit_mm: perRaw === '' ? '' : Number(perRaw),
        buffer_length_mm: bufRaw === '' ? '' : Number(bufRaw),
        batches: draftBatches.length ? draftBatches : [{ batch_no: '', length_mm: '' }],
      };
    });
    return state.materialEntries;
  }

  function computeEntry(entry, orderQty) {
    const order = Math.max(0, Number(orderQty) || 0);
    const perUnit = Math.max(0, Number(entry.material_per_unit_mm) || 0);
    const buffer = Math.max(0, Number(entry.buffer_length_mm) || 0);
    const perPiece = perUnit + buffer;
    const target = order * perPiece;
    const batches = (entry.batches || [])
      .map((b) => ({
        batch_no: String(b.batch_no || '').trim(),
        length_mm: Math.max(0, Number(b.length_mm) || 0),
      }))
      .filter((b) => b.batch_no || b.length_mm > 0);
    const issued = batches.reduce((s, b) => s + b.length_mm, 0);
    return {
      order,
      perUnit,
      buffer,
      perPiece,
      target,
      issued,
      returnable: issued - target,
      batches,
      uom: entry.material_uom || 'mm',
    };
  }

  function orderQtyValue() {
    return Math.max(0, num($('mbc-order-qty')));
  }

  function renderMaterialList() {
    const list = $('mbc-mat-list');
    if (!list) return;
    if (!state.materialEntries.length) {
      state.materialEntries = [emptyMaterialEntry()];
    }
    const order = orderQtyValue();
    list.innerHTML = state.materialEntries
      .map((entry, idx) => {
        const uom = entry.material_uom || 'mm';
        const calc = computeEntry(entry, order);
        const title =
          entry.material_type_grade ||
          entry.material_inventory_code ||
          'Material ' + (idx + 1);
        const batches = entry.batches && entry.batches.length
          ? entry.batches
          : [{ batch_no: '', length_mm: '' }];
        const batchHtml = batches
          .map((b, bi) => {
            const val =
              b.length_mm === '' || b.length_mm == null ? '' : escapeHtml(b.length_mm);
            return (
              '<div class="mbc-batch-row" data-batch-index="' +
              bi +
              '">' +
              '<div><label>Batch no.</label>' +
              '<input type="text" class="mbc-input" data-field="batch_no" value="' +
              escapeHtml(b.batch_no || '') +
              '" placeholder="Batch / heat no." /></div>' +
              '<div><label>' +
              escapeHtml(qtyLabelFor(uom)) +
              '</label>' +
              '<input type="number" step="any" min="0" class="mbc-input mbc-num" data-field="length_mm" value="' +
              val +
              '" placeholder="0" /></div>' +
              '<button type="button" class="mbc-batch-remove" data-action="remove-batch" title="Remove">x</button></div>'
            );
          })
          .join('');
        const returnText = calc.issued <= 0 ? '?' : fmt(calc.returnable);
        const returnClass =
          calc.issued <= 0 ? ' is-pending' : calc.returnable < 0 ? ' is-short' : '';
        return (
          '<div class="mbc-mat-block" data-mat-index="' +
          idx +
          '" data-mat-key="' +
          escapeHtml(entry.key) +
          '"' +
          (entry.calc_id ? ' data-calc-id="' + escapeHtml(entry.calc_id) + '"' : '') +
          '>' +
          '<div class="mbc-mat-block-head">' +
          '<div><strong>' +
          escapeHtml(title) +
          '</strong>' +
          (entry.bom_qty_per_fg != null && entry.bom_qty_per_fg !== ''
            ? '<small>BOM ' +
              escapeHtml(fmt(entry.bom_qty_per_fg, 4).replace(/\.?0+$/, '')) +
              ' / FG</small>'
            : '') +
          '</div>' +
          '<button type="button" class="btn btn-light btn-sm" data-action="add-batch">+ Add batch</button>' +
          '</div>' +
          '<input type="hidden" data-field="material" value="' +
          escapeHtml(entry.material_type_grade || entry.material_inventory_code || '') +
          '" />' +
          '<div class="mbc-mat-qty-grid">' +
          '<div class="mbc-field"><label>Unit</label>' +
          '<select class="mbc-input" data-field="uom">' +
          uomOptionsHtml(uom) +
          '</select></div>' +
          '<div class="mbc-field"><label>' +
          escapeHtml(perUnitLabelFor(uom)) +
          '</label>' +
          '<input type="number" step="any" min="0" class="mbc-input mbc-num" data-field="per_unit" value="' +
          (entry.material_per_unit_mm === '' || entry.material_per_unit_mm == null
            ? ''
            : escapeHtml(entry.material_per_unit_mm)) +
          '" /></div>' +
          '<div class="mbc-field"><label>' +
          escapeHtml(bufferLabelFor(uom)) +
          '</label>' +
          '<input type="number" step="any" min="0" class="mbc-input mbc-num" data-field="buffer" value="' +
          (entry.buffer_length_mm === '' || entry.buffer_length_mm == null
            ? ''
            : escapeHtml(entry.buffer_length_mm)) +
          '" placeholder="0" /></div>' +
          '</div>' +
          '<div class="mbc-target mbc-target--compact">' +
          '<span>Target usable</span>' +
          '<div class="mbc-target-value"><strong>' +
          fmt(calc.target) +
          '</strong><small>' +
          escapeHtml(uom) +
          '</small></div></div>' +
          '<div class="mbc-batch-list">' +
          batchHtml +
          '</div>' +
          '<div class="mbc-issued-totals">' +
          '<div class="mbc-stat"><span>Total issued</span><strong>' +
          fmt(calc.issued) +
          '</strong> <small>' +
          escapeHtml(uom) +
          '</small></div>' +
          '<div class="mbc-stat mbc-returnable' +
          returnClass +
          '"><span>Target return</span><strong>' +
          returnText +
          '</strong> <small>' +
          escapeHtml(uom) +
          '</small></div>' +
          '</div></div>'
        );
      })
      .join('');

    list.querySelectorAll('input, select').forEach((el) => {
      el.addEventListener('input', onMaterialCardChange);
      el.addEventListener('change', onMaterialCardChange);
    });
    list.querySelectorAll('[data-action="add-batch"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        syncMaterialEntriesFromDom();
        const idx = Number(btn.closest('.mbc-mat-block')?.getAttribute('data-mat-index'));
        if (!Number.isFinite(idx) || !state.materialEntries[idx]) return;
        state.materialEntries[idx].batches.push({ batch_no: '', length_mm: '' });
        renderMaterialList();
      });
    });
    list.querySelectorAll('[data-action="remove-batch"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        syncMaterialEntriesFromDom();
        const card = btn.closest('.mbc-mat-block');
        const idx = Number(card?.getAttribute('data-mat-index'));
        const batchIdx = Number(btn.closest('.mbc-batch-row')?.getAttribute('data-batch-index'));
        if (!Number.isFinite(idx) || !state.materialEntries[idx]) return;
        state.materialEntries[idx].batches.splice(batchIdx, 1);
        if (!state.materialEntries[idx].batches.length) {
          state.materialEntries[idx].batches.push({ batch_no: '', length_mm: '' });
        }
        renderMaterialList();
      });
    });
  }

  function onMaterialCardChange(ev) {
    const field = ev?.target?.getAttribute?.('data-field');
    syncMaterialEntriesFromDom();
    if (field === 'uom') {
      renderMaterialList();
      return;
    }
    // Update totals in-place so typing does not steal focus.
    const order = orderQtyValue();
    document.querySelectorAll('#mbc-mat-list .mbc-mat-block').forEach((card, idx) => {
      const entry = state.materialEntries[idx];
      if (!entry) return;
      const calc = computeEntry(entry, order);
      const targetEl = card.querySelector('.mbc-target-value strong');
      const issuedEl = card.querySelector('.mbc-issued-totals .mbc-stat strong');
      const returnBox = card.querySelector('.mbc-returnable');
      const returnEl = returnBox?.querySelector('strong');
      if (targetEl) targetEl.textContent = fmt(calc.target);
      if (issuedEl) issuedEl.textContent = fmt(calc.issued);
      if (returnEl) returnEl.textContent = calc.issued <= 0 ? '?' : fmt(calc.returnable);
      if (returnBox) {
        returnBox.classList.toggle('is-pending', calc.issued <= 0);
        returnBox.classList.toggle('is-short', calc.issued > 0 && calc.returnable < 0);
      }
    });
  }

  function renderResults() {
    syncMaterialEntriesFromDom();
    renderMaterialList();
  }

  function readOpAssignments() {
    const rows = document.querySelectorAll('#mbc-op-assign-list .mbc-op-assign-row');
    const out = [];
    rows.forEach((row) => {
      const opNo = row.getAttribute('data-op-no');
      if (opNo == null || opNo === '') return;
      const cnc = String(row.querySelector('[data-field="cnc"]')?.value || '').trim();
      const operator = String(row.querySelector('[data-field="operator"]')?.value || '').trim();
      const label = String(row.getAttribute('data-op-label') || '').trim();
      const stage = String(row.getAttribute('data-stage-desc') || '').trim();
      let op_no = opNo;
      if (/^\d+$/.test(opNo)) op_no = Number(opNo);
      out.push({
        op_no,
        operation_label: label || 'Operation ' + opNo,
        stage_desc: stage,
        cnc,
        operator,
      });
    });
    return out;
  }

  function readSelectedCncs() {
    const seen = new Set();
    const out = [];
    readOpAssignments().forEach((row) => {
      const code = String(row.cnc || '').trim();
      if (!code) return;
      const key = code.toUpperCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(code);
    });
    return out;
  }

  function assignmentMapFromRecord(record) {
    const map = {};
    (record?.op_assignments || []).forEach((row) => {
      if (row == null || row.op_no == null || row.op_no === '') return;
      map[String(row.op_no)] = {
        cnc: row.cnc || '',
        operator: row.operator || '',
      };
    });
    // Legacy fallback: first saved CNC applied to first op only if no assignments.
    if (!Object.keys(map).length && (record?.cnc_machines || []).length) {
      /* leave empty; user picks per op */
    }
    return map;
  }

  function machineOptionsHtml(selected) {
    const sel = String(selected || '').trim().toUpperCase();
    const opts = ['<option value="">Select CNC?</option>'];
    const codes = (state.machines || [])
      .map((m) => String(m.machine_no || m.machine_code || '').trim())
      .filter(Boolean);
    let found = false;
    codes.forEach((code) => {
      const isOn = code.toUpperCase() === sel;
      if (isOn) found = true;
      opts.push(
        '<option value="' +
          escapeHtml(code) +
          '"' +
          (isOn ? ' selected' : '') +
          '>' +
          escapeHtml(code) +
          '</option>'
      );
    });
    if (sel && !found) {
      opts.push(
        '<option value="' + escapeHtml(selected) + '" selected>' + escapeHtml(selected) + '</option>'
      );
    }
    return opts.join('');
  }

  function renderOpAssignList() {
    const list = $('mbc-op-assign-list');
    if (!list) return;
    const ops = state.operations || [];
    if (!ops.length) {
      list.innerHTML =
        '<div class="mbc-empty mbc-empty--inline">No machining operations found for this PS.</div>';
      return;
    }
    const saved = state.opAssignments || {};
    list.innerHTML = ops
      .map((op) => {
        const opNo = op.op_no != null ? String(op.op_no) : '';
        if (!opNo) return '';
        const label = op.operation_label || 'Operation ' + opNo;
        const stage = op.stage_desc || '';
        const assign = saved[opNo] || {};
        return (
          '<div class="mbc-op-assign-row" data-op-no="' +
          escapeHtml(opNo) +
          '" data-op-label="' +
          escapeHtml(label) +
          '" data-stage-desc="' +
          escapeHtml(stage) +
          '">' +
          '<div class="mbc-op-assign-op">' +
          '<strong>' +
          escapeHtml(label) +
          '</strong>' +
          (stage ? '<small>' + escapeHtml(stage) + '</small>' : '') +
          '</div>' +
          '<div class="mbc-field">' +
          '<label>CNC</label>' +
          '<select class="mbc-input" data-field="cnc">' +
          machineOptionsHtml(assign.cnc) +
          '</select></div>' +
          '<div class="mbc-field">' +
          '<label>Operator</label>' +
          '<input type="text" class="mbc-input" data-field="operator" value="' +
          escapeHtml(assign.operator || '') +
          '" placeholder="Name?" autocomplete="off" /></div>' +
          '</div>'
        );
      })
      .filter(Boolean)
      .join('');

    list.querySelectorAll('[data-field="cnc"], [data-field="operator"]').forEach((el) => {
      el.addEventListener('change', () => {
        state.opAssignments = {};
        readOpAssignments().forEach((row) => {
          state.opAssignments[String(row.op_no)] = {
            cnc: row.cnc || '',
            operator: row.operator || '',
          };
        });
        state.selectedCncs = readSelectedCncs();
      });
      el.addEventListener('input', () => {
        state.opAssignments = {};
        readOpAssignments().forEach((row) => {
          state.opAssignments[String(row.op_no)] = {
            cnc: row.cnc || '',
            operator: row.operator || '',
          };
        });
        state.selectedCncs = readSelectedCncs();
      });
    });
  }

  async function loadOperationsForPs(plannerPsId, partNo) {
    const ps = String(plannerPsId || '').trim();
    if (!ps) {
      state.operations = [];
      renderOpAssignList();
      return;
    }
    try {
      const qs =
        '?planner_ps_id=' +
        encodeURIComponent(ps) +
        (partNo ? '&part_no=' + encodeURIComponent(partNo) : '');
      const data = await json(API + '/machining-ops' + qs);
      state.operations = data.operations || [];
    } catch (_) {
      state.operations = [];
    }
    renderOpAssignList();
  }

  function updateSummary() {
    const ps = String($('mbc-ps-id').value || '').trim();
    const hasPs = !!ps;
    if ($('mbc-summary')) $('mbc-summary').hidden = !hasPs;
    if ($('mbc-inputs')) $('mbc-inputs').hidden = !hasPs;
    if ($('mbc-issued')) $('mbc-issued').hidden = !hasPs;
    if ($('mbc-ops')) $('mbc-ops').hidden = !hasPs;
    if (!hasPs) return;
    $('mbc-sum-ps').textContent = ps;
    $('mbc-sum-part').textContent = $('mbc-part-no').value || '-';
    const mats = (state.materialEntries || [])
      .map((m) => m.material_type_grade || m.material_inventory_code)
      .filter(Boolean);
    $('mbc-sum-mat').textContent = mats.length
      ? mats.join(', ')
      : state.materialCode || $('mbc-material').value || '- not on BOM -';
    if (mats.length === 1) {
      const entry = state.materialEntries[0];
      const qtyFg = entry?.bom_qty_per_fg;
      $('mbc-sum-qtyfg').textContent =
        qtyFg != null && qtyFg !== '' && Number.isFinite(Number(qtyFg))
          ? fmt(Number(qtyFg), 4).replace(/\.?0+$/, '') + ' ' + (entry.material_uom || '')
          : '-';
    } else if (mats.length > 1) {
      $('mbc-sum-qtyfg').textContent = mats.length + ' materials';
    } else {
      $('mbc-sum-qtyfg').textContent = '-';
    }
    $('mbc-sum-bom').textContent = state.bomCode || '-';
    const hint = $('mbc-issued-hint');
    if (hint) {
      hint.textContent =
        mats.length > 1
          ? mats.length + ' materials loaded from BOM ? issue batches for each below.'
          : 'Materials are loaded automatically from the BOM.';
    }
  }

  function entryFromRecord(record) {
    const batches = record?.issued_batches || [];
    const overrides = {
      calc_id: record?.calc_id || null,
      material_inventory_code: record?.material_inventory_code || '',
      material_type_grade: record?.material_type_grade || '',
      material_uom: record?.material_uom || 'mm',
      material_per_unit_mm: record?.material_per_unit_mm ?? '',
      buffer_length_mm: record?.buffer_length_mm ?? '',
      bom_qty_per_fg: record?.bom_qty_per_fg ?? record?.material_per_unit_mm ?? null,
      batches: batches.length
        ? batches.map((b) => ({
            batch_no: b.batch_no || '',
            length_mm: b.length_mm ?? '',
          }))
        : [{ batch_no: '', length_mm: '' }],
    };
    const key = materialKey(record || {});
    if (key) overrides.key = key;
    return emptyMaterialEntry(overrides);
  }

  function fillForm(record) {
    state.selectedCalcId = record?.calc_id || null;
    $('mbc-calc-id').value = record?.calc_id || '';
    $('mbc-ps-id').value = record?.planner_ps_id || '';
    $('mbc-ps-search').value = record?.planner_ps_id || '';
    $('mbc-part-no').value = record?.part_no || '';
    $('mbc-material').value = record?.material_type_grade || '';
    state.materialCode = record?.material_type_grade || state.materialCode || '';
    state.uom = record?.material_uom || 'mm';
    setSlipDate(record?.slip_date || todayISO());
    $('mbc-order-qty').value = record?.order_qty ?? '';
    $('mbc-stock-in').value = record?.stock_in_operator || '';
    $('mbc-stock-out').value = record?.stock_out_operator || '';
    state.opAssignments = assignmentMapFromRecord(record);
    state.selectedCncs = record?.cnc_machines || [];
    if (record && (record.material_type_grade || record.calc_id)) {
      state.materialEntries = [entryFromRecord(record)];
    } else if (!state.materialEntries.length) {
      state.materialEntries = [emptyMaterialEntry()];
    }
    renderMaterialList();
    updateSummary();
    highlightSelectedRow();
    loadOperationsForPs(record?.planner_ps_id, record?.part_no);
  }

  function resetFormFields() {
    state.bomCode = '';
    state.materialCode = '';
    state.bomQtyPerFg = null;
    state.batches = [{ batch_no: '', length_mm: '' }];
    state.materialEntries = [];
    state.selectedCncs = [];
    state.operations = [];
    state.opAssignments = {};
    fillForm({
      calc_id: null,
      planner_ps_id: '',
      part_no: '',
      material_type_grade: '',
      material_uom: 'mm',
      slip_date: todayISO(),
      order_qty: '',
      material_per_unit_mm: '',
      buffer_length_mm: '',
      issued_batches: [],
      cnc_machines: [],
      op_assignments: [],
      stock_in_operator: '',
      stock_out_operator: '',
    });
    if ($('mbc-summary')) $('mbc-summary').hidden = true;
    if ($('mbc-inputs')) $('mbc-inputs').hidden = true;
    if ($('mbc-issued')) $('mbc-issued').hidden = true;
    if ($('mbc-ops')) $('mbc-ops').hidden = true;
  }

  function openCreateModal() {
    closeEdit(false);
    state.mode = 'create';
    resetFormFields();
    mountForm($('mbc-modal-form-slot'));
    $('mbc-create-modal').hidden = false;
    document.body.classList.add('mbc-modal-open');
    setStatus('');
    setTimeout(() => $('mbc-ps-search')?.focus(), 30);
  }

  function closeCreateModal(opts) {
    const keepForm = opts && opts.keepForm;
    const modal = $('mbc-create-modal');
    if (modal) modal.hidden = true;
    document.body.classList.remove('mbc-modal-open');
    if (state.mode === 'create') {
      state.mode = 'idle';
      if (!keepForm) {
        parkForm();
        resetFormFields();
        highlightSelectedRow();
      }
    }
  }

  function openEdit(record) {
    closeCreateModal({ keepForm: true });
    state.mode = 'edit';
    mountForm($('mbc-edit-form-slot'));
    fillForm(record);
    loadFromPs(record.planner_ps_id, { keepMode: 'edit', seedRecord: record }).catch((e) =>
      setStatus(e.message || 'Failed to load BOM materials', 'error')
    );
    $('mbc-edit-title').textContent = 'Edit entry';
    $('mbc-edit-sub').textContent = record.planner_ps_id || '';
    $('mbc-edit-panel').hidden = false;
    $('mbc-ps-search').readOnly = true;
    setStatus('Editing ' + (record.planner_ps_id || '') + ' - click Save to update.');
    $('mbc-edit-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeEdit(park) {
    const panel = $('mbc-edit-panel');
    if (panel) panel.hidden = true;
    if ($('mbc-ps-search')) $('mbc-ps-search').readOnly = false;
    if (state.mode === 'edit') {
      state.mode = 'idle';
      state.selectedCalcId = null;
      if (park !== false) {
        parkForm();
        resetFormFields();
      }
      highlightSelectedRow();
      if ($('mbc-edit-status')) {
        $('mbc-edit-status').textContent = '';
        $('mbc-edit-status').classList.remove('is-error', 'is-ok');
      }
    }
  }

  function formatBatches(batches, uom) {
    const list = batches || [];
    const unit = uom || 'mm';
    if (!list.length) return '';
    return list
      .map((b) => {
        const batch = String(b.batch_no || '').trim() || '(no batch)';
        return (
          '<span class="mbc-batch-tag">' +
          escapeHtml(batch) +
          ' - ' +
          fmt(b.length_mm) +
          ' ' +
          escapeHtml(unit) +
          '</span>'
        );
      })
      .join('');
  }

  function renderTable(filter) {
    const wrap = $('mbc-table-wrap');
    const needle = String(filter || '').trim().toLowerCase();
    let rows = state.records;
    if (needle) {
      rows = rows.filter((r) => {
        const batchBlob = (r.issued_batches || [])
          .map((b) => (b.batch_no || '') + ' ' + (b.length_mm || ''))
          .join(' ');
        const cncBlob = (r.cnc_machines || []).join(' ');
        return (
          r.planner_ps_id +
          ' ' +
          r.part_no +
          ' ' +
          r.material_type_grade +
          ' ' +
          (r.material_uom || '') +
          ' ' +
          batchBlob +
          ' ' +
          cncBlob +
          ' ' +
          (r.stock_in_operator || '') +
          ' ' +
          (r.stock_out_operator || '')
        )
          .toLowerCase()
          .includes(needle);
      });
    }
    if (!rows.length) {
      wrap.innerHTML =
        '<div class="mbc-empty">' +
        (state.records.length
          ? 'No matches.'
          : 'No submitted entries yet. Click New entry to start.') +
        '</div>';
      return;
    }

    let html = '';
    for (const r of rows) {
      const selected = Number(state.selectedCalcId) === Number(r.calc_id);
      const uom = r.material_uom || r.uom_label || 'mm';
      const cncs = (r.cnc_machines || []).filter(Boolean);
      const ret = Number(r.returnable_mm);
      const retShort = Number.isFinite(ret) && ret < 0;
      const batchesHtml = formatBatches(r.issued_batches, uom);
      const chips = [];
      chips.push('<span class="mbc-chip">' + escapeHtml(uom) + '</span>');
      chips.push('<span class="mbc-chip">Qty ' + fmt(r.order_qty, 0) + '</span>');
      if (r.material_per_unit_mm != null) {
        chips.push(
          '<span class="mbc-chip">Per unit ' +
            fmt(r.material_per_unit_mm) +
            '</span>'
        );
      }
      if (r.buffer_length_mm) {
        chips.push('<span class="mbc-chip">Buf ' + fmt(r.buffer_length_mm) + '</span>');
      }
      cncs.slice(0, 4).forEach((c) => {
        chips.push('<span class="mbc-chip">' + escapeHtml(c) + '</span>');
      });
      if (cncs.length > 4) {
        chips.push('<span class="mbc-chip">+' + (cncs.length - 4) + '</span>');
      }

      html +=
        '<article class="mbc-entry' +
        (selected ? ' is-selected' : '') +
        '" data-calc-id="' +
        r.calc_id +
        '">' +
        '<div class="mbc-entry-main">' +
        '<p class="mbc-entry-ps">' +
        escapeHtml(r.planner_ps_id) +
        '</p>' +
        '<p class="mbc-entry-part">' +
        escapeHtml(r.part_no || '-') +
        '</p>' +
        (r.material_type_grade
          ? '<div class="mbc-entry-mat">' + escapeHtml(r.material_type_grade) + '</div>'
          : '') +
        '<div class="mbc-chips">' +
        chips.join('') +
        '</div>' +
        (batchesHtml
          ? '<div class="mbc-entry-batches">' + batchesHtml + '</div>'
          : '') +
        '</div>' +
        '<div class="mbc-entry-metrics">' +
        '<div class="mbc-metric"><span>Target</span><strong>' +
        fmt(r.target_total_mm) +
        ' ' +
        escapeHtml(uom) +
        '</strong></div>' +
        '<div class="mbc-metric"><span>Issued</span><strong>' +
        fmt(r.issued_total_mm) +
        ' ' +
        escapeHtml(uom) +
        '</strong></div>' +
        '<div class="mbc-metric mbc-metric--return' +
        (retShort ? ' is-short' : '') +
        '"><span>Return</span><strong>' +
        fmt(r.returnable_mm) +
        ' ' +
        escapeHtml(uom) +
        '</strong></div>' +
        '</div>' +
        '<div class="mbc-entry-side">' +
        '<div class="mbc-entry-meta">' +
        'In: ' +
        (escapeHtml(r.stock_in_operator) || '-') +
        '<br>Out: ' +
        (escapeHtml(r.stock_out_operator) || '-') +
        '</div>' +
        '<div class="mbc-actions">' +
        '<button type="button" class="btn btn-sm btn-light" data-action="edit">Edit</button>' +
        '<button type="button" class="btn btn-sm btn-light" data-action="slip-pdf">Slip PDF</button>' +
        '<button type="button" class="btn btn-sm btn-light" data-action="delete">Del</button>' +
        '</div>' +
        '</div>' +
        '</article>';
    }
    wrap.innerHTML = html;
  }

  function highlightSelectedRow() {
    document.querySelectorAll('.mbc-entry[data-calc-id]').forEach((el) => {
      el.classList.toggle(
        'is-selected',
        Number(el.getAttribute('data-calc-id')) === Number(state.selectedCalcId)
      );
    });
  }

  async function loadRecords() {
    const search = String($('mbc-track-search').value || '').trim();
    const qs = search ? '?search=' + encodeURIComponent(search) : '';
    const data = await json(API + '/records' + qs);
    state.records = data.records || [];
    renderTable($('mbc-track-search').value);
  }

  async function loadMachines() {
    const data = await json(API + '/machines');
    state.machines = data.machines || [];
    renderOpAssignList();
  }

  async function saveMaterialEntry(entry, shared) {
    const calc = computeEntry(entry, shared.order_qty);
    const material =
      String(entry.material_type_grade || entry.material_inventory_code || '').trim();
    if (!material) return null;
    const payload = {
      planner_ps_id: shared.planner_ps_id,
      part_no: shared.part_no,
      material_type_grade: material,
      material_uom: entry.material_uom || 'mm',
      slip_date: shared.slip_date,
      order_qty: shared.order_qty,
      material_per_unit_mm: calc.perUnit,
      buffer_length_mm: calc.buffer,
      issued_batches: calc.batches,
      op_assignments: shared.op_assignments,
      cnc_machines: shared.cnc_machines,
      stock_in_operator: shared.stock_in_operator,
      stock_out_operator: shared.stock_out_operator,
    };
    const calcId = entry.calc_id ? String(entry.calc_id) : '';
    if (calcId) {
      return json(API + '/records/' + calcId, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    }
    try {
      return await json(API + '/records', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (err.status === 409 && err.body?.calc_id) {
        return json(API + '/records/' + err.body.calc_id, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      }
      throw err;
    }
  }

  async function submitOrSave() {
    const ps = String($('mbc-ps-id').value || '').trim();
    if (!ps) {
      setStatus('Select a process sheet first.', 'error');
      return;
    }
    syncMaterialEntriesFromDom();
    const entries = (state.materialEntries || []).filter(
      (e) => String(e.material_type_grade || e.material_inventory_code || '').trim()
    );
    if (!entries.length) {
      setStatus('No BOM materials to save.', 'error');
      return;
    }
    const shared = {
      planner_ps_id: ps,
      part_no: String($('mbc-part-no').value || '').trim(),
      slip_date: readSlipDate(),
      order_qty: orderQtyValue(),
      op_assignments: readOpAssignments(),
      cnc_machines: readSelectedCncs(),
      stock_in_operator: String($('mbc-stock-in').value || '').trim(),
      stock_out_operator: String($('mbc-stock-out').value || '').trim(),
    };
    const isEdit = state.mode === 'edit';
    setStatus(isEdit ? 'Saving...' : 'Submitting...');
    try {
      const results = [];
      for (const entry of entries) {
        results.push(await saveMaterialEntry(entry, shared));
      }
      await loadRecords();
      const msg =
        (isEdit ? 'Saved' : 'Submitted') +
        ' ' +
        results.length +
        ' material' +
        (results.length === 1 ? '' : 's') +
        ' for ' +
        ps;

      if (state.mode === 'create') {
        closeCreateModal();
        state.mode = 'idle';
        setStatus(msg, 'ok');
      } else {
        await loadFromPs(ps, { keepMode: 'edit' });
        $('mbc-edit-sub').textContent = ps;
        setStatus(msg, 'ok');
      }
    } catch (err) {
      setStatus(err.message || (isEdit ? 'Save failed' : 'Submit failed'), 'error');
    }
  }

  async function deleteRecord(calcId) {
    if (!window.confirm('Delete this entry?')) return;
    await json(API + '/records/' + calcId, { method: 'DELETE' });
    if (Number(state.selectedCalcId) === Number(calcId)) closeEdit();
    await loadRecords();
    state.mode = 'idle';
    setStatus('Deleted.', 'ok');
  }

  async function downloadSlipPdf(calcId) {
    const record = state.records.find((r) => Number(r.calc_id) === Number(calcId));
    let dateVal = '';
    if (Number(state.selectedCalcId) === Number(calcId) && state.mode === 'edit') {
      dateVal = readSlipDate();
    } else if (record && record.slip_date) {
      dateVal = String(record.slip_date).slice(0, 10);
    } else {
      dateVal = todayISO();
    }
    setStatus('Generating slip PDF...');
    const qs = '?date=' + encodeURIComponent(dateVal);
    const res = await fetch(API + '/records/' + calcId + '/issue-slip-pdf' + qs, {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      let msg = 'PDF failed (' + res.status + ')';
      try {
        const err = await res.json();
        if (err && err.error) msg = err.error;
      } catch (_) {
        try {
          const text = await res.text();
          if (text) msg = text.slice(0, 200);
        } catch (__) {}
      }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(cd);
    const filename = match
      ? decodeURIComponent(match[1].replace(/"/g, ''))
      : 'Material_Issue_Return_Slip.pdf';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus('Slip PDF downloaded.', 'ok');
  }

  async function loadFromPs(plannerPsId, opts) {
    opts = opts || {};
    const data = await json(API + '/from-ps/' + encodeURIComponent(plannerPsId));
    const prefill = data.prefill || {};
    state.bomCode = prefill.bom_code || '';
    state.materialCode = prefill.material_inventory_code || '';
    state.bomQtyPerFg =
      prefill.bom_qty_per_fg != null && prefill.bom_qty_per_fg !== ''
        ? prefill.bom_qty_per_fg
        : null;

    const materials = Array.isArray(prefill.materials) && prefill.materials.length
      ? prefill.materials
      : [
          {
            material_inventory_code: prefill.material_inventory_code || '',
            material_type_grade: prefill.material_type_grade || '',
            material_uom: prefill.material_uom || 'mm',
            material_per_unit_mm: prefill.material_per_unit_mm,
            bom_qty_per_fg: prefill.bom_qty_per_fg,
            existing_record: prefill.existing_record || null,
            existing_calc_id: prefill.existing_calc_id || null,
          },
        ];

    state.materialEntries = materials.map((mat, idx) => {
      const saved = mat.existing_record || null;
      if (saved) {
        const entry = entryFromRecord(saved);
        entry.bom_qty_per_fg =
          mat.bom_qty_per_fg != null ? mat.bom_qty_per_fg : entry.bom_qty_per_fg;
        entry.material_inventory_code =
          mat.material_inventory_code || entry.material_inventory_code;
        return entry;
      }
      let perUnit = mat.material_per_unit_mm;
      if (!(Number(perUnit) > 0) && Number(mat.bom_qty_per_fg) > 0) {
        perUnit = mat.bom_qty_per_fg;
      }
      if (!(Number(perUnit) > 0) && uomKind(mat.material_uom || 'mm') === 'count') {
        perUnit = 1;
      }
      return emptyMaterialEntry({
        key: materialKey(mat) || 'bom-' + idx,
        calc_id: mat.existing_calc_id || null,
        material_inventory_code: mat.material_inventory_code || '',
        material_type_grade:
          mat.material_type_grade || mat.material_inventory_code || '',
        material_uom: mat.material_uom || 'mm',
        material_per_unit_mm: perUnit > 0 ? perUnit : '',
        buffer_length_mm: '',
        bom_qty_per_fg: mat.bom_qty_per_fg,
        batches: [{ batch_no: '', length_mm: '' }],
      });
    });

    if (opts.seedRecord && opts.seedRecord.calc_id) {
      const seedKey = materialKey(opts.seedRecord);
      const hasSeed = state.materialEntries.some(
        (e) => String(e.calc_id) === String(opts.seedRecord.calc_id)
      );
      if (!hasSeed) {
        state.materialEntries.unshift(entryFromRecord(opts.seedRecord));
      } else if (seedKey) {
        // Ensure seeded values win for matching material.
        state.materialEntries = state.materialEntries.map((e) => {
          if (String(e.calc_id) === String(opts.seedRecord.calc_id)) {
            return entryFromRecord(opts.seedRecord);
          }
          return e;
        });
      }
    }

    const first = state.materialEntries[0] || {};
    $('mbc-calc-id').value = first.calc_id || '';
    state.selectedCalcId = first.calc_id || null;
    $('mbc-ps-id').value = prefill.planner_ps_id || '';
    $('mbc-ps-search').value = prefill.planner_ps_id || '';
    $('mbc-part-no').value = prefill.part_no || '';
    $('mbc-material').value =
      first.material_type_grade ||
      prefill.material_inventory_code ||
      prefill.material_type_grade ||
      '';
    state.uom = first.material_uom || prefill.material_uom || 'mm';
    if (!opts.keepMode) setSlipDate(todayISO());
    if (prefill.order_qty != null) $('mbc-order-qty').value = prefill.order_qty;
    if (!opts.keepMode) {
      $('mbc-stock-in').value = '';
      $('mbc-stock-out').value = '';
      state.selectedCncs = [];
      state.opAssignments = {};
    } else if (opts.seedRecord) {
      $('mbc-stock-in').value = opts.seedRecord.stock_in_operator || '';
      $('mbc-stock-out').value = opts.seedRecord.stock_out_operator || '';
      state.opAssignments = assignmentMapFromRecord(opts.seedRecord);
      state.selectedCncs = opts.seedRecord.cnc_machines || [];
      if (opts.seedRecord.order_qty != null) {
        $('mbc-order-qty').value = opts.seedRecord.order_qty;
      }
      if (opts.seedRecord.slip_date) setSlipDate(opts.seedRecord.slip_date);
    }

    renderMaterialList();
    updateSummary();
    await loadOperationsForPs(prefill.planner_ps_id, prefill.part_no);

    const names = state.materialEntries
      .map((m) => m.material_type_grade || m.material_inventory_code)
      .filter(Boolean);
    setStatus(
      names.length
        ? prefill.planner_ps_id +
            ' - ' +
            names.length +
            ' BOM material' +
            (names.length === 1 ? '' : 's') +
            ': ' +
            names.join(', ')
        : prefill.planner_ps_id + ' - BOM material not found',
      'ok'
    );
  }

  function hideHits() {
    const box = $('mbc-ps-hits');
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
    state.hits = [];
    state.hitIndex = -1;
  }

  function renderHits(hits) {
    const box = $('mbc-ps-hits');
    state.hits = hits || [];
    state.hitIndex = -1;
    if (!state.hits.length) {
      hideHits();
      return;
    }
    box.innerHTML = state.hits
      .map((h, i) => {
        const part = String(h.part_no || '').replace(/\uFFFD/g, '').trim();
        const desc = String(h.description || '').replace(/\uFFFD/g, '').trim();
        const bits = [part, desc].filter(Boolean).join(' - ');
        return (
          '<button type="button" class="mbc-hit" data-index="' +
          i +
          '"><strong>' +
          escapeHtml(h.planner_ps_id) +
          '</strong><small>' +
          escapeHtml(bits || '') +
          (bits ? ' - ' : '') +
          'qty ' +
          fmt(h.display_qty, 0) +
          '</small></button>'
        );
      })
      .join('');
    box.hidden = false;
  }

  async function searchPs(query) {
    const q = String(query || '').trim();
    if (q.length < 2) {
      hideHits();
      return;
    }
    const data = await json(API + '/ps-search?q=' + encodeURIComponent(q));
    renderHits(data.results || []);
  }

  function bindEvents() {
    $('mbc-new-btn').addEventListener('click', () => openCreateModal());
    $('mbc-modal-close').addEventListener('click', () => closeCreateModal());
    $('mbc-modal-cancel-btn').addEventListener('click', () => closeCreateModal());
    $('mbc-submit-btn').addEventListener('click', () => submitOrSave());
    $('mbc-save-btn').addEventListener('click', () => submitOrSave());
    $('mbc-edit-cancel-btn').addEventListener('click', () => closeEdit());

    $('mbc-create-modal').addEventListener('click', (ev) => {
      if (ev.target === $('mbc-create-modal')) closeCreateModal();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && state.mode === 'create') closeCreateModal();
    });

    $('mbc-order-qty').addEventListener('input', () => {
      syncMaterialEntriesFromDom();
      renderMaterialList();
    });

    let trackTimer = null;
    $('mbc-track-search').addEventListener('input', () => {
      clearTimeout(trackTimer);
      trackTimer = setTimeout(() => {
        loadRecords().catch(() => renderTable($('mbc-track-search').value));
      }, 250);
    });

    $('mbc-ps-search').addEventListener('input', () => {
      if (state.mode === 'edit') return;
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        searchPs($('mbc-ps-search').value).catch(() => hideHits());
      }, 220);
    });

    $('mbc-ps-search').addEventListener('keydown', (ev) => {
      if (state.mode === 'edit') return;
      if ($('mbc-ps-hits').hidden) return;
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        state.hitIndex = Math.min(state.hitIndex + 1, state.hits.length - 1);
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        state.hitIndex = Math.max(state.hitIndex - 1, 0);
      } else if (ev.key === 'Enter' && state.hitIndex >= 0) {
        ev.preventDefault();
        const hit = state.hits[state.hitIndex];
        if (hit) {
          hideHits();
          loadFromPs(hit.planner_ps_id).catch((e) => setStatus(e.message, 'error'));
        }
        return;
      } else if (ev.key === 'Escape') {
        hideHits();
        return;
      } else {
        return;
      }
      document.querySelectorAll('.mbc-hit').forEach((el, i) => {
        el.classList.toggle('is-active', i === state.hitIndex);
      });
    });

    $('mbc-ps-hits').addEventListener('click', (ev) => {
      const btn = ev.target.closest('.mbc-hit');
      if (!btn) return;
      const hit = state.hits[Number(btn.dataset.index)];
      if (!hit) return;
      hideHits();
      $('mbc-ps-search').value = hit.planner_ps_id;
      loadFromPs(hit.planner_ps_id).catch((e) => setStatus(e.message, 'error'));
    });

    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('.mbc-search-wrap')) hideHits();
    });

    $('mbc-table-wrap').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-action]');
      const card = ev.target.closest('.mbc-entry[data-calc-id]');
      if (!card) return;
      const calcId = Number(card.getAttribute('data-calc-id'));
      const record = state.records.find((r) => Number(r.calc_id) === calcId);
      if (!record) return;
      if (btn?.dataset.action === 'delete') {
        deleteRecord(calcId).catch((e) => setStatus(e.message, 'error'));
        return;
      }
      if (btn?.dataset.action === 'slip-pdf') {
        downloadSlipPdf(calcId).catch((e) => {
          state.mode = 'idle';
          setStatus(e.message, 'error');
        });
        return;
      }
      if (btn?.dataset.action === 'edit' || !btn) {
        openEdit(record);
      }
    });
  }

  async function boot() {
    parkForm();
    bindEvents();
    try {
      await Promise.all([loadRecords(), loadMachines()]);
    } catch (err) {
      state.mode = 'idle';
      setStatus(err.message || 'Failed to load', 'error');
      $('mbc-table-wrap').innerHTML = '<div class="mbc-empty">Could not load entries.</div>';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
