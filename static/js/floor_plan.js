// Factory floor plan - HTML tiles with utilization and monthly capacity bookings.

(function () {
  const LAYOUT_WIDTH = 10;
  const LAYOUT_HEIGHT = 12;
  const TILE_INSET = 0.025;
  const MAX_MAP_HEIGHT = 760;
  const MAX_MAP_VH = 0.72;

  const state = {
    payload: null,
    selectedMachineNo: null,
    loading: false,
    psResults: [],
    psActive: -1,
    psSequence: 0,
    psTimer: 0,
    pickedPs: null,
  };

  const els = {
    loading: document.getElementById('fp-loading'),
    error: document.getElementById('fp-error'),
    content: document.getElementById('fp-content'),
    basis: document.getElementById('fp-basis-select'),
    month: document.getElementById('fp-month-input'),
    asOf: document.getElementById('fp-as-of-input'),
    windowLabel: document.getElementById('fp-window-label'),
    groupSummary: document.getElementById('fp-group-summary'),
    legend: document.getElementById('fp-legend'),
    map: document.getElementById('fp-map'),
    detailEmpty: document.getElementById('fp-detail-empty'),
    detailBody: document.getElementById('fp-detail-body'),
    detailTitle: document.getElementById('fp-detail-title'),
    detailMeta: document.getElementById('fp-detail-meta'),
    detailUtil: document.getElementById('fp-detail-util'),
    detailReserved: document.getElementById('fp-detail-reserved'),
    bookingHelp: document.getElementById('fp-booking-help'),
    reservedSummary: document.getElementById('fp-reserved-summary'),
    bookingList: document.getElementById('fp-booking-list'),
    bookingEmpty: document.getElementById('fp-booking-empty'),
    bookingForm: document.getElementById('fp-booking-form'),
    partNo: document.getElementById('fp-part-no'),
    reservedHours: document.getElementById('fp-reserved-hours'),
    tagLabel: document.getElementById('fp-tag-label'),
    tagNotes: document.getElementById('fp-tag-notes'),
    refreshBtn: document.getElementById('fp-refresh-btn'),
    psSearch: document.getElementById('fp-ps-search'),
    psResults: document.getElementById('fp-ps-results'),
    psSearchStatus: document.getElementById('fp-ps-search-status'),
    psPicked: document.getElementById('fp-ps-picked'),
  };

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function currentMonthValue() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  function utilClass(pct) {
    if (pct >= 70) return 'fp-util-badge--high';
    if (pct >= 30) return 'fp-util-badge--mid';
    return 'fp-util-badge--low';
  }

  function formatPct(value) {
    const num = Number(value) || 0;
    return `${num.toFixed(1)}%`;
  }

  function formatHours(value) {
    const num = Number(value) || 0;
    return `${num.toFixed(num % 1 === 0 ? 0 : 1)}h`;
  }

  function selectedMonthLabel() {
    const monthValue = els.month.value || currentMonthValue();
    const [year, month] = monthValue.split('-');
    const date = new Date(Number(year), Number(month) - 1, 1);
    return date.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  }

  function layoutMetrics() {
    const bounds = state.payload?.layout_bounds;
    if (bounds) {
      return {
        minX: Number(bounds.min_x),
        minY: Number(bounds.min_y),
        maxY: Number(bounds.max_y),
        width: Number(bounds.width),
        height: Number(bounds.height),
      };
    }
    return {
      minX: 0,
      minY: 0,
      maxY: LAYOUT_HEIGHT,
      width: Number(state.payload?.layout_width) || LAYOUT_WIDTH,
      height: Number(state.payload?.layout_height) || LAYOUT_HEIGHT,
    };
  }

  function machineTileStyle(machine) {
    const { minX, maxY, width, height } = layoutMetrics();
    const relX = machine.x - minX;
    const relTop = maxY - (machine.y + machine.h);
    const scale = 1 - (2 * TILE_INSET);
    const insetPct = TILE_INSET * 100;
    return [
      `left:calc(${insetPct}% + ${((relX / width) * 100 * scale).toFixed(4)}%)`,
      `top:calc(${insetPct}% + ${((relTop / height) * 100 * scale).toFixed(4)}%)`,
      `width:${((machine.w / width) * 100 * scale).toFixed(4)}%`,
      `height:${((machine.h / height) * 100 * scale).toFixed(4)}%`,
    ].join(';');
  }

  function sizeMapCanvas() {
    if (!els.map || !state.payload) return;
    const { width, height } = layoutMetrics();
    const wrap = els.map.parentElement;
    if (!wrap) return;

    const ratio = width / height;
    const maxH = Math.min(window.innerHeight * MAX_MAP_VH, MAX_MAP_HEIGHT);
    let canvasW = wrap.clientWidth || 640;
    let canvasH = canvasW / ratio;
    if (canvasH > maxH) {
      canvasH = maxH;
      canvasW = canvasH * ratio;
    }

    els.map.style.width = `${Math.floor(canvasW)}px`;
    els.map.style.height = `${Math.floor(canvasH)}px`;
  }

  function tileSizeClass(machine) {
    const narrow = machine.w < machine.h * 0.85;
    const small = Math.min(machine.w, machine.h) <= 0.85;
    const classes = [];
    if (narrow) classes.push('fp-tile--narrow');
    if (small) classes.push('fp-tile--small');
    return classes.join(' ');
  }

  function selectedMachine() {
    if (!state.payload || !state.selectedMachineNo) return null;
    return state.payload.machines.find((m) => m.machine_no === state.selectedMachineNo) || null;
  }

  function planningMonthParts() {
    const monthValue = els.month.value || currentMonthValue();
    const [year, month] = monthValue.split('-');
    return { planning_year: Number(year), planning_month: Number(month) };
  }

  function psDisplayLabel(item) {
    return item.display_ps_id
      || item.planner_ps_id
      || item.source_ps_id
      || item.ps_id
      || '';
  }

  function closePsResults() {
    if (!els.psResults) return;
    els.psResults.hidden = true;
    els.psResults.innerHTML = '';
    state.psResults = [];
    state.psActive = -1;
  }

  function clearPickedPs() {
    state.pickedPs = null;
    if (els.psPicked) {
      els.psPicked.hidden = true;
      els.psPicked.innerHTML = '';
    }
  }

  function resetBookingFormFields() {
    els.partNo.value = '';
    els.reservedHours.value = '';
    els.tagLabel.value = '';
    els.tagNotes.value = '';
    if (els.psSearch) els.psSearch.value = '';
    clearPickedPs();
    closePsResults();
    if (els.psSearchStatus) {
      els.psSearchStatus.textContent = 'Pick a process sheet to fill in the part number and details.';
    }
  }

  function buildBookingNotesFromPs(item) {
    const lines = [];
    const psLabel = psDisplayLabel(item);
    if (psLabel) lines.push(`Process sheet: ${psLabel}`);
    if (item.part_desc) lines.push(item.part_desc);
    if (item.display_qty) lines.push(`Qty ${Number(item.display_qty).toLocaleString()}`);
    if (item.due_date) lines.push(`Due ${String(item.due_date).slice(0, 10)}`);
    if (item.bom_code) lines.push(`BOM ${item.bom_code}`);
    return lines.join(' | ');
  }

  function applyProcessSheet(item) {
    state.pickedPs = item;
    const partNo = compactPartNo(item.part_no);
    if (partNo) els.partNo.value = partNo;
    els.tagLabel.value = psDisplayLabel(item);
    els.tagNotes.value = buildBookingNotesFromPs(item);

    if (els.psPicked) {
      els.psPicked.hidden = false;
      els.psPicked.innerHTML = `
        <strong>${escapeHtml(psDisplayLabel(item))}</strong>
        ${escapeHtml([item.part_no, item.part_desc].filter(Boolean).join(' - ') || 'No part description')}
      `;
    }
    if (els.psSearchStatus) {
      els.psSearchStatus.textContent = 'Details filled from process sheet. Enter reserved hours and save.';
    }
    if (els.psSearch) els.psSearch.value = '';
    closePsResults();
    els.reservedHours.focus();
  }

  function compactPartNo(raw) {
    return String(raw || '').trim().toUpperCase();
  }

  function highlightPsResult() {
    els.psResults.querySelectorAll('.fp-ps-result').forEach((node, index) => {
      node.classList.toggle('is-active', index === state.psActive);
    });
  }

  function renderPsResults(items, message) {
    els.psResults.hidden = false;
    els.psResults.innerHTML = '';
    state.psResults = items;
    state.psActive = items.length ? 0 : -1;

    if (!items.length) {
      els.psResults.innerHTML = `<div class="fp-ps-empty">${escapeHtml(message || 'No matching process sheets.')}</div>`;
      return;
    }

    items.forEach((item, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `fp-ps-result${index === 0 ? ' is-active' : ''}`;
      btn.setAttribute('role', 'option');
      btn.innerHTML = `
        <strong>${escapeHtml(psDisplayLabel(item))}</strong>
        <span>${escapeHtml([item.part_no, item.part_desc].filter(Boolean).join(' - ') || 'No part information')}</span>
        <small>${escapeHtml([
          item.display_qty ? `Qty ${Number(item.display_qty).toLocaleString()}` : '',
          item.due_date ? `Due ${String(item.due_date).slice(0, 10)}` : '',
        ].filter(Boolean).join(' / '))}</small>
      `;
      btn.addEventListener('mousedown', (event) => {
        event.preventDefault();
        applyProcessSheet(item);
      });
      els.psResults.appendChild(btn);
    });
  }

  async function searchProcessSheets(query) {
    const sequence = ++state.psSequence;
    if (els.psSearchStatus) els.psSearchStatus.textContent = 'Searching...';
    try {
      const res = await fetch(`/api/floor-plan/process-sheets/search?q=${encodeURIComponent(query)}&limit=20`);
      const data = await res.json();
      if (sequence !== state.psSequence) return;
      if (!res.ok) throw new Error(data.error || `Search failed (${res.status})`);
      const items = Array.isArray(data.items) ? data.items : [];
      renderPsResults(items);
      if (els.psSearchStatus) {
        els.psSearchStatus.textContent = items.length
          ? `${items.length} match${items.length === 1 ? '' : 'es'} - select one to fill the form.`
          : 'No process sheets matched that search.';
      }
    } catch (err) {
      if (sequence !== state.psSequence) return;
      renderPsResults([], err.message || 'Search failed.');
      if (els.psSearchStatus) els.psSearchStatus.textContent = err.message || 'Search failed.';
    }
  }

  function queuePsSearch() {
    clearTimeout(state.psTimer);
    const query = (els.psSearch?.value || '').trim();
    if (query.length < 2) {
      closePsResults();
      if (els.psSearchStatus) {
        els.psSearchStatus.textContent = query
          ? 'Type at least 2 characters to search.'
          : 'Pick a process sheet to fill in the part number and details.';
      }
      return;
    }
    state.psTimer = setTimeout(() => searchProcessSheets(query), 220);
  }

  function renderLegend(colors) {
    const items = [
      ['Turnmill', colors.turnmill],
      ['MPP (35/36/41)', colors.mpp],
      ['Turning', colors.turning],
      ['Milling', colors.milling],
    ];
    els.legend.innerHTML = items.map(([name, color]) => `
      <span class="fp-legend-item">
        <span class="fp-legend-swatch" style="background:${escapeHtml(color)}"></span>
        ${escapeHtml(name)}
      </span>
    `).join('');
  }

  function renderGroupSummary(capacity) {
    const groups = capacity?.groups || [];
    els.groupSummary.innerHTML = groups.map((group) => `
      <div class="fp-group-card">
        <span>${escapeHtml(group.label)} ${escapeHtml(group.header_subtitle || '')}</span>
        <strong class="${utilClass(group.effective_utilization_pct)}">${formatPct(group.effective_utilization_pct)}</strong>
      </div>
    `).join('');
  }

  function renderMap() {
    const { machines, layout_colors: colors } = state.payload;
    sizeMapCanvas();

    els.map.innerHTML = machines.map((machine) => {
      const fill = colors[machine.color] || '#ccc';
      const utilPct = Number(machine.effective_utilization_pct) || 0;
      const reservedHours = Number(machine.reserved_hours) || 0;
      const reservedPct = Number(machine.reserved_pct) || 0;
      const utilText = formatPct(utilPct);
      const selected = machine.machine_no === state.selectedMachineNo ? ' is-selected' : '';
      const sizeClass = tileSizeClass(machine);
      const mppClass = machine.color === 'mpp' ? ' fp-tile--mpp' : '';
      const bookings = machine.bookings || [];
      const firstBooking = bookings[0];
      const bookingLabel = firstBooking
        ? (firstBooking.tag_label || firstBooking.part_no)
        : '';
      const bookingExtra = bookings.length > 1 ? ` +${bookings.length - 1}` : '';
      const subtitle = machine.subtitle ? `<span class="fp-tile-sub">${escapeHtml(machine.subtitle)}</span>` : '';
      const reservedLine = reservedHours > 0
        ? `<span class="fp-tile-reserved">${escapeHtml(formatHours(reservedHours))}</span>`
        : '';
      const titleBits = [
        machine.machine_no,
        machine.subtitle ? `(${machine.subtitle})` : '',
        `plan ${utilText}`,
        reservedHours > 0 ? `reserved ${formatHours(reservedHours)} (${formatPct(reservedPct)})` : '',
      ].filter(Boolean).join(' - ');

      return `
        <button
          type="button"
          class="fp-tile ${sizeClass}${mppClass}${selected}"
          style="${machineTileStyle(machine)};background:${escapeHtml(fill)}"
          data-machine-no="${escapeHtml(machine.machine_no)}"
          title="${escapeHtml(titleBits)}"
          aria-label="${escapeHtml(machine.machine_no)}, ${escapeHtml(utilText)} plan util, ${escapeHtml(formatHours(reservedHours))} reserved"
        >
          <span class="fp-tile-no">${escapeHtml(machine.label)}</span>
          ${subtitle}
          <span class="fp-tile-util ${utilClass(utilPct)}">${escapeHtml(utilText)}</span>
          ${reservedLine}
          ${bookingLabel && !sizeClass.includes('fp-tile--small') ? `
            <span class="fp-tile-tag">${escapeHtml(bookingLabel)}${escapeHtml(bookingExtra)}</span>
          ` : ''}
          <span class="fp-tile-bar" style="width:${Math.min(100, utilPct)}%"></span>
          ${reservedHours > 0 ? `<span class="fp-tile-bar fp-tile-bar--reserved" style="width:${Math.min(100, reservedPct)}%"></span>` : ''}
        </button>
      `;
    }).join('');

    els.map.querySelectorAll('.fp-tile').forEach((node) => {
      node.addEventListener('click', () => selectMachine(node.getAttribute('data-machine-no')));
    });
    sizeMapCanvas();
  }

  function renderDetail() {
    const machine = selectedMachine();
    if (!machine) {
      els.detailEmpty.hidden = false;
      els.detailBody.hidden = true;
      return;
    }

    els.detailEmpty.hidden = true;
    els.detailBody.hidden = false;
    els.detailTitle.textContent = machine.machine_no;
    els.detailMeta.textContent = [
      machine.machine_category || 'Unknown category',
      machine.shift_profile || 'STANDARD',
    ].join(' | ');
    els.detailUtil.textContent = `Plan ${formatPct(machine.effective_utilization_pct)}`;
    els.detailUtil.className = `fp-util-badge ${utilClass(machine.effective_utilization_pct)}`;

    const reservedHours = Number(machine.reserved_hours) || 0;
    const reservedPct = Number(machine.reserved_pct) || 0;
    const capacityHours = Number(machine.effective_capacity_hours) || 0;
    els.detailReserved.textContent = `Reserved ${formatPct(reservedPct)}`;
    els.detailReserved.className = `fp-reserved-badge ${utilClass(reservedPct)}`;

    if (els.bookingHelp) {
      els.bookingHelp.textContent =
        `Reserve hours on this machine for ${selectedMonthLabel()}. Multiple parts are allowed; hours sum toward calendar-month capacity.`;
    }

    if (els.reservedSummary) {
      const over = capacityHours > 0 && reservedHours > capacityHours;
      els.reservedSummary.innerHTML = `
        <div class="fp-reserved-summary-row${over ? ' is-over' : ''}">
          <span>Reserved ${escapeHtml(formatHours(reservedHours))} / ${escapeHtml(formatHours(capacityHours))} capacity</span>
          <strong>${escapeHtml(formatPct(reservedPct))}</strong>
        </div>
      `;
    }

    const bookings = machine.bookings || [];
    els.bookingEmpty.hidden = bookings.length > 0;
    els.bookingList.innerHTML = bookings.map((booking) => `
      <li class="fp-tag-item">
        <div class="fp-tag-item-main">
          <strong>${escapeHtml(booking.part_no)}</strong>
          <small>${escapeHtml(formatHours(booking.reserved_hours))} reserved</small>
          ${booking.tag_label ? `<small>${escapeHtml(booking.tag_label)}</small>` : ''}
          ${booking.notes ? `<small>${escapeHtml(booking.notes)}</small>` : ''}
        </div>
        <button type="button" class="btn btn-secondary btn-sm" data-delete-booking="${booking.booking_id}">Remove</button>
      </li>
    `).join('');

    els.bookingList.querySelectorAll('[data-delete-booking]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const bookingId = btn.getAttribute('data-delete-booking');
        btn.disabled = true;
        try {
          await deleteBooking(bookingId);
          await loadFloorPlan({ keepSelection: true });
        } catch (err) {
          alert(err.message || 'Failed to remove booking.');
          btn.disabled = false;
        }
      });
    });
  }

  function renderAll() {
    if (!state.payload) return;
    renderLegend(state.payload.layout_colors || {});
    renderGroupSummary(state.payload.capacity);
    renderMap();
    renderDetail();

    const capacity = state.payload.capacity || {};
    els.windowLabel.textContent = [
      capacity.capacity_window_label || capacity.capacity_basis_label || 'Capacity window',
      capacity.capacity_window_start && capacity.capacity_window_end
        ? `(${capacity.capacity_window_start} to ${capacity.capacity_window_end})`
        : '',
    ].filter(Boolean).join(' ');
  }

  function selectMachine(machineNo) {
    state.selectedMachineNo = machineNo;
    resetBookingFormFields();
    renderMap();
    renderDetail();
  }

  function queryParams() {
    const monthValue = els.month.value || currentMonthValue();
    const [year, month] = monthValue.split('-');
    return new URLSearchParams({
      year,
      month,
      basis: els.basis.value,
      as_of: els.asOf.value || todayIso(),
    });
  }

  async function loadFloorPlan(options = {}) {
    if (state.loading) return;
    state.loading = true;
    els.loading.hidden = false;
    els.error.hidden = true;
    els.content.hidden = true;

    try {
      const res = await fetch(`/api/floor-plan?${queryParams().toString()}`);
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `Request failed (${res.status})`);
      }
      state.payload = payload;
      if (!options.keepSelection || !selectedMachine()) {
        state.selectedMachineNo = payload.machines?.[0]?.machine_no || null;
      }
      els.content.hidden = false;
      renderAll();
      requestAnimationFrame(sizeMapCanvas);
    } catch (err) {
      els.error.hidden = false;
      els.error.textContent = err.message || 'Failed to load floor plan.';
    } finally {
      els.loading.hidden = true;
      state.loading = false;
    }
  }

  async function saveBooking(event) {
    event.preventDefault();
    const machine = selectedMachine();
    if (!machine?.machine_id) {
      alert('This machine is not registered in planner_machines yet.');
      return;
    }

    const monthParts = planningMonthParts();
    const body = {
      machine_id: machine.machine_id,
      planning_year: monthParts.planning_year,
      planning_month: monthParts.planning_month,
      part_no: els.partNo.value.trim(),
      reserved_hours: els.reservedHours.value,
      tag_label: els.tagLabel.value.trim(),
      notes: els.tagNotes.value.trim(),
      as_of: els.asOf.value || todayIso(),
    };

    const res = await fetch('/api/floor-plan/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await res.json();
    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `Save failed (${res.status})`);
    }

    if (payload.warning) {
      alert(payload.warning);
    }

    resetBookingFormFields();
    await loadFloorPlan({ keepSelection: true });
  }

  async function deleteBooking(bookingId) {
    const res = await fetch(`/api/floor-plan/bookings/${encodeURIComponent(bookingId)}`, {
      method: 'DELETE',
    });
    const payload = await res.json();
    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || `Delete failed (${res.status})`);
    }
  }

  function bindEvents() {
    els.refreshBtn.addEventListener('click', () => loadFloorPlan({ keepSelection: true }));
    els.basis.addEventListener('change', () => loadFloorPlan({ keepSelection: true }));
    els.month.addEventListener('change', () => loadFloorPlan({ keepSelection: true }));
    els.asOf.addEventListener('change', () => loadFloorPlan({ keepSelection: true }));
    window.addEventListener('resize', () => {
      if (state.payload) {
        sizeMapCanvas();
      }
    });
    els.bookingForm.addEventListener('submit', async (event) => {
      try {
        await saveBooking(event);
      } catch (err) {
        alert(err.message || 'Failed to save booking.');
      }
    });

    if (els.psSearch) {
      els.psSearch.addEventListener('input', queuePsSearch);
      els.psSearch.addEventListener('focus', queuePsSearch);
      els.psSearch.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          closePsResults();
          return;
        }
        if (!state.psResults.length || els.psResults.hidden) return;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          state.psActive = Math.min(state.psActive + 1, state.psResults.length - 1);
          highlightPsResult();
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          state.psActive = Math.max(state.psActive - 1, 0);
          highlightPsResult();
        } else if (event.key === 'Enter' && state.psActive >= 0) {
          event.preventDefault();
          applyProcessSheet(state.psResults[state.psActive]);
        }
      });
      els.psSearch.addEventListener('blur', () => {
        setTimeout(closePsResults, 150);
      });
    }
  }

  function initDefaults() {
    els.month.value = currentMonthValue();
    els.asOf.value = todayIso();
  }

  initDefaults();
  bindEvents();
  loadFloorPlan();
})();
