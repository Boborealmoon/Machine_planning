const esoState = {
  loading: false,
  view: "machine",
  from: "",
  to: "",
  machine: "",
  search: "",
  data: null,
};

function esoEl(id) {
  return document.getElementById(id);
}

function esoEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function esoFormatQty(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return "0";
  if (Number.isInteger(num)) return String(num);
  return num.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function esoFormatDate(value) {
  const text = String(value || "").slice(0, 10);
  if (!text) return "-";
  const [year, month, day] = text.split("-");
  if (!year || !month || !day) return esoEscape(text);
  return `${day}/${month}/${year}`;
}

function esoFormatWhen(row) {
  const stamp = String(row?.scanned_at || "").trim();
  if (stamp.length >= 16) return `${esoFormatDate(stamp)} ${stamp.slice(11, 16)}`;
  return esoFormatDate(row?.scanned_date);
}

function esoIsoDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function esoDefaultRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 13);
  return { from: esoIsoDate(from), to: esoIsoDate(to) };
}

function esoQuery() {
  const params = new URLSearchParams();
  if (esoState.from) params.set("from", esoState.from);
  if (esoState.to) params.set("to", esoState.to);
  if (esoState.machine) params.set("machine_no", esoState.machine);
  if (esoState.search) params.set("search", esoState.search);
  return params.toString();
}

function esoSetAlert(message) {
  const el = esoEl("eso-alert");
  if (!el) return;
  if (!message) {
    el.textContent = "";
    esoSetHidden(el, true);
    return;
  }
  el.textContent = message;
  esoSetHidden(el, false);
}

function esoRenderKpi(stats) {
  const el = esoEl("eso-kpi");
  if (!el) return;
  const items = [
    ["Accepted qty jumped", esoFormatQty(stats?.qty_jump), "jump"],
    ["Jumps captured", esoFormatQty(stats?.jump_count), ""],
    ["Machines", esoFormatQty(stats?.machine_count), ""],
    ["Today's jump qty", esoFormatQty(stats?.today_qty_jump), "jump"],
  ];
  el.hidden = false;
  el.innerHTML = items.map(([label, value, kind]) => `
    <div class="eso-kpi-card${kind ? ` eso-kpi-card--${kind}` : ""}">
      <span class="eso-kpi-label">${esoEscape(label)}</span>
      <span class="eso-kpi-value">${esoEscape(value)}</span>
    </div>
  `).join("");
}

function esoBlank(value) {
  return value || "-";
}

function esoJumpCells(row) {
  const partial = row.pp_partial_no > 1
    ? `<span class="eso-sub">Partial ${esoEscape(row.pp_partial_no)}</span>`
    : "";
  const partDesc = row.part_desc ? `<span class="eso-sub">${esoEscape(row.part_desc)}</span>` : "";
  const stageDesc = row.stage_desc ? `<span class="eso-sub">${esoEscape(row.stage_desc)}</span>` : "";
  return `
    <td>
      ${esoEscape(esoFormatWhen(row))}
      <span class="eso-sub">Detected on ERP sync</span>
    </td>
    <td>
      ${esoEscape(esoBlank(row.source_mps_no))}
      ${partial}
    </td>
    <td>
      ${esoEscape(esoBlank(row.part_no))}
      ${partDesc}
    </td>
    <td>
      ${esoEscape(row.stage_no ? `OP${row.stage_no}` : "-")}
      ${stageDesc}
    </td>
    <td class="eso-num">${esoEscape(esoFormatQty(row.prev_acc_qty))}</td>
    <td class="eso-num">${esoEscape(esoFormatQty(row.new_acc_qty))}</td>
    <td class="eso-num eso-jump">+${esoEscape(esoFormatQty(row.qty_jump))}</td>
  `;
}

function esoJumpRows(jumps) {
  return (jumps || []).map((row) => `<tr>${esoJumpCells(row)}</tr>`).join("");
}

