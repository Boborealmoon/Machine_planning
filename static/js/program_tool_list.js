/* Program / Tool List */

const COLSPAN    = 21;
const PAGE_SIZE  = 100;

let debounceTimer = null;
let allRows       = [];
let filteredRows  = [];   // post-filter, pre-pagination
let currentPage   = 1;
let opTypeFilter  = "";         // "" | "Turning" | "Milling" | "Turnmill"
let machineFilter = new Set();  // empty = show all
let summaryEntries = [];        // full built summary, pre-search

// ── Boot ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  loadData();

  // Search
  document.getElementById("ptl-search").addEventListener("input", (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => loadData(e.target.value.trim()), 280);
  });

  // Sync
  document.getElementById("btn-sync").addEventListener("click", syncData);

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

async function loadData(search = "") {
  setTableState("Loading…");
  try {
    const url = "/api/program-tool-list" +
      (search ? `?search=${encodeURIComponent(search)}` : "");
    const res  = await fetch(url);
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
  btn.textContent = "Syncing…";
  btn.classList.add("btn-syncing");

  try {
    const res  = await fetch("/api/program-tool-list/sync", { method: "POST" });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    btn.textContent = `Synced ${data.synced} rows ✓`;
    const search = document.getElementById("ptl-search").value.trim();
    await loadData(search);
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

function renderTable(rows) {
  const tbody = document.getElementById("ptl-tbody");

  if (!rows.length) {
    setTableState("No records found. Use \"Sync from Google Sheets\" to load data.");
    return;
  }

  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td class="ptl-sticky-1">${esc(r.ps_no)}</td>
      <td class="ptl-sticky-2">${esc(r.part_no_erp)}</td>
      <td>${esc(r.program_no)}</td>

      <td class="ptl-group-start">${esc(r.cnc_machine_no || r.cnc_machine_no_2)}</td>
      <td class="ptl-actual-machine">${esc(r.actual_machine_no)}</td>
      <td>${esc(r.operation_no || r.operation_no_2)}</td>
      <td>${esc(r.operation_type)}</td>
      <td>${esc(r.setup_time)}</td>
      <td>${esc(r.cycle_time)}</td>
      <td>${esc(r.original_setup_time)}</td>

      <td class="ptl-group-start">${esc(r.quoted_setup_price)}</td>
      <td>${esc(r.quoted_ct_price)}</td>

      <td class="ptl-group-start">${esc(r.quoted_ct_price_2)}</td>

      <td class="ptl-group-start">${esc(r.material_extension_mm)}</td>
      <td>${esc(r.setup_diagram_mm)}</td>
      <td>${esc(r.kit_assembly_number || r.kit_assembly_no)}</td>

      <td class="ptl-group-start">${esc(r.programmer_name)}</td>
      <td>${esc(r.date)}</td>
      <td>${esc(r.verified_by)}</td>

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
