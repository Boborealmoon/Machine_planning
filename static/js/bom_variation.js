(function () {
  "use strict";

  const TABS = ["lookup", "bom-per-part", "bom-per-ps"];

  const COLS = {
    lookup: [
      "Part No",
      "Part Name",
      "BOM Code",
      "OP Description",
      "Required Quantity",
      "Material Inventory Code",
      "Material Description",
    ],
    "bom-per-part": [
      "Part No",
      "Part Name",
      "BOM Code",
      "OP No",
      "OP Description",
      "Inhouse Quantity",
      "Material Inventory Code",
      "Material Description",
    ],
    "bom-per-ps": [
      "Process Sheet",
      "Part No",
      "Part Name",
      "BOM Code",
      "OP No",
      "OP Description",
      "Inhouse Quantity",
      "Material Inventory Code",
      "Material Description",
    ],
  };

  const state = {
    lookup: { rows: [], filtered: [] },
    "bom-per-part": { rows: [], filtered: [], loaded: false },
    "bom-per-ps": { rows: [], filtered: [], loaded: false },
  };

  function el(id) {
    return document.getElementById(id);
  }

  // ── Tab switching ────────────────────────────────────────────────────────

  function switchTab(tab) {
    TABS.forEach(function (t) {
      var panel = el("bv-tab-" + t);
      var btn = document.querySelector('[data-bv-tab="' + t + '"]');
      if (panel) panel.hidden = t !== tab;
      if (btn) {
        btn.classList.toggle("is-active", t === tab);
        btn.setAttribute("aria-selected", t === tab ? "true" : "false");
      }
    });
  }

  // ── Shared utilities ─────────────────────────────────────────────────────

  function renderTable(tbodyId, rows, cols) {
    var tbody = el(tbodyId);
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = "";
      return;
    }
    var frag = document.createDocumentFragment();
    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      cols.forEach(function (col) {
        var td = document.createElement("td");
        var val = row[col];
        td.textContent = val === null || val === undefined ? "" : String(val);
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    });
    tbody.innerHTML = "";
    tbody.appendChild(frag);
  }

  function filterRows(rows, cols, term) {
    if (!term) return rows;
    var terms = term.split(/[,;\n]+/).map(function (t) { return t.trim().toLowerCase(); }).filter(Boolean);
    if (!terms.length) return rows;
    return rows.filter(function (row) {
      return terms.some(function (t) {
        return cols.some(function (col) {
          var val = row[col];
          return val !== null && val !== undefined && String(val).toLowerCase().includes(t);
        });
      });
    });
  }

  function updateStats(statsId, shown, total) {
    var statsEl = el(statsId);
    if (!statsEl) return;
    if (!total) {
      statsEl.textContent = "";
    } else if (shown === total) {
      statsEl.textContent = total.toLocaleString() + " rows";
    } else {
      statsEl.textContent = shown.toLocaleString() + " of " + total.toLocaleString() + " rows";
    }
  }

  function showError(errorId, msg) {
    var errEl = el(errorId);
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }
  }

  function clearError(errorId) {
    var errEl = el(errorId);
    if (errEl) {
      errEl.textContent = "";
      errEl.hidden = true;
    }
  }

  function exportCsv(rows, cols, filename) {
    if (!rows.length) return;
    var header = cols.map(function (c) { return '"' + c.replace(/"/g, '""') + '"'; }).join(",");
    var lines = rows.map(function (row) {
      return cols.map(function (col) {
        var val = row[col] === null || row[col] === undefined ? "" : String(row[col]);
        return '"' + val.replace(/"/g, '""') + '"';
      }).join(",");
    });
    var csv = [header].concat(lines).join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Tab 1: Lookup by Part No ─────────────────────────────────────────────

  function runLookup() {
    var input = el("bv-lookup-input");
    if (!input) return;
    var raw = input.value.trim();
    if (!raw) return;

    var partNos = raw
      .split(/[\n,;]+/)
      .map(function (s) { return s.trim().toUpperCase(); })
      .filter(Boolean);
    if (!partNos.length) return;

    clearError("bv-lookup-error");
    el("bv-lookup-results").hidden = true;
    el("bv-lookup-loading").hidden = false;

    var url = "/api/bom-variation/lookup?part_nos=" + encodeURIComponent(partNos.join(","));
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        el("bv-lookup-loading").hidden = true;
        if (data.error) {
          showError("bv-lookup-error", data.error);
          return;
        }
        state.lookup.rows = data.rows || [];
        var term = (el("bv-lookup-search") ? el("bv-lookup-search").value : "").trim();
        state.lookup.filtered = term ? filterRows(state.lookup.rows, COLS.lookup, term) : state.lookup.rows;
        renderTable("bv-lookup-tbody", state.lookup.filtered, COLS.lookup);
        updateStats("bv-lookup-stats", state.lookup.filtered.length, state.lookup.rows.length);
        var emptyEl = el("bv-lookup-empty");
        if (emptyEl) emptyEl.hidden = state.lookup.filtered.length > 0 || !state.lookup.rows.length;
        el("bv-lookup-results").hidden = false;
      })
      .catch(function (err) {
        el("bv-lookup-loading").hidden = true;
        showError("bv-lookup-error", "Request failed: " + err.message);
      });
  }

  // ── Tab 2: BOM Per Part ──────────────────────────────────────────────────

  function loadBomPerPart(refresh) {
    clearError("bv-bpp-error");
    var loadingEl = el("bv-bpp-loading");
    var resultsEl = el("bv-bpp-results");
    var loadBtn = el("bv-bpp-load");
    if (resultsEl) resultsEl.hidden = true;
    if (loadingEl) loadingEl.hidden = false;
    if (loadBtn) loadBtn.disabled = true;

    var url = "/api/bom-variation/bom-per-part" + (refresh ? "?refresh=1" : "");
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (loadingEl) loadingEl.hidden = true;
        if (loadBtn) { loadBtn.disabled = false; loadBtn.textContent = "Refresh"; }
        if (data.error) {
          showError("bv-bpp-error", data.error);
          return;
        }
        state["bom-per-part"].rows = data.rows || [];
        state["bom-per-part"].loaded = true;
        var term = (el("bv-bpp-search") ? el("bv-bpp-search").value : "").trim();
        state["bom-per-part"].filtered = term
          ? filterRows(state["bom-per-part"].rows, COLS["bom-per-part"], term)
          : state["bom-per-part"].rows;
        renderTable("bv-bpp-tbody", state["bom-per-part"].filtered, COLS["bom-per-part"]);
        updateStats("bv-bpp-stats", state["bom-per-part"].filtered.length, state["bom-per-part"].rows.length);
        var emptyEl = el("bv-bpp-empty");
        if (emptyEl) emptyEl.hidden = state["bom-per-part"].filtered.length > 0;
        if (resultsEl) resultsEl.hidden = false;
        var metaEl = el("bv-bpp-meta");
        if (metaEl && data.cached_at) {
          metaEl.textContent = "Cached at " + data.cached_at + " · TTL " + data.cache_ttl_sec + "s";
          metaEl.hidden = false;
        }
        var csvBtn = el("bv-bpp-csv");
        if (csvBtn) csvBtn.hidden = false;
      })
      .catch(function (err) {
        if (loadingEl) loadingEl.hidden = true;
        if (loadBtn) loadBtn.disabled = false;
        showError("bv-bpp-error", "Request failed: " + err.message);
      });
  }

  // ── Tab 3: BOM Per Process Sheet ─────────────────────────────────────────

  function loadBomPerPs(refresh) {
    clearError("bv-bpps-error");
    var loadingEl = el("bv-bpps-loading");
    var resultsEl = el("bv-bpps-results");
    var loadBtn = el("bv-bpps-load");
    if (resultsEl) resultsEl.hidden = true;
    if (loadingEl) loadingEl.hidden = false;
    if (loadBtn) loadBtn.disabled = true;

    var url = "/api/bom-variation/bom-per-ps" + (refresh ? "?refresh=1" : "");
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (loadingEl) loadingEl.hidden = true;
        if (loadBtn) { loadBtn.disabled = false; loadBtn.textContent = "Refresh"; }
        if (data.error) {
          showError("bv-bpps-error", data.error);
          return;
        }
        state["bom-per-ps"].rows = data.rows || [];
        state["bom-per-ps"].loaded = true;
        var term = (el("bv-bpps-search") ? el("bv-bpps-search").value : "").trim();
        state["bom-per-ps"].filtered = term
          ? filterRows(state["bom-per-ps"].rows, COLS["bom-per-ps"], term)
          : state["bom-per-ps"].rows;
        renderTable("bv-bpps-tbody", state["bom-per-ps"].filtered, COLS["bom-per-ps"]);
        updateStats("bv-bpps-stats", state["bom-per-ps"].filtered.length, state["bom-per-ps"].rows.length);
        var emptyEl = el("bv-bpps-empty");
        if (emptyEl) emptyEl.hidden = state["bom-per-ps"].filtered.length > 0;
        if (resultsEl) resultsEl.hidden = false;
        var metaEl = el("bv-bpps-meta");
        if (metaEl && data.cached_at) {
          metaEl.textContent = "Cached at " + data.cached_at + " · TTL " + data.cache_ttl_sec + "s";
          metaEl.hidden = false;
        }
        var csvBtn = el("bv-bpps-csv");
        if (csvBtn) csvBtn.hidden = false;
      })
      .catch(function (err) {
        if (loadingEl) loadingEl.hidden = true;
        if (loadBtn) loadBtn.disabled = false;
        showError("bv-bpps-error", "Request failed: " + err.message);
      });
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  function init() {
    // Tab buttons
    document.querySelectorAll("[data-bv-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () { switchTab(btn.dataset.bvTab); });
    });

    // Lookup: run button
    var lookupRunBtn = el("bv-lookup-run");
    if (lookupRunBtn) lookupRunBtn.addEventListener("click", runLookup);

    // Lookup: Ctrl+Enter in textarea
    var lookupInput = el("bv-lookup-input");
    if (lookupInput) {
      lookupInput.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") runLookup();
      });
    }

    // Lookup: search filter
    var lookupSearch = el("bv-lookup-search");
    if (lookupSearch) {
      lookupSearch.addEventListener("input", function () {
        var term = lookupSearch.value.trim();
        state.lookup.filtered = filterRows(state.lookup.rows, COLS.lookup, term);
        renderTable("bv-lookup-tbody", state.lookup.filtered, COLS.lookup);
        updateStats("bv-lookup-stats", state.lookup.filtered.length, state.lookup.rows.length);
        var emptyEl = el("bv-lookup-empty");
        if (emptyEl) emptyEl.hidden = state.lookup.filtered.length > 0 || !state.lookup.rows.length;
      });
    }

    // Lookup: CSV export
    var lookupCsvBtn = el("bv-lookup-csv");
    if (lookupCsvBtn) {
      lookupCsvBtn.addEventListener("click", function () {
        exportCsv(state.lookup.filtered, COLS.lookup, "bom_lookup.csv");
      });
    }

    // BOM Per Part: load/refresh button
    var bppLoadBtn = el("bv-bpp-load");
    if (bppLoadBtn) {
      bppLoadBtn.addEventListener("click", function () {
        loadBomPerPart(state["bom-per-part"].loaded);
      });
    }

    // BOM Per Part: search filter
    var bppSearch = el("bv-bpp-search");
    if (bppSearch) {
      bppSearch.addEventListener("input", function () {
        if (!state["bom-per-part"].loaded) return;
        var term = bppSearch.value.trim();
        state["bom-per-part"].filtered = filterRows(state["bom-per-part"].rows, COLS["bom-per-part"], term);
        renderTable("bv-bpp-tbody", state["bom-per-part"].filtered, COLS["bom-per-part"]);
        updateStats("bv-bpp-stats", state["bom-per-part"].filtered.length, state["bom-per-part"].rows.length);
        var emptyEl = el("bv-bpp-empty");
        if (emptyEl) emptyEl.hidden = state["bom-per-part"].filtered.length > 0;
      });
    }

    // BOM Per Part: CSV export
    var bppCsvBtn = el("bv-bpp-csv");
    if (bppCsvBtn) {
      bppCsvBtn.addEventListener("click", function () {
        exportCsv(state["bom-per-part"].filtered, COLS["bom-per-part"], "bom_per_part.csv");
      });
    }

    // BOM Per PS: load/refresh button
    var bppsLoadBtn = el("bv-bpps-load");
    if (bppsLoadBtn) {
      bppsLoadBtn.addEventListener("click", function () {
        loadBomPerPs(state["bom-per-ps"].loaded);
      });
    }

    // BOM Per PS: search filter
    var bppsSearch = el("bv-bpps-search");
    if (bppsSearch) {
      bppsSearch.addEventListener("input", function () {
        if (!state["bom-per-ps"].loaded) return;
        var term = bppsSearch.value.trim();
        state["bom-per-ps"].filtered = filterRows(state["bom-per-ps"].rows, COLS["bom-per-ps"], term);
        renderTable("bv-bpps-tbody", state["bom-per-ps"].filtered, COLS["bom-per-ps"]);
        updateStats("bv-bpps-stats", state["bom-per-ps"].filtered.length, state["bom-per-ps"].rows.length);
        var emptyEl = el("bv-bpps-empty");
        if (emptyEl) emptyEl.hidden = state["bom-per-ps"].filtered.length > 0;
      });
    }

    // BOM Per PS: CSV export
    var bppsCsvBtn = el("bv-bpps-csv");
    if (bppsCsvBtn) {
      bppsCsvBtn.addEventListener("click", function () {
        exportCsv(state["bom-per-ps"].filtered, COLS["bom-per-ps"], "bom_per_ps.csv");
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
