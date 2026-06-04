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
