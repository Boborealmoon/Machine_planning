(() => {
  'use strict';

  const MATERIAL_ARRIVED = 'ARRIVED';

  const state = {
    items: [],
    search: '',
    issuesOnly: false,
    flag: '',
    view: 'active',
    types: new Set(['APS', 'NPS', 'SR']),
    expanded: new Set(),
    saveInFlight: new Set(),
  };

  const FLAG_META = {
    nested_assembly: ['Assembly', 'info'],
    deep_nested: ['Nested BOM', 'info'],
    leaf_component: ['Leaf component', 'info'],
    multiple_boms: ['Multiple BOMs', 'warn'],
    missing_bom: ['Missing child BOM', 'danger'],
    unresolved_bom: ['Unresolved BOM', 'danger'],
    bom_alias: ['BOM alias', 'warn'],
    repeated_component: ['Repeated component', 'info'],
    qty_mismatch: ['Qty mismatch', 'warn'],
    orphan_comp: ['Orphan component', 'warn'],
    missing_comp_sheet: ['Missing COMP sheet', 'danger'],
    stalled_child: ['Stalled', 'warn'],
  };

  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const text = (value) => String(value ?? '').trim();

  function jobType(job) {
    const typed = text(job?.ps_type).toUpperCase();
    if (typed) return typed;
    const raw = text(job?.ps_id);
    if (/\[sr\]/i.test(raw)) return 'SR';
    return raw.slice(0, 3).toUpperCase();
  }

  function fmtQty(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '-';
    return Number.isInteger(number) ? String(number) : number.toLocaleString(undefined, { maximumFractionDigits: 3 });
  }

  function fmtDate(value) {
    const raw = text(value);
    return raw ? raw.slice(0, 10) : '-';
  }

  function parseMaterialSubcon(raw) {
    const value = text(raw);
    if (!value) return { arrived: false, date: '', legacy: '' };
    if (/^arrived$/i.test(value)) return { arrived: true, date: '', legacy: '' };
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { arrived: false, date: value, legacy: '' };
    const dmy = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (dmy) {
      const day = Number(dmy[1]);
      const month = Number(dmy[2]);
      let year = Number(dmy[3]);
      if (year < 100) year += 2000;
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (!Number.isNaN(Date.parse(`${iso}T00:00:00`))) {
          return { arrived: false, date: iso, legacy: '' };
        }
      }
    }
    return { arrived: false, date: '', legacy: value };
  }

  function serializeMaterialSubcon({ arrived, date }) {
    if (arrived) return MATERIAL_ARRIVED;
    return text(date);
  }

  async function patchNotes(psNo, body) {
    const res = await fetch(`/api/sales-orders/notes/${encodeURIComponent(psNo)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  function findChild(psNo) {
    const key = text(psNo).toUpperCase();
    if (!key) return null;
    for (const job of state.items) {
      for (const child of job.children || []) {
        if (text(child.process_sheet_no).toUpperCase() === key) return child;
      }
    }
    return null;
  }

  function setFieldStatus(el, status, message) {
    if (!el) return;
    el.classList.remove('is-saving', 'is-saved', 'is-error');
    if (status) el.classList.add(status);
    const note = el.querySelector('.ap-field-status');
    if (!note) return;
    if (!message) {
      note.hidden = true;
      note.textContent = '';
      return;
    }
    note.hidden = false;
    note.textContent = message;
  }

  function flagBadge(flag) {
    const [label, tone] = FLAG_META[flag] || [flag.replaceAll('_', ' '), 'info'];
    const cls = tone === 'danger' ? 'ap-chip--danger' : (tone === 'warn' ? 'ap-chip--warn' : 'ap-chip');
    return `<span class="ap-chip ${cls}">${escapeHtml(label)}</span>`;
  }

  function routePill(child) {
    if (!child.is_subassembly && !child.missing_comp_sheet) {
      return '<span class="ap-pill ap-pill--muted">Leaf</span>';
    }
    const meta = {
      ok: ['Route OK', 'ok'],
      alias: ['Alias', 'warn'],
      missing: ['BOM missing', 'danger'],
      unresolved: ['Unresolved', 'danger'],
      history: ['History', 'ok'],
    };
    const [label, tone] = meta[child.route_status] || ['Unknown', 'warn'];
    return `<span class="ap-pill ap-pill--${tone}">${label}</span>`;
  }

  function stagePill(child) {
    const stage = text(child.current_stage_desc) || text(child.status) || '-';
    const st = text(child.current_stage_status).toUpperCase();
    let tone = 'muted';
    if (st === 'C' || /complete/i.test(stage)) tone = 'ok';
    else if (child.stalled) tone = 'warn';
    else if (stage !== '-') tone = 'ok';
    return `<span class="ap-pill ap-pill--${tone}" title="${escapeHtml(stage)}">${escapeHtml(stage.length > 28 ? `${stage.slice(0, 26)}...` : stage)}</span>`;
  }

  function materialPill(child) {
    if (child.material_in || parseMaterialSubcon(child.material_subcon).arrived) {
      return '<span class="ap-pill ap-pill--ok">In</span>';
    }
    if (child.in_house === false) {
      return '<span class="ap-pill ap-pill--muted">N/A</span>';
    }
    return '<span class="ap-pill ap-pill--warn">Pending</span>';
  }

  function childBomCode(child) {
    // Prefer the process-sheet BOM from cache; then resolved child route.
    // For leaves, selected_bom_code is the parent's route ? do not use it here.
    return (
      text(child.ps_bom_code)
      || text(child.resolved_bom_code)
      || (child.is_subassembly ? text(child.selected_bom_code) : '')
    );
  }

  function materialCellHtml(child) {
    const partNo = text(child.part_no);
    const bom = childBomCode(child);
    const psNo = text(child.process_sheet_no);
    if (!partNo) return materialPill(child);
    const title = bom
      ? `View BOM materials for ${partNo} ? ${bom}`
      : `View BOM materials for ${partNo}`;
    return `
      <button type="button"
        class="ap-material-btn"
        data-action="open-material"
        data-part-no="${escapeHtml(partNo)}"
        data-bom-code="${escapeHtml(bom)}"
        data-process-sheet="${escapeHtml(psNo)}"
        title="${escapeHtml(title)}"
        aria-label="${escapeHtml(title)}">
        ${materialPill(child)}
        <span class="ap-material-btn-label">Check</span>
      </button>`;
  }

  function queuePill(child) {
    const machines = child.queued_machines || [];
    if (machines.length) {
      return `<span class="ap-pill ap-pill--ok" title="${escapeHtml(machines.join(', '))}">Queued ${escapeHtml(machines.length)}</span>`;
    }
    if (child.needs_scheduling) {
      return '<span class="ap-pill ap-pill--warn">Needs sched.</span>';
    }
    if (child.ready) {
      return '<span class="ap-pill ap-pill--ok">Ready</span>';
    }
    return '<span class="ap-pill ap-pill--muted">-</span>';
  }

  function inHouseLabel(child) {
    if (child.in_house === true) return '<span class="ap-pill ap-pill--ok">In-house</span>';
    if (child.in_house === false) return '<span class="ap-pill ap-pill--muted">External</span>';
    return '<span class="ap-pill ap-pill--muted">-</span>';
  }

  function issueChips(child) {
    const flags = (child.flags || []).filter((f) => !['nested_assembly', 'deep_nested', 'leaf_component', 'repeated_component'].includes(f));
    if (!flags.length && child.repeated) {
      return flagBadge('repeated_component');
    }
    if (!flags.length) return '<span class="ap-sub">-</span>';
    return `<div class="ap-issues">${flags.map(flagBadge).join('')}</div>`;
  }

  function arrivalCell(child) {
    const psNo = text(child.process_sheet_no);
    if (!psNo) {
      return '<td class="ap-arrival-cell"><span class="ap-sub">-</span></td>';
    }
    const parsed = parseMaterialSubcon(child.material_subcon);
    const arrived = parsed.arrived || Boolean(child.material_in);
    const raw = text(child.material_subcon) || (arrived ? MATERIAL_ARRIVED : '');
    const legacyHtml = parsed.legacy
      ? `<span class="ap-arrival-legacy" title="Previous note">${escapeHtml(parsed.legacy)}</span>`
      : '';
    return `
      <td class="ap-arrival-cell${arrived ? ' has-arrived' : (parsed.date ? ' has-date' : '')}" data-ps-no="${escapeHtml(psNo)}" data-last-saved="${escapeHtml(raw)}">
        <div class="ap-arrival-controls">
          <button type="button"
            class="ap-arrived-btn${arrived ? ' is-active' : ''}"
            data-action="toggle-arrived"
            aria-pressed="${arrived ? 'true' : 'false'}"
            title="${arrived ? 'Material arrived - click to clear' : 'Mark material as arrived'}">
            <span class="ap-arrived-dot" aria-hidden="true"></span>
            Arrived
          </button>
          <input type="date"
            class="ap-arrival-date${arrived ? ' is-hidden' : ''}"
            data-action="arrival-date"
            value="${escapeHtml(arrived ? '' : parsed.date)}"
            ${arrived ? 'disabled' : ''}
            aria-label="Material arrival date">
          ${legacyHtml}
        </div>
        <span class="ap-field-status" hidden></span>
      </td>`;
  }

  function remarkCell(child) {
    const psNo = text(child.process_sheet_no);
    if (!psNo) {
      return '<td class="ap-remark-cell"><span class="ap-sub">-</span></td>';
    }
    const value = text(child.remark);
    return `
      <td class="ap-remark-cell" data-ps-no="${escapeHtml(psNo)}">
        <textarea
          class="ap-remark-input"
          rows="2"
          data-action="remark"
          data-last-saved="${escapeHtml(value)}"
          aria-label="Remark"
          placeholder="Remark">${escapeHtml(value)}</textarea>
        <span class="ap-field-status" hidden></span>
      </td>`;
  }

  function relatedHtml(job) {
    const related = Array.isArray(job.related_process_sheets) ? job.related_process_sheets : [];
    if (!related.length) return '';
    const chips = related.map((item) => {
      const href = text(item.process_sheets_url) || `/process-sheets?q=${encodeURIComponent(text(item.ps_id))}`;
      const status = text(item.status);
      const label = status ? `${text(item.ps_id)} · ${status}` : text(item.ps_id);
      return `<a class="ap-chip ap-chip--related" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
    }).join('');
    return `<div class="ap-parent-related"><span class="ap-sub">Related</span>${chips}</div>`;
  }

  function parentCell(job, rowspan) {
    const flags = (job.flags || [])
      .filter((f) => f !== 'nested_assembly')
      .slice(0, 4)
      .map(flagBadge)
      .join('');
    return `
      <td class="ap-parent-cell" rowspan="${rowspan}">
        <div class="ap-parent-block">
          <div class="ap-parent-id">${escapeHtml(job.ps_id)}</div>
          <div class="ap-parent-part">
            <span class="ap-mono">${escapeHtml(job.part_no || '-')}</span>
            <span class="ap-sub">${escapeHtml(job.part_desc || '-')}</span>
          </div>
          <div class="ap-parent-meta">
            <span class="ap-chip ap-chip--muted">${escapeHtml(job.sales_order_no || 'No SO')}</span>
            <span class="ap-chip ap-chip--muted">Due ${escapeHtml(fmtDate(job.due_date))}</span>
            <span class="ap-chip">${escapeHtml(job.readiness_label || '0/0')} ready</span>
          </div>
          ${relatedHtml(job)}
          <div class="ap-parent-meta">${flags}</div>
        </div>
      </td>`;
  }

  function detailHtml(job, child) {
    const materials = (child.leaf_materials || []).length
      ? `<ul>${child.leaf_materials.map((m) => `<li class="ap-mono">${escapeHtml(m)}</li>`).join('')}</ul>`
      : '<span class="ap-sub">No leaf materials</span>';
    const routes = (child.available_bom_codes || []).length
      ? `<ul>${child.available_bom_codes.map((c) => `<li><code>${escapeHtml(c)}</code></li>`).join('')}</ul>`
      : '<span class="ap-sub">No child BOM routes</span>';
    const expected = child.expected_qty != null ? fmtQty(child.expected_qty) : '-';
    const arrival = parseMaterialSubcon(child.material_subcon);
    const arrivalLabel = arrival.arrived || child.material_in
      ? `Arrived${child.material_in_date ? ` ${fmtDate(child.material_in_date)}` : ''}`
      : (arrival.date || arrival.legacy || '-');
    const partNo = text(child.part_no);
    const bom = childBomCode(child);
    const psNo = text(child.process_sheet_no);
    const materialBtn = partNo
      ? `<button type="button" class="ap-detail-material-btn"
           data-action="open-material"
           data-part-no="${escapeHtml(partNo)}"
           data-bom-code="${escapeHtml(bom)}"
           data-process-sheet="${escapeHtml(psNo)}">Check BOM materials</button>`
      : '';
    return `
      <tr class="ap-detail-row" data-detail-for="${escapeHtml(job.ps_id)}::${escapeHtml(child.process_sheet_no || child.part_no)}">
        <td colspan="13">
          <div class="ap-detail">
            <div>
              <h4>BOM route</h4>
              <div><code>${escapeHtml(child.selected_bom_code || '-')}</code> -> <code>${escapeHtml(child.resolved_bom_code || '-')}</code></div>
              <div class="ap-sub">Expected qty ${escapeHtml(expected)} / Actual ${escapeHtml(fmtQty(child.qty))}</div>
              ${routes}
              <div class="ap-detail-actions">
                <a href="${escapeHtml(child.process_sheets_url || '/process-sheets')}" target="_blank" rel="noopener">Open Process Sheet</a>
                <a href="${escapeHtml(child.sales_orders_url || '/sales-orders')}" target="_blank" rel="noopener">Open S/O</a>
                <a href="${escapeHtml(job.process_sheets_url || '/process-sheets')}" target="_blank" rel="noopener">Parent PS</a>
                ${materialBtn}
              </div>
            </div>
            <div>
              <h4>Leaf materials</h4>
              ${materials}
            </div>
            <div>
              <h4>Status</h4>
              <div>${stagePill(child)}</div>
              <div class="ap-sub" style="margin-top:6px">Queue: ${escapeHtml((child.queued_machines || []).join(', ') || 'none')}</div>
              <div class="ap-sub">Material arrival: ${escapeHtml(arrivalLabel)}</div>
              <div class="ap-sub">Remark: ${escapeHtml(text(child.remark) || '-')}</div>
              <div class="ap-sub">In-house: ${child.in_house === true ? 'yes' : (child.in_house === false ? 'no' : 'unknown')}</div>
            </div>
          </div>
        </td>
      </tr>`;
  }

  function childRow(job, child, isFirst, rowspan, expanded) {
    const key = `${job.ps_id}::${child.process_sheet_no || child.part_no}`;
    const parent = isFirst ? parentCell(job, rowspan) : '';
    const psLabel = text(child.process_sheet_no) || '<span class="ap-sub">Missing sheet</span>';
    return `
      <tr class="ap-row ${expanded ? 'is-expanded' : ''}" data-row-key="${escapeHtml(key)}">
        ${parent}
        <td>
          <strong>${psLabel}</strong>
          <span class="ap-sub">Seq ${escapeHtml(child.component_seq_no || '-')}</span>
        </td>
        <td>
          <strong class="ap-mono">${escapeHtml(child.part_no || '-')}</strong>
          <span class="ap-sub">${escapeHtml(child.description || '-')}</span>
        </td>
        <td class="ap-num">${escapeHtml(fmtQty(child.qty))}</td>
        <td>${inHouseLabel(child)}</td>
        <td>${stagePill(child)}</td>
        <td class="ap-material-cell">${materialCellHtml(child)}</td>
        ${arrivalCell(child)}
        ${remarkCell(child)}
        <td>${queuePill(child)}</td>
        <td>${routePill(child)}</td>
        <td>${issueChips(child)}</td>
        <td>
          <button type="button" class="ap-expand-btn" data-expand="${escapeHtml(key)}" aria-expanded="${expanded ? 'true' : 'false'}" aria-label="Toggle details">?</button>
        </td>
      </tr>
      ${expanded ? detailHtml(job, child) : ''}`;
  }

  function visibleJobs() {
    const q = state.search.toLowerCase();
    return state.items.filter((job) => {
      const type = jobType(job);
      if (!state.types.has(type)) return false;
      if (state.issuesOnly && !job.has_issues && !job.has_anomaly) return false;
      if (state.flag) {
        const jobFlags = new Set(job.flags || []);
        const childHit = (job.children || []).some((c) => (c.flags || []).includes(state.flag));
        if (!jobFlags.has(state.flag) && !childHit) return false;
      }
      if (!q) return true;
      const blob = [
        job.ps_id,
        job.part_no,
        job.part_desc,
        job.sales_order_no,
        job.bom_code,
        ...(job.related_process_sheets || []).flatMap((item) => [
          item.ps_id,
          item.ps_type,
          item.status,
          item.sales_order_no,
        ]),
        ...(job.children || []).flatMap((c) => [
          c.process_sheet_no,
          c.part_no,
          c.description,
          c.selected_bom_code,
          c.material_subcon,
          c.remark,
          ...(c.leaf_materials || []),
        ]),
      ].join(' ').toLowerCase();
      return blob.includes(q);
    });
  }

  function render() {
    const list = visibleJobs();
    const tbody = document.getElementById('ap-tbody');
    const wrap = document.getElementById('ap-table-wrap');
    const empty = document.getElementById('ap-empty');
    const summary = document.getElementById('ap-summary');

    const childCount = list.reduce((n, job) => n + (job.children || []).length, 0);
    const issueCount = list.filter((j) => j.has_issues || j.has_anomaly).length;
    summary.textContent = `${list.length} parents / ${childCount} child parts | ${issueCount} with issues | view ${state.view}`;

    if (!list.length) {
      tbody.innerHTML = '';
      wrap.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    wrap.hidden = false;

    const html = [];
    for (const job of list) {
      const children = job.children || [];
      let rowspan = Math.max(children.length, 1);
      for (const child of children) {
        const key = `${job.ps_id}::${child.process_sheet_no || child.part_no}`;
        if (state.expanded.has(key)) rowspan += 1;
      }
      children.forEach((child, idx) => {
        const key = `${job.ps_id}::${child.process_sheet_no || child.part_no}`;
        html.push(childRow(job, child, idx === 0, rowspan, state.expanded.has(key)));
      });
    }
    tbody.innerHTML = html.join('');
  }

  function applyArrivalCellState(cell, raw, child) {
    if (!cell) return;
    const parsed = parseMaterialSubcon(raw);
    const arrived = parsed.arrived || Boolean(child?.material_in);
    cell.classList.toggle('has-arrived', arrived);
    cell.classList.toggle('has-date', Boolean(parsed.date) && !arrived);
    const btn = cell.querySelector('[data-action="toggle-arrived"]');
    const dateInput = cell.querySelector('[data-action="arrival-date"]');
    if (btn) {
      btn.classList.toggle('is-active', arrived);
      btn.setAttribute('aria-pressed', arrived ? 'true' : 'false');
      btn.title = arrived ? 'Material arrived - click to clear' : 'Mark material as arrived';
    }
    if (dateInput) {
      dateInput.value = arrived ? '' : (parsed.date || '');
      dateInput.disabled = arrived;
      dateInput.classList.toggle('is-hidden', arrived);
    }
  }

  function syncArrivalCell(cell, raw, child) {
    if (!cell) return;
    const parsed = parseMaterialSubcon(raw);
    const arrived = parsed.arrived || Boolean(child?.material_in);
    cell.dataset.lastSaved = text(raw) || (arrived ? MATERIAL_ARRIVED : '');
    applyArrivalCellState(cell, raw, child);
  }

  function updateMaterialPillInRow(cell, child) {
    const row = cell?.closest('tr.ap-row');
    if (!row || !child) return;
    const cells = row.querySelectorAll(':scope > td');
    const hasParent = row.querySelector(':scope > td.ap-parent-cell');
    const materialIdx = hasParent ? 6 : 5;
    const materialTd = cells[materialIdx];
    if (materialTd) materialTd.innerHTML = materialCellHtml(child);
  }

  async function saveArrival(cell, nextValue) {
    const psNo = text(cell?.dataset?.psNo);
    if (!psNo || !cell) return;
    const key = `${psNo}::material_subcon`;
    if (state.saveInFlight.has(key)) return;
    const savedValue = text(nextValue);
    const lastSaved = text(cell.dataset.lastSaved);
    if (savedValue === lastSaved) return;

    state.saveInFlight.add(key);
    setFieldStatus(cell, 'is-saving', 'Saving...');
    try {
      const data = await patchNotes(psNo, { material_subcon: savedValue });
      const saved = text(data.material_subcon);
      const child = findChild(psNo);
      if (child) {
        child.material_subcon = saved;
        if (Object.prototype.hasOwnProperty.call(data, 'material_in')) {
          child.material_in = Boolean(data.material_in);
        } else {
          child.material_in = parseMaterialSubcon(saved).arrived;
        }
        if (Object.prototype.hasOwnProperty.call(data, 'material_in_date')) {
          child.material_in_date = data.material_in_date || null;
        } else if (!child.material_in) {
          child.material_in_date = null;
        }
      }
      syncArrivalCell(cell, saved, child);
      updateMaterialPillInRow(cell, child);
      setFieldStatus(cell, 'is-saved', 'Saved');
      window.setTimeout(() => {
        if (text(cell.dataset.lastSaved) === saved) setFieldStatus(cell, '', '');
      }, 1500);
    } catch (err) {
      syncArrivalCell(cell, lastSaved, findChild(psNo));
      setFieldStatus(cell, 'is-error', err.message || 'Save failed');
    } finally {
      state.saveInFlight.delete(key);
    }
  }

  async function saveRemark(input) {
    const cell = input?.closest('.ap-remark-cell');
    const psNo = text(cell?.dataset?.psNo);
    if (!psNo || !input) return;
    const key = `${psNo}::remark`;
    if (state.saveInFlight.has(key)) return;
    const nextValue = String(input.value || '').trim();
    const lastSaved = String(input.dataset.lastSaved || '');
    if (nextValue === lastSaved) return;

    state.saveInFlight.add(key);
    setFieldStatus(cell, 'is-saving', 'Saving...');
    try {
      const data = await patchNotes(psNo, { mtl_part_order: nextValue });
      const saved = text(data.mtl_part_order);
      input.value = saved;
      input.dataset.lastSaved = saved;
      const child = findChild(psNo);
      if (child) child.remark = saved;
      setFieldStatus(cell, 'is-saved', 'Saved');
      window.setTimeout(() => {
        if (input.dataset.lastSaved === saved) setFieldStatus(cell, '', '');
      }, 1500);
    } catch (err) {
      input.value = lastSaved;
      setFieldStatus(cell, 'is-error', err.message || 'Save failed');
    } finally {
      state.saveInFlight.delete(key);
    }
  }

  async function load(refresh = false) {
    const loading = document.getElementById('ap-loading');
    const error = document.getElementById('ap-error');
    loading.hidden = false;
    error.hidden = true;
    document.getElementById('ap-table-wrap').hidden = true;
    document.getElementById('ap-empty').hidden = true;

    const params = new URLSearchParams({ view: state.view });
    if (refresh) params.set('refresh', '1');
    try {
      const res = await fetch(`/api/assembly-parts?${params.toString()}`);
      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        throw new Error(
          snippet
            ? `API returned non-JSON (HTTP ${res.status}): ${snippet}`
            : `API returned no JSON (HTTP ${res.status}). The query likely timed out — retry or stay on Active.`
        );
      }
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      state.items = payload.items || [];
      loading.hidden = true;
      render();
    } catch (err) {
      loading.hidden = true;
      error.hidden = false;
      error.textContent = err.message || String(err);
    }
  }

  function bind() {
    document.getElementById('ap-search').addEventListener('input', (e) => {
      state.search = e.target.value || '';
      render();
    });
    document.getElementById('ap-issues-only').addEventListener('change', (e) => {
      state.issuesOnly = !!e.target.checked;
      render();
    });
    document.getElementById('ap-flag-filter').addEventListener('change', (e) => {
      state.flag = e.target.value || '';
      render();
    });
    document.getElementById('ap-refresh').addEventListener('click', () => load(true));

    document.querySelectorAll('[data-ap-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-ap-type');
        if (state.types.has(type)) {
          if (state.types.size === 1) return;
          state.types.delete(type);
          btn.classList.remove('is-active');
          btn.setAttribute('aria-pressed', 'false');
        } else {
          state.types.add(type);
          btn.classList.add('is-active');
          btn.setAttribute('aria-pressed', 'true');
        }
        render();
      });
    });

    document.querySelectorAll('[data-ap-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = btn.getAttribute('data-ap-view');
        if (view === state.view) return;
        state.view = view;
        document.querySelectorAll('[data-ap-view]').forEach((b) => {
          const on = b.getAttribute('data-ap-view') === view;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        load(false);
      });
    });

    const tbody = document.getElementById('ap-tbody');
    tbody.addEventListener('click', (e) => {
      const materialBtn = e.target.closest('[data-action="open-material"]');
      if (materialBtn) {
        e.preventDefault();
        e.stopPropagation();
        const partNo = text(materialBtn.dataset.partNo);
        if (!partNo || typeof window.openMaterialModal !== 'function') return;
        window.openMaterialModal({
          partNo,
          bomCode: text(materialBtn.dataset.bomCode),
          processSheetNo: text(materialBtn.dataset.processSheet),
        });
        return;
      }

      const arrivedBtn = e.target.closest('[data-action="toggle-arrived"]');
      if (arrivedBtn) {
        e.preventDefault();
        e.stopPropagation();
        const cell = arrivedBtn.closest('.ap-arrival-cell');
        if (!cell) return;
        const parsed = parseMaterialSubcon(cell.dataset.lastSaved);
        const nextArrived = !parsed.arrived;
        const dateInput = cell.querySelector('[data-action="arrival-date"]');
        const date = nextArrived ? '' : text(dateInput?.value);
        const nextValue = serializeMaterialSubcon({ arrived: nextArrived, date });
        applyArrivalCellState(cell, nextValue, { material_in: nextArrived });
        saveArrival(cell, nextValue);
        return;
      }

      const btn = e.target.closest('[data-expand]');
      if (!btn) return;
      const key = btn.getAttribute('data-expand');
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      render();
    });

    tbody.addEventListener('change', (e) => {
      const dateInput = e.target.closest('[data-action="arrival-date"]');
      if (!dateInput || dateInput.disabled) return;
      e.stopPropagation();
      const cell = dateInput.closest('.ap-arrival-cell');
      if (!cell) return;
      const date = text(dateInput.value);
      const nextValue = serializeMaterialSubcon({ arrived: false, date });
      applyArrivalCellState(cell, nextValue, { material_in: false });
      saveArrival(cell, nextValue);
    });

    tbody.addEventListener('focusout', (e) => {
      const remark = e.target.closest('[data-action="remark"]');
      if (remark) saveRemark(remark);
    });

    tbody.addEventListener('keydown', (e) => {
      const remark = e.target.closest('[data-action="remark"]');
      if (!remark) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        remark.blur();
      }
    });
  }

  bind();
  load(false);
})();
