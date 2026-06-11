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
