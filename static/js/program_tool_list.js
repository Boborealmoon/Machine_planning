/* Program / Tool List */

const COLSPAN    = 22;
const PAGE_SIZE  = 100;

let debounceTimer = null;
let allRows       = [];
let filteredRows  = [];   // post-filter, pre-pagination
let currentPage   = 1;
let searchQuery   = "";
let opTypeFilter  = "";         // "" | "Turning" | "Milling" | "Turnmill"
let machineFilter = new Set();  // empty = show all
let summaryEntries = [];        // full built summary, pre-search

// ── Boot ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  if (!document.getElementById("ptl-tbody")) return;

  loadData();

  // Search (client-side on enriched display fields)
  document.getElementById("ptl-search").addEventListener("input", (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchQuery = e.target.value.trim();
      applyFilters();
    }, 280);
  });

  // Sync
  document.getElementById("btn-sync")?.addEventListener("click", syncData);
  document.getElementById("btn-sync-supabase")?.addEventListener("click", syncToSupabase);

  // OP TYPE chips
  document.getElementById("optype-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".filter-chip");
    if (!chip) return;
    opTypeFilter = chip.dataset.val;
    document.querySelectorAll("#optype-chips .filter-chip").forEach((c) =>
      c.classList.toggle("filter-chip--active", c === chip)
    );
    applyFilters();
  });

  // Machine picker toggle
  document.getElementById("machine-picker-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const dd = document.getElementById("machine-dd");
    dd.hidden = !dd.hidden;
  });
  document.addEventListener("click", () => {
    document.getElementById("machine-dd").hidden = true;
  });
  document.getElementById("machine-dd").addEventListener("click", (e) => e.stopPropagation());

  document.getElementById("machine-select-all").addEventListener("click", () => {
    document.querySelectorAll(".machine-cb").forEach((cb) => {
      cb.checked = true;
      machineFilter.add(cb.value);
    });
    updateMachineBtn();
    applyFilters();
  });

  document.getElementById("machine-clear-all").addEventListener("click", () => {
    document.querySelectorAll(".machine-cb").forEach((cb) => { cb.checked = false; });
    machineFilter.clear();
    updateMachineBtn();
    applyFilters();
  });

  // Pagination
  document.getElementById("btn-prev-page").addEventListener("click", () => {
    if (currentPage > 1) { currentPage--; renderPage(); }
  });
  document.getElementById("btn-next-page").addEventListener("click", () => {
    if (currentPage < totalPages()) { currentPage++; renderPage(); }
  });

  // Summary modal
  function closeSummaryModal() {
    document.getElementById("ptl-modal-backdrop").hidden = true;
  }
  document.getElementById("btn-summary").addEventListener("click", () => {
    document.getElementById("ptl-modal-backdrop").hidden = false;
  });
  document.getElementById("ptl-modal-close").addEventListener("click", closeSummaryModal);
  document.getElementById("ptl-modal-backdrop").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSummaryModal();
  });

  // Summary search
  document.getElementById("ptl-summary-search").addEventListener("input", applySummaryFilter);
});

// ── Load ──────────────────────────────────────────────────────────────────

async function loadData() {
  setTableState("Loading…");
  try {
    const res  = await fetch("/api/program-tool-list");
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    allRows = data.rows;
    populateMachineCheckboxes(allRows);
    setLastSynced(data.last_synced);
    applyFilters();
  } catch (err) {
    setTableState(`Error: ${err.message}`, true);
  }
}

// ── Sync ──────────────────────────────────────────────────────────────────

async function syncData() {
  const btn = document.getElementById("btn-sync");
  if (!btn) return;
  btn.textContent = "Syncing…";
  btn.classList.add("btn-syncing");

  try {
    const res  = await fetch("/api/program-tool-list/sync", { method: "POST" });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    btn.textContent = `Synced ${data.synced} rows ✓`;
    await loadData();
  } catch (err) {
    btn.textContent = "Sync Failed";
    alert("Sync error: " + err.message);
  } finally {
    btn.classList.remove("btn-syncing");
    setTimeout(() => { btn.textContent = "Sync from Google Sheets"; }, 2500);
  }
}

