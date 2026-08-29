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
  const CALC_FIELDS = new Set(["qty", "total_ct_mins", "total_hours", "days"]);
  const ARCHIVE_FIELDS = ["sheet_tag", ...FIELDS];

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
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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

  function renderReadRow(row, { clickablePart = true, fields } = {}) {
    const match = row.match_status || "";
    const cls = match === "matched" ? "is-matched" : match === "new" ? "is-new" : "";
    const cells = (fields || FIELDS).map((field) => {
      const extra = FILL_FIELDS.has(field) ? ` class="rfq-td-${field}"` : "";
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
      const tdClass = FILL_FIELDS.has(field) ? ` class="rfq-td-${field}"` : "";
      if (field === "sheet_tag") {
        return `<td>${tagBadge(row.sheet_tag || "")}</td>`;
      }
      if (field === "part_no") {
        return `<td${tdClass}>${partButton(row.part_no || "", match)}</td>`;
      }
      const inputClass = `rfq-cell${fillClass}`;
      const type = ["qty", "total_ct_mins", "machine_hours", "total_hours", "days"].includes(field) ? "number" : "text";
      return `<td${tdClass}><input class="${inputClass}" data-field="${field}" data-line-id="${escapeHtml(row.line_id)}" type="${type}" value="${escapeHtml(displayValue(row[field]))}"${type === "number" ? ' step="any"' : ""}></td>`;
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
          <h3>Summary</h3>
          <p><strong>${escapeHtml(dash(part.part_no))}</strong><br>${escapeHtml(dash(part.part_description))}</p>
          <p>Opns ${escapeHtml(dash(part.opns))} | Total C/T ${escapeHtml(dash(part.total_ct_mins))} mins | Machines ${escapeHtml(dash(part.machines))}</p>
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

  async function loadArchive() {
    const q = ($("rfq-archive-search") && $("rfq-archive-search").value) || "";
    const card = $("rfq-archive-card");
    const empty = $("rfq-archive-empty");
    try {
      const data = await api(`/api/rfq-checker/archive?q=${encodeURIComponent(q)}`);
      const rows = data.rows || [];
      $("rfq-archive-head").innerHTML = headerRow(ARCHIVE_FIELDS);
      $("rfq-archive-body").innerHTML = rows.map((row) => renderReadRow(row, { fields: ARCHIVE_FIELDS })).join("");
      card.hidden = rows.length === 0;
      empty.hidden = rows.length > 0;
      bindPartLinks($("rfq-archive-body"));
    } catch (err) {
      showAlert(err.message);
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
    };
  }

  function renderTagPills(tag) {
    const current = String(tag || "").trim().toUpperCase();
    document.querySelectorAll("[data-rfq-tag]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-rfq-tag") === current);
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
    renderTagPills(tag);
  }

  async function saveDefaults(patch) {
    if (!batch) return;
    let payload = patch || defaultsFromForm();
    if (!patch) {
      payload = { ...payload };
      ["rfq", "customer", "salesperson"].forEach((field) => {
        if (!String(payload[field] || "").trim()) delete payload[field];
      });
      if (!payload.sheet_tag && !payload.rfq && !payload.customer && !payload.salesperson) {
        showAlert("Enter a tag, RFQ, customer, or salesperson first.");
        return;
      }
    }
    try {
      const data = await api(`/api/rfq-checker/batches/${batch.batch_id}/defaults`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      renderBatch(data.batch);
      showAlert("Sheet defaults applied to every line.", true);
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
    select.innerHTML = sheets.map((sheet) => (
      `<option value="${escapeHtml(sheet.name)}"${sheet.name === current ? " selected" : ""}>${escapeHtml(sheet.name)} (${sheet.row_count})</option>`
    )).join("");
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
    $("rfq-lines-head").innerHTML = headerRow(ARCHIVE_FIELDS);
    $("rfq-lines-body").innerHTML = lines.map((row) => renderEditRow(row)).join("");
    card.hidden = lines.length === 0;
    empty.hidden = lines.length > 0;
    if (saveBtn) saveBtn.hidden = lines.length === 0;
    bindPartLinks($("rfq-lines-body"));
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
        ["machine_hours", "total_hours", "days", "lead_time"].forEach((calcField) => {
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
    if (loadingText) loadingText.textContent = "Mapping columns and calculating cycle times...";
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
      showAlert(data.batch.mapping_notes || "Workbook mapped onto Archive columns.", true);
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
        document.querySelectorAll("[data-rfq-tab]").forEach((other) => other.classList.toggle("is-active", other === tab));
        const name = tab.getAttribute("data-rfq-tab");
        $("rfq-panel-parts").hidden = name !== "parts";
        $("rfq-panel-archive").hidden = name !== "archive";
        if (name === "archive") loadArchive();
      });
    });
    loadLibrary();
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
    ["rfq-sheet-tag", "rfq-default-rfq", "rfq-default-customer", "rfq-default-salesperson"].forEach((id) => {
      const input = $(id);
      if (!input) return;
      input.addEventListener("input", () => {
        if (id === "rfq-sheet-tag") renderTagPills(input.value);
        const fieldById = {
          "rfq-sheet-tag": "sheet_tag",
          "rfq-default-rfq": "rfq",
          "rfq-default-customer": "customer",
          "rfq-default-salesperson": "salesperson",
        };
        window.clearTimeout(saveTimers.defaults);
        saveTimers.defaults = window.setTimeout(() => {
          saveDefaults({ [fieldById[id]]: input.value });
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
        showAlert("Saved to Archive. Open Existing parts to compare by part no.", true);
      } catch (err) {
        showAlert(err.message);
      }
    });
    api("/api/rfq-checker/meta").then((data) => {
      const hint = $("rfq-llm-hint");
      if (!hint) return;
      if (data.llm && data.llm.configured) {
        const labels = { groq: "Groq", openai: "OpenAI" };
        const via = data.llm.provider ? ` via ${labels[data.llm.provider] || data.llm.provider}` : "";
        hint.textContent = `LLM mapping ready (${data.llm.model}${via}). Hours = QTY x C/T / 60; days use a ${data.hours_per_day}-hour day.`;
      } else {
        hint.textContent = "No LLM key set - columns are mapped by header aliases. Add RFQ_LLM_API_KEY to .env to map unusual workbooks. Hours = QTY x C/T / 60; days use a 10-hour day.";
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
