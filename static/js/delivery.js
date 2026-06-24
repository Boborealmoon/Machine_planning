// Delivery page — toggle between Delivery schedule and Queue delays views.

const deliveryPageState = {
  view: 'schedule',
  queueLoaded: false,
  scheduleLoaded: false,
};

const DELIVERY_SUBTITLES = {
  schedule: 'Open partials (one row per PP partial). Search filters the loaded list; Refresh reloads from server.',
  queue: 'Queued jobs grouped by PS + partial. All schedule times are Singapore (SGT, UTC+8). Coway EDD is set once per group and overrides PS due for all ops under that partial.',
};

function deliveryViewFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const view = String(params.get('view') || '').trim().toLowerCase();
  return view === 'queue' ? 'queue' : 'schedule';
}

function deliveryUpdateUrl(view) {
  const url = new URL(window.location.href);
  if (view === 'queue') url.searchParams.set('view', 'queue');
  else url.searchParams.delete('view');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function deliverySetView(view, options = {}) {
  const nextView = view === 'queue' ? 'queue' : 'schedule';
  deliveryPageState.view = nextView;

  const schedulePanel = document.getElementById('delivery-panel-schedule');
  const queuePanel = document.getElementById('delivery-panel-queue');
  const scheduleBtn = document.getElementById('delivery-view-schedule');
  const queueBtn = document.getElementById('delivery-view-queue');
  const subtitle = document.getElementById('delivery-subtitle');
  const showSchedule = nextView === 'schedule';
  const showQueue = nextView === 'queue';

  if (schedulePanel) {
    schedulePanel.hidden = !showSchedule;
    schedulePanel.setAttribute('aria-hidden', showSchedule ? 'false' : 'true');
  }
  if (queuePanel) {
    queuePanel.hidden = !showQueue;
    queuePanel.setAttribute('aria-hidden', showQueue ? 'false' : 'true');
  }
  if (scheduleBtn) {
    scheduleBtn.classList.toggle('is-active', showSchedule);
    scheduleBtn.setAttribute('aria-selected', showSchedule ? 'true' : 'false');
  }
  if (queueBtn) {
    queueBtn.classList.toggle('is-active', showQueue);
    queueBtn.setAttribute('aria-selected', showQueue ? 'true' : 'false');
  }
  if (subtitle) subtitle.textContent = DELIVERY_SUBTITLES[nextView] || DELIVERY_SUBTITLES.schedule;

  if (!options.skipUrl) deliveryUpdateUrl(nextView);

  if (showSchedule) {
    if (!deliveryPageState.scheduleLoaded || options.force) {
      if (typeof loadDeliverySchedule === 'function') {
        loadDeliverySchedule({ force: Boolean(options.force) });
      } else if (typeof renderDeliverySchedule === 'function') {
        renderDeliverySchedule();
      }
      deliveryPageState.scheduleLoaded = true;
    }
    return;
  }

  if (!deliveryPageState.queueLoaded || options.force) {
    if (typeof loadQueueDelays === 'function') {
      loadQueueDelays({ force: Boolean(options.force) });
    }
    deliveryPageState.queueLoaded = true;
  }
}

function deliveryRefreshActiveView() {
  if (deliveryPageState.view === 'schedule' && typeof loadDeliverySchedule === 'function') {
    loadDeliverySchedule({ force: true });
    return;
  }
  deliverySetView(deliveryPageState.view, { force: true, skipUrl: true });
}

document.addEventListener('DOMContentLoaded', () => {
  if (!document.querySelector('.delivery-page')) return;

  document.querySelectorAll('[data-delivery-view]').forEach((button) => {
    button.addEventListener('click', () => {
      deliverySetView(button.dataset.deliveryView || 'schedule');
    });
  });

  document.getElementById('delivery-refresh')?.addEventListener('click', deliveryRefreshActiveView);

  deliverySetView(deliveryViewFromQuery(), { skipUrl: true });
  deliveryUpdateUrl(deliveryPageState.view);
});
