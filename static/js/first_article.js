(() => {
  const API = {
    list: '/api/first-article',
    search: '/api/first-article/search',
    pics: '/api/first-article/pics',
  };
  const CHECK_FIELDS = [
    { prefix: 'tooling', label: 'Tooling' },
    { prefix: 'fixture', label: 'Fixture/Jig' },
    { prefix: 'gauges', label: 'Gauges/CMM' },
  ];

  const state = {
    rows: [],
    pics: [],
    filter: '',
    searchHits: [],
    searchTimer: 0,
    saveTimers: {},
    busy: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function dash(value) {
    const text = String(value == null ? '' : value).trim();
    return text || '\u2014';
  }

  async function api(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function setStatus(id, message, kind) {
    const el = $(id);
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('is-error', kind === 'error');
    el.classList.toggle('is-saved', kind === 'saved');
  }

  function showAlert(message) {
    const el = $('fa-alert');
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || '';
  }

  function rowById(id) {
    return state.rows.find((row) => Number(row.first_article_id) === Number(id));
  }

  function filteredRows() {
    const needle = state.filter.trim().toUpperCase();
    if (!needle) return state.rows;
    return state.rows.filter((row) => {
      const blob = [
        row.process_sheet_no,
        row.pp_voucher_no,
        row.part_no,
        row.part_description,
        row.machine_cnc,
        row.sales_order_no,
        row.remarks,
        ...(row.pics || []).map((pic) => pic.name),
      ].join(' ').toUpperCase();
      return blob.includes(needle);
    });
  }

  function picOptions(selectedIds, includeBlank) {
    const selected = new Set((selectedIds || []).map(Number));
    const unused = state.pics.filter((pic) => !selected.has(Number(pic.pic_id)));
    const blank = includeBlank ? '<option value="">Add PIC...</option>' : '';
    if (!unused.length) {
      return `${blank}<option value="__new">New PIC name...</option>`;
    }
    return `${blank}${unused.map((pic) => (
      `<option value="${escapeHtml(pic.pic_id)}">${escapeHtml(pic.name)}</option>`
    )).join('')}<option value="__new">New PIC name...</option>`;
  }

  function checkCell(row, prefix) {
    const mode = row[`${prefix}_mode`] === 'text' ? 'text' : 'tick';
    const tick = row[`${prefix}_tick`] ? 'checked' : '';
    const text = escapeHtml(row[`${prefix}_text`] || '');
    const control = mode === 'text'
      ? `<input class="fa-check-text" data-fa-field="${prefix}_text" data-id="${row.first_article_id}" value="${text}" placeholder="Note">`
      : `<label class="fa-tick-wrap"><input type="checkbox" data-fa-field="${prefix}_tick" data-id="${row.first_article_id}" ${tick}> Ready</label>`;
    return `
      <div class="fa-check-cell">
        <select data-fa-field="${prefix}_mode" data-id="${row.first_article_id}" aria-label="${prefix} column type">
          <option value="tick"${mode === 'tick' ? ' selected' : ''}>Tick box</option>
          <option value="text"${mode === 'text' ? ' selected' : ''}>Text box</option>
        </select>
        ${control}
      </div>
    `;
  }

  function picCell(row) {
    const chips = (row.pics || []).map((pic) => (
      `<span class="fa-chip">${escapeHtml(pic.name)}
        <button type="button" class="fa-chip-x" data-fa-remove-pic="${pic.pic_id}" data-id="${row.first_article_id}" aria-label="Remove ${escapeHtml(pic.name)}">\u00d7</button>
      </span>`
    )).join('');
    return `
      <div class="fa-pic-chips">${chips || '<span class="fa-muted">None</span>'}</div>
      <div class="fa-pic-add">
        <select data-fa-add-pic data-id="${row.first_article_id}" aria-label="Add PIC">
          ${picOptions(row.pic_ids, true)}
        </select>
      </div>
    `;
  }

  function renderTable() {
    const host = $('fa-table-host');
    const empty = $('fa-empty');
    const body = $('fa-table-body');
    const rows = filteredRows();
    const loading = $('fa-loading');
    if (loading) loading.hidden = true;
    if (!state.rows.length) {
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'No process sheets flagged yet. Search a PS number above to add it.';
      }
      $('fa-subtitle').textContent = 'Flag a process sheet, then track tooling, fixture, gauges, and PIC.';
      return;
    }
    if (!rows.length) {
      if (host) host.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'No flagged jobs match this filter.';
      }
      return;
    }
    if (host) host.hidden = false;
    if (empty) empty.hidden = true;
    body.innerHTML = rows.map((row) => {
      const missing = row.in_sales_orders ? '' : ' is-missing';
      const missingHint = row.in_sales_orders ? '' : ' title="Not found in active S/O management"';
      return `
        <tr class="${missing}" data-id="${row.first_article_id}"${missingHint}>
          <td class="fa-mono">${escapeHtml(dash(row.process_sheet_no))}</td>
          <td class="fa-readonly">${escapeHtml(dash(row.part_no))}</td>
          <td>${escapeHtml(dash(row.part_description))}</td>
          <td class="fa-col-qty">${escapeHtml(dash(row.total_qty))}</td>
          <td class="fa-col-date">${escapeHtml(dash(row.po_due_date))}</td>
          <td>${escapeHtml(dash(row.machine_cnc))}</td>
          <td class="fa-edd">${escapeHtml(dash(row.coway_proposed_edd))}</td>
          <td class="fa-col-pic">${picCell(row)}</td>
          ${CHECK_FIELDS.map((field) => `<td class="fa-col-check">${checkCell(row, field.prefix)}</td>`).join('')}
          <td class="fa-col-remarks">
            <textarea class="fa-remarks" data-fa-field="remarks" data-id="${row.first_article_id}" placeholder="Remarks">${escapeHtml(row.remarks || '')}</textarea>
          </td>
          <td class="fa-col-actions">
            <button type="button" class="fa-btn fa-btn--danger" data-fa-unflag="${row.first_article_id}">Remove</button>
          </td>
        </tr>
      `;
    }).join('');
    $('fa-subtitle').textContent = `${state.rows.length} flagged process sheet${state.rows.length === 1 ? '' : 's'}`;
  }

  function renderPicList() {
    const list = $('fa-pic-list');
    const empty = $('fa-pic-empty');
    if (!list) return;
    if (!state.pics.length) {
      list.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = state.pics.map((pic) => (
      `<li>
        <span>${escapeHtml(pic.name)}</span>
        <button type="button" class="fa-btn fa-btn--danger" data-fa-delete-pic="${pic.pic_id}">Delete</button>
      </li>`
    )).join('');
  }

  function applyRow(updated) {
    if (!updated || !updated.first_article_id) return;
    const index = state.rows.findIndex((row) => Number(row.first_article_id) === Number(updated.first_article_id));
    if (index >= 0) state.rows[index] = updated;
    else state.rows.unshift(updated);
    renderTable();
  }

  async function loadTracker() {
    $('fa-loading').hidden = false;
    showAlert('');
    try {
      const data = await api(API.list);
      state.rows = data.rows || [];
      state.pics = data.pics || [];
      renderPicList();
      renderTable();
    } catch (err) {
      showAlert(err.message || 'Could not load first article tracker');
      $('fa-loading').hidden = true;
    }
  }

  function hideSearch() {
    const list = $('fa-ps-results');
    if (!list) return;
    list.hidden = true;
    list.innerHTML = '';
    $('fa-ps-search')?.setAttribute('aria-expanded', 'false');
  }

  function renderSearchHits(hits, status) {
    const list = $('fa-ps-results');
    if (!list) return;
    list.hidden = false;
    $('fa-ps-search')?.setAttribute('aria-expanded', 'true');
    if (status) {
      list.innerHTML = `<div class="fa-typeahead-status">${escapeHtml(status)}</div>`;
      return;
    }
    if (!hits.length) {
      list.innerHTML = '<div class="fa-typeahead-status">No matching process sheet in active S/O management.</div>';
      return;
    }
    list.innerHTML = hits.map((hit, index) => {
      const flagged = hit.already_flagged;
      const desc = [hit.part_no, hit.part_description].filter(Boolean).join(' | ');
      return `
        <button type="button" class="fa-typeahead-item${flagged ? ' is-flagged' : ''}${index === 0 ? ' is-active' : ''}"
                role="option" data-index="${index}" ${flagged ? 'disabled' : ''}>
          <span class="fa-typeahead-main">
            <span class="fa-typeahead-code">${escapeHtml(hit.process_sheet_no || hit.pp_voucher_no)}</span>
            <span class="fa-typeahead-desc">${escapeHtml(desc || 'No description')}</span>
          </span>
          <span class="fa-typeahead-action">${flagged ? 'Already flagged' : 'Flag'}</span>
        </button>
      `;
    }).join('');
  }

  async function runSearch(query) {
    const needle = String(query || '').trim();
    if (needle.length < 2) {
      hideSearch();
      return;
    }
    renderSearchHits([], 'Searching...');
    try {
      const data = await api(`${API.search}?q=${encodeURIComponent(needle)}`);
      if (String($('fa-ps-search')?.value || '').trim() !== needle) return;
      state.searchHits = data.rows || [];
      renderSearchHits(state.searchHits);
    } catch (err) {
      renderSearchHits([], err.message || 'Search failed');
    }
  }

  async function flagHit(hit) {
    if (!hit || hit.already_flagged) return;
    setStatus('fa-add-status', 'Flagging...');
    try {
      const data = await api(API.list, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          process_sheet_no: hit.process_sheet_no,
          pp_voucher_no: hit.pp_voucher_no,
        }),
      });
      applyRow(data.row);
      $('fa-ps-search').value = '';
      hideSearch();
      setStatus('fa-add-status', data.created ? `Flagged ${data.row.process_sheet_no}` : `${data.row.process_sheet_no} is already flagged`, 'saved');
    } catch (err) {
      setStatus('fa-add-status', err.message || 'Could not flag process sheet', 'error');
    }
  }

  async function savePatch(id, patch) {
    const data = await api(`${API.list}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    applyRow(data.row);
    return data.row;
  }

  function queueSave(id, patch, delay) {
    const key = `${id}:${Object.keys(patch).join(',')}`;
    clearTimeout(state.saveTimers[key]);
    state.saveTimers[key] = setTimeout(() => {
      savePatch(id, patch).catch((err) => showAlert(err.message || 'Save failed'));
    }, delay || 0);
  }

  async function addPicName(name) {
    const data = await api(API.pics, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (data.pic && !state.pics.some((pic) => Number(pic.pic_id) === Number(data.pic.pic_id))) {
      state.pics.push(data.pic);
      state.pics.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    renderPicList();
    return data.pic;
  }

  function openPicModal() {
    const modal = $('fa-pic-modal');
    if (!modal) return;
    renderPicList();
    modal.hidden = false;
    $('fa-pic-name')?.focus();
  }

  function closePicModal() {
    const modal = $('fa-pic-modal');
    if (!modal) return;
    modal.hidden = true;
  }

  function bind() {
    $('fa-refresh')?.addEventListener('click', () => loadTracker());
    $('fa-manage-pics')?.addEventListener('click', openPicModal);
    $('fa-pic-modal-close')?.addEventListener('click', closePicModal);
    $('fa-pic-modal')?.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'fa-pic-modal') closePicModal();
    });

    $('fa-filter')?.addEventListener('input', (e) => {
      state.filter = e.target.value || '';
      renderTable();
    });

    $('fa-ps-search')?.addEventListener('input', (e) => {
      clearTimeout(state.searchTimer);
      const value = e.target.value || '';
      state.searchTimer = setTimeout(() => runSearch(value), 220);
    });
    $('fa-ps-search')?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideSearch();
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = state.searchHits.find((hit) => !hit.already_flagged);
        if (first) flagHit(first);
      }
    });
    $('fa-ps-results')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.fa-typeahead-item');
      if (!btn || btn.disabled) return;
      const hit = state.searchHits[Number(btn.getAttribute('data-index'))];
      flagHit(hit);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.fa-typeahead')) hideSearch();
    });

    $('fa-table-body')?.addEventListener('change', async (e) => {
      const addPic = e.target.closest('[data-fa-add-pic]');
      if (addPic) {
        const id = addPic.getAttribute('data-id');
        const value = addPic.value;
        addPic.value = '';
        if (!value) return;
        try {
          let picId = value;
          if (value === '__new') {
            const name = window.prompt('PIC name');
            if (!name || !name.trim()) return;
            const pic = await addPicName(name.trim());
            picId = pic && pic.pic_id;
          }
          const row = rowById(id);
          const next = Array.from(new Set([...(row?.pic_ids || []), Number(picId)])).filter(Boolean);
          await savePatch(id, { pic_ids: next });
        } catch (err) {
          showAlert(err.message || 'Could not add PIC');
        }
        return;
      }
      const fieldEl = e.target.closest('[data-fa-field]');
      if (!fieldEl) return;
      const id = fieldEl.getAttribute('data-id');
      const field = fieldEl.getAttribute('data-fa-field');
      let value = fieldEl.type === 'checkbox' ? fieldEl.checked : fieldEl.value;
      const patch = { [field]: value };
      try {
        await savePatch(id, patch);
      } catch (err) {
        showAlert(err.message || 'Save failed');
      }
    });

    $('fa-table-body')?.addEventListener('input', (e) => {
      const fieldEl = e.target.closest('[data-fa-field]');
      if (!fieldEl) return;
      if (fieldEl.tagName !== 'TEXTAREA' && !fieldEl.classList.contains('fa-check-text')) return;
      const id = fieldEl.getAttribute('data-id');
      const field = fieldEl.getAttribute('data-fa-field');
      queueSave(id, { [field]: fieldEl.value }, 450);
    });

    $('fa-table-body')?.addEventListener('click', async (e) => {
      const unflag = e.target.closest('[data-fa-unflag]');
      if (unflag) {
        const id = Number(unflag.getAttribute('data-fa-unflag'));
        const row = rowById(id);
        if (!window.confirm(`Remove ${row?.process_sheet_no || 'this process sheet'} from the tracker?`)) return;
        try {
          await api(`${API.list}/${id}`, { method: 'DELETE' });
          state.rows = state.rows.filter((item) => Number(item.first_article_id) !== id);
          renderTable();
        } catch (err) {
          showAlert(err.message || 'Could not remove row');
        }
        return;
      }
      const removePic = e.target.closest('[data-fa-remove-pic]');
      if (removePic) {
        const id = removePic.getAttribute('data-id');
        const picId = Number(removePic.getAttribute('data-fa-remove-pic'));
        const row = rowById(id);
        const next = (row?.pic_ids || []).filter((value) => Number(value) !== picId);
        try {
          await savePatch(id, { pic_ids: next });
        } catch (err) {
          showAlert(err.message || 'Could not remove PIC');
        }
      }
    });

    $('fa-pic-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('fa-pic-name');
      const name = String(input?.value || '').trim();
      if (!name) return;
      try {
        const pic = await addPicName(name);
        input.value = '';
        setStatus('fa-pic-status', pic && pic.name ? `Saved ${pic.name}` : 'Saved', 'saved');
        renderTable();
      } catch (err) {
        setStatus('fa-pic-status', err.message || 'Could not add PIC', 'error');
      }
    });

    $('fa-pic-list')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-fa-delete-pic]');
      if (!btn) return;
      const picId = Number(btn.getAttribute('data-fa-delete-pic'));
      const pic = state.pics.find((item) => Number(item.pic_id) === picId);
      if (!window.confirm(`Delete ${pic?.name || 'this PIC'} from the list?`)) return;
      try {
        await api(`${API.pics}/${picId}`, { method: 'DELETE' });
        state.pics = state.pics.filter((item) => Number(item.pic_id) !== picId);
        state.rows = state.rows.map((row) => {
          const picIds = (row.pic_ids || []).filter((value) => Number(value) !== picId);
          return {
            ...row,
            pic_ids: picIds,
            pics: (row.pics || []).filter((item) => Number(item.pic_id) !== picId),
          };
        });
        renderPicList();
        renderTable();
        setStatus('fa-pic-status', `Removed ${pic?.name || 'PIC'}`, 'saved');
      } catch (err) {
        setStatus('fa-pic-status', err.message || 'Could not delete PIC', 'error');
      }
    });
  }

  bind();
  loadTracker();
})();
