(function () {
  "use strict";

  function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtDate(value) {
    if (!value) return "—";
    return String(value).slice(0, 10) || "—";
  }

  function fmtQty(value) {
    if (value === null || value === undefined || value === "") return "—";
    const num = Number(value);
    if (!Number.isFinite(num)) return escapeHtml(value);
    return Number.isInteger(num) ? String(num) : num.toFixed(2);
  }

  function dueCell(row) {
    return row.overdue
      ? `<span class="pending-pp-due-late">${fmtDate(row.due_date)}</span>`
      : fmtDate(row.due_date);
  }

  function partBadges(row) {
    let out = "";
    if (row.is_new_part) {
      out += ` <span class="pending-pp-new-badge" title="New part — no prior production history">NEW</span>`;
    }
    if (row.is_frame_agreement) {
      out += ` <span class="pending-pp-fa-badge" title="Frame agreement part">FA</span>`;
    }
    return out;
  }

  function partCell(row) {
    const rawCode = String(row.inventory_code || "").trim();
    const code = escapeHtml(row.inventory_code);
    const badges = partBadges(row);
    if (!rawCode) return code + badges;
    const psNo = escapeHtml(row.pp_voucher_no || "");
    return `<button type="button" class="pending-pp-part-link" data-part="${escapeHtml(
      rawCode
    )}" data-ps="${psNo}" title="View BOM materials & inventory balance">${code}</button>${badges}`;
  }

  const NUMERIC = { align: "num", numeric: true };

  // Column definitions per tab. `render` defaults to escaped text of row[key].
  const TAB_COLUMNS = {
    "no-pp": [
      { key: "sales_order_no", label: "Sales order", side: true },
      { key: "line_item_no", label: "Line" },
      { key: "inventory_code", label: "Part", render: partCell },
      { key: "description", label: "Description", desc: true },
      { key: "customer_name", label: "Customer" },
      { key: "customer_po_no", label: "Customer PO" },
      { key: "order_date", label: "Order date", render: (r) => fmtDate(r.order_date) },
      { key: "due_date", label: "Due date", render: dueCell },
      { key: "remaining_qty", label: "Remaining", ...NUMERIC, render: (r) => fmtQty(r.remaining_qty) },
    ],
    "no-wo": [
      { key: "sales_order_no", label: "Sales order", side: true },
      { key: "pp_voucher_no", label: "PP voucher" },
      { key: "inventory_code", label: "Part", render: partCell },
      { key: "description", label: "Description", desc: true },
      { key: "customer_name", label: "Customer" },
      { key: "customer_po_no", label: "Customer PO" },
      { key: "due_date", label: "Due date", render: dueCell },
      { key: "proposed_edd", label: "Proposed EDD", render: (r) => fmtDate(r.proposed_edd) },
      { key: "pp_qty", label: "PP qty", ...NUMERIC, render: (r) => fmtQty(r.pp_qty) },
    ],
  };

  const TAB_DESC = {
    "no-pp":
      "Open sales-order lines with <strong>no PP voucher raised yet</strong> — the process sheet has not been created. Excludes voided and fully-shipped lines.",
    "no-wo":
      "PP vouchers with <strong>no work order raised yet</strong> — the process sheet exists but no WO has been cut. Excludes fully-shipped lines.",
  };

  const TAB_EMPTY = {
    "no-pp": "Every open sales-order line already has a PP voucher. Nothing stuck.",
    "no-wo": "Every PP voucher already has a work order. Nothing stuck.",
  };

  const ALL_PS_TYPES = ["MPS", "APS", "NPS", "SR", "PPS", "CPS"];

  function getPsType(row) {
    const raw = String(row.pp_voucher_no || "").split("::")[0];
    if (!raw) return null;
    if (/\[sr\]/i.test(raw)) return "SR";
    const m = raw.toUpperCase().match(/^([A-Z]+)/);
    return m ? m[1] : null;
  }

  const state = {
    tab: "no-pp",
    rowsByTab: { "no-pp": [], "no-wo": [] },
    metaByTab: { "no-pp": null, "no-wo": null },
    search: "",
    overdueOnly: false,
    psTypes: new Set(["APS", "NPS"]),
    sort: {
      "no-pp": { key: "due_date", dir: "asc" },
      "no-wo": { key: "due_date", dir: "asc" },
    },
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function currentColumns() {
    return TAB_COLUMNS[state.tab];
  }

  function colByKey(key) {
    return currentColumns().find((c) => c.key === key);
  }

  function compareRows(a, b) {
    const { key, dir } = state.sort[state.tab];
    const col = colByKey(key);
    const mul = dir === "desc" ? -1 : 1;
    let av = a[key];
    let bv = b[key];
    if (col && col.numeric) {
      av = av == null ? -Infinity : Number(av);
      bv = bv == null ? -Infinity : Number(bv);
      return (av - bv) * mul;
    }
    av = (av == null ? "" : String(av)).toLowerCase();
    bv = (bv == null ? "" : String(bv)).toLowerCase();
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return 0;
  }

  function matchesSearch(row) {
    if (!state.search) return true;
    const needle = state.search.toLowerCase();
    const haystack = [
      row.sales_order_no,
      row.pp_voucher_no,
      row.line_item_no,
      row.inventory_code,
      row.description,
      row.customer_name,
      row.customer_code,
      row.customer_po_no,
      row.sales_person_name,
      row.sbu_desc,
    ]
      .map((v) => (v == null ? "" : String(v)))
      .join(" ")
      .toLowerCase();
    return haystack.indexOf(needle) !== -1;
  }

  function matchesPsType(row) {
    // PS-type classification only applies where a PP voucher exists (no-wo tab).
    if (state.tab !== "no-wo") return true;
    if (state.psTypes.size >= ALL_PS_TYPES.length) return true;
    const t = getPsType(row);
    if (!t) return true;
    return state.psTypes.has(t);
  }

  function visibleRows() {
    return state.rowsByTab[state.tab]
      .filter(
        (row) =>
          (!state.overdueOnly || row.overdue) &&
          matchesPsType(row) &&
          matchesSearch(row)
      )
      .slice()
      .sort(compareRows);
  }

  function renderHead() {
    const { key, dir } = state.sort[state.tab];
    els.head.innerHTML =
      "<tr>" +
      currentColumns()
        .map((col) => {
          const cls = [];
          if (col.side) cls.push("new-orders-side-head");
          if (col.desc) cls.push("new-orders-desc-head");
          if (col.align === "num") cls.push("pending-pp-num");
          cls.push("is-sortable");
          if (col.key === key) cls.push("is-sorted");
          const sortDir = col.key === key ? dir : "";
          return `<th class="${cls.join(" ")}" data-sort="${col.key}" data-sort-dir="${sortDir}">${escapeHtml(
            col.label
          )}</th>`;
        })
        .join("") +
      "</tr>";
    els.head.querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const k = th.getAttribute("data-sort");
        const s = state.sort[state.tab];
        if (s.key === k) {
          s.dir = s.dir === "asc" ? "desc" : "asc";
        } else {
          s.key = k;
          s.dir = "asc";
        }
        render();
      });
    });
  }

  function rowHtml(row) {
    const cls = row.overdue ? "pending-pp-row--overdue" : "";
    const cells = currentColumns()
      .map((col) => {
        const tdCls = [];
        if (col.side) tdCls.push("new-orders-side-head");
        if (col.desc) tdCls.push("new-orders-desc-head");
        if (col.align === "num") tdCls.push("pending-pp-num");
        const content = col.render ? col.render(row) : escapeHtml(row[col.key]);
        return `<td class="${tdCls.join(" ")}">${content}</td>`;
      })
      .join("");
    return `<tr class="${cls}">${cells}</tr>`;
  }

  function renderStats(shown) {
    const meta = state.metaByTab[state.tab];
    if (!meta) {
      els.stats.textContent = "";
      return;
    }
    const parts = [
      `<strong>${shown}</strong> shown`,
      `${meta.count} rows`,
      `${meta.so_count} orders`,
    ];
    if (meta.overdue_count) {
      parts.push(`<span class="pending-pp-overdue-stat">${meta.overdue_count} overdue</span>`);
    }
    els.stats.innerHTML = parts.join(" · ");
  }

  function renderTabCounts() {
    document.querySelectorAll(".pending-pp-tab-count").forEach((span) => {
      const tab = span.getAttribute("data-count");
      const meta = state.metaByTab[tab];
      span.textContent = meta ? `(${meta.count})` : "";
    });
  }

  function psTypeLabel() {
    const checked = [...state.psTypes];
    if (!checked.length) return "None";
    if (checked.length >= ALL_PS_TYPES.length) return "All types";
    return ALL_PS_TYPES.filter((t) => state.psTypes.has(t)).join(", ");
  }

  function render() {
    els.desc.innerHTML = TAB_DESC[state.tab];
    if (els.psTypeWrap) els.psTypeWrap.hidden = state.tab !== "no-wo";
    const rows = visibleRows();
    renderHead();
    renderStats(rows.length);
    renderTabCounts();

    const total = state.rowsByTab[state.tab].length;
    if (!total) {
      els.tableWrap.hidden = true;
      els.empty.hidden = false;
      els.emptyText.textContent = TAB_EMPTY[state.tab];
    } else if (!rows.length) {
      els.tableWrap.hidden = true;
      els.empty.hidden = false;
      els.emptyText.textContent = "No rows match your filters.";
    } else {
      els.empty.hidden = true;
      els.tableWrap.hidden = false;
      els.body.innerHTML = rows.map(rowHtml).join("");
    }

    const meta = state.metaByTab[state.tab];
    if (meta) {
      els.meta.hidden = false;
      els.meta.textContent = `Source: ${meta.source} · cached at ${meta.cached_at} (${Math.round(
        meta.cache_ttl_sec / 60
      )} min TTL)`;
    } else {
      els.meta.hidden = true;
    }
  }

  async function load(tab, refresh) {
    els.loading.hidden = false;
    els.tableWrap.hidden = true;
    els.empty.hidden = true;
    try {
      const res = await fetch(
        `/api/pending-pp?tab=${encodeURIComponent(tab)}${refresh ? "&refresh=1" : ""}`,
        { headers: { Accept: "application/json" } }
      );
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      state.rowsByTab[tab] = data.rows || [];
      state.metaByTab[tab] = {
        source: data.source,
        count: data.count,
        so_count: data.so_count,
        overdue_count: data.overdue_count,
        cached_at: data.cached_at,
        cache_ttl_sec: data.cache_ttl_sec,
      };
    } catch (err) {
      state.rowsByTab[tab] = [];
      state.metaByTab[tab] = null;
      if (tab === state.tab) {
        els.empty.hidden = false;
        els.emptyText.textContent = `Failed to load: ${err.message}`;
      }
    } finally {
      els.loading.hidden = true;
      if (tab === state.tab) render();
      else renderTabCounts();
    }
  }

  function switchTab(tab) {
    if (tab === state.tab) return;
    state.tab = tab;
    document.querySelectorAll(".pending-pp-tab").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-tab") === tab);
    });
    if (state.metaByTab[tab]) {
      render();
    } else {
      load(tab, false);
    }
  }

  function copySalesOrders() {
    const seen = [];
    visibleRows().forEach((row) => {
      const so = row.sales_order_no;
      if (so && seen.indexOf(so) === -1) seen.push(so);
    });
    const text = seen.join("\n");
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => flashButton(els.copySo, "Copied!"),
      () => flashButton(els.copySo, "Copy failed")
    );
  }

  function flashButton(btn, label) {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = label;
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  }

  function bind() {
    els.search.addEventListener("input", (e) => {
      state.search = e.target.value.trim();
      render();
    });
    els.overdue.addEventListener("change", (e) => {
      state.overdueOnly = e.target.checked;
      render();
    });
    els.refresh.addEventListener("click", () => load(state.tab, true));
    els.copySo.addEventListener("click", copySalesOrders);
    document.querySelectorAll(".pending-pp-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.getAttribute("data-tab")));
    });
    els.body.addEventListener("click", (e) => {
      const link = e.target.closest(".pending-pp-part-link");
      if (!link) return;
      const partNo = link.getAttribute("data-part");
      if (partNo && typeof window.openMaterialModal === "function") {
        window.openMaterialModal({
          partNo,
          processSheetNo: link.getAttribute("data-ps") || "",
        });
      }
    });
    bindPsTypeDropdown();
  }

  function bindPsTypeDropdown() {
    const btn = $("pp-ps-type-btn");
    const panel = $("pp-ps-type-panel");
    if (!btn || !panel) return;

    const syncLabel = () => {
      btn.textContent = `${psTypeLabel()} ▾`;
    };
    syncLabel();

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
    });
    document.addEventListener("click", (e) => {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) {
        panel.hidden = true;
      }
    });
    panel.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", () => {
        state.psTypes = new Set(
          [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(
            (el) => el.value
          )
        );
        syncLabel();
        render();
      });
    });
  }

  function init() {
    els.loading = $("pending-pp-loading");
    els.tableWrap = $("pending-pp-table-wrap");
    els.head = $("pending-pp-head");
    els.body = $("pending-pp-body");
    els.empty = $("pending-pp-empty");
    els.emptyText = $("pending-pp-empty-text");
    els.meta = $("pending-pp-meta");
    els.stats = $("pending-pp-stats");
    els.desc = $("pending-pp-desc");
    els.search = $("pending-pp-search");
    els.psTypeWrap = $("pending-pp-ps-type-wrap");
    els.overdue = $("pending-pp-overdue-only");
    els.refresh = $("pending-pp-refresh");
    els.copySo = $("pending-pp-copy-so");
    bind();
    load("no-pp", false);
    load("no-wo", false); // preload count for the second tab
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
