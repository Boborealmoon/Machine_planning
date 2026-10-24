(function () {
  const config = window.AUK_OEE_CONFIG || {};
  const refreshToastEl = document.getElementById('auk-oee-refresh-toast');
  const gridEl = document.getElementById('auk-oee-grid');
  const metaEl = document.getElementById('auk-oee-meta');
  const alertEl = document.getElementById('auk-oee-alert');
  const fromEl = document.getElementById('auk-oee-from');
  const toEl = document.getElementById('auk-oee-to');
  const fromFieldEl = document.getElementById('auk-oee-from-field');
  const toFieldEl = document.getElementById('auk-oee-to-field');
  const shiftPickEl = document.getElementById('auk-oee-shift-pick');
  const shiftDateEl = document.getElementById('auk-oee-shift-date');
  const shiftPmEl = document.getElementById('auk-oee-shift-pm');
  const shiftAmLabelEl = document.getElementById('auk-oee-shift-am-label');
  const shiftPmLabelEl = document.getElementById('auk-oee-shift-pm-label');
  const refreshBtn = document.getElementById('auk-oee-refresh');
  const presetButtons = Array.from(document.querySelectorAll('.auk-oee-preset[data-preset]'));

  const LIVE_REFRESH_MS = 60 * 1000;
  let activePreset = 'day';
  let syncingRange = false;
  let refreshTimer = null;
  let hasLoadedOnce = false;
  let dashboardData = null;
  let historyData = null;
  let layout = null;
  let savedSnapshot = '';
  let arranging = false;
  let dragState = null;

  const arrangeBtn = document.getElementById('auk-oee-arrange');
  const doneBtn = document.getElementById('auk-oee-done');
  const cancelBtn = document.getElementById('auk-oee-cancel');
  const addBtn = document.getElementById('auk-oee-add');
  const alertMinutesEl = document.getElementById('auk-oee-alert-minutes');
  const lowEl = document.getElementById('auk-oee-low');
  const paletteEl = document.getElementById('auk-oee-palette');
  const floorEl = document.getElementById('auk-oee-floor');
  const calendarEl = document.getElementById('auk-oee-calendar');
  const subtitleEl = document.getElementById('auk-oee-subtitle');
  const viewButtons = Array.from(document.querySelectorAll('[data-view]'));
  let viewMode = 'cards';
  let dashboardLoadSeq = 0;

  const PRESET_LABELS = {
    day: '1 day',
    shift: 'Shift (live)',
    last_1h: 'Last 1 hour',
    last_24h: 'Last 24 hours',
    custom: 'Custom',
  };

  const GROUP_ACCENTS = {
    overall: '#475467',
    turning: '#1570ef',
    milling: '#7a5af8',
    multiaxis: '#099250',
    mpp: '#dd2590',
    other: '#667085',
  };

  const LOSS_LABELS = {
    us: 'Unscheduled',
    pd: 'Planned downtime',
    bd: 'Breakdowns',
    st: 'Setup',
    uu: 'Un-utilised',
    ms: 'Minor stops',
    sl: 'Speed loss',
    ef: 'Effective',
    rj: 'Rejects',
    rw: 'Rework',
    na: 'No data',
  };

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function toLocalInputValue(iso) {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    return [
      dt.getFullYear(),
      pad2(dt.getMonth() + 1),
      pad2(dt.getDate()),
    ].join('-') + 'T' + pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
  }

  function localInputToIso(value) {
    if (!value) return '';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toISOString();
  }

  function fmtPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return `${n.toFixed(2)}%`;
  }

  function fmtPctShort(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const text = Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
    return `${text}%`;
  }

  function toneForPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 'bad';
    if (n >= 85) return 'good';
    if (n >= 55) return 'warn';
    return 'bad';
  }

  function metricTone(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'muted';
    if (n >= 85) return 'good';
    if (n >= 55) return 'warn';
    return 'bad';
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderMetric(label, value) {
    const pct = Math.max(0, Math.min(100, Number(value) || 0));
    const tone = metricTone(pct);
    return `
      <div class="auk-oee-metric">
        <span class="auk-oee-metric__label">${label}</span>
        <div class="auk-oee-metric__bar">
          <div class="auk-oee-metric__fill auk-oee-metric__fill--${tone}" style="width:${pct}%"></div>
        </div>
        <span class="auk-oee-metric__value">${fmtPct(value)}</span>
      </div>
    `;
  }

  function renderCompactMetric(label, value) {
    const pct = Math.max(0, Math.min(100, Number(value) || 0));
    const tone = metricTone(pct);
    return `
      <div class="auk-oee-compact-metric">
        <span class="auk-oee-compact-metric__label">${label}</span>
        <div class="auk-oee-compact-metric__bar">
          <div class="auk-oee-metric__fill auk-oee-metric__fill--${tone}" style="width:${pct}%"></div>
        </div>
        <span class="auk-oee-compact-metric__value">${fmtPct(value)}</span>
      </div>
    `;
  }

  function renderDonut(oee, sizeClass) {
    const tone = toneForPct(oee);
    const pct = Math.max(0, Math.min(100, Number(oee) || 0));
    const size = sizeClass ? ` ${sizeClass}` : '';
    return `
      <div class="auk-oee-donut auk-oee-donut--${tone}${size}" style="--pct:${pct}">
        <div class="auk-oee-donut__center">
          <span class="auk-oee-donut__value">${sizeClass && sizeClass.indexOf('card') >= 0 ? fmtPctShort(oee) : fmtPct(oee)}</span>
          <span class="auk-oee-donut__label">OEE</span>
        </div>
      </div>
    `;
  }

  function renderSummaryChip(card) {
    const title = card.title || card.label || 'Untitled';
    const tone = toneForPct(card.oee_pct);
    return `
      <div class="auk-oee-summary-chip auk-oee-summary-chip--${tone}" title="Auk pareto group block · reference only">
        <span class="auk-oee-summary-chip__name">${escapeHtml(title)}</span>
        <strong class="auk-oee-summary-chip__oee">${fmtPct(card.oee_pct)}</strong>
      </div>
    `;
  }

  function renderHeroCard(card) {
    const title = card.title || card.label || 'Plant overview';
    const tone = toneForPct(card.oee_pct);
    return `
      <article class="auk-oee-hero-card auk-oee-hero-card--${tone}">
        <div class="auk-oee-hero-card__body">
          <div class="auk-oee-hero-card__text">
            <h2 class="auk-oee-hero-card__title">${escapeHtml(title)}</h2>
            <p class="auk-oee-hero-card__sub">Factory dashboard OEE</p>
          </div>
          ${renderDonut(card.oee_pct, 'auk-oee-donut--hero')}
        </div>
        <div class="auk-oee-hero-card__metrics">
          ${renderMetric('Loading', card.loading_pct)}
          ${renderMetric('Availability', card.availability_pct)}
          ${renderMetric('Performance', card.performance_pct)}
          ${renderMetric('Quality', card.quality_pct)}
        </div>
      </article>
    `;
  }

  function renderLossGrid(losses) {
    const entries = Object.entries(losses || {}).filter(([, value]) => Number.isFinite(Number(value)));
    if (!entries.length) {
      return '<div class="auk-oee-loss-grid auk-oee-loss-grid--empty">No hourly loss breakdown for this range.</div>';
    }
    return `
      <div class="auk-oee-loss-grid">
        ${entries.map(([key, value]) => `
          <div class="auk-oee-loss-cell">
            <span class="auk-oee-loss-cell__key">${escapeHtml(LOSS_LABELS[key] || key.toUpperCase())}</span>
            <strong class="auk-oee-loss-cell__val">${fmtPct(value)}</strong>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderHourlyOeeBar(slots) {
    if (!Array.isArray(slots) || !slots.length) {
      return '<div class="auk-oee-hourly auk-oee-hourly--empty">No hourly OEE slots.</div>';
    }
    const cells = slots.map((slot) => {
      const oee = (slot && slot.oee) || {};
      const ef = Number(oee.ef) || 0;
      const sl = Number(oee.sl) || 0;
      const loss = Math.max(0, 100 - ef - sl);
      const label = slot.start
        ? new Date(slot.start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : '';
      return `
        <div class="auk-oee-hourly__cell" title="${escapeHtml(label)}">
          <div class="auk-oee-hourly__stack">
            <span class="auk-oee-hourly__ef" style="height:${ef}%"></span>
            <span class="auk-oee-hourly__sl" style="height:${sl}%"></span>
            <span class="auk-oee-hourly__loss" style="height:${loss}%"></span>
          </div>
        </div>
      `;
    }).join('');
    return `<div class="auk-oee-hourly" aria-label="Hourly OEE">${cells}</div>`;
  }

  function renderChartSummary(charts) {
    if (!Array.isArray(charts) || !charts.length) return '';
    return `
      <div class="auk-oee-chart-summary">
        ${charts.map((ch) => `
          <div class="auk-oee-chart-summary__row">
            <span class="auk-oee-chart-summary__name">${escapeHtml(ch.title || `Chart ${ch.chart_id}`)}</span>
            <span class="auk-oee-chart-summary__id">#${ch.chart_id}</span>
            <strong class="auk-oee-chart-summary__val">${ch.last_value != null ? Number(ch.last_value).toFixed(2) : '—'}</strong>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderMachineDetail(card, assetDetail) {
    const meta = [
      card.asset_id != null ? `Asset ${card.asset_id}` : null,
      card.block_id != null ? `Block ${card.block_id}` : null,
      card.std_time_hrs != null ? `Std ${Number(card.std_time_hrs).toFixed(1)}h` : null,
      card.hourly_slots != null ? `${card.hourly_slots} hourly slots` : null,
    ].filter(Boolean);
    const charts = assetDetail?.charts || (Array.isArray(card.charts) ? card.charts : []);
    const chartMeta = charts.length
      ? renderChartSummary(charts)
      : '';
    const hourly = assetDetail?.hourly_oee ? renderHourlyOeeBar(assetDetail.hourly_oee) : '';
    const loading = assetDetail === undefined && card.asset_id != null
      ? '<div class="auk-oee-row__loading">Loading chart data…</div>'
      : '';
    const assetError = assetDetail?.error
      ? `<div class="auk-oee-row__error">${escapeHtml(assetDetail.error)}</div>`
      : '';

    return `
      <div class="auk-oee-row__detail">
        <div class="auk-oee-row__detail-metrics">
          ${renderCompactMetric('LOA', card.loading_pct)}
          ${renderCompactMetric('AVA', card.availability_pct)}
          ${renderCompactMetric('PER', card.performance_pct)}
          ${renderCompactMetric('QUA', card.quality_pct)}
        </div>
        ${hourly}
        ${meta.length ? `<div class="auk-oee-row__meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
        ${loading}
        ${assetError}
        ${chartMeta}
        <div class="auk-oee-row__loss-title">Pareto loss breakdown (avg per hour)</div>
        ${renderLossGrid(card.losses)}
      </div>
    `;
  }

  function renderMachineRow(card, rank) {
    const oee = card.oee_pct;
    const tone = toneForPct(oee);
    const title = card.title || card.label || 'Untitled';
    const typeBadge = card.machine_type
      ? `<span class="auk-oee-row__type">${escapeHtml(card.machine_type)}</span>`
      : '';
    const error = card.error
      ? `<div class="auk-oee-row__error">${escapeHtml(card.error)}</div>`
      : '';
    const inactive = !Number.isFinite(Number(oee)) || Number(oee) <= 0;
    const assetAttr = card.asset_id != null ? ` data-asset-id="${card.asset_id}"` : '';

    return `
      <details class="auk-oee-row-wrap auk-oee-row-wrap--${tone}${inactive ? ' auk-oee-row-wrap--inactive' : ''}"${assetAttr}>
        <summary class="auk-oee-row auk-oee-row--${tone}${inactive ? ' auk-oee-row--inactive' : ''}">
          <div class="auk-oee-row__rank">${rank}</div>
          <div class="auk-oee-row__identity">
            <div class="auk-oee-row__name">${escapeHtml(title)}</div>
            ${typeBadge}
            ${error}
          </div>
          <div class="auk-oee-row__oee">
            ${renderDonut(oee, 'auk-oee-donut--sm')}
          </div>
          <div class="auk-oee-row__metrics">
            ${renderCompactMetric('AVA', card.availability_pct)}
            ${renderCompactMetric('PER', card.performance_pct)}
          </div>
          <div class="auk-oee-row__secondary" title="Loading, un-utilised &amp; quality">
            <span>LOA ${fmtPct(card.loading_pct)}</span>
            <span>UU ${fmtPct(card.unutilised_pct)}</span>
          </div>
          <span class="auk-oee-row__expand" aria-hidden="true">▾</span>
        </summary>
        ${renderMachineDetail(card)}
      </details>
    `;
  }

  const assetDetailCache = new Map();

  async function loadAssetDetail(assetId) {
    const key = `${assetId}:${currentQuery()}`;
    if (assetDetailCache.has(key)) return assetDetailCache.get(key);
    const res = await fetch(`/api/auk-oee/asset/${assetId}?${currentQuery()}`);
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_err) {
      throw new Error('Invalid asset detail response');
    }
    if (!res.ok) throw new Error(data.error || `Asset ${assetId} failed (${res.status})`);
    assetDetailCache.set(key, data);
    return data;
  }

  function bindAssetDetailLoaders() {
    gridEl.querySelectorAll('.auk-oee-row-wrap[data-asset-id]').forEach((row) => {
      if (row.dataset.detailBound) return;
      row.dataset.detailBound = '1';
      row.addEventListener('toggle', async () => {
        if (!row.open) return;
        const assetId = row.dataset.assetId;
        if (!assetId || row.dataset.detailLoaded) return;
        const detailEl = row.querySelector('.auk-oee-row__detail');
        if (!detailEl) return;
        try {
          const detail = await loadAssetDetail(assetId);
          const cardJson = row.dataset.card;
          const card = cardJson ? JSON.parse(cardJson) : { asset_id: Number(assetId) };
          detailEl.outerHTML = renderMachineDetail(card, detail);
          row.dataset.detailLoaded = '1';
        } catch (err) {
          const cardJson = row.dataset.card;
          const card = cardJson ? JSON.parse(cardJson) : { asset_id: Number(assetId) };
          detailEl.outerHTML = renderMachineDetail(card, { error: err.message, charts: [] });
        }
      });
    });
  }

  function stampMachineRowCards(cards) {
    gridEl.querySelectorAll('.auk-oee-row-wrap[data-asset-id]').forEach((row) => {
      const assetId = Number(row.dataset.assetId);
      const card = cards.find((c) => Number(c.asset_id) === assetId);
      if (card) row.dataset.card = JSON.stringify(card);
    });
  }

  function splitSectionCards(section) {
    const summaries = Array.isArray(section.summaries)
      ? section.summaries
      : (section.cards || []).filter((c) => c.is_group_summary);
    const machines = Array.isArray(section.machines)
      ? section.machines
      : (section.cards || []).filter((c) => c.is_machine);
    return { summaries, machines };
  }

  function renderOverallSection(section) {
    const accent = GROUP_ACCENTS.overall;
    const { summaries } = splitSectionCards(section);
    const hero = summaries[0] || (section.cards || [])[0];
    if (!hero) return '';

    return `
      <section class="auk-oee-overall" style="--section-accent:${accent}">
        ${renderHeroCard(hero)}
      </section>
    `;
  }

  function renderDepartmentSection(section) {
    const accent = GROUP_ACCENTS[section.id] || GROUP_ACCENTS.other;
    const avg = section.avg_oee_pct != null ? fmtPct(section.avg_oee_pct) : '—';
    const { summaries, machines } = splitSectionCards(section);

    if (!machines.length && !summaries.length) return '';

    const summaryStrip = summaries.length
      ? `
        <div class="auk-oee-ref-block">
          <div class="auk-oee-ref-block__label">Auk reference blocks</div>
          <div class="auk-oee-summary-strip">
            ${summaries.map(renderSummaryChip).join('')}
          </div>
        </div>
      `
      : '';

    const machineList = machines.length
      ? `
        <div class="auk-oee-machine-list">
          <div class="auk-oee-machine-list__head">
            <span class="auk-oee-machine-list__col auk-oee-machine-list__col--rank">#</span>
            <span class="auk-oee-machine-list__col auk-oee-machine-list__col--name">Machine</span>
            <span class="auk-oee-machine-list__col auk-oee-machine-list__col--oee">OEE</span>
            <span class="auk-oee-machine-list__col auk-oee-machine-list__col--metrics">Availability · Performance</span>
            <span class="auk-oee-machine-list__col auk-oee-machine-list__col--secondary">LOA · QUA</span>
          </div>
          ${machines.map((card, idx) => renderMachineRow(card, idx + 1)).join('')}
        </div>
      `
      : '<div class="auk-oee-empty">No machines in this group.</div>';

    return `
      <section class="auk-oee-section" style="--section-accent:${accent}">
        <header class="auk-oee-section__head">
          <div class="auk-oee-section__title-wrap">
            <h2 class="auk-oee-section__title">${escapeHtml(section.title)}</h2>
            <span class="auk-oee-section__count">${machines.length} machine${machines.length === 1 ? '' : 's'}</span>
          </div>
          <div class="auk-oee-section__avg">
            <span class="auk-oee-section__avg-label">Machine avg</span>
            <strong class="auk-oee-section__avg-value">${avg}</strong>
          </div>
        </header>
        ${summaryStrip}
        ${machineList}
      </section>
    `;
  }

  function renderSection(section) {
    if (section.id === 'overall') {
      return renderOverallSection(section);
    }
    return renderDepartmentSection(section);
  }

  function buildGroupsFromCards(cards) {
    const byGroup = new Map();
    for (const card of cards) {
      const id = card.group_id || 'other';
      if (!byGroup.has(id)) byGroup.set(id, []);
      byGroup.get(id).push(card);
    }
    const titles = {
      overall: 'Plant overview',
      turning: 'Turning',
      milling: 'Milling',
      multiaxis: 'Multi-axis',
      mpp: 'MPP',
      other: 'Other',
    };
    const order = ['overall', 'turning', 'milling', 'multiaxis', 'mpp', 'other'];
    return order
      .filter((id) => byGroup.has(id))
      .map((id) => {
        const sectionCards = byGroup.get(id) || [];
        const summaries = sectionCards.filter((c) => c.is_group_summary);
        const machines = sectionCards
          .filter((c) => c.is_machine)
          .sort((a, b) => (Number(a.oee_pct) || -1) - (Number(b.oee_pct) || -1));
        const machineOee = machines
          .map((c) => Number(c.oee_pct))
          .filter((n) => Number.isFinite(n));
        const avg = id === 'overall'
          ? (summaries.find((c) => Number.isFinite(Number(c.oee_pct)))?.oee_pct ?? null)
          : (machineOee.length ? machineOee.reduce((a, b) => a + b, 0) / machineOee.length : null);
        return {
          id,
          title: titles[id] || id,
          summaries,
          machines,
          cards: sectionCards,
          count: machines.length,
          avg_oee_pct: avg,
        };
      });
  }

  function setLoading(isLoading, message) {
    const text = message || (hasLoadedOnce ? 'Refreshing OEE…' : 'Loading OEE…');
    if (refreshToastEl) {
      refreshToastEl.hidden = false;
      refreshToastEl.classList.toggle('is-active', isLoading);
      const label = refreshToastEl.querySelector('.auk-oee-refresh-toast__text');
      if (label) label.textContent = text;
    }
    if (viewMode === 'calendar') {
      if (gridEl) gridEl.hidden = true;
      if (floorEl) floorEl.hidden = true;
      if (calendarEl) calendarEl.hidden = false;
      return;
    }
    const surface = viewMode === 'floor' ? floorEl : gridEl;
    if (!surface) return;
    if (!hasLoadedOnce) {
      if (viewMode === 'floor') {
        if (gridEl) gridEl.hidden = true;
        if (calendarEl) calendarEl.hidden = true;
        surface.hidden = false;
        surface.classList.toggle('auk-oee-floor--initial', isLoading);
      } else {
        if (floorEl) floorEl.hidden = true;
        if (calendarEl) calendarEl.hidden = true;
        surface.hidden = isLoading;
        surface.classList.toggle('auk-oee-grid--initial', isLoading);
        if (isLoading && !surface.innerHTML.trim()) {
          surface.innerHTML = '<span>Loading OEE cards…</span>';
          surface.hidden = false;
        }
      }
      return;
    }
    if (gridEl) gridEl.classList.toggle('auk-oee-grid--refreshing', isLoading && viewMode === 'cards');
    if (floorEl) floorEl.classList.toggle('auk-oee-floor--refreshing', isLoading && viewMode === 'floor');
  }

  function parseApiError(raw, status) {
    if (!raw) return `Server error (${status})`;
    try {
      const data = JSON.parse(raw);
      if (data && data.error) return String(data.error);
    } catch (_err) {
      // plain text / HTML
    }
    return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
  }

  function showAlert(message) {
    if (!message) {
      alertEl.hidden = true;
      alertEl.textContent = '';
      return;
    }
    alertEl.hidden = false;
    alertEl.textContent = message;
  }

  function floorToMinute(date) {
    const d = new Date(date);
    d.setSeconds(0, 0);
    return d;
  }

  function dateInputValue(date) {
    return [
      date.getFullYear(),
      pad2(date.getMonth() + 1),
      pad2(date.getDate()),
    ].join('-');
  }

  function addDaysToDateInput(value, days) {
    const parts = String(value || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return '';
    const dt = new Date(parts[0], parts[1] - 1, parts[2]);
    dt.setDate(dt.getDate() + days);
    return dateInputValue(dt);
  }

  function defaultCustomShift(now = new Date()) {
    const minutes = now.getHours() * 60 + now.getMinutes();
    const night = minutes >= (19 * 60 + 30) || minutes < (9 * 60);
    const date = new Date(now);
    if (night && minutes < (9 * 60)) date.setDate(date.getDate() - 1);
    return { pm: night, date: dateInputValue(date) };
  }

  function updateShiftToggleLabels() {
    const pm = Boolean(shiftPmEl && shiftPmEl.checked);
    if (shiftAmLabelEl) shiftAmLabelEl.classList.toggle('is-active', !pm);
    if (shiftPmLabelEl) shiftPmLabelEl.classList.toggle('is-active', pm);
  }

  function updateCustomShiftVisibility() {
    const custom = activePreset === 'custom';
    if (shiftPickEl) shiftPickEl.hidden = !custom;
    if (fromFieldEl) fromFieldEl.hidden = custom;
    if (toFieldEl) toFieldEl.hidden = custom;
  }

  function ensureCustomShiftDefaults() {
    if (!shiftDateEl || shiftDateEl.value) {
      updateShiftToggleLabels();
      return;
    }
    const defaults = defaultCustomShift();
    shiftDateEl.value = defaults.date;
    if (shiftPmEl) shiftPmEl.checked = defaults.pm;
    updateShiftToggleLabels();
  }

  function customShiftBounds(now = floorToMinute(new Date())) {
    const date = shiftDateEl ? shiftDateEl.value : '';
    if (!date) return { error: 'Pick a shift date.' };
    const pm = Boolean(shiftPmEl && shiftPmEl.checked);
    const from = pm ? `${date}T19:30` : `${date}T08:30`;
    const toDate = pm ? addDaysToDateInput(date, 1) : date;
    const to = pm ? `${toDate}T09:00` : `${date}T20:00`;
    const fromDt = new Date(from);
    const toDt = new Date(to);
    if (Number.isNaN(fromDt.getTime()) || Number.isNaN(toDt.getTime())) {
      return { error: 'Pick a shift date.' };
    }
    if (fromDt > now) {
      return {
        error: pm
          ? 'Night shift starts at 7:30pm on the selected date.'
          : 'Morning shift starts at 8:30am on the selected date.',
      };
    }
    const toValue = toDt > now ? toLocalInputValue(now.toISOString()) : to;
    if (new Date(toValue) <= fromDt) {
      return {
        error: pm
          ? 'Night shift has only just started. Try again in a minute.'
          : 'Morning shift has only just started. Try again in a minute.',
      };
    }
    return { from, to: toValue, pm };
  }

  function setActivePreset(preset) {
    activePreset = preset || 'shift';
    presetButtons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.preset === activePreset);
    });
    if (activePreset === 'custom') ensureCustomShiftDefaults();
    updateCustomShiftVisibility();
    updateShiftToggleLabels();
  }

  function clampToIso(iso) {
    if (!iso) return '';
    const nowIso = floorToMinute(new Date()).toISOString();
    return iso > nowIso ? nowIso : iso;
  }

  function currentQuery() {
    const params = new URLSearchParams();
    if (activePreset !== 'custom') {
      params.set('preset', activePreset);
    } else {
      const bounds = customShiftBounds();
      if (bounds.from && bounds.to) {
        const fromIso = localInputToIso(bounds.from);
        const toIso = clampToIso(localInputToIso(bounds.to));
        if (fromIso) params.set('from', fromIso);
        if (toIso) params.set('to', toIso);
        syncingRange = true;
        fromEl.value = bounds.from;
        toEl.value = bounds.to;
        syncingRange = false;
      }
    }
    params.set('res_x', '15');
    params.set('res_period', 'minutes');
    return params.toString();
  }

  function syncRangeInputs(fromIso, toIso) {
    syncingRange = true;
    if (fromIso) fromEl.value = toLocalInputValue(fromIso);
    if (toIso) toEl.value = toLocalInputValue(toIso);
    syncingRange = false;
  }

  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    const ms = activePreset === 'custom' || activePreset === 'last_24h'
      ? 5 * 60 * 1000
      : LIVE_REFRESH_MS;
    refreshTimer = setInterval(loadDashboard, ms);
  }

  function formatRangeLocal(fromIso, toIso) {
    const fmt = (iso) => {
      const dt = new Date(iso);
      if (Number.isNaN(dt.getTime())) return iso || '';
      return dt.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    };
    return `${fmt(fromIso)} → ${fmt(toIso)}`;
  }

  function alertMinutes() {
    const value = Number(alertMinutesEl && alertMinutesEl.value);
    return [5, 10, 15, 30].includes(value) ? value : 10;
  }

  function cardsById() {
    const map = new Map();
    const cards = (dashboardData && dashboardData.cards) || [];
    cards.forEach((card) => {
      if (card.equipment_id != null) map.set(Number(card.equipment_id), card);
    });
    return map;
  }

  function cloneLayout(source) {
    return JSON.parse(JSON.stringify(source));
  }

  const GRID_COLS = 12;
  const CARD_COLORS = ['red', 'amber', 'green', 'blue', 'violet', 'slate'];
  let suppressClick = false;

  function packCanvas(source) {
    if (!source || !Array.isArray(source.items)) return false;
    const cards = source.items.filter((item) => item.type === 'card');
    if (!cards.length || !cards.some((card) => card.h < 2)) return false;
    cards.forEach((card, index) => {
      card.w = 2;
      card.h = 2;
      card.x = (index % 6) * 2;
      card.y = Math.floor(index / 6) * 2;
    });
    const base = Math.ceil(cards.length / 6) * 2;
    source.items.filter((item) => item.type !== 'card').forEach((item) => {
      item.h = 2;
      item.w = item.type === 'today' ? 6 : 3;
      item.x = item.type === 'today' ? 0 : item.type === 'lowest' ? 6 : 9;
      item.y = base;
    });
    return true;
  }

  function ensureLayout() {
    if (!(layout && Array.isArray(layout.items) && layout.items.length)) {
      const fallback = (dashboardData && dashboardData.default_layout) || { columns: 12, alert_minutes: 10, items: [] };
      layout = cloneLayout(fallback);
      if (alertMinutesEl && layout.alert_minutes) {
        alertMinutesEl.value = String(layout.alert_minutes);
      }
    }
    if (packCanvas(layout)) saveLayout().catch(() => {});
  }

  function placeStyle(item) {
    return `grid-column:${item.x + 1} / span ${item.w};grid-row:${item.y + 1} / span ${item.h};`;
  }

  function cardTone(card) {
    const n = Number(card && card.oee_pct);
    if (!Number.isFinite(n) || n <= 0) return 'idle';
    if (n >= 85) return 'good';
    if (n >= 55) return 'warn';
    return 'bad';
  }

  function renderSwatches(item) {
    if (!arranging || item.type !== 'card') return '';
    const dots = ['auto', ...CARD_COLORS].map((color) => {
      const active = (item.color || 'auto') === color || (!item.color && color === 'auto');
      return `<button type="button" class="auk-oee-swatch auk-oee-swatch--${color}${active ? ' is-active' : ''}" data-color="${color}" aria-label="${color} colour"></button>`;
    }).join('');
    return `<div class="auk-oee-swatches">${dots}</div>`;
  }

  function renderCanvasCard(card) {
    const title = card.title || card.label || 'Machine';
    return `
      <div class="auk-oee-tile auk-oee-tile--canvas auk-oee-tile--${cardTone(card)}">
        <div class="auk-oee-tile__title">${escapeHtml(title)}</div>
        <div class="auk-oee-tile__oee">${fmtPctShort(card.oee_pct)}</div>
        <div class="auk-oee-tile__facts">
          <span>LOA ${fmtPctShort(card.loading_pct)}</span>
          <span>AVA ${fmtPctShort(card.availability_pct)}</span>
          <span>PER ${fmtPctShort(card.performance_pct)}</span>
          <span>QUA ${fmtPctShort(card.quality_pct)}</span>
        </div>
      </div>
    `;
  }

  function renderTodayWidget() {
    const points = (historyData && historyData.plant) || [];
    if (!points.length) {
      return '<p class="auk-oee-widget__empty">The day line fills in as each 15-minute bucket is recorded. The cards above are already live.</p>';
    }
    const width = 360;
    const height = 120;
    const pad = 16;
    const vals = points.map((point) => Number(point.oee) || 0);
    const step = (width - pad * 2) / Math.max(1, vals.length - 1);
    const coords = vals.map((value, index) => {
      const x = pad + index * step;
      const y = pad + (1 - Math.max(0, Math.min(100, value)) / 100) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const last = vals[vals.length - 1];
    return `
      <svg class="auk-oee-line" viewBox="0 0 ${width} ${height}" role="img" aria-label="Plant OEE today">
        <polyline fill="none" stroke="#f04438" stroke-width="2.5" points="${coords}"></polyline>
      </svg>
      <p class="auk-oee-widget__empty">Latest bucket ${fmtPctShort(last)}</p>
    `;
  }

  function renderLowestWidget() {
    const rows = (historyData && historyData.lowest) || [];
    if (!rows.length) {
      const machines = ((dashboardData && dashboardData.cards) || [])
        .filter((card) => card.is_machine && Number(card.loading_pct) > 50)
        .sort((a, b) => (Number(a.oee_pct) || 0) - (Number(b.oee_pct) || 0))
        .slice(0, 5);
      if (!machines.length) {
        return '<p class="auk-oee-widget__empty">Lowest machines show up once a minute of loaded running time is recorded.</p>';
      }
      return machines.map((card) => barRow(card.title || card.label, card.oee_pct)).join('');
    }
    return rows.map((row) => barRow(row.label, row.oee_pct)).join('');
  }

  function barRow(label, oee) {
    const pct = Math.max(0, Math.min(100, Number(oee) || 0));
    return `
      <div class="auk-oee-bar-row">
        <span>${escapeHtml(label || 'Machine')}</span>
        <div class="auk-oee-bar-track"><div style="width:${pct}%"></div></div>
        <strong>${fmtPctShort(oee)}</strong>
      </div>
    `;
  }

  function renderReportWidget() {
    const report = (historyData && historyData.report) || {};
    const low = report.low || [];
    return `
      <div class="auk-oee-report">
        <div><dt>Plant OEE</dt><dd>${fmtPctShort(report.plant_oee)}</dd></div>
        <div><dt>Loaded</dt><dd>${report.loaded_count || 0}/${report.machine_count || 0}</dd></div>
        <div><dt>Under the line</dt><dd>${low.length}</dd></div>
        <div><dt>Watch</dt><dd>${alertMinutes()}m</dd></div>
      </div>
    `;
  }

  function renderWidget(item) {
    const lowIds = new Set(((historyData && historyData.alerts) || []).map((alert) => Number(alert.equipment_id)));
    const cards = cardsById();
    let body = '';
    let title = '';
    let low = false;
    if (item.type === 'card') {
      const card = cards.get(Number(item.equipment_id));
      title = '';
      low = lowIds.has(Number(item.equipment_id));
      body = card
        ? renderCanvasCard(card, low)
        : '<p class="auk-oee-widget__empty">This machine is not on the current Auk dashboard.</p>';
    } else if (item.type === 'today') {
      title = 'Today';
      body = renderTodayWidget();
    } else if (item.type === 'lowest') {
      title = 'Lowest loaded';
      body = renderLowestWidget();
    } else if (item.type === 'report') {
      title = 'This watch';
      body = renderReportWidget();
    }
    const chrome = arranging
      ? `<button type="button" class="auk-oee-widget__remove" data-remove="${escapeHtml(item.id)}" aria-label="Remove">×</button>
         <span class="auk-oee-widget__resize" data-resize="${escapeHtml(item.id)}"></span>`
      : '';
    const heading = title ? `<div class="auk-oee-widget__head"><h2 class="auk-oee-widget__title">${escapeHtml(title)}</h2></div>` : '';
    const pick = item.color ? ` auk-oee-widget--pick-${item.color}` : '';
    return `
      <section class="auk-oee-widget${item.type === 'card' ? ' auk-oee-widget--card' : ''}${pick}${low ? ' is-low' : ''}" data-widget-id="${escapeHtml(item.id)}" style="${placeStyle(item)}">
        ${chrome}
        ${renderSwatches(item)}
        ${heading}
        <div class="auk-oee-widget__body">${body}</div>
      </section>
    `;
  }

  function renderCanvas() {
    if (!gridEl) return;
    ensureLayout();
    gridEl.classList.add('auk-oee-canvas');
    gridEl.classList.toggle('is-arranging', arranging);
    gridEl.classList.remove('auk-oee-grid--initial');
    gridEl.innerHTML = renderGuides() + (layout.items || []).map(renderWidget).join('') + renderDropGhosts();
    gridEl.hidden = false;
    bindCanvas();
    bindCardDetails();
    renderLowBanner();
    renderPalette();
  }

  const FLOOR_TILE_INSET = 0.025;
  const FLOOR_MAX_HEIGHT = 760;
  const CARDS_SUBTITLE = 'Live factory dashboard · refreshes every minute · drag the board to match the floor';
  const FLOOR_SUBTITLE = 'Shop layout. Each machine shows utilisation, OEE, and the first job in its queue.';
  let floorJobs = { available: false, byCnc: {}, lowPct: 40 };
  let floorJobsSeq = 0;
  const CALENDAR_SUBTITLE = 'Monthly OEE by machine, grouped Mon–Sun. Pick a month, then click a name for that month’s timeline.';

  function readSavedView() {
    try {
      const saved = localStorage.getItem('auk-oee-view');
      return saved === 'floor' || saved === 'calendar' ? saved : 'cards';
    } catch (_err) {
      return 'cards';
    }
  }

  function activeFloorLayout() {
    return (dashboardData && dashboardData.floor_layout) || config.floorLayout || null;
  }

  function fmtFloorPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return `${n.toFixed(1)}%`;
  }

  function cardsByCnc() {
    const map = new Map();
    ((dashboardData && dashboardData.cards) || []).forEach((card) => {
      if (!card.is_machine || card.cnc_number == null) return;
      map.set(Number(card.cnc_number), card);
    });
    return map;
  }

  function floorBounds(layoutSource) {
    const bounds = layoutSource && layoutSource.layout_bounds;
    if (bounds && Number(bounds.width) > 0 && Number(bounds.height) > 0) {
      return {
        minX: Number(bounds.min_x),
        maxY: Number(bounds.max_y),
        width: Number(bounds.width),
        height: Number(bounds.height),
      };
    }
    return { minX: 0, maxY: 12, width: 10, height: 12 };
  }

  function floorTileStyle(machine, bounds) {
    const relX = Number(machine.x) - bounds.minX;
    const relTop = bounds.maxY - (Number(machine.y) + Number(machine.h));
    const scale = 1 - (2 * FLOOR_TILE_INSET);
    const insetPct = FLOOR_TILE_INSET * 100;
    return [
      `left:calc(${insetPct}% + ${((relX / bounds.width) * 100 * scale).toFixed(4)}%)`,
      `top:calc(${insetPct}% + ${((relTop / bounds.height) * 100 * scale).toFixed(4)}%)`,
      `width:${((Number(machine.w) / bounds.width) * 100 * scale).toFixed(4)}%`,
      `height:${((Number(machine.h) / bounds.height) * 100 * scale).toFixed(4)}%`,
    ].join(';');
  }

  function floorTileSizeClass(machine) {
    const classes = [];
    const w = Number(machine.w);
    const h = Number(machine.h);
    if (w < h * 0.85) classes.push('auk-floor-tile--narrow');
    if (Math.min(w, h) <= 0.85) classes.push('auk-floor-tile--small');
    if (w * h >= 1.8) classes.push('auk-floor-tile--roomy');
    if (h >= 1.4) classes.push('auk-floor-tile--tall');
    if (w <= 0.7) classes.push('auk-floor-tile--thin');
    return classes.join(' ');
  }

  function lowCutoff() {
    const limit = Number(floorJobs.lowPct);
    return Number.isFinite(limit) ? limit : 40;
  }

  function lowCallouts(card) {
    const cutoff = lowCutoff();
    const reasons = [];
    const loading = Number(card && card.loading_pct);
    const oee = Number(card && card.oee_pct);
    if (Number.isFinite(loading) && loading < cutoff) reasons.push(`Utilisation under ${cutoff}%`);
    if (Number.isFinite(oee) && oee < cutoff) reasons.push(`OEE under ${cutoff}%`);
    return reasons;
  }

  function floorJobFor(cncNumber) {
    if (!floorJobs.available) return undefined;
    const key = String(cncNumber);
    return floorJobs.byCnc[key] || floorJobs.byCnc[cncNumber] || null;
  }

  function renderFloorMeter(label, value, compact) {
    const n = Number(value);
    const known = Number.isFinite(n);
    const pct = known ? Math.max(0, Math.min(100, n)) : 0;
    const tone = known ? metricTone(n) : 'muted';
    const text = compact ? fmtPctShort(value) : fmtFloorPct(value);
    return `
      <span class="auk-floor-meter">
        <span class="auk-floor-meter__k">${label}</span>
        <strong class="auk-floor-meter__v is-${tone}">${text}</strong>
        <span class="auk-floor-meter__track" aria-hidden="true">
          <span class="auk-floor-meter__fill is-${tone}" style="width:${pct}%"></span>
        </span>
      </span>
    `;
  }

  function renderFloorFlag(ready, short, word, title) {
    const state = ready ? 'is-yes' : 'is-no';
    const mark = ready ? '✓' : '×';
    return `
      <span class="auk-floor-flag ${state}" title="${escapeHtml(title)}">
        <span class="auk-floor-flag__mark" aria-hidden="true">${mark}</span>
        <span class="auk-floor-flag__short">${short}</span>
        <span class="auk-floor-flag__long">${word}</span>
      </span>
    `;
  }

  function renderFloorJob(job) {
    if (job === undefined) return '';
    if (!job) {
      return '<span class="auk-floor-tile__job auk-floor-tile__job--empty">No job</span>';
    }
    const sub = job.sub ? `<em>${escapeHtml(job.sub)}</em>` : '';
    const detail = [
      job.part_no ? `Part ${job.part_no}` : '',
      job.process_sheet ? `PS ${job.process_sheet}` : '',
      job.op_no ? `Op ${job.op_no}` : '',
      job.operation_name || '',
    ].filter(Boolean).join(' · ');
    return `<span class="auk-floor-tile__job" title="${escapeHtml(detail)}"><strong>${escapeHtml(job.label || 'Job')}</strong>${sub}</span>`;
  }

  function renderFloorFlags(job) {
    if (!job) return '';
    return `
      <span class="auk-floor-tile__flags">
        ${renderFloorFlag(job.material_in, 'M', 'Mat', job.material_in ? 'Material in' : 'No material')}
        ${renderFloorFlag(job.tooling_ready, 'T', 'Tool', job.tooling_ready ? 'Tooling ready' : 'No tooling')}
        ${renderFloorFlag(job.program_ready, 'P', 'Prog', job.program_ready ? 'Program ready' : 'No program')}
      </span>
    `;
  }

  function sizeFloorCanvas() {
    const canvas = floorEl && floorEl.querySelector('.auk-floor-canvas');
    const layoutSource = activeFloorLayout();
    if (!canvas || !layoutSource) return;
    const bounds = floorBounds(layoutSource);
    const stage = canvas.parentElement;
    if (!stage) return;
    const ratio = bounds.width / bounds.height;
    const maxH = Math.min(window.innerHeight * 0.72, FLOOR_MAX_HEIGHT);
    let canvasW = stage.clientWidth || 640;
    let canvasH = canvasW / ratio;
    if (canvasH > maxH) {
      canvasH = maxH;
      canvasW = canvasH * ratio;
    }
    canvas.style.width = `${Math.floor(canvasW)}px`;
    canvas.style.height = `${Math.floor(canvasH)}px`;
  }

  function renderFloorGroups(layoutSource, byCnc) {
    const groups = layoutSource.groups || [];
    return groups.map((group) => {
      const numbers = (group.cnc_numbers || []).map((value) => Number(value));
      const values = numbers
        .map((number) => byCnc.get(number))
        .filter(Boolean)
        .map((card) => Number(card.oee_pct))
        .filter((value) => Number.isFinite(value));
      const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      const tone = avg == null ? 'idle' : toneForPct(avg);
      const width = avg == null ? 0 : Math.max(0, Math.min(100, avg));
      const subtitle = group.subtitle || `${numbers.length}X`;
      return `
        <article class="auk-floor-group">
          <span class="auk-floor-group__label">${escapeHtml(group.label)} <em>${escapeHtml(subtitle)}</em></span>
          <strong class="auk-floor-group__value">${fmtFloorPct(avg)}</strong>
          <span class="auk-floor-group__metric">avg OEE</span>
          <div class="auk-floor-group__track" aria-hidden="true">
            <span class="auk-floor-group__fill auk-floor-group__fill--${tone}" style="width:${width}%"></span>
          </div>
        </article>
      `;
    }).join('');
  }

  function renderFloorReadinessKey() {
    const limit = Number(floorJobs.lowPct) || 40;
    return `
      <span class="auk-floor-legend__item">
        <span class="auk-floor-alert-sample" aria-hidden="true">!</span>
        Under ${limit}%
      </span>
      <span class="auk-floor-legend__item">
        <span class="auk-floor-flag auk-floor-flag--legend is-yes" title="Ready"><span class="auk-floor-flag__mark">✓</span><span class="auk-floor-flag__long">Mat</span></span>
        in / ready
      </span>
      <span class="auk-floor-legend__item">
        <span class="auk-floor-flag auk-floor-flag--legend is-no" title="Missing"><span class="auk-floor-flag__mark">×</span><span class="auk-floor-flag__long">Mat</span></span>
        missing
      </span>
    `;
  }

  function renderFloorLegend(layoutSource) {
    const colors = layoutSource.layout_colors || {};
    const items = layoutSource.legend || [];
    return items.map((item) => `
      <span class="auk-floor-legend__item">
        <span class="auk-floor-legend__swatch" style="background:${escapeHtml(colors[item.key] || '#ccc')}"></span>
        ${escapeHtml(item.label)}
      </span>
    `).join('');
  }

  function renderFloorTiles(layoutSource, byCnc) {
    const colors = layoutSource.layout_colors || {};
    const bounds = floorBounds(layoutSource);
    const limit = lowCutoff();
    return (layoutSource.machines || []).map((machine) => {
      const card = byCnc.get(Number(machine.cnc_number)) || null;
      const oee = card ? card.oee_pct : null;
      const loading = card ? card.loading_pct : null;
      const fill = colors[machine.color] || '#ccc';
      const equipmentId = card && card.equipment_id != null ? Number(card.equipment_id) : null;
      const tag = equipmentId != null ? 'button' : 'div';
      const selected = equipmentId != null && equipmentId === Number(detailEquipmentId) ? ' is-selected' : '';
      const reasons = lowCallouts(card);
      const low = reasons.length ? ' is-low-util' : '';
      const missing = card ? '' : ' is-missing';
      const sizeClass = floorTileSizeClass(machine);
      const compact = sizeClass.indexOf('auk-floor-tile--tall') < 0;
      const job = floorJobFor(machine.cnc_number);
      const subtitle = machine.subtitle ? `<span class="auk-floor-tile__sub">${escapeHtml(machine.subtitle)}</span>` : '';
      const jobBits = [];
      if (job) {
        jobBits.push(job.label || 'Job');
        jobBits.push(job.material_in ? 'material in' : 'no material');
        jobBits.push(job.tooling_ready ? 'tooling ready' : 'no tooling');
        jobBits.push(job.program_ready ? 'program ready' : 'no program');
      } else if (job === null) {
        jobBits.push('no job in queue');
      }
      const title = [
        machine.machine_no,
        card && card.machine_type ? card.machine_type : '',
        `utilisation ${fmtFloorPct(loading)}`,
        `OEE ${fmtFloorPct(oee)}`,
        reasons.join(' · '),
        ...jobBits,
      ].filter(Boolean).join(' · ');
      const idAttr = equipmentId != null ? ` data-equipment-id="${equipmentId}"` : '';
      const alert = low
        ? `<span class="auk-floor-tile__alert" title="${escapeHtml(reasons.join(' · '))}">!</span>`
        : '';
      const foot = job === undefined
        ? ''
        : `<span class="auk-floor-tile__foot">${renderFloorJob(job)}${renderFloorFlags(job)}</span>`;
      return `
        <${tag}${tag === 'button' ? ' type="button"' : ''}
          class="auk-floor-tile ${sizeClass}${selected}${low}${missing}"
          style="${floorTileStyle(machine, bounds)};background:${escapeHtml(fill)}"
          title="${escapeHtml(title)}"
          aria-label="${escapeHtml(title)}"${idAttr}
        >
          ${alert}
          <span class="auk-floor-tile__no">${escapeHtml(machine.label)}</span>
          ${subtitle}
          <span class="auk-floor-tile__meters">
            ${renderFloorMeter(compact ? 'U' : 'Util', loading, compact)}
            ${renderFloorMeter(compact ? 'O' : 'OEE', oee, compact)}
          </span>
          ${foot}
        </${tag}>
      `;
    }).join('');
  }

  function renderFloorExtras(layoutSource, byCnc) {
    const placed = new Set((layoutSource.machines || []).map((machine) => Number(machine.cnc_number)));
    const extras = ((dashboardData && dashboardData.cards) || []).filter((card) => {
      if (!card.is_machine) return false;
      return card.cnc_number == null || !placed.has(Number(card.cnc_number));
    });
    if (!extras.length) return '';
    const chips = extras.map((card) => {
      const equipmentId = card.equipment_id != null ? Number(card.equipment_id) : null;
      const idAttr = equipmentId != null ? ` data-equipment-id="${equipmentId}"` : '';
      return `
        <button type="button" class="auk-floor-chip"${idAttr}>
          <span>${escapeHtml(card.title || card.label || 'Machine')}</span>
          <strong>${fmtFloorPct(card.oee_pct)}</strong>
        </button>
      `;
    }).join('');
    return `
      <div class="auk-floor-extra">
        <span class="auk-floor-extra__label">Reporting, not on this floor plan</span>
        <div class="auk-floor-extra__list">${chips}</div>
      </div>
    `;
  }

  function renderFloor() {
    if (!floorEl) return;
    const layoutSource = activeFloorLayout();
    floorEl.classList.remove('auk-oee-floor--initial');
    if (!layoutSource || !(layoutSource.machines || []).length) {
      floorEl.innerHTML = '<div class="auk-floor-empty">Floor layout is not available.</div>';
      floorEl.hidden = viewMode !== 'floor';
      return;
    }
    const byCnc = cardsByCnc();
    floorEl.innerHTML = `
      <div class="auk-floor-groups">${renderFloorGroups(layoutSource, byCnc)}</div>
      <section class="auk-floor-panel">
        <div class="auk-floor-legend">${renderFloorLegend(layoutSource)}${renderFloorReadinessKey()}</div>
        <div class="auk-floor-stage">
          <div class="auk-floor-canvas" aria-label="Factory floor plan with live OEE">${renderFloorTiles(layoutSource, byCnc)}</div>
        </div>
        <p class="auk-floor-hint">Colours are the shop layout. Utilisation and OEE are for the selected range. The job is the first one in that machine’s queue. A red ! means utilisation or OEE is under ${lowCutoff()}%.</p>
      </section>
      ${renderFloorExtras(layoutSource, byCnc)}
    `;
    floorEl.hidden = viewMode !== 'floor';
    sizeFloorCanvas();
    renderLowBanner();
  }

  function renderActive() {
    if (viewMode === 'calendar') {
      if (gridEl) gridEl.hidden = true;
      if (floorEl) floorEl.hidden = true;
      renderCalendar();
      return;
    }
    if (calendarEl) calendarEl.hidden = true;
    if (viewMode === 'floor') {
      if (gridEl) gridEl.hidden = true;
      renderFloor();
      return;
    }
    if (floorEl) floorEl.hidden = true;
    if (!dashboardData && !layout) return;
    renderCanvas();
  }

  function syncViewChrome() {
    const cards = viewMode === 'cards';
    viewButtons.forEach((button) => {
      button.classList.toggle('is-active', button.dataset.view === viewMode);
      button.disabled = arranging;
    });
    if (arrangeBtn) arrangeBtn.hidden = !cards || arranging;
    if (subtitleEl) {
      const subtitles = { floor: FLOOR_SUBTITLE, calendar: CALENDAR_SUBTITLE };
      subtitleEl.textContent = subtitles[viewMode] || CARDS_SUBTITLE;
    }
  }

  function setView(mode) {
    if (arranging) return;
    viewMode = mode === 'floor' || mode === 'calendar' ? mode : 'cards';
    try {
      localStorage.setItem('auk-oee-view', viewMode);
    } catch (_err) {
      // private browsing
    }
    syncViewChrome();
    if (viewMode === 'calendar') loadCalendar(false);
    else renderActive();
  }

  let calendarData = null;
  let calendarKey = '';
  let calendarRequest = 0;
  const calendarCollapsed = new Set();

  function heatStyle(value) {
    const pct = Number(value);
    if (!Number.isFinite(pct)) return '';
    const t = Math.max(0, Math.min(100, pct)) / 100;
    const stops = [
      [0, [196, 50, 42]],
      [0.35, [227, 106, 34]],
      [0.62, [242, 193, 75]],
      [0.82, [125, 190, 69]],
      [1, [47, 158, 74]],
    ];
    let left = stops[0];
    let right = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i += 1) {
      if (t >= stops[i][0] && t <= stops[i + 1][0]) {
        left = stops[i];
        right = stops[i + 1];
        break;
      }
    }
    const span = right[0] - left[0] || 1;
    const mix = (t - left[0]) / span;
    const rgb = left[1].map((channel, index) => Math.round(channel + (right[1][index] - channel) * mix));
    const text = (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114) > 150 ? '#101828' : '#fff';
    return `background:rgb(${rgb.join(',')});color:${text}`;
  }

  const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function calendarRowVisible(row, byId) {
    let parentId = row.parent_id;
    while (parentId) {
      if (calendarCollapsed.has(parentId)) return false;
      const parent = byId.get(parentId);
      parentId = parent ? parent.parent_id : null;
    }
    return true;
  }

  function parseLocalDay(iso) {
    if (!iso || typeof iso !== 'string') return null;
    const parts = iso.slice(0, 10).split('-').map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function formatLocalDay(dt) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  function currentCalendarMonth() {
    const input = document.getElementById('auk-oee-cal-month');
    if (input && /^\d{4}-\d{2}$/.test(input.value || '')) return input.value;
    if (calendarData && calendarData.from) return String(calendarData.from).slice(0, 7);
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthBounds(monthValue) {
    const [year, month] = String(monthValue || '').split('-').map(Number);
    if (!year || !month) return null;
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0);
    return { start: formatLocalDay(start), end: formatLocalDay(end), year, month };
  }

  function formatMonthLabel(monthValue) {
    const bounds = monthBounds(monthValue);
    if (!bounds) return monthValue || '';
    return new Date(bounds.year, bounds.month - 1, 1).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
  }

  function formatWeekRangeLabel(slots) {
    const inMonth = slots.filter((slot) => slot.inMonth && slot.day);
    if (!inMonth.length) return 'Week';
    const first = parseLocalDay(inMonth[0].day);
    const last = parseLocalDay(inMonth[inMonth.length - 1].day);
    if (!first || !last) return 'Week';
    const startText = first.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const endText = first.getMonth() === last.getMonth()
      ? String(last.getDate())
      : last.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `${startText} – ${endText}`;
  }

  /** Pad the selected month into Mon–Sun week strips. */
  function calendarWeeks(days, monthValue) {
    const dayIndex = new Map((days || []).map((day, index) => [day, index]));
    const bounds = monthBounds(monthValue || currentCalendarMonth());
    const first = bounds ? parseLocalDay(bounds.start) : parseLocalDay((days || [])[0]);
    const last = bounds ? parseLocalDay(bounds.end) : parseLocalDay((days || [])[(days || []).length - 1]);
    if (!first || !last) return [];

    const cursor = new Date(first);
    const mondayOffset = (cursor.getDay() + 6) % 7; // Monday = 0
    cursor.setDate(cursor.getDate() - mondayOffset);

    const end = new Date(last);
    const sundayOffset = (7 - end.getDay()) % 7; // Sunday = 0 offset from itself
    end.setDate(end.getDate() + sundayOffset);

    const weeks = [];
    while (cursor <= end) {
      const slots = [];
      for (let i = 0; i < 7; i += 1) {
        const day = formatLocalDay(cursor);
        const inMonth = !bounds || (day >= bounds.start && day <= bounds.end);
        slots.push({
          day,
          index: dayIndex.has(day) ? dayIndex.get(day) : -1,
          inMonth,
          weekday: WEEKDAY_LABELS[i],
          dateNum: String(cursor.getDate()).padStart(2, '0'),
        });
        cursor.setDate(cursor.getDate() + 1);
      }
      if (slots.some((slot) => slot.inMonth)) weeks.push(slots);
    }
    return weeks;
  }

  function renderCalendarLabelCell(row) {
    const twist = row.expandable
      ? `<button type="button" class="auk-cal-twist" data-cal-toggle="${escapeHtml(row.id)}" aria-label="${calendarCollapsed.has(row.id) ? 'Expand' : 'Collapse'}">${calendarCollapsed.has(row.id) ? '▸' : '▾'}</button>`
      : '<span class="auk-cal-twist auk-cal-twist--spacer"></span>';
    const nameTag = row.equipment_id != null ? 'button' : 'span';
    const nameAttrs = row.equipment_id != null
      ? ` type="button" class="auk-cal-name is-link" data-cal-open="${Number(row.equipment_id)}" data-cal-label="${escapeHtml(row.label)}"`
      : ' class="auk-cal-name"';
    return `
      <th class="auk-cal-label" style="padding-left:${8 + row.depth * 16}px">
        ${twist}<${nameTag}${nameAttrs}>${escapeHtml(row.label)}</${nameTag}>
      </th>
    `;
  }

  function renderCalendarWeek(week, weekIndex, visibleRows) {
    const dayHeads = week.map((slot) => `
      <th class="auk-cal-day${slot.inMonth ? '' : ' is-outside'}">
        <span class="auk-cal-weekday">${escapeHtml(slot.weekday)}</span>
        <span class="auk-cal-date-num">${escapeHtml(slot.dateNum)}</span>
      </th>
    `).join('');
    const body = visibleRows.map((row) => {
      const cells = week.map((slot) => {
        if (!slot.inMonth || slot.index < 0) {
          return `<td class="auk-cal-cell is-empty${slot.inMonth ? '' : ' is-outside'}"></td>`;
        }
        const value = (row.values || [])[slot.index];
        if (value == null) return '<td class="auk-cal-cell is-empty"></td>';
        return `<td class="auk-cal-cell" style="${heatStyle(value)}" title="${escapeHtml(row.label)} · ${escapeHtml(slot.day)} · ${value}%">${value}</td>`;
      }).join('');
      return `
        <tr class="auk-cal-row${row.is_machine ? '' : ' is-group'}">
          ${renderCalendarLabelCell(row)}
          ${cells}
        </tr>
      `;
    }).join('');
    return `
      <section class="auk-cal-week" aria-label="Week ${weekIndex + 1}">
        <header class="auk-cal-week__head">
          <span class="auk-cal-week__title">Week ${weekIndex + 1}</span>
          <span class="auk-cal-week__range">${escapeHtml(formatWeekRangeLabel(week))}</span>
          <span class="auk-cal-week__span">Mon – Sun</span>
        </header>
        <div class="auk-cal-week__scroll">
          <table class="auk-cal-table auk-cal-table--week">
            <thead>
              <tr>
                <th class="auk-cal-corner"></th>
                ${dayHeads}
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderCalendar() {
    if (!calendarEl) return;
    if (viewMode === 'calendar') {
      if (gridEl) gridEl.hidden = true;
      if (floorEl) floorEl.hidden = true;
      calendarEl.hidden = false;
    } else {
      calendarEl.hidden = true;
      return;
    }
    if (!calendarData) {
      calendarEl.innerHTML = '<p class="auk-cal-status">Loading daily OEE…</p>';
      return;
    }
    if (calendarData.error) {
      calendarEl.innerHTML = `<p class="auk-cal-status">${escapeHtml(calendarData.error)}</p>`;
      return;
    }
    const monthValue = (calendarData.from || currentCalendarMonth()).slice(0, 7);
    const days = calendarData.days || [];
    const rows = calendarData.rows || [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const visibleRows = rows.filter((row) => calendarRowVisible(row, byId));
    const weeks = calendarWeeks(days, monthValue);
    const weekBlocks = weeks.map((week, index) => renderCalendarWeek(week, index, visibleRows)).join('');
    calendarEl.innerHTML = `
      <div class="auk-cal-tools">
        <button type="button" class="auk-cal-nav" data-cal-month="-1" aria-label="Previous month">‹</button>
        <label class="auk-cal-month-field">
          <span class="auk-cal-month-field__label">Month</span>
          <input type="month" class="auk-cal-date auk-cal-month-input" id="auk-oee-cal-month" value="${escapeHtml(monthValue)}" aria-label="Report month">
        </label>
        <button type="button" class="auk-cal-nav" data-cal-month="1" aria-label="Next month">›</button>
        <span class="auk-cal-res">${escapeHtml(formatMonthLabel(monthValue))} · weekly</span>
        <div class="auk-cal-legend">
          <span>0</span>
          <span class="auk-cal-legend__bar" aria-hidden="true"></span>
          <span>100</span>
          <span>OEE</span>
        </div>
      </div>
      <div class="auk-cal-scroll">
        ${weekBlocks || '<p class="auk-cal-status">No days in this month.</p>'}
      </div>
    `;
  }

  function calendarRangeParams() {
    const bounds = monthBounds(currentCalendarMonth());
    const params = new URLSearchParams();
    if (bounds) {
      params.set('from', bounds.start);
      params.set('to', bounds.end);
    }
    return params;
  }

  async function loadCalendar(force) {
    if (!calendarEl || viewMode !== 'calendar') return;
    const params = calendarRangeParams();
    const key = params.toString() || 'default';
    if (!force && calendarData && calendarKey === key && !calendarData.error) {
      renderCalendar();
      return;
    }
    const requestId = ++calendarRequest;
    if (gridEl) gridEl.hidden = true;
    if (floorEl) floorEl.hidden = true;
    calendarEl.hidden = false;
    if (!calendarData || calendarKey !== key) {
      calendarEl.innerHTML = '<p class="auk-cal-status">Loading daily OEE…</p>';
    }
    try {
      const res = await fetch(`/api/auk-oee/calendar?${params}`);
      const data = await res.json();
      if (requestId !== calendarRequest) return;
      if (!res.ok) throw new Error(data.error || 'Could not load daily OEE');
      calendarData = data;
      calendarKey = new URLSearchParams({ from: data.from || '', to: data.to || '' }).toString();
      renderCalendar();
    } catch (err) {
      if (requestId !== calendarRequest) return;
      if (calendarData && calendarData.rows) {
        showAlert(err.message || 'Could not load daily OEE');
        renderCalendar();
        return;
      }
      calendarData = { error: err.message || 'Could not load daily OEE' };
      renderCalendar();
    }
  }

  function shiftCalendarMonth(delta) {
    const input = document.getElementById('auk-oee-cal-month');
    const source = (input && input.value) || currentCalendarMonth();
    const [year, month] = source.split('-').map(Number);
    if (!year || !month) return;
    const next = new Date(year, month - 1 + delta, 1);
    const value = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
    if (input) input.value = value;
    loadCalendar(true);
  }

  function markFloorSelection() {
    if (!floorEl || viewMode !== 'floor') return;
    floorEl.querySelectorAll('.auk-floor-tile').forEach((node) => {
      const id = Number(node.getAttribute('data-equipment-id'));
      node.classList.toggle('is-selected', id && id === Number(detailEquipmentId));
    });
  }

  const modalEl = document.getElementById('auk-oee-modal');
  const modalTitleEl = document.getElementById('auk-oee-modal-title');
  const modalSubEl = document.getElementById('auk-oee-modal-sub');
  const modalBodyEl = document.getElementById('auk-oee-modal-body');
  let detailEquipmentId = null;
  let detailRes = '60';
  let detailPayload = null;
  let detailSelected = null;

  function segmentTone(oee) {
    const n = Number(oee);
    if (!Number.isFinite(n) || n <= 0) return 'idle';
    if (n >= 85) return 'good';
    if (n >= 55) return 'warn';
    return 'bad';
  }

  function formatSlotTime(iso) {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function detailNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function slotMinutes() {
    return detailRes === '15' ? 15 : 60;
  }

  function formatSlotWindow(iso) {
    const start = new Date(iso);
    if (Number.isNaN(start.getTime())) return 'This block';
    const end = new Date(start.getTime() + slotMinutes() * 60 * 1000);
    const timeOf = (dt) => dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${timeOf(start)}–${timeOf(end)}`;
  }

  function explainHour(source) {
    const oee = detailNumber(source && source.oee_pct);
    const losses = (source && source.losses) || {};
    const unscheduled = detailNumber(losses.us);
    const planned = detailNumber(losses.pd);
    const idle = detailNumber(losses.uu);
    const broken = detailNumber(losses.bd);
    const setup = detailNumber(losses.st);
    const stops = detailNumber(losses.ms);
    const slow = detailNumber(losses.sl);
    const rejects = detailNumber(losses.rj);
    const rework = detailNumber(losses.rw);

    if (oee < 1 && unscheduled >= 80) {
      return 'This block was off the plan. Nothing was expected to run, so OEE is 0.';
    }

    const drags = [
      [idle, `It was on the plan, but sat idle for ${fmtPctShort(idle)} of the time.`],
      [unscheduled, `${fmtPctShort(unscheduled)} of the time was not scheduled.`],
      [planned, `${fmtPctShort(planned)} was a planned stop.`],
      [broken, `${fmtPctShort(broken)} was a breakdown.`],
      [setup, `${fmtPctShort(setup)} was setup, not cutting.`],
      [stops, `${fmtPctShort(stops)} was lost to short stops.`],
      [slow, `${fmtPctShort(slow)} was lost because it ran slow.`],
      [rejects, `${fmtPctShort(rejects)} went to rejected parts.`],
      [rework, `${fmtPctShort(rework)} went to rework.`],
    ].filter(([amount]) => amount >= 8).sort((a, b) => b[0] - a[0]);

    let text = drags.length
      ? drags[0][1]
      : `OEE was ${fmtPctShort(oee)}.`;
    if (drags[1] && drags[1][0] >= 15) text += ` ${drags[1][1]}`;
    if (oee >= 85 && !drags.length) text += ' This was a solid block.';
    return text;
  }

  function explainRange(payload) {
    const oee = detailNumber(payload && payload.oee_pct);
    const loa = detailNumber(payload && payload.loading_pct);
    const ava = detailNumber(payload && payload.availability_pct);
    const bits = [`Across the whole range, OEE was ${fmtPctShort(oee)}.`];
    if (loa < 75) bits.push(`Only ${fmtPctShort(loa)} of the time was on the plan.`);
    else bits.push(`${fmtPctShort(loa)} of the time was scheduled.`);
    if (ava < 85) bits.push(`The machine was up for ${fmtPctShort(ava)} of that scheduled time.`);
    return bits.join(' ');
  }

  function renderFactors(source) {
    const ava = detailNumber(source && source.availability_pct);
    const factors = [
      {
        name: 'Scheduled',
        hint: 'Share of this time that was on the plan',
        text: fmtPctShort(source && source.loading_pct),
        bar: detailNumber(source && source.loading_pct),
        tone: segmentTone(source && source.loading_pct),
      },
      {
        name: 'Up time',
        hint: 'Of the scheduled time, how much the machine was up',
        text: fmtPctShort(ava),
        bar: ava,
        tone: segmentTone(ava),
      },
    ];
    return `
      <div class="auk-factor">
        ${factors.map((factor) => `
          <div class="auk-factor__item">
            <span class="auk-factor__name">${factor.name}</span>
            <strong class="auk-factor__value">${factor.text}</strong>
            <span class="auk-factor__hint">${factor.hint}</span>
            <span class="auk-factor__track"><span class="auk-factor__fill auk-factor__fill--${factor.tone}" style="width:${Math.max(0, Math.min(100, factor.bar))}%"></span></span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderTimeSplit(losses) {
    const story = [
      ['us', 'Not scheduled', 'idle'],
      ['pd', 'Planned stop', 'idle'],
      ['uu', 'Sitting idle', 'warn'],
      ['bd', 'Breakdown', 'bad'],
      ['st', 'Setup', 'warn'],
      ['ms', 'Short stops', 'warn'],
      ['sl', 'Running slow', 'warn'],
      ['rj', 'Rejects', 'bad'],
      ['rw', 'Rework', 'bad'],
      ['na', 'No data', 'idle'],
      ['ef', 'Producing', 'good'],
    ];
    const parts = story
      .map(([key, name, tone]) => ({ name, tone, value: detailNumber(losses && losses[key]) }))
      .filter((part) => part.value >= 0.5);
    if (!parts.length) return '';
    return `
      <div class="auk-split">
        <p class="auk-split__label">Where the time went</p>
        <div class="auk-split__bar">
          ${parts.map((part) => `<span class="auk-split__seg auk-split__seg--${part.tone}" style="flex:${part.value.toFixed(2)}" title="${escapeHtml(part.name)} ${fmtPctShort(part.value)}"></span>`).join('')}
        </div>
        <ul class="auk-split__list">
          ${parts.map((part) => `<li><i class="auk-split__dot auk-split__seg--${part.tone}"></i><span>${escapeHtml(part.name)}</span><strong>${fmtPctShort(part.value)}</strong></li>`).join('')}
        </ul>
      </div>
    `;
  }

  function renderTimeline(payload) {
    const segments = (payload && payload.segments) || [];
    if (!segments.length) {
      modalBodyEl.innerHTML = '<p class="auk-oee-widget__empty">No time blocks came back for this range.</p>';
      return;
    }
    if (detailSelected == null || detailSelected >= segments.length) detailSelected = segments.length - 1;
    const selected = segments[detailSelected];
    const blockWord = slotMinutes() === 15 ? '15-minute block' : 'hour';
    const bars = segments.map((segment, index) => {
      const pct = Math.max(0, Math.min(100, detailNumber(segment.oee_pct)));
      const tone = segmentTone(segment.oee_pct);
      return `
        <button type="button" class="auk-tl__bar${index === detailSelected ? ' is-selected' : ''}" data-segment-index="${index}" title="${escapeHtml(formatSlotWindow(segment.start))} · OEE ${fmtPctShort(segment.oee_pct)}">
          <span class="auk-tl__plot"><span class="auk-tl__fill auk-tl__fill--${tone}" style="height:${Math.max(pct, 4)}%"></span></span>
          <span class="auk-tl__meta"><strong>${fmtPctShort(segment.oee_pct)}</strong>${escapeHtml(formatSlotTick(segment.start))}</span>
        </button>
      `;
    }).join('');
    modalBodyEl.innerHTML = `
      <p class="auk-tl__hint">Each bar is one ${blockWord}. Taller means higher OEE. Grey means it was off the plan. Click a bar.</p>
      <div class="auk-tl__track">${bars}</div>
      <section class="auk-detail">
        <div class="auk-detail__lead">
          <p class="auk-detail__when">${escapeHtml(selected && selected.start ? formatSlotWindow(selected.start) : 'This block')}</p>
          <p class="auk-detail__oee auk-detail__oee--${segmentTone(selected && selected.oee_pct)}">${fmtPctShort(selected && selected.oee_pct)}</p>
          <p class="auk-detail__kicker">OEE for this ${blockWord}</p>
          <p class="auk-detail__story">${escapeHtml(explainHour(selected))}</p>
        </div>
        ${renderTimeSplit(selected && selected.losses)}
        ${renderFactors(selected)}
      </section>
      <section class="auk-range">
        <h3>Whole range</h3>
        <p class="auk-detail__story">${escapeHtml(explainRange(payload))}</p>
        ${renderFactors(payload)}
      </section>
    `;
    modalBodyEl.querySelectorAll('[data-segment-index]').forEach((button) => {
      button.addEventListener('click', () => {
        detailSelected = Number(button.getAttribute('data-segment-index'));
        renderTimeline(detailPayload);
      });
    });
    const selectedBar = modalBodyEl.querySelector('.auk-tl__bar.is-selected');
    if (selectedBar) selectedBar.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  function formatSlotTick(iso) {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    if (dt.getMinutes() === 0) return dt.toLocaleTimeString(undefined, { hour: 'numeric' });
    return dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  async function openDetail(equipmentId, options) {
    const card = cardsById().get(Number(equipmentId));
    const range = options && options.query;
    detailEquipmentId = equipmentId;
    detailSelected = null;
    modalTitleEl.textContent = (options && options.label) || (card && (card.title || card.label)) || `Equipment ${equipmentId}`;
    modalSubEl.textContent = 'Loading time slices…';
    modalBodyEl.innerHTML = '<p class="auk-oee-widget__empty">Loading…</p>';
    modalEl.hidden = false;
    markFloorSelection();
    const params = new URLSearchParams(range || currentQuery());
    if (detailRes === '15') {
      params.set('res_x', '15');
      params.set('res_period', 'minutes');
    } else {
      params.set('res_x', '1');
      params.set('res_period', 'hours');
    }
    try {
      const res = await fetch(`/api/auk-oee/equipment/${equipmentId}?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load the timeline');
      detailPayload = data;
      const blockLabel = detailRes === '15' ? '15-minute blocks' : 'hours';
      modalSubEl.textContent = `${formatRangeLocal(data.from, data.to)} · ${(data.segments || []).length} ${blockLabel}`;
      renderTimeline(data);
    } catch (err) {
      modalSubEl.textContent = '';
      modalBodyEl.innerHTML = `<p class="auk-oee-widget__empty">${escapeHtml(err.message || 'Failed to load the timeline')}</p>`;
    }
  }

  function closeDetail() {
    if (!modalEl) return;
    modalEl.hidden = true;
    detailEquipmentId = null;
    markFloorSelection();
  }

  function bindCardDetails() {
    gridEl.querySelectorAll('.auk-oee-widget--card').forEach((widget) => {
      widget.addEventListener('click', (event) => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        if (arranging || dragState) return;
        if (event.target.closest('button, .auk-oee-swatches')) return;
        const item = (layout.items || []).find((entry) => entry.id === widget.getAttribute('data-widget-id'));
        if (!item || item.equipment_id == null) return;
        openDetail(item.equipment_id);
      });
    });
  }

  function liveNotices() {
    const minutes = alertMinutes();
    const byId = new Map();
    ((historyData && historyData.watching) || (historyData && historyData.alerts) || []).forEach((notice) => {
      byId.set(Number(notice.equipment_id), notice);
    });
    ((dashboardData && dashboardData.cards) || []).forEach((card) => {
      const loaded = Number(card.loading_pct) > 50;
      const lowMachine = card.is_machine && loaded && Number(card.oee_pct) < 40;
      const lowPlant = card.is_group_summary && /manufacturing/i.test(card.label || '') && Number(card.oee_pct) < 50;
      if (!lowMachine && !lowPlant) return;
      const id = Number(card.equipment_id);
      if (byId.has(id)) return;
      byId.set(id, {
        equipment_id: id,
        label: card.title || card.label,
        kind: lowPlant ? 'plant' : 'machine',
        oee_pct: card.oee_pct,
        minutes: 0,
        triggered: false,
      });
    });
    return Array.from(byId.values()).map((notice) => ({
      ...notice,
      triggered: Boolean(notice.triggered) || Number(notice.minutes) >= minutes,
      needed: minutes,
    }));
  }

  function shortMachineName(label) {
    const text = String(label || 'Machine').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return text || 'Machine';
  }

  function formatWait(minutes) {
    const n = Number(minutes);
    if (!Number.isFinite(n) || n <= 0) return 'now';
    if (n < 60) return `${Math.round(n)}m`;
    const hours = Math.floor(n / 60);
    const rest = Math.round(n % 60);
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  function renderLowBanner() {
    if (!lowEl) return;
    if (viewMode === 'floor') {
      lowEl.hidden = true;
      lowEl.innerHTML = '';
      return;
    }
    const notices = liveNotices().sort((a, b) => {
      if (Boolean(a.triggered) !== Boolean(b.triggered)) return a.triggered ? -1 : 1;
      return (Number(b.minutes) || 0) - (Number(a.minutes) || 0)
        || (Number(a.oee_pct) || 0) - (Number(b.oee_pct) || 0);
    });
    if (!notices.length) {
      lowEl.hidden = true;
      lowEl.innerHTML = '';
      return;
    }
    const triggered = notices.filter((notice) => notice.triggered);
    lowEl.hidden = false;
    lowEl.className = `auk-oee-low auk-oee-low--${triggered.length ? 'alert' : 'watch'}`;
    const countLabel = triggered.length
      ? `${notices.length} under 40%`
      : `${notices.length} dipping`;
    const chips = notices.map((notice) => {
      const name = shortMachineName(notice.label || (notice.kind === 'plant' ? 'Plant' : 'Machine'));
      const idAttr = notice.equipment_id != null ? ` data-low-equipment="${Number(notice.equipment_id)}"` : '';
      return `
        <button type="button" class="auk-oee-low__chip${notice.triggered ? ' is-hot' : ''}"${idAttr}>
          <span>${escapeHtml(name)}</span>
          <strong>${fmtPctShort(notice.oee_pct)}</strong>
          <em>${formatWait(notice.minutes)}</em>
        </button>
      `;
    }).join('');
    lowEl.innerHTML = `<span class="auk-oee-low__count">${escapeHtml(countLabel)}</span><div class="auk-oee-low__list">${chips}</div>`;
  }

  function renderGuides() {
    const items = layout.items || [];
    const used = items.length ? Math.max(...items.map((item) => item.y + item.h)) : 4;
    const rows = Math.max(used + 2, 8);
    let html = '';
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < GRID_COLS; x += 1) {
        html += `<div class="auk-oee-cell" data-cell="${x},${y}" style="grid-column:${x + 1};grid-row:${y + 1}"></div>`;
      }
    }
    return html;
  }

  function renderDropGhosts() {
    return '<div class="auk-oee-drop-ghost" data-ghost="dest" hidden></div><div class="auk-oee-drop-ghost" data-ghost="origin" hidden></div>';
  }

  function gridMetrics() {
    const origin = gridEl.querySelector('[data-cell="0,0"]');
    if (!origin) return null;
    const originRect = origin.getBoundingClientRect();
    const right = gridEl.querySelector('[data-cell="1,0"]');
    const below = gridEl.querySelector('[data-cell="0,1"]');
    const strideX = right ? right.getBoundingClientRect().left - originRect.left : originRect.width;
    const strideY = below ? below.getBoundingClientRect().top - originRect.top : originRect.height;
    if (!(strideX > 0) || !(strideY > 0)) return null;
    return { originX: originRect.left, originY: originRect.top, strideX, strideY };
  }

  function cellFromClient(clientX, clientY) {
    const metrics = gridMetrics();
    if (!metrics) return null;
    return {
      col: Math.floor((clientX - metrics.originX) / metrics.strideX),
      row: Math.floor((clientY - metrics.originY) / metrics.strideY),
    };
  }

  function snapCardOrigin(left, top, w) {
    const metrics = gridMetrics();
    if (!metrics) return null;
    const col = Math.round((left - metrics.originX) / metrics.strideX);
    const row = Math.round((top - metrics.originY) / metrics.strideY);
    return {
      col: Math.max(0, Math.min(GRID_COLS - w, col)),
      row: Math.max(0, row),
    };
  }

  function overlapArea(entry, x, y, w, h) {
    const x1 = Math.max(entry.x, x);
    const y1 = Math.max(entry.y, y);
    const x2 = Math.min(entry.x + entry.w, x + w);
    const y2 = Math.min(entry.y + entry.h, y + h);
    if (x2 <= x1 || y2 <= y1) return 0;
    return (x2 - x1) * (y2 - y1);
  }

  function itemAtCell(col, row, ignoreId) {
    if (col < 0 || col >= GRID_COLS || row < 0) return null;
    return (layout.items || []).find((entry) => (
      entry.id !== ignoreId
      && col >= entry.x
      && col < entry.x + entry.w
      && row >= entry.y
      && row < entry.y + entry.h
    )) || null;
  }

  function cellsFree(ignoreIds, x, y, w, h) {
    if (x < 0 || y < 0 || x + w > GRID_COLS) return false;
    return (layout.items || []).every((entry) => ignoreIds.has(entry.id) || overlapArea(entry, x, y, w, h) === 0);
  }

  function canSwap(item, other) {
    if (other.w === item.w && other.h === item.h) return true;
    const ignore = new Set([item.id, other.id]);
    return cellsFree(ignore, other.x, other.y, item.w, item.h)
      && cellsFree(ignore, item.x, item.y, other.w, other.h);
  }

  function resolveDrop(item, snapped, pointer) {
    const hovered = pointer ? itemAtCell(pointer.col, pointer.row, item.id) : null;
    if (hovered && canSwap(item, hovered)) {
      return { type: 'swap', other: hovered, x: hovered.x, y: hovered.y };
    }
    if (!snapped) return { type: 'invalid' };
    const hits = (layout.items || []).filter((entry) => entry.id !== item.id && overlapArea(entry, snapped.col, snapped.row, item.w, item.h) > 0);
    if (!hits.length) return { type: 'move', x: snapped.col, y: snapped.row };
    hits.sort((a, b) => overlapArea(b, snapped.col, snapped.row, item.w, item.h) - overlapArea(a, snapped.col, snapped.row, item.w, item.h));
    const other = hits[0];
    const area = overlapArea(other, snapped.col, snapped.row, item.w, item.h);
    const covered = area / Math.min(item.w * item.h, other.w * other.h);
    if (covered >= 0.5 && canSwap(item, other)) {
      return { type: 'swap', other, x: other.x, y: other.y };
    }
    return { type: 'invalid', x: snapped.col, y: snapped.row };
  }

  function placeGhost(name, box, mode) {
    const ghost = gridEl.querySelector(`[data-ghost="${name}"]`);
    if (!ghost) return;
    if (!box) {
      ghost.hidden = true;
      ghost.className = 'auk-oee-drop-ghost';
      return;
    }
    ghost.hidden = false;
    ghost.className = `auk-oee-drop-ghost is-${mode}`;
    ghost.style.gridColumn = `${box.x + 1} / span ${box.w}`;
    ghost.style.gridRow = `${box.y + 1} / span ${box.h}`;
  }

  function markSwapTarget(id) {
    gridEl.querySelectorAll('.auk-oee-widget.is-swap-target').forEach((node) => node.classList.remove('is-swap-target'));
    if (!id) return;
    const target = gridEl.querySelector(`[data-widget-id="${CSS.escape(id)}"]`);
    if (target) target.classList.add('is-swap-target');
  }

  function clearDropPreview() {
    placeGhost('dest', null);
    placeGhost('origin', null);
    markSwapTarget(null);
    gridEl.classList.remove('is-dragging-active');
  }

  function showDropPreview(decision, state) {
    if (!decision || decision.type === 'invalid') {
      placeGhost('origin', null);
      markSwapTarget(null);
      if (decision && decision.x != null) {
        placeGhost('dest', { x: decision.x, y: decision.y, w: state.w, h: state.h }, 'invalid');
      } else {
        placeGhost('dest', null);
      }
      return;
    }
    if (decision.type === 'swap') {
      placeGhost('dest', { x: decision.x, y: decision.y, w: state.w, h: state.h }, 'swap');
      placeGhost('origin', { x: state.startX, y: state.startY, w: decision.other.w, h: decision.other.h }, 'origin');
      markSwapTarget(decision.other.id);
      return;
    }
    placeGhost('origin', null);
    markSwapTarget(null);
    placeGhost('dest', { x: decision.x, y: decision.y, w: state.w, h: state.h }, 'move');
  }

  function renderPalette() {
    if (!paletteEl) return;
    if (!arranging) {
      paletteEl.hidden = true;
      paletteEl.innerHTML = '';
      return;
    }
    paletteEl.hidden = !paletteOpen;
    if (!paletteOpen) return;
    const placed = new Set((layout.items || []).map((item) => item.id));
    const buttons = [];
    ['today', 'lowest', 'report'].forEach((type) => {
      if (!placed.has(type)) {
        const labels = { today: 'Today chart', lowest: 'Lowest machines', report: 'Report' };
        buttons.push(`<button type="button" data-add-type="${type}">${labels[type]}</button>`);
      }
    });
    cardsById().forEach((card, equipmentId) => {
      const id = `card-${equipmentId}`;
      if (placed.has(id)) return;
      buttons.push(`<button type="button" data-add-card="${equipmentId}">${escapeHtml(card.title || card.label || id)}</button>`);
    });
    paletteEl.innerHTML = buttons.length
      ? buttons.join('')
      : '<span class="auk-oee-widget__empty">Every widget is already on the board.</span>';
  }

  function firstFreeCell(w, h) {
    const items = layout.items || [];
    for (let y = 0; y < 40; y += 1) {
      for (let x = 0; x <= 12 - w; x += 1) {
        const hit = items.some((item) => x < item.x + item.w && x + w > item.x && y < item.y + item.h && y + h > item.y);
        if (!hit) return { x, y };
      }
    }
    return { x: 0, y: 0 };
  }

  function bindCanvas() {
    if (!arranging) return;
    gridEl.querySelectorAll('.auk-oee-widget').forEach((widget) => {
      widget.addEventListener('pointerdown', onWidgetPointerDown);
    });
    gridEl.querySelectorAll('[data-remove]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const id = button.getAttribute('data-remove');
        layout.items = layout.items.filter((item) => item.id !== id);
        renderCanvas();
      });
    });
    gridEl.querySelectorAll('[data-color]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const widget = button.closest('[data-widget-id]');
        const item = (layout.items || []).find((entry) => entry.id === widget.getAttribute('data-widget-id'));
        if (!item) return;
        const color = button.getAttribute('data-color');
        if (!color || color === 'auto') delete item.color;
        else item.color = color;
        renderCanvas();
      });
    });
  }

  function onWidgetPointerDown(event) {
    if (!arranging || event.button !== 0) return;
    if (event.target.closest('[data-remove], [data-color], .auk-oee-swatches, [data-resize]')) return;
    if (dragState) return;
    event.preventDefault();
    const widget = event.currentTarget;
    const id = widget.getAttribute('data-widget-id');
    const item = (layout.items || []).find((entry) => entry.id === id);
    if (!item) return;
    const rect = widget.getBoundingClientRect();
    dragState = {
      id,
      startX: item.x,
      startY: item.y,
      w: item.w,
      h: item.h,
      originX: event.clientX,
      originY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      moved: false,
    };
    if (widget.setPointerCapture) widget.setPointerCapture(event.pointerId);
    document.addEventListener('pointermove', onWidgetPointerMove);
    document.addEventListener('pointerup', onWidgetPointerUp);
    document.addEventListener('pointercancel', onWidgetPointerUp);
  }

  function endWidgetDrag() {
    document.removeEventListener('pointermove', onWidgetPointerMove);
    document.removeEventListener('pointerup', onWidgetPointerUp);
    document.removeEventListener('pointercancel', onWidgetPointerUp);
  }

  function onWidgetPointerMove(event) {
    if (!dragState) return;
    const dx = event.clientX - dragState.originX;
    const dy = event.clientY - dragState.originY;
    if (!dragState.moved && Math.hypot(dx, dy) < 6) return;
    dragState.moved = true;
    const widget = gridEl.querySelector(`[data-widget-id="${CSS.escape(dragState.id)}"]`);
    if (!widget) return;
    const left = event.clientX - dragState.offsetX;
    const top = event.clientY - dragState.offsetY;
    widget.classList.add('is-dragging');
    gridEl.classList.add('is-dragging-active');
    widget.style.position = 'fixed';
    widget.style.left = `${left}px`;
    widget.style.top = `${top}px`;
    widget.style.width = `${dragState.width}px`;
    widget.style.height = `${dragState.height}px`;
    widget.style.zIndex = '30';
    widget.style.margin = '0';
    const item = (layout.items || []).find((entry) => entry.id === dragState.id);
    if (!item) return;
    const snapped = snapCardOrigin(left, top, dragState.w);
    const pointer = cellFromClient(event.clientX, event.clientY);
    dragState.decision = resolveDrop(item, snapped, pointer);
    showDropPreview(dragState.decision, dragState);
  }

  function onWidgetPointerUp() {
    endWidgetDrag();
    const state = dragState;
    dragState = null;
    clearDropPreview();
    if (!state || !state.moved) {
      renderCanvas();
      return;
    }
    suppressClick = true;
    window.setTimeout(() => { suppressClick = false; }, 0);
    const item = (layout.items || []).find((entry) => entry.id === state.id);
    const decision = state.decision;
    if (!item || !decision || decision.type === 'invalid') {
      renderCanvas();
      return;
    }
    let changed = false;
    if (decision.type === 'move') {
      changed = item.x !== decision.x || item.y !== decision.y;
      item.x = decision.x;
      item.y = decision.y;
    } else if (decision.type === 'swap' && decision.other) {
      const nextX = decision.other.x;
      const nextY = decision.other.y;
      changed = nextX !== state.startX || nextY !== state.startY;
      decision.other.x = state.startX;
      decision.other.y = state.startY;
      item.x = nextX;
      item.y = nextY;
    }
    renderCanvas();
    if (changed) saveLayout().catch((err) => showAlert(err.message || 'Could not save the canvas'));
  }

  async function saveLayout() {
    layout.alert_minutes = alertMinutes();
    const res = await fetch('/api/auk-oee/layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save the layout');
    layout = data.layout || layout;
    savedSnapshot = JSON.stringify(layout);
  }

  function setArrange(on) {
    arranging = on;
    paletteOpen = false;
    if (arrangeBtn) arrangeBtn.hidden = on;
    if (doneBtn) doneBtn.hidden = !on;
    if (cancelBtn) cancelBtn.hidden = !on;
    if (addBtn) addBtn.hidden = !on;
    if (paletteEl && !on) paletteEl.hidden = true;
    syncViewChrome();
    renderCanvas();
  }

  async function loadFloorJobs() {
    const seq = ++floorJobsSeq;
    try {
      const res = await fetch('/api/auk-oee/floor-jobs');
      const data = await res.json();
      if (seq !== floorJobsSeq) return;
      if (!res.ok || data.ok === false) {
        floorJobs = { available: false, byCnc: {}, lowPct: Number(data.low_utilisation_pct) || 40 };
        return;
      }
      floorJobs = {
        available: true,
        byCnc: data.by_cnc || {},
        lowPct: Number(data.low_utilisation_pct) || 40,
      };
    } catch (_err) {
      if (seq !== floorJobsSeq) return;
      floorJobs = { available: false, byCnc: {}, lowPct: 40 };
    }
  }

  async function loadDashboard() {
    const jobsPromise = loadFloorJobs();
    if (!config.configured) {
      await jobsPromise;
      setLoading(false);
      showAlert('Set AUK_ACCESS_TOKEN in .env, then restart the app.');
      if (viewMode === 'floor') renderFloor();
      return;
    }

    if (activePreset === 'custom') {
      const bounds = customShiftBounds();
      if (bounds.error) {
        if (refreshTimer) clearInterval(refreshTimer);
        setLoading(false);
        showAlert(bounds.error);
        return;
      }
    }

    const seq = ++dashboardLoadSeq;
    setLoading(true);
    showAlert('');

    try {
      const res = await fetch(`/api/auk-oee/dashboard?${currentQuery()}`);
      if (seq !== dashboardLoadSeq) return;
      const contentType = res.headers.get('content-type') || '';
      const raw = await res.text();
      if (seq !== dashboardLoadSeq) return;

      if (!contentType.includes('application/json') || raw.trim().startsWith('<')) {
        throw new Error(
          res.ok
            ? 'Server returned HTML instead of JSON. Check deployment logs.'
            : `Server error (${res.status}). The API may be down or misconfigured.`
        );
      }

      const data = JSON.parse(raw);
      if (!res.ok) {
        throw new Error(data.error || parseApiError(raw, res.status));
      }
      if (seq !== dashboardLoadSeq) return;
      dashboardData = data;
      await Promise.all([loadHistory(), jobsPromise]);
      if (seq !== dashboardLoadSeq) return;
      if (!layout) {
        const saved = await loadSavedLayout();
        layout = saved ? cloneLayout(saved) : null;
        if (layout && layout.alert_minutes && alertMinutesEl) {
          alertMinutesEl.value = String(layout.alert_minutes);
        }
        savedSnapshot = JSON.stringify(layout || data.default_layout || {});
      }
      if (!arranging && !dragState) renderActive();
      hasLoadedOnce = true;

      const machineCount = data.machine_count || ((data.cards || []).filter((card) => card.is_machine).length);
      if (data.range_preset) {
        setActivePreset(data.range_preset);
        scheduleRefresh();
      }
      syncRangeInputs(data.from, data.to);

      const presetLabel = data.range_preset === 'custom'
        ? (shiftPmEl && shiftPmEl.checked ? 'Custom · PM' : 'Custom · AM')
        : (PRESET_LABELS[data.range_preset] || PRESET_LABELS.custom);
      const toDt = new Date(data.to || '');
      const toIsLive = Number.isFinite(toDt.getTime())
        && toDt >= new Date(Date.now() - 3 * 60 * 1000);
      const openMinute = toDt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      metaEl.textContent = [
        `${presetLabel} · ${formatRangeLocal(data.from, data.to)}`,
        toIsLive ? `open minute ${openMinute}` : 'range frozen',
        `${machineCount} machines`,
        `updated ${new Date(data.fetched_at || Date.now()).toLocaleTimeString()}`,
      ].join(' · ');

      if (data.warning) showAlert(data.warning);
      else if (data.asset_error_count > 0) showAlert(`${data.asset_error_count} machine(s) returned no OEE for this range.`);
      else showAlert('');
    } catch (err) {
      if (seq !== dashboardLoadSeq) return;
      if (!hasLoadedOnce) gridEl.hidden = true;
      showAlert(err.message || 'Failed to load OEE dashboard');
    } finally {
      if (seq !== dashboardLoadSeq) return;
      setLoading(false);
      if (refreshToastEl) {
        window.setTimeout(() => {
          if (!refreshToastEl.classList.contains('is-active')) {
            refreshToastEl.hidden = true;
          }
        }, 220);
      }
    }
  }

  function applyCustomShift() {
    setActivePreset('custom');
    const bounds = customShiftBounds();
    if (bounds.error) {
      showAlert(bounds.error);
      return;
    }
    showAlert('');
    scheduleRefresh();
    loadDashboard();
  }

  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset || 'shift';
      if (preset === 'custom') {
        applyCustomShift();
        return;
      }
      setActivePreset(preset);
      scheduleRefresh();
      loadDashboard();
    });
  });

  if (shiftDateEl) {
    shiftDateEl.addEventListener('change', () => {
      if (!syncingRange) applyCustomShift();
    });
  }
  if (shiftPmEl) {
    shiftPmEl.addEventListener('change', () => {
      if (!syncingRange) applyCustomShift();
    });
  }

  function adoptRangeAsShift() {
    if (!fromEl.value || !shiftDateEl) return;
    const date = fromEl.value.slice(0, 10);
    const hour = Number(fromEl.value.slice(11, 13));
    const minute = Number(fromEl.value.slice(14, 16));
    if (!date || !Number.isFinite(hour) || !Number.isFinite(minute)) return;
    const minutes = hour * 60 + minute;
    shiftDateEl.value = date;
    if (shiftPmEl) {
      shiftPmEl.checked = minutes >= (19 * 60 + 30) || minutes < (9 * 60);
    }
    updateShiftToggleLabels();
  }

  fromEl.addEventListener('change', () => {
    if (syncingRange) return;
    adoptRangeAsShift();
    applyCustomShift();
  });
  toEl.addEventListener('change', () => {
    if (syncingRange) return;
    adoptRangeAsShift();
    applyCustomShift();
  });

  async function loadHistory() {
    try {
      const res = await fetch(`/api/auk-oee/history?minutes=${alertMinutes()}`);
      if (!res.ok) return;
      historyData = await res.json();
    } catch (_err) {
      historyData = historyData || null;
    }
  }

  async function loadSavedLayout() {
    try {
      const res = await fetch('/api/auk-oee/layout');
      if (!res.ok) return null;
      const data = await res.json();
      return data.layout || null;
    } catch (_err) {
      return null;
    }
  }

  if (modalEl) {
    modalEl.querySelectorAll('[data-close-modal]').forEach((el) => {
      el.addEventListener('click', closeDetail);
    });
    modalEl.querySelectorAll('[data-segment]').forEach((button) => {
      button.addEventListener('click', () => {
        detailRes = button.getAttribute('data-segment') || '60';
        modalEl.querySelectorAll('[data-segment]').forEach((el) => {
          el.classList.toggle('is-active', el === button);
        });
        if (detailEquipmentId != null) openDetail(detailEquipmentId);
      });
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDetail();
  });

  if (lowEl) {
    lowEl.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-low-equipment]');
      if (!chip) return;
      const equipmentId = Number(chip.getAttribute('data-low-equipment'));
      if (equipmentId) openDetail(equipmentId);
    });
  }

  refreshBtn.addEventListener('click', () => {
    if (viewMode === 'calendar') loadCalendar(true);
    else loadDashboard();
  });
  arrangeBtn.addEventListener('click', () => {
    savedSnapshot = JSON.stringify(layout);
    setArrange(true);
  });
  doneBtn.addEventListener('click', async () => {
    try {
      await saveLayout();
      setArrange(false);
      showAlert('');
    } catch (err) {
      showAlert(err.message || 'Could not save the layout');
    }
  });
  cancelBtn.addEventListener('click', () => {
    try {
      layout = JSON.parse(savedSnapshot);
    } catch (_err) {
      layout = null;
    }
    setArrange(false);
  });
  addBtn.addEventListener('click', () => {
    paletteOpen = !paletteOpen;
    renderPalette();
  });
  paletteEl.addEventListener('click', (event) => {
    const typeButton = event.target.closest('[data-add-type]');
    const cardButton = event.target.closest('[data-add-card]');
    if (!layout) return;
    if (typeButton) {
      const type = typeButton.getAttribute('data-add-type');
      const spot = firstFreeCell(type === 'today' ? 6 : 3, 2);
      layout.items.push({
        id: type,
        type,
        x: spot.x,
        y: spot.y,
        w: type === 'today' ? 6 : 3,
        h: 2,
      });
    } else if (cardButton) {
      const equipmentId = Number(cardButton.getAttribute('data-add-card'));
      const spot = firstFreeCell(2, 1);
      layout.items.push({
        id: `card-${equipmentId}`,
        type: 'card',
        equipment_id: equipmentId,
        x: spot.x,
        y: spot.y,
        w: 2,
        h: 1,
      });
    } else {
      return;
    }
    paletteOpen = false;
    renderCanvas();
  });
  alertMinutesEl.addEventListener('change', () => {
    if (layout) layout.alert_minutes = alertMinutes();
    loadHistory().then(() => {
      if (!dragState) renderActive();
    });
  });
  viewButtons.forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view || 'cards'));
  });
  if (calendarEl) {
    calendarEl.addEventListener('click', (event) => {
      const monthBtn = event.target.closest('[data-cal-month]');
      if (monthBtn) {
        shiftCalendarMonth(Number(monthBtn.getAttribute('data-cal-month')));
        return;
      }
      const toggle = event.target.closest('[data-cal-toggle]');
      if (toggle) {
        const id = toggle.getAttribute('data-cal-toggle');
        if (calendarCollapsed.has(id)) calendarCollapsed.delete(id);
        else calendarCollapsed.add(id);
        renderCalendar();
        return;
      }
      const open = event.target.closest('[data-cal-open]');
      if (!open || !calendarData) return;
      openDetail(Number(open.getAttribute('data-cal-open')), {
        label: open.getAttribute('data-cal-label'),
        query: { from: calendarData.query_from, to: calendarData.query_to },
      });
    });
    calendarEl.addEventListener('change', (event) => {
      if (event.target.id === 'auk-oee-cal-month') loadCalendar(true);
    });
  }
  if (floorEl) {
    floorEl.addEventListener('click', (event) => {
      const target = event.target.closest('[data-equipment-id]');
      if (!target) return;
      const equipmentId = Number(target.getAttribute('data-equipment-id'));
      if (!equipmentId) return;
      openDetail(equipmentId);
    });
  }
  window.addEventListener('resize', () => {
    if (viewMode === 'floor') sizeFloorCanvas();
  });
  setView(readSavedView());
  setActivePreset('day');
  scheduleRefresh();
  loadDashboard();
})();
