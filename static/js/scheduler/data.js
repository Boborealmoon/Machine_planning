// State queries, filter helpers, metrics derivation - reads trialState, no DOM writes.

let trialDerivedIndexes = null;

function trialResetDataIndexes() {
  trialDerivedIndexes = null;
}

function trialBuildDerivedIndexes() {
  const perf = (typeof trialPerfStart === 'function')
    ? trialPerfStart('build-derived-indexes', {
      blocks: Array.isArray(trialState.blocks) ? trialState.blocks.length : 0,
      actuals: Array.isArray(trialState.actuals) ? trialState.actuals.length : 0,
    })
    : null;
  const blocksByMachine = new Map();
  const blocksBySourceBase = new Map();
  const blocksByPsPartial = new Map();
  const allocatedOpKeys = new Set();
  const actualTotalsByBlock = new Map();

  (trialState.blocks || []).forEach(block => {
    if (typeof trialIsMainPlannerLaneBlock === 'function' && !trialIsMainPlannerLaneBlock(block)) return;
    const machineKey = String(block.machine_id || '');
    if (!blocksByMachine.has(machineKey)) blocksByMachine.set(machineKey, []);
    blocksByMachine.get(machineKey).push(block);

    const sourceBase = trialSplitPsId(
      block.planner_ps_id || block.source_ps_id || block.job_no,
    ).base;
    if (sourceBase) {
      if (!blocksBySourceBase.has(sourceBase)) blocksBySourceBase.set(sourceBase, []);
      blocksBySourceBase.get(sourceBase).push(block);

      const blockSource = (typeof trialCatalogSourceBase === 'function')
        ? trialCatalogSourceBase({
          planner_ps_id: block.planner_ps_id,
          source_ps_id: block.source_ps_id || block.job_no,
        })
        : sourceBase;
      const partial = String(trialCatalogPartialIndex(block) || 1);
      const partialKey = `${blockSource}::${partial}`;
      if (!blocksByPsPartial.has(partialKey)) blocksByPsPartial.set(partialKey, []);
      blocksByPsPartial.get(partialKey).push(block);

      const opNo = String(block.source_op_no || '').trim();
      const opLabel = String(block.operation_name || '').trim();
      const opSeq = Number(block.source_op_seq_id || 0);
      const addAlloc = (token) => {
        if (token) allocatedOpKeys.add(`${blockSource}::${partial}::${token}`);
      };
      addAlloc(opNo);
      if (opLabel && opLabel !== opNo) addAlloc(opLabel);
      if (opSeq > 0) addAlloc(`step:${opSeq}`);
    }
  });

  blocksByPsPartial.forEach((blocks) => {
    blocks.sort((a, b) => Number(a.block_id) - Number(b.block_id));
  });

  (trialState.actuals || []).forEach(row => {
    const blockId = String(row.block_id || '');
    if (!blockId) return;
    const entry = actualTotalsByBlock.get(blockId) || { output: 0, reject: 0 };
    if (row.output_qty != null) entry.output += Number(row.output_qty || 0);
    if (row.reject_qty != null) entry.reject += Number(row.reject_qty || 0);
    actualTotalsByBlock.set(blockId, entry);
  });

  trialDerivedIndexes = {
    blocksByMachine,
    blocksBySourceBase,
    blocksByPsPartial,
    allocatedOpKeys,
    actualTotalsByBlock,
  };
  if (typeof trialPerfEnd === 'function') {
    trialPerfEnd(perf, {
      index_machines: blocksByMachine.size,
      index_ps_bases: blocksBySourceBase.size,
      index_ps_partials: blocksByPsPartial.size,
      index_allocated_ops: allocatedOpKeys.size,
      index_actual_blocks: actualTotalsByBlock.size,
    });
  }
}

function trialEnsureDataIndexes() {
  if (!trialDerivedIndexes) {
    trialBuildDerivedIndexes();
  }
  return trialDerivedIndexes;
}

function trialMachineCategories() {
  const categories = new Set(
    (trialState.machines || [])
      .map(m => String(m.machine_category || '').trim().toUpperCase())
      .filter(Boolean)
  );
  return ['ALL', ...Array.from(categories).sort()];
}

function trialMachinesInCategory() {
  const selected = String(trialMachineCategoryFilter || 'ALL').toUpperCase();
  if (selected === 'ALL') return trialState.machines || [];
  return (trialState.machines || []).filter(m =>
    String(m.machine_category || '').trim().toUpperCase() === selected
  );
}

function trialVisibleMachines() {
  let machines = trialMachinesInCategory();
  if (typeof trialIsMppMachinesVisible === 'function' && !trialIsMppMachinesVisible()) {
    machines = machines.filter(m => !trialIsMppPlannerMachine(Number(m.machine_id), m.machine_code));
  }
  if (trialMachineHiddenSet.size > 0) {
    machines = machines.filter(m => !trialMachineHiddenSet.has(m.machine_code));
  }
  return machines;
}

/** #1 queue item per visible machine lane (unfiltered by date — true queue head). */
function trialFirstQueueHeads() {
  return (trialVisibleMachines() || []).map(machine => {
    const allGroups = typeof trialBlocksGroupedForMachine === 'function'
      ? trialBlocksGroupedForMachine(machine.machine_id)
      : [];
    return {
      machine,
      machine_id: Number(machine.machine_id || 0),
      machine_code: String(machine.machine_code || '').trim(),
      machine_category: String(machine.machine_category || '').trim(),
      firstGroup: allGroups[0] || null,
      queue_depth: allGroups.length,
    };
  });
}

/**
 * Shop-floor lane groups when Type = All (machine group matrix + subgroup annotations).
 */
const TRIAL_MACHINE_BOARD_GROUPS = [
  {
    id: 'mpp',
    label: 'MPP',
    subgroups: [
      {
        id: 'mpp-production',
        title: 'OSS frame · 3D complex · quick-change',
        hint: 'OSS frame agreement, 3D complex parts, quick-change production',
        machine_codes: ['CNC 35', 'CNC 36', 'CNC 41'],
      },
    ],
  },
  {
    id: 'multiaxis',
    label: 'Multi-Axis',
    subgroups: [
      {
        id: 'ma-index-8',
        title: 'Turn-mill indexing',
        hint: 'Turning + milling indexing · 8″ chuck',
        machine_codes: ['CNC 38'],
      },
      {
        id: 'ma-full5-12',
        title: 'Full 5-axis milling',
        hint: 'Turning + full 5-axis milling · 12″ chuck',
        machine_codes: ['CNC 39', 'CNC 40'],
      },
    ],
  },
  {
    id: 'turning',
    label: 'Turning',
    subgroups: [
      {
        id: 't-mazak-tm',
        title: 'Mazak turn-mill',
        hint: 'Mazak turn-mill · 8″ & 10″ chuck',
        machine_codes: ['CNC 22', 'CNC 30'],
      },
      {
        id: 't-mazak-lathe',
        title: 'Mazak turning',
        hint: 'Mazak turning · 6″ chuck · 8-tool ATC max',
        machine_codes: ['CNC 31', 'CNC 32'],
      },
      {
        id: 't-fanuc-10',
        title: 'Fanuc · 10″ chuck',
        hint: 'Fanuc turning · 10″ chuck turn-mill & lathe',
        machine_codes: ['CNC 10', 'CNC 15'],
      },
      {
        id: 't-fanuc-8',
        title: 'Fanuc · 8″ chuck',
        hint: 'Fanuc turning · 8″ chuck · main & sub-spindle',
        machine_codes: ['CNC 21', 'CNC 24', 'CNC 27'],
      },
    ],
  },
  {
    id: 'milling',
    label: 'Milling',
    subgroups: [
      {
        id: 'm-mitsu-31',
        title: 'Mitsubishi · 3+1',
        hint: 'Mitsubishi controller · 3+1 indexing',
        machine_codes: ['CNC 20'],
      },
      {
        id: 'm-mitsu-32',
        title: 'Mitsubishi · 3+2',
        hint: 'Mitsubishi controller · 3+2 indexing · 750 mm table X',
        machine_codes: ['CNC 29'],
      },
      {
        id: 'm-makino-31',
        title: 'Makino · Mitsubishi · 3+1',
        hint: 'Makino / Mitsubishi milling · 3+1 indexing',
        machine_codes: ['CNC 25', 'CNC 26'],
      },
    ],
  },
];

const TRIAL_MACHINE_BOARD_GROUP_BY_CATEGORY = {
  MPP: 'mpp',
  TURNMILL: 'multiaxis',
  TURNING: 'turning',
  MILLING: 'milling',
};

const TRIAL_MACHINE_BOARD_GROUP_LABELS = {
  mpp: 'MPP',
  multiaxis: 'Multi-Axis',
  turning: 'Turning',
  milling: 'Milling',
};

const TRIAL_MACHINE_BOARD_GROUP_ORDER = ['mpp', 'multiaxis', 'turning', 'milling'];

const TRIAL_MACHINE_BOARD_GROUP_CATEGORY_ORDER = ['MPP', 'TURNMILL', 'TURNING', 'MILLING', 'OTHER'];

function trialSortMachineBoardGroups(groups) {
  return groups.slice().sort((a, b) => {
    const ai = TRIAL_MACHINE_BOARD_GROUP_ORDER.indexOf(a.id);
    const bi = TRIAL_MACHINE_BOARD_GROUP_ORDER.indexOf(b.id);
    const aRank = ai < 0 ? 100 : ai;
    const bRank = bi < 0 ? 100 : bi;
    if (aRank !== bRank) return aRank - bRank;
    return String(a.label || '').localeCompare(String(b.label || ''));
  });
}

function trialShouldGroupMachineLanes() {
  return String(trialMachineCategoryFilter || 'ALL').toUpperCase() === 'ALL';
}

function trialNormalizeMachineCode(code) {
  return String(code || '').trim().toUpperCase();
}

function trialAppendMachinesToBoardGroup(groups, groupId, machines, options = {}) {
  if (!machines.length) return;
  let group = groups.find(row => row.id === groupId);
  if (!group) {
    group = {
      id: groupId,
      label: TRIAL_MACHINE_BOARD_GROUP_LABELS[groupId] || groupId,
      subgroups: [],
      grouped: true,
      fallback: true,
    };
    groups.push(group);
  }
  if (!Array.isArray(group.subgroups)) group.subgroups = [];
  let bucket = group.subgroups.find(sub => sub.fallback);
  if (!bucket) {
    bucket = {
      id: `${groupId}-other`,
      title: options.title || 'Additional machines',
      hint: options.hint || 'Active machines in this category not listed in the matrix',
      machines: [],
      fallback: true,
    };
    group.subgroups.push(bucket);
  }
  bucket.machines.push(...machines);
}

