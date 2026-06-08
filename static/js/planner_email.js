(function () {
  'use strict';

  const state = {
    settings: null,
    saving: false,
    sending: false,
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  }

  function setLoading(isLoading) {
    document.getElementById('planner-email-loading').hidden = !isLoading;
    document.getElementById('planner-email-content').hidden = isLoading;
  }

  function renderSettings(settings) {
    state.settings = settings;
    document.getElementById('planner-email-enabled').checked = !!settings.enabled;
    document.getElementById('planner-email-recipients').value = settings.recipient_emails || '';
    document.getElementById('planner-email-send-time').value = settings.send_time_local || '07:00';
    document.getElementById('planner-email-subject').value = settings.email_subject || '';

    const smtpOk = !!settings.smtp_configured;
    document.getElementById('planner-email-smtp-status').innerHTML = smtpOk
      ? `<span class="planner-email-pill is-ok">Configured</span> ${escapeHtml(settings.smtp_host || '')}`
      : '<span class="planner-email-pill is-bad">Not configured</span> Set SMTP_HOST and SMTP_FROM in .env';
    document.getElementById('planner-email-smtp-from').textContent = settings.smtp_from_email || '—';
    document.getElementById('planner-email-last-sent').textContent = settings.last_sent_at || 'Never';
    const resultEl = document.getElementById('planner-email-last-result');
    const status = String(settings.last_send_status || '').trim();
    const message = String(settings.last_send_message || '').trim();
    if (!status && !message) {
      resultEl.textContent = '—';
    } else {
      const cls = status === 'SUCCESS' ? 'is-ok' : (status === 'FAILED' ? 'is-bad' : '');
      resultEl.innerHTML = `${status ? `<span class="planner-email-pill ${cls}">${escapeHtml(status)}</span> ` : ''}${escapeHtml(message)}`;
    }
  }

  function renderLog(items) {
    const body = document.getElementById('planner-email-log-body');
    const empty = document.getElementById('planner-email-log-empty');
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) {
      body.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    body.innerHTML = rows.map(row => {
      const status = String(row.status || '');
      const cls = status === 'SUCCESS' ? 'is-ok' : (status === 'FAILED' ? 'is-bad' : '');
      return `
        <tr>
          <td>${escapeHtml(row.sent_at || '')}</td>
          <td><span class="planner-email-pill ${cls}">${escapeHtml(status || '—')}</span></td>
          <td>${escapeHtml(row.recipient_emails || '')}</td>
          <td>${escapeHtml(row.subject || '')}</td>
          <td>${escapeHtml(row.attachment_name || '')}</td>
          <td>${escapeHtml(row.message || '')}</td>
        </tr>
      `;
    }).join('');
  }

  async function loadPage() {
    setLoading(true);
    try {
      const [settings, logData] = await Promise.all([
        fetchJson('/api/planner-email/settings'),
        fetchJson('/api/planner-email/log?limit=20'),
      ]);
      renderSettings(settings);
      renderLog(logData.items || []);
    } catch (err) {
      toast('Could not load planner email settings: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    if (state.saving) return;
    state.saving = true;
    const button = document.getElementById('planner-email-save');
    button.disabled = true;
    try {
      const payload = {
        enabled: document.getElementById('planner-email-enabled').checked,
        recipient_emails: document.getElementById('planner-email-recipients').value,
        send_time_local: document.getElementById('planner-email-send-time').value,
        email_subject: document.getElementById('planner-email-subject').value,
      };
      const settings = await fetchJson('/api/planner-email/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      renderSettings(settings);
      toast('Email settings saved', 'success');
    } catch (err) {
      toast('Save failed: ' + err.message, 'error');
    } finally {
      state.saving = false;
      button.disabled = false;
    }
  }

  async function sendNow() {
    if (state.sending) return;
    state.sending = true;
    const button = document.getElementById('planner-email-send-now');
    button.disabled = true;
    try {
      const result = await fetchJson('/api/planner-email/send-now', { method: 'POST' });
      toast(result.message || 'Email sent', 'success');
      await loadPage();
    } catch (err) {
      toast('Send failed: ' + err.message, 'error');
    } finally {
      state.sending = false;
      button.disabled = false;
    }
  }

  async function sendTest() {
    if (state.sending) return;
    const testRecipient = document.getElementById('planner-email-test-recipient').value.trim();
    if (!testRecipient) {
      toast('Enter a test recipient email address', 'info');
      return;
    }
    state.sending = true;
    const button = document.getElementById('planner-email-send-test');
    button.disabled = true;
    try {
      const result = await fetchJson('/api/planner-email/send-test', {
        method: 'POST',
        body: JSON.stringify({ test_recipient: testRecipient }),
      });
      toast(result.message || 'Test email sent', 'success');
      await loadPage();
    } catch (err) {
      toast('Test send failed: ' + err.message, 'error');
    } finally {
      state.sending = false;
      button.disabled = false;
    }
  }

  document.getElementById('planner-email-save')?.addEventListener('click', saveSettings);
  document.getElementById('planner-email-send-now')?.addEventListener('click', sendNow);
  document.getElementById('planner-email-send-test')?.addEventListener('click', sendTest);
  document.getElementById('planner-email-refresh')?.addEventListener('click', loadPage);

  loadPage();
})();
