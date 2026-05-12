/* Inventory BOM — Parts & Flows */

let selectedSource = null;
let selectedSourceEl = null;
let activeBom = null;
let debounceTimer = null;

// ── Boot ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  loadSources();

  document.getElementById("part-search").addEventListener("input", (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => loadSources(e.target.value.trim()), 280);
  });

  document.getElementById("btn-save-flow").addEventListener("click", saveFlowMeta);
  document.getElementById("btn-duplicate").addEventListener("click", () => {
    alert("Duplicate flow — coming soon.");
  });
  document.getElementById("btn-add-flow").addEventListener("click", () => {
    alert("Add Flow — coming soon.");
  });
  document.getElementById("btn-edit-part").addEventListener("click", () => {
    alert("Edit Part — coming soon.");
  });
  document.getElementById("btn-add-part").addEventListener("click", () => {
    alert("Add Part — coming soon.");
  });
  document.getElementById("btn-add-step").addEventListener("click", () => {
    alert("Add Step — coming soon.");
  });
});

// ── Sources (left panel) ──────────────────────────────────────────────────

async function loadSources(search = "") {
  const list = document.getElementById("parts-list");
  list.innerHTML = '<div class="pf-list-loading">Loading...</div>';
  try {
    const url = "/api/bom/sources" + (search ? `?search=${encodeURIComponent(search)}` : "");
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderSourcesList(data);
  } catch (err) {
    list.innerHTML = `<div class="pf-list-empty">Error: ${err.message}</div>`;
  }
}

function renderSourcesList(sources) {
  const list = document.getElementById("parts-list");
  if (!sources.length) {
    list.innerHTML = '<div class="pf-list-empty">No parts found.</div>';
    return;
  }
  list.innerHTML = sources.map((s) => `
    <div class="part-item${s.source_code === selectedSource ? " part-item--selected" : ""}"
         data-source="${esc(s.source_code)}">
      <div class="part-number">${esc(s.source_code)}</div>
      <div class="part-desc">No description</div>
      <div class="part-boms">${s.bom_count} bom(s)</div>
    </div>`
  ).join("");

  list.querySelectorAll(".part-item").forEach((el) => {
    el.addEventListener("click", () => selectSource(el));
  });

  // Re-highlight previously selected source after reload
  if (selectedSource) {
    const el = list.querySelector(`[data-source="${CSS.escape(selectedSource)}"]`);
    if (el) { selectedSourceEl = el; el.classList.add("part-item--selected"); }
  }
}

async function selectSource(el) {
  if (selectedSourceEl) selectedSourceEl.classList.remove("part-item--selected");
  el.classList.add("part-item--selected");
  selectedSourceEl = el;
  selectedSource = el.dataset.source;
  activeBom = null;

  document.getElementById("selected-part-number").textContent = selectedSource;
  document.getElementById("empty-state").style.display = "none";

  const detail = document.getElementById("part-detail");
  detail.style.display = "flex";

  await loadBomTabs(selectedSource);
}

// ── BOM tabs ──────────────────────────────────────────────────────────────

