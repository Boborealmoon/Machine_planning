(function () {
  const FILTERS = [
    ["all", "All"],
    ["ops", "Waiting on Ops"],
    ["supply_chain", "Waiting on Supply Chain"],
    ["planning", "Waiting on Planning"],
    ["ready", "Ready for Sales"],
  ];
  const HINTS = {
    ops: "Operations owns the master columns. Changing a quoted line raises its revision so Supply Chain or Planning must reconfirm.",
    supply_chain: "Supply Chain owns the supplier quote. Repeat lines share the earlier line’s quote. Set Quoted and a lead time before Planning can enter TAT.",
    planning: "Planning enters TAT days on each line. The field stays locked until the supplier quote has a lead time.",
    sales: "Sales can read every column and cannot edit them.",
  };
  const state = {
    team: "ops",
    teams: [],
    machines: [],
    rfqs: [],
    query: "",
    filter: "all",
    folder: "all",
    view: "grid",
    sheetId: null,
    lineQuery: "",
  };

  const app = document.getElementById("rfq-app");
  const alertBox = document.getElementById("rfq-alert");
  const library = document.getElementById("rfq-library");
  const detail = document.getElementById("rfq-detail");

  document.getElementById("rfq-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderLibrary();
  });
  document.getElementById("rfq-line-search").addEventListener("input", (event) => {
    state.lineQuery = event.target.value;
    renderDetail();
  });
  document.getElementById("rfq-folder").addEventListener("change", (event) => {
    state.folder = event.target.value;
    renderLibrary();
  });
  document.getElementById("rfq-back").addEventListener("click", () => {
    state.sheetId = null;
    state.lineQuery = "";
    document.getElementById("rfq-line-search").value = "";
    show();
  });
  document.getElementById("ops-scan").addEventListener("click", importFolder);
  app.addEventListener("click", onClick);
  app.addEventListener("change", onChange);

  load();

  async function load() {
    try {
      const payload = await fetchJson("/api/rfq-workflow");
      state.team = payload.team || "ops";
      state.teams = payload.teams || [];
      state.machines = payload.machine_columns || [];
      state.rfqs = payload.rfqs || [];
      showAlert("");
      show();
    } catch (error) {
      showAlert(error.message);
      document.getElementById("rfq-meta").textContent = "The RFQ library could not be loaded.";
    }
  }

  function show() {
    const open = current();
    library.hidden = !!open;
    detail.hidden = !open;
    renderTeams();
    if (open) renderDetail();
    else renderLibrary();
  }

  function renderTeams() {
    document.getElementById("rfq-teams").innerHTML = state.teams.map((team) =>
      `<button type="button" class="ops-btn${team.id === state.team ? " is-on" : ""}" data-team="${esc(team.id)}">${esc(team.label)}</button>`
    ).join("");
  }

  function renderLibrary() {
    document.getElementById("rfq-title").textContent = "RFQ library";
    const query = state.query.trim().toLowerCase();
    const visible = state.rfqs.filter((rfq) => {
      if (state.folder !== "all" && rfq.folder_status !== state.folder) return false;
      if (state.filter !== "all" && rfq.workflow.category !== state.filter) return false;
      return !query || tokens(query).every((token) => haystack(rfq).includes(token));
    });
    document.getElementById("rfq-chips").innerHTML = FILTERS.map(([key, label]) => {
      const count = key === "all"
        ? state.rfqs.filter((rfq) => state.folder === "all" || rfq.folder_status === state.folder).length
        : state.rfqs.filter((rfq) => (state.folder === "all" || rfq.folder_status === state.folder) && rfq.workflow.category === key).length;
      return `<button type="button" class="rfq-chip${state.filter === key ? " is-on" : ""}" data-filter="${key}">${esc(label)} (${count})</button>`;
    }).join("");
    document.getElementById("rfq-grid").classList.toggle("is-on", state.view === "grid");
    document.getElementById("rfq-list").classList.toggle("is-on", state.view === "list");
    document.getElementById("rfq-meta").textContent = countPhrase(visible.length, "RFQ", "RFQs") + " · Supabase";
    const results = document.getElementById("rfq-results");
    results.classList.toggle("is-list", state.view === "list");
    if (!state.rfqs.length) {
      results.innerHTML = '<p class="ops-idle">No RFQs yet. Import from the RFQ folder to onboard the OPS sheets.</p>';
      return;
    }
    if (!visible.length) {
      results.innerHTML = '<p class="ops-idle">No RFQ matches that search.</p>';
      return;
    }
    results.innerHTML = visible.map((rfq) => cardHtml(rfq, query)).join("");
  }

  function cardHtml(rfq, query) {
    const flow = rfq.workflow;
    const width = flow.total ? Math.round((flow.ready / flow.total) * 100) : 0;
    const hits = query ? matchedParts(rfq, query) : [];
    return `<button type="button" class="rfq-card" data-open="${rfq.sheet_id}">
      <span><span class="rfq-card-name">${esc(rfq.rfq_no)}</span>
        <span class="rfq-card-sub">${esc(rfq.customer)}${rfq.title && rfq.title !== rfq.customer ? " · " + esc(rfq.title) : ""}</span>
        ${hits.length ? `<span class="rfq-match">Match: ${hits.map(esc).join(", ")}</span>` : ""}
      </span>
      <span><span class="rfq-pill rfq-tone-${esc(flow.tone)}">${esc(flow.label)}</span></span>
      <span><span class="rfq-bar"><span style="width:${width}%"></span></span>
        <span class="rfq-card-meta">${flow.ready}/${flow.total} lines ready</span></span>
      <span class="rfq-card-meta">Rev ${rfq.ops_rev}${rfq.date_in ? " · in " + esc(formatDate(rfq.date_in)) : ""}<br>${esc(folderLabel(rfq.folder_status))} · ${esc(rfq.file_name)}</span>
    </button>`;
  }

  function renderDetail() {
    const rfq = current();
    if (!rfq) return;
    const flow = rfq.workflow;
    const width = flow.total ? Math.round((flow.ready / flow.total) * 100) : 0;
    document.getElementById("rfq-title").textContent = rfq.rfq_no;
    document.getElementById("rfq-crumb-name").textContent = rfq.rfq_no + " · " + rfq.customer;
    document.getElementById("rfq-export").href = "/api/rfq-workflow/files/" + rfq.sheet_id + "/price-to-sales";
    const counts = Object.entries(rfq.counts || {}).map(([label, count]) => {
      const tone = (rfq.lines.find((line) => line.workflow.label === label) || {}).workflow;
      return `<span class="rfq-pill rfq-tone-${esc(tone ? tone.tone : "neutral")}">${esc(label)}: ${count}</span>`;
    }).join("");
    const editable = state.team === "ops";
    document.getElementById("rfq-summary").innerHTML = `
      <strong>${flow.ready}/${flow.total} lines ready for Sales</strong>
      <span class="rfq-bar"><span style="width:${width}%"></span></span>
      ${counts}
      <span class="rfq-card-meta">Supplier quotes so far: SGD ${money(rfq.supplier_total)}</span>
      <div class="rfq-head">
        ${headField(rfq, "rfq_no", "RFQ no.", rfq.rfq_no, editable)}
        ${headField(rfq, "customer", "Customer", rfq.customer, editable)}
        ${headField(rfq, "title", "Title", rfq.title, editable)}
        ${headField(rfq, "file_name", "OPS file", rfq.file_name, editable)}
      </div>`;
    const needle = state.lineQuery.trim().toLowerCase();
    const rows = rfq.lines.filter((line) => !needle || lineHay(line).includes(needle)).map(lineHtml).join("");
    document.getElementById("rfq-table").innerHTML = `
      <table class="rfq-table">
        <thead>
          <tr class="rfq-group">
            <th class="rfq-group-ops" colspan="7">Operations</th>
            <th class="rfq-group-sc" colspan="6">Supply Chain</th>
            <th class="rfq-group-plan" colspan="2">Planning</th>
            <th>Status</th>
          </tr>
          <tr>
            <th>S/N</th><th>Part</th><th>Qty</th><th>Material</th><th>Size mm</th><th>Setup + cycle</th><th>Rev</th>
            <th>Need mtr</th><th>kg/m</th><th>Supplier</th><th>Quote SGD</th><th>Lead wks</th><th>State</th>
            <th>Calc h</th><th>TAT days</th><th>Where it is</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="16">No lines match.</td></tr>'}</tbody>
      </table>`;
    document.getElementById("rfq-hint").textContent = HINTS[state.team] || "";
    const log = document.getElementById("rfq-log");
    log.innerHTML = (rfq.activity || []).map((item) => {
      const line = rfq.lines.find((entry) => entry.line_id === item.line_id);
      const where = line ? "S/N " + line.sn + " · " : "";
      return `<li>${esc(formatWhen(item.at))} · ${esc(item.actor)} · ${esc(where + item.field)}: ${esc(item.old || "—")} → ${esc(item.new || "—")}</li>`;
    }).join("") || "<li>No changes yet.</li>";
  }

  function lineHtml(line) {
    const ownOps = state.team === "ops";
    const ownSc = state.team === "supply_chain";
    const ownPlan = state.team === "planning";
    const quote = line.quote || {};
    let supply;
    if (line.quote_ref_sn) {
      supply = `<td class="rfq-lock" colspan="6">Shares the supplier quote with S/N ${line.quote_ref_sn}</td>`;
    } else {
      supply = quoteCell(ownSc, line, "qty_needed_mtr", quote.qty_needed_mtr, "number")
        + quoteCell(ownSc, line, "kg_per_mtr", quote.kg_per_mtr, "number")
        + `<td class="${ownSc ? "rfq-cell" : "rfq-lock"}">${ownSc
          ? `<input data-quote="${line.line_id}" data-qfield="supplier" value="${esc(quote.supplier || "")}"><textarea data-quote="${line.line_id}" data-qfield="supplier_note" placeholder="Supplier note">${esc(quote.supplier_note || "")}</textarea>`
          : esc(quote.supplier || "—") + (quote.supplier_note ? `<small>${esc(quote.supplier_note)}</small>` : "")}</td>`
        + quoteCell(ownSc, line, "material_cost_sgd", quote.material_cost_sgd, "number")
        + quoteCell(ownSc, line, "lead_time_weeks", quote.lead_time_weeks, "number")
        + `<td class="${ownSc ? "rfq-cell" : "rfq-lock"}">${ownSc ? stateSelect(line, quote.state) : esc(quote.state_label || "Not sent")}</td>`;
    }
    const hours = (line.calc_hour_breaks || []).map((value) => value + " h").join(" · ") || "—";
    const tatDisabled = ownPlan && line.tat_open ? "" : " disabled";
    const tatTitle = line.tat_open ? "" : ' title="Waiting for a quoted supplier lead time"';
    const waiting = line.workflow.waiting_on === "—" ? "" : `<small>Waiting on ${esc(line.workflow.waiting_on)}</small>`;
    const canReconfirm = line.workflow.stale && (
      (ownSc && line.workflow.waiting_on === "Supply Chain")
      || (ownPlan && line.workflow.waiting_on === "Planning")
    );
    return `<tr>
      <td>${line.sn}</td>
      <td class="${ownOps ? "rfq-cell rfq-part" : "rfq-lock rfq-part"}">
        ${ownOps ? `<input data-line="${line.line_id}" data-field="part_number" value="${esc(line.part_number)}" aria-label="Part number">
          <input data-line="${line.line_id}" data-field="description" value="${esc(line.description)}" aria-label="Description">
          <textarea data-line="${line.line_id}" data-field="engineering_remarks" aria-label="Remarks">${esc(line.engineering_remarks)}</textarea>`
          : `<strong>${esc(line.part_number)}</strong><small>${esc(line.description)}</small>${line.engineering_remarks ? `<small>${esc(line.engineering_remarks)}</small>` : ""}`}
      </td>
      ${opsCell(ownOps, line, "rfq_qty_text", line.rfq_qty_text || line.rfq_qty || "", "text")}
      <td class="${ownOps ? "rfq-cell" : "rfq-lock"}">
        ${ownOps ? `<input data-line="${line.line_id}" data-field="material_type" value="${esc(line.material_type)}" aria-label="Material">
          <input data-line="${line.line_id}" data-field="material_spec" value="${esc(line.material_spec)}" aria-label="Spec">`
          : `${esc(line.material_type || "—")}<small>${esc(line.material_spec)}</small>`}
      </td>
      <td class="${ownOps ? "rfq-cell" : "rfq-lock"}">
        ${ownOps ? sizeInputs(line) : `Ø ${showNum(line.raw_thk)} × ${showNum(line.raw_width)} × ${showNum(line.raw_length)}`}
      </td>
      <td class="${ownOps ? "rfq-cell" : "rfq-lock"}">
        ${ownOps ? `<input type="number" min="0" step="any" data-line="${line.line_id}" data-field="setup_mins" value="${esc(showNum(line.setup_mins))}" aria-label="Setup minutes">` : esc(showNum(line.setup_mins))}
        <small>${machineSummary(line)}</small>
        ${ownOps ? machineEditor(line) : ""}
      </td>
      <td class="rfq-lock">${line.rev}</td>
      ${supply}
      <td class="rfq-lock">${esc(hours)}</td>
      <td class="${ownPlan && line.tat_open ? "rfq-cell" : "rfq-lock"}">
        ${ownPlan ? `<input type="number" min="0" step="any" data-tat="${line.line_id}" value="${esc(showNum(line.tat_days))}"${tatDisabled}${tatTitle} aria-label="TAT days">` : esc(showNum(line.tat_days) || "—")}
      </td>
      <td><span class="rfq-pill rfq-tone-${esc(line.workflow.tone)}">${esc(line.workflow.label)}</span>${waiting}
        ${canReconfirm ? `<button type="button" class="rfq-reconfirm" data-reconfirm="${line.line_id}">Reconfirm</button>` : ""}
      </td>
    </tr>`;
  }

  function headField(rfq, key, label, value, editable) {
    if (!editable) return `<label>${esc(label)}<span class="rfq-card-name">${esc(value || "—")}</span></label>`;
    return `<label>${esc(label)}<input data-header="${rfq.sheet_id}" data-hfield="${key}" value="${esc(value || "")}"></label>`;
  }

  function opsCell(editable, line, field, value, kind) {
    if (!editable) return `<td class="rfq-lock">${esc(value || "—")}</td>`;
    return `<td class="rfq-cell"><input type="${kind}" data-line="${line.line_id}" data-field="${field}" value="${esc(value || "")}"></td>`;
  }

  function quoteCell(editable, line, field, value, kind) {
    if (!editable) return `<td class="rfq-lock">${esc(showNum(value) || "—")}</td>`;
    return `<td class="rfq-cell"><input type="${kind}" min="0" step="any" data-quote="${line.line_id}" data-qfield="${field}" value="${esc(showNum(value))}"></td>`;
  }

  function stateSelect(line, value) {
    const options = [["not_sent", "Not sent"], ["rfq_sent", "RFQ sent"], ["quoted", "Quoted"]];
    return `<select data-quote="${line.line_id}" data-qfield="state">${options.map(([key, label]) =>
      `<option value="${key}"${key === (value || "not_sent") ? " selected" : ""}>${label}</option>`
    ).join("")}</select>`;
  }

  function sizeInputs(line) {
    return ["raw_thk", "raw_width", "raw_length"].map((field) =>
      `<input type="number" step="any" data-line="${line.line_id}" data-field="${field}" value="${esc(showNum(line[field]))}" aria-label="${field}">`
    ).join("");
  }

  function machineSummary(line) {
    if (!line.machines.length) return "No cycle minutes";
    return line.machines.map((item) => item.label + " " + showNum(item.minutes)).join(" · ");
  }

  function machineEditor(line) {
    const minutes = line.machine_minutes || {};
    const fields = state.machines.map((item) =>
      `<label>${esc(item.label)}<input type="number" min="0" step="any" data-line="${line.line_id}" data-field="${esc(item.key)}" value="${esc(showNum(minutes[item.key]))}"></label>`
    ).join("");
    return `<details class="rfq-machines"><summary>Machine minutes</summary>${fields}</details>`;
  }

  async function onClick(event) {
    const team = event.target.closest("[data-team]");
    if (team) {
      await saveTeam(team.dataset.team);
      return;
    }
    const filter = event.target.closest("[data-filter]");
    if (filter) {
      state.filter = filter.dataset.filter;
      renderLibrary();
      return;
    }
    const view = event.target.closest("[data-view]");
    if (view) {
      state.view = view.dataset.view;
      renderLibrary();
      return;
    }
    const open = event.target.closest("[data-open]");
    if (open) {
      state.sheetId = Number(open.dataset.open);
      state.lineQuery = "";
      document.getElementById("rfq-line-search").value = "";
      show();
      return;
    }
    const reconfirm = event.target.closest("[data-reconfirm]");
    if (reconfirm) {
      await sendPatch("/api/rfq-workflow/lines/" + reconfirm.dataset.reconfirm + "/reconfirm", { method: "POST", body: "{}" });
    }
  }

  async function onChange(event) {
    const target = event.target;
    if (target.matches("[data-header]")) {
      await sendPatch("/api/rfq-workflow/files/" + target.dataset.header, {
        method: "PATCH",
        body: JSON.stringify({ fields: { [target.dataset.hfield]: target.value } }),
      });
      return;
    }
    if (target.matches("[data-field]")) {
      await sendPatch("/api/rfq-workflow/lines/" + target.dataset.line + "/ops", {
        method: "PATCH",
        body: JSON.stringify({ fields: { [target.dataset.field]: target.value } }),
      });
      return;
    }
    if (target.matches("[data-qfield]")) {
      await sendPatch("/api/rfq-workflow/lines/" + target.dataset.quote + "/quote", {
        method: "PATCH",
        body: JSON.stringify({ fields: { [target.dataset.qfield]: target.value } }),
      });
      return;
    }
    if (target.matches("[data-tat]")) {
      await sendPatch("/api/rfq-workflow/lines/" + target.dataset.tat + "/tat", {
        method: "PATCH",
        body: JSON.stringify({ tat_days: target.value }),
      });
    }
  }

  async function saveTeam(team) {
    try {
      const payload = await fetchJson("/api/rfq-workflow/team", {
        method: "POST",
        body: JSON.stringify({ team }),
      });
      state.team = payload.team;
      showAlert("");
      show();
    } catch (error) {
      showAlert(error.message);
    }
  }

  async function sendPatch(url, options) {
    try {
      const payload = await fetchJson(url, options);
      replaceRfq(payload.rfq);
      showAlert("");
      renderDetail();
    } catch (error) {
      showAlert(error.message);
    }
  }

  async function importFolder() {
    const button = document.getElementById("ops-scan");
    button.disabled = true;
    try {
      const payload = await fetchJson("/api/ops-sheets/scan", { method: "POST", body: "{}" });
      const summary = payload.summary || {};
      showAlert("");
      document.getElementById("rfq-meta").textContent = "Imported " + (summary.lines || 0) + " lines from " + (summary.saved || 0) + " files.";
      await load();
    } catch (error) {
      showAlert(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function replaceRfq(rfq) {
    if (!rfq) return;
    const index = state.rfqs.findIndex((item) => item.sheet_id === rfq.sheet_id);
    if (index >= 0) state.rfqs[index] = rfq;
    else state.rfqs.unshift(rfq);
  }

  function current() {
    return state.rfqs.find((rfq) => rfq.sheet_id === state.sheetId) || null;
  }

  function haystack(rfq) {
    return [rfq.rfq_no, rfq.customer, rfq.title, rfq.file_name, rfq.folder]
      .concat(rfq.lines.flatMap((line) => [line.part_number, line.description, line.material_type, line.material_spec]))
      .join(" ")
      .toLowerCase();
  }

  function lineHay(line) {
    return [line.sn, line.part_number, line.description, line.material_type, line.material_spec, line.engineering_remarks]
      .join(" ")
      .toLowerCase();
  }

  function matchedParts(rfq, query) {
    const parts = [];
    rfq.lines.forEach((line) => {
      const text = (line.part_number + " " + line.description + " " + line.material_type).toLowerCase();
      if (tokens(query).every((token) => text.includes(token)) && line.part_number && !parts.includes(line.part_number)) {
        parts.push(line.part_number);
      }
    });
    return parts.slice(0, 3);
  }

  function tokens(query) {
    return query.split(/\s+/).filter(Boolean);
  }

  function folderLabel(status) {
    if (status === "completed") return "Completed";
    if (status === "archive") return "Archive";
    if (status === "current") return "Current";
    return status || "";
  }

  function formatDate(iso) {
    const parts = String(iso).slice(0, 10).split("-");
    if (parts.length < 3) return iso;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return Number(parts[2]) + " " + months[Number(parts[1]) - 1] + " " + parts[0];
  }

  function formatWhen(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function money(value) {
    const number = Number(value || 0);
    return number.toFixed(2);
  }

  function showNum(value) {
    if (value === null || value === undefined || value === "") return "";
    const number = Number(value);
    return Number.isFinite(number) ? String(number) : "";
  }

  function countPhrase(count, singular, plural) {
    return count + " " + (count === 1 ? singular : plural);
  }

  function showAlert(message) {
    alertBox.hidden = !message;
    alertBox.textContent = message || "";
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      ...options,
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok || (payload && payload.ok === false)) {
      throw new Error((payload && payload.error) || "The RFQ library could not be saved.");
    }
    return payload;
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }
})();