function trialVisibleMachinesGrouped() {
  const visible = trialVisibleMachines();
  if (!trialShouldGroupMachineLanes()) {
    return [{ id: 'flat', label: '', machines: visible, grouped: false }];
  }

  const byCode = new Map();
  visible.forEach(machine => {
    byCode.set(trialNormalizeMachineCode(machine.machine_code), machine);
  });

  const assigned = new Set();
  const groups = [];

  TRIAL_MACHINE_BOARD_GROUPS.forEach(spec => {
    const subgroups = [];
    (spec.subgroups || []).forEach(subSpec => {
      const machines = [];
      (subSpec.machine_codes || []).forEach(code => {
        const key = trialNormalizeMachineCode(code);
        const machine = byCode.get(key);
        if (!machine) return;
        machines.push(machine);
        assigned.add(key);
      });
      if (!machines.length) return;
      subgroups.push({
        id: subSpec.id,
        title: subSpec.title || '',
        hint: subSpec.hint || subSpec.title || '',
        machines,
      });
    });
    if (subgroups.length) {
      groups.push({
        id: spec.id,
        label: spec.label,
        subgroups,
        grouped: true,
      });
    }
  });

  const remainder = visible.filter(machine =>
    !assigned.has(trialNormalizeMachineCode(machine.machine_code))
  );
  if (remainder.length) {
    const categoryRemainder = new Map();
    const buckets = new Map();
    remainder.forEach(machine => {
      const cat = String(machine.machine_category || 'OTHER').trim().toUpperCase() || 'OTHER';
      const groupId = TRIAL_MACHINE_BOARD_GROUP_BY_CATEGORY[cat];
      if (groupId) {
        if (!categoryRemainder.has(groupId)) categoryRemainder.set(groupId, []);
        categoryRemainder.get(groupId).push(machine);
        assigned.add(trialNormalizeMachineCode(machine.machine_code));
        return;
      }
      if (!buckets.has(cat)) buckets.set(cat, []);
      buckets.get(cat).push(machine);
    });
    categoryRemainder.forEach((machines, groupId) => {
      machines.sort((a, b) =>
        trialNormalizeMachineCode(a.machine_code).localeCompare(trialNormalizeMachineCode(b.machine_code))
      );
      trialAppendMachinesToBoardGroup(groups, groupId, machines, {
        title: 'Additional machines',
        hint: `Other active ${TRIAL_MACHINE_BOARD_GROUP_LABELS[groupId] || groupId} machines`,
      });
    });
    const sortedCats = [...buckets.keys()].sort((a, b) => {
      const ai = TRIAL_MACHINE_BOARD_GROUP_CATEGORY_ORDER.indexOf(a);
      const bi = TRIAL_MACHINE_BOARD_GROUP_CATEGORY_ORDER.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
    });
    sortedCats.forEach(cat => {
      const machines = buckets.get(cat).slice().sort((a, b) =>
        trialNormalizeMachineCode(a.machine_code).localeCompare(trialNormalizeMachineCode(b.machine_code))
      );
      if (!machines.length) return;
      groups.push({
        id: `other-${cat.toLowerCase()}`,
        label: trialMachineCategoryLabel(cat),
        machines,
        grouped: true,
        fallback: true,
      });
    });
  }

  return groups.length
    ? trialSortMachineBoardGroups(groups)
    : [{ id: 'flat', label: '', machines: visible, grouped: false }];
}

/** Unique queue slot: base PS + partial + operation (partials may share a lane). */
function trialQueueIdentityKey(row) {
  const raw = row || {};
  if (String(raw.card_kind || '') === 'group' && Number(raw.card_id || 0) > 0) {
    return `group:${Number(raw.card_id)}`;
  }
  const base = (typeof trialCatalogSourceBase === 'function')
    ? trialCatalogSourceBase(raw)
    : trialSplitPsId(String(raw?.ps_id || raw?.source_ps_id || raw?.job_no || '')).base;
  const partial = typeof trialCatalogPartialIndex === 'function'
    ? trialCatalogPartialIndex(raw)
    : 1;
  const op = String(raw?.source_op_no || raw?.operation_label || '').trim();
  const seq = Number(raw?.source_op_seq_id || 0);
  return `${base}|${partial}|${op}|${seq}`;
}

function trialCatalogOpPendingKey(cardOrPayload) {
  return trialQueueIdentityKey(cardOrPayload);
}

/** Resolve catalog card + canonical planner ids for queue POST / lane checks. */
function trialResolveQueueCard(card) {
  const catalogCard = (typeof trialCatalogCardFromPayload === 'function')
    ? (trialCatalogCardFromPayload(card) || card)
    : card;
  const psRow = (typeof trialCatalogPsFromPayload === 'function')
    ? trialCatalogPsFromPayload(card)
    : null;
  const queueId = (typeof trialCatalogQueueIdentity === 'function')
    ? trialCatalogQueueIdentity(card, catalogCard, psRow)
    : null;
  const workCard = queueId?.catalogCtx || catalogCard;
  const partialNo = queueId?.ppPartialNo
    ?? trialCatalogPartialIndex(card)
    ?? trialCatalogPartialIndex(workCard);
  const base = trialCatalogSourceBase(workCard) || trialCatalogSourceBase(card);
  return {
    catalogCard: workCard,
    psRow,
    plannerPsId: queueId?.plannerPsId || trialFormatPlannerPsId(base, partialNo),
    ppPartialNo: partialNo,
  };
}

function trialReserveCatalogOpSchedule(cardOrPayload) {
  const key = trialCatalogOpPendingKey(cardOrPayload);
  if (!key || key === '|' || key === '||0') return { ok: false, key };
  if (trialPendingCatalogOpSchedules.has(key)) return { ok: false, key };
  trialPendingCatalogOpSchedules.add(key);
  return { ok: true, key };
}

function trialReleaseCatalogOpSchedule(key) {
  if (key) trialPendingCatalogOpSchedules.delete(key);
}

function trialMachineDuplicateQueueCount(machineId) {
  if (typeof trialDuplicateQueueBlockIds === 'function') {
    return trialDuplicateQueueBlockIds(machineId).length;
  }
  return 0;
}

function trialCatalogAllocationKey(psId, opNo, opSeqId) {
  const ps = String(psId || '').trim();
  if (!ps) return '';
  const no = String(opNo || '').trim();
  if (no) return `${ps}||op:${no}`;
  const seq = Number(opSeqId || 0);
  if (seq > 0) return `${ps}||seq:${seq}`;
  return '';
}

const TRIAL_TEMP_PARTIAL_MIN = 900001;

function trialIsTempCatalogPs(row) {
  if (!row) return false;
  if (row.is_temp_ps) return true;
  const psId = String(row.ps_id || row.planner_ps_id || '').trim();
  if (psId.startsWith('[Temp]')) return true;
  const src = String(row.source_ps_id || row.job_no || '').trim();
  return src.startsWith('[Temp]');
}

/** [Temp] planner ids on machine lanes that are not yet in the catalog API payload. */
function trialBoardTempPsIdsMissingFromCatalog() {
  const known = new Set();
  [...(trialState.catalog || []), ...(trialState.planned || [])].forEach(ps => {
    const id = String(ps?.ps_id || '').trim();
    if (id) known.add(id);
  });
  const missing = new Set();
  (trialState.blocks || []).forEach(block => {
    const psId = String(block.planner_ps_id || block.source_ps_id || block.job_no || '').trim();
    if (!psId || known.has(psId)) return;
    if (trialIsTempCatalogPs({ ps_id: psId, planner_ps_id: psId, source_ps_id: psId })) {
      missing.add(psId);
    }
  });
  return [...missing];
}

/** Minimal catalog rows for queued [Temp] lines missing from /with-ops (stale cache). */
function trialBoardOnlyTempCatalogEntries() {
  const missing = trialBoardTempPsIdsMissingFromCatalog();
  if (!missing.length) return [];
  const missingSet = new Set(missing);
  const byId = new Map();
  (trialState.blocks || []).forEach(block => {
    const psId = String(block.planner_ps_id || block.source_ps_id || block.job_no || '').trim();
    if (!psId || !missingSet.has(psId)) return;
    let row = byId.get(psId);
    if (!row) {
      const sourceRef = psId.replace(/^\[Temp\]\s*/i, '').trim();
      row = {
        ps_id: psId,
        display_ps_id: typeof trialTempPsDisplayId === 'function' ? trialTempPsDisplayId(psId) : psId,
        is_temp_ps: true,
        source_ps_id: sourceRef,
        temp_source_ps_id: sourceRef,
        pp_partial_no: 1,
        part_no: '',
        part_name: '',
        part_desc: '',
        due_date: '',
        material_in: false,
        partial_qty: 0,
        op_cards: [],
        ops: [],
        _from_board_blocks: true,
      };
      byId.set(psId, row);
    }
    const part = String(block.part_no || block.inventory_code || '').trim();
    if (part && !row.part_no) row.part_no = part;
    if (part && !row.part_name) row.part_name = part;
    const desc = String(block.part_desc || '').trim();
    if (desc && !row.part_desc) row.part_desc = desc;
    const due = String(block.due_date || '').trim();
    if (due && !row.due_date) row.due_date = due;
    if (Object.prototype.hasOwnProperty.call(block, 'material_in') && block.material_in) {
      row.material_in = true;
    }
    if (Object.prototype.hasOwnProperty.call(block, 'tooling_ready') && block.tooling_ready === false) {
      row.tooling_ready = false;
    }
    row.partial_qty = Math.max(
      Number(row.partial_qty || 0),
      Number(block.scheduled_qty || 0),
    );
  });
  return [...byId.values()];
}

/** Catalog rows plus any [Temp] lines visible on the board but absent from the API. */
function trialMergedCatalogRows() {
  const boardTemp = trialBoardOnlyTempCatalogEntries();
  if (!boardTemp.length) return trialState.catalog || [];
  return [...(trialState.catalog || []), ...boardTemp];
}

/** Resolve partial number from pp_partial_no and/or ::suffix on any planner id field. */
function trialCatalogPartialIndex(psIdOrRow, explicitPartialNo) {
  let ppPartial = explicitPartialNo;
  const idFields = [];
  if (psIdOrRow != null && typeof psIdOrRow === 'object') {
    const row = psIdOrRow;
    if (trialIsTempCatalogPs(row)) return 1;
    ppPartial = row.pp_partial_no ?? row.partial_no ?? row.display_partial_no ?? explicitPartialNo;
    idFields.push(row.ps_id, row.source_ps_id, row.job_no);
  } else {
    idFields.push(psIdOrRow);
  }
  const fromField = Number(ppPartial);
  if (Number.isFinite(fromField) && fromField > 0 && fromField < TRIAL_TEMP_PARTIAL_MIN) {
    return Math.floor(fromField);
  }
  let best = 1;
  idFields.forEach(raw => {
    const rawStr = String(raw || '').trim();
    if (rawStr.startsWith('[Temp]')) return;
    const parsed = Number(trialSplitPsId(rawStr).partial);
    if (Number.isFinite(parsed) && parsed > best && parsed < TRIAL_TEMP_PARTIAL_MIN) best = parsed;
  });
  return best;
}

