// Inventory Enquiry — ic_inventory_enquiry_summary_view (grouped by inventory class).

const invState = {
  rows: [],
  lotRows: [],
  lotsLoaded: false,
  lotsLoading: false,
  tableView: 'summary',
  classView: 'all',
  stockFilter: 'all',
  search: '',
  searchMode: 'part',
  cachedAt: '',
  lotCachedAt: '',
  cacheTtlSec: 300,
  selectedCode: '',
  selectedLotKey: '',
  selectedLotRef: '',
  stockCounts: {},
  partLotStatus: {},
};

const INV_CLASS_LABELS = {
  all: 'All inventory',
  raw_material: 'Raw material',
  fg_mfg_commercial: 'FG MFG commercial',
  fg_mro: 'FG MRO',
  cp: 'CP',
  cfm: 'CFM',
  other: 'Other',
};

const INV_GROUP_LABELS = {
  raw_material: 'Raw material',
  fg_mfg_commercial: 'FG MFG commercial',
  fg_mro: 'FG MRO',
  cp: 'CP',
  cfm: 'CFM',
  other: 'Other / unclassified',
};

const INV_CLASS_ORDER = [
  'raw_material',
  'fg_mfg_commercial',
  'fg_mro',
  'cp',
  'cfm',
  'other',
];

const INV_DETAIL_SECTIONS = [
  {
    title: 'Part',
    fields: [
      ['Part no', 'inventory_code', { mono: true }],
      ['Main description', 'main_desc', { fullWidth: true }],
      ['Short description', 'short_desc', { fullWidth: true }],
    ],
  },
  {
    title: 'Classification',
    fields: [
      ['Class', 'inventory_class_code'],
      ['Category', 'inventory_category_code'],
      ['Brand', 'inventory_brand_code'],
      ['UOM', 'uom_code'],
    ],
  },
  {
    title: 'Available quantities',
    numeric: true,
    fields: [
      ['QOH available', 'total_qoh_available'],
      ['QOO available', 'total_qoo_available'],
    ],
  },
  {
    title: 'Balances & allocation',
    numeric: true,
    fields: [
      ['Qty on hand', 'total_qty_on_hand'],
      ['Qty on order', 'total_qty_on_order'],
      ['Free balance', 'total_free_balance_qty'],
      ['Allocated in SQ', 'total_allocated_in_sq'],
      ['Unallocated qty', 'total_unallocated_qty'],
      ['Back order', 'total_qty_back_order'],
    ],
  },
];

const INV_TABLE_COL_COUNT = 13;
const INV_LOT_CHIP_LIMIT = 3;

const INV_TABLE_VIEW_LABELS = {
  summary: 'Part summary',
  lot: 'By lot reference',
};

function invFormatDate(value) {
  if (!value) return '—';
  const text = String(value).trim();
  if (!text) return '—';
  const datePart = text.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    const [year, month, day] = datePart.split('-').map((part) => Number(part));
    const dt = new Date(year, month - 1, day);
    if (!Number.isNaN(dt.getTime())) {
      return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
    }
  }
  return text;
}

function invLocationLabel(lot) {
  const code = String(lot?.location_code || '').trim();
  const name = String(lot?.location_name || '').trim();
  if (code && name) return `${code} · ${name}`;
  return code || name || '—';
}

function invNormCode(value) {
  return String(value || '').trim().toUpperCase();
}

function invPartMeta(code) {
  const target = invNormCode(code);
  if (!target) return null;
  return invState.rows.find((row) => invNormCode(row.inventory_code) === target) || null;
}

function invLotsForPart(code) {
  const target = invNormCode(code);
  if (!target) return [];
  return invState.lotRows.filter((lot) => invNormCode(lot.inventory_code) === target);
}

function invLotSummaries(row) {
  const fromLots = invGroupLotsByRef(invLotsForPart(row?.inventory_code));
  if (fromLots.length) {
    return fromLots.map((group) => ({
      reference_no: group.reference_no,
      remaining_qty: group.remaining_qty,
      original_qty: group.original_qty,
      allocation_qty: group.allocation_qty,
      available_qty: group.available_qty,
      batch_count: group.lots.length,
    }));
  }
  if (Array.isArray(row?.lot_summaries) && row.lot_summaries.length) {
    return row.lot_summaries;
  }
  return (row?.lot_reference_nos || []).map((reference_no) => ({
    reference_no,
    remaining_qty: null,
    original_qty: null,
    allocation_qty: null,
    available_qty: null,
    batch_count: 0,
  }));
}

function invBatchNo(lot) {
  const batch = String(lot?.batch_no || lot?.lot_no || '').trim();
  return batch || '—';
}

function invGroupLotsByRef(lots) {
  const groups = [];
  const index = new Map();
  for (const lot of lots || []) {
    const ref = String(lot.reference_no || '').trim() || '—';
    if (!index.has(ref)) {
      const group = {
        reference_no: ref,
        lots: [],
        remaining_qty: 0,
        original_qty: 0,
        allocation_qty: 0,
        available_qty: 0,
      };
      index.set(ref, group);
      groups.push(group);
    }
    const group = index.get(ref);
    group.lots.push(lot);
    group.remaining_qty += invQty(lot, 'remaining_qty');
    group.original_qty += invQty(lot, 'original_qty');
    group.allocation_qty += invQty(lot, 'allocation_qty');
    group.available_qty += invQty(lot, 'available_qty');
  }
  return groups;
}

