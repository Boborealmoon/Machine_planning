// MRO application — ARC format (mfg_arc_format_v1_view).

const mroState = {
  rows: [],
  historyRows: [],
  trackingRows: [],
  search: '',
  historySearch: '',
  trackingSearch: '',
  trackingStatus: 'active',
  trackingHideZeroValue: true,
  trackingIncludesCompleted: false,
  trackingModalKey: '',
  historyFlash: '',
  psTypeFilter: 'MPS',
  statusFilter: 'all',
  activeTab: 'arc',
  cachedAt: '',
  cacheTtlSec: 300,
  modalRow: null,
  soHeader: null,
  detailRow: null,
  arcVariants: ['CAAS'],
  certifyingStaff: [],
  historyLoaded: false,
  trackingLoaded: false,
  arcItemRows: [],
};

const mroNativeFetch = globalThis.fetch.bind(globalThis);

function mroFetch(input, init) {
  return mroNativeFetch(input, init).then((res) => {
    if (res.status === 401) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/mro-login?next=${next}`;
    }
    return res;
  });
}

const MRO_ARC_VARIANTS = {
  CAAS: {
    label: 'CAAS',
    desc: 'Singapore',
    correctionLabel: '12. ARC Correction (CAAS)',
    statusLabel: '11. Status/Work (CAAS)',
    correctionTemplate: '',
    usedParts: [
      { value: 'sar_145_50', label: 'SAR-145.50 Release to Service', defaultChecked: true },
      { value: 'other_block_12', label: 'Other regulation specified in Block 12 (CAAS)', defaultChecked: false },
    ],
    statusOptions: [
      'OVERHAULED',
      'INSPECTED/TESTED',
      'MODIFIED',
      'REPAIRED',
      'RETREADED',
      'REASSEMBLED',
    ],
    defaultStatus: 'INSPECTED/TESTED',
  },
  FAA: {
    label: 'FAA',
    desc: 'United States',
    correctionLabel: '12. ARC Correction (FAA)',
    statusLabel: '11. Status/Work (FAA)',
    correctionTemplate: '',
    usedParts: [
      { value: 'cfr_43_9', label: '14 CFR 43.9 Return to Service', defaultChecked: true },
      { value: 'other_block_12', label: 'Other regulation specified in Block 12 (FAA)', defaultChecked: false },
    ],
    statusOptions: [
      'OVERHAULED',
      'INSPECTED',
      'MODIFIED',
      'REPAIRED',
      'RETREADED',
      'REBUILT',
    ],
    defaultStatus: 'INSPECTED',
  },
  EASA: {
    label: 'EASA',
    desc: 'Europe',
    correctionLabel: '12. ARC Correction (EASA)',
    statusLabel: '11. Status/Work (EASA)',
    correctionTemplate: '',
    usedParts: [
      { value: 'part_145_a_50', label: 'Part-145.A.50 Release to Service', defaultChecked: true },
      { value: 'other_block_12', label: 'Other regulation specified in Block 12 (EASA)', defaultChecked: false },
    ],
    statusOptions: [
      'OVERHAULED',
      'INSPECTED/TESTED',
      'MODIFIED',
      'REPAIRED',
    ],
    defaultStatus: 'INSPECTED/TESTED',
  },
  JCAB: {
    label: 'JCAB',
    desc: 'Japan (CAAS format)',
    correctionLabel: '12. ARC Correction (JCAB)',
    statusLabel: '11. Status/Work (JCAB)',
    correctionTemplate: '',
    usedParts: [
      { value: 'sar_145_50', label: 'SAR-145.50 Release to Service', defaultChecked: true },
      { value: 'other_block_12', label: 'Other regulation specified in Block 12 (JCAB)', defaultChecked: false },
    ],
    statusOptions: [
      'OVERHAULED',
      'INSPECTED/TESTED',
      'MODIFIED',
      'REPAIRED',
      'RETREADED',
      'REASSEMBLED',
    ],
    defaultStatus: 'INSPECTED/TESTED',
  },
  CAAC: {
    label: 'CAAC',
    desc: 'Civil Aviation Administration of China',
    correctionLabel: '13. ARC Correction (CAAC)',
    statusLabel: '12. Status/Work (CAAC)',
    correctionTemplate: '',
    usedParts: [
      { value: 'caac_145_rts', label: 'CAAC Part-145 Release to Service', defaultChecked: true },
      { value: 'other_block_12', label: 'Other regulation specified in Block 13 (CAAC)', defaultChecked: false },
    ],
    statusOptions: [
      'OVERHAULED',
      'INSPECTED/TESTED',
      'MODIFIED',
      'REPAIRED',
    ],
    defaultStatus: 'INSPECTED/TESTED',
  },
};

function mroEscapeHtml(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(value);
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mroFormatDate(value) {
  if (!value) return '—';
  const text = String(value).trim();
  if (!text) return '—';
  const d = new Date(text.includes('T') ? text : text.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return text;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function mroFormatQty(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return mroEscapeHtml(String(value));
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function mroDisplay(value) {
  if (value == null || String(value).trim() === '') return '—';
  return String(value);
}

function mroRowPs(row) {
  return String(row.pp_voucher_no || row.process_sheet_no || '').trim();
}

function mroRowPsType(row) {
  const ps = mroRowPs(row).toUpperCase();
  const match = ps.match(/^([A-Z]+)/);
  return match ? match[1] : '';
}

function mroSearchHaystack(row) {
  return [
    row.sales_order_no,
    row.sales_line_item_no,
    row.pp_voucher_no,
    row.process_sheet_no,
    row.customer_code,
    row.customer_po_no,
    row.customer_po_line_item_no,
    row.inventory_code,
    row.inventory_main_desc,
    row.inventory_short_desc,
    row.sn_remarks,
    row.type,
    row.arc_status,
    row.erp_arc_status,
    row.effective_status,
    row.app_completed ? 'app completed submitted' : '',
    row.caas_doc_no,
    row.faa_doc_no,
    row.easa_doc_no,
    row.jcab_doc_no,
    row.caac_doc_no,
  ]
    .filter((v) => v != null && String(v).trim() !== '')
    .join(' ')
    .toLowerCase();
}

function mroIsEffectivelyCompleted(row) {
  // App completion is parked — only ERP status C marks a line completed.
  const erp = String(row?.erp_arc_status || row?.arc_status || '').trim().toUpperCase();
  return erp === 'C';
}

function mroStatusBadgeHtml(row) {
  const erp = String(row.erp_arc_status || row.arc_status || '').trim().toUpperCase();
  const done = mroIsEffectivelyCompleted(row);
  if (done) {
    return `<span class="mro-status-badge mro-status-badge--done" title="Completed in ERP">Completed · ERP</span>`;
  }
  const label = erp || '—';
  return `<span class="mro-status-badge mro-status-badge--open" title="ERP status ${mroEscapeHtml(label)}">${mroEscapeHtml(label === '—' ? 'Incomplete' : label)}</span>`;
}

function mroFilteredRows() {
  const search = mroState.search.trim().toLowerCase();
  const status = mroState.statusFilter;
  const psType = mroState.psTypeFilter;
  return mroState.rows.filter((row) => {
    if (psType !== 'all' && mroRowPsType(row) !== psType) {
      return false;
    }
    if (status === 'completed' && !mroIsEffectivelyCompleted(row)) {
      return false;
    }
    if (status === 'incomplete' && mroIsEffectivelyCompleted(row)) {
      return false;
    }
    if (status !== 'all' && status !== 'completed' && status !== 'incomplete') {
      // Legacy exact ERP code filter fallback
      if (String(row.arc_status || '').trim() !== status) return false;
    }
    if (!search) return true;
    return mroSearchHaystack(row).includes(search);
  });
}

function mroRenderStats() {
  const statsEl = document.getElementById('mro-stats');
  if (!statsEl) return;
  const visible = mroFilteredRows().length;
  const total = mroState.rows.length;
  const psLabel = mroState.psTypeFilter === 'all' ? 'all PS types' : mroState.psTypeFilter;
  statsEl.textContent = `${visible} shown · ${total} total · filter: ${psLabel}`;
}

function mroRenderMeta() {
  const meta = document.getElementById('mro-meta');
  if (!meta) return;
  if (!mroState.cachedAt) {
    meta.hidden = true;
    return;
  }
  meta.hidden = false;
  meta.textContent = `Live COMAIN read · cached ${mroState.cachedAt} · TTL ${mroState.cacheTtlSec}s · Completed = ERP C only · multiple ARCs allowed per process sheet · click a row for full details`;
}

function mroCell(text, className = '') {
  const display = text == null || String(text).trim() === '' ? '—' : mroEscapeHtml(String(text));
  return className ? `<td class="${className}">${display}</td>` : `<td>${display}</td>`;
}

function mroSummaryHtml(fields) {
  return fields.map(([label, value]) => `
    <div class="mro-modal-summary-row">
      <dt>${mroEscapeHtml(label)}</dt>
      <dd>${mroEscapeHtml(mroDisplay(value))}</dd>
    </div>
  `).join('');
}

function mroRenderTable() {
  const wrap = document.getElementById('mro-table-wrap');
  const body = document.getElementById('mro-table-body');
  const empty = document.getElementById('mro-empty');
  if (!wrap || !body || !empty) return;

  const rows = mroFilteredRows();
  mroRenderStats();

  if (!mroState.rows.length) {
    wrap.hidden = true;
    empty.hidden = false;
    empty.textContent = 'No MRO ARC rows returned from ERP.';
    return;
  }

  if (!rows.length) {
    wrap.hidden = true;
    empty.hidden = false;
    empty.textContent = 'No rows match your filters.';
    return;
  }

  wrap.hidden = false;
  empty.hidden = true;
  body.innerHTML = rows.map((row, index) => {
    const ps = mroRowPs(row);
    return `
    <tr class="mro-row" data-row-index="${index}" tabindex="0" title="Click for full details">
      <td class="mro-col-action">
        <button
          type="button"
          class="mro-generate-btn"
          data-row-index="${index}"
          title="Generate ARC for ${mroEscapeHtml(ps || 'this line')}"
        >ARC</button>
      </td>
      <td class="mro-col-status">${mroStatusBadgeHtml(row)}</td>
      ${mroCell(mroFormatDate(row.sales_order_date))}
      ${mroCell(ps)}
      ${mroCell(row.inventory_code)}
      ${mroCell(row.inventory_main_desc, 'mro-desc')}
      ${mroCell(row.sn_remarks)}
      ${mroCell(row.customer_code)}
      ${mroCell(row.customer_po_no)}
      ${mroCell(row.customer_po_line_item_no)}
      <td>${mroFormatQty(row.total_qty)}</td>
      ${mroCell(row.sales_order_no)}
    </tr>
  `;
  }).join('');
}

function mroTrackingIsShippedComplete(row) {
  const shipped = Number(row?.qty_shipped || 0);
  const soQty = Number(row?.so_det_qty || 0);
  return Number.isFinite(shipped) && Number.isFinite(soQty) && soQty > 0 && shipped >= soQty - 0.0001;
}

function mroTrackingStageKind(row) {
  if (mroTrackingIsShippedComplete(row)) return 'completed';
  const status = String(row.current_stage_status || row.execution_status || '').trim();
  if (!status && !Number(row.current_stage_no || 0) && !String(row.current_stage_desc || '').trim()) {
    return 'not-started';
  }
  return 'active';
}

function mroTrackingStatusLabel(row) {
  const kind = mroTrackingStageKind(row);
  if (kind === 'completed') return 'Completed';
  if (kind === 'not-started') return 'Not started';
  return 'Active';
}

function mroTrackingStateExplanation(row) {
  const kind = mroTrackingStageKind(row);
  if (kind === 'completed') {
    return 'Completed — sales-order quantity is fully shipped.';
  }
  if (kind === 'not-started') return 'Not started — no production stage has begun.';
  return 'Active — currently moving through production stages.';
}

function mroTrackingErpRecordState(row) {
  const value = String(row.status || '').trim();
  if (!value) return '—';
  return value.toLowerCase() === 'history'
    ? 'History (ERP record state only)'
    : value;
}

function mroTrackingHaystack(row) {
  return [
    row.ps_id,
    row.source_ps_id,
    row.display_ps_id,
    row.inventory_code,
    row.part_no,
    row.part_name,
    row.part_desc,
    row.current_stage_no,
    row.current_stage_desc,
    row.current_stage_status,
    row.execution_status,
    row.source_voucher_no,
  ].filter((value) => value != null).join(' ').toLowerCase();
}

function mroFilteredTrackingRows() {
  const search = mroState.trackingSearch.trim().toLowerCase();
  return mroState.trackingRows.filter((row) => {
    const kind = mroTrackingStageKind(row);
    const hasSalesOrderValue = row.sales_order_value != null
      && String(row.sales_order_value).trim() !== '';
    const salesOrderValue = Number(row.sales_order_value);
    if (
      mroState.trackingHideZeroValue
      && hasSalesOrderValue
      && Number.isFinite(salesOrderValue)
      && Math.abs(salesOrderValue) < 0.0001
    ) {
      return false;
    }
    if (mroState.trackingStatus === 'incomplete' && kind === 'completed') {
      return false;
    }
    if (
      !['all', 'incomplete'].includes(mroState.trackingStatus)
      && kind !== mroState.trackingStatus
    ) {
      return false;
    }
    return !search || mroTrackingHaystack(row).includes(search);
  });
}

function mroTrackingProgress(row) {
  const total = Number(row.display_qty || row.wo_req_qty || row.total_qty || 0);
  const finished = Number(row.finished_qty || 0);
  if (mroTrackingStageKind(row) === 'completed') return 100;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(finished)) return 0;
  return Math.max(0, Math.min(100, Math.round((finished / total) * 100)));
}

function mroTrackingStageLabel(row) {
  const number = Number(row.current_stage_no || 0);
  const description = String(row.current_stage_desc || '').trim();
  if (number && description) return `${number} · ${description}`;
  if (description) return description;
  if (number) return `Stage ${number}`;
  return mroTrackingIsShippedComplete(row) ? 'Completed · fully shipped' : 'Awaiting first stage';
}

function mroRenderTrackingTable() {
  const wrap = document.getElementById('mro-tracking-table-wrap');
  const body = document.getElementById('mro-tracking-table-body');
  const empty = document.getElementById('mro-tracking-empty');
  const summary = document.getElementById('mro-tracking-summary');
  const meta = document.getElementById('mro-tracking-meta');
  if (!wrap || !body || !empty) return;

  const rows = mroFilteredTrackingRows();
  const counts = mroState.trackingRows.reduce((acc, row) => {
    acc[mroTrackingStageKind(row)] += 1;
    return acc;
  }, { active: 0, completed: 0, 'not-started': 0 });

  if (summary) {
    summary.innerHTML = `
      <div class="mro-tracking-stat"><strong>${mroState.trackingRows.length}</strong><span>MRO process sheets</span></div>
      <div class="mro-tracking-stat mro-tracking-stat--active"><strong>${counts.active}</strong><span>Active stages</span></div>
      <div class="mro-tracking-stat mro-tracking-stat--waiting"><strong>${counts['not-started']}</strong><span>Not started</span></div>
      <div class="mro-tracking-stat mro-tracking-stat--done"><strong>${counts.completed}</strong><span>Completed</span></div>
    `;
  }
  if (meta) {
    meta.hidden = false;
    const scope = mroState.trackingIncludesCompleted ? 'including completed history' : 'open/incomplete scope';
    meta.textContent = `${rows.length} shown · ${mroState.trackingRows.length} ERP MPS records · ${scope}`;
  }
  if (mroState.activeTab === 'tracking') {
    const statsEl = document.getElementById('mro-stats');
    if (statsEl) statsEl.textContent = `${rows.length} MRO process sheets shown · ${counts.active} active`;
  }

  if (!rows.length) {
    wrap.hidden = true;
    empty.hidden = false;
    empty.textContent = mroState.trackingRows.length
      ? 'No MRO process sheets match your filters.'
      : 'No MRO process sheets are currently available.';
    return;
  }

  wrap.hidden = false;
  empty.hidden = true;
  body.innerHTML = rows.map((row, index) => {
    const kind = mroTrackingStageKind(row);
    const progress = mroTrackingProgress(row);
    const ps = row.display_ps_id || row.source_ps_id || row.ps_id;
    return `
      <tr class="mro-tracking-row" data-tracking-index="${index}" tabindex="0" title="Expand detailed process sheet tracking" aria-expanded="false">
        <td class="mro-tracking-ps">
          <span class="mro-tracking-expand-icon" aria-hidden="true">›</span>
          <span>${mroEscapeHtml(mroDisplay(ps))}</span>
        </td>
        ${mroCell(row.part_no || row.inventory_code)}
        ${mroCell(row.part_desc, 'mro-desc')}
        ${mroCell(mroTrackingStageLabel(row), 'mro-tracking-stage')}
        <td><span class="mro-stage-badge mro-stage-badge--${kind}">${mroEscapeHtml(mroTrackingStatusLabel(row))}</span></td>
        <td class="mro-progress-cell">
          <div class="mro-progress" title="${progress}% complete"><span style="width:${progress}%"></span></div>
          <span>${progress}%</span>
        </td>
        ${mroCell(mroFormatDate(row.due_date))}
        ${mroCell(row.source_voucher_no)}
      </tr>
      <tr class="mro-tracking-detail-row" data-tracking-detail-index="${index}" hidden>
        <td colspan="8"><div class="mro-tracking-inline-detail"></div></td>
      </tr>
    `;
  }).join('');
}

function mroTrackingOpValue(op, keys, fallback = '') {
  for (const key of keys) {
    const value = op?.[key];
    if (value != null && String(value).trim() !== '') return value;
  }
  return fallback;
}

function mroTrackingOpQuantity(op, keys) {
  const value = mroTrackingOpValue(op, keys, 0);
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function mroTrackingOperationRows(row) {
  const ops = Array.isArray(row?.ops)
    ? row.ops
    : (Array.isArray(row?.op_cards) ? row.op_cards : []);
  return ops.slice().sort((a, b) => (
    Number(mroTrackingOpValue(a, ['stage_no', 'source_stage_no', 'seq_no', 'op_seq_id'], 0))
    - Number(mroTrackingOpValue(b, ['stage_no', 'source_stage_no', 'seq_no', 'op_seq_id'], 0))
  ));
}

function mroTrackingQuantityCard(label, value, modifier = '') {
  const cls = modifier ? ` mro-tracking-quantity--${modifier}` : '';
  return `<div class="mro-tracking-quantity${cls}"><span>${mroEscapeHtml(label)}</span><strong>${mroFormatQty(value)}</strong></div>`;
}

function mroTrackingInfoPill(label, value, modifier = '') {
  const cls = modifier ? ` mro-tracking-info-pill--${modifier}` : '';
  return `
    <span class="mro-tracking-info-pill${cls}">
      <small>${mroEscapeHtml(label)}</small>
      <strong>${mroEscapeHtml(mroDisplay(value))}</strong>
    </span>
  `;
}

function mroTrackingBomStageScan(row, stage) {
  const stageNo = Number(stage?.stage_no || 0);
  const opNo = String(stage?.op_no || '').trim().toLowerCase();
  const matches = mroTrackingOperationRows(row).filter((op) => {
    const candidateStage = Number(mroTrackingOpValue(op, ['stage_no', 'source_stage_no', 'seq_no', 'op_seq_id'], 0));
    const candidateOp = String(mroTrackingOpValue(op, ['op_no', 'source_op_no'], '')).trim().toLowerCase();
    return (stageNo > 0 && candidateStage === stageNo) || (opNo && candidateOp === opNo);
  });
  const scanned = matches.some((op) => {
    const status = String(mroTrackingOpValue(op, ['execution_status', 'erp_execution_status', 'status'], ''))
      .trim()
      .toUpperCase()
      .replaceAll('-', '_')
      .replaceAll(' ', '_');
    const produced = mroTrackingOpQuantity(op, [
      'cascade_output_qty',
      'total_acc_qty_produced',
      'wo_qty_produced',
      'erp_finished_qty',
      'finished_qty',
    ]);
    return produced > 0 || ['I', 'IN_PROCESS', 'C', 'COMPLETED'].includes(status);
  });
  return {
    scanned,
    label: scanned ? 'Scanned' : 'Not scanned',
  };
}

function mroTrackingModalKey(row) {
  return [
    row.source_ps_id || row.ps_id || '',
    row.pp_partial_no || 1,
    row.inventory_code || row.part_no || '',
    row.bom_code || row.erp_bom_code || '',
  ].join('|');
}

function mroRenderTrackingRemarks(container, entries, emptyText) {
  if (!container) return;
  if (!entries.length) {
    container.innerHTML = `<span class="mro-tracking-remarks-empty">${mroEscapeHtml(emptyText)}</span>`;
    return;
  }
  container.innerHTML = entries.map((entry) => `
    <div class="mro-tracking-remark-item">
      ${entry.label ? `<strong>${mroEscapeHtml(entry.label)}</strong>` : ''}
      <p>${mroEscapeHtml(entry.text)}</p>
    </div>
  `).join('');
}

async function mroLoadTrackingBomRemarks(row, modalKey, container) {
  const params = new URLSearchParams({
    part_no: String(row.inventory_code || row.part_no || ''),
    bom_code: String(row.bom_code || row.erp_bom_code || ''),
  });
  try {
    const res = await mroFetch(`/api/mro/workscope-remarks?${params.toString()}`);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    if (mroState.trackingModalKey !== modalKey) return;
    const entries = (Array.isArray(data.rows) ? data.rows : [])
      .map((item) => ({
        label: item.bom_desc || item.bom_code || '',
        text: String(item.remarks_trimmed || item.remarks || '').trim(),
      }))
      .filter((item) => item.text);
    mroRenderTrackingRemarks(container, entries, 'No Inventory BOM remarks.');
  } catch (err) {
    if (mroState.trackingModalKey !== modalKey) return;
    mroRenderTrackingRemarks(container, [], 'BOM remarks unavailable.');
  }
}

async function mroLoadTrackingSupplement(row) {
  const modalKey = mroTrackingModalKey(row);
  mroState.trackingModalKey = modalKey;
  const bomCount = document.getElementById('mro-tracking-modal-bom-count');
  const bomWrap = document.getElementById('mro-tracking-modal-bom-wrap');
  const bomBody = document.getElementById('mro-tracking-modal-bom-stages');
  const noBom = document.getElementById('mro-tracking-modal-no-bom');
  const bomRemarks = document.getElementById('mro-tracking-modal-bom-remarks');
  const soRemarks = document.getElementById('mro-tracking-modal-so-remarks');
  if (bomCount) bomCount.textContent = 'Loading…';
  if (bomWrap) bomWrap.hidden = true;
  if (bomBody) bomBody.innerHTML = '';
  if (noBom) {
    noBom.hidden = false;
    noBom.textContent = 'Loading BOM stages…';
  }
  if (bomRemarks) bomRemarks.textContent = 'Loading…';
  if (soRemarks) soRemarks.textContent = 'Loading…';
  mroLoadTrackingBomRemarks(row, modalKey, bomRemarks);

  const params = new URLSearchParams({
    inventory_code: String(row.inventory_code || row.part_no || ''),
    bom_code: String(row.bom_code || row.erp_bom_code || ''),
    sales_order_no: String(row.source_voucher_no || ''),
  });
  try {
    const res = await mroFetch(`/api/mro/process-sheet-tracking/details?${params.toString()}`);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    if (mroState.trackingModalKey !== modalKey) return;

    const stages = Array.isArray(data.bom_stages) ? data.bom_stages : [];
    if (bomCount) bomCount.textContent = `${stages.length} stage${stages.length === 1 ? '' : 's'}`;
    if (bomWrap) bomWrap.hidden = stages.length === 0;
    if (noBom) {
      noBom.hidden = stages.length > 0;
      noBom.textContent = 'No BOM stages found for this part and BOM.';
    }
    if (bomBody) {
      bomBody.innerHTML = stages.map((stage) => `
        <tr>
          <td>${mroEscapeHtml(mroDisplay(stage.stage_no))}</td>
          <td class="mro-tracking-op-name">${mroEscapeHtml(mroDisplay(stage.stage_desc))}</td>
          <td>${mroEscapeHtml(mroDisplay(stage.op_no))}</td>
          <td>${mroEscapeHtml(mroDisplay(stage.machine_no))}</td>
          <td>${mroFormatQty(stage.setup_time)} min</td>
          <td>${mroFormatQty(stage.cycle_time)} min/pc</td>
        </tr>
      `).join('');
    }

    const so = data.sales_order_remarks || {};
    const soRemarkRows = [
      { label: 'Subject', text: String(so.subject || '').trim() },
      { label: 'Internal', text: String(so.remarks || '').trim() },
      { label: 'External', text: String(so.external_remarks || '').trim() },
    ].filter((item) => item.text);
    mroRenderTrackingRemarks(soRemarks, soRemarkRows, 'No sales-order remarks.');
  } catch (err) {
    if (mroState.trackingModalKey !== modalKey) return;
    if (bomCount) bomCount.textContent = 'Unavailable';
    if (noBom) {
      noBom.hidden = false;
      noBom.textContent = err.message || 'Could not load BOM stages.';
    }
    mroRenderTrackingRemarks(soRemarks, [], 'Sales-order remarks unavailable.');
  }
}

function mroOpenTrackingModal(row) {
  const modal = document.getElementById('mro-tracking-modal');
  const title = document.getElementById('mro-tracking-modal-title');
  const subtitle = document.getElementById('mro-tracking-modal-subtitle');
  const stage = document.getElementById('mro-tracking-modal-stage');
  const summary = document.getElementById('mro-tracking-modal-summary');
  const quantities = document.getElementById('mro-tracking-modal-quantities');
  const opsBody = document.getElementById('mro-tracking-modal-ops');
  const opsWrap = document.getElementById('mro-tracking-modal-ops-wrap');
  const opCount = document.getElementById('mro-tracking-modal-op-count');
  const noOps = document.getElementById('mro-tracking-modal-no-ops');
  if (!modal || !summary || !opsBody) return;

  const ps = row.display_ps_id || row.source_ps_id || row.ps_id || 'Process sheet';
  if (title) title.textContent = ps;
  if (subtitle) subtitle.textContent = `ERP MPS details · Partial ${Number(row.pp_partial_no || 1)}`;
  if (stage) {
    const kind = mroTrackingStageKind(row);
    stage.innerHTML = `
      <div>
        <span class="mro-tracking-current-label">Current stage</span>
        <strong>${mroEscapeHtml(mroTrackingStageLabel(row))}</strong>
      </div>
      <span class="mro-stage-badge mro-stage-badge--${kind}">${mroEscapeHtml(mroTrackingStatusLabel(row))}</span>
    `;
  }
  summary.innerHTML = mroSummaryHtml([
    ['Part no.', row.part_no || row.inventory_code],
    ['Description', row.part_desc],
    ['Sales order', row.source_voucher_no],
    ['SO line item', row.source_line_item_no],
    ['Order date', mroFormatDate(row.order_date)],
    ['Due date', mroFormatDate(row.due_date)],
    ['BOM / route', row.selected_flow_code || row.selected_bom_code || row.erp_bom_code || row.bom_code],
    ['MPS status', row.status],
    ['Execution status', row.execution_status],
    ['Material', row.material_inventory_code || row.inventory_code],
  ]);

  if (quantities) {
    const remaining = mroTrackingIsShippedComplete(row) ? 0 : row.remaining_qty;
    quantities.innerHTML = [
      mroTrackingQuantityCard('Required', row.display_qty || row.wo_req_qty || row.total_qty),
      mroTrackingQuantityCard('Produced', row.finished_qty || row.wo_qty_produced, 'done'),
      mroTrackingQuantityCard('Rejected', row.reject_qty || row.wo_qty_rejected, 'reject'),
      mroTrackingQuantityCard('Remaining', remaining, 'remaining'),
      mroTrackingQuantityCard('Shipped', row.qty_shipped),
    ].join('');
  }

  const ops = mroTrackingOperationRows(row);
  if (opCount) opCount.textContent = `${ops.length} stage${ops.length === 1 ? '' : 's'}`;
  if (opsWrap) opsWrap.hidden = ops.length === 0;
  if (noOps) noOps.hidden = ops.length > 0;
  opsBody.innerHTML = ops.map((op) => {
    const stageNo = mroTrackingOpValue(op, ['stage_no', 'source_stage_no', 'seq_no', 'op_seq_id']);
    const opNo = mroTrackingOpValue(op, ['op_no', 'source_op_no']);
    const description = mroTrackingOpValue(op, ['stage_desc', 'operation_name', 'op_desc', 'op_name', 'description']);
    const machine = mroTrackingOpValue(op, ['wo_voucher_no', 'work_order_no', 'machine_code']);
    const statusText = String(mroTrackingOpValue(op, ['execution_status', 'erp_execution_status', 'status'], '')).trim();
    const required = mroTrackingOpQuantity(op, ['cascade_required_qty', 'wo_qty_required', 'erp_required_qty', 'required_qty']);
    const produced = mroTrackingOpQuantity(op, ['cascade_output_qty', 'total_acc_qty_produced', 'wo_qty_produced', 'erp_finished_qty', 'finished_qty']);
    const rejected = mroTrackingOpQuantity(op, ['cascade_reject_qty', 'wo_qty_rejected', 'erp_reject_qty', 'reject_qty']);
    const explicitRemaining = mroTrackingOpValue(op, ['remaining_qty'], null);
    const remaining = explicitRemaining == null ? Math.max(0, required - produced - rejected) : explicitRemaining;
    return `
      <tr>
        <td>${mroEscapeHtml(mroDisplay(stageNo))}</td>
        <td class="mro-tracking-op-name"><strong>${mroEscapeHtml(mroDisplay(opNo))}</strong><span>${mroEscapeHtml(mroDisplay(description))}</span></td>
        <td>${mroEscapeHtml(mroDisplay(machine))}</td>
        <td>${mroEscapeHtml(mroDisplay(statusText))}</td>
        <td>${mroFormatQty(required)}</td>
        <td>${mroFormatQty(produced)}</td>
        <td>${mroFormatQty(rejected)}</td>
        <td>${mroFormatQty(remaining)}</td>
      </tr>
    `;
  }).join('');

  modal.hidden = false;
  document.body.classList.add('mro-modal-open');
  modal.querySelector('.mro-modal-close')?.focus();
  mroLoadTrackingSupplement(row);
}

function mroCloseTrackingModal() {
  const modal = document.getElementById('mro-tracking-modal');
  if (modal) modal.hidden = true;
  mroState.trackingModalKey = '';
  mroSyncBodyModalClass();
}

function mroTrackingOpsTableHtml(row) {
  const ops = mroTrackingOperationRows(row);
  if (!ops.length) {
    return '<p class="mro-arc-empty-hint">No MPS or work-order stages are available.</p>';
  }
  const body = ops.map((op) => {
    const stageNo = mroTrackingOpValue(op, ['stage_no', 'source_stage_no', 'seq_no', 'op_seq_id']);
    const opNo = mroTrackingOpValue(op, ['op_no', 'source_op_no']);
    const description = mroTrackingOpValue(op, ['stage_desc', 'operation_name', 'op_desc', 'op_name', 'description']);
    const machine = mroTrackingOpValue(op, ['wo_voucher_no', 'work_order_no', 'machine_code']);
    const status = mroTrackingOpValue(op, ['execution_status', 'erp_execution_status', 'status']);
    const required = mroTrackingOpQuantity(op, ['cascade_required_qty', 'wo_qty_required', 'erp_required_qty', 'required_qty']);
    const produced = mroTrackingOpQuantity(op, ['cascade_output_qty', 'total_acc_qty_produced', 'wo_qty_produced', 'erp_finished_qty', 'finished_qty']);
    const rejected = mroTrackingOpQuantity(op, ['cascade_reject_qty', 'wo_qty_rejected', 'erp_reject_qty', 'reject_qty']);
    const explicitRemaining = mroTrackingOpValue(op, ['remaining_qty'], null);
    const remaining = explicitRemaining == null ? Math.max(0, required - produced - rejected) : explicitRemaining;
    return `
      <tr>
        <td>${mroEscapeHtml(mroDisplay(stageNo))}</td>
        <td class="mro-tracking-op-name"><strong>${mroEscapeHtml(mroDisplay(opNo))}</strong><span>${mroEscapeHtml(mroDisplay(description))}</span></td>
        <td>${mroEscapeHtml(mroDisplay(machine))}</td>
        <td>${mroEscapeHtml(mroDisplay(status))}</td>
        <td>${mroFormatQty(required)}</td>
        <td>${mroFormatQty(produced)}</td>
        <td>${mroFormatQty(rejected)}</td>
        <td>${mroFormatQty(remaining)}</td>
      </tr>
    `;
  }).join('');
  return `
    <div class="mro-arc-items-scroll">
      <table class="mro-arc-items-table mro-tracking-ops-table">
        <thead><tr><th>Stage</th><th>Operation</th><th>Work order / machine</th><th>Status</th><th>Required</th><th>Produced</th><th>Rejected</th><th>Remaining</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function mroTrackingInlineHtml(row) {
  const kind = mroTrackingStageKind(row);
  const remaining = mroTrackingIsShippedComplete(row) ? 0 : row.remaining_qty;
  return `
    <div class="mro-tracking-inline-head">
      <div>
        <span class="mro-tracking-inline-eyebrow">Expanded process sheet</span>
        <strong>${mroEscapeHtml(row.display_ps_id || row.source_ps_id || row.ps_id || 'MPS details')}</strong>
        <span>ERP MPS details · Partial ${Number(row.pp_partial_no || 1)}</span>
      </div>
      <button type="button" class="mro-btn mro-btn--compact" data-tracking-collapse>Collapse</button>
    </div>
    <div class="mro-tracking-current-stage">
      <div>
        <span class="mro-tracking-current-label">Operational job state</span>
        <strong>${mroEscapeHtml(mroTrackingStageLabel(row))}</strong>
        <small>${mroEscapeHtml(mroTrackingStateExplanation(row))}</small>
      </div>
      <span class="mro-stage-badge mro-stage-badge--${kind}">${mroEscapeHtml(mroTrackingStatusLabel(row))}</span>
    </div>
    <div class="mro-tracking-description">
      <span>Description</span>
      <strong>${mroEscapeHtml(mroDisplay(row.part_desc))}</strong>
    </div>
    <div class="mro-tracking-info-pills">
      ${mroTrackingInfoPill('Part', row.part_no || row.inventory_code)}
      ${mroTrackingInfoPill('Sales order', row.source_voucher_no)}
      ${mroTrackingInfoPill('Due', mroFormatDate(row.due_date))}
      ${mroTrackingInfoPill('BOM', row.erp_bom_code || row.bom_code)}
      ${mroTrackingInfoPill('ERP record', mroTrackingErpRecordState(row))}
      ${mroTrackingInfoPill('SO qty', mroFormatQty(row.so_det_qty))}
      ${mroTrackingInfoPill('Produced', mroFormatQty(row.finished_qty || row.wo_qty_produced), 'done')}
      ${mroTrackingInfoPill('Remaining', mroFormatQty(remaining), 'remaining')}
      ${mroTrackingInfoPill('Shipped', mroFormatQty(row.qty_shipped))}
    </div>
    <section class="mro-tracking-operations">
      <div class="mro-tracking-section-head"><h3>BOM stages</h3><span data-inline-bom-count>Loading…</span></div>
      <div class="mro-arc-items-scroll" data-inline-bom-wrap hidden>
        <table class="mro-arc-items-table mro-tracking-bom-table">
          <thead><tr><th>Stage</th><th>Description</th><th>Stage status</th></tr></thead>
          <tbody data-inline-bom-body></tbody>
        </table>
      </div>
      <p class="mro-arc-empty-hint" data-inline-no-bom>Loading BOM stages…</p>
    </section>
    <section class="mro-tracking-remarks">
      <article class="mro-tracking-notes">
        <h3>Inventory BOM remarks</h3>
        <div class="mro-tracking-remarks-list" data-inline-bom-remarks>Loading…</div>
      </article>
      <article class="mro-tracking-notes">
        <h3>Sales order remarks</h3>
        <div class="mro-tracking-remarks-list" data-inline-so-remarks>Loading…</div>
      </article>
    </section>
  `;
}

async function mroLoadTrackingInlineSupplement(row, panel, detailKey) {
  const bomCount = panel.querySelector('[data-inline-bom-count]');
  const bomWrap = panel.querySelector('[data-inline-bom-wrap]');
  const bomBody = panel.querySelector('[data-inline-bom-body]');
  const noBom = panel.querySelector('[data-inline-no-bom]');
  const bomRemarks = panel.querySelector('[data-inline-bom-remarks]');
  const soRemarks = panel.querySelector('[data-inline-so-remarks]');
  mroLoadTrackingBomRemarks(row, detailKey, bomRemarks);
  const params = new URLSearchParams({
    inventory_code: String(row.inventory_code || row.part_no || ''),
    bom_code: String(row.bom_code || row.erp_bom_code || ''),
    sales_order_no: String(row.source_voucher_no || ''),
  });
  try {
    const res = await mroFetch(`/api/mro/process-sheet-tracking/details?${params.toString()}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `Request failed (${res.status})`);
    if (mroState.trackingModalKey !== detailKey || !panel.isConnected) return;
    const stages = Array.isArray(data.bom_stages) ? data.bom_stages : [];
    bomCount.textContent = `${stages.length} stage${stages.length === 1 ? '' : 's'}`;
    bomWrap.hidden = stages.length === 0;
    noBom.hidden = stages.length > 0;
    noBom.textContent = 'No BOM stages found for this part and BOM.';
    bomBody.innerHTML = stages.map((stage) => {
      const scan = mroTrackingBomStageScan(row, stage);
      return `
        <tr>
          <td>${mroEscapeHtml(mroDisplay(stage.stage_no))}</td>
          <td>${mroEscapeHtml(mroDisplay(stage.stage_desc))}</td>
          <td><span class="mro-scan-badge${scan.scanned ? ' is-scanned' : ''}">${mroEscapeHtml(scan.label)}</span></td>
        </tr>
      `;
    }).join('');
    const so = data.sales_order_remarks || {};
    mroRenderTrackingRemarks(soRemarks, [
      { label: 'Subject', text: String(so.subject || '').trim() },
      { label: 'Internal', text: String(so.remarks || '').trim() },
      { label: 'External', text: String(so.external_remarks || '').trim() },
    ].filter((item) => item.text), 'No sales-order remarks.');
  } catch (err) {
    if (mroState.trackingModalKey !== detailKey || !panel.isConnected) return;
    bomCount.textContent = 'Unavailable';
    noBom.hidden = false;
    noBom.textContent = err.message || 'Could not load BOM stages.';
    mroRenderTrackingRemarks(soRemarks, [], 'Sales-order remarks unavailable.');
  }
}

function mroToggleTrackingDetail(row, rowEl) {
  const detailRow = rowEl.nextElementSibling;
  const panel = detailRow?.querySelector('.mro-tracking-inline-detail');
  if (!detailRow || !panel) return;
  const opening = detailRow.hidden;
  document.querySelectorAll('tr.mro-tracking-detail-row:not([hidden])').forEach((openRow) => {
    openRow.hidden = true;
    openRow.previousElementSibling?.setAttribute('aria-expanded', 'false');
  });
  mroState.trackingModalKey = '';
  if (!opening) return;
  detailRow.hidden = false;
  rowEl.setAttribute('aria-expanded', 'true');
  panel.innerHTML = mroTrackingInlineHtml(row);
  const detailKey = mroTrackingModalKey(row);
  mroState.trackingModalKey = detailKey;
  mroLoadTrackingInlineSupplement(row, panel, detailKey);
}

async function mroLoadTracking({ force = false, includeCompleted = false } = {}) {
  const loading = document.getElementById('mro-tracking-loading');
  if (loading) loading.hidden = false;
  try {
    const params = new URLSearchParams();
    if (force) params.set('refresh', '1');
    if (includeCompleted) params.set('show_completed', '1');
    const query = params.toString();
    const res = await mroFetch(`/api/mro/process-sheet-tracking${query ? `?${query}` : ''}`);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    mroState.trackingRows = Array.isArray(data.rows) ? data.rows : [];
    mroState.trackingIncludesCompleted = !!data.include_completed;
    mroState.trackingLoaded = true;
    mroRenderTrackingTable();
  } catch (err) {
    mroState.trackingRows = [];
    mroState.trackingLoaded = false;
    mroRenderTrackingTable();
    const empty = document.getElementById('mro-tracking-empty');
    if (empty) {
      empty.hidden = false;
      empty.textContent = `Failed to load PS tracking: ${err.message || err}`;
    }
  } finally {
    if (loading) loading.hidden = true;
  }
}

function mroSetTab(tab) {
  mroState.activeTab = tab;
  const section = tab === 'tracking' ? 'tracking' : 'arc';
  const arcPanel = document.getElementById('mro-panel-arc');
  const trackingPanel = document.getElementById('mro-panel-tracking');
  const historyPanel = document.getElementById('mro-panel-history');
  const arcSubnav = document.getElementById('mro-arc-subnav');
  const appbarActions = document.querySelector('.mro-appbar-actions');
  document.querySelectorAll('[data-mro-section]').forEach((btn) => {
    const active = btn.getAttribute('data-mro-section') === section;
    btn.classList.toggle('is-active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-mro-tab]').forEach((btn) => {
    const active = btn.getAttribute('data-mro-tab') === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (arcSubnav) arcSubnav.hidden = section !== 'arc';
  if (appbarActions) appbarActions.hidden = section === 'tracking';
  if (arcPanel) arcPanel.hidden = tab !== 'arc';
  if (trackingPanel) trackingPanel.hidden = tab !== 'tracking';
  if (historyPanel) historyPanel.hidden = tab !== 'history';
  if (tab === 'tracking') {
    if (mroState.trackingLoaded) mroRenderTrackingTable();
    else mroLoadTracking();
  } else if (tab === 'arc') {
    mroRenderStats();
  }
  if (tab === 'history') {
    mroLoadHistory();
  }
}

function mroOpenDetailModal(row) {
  mroState.detailRow = row;
  const modal = document.getElementById('mro-detail-modal');
  const summary = document.getElementById('mro-detail-modal-summary');
  const title = document.getElementById('mro-detail-modal-title');
  if (!modal || !summary) return;

  const ps = mroRowPs(row) || '—';
  if (title) title.textContent = `Details · ${ps}`;

  summary.innerHTML = mroSummaryHtml([
    ['Order date', mroFormatDate(row.sales_order_date)],
    ['Process sheet no.', ps],
    ['Part no.', row.inventory_code],
    ['Description', row.inventory_main_desc],
    ['Short description', row.inventory_short_desc],
    ['S/N', row.sn_remarks],
    ['Customer code', row.customer_code],
    ['Customer PO', row.customer_po_no],
    ['PO item no.', row.customer_po_line_item_no],
    ['SO qty', mroFormatQty(row.total_qty)],
    ['Sales order no.', row.sales_order_no],
    ['Sales line item', row.sales_line_item_no],
    ['Type', row.type],
    ['Component line', row.component_line_item_no],
    ['Parent inventory', row.parent_inventory_code],
    ['Sales component seq', row.sales_component_seq_no],
    ['ARC seq', row.arc_seq_no],
    ['ERP ARC status', row.erp_arc_status || row.arc_status],
    ['Submitted in app', row.app_completed ? 'Yes' : 'No'],
    ['Effective status', mroIsEffectivelyCompleted(row) ? 'Completed' : 'Incomplete'],
    ['CAAS doc', row.caas_doc_no],
    ['FAA doc', row.faa_doc_no],
    ['EASA doc', row.easa_doc_no],
    ['JCAB doc', row.jcab_doc_no],
    ['CAAC doc', row.caac_doc_no],
    ['Created by', row.created_by],
    ['Created', row.created_datetime],
    ['Last updated by', row.last_updated_by],
    ['Last updated', row.last_updated_datetime],
  ]);

  modal.hidden = false;
  document.body.classList.add('mro-modal-open');
  modal.querySelector('.mro-modal-close')?.focus();
}

function mroCloseDetailModal() {
  const modal = document.getElementById('mro-detail-modal');
  if (modal) modal.hidden = true;
  mroState.detailRow = null;
  mroSyncBodyModalClass();
}

function mroCloseArcModal() {
  const modal = document.getElementById('mro-arc-modal');
  if (modal) modal.hidden = true;
  mroState.modalRow = null;
  mroSyncBodyModalClass();
}

function mroSyncBodyModalClass() {
  if (mroAnyModalOpen()) {
    document.body.classList.add('mro-modal-open');
  } else {
    document.body.classList.remove('mro-modal-open');
  }
}

function mroSelectedArcVariants() {
  return Array.from(document.querySelectorAll('input[name="mro-arc-variant"]:checked'))
    .map((el) => el.value)
    .filter((value) => MRO_ARC_VARIANTS[value]);
}

function mroSyncArcVariantPanels() {
  const selected = mroSelectedArcVariants();
  mroState.arcVariants = selected;

  const correctionsEl = document.getElementById('mro-arc-corrections');
  const correctionsEmpty = document.getElementById('mro-arc-corrections-empty');
  if (correctionsEl) {
    const existingValues = {};
    correctionsEl.querySelectorAll('textarea[data-correction-variant]').forEach((el) => {
      existingValues[el.getAttribute('data-correction-variant')] = el.value || '';
    });
    correctionsEl.innerHTML = selected.map((variant) => {
      const config = MRO_ARC_VARIANTS[variant];
      const tagClass = `mro-arc-tag mro-arc-tag--${variant.toLowerCase()}`;
      const saved = existingValues[variant] || '';
      return `
        <div class="mro-arc-field mro-arc-variant-panel mro-arc-correction-panel" data-variant-panel="${mroEscapeHtml(variant)}">
          <div class="mro-arc-field-head">
            <span class="${tagClass}">${mroEscapeHtml(variant)}</span>
            <button
              type="button"
              class="mro-btn mro-btn--ghost mro-btn--compact"
              data-mro-insert-correction="${mroEscapeHtml(variant)}"
              title="Insert the configured template for this certificate"
            >Insert template</button>
          </div>
          <span>${mroEscapeHtml(config.correctionLabel)}</span>
          <textarea
            id="mro-arc-correction-${mroEscapeHtml(variant.toLowerCase())}"
            class="mro-arc-textarea"
            rows="2"
            data-correction-variant="${mroEscapeHtml(variant)}"
            placeholder="Empty — Insert template to fill"
          >${mroEscapeHtml(saved)}</textarea>
        </div>
      `;
    }).join('');
  }
  if (correctionsEmpty) correctionsEmpty.hidden = selected.length > 0;

  const usedPartsEl = document.getElementById('mro-arc-used-parts');
  const usedPartsEmpty = document.getElementById('mro-arc-used-parts-empty');
  if (usedPartsEl) {
    usedPartsEl.innerHTML = selected.map((variant) => {
      const config = MRO_ARC_VARIANTS[variant];
      const tagClass = `mro-arc-tag mro-arc-tag--${variant.toLowerCase()}`;
      return `
        <div class="mro-arc-used-col" data-variant="${mroEscapeHtml(variant)}">
          <div class="mro-arc-used-col-head">
            <span class="${tagClass}">${mroEscapeHtml(variant)}</span>
          </div>
          <div class="mro-arc-used-col-body">
            ${config.usedParts.map((part) => `
              <label class="mro-arc-check-card">
                <input
                  type="checkbox"
                  name="mro-arc-used-part-${mroEscapeHtml(variant)}"
                  value="${mroEscapeHtml(part.value)}"
                  ${part.defaultChecked ? 'checked' : ''}
                >
                <span>${mroEscapeHtml(part.label)}</span>
              </label>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');
  }
  if (usedPartsEmpty) usedPartsEmpty.hidden = selected.length > 0;

  const statusPanels = document.getElementById('mro-arc-status-panels');
  const statusEmpty = document.getElementById('mro-arc-status-empty');
  if (statusPanels) {
    statusPanels.innerHTML = selected.map((variant) => {
      const config = MRO_ARC_VARIANTS[variant];
      const tagClass = `mro-arc-tag mro-arc-tag--${variant.toLowerCase()}`;
      return `
        <label class="mro-arc-field mro-arc-status-field">
          <span class="${tagClass}">${mroEscapeHtml(variant)}</span>
          <span>${mroEscapeHtml(config.statusLabel)}</span>
          <select class="mro-arc-input" name="mro-arc-status-${mroEscapeHtml(variant)}" id="mro-arc-status-${mroEscapeHtml(variant)}">
            ${config.statusOptions.map((opt) => `
              <option value="${mroEscapeHtml(opt)}"${opt === config.defaultStatus ? ' selected' : ''}>${mroEscapeHtml(opt)}</option>
            `).join('')}
          </select>
        </label>
      `;
    }).join('');
  }
  if (statusEmpty) statusEmpty.hidden = selected.length > 0;

  mroSyncCaacPanel();
}

function mroSyncCaacPanel() {
  const panel = document.getElementById('mro-arc-caac-panel');
  if (!panel) return;
  panel.hidden = !mroSelectedArcVariants().includes('CAAC');
}

function mroSelectedCaacCertificateType() {
  const checked = document.querySelector('input[name="mro-arc-caac-cert-type"]:checked');
  return checked && checked.value === 'conformity' ? 'conformity' : 'airworthiness';
}

function mroSelectedCaacEligibility() {
  return 'NOT KNOWN';
}

function mroRowProcessSheet(row) {
  return String(row?.process_sheet_no || row?.pp_voucher_no || '').trim();
}

function mroApplyExtractedStatus(status) {
  const token = String(status || '').trim().toUpperCase();
  if (!token) return;
  mroSelectedArcVariants().forEach((variant) => {
    const select = document.getElementById(`mro-arc-status-${variant}`);
    if (!select) return;
    const options = Array.from(select.options).map((opt) => opt.value.toUpperCase());
    const exact = options.find((opt) => opt === token);
    const fuzzy = options.find((opt) => opt.includes(token) || token.includes(opt));
    const match = exact || fuzzy;
    if (match) {
      const opt = Array.from(select.options).find((o) => o.value.toUpperCase() === match);
      if (opt) select.value = opt.value;
    }
  });
}

async function mroAutofillWorkscopeFromBom(row) {
  const workscope = document.getElementById('mro-arc-workscope');
  const meta = document.getElementById('mro-arc-workscope-meta');
  if (!workscope) return;
  const ps = mroRowProcessSheet(row);
  const partNo = String(
    row?.inventory_code
    || document.querySelector('#mro-arc-items-body .mro-arc-item-part')?.value
    || ''
  ).trim();
  if (!ps && !partNo) {
    if (meta) meta.textContent = '';
    return;
  }
  const params = new URLSearchParams();
  if (ps) params.set('process_sheet_no', ps);
  if (partNo) params.set('part_no', partNo);
  try {
    if (meta) meta.textContent = 'loading…';
    const res = await mroFetch(`/api/mro/workscope-remarks?${params.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Workscope lookup failed (${res.status})`);
    }
    const hit = (data.rows || []).find((r) => r.remarks_trimmed || r.remarks);
    if (!hit) {
      if (meta) meta.textContent = ps ? `no Inventory BOM remarks for ${ps}` : 'no Inventory BOM remarks';
      return;
    }
    const text = String(hit.remarks_trimmed || hit.remarks || '').trim();
    if (text && !String(workscope.value || '').trim()) {
      workscope.value = text;
    }
    mroApplyExtractedStatus(hit.extracted_status);
    const bom = hit.bom_code || data.resolved?.bom_code || '';
    if (meta) {
      meta.textContent = bom
        ? `Inventory BOM ${bom}${hit.extracted_status ? ` · status ${hit.extracted_status}` : ''}`
        : (hit.extracted_status ? `status ${hit.extracted_status}` : 'from Inventory BOM');
    }
  } catch (err) {
    if (meta) meta.textContent = '';
    console.warn('MRO Inventory BOM remarks autofill failed:', err);
  }
}

function mroFormatCustomerLabel(header, row) {
  const code = String(
    (header && header.customer_code) || (row && row.customer_code) || ''
  ).trim();
  const name = String(
    (header && (header.customer_name || header.customer_short_name)) || ''
  ).trim();
  if (code && name) return `${code} ${name}`;
  return name || code || '';
}

function mroFillArcGeneral(row, header) {
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = mroDisplay(value);
  };

  const hdr = header || {};
  setText('mro-arc-g-quotation', hdr.sales_quotation_no);
  setText(
    'mro-arc-g-salesperson',
    hdr.sales_person_name || hdr.sales_person_code
  );
  setText('mro-arc-g-so', row.sales_order_no || hdr.sales_order_no);
  setText('mro-arc-g-customer', mroFormatCustomerLabel(hdr, row));
  setText(
    'mro-arc-g-po',
    hdr.customer_po_no || row.customer_po_no
  );
  setText('mro-arc-g-sbu', hdr.sbu_desc || hdr.sbu_code);
  setText(
    'mro-arc-g-category',
    hdr.sales_category_desc || hdr.sales_category_code
  );
  setText(
    'mro-arc-g-segment',
    hdr.segment_1_desc || hdr.segment_1_code
  );
  setText('mro-arc-g-ps', mroRowPs(row));
}

async function mroFetchSoHeader(salesOrderNo, { force = false } = {}) {
  const so = String(salesOrderNo || '').trim();
  if (!so) return null;
  const url = force
    ? `/api/mro/sales-order-header?sales_order_no=${encodeURIComponent(so)}&refresh=1`
    : `/api/mro/sales-order-header?sales_order_no=${encodeURIComponent(so)}`;
  const res = await mroFetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Sales order lookup failed (${res.status})`);
  }
  return data.header || null;
}

function mroItemKey(row) {
  return [
    row.sales_order_no || '',
    row.sales_line_item_no || '',
    row.component_line_item_no || '',
    row.inventory_code || '',
    row.sn_remarks || '',
    mroRowPs(row),
  ].join('|');
}

function mroSiblingArcRows(anchorRow) {
  const so = String(anchorRow?.sales_order_no || '').trim();
  const ps = mroRowPs(anchorRow);
  if (!so || !ps) return [anchorRow].filter(Boolean);
  const siblings = (mroState.rows || []).filter((row) => (
    String(row.sales_order_no || '').trim() === so
    && mroRowPs(row) === ps
  ));
  if (!siblings.length) return [anchorRow];
  // Keep clicked row first, then remaining siblings in list order.
  const anchorKey = mroItemKey(anchorRow);
  const ordered = [];
  const seen = new Set();
  const push = (row) => {
    const key = mroItemKey(row);
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(row);
  };
  push(anchorRow);
  siblings.forEach(push);
  return ordered;
}

function mroFillArcItems(anchorRow) {
  const body = document.getElementById('mro-arc-items-body');
  const hint = document.getElementById('mro-arc-items-hint');
  if (!body) return;
  const rows = mroSiblingArcRows(anchorRow);
  mroState.arcItemRows = rows;
  if (hint) {
    hint.textContent = rows.length > 1
      ? `${rows.length} line items found for this process sheet. Uncheck a line to print it as Quantity 0 (blank serial) on the PDF. Remove deletes the line entirely.`
      : 'Uncheck a line to print it as Quantity 0 (blank serial) on the PDF. Remove deletes the line entirely.';
  }
  body.innerHTML = rows.map((row, index) => {
    const qty = row.total_qty == null || row.total_qty === ''
      ? ''
      : String(Math.round(Number(row.total_qty)));
    const key = mroEscapeHtml(mroItemKey(row));
    return `
      <tr class="mro-arc-item-row" data-item-key="${key}" data-item-index="${index}">
        <td class="mro-arc-items-col-check">
          <input type="checkbox" class="mro-arc-item-include" checked aria-label="Include item ${index + 1}">
        </td>
        <td><input class="mro-arc-input mro-arc-input--compact mro-arc-item-iter" type="text" value="${index + 1}" readonly></td>
        <td><input class="mro-arc-input mro-arc-item-desc" type="text" value="${mroEscapeHtml(row.inventory_main_desc || '')}"></td>
        <td><input class="mro-arc-input mro-arc-item-part" type="text" value="${mroEscapeHtml(row.inventory_code || '')}"></td>
        <td><input class="mro-arc-input mro-arc-input--qty mro-arc-item-qty" type="number" step="1" min="0" inputmode="numeric" value="${mroEscapeHtml(qty)}"></td>
        <td><input class="mro-arc-input mro-arc-item-sn" type="text" value="${mroEscapeHtml(row.sn_remarks || '')}"></td>
        <td class="mro-arc-items-col-action">
          <button type="button" class="mro-btn mro-btn--danger-ghost mro-btn--compact" data-mro-remove-item title="Delete this line from the ARC (omitted from the PDF)">Remove</button>
        </td>
      </tr>
    `;
  }).join('');
  mroRenumberArcItems();
}

function mroRenumberArcItems() {
  document.querySelectorAll('#mro-arc-items-body tr.mro-arc-item-row').forEach((tr, index) => {
    const iter = tr.querySelector('.mro-arc-item-iter');
    if (iter) iter.value = String(index + 1);
  });
}

function mroCollectSelectedArcItems() {
  const rows = [];
  let includedCount = 0;
  document.querySelectorAll('#mro-arc-items-body tr.mro-arc-item-row').forEach((tr, index) => {
    const include = tr.querySelector('.mro-arc-item-include');
    const included = !include || include.checked;
    const rawQty = tr.querySelector('.mro-arc-item-qty')?.value || '';
    let qty = mroNormalizeWholeQty(rawQty);
    if (rawQty !== '' && qty === null) {
      throw new Error('Quantity must be a whole number (0 decimal places).');
    }
    let serial = tr.querySelector('.mro-arc-item-sn')?.value || '';
    // Unchecked lines stay on the Form 1 as Quantity 0 with blank serial
    // (same pattern as CAAS(AW)95 / EASA Form 1 / FAA 8130-3 samples).
    if (!included) {
      qty = '0';
      serial = '';
    } else {
      includedCount += 1;
    }
    rows.push({
      iter: String(index + 1),
      description: tr.querySelector('.mro-arc-item-desc')?.value || '',
      part_no: tr.querySelector('.mro-arc-item-part')?.value || '',
      quantity: qty === null || qty === '' ? (included ? '' : '0') : qty,
      serial_no: serial,
      included,
      removed: !included,
    });
  });
  if (!rows.length) {
    throw new Error('Select at least one item line for the ARC.');
  }
  if (!includedCount) {
    throw new Error('Include at least one line item (unchecked lines print as Quantity 0).');
  }
  return rows;
}

function mroSelectedPartType() {
  const checked = document.querySelector('input[name="mro-arc-part-type"]:checked');
  return checked && checked.value === 'new' ? 'new' : 'used';
}

function mroSyncPartTypePanels() {
  const partType = mroSelectedPartType();
  const usedPanel = document.getElementById('mro-arc-used-panel');
  const newPanel = document.getElementById('mro-arc-new-panel');
  if (usedPanel) usedPanel.hidden = partType !== 'used';
  if (newPanel) newPanel.hidden = partType !== 'new';

  const staffLabel = document.getElementById('mro-arc-staff-label');
  const dateLabel = document.getElementById('mro-arc-date-label');
  if (staffLabel) {
    staffLabel.innerHTML = partType === 'new'
      ? '13d. Name <span class="mro-req">*</span>'
      : '14d. Name <span class="mro-req">*</span>';
  }
  if (dateLabel) {
    dateLabel.innerHTML = partType === 'new'
      ? '13e. Date <span class="mro-req">*</span>'
      : '14e. Date <span class="mro-req">*</span>';
  }
}

function mroNormalizeWholeQty(value) {
  if (value == null || value === '') return '';
  const n = Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return String(n);
}

function mroResetArcFormFields() {
  const workscope = document.getElementById('mro-arc-workscope');
  const supplementary = document.getElementById('mro-arc-supplementary');
  const certDate = document.getElementById('mro-arc-cert-date');
  if (workscope) workscope.value = '';
  if (supplementary) supplementary.value = '';
  if (certDate) certDate.value = mroTodayInputValue();
  document.querySelectorAll('input[name="mro-arc-part-type"]').forEach((input) => {
    input.checked = input.value === 'used';
  });
  document.querySelectorAll('input[name="mro-arc-new-part"]').forEach((input) => {
    input.checked = input.value === 'approved_design';
  });
  document.querySelectorAll('input[name="mro-arc-caac-cert-type"]').forEach((input) => {
    input.checked = input.value === 'airworthiness';
  });
  const eligibility = document.getElementById('mro-arc-caac-eligibility');
  if (eligibility) eligibility.value = 'NOT KNOWN';
  const workscopeMeta = document.getElementById('mro-arc-workscope-meta');
  if (workscopeMeta) workscopeMeta.textContent = '';
  mroSyncPartTypePanels();
  mroPopulateStaffDropdown();
  mroSetGenerateHint('');
}

function mroTodayInputValue() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function mroCollectArcPayload() {
  const row = mroState.modalRow || {};
  const header = mroState.soHeader || {};
  const variants = mroSelectedArcVariants();
  const corrections = {};
  const statusWork = {};
  const usedParts = {};
  const partType = mroSelectedPartType();

  variants.forEach((variant) => {
    const key = variant.toLowerCase();
    corrections[variant] = document.getElementById(`mro-arc-correction-${key}`)?.value || '';
    statusWork[variant] = document.getElementById(`mro-arc-status-${variant}`)?.value || '';
    usedParts[variant] = Array.from(
      document.querySelectorAll(`input[name="mro-arc-used-part-${variant}"]:checked`)
    ).map((el) => el.value);
  });

  const newParts = Array.from(
    document.querySelectorAll('input[name="mro-arc-new-part"]:checked')
  ).map((el) => el.value);

  const items = mroCollectSelectedArcItems();
  if (!items.length) {
    throw new Error('Select at least one item line for the ARC.');
  }
  const primary = items.find((item) => !item.removed) || items[0];

  return {
    variants,
    part_type: partType,
    caac_certificate_type: mroSelectedCaacCertificateType(),
    eligibility: mroSelectedCaacEligibility(),
    caac_eligibility: mroSelectedCaacEligibility(),
    sales_order_no: row.sales_order_no || '',
    sales_line_item_no: row.sales_line_item_no || '',
    sales_order_date: row.sales_order_date || '',
    order_date: row.sales_order_date || '',
    sales_quotation_no: header.sales_quotation_no || '',
    sales_person_name: header.sales_person_name || header.sales_person_code || '',
    customer_code: header.customer_code || row.customer_code || '',
    customer_name: header.customer_name || header.customer_short_name || '',
    customer_po_no: header.customer_po_no || row.customer_po_no || '',
    customer_po_line_item_no: row.customer_po_line_item_no || '',
    po_item_no: row.customer_po_line_item_no || '',
    sbu_desc: header.sbu_desc || header.sbu_code || '',
    sales_category: header.sales_category_desc || header.sales_category_code || '',
    segment_1: header.segment_1_desc || header.segment_1_code || '',
    process_sheet_no: mroRowPs(row),
    inventory_code: primary.part_no || row.inventory_code || '',
    inventory_main_desc: primary.description || row.inventory_main_desc || '',
    sn_remarks: primary.serial_no || row.sn_remarks || '',
    total_qty: primary.quantity || row.total_qty,
    workscope: document.getElementById('mro-arc-workscope')?.value || '',
    supplementary: document.getElementById('mro-arc-supplementary')?.value || '',
    corrections,
    status_work: statusWork,
    used_parts: usedParts,
    new_parts: newParts,
    certifying_staff: document.getElementById('mro-arc-certifying-staff')?.value || '',
    cert_date: document.getElementById('mro-arc-cert-date')?.value || mroTodayInputValue(),
    items,
    item: primary,
  };
}

function mroSetGenerateHint(message) {
  const el = document.getElementById('mro-arc-generate-hint');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function mroSetArcActionBusy(busy, { previewLabel, submitLabel } = {}) {
  const previewBtn = document.getElementById('mro-arc-modal-preview');
  const submitBtn = document.getElementById('mro-arc-modal-submit');
  if (previewBtn) {
    previewBtn.disabled = !!busy;
    if (previewLabel) previewBtn.textContent = previewLabel;
  }
  if (submitBtn) {
    submitBtn.disabled = !!busy;
    if (submitLabel) submitBtn.textContent = submitLabel;
  }
}

function mroDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function mroOpenBlobPreview(blob) {
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) {
    URL.revokeObjectURL(url);
    throw new Error('Pop-up blocked. Allow pop-ups to preview the PDF.');
  }
  // Keep the blob URL alive long enough for the viewer to load.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function mroPreviewArc() {
  let payload;
  try {
    payload = mroCollectArcPayload();
  } catch (err) {
    mroSetGenerateHint(err.message || 'Invalid ARC form values.');
    return;
  }
  mroSetGenerateHint('');

  if (!payload.variants.length) {
    mroSetGenerateHint('Select at least one variant (CAAS, FAA, EASA, JCAB, or CAAC).');
    return;
  }
  if (!payload.certifying_staff) {
    const label = payload.part_type === 'new' ? '13d. Name' : '14d. Name';
    mroSetGenerateHint(`Select certifying staff (${label}).`);
    return;
  }

  mroSetArcActionBusy(true, { previewLabel: 'Previewing…' });

  try {
    const res = await mroFetch('/api/mro/generate-arc-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      if (contentType.includes('application/json')) {
        const data = await res.json();
        message = data.error || message;
      }
      throw new Error(message);
    }

    const blob = await res.blob();
    mroOpenBlobPreview(blob);
    const pageHint = payload.variants.length > 1
      ? `${payload.variants.length} pages (${payload.variants.join(', ')})`
      : payload.variants[0];
    mroSetGenerateHint(`Preview opened (${pageHint}) — not saved to history.`);
  } catch (err) {
    mroSetGenerateHint(err.message || 'Failed to preview ARC PDF');
  } finally {
    mroSetArcActionBusy(false, { previewLabel: 'Preview PDF', submitLabel: 'Create ARC' });
  }
}

async function mroCreateArc() {
  let payload;
  try {
    payload = mroCollectArcPayload();
  } catch (err) {
    mroSetGenerateHint(err.message || 'Invalid ARC form values.');
    return;
  }
  mroSetGenerateHint('');

  if (!payload.variants.length) {
    mroSetGenerateHint('Select at least one variant (CAAS, FAA, EASA, JCAB, or CAAC).');
    return;
  }
  if (!payload.certifying_staff) {
    const label = payload.part_type === 'new' ? '13d. Name' : '14d. Name';
    mroSetGenerateHint(`Select certifying staff (${label}).`);
    return;
  }

  mroSetArcActionBusy(true, { submitLabel: 'Creating…' });

  try {
    const res = await mroFetch('/api/mro/create-arc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      if (contentType.includes('application/json')) {
        const data = await res.json();
        message = data.error || message;
      }
      throw new Error(message);
    }

    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/i);
    const filename = match?.[1]
      || `ARC_${payload.variants.join('-')}.pdf`;

    mroDownloadBlob(blob, filename);
    try {
      mroOpenBlobPreview(blob);
    } catch (_) {
      // Download still succeeded if pop-ups are blocked.
    }

    const serialHint = mroFormatDocNosHint(res.headers);
    mroState.historyFlash = serialHint
      ? `Created ${serialHint}. PDF saved to history — open ARC creation history to view it again.`
      : 'ARC created. PDF saved to history — open ARC creation history to view it again.';
    mroState.historyLoaded = false;
    await Promise.all([
      mroLoadHistory({ quiet: true }),
      mroLoad({ force: false }),
    ]);
    mroUpdateHistoryBadge();
    mroCloseArcModal();
    mroSetTab('history');
  } catch (err) {
    mroSetGenerateHint(err.message || 'Failed to create ARC');
  } finally {
    mroSetArcActionBusy(false, { previewLabel: 'Preview PDF', submitLabel: 'Create ARC' });
  }
}

function mroFormatDocNosHint(headers) {
  const parts = [];
  const caas = headers.get('X-MRO-CAAS-Doc');
  const faa = headers.get('X-MRO-FAA-Doc');
  const easa = headers.get('X-MRO-EASA-Doc');
  const japan = headers.get('X-MRO-JCAB-Doc');
  const china = headers.get('X-MRO-CAAC-Doc');
  if (caas) parts.push(`CAAS ${caas}`);
  if (faa) parts.push(`FAA ${faa}`);
  if (easa) parts.push(`EASA ${easa}`);
  if (japan) parts.push(`JCAB ${japan}`);
  if (china) parts.push(`CAAC ${china}`);
  return parts.length ? parts.join(' · ') : '';
}

function mroHistorySearchHaystack(row) {
  return [
    row.history_id,
    row.caas_doc_no,
    row.faa_doc_no,
    row.easa_doc_no,
    row.jcab_doc_no,
    row.caac_doc_no,
    row.caas_tracking_no,
    row.faa_tracking_no,
    row.easa_tracking_no,
    row.jcab_tracking_no,
    row.caac_tracking_no,
    row.process_sheet_no,
    row.part_no,
    row.description,
    row.serial_no,
    row.customer_code,
    row.customer_name,
    row.customer_po_no,
    row.po_item_no,
    row.sales_order_no,
    row.certifying_staff,
    row.workscope,
    row.supplementary,
    row.remark,
    row.inspection_report,
    row.created_by,
  ]
    .filter((v) => v != null && String(v).trim() !== '')
    .join(' ')
    .toLowerCase();
}

function mroFilteredHistoryRows() {
  const search = mroState.historySearch.trim().toLowerCase();
  if (!search) return mroState.historyRows;
  return mroState.historyRows.filter((row) => mroHistorySearchHaystack(row).includes(search));
}

const MRO_TRACKING_PREFIXES = {
  CAAS: 'CEM / AW',
  FAA: 'CEM/FAA',
  EASA: 'CEM / EASA',
  JCAB: 'CEM / JCAB',
  CAAC: 'CEM / CAAC',
};

function mroDocCell(value) {
  if (value == null || String(value).trim() === '') return '<td>—</td>';
  const text = mroEscapeHtml(String(value));
  return `<td><span class="mro-doc-link" title="Dummy running serial">${text}</span></td>`;
}

function mroHistoryHasVariant(row, variant) {
  const variants = Array.isArray(row?.variants) ? row.variants : [];
  return variants.some((v) => String(v || '').toUpperCase() === variant);
}

function mroExtractRunningNumber(docNo) {
  const text = String(docNo || '').trim();
  if (!text) return '';
  const match = text.match(/(\d+)\s*$/);
  return match ? match[1] : text;
}

function mroTrackingFields(row, variant) {
  const key = variant.toLowerCase();
  const doc = row?.[`${key}_doc_no`] || '';
  const hasAuthority = Boolean(doc) || mroHistoryHasVariant(row, variant);
  const prefix = hasAuthority
    ? (row?.[`${key}_tracking_prefix`] || MRO_TRACKING_PREFIXES[variant] || '')
    : '';
  const number = row?.[`${key}_tracking_no`] || (doc ? mroExtractRunningNumber(doc) : '');
  return { doc, prefix, number, hasAuthority };
}

function mroTrackingPrefixCell(prefix, hasAuthority) {
  if (!hasAuthority || !prefix) return '<td class="mro-track-prefix">—</td>';
  return `<td class="mro-track-prefix">${mroEscapeHtml(prefix)}</td>`;
}

function mroTrackingNoCell(number, fullDoc) {
  if (number == null || String(number).trim() === '') {
    return '<td class="mro-track-no">—</td>';
  }
  const title = fullDoc ? ` title="${mroEscapeHtml(String(fullDoc))}"` : '';
  return `<td class="mro-track-no"><span class="mro-doc-link"${title}>${mroEscapeHtml(String(number))}</span></td>`;
}

function mroFormFlagCell(checked, kind) {
  const mark = checked ? '✓' : '';
  const cls = kind === 'd' ? 'mro-form-flag mro-form-flag--d' : 'mro-form-flag mro-form-flag--c';
  return `<td class="${cls}">${mark}</td>`;
}

function mroHistoryCustomer(row) {
  return row.customer_name || row.customer_code || '';
}

function mroHistoryReleaseDate(row) {
  const raw = row.cert_date || row.created_at || '';
  if (!raw) return '';
  return mroFormatDate(raw);
}

function mroHistoryQty(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return mroEscapeHtml(String(value));
  return String(Math.trunc(n));
}

function mroUpdateHistoryBadge() {
  const btn = document.querySelector('[data-mro-tab="history"]');
  if (!btn) return;
  const count = mroState.historyRows.length;
  let badge = btn.querySelector('.mro-history-badge');
  if (!count) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'mro-history-badge';
    badge.setAttribute('aria-label', `${count} creations`);
    btn.appendChild(badge);
  }
  badge.textContent = count > 99 ? '99+' : String(count);
}

function mroRenderHistoryTable() {
  const wrap = document.getElementById('mro-history-table-wrap');
  const body = document.getElementById('mro-history-table-body');
  const empty = document.getElementById('mro-history-empty');
  const meta = document.getElementById('mro-history-meta');
  if (!wrap || !body || !empty) return;

  const rows = mroFilteredHistoryRows();
  mroUpdateHistoryBadge();

  if (meta) {
    meta.hidden = false;
    if (mroState.historyFlash) {
      meta.textContent = mroState.historyFlash;
    } else {
      meta.textContent = `${rows.length} shown · ${mroState.historyRows.length} total · dummy serials (unique running numbers)`;
    }
  }

  if (!mroState.historyRows.length) {
    wrap.hidden = true;
    empty.hidden = false;
    empty.textContent = 'No ARC creations yet. Open a row from the ARC tab → Create ARC to start.';
    return;
  }

  if (!rows.length) {
    wrap.hidden = true;
    empty.hidden = false;
    empty.textContent = 'No history rows match your search.';
    return;
  }

  wrap.hidden = false;
  empty.hidden = true;
  body.innerHTML = rows.map((row) => {
    const caas = mroTrackingFields(row, 'CAAS');
    const faa = mroTrackingFields(row, 'FAA');
    const easa = mroTrackingFields(row, 'EASA');
    const jcab = mroTrackingFields(row, 'JCAB');
    const caac = mroTrackingFields(row, 'CAAC');
    return `
    <tr class="mro-row mro-history-row" data-history-id="${mroEscapeHtml(String(row.history_id || ''))}">
      <td class="mro-history-sn">${mroEscapeHtml(String(row.history_id || ''))}</td>
      ${mroTrackingPrefixCell(caas.prefix, caas.hasAuthority)}
      ${mroTrackingNoCell(caas.number, caas.doc)}
      ${mroTrackingPrefixCell(faa.prefix, faa.hasAuthority)}
      ${mroTrackingNoCell(faa.number, faa.doc)}
      ${mroTrackingPrefixCell(easa.prefix, easa.hasAuthority)}
      ${mroTrackingNoCell(easa.number, easa.doc)}
      ${mroTrackingPrefixCell(jcab.prefix, jcab.hasAuthority)}
      ${mroTrackingNoCell(jcab.number, jcab.doc)}
      ${mroTrackingPrefixCell(caac.prefix, caac.hasAuthority)}
      ${mroTrackingNoCell(caac.number, caac.doc)}
      ${mroFormFlagCell(!!row.form_c1, 'c')}
      ${mroFormFlagCell(!!row.form_c7, 'c')}
      ${mroFormFlagCell(!!row.form_c14, 'c')}
      ${mroFormFlagCell(!!row.form_d1, 'd')}
      ${mroCell(mroHistoryReleaseDate(row))}
      ${mroCell(row.certifying_staff)}
      ${mroCell(mroHistoryCustomer(row))}
      ${mroCell(row.part_no)}
      ${mroCell(row.description, 'mro-desc')}
      ${mroCell(row.customer_po_no)}
      ${mroCell(row.process_sheet_no)}
      ${mroCell(row.inspection_report || row.supplementary)}
      ${mroCell(row.serial_no || row.sales_order_no)}
      <td>${mroEscapeHtml(String(row.item_count != null ? row.item_count : 1))}</td>
      ${mroCell(row.po_item_no)}
      <td>${mroHistoryQty(row.so_qty)}</td>
      ${mroCell(row.remark || row.workscope, 'mro-history-remark')}
      <td class="mro-history-actions">
        <button
          type="button"
          class="mro-btn mro-btn--ghost mro-btn--compact"
          data-mro-download-history="${mroEscapeHtml(String(row.history_id || ''))}"
          title="Open stored ARC PDF"
        >View PDF</button>
        <button
          type="button"
          class="mro-btn mro-btn--danger-ghost mro-history-delete mro-btn--compact"
          data-mro-delete-history="${mroEscapeHtml(String(row.history_id || ''))}"
          title="Delete this test ARC (testing only)"
        >Delete</button>
      </td>
    </tr>
  `;
  }).join('');
}

async function mroDeleteHistory(historyId) {
  const id = String(historyId || '').trim();
  if (!id) return;
  const row = mroState.historyRows.find((item) => String(item.history_id) === id);
  const label = [
    row?.caas_doc_no,
    row?.faa_doc_no,
    row?.easa_doc_no,
    row?.jcab_doc_no,
    row?.caac_doc_no,
    row?.sales_order_no,
  ].filter(Boolean).join(' / ') || `history #${id}`;

  if (!window.confirm(`Delete ARC ${label}?\n\nThis is allowed for testing only. Production will keep ARC history immutable.`)) {
    return;
  }

  const btn = document.querySelector(`[data-mro-delete-history="${id}"]`);
  if (btn) btn.disabled = true;

  try {
    const res = await mroFetch(`/api/mro/arc-history/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    mroState.historyRows = mroState.historyRows.filter((item) => String(item.history_id) !== id);
    mroState.historyFlash = `Deleted ${label}. Local completion cleared — reload ARC list if needed.`;
    mroRenderHistoryTable();
    // Refresh ARC list so Incomplete filter reflects cleared app flag.
    mroLoad({ force: false }).catch(() => {});
  } catch (err) {
    if (btn) btn.disabled = false;
    window.alert(err.message || 'Failed to delete ARC history');
  }
}

async function mroLoadHistory({ quiet = false } = {}) {
  const loading = document.getElementById('mro-history-loading');
  if (!quiet && loading) loading.hidden = false;

  try {
    const res = await mroFetch('/api/mro/arc-history');
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    mroState.historyRows = Array.isArray(data.rows) ? data.rows : [];
    mroState.historyLoaded = true;
    mroRenderHistoryTable();
  } catch (err) {
    mroState.historyRows = [];
    mroState.historyLoaded = false;
    mroRenderHistoryTable();
    const empty = document.getElementById('mro-history-empty');
    if (empty) {
      empty.hidden = false;
      empty.textContent = `Failed to load history: ${err.message || err}`;
    }
  } finally {
    if (loading) loading.hidden = true;
  }
}

function mroPopulateStaffDropdown(selectedName = '') {
  const select = document.getElementById('mro-arc-certifying-staff');
  if (!select) return;
  const current = selectedName || select.value || '';
  const staff = mroState.certifyingStaff || [];
  if (!staff.length) {
    select.innerHTML = '<option value="">No certifying staff yet — manage the list first</option>';
    return;
  }
  select.innerHTML = [
    '<option value="">Select certifying staff…</option>',
    ...staff.map((person) => {
      const name = String(person.name || '').trim();
      const selected = name && name === current ? ' selected' : '';
      return `<option value="${mroEscapeHtml(name)}"${selected}>${mroEscapeHtml(name)}</option>`;
    }),
  ].join('');
}

function mroSetStaffStatus(message, type = 'info') {
  const el = document.getElementById('mro-staff-status');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    el.className = 'mro-staff-status';
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = `mro-staff-status mro-staff-status--${type}`;
}

function mroRenderStaffList() {
  const list = document.getElementById('mro-staff-list');
  const empty = document.getElementById('mro-staff-empty');
  if (!list || !empty) return;
  const staff = mroState.certifyingStaff || [];
  if (!staff.length) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = staff.map((person) => {
    const staffId = String(person.staff_id);
    const hasSig = !!person.has_signature;
    return `
      <li class="mro-staff-item">
        <div class="mro-staff-item-main">
          <span class="mro-staff-item-name">${mroEscapeHtml(person.name)}</span>
          ${hasSig
            ? `<img class="mro-staff-sig-preview" src="${mroAuthorizedUrl(`/api/mro/certifying-staff/${encodeURIComponent(staffId)}/signature?t=${Date.now()}`)}" alt="E-signature for ${mroEscapeHtml(person.name)}" />`
            : '<span class="mro-staff-sig-missing">No e-signature</span>'}
        </div>
        <div class="mro-staff-item-actions">
          <label class="mro-btn mro-btn--ghost mro-staff-upload-btn">
            ${hasSig ? 'Replace signature' : 'Upload signature'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
              hidden
              data-mro-upload-signature="${mroEscapeHtml(staffId)}"
            >
          </label>
          ${hasSig ? `
            <button
              type="button"
              class="mro-btn mro-btn--ghost"
              data-mro-clear-signature="${mroEscapeHtml(staffId)}"
            >Clear signature</button>
          ` : ''}
          <button
            type="button"
            class="mro-btn mro-btn--danger-ghost"
            data-mro-remove-staff="${mroEscapeHtml(staffId)}"
          >Remove</button>
        </div>
      </li>
    `;
  }).join('');
}

async function mroReloadCertifyingStaff() {
  const res = await mroFetch('/api/mro/certifying-staff');
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  mroState.certifyingStaff = Array.isArray(data.staff) ? data.staff : [];
  mroRenderStaffList();
  mroPopulateStaffDropdown();
  return mroState.certifyingStaff;
}

async function mroOpenStaffModal() {
  const modal = document.getElementById('mro-staff-modal');
  if (!modal) return;
  mroSetStaffStatus('');
  modal.hidden = false;
  document.body.classList.add('mro-modal-open');
  try {
    await mroReloadCertifyingStaff();
  } catch (err) {
    mroRenderStaffList();
    mroSetStaffStatus(err.message || 'Failed to load staff', 'error');
  }
  document.getElementById('mro-staff-name')?.focus();
}

function mroCloseStaffModal() {
  const modal = document.getElementById('mro-staff-modal');
  if (modal) modal.hidden = true;
  mroSyncBodyModalClass();
}

async function mroLoadCorrectionTemplates() {
  try {
    const res = await mroFetch('/api/mro/arc-correction-templates');
    const data = await res.json();
    if (!res.ok || !data.ok) return;
    const templates = data.templates || {};
    Object.keys(MRO_ARC_VARIANTS).forEach((variant) => {
      if (templates[variant]) {
        MRO_ARC_VARIANTS[variant].correctionTemplate = String(templates[variant]);
      }
    });
  } catch (err) {
    // Keep empty templates; Insert button will show a hint.
  }
}

function mroInsertCorrectionTemplate(variant) {
  const key = String(variant || '').toUpperCase();
  const config = MRO_ARC_VARIANTS[key];
  const textarea = document.getElementById(`mro-arc-correction-${key.toLowerCase()}`);
  if (!textarea || !config) return;
  const template = String(config.correctionTemplate || '').trim();
  if (!template) {
    mroSetGenerateHint(`No template configured yet for ${key}. Edit ARC_CORRECTION_TEMPLATES in mro_arc_pdf.py.`);
    return;
  }
  textarea.value = template;
  textarea.focus();
  mroSetGenerateHint(`Inserted ${key} ARC Correction template.`);
}

function mroSetWorkscopeStatus(message, type = 'info') {
  const el = document.getElementById('mro-workscope-status');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    el.className = 'mro-staff-status';
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = `mro-staff-status mro-staff-status--${type}`;
}

function mroRenderWorkscopeResults(rows) {
  const results = document.getElementById('mro-workscope-results');
  const empty = document.getElementById('mro-workscope-empty');
  if (!results || !empty) return;
  if (!rows.length) {
    results.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  results.innerHTML = rows.map((row, index) => `
    <article class="mro-workscope-result">
      <div class="mro-workscope-result-meta">
        <span><strong>PS</strong> ${mroEscapeHtml(row.process_sheet_no || row.pp_voucher_no || '—')}</span>
        <span><strong>WO</strong> ${mroEscapeHtml(row.wo_voucher_no || '—')}</span>
        <span><strong>Part</strong> ${mroEscapeHtml(row.part_no || row.inventory_code || '—')}</span>
        <span><strong>BOM</strong> ${mroEscapeHtml(row.bom_code || '—')}</span>
        <span><strong>SO</strong> ${mroEscapeHtml(row.sales_order_no || '—')}</span>
      </div>
      <pre class="mro-workscope-result-text">${mroEscapeHtml(row.remarks_trimmed || row.remarks || '')}</pre>
      <button
        type="button"
        class="mro-btn mro-btn--primary mro-btn--compact"
        data-mro-insert-workscope="${index}"
      >Insert into Workscope</button>
    </article>
  `).join('');
  results.dataset.rows = JSON.stringify(rows);
}

async function mroSearchWorkscopeRemarks() {
  const partInput = document.getElementById('mro-workscope-part');
  const bomInput = document.getElementById('mro-workscope-bom');
  const psInput = document.getElementById('mro-workscope-ps');
  const qInput = document.getElementById('mro-workscope-q');
  const partNo = partInput?.value || '';
  const bomCode = bomInput?.value || '';
  const ps = psInput?.value || '';
  const q = qInput?.value || '';
  if (![partNo, bomCode, ps, q].some((value) => String(value).trim())) {
    mroSetWorkscopeStatus('Enter a part no., BOM code, process sheet, or keyword.', 'error');
    return;
  }

  const params = new URLSearchParams();
  if (String(partNo).trim()) params.set('part_no', String(partNo).trim());
  if (String(bomCode).trim()) params.set('bom_code', String(bomCode).trim());
  if (String(ps).trim()) params.set('process_sheet_no', String(ps).trim());
  if (String(q).trim()) params.set('q', String(q).trim());

  const btn = document.getElementById('mro-workscope-search-btn');
  if (btn) btn.disabled = true;
  mroSetWorkscopeStatus('Searching…', 'pending');
  try {
    const res = await mroFetch(`/api/mro/workscope-remarks?${params.toString()}`);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    const resolved = data.resolved && typeof data.resolved === 'object' ? data.resolved : null;
    if (resolved) {
      if (partInput && resolved.part_no) partInput.value = resolved.part_no;
      if (bomInput && resolved.bom_code) bomInput.value = resolved.bom_code;
      if (psInput && resolved.process_sheet_no) psInput.value = resolved.process_sheet_no;
    }
    const rows = Array.isArray(data.rows) ? data.rows : [];
    mroRenderWorkscopeResults(rows);
    if (rows.length) {
      mroSetWorkscopeStatus(
        `${rows.length} remark${rows.length === 1 ? '' : 's'} found`,
        'success'
      );
    } else if (resolved && (resolved.part_no || resolved.bom_code)) {
      const bits = [];
      if (resolved.part_no) bits.push(`part ${resolved.part_no}`);
      if (resolved.bom_code) bits.push(`BOM ${resolved.bom_code}`);
      mroSetWorkscopeStatus(
        `Resolved ${bits.join(' / ')} from process sheet / work order, but no Inventory BOM remarks found`,
        'info'
      );
    } else {
      mroSetWorkscopeStatus('No matching ERP remarks', 'info');
    }
  } catch (err) {
    mroRenderWorkscopeResults([]);
    mroSetWorkscopeStatus(err.message || 'Search failed', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function mroOpenWorkscopeModal() {
  const modal = document.getElementById('mro-workscope-modal');
  if (!modal) return;
  const row = mroState.modalRow || {};
  const partInput = document.getElementById('mro-workscope-part');
  const bomInput = document.getElementById('mro-workscope-bom');
  const psInput = document.getElementById('mro-workscope-ps');
  const qInput = document.getElementById('mro-workscope-q');
  if (partInput) {
    partInput.value = row.inventory_code
      || document.querySelector('#mro-arc-items-body .mro-arc-item-part')?.value
      || '';
  }
  if (bomInput) bomInput.value = row.bom_code || row.parent_inventory_code || '';
  if (psInput) psInput.value = mroRowPs(row);
  if (qInput) qInput.value = '';
  mroSetWorkscopeStatus('');
  mroRenderWorkscopeResults([]);
  modal.hidden = false;
  document.body.classList.add('mro-modal-open');
  await mroSearchWorkscopeRemarks();
  document.getElementById('mro-workscope-q')?.focus();
}

function mroCloseWorkscopeModal() {
  const modal = document.getElementById('mro-workscope-modal');
  if (modal) modal.hidden = true;
  mroSyncBodyModalClass();
}

function mroInsertWorkscopeRemark(index) {
  const results = document.getElementById('mro-workscope-results');
  const workscope = document.getElementById('mro-arc-workscope');
  if (!results || !workscope) return;
  let rows = [];
  try {
    rows = JSON.parse(results.dataset.rows || '[]');
  } catch (err) {
    rows = [];
  }
  const row = rows[Number(index)];
  if (!row || !row.remarks) return;
  const text = String(row.remarks_trimmed || row.remarks || '').trim();
  if (!text) return;
  const existing = String(workscope.value || '').trim();
  workscope.value = existing ? `${existing}\n\n${text}` : text;
  mroApplyExtractedStatus(row.extracted_status);
  mroCloseWorkscopeModal();
  workscope.focus();
  mroSetGenerateHint('Inserted ERP remarks into Workscope (status trimmed).');
}

async function mroOpenArcModal(row) {
  mroState.modalRow = row;
  mroState.soHeader = null;
  const modal = document.getElementById('mro-arc-modal');
  const title = document.getElementById('mro-arc-modal-title');
  const soLine = document.getElementById('mro-arc-modal-so');
  if (!modal) return;

  const so = String(row.sales_order_no || '').trim() || '—';
  if (title) title.textContent = 'Authorisation Release Certificate (ARC)';
  if (soLine) soLine.textContent = so;

  document.querySelectorAll('input[name="mro-arc-variant"]').forEach((input) => {
    input.checked = input.value === 'CAAS';
  });

  mroResetArcFormFields();
  mroSyncArcVariantPanels();
  mroFillArcGeneral(row, null);
  mroFillArcItems(row);

  modal.hidden = false;
  document.body.classList.add('mro-modal-open');
  modal.querySelector('.mro-modal-close')?.focus();

  const soNo = String(row.sales_order_no || '').trim();
  const loadHeader = soNo
    ? mroFetchSoHeader(soNo).then((header) => {
      if (mroState.modalRow !== row) return;
      mroState.soHeader = header;
      mroFillArcGeneral(row, header);
    }).catch((err) => {
      if (mroState.modalRow !== row) return;
      console.warn('MRO SO header lookup failed:', err);
      mroSetGenerateHint(err.message || 'Could not load sales order header details.');
    })
    : Promise.resolve();

  const loadStaff = (async () => {
    try {
      if (!mroState.certifyingStaff.length) {
        await mroReloadCertifyingStaff();
      }
    } catch (err) {
      // Keep empty dropdown; user can still open staff settings.
    }
    mroPopulateStaffDropdown();
  })();

  const loadWorkscope = mroAutofillWorkscopeFromBom(row);

  await Promise.all([loadHeader, loadStaff, loadWorkscope]);
}

function mroAnyModalOpen() {
  return (
    document.getElementById('mro-arc-modal')?.hidden === false
    || document.getElementById('mro-detail-modal')?.hidden === false
    || document.getElementById('mro-staff-modal')?.hidden === false
    || document.getElementById('mro-workscope-modal')?.hidden === false
  );
}

async function mroLoad({ force = false } = {}) {
  const loading = document.getElementById('mro-loading');
  if (loading) loading.hidden = false;

  try {
    const url = force ? '/api/mro/arc-format?refresh=1' : '/api/mro/arc-format';
    const res = await mroFetch(url);
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    mroState.rows = Array.isArray(data.rows) ? data.rows : [];
    mroState.cachedAt = data.cached_at || '';
    mroState.cacheTtlSec = data.cache_ttl_sec || 300;
    mroRenderMeta();
    mroRenderTable();
  } catch (err) {
    mroState.rows = [];
    mroRenderTable();
    const empty = document.getElementById('mro-empty');
    if (empty) {
      empty.hidden = false;
      empty.textContent = `Failed to load: ${err.message || err}`;
    }
    const statsEl = document.getElementById('mro-stats');
    if (statsEl) statsEl.textContent = 'Failed to load ARC format';
  } finally {
    if (loading) loading.hidden = true;
  }
}

document.getElementById('mro-search')?.addEventListener('input', (event) => {
  mroState.search = event.target.value || '';
  mroRenderTable();
});

document.getElementById('mro-ps-type-filter')?.addEventListener('change', (event) => {
  mroState.psTypeFilter = event.target.value || 'MPS';
  mroRenderTable();
});

document.getElementById('mro-status-filter')?.addEventListener('change', (event) => {
  mroState.statusFilter = event.target.value || 'all';
  mroRenderTable();
});

document.getElementById('mro-refresh')?.addEventListener('click', () => mroLoad({ force: true }));
document.getElementById('mro-manage-staff')?.addEventListener('click', () => {
  mroOpenStaffModal();
});

document.querySelectorAll('[data-mro-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    mroSetTab(btn.getAttribute('data-mro-tab') || 'arc');
  });
});

document.querySelectorAll('[data-mro-section]').forEach((btn) => {
  btn.addEventListener('click', () => {
    mroSetTab(btn.getAttribute('data-mro-section') === 'tracking' ? 'tracking' : 'arc');
  });
});

document.getElementById('mro-table-body')?.addEventListener('click', (event) => {
  const btn = event.target.closest('.mro-generate-btn');
  if (btn) {
    event.stopPropagation();
    const index = Number(btn.getAttribute('data-row-index'));
    const row = mroFilteredRows()[index];
    if (row) mroOpenArcModal(row);
    return;
  }
  const tr = event.target.closest('tr.mro-row');
  if (!tr) return;
  const index = Number(tr.getAttribute('data-row-index'));
  const row = mroFilteredRows()[index];
  if (row) mroOpenDetailModal(row);
});

document.getElementById('mro-table-body')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const tr = event.target.closest('tr.mro-row');
  if (!tr || event.target.closest('.mro-generate-btn')) return;
  event.preventDefault();
  const index = Number(tr.getAttribute('data-row-index'));
  const row = mroFilteredRows()[index];
  if (row) mroOpenDetailModal(row);
});

document.getElementById('mro-detail-modal')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-mro-detail-close]')) {
    mroCloseDetailModal();
  }
});

document.getElementById('mro-detail-generate')?.addEventListener('click', () => {
  const row = mroState.detailRow;
  mroCloseDetailModal();
  if (row) mroOpenArcModal(row);
});

document.getElementById('mro-arc-modal')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-mro-modal-close]')) {
    mroCloseArcModal();
    return;
  }
  const removeBtn = event.target.closest('[data-mro-remove-item]');
  if (removeBtn) {
    const tr = removeBtn.closest('tr.mro-arc-item-row');
    if (tr) {
      tr.remove();
      mroRenumberArcItems();
    }
  }
});

document.getElementById('mro-arc-modal-preview')?.addEventListener('click', () => {
  mroPreviewArc();
});

document.getElementById('mro-arc-modal-submit')?.addEventListener('click', () => {
  mroCreateArc();
});

document.getElementById('mro-history-search')?.addEventListener('input', (event) => {
  mroState.historySearch = event.target.value || '';
  mroRenderHistoryTable();
});

document.getElementById('mro-tracking-search')?.addEventListener('input', (event) => {
  mroState.trackingSearch = event.target.value || '';
  mroRenderTrackingTable();
});

document.getElementById('mro-tracking-status')?.addEventListener('change', (event) => {
  mroState.trackingStatus = event.target.value || 'active';
  const needsCompleted = ['all', 'completed'].includes(mroState.trackingStatus);
  if (needsCompleted && !mroState.trackingIncludesCompleted) {
    mroLoadTracking({ includeCompleted: true });
  } else {
    mroRenderTrackingTable();
  }
});

document.getElementById('mro-tracking-hide-zero-value')?.addEventListener('change', (event) => {
  mroState.trackingHideZeroValue = event.target.checked;
  mroRenderTrackingTable();
});

document.getElementById('mro-tracking-refresh')?.addEventListener('click', () => {
  mroState.trackingLoaded = false;
  const includeCompleted = ['all', 'completed'].includes(mroState.trackingStatus);
  mroLoadTracking({ force: true, includeCompleted });
});

document.getElementById('mro-tracking-table-body')?.addEventListener('click', (event) => {
  const collapseBtn = event.target.closest('[data-tracking-collapse]');
  if (collapseBtn) {
    const detailRow = collapseBtn.closest('tr.mro-tracking-detail-row');
    if (detailRow) {
      detailRow.hidden = true;
      detailRow.previousElementSibling?.setAttribute('aria-expanded', 'false');
      mroState.trackingModalKey = '';
    }
    return;
  }
  const rowEl = event.target.closest('tr[data-tracking-index]');
  if (!rowEl) return;
  const row = mroFilteredTrackingRows()[Number(rowEl.getAttribute('data-tracking-index'))];
  if (row) mroToggleTrackingDetail(row, rowEl);
});

document.getElementById('mro-tracking-table-body')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const rowEl = event.target.closest('tr[data-tracking-index]');
  if (!rowEl) return;
  event.preventDefault();
  const row = mroFilteredTrackingRows()[Number(rowEl.getAttribute('data-tracking-index'))];
  if (row) mroToggleTrackingDetail(row, rowEl);
});

document.getElementById('mro-history-refresh')?.addEventListener('click', () => {
  mroState.historyFlash = '';
  mroState.historyLoaded = false;
  mroLoadHistory();
});

async function mroDownloadHistoryPdf(historyId, { download = false } = {}) {
  const id = String(historyId || '').trim();
  if (!id) return;
  const btn = document.querySelector(`[data-mro-download-history="${id}"]`);
  if (btn) btn.disabled = true;
  try {
    const res = await mroFetch(`/api/mro/arc-history/${encodeURIComponent(id)}/pdf`);
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      if (contentType.includes('application/json')) {
        const data = await res.json();
        message = data.error || message;
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/i);
    const filename = match?.[1] || `ARC_history_${id}.pdf`;
    if (download) {
      mroDownloadBlob(blob, filename);
    }
    mroOpenBlobPreview(blob);
    mroState.historyFlash = `Opened PDF for history #${id}.`;
    mroRenderHistoryTable();
  } catch (err) {
    mroState.historyFlash = err.message || 'Failed to open ARC PDF';
    mroRenderHistoryTable();
    window.alert(err.message || 'Failed to open ARC PDF');
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.getElementById('mro-history-table-body')?.addEventListener('click', (event) => {
  const downloadBtn = event.target.closest('[data-mro-download-history]');
  if (downloadBtn) {
    event.stopPropagation();
    mroDownloadHistoryPdf(downloadBtn.getAttribute('data-mro-download-history'));
    return;
  }
  const btn = event.target.closest('[data-mro-delete-history]');
  if (!btn) return;
  event.stopPropagation();
  mroDeleteHistory(btn.getAttribute('data-mro-delete-history'));
});

document.getElementById('mro-arc-form')?.addEventListener('change', (event) => {
  const target = event.target;
  if (!target) return;
  if (target.name === 'mro-arc-variant') {
    mroSyncArcVariantPanels();
  }
  if (target.name === 'mro-arc-part-type') {
    mroSyncPartTypePanels();
  }
});

document.getElementById('mro-arc-form')?.addEventListener('click', (event) => {
  const insertBtn = event.target.closest('[data-mro-insert-correction]');
  if (insertBtn) {
    event.preventDefault();
    mroInsertCorrectionTemplate(insertBtn.getAttribute('data-mro-insert-correction'));
  }
});

document.getElementById('mro-arc-workscope-search')?.addEventListener('click', () => {
  mroOpenWorkscopeModal();
});

document.getElementById('mro-workscope-modal')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-mro-workscope-close]')) {
    mroCloseWorkscopeModal();
    return;
  }
  const insertBtn = event.target.closest('[data-mro-insert-workscope]');
  if (insertBtn) {
    mroInsertWorkscopeRemark(insertBtn.getAttribute('data-mro-insert-workscope'));
  }
});

document.getElementById('mro-workscope-search-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  mroSearchWorkscopeRemarks();
});

document.getElementById('mro-arc-form')?.addEventListener('change', (event) => {
  const target = event.target;
  if (target && target.id === 'mro-arc-item-qty') {
    const normalized = mroNormalizeWholeQty(target.value);
    if (normalized !== null && String(target.value) !== normalized) {
      target.value = normalized;
    }
  }
});

document.getElementById('mro-staff-modal')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-mro-staff-close]')) {
    mroCloseStaffModal();
  }
});

