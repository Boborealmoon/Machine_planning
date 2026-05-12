/* Parts & Flows — Inventory BOM */

let selectedPartId = null;
let selectedPartEl = null;
let editingPartId = null;
let debounceTimer = null;

// ── Boot ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  loadParts();

  document.getElementById("part-search").addEventListener("input", (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => loadParts(e.target.value.trim()), 280);
  });

  document.getElementById("btn-add-part").addEventListener("click", () => {
    editingPartId = null;
    document.getElementById("modal-part-title").textContent = "Add Part";
    document.getElementById("input-part-number").value = "";
    document.getElementById("input-part-desc").value = "";
    document.getElementById("part-error").textContent = "";
    showModal("modal-part");
  });

  document.getElementById("btn-edit-part").addEventListener("click", () => {
    if (!selectedPartId) return;
    editingPartId = selectedPartId;
    document.getElementById("modal-part-title").textContent = "Edit Part";
    document.getElementById("input-part-number").value =
      document.getElementById("selected-part-number").textContent;
    document.getElementById("input-part-desc").value =
      document.getElementById("selected-part-desc").textContent;
    document.getElementById("part-error").textContent = "";
    showModal("modal-part");
  });

  document.getElementById("btn-save-part").addEventListener("click", savePart);

  document.getElementById("btn-add-flow").addEventListener("click", () => {
    document.getElementById("input-flow-name").value = "";
    document.getElementById("flow-error").textContent = "";
    showModal("modal-flow");
  });

  document.getElementById("btn-save-flow").addEventListener("click", saveFlow);

  // Close buttons
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => hideModal(btn.dataset.close));
  });

  // Close on overlay click
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) hideModal(overlay.id);
    });
  });

  // Enter key in modals
  document.getElementById("input-part-desc").addEventListener("keydown", (e) => {
    if (e.key === "Enter") savePart();
  });
  document.getElementById("input-flow-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveFlow();
  });
});

// ── Parts ─────────────────────────────────────────────────────────────────

async function loadParts(search = "") {
  const list = document.getElementById("parts-list");
  list.innerHTML = '<div class="pf-list-loading">Loading...</div>';
  try {
    const url = "/api/parts" + (search ? `?search=${encodeURIComponent(search)}` : "");
    const res = await fetch(url);
    const parts = await res.json();
    if (parts.error) throw new Error(parts.error);
    renderPartsList(parts);
  } catch (err) {
    list.innerHTML = `<div class="pf-list-empty">Error: ${err.message}</div>`;
  }
}

function renderPartsList(parts) {
  const list = document.getElementById("parts-list");
  if (!parts.length) {
    list.innerHTML = '<div class="pf-list-empty">No parts found.</div>';
    return;
  }
  list.innerHTML = parts
    .map(
      (p) => `
    <div class="part-item${p.id === selectedPartId ? " part-item--selected" : ""}"
         data-id="${p.id}"
         data-number="${esc(p.part_number)}"
         data-desc="${esc(p.description)}">
      <div class="part-number">${esc(p.part_number)}</div>
      ${p.description ? `<div class="part-desc">${esc(p.description)}</div>` : ""}
      <div class="part-flows">${p.flow_count} flow(s)</div>
    </div>`
    )
    .join("");

  list.querySelectorAll(".part-item").forEach((el) => {
    el.addEventListener("click", () => selectPart(el));
  });

  // Re-select the previously selected item if it still exists
  if (selectedPartId) {
    const el = list.querySelector(`[data-id="${selectedPartId}"]`);
    if (el) {
      selectedPartEl = el;
      el.classList.add("part-item--selected");
    }
  }
}

function selectPart(el) {
  // Deselect previous
  if (selectedPartEl) selectedPartEl.classList.remove("part-item--selected");

  el.classList.add("part-item--selected");
  selectedPartEl = el;
  selectedPartId = parseInt(el.dataset.id);

  document.getElementById("selected-part-number").textContent = el.dataset.number;
  document.getElementById("selected-part-desc").textContent = el.dataset.desc;

  document.getElementById("empty-state").style.display = "none";
  document.getElementById("part-header").style.display = "flex";
  document.getElementById("flows-list").style.display = "flex";

  loadFlows(selectedPartId);
}

