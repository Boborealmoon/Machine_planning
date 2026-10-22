(function () {
  const page = document.querySelector(".pst-page");
  const form = document.getElementById("pst-form");
  const input = document.getElementById("pst-input");
  const suggestEl = document.getElementById("pst-suggest");
  const submit = document.getElementById("pst-submit");
  const printBtn = document.getElementById("pst-print");
  const statusEl = document.getElementById("pst-status");
  const resultEl = document.getElementById("pst-result");
  if (!page || !form || !input || !resultEl) return;

  let suggestTimer = null;
  let suggestToken = 0;
  let suggestions = [];
  let suggestIndex = -1;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function qtyText(value) {
    if (value == null || value === "") return "—";
    const number = Number(value);
    if (!Number.isFinite(number)) return escapeHtml(value);
    return escapeHtml(String(number));
  }

  function setStatus(message, isError) {
    statusEl.textContent = message || "";
    statusEl.classList.toggle("is-error", Boolean(isError));
  }

  function allocState(row) {
    const remain = Number(row.remain_qty || 0);
    const issued = Number(row.issued_qty || 0);
    if (remain > 0 && issued > 0) return { label: "Part issued", kind: "open" };
    if (remain > 0) return { label: "Allocated", kind: "open" };
    if (issued > 0) return { label: "Issued", kind: "issued" };
    return { label: "Allocated", kind: "open" };
  }

  function batchCell(row) {
    const batch = String(row.batch_no || "").trim();
    if (!batch) return '<span class="pst-empty">—</span>';
    return '<span class="pst-code">' + escapeHtml(batch) + "</span>";
  }

  function jobCell(row) {
    const job = String(row.work_order_no || "").trim();
    const voucher = String(row.alloc_voucher_no || "").trim();
    if (!job && !voucher) return '<span class="pst-empty">—</span>';
    let html = job
      ? '<span class="pst-code">' + escapeHtml(job) + "</span>"
      : '<span class="pst-empty">—</span>';
    if (voucher) html += '<span class="pst-desc">' + escapeHtml(voucher) + "</span>";
    return html;
  }

  function statusCell(row) {
    const state = allocState(row);
    return '<span class="pst-pill pst-pill--' + state.kind + '">' + escapeHtml(state.label) + "</span>";
  }

  function materialRows(materials) {
    const rows = [];
    (materials || []).forEach((material) => {
      const allocs = Array.isArray(material.allocations) ? material.allocations : [];
      const shared = material.shared
        ? '<span class="pst-shared" title="This material is on more than one line, and the job did not record which lot belongs to this line.">Shared</span>'
        : "";
      const identity =
        '<div class="pst-code">' +
        escapeHtml(material.inventory_code) +
        "</div>" +
        (material.description ? '<span class="pst-desc">' + escapeHtml(material.description) + "</span>" : "") +
        (material.bom_code ? '<span class="pst-desc">' + escapeHtml(material.bom_code) + "</span>" : "") +
        shared;
      if (!allocs.length) {
        rows.push(
          "<tr>" +
            "<td>" + identity + "</td>" +
            '<td class="pst-num">' + qtyText(material.qty) + "</td>" +
            '<td class="pst-num">' + qtyText(material.required_qty) + "</td>" +
            '<td><span class="pst-empty">—</span></td>' +
            '<td><span class="pst-empty">—</span></td>' +
            '<td class="pst-num"><span class="pst-empty">—</span></td>' +
            '<td><span class="pst-pill pst-pill--none">No allocation</span></td>' +
            "</tr>"
        );
        return;
      }
      allocs.forEach((alloc, index) => {
        const issued = Number(alloc.issued_qty || 0);
        rows.push(
          "<tr>" +
            "<td>" + (index === 0 ? identity : "") + "</td>" +
            '<td class="pst-num">' + (index === 0 ? qtyText(material.qty) : "") + "</td>" +
            '<td class="pst-num">' + (index === 0 ? qtyText(material.required_qty) : "") + "</td>" +
            "<td>" + batchCell(alloc) + "</td>" +
            "<td>" + jobCell(alloc) + "</td>" +
            '<td class="pst-num">' + (issued > 0 ? qtyText(alloc.issued_qty) : '<span class="pst-empty">—</span>') + "</td>" +
            "<td>" + statusCell(alloc) + "</td>" +
            "</tr>"
        );
      });
    });
    return rows.join("");
  }

  function tableHtml(materials) {
    return (
      '<div class="pst-table-wrap"><table class="pst-table">' +
      "<colgroup>" +
      '<col class="pst-col-material">' +
      '<col class="pst-col-qty">' +
      '<col class="pst-col-qty">' +
      '<col class="pst-col-batch">' +
      '<col class="pst-col-job">' +
      '<col class="pst-col-qty">' +
      '<col class="pst-col-status">' +
      "</colgroup>" +
      "<thead><tr>" +
      "<th>Material</th>" +
      '<th class="pst-num">BOM qty</th>' +
      '<th class="pst-num">Required</th>' +
      "<th>Batch / heat</th>" +
      "<th>Job</th>" +
      '<th class="pst-num">Issued</th>' +
      "<th>Status</th>" +
      "</tr></thead><tbody>" +
      materialRows(materials) +
      "</tbody></table></div>"
    );
  }

  function lineMatches(line, needle) {
    if (!needle) return true;
    const chunks = [
      line.line_no,
      line.process_sheet_no,
      line.sub_part,
      line.sub_part_desc,
    ];
    (line.materials || []).forEach((material) => {
      chunks.push(material.inventory_code, material.description, material.bom_code);
      (material.allocations || []).forEach((alloc) => {
        chunks.push(alloc.batch_no, alloc.lot_no, alloc.alloc_voucher_no);
        (alloc.other_refs || []).forEach((ref) => chunks.push(ref));
      });
    });
    return chunks.join(" ").toLowerCase().indexOf(needle) >= 0;
  }

  function render(payload) {
    const header = payload.header || {};
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const special = Boolean(payload.special);
    let allocated = 0;
    let missing = 0;
    lines.forEach((line) => {
      (line.materials || []).forEach((material) => {
        if (material.allocations && material.allocations.length) allocated += 1;
        else missing += 1;
      });
    });

    const salesOrder = [header.sales_order_no, header.sales_order_line].filter(Boolean).join(" / ");
    const source = [header.source_voucher_no, header.source_line].filter(Boolean).join(" / ");
    const stats = [
      ["Process sheet", header.process_sheet_no],
      ["Part", header.part_no, header.part_desc],
      ["Pushed BOM", header.bom_code, header.bom_desc],
      ["Qty", header.qty == null ? "" : String(header.qty)],
      salesOrder
        ? ["Sales order", salesOrder]
        : ["Source", source],
    ];

    let html = '<div class="pst-summary">';
    stats.forEach((stat) => {
      html +=
        '<div class="pst-stat"><p class="pst-stat-label">' +
        escapeHtml(stat[0]) +
        '</p><p class="pst-stat-value">' +
        escapeHtml(stat[1] || "—") +
        "</p>" +
        (stat[2] ? '<p class="pst-stat-hint">' + escapeHtml(stat[2]) + "</p>" : "") +
        "</div>";
    });
    html += "</div>";

    if (payload.focus_process_sheet) {
      html +=
        '<p class="pst-focus">Showing line item <strong>' +
        escapeHtml(payload.focus_process_sheet) +
        "</strong> under " +
        escapeHtml(header.process_sheet_no) +
        ".</p>";
    }

    html +=
      '<div class="pst-toolbar"><input id="pst-filter" class="pst-filter" type="search" placeholder="' +
      (special ? "Filter line, material, or batch" : "Filter material or batch") +
      '"></div>';
    html += '<div id="pst-lines"></div>';
    resultEl.innerHTML = html;
    resultEl.hidden = false;

    const host = document.getElementById("pst-lines");
    const filter = document.getElementById("pst-filter");

    function paint() {
      const needle = String(filter.value || "").trim().toLowerCase();
      const visible = lines.filter((line) => lineMatches(line, needle));
      if (!visible.length) {
        host.innerHTML = '<p class="pst-status">No lines match that filter.</p>';
        return;
      }
      if (!special) {
        const materials = [];
        visible.forEach((line) => {
          (line.materials || []).forEach((material) => materials.push(material));
        });
        host.innerHTML = '<div class="pst-line">' + tableHtml(materials) + "</div>";
        return;
      }
      host.innerHTML = visible
        .map((line) => {
          const title = line.sub_part
            ? "Line " + (line.line_no || "—") + " · " + line.sub_part
            : "Line " + (line.line_no || "—");
          const meta = [
            line.process_sheet_no,
            line.sub_part_desc,
            line.sub_part_qty != null ? "Qty " + line.sub_part_qty : "",
            line.in_house ? "In-house" : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            '<section class="pst-line">' +
            '<div class="pst-line-head"><h2 class="pst-line-title">' +
            escapeHtml(title) +
            "</h2>" +
            (meta ? '<span class="pst-line-meta">' + escapeHtml(meta) + "</span>" : "") +
            "</div>" +
            tableHtml(line.materials) +
            "</section>"
          );
        })
        .join("");
    }

    filter.addEventListener("input", paint);
    paint();
    setStatus(
      lines.length +
        (special ? " line item" + (lines.length === 1 ? "" : "s") : " material line" + (lines.length === 1 ? "" : "s")) +
        " · " +
        allocated +
        " with an allocation · " +
        missing +
        " without"
    );
  }

  async function trace(processSheetNo) {
    const query = String(processSheetNo || "").trim();
    if (!query) {
      setStatus("Enter a process sheet number.", true);
      return;
    }
    submit.disabled = true;
    setStatus("Reading the pushed BOM and allocations…");
    resultEl.hidden = true;
    try {
      const response = await fetch(
        "/api/process-sheet-trace?ps=" + encodeURIComponent(query)
      );
      const payload = await response.json();
      if (!response.ok) {
        setStatus(payload.error || (response.status === 404 ? "Process sheet was not found." : "Trace failed."), true);
        return;
      }
      if (!payload.found) {
        setStatus("No process sheet matches " + query + ".", true);
        return;
      }
      const url = new URL(window.location.href);
      url.searchParams.set("ps", query);
      history.replaceState({}, "", url.pathname + url.search);
      render(payload);
    } catch (err) {
      setStatus("Could not reach the trace service.", true);
    } finally {
      submit.disabled = false;
    }
  }

  function hideSuggest() {
    if (!suggestEl) return;
    suggestEl.hidden = true;
    suggestEl.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    suggestions = [];
    suggestIndex = -1;
  }

  function suggestionMeta(hit) {
    return [hit.part_no, hit.description, hit.qty == null || hit.qty === "" ? "" : "Qty " + hit.qty]
      .filter(Boolean)
      .join(" · ");
  }

  function paintSuggest() {
    if (!suggestEl) return;
    if (!suggestions.length) {
      hideSuggest();
      return;
    }
    suggestEl.innerHTML = suggestions
      .map(function (hit, index) {
        const meta = suggestionMeta(hit);
        return (
          '<button type="button" class="pst-suggest-item' +
          (index === suggestIndex ? " is-active" : "") +
          '" role="option" data-index="' +
          index +
          '">' +
          '<span class="pst-suggest-no">' +
          escapeHtml(hit.process_sheet_no) +
          "</span>" +
          (meta ? '<span class="pst-suggest-meta">' + escapeHtml(meta) + "</span>" : "") +
          "</button>"
        );
      })
      .join("");
    suggestEl.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function chooseSuggestion(hit) {
    if (!hit || !hit.process_sheet_no) return;
    input.value = hit.process_sheet_no;
    hideSuggest();
    trace(hit.process_sheet_no);
  }

  function moveSuggest(step) {
    if (!suggestions.length) return;
    if (suggestIndex < 0) suggestIndex = step > 0 ? 0 : suggestions.length - 1;
    else suggestIndex = (suggestIndex + step + suggestions.length) % suggestions.length;
    paintSuggest();
  }

  async function loadSuggest(query) {
    const token = ++suggestToken;
    try {
      const response = await fetch("/api/process-sheet-trace/suggest?q=" + encodeURIComponent(query));
      const payload = await response.json();
      if (token !== suggestToken) return;
      if (String(input.value || "").trim() !== query) return;
      suggestions = response.ok && Array.isArray(payload.suggestions) ? payload.suggestions : [];
      suggestIndex = suggestions.length ? 0 : -1;
      paintSuggest();
    } catch (err) {
      if (token === suggestToken) hideSuggest();
    }
  }

  function scheduleSuggest() {
    const query = String(input.value || "").trim();
    if (suggestTimer) clearTimeout(suggestTimer);
    if (query.length < 2) {
      suggestToken += 1;
      hideSuggest();
      return;
    }
    suggestTimer = setTimeout(function () {
      loadSuggest(query);
    }, 140);
  }

  if (suggestEl) {
    suggestEl.addEventListener("mousedown", function (event) {
      const button = event.target.closest(".pst-suggest-item");
      if (!button) return;
      event.preventDefault();
      chooseSuggestion(suggestions[Number(button.getAttribute("data-index"))]);
    });
  }

  input.addEventListener("input", scheduleSuggest);
  input.addEventListener("keydown", function (event) {
    if (event.key === "ArrowDown") {
      if (!suggestions.length) return;
      event.preventDefault();
      moveSuggest(1);
      return;
    }
    if (event.key === "ArrowUp") {
      if (!suggestions.length) return;
      event.preventDefault();
      moveSuggest(-1);
      return;
    }
    if (event.key === "Escape") {
      hideSuggest();
      return;
    }
    if (event.key === "Enter" && suggestEl && !suggestEl.hidden && suggestIndex >= 0) {
      event.preventDefault();
      chooseSuggestion(suggestions[suggestIndex]);
    }
  });
  input.addEventListener("blur", function () {
    setTimeout(hideSuggest, 150);
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    hideSuggest();
    trace(input.value);
  });

  if (printBtn) {
    printBtn.addEventListener("click", function () {
      const query = String(input.value || "").trim();
      if (!query) {
        setStatus("Enter a process sheet number.", true);
        return;
      }
      window.open("/api/process-sheet-trace/document?ps=" + encodeURIComponent(query), "_blank", "noopener");
    });
  }

  const initial = String(page.getAttribute("data-initial-ps") || "").trim();
  if (initial) trace(initial);
})();
