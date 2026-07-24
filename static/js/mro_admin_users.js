(() => {
  'use strict';

  const ADMIN_GATE_TOKEN = String(globalThis.__ADMIN_GATE_TOKEN__ || '').trim();
  const nativeFetch = globalThis.fetch.bind(globalThis);

  function adminFetch(input, init) {
    const nextInit = { ...(init || {}) };
    const headers = { ...(nextInit.headers || {}) };
    if (ADMIN_GATE_TOKEN) {
      headers['X-Admin-Token'] = ADMIN_GATE_TOKEN;
    }
    if (nextInit.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    nextInit.headers = headers;
    let url = input;
    if (ADMIN_GATE_TOKEN && typeof input === 'string' && input.startsWith('/api/admin/mro-users')) {
      const joiner = input.includes('?') ? '&' : '?';
      url = `${input}${joiner}at=${encodeURIComponent(ADMIN_GATE_TOKEN)}`;
    }
    return nativeFetch(url, nextInit);
  }

  const bodyEl = document.getElementById('mro-users-body');
  const emptyEl = document.getElementById('mro-users-empty');
  const filterEl = document.getElementById('mro-users-filter');
  const createForm = document.getElementById('mro-create-form');
  const createStatus = document.getElementById('mro-create-status');
  const editDialog = document.getElementById('mro-edit-dialog');
  const editForm = document.getElementById('mro-edit-form');
  const editStatus = document.getElementById('mro-edit-status');
  const resetsBody = document.getElementById('mro-resets-body');
  const resetsEmpty = document.getElementById('mro-resets-empty');
  const resetsTable = document.getElementById('mro-resets-table');
  const resetBadge = document.getElementById('mro-reset-badge');
  const pendingBadge = document.getElementById('mro-pending-badge');

  let usersCache = [];
  let resetsCache = [];
  let editMode = 'user'; // 'user' | 'reset'

  function setStatus(el, text, ok) {
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      el.classList.remove('is-ok', 'is-err');
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle('is-ok', !!ok);
    el.classList.toggle('is-err', !ok);
  }

  function formatWhen(value) {
    if (!value) return '\u2014';
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleString();
    } catch (_) {
      return String(value);
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setBadge(el, count) {
    if (!el) return;
    const n = Number(count) || 0;
    if (n > 0) {
      el.hidden = false;
      el.textContent = String(n);
    } else {
      el.hidden = true;
      el.textContent = '0';
    }
  }

  function actionButtons(user) {
    const parts = [];
    if (user.status === 'pending') {
      parts.push(`<button type="button" class="mro-admin-approve" data-act="approve" data-id="${user.user_id}">Approve</button>`);
      parts.push(`<button type="button" data-act="reject" data-id="${user.user_id}">Reject</button>`);
    }
    if (user.status === 'approved') {
      parts.push(`<button type="button" data-act="disable" data-id="${user.user_id}">Disable</button>`);
    }
    if (user.status === 'disabled' || user.status === 'rejected') {
      parts.push(`<button type="button" class="mro-admin-approve" data-act="approve" data-id="${user.user_id}">Re-approve</button>`);
    }
    parts.push(`<button type="button" data-act="edit" data-id="${user.user_id}">Edit</button>`);
    return parts.join('');
  }

  function renderUsers(users) {
    usersCache = users || [];
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    if (!usersCache.length) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    usersCache.forEach((user) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(user.username || '')}</strong></td>
        <td>${escapeHtml(user.email || '')}</td>
        <td><span class="mro-admin-status-pill is-${escapeHtml(user.status || '')}">${escapeHtml(user.status || '')}</span></td>
        <td>${escapeHtml(formatWhen(user.created_at))}</td>
        <td>${escapeHtml(formatWhen(user.last_login_at))}</td>
        <td><div class="mro-admin-actions">${actionButtons(user)}</div></td>
      `;
      bodyEl.appendChild(tr);
    });
  }

  function renderResets(requests) {
    resetsCache = requests || [];
    if (!resetsBody) return;
    resetsBody.innerHTML = '';
    setBadge(resetBadge, resetsCache.length);
    if (!resetsCache.length) {
      if (resetsEmpty) resetsEmpty.hidden = false;
      if (resetsTable) resetsTable.hidden = true;
      return;
    }
    if (resetsEmpty) resetsEmpty.hidden = true;
    if (resetsTable) resetsTable.hidden = false;
    resetsCache.forEach((req) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(req.username || '')}</strong></td>
        <td>${escapeHtml(req.email || '')}</td>
        <td>${escapeHtml(formatWhen(req.created_at))}</td>
        <td><div class="mro-admin-actions">
          <button type="button" class="mro-admin-approve" data-reset-act="set-password" data-request-id="${req.request_id}" data-user-id="${req.user_id}">Set password</button>
          <button type="button" data-reset-act="dismiss" data-request-id="${req.request_id}">Dismiss</button>
        </div></td>
      `;
      resetsBody.appendChild(tr);
    });
  }

  function openEditUser(user) {
    editMode = 'user';
    document.getElementById('mro-edit-title').textContent = 'Edit credentials';
    document.getElementById('mro-edit-subtitle').textContent = `User #${user.user_id}`;
    document.getElementById('mro-edit-user-id').value = user.user_id;
    document.getElementById('mro-edit-request-id').value = '';
    document.getElementById('mro-edit-username').value = user.username || '';
    document.getElementById('mro-edit-email').value = user.email || '';
    document.getElementById('mro-edit-password').value = '';
    document.getElementById('mro-edit-password').required = false;
    document.getElementById('mro-edit-password-label').innerHTML = 'New password <em>(leave blank to keep)</em>';
    document.getElementById('mro-edit-username-wrap').hidden = false;
    document.getElementById('mro-edit-email-wrap').hidden = false;
    document.getElementById('mro-edit-username').required = true;
    document.getElementById('mro-edit-email').required = true;
    setStatus(editStatus, '', true);
    editDialog.showModal();
  }

  function openSetPassword(req) {
    editMode = 'reset';
    document.getElementById('mro-edit-title').textContent = 'Set new password';
    document.getElementById('mro-edit-subtitle').textContent =
      `Reset request for ${req.username || 'user'} (#${req.user_id})`;
    document.getElementById('mro-edit-user-id').value = req.user_id;
    document.getElementById('mro-edit-request-id').value = req.request_id;
    document.getElementById('mro-edit-username').value = req.username || '';
    document.getElementById('mro-edit-email').value = req.email || '';
    document.getElementById('mro-edit-password').value = '';
    document.getElementById('mro-edit-password').required = true;
    document.getElementById('mro-edit-password-label').innerHTML = 'New password';
    document.getElementById('mro-edit-username-wrap').hidden = true;
    document.getElementById('mro-edit-email-wrap').hidden = true;
    document.getElementById('mro-edit-username').required = false;
    document.getElementById('mro-edit-email').required = false;
    setStatus(editStatus, '', true);
    editDialog.showModal();
  }

  async function loadUsers() {
    const status = filterEl ? filterEl.value : '';
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await adminFetch(`/api/admin/mro-users${qs}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(createStatus, data.error || 'Failed to load users.', false);
      return;
    }
    renderUsers(data.users || []);
    renderResets(data.reset_requests || []);
    setBadge(pendingBadge, data.pending_count);
    setBadge(resetBadge, data.reset_pending_count);
  }

  async function postAction(path) {
    const res = await adminFetch(path, { method: 'POST', body: '{}' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      window.alert(data.error || 'Action failed.');
      return;
    }
    await loadUsers();
  }

  if (bodyEl) {
    bodyEl.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      const id = btn.getAttribute('data-id');
      if (!id) return;
      if (act === 'approve') {
        postAction(`/api/admin/mro-users/${id}/approve`);
      } else if (act === 'reject') {
        postAction(`/api/admin/mro-users/${id}/reject`);
      } else if (act === 'disable') {
        postAction(`/api/admin/mro-users/${id}/disable`);
      } else if (act === 'edit') {
        const user = usersCache.find((u) => String(u.user_id) === String(id));
        if (user) openEditUser(user);
      }
    });
  }

  if (resetsBody) {
    resetsBody.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-reset-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-reset-act');
      const requestId = btn.getAttribute('data-request-id');
      if (act === 'dismiss' && requestId) {
        postAction(`/api/admin/mro-users/reset-requests/${requestId}/reject`);
      } else if (act === 'set-password' && requestId) {
        const req = resetsCache.find((r) => String(r.request_id) === String(requestId));
        if (req) openSetPassword(req);
      }
    });
  }

  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const fd = new FormData(createForm);
      const payload = {
        username: String(fd.get('username') || '').trim(),
        email: String(fd.get('email') || '').trim(),
        password: String(fd.get('password') || ''),
      };
      setStatus(createStatus, 'Creating\u2026', true);
      const res = await adminFetch('/api/admin/mro-users', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(createStatus, data.error || 'Create failed.', false);
        return;
      }
      createForm.reset();
      setStatus(createStatus, `Created and approved ${payload.username}.`, true);
      if (filterEl) filterEl.value = 'approved';
      await loadUsers();
    });
  }

  if (editForm && editDialog) {
    editForm.addEventListener('submit', async (event) => {
      const submitter = event.submitter;
      if (submitter && submitter.value === 'cancel') {
        return;
      }
      event.preventDefault();
      const password = document.getElementById('mro-edit-password').value;
      setStatus(editStatus, 'Saving\u2026', true);

      if (editMode === 'reset') {
        const requestId = document.getElementById('mro-edit-request-id').value;
        if (!password) {
          setStatus(editStatus, 'Password is required.', false);
          return;
        }
        const res = await adminFetch(`/api/admin/mro-users/reset-requests/${requestId}/complete`, {
          method: 'POST',
          body: JSON.stringify({ password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatus(editStatus, data.error || 'Could not set password.', false);
          return;
        }
        editDialog.close();
        await loadUsers();
        return;
      }

      const userId = document.getElementById('mro-edit-user-id').value;
      const payload = {
        username: document.getElementById('mro-edit-username').value.trim(),
        email: document.getElementById('mro-edit-email').value.trim(),
      };
      if (password) payload.password = password;
      const res = await adminFetch(`/api/admin/mro-users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(editStatus, data.error || 'Save failed.', false);
        return;
      }
      editDialog.close();
      await loadUsers();
    });
  }

  if (filterEl) {
    filterEl.addEventListener('change', () => {
      loadUsers();
    });
  }

  const refreshBtn = document.getElementById('mro-users-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadUsers());
  }

  loadUsers();
})();
