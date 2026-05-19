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
  "part_desc",
  "pp_partial",
  "mfg_wo_status",
  "pp_vouchers_cache",
];

const PP_SYNC_STEP_LABELS = {
  pp_voucher: "PP vouchers",
  mfg_process_sheet_info: "Process sheets",
  workorder_status: "Work orders",
  qty_shipped: "Qty shipped",
  so_detail: "SO lines",
  part_desc: "Parts",
  pp_partial: "Partials",
  mfg_wo_status: "WO status",
  pp_vouchers_cache: "Cache",
};

async function postPpStagingStep(step, force = true) {
  const res = await fetch("/api/pp-staging/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ steps: [step], force }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || "ERP sync failed");
    err.step = step;
    err.detail = data;
    throw err;
  }
  return data;
}

/**
 * Full ERP sync, one HTTP request per step (avoids proxy/browser timeouts).
 * @param {{ steps?: string[], onProgress?: (info: object) => void }} [opts]
 */
async function syncErpPpVouchers(opts = {}) {
  const btn = document.getElementById("nav-erp-sync-btn");
  const defaultLabel = btn?.dataset.defaultLabel || "Sync ERP";
  const steps = opts.steps && opts.steps.length ? opts.steps : PP_SYNC_STEPS;
  const total = steps.length;
  const combined = {};

  const setLabel = (text) => {
    if (btn) btn.textContent = text;
  };

  if (btn) {
    btn.disabled = true;
    setLabel("Syncing…");
  }

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const label = PP_SYNC_STEP_LABELS[step] || step;
      const progress = { step, label, index: i + 1, total };
      setLabel(`${i + 1}/${total} ${label}…`);
      opts.onProgress?.(progress);

      const data = await postPpStagingStep(step, true);
      Object.assign(combined, data);
      const stepResult = data[step] || {};
      if (stepResult.skipped) {
        console.warn(`${step} skipped:`, stepResult.reason);
      }
    }

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
    const step = err.step || "?";
    const label = PP_SYNC_STEP_LABELS[step] || step;
    setLabel(`Failed: ${label}`);
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