function invQty(row, key) {
  const n = Number(row?.[key]);
  return Number.isFinite(n) ? n : 0;
}

function invFormatNum(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  if (Math.abs(n) < 0.0001 && n !== 0) return String(value);
  if (Number.isInteger(n)) return String(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function invMatchesStock(row) {
  const filter = invState.stockFilter;
  if (filter === 'on_hand') return invQty(row, 'total_qty_on_hand') > 0;
  if (filter === 'on_order') return invQty(row, 'total_qty_on_order') > 0;
  if (filter === 'free_balance') return invQty(row, 'total_free_balance_qty') > 0;
  if (filter === 'back_order') return invQty(row, 'total_qty_back_order') > 0;
  return true;
}

function invMatchesClass(row) {
  if (invState.classView === 'all') return true;
  return (row?.class_key || 'other') === invState.classView;
}

function invLotReferenceText(row) {
  return (row?.lot_reference_nos || [])
    .map((v) => String(v == null ? '' : v).toLowerCase())
    .join(' ');
}

function invRowSearchText(row) {
  const parts = [
    row.inventory_code,
    row.main_desc,
    row.short_desc,
    row.inventory_class_code,
    row.inventory_category_code,
    row.inventory_brand_code,
    row.uom_code,
  ];
  return parts.map((v) => String(v == null ? '' : v).toLowerCase()).join(' ');
}

function invMatchesSearch(row) {
  const q = String(invState.search || '').trim().toLowerCase();
  if (!q) return true;
  if (invState.searchMode === 'lot_ref') {
    return invLotReferenceText(row).includes(q);
  }
  return invRowSearchText(row).includes(q);
}

function invLotSearchText(lot, part) {
  const parts = [
    lot.reference_no,
    lot.batch_no,
    lot.lot_no,
    lot.inventory_code,
    lot.location_code,
    lot.location_name,
    part?.main_desc,
    part?.short_desc,
    part?.inventory_class_code,
    part?.inventory_category_code,
    part?.uom_code,
  ];
  return parts.map((v) => String(v == null ? '' : v).toLowerCase()).join(' ');
}

function invLotMatchesClass(lot) {
  if (invState.classView === 'all') return true;
  const part = invPartMeta(lot.inventory_code);
  if (!part) return invState.classView === 'other';
  return (part.class_key || 'other') === invState.classView;
}

function invLotMatchesStock(lot) {
  const filter = invState.stockFilter;
  if (filter === 'all') return true;
  const part = invPartMeta(lot.inventory_code);
  if (!part) {
    if (filter === 'on_hand') return invQty(lot, 'remaining_qty') > 0;
    return false;
  }
  return invMatchesStock(part);
}

function invLotMatchesSearch(lot) {
  const q = String(invState.search || '').trim().toLowerCase();
  if (!q) return true;
  const part = invPartMeta(lot.inventory_code);
  if (invState.tableView === 'lot') {
    return invLotSearchText(lot, part).includes(q);
  }
  if (invState.searchMode === 'lot_ref') {
    return String(lot.reference_no || '').toLowerCase().includes(q);
  }
  if (invState.searchMode === 'part') {
    return invRowSearchText(part || { inventory_code: lot.inventory_code }).includes(q);
  }
  return invLotSearchText(lot, part).includes(q);
}

function invFilterRows(rows) {
  return (rows || []).filter((row) => {
    if (!invMatchesClass(row)) return false;
    if (!invMatchesStock(row)) return false;
    if (!invMatchesSearch(row)) return false;
    return true;
  });
}

function invFilterLotRows(rows) {
  return (rows || []).filter((lot) => {
    if (!invLotMatchesClass(lot)) return false;
    if (!invLotMatchesStock(lot)) return false;
    if (!invLotMatchesSearch(lot)) return false;
    return true;
  });
}

function invRenderLotQtyTable(lots, { selectedLotKey = '' } = {}) {
  if (!lots.length) return '';
  const body = lots.map((lot) => {
    const active = lot.lot_key === selectedLotKey;
    return `
      <tr class="is-clickable${active ? ' is-selected' : ''}" data-lot-key="${escapeHtml(lot.lot_key || '')}">
        <td class="mi-cell--mono">${escapeHtml(invBatchNo(lot))}</td>
        <td>${escapeHtml(invLocationLabel(lot))}</td>
        <td class="mi-cell--num">${escapeHtml(invFormatNum(lot.remaining_qty))}</td>
        <td class="mi-cell--num">${escapeHtml(invFormatNum(lot.original_qty))}</td>
        <td class="mi-cell--num">${escapeHtml(invFormatNum(lot.allocation_qty))}</td>
        <td class="mi-cell--num">${escapeHtml(invFormatNum(lot.available_qty))}</td>
        <td>${escapeHtml(invFormatDate(lot.lot_creation_date || lot.created_datetime))}</td>
        <td>${escapeHtml(invFormatDate(lot.expiry_date))}</td>
      </tr>
    `;
  }).join('');
  return `
    <div class="inv-lot-qty-wrap">
      <table class="inv-lot-qty-table">
        <thead>
          <tr>
            <th>Batch no</th>
            <th>Location</th>
            <th>Remaining</th>
            <th>Original</th>
            <th>Allocated</th>
            <th>Available</th>
            <th>Receipt</th>
            <th>Expiry</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function invRenderLotGroup(group, { selectedLotKey = '', selectedLotRef = '' } = {}) {
  const part = invPartMeta(group.lots[0]?.inventory_code);
  const uom = String(part?.uom_code || '').trim();
  const active = selectedLotRef && group.reference_no === selectedLotRef;
  const batchLabel = group.lots.length === 1 ? '1 batch' : `${group.lots.length} batches`;
  return `
    <article class="inv-lot-group${active ? ' is-active' : ''}" data-lot-ref="${escapeHtml(group.reference_no)}">
      <header class="inv-lot-group-head">
        <div>
          <p class="inv-lot-card-label">Lot reference</p>
          <h4 class="inv-lot-card-ref">${escapeHtml(group.reference_no)}</h4>
          <p class="inv-lot-group-sub">${escapeHtml(batchLabel)}${uom ? ` · ${escapeHtml(uom)}` : ''}</p>
        </div>
        <div class="inv-lot-group-totals">
          <div><span>Remaining</span><strong>${escapeHtml(invFormatNum(group.remaining_qty))}</strong></div>
          <div><span>Original</span><strong>${escapeHtml(invFormatNum(group.original_qty))}</strong></div>
          <div><span>Allocated</span><strong>${escapeHtml(invFormatNum(group.allocation_qty))}</strong></div>
          <div><span>Available</span><strong>${escapeHtml(invFormatNum(group.available_qty))}</strong></div>
        </div>
      </header>
      ${invRenderLotQtyTable(group.lots, { selectedLotKey })}
    </article>
  `;
}

function invRenderLotCards(lots, selectedLotKey = '', selectedLotRef = '') {
  if (!lots.length) {
    return '<p class="inv-lot-empty">No active lots with reference numbers for this part.</p>';
  }
  let groups = invGroupLotsByRef(lots);
  if (selectedLotRef) {
    const focused = groups.filter((group) => group.reference_no === selectedLotRef);
    if (focused.length) groups = focused;
  }
  return `<div class="inv-lot-group-list">${groups.map((group) => invRenderLotGroup(group, { selectedLotKey, selectedLotRef })).join('')}</div>`;
}

function invRenderLotSummaryFallback(summaries) {
  if (!summaries.length) return '';
  const rows = summaries.map((item) => `
    <tr>
      <td class="mi-cell--mono">${escapeHtml(String(item.reference_no || '—'))}</td>
      <td class="mi-cell--num">${escapeHtml(invFormatNum(item.remaining_qty))}</td>
      <td class="mi-cell--num">${escapeHtml(invFormatNum(item.original_qty))}</td>
      <td class="mi-cell--num">${escapeHtml(invFormatNum(item.allocation_qty))}</td>
      <td class="mi-cell--num">${escapeHtml(invFormatNum(item.available_qty))}</td>
      <td>${escapeHtml(String(item.batch_count || '—'))}</td>
    </tr>
  `).join('');
  return `
    <div class="inv-lot-qty-wrap">
      <table class="inv-lot-qty-table">
        <thead>
          <tr>
            <th>Lot ref. no.</th>
            <th>Remaining</th>
            <th>Original</th>
            <th>Allocated</th>
            <th>Available</th>
            <th>Batches</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function invDetailField(label, value, { mono, fullWidth, numeric } = {}) {
  if (!numeric && (value == null || value === '')) return '';
  if (numeric && (value == null || value === '')) value = 0;
  const text = numeric ? invFormatNum(value) : String(value);
  const cls = mono ? ' mi-detail-value--mono' : '';
  const span = fullWidth ? ' mi-detail-field--full' : '';
  return `
    <div class="mi-detail-field${span}">
      <dt>${escapeHtml(label)}</dt>
      <dd class="mi-detail-value${cls}${numeric ? ' mi-detail-value--num' : ''}">${escapeHtml(text)}</dd>
    </div>
  `;
}

function invDetailSection(title, html) {
  if (!html) return '';
  return `
    <section class="mi-detail-section">
      <h3 class="mi-detail-section-title">${escapeHtml(title)}</h3>
      <dl class="mi-detail-grid">${html}</dl>
    </section>
  `;
}

function invRenderDetail(row, { selectedLotKey = '', selectedLotRef = '' } = {}) {
  const sections = INV_DETAIL_SECTIONS.map((section) => {
    const html = section.fields
      .map(([label, key, opts]) => invDetailField(
        label,
        row[key],
        { ...(opts || {}), numeric: section.numeric },
      ))
      .join('');
    return invDetailSection(section.title, html);
  }).join('');

  const allLots = invLotsForPart(row.inventory_code);
  const lots = selectedLotRef
    ? allLots.filter((lot) => String(lot.reference_no || '').trim() === selectedLotRef)
    : allLots;
  const summaries = selectedLotRef
    ? invLotSummaries(row).filter((item) => String(item.reference_no || '').trim() === selectedLotRef)
    : invLotSummaries(row);
  if (!allLots.length && !invLotSummaries(row).length) return sections;

  const lotCount = lots.length || summaries.reduce((sum, item) => sum + Number(item.batch_count || 1), 0);
  const refCount = lots.length ? invGroupLotsByRef(lots).length : summaries.length;
  const partKey = invNormCode(row.inventory_code);
  const waiting = !lots.length && invState.partLotStatus[partKey] !== 'done';
  let lotBody = '';
  if (lots.length) {
    lotBody = invRenderLotCards(lots, selectedLotKey, selectedLotRef);
  } else if (waiting) {
    lotBody = '<p class="inv-lot-empty">Loading quantity per batch…</p>';
  } else if (summaries.some((item) => item.remaining_qty != null && item.remaining_qty !== '')) {
    lotBody = invRenderLotSummaryFallback(summaries);
  } else if (summaries.length) {
    lotBody = '<p class="inv-lot-empty">Lot references found, but no remaining / allocated quantity was returned for these batches.</p>';
  } else {
    lotBody = '<p class="inv-lot-empty">No active lots with reference numbers for this part.</p>';
  }

  const lotSection = `
      <section class="mi-detail-section inv-lot-detail-section">
        <div class="inv-lot-section-head">
          <h3 class="mi-detail-section-title">Quantity per batch</h3>
          <span class="inv-lot-section-count">${lotCount} batch${lotCount === 1 ? '' : 'es'} · ${refCount} lot ref${refCount === 1 ? '' : 's'}</span>
        </div>
        ${lotBody}
      </section>
    `;
  return `${sections}${lotSection}`;
}

function invFindRow(code) {
  const target = invNormCode(code);
  if (!target) return null;
  return invState.rows.find((row) => invNormCode(row.inventory_code) === target) || null;
}

function invOpenDetail({ title, bodyHtml }) {
  const shell = document.getElementById('inv-detail');
  const titleEl = document.getElementById('inv-detail-title');
  const bodyEl = document.getElementById('inv-detail-body');
  if (!shell || !titleEl || !bodyEl) return;
  if (shell.parentElement !== document.body) {
    document.body.appendChild(shell);
  }
  titleEl.textContent = title || 'Inventory detail';
  bodyEl.innerHTML = bodyHtml || '';
  shell.hidden = false;
  document.body.classList.add('mi-detail-open');
}

function invCloseDetail() {
  const shell = document.getElementById('inv-detail');
  if (!shell) return;
  shell.hidden = true;
  document.body.classList.remove('mi-detail-open');
  invState.selectedCode = '';
  invState.selectedLotKey = '';
  invState.selectedLotRef = '';
  document.querySelectorAll('#inv-table-body tr.is-selected, #inv-table-body .inv-lot-chip.is-selected').forEach((el) => {
    el.classList.remove('is-selected');
  });
}

let _invLotsPromise = null;

async function invEnsureLotsLoaded() {
  if (invState.lotsLoaded) return;
  await invLoadLots();
}

async function invLoadLots({ refresh = false } = {}) {
  if (!refresh && _invLotsPromise) return _invLotsPromise;
  _invLotsPromise = (async () => {
    invState.lotsLoading = true;
    if (invState.tableView === 'lot') invRender();
    try {
      const url = '/api/inventory-enquiry/lots' + (refresh ? '?refresh=1' : '');
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      invState.lotRows = data.rows || [];
      invState.lotCachedAt = data.cached_at || '';
      invState.lotsLoaded = true;
      invRender();
    } catch (err) {
      invState.lotsLoaded = false;
      invState.lotRows = [];
      _invLotsPromise = null;
      const emptyEl = document.getElementById('inv-table-empty');
      if (emptyEl && invState.tableView === 'lot') {
        emptyEl.hidden = false;
        emptyEl.textContent = `Failed to load lot breakdown: ${err.message}`;
      }
      invRender();
    } finally {
      invState.lotsLoading = false;
      const loading = document.getElementById('inv-loading');
      if (loading && invState.tableView === 'lot') loading.hidden = true;
    }
  })();
  return _invLotsPromise;
}

async function invLoadLotsForPart(code) {
  const target = String(code || '').trim();
  const key = invNormCode(target);
  if (!target || !key) return;
  if (invLotsForPart(target).length) {
    invState.partLotStatus[key] = 'done';
    return;
  }
  invState.partLotStatus[key] = 'loading';
  try {
    const params = new URLSearchParams({ codes: target });
    const res = await fetch('/api/inventory-enquiry/lots?' + params.toString());
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const keep = invState.lotRows.filter((lot) => invNormCode(lot.inventory_code) !== key);
    invState.lotRows = keep.concat(rows);
  } catch (err) {
    console.warn('Failed to load lot quantities for', target, err);
  } finally {
    invState.partLotStatus[key] = 'done';
  }
}

async function invOpenRowDetail(row, { lotKey = '', lotRef = '' } = {}) {
  if (!row) return;
  const code = String(row.inventory_code || '').trim();
  invState.selectedCode = code;
  invState.selectedLotKey = lotKey || '';
  const lot = lotKey
    ? invState.lotRows.find((item) => item.lot_key === lotKey)
    : null;
  invState.selectedLotRef = lotRef || String(lot?.reference_no || '').trim();
  const desc = String(row.main_desc || '').trim();
  const titleFor = () => (
    invState.selectedLotRef
      ? invState.selectedLotRef
      : (desc ? `${code} — ${desc}` : code)
  );

  const paint = () => {
    invOpenDetail({
      title: titleFor(),
      bodyHtml: invRenderDetail(row, {
        selectedLotKey: invState.selectedLotKey,
        selectedLotRef: invState.selectedLotRef,
      }),
    });
    document.querySelectorAll('#inv-table-body tr[data-inv-code], #inv-table-body tr[data-lot-key]').forEach((tr) => {
      const selected = lotKey
        ? tr.dataset.lotKey === lotKey
        : (!invState.selectedLotRef && tr.dataset.invCode === code && !tr.dataset.lotKey);
      tr.classList.toggle('is-selected', selected);
    });
    document.querySelectorAll('#inv-table-body .inv-lot-chip').forEach((chip) => {
      const selected = Boolean(invState.selectedLotRef)
        && chip.dataset.invCode === code
        && chip.dataset.lotRef === invState.selectedLotRef;
      chip.classList.toggle('is-selected', selected);
    });
  };

  paint();
  await invLoadLotsForPart(code);
  if (invState.selectedCode !== code) return;
  const loadedLot = invState.selectedLotKey
    ? invState.lotRows.find((item) => item.lot_key === invState.selectedLotKey)
    : null;
  if (loadedLot && !invState.selectedLotRef) {
    invState.selectedLotRef = String(loadedLot.reference_no || '').trim();
  }
  paint();
}

async function invOpenLotDetail(lot) {
  if (!lot) return;
  await invEnsureLotsLoaded();
  const row = invPartMeta(lot.inventory_code) || { inventory_code: lot.inventory_code };
  await invOpenRowDetail(row, { lotKey: lot.lot_key });
}

function invFindLot(lotKey) {
  const target = String(lotKey || '').trim();
  if (!target) return null;
  return invState.lotRows.find((lot) => lot.lot_key === target) || null;
}

function invRenderGroupRow(label) {
  return `
    <tr class="mi-group-row" aria-hidden="true">
      <td colspan="${INV_TABLE_COL_COUNT}">${escapeHtml(label)}</td>
    </tr>
  `;
}

function invQtyCell(value) {
  const n = Number(value);
  const cls = Number.isFinite(n) && n > 0 ? ' inv-enq-qty--pos' : '';
  return `<td class="mi-cell--num${cls}">${escapeHtml(invFormatNum(value))}</td>`;
}

function invRenderLotRefCell(row) {
  const code = String(row.inventory_code || '').trim();
  const summaries = invLotSummaries(row);
  if (!summaries.length) {
    return '<td class="inv-lot-ref-summary-cell"><span class="inv-lot-chip-empty">—</span></td>';
  }
  const q = invState.searchMode === 'lot_ref'
    ? String(invState.search || '').trim().toLowerCase()
    : '';
  const sorted = [...summaries].sort((a, b) => {
    if (q) {
      const aMatch = String(a.reference_no || '').toLowerCase().includes(q) ? 0 : 1;
      const bMatch = String(b.reference_no || '').toLowerCase().includes(q) ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
    }
    return String(a.reference_no || '').localeCompare(String(b.reference_no || ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
  const visible = sorted.slice(0, INV_LOT_CHIP_LIMIT);
  const extra = sorted.length - visible.length;
  const chips = visible.map((item) => {
    const ref = String(item.reference_no || '').trim();
    const match = Boolean(q) && ref.toLowerCase().includes(q);
    const selected = invState.selectedLotRef === ref && invState.selectedCode === code;
    const batches = Number(item.batch_count || 0);
    const qtyText = item.remaining_qty == null || item.remaining_qty === ''
      ? ''
      : invFormatNum(item.remaining_qty);
    const meta = batches > 1 ? `${batches} batches` : '';
    return `
      <button type="button" class="inv-lot-chip${match ? ' is-match' : ''}${selected ? ' is-selected' : ''}" data-inv-code="${escapeHtml(code)}" data-lot-ref="${escapeHtml(ref)}" title="View quantity per batch for ${escapeHtml(ref)}">
        <span class="inv-lot-chip-ref">${escapeHtml(ref || '—')}</span>
        ${qtyText ? `<span class="inv-lot-chip-qty">${escapeHtml(qtyText)}</span>` : ''}
        ${meta ? `<span class="inv-lot-chip-meta">${escapeHtml(meta)}</span>` : ''}
      </button>
    `;
  }).join('');
  const more = extra > 0
    ? `<button type="button" class="inv-lot-chip inv-lot-chip--more" data-inv-code="${escapeHtml(code)}" data-lot-ref="" title="View all lot references">+${extra}</button>`
    : '';
  return `<td class="inv-lot-ref-summary-cell"><div class="inv-lot-chip-list">${chips}${more}</div></td>`;
}

function invRenderRow(row) {
  const code = String(row.inventory_code || '').trim();
  const selected = code === invState.selectedCode && !invState.selectedLotKey && !invState.selectedLotRef;
  const desc = String(row.main_desc || '').trim();
  return `
    <tr class="is-clickable${selected ? ' is-selected' : ''}" data-inv-code="${escapeHtml(code)}" tabindex="0" role="button" aria-label="View inventory detail">
      <td class="mi-cell--mono">${escapeHtml(code || '—')}</td>
      <td class="mi-cell--desc" title="${escapeHtml(desc)}">${escapeHtml(desc || '—')}</td>
      ${invRenderLotRefCell(row)}
      <td>${escapeHtml(String(row.inventory_class_code || '—'))}</td>
      <td>${escapeHtml(String(row.inventory_category_code || '—'))}</td>
      <td>${escapeHtml(String(row.uom_code || '—'))}</td>
      ${invQtyCell(row.total_qoh_available)}
      ${invQtyCell(row.total_qty_on_hand)}
      ${invQtyCell(row.total_qty_on_order)}
      ${invQtyCell(row.total_allocated_in_sq)}
      ${invQtyCell(row.total_unallocated_qty)}
      ${invQtyCell(row.total_free_balance_qty)}
      ${invQtyCell(row.total_qty_back_order)}
    </tr>
  `;
}

function invRenderLotRow(lot) {
  const part = invPartMeta(lot.inventory_code);
  const code = String(lot.inventory_code || '').trim();
  const desc = String(part?.main_desc || '').trim();
  const selected = lot.lot_key === invState.selectedLotKey;
  const uom = String(part?.uom_code || '').trim();
  return `
    <tr class="is-clickable inv-lot-row${selected ? ' is-selected' : ''}" data-lot-key="${escapeHtml(lot.lot_key || '')}" data-inv-code="${escapeHtml(code)}" tabindex="0" role="button" aria-label="View lot detail">
      <td class="mi-cell--mono inv-lot-ref-cell">${escapeHtml(String(lot.reference_no || '—'))}</td>
      <td class="mi-cell--mono">${escapeHtml(invBatchNo(lot))}</td>
      <td class="mi-cell--mono">${escapeHtml(code || '—')}</td>
      <td class="mi-cell--desc" title="${escapeHtml(desc)}">${escapeHtml(desc || '—')}</td>
      <td class="inv-lot-loc-cell">${escapeHtml(invLocationLabel(lot))}</td>
      ${invQtyCell(lot.remaining_qty)}
      ${invQtyCell(lot.original_qty)}
      ${invQtyCell(lot.allocation_qty)}
      <td>${escapeHtml(invFormatDate(lot.lot_creation_date || lot.created_datetime))}</td>
      <td>${escapeHtml(uom || '—')}</td>
    </tr>
  `;
}

function invSortRows(rows) {
  return [...(rows || [])].sort((a, b) => {
    const ac = String(a.inventory_code || '');
    const bc = String(b.inventory_code || '');
    return ac.localeCompare(bc, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function invSortLotRows(rows) {
  return [...(rows || [])].sort((a, b) => {
    const ar = String(a.reference_no || '');
    const br = String(b.reference_no || '');
    const byRef = ar.localeCompare(br, undefined, { numeric: true, sensitivity: 'base' });
    if (byRef !== 0) return byRef;
    return String(a.inventory_code || '').localeCompare(String(b.inventory_code || ''), undefined, { numeric: true, sensitivity: 'base' });
  });
}

function invRenderBody(rows) {
  const sorted = invSortRows(rows);
  if (invState.classView !== 'all') {
    return sorted.map(invRenderRow).join('');
  }

  const parts = [];
  let lastClass = null;
  for (const row of sorted) {
    const classKey = row.class_key || 'other';
    if (classKey !== lastClass) {
      parts.push(invRenderGroupRow(INV_GROUP_LABELS[classKey] || INV_GROUP_LABELS.other));
      lastClass = classKey;
    }
    parts.push(invRenderRow(row));
  }
  return parts.join('');
}

function invRenderLotBody(rows) {
  return invSortLotRows(rows).map(invRenderLotRow).join('');
}

function invUpdateTableHead() {
  const head = document.getElementById('inv-table-head');
  if (!head) return;
  if (invState.tableView === 'lot') {
    head.innerHTML = `
      <tr>
        <th>Lot reference</th>
        <th>Batch no</th>
        <th>Part no</th>
        <th>Description</th>
        <th>Location</th>
        <th>Remaining</th>
        <th>Original</th>
        <th>Allocated</th>
        <th>Receipt</th>
        <th>UOM</th>
      </tr>
    `;
    return;
  }
  head.innerHTML = `
    <tr>
      <th>Part no</th>
      <th>Description</th>
      <th>Lot ref. no.</th>
      <th>Class</th>
      <th>Cat</th>
      <th>UOM</th>
      <th>QOH avail</th>
      <th>On hand</th>
      <th>On order</th>
      <th>Alloc (SQ)</th>
      <th>Unalloc</th>
      <th>Free bal</th>
      <th>Back order</th>
    </tr>
  `;
}

function invBindTableRowKeys(body) {
  if (!body) return;
  body.querySelectorAll('tr[data-inv-code], tr[data-lot-key]').forEach((tr) => {
    tr.addEventListener('keydown', async (e) => {
      if (e.target.closest('button')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (tr.dataset.lotKey) {
          const lot = invFindLot(tr.dataset.lotKey);
          if (lot) await invOpenLotDetail(lot);
          return;
        }
        const row = invFindRow(tr.dataset.invCode);
        if (row) await invOpenRowDetail(row);
      }
    });
  });
}

function invPassesStockForCounts(row) {
  return invMatchesStock(row);
}

function invUpdateTabCounts() {
  const countFor = (classKey) => {
    if (invState.tableView === 'lot') {
      return invFilterLotRows(invState.lotRows).filter((lot) => {
        if (classKey === 'all') return true;
        const part = invPartMeta(lot.inventory_code);
        return (part?.class_key || 'other') === classKey;
      }).length;
    }
    return invState.rows.filter((row) => {
      if (!invPassesStockForCounts(row)) return false;
      if (classKey !== 'all' && (row.class_key || 'other') !== classKey) return false;
      if (!invMatchesSearch(row)) return false;
      return true;
    }).length;
  };

  for (const key of ['all', ...INV_CLASS_ORDER]) {
    const el = document.getElementById(`inv-count-${key}`);
    if (el) el.textContent = String(countFor(key));
  }
}

function invUpdateStats() {
  const stats = document.getElementById('inv-stats');
  if (!stats) return;
  const filtered = invState.tableView === 'lot'
    ? invFilterLotRows(invState.lotRows)
    : invFilterRows(invState.rows);
  const sc = invState.stockCounts || {};
  const parts = [`${filtered.length} shown`];
  if (invState.tableView === 'lot') {
    const partsWithLots = new Set(filtered.map((lot) => lot.inventory_code)).size;
    parts.push(`${partsWithLots} part${partsWithLots === 1 ? '' : 's'}`);
  } else {
    parts.push(`on hand: ${sc.on_hand ?? '—'}`);
    parts.push(`on order: ${sc.on_order ?? '—'}`);
    parts.push(`back order: ${sc.back_order ?? '—'}`);
  }
  stats.textContent = parts.join(' · ');
}

function invUpdateSearchPlaceholder() {
  const search = document.getElementById('inv-search');
  if (!search) return;
  if (invState.tableView === 'lot') {
    search.placeholder = 'Lot ref, part no, description, location...';
    return;
  }
  search.placeholder = invState.searchMode === 'lot_ref'
    ? 'Lot reference no, e.g. AM/0454/21...'
    : 'Part no, description, class, category, brand...';
}

function invSetSearchMode(mode) {
  invState.searchMode = mode === 'lot_ref' ? 'lot_ref' : 'part';
  const searchMode = document.getElementById('inv-search-mode');
  if (searchMode) searchMode.value = invState.searchMode;
  invUpdateSearchPlaceholder();
  invCloseDetail();
  invRender();
}

function invSetTableView(view) {
  const next = view === 'lot' ? 'lot' : 'summary';
  if (invState.tableView === next) return;
  invState.tableView = next;
  invCloseDetail();
  document.querySelectorAll('[data-inv-table-view]').forEach((btn) => {
    const active = btn.getAttribute('data-inv-table-view') === next;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const table = document.querySelector('.inv-enq-table');
  table?.classList.toggle('inv-enq-table--lot', next === 'lot');
  const searchModeWrap = document.getElementById('inv-search-mode')?.closest('.mi-filter');
  if (searchModeWrap) searchModeWrap.hidden = next === 'lot';
  invUpdateSearchPlaceholder();
  invUpdateTableHead();
  if (next === 'lot' && !invState.lotsLoaded && !invState.lotsLoading) {
    invLoadLots();
    return;
  }
  invRender();
}

function invSetClassView(classView) {
  const next = classView === 'all' || INV_CLASS_ORDER.includes(classView) ? classView : 'all';
  invState.classView = next;
  invCloseDetail();
  document.querySelectorAll('[data-inv-class]').forEach((btn) => {
    const active = btn.getAttribute('data-inv-class') === next;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const title = document.getElementById('inv-section-title');
  if (title) title.textContent = INV_CLASS_LABELS[next] || 'Inventory';
  invRender();
}

function invRender() {
  const isLotView = invState.tableView === 'lot';
  const filtered = isLotView
    ? invFilterLotRows(invState.lotRows)
    : invFilterRows(invState.rows);
  const body = document.getElementById('inv-table-body');
  const emptyEl = document.getElementById('inv-table-empty');
  const countEl = document.getElementById('inv-row-count');
  const section = document.getElementById('inv-table-section');
  const globalEmpty = document.getElementById('inv-global-empty');
  const loading = document.getElementById('inv-loading');

  if (loading) {
    if (invState.tableView === 'lot') {
      loading.hidden = !invState.lotsLoading;
    }
  }
  invUpdateTableHead();

  const hasSummaryData = (invState.rows?.length || 0) > 0;
  const hasLotData = invState.lotsLoaded && (invState.lotRows?.length || 0) > 0;
  const hasData = isLotView ? (hasSummaryData && (invState.lotsLoaded ? hasLotData || invState.lotRows.length === 0 : true)) : hasSummaryData;

  if (section) section.hidden = !hasSummaryData;
  if (globalEmpty) globalEmpty.hidden = hasSummaryData;

  if (body) {
    if (isLotView) {
      body.innerHTML = invState.lotsLoaded ? invRenderLotBody(filtered) : '';
    } else {
      body.innerHTML = invRenderBody(filtered);
    }
    invBindTableRowKeys(body);
  }
  if (countEl) {
    countEl.textContent = `${filtered.length} row${filtered.length === 1 ? '' : 's'}`;
  }
  if (emptyEl) {
    const waitingForLots = isLotView && invState.lotsLoading;
    const noLotMatches = isLotView && invState.lotsLoaded && filtered.length === 0;
    const noSummaryMatches = !isLotView && filtered.length === 0 && hasSummaryData;
    emptyEl.hidden = !(waitingForLots || noLotMatches || noSummaryMatches);
    emptyEl.textContent = waitingForLots
      ? 'Loading lot breakdown...'
      : 'No rows match your filters.';
  }

  const title = document.getElementById('inv-section-title');
  if (title) {
    title.textContent = isLotView
      ? INV_TABLE_VIEW_LABELS.lot
      : (INV_CLASS_LABELS[invState.classView] || 'Inventory');
  }

  const meta = document.getElementById('inv-meta');
  if (meta) {
    if (hasSummaryData) {
      meta.hidden = false;
      const viewHint = isLotView
        ? 'Split by lot reference from ic_inventory_ost_lot'
        : (invState.classView === 'all'
          ? 'All view grouped by inventory class'
          : `Filtered to ${INV_CLASS_LABELS[invState.classView] || invState.classView}`);
      const cacheBits = [
        `cached ${invState.cachedAt || '—'}`,
        isLotView && invState.lotCachedAt ? `lots ${invState.lotCachedAt}` : '',
        `TTL ${invState.cacheTtlSec}s`,
      ].filter(Boolean).join(' · ');
      meta.textContent = `Click a lot ref. no. for quantity per batch · ${viewHint} · ${cacheBits}`;
    } else {
      meta.hidden = true;
    }
  }

  invUpdateTabCounts();
  invUpdateStats();
}

async function invLoad({ refresh = false } = {}) {
  const loading = document.getElementById('inv-loading');
  if (loading) loading.hidden = false;
  try {
    const url = '/api/inventory-enquiry' + (refresh ? '?refresh=1' : '');
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    invState.rows = data.rows || [];
    invState.stockCounts = data.stock_counts || {};
    invState.cachedAt = data.cached_at || '';
    invState.cacheTtlSec = data.cache_ttl_sec || 300;
    if (refresh) {
      invState.lotsLoaded = false;
      invState.lotRows = [];
      invState.partLotStatus = {};
      _invLotsPromise = null;
    }
    if (invState.tableView === 'lot') {
      await invLoadLots({ refresh });
      return;
    }
    if (loading) loading.hidden = true;
    invRender();
  } catch (err) {
    if (loading) loading.hidden = true;
    const globalEmpty = document.getElementById('inv-global-empty');
    if (globalEmpty) {
      globalEmpty.hidden = false;
      globalEmpty.querySelector('p').textContent = `Failed to load inventory: ${err.message}`;
    }
  }
}

function invBindEvents() {
  document.querySelectorAll('[data-inv-class]').forEach((btn) => {
    btn.addEventListener('click', () => invSetClassView(btn.getAttribute('data-inv-class')));
  });

  document.querySelectorAll('[data-inv-table-view]').forEach((btn) => {
    btn.addEventListener('click', () => invSetTableView(btn.getAttribute('data-inv-table-view')));
  });

  const stockFilter = document.getElementById('inv-stock-filter');
  stockFilter?.addEventListener('change', () => {
    invState.stockFilter = stockFilter.value || 'all';
    invCloseDetail();
    invRender();
  });

  const searchMode = document.getElementById('inv-search-mode');
  searchMode?.addEventListener('change', () => invSetSearchMode(searchMode.value));

  const search = document.getElementById('inv-search');
  let debounce = null;
  search?.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      invState.search = search.value.trim();
      invCloseDetail();
      invRender();
    }, 200);
  });

  document.getElementById('inv-refresh')?.addEventListener('click', () => invLoad({ refresh: true }));

  const shell = document.getElementById('inv-detail');
  shell?.querySelector('[data-action="close-detail"]')?.addEventListener('click', invCloseDetail);
  document.getElementById('inv-detail-close')?.addEventListener('click', invCloseDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shell && !shell.hidden) invCloseDetail();
  });

  const wrap = document.querySelector('.inv-enq-table')?.closest('.mi-table-wrap');
  wrap?.addEventListener('click', async (e) => {
    const chip = e.target.closest('button[data-lot-ref]');
    if (chip) {
      e.preventDefault();
      const row = invFindRow(chip.dataset.invCode);
      const lotRef = String(chip.dataset.lotRef || '').trim();
      if (row) await invOpenRowDetail(row, { lotRef });
      return;
    }
    const tr = e.target.closest('tr[data-lot-key], tr[data-inv-code]');
    if (!tr) return;
    if (tr.dataset.lotKey) {
      const lot = invFindLot(tr.dataset.lotKey);
      if (lot) await invOpenLotDetail(lot);
      return;
    }
    const row = invFindRow(tr.dataset.invCode);
    if (row) await invOpenRowDetail(row);
  });

  const detailBody = document.getElementById('inv-detail-body');
  detailBody?.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-lot-key]');
    if (!tr || !detailBody.contains(tr)) return;
    const lot = invFindLot(tr.dataset.lotKey);
    if (lot) await invOpenLotDetail(lot);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  invBindEvents();
  invUpdateSearchPlaceholder();
  invLoad();
});