// ── Filters ────────────────────────────────────────────────────────────────

function applyFilters() {
  let rows = allRows;

  if (searchQuery) {
    rows = rows.filter((r) => rowMatchesSearch(r, searchQuery));
  }

  if (opTypeFilter) {
    const f = opTypeFilter.toLowerCase();
    rows = rows.filter((r) => (r.operation_type || "").toLowerCase().startsWith(f));
  }

  if (machineFilter.size > 0) {
    rows = rows.filter((r) =>
      machineFilter.has(r.cnc_machine_no) || machineFilter.has(r.cnc_machine_no_2)
    );
  }

  filteredRows = rows;
  currentPage  = 1;
  renderPage();
  renderSummary(buildSummary(filteredRows));
}

function totalPages() {
  return Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
}

function populateMachineCheckboxes(rows) {
  const machines = new Set();
  rows.forEach((r) => {
    if (r.cnc_machine_no)   machines.add(r.cnc_machine_no);
    if (r.cnc_machine_no_2) machines.add(r.cnc_machine_no_2);
  });

  const list = document.getElementById("machine-cb-list");
  list.innerHTML = [...machines].sort().map((m) => `
    <label class="machine-cb-label">
      <input type="checkbox" class="machine-cb" value="${esc(m)}"${machineFilter.has(m) ? " checked" : ""}> ${esc(m)}
    </label>
  `).join("");

  list.querySelectorAll(".machine-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) machineFilter.add(cb.value);
      else            machineFilter.delete(cb.value);
      updateMachineBtn();
      applyFilters();
    });
  });
}

function updateMachineBtn() {
  const btn = document.getElementById("machine-picker-btn");
  const n   = machineFilter.size;
  btn.textContent = n > 0 ? `${n} machine${n !== 1 ? "s" : ""} ▾` : "All machines ▾";
  btn.classList.toggle("machine-picker-btn--active", n > 0);
}

// ── Pagination ────────────────────────────────────────────────────────────

function renderPage() {
  const total  = filteredRows.length;
  const pages  = totalPages();
  const start  = (currentPage - 1) * PAGE_SIZE;
  const end    = Math.min(start + PAGE_SIZE, total);
  const pageRows = filteredRows.slice(start, end);

  // Count label
  const countEl = document.getElementById("ptl-count");
  if (total === 0) {
    countEl.textContent = "";
  } else if (total <= PAGE_SIZE) {
    countEl.textContent = `${total} row${total !== 1 ? "s" : ""}`;
  } else {
    countEl.textContent = `${start + 1}–${end} of ${total} rows`;
  }

  renderTable(pageRows);

  // Pagination bar
  const bar = document.getElementById("ptl-pagination");
  if (pages <= 1) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  document.getElementById("ptl-page-info").textContent = `Page ${currentPage} of ${pages}`;
  document.getElementById("btn-prev-page").disabled = currentPage === 1;
  document.getElementById("btn-next-page").disabled = currentPage === pages;
}

// ── Summary ────────────────────────────────────────────────────────────────

function buildSummary(rows) {
  const map = new Map();
  rows.forEach((r) => {
    const part = (r.part_no_erp || "").trim();
    const opNo = String(r.operation_no || r.operation_no_2 || "").trim();
    [r.cnc_machine_no, r.cnc_machine_no_2].forEach((m) => {
      const machine = String(m || "").trim();
      if (!machine) return;
      const key = `${part}\x00${opNo}\x00${machine}`;
      map.set(key, (map.get(key) || 0) + 1);
    });
  });
  return [...map.entries()]
    .map(([key, count]) => {
      const i1 = key.indexOf("\x00");
      const i2 = key.indexOf("\x00", i1 + 1);
      return {
        part: key.slice(0, i1),
        op_no: key.slice(i1 + 1, i2),
        machine: key.slice(i2 + 1),
        count,
      };
    })
    .sort(
      (a, b) =>
        a.part.localeCompare(b.part) ||
        a.op_no.localeCompare(b.op_no, undefined, { numeric: true }) ||
        a.machine.localeCompare(b.machine, undefined, { numeric: true })
    );
}

