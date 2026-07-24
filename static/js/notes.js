(() => {
  'use strict';

  const ADMIN_GATE_TOKEN = String(globalThis.__ADMIN_GATE_TOKEN__ || '').trim();
  const notesNativeFetch = globalThis.fetch.bind(globalThis);

  const state = {
    selected: [],
    results: [],
    active: -1,
    timer: 0,
    sequence: 0,
    details: new Map(),
    editingId: null,
  };
  const get = id => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function notesFetch(input, init) {
    const nextInit = { ...(init || {}) };
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    const isNotesApi = typeof url === 'string' && url.startsWith('/api/notes');
    if (ADMIN_GATE_TOKEN && isNotesApi) {
      nextInit.headers = {
        ...(nextInit.headers || {}),
        'X-Admin-Token': ADMIN_GATE_TOKEN,
      };
    }
    return notesNativeFetch(input, nextInit);
  }

  async function json(url, options) {
    const response = await notesFetch(url, options);
    let data = {};
    try { data = await response.json(); } catch (_) { /* no JSON body */ }
    if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
    return data;
  }

  function psLabel(item) {
    const partial = Number(item.pp_partial_no || 1);
    const base = String(item.source_ps_id || item.ps_id || item.planner_ps_id || '').trim();
    return partial > 1 && !base.includes('::') ? `${base} - Partial ${partial}` : base;
  }

  function setComposerMode(editing) {
    const title = get('new-note-title');
    const save = get('note-save');
    const cancel = get('note-cancel');
    if (editing) {
      title.textContent = 'Edit note';
      save.textContent = 'Save changes';
      cancel.hidden = false;
    } else {
      title.textContent = 'New note';
      save.textContent = 'Add note';
      cancel.hidden = true;
    }
  }

  function clearComposer(message) {
    state.editingId = null;
    get('note-body').value = '';
    state.selected = [];
    renderSelected();
    get('process-sheet-search').value = '';
    closeResults();
    get('process-sheet-search-status').textContent =
      'Select a result to attach it to this note.';
    get('note-form-message').textContent = message || '';
    setComposerMode(false);
  }

  function beginEdit(note) {
    state.editingId = note.note_id;
    get('note-body').value = note.body || '';
    state.selected = (Array.isArray(note.process_sheets) ? note.process_sheets : []).map(tag => ({
      planner_ps_id: tag.planner_ps_id,
      source_ps_id: tag.source_ps_id,
      ps_id: tag.source_ps_id,
      pp_partial_no: tag.pp_partial_no,
      part_no: tag.part_no,
      part_desc: tag.part_desc,
    }));
    renderSelected();
    closeResults();
    get('process-sheet-search').value = '';
    get('process-sheet-search-status').textContent = state.selected.length
      ? `${state.selected.length} process sheet${state.selected.length === 1 ? '' : 's'} attached.`
      : 'Select a result to attach it to this note.';
    get('note-form-message').textContent = 'Editing note - save when ready.';
    setComposerMode(true);
    get('note-body').focus();
    get('note-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderSelected() {
    const host = get('selected-process-sheets');
    host.replaceChildren();
    state.selected.forEach(item => {
      const chip = el('span', 'notes-selected-chip');
      chip.append(el('span', '', psLabel(item)));
      const remove = el('button', '', 'x');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${psLabel(item)}`);
      remove.addEventListener('click', () => {
        state.selected = state.selected.filter(x => x.planner_ps_id !== item.planner_ps_id);
        renderSelected();
      });
      chip.append(remove);
      host.append(chip);
    });
  }

  function closeResults() {
    get('process-sheet-results').hidden = true;
    get('process-sheet-results').replaceChildren();
    state.results = [];
    state.active = -1;
  }

  function chooseResult(index) {
    const item = state.results[index];
    if (!item) return;
    if (!state.selected.some(x => x.planner_ps_id === item.planner_ps_id)) {
      state.selected.push(item);
      renderSelected();
    }
    get('process-sheet-search').value = '';
    get('process-sheet-search-status').textContent =
      `${state.selected.length} process sheet${state.selected.length === 1 ? '' : 's'} attached.`;
    closeResults();
    get('process-sheet-search').focus();
  }

  function highlightResult() {
    get('process-sheet-results').querySelectorAll('[role="option"]').forEach((option, index) => {
      const active = index === state.active;
      option.classList.toggle('is-active', active);
      option.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function renderResults(items, message) {
    const host = get('process-sheet-results');
    host.replaceChildren();
    host.hidden = false;
    state.results = items;
    state.active = items.length ? 0 : -1;
    if (!items.length) {
      host.append(el('div', 'notes-search-empty', message || 'No matching process sheets.'));
      return;
    }
    items.forEach((item, index) => {
      const option = el('button', 'notes-search-option');
      option.type = 'button';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
      option.append(el('strong', '', psLabel(item)));
      option.append(el(
        'span', '',
        [item.part_no, item.part_desc].filter(Boolean).join(' - ') || 'No part information'
      ));
      const meta = [];
      if (item.display_qty) meta.push(`Qty ${Number(item.display_qty).toLocaleString()}`);
      if (item.due_date) meta.push(`Due ${String(item.due_date).slice(0, 10)}`);
      if (meta.length) option.append(el('small', '', meta.join(' / ')));
      option.addEventListener('mousedown', event => {
        event.preventDefault();
        chooseResult(index);
      });
      host.append(option);
    });
  }

  async function search(query) {
    const sequence = ++state.sequence;
    get('process-sheet-search-status').textContent = 'Searching...';
    try {
      const data = await json(
        `/api/notes/process-sheets/search?q=${encodeURIComponent(query)}&limit=20`
      );
      if (sequence !== state.sequence) return;
      const items = Array.isArray(data.items) ? data.items : [];
      renderResults(items);
      get('process-sheet-search-status').textContent = items.length
        ? `${items.length} match${items.length === 1 ? '' : 'es'} - select one to tag it.`
        : 'No process sheets matched that search.';
    } catch (error) {
      if (sequence !== state.sequence) return;
      renderResults([], error.message || 'Search failed.');
      get('process-sheet-search-status').textContent = error.message || 'Search failed.';
    }
  }

  function formatDate(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function detailValue(label, value) {
    const row = el('div', 'notes-detail-value');
    row.append(el('span', '', label));
    row.append(el(
      'strong', '',
      value === null || value === undefined || value === '' ? '-' : String(value)
    ));
    return row;
  }

  function renderDetails(host, data) {
    const summary = data.summary || {};
    host.replaceChildren();
    const heading = el('div', 'notes-detail-heading');
    const title = el('div');
    title.append(el('strong', '', summary.display_ps_id || summary.source_ps_id || summary.ps_id));
    title.append(el(
      'span', '',
      [summary.part_no || summary.inventory_code, summary.part_desc].filter(Boolean).join(' - ')
    ));
    heading.append(title);
    heading.append(el(
      'span',
      'notes-status-pill',
      summary.current_stage_status || summary.planner_status || 'No status'
    ));
    host.append(heading);

    const grid = el('div', 'notes-detail-grid');
    grid.append(
      detailValue('Quantity', Number(summary.display_qty || 0).toLocaleString()),
      detailValue('Due date', String(summary.due_date || '-').slice(0, 10)),
      detailValue('Current stage', summary.current_stage_desc || '-'),
      detailValue('Route', summary.route_label || summary.selected_flow_code || summary.erp_bom_code || '-'),
      detailValue('Planned', Number(summary.planned_qty || 0).toLocaleString()),
      detailValue('Finished', Number(summary.finished_qty || 0).toLocaleString())
    );
    host.append(grid);

    if (summary.remarks) {
      const remarks = el('p', 'notes-detail-remarks');
      remarks.append(el('strong', '', 'Process sheet remarks: '));
      remarks.append(document.createTextNode(summary.remarks));
      host.append(remarks);
    }
    const operations = Array.isArray(summary.ops) ? summary.ops : [];
    if (operations.length) {
      const line = el('p', 'notes-detail-ops');
      line.append(el('strong', '', 'Operations: '));
      line.append(document.createTextNode(
        operations
          .map(op => op.operation_name || op.op_type || op.stage_desc)
          .filter(Boolean)
          .join(' -> ')
      ));
      host.append(line);
    }
  }

  async function toggleDetails(button, host, plannerPsId) {
    if (!host.hidden) {
      host.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      return;
    }
    host.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    host.replaceChildren(el('div', 'notes-detail-loading', 'Loading process sheet information...'));
    try {
      let data = state.details.get(plannerPsId);
      if (!data) {
        data = await json(`/api/process-sheets/${encodeURIComponent(plannerPsId)}/details`);
        state.details.set(plannerPsId, data);
      }
      renderDetails(host, data);
    } catch (error) {
      host.replaceChildren(el(
        'div', 'notes-detail-error', error.message || 'Could not load process sheet.'
      ));
    }
  }

  async function deleteNote(note) {
    const preview = String(note.body || '').trim().slice(0, 80);
    const ok = window.confirm(
      preview
        ? `Delete this note?\n\n${preview}${String(note.body || '').trim().length > 80 ? '…' : ''}`
        : 'Delete this note?'
    );
    if (!ok) return;
    try {
      await json(`/api/notes/${encodeURIComponent(note.note_id)}`, { method: 'DELETE' });
      if (state.editingId === note.note_id) clearComposer('Note deleted.');
      else get('note-form-message').textContent = 'Note deleted.';
      await loadNotes();
    } catch (error) {
      get('note-form-message').textContent = error.message || 'Could not delete note.';
    }
  }

  function renderNotes(notes) {
    const host = get('notes-list');
    host.replaceChildren();
    get('notes-count').textContent = `${notes.length} note${notes.length === 1 ? '' : 's'}`;
    if (!notes.length) {
      host.append(el('div', 'notes-empty', 'No notes yet. Add the first one above.'));
      return;
    }
    notes.forEach(note => {
      const card = el('article', 'note-card');
      if (state.editingId === note.note_id) card.classList.add('is-editing');

      const meta = el('div', 'note-card-meta');
      const stamps = el('div', 'note-card-stamps');
      stamps.append(el('time', '', formatDate(note.created_at)));
      if (note.updated_at && note.updated_at !== note.created_at) {
        stamps.append(el('span', 'note-card-edited', `Edited ${formatDate(note.updated_at)}`));
      }
      meta.append(stamps);

      const actions = el('div', 'note-card-actions');
      const editBtn = el('button', 'note-card-action', 'Edit');
      editBtn.type = 'button';
      editBtn.addEventListener('click', () => beginEdit(note));
      const deleteBtn = el('button', 'note-card-action note-card-action--danger', 'Delete');
      deleteBtn.type = 'button';
      deleteBtn.addEventListener('click', () => deleteNote(note));
      actions.append(editBtn, deleteBtn);
      meta.append(actions);
      card.append(meta, el('p', 'note-card-body', note.body));

      const tags = Array.isArray(note.process_sheets) ? note.process_sheets : [];
      if (tags.length) {
        const tagList = el('div', 'note-card-tags');
        tags.forEach((tag, index) => {
          const group = el('div', 'note-tag-group');
          const button = el('button', 'note-ps-tag');
          button.type = 'button';
          button.setAttribute('aria-expanded', 'false');
          button.append(el('strong', '', psLabel(tag)));
          const part = [tag.part_no, tag.part_desc].filter(Boolean).join(' - ');
          if (part) button.append(el('span', '', part));
          const detail = el('div', 'notes-process-sheet-detail');
          detail.id = `note-${note.note_id}-ps-${index}`;
          detail.hidden = true;
          button.setAttribute('aria-controls', detail.id);
          button.addEventListener('click', () =>
            toggleDetails(button, detail, tag.planner_ps_id)
          );
          group.append(button, detail);
          tagList.append(group);
        });
        card.append(tagList);
      }
      host.append(card);
    });
  }

  async function loadNotes() {
    get('notes-list').replaceChildren(el('div', 'notes-empty', 'Loading notes...'));
    try {
      const data = await json('/api/notes');
      renderNotes(Array.isArray(data.notes) ? data.notes : []);
    } catch (error) {
      get('notes-list').replaceChildren(el(
        'div', 'notes-empty notes-error', error.message || 'Could not load notes.'
      ));
    }
  }

  async function saveNote(event) {
    event.preventDefault();
    const body = get('note-body').value.trim();
    if (!body) return;
    const save = get('note-save');
    const cancel = get('note-cancel');
    const message = get('note-form-message');
    const editingId = state.editingId;
    save.disabled = true;
    cancel.disabled = true;
    message.textContent = editingId ? 'Saving changes...' : 'Saving...';
    try {
      const payload = {
        body,
        process_sheets: state.selected.map(item => ({
          planner_ps_id: item.planner_ps_id,
        })),
      };
      if (editingId) {
        await json(`/api/notes/${encodeURIComponent(editingId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        clearComposer('Note updated.');
      } else {
        await json('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        clearComposer('Note added.');
      }
      await loadNotes();
    } catch (error) {
      message.textContent = error.message || (
        editingId ? 'Could not update note.' : 'Could not save note.'
      );
    } finally {
      save.disabled = false;
      cancel.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    get('note-form').addEventListener('submit', saveNote);
    get('note-cancel').addEventListener('click', () => clearComposer());
    get('notes-refresh').addEventListener('click', loadNotes);
    get('process-sheet-search').addEventListener('input', event => {
      clearTimeout(state.timer);
      const query = event.target.value.trim();
      if (!query) {
        closeResults();
        get('process-sheet-search-status').textContent =
          'Select a result to attach it to this note.';
        return;
      }
      state.timer = setTimeout(() => search(query), 250);
    });
    get('process-sheet-search').addEventListener('keydown', event => {
      if (!state.results.length) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        state.active = (state.active + 1) % state.results.length;
        highlightResult();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        state.active = (state.active - 1 + state.results.length) % state.results.length;
        highlightResult();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        chooseResult(state.active);
      } else if (event.key === 'Escape') {
        closeResults();
      }
    });
    document.addEventListener('click', event => {
      if (!event.target.closest('.notes-search-wrap')) closeResults();
    });
    loadNotes();
  });
})();
