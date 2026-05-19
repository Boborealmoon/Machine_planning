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

async function syncErpPpVouchers() {
  const btn = document.getElementById("nav-erp-sync-btn");
  const defaultLabel = btn?.dataset.defaultLabel || "Sync ERP";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Syncing…";
  }
  try {
    const res = await fetch("/api/pp-vouchers/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || res.statusText || "ERP sync failed");
    }
    if (btn) btn.textContent = "Synced ✓";
    window.dispatchEvent(new CustomEvent("pp-vouchers-synced", { detail: data }));
    window.setTimeout(() => {
      if (btn) btn.textContent = defaultLabel;
    }, 2000);
    return data;
  } catch (err) {
    if (btn) btn.textContent = "Sync failed";
    window.setTimeout(() => {
      if (btn) btn.textContent = defaultLabel;
    }, 3000);
    console.error("pp-vouchers sync failed:", err);
    throw err;
  } finally {
    if (btn) btn.disabled = false;
  }
}

window.syncErpPpVouchers = syncErpPpVouchers;

document.getElementById("nav-erp-sync-btn")?.addEventListener("click", () => {
  syncErpPpVouchers().catch(() => {});
});