function renderSummary(entries) {
  summaryEntries = entries;
  applySummaryFilter();
}

function applySummaryFilter() {
  const q = (document.getElementById("ptl-summary-search").value || "").trim().toLowerCase();
  const entries = q
    ? summaryEntries.filter(
        (e) =>
          e.part.toLowerCase().includes(q) ||
          String(e.op_no).toLowerCase().includes(q)
      )
    : summaryEntries;

  const tbody = document.getElementById("ptl-summary-tbody");
  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="ptl-empty" style="padding:20px">No data</td></tr>`;
    return;
  }

  // Group by part, then op_no; count per CNC machine within each op
  const groups = [];
  entries.forEach((e) => {
    let g = groups[groups.length - 1];
    if (!g || g.part !== e.part) {
      g = { part: e.part, opGroups: [] };
      groups.push(g);
    }
    let og = g.opGroups[g.opGroups.length - 1];
    if (!og || og.op_no !== e.op_no) {
      og = { op_no: e.op_no, machines: [] };
      g.opGroups.push(og);
    }
    og.machines.push(e);
  });

  tbody.innerHTML = groups
    .map((g) => {
      const partRowspan = g.opGroups.reduce((n, og) => n + og.machines.length, 0);
      let partRow = 0;
      return g.opGroups
        .map((og) => {
          const opRowspan = og.machines.length;
          return og.machines
            .map((m, i) => {
              const row = `
      <tr${partRow === 0 && i === 0 ? ' class="ptl-summary-group-first"' : ""}>
        ${partRow === 0 ? `<td class="ptl-summary-part" rowspan="${partRowspan}">${esc(g.part) || "—"}</td>` : ""}
        ${i === 0 ? `<td class="ptl-summary-op" rowspan="${opRowspan}">${esc(og.op_no) || "—"}</td>` : ""}
        <td>${esc(m.machine)}</td>
        <td class="ptl-summary-count">${m.count}</td>
      </tr>`;
              partRow += 1;
              return row;
            })
            .join("");
        })
        .join("");
    })
    .join("");
}

// ── Render ────────────────────────────────────────────────────────────────

function cellText(value, clip = false) {
  const text = String(value ?? "").trim();
  if (!text) return '<span class="ptl-dash">—</span>';
  if (!clip || text.length <= 28) return esc(text);
  return `<span class="ptl-cell-clip" title="${esc(text)}">${esc(text)}</span>`;
}

function renderTable(rows) {
  const tbody = document.getElementById("ptl-tbody");

  if (!rows.length) {
    setTableState("No records found. Use \"Sync from Google Sheets\" to load data.");
    return;
  }

  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td class="ptl-sticky-1">${cellText(r.ps_no)}</td>
      <td class="ptl-sticky-2">${cellText(r.part_no_erp)}</td>
      <td>${cellText(r.bom_code || r.erp_bom_code, true)}</td>
      <td>${cellText(r.program_no, true)}</td>

      <td class="ptl-group-start">${cellText(r.cnc_machine_no || r.cnc_machine_no_2)}</td>
      <td class="ptl-actual-machine">${cellText(r.actual_machine_no)}</td>
      <td>${cellText(r.operation_no || r.operation_no_2)}</td>
      <td>${cellText(r.operation_type)}</td>
      <td>${cellText(r.setup_time)}</td>
      <td>${cellText(r.cycle_time)}</td>
      <td>${cellText(r.original_setup_time)}</td>

      <td class="ptl-group-start">${cellText(r.quoted_setup_price)}</td>
      <td>${cellText(r.quoted_ct_price)}</td>

      <td class="ptl-group-start">${cellText(r.quoted_ct_price_2, true)}</td>

      <td class="ptl-group-start">${cellText(r.material_extension_mm)}</td>
      <td>${cellText(r.setup_diagram_mm)}</td>
      <td>${cellText(r.kit_assembly_number || r.kit_assembly_no, true)}</td>

      <td class="ptl-group-start">${cellText(r.programmer_name)}</td>
      <td>${cellText(r.date)}</td>
      <td>${cellText(r.verified_by)}</td>

      <td class="ptl-group-start">${fileLink(r.program_file)}</td>
      <td>${fileLink(r.tool_list_files)}</td>
    </tr>
  `).join("");
}

