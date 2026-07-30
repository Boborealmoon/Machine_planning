// PPS tracking - PS-level controls + columns/cards views.
const PPS_VIEW_KEY = 'pps.viewStyle';

const ppsState = {
  trackingRows: [],
  trackingSearch: '',
  trackingStatus: 'active',
  trackingHideZeroValue: true,
  trackingIncludesCompleted: false,
  trackingModalKey: '',
  openKey: '',
  view: localStorage.getItem(PPS_VIEW_KEY) === 'cards' ? 'cards' : 'columns',
};

const ppsRemarkTimers = new Map();

function ppsEscapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function ppsFormatDate(value) {
  if (value == null || value === '') return '-';
  const text = String(value).trim();
  if (!text) return '-';
  const date = new Date(text.includes('T') ? text : text.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) {
    const m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return text.slice(0, 10);
  }
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function ppsFormatQty(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value == null || value === '' ? '-' : String(value);
  return number.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function ppsDisplay(value) {
  if (value == null) return '-';
  const text = String(value).trim();
  return text || '-';
}

function ppsRowKey(row) {
  return [row.source_ps_id || row.ps_id || '', row.pp_partial_no || 1].join('|');
}

function ppsPsId(row) {
  return String(row.display_ps_id || row.source_ps_id || row.ps_id || '').split('::')[0];
}

function ppsIsShippedComplete(row) {
  return !!(row?.shipped_completed || row?.is_completed);
}

function ppsStageKind(row) {
  if (ppsIsShippedComplete(row)) return 'completed';
  const stageNo = Number(row?.current_stage_no || 0);
  const finished = Number(row?.finished_qty || row?.wo_qty_produced || 0);
  const status = String(row?.current_stage_status || row?.execution_status || '')
    .trim()
    .toUpperCase();
  if (
    (!Number.isFinite(stageNo) || stageNo <= 0)
    && finished <= 0
    && !['I', 'IN_PROCESS', 'C', 'COMPLETED'].includes(status)
  ) {
    return 'not-started';
  }
  return 'active';
}

function ppsStatusLabel(kind) {
  if (kind === 'completed') return 'Done';
  if (kind === 'not-started') return 'Waiting';
  return 'Active';
}

function ppsStageLabel(row) {
  const number = Number(row.current_stage_no || 0);
  const description = String(row.current_stage_desc || '').trim();
  if (number && description) return `${number} - ${description}`;
  if (description) return description;
  if (number) return `Stage ${number}`;
  return ppsIsShippedComplete(row) ? 'Fully shipped' : 'Not started';
}

function ppsIsOverdue(row) {
  if (ppsIsShippedComplete(row) || !row?.due_date) return false;
  const text = String(row.due_date).trim();
  const due = new Date(text.includes('T') ? text : text.replace(' ', 'T'));
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return due < today;
}

function ppsHaystack(row) {
  return [
    row.ps_id,
    row.source_ps_id,
    row.display_ps_id,
    row.inventory_code,
    row.part_no,
    row.part_desc,
    row.current_stage_desc,
    row.source_voucher_no,
    row.pps_remarks,
  ].filter((value) => value != null).join(' ').toLowerCase();
}

function ppsFilteredRows() {
  const search = ppsState.trackingSearch.trim().toLowerCase();
  return ppsState.trackingRows.filter((row) => {
    const kind = ppsStageKind(row);
    const hasSalesOrderValue = row.sales_order_value != null
      && String(row.sales_order_value).trim() !== '';
    const salesOrderValue = Number(row.sales_order_value);
    if (
      ppsState.trackingHideZeroValue
      && hasSalesOrderValue
      && Number.isFinite(salesOrderValue)
      && Math.abs(salesOrderValue) < 0.0001
    ) {
      return false;
    }
    if (ppsState.trackingStatus !== 'all' && kind !== ppsState.trackingStatus) {
      return false;
    }
    return !search || ppsHaystack(row).includes(search);
  });
}

function ppsUpdateTabCounts() {
  const counts = { active: 0, completed: 0, 'not-started': 0, all: 0 };
  for (const row of ppsState.trackingRows) {
    const hasSalesOrderValue = row.sales_order_value != null
      && String(row.sales_order_value).trim() !== '';
    const salesOrderValue = Number(row.sales_order_value);
    if (
      ppsState.trackingHideZeroValue
      && hasSalesOrderValue
      && Number.isFinite(salesOrderValue)
      && Math.abs(salesOrderValue) < 0.0001
    ) {
      continue;
    }
    counts[ppsStageKind(row)] += 1;
    counts.all += 1;
  }
  document.querySelectorAll('[data-count]').forEach((el) => {
    el.textContent = String(counts[el.getAttribute('data-count')] ?? 0);
  });
}

function ppsApplyViewChrome() {
  const board = document.getElementById('pps-board');
  board?.classList.toggle('pps-board--columns', ppsState.view === 'columns');
  board?.classList.toggle('pps-board--cards', ppsState.view === 'cards');
  document.querySelectorAll('.pps-view-btn').forEach((btn) => {
    const active = btn.getAttribute('data-view') === ppsState.view;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function ppsSetView(view) {
  ppsState.view = view === 'cards' ? 'cards' : 'columns';
  localStorage.setItem(PPS_VIEW_KEY, ppsState.view);
  ppsState.openKey = '';
  ppsApplyViewChrome();
  ppsRender();
}

function ppsFlagButtonHtml(flagged) {
  return `
    <button type="button" class="pps-flag-btn${flagged ? ' is-on' : ''}" data-field="flagged"
      aria-pressed="${flagged ? 'true' : 'false'}" title="${flagged ? 'Clear flag' : 'Flag this PS'}">
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M3 1.5v13M3 2.5h8.2l-1.4 2.6 1.4 2.6H3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
    </button>
  `;
}

function ppsAsDateInput(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const weekMatch = text.match(/^(\d{4})-W(\d{2})$/i);
  if (!weekMatch) return '';
  // Convert ISO week to that week's Monday for the date input.
  const year = Number(weekMatch[1]);
  const week = Number(weekMatch[2]);
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const day = simple.getUTCDay();
  const isoMonday = new Date(simple);
  const diff = day <= 4 ? day - 1 : day - 8;
  isoMonday.setUTCDate(simple.getUTCDate() - diff);
  return isoMonday.toISOString().slice(0, 10);
}

function ppsStageCellHtml(row) {
  const kind = ppsStageKind(row);
  const key = ppsRowKey(row);
  return `
    <button type="button" class="pps-stage-btn" data-stage-popup="${ppsEscapeHtml(key)}" title="View full route stages">
      <span class="pps-dot pps-dot--${kind}" aria-hidden="true"></span>
      <span class="pps-stage-btn-text">
        <span class="pps-stage-name">${ppsEscapeHtml(ppsStageLabel(row))}</span>
        <span class="pps-stage-kind pps-stage-kind--${kind}">${ppsEscapeHtml(ppsStatusLabel(kind))}</span>
      </span>
    </button>
  `;
}

function ppsControlsHtml(row, compact = false) {
  const flagged = !!row.pps_flagged;
  const remarks = row.pps_remarks || '';
  const material = row.pps_material_date || '';
  const week = row.pps_delivery_week || '';
  const cls = compact ? 'pps-sheet-controls pps-sheet-controls--compact' : 'pps-sheet-controls';
  return `
    <div class="${cls}" data-ps-controls data-key="${ppsEscapeHtml(ppsRowKey(row))}">
      <label class="pps-field pps-field--remarks">
        <span>Remarks</span>
        <textarea data-field="remarks" rows="2" placeholder="PS notes...">${ppsEscapeHtml(remarks)}</textarea>
      </label>
      <label class="pps-field pps-field--flag">
        <span>Flag</span>
        ${ppsFlagButtonHtml(flagged)}
      </label>
      <label class="pps-field">
        <span>Material date</span>
        <input data-field="material_date" type="date" value="${ppsEscapeHtml(material)}">
      </label>
      <label class="pps-field">
        <span>Delivery date</span>
        <input data-field="delivery_week" type="date" value="${ppsEscapeHtml(ppsAsDateInput(week))}">
      </label>
      <div class="pps-op-save" data-save-status aria-live="polite"></div>
    </div>
  `;
}

function ppsFindRowByKey(key) {
  return ppsState.trackingRows.find((item) => {
    const rowKey = ppsRowKey(item);
    return rowKey === key || rowKey.toUpperCase() === String(key || '').toUpperCase();
  });
}

async function ppsSaveSheetOverlay(key, patch) {
  const row = ppsFindRowByKey(key);
  if (!row) return;
  const statusEl = Array.from(document.querySelectorAll('[data-save-status]')).find((el) => {
    const host = el.closest('[data-ps-controls], tr[data-save-for]');
    if (!host) return false;
    return (host.getAttribute('data-key') || host.getAttribute('data-save-for')) === key;
  });
  if (statusEl) {
    statusEl.className = 'pps-op-save';
    statusEl.textContent = 'Saving...';
  }
  try {
    const res = await fetch('/api/pps/sheet-overlay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        ps_id: ppsPsId(row),
        pp_partial_no: Number(row.pp_partial_no || 1),
        ...patch,
      }),
    });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Save failed (${res.status}). Restart the app if this persists.`);
    }
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `Request failed (${res.status})`);
    const overlay = data.overlay || {};
    row.overlay = overlay;
    row.pps_remarks = overlay.remarks || '';
    row.pps_flagged = !!overlay.flagged;
    row.pps_material_date = overlay.material_date || null;
    row.pps_delivery_week = overlay.delivery_week || '';
    row.has_flagged_op = !!overlay.flagged;
    if (statusEl) {
      statusEl.className = 'pps-op-save is-ok';
      statusEl.textContent = 'Saved';
    }
    ppsSyncFlagUi(key, !!overlay.flagged);
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'pps-op-save is-err';
      statusEl.textContent = err.message || 'Save failed';
    }
  }
}

function ppsSyncFlagUi(key, flagged) {
  Array.from(document.querySelectorAll('[data-key], [data-ps-controls]')).forEach((el) => {
    if (el.getAttribute('data-key') !== key) return;
    el.classList.toggle('is-flagged', flagged);
    const pillHost = el.querySelector?.('.pps-ps-id, .pps-col-ps');
    if (pillHost) {
      const pill = pillHost.querySelector('.pps-flag-pill');
      if (flagged && !pill) {
        pillHost.insertAdjacentHTML('beforeend', '<span class="pps-flag-pill">Flagged</span>');
      } else if (!flagged && pill) {
        pill.remove();
      }
    }
  });
  Array.from(document.querySelectorAll('[data-field="flagged"]')).forEach((flagBtn) => {
    const hostKey = ppsControlKeyFromEvent(flagBtn);
    if (hostKey !== key) return;
    flagBtn.classList.toggle('is-on', flagged);
    flagBtn.setAttribute('aria-pressed', flagged ? 'true' : 'false');
    flagBtn.title = flagged ? 'Clear flag' : 'Flag this PS';
  });
}

function ppsRenderColumns(rows) {
  return `
    <div class="pps-table-wrap">
      <table class="pps-grid">
        <colgroup>
          <col class="pps-w-ps">
          <col class="pps-w-part">
          <col class="pps-w-stage">
          <col class="pps-w-due">
          <col class="pps-w-so">
          <col class="pps-w-flag">
          <col class="pps-w-remarks">
          <col class="pps-w-date">
          <col class="pps-w-week">
        </colgroup>
        <thead>
          <tr>
            <th>PS</th>
            <th>Part</th>
            <th>Stage</th>
            <th>Due</th>
            <th>SO</th>
            <th class="pps-th-center">Flag</th>
            <th>Remarks</th>
            <th>Material</th>
            <th>Delivery</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => {
            const kind = ppsStageKind(row);
            const key = ppsRowKey(row);
            const overdue = ppsIsOverdue(row);
            const flagged = !!row.pps_flagged;
            const ps = row.display_ps_id || row.source_ps_id || row.ps_id;
            return `
              <tr class="${flagged ? 'is-flagged' : ''}" data-key="${ppsEscapeHtml(key)}" data-ps-controls>
                <td class="pps-col-ps">
                  <strong>${ppsEscapeHtml(ppsDisplay(ps))}</strong>
                </td>
                <td class="pps-col-part" title="${ppsEscapeHtml(ppsDisplay(row.part_desc))}">
                  <div class="pps-part-no">${ppsEscapeHtml(ppsDisplay(row.part_no || row.inventory_code))}</div>
                  <div class="pps-part-desc">${ppsEscapeHtml(ppsDisplay(row.part_desc))}</div>
                </td>
                <td class="pps-col-stage">
                  ${ppsStageCellHtml(row)}
                </td>
                <td class="pps-col-due${overdue ? ' is-overdue' : ''}">
                  <span>${ppsEscapeHtml(ppsFormatDate(row.due_date))}</span>
                  ${overdue ? '<small>Overdue</small>' : ''}
                </td>
                <td class="pps-col-so">${ppsEscapeHtml(ppsDisplay(row.source_voucher_no))}</td>
                <td class="pps-col-flag">${ppsFlagButtonHtml(flagged)}</td>
                <td class="pps-col-remarks">
                  <input data-field="remarks" type="text" value="${ppsEscapeHtml(row.pps_remarks || '')}" placeholder="Notes...">
                  <span class="pps-op-save" data-save-status aria-live="polite"></span>
                </td>
                <td class="pps-col-date">
                  <input data-field="material_date" type="date" value="${ppsEscapeHtml(row.pps_material_date || '')}">
                </td>
                <td class="pps-col-week">
                  <input data-field="delivery_week" type="date" value="${ppsEscapeHtml(ppsAsDateInput(row.pps_delivery_week))}">
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function ppsRenderCards(rows) {
  return rows.map((row) => {
    const kind = ppsStageKind(row);
    const key = ppsRowKey(row);
    const isOpen = ppsState.openKey === key;
    const overdue = ppsIsOverdue(row);
    const flagged = !!row.pps_flagged;
    const ps = row.display_ps_id || row.source_ps_id || row.ps_id;
    const so = row.source_voucher_no ? `SO ${row.source_voucher_no}` : '';
    return `
      <article class="pps-card${isOpen ? ' is-open' : ''}${flagged ? ' is-flagged' : ''}" data-key="${ppsEscapeHtml(key)}">
        <button type="button" class="pps-card-main" aria-expanded="${isOpen ? 'true' : 'false'}">
          <div class="pps-ps">
            <span class="pps-ps-id">${ppsEscapeHtml(ppsDisplay(ps))}${flagged ? '<span class="pps-flag-pill">Flagged</span>' : ''}</span>
            <span class="pps-ps-so">${ppsEscapeHtml(so || 'No sales order')}</span>
          </div>
          <div class="pps-part">
            <div class="pps-part-no">${ppsEscapeHtml(ppsDisplay(row.part_no || row.inventory_code))}</div>
            <div class="pps-part-desc" title="${ppsEscapeHtml(ppsDisplay(row.part_desc))}">${ppsEscapeHtml(ppsDisplay(row.part_desc))}</div>
          </div>
          <div class="pps-stage-cell" data-stage-popup="${ppsEscapeHtml(key)}" title="View full route stages" role="button" tabindex="0">
            <span class="pps-dot pps-dot--${kind}" aria-hidden="true"></span>
            <div class="pps-stage-text">
              <div class="pps-stage-name">${ppsEscapeHtml(ppsStageLabel(row))}</div>
              <div class="pps-stage-kind pps-stage-kind--${kind}">${ppsEscapeHtml(ppsStatusLabel(kind))}</div>
            </div>
          </div>
          <div class="pps-due${overdue ? ' is-overdue' : ''}">
            ${ppsEscapeHtml(ppsFormatDate(row.due_date))}
            ${overdue ? '<small>Overdue</small>' : ''}
          </div>
        </button>
        <div class="pps-detail" ${isOpen ? '' : 'hidden'}>
          ${isOpen ? ppsCardDetailHtml(row) : ''}
        </div>
      </article>
    `;
  }).join('');
}

function ppsCardDetailHtml(row) {
  const remaining = ppsIsShippedComplete(row) ? 0 : row.remaining_qty;
  return `
    ${ppsControlsHtml(row)}
    <div class="pps-qty">
      <div class="pps-qty-item"><span>Required</span><strong>${ppsEscapeHtml(ppsFormatQty(row.display_qty || row.wo_req_qty || row.total_qty))}</strong></div>
      <div class="pps-qty-item"><span>Produced</span><strong>${ppsEscapeHtml(ppsFormatQty(row.finished_qty || row.wo_qty_produced))}</strong></div>
      <div class="pps-qty-item"><span>Remaining</span><strong>${ppsEscapeHtml(ppsFormatQty(remaining))}</strong></div>
      <div class="pps-qty-item"><span>Shipped</span><strong>${ppsEscapeHtml(ppsFormatQty(row.qty_shipped))}</strong></div>
    </div>
    <section class="pps-panel">
      <h3>Route stages</h3>
      <ul class="pps-stages" data-stages><li class="pps-muted-text">Loading stages...</li></ul>
    </section>
  `;
}

function ppsStageScanned(row, stage) {
  const ops = Array.isArray(row?.ops) ? row.ops : (Array.isArray(row?.op_cards) ? row.op_cards : []);
  const stageNo = Number(stage?.stage_no || 0);
  const opNo = String(stage?.op_no || '').trim().toLowerCase();
  return ops.some((op) => {
    const candidateStage = Number(op.stage_no || op.source_stage_no || op.seq_no || op.op_seq_id || 0);
    const candidateOp = String(op.op_no || op.source_op_no || '').trim().toLowerCase();
    if (!((stageNo > 0 && candidateStage === stageNo) || (opNo && candidateOp === opNo))) return false;
    const status = String(op.execution_status || op.erp_execution_status || op.status || '')
      .trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');
    const produced = Number(op.cascade_output_qty || op.total_acc_qty_produced || op.wo_qty_produced || op.finished_qty || 0);
    return produced > 0 || ['I', 'IN_PROCESS', 'C', 'COMPLETED'].includes(status);
  });
}

async function ppsFillCardStages(row, panel, detailKey) {
  const stagesEl = panel.querySelector('[data-stages]');
  if (!stagesEl) return;
  try {
    const stages = await ppsFetchStages(row);
    if (ppsState.trackingModalKey !== detailKey || !panel.isConnected) return;
    stagesEl.innerHTML = ppsStagesListHtml(row, stages);
  } catch (err) {
    if (ppsState.trackingModalKey !== detailKey || !panel.isConnected) return;
    stagesEl.innerHTML = `<li class="pps-muted-text">${ppsEscapeHtml(err.message || 'Could not load stages.')}</li>`;
  }
}

async function ppsFetchStages(row) {
  const params = new URLSearchParams({
    inventory_code: String(row.inventory_code || row.part_no || ''),
    bom_code: String(row.bom_code || row.erp_bom_code || ''),
    sales_order_no: String(row.source_voucher_no || ''),
    ps_id: ppsPsId(row),
    pp_partial_no: String(row.pp_partial_no || 1),
  });
  const res = await fetch(`/api/pps/process-sheet-tracking/details?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return Array.isArray(data.bom_stages) ? data.bom_stages : [];
}

function ppsStagesListHtml(row, stages) {
  if (!stages.length) {
    return '<li class="pps-muted-text">No route stages for this BOM.</li>';
  }
  const currentNo = Number(row.current_stage_no || 0);
  return stages.map((stage) => {
    const done = ppsStageScanned(row, stage);
    const isCurrent = currentNo > 0 && Number(stage.stage_no) === currentNo;
    const cls = ['pps-stage-row', done ? 'is-done' : '', isCurrent ? 'is-current' : ''].filter(Boolean).join(' ');
    const flag = done ? 'Done' : (isCurrent ? 'Now' : 'Queued');
    return `
      <li class="${cls}">
        <span class="pps-stage-no">${ppsEscapeHtml(ppsDisplay(stage.stage_no))}</span>
        <span class="pps-stage-desc">${ppsEscapeHtml(ppsDisplay(stage.stage_desc))}</span>
        <span class="pps-stage-flag">${flag}</span>
      </li>
    `;
  }).join('');
}

function ppsCloseStageModal() {
  const modal = document.getElementById('pps-stage-modal');
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove('pps-modal-open');
  ppsState.trackingModalKey = '';
}

async function ppsOpenStageModal(key) {
  const row = ppsFindRowByKey(key);
  const modal = document.getElementById('pps-stage-modal');
  if (!row || !modal) return;
  const kind = ppsStageKind(row);
  const ps = row.display_ps_id || row.source_ps_id || row.ps_id;
  const remaining = ppsIsShippedComplete(row) ? 0 : row.remaining_qty;
  ppsState.trackingModalKey = `modal:${key}`;
  modal.hidden = false;
  document.body.classList.add('pps-modal-open');
  document.getElementById('pps-stage-modal-title').textContent = ppsDisplay(ps);
  document.getElementById('pps-stage-modal-sub').textContent =
    `${ppsStageLabel(row)} | ${ppsStatusLabel(kind)}`;
  document.getElementById('pps-stage-modal-summary').innerHTML = `
    <div class="pps-qty">
      <div class="pps-qty-item"><span>Required</span><strong>${ppsEscapeHtml(ppsFormatQty(row.display_qty || row.wo_req_qty || row.total_qty))}</strong></div>
      <div class="pps-qty-item"><span>Produced</span><strong>${ppsEscapeHtml(ppsFormatQty(row.finished_qty || row.wo_qty_produced))}</strong></div>
      <div class="pps-qty-item"><span>Remaining</span><strong>${ppsEscapeHtml(ppsFormatQty(remaining))}</strong></div>
      <div class="pps-qty-item"><span>Shipped</span><strong>${ppsEscapeHtml(ppsFormatQty(row.qty_shipped))}</strong></div>
    </div>
    <div class="pps-modal-meta">
      <div><span>Part</span><strong>${ppsEscapeHtml(ppsDisplay(row.part_no || row.inventory_code))}</strong></div>
      <div><span>Description</span><strong>${ppsEscapeHtml(ppsDisplay(row.part_desc))}</strong></div>
      <div><span>SO</span><strong>${ppsEscapeHtml(ppsDisplay(row.source_voucher_no))}</strong></div>
      <div><span>Due</span><strong class="${ppsIsOverdue(row) ? 'is-overdue' : ''}">${ppsEscapeHtml(ppsFormatDate(row.due_date))}</strong></div>
      <div><span>BOM</span><strong>${ppsEscapeHtml(ppsDisplay(row.erp_bom_code || row.bom_code))}</strong></div>
      <div><span>Status</span><strong>${ppsEscapeHtml(ppsStatusLabel(kind))}</strong></div>
    </div>
  `;
  const list = document.getElementById('pps-stage-modal-list');
  list.innerHTML = '<li class="pps-muted-text">Loading stages...</li>';
  try {
    const stages = await ppsFetchStages(row);
    if (ppsState.trackingModalKey !== `modal:${key}`) return;
    list.innerHTML = ppsStagesListHtml(row, stages);
  } catch (err) {
    if (ppsState.trackingModalKey !== `modal:${key}`) return;
    list.innerHTML = `<li class="pps-muted-text">${ppsEscapeHtml(err.message || 'Could not load stages.')}</li>`;
  }
}

function ppsRender() {
  const board = document.getElementById('pps-board');
  const empty = document.getElementById('pps-tracking-empty');
  const stats = document.getElementById('pps-stats');
  if (!board || !empty) return;
  ppsApplyViewChrome();
  ppsUpdateTabCounts();
  const rows = ppsFilteredRows();
  if (stats) {
    const label = ppsState.trackingStatus === 'all'
      ? 'all'
      : ppsStatusLabel(ppsState.trackingStatus).toLowerCase();
    stats.textContent = rows.length
      ? `${rows.length} ${label} job${rows.length === 1 ? '' : 's'}`
      : `No ${label} jobs`;
  }
  if (!rows.length) {
    board.hidden = true;
    board.innerHTML = '';
    empty.hidden = false;
    empty.textContent = ppsState.trackingRows.length
      ? 'No jobs match these filters.'
      : 'No PPS jobs available.';
    return;
  }
  empty.hidden = true;
  board.hidden = false;
  board.innerHTML = ppsState.view === 'cards'
    ? `<div class="pps-list">${ppsRenderCards(rows)}</div>`
    : ppsRenderColumns(rows);
  if (ppsState.view === 'cards' && ppsState.openKey) {
    const openCard = Array.from(board.querySelectorAll('.pps-card'))
      .find((el) => el.getAttribute('data-key') === ppsState.openKey);
    const row = ppsFindRowByKey(ppsState.openKey);
    const panel = openCard?.querySelector('.pps-detail');
    if (row && panel) {
      panel.hidden = false;
      panel.innerHTML = ppsCardDetailHtml(row);
      ppsState.trackingModalKey = ppsState.openKey;
      ppsFillCardStages(row, panel, ppsState.openKey);
    }
  }
}

function ppsToggleCard(key) {
  ppsState.openKey = ppsState.openKey === key ? '' : key;
  ppsState.trackingModalKey = '';
  ppsRender();
}

async function ppsLoadTracking({ force = false, includeCompleted = false } = {}) {
  const loading = document.getElementById('pps-tracking-loading');
  if (loading) loading.hidden = false;
  try {
    const params = new URLSearchParams();
    if (force) params.set('refresh', '1');
    if (includeCompleted) params.set('show_completed', '1');
    const query = params.toString();
    const res = await fetch(`/api/pps/process-sheet-tracking${query ? `?${query}` : ''}`, {
      headers: { Accept: 'application/json' },
    });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Unexpected response (${res.status}). Restart Flask and hard-refresh.`);
    }
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `Request failed (${res.status})`);
    ppsState.trackingRows = (Array.isArray(data.rows) ? data.rows : []).map((row) => ({
      ...row,
      pps_remarks: row.pps_remarks || row.overlay?.remarks || '',
      pps_flagged: !!(row.pps_flagged ?? row.overlay?.flagged ?? row.has_flagged_op),
      pps_material_date: row.pps_material_date || row.overlay?.material_date || null,
      pps_delivery_week: row.pps_delivery_week || row.overlay?.delivery_week || '',
    }));
    ppsState.trackingIncludesCompleted = !!data.include_completed;
    ppsRender();
  } catch (err) {
    ppsState.trackingRows = [];
    ppsRender();
    const empty = document.getElementById('pps-tracking-empty');
    if (empty) {
      empty.hidden = false;
      empty.textContent = `Failed to load: ${err.message || err}`;
    }
  } finally {
    if (loading) loading.hidden = true;
  }
}

function ppsSetStatus(status) {
  ppsState.trackingStatus = status;
  document.querySelectorAll('.pps-status-tab').forEach((tab) => {
    const active = tab.getAttribute('data-status') === status;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const needsCompleted = ['all', 'completed'].includes(status);
  if (needsCompleted && !ppsState.trackingIncludesCompleted) {
    ppsLoadTracking({ includeCompleted: true });
  } else {
    ppsRender();
  }
}

function ppsControlKeyFromEvent(target) {
  const wrap = target.closest('[data-ps-controls]');
  if (wrap?.getAttribute('data-key')) return wrap.getAttribute('data-key');
  const row = target.closest('tr[data-key]');
  return row?.getAttribute('data-key') || '';
}

document.querySelector('.pps-view-toggle')?.addEventListener('click', (event) => {
  const btn = event.target.closest('.pps-view-btn');
  if (!btn) return;
  ppsSetView(btn.getAttribute('data-view') || 'columns');
});

document.getElementById('pps-tracking-search')?.addEventListener('input', (event) => {
  ppsState.trackingSearch = event.target.value || '';
  ppsRender();
});

document.getElementById('pps-tracking-hide-zero-value')?.addEventListener('change', (event) => {
  ppsState.trackingHideZeroValue = event.target.checked;
  ppsRender();
});

document.getElementById('pps-tracking-refresh')?.addEventListener('click', () => {
  const includeCompleted = ['all', 'completed'].includes(ppsState.trackingStatus);
  ppsLoadTracking({ force: true, includeCompleted });
});

document.querySelector('.pps-status-tabs')?.addEventListener('click', (event) => {
  const tab = event.target.closest('.pps-status-tab');
  if (!tab) return;
  ppsSetStatus(tab.getAttribute('data-status') || 'active');
});

document.getElementById('pps-board')?.addEventListener('click', (event) => {
  const stageBtn = event.target.closest('[data-stage-popup]');
  if (stageBtn) {
    event.preventDefault();
    event.stopPropagation();
    const key = stageBtn.getAttribute('data-stage-popup');
    if (key) ppsOpenStageModal(key);
    return;
  }
  const flagBtn = event.target.closest('[data-field="flagged"]');
  if (flagBtn) {
    event.preventDefault();
    event.stopPropagation();
    const key = ppsControlKeyFromEvent(flagBtn);
    if (!key) return;
    const next = !flagBtn.classList.contains('is-on');
    ppsSaveSheetOverlay(key, { flagged: next });
    return;
  }
  const main = event.target.closest('.pps-card-main');
  if (!main) return;
  // Don't expand card when interacting with stage popup target inside header.
  if (event.target.closest('[data-stage-popup]')) return;
  const card = main.closest('.pps-card');
  const key = card?.getAttribute('data-key');
  if (key) ppsToggleCard(key);
});

document.getElementById('pps-board')?.addEventListener('input', (event) => {
  const field = event.target.closest('[data-field]');
  if (!field || field.dataset.field !== 'remarks') return;
  const key = ppsControlKeyFromEvent(field);
  if (!key) return;
  const existing = ppsRemarkTimers.get(key);
  if (existing) clearTimeout(existing);
  ppsRemarkTimers.set(key, setTimeout(() => {
    ppsSaveSheetOverlay(key, { remarks: field.value || '' });
  }, 450));
});

document.getElementById('pps-board')?.addEventListener('change', (event) => {
  const field = event.target.closest('[data-field]');
  if (!field) return;
  const key = ppsControlKeyFromEvent(field);
  if (!key) return;
  const name = field.dataset.field;
  if (name === 'material_date') ppsSaveSheetOverlay(key, { material_date: field.value || '' });
  if (name === 'delivery_week') ppsSaveSheetOverlay(key, { delivery_week: field.value || '' });
});

document.getElementById('pps-stage-modal')?.addEventListener('click', (event) => {
  if (event.target.id === 'pps-stage-modal' || event.target.closest('[data-pps-modal-close]')) {
    ppsCloseStageModal();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') ppsCloseStageModal();
});

ppsApplyViewChrome();
ppsLoadTracking();
