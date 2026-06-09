(function () {
  const config = window.AUK_OEE_CONFIG || {};
  const loadingEl = document.getElementById('auk-oee-loading');
  const gridEl = document.getElementById('auk-oee-grid');
  const metaEl = document.getElementById('auk-oee-meta');
  const alertEl = document.getElementById('auk-oee-alert');
  const fromEl = document.getElementById('auk-oee-from');
  const toEl = document.getElementById('auk-oee-to');
  const refreshBtn = document.getElementById('auk-oee-refresh');

  const REFRESH_MS = 5 * 60 * 1000;

  const GROUP_ACCENTS = {
    overall: '#475467',
    turning: '#1570ef',
    milling: '#7a5af8',
    multiaxis: '#099250',
    mpp: '#dd2590',
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
    return `${n.toFixed(1)}%`;
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

  function renderCard(card, groupId) {
    const oee = card.oee_pct;
    const tone = toneForPct(oee);
    const pct = Math.max(0, Math.min(100, Number(oee) || 0));
    const title = card.title || card.label || 'Untitled';
    const typeBadge = card.machine_type
      ? `<span class="auk-oee-card__badge">${escapeHtml(card.machine_type)}</span>`
      : '';
    const summaryClass = card.is_group_summary ? ' auk-oee-card--summary' : '';
    const summaryNote = card.is_group_summary
      ? '<div class="auk-oee-card__note">Auk block summary · not included in machine avg</div>'
      : '';
    const error = card.error
      ? `<div class="auk-oee-card__error">${escapeHtml(card.error)}</div>`
      : '';

    return `
      <article class="auk-oee-card${summaryClass} auk-oee-card--${tone}" data-group="${escapeHtml(groupId || card.group_id || 'other')}">
        <div class="auk-oee-card__head">
          <div class="auk-oee-card__title">${escapeHtml(title)}</div>
          ${typeBadge}
        </div>
        <div class="auk-oee-card__donut-wrap">
          <div class="auk-oee-donut auk-oee-donut--${tone}" style="--pct:${pct}">
            <div class="auk-oee-donut__center">
              <span class="auk-oee-donut__value">${fmtPct(oee)}</span>
              <span class="auk-oee-donut__label">OEE</span>
            </div>
          </div>
        </div>
        <div class="auk-oee-metrics">
          ${renderMetric('LOA', card.loading_pct)}
          ${renderMetric('AVA', card.availability_pct)}
          ${renderMetric('PER', card.performance_pct)}
          ${renderMetric('QUA', card.quality_pct)}
        </div>
        ${summaryNote}
        ${error}
      </article>
    `;
  }

  function renderSection(section) {
    const accent = GROUP_ACCENTS[section.id] || GROUP_ACCENTS.other;
    const avg = section.avg_oee_pct != null ? fmtPct(section.avg_oee_pct) : '—';
    const cards = Array.isArray(section.cards) ? section.cards : [];
    const machineCount = section.count ?? cards.filter((c) => c.is_machine).length;
    const avgLabel = section.id === 'overall' ? 'Plant OEE' : 'Machine avg';

    return `
      <section class="auk-oee-section" style="--section-accent:${accent}">
        <header class="auk-oee-section__head">
          <div class="auk-oee-section__title-wrap">
            <h2 class="auk-oee-section__title">${escapeHtml(section.title)}</h2>
            <span class="auk-oee-section__count">${section.id === 'overall' ? 'Summary' : `${machineCount} machine${machineCount === 1 ? '' : 's'}`}</span>
          </div>
          <div class="auk-oee-section__avg">
            <span class="auk-oee-section__avg-label">${avgLabel}</span>
            <strong class="auk-oee-section__avg-value">${avg}</strong>
          </div>
        </header>
        <div class="auk-oee-section__grid">
          ${cards.map((card) => renderCard(card, section.id)).join('')}
        </div>
      </section>
    `;
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
    };
    const order = ['overall', 'turning', 'milling', 'multiaxis', 'mpp'];
    return order
      .filter((id) => byGroup.has(id))
      .map((id) => {
        const sectionCards = byGroup.get(id) || [];
        const machines = sectionCards.filter((c) => c.is_machine);
        const summaries = sectionCards.filter((c) => c.is_group_summary);
        const machineOee = machines
          .map((c) => Number(c.oee_pct))
          .filter((n) => Number.isFinite(n));
        const avg = id === 'overall'
          ? (summaries.find((c) => Number.isFinite(Number(c.oee_pct)))?.oee_pct ?? null)
          : (machineOee.length ? machineOee.reduce((a, b) => a + b, 0) / machineOee.length : null);
        return {
          id,
          title: titles[id] || id,
          cards: sectionCards,
          count: machines.length,
          avg_oee_pct: avg,
        };
      });
  }

  function setLoading(isLoading) {
    if (loadingEl) {
      loadingEl.classList.toggle('is-active', isLoading);
    }
    if (gridEl) {
      gridEl.hidden = isLoading;
    }
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

  function defaultRange() {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const from = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: now.toISOString() };
  }

  function currentQuery() {
    const fromIso = localInputToIso(fromEl.value);
    const toIso = localInputToIso(toEl.value);
    const params = new URLSearchParams();
    if (fromIso) params.set('from', fromIso);
    if (toIso) params.set('to', toIso);
    params.set('res_x', '1');
    params.set('res_period', 'hours');
    return params.toString();
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
        throw new Error(data.error || `${res.status} ${res.statusText}`);
      }

      const groups = Array.isArray(data.groups) && data.groups.length
        ? data.groups
        : buildGroupsFromCards(Array.isArray(data.cards) ? data.cards : []);

      gridEl.innerHTML = groups.map(renderSection).join('');
      gridEl.hidden = groups.length === 0;

      const cardCount = data.card_count ?? (data.cards || []).length;
      metaEl.textContent = [
        `Range ${data.from || ''} → ${data.to || ''}`,
        `${cardCount} machines`,
        `${groups.length} groups`,
        `updated ${new Date(data.fetched_at || Date.now()).toLocaleString()}`,
      ].join(' · ');
    } catch (err) {
      gridEl.hidden = true;
      showAlert(err.message || 'Failed to load OEE dashboard');
    } finally {
      setLoading(false);
    }
  }

  function initRangeInputs() {
    const range = defaultRange();
    fromEl.value = toLocalInputValue(range.from);
    toEl.value = toLocalInputValue(range.to);
  }

  refreshBtn.addEventListener('click', loadDashboard);
  initRangeInputs();
  loadDashboard();
  setInterval(loadDashboard, REFRESH_MS);
})();