function trialCatalogPlannerPsId(row) {
  const base = (typeof trialCatalogSourceBase === 'function')
    ? trialCatalogSourceBase(row)
    : trialSplitPsId(String(row?.ps_id || row?.source_ps_id || row?.job_no || '')).base;
  if (!base) return '';
  return trialFormatPlannerPsId(base, trialCatalogPartialIndex(row));
}

/** Canonical ids for POST /api/trial/operations — never queue partial 2 as bare base PS. */
function trialCatalogQueueIdentity(card, catalogCard, psRow) {
  const ctx = typeof trialCatalogOpForPs === 'function'
    ? trialCatalogOpForPs(catalogCard || card, psRow)
    : { ...(catalogCard || card || {}) };
  const partial = trialCatalogPartialIndex(ctx);
  const base = (typeof trialCatalogSourceBase === 'function')
    ? trialCatalogSourceBase(ctx)
    : trialSplitPsId(String(ctx?.ps_id || ctx?.source_ps_id || '')).base;
  const plannerPsId = trialFormatPlannerPsId(base, partial);
  return { plannerPsId, ppPartialNo: partial, catalogCtx: ctx };
}

/** Build POST body with canonical planner PS id (Partial 2+ must use ::suffix). */
function trialCanonicalQueuePayload(body, catalogCard) {
  const ctx = catalogCard || {};
  const fromBody = Number(body?.pp_partial_no);
  const fromCtx = trialCatalogPartialIndex(ctx);
  const partial = (Number.isFinite(fromBody) && fromBody > 0)
    ? Math.floor(fromBody)
    : fromCtx;
  const base = (typeof trialCatalogSourceBase === 'function')
    ? trialCatalogSourceBase(ctx)
    : trialSplitPsId(String(
      body?.source_ps_id || body?.job_no || ctx?.ps_id || ctx?.source_ps_id || '',
    )).base;
  const plannerPsId = trialFormatPlannerPsId(base, partial);
  return {
    ...body,
    job_no: plannerPsId,
    source_ps_id: plannerPsId,
    pp_partial_no: partial,
  };
}

function trialFormatPlannerPsId(sourceBase, partialNo) {
  const base = String(sourceBase || '').trim();
  const partial = Math.max(1, Number(partialNo) || 1);
  if (!base) return '';
  if (base.startsWith('[Temp]') || partial >= TRIAL_TEMP_PARTIAL_MIN) return base;
  return partial > 1 ? `${base}::${partial}` : base;
}

function trialCatalogPsFromPayload(payload) {
  const needle = String(payload?.ps_id || payload?.job_no || payload?.source_ps_id || '').trim();
  if (!needle) return null;
  if (typeof trialCatalogFindPsRow === 'function') {
    return trialCatalogFindPsRow(needle, payload?.pp_partial_no || '');
  }
  const parts = trialSplitPsId(needle);
  const base = String(parts.base || needle).trim();
  const wantPartial = String(parts.partial || payload?.pp_partial_no || '').trim() || '1';
  const pools = [...(trialState.catalog || []), ...(trialState.planned || [])];
  return pools.find(ps => {
    if (String(ps.ps_id || '') === needle) return true;
    if (trialIsTempCatalogPs(ps)) {
      return String(ps.ps_id || '').trim() === needle
        || trialCatalogSourceBase(ps) === base;
    }
    const rowBase = trialCatalogSourceBase(ps);
    if (rowBase !== base) return false;
    const rowPartial = String(
      ps.pp_partial_no ?? trialSplitPsId(ps.ps_id || '').partial ?? '1',
    ).trim();
    return rowPartial === wantPartial;
  }) || null;
}

/** Canonical planner PS id for API calls — partial 2+ must use ::suffix, not bare base. */
function trialResolvePlannerPsId(cardOrPayload, psRow) {
  const row = psRow || trialCatalogPsFromPayload(cardOrPayload);
  const base = trialCatalogSourceBase(row || cardOrPayload)
    || trialSplitPsId(String(cardOrPayload?.ps_id || cardOrPayload?.source_ps_id || '')).base;
  let partial = Number(row?.pp_partial_no ?? cardOrPayload?.pp_partial_no);
  if (!Number.isFinite(partial) || partial < 1) {
    partial = trialCatalogPartialIndex(String(cardOrPayload?.ps_id || cardOrPayload?.source_ps_id || ''));
  }
  return trialFormatPlannerPsId(base, partial);
}

function trialBlockMatchesCatalogCard(block, card) {
  if (!block || !card) return false;
  const wantPartial = trialCatalogPartialIndex(card);
  const gotPartial = trialCatalogPartialIndex(block);
  if (wantPartial !== gotPartial) return false;
  return trialCatalogOpMatchesBlock(
    card.source_op_no,
    card.source_op_seq_id,
    card.operation_label,
    block,
  );
}

/** Attach catalog PS partial identity so queue lookups stay per-partial. */
function trialCatalogOpForPs(card, ps) {
  const merged = { ...(card || {}), ...(ps || {}) };
  const isTempPs = trialIsTempCatalogPs(merged);
  const partial = trialCatalogPartialIndex(merged);
  const base = (typeof trialCatalogSourceBase === 'function')
    ? trialCatalogSourceBase(merged)
    : trialSplitPsId(String(merged.ps_id || merged.source_ps_id || '')).base;
  const plannerPsId = trialFormatPlannerPsId(base, partial);
  return {
    ...card,
    is_temp_ps: isTempPs,
    ps_id: plannerPsId || String(merged.ps_id || '').trim(),
    pp_partial_no: partial,
    source_ps_id: base || String(merged.source_ps_id || '').trim(),
  };
}

function trialCatalogOpMatchesBlock(cardOpNo, cardOpSeqId, cardOpLabel, block) {
  const blockOp = String(block?.source_op_no || '').trim();
  const cardOp = String(cardOpNo || '').trim();
  if (cardOp && blockOp && cardOp === blockOp) return true;
  const label = String(cardOpLabel || '').trim();
  if (label && blockOp && label === blockOp) return true;
  const blockSeq = Number(block?.source_op_seq_id || 0);
  const cardSeq = Number(cardOpSeqId || 0);
  return cardSeq > 0 && blockSeq > 0 && cardSeq === blockSeq;
}

/** Run blocks queued for a catalog PS row (exact partial, else legacy queue order). */
function trialBlocksForCatalogPs(ps) {
  const source = (typeof trialCatalogSourceBase === 'function')
    ? trialCatalogSourceBase(ps)
    : (trialSplitPsId(String(ps?.ps_id || '')).base || String(ps?.source_ps_id || '').trim());
  if (!source) return [];
  const wantPartial = trialCatalogPartialIndex(
    String(ps?.ps_id || '').includes('::')
      ? ps.ps_id
      : `${source}::${Number(ps?.pp_partial_no) || 1}`,
  );
  const { blocksBySourceBase, blocksByPsPartial } = trialEnsureDataIndexes();
  const exactFromIndex = blocksByPsPartial?.get(`${source}::${wantPartial}`);
  if (exactFromIndex?.length) {
    return exactFromIndex;
  }
  const allBlocks = (blocksBySourceBase.get(source) || []).filter(block => {
    if (typeof trialIsDummyBlock === 'function' && trialIsDummyBlock(block)) return false;
    if (typeof trialIsMainPlannerLaneBlock === 'function' && !trialIsMainPlannerLaneBlock(block)) return false;
    return true;
  });
  if (!allBlocks.length) return [];
  const exact = allBlocks.filter(block => trialCatalogPartialIndex(block) === wantPartial);
  if (exact.length) {
    return exact.slice().sort((a, b) => Number(a.block_id) - Number(b.block_id));
  }
  // Unsuffixed queue rows are partial 1 only — never attach them to partial 2+.
  if (wantPartial > 1) {
    return [];
  }
  const legacyBlocks = allBlocks.filter(block => {
    const raw = String(block.source_ps_id || block.job_no || '');
    return !raw.includes('::') && trialCatalogPartialIndex(raw) === 1;
  });
  if (!legacyBlocks.length) return [];
  const byOp = new Map();
  legacyBlocks.forEach(block => {
    const opNo = String(block.source_op_no || '').trim() || String(block.operation_name || '').trim();
    const opSeq = Number(block.source_op_seq_id || 0);
    const key = `${opNo}::${opSeq}`;
    if (!byOp.has(key)) byOp.set(key, []);
    byOp.get(key).push(block);
  });
  const picked = [];
  byOp.forEach(blocks => {
    blocks.sort((a, b) => Number(a.block_id) - Number(b.block_id));
    const block = blocks[wantPartial - 1];
    if (block) picked.push(block);
  });
  return picked.sort((a, b) => Number(a.block_id) - Number(b.block_id));
}

/** Queue blocks for one catalog op (same partial + operation; not other partials). */
function trialBlocksForCatalogOp(card) {
  const psLike = {
    ps_id: card?.ps_id || card?.source_ps_id || '',
    source_ps_id: card?.source_ps_id || '',
    pp_partial_no: card?.pp_partial_no,
  };
  return trialBlocksForCatalogPs(psLike)
    .filter(block => trialIsMainPlannerLaneBlock(block))
    .filter(block => trialCatalogOpMatchesBlock(
      card?.source_op_no,
      card?.source_op_seq_id,
      card?.operation_label,
      block,
    ))
    .sort((a, b) => Number(a.block_id) - Number(b.block_id));
}

function trialHasLiveBlockQueueIndex() {
  return Array.isArray(trialState?.blocks);
}

/** CNC lanes owned by the MPP planner tab — must mirror on the main board (planning/machines.py). */
const TRIAL_MPP_PLANNER_MACHINE_CODES = new Set(['CNC 35', 'CNC 36', 'CNC 41']);

function trialIsMppPlannerMachine(machineId, machineCode) {
  const code = trialNormalizeMachineCode(machineCode);
  if (code && TRIAL_MPP_PLANNER_MACHINE_CODES.has(code)) return true;
  const mid = Number(machineId || 0);
  if (!mid) return false;
  const machine = (trialState.machines || []).find(row => Number(row.machine_id) === mid);
  const fromState = trialNormalizeMachineCode(machine?.machine_code || machine?.machine_no);
  if (TRIAL_MPP_PLANNER_MACHINE_CODES.has(fromState)) return true;
  return String(machine?.machine_category || '').toUpperCase() === 'MPP';
}

