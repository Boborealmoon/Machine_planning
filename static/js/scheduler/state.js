// Global scheduler state — loaded first so all other files can reference these vars.

let trialState = {
  machines: [], blocks: [], block_groups: [], segments: [],
  actuals: [], capacities: [], profiles: [],
  catalog: [], planned: [], planning_cards: [],
};
let trialDragPayload = null;
let trialCatalogSearch = '';
let trialShowCompleted = false;
let trialPsTypeFilter = new Set(['A', 'M', 'N']);
let trialMachineCategoryFilter = 'ALL';
let trialMachineHiddenSet = new Set();
let trialScheduleDateFilter = { start: '', end: '' };
let trialBOMEditing = [];
let trialBOMMeta = {};
let trialActualDraft = { remarks: '', rows: {} };
let trialMachineSortables = [];
let trialCatalogPointerDrag = null;
let trialCatalogPointerListenersBound = false;
