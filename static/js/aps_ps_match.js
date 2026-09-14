(() => {
  const dropzone = document.getElementById("aps-match-dropzone");
  const fileInput = document.getElementById("aps-match-file");
  const browseBtn = document.getElementById("aps-match-browse");
  const filenameEl = document.getElementById("aps-match-filename");
  const alertEl = document.getElementById("aps-match-alert");
  const summaryEl = document.getElementById("aps-match-summary");

  function showAlert(message, ok) {
    if (!alertEl) return;
    if (!message) {
      alertEl.hidden = true;
      alertEl.textContent = "";
      return;
    }
    alertEl.hidden = false;
    alertEl.classList.toggle("is-ok", Boolean(ok));
    alertEl.textContent = message;
  }

  function setBusy(busy) {
    if (dropzone) dropzone.classList.toggle("is-busy", Boolean(busy));
    if (browseBtn) browseBtn.disabled = Boolean(busy);
  }

  function filenameFromDisposition(header) {
    const text = String(header || "");
    const utf = /filename\*=UTF-8''([^;]+)/i.exec(text);
    if (utf) {
      try {
        return decodeURIComponent(utf[1]);
      } catch (_err) {
        return utf[1];
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(text);
    return plain ? plain[1] : "";
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name || "aps-ps-match.xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function renderSummary(summary) {
    if (!summaryEl) return;
    const data = summary || {};
    document.getElementById("aps-match-input").textContent = String(data.input_rows || 0);
    document.getElementById("aps-match-output").textContent = String(data.output_rows || 0);
    document.getElementById("aps-match-ps").textContent = String(data.matched_ps || 0);
    document.getElementById("aps-match-unmatched-ps").textContent = String(data.unmatched_ps || 0);
    document.getElementById("aps-match-unmatched-inv").textContent = String(data.unmatched_inventory || 0);
    summaryEl.hidden = false;
  }

  async function uploadFile(file) {
    if (!file) return;
    if (filenameEl) {
      filenameEl.hidden = false;
      filenameEl.textContent = file.name;
    }
    showAlert("");
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/archive/aps-ps-match", { method: "POST", body });
      const type = (res.headers.get("content-type") || "").toLowerCase();
      if (!res.ok) {
        const data = type.includes("json") ? await res.json().catch(() => ({})) : {};
        throw new Error(data.error || "Upload failed");
      }
      let summary = {};
      const rawSummary = res.headers.get("X-Aps-Match-Summary");
      if (rawSummary) {
        try {
          summary = JSON.parse(rawSummary);
        } catch (_err) {
          summary = {};
        }
      }
      const blob = await res.blob();
      const name =
        summary.download_name ||
        filenameFromDisposition(res.headers.get("Content-Disposition")) ||
        "aps-ps-match.xlsx";
      downloadBlob(blob, name);
      renderSummary(summary);
      const extra =
        Number(summary.output_rows || 0) > Number(summary.input_rows || 0)
          ? " Duplicate rows were added where one part matched more than one APS."
          : "";
      showAlert(`Downloaded ${name}.${extra}`, true);
    } catch (err) {
      showAlert(err && err.message ? err.message : "Upload failed");
    } finally {
      setBusy(false);
      if (fileInput) fileInput.value = "";
    }
  }

  if (browseBtn && fileInput) {
    browseBtn.addEventListener("click", () => fileInput.click());
  }
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) uploadFile(file);
    });
  }
  if (dropzone) {
    dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropzone.classList.add("is-hover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-hover"));
    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-hover");
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) uploadFile(file);
    });
  }
})();
