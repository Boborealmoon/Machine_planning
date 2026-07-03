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
