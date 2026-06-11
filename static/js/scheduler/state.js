// Global scheduler state — loaded first so all other files can reference these vars.

let trialState = {
  machines: [], blocks: [], block_groups: [], segments: [],
  actuals: [], capacities: [], profiles: [], public_holidays: [],
  capacityBundleLoaded: false,
  catalog: [], planned: [], planning_cards: [],
  program_tools_lookup: null,
};
let trialDragPayload = null;
let trialCatalogSearch = '';
let trialCatalogSearchTimer = null;
/** Machinist board job queue search (locate position on lanes). */
let trialMachinistJobSearch = '';
let trialMachinistJobSearchTimer = null;
let trialMachinistJobSearchHits = [];
/** When true, PS / Ops sidebar lists earliest due_date first. */
let trialCatalogSortByDueDate = false;
/** '', 'queued', or 'unqueued' — filter PS / Ops sidebar by machine queue state. */
let trialCatalogQueueFilter = '';
let trialShowCompleted = false;
let trialPsTypeFilter = new Set(['A', 'N', 'T']);
let trialShowSrOrders = false;
let trialMachineCategoryFilter = 'ALL';
let trialMachineHiddenSet = new Set();
/** 'planner' | 'machinist' while machine filter dropdown is open; null when closed. */
let trialMachineFilterPanelOpenScope = null;
/** Machinist focus view: selected machine lanes (persisted, max 4). */
let trialMachinistFocusMachineIds = [];
let trialMachinistFocusMachineIdsLoaded = false;
let trialOpenQueueMachineId = 0;
let trialScheduleDateFilter = { start: '', end: '' };
let trialBOMEditing = [];
let trialBOMMeta = {};
let trialActualDraft = { blockId: null, rows: {}, deletedDates: new Set(), removedTargetDates: new Set() };
let trialActualSaving = false;
let trialMachineSortables = [];
let trialQueueSortable = null;
let trialPlannerBusyDepth = 0;
let trialPlannerBusyLock = 0;
let trialCatalogPointerDrag = null;
let trialCatalogPointerListenersBound = false;
/** Catalog op keys currently being scheduled (prevents double-drop duplicates). */
let trialPendingCatalogOpSchedules = new Set();
// Blocks pinned after schedule POST until schedule refresh includes them (prevents pop-off).
let trialPinnedBlocks = new Map();
/** Machine IDs whose lane order changed without schedule recalc (stale times until recalculate). */
let trialDirtyMachineIds = new Set();
let trialLoadCache = {
  catalog: null,
  catalogExpiresAt: 0,
  machines: null,
  machinesExpiresAt: 0,
};
/** Optimistic material-in overrides keyed by planner ps_id (e.g. NPS25-0279::4). */
let trialMaterialInOverrides = new Map();
