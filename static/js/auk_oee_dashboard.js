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
  let activePreset = 'shift';
  let syncingRange = false;
  let refreshTimer = null;
  let hasLoadedOnce = false;

  const PRESET_LABELS = {
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
          <span class="auk-oee-donut__value">${fmtPct(oee)}</span>
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
            <p class="auk-oee-hero-card__sub">Live plant OEE from Auk Pareto</p>
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
    params.set('res_x', '1');
    params.set('res_period', 'hours');
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

      const groups = Array.isArray(data.groups) && data.groups.length
        ? data.groups
        : buildGroupsFromCards(Array.isArray(data.cards) ? data.cards : []);

      gridEl.classList.remove('auk-oee-grid--initial');
      gridEl.innerHTML = groups.map(renderSection).join('');
      gridEl.hidden = groups.length === 0;
      hasLoadedOnce = true;
      assetDetailCache.clear();
      const allCards = groups.flatMap((g) => [...(g.summaries || []), ...(g.machines || [])]);
      stampMachineRowCards(allCards);
      bindAssetDetailLoaders();

      const machineCount = data.machine_count ?? groups.reduce(
        (sum, g) => sum + (g.count ?? (g.machines || []).length),
        0,
      );
      if (data.range_preset) {
        setActivePreset(data.range_preset);
        scheduleRefresh();
      }
      syncRangeInputs(data.from, data.to);

      const presetLabel = PRESET_LABELS[data.range_preset] || PRESET_LABELS.custom;
      const shiftWindow = data.shift_window || '08:30-20:30';
      const toDt = new Date(data.to || '');
      const toIsLive = Number.isFinite(toDt.getTime())
        && toDt >= new Date(Date.now() - 90 * 1000);
      metaEl.textContent = [
        `${presetLabel} · ${formatRangeLocal(data.from, data.to)}`,
        toIsLive ? 'To = now (live)' : `To frozen`,
        `window ${shiftWindow}`,
        `${machineCount} assets`,
        `updated ${new Date(data.fetched_at || Date.now()).toLocaleString()}`,
      ].join(' · ');

      if (data.warning) {
        showAlert(data.warning);
      } else if (data.asset_error_count > 0) {
        showAlert(`${data.asset_error_count} machine(s) failed to load — expand rows for details.`);
      } else {
        showAlert('');
      }
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

  refreshBtn.addEventListener('click', loadDashboard);
  setActivePreset('shift');
  scheduleRefresh();
  loadDashboard();
})();
