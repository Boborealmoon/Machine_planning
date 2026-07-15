(function () {
  "use strict";

  const PREFIX_ORDER = ["CHM", "T", "D", "DRL", "Other"];
  const PREFIX_RANK = Object.fromEntries(PREFIX_ORDER.map((p, i) => [p, i]));
  const SAFETY_FACTOR = 1.15;
  const DAYS_PER_MONTH = 30.4375;
  const DUE_SOON_RATIO = 0.85;

  const SORT_COLUMNS = [
    { key: "prefix", label: "Prefix", sort: "prefix" },
    { key: "item_code", label: "Item code", sort: "item_code" },
    { key: "item_description", label: "Description", sort: "item_description" },
    { key: "urgency", label: "Urgency", sort: "urgencyRank" },
    { key: "prCount", label: "PRs", sort: "prCount", num: true },
    { key: "avgQtyPerPr", label: "Avg qty / PR", sort: "avgQtyPerPr", num: true },
    { key: "avgMonthlyQty", label: "Avg qty / mo", sort: "avgMonthlyQty", num: true },
    { key: "avgCycleDays", label: "Avg cycle (d)", sort: "avgCycleDays", num: true },
    { key: "recommendedCycleQty", label: "Rec. qty / cycle", sort: "recommendedCycleQty", num: true },
    { key: "daysSince", label: "Days since", sort: "daysSince", num: true },
    { key: "nextDue", label: "Next due", sort: "nextDueTs" },
    { key: "leadTimeDays", label: "Lead time (d)", sort: "leadTimeDays", num: true },
    { key: "trend", label: "3m trend", sort: "trendRatio" },
    { key: "rejectRate", label: "Reject %", sort: "rejectRate", num: true },
  ];

  const state = {
    rows: [],
    statuses: [],
    sbuCodes: [],
    selectedSbu: new Set(["MFG"]),
    selectedStatus: new Set(),
    prefix: "ALL",
    focus: "all",
    search: "",
    sortKey: "avgMonthlyQty",
    sortDir: "desc",
    cachedAt: "",
    cacheTtlSec: 300,
    source: "",
    drillItem: null,
    lastItems: [],
  };

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
    const text = String(value).trim();
    return text ? text.slice(0, 10) : "—";
  }

  function fmtQty(value, digits = 1) {
    if (value === null || value === undefined || value === "") return "—";
    const num = Number(value);
    if (!Number.isFinite(num)) return escapeHtml(value);
    if (Number.isInteger(num)) return String(num);
    return num.toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function fmtPct(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    return `${Math.round(value * 100)}%`;
  }

  function parseDate(value) {
    if (!value) return null;
    const text = String(value).trim();
    if (!text) return null;
    const d = new Date(text.includes("T") ? text : text.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function toYmd(d) {
    if (!d) return "—";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function dayDiff(a, b) {
    const ms = a.getTime() - b.getTime();
    return Math.round(ms / 86400000);
  }

  function mean(nums) {
    if (!nums.length) return null;
    return nums.reduce((s, n) => s + n, 0) / nums.length;
  }

  function median(nums) {
    if (!nums.length) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function itemPrefix(itemCode) {
    const code = String(itemCode || "").trim().toUpperCase();
    if (!code) return "Other";
    if (code.startsWith("CHM")) return "CHM";
    if (code.startsWith("DRL")) return "DRL";
    // Pure DXXX / TXXX only (digits after the letter). TAP003, TG-182, DEB058, DI-11 → Other.
    if (/^D\d+$/.test(code)) return "D";
    if (/^T\d+$/.test(code)) return "T";
    return "Other";
  }

  function prefixClass(prefix) {
    return `pse-prefix pse-prefix--${String(prefix || "other").toLowerCase()}`;
  }

  function isRejected(status) {
    return String(status || "").toLowerCase().includes("reject");
  }

  function statusChipClass(status) {
    const s = String(status || "").toLowerCase();
    if (s.includes("reject")) return "pse-status-chip pse-status-chip--rejected";
    if (s.includes("draft")) return "pse-status-chip pse-status-chip--draft";
    if (s.includes("grn") || s.includes("arriv") || s.includes("complete")) {
      return "pse-status-chip pse-status-chip--grn";
    }
    if (s.includes("po") || s.includes("approv") || s.includes("confirm")) {
      return "pse-status-chip pse-status-chip--approved";
    }
    return "pse-status-chip";
  }

  function haystack(row) {
    return [
      row.item_code,
      row.item_description,
      row.line_item_description,
      row.status,
      row.project_no,
      row.purchase_requisition_no,
      row.purchase_order_no,
      row.supplier_code,
      row.sbu_code,
      row.grn_no,
      row.inventory_code,
    ]
      .filter((v) => v != null && String(v).trim() !== "")
      .join(" ")
      .toLowerCase();
  }

  function filteredRows() {
    const search = state.search.trim().toLowerCase();
    return state.rows.filter((row) => {
      const sbu = String(row.sbu_code || "").trim();
      if (state.selectedSbu.size && !state.selectedSbu.has(sbu)) return false;

      const status = String(row.status || "").trim();
      if (state.selectedStatus.size && !state.selectedStatus.has(status)) return false;

      if (state.prefix !== "ALL" && itemPrefix(row.item_code) !== state.prefix) return false;
      if (search && !haystack(row).includes(search)) return false;
      return true;
    });
  }

  function buildPrEvents(rows) {
    // Group qty by purchase_requisition_no + date for cycle gaps.
    const byPr = new Map();
    for (const row of rows) {
      if (isRejected(row.status)) continue;
      const prNo = String(row.purchase_requisition_no || "").trim() || `line:${row.no}`;
      const prDate = parseDate(row.pr_date);
      const qty = Number(row.qty);
      let event = byPr.get(prNo);
      if (!event) {
        event = { prNo, date: prDate, qty: 0 };
        byPr.set(prNo, event);
      }
      if (prDate && (!event.date || prDate < event.date)) event.date = prDate;
      if (Number.isFinite(qty)) event.qty += qty;
    }
    return Array.from(byPr.values())
      .filter((e) => e.date)
      .sort((a, b) => a.date - b.date);
  }

  function computeItemMetrics(agg, today) {
    const usable = agg.rows.filter((r) => !isRejected(r.status));
    const events = buildPrEvents(usable);

    let totalQty = 0;
    let rejectLines = 0;
    const leadTimes = [];
    const monthBuckets = new Map();
    const recentCutoff = new Date(today);
    recentCutoff.setMonth(recentCutoff.getMonth() - 3);
    const priorCutoff = new Date(today);
    priorCutoff.setMonth(priorCutoff.getMonth() - 6);
    let recentQty = 0;
    let priorQty = 0;

    for (const row of agg.rows) {
      if (isRejected(row.status)) {
        rejectLines += 1;
        continue;
      }
      const qty = Number(row.qty);
      const q = Number.isFinite(qty) ? qty : 0;
      totalQty += q;

      const prDate = parseDate(row.pr_date);
      if (prDate) {
        const key = `${prDate.getFullYear()}-${String(prDate.getMonth() + 1).padStart(2, "0")}`;
        monthBuckets.set(key, (monthBuckets.get(key) || 0) + q);
        if (prDate >= recentCutoff) recentQty += q;
        else if (prDate >= priorCutoff) priorQty += q;
      }

      const required = parseDate(row.required_arrival_date);
      const grn = parseDate(row.grn_date);
      const po = parseDate(row.po_date);
      const arrival = grn || required || po;
      if (prDate && arrival && arrival >= prDate) {
        leadTimes.push(dayDiff(arrival, prDate));
      }
    }

    const prCount = events.length;
    const firstPr = events.length ? events[0].date : null;
    const lastPr = events.length ? events[events.length - 1].date : null;

    const gaps = [];
    for (let i = 1; i < events.length; i += 1) {
      gaps.push(dayDiff(events[i].date, events[i - 1].date));
    }
    const avgCycleDays = gaps.length ? mean(gaps) : null;

    let spanMonths = 1;
    if (firstPr && lastPr) {
      const days = Math.max(1, dayDiff(lastPr, firstPr));
      spanMonths = Math.max(1, days / DAYS_PER_MONTH);
    }
    const occupiedMonths = Math.max(1, monthBuckets.size);
    // Multi-month history: average over occupied months. Thin history: span-based.
    const avgMonthly =
      monthBuckets.size >= 2 ? totalQty / occupiedMonths : prCount > 0 ? totalQty / spanMonths : null;

    const avgQtyPerPr = prCount > 0 ? totalQty / prCount : null;

    let recommendedCycleQty = null;
    if (avgMonthly != null && avgCycleDays != null && avgCycleDays > 0) {
      recommendedCycleQty = avgMonthly * (avgCycleDays / DAYS_PER_MONTH) * SAFETY_FACTOR;
    } else if (avgQtyPerPr != null) {
      recommendedCycleQty = avgQtyPerPr * SAFETY_FACTOR;
    }

    let daysSince = null;
    if (lastPr) {
      const last = new Date(lastPr);
      last.setHours(0, 0, 0, 0);
      daysSince = dayDiff(today, last);
    }

    let nextDue = null;
    let nextDueTs = null;
    if (lastPr && avgCycleDays != null) {
      nextDue = new Date(lastPr.getTime() + avgCycleDays * 86400000);
      nextDueTs = nextDue.getTime();
    }

    let urgency = "new";
    let urgencyRank = 3;
    if (prCount >= 2 && avgCycleDays != null && daysSince != null) {
      if (daysSince >= avgCycleDays) {
        urgency = "overdue";
        urgencyRank = 0;
      } else if (daysSince >= avgCycleDays * DUE_SOON_RATIO) {
        urgency = "due";
        urgencyRank = 1;
      } else {
        urgency = "ok";
        urgencyRank = 2;
      }
    } else if (prCount === 1 && daysSince != null && daysSince >= 90) {
      urgency = "due";
      urgencyRank = 1;
    }

    let trendRatio = null;
    let trend = "flat";
    if (priorQty > 0) {
      trendRatio = recentQty / priorQty;
      if (trendRatio >= 1.25) trend = "up";
      else if (trendRatio <= 0.8) trend = "down";
    } else if (recentQty > 0) {
      trendRatio = 2;
      trend = "up";
    }

    const rejectRate = agg.rows.length ? rejectLines / agg.rows.length : 0;

    return {
      ...agg,
      prCount,
      totalQty,
      firstPr,
      lastPr,
      avgQtyPerPr,
      avgMonthlyQty: avgMonthly,
      avgCycleDays,
      recommendedCycleQty,
      daysSince,
      nextDue,
      nextDueTs,
      leadTimeDays: mean(leadTimes),
      rejectRate,
      urgency,
      urgencyRank,
      trend,
      trendRatio,
      recentQty,
      priorQty,
      statusEntries: Array.from(agg.statusCounts.entries()).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      ),
    };
  }

  function aggregateByItem(rows) {
    const map = new Map();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const row of rows) {
      const itemCode = String(row.item_code || "").trim() || "(blank)";
      let agg = map.get(itemCode);
      if (!agg) {
        agg = {
          item_code: itemCode,
          item_description: row.item_description || "",
          prefix: itemPrefix(itemCode),
          lineCount: 0,
          statusCounts: new Map(),
          rows: [],
        };
        map.set(itemCode, agg);
      }
      if (!agg.item_description && row.item_description) {
        agg.item_description = row.item_description;
      }
      agg.lineCount += 1;
      const status = String(row.status || "").trim() || "(blank)";
      agg.statusCounts.set(status, (agg.statusCounts.get(status) || 0) + 1);
      agg.rows.push(row);
    }

    return Array.from(map.values()).map((agg) => computeItemMetrics(agg, today));
  }

  function applyFocus(items) {
    if (state.focus === "repeat") return items.filter((i) => i.prCount >= 2);
    if (state.focus === "overdue") return items.filter((i) => i.urgency === "overdue");
    if (state.focus === "due") return items.filter((i) => i.urgency === "due" || i.urgency === "overdue");
    if (state.focus === "highburn") {
      const burns = items.map((i) => i.avgMonthlyQty).filter((v) => v != null && v > 0).sort((a, b) => a - b);
      if (!burns.length) return items;
      const cutoff = burns[Math.floor(burns.length * 0.75)] || burns[burns.length - 1];
      return items.filter((i) => (i.avgMonthlyQty || 0) >= cutoff);
    }
    return items;
  }

  function sortItems(items) {
    const key = state.sortKey;
    const dir = state.sortDir === "asc" ? 1 : -1;
    return [...items].sort((a, b) => {
      let av = a[key];
      let bv = b[key];
      if (key === "prefix") {
        av = PREFIX_RANK[a.prefix] ?? 99;
        bv = PREFIX_RANK[b.prefix] ?? 99;
      }
      if (key === "item_code" || key === "item_description") {
        return dir * String(av || "").localeCompare(String(bv || ""), undefined, { sensitivity: "base" });
      }
      if (av == null && bv == null) {
        return a.item_code.localeCompare(b.item_code);
      }
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) {
        // Stable secondary: urgency then monthly burn.
        if (a.urgencyRank !== b.urgencyRank) return a.urgencyRank - b.urgencyRank;
        return (b.avgMonthlyQty || 0) - (a.avgMonthlyQty || 0);
      }
      return av < bv ? -dir : dir;
    });
  }

  function setDropdownLabel(btnId, selected, allLabel) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (!selected.size) {
      btn.textContent = `${allLabel} ▾`;
      return;
    }
    const values = Array.from(selected);
    btn.textContent = values.length <= 2 ? `${values.join(", ")} ▾` : `${values.length} selected ▾`;
  }

  function renderFilterPanels() {
    const sbuPanel = document.getElementById("pse-sbu-panel");
    const statusPanel = document.getElementById("pse-status-panel");
    if (sbuPanel) {
      const codes = state.sbuCodes.length ? state.sbuCodes : Array.from(state.selectedSbu);
      sbuPanel.innerHTML = codes
        .map((code) => {
          const checked = state.selectedSbu.has(code) ? "checked" : "";
          return `<label class="filter-dropdown-item"><input type="checkbox" value="${escapeHtml(code)}" ${checked} /> ${escapeHtml(code)}</label>`;
        })
        .join("");
    }
    if (statusPanel) {
      statusPanel.innerHTML = state.statuses
        .map((status) => {
          const checked = !state.selectedStatus.size || state.selectedStatus.has(status) ? "checked" : "";
          return `<label class="filter-dropdown-item"><input type="checkbox" value="${escapeHtml(status)}" ${checked} /> ${escapeHtml(status)}</label>`;
        })
        .join("");
    }
    setDropdownLabel("pse-sbu-btn", state.selectedSbu, "All SBUs");
    setDropdownLabel(
      "pse-status-btn",
      state.selectedStatus.size ? state.selectedStatus : new Set(),
      "All statuses"
    );

    const focusBtn = document.getElementById("pse-focus-btn");
    if (focusBtn) {
      const labels = {
        all: "All items",
        repeat: "Repeat buyers",
        overdue: "Overdue reorders",
        due: "Due soon",
        highburn: "High monthly burn",
      };
      focusBtn.textContent = `${labels[state.focus] || "All items"} ▾`;
    }

    const prefixWrap = document.getElementById("pse-prefix-filters");
    if (prefixWrap) {
      const options = ["ALL", ...PREFIX_ORDER];
      prefixWrap.innerHTML = options
        .map((p) => {
          const label = p === "ALL" ? "All" : p;
          const active = state.prefix === p ? "is-active" : "";
          return `<button type="button" class="pse-prefix-btn ${active}" data-prefix="${p}">${label}</button>`;
        })
        .join("");
    }
  }

  function urgencyBadge(item) {
    const labels = {
      overdue: "Overdue",
      due: "Due soon",
      ok: "On cycle",
      new: "Thin history",
    };
    return `<span class="pse-urgency pse-urgency--${item.urgency}">${labels[item.urgency] || item.urgency}</span>`;
  }

  function trendCell(item) {
    if (item.trend === "up") {
      return `<span class="pse-trend-up" title="Last 3 months vs prior 3 months">▲ ${fmtQty(item.recentQty, 0)} vs ${fmtQty(item.priorQty, 0)}</span>`;
    }
    if (item.trend === "down") {
      return `<span class="pse-trend-down" title="Last 3 months vs prior 3 months">▼ ${fmtQty(item.recentQty, 0)} vs ${fmtQty(item.priorQty, 0)}</span>`;
    }
    if (item.recentQty || item.priorQty) {
      return `<span class="pse-trend-flat">${fmtQty(item.recentQty, 0)} vs ${fmtQty(item.priorQty, 0)}</span>`;
    }
    return "—";
  }

  function renderKpis(items) {
    const el = document.getElementById("pse-kpis");
    if (!el) return;
    if (!items.length) {
      el.hidden = true;
      return;
    }
    const overdue = items.filter((i) => i.urgency === "overdue").length;
    const due = items.filter((i) => i.urgency === "due").length;
    const cycles = items.map((i) => i.avgCycleDays).filter((v) => v != null);
    const burns = items.map((i) => i.avgMonthlyQty).filter((v) => v != null);
    const topBurn = [...items]
      .filter((i) => i.avgMonthlyQty != null)
      .sort((a, b) => b.avgMonthlyQty - a.avgMonthlyQty)[0];

    el.hidden = false;
    el.innerHTML = `
      <div class="pse-kpi">
        <p class="pse-kpi-label">Items</p>
        <p class="pse-kpi-value">${items.length}</p>
        <p class="pse-kpi-hint">after filters</p>
      </div>
      <div class="pse-kpi ${overdue ? "pse-kpi--danger" : ""}">
        <p class="pse-kpi-label">Overdue reorders</p>
        <p class="pse-kpi-value">${overdue}</p>
        <p class="pse-kpi-hint">past avg cycle</p>
      </div>
      <div class="pse-kpi ${due ? "pse-kpi--warn" : ""}">
        <p class="pse-kpi-label">Due soon</p>
        <p class="pse-kpi-value">${due}</p>
        <p class="pse-kpi-hint">≥85% of cycle</p>
      </div>
      <div class="pse-kpi">
        <p class="pse-kpi-label">Median cycle</p>
        <p class="pse-kpi-value">${cycles.length ? fmtQty(median(cycles), 0) : "—"}</p>
        <p class="pse-kpi-hint">days between PRs</p>
      </div>
      <div class="pse-kpi">
        <p class="pse-kpi-label">Median monthly burn</p>
        <p class="pse-kpi-value">${burns.length ? fmtQty(median(burns), 1) : "—"}</p>
        <p class="pse-kpi-hint">qty / month</p>
      </div>
      <div class="pse-kpi pse-kpi--ok">
        <p class="pse-kpi-label">Top burner</p>
        <p class="pse-kpi-value" style="font-size:0.95rem">${topBurn ? escapeHtml(topBurn.item_code) : "—"}</p>
        <p class="pse-kpi-hint">${topBurn ? `${fmtQty(topBurn.avgMonthlyQty)} / mo` : "n/a"}</p>
      </div>
    `;
  }

  function renderStats(items, lineCount) {
    const el = document.getElementById("pse-stats");
    if (!el) return;
    const prTotal = items.reduce((sum, item) => sum + item.prCount, 0);
    el.innerHTML = `
      <span class="new-orders-stat"><strong>${items.length}</strong> items</span>
      <span class="new-orders-stat"><strong>${prTotal}</strong> PRs</span>
      <span class="new-orders-stat"><strong>${lineCount}</strong> lines</span>
    `;
  }

  function renderMeta() {
    const meta = document.getElementById("pse-meta");
    if (!meta) return;
    if (!state.cachedAt) {
      meta.hidden = true;
      return;
    }
    meta.hidden = false;
    meta.textContent = `Source: ${state.source || "pr_status_enquiry_view"} · cached ${state.cachedAt} · TTL ${state.cacheTtlSec}s · rejected PRs excluded from burn/cycle`;
  }

  function renderHead() {
    const head = document.getElementById("pse-head");
    if (!head) return;
    head.innerHTML = `<tr>${SORT_COLUMNS.map((col) => {
      const active = state.sortKey === col.sort;
      const arrow = active ? (state.sortDir === "asc" ? "▲" : "▼") : "↕";
      return `<th class="pse-sortable ${col.num ? "num" : ""}" data-sort="${col.sort}">
        ${escapeHtml(col.label)} <span class="pse-sort-ind ${active ? "is-active" : ""}">${arrow}</span>
      </th>`;
    }).join("")}</tr>`;
  }

  function renderTable() {
    const wrap = document.getElementById("pse-table-wrap");
    const body = document.getElementById("pse-body");
    const empty = document.getElementById("pse-empty");
    const emptyText = document.getElementById("pse-empty-text");
    if (!wrap || !body || !empty) return;

    const rows = filteredRows();
    let items = applyFocus(aggregateByItem(rows));
    items = sortItems(items);
    state.lastItems = items;

    renderHead();
    renderKpis(items);
    renderStats(items, rows.length);
    renderMeta();

    if (!state.rows.length) {
      wrap.hidden = true;
      empty.hidden = false;
      if (emptyText) emptyText.textContent = "No PR status rows returned from ERP.";
      return;
    }

    if (!items.length) {
      wrap.hidden = true;
      empty.hidden = false;
      if (emptyText) emptyText.textContent = "No items match your filters.";
      return;
    }

    wrap.hidden = false;
    empty.hidden = true;
    body.innerHTML = items
      .map(
        (item) => `<tr data-item="${escapeHtml(item.item_code)}">
          <td><span class="${prefixClass(item.prefix)}">${escapeHtml(item.prefix)}</span></td>
          <td><button type="button" class="pse-item-link" data-item="${escapeHtml(item.item_code)}">${escapeHtml(item.item_code)}</button></td>
          <td class="pse-desc" title="${escapeHtml(item.item_description)}">${escapeHtml(item.item_description) || "—"}</td>
          <td>${urgencyBadge(item)}</td>
          <td class="num">${item.prCount}</td>
          <td class="num">${fmtQty(item.avgQtyPerPr)}</td>
          <td class="num">${fmtQty(item.avgMonthlyQty)}</td>
          <td class="num">${fmtQty(item.avgCycleDays, 0)}</td>
          <td class="num"><strong>${fmtQty(item.recommendedCycleQty)}</strong></td>
          <td class="num">${item.daysSince == null ? "—" : item.daysSince}</td>
          <td>${item.nextDue ? toYmd(item.nextDue) : "—"}</td>
          <td class="num">${fmtQty(item.leadTimeDays, 0)}</td>
          <td>${trendCell(item)}</td>
          <td class="num">${fmtPct(item.rejectRate)}</td>
        </tr>`
      )
      .join("");
  }

  function openDrill(itemCode) {
    const item = state.lastItems.find((i) => i.item_code === itemCode);
    if (!item) return;

    state.drillItem = itemCode;
    const drill = document.getElementById("pse-drill");
    const title = document.getElementById("pse-drill-title");
    const sub = document.getElementById("pse-drill-sub");
    const metrics = document.getElementById("pse-drill-metrics");
    const body = document.getElementById("pse-drill-body");
    if (!drill || !title || !sub || !metrics || !body) return;

    title.textContent = item.item_code;
    const urgencyLabels = { overdue: "Overdue", due: "Due soon", ok: "On cycle", new: "Thin history" };
    sub.textContent = `${item.item_description || "No description"} · ${urgencyLabels[item.urgency] || item.urgency} · ${item.prCount} PR(s)`;

    metrics.innerHTML = [
      ["Avg qty / PR", fmtQty(item.avgQtyPerPr)],
      ["Avg qty / month", fmtQty(item.avgMonthlyQty)],
      ["Avg cycle (days)", fmtQty(item.avgCycleDays, 0)],
      ["Rec. qty / cycle", fmtQty(item.recommendedCycleQty)],
      ["Lead time (days)", fmtQty(item.leadTimeDays, 0)],
      ["Days since last", item.daysSince == null ? "—" : String(item.daysSince)],
      ["Next due", item.nextDue ? toYmd(item.nextDue) : "—"],
      ["Reject rate", fmtPct(item.rejectRate)],
    ]
      .map(
        ([label, value]) => `<div>
          <p class="pse-drill-metric-label">${escapeHtml(label)}</p>
          <p class="pse-drill-metric-value">${value}</p>
        </div>`
      )
      .join("");

    const sorted = [...item.rows].sort((a, b) => {
      const da = parseDate(a.pr_date);
      const db = parseDate(b.pr_date);
      if (da && db && da.getTime() !== db.getTime()) return db - da;
      return String(b.purchase_requisition_no || "").localeCompare(String(a.purchase_requisition_no || ""));
    });

    body.innerHTML = sorted
      .map(
        (row) => `<tr>
          <td>${escapeHtml(row.purchase_requisition_no) || "—"}</td>
          <td>${escapeHtml(row.pr_revision_no) || "—"}</td>
          <td><span class="${statusChipClass(row.status)}">${escapeHtml(row.status) || "—"}</span></td>
          <td>${fmtDate(row.pr_date)}</td>
          <td class="num">${fmtQty(row.qty)}</td>
          <td>${fmtDate(row.required_arrival_date)}</td>
          <td>${escapeHtml(row.purchase_order_no) || "—"}</td>
          <td>${escapeHtml(row.supplier_code) || "—"}</td>
          <td>${escapeHtml(row.project_no) || "—"}</td>
          <td>${escapeHtml(row.grn_no) || "—"}</td>
          <td class="pse-desc" title="${escapeHtml(row.line_item_description)}">${escapeHtml(row.line_item_description) || "—"}</td>
        </tr>`
      )
      .join("");

    drill.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeDrill() {
    const drill = document.getElementById("pse-drill");
    if (drill) drill.hidden = true;
    state.drillItem = null;
    document.body.style.overflow = "";
  }

  function wireDropdown(dropdownId, panelId, btnId, onChange) {
    const dropdown = document.getElementById(dropdownId);
    const panel = document.getElementById(panelId);
    const btn = document.getElementById(btnId);
    if (!dropdown || !panel || !btn) return;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = panel.hidden;
      document.querySelectorAll(".filter-dropdown-panel").forEach((p) => {
        p.hidden = true;
      });
      panel.hidden = !open;
    });

    panel.addEventListener("change", () => {
      onChange(panel);
      renderTable();
    });
  }

  async function load({ force = false } = {}) {
    const loading = document.getElementById("pse-loading");
    if (loading) loading.hidden = false;

    try {
      const url = force ? "/api/pr-status-enquiry?refresh=1" : "/api/pr-status-enquiry";
      const res = await fetch(url);
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch (_) {
        throw new Error(
          `API returned non-JSON (${res.status}). Restart the server if this page was just added.`
        );
      }
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      state.rows = Array.isArray(data.rows) ? data.rows : [];
      state.statuses = Array.isArray(data.statuses) ? data.statuses : [];
      state.sbuCodes = Array.isArray(data.sbu_codes) ? data.sbu_codes : [];
      state.cachedAt = data.cached_at || "";
      state.cacheTtlSec = data.cache_ttl_sec || 300;
      state.source = data.source || "";

      if (state.sbuCodes.includes("MFG") && !state.selectedSbu.size) {
        state.selectedSbu = new Set(["MFG"]);
      } else if (state.sbuCodes.length && ![...state.selectedSbu].some((c) => state.sbuCodes.includes(c))) {
        state.selectedSbu = state.sbuCodes.includes("MFG") ? new Set(["MFG"]) : new Set();
      }

      renderFilterPanels();
      renderTable();
    } catch (err) {
      state.rows = [];
      renderFilterPanels();
      renderTable();
      const emptyText = document.getElementById("pse-empty-text");
      if (emptyText) emptyText.textContent = err.message || "Failed to load tooling analytics.";
      const empty = document.getElementById("pse-empty");
      const wrap = document.getElementById("pse-table-wrap");
      const kpis = document.getElementById("pse-kpis");
      if (empty) empty.hidden = false;
      if (wrap) wrap.hidden = true;
      if (kpis) kpis.hidden = true;
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function init() {
    wireDropdown("pse-sbu-dropdown", "pse-sbu-panel", "pse-sbu-btn", (panel) => {
      const checked = Array.from(panel.querySelectorAll('input[type="checkbox"]:checked')).map((el) => el.value);
      state.selectedSbu = new Set(checked);
      setDropdownLabel("pse-sbu-btn", state.selectedSbu, "All SBUs");
    });

    wireDropdown("pse-status-dropdown", "pse-status-panel", "pse-status-btn", (panel) => {
      const checked = Array.from(panel.querySelectorAll('input[type="checkbox"]:checked')).map((el) => el.value);
      state.selectedStatus = checked.length === state.statuses.length ? new Set() : new Set(checked);
      setDropdownLabel(
        "pse-status-btn",
        state.selectedStatus.size ? state.selectedStatus : new Set(),
        "All statuses"
      );
    });

    wireDropdown("pse-focus-dropdown", "pse-focus-panel", "pse-focus-btn", (panel) => {
      const selected = panel.querySelector('input[name="pse-focus"]:checked');
      state.focus = selected ? selected.value : "all";
      renderFilterPanels();
    });

    document.getElementById("pse-prefix-filters")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-prefix]");
      if (!btn) return;
      state.prefix = btn.getAttribute("data-prefix") || "ALL";
      renderFilterPanels();
      renderTable();
    });

    document.getElementById("pse-search")?.addEventListener("input", (e) => {
      state.search = e.target.value || "";
      renderTable();
    });

    document.getElementById("pse-refresh")?.addEventListener("click", () => load({ force: true }));

    document.getElementById("pse-head")?.addEventListener("click", (e) => {
      const th = e.target.closest("[data-sort]");
      if (!th) return;
      const key = th.getAttribute("data-sort");
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = ["item_code", "item_description", "prefix", "nextDueTs"].includes(key) ? "asc" : "desc";
      }
      renderTable();
    });

    document.getElementById("pse-body")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-item]");
      if (!btn) return;
      openDrill(btn.getAttribute("data-item") || "");
    });

    document.getElementById("pse-drill")?.addEventListener("click", (e) => {
      if (e.target.closest("[data-action='close-drill']")) closeDrill();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDrill();
    });

    document.addEventListener("click", () => {
      document.querySelectorAll(".filter-dropdown-panel").forEach((p) => {
        p.hidden = true;
      });
    });

    document.querySelectorAll(".filter-dropdown").forEach((el) => {
      el.addEventListener("click", (e) => e.stopPropagation());
    });

    renderFilterPanels();
    load();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
