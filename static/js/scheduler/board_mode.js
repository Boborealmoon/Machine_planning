// Board display mode: full planner vs read-only machinist lane view.

window.trialBoardMode = window.trialBoardMode || 'planner';

function trialIsMachinistBoard() {
  return String(window.trialBoardMode || '').toLowerCase() === 'machinist';
}

function trialIsReadOnlyBoard() {
  return trialIsMachinistBoard();
}

/** Groups with section labels + subgroup cards visible (default: compact lanes only). */
const TRIAL_BOARD_GROUP_CHROME_KEY = 'planner-board-group-chrome-v2';

function trialBoardGroupChromeExpandedSet() {
  if (!window._trialBoardGroupChromeExpanded) {
    try {
      const raw = localStorage.getItem(TRIAL_BOARD_GROUP_CHROME_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      window._trialBoardGroupChromeExpanded = new Set(
        Array.isArray(parsed) ? parsed.map(id => String(id)) : []
      );
    } catch (_) {
      window._trialBoardGroupChromeExpanded = new Set();
    }
  }
  return window._trialBoardGroupChromeExpanded;
}

function trialIsBoardGroupChromeExpanded(groupId) {
  return trialBoardGroupChromeExpandedSet().has(String(groupId || ''));
}

function trialToggleBoardGroupChromeExpanded(groupId) {
  const key = String(groupId || '');
  if (!key) return false;
  const set = trialBoardGroupChromeExpandedSet();
  if (set.has(key)) set.delete(key);
  else set.add(key);
  try {
    localStorage.setItem(TRIAL_BOARD_GROUP_CHROME_KEY, JSON.stringify([...set]));
  } catch (_) {
    // ignore quota / private mode
  }
  return trialIsBoardGroupChromeExpanded(key);
}

function trialBoardGroupMachineCount(group) {
  const subgroups = Array.isArray(group?.subgroups) ? group.subgroups : [];
  if (subgroups.length) {
    return subgroups.reduce((sum, sub) => sum + (sub.machines?.length || 0), 0);
  }
  return (group?.machines || []).length;
}

/** Main planner: show CNC 35/36/41 lanes (default hidden — use MPP planner tab). */
const TRIAL_MPP_MACHINES_VISIBLE_KEY = 'planner-mpp-machines-visible-v1';

function trialIsMppMachinesVisible() {
  try {
    return localStorage.getItem(TRIAL_MPP_MACHINES_VISIBLE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function trialSetMppMachinesVisible(visible) {
  try {
    localStorage.setItem(TRIAL_MPP_MACHINES_VISIBLE_KEY, visible ? '1' : '0');
  } catch (_) {
    // ignore quota / private mode
  }
}

function trialToggleMppMachinesVisible() {
  trialSetMppMachinesVisible(!trialIsMppMachinesVisible());
  if (typeof renderTrial === 'function') renderTrial({ skipCatalog: true });
}

/** Machinist board: green/red stock tint on lane cards (default off). */
const TRIAL_MACHINIST_STOCK_COLORS_KEY = 'machinist-board-stock-colors-v1';

function trialIsMachinistStockColorsEnabled() {
  try {
    return localStorage.getItem(TRIAL_MACHINIST_STOCK_COLORS_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function trialSetMachinistStockColorsEnabled(enabled) {
  try {
    localStorage.setItem(TRIAL_MACHINIST_STOCK_COLORS_KEY, enabled ? '1' : '0');
  } catch (_) {
    // ignore quota / private mode
  }
  trialSyncMachinistStockColorsClass();
}

function trialSyncMachinistStockColorsClass() {
  if (typeof trialIsMachinistBoard !== 'function' || !trialIsMachinistBoard()) return;
  const on = trialIsMachinistStockColorsEnabled();
  document.body.classList.toggle('machinist-board--stock-colors', on);
  const btn = document.getElementById('machinist-stock-colors-toggle');
  if (btn) {
    btn.classList.toggle('is-on', on);
    btn.classList.toggle('is-off', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (typeof trialMachinistT === 'function') {
      btn.textContent = trialMachinistT('stock_colours');
      btn.title = trialMachinistT('stock_colours_title');
    }
  }
  const legend = document.querySelector('.machinist-board-legend');
  if (legend) legend.hidden = !on;
}

function trialToggleMachinistStockColors() {
  trialSetMachinistStockColorsEnabled(!trialIsMachinistStockColorsEnabled());
}

/** Machinist board: focus view shows current job + queue (lane scrolls after ~5 cards). */
const TRIAL_MACHINIST_FOCUS_KEY = 'machinist-board-focus-v1';

function trialIsMachinistFocusEnabled() {
  try {
    return localStorage.getItem(TRIAL_MACHINIST_FOCUS_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function trialSetMachinistFocusEnabled(enabled) {
  try {
    localStorage.setItem(TRIAL_MACHINIST_FOCUS_KEY, enabled ? '1' : '0');
  } catch (_) {
    // ignore quota / private mode
  }
  trialSyncMachinistFocusClass();
}

function trialSyncMachinistFocusClass() {
  if (typeof trialIsMachinistBoard !== 'function' || !trialIsMachinistBoard()) return;
  const on = trialIsMachinistFocusEnabled();
  document.body.classList.toggle('machinist-board--focus', on);
  const btn = document.getElementById('machinist-focus-toggle');
  if (btn) {
    btn.classList.toggle('is-on', on);
    btn.classList.toggle('is-off', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (typeof trialMachinistT === 'function') {
      btn.textContent = trialMachinistT('focus_view');
      btn.title = trialMachinistT('focus_view_title');
    }
  }
}

function trialToggleMachinistFocus() {
  const next = !trialIsMachinistFocusEnabled();
  trialSetMachinistFocusEnabled(next);
  if (!next && typeof trialSaveMachinistFocusMachineIds === 'function') {
    trialSaveMachinistFocusMachineIds([]);
  }
  if (typeof renderTrial === 'function') renderTrial({ skipCatalog: true });
}

/** Planner board lane zoom (persisted; Chromium `zoom` on the machine grid). */
const TRIAL_BOARD_ZOOM_KEY = 'planner-board-zoom-v1';
const TRIAL_BOARD_ZOOM_MIN = 0.65;
const TRIAL_BOARD_ZOOM_MAX = 1.4;
const TRIAL_BOARD_ZOOM_STEP = 0.05;
const TRIAL_BOARD_ZOOM_DEFAULT = 1;

function trialClampBoardZoom(z) {
  const n = Number(z);
  if (!Number.isFinite(n)) return TRIAL_BOARD_ZOOM_DEFAULT;
  return Math.min(
    TRIAL_BOARD_ZOOM_MAX,
    Math.max(TRIAL_BOARD_ZOOM_MIN, Math.round(n * 100) / 100)
  );
}

function trialGetBoardZoom() {
  try {
    const raw = parseFloat(localStorage.getItem(TRIAL_BOARD_ZOOM_KEY));
    if (!Number.isFinite(raw)) return TRIAL_BOARD_ZOOM_DEFAULT;
    return trialClampBoardZoom(raw);
  } catch (_) {
    return TRIAL_BOARD_ZOOM_DEFAULT;
  }
}

function trialSyncBoardZoomUi(zoom) {
  const z = zoom ?? trialGetBoardZoom();
  const label = document.getElementById('trial-board-zoom-label');
  const outBtn = document.getElementById('trial-board-zoom-out');
  const inBtn = document.getElementById('trial-board-zoom-in');
  if (label) label.textContent = `${Math.round(z * 100)}%`;
  if (outBtn) outBtn.disabled = z <= TRIAL_BOARD_ZOOM_MIN + 0.001;
  if (inBtn) inBtn.disabled = z >= TRIAL_BOARD_ZOOM_MAX - 0.001;
}

function trialSetBoardZoom(z, options = {}) {
  const zoom = trialClampBoardZoom(z);
  const host = document.querySelector('.trial-grid-scroll-host');
  if (host) host.style.setProperty('--trial-board-zoom', String(zoom));
  try {
    localStorage.setItem(TRIAL_BOARD_ZOOM_KEY, String(zoom));
  } catch (_) {
    // ignore quota / private mode
  }
  trialSyncBoardZoomUi(zoom);
  if (!options.skipScrollSync && typeof trialSyncMachineGridScrollWidth === 'function') {
    window.requestAnimationFrame(() => {
      trialSyncMachineGridScrollWidth();
      window.requestAnimationFrame(trialSyncMachineGridScrollWidth);
    });
  }
  return zoom;
}

function trialBumpBoardZoom(delta) {
  return trialSetBoardZoom(trialGetBoardZoom() + Number(delta || 0));
}

function trialInitBoardZoom() {
  const host = document.querySelector('.trial-grid-scroll-host');
  if (!host) return;
  trialSetBoardZoom(trialGetBoardZoom(), { skipScrollSync: true });

  const outBtn = document.getElementById('trial-board-zoom-out');
  const inBtn = document.getElementById('trial-board-zoom-in');
  const label = document.getElementById('trial-board-zoom-label');

  if (outBtn && outBtn.dataset.zoomBound !== '1') {
    outBtn.dataset.zoomBound = '1';
    outBtn.addEventListener('click', () => trialBumpBoardZoom(-TRIAL_BOARD_ZOOM_STEP));
  }
  if (inBtn && inBtn.dataset.zoomBound !== '1') {
    inBtn.dataset.zoomBound = '1';
    inBtn.addEventListener('click', () => trialBumpBoardZoom(TRIAL_BOARD_ZOOM_STEP));
  }
  if (label && label.dataset.zoomBound !== '1') {
    label.dataset.zoomBound = '1';
    label.title = 'Double-click to reset zoom';
    label.addEventListener('dblclick', () => trialSetBoardZoom(TRIAL_BOARD_ZOOM_DEFAULT));
  }

  if (host.dataset.zoomWheelBound === '1') return;
  host.dataset.zoomWheelBound = '1';
  host.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY;
    if (!delta) return;
    trialBumpBoardZoom(delta > 0 ? -TRIAL_BOARD_ZOOM_STEP : TRIAL_BOARD_ZOOM_STEP);
  }, { passive: false });
}