// ── Helpers ───────────────────────────────────────────────────────────────

function setTableState(msg, isError = false) {
  document.getElementById("ptl-tbody").innerHTML =
    `<tr><td colspan="${COLSPAN}" class="ptl-empty" style="${isError ? "color:#e74c3c" : ""}">${esc(msg)}</td></tr>`;
  document.getElementById("ptl-count").textContent = "";
  document.getElementById("ptl-pagination").hidden = true;
}

function setLastSynced(ts) {
  const el = document.getElementById("ptl-sync-info");
  el.textContent = ts ? `Last synced: ${ts}` : "Not yet synced";
}

function fileLink(url) {
  if (!url || !url.startsWith("https://")) return '<span class="ptl-dash">—</span>';
  return `<a class="ptl-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">View</a>`;
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeSearchText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function rowSearchHaystack(row) {
  return normalizeSearchText(
    [
      row.part_no_erp,
      row.part_number,
      row.bom_code,
      row.erp_bom_code,
      row.bom_desc,
      row.program_no,
      row.programmer_name,
      row.process_sheet_no,
      row.ps_no,
      row.cnc_machine_no,
      row.cnc_machine_no_2,
      row.actual_machine_no,
      row.operation_no,
      row.operation_no_2,
      row.operation_type,
      row.kit_assembly_number,
      row.kit_assembly_no,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function rowMatchesSearch(row, query) {
  const q = normalizeSearchText(query);
  if (!q) return true;
  const haystack = rowSearchHaystack(row);
  if (haystack.includes(q)) return true;
  const tokens = q.split(" ");
  return tokens.length > 1 && tokens.every((token) => haystack.includes(token));
}

async function syncToSupabase() {
  const btn = document.getElementById("btn-sync-supabase");
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = "Syncing…";
  btn.disabled = true;
  try {
    const res = await fetch("/api/program-tool-list/sync-to-supabase", { method: "POST" });
    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      const text = await res.text();
      throw new Error(`Server ${res.status}: ${text.substring(0, 150)}`);
    }
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.sync_api_version == null || data.sync_api_version < 4) {
      throw new Error(
        "Server returned old sync API. Restart Flask so it loads program_tool_list_route.py (sync_api_version 4 with bom_code)."
      );
    }
    const ct = data.sample_payload?.cycle_time;
    const cycleTimeNote = data.with_cycle_time != null
      ? ` (${data.with_cycle_time} w/ cycle time${ct != null ? `, e.g. ${ct}` : ""})`
      : "";
    const skipped = (data.skipped_missing_program_file || 0)
      + (data.skipped_missing_tool_list_files || 0)
      + (data.skipped_missing_part_no_erp || 0);
    const skipNote = skipped > 0 ? `, ${skipped} skipped` : "";
    const payloadNote = data.payload_rows != null
      ? ` (${data.synced}/${data.payload_rows} valid)`
      : "";
    btn.textContent = `✓ Upserted ${data.synced}${payloadNote}${skipNote}${cycleTimeNote}`;
    if (data.warnings && data.warnings.length) {
      let wmsg = `Synced ${data.synced} row(s)`;
      if (data.supabase_host) wmsg += ` → ${data.supabase_host}`;
      wmsg += "\n\n" + data.warnings.join("\n\n");
      if (data.read_back?.sample?.length) {
        wmsg += "\n\nRead-back sample: " + JSON.stringify(data.read_back.sample);
      }
      alert(wmsg);
    }
    if (document.getElementById("ptl-tbody")) await loadData();
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
  } catch (err) {
    alert("Supabase sync error: " + err.message);
    btn.textContent = "Sync Failed";
    btn.disabled = false;
  }
}
