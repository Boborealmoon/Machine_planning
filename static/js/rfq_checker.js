(() => {
  const FIELDS = [
    "part_no", "rfq", "customer", "salesperson", "qty", "opns", "assignment",
    "machines", "total_ct_mins", "machine_hours", "total_hours", "days",
    "lead_time", "need_tooling", "need_fixture", "remark",
  ];
  const LABELS = {
    part_no: "Part No.",
    rfq: "RFQ",
    customer: "Cust.",
    salesperson: "Salesperson",
    sheet_tag: "Tag",
    qty: "QTY",
    opns: "Opns",
    assignment: "Assignment",
    machines: "Machines",
    total_ct_mins: "Total C/T (mins)",
    machine_hours: "Machine Hours",
    total_hours: "Total Hours",
    days: "Days",
    lead_time: "Lead Time",
    need_tooling: "Need Tooling?",
    need_fixture: "Need Fixture?",
    remark: "Remark",
  };
  const FILL_FIELDS = new Set(["assignment", "remark"]);
  const HOUR_FIELDS = ["machine_hours", "total_hours"];
  const CALC_FIELDS = new Set(["qty", "total_ct_mins", "total_hours"]);
  const ARCHIVE_FIELDS = ["sheet_tag", ...FIELDS];
  const DEFAULT_FIELD_BY_ID = {
    "rfq-default-rfq": "rfq",
    "rfq-default-customer": "customer",
    "rfq-default-salesperson": "salesperson",
  };

  const pageRoot = document.querySelector("[data-rfq-page]");
  const page = pageRoot ? pageRoot.getAttribute("data-rfq-page") : "";
  const saveTimers = {};
  let batch = null;
  let lastFile = null;
  let lastSheets = null;
  let fieldLabels = { ...LABELS };
  let knownCustomers = [];

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function dash(value) {
    const text = String(value == null ? "" : value).trim();
    return text || "-";
  }

  function showAlert(message, ok) {
    const el = $("rfq-alert");
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.classList.toggle("is-ok", Boolean(ok));
    el.textContent = message;
  }

  async function api(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 524 || res.status === 504 || res.status === 502) {
        throw new Error(
          data.error
          || `Upload timed out (HTTP ${res.status}). Uncheck “Use LLM to map columns” and pick a single RFQ sheet.`
        );
      }
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  function headerRow(fields) {
    return `<tr>${(fields || FIELDS).map((field) => `<th>${escapeHtml(fieldLabels[field] || LABELS[field] || field)}</th>`).join("")}</tr>`;
  }

  function tagBadge(tag) {
    const text = String(tag || "").trim();
    if (!text) return "-";
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return `<span class="rfq-sheet-tag rfq-sheet-tag--${escapeHtml(key)}">${escapeHtml(text)}</span>`;
  }

  function statusPill(status) {
    const text = String(status || "").trim().toLowerCase();
    if (!text) return "";
    const label = text === "archived" ? "saved" : text;
    return `<span class="rfq-status-pill rfq-status-pill--${escapeHtml(text)}">${escapeHtml(label)}</span>`;
  }

  function partButton(partNo, matchStatus, priorCount) {
    const badge = matchStatus
      ? `<span class="rfq-badge rfq-badge--${matchStatus === "matched" ? "matched" : "new"}">${matchStatus === "matched" ? "known" : "new"}</span>`
      : "";
    const prior = Number(priorCount || 0) > 0
      ? `<span class="rfq-badge rfq-badge--quoted">quoted before</span>`
      : "";
    return `<button type="button" class="rfq-part-link" data-part="${escapeHtml(partNo)}" title="Part details">${escapeHtml(dash(partNo))}</button>${badge}${prior}`;
  }

  function displayValue(value) {
    if (value == null || value === "") return "";
    if (typeof value === "number" && Number.isFinite(value)) {
      return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
    }
    return String(value);
  }

  function formatWhen(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  }

  function cellClass(field) {
    const extras = [];
    if (FILL_FIELDS.has(field)) extras.push(`rfq-td-${field}`);
    if (field === "days" || field === "lead_time") extras.push(`rfq-td-${field}`);
    return extras.length ? ` class="${extras.join(" ")}"` : "";
  }

  function renderReadRow(row, { clickablePart = true, fields } = {}) {
    const match = row.match_status || "";
    const cls = match === "matched" ? "is-matched" : match === "new" ? "is-new" : "";
    const cells = (fields || FIELDS).map((field) => {
      const extra = cellClass(field);
      if (field === "sheet_tag") {
        return `<td>${tagBadge(row.sheet_tag || "")}</td>`;
      }
      if (field === "part_no" && clickablePart) {
        return `<td${extra}>${partButton(row.part_no || "", match, row.prior_quote_count)}</td>`;
      }
      return `<td${extra}>${escapeHtml(displayValue(row[field]))}</td>`;
    }).join("");
    return `<tr class="${cls}" data-line-id="${escapeHtml(row.line_id || "")}">${cells}</tr>`;
  }

  function renderEditRow(row) {
    const match = row.match_status || "";
    const cls = match === "matched" ? "is-matched" : "is-new";
    const cells = ARCHIVE_FIELDS.map((field) => {
      const fillClass = FILL_FIELDS.has(field) ? ` rfq-cell--${field}` : "";
      const scheduleClass = (field === "days" || field === "lead_time") ? ` rfq-cell--${field}` : "";
      const extra = cellClass(field);
      if (field === "sheet_tag") {
        return `<td>${tagBadge(row.sheet_tag || "")}</td>`;
      }
      if (field === "part_no") {
        return `<td${extra}>${partButton(row.part_no || "", match, row.prior_quote_count)}</td>`;
      }
      const type = ["qty", "total_ct_mins", "machine_hours", "total_hours", "days"].includes(field) ? "number" : "text";
      return `<td${extra}><input class="rfq-cell${fillClass}${scheduleClass}" data-field="${field}" data-line-id="${escapeHtml(row.line_id)}" type="${type}" value="${escapeHtml(displayValue(row[field]))}"${type === "number" ? ' step="any"' : ""}></td>`;
    }).join("");
    return `<tr class="${cls}" data-line-id="${escapeHtml(row.line_id)}">${cells}</tr>`;
  }

  function splitMachines(value) {
    return String(value || "").split(/[,;/|]+/).map((item) => item.trim()).filter(Boolean);
  }

  function machineKey(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  const STANDARD_OPS = [
    ["Milling (mins)", "3 Axis", "ML"],
    ["Milling (mins)", "4 Axis", "ML"],
    ["Milling (mins)", "5 Axis", "ML"],
    ["Milling (mins)", "5 Axis (i-800)", "ML"],
    ["Turning (mins)", "Quick Turn", "TN"],
    ["Turning (mins)", "J-200", "TN"],
    ["Turning (mins)", "i-250", "TN"],
    ["EDM (mins)", "Wirecut", "EDM"],
    ["EDM (mins)", "EDM", "EDM"],
    ["EDM (mins)", "Superdrill", "EDM"],
    ["Backend (mins)", "Deburring", "BE"],
    ["Backend (mins)", "Cleaning", "BE"],
  ];

  function standardOps() {
    return STANDARD_OPS.map(([group, machine, code]) => ({
      group,
      machine,
      code,
      header: `${group} / ${machine}`,
    }));
  }

  function machineColumns(lines) {
    for (const row of lines || []) {
      const cols = row.quote && row.quote.columns;
      if (Array.isArray(cols) && cols.length) return cols;
    }
    if ((lines || []).some((row) => row.quote && row.quote.format === "op_sheet")) return standardOps();
    return [];
  }

  function isOpSheet(lines) {
    return (lines || []).some((row) => {
      const quote = row.quote || {};
      return quote.format === "op_sheet" || (Array.isArray(quote.columns) && quote.columns.length > 0);
    });
  }

  function pickedMachines(row) {
    const quote = (row && row.quote) || {};
    if (quote.machine_selection || quote.machines_from_sheet) return splitMachines(row.machines);
    return [];
  }

  function groupTone(group) {
    const key = String(group || "").toLowerCase();
    if (key.startsWith("mill")) return "mill";
    if (key.startsWith("turn")) return "turn";
    if (key.startsWith("edm")) return "edm";
    if (key.startsWith("back")) return "back";
    return "other";
  }

  function groupedColumns(columns) {
    const groups = [];
    (columns || []).forEach((col) => {
      const last = groups[groups.length - 1];
      if (last && last.group === col.group) last.items.push(col);
      else groups.push({ group: col.group, items: [col] });
    });
    return groups;
  }

  function quoteNum(quote, key) {
    if (!quote || quote[key] == null || quote[key] === "") return "";
    return displayValue(quote[key]);
  }

  function columnMinutes(quote, col) {
    const header = col.header;
    const times = (quote && quote.times) || {};
    if (Object.prototype.hasOwnProperty.call(times, header) && times[header] != null && times[header] !== "") {
      return displayValue(times[header]);
    }
    const hit = ((quote && quote.operations) || []).find((op) => (
      machineKey(op.machine) === machineKey(col.machine) || op.header === header
    ));
    if (hit && hit.mins != null && hit.mins !== "") return displayValue(hit.mins);
    return "";
  }

  function sheetInput(attrs, value, numeric) {
    const step = numeric ? ' step="any"' : "";
    const kind = numeric ? "number" : "text";
    return `<input class="rfq-sheet-input${numeric ? " rfq-sheet-input--num" : ""}" type="${kind}"${step} ${attrs} value="${escapeHtml(value)}">`;
  }

  function quoteInput(row, field, kind) {
    const type = kind === "text" ? "text" : "number";
    const step = type === "number" ? ' step="any"' : "";
    const cls = type === "number" ? " rfq-cell--mins" : "";
    return `<input class="rfq-cell${cls}" data-quote-field="${field}" data-line-id="${escapeHtml(row.line_id)}" type="${type}"${step} value="${escapeHtml(quoteNum(row.quote, field))}">`;
  }

  function machinePicker(row, columns) {
    const selected = new Set(pickedMachines(row).map(machineKey));
    const boxes = groupedColumns(columns).map((group) => {
      const items = group.items.map((col) => {
        const on = selected.has(machineKey(col.machine));
        return `<label class="rfq-machine-option"><input type="checkbox" data-machine-choice data-line-id="${escapeHtml(row.line_id)}" value="${escapeHtml(col.machine)}"${on ? " checked" : ""}> ${escapeHtml(col.machine)}</label>`;
      }).join("");
      return `<p class="rfq-machine-group">${escapeHtml(group.group)}</p>${items}`;
    }).join("");
    const text = pickedMachines(row).join(", ");
    return `<details class="rfq-machine-pick"><summary class="rfq-machine-summary${text ? " is-set" : ""}" data-machine-summary>${escapeHtml(text || "Use")}</summary><div class="rfq-machine-menu">${boxes}</div></details>`;
  }

  function opSheetHead(lines) {
    const groups = groupedColumns(machineColumns(lines));
    const top = ["Part Number", "Descriptions", "RFQ QTY", "MAT"].map((label) => (
      `<th rowspan="2"${label === "Part Number" ? ' class="rfq-sheet-sticky"' : ""}>${escapeHtml(label)}</th>`
    ));
    const sub = [];
    top.push('<th colspan="3" class="rfq-th--rm">Raw Material (mm)</th>');
    ["Thk/Ø", "Width", "Length"].forEach((label) => sub.push(`<th class="rfq-th--rm">${escapeHtml(label)}</th>`));
    top.push('<th rowspan="2" class="rfq-th--setup">Setup (mins)</th>');
    groups.forEach((group) => {
      const tone = groupTone(group.group);
      top.push(`<th colspan="${group.items.length}" class="rfq-th--${tone}">${escapeHtml(group.group)}</th>`);
      group.items.forEach((col) => sub.push(`<th class="rfq-th--${tone}">${escapeHtml(col.machine)}</th>`));
    });
    top.push('<th rowspan="2" class="rfq-th--use">Use</th>');
    top.push('<th colspan="3" class="rfq-th--calc">Calculated</th>');
    ["C/T", "Mc hrs", "Total hrs"].forEach((label) => sub.push(`<th class="rfq-th--calc">${escapeHtml(label)}</th>`));
    top.push('<th rowspan="2" class="rfq-th--remark">Remark</th>');
    return `<tr>${top.join("")}</tr><tr>${sub.join("")}</tr>`;
  }

  function renderOpRow(row, columns) {
    const cols = columns || machineColumns([row]);
    const match = row.match_status || "";
    const id = escapeHtml(row.line_id);
    const quote = row.quote || {};
    const minutes = cols.map((col) => {
      const tone = groupTone(col.group);
      return `<td class="rfq-td--${tone}">${sheetInput(`data-op-time data-line-id="${id}" data-op-header="${escapeHtml(col.header)}"`, columnMinutes(quote, col), true)}</td>`;
    }).join("");
    return `<tr data-line-id="${id}">
      <td class="rfq-sheet-sticky">${partButton(row.part_no || "", match, row.prior_quote_count)}</td>
      <td class="rfq-sheet-desc"><textarea class="rfq-sheet-input rfq-sheet-desc-input" data-quote-field="description" data-line-id="${id}" rows="2">${escapeHtml(quoteNum(quote, "description"))}</textarea></td>
      <td>${sheetInput(`data-field="qty" data-line-id="${id}"`, displayValue(row.qty), true)}</td>
      <td class="rfq-sheet-mat">${sheetInput(`data-quote-field="material_type" data-line-id="${id}"`, quoteNum(quote, "material_type"), false)}</td>
      <td class="rfq-td--rm">${sheetInput(`data-quote-field="rm_thk" data-line-id="${id}"`, quoteNum(quote, "rm_thk"), true)}</td>
      <td class="rfq-td--rm">${sheetInput(`data-quote-field="rm_width" data-line-id="${id}"`, quoteNum(quote, "rm_width"), true)}</td>
      <td class="rfq-td--rm">${sheetInput(`data-quote-field="rm_length" data-line-id="${id}"`, quoteNum(quote, "rm_length"), true)}</td>
      <td class="rfq-td--setup">${sheetInput(`data-quote-field="setup_mins" data-line-id="${id}"`, quoteNum(quote, "setup_mins"), true)}</td>
      ${minutes}
      <td class="rfq-td--use">${machinePicker(row, cols)}</td>
      <td class="rfq-td--calc">${sheetInput(`data-field="total_ct_mins" data-line-id="${id}"`, displayValue(row.total_ct_mins), true)}</td>
      <td class="rfq-td--calc">${sheetInput(`data-field="machine_hours" data-line-id="${id}"`, displayValue(row.machine_hours), true)}</td>
      <td class="rfq-td--calc">${sheetInput(`data-field="total_hours" data-line-id="${id}"`, displayValue(row.total_hours), true)}</td>
      <td class="rfq-td--remark"><textarea class="rfq-sheet-input rfq-sheet-remark" data-field="remark" data-line-id="${id}" rows="3">${escapeHtml(displayValue(row.remark))}</textarea></td>
    </tr>`;
  }

  function linesHead(lines) {
    return isOpSheet(lines) ? opSheetHead(lines) : headerRow(ARCHIVE_FIELDS);
  }

  function linesBody(lines) {
    if (!isOpSheet(lines)) return (lines || []).map((row) => renderEditRow(row)).join("");
    const columns = machineColumns(lines);
    return (lines || []).map((row) => renderOpRow(row, columns)).join("");
  }

  function qtyText(value) {
    if (value == null || value === "") return "-";
    const number = Number(value);
    if (!Number.isFinite(number)) return dash(value);
    return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
  }

  function materialLine(quote) {
    const type = String((quote && quote.material_type) || "").trim();
    const spec = String((quote && quote.material_spec) || "").trim();
    return [type, spec].filter(Boolean).join(" · ") || "-";
  }

  function rmLine(quote) {
    const bits = ["rm_thk", "rm_width", "rm_length"].map((key) => {
      const value = quote ? quote[key] : null;
      return value == null || value === "" ? "" : qtyText(value);
    }).filter((item) => item && item !== "-");
    return bits.length ? `${bits.join(" × ")} mm` : "-";
  }

  function positiveOps(quote) {
    return ((quote && quote.operations) || []).filter((op) => Number(op.mins) > 0);
  }

  function fact(label, value) {
    const text = String(value == null ? "" : value).trim();
    if (!text || text === "-") return "";
    return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text)}</dd></div>`;
  }

  function machineTimeTable(quote) {
    const ops = positiveOps(quote);
    if (!ops.length) return "";
    const body = ops.map((op) => `
      <tr>
        <td>${escapeHtml(dash(op.machine))}</td>
        <td>${escapeHtml(qtyText(op.mins))}</td>
      </tr>`).join("");
    return `<table class="rfq-mini-table rfq-mini-table--times"><thead><tr><th>Machine</th><th>Mins</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  function earlierTable(rows) {
    if (!rows || !rows.length) return "";
    const body = rows.map((row) => {
      const machines = positiveOps(row.quote).map((op) => op.machine).filter(Boolean).join(", ");
      return `
        <tr>
          <td>${escapeHtml(formatWhen(row.created_at || row.batch_created_at || row.updated_at) || "—")}</td>
          <td>${escapeHtml(dash(row.filename))}</td>
          <td>${escapeHtml(dash(row.rfq))}</td>
          <td>${escapeHtml(qtyText(row.qty))}</td>
          <td>${escapeHtml(qtyText(row.total_ct_mins))}</td>
          <td>${escapeHtml(machines || "—")}</td>
        </tr>`;
    }).join("");
    return `<table class="rfq-mini-table"><thead><tr><th>Uploaded</th><th>File</th><th>RFQ</th><th>Qty</th><th>C/T</th><th>Machines used</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  function quoteBlock(row) {
    const quote = row.quote || {};
    const when = formatWhen(row.created_at || row.batch_created_at || row.updated_at || row.batch_updated_at);
    const remark = String(row.remark || quote.engineering_remarks || "").trim();
    return `
      <article class="rfq-quote">
        <header class="rfq-quote-head">
          <strong>${escapeHtml(dash(row.filename))}</strong>
          <span>${escapeHtml(when)}</span>
        </header>
        <dl class="rfq-facts">
          ${fact("RFQ", row.rfq)}
          ${fact("Sales", row.salesperson)}
          ${fact("Customer", row.customer)}
          ${fact("Qty", qtyText(row.qty))}
          ${fact("Material", materialLine(quote))}
          ${fact("Raw", rmLine(quote))}
          ${fact("Setup", quote.setup_mins != null && quote.setup_mins !== "" ? `${qtyText(quote.setup_mins)} min` : "")}
          ${fact("C/T", row.total_ct_mins != null && row.total_ct_mins !== "" ? `${qtyText(row.total_ct_mins)} min` : "")}
          ${fact("Hours", qtyText(row.total_hours))}
        </dl>
        ${machineTimeTable(quote)}
        ${remark ? `<p class="rfq-quote-remark">${escapeHtml(remark)}</p>` : ""}
      </article>`;
  }

  function stockTable(rows, emptyText) {
    if (!rows || !rows.length) return `<p class="rfq-empty">${escapeHtml(emptyText)}</p>`;
    const body = rows.map((row) => `
      <tr>
        <td>${escapeHtml(dash(row.inventory_code))}</td>
        <td>${escapeHtml(dash(row.main_desc || row.short_desc))}</td>
        <td>${escapeHtml(dash(row.inventory_class_code))}</td>
        <td>${escapeHtml(qtyText(row.total_qty_on_hand))}</td>
        <td>${escapeHtml(qtyText(row.total_free_balance_qty))}</td>
        <td>${escapeHtml(qtyText(row.total_qty_on_order))}</td>
        <td>${escapeHtml(qtyText(row.total_qty_back_order))}</td>
      </tr>`).join("");
    return `<table class="rfq-mini-table"><thead><tr><th>Part</th><th>Description</th><th>Class</th><th>On hand</th><th>Free bal</th><th>On order</th><th>Back order</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  function renderCheckPayload(data) {
    const results = $("rfq-check-results");
    const empty = $("rfq-check-empty");
    if (!results) return;
    const parts = (data && data.parts) || [];
    if (data && data.inventory_error) {
      showAlert(`Finished-goods lookup failed: ${data.inventory_error}. Previous quotes are still shown.`);
    } else {
      showAlert("");
    }
    results.innerHTML = parts.map((part) => {
      const quotes = (part.quotes || []).map((row) => quoteBlock(row)).join("");
      const other = (part.other_inventory || []).length
        ? `<h3>Same part, not finished goods</h3>${stockTable(part.other_inventory, "")}`
        : "";
      return `
        <article class="rfq-check-card">
          <h2>${escapeHtml(part.part_no)}</h2>
          <h3>Previous quotes <span class="rfq-check-count">${(part.quotes || []).length}</span></h3>
          ${quotes || "<p class='rfq-empty'>No previous quote for this part.</p>"}
          <h3>Finished goods</h3>
          ${stockTable(part.finished_goods, "No FG MFG or FG MRO row for this part number.")}
          ${other}
        </article>`;
    }).join("");
    results.hidden = parts.length === 0;
    if (empty) empty.hidden = parts.length > 0;
  }

  async function runCheck(payload) {
    const loading = $("rfq-loading");
    if (loading && page === "library") loading.hidden = false;
    try {
      const data = await api("/api/rfq-checker/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
      const box = $("rfq-check-input");
      if (box && (!box.value || payload.batch_id)) {
        box.value = (data.parts || []).map((part) => part.part_no).join("\n");
      }
      renderCheckPayload(data);
      return data;
    } catch (err) {
      showAlert(err.message);
      return null;
    } finally {
      if (loading && page === "library") loading.hidden = true;
    }
  }

  const TAB_NOTES = {
    master: "Each customer is a group. Under it are the part numbers from quotes we saved, with cycle time, machines, and the last RFQ.",
    check: "Paste part numbers from a new RFQ. This shows every earlier quote for those parts, and finished-goods stock.",
    archive: "Each card is one Excel file. Open it to edit the lines, check stock, or delete the file.",
    parts: "These are parts we already fabricate, from process sheets and the cycle-time master. They are not quotes.",
  };

  function activateTab(name) {
    document.querySelectorAll("[data-rfq-tab]").forEach((tab) => {
      const on = tab.getAttribute("data-rfq-tab") === name;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
    const note = $("rfq-nav-note");
    if (note) note.textContent = TAB_NOTES[name] || TAB_NOTES.master;
    if ($("rfq-panel-master")) $("rfq-panel-master").hidden = name !== "master";
    if ($("rfq-panel-parts")) $("rfq-panel-parts").hidden = name !== "parts";
    if ($("rfq-panel-archive")) $("rfq-panel-archive").hidden = name !== "archive";
    if ($("rfq-panel-check")) $("rfq-panel-check").hidden = name !== "check";
    const loadingLabel = $("rfq-loading-label");
    if (loadingLabel) {
      loadingLabel.textContent = name === "archive"
        ? "Loading uploads..."
        : name === "parts"
          ? "Loading shop parts..."
          : "Loading quoted parts...";
    }
    if (name === "master") loadMaster();
    if (name === "parts") loadLibrary();
    if (name === "archive") loadArchive();
  }

  async function deleteBatch(batchId, filename) {
    const label = filename ? ` “${filename}”` : "";
    if (!window.confirm(`Delete upload${label}? Its lines are removed from the tracker.`)) return;
    await api(`/api/rfq-checker/batches/${batchId}`, { method: "DELETE" });
    if (page === "upload") {
      window.location.href = "/archive/rfq-checker";
      return;
    }
    showAlert("Upload deleted.", true);
    loadArchive();
  }

  async function openPart(partNo) {
    const drawer = $("rfq-drawer");
    const title = $("rfq-drawer-title");
    const body = $("rfq-drawer-body");
    if (!drawer || !partNo) return;
    title.textContent = partNo;
    body.innerHTML = "<p class='rfq-empty'>Loading part history...</p>";
    drawer.hidden = false;
    const partCall = api(`/api/rfq-checker/parts/${encodeURIComponent(partNo)}`).then(
      (data) => data,
      () => null,
    );
    const checkCall = api("/api/rfq-checker/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [partNo] }),
    }).then((data) => data, () => null);
    try {
      const [partData, checkData] = await Promise.all([partCall, checkCall]);
      const part = (partData && partData.part) || {};
      const profile = part.rfq_profile || {};
      const checked = ((checkData && checkData.parts) || [])[0] || {};
      const history = checked.quotes || part.rfq_history || [];
      const matchedLine = batch && (batch.lines || []).find((row) => String(row.part_no || "").trim().toUpperCase() === String(partNo).trim().toUpperCase());
      const current = matchedLine
        ? Object.assign({}, matchedLine, {
          filename: batch.filename,
          created_at: batch.created_at || matchedLine.created_at,
        })
        : (history[0] || {});
      const earlier = history.filter((row) => String(row.line_id || "") !== String(current.line_id || ""));
      const description = (current.quote && current.quote.description) || part.part_description || "";
      const finished = checked.finished_goods || [];
      const otherStock = checked.other_inventory || [];
      const ops = (part.operations || []).map((op) => `
        <tr>
          <td>${escapeHtml(dash(op.op_no || op.stage_no))}</td>
          <td>${escapeHtml(dash(op.op_type || op.stage_name))}</td>
          <td>${escapeHtml(dash(op.cycle_time || op.ideal_cycle_time))}</td>
        </tr>`).join("");
      const sheets = (part.process_sheets || []).map((ps) => `
        <tr>
          <td>${escapeHtml(dash(ps.ps_id))}</td>
          <td>${escapeHtml(dash(ps.order_date))}</td>
          <td>${escapeHtml(dash(ps.total_qty))}</td>
        </tr>`).join("");
      const machines = positiveOps(current.quote).map((op) => `
        <li><span>${escapeHtml(dash(op.machine))}</span><b>${escapeHtml(qtyText(op.mins))}</b></li>`).join("");
      const remark = String((current.remark || (current.quote && current.quote.engineering_remarks) || "")).trim();
      const sourceBits = [current.filename, formatWhen(current.created_at)].filter(Boolean);
      const shopBits = [
        sheets ? `<h4>Process sheets</h4><table class="rfq-mini-table"><thead><tr><th>PS</th><th>Order date</th><th>Qty</th></tr></thead><tbody>${sheets}</tbody></table>` : "",
        ops ? `<h4>Cycle time</h4><table class="rfq-mini-table"><thead><tr><th>Op</th><th>Type</th><th>Mins</th></tr></thead><tbody>${ops}</tbody></table>` : "",
        profile.opns || profile.total_ct_mins ? `<p class="rfq-part-note">Last saved quote: ${escapeHtml(dash(profile.opns))} · ${escapeHtml(qtyText(profile.total_ct_mins))} min</p>` : "",
      ].filter(Boolean);
      const sections = [
        finished.length ? `<section class="rfq-drawer-section"><h3>Finished goods</h3>${stockTable(finished, "")}</section>` : "",
        otherStock.length ? `<section class="rfq-drawer-section"><h3>Other stock</h3>${stockTable(otherStock, "")}</section>` : "",
        earlier.length ? `<section class="rfq-drawer-section"><h3>Earlier quotes</h3>${earlierTable(earlier)}</section>` : "",
        shopBits.length ? `<section class="rfq-drawer-section"><h3>Already made here</h3>${shopBits.join("")}</section>` : "",
      ].filter(Boolean);
      document.querySelectorAll("tr.is-part-open").forEach((row) => row.classList.remove("is-part-open"));
      document.querySelectorAll(`[data-part]`).forEach((btn) => {
        if (String(btn.getAttribute("data-part") || "").trim().toUpperCase() === String(partNo).trim().toUpperCase()) {
          const row = btn.closest("tr");
          if (row) row.classList.add("is-part-open");
        }
      });
      title.textContent = partNo;
      body.innerHTML = `
        <p class="rfq-part-desc">${escapeHtml(description || "No description on this line.")}</p>
        ${sourceBits.length ? `<p class="rfq-part-source">${escapeHtml(sourceBits.join(" · "))}</p>` : ""}
        <dl class="rfq-facts">
          ${fact("RFQ", current.rfq)}
          ${fact("Sales", current.salesperson)}
          ${fact("Customer", current.customer)}
          ${fact("Qty", qtyText(current.qty))}
          ${fact("Material", materialLine(current.quote))}
          ${fact("Raw", rmLine(current.quote))}
          ${fact("Setup", current.quote && current.quote.setup_mins != null && current.quote.setup_mins !== "" ? `${qtyText(current.quote.setup_mins)} min` : "")}
          ${fact("C/T", current.total_ct_mins != null && current.total_ct_mins !== "" ? `${qtyText(current.total_ct_mins)} min` : "")}
          ${fact("Hours", qtyText(current.total_hours))}
        </dl>
        ${machines ? `<ul class="rfq-machine-list">${machines}</ul>` : `<p class="rfq-part-note">No machine minutes on this line.</p>`}
        ${remark ? `<p class="rfq-quote-remark">${escapeHtml(remark)}</p>` : ""}
        ${sections.join("") || `<p class="rfq-part-note">No finished goods, earlier quote, or shop record for this part.</p>`}`;
    } catch (err) {
      body.innerHTML = `<p class="rfq-empty">${escapeHtml(err.message)}</p>`;
    }
  }

  function bindPartLinks(root) {
    (root || document).querySelectorAll("[data-part]").forEach((btn) => {
      btn.addEventListener("click", () => openPart(btn.getAttribute("data-part")));
    });
  }

  function closeDrawer() {
    const drawer = $("rfq-drawer");
    if (drawer) drawer.hidden = true;
    document.querySelectorAll("tr.is-part-open").forEach((row) => row.classList.remove("is-part-open"));
  }

  function customerGroupName(row) {
    const name = String((row && row.customer) || "").trim();
    return name || "No customer yet";
  }

  function groupQuotedParts(rows) {
    const groups = new Map();
    (rows || []).forEach((row) => {
      const name = customerGroupName(row);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(row);
    });
    return Array.from(groups.entries()).sort((left, right) => {
      const leftMissing = left[0] === "No customer yet";
      const rightMissing = right[0] === "No customer yet";
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
      return left[0].localeCompare(right[0], undefined, { sensitivity: "base" });
    });
  }

  function quotedPartRow(row) {
    return `
      <tr>
        <td>${partButton(row.part_no || "")}</td>
        <td>${escapeHtml(dash(row.assignment))}</td>
        <td>${escapeHtml(dash(row.opns))}</td>
        <td>${escapeHtml(qtyText(row.total_ct_mins))}</td>
        <td>${escapeHtml(dash(row.machines))}</td>
        <td>${escapeHtml(dash(row.last_rfq))}</td>
        <td>${tagBadge(row.sheet_tag || "")}</td>
        <td>${escapeHtml(dash(row.salesperson))}</td>
      </tr>`;
  }

  async function loadMaster() {
    const loading = $("rfq-loading");
    const q = ($("rfq-master-search") && $("rfq-master-search").value) || "";
    if (loading) loading.hidden = false;
    showAlert("");
    try {
      const data = await api(`/api/rfq-checker/part-master?q=${encodeURIComponent(q)}&limit=2000`);
      const rows = data.rows || [];
      const groups = $("rfq-master-groups");
      const empty = $("rfq-master-empty");
      const grouped = groupQuotedParts(rows);
      if (groups) {
        groups.innerHTML = grouped.map(([customer, items]) => `
          <section class="rfq-customer">
            <header class="rfq-customer-head">
              <h2 class="rfq-customer-name">${escapeHtml(customer)}</h2>
              <span class="rfq-customer-count">${items.length} part${items.length === 1 ? "" : "s"}</span>
            </header>
            <div class="rfq-table-scroll">
              <table class="rfq-table rfq-table--quotes">
                <thead>
                  <tr>
                    <th>Part No.</th>
                    <th>Assignment</th>
                    <th>Opns</th>
                    <th>Total C/T (mins)</th>
                    <th>Machines</th>
                    <th>Last RFQ</th>
                    <th>Tag</th>
                    <th>Salesperson</th>
                  </tr>
                </thead>
                <tbody>${items.map((row) => quotedPartRow(row)).join("")}</tbody>
              </table>
            </div>
          </section>`).join("");
        bindPartLinks(groups);
        groups.hidden = rows.length === 0;
      }
      if (empty) empty.hidden = rows.length > 0;
    } catch (err) {
      showAlert(err.message);
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  async function loadLibrary() {
    const loading = $("rfq-loading");
    const q = ($("rfq-parts-search") && $("rfq-parts-search").value) || "";
    if (loading) loading.hidden = false;
    showAlert("");
    try {
      const data = await api(`/api/rfq-checker/parts?q=${encodeURIComponent(q)}`);
      const rows = data.rows || [];
      const body = $("rfq-parts-body");
      const card = $("rfq-parts-card");
      const empty = $("rfq-parts-empty");
      body.innerHTML = rows.map((row) => `
        <tr>
          <td>${partButton(row.part_no || "")}</td>
          <td>${escapeHtml(dash(row.part_description))}</td>
          <td>${escapeHtml(dash(row.opns))}</td>
          <td>${escapeHtml(dash(row.op_count))}</td>
          <td>${escapeHtml(dash(row.total_ct_mins))}</td>
          <td>${escapeHtml(dash(row.ps_count))}</td>
          <td>${escapeHtml(dash(row.last_order_date))}</td>
        </tr>`).join("");
      card.hidden = rows.length === 0;
      empty.hidden = rows.length > 0;
      bindPartLinks(body);
    } catch (err) {
      showAlert(err.message);
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function matchSummary(batchData) {
    const lines = (batchData && batchData.lines) || [];
    const total = Number(batchData.line_count != null ? batchData.line_count : lines.length);
    const known = Number(batchData.matched_count != null ? batchData.matched_count : lines.filter((row) => row.match_status === "matched").length);
    const fresh = Number(batchData.new_count != null ? batchData.new_count : lines.filter((row) => row.match_status === "new").length);
    return `${total} lines · <span class="rfq-batch-known">${known} known</span> · <span class="rfq-batch-new">${fresh} new</span>`;
  }

  function defaultsMarkup(batchData) {
    const id = batchData.batch_id;
    const when = formatWhen(batchData.created_at || batchData.batch_created_at || batchData.updated_at);
    return `
      <div class="rfq-batch-defaults" data-defaults-for="${escapeHtml(id)}">
        <div class="rfq-meta-bar">
          <p class="rfq-upload-when">Uploaded ${escapeHtml(when || "—")}</p>
          <label class="rfq-meta-field"><span class="rfq-label">RFQ no.</span>
            <input class="rfq-input" data-default-field="rfq" data-batch-id="${escapeHtml(id)}" type="text" value="${escapeHtml(batchData.default_rfq || "")}" autocomplete="off"></label>
          <label class="rfq-meta-field"><span class="rfq-label">Salesperson</span>
            <input class="rfq-input" data-default-field="salesperson" data-batch-id="${escapeHtml(id)}" type="text" value="${escapeHtml(batchData.default_salesperson || "")}" autocomplete="off"></label>
          <label class="rfq-meta-field"><span class="rfq-label">Customer</span>
            <input class="rfq-input" data-default-field="customer" data-batch-id="${escapeHtml(id)}" type="text" value="${escapeHtml(batchData.default_customer || "")}" autocomplete="off"></label>
        </div>
      </div>`;
  }

  function renderBatchGroup(batchData, { startOpen = false } = {}) {
    const lines = batchData.lines || [];
    const loaded = lines.length > 0 || Number(batchData.line_count || 0) === 0;
    const id = batchData.batch_id;
    const openClass = startOpen ? " is-open" : "";
    const truncated = Boolean(batchData.lines_truncated);
    const body = loaded
      ? linesBody(lines)
      : `<tr><td colspan="${isOpSheet(lines) ? 40 : ARCHIVE_FIELDS.length}" class="rfq-empty">Open this upload to edit its lines.</td></tr>`;
    return `
      <article class="rfq-batch${openClass}" data-batch-id="${escapeHtml(id)}" data-loaded="${loaded ? "1" : "0"}">
        <header class="rfq-batch-head">
          <button type="button" class="rfq-batch-toggle" data-toggle-batch="${escapeHtml(id)}" aria-expanded="${startOpen ? "true" : "false"}">${startOpen ? "Hide" : "Show"}</button>
          <div class="rfq-batch-meta">
            <p class="rfq-batch-title">${escapeHtml(dash(batchData.filename))} ${tagBadge(batchData.sheet_tag)} ${statusPill(batchData.status || batchData.batch_status)}</p>
            <p class="rfq-batch-sub">${escapeHtml(dash(batchData.sheet_name))} · ${escapeHtml(formatWhen(batchData.updated_at || batchData.batch_updated_at))} · ${matchSummary(batchData)}</p>
          </div>
          <div class="rfq-batch-actions">
            <button type="button" class="rfq-btn rfq-btn--ghost" data-check-batch="${escapeHtml(id)}">Check stock</button>
            <a class="rfq-btn rfq-btn--ghost" href="/archive/rfq-checker/upload?batch=${encodeURIComponent(id)}">Edit file</a>
            <button type="button" class="rfq-btn rfq-btn--danger" data-delete-batch="${escapeHtml(id)}" data-filename="${escapeHtml(batchData.filename || "")}">Delete</button>
          </div>
        </header>
        <div class="rfq-batch-panel">
          ${defaultsMarkup(batchData)}
          ${truncated ? `<p class="rfq-batch-note">Showing ${lines.length} of ${Number(batchData.line_count)} lines. Open upload to edit the rest.</p>` : ""}
          <div class="rfq-table-card">
            <div class="rfq-table-scroll">
              <table class="rfq-table rfq-table--wide rfq-table--edit${isOpSheet(lines) ? " rfq-table--opsheet" : ""}">
                <thead>${linesHead(lines)}</thead>
                <tbody data-batch-lines="${escapeHtml(id)}">${body}</tbody>
              </table>
            </div>
          </div>
        </div>
      </article>`;
  }

  async function hydrateBatch(batchId, startOpen) {
    const data = await api(`/api/rfq-checker/batches/${batchId}?limit=300`);
    const card = document.querySelector(`.rfq-batch[data-batch-id="${batchId}"]`);
    if (!card) return data.batch;
    const open = startOpen || card.classList.contains("is-open");
    card.outerHTML = renderBatchGroup(data.batch, { startOpen: open });
    bindPartLinks($("rfq-archive-groups"));
    return data.batch;
  }

  async function loadArchive() {
    const q = ($("rfq-archive-search") && $("rfq-archive-search").value) || "";
    const groups = $("rfq-archive-groups");
    const empty = $("rfq-archive-empty");
    const loading = $("rfq-loading");
    if (loading) loading.hidden = false;
    try {
      const data = await api(`/api/rfq-checker/archive?q=${encodeURIComponent(q)}`);
      const batches = data.batches || [];
      if (groups) {
        groups.innerHTML = batches.map((item) => renderBatchGroup(item, { startOpen: false })).join("");
        bindPartLinks(groups);
      }
      if (groups) groups.hidden = batches.length === 0;
      if (empty) empty.hidden = batches.length > 0;
      if (batches[0] && batches[0].batch_id) {
        await hydrateBatch(batches[0].batch_id, true);
      }
    } catch (err) {
      showAlert(err.message);
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function renderMapping(batchData) {
    const wrap = $("rfq-mapping");
    const grid = $("rfq-mapping-grid");
    const notes = $("rfq-mapping-notes");
    if (!wrap || !grid) return;
    const mapping = batchData.mapping || {};
    let headers = batchData.headers || [];
    if (!headers.length) {
      const source = ((batchData.lines || [])[0] || {}).source_row || {};
      if (source && typeof source === "object") headers = Object.keys(source);
    }
    notes.textContent = batchData.mapping_notes || "";
    grid.innerHTML = FIELDS.map((field) => {
      const current = Object.keys(mapping).find((header) => mapping[header] === field) || "";
      const options = ["<option value=''>Not mapped</option>"]
        .concat(headers.map((header) => `<option value="${escapeHtml(header)}"${header === current ? " selected" : ""}>${escapeHtml(header)}</option>`));
      return `<label class="rfq-inline"><span class="rfq-label">${escapeHtml(fieldLabels[field] || field)}</span><select class="rfq-select" data-map-field="${field}">${options.join("")}</select></label>`;
    }).join("");
    wrap.hidden = false;
  }

  function mappingFromForm() {
    const mapping = {};
    document.querySelectorAll("[data-map-field]").forEach((select) => {
      const field = select.getAttribute("data-map-field");
      const header = select.value;
      if (field && header) mapping[header] = field;
    });
    return mapping;
  }

  function majorityValue(lines, field) {
    const counts = {};
    (lines || []).forEach((row) => {
      const value = String(row[field] || "").trim();
      if (!value) return;
      counts[value] = (counts[value] || 0) + 1;
    });
    let top = "";
    let best = 0;
    Object.keys(counts).forEach((key) => {
      if (counts[key] > best) {
        top = key;
        best = counts[key];
      }
    });
    return best * 2 >= (lines || []).length && best > 0 ? top : "";
  }

  function defaultsFromForm() {
    return {
      rfq: ($("rfq-default-rfq") && $("rfq-default-rfq").value) || "",
      customer: ($("rfq-default-customer") && $("rfq-default-customer").value) || "",
      salesperson: ($("rfq-default-salesperson") && $("rfq-default-salesperson").value) || "",
    };
  }

  function defaultsFromGroup(batchId) {
    const payload = {};
    document.querySelectorAll(`[data-default-field][data-batch-id="${batchId}"]`).forEach((input) => {
      payload[input.getAttribute("data-default-field")] = input.value;
    });
    return payload;
  }

  function renderTagPills(tag, root) {
    const current = String(tag || "").trim().toUpperCase();
    (root || document).querySelectorAll("[data-rfq-tag]").forEach((btn) => {
      if (root || !btn.getAttribute("data-batch-id") || page === "upload") {
        btn.classList.toggle("is-active", btn.getAttribute("data-rfq-tag") === current);
      }
    });
  }

  function renderDefaults(batchData) {
    const wrap = $("rfq-defaults");
    if (!wrap) return;
    const lines = (batchData && batchData.lines) || [];
    wrap.hidden = !(batchData && batchData.batch_id);
    const rfq = batchData.default_rfq || majorityValue(lines, "rfq");
    const customer = batchData.default_customer || majorityValue(lines, "customer");
    const salesperson = batchData.default_salesperson || majorityValue(lines, "salesperson");
    const when = formatWhen(batchData.created_at || batchData.updated_at);
    if ($("rfq-upload-when")) $("rfq-upload-when").textContent = when ? `Uploaded ${when}` : "Uploaded —";
    if ($("rfq-default-rfq")) $("rfq-default-rfq").value = rfq;
    if ($("rfq-default-customer")) $("rfq-default-customer").value = customer;
    if ($("rfq-default-salesperson")) $("rfq-default-salesperson").value = salesperson;
    syncSaveButton();
  }

  function chosenCustomer() {
    return String(($("rfq-default-customer") && $("rfq-default-customer").value) || "").trim();
  }

  function customerSuggestions(query) {
    const needle = String(query || "").trim().toLowerCase();
    return knownCustomers.filter((name) => !needle || name.toLowerCase().includes(needle)).slice(0, 12);
  }

  function hideCustomerMenu() {
    const menu = $("rfq-customer-menu");
    if (!menu) return;
    menu.hidden = true;
  }

  function renderCustomerMenu() {
    const menu = $("rfq-customer-menu");
    const input = $("rfq-default-customer");
    if (!menu || !input) return;
    const names = customerSuggestions(input.value).filter((name) => name.toLowerCase() !== input.value.trim().toLowerCase());
    if (!names.length || document.activeElement !== input) {
      hideCustomerMenu();
      menu.innerHTML = "";
      return;
    }
    menu.innerHTML = names.map((name) => `<button type="button" data-customer-option="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("");
    menu.hidden = false;
  }

  function rememberQuietBatch(batchData) {
    if (!batchData) return;
    const sheets = (batch && batch.sheets) || lastSheets;
    batch = batchData;
    if (!batch.sheets && sheets) batch.sheets = sheets;
    const saved = {
      "rfq-default-rfq": batchData.default_rfq || "",
      "rfq-default-customer": batchData.default_customer || "",
      "rfq-default-salesperson": batchData.default_salesperson || "",
    };
    Object.keys(saved).forEach((id) => {
      const input = $(id);
      if (!input || document.activeElement === input) return;
      if (input.value !== saved[id]) input.value = saved[id];
    });
    syncSaveButton();
  }

  function syncSaveButton() {
    const btn = $("rfq-save-archive");
    if (!btn) return;
    const hasLines = Boolean(batch && (batch.lines || []).length);
    btn.hidden = !hasLines;
    btn.disabled = !chosenCustomer();
  }

  async function saveDefaults(patch, batchId) {
    const id = batchId || (batch && batch.batch_id);
    if (!id) return;
    let payload = patch || (batchId ? defaultsFromGroup(batchId) : defaultsFromForm());
    if (!patch) {
      payload = { ...payload };
      ["rfq", "customer", "salesperson", "days", "lead_time"].forEach((field) => {
        if (!String(payload[field] || "").trim()) delete payload[field];
      });
      if (!payload.sheet_tag && !payload.rfq && !payload.customer && !payload.salesperson && payload.days == null && !payload.lead_time) {
        showAlert("Enter a tag, RFQ, customer, salesperson, days, or lead time first.");
        return;
      }
    }
    try {
      const data = await api(`/api/rfq-checker/batches/${id}/defaults`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const quiet = patch && Object.keys(patch).every((key) => key === "rfq" || key === "customer" || key === "salesperson");
      if (page === "upload") {
        if (quiet) rememberQuietBatch(data.batch);
        else renderBatch(data.batch);
      } else {
        const card = document.querySelector(`.rfq-batch[data-batch-id="${id}"]`);
        const open = !card || card.classList.contains("is-open");
        await hydrateBatch(id, open);
      }
      if (!quiet) showAlert("Saved.", true);
    } catch (err) {
      showAlert(err.message);
    }
  }

  function renderSheetSelect(batchData) {
    const select = $("rfq-sheet");
    if (!select) return;
    const sheets = batchData.sheets || lastSheets || [];
    if (batchData.sheets) lastSheets = batchData.sheets;
    if (!sheets.length) {
      const current = batchData.sheet_name || "";
      select.innerHTML = current
        ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`
        : `<option value="">Auto-detect</option>`;
      select.disabled = !lastFile;
      return;
    }
    const current = batchData.sheet_name || "";
    select.innerHTML = sheets.map((sheet) => {
      const count = Number(sheet.row_count || 0);
      const label = count > 0 ? `${sheet.name} (${count})` : sheet.name;
      return `<option value="${escapeHtml(sheet.name)}"${sheet.name === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
    select.disabled = !lastFile;
  }

  function renderBatch(batchData) {
    const keptSheets = (batch && batch.sheets) || lastSheets;
    batch = batchData;
    if (!batch.sheets && keptSheets) batch.sheets = keptSheets;
    fieldLabels = batchData.field_labels || fieldLabels;
    const card = $("rfq-lines-card");
    const empty = $("rfq-lines-empty");
    const saveBtn = $("rfq-save-archive");
    const lines = batchData.lines || [];
    const head = $("rfq-lines-head");
    const body = $("rfq-lines-body");
    const opSheet = isOpSheet(lines);
    if (head) head.innerHTML = linesHead(lines);
    if (body) body.innerHTML = linesBody(lines);
    const table = $("rfq-lines-table");
    if (table) table.classList.toggle("rfq-table--opsheet", opSheet);
    if (card) {
      const summary = card.querySelector(".rfq-summary") || document.createElement("p");
      summary.className = "rfq-summary";
      summary.innerHTML = matchSummary(batchData) + (opSheet
        ? " · Same columns as the op sheet. Tick Use on a row and hours recalculate from those machines."
        : "");
      if (!summary.parentNode) card.insertBefore(summary, card.firstChild);
      card.hidden = lines.length === 0;
    }
    if (empty) empty.hidden = lines.length > 0;
    if (saveBtn) saveBtn.hidden = lines.length === 0;
    const deleteBtn = $("rfq-delete-upload");
    const checkBtn = $("rfq-check-upload");
    if (deleteBtn) deleteBtn.hidden = !batchData.batch_id;
    if (checkBtn) checkBtn.hidden = lines.length === 0;
    if (body) bindPartLinks(body);
    renderMapping(batchData);
    renderDefaults(batch);
    renderSheetSelect(batch);
  }

  function rememberLine(row) {
    if (!batch || !row) return;
    const lines = batch.lines || [];
    const idx = lines.findIndex((item) => String(item.line_id) === String(row.line_id));
    if (idx >= 0) lines[idx] = Object.assign({}, lines[idx], row);
  }

  function applyLineCalc(tr, row) {
    if (!tr || !row) return;
    ["opns", "total_ct_mins", "machine_hours", "total_hours", "machines"].forEach((field) => {
      const cell = tr.querySelector(`[data-field="${field}"]`);
      if (cell && document.activeElement !== cell) cell.value = displayValue(row[field]);
    });
    const summary = tr.querySelector("[data-machine-summary]");
    if (summary) {
      const text = String(row.machines || "").trim();
      summary.textContent = text || "Use";
      summary.classList.toggle("is-set", Boolean(text));
    }
    rememberLine(row);
  }

  async function patchLine(lineId, payload, tr) {
    const data = await api(`/api/rfq-checker/lines/${lineId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    applyLineCalc(tr, data.row);
    showAlert("Saved.", true);
    return data;
  }

  function queueMachineSave(input) {
    const lineId = input.getAttribute("data-line-id");
    const tr = input.closest("tr");
    const key = `machines:${lineId}`;
    window.clearTimeout(saveTimers[key]);
    saveTimers[key] = window.setTimeout(() => {
      const names = Array.from(tr.querySelectorAll("[data-machine-choice]"))
        .filter((box) => box.checked)
        .map((box) => box.value);
      patchLine(lineId, { machines: names.join(", ") }, tr).catch((err) => showAlert(err.message));
    }, 200);
  }

  function queueOpTime(input) {
    const lineId = input.getAttribute("data-line-id");
    const header = input.getAttribute("data-op-header");
    const tr = input.closest("tr");
    const key = `time:${lineId}:${header}`;
    window.clearTimeout(saveTimers[key]);
    saveTimers[key] = window.setTimeout(() => {
      patchLine(lineId, { op_times: { [header]: input.value } }, tr).catch((err) => showAlert(err.message));
    }, 400);
  }

  function queueQuoteField(input) {
    const lineId = input.getAttribute("data-line-id");
    const field = input.getAttribute("data-quote-field");
    const tr = input.closest("tr");
    const key = `quote:${lineId}:${field}`;
    window.clearTimeout(saveTimers[key]);
    saveTimers[key] = window.setTimeout(() => {
      patchLine(lineId, { [field]: input.value }, tr).catch((err) => showAlert(err.message));
    }, 400);
  }

  function onLineEdit(event) {
    const target = event.target;
    if (!target || !target.matches) return;
    if (target.matches("[data-machine-choice]")) {
      queueMachineSave(target);
      return;
    }
    if (target.matches("[data-op-time]")) {
      queueOpTime(target);
      return;
    }
    if (target.matches("[data-quote-field]")) {
      queueQuoteField(target);
      return;
    }
    if (target.matches("[data-field]")) queueSave(target);
  }

  async function saveLine(input) {
    const lineId = input.getAttribute("data-line-id");
    const field = input.getAttribute("data-field");
    if (!lineId || !field) return;
    const payload = { [field]: input.value };
    try {
      const data = await api(`/api/rfq-checker/lines/${lineId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const row = data.row;
      if (row) applyLineCalc(input.closest("tr"), row);
      showAlert("Saved.", true);
    } catch (err) {
      showAlert(err.message);
    }
  }

  function queueSave(input) {
    const key = `${input.getAttribute("data-line-id")}:${input.getAttribute("data-field")}`;
    window.clearTimeout(saveTimers[key]);
    saveTimers[key] = window.setTimeout(() => saveLine(input), 400);
  }

  async function uploadFile(file, sheetName) {
    if (!file) return;
    const loading = $("rfq-loading");
    const loadingText = $("rfq-loading-text");
    if (loading) loading.hidden = false;
    if (loadingText) loadingText.textContent = "Matching known parts and filling cycle time...";
    showAlert("");
    const body = new FormData();
    body.append("file", file);
    body.append("use_llm", $("rfq-use-llm") && $("rfq-use-llm").checked ? "1" : "0");
    if (sheetName) body.append("sheet", sheetName);
    const defaults = defaultsFromForm();
    if (defaults.sheet_tag) body.append("sheet_tag", defaults.sheet_tag);
    if (defaults.rfq) body.append("rfq", defaults.rfq);
    if (defaults.customer) body.append("customer", defaults.customer);
    if (defaults.salesperson) body.append("salesperson", defaults.salesperson);
    try {
      const data = await api("/api/rfq-checker/upload", { method: "POST", body });
      renderBatch(data.batch);
      const params = new URLSearchParams(window.location.search);
      params.set("batch", data.batch.batch_id);
      history.replaceState({}, "", `${window.location.pathname}?${params}`);
      showAlert(data.batch.mapping_notes || "Workbook mapped. Known parts pulled existing C/T; hours calculated from minutes.", true);
    } catch (err) {
      showAlert(err.message);
      const select = $("rfq-sheet");
      if (select && batch && batch.sheet_name) select.value = batch.sheet_name;
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function initLibrary() {
    let timer = 0;
    $("rfq-master-search") && $("rfq-master-search").addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(loadMaster, 250);
    });
    $("rfq-parts-search") && $("rfq-parts-search").addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(loadLibrary, 250);
    });
    $("rfq-archive-search") && $("rfq-archive-search").addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(loadArchive, 250);
    });
    document.querySelectorAll("[data-rfq-tab]").forEach((tab) => {
      tab.addEventListener("click", () => activateTab(tab.getAttribute("data-rfq-tab")));
    });
    $("rfq-check-run") && $("rfq-check-run").addEventListener("click", () => {
      runCheck({ q: ($("rfq-check-input") && $("rfq-check-input").value) || "" });
    });
    const groups = $("rfq-archive-groups");
    groups && groups.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-delete-batch]");
      if (remove) {
        deleteBatch(remove.getAttribute("data-delete-batch"), remove.getAttribute("data-filename") || "")
          .catch((err) => showAlert(err.message));
        return;
      }
      const check = event.target.closest("[data-check-batch]");
      if (check) {
        activateTab("check");
        runCheck({ batch_id: Number(check.getAttribute("data-check-batch")) });
        return;
      }
      const toggle = event.target.closest("[data-toggle-batch]");
      if (toggle) {
        const batchId = toggle.getAttribute("data-toggle-batch");
        const card = toggle.closest(".rfq-batch");
        if (!card) return;
        const open = !card.classList.contains("is-open");
        if (open && card.getAttribute("data-loaded") !== "1") {
          hydrateBatch(batchId, true).catch((err) => showAlert(err.message));
          return;
        }
        card.classList.toggle("is-open", open);
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.textContent = open ? "Hide" : "Show";
        return;
      }
      const apply = event.target.closest("[data-apply-defaults]");
      if (apply) {
        saveDefaults(null, apply.getAttribute("data-apply-defaults"));
        return;
      }
      const tag = event.target.closest("[data-rfq-tag]");
      if (tag) {
        const batchId = tag.getAttribute("data-batch-id");
        const next = tag.classList.contains("is-active") ? "" : (tag.getAttribute("data-rfq-tag") || "");
        const input = document.querySelector(`[data-default-field="sheet_tag"][data-batch-id="${batchId}"]`);
        if (input) input.value = next;
        saveDefaults({ sheet_tag: next }, batchId);
      }
    });
    groups && groups.addEventListener("input", (event) => {
      if (event.target && event.target.matches("[data-default-field]")) {
        const batchId = event.target.getAttribute("data-batch-id");
        const field = event.target.getAttribute("data-default-field");
        const key = `batch-${batchId}:${field}`;
        window.clearTimeout(saveTimers[key]);
        saveTimers[key] = window.setTimeout(() => {
          saveDefaults({ [field]: event.target.value }, batchId);
        }, 450);
        return;
      }
      onLineEdit(event);
    });
    const opened = new URLSearchParams(window.location.search);
    const tabAlias = {
      check: "check",
      archive: "archive",
      uploads: "archive",
      parts: "parts",
      shop: "parts",
      master: "master",
      quotes: "master",
    };
    const initial = tabAlias[opened.get("tab") || ""] || "master";
    activateTab(initial);
    if (initial === "check" && opened.get("batch")) {
      runCheck({ batch_id: Number(opened.get("batch")) });
    }
  }

  function initUpload() {
    const fileInput = $("rfq-file");
    const dropzone = $("rfq-dropzone");
    $("rfq-browse") && $("rfq-browse").addEventListener("click", () => fileInput && fileInput.click());
    fileInput && fileInput.addEventListener("change", () => {
      lastFile = fileInput.files && fileInput.files[0];
      uploadFile(lastFile, "");
    });
    ["dragenter", "dragover"].forEach((eventName) => {
      dropzone && dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.add("is-hover");
      });
    });
    ["dragleave", "drop"].forEach((eventName) => {
      dropzone && dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.remove("is-hover");
      });
    });
    dropzone && dropzone.addEventListener("drop", (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      lastFile = file || lastFile;
      uploadFile(file, "");
    });
    const sheetSelect = $("rfq-sheet");
    sheetSelect && sheetSelect.addEventListener("change", () => {
      const wanted = sheetSelect.value;
      if (batch && wanted === (batch.sheet_name || "")) return;
      if (!lastFile) {
        showAlert("Choose the Excel file again to read a different sheet.");
        if (batch && batch.sheet_name) sheetSelect.value = batch.sheet_name;
        return;
      }
      uploadFile(lastFile, wanted);
    });
    Object.keys(DEFAULT_FIELD_BY_ID).forEach((id) => {
      const input = $(id);
      if (!input) return;
      input.addEventListener("input", () => {
        if (id === "rfq-sheet-tag") renderTagPills(input.value);
        if (id === "rfq-default-customer") {
          syncSaveButton();
          renderCustomerMenu();
        }
        window.clearTimeout(saveTimers.defaults);
        saveTimers.defaults = window.setTimeout(() => {
          saveDefaults({ [DEFAULT_FIELD_BY_ID[id]]: input.value });
        }, 450);
      });
    });
    $("rfq-lines-body") && $("rfq-lines-body").addEventListener("input", onLineEdit);
    $("rfq-remap") && $("rfq-remap").addEventListener("click", async () => {
      if (!batch) return;
      try {
        const data = await api(`/api/rfq-checker/batches/${batch.batch_id}/remap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ column_map: mappingFromForm() }),
        });
        renderBatch(data.batch);
        showAlert("Mapping re-applied.", true);
      } catch (err) {
        showAlert(err.message);
      }
    });
    $("rfq-delete-upload") && $("rfq-delete-upload").addEventListener("click", () => {
      if (!batch) return;
      deleteBatch(batch.batch_id, batch.filename).catch((err) => showAlert(err.message));
    });
    $("rfq-check-upload") && $("rfq-check-upload").addEventListener("click", () => {
      if (!batch || !batch.batch_id) return;
      window.location.href = `/archive/rfq-checker?tab=check&batch=${encodeURIComponent(batch.batch_id)}`;
    });
    $("rfq-save-archive") && $("rfq-save-archive").addEventListener("click", async () => {
      if (!batch) return;
      const customer = chosenCustomer();
      if (!customer) {
        showAlert("Choose the customer this quote is for before saving.");
        if ($("rfq-default-customer")) $("rfq-default-customer").focus();
        syncSaveButton();
        return;
      }
      try {
        await api(`/api/rfq-checker/batches/${batch.batch_id}/archive`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customer }),
        });
        window.location.href = "/archive/rfq-checker";
      } catch (err) {
        showAlert(err.message);
      }
    });
    const customerInput = $("rfq-default-customer");
    if (customerInput) {
      customerInput.addEventListener("focus", () => renderCustomerMenu());
      customerInput.addEventListener("blur", () => {
        window.setTimeout(hideCustomerMenu, 160);
      });
    }
    const customerMenu = $("rfq-customer-menu");
    if (customerMenu) {
      customerMenu.addEventListener("mousedown", (event) => {
        const choice = event.target.closest("[data-customer-option]");
        if (!choice || !customerInput) return;
        event.preventDefault();
        customerInput.value = choice.getAttribute("data-customer-option") || "";
        hideCustomerMenu();
        syncSaveButton();
        window.clearTimeout(saveTimers.defaults);
        saveDefaults({ customer: customerInput.value });
      });
    }
    api("/api/rfq-checker/part-master?limit=2000").then((data) => {
      const names = [];
      const seen = new Set();
      (data.rows || []).forEach((row) => {
        const name = String(row.customer || "").trim();
        const key = name.toLowerCase();
        if (!name || seen.has(key)) return;
        seen.add(key);
        names.push(name);
      });
      names.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
      knownCustomers = names;
    }).catch(() => {});
    const params = new URLSearchParams(window.location.search);
    const batchId = params.get("batch");
    if (batchId) {
      api(`/api/rfq-checker/batches/${batchId}`).then((data) => renderBatch(data.batch)).catch((err) => showAlert(err.message));
    }
  }

  $("rfq-drawer-close") && $("rfq-drawer-close").addEventListener("click", closeDrawer);
  $("rfq-drawer") && $("rfq-drawer").addEventListener("click", (event) => {
    if (event.target === $("rfq-drawer")) closeDrawer();
  });

  if (page === "library") initLibrary();
  if (page === "upload") initUpload();
})();