function esoTable(jumps) {
  return `
    <div class="eso-table-wrap">
      <table class="eso-table">
        <thead>
          <tr>
            <th>Scan date</th>
            <th>Process sheet</th>
            <th>Part</th>
            <th>Stage</th>
            <th class="eso-num">Prev qty</th>
            <th class="eso-num">New qty</th>
            <th class="eso-num">Jump</th>
          </tr>
        </thead>
        <tbody>${esoJumpRows(jumps) || `<tr><td colspan="7">No jumps.</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

function esoRenderMachines(machines) {
  const el = esoEl("eso-machine-view");
  if (!el) return;
  if (!machines?.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `<div class="eso-machine-list">${machines.map((machine) => {
    const unassigned = machine.machine_no === "Unassigned";
    return `
      <section class="eso-machine-card card${unassigned ? " eso-unassigned" : ""}">
        <div class="eso-machine-head">
          <span class="eso-machine-name">${esoEscape(machine.machine_no || "Unassigned")}</span>
          ${machine.machine_category ? `<span class="eso-pill">${esoEscape(machine.machine_category)}</span>` : ""}
          <span class="eso-pill eso-pill--qty">+${esoEscape(esoFormatQty(machine.qty_jump))}</span>
          <div class="eso-machine-stats">
            <span><strong>${esoEscape(esoFormatQty(machine.jump_count))}</strong> jumps</span>
          </div>
        </div>
        ${esoTable(machine.jumps)}
      </section>
    `;
  }).join("")}</div>`;
}

function esoRenderEvents(jumps) {
  const el = esoEl("eso-event-view");
  if (!el) return;
  if (!jumps?.length) {
    el.innerHTML = "";
    return;
  }
  const body = (jumps || []).map((row) => `
    <tr>
      <td>${esoEscape(row.machine_no || "Unassigned")}</td>
      ${esoJumpCells(row)}
    </tr>
  `).join("");
  el.innerHTML = `
    <section class="card eso-machine-card">
      <div class="eso-table-wrap">
        <table class="eso-table">
          <thead>
            <tr>
              <th>Machine</th>
              <th>Scan date</th>
              <th>Process sheet</th>
              <th>Part</th>
              <th>Stage</th>
              <th class="eso-num">Prev qty</th>
              <th class="eso-num">New qty</th>
              <th class="eso-num">Jump</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>
  `;
}

function esoFillMachines(options) {
  const select = esoEl("eso-machine");
  if (!select) return;
  const current = esoState.machine;
  const opts = ['<option value="">All machines</option>'].concat(
    (options || []).map((row) => {
      const value = row.machine_no || "Unassigned";
      const selected = value === current ? " selected" : "";
      return `<option value="${esoEscape(value)}"${selected}>${esoEscape(value)} (${esoEscape(esoFormatQty(row.qty_jump))})</option>`;
    })
  );
  select.innerHTML = opts.join("");
}

function esoSetHidden(el, hidden) {
  if (!el) return;
  el.hidden = Boolean(hidden);
  el.style.display = hidden ? "none" : "";
}

function esoRender() {
  const data = esoState.data || {};
  const jumps = data.jumps || [];
  const machines = data.machines || [];
  const empty = esoEl("eso-empty");
  const meta = esoEl("eso-meta");
  const loading = esoEl("eso-loading");
  const machineView = esoEl("eso-machine-view");
  const eventView = esoEl("eso-event-view");

  if (esoState.loading) {
    esoSetHidden(empty, true);
    esoSetHidden(loading, false);
    esoSetHidden(machineView, true);
    esoSetHidden(eventView, true);
    if (meta) meta.textContent = "Loading...";
    return;
  }

  esoSetHidden(loading, true);
  esoRenderKpi(data.stats || {});
  esoFillMachines(data.machine_options || []);
  if (meta) {
    if (!esoState.data) {
      meta.textContent = "Ready";
    } else {
      const loaded = data.loaded_at ? ` | ${data.loaded_at}` : "";
      meta.textContent = `${jumps.length} jump${jumps.length === 1 ? "" : "s"} | ${esoFormatDate(data.from_date)} - ${esoFormatDate(data.to_date)}${loaded}`;
    }
  }
  const hasRows = jumps.length > 0;
  esoSetHidden(empty, hasRows || Boolean(esoEl("eso-alert")?.textContent));
  esoSetHidden(machineView, esoState.view !== "machine" || !hasRows);
  esoSetHidden(eventView, esoState.view !== "events" || !hasRows);
  if (hasRows) {
    esoRenderMachines(machines);
    esoRenderEvents(jumps);
  } else {
    if (machineView) machineView.innerHTML = "";
    if (eventView) eventView.innerHTML = "";
  }
}

async function esoLoad() {
  if (esoState.loading) return;
  const loading = esoEl("eso-loading");
  const empty = esoEl("eso-empty");
  esoState.loading = true;
  esoSetHidden(loading, false);
  esoSetHidden(empty, true);
  esoSetHidden(esoEl("eso-machine-view"), true);
  esoSetHidden(esoEl("eso-event-view"), true);
  esoSetAlert("");
  if (esoEl("eso-meta")) esoEl("eso-meta").textContent = "Loading...";

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`/api/erp-scanned-output?${esoQuery()}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_parseErr) {
      throw new Error(`Load failed (${res.status})`);
    }
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `Load failed (${res.status})`);
    }
    esoState.data = data;
    if (data.from_date && esoEl("eso-from") && !esoEl("eso-from").value) {
      esoEl("eso-from").value = data.from_date;
      esoState.from = data.from_date;
    }
    if (data.to_date && esoEl("eso-to") && !esoEl("eso-to").value) {
      esoEl("eso-to").value = data.to_date;
      esoState.to = data.to_date;
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      esoSetAlert("Request timed out. Try a shorter date range or refresh after ERP sync.");
    } else {
      esoSetAlert(err?.message || "Failed to load scanned output.");
    }
  } finally {
    window.clearTimeout(timer);
    esoState.loading = false;
    esoRender();
  }
}

function esoCsvValue(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function esoExport() {
  const jumps = esoState.data?.jumps || [];
  if (!jumps.length) return;
  const header = [
    "scan_date", "scanned_at", "machine_no", "source_mps_no", "pp_partial_no",
    "part_no", "part_desc", "stage_no", "stage_desc", "prev_acc_qty", "new_acc_qty", "qty_jump",
  ];
  const lines = [header.join(",")].concat(jumps.map((row) => header.map((key) => esoCsvValue(row[key])).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `erp-scanned-output-${esoState.from || "from"}-${esoState.to || "to"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function esoInitDates() {
  const range = esoDefaultRange();
  esoState.from = range.from;
  esoState.to = range.to;
  const fromEl = esoEl("eso-from");
  const toEl = esoEl("eso-to");
  if (fromEl) fromEl.value = range.from;
  if (toEl) toEl.value = range.to;
}

function esoBind() {
  esoEl("eso-refresh")?.addEventListener("click", () => esoLoad());
  esoEl("eso-export")?.addEventListener("click", () => esoExport());
  esoEl("eso-from")?.addEventListener("change", (ev) => {
    esoState.from = ev.target.value;
    esoLoad();
  });
  esoEl("eso-to")?.addEventListener("change", (ev) => {
    esoState.to = ev.target.value;
    esoLoad();
  });
  esoEl("eso-machine")?.addEventListener("change", (ev) => {
    esoState.machine = ev.target.value;
    esoLoad();
  });
  let searchTimer = 0;
  esoEl("eso-search")?.addEventListener("input", (ev) => {
    esoState.search = ev.target.value.trim();
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => esoLoad(), 250);
  });
  document.querySelectorAll("[data-eso-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      esoState.view = btn.getAttribute("data-eso-view") || "machine";
      document.querySelectorAll("[data-eso-view]").forEach((el) => {
        const on = el === btn;
        el.classList.toggle("is-active", on);
        el.setAttribute("aria-selected", on ? "true" : "false");
      });
      esoRender();
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  esoInitDates();
  esoBind();
  esoLoad();
});
