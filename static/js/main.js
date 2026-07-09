// Mobile navigation drawer
(function initMobileNav() {
  const nav = document.getElementById("site-navbar");
  const btn = document.getElementById("navbar-menu-btn");
  const backdrop = document.getElementById("navbar-backdrop");
  const panel = document.getElementById("navbar-nav-panel");
  if (!nav || !btn || !panel) return;

  const mq = window.matchMedia("(max-width: 1024px)");

  const closeMenu = () => {
    nav.classList.remove("is-menu-open");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Open navigation menu");
    document.body.classList.remove("navbar-menu-open");
    if (backdrop) backdrop.hidden = true;
  };

  const openMenu = () => {
    if (!mq.matches) return;
    nav.classList.add("is-menu-open");
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-label", "Close navigation menu");
    document.body.classList.add("navbar-menu-open");
    if (backdrop) backdrop.hidden = false;
  };

  btn.addEventListener("click", () => {
    if (nav.classList.contains("is-menu-open")) closeMenu();
    else openMenu();
  });

  backdrop?.addEventListener("click", closeMenu);

  panel.querySelectorAll(".nav-link, .nav-dropdown-item").forEach((el) => {
    el.addEventListener("click", closeMenu);
  });

  mq.addEventListener("change", (e) => {
    if (!e.matches) closeMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
})();

// Navbar dropdowns
document.querySelectorAll(".nav-dropdown-trigger").forEach((trigger) => {
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = trigger.dataset.dropdown;
    const menu = document.getElementById("dd-" + id);
    const isOpen = menu.classList.contains("open");

    // Close all
    document.querySelectorAll(".nav-dropdown-menu").forEach((m) =>
      m.classList.remove("open")
    );

    if (!isOpen) menu.classList.add("open");
  });
});

document.addEventListener("click", () => {
  document.querySelectorAll(".nav-dropdown-menu").forEach((m) =>
    m.classList.remove("open")
  );
});

/** Fetch helper for REPORTS / ANALYTICS APIs — redirects to passcode gate on 401. */
const REPORTS_API_MARKERS = [
  "/api/sales-report",
  "/api/job-ratio",
  "/api/production-capacity",
  "/api/planning-data/repeat-orders",
];

function isReportsApiUrl(url) {
  return REPORTS_API_MARKERS.some((marker) => String(url).includes(marker));
}

