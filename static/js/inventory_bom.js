/* Inventory BOM — Parts & Flows (read-only) */

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

  document.getElementById("pf-fetch-btn")?.addEventListener("click", () => {
    fetchFromErp().catch((err) => console.error("Fetch ERP failed:", err));
  });
});

/** Re-read live COMAIN data (no Supabase staging). */
async function fetchFromErp() {
  const btn = document.getElementById("pf-fetch-btn");
  const defaultLabel = btn?.dataset.defaultLabel || "Fetch ERP";
  const search = document.getElementById("part-search")?.value.trim() || "";
  const bomToKeep = activeBom;

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Fetching…";
  }

  try {
    await loadSources(search);
    if (selectedSource) {
      await loadBomTabs(selectedSource, bomToKeep);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = defaultLabel;
    }
  }
}

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
      <div class="part-boms">${s.bom_count} bom(s)</div>
    </div>`
  ).join("");

  list.querySelectorAll(".part-item").forEach((el) => {
    el.addEventListener("click", () => selectSource(el));
  });

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

async function loadBomTabs(source, preferredBom = null) {
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

    const bomToSelect =
      preferredBom && data.bom_codes.includes(preferredBom)
        ? preferredBom
        : data.bom_codes[0];
    renderBomTabs(data.bom_codes);
    selectBomTab(bomToSelect);
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

  document.querySelectorAll(".bom-tab").forEach((btn) => {
    btn.classList.toggle("bom-tab--active", btn.dataset.bom === bomCode);
  });

  document.getElementById("flow-code-display").textContent = bomCode;
  document.getElementById("bom-detail").style.display = "flex";

  loadOperations(selectedSource, bomCode);
  loadMaterials(selectedSource, bomCode);
}

// ── Operations table ──────────────────────────────────────────────────────

async function loadOperations(source, bom) {
  const tbody = document.getElementById("ops-tbody");
  tbody.innerHTML = '<tr><td colspan="4" class="steps-empty">Loading...</td></tr>';
  try {
    const res = await fetch(
      `/api/bom/operations?source=${encodeURIComponent(source)}&bom=${encodeURIComponent(bom)}`
    );
    const rows = await res.json();
    if (rows.error) throw new Error(rows.error);
    renderOperations(rows);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="steps-empty" style="color:#e74c3c">Error: ${err.message}</td></tr>`;
  }
}

function renderOperations(rows) {
  const tbody = document.getElementById("ops-tbody");
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="steps-empty">No operations for this BOM.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${esc(String(r.stage_no))}</td>
      <td>${r.op_no != null ? esc(String(r.op_no)) : "—"}</td>
      <td>${esc(r.stage_desc)}</td>
      <td>${esc(r.machine_no)}</td>
    </tr>`
  ).join("");
}

// ── Materials table ───────────────────────────────────────────────────────

async function loadMaterials(source, bom) {
  const tbody = document.getElementById("steps-tbody");
  tbody.innerHTML = '<tr><td colspan="4" class="steps-empty">Loading...</td></tr>';
  try {
    const res = await fetch(
      `/api/bom/materials?source=${encodeURIComponent(source)}&bom=${encodeURIComponent(bom)}`
    );
    const rows = await res.json();
    if (rows.error) throw new Error(rows.error);
    renderMaterials(rows);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="steps-empty" style="color:#e74c3c">Error: ${err.message}</td></tr>`;
  }
}

function formatQtyPerFg(row) {
  const fromApi = Number(row.qty_per_fg);
  if (Number.isFinite(fromApi) && fromApi > 0) {
    return formatDecimal(fromApi);
  }
  const qtyParent = Number(row.qty_parent);
  const qtyFg = Number(row.qty_fg);
  if (!Number.isFinite(qtyParent) || qtyParent <= 0) return "—";
  const perFg = Number.isFinite(qtyFg) && qtyFg > 0 ? qtyParent / qtyFg : qtyParent;
  return formatDecimal(perFg);
}

function formatDecimal(value) {
  if (!Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/\.?0+$/, "");
}

function renderMaterials(rows) {
  const tbody = document.getElementById("steps-tbody");
  const hint = document.getElementById("materials-hint");
  const templateRows = rows.filter((r) => r.bom_template);
  if (hint) {
    if (templateRows.length) {
      hint.hidden = false;
      hint.textContent = "Template BOM — quantities shown from bom_code (not part-specific).";
    } else {
      hint.hidden = true;
      hint.textContent = "";
    }
  }
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="steps-empty">No materials for this BOM.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${esc(r.material_inventory_code)}</td>
      <td>${esc(r.description)}</td>
      <td>${esc(formatQtyPerFg(r))}</td>
      <td>${esc(r.uom_code || "—")}</td>
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