/** Lane blocks for the main planner board (MPP machines mirror the MPP planner tab). */
function trialIsMainPlannerLaneBlock(block) {
  if (!block) return false;
  if (block.is_mpp_planner_mirror) return true;
  if (trialIsMppPlannerMachine(Number(block.machine_id), block.machine_code)) return true;
  if (String(block.group_type || '').toUpperCase() === 'MPP_CYCLE') return false;
  if (block.is_mpp_planner_owned) return false;
  const groupLabel = String(block.group_label || '').trim();
  if (/^MPP cycle\b/i.test(groupLabel)) return false;
  const opLabel = String(block.operation_name || '').trim();
  if (/^MPP cycle\b/i.test(opLabel)) return false;
  return true;
}

function trialCatalogQueuedQty(cardOrPayload) {
  const card = (typeof trialCatalogCardFromPayload === 'function')
    ? (trialCatalogCardFromPayload(cardOrPayload) || cardOrPayload)
    : cardOrPayload;
  const op = card?.op || {};
  const fromBlocks = trialBlocksForCatalogOp(card)
    .filter(block => trialIsMainPlannerLaneBlock(block))
    .reduce(
      (sum, block) => sum + Math.max(0, Number(block.scheduled_qty || 0)),
      0,
    );
  // Board blocks are authoritative once loaded; catalog planned_qty can lag after remove.
  if (trialHasLiveBlockQueueIndex()) return fromBlocks;
  const fromServer = Math.max(
    0,
    Number(card?.planned_qty ?? op?.planned_qty ?? 0),
  );
  return Math.max(fromBlocks, fromServer);
}

function trialCatalogSchedulableRemaining(cardOrPayload) {
  const op = cardOrPayload?.op || {};
  const serverRemaining = Math.max(0, Number(
    cardOrPayload?.remaining_qty ?? op?.remaining_qty ?? 0,
  ));
  let required = Math.max(0, Number(
    op?.required_qty ?? cardOrPayload?.required_qty ?? 0,
  ));
  if (required <= 0.0001) {
    required = Math.max(0, Number(
      cardOrPayload?.target_qty ?? cardOrPayload?.total_qty ?? op?.total_qty ?? 0,
    ));
  }
  const erpFinished = Math.max(0, Number(
    op?.erp_finished_qty ?? cardOrPayload?.erp_finished_qty ?? 0,
  ));
  const queued = trialCatalogQueuedQty(cardOrPayload);
  if (required > 0.0001) {
    return Math.max(0, required - queued - erpFinished);
  }
  if (queued > 0.0001) {
    return Math.max(0, serverRemaining);
  }
  return serverRemaining;
}

function trialCatalogOpHasQueuedBlocks(card) {
  return trialBlocksForCatalogOp(card).length > 0;
}

function trialIsCatalogOpFullyQueued(card) {
  if (trialCatalogSchedulableRemaining(card) > 0.0001) return false;
  if (trialCatalogOpHasQueuedBlocks(card)) return true;
  if (trialHasLiveBlockQueueIndex()) return false;
  return Number(card?.planned_qty || 0) > 0.0001
    || (Array.isArray(card?.queued_machines) && card.queued_machines.length > 0);
}

/** Open catalog ops for a PS partial that can still be queued (route order). */
function trialSchedulableOpCardsForPs(ps) {
  const cards = typeof trialResolvedOpCardsForPs === 'function'
    ? trialResolvedOpCardsForPs(ps)
    : [];
  const enrich = card => (
    typeof trialCatalogOpForPs === 'function' ? trialCatalogOpForPs(card, ps) : card
  );
  return cards
    .map(enrich)
    .filter(card => String(card.card_kind || 'single') !== 'group')
    .filter(card => !trialCatalogOpIsComplete(card, ps))
    .filter(card => typeof trialCatalogOpCanDrag !== 'function' || trialCatalogOpCanDrag(card, ps))
    .filter(card => trialCatalogSchedulableRemaining(card) > 0.0001)
    .sort((a, b) => (
      Number(a.source_op_seq_id || 0) - Number(b.source_op_seq_id || 0)
      || String(a.source_op_no || a.operation_label || '').localeCompare(String(b.source_op_no || b.operation_label || ''))
    ));
}

function trialIsCatalogOpAllocated(card) {
  const { allocatedOpKeys } = trialEnsureDataIndexes();
  if (allocatedOpKeys?.size) {
    const source = String(
      card?.source_ps_id
      || (typeof trialCatalogSourceBase === 'function' ? trialCatalogSourceBase(card) : '')
      || '',
    ).trim();
    if (!source) return false;
    const partial = String(trialCatalogPartialIndex(card) || 1);
    const prefix = `${source}::${partial}::`;
    const opNo = String(card?.source_op_no || '').trim();
    const opLabel = String(card?.operation_label || '').trim();
    const opSeq = Number(card?.source_op_seq_id || 0);
    if (opNo && allocatedOpKeys.has(prefix + opNo)) return true;
    if (opLabel && opLabel !== opNo && allocatedOpKeys.has(prefix + opLabel)) return true;
    if (opSeq > 0 && allocatedOpKeys.has(prefix + `step:${opSeq}`)) return true;
    return false;
  }
  return trialBlocksForCatalogOp(card).length > 0;
}

function trialQueuedMachineCodesForCatalogOp(card) {
  const fromBlocks = trialBlocksForCatalogOp(card)
    .map(block => String(block.machine_code || '').trim())
    .filter(Boolean);
  if (trialHasLiveBlockQueueIndex()) return [...new Set(fromBlocks)].sort();
  const fromCard = Array.isArray(card?.queued_machines) ? card.queued_machines : [];
  return [...new Set([...fromCard, ...fromBlocks])].sort();
}

function trialBlockForCatalogOpOnMachine(card, machineId) {
  const targetId = Number(machineId || 0);
  if (!targetId) return null;
  return trialBlocksForCatalogOp(card).find(block => Number(block.machine_id) === targetId) || null;
}

function trialIsOpAllocated(psId, opNo) {
  return trialIsCatalogOpAllocated({ source_ps_id: psId, source_op_no: opNo });
}

function trialAllocatedBlockForOp(psId, opNo, opSeqId = 0) {
  return trialFindBlockForCatalogOp({
    source_ps_id: psId,
    source_op_no: opNo,
    source_op_seq_id: opSeqId,
  });
}

function trialHasActiveDateFilter() {
  return Boolean(
    String(trialScheduleDateFilter.start || '').trim() ||
    String(trialScheduleDateFilter.end || '').trim()
  );
}

function trialCanReorderMachineQueue() {
  if (typeof trialIsMachinistBoard === 'function' && trialIsMachinistBoard()) return false;
  return true;
}

function trialFindBlockForCatalogOp(card) {
  const blocks = trialBlocksForCatalogOp(card);
  return blocks.length ? blocks[0] : null;
}

function trialCatalogCardFromPayload(payload) {
  if (!payload) return null;
  const op = payload.op || {};
  const psId = String(payload.ps_id || payload.source_ps_id || op.source_ps_id || '').trim();
  const parts = typeof trialSplitPsId === 'function' ? trialSplitPsId(psId) : { base: psId, partial: '' };
  const isTempPs = Boolean(payload?.is_temp_ps) || psId.startsWith('[Temp]');
  const partialNo = trialCatalogPartialIndex({
    ps_id: psId,
    source_ps_id: payload.source_ps_id,
    pp_partial_no: payload.pp_partial_no ?? parts.partial,
    is_temp_ps: isTempPs,
  });
  const queuePsId = isTempPs
    ? [psId, payload?.source_ps_id, payload?.job_no, op?.source_ps_id, op?.job_no]
      .map(v => String(v || '').trim())
      .find(v => v.startsWith('[Temp]')) || psId
    : String(payload.source_ps_id || psId || op.source_ps_id || '').trim();
  return {
    ps_id: psId,
    pp_partial_no: partialNo,
    is_temp_ps: isTempPs,
    source_ps_id: queuePsId,
    source_op_no: payload.source_op_no || op.source_op_no || payload.operation_label || '',
    source_op_seq_id: Number(payload.source_op_seq_id || op.source_op_seq_id || 0),
    operation_label: payload.operation_label || '',
    remaining_qty: Number(payload.remaining_qty ?? op.remaining_qty ?? 0),
    required_qty: Number(payload.required_qty ?? op.required_qty ?? 0),
    erp_finished_qty: Number(payload.erp_finished_qty ?? op.erp_finished_qty ?? 0),
    planned_qty: Number(payload.planned_qty ?? op.planned_qty ?? 0),
  };
}

/** True when this PS/op has a lane block on the machine and the board can show it. */
function trialCatalogOpVisibleOnMachineLane(card, machineId) {
  const block = trialBlockForCatalogOpOnMachine(card, machineId);
  if (!block) return false;
  const mid = Number(machineId || 0);
  if (!mid || Number(block.machine_id) !== mid) return false;

  if (typeof trialHasActiveDateFilter === 'function' && trialHasActiveDateFilter()) {
    const groups = typeof trialBlocksGroupedForMachine === 'function'
      ? trialBlocksGroupedForMachine(mid)
      : [];
    const group = groups.find(row =>
      String(row?.leader?.block_id) === String(block.block_id)
      || (row?.blocks || []).some(b => String(b.block_id) === String(block.block_id)),
    );
    if (group && typeof trialGroupRunsInsideDateFilter === 'function') {
      return trialGroupRunsInsideDateFilter(group);
    }
    // Newly queued blocks may not be grouped yet — still treat as on-lane.
    return true;
  }
  return true;
}

