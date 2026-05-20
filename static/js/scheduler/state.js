// Global scheduler state — loaded first so all other files can reference these vars.

let trialState = {
  machines: [], blocks: [], block_groups: [], segments: [],
  actuals: [], capacities: [], profiles: [],
  catalog: [], planned: [], planning_cards: [],
  program_tools_lookup: null,
};
let trialDragPayload = null;
let trialCatalogSearch = '';
let trialShowCompleted = false;
let trialHidePendingDo = true;
let trialHideBlankPs = true;
let trialPsTypeFilter = new Set(['A', 'N']);
let trialShowSrOrders = false;
let trialMachineCategoryFilter = 'ALL';
let trialMachineHiddenSet = new Set();
let trialScheduleDateFilter = { start: '', end: '' };
let trialBOMEditing = [];
let trialBOMMeta = {};
let trialActualDraft = { remarks: '', rows: {} };
let trialMachineSortables = [];
let trialCatalogPointerDrag = null;
let trialCatalogPointerListenersBound = false;
// Blocks pinned after schedule POST until schedule refresh includes them (prevents pop-off).
let trialPinnedBlocks = new Map();
let trialLoadCache = {
  catalog: null,
  catalogExpiresAt: 0,
  machines: null,
  machinesExpiresAt: 0,
};
