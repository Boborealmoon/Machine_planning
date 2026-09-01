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
    "rfq-sheet-tag": "sheet_tag",
    "rfq-default-rfq": "rfq",
    "rfq-default-customer": "customer",
    "rfq-default-salesperson": "salesperson",
    "rfq-default-days": "days",
    "rfq-default-lead-time": "lead_time",
  };

  const pageRoot = document.querySelector("[data-rfq-page]");
  const page = pageRoot ? pageRoot.getAttribute("data-rfq-page") : "";
  const saveTimers = {};
  let batch = null;
  let lastFile = null;
  let lastSheets = null;
  let fieldLabels = { ...LABELS };

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

  function partButton(partNo, matchStatus) {
    const badge = matchStatus
      ? `<span class="rfq-badge rfq-badge--${matchStatus === "matched" ? "matched" : "new"}">${matchStatus === "matched" ? "known" : "new"}</span>`
      : "";
    return `<button type="button" class="rfq-part-link" data-part="${escapeHtml(partNo)}">${escapeHtml(dash(partNo))}</button>${badge}`;
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
        return `<td${extra}>${partButton(row.part_no || "", match)}</td>`;
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
        return `<td${extra}>${partButton(row.part_no || "", match)}</td>`;
      }
      const type = ["qty", "total_ct_mins", "machine_hours", "total_hours", "days"].includes(field) ? "number" : "text";
      return `<td${extra}><input class="rfq-cell${fillClass}${scheduleClass}" data-field="${field}" data-line-id="${escapeHtml(row.line_id)}" type="${type}" value="${escapeHtml(displayValue(row[field]))}"${type === "number" ? ' step="any"' : ""}></td>`;
    }).join("");
    return `<tr class="${cls}" data-line-id="${escapeHtml(row.line_id)}">${cells}</tr>`;
  }

  async function openPart(partNo) {
    const drawer = $("rfq-drawer");
    const title = $("rfq-drawer-title");
    const body = $("rfq-drawer-body");
    if (!drawer || !partNo) return;
    title.textContent = partNo;
    body.innerHTML = "<p class='rfq-empty'>Loading part history...</p>";
    drawer.hidden = false;
    try {
      const data = await api(`/api/rfq-checker/parts/${encodeURIComponent(partNo)}`);
      const part = data.part || {};
      const profile = part.rfq_profile || {};
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
      body.innerHTML = `
        <div class="rfq-drawer-section">
          <h3>RFQ assignment / C/T</h3>
          <p><strong>${escapeHtml(dash(part.part_no))}</strong><br>${escapeHtml(dash(part.part_description))}</p>
          <p>Assignment ${escapeHtml(dash(profile.assignment || part.assignment))}</p>
          <p>Opns ${escapeHtml(dash(profile.opns || part.opns))} | Total C/T ${escapeHtml(dash(profile.total_ct_mins != null ? profile.total_ct_mins : part.total_ct_mins))} mins</p>
          <p>Machines ${escapeHtml(dash(profile.machines || part.machines))}</p>
        </div>
        <div class="rfq-drawer-section">
          <h3>Cycle time master</h3>
          ${ops ? `<table class="rfq-mini-table"><thead><tr><th>Op</th><th>Type</th><th>C/T</th></tr></thead><tbody>${ops}</tbody></table>` : "<p class='rfq-empty'>No cycle-time rows.</p>"}
        </div>
        <div class="rfq-drawer-section">
          <h3>Process sheets</h3>
          ${sheets ? `<table class="rfq-mini-table"><thead><tr><th>PS</th><th>Order date</th><th>Qty</th></tr></thead><tbody>${sheets}</tbody></table>` : "<p class='rfq-empty'>No process sheets.</p>"}
        </div>`;
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
  }

  async function loadMaster() {
    const loading = $("rfq-loading");
    const q = ($("rfq-master-search") && $("rfq-master-search").value) || "";
    if (loading) loading.hidden = false;
    showAlert("");
    try {
      const data = await api(`/api/rfq-checker/part-master?q=${encodeURIComponent(q)}`);
      const rows = data.rows || [];
      const body = $("rfq-master-body");
      const card = $("rfq-master-card");
      const empty = $("rfq-master-empty");
      if (body) {
        body.innerHTML = rows.map((row) => `
          <tr>
            <td>${partButton(row.part_no || "")}</td>
            <td>${escapeHtml(dash(row.assignment))}</td>
            <td>${escapeHtml(dash(row.opns))}</td>
            <td>${escapeHtml(dash(row.total_ct_mins))}</td>
            <td>${escapeHtml(dash(row.machines))}</td>
            <td>${escapeHtml(dash(row.last_rfq))}</td>
            <td>${escapeHtml(dash(row.customer))}</td>
          </tr>`).join("");
        bindPartLinks(body);
      }
      if (card) card.hidden = rows.length === 0;
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

  function defaultsMarkup(batchData, { includeApply = true } = {}) {
    const id = batchData.batch_id;
    const tag = batchData.sheet_tag || "";
    const pills = ["APS", "NPS", "PPS", "MPS", "CPS", "SR"].map((item) => (
      `<button type="button" class="rfq-tag-pill${item === String(tag).toUpperCase() ? " is-active" : ""}" data-rfq-tag="${item}" data-batch-id="${escapeHtml(id)}">${item}</button>`
    )).join("");
    return `
      <div class="rfq-batch-defaults" data-defaults-for="${escapeHtml(id)}">
        <div class="rfq-defaults-head">
          <div>
            <h2 class="rfq-defaults-title">Edit this upload</h2>
            <p class="rfq-upload-hint">Apply once to every line, or edit a single row in the table.</p>
          </div>
          ${includeApply ? `<button type="button" class="rfq-btn rfq-btn--ghost" data-apply-defaults="${escapeHtml(id)}">Apply to all lines</button>` : ""}
        </div>
        <div class="rfq-defaults-row">
          <div class="rfq-inline rfq-defaults-tags">
            <span class="rfq-label">Tag</span>
            <div class="rfq-tag-pills" role="group">${pills}</div>
            <input class="rfq-input" data-default-field="sheet_tag" data-batch-id="${escapeHtml(id)}" type="text" maxlength="16" value="${escapeHtml(tag)}" placeholder="Other tag" autocomplete="off">
          </div>
          <label class="rfq-inline"><span class="rfq-label">RFQ</span>
            <input class="rfq-input" data-default-field="rfq" data-batch-id="${escapeHtml(id)}" type="text" value="${escapeHtml(batchData.default_rfq || "")}" autocomplete="off"></label>
          <label class="rfq-inline"><span class="rfq-label">Cust.</span>
            <input class="rfq-input" data-default-field="customer" data-batch-id="${escapeHtml(id)}" type="text" value="${escapeHtml(batchData.default_customer || "")}" autocomplete="off"></label>
          <label class="rfq-inline"><span class="rfq-label">Salesperson</span>
            <input class="rfq-input" data-default-field="salesperson" data-batch-id="${escapeHtml(id)}" type="text" value="${escapeHtml(batchData.default_salesperson || "")}" autocomplete="off"></label>
          <label class="rfq-inline"><span class="rfq-label">Days</span>
            <input class="rfq-input" data-default-field="days" data-batch-id="${escapeHtml(id)}" type="number" step="any" value="${escapeHtml(displayValue(batchData.default_days))}" placeholder="You enter" autocomplete="off"></label>
          <label class="rfq-inline"><span class="rfq-label">Lead time</span>
            <input class="rfq-input" data-default-field="lead_time" data-batch-id="${escapeHtml(id)}" type="text" value="${escapeHtml(batchData.default_lead_time || "")}" placeholder="You enter" autocomplete="off"></label>
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
      ? lines.map((row) => renderEditRow(row)).join("")
      : `<tr><td colspan="${ARCHIVE_FIELDS.length}" class="rfq-empty">Open this upload to edit its lines.</td></tr>`;
    return `
      <article class="rfq-batch${openClass}" data-batch-id="${escapeHtml(id)}" data-loaded="${loaded ? "1" : "0"}">
        <header class="rfq-batch-head">
          <button type="button" class="rfq-batch-toggle" data-toggle-batch="${escapeHtml(id)}" aria-expanded="${startOpen ? "true" : "false"}">${startOpen ? "Hide" : "Show"}</button>
          <div class="rfq-batch-meta">
            <p class="rfq-batch-title">${escapeHtml(dash(batchData.filename))} ${tagBadge(batchData.sheet_tag)} ${statusPill(batchData.status || batchData.batch_status)}</p>
            <p class="rfq-batch-sub">${escapeHtml(dash(batchData.sheet_name))} · ${escapeHtml(formatWhen(batchData.updated_at || batchData.batch_updated_at))} · ${matchSummary(batchData)}</p>
          </div>
          <div class="rfq-batch-actions">
            <a class="rfq-btn rfq-btn--ghost" href="/archive/rfq-checker/upload?batch=${encodeURIComponent(id)}">Open upload</a>
          </div>
        </header>
        <div class="rfq-batch-panel">
          ${defaultsMarkup(batchData)}
          ${truncated ? `<p class="rfq-batch-note">Showing ${lines.length} of ${Number(batchData.line_count)} lines. Open upload to edit the rest.</p>` : ""}
          <div class="rfq-table-card">
            <div class="rfq-table-scroll">
              <table class="rfq-table rfq-table--wide rfq-table--edit">
                <thead>${headerRow(ARCHIVE_FIELDS)}</thead>
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
    wrap.open = true;
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
      sheet_tag: ($("rfq-sheet-tag") && $("rfq-sheet-tag").value) || "",
      rfq: ($("rfq-default-rfq") && $("rfq-default-rfq").value) || "",
      customer: ($("rfq-default-customer") && $("rfq-default-customer").value) || "",
      salesperson: ($("rfq-default-salesperson") && $("rfq-default-salesperson").value) || "",
      days: ($("rfq-default-days") && $("rfq-default-days").value) || "",
      lead_time: ($("rfq-default-lead-time") && $("rfq-default-lead-time").value) || "",
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
    const tag = batchData.sheet_tag || "";
    const rfq = batchData.default_rfq || majorityValue(lines, "rfq");
    const customer = batchData.default_customer || majorityValue(lines, "customer");
    const salesperson = batchData.default_salesperson || majorityValue(lines, "salesperson");
    if ($("rfq-sheet-tag")) $("rfq-sheet-tag").value = tag;
    if ($("rfq-default-rfq")) $("rfq-default-rfq").value = rfq;
    if ($("rfq-default-customer")) $("rfq-default-customer").value = customer;
    if ($("rfq-default-salesperson")) $("rfq-default-salesperson").value = salesperson;
    if ($("rfq-default-days")) $("rfq-default-days").value = displayValue(batchData.default_days);
    if ($("rfq-default-lead-time")) $("rfq-default-lead-time").value = batchData.default_lead_time || majorityValue(lines, "lead_time");
    renderTagPills(tag);
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
      if (page === "upload") {
        renderBatch(data.batch);
      } else {
        const card = document.querySelector(`.rfq-batch[data-batch-id="${id}"]`);
        const open = !card || card.classList.contains("is-open");
        await hydrateBatch(id, open);
      }
      showAlert("Upload defaults applied to every line.", true);
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
    if (head) head.innerHTML = headerRow(ARCHIVE_FIELDS);
    if (body) body.innerHTML = lines.map((row) => renderEditRow(row)).join("");
    if (card) {
      const summary = card.querySelector(".rfq-summary") || document.createElement("p");
      summary.className = "rfq-summary";
      summary.innerHTML = matchSummary(batchData);
      if (!summary.parentNode) card.insertBefore(summary, card.firstChild);
      card.hidden = lines.length === 0;
    }
    if (empty) empty.hidden = lines.length > 0;
    if (saveBtn) saveBtn.hidden = lines.length === 0;
    if (body) bindPartLinks(body);
    renderMapping(batchData);
    renderDefaults(batch);
    renderSheetSelect(batch);
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
      if (row && CALC_FIELDS.has(field)) {
        const tr = input.closest("tr");
        HOUR_FIELDS.forEach((calcField) => {
          const cell = tr.querySelector(`[data-field="${calcField}"]`);
          if (cell && calcField !== field) cell.value = displayValue(row[calcField]);
        });
      }
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
      tab.addEventListener("click", () => {
        document.querySelectorAll("[data-rfq-tab]").forEach((other) => {
          const on = other === tab;
          other.classList.toggle("is-active", on);
          other.setAttribute("aria-selected", on ? "true" : "false");
        });
        const name = tab.getAttribute("data-rfq-tab");
        if ($("rfq-panel-master")) $("rfq-panel-master").hidden = name !== "master";
        if ($("rfq-panel-parts")) $("rfq-panel-parts").hidden = name !== "parts";
        if ($("rfq-panel-archive")) $("rfq-panel-archive").hidden = name !== "archive";
        if (name === "master") loadMaster();
        if (name === "parts") loadLibrary();
        if (name === "archive") loadArchive();
      });
    });
    const groups = $("rfq-archive-groups");
    groups && groups.addEventListener("click", (event) => {
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
      if (event.target && event.target.matches("[data-field]")) queueSave(event.target);
      if (event.target && event.target.matches("[data-default-field]")) {
        const batchId = event.target.getAttribute("data-batch-id");
        const field = event.target.getAttribute("data-default-field");
        const key = `batch-${batchId}:${field}`;
        window.clearTimeout(saveTimers[key]);
        saveTimers[key] = window.setTimeout(() => {
          saveDefaults({ [field]: event.target.value }, batchId);
        }, 450);
      }
    });
    loadArchive();
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
    $("rfq-apply-defaults") && $("rfq-apply-defaults").addEventListener("click", () => saveDefaults());
    document.querySelectorAll("[data-rfq-tag]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tag = btn.getAttribute("data-rfq-tag") || "";
        const current = ($("rfq-sheet-tag") && $("rfq-sheet-tag").value) || "";
        const next = current === tag ? "" : tag;
        if ($("rfq-sheet-tag")) $("rfq-sheet-tag").value = next;
        renderTagPills(next);
        saveDefaults({ sheet_tag: next });
      });
    });
    Object.keys(DEFAULT_FIELD_BY_ID).forEach((id) => {
      const input = $(id);
      if (!input) return;
      input.addEventListener("input", () => {
        if (id === "rfq-sheet-tag") renderTagPills(input.value);
        window.clearTimeout(saveTimers.defaults);
        saveTimers.defaults = window.setTimeout(() => {
          saveDefaults({ [DEFAULT_FIELD_BY_ID[id]]: input.value });
        }, 450);
      });
    });
    $("rfq-lines-body") && $("rfq-lines-body").addEventListener("input", (event) => {
      if (event.target && event.target.matches("[data-field]")) queueSave(event.target);
    });
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
    $("rfq-save-archive") && $("rfq-save-archive").addEventListener("click", async () => {
      if (!batch) return;
      try {
        const data = await api(`/api/rfq-checker/batches/${batch.batch_id}/archive`, { method: "POST" });
        renderBatch(data.batch);
        showAlert("Saved to Tracker. Uploads stay grouped there so you can keep editing.", true);
      } catch (err) {
        showAlert(err.message);
      }
    });
    api("/api/rfq-checker/meta").then((data) => {
      const hint = $("rfq-llm-hint");
      if (!hint) return;
      const hours = "Hours = QTY × C/T ÷ 60. Days and lead time stay blank unless the workbook has those columns.";
      if (data.llm && data.llm.configured) {
        const labels = { groq: "Groq", openai: "OpenAI" };
        const via = data.llm.provider ? ` via ${labels[data.llm.provider] || data.llm.provider}` : "";
        hint.textContent = `LLM mapping ready (${data.llm.model}${via}). ${hours}`;
      } else {
        hint.textContent = `No LLM key set — columns are mapped by header aliases. Add RFQ_LLM_API_KEY to .env for unusual workbooks. ${hours}`;
      }
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