async function reportsApiFetch(url, options = {}) {
  const token = window.__reportsAuthToken || "";
  const headers = new Headers(options.headers || {});
  if (token && !headers.has("X-Reports-Token")) {
    headers.set("X-Reports-Token", token);
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 && isReportsApiUrl(url)) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/reports-gate?next=${next}`;
    return new Promise(() => {});
  }
  return res;
}

window.reportsApiFetch = reportsApiFetch;

/** PP staging steps (must match sync.PP_STAGING_STEP_ORDER). */
const PP_SYNC_STEPS = [
  "pp_voucher",
  "mfg_process_sheet_info",
  "workorder_status",
  "qty_shipped",
  "so_detail",
  "pp_voucher_hdr",
  "pp_partial_detail",
  "so_order_header",
  "so_order_line",
  "so_order_posted",
  "lg_out_shipment_line",
  "stg_inventory_bom_stage",
  "stg_qc_inspection",
  "stg_inventory_enquiry",
  "stg_kobelco_mps_archive",
  "part_desc",
  "pp_partial",
  "mfg_wo_status",
  "pp_vouchers_cache",
];

const PP_SYNC_STEP_LABELS = {
  lock: "Already running",
  pp_voucher: "PP vouchers",
  mfg_process_sheet_info: "Process sheets",
  workorder_status: "Work orders",
  qty_shipped: "Qty shipped",
  so_detail: "SO lines",
  pp_voucher_hdr: "PP headers",
  pp_partial_detail: "PP partials+",
  so_order_header: "SO headers",
  so_order_line: "SO pricing",
  so_order_posted: "SO posted",
  lg_out_shipment_line: "Shipments",
  stg_inventory_bom_stage: "BOM stages",
  stg_qc_inspection: "QC inspect",
  stg_inventory_enquiry: "Inventory",
  stg_kobelco_mps_archive: "Kobelco MPS",
  part_desc: "Parts",
  pp_partial: "Partials",
  mfg_wo_status: "WO status",
  pp_vouchers_cache: "Cache",
};

async function fetchPpStagingWait(since = "", timeoutSec = 20) {
  const params = new URLSearchParams({ timeout: String(timeoutSec) });
  if (since) params.set("since", since);
  const res = await fetch(`/api/pp-staging/wait?${params}`);
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    if (res.status === 502 || (raw && raw.includes("Bad gateway"))) {
      throw new Error(
        "Server unreachable during ERP sync (502). The app may be busy loading PP vouchers from COMAIN — wait a minute and retry, or run scripts/run_erp_sync.ps1 on the on-prem PC."
      );
    }
  }
  if (!res.ok) {
    throw new Error(data.error || res.statusText || "Could not read sync status");
  }
  return data;
}

function ppSyncProgressFromStatus(status) {
  const order = status.step_order || PP_SYNC_STEPS;
  const total = order.length;
  const bg = status.background_sync || {};
  if (bg.post_sync_running && !bg.running) {
    return { index: total, total, label: "Finishing", step: "post_sync" };
  }
  for (let i = 0; i < order.length; i++) {
    const step = order[i];
    const info = status.steps?.[step] || {};
    if (info.in_progress) {
      return { index: i + 1, total, label: PP_SYNC_STEP_LABELS[step] || step, step };
    }
  }
  let completed = 0;
  for (let i = 0; i < order.length; i++) {
    const last = status.steps?.[order[i]]?.last;
    if (last && !last.error) completed = i + 1;
  }
  const step = order[Math.min(completed, total - 1)] || order[0];
  return {
    index: Math.max(1, completed),
    total,
    label: PP_SYNC_STEP_LABELS[step] || step,
    step,
  };
}

async function waitForPostSyncComplete(initialToken = "") {
  let token = initialToken;
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = await fetchPpStagingWait(token, 15);
    token = status.progress_token || token;
    const bg = status.background_sync || {};
    if (!bg.post_sync_running) {
      if (bg.post_sync_error) {
        console.warn("ERP post-sync warning:", bg.post_sync_error);
      }
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.warn("ERP post-sync still running after wait; continuing anyway");
  return null;
}

async function startBackgroundPpSync(steps = null) {
  const body = { background: true, force: true };
  if (steps && steps.length) body.steps = steps;
  const res = await fetch("/api/pp-staging/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409) {
    const err = new Error(data.error || "ERP sync is already running");
    err.alreadyRunning = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(data.error || res.statusText || "ERP sync failed to start");
  }
  return data;
}

async function waitForBackgroundPpSync(onProgress) {
  let token = "";
  for (;;) {
    const status = await fetchPpStagingWait(token, 20);
    token = status.progress_token || token;
    onProgress?.(ppSyncProgressFromStatus(status));
    const bg = status.background_sync || {};
    if (!bg.running) {
      if (bg.error) throw new Error(bg.error);
      if (bg.failed_at) {
        const stepResult = (bg.results || {})[bg.failed_at] || {};
        const err = new Error(
          stepResult.error || stepResult.reason || `sync failed at ${bg.failed_at}`
        );
        err.step = bg.failed_at;
        throw err;
      }
      if (bg.post_sync_running) {
        onProgress?.({ index: PP_SYNC_STEPS.length, total: PP_SYNC_STEPS.length, label: "Finishing", step: "post_sync" });
        await waitForPostSyncComplete(token);
      }
      return bg.results || {};
    }
  }
}

/**
 * Sync ERP: 1 POST to start on server, long-poll for progress (not 11 separate sync POSTs).
 */
async function syncErpPpVouchers(opts = {}) {
  const btn = document.getElementById("nav-erp-sync-btn");
  const defaultLabel = btn?.dataset.defaultLabel || "Sync ERP";
  const steps = opts.steps && opts.steps.length ? opts.steps : null;

  const setLabel = (text) => {
    if (btn) btn.textContent = text;
  };

  if (btn) {
    btn.disabled = true;
    setLabel("Syncing ERP…");
  }

  try {
    await startBackgroundPpSync(steps);
    const combined = await waitForBackgroundPpSync((progress) => {
      setLabel(`${progress.index}/${progress.total} ${progress.label}…`);
      opts.onProgress?.(progress);
    });

    const cache = combined.pp_vouchers_cache || {};
    if (btn && cache.row_count != null) {
      setLabel(`Synced (${cache.row_count}) ✓`);
    } else if (btn) {
      setLabel("Synced ✓");
    }

    window.dispatchEvent(
      new CustomEvent("pp-vouchers-synced", { detail: combined })
    );
    window.setTimeout(() => setLabel(defaultLabel), 2000);
    return combined;
  } catch (err) {
    if (!err.alreadyRunning) {
      const label = PP_SYNC_STEP_LABELS[err.step] || err.step || "Sync";
      setLabel(`Failed: ${label}`);
    }
    console.error("pp-vouchers sync failed:", err);
    window.setTimeout(() => setLabel(defaultLabel), 4000);
    throw err;
  } finally {
    if (btn) btn.disabled = false;
  }
}

window.syncErpPpVouchers = syncErpPpVouchers;
window.PP_SYNC_STEPS = PP_SYNC_STEPS;

document.getElementById("nav-erp-sync-btn")?.addEventListener("click", () => {
  syncErpPpVouchers().catch(() => {});
});

/* ---------------------------------------------------------------------------
 * Notification bell — logs when an operation card is popped off a machine queue
 * (data comes from /api/queue-exit-history, recorded server-side on exit).
 * ------------------------------------------------------------------------- */
(function initNotifications() {
  const root = document.getElementById("nav-notif");
  const btn = document.getElementById("nav-notif-btn");
  const panel = document.getElementById("nav-notif-panel");
  const list = document.getElementById("nav-notif-list");
  const empty = document.getElementById("nav-notif-empty");
  const badge = document.getElementById("nav-notif-badge");
  const markReadBtn = document.getElementById("nav-notif-markread");
  const filterBtn = document.getElementById("nav-notif-filter-btn");
  const filterPanel = document.getElementById("nav-notif-filter-panel");
  const filterOpts = document.getElementById("nav-notif-filter-opts");
  if (!root || !btn || !panel || !list || !badge) return;

  const LAST_SEEN_KEY = "notif-last-seen-exit-id";
  const LAST_SEEN_SO_KEY = "notif-last-seen-so-time";
  const POLL_MS = 60000;
  const FETCH_LIMIT = 50;
  const SO_PARTS_MAX = 4; // parts listed per new-order card before "+N more"

  // In-memory copy is the source of truth so Mark all read works even when
  // localStorage is unavailable/blocked (e.g. embedded webviews); persistence
  // to localStorage is best-effort on top of that.
  const readNum = (key) => {
    try {
      return Number(localStorage.getItem(key) || 0) || 0;
    } catch {
      return 0;
    }
  };
  let lastSeenMem = readNum(LAST_SEEN_KEY);
  let lastSeenSoMem = readNum(LAST_SEEN_SO_KEY);

  const getLastSeen = () => lastSeenMem;
  const setLastSeen = (val) => {
    lastSeenMem = Number(val) || 0;
    try {
      localStorage.setItem(LAST_SEEN_KEY, String(lastSeenMem));
    } catch {}
  };
  const getLastSeenSo = () => lastSeenSoMem;
  const setLastSeenSo = (val) => {
    lastSeenSoMem = Number(val) || 0;
    try {
      localStorage.setItem(LAST_SEEN_SO_KEY, String(lastSeenSoMem));
    } catch {}
  };

  let events = [];
  let maxExitId = 0;
  let newOrders = [];
  let maxSoTime = 0;

  // Which PS types show up as new-sales-order notifications (user-configurable).
  const PS_TYPES = ["MPS", "APS", "NPS", "PPS", "CPS", "SR"];
  const DEFAULT_SO_PS_TYPES = ["APS", "NPS"];
  const SO_PS_TYPES_KEY = "notif-so-ps-types";
  let soPsTypes = new Set(DEFAULT_SO_PS_TYPES);
  try {
    const raw = localStorage.getItem(SO_PS_TYPES_KEY);
    if (raw != null) {
      soPsTypes = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
    }
  } catch {}
  const saveSoPsTypes = () => {
    try {
      localStorage.setItem(SO_PS_TYPES_KEY, [...soPsTypes].join(","));
    } catch {}
  };

  const psTypeOf = (ps) => {
    const raw = String(ps || "").split("::")[0];
    if (/\[sr\]/i.test(raw)) return "SR";
    const m = raw.toUpperCase().match(/^([A-Z]+)/);
    return m ? m[1] : null;
  };
  // Unknown/blank prefixes always show; known types respect the filter.
  const psTypeSelected = (type) => !type || soPsTypes.has(type);

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const fmtQty = (v) => {
    const n = num(v);
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
  };

  const fmtTime = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.round(diffMs / 60000);
    let rel;
    if (diffMin < 1) rel = "just now";
    else if (diffMin < 60) rel = `${diffMin} min ago`;
    else if (diffMin < 1440) rel = `${Math.round(diffMin / 60)} hr ago`;
    else rel = `${Math.round(diffMin / 1440)} d ago`;
    const abs = d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${rel} · ${abs}`;
  };

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));

  const buildNotif = (row) => {
    let ps = String(row.source_ps_id || row.planner_ps_id || "").trim() || "(unknown job)";
    const partial = num(row.pp_partial_no);
    if (partial > 1 && !/-\d+$/.test(ps)) ps = `${ps} · P${partial}`;
    const opNo = String(row.source_op_no || "").trim();
    const stage = String(row.stage_desc || row.op_type || "").trim();
    const opLabel = [opNo && `Operation ${opNo}`, stage].filter(Boolean).join(" ");
    const qty = fmtQty(row.good_qty || row.scheduled_qty);
    const machine = String(row.machine_no || "").trim();
    const machineLabel = machine
      ? /^cnc/i.test(machine)
        ? machine
        : `CNC ${machine}`
      : "the machine";
    return { ps, opLabel, qty, machineLabel, exitedAt: row.exited_at };
  };

  const toMs = (v) => {
    if (!v) return 0;
    const t = Date.parse(String(v).replace(" ", "T"));
    return Number.isFinite(t) ? t : 0;
  };

  // Collapse the line-level /api/new-orders rows into one card per sales order,
  // keeping a de-duplicated list of its PS + part lines.
  const groupNewOrders = (rows) => {
    const bySo = new Map();
    for (const row of rows) {
      const so = String(row.source_voucher_no || "").trim();
      if (!so) continue;
      let g = bySo_get(bySo, so, row);
      const ps = String(row.process_sheet_no || "").trim();
      const part = String(row.inventory_code || "").trim();
      const desc = String(row.part_desc || row.main_desc || "").trim();
      if (!ps && !part) continue;
      const key = `${ps}|${part}`;
      if (g.seen.has(key)) continue;
      g.seen.add(key);
      g.parts.push({ ps, part, desc, type: psTypeOf(ps) });
    }
    newOrders = Array.from(bySo.values());
    maxSoTime = newOrders.reduce((m, g) => Math.max(m, toMs(g.postedAt)), 0);
  };

  const bySo_get = (map, so, row) => {
    let g = map.get(so);
    if (!g) {
      g = {
        so,
        customer: String(row.customer_code || "").trim(),
        postedAt: row.first_posted_datetime || null,
        parts: [],
        seen: new Set(),
      };
      map.set(so, g);
    }
    if (!g.postedAt && row.first_posted_datetime) g.postedAt = row.first_posted_datetime;
    return g;
  };

  const exitItemHtml = (row, isUnread) => {
    const n = buildNotif(row);
    return `
      <div class="nav-notif-item${isUnread ? " is-unread" : ""}">
        <div class="nav-notif-ps">${esc(n.ps)}</div>
        ${n.opLabel ? `<div class="nav-notif-op">${esc(n.opLabel)}</div>` : ""}
        ${n.qty ? `<div class="nav-notif-qty">(Qty ${esc(n.qty)})</div>` : ""}
        <div class="nav-notif-action">has been scanned and taken off <strong>${esc(n.machineLabel)}</strong></div>
        <div class="nav-notif-time">${esc(fmtTime(n.exitedAt))}</div>
      </div>`;
  };

  const soItemHtml = (g, parts, isUnread) => {
    const shown = parts.slice(0, SO_PARTS_MAX);
    const extra = parts.length - shown.length;
    const partsHtml = shown
      .map((p) => {
        const detail = [p.part, p.desc].filter(Boolean).join(" · ");
        return `
          <li class="nav-notif-part">
            <span class="nav-notif-part-ps">${esc(p.ps || "—")}</span>
            ${detail ? `<span class="nav-notif-part-no">${esc(detail)}</span>` : ""}
          </li>`;
      })
      .join("");
    const moreHtml = extra > 0 ? `<li class="nav-notif-part-more">+${extra} more</li>` : "";
    return `
      <div class="nav-notif-item nav-notif-item--so${isUnread ? " is-unread" : ""}">
        <div class="nav-notif-tag">New sales order</div>
        <div class="nav-notif-ps">${esc(g.so)}</div>
        ${g.customer ? `<div class="nav-notif-action">from <strong>${esc(g.customer)}</strong></div>` : ""}
        <ul class="nav-notif-parts">${partsHtml}${moreHtml}</ul>
        <div class="nav-notif-time">${esc(fmtTime(g.postedAt))}</div>
      </div>`;
  };

  const render = () => {
    const lastSeen = getLastSeen();
    const lastSeenSo = getLastSeenSo();
    const items = [];
    let unread = 0;

    for (const row of events) {
      const id = num(row.exit_id);
      const isUnread = id > lastSeen;
      if (isUnread) unread += 1;
      items.push({ sortMs: toMs(row.exited_at), html: exitItemHtml(row, isUnread) });
    }
    for (const g of newOrders) {
      const parts = g.parts.filter((p) => psTypeSelected(p.type));
      if (!parts.length) continue;
      const ms = toMs(g.postedAt);
      const isUnread = ms > 0 && ms > lastSeenSo;
      if (isUnread) unread += 1;
      items.push({ sortMs: ms, html: soItemHtml(g, parts, isUnread) });
    }

    if (!items.length) {
      list.innerHTML = "";
      if (empty) {
        empty.hidden = false;
        list.appendChild(empty);
      }
    } else {
      items.sort((a, b) => b.sortMs - a.sortMs);
      list.innerHTML = items.map((i) => i.html).join("");
    }

    if (unread > 0) {
      badge.textContent = unread > 99 ? "99+" : String(unread);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  };

  const fetchEvents = async () => {
    try {
      const res = await fetch(`/api/queue-exit-history?limit=${FETCH_LIMIT}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || data.ok === false || !Array.isArray(data.rows)) return;
      events = data.rows;
      maxExitId = events.reduce((m, r) => Math.max(m, num(r.exit_id)), 0);
      render();
    } catch {
      /* silent — bell just won't update */
    }
  };

  const fetchNewOrders = async () => {
    try {
      const res = await fetch("/api/new-orders?week=this_week", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || data.ok === false || !Array.isArray(data.rows)) return;
      groupNewOrders(data.rows);
      render();
    } catch {
      /* silent — bell just won't update */
    }
  };

  const refresh = () => {
    fetchEvents();
    fetchNewOrders();
  };

  const markAllRead = () => {
    if (maxExitId > getLastSeen()) setLastSeen(maxExitId);
    if (maxSoTime > getLastSeenSo()) setLastSeenSo(maxSoTime);
    render();
  };

  const openPanel = () => {
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    refresh();
  };
  const closeFilter = () => {
    if (!filterPanel) return;
    filterPanel.hidden = true;
    filterBtn?.setAttribute("aria-expanded", "false");
  };
  const closePanel = () => {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    closeFilter();
  };

  const buildFilter = () => {
    if (!filterOpts) return;
    filterOpts.innerHTML = PS_TYPES.map(
      (t) => `
        <label class="nav-notif-filter-opt">
          <input type="checkbox" value="${t}"${soPsTypes.has(t) ? " checked" : ""} />
          <span>${t}</span>
        </label>`
    ).join("");
    filterOpts.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) soPsTypes.add(cb.value);
        else soPsTypes.delete(cb.value);
        saveSoPsTypes();
        render();
      });
    });
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.hidden) openPanel();
    else closePanel();
  });

  markReadBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    markAllRead();
  });

  filterBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!filterPanel) return;
    const willOpen = filterPanel.hidden;
    filterPanel.hidden = !willOpen;
    filterBtn.setAttribute("aria-expanded", String(willOpen));
  });

  document.addEventListener("click", (e) => {
    if (
      filterPanel &&
      !filterPanel.hidden &&
      !filterPanel.contains(e.target) &&
      !filterBtn?.contains(e.target)
    ) {
      closeFilter();
    }
    if (!panel.hidden && !root.contains(e.target)) closePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (filterPanel && !filterPanel.hidden) closeFilter();
    else if (!panel.hidden) closePanel();
  });

  buildFilter();

  refresh();
  window.setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, POLL_MS);
  window.addEventListener("focus", () => refresh());
  // Refetch right after an ERP sync so brand-new orders show without waiting for the poll.
  window.addEventListener("pp-vouchers-synced", () => fetchNewOrders());
})();
