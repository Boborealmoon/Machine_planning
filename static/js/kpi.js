(function () {
  const SUBTITLES = {
    qc: "Days at QC start from the QAQC Pushed to QC stamp (the Deburring scan into Final Inspection). The clock stops at the first Packing scan after that stamp. Jobs still in Final Inspection keep counting through today. A job that has left Final Inspection without a Packing scan is listed with the stay time blank.",
    material: "Active S/O lines where the material arrived after the need date. Need is the material need date. Arrival is the Material in date. Gap is how many days late. PO due is the customer due date. Proposed EDD is the planner date from S/O management.",
    exceptions: "Active S/O lines flagged with an exception. Each row is one partial, with the part description, posted date, due date, proposed EDD, and the remarks from S/O management.",
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
    filterTimer: 0,
    resolved: { qc: {}, material: {}, exceptions: {} },
    hideResolved: false,
  };

  const COLUMN_LABELS = {
    qc: [
      ["ps_id", "Job"],
      ["part_no", "Part"],
      ["customer_name", "Customer"],
      ["current_stage_desc", "Stage"],
      ["pushed_at", "Pushed to QC"],
      ["left_at", "Left QC"],
      ["days_at_qc", "Days at QC"],
      ["qc_state", "State"],
      ["inspector_name", "Inspector"],
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

  const COLUMN_FIELDS = {
    qc: {
      ps_id: ["ps_id", "ps_type"],
      part_no: ["part_no", "part_desc", "sales_order_no"],
      customer_name: ["customer_name", "customer_code"],
      current_stage_desc: ["current_stage_desc", "stage_status_label"],
      pushed_at: ["pushed_at"],
      left_at: ["left_at", "left_stage_desc"],
      days_at_qc: ["days_at_qc", "elapsed_label"],
      qc_state: ["qc_state_label", "qc_state"],
      inspector_name: ["inspector_name"],
    },
    material: {
      process_sheet_no: ["process_sheet_no", "sales_order_no", "ps_type"],
      part_no: ["part_no"],
      description: ["description"],
      material_need_date: ["material_need_date"],
      material_arrival_date: ["material_arrival_date"],
      day_gap: ["day_gap", "gap_label"],
      due_date: ["due_date"],
      edd_date: ["edd_date"],
      mtl_part_order: ["mtl_part_order"],
      quality_doc: ["quality_doc"],
      ops_notes: ["ops_notes"],
      sales_notes: ["sales_notes"],
    },
    exceptions: {
      process_sheet_no: ["process_sheet_no", "sales_order_no", "ps_type"],
      partial_no: ["partial_label", "partial_no"],
      part_no: ["part_no"],
      description: ["description"],
      posted_date: ["posted_date"],
      due_date: ["due_date"],
      edd_date: ["edd_date"],
      exception_label: ["exception_label"],
      delivery_date: ["delivery_date"],
      mtl_part_order: ["mtl_part_order"],
      quality_doc: ["quality_doc"],
      ops_notes: ["ops_notes"],
      sales_notes: ["sales_notes"],
    },
  };

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

  function customerLabel(row) {
    return row.customer_name || row.customer_code || "";
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

  function renderSummary(summary) {
    const host = $("kpi-summary");
    if (!host) return;
    const s = summary || {};
    const cards = [
      ["In QC now", s.in_qc, ""],
      ["Avg days still in QC", s.avg_days_in_qc, ""],
      ["Left QC", s.left_qc, ""],
      ["Avg days at QC", s.avg_days_left, ""],
      ["Median days (left QC)", s.median_days_left, ""],
      ["In QC 3 days or more", s.in_qc_3d, s.in_qc_3d ? "kpi-stat--alert" : ""],
      ["In QC 7 days or more", s.in_qc_7d, s.in_qc_7d ? "kpi-stat--hot" : ""],
      ["Left, time not recorded", s.left_unstamped, ""],
    ];
    host.innerHTML = cards.map(([label, value, cls]) => {
      const shown = value == null || value === "" ? "—" : value;
      return (
        '<article class="kpi-stat ' + cls + '">' +
          '<div class="kpi-stat-value">' + esc(shown) + '</div>' +
          '<div class="kpi-stat-label">' + esc(label) + '</div>' +
        '</article>'
      );
    }).join("");
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

  function renderColFilter() {
    const select = $("kpi-col-key");
    const input = $("kpi-col-value");
    const chips = $("kpi-col-chips");
    const options = COLUMN_LABELS[state.tab] || [];
    const filters = state.colFilters[state.tab] || {};
    if (select && select.dataset.tab !== state.tab) {
      select.innerHTML = options.map(([key, label]) => '<option value="' + esc(key) + '">' + esc(label) + "</option>").join("");
      select.dataset.tab = state.tab;
      const active = options.find(([key]) => filters[key]);
      select.value = active ? active[0] : (options[0] ? options[0][0] : "");
      if (input) input.value = filters[select.value] || "";
    }
    if (!chips) return;
    const labels = Object.fromEntries(options);
    const activeKeys = Object.keys(filters).filter((key) => filters[key]);
    chips.innerHTML = activeKeys.map((key) => (
      '<button type="button" class="kpi-filter-chip" data-clear-filter="' + esc(key) + '">' +
        esc(labels[key] || key) + ": " + esc(filters[key]) + " ×</button>"
    )).join("");
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

  function matchesColumns(row, view) {
    const filters = state.colFilters[view] || {};
    const fields = COLUMN_FIELDS[view] || {};
    return Object.keys(filters).every((key) => {
      const query = filters[key];
      if (!query) return true;
      const names = fields[key] || [key];
      const hay = names.map((name) => String(row[name] == null ? "" : row[name])).join(" ").toLowerCase();
      return hay.includes(query);
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

  function sortedRows() {
    const dir = state.sortDir === "asc" ? 1 : -1;
    return state.rows.filter((row) => passesView(row, "qc")).slice().sort((a, b) => {
      const base = compare(a, b, state.sortKey);
      if (base) return base * dir;
      return String(a.ps_id || "").localeCompare(String(b.ps_id || ""));
    });
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
      const partSub = [row.part_desc, row.sales_order_no].filter(Boolean).join(" · ");
      const stageSub = row.stage_status_label || "";
      const days = row.days_at_qc == null
        ? "—"
        : (row.elapsed_label ? row.elapsed_label : String(row.days_at_qc));
      const daysTitle = row.days_at_qc == null ? "" : String(row.days_at_qc) + " days";
      return (
        '<tr class="' + rowClass(row) + '">' +
          resolvedCell("qc", row) +
          '<td>' + typePill(row) + '<span class="kpi-job">' + esc(row.ps_id || "—") + '</span>' +
            (partial ? '<span class="kpi-sub">' + esc(partial) + '</span>' : '') +
          '</td>' +
          '<td class="kpi-wrap"><span>' + esc(dash(row.part_no)) + '</span>' +
            (partSub ? '<span class="kpi-sub">' + esc(partSub) + '</span>' : '') +
          '</td>' +
          '<td class="kpi-wrap">' + esc(dash(customerLabel(row))) + '</td>' +
          '<td><span>' + esc(dash(row.current_stage_desc)) + '</span>' +
            (stageSub ? '<span class="kpi-sub">' + esc(stageSub) + '</span>' : '') +
          '</td>' +
          '<td>' + esc(dash(row.pushed_at)) + '</td>' +
          '<td>' + esc(dash(row.left_at)) +
            (row.left_stage_desc ? '<span class="kpi-sub">' + esc(row.left_stage_desc) + '</span>' : '') +
          '</td>' +
          '<td class="kpi-num kpi-days" title="' + esc(daysTitle) + '">' + esc(days) + '</td>' +
          '<td><span class="kpi-pill kpi-pill--' + esc(row.qc_state) + '">' + esc(row.qc_state_label || "—") + '</span></td>' +
          '<td>' + esc(dash(row.inspector_name)) + '</td>' +
        '</tr>'
      );
    }).join("");
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
  const REMARK_COLUMNS = [["delivery_date", "Delivered"]].concat(NOTE_COLUMNS);

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
        ].concat(REMARK_COLUMNS),
        withResolved("exceptions", exceptionRows())
      );
      return;
    }
    const columns =         [
          ["resolved", "Resolved"],
          ["ps_type", "PS type"],
          ["ps_id", "Job"],
      ["pp_partial_no", "Partial"],
      ["part_no", "Part no"],
      ["part_desc", "Description"],
      ["sales_order_no", "Sales order"],
      ["customer_name", "Customer"],
      ["customer_code", "Customer code"],
      ["qty", "Qty"],
      ["due_date", "PO due"],
      ["current_stage_desc", "Current stage"],
      ["stage_status_label", "Stage status"],
      ["pushed_at", "Pushed to QC"],
      ["left_at", "Left QC"],
      ["left_stage_desc", "Left via"],
      ["days_at_qc", "Days at QC"],
      ["elapsed_label", "Elapsed"],
      ["qc_state_label", "QC state"],
      ["inspector_name", "Inspector"],
      ["qty_jump", "Deburr qty increase"],
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
      if (key === "day_gap") {
        const an = Number(av) || 0;
        const bn = Number(bv) || 0;
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

  function exceptionRows() {
    const query = soQuery("kpi-exception-search");
    const keys = [
      "process_sheet_no", "sales_order_no", "customer_name", "part_no", "description",
      "exception_label", "delivery_date", "mtl_part_order", "quality_doc", "ops_notes", "sales_notes",
    ];
    const rows = (state.so?.exception_rows || []).filter((row) => soMatch(row, query, keys) && passesView(row, "exceptions"));
    return sortSoRows(rows, "exceptions");
  }

  function remarkCells(row, keys) {
    const cols = keys || ["delivery_date", "mtl_part_order", "quality_doc", "ops_notes", "sales_notes"];
    return cols
      .map((key) => `<td class="kpi-wrap">${esc(dash(row[key]))}</td>`)
      .join("");
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
  }

  function renderExceptions() {
    const summaryNode = $("kpi-exception-summary");
    const card = $("kpi-exception-card");
    const body = $("kpi-exception-body");
    const empty = $("kpi-exception-empty");
    const rows = exceptionRows();
    const jobs = new Set(rows.map((row) => row.process_sheet_no)).size;
    paintSort($("kpi-panel-exceptions"), state.soSort.exceptions.key, state.soSort.exceptions.dir);
    if (summaryNode) {
      summaryNode.hidden = false;
      summaryNode.innerHTML = [
        ["Flagged partials", rows.length],
        ["Process sheets", jobs],
      ].map(([label, value]) => (
        '<article class="kpi-stat">' +
          '<div class="kpi-stat-value">' + esc(value) + '</div>' +
          '<div class="kpi-stat-label">' + esc(label) + '</div>' +
        '</article>'
      )).join("");
    }
    if ($("kpi-exception-meta")) {
      $("kpi-exception-meta").textContent = rows.length + " partial" + (rows.length === 1 ? "" : "s");
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
        <td><span class="kpi-pill kpi-pill--exception">${esc(row.exception_label)}</span></td>
        ${remarkCells(row)}
      </tr>`).join("");
    }
    if (card) card.hidden = false;
    if (empty) empty.hidden = rows.length > 0;
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
    renderColFilter();
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
    $("kpi-col-key")?.addEventListener("change", () => {
      const key = $("kpi-col-key").value;
      const input = $("kpi-col-value");
      if (input) input.value = (state.colFilters[state.tab] || {})[key] || "";
    });
    $("kpi-col-value")?.addEventListener("input", () => {
      const key = $("kpi-col-key")?.value;
      if (!key) return;
      if (!state.colFilters[state.tab]) state.colFilters[state.tab] = {};
      const value = ($("kpi-col-value").value || "").trim().toLowerCase();
      if (value) state.colFilters[state.tab][key] = value;
      else delete state.colFilters[state.tab][key];
      window.clearTimeout(state.filterTimer);
      state.filterTimer = window.setTimeout(() => {
        renderColFilter();
        rerenderActive();
      }, 120);
    });
    $("kpi-col-chips")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-clear-filter]");
      if (!btn) return;
      const key = btn.getAttribute("data-clear-filter");
      if (state.colFilters[state.tab]) delete state.colFilters[state.tab][key];
      if ($("kpi-col-key")?.value === key && $("kpi-col-value")) $("kpi-col-value").value = "";
      renderColFilter();
      rerenderActive();
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
  loadResolved();
  setDefaults();
  setSubtitle();
  bind();
  renderTypebar();
  renderColFilter();
  load();
})();
