(() => {
  const API = {
    list: '/api/first-article',
    search: '/api/first-article/search',
    candidates: '/api/first-article/candidates',
    bulk: '/api/first-article/bulk',
    import: '/api/first-article/import',
    template: '/api/first-article/import-template',
    pics: '/api/first-article/pics',
    newParts: '/api/first-article/new-parts',
    history: '/api/first-article/history',
  };
  const CHECK_FIELDS = [
    { prefix: 'tooling', label: 'Tooling' },
    { prefix: 'fixture', label: 'Fixture/Jig' },
    { prefix: 'gauges', label: 'Gauges/CMM' },
  ];
  const PS_TYPE_ORDER = ['APS', 'NPS', 'MPS', 'PPS', 'CPS', 'SR', 'OTHER'];
  const BLANK_FILTER = '';
  const BLANK_FILTER_LABEL = '(Blank)';
  const PRIORITIES = [
    { id: 'critical', label: 'Critical', aliases: ['critical', 'crit', 'c'] },
    { id: 'high', label: 'High', aliases: ['high', 'h'] },
    { id: 'medium', label: 'Medium', aliases: ['medium', 'med', 'm'] },
    { id: 'low', label: 'Low', aliases: ['low', 'l'] },
  ];
  const PRIORITY_RANK = { critical: 1, high: 2, medium: 3, low: 4 };
  const grid = {
    tableId: '',
    anchor: null,
    focus: null,
    pending: null,
    dragging: false,
    suppressClick: false,
  };
  const NEW_PART_COLUMNS = [
    { id: 'process_sheet_no', label: 'PS', className: 'fa-col-ps', sortable: true, filterable: true },
    { id: 'part_no', label: 'Part', className: 'fa-col-part', sortable: true, filterable: true },
    { id: 'part_description', label: 'Description', className: 'fa-col-desc', sortable: true, filterable: true },
    { id: 'bom', label: 'BOM', className: 'fa-col-bom', sortable: true, filterable: true, title: 'Opens BOM materials. Green = ERP material lines exist.' },
    { id: 'stage', label: 'WO / Stage', className: 'fa-col-stage', sortable: true, filterable: true, title: 'Current work-order stage and WO status from ERP' },
    { id: 'po_due_date', label: 'Due', className: 'fa-col-date', sortable: true, filterable: true, title: 'PO due date' },
    { id: 'coway_proposed_edd', label: 'Coway proposed EDD', className: 'fa-col-date fa-col-edd', sortable: true, filterable: true, title: 'Coway proposed EDD from S/O management' },
    { id: 'program_finish_at', label: 'Commitment date', className: 'fa-col-finish', sortable: true, filterable: true, title: 'Commitment date. Drag cells, then paste dates as dd/mm/yyyy.' },
    { id: 'proposed_cnc', label: 'Proposed CNC', className: 'fa-col-machine', sortable: true, filterable: true, title: 'Same Proposed CNC as S/O Management. Pick one or more planner CNC machines.' },
    { id: 'priority', label: 'Priority', className: 'fa-col-priority', sortable: true, filterable: true, title: 'Critical, High, Medium, or Low. Drag cells, then paste.' },
    { id: 'pic', label: 'PIC', className: 'fa-col-pic', sortable: true, filterable: true, title: 'Programme PIC. Drag cells, then paste names.' },
    { id: 'remarks', label: 'Remarks', className: 'fa-col-remarks', sortable: true, filterable: true },
    { id: 'npi_complete', label: 'Done', className: 'fa-col-done', sortable: true, filterable: true, title: 'Mark this NPI job complete. The tick is saved on this tracker.' },
    { id: '_actions', label: '', className: 'fa-col-actions' },
  ];
  function makeTableView() {
    return {
      sortCol: 'po_due_date',
      sortDir: 'asc',
      sorts: [{ col: 'po_due_date', dir: 'asc' }],
      assignedPicOnly: false,
      colFilters: {},
      collapsedGroups: new Set(),
    };
  }

  const state = {
    tab: 'flagged',
    rows: [],
    newRows: [],
    newLoaded: false,
    newFilter: '',
    newTypes: new Set(['APS', 'NPS']),
    newView: makeTableView(),
    completedRows: [],
    completedLoaded: false,
    completedFilter: '',
    completedTypes: new Set(['APS', 'NPS']),
    completedView: makeTableView(),
    openFilterCol: '',
    openFilterTable: '',
    filterQuery: '',
    openPriorityPs: '',
    openProposedCncKey: '',
    proposedCncQuery: '',
    proposedCncSource: '',
    saveInFlight: new Set(),
    flaggedAssignedPicOnly: false,
    pics: [],
    machines: [],
    filter: '',
    searchHits: [],
    searchTimer: 0,
    exceptionHits: [],
    exceptionSearchTimer: 0,
    saveTimers: {},
    busy: false,
    history: {
      source: '',
      processSheetNo: '',
      rows: [],
      loading: false,
    },
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

  function tableView(which) {
    return which === 'history' ? state.completedView : state.newView;
  }

  function tableKindFromEl(el) {
    if (el && el.closest && el.closest('#fa-panel-history, #fa-history-table, #fa-history-assigned-pic')) {
      return 'history';
    }
    return 'new';
  }

  function rerenderTable(which) {
    if (which === 'history') renderHistoryTable();
    else renderNewTable();
  }

  function hasAssignedPic(row) {
    return (row?.program_pics || []).some((pic) => String(pic?.name || '').trim());
  }

  function soGroupKey(row) {
    return String(row?.sales_order_no || '').trim() || '\u2014';
  }

  function stageFilterLabel(row) {
    const desc = String(row?.current_stage_desc || '').trim();
    const statusCode = String(row?.current_stage_status || '').trim();
    const status = String(row?.current_stage_status_label || stageStatusLabel(statusCode) || '').trim();
    if (desc || status) return [desc, status].filter(Boolean).join(' · ');
    const mode = String(row?.erp_stage_mode || '').trim().toLowerCase();
    if (mode === 'completed' || isCompleteStatus(row)) return 'All complete';
    if (mode === 'unassigned') return 'No WO';
    return '';
  }

  function materialFilterLabel(row) {
    if (row?.material_arrived) return 'In';
    if (row?.material_date) return String(row.material_date).trim();
    return String(row?.material_legacy || row?.material_display || '').trim();
  }

  function colFilterValues(row, colId) {
    if (colId === 'pic') {
      const names = (row?.program_pics || []).map((pic) => String(pic?.name || '').trim()).filter(Boolean);
      return names.length ? names : [BLANK_FILTER];
    }
    if (colId === 'priority') {
      const label = priorityLabel(row?.priority);
      return [label || BLANK_FILTER];
    }
    let raw = '';
    if (colId === 'process_sheet_no') raw = row?.process_sheet_no || row?.pp_voucher_no || '';
    else if (colId === 'part_no') raw = row?.part_no;
    else if (colId === 'part_description') raw = row?.part_description;
    else if (colId === 'posted_date') raw = compactDate(row?.posted_date);
    else if (colId === 'po_due_date') raw = compactDate(row?.po_due_date);
    else if (colId === 'coway_proposed_edd') raw = compactDate(row?.coway_proposed_edd);
    else if (colId === 'total_qty') raw = row?.total_qty;
    else if (colId === 'stage') raw = stageFilterLabel(row);
    else if (colId === 'proposed_cnc') {
      const names = proposedCncMachines(row);
      return names.length ? names : [BLANK_FILTER];
    }
    else if (colId === 'bom') raw = hasBom(row) ? 'Yes' : 'None';
    else if (colId === 'material') raw = materialFilterLabel(row);
    else if (colId === 'remarks') raw = row?.remarks;
    else if (colId === 'npi_complete') raw = row?.npi_complete ? 'Yes' : 'No';
    else if (colId === 'program_finish_at') raw = formatFinishDate(row?.program_finish_at) || row?.program_finish_at;
    else if (colId === 'sales_order_no') raw = row?.sales_order_no;
    const text = String(raw == null ? '' : raw).trim();
    return [text];
  }

  function colFilterLabel(value) {
    return String(value || '') === BLANK_FILTER ? BLANK_FILTER_LABEL : String(value);
  }

  function colSortValue(row, colId) {
    if (colId === 'process_sheet_no') return String(row?.process_sheet_no || row?.pp_voucher_no || '').trim();
    if (colId === 'po_due_date') return parseIsoDate(row?.po_due_date) || parseFinishDate(row?.po_due_date) || String(row?.po_due_date || '').trim();
    if (colId === 'coway_proposed_edd') return parseIsoDate(row?.coway_proposed_edd) || parseFinishDate(row?.coway_proposed_edd) || String(row?.coway_proposed_edd || '').trim();
    if (colId === 'posted_date') return parseIsoDate(row?.posted_date) || parseFinishDate(row?.posted_date) || String(row?.posted_date || '').trim();
    if (colId === 'program_finish_at') return parseFinishDate(row?.program_finish_at);
    if (colId === 'priority') return PRIORITY_RANK[normalizePriority(row?.priority)] || '';
    if (colId === 'npi_complete') return row?.npi_complete ? 1 : 0;
    if (colId === 'sales_order_no') return soGroupKey(row);
    const values = colFilterValues(row, colId).filter((value) => value !== BLANK_FILTER);
    return values[0] || '';
  }

  function compareSortValues(a, b, dir) {
    const emptyA = a == null || String(a).trim() === '';
    const emptyB = b == null || String(b).trim() === '';
    if (emptyA && emptyB) return 0;
    if (emptyA) return 1;
    if (emptyB) return -1;
    const sa = String(a).trim();
    const sb = String(b).trim();
    const da = parseIsoDate(sa) || (/^\d{4}-\d{2}-\d{2}/.test(sa) ? sa.slice(0, 10) : '');
    const db = parseIsoDate(sb) || (/^\d{4}-\d{2}-\d{2}/.test(sb) ? sb.slice(0, 10) : '');
    if (da && db) {
      const cmp = da.localeCompare(db);
      return dir === 'desc' ? -cmp : cmp;
    }
    const na = Number(sa);
    const nb = Number(sb);
    if (sa !== '' && sb !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
      const cmp = na - nb;
      return dir === 'desc' ? -cmp : cmp;
    }
    const cmp = sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
    return dir === 'desc' ? -cmp : cmp;
  }

  function columnFilterActive(view, colId) {
    const selected = view.colFilters[colId];
    return Array.isArray(selected);
  }

  function rowMatchesColumnFilters(row, view) {
    return NEW_PART_COLUMNS.every((col) => {
      if (!col.filterable) return true;
      const selected = view.colFilters[col.id];
      if (!Array.isArray(selected)) return true;
      const wanted = new Set(selected);
      return colFilterValues(row, col.id).some((value) => wanted.has(value));
    });
  }

  function newPartSearchBlob(row) {
    return [
      row.process_sheet_no,
      row.pp_voucher_no,
      row.part_no,
      row.part_description,
      row.posted_date,
      row.po_due_date,
      row.coway_proposed_edd,
      row.material_display,
      row.material_subcon,
      row.remarks,
      row.npi_complete ? 'DONE COMPLETE' : '',
      row.program_finish_at,
      priorityLabel(row.priority),
      row.current_stage_desc,
      row.current_stage_status_label,
      row.erp_last_stage_desc,
      row.ps_type,
      row.machine_cnc,
      ...(row.proposed_cnc || []),
      ...(row.machine_codes || []),
      row.tooling_text,
      row.fixture_text,
      row.gauges_text,
      row.sales_order_no,
      row.customer_name,
      isExceptionRow(row) ? 'EXCEPTION' : '',
      row.from_npi_tracker ? 'NPI' : '',
      ...(row.program_pics || []).map((pic) => pic.name),
    ].join(' ').toUpperCase();
  }

  function applyTableView(rows, view, { needle, selectedTypes, extraBlob }) {
    const types = selectedTypes;
    const search = String(needle || '').trim().toUpperCase();
    let out = (rows || []).filter((row) => {
      if (!types.size || !types.has(newRowPsType(row))) return false;
      if (view.assignedPicOnly && !hasAssignedPic(row)) return false;
      if (search) {
        const blob = extraBlob ? extraBlob(row) : newPartSearchBlob(row);
        if (!blob.includes(search)) return false;
      }
      return rowMatchesColumnFilters(row, view);
    });
    const sorts = activeSorts(view);
    if (sorts[0].col !== 'sales_order_no') {
      out.sort((a, b) => compareBySorts(a, b, sorts));
      const groups = out.map((row) => ({
        so: soGroupKey(row),
        customer: String(row.customer_name || '').trim(),
        rows: [row],
      }));
      return { rows: out, groups };
    }
    const groups = [];
    const map = new Map();
    out.forEach((row) => {
      const key = soGroupKey(row);
      let group = map.get(key);
      if (!group) {
        group = {
          so: key,
          customer: String(row.customer_name || '').trim(),
          rows: [],
        };
        map.set(key, group);
        groups.push(group);
      }
      group.rows.push(row);
      if (!group.customer && row.customer_name) {
        group.customer = String(row.customer_name).trim();
      }
    });
    const inner = sorts.slice(1);
    groups.forEach((group) => {
      group.rows.sort((a, b) => (
        inner.length
          ? compareBySorts(a, b, inner)
          : compareSortValues(colSortValue(a, 'process_sheet_no'), colSortValue(b, 'process_sheet_no'), 'asc')
      ));
    });
    groups.sort((a, b) => compareSortValues(a.so, b.so, sorts[0].dir));
    return { rows: groups.flatMap((group) => group.rows), groups };
  }

  function uniqueFilterOptions(rows, colId) {
    const seen = new Set();
    const values = [];
    (rows || []).forEach((row) => {
      colFilterValues(row, colId).forEach((value) => {
        if (seen.has(value)) return;
        seen.add(value);
        values.push(value);
      });
    });
    values.sort((a, b) => {
      if (a === BLANK_FILTER) return 1;
      if (b === BLANK_FILTER) return -1;
      return compareSortValues(a, b, 'asc');
    });
    return values;
  }

  function activeSorts(view) {
    if (Array.isArray(view?.sorts) && view.sorts.length) {
      return view.sorts.map((sort) => ({
        col: sort.col,
        dir: sort.dir === 'desc' ? 'desc' : 'asc',
      }));
    }
    return [{
      col: view?.sortCol || 'po_due_date',
      dir: view?.sortDir === 'desc' ? 'desc' : 'asc',
    }];
  }

  function compareBySorts(a, b, sorts) {
    for (let i = 0; i < sorts.length; i += 1) {
      const sort = sorts[i];
      const cmp = compareSortValues(colSortValue(a, sort.col), colSortValue(b, sort.col), sort.dir);
      if (cmp) return cmp;
    }
    return compareSortValues(
      colSortValue(a, 'process_sheet_no'),
      colSortValue(b, 'process_sheet_no'),
      'asc',
    );
  }

  function isDefaultSort(view) {
    const sorts = activeSorts(view);
    return sorts.length === 1 && sorts[0].col === 'po_due_date' && sorts[0].dir === 'asc';
  }

  function setColumnSort(view, colId, { additive = false, dir = '' } = {}) {
    const sorts = activeSorts(view);
    if (additive) {
      const existing = sorts.find((sort) => sort.col === colId);
      if (existing) existing.dir = dir || (existing.dir === 'asc' ? 'desc' : 'asc');
      else sorts.push({ col: colId, dir: dir || 'asc' });
      view.sorts = sorts;
    } else if (dir) {
      view.sorts = [{ col: colId, dir: dir === 'desc' ? 'desc' : 'asc' }];
    } else if (sorts.length === 1 && sorts[0].col === colId) {
      view.sorts = [{ col: colId, dir: sorts[0].dir === 'asc' ? 'desc' : 'asc' }];
    } else {
      view.sorts = [{ col: colId, dir: 'asc' }];
    }
    view.sortCol = view.sorts[0].col;
    view.sortDir = view.sorts[0].dir;
  }

  function sortIcon(view, colId) {
    const sorts = activeSorts(view);
    const index = sorts.findIndex((sort) => sort.col === colId);
    if (index < 0) return '↕';
    const arrow = sorts[index].dir === 'desc' ? '↓' : '↑';
    return sorts.length > 1 ? `${arrow}${index + 1}` : arrow;
  }

  function sortSummary(view) {
    return activeSorts(view).map((sort, index) => {
      const col = NEW_PART_COLUMNS.find((item) => item.id === sort.col);
      const label = col?.label || sort.col;
      const arrow = sort.dir === 'desc' ? '↓' : '↑';
      return index === 0 ? `${label} ${arrow}` : `${label} ${arrow}`;
    }).join(', then ');
  }

  function renderNewPartHead(tableId, view) {
    const row = document.querySelector(`#${tableId} thead tr`);
    if (!row) return;
    row.innerHTML = NEW_PART_COLUMNS.map((col) => {
      const title = col.title ? ` title="${escapeHtml(col.title)}"` : '';
      if (!col.sortable && !col.filterable) {
        return `<th class="${escapeHtml(col.className || '')}"${title}>${escapeHtml(col.label)}</th>`;
      }
      const sorted = activeSorts(view).some((sort) => sort.col === col.id) ? ' is-sorted' : '';
      const filterOn = columnFilterActive(view, col.id) ? ' is-active' : '';
      const sortBtn = col.sortable
        ? `<button type="button" class="fa-col-sort-btn" data-fa-sort-col="${escapeHtml(col.id)}" title="Sort this column. Shift-click to add another sort. Filters stay on.">
            <span class="fa-col-label">${escapeHtml(col.label)}</span>
            <span class="fa-col-sort-icon">${sortIcon(view, col.id)}</span>
          </button>`
        : `<span class="fa-col-label">${escapeHtml(col.label)}</span>`;
      const filterBtn = col.filterable
        ? `<button type="button" class="fa-col-filter-btn${filterOn}" data-fa-filter-col="${escapeHtml(col.id)}" title="Filter">▾</button>`
        : '';
      return `<th class="fa-col-head ${escapeHtml(col.className || '')}${sorted}" data-fa-col="${escapeHtml(col.id)}"${title}>
        <div class="fa-col-head-inner">${sortBtn}${filterBtn}</div>
      </th>`;
    }).join('');
  }

  function closeColumnFilter() {
    const pop = $('fa-col-filter-popover');
    if (pop) pop.hidden = true;
    state.openFilterCol = '';
    state.openFilterTable = '';
    state.filterQuery = '';
  }

  function columnFilterBtn(which, colId) {
    const tableId = which === 'history' ? 'fa-history-table' : 'fa-new-table';
    return document.querySelector(`#${tableId} [data-fa-filter-col="${CSS.escape(colId)}"]`);
  }

  function repositionColumnFilter() {
    const pop = $('fa-col-filter-popover');
    if (!pop || pop.hidden || !state.openFilterCol) return;
    const btn = columnFilterBtn(state.openFilterTable, state.openFilterCol);
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const width = pop.offsetWidth || 220;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${rect.bottom + 4}px`;
  }

  function columnFilterSourceRows(which, skipColId) {
    const view = tableView(which);
    const probe = {
      ...view,
      colFilters: { ...view.colFilters },
    };
    delete probe.colFilters[skipColId];
    const grouped = which === 'history'
      ? applyTableView(state.completedRows, probe, { needle: state.completedFilter, selectedTypes: state.completedTypes })
      : applyTableView(state.newRows, probe, { needle: state.newFilter, selectedTypes: state.newTypes });
    return grouped.rows;
  }

  function renderColumnFilterPanel(which, colId) {
    const col = NEW_PART_COLUMNS.find((item) => item.id === colId);
    if (!col) return '';
    const view = tableView(which);
    const options = uniqueFilterOptions(columnFilterSourceRows(which, colId), colId);
    const selected = Array.isArray(view.colFilters[colId]) ? new Set(view.colFilters[colId]) : null;
    const query = String(state.filterQuery || '').trim().toUpperCase();
    const visible = query
      ? options.filter((value) => colFilterLabel(value).toUpperCase().includes(query))
      : options;
    const allChecked = !selected;
    const checks = visible.map((value) => {
      const checked = !selected || selected.has(value) ? ' checked' : '';
      return `<label class="fa-col-filter-check">
        <input type="checkbox" data-fa-filter-value="${escapeHtml(value)}"${checked} />
        <span title="${escapeHtml(colFilterLabel(value))}">${escapeHtml(colFilterLabel(value))}</span>
      </label>`;
    }).join('') || '<p class="fa-col-filter-empty">No values</p>';
    const sorts = activeSorts(view);
    const current = sorts.find((sort) => sort.col === colId);
    return `
      <div class="fa-col-filter-title">Filter: ${escapeHtml(col.label)}</div>
      <div class="fa-col-filter-sort">
        <button type="button" class="fa-btn fa-btn--ghost${current && current.dir === 'asc' ? ' is-on' : ''}" data-fa-sort-dir="asc">Sort A → Z</button>
        <button type="button" class="fa-btn fa-btn--ghost${current && current.dir === 'desc' ? ' is-on' : ''}" data-fa-sort-dir="desc">Sort Z → A</button>
      </div>
      <p class="fa-col-filter-hint">Filters on other columns stay on. Shift-click a heading to sort by more than one column.</p>
      <input type="search" class="fa-col-filter-search" value="${escapeHtml(state.filterQuery || '')}" placeholder="Search values..." autocomplete="off">
      <label class="fa-col-filter-check fa-col-filter-all">
        <input type="checkbox" data-fa-filter-all${allChecked ? ' checked' : ''}>
        Select all
      </label>
      <div class="fa-col-filter-checks">${checks}</div>
      <div class="fa-col-filter-actions">
        <button type="button" class="fa-btn fa-btn--ghost" data-fa-clear-col-filter="${escapeHtml(colId)}">Clear</button>
      </div>
    `;
  }

  function openColumnFilter(btn, which, colId) {
    const pop = $('fa-col-filter-popover');
    if (!pop || !colId) return;
    if (state.openFilterCol === colId && state.openFilterTable === which && !pop.hidden) {
      closeColumnFilter();
      return;
    }
    closeProposedCncPopover();
    state.openFilterCol = colId;
    state.openFilterTable = which;
    state.filterQuery = '';
    pop.innerHTML = renderColumnFilterPanel(which, colId);
    pop.hidden = false;
    repositionColumnFilter();
    pop.querySelector('.fa-col-filter-search')?.focus();
  }

  function syncAssignedPicChip(which) {
    const id = which === 'history' ? 'fa-history-assigned-pic' : 'fa-new-assigned-pic';
    const btn = $(id);
    if (!btn) return;
    const view = tableView(which);
    const rows = which === 'history' ? state.completedRows : state.newRows;
    const count = rows.filter(hasAssignedPic).length;
    btn.textContent = count ? `Assigned PIC ${count}` : 'Assigned PIC';
    btn.classList.toggle('is-active', view.assignedPicOnly);
    btn.setAttribute('aria-pressed', view.assignedPicOnly ? 'true' : 'false');
  }

  function soRailHtml(group, rowSpan, { shadeAlt, collapsed } = {}) {
    const soNo = group.so;
    const chevron = collapsed ? '▸' : '▾';
    const customer = group.customer || '';
    const hasSo = soNo && soNo !== '\u2014';
    const href = hasSo ? `/sales-orders?q=${encodeURIComponent(soNo)}` : '';
    const soInner = href
      ? `<a class="fa-so-link" href="${escapeHtml(href)}" title="Open ${escapeHtml(soNo)} in S/O Management">${escapeHtml(soNo)}</a>`
      : `<strong class="fa-so-no">${escapeHtml(soNo)}</strong>`;
    return `
      <td class="fa-col-so fa-so-rail${shadeAlt ? ' fa-so-rail--shade-alt' : ''}" rowspan="${rowSpan}" data-sales-order="${escapeHtml(soNo)}">
        <div class="fa-so-rail-inner">
          <button type="button" class="fa-so-toggle" data-fa-toggle-so="${escapeHtml(soNo)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} process sheets">${chevron}</button>
          ${soInner}
          ${customer ? `<span class="fa-so-customer" title="${escapeHtml(customer)}">${escapeHtml(customer)}</span>` : ''}
        </div>
      </td>
    `;
  }

  async function api(url, options) {
    const opts = { ...(options || {}) };
    const timeoutMs = Number(opts.timeoutMs) || 0;
    const timeoutMessage = opts.timeoutMessage || 'Request timed out';
    delete opts.timeoutMs;
    delete opts.timeoutMessage;
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
        throw new Error(timeoutMessage);
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
    return state.rows.filter((row) => {
      if (state.flaggedAssignedPicOnly && !(row.pics || []).some((pic) => String(pic?.name || '').trim())) {
        return false;
      }
      if (!needle) return true;
      const blob = [
        row.process_sheet_no,
        row.pp_voucher_no,
        row.part_no,
        row.part_description,
        row.machine_cnc,
        ...(row.proposed_cnc || []),
        ...(row.machine_codes || []),
        row.current_stage_desc,
        row.erp_last_stage_desc,
        row.so_scope,
        row.sales_order_no,
        row.posted_date,
        row.remarks,
        row.tooling_text,
        row.fixture_text,
        row.gauges_text,
        row.on_new_parts ? 'PO' : '',
        row.from_quotation ? 'QUOTE' : '',
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

  function picOptions(selectedId) {
    const current = Number(selectedId || 0);
    const blank = '<option value="">PIC...</option>';
    const pics = state.pics.map((pic) => {
      const selected = Number(pic.pic_id) === current ? ' selected' : '';
      return `<option value="${escapeHtml(pic.pic_id)}"${selected}>${escapeHtml(pic.name)}</option>`;
    }).join('');
    return `${blank}${pics}<option value="__new">New PIC name...</option>`;
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

  function proposedCncMachines(row) {
    if (Array.isArray(row?.proposed_cnc)) {
      return row.proposed_cnc.filter(Boolean);
    }
    if (Array.isArray(row?.machine_codes) && row.machine_codes.some(Boolean)) {
      return row.machine_codes.filter(Boolean);
    }
    const text = String(row?.machine_cnc || '').trim();
    if (!text) return [];
    return text.split(',').map((part) => part.trim()).filter(Boolean);
  }

  const FA_NON_CNC_OPTIONS = ['Subcon', 'Wirecut'];

  function faCncMachineNumber(code) {
    const match = String(code || '').trim().match(/(\d+)\s*$/);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
  }

  function faNonCncOptionKey(raw) {
    return String(raw || '').trim().replace(/[\s_-]+/g, '').toUpperCase();
  }

  function faIsNonCncOption(raw) {
    const key = faNonCncOptionKey(raw);
    return key === 'SUBCON' || key === 'WIRECUT';
  }

  function faNormalizeCncMachine(raw) {
    const text = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!text) return '';
    const key = faNonCncOptionKey(text);
    if (key === 'SUBCON') return 'Subcon';
    if (key === 'WIRECUT') return 'Wirecut';
    if (/^\d+$/.test(text)) return `CNC ${text}`;
    return text;
  }

  function faCncMachineCatalog(selected) {
    const out = [];
    const seen = new Set();
    const add = (raw) => {
      const name = faNormalizeCncMachine(raw);
      const key = name.toUpperCase();
      if (!name || seen.has(key) || faIsNonCncOption(name)) return;
      seen.add(key);
      out.push(name);
    };
    (state.machines || []).forEach(add);
    (selected || []).forEach(add);
    out.sort((a, b) => {
      const an = faCncMachineNumber(a);
      const bn = faCncMachineNumber(b);
      if (an !== bn) return an - bn;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });
    return out;
  }

  function proposedCncValueHtml(machines, source) {
    const list = Array.isArray(machines) ? machines.filter(Boolean) : [];
    if (!list.length) return '<span class="fa-muted">\u2014</span>';
    if (source === 'new') {
      const text = list.join(', ');
      return `<span class="fa-cnc-compact" title="${escapeHtml(text)}">${escapeHtml(text)}</span>`;
    }
    return faRenderCncPills(list);
  }

  function faRenderCncPills(machines) {
    const list = Array.isArray(machines) ? machines.filter(Boolean) : [];
    if (!list.length) return '<span class="fa-muted">\u2014</span>';
    const pills = list.map((machine) => {
      const other = faIsNonCncOption(machine) ? ' fa-cnc-pill--other' : '';
      return `<span class="fa-cnc-pill${other}">${escapeHtml(String(machine))}</span>`;
    }).join('');
    return `<span class="fa-cnc-pills" title="Proposed CNC">${pills}</span>`;
  }

  function proposedCncOpenKey(row, source) {
    if (source === 'tracker') return `tracker:${row.first_article_id}`;
    return `new:${String(row.process_sheet_no || row.pp_voucher_no || '').trim().toUpperCase()}`;
  }

  function proposedCncPickerHtml(row, source) {
    const key = proposedCncOpenKey(row, source);
    const machines = proposedCncMachines(row);
    const open = state.openProposedCncKey === key;
    const extraAttr = source === 'tracker'
      ? `data-fa-cnc-id="${escapeHtml(row.first_article_id)}"`
      : `data-fa-cnc-ps="${escapeHtml(row.process_sheet_no || row.pp_voucher_no || '')}"`;
    return `
      <button type="button"
        class="fa-proposed-cnc-btn${machines.length ? ' has-value' : ''}${open ? ' is-open' : ''}"
        data-fa-cnc-source="${escapeHtml(source)}"
        data-fa-cnc-key="${escapeHtml(key)}"
        ${extraAttr}
        aria-haspopup="listbox"
        aria-expanded="${open ? 'true' : 'false'}"
        title="Choose proposed CNC machines — same field as S/O Management">
        <span class="fa-proposed-cnc-btn-value">${proposedCncValueHtml(machines, source)}</span>
        <span class="fa-proposed-cnc-btn-caret" aria-hidden="true">▾</span>
      </button>
      <span class="fa-proposed-cnc-status" aria-live="polite"></span>
    `;
  }

  function machineCell(row) {
    return proposedCncPickerHtml(row, 'tracker');
  }

  function stageStatusClass(value) {
    const code = String(value == null ? '' : value).trim().toUpperCase();
    if (code === 'I') return 'is-in-process';
    if (code === 'R') return 'is-released';
    if (code === 'P') return 'is-pending';
    if (code === 'C') return 'is-complete';
    return '';
  }

  function stageCell(row) {
    const desc = String(row.current_stage_desc || '').trim();
    const statusCode = String(row.current_stage_status || '').trim();
    const status = String(row.current_stage_status_label || stageStatusLabel(statusCode) || '').trim();
    const mode = String(row.erp_stage_mode || '').trim().toLowerCase();
    const last = String(row.erp_last_stage_desc || '').trim();
    if (desc || status) {
      const extra = status
        ? `<span class="fa-stage-status ${stageStatusClass(statusCode)}" title="WO status">${escapeHtml(status)}</span>`
        : '';
      const stageHtml = desc
        ? `<span class="fa-stage-desc" title="${escapeHtml(desc)}">${escapeHtml(desc)}</span>`
        : '<span class="fa-muted">\u2014</span>';
      return `<div class="fa-stage-stack">${stageHtml}${extra}</div>`;
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

  function historyButton(row, source) {
    const ps = String(row.process_sheet_no || row.pp_voucher_no || '').trim();
    const count = Number(row.history_count || 0);
    const active = count > 0 ? ' has-history' : '';
    const title = count > 0
      ? `View ${count} change${count === 1 ? '' : 's'} to PIC, remarks, and dates`
      : 'View change history for PIC, remarks, and dates';
    return `
      <button type="button"
        class="fa-history-btn${active}"
        data-fa-history="${escapeHtml(source)}"
        data-ps="${escapeHtml(ps)}"
        data-part="${escapeHtml(row.part_no || '')}"
        title="${escapeHtml(title)}"
        aria-label="${escapeHtml(title)}">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="8" cy="8" r="6.2"/>
          <path d="M8 4.5V8l2.2 1.6"/>
        </svg>
      </button>
    `;
  }

  function npiStatusBadge(row) {
    if (row?.on_new_parts || row?.is_new_part) {
      return '<span class="fa-new-part-badge is-po" title="Posted as our PO — details are on New parts">PO</span>';
    }
    if (row?.from_quotation && !row?.in_sales_orders) {
      return '<span class="fa-new-part-badge is-quote" title="Quotation — waiting for PO">QUOTE</span>';
    }
    return '';
  }

  function checkReadout(row, prefix) {
    const parsed = parseCheckValue(row, prefix);
    if (parsed.ready) return '<span class="fa-check-readout is-ready">OK</span>';
    if (parsed.date) return `<span class="fa-check-readout has-date">${escapeHtml(formatDmy(parsed.date))}</span>`;
    if (parsed.legacy) return `<span class="fa-check-readout">${escapeHtml(parsed.legacy)}</span>`;
    return '<span class="fa-muted">—</span>';
  }

  function psCell(row) {
    return `<span class="fa-mono">${escapeHtml(dash(row.process_sheet_no))}</span>`;
  }

  function compactDate(value) {
    const iso = parseFinishDate(value) || parseIsoDate(value);
    if (!iso) return String(value || '').trim();
    const [year, month, day] = iso.split('-');
    return `${day}/${month}/${year.slice(2)}`;
  }

  function formatDmy(iso) {
    const text = String(iso || '').trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return text;
    return `${Number(match[3])}/${Number(match[2])}/${match[1]}`;
  }

  function isReadyCheckText(value) {
    const text = String(value == null ? '' : value).trim().toLowerCase();
    return ['ok', 'okay', 'ready', 'yes', 'y', 'done', 'complete', 'completed'].includes(text);
  }

  function checkDisplayValue(row, prefix) {
    const parsed = parseCheckValue(row, prefix);
    if (parsed.ready) return 'OK';
    if (parsed.date) return formatDmy(parsed.date);
    return parsed.legacy;
  }

  function checkCell(row, prefix, label) {
    const parsed = parseCheckValue(row, prefix);
    const readyCls = parsed.ready ? ' is-ready' : '';
    return `
      <input type="text"
        class="fa-cell-input fa-check-input${readyCls}"
        data-fa-field="${prefix}"
        data-id="${row.first_article_id}"
        value="${escapeHtml(checkDisplayValue(row, prefix))}"
        placeholder="OK, NA, date..."
        autocomplete="off"
        aria-label="${escapeHtml(label)}">
    `;
  }

  function picText(row) {
    return (row.pics || []).map((pic) => pic.name).filter(Boolean).join(' / ');
  }

  function picCell(row) {
    return `
      <input type="text"
        class="fa-cell-input fa-pic-input"
        data-fa-field="pic_names"
        data-id="${row.first_article_id}"
        value="${escapeHtml(picText(row))}"
        list="fa-pic-datalist"
        placeholder="Name / Name"
        autocomplete="off"
        aria-label="PIC">
    `;
  }

  function programPicCell(row) {
    const ps = escapeHtml(row.process_sheet_no || row.pp_voucher_no || '');
    const currentId = Number((row.program_pic_ids || [])[0] || 0);
    const filled = currentId ? ' has-value' : '';
    return `
      <select class="fa-pic-select${filled}" data-fa-set-pic data-ps="${ps}" aria-label="Programme PIC">
        ${picOptions(currentId)}
      </select>
    `;
  }

  function normalizePriority(value) {
    const text = String(value == null ? '' : value).trim().toLowerCase();
    if (!text || text === '-' || text === '\u2014' || text === 'none') return '';
    const hit = PRIORITIES.find((item) => item.id === text || item.aliases.includes(text));
    return hit ? hit.id : '';
  }

  function priorityLabel(value) {
    const key = normalizePriority(value);
    const hit = PRIORITIES.find((item) => item.id === key);
    return hit ? hit.label : '';
  }

  function priorityIcon(kind) {
    if (kind === 'critical') {
      return '<svg class="fa-priority-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.15 14.35 8 8 14.85 1.65 8 8 1.15z"/><path fill="#fff" d="M7.2 4.15h1.6v5.05H7.2zM7.2 10.35h1.6V12H7.2z"/></svg>';
    }
    if (kind === 'high') {
      return '<svg class="fa-priority-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M8 2.1 13.7 13.2H2.3z"/></svg>';
    }
    if (kind === 'medium') {
      return '<svg class="fa-priority-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.15" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';
    }
    if (kind === 'low') {
      return '<svg class="fa-priority-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M2.3 2.8h11.4L8 13.9z"/></svg>';
    }
    return '';
  }

  function priorityButtonHtml(row) {
    const ps = escapeHtml(row.process_sheet_no || row.pp_voucher_no || '');
    const key = normalizePriority(row.priority);
    const label = priorityLabel(key) || '\u2014';
    const open = state.openPriorityPs && state.openPriorityPs === String(row.process_sheet_no || row.pp_voucher_no || '').trim();
    return `
      <button type="button" class="fa-priority-btn${key ? ` is-${key}` : ''}${open ? ' is-open' : ''}"
              data-fa-priority="${ps}" data-fa-priority-value="${escapeHtml(key)}"
              aria-haspopup="listbox" aria-expanded="${open ? 'true' : 'false'}"
              aria-label="Priority${key ? `: ${priorityLabel(key)}` : ''}">
        ${key ? priorityIcon(key) : '<span class="fa-priority-empty" aria-hidden="true">\u2014</span>'}
        <span class="fa-priority-label">${escapeHtml(label)}</span>
      </button>
    `;
  }

  function renderTable() {
    const host = $('fa-table-host');
    const empty = $('fa-empty');
    const body = $('fa-table-body');
    const rows = filteredRows();
    const picBtn = $('fa-flagged-assigned-pic');
    if (picBtn) {
      const count = state.rows.filter((row) => (row.pics || []).some((pic) => String(pic?.name || '').trim())).length;
      picBtn.textContent = count ? `Assigned PIC ${count}` : 'Assigned PIC';
      picBtn.classList.toggle('is-active', state.flaggedAssignedPicOnly);
      picBtn.setAttribute('aria-pressed', state.flaggedAssignedPicOnly ? 'true' : 'false');
    }
    if (!state.rows.length) {
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'No quotations flagged yet. Search a PS number, use Bulk flag, or import an Excel sheet.';
      }
      if (state.tab === 'flagged') {
        $('fa-subtitle').textContent = 'Import quotations for new parts. When the job posts as a PO, details carry to New parts.';
      }
      return;
    }
    if (!rows.length) {
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = state.flaggedAssignedPicOnly
          ? 'No process sheets with an assigned PIC match this filter.'
          : 'No flagged jobs match this filter.';
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
        <th class="fa-col-date" title="S/O posted date when the quotation becomes our PO">Posted</th>
        <th class="fa-col-stage" title="Current work-order stage and WO status from ERP">WO / Stage</th>
        <th class="fa-col-machine" title="Same Proposed CNC as S/O Management">Proposed CNC</th>
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
      const quotation = Boolean(row.from_quotation) && !row.in_sales_orders && !row.from_erp_cache;
      const missing = !row.in_sales_orders && !row.from_erp_cache && !historical && !quotation;
      const rowClass = [missing ? 'is-missing' : '', historical ? 'is-historical' : '', quotation ? 'is-quote' : ''].filter(Boolean).join(' ');
      const missingHint = missing
        ? ' title="Not found in S/O management or ERP cache"'
        : (quotation ? ' title="Quotation — waiting for this job to post as a PO"' : '');
      return `
        <tr class="${rowClass}" data-id="${row.first_article_id}"${missingHint}>
          <td>${psCell(row)}</td>
          <td class="fa-readonly">${escapeHtml(dash(row.part_no))}${npiStatusBadge(row)}</td>
          <td>${escapeHtml(dash(row.part_description))}</td>
          <td class="fa-col-qty">${escapeHtml(dash(row.total_qty))}</td>
          <td class="fa-col-date">${escapeHtml(dash(row.po_due_date))}</td>
          <td class="fa-col-date">${escapeHtml(dash(row.posted_date))}</td>
          <td class="fa-col-stage">${stageCell(row)}</td>
          <td class="fa-col-machine fa-proposed-cnc-cell">${proposedCncPickerHtml(row, 'tracker')}</td>
          <td class="fa-edd">${escapeHtml(dash(row.coway_proposed_edd))}</td>
          <td class="fa-col-pic">${picCell(row)}</td>
          ${CHECK_FIELDS.map((field) => {
            const parsed = parseCheckValue(row, field.prefix);
            return `<td class="fa-col-check${checkCellStateClass(parsed)}">${checkCell(row, field.prefix, field.label)}</td>`;
          }).join('')}
          <td class="fa-col-remarks">
            <textarea class="fa-cell-input fa-remarks" data-fa-field="remarks" data-id="${row.first_article_id}" placeholder="Remarks">${escapeHtml(row.remarks || '')}</textarea>
          </td>
          <td class="fa-col-actions">
            ${historyButton(row, 'flagged')}
            <button type="button" class="fa-btn fa-btn--danger" data-fa-unflag="${row.first_article_id}">Remove</button>
          </td>
        </tr>
      `;
    }).join('');
    if (state.tab === 'flagged') {
        $('fa-subtitle').textContent = `${state.rows.length} quotation${state.rows.length === 1 ? '' : 's'} on NPI Tracker`;
    }
    renderPicDatalist();
    repositionProposedCncPopover();
  }

  function newRowKey(row) {
    return String(row?.process_sheet_no || row?.pp_voucher_no || '').trim().toUpperCase();
  }

  function isExceptionRow(row) {
    return Boolean(row && row.is_exception) && !row.is_new_part;
  }

  function isCompleteStatus(row) {
    const scope = String(row?.so_scope || '').toLowerCase();
    const mode = String(row?.erp_stage_mode || '').toLowerCase();
    return !!row?.shipped_completed || scope === 'complete' || mode === 'completed' || row?.list_scope === 'history';
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

  function groupedNewRows() {
    return applyTableView(state.newRows, state.newView, {
      needle: state.newFilter,
      selectedTypes: state.newTypes,
    });
  }

  function filteredNewRows() {
    return groupedNewRows().rows;
  }

  function renderNewTypeChips() {
    const host = $('fa-new-types');
    if (!host) return;
    const counts = newTypeCounts();
    const present = PS_TYPE_ORDER.filter((label) => counts[label] || label === 'APS' || label === 'NPS');
    const allOn = present.length > 0 && present.every((label) => state.newTypes.has(label));
    const chips = [`<button type="button" class="fa-type-chip${allOn ? ' is-active' : ''}" data-fa-new-type="__all">All ${state.newRows.length}</button>`]
      .concat(present.map((label) => {
        const active = state.newTypes.has(label);
        return `<button type="button" class="fa-type-chip${active ? ' is-active' : ''}" data-fa-new-type="${escapeHtml(label)}">${escapeHtml(label)} ${counts[label] || 0}</button>`;
      }));
    host.innerHTML = chips.join('');
  }

  function parseFinishDate(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    const isoHead = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/);
    if (isoHead) return parseIsoDate(isoHead[1]);
    const dmy = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:\b.*)?$/);
    if (dmy) return parseIsoDate(`${dmy[1]}/${dmy[2]}/${dmy[3]}`);
    return '';
  }

  function formatFinishDate(value) {
    const iso = parseFinishDate(value);
    if (!iso) return '';
    const [year, month, day] = iso.split('-');
    return `${day}/${month}/${year}`;
  }

  function syncFinishField(wrap, iso) {
    const text = wrap?.querySelector('.fa-finish-input');
    const picker = wrap?.querySelector('[data-fa-finish-picker]');
    if (text) {
      text.value = iso ? compactDate(iso) : '';
      text.classList.remove('is-invalid');
    }
    if (picker) picker.value = iso || '';
  }

  function materialCell(row) {
    if (row.material_arrived) {
      return `<span class="fa-mat-status is-ready" title="From S/O Material in / Sub-con">In</span>`;
    }
    if (row.material_date) {
      return `<span class="fa-material-date" title="${escapeHtml(row.material_date)}">${escapeHtml(compactDate(row.material_date))}</span>`;
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
    const label = exists ? 'Yes' : 'None';
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

  function completedTypeCounts() {
    const counts = {};
    state.completedRows.forEach((row) => {
      const kind = newRowPsType(row);
      counts[kind] = (counts[kind] || 0) + 1;
    });
    return counts;
  }

  function selectedCompletedTypeLabels() {
    return PS_TYPE_ORDER.filter((label) => state.completedTypes.has(label));
  }

  function ensureCompletedTypes() {
    if (state.completedTypes.size) return;
    const present = PS_TYPE_ORDER.filter((label) => state.completedRows.some((row) => newRowPsType(row) === label));
    state.completedTypes = new Set(present.length ? present : ['APS', 'NPS']);
  }

  function groupedCompletedRows() {
    ensureCompletedTypes();
    return applyTableView(state.completedRows, state.completedView, {
      needle: state.completedFilter,
      selectedTypes: state.completedTypes,
      extraBlob: (row) => `${newPartSearchBlob(row)} COMPLETE`,
    });
  }

  function filteredCompletedRows() {
    return groupedCompletedRows().rows;
  }

  function renderCompletedTypeChips() {
    const host = $('fa-history-types');
    if (!host) return;
    ensureCompletedTypes();
    const counts = completedTypeCounts();
    const present = PS_TYPE_ORDER.filter((label) => counts[label]);
    const allOn = present.length > 0 && present.every((label) => state.completedTypes.has(label));
    const chips = [`<button type="button" class="fa-type-chip${allOn ? ' is-active' : ''}" data-fa-history-type="__all">All ${state.completedRows.length}</button>`]
      .concat(present.map((label) => {
        const active = state.completedTypes.has(label);
        return `<button type="button" class="fa-type-chip${active ? ' is-active' : ''}" data-fa-history-type="${escapeHtml(label)}">${escapeHtml(label)} ${counts[label] || 0}</button>`;
      }));
    host.innerHTML = chips.join('');
  }

  function updateHistoryCount() {
    const count = $('fa-history-count');
    const visible = filteredCompletedRows().length;
    if (!count) return;
    if (!state.completedLoaded) {
      count.hidden = true;
      return;
    }
    count.hidden = false;
    count.textContent = String(visible);
  }

  function newPartBadges(row) {
    const bits = [];
    if (isExceptionRow(row)) {
      bits.push('<span class="fa-new-part-badge is-exception" title="Manually added exception — not tagged NEW in S/O management">Ex</span>');
    } else if (isCompleteStatus(row)) {
      bits.push('<span class="fa-new-part-badge is-complete" title="Process sheet is complete">Done</span>');
    }
    if (row.from_npi_tracker) {
      bits.push('<span class="fa-new-part-badge is-quote" title="Copied from NPI Tracker quotation">NPI</span>');
    }
    return bits.join('');
  }

  function newPartRowHtml(row, { allowRemove } = {}) {
    const ps = escapeHtml(row.process_sheet_no || row.pp_voucher_no || '');
    const exists = hasBom(row);
    const exception = isExceptionRow(row);
    const complete = isCompleteStatus(row);
    const missing = exception && !row.in_sales_orders && !row.from_erp_cache;
    const badges = newPartBadges(row);
    const desc = String(row.part_description || '').trim();
    const remove = allowRemove && exception
      ? `<button type="button" class="fa-btn fa-btn--danger" data-fa-remove-exception="${ps}">Remove</button>`
      : '';
    const rowClass = [
      missing ? 'is-missing' : '',
      complete ? 'is-historical' : '',
      row.npi_complete ? 'is-npi-complete' : '',
    ].filter(Boolean).join(' ');
    const missingHint = missing ? ' title="Not found in S/O management or ERP cache"' : '';
    return `
      <tr class="${rowClass}" data-ps="${escapeHtml(row.process_sheet_no || '')}" data-pp="${escapeHtml(row.pp_voucher_no || '')}" data-so="${escapeHtml(soGroupKey(row))}"${missingHint}>
        <td class="fa-col-ps">
          <div class="fa-id-cell">
            <span class="fa-mono">${escapeHtml(dash(row.process_sheet_no))}</span>
            ${badges}
          </div>
        </td>
        <td class="fa-col-part fa-readonly">${escapeHtml(dash(row.part_no))}</td>
        <td class="fa-col-desc" title="${escapeHtml(desc)}">${escapeHtml(dash(row.part_description))}</td>
        <td class="fa-col-bom${exists ? ' has-bom' : ''}">${bomCell(row)}</td>
        <td class="fa-col-stage">${stageCell(row)}</td>
        <td class="fa-col-date" title="${escapeHtml(row.po_due_date || '')}">${escapeHtml(dash(compactDate(row.po_due_date)))}</td>
        <td class="fa-col-date fa-col-edd" title="${escapeHtml(row.coway_proposed_edd || 'Coway proposed EDD')}">${escapeHtml(dash(compactDate(row.coway_proposed_edd)))}</td>
        <td class="fa-col-finish fa-grid-cell" data-fa-grid="commitment">
          <div class="fa-finish-field">
            <input type="text" class="fa-finish-input" data-fa-new-field="program_finish_at" data-ps="${ps}"
                   value="${escapeHtml(compactDate(row.program_finish_at))}"
                   placeholder="dd/mm/yy" autocomplete="off" spellcheck="false"
                   aria-label="Commitment date">
            <input type="date" class="fa-finish-picker" data-fa-finish-picker data-ps="${ps}"
                   value="${escapeHtml(parseFinishDate(row.program_finish_at))}"
                   tabindex="-1" aria-label="Pick commitment date">
          </div>
        </td>
        <td class="fa-col-machine fa-proposed-cnc-cell">${proposedCncPickerHtml(row, 'new')}</td>
        <td class="fa-col-priority fa-grid-cell" data-fa-grid="priority">${priorityButtonHtml(row)}</td>
        <td class="fa-col-pic fa-grid-cell" data-fa-grid="pic">${programPicCell(row)}</td>
        <td class="fa-col-remarks">
          <textarea class="fa-remarks" data-fa-new-field="remarks" data-ps="${ps}" rows="1" placeholder="Note">${escapeHtml(row.remarks || '')}</textarea>
        </td>
        <td class="fa-col-done${row.npi_complete ? ' is-done' : ''}">
          <label class="fa-done-check">
            <input type="checkbox" data-fa-new-field="npi_complete" data-ps="${ps}"
                   ${row.npi_complete ? 'checked' : ''} aria-label="Mark NPI job complete">
          </label>
        </td>
        <td class="fa-col-actions">${historyButton(row, 'new_part')}${remove}</td>
      </tr>
    `;
  }

  function groupedTableBodyHtml(groups, _view, { allowRemove }) {
    if (!groups.length) return '';
    return groups.map((group) => group.rows.map((row) => newPartRowHtml(row, { allowRemove })).join('')).join('');
  }

  function filterEmptyMessage(view, { typeSelected, history }) {
    if (!typeSelected) {
      return history
        ? 'Select a process sheet type to view history.'
        : 'Select a process sheet type to view NEW parts.';
    }
    if (view.assignedPicOnly) return 'No process sheets with an assigned PIC match this filter.';
    if (Object.keys(view.colFilters).length) {
      return history
        ? 'No completed process sheets match this type, search, or column filter.'
        : 'No NEW parts match this type, search, or column filter.';
    }
    return history
      ? 'No completed process sheets match this type or search filter.'
      : 'No NEW parts match this type or search filter.';
  }

  function activeFiltersHost(which) {
    const id = which === 'history' ? 'fa-history-active-filters' : 'fa-new-active-filters';
    let host = $(id);
    if (host) return host;
    const tableHost = $(which === 'history' ? 'fa-history-table-host' : 'fa-new-table-host');
    if (!tableHost || !tableHost.parentElement) return null;
    host = document.createElement('div');
    host.id = id;
    host.className = 'fa-active-filters';
    host.hidden = true;
    tableHost.parentElement.insertBefore(host, tableHost);
    return host;
  }

  function renderActiveFilters(which) {
    const host = activeFiltersHost(which);
    if (!host) return;
    const view = tableView(which);
    const filters = NEW_PART_COLUMNS.filter((col) => columnFilterActive(view, col.id)).map((col) => {
      const selected = view.colFilters[col.id] || [];
      const labels = selected.map((value) => colFilterLabel(value)).filter(Boolean);
      let text = labels.slice(0, 2).join(', ');
      if (labels.length > 2) text += ` +${labels.length - 2}`;
      if (!text) text = 'none';
      return { id: col.id, label: col.label, text };
    });
    const showSort = !isDefaultSort(view);
    if (!filters.length && !showSort) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    const sortChip = showSort
      ? `<button type="button" class="fa-filter-chip is-sort" data-fa-clear-sort data-fa-filter-table="${which}" title="Reset sort">Sorted by ${escapeHtml(sortSummary(view))} <span aria-hidden="true">×</span></button>`
      : '';
    const filterChips = filters.map((item) => (
      `<button type="button" class="fa-filter-chip" data-fa-clear-filter="${escapeHtml(item.id)}" data-fa-filter-table="${which}" title="Remove this filter">${escapeHtml(item.label)}: ${escapeHtml(item.text)} <span aria-hidden="true">×</span></button>`
    )).join('');
    const clear = filters.length
      ? `<button type="button" class="fa-filter-chip is-clear" data-fa-clear-all-filters data-fa-filter-table="${which}">Clear filters</button>`
      : '';
    host.hidden = false;
    host.innerHTML = `${sortChip}${filterChips}${clear}`;
  }

  function renderNewTable() {
    closePriorityMenu();
    resetGridSelection();
    const host = $('fa-new-table-host');
    const empty = $('fa-new-empty');
    const body = $('fa-new-table-body');
    const grouped = groupedNewRows();
    const rows = grouped.rows;
    renderNewTypeChips();
    syncAssignedPicChip('new');
    renderNewPartHead('fa-new-table', state.newView);
    renderActiveFilters('new');
    updateNewCount();
    if (state.tab === 'new') {
      if (!state.newLoaded) {
        $('fa-subtitle').textContent = 'Loading NEW parts from S/O management...';
      } else {
        const counts = newTypeCounts();
        const present = PS_TYPE_ORDER.filter((label) => counts[label]);
        const allSelected = present.length > 0 && present.every((label) => state.newTypes.has(label));
        const labels = selectedNewTypeLabels().join(' / ') || 'selected types';
        const exceptionCount = state.newRows.filter(isExceptionRow).length;
        const exceptionPart = exceptionCount
          ? ` · ${exceptionCount} exception${exceptionCount === 1 ? '' : 's'}`
          : '';
        const picPart = state.newView.assignedPicOnly ? ' with assigned PIC' : '';
        $('fa-subtitle').textContent = allSelected
          ? `${rows.length} NEW part${rows.length === 1 ? '' : 's'} from active S/O management${picPart}${exceptionPart}`
          : `${rows.length} NEW ${labels} part${rows.length === 1 ? '' : 's'} of ${state.newRows.length}${picPart}${exceptionPart}`;
      }
    }
    if (!state.newRows.length) {
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'No NEW parts in active S/O management. Add an exception to track a process sheet that is not tagged NEW.';
      }
      return;
    }
    if (host) host.hidden = false;
    if (!rows.length) {
      if (empty) empty.hidden = true;
      if (body) {
        body.innerHTML = `<tr><td colspan="${NEW_PART_COLUMNS.length}" class="fa-so-collapsed">${escapeHtml(filterEmptyMessage(state.newView, { typeSelected: state.newTypes.size, history: false }))}</td></tr>`;
      }
      if (state.openFilterTable === 'new' && state.openFilterCol) repositionColumnFilter();
      return;
    }
    if (empty) empty.hidden = true;
    if (!body) return;
    body.innerHTML = groupedTableBodyHtml(grouped.groups, state.newView, { allowRemove: true });
    if (state.openFilterTable === 'new' && state.openFilterCol) repositionColumnFilter();
    repositionProposedCncPopover();
  }

  function renderHistoryTable() {
    closePriorityMenu();
    resetGridSelection();
    const host = $('fa-history-table-host');
    const empty = $('fa-completed-empty');
    const body = $('fa-history-table-body');
    const grouped = groupedCompletedRows();
    const rows = grouped.rows;
    renderCompletedTypeChips();
    syncAssignedPicChip('history');
    renderNewPartHead('fa-history-table', state.completedView);
    renderActiveFilters('history');
    updateHistoryCount();
    if (state.tab === 'history') {
      if (!state.completedLoaded) {
        $('fa-subtitle').textContent = 'Loading completed process sheets...';
      } else {
        const counts = completedTypeCounts();
        const present = PS_TYPE_ORDER.filter((label) => counts[label]);
        const allSelected = present.length > 0 && present.every((label) => state.completedTypes.has(label));
        const labels = selectedCompletedTypeLabels().join(' / ') || 'selected types';
        const picPart = state.completedView.assignedPicOnly ? ' with assigned PIC' : '';
        $('fa-subtitle').textContent = allSelected
          ? `${rows.length} completed process sheet${rows.length === 1 ? '' : 's'}${picPart}`
          : `${rows.length} completed ${labels} of ${state.completedRows.length}${picPart}`;
      }
    }
    if (!state.completedRows.length) {
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'No completed NEW process sheets yet. When WO / S/O status is complete, the row moves here with PIC, remarks, and commitment date kept.';
      }
      if (body) body.innerHTML = '';
      return;
    }
    if (host) host.hidden = false;
    if (!rows.length) {
      if (empty) empty.hidden = true;
      if (body) {
        body.innerHTML = `<tr><td colspan="${NEW_PART_COLUMNS.length}" class="fa-so-collapsed">${escapeHtml(filterEmptyMessage(state.completedView, { typeSelected: state.completedTypes.size, history: true }))}</td></tr>`;
      }
      if (state.openFilterTable === 'history' && state.openFilterCol) repositionColumnFilter();
      return;
    }
    if (empty) empty.hidden = true;
    if (!body) return;
    body.innerHTML = groupedTableBodyHtml(grouped.groups, state.completedView, { allowRemove: false });
    if (state.openFilterTable === 'history' && state.openFilterCol) repositionColumnFilter();
    repositionProposedCncPopover();
  }

  function setTab(tab, options) {
    const persistHash = options && options.persistHash;
    const next = tab === 'new' ? 'new' : (tab === 'history' ? 'history' : 'flagged');
    if (next !== state.tab) {
      closeColumnFilter();
      closeProposedCncPopover();
    }
    state.tab = next;
    document.querySelectorAll('[data-fa-tab]').forEach((btn) => {
      const active = btn.getAttribute('data-fa-tab') === next;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const flagged = $('fa-panel-flagged');
    const neu = $('fa-panel-new');
    const hist = $('fa-panel-history');
    if (flagged) flagged.hidden = next !== 'flagged';
    if (neu) neu.hidden = next !== 'new';
    if (hist) hist.hidden = next !== 'history';
    if (persistHash !== false) {
      const hash = next === 'new' ? '#new' : (next === 'history' ? '#history' : '#flagged');
      if (window.location.hash !== hash) {
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
      }
    }
    if (next === 'new') {
      renderNewTable();
      if (!state.newLoaded) loadNewParts();
    } else if (next === 'history') {
      renderHistoryTable();
      if (!state.completedLoaded) loadCompletedParts();
    } else {
      renderTable();
    }
    syncExportButton();
    syncLoading();
  }

  function renderPicList() {
    const list = $('fa-pic-list');
    const empty = $('fa-pic-empty');
    if (!list) return;
    if (!state.pics.length) {
      list.innerHTML = '';
      if (empty) empty.hidden = false;
      renderPicDatalist();
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = state.pics.map((pic) => (
      `<li>
        <span>${escapeHtml(pic.name)}</span>
        <button type="button" class="fa-btn fa-btn--danger" data-fa-delete-pic="${pic.pic_id}">Delete</button>
      </li>`
    )).join('');
    renderPicDatalist();
  }

  function renderPicDatalist() {
    let list = $('fa-pic-datalist');
    if (!list) {
      list = document.createElement('datalist');
      list.id = 'fa-pic-datalist';
      document.body.appendChild(list);
    }
    list.innerHTML = state.pics.map((pic) => (
      `<option value="${escapeHtml(pic.name)}"></option>`
    )).join('');
  }

  function jobKey(job) {
    return String(job?.process_sheet_no || job?.pp_voucher_no || '').trim().toUpperCase();
  }

  function mergePics(pics) {
    (pics || []).forEach((pic) => {
      if (!pic || !pic.pic_id) return;
      if (!state.pics.some((item) => Number(item.pic_id) === Number(pic.pic_id))) {
        state.pics.push(pic);
      }
    });
    state.pics.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    renderPicDatalist();
  }

  function applyRow(updated, options) {
    if (!updated || !updated.first_article_id) return;
    const index = state.rows.findIndex((row) => Number(row.first_article_id) === Number(updated.first_article_id));
    if (index >= 0) state.rows[index] = updated;
    else state.rows.unshift(updated);
    mergePics(updated.pics);
    if (options && options.render) renderTable();
  }

  const loadsInFlight = { flagged: 0, new: 0, history: 0 };

  function loadingLabel(tab) {
    if (tab === 'new') return 'Loading new parts...';
    if (tab === 'history') return 'Loading history...';
    return 'Loading NPI tracker...';
  }

  function syncLoading() {
    const loading = $('fa-loading');
    if (!loading) return;
    const tab = state.tab === 'new' || state.tab === 'history' ? state.tab : 'flagged';
    const busy = (loadsInFlight[tab] || 0) > 0;
    loading.hidden = !busy;
    const label = loading.querySelector('[data-fa-loading-label]');
    if (label) label.textContent = loadingLabel(tab);
  }

  async function withTabLoad(tab, work) {
    loadsInFlight[tab] = (loadsInFlight[tab] || 0) + 1;
    syncLoading();
    try {
      return await work();
    } finally {
      loadsInFlight[tab] = Math.max(0, (loadsInFlight[tab] || 1) - 1);
      syncLoading();
    }
  }

  async function loadTracker() {
    const empty = $('fa-empty');
    if (state.tab === 'flagged' && empty) empty.hidden = true;
    showAlert('');
    return withTabLoad('flagged', async () => {
      try {
        const data = await api(API.list, {
          timeoutMs: 30000,
          timeoutMessage: 'Timed out loading NPI tracker',
        });
        state.rows = data.rows || [];
        state.pics = data.pics || [];
        state.machines = data.machines || state.machines || [];
        renderPicList();
        renderTable();
      } catch (err) {
        showAlert(err.message || 'Could not load first article tracker');
        if (!state.rows.length && empty) {
          empty.hidden = false;
          empty.textContent = 'Could not load the tracker. Try Refresh.';
        }
      }
    });
  }

  async function loadNewParts() {
    const empty = $('fa-new-empty');
    if (state.tab === 'new' && empty) empty.hidden = true;
    showAlert('');
    return withTabLoad('new', async () => {
      try {
        const data = await api(API.newParts, {
          timeoutMs: 45000,
          timeoutMessage: 'Timed out loading new parts',
        });
        state.newRows = data.rows || [];
        if (Array.isArray(data.pics)) {
          state.pics = data.pics;
          renderPicList();
        }
        if (Array.isArray(data.machines) && data.machines.length) {
          state.machines = data.machines;
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
      }
    });
  }

  async function loadCompletedParts() {
    const empty = $('fa-completed-empty');
    if (state.tab === 'history' && empty) empty.hidden = true;
    showAlert('');
    return withTabLoad('history', async () => {
      try {
        const data = await api(`${API.newParts}?scope=history`, {
          timeoutMs: 120000,
          timeoutMessage: 'Timed out loading history',
        });
        state.completedRows = data.rows || [];
        if (Array.isArray(data.pics)) {
          state.pics = data.pics;
          renderPicList();
        }
        if (Array.isArray(data.machines) && data.machines.length) {
          state.machines = data.machines;
        }
        state.completedLoaded = true;
        if (!state.completedTypes.size) ensureCompletedTypes();
        renderHistoryTable();
      } catch (err) {
        showAlert(err.message || 'Could not load completed process sheets');
        state.completedLoaded = true;
        if (!state.completedRows.length && empty) {
          empty.hidden = false;
          empty.textContent = 'Could not load completed process sheets. Try Refresh.';
        }
        updateHistoryCount();
      }
    });
  }

  function newRowByPs(ps) {
    const key = String(ps || '').trim().toUpperCase();
    return state.newRows.find((row) => newRowKey(row) === key)
      || state.completedRows.find((row) => newRowKey(row) === key);
  }

  function applyNewRow(updated, { render } = {}) {
    if (!updated) return;
    const key = newRowKey(updated);
    const fromNew = state.newRows.findIndex((row) => newRowKey(row) === key);
    const fromHist = state.completedRows.findIndex((row) => newRowKey(row) === key);
    const prev = fromNew >= 0
      ? state.newRows[fromNew]
      : (fromHist >= 0 ? state.completedRows[fromHist] : null);
    const merged = prev ? { ...prev, ...updated } : updated;
    if (fromNew >= 0) state.newRows.splice(fromNew, 1);
    if (fromHist >= 0) state.completedRows.splice(fromHist, 1);
    const kind = newRowPsType(merged);
    if (isCompleteStatus(merged)) {
      state.completedRows.unshift(merged);
      if (kind) state.completedTypes.add(kind);
    } else {
      state.newRows.unshift(merged);
      if (kind) state.newTypes.add(kind);
    }
    if (render !== false) {
      renderNewTable();
      if (state.completedLoaded || state.tab === 'history') renderHistoryTable();
    }
  }

  async function saveNewPatch(ps, patch, { render, apply } = {}) {
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
    if (apply !== false) applyNewRow(data.row, { render });
    return data.row;
  }

  function hideSearch() {
    const list = $('fa-ps-results');
    if (!list) return;
    list.hidden = true;
    list.innerHTML = '';
    $('fa-ps-search')?.setAttribute('aria-expanded', 'false');
  }

  function hideExceptionSearch() {
    const list = $('fa-new-exception-results');
    if (!list) return;
    list.hidden = true;
    list.innerHTML = '';
    $('fa-new-exception-search')?.setAttribute('aria-expanded', 'false');
  }

  function exceptionAlreadyOnList(hit) {
    const key = jobKey(hit);
    if (!key) return false;
    return state.newRows.some((row) => newRowKey(row) === key);
  }

  function renderExceptionHits(hits, status) {
    const list = $('fa-new-exception-results');
    if (!list) return;
    list.hidden = false;
    $('fa-new-exception-search')?.setAttribute('aria-expanded', 'true');
    if (status) {
      list.innerHTML = `<div class="fa-typeahead-status">${escapeHtml(status)}</div>`;
      return;
    }
    if (!hits.length) {
      const query = String($('fa-new-exception-search')?.value || '').trim();
      const already = exceptionAlreadyOnList({ process_sheet_no: query });
      state.exceptionHits = query ? [{
        process_sheet_no: query,
        pp_voucher_no: '',
        already_on_list: already,
        flag_anyway: true,
      }] : [];
      if (!query) {
        list.innerHTML = '<div class="fa-typeahead-status">No matching process sheet in S/O management.</div>';
        return;
      }
      hits = state.exceptionHits;
    }
    list.innerHTML = hits.map((hit, index) => {
      const already = hit.already_on_list || exceptionAlreadyOnList(hit);
      const desc = [hit.part_no, hit.part_description].filter(Boolean).join(' | ');
      const source = psSourceLabel(hit);
      const action = already ? 'Already on list' : (hit.flag_anyway ? 'Add anyway' : 'Add');
      return `
        <button type="button" class="fa-typeahead-item${already ? ' is-flagged' : ''}${index === 0 ? ' is-active' : ''}"
                role="option" data-index="${index}" ${already ? 'disabled' : ''}>
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

  async function runExceptionSearch(query) {
    const needle = String(query || '').trim();
    if (needle.length < 2) {
      hideExceptionSearch();
      return;
    }
    renderExceptionHits([], 'Searching...');
    try {
      const data = await api(`${API.search}?q=${encodeURIComponent(needle)}`);
      if (String($('fa-new-exception-search')?.value || '').trim() !== needle) return;
      state.exceptionHits = (data.rows || []).map((hit) => ({
        ...hit,
        already_on_list: exceptionAlreadyOnList(hit),
      }));
      renderExceptionHits(state.exceptionHits);
    } catch (err) {
      renderExceptionHits([], err.message || 'Search failed');
    }
  }

  async function addExceptionHit(hit) {
    if (!hit || hit.already_on_list || exceptionAlreadyOnList(hit)) {
      setStatus('fa-new-exception-status', 'Already on the NEW parts list', 'saved');
      return;
    }
    setStatus('fa-new-exception-status', 'Adding exception...');
    try {
      const data = await api(API.newParts, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          process_sheet_no: hit.process_sheet_no,
          pp_voucher_no: hit.pp_voucher_no,
        }),
      });
      applyNewRow(data.row);
      $('fa-new-exception-search').value = '';
      hideExceptionSearch();
      setStatus(
        'fa-new-exception-status',
        data.message || (data.created ? `Added ${data.row.process_sheet_no}` : `${data.row.process_sheet_no} is already on the list`),
        'saved',
      );
    } catch (err) {
      setStatus('fa-new-exception-status', err.message || 'Could not add exception', 'error');
    }
  }

  async function addTypedException() {
    const processSheetNo = String($('fa-new-exception-search')?.value || '').trim();
    if (!processSheetNo) {
      setStatus('fa-new-exception-status', 'Type a process sheet number first', 'error');
      return;
    }
    const first = state.exceptionHits.find((hit) => !hit.already_on_list && !exceptionAlreadyOnList(hit));
    await addExceptionHit(first || { process_sheet_no: processSheetNo, pp_voucher_no: '' });
  }

  async function removeException(ps) {
    const row = newRowByPs(ps);
    const label = row?.process_sheet_no || ps || 'this exception';
    if (!window.confirm(`Remove ${label} from the NEW parts list?`)) return;
    try {
      const data = await api(`${API.newParts}/${encodeURIComponent(ps)}`, { method: 'DELETE' });
      if (data.still_on_list && data.row) {
        applyNewRow(data.row);
      } else {
        state.newRows = state.newRows.filter((item) => newRowKey(item) !== String(ps || '').trim().toUpperCase());
        renderNewTable();
      }
      setStatus('fa-new-exception-status', `Removed ${label}`, 'saved');
    } catch (err) {
      showAlert(err.message || 'Could not remove exception');
    }
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
      applyRow(data.row, { render: true });
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

  function formatHistoryValue(fieldName, value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return '(empty)';
    if (fieldName === 'program_finish_at') {
      return formatFinishDate(text) || text;
    }
    return text;
  }

  function closeHistoryModal() {
    const modal = $('fa-history-modal');
    if (!modal) return;
    modal.hidden = true;
  }

  function renderHistoryList() {
    const list = $('fa-history-list');
    const empty = $('fa-change-history-empty');
    const rows = state.history.rows || [];
    if (!list) return;
    if (!rows.length) {
      list.innerHTML = '';
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'No changes recorded yet. Edits to priority, PIC, remarks, and commitment date will appear here.';
      }
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = rows.map((item) => {
      const field = String(item.field_label || item.field_name || 'Field').trim();
      const when = formatHistoryWhen(item.changed_at);
      const oldValue = formatHistoryValue(item.field_name, item.old_value);
      const newValue = formatHistoryValue(item.field_name, item.new_value);
      return `
        <li class="fa-history-item">
          <p class="fa-history-when">${escapeHtml(when || 'Unknown time')}</p>
          <p class="fa-history-field">${escapeHtml(field)}</p>
          <p class="fa-history-change">
            <span class="fa-history-old">${escapeHtml(oldValue)}</span>
            <span class="fa-history-arrow" aria-hidden="true">\u2192</span>
            <span class="fa-history-new">${escapeHtml(newValue)}</span>
          </p>
        </li>
      `;
    }).join('');
  }

  async function openHistoryModal(source, processSheetNo, partNo) {
    const modal = $('fa-history-modal');
    if (!modal || !processSheetNo) return;
    state.history.source = source;
    state.history.processSheetNo = processSheetNo;
    state.history.rows = [];
    modal.hidden = false;
    const sub = $('fa-history-modal-sub');
    if (sub) {
      const part = String(partNo || '').trim();
      sub.textContent = part ? `${processSheetNo} · ${part}` : processSheetNo;
    }
    const loading = $('fa-history-loading');
    const empty = $('fa-change-history-empty');
    if (loading) loading.hidden = false;
    if (empty) empty.hidden = true;
    renderHistoryList();
    setStatus('fa-history-status', '');
    try {
      const data = await api(
        `${API.history}?source=${encodeURIComponent(source)}&process_sheet_no=${encodeURIComponent(processSheetNo)}`,
      );
      state.history.rows = data.rows || [];
      renderHistoryList();
    } catch (err) {
      setStatus('fa-history-status', err.message || 'Could not load history', 'error');
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'Could not load history.';
      }
    } finally {
      if (loading) loading.hidden = true;
    }
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

  function openImportModal() {
    const modal = $('fa-import-modal');
    if (!modal) return;
    setStatus('fa-import-status', '');
    modal.hidden = false;
  }

  function closeImportModal() {
    const modal = $('fa-import-modal');
    if (!modal) return;
    modal.hidden = true;
    const input = $('fa-import-file');
    if (input) input.value = '';
  }

  function importSummary(data) {
    const created = Number(data.created_count || 0);
    const updated = Number(data.updated_count || 0);
    const missing = Number(data.missing_erp_count || 0);
    const errors = Number(data.error_count || 0);
    const parts = [];
    if (created) parts.push(`Imported ${created} new`);
    if (updated) parts.push(`updated ${updated}`);
    if (!created && !updated) parts.push('No rows imported');
    if (missing) parts.push(`${missing} not in ERP yet (kept as quotation)`);
    if (errors) parts.push(`${errors} failed`);
    return parts.join('. ');
  }

  async function importExcelFile(file) {
    if (!file) return;
    const name = String(file.name || '').toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.xlsm') && !name.endsWith('.xls')) {
      setStatus('fa-import-status', 'Upload an .xlsx or .xls workbook', 'error');
      return;
    }
    const body = new FormData();
    body.append('file', file);
    state.busy = true;
    setStatus('fa-import-status', `Importing ${file.name}...`);
    try {
      const data = await api(API.import, { method: 'POST', body, timeoutMs: 120000 });
      (data.created || []).forEach((row) => applyRow(row));
      (data.updated || []).forEach((row) => applyRow(row));
      if (Array.isArray(data.pics)) {
        state.pics = data.pics;
        renderPicList();
      }
      renderTable();
      if (state.newLoaded) loadNewParts();
      if (state.completedLoaded) loadCompletedParts();
      const message = importSummary(data);
      setStatus('fa-add-status', message, Number(data.error_count || 0) ? 'error' : 'saved');
      closeImportModal();
    } catch (err) {
      setStatus('fa-import-status', err.message || 'Could not import Excel', 'error');
    } finally {
      state.busy = false;
      const input = $('fa-import-file');
      if (input) input.value = '';
    }
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
      (data.created || []).forEach((row) => applyRow(row));
      (data.already_flagged || []).forEach((row) => applyRow(row));
      renderTable();
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

  function proposedCncPopover() {
    return $('fa-proposed-cnc-popover');
  }

  function closeProposedCncPopover() {
    const pop = proposedCncPopover();
    if (pop) pop.hidden = true;
    state.openProposedCncKey = '';
    state.proposedCncQuery = '';
    state.proposedCncSource = '';
    document.querySelectorAll('.fa-proposed-cnc-btn.is-open').forEach((btn) => {
      btn.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  function repositionProposedCncPopover() {
    const pop = proposedCncPopover();
    if (!pop || pop.hidden || !state.openProposedCncKey) return;
    const btn = document.querySelector(
      `.fa-proposed-cnc-btn[data-fa-cnc-key="${CSS.escape(state.openProposedCncKey)}"]`
    );
    if (!btn) {
      closeProposedCncPopover();
      return;
    }
    const rect = btn.getBoundingClientRect();
    const width = Math.max(220, Math.min(280, window.innerWidth - 16));
    let left = rect.left;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    let top = rect.bottom + 4;
    const maxHeight = 320;
    if (top + 180 > window.innerHeight && rect.top > 200) {
      top = Math.max(8, rect.top - Math.min(maxHeight, 280) - 4);
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.width = `${width}px`;
  }

  function setProposedCncStatus(key, kind, message) {
    document.querySelectorAll(`.fa-proposed-cnc-btn[data-fa-cnc-key="${CSS.escape(key)}"]`).forEach((btn) => {
      const status = btn.parentElement?.querySelector('.fa-proposed-cnc-status');
      if (!status) return;
      status.className = `fa-proposed-cnc-status${kind ? ` is-${kind}` : ''}`;
      status.textContent = message || '';
    });
  }

  function syncProposedCncButtons(key, machines) {
    document.querySelectorAll(`.fa-proposed-cnc-btn[data-fa-cnc-key="${CSS.escape(key)}"]`).forEach((btn) => {
      const value = btn.querySelector('.fa-proposed-cnc-btn-value');
      if (value) {
        value.innerHTML = proposedCncValueHtml(machines, btn.getAttribute('data-fa-cnc-source') || '');
      }
      btn.classList.toggle('has-value', machines.length > 0);
      btn.classList.toggle('is-open', state.openProposedCncKey === key);
      btn.setAttribute('aria-expanded', state.openProposedCncKey === key ? 'true' : 'false');
    });
  }

  function rowForProposedCncKey(key) {
    const text = String(key || '');
    if (text.startsWith('tracker:')) {
      return rowById(text.slice('tracker:'.length));
    }
    if (text.startsWith('new:')) {
      return newRowByPs(text.slice('new:'.length));
    }
    return null;
  }

  function applyProposedCncLocal(row, source, machines) {
    if (!row) return;
    if (source === 'tracker') {
      row.machine_codes = machines;
      row.machine_cnc = machines.join(', ');
      applyRow(row);
    } else {
      row.proposed_cnc = machines;
      applyNewRow(row, { render: false });
    }
    syncProposedCncButtons(proposedCncOpenKey(row, source), machines);
  }

  function renderProposedCncPopover() {
    const pop = proposedCncPopover();
    const key = state.openProposedCncKey;
    if (!pop || !key) return;
    const row = rowForProposedCncKey(key);
    const selected = proposedCncMachines(row);
    const selectedSet = new Set(selected.map((item) => faNormalizeCncMachine(item).toUpperCase()).filter(Boolean));
    const query = String(state.proposedCncQuery || '').trim().toLowerCase();
    const matches = (name) => (
      !query || name.toLowerCase().includes(query) || String(faCncMachineNumber(name)) === query
    );
    const checkHtml = (name) => {
      const checked = selectedSet.has(name.toUpperCase()) ? ' checked' : '';
      return `<label class="fa-col-filter-check fa-proposed-cnc-check">
          <input type="checkbox" data-fa-cnc-machine="${escapeHtml(name)}"${checked} />
          ${escapeHtml(name)}
        </label>`;
    };
    const nonCnc = FA_NON_CNC_OPTIONS.filter(matches);
    const catalog = faCncMachineCatalog(selected).filter(matches);
    const nonCncHtml = nonCnc.length
      ? `<div class="fa-proposed-cnc-other">
          <div class="fa-proposed-cnc-group-label">Not CNC</div>
          ${nonCnc.map(checkHtml).join('')}
        </div>`
      : '';
    const checks = catalog.length
      ? catalog.map(checkHtml).join('')
      : (nonCnc.length ? '' : '<p class="fa-col-filter-empty">No matching CNC machines</p>');
    const cncLabel = catalog.length && nonCnc.length
      ? '<div class="fa-proposed-cnc-group-label">CNC</div>'
      : '';
    pop.innerHTML = `
      <div class="fa-col-filter-title">Proposed CNC</div>
      <input type="search" class="fa-col-filter-search fa-proposed-cnc-search" value="${escapeHtml(state.proposedCncQuery || '')}" placeholder="Search or type CNC…" autocomplete="off" />
      ${nonCncHtml}
      <div class="fa-proposed-cnc-checks">${cncLabel}${checks}</div>
      <form class="fa-proposed-cnc-add" data-action="add-proposed-cnc">
        <input type="text" class="fa-col-filter-search fa-proposed-cnc-add-input" placeholder="Add CNC 22" autocomplete="off" />
        <button type="submit" class="fa-btn fa-btn--ghost">Add</button>
      </form>
      <div class="fa-col-filter-actions">
        <button type="button" class="fa-btn fa-btn--ghost" data-action="clear-proposed-cnc">Clear</button>
      </div>
    `;
    pop.hidden = false;
    repositionProposedCncPopover();
  }

  function openProposedCncPopover(btn) {
    const key = String(btn?.dataset?.faCncKey || '').trim();
    const source = String(btn?.dataset?.faCncSource || '').trim() || 'new';
    if (!key) return;
    if (state.openProposedCncKey === key && proposedCncPopover() && !proposedCncPopover().hidden) {
      closeProposedCncPopover();
      return;
    }
    closeColumnFilter();
    state.openProposedCncKey = key;
    state.proposedCncSource = source;
    state.proposedCncQuery = '';
    document.querySelectorAll('.fa-proposed-cnc-btn.is-open').forEach((el) => {
      el.classList.remove('is-open');
      el.setAttribute('aria-expanded', 'false');
    });
    btn.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    renderProposedCncPopover();
    proposedCncPopover()?.querySelector('.fa-proposed-cnc-search')?.focus();
  }

  const proposedCncPending = new Map();

  function syncProposedCncChecks(machines) {
    const pop = proposedCncPopover();
    if (!pop || pop.hidden) return;
    const selected = new Set(
      (machines || []).map((item) => faNormalizeCncMachine(item).toUpperCase()).filter(Boolean),
    );
    pop.querySelectorAll('[data-fa-cnc-machine]').forEach((input) => {
      const name = faNormalizeCncMachine(input.getAttribute('data-fa-cnc-machine')).toUpperCase();
      input.checked = selected.has(name);
    });
  }

  function queueProposedCncSave(row, source, machines) {
    const next = (machines || []).map(faNormalizeCncMachine).filter(Boolean);
    if (!row) return;
    const key = proposedCncOpenKey(row, source);
    applyProposedCncLocal(row, source, next);
    if (state.openProposedCncKey === key) syncProposedCncChecks(next);
    proposedCncPending.set(key, next);
    flushProposedCncSave(key);
  }

  async function flushProposedCncSave(key) {
    const flight = `${key}::save`;
    if (state.saveInFlight.has(flight) || !proposedCncPending.has(key)) return;
    const next = proposedCncPending.get(key).slice();
    proposedCncPending.delete(key);
    const row = rowForProposedCncKey(key);
    const source = String(key || '').startsWith('tracker:') ? 'tracker' : 'new';
    if (!row) return;
    state.saveInFlight.add(flight);
    setProposedCncStatus(key, 'saving', 'Saving…');
    try {
      let saved = null;
      if (source === 'tracker') {
        saved = await savePatch(row.first_article_id, { machine_codes: next });
      } else {
        saved = await saveNewPatch(
          row.process_sheet_no || row.pp_voucher_no,
          { proposed_cnc: next },
          { render: false, apply: false },
        );
      }
      if (proposedCncPending.has(key)) return;
      const sameSheet = !saved || source === 'tracker' || newRowKey(saved) === newRowKey(row);
      const machinesSaved = source === 'tracker'
        ? (Array.isArray(saved?.machine_codes) ? saved.machine_codes.filter(Boolean) : next)
        : (sameSheet && Array.isArray(saved?.proposed_cnc) ? saved.proposed_cnc.filter(Boolean) : next);
      applyProposedCncLocal(rowForProposedCncKey(key) || row, source, machinesSaved);
      if (state.openProposedCncKey === key) syncProposedCncChecks(machinesSaved);
      setProposedCncStatus(key, 'saved', 'Saved');
      window.setTimeout(() => setProposedCncStatus(key, '', ''), 1500);
    } catch (err) {
      if (proposedCncPending.has(key)) return;
      setProposedCncStatus(key, 'error', err.message || 'Save failed');
      showAlert(err.message || 'Save failed');
    } finally {
      state.saveInFlight.delete(flight);
      if (proposedCncPending.has(key)) flushProposedCncSave(key);
    }
  }

  function saveProposedCnc(row, source, machines) {
    queueProposedCncSave(row, source, machines);
  }

  function toggleProposedCncMachine(row, source, machine, checked) {
    const current = proposedCncMachines(row);
    const next = [];
    const seen = new Set();
    current.forEach((item) => {
      const name = faNormalizeCncMachine(item);
      const itemKey = name.toUpperCase();
      if (!name || seen.has(itemKey)) return;
      seen.add(itemKey);
      next.push(name);
    });
    const added = faNormalizeCncMachine(machine);
    const addedKey = added.toUpperCase();
    if (checked && added && !seen.has(addedKey)) next.push(added);
    if (!checked) {
      saveProposedCnc(row, source, next.filter((item) => item.toUpperCase() !== addedKey));
      return;
    }
    saveProposedCnc(row, source, next);
  }

  function bindProposedCncPicker() {
    const onOpen = (e) => {
      const btn = e.target.closest('.fa-proposed-cnc-btn');
      if (!btn) return;
      e.stopPropagation();
      openProposedCncPopover(btn);
    };
    ['fa-table-body', 'fa-new-table-body', 'fa-history-table-body'].forEach((id) => {
      const body = $(id);
      if (!body || body.dataset.proposedCncBound === '1') return;
      body.dataset.proposedCncBound = '1';
      body.addEventListener('click', onOpen);
    });

    const pop = proposedCncPopover();
    if (!pop || pop.dataset.bound === '1') return;
    pop.dataset.bound = '1';
    pop.addEventListener('click', (e) => e.stopPropagation());
    pop.addEventListener('change', (e) => {
      const input = e.target.closest('[data-fa-cnc-machine]');
      if (!input) return;
      const row = rowForProposedCncKey(state.openProposedCncKey);
      if (!row) return;
      toggleProposedCncMachine(
        row,
        state.proposedCncSource || 'new',
        input.getAttribute('data-fa-cnc-machine'),
        input.checked,
      );
    });
    pop.addEventListener('input', (e) => {
      const search = e.target.closest('.fa-proposed-cnc-search');
      if (!search) return;
      state.proposedCncQuery = search.value || '';
      const active = document.activeElement === search;
      const start = search.selectionStart;
      renderProposedCncPopover();
      if (!active) return;
      const next = proposedCncPopover()?.querySelector('.fa-proposed-cnc-search');
      if (!next) return;
      next.focus();
      const pos = typeof start === 'number' ? start : next.value.length;
      next.setSelectionRange(pos, pos);
    });
    pop.addEventListener('submit', (e) => {
      const form = e.target.closest('[data-action="add-proposed-cnc"]');
      if (!form) return;
      e.preventDefault();
      const row = rowForProposedCncKey(state.openProposedCncKey);
      const input = form.querySelector('.fa-proposed-cnc-add-input');
      const typed = faNormalizeCncMachine(input?.value);
      if (!row || !typed) return;
      toggleProposedCncMachine(row, state.proposedCncSource || 'new', typed, true);
      if (input) input.value = '';
    });
    pop.addEventListener('click', (e) => {
      const clearBtn = e.target.closest('[data-action="clear-proposed-cnc"]');
      if (!clearBtn) return;
      const row = rowForProposedCncKey(state.openProposedCncKey);
      if (row) saveProposedCnc(row, state.proposedCncSource || 'new', []);
    });

    document.addEventListener('click', (e) => {
      const popEl = proposedCncPopover();
      if (!popEl || popEl.hidden) return;
      if (popEl.contains(e.target) || e.target.closest('.fa-proposed-cnc-btn')) return;
      closeProposedCncPopover();
    });
    window.addEventListener('resize', repositionProposedCncPopover);
    ['fa-table-host', 'fa-new-table-host', 'fa-history-table-host'].forEach((id) => {
      $(id)?.addEventListener('scroll', repositionProposedCncPopover, { passive: true });
    });
    document.querySelectorAll('.fa-table-scroll').forEach((el) => {
      el.addEventListener('scroll', repositionProposedCncPopover, { passive: true });
    });
  }

  function closePriorityMenu() {
    state.openPriorityPs = '';
    const pop = $('fa-priority-popover');
    if (!pop) return;
    pop.hidden = true;
    pop.innerHTML = '';
    document.querySelectorAll('.fa-priority-btn.is-open').forEach((btn) => {
      btn.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  function resetGridSelection() {
    grid.tableId = '';
    grid.anchor = null;
    grid.focus = null;
    grid.pending = null;
    grid.dragging = false;
    document.body.classList.remove('fa-grid-dragging');
  }

  function gridRows(table) {
    if (!table) return [];
    return [...table.querySelectorAll('tbody tr[data-ps]')];
  }

  function cellPos(td) {
    const tr = td.closest('tr');
    const table = td.closest('table');
    const row = gridRows(table).indexOf(tr);
    const col = [...tr.querySelectorAll('td[data-fa-grid]')].indexOf(td);
    return { row, col };
  }

  function selectedCells() {
    const table = $(grid.tableId);
    if (!table || !grid.anchor || !grid.focus) return [];
    const rows = gridRows(table);
    const r1 = Math.min(grid.anchor.row, grid.focus.row);
    const r2 = Math.max(grid.anchor.row, grid.focus.row);
    const c1 = Math.min(grid.anchor.col, grid.focus.col);
    const c2 = Math.max(grid.anchor.col, grid.focus.col);
    const out = [];
    for (let r = r1; r <= r2; r += 1) {
      const cells = [...(rows[r]?.querySelectorAll('td[data-fa-grid]') || [])];
      for (let c = c1; c <= c2; c += 1) {
        if (cells[c]) out.push(cells[c]);
      }
    }
    return out;
  }

  function paintGridSelection() {
    document.querySelectorAll('td.fa-grid-cell.is-selected, td.fa-grid-cell.is-active').forEach((td) => {
      td.classList.remove('is-selected', 'is-active');
    });
    const cells = selectedCells();
    cells.forEach((td) => td.classList.add('is-selected'));
    const table = $(grid.tableId);
    const rows = gridRows(table);
    const focusTd = rows[grid.focus?.row]?.querySelectorAll('td[data-fa-grid]')[grid.focus?.col];
    if (focusTd) focusTd.classList.add('is-active');
  }

  function gridCellText(td) {
    const col = td.getAttribute('data-fa-grid');
    if (col === 'priority') return priorityLabel(td.querySelector('.fa-priority-btn')?.getAttribute('data-fa-priority-value') || td.querySelector('.fa-priority-label')?.textContent);
    if (col === 'commitment') return String(td.querySelector('[data-fa-new-field="program_finish_at"]')?.value || '').trim();
    if (col === 'pic') {
      const select = td.querySelector('[data-fa-set-pic]');
      const option = select?.selectedOptions?.[0];
      const value = select?.value || '';
      if (!value || value === '__new') return '';
      return String(option?.textContent || '').trim();
    }
    return '';
  }

  function cellsToTsv(cells) {
    const byRow = new Map();
    cells.forEach((td) => {
      const pos = cellPos(td);
      if (!byRow.has(pos.row)) byRow.set(pos.row, []);
      byRow.get(pos.row).push({ col: pos.col, text: gridCellText(td) });
    });
    const rowIndexes = [...byRow.keys()].sort((a, b) => a - b);
    return rowIndexes.map((rowIndex) => {
      const items = byRow.get(rowIndex).sort((a, b) => a.col - b.col);
      const minCol = items[0].col;
      const maxCol = items[items.length - 1].col;
      const line = [];
      for (let col = minCol; col <= maxCol; col += 1) {
        const found = items.find((item) => item.col === col);
        line.push(found ? found.text : '');
      }
      return line.join('\t');
    }).join('\n');
  }

  function clipboardMatrix(text) {
    let raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (raw.endsWith('\n')) raw = raw.slice(0, -1);
    if (!raw) return [['']];
    return raw.split('\n').map((line) => line.split('\t'));
  }

  function interpretGridCell(col, raw) {
    const text = String(raw == null ? '' : raw).trim();
    const blank = !text || /^[-–—−]+$/.test(text) || /^(none|n\/a|na|blank|pic\.\.\.)$/i.test(text);
    if (col === 'priority') {
      if (blank) return { priority: '' };
      const key = normalizePriority(text);
      if (!key) throw new Error(`"${text}" is not a priority (Critical, High, Medium, Low)`);
      return { priority: key };
    }
    if (col === 'commitment') {
      if (blank) return { program_finish_at: '' };
      const iso = parseFinishDate(text);
      if (!iso) throw new Error(`"${text}" is not a date (dd/mm/yyyy)`);
      return { program_finish_at: iso };
    }
    if (col === 'pic') {
      if (blank) return { program_pic_ids: [] };
      const pic = state.pics.find((item) => String(item.name || '').trim().toLowerCase() === text.toLowerCase());
      if (!pic) throw new Error(`No PIC named "${text}"`);
      return { program_pic_ids: [Number(pic.pic_id)] };
    }
    throw new Error('That column cannot be pasted');
  }

  function paintGridCell(td, patch) {
    if ('priority' in patch) {
      const key = normalizePriority(patch.priority);
      const btn = td.querySelector('[data-fa-priority]');
      if (!btn) return;
      btn.className = `fa-priority-btn${key ? ` is-${key}` : ''}`;
      btn.setAttribute('data-fa-priority-value', key);
      btn.setAttribute('aria-label', key ? `Priority: ${priorityLabel(key)}` : 'Priority');
      btn.innerHTML = `${key ? priorityIcon(key) : '<span class="fa-priority-empty" aria-hidden="true">\u2014</span>'}<span class="fa-priority-label">${escapeHtml(priorityLabel(key) || '\u2014')}</span>`;
    }
    if ('program_finish_at' in patch) syncFinishField(td.querySelector('.fa-finish-field'), patch.program_finish_at || '');
    if ('program_pic_ids' in patch) {
      const select = td.querySelector('[data-fa-set-pic]');
      if (!select) return;
      const id = Number((patch.program_pic_ids || [])[0] || 0);
      select.value = id ? String(id) : '';
      select.classList.toggle('has-value', !!id);
    }
  }

  function pasteTargets(matrix) {
    const table = $(grid.tableId);
    const rows = gridRows(table);
    const selected = selectedCells();
    const single = matrix.length === 1 && matrix[0].length === 1;
    if (single && selected.length > 1) {
      return selected.map((td) => ({ td, raw: matrix[0][0] }));
    }
    const originRow = Math.min(grid.anchor.row, grid.focus.row);
    const originCol = Math.min(grid.anchor.col, grid.focus.col);
    const out = [];
    matrix.forEach((line, r) => {
      line.forEach((raw, c) => {
        const cells = [...(rows[originRow + r]?.querySelectorAll('td[data-fa-grid]') || [])];
        const td = cells[originCol + c];
        if (td) out.push({ td, raw });
      });
    });
    return out;
  }

  async function applyGridValues(pairs) {
    const errors = [];
    const byPs = new Map();
    pairs.forEach(({ td, raw }) => {
      const col = td.getAttribute('data-fa-grid');
      let patch;
      try {
        patch = interpretGridCell(col, raw);
      } catch (err) {
        errors.push(err.message || 'Could not paste');
        return;
      }
      paintGridCell(td, patch);
      const ps = td.closest('tr')?.getAttribute('data-ps') || '';
      if (!ps) return;
      const merged = byPs.get(ps) || {};
      Object.assign(merged, patch);
      byPs.set(ps, merged);
    });
    const uniqueErrors = [...new Set(errors)];
    if (!byPs.size) {
      if (uniqueErrors.length) showAlert(gridPasteAlert(uniqueErrors));
      return;
    }
    const results = await Promise.allSettled(
      [...byPs.entries()].map(([ps, patch]) => saveNewPatch(ps, patch, { render: false })),
    );
    const failed = results.filter((item) => item.status === 'rejected').length;
    if (failed || uniqueErrors.length) {
      const which = grid.tableId === 'fa-history-table' ? 'history' : 'new';
      rerenderTable(which);
      const message = gridPasteAlert(uniqueErrors);
      showAlert(failed ? `${message} ${failed} row${failed === 1 ? '' : 's'} could not be saved.`.trim() : message);
      return;
    }
    showAlert('');
    paintGridSelection();
  }

  function gridPasteAlert(errors) {
    const sample = String(errors[0] || '');
    if (/not a date/i.test(sample)) return 'Paste not saved. Commitment dates need to look like 30/09/2026.';
    if (/not a priority/i.test(sample)) return 'Paste not saved. Priority must be Critical, High, Medium, or Low.';
    if (/No PIC named/i.test(sample)) return 'Paste not saved. Copy a PIC name that is already in the list, such as Ananda, then paste it onto the selected PIC cells.';
    return 'Paste not saved.';
  }

  function editorHasTextSelection() {
    const el = document.activeElement;
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return false;
    if (el.type === 'date') return false;
    return typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd;
  }

  function shouldGridPaste(event) {
    const origin = event.target?.closest?.('td[data-fa-grid]');
    const table = $(grid.tableId);
    const active = document.activeElement;
    const inGrid = !!(table && active && (active === table || table.contains(active)));
    if (!grid.anchor || !table) return false;
    if (!inGrid && !origin) return false;
    if (origin && origin.closest('table')?.id !== grid.tableId) return false;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const multi = selectedCells().length > 1;
    const structured = /[\t\n]/.test(String(text));
    if (multi || structured) return true;
    const col = (origin || selectedCells()[0])?.getAttribute('data-fa-grid');
    if (col === 'pic' || col === 'priority') return true;
    if (col === 'commitment' && event.target?.closest?.('[data-fa-new-field="program_finish_at"]')) return false;
    return !!col;
  }

  function openPriorityMenu(ps, anchor) {
    const pop = $('fa-priority-popover');
    if (!pop || !anchor) return;
    state.openPriorityPs = ps;
    document.querySelectorAll('.fa-priority-btn.is-open').forEach((btn) => {
      btn.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
    });
    anchor.classList.add('is-open');
    anchor.setAttribute('aria-expanded', 'true');
    const current = normalizePriority(anchor.getAttribute('data-fa-priority-value') || newRowByPs(ps)?.priority);
    const options = [{ id: '', label: 'None' }].concat(PRIORITIES);
    pop.innerHTML = options.map((item) => {
      const selected = item.id === current ? ' is-selected' : '';
      const tone = item.id ? ` is-${item.id}` : '';
      return `<button type="button" class="fa-priority-option${tone}${selected}" role="option" data-fa-priority-pick="${escapeHtml(item.id)}" data-ps="${escapeHtml(ps)}">${item.id ? priorityIcon(item.id) : '<span class="fa-priority-empty" aria-hidden="true">\u2014</span>'}<span>${escapeHtml(item.label)}</span></button>`;
    }).join('');
    pop.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const width = Math.max(rect.width, 156);
    pop.style.width = `${width}px`;
    let top = rect.bottom + 4;
    let left = rect.left;
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
    const box = pop.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 8) top = Math.max(8, rect.top - box.height - 4);
    if (left + box.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - box.width - 8);
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  }

  function bindGrid() {
    document.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const inPopover = event.target.closest?.('#fa-priority-popover');
      const cell = event.target.closest?.('td[data-fa-grid]');
      if (!cell) {
        if (!inPopover) closePriorityMenu();
        if (!inPopover && !event.target.closest?.('.fa-col-filter-popover, .fa-modal-backdrop')) {
          resetGridSelection();
          paintGridSelection();
        }
        return;
      }
      if (event.target.closest?.('a')) return;
      const table = cell.closest('table');
      const pos = cellPos(cell);
      if (pos.row < 0 || pos.col < 0) return;
      if (event.shiftKey && grid.tableId === table.id && grid.anchor) {
        event.preventDefault();
        grid.focus = pos;
        paintGridSelection();
        closePriorityMenu();
        return;
      }
      grid.tableId = table.id;
      grid.anchor = pos;
      grid.focus = pos;
      grid.pending = { x: event.clientX, y: event.clientY };
      grid.dragging = false;
      paintGridSelection();
    });

    document.addEventListener('mousemove', (event) => {
      if (!grid.pending || !grid.anchor) return;
      const dx = Math.abs(event.clientX - grid.pending.x);
      const dy = Math.abs(event.clientY - grid.pending.y);
      if (!grid.dragging && dx + dy < 5) return;
      grid.dragging = true;
      document.body.classList.add('fa-grid-dragging');
      closePriorityMenu();
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const cell = under?.closest?.('td[data-fa-grid]');
      if (!cell || cell.closest('table')?.id !== grid.tableId) return;
      const pos = cellPos(cell);
      if (pos.row < 0 || pos.col < 0) return;
      grid.focus = pos;
      paintGridSelection();
      const selection = window.getSelection?.();
      if (selection && selection.rangeCount) selection.removeAllRanges();
    });

    document.addEventListener('mouseup', () => {
      if (!grid.pending) return;
      if (grid.dragging) {
        grid.suppressClick = true;
        window.setTimeout(() => { grid.suppressClick = false; }, 0);
        const active = document.activeElement;
        if (active && active.closest?.('td[data-fa-grid]')) active.blur();
        $(grid.tableId)?.focus({ preventScroll: true });
      }
      grid.pending = null;
      grid.dragging = false;
      document.body.classList.remove('fa-grid-dragging');
    });

    document.addEventListener('copy', (event) => {
      if (editorHasTextSelection()) return;
      const cells = selectedCells();
      if (!cells.length) return;
      const active = document.activeElement;
      if (active && !active.closest?.('td[data-fa-grid], #' + grid.tableId) && active !== $(grid.tableId)) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', cellsToTsv(cells));
    }, true);

    document.addEventListener('paste', (event) => {
      if (!shouldGridPaste(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      applyGridValues(pasteTargets(clipboardMatrix(text))).catch((err) => {
        showAlert(err.message || 'Paste failed');
      });
    }, true);

    document.addEventListener('keydown', (event) => {
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedCells().length && grid.tableId) {
        const active = document.activeElement;
        if (active && active.closest?.('input, textarea, select') && active.closest('td[data-fa-grid]') && selectedCells().length < 2) return;
        if (active && !active.closest?.('td[data-fa-grid], #' + grid.tableId) && active !== $(grid.tableId)) return;
        event.preventDefault();
        applyGridValues(selectedCells().map((td) => ({ td, raw: '' }))).catch((err) => {
          showAlert(err.message || 'Could not clear cells');
        });
      }
    });

    ['fa-new-table', 'fa-history-table'].forEach((id) => {
      const table = $(id);
      if (table) table.tabIndex = -1;
    });

    $('fa-priority-popover')?.addEventListener('click', async (event) => {
      const pick = event.target.closest('[data-fa-priority-pick]');
      if (!pick) return;
      const ps = pick.getAttribute('data-ps') || '';
      const key = pick.getAttribute('data-fa-priority-pick') || '';
      closePriorityMenu();
      try {
        await saveNewPatch(ps, { priority: key });
      } catch (err) {
        showAlert(err.message || 'Could not save priority');
      }
    });

    document.querySelectorAll('.fa-table-scroll').forEach((el) => {
      el.addEventListener('scroll', () => closePriorityMenu(), { passive: true });
    });
  }

  const NEW_PART_EXPORT_COLUMNS = [
    { id: 'process_sheet_no', label: 'PS', width: 16 },
    { id: 'part_no', label: 'Part', width: 22 },
    { id: 'part_description', label: 'Description', width: 36 },
    { id: 'bom', label: 'BOM', width: 10 },
    { id: 'stage', label: 'WO / Stage', width: 28 },
    { id: 'po_due_date', label: 'Due', width: 12 },
    { id: 'coway_proposed_edd', label: 'Coway proposed EDD', width: 20 },
    { id: 'program_finish_at', label: 'Commitment date', width: 18 },
    { id: 'proposed_cnc', label: 'Proposed CNC', width: 18 },
    { id: 'priority', label: 'Priority', width: 12 },
    { id: 'pic', label: 'PIC', width: 16 },
    { id: 'remarks', label: 'Remarks', width: 28 },
    { id: 'npi_complete', label: 'Done', width: 10 },
    { id: 'customer_name', label: 'Customer', width: 28 },
    { id: 'exception', label: 'Exception', width: 12 },
  ];
  const TRACKER_EXPORT_COLUMNS = [
    { id: 'process_sheet_no', label: 'PS no.', width: 16 },
    { id: 'part_no', label: 'Part No.', width: 22 },
    { id: 'part_description', label: 'Part Description', width: 36 },
    { id: 'total_qty', label: 'Total Qty', width: 12 },
    { id: 'po_due_date', label: 'PO Due Date', width: 14 },
    { id: 'posted_date', label: 'Posted', width: 12 },
    { id: 'stage', label: 'WO / Stage', width: 28 },
    { id: 'proposed_cnc', label: 'Proposed CNC', width: 18 },
    { id: 'coway_proposed_edd', label: 'Stipulated Coway EDD', width: 22 },
    { id: 'pic', label: 'PIC', width: 16 },
    { id: 'tooling', label: 'Tooling', width: 14 },
    { id: 'fixture', label: 'Fixture/Jig', width: 14 },
    { id: 'gauges', label: 'Gauges/CMM', width: 14 },
    { id: 'remarks', label: 'Remark', width: 28 },
    { id: 'status', label: 'Status', width: 12 },
  ];

  function exportStamp() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  }

  function exportQty(value) {
    if (value == null || String(value).trim() === '') return '';
    const text = String(value).trim().replace(/,/g, '');
    const num = Number(text);
    return Number.isFinite(num) ? num : String(value).trim();
  }

  function exportPicNames(pics) {
    return (pics || []).map((pic) => String(pic?.name || '').trim()).filter(Boolean).join(' / ');
  }

  function newPartExportValue(row, colId) {
    if (colId === 'process_sheet_no') return String(row.process_sheet_no || row.pp_voucher_no || '').trim();
    if (colId === 'part_no') return String(row.part_no || '').trim();
    if (colId === 'part_description') return String(row.part_description || '').trim();
    if (colId === 'total_qty') return exportQty(row.total_qty);
    if (colId === 'bom') return hasBom(row) ? 'Yes' : 'None';
    if (colId === 'material') {
      if (row.material_arrived) return 'In';
      if (row.material_date) return compactDate(row.material_date);
      return String(row.material_legacy || row.material_display || '').trim();
    }
    if (colId === 'stage') return stageFilterLabel(row);
    if (colId === 'posted_date') return compactDate(row.posted_date);
    if (colId === 'po_due_date') return compactDate(row.po_due_date);
    if (colId === 'coway_proposed_edd') return compactDate(row.coway_proposed_edd) || String(row.coway_proposed_edd || '').trim();
    if (colId === 'program_finish_at') return compactDate(row.program_finish_at);
    if (colId === 'proposed_cnc') return proposedCncMachines(row).join(', ');
    if (colId === 'priority') return priorityLabel(row.priority);
    if (colId === 'pic') return exportPicNames(row.program_pics);
    if (colId === 'remarks') return String(row.remarks || '').trim();
    if (colId === 'npi_complete') return row.npi_complete ? 'Yes' : 'No';
    if (colId === 'sales_order_no') return String(row.sales_order_no || '').trim();
    if (colId === 'customer_name') return String(row.customer_name || '').trim();
    if (colId === 'exception') return isExceptionRow(row) ? 'Yes' : '';
    return '';
  }

  function trackerExportValue(row, colId) {
    if (colId === 'process_sheet_no') return String(row.process_sheet_no || row.pp_voucher_no || '').trim();
    if (colId === 'part_no') return String(row.part_no || '').trim();
    if (colId === 'part_description') return String(row.part_description || '').trim();
    if (colId === 'total_qty') return exportQty(row.total_qty);
    if (colId === 'po_due_date') return compactDate(row.po_due_date);
    if (colId === 'posted_date') return compactDate(row.posted_date);
    if (colId === 'stage') return stageFilterLabel(row);
    if (colId === 'proposed_cnc') return proposedCncMachines(row).join(', ');
    if (colId === 'coway_proposed_edd') return compactDate(row.coway_proposed_edd) || String(row.coway_proposed_edd || '').trim();
    if (colId === 'pic') return exportPicNames(row.pics);
    if (colId === 'tooling' || colId === 'fixture' || colId === 'gauges') return checkDisplayValue(row, colId);
    if (colId === 'remarks') return String(row.remarks || '').trim();
    if (colId === 'status') {
      if (row.on_new_parts || row.is_new_part) return 'PO';
      if (row.from_quotation && !row.in_sales_orders) return 'QUOTE';
    }
    return '';
  }

  function exportListSpec() {
    const stamp = exportStamp();
    if (state.tab === 'new') {
      if (!state.newLoaded) return { error: 'New parts are still loading.' };
      return {
        rows: filteredNewRows(),
        columns: NEW_PART_EXPORT_COLUMNS,
        sheetName: 'New parts',
        filename: `npi-new-parts-${stamp}.xlsx`,
        value: newPartExportValue,
      };
    }
    if (state.tab === 'history') {
      if (!state.completedLoaded) return { error: 'History is still loading.' };
      return {
        rows: filteredCompletedRows(),
        columns: NEW_PART_EXPORT_COLUMNS,
        sheetName: 'History',
        filename: `npi-history-${stamp}.xlsx`,
        value: newPartExportValue,
      };
    }
    return {
      rows: filteredRows(),
      columns: TRACKER_EXPORT_COLUMNS,
      sheetName: 'NPI Tracker',
      filename: `npi-tracker-${stamp}.xlsx`,
      value: trackerExportValue,
    };
  }

  function syncExportButton() {
    const btn = $('fa-export-excel');
    if (!btn) return;
    const label = state.tab === 'new' ? 'New parts' : (state.tab === 'history' ? 'History' : 'NPI Tracker');
    btn.title = `Download the visible ${label} list as Excel`;
  }

  async function ensureExcelJs() {
    if (window.ExcelJS) return window.ExcelJS;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load Excel export library'));
      document.head.appendChild(script);
    });
    return window.ExcelJS;
  }

  async function exportCurrentList() {
    const spec = exportListSpec();
    if (spec.error) {
      showAlert(spec.error);
      return;
    }
    if (!spec.rows.length) {
      showAlert('Nothing on this list to export.');
      return;
    }
    const btn = $('fa-export-excel');
    if (btn) btn.disabled = true;
    showAlert('');
    try {
      const ExcelJS = await ensureExcelJs();
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'NPI/FA Management';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet(spec.sheetName);
      const header = sheet.addRow(spec.columns.map((col) => col.label));
      header.font = { bold: true, size: 11, color: { argb: 'FF0F172A' } };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F1FE' } };
      header.alignment = { vertical: 'middle' };
      spec.rows.forEach((row) => {
        const added = sheet.addRow(spec.columns.map((col) => spec.value(row, col.id)));
        added.alignment = { vertical: 'top', wrapText: true };
      });
      spec.columns.forEach((col, index) => {
        sheet.getColumn(index + 1).width = col.width;
      });
      sheet.views = [{ state: 'frozen', ySplit: 1, activeCell: 'A2' }];
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: spec.columns.length },
      };
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = spec.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showAlert(err.message || 'Could not export Excel.');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function bind() {
    $('fa-export-excel')?.addEventListener('click', () => exportCurrentList());
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-fa-clear-filter], [data-fa-clear-all-filters], [data-fa-clear-sort]');
      if (!chip) return;
      const which = chip.getAttribute('data-fa-filter-table') || 'new';
      const view = tableView(which);
      if (chip.hasAttribute('data-fa-clear-sort')) {
        setColumnSort(view, 'po_due_date', { dir: 'asc' });
      } else if (chip.hasAttribute('data-fa-clear-all-filters')) {
        view.colFilters = {};
      } else {
        const colId = chip.getAttribute('data-fa-clear-filter');
        if (colId) delete view.colFilters[colId];
      }
      closeColumnFilter();
      rerenderTable(which);
    });
    $('fa-refresh')?.addEventListener('click', () => {
      if (state.tab === 'new') loadNewParts();
      else if (state.tab === 'history') loadCompletedParts();
      else loadTracker();
    });
    document.querySelectorAll('[data-fa-tab]').forEach((btn) => {
      btn.addEventListener('click', () => setTab(btn.getAttribute('data-fa-tab')));
    });
    $('fa-new-exception-add')?.addEventListener('click', () => addTypedException());
    $('fa-new-exception-search')?.addEventListener('input', (e) => {
      clearTimeout(state.exceptionSearchTimer);
      const value = e.target.value || '';
      state.exceptionSearchTimer = setTimeout(() => runExceptionSearch(value), 220);
    });
    $('fa-new-exception-search')?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideExceptionSearch();
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = state.exceptionHits.find((hit) => !hit.already_on_list && !exceptionAlreadyOnList(hit));
        if (first) addExceptionHit(first);
        else addTypedException();
      }
    });
    $('fa-new-exception-results')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.fa-typeahead-item');
      if (!btn || btn.disabled) return;
      const hit = state.exceptionHits[Number(btn.getAttribute('data-index'))];
      addExceptionHit(hit);
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
    $('fa-history-filter')?.addEventListener('input', (e) => {
      state.completedFilter = e.target.value || '';
      renderHistoryTable();
    });
    $('fa-history-types')?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-fa-history-type]');
      if (!chip) return;
      const value = chip.getAttribute('data-fa-history-type') || '';
      const counts = completedTypeCounts();
      const present = PS_TYPE_ORDER.filter((label) => counts[label]);
      if (value === '__all') {
        const allOn = present.length > 0 && present.every((label) => state.completedTypes.has(label));
        state.completedTypes = allOn ? new Set() : new Set(present);
      } else if (state.completedTypes.has(value)) {
        state.completedTypes.delete(value);
      } else {
        state.completedTypes.add(value);
      }
      renderHistoryTable();
    });
    $('fa-new-assigned-pic')?.addEventListener('click', () => {
      state.newView.assignedPicOnly = !state.newView.assignedPicOnly;
      renderNewTable();
    });
    $('fa-history-assigned-pic')?.addEventListener('click', () => {
      state.completedView.assignedPicOnly = !state.completedView.assignedPicOnly;
      renderHistoryTable();
    });
    $('fa-flagged-assigned-pic')?.addEventListener('click', () => {
      state.flaggedAssignedPicOnly = !state.flaggedAssignedPicOnly;
      renderTable();
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
    $('fa-import-excel')?.addEventListener('click', openImportModal);
    $('fa-import-modal-close')?.addEventListener('click', closeImportModal);
    $('fa-import-modal')?.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'fa-import-modal') closeImportModal();
    });
    $('fa-import-browse')?.addEventListener('click', () => $('fa-import-file')?.click());
    $('fa-import-file')?.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      importExcelFile(file);
    });
    const importDrop = $('fa-import-drop');
    if (importDrop) {
      ['dragenter', 'dragover'].forEach((type) => {
        importDrop.addEventListener(type, (e) => {
          e.preventDefault();
          importDrop.classList.add('is-over');
        });
      });
      ['dragleave', 'drop'].forEach((type) => {
        importDrop.addEventListener(type, (e) => {
          e.preventDefault();
          importDrop.classList.remove('is-over');
        });
      });
      importDrop.addEventListener('drop', (e) => {
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        importExcelFile(file);
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('fa-priority-popover')?.hidden) {
        closePriorityMenu();
        return;
      }
      if (!$('fa-col-filter-popover')?.hidden) {
        closeColumnFilter();
        return;
      }
      if (proposedCncPopover() && !proposedCncPopover().hidden) {
        closeProposedCncPopover();
        return;
      }
      if (!$('fa-history-modal')?.hidden) {
        closeHistoryModal();
        return;
      }
      if (!$('fa-import-modal')?.hidden) {
        closeImportModal();
        return;
      }
      if (!$('fa-bulk-modal')?.hidden) {
        closeBulkModal();
        return;
      }
      if (!$('fa-pic-modal')?.hidden) {
        closePicModal();
        return;
      }
      hideExceptionSearch();
    });

    $('fa-filter')?.addEventListener('input', (e) => {
      state.filter = e.target.value || '';
      renderTable();
    });

    $('fa-history-modal-close')?.addEventListener('click', closeHistoryModal);
    $('fa-history-modal')?.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'fa-history-modal') closeHistoryModal();
    });

    function onNewPartBodies(eventName, handler) {
      ['fa-new-table-body', 'fa-history-table-body'].forEach((id) => {
        $(id)?.addEventListener(eventName, handler);
      });
    }

    onNewPartBodies('click', async (e) => {
      if (grid.suppressClick) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const priorityBtn = e.target.closest('[data-fa-priority]');
      if (priorityBtn && !e.shiftKey) {
        e.preventDefault();
        const ps = priorityBtn.closest('tr')?.getAttribute('data-ps') || '';
        if (state.openPriorityPs && state.openPriorityPs === ps) closePriorityMenu();
        else openPriorityMenu(ps, priorityBtn);
        return;
      }
      const toggleSo = e.target.closest('[data-fa-toggle-so]');
      if (toggleSo) {
        e.preventDefault();
        e.stopPropagation();
        const which = tableKindFromEl(toggleSo);
        const view = tableView(which);
        const soNo = toggleSo.getAttribute('data-fa-toggle-so') || '';
        if (!soNo) return;
        if (view.collapsedGroups.has(soNo)) view.collapsedGroups.delete(soNo);
        else view.collapsedGroups.add(soNo);
        rerenderTable(which);
        return;
      }
      const groupRow = e.target.closest('tr.fa-so-group-row');
      if (groupRow && !e.target.closest('a, button')) {
        const which = tableKindFromEl(groupRow);
        const view = tableView(which);
        const soNo = groupRow.getAttribute('data-so') || '';
        if (soNo) {
          view.collapsedGroups.delete(soNo);
          rerenderTable(which);
        }
        return;
      }
      const historyBtn = e.target.closest('[data-fa-history]');
      if (historyBtn) {
        await openHistoryModal(
          historyBtn.getAttribute('data-fa-history') || 'new_part',
          historyBtn.getAttribute('data-ps') || '',
          historyBtn.getAttribute('data-part') || '',
        );
        return;
      }
      const picker = e.target.closest('[data-fa-finish-picker]');
      if (picker && typeof picker.showPicker === 'function') {
        try { picker.showPicker(); } catch (_) { /* native click still opens the picker */ }
      }
      const removeExceptionBtn = e.target.closest('[data-fa-remove-exception]');
      if (removeExceptionBtn) {
        await removeException(removeExceptionBtn.getAttribute('data-fa-remove-exception'));
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
    onNewPartBodies('change', async (e) => {
      const setPic = e.target.closest('[data-fa-set-pic]');
      if (setPic) {
        const ps = setPic.getAttribute('data-ps');
        const value = setPic.value;
        const previous = String((newRowByPs(ps)?.program_pic_ids || [])[0] || '');
        try {
          if (!value) {
            await saveNewPatch(ps, { program_pic_ids: [] });
            return;
          }
          let picId = value;
          if (value === '__new') {
            const name = window.prompt('PIC name');
            if (!name || !name.trim()) {
              setPic.value = previous;
              return;
            }
            const pic = await addPicName(name.trim());
            picId = pic && pic.pic_id;
          }
          const next = Number(picId) ? [Number(picId)] : [];
          await saveNewPatch(ps, { program_pic_ids: next });
        } catch (err) {
          setPic.value = previous;
          showAlert(err.message || 'Could not save PIC');
        }
        return;
      }
      const picker = e.target.closest('[data-fa-finish-picker]');
      if (picker) {
        const ps = picker.getAttribute('data-ps');
        const iso = picker.value || '';
        syncFinishField(picker.parentElement, iso);
        try {
          await saveNewPatch(ps, { program_finish_at: iso }, { render: false });
        } catch (err) {
          showAlert(err.message || 'Save failed');
        }
        return;
      }
      const fieldEl = e.target.closest('[data-fa-new-field]');
      if (!fieldEl || fieldEl.tagName === 'TEXTAREA') return;
      const ps = fieldEl.getAttribute('data-ps');
      const field = fieldEl.getAttribute('data-fa-new-field');
      if (field === 'npi_complete') {
        const checked = !!fieldEl.checked;
        const rowEl = fieldEl.closest('tr');
        const doneCell = fieldEl.closest('td');
        if (rowEl) rowEl.classList.toggle('is-npi-complete', checked);
        if (doneCell) doneCell.classList.toggle('is-done', checked);
        try {
          await saveNewPatch(ps, { npi_complete: checked }, { render: false });
        } catch (err) {
          fieldEl.checked = !checked;
          if (rowEl) rowEl.classList.toggle('is-npi-complete', !checked);
          if (doneCell) doneCell.classList.toggle('is-done', !checked);
          showAlert(err.message || 'Save failed');
        }
        return;
      }
      let value = fieldEl.value || '';
      if (field === 'program_finish_at') {
        const iso = parseFinishDate(value);
        if (String(value).trim() && !iso) {
          fieldEl.classList.add('is-invalid');
          showAlert('Enter a date as dd/mm/yyyy');
          return;
        }
        fieldEl.classList.remove('is-invalid');
        showAlert('');
        syncFinishField(fieldEl.parentElement, iso);
        value = iso;
      }
      try {
        await saveNewPatch(ps, { [field]: value }, { render: false });
      } catch (err) {
        showAlert(err.message || 'Save failed');
      }
    });
    onNewPartBodies('paste', (e) => {
      const fieldEl = e.target.closest('[data-fa-new-field="program_finish_at"]');
      if (!fieldEl) return;
      window.setTimeout(() => {
        const iso = parseFinishDate(fieldEl.value);
        if (!iso) return;
        syncFinishField(fieldEl.parentElement, iso);
        saveNewPatch(fieldEl.getAttribute('data-ps'), { program_finish_at: iso }, { render: false })
          .catch((err) => showAlert(err.message || 'Save failed'));
      }, 0);
    });
    onNewPartBodies('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const fieldEl = e.target.closest('[data-fa-new-field="program_finish_at"]');
      if (!fieldEl) return;
      e.preventDefault();
      fieldEl.blur();
    });
    onNewPartBodies('input', (e) => {
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
      if (e.target.closest('.fa-typeahead')) return;
      hideSearch();
      hideExceptionSearch();
    });

    $('fa-table-body')?.addEventListener('change', async (e) => {
      const fieldEl = e.target.closest('[data-fa-field]');
      if (!fieldEl) return;
      const id = fieldEl.getAttribute('data-id');
      const field = fieldEl.getAttribute('data-fa-field');
      const value = fieldEl.type === 'checkbox' ? fieldEl.checked : fieldEl.value;
      try {
        const saved = await savePatch(id, { [field]: value });
        if (field === 'pic_names' && saved) {
          fieldEl.value = picText(saved);
        }
        if ((field === 'tooling' || field === 'fixture' || field === 'gauges') && saved) {
          fieldEl.value = checkDisplayValue(saved, field);
          fieldEl.classList.toggle('is-ready', !!saved[`${field}_tick`]);
          const cell = fieldEl.closest('td');
          if (cell) {
            const parsed = parseCheckValue(saved, field);
            cell.classList.toggle('is-ready', parsed.ready);
            cell.classList.toggle('has-date', !!parsed.date);
          }
        }
      } catch (err) {
        showAlert(err.message || 'Save failed');
      }
    });

    $('fa-table-body')?.addEventListener('input', (e) => {
      const fieldEl = e.target.closest('[data-fa-field]');
      if (!fieldEl) return;
      if (fieldEl.classList.contains('fa-check-input')) {
        fieldEl.classList.toggle('is-ready', isReadyCheckText(fieldEl.value));
      }
      if (fieldEl.getAttribute('data-fa-field') === 'pic_names') return;
      if (fieldEl.classList.contains('fa-check-input')) return;
      if (fieldEl.tagName !== 'TEXTAREA' && !fieldEl.classList.contains('fa-check-input')) return;
      const id = fieldEl.getAttribute('data-id');
      const field = fieldEl.getAttribute('data-fa-field');
      queueSave(id, { [field]: fieldEl.value }, 450);
    });

    $('fa-table-body')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const fieldEl = e.target.closest('[data-fa-field]');
      if (!fieldEl || fieldEl.tagName === 'TEXTAREA') return;
      e.preventDefault();
      fieldEl.blur();
    });

    $('fa-table-body')?.addEventListener('click', async (e) => {
      const historyBtn = e.target.closest('[data-fa-history]');
      if (historyBtn) {
        await openHistoryModal(
          historyBtn.getAttribute('data-fa-history') || 'flagged',
          historyBtn.getAttribute('data-ps') || '',
          historyBtn.getAttribute('data-part') || '',
        );
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
        if (state.completedLoaded || state.tab === 'history') renderHistoryTable();
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
        const dropPic = (row) => {
          const picIds = (row.program_pic_ids || []).filter((value) => Number(value) !== picId);
          return {
            ...row,
            program_pic_ids: picIds,
            program_pics: (row.program_pics || []).filter((item) => Number(item.pic_id) !== picId),
          };
        };
        state.newRows = state.newRows.map(dropPic);
        state.completedRows = state.completedRows.map(dropPic);
        renderPicList();
        renderTable();
        renderNewTable();
        if (state.completedLoaded || state.tab === 'history') renderHistoryTable();
        setStatus('fa-pic-status', `Removed ${pic?.name || 'PIC'}`, 'saved');
      } catch (err) {
        setStatus('fa-pic-status', err.message || 'Could not delete PIC', 'error');
      }
    });

    function bindColumnControls() {
      ['fa-new-table-host', 'fa-history-table-host'].forEach((id) => {
        const host = $(id);
        if (!host || host.dataset.colControlsBound === '1') return;
        host.dataset.colControlsBound = '1';
        host.addEventListener('scroll', repositionColumnFilter, { passive: true });
        host.addEventListener('click', (e) => {
          const sortBtn = e.target.closest('[data-fa-sort-col]');
          if (sortBtn) {
            e.stopPropagation();
            const which = tableKindFromEl(sortBtn);
            const view = tableView(which);
            const colId = sortBtn.getAttribute('data-fa-sort-col');
            if (!colId) return;
            setColumnSort(view, colId, { additive: e.shiftKey });
            closeColumnFilter();
            rerenderTable(which);
            return;
          }
          const filterBtn = e.target.closest('[data-fa-filter-col]');
          if (filterBtn) {
            e.stopPropagation();
            openColumnFilter(filterBtn, tableKindFromEl(filterBtn), filterBtn.getAttribute('data-fa-filter-col'));
          }
        });
      });
      document.querySelectorAll('.fa-table-scroll').forEach((el) => {
        el.addEventListener('scroll', repositionColumnFilter, { passive: true });
      });
      window.addEventListener('resize', repositionColumnFilter);

      document.addEventListener('click', (e) => {
        const pop = $('fa-col-filter-popover');
        if (!pop || pop.hidden) return;
        if (pop.contains(e.target) || e.target.closest('[data-fa-filter-col]')) return;
        closeColumnFilter();
      });

      const pop = $('fa-col-filter-popover');
      pop?.addEventListener('click', (e) => {
        const which = state.openFilterTable || 'new';
        const view = tableView(which);
        const sortDirBtn = e.target.closest('[data-fa-sort-dir]');
        if (sortDirBtn && state.openFilterCol) {
          setColumnSort(view, state.openFilterCol, { dir: sortDirBtn.getAttribute('data-fa-sort-dir') });
          closeColumnFilter();
          rerenderTable(which);
          return;
        }
        const clearBtn = e.target.closest('[data-fa-clear-col-filter]');
        if (clearBtn) {
          const which = state.openFilterTable || 'new';
          const view = tableView(which);
          const colId = clearBtn.getAttribute('data-fa-clear-col-filter');
          if (colId) delete view.colFilters[colId];
          closeColumnFilter();
          rerenderTable(which);
          return;
        }
        e.stopPropagation();
      });

      pop?.addEventListener('input', (e) => {
        const search = e.target.closest('.fa-col-filter-search');
        if (!search || !state.openFilterCol) return;
        state.filterQuery = search.value || '';
        const which = state.openFilterTable || 'new';
        pop.innerHTML = renderColumnFilterPanel(which, state.openFilterCol);
        const next = pop.querySelector('.fa-col-filter-search');
        if (next) {
          next.focus();
          const pos = state.filterQuery.length;
          next.setSelectionRange(pos, pos);
        }
        repositionColumnFilter();
      });

      pop?.addEventListener('change', (e) => {
        const which = state.openFilterTable || 'new';
        const view = tableView(which);
        const colId = state.openFilterCol;
        if (!colId) return;
        const allOptions = uniqueFilterOptions(columnFilterSourceRows(which, colId), colId);
        const allInput = e.target.closest('input[data-fa-filter-all]');
        if (allInput) {
          if (allInput.checked) delete view.colFilters[colId];
          else view.colFilters[colId] = [];
          rerenderTable(which);
          pop.innerHTML = renderColumnFilterPanel(which, colId);
          repositionColumnFilter();
          return;
        }
        const valueInput = e.target.closest('input[data-fa-filter-value]');
        if (!valueInput) return;
        const selected = new Set(Array.isArray(view.colFilters[colId]) ? view.colFilters[colId] : allOptions);
        const value = valueInput.getAttribute('data-fa-filter-value') || '';
        if (valueInput.checked) selected.add(value);
        else selected.delete(value);
        if (selected.size === allOptions.length && allOptions.every((item) => selected.has(item))) {
          delete view.colFilters[colId];
        } else {
          view.colFilters[colId] = allOptions.filter((item) => selected.has(item));
        }
        rerenderTable(which);
        pop.innerHTML = renderColumnFilterPanel(which, colId);
        repositionColumnFilter();
      });
    }

    bindColumnControls();
    bindProposedCncPicker();
    bindGrid();
  }

  bind();
  syncExportButton();
  ensureMaterialModalShell();
  loadMaterialModalScript();
  const bootHash = String(window.location.hash || '').toLowerCase();
  if (bootHash === '#new') {
    setTab('new', { persistHash: false });
  } else if (bootHash === '#history') {
    setTab('history', { persistHash: false });
  }
  loadTracker();
})();