document.getElementById('mro-staff-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('mro-staff-name');
  const submitBtn = event.target.querySelector('button[type="submit"]');
  const name = String(input?.value || '').trim();
  if (!name) return;
  if (submitBtn) submitBtn.disabled = true;
  mroSetStaffStatus('Saving…', 'pending');
  try {
    const res = await mroFetch('/api/mro/certifying-staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    await mroReloadCertifyingStaff();
    if (input) input.value = '';
    mroSetStaffStatus(data.message || `Saved ${name}`, data.created ? 'success' : 'info');
    input?.focus();
  } catch (err) {
    mroSetStaffStatus(err.message || 'Could not save staff', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

document.getElementById('mro-staff-list')?.addEventListener('click', async (event) => {
  const clearBtn = event.target.closest('[data-mro-clear-signature]');
  if (clearBtn && !clearBtn.disabled) {
    const staffId = clearBtn.getAttribute('data-mro-clear-signature');
    if (!staffId) return;
    clearBtn.disabled = true;
    mroSetStaffStatus('Clearing signature…', 'pending');
    try {
      const res = await mroFetch(`/api/mro/certifying-staff/${encodeURIComponent(staffId)}/signature`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      await mroReloadCertifyingStaff();
      mroSetStaffStatus(data.message || 'Signature cleared', 'success');
    } catch (err) {
      mroSetStaffStatus(err.message || 'Could not clear signature', 'error');
      clearBtn.disabled = false;
    }
    return;
  }

  const btn = event.target.closest('[data-mro-remove-staff]');
  if (!btn || btn.disabled) return;
  const staffId = btn.getAttribute('data-mro-remove-staff');
  if (!staffId) return;
  btn.disabled = true;
  mroSetStaffStatus('Removing…', 'pending');
  try {
    const res = await mroFetch(`/api/mro/certifying-staff/${encodeURIComponent(staffId)}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    await mroReloadCertifyingStaff();
    mroSetStaffStatus('Removed', 'success');
  } catch (err) {
    mroSetStaffStatus(err.message || 'Could not remove staff', 'error');
    btn.disabled = false;
  }
});

document.getElementById('mro-staff-list')?.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-mro-upload-signature]');
  if (!input || input.tagName !== 'INPUT') return;
  const staffId = input.getAttribute('data-mro-upload-signature');
  const file = input.files && input.files[0];
  input.value = '';
  if (!staffId || !file) return;
  mroSetStaffStatus('Uploading signature…', 'pending');
  try {
    const body = new FormData();
    body.append('signature', file);
    const res = await mroFetch(`/api/mro/certifying-staff/${encodeURIComponent(staffId)}/signature`, {
      method: 'POST',
      body,
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    await mroReloadCertifyingStaff();
    mroSetStaffStatus(data.message || 'Signature saved', 'success');
  } catch (err) {
    mroSetStaffStatus(err.message || 'Could not upload signature', 'error');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !mroAnyModalOpen()) return;
  if (document.getElementById('mro-workscope-modal')?.hidden === false) {
    mroCloseWorkscopeModal();
    return;
  }
  if (document.getElementById('mro-staff-modal')?.hidden === false) {
    mroCloseStaffModal();
    return;
  }
  if (document.getElementById('mro-arc-modal')?.hidden === false) {
    mroCloseArcModal();
    return;
  }
  mroCloseDetailModal();
});

if (window.__MRO_PAGE__ === 'tracking') {
  mroSetTab('tracking');
} else {
  mroSetTab('arc');
  mroLoadCorrectionTemplates().catch(() => {});
  mroReloadCertifyingStaff().catch(() => {});
  mroLoadHistory({ quiet: true }).catch(() => {});
  mroLoad();
}