function trialParseDateTime(value) {
  if (!value) return null;
  const text = String(value).replace(' ', 'T');
  const dt = new Date(text);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function trialLocalDateText(value) {
  const dt = trialParseDateTime(value);
  return dt ? trialDateText(dt) : '';
}

function trialGroupQueuedDay(group) {
  const leader = group.leader || (group.blocks || [])[0];
  const queuedAt = trialParseDateTime(
    group.visual_start_datetime || group.group_start ||
    leader?.visual_start_datetime || leader?.calculated_start_datetime ||
    leader?.anchor_datetime
  );
  return trialLocalDateText(queuedAt);
}

function trialMachinistGroupSearchHaystack(group) {
  const leader = group?.leader || (group?.blocks || [])[0];
  if (!leader) return [];
  const psId = String(
    group.ps_id || leader.planner_ps_id || leader.job_no || leader.source_ps_id || '',
  ).trim();
  const parts = typeof trialSplitPsId === 'function'
    ? trialSplitPsId(psId)
    : { base: psId, partial: '' };
  const blocks = Array.isArray(group?.blocks) ? group.blocks : [leader];
  return trialSearchableTokens([
    psId,
    parts.base,
    parts.partial ? `partial ${parts.partial}` : '',
    leader.job_no,
    leader.source_ps_id,
    leader.planner_ps_id,
    group.operation_label,
    group.group_label,
    ...blocks.flatMap(block => [
      block?.source_op_no,
      block?.operation_name,
      block?.group_label,
    ]),
  ]);
}

function trialMachinistJobMatchesQuery(group, query) {
  const rawQuery = String(query || '').trim();
  if (!rawQuery || rawQuery.length < 2) return false;
  const normalizedQuery = trialNormalizeSearchText(rawQuery);
  const rawLower = rawQuery.toLowerCase();
  const haystack = trialMachinistGroupSearchHaystack(group);
  return haystack.some(token => {
    const text = String(token).toLowerCase();
    const normalized = trialNormalizeSearchText(token);
    return text.includes(rawLower)
      || (normalizedQuery && normalized.includes(normalizedQuery));
  });
}

/** Find queued jobs across all machines; returns lane position (#1 = queue head). */
function trialSearchMachinistQueues(query) {
  const needle = String(query || '').trim();
  if (!needle || needle.length < 2) return [];
  const machines = Array.isArray(trialState.machines) ? trialState.machines : [];
  const hits = [];
  machines.forEach(machine => {
    const groups = typeof trialBlocksGroupedForMachine === 'function'
      ? trialBlocksGroupedForMachine(machine.machine_id)
      : [];
    groups.forEach((group, idx) => {
      if (!trialMachinistJobMatchesQuery(group, needle)) return;
      const vm = typeof trialBlockGroupViewModel === 'function'
        ? trialBlockGroupViewModel(group, { displaySequenceNo: idx + 1 })
        : null;
      hits.push({
        machineId: Number(machine.machine_id || 0),
        machineCode: String(machine.machine_code || '').trim(),
        machineCategory: String(machine.machine_category || '').trim(),
        queuePosition: idx + 1,
        groupId: Number(group.group_id || 0),
        blockId: Number(group.leader?.block_id || 0),
        psDisplay: String(vm?.psDisplay?.base || group.ps_id || group.title || '').trim(),
        operationLine: String(vm?.operationLine || group.operation_label || '').trim(),
        partial: String(vm?.psDisplay?.partial || '').trim(),
      });
    });
  });
  return hits.sort((a, b) =>
    a.machineCode.localeCompare(b.machineCode, undefined, { numeric: true })
    || a.queuePosition - b.queuePosition,
  );
}

function trialEnsureMachineLaneVisibleForSearch(machine) {
  if (!machine) return false;
  let changed = false;
  const code = String(machine.machine_code || '').trim();
  if (code && trialMachineHiddenSet.has(code)) {
    trialMachineHiddenSet.delete(code);
    changed = true;
  }
  if (typeof trialIsMppPlannerMachine === 'function'
    && trialIsMppPlannerMachine(Number(machine.machine_id), code)
    && typeof trialIsMppMachinesVisible === 'function'
    && !trialIsMppMachinesVisible()) {
    if (typeof trialSetMppMachinesVisible === 'function') trialSetMppMachinesVisible(true);
    changed = true;
  }
  const machineCat = String(machine.machine_category || '').trim().toUpperCase();
  const filterCat = String(trialMachineCategoryFilter || 'ALL').trim().toUpperCase();
  if (machineCat && filterCat !== 'ALL' && filterCat !== machineCat) {
    trialMachineCategoryFilter = 'ALL';
    changed = true;
  }
  return changed;
}

function trialEnsureMachinistFocusMachineSelected(machineId) {
  const id = Number(machineId || 0);
  if (!id || typeof trialMachinistFocusLayoutActive !== 'function' || !trialMachinistFocusLayoutActive()) {
    return false;
  }
  const ids = typeof trialGetMachinistFocusMachineIds === 'function'
    ? trialGetMachinistFocusMachineIds()
    : [];
  if (ids.includes(id)) return false;
  if (ids.length >= trialMachinistFocusMaxMachines()) {
    if (typeof toast === 'function') {
      toast(
        typeof trialMachinistT === 'function'
          ? trialMachinistT('add_machine_focus', { max: trialMachinistFocusMaxMachines() })
          : `Add this machine in focus view (max ${trialMachinistFocusMaxMachines()} selected)`,
        'error',
      );
    }
    return false;
  }
  if (typeof trialToggleMachinistFocusMachine === 'function') {
    trialToggleMachinistFocusMachine(id);
    return true;
  }
  return false;
}

function trialMachinistFocusMaxJobs() {
  return 5;
}

/** Machinist focus view: full queue in planner order (lane scrolls after ~5 visible cards). */
function trialMachinistFocusGroups(groups) {
  const rows = Array.isArray(groups) ? groups : [];
  return rows.length ? rows : [];
}

function trialMachinistFocusLayoutActive() {
  return typeof trialIsMachinistBoard === 'function'
    && trialIsMachinistBoard()
    && typeof trialIsMachinistFocusEnabled === 'function'
    && trialIsMachinistFocusEnabled();
}

const TRIAL_MACHINIST_FOCUS_MACHINE_KEY = 'machinist-board-focus-machine-v1';
const TRIAL_MACHINIST_FOCUS_MACHINES_KEY = 'machinist-board-focus-machines-v2';

function trialMachinistFocusMaxMachines() {
  return 4;
}

function trialLoadMachinistFocusMachineIds() {
  const max = trialMachinistFocusMaxMachines();
  try {
    const raw = localStorage.getItem(TRIAL_MACHINIST_FOCUS_MACHINES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.map(id => Number(id)).filter(id => id > 0))].slice(0, max);
      }
    }
  } catch (_) {
    // ignore quota / private mode
  }
  return [];
}

function trialSaveMachinistFocusMachineIds(ids) {
  const max = trialMachinistFocusMaxMachines();
  const normalized = [...new Set((ids || []).map(id => Number(id)).filter(id => id > 0))].slice(0, max);
  trialMachinistFocusMachineIds = normalized;
  trialMachinistFocusMachineIdsLoaded = true;
  try {
    if (normalized.length) {
      localStorage.setItem(TRIAL_MACHINIST_FOCUS_MACHINES_KEY, JSON.stringify(normalized));
    } else {
      localStorage.removeItem(TRIAL_MACHINIST_FOCUS_MACHINES_KEY);
    }
    localStorage.removeItem(TRIAL_MACHINIST_FOCUS_MACHINE_KEY);
  } catch (_) {
    // ignore quota / private mode
  }
  return normalized;
}

function trialGetMachinistFocusMachineIds() {
  if (!trialMachinistFocusMachineIdsLoaded) {
    trialMachinistFocusMachineIds = trialLoadMachinistFocusMachineIds();
    trialMachinistFocusMachineIdsLoaded = true;
  }
  return [...trialMachinistFocusMachineIds];
}

function trialMachinesForFocusGrid() {
  return (trialVisibleMachines() || []).filter(machine => {
    const allGroups = typeof trialBlocksGroupedForMachine === 'function'
      ? trialBlocksGroupedForMachine(machine.machine_id)
      : [];
    const groups = allGroups.filter(
      row => typeof trialGroupRunsInsideDateFilter === 'function' && trialGroupRunsInsideDateFilter(row),
    );
    return typeof trialMachinistFocusGroups === 'function' && trialMachinistFocusGroups(groups).length > 0;
  });
}

function trialResolveMachinistFocusMachines() {
  const ids = trialGetMachinistFocusMachineIds();
  if (!ids.length) return [];
  const candidates = trialMachinesForFocusGrid();
  if (!candidates.length) return [];
  const byId = new Map(candidates.map(machine => [Number(machine.machine_id), machine]));
  return ids.map(id => byId.get(Number(id))).filter(Boolean);
}

function trialSyncMachinistFocusMachineIds() {
  const candidates = trialMachinesForFocusGrid();
  const candidateIds = new Set(candidates.map(machine => Number(machine.machine_id)));
  const pruned = trialGetMachinistFocusMachineIds().filter(id => candidateIds.has(id));
  const currentIds = trialGetMachinistFocusMachineIds();
  if (pruned.join(',') !== currentIds.join(',')) {
    trialSaveMachinistFocusMachineIds(pruned);
  }
}

function trialToggleMachinistFocusMachine(machineId) {
  const id = Number(machineId || 0);
  if (!id) return;
  const candidates = trialMachinesForFocusGrid();
  if (!candidates.some(machine => Number(machine.machine_id) === id)) return;
  const ids = [...trialGetMachinistFocusMachineIds()];
  const idx = ids.indexOf(id);
  if (idx >= 0) {
    ids.splice(idx, 1);
  } else {
    if (ids.length >= trialMachinistFocusMaxMachines()) {
      if (typeof toast === 'function') {
        toast(
          typeof trialMachinistT === 'function'
            ? trialMachinistT('max_machines_focus', { max: trialMachinistFocusMaxMachines() })
            : `Maximum ${trialMachinistFocusMaxMachines()} machines in focus view`,
          'error',
        );
      }
      return;
    }
    ids.push(id);
  }
  trialSaveMachinistFocusMachineIds(ids);
  if (typeof renderTrial === 'function') renderTrial({ skipCatalog: true });
}

function trialClearMachinistFocusMachines() {
  trialSaveMachinistFocusMachineIds([]);
  if (typeof renderTrial === 'function') renderTrial({ skipCatalog: true });
}

function trialSegmentTargetQty(seg) {
  return Math.max(0, Number(seg?.qty_done ?? seg?.planned_qty ?? 0));
}

function trialSegmentDateKey(seg) {
  const dated = String(seg?.segment_date || '').trim();
  if (dated) return dated.slice(0, 10);
  const start = String(seg?.start_datetime || seg?.visual_start_datetime || '').trim();
  return start ? start.slice(0, 10) : '';
}

function trialFocusTargetForBlock(blockId, today) {
  if (!blockId || !today || typeof trialSegmentsForBlock !== 'function') return 0;
  const segs = trialSegmentsForBlock(blockId)
    .filter(seg => String(seg.segment_type || '') === 'production');
  if (!segs.length) return 0;

  const todaySegs = segs.filter(seg => trialSegmentDateKey(seg) === today);
  if (todaySegs.length) {
    return todaySegs.reduce((sum, seg) => sum + trialSegmentTargetQty(seg), 0);
  }

  const dayStart = typeof trialParseDateTime === 'function'
    ? trialParseDateTime(`${today}T00:00:00`)
    : new Date(`${today}T00:00:00`);
  const dayEnd = typeof trialParseDateTime === 'function'
    ? trialParseDateTime(`${today}T23:59:59`)
    : new Date(`${today}T23:59:59`);
  if (dayStart && dayEnd) {
    const spanning = segs.filter(seg => {
      const start = trialParseDateTime(seg.start_datetime || seg.visual_start_datetime);
      const end = trialParseDateTime(seg.end_datetime || seg.visual_end_datetime);
      if (!start) return false;
      return start <= dayEnd && (!end || end >= dayStart);
    });
    if (spanning.length) {
      return spanning.reduce((sum, seg) => sum + trialSegmentTargetQty(seg), 0);
    }
  }

  const upcoming = segs
    .map(seg => ({ seg, date: trialSegmentDateKey(seg) }))
    .filter(row => row.date && row.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || Number(a.seg.segment_id || 0) - Number(b.seg.segment_id || 0));
  if (upcoming.length) {
    const nextDate = upcoming[0].date;
    return upcoming
      .filter(row => row.date === nextDate)
      .reduce((sum, row) => sum + trialSegmentTargetQty(row.seg), 0);
  }

  const block = (trialState.blocks || []).find(row => Number(row.block_id) === Number(blockId));
  if (block && typeof trialBlockMemberMetrics === 'function') {
    const metrics = trialBlockMemberMetrics(block);
    return Math.max(0, Number(metrics.remainingQty ?? 0));
  }
  return 0;
}

