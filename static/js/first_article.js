(() => {
  const API = {
    list: '/api/first-article',
    search: '/api/first-article/search',
    candidates: '/api/first-article/candidates',
    bulk: '/api/first-article/bulk',
    pics: '/api/first-article/pics',
    newParts: '/api/first-article/new-parts',
  };
  const CHECK_FIELDS = [
    { prefix: 'tooling', label: 'Tooling' },
    { prefix: 'fixture', label: 'Fixture/Jig' },
    { prefix: 'gauges', label: 'Gauges/CMM' },
  ];
  const PS_TYPE_ORDER = ['APS', 'NPS', 'MPS', 'PPS', 'CPS', 'SR', 'OTHER'];

  const state = {
    tab: 'flagged',
    rows: [],
    newRows: [],
    newLoaded: false,
    newFilter: '',
    newTypes: new Set(['APS', 'NPS']),
    pics: [],
    machines: [],
    filter: '',
    searchHits: [],
    searchTimer: 0,
    saveTimers: {},
    busy: false,
    bulk: {
      jobs: [],
      types: [],
      query: '',
      psType: '',
      selected: new Set(),
      scope: 'all',
      truncated: false,
      total: 0,
    },
  };

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

  function dash(value) {
    const text = String(value == null ? '' : value).trim();
    return text || '\u2014';
  }

  async function api(url, options) {
    const opts = { ...(options || {}) };
    const timeoutMs = Number(opts.timeoutMs) || 0;
    delete opts.timeoutMs;
    let timer = 0;
    if (timeoutMs > 0) {
      const ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
    }
    try {
      const res = await fetch(url, opts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('Timed out loading first article tracker');
      }
      throw err;
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  function setStatus(id, message, kind) {
    const el = $(id);
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
    el.classList.toggle('is-error', kind === 'error');
    el.classList.toggle('is-saved', kind === 'saved');
  }

  function showAlert(message) {
    const el = $('fa-alert');
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || '';
  }

  function rowById(id) {
    return state.rows.find((row) => Number(row.first_article_id) === Number(id));
  }

  function filteredRows() {
    const needle = state.filter.trim().toUpperCase();
    if (!needle) return state.rows;
    return state.rows.filter((row) => {
      const blob = [
        row.process_sheet_no,
        row.pp_voucher_no,
        row.part_no,
        row.part_description,
        row.machine_cnc,
        ...(row.machine_codes || []),
        row.current_stage_desc,
        row.erp_last_stage_desc,
        row.so_scope,
        row.sales_order_no,
        row.remarks,
        row.tooling_text,
        row.fixture_text,
        row.gauges_text,
        ...(row.pics || []).map((pic) => pic.name),
      ].join(' ').toUpperCase();
      return blob.includes(needle);
    });
  }

  function parseIsoDate(value) {
    const text = String(value == null ? '' : value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const dmy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!dmy) return '';
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    if (day < 1 || day > 31 || month < 1 || month > 12) return '';
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return Number.isNaN(Date.parse(`${iso}T00:00:00`)) ? '' : iso;
  }

  function parseCheckValue(row, prefix) {
    const ready = !!row[`${prefix}_tick`];
    const raw = String(row[`${prefix}_text`] || '').trim();
    if (ready) return { ready: true, date: '', legacy: '' };
    const date = parseIsoDate(raw);
    if (date) return { ready: false, date, legacy: '' };
    return { ready: false, date: '', legacy: raw };
  }

  function checkCellStateClass(parsed) {
    if (parsed.ready) return ' is-ready';
    if (parsed.date) return ' has-date';
    return '';
  }

  function picOptions(selectedIds, includeBlank) {
    const selected = new Set((selectedIds || []).map(Number));
    const unused = state.pics.filter((pic) => !selected.has(Number(pic.pic_id)));
    const blank = includeBlank ? '<option value="">Add PIC...</option>' : '';
    if (!unused.length) {
      return `${blank}<option value="__new">New PIC name...</option>`;
    }
    return `${blank}${unused.map((pic) => (
      `<option value="${escapeHtml(pic.pic_id)}">${escapeHtml(pic.name)}</option>`
    )).join('')}<option value="__new">New PIC name...</option>`;
  }

  function isHistorical(row) {
    const scope = String(row?.so_scope || '').toLowerCase();
    return scope === 'complete' || !!row?.shipped_completed;
  }

  function psSourceLabel(row) {
    if (isHistorical(row)) return 'Historical';
    if (row?.from_erp_cache) return 'ERP cache';
    if (row?.flag_anyway) return 'Typed';
    return '';
  }

  function stageStatusLabel(value) {
    const code = String(value == null ? '' : value).trim().toUpperCase();
    if (code === 'I') return 'In process';
    if (code === 'R') return 'Released';
    if (code === 'P') return 'Pending';
    if (code === 'C') return 'Completed';
    return String(value == null ? '' : value).trim();
  }

  function machineCell(row) {
    return `
      <input type="text"
        class="fa-machine-input"
        data-fa-field="machine_codes"
        data-id="${row.first_article_id}"
        value="${escapeHtml(row.machine_cnc || '')}"
        placeholder="CNC 10, CNC 20"
        aria-label="Machines">
    `;
  }

  function stageCell(row) {
    const desc = String(row.current_stage_desc || '').trim();
    const status = String(row.current_stage_status_label || stageStatusLabel(row.current_stage_status) || '').trim();
    const mode = String(row.erp_stage_mode || '').trim().toLowerCase();
    const last = String(row.erp_last_stage_desc || '').trim();
    if (desc) {
      const extra = status ? `<span class="fa-stage-status">${escapeHtml(status)}</span>` : '';
      return `<span class="fa-stage-desc" title="${escapeHtml(desc)}">${escapeHtml(desc)}</span>${extra}`;
    }
    if (mode === 'completed' || isHistorical(row)) {
      const title = last ? `Last stage: ${last}` : 'All manufacturing stages marked complete in ERP';
      return `<span class="fa-stage-mode is-complete" title="${escapeHtml(title)}">All complete</span>`;
    }
    if (mode === 'unassigned') {
      return '<span class="fa-stage-mode is-none" title="No work-order stages in ERP">No WO</span>';
    }
    return escapeHtml(dash(''));
  }

  function psCell(row) {
    return `<span class="fa-mono">${escapeHtml(dash(row.process_sheet_no))}</span>`;
  }

  function checkCell(row, prefix, label) {
    const parsed = parseCheckValue(row, prefix);
    const readyCls = parsed.ready ? ' is-active' : '';
    const dateHiddenCls = parsed.ready ? ' is-hidden' : '';
    const legacy = parsed.legacy
      ? `<span class="fa-check-legacy" title="Previous note">${escapeHtml(parsed.legacy)}</span>`
      : '';
    return `
      <div class="fa-check-cell">
        <button type="button"
          class="fa-ready-toggle${readyCls}"
          data-fa-toggle="${prefix}"
          data-id="${row.first_article_id}"
          aria-pressed="${parsed.ready ? 'true' : 'false'}"
          title="${parsed.ready ? `${label} ready — click to clear` : `Mark ${label} as ready`}">
          <span class="fa-ready-dot" aria-hidden="true"></span>
          Ready
        </button>
        <input type="date"
          class="fa-check-date${dateHiddenCls}"
          data-fa-field="${prefix}_text"
          data-id="${row.first_article_id}"
          value="${escapeHtml(parsed.date)}"
          ${parsed.ready ? 'disabled' : ''}
          aria-label="${escapeHtml(label)} date">
        ${legacy}
      </div>
    `;
  }

  function picCell(row) {
    const chips = (row.pics || []).map((pic) => (
      `<span class="fa-chip">${escapeHtml(pic.name)}
        <button type="button" class="fa-chip-x" data-fa-remove-pic="${pic.pic_id}" data-id="${row.first_article_id}" aria-label="Remove ${escapeHtml(pic.name)}">\u00d7</button>
      </span>`
    )).join('');
    return `
      <div class="fa-pic-chips">${chips || '<span class="fa-muted">None</span>'}</div>
      <div class="fa-pic-add">
        <select data-fa-add-pic data-id="${row.first_article_id}" aria-label="Add PIC">
          ${picOptions(row.pic_ids, true)}
        </select>
      </div>
    `;
  }

  function programPicCell(row) {
    const ps = escapeHtml(row.process_sheet_no || row.pp_voucher_no || '');
    const chips = (row.program_pics || []).map((pic) => (
      `<span class="fa-chip">${escapeHtml(pic.name)}
        <button type="button" class="fa-chip-x" data-fa-new-remove-pic="${pic.pic_id}" data-ps="${ps}" aria-label="Remove ${escapeHtml(pic.name)}">\u00d7</button>
      </span>`
    )).join('');
    return `
      <div class="fa-pic-chips">${chips || '<span class="fa-muted">None</span>'}</div>
      <div class="fa-pic-add">
        <select data-fa-new-add-pic data-ps="${ps}" aria-label="Add programme PIC">
          ${picOptions(row.program_pic_ids, true)}
        </select>
      </div>
    `;
  }

  function renderTable() {
    const host = $('fa-table-host');
    const empty = $('fa-empty');
    const body = $('fa-table-body');
    const rows = filteredRows();
    if (!state.rows.length) {
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'No process sheets flagged yet. Search a PS number or use Bulk flag to add jobs.';
      }
      if (state.tab === 'flagged') {
        $('fa-subtitle').textContent = 'Flag a process sheet, then track tooling, fixture, gauges, and PIC.';
      }
      return;
    }
    if (!rows.length) {
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'No flagged jobs match this filter.';
      }
      return;
    }
    if (host) host.hidden = false;
    if (empty) empty.hidden = true;
    const head = document.querySelector('#fa-table thead tr');
    if (head) {
      head.innerHTML = `
        <th class="fa-col-ps">PS no.</th>
        <th>Part No.</th>
        <th>Part Description</th>
        <th class="fa-col-qty">Total Qty</th>
        <th class="fa-col-date">PO Due Date</th>
        <th class="fa-col-stage" title="Current work-order stage from ERP">ERP stage</th>
        <th class="fa-col-machine">Machine (CNC)</th>
        <th class="fa-col-edd" title="Read-only from S/O management">Stipulated Coway EDD</th>
        <th class="fa-col-pic">PIC</th>
        <th class="fa-col-check">Tooling</th>
        <th class="fa-col-check">Fixture/Jig</th>
        <th class="fa-col-check">Gauges/CMM</th>
        <th class="fa-col-remarks">Remark</th>
        <th class="fa-col-actions"></th>
      `;
    }
    body.innerHTML = rows.map((row) => {
      const historical = isHistorical(row);
      const missing = !row.in_sales_orders && !row.from_erp_cache && !historical;
      const rowClass = [missing ? 'is-missing' : '', historical ? 'is-historical' : ''].filter(Boolean).join(' ');
      const missingHint = missing ? ' title="Not found in S/O management or ERP cache"' : '';
      return `
        <tr class="${rowClass}" data-id="${row.first_article_id}"${missingHint}>
          <td>${psCell(row)}</td>
          <td class="fa-readonly">${escapeHtml(dash(row.part_no))}</td>
          <td>${escapeHtml(dash(row.part_description))}</td>
          <td class="fa-col-qty">${escapeHtml(dash(row.total_qty))}</td>
          <td class="fa-col-date">${escapeHtml(dash(row.po_due_date))}</td>
          <td class="fa-col-stage">${stageCell(row)}</td>
          <td class="fa-col-machine">${machineCell(row)}</td>
          <td class="fa-edd">${escapeHtml(dash(row.coway_proposed_edd))}</td>
          <td class="fa-col-pic">${picCell(row)}</td>
          ${CHECK_FIELDS.map((field) => {
            const parsed = parseCheckValue(row, field.prefix);
            return `<td class="fa-col-check${checkCellStateClass(parsed)}">${checkCell(row, field.prefix, field.label)}</td>`;
          }).join('')}
          <td class="fa-col-remarks">
            <textarea class="fa-remarks" data-fa-field="remarks" data-id="${row.first_article_id}" placeholder="Remarks">${escapeHtml(row.remarks || '')}</textarea>
          </td>
          <td class="fa-col-actions">
            <button type="button" class="fa-btn fa-btn--danger" data-fa-unflag="${row.first_article_id}">Remove</button>
          </td>
        </tr>
      `;
    }).join('');
    if (state.tab === 'flagged') {
      $('fa-subtitle').textContent = `${state.rows.length} flagged process sheet${state.rows.length === 1 ? '' : 's'}`;
    }
  }

  function newRowKey(row) {
    return String(row?.process_sheet_no || row?.pp_voucher_no || '').trim().toUpperCase();
  }

  function newRowPsType(row) {
    const sent = String(row?.ps_type || '').trim().toUpperCase();
    if (sent) return sent;
    const ps = String(row?.process_sheet_no || row?.pp_voucher_no || '').trim().toUpperCase();
    if (ps.startsWith('[SR]') || ps.startsWith('SR')) return 'SR';
    for (let i = 0; i < PS_TYPE_ORDER.length; i += 1) {
      const prefix = PS_TYPE_ORDER[i];
      if (prefix !== 'OTHER' && ps.startsWith(prefix)) return prefix;
    }
    return 'OTHER';
  }

  function newTypeCounts() {
    const counts = {};
    state.newRows.forEach((row) => {
      const kind = newRowPsType(row);
      counts[kind] = (counts[kind] || 0) + 1;
    });
    return counts;
  }

  function selectedNewTypeLabels() {
    return PS_TYPE_ORDER.filter((label) => state.newTypes.has(label));
  }

  function filteredNewRows() {
    const needle = state.newFilter.trim().toUpperCase();
    const selected = state.newTypes;
    return state.newRows.filter((row) => {
      if (!selected.size || !selected.has(newRowPsType(row))) return false;
      if (!needle) return true;
      const blob = [
        row.process_sheet_no,
        row.pp_voucher_no,
        row.part_no,
        row.part_description,
        row.posted_date,
        row.po_due_date,
        row.material_display,
        row.material_subcon,
        row.remarks,
        row.program_finish_at,
        row.ps_type,
        ...(row.program_pics || []).map((pic) => pic.name),
      ].join(' ').toUpperCase();
      return blob.includes(needle);
    });
  }

  function renderNewTypeChips() {
    const host = $('fa-new-types');
    if (!host) return;
    const counts = newTypeCounts();
    const present = PS_TYPE_ORDER.filter((label) => counts[label] || label === 'APS' || label === 'NPS');
    const allOn = present.length > 0 && present.every((label) => state.newTypes.has(label));
    const chips = [`<button type="button" class="fa-bulk-chip${allOn ? ' is-active' : ''}" data-fa-new-type="__all">All (${state.newRows.length})</button>`]
      .concat(present.map((label) => {
        const active = state.newTypes.has(label);
        return `<button type="button" class="fa-bulk-chip${active ? ' is-active' : ''}" data-fa-new-type="${escapeHtml(label)}">${escapeHtml(label)} (${counts[label] || 0})</button>`;
      }));
    host.innerHTML = chips.join('');
  }

  function toDateTimeLocal(value) {
    const text = String(value || '').trim().replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return text.slice(0, 16);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00`;
    return '';
  }

  function materialCell(row) {
    if (row.material_arrived) {
      return `<span class="fa-ready-toggle is-active fa-ready-toggle--static" title="From S/O Material in / Sub-con"><span class="fa-ready-dot" aria-hidden="true"></span> Arrived</span>`;
    }
    if (row.material_date) {
      return `<span class="fa-material-date" title="From S/O Material in / Sub-con">${escapeHtml(row.material_date)}</span>`;
    }
    if (row.material_legacy) {
      return `<span title="From S/O Material in / Sub-con">${escapeHtml(row.material_legacy)}</span>`;
    }
    return '<span class="fa-muted">\u2014</span>';
  }

  function hasBom(row) {
    return Boolean(row && row.has_bom);
  }

  function bomCell(row) {
    const partNo = String(row.part_no || '').trim();
    const bomCode = String(row.bom_code || '').trim();
    const ps = String(row.process_sheet_no || row.pp_voucher_no || '').trim();
    const exists = hasBom(row);
    if (!partNo) return '<span class="fa-muted">\u2014</span>';
    const label = exists ? 'Has BOM' : 'No BOM';
    const title = exists
      ? `View BOM materials for ${partNo}${bomCode ? ` · ${bomCode}` : ''}`
      : `No ERP material lines for ${partNo} — click to confirm`;
    return `
      <button type="button"
        class="fa-bom-btn${exists ? ' has-bom' : ' no-bom'}"
        data-action="open-material"
        data-part-no="${escapeHtml(partNo)}"
        data-bom-code="${escapeHtml(bomCode)}"
        data-process-sheet="${escapeHtml(ps)}"
        title="${escapeHtml(title)}"
        aria-label="${escapeHtml(title)}">
        <span class="fa-ready-dot" aria-hidden="true"></span>
        <span class="fa-bom-btn-label">${escapeHtml(label)}</span>
      </button>
    `;
  }

  function syncBomColumnHeader() {
    const th = document.querySelector('#fa-new-table thead th.fa-col-check, #fa-new-table thead th.fa-col-bom');
    if (!th) return;
    th.classList.add('fa-col-bom');
    th.classList.remove('fa-col-check');
    th.textContent = 'BOM';
    th.title = 'Opens BOM materials. Green = part has ERP material lines, amber = none.';
  }

  function ensureMaterialModalShell() {
    if (document.getElementById('so-material-modal')) return;
    const shell = document.createElement('div');
    shell.id = 'so-material-modal';
    shell.className = 'so-material-modal';
    shell.hidden = true;
    shell.innerHTML = `
      <div class="so-material-modal-backdrop" data-action="close-material-modal" aria-hidden="true"></div>
      <div class="so-material-modal-panel" role="dialog" aria-modal="true" aria-labelledby="so-material-modal-title">
        <div class="so-material-modal-head">
          <div>
            <p class="so-material-modal-kicker">BOM materials</p>
            <div class="so-material-modal-identifiers" id="so-material-modal-title"></div>
          </div>
          <button type="button" class="fa-btn fa-btn--ghost" id="so-material-modal-close" aria-label="Close">Close</button>
        </div>
        <div class="so-material-modal-body" id="so-material-modal-body"></div>
        <p class="so-material-modal-foot">BOM: <code>inventory_bom_listing</code> · Inventory: <code>ic_inventory_enquiry_summary_view</code></p>
      </div>
    `;
    document.body.appendChild(shell);
  }

  function loadMaterialModalScript() {
    if (typeof window.openMaterialModal === 'function') return Promise.resolve();
    if (window.__faMaterialModalLoading) return window.__faMaterialModalLoading;
    window.__faMaterialModalLoading = new Promise((resolve) => {
      const existing = document.querySelector('script[src*="material_modal.js"]');
      const done = () => resolve();
      if (existing) {
        existing.addEventListener('load', done);
        existing.addEventListener('error', done);
        return;
      }
      const script = document.createElement('script');
      script.src = '/static/js/material_modal.js?v=fa-20260824-6';
      script.onload = done;
      script.onerror = done;
      document.head.appendChild(script);
    });
    return window.__faMaterialModalLoading;
  }

  async function openBomModal(btn) {
    const partNo = String(btn.getAttribute('data-part-no') || '').trim();
    if (!partNo) return;
    ensureMaterialModalShell();
    await loadMaterialModalScript();
    if (typeof window.openMaterialModal !== 'function') {
      showAlert('Could not open BOM materials');
      return;
    }
    window.openMaterialModal({
      partNo,
      bomCode: btn.getAttribute('data-bom-code') || '',
      processSheetNo: btn.getAttribute('data-process-sheet') || '',
    });
  }

  function updateNewCount() {
    const count = $('fa-new-count');
    const visible = filteredNewRows().length;
    if (!count) return;
    if (!state.newLoaded) {
      count.hidden = true;
      return;
    }
    count.hidden = false;
    count.textContent = String(visible);
  }

  function renderNewTable() {
    const host = $('fa-new-table-host');
    const empty = $('fa-new-empty');
    const body = $('fa-new-table-body');
    const rows = filteredNewRows();
    renderNewTypeChips();
    updateNewCount();
    if (state.tab === 'new') {
      if (!state.newLoaded) {
        $('fa-subtitle').textContent = 'Loading NEW parts from S/O management...';
      } else {
        const counts = newTypeCounts();
        const present = PS_TYPE_ORDER.filter((label) => counts[label]);
        const allSelected = present.length > 0 && present.every((label) => state.newTypes.has(label));
        const labels = selectedNewTypeLabels().join(' / ') || 'selected types';
        $('fa-subtitle').textContent = allSelected
          ? `${state.newRows.length} NEW part${state.newRows.length === 1 ? '' : 's'} from active S/O management`
          : `${rows.length} NEW ${labels} part${rows.length === 1 ? '' : 's'} of ${state.newRows.length}`;
      }
    }
    if (!state.newRows.length) {
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'No NEW parts in active S/O management. The NEW tag is the same as S/O management (no prior process sheet history).';
      }
      return;
    }
    if (!rows.length) {
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = state.newTypes.size
          ? 'No NEW parts match this type or search filter.'
          : 'Select a process sheet type to view NEW parts.';
      }
      return;
    }
    if (host) host.hidden = false;
    if (empty) empty.hidden = true;
    if (!body) return;
    syncBomColumnHeader();
    body.innerHTML = rows.map((row) => {
      const ps = escapeHtml(row.process_sheet_no || row.pp_voucher_no || '');
      const exists = hasBom(row);
      return `
        <tr data-ps="${escapeHtml(row.process_sheet_no || '')}" data-pp="${escapeHtml(row.pp_voucher_no || '')}">
          <td class="fa-mono">${escapeHtml(dash(row.process_sheet_no))}</td>
          <td class="fa-readonly">
            ${escapeHtml(dash(row.part_no))}
            <span class="fa-new-part-badge" title="New part — no prior process sheet history">NEW</span>
          </td>
          <td>${escapeHtml(dash(row.part_description))}</td>
          <td class="fa-col-date">${escapeHtml(dash(row.posted_date))}</td>
          <td class="fa-col-date">${escapeHtml(dash(row.po_due_date))}</td>
          <td class="fa-col-qty">${escapeHtml(dash(row.total_qty))}</td>
          <td class="fa-col-bom${exists ? ' has-bom' : ' no-bom'}">${bomCell(row)}</td>
          <td class="fa-col-material${row.material_arrived ? ' is-ready' : (row.material_date ? ' has-date' : '')}">${materialCell(row)}</td>
          <td class="fa-col-pic">${programPicCell(row)}</td>
          <td class="fa-col-remarks">
            <textarea class="fa-remarks" data-fa-new-field="remarks" data-ps="${ps}" placeholder="Remarks">${escapeHtml(row.remarks || '')}</textarea>
          </td>
          <td class="fa-col-finish">
            <input type="datetime-local" class="fa-finish-input" data-fa-new-field="program_finish_at" data-ps="${ps}"
                   value="${escapeHtml(toDateTimeLocal(row.program_finish_at))}" aria-label="Programme estimated finish">
          </td>
        </tr>
      `;
    }).join('');
  }

  function setTab(tab, options) {
    const persistHash = options && options.persistHash;
    const next = tab === 'new' ? 'new' : 'flagged';
    state.tab = next;
    document.querySelectorAll('[data-fa-tab]').forEach((btn) => {
      const active = btn.getAttribute('data-fa-tab') === next;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const flagged = $('fa-panel-flagged');
    const neu = $('fa-panel-new');
    if (flagged) flagged.hidden = next !== 'flagged';
    if (neu) neu.hidden = next !== 'new';
    if (persistHash !== false) {
      const hash = next === 'new' ? '#new' : '#flagged';
      if (window.location.hash !== hash) {
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
      }
    }
    if (next === 'new') {
      renderNewTable();
      if (!state.newLoaded) loadNewParts();
    } else {
      renderTable();
    }
  }

  function renderPicList() {
    const list = $('fa-pic-list');
    const empty = $('fa-pic-empty');
    if (!list) return;
    if (!state.pics.length) {
      list.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = state.pics.map((pic) => (
      `<li>
        <span>${escapeHtml(pic.name)}</span>
        <button type="button" class="fa-btn fa-btn--danger" data-fa-delete-pic="${pic.pic_id}">Delete</button>
      </li>`
    )).join('');
  }

  function jobKey(job) {
    return String(job?.process_sheet_no || job?.pp_voucher_no || '').trim().toUpperCase();
  }

  function applyRow(updated) {
    if (!updated || !updated.first_article_id) return;
    const index = state.rows.findIndex((row) => Number(row.first_article_id) === Number(updated.first_article_id));
    if (index >= 0) state.rows[index] = updated;
    else state.rows.unshift(updated);
    renderTable();
  }

  async function loadTracker() {
    const loading = $('fa-loading');
    const empty = $('fa-empty');
    if (state.tab === 'flagged') {
      if (loading) loading.hidden = false;
      if (empty) empty.hidden = true;
    }
    showAlert('');
    try {
      const data = await api(API.list, { timeoutMs: 30000 });
      state.rows = data.rows || [];
      state.pics = data.pics || [];
      state.machines = data.machines || [];
      renderPicList();
      renderTable();
    } catch (err) {
      showAlert(err.message || 'Could not load first article tracker');
      if (!state.rows.length && empty) {
        empty.hidden = false;
        empty.textContent = 'Could not load the tracker. Try Refresh.';
      }
    } finally {
      if (loading && state.tab === 'flagged') loading.hidden = true;
    }
  }

  async function loadNewParts() {
    const loading = $('fa-loading');
    const empty = $('fa-new-empty');
    if (state.tab === 'new') {
      if (loading) loading.hidden = false;
      if (empty) empty.hidden = true;
    }
    showAlert('');
    try {
      const data = await api(API.newParts, { timeoutMs: 45000 });
      state.newRows = data.rows || [];
      if (Array.isArray(data.pics)) {
        state.pics = data.pics;
        renderPicList();
      }
      state.newLoaded = true;
      renderNewTable();
    } catch (err) {
      showAlert(err.message || 'Could not load NEW parts');
      state.newLoaded = true;
      if (!state.newRows.length && empty) {
        empty.hidden = false;
        empty.textContent = 'Could not load NEW parts. Open S/O management once, then Refresh.';
      }
      updateNewCount();
    } finally {
      if (loading && state.tab === 'new') loading.hidden = true;
    }
  }

  function newRowByPs(ps) {
    const key = String(ps || '').trim().toUpperCase();
    return state.newRows.find((row) => newRowKey(row) === key);
  }

  function applyNewRow(updated, { render } = {}) {
    if (!updated) return;
    const key = newRowKey(updated);
    const index = state.newRows.findIndex((row) => newRowKey(row) === key);
    if (index >= 0) state.newRows[index] = { ...state.newRows[index], ...updated };
    else state.newRows.unshift(updated);
    if (render !== false) renderNewTable();
  }

  async function saveNewPatch(ps, patch, { render } = {}) {
    const row = newRowByPs(ps);
    const data = await api(API.newParts, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        process_sheet_no: ps,
        pp_voucher_no: row?.pp_voucher_no || '',
        ...patch,
      }),
    });
    applyNewRow(data.row, { render });
    return data.row;
  }

  function hideSearch() {
    const list = $('fa-ps-results');
    if (!list) return;
    list.hidden = true;
    list.innerHTML = '';
    $('fa-ps-search')?.setAttribute('aria-expanded', 'false');
  }

  function renderSearchHits(hits, status) {
    const list = $('fa-ps-results');
    if (!list) return;
    list.hidden = false;
    $('fa-ps-search')?.setAttribute('aria-expanded', 'true');
    if (status) {
      list.innerHTML = `<div class="fa-typeahead-status">${escapeHtml(status)}</div>`;
      return;
    }
    if (!hits.length) {
      const query = String($('fa-ps-search')?.value || '').trim();
      const already = state.rows.some((row) => String(row.process_sheet_no || '').trim().toUpperCase() === query.toUpperCase());
      state.searchHits = query ? [{
        process_sheet_no: query,
        pp_voucher_no: '',
        already_flagged: already,
        flag_anyway: true,
      }] : [];
      if (!query) {
        list.innerHTML = '<div class="fa-typeahead-status">No matching process sheet in S/O management.</div>';
        return;
      }
      hits = state.searchHits;
    }
    list.innerHTML = hits.map((hit, index) => {
      const flagged = hit.already_flagged;
      const desc = [hit.part_no, hit.part_description].filter(Boolean).join(' | ');
      const source = psSourceLabel(hit);
      const action = flagged ? 'Already flagged' : (hit.flag_anyway ? 'Flag anyway' : 'Flag');
      return `
        <button type="button" class="fa-typeahead-item${flagged ? ' is-flagged' : ''}${index === 0 ? ' is-active' : ''}"
                role="option" data-index="${index}" ${flagged ? 'disabled' : ''}>
          <span class="fa-typeahead-main">
            <span class="fa-typeahead-code">${escapeHtml(hit.process_sheet_no || hit.pp_voucher_no)}</span>
            <span class="fa-typeahead-desc">${escapeHtml(desc || (hit.flag_anyway ? 'Not listed in S/O management' : 'No description'))}</span>
            ${source ? `<span class="fa-typeahead-meta">${escapeHtml(source)}</span>` : ''}
          </span>
          <span class="fa-typeahead-action">${action}</span>
        </button>
      `;
    }).join('');
  }

  async function runSearch(query) {
    const needle = String(query || '').trim();
    if (needle.length < 2) {
      hideSearch();
      return;
    }
    renderSearchHits([], 'Searching...');
    try {
      const data = await api(`${API.search}?q=${encodeURIComponent(needle)}`);
      if (String($('fa-ps-search')?.value || '').trim() !== needle) return;
      state.searchHits = data.rows || [];
      renderSearchHits(state.searchHits);
    } catch (err) {
      renderSearchHits([], err.message || 'Search failed');
    }
  }

  async function flagHit(hit) {
    if (!hit || hit.already_flagged) return;
    setStatus('fa-add-status', 'Flagging...');
    try {
      const data = await api(API.list, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          process_sheet_no: hit.process_sheet_no,
          pp_voucher_no: hit.pp_voucher_no,
        }),
      });
      applyRow(data.row);
      $('fa-ps-search').value = '';
      hideSearch();
      setStatus('fa-add-status', data.created ? `Flagged ${data.row.process_sheet_no}` : `${data.row.process_sheet_no} is already flagged`, 'saved');
    } catch (err) {
      setStatus('fa-add-status', err.message || 'Could not flag process sheet', 'error');
    }
  }

  async function flagTyped() {
    const processSheetNo = String($('fa-ps-search')?.value || '').trim();
    if (!processSheetNo) {
      setStatus('fa-add-status', 'Type a process sheet number first', 'error');
      return;
    }
    const first = state.searchHits.find((hit) => !hit.already_flagged);
    await flagHit(first || { process_sheet_no: processSheetNo, pp_voucher_no: '' });
  }

  async function savePatch(id, patch) {
    const data = await api(`${API.list}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    applyRow(data.row);
    return data.row;
  }

  function queueSave(id, patch, delay) {
    const key = `${id}:${Object.keys(patch).join(',')}`;
    clearTimeout(state.saveTimers[key]);
    state.saveTimers[key] = setTimeout(() => {
      savePatch(id, patch).catch((err) => showAlert(err.message || 'Save failed'));
    }, delay || 0);
  }

  async function addPicName(name) {
    const data = await api(API.pics, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (data.pic && !state.pics.some((pic) => Number(pic.pic_id) === Number(data.pic.pic_id))) {
      state.pics.push(data.pic);
      state.pics.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    renderPicList();
    return data.pic;
  }

  function openPicModal() {
    const modal = $('fa-pic-modal');
    if (!modal) return;
    renderPicList();
    modal.hidden = false;
    $('fa-pic-name')?.focus();
  }

  function closePicModal() {
    const modal = $('fa-pic-modal');
    if (!modal) return;
    modal.hidden = true;
  }

  function filteredBulkJobs() {
    const needle = state.bulk.query.trim().toUpperCase();
    const wanted = String(state.bulk.psType || '').toUpperCase();
    const wantedScope = String(state.bulk.scope || 'all').toLowerCase();
    return (state.bulk.jobs || []).filter((job) => {
      const kind = String(job.ps_type || 'OTHER').toUpperCase();
      if (wanted && kind !== wanted) return false;
      if (wantedScope === 'active' && isHistorical(job)) return false;
      if (wantedScope === 'complete' && !isHistorical(job)) return false;
      if (!needle) return true;
      const blob = [
        job.process_sheet_no,
        job.pp_voucher_no,
        job.part_no,
        job.part_description,
        job.sales_order_no,
        job.ps_type,
      ].join(' ').toUpperCase();
      return blob.includes(needle);
    });
  }

  function renderBulkTypes() {
    const host = $('fa-bulk-types');
    if (!host) return;
    const chips = [{ ps_type: '', count: state.bulk.total || state.bulk.jobs.length, label: 'All' }]
      .concat((state.bulk.types || []).map((item) => ({
        ps_type: item.ps_type,
        count: item.count,
        label: item.ps_type,
      })));
    host.innerHTML = chips.map((chip) => {
      const active = String(state.bulk.psType || '') === String(chip.ps_type || '');
      return `<button type="button" class="fa-bulk-chip${active ? ' is-active' : ''}" data-fa-ps-type="${escapeHtml(chip.ps_type)}">${escapeHtml(chip.label)} (${chip.count})</button>`;
    }).join('');
  }

  function renderBulkScopes() {
    const host = $('fa-bulk-scopes');
    if (!host) return;
    const allCount = (state.bulk.jobs || []).length;
    const historicalCount = (state.bulk.jobs || []).filter(isHistorical).length;
    const chips = [
      { scope: 'all', count: allCount, label: 'All' },
      { scope: 'active', count: allCount - historicalCount, label: 'Active' },
      { scope: 'complete', count: historicalCount, label: 'Historical' },
    ];
    host.innerHTML = chips.map((chip) => {
      const active = String(state.bulk.scope || 'all') === String(chip.scope);
      return `<button type="button" class="fa-bulk-chip${active ? ' is-active' : ''}" data-fa-scope="${escapeHtml(chip.scope)}">${escapeHtml(chip.label)} (${chip.count})</button>`;
    }).join('');
  }

  function renderBulkList() {
    const body = $('fa-bulk-body');
    const wrap = $('fa-bulk-table-wrap');
    const empty = $('fa-bulk-empty');
    const loading = $('fa-bulk-loading');
    const checkAll = $('fa-bulk-check-all');
    if (loading) loading.hidden = true;
    const rows = filteredBulkJobs();
    const selectable = rows.filter((job) => !job.already_flagged);
    if (!rows.length) {
      if (wrap) wrap.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = state.bulk.jobs.length
          ? 'No matching process sheets.'
          : 'No process sheets found.';
      }
    } else {
      if (wrap) wrap.hidden = false;
      if (empty) empty.hidden = true;
      body.innerHTML = rows.map((job) => {
        const key = jobKey(job);
        const flagged = !!job.already_flagged;
        const checked = !flagged && state.bulk.selected.has(key);
        const desc = job.part_description || '';
        return `
          <tr class="${flagged ? 'is-flagged' : ''}${checked ? ' is-selected' : ''}" data-key="${escapeHtml(key)}">
            <td class="fa-bulk-check">
              <input type="checkbox" data-fa-bulk-key="${escapeHtml(key)}" ${flagged ? 'disabled' : ''} ${checked ? 'checked' : ''} aria-label="Select ${escapeHtml(job.process_sheet_no || key)}">
            </td>
            <td class="fa-mono">${escapeHtml(dash(job.process_sheet_no))}${isHistorical(job) ? ' <span class="fa-ps-badge">Historical</span>' : ''}</td>
            <td><span class="fa-ps-type">${escapeHtml(job.ps_type || 'OTHER')}</span></td>
            <td class="fa-readonly">${escapeHtml(dash(job.part_no))}</td>
            <td>${escapeHtml(dash(desc))}</td>
            <td class="fa-col-qty">${escapeHtml(dash(job.total_qty))}</td>
          </tr>
        `;
      }).join('');
    }
    const selectedCount = state.bulk.selected.size;
    const countEl = $('fa-bulk-count');
    if (countEl) {
      const extra = state.bulk.truncated ? ` Showing first ${state.bulk.jobs.length} of ${state.bulk.total}.` : '';
      countEl.textContent = `${selectedCount} selected.${extra}`;
    }
    if (checkAll) {
      const selectedVisible = selectable.filter((job) => state.bulk.selected.has(jobKey(job))).length;
      checkAll.disabled = !selectable.length;
      checkAll.checked = selectable.length > 0 && selectedVisible === selectable.length;
      checkAll.indeterminate = selectedVisible > 0 && selectedVisible < selectable.length;
    }
    const apply = $('fa-bulk-apply');
    if (apply) apply.disabled = selectedCount === 0 || state.busy;
  }

  async function loadBulkCandidates() {
    const loading = $('fa-bulk-loading');
    const empty = $('fa-bulk-empty');
    const wrap = $('fa-bulk-table-wrap');
    if (loading) loading.hidden = false;
    if (empty) empty.hidden = true;
    if (wrap) wrap.hidden = true;
    setStatus('fa-bulk-status', '');
    try {
      const data = await api(`${API.candidates}?limit=2500`, { timeoutMs: 45000 });
      state.bulk.jobs = data.rows || [];
      state.bulk.types = data.types || [];
      state.bulk.total = Number(data.total || state.bulk.jobs.length);
      state.bulk.truncated = !!data.truncated;
      const known = new Set(state.bulk.jobs.map(jobKey));
      state.bulk.selected = new Set([...state.bulk.selected].filter((key) => known.has(key)));
      renderBulkScopes();
      renderBulkTypes();
      renderBulkList();
    } catch (err) {
      state.bulk.jobs = [];
      state.bulk.types = [];
      renderBulkScopes();
      renderBulkTypes();
      renderBulkList();
      setStatus('fa-bulk-status', err.message || 'Could not load process sheets', 'error');
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function openBulkModal() {
    const modal = $('fa-bulk-modal');
    if (!modal) return;
    state.bulk.query = '';
    state.bulk.psType = '';
    state.bulk.scope = 'all';
    state.bulk.selected = new Set();
    if ($('fa-bulk-search')) $('fa-bulk-search').value = '';
    modal.hidden = false;
    renderBulkScopes();
    renderBulkTypes();
    renderBulkList();
    loadBulkCandidates();
    $('fa-bulk-search')?.focus();
  }

  function closeBulkModal() {
    const modal = $('fa-bulk-modal');
    if (!modal) return;
    modal.hidden = true;
  }

  async function applyBulkFlag() {
    const keys = [...state.bulk.selected];
    if (!keys.length) return;
    const byKey = new Map(state.bulk.jobs.map((job) => [jobKey(job), job]));
    const items = keys.map((key) => {
      const job = byKey.get(key);
      return {
        process_sheet_no: job?.process_sheet_no || key,
        pp_voucher_no: job?.pp_voucher_no || '',
      };
    });
    state.busy = true;
    renderBulkList();
    setStatus('fa-bulk-status', `Flagging ${items.length} process sheet${items.length === 1 ? '' : 's'}...`);
    try {
      const data = await api(API.bulk, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
        timeoutMs: 60000,
      });
      (data.created || []).forEach(applyRow);
      (data.already_flagged || []).forEach(applyRow);
      const created = Number(data.created_count || 0);
      const skipped = Number(data.already_flagged_count || 0);
      const parts = [];
      if (created) parts.push(`Flagged ${created}`);
      if (skipped) parts.push(`${skipped} already flagged`);
      setStatus('fa-add-status', parts.join('. ') || 'No new process sheets flagged', 'saved');
      closeBulkModal();
    } catch (err) {
      setStatus('fa-bulk-status', err.message || 'Could not bulk flag process sheets', 'error');
    } finally {
      state.busy = false;
      renderBulkList();
    }
  }

  function bind() {
    $('fa-refresh')?.addEventListener('click', () => {
      if (state.tab === 'new') loadNewParts();
      else loadTracker();
    });
    document.querySelectorAll('[data-fa-tab]').forEach((btn) => {
      btn.addEventListener('click', () => setTab(btn.getAttribute('data-fa-tab')));
    });
    $('fa-new-filter')?.addEventListener('input', (e) => {
      state.newFilter = e.target.value || '';
      renderNewTable();
    });
    $('fa-new-types')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-fa-new-type]');
      if (!chip) return;
      const value = chip.getAttribute('data-fa-new-type') || '';
      const counts = newTypeCounts();
      const present = PS_TYPE_ORDER.filter((label) => counts[label] || label === 'APS' || label === 'NPS');
      if (value === '__all') {
        const allOn = present.length > 0 && present.every((label) => state.newTypes.has(label));
        state.newTypes = allOn ? new Set(['APS', 'NPS']) : new Set(present);
      } else if (state.newTypes.has(value)) {
        state.newTypes.delete(value);
      } else {
        state.newTypes.add(value);
      }
      renderNewTable();
    });
    $('fa-manage-pics')?.addEventListener('click', openPicModal);
    $('fa-pic-modal-close')?.addEventListener('click', closePicModal);
    $('fa-pic-modal')?.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'fa-pic-modal') closePicModal();
    });
    $('fa-bulk-flag')?.addEventListener('click', openBulkModal);
    $('fa-flag-one')?.addEventListener('click', () => flagTyped());
    $('fa-bulk-modal-close')?.addEventListener('click', closeBulkModal);
    $('fa-bulk-modal')?.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'fa-bulk-modal') closeBulkModal();
    });
    $('fa-bulk-search')?.addEventListener('input', (e) => {
      state.bulk.query = e.target.value || '';
      renderBulkList();
    });
    $('fa-bulk-types')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-fa-ps-type]');
      if (!chip) return;
      state.bulk.psType = chip.getAttribute('data-fa-ps-type') || '';
      renderBulkTypes();
      renderBulkList();
    });
    $('fa-bulk-scopes')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-fa-scope]');
      if (!chip) return;
      state.bulk.scope = chip.getAttribute('data-fa-scope') || 'all';
      renderBulkScopes();
      renderBulkList();
    });
    $('fa-bulk-body')?.addEventListener('change', (e) => {
      const box = e.target.closest('[data-fa-bulk-key]');
      if (!box) return;
      const key = box.getAttribute('data-fa-bulk-key');
      if (box.checked) state.bulk.selected.add(key);
      else state.bulk.selected.delete(key);
      renderBulkList();
    });
    $('fa-bulk-check-all')?.addEventListener('change', (e) => {
      const on = !!e.target.checked;
      filteredBulkJobs().forEach((job) => {
        if (job.already_flagged) return;
        const key = jobKey(job);
        if (on) state.bulk.selected.add(key);
        else state.bulk.selected.delete(key);
      });
      renderBulkList();
    });
    $('fa-bulk-clear')?.addEventListener('click', () => {
      state.bulk.selected = new Set();
      renderBulkList();
    });
    $('fa-bulk-apply')?.addEventListener('click', () => applyBulkFlag());
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('fa-bulk-modal')?.hidden) {
        closeBulkModal();
        return;
      }
      if (!$('fa-pic-modal')?.hidden) {
        closePicModal();
        return;
      }
    });

    $('fa-filter')?.addEventListener('input', (e) => {
      state.filter = e.target.value || '';
      renderTable();
    });

    $('fa-new-table-body')?.addEventListener('click', async (e) => {
      const removePic = e.target.closest('[data-fa-new-remove-pic]');
      if (removePic) {
        const ps = removePic.getAttribute('data-ps');
        const picId = Number(removePic.getAttribute('data-fa-new-remove-pic'));
        const row = newRowByPs(ps);
        const next = (row?.program_pic_ids || []).filter((value) => Number(value) !== picId);
        try {
          await saveNewPatch(ps, { program_pic_ids: next });
        } catch (err) {
          showAlert(err.message || 'Could not remove PIC');
        }
        return;
      }
      const materialBtn = e.target.closest('[data-action="open-material"]');
      if (materialBtn) {
        try {
          await openBomModal(materialBtn);
        } catch (err) {
          showAlert(err.message || 'Could not open BOM materials');
        }
      }
    });
    $('fa-new-table-body')?.addEventListener('change', async (e) => {
      const addPic = e.target.closest('[data-fa-new-add-pic]');
      if (addPic) {
        const ps = addPic.getAttribute('data-ps');
        const value = addPic.value;
        addPic.value = '';
        if (!value) return;
        try {
          let picId = value;
          if (value === '__new') {
            const name = window.prompt('PIC name');
            if (!name || !name.trim()) return;
            const pic = await addPicName(name.trim());
            picId = pic && pic.pic_id;
          }
          const row = newRowByPs(ps);
          const next = Array.from(new Set([...(row?.program_pic_ids || []), Number(picId)])).filter(Boolean);
          await saveNewPatch(ps, { program_pic_ids: next });
        } catch (err) {
          showAlert(err.message || 'Could not add PIC');
        }
        return;
      }
      const fieldEl = e.target.closest('[data-fa-new-field]');
      if (!fieldEl || fieldEl.tagName === 'TEXTAREA') return;
      const ps = fieldEl.getAttribute('data-ps');
      const field = fieldEl.getAttribute('data-fa-new-field');
      try {
        await saveNewPatch(ps, { [field]: fieldEl.value || '' }, { render: false });
      } catch (err) {
        showAlert(err.message || 'Save failed');
      }
    });
    $('fa-new-table-body')?.addEventListener('input', (e) => {
      const fieldEl = e.target.closest('[data-fa-new-field]');
      if (!fieldEl || fieldEl.tagName !== 'TEXTAREA') return;
      const ps = fieldEl.getAttribute('data-ps');
      const field = fieldEl.getAttribute('data-fa-new-field');
      const key = `new:${ps}:${field}`;
      clearTimeout(state.saveTimers[key]);
      state.saveTimers[key] = setTimeout(() => {
        saveNewPatch(ps, { [field]: fieldEl.value || '' }, { render: false })
          .catch((err) => showAlert(err.message || 'Save failed'));
      }, 450);
    });

    $('fa-ps-search')?.addEventListener('input', (e) => {
      clearTimeout(state.searchTimer);
      const value = e.target.value || '';
      state.searchTimer = setTimeout(() => runSearch(value), 220);
    });
    $('fa-ps-search')?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideSearch();
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = state.searchHits.find((hit) => !hit.already_flagged);
        if (first) flagHit(first);
        else flagTyped();
      }
    });
    $('fa-ps-results')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.fa-typeahead-item');
      if (!btn || btn.disabled) return;
      const hit = state.searchHits[Number(btn.getAttribute('data-index'))];
      flagHit(hit);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.fa-typeahead')) hideSearch();
    });

    $('fa-table-body')?.addEventListener('change', async (e) => {
      const addPic = e.target.closest('[data-fa-add-pic]');
      if (addPic) {
        const id = addPic.getAttribute('data-id');
        const value = addPic.value;
        addPic.value = '';
        if (!value) return;
        try {
          let picId = value;
          if (value === '__new') {
            const name = window.prompt('PIC name');
            if (!name || !name.trim()) return;
            const pic = await addPicName(name.trim());
            picId = pic && pic.pic_id;
          }
          const row = rowById(id);
          const next = Array.from(new Set([...(row?.pic_ids || []), Number(picId)])).filter(Boolean);
          await savePatch(id, { pic_ids: next });
        } catch (err) {
          showAlert(err.message || 'Could not add PIC');
        }
        return;
      }
      const fieldEl = e.target.closest('[data-fa-field]');
      if (!fieldEl) return;
      const id = fieldEl.getAttribute('data-id');
      const field = fieldEl.getAttribute('data-fa-field');
      const value = fieldEl.type === 'checkbox' ? fieldEl.checked : fieldEl.value;
      const patch = { [field]: value };
      if (field.endsWith('_text') && fieldEl.classList.contains('fa-check-date')) {
        const prefix = field.slice(0, -5);
        const date = parseIsoDate(value);
        patch[field] = date;
        patch[`${prefix}_tick`] = false;
        patch[`${prefix}_mode`] = date ? 'text' : 'tick';
      }
      try {
        await savePatch(id, patch);
      } catch (err) {
        showAlert(err.message || 'Save failed');
      }
    });

    $('fa-table-body')?.addEventListener('input', (e) => {
      const fieldEl = e.target.closest('[data-fa-field]');
      if (!fieldEl) return;
      if (fieldEl.tagName !== 'TEXTAREA' && !fieldEl.classList.contains('fa-check-text') && !fieldEl.classList.contains('fa-machine-input')) return;
      const id = fieldEl.getAttribute('data-id');
      const field = fieldEl.getAttribute('data-fa-field');
      queueSave(id, { [field]: fieldEl.value }, 450);
    });

    $('fa-table-body')?.addEventListener('click', async (e) => {
      const toggle = e.target.closest('[data-fa-toggle]');
      if (toggle) {
        const prefix = toggle.getAttribute('data-fa-toggle');
        const id = toggle.getAttribute('data-id');
        const row = rowById(id);
        const nextReady = !row?.[`${prefix}_tick`];
        const dateEl = toggle.parentElement?.querySelector('.fa-check-date');
        const date = nextReady ? '' : parseIsoDate(dateEl?.value);
        try {
          await savePatch(id, {
            [`${prefix}_tick`]: nextReady,
            [`${prefix}_mode`]: nextReady || !date ? 'tick' : 'text',
            [`${prefix}_text`]: date,
          });
        } catch (err) {
          showAlert(err.message || 'Save failed');
        }
        return;
      }
      const unflag = e.target.closest('[data-fa-unflag]');
      if (unflag) {
        const id = Number(unflag.getAttribute('data-fa-unflag'));
        const row = rowById(id);
        if (!window.confirm(`Remove ${row?.process_sheet_no || 'this process sheet'} from the tracker?`)) return;
        try {
          await api(`${API.list}/${id}`, { method: 'DELETE' });
          state.rows = state.rows.filter((item) => Number(item.first_article_id) !== id);
          renderTable();
        } catch (err) {
          showAlert(err.message || 'Could not remove row');
        }
        return;
      }
      const removePic = e.target.closest('[data-fa-remove-pic]');
      if (removePic) {
        const id = removePic.getAttribute('data-id');
        const picId = Number(removePic.getAttribute('data-fa-remove-pic'));
        const row = rowById(id);
        const next = (row?.pic_ids || []).filter((value) => Number(value) !== picId);
        try {
          await savePatch(id, { pic_ids: next });
        } catch (err) {
          showAlert(err.message || 'Could not remove PIC');
        }
      }
    });

    $('fa-pic-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('fa-pic-name');
      const name = String(input?.value || '').trim();
      if (!name) return;
      try {
        const pic = await addPicName(name);
        input.value = '';
        setStatus('fa-pic-status', pic && pic.name ? `Saved ${pic.name}` : 'Saved', 'saved');
        renderTable();
        renderNewTable();
      } catch (err) {
        setStatus('fa-pic-status', err.message || 'Could not add PIC', 'error');
      }
    });

    $('fa-pic-list')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-fa-delete-pic]');
      if (!btn) return;
      const picId = Number(btn.getAttribute('data-fa-delete-pic'));
      const pic = state.pics.find((item) => Number(item.pic_id) === picId);
      if (!window.confirm(`Delete ${pic?.name || 'this PIC'} from the list?`)) return;
      try {
        await api(`${API.pics}/${picId}`, { method: 'DELETE' });
        state.pics = state.pics.filter((item) => Number(item.pic_id) !== picId);
        state.rows = state.rows.map((row) => {
          const picIds = (row.pic_ids || []).filter((value) => Number(value) !== picId);
          return {
            ...row,
            pic_ids: picIds,
            pics: (row.pics || []).filter((item) => Number(item.pic_id) !== picId),
          };
        });
        state.newRows = state.newRows.map((row) => {
          const picIds = (row.program_pic_ids || []).filter((value) => Number(value) !== picId);
          return {
            ...row,
            program_pic_ids: picIds,
            program_pics: (row.program_pics || []).filter((item) => Number(item.pic_id) !== picId),
          };
        });
        renderPicList();
        renderTable();
        renderNewTable();
        setStatus('fa-pic-status', `Removed ${pic?.name || 'PIC'}`, 'saved');
      } catch (err) {
        setStatus('fa-pic-status', err.message || 'Could not delete PIC', 'error');
      }
    });
  }

  bind();
  ensureMaterialModalShell();
  loadMaterialModalScript();
  if (String(window.location.hash || '').toLowerCase() === '#new') {
    setTab('new', { persistHash: false });
  }
  loadTracker();
})();
