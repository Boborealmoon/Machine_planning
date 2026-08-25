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

  const pageRoot = document.querySelector("[data-rfq-page]");
  const page = pageRoot ? pageRoot.getAttribute("data-rfq-page") : "";
  const saveTimers = {};
  let batch = null;
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
    return text || "—";
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

  function headerRow() {
    return `<tr>${FIELDS.map((field) => `<th>${escapeHtml(fieldLabels[field] || LABELS[field] || field)}</th>`).join("")}</tr>`;
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

  function renderReadRow(row, { clickablePart = true } = {}) {
    const match = row.match_status || "";
    const cls = match === "matched" ? "is-matched" : match === "new" ? "is-new" : "";
    const cells = FIELDS.map((field) => {
      const extra = FILL_FIELDS.has(field) ? ` class="rfq-td-${field}"` : "";
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
    const cells = FIELDS.map((field) => {
      const fillClass = FILL_FIELDS.has(field) ? ` rfq-cell--${field}` : "";
      const tdClass = FILL_FIELDS.has(field) ? ` class="rfq-td-${field}"` : "";
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
          <p>Opns ${escapeHtml(dash(part.opns))} · Total C/T ${escapeHtml(dash(part.total_ct_mins))} mins · Machines ${escapeHtml(dash(part.machines))}</p>
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
      $("rfq-archive-head").innerHTML = headerRow();
      $("rfq-archive-body").innerHTML = rows.map((row) => renderReadRow(row)).join("");
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
    const headers = batchData.headers || [];
    notes.textContent = batchData.mapping_notes || "";
    grid.innerHTML = FIELDS.map((field) => {
      const current = Object.keys(mapping).find((header) => mapping[header] === field) || "";
      const options = ["<option value=''>—</option>"]
        .concat(headers.map((header) => `<option value="${escapeHtml(header)}"${header === current ? " selected" : ""}>${escapeHtml(header)}</option>`));
      return `<label class="rfq-inline"><span class="rfq-label">${escapeHtml(fieldLabels[field] || field)}</span><select class="rfq-select" data-map-field="${field}">${options.join("")}</select></label>`;
    }).join("");
    wrap.hidden = false;
    wrap.open = true;
  }

  function mappingFromForm() {
    const out = {};
    document.querySelectorAll("[data-map-field]").forEach((select) => {
      if (select.value) out[select.value] = select.getAttribute("data-map-field");
    });
    return out;
  }

  function renderBatch(batchData) {
    batch = batchData;
    fieldLabels = batchData.field_labels || fieldLabels;
    const card = $("rfq-lines-card");
    const empty = $("rfq-lines-empty");
    const saveBtn = $("rfq-save-archive");
    const lines = batchData.lines || [];
    $("rfq-lines-head").innerHTML = headerRow();
    $("rfq-lines-body").innerHTML = lines.map((row) => renderEditRow(row)).join("");
    card.hidden = lines.length === 0;
    empty.hidden = lines.length > 0;
    if (saveBtn) saveBtn.hidden = lines.length === 0;
    bindPartLinks($("rfq-lines-body"));
    renderMapping(batchData);
    if (batchData.sheets) {
      const select = $("rfq-sheet");
      if (select) {
        const current = batchData.sheet_name || "";
        select.innerHTML = batchData.sheets.map((sheet) => (
          `<option value="${escapeHtml(sheet.name)}"${sheet.name === current ? " selected" : ""}>${escapeHtml(sheet.name)} (${sheet.row_count})</option>`
        )).join("");
        select.disabled = false;
      }
    }
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
    try {
      const data = await api("/api/rfq-checker/upload", { method: "POST", body });
      renderBatch(data.batch);
      const params = new URLSearchParams(window.location.search);
      params.set("batch", data.batch.batch_id);
      history.replaceState({}, "", `${window.location.pathname}?${params}`);
      showAlert(data.batch.mapping_notes || "Workbook mapped onto Archive columns.", true);
    } catch (err) {
      showAlert(err.message);
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
      const file = fileInput.files && fileInput.files[0];
      uploadFile(file, $("rfq-sheet") && $("rfq-sheet").value);
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
      uploadFile(file);
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
        hint.textContent = `LLM mapping ready (${data.llm.model}). Hours = QTY × C/T ÷ 60; days use a ${data.hours_per_day}-hour day.`;
      } else {
        hint.textContent = "No LLM key set — columns are mapped by header aliases. Add RFQ_LLM_API_KEY to .env to map unusual workbooks. Hours = QTY × C/T ÷ 60; days use a 10-hour day.";
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