function trialFocusTargetForGroup(group) {
  const blocks = Array.isArray(group?.blocks) && group.blocks.length
    ? group.blocks
    : [group?.leader].filter(Boolean);
  const today = typeof trialTodayISO === 'function' ? trialTodayISO() : '';
  if (!today || !blocks.length) return 0;
  return blocks.reduce((sum, block) => sum + trialFocusTargetForBlock(block?.block_id, today), 0);
}

function trialTodayTargetForGroup(group) {
  return trialFocusTargetForGroup(group);
}

function trialGroupRunsInsideDateFilter(group) {
  const filterStartDay = String(trialScheduleDateFilter.start || '').trim();
  const filterEndDay = String(trialScheduleDateFilter.end || '').trim();
  if (!filterStartDay && !filterEndDay) return true;

  const queuedDay = trialGroupQueuedDay(group);
  // Keep blocks visible until queue timing is calculated (newly dropped ops).
  if (!queuedDay) return true;

  if (filterStartDay && queuedDay < filterStartDay) return false;
  if (filterEndDay && queuedDay > filterEndDay) return false;
  return true;
}

function trialMachineLaneEmptyMessage(totalGroups, visibleGroups) {
  if (typeof trialIsMachinistBoard === 'function' && trialIsMachinistBoard()
    && typeof trialMachinistLaneEmptyMessage === 'function') {
    return trialMachinistLaneEmptyMessage(totalGroups, visibleGroups);
  }
  if (totalGroups > 0 && visibleGroups === 0 && trialHasActiveDateFilter()) {
    const n = totalGroups === 1 ? '1 block is' : `${totalGroups} blocks are`;
    return `${n} on this machine outside the date filter. Clear dates to show all.`;
  }
  if (trialHasActiveDateFilter()) return 'No run blocks in this date range.';
  return 'No run blocks yet for this machine.';
}

function trialCapacityKey(machineId, workDate) {
  return `${machineId}::${workDate}`;
}

function trialCapacityByKey() {
  const map = new Map();
  (trialState.capacities || []).forEach(row =>
    map.set(trialCapacityKey(row.machine_id, row.work_date), row)
  );
  return map;
}

function trialBlocksForMachine(machineId) {
  const { blocksByMachine } = trialEnsureDataIndexes();
  return (blocksByMachine.get(String(machineId)) || [])
    .filter(block => typeof trialIsMainPlannerLaneBlock !== 'function' || trialIsMainPlannerLaneBlock(block));
}

function trialGroupSummaryBlocksForMachine(machineId) {
  return (trialState.block_groups || []).filter(g => String(g.machine_id || 0) === String(machineId));
}

function trialSegmentsForBlock(blockId) {
  return (trialState.segments || []).filter(seg => String(seg.block_id) === String(blockId));
}

function trialActualsForBlock(blockId) {
  return (trialState.actuals || []).filter(row => String(row.block_id) === String(blockId));
}

function trialActualForSegment(segmentId) {
  const exact = (trialState.actuals || []).find(row =>
    String(row.segment_id || '') === String(segmentId || '')
  );
  if (exact) return exact;
  const segment = (trialState.segments || []).find(seg =>
    String(seg.segment_id || '') === String(segmentId || '')
  );
  if (!segment) return null;
  return (trialState.actuals || []).find(row =>
    String(row.block_id || '') === String(segment.block_id || '') &&
    String(row.report_date || '') === String(segment.segment_date || '')
  ) || null;
}

function trialActualForBlockDate(blockId, reportDate) {
  return (trialState.actuals || []).find(row =>
    String(row.block_id || '') === String(blockId || '') &&
    String(row.report_date || '') === String(reportDate || '')
  ) || null;
}

function trialActualRowsForBlock(blockId) {
  const rowMap = new Map();
  trialSegmentsForBlock(blockId)
    .filter(seg => String(seg.segment_type || '') === 'production')
    .sort((a, b) =>
      String(a.start_datetime || '').localeCompare(String(b.start_datetime || '')) ||
      Number(a.segment_id || 0) - Number(b.segment_id || 0)
    )
    .forEach(seg => {
      const reportDate = String(seg.segment_date || '');
      if (!reportDate) return;
      rowMap.set(reportDate, {
        report_date: reportDate,
        segment: seg,
        actual: trialActualForSegment(seg.segment_id) || trialActualForBlockDate(blockId, reportDate),
        target_qty: Number(seg.qty_done || 0),
        actual_only: false,
      });
    });
  trialActualsForBlock(blockId).forEach(actual => {
    const reportDate = String(actual.report_date || '');
    if (!reportDate || rowMap.has(reportDate)) return;
    rowMap.set(reportDate, {
      report_date: reportDate,
      segment: null,
      actual,
      target_qty: Number(actual.target_qty_at_report || 0),
      actual_only: true,
    });
  });
  return Array.from(rowMap.values()).sort((a, b) =>
    String(a.report_date).localeCompare(String(b.report_date))
  );
}

function trialActualTargetsForBlock(blockId) {
  const segs = trialSegmentsForBlock(blockId).filter(seg =>
    String(seg.segment_type || '') === 'production'
  );
  const grouped = new Map();
  segs.forEach(seg => {
    const key = String(seg.segment_date || '');
    if (!key) return;
    const qty = Number(seg.qty_done || 0);
    const existing = grouped.get(key) || { report_date: key, target_qty: 0, target_minutes: 0 };
    existing.target_qty += qty;
    existing.target_minutes += Number(seg.minutes_used || 0);
    grouped.set(key, existing);
  });
  return Array.from(grouped.values()).sort((a, b) =>
    String(a.report_date).localeCompare(String(b.report_date))
  );
}

function trialIntegerizeTargets(rows, totalQty) {
  const targetTotal = Math.max(0, Math.round(Number(totalQty || 0)));
  const prepared = (rows || []).map(row => {
    const raw = Math.max(0, Number(row.target_qty || 0));
    const base = Math.floor(raw);
    return { ...row, raw_qty: raw, display_qty: base, remainder: raw - base };
  });
  let remaining = targetTotal - prepared.reduce((sum, row) => sum + Number(row.display_qty || 0), 0);
  if (remaining > 0) {
    [...prepared]
      .sort((a, b) => (b.remainder - a.remainder) || String(a.report_date).localeCompare(String(b.report_date)))
      .slice(0, remaining)
      .forEach(row => {
        const target = prepared.find(item => item.report_date === row.report_date);
        if (target) target.display_qty += 1;
      });
  } else if (remaining < 0) {
    [...prepared]
      .sort((a, b) => (a.remainder - b.remainder) || String(a.report_date).localeCompare(String(b.report_date)))
      .slice(0, Math.abs(remaining))
      .forEach(row => {
        const target = prepared.find(item => item.report_date === row.report_date);
        if (target && target.display_qty > 0) target.display_qty -= 1;
      });
  }
  return prepared;
}

function trialBlocksByIds(blockIds) {
  const ids = new Set((blockIds || []).map(id => String(id)));
  return (trialState.blocks || []).filter(b => ids.has(String(b.block_id)));
}

function trialFindGroupSummaryById(groupId) {
  const numericGroupId = Number(groupId || 0);
  if (!numericGroupId) return null;
  const direct = (trialState.block_groups || []).find(g => Number(g.group_id || 0) === numericGroupId);
  if (direct) return direct;
  for (const machine of (trialState.machines || [])) {
    const groups = trialBlocksGroupedForMachine(machine.machine_id);
    const found = groups.find(g => Number(g.group_id || 0) === numericGroupId);
    if (found) return found;
  }
  return null;
}

function trialCombinedActualModels(group) {
  const blocks = Array.isArray(group?.blocks) && group.blocks.length
    ? group.blocks
    : (trialState.blocks || [])
        .filter(item => String(item.group_id || 0) === String(group?.group_id || 0))
        .sort((a, b) =>
          Number(a.queue_position || 0) - Number(b.queue_position || 0) ||
          Number(a.block_id || 0) - Number(b.block_id || 0)
        );
  return blocks.map(block => {
    const metrics = trialBlockMemberMetrics(block);
    const segments = trialSegmentsForBlock(block.block_id)
      .filter(seg => String(seg.segment_type || '') === 'production')
      .sort((a, b) =>
        String(a.start_datetime || '').localeCompare(String(b.start_datetime || '')) ||
        Number(a.segment_id || 0) - Number(b.segment_id || 0)
      );
    return {
      block: metrics,
      source: block,
      segments,
      outputTotal: metrics.outputTotal,
      rejectTotal: metrics.rejectTotal,
      remainingQty: metrics.remainingQty,
      remainingMinutes: metrics.remainingMinutes,
    };
  });
}

// ── Metrics ──────────────────────────────────────────────────────────────────

function trialStatusClass(status) {
  const text = String(status || '').toUpperCase();
  if (text === 'DONE') return 'green';
  if (text === 'IN_PROGRESS') return 'orange';
  return 'gray';
}

function trialPlanningStatusClass(status) {
  const text = String(status || '').toUpperCase();
  if (text === 'PLANNED') return 'blue';
  if (text === 'PARTIALLY_PLANNED') return 'yellow';
  return 'gray';
}

function trialBlockGroupKey(block) {
  return String(block.group_id || block.block_id || '');
}

function trialMachineGroupSortKey(group) {
  const leader = group?.leader || group?.blocks?.[0] || {};
  return {
    queue: Number(leader.queue_position ?? group?.queue_position ?? 0),
    start: String(
      group?.visual_start_datetime || group?.group_start ||
      leader?.visual_start_datetime || leader?.calculated_start_datetime ||
      leader?.anchor_datetime || ''
    ),
    blockId: Number(leader.block_id || group?.group_id || 0),
  };
}

function trialCompareMachineGroups(a, b) {
  const left = trialMachineGroupSortKey(a);
  const right = trialMachineGroupSortKey(b);
  if (left.queue !== right.queue) return left.queue - right.queue;
  if (left.start !== right.start) return left.start.localeCompare(right.start);
  return left.blockId - right.blockId;
}

function trialBlockNetOutput(actualGood, actualReject) {
  return Math.max(0, Number(actualGood || 0) - Number(actualReject || 0));
}

