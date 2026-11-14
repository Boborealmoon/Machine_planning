(function () {
  const SUBTITLES = {
    qc: "Time in QC, from the Final Inspection scan to the packing scan. Jobs still at QC stay at the top, and their TAT clock keeps running.",
    material: "Active S/O lines where the material arrived after the need date. Need is the material need date. Arrival is the Material in date. Gap is how many days late. PO due is the customer due date. Proposed EDD is the planner date from S/O management.",
    exceptions: "Active S/O exceptions, one partial per row. Partial value is the exception partial qty times the unit selling price. Full value is the process sheet qty times that price, counted once per sheet. Both follow the filters on screen. All shows every department. Pick one or more departments to keep those partials and only the remark columns they own. Each column header sorts and filters.",
  };

  const state = {
    tab: "qc",
    rows: [],
    summary: null,
    sortKey: "days_at_qc",
    sortDir: "desc",
    timer: 0,
    so: null,
    soSort: {
      material: { key: "day_gap", dir: "desc" },
      exceptions: { key: "due_date", dir: "asc" },
    },
    psMode: "all",
    psTypes: new Set(),
    colFilters: { qc: {}, material: {}, exceptions: {} },
    openFilter: "",
    filterOptions: [],
    deptMode: "all",
    deptTags: new Set(),
    tatTicker: 0,
    resolved: { qc: {}, material: {}, exceptions: {} },
    hideResolved: false,
  };

  const COLUMN_LABELS = {
    qc: [
      ["ps_id", "Job"],
      ["part_no", "Part"],
      ["current_stage_desc", "Stage"],
      ["due_date", "Due"],
      ["pushed_at", "Arrived at QC"],
      ["left_at", "Left QC"],
      ["days_at_qc", "QC TAT"],
      ["qc_state", "Status"],
    ],
    material: [
      ["process_sheet_no", "Process sheet"],
      ["part_no", "Part"],
      ["description", "Description"],
      ["material_need_date", "Material need date"],
      ["material_arrival_date", "Material arrival"],
      ["day_gap", "Days late"],
      ["due_date", "PO due date"],
      ["edd_date", "Proposed EDD"],
      ["mtl_part_order", "Mtl / Part Order"],
      ["quality_doc", "Quality Doc"],
      ["ops_notes", "Ops"],
      ["sales_notes", "Sales"],
    ],
    exceptions: [
      ["process_sheet_no", "Process sheet"],
      ["partial_no", "Partial"],
      ["part_no", "Part"],
      ["description", "Description"],
      ["posted_date", "Posted"],
      ["due_date", "Due"],
      ["edd_date", "EDD"],
      ["exception_label", "Exception"],
      ["delivery_date", "Delivered"],
      ["mtl_part_order", "Mtl / Part Order"],
      ["quality_doc", "Quality Doc"],
      ["ops_notes", "Ops"],
      ["sales_notes", "Sales"],
    ],
  };

  const PS_ORDER = ["MPS", "APS", "NPS", "PPS", "CPS", "SR", "TEMP", "Other"];

  const DEPTS = [
    { id: "supply_chain", label: "Supply Chain" },
    { id: "process_engr", label: "Process / Engr" },
    { id: "qlty", label: "Qlty" },
    { id: "sales", label: "Sales" },
    { id: "others", label: "Others" },
  ];

  const DEPT_COLUMNS = [
    { key: "mtl_part_order", dept: "supply_chain", label: "Mtl / Part Order" },
    { key: "quality_doc", dept: "qlty", label: "Quality Doc" },
    { key: "ops_notes", dept: "process_engr", label: "Ops" },
    { key: "sales_notes", dept: "sales", label: "Sales" },
  ];

  const $ = (id) => document.getElementById(id);

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function isoDate(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function csvCell(value) {
    const text = value == null ? "" : String(value);
    if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  function dash(value) {
    const text = value == null ? "" : String(value).trim();
    return text || "—";
  }

  function setSubtitle() {
    const node = $("kpi-subtitle");
    if (node) node.textContent = SUBTITLES[state.tab] || "";
  }

  function setDefaults() {
    const today = new Date();
    const from = $("kpi-from");
    const to = $("kpi-to");
    if (from && !from.value) from.value = today.getFullYear() + "-01-01";
    if (to && !to.value) to.value = isoDate(today);
  }

  function queryString() {
    const params = new URLSearchParams();
    const from = $("kpi-from")?.value || "";
    const to = $("kpi-to")?.value || "";
    const status = $("kpi-status")?.value || "all";
    const minDays = $("kpi-min-days")?.value || "";
    const q = $("kpi-search")?.value || "";
    const includeOpen = $("kpi-include-open")?.checked;
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (status && status !== "all") params.set("status", status);
    if (minDays !== "") params.set("min_days", minDays);
    if (q.trim()) params.set("q", q.trim());
    params.set("include_open", includeOpen ? "1" : "0");
    return params.toString();
  }

  function setLoading(on, text) {
    const loading = $("kpi-loading");
    const label = $("kpi-loading-text");
    if (label && text) label.textContent = text;
    if (loading) loading.hidden = !on;
  }

  function showAlert(message) {
    const alert = $("kpi-alert");
    if (!alert) return;
    if (!message) {
      alert.hidden = true;
      alert.textContent = "";
      return;
    }
    alert.hidden = false;
    alert.textContent = message;
  }

  function countText(value) {
    if (value == null || value === "") return "\u2014";
    return String(value);
  }

  function dayText(value) {
    if (value == null || value === "") return "\u2014";
    return value + " days";
  }

  function boardFact(label, value, cls) {
    return (
      '<span class="' + (cls || "") + '">' + esc(label) + " <b>" + esc(value) + "</b></span>"
    );
  }

  function boardGroup(tone, count, title, facts) {
    return (
      '<article class="kpi-board-group kpi-board-group--' + tone + '">' +
        '<div class="kpi-board-n">' + esc(countText(count)) + "</div>" +
        '<div class="kpi-board-copy">' +
          '<div class="kpi-board-k">' + esc(title) + "</div>" +
          '<div class="kpi-board-facts">' + facts + "</div>" +
        "</div>" +
      "</article>"
    );
  }

  function renderSummary(summary) {
    const host = $("kpi-summary");
    if (!host) return;
    const s = summary || {};
    const aged = Number(s.in_qc_7d) > 0 ? "kpi-board-hot" : "";
    host.innerHTML = [
      boardGroup("open", s.in_qc, "Still in QC", [
        boardFact("Avg", dayText(s.avg_days_in_qc)),
        boardFact("7+ days", countText(s.in_qc_7d), aged),
      ].join("")),
      boardGroup("done", s.left_qc, "Left QC", [
        boardFact("Avg", dayText(s.avg_days_left)),
        boardFact("Median", dayText(s.median_days_left)),
      ].join("")),
      boardGroup("gap", s.left_unstamped, "No out time",
        "<span>Left inspection, no packing scan</span>"),
    ].join("");
    host.hidden = false;
  }

  function compare(a, b, key) {
    const av = a[key];
    const bv = b[key];
    if (key === "days_at_qc" || key === "pp_partial_no") {
      const an = av == null || av === "" ? null : Number(av);
      const bn = bv == null || bv === "" ? null : Number(bv);
      if (an == null && bn == null) return 0;
      if (an == null) return 1;
      if (bn == null) return -1;
      return an - bn;
    }
    const as = String(av == null ? "" : av).toLowerCase();
    const bs = String(bv == null ? "" : bv).toLowerCase();
    if (as < bs) return -1;
    if (as > bs) return 1;
    return 0;
  }

  function sheetCategory(value) {
    const raw = String(value || "").split("::")[0].trim();
    if (!raw) return "Other";
    if (/\[temp\]/i.test(raw)) return "TEMP";
    if (/\[sr\]|\(sr\)/i.test(raw)) return "SR";
    const match = raw.toUpperCase().match(/^([A-Z]+)/);
    return match ? match[1] : "Other";
  }

  function rowType(row) {
    if (row.ps_type) return row.ps_type;
    return sheetCategory(state.tab === "qc" ? row.ps_id : row.process_sheet_no);
  }

  function typeOn(type) {
    if (state.psMode === "none") return false;
    if (state.psMode === "all") return true;
    return !state.psTypes.has(type);
  }

  function loadPsTypes() {
    try {
      const raw = localStorage.getItem("kpi-ps-types-v1") || "all";
      if (raw === "none") {
        state.psMode = "none";
        state.psTypes = new Set();
        return;
      }
      if (raw.startsWith("off:")) {
        state.psMode = "custom";
        state.psTypes = new Set(raw.slice(4).split(",").map((part) => part.trim()).filter(Boolean));
        if (!state.psTypes.size) state.psMode = "all";
        return;
      }
      state.psMode = "all";
      state.psTypes = new Set();
    } catch (err) {
      state.psMode = "all";
      state.psTypes = new Set();
    }
  }

  function savePsTypes() {
    try {
      let value = "all";
      if (state.psMode === "none") value = "none";
      else if (state.psMode === "custom") value = "off:" + [...state.psTypes].join(",");
      localStorage.setItem("kpi-ps-types-v1", value);
    } catch (err) {
      /* ignore private-mode storage failures */
    }
  }

  function knownTypes() {
    const found = new Set();
    const add = (rows) => {
      (rows || []).forEach((row) => {
        found.add(row.ps_type || sheetCategory(row.ps_id || row.process_sheet_no));
      });
    };
    add(state.rows);
    add(state.so?.material_rows);
    add(state.so?.exception_rows);
    return found;
  }

  function sourceRows() {
    if (state.tab === "material") {
      return (state.so?.material_rows || []).filter((row) => Number(row.day_gap) > 0);
    }
    if (state.tab === "exceptions") return state.so?.exception_rows || [];
    return state.rows || [];
  }

  function typesPresent() {
    const counts = {};
    sourceRows().forEach((row) => {
      const type = rowType(row);
      counts[type] = (counts[type] || 0) + 1;
    });
    const extras = Object.keys(counts)
      .filter((type) => !PS_ORDER.includes(type))
      .sort();
    const types = PS_ORDER.concat(extras).filter((type) => counts[type]);
    return { counts, types };
  }

  function typeTone(type) {
    return String(type || "other").toLowerCase().replace(/[^a-z0-9]+/g, "") || "other";
  }

  function typePill(row) {
    const type = rowType(row);
    return '<span class="kpi-type-pill kpi-type-pill--' + typeTone(type) + '">' + esc(type) + "</span>";
  }

  function renderTypebar() {
    const host = $("kpi-typebar");
    if (!host) return;
    const { counts, types } = typesPresent();
    const chips = types.map((type) => {
      const on = typeOn(type);
      return (
        '<button type="button" class="kpi-type kpi-type--' + typeTone(type) + (on ? " is-on" : "") + '" data-ps-type="' + esc(type) + '" aria-pressed="' + (on ? "true" : "false") + '">' +
          esc(type) + '<span class="kpi-type-count">' + counts[type] + "</span></button>"
      );
    }).join("");
    host.innerHTML =
      '<span class="kpi-typebar-label">Process sheet</span>' +
      '<button type="button" class="kpi-type kpi-type--all' + (state.psMode === "all" ? " is-on" : "") + '" data-ps-type="__all">All</button>' +
      chips;
  }

  function rowKey(view, row) {
    if (view === "qc") return String(row.ps_id || "") + "|" + String(row.pp_partial_no || 1);
    if (view === "exceptions") return String(row.process_sheet_no || "") + "|" + String(row.partial_no || 1);
    return String(row.process_sheet_no || "");
  }

  function isResolved(view, row) {
    return !!(state.resolved[view] && state.resolved[view][rowKey(view, row)]);
  }

  function loadResolved() {
    try {
      const raw = localStorage.getItem("kpi-resolved-v1");
      const saved = raw ? JSON.parse(raw) : null;
      if (!saved || typeof saved !== "object") return;
      ["qc", "material", "exceptions"].forEach((view) => {
        if (saved[view] && typeof saved[view] === "object") state.resolved[view] = saved[view];
      });
      state.hideResolved = !!saved.hideResolved;
    } catch (err) {
      /* ignore unreadable storage */
    }
    const hide = $("kpi-hide-resolved");
    if (hide) hide.checked = state.hideResolved;
  }

  function saveResolved() {
    try {
      localStorage.setItem("kpi-resolved-v1", JSON.stringify({
        qc: state.resolved.qc,
        material: state.resolved.material,
        exceptions: state.resolved.exceptions,
        hideResolved: state.hideResolved,
      }));
    } catch (err) {
      /* ignore private-mode storage failures */
    }
  }

  function resolvedCell(view, row) {
    const on = isResolved(view, row);
    return (
      '<td class="kpi-resolved"><input type="checkbox" data-resolve="' + esc(view) + '" data-resolve-key="' + esc(rowKey(view, row)) + '"' +
      (on ? " checked" : "") + ' aria-label="Mark resolved"></td>'
    );
  }

  function columnLabel(view, key) {
    const found = (COLUMN_LABELS[view] || []).find(([name]) => name === key);
    return found ? found[1] : key;
  }

  const BLANK_VALUE = "(Blank)";

  function paintColumnFilters() {
    const panel = document.querySelector('[data-kpi-panel="' + state.tab + '"]');
    const filters = state.colFilters[state.tab] || {};
    document.querySelectorAll("[data-col-filter]").forEach((btn) => {
      const inView = !panel || panel.contains(btn);
      const key = btn.getAttribute("data-col-filter");
      const selected = filters[key];
      const on = inView && selected && selected.size;
      btn.classList.toggle("is-on", !!on);
      btn.classList.toggle("is-open", inView && state.openFilter === key);
      btn.setAttribute("aria-expanded", inView && state.openFilter === key ? "true" : "false");
    });
    const pop = $("kpi-col-popover");
    if (state.openFilter && pop && !pop.hidden) fillColFilter(state.openFilter);
  }

  function closeColFilter() {
    state.openFilter = "";
    state.filterOptions = [];
    const pop = $("kpi-col-popover");
    if (pop) pop.hidden = true;
    const list = $("kpi-col-list");
    if (list) delete list.dataset.signature;
    paintColumnFilters();
  }

  function cellText(value) {
    return String(value == null ? "" : value).trim();
  }

  function exceptionText(row) {
    const tags = rowDepts(row);
    if (!tags.length) return cellText(row.exception_label);
    return tags.map((id) => {
      const dept = DEPTS.find((item) => item.id === id);
      return dept ? dept.label : id;
    }).join(", ");
  }

  function tatText(row) {
    if (row.qc_state === "in_qc") {
      const label = cellText(row.elapsed_label) || (row.days_at_qc != null ? String(row.days_at_qc) + "d" : "");
      return label ? "Live · " + label : "Live";
    }
    if (row.qc_state === "left_qc") return cellText(row.elapsed_label) || (row.days_at_qc != null ? String(row.days_at_qc) : "");
    if (row.qc_state === "left_unstamped") return "No out time";
    if (row.qc_state === "before_qc") return "Not started";
    return "";
  }

  function columnDisplay(view, key, row) {
    if (view === "qc" && key === "days_at_qc") return tatText(row);
    if (view === "qc" && key === "qc_state") return cellText(row.qc_state_label);
    if (key === "partial_no") return cellText(row.partial_label);
    if (key === "day_gap") return cellText(row.gap_label);
    if (key === "exception_label") return exceptionText(row);
    return cellText(row[key]);
  }

  function columnSortToken(view, key, row, value) {
    if (!value) return null;
    if (key === "day_gap" || key === "days_at_qc" || key === "partial_no") {
      const num = row ? Number(row[key]) : parseFloat(value);
      if (Number.isFinite(num)) return num;
    }
    return value.toLowerCase();
  }

  function compareFilterTokens(a, b) {
    const aEmpty = a == null || a === "";
    const bEmpty = b == null || b === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }

  function selectedFilters(view) {
    return state.colFilters[view] || {};
  }

  function columnOptions(view, key, rows, selected) {
    const sortOf = new Map();
    rows.forEach((row) => {
      const value = columnDisplay(view, key, row);
      if (!sortOf.has(value)) sortOf.set(value, columnSortToken(view, key, row, value));
    });
    if (selected) {
      selected.forEach((value) => {
        if (!sortOf.has(value)) sortOf.set(value, columnSortToken(view, key, null, value));
      });
    }
    return [...sortOf.entries()]
      .sort((a, b) => compareFilterTokens(a[1], b[1]) || String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true, sensitivity: "base" }))
      .map((entry) => entry[0]);
  }

  function rowsForOpenFilter(skipKey) {
    const view = state.tab;
    let rows;
    if (view === "material") {
      const query = soQuery("kpi-material-search");
      const keys = [
        "process_sheet_no", "sales_order_no", "customer_name", "part_no", "description",
        "material_need_date", "material_arrival_date", "due_date", "edd_date", "gap_label",
        "mtl_part_order", "quality_doc", "ops_notes", "sales_notes",
      ];
      rows = (state.so?.material_rows || []).filter((row) => Number(row.day_gap) > 0 && soMatch(row, query, keys));
    } else if (view === "exceptions") {
      const query = soQuery("kpi-exception-search");
      const keys = [
        "process_sheet_no", "sales_order_no", "customer_name", "part_no", "description",
        "exception_label", "delivery_date", "mtl_part_order", "quality_doc", "ops_notes", "sales_notes",
      ];
      rows = (state.so?.exception_rows || []).filter((row) => soMatch(row, query, keys) && matchesDept(row));
    } else {
      rows = state.rows || [];
    }
    return rows.filter((row) => {
      if (state.hideResolved && isResolved(view, row)) return false;
      if (!matchesType(row)) return false;
      return matchesColumns(row, view, skipKey);
    });
  }

  function positionColFilter(anchor) {
    const pop = $("kpi-col-popover");
    if (!pop || pop.hidden || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    pop.style.top = "0px";
    pop.style.left = "0px";
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 4);
    pop.style.top = Math.round(top) + "px";
    pop.style.left = Math.round(left) + "px";
  }

  function filterListItems(query) {
    const list = $("kpi-col-list");
    if (!list) return;
    const q = String(query || "").trim().toLowerCase();
    list.querySelectorAll(".filter-dropdown-item").forEach((label) => {
      label.hidden = Boolean(q) && !label.textContent.toLowerCase().includes(q);
    });
  }

  function fillColFilter(key) {
    const list = $("kpi-col-list");
    const search = $("kpi-col-value");
    const title = $("kpi-col-popover-title");
    if (!list || !key) return;
    const view = state.tab;
    const selected = selectedFilters(view)[key];
    const options = columnOptions(view, key, rowsForOpenFilter(key), selected);
    state.filterOptions = options;
    const signature = view + ":" + key + ":" + JSON.stringify(options);
    if (list.dataset.signature !== signature) {
      const searchWas = search ? search.value : "";
      list.dataset.signature = signature;
      list.innerHTML = options.length
        ? options.map((value, index) => {
          const checked = selected && selected.has(value) ? " checked" : "";
          const label = value || BLANK_VALUE;
          return '<label class="filter-dropdown-item"><input type="checkbox" data-idx="' + index + '"' + checked + "> " + esc(label) + "</label>";
        }).join("")
        : '<p class="kpi-col-empty">No values</p>';
      if (search) {
        search.value = searchWas;
        filterListItems(searchWas);
      }
    } else {
      list.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        const value = state.filterOptions[Number(input.getAttribute("data-idx"))];
        input.checked = Boolean(selected && selected.has(value));
      });
    }
    if (title) {
      title.textContent = selected && selected.size
        ? selected.size + " selected · " + columnLabel(view, key)
        : "All values · " + columnLabel(view, key);
    }
  }

  function openColFilter(btn) {
    const key = btn.getAttribute("data-col-filter");
    const pop = $("kpi-col-popover");
    if (!key || !pop) return;
    if (state.openFilter === key && !pop.hidden) {
      closeColFilter();
      return;
    }
    state.openFilter = key;
    const list = $("kpi-col-list");
    const input = $("kpi-col-value");
    if (list) delete list.dataset.signature;
    if (input) input.value = "";
    pop.hidden = false;
    fillColFilter(key);
    paintColumnFilters();
    positionColFilter(btn);
    if (input) input.focus();
  }

  function setColumnFilter(key, values) {
    if (!key) return;
    if (!state.colFilters[state.tab]) state.colFilters[state.tab] = {};
    if (values && values.size) state.colFilters[state.tab][key] = values;
    else delete state.colFilters[state.tab][key];
    paintColumnFilters();
    rerenderActive();
    if (state.openFilter === key) {
      fillColFilter(key);
      const safeKey = window.CSS && CSS.escape ? CSS.escape(key) : key;
      const btn = document.querySelector('[data-kpi-panel="' + state.tab + '"] [data-col-filter="' + safeKey + '"]');
      if (btn) positionColFilter(btn);
    }
  }

  function checkedFilterValues() {
    const list = $("kpi-col-list");
    const selected = new Set();
    if (!list) return selected;
    list.querySelectorAll('input[type="checkbox"]:checked').forEach((input) => {
      const value = state.filterOptions[Number(input.getAttribute("data-idx"))];
      if (value != null) selected.add(value);
    });
    return selected;
  }

  function toggleType(type) {
    if (type === "__all") {
      state.psMode = "all";
      state.psTypes = new Set();
    } else if (type === "__none") {
      state.psMode = "none";
      state.psTypes = new Set();
    } else if (state.psMode === "none") {
      const excluded = knownTypes();
      excluded.delete(type);
      state.psMode = excluded.size ? "custom" : "all";
      state.psTypes = excluded;
    } else {
      const excluded = state.psMode === "all" ? new Set() : new Set(state.psTypes);
      if (excluded.has(type)) excluded.delete(type);
      else excluded.add(type);
      state.psMode = excluded.size ? "custom" : "all";
      state.psTypes = excluded;
    }
    savePsTypes();
    renderTypebar();
    rerenderActive();
  }

  function matchesType(row) {
    return typeOn(rowType(row));
  }

  function columnVisible(view, key) {
    if (view !== "exceptions" || state.deptMode === "all") return true;
    const spec = DEPT_COLUMNS.find((item) => item.key === key);
    if (!spec) return true;
    return state.deptTags.has(spec.dept);
  }

  function matchesColumns(row, view, skipKey) {
    const filters = state.colFilters[view] || {};
    return Object.keys(filters).every((key) => {
      if (key === skipKey || !columnVisible(view, key)) return true;
      const selected = filters[key];
      if (!selected || !selected.size) return true;
      return selected.has(columnDisplay(view, key, row));
    });
  }

  function passesView(row, view) {
    if (state.hideResolved && isResolved(view, row)) return false;
    return matchesType(row) && matchesColumns(row, view);
  }

  function paintSort(panel, key, dir) {
    if (!panel) return;
    panel.querySelectorAll("[data-kpi-sort], [data-so-sort]").forEach((btn) => {
      const sortKey = btn.getAttribute("data-kpi-sort") || btn.getAttribute("data-so-sort");
      const on = sortKey === key;
      btn.classList.toggle("is-sorted", on);
      btn.dataset.dir = on ? dir : "";
    });
  }

  function summarizeVisible(rows) {
    const inDays = rows.filter((row) => row.qc_state === "in_qc" && row.days_at_qc != null).map((row) => Number(row.days_at_qc));
    const leftDays = rows.filter((row) => row.qc_state === "left_qc" && row.days_at_qc != null).map((row) => Number(row.days_at_qc));
    const mean = (values) => {
      if (!values.length) return null;
      return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
    };
    const median = (values) => {
      if (!values.length) return null;
      const ordered = values.slice().sort((a, b) => a - b);
      const mid = Math.floor(ordered.length / 2);
      const value = ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
      return Math.round(value * 100) / 100;
    };
    return {
      in_qc: rows.filter((row) => row.qc_state === "in_qc").length,
      avg_days_in_qc: mean(inDays),
      left_qc: rows.filter((row) => row.qc_state === "left_qc").length,
      avg_days_left: mean(leftDays),
      median_days_left: median(leftDays),
      in_qc_3d: inDays.filter((days) => days >= 3).length,
      in_qc_7d: inDays.filter((days) => days >= 7).length,
      left_unstamped: rows.filter((row) => row.qc_state === "left_unstamped").length,
    };
  }

  function missingSortValue(value) {
    return value == null || value === "";
  }

  function sortedRows() {
    const dir = state.sortDir === "asc" ? 1 : -1;
    const key = state.sortKey;
    return state.rows.filter((row) => passesView(row, "qc")).slice().sort((a, b) => {
      if (key === "days_at_qc") {
        const group = (row) => (row.qc_state === "in_qc" ? 0 : 1);
        const grouped = group(a) - group(b);
        if (grouped) return grouped;
      }
      if (missingSortValue(a[key]) || missingSortValue(b[key])) {
        if (missingSortValue(a[key]) && missingSortValue(b[key])) {
          return String(a.ps_id || "").localeCompare(String(b.ps_id || ""));
        }
        return missingSortValue(a[key]) ? 1 : -1;
      }
      const base = compare(a, b, key);
      if (base) return base * dir;
      return String(a.ps_id || "").localeCompare(String(b.ps_id || ""));
    });
  }

  function stampMs(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;
    const utc = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] || 0));
    return utc - (8 * 60 * 60 * 1000);
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function formatRunning(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const clock = pad2(hours) + ":" + pad2(minutes) + ":" + pad2(seconds);
    return days > 0 ? days + "d " + clock : clock;
  }

  function tickTatClocks() {
    const now = Date.now();
    document.querySelectorAll("[data-tat-start]").forEach((node) => {
      const start = stampMs(node.getAttribute("data-tat-start"));
      const clock = node.querySelector(".kpi-tat-clock");
      if (start == null || !clock) return;
      clock.textContent = formatRunning(now - start);
    });
  }

  function ensureTatTicker() {
    if (state.tatTicker) return;
    state.tatTicker = window.setInterval(tickTatClocks, 1000);
  }

  function tatCell(row) {
    if (row.qc_state === "in_qc" && row.pushed_at) {
      const start = stampMs(row.pushed_at);
      const label = start == null ? (row.elapsed_label || "—") : formatRunning(Date.now() - start);
      const days = Number(row.days_at_qc);
      let tone = "";
      if (days >= 7) tone = " kpi-tat--hot";
      else if (days >= 3) tone = " kpi-tat--watch";
      return (
        '<td class="kpi-num">' +
          '<span class="kpi-tat kpi-tat--live' + tone + '" data-tat-start="' + esc(row.pushed_at) + '" title="Still at QC. Clock running from arrival.">' +
            '<span class="kpi-tat-dot" aria-hidden="true"></span>' +
            '<span class="kpi-tat-flag">Live</span>' +
            '<span class="kpi-tat-clock">' + esc(label) + "</span>" +
          "</span>" +
        "</td>"
      );
    }
    if (row.qc_state === "left_qc" && (row.elapsed_label || row.days_at_qc != null)) {
      const days = row.elapsed_label || String(row.days_at_qc);
      const title = row.days_at_qc == null ? "" : String(row.days_at_qc) + " days";
      return '<td class="kpi-num kpi-days" title="' + esc(title) + '">' + esc(days) + "</td>";
    }
    const idle = row.qc_state === "left_unstamped" ? "No out time" : row.qc_state === "before_qc" ? "Not started" : "—";
    return '<td class="kpi-num kpi-days kpi-days--idle">' + esc(idle) + "</td>";
  }

  function rowClass(row) {
    let cls = "kpi-row kpi-row--" + (row.qc_state || "");
    if (row.qc_state === "in_qc" && row.days_at_qc != null) {
      cls = "kpi-row kpi-row--in_qc";
      if (Number(row.days_at_qc) >= 7) cls += " kpi-row--hot";
      else if (Number(row.days_at_qc) >= 3) cls += " kpi-row--watch";
    }
    if (isResolved("qc", row)) cls += " kpi-row--resolved";
    return cls;
  }

  function renderTable() {
    const body = $("kpi-body");
    const empty = $("kpi-empty");
    const card = $("kpi-table-card");
    const meta = $("kpi-meta");
    const rows = sortedRows();
    if (card) card.hidden = false;
    paintSort($("kpi-panel-qc"), state.sortKey, state.sortDir);
    renderSummary(summarizeVisible(rows));
    if (meta) {
      const n = rows.length;
      meta.textContent = n === 1 ? "1 job" : n + " jobs";
    }
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    body.innerHTML = rows.map((row) => {
      const partial = Number(row.pp_partial_no) > 1 ? "Partial " + row.pp_partial_no : "";
      const qty = row.qty == null || row.qty === "" ? "" : "Qty " + row.qty;
      const stageBits = [row.stage_status_label, qty].filter(Boolean).join(" · ");
      return (
        '<tr class="' + rowClass(row) + (row.qc_state === "in_qc" ? " kpi-row--live" : "") + '">' +
          resolvedCell("qc", row) +
          '<td>' + typePill(row) + '<span class="kpi-job">' + esc(row.ps_id || "—") + '</span>' +
            (partial ? '<span class="kpi-sub">' + esc(partial) + '</span>' : '') +
          '</td>' +
          '<td class="kpi-wrap"><span class="kpi-job">' + esc(dash(row.part_no)) + '</span>' +
            (row.part_desc ? '<span class="kpi-sub">' + esc(row.part_desc) + '</span>' : '') +
          '</td>' +
          '<td class="kpi-wrap"><span class="kpi-job">' + esc(dash(row.current_stage_desc)) + '</span>' +
            (stageBits ? '<span class="kpi-sub">' + esc(stageBits) + '</span>' : '') +
          '</td>' +
          '<td>' + esc(dash(row.due_date)) + '</td>' +
          '<td>' + esc(dash(row.pushed_at)) + '</td>' +
          '<td>' + esc(dash(row.left_at)) +
            (row.left_stage_desc ? '<span class="kpi-sub">' + esc(row.left_stage_desc) + '</span>' : '') +
          '</td>' +
          tatCell(row) +
          '<td><span class="kpi-pill kpi-pill--' + esc(row.qc_state) + '">' + esc(row.qc_state_label || "—") + '</span></td>' +
        '</tr>'
      );
    }).join("");
    ensureTatTicker();
    tickTatClocks();
    paintColumnFilters();
  }

  function render(payload) {
    state.rows = payload.rows || [];
    state.summary = payload.summary || {};
    renderTypebar();
    renderTable();
    const exportBtn = $("kpi-export");
    if (exportBtn && state.tab === "qc") exportBtn.disabled = !state.rows.length;
  }

  function rerenderActive() {
    if (state.tab === "material") renderMaterial();
    else if (state.tab === "exceptions") renderExceptions();
    else renderTable();
    if (state.tab !== "qc") renderTypebar();
  }

  async function load() {
    setLoading(true, "Loading QC dwell...");
    showAlert("");
    try {
      const fetchFn = window.reportsApiFetch || fetch;
      const res = await fetchFn("/api/kpi/qc-dwell?" + queryString());
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || ("HTTP " + res.status));
      }
      render(data);
    } catch (err) {
      showAlert(err && err.message ? err.message : "Could not load QC dwell.");
    } finally {
      setLoading(false);
    }
  }

  function scheduleLoad() {
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(load, 280);
  }

  function downloadCsv(filename, columns, rows) {
    const lines = [columns.map(([, label]) => csvCell(label)).join(",")];
    rows.forEach((row) => {
      lines.push(columns.map(([key]) => csvCell(row[key] ?? "")).join(","));
    });
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const NOTE_COLUMNS = [
    ["mtl_part_order", "Mtl / Part Order"],
    ["quality_doc", "Quality Doc"],
    ["ops_notes", "Ops"],
    ["sales_notes", "Sales"],
  ];

  function withResolved(view, rows) {
    return rows.map((row) => Object.assign({}, row, { resolved: isResolved(view, row) ? "Yes" : "" }));
  }

  function exportCsv() {
    const day = isoDate(new Date());
    if (state.tab === "material") {
      downloadCsv(
        "material-date-kpi-" + day + ".csv",
        [
          ["resolved", "Resolved"],
          ["ps_type", "PS type"],
          ["process_sheet_no", "Process sheet"],
          ["sales_order_no", "Sales order"],
          ["part_no", "Part no"],
          ["description", "Description"],
          ["material_need_date", "Material need date"],
          ["material_arrival_date", "Material arrival"],
          ["day_gap", "Gap days"],
          ["gap_label", "Days late"],
          ["due_date", "PO due date"],
          ["edd_date", "Proposed EDD"],
        ].concat(NOTE_COLUMNS),
        withResolved("material", materialRows())
      );
      return;
    }
    if (state.tab === "exceptions") {
      downloadCsv(
        "exception-kpi-" + day + ".csv",
        [
          ["resolved", "Resolved"],
          ["ps_type", "PS type"],
          ["process_sheet_no", "Process sheet"],
          ["partial_label", "Partial"],
          ["sales_order_no", "Sales order"],
          ["customer_name", "Customer"],
          ["part_no", "Part no"],
          ["description", "Description"],
          ["posted_date", "Posted date"],
          ["due_date", "Due date"],
          ["edd_date", "EDD"],
          ["exception_label", "Exception"],
          ["partial_qty", "Partial qty"],
          ["full_qty", "Full qty"],
          ["unit_selling_price", "Unit price"],
          ["partial_value", "Partial value"],
          ["full_value", "Full value"],
        ].concat(
          [["delivery_date", "Delivered"]].concat(
            DEPT_COLUMNS
              .filter((col) => state.deptMode !== "custom" || state.deptTags.has(col.dept))
              .map((col) => [col.key, col.label])
          )
        ),
        withResolved("exceptions", exceptionRows())
      );
      return;
    }
    const columns = [
      ["resolved", "Resolved"],
      ["ps_type", "PS type"],
      ["ps_id", "Job"],
      ["pp_partial_no", "Partial"],
      ["part_no", "Part no"],
      ["part_desc", "Description"],
      ["qty", "Qty"],
      ["current_stage_desc", "Stage"],
      ["stage_status_label", "Stage status"],
      ["due_date", "Due"],
      ["pushed_at", "Arrived at QC"],
      ["left_at", "Left QC"],
      ["left_stage_desc", "Left stage"],
      ["days_at_qc", "QC TAT days"],
      ["elapsed_label", "QC TAT"],
      ["qc_state_label", "Status"],
    ];
    downloadCsv("qc-dwell-kpi-" + day + ".csv", columns, withResolved("qc", sortedRows()));
  }

  function soQuery(id) {
    return ($(id)?.value || "").trim().toLowerCase();
  }

  function soMatch(row, query, keys) {
    if (!query) return true;
    return keys.some((key) => String(row[key] == null ? "" : row[key]).toLowerCase().includes(query));
  }

  function sortSoRows(rows, view) {
    const sort = state.soSort[view];
    const dir = sort.dir === "asc" ? 1 : -1;
    const key = sort.key;
    return rows.slice().sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (key === "day_gap" || key === "partial_no") {
        const an = av == null || av === "" ? null : Number(av);
        const bn = bv == null || bv === "" ? null : Number(bv);
        if (an == null && bn == null) return 0;
        if (an == null) return 1;
        if (bn == null) return -1;
        if (an !== bn) return (an - bn) * dir;
        return 0;
      }
      const as = String(av == null ? "" : av);
      const bs = String(bv == null ? "" : bv);
      if (!as && bs) return 1;
      if (as && !bs) return -1;
      return as.localeCompare(bs) * dir;
    });
  }

  function materialRows() {
    const query = soQuery("kpi-material-search");
    const keys = [
      "process_sheet_no", "sales_order_no", "customer_name", "part_no", "description",
      "material_need_date", "material_arrival_date", "due_date", "edd_date", "gap_label",
      "mtl_part_order", "quality_doc", "ops_notes", "sales_notes",
    ];
    const rows = (state.so?.material_rows || []).filter((row) => Number(row.day_gap) > 0 && soMatch(row, query, keys) && passesView(row, "material"));
    return sortSoRows(rows, "material");
  }

  function exceptionPool() {
    const query = soQuery("kpi-exception-search");
    const keys = [
      "process_sheet_no", "sales_order_no", "customer_name", "part_no", "description",
      "exception_label", "delivery_date", "mtl_part_order", "quality_doc", "ops_notes", "sales_notes",
    ];
    return (state.so?.exception_rows || []).filter((row) => soMatch(row, query, keys) && passesView(row, "exceptions"));
  }

  function exceptionRows() {
    return sortSoRows(exceptionPool().filter(matchesDept), "exceptions");
  }

  function remarkCells(row, keys) {
    const cols = keys || ["delivery_date", "mtl_part_order", "quality_doc", "ops_notes", "sales_notes"];
    return cols.map((spec) => {
      const key = typeof spec === "string" ? spec : spec.key;
      const dept = typeof spec === "string" ? "" : (spec.dept || "");
      return `<td class="kpi-wrap"${dept ? ` data-dept="${esc(dept)}"` : ""}>${esc(dash(row[key]))}</td>`;
    }).join("");
  }

  function rowDepts(row) {
    if (Array.isArray(row.exception_tags) && row.exception_tags.length) {
      return row.exception_tags.filter((id) => DEPTS.some((dept) => dept.id === id));
    }
    return String(row.exception_label || "").split(",").map((part) => {
      const label = part.trim().toLowerCase();
      const found = DEPTS.find((dept) => dept.label.toLowerCase() === label);
      return found ? found.id : "";
    }).filter(Boolean);
  }

  function matchesDept(row) {
    if (state.deptMode !== "custom" || !state.deptTags.size) return true;
    return rowDepts(row).some((id) => state.deptTags.has(id));
  }

  function deptColumnNote() {
    if (state.deptMode !== "custom" || !state.deptTags.size) return "All departments";
    const names = DEPTS.filter((dept) => state.deptTags.has(dept.id)).map((dept) => dept.label);
    const cols = DEPT_COLUMNS.filter((col) => state.deptTags.has(col.dept)).map((col) => col.label);
    return names.join(" + ") + (cols.length ? " · " + cols.join(", ") : "");
  }

  function syncDeptColumns() {
    const panel = $("kpi-panel-exceptions");
    if (!panel) return;
    panel.querySelectorAll("[data-dept]").forEach((el) => {
      const dept = el.getAttribute("data-dept");
      const show = state.deptMode !== "custom" || state.deptTags.has(dept);
      el.hidden = !show;
    });
  }

  function loadDepts() {
    try {
      const raw = localStorage.getItem("kpi-exception-depts-v1") || "all";
      if (!raw || raw === "all") {
        state.deptMode = "all";
        state.deptTags = new Set();
        return;
      }
      const tags = raw.split(",").map((part) => part.trim()).filter((id) => DEPTS.some((dept) => dept.id === id));
      state.deptTags = new Set(tags);
      state.deptMode = state.deptTags.size ? "custom" : "all";
    } catch (err) {
      state.deptMode = "all";
      state.deptTags = new Set();
    }
  }

  function saveDepts() {
    try {
      const value = state.deptMode === "custom" && state.deptTags.size
        ? [...state.deptTags].join(",")
        : "all";
      localStorage.setItem("kpi-exception-depts-v1", value);
    } catch (err) {
      /* ignore private-mode storage failures */
    }
  }

  function toggleDept(id) {
    if (id === "__all") {
      state.deptMode = "all";
      state.deptTags = new Set();
    } else if (state.deptMode !== "custom") {
      state.deptMode = "custom";
      state.deptTags = new Set([id]);
    } else if (state.deptTags.has(id)) {
      state.deptTags.delete(id);
      if (!state.deptTags.size) state.deptMode = "all";
    } else {
      state.deptTags.add(id);
    }
    saveDepts();
    renderExceptions();
  }

  function exceptionChips(row) {
    const tags = rowDepts(row);
    if (!tags.length) return esc(dash(row.exception_label));
    return '<span class="kpi-dept-chips">' + tags.map((id) => {
      const dept = DEPTS.find((item) => item.id === id);
      return '<span class="kpi-dept-chip kpi-dept-chip--' + esc(id) + '">' + esc(dept ? dept.label : id) + "</span>";
    }).join("") + "</span>";
  }

  function dateCell(kind, value) {
    return `<td class="kpi-datecell kpi-datecell--${kind}">${esc(dash(value))}</td>`;
  }

  function partCells(row) {
    return `<td><span class="kpi-job">${esc(dash(row.part_no))}</span></td><td class="kpi-wrap">${esc(dash(row.description))}</td>`;
  }

  function renderMaterial() {
    const summaryNode = $("kpi-material-summary");
    const card = $("kpi-material-card");
    const body = $("kpi-material-body");
    const empty = $("kpi-material-empty");
    const rows = materialRows();
    paintSort($("kpi-panel-material"), state.soSort.material.key, state.soSort.material.dir);
    if (summaryNode) {
      summaryNode.hidden = false;
      summaryNode.innerHTML = [
        ["Arrived late", rows.length, rows.length ? "kpi-stat--hot" : ""],
      ].map(([label, value, cls]) => (
        '<article class="kpi-stat ' + cls + '">' +
          '<div class="kpi-stat-value">' + esc(value) + '</div>' +
          '<div class="kpi-stat-label">' + esc(label) + '</div>' +
        '</article>'
      )).join("");
    }
    if ($("kpi-material-meta")) {
      $("kpi-material-meta").textContent = rows.length + " process sheet" + (rows.length === 1 ? "" : "s");
    }
    if (body) {
      body.innerHTML = rows.map((row) => {
        const gapClass = "kpi-gap--late";
        return `<tr class="${isResolved("material", row) ? "kpi-row--resolved" : ""}">
          ${resolvedCell("material", row)}
          <td>${typePill(row)}<span class="kpi-job">${esc(row.process_sheet_no)}</span><span class="kpi-sub">${esc(row.sales_order_no)}</span></td>
          ${partCells(row)}
          ${dateCell("need", row.material_need_date)}
          ${dateCell("arrival", row.material_arrival_date)}
          <td class="kpi-num kpi-datecell kpi-datecell--gap ${gapClass}">${esc(row.gap_label)}</td>
          ${dateCell("due", row.due_date)}
          ${dateCell("edd", row.edd_date)}
          ${remarkCells(row, ["mtl_part_order", "quality_doc", "ops_notes", "sales_notes"])}
        </tr>`;
      }).join("");
    }
    if (card) card.hidden = false;
    if (empty) empty.hidden = rows.length > 0;
    paintColumnFilters();
  }

  function renderDeptbar() {
    const host = $("kpi-deptbar");
    if (!host) return;
    if (state.tab !== "exceptions") {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const counts = {};
    DEPTS.forEach((dept) => { counts[dept.id] = 0; });
    exceptionPool().forEach((row) => {
      rowDepts(row).forEach((id) => {
        if (counts[id] != null) counts[id] += 1;
      });
    });
    const allOn = state.deptMode !== "custom";
    host.innerHTML =
      '<span class="kpi-typebar-label">Department</span>' +
      '<button type="button" class="kpi-dept kpi-dept--all' + (allOn ? " is-on" : "") + '" data-dept-tag="__all" aria-pressed="' + allOn + '">All</button>' +
      DEPTS.map((dept) => {
        const on = !allOn && state.deptTags.has(dept.id);
        return (
          '<button type="button" class="kpi-dept kpi-dept--' + dept.id + (on ? " is-on" : "") + '" data-dept-tag="' + esc(dept.id) + '" aria-pressed="' + on + '">' +
            esc(dept.label) + '<span class="kpi-type-count">' + counts[dept.id] + "</span></button>"
        );
      }).join("");
  }

  function moneyText(value, known) {
    if (!known) return "—";
    return Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function exceptionValueTotals(rows) {
    let partial = 0;
    let partialKnown = 0;
    let full = 0;
    let fullKnown = 0;
    let missingPrice = 0;
    const seen = new Set();
    rows.forEach((row) => {
      const partialValue = Number(row.partial_value);
      if (Number.isFinite(partialValue)) {
        partial += partialValue;
        partialKnown += 1;
      } else {
        missingPrice += 1;
      }
      const sheet = String(row.sales_order_no || "") + "|" + String(row.process_sheet_no || "");
      if (seen.has(sheet)) return;
      seen.add(sheet);
      const fullValue = Number(row.full_value);
      if (Number.isFinite(fullValue)) {
        full += fullValue;
        fullKnown += 1;
      }
    });
    return { partial, partialKnown, full, fullKnown, missingPrice };
  }

  function renderExceptions() {
    const summaryNode = $("kpi-exception-summary");
    const card = $("kpi-exception-card");
    const body = $("kpi-exception-body");
    const empty = $("kpi-exception-empty");
    const rows = exceptionRows();
    const jobs = new Set(rows.map((row) => row.process_sheet_no)).size;
    const values = exceptionValueTotals(rows);
    renderDeptbar();
    paintSort($("kpi-panel-exceptions"), state.soSort.exceptions.key, state.soSort.exceptions.dir);
    if (summaryNode) {
      summaryNode.hidden = false;
      const cards = [
        ["Flagged partials", rows.length, ""],
        ["Process sheets", jobs, ""],
        ["Partial value", moneyText(values.partial, values.partialKnown), "Exception partial qty × unit selling price", true],
        ["Full value", moneyText(values.full, values.fullKnown), "Process sheet qty × unit selling price, once per sheet", true],
      ];
      if (state.deptMode === "custom") {
        DEPTS.filter((dept) => state.deptTags.has(dept.id)).forEach((dept) => {
          cards.push([dept.label, rows.filter((row) => rowDepts(row).includes(dept.id)).length, "", false]);
        });
      }
      summaryNode.innerHTML = cards.map(([label, value, title, money]) => (
        '<article class="kpi-stat"' + (title ? ' title="' + esc(title) + '"' : "") + ">" +
          '<div class="kpi-stat-value' + (money ? " kpi-stat-value--money" : "") + '">' + esc(value) + "</div>" +
          '<div class="kpi-stat-label">' + esc(label) + "</div>" +
        "</article>"
      )).join("");
    }
    if ($("kpi-exception-meta")) {
      const noun = rows.length === 1 ? "partial" : "partials";
      const missing = values.missingPrice
        ? " · " + values.missingPrice + (values.missingPrice === 1 ? " line has" : " lines have") + " no unit price"
        : "";
      $("kpi-exception-meta").textContent = rows.length + " " + noun + " · " + deptColumnNote() + missing;
    }
    if (body) {
      body.innerHTML = rows.map((row) => `<tr class="${isResolved("exceptions", row) ? "kpi-row--resolved" : ""}">
        ${resolvedCell("exceptions", row)}
        <td>${typePill(row)}<span class="kpi-job">${esc(row.process_sheet_no)}</span><span class="kpi-sub">${esc(row.sales_order_no)}</span></td>
        <td>${esc(row.partial_label)}</td>
        ${partCells(row)}
        <td>${esc(dash(row.posted_date))}</td>
        <td>${esc(dash(row.due_date))}</td>
        <td>${esc(dash(row.edd_date))}</td>
        <td class="kpi-exception-cell">${exceptionChips(row)}</td>
        ${remarkCells(row, [{ key: "delivery_date" }].concat(DEPT_COLUMNS))}
      </tr>`).join("");
    }
    syncDeptColumns();
    paintColumnFilters();
    if (card) card.hidden = false;
    if (empty) {
      const total = (state.so?.exception_rows || []).length;
      empty.textContent = total && !rows.length
        ? "Nothing matches these filters."
        : "No active S/O lines are flagged with an exception.";
      empty.hidden = rows.length > 0;
    }
  }

  async function loadSo(force) {
    if (state.so && !force) {
      renderTypebar();
      renderMaterial();
      renderExceptions();
      $("kpi-export").disabled = false;
      return;
    }
    setLoading(true, "Loading S/O management...");
    showAlert("");
    try {
      const fetchFn = window.reportsApiFetch || fetch;
      const res = await fetchFn("/api/kpi/so-management");
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || ("HTTP " + res.status));
      }
      state.so = data;
      renderTypebar();
      renderMaterial();
      renderExceptions();
      $("kpi-export").disabled = false;
    } catch (err) {
      showAlert(err && err.message ? err.message : "Could not load S/O management.");
    } finally {
      setLoading(false);
    }
  }

  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll("[data-kpi-tab]").forEach((btn) => {
      const on = btn.getAttribute("data-kpi-tab") === tab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll("[data-kpi-panel]").forEach((panel) => {
      panel.hidden = panel.getAttribute("data-kpi-panel") !== tab;
    });
    document.querySelector(".kpi-page")?.setAttribute("data-screen", tab);
    setSubtitle();
    renderTypebar();
    closeColFilter();
    renderDeptbar();
    showAlert("");
    if (tab === "qc") {
      $("kpi-export").disabled = !state.rows.length && !state.summary;
      return;
    }
    $("kpi-export").disabled = !state.so;
    loadSo(false);
  }

  function bind() {
    ["kpi-from", "kpi-to", "kpi-status", "kpi-min-days"].forEach((id) => {
      $(id)?.addEventListener("change", load);
    });
    $("kpi-include-open")?.addEventListener("change", load);
    $("kpi-search")?.addEventListener("input", scheduleLoad);
    $("kpi-material-search")?.addEventListener("input", renderMaterial);
    $("kpi-exception-search")?.addEventListener("input", renderExceptions);
    $("kpi-refresh")?.addEventListener("click", () => {
      if (state.tab === "qc") load();
      else loadSo(true);
    });
    $("kpi-export")?.addEventListener("click", exportCsv);
    document.querySelectorAll("[data-kpi-tab]").forEach((btn) => {
      btn.addEventListener("click", () => showTab(btn.getAttribute("data-kpi-tab")));
    });
    document.querySelectorAll("[data-so-sort]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.closest("[data-kpi-panel]")?.getAttribute("data-kpi-panel");
        const key = btn.getAttribute("data-so-sort");
        const sort = state.soSort[view];
        if (!sort || !key) return;
        if (sort.key === key) sort.dir = sort.dir === "asc" ? "desc" : "asc";
        else {
          sort.key = key;
          sort.dir = key === "day_gap" ? "desc" : "asc";
        }
        if (view === "material") renderMaterial();
        else renderExceptions();
      });
    });
    $("kpi-typebar")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-ps-type]");
      if (!btn) return;
      toggleType(btn.getAttribute("data-ps-type"));
    });
    $("kpi-deptbar")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-dept-tag]");
      if (!btn) return;
      toggleDept(btn.getAttribute("data-dept-tag"));
    });
    const colPopover = $("kpi-col-popover");
    colPopover?.addEventListener("click", (event) => event.stopPropagation());
    colPopover?.addEventListener("change", (event) => {
      if (event.target.type !== "checkbox" || !state.openFilter) return;
      setColumnFilter(state.openFilter, checkedFilterValues());
    });
    document.addEventListener("click", (event) => {
      const filterBtn = event.target.closest("[data-col-filter]");
      if (filterBtn) {
        event.preventDefault();
        event.stopPropagation();
        openColFilter(filterBtn);
        return;
      }
      if (event.target.closest("#kpi-col-popover")) return;
      if (state.openFilter) closeColFilter();
    });
    $("kpi-col-value")?.addEventListener("input", () => {
      filterListItems($("kpi-col-value").value);
    });
    $("kpi-col-clear")?.addEventListener("click", () => {
      if (!state.openFilter) return;
      if ($("kpi-col-value")) $("kpi-col-value").value = "";
      setColumnFilter(state.openFilter, new Set());
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.openFilter) closeColFilter();
    });
    document.querySelectorAll(".kpi-table-wrap").forEach((wrap) => {
      wrap.addEventListener("scroll", () => {
        if (state.openFilter) closeColFilter();
      });
    });
    $("kpi-hide-resolved")?.addEventListener("change", () => {
      state.hideResolved = !!$("kpi-hide-resolved").checked;
      saveResolved();
      rerenderActive();
    });
    document.querySelector(".kpi-page")?.addEventListener("change", (event) => {
      const box = event.target.closest("[data-resolve]");
      if (!box) return;
      const view = box.getAttribute("data-resolve");
      const key = box.getAttribute("data-resolve-key");
      if (!state.resolved[view]) state.resolved[view] = {};
      if (box.checked) state.resolved[view][key] = 1;
      else delete state.resolved[view][key];
      saveResolved();
      rerenderActive();
    });
    document.querySelectorAll("[data-kpi-sort]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-kpi-sort");
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = key;
          state.sortDir = key === "days_at_qc" || key === "pushed_at" || key === "left_at" ? "desc" : "asc";
        }
        renderTable();
      });
    });
  }

  loadPsTypes();
  loadDepts();
  loadResolved();
  setDefaults();
  setSubtitle();
  bind();
  renderTypebar();
  paintColumnFilters();
  load();
})();
