// Machine lane calculator — seed data from turnmill assignment spreadsheet.
(function () {
  "use strict";

  const MACHINES = [15, 31, 32, 39, 40];
  const SET_MULTIPLIERS = [30, 50, 100, 150, 240];
  const DEFAULT_SETS = 30;
  const BAR_COLORS = {
    15: "#0f766e",
    31: "#2563eb",
    32: "#7c3aed",
    39: "#0369a1",
    40: "#b91c1c",
  };

  /** Seed rows from the planning spreadsheet screenshot (durations computed at runtime). */
  const SEED = [
    { part_no: "BB18-KS1209-02", qty: 1, ct_tn: 120, ct_ml: 150, assign_tn: "", assign_ml: "", assign_tm: "39" },
    { part_no: "BB18-KS1211-04", qty: 1, ct_tn: 90, ct_ml: 150, assign_tn: "", assign_ml: "", assign_tm: "40" },
    { part_no: "BB18-KS1212-04", qty: 1, ct_tn: 120, ct_ml: 10, assign_tn: "", assign_ml: "", assign_tm: "39" },
    { part_no: "BB18-KS1213-02", qty: 4, ct_tn: 20, ct_ml: 6, assign_tn: "31", assign_ml: "", assign_tm: "" },
    { part_no: "BB18-KS1214-02", qty: 4, ct_tn: 7.5, ct_ml: 0, assign_tn: "32", assign_ml: "", assign_tm: "" },
    { part_no: "BB18-KS1215-02", qty: 1, ct_tn: 15, ct_ml: 0, assign_tn: "15", assign_ml: "", assign_tm: "" },
    { part_no: "BB18-KS1217-02", qty: 1, ct_tn: 80 / 3, ct_ml: 0, assign_tn: "15", assign_ml: "", assign_tm: "" },
    { part_no: "BB18-KS1218-01", qty: 1, ct_tn: 80 / 3, ct_ml: 0, assign_tn: "15", assign_ml: "", assign_tm: "" },
    { part_no: "BB18-KS1219-01", qty: 2, ct_tn: 0, ct_ml: 0, assign_tn: "", assign_ml: "", assign_tm: "" },
    { part_no: "BB18-KS1227-03", qty: 1, ct_tn: 30, ct_ml: 60, assign_tn: "", assign_ml: "", assign_tm: "40" },
    { part_no: "BB18-KS1227-04", qty: 1, ct_tn: 20, ct_ml: 0, assign_tn: "15", assign_ml: "", assign_tm: "" },
    { part_no: "BB18-KS1235-02", qty: 4, ct_tn: 20, ct_ml: 0, assign_tn: "32", assign_ml: "", assign_tm: "" },
    { part_no: "BB18-KS1299-02", qty: 1, ct_tn: 15, ct_ml: 6, assign_tn: "", assign_ml: "", assign_tm: "39" },
    { part_no: "BB18-KS1584-01", qty: 3, ct_tn: 15, ct_ml: 0, assign_tn: "31", assign_ml: "", assign_tm: "" },
    { part_no: "BB18-KS1584-02", qty: 2, ct_tn: 15, ct_ml: 0, assign_tn: "31", assign_ml: "", assign_tm: "" },
    { part_no: "BB18-KS1584-03", qty: 2, ct_tn: 15, ct_ml: 0, assign_tn: "31", assign_ml: "", assign_tm: "" },
    { part_no: "BB15-KS0001-01", qty: 1, ct_tn: 0, ct_ml: 0, assign_tn: "", assign_ml: "", assign_tm: "" },
    { part_no: "BB15-KS0009-07", qty: 1, ct_tn: 0, ct_ml: 0, assign_tn: "", assign_ml: "", assign_tm: "" },
  ];

  const state = {
    rows: cloneSeed(),
    search: "",
    sets: DEFAULT_SETS,
  };

  function cloneSeed() {
    return SEED.map((r) => ({ ...r }));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function fmt(value) {
    const n = num(value);
    if (Object.is(n, -0)) return "0";
    if (Number.isInteger(n)) return String(n);
    const rounded = Math.round(n * 100) / 100;
    return String(rounded);
  }

  function durationStats(minutes) {
    const min = num(minutes);
    return {
      min,
      hours: min / 60,
      days: min / 60 / 24,
    };
  }

  function fmtDurationLine(minutes) {
    const d = durationStats(minutes);
    return `${fmt(d.min)} min · ${fmt(d.hours)} hr · ${fmt(d.days)} days`;
  }

  function fmtDurationCard(minutes) {
    const d = durationStats(minutes);
    return `<strong>${escapeHtml(fmt(d.min))}</strong>
      <small>minutes</small>
      <div class="mlc-duration-sub">${escapeHtml(fmt(d.hours))} hr · ${escapeHtml(fmt(d.days))} days</div>`;
  }

  function machineKey(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    const n = Number(text);
    return Number.isFinite(n) ? String(n) : text;
  }

  function computeRow(row) {
    const qty = num(row.qty);
    const sets = num(state.sets);
    const pieces = qty * sets;
    const ctTn = num(row.ct_tn);
    const ctMl = num(row.ct_ml);
    const tnDur = pieces * ctTn;
    const mlDur = pieces * ctMl;
    const tmDur = tnDur + mlDur;
    const loads = Object.fromEntries(MACHINES.map((m) => [String(m), 0]));

    const aTn = machineKey(row.assign_tn);
    const aMl = machineKey(row.assign_ml);
    const aTm = machineKey(row.assign_tm);

    if (aTn && loads[aTn] !== undefined) loads[aTn] += tnDur;
    if (aMl && loads[aMl] !== undefined) loads[aMl] += mlDur;
    if (aTm && loads[aTm] !== undefined) loads[aTm] += tmDur;

    return {
      qty,
      sets,
      pieces,
      ctTn,
      ctMl,
      tnDur,
      mlDur,
      tmDur,
      loads,
      inactive: ctTn === 0 && ctMl === 0,
    };
  }

  function totals() {
    const out = Object.fromEntries(MACHINES.map((m) => [String(m), 0]));
    for (const row of state.rows) {
      const calc = computeRow(row);
      for (const m of MACHINES) out[String(m)] += calc.loads[String(m)];
    }
    return out;
  }

  function filteredRows() {
    const q = state.search.trim().toLowerCase();
    if (!q) return state.rows.map((row, index) => ({ row, index }));
    return state.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.part_no.toLowerCase().includes(q));
  }

  function assignOptions(selected) {
    const sel = machineKey(selected);
    const opts = ['<option value="">—</option>'].concat(
      MACHINES.map((m) => {
        const key = String(m);
        return `<option value="${key}"${key === sel ? " selected" : ""}>${key}</option>`;
      })
    );
    return opts.join("");
  }

  function renderTotals() {
    const el = document.getElementById("mlc-totals");
    const t = totals();
    const grand = MACHINES.reduce((sum, m) => sum + t[String(m)], 0);
    el.innerHTML =
      MACHINES.map((m) => {
        const key = String(m);
        return `<div class="mlc-total-card">
          <span>Machine ${escapeHtml(key)}</span>
          ${fmtDurationCard(t[key])}
        </div>`;
      }).join("") +
      `<div class="mlc-total-card">
        <span>All machines</span>
        ${fmtDurationCard(grand)}
      </div>`;
  }

  function renderLanes() {
    const el = document.getElementById("mlc-lanes");
    const maxTotal = Math.max(
      1,
      ...MACHINES.map((m) =>
        state.rows.reduce((sum, row) => sum + computeRow(row).loads[String(m)], 0)
      )
    );

    el.innerHTML = MACHINES.map((machine) => {
      const key = String(machine);
      const segments = state.rows
        .map((row) => {
          const calc = computeRow(row);
          const value = calc.loads[key];
          return value > 0 ? { part: row.part_no, value } : null;
        })
        .filter(Boolean);
      const laneTotal = segments.reduce((sum, s) => sum + s.value, 0);
      const bars =
        segments.length === 0
          ? `<div class="mlc-empty-lane">No load assigned</div>`
          : `<div class="mlc-bar-stack" style="width:${((laneTotal / maxTotal) * 100).toFixed(2)}%">
              ${segments
                .map((s) => {
                  const pct = (s.value / laneTotal) * 100;
                  return `<div class="mlc-bar" style="width:${pct.toFixed(3)}%;background:${BAR_COLORS[machine]}" title="${escapeHtml(s.part)}: ${escapeHtml(fmtDurationLine(s.value))}">
                    ${escapeHtml(s.part)}, ${escapeHtml(fmt(s.value))}
                  </div>`;
                })
                .join("")}
            </div>`;

      return `<section class="mlc-lane">
        <div class="mlc-lane-head">
          <h3>Machine lane ${escapeHtml(key)}</h3>
          <div class="mlc-lane-stats">
            <div>${escapeHtml(fmtDurationLine(laneTotal))}</div>
            <div>${segments.length} part${segments.length === 1 ? "" : "s"}</div>
          </div>
        </div>
        <div class="mlc-lane-track">${bars}</div>
      </section>`;
    }).join("");
  }

  function renderSets() {
    const chips = document.getElementById("mlc-sets-chips");
    const meta = document.getElementById("mlc-sets-meta");
    chips.innerHTML = SET_MULTIPLIERS.map((sets) => {
      const active = sets === state.sets ? " is-active" : "";
      return `<button type="button" class="mlc-set-chip${active}" data-sets="${sets}">${sets} sets</button>`;
    }).join("");
    meta.textContent = `Pieces = Qty/set × ${state.sets} sets`;
  }

  function renderTable() {
    const tbody = document.getElementById("mlc-tbody");
    const rows = filteredRows();
    document.getElementById("mlc-stats").textContent = `${rows.length} / ${state.rows.length} parts · ${state.sets} sets`;

    tbody.innerHTML = rows
      .map(({ row, index }) => {
        const calc = computeRow(row);
        const machineCells = MACHINES.map((m) => {
          const key = String(m);
          const value = calc.loads[key];
          const hit = value > 0 ? " is-hit" : "";
          return `<td class="mlc-machine-cell${hit}">${value > 0 ? escapeHtml(fmt(value)) : "—"}</td>`;
        }).join("");

        return `<tr class="${calc.inactive ? "mlc-row--zero" : ""}" data-index="${index}">
          <td class="mlc-part">${escapeHtml(row.part_no)}</td>
          <td>
            <input class="mlc-qty" type="number" min="0" step="1" data-field="qty" value="${escapeHtml(row.qty)}">
            <div class="mlc-pieces">${escapeHtml(fmt(calc.pieces))} pcs</div>
          </td>
          <td><input class="mlc-ct" type="number" min="0" step="any" data-field="ct_tn" value="${escapeHtml(row.ct_tn)}"></td>
          <td><input class="mlc-ct" type="number" min="0" step="any" data-field="ct_ml" value="${escapeHtml(row.ct_ml)}"></td>
          <td class="mlc-machine-cell">${escapeHtml(fmt(calc.tnDur))}</td>
          <td class="mlc-machine-cell">${escapeHtml(fmt(calc.mlDur))}</td>
          <td class="mlc-machine-cell">${escapeHtml(fmt(calc.tmDur))}</td>
          <td><select class="mlc-assign" data-field="assign_tn">${assignOptions(row.assign_tn)}</select></td>
          <td><select class="mlc-assign" data-field="assign_ml">${assignOptions(row.assign_ml)}</select></td>
          <td><select class="mlc-assign" data-field="assign_tm">${assignOptions(row.assign_tm)}</select></td>
          ${machineCells}
        </tr>`;
      })
      .join("");
  }

  function renderAll() {
    renderSets();
    renderTotals();
    renderLanes();
    renderTable();
  }

  function bind() {
    document.getElementById("mlc-search").addEventListener("input", (e) => {
      state.search = e.target.value || "";
      renderTable();
    });

    document.getElementById("mlc-sets-chips").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-sets]");
      if (!btn) return;
      const sets = num(btn.getAttribute("data-sets"));
      if (!SET_MULTIPLIERS.includes(sets)) return;
      state.sets = sets;
      renderAll();
    });

    document.getElementById("mlc-reset").addEventListener("click", () => {
      state.rows = cloneSeed();
      state.sets = DEFAULT_SETS;
      renderAll();
    });

    document.getElementById("mlc-swap-39-40").addEventListener("click", () => {
      for (const row of state.rows) {
        for (const field of ["assign_tn", "assign_ml", "assign_tm"]) {
          const v = machineKey(row[field]);
          if (v === "39") row[field] = "40";
          else if (v === "40") row[field] = "39";
        }
      }
      renderAll();
    });

    document.getElementById("mlc-tbody").addEventListener("change", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const field = target.getAttribute("data-field");
      if (!field) return;
      const tr = target.closest("tr[data-index]");
      if (!tr) return;
      const index = Number(tr.getAttribute("data-index"));
      if (!Number.isInteger(index) || !state.rows[index]) return;

      if (field.startsWith("assign_")) {
        state.rows[index][field] = target.value;
      } else {
        state.rows[index][field] = num(target.value);
      }
      renderAll();
    });

    document.getElementById("mlc-tbody").addEventListener("input", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      const field = target.getAttribute("data-field");
      if (!field || field.startsWith("assign_")) return;
      const tr = target.closest("tr[data-index]");
      if (!tr) return;
      const index = Number(tr.getAttribute("data-index"));
      if (!Number.isInteger(index) || !state.rows[index]) return;
      state.rows[index][field] = num(target.value);
      // Live refresh totals/lanes without full table rebuild (keeps focus).
      const calc = computeRow(state.rows[index]);
      const cells = tr.querySelectorAll("td");
      if (cells.length >= 15) {
        const piecesEl = cells[1].querySelector(".mlc-pieces");
        if (piecesEl) piecesEl.textContent = `${fmt(calc.pieces)} pcs`;
        cells[4].textContent = fmt(calc.tnDur);
        cells[5].textContent = fmt(calc.mlDur);
        cells[6].textContent = fmt(calc.tmDur);
        MACHINES.forEach((m, i) => {
          const value = calc.loads[String(m)];
          const cell = cells[10 + i];
          cell.textContent = value > 0 ? fmt(value) : "—";
          cell.classList.toggle("is-hit", value > 0);
        });
        tr.classList.toggle("mlc-row--zero", calc.inactive);
      }
      renderTotals();
      renderLanes();
    });
  }

  bind();
  renderAll();
})();
