(function () {
  const CYCLE_KEYS = [
    "mill_3axis", "mill_4axis", "mill_5axis", "mill_5axis_i800",
    "turn_quick", "turn_j200", "turn_i250",
    "edm_wirecut", "edm", "edm_superdrill",
    "backend_deburr", "backend_cleaning",
  ];

  const state = {
    payload: null,
    status: "all",
    query: "",
    openFiles: {},
  };

  const results = document.getElementById("ops-results");
  const alertBox = document.getElementById("ops-alert");
  const meta = document.getElementById("ops-meta");
  const scanBtn = document.getElementById("ops-scan");
  const modal = document.getElementById("ops-modal");

  document.getElementById("ops-search").addEventListener("input", function (event) {
    state.query = event.target.value || "";
    render();
  });
  document.getElementById("ops-status").addEventListener("change", function (event) {
    state.status = event.target.value;
    render();
  });
  scanBtn.addEventListener("click", scan);
  document.getElementById("ops-add-col").addEventListener("click", function () {
    modal.hidden = false;
    modal.querySelector("input[name=name]").focus();
  });
  document.getElementById("ops-col-cancel").addEventListener("click", closeModal);
  modal.addEventListener("click", function (event) {
    if (event.target === modal) closeModal();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !modal.hidden) closeModal();
  });
  document.getElementById("ops-col-form").addEventListener("submit", addColumn);
  results.addEventListener("input", onResultInput);
  results.addEventListener("change", onResultChange);
  results.addEventListener("click", onResultClick);

  load();

  function closeModal() {
    modal.hidden = true;
    document.getElementById("ops-col-form").reset();
  }

  async function load() {
    try {
      state.payload = await fetchJson("/api/ops-sheets");
      showAlert("");
      render();
    } catch (error) {
      showAlert(error.message);
      results.innerHTML = '<p class="ops-idle">The quote database could not be loaded.</p>';
    }
  }

  async function scan() {
    scanBtn.disabled = true;
    scanBtn.textContent = "Importing…";
    showAlert("");
    try {
      state.payload = await fetchJson("/api/ops-sheets/scan", { method: "POST" });
      render();
      const summary = state.payload.summary || {};
      const failed = (summary.errors || []).length;
      let message = "Imported " + (summary.lines || 0) + " parts from " + (summary.saved || 0) + " files into Supabase.";
      if (failed) {
        message += " " + failed + " file" + (failed === 1 ? "" : "s") + " could not be read.";
        showAlert(message + " " + summary.errors.map(function (item) {
          return item.file + ": " + item.error;
        }).join(" "));
      }
    } catch (error) {
      showAlert(error.message);
    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = "Import from RFQ folder";
    }
  }

  async function addColumn(event) {
    event.preventDefault();
    const form = event.target;
    try {
      state.payload = await fetchJson("/api/ops-sheets/columns", {
        method: "POST",
        body: JSON.stringify({ name: form.name.value, apply_mode: form.apply_mode.value }),
      });
      closeModal();
      showAlert("");
      render();
    } catch (error) {
      showAlert(error.message);
    }
  }

  function render() {
    const payload = state.payload;
    if (!payload) return;
    const scrollY = window.scrollY;
    const library = libraryLines();
    const query = state.query.trim();
    if (!query) {
      const files = {};
      library.forEach(function (line) { files[line.sheet_id] = true; });
      meta.textContent = countPhrase(library.length, "quoted part", "quoted parts") +
        " in " + countPhrase(Object.keys(files).length, "RFQ file", "RFQ files") + " · Supabase";
      results.innerHTML = '<div class="ops-idle"><p>Search a part, material, remark, quantity, or RFQ file.</p><p>The columns stay hidden until you tick Show line items on a file.</p></div>';
      window.scrollTo(0, scrollY);
      return;
    }
    const matched = library.filter(matchesQuery);
    const groups = groupLines(matched);
    meta.textContent = countPhrase(matched.length, "matching part", "matching parts") +
      " in " + countPhrase(groups.length, "RFQ file", "RFQ files") + " · Supabase";
    if (!groups.length) {
      results.innerHTML = '<p class="ops-idle">No quoted parts match that search.</p>';
      window.scrollTo(0, scrollY);
      return;
    }
    results.innerHTML = groups.map(fileCard).join("");
    window.scrollTo(0, scrollY);
  }

  function countPhrase(count, singular, plural) {
    return count + " " + (count === 1 ? singular : plural);
  }

  function libraryLines() {
    return (state.payload.lines || []).filter(function (line) {
      if (line.file_missing) return false;
      if (state.status === "all") return true;
      return line.status === state.status;
    });
  }

  function matchesQuery(line) {
    const query = state.query.trim().toLowerCase();
    if (!query) return false;
    return haystack(line).indexOf(query) !== -1;
  }

  function haystack(line) {
    const values = [
      line.part_number, line.description, line.rfq_qty_text, line.material_type,
      line.material_spec, line.raw_thk, line.raw_width, line.raw_length, line.setup_mins,
      line.fixture_required, line.engineering_remarks, line.nre_text,
      line.rfq_folder, line.file_name,
    ];
    CYCLE_KEYS.forEach(function (key) { values.push(line[key]); });
    return values.join(" ").toLowerCase();
  }

  function groupLines(lines) {
    const groups = [];
    const byId = {};
    lines.forEach(function (line) {
      if (!byId[line.sheet_id]) {
        byId[line.sheet_id] = {
          sheetId: line.sheet_id,
          fileName: line.file_name,
          folder: line.rfq_folder,
          dateIn: line.date_in,
          dateOut: line.date_out,
          status: line.status,
          lines: [],
        };
        groups.push(byId[line.sheet_id]);
      }
      byId[line.sheet_id].lines.push(line);
    });
    return groups;
  }

  function fileCard(group) {
    const open = !!state.openFiles[String(group.sheetId)];
    const head =
      '<header class="ops-file-head">' +
      '<label class="ops-show"><input type="checkbox" data-show-file="' + group.sheetId + '"' +
      (open ? " checked" : "") + "> Show line items</label>" +
      '<input class="ops-file-name" data-file-name="' + group.sheetId + '" value="' + esc(group.fileName) + '" aria-label="RFQ file name">' +
      '<span class="ops-file-meta">' + esc(group.folder) + "</span>" +
      '<span class="ops-file-meta">In ' + esc(fmtDate(group.dateIn)) + "</span>" +
      '<span class="ops-file-meta">Out ' + esc(fmtDate(group.dateOut)) + "</span>" +
      '<span class="ops-pill">' + esc(statusLabel(group.status)) + "</span>" +
      '<span class="ops-file-meta">' + group.lines.length + " matching</span>" +
      "</header>";
    const body = open ? tableHtml(group.lines) : hitList(group.lines);
    return '<section class="ops-file' + (open ? " ops-file--open" : "") + '">' + head + body + "</section>";
  }

  function hitList(lines) {
    const shown = lines.slice(0, 8).map(function (line) {
      const hours = line.tat && line.tat[0] ? fmtNum(line.tat[0].hours, 2) + " h" : "";
      return "<li><b>" + esc(line.part_number) + "</b> " + esc(line.description) +
        (hours ? " · " + esc(hours) : "") + "</li>";
    }).join("");
    const more = lines.length > 8 ? "<li>" + (lines.length - 8) + " more in this file</li>" : "";
    return '<ul class="ops-hit-list">' + shown + more + "</ul>";
  }

  function tableHtml(lines) {
    const columns = tableColumns(state.payload);
    const body = lines.map(function (line) {
      return '<tr data-line="' + line.line_id + '">' +
        columns.map(function (column) { return cellHtml(column, line); }).join("") +
        "</tr>";
    }).join("");
    return '<div class="ops-scroll"><table class="ops-table"><thead>' + headHtml(columns) +
      "</thead><tbody>" + body + "</tbody></table></div>";
  }

  function tableColumns(payload) {
    const source = payload.columns || [];
    const before = source.filter(function (column) { return column.section !== "after"; });
    const after = source.filter(function (column) { return column.section === "after"; });
    const extras = (payload.extra_columns || []).map(function (column) {
      return {
        key: "extra:" + column.column_id,
        label: column.name,
        group: "Added to TAT",
        kind: "extra",
        column: column,
      };
    });
    const calc = [
      { key: "ops", label: "Ops", group: "Turnaround", kind: "ops" },
      { key: "cycle_sum", label: "Cycle (mins)", group: "Turnaround", kind: "cycle" },
      { key: "tat_minutes", label: "TAT (mins)", group: "Turnaround", kind: "tat-min" },
      { key: "tat_hours", label: "TAT (hours)", group: "Turnaround", kind: "tat-h" },
    ];
    return before.concat(extras, calc, after);
  }

  function headHtml(columns) {
    return "<tr>" + columns.map(function (column) {
      return '<th class="' + headClass(column) + '">' + headLabel(column) + "</th>";
    }).join("") + "</tr>";
  }

  function headClass(column) {
    if (column.kind === "extra") return "ops-extra";
    if (column.group === "Turnaround") return "ops-tat";
    return "";
  }

  function headLabel(column) {
    if (column.kind !== "extra") {
      const group = column.group
        ? '<span class="ops-col-group">' + esc(column.group) + "</span>"
        : "";
      return group + esc(column.label);
    }
    const col = column.column;
    return (
      '<div class="ops-extra-head">' +
      '<span class="ops-col-group">Added to TAT</span>' +
      esc(col.name) +
      '<select data-col-mode="' + col.column_id + '" aria-label="How ' + esc(col.name) + ' is added">' +
      modeOption("per_piece", "× qty", col.apply_mode) +
      modeOption("per_operation", "× ops", col.apply_mode) +
      modeOption("flat", "flat", col.apply_mode) +
      "</select>" +
      '<button type="button" class="ops-linkish" data-col-remove="' + col.column_id + '">Remove</button>' +
      "</div>"
    );
  }

  function modeOption(value, label, current) {
    return '<option value="' + value + '"' + (value === current ? " selected" : "") + ">" + label + "</option>";
  }

  function cellHtml(column, line) {
    if (column.kind === "extra") {
      const value = line.extras ? line.extras[String(column.column.column_id)] : null;
      return (
        '<td class="ops-extra ops-num"><input class="ops-cell-input" type="number" min="0" step="any" ' +
        'data-extra="' + line.line_id + '" data-column="' + column.column.column_id + '" ' +
        'value="' + esc(value == null ? "" : value) + '" aria-label="' + esc(column.label) + '"></td>'
      );
    }
    if (column.kind === "ops") return opsCell(line);
    if (column.kind === "cycle") {
      return '<td class="ops-cycle ops-num" data-cycle="' + line.line_id + '">' + esc(fmtNum(line.cycle_sum, 1)) + "</td>";
    }
    if (column.kind === "tat-min" || column.kind === "tat-h") return tatCell(column, line);
    return fieldCell(column, line);
  }

  function fieldCell(column, line) {
    const raw = line[column.key];
    const value = raw == null ? "" : raw;
    if (column.kind === "number" || column.kind === "minutes") {
      return '<td class="ops-num"><input class="ops-cell-input" type="number" step="any" min="0" data-field="' +
        column.key + '" data-line="' + line.line_id + '" value="' + esc(value) + '" aria-label="' + esc(column.label) + '"></td>';
    }
    if (column.key === "engineering_remarks") {
      return '<td class="ops-remarks"><textarea data-field="engineering_remarks" data-line="' + line.line_id +
        '" aria-label="Engineering remarks">' + esc(value) + "</textarea></td>";
    }
    const wide = column.key === "description" || column.key === "material_spec" || column.key === "material_type";
    return '<td><input class="ops-cell-input ops-cell-text' + (wide ? " ops-input-wide" : "") +
      '" data-field="' + column.key + '" data-line="' + line.line_id + '" value="' + esc(value) +
      '" aria-label="' + esc(column.label) + '"></td>';
  }

  function opsCell(line) {
    const value = line.ops_override == null ? line.ops_auto : line.ops_override;
    const basis = line.ops_source === "override"
      ? "override"
      : (line.ops_basis === "remarks" ? "from remarks" : "from filled cycles");
    const reset = line.ops_override == null
      ? ""
      : '<button type="button" class="ops-linkish" data-ops-reset="' + line.line_id + '">Use auto (' + line.ops_auto + ")</button>";
    return (
      '<td class="ops-ops"><input type="number" min="0" max="999" step="1" data-ops="' + line.line_id + '" ' +
      'value="' + esc(value) + '" aria-label="Operations">' +
      '<span class="ops-ops-basis" data-ops-basis="' + line.line_id + '">' + esc(basis) + "</span>" +
      reset +
      "</td>"
    );
  }

  function tatCell(column, line) {
    const hours = column.kind === "tat-h";
    const breaks = line.tat || [];
    const html = breaks.map(function (item) {
      const number = hours ? fmtNum(item.hours, 2) : fmtNum(item.minutes, 1);
      const prefix = breaks.length > 1 && item.qty != null ? fmtNum(item.qty, 2) + " · " : "";
      return '<div class="ops-break" title="' + esc(item.detail || "") + '">' + esc(prefix + number) + "</div>";
    }).join("");
    const attr = hours ? "data-tat-h" : "data-tat-m";
    return '<td class="ops-tat ops-num" ' + attr + '="' + line.line_id + '">' + (html || "") + "</td>";
  }

  function onResultInput(event) {
    const ops = event.target.closest("[data-ops]");
    const extra = event.target.closest("[data-extra]");
    const field = event.target.closest("[data-field]");
    if (!ops && !extra && !field) return;
    const line = lineById(ops ? ops.dataset.ops : extra ? extra.dataset.extra : field.dataset.line);
    if (!line) return;
    if (ops) {
      line.ops_override = ops.value === "" ? null : Number(ops.value);
      line.ops_source = line.ops_override == null ? line.ops_basis : "override";
    } else if (extra) {
      line.extras = line.extras || {};
      line.extras[extra.dataset.column] = extra.value === "" ? null : Number(extra.value);
    } else if (field.dataset.field !== "engineering_remarks" && field.dataset.field !== "part_number") {
      const key = field.dataset.field;
      line[key] = field.value === "" ? null : (field.type === "number" ? Number(field.value) : field.value);
    }
    const preview = localTat(line);
    line.cycle_sum = preview.cycle_sum;
    line.tat = preview.breaks;
    line.ops_effective = preview.ops_effective;
    paintLine(line);
  }

  async function onResultChange(event) {
    const show = event.target.closest("[data-show-file]");
    if (show) {
      if (show.checked) state.openFiles[show.dataset.showFile] = true;
      else delete state.openFiles[show.dataset.showFile];
      render();
      return;
    }
    const fileName = event.target.closest("[data-file-name]");
    if (fileName) {
      await saveFileName(fileName);
      return;
    }
    const mode = event.target.closest("[data-col-mode]");
    if (mode) {
      try {
        state.payload = await fetchJson("/api/ops-sheets/columns/" + mode.dataset.colMode, {
          method: "PATCH",
          body: JSON.stringify({ apply_mode: mode.value }),
        });
        showAlert("");
        render();
      } catch (error) {
        showAlert(error.message);
      }
      return;
    }
    const ops = event.target.closest("[data-ops]");
    const extra = event.target.closest("[data-extra]");
    const field = event.target.closest("[data-field]");
    if (!ops && !extra && !field) return;
    try {
      let updated;
      if (ops) {
        updated = await fetchJson("/api/ops-sheets/lines/" + ops.dataset.ops, {
          method: "PATCH",
          body: JSON.stringify({ operation_count: ops.value === "" ? null : Number(ops.value) }),
        });
      } else if (extra) {
        updated = await fetchJson(
          "/api/ops-sheets/lines/" + extra.dataset.extra + "/extras/" + extra.dataset.column,
          {
            method: "PUT",
            body: JSON.stringify({ minutes: extra.value === "" ? null : Number(extra.value) }),
          }
        );
      } else {
        const body = {};
        body[field.dataset.field] = field.value;
        updated = await fetchJson("/api/ops-sheets/lines/" + field.dataset.line, {
          method: "PATCH",
          body: JSON.stringify({ fields: body }),
        });
      }
      replaceLine(updated.line);
      showAlert("");
    } catch (error) {
      showAlert(error.message);
    }
  }

  async function saveFileName(input) {
    try {
      const saved = await fetchJson("/api/ops-sheets/files/" + input.dataset.fileName, {
        method: "PATCH",
        body: JSON.stringify({ file_name: input.value }),
      });
      (state.payload.lines || []).forEach(function (line) {
        if (String(line.sheet_id) === String(saved.sheet_id)) line.file_name = saved.file_name;
      });
      input.value = saved.file_name;
      showAlert("");
    } catch (error) {
      showAlert(error.message);
    }
  }

  async function onResultClick(event) {
    const reset = event.target.closest("[data-ops-reset]");
    if (reset) {
      try {
        const updated = await fetchJson("/api/ops-sheets/lines/" + reset.dataset.opsReset, {
          method: "PATCH",
          body: JSON.stringify({ operation_count: null }),
        });
        replaceLine(updated.line);
        render();
      } catch (error) {
        showAlert(error.message);
      }
      return;
    }
    const button = event.target.closest("[data-col-remove]");
    if (!button) return;
    const column = (state.payload.extra_columns || []).find(function (item) {
      return String(item.column_id) === button.dataset.colRemove;
    });
    if (!column) return;
    if (!window.confirm("Remove the " + column.name + " column from the TAT measure?")) return;
    try {
      state.payload = await fetchJson("/api/ops-sheets/columns/" + column.column_id, { method: "DELETE" });
      showAlert("");
      render();
    } catch (error) {
      showAlert(error.message);
    }
  }

  function localTat(line) {
    let cycle = 0;
    CYCLE_KEYS.forEach(function (key) { cycle += Number(line[key]) || 0; });
    const setup = Number(line.setup_mins) || 0;
    const ops = line.ops_override == null || line.ops_override === ""
      ? Number(line.ops_auto) || 0
      : Number(line.ops_override) || 0;
    let perPiece = 0;
    let perOp = 0;
    let flat = 0;
    (state.payload.extra_columns || []).forEach(function (column) {
      const minutes = Number((line.extras || {})[String(column.column_id)]) || 0;
      if (!minutes) return;
      if (column.apply_mode === "per_operation") perOp += minutes;
      else if (column.apply_mode === "flat") flat += minutes;
      else perPiece += minutes;
    });
    const piece = cycle + perPiece;
    const operationPart = setup + perOp;
    const quantities = line.qty_breaks && line.qty_breaks.length ? line.qty_breaks : [line.rfq_qty];
    return {
      cycle_sum: cycle,
      ops_effective: ops,
      breaks: quantities.map(function (qty) {
        const qtyValue = Number(qty) || 0;
        const minutes = piece * qtyValue + operationPart * ops + flat;
        const bits = [trimNum(piece, 2) + " min × " + trimNum(qtyValue, 2)];
        if (operationPart || ops) bits.push(trimNum(operationPart, 2) + " min × " + ops + " ops");
        if (flat) bits.push(trimNum(flat, 2) + " min flat");
        return { qty: qty, minutes: minutes, hours: minutes / 60, detail: bits.join(" + ") };
      }),
    };
  }

  function paintLine(line) {
    const cycle = results.querySelector('[data-cycle="' + line.line_id + '"]');
    if (cycle) cycle.textContent = fmtNum(line.cycle_sum, 1);
    paintTat(line, "data-tat-m", false);
    paintTat(line, "data-tat-h", true);
    const basis = results.querySelector('[data-ops-basis="' + line.line_id + '"]');
    if (basis) {
      basis.textContent = line.ops_source === "override"
        ? "override"
        : (line.ops_basis === "remarks" ? "from remarks" : "from filled cycles");
    }
    const ops = results.querySelector('[data-ops="' + line.line_id + '"]');
    if (ops && document.activeElement !== ops) {
      ops.value = line.ops_override == null ? line.ops_auto : line.ops_override;
    }
  }

  function paintTat(line, attr, hours) {
    const cell = results.querySelector("[" + attr + '="' + line.line_id + '"]');
    if (!cell) return;
    const breaks = line.tat || [];
    cell.innerHTML = breaks.map(function (item) {
      const number = hours ? fmtNum(item.hours, 2) : fmtNum(item.minutes, 1);
      const prefix = breaks.length > 1 && item.qty != null ? fmtNum(item.qty, 2) + " · " : "";
      return '<div class="ops-break" title="' + esc(item.detail || "") + '">' + esc(prefix + number) + "</div>";
    }).join("");
  }

  function replaceLine(updated) {
    const lines = state.payload.lines || [];
    const index = lines.findIndex(function (line) { return line.line_id === updated.line_id; });
    if (index >= 0) lines[index] = updated;
    paintLine(updated);
  }

  function lineById(id) {
    return (state.payload.lines || []).find(function (line) { return String(line.line_id) === String(id); });
  }

  function statusLabel(status) {
    if (status === "completed") return "Completed";
    if (status === "archive") return "Archive";
    if (status === "template") return "Template";
    return "Current";
  }

  function fmtDate(value) {
    if (!value) return "—";
    const parts = String(value).slice(0, 10).split("-");
    if (parts.length !== 3) return value;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return Number(parts[2]) + " " + months[Number(parts[1]) - 1] + " " + parts[0];
  }

  function fmtNum(value, digits) {
    if (value == null || value === "" || !Number.isFinite(Number(value))) return "";
    return trimNum(Number(value), digits);
  }

  function trimNum(value, digits) {
    return Number(value).toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  function showAlert(message) {
    alertBox.hidden = !message;
    alertBox.textContent = message || "";
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, Object.assign({
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
    }, options || {}));
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok || data.ok === false) throw new Error(data.error || "Request failed");
    return data;
  }
})();
