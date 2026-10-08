(function () {
  const config = window.AUK_OEE_CONFIG || {};
  const refreshToastEl = document.getElementById('auk-oee-refresh-toast');
  const gridEl = document.getElementById('auk-oee-grid');
  const metaEl = document.getElementById('auk-oee-meta');
  const alertEl = document.getElementById('auk-oee-alert');
  const fromEl = document.getElementById('auk-oee-from');
  const toEl = document.getElementById('auk-oee-to');
  const refreshBtn = document.getElementById('auk-oee-refresh');
  const presetButtons = Array.from(document.querySelectorAll('.auk-oee-preset'));

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
    if (!gridEl) return;
    if (!hasLoadedOnce) {
      gridEl.hidden = isLoading;
      gridEl.classList.toggle('auk-oee-grid--initial', isLoading);
      if (isLoading && !gridEl.innerHTML.trim()) {
        gridEl.innerHTML = '<span>Loading OEE cards…</span>';
        gridEl.hidden = false;
      }
      return;
    }
    gridEl.classList.toggle('auk-oee-grid--refreshing', isLoading);
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

  function setActivePreset(preset) {
    activePreset = preset || 'shift';
    presetButtons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.preset === activePreset);
    });
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
      const fromIso = localInputToIso(fromEl.value);
      const toIso = clampToIso(localInputToIso(toEl.value));
      if (fromIso) params.set('from', fromIso);
      if (toIso) params.set('to', toIso);
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
  const GRID_ROW = 112;
  const GRID_GAP = 8;
  const CARD_COLORS = ['red', 'amber', 'green', 'blue', 'violet', 'slate'];

  function tightenLayout(source) {
    if (!source || !Array.isArray(source.items)) return source;
    const cards = source.items.filter((item) => item.type === 'card');
    if (!cards.some((item) => item.h >= 3)) return source;
    cards.forEach((card, index) => {
      card.w = 2;
      card.h = 1;
      card.x = (index % 6) * 2;
      card.y = Math.floor(index / 6);
    });
    const base = Math.ceil(cards.length / 6);
    source.items.filter((item) => item.type !== 'card').forEach((item, index) => {
      item.y = base + index * 2;
      item.h = 2;
      item.w = item.type === 'today' ? 6 : 3;
      item.x = item.type === 'today' ? 0 : item.type === 'lowest' ? 6 : 9;
    });
    return source;
  }

  function ensureLayout() {
    if (layout && Array.isArray(layout.items) && layout.items.length) {
      tightenLayout(layout);
      return;
    }
    const fallback = (dashboardData && dashboardData.default_layout) || { columns: 12, alert_minutes: 10, items: [] };
    layout = tightenLayout(cloneLayout(fallback));
    if (alertMinutesEl && layout.alert_minutes) {
      alertMinutesEl.value = String(layout.alert_minutes);
    }
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
      <div class="auk-oee-tile auk-oee-tile--${cardTone(card)}">
        <div class="auk-oee-tile__top">
          <div class="auk-oee-tile__title">${escapeHtml(title)}</div>
          <strong class="auk-oee-tile__oee">${fmtPctShort(card.oee_pct)}</strong>
        </div>
        <div class="auk-oee-tile__metrics">
          ${renderCompactMetric('LOA', card.loading_pct)}
          ${renderCompactMetric('AVA', card.availability_pct)}
          ${renderCompactMetric('PER', card.performance_pct)}
          ${renderCompactMetric('QUA', card.quality_pct)}
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
    gridEl.innerHTML = renderGuides() + (layout.items || []).map(renderWidget).join('');
    gridEl.hidden = false;
    bindCanvas();
    bindCardDetails();
    renderLowBanner();
    renderPalette();
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

  function renderSliceDetail(source, title) {
    return `
      <div class="auk-oee-modal__detail">
        <h3>${escapeHtml(title)}</h3>
        <div class="auk-oee-tile__oee">${fmtPctShort(source && source.oee_pct)}</div>
        ${renderCompactMetric('LOA', source && source.loading_pct)}
        ${renderCompactMetric('AVA', source && source.availability_pct)}
        ${renderCompactMetric('PER', source && source.performance_pct)}
        ${renderCompactMetric('QUA', source && source.quality_pct)}
        ${source && source.losses ? renderLossGrid(source.losses) : ''}
      </div>
    `;
  }

  function renderTimeline(payload) {
    const segments = (payload && payload.segments) || [];
    if (!segments.length) {
      modalBodyEl.innerHTML = '<p class="auk-oee-widget__empty">No time slices came back for this range.</p>';
      return;
    }
    if (detailSelected == null || detailSelected >= segments.length) detailSelected = segments.length - 1;
    const bars = segments.map((segment, index) => `
      <button type="button" class="auk-oee-seg auk-oee-seg--${segmentTone(segment.oee_pct)}${index === detailSelected ? ' is-selected' : ''}" data-segment-index="${index}">
        <span class="auk-oee-seg__bar">${fmtPctShort(segment.oee_pct)}</span>
        <span class="auk-oee-seg__time">${escapeHtml(formatSlotTime(segment.start))}</span>
      </button>
    `).join('');
    const selected = segments[detailSelected];
    modalBodyEl.innerHTML = `
      <div class="auk-oee-modal__layout">
        <div class="auk-oee-segments">${bars}</div>
        <div>
          ${renderSliceDetail(selected, selected && selected.start ? `Slice ${formatSlotTime(selected.start)}` : 'This slice')}
          ${renderSliceDetail(payload, 'Whole range')}
        </div>
      </div>
    `;
    modalBodyEl.querySelectorAll('[data-segment-index]').forEach((button) => {
      button.addEventListener('click', () => {
        detailSelected = Number(button.getAttribute('data-segment-index'));
        renderTimeline(detailPayload);
      });
    });
  }

  async function openDetail(equipmentId) {
    const card = cardsById().get(Number(equipmentId));
    detailEquipmentId = equipmentId;
    detailSelected = null;
    modalTitleEl.textContent = (card && (card.title || card.label)) || `Equipment ${equipmentId}`;
    modalSubEl.textContent = 'Loading time slices…';
    modalBodyEl.innerHTML = '<p class="auk-oee-widget__empty">Loading…</p>';
    modalEl.hidden = false;
    const params = new URLSearchParams(currentQuery());
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
      modalSubEl.textContent = `${formatRangeLocal(data.from, data.to)} · ${(data.segments || []).length} slices`;
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
  }

  function bindCardDetails() {
    gridEl.querySelectorAll('.auk-oee-widget--card').forEach((widget) => {
      widget.addEventListener('click', (event) => {
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

  function renderLowBanner() {
    if (!lowEl) return;
    const notices = liveNotices();
    lowEl.hidden = false;
    if (!notices.length) {
      lowEl.className = 'auk-oee-low auk-oee-low--quiet';
      lowEl.innerHTML = `No loaded machine is under 40%. Watch is ${alertMinutes()} min.`;
      return;
    }
    const triggered = notices.filter((notice) => notice.triggered);
    lowEl.className = `auk-oee-low${triggered.length ? ' auk-oee-low--alert' : ' auk-oee-low--watch'}`;
    const head = triggered.length
      ? `<strong>Low OEE</strong> for ${alertMinutes()} min or more`
      : `<strong>Watching low OEE</strong> — alert after ${alertMinutes()} min`;
    const lines = notices.map((notice) => {
      const name = notice.label || (notice.kind === 'plant' ? 'Plant' : 'Machine');
      const waited = Number(notice.minutes) > 0 ? `${notice.minutes} min` : 'just now';
      return `<span><strong>${escapeHtml(name)}</strong> ${fmtPctShort(notice.oee_pct)} · ${waited}</span>`;
    }).join('');
    lowEl.innerHTML = `${head}<div class="auk-oee-low__list">${lines}</div>`;
  }

  function renderGuides() {
    if (!arranging) return '';
    const items = layout.items || [];
    const rows = Math.max(4, ...items.map((item) => item.y + item.h)) + 1;
    let html = '';
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < GRID_COLS; x += 1) {
        html += `<div class="auk-oee-cell" style="grid-column:${x + 1};grid-row:${y + 1}"></div>`;
      }
    }
    return html;
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

  function cellFromPointer(clientX, clientY) {
    const rect = gridEl.getBoundingClientRect();
    const colWidth = (rect.width - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
    const col = Math.floor((clientX - rect.left) / (colWidth + GRID_GAP));
    const row = Math.floor((clientY - rect.top) / (GRID_ROW + GRID_GAP));
    return {
      col: Math.max(0, Math.min(GRID_COLS - 1, col)),
      row: Math.max(0, row),
    };
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
    if (event.target.closest('[data-remove], [data-color], .auk-oee-swatches')) return;
    const widget = event.currentTarget;
    const id = widget.getAttribute('data-widget-id');
    const item = (layout.items || []).find((entry) => entry.id === id);
    if (!item) return;
    const resizing = Boolean(event.target.closest('[data-resize]'));
    const origin = cellFromPointer(event.clientX, event.clientY);
    dragState = {
      id,
      resizing,
      originCol: origin.col,
      originRow: origin.row,
      startX: item.x,
      startY: item.y,
      startW: item.w,
      startH: item.h,
    };
    widget.setPointerCapture(event.pointerId);
    widget.addEventListener('pointermove', onWidgetPointerMove);
    widget.addEventListener('pointerup', onWidgetPointerUp);
  }

  function onWidgetPointerMove(event) {
    if (!dragState) return;
    const item = (layout.items || []).find((entry) => entry.id === dragState.id);
    if (!item) return;
    const cell = cellFromPointer(event.clientX, event.clientY);
    if (dragState.resizing) {
      const dw = cell.col - dragState.originCol;
      const dh = cell.row - dragState.originRow;
      const minH = item.type === 'card' ? 1 : 2;
      item.w = Math.max(2, Math.min(12 - item.x, dragState.startW + dw));
      item.h = Math.max(minH, Math.min(4, dragState.startH + dh));
    } else {
      const dx = cell.col - dragState.originCol;
      const dy = cell.row - dragState.originRow;
      item.x = Math.max(0, Math.min(12 - item.w, dragState.startX + dx));
      item.y = Math.max(0, dragState.startY + dy);
    }
    const widget = gridEl.querySelector(`[data-widget-id="${dragState.id}"]`);
    if (widget) widget.style.cssText = placeStyle(item);
  }

  function onWidgetPointerUp(event) {
    const widget = event.currentTarget;
    widget.removeEventListener('pointermove', onWidgetPointerMove);
    widget.removeEventListener('pointerup', onWidgetPointerUp);
    const state = dragState;
    dragState = null;
    if (!state) return;
    const item = (layout.items || []).find((entry) => entry.id === state.id);
    if (!item || state.resizing) {
      renderCanvas();
      return;
    }
    const other = (layout.items || []).find((entry) => {
      if (entry.id === item.id) return false;
      return item.x < entry.x + entry.w && item.x + item.w > entry.x
        && item.y < entry.y + entry.h && item.y + item.h > entry.y;
    });
    if (other) {
      const nextX = other.x;
      const nextY = other.y;
      other.x = Math.max(0, Math.min(12 - other.w, state.startX));
      other.y = state.startY;
      item.x = Math.max(0, Math.min(12 - item.w, nextX));
      item.y = nextY;
    }
    renderCanvas();
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
    renderCanvas();
  }

  async function loadDashboard() {
    if (!config.configured) {
      setLoading(false);
      showAlert('Set AUK_ACCESS_TOKEN in .env, then restart the app.');
      return;
    }

    setLoading(true);
    showAlert('');

    try {
      const res = await fetch(`/api/auk-oee/dashboard?${currentQuery()}`);
      const contentType = res.headers.get('content-type') || '';
      const raw = await res.text();

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
      dashboardData = data;
      await loadHistory();
      if (!layout) {
        const saved = await loadSavedLayout();
        layout = saved ? cloneLayout(saved) : null;
        if (layout && layout.alert_minutes && alertMinutesEl) {
          alertMinutesEl.value = String(layout.alert_minutes);
        }
        savedSnapshot = JSON.stringify(layout || data.default_layout || {});
      }
      if (!arranging && !dragState) renderCanvas();
      hasLoadedOnce = true;

      const machineCount = data.machine_count || ((data.cards || []).filter((card) => card.is_machine).length);
      if (data.range_preset) {
        setActivePreset(data.range_preset);
        scheduleRefresh();
      }
      syncRangeInputs(data.from, data.to);

      const presetLabel = PRESET_LABELS[data.range_preset] || PRESET_LABELS.custom;
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
      if (!hasLoadedOnce) gridEl.hidden = true;
      showAlert(err.message || 'Failed to load OEE dashboard');
    } finally {
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

  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset || 'shift';
      setActivePreset(preset);
      scheduleRefresh();
      loadDashboard();
    });
  });

  fromEl.addEventListener('change', () => {
    if (!syncingRange) {
      setActivePreset('custom');
      scheduleRefresh();
    }
  });
  toEl.addEventListener('change', () => {
    if (!syncingRange) {
      setActivePreset('custom');
      scheduleRefresh();
    }
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

  refreshBtn.addEventListener('click', loadDashboard);
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
      if (!dragState) renderCanvas();
    });
  });
  setActivePreset('day');
  scheduleRefresh();
  loadDashboard();
})();