async function savePart() {
  const partNumber = document.getElementById("input-part-number").value.trim();
  const description = document.getElementById("input-part-desc").value.trim();
  const errEl = document.getElementById("part-error");
  errEl.textContent = "";

  if (!partNumber) {
    errEl.textContent = "Part number is required.";
    return;
  }

  try {
    let res;
    if (editingPartId) {
      res = await fetch(`/api/parts/${editingPartId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ part_number: partNumber, description }),
      });
    } else {
      res = await fetch("/api/parts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ part_number: partNumber, description }),
      });
    }

    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || "Failed to save."; return; }

    hideModal("modal-part");

    // Update the header if we edited the currently selected part
    if (editingPartId && editingPartId === selectedPartId) {
      document.getElementById("selected-part-number").textContent = data.part_number;
      document.getElementById("selected-part-desc").textContent = data.description;
      if (selectedPartEl) {
        selectedPartEl.dataset.number = data.part_number;
        selectedPartEl.dataset.desc = data.description;
      }
    }

    // Reload list, keep selection
    await loadParts(document.getElementById("part-search").value.trim());

    // Auto-select newly created part
    if (!editingPartId) {
      selectedPartId = data.id;
      const newEl = document.getElementById("parts-list").querySelector(`[data-id="${data.id}"]`);
      if (newEl) selectPart(newEl);
    }
  } catch (err) {
    errEl.textContent = err.message;
  }
}

// ── Flows ─────────────────────────────────────────────────────────────────

async function loadFlows(partId) {
  const list = document.getElementById("flows-list");
  list.innerHTML = '<div class="pf-list-loading" style="padding:12px 0">Loading...</div>';
  try {
    const res = await fetch(`/api/parts/${partId}/flows`);
    const flows = await res.json();
    if (flows.error) throw new Error(flows.error);
    renderFlows(flows, partId);
  } catch (err) {
    list.innerHTML = `<div class="pf-list-empty">Error: ${err.message}</div>`;
  }
}

function renderFlows(flows, partId) {
  const list = document.getElementById("flows-list");
  if (!flows.length) {
    list.innerHTML = '<div class="pf-flows-empty">No flows yet. Click "Add Flow" to create one.</div>';
    return;
  }
  list.innerHTML = flows
    .map(
      (f) => `
    <div class="flow-item" data-flow-id="${f.id}">
      <span class="flow-name">${esc(f.name)}</span>
      <button class="flow-delete" data-flow-id="${f.id}" title="Delete flow">&times;</button>
    </div>`
    )
    .join("");

  list.querySelectorAll(".flow-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteFlow(parseInt(btn.dataset.flowId), partId);
    });
  });
}

async function saveFlow() {
  if (!selectedPartId) return;
  const name = document.getElementById("input-flow-name").value.trim();
  const errEl = document.getElementById("flow-error");
  errEl.textContent = "";

  if (!name) { errEl.textContent = "Flow name is required."; return; }

  try {
    const res = await fetch(`/api/parts/${selectedPartId}/flows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || "Failed to save."; return; }

    hideModal("modal-flow");
    await loadFlows(selectedPartId);
    await loadParts(document.getElementById("part-search").value.trim());
  } catch (err) {
    errEl.textContent = err.message;
  }
}

async function deleteFlow(flowId, partId) {
  if (!confirm("Delete this flow?")) return;
  try {
    await fetch(`/api/flows/${flowId}`, { method: "DELETE" });
    await loadFlows(partId);
    await loadParts(document.getElementById("part-search").value.trim());
  } catch (err) {
    alert("Failed to delete flow: " + err.message);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────

function showModal(id) {
  document.getElementById(id).style.display = "flex";
}

function hideModal(id) {
  document.getElementById(id).style.display = "none";
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
