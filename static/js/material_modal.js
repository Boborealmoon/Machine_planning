/**
 * Standalone BOM materials + inventory-balance modal.
 * Mirrors the S/O Management material modal, reusing its `so-material-modal-*`
 * CSS classes and DOM shell. Exposes window.openMaterialModal({ partNo, bomCode, processSheetNo }).
 */
(function () {
  "use strict";

  const COPY_ICON =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5" y="4" width="8" height="10" rx="1"/><path d="M4 4V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1"/></svg>';

  function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function copyBtn(text, label) {
    const value = String(text || "").trim();
    if (!value) return "";
    const aria = escapeHtml(label || "text");
    return `
      <button type="button" class="so-copy-btn"
        data-action="copy-text"
        data-copy-json="${escapeHtml(JSON.stringify(value))}"
        title="Copy ${aria}"
        aria-label="Copy ${aria}">
        ${COPY_ICON}
      </button>
    `;
  }

  function copyableLine(label, text, { mono = false } = {}) {
    const value = String(text || "").trim();
    if (!value) return "";
    const cls = mono ? " so-material-modal-id-value--mono" : "";
    return `
      <div class="so-copy-line so-material-modal-id-row">
        <span class="so-material-modal-id-label">${escapeHtml(label)}</span>
        <span class="so-material-modal-id-value${cls}">${escapeHtml(value)}</span>
        ${copyBtn(value, label)}
      </div>
    `;
  }

  function copyableCell(text, label) {
    const value = String(text || "").trim();
    if (!value || value === "—") return escapeHtml(text || "—");
    return `
      <span class="so-copy-line so-copy-line--cell">
        <span class="so-copy-line-text">${escapeHtml(value)}</span>
        ${copyBtn(value, label)}
      </span>
    `;
  }

  function renderHeader(partNo, bomCode, processSheetNo) {
    const rows = [
      copyableLine("Part no", partNo, { mono: true }),
      copyableLine("BOM code", bomCode, { mono: true }),
      copyableLine("PS number", processSheetNo, { mono: true }),
    ]
      .filter(Boolean)
      .join("");
    const part = String(partNo || "").trim();
    if (rows) return rows;
    return part
      ? `<div class="so-copy-line so-material-modal-id-row"><span class="so-material-modal-id-value so-material-modal-id-value--mono">${escapeHtml(
          part
        )}</span>${copyBtn(part, "Part no")}</div>`
      : "";
  }

  function copyTextFromButton(btn) {
    if (!btn) return;
    let value = "";
    try {
      value = JSON.parse(btn.dataset.copyJson || '""');
    } catch (_err) {
      value = btn.dataset.copyJson || "";
    }
    value = String(value || "").trim();
    if (!value) return;
    const defaultTitle = btn.title || "";
    navigator.clipboard.writeText(value).then(
      () => {
        btn.classList.add("is-copied");
        btn.title = "Copied!";
        window.setTimeout(() => {
          btn.classList.remove("is-copied");
          btn.title = defaultTitle;
        }, 1200);
      },
      () => {
        btn.classList.add("is-copy-error");
        btn.title = "Copy failed";
        window.setTimeout(() => {
          btn.classList.remove("is-copy-error");
          btn.title = defaultTitle;
        }, 1200);
      }
    );
  }

  function bomQtyPerFg(qtyParent, qtyFg) {
    const parent = Number(qtyParent);
    const fg = Number(qtyFg);
    if (!Number.isFinite(parent) || parent <= 0) return null;
    if (!Number.isFinite(fg) || fg <= 0) return parent;
    if (Math.abs(parent - fg) < 1e-9) return parent;
    return parent / fg;
  }

  function formatMaterialQtyPerFg(row) {
    const fromApi = Number(row.qty_per_fg);
    if (Number.isFinite(fromApi) && fromApi > 0) {
      return Number.isInteger(fromApi)
        ? String(fromApi)
        : fromApi.toFixed(4).replace(/\.?0+$/, "");
    }
    const perFg = bomQtyPerFg(row.qty_parent, row.qty_fg);
    if (perFg == null) return "—";
    return Number.isInteger(perFg)
      ? String(perFg)
      : perFg.toFixed(4).replace(/\.?0+$/, "");
  }

  function formatInvNum(value) {
    if (value == null || value === "") return "—";
    const n = Number(value);
    if (Number.isNaN(n)) return String(value);
    if (Math.abs(n) < 0.0001 && n !== 0) return String(value);
    if (Number.isInteger(n)) return String(n);
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  function invQtyCell(value) {
    const n = Number(value);
    const cls = Number.isFinite(n) && n > 0 ? " inv-enq-qty--pos" : "";
    return `<td class="new-orders-num${cls}">${escapeHtml(formatInvNum(value))}</td>`;
  }

  function bomMaterialCodes(bomRows) {
    return [
      ...new Set(
        (bomRows || [])
          .map((row) => String(row.material_inventory_code || "").trim())
          .filter(Boolean)
      ),
    ];
  }

  function inventoryMatchesBomCode(bomCode, invRows) {
    const bom = String(bomCode || "").trim();
    if (!bom) return [];
    const matches = (invRows || []).filter((row) => {
      const matchedBom = String(row.matched_bom_material_code || "").trim();
      if (matchedBom && matchedBom === bom) return true;
      const inv = String(row.inventory_code || "").trim();
      return inv === bom || inv.startsWith(`${bom}_`);
    });
    return matches.sort((a, b) => {
      const ac = String(a.inventory_code || "");
      const bc = String(b.inventory_code || "");
      if (ac === bom && bc !== bom) return -1;
      if (bc === bom && ac !== bom) return 1;
      return ac.localeCompare(bc, undefined, { numeric: true, sensitivity: "base" });
    });
  }

  function renderInventoryDataRow(bomCode, row, { showBomCell = true, rowSpan = 1 } = {}) {
    const invCode = String(row.inventory_code || "").trim();
    const bom = String(bomCode || "").trim();
    const isVariant = invCode && bom && invCode !== bom;
    const desc = String(row.main_desc || "").trim();
    const variantBadge = isVariant
      ? '<span class="so-material-modal-match-pill" title="Matched from BOM material header with dimension suffix">variant</span>'
      : "";
    const bomCell = showBomCell
      ? `<td class="new-orders-mono so-material-modal-bom-ref"${
          rowSpan > 1 ? ` rowspan="${rowSpan}"` : ""
        }>${escapeHtml(bom)}</td>`
      : "";
    return `
      <tr${isVariant ? ' class="so-material-modal-inv-variant"' : ""}>
        ${bomCell}
        <td class="new-orders-mono">
          <span class="so-material-modal-inv-code">${escapeHtml(invCode || bom)}${variantBadge}</span>
        </td>
        <td class="so-material-modal-desc" title="${escapeHtml(desc)}">${escapeHtml(desc || "—")}</td>
        <td>${escapeHtml(String(row.inventory_class_code || "—"))}</td>
        <td>${escapeHtml(String(row.inventory_category_code || "—"))}</td>
        <td>${escapeHtml(String(row.uom_code || "—"))}</td>
        ${invQtyCell(row.total_qoh_available)}
        ${invQtyCell(row.total_qty_on_hand)}
        ${invQtyCell(row.total_qty_on_order)}
        ${invQtyCell(row.total_allocated_in_sq)}
        ${invQtyCell(row.total_unallocated_qty)}
        ${invQtyCell(row.total_free_balance_qty)}
        ${invQtyCell(row.total_qty_back_order)}
      </tr>
    `;
  }

  function renderInventoryTable(bomRows, invRows) {
    const codes = bomMaterialCodes(bomRows);
    if (!codes.length) return "";
    const bodyParts = [];
    codes.forEach((bomCode) => {
      const matches = inventoryMatchesBomCode(bomCode, invRows);
      if (!matches.length) {
        bodyParts.push(`
          <tr class="so-material-modal-inv-missing">
            <td class="new-orders-mono so-material-modal-bom-ref">${escapeHtml(bomCode)}</td>
            <td class="new-orders-mono">${escapeHtml(bomCode)}</td>
            <td colspan="11" class="so-material-modal-inv-missing-note">Not found in inventory enquiry (exact or dimension suffix)</td>
          </tr>
        `);
        return;
      }
      matches.forEach((row, idx) => {
        bodyParts.push(
          renderInventoryDataRow(bomCode, row, {
            showBomCell: idx === 0,
            rowSpan: matches.length,
          })
        );
      });
    });
    return `
      <section class="so-material-modal-section">
        <h3 class="so-material-modal-section-title">Inventory enquiry</h3>
        <p class="so-material-modal-section-hint">Live stock for each BOM material. Dimension variants (e.g. <code>NITRONIC 50(HS)*3_D50.8_39.1</code>) are matched when they share the same BOM header.</p>
        <div class="so-material-modal-table-wrap so-material-modal-table-wrap--wide">
          <table class="so-material-modal-table so-material-modal-table--inventory">
            <thead>
              <tr>
                <th>BOM material</th>
                <th>Part no</th>
                <th>Description</th>
                <th>Class</th>
                <th>Cat</th>
                <th>UOM</th>
                <th>QOH avail</th>
                <th>On hand</th>
                <th>On order</th>
                <th>Alloc (SQ)</th>
                <th>Unalloc</th>
                <th>Free bal</th>
                <th>Back order</th>
              </tr>
            </thead>
            <tbody>${bodyParts.join("")}</tbody>
          </table>
        </div>
      </section>
    `;
  }

  function shouldShowBomRouteColumn(bomRows, meta) {
    const mode = String(meta?.match_mode || "").trim();
    if (mode && mode !== "exact") return true;
    const codes = new Set(
      (bomRows || []).map((row) => String(row.bom_code || "").trim()).filter(Boolean)
    );
    return codes.size > 1;
  }

  function renderNotice(meta) {
    const text = String(meta?.notice || "").trim();
    if (!text) return "";
    const mode = String(meta?.match_mode || "");
    const cls =
      mode === "not_found" || mode === "route_no_materials"
        ? " so-material-modal-notice--warn"
        : " so-material-modal-notice--info";
    return `<div class="so-material-modal-notice${cls}">${escapeHtml(text)}</div>`;
  }

  function renderMatchedBomStages(meta) {
    const stages = Array.isArray(meta?.matched_stages) ? meta.matched_stages : [];
    if (!stages.length) return "";
    const route = String(meta?.matched_bom_code || meta?.resolved_bom_code || "").trim();
    const desc = String(meta?.matched_bom_desc || "").trim();
    const title = route
      ? `Matched BOM op stages · ${route}${desc ? ` · ${desc}` : ""}`
      : "Matched BOM op stages";
    const body = stages
      .map((stage) => {
        const no =
          stage?.stage_no != null && stage.stage_no !== "" ? String(stage.stage_no) : "—";
        const stageDesc = String(stage?.stage_desc || "—");
        return `
      <tr>
        <td class="new-orders-num">${escapeHtml(no)}</td>
        <td>${escapeHtml(stageDesc)}</td>
      </tr>
    `;
      })
      .join("");
    return `
      <section class="so-material-modal-section">
        <h3 class="so-material-modal-section-title">${escapeHtml(title)}</h3>
        <div class="so-material-modal-table-wrap">
          <table class="so-material-modal-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderBomTable(rows, meta = null) {
    if (!Array.isArray(rows) || !rows.length) {
      const stagesHtml = renderMatchedBomStages(meta);
      if (stagesHtml) {
        return `${stagesHtml}<p class="so-material-modal-empty">No raw-material lines on this BOM route.</p>`;
      }
      return '<p class="so-material-modal-empty">No BOM materials found for this part and route.</p>';
    }
    const showRoute = shouldShowBomRouteColumn(rows, meta);
    const body = rows
      .map(
        (row) => `
      <tr>
        ${showRoute ? `<td class="new-orders-mono">${escapeHtml(String(row.bom_code || "—"))}</td>` : ""}
        <td class="new-orders-mono">${copyableCell(row.material_inventory_code, "material name")}</td>
        <td>${escapeHtml(row.description || "—")}</td>
        <td class="new-orders-num">${escapeHtml(formatMaterialQtyPerFg(row))}</td>
        <td>${escapeHtml(row.uom_code || "—")}</td>
      </tr>
    `
      )
      .join("");
    return `
      <section class="so-material-modal-section">
        <h3 class="so-material-modal-section-title">BOM materials</h3>
        <div class="so-material-modal-table-wrap">
          <table class="so-material-modal-table">
            <thead>
              <tr>
                ${showRoute ? "<th>BOM route</th>" : ""}
                <th>Material</th>
                <th>Description</th>
                <th>Qty / FG</th>
                <th>UOM</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderContent(bomRows, invRows, meta = null) {
    return [
      renderNotice(meta),
      renderBomTable(bomRows, meta),
      renderInventoryTable(bomRows, invRows),
    ].join("");
  }

  function parseBomMaterialsResponse(data) {
    if (Array.isArray(data)) return { bomRows: data, meta: null };
    if (data && Array.isArray(data.rows)) {
      return {
        bomRows: data.rows,
        meta: {
          requested_bom_code: data.requested_bom_code || "",
          resolved_bom_code: data.resolved_bom_code || "",
          match_mode: data.match_mode || "",
          alternate_bom_codes: data.alternate_bom_codes || [],
          notice: data.notice || "",
          matched_bom_code: data.matched_bom_code || data.resolved_bom_code || "",
          matched_bom_desc: data.matched_bom_desc || "",
          matched_stages: Array.isArray(data.matched_stages) ? data.matched_stages : [],
          route_matched: Boolean(data.route_matched),
        },
      };
    }
    if (data?.error) throw new Error(data.error);
    return { bomRows: [], meta: null };
  }

  function closeModal() {
    const shell = document.getElementById("so-material-modal");
    if (!shell) return;
    shell.hidden = true;
    document.body.classList.remove("so-material-modal-open");
    const bodyEl = document.getElementById("so-material-modal-body");
    if (bodyEl) bodyEl.innerHTML = "";
    const titleEl = document.getElementById("so-material-modal-title");
    if (titleEl) titleEl.innerHTML = "";
  }

  function openModal({ partNo, bomCode, processSheetNo } = {}) {
    const shell = document.getElementById("so-material-modal");
    const titleEl = document.getElementById("so-material-modal-title");
    const bodyEl = document.getElementById("so-material-modal-body");
    if (!shell || !titleEl || !bodyEl) return;

    const part = String(partNo || "").trim();
    const bom = String(bomCode || "").trim();
    const psNo = String(processSheetNo || "").trim();
    if (!part) return;

    titleEl.innerHTML = renderHeader(part, bom, psNo);
    bodyEl.innerHTML =
      '<div class="so-material-modal-loading"><div class="spinner"></div> Loading BOM materials and inventory…</div>';
    shell.hidden = false;
    document.body.classList.add("so-material-modal-open");

    const bomParams = new URLSearchParams({ source: part, fallback: "1" });
    if (bom) bomParams.set("bom", bom);

    fetch(`/api/bom/materials?${bomParams}`)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(async ({ ok, data }) => {
        if (!ok) throw new Error(data?.error || "Failed to load BOM materials");
        const { bomRows, meta } = parseBomMaterialsResponse(data);
        const codes = bomMaterialCodes(bomRows);
        let invRows = [];
        if (codes.length) {
          const invParams = new URLSearchParams({ codes: codes.join(","), loose: "1" });
          const invRes = await fetch(`/api/inventory-enquiry?${invParams}`);
          const invData = await invRes.json();
          if (!invRes.ok || invData?.error) {
            throw new Error(invData?.error || "Failed to load inventory enquiry");
          }
          invRows = Array.isArray(invData.rows) ? invData.rows : [];
        }
        bodyEl.innerHTML = renderContent(bomRows, invRows, meta);
      })
      .catch((err) => {
        bodyEl.innerHTML = `<p class="so-material-modal-error">Could not load materials: ${escapeHtml(
          err.message || "Unknown error"
        )}</p>`;
      });
  }

  function bindModal() {
    const shell = document.getElementById("so-material-modal");
    if (!shell || shell.dataset.bound === "1") return;
    shell.dataset.bound = "1";

    shell
      .querySelector('[data-action="close-material-modal"]')
      ?.addEventListener("click", closeModal);
    document
      .getElementById("so-material-modal-close")
      ?.addEventListener("click", closeModal);
    shell.addEventListener("click", (e) => {
      const btn = e.target.closest('[data-action="copy-text"]');
      if (!btn || !shell.contains(btn)) return;
      e.stopPropagation();
      copyTextFromButton(btn);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !shell.hidden) closeModal();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindModal);
  } else {
    bindModal();
  }

  window.openMaterialModal = openModal;
  window.closeMaterialModal = closeModal;
})();