function trialBlockPendingSetupMinutes(block, outputTotal = 0, rejectTotal = 0) {
  if (Number(block?.include_setup || 0) !== 1) return 0;
  if (Number(outputTotal || 0) > 0 || Number(rejectTotal || 0) > 0) return 0;
  return Math.max(0, Number(block?.setup_minutes || 0));
}

function trialOperationSiblingBlocks(block) {
  const operationId = Number(block?.operation_id || 0);
  if (!operationId) return block ? [block] : [];
  return (trialState.blocks || [])
    .filter(row => Number(row?.operation_id || 0) === operationId)
    .sort((left, right) =>
      Number(left?.queue_position || 0) - Number(right?.queue_position || 0) ||
      Number(left?.block_id || 0) - Number(right?.block_id || 0)
    );
}

function trialAllocateQtyAcrossSiblings(block, totalQty) {
  const siblings = trialOperationSiblingBlocks(block);
  let remaining = Math.max(0, Number(totalQty || 0));
  if (siblings.length <= 1) {
    const scheduledQty = Math.max(0, Number(block?.scheduled_qty || 0));
    return scheduledQty > 0 ? Math.min(remaining, scheduledQty) : remaining;
  }
  for (const sibling of siblings) {
    const scheduledQty = Math.max(0, Number(sibling?.scheduled_qty || 0));
    const allocated = Math.min(scheduledQty, remaining);
    if (Number(sibling?.block_id || 0) === Number(block?.block_id || 0)) {
      return allocated;
    }
    remaining -= allocated;
  }
  return 0;
}

function trialCatalogOperationProducedQty(block) {
  const sourcePs = String(block?.source_ps_id || block?.job_no || '').trim();
  if (!sourcePs) return 0;
  const sourceParts = trialSplitPsId(sourcePs);
  const sourceBase = String(sourceParts.base || '').trim();
  const sourcePartial = String(sourceParts.partial || '').trim();
  if (!sourceBase) return 0;
  const pools = [
    ...(Array.isArray(trialState.catalog) ? trialState.catalog : []),
    ...(Array.isArray(trialState.planned) ? trialState.planned : []),
  ];
  for (const ps of pools) {
    const psId = String(ps?.ps_id || '').trim();
    if (!psId) continue;
    const psParts = trialSplitPsId(psId);
    const psBase = String(psParts.base || '').trim();
    const psPartial = String(psParts.partial || ps?.pp_partial_no || '').trim();
    if (psBase !== sourceBase) continue;
    if (sourcePartial && psPartial && sourcePartial !== psPartial) continue;
    const cards = Array.isArray(ps?.op_cards) ? ps.op_cards : [];
    const hit = cards.find(card => trialCatalogOpMatchesBlock(
      card?.source_op_no,
      card?.source_op_seq_id,
      card?.operation_label,
      block,
    ));
    if (!hit) continue;
    const opRef = hit?.op || {};
    return Math.max(0, Number(
      hit?.finished_qty ?? hit?.erp_finished_qty ?? hit?.wo_qty_produced ??
      opRef.finished_qty ?? opRef.erp_finished_qty ?? opRef.wo_qty_produced ?? 0
    ));
  }
  return 0;
}

function trialBlockMemberMetrics(block) {
  const { actualTotalsByBlock } = trialEnsureDataIndexes();
  const blockTotals = actualTotalsByBlock.get(String(block.block_id || '')) || { output: 0, reject: 0 };
  const shopOutputTotal = Number(blockTotals.output || 0);
  const shopRejectTotal = Number(blockTotals.reject || 0);
  const effective = block?.effective_actuals || {};
  const recon = block?.erp_reconciliation || {};
  let outputTotal = Number(
    effective.effective_output_qty ?? recon.effective_output_qty ?? shopOutputTotal
  );
  let rejectTotal = Number(
    effective.effective_reject_qty ?? recon.effective_reject_qty ?? shopRejectTotal
  );
  const scheduledQty = Number(block.scheduled_qty || 0);
  const shopNetOutput = trialBlockNetOutput(shopOutputTotal, shopRejectTotal);
  const blockGoodQty = Math.max(0, Number(block?.good_qty ?? block?.actual_good_qty ?? 0));
  const hasBlockShopActuals = shopOutputTotal > 0 || shopRejectTotal > 0;
  const siblings = trialOperationSiblingBlocks(block);
  let netOutput = 0;
  if (hasBlockShopActuals) {
    netOutput = shopNetOutput;
  } else if (blockGoodQty > 0) {
    netOutput = blockGoodQty;
    if (outputTotal <= 0) outputTotal = blockGoodQty;
  } else {
    let operationGood = Number(
      effective.effective_good_qty ?? recon.effective_good_qty ?? 0
    );
    if (operationGood <= 0) {
      operationGood = trialCatalogOperationProducedQty(block);
    }
    netOutput = siblings.length > 1
      ? trialAllocateQtyAcrossSiblings(block, operationGood)
      : Math.min(Math.max(0, operationGood), scheduledQty || operationGood);
    if (outputTotal <= 0 && netOutput > 0) {
      outputTotal = netOutput;
    }
  }
  const status = String(block.execution_status || block.status || '').toUpperCase();
  const isCompleted = status === 'DONE' || status === 'COMPLETED' || status === 'C';
  // Lite schedule payloads can omit ERP reconciliation totals; if a block is marked complete,
  // treat scheduled qty as fully output so machine cards do not show stale "OUT 0".
  if (isCompleted && scheduledQty > 0 && outputTotal <= 0 && rejectTotal <= 0 && netOutput <= 0) {
    outputTotal = scheduledQty;
    netOutput = scheduledQty;
  }
  // Remaining follows ERP "WO req − finished/produced", not good qty after rejects.
  const producedQty = outputTotal > 0 ? outputTotal : netOutput;
  const remainingQty = Math.max(0, scheduledQty - producedQty);
  const pendingSetupMinutes = trialBlockPendingSetupMinutes(block, outputTotal, rejectTotal);
  const remainingMinutes = pendingSetupMinutes + (remainingQty * Number(block.cycle_minutes_per_qty || 0));
  return {
    ...block,
    shopOutputTotal,
    shopRejectTotal,
    outputTotal,
    rejectTotal,
    netOutput,
    remainingQty,
    qtySources: {
      output: effective.output_source || recon.output_source || 'shop',
      reject: effective.reject_source || recon.reject_source || 'shop',
      good: effective.good_source || recon.good_source || 'shop',
    },
    pendingSetupMinutes,
    remainingMinutes,
    isDone: status === 'DONE',
    isInProgress: status === 'IN_PROGRESS',
  };
}

function trialCombinedPairMetrics(memberMetrics, targetQty) {
  const rows = Array.isArray(memberMetrics) ? memberMetrics : [];
  const pairedOutput = rows.length
    ? Math.min(...rows.map(row => Number(row.outputTotal || row.netOutput || 0)))
    : 0;
  const pairedRemainingQty = Math.max(0, Number(targetQty || 0) - pairedOutput);
  const pendingSetupMinutes = rows.length && Number(rows[0]?.include_setup || 0) === 1
    ? rows.reduce((max, row) => Math.max(max, Number(row.pendingSetupMinutes || 0)), 0)
    : 0;
  const pairedRemainingMinutes = pendingSetupMinutes + (
    pairedRemainingQty * rows.reduce((sum, row) => sum + Number(row.cycle_minutes_per_qty || 0), 0)
  );
  return { pairedOutput, pairedRemainingQty, pairedRemainingMinutes };
}

function trialBuildMachineDisplayGroup(rawBlocks, summary = null) {
  const blocks = (rawBlocks || [])
    .map(b => trialBlockMemberMetrics(b))
    .sort((a, b) =>
      Number(a.queue_position || 0) - Number(b.queue_position || 0) ||
      Number(a.block_id || 0) - Number(b.block_id || 0)
    );
  const leader = blocks[0] || null;
  if (!leader) return null;

  const groupId = Number(leader.group_id || summary?.group_id || 0);
  const psId = String(
    summary?.ps_id || leader.planner_ps_id || leader.job_no || leader.source_ps_id || '',
  ).trim();
  const operationLabel = String(
    summary?.operation_label || summary?.group_label || leader.group_label ||
    (blocks.length > 1
      ? blocks.map(b => String(b.source_op_no || b.operation_name || '')).filter(Boolean).join(' & ')
      : (leader.source_op_no || leader.operation_name || ''))
  ).trim();
  const targetQty = summary?.target_qty != null
    ? Number(summary.target_qty)
    : blocks.reduce((max, b) => Math.max(max, Number(b.scheduled_qty || 0)), 0);
  const actualGood = blocks.reduce((sum, b) => sum + Number(b.outputTotal || 0), 0);
  const actualReject = blocks.reduce((sum, b) => sum + Number(b.rejectTotal || 0), 0);
  const pairedMetrics = trialCombinedPairMetrics(blocks, targetQty);
  const pairedOutput = Number(summary?.paired_output_qty ?? pairedMetrics.pairedOutput ?? 0);
  const enrichedBlocks = blocks.map(member => ({
    ...member,
    pairedExcessQty: Math.max(0, Number(member.outputTotal || member.netOutput || 0) - pairedOutput),
    pairedShortfallQty: Math.max(0, pairedOutput - Number(member.outputTotal || member.netOutput || 0)),
  }));
  const starts = blocks.map(b => String(b.calculated_start_datetime || '')).filter(Boolean).sort();
  const ends = blocks.map(b => String(b.calculated_end_datetime || '')).filter(Boolean).sort();
  const visualStarts = blocks.map(b => String(b.visual_start_datetime || b.calculated_start_datetime || '')).filter(Boolean).sort();
  const visualEnds = blocks.map(b => String(
    b.visual_end_datetime || b.predicted_end_at || b.calculated_end_datetime || ''
  )).filter(Boolean).sort();
  const actualStarts = blocks.map(b => String(b.actual_start_at || '')).filter(Boolean).sort();
  const actualEnds = blocks.map(b => String(b.actual_end_at || '')).filter(Boolean).sort();
  const allDone = blocks.length > 0 && blocks.every(b => String(b.actual_end_at || '').trim());
  const status = blocks.every(b => b.isDone)
    ? 'DONE'
    : blocks.some(b => b.isInProgress || Number(b.outputTotal || 0) > 0 || Number(b.rejectTotal || 0) > 0)
      ? 'IN_PROGRESS'
      : 'NOT_STARTED';
  const planningStatus = blocks.some(b => String(b.planning_status || '').toUpperCase() === 'PARTIALLY_PLANNED')
    ? 'PARTIALLY_PLANNED'
    : blocks.every(b => String(b.planning_status || '').toUpperCase() === 'PLANNED')
      ? 'PLANNED'
      : blocks[0]?.planning_status || 'UNPLANNED';

  return {
    group_id: groupId,
    group_label: operationLabel,
    ps_id: psId,
    operation_label: operationLabel,
    leader,
    blocks: enrichedBlocks,
    member_metrics: enrichedBlocks,
    title: psId,
    subtitle: operationLabel,
    summary_line: typeof fmt === 'function' ? `Qty ${fmt(targetQty, 0)}` : `Qty ${targetQty}`,
    target_qty: targetQty,
    setup_minutes: summary?.setup_minutes != null
      ? Number(summary.setup_minutes)
      : blocks.reduce((max, b) => Math.max(max, Number(b.setup_minutes || 0)), 0),
    cycle_minutes_per_qty: summary?.cycle_minutes_per_qty != null
      ? Number(summary.cycle_minutes_per_qty)
      : blocks.reduce((sum, b) => sum + Number(b.cycle_minutes_per_qty || 0), 0),
    output_qty: actualGood,
    reject_qty: actualReject,
    paired_output_qty: pairedOutput,
    paired_remaining_qty: Number(summary?.paired_remaining_qty ?? pairedMetrics.pairedRemainingQty ?? 0),
    paired_remaining_minutes: Number(summary?.paired_remaining_minutes ?? pairedMetrics.pairedRemainingMinutes ?? 0),
    remaining_qty: pairedMetrics.pairedRemainingQty,
    remaining_minutes: pairedMetrics.pairedRemainingMinutes,
    status,
    planning_status: planningStatus,
    group_type: (() => {
      const fromLeader = String(leader.group_type || summary?.group_type || '').toUpperCase();
      if (fromLeader === 'MPP_CYCLE') return 'MPP_CYCLE';
      if (/^MPP cycle\b/i.test(String(summary?.group_label || leader.group_label || '').trim())) {
        return 'MPP_CYCLE';
      }
      return blocks.length > 1 ? 'COMBINED' : (leader.group_type || summary?.group_type || '');
    })(),
    group_start: summary?.group_start || starts[0] || leader.calculated_start_datetime || '',
    group_end: summary?.group_end || ends[ends.length - 1] || leader.calculated_end_datetime || '',
    visual_start_datetime: visualStarts[0] || leader.visual_start_datetime || leader.calculated_start_datetime || leader.anchor_datetime || '',
    visual_end_datetime: visualEnds[visualEnds.length - 1] || leader.visual_end_datetime || leader.calculated_end_datetime || '',
    actual_start_at: actualStarts[0] || leader.actual_start_at || '',
    actual_end_at: (allDone && actualEnds.length ? actualEnds[actualEnds.length - 1] : '') || leader.actual_end_at || '',
    material_status: summary?.material_status || leader.material_status || {},
  };
}