async function loadBomTabs(source) {
  const tabsEl = document.getElementById("bom-tabs");
  tabsEl.innerHTML = "";
  document.getElementById("bom-detail").style.display = "none";
  document.getElementById("bom-no-boms").style.display = "none";

  try {
    const res = await fetch(`/api/bom/sources/${encodeURIComponent(source)}/boms`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (!data.bom_codes.length) {
      document.getElementById("bom-no-boms").style.display = "flex";
      return;
    }

    renderBomTabs(data.bom_codes);
    selectBomTab(data.bom_codes[0]);
  } catch (err) {
    tabsEl.innerHTML = `<span style="font-size:12px;color:#e74c3c">Error: ${err.message}</span>`;
  }
}

function renderBomTabs(bomCodes) {
  const tabsEl = document.getElementById("bom-tabs");
  tabsEl.innerHTML = bomCodes.map((code) => `
    <button class="bom-tab${code === activeBom ? " bom-tab--active" : ""}" data-bom="${esc(code)}">
      ${esc(code)}
    </button>`
  ).join("");

  tabsEl.querySelectorAll(".bom-tab").forEach((btn) => {
    btn.addEventListener("click", () => selectBomTab(btn.dataset.bom));
  });
}

function selectBomTab(bomCode) {
  activeBom = bomCode;

  // Update tab highlight
  document.querySelectorAll(".bom-tab").forEach((btn) => {
    btn.classList.toggle("bom-tab--active", btn.dataset.bom === bomCode);
  });

  // Update flow header
  document.getElementById("flow-code-display").textContent = bomCode;
  document.getElementById("input-bom-code").value = bomCode;

  document.getElementById("bom-detail").style.display = "flex";

  // Load flow name metadata, operations, and materials
  loadFlowMeta(selectedSource, bomCode);
  loadOperations(selectedSource, bomCode);
  loadMaterials(selectedSource, bomCode);
}

// ── Flow metadata ─────────────────────────────────────────────────────────

async function loadFlowMeta(source, bom) {
  try {
    const res = await fetch(
      `/api/bom/meta?source=${encodeURIComponent(source)}&bom=${encodeURIComponent(bom)}`
    );
    const data = await res.json();
    document.getElementById("input-flow-name").value = data.flow_name || "";
  } catch (_) {
    document.getElementById("input-flow-name").value = "";
  }
}

async function saveFlowMeta() {
  if (!selectedSource || !activeBom) return;
  const flowName = document.getElementById("input-flow-name").value.trim();
  try {
    await fetch("/api/bom/meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: selectedSource, bom: activeBom, flow_name: flowName }),
    });
    const btn = document.getElementById("btn-save-flow");
    btn.textContent = "Saved ✓";
    setTimeout(() => { btn.textContent = "Save Flow"; }, 1800);
  } catch (err) {
    alert("Save failed: " + err.message);
  }
}


// ── Operations table (SQLite planner.db) ─────────────────────────────────

async function loadOperations(source, bom) {
  const tbody = document.getElementById("ops-tbody");
  tbody.innerHTML = '<tr><td colspan="5" class="steps-empty">Loading...</td></tr>';
  try {
    const res = await fetch(
      `/api/bom/operations?source=${encodeURIComponent(source)}&bom=${encodeURIComponent(bom)}`
    );
    const rows = await res.json();
    if (rows.error) throw new Error(rows.error);
    renderOperations(rows);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="steps-empty" style="color:#e74c3c">Error: ${err.message}</td></tr>`;
  }
}

function renderOperations(rows) {
  const tbody = document.getElementById("ops-tbody");
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="steps-empty">No operations for this BOM.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td class="col-drag">⠿</td>
      <td>${esc(String(r.stage_no))}</td>
      <td>${r.op_no != null ? esc(String(r.op_no)) : "—"}</td>
      <td>${esc(r.stage_desc)}</td>
      <td>${esc(r.machine_no)}</td>
    </tr>`
  ).join("");
}

// ── Materials table (PostgreSQL) ──────────────────────────────────────────

async function loadMaterials(source, bom) {
  const tbody = document.getElementById("steps-tbody");
  tbody.innerHTML = '<tr><td colspan="2" class="steps-empty">Loading...</td></tr>';
  try {
    const res = await fetch(
      `/api/bom/materials?source=${encodeURIComponent(source)}&bom=${encodeURIComponent(bom)}`
    );
    const rows = await res.json();
    if (rows.error) throw new Error(rows.error);
    renderMaterials(rows);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="2" class="steps-empty" style="color:#e74c3c">Error: ${err.message}</td></tr>`;
  }
}

function renderMaterials(rows) {
  const tbody = document.getElementById("steps-tbody");
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="steps-empty">No materials for this BOM.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${esc(r.material_inventory_code)}</td>
      <td>${esc(r.description)}</td>
    </tr>`
  ).join("");
}

// ── Utilities ─────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
