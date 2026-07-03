(function () {
  const loadingEl = document.getElementById("email-settings-loading");
  const errorEl = document.getElementById("email-settings-error");
  const formEl = document.getElementById("email-settings-form");
  const statusEl = document.getElementById("email-settings-status");
  const logWrap = document.getElementById("email-settings-log-wrap");
  const logEl = document.getElementById("email-settings-log");

  const fields = {
    smtpEnabled: document.getElementById("smtp-enabled"),
    smtpHost: document.getElementById("smtp-host"),
    smtpPort: document.getElementById("smtp-port"),
    smtpUser: document.getElementById("smtp-user"),
    smtpPassword: document.getElementById("smtp-password"),
    smtpFrom: document.getElementById("smtp-from"),
    smtpUseTls: document.getElementById("smtp-use-tls"),
    smtpTimeout: document.getElementById("smtp-timeout"),
    newSoEnabled: document.getElementById("new-so-enabled"),
    newSoRecipients: document.getElementById("new-so-recipients"),
    newSoCc: document.getElementById("new-so-cc"),
    newSoBcc: document.getElementById("new-so-bcc"),
    newSoSubject: document.getElementById("new-so-subject"),
    newSoLookback: document.getElementById("new-so-lookback"),
    newSoPsEnabled: document.getElementById("new-so-ps-enabled"),
    newSoPsHeading: document.getElementById("new-so-ps-heading"),
    newSoPsLineTemplate: document.getElementById("new-so-ps-line-template"),
  };

  function showToast(message, isError) {
    let toastEl = document.getElementById("email-settings-toast");
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "email-settings-toast";
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.toggle("toast--error", !!isError);
    toastEl.classList.add("toast--show");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toastEl.classList.remove("toast--show"), 3200);
  }

  async function api(method, url, body) {
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
    return data;
  }

  function setStatus(config) {
    if (!statusEl) return;
    const smtpOk = config?.smtp?.configured;
    const triggerOk = config?.triggers?.new_sales_order?.configured;
    if (smtpOk && triggerOk) {
      statusEl.textContent = "Ready to send";
      statusEl.className = "email-settings-status email-settings-status--ok";
    } else if (smtpOk) {
      statusEl.textContent = "SMTP OK — add recipients";
      statusEl.className = "email-settings-status email-settings-status--warn";
    } else {
      statusEl.textContent = "Not configured";
      statusEl.className = "email-settings-status email-settings-status--warn";
    }
    statusEl.hidden = false;
  }

  function fillForm(config) {
    const smtp = config.smtp || {};
    const trigger = (config.triggers || {}).new_sales_order || {};
    fields.smtpEnabled.checked = !!smtp.enabled;
    fields.smtpHost.value = smtp.host || "";
    fields.smtpPort.value = smtp.port || 587;
    fields.smtpUser.value = smtp.user || "";
    fields.smtpPassword.value = "";
    fields.smtpPassword.placeholder = smtp.password_set
      ? "Saved — leave blank to keep"
      : "Enter SMTP password";
    fields.smtpFrom.value = smtp.from_address || "";
    fields.smtpUseTls.checked = smtp.use_tls !== false;
    fields.smtpTimeout.value = smtp.timeout_sec || 30;
    fields.newSoEnabled.checked = !!trigger.enabled;
    fields.newSoRecipients.value = trigger.recipients_text || (trigger.recipients || []).join(", ");
    fields.newSoCc.value = trigger.cc_text || (trigger.cc || []).join(", ");
    fields.newSoBcc.value = trigger.bcc_text || (trigger.bcc || []).join(", ");
    fields.newSoSubject.value = trigger.subject_template || "[Planner] New Sales Order: {sales_order_no}";
    fields.newSoLookback.value = trigger.lookback_days || 7;
    fields.newSoPsEnabled.checked = trigger.ps_enabled !== false;
    fields.newSoPsHeading.value = trigger.ps_heading || "Process sheets:";
    fields.newSoPsLineTemplate.value =
      trigger.ps_line_template || "  - {process_sheet_no} | {part_no} | line {line_item_no} | qty {qty}";
    setStatus(config);
  }

  function collectPayload() {
    const payload = {
      smtp: {
        enabled: fields.smtpEnabled.checked,
        host: fields.smtpHost.value.trim(),
        port: Number(fields.smtpPort.value || 587),
        user: fields.smtpUser.value.trim(),
        from_address: fields.smtpFrom.value.trim(),
        use_tls: fields.smtpUseTls.checked,
        timeout_sec: Number(fields.smtpTimeout.value || 30),
      },
      triggers: {
        new_sales_order: {
          enabled: fields.newSoEnabled.checked,
          recipients_text: fields.newSoRecipients.value.trim(),
          cc_text: fields.newSoCc.value.trim(),
          bcc_text: fields.newSoBcc.value.trim(),
          subject_template: fields.newSoSubject.value.trim(),
          lookback_days: Number(fields.newSoLookback.value || 7),
          ps_enabled: fields.newSoPsEnabled.checked,
          ps_heading: fields.newSoPsHeading.value.trim(),
          ps_line_template: fields.newSoPsLineTemplate.value,
        },
      },
    };
    const password = fields.smtpPassword.value;
    if (password) payload.smtp.password = password;
    return payload;
  }

  function showLog(data) {
    if (!logWrap || !logEl) return;
    logWrap.hidden = false;
    logEl.textContent = JSON.stringify(data, null, 2);
  }

  async function loadConfig() {
    loadingEl.hidden = false;
    errorEl.hidden = true;
    formEl.hidden = true;
    try {
      const config = await api("GET", "/api/email/config");
      fillForm(config);
      formEl.hidden = false;
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = err.message || String(err);
    } finally {
      loadingEl.hidden = true;
    }
  }

  formEl?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const result = await api("PUT", "/api/email/config", collectPayload());
      fillForm(result);
      showToast("Settings saved");
    } catch (err) {
      showToast(err.message || "Save failed", true);
    }
  });

  document.getElementById("email-settings-test")?.addEventListener("click", async () => {
    try {
      await api("PUT", "/api/email/config", collectPayload());
      const result = await api("POST", "/api/email/send-test");
      showLog(result);
      showToast(result.ok ? "Test email sent" : (result.error || "Send failed"), !result.ok);
    } catch (err) {
      showToast(err.message || "Test failed", true);
    }
  });

  document.getElementById("email-settings-preview")?.addEventListener("click", async () => {
    try {
      await api("PUT", "/api/email/config", collectPayload());
      const result = await api("POST", "/api/email/notify-new-sales-orders", { dry_run: true });
      showLog(result);
      const count = result.pending_count ?? (result.sent || []).length;
      showToast(`Preview: ${count} pending sales order(s)`);
    } catch (err) {
      showToast(err.message || "Preview failed", true);
    }
  });

  document.getElementById("email-settings-notify")?.addEventListener("click", async () => {
    if (!confirm("Send emails for all pending new sales orders now?")) return;
    try {
      await api("PUT", "/api/email/config", collectPayload());
      const result = await api("POST", "/api/email/notify-new-sales-orders");
      showLog(result);
      showToast(`Sent ${result.sent_count || 0} email(s)`, !!result.failed_count);
    } catch (err) {
      showToast(err.message || "Notify failed", true);
    }
  });

  loadConfig();
})();