function trialGroupCompletedForQueue(group) {
  const blockCompletedByCatalog = (block) => {
    const sourcePs = String(block?.source_ps_id || block?.job_no || '').trim();
    if (!sourcePs) return false;
    const sourceBase = trialSplitPsId(sourcePs).base;
    const sourcePartial = String(trialSplitPsId(sourcePs).partial || '').trim();
    const pools = [
      ...(Array.isArray(trialState.catalog) ? trialState.catalog : []),
      ...(Array.isArray(trialState.planned) ? trialState.planned : []),
    ];
    for (const ps of pools) {
      const psId = String(ps?.ps_id || '').trim();
      if (!psId) continue;
      const psParts = trialSplitPsId(psId);
      const psBase = String(psParts.base || '').trim();
      const psPartial = String(psParts.partial || ps?.pp_partial_no || '').trim();
      if (!psBase || psBase !== sourceBase) continue;
      if (sourcePartial && psPartial && sourcePartial !== psPartial) continue;
      const cards = Array.isArray(ps?.op_cards) ? ps.op_cards : [];
      const hit = cards.find(card => trialCatalogOpMatchesBlock(
        card?.source_op_no,
        card?.source_op_seq_id,
        card?.operation_label,
        block,
      ));
      if (!hit) continue;
      return !trialCatalogOpIsOpen(hit, ps);
    }
    return false;
  };

  const rows = Array.isArray(group?.member_metrics) && group.member_metrics.length
    ? group.member_metrics
    : (Array.isArray(group?.blocks) ? group.blocks : []);
  if (!rows.length) return false;
  const tol = 0.0001;
  const pairRemaining = Number(group?.paired_remaining_qty ?? group?.remaining_qty ?? 0);
  if (pairRemaining > tol) return false;
  return rows.every(row => {
    const status = String(row?.execution_status || row?.status || '').toUpperCase();
    const doneByStatus = status === 'DONE' || status === 'COMPLETED' || status === 'C';
    if (doneByStatus) return true;
    const remaining = Number(row?.remainingQty ?? row?.remaining_qty ?? 0);
    if (remaining > tol) return false;
    // ERP/catalog reconciliation can drive remaining to 0 while the WO is still open.
    // Only drop from machine lanes when the catalog agrees the op is finished.
    return blockCompletedByCatalog(row);
  });
}

// Always build lane cards from live trialState.blocks. Stale block_groups snapshots used to
// hide newly scheduled ops (sidebar consumed them via allocation keys, lanes stayed empty).
function trialBlocksGroupedForMachine(machineId) {
  const machineBlocks = trialBlocksForMachine(machineId);
  if (!machineBlocks.length) return [];

  const isMppLane = typeof trialIsMppPlannerMachine === 'function' && trialIsMppPlannerMachine(machineId);
  const summaryByGroupId = new Map(
    (trialState.block_groups || [])
      .filter(g => String(g.machine_id || 0) === String(machineId) && Number(g.group_id || 0) > 0)
      .filter(g => isMppLane || String(g.group_type || '').toUpperCase() !== 'MPP_CYCLE')
      .filter(g => isMppLane || !/^MPP cycle\b/i.test(String(g.group_label || '').trim()))
      .map(g => [String(g.group_id), g])
  );

  const byKey = new Map();
  machineBlocks.forEach(block => {
    const groupId = Number(block.group_id || 0);
    const key = groupId > 0 ? `g:${groupId}` : `s:${block.block_id}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(block);
  });

  return Array.from(byKey.values())
    .map(rawBlocks => {
      const groupId = Number(rawBlocks[0]?.group_id || 0);
      const summary = groupId > 0 ? summaryByGroupId.get(String(groupId)) : null;
      return trialBuildMachineDisplayGroup(rawBlocks, summary);
    })
    .filter(Boolean)
    .sort(trialCompareMachineGroups);
}

/** Stable identity for an MPP cycle member (PS + partial + op + qty). */
function trialMppBlockIdentityKey(block) {
  if (!block) return '';
  let base = '';
  let partial = '1';
  if (typeof trialCatalogSourceBase === 'function') {
    base = String(trialCatalogSourceBase({
      planner_ps_id: block.planner_ps_id,
      source_ps_id: block.source_ps_id,
      job_no: block.job_no,
      ps_id: block.ps_id,
    }) || '').trim();
  }
  if (!base) {
    const raw = String(block.planner_ps_id || block.source_ps_id || block.job_no || '').trim();
    const parts = typeof trialSplitPsId === 'function' ? trialSplitPsId(raw) : { base: raw, partial: '' };
    base = String(parts.base || raw).trim();
    if (parts.partial) partial = String(parts.partial);
  }
  if (typeof trialCatalogPartialIndex === 'function') {
    const n = Number(trialCatalogPartialIndex({
      planner_ps_id: block.planner_ps_id,
      pp_partial_no: block.pp_partial_no,
      source_ps_id: block.source_ps_id,
      job_no: block.job_no,
    }) || 0);
    if (n > 0) partial = String(n);
  } else if (block.pp_partial_no != null && Number(block.pp_partial_no) > 0) {
    partial = String(Number(block.pp_partial_no));
  }
  const op = String(block.source_op_no || block.operation_name || block.source_op_seq_id || '').trim();
  const qty = Math.max(0, Number(block.scheduled_qty || 0));
  return `${base}::p${partial}::${op}:q${qty}`;
}

/** Fingerprint so consecutive identical MPP cycles can collapse into one stack. */
function trialMppCycleFingerprint(group) {
  const blocks = Array.isArray(group?.blocks) ? group.blocks : [];
  if (!blocks.length) {
    return `empty:${Number(group?.group_id || group?.leader?.block_id || 0)}`;
  }
  return blocks.map(trialMppBlockIdentityKey).filter(Boolean).sort().join('|')
    || `g:${Number(group?.group_id || 0)}`;
}

/**
 * Collapse consecutive identical MPP cycles (same PS/op mix + qty) into runs.
 * Non-MPP lanes should pass groups through unchanged via trialGroupMppLaneRuns.
 */
function trialGroupIdenticalMppCycleRuns(groups) {
  const runs = [];
  (groups || []).forEach((group, index) => {
    const fingerprint = trialMppCycleFingerprint(group);
    const tail = runs[runs.length - 1];
    if (tail && tail.fingerprint === fingerprint) {
      tail.groups.push(group);
      tail.endIndex = index;
    } else {
      runs.push({
        fingerprint,
        groups: [group],
        startIndex: index,
        endIndex: index,
      });
    }
  });
  return runs;
}

function trialGroupMppLaneRuns(groups) {
  return trialGroupIdenticalMppCycleRuns(groups);
}

/** Distinct PS/op lines inside one MPP cycle (supports multi-PS cycles). */
function trialMppCycleMemberSummaries(group) {
  const seen = new Set();
  const rows = [];
  (group?.blocks || []).forEach(block => {
    let base = '';
    let partial = '';
    if (typeof trialCatalogSourceBase === 'function') {
      base = String(trialCatalogSourceBase({
        planner_ps_id: block.planner_ps_id,
        source_ps_id: block.source_ps_id,
        job_no: block.job_no,
      }) || '').trim();
    }
    if (!base) {
      const raw = String(block.planner_ps_id || block.source_ps_id || block.job_no || '').trim();
      const parts = typeof trialSplitPsId === 'function' ? trialSplitPsId(raw) : { base: raw, partial: '' };
      base = String(parts.base || raw).trim();
      partial = String(parts.partial || '').trim();
    }
    if (typeof trialCatalogPartialIndex === 'function') {
      const n = Number(trialCatalogPartialIndex({
        planner_ps_id: block.planner_ps_id,
        pp_partial_no: block.pp_partial_no,
        source_ps_id: block.source_ps_id,
        job_no: block.job_no,
      }) || 0);
      if (n > 1) partial = String(n);
    }
    const opNo = String(block.source_op_no || '').trim();
    const opName = String(block.operation_name || '').trim();
    const op = [opNo, opName].filter(Boolean).join(' ') || opNo || opName;
    const key = `${base}::${partial}::${opNo || opName}`;
    if (!base || seen.has(key)) return;
    seen.add(key);
    rows.push({
      base,
      partial,
      op,
      qty: Math.max(0, Number(block.scheduled_qty || 0)),
    });
  });
  return rows;
}
