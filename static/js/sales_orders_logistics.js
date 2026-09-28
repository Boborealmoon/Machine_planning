// Supply Chain View - logistics view for material-in dates, PR enquiry, and POs.

(function () {
  'use strict';

  const MATERIAL_ARRIVED = 'ARRIVED';
  const PS_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
  const EM_DASH = '-';
  const PS_VIEWS = new Set(['active', 'no-wo', 'sr']);
  const PR_PO_VIEWS = new Set(['pr-enquiry', 'purchase-order']);
  const REQUEST_VIEW = 'part-requests';
  const QC_VIEW = 'qc-checklist';
  const SHIP_IN_VIEW = 'logistics-in';
  const SHIP_OUT_VIEW = 'logistics-out';
  const SHIP_VIEWS = new Set([SHIP_IN_VIEW, SHIP_OUT_VIEW]);
  const IN_SHIP_BUCKETS = ['outstanding', 'grn', 'history', 'cancelled'];
  const OUT_SHIP_BUCKETS = ['outstanding', 'history', 'cancelled'];
  const SHIP_BUCKET_LABELS = {
    outstanding: 'Outstanding',
    grn: 'GRN',
    history: 'History',
    cancelled: 'Cancelled',
  };
  const SECTION_DEFAULTS = {
    jobs: 'active',
    purchasing: 'pr-enquiry',
    'logistics-in': SHIP_IN_VIEW,
    'logistics-out': SHIP_OUT_VIEW,
  };
  const BUCKET_LABELS = { ost: 'Outstanding', new: 'New', hst: 'History' };
  const QC_BUCKET_LABELS = {
    ready_qc: 'Ready for QC',
    awaiting_grn: 'Awaiting GRN',
  };
  const PS_TABLE_HEAD = `
    <tr>
      <th class="sol-col-delay" title="Material arrival delay">Flag</th>
      <th class="sol-col-order">S/O</th>
      <th class="sol-col-ps">PS</th>
      <th class="sol-col-qty" title="Partial · SO qty / Partial qty">Qty</th>
      <th class="sol-col-stage">Stage</th>
      <th class="sol-col-part">Part</th>
      <th class="sol-col-due">Due</th>
      <th class="sol-col-need" title="Same Need date as S/O Management — saved per PP voucher">Need date</th>
      <th class="sol-col-bom">BOM</th>
      <th class="sol-col-material" title="Material in">In</th>
      <th class="sol-col-notes" title="Mtl / Part Order">Notes</th>
    </tr>`;
  const BLANK_SUPPLIER = '(Blank)';
  const PR_PO_COLUMNS = [
    { key: 'status', label: 'Status' },
    { key: 'purchase_requisition_no', label: 'PR No' },
    { key: 'pr_date', label: 'PR Date', type: 'date' },
    { key: 'item_code', label: 'Item', cls: 'sol-col-item' },
    { key: 'description', label: 'Description', cls: 'sol-desc' },
    { key: 'remarks', label: 'Remarks', cls: 'sol-desc' },
    { key: 'qty', label: 'Qty', type: 'num', cls: 'sol-col-qty' },
    { key: 'required_arrival_date', label: 'Required arrival', type: 'date' },
    { key: 'purchase_order_no', label: 'PO No' },
    { key: 'po_date', label: 'PO Date', type: 'date' },
    { key: 'estimated_arrival_date', label: 'Est. arrival', type: 'date' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'project_no', label: 'Project' },
    { key: 'sbu_code', label: 'SBU' },
    { key: 'created_by', label: 'Created by' },
    { key: 'grn_no', label: 'GRN' },
    { key: 'actual_arrival_date', label: 'Actual arrival', type: 'date' },
  ];
  const REQUEST_TABLE_HEAD = `
    <tr>
      <th class="sol-col-delay" title="Material arrival delay">Flag</th>
      <th>Part no</th>
      <th>Inventory code</th>
      <th>Description</th>
      <th class="sol-col-qty">Qty</th>
      <th class="sol-col-material">Material EDD</th>
      <th class="sol-col-notes">Remarks</th>
      <th class="sol-col-bom">BOM</th>
      <th class="sol-col-actions">Remove</th>
    </tr>`;
  const QC_COLUMNS = [
    { key: 'qc_status', label: 'Status', value: row => (String(row.grn_no || '').trim() ? 'Ready for QC' : 'Awaiting GRN') },
    { key: 'shipment_voucher_no', label: 'Shipment' },
    { key: 'po_no', label: 'PO' },
    { key: 'supplier', label: 'Supplier', value: row => String(row.supplier_name || row.supplier_code || '').trim() },
    { key: 'item', label: 'Item', value: row => String(row.item_code || row.inventory_code || row.service_code || '').trim() },
    { key: 'description', label: 'Description', value: row => String(row.line_item_description || '').trim() },
    { key: 'qty', label: 'Qty', type: 'num', cls: 'sol-col-qty' },
    { key: 'qty_received', label: 'Received', type: 'num', cls: 'sol-col-qty' },
    { key: 'uom_code', label: 'UOM' },
    { key: 'grn_no', label: 'GRN' },
    { key: 'goods_receipt_date', label: 'GRN date', type: 'date' },
    { key: 'supplier_do_no', label: 'Supplier DO' },
    {
      key: 'qi',
      label: 'QI',
      value: row => {
        const qi = String(row.qi_voucher_no || '').trim();
        const qiStatus = String(row.qi_status || '').trim().toUpperCase();
        return qi ? `${qi}${qiStatus ? ` · ${qiStatus}` : ''}` : '';
      },
    },
    { key: 'receiving_location_code', label: 'Location' },
  ];
  const SHIP_IN_COLUMNS = [
    { key: 'shipment_voucher_no', label: 'Shipment' },
    { key: 'grn_no', label: 'GRN' },
    { key: 'source_voucher_no', label: 'Source' },
    { key: 'supplier_do_no', label: 'Supplier DO' },
    { key: 'shipment_date', label: 'ESD', type: 'date' },
    { key: 'arrival_date', label: 'EAD', type: 'date' },
    { key: 'goods_receipt_date', label: 'CRD', type: 'date' },
    { key: 'priority', label: 'Priority' },
    { key: 'mode', label: 'Mode' },
    { key: 'subject', label: 'Subject' },
    { key: 'reference_no', label: 'Reference' },
    { key: 'location_name', label: 'Receiving location' },
    { key: 'party_name', label: 'Supplier' },
    { key: 'created_by_name', label: 'Created by' },
    { key: 'created_datetime', label: 'Created', type: 'date' },
    { key: 'last_updated_by_name', label: 'Updated by' },
    { key: 'last_updated_datetime', label: 'Updated', type: 'date' },
  ];
  const SHIP_OUT_COLUMNS = [
    { key: 'shipment_voucher_no', label: 'Shipment' },
    { key: 'do_no', label: 'DO' },
    { key: 'invoice_no', label: 'Invoice' },
    { key: 'source_voucher_no', label: 'Source' },
    { key: 'shipment_date', label: 'ESD', type: 'date' },
    { key: 'arrival_date', label: 'EAD', type: 'date' },
    { key: 'shipment_date_actual', label: 'Shipped', type: 'date' },
    { key: 'priority', label: 'Priority' },
    { key: 'mode', label: 'Mode' },
    { key: 'subject', label: 'Subject' },
    { key: 'reference_no', label: 'Reference' },
    { key: 'location_name', label: 'Ship to' },
    { key: 'party_name', label: 'Customer' },
    { key: 'created_by_name', label: 'Created by' },
    { key: 'created_datetime', label: 'Created', type: 'date' },
    { key: 'last_updated_by_name', label: 'Updated by' },
    { key: 'last_updated_datetime', label: 'Updated', type: 'date' },
  ];

  const state = {
    active: [],
    prPoRows: [],
    prPoCounts: { pr: {}, po: {} },
    prPoSource: '',
    prPoKey: '',
    pendingLoad: '',
    loadControllers: { sales: null, prpo: null, qc: null, ship: null },
    view: 'active',
    prPoBucket: 'ost',
    search: '',
    selectedSbu: new Set(['MFG']),
    selectedSuppliers: new Set(),
    sortKey: 'pr_date',
    sortDir: 'desc',
    materialFilter: 'all',
    ppTypes: new Set(['APS', 'NPS']),
    saveInFlight: new Set(),
    cachedAt: '',
    ppCount: 0,
    partialCount: 0,
    salesOrdersLoaded: false,
    requests: [],
    requestsLoaded: false,
    addSearch: {
      part_no: { hits: [], loading: false, open: false, activeIndex: -1, timer: 0 },
      inventory_code: { hits: [], loading: false, open: false, activeIndex: -1, timer: 0 },
    },
    qcRows: [],
    qcCounts: { ready_qc: 0, awaiting_grn: 0 },
    qcSource: '',
    qcBucket: 'ready_qc',
    qcLoaded: false,
    qcLoadedBucket: '',
    shipBucket: 'outstanding',
    shipRows: [],
    shipCounts: { in: {}, out: {} },
    shipSource: '',
    shipTotal: 0,
    shipTruncated: false,
    shipCache: {},
    shipSortKey: '',
    shipSortDir: 'asc',
    shipFilters: {},
    shipFilterDir: '',
    qcSortKey: '',
    qcSortDir: 'asc',
    qcFilters: {},
    colFilterKey: '',
    colFilterKind: '',
    assemblyJobs: new Map(),
    newOrders: [],
    unreadSoKeys: new Set(),
    rowFocus: null,
    maxNotifSoTime: 0,
    notifInFlight: null,
    notifFetchedAt: 0,
  };

  function isPrPoView(view) {
    return PR_PO_VIEWS.has(view || state.view);
  }

  function isRequestView(view) {
    return (view || state.view) === REQUEST_VIEW;
  }

  function isQcView(view) {
    return (view || state.view) === QC_VIEW;
  }

  function isShipView(view) {
    return SHIP_VIEWS.has(view || state.view);
  }

  function shipDirection(view) {
    return (view || state.view) === SHIP_OUT_VIEW ? 'out' : 'in';
  }

  function sectionForView(view) {
    const current = view || state.view;
    if (isPrPoView(current) || isRequestView(current)) return 'purchasing';
    if (isQcView(current) || current === SHIP_IN_VIEW) return 'logistics-in';
    if (current === SHIP_OUT_VIEW) return 'logistics-out';
    return 'jobs';
  }

  function isPsView(view) {
    return PS_VIEWS.has(view || state.view);
  }

  function scopeForView(view) {
    return (view || state.view) === 'purchase-order' ? 'po' : 'pr';
  }

  function formatDate(value) {
    return typeof trialFormatDate === 'function' ? trialFormatDate(value) : String(value || EM_DASH);
  }

  function formatQty(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return EM_DASH;
    return Number.isInteger(num)
      ? String(num)
      : num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function cellText(value) {
    const text = String(value == null ? '' : value).trim();
    return text || EM_DASH;
  }

  function renderDescCell(value) {
    const text = cellText(value);
    return `<td class="sol-desc" title="${escapeHtml(text)}"><span class="sol-desc-text">${escapeHtml(text)}</span></td>`;
  }

  function renderOrderCell(order) {
    const so = String(order.sales_order_no || EM_DASH);
    const customer = order.customer_name || order.customer_short_name || order.customer_code || EM_DASH;
    const soKey = so.trim().toUpperCase();
    const isNew = soKey && state.unreadSoKeys.has(soKey);
    const newPill = isNew ? '<span class="sol-new-pill">New</span>' : '';
    return `
      <td class="sol-order" title="${escapeHtml(`${so} · ${customer}`)}">
        <span class="sol-order-so-line">
          <span class="sol-order-so sol-mono">${escapeHtml(so)}</span>${newPill}
        </span>
        <span class="sol-order-customer">${escapeHtml(customer)}</span>
      </td>`;
  }

  function renderQtyCell(pp, partial, assemblyChild) {
    if (assemblyChild) {
      const bomQty = formatQty(assemblyChild.qty);
      const soQty = soQtyDisplay(pp);
      return `
        <td class="sol-col-qty sol-qty-combo" title="BOM qty ${escapeHtml(bomQty)} · parent SO qty ${escapeHtml(soQty)}">
          <span class="sol-qty-ptl">BOM</span>
          <span class="sol-qty-frac">${escapeHtml(bomQty)}</span>
        </td>`;
    }
    const ptl = String(partialNo(partial));
    const soQty = soQtyDisplay(pp);
    const pQty = partialQtyDisplay(partial, pp);
    return `
      <td class="sol-col-qty sol-qty-combo" title="Partial ${escapeHtml(ptl)} · SO qty ${escapeHtml(soQty)} · Partial qty ${escapeHtml(pQty)}">
        <span class="sol-qty-ptl">${escapeHtml(ptl)}</span>
        <span class="sol-qty-frac">${escapeHtml(soQty)}/${escapeHtml(pQty)}</span>
      </td>`;
  }

  function renderPartCell(pp, partial, assemblyChild) {
    const part = partNoForRow(pp, partial, assemblyChild) || EM_DASH;
    const desc = assemblyChild
      ? cellText(assemblyChild.description)
      : cellText(pp.description);
    return `
      <td class="sol-part" title="${escapeHtml(`${part} · ${desc}`)}">
        <span class="sol-part-no sol-mono">${escapeHtml(part)}</span>
        <span class="sol-part-desc">${escapeHtml(desc)}</span>
      </td>`;
  }

  function soQtyDisplay(pp) {
    return formatQty(pp?.so_det_qty);
  }

  function partialQtyDisplay(partial, pp) {
    const qty = partial?.partial_qty ?? pp?.pp_qty;
    return formatQty(qty);
  }

  function parseMaterialSubcon(raw) {
    const text = String(raw || '').trim();
    if (!text) return { arrived: false, date: '', legacy: '' };
    if (/^arrived$/i.test(text)) return { arrived: true, date: '', legacy: '' };
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { arrived: false, date: text, legacy: '' };
    const dmy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
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
    return { arrived: false, date: '', legacy: text };
  }

  function serializeMaterialSubcon({ arrived, date }) {
    if (arrived) return MATERIAL_ARRIVED;
    return String(date || '').trim();
  }

  function materialSubconDisplay(raw) {
    const parsed = parseMaterialSubcon(raw);
    if (parsed.arrived) return 'Arrived';
    if (parsed.date) return formatDate(parsed.date);
    if (parsed.legacy) return parsed.legacy;
    return '';
  }

  function effectiveMaterialSubcon(pp) {
    return String(pp?.assembly_material_subcon || pp?.material_subcon || '');
  }

  async function requestJson(url, { method = 'GET', body } = {}) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function postJson(url, body) {
    return requestJson(url, { method: 'PATCH', body });
  }

  function partialNo(partial) {
    const n = Number(partial?.pp_partial_no);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function getPsType(pp) {
    const raw = String(pp?.process_sheet_no || pp?.pp_voucher_no || '').split('::')[0];
    if (/\[sr\]/i.test(raw)) return 'SR';
    const match = raw.toUpperCase().match(/^([A-Z]+)/);
    return match ? match[1] : null;
  }

  function psBaseKey(value) {
    return String(value || '').split('::')[0].trim().toUpperCase();
  }

  function stripSrTag(value) {
    return String(value == null ? '' : value).replace(/\[sr\]/gi, '');
  }

  function textMatchesQuery(value, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    const raw = String(value == null ? '' : value).toLowerCase();
    if (raw.includes(q)) return true;
    const strippedQ = stripSrTag(q).replace(/\s+/g, '');
    if (!strippedQ) return false;
    const strippedVal = stripSrTag(raw).toLowerCase();
    if (strippedVal.includes(strippedQ)) return true;
    return strippedVal.replace(/\s+/g, '').includes(strippedQ);
  }

  function isComponentChildPs(value) {
    const raw = psBaseKey(value);
    return (raw.match(/-/g) || []).length >= 2 && /-\d+$/.test(raw);
  }

  function parentPsIdFromChild(value) {
    const raw = psBaseKey(value);
    return isComponentChildPs(raw) ? raw.replace(/-\d+$/, '') : '';
  }

  function psIdOf(leaf) {
    return psBaseKey(leaf?.pp?.process_sheet_no || leaf?.pp?.pp_voucher_no);
  }

  function assemblyForPp(pp) {
    if (!state.assemblyJobs.size) return null;
    for (const key of [pp?.process_sheet_no, pp?.pp_voucher_no]) {
      const id = psBaseKey(key);
      if (!id) continue;
      if (state.assemblyJobs.has(id)) return state.assemblyJobs.get(id);
      const parent = parentPsIdFromChild(id);
      if (parent && state.assemblyJobs.has(parent)) return state.assemblyJobs.get(parent);
    }
    const part = partKeyOf(pp?.inventory_code);
    if (part && state.assemblyJobs.has(`part:${part}`)) return state.assemblyJobs.get(`part:${part}`);
    return null;
  }

  function assemblyLineItems(pp) {
    const job = assemblyForPp(pp);
    if (!job) return [];
    return (job.children || []).filter(child => String(child.part_no || '').trim());
  }

  function partKeyOf(value) {
    return String(value || '').trim().toUpperCase();
  }

  function bomChildPp(parentPp, child) {
    const childPs = String(child?.process_sheet_no || '').trim();
    if (!childPs) return parentPp;
    return {
      ...parentPp,
      pp_voucher_no: childPs,
      process_sheet_no: childPs,
      inventory_code: child.part_no || parentPp.inventory_code,
      description: child.description || parentPp.description,
      pp_qty: child.qty == null ? parentPp.pp_qty : child.qty,
      bom_code: child.selected_bom_code || child.resolved_bom_code || '',
      material_subcon: child.material_subcon || '',
      mtl_part_order: child.mtl_part_order || '',
      material_need_date: child.material_need_date || '',
      material_need_date_history_count: Number(child.material_need_date_history_count || 0),
      material_in_date_history_count: Number(child.material_in_date_history_count || 0),
      material_delay: Boolean(child.material_delay),
    };
  }

  function asBomChildRow(parentLeaf, child, index, count) {
    return {
      ...parentLeaf,
      pp: bomChildPp(parentLeaf.pp, child),
      partial: {
        ...(parentLeaf.partial || {}),
        inventory_code: child.part_no || parentLeaf.partial?.inventory_code,
        partial_qty: child.qty == null ? parentLeaf.partial?.partial_qty : child.qty,
      },
      assemblyChild: child,
      assemblyChildIndex: index,
      assemblyChildCount: count,
    };
  }

  function asNestedChildRow(parentLeaf, childLeaf, child, index, count) {
    const part = String(
      child?.part_no || childLeaf.partial?.inventory_code || childLeaf.pp?.inventory_code || ''
    ).trim();
    const assemblyChild = child && String(child.process_sheet_no || '').trim()
      ? child
      : {
        part_no: part,
        description: childLeaf.pp?.description || '',
        qty: childLeaf.partial?.partial_qty ?? childLeaf.pp?.pp_qty,
        process_sheet_no: psIdOf(childLeaf) || String(childLeaf.pp?.process_sheet_no || '').trim(),
        selected_bom_code: childLeaf.pp?.bom_code || '',
        is_subassembly: true,
        material_subcon: childLeaf.pp?.material_subcon || '',
        mtl_part_order: childLeaf.pp?.mtl_part_order || '',
        material_need_date: childLeaf.pp?.material_need_date || '',
        material_delay: Boolean(childLeaf.pp?.material_delay),
      };
    return {
      ...childLeaf,
      pp: bomChildPp(childLeaf.pp, assemblyChild),
      partial: {
        ...(childLeaf.partial || {}),
        inventory_code: assemblyChild.part_no || childLeaf.partial?.inventory_code,
        partial_qty: assemblyChild.qty == null ? childLeaf.partial?.partial_qty : assemblyChild.qty,
      },
      assemblyChild,
      assemblyChildIndex: index,
      assemblyChildCount: count,
    };
  }

  function explodeLeaf(leaf) {
    const items = assemblyLineItems(leaf.pp);
    if (!items.length) return [leaf];
    const children = items.map((child, index) => asBomChildRow(leaf, child, index, items.length));
    if (getPsType(leaf.pp) === 'SR') return children;
    return [{ ...leaf, assemblyChildCount: items.length }, ...children];
  }

  function nestAndExplodeLeaves(leaves) {
    const parentKeys = new Set();
    leaves.forEach(leaf => {
      const ps = psIdOf(leaf);
      if (ps && !isComponentChildPs(ps)) parentKeys.add(ps);
    });

    const nestedByParent = new Map();
    const roots = [];
    const orphans = [];
    leaves.forEach(leaf => {
      const ps = psIdOf(leaf);
      if (isComponentChildPs(ps)) {
        const parent = parentPsIdFromChild(ps);
        if (parent && parentKeys.has(parent)) {
          const list = nestedByParent.get(parent) || [];
          list.push(leaf);
          nestedByParent.set(parent, list);
          return;
        }
        orphans.push(leaf);
        return;
      }
      roots.push(leaf);
    });

    const out = [];
    roots.forEach(leaf => {
      const ps = psIdOf(leaf);
      const nested = (nestedByParent.get(ps) || []).slice().sort((a, b) => {
        const psCmp = psIdOf(a).localeCompare(psIdOf(b), undefined, { numeric: true });
        if (psCmp) return psCmp;
        return partialNo(a.partial) - partialNo(b.partial);
      });
      const items = assemblyLineItems(leaf.pp);
      const nestedByPs = new Map();
      const nestedByPart = new Map();
      nested.forEach(childLeaf => {
        const ps = psIdOf(childLeaf);
        if (ps && !nestedByPs.has(ps)) nestedByPs.set(ps, childLeaf);
        const part = partKeyOf(childLeaf.partial?.inventory_code || childLeaf.pp?.inventory_code);
        if (part && !nestedByPart.has(part)) nestedByPart.set(part, childLeaf);
      });
      const usedNested = new Set();
      const childRows = items.map((child, index) => {
        const childPs = psBaseKey(child.process_sheet_no);
        const nestedLeaf = (childPs && nestedByPs.get(childPs))
          || nestedByPart.get(partKeyOf(child.part_no))
          || null;
        if (nestedLeaf) usedNested.add(nestedLeaf);
        if (nestedLeaf) return asNestedChildRow(leaf, nestedLeaf, child, index, 0);
        return asBomChildRow(leaf, child, index, 0);
      });
      nested.forEach(childLeaf => {
        if (usedNested.has(childLeaf)) return;
        childRows.push(asNestedChildRow(leaf, childLeaf, null, childRows.length, 0));
      });
      if (!childRows.length) {
        explodeLeaf(leaf).forEach(row => out.push(row));
        return;
      }
      const keepParent = getPsType(leaf.pp) !== 'SR';
      childRows.forEach((row, index) => {
        row.assemblyChildIndex = index;
        row.assemblyChildCount = childRows.length;
      });
      if (keepParent) out.push({ ...leaf, assemblyChildCount: childRows.length });
      out.push(...childRows);
    });
    orphans.forEach(leaf => out.push(leaf));
    return out;
  }

  function patchAssemblyChildNotes(ppNo, patch) {
    const key = psBaseKey(ppNo);
    if (!key || !state.assemblyJobs.size) return;
    state.assemblyJobs.forEach(job => {
      (job.children || []).forEach(child => {
        if (psBaseKey(child.process_sheet_no) !== key) return;
        Object.assign(child, patch);
      });
    });
  }

  function assemblySearchBits(pp, assemblyChild) {
    const job = assemblyForPp(pp);
    if (!job) return [];
    if (assemblyChild) {
      return [
        job.ps_id,
        job.part_no,
        assemblyChild.part_no,
        assemblyChild.description,
        assemblyChild.process_sheet_no,
      ];
    }
    const bits = [job.ps_id, job.part_no];
    (job.children || []).forEach(child => {
      bits.push(child.part_no, child.description, child.process_sheet_no);
    });
    return bits;
  }

  function psDisplayForPartial(pp, partial) {
    const base = String(pp?.process_sheet_no || pp?.pp_voucher_no || EM_DASH).split('::')[0].trim();
    const partialCount = Math.max(1, (pp?.partials || []).length);
    const pno = partialNo(partial);
    return partialCount > 1 ? `${base} - p${pno}` : base;
  }

  function typeTagHtml(psType) {
    if (!psType) return '';
    const label = psType === 'SR' ? '[SR]' : psType;
    return `<span class="so-type-tag so-type-tag--${String(psType).toLowerCase()}">${escapeHtml(label)}</span>`;
  }

  function partialStage(partial) {
    return {
      desc: String(partial?.current_stage_desc || '').trim(),
      status: String(partial?.current_stage_status || '').trim(),
      mode: String(partial?.erp_stage_mode || 'unassigned').trim() || 'unassigned',
      lastDesc: String(partial?.erp_last_stage_desc || '').trim(),
      lastStatus: String(partial?.erp_last_stage_status || '').trim(),
      woCount: Number(partial?.erp_wo_stage_count) || 0,
    };
  }

  function executionLabel(code) {
    const c = String(code || '').trim().toUpperCase();
    if (c === 'I') return 'In Process';
    if (c === 'R') return 'Ready to Start';
    if (c === 'P') return 'Pending SI';
    return c || EM_DASH;
  }

  function statusPill(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!c) return '';
    let cls = 'mi-status-pill';
    if (c === 'I') cls += ' mi-status-pill--o';
    else if (c === 'R') cls += ' mi-status-pill--r';
    else if (c === 'P') cls += ' mi-status-pill--h';
    return `<span class="${cls}" title="${escapeHtml(executionLabel(c))}">${escapeHtml(c)}</span>`;
  }

  function prPoStatusPill(status) {
    const text = String(status || '').trim();
    if (!text) return `<span class="sol-dash">${EM_DASH}</span>`;
    let cls = 'sol-status-pill';
    const lower = text.toLowerCase();
    if (lower.includes('outstanding') || lower.includes('pending')) cls += ' sol-status-pill--ost';
    else if (lower.includes('approval') || lower.includes('new')) cls += ' sol-status-pill--new';
    else if (lower.includes('complete') || lower.includes('grn')) cls += ' sol-status-pill--ok';
    else if (lower.includes('cancel') || lower.includes('history')) cls += ' sol-status-pill--hst';
    return `<span class="${cls}">${escapeHtml(text)}</span>`;
  }

  function ppPendingWoQty(pp) {
    const pending = Number(pp?.erp_pending_wo_qty);
    if (Number.isFinite(pending) && pending > 0.0001) return pending;
    const ppQty = Number(pp?.pp_qty);
    const issued = Number(pp?.erp_wo_issued_qty);
    if (Number.isFinite(ppQty) && Number.isFinite(issued) && ppQty - issued > 0.0001) {
      return ppQty - issued;
    }
    return 0;
  }

  function ppIsNoWo(pp) {
    const soNo = String(pp?.source_voucher_no || '').trim();
    if (!soNo.startsWith('SO/')) return false;
    if (typeof pp?.erp_pending_no_wo === 'boolean') return pp.erp_pending_no_wo;
    if (ppPendingWoQty(pp) > 0.0001) return true;
    if (typeof pp?.erp_has_wo === 'boolean') return !pp.erp_has_wo;
    const partials = Array.isArray(pp?.partials) && pp.partials.length ? pp.partials : [pp];
    return !partials.some(p => (Number(p?.erp_wo_stage_count) || 0) > 0);
  }

  function leafRows(order) {
    const leaves = [];
    (order.pp_vouchers || []).forEach(pp => {
      const partials = pp.partials || [];
      if (!partials.length) {
        const byPartial = pp.queued_machines_by_partial || {};
        leaves.push({
          order,
          pp,
          partial: {
            pp_partial_no: 1,
            inventory_code: pp.inventory_code,
            partial_qty: pp.pp_qty,
            current_stage_desc: pp.current_stage_desc,
            current_stage_status: pp.current_stage_status,
            erp_stage_mode: pp.erp_stage_mode,
            erp_wo_stage_count: pp.erp_wo_stage_count,
            erp_last_stage_desc: pp.erp_last_stage_desc,
            erp_last_stage_status: pp.erp_last_stage_status,
            queued_machines: Array.isArray(byPartial['1']) ? byPartial['1'] : (pp.queued_machines || []),
          },
        });
        return;
      }
      partials.forEach(partial => leaves.push({ order, pp, partial }));
    });
    return leaves;
  }

  function searchText(order, pp, partial, assemblyChild) {
    const parts = [
      order.sales_order_no,
      order.customer_name,
      order.customer_short_name,
      order.customer_po_no,
      pp.pp_voucher_no,
      pp.process_sheet_no,
      pp.inventory_code,
      pp.description,
      partial?.inventory_code,
      pp.material_subcon,
      pp.assembly_material_subcon,
      pp.mtl_part_order,
      pp.material_need_date,
      formatDate(pp.material_need_date),
      materialSubconDisplay(effectiveMaterialSubcon(pp)),
      ...assemblySearchBits(pp, assemblyChild),
    ];
    return parts.map(v => String(v == null ? '' : v)).join(' ');
  }

  function normalizeItemText(value) {
    return String(value == null ? '' : value).toLowerCase().replace(/[+*]/g, '');
  }

  function prPoSearchText(row) {
    const parts = [
      row.status,
      row.purchase_requisition_no,
      row.item_code,
      row.item_description,
      row.line_item_description,
      row.purchase_order_no,
      row.supplier_code,
      row.supplier_name,
      row.project_no,
      row.sbu_code,
      row.created_by,
      row.grn_no,
      row.shipment_voucher_no,
      row.remarks,
      row.internal_remarks,
      row.sales_order_no,
      normalizeItemText(row.item_code),
    ];
    return parts.map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
  }

  function passesPrefixFilter(pp) {
    if (!state.ppTypes.size || state.ppTypes.size === PS_TYPES.length) return true;
    const psType = getPsType(pp);
    if (!psType) return true;
    return state.ppTypes.has(psType);
  }

  function passesMaterialFilter(pp) {
    const parsed = parseMaterialSubcon(effectiveMaterialSubcon(pp));
    switch (state.materialFilter) {
      case 'empty':
        return !parsed.arrived && !parsed.date && !parsed.legacy;
      case 'expected':
        return Boolean(parsed.date) && !parsed.arrived;
      case 'arrived':
        return parsed.arrived;
      default:
        return true;
    }
  }

  function passesFilters(leaf) {
    const { order, pp, partial, assemblyChild } = leaf;
    if (state.view === 'no-wo' && !ppIsNoWo(pp)) return false;
    if (state.view === 'sr') {
      if (getPsType(pp) !== 'SR') return false;
    } else if (!passesPrefixFilter(pp)) {
      return false;
    }
    if (!passesMaterialFilter(pp)) return false;
    const q = String(state.search || '').trim();
    if (q && !textMatchesQuery(searchText(order, pp, partial, assemblyChild), q)) return false;
    return true;
  }

  function visibleLeaves() {
    const rows = [];
    const leaves = [];
    state.active.forEach(order => {
      leafRows(order).forEach(leaf => leaves.push(leaf));
    });
    nestAndExplodeLeaves(leaves).forEach(expanded => {
      if (passesFilters(expanded)) rows.push(expanded);
    });
    rows.sort((a, b) => {
      const soCmp = String(a.order.sales_order_no || '').localeCompare(String(b.order.sales_order_no || ''));
      if (soCmp) return soCmp;
      const psCmp = psDisplayForPartial(a.pp, a.partial).localeCompare(psDisplayForPartial(b.pp, b.partial));
      if (psCmp) return psCmp;
      const childA = Number.isInteger(a.assemblyChildIndex) ? a.assemblyChildIndex : -1;
      const childB = Number.isInteger(b.assemblyChildIndex) ? b.assemblyChildIndex : -1;
      if (childA !== childB) return childA - childB;
      return partialNo(a.partial) - partialNo(b.partial);
    });
    return rows;
  }

  function supplierKey(row) {
    return String(row.supplier_name || row.supplier_code || '').trim() || BLANK_SUPPLIER;
  }

  function uniqueTrimmed(values) {
    const seen = new Set();
    const out = [];
    values.forEach(value => {
      const text = String(value == null ? '' : value).trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      out.push(text);
    });
    return out;
  }

  function passesSbuFilter(row) {
    if (!state.selectedSbu.size) return true;
    return state.selectedSbu.has(String(row.sbu_code || '').trim());
  }

  function passesSupplierFilter(row) {
    if (!state.selectedSuppliers.size) return true;
    return state.selectedSuppliers.has(supplierKey(row));
  }

  function passesPrPoTextSearch(row) {
    const q = String(state.search || '').trim();
    if (!q) return true;
    const blob = prPoSearchText(row);
    if (textMatchesQuery(blob, q)) return true;
    const hay = normalizeItemText(blob);
    return q.split(/\s+/).filter(Boolean).every(token => hay.includes(normalizeItemText(token)));
  }

  function dateSortValue(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const ts = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'));
    return Number.isFinite(ts) ? ts : null;
  }

  function prPoSortValue(row, key) {
    if (key === 'description') {
      return String(row.line_item_description || row.item_description || '').trim().toLowerCase();
    }
    if (key === 'supplier') return supplierKey(row).toLowerCase();
    if (key === 'qty') {
      const num = Number(row.qty);
      return Number.isFinite(num) ? num : null;
    }
    const col = PR_PO_COLUMNS.find(c => c.key === key);
    if (col && col.type === 'date') return dateSortValue(row[key]);
    return String(row[key] == null ? '' : row[key]).trim().toLowerCase();
  }

  function compareSortValues(a, b, dir) {
    const aEmpty = a == null || a === '';
    const bEmpty = b == null || b === '';
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }) * dir;
  }

  function sortPrPoRows(rows) {
    const key = state.sortKey || 'pr_date';
    const dir = state.sortDir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => compareSortValues(prPoSortValue(a, key), prPoSortValue(b, key), dir));
  }

  function visiblePrPoRows() {
    const rows = state.prPoRows.filter(row => {
      if (!passesSbuFilter(row)) return false;
      if (!passesSupplierFilter(row)) return false;
      if (!passesPrPoTextSearch(row)) return false;
      return true;
    });
    return sortPrPoRows(rows);
  }

  function qcSearchText(row) {
    const parts = [
      row.shipment_voucher_no,
      row.po_no,
      row.supplier_code,
      row.supplier_name,
      row.item_code,
      row.inventory_code,
      row.service_code,
      row.line_item_description,
      row.grn_no,
      row.supplier_do_no,
      row.qi_voucher_no,
      row.receiving_location_code,
    ];
    return parts.map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
  }

  function visibleQcRows() {
    const q = String(state.search || '').trim().toLowerCase();
    let rows = q ? state.qcRows.filter(row => qcSearchText(row).includes(q)) : state.qcRows.slice();
    rows = rows.filter(row => passesColumnFilters(row, QC_COLUMNS, state.qcFilters));
    return sortRowsByColumn(rows, QC_COLUMNS, state.qcSortKey, state.qcSortDir);
  }

  function findPp(ppVoucherNo) {
    const target = String(ppVoucherNo || '').trim();
    for (const order of state.active) {
      const pp = (order.pp_vouchers || []).find(row => String(row.pp_voucher_no || '').trim() === target);
      if (pp) return { order, pp };
    }
    return { order: null, pp: null };
  }

  function findRequest(requestId) {
    const id = Number(requestId);
    if (!Number.isFinite(id) || id <= 0) return null;
    return state.requests.find(row => Number(row.request_id) === id) || null;
  }

  function requestSearchText(row) {
    const parts = [
      row.part_no,
      row.inventory_code,
      row.description,
      row.qty,
      row.remarks,
      row.material_subcon,
      materialSubconDisplay(row.material_subcon),
    ];
    return parts.map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
  }

  function passesRequestFilters(row) {
    if (!passesMaterialFilter(row)) return false;
    const q = String(state.search || '').trim().toLowerCase();
    if (q && !requestSearchText(row).includes(q)) return false;
    return true;
  }

  function visibleRequestRows() {
    return state.requests.filter(passesRequestFilters);
  }

  function requestIdOf(el) {
    const raw = el?.dataset?.requestId || el?.closest?.('[data-request-id]')?.dataset?.requestId;
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : 0;
  }

  function partNoForRow(pp, partial, assemblyChild) {
    const childPart = String(assemblyChild?.part_no || '').trim();
    if (childPart) return childPart;
    return String(partial?.inventory_code || pp?.inventory_code || '').trim();
  }

  function renderStageCell(pp, partial) {
    const stage = partialStage(partial);
    let stageHtml = '';
    if (stage.desc || stage.status) {
      const descHtml = stage.desc
        ? `<span class="so-stage-desc" title="${escapeHtml(stage.desc)}">${escapeHtml(stage.desc)}</span>`
        : '';
      const statusHtml = stage.status ? statusPill(stage.status) : '';
      stageHtml = `${descHtml}${statusHtml}`;
    } else if (stage.mode === 'unassigned') {
      stageHtml = '<span class="so-stage-mode so-stage-mode--unassigned" title="No work order raised yet">No WO</span>';
    } else if (stage.mode === 'completed') {
      stageHtml = '<span class="so-stage-mode so-stage-mode--completed" title="All stages complete">All complete</span>';
    } else {
      stageHtml = `<span class="sol-dash">${EM_DASH}</span>`;
    }
    const pendingWo = ppPendingWoQty(pp);
    const pendingHtml = pendingWo > 0.0001
      ? `<span class="so-stage-mode so-stage-mode--pending-wo" title="${escapeHtml(`${pendingWo} qty awaiting WO`)}">${escapeHtml(String(pendingWo))} WO</span>`
      : '';
    return `<td class="sol-stage so-stage-cell"><div class="so-stage-stack">${stageHtml}${pendingHtml}</div></td>`;
  }

  function renderMaterialsCell(pp, partial, assemblyChild) {
    const partNo = partNoForRow(pp, partial, assemblyChild);
    if (!partNo) return `<td class="sol-col-bom">${EM_DASH}</td>`;
    const bomCode = assemblyChild
      ? String(assemblyChild.selected_bom_code || assemblyChild.resolved_bom_code || '').trim()
      : String(pp?.bom_code || '').trim();
    const processSheetNo = String(assemblyChild?.process_sheet_no || '').trim()
      || psDisplayForPartial(pp, partial);
    const title = `BOM materials and inventory for ${partNo}`;
    return `
      <td class="sol-col-bom">
        <button type="button" class="sol-materials-btn"
          data-action="open-material"
          data-part-no="${escapeHtml(partNo)}"
          data-bom-code="${escapeHtml(bomCode)}"
          data-process-sheet="${escapeHtml(processSheetNo)}"
          title="${escapeHtml(title)}">BOM</button>
      </td>
    `;
  }

  function applyMaterialCellState(cell, parsed) {
    if (!cell) return;
    cell.classList.toggle('has-material-date', Boolean(parsed.date) && !parsed.arrived);
    cell.classList.toggle('has-material-arrived', Boolean(parsed.arrived));
    const dateInput = cell.querySelector('.so-material-subcon-date');
    if (dateInput) {
      dateInput.disabled = Boolean(parsed.arrived);
      dateInput.classList.toggle('is-hidden', Boolean(parsed.arrived));
    }
  }

  function renderMaterialCell(pp) {
    const ppNo = String(pp.pp_voucher_no || '').trim();
    const raw = effectiveMaterialSubcon(pp);
    const parsed = parseMaterialSubcon(raw);
    const arrivedCls = parsed.arrived ? ' is-active' : '';
    const dateHiddenCls = parsed.arrived ? ' is-hidden' : '';
    const cellStateCls = parsed.arrived ? ' has-material-arrived' : (parsed.date ? ' has-material-date' : '');
    const legacyHtml = parsed.legacy
      ? `<span class="so-material-subcon-legacy" title="Previous note">${escapeHtml(parsed.legacy)}</span>`
      : '';
    return `
      <td class="so-material-subcon-cell${cellStateCls}" data-pp-voucher-no="${escapeHtml(ppNo)}" data-last-saved="${escapeHtml(raw)}">
        <div class="so-material-subcon-controls">
          <div class="so-material-subcon-arrived-row">
            <button type="button"
              class="so-material-subcon-arrived${arrivedCls}"
              data-action="toggle-subcon-arrived"
              aria-pressed="${parsed.arrived ? 'true' : 'false'}"
              title="${parsed.arrived ? 'Material arrived - click to clear' : 'Mark material as arrived'}">
              <span class="so-material-subcon-arrived-dot" aria-hidden="true"></span>
              Arrived
            </button>
            ${renderDateHistoryButton(pp, 'material_in_date')}
          </div>
          <input type="date"
            class="so-material-subcon-date${dateHiddenCls}"
            value="${escapeHtml(parsed.arrived ? '' : parsed.date)}"
            ${parsed.arrived ? 'disabled' : ''}
            aria-label="Material expected / arrival date">
          ${legacyHtml}
        </div>
        <span class="so-editable-status" aria-live="polite"></span>
      </td>
    `;
  }

  function isoDateValue(value) {
    const text = String(value == null ? '' : value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    return parseMaterialSubcon(text).date || '';
  }

  function dateHistoryCount(pp, field) {
    const key = field === 'material_in_date'
      ? 'material_in_date_history_count'
      : 'material_need_date_history_count';
    return Math.max(0, Number(pp?.[key]) || 0);
  }

  function dateHistoryLabel(field) {
    return field === 'material_in_date' ? 'in date' : 'need date';
  }

  function renderDateHistoryButton(pp, field) {
    const ppNo = String(pp.pp_voucher_no || '').trim();
    const count = dateHistoryCount(pp, field);
    const has = count > 0;
    const label = dateHistoryLabel(field);
    const title = has
      ? `View ${count} ${label} change${count === 1 ? '' : 's'}`
      : `No ${label} change history`;
    return `
      <button type="button"
        class="sol-date-history-btn${has ? ' has-history' : ''}"
        data-action="open-date-history"
        data-field="${escapeHtml(field)}"
        data-pp-voucher-no="${escapeHtml(ppNo)}"
        ${has ? '' : 'disabled'}
        title="${escapeHtml(title)}"
        aria-label="${escapeHtml(title)}">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="8" cy="8" r="6.2"/>
          <path d="M8 4.5V8l2.2 1.6"/>
        </svg>
      </button>
    `;
  }

  function syncDateHistoryButtons(ppNo, field, count) {
    const body = document.getElementById('sol-table-body');
    if (!body || !ppNo || !field) return;
    const n = Math.max(0, Number(count) || 0);
    const has = n > 0;
    const label = dateHistoryLabel(field);
    const title = has
      ? `View ${n} ${label} change${n === 1 ? '' : 's'}`
      : `No ${label} change history`;
    body.querySelectorAll('.sol-date-history-btn').forEach(btn => {
      if (String(btn.dataset.ppVoucherNo || '') !== ppNo) return;
      if (String(btn.dataset.field || '') !== field) return;
      btn.disabled = !has;
      btn.classList.toggle('has-history', has);
      btn.title = title;
      btn.setAttribute('aria-label', title);
    });
  }

  function applyHistoryCountsFromSave(ppNo, data) {
    if (!ppNo || !data) return;
    const found = findPp(ppNo);
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(data, 'material_need_date_history_count')) {
      const n = Math.max(0, Number(data.material_need_date_history_count) || 0);
      patch.material_need_date_history_count = n;
      if (found.pp) found.pp.material_need_date_history_count = n;
      syncDateHistoryButtons(ppNo, 'material_need_date', n);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'material_in_date_history_count')) {
      const n = Math.max(0, Number(data.material_in_date_history_count) || 0);
      patch.material_in_date_history_count = n;
      if (found.pp) found.pp.material_in_date_history_count = n;
      syncDateHistoryButtons(ppNo, 'material_in_date', n);
    }
    if (Object.keys(patch).length) patchAssemblyChildNotes(ppNo, patch);
  }

  function formatHistoryWhen(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const iso = text.replace(' ', 'T');
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return text;
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }

  function formatHistoryDateValue(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return '(empty)';
    const iso = isoDateValue(text);
    if (iso) return formatDate(iso) || iso;
    return text;
  }

  function closeDateHistoryModal() {
    const modal = document.getElementById('sol-date-history-modal');
    if (modal) modal.hidden = true;
  }

  function renderDateHistoryList(rows) {
    const list = document.getElementById('sol-date-history-list');
    const empty = document.getElementById('sol-date-history-empty');
    if (!list) return;
    const items = Array.isArray(rows) ? rows : [];
    if (!items.length) {
      list.innerHTML = '';
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'No changes recorded yet.';
      }
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = items.map((item) => {
      const when = formatHistoryWhen(item.changed_at);
      const oldValue = formatHistoryDateValue(item.old_value);
      const newValue = formatHistoryDateValue(item.new_value);
      return `
        <li class="sol-date-history-item">
          <p class="sol-date-history-when">${escapeHtml(when || 'Unknown time')}</p>
          <p class="sol-date-history-change">
            <span class="sol-date-history-old">${escapeHtml(oldValue)}</span>
            <span class="sol-date-history-arrow" aria-hidden="true">\u2192</span>
            <span class="sol-date-history-new">${escapeHtml(newValue)}</span>
          </p>
        </li>
      `;
    }).join('');
  }

  async function openDateHistoryModal(ppNo, field) {
    const modal = document.getElementById('sol-date-history-modal');
    if (!modal || !ppNo || !field) return;
    const label = field === 'material_in_date' ? 'In date' : 'Need date';
    modal.hidden = false;
    const title = document.getElementById('sol-date-history-title');
    const sub = document.getElementById('sol-date-history-sub');
    const loading = document.getElementById('sol-date-history-loading');
    const empty = document.getElementById('sol-date-history-empty');
    const status = document.getElementById('sol-date-history-status');
    if (title) title.textContent = `${label} history`;
    if (sub) sub.textContent = ppNo;
    if (status) {
      status.hidden = true;
      status.textContent = '';
    }
    if (loading) loading.hidden = false;
    if (empty) empty.hidden = true;
    renderDateHistoryList([]);
    try {
      const qs = new URLSearchParams({ pp_voucher_no: ppNo, field });
      const data = await requestJson(`/api/sales-orders/date-history?${qs.toString()}`);
      renderDateHistoryList(data.rows || []);
    } catch (err) {
      if (status) {
        status.hidden = false;
        status.textContent = err.message || 'Could not load history';
      }
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'Could not load history.';
      }
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function renderNeedDateCell(pp) {
    const ppNo = String(pp.pp_voucher_no || '').trim();
    const value = isoDateValue(pp.material_need_date);
    const cellStateCls = value ? ' has-need-date' : '';
    return `
      <td class="sol-need-date-cell${cellStateCls}">
        <div class="sol-date-with-history">
          <input type="date"
            class="sol-need-date-input"
            data-pp-voucher-no="${escapeHtml(ppNo)}"
            data-field="material_need_date"
            data-last-saved="${escapeHtml(value)}"
            value="${escapeHtml(value)}"
            aria-label="Need date"
            title="Same Need date as S/O Management — saved per PP voucher">
          ${renderDateHistoryButton(pp, 'material_need_date')}
        </div>
        <span class="so-editable-status" aria-live="polite"></span>
      </td>
    `;
  }

  function renderNotesCell(pp) {
    const ppNo = String(pp.pp_voucher_no || '').trim();
    const value = String(pp.mtl_part_order || '');
    return `
      <td class="so-editable-cell sol-col-notes">
        <textarea
          class="so-editable-input"
          rows="1"
          data-pp-voucher-no="${escapeHtml(ppNo)}"
          data-field="mtl_part_order"
          data-last-saved="${escapeHtml(value)}"
          aria-label="Mtl / Part Order"
          placeholder="Notes..."
        >${escapeHtml(value)}</textarea>
        <span class="so-editable-status" aria-live="polite"></span>
      </td>
    `;
  }

  function renderDelayCell(pp) {
    const ppNo = String(pp.pp_voucher_no || '').trim();
    const flagged = Boolean(pp.material_delay);
    return `
      <td class="sol-delay-cell">
        <label class="sol-delay-flag${flagged ? ' is-active' : ''}"
          title="${flagged ? 'Material delay flagged — click to clear' : 'Flag material arrival delay'}"
          aria-pressed="${flagged ? 'true' : 'false'}"
          aria-label="${flagged ? 'Material delay flagged' : 'Flag material arrival delay'}">
          <input type="checkbox"
            class="sol-delay-input"
            data-pp-voucher-no="${escapeHtml(ppNo)}"
            ${flagged ? 'checked' : ''}
            tabindex="-1"
            aria-hidden="true">
          <span class="sol-delay-mark" aria-hidden="true">⚑</span>
        </label>
        <span class="sol-delay-status" aria-live="polite"></span>
      </td>
    `;
  }

  function syncDelayRows(ppNo, flagged) {
    const body = document.getElementById('sol-table-body');
    if (!body || !ppNo) return;
    body.querySelectorAll('.sol-delay-input').forEach(input => {
      if (String(input.dataset.ppVoucherNo || '') !== ppNo) return;
      applyDelayUi(input, flagged);
    });
  }

  function syncNeedDateRows(ppNo, value) {
    const body = document.getElementById('sol-table-body');
    if (!body || !ppNo) return;
    const saved = isoDateValue(value);
    body.querySelectorAll('.sol-need-date-input').forEach(input => {
      if (String(input.dataset.ppVoucherNo || '') !== ppNo) return;
      input.value = saved;
      input.dataset.lastSaved = saved;
      const cell = input.closest('.sol-need-date-cell');
      if (cell) cell.classList.toggle('has-need-date', Boolean(saved));
    });
  }

  function syncNotesRows(ppNo, field, value) {
    const body = document.getElementById('sol-table-body');
    if (!body || !ppNo || !field) return;
    const saved = String(value == null ? '' : value);
    body.querySelectorAll(`.so-editable-input[data-field="${field}"]`).forEach(input => {
      if (String(input.dataset.ppVoucherNo || '') !== ppNo) return;
      input.value = saved;
      input.dataset.lastSaved = saved;
    });
  }

  function syncMaterialRows(ppNo, raw) {
    const body = document.getElementById('sol-table-body');
    if (!body || !ppNo) return;
    body.querySelectorAll('.so-material-subcon-cell').forEach(cell => {
      if (String(cell.dataset.ppVoucherNo || '') !== ppNo) return;
      syncMaterialCell(cell, raw);
    });
  }

  function syncRequestDelayRows(requestId, flagged) {
    const body = document.getElementById('sol-table-body');
    const id = Number(requestId);
    if (!body || !id) return;
    body.querySelectorAll('.sol-delay-input').forEach(input => {
      if (Number(input.dataset.requestId) !== id) return;
      applyDelayUi(input, flagged);
    });
  }

  function applyDelayUi(input, flagged) {
    const row = input.closest('tr');
    const label = input.closest('.sol-delay-flag');
    input.checked = Boolean(flagged);
    if (row) row.classList.toggle('is-material-delay', Boolean(flagged));
    if (label) {
      label.classList.toggle('is-active', Boolean(flagged));
      label.setAttribute('aria-pressed', flagged ? 'true' : 'false');
      label.title = flagged
        ? 'Material delay flagged — click to clear'
        : 'Flag material arrival delay';
    }
  }

  function setDelayStatus(control, status, message) {
    const el = control?.closest('.sol-delay-cell')?.querySelector('.sol-delay-status');
    if (!el) return;
    el.className = `sol-delay-status${status ? ` is-${status}` : ''}`;
    el.textContent = message || '';
  }

  async function saveDelayFlag(input) {
    const requestId = requestIdOf(input);
    if (requestId) {
      await saveRequestDelayFlag(input, requestId);
      return;
    }
    const ppNo = String(input?.dataset?.ppVoucherNo || '').trim();
    if (!ppNo || input.disabled) return;

    const flagged = Boolean(input.checked);
    const label = input.closest('.sol-delay-flag');
    const found = findPp(ppNo);
    const previous = Boolean(found?.pp?.material_delay);
    const key = `${ppNo}::material_delay`;
    if (state.saveInFlight.has(key)) {
      input.checked = previous;
      return;
    }

    if (found?.pp) found.pp.material_delay = flagged;
    patchAssemblyChildNotes(ppNo, { material_delay: flagged });
    syncDelayRows(ppNo, flagged);
    state.saveInFlight.add(key);
    input.disabled = true;
    if (label) label.classList.add('is-saving');
    setDelayStatus(input, 'saving', 'Saving...');
    try {
      const data = await postJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, {
        material_delay: flagged,
      });
      const saved = Boolean(data.material_delay);
      if (found?.pp) found.pp.material_delay = saved;
      patchAssemblyChildNotes(ppNo, { material_delay: saved });
      syncDelayRows(ppNo, saved);
      setDelayStatus(input, 'saved', saved ? 'Flagged' : 'Cleared');
      window.setTimeout(() => setDelayStatus(input, '', ''), 1500);
    } catch (err) {
      if (found?.pp) found.pp.material_delay = previous;
      patchAssemblyChildNotes(ppNo, { material_delay: previous });
      syncDelayRows(ppNo, previous);
      setDelayStatus(input, 'error', err.message || 'Save failed');
    } finally {
      input.disabled = false;
      if (label) label.classList.remove('is-saving');
      state.saveInFlight.delete(key);
    }
  }

  async function saveRequestDelayFlag(input, requestId) {
    if (!requestId || input.disabled) return;
    const flagged = Boolean(input.checked);
    const label = input.closest('.sol-delay-flag');
    const found = findRequest(requestId);
    const previous = Boolean(found?.material_delay);
    const key = `req:${requestId}::material_delay`;
    if (state.saveInFlight.has(key)) {
      input.checked = previous;
      return;
    }
    if (found) found.material_delay = flagged;
    syncRequestDelayRows(requestId, flagged);
    state.saveInFlight.add(key);
    input.disabled = true;
    if (label) label.classList.add('is-saving');
    setDelayStatus(input, 'saving', 'Saving...');
    try {
      const data = await postJson(`/api/material-tracking/requests/${requestId}`, {
        material_delay: flagged,
      });
      const saved = Boolean(data.row?.material_delay);
      if (found) found.material_delay = saved;
      syncRequestDelayRows(requestId, saved);
      setDelayStatus(input, 'saved', saved ? 'Flagged' : 'Cleared');
      window.setTimeout(() => setDelayStatus(input, '', ''), 1500);
    } catch (err) {
      if (found) found.material_delay = previous;
      syncRequestDelayRows(requestId, previous);
      setDelayStatus(input, 'error', err.message || 'Save failed');
    } finally {
      input.disabled = false;
      if (label) label.classList.remove('is-saving');
      state.saveInFlight.delete(key);
    }
  }

  function renderRow(leaf) {
    const { order, pp, partial, assemblyChild, assemblyChildIndex, assemblyChildCount } = leaf;
    const psType = getPsType(pp);
    const classes = [];
    if (ppIsNoWo(pp)) classes.push('is-no-wo');
    if (pp.material_delay) classes.push('is-material-delay');
    if (psType === 'SR') classes.push('is-sr');
    if (assemblyChild) {
      classes.push('is-sr-line');
      if (assemblyChildIndex === 0) classes.push('is-sr-line-first');
    } else if (Number(assemblyChildCount) > 0) {
      classes.push('is-asm-parent');
    }
    const soKey = String(order.sales_order_no || '').trim().toUpperCase();
    const psKey = psBaseKey(psDisplayForPartial(pp, partial));
    const rowCls = classes.join(' ');
    const lineNo = Number(assemblyChildIndex) + 1;
    const lineCount = Number(assemblyChildCount) || 0;
    const subBadge = assemblyChild
      ? `<span class="sol-subasm-pill" title="Sub-assembly finished good ${lineNo} of ${lineCount} on this assembly">${escapeHtml(String(lineNo))}/${escapeHtml(String(lineCount))}</span>`
      : (Number(assemblyChildCount) > 0
        ? `<span class="sol-subasm-pill" title="${escapeHtml(String(assemblyChildCount))} sub-assembly finished goods tracked as line items">${escapeHtml(String(assemblyChildCount))} FG</span>`
        : '');
    return `
      <tr class="${rowCls}" data-sol-so="${escapeHtml(soKey)}" data-sol-ps="${escapeHtml(psKey)}">
        ${renderDelayCell(pp)}
        ${renderOrderCell(order)}
        <td class="sol-mono sol-col-ps">
          <div class="sol-ps-line">${typeTagHtml(psType)}<span>${escapeHtml(psDisplayForPartial(pp, partial))}</span>${subBadge}</div>
        </td>
        ${renderQtyCell(pp, partial, assemblyChild)}
        ${renderStageCell(pp, partial)}
        ${renderPartCell(pp, partial, assemblyChild)}
        <td class="sol-date sol-col-due">${escapeHtml(formatDate(pp.due_date))}</td>
        ${renderNeedDateCell(pp)}
        ${renderMaterialsCell(pp, partial, assemblyChild)}
        ${renderMaterialCell(pp)}
        ${renderNotesCell(pp)}
      </tr>
    `;
  }

  function renderPrPoRow(row) {
    const desc = String(row.line_item_description || row.item_description || '').trim();
    const remarks = String(row.remarks || row.internal_remarks || '').trim();
    const supplier = String(row.supplier_name || row.supplier_code || '').trim() || EM_DASH;
    return `
      <tr>
        <td class="sol-col-status">${prPoStatusPill(row.status)}</td>
        <td class="sol-mono sol-col-code">${escapeHtml(cellText(row.purchase_requisition_no))}</td>
        <td class="sol-date">${escapeHtml(formatDate(row.pr_date))}</td>
        <td class="sol-mono sol-col-item">${escapeHtml(cellText(row.item_code))}</td>
        ${renderDescCell(desc)}
        ${renderDescCell(remarks)}
        <td class="sol-col-qty">${escapeHtml(formatQty(row.qty))}</td>
        <td class="sol-date">${escapeHtml(formatDate(row.required_arrival_date))}</td>
        <td class="sol-mono sol-col-code">${escapeHtml(cellText(row.purchase_order_no))}</td>
        <td class="sol-date">${escapeHtml(formatDate(row.po_date))}</td>
        <td class="sol-date">${escapeHtml(formatDate(row.estimated_arrival_date))}</td>
        <td class="sol-col-supplier" title="${escapeHtml(supplier)}">${escapeHtml(supplier)}</td>
        <td class="sol-mono sol-col-code">${escapeHtml(cellText(row.project_no))}</td>
        <td class="sol-col-sbu">${escapeHtml(cellText(row.sbu_code))}</td>
        <td class="sol-col-user">${escapeHtml(cellText(row.created_by))}</td>
        <td class="sol-mono sol-col-code">${escapeHtml(cellText(row.grn_no))}</td>
        <td class="sol-date">${escapeHtml(formatDate(row.actual_arrival_date))}</td>
      </tr>
    `;
  }

  function renderQcRow(row) {
    const hasGrn = Boolean(String(row.grn_no || '').trim());
    const desc = String(row.line_item_description || '').trim();
    const supplier = String(row.supplier_name || row.supplier_code || '').trim() || EM_DASH;
    const item = String(row.item_code || row.inventory_code || row.service_code || '').trim();
    const qi = String(row.qi_voucher_no || '').trim();
    const qiStatus = String(row.qi_status || '').trim().toUpperCase();
    const doNo = String(row.supplier_do_no || '').trim();
    const statusCls = hasGrn ? 'sol-qc-pill sol-qc-pill--ready' : 'sol-qc-pill sol-qc-pill--awaiting';
    const statusLabel = hasGrn ? 'Ready for QC' : 'Awaiting GRN';
    const rowCls = hasGrn ? 'is-qc-ready' : 'is-qc-awaiting';
    return `
      <tr class="${rowCls}">
        <td><span class="${statusCls}">${escapeHtml(statusLabel)}</span></td>
        <td class="sol-mono">${escapeHtml(cellText(row.shipment_voucher_no))}</td>
        <td class="sol-mono">${escapeHtml(cellText(row.po_no))}</td>
        <td title="${escapeHtml(supplier)}">${escapeHtml(supplier)}</td>
        <td class="sol-mono">${escapeHtml(item || EM_DASH)}</td>
        ${renderDescCell(desc)}
        <td class="sol-col-qty">${escapeHtml(formatQty(row.qty))}</td>
        <td class="sol-col-qty">${escapeHtml(formatQty(row.qty_received))}</td>
        <td>${escapeHtml(cellText(row.uom_code))}</td>
        <td class="sol-mono">${hasGrn ? `<span class="sol-qc-grn">${escapeHtml(row.grn_no)}</span>` : EM_DASH}</td>
        <td class="sol-date">${escapeHtml(formatDate(row.goods_receipt_date))}</td>
        <td class="sol-mono" title="${escapeHtml(doNo)}">${escapeHtml(doNo || EM_DASH)}</td>
        <td class="sol-mono">${qi ? `${escapeHtml(qi)}${qiStatus ? ` · ${escapeHtml(qiStatus)}` : ''}` : EM_DASH}</td>
        <td>${escapeHtml(cellText(row.receiving_location_code))}</td>
      </tr>
    `;
  }

  function shipDateCell(value) {
    return `<td class="sol-date">${escapeHtml(formatDate(value))}</td>`;
  }

  function renderShipRow(row) {
    const party = String(row.party_name || '').trim() || EM_DASH;
    const subject = String(row.subject || '').trim();
    const location = String(row.location_name || '').trim();
    if (shipDirection() === 'out') {
      return `
        <tr>
          <td class="sol-mono">${escapeHtml(cellText(row.shipment_voucher_no))}</td>
          <td class="sol-mono">${escapeHtml(cellText(row.do_no))}</td>
          <td class="sol-mono">${escapeHtml(cellText(row.invoice_no))}</td>
          <td class="sol-mono">${escapeHtml(cellText(row.source_voucher_no))}</td>
          ${shipDateCell(row.shipment_date)}
          ${shipDateCell(row.arrival_date)}
          ${shipDateCell(row.shipment_date_actual)}
          <td>${escapeHtml(cellText(row.priority))}</td>
          <td>${escapeHtml(cellText(row.mode))}</td>
          ${renderDescCell(subject)}
          <td class="sol-mono">${escapeHtml(cellText(row.reference_no))}</td>
          <td title="${escapeHtml(location)}">${escapeHtml(location || EM_DASH)}</td>
          <td title="${escapeHtml(party)}">${escapeHtml(party)}</td>
          <td>${escapeHtml(cellText(row.created_by_name))}</td>
          ${shipDateCell(row.created_datetime)}
          <td>${escapeHtml(cellText(row.last_updated_by_name))}</td>
          ${shipDateCell(row.last_updated_datetime)}
        </tr>`;
    }
    const grn = String(row.grn_no || '').trim();
    return `
      <tr>
        <td class="sol-mono">${escapeHtml(cellText(row.shipment_voucher_no))}</td>
        <td class="sol-mono">${grn ? `<span class="sol-qc-grn">${escapeHtml(grn)}</span>` : EM_DASH}</td>
        <td class="sol-mono">${escapeHtml(cellText(row.source_voucher_no))}</td>
        <td class="sol-mono">${escapeHtml(cellText(row.supplier_do_no))}</td>
        ${shipDateCell(row.shipment_date)}
        ${shipDateCell(row.arrival_date)}
        ${shipDateCell(row.goods_receipt_date)}
        <td>${escapeHtml(cellText(row.priority))}</td>
        <td>${escapeHtml(cellText(row.mode))}</td>
        ${renderDescCell(subject)}
        <td class="sol-mono">${escapeHtml(cellText(row.reference_no))}</td>
        <td title="${escapeHtml(location)}">${escapeHtml(location || EM_DASH)}</td>
        <td title="${escapeHtml(party)}">${escapeHtml(party)}</td>
        <td>${escapeHtml(cellText(row.created_by_name))}</td>
        ${shipDateCell(row.created_datetime)}
        <td>${escapeHtml(cellText(row.last_updated_by_name))}</td>
        ${shipDateCell(row.last_updated_datetime)}
      </tr>`;
  }

  function shipSearchText(row) {
    return [
      row.shipment_voucher_no,
      row.grn_no,
      row.do_no,
      row.invoice_no,
      row.source_voucher_no,
      row.supplier_do_no,
      row.subject,
      row.reference_no,
      row.location_name,
      row.party_name,
      row.created_by_name,
      row.priority,
      row.mode,
      row.sbu_code,
    ].map(value => String(value == null ? '' : value).toLowerCase()).join(' ');
  }

  function visibleShipRows() {
    const columns = shipColumns();
    const q = String(state.search || '').trim().toLowerCase();
    let rows = q ? state.shipRows.filter(row => shipSearchText(row).includes(q)) : state.shipRows.slice();
    rows = rows.filter(row => passesColumnFilters(row, columns, state.shipFilters));
    return sortRowsByColumn(rows, columns, state.shipSortKey, state.shipSortDir);
  }

  function shipColumns() {
    return shipDirection() === 'out' ? SHIP_OUT_COLUMNS : SHIP_IN_COLUMNS;
  }

  function isBlankDisplay(value) {
    const text = String(value == null ? '' : value).trim();
    return !text || text === EM_DASH || text === '—' || text === '-';
  }

  function columnRaw(row, col) {
    if (typeof col.value === 'function') return col.value(row);
    return row[col.key];
  }

  function columnFilterKey(row, col) {
    const raw = columnRaw(row, col);
    if (col.type === 'date') {
      const shown = formatDate(raw);
      return isBlankDisplay(shown) ? '' : shown;
    }
    if (col.type === 'num') {
      const shown = formatQty(raw);
      return isBlankDisplay(shown) ? '' : shown;
    }
    const text = String(raw == null ? '' : raw).trim();
    return isBlankDisplay(text) ? '' : text;
  }

  function columnSortValue(row, col) {
    const raw = columnRaw(row, col);
    if (col.type === 'date') return dateSortValue(raw);
    if (col.type === 'num') {
      const num = Number(raw);
      return Number.isFinite(num) ? num : null;
    }
    const text = String(raw == null ? '' : raw).trim();
    return text ? text.toLowerCase() : '';
  }

  function passesColumnFilters(row, columns, filters) {
    return columns.every(col => {
      const selected = filters[col.key];
      if (!selected || !selected.size) return true;
      return selected.has(columnFilterKey(row, col));
    });
  }

  function sortRowsByColumn(rows, columns, sortKey, sortDir) {
    if (!sortKey) return rows;
    const col = columns.find(item => item.key === sortKey);
    if (!col) return rows;
    const dir = sortDir === 'desc' ? -1 : 1;
    return rows.slice().sort((a, b) => compareSortValues(
      columnSortValue(a, col),
      columnSortValue(b, col),
      dir,
    ));
  }

  function columnFiltersActive(filters) {
    return Object.values(filters || {}).some(selected => selected && selected.size);
  }

  function columnFilterOptions(rows, col, selected) {
    const sortOf = new Map();
    rows.forEach(row => {
      const key = columnFilterKey(row, col);
      if (!sortOf.has(key)) sortOf.set(key, columnSortValue(row, col));
    });
    if (selected) {
      selected.forEach(key => {
        if (sortOf.has(key)) return;
        sortOf.set(key, col.type === 'num' || col.type === 'date' ? null : String(key || '').toLowerCase());
      });
    }
    return [...sortOf.entries()]
      .sort((a, b) => compareSortValues(a[1], b[1], 1))
      .map(entry => entry[0]);
  }

  function activeColumnContext() {
    if (isShipView()) {
      return {
        kind: 'ship',
        columns: shipColumns(),
        rows: state.shipRows,
        filters: state.shipFilters,
        sortKey: state.shipSortKey,
        sortDir: state.shipSortDir,
      };
    }
    if (isQcView()) {
      return {
        kind: 'qc',
        columns: QC_COLUMNS,
        rows: state.qcRows,
        filters: state.qcFilters,
        sortKey: state.qcSortKey,
        sortDir: state.qcSortDir,
      };
    }
    return null;
  }

  function resetShipColumnControls() {
    state.shipSortKey = '';
    state.shipSortDir = 'asc';
    state.shipFilters = {};
  }

  function toggleColumnSort(kind, key) {
    const columns = kind === 'qc' ? QC_COLUMNS : shipColumns();
    const col = columns.find(item => item.key === key);
    if (!col) return;
    const keyName = kind === 'qc' ? 'qcSortKey' : 'shipSortKey';
    const dirName = kind === 'qc' ? 'qcSortDir' : 'shipSortDir';
    if (state[keyName] === key) {
      state[dirName] = state[dirName] === 'asc' ? 'desc' : 'asc';
    } else {
      state[keyName] = key;
      state[dirName] = col.type === 'date' || col.type === 'num' ? 'desc' : 'asc';
    }
  }

  function setColumnFilter(kind, key, values) {
    const filters = kind === 'qc' ? state.qcFilters : state.shipFilters;
    if (!values.size) delete filters[key];
    else filters[key] = values;
    render();
  }

  function clearActiveColumnFilters() {
    if (isShipView()) state.shipFilters = {};
    if (isQcView()) state.qcFilters = {};
    render();
  }

  function renderRequestDelayCell(row) {
    const id = Number(row.request_id) || 0;
    const flagged = Boolean(row.material_delay);
    return `
      <td class="sol-delay-cell">
        <label class="sol-delay-flag${flagged ? ' is-active' : ''}"
          title="${flagged ? 'Material delay flagged — click to clear' : 'Flag material arrival delay'}"
          aria-pressed="${flagged ? 'true' : 'false'}"
          aria-label="${flagged ? 'Material delay flagged' : 'Flag material arrival delay'}">
          <input type="checkbox"
            class="sol-delay-input"
            data-request-id="${escapeHtml(String(id))}"
            ${flagged ? 'checked' : ''}
            tabindex="-1"
            aria-hidden="true">
          <span class="sol-delay-mark" aria-hidden="true">⚑</span>
        </label>
        <span class="sol-delay-status" aria-live="polite"></span>
      </td>
    `;
  }

  function renderRequestMaterialCell(row) {
    const id = Number(row.request_id) || 0;
    const raw = String(row.material_subcon || '');
    const parsed = parseMaterialSubcon(raw);
    const arrivedCls = parsed.arrived ? ' is-active' : '';
    const dateHiddenCls = parsed.arrived ? ' is-hidden' : '';
    const cellStateCls = parsed.arrived ? ' has-material-arrived' : (parsed.date ? ' has-material-date' : '');
    return `
      <td class="so-material-subcon-cell${cellStateCls}" data-request-id="${escapeHtml(String(id))}" data-last-saved="${escapeHtml(raw)}">
        <div class="so-material-subcon-controls">
          <button type="button"
            class="so-material-subcon-arrived${arrivedCls}"
            data-action="toggle-subcon-arrived"
            aria-pressed="${parsed.arrived ? 'true' : 'false'}"
            title="${parsed.arrived ? 'Material arrived - click to clear' : 'Mark material as arrived'}">
            <span class="so-material-subcon-arrived-dot" aria-hidden="true"></span>
            Arrived
          </button>
          <input type="date"
            class="so-material-subcon-date${dateHiddenCls}"
            value="${escapeHtml(parsed.arrived ? '' : parsed.date)}"
            ${parsed.arrived ? 'disabled' : ''}
            aria-label="Material EDD date">
        </div>
        <span class="so-editable-status" aria-live="polite"></span>
      </td>
    `;
  }

  function renderRequestNotesCell(row) {
    const id = Number(row.request_id) || 0;
    const value = String(row.remarks || '');
    return `
      <td class="so-editable-cell sol-col-notes">
        <textarea
          class="so-editable-input"
          rows="1"
          data-request-id="${escapeHtml(String(id))}"
          data-field="remarks"
          data-last-saved="${escapeHtml(value)}"
          aria-label="Remarks"
          placeholder="Notes..."
        >${escapeHtml(value)}</textarea>
        <span class="so-editable-status" aria-live="polite"></span>
      </td>
    `;
  }

  function renderRequestRow(row) {
    const id = Number(row.request_id) || 0;
    const part = String(row.part_no || '').trim();
    const inv = String(row.inventory_code || '').trim();
    const bomPart = part || inv;
    const qtyVal = row.qty == null || row.qty === '' ? '' : String(row.qty);
    const classes = row.material_delay ? 'is-material-delay' : '';
    return `
      <tr class="${classes}" data-request-id="${escapeHtml(String(id))}">
        ${renderRequestDelayCell(row)}
        <td class="sol-mono">${escapeHtml(part || EM_DASH)}</td>
        <td class="sol-mono">${escapeHtml(inv || EM_DASH)}</td>
        ${renderDescCell(row.description)}
        <td class="sol-col-qty">
          <input type="number" min="0" step="any"
            class="sol-qty-cell-input"
            data-request-id="${escapeHtml(String(id))}"
            data-field="qty"
            data-last-saved="${escapeHtml(qtyVal)}"
            value="${escapeHtml(qtyVal)}"
            aria-label="Qty">
        </td>
        ${renderRequestMaterialCell(row)}
        ${renderRequestNotesCell(row)}
        <td class="sol-col-bom">
          ${bomPart ? `
            <button type="button" class="sol-materials-btn"
              data-action="open-material"
              data-part-no="${escapeHtml(bomPart)}"
              data-bom-code=""
              data-process-sheet=""
              title="BOM materials and inventory for ${escapeHtml(bomPart)}">BOM</button>
          ` : EM_DASH}
        </td>
        <td class="sol-col-actions">
          <button type="button" class="sol-btn sol-btn--ghost sol-delete-btn"
            data-action="delete-request"
            data-request-id="${escapeHtml(String(id))}"
            title="Remove this part request"
            aria-label="Remove request ${escapeHtml(part || inv || String(id))}">Remove</button>
        </td>
      </tr>
    `;
  }

  function setSaveStatus(control, status, message) {
    const el = control?.closest('.so-editable-cell, .so-material-subcon-cell, .sol-need-date-cell')?.querySelector('.so-editable-status');
    if (!el) return;
    el.className = `so-editable-status${status ? ` is-${status}` : ''}`;
    el.textContent = message || '';
  }

  function syncMaterialCell(cell, raw) {
    if (!cell) return;
    const parsed = parseMaterialSubcon(raw);
    applyMaterialCellState(cell, parsed);
    cell.dataset.lastSaved = String(raw || '');
    const btn = cell.querySelector('.so-material-subcon-arrived');
    const dateInput = cell.querySelector('.so-material-subcon-date');
    if (btn) {
      btn.classList.toggle('is-active', parsed.arrived);
      btn.setAttribute('aria-pressed', parsed.arrived ? 'true' : 'false');
    }
    if (dateInput) {
      dateInput.disabled = parsed.arrived;
      dateInput.classList.toggle('is-hidden', parsed.arrived);
      if (parsed.date) dateInput.value = parsed.date;
      else dateInput.value = '';
    }
  }

  async function saveRequestPatch(requestId, patch, { cell, onSaved, onRevert, lastSaved, key }) {
    if (!requestId || !cell) return;
    const nextValue = Object.values(patch)[0];
    const nextText = nextValue == null ? '' : String(nextValue).trim();
    if (state.saveInFlight.has(key)) return;
    if (nextText === String(lastSaved || '').trim() && !('material_delay' in patch)) return;

    state.saveInFlight.add(key);
    setSaveStatus(cell, 'saving', 'Saving...');
    try {
      const data = await postJson(`/api/material-tracking/requests/${requestId}`, patch);
      const row = data.row || {};
      const found = findRequest(requestId);
      if (found) Object.assign(found, row);
      if (onSaved) onSaved(row);
      setSaveStatus(cell, 'saved', 'Saved');
      window.setTimeout(() => {
        if (cell.isConnected) setSaveStatus(cell, '', '');
      }, 1500);
    } catch (err) {
      if (onRevert) onRevert(lastSaved);
      setSaveStatus(cell, 'error', err.message || 'Save failed');
    } finally {
      state.saveInFlight.delete(key);
    }
  }

  async function saveMaterialCell(cell, nextValue) {
    const requestId = requestIdOf(cell);
    if (requestId) {
      await saveRequestPatch(requestId, { material_subcon: String(nextValue || '').trim() }, {
        cell,
        onSaved(row) {
          syncMaterialCell(cell, String(row.material_subcon || ''));
          if (Object.prototype.hasOwnProperty.call(row, 'material_delay')) {
            syncRequestDelayRows(requestId, Boolean(row.material_delay));
          }
        },
        onRevert(lastSaved) {
          syncMaterialCell(cell, lastSaved);
        },
        lastSaved: String(cell.dataset.lastSaved || '').trim(),
        key: `req:${requestId}::material_subcon`,
      });
      return;
    }
    const ppNo = String(cell?.dataset?.ppVoucherNo || '').trim();
    if (!ppNo || !cell) return;
    const key = `${ppNo}::material_subcon`;
    if (state.saveInFlight.has(key)) return;
    const savedValue = String(nextValue || '').trim();
    const lastSaved = String(cell.dataset.lastSaved || '').trim();
    if (savedValue === lastSaved) return;

    state.saveInFlight.add(key);
    setSaveStatus(cell, 'saving', 'Saving...');
    try {
      const data = await postJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, {
        material_subcon: savedValue,
      });
      const saved = String(data.material_subcon || '').trim();
      syncMaterialRows(ppNo, saved);
      const found = findPp(ppNo);
      if (found.pp) {
        found.pp.material_subcon = saved;
        found.pp.assembly_material_subcon = saved;
        if (Object.prototype.hasOwnProperty.call(data, 'material_delay')) {
          found.pp.material_delay = Boolean(data.material_delay);
          syncDelayRows(ppNo, found.pp.material_delay);
        }
      }
      patchAssemblyChildNotes(ppNo, {
        material_subcon: saved,
        ...(Object.prototype.hasOwnProperty.call(data, 'material_delay')
          ? { material_delay: Boolean(data.material_delay) }
          : {}),
      });
      applyHistoryCountsFromSave(ppNo, data);
      setSaveStatus(cell, 'saved', 'Saved');
      window.setTimeout(() => {
        if (String(cell.dataset.lastSaved || '').trim() === saved) setSaveStatus(cell, '', '');
      }, 1500);
    } catch (err) {
      syncMaterialRows(ppNo, lastSaved);
      setSaveStatus(cell, 'error', err.message || 'Save failed');
    } finally {
      state.saveInFlight.delete(key);
    }
  }

  async function saveNotesField(control) {
    const requestId = requestIdOf(control);
    const field = String(control.dataset.field || '').trim();
    if (requestId && (field === 'remarks' || field === 'qty')) {
      const nextValue = String(control.value || '').trim();
      await saveRequestPatch(requestId, { [field]: nextValue }, {
        cell: control,
        onSaved(row) {
          const saved = row[field] == null ? '' : String(row[field]).trim();
          control.value = saved;
          control.dataset.lastSaved = saved;
        },
        onRevert(lastSaved) {
          control.value = lastSaved;
        },
        lastSaved: String(control.dataset.lastSaved || ''),
        key: `req:${requestId}::${field}`,
      });
      return;
    }
    const ppNo = String(control.dataset.ppVoucherNo || '').trim();
    const saveable = field === 'mtl_part_order' || field === 'material_need_date';
    if (!ppNo || !saveable) return;
    const key = `${ppNo}::${field}`;
    if (state.saveInFlight.has(key)) return;
    const nextValue = field === 'material_need_date'
      ? isoDateValue(control.value)
      : String(control.value || '').trim();
    const lastSaved = String(control.dataset.lastSaved || '');
    if (nextValue === lastSaved) return;

    state.saveInFlight.add(key);
    setSaveStatus(control, 'saving', 'Saving...');
    try {
      const payload = field === 'material_need_date'
        ? { material_need_date: nextValue }
        : { [field]: nextValue };
      const data = await postJson(`/api/sales-orders/notes/${encodeURIComponent(ppNo)}`, payload);
      const saved = field === 'material_need_date'
        ? isoDateValue(data.material_need_date)
        : String(data[field] || '').trim();
      const found = findPp(ppNo);
      if (found.pp) found.pp[field] = saved;
      patchAssemblyChildNotes(ppNo, { [field]: saved });
      if (field === 'material_need_date') syncNeedDateRows(ppNo, saved);
      else syncNotesRows(ppNo, field, saved);
      applyHistoryCountsFromSave(ppNo, data);
      setSaveStatus(control, 'saved', 'Saved');
      window.setTimeout(() => {
        if (control.dataset.lastSaved === saved) setSaveStatus(control, '', '');
      }, 1500);
    } catch (err) {
      control.value = lastSaved;
      setSaveStatus(control, 'error', err.message || 'Save failed');
    } finally {
      state.saveInFlight.delete(key);
    }
  }

  function countNoWoJobs() {
    const seen = new Set();
    let count = 0;
    state.active.forEach(order => {
      leafRows(order).forEach(leaf => {
        const ppNo = String(leaf.pp?.pp_voucher_no || '').trim();
        if (!ppNo || seen.has(ppNo) || !ppIsNoWo(leaf.pp)) return;
        seen.add(ppNo);
        count += 1;
      });
    });
    return count;
  }

  function countActiveJobs() {
    const seen = new Set();
    let count = 0;
    state.active.forEach(order => {
      (order.pp_vouchers || []).forEach(pp => {
        const ppNo = String(pp.pp_voucher_no || '').trim();
        if (!ppNo || seen.has(ppNo)) return;
        seen.add(ppNo);
        count += 1;
      });
    });
    return count;
  }

  function countSrJobs() {
    const seen = new Set();
    let count = 0;
    state.active.forEach(order => {
      (order.pp_vouchers || []).forEach(pp => {
        const ppNo = String(pp.pp_voucher_no || '').trim();
        if (!ppNo || seen.has(ppNo) || getPsType(pp) !== 'SR') return;
        seen.add(ppNo);
        count += 1;
      });
    });
    return count;
  }

  function setChipCount(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const n = Number(value) || 0;
    el.textContent = String(n);
    el.hidden = n === 0;
  }

  function updatePrPoChipCounts() {
    const pr = state.prPoCounts.pr || {};
    const po = state.prPoCounts.po || {};
    const prOst = Number(pr.ost) || 0;
    const poOst = Number(po.ost) || 0;
    setChipCount('sol-pr-count', prOst);
    setChipCount('sol-po-count', poOst);

    const scopeCounts = state.view === 'purchase-order' ? po : pr;
    setChipCount('sol-bucket-ost-count', scopeCounts.ost);
    setChipCount('sol-bucket-new-count', scopeCounts.new);
    setChipCount('sol-bucket-hst-count', scopeCounts.hst);
    updateQcChipCounts();
  }

  function updateQcChipCounts() {
    const ready = Number(state.qcCounts.ready_qc) || 0;
    const awaiting = Number(state.qcCounts.awaiting_grn) || 0;
    setChipCount('sol-qc-ready-count', ready);
    setChipCount('sol-qc-awaiting-count', awaiting);
    setChipCount('sol-qc-count', ready + awaiting);
  }

  function updateShipChipCounts() {
    const inbound = state.shipCounts.in || {};
    const outbound = state.shipCounts.out || {};
    setChipCount('sol-in-ost-count', inbound.outstanding);
    setChipCount('sol-in-grn-count', inbound.grn);
    setChipCount('sol-in-hst-count', inbound.history);
    setChipCount('sol-in-can-count', inbound.cancelled);
    setChipCount('sol-out-ost-count', outbound.outstanding);
    setChipCount('sol-out-hst-count', outbound.history);
    setChipCount('sol-out-can-count', outbound.cancelled);
  }

  function setStatPills(items) {
    const host = document.getElementById('sol-stat-pills');
    if (!host) return;
    host.innerHTML = (items || []).map(item => `
      <div class="sol-stat-pill">
        <span class="sol-stat-pill-label">${escapeHtml(item.label)}</span>
        <span class="sol-stat-pill-value">${escapeHtml(String(item.value))}</span>
      </div>
    `).join('');
  }

  function updatePsStats(rows) {
    const subtitle = document.getElementById('sol-subtitle');
    const activeJobs = countActiveJobs();
    const noWoJobs = countNoWoJobs();
    const srJobs = countSrJobs();
    const viewLabel = state.view === 'no-wo' ? 'No WO' : (state.view === 'sr' ? '[SR]' : 'Active');

    setChipCount('sol-active-count', activeJobs);
    setChipCount('sol-no-wo-count', noWoJobs);
    setChipCount('sol-sr-count', srJobs);
    updatePrPoChipCounts();
    setStatPills([
      { label: 'Shown', value: rows.length },
      { label: 'Active PP', value: activeJobs },
      { label: 'Awaiting WO', value: noWoJobs },
      { label: '[SR]', value: srJobs },
    ]);

    if (subtitle) {
      subtitle.textContent = `${rows.length} ${viewLabel} rows shown | ${activeJobs} active PP | ${noWoJobs} awaiting WO | ${srJobs} outstanding [SR]`;
    }
  }

  function prPoFilterSummary() {
    const parts = [];
    if (state.selectedSbu.size) {
      const sbus = Array.from(state.selectedSbu);
      parts.push(sbus.length <= 2 ? `SBU ${sbus.join(', ')}` : `${sbus.length} SBUs`);
    }
    if (state.selectedSuppliers.size) {
      parts.push(
        state.selectedSuppliers.size === 1
          ? `supplier ${Array.from(state.selectedSuppliers)[0]}`
          : `${state.selectedSuppliers.size} suppliers`,
      );
    }
    return parts;
  }

  function updatePrPoStats(rows) {
    const subtitle = document.getElementById('sol-subtitle');
    const scopeLabel = state.view === 'purchase-order' ? 'Purchase Order' : 'PR Enquiry';
    const bucketLabel = BUCKET_LABELS[state.prPoBucket] || state.prPoBucket;
    const scopeCounts = state.view === 'purchase-order'
      ? (state.prPoCounts.po || {})
      : (state.prPoCounts.pr || {});
    updatePrPoChipCounts();
    const extra = prPoFilterSummary();
    if (subtitle) {
      subtitle.textContent = extra.length
        ? `${rows.length} ${scopeLabel} · ${bucketLabel} rows shown · ${extra.join(' · ')}`
        : `${rows.length} ${scopeLabel} · ${bucketLabel} rows shown`;
    }
    setStatPills([
      { label: 'Shown', value: rows.length },
      { label: 'Outstanding', value: Number(scopeCounts.ost) || 0 },
      { label: 'History', value: Number(scopeCounts.hst) || 0 },
    ]);
  }

  function updateQcStats(rows) {
    const subtitle = document.getElementById('sol-subtitle');
    const bucketLabel = QC_BUCKET_LABELS[state.qcBucket] || state.qcBucket;
    updateQcChipCounts();
    if (subtitle) {
      const total = state.qcRows.length;
      subtitle.textContent = rows.length === total
        ? `${rows.length} ${bucketLabel} inbound lines shown`
        : `${rows.length} of ${total} ${bucketLabel} inbound lines match`;
    }
    setStatPills([
      { label: 'Shown', value: rows.length },
      { label: 'Ready for QC', value: Number(state.qcCounts.ready_qc) || 0 },
      { label: 'Awaiting GRN', value: Number(state.qcCounts.awaiting_grn) || 0 },
    ]);
  }

  function syncNavUi() {
    const prPo = isPrPoView();
    const requests = isRequestView();
    const qc = isQcView();
    const ship = isShipView();
    const section = sectionForView();
    const prpoToolbar = document.getElementById('sol-prpo-toolbar');
    const newBucketBtn = document.querySelector('[data-sol-bucket="new"]');
    const search = document.getElementById('sol-search');
    const legend = document.getElementById('sol-legend');
    const page = document.querySelector('.sol-page');
    if (page) {
      page.classList.toggle('sol-page--wide', prPo || qc || ship);
      page.classList.toggle('sol-page--prpo', prPo);
    }

    document.querySelectorAll('[data-sol-section]').forEach(btn => {
      const active = btn.getAttribute('data-sol-section') === section;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-sol-section-panel]').forEach(panel => {
      panel.hidden = panel.getAttribute('data-sol-section-panel') !== section;
    });

    document.querySelectorAll('.sol-ps-only').forEach(el => {
      el.hidden = !isPsView();
    });
    const typeDrop = document.getElementById('sol-ps-type-dropdown');
    if (typeDrop) typeDrop.hidden = !isPsView() || state.view === 'sr';
    document.querySelectorAll('.sol-req-only').forEach(el => {
      el.hidden = !requests;
    });
    document.querySelectorAll('.sol-edd-filter').forEach(el => {
      el.hidden = prPo || qc || ship;
    });

    if (prpoToolbar) prpoToolbar.hidden = !prPo;
    if (newBucketBtn) newBucketBtn.hidden = state.view !== 'purchase-order';

    document.querySelectorAll('[data-sol-view]').forEach(btn => {
      const view = btn.getAttribute('data-sol-view');
      const shipBucket = btn.getAttribute('data-sol-ship-bucket');
      const qcBucket = btn.getAttribute('data-sol-qc-bucket');
      let active = view === state.view;
      if (active && shipBucket) active = shipBucket === state.shipBucket;
      if (active && qcBucket) active = qcBucket === state.qcBucket;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    document.querySelectorAll('[data-sol-bucket]').forEach(btn => {
      const active = btn.getAttribute('data-sol-bucket') === state.prPoBucket;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    const clearFilters = document.getElementById('sol-clear-col-filters');
    if (clearFilters) {
      const filtering = (ship && columnFiltersActive(state.shipFilters))
        || (qc && columnFiltersActive(state.qcFilters));
      clearFilters.hidden = !filtering;
    }

    if (search) {
      const shipLabel = shipDirection() === 'out' ? 'DO, invoice, customer' : 'GRN, supplier DO, supplier';
      search.placeholder = prPo
        ? 'Search item, PR, PO, supplier, remarks...'
        : requests
          ? 'Search part no, inventory code, remarks...'
          : qc
            ? 'Search shipment, PO, GRN, supplier, item...'
            : ship
              ? `Search shipment, source, ${shipLabel}...`
              : state.view === 'sr'
                ? 'Search [SR] sheet, SO, part, sub-assembly...'
                : 'Search SO, PP, part, sub-assembly...';
    }
    if (legend) {
      legend.hidden = prPo;
      if (ship) {
        const inbound = shipDirection() === 'in';
        const sortHint = ' Click a column heading to sort. Use the filter icon to narrow that column.';
        legend.innerHTML = inbound
          ? `Inbound shipments from ERP. <strong>Outstanding</strong> has no GRN yet, <strong>GRN</strong> is still open with a receipt, <strong>History</strong> is posted, <strong>Cancelled</strong> is void. Ready for QC and Awaiting GRN are the inspection queues.${sortHint}`
          : `Outbound shipments from ERP. <strong>Outstanding</strong> is still open, <strong>History</strong> is posted, <strong>Cancelled</strong> is void. History shows the latest 500 vouchers.${sortHint}`;
      } else if (qc) {
        legend.innerHTML = `
          <span class="sol-legend-item sol-legend-item--qc-ready">Green GRN</span> material ready for QC &middot;
          <span class="sol-legend-item sol-legend-item--qc-awaiting">Amber row</span> received, GRN not generated in ERP &middot;
          Source: outstanding inbound shipments (<code>lg_in_shm_ost</code>) &middot;
          Click a column heading to sort. Use the filter icon to narrow that column.
        `;
      } else if (requests) {
        legend.innerHTML = `
          <span class="sol-legend-item sol-legend-item--delay">Rose row</span> material delay &middot;
          <span class="sol-legend-item sol-legend-item--date">Blue cell</span> material EDD &middot;
          <span class="sol-legend-item sol-legend-item--arrived">Green cell</span> material arrived &middot;
          Not tagged to a process sheet &middot;
          Click <strong>BOM</strong> for materials + inventory enquiry
        `;
      } else {
        legend.innerHTML = `
          <span class="sol-legend-item sol-legend-item--delay">Rose row</span> material delay &middot;
          <span class="sol-legend-item sol-legend-item--no-wo">Amber row</span> awaiting WO &middot;
          <span class="sol-legend-item sol-legend-item--date">Blue cell</span> expected date &middot;
          <span class="sol-legend-item sol-legend-item--arrived">Green cell</span> material arrived &middot;
          Click <strong>Flag</strong> for material arrival delay &middot;
          Click <strong>BOM</strong> for materials + inventory enquiry &middot;
          <span class="sol-legend-item sol-legend-item--sr">[SR]</span> special process sheets &middot;
          Assembly sub-assembly finished goods appear as separate lines
        `;
      }
    }
  }

  function columnFilterTitle(col, selected) {
    if (!selected || !selected.size) return `Filter ${col.label}`;
    const labels = [...selected].map(value => value || BLANK_SUPPLIER);
    const shown = labels.length <= 2 ? labels.join(', ') : `${labels.length} selected`;
    return `${col.label}: ${shown}`;
  }

  function columnTableHeadHtml(columns, sortKey, sortDir, filters) {
    return `<tr>${columns.map(col => {
      const sorted = sortKey === col.key;
      const selected = filters[col.key];
      const filtering = Boolean(selected && selected.size);
      const classes = [col.cls, 'is-sortable', sorted ? 'is-sorted' : '', filtering ? 'has-filter' : '']
        .filter(Boolean)
        .join(' ');
      const dir = sorted ? ` data-sort-dir="${escapeHtml(sortDir)}"` : '';
      const aria = sorted
        ? ` aria-sort="${sortDir === 'desc' ? 'descending' : 'ascending'}"`
        : ' aria-sort="none"';
      const ind = sorted
        ? `<span class="sol-th-ind" aria-hidden="true">${sortDir === 'desc' ? '▼' : '▲'}</span>`
        : '';
      const title = columnFilterTitle(col, selected);
      const expanded = state.colFilterKey === col.key ? 'true' : 'false';
      return `<th class="${classes}" data-sort="${escapeHtml(col.key)}"${dir}${aria} title="Sort by ${escapeHtml(col.label)}"><span class="sol-th-row"><span class="sol-th-label">${escapeHtml(col.label)}${ind}</span><button type="button" class="sol-th-filter${filtering ? ' is-active' : ''}" data-col-filter="${escapeHtml(col.key)}" aria-label="${escapeHtml(title)}" aria-expanded="${expanded}" title="${escapeHtml(title)}"><svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M1.5 2.5h13l-5 6.1V13.2l-3-1.4V8.6l-5-6.1z"/></svg></button></span></th>`;
    }).join('')}</tr>`;
  }

  function prPoTableHeadHtml() {
    return `<tr>${PR_PO_COLUMNS.map(col => {
      const sorted = state.sortKey === col.key;
      const classes = [col.cls, 'is-sortable', sorted ? 'is-sorted' : '']
        .filter(Boolean)
        .join(' ');
      const dir = sorted ? ` data-sort-dir="${escapeHtml(state.sortDir)}"` : '';
      return `<th class="${classes}" data-sort="${escapeHtml(col.key)}"${dir} title="Sort by ${escapeHtml(col.label)}">${escapeHtml(col.label)}</th>`;
    }).join('')}</tr>`;
  }

  function ensureTableHead() {
    const head = document.getElementById('sol-table-head');
    const table = document.getElementById('sol-table');
    if (!head) return;
    const mode = isPrPoView()
      ? 'prpo'
      : isRequestView()
        ? 'req'
        : isQcView()
          ? 'qc'
          : isShipView()
            ? (shipDirection() === 'out' ? 'ship-out' : 'ship-in')
            : 'ps';
    if (table) table.dataset.mode = mode;
    const html = mode === 'prpo'
      ? prPoTableHeadHtml()
      : mode === 'req'
        ? REQUEST_TABLE_HEAD
        : mode === 'qc'
          ? columnTableHeadHtml(QC_COLUMNS, state.qcSortKey, state.qcSortDir, state.qcFilters)
          : mode === 'ship-in'
            ? columnTableHeadHtml(SHIP_IN_COLUMNS, state.shipSortKey, state.shipSortDir, state.shipFilters)
            : mode === 'ship-out'
              ? columnTableHeadHtml(SHIP_OUT_COLUMNS, state.shipSortKey, state.shipSortDir, state.shipFilters)
              : PS_TABLE_HEAD;
    if (head.dataset.mode === mode && head.dataset.headHtml === html) return;
    head.dataset.mode = mode;
    head.dataset.headHtml = html;
    head.innerHTML = html;
  }

  function renderPs() {
    const rows = visibleLeaves();
    const body = document.getElementById('sol-table-body');
    const host = document.getElementById('sol-table-host');
    const empty = document.getElementById('sol-empty');
    const loading = document.getElementById('sol-loading');
    const meta = document.getElementById('sol-meta');

    if (loading) loading.hidden = true;
    ensureTableHead();
    updatePsStats(rows);

    if (!rows.length) {
      let msg = 'No rows match your filters.';
      if (!state.active.length) msg = 'No active process sheets in ERP.';
      else if (state.view === 'no-wo') msg = 'No process sheets awaiting work order issuance.';
      else if (state.view === 'sr') msg = 'No outstanding [SR] process sheets match your filters.';
      else if (state.materialFilter === 'empty') msg = 'No rows without a material date or arrival flag.';
      if (body) body.innerHTML = '';
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = msg;
      }
    } else {
      if (host) host.hidden = false;
      if (empty) empty.hidden = true;
      if (body) {
        body.innerHTML = rows.map(renderRow).join('');
        bindInputs();
        applyRowFocus();
      }
    }

    if (meta) {
      meta.hidden = !state.active.length;
      meta.textContent = `Autosave on blur | ${state.ppCount || 0} PP | ${state.partialCount || 0} partials | cached ${state.cachedAt || EM_DASH}`;
    }
  }

  function renderPrPo() {
    const rows = visiblePrPoRows();
    const body = document.getElementById('sol-table-body');
    const host = document.getElementById('sol-table-host');
    const empty = document.getElementById('sol-empty');
    const loading = document.getElementById('sol-loading');
    const meta = document.getElementById('sol-meta');
    const bucketLabel = BUCKET_LABELS[state.prPoBucket] || state.prPoBucket;

    if (loading) loading.hidden = true;
    fillPrPoFilterPanels();
    ensureTableHead();
    updatePrPoStats(rows);

    if (!rows.length) {
      let msg = 'No rows match your filters.';
      if (!state.prPoRows.length) msg = `No ${bucketLabel.toLowerCase()} rows in ERP.`;
      else msg = 'No rows match your filters. Try another status, SBU, supplier, or item search.';
      if (body) body.innerHTML = '';
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = msg;
      }
    } else {
      if (host) host.hidden = false;
      if (empty) empty.hidden = true;
      if (body) {
        body.innerHTML = rows.map(renderPrPoRow).join('');
        bindInputs();
      }
    }

    if (meta) {
      meta.hidden = !state.prPoRows.length && !state.prPoSource;
      meta.textContent = `${state.prPoSource || 'PR/PO'} | ${state.prPoRows.length} rows | cached ${state.cachedAt || EM_DASH}`;
    }
  }

  function updateRequestStats(rows) {
    const subtitle = document.getElementById('sol-subtitle');
    setChipCount('sol-req-count', state.requests.length);
    if (subtitle) {
      subtitle.textContent = `${rows.length} part request${rows.length === 1 ? '' : 's'} shown | ${state.requests.length} saved`;
    }
    setStatPills([
      { label: 'Shown', value: rows.length },
      { label: 'Saved', value: state.requests.length },
    ]);
  }

  function renderRequests() {
    const rows = visibleRequestRows();
    const body = document.getElementById('sol-table-body');
    const host = document.getElementById('sol-table-host');
    const empty = document.getElementById('sol-empty');
    const loading = document.getElementById('sol-loading');
    const meta = document.getElementById('sol-meta');

    if (loading) loading.hidden = true;
    ensureTableHead();
    updateRequestStats(rows);

    if (!rows.length) {
      let msg = 'No rows match your filters.';
      if (!state.requests.length) {
        msg = 'No part requests yet. Search a part no or inventory code and click Add request.';
      }
      if (body) body.innerHTML = '';
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = msg;
      }
    } else {
      if (host) host.hidden = false;
      if (empty) empty.hidden = true;
      if (body) {
        body.innerHTML = rows.map(renderRequestRow).join('');
        bindInputs();
      }
    }

    if (meta) {
      meta.hidden = false;
      meta.textContent = `Autosave on blur | ${state.requests.length} requests | not tagged to a process sheet`;
    }
  }

  function renderQc() {
    const rows = visibleQcRows();
    const body = document.getElementById('sol-table-body');
    const host = document.getElementById('sol-table-host');
    const empty = document.getElementById('sol-empty');
    const loading = document.getElementById('sol-loading');
    const meta = document.getElementById('sol-meta');
    const bucketLabel = QC_BUCKET_LABELS[state.qcBucket] || state.qcBucket;

    if (loading) loading.hidden = true;
    ensureTableHead();
    updateQcStats(rows);

    if (!rows.length) {
      let msg = 'No rows match your filters.';
      if (!state.qcRows.length) {
        msg = state.qcBucket === 'awaiting_grn'
          ? 'No inbound lines are received without a GRN.'
          : 'No inbound lines currently have a GRN ready for QC.';
      }
      if (body) body.innerHTML = '';
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = msg;
      }
    } else {
      if (host) host.hidden = false;
      if (empty) empty.hidden = true;
      if (body) {
        body.innerHTML = rows.map(renderQcRow).join('');
        bindInputs();
      }
    }

    if (meta) {
      meta.hidden = !state.qcRows.length && !state.qcSource;
      meta.textContent = `${state.qcSource || 'Inbound shipments'} | ${bucketLabel} | cached ${state.cachedAt || EM_DASH}`;
    }
    rememberColFilter();
  }

  function updateShipStats(rows) {
    const subtitle = document.getElementById('sol-subtitle');
    const direction = shipDirection();
    const bucketLabel = SHIP_BUCKET_LABELS[state.shipBucket] || state.shipBucket;
    const counts = (direction === 'out' ? state.shipCounts.out : state.shipCounts.in) || {};
    updateShipChipCounts();
    const flow = direction === 'out' ? 'outbound' : 'inbound';
    const total = state.shipRows.length;
    const matched = rows.length !== total;
    if (subtitle) {
      if (state.shipTruncated && !matched) {
        subtitle.textContent = `${rows.length} latest ${bucketLabel} ${flow} shipments shown of ${state.shipTotal}`;
      } else if (matched) {
        subtitle.textContent = `${rows.length} of ${total} ${bucketLabel} ${flow} shipments match`;
      } else {
        subtitle.textContent = `${rows.length} ${bucketLabel} ${flow} shipments shown`;
      }
    }
    const pills = direction === 'out'
      ? [
          { label: 'Shown', value: rows.length },
          { label: 'Outstanding', value: Number(counts.outstanding) || 0 },
          { label: 'History', value: Number(counts.history) || 0 },
          { label: 'Cancelled', value: Number(counts.cancelled) || 0 },
        ]
      : [
          { label: 'Shown', value: rows.length },
          { label: 'Outstanding', value: Number(counts.outstanding) || 0 },
          { label: 'GRN', value: Number(counts.grn) || 0 },
          { label: 'History', value: Number(counts.history) || 0 },
          { label: 'Cancelled', value: Number(counts.cancelled) || 0 },
        ];
    setStatPills(pills);
  }

  function renderShip() {
    const rows = visibleShipRows();
    const body = document.getElementById('sol-table-body');
    const host = document.getElementById('sol-table-host');
    const empty = document.getElementById('sol-empty');
    const loading = document.getElementById('sol-loading');
    const meta = document.getElementById('sol-meta');
    const bucketLabel = SHIP_BUCKET_LABELS[state.shipBucket] || state.shipBucket;

    if (loading) loading.hidden = true;
    ensureTableHead();
    updateShipStats(rows);

    if (!rows.length) {
      const msg = state.shipRows.length
        ? 'No rows match your filters.'
        : `No ${bucketLabel.toLowerCase()} shipments in ERP.`;
      if (body) body.innerHTML = '';
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = msg;
      }
    } else {
      if (host) host.hidden = false;
      if (empty) empty.hidden = true;
      if (body) {
        body.innerHTML = rows.map(renderShipRow).join('');
        bindInputs();
      }
    }

    if (meta) {
      const clipped = state.shipTruncated ? ` | latest ${state.shipRows.length} of ${state.shipTotal}` : '';
      meta.hidden = !state.shipRows.length && !state.shipSource;
      meta.textContent = `${state.shipSource || 'Shipments'} | ${bucketLabel}${clipped} | cached ${state.cachedAt || EM_DASH}`;
    }
    rememberColFilter();
  }

  function render() {
    syncNavUi();
    setChipCount('sol-req-count', state.requests.length);
    updateQcChipCounts();
    updateShipChipCounts();
    if (state.pendingLoad && (
      (state.pendingLoad === 'prpo' && isPrPoView())
      || (state.pendingLoad === 'ps' && isPsView())
      || (state.pendingLoad === 'req' && isRequestView())
      || (state.pendingLoad === 'qc' && isQcView())
      || (state.pendingLoad === 'ship' && isShipView())
    )) {
      return;
    }
    if (isPrPoView()) renderPrPo();
    else if (isRequestView()) renderRequests();
    else if (isQcView()) renderQc();
    else if (isShipView()) renderShip();
    else renderPs();
  }

  function normalizeBucketForView(view, bucket) {
    if (view === 'purchase-order') {
      return bucket === 'hst' || bucket === 'new' ? bucket : 'ost';
    }
    return bucket === 'hst' ? 'hst' : 'ost';
  }

  function viewFamily(view) {
    if (isPrPoView(view)) return 'prpo';
    if (isRequestView(view)) return 'req';
    if (isQcView(view)) return 'qc';
    if ((view || state.view) === SHIP_OUT_VIEW) return 'ship-out';
    if ((view || state.view) === SHIP_IN_VIEW) return 'ship-in';
    return 'ps';
  }

  function clearSearchIfFamilyChanged(nextView) {
    if (viewFamily(state.view) === viewFamily(nextView)) return;
    state.search = '';
    const search = document.getElementById('sol-search');
    if (search) search.value = '';
  }

  function normalizeShipBucket(view, bucket) {
    const allowed = view === SHIP_OUT_VIEW ? OUT_SHIP_BUCKETS : IN_SHIP_BUCKETS;
    return allowed.includes(bucket) ? bucket : 'outstanding';
  }

  function setView(view) {
    const next = PR_PO_VIEWS.has(view) || PS_VIEWS.has(view) || view === REQUEST_VIEW || view === QC_VIEW || SHIP_VIEWS.has(view)
      ? view
      : 'active';
    const nextIsPrPo = isPrPoView(next);
    const nextIsRequest = isRequestView(next);
    const nextIsQc = isQcView(next);
    const nextIsShip = isShipView(next);
    clearSearchIfFamilyChanged(next);
    if (nextIsShip) {
      const nextDir = shipDirection(next);
      if (state.shipFilterDir && state.shipFilterDir !== nextDir) resetShipColumnControls();
      state.shipFilterDir = nextDir;
    }
    closeColFilter();
    state.view = next;
    if (nextIsPrPo) {
      state.prPoBucket = normalizeBucketForView(next, state.prPoBucket);
    }
    if (nextIsShip) {
      state.shipBucket = normalizeShipBucket(next, state.shipBucket);
    }
    syncNavUi();

    if (nextIsPrPo) {
      abortLoad('sales');
      loadPrPo({ refresh: false });
      return;
    }
    if (nextIsRequest) {
      if (!state.requestsLoaded) loadRequests({ refresh: false });
      else render();
      return;
    }
    if (nextIsQc) {
      if (!state.qcLoaded || state.qcLoadedBucket !== state.qcBucket) loadQcChecklist({ refresh: false });
      else render();
      return;
    }
    if (nextIsShip) {
      loadShipments({ refresh: false });
      return;
    }
    if (!state.salesOrdersLoaded) {
      loadSalesOrders({ refresh: false });
      return;
    }
    render();
  }

  function setSection(section) {
    if (!SECTION_DEFAULTS[section]) return;
    if (sectionForView() === section) return;
    if (section === 'logistics-in' || section === 'logistics-out') {
      state.shipBucket = 'outstanding';
    }
    setView(SECTION_DEFAULTS[section]);
  }

  function setBucket(bucket) {
    if (!isPrPoView()) return;
    const next = normalizeBucketForView(state.view, bucket);
    if (next === state.prPoBucket) return;
    state.prPoBucket = next;
    syncNavUi();
    loadPrPo({ refresh: false });
  }

  function setQcBucket(bucket) {
    if (!isQcView()) return;
    const next = bucket === 'awaiting_grn' ? 'awaiting_grn' : 'ready_qc';
    if (next === state.qcBucket) return;
    state.qcBucket = next;
    syncNavUi();
    loadQcChecklist({ refresh: false });
  }

  function psTypeLabel() {
    if (!state.ppTypes.size) return 'None';
    if (state.ppTypes.size === PS_TYPES.length) return 'All';
    const labels = PS_TYPES.filter(t => state.ppTypes.has(t)).map(t => (t === 'SR' ? '[SR]' : t));
    return labels.length <= 3 ? labels.join(', ') : `${labels.length} types`;
  }

  function bindPsTypeDropdown() {
    const btn = document.getElementById('sol-ps-type-btn');
    const panel = document.getElementById('sol-ps-type-panel');
    if (!btn || !panel || panel.dataset.bound === '1') return;
    panel.dataset.bound = '1';

    btn.addEventListener('click', e => {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
    });

    document.addEventListener('click', e => {
      if (!panel.contains(e.target) && e.target !== btn) panel.hidden = true;
    });

    panel.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.addEventListener('change', () => {
        state.ppTypes = new Set(
          [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value),
        );
        btn.textContent = `${psTypeLabel()} v`;
        render();
        renderNotifications();
      });
    });

    btn.textContent = `${psTypeLabel()} v`;
  }

  function setFilterButtonLabel(btnId, selected, allLabel) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (!selected.size) {
      btn.textContent = allLabel;
      return;
    }
    const values = Array.from(selected);
    btn.textContent = values.length <= 2 ? values.join(', ') : `${values.length} selected`;
  }

  function currentSbuOptions() {
    const codes = uniqueTrimmed(state.prPoRows.map(row => row.sbu_code));
    state.selectedSbu.forEach(code => {
      if (code && !codes.includes(code)) codes.push(code);
    });
    if (!codes.includes('MFG')) codes.unshift('MFG');
    codes.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const mfgAt = codes.indexOf('MFG');
    if (mfgAt > 0) {
      codes.splice(mfgAt, 1);
      codes.unshift('MFG');
    }
    return codes;
  }

  function currentSupplierOptions() {
    const names = uniqueTrimmed(state.prPoRows.filter(passesSbuFilter).map(supplierKey));
    state.selectedSuppliers.forEach(name => {
      if (name && !names.includes(name)) names.push(name);
    });
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return names;
  }

  function fillCheckboxPanel(panel, values, selected, { searchable } = {}) {
    if (!panel) return;
    const signature = `${searchable ? 's' : 'n'}:${values.join('\u0001')}`;
    if (panel.dataset.signature === signature) {
      panel.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.checked = selected.has(input.value);
      });
      return;
    }
    const searchWas = panel.querySelector('.sol-filter-panel-search')?.value || '';
    panel.dataset.signature = signature;
    const searchHtml = searchable && values.length > 8
      ? `<input type="search" class="sol-filter-panel-search" placeholder="Find..." autocomplete="off" value="${escapeHtml(searchWas)}">`
      : '';
    panel.innerHTML = searchHtml + values.map(value => {
      const checked = selected.has(value) ? 'checked' : '';
      return `<label class="filter-dropdown-item"><input type="checkbox" value="${escapeHtml(value)}" ${checked} /> ${escapeHtml(value)}</label>`;
    }).join('');
    if (searchWas) filterPanelItems(panel, searchWas);
  }

  function filterPanelItems(panel, query) {
    const q = String(query || '').trim().toLowerCase();
    panel.querySelectorAll('.filter-dropdown-item').forEach(label => {
      label.hidden = Boolean(q) && !label.textContent.toLowerCase().includes(q);
    });
  }

  function fillPrPoFilterPanels() {
    fillCheckboxPanel(
      document.getElementById('sol-sbu-panel'),
      currentSbuOptions(),
      state.selectedSbu,
    );
    fillCheckboxPanel(
      document.getElementById('sol-supplier-panel'),
      currentSupplierOptions(),
      state.selectedSuppliers,
      { searchable: true },
    );
    setFilterButtonLabel('sol-sbu-btn', state.selectedSbu, 'All SBUs');
    setFilterButtonLabel('sol-supplier-btn', state.selectedSuppliers, 'All suppliers');
  }

  function closePrPoFilterPanels(except) {
    document.querySelectorAll('#sol-prpo-toolbar .filter-dropdown-panel').forEach(panel => {
      if (panel !== except) panel.hidden = true;
    });
    document.querySelectorAll('#sol-prpo-toolbar .filter-dropdown-btn').forEach(btn => {
      const panelId = btn.id === 'sol-sbu-btn' ? 'sol-sbu-panel' : 'sol-supplier-panel';
      const panel = document.getElementById(panelId);
      btn.setAttribute('aria-expanded', panel && !panel.hidden ? 'true' : 'false');
    });
  }

  function bindPrPoFilters() {
    const toolbar = document.getElementById('sol-prpo-toolbar');
    if (!toolbar || toolbar.dataset.bound === '1') return;
    toolbar.dataset.bound = '1';

    function bindDropdown(btnId, panelId, onChange) {
      const btn = document.getElementById(btnId);
      const panel = document.getElementById(panelId);
      if (!btn || !panel) return;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const willOpen = panel.hidden;
        closePrPoFilterPanels(willOpen ? panel : null);
        panel.hidden = !willOpen;
        btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      });
      panel.addEventListener('click', e => e.stopPropagation());
      panel.addEventListener('change', e => {
        if (e.target.type !== 'checkbox') return;
        onChange(panel);
      });
      panel.addEventListener('input', e => {
        if (!e.target.classList.contains('sol-filter-panel-search')) return;
        filterPanelItems(panel, e.target.value);
      });
    }

    bindDropdown('sol-sbu-btn', 'sol-sbu-panel', panel => {
      state.selectedSbu = new Set(
        [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value),
      );
      const supplierPanel = document.getElementById('sol-supplier-panel');
      if (supplierPanel) delete supplierPanel.dataset.signature;
      fillPrPoFilterPanels();
      render();
    });

    bindDropdown('sol-supplier-btn', 'sol-supplier-panel', panel => {
      state.selectedSuppliers = new Set(
        [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value),
      );
      setFilterButtonLabel('sol-supplier-btn', state.selectedSuppliers, 'All suppliers');
      render();
    });

    document.addEventListener('click', () => closePrPoFilterPanels());
  }

  function closeColFilter() {
    const panel = document.getElementById('sol-col-filter');
    if (panel) panel.hidden = true;
    state.colFilterKey = '';
    state.colFilterKind = '';
    document.querySelectorAll('.sol-th-filter[aria-expanded="true"]').forEach(btn => {
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  function positionColFilter(anchor) {
    const panel = document.getElementById('sol-col-filter');
    if (!panel || panel.hidden || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    panel.style.top = '0px';
    panel.style.left = '0px';
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 4);
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
  }

  function fillColFilterPanel(col, rows, selected) {
    const list = document.getElementById('sol-col-filter-list');
    const search = document.getElementById('sol-col-filter-search');
    const count = document.getElementById('sol-col-filter-count');
    if (!list) return;
    const options = columnFilterOptions(rows, col, selected);
    const signature = `${state.colFilterKind}:${col.key}:${options.join('\u0001')}`;
    if (list.dataset.signature !== signature) {
      const searchWas = search ? search.value : '';
      list.dataset.signature = signature;
      list.innerHTML = options.length
        ? options.map(value => {
          const checked = selected && selected.has(value) ? ' checked' : '';
          const label = value || BLANK_SUPPLIER;
          return `<label class="filter-dropdown-item"><input type="checkbox" value="${escapeHtml(value)}"${checked}> ${escapeHtml(label)}</label>`;
        }).join('')
        : '<p class="sol-col-filter-empty">No values</p>';
      if (search) {
        search.value = searchWas;
        filterPanelItems(list, searchWas);
      }
    } else {
      list.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.checked = Boolean(selected && selected.has(input.value));
      });
    }
    if (count) count.textContent = selected && selected.size ? `${selected.size} selected` : 'All values';
  }

  function rememberColFilter() {
    if (!state.colFilterKey) return;
    const ctx = activeColumnContext();
    const panel = document.getElementById('sol-col-filter');
    if (!ctx || ctx.kind !== state.colFilterKind || !panel) {
      closeColFilter();
      return;
    }
    const col = ctx.columns.find(item => item.key === state.colFilterKey);
    const safeKey = window.CSS && CSS.escape ? CSS.escape(state.colFilterKey) : state.colFilterKey;
    const btn = document.querySelector(`.sol-th-filter[data-col-filter="${safeKey}"]`);
    if (!col || !btn) {
      closeColFilter();
      return;
    }
    panel.hidden = false;
    fillColFilterPanel(col, ctx.rows, ctx.filters[col.key]);
    btn.setAttribute('aria-expanded', 'true');
    positionColFilter(btn);
  }

  function toggleColFilter(btn) {
    const key = btn.getAttribute('data-col-filter') || '';
    const ctx = activeColumnContext();
    if (!ctx || !key) return;
    if (state.colFilterKey === key && state.colFilterKind === ctx.kind) {
      closeColFilter();
      return;
    }
    const col = ctx.columns.find(item => item.key === key);
    const panel = document.getElementById('sol-col-filter');
    const list = document.getElementById('sol-col-filter-list');
    const search = document.getElementById('sol-col-filter-search');
    if (!col || !panel) return;
    state.colFilterKey = key;
    state.colFilterKind = ctx.kind;
    if (list) delete list.dataset.signature;
    if (search) search.value = '';
    panel.hidden = false;
    fillColFilterPanel(col, ctx.rows, ctx.filters[key]);
    document.querySelectorAll('.sol-th-filter[aria-expanded="true"]').forEach(el => {
      if (el !== btn) el.setAttribute('aria-expanded', 'false');
    });
    btn.setAttribute('aria-expanded', 'true');
    positionColFilter(btn);
    if (search) search.focus();
  }

  function ensureColFilterDom() {
    if (!document.getElementById('sol-col-filter')) {
      const panel = document.createElement('div');
      panel.id = 'sol-col-filter';
      panel.className = 'sol-col-filter';
      panel.hidden = true;
      panel.innerHTML = `
        <div class="sol-col-filter-head">
          <span id="sol-col-filter-count">All values</span>
          <button type="button" id="sol-col-filter-clear">Clear</button>
        </div>
        <input type="search" id="sol-col-filter-search" class="sol-col-filter-search" placeholder="Find a value..." autocomplete="off" aria-label="Find a filter value">
        <div id="sol-col-filter-list" class="sol-col-filter-list"></div>`;
      document.body.appendChild(panel);
    }
    if (!document.getElementById('sol-clear-col-filters')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'sol-clear-col-filters';
      btn.className = 'sol-btn sol-btn--ghost sol-clear-filters';
      btn.hidden = true;
      btn.textContent = 'Clear filters';
      const search = document.querySelector('.sol-nav .sol-search-wrap');
      if (search && search.parentElement) search.parentElement.insertBefore(btn, search);
      else document.querySelector('.sol-nav')?.appendChild(btn);
    }
  }

  function bindColFilter() {
    ensureColFilterDom();
    const panel = document.getElementById('sol-col-filter');
    if (!panel || panel.dataset.bound === '1') return;
    panel.dataset.bound = '1';
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.addEventListener('click', e => e.stopPropagation());
    panel.addEventListener('change', e => {
      if (e.target.type !== 'checkbox') return;
      const selected = new Set(
        [...panel.querySelectorAll('#sol-col-filter-list input[type="checkbox"]:checked')].map(el => el.value),
      );
      setColumnFilter(state.colFilterKind, state.colFilterKey, selected);
    });
    document.getElementById('sol-col-filter-search')?.addEventListener('input', e => {
      filterPanelItems(document.getElementById('sol-col-filter-list'), e.target.value);
    });
    document.getElementById('sol-col-filter-clear')?.addEventListener('click', () => {
      setColumnFilter(state.colFilterKind, state.colFilterKey, new Set());
    });
    document.getElementById('sol-clear-col-filters')?.addEventListener('click', () => {
      clearActiveColumnFilters();
    });
    document.addEventListener('click', e => {
      if (panel.contains(e.target) || e.target.closest('.sol-th-filter')) return;
      closeColFilter();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeColFilter();
    });
    document.querySelector('.sol-table-scroll')?.addEventListener('scroll', closeColFilter, { passive: true });
    window.addEventListener('resize', closeColFilter);
  }

  function bindPrPoSort() {
    const head = document.getElementById('sol-table-head');
    if (!head || head.dataset.sortBound === '1') return;
    head.dataset.sortBound = '1';
    head.addEventListener('click', e => {
      const filterBtn = e.target.closest('[data-col-filter]');
      if (filterBtn) {
        e.preventDefault();
        e.stopPropagation();
        toggleColFilter(filterBtn);
        return;
      }
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      const key = th.getAttribute('data-sort');
      if (isPrPoView()) {
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortKey = key;
          const col = PR_PO_COLUMNS.find(c => c.key === key);
          state.sortDir = col && (col.type === 'date' || col.type === 'num') ? 'desc' : 'asc';
        }
        render();
        return;
      }
      if (isShipView()) {
        toggleColumnSort('ship', key);
        render();
        return;
      }
      if (isQcView()) {
        toggleColumnSort('qc', key);
        render();
      }
    });
  }

  function bindMaterialButtons() {
    const host = document.getElementById('sol-table-host');
    if (!host || host.dataset.materialBound === '1') return;
    host.dataset.materialBound = '1';

    host.addEventListener('click', e => {
      const btn = e.target.closest('[data-action="open-material"]');
      if (!btn) return;
      e.stopPropagation();
      if (typeof window.openMaterialModal !== 'function') return;
      window.openMaterialModal({
        partNo: btn.getAttribute('data-part-no'),
        bomCode: btn.getAttribute('data-bom-code'),
        processSheetNo: btn.getAttribute('data-process-sheet'),
      });
    });
  }

  function bindInputs() {
    const body = document.getElementById('sol-table-body');
    if (!body || body.dataset.bound === '1') return;
    body.dataset.bound = '1';

    body.addEventListener('click', e => {
      const deleteBtn = e.target.closest('[data-action="delete-request"]');
      if (deleteBtn) {
        e.stopPropagation();
        deleteRequestRow(deleteBtn);
        return;
      }
      const historyBtn = e.target.closest('[data-action="open-date-history"]');
      if (historyBtn) {
        e.stopPropagation();
        if (historyBtn.disabled) return;
        openDateHistoryModal(
          String(historyBtn.dataset.ppVoucherNo || '').trim(),
          String(historyBtn.dataset.field || '').trim(),
        );
        return;
      }
      const btn = e.target.closest('[data-action="toggle-subcon-arrived"]');
      if (!btn) return;
      e.stopPropagation();
      const cell = btn.closest('.so-material-subcon-cell');
      if (!cell) return;
      const parsed = parseMaterialSubcon(cell.dataset.lastSaved);
      const nextArrived = !parsed.arrived;
      const dateInput = cell.querySelector('.so-material-subcon-date');
      const date = isoDateValue(dateInput?.value);
      applyMaterialCellState(cell, { arrived: nextArrived, date: nextArrived ? '' : date });
      btn.classList.toggle('is-active', nextArrived);
      btn.setAttribute('aria-pressed', nextArrived ? 'true' : 'false');
      btn.title = nextArrived ? 'Material arrived - click to clear' : 'Mark material as arrived';
      saveMaterialCell(cell, serializeMaterialSubcon({ arrived: nextArrived, date: nextArrived ? '' : date }));
    });

    body.addEventListener('change', e => {
      const delayInput = e.target.closest('.sol-delay-input');
      if (delayInput) {
        e.stopPropagation();
        saveDelayFlag(delayInput);
        return;
      }
      const needDateInput = e.target.closest('.sol-need-date-input');
      if (needDateInput) {
        e.stopPropagation();
        saveNotesField(needDateInput);
        return;
      }
      const dateInput = e.target.closest('.so-material-subcon-date');
      if (!dateInput || dateInput.disabled) return;
      e.stopPropagation();
      const cell = dateInput.closest('.so-material-subcon-cell');
      if (!cell) return;
      const date = isoDateValue(dateInput.value);
      applyMaterialCellState(cell, { arrived: false, date });
      saveMaterialCell(cell, serializeMaterialSubcon({ arrived: false, date }));
    });

    body.addEventListener('click', e => {
      const flag = e.target.closest('.sol-delay-flag');
      if (!flag) return;
      e.stopPropagation();
    });

    body.addEventListener('blur', e => {
      const textarea = e.target.closest('.so-editable-input');
      if (textarea) {
        saveNotesField(textarea);
        return;
      }
      const needDateInput = e.target.closest('.sol-need-date-input');
      if (needDateInput) {
        saveNotesField(needDateInput);
        return;
      }
      const dateInput = e.target.closest('.so-material-subcon-date');
      if (dateInput && !dateInput.disabled) {
        const cell = dateInput.closest('.so-material-subcon-cell');
        if (!cell) return;
        const date = isoDateValue(dateInput.value);
        applyMaterialCellState(cell, { arrived: false, date });
        saveMaterialCell(cell, serializeMaterialSubcon({ arrived: false, date }));
        return;
      }
      const qtyInput = e.target.closest('.sol-qty-cell-input');
      if (qtyInput) saveNotesField(qtyInput);
    }, true);
  }

  function abortLoad(kind) {
    const ac = state.loadControllers[kind];
    if (!ac) return;
    state.loadControllers[kind] = null;
    try { ac.abort(); } catch (_) { /* ignore */ }
  }

  function beginViewLoad(kind, label) {
    state.pendingLoad = kind;
    const loading = document.getElementById('sol-loading');
    const labelEl = document.getElementById('sol-loading-label');
    const host = document.getElementById('sol-table-host');
    const empty = document.getElementById('sol-empty');
    const subtitle = document.getElementById('sol-subtitle');
    const meta = document.getElementById('sol-meta');
    if (loading) loading.hidden = false;
    if (labelEl) labelEl.textContent = label;
    if (host) host.hidden = true;
    if (empty) {
      empty.hidden = true;
      empty.textContent = '';
    }
    if (meta) meta.hidden = true;
    if (subtitle) subtitle.textContent = label;
  }

  function showLoadError(err) {
    state.pendingLoad = '';
    const loading = document.getElementById('sol-loading');
    const subtitle = document.getElementById('sol-subtitle');
    const empty = document.getElementById('sol-empty');
    const host = document.getElementById('sol-table-host');
    if (loading) loading.hidden = true;
    if (host) host.hidden = true;
    if (subtitle) subtitle.textContent = 'Failed to load';
    if (empty) {
      empty.hidden = false;
      empty.textContent = `Failed to load: ${err.message}`;
    }
  }

  function indexAssemblyJobs(items) {
    const map = new Map();
    (items || []).forEach(item => {
      const psId = psBaseKey(item?.ps_id);
      if (psId) map.set(psId, item);
      const part = partKeyOf(item?.part_no);
      if (part && !map.has(`part:${part}`)) map.set(`part:${part}`, item);
    });
    return map;
  }

  async function loadAssemblyJobs({ refresh = false } = {}) {
    try {
      const params = new URLSearchParams();
      if (refresh) params.set('refresh', '1');
      const qs = params.toString();
      const res = await fetch(`/api/material-tracking/sr-assemblies${qs ? `?${qs}` : ''}`, {
        cache: refresh ? 'no-store' : 'default',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) return;
      state.assemblyJobs = indexAssemblyJobs(payload.items);
      if (isPsView()) render();
    } catch (_err) {
      state.assemblyJobs = state.assemblyJobs || new Map();
    }
  }

  async function loadSalesOrders({ refresh = false } = {}) {
    abortLoad('sales');
    const baseLabel = refresh
      ? 'Refreshing from ERP...'
      : 'Loading process sheets from ERP...';
    if (isPsView()) beginViewLoad('ps', baseLabel);

    const params = new URLSearchParams({ active_only: '1' });
    if (refresh) params.set('refresh', '1');

    const ac = new AbortController();
    state.loadControllers.sales = ac;
    const timeoutMs = refresh ? 180000 : 120000;
    const timeoutId = window.setTimeout(() => ac.abort(), timeoutMs);
    const subtitle = document.getElementById('sol-subtitle');
    let elapsed = 0;
    const tickId = window.setInterval(() => {
      elapsed += 1;
      if (isPsView() && subtitle) subtitle.textContent = `${baseLabel} ${elapsed}s`;
    }, 1000);

    try {
      const res = await fetch(`/api/sales-orders?${params}`, {
        cache: refresh ? 'no-store' : 'default',
        signal: ac.signal,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      state.active = Array.isArray(payload.active) ? payload.active : [];
      state.cachedAt = payload.cached_at || '';
      state.ppCount = Number(payload.active_job_count || payload.pp_count) || 0;
      state.partialCount = Number(payload.partial_count) || 0;
      state.salesOrdersLoaded = true;
      if (state.pendingLoad === 'ps') state.pendingLoad = '';
      if (isPsView()) render();
      loadAssemblyJobs({ refresh });
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (state.loadControllers.sales === ac && isPsView()) {
          showLoadError(new Error('Timed out waiting for ERP. Click Refresh to retry.'));
        }
        return false;
      }
      if (isPsView()) showLoadError(err);
      return false;
    } finally {
      if (state.loadControllers.sales === ac) state.loadControllers.sales = null;
      window.clearTimeout(timeoutId);
      window.clearInterval(tickId);
    }
  }

  async function loadPrPo({ refresh = false } = {}) {
    const scope = scopeForView();
    const bucket = state.prPoBucket;
    const bucketLabel = BUCKET_LABELS[bucket] || bucket;
    const key = `${scope}:${bucket}`;

    if (!refresh && state.prPoKey === key) {
      state.pendingLoad = '';
      if (isPrPoView()) render();
      return;
    }

    abortLoad('prpo');
    const label = refresh
      ? `Refreshing ${bucketLabel} from ERP...`
      : `Loading ${bucketLabel}...`;
    if (isPrPoView()) beginViewLoad('prpo', label);

    const params = new URLSearchParams({ scope, bucket });
    if (refresh) params.set('refresh', '1');

    const ac = new AbortController();
    state.loadControllers.prpo = ac;
    const timeoutId = window.setTimeout(() => ac.abort(), 90000);

    try {
      const res = await fetch(`/api/material-tracking/pr-po?${params}`, {
        cache: refresh ? 'no-store' : 'default',
        signal: ac.signal,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      state.prPoRows = Array.isArray(payload.rows) ? payload.rows : [];
      state.prPoCounts = payload.counts || { pr: {}, po: {} };
      state.prPoSource = payload.source || '';
      state.cachedAt = payload.cached_at || '';
      state.prPoKey = key;
      if (state.pendingLoad === 'prpo') state.pendingLoad = '';
      fillPrPoFilterPanels();
      if (isPrPoView()) render();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (state.loadControllers.prpo === ac && isPrPoView()) {
          showLoadError(new Error('Timed out waiting for ERP. Click Refresh to retry.'));
        }
        return;
      }
      if (isPrPoView()) showLoadError(err);
    } finally {
      if (state.loadControllers.prpo === ac) state.loadControllers.prpo = null;
      window.clearTimeout(timeoutId);
    }
  }

  async function loadRequests({ refresh = false, silent = false } = {}) {
    const showUi = isRequestView() && !silent;
    if (showUi) {
      beginViewLoad('req', refresh ? 'Refreshing part requests...' : 'Loading part requests...');
    }
    try {
      const data = await requestJson('/api/material-tracking/requests');
      state.requests = Array.isArray(data.rows) ? data.rows : [];
      state.requestsLoaded = true;
      setChipCount('sol-req-count', state.requests.length);
      if (state.pendingLoad === 'req') state.pendingLoad = '';
      if (isRequestView()) render();
    } catch (err) {
      if (showUi) showLoadError(err);
    }
  }

  async function loadQcChecklist({ refresh = false, silent = false } = {}) {
    const showUi = isQcView() && !silent;
    const bucketLabel = QC_BUCKET_LABELS[state.qcBucket] || state.qcBucket;
    if (showUi) {
      beginViewLoad(
        'qc',
        refresh
          ? `Refreshing ${bucketLabel} from ERP...`
          : `Loading ${bucketLabel}...`,
      );
    }

    abortLoad('qc');
    const params = new URLSearchParams({ bucket: state.qcBucket });
    if (refresh) params.set('refresh', '1');
    const ac = new AbortController();
    state.loadControllers.qc = ac;

    try {
      const res = await fetch(`/api/material-tracking/qc-checklist?${params}`, {
        cache: refresh ? 'no-store' : 'default',
        signal: ac.signal,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      state.qcRows = Array.isArray(payload.rows) ? payload.rows : [];
      state.qcCounts = payload.counts || { ready_qc: 0, awaiting_grn: 0 };
      state.qcSource = payload.source || '';
      state.cachedAt = payload.cached_at || state.cachedAt;
      state.qcLoaded = true;
      state.qcLoadedBucket = state.qcBucket;
      if (state.pendingLoad === 'qc') state.pendingLoad = '';
      updateQcChipCounts();
      if (isQcView()) render();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (showUi) showLoadError(err);
    } finally {
      if (state.loadControllers.qc === ac) state.loadControllers.qc = null;
    }
  }

  function shipCacheKey() {
    return `${shipDirection()}|${state.shipBucket}`;
  }

  function applyShipPayload(payload) {
    const direction = payload.direction || shipDirection();
    state.shipRows = Array.isArray(payload.rows) ? payload.rows : [];
    state.shipCounts[direction] = payload.counts || {};
    state.shipSource = payload.source || '';
    state.shipTotal = Number(payload.total) || state.shipRows.length;
    state.shipTruncated = Boolean(payload.truncated);
    state.cachedAt = payload.cached_at || state.cachedAt;
    state.shipCache[shipCacheKey()] = {
      rows: state.shipRows,
      counts: state.shipCounts[direction],
      source: state.shipSource,
      total: state.shipTotal,
      truncated: state.shipTruncated,
      cachedAt: state.cachedAt,
    };
  }

  async function loadShipments({ refresh = false } = {}) {
    if (!isShipView()) return;
    const key = shipCacheKey();
    const cached = state.shipCache[key];
    if (!refresh && cached) {
      state.shipRows = cached.rows;
      state.shipCounts[shipDirection()] = cached.counts || {};
      state.shipSource = cached.source || '';
      state.shipTotal = cached.total || 0;
      state.shipTruncated = Boolean(cached.truncated);
      state.cachedAt = cached.cachedAt || state.cachedAt;
      if (state.pendingLoad === 'ship') state.pendingLoad = '';
      render();
      return;
    }

    const bucketLabel = SHIP_BUCKET_LABELS[state.shipBucket] || state.shipBucket;
    const flow = shipDirection() === 'out' ? 'outbound' : 'inbound';
    beginViewLoad(
      'ship',
      refresh ? `Refreshing ${bucketLabel} ${flow} shipments...` : `Loading ${bucketLabel} ${flow} shipments...`,
    );
    abortLoad('ship');
    const params = new URLSearchParams({
      direction: shipDirection(),
      bucket: state.shipBucket,
    });
    if (refresh) params.set('refresh', '1');
    const ac = new AbortController();
    state.loadControllers.ship = ac;
    const timeoutId = window.setTimeout(() => ac.abort(), 90000);
    try {
      const res = await fetch(`/api/material-tracking/shipments?${params}`, {
        cache: refresh ? 'no-store' : 'default',
        signal: ac.signal,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      if (state.loadControllers.ship !== ac) return;
      const responseKey = `${payload.direction}|${payload.bucket}`;
      if (!isShipView() || shipCacheKey() !== responseKey) {
        state.shipCache[responseKey] = {
          rows: Array.isArray(payload.rows) ? payload.rows : [],
          counts: payload.counts || {},
          source: payload.source || '',
          total: Number(payload.total) || 0,
          truncated: Boolean(payload.truncated),
          cachedAt: payload.cached_at || '',
        };
        if (payload.direction) state.shipCounts[payload.direction] = payload.counts || {};
        updateShipChipCounts();
        return;
      }
      applyShipPayload(payload);
      if (state.pendingLoad === 'ship') state.pendingLoad = '';
      render();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (state.loadControllers.ship === ac && isShipView()) {
          showLoadError(new Error('Timed out waiting for ERP. Click Refresh to retry.'));
        }
        return;
      }
      if (isShipView()) showLoadError(err);
    } finally {
      if (state.loadControllers.ship === ac) state.loadControllers.ship = null;
      window.clearTimeout(timeoutId);
    }
  }

  async function load({ refresh = false } = {}) {
    if (isPrPoView()) {
      await loadPrPo({ refresh });
      return;
    }
    if (isRequestView()) {
      await loadRequests({ refresh });
      return;
    }
    if (isQcView()) {
      await loadQcChecklist({ refresh });
      return;
    }
    if (isShipView()) {
      if (refresh) state.shipCache = {};
      await loadShipments({ refresh });
      return;
    }
    await loadSalesOrders({ refresh });
  }

  function setAddStatus(status, message) {
    const el = document.getElementById('sol-add-status');
    if (!el) return;
    el.className = `sol-add-status${status ? ` is-${status}` : ''}`;
    el.textContent = message || '';
  }

  function closeTypeahead(field) {
    const box = state.addSearch[field];
    if (!box) return;
    box.open = false;
    box.activeIndex = -1;
    const wrap = document.querySelector(`.sol-typeahead[data-sol-field="${field}"]`);
    const input = wrap?.querySelector('input');
    const list = wrap?.querySelector('.sol-typeahead-results');
    if (list) list.hidden = true;
    if (input) input.setAttribute('aria-expanded', 'false');
  }

  function closeAllTypeaheads() {
    closeTypeahead('part_no');
    closeTypeahead('inventory_code');
  }

  function renderTypeahead(field) {
    const box = state.addSearch[field];
    const wrap = document.querySelector(`.sol-typeahead[data-sol-field="${field}"]`);
    const input = wrap?.querySelector('input');
    const list = wrap?.querySelector('.sol-typeahead-results');
    if (!box || !list || !input) return;
    if (!box.open) {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      return;
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (box.loading) {
      list.innerHTML = '<div class="sol-typeahead-status">Searching...</div>';
      return;
    }
    if (!box.hits.length) {
      list.innerHTML = '<div class="sol-typeahead-status">No matching part / inventory code. You can still add the typed value.</div>';
      return;
    }
    list.innerHTML = box.hits.map((hit, index) => {
      const active = index === box.activeIndex ? ' is-active' : '';
      const desc = hit.description
        ? `<span class="sol-typeahead-desc">${escapeHtml(hit.description)}</span>`
        : '';
      const code = hit.inventory_code || hit.part_no || '';
      return `
        <button type="button" class="sol-typeahead-item${active}" role="option" data-index="${index}">
          <span class="sol-typeahead-code">${escapeHtml(code)}</span>
          ${desc}
        </button>`;
    }).join('');
  }

  function applyTypeaheadHit(field, hit) {
    const code = String(hit?.inventory_code || hit?.part_no || '').trim();
    if (!code) return;
    const wrap = document.querySelector(`.sol-typeahead[data-sol-field="${field}"]`);
    const input = wrap?.querySelector('input');
    if (input) input.value = code;
    const otherField = field === 'part_no' ? 'inventory_code' : 'part_no';
    const otherInput = document.querySelector(`.sol-typeahead[data-sol-field="${otherField}"] input`);
    if (otherInput && !String(otherInput.value || '').trim()) {
      otherInput.value = code;
    }
    closeTypeahead(field);
  }

  async function runTypeaheadSearch(field, query) {
    const box = state.addSearch[field];
    if (!box) return;
    const needle = String(query || '').trim();
    if (needle.length < 2) {
      box.hits = [];
      box.loading = false;
      box.open = Boolean(needle);
      renderTypeahead(field);
      return;
    }
    box.loading = true;
    box.open = true;
    renderTypeahead(field);
    try {
      const data = await requestJson(
        `/api/material-tracking/requests/search?q=${encodeURIComponent(needle)}&limit=20`,
      );
      if (String(document.querySelector(`.sol-typeahead[data-sol-field="${field}"] input`)?.value || '').trim() !== needle) {
        return;
      }
      box.hits = Array.isArray(data.rows) ? data.rows : [];
      box.activeIndex = box.hits.length ? 0 : -1;
    } catch (err) {
      box.hits = [];
      setAddStatus('error', err.message || 'Search failed');
    } finally {
      box.loading = false;
      renderTypeahead(field);
    }
  }

  function bindTypeahead(field) {
    const wrap = document.querySelector(`.sol-typeahead[data-sol-field="${field}"]`);
    const input = wrap?.querySelector('input');
    const list = wrap?.querySelector('.sol-typeahead-results');
    const box = state.addSearch[field];
    if (!wrap || !input || !list || !box || wrap.dataset.bound === '1') return;
    wrap.dataset.bound = '1';

    input.addEventListener('input', () => {
      window.clearTimeout(box.timer);
      box.timer = window.setTimeout(() => runTypeaheadSearch(field, input.value), 220);
    });

    input.addEventListener('focus', () => {
      if (String(input.value || '').trim().length >= 2) {
        box.open = true;
        renderTypeahead(field);
      }
    });

    input.addEventListener('keydown', e => {
      if (!box.open) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        box.activeIndex = Math.min(box.hits.length - 1, box.activeIndex + 1);
        renderTypeahead(field);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        box.activeIndex = Math.max(0, box.activeIndex - 1);
        renderTypeahead(field);
      } else if (e.key === 'Enter') {
        if (box.activeIndex >= 0 && box.hits[box.activeIndex]) {
          e.preventDefault();
          applyTypeaheadHit(field, box.hits[box.activeIndex]);
        }
      } else if (e.key === 'Escape') {
        closeTypeahead(field);
      }
    });

    list.addEventListener('mousedown', e => {
      const btn = e.target.closest('.sol-typeahead-item');
      if (!btn) return;
      e.preventDefault();
      const hit = box.hits[Number(btn.dataset.index)];
      if (hit) applyTypeaheadHit(field, hit);
    });
  }

  async function addRequest() {
    const partNo = String(document.getElementById('sol-req-part')?.value || '').trim();
    const inventoryCode = String(document.getElementById('sol-req-inv')?.value || '').trim();
    const qty = String(document.getElementById('sol-req-qty')?.value || '').trim();
    const btn = document.getElementById('sol-req-add');
    if (!partNo && !inventoryCode) {
      setAddStatus('error', 'Enter a part no or inventory code.');
      return;
    }
    if (btn) btn.disabled = true;
    setAddStatus('', 'Adding...');
    try {
      const data = await requestJson('/api/material-tracking/requests', {
        method: 'POST',
        body: {
          part_no: partNo,
          inventory_code: inventoryCode,
          qty: qty || null,
        },
      });
      const row = data.row;
      if (row) state.requests.unshift(row);
      state.requestsLoaded = true;
      document.getElementById('sol-req-part').value = '';
      document.getElementById('sol-req-inv').value = '';
      document.getElementById('sol-req-qty').value = '';
      closeAllTypeaheads();
      setAddStatus('saved', 'Request added.');
      window.setTimeout(() => setAddStatus('', ''), 1600);
      render();
    } catch (err) {
      setAddStatus('error', err.message || 'Add failed');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function deleteRequestRow(btn) {
    const requestId = requestIdOf(btn);
    if (!requestId) return;
    const found = findRequest(requestId);
    const label = found?.part_no || found?.inventory_code || `#${requestId}`;
    if (!window.confirm(`Remove request for ${label}?`)) return;
    btn.disabled = true;
    try {
      await requestJson(`/api/material-tracking/requests/${requestId}`, { method: 'DELETE' });
      state.requests = state.requests.filter(row => Number(row.request_id) !== requestId);
      render();
    } catch (err) {
      btn.disabled = false;
      window.alert(err.message || 'Remove failed');
    }
  }

  function bindRequestAdd() {
    const addBtn = document.getElementById('sol-req-add');
    if (addBtn && addBtn.dataset.bound !== '1') {
      addBtn.dataset.bound = '1';
      addBtn.addEventListener('click', () => addRequest());
    }
    bindTypeahead('part_no');
    bindTypeahead('inventory_code');
    const qtyInput = document.getElementById('sol-req-qty');
    if (qtyInput && qtyInput.dataset.bound !== '1') {
      qtyInput.dataset.bound = '1';
      qtyInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addRequest();
        }
      });
    }
    document.addEventListener('click', e => {
      if (e.target.closest('.sol-typeahead')) return;
      closeAllTypeaheads();
    });
  }

  function notifToMs(value) {
    if (!value) return 0;
    const t = Date.parse(String(value).replace(' ', 'T'));
    return Number.isFinite(t) ? t : 0;
  }

  function notifFmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
    let rel;
    if (diffMin < 1) rel = 'just now';
    else if (diffMin < 60) rel = `${diffMin} min ago`;
    else if (diffMin < 1440) rel = `${Math.round(diffMin / 60)} hr ago`;
    else rel = `${Math.round(diffMin / 1440)} d ago`;
    const abs = d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `${rel} · ${abs}`;
  }

  function psTypeFromId(ps) {
    const raw = String(ps || '').split('::')[0];
    if (/\[sr\]/i.test(raw)) return 'SR';
    const match = raw.toUpperCase().match(/^([A-Z]+)/);
    return match ? match[1] : null;
  }

  function readLastSeenSoTime() {
    try {
      return Number(localStorage.getItem('notif-last-seen-so-time') || 0) || 0;
    } catch {
      return 0;
    }
  }

  function writeLastSeenSoTime(value) {
    try {
      localStorage.setItem('notif-last-seen-so-time', String(Number(value) || 0));
    } catch {
      /* ignore quota / private mode */
    }
  }

  function visibleNotifParts(order) {
    return (order.parts || []).filter(part => {
      const type = part.type || psTypeFromId(part.ps);
      if (!type) return true;
      if (!state.ppTypes.size || state.ppTypes.size === PS_TYPES.length) return true;
      return state.ppTypes.has(type);
    });
  }

  function trackerHasOrder(so, ps) {
    const soKey = String(so || '').trim().toUpperCase();
    const psKey = psBaseKey(ps);
    return state.active.some(order => {
      if (soKey && String(order.sales_order_no || '').trim().toUpperCase() !== soKey) return false;
      if (!psKey) return true;
      return leafRows(order).some(leaf => psBaseKey(psDisplayForPartial(leaf.pp, leaf.partial)) === psKey);
    });
  }

  function applyRowFocus() {
    const focus = state.rowFocus;
    document.querySelectorAll('#sol-table-body tr.is-focus').forEach(row => {
      row.classList.remove('is-focus');
    });
    if (!focus || !isPsView()) return;
    const soKey = String(focus.so || '').trim().toUpperCase();
    const psKey = psBaseKey(focus.ps);
    const rows = [...document.querySelectorAll('#sol-table-body tr[data-sol-so]')];
    const match = rows.find(row => {
      const rowSo = String(row.getAttribute('data-sol-so') || '').toUpperCase();
      const rowPs = String(row.getAttribute('data-sol-ps') || '').toUpperCase();
      if (psKey && rowPs === psKey) return true;
      return Boolean(soKey) && rowSo === soKey;
    }) || rows[0];
    if (!match) return;
    match.classList.add('is-focus');
    match.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function enablePsType(type) {
    if (!type || !PS_TYPES.includes(type) || state.ppTypes.has(type)) return;
    state.ppTypes.add(type);
    const panel = document.getElementById('sol-ps-type-panel');
    panel?.querySelectorAll('input[type="checkbox"]').forEach(input => {
      if (input.value === type) input.checked = true;
    });
    const btn = document.getElementById('sol-ps-type-btn');
    if (btn) btn.textContent = `${psTypeLabel()} v`;
  }

  function closeNotifPanel() {
    const panel = document.getElementById('sol-notif-panel');
    const btn = document.getElementById('sol-notif-btn');
    if (panel) panel.hidden = true;
    btn?.setAttribute('aria-expanded', 'false');
  }

  async function focusTrackerItem({ so, ps, type } = {}) {
    closeNotifPanel();
    enablePsType(type);
    const soKey = String(so || '').trim().toUpperCase();
    const order = state.newOrders.find(item => String(item.so || '').trim().toUpperCase() === soKey);
    (order?.parts || []).forEach(part => {
      enablePsType(part.type || psTypeFromId(part.ps));
    });
    if (state.view !== 'active') {
      state.view = 'active';
      syncNavUi();
    }
    state.materialFilter = 'all';
    const material = document.getElementById('sol-material-filter');
    if (material) material.value = 'all';
    const needle = String(ps || so || '').trim();
    state.search = needle;
    const search = document.getElementById('sol-search');
    if (search) search.value = needle;
    state.rowFocus = { so: String(so || '').trim().toUpperCase(), ps: psBaseKey(ps) };

    if (!state.salesOrdersLoaded) {
      await loadSalesOrders({ refresh: false });
    } else {
      render();
    }

    if (!trackerHasOrder(so, ps)) {
      await loadSalesOrders({ refresh: true });
    }
    applyRowFocus();

    if (!trackerHasOrder(so, ps)) {
      const subtitle = document.getElementById('sol-subtitle');
      if (subtitle) {
        subtitle.textContent = `${needle} is posted in ERP but not in this tracker yet. It appears once a PP voucher exists — click Refresh after PP is raised.`;
      }
    }
  }

  function renderNotifications() {
    const list = document.getElementById('sol-notif-list');
    const empty = document.getElementById('sol-notif-empty');
    const badge = document.getElementById('sol-notif-badge');
    const sub = document.getElementById('sol-notif-sub');
    if (!list || !badge) return;

    const lastSeen = readLastSeenSoTime();
    const items = [];
    const unreadKeys = new Set();
    let unread = 0;
    let maxSoTime = 0;

    state.newOrders.forEach(order => {
      const parts = visibleNotifParts(order);
      if (!parts.length) return;
      const postedAt = order.postedAt || order.latestPostedAt || order.firstPostedAt;
      const ms = notifToMs(postedAt);
      maxSoTime = Math.max(maxSoTime, ms);
      const isUnread = ms > 0 && ms > lastSeen;
      const soKey = String(order.so || '').trim().toUpperCase();
      if (isUnread && soKey) {
        unread += 1;
        unreadKeys.add(soKey);
      }
      const isUpdated = String(order.kind || '').toLowerCase() === 'updated';
      const hasNewPs = parts.some(part => {
        const psType = part.type || psTypeFromId(part.ps);
        return psType === 'NPS' || psType === 'APS' || !psType;
      });
      const soTag = isUpdated ? 'Updated sales order' : 'New sales order';
      const tagCls = isUpdated ? 'sol-notif-tag sol-notif-tag--updated' : 'sol-notif-tag';
      const tagsHtml = `
        <span class="${tagCls}">${escapeHtml(soTag)}</span>
        ${hasNewPs ? '<span class="sol-notif-tag">New process sheet</span>' : ''}`;
      const shown = parts.slice(0, 4);
      const extra = parts.length - shown.length;
      const partsHtml = shown.map(part => {
        const detail = [part.part, part.desc].filter(Boolean).join(' · ');
        const psType = part.type || psTypeFromId(part.ps);
        const psLabel = psType ? `${psType} ${part.ps || ''}`.trim() : (part.ps || '—');
        return `
          <li>
            <button type="button" class="sol-notif-part" data-sol-focus-so="${escapeHtml(order.so || '')}" data-sol-focus-ps="${escapeHtml(part.ps || '')}" data-sol-focus-type="${escapeHtml(psType || '')}">
              <span class="sol-notif-part-ps">${escapeHtml(psLabel || 'New process sheet')}</span>
              ${detail ? `<span class="sol-notif-part-no">${escapeHtml(detail)}</span>` : ''}
            </button>
          </li>`;
      }).join('');
      items.push(`
        <article class="sol-notif-card${isUnread ? ' is-unread' : ''}${isUpdated ? ' is-updated' : ''}" data-sol-focus-so="${escapeHtml(order.so || '')}">
          ${tagsHtml}
          <p class="sol-notif-so">${escapeHtml(order.so || '—')}</p>
          ${order.customer ? `<p class="sol-notif-customer">from ${escapeHtml(order.customer)}</p>` : ''}
          <ul class="sol-notif-parts">${partsHtml}</ul>
          ${extra > 0 ? `<p class="sol-notif-part-more">+${extra} more process sheets</p>` : ''}
          <p class="sol-notif-time">${escapeHtml(notifFmtTime(postedAt))}</p>
        </article>`);
    });

    const unreadChanged = unreadKeys.size !== state.unreadSoKeys.size
      || [...unreadKeys].some(key => !state.unreadSoKeys.has(key));
    state.unreadSoKeys = unreadKeys;
    state.maxNotifSoTime = maxSoTime;

    if (!items.length) {
      list.innerHTML = '';
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'No new sales orders this week.';
        list.appendChild(empty);
      }
    } else {
      list.innerHTML = items.join('');
    }

    if (sub) {
      sub.textContent = items.length
        ? 'This week’s posted sales orders and process sheets. Click a card to jump to the tracker row.'
        : 'No new APS/NPS sales orders posted this week.';
    }

    if (unread > 0) {
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }

    if (unreadChanged && isPsView() && state.salesOrdersLoaded && !state.pendingLoad) {
      renderPs();
    }
  }

  async function fetchNotifications({ force = false } = {}) {
    const now = Date.now();
    if (!force && state.notifInFlight) return state.notifInFlight;
    if (!force && state.notifFetchedAt && now - state.notifFetchedAt < 20000) return state.notifInFlight;
    state.notifFetchedAt = now;
    state.notifInFlight = (async () => {
      try {
        const res = await fetch('/api/new-orders/notifications', {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!data || data.ok === false || !Array.isArray(data.orders)) return;
        state.newOrders = data.orders.map(order => ({
          ...order,
          parts: (order.parts || []).map(part => ({
            ...part,
            type: part.type || psTypeFromId(part.ps),
          })),
        }));
        renderNotifications();
      } catch {
        /* silent — bell just won't update */
      } finally {
        state.notifInFlight = null;
      }
    })();
    return state.notifInFlight;
  }

  function bindNotifications() {
    const root = document.getElementById('sol-notif');
    const btn = document.getElementById('sol-notif-btn');
    const panel = document.getElementById('sol-notif-panel');
    const list = document.getElementById('sol-notif-list');
    const markRead = document.getElementById('sol-notif-markread');
    if (!root || !btn || !panel || !list) return;

    const openPanel = () => {
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      fetchNotifications({ force: true });
    };

    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (panel.hidden) openPanel();
      else closeNotifPanel();
    });

    markRead?.addEventListener('click', e => {
      e.stopPropagation();
      if ((state.maxNotifSoTime || 0) > readLastSeenSoTime()) {
        writeLastSeenSoTime(state.maxNotifSoTime);
      }
      renderNotifications();
    });

    list.addEventListener('click', e => {
      const partBtn = e.target.closest('[data-sol-focus-ps]');
      const card = e.target.closest('[data-sol-focus-so]');
      const target = partBtn || card;
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      focusTrackerItem({
        so: target.getAttribute('data-sol-focus-so') || '',
        ps: target.getAttribute('data-sol-focus-ps') || '',
        type: target.getAttribute('data-sol-focus-type') || '',
      });
    });

    document.addEventListener('click', e => {
      if (!panel.hidden && !root.contains(e.target)) closeNotifPanel();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !panel.hidden) closeNotifPanel();
    });

    window.setTimeout(() => fetchNotifications(), 2000);
    window.setInterval(() => {
      if (document.visibilityState === 'visible') fetchNotifications();
    }, 60000);
    window.addEventListener('focus', () => fetchNotifications());
    window.addEventListener('pp-vouchers-synced', () => {
      fetchNotifications({ force: true });
      if (isPsView()) loadSalesOrders({ refresh: true });
    });
  }

  function bindDateHistoryModal() {
    const modal = document.getElementById('sol-date-history-modal');
    if (!modal || modal.dataset.bound === '1') return;
    modal.dataset.bound = '1';
    document.getElementById('sol-date-history-close')?.addEventListener('click', closeDateHistoryModal);
    modal.addEventListener('click', e => {
      if (e.target && e.target.id === 'sol-date-history-modal') closeDateHistoryModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !modal.hidden) closeDateHistoryModal();
    });
  }

  function init() {
    document.querySelectorAll('[data-sol-section]').forEach(btn => {
      btn.addEventListener('click', () => setSection(btn.getAttribute('data-sol-section')));
    });

    document.querySelectorAll('[data-sol-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        const qcBucket = btn.getAttribute('data-sol-qc-bucket');
        const shipBucket = btn.getAttribute('data-sol-ship-bucket');
        if (qcBucket) state.qcBucket = qcBucket;
        if (shipBucket) state.shipBucket = shipBucket;
        setView(btn.getAttribute('data-sol-view'));
      });
    });

    document.querySelectorAll('[data-sol-bucket]').forEach(btn => {
      btn.addEventListener('click', () => setBucket(btn.getAttribute('data-sol-bucket')));
    });

    document.getElementById('sol-search')?.addEventListener('input', e => {
      state.search = e.target.value || '';
      render();
    });

    document.getElementById('sol-material-filter')?.addEventListener('change', e => {
      state.materialFilter = e.target.value || 'all';
      render();
    });

    document.getElementById('sol-refresh')?.addEventListener('click', () => load({ refresh: true }));
    bindNotifications();

    bindMaterialButtons();
    bindPsTypeDropdown();
    bindPrPoFilters();
    bindPrPoSort();
    bindColFilter();
    bindRequestAdd();
    bindInputs();
    bindDateHistoryModal();
    syncNavUi();
    // Same live /api/sales-orders path as Sales Orders (COMAIN, not staging).
    load({ refresh: false });
    loadRequests({ refresh: false, silent: true });
    loadQcChecklist({ refresh: false, silent: true });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
