(() => {
  'use strict';

  const ADMIN_GATE_TOKEN = String(globalThis.__ADMIN_GATE_TOKEN__ || '').trim();
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const API = '/api/admin/shift-management-users';

  function adminFetch(input, init) {
    const nextInit = Object.assign({}, init || {});
    const headers = Object.assign({}, nextInit.headers || {});
    if (ADMIN_GATE_TOKEN) {
      headers['X-Admin-Token'] = ADMIN_GATE_TOKEN;
    }
    if (nextInit.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    nextInit.headers = headers;
    let url = input;
    if (ADMIN_GATE_TOKEN && typeof input === 'string' && input.startsWith(API)) {
      const joiner = input.includes('?') ? '&' : '?';
      url = input + joiner + 'at=' + encodeURIComponent(ADMIN_GATE_TOKEN);
    }
    return nativeFetch(url, nextInit);
  }

  const bodyEl = document.getElementById('sm-users-body');
  const emptyEl = document.getElementById('sm-users-empty');
  const filterEl = document.getElementById('sm-users-filter');
  const createForm = document.getElementById('sm-create-form');
  const createStatus = document.getElementById('sm-create-status');
  const editDialog = document.getElementById('sm-edit-dialog');
  const editStatus = document.getElementById('sm-edit-status');
  const pendingBadge = document.getElementById('sm-pending-badge');
  const saveBtn = document.getElementById('sm-edit-save');
  const saveApproveBtn = document.getElementById('sm-edit-save-approve');
  const cancelBtn = document.getElementById('sm-edit-cancel');

  let usersCache = [];

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
    if (!value) return '-';
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
    el.hidden = n <= 0;
    el.textContent = String(n);
  }

  function actionButtons(user) {
    const parts = [];
    if (user.status === 'pending') {
      parts.push(
        '<button type="button" class="mro-admin-approve" data-act="approve" data-id="' +
          user.user_id +
          '">Approve</button>'
      );
      parts.push(
        '<button type="button" data-act="disable" data-id="' + user.user_id + '">Reject</button>'
      );
    }
    if (user.status === 'approved') {
      parts.push(
        '<button type="button" data-act="disable" data-id="' + user.user_id + '">Disable</button>'
      );
    }
    if (user.status === 'disabled') {
      parts.push(
        '<button type="button" class="mro-admin-approve" data-act="approve" data-id="' +
          user.user_id +
          '">Re-approve</button>'
      );
    }
    parts.push(
      '<button type="button" data-act="edit" data-id="' + user.user_id + '">Edit</button>'
    );
    return parts.join(' ');
  }

  function renderUsers(users) {
    usersCache = users || [];
    if (!bodyEl) return;
    if (!usersCache.length) {
      bodyEl.innerHTML = '';
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.textContent = 'No users match this filter.';
      }
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    bodyEl.innerHTML = usersCache
      .map(function (u) {
        return (
          '<tr>' +
          '<td>' +
          escapeHtml(u.username) +
          '</td>' +
          '<td>' +
          escapeHtml(u.display_name || '') +
          '</td>' +
          '<td>' +
          escapeHtml(u.role || '') +
          '</td>' +
          '<td>' +
          escapeHtml(u.default_shift || '-') +
          '</td>' +
          '<td>' +
          escapeHtml(u.status) +
          '</td>' +
          '<td>' +
          escapeHtml(formatWhen(u.created_at)) +
          '</td>' +
          '<td>' +
          escapeHtml(formatWhen(u.last_login_at)) +
          '</td>' +
          '<td class="mro-admin-actions">' +
          actionButtons(u) +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  async function loadUsers() {
    const status = filterEl ? filterEl.value : '';
    const qs = status ? '?status=' + encodeURIComponent(status) : '';
    try {
      const res = await adminFetch(API + qs);
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        if (emptyEl) {
          emptyEl.hidden = false;
          emptyEl.textContent = data.error || 'Failed to load users.';
        }
        bodyEl.innerHTML = '';
        return;
      }
      setBadge(pendingBadge, data.pending_count);
      const users = data.users || [];
      renderUsers(users);
      if (!users.length && emptyEl) {
        emptyEl.hidden = false;
        if (status === 'pending') {
          emptyEl.textContent =
            'No pending accounts. Switch Status to All or Approved to see existing users.';
        } else if (status) {
          emptyEl.textContent = 'No users with status "' + status + '".';
        } else {
          emptyEl.textContent = 'No users yet. Create one above.';
        }
      }
    } catch (err) {
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.textContent = err.message || 'Failed to load users.';
      }
    }
  }

  async function postAction(url) {
    try {
      const res = await adminFetch(url, { method: 'POST', body: '{}' });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        alert(data.error || 'Action failed');
        return;
      }
      await loadUsers();
    } catch (err) {
      alert(err.message || 'Action failed');
    }
  }

  function openEdit(user) {
    if (!user || !editDialog) return;
    document.getElementById('sm-edit-user-id').value = user.user_id;
    document.getElementById('sm-edit-display').value = user.display_name || '';
    document.getElementById('sm-edit-role').value = user.role || 'operator';
    document.getElementById('sm-edit-shift').value = user.default_shift || '';
    document.getElementById('sm-edit-password').value = '';
    document.getElementById('sm-edit-subtitle').textContent =
      user.username + ' | ' + user.status;
    setStatus(editStatus, '', true);
    if (saveApproveBtn) {
      saveApproveBtn.hidden = user.status === 'approved';
    }
    editDialog.showModal();
  }

  function buildEditPayload() {
    const password = document.getElementById('sm-edit-password').value || '';
    if (password && password.length < 4) {
      throw new Error('Password/PIN must be at least 4 characters (or leave blank).');
    }
    const payload = {
      display_name: document.getElementById('sm-edit-display').value,
      role: document.getElementById('sm-edit-role').value,
      default_shift: document.getElementById('sm-edit-shift').value,
    };
    if (password) payload.password = password;
    return payload;
  }

  async function saveEdit(alsoApprove) {
    const userId = document.getElementById('sm-edit-user-id').value;
    if (!userId) {
      setStatus(editStatus, 'Missing user id.', false);
      return;
    }
    let payload;
    try {
      payload = buildEditPayload();
    } catch (err) {
      setStatus(editStatus, err.message, false);
      return;
    }

    setStatus(editStatus, 'Saving...', true);
    if (saveBtn) saveBtn.disabled = true;
    if (saveApproveBtn) saveApproveBtn.disabled = true;

    try {
      const res = await adminFetch(API + '/' + userId, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        setStatus(editStatus, data.error || 'Save failed.', false);
        return;
      }

      if (alsoApprove) {
        const res2 = await adminFetch(API + '/' + userId + '/approve', {
          method: 'POST',
          body: '{}',
        });
        const data2 = await res2.json().catch(function () {
          return {};
        });
        if (!res2.ok) {
          setStatus(
            editStatus,
            'Saved, but approve failed: ' + (data2.error || res2.statusText),
            false
          );
          await loadUsers();
          return;
        }
      }

      editDialog.close();
      // Show approved users too so the change is visible after approve
      if (alsoApprove && filterEl && filterEl.value === 'pending') {
        filterEl.value = 'approved';
      }
      await loadUsers();
    } catch (err) {
      setStatus(editStatus, err.message || 'Save failed.', false);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (saveApproveBtn) saveApproveBtn.disabled = false;
    }
  }

  if (bodyEl) {
    bodyEl.addEventListener('click', function (ev) {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      const act = btn.getAttribute('data-act');
      if (act === 'approve') postAction(API + '/' + id + '/approve');
      else if (act === 'disable') postAction(API + '/' + id + '/disable');
      else if (act === 'edit') {
        const user = usersCache.find(function (u) {
          return String(u.user_id) === String(id);
        });
        openEdit(user);
      }
    });
  }

  if (createForm) {
    createForm.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      const fd = new FormData(createForm);
      const payload = Object.fromEntries(fd.entries());
      setStatus(createStatus, 'Creating...', true);
      try {
        const res = await adminFetch(API, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(function () {
          return {};
        });
        if (!res.ok) {
          setStatus(createStatus, data.error || 'Create failed', false);
          return;
        }
        setStatus(createStatus, 'Created ' + data.user.username + ' (approved)', true);
        createForm.reset();
        if (filterEl) filterEl.value = 'approved';
        await loadUsers();
      } catch (err) {
        setStatus(createStatus, err.message || 'Create failed', false);
      }
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      saveEdit(false);
    });
  }
  if (saveApproveBtn) {
    saveApproveBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      saveEdit(true);
    });
  }
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      editDialog.close();
    });
  }

  const refreshBtn = document.getElementById('sm-users-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', loadUsers);
  if (filterEl) filterEl.addEventListener('change', loadUsers);
  loadUsers();
})();
