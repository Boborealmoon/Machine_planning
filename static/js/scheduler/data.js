// State queries, filter helpers, metrics derivation — reads trialState, no DOM writes.

function trialSyncScheduleUrl() {
  const params = new URLSearchParams(window.location.search);
  const resolvedStart = String(trialScheduleDateFilter.start || '').trim();
  const resolvedEnd = String(trialScheduleDateFilter.end || '').trim();
  if (resolvedStart) params.set('start', resolvedStart); else params.delete('start');
  if (resolvedEnd) params.set('end', resolvedEnd); else params.delete('end');
  window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
}

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
  const actualTotalsByBlock = new Map();

  (trialState.blocks || []).forEach(block => {
    const machineKey = String(block.machine_id || '');
    if (!blocksByMachine.has(machineKey)) blocksByMachine.set(machineKey, []);
    blocksByMachine.get(machineKey).push(block);

    const sourceBase = trialSplitPsId(block.source_ps_id || block.job_no).base;
    if (sourceBase) {
      if (!blocksBySourceBase.has(sourceBase)) blocksBySourceBase.set(sourceBase, []);
      blocksBySourceBase.get(sourceBase).push(block);
    }
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
    actualTotalsByBlock,
  };
  if (typeof trialPerfEnd === 'function') {
    trialPerfEnd(perf, {
      index_machines: blocksByMachine.size,
      index_ps_bases: blocksBySourceBase.size,
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
  if (trialMachineHiddenSet.size > 0) {
    machines = machines.filter(m => !trialMachineHiddenSet.has(m.machine_code));
  }
  return machines;
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
        machine_codes: ['CNC 35', 'CNC 36'],
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

function trialCatalogOpPendingKey(cardOrPayload) {
  const raw = cardOrPayload || {};
  if (String(raw.card_kind || '') === 'group' && Number(raw.card_id || 0) > 0) {
    return `group:${Number(raw.card_id)}`;
  }
  const card = (typeof trialCatalogCardFromPayload === 'function')
    ? (trialCatalogCardFromPayload(cardOrPayload) || cardOrPayload)
    : (cardOrPayload || {});
  const ps = String(card?.source_ps_id || card?.ps_id || '').trim();
  const base = trialSplitPsId(ps).base || ps;
  const op = String(card?.source_op_no || card?.operation_label || '').trim();
  const seq = Number(card?.source_op_seq_id || 0);
  return `${base}|${op}|${seq}`;
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

function trialCatalogPartialIndex(psId) {
  const partialText = trialSplitPsId(psId).partial;
  const parsed = Number(partialText);
  return partialText && Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
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

/** Queue blocks on the same WO + operation (any partial suffix). */
function trialBlocksForCatalogOp(card) {
  const psId = String(card?.source_ps_id || card?.ps_id || '').trim();
  const base = trialSplitPsId(psId).base;
  if (!base) return [];
  const { blocksBySourceBase } = trialEnsureDataIndexes();
  const candidates = blocksBySourceBase.get(base) || [];
  return candidates
    .filter(block => {
      return trialCatalogOpMatchesBlock(
        card?.source_op_no,
        card?.source_op_seq_id,
        card?.operation_label,
        block,
      );
    })
    .sort((a, b) => Number(a.block_id) - Number(b.block_id));
}

function trialLegacyBlocksForCatalogOp(card) {
  return trialBlocksForCatalogOp(card).filter(block => {
    const raw = String(block.source_ps_id || block.job_no || '');
    return trialCatalogPartialIndex(raw) === 1 && !raw.includes('::');
  });
}

function trialCatalogQueuedQty(cardOrPayload) {
  const card = (typeof trialCatalogCardFromPayload === 'function')
    ? (trialCatalogCardFromPayload(cardOrPayload) || cardOrPayload)
    : cardOrPayload;
  return trialBlocksForCatalogOp(card).reduce(
    (sum, block) => sum + Math.max(0, Number(block.scheduled_qty || 0)),
    0,
  );
}

function trialCatalogSchedulableRemaining(cardOrPayload) {
  const op = cardOrPayload?.op || {};
  const serverRemaining = Math.max(0, Number(
    cardOrPayload?.remaining_qty ?? op?.remaining_qty ?? 0,
  ));
  const required = Math.max(0, Number(
    op?.required_qty ?? cardOrPayload?.required_qty ?? 0,
  ));
  const erpFinished = Math.max(0, Number(
    op?.erp_finished_qty ?? cardOrPayload?.erp_finished_qty ?? 0,
  ));
  const queued = trialCatalogQueuedQty(cardOrPayload);
  if (required > 0.0001) {
    return Math.max(0, required - queued - erpFinished);
  }
  if (queued > 0.0001 && serverRemaining > queued + 0.0001) {
    return Math.max(0, serverRemaining - queued);
  }
  return serverRemaining;
}

function trialCatalogOpHasQueuedBlocks(card) {
  return trialBlocksForCatalogOp(card).length > 0;
}

function trialIsCatalogOpFullyQueued(card) {
  return trialCatalogOpHasQueuedBlocks(card) && trialCatalogSchedulableRemaining(card) <= 0.0001;
}

function trialIsCatalogOpAllocated(card) {
  const blocks = trialBlocksForCatalogOp(card);
  if (!blocks.length) return false;
  const wantPartial = trialCatalogPartialIndex(card?.source_ps_id || card?.ps_id);
  const exact = blocks.filter(block => (
    trialCatalogPartialIndex(block.source_ps_id || block.job_no) === wantPartial
  ));
  if (exact.length) return true;
  // Blocks saved before partial suffixes: assign in queue order to Partial 1, 2, …
  return trialLegacyBlocksForCatalogOp(card).length >= wantPartial;
}

function trialQueuedMachineCodesForCatalogOp(card) {
  const fromCard = Array.isArray(card?.queued_machines) ? card.queued_machines : [];
  const fromBlocks = trialBlocksForCatalogOp(card)
    .map(block => String(block.machine_code || '').trim())
    .filter(Boolean);
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
  if (!blocks.length) return null;
  const wantPartial = trialCatalogPartialIndex(card?.source_ps_id || card?.ps_id);
  const exact = blocks.filter(block => (
    trialCatalogPartialIndex(block.source_ps_id || block.job_no) === wantPartial
  ));
  if (exact.length) return exact[0];
  const legacy = trialLegacyBlocksForCatalogOp(card);
  return legacy[wantPartial - 1] || null;
}

function trialCatalogCardFromPayload(payload) {
  if (!payload) return null;
  const op = payload.op || {};
  return {
    ps_id: payload.ps_id || '',
    source_ps_id: payload.source_ps_id || payload.ps_id || op.source_ps_id || '',
    source_op_no: payload.source_op_no || op.source_op_no || payload.operation_label || '',
    source_op_seq_id: Number(payload.source_op_seq_id || op.source_op_seq_id || 0),
    operation_label: payload.operation_label || '',
    remaining_qty: Number(payload.remaining_qty ?? op.remaining_qty ?? 0),
    required_qty: Number(payload.required_qty ?? op.required_qty ?? 0),
    erp_finished_qty: Number(payload.erp_finished_qty ?? op.erp_finished_qty ?? 0),
    planned_qty: Number(payload.planned_qty ?? op.planned_qty ?? 0),
  };
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
  return blocksByMachine.get(String(machineId)) || [];
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

function trialBlockMemberMetrics(block) {
  const catalogFallbackGoodQty = () => {
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
      const produced = Number(hit?.finished_qty ?? hit?.wo_qty_produced ?? 0);
      const required = Number(hit?.wo_qty_required ?? hit?.required_qty ?? block?.scheduled_qty ?? 0);
      const bounded = Math.max(0, Math.min(
        Math.max(0, Number(block?.scheduled_qty || required || 0)),
        Math.max(0, produced),
      ));
      if (bounded > 0) return bounded;
    }
    return 0;
  };

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
  let netOutput = Number(
    effective.effective_good_qty ?? recon.effective_good_qty ?? trialBlockNetOutput(shopOutputTotal, shopRejectTotal)
  );
  if (netOutput <= 0) {
    const fallbackGood = catalogFallbackGoodQty();
    if (fallbackGood > 0) {
      netOutput = fallbackGood;
      outputTotal = Math.max(outputTotal, fallbackGood);
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
  const remainingQty = Math.max(0, scheduledQty - netOutput);
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
    ? Math.min(...rows.map(row => Number(row.netOutput || row.outputTotal || 0)))
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
  const psId = String(summary?.ps_id || leader.job_no || leader.source_ps_id || '').trim();
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
    pairedExcessQty: Math.max(0, Number(member.netOutput || 0) - pairedOutput),
    pairedShortfallQty: Math.max(0, pairedOutput - Number(member.netOutput || 0)),
  }));
  const starts = blocks.map(b => String(b.calculated_start_datetime || '')).filter(Boolean).sort();
  const ends = blocks.map(b => String(b.calculated_end_datetime || '')).filter(Boolean).sort();
  const visualStarts = blocks.map(b => String(b.visual_start_datetime || b.calculated_start_datetime || '')).filter(Boolean).sort();
  const visualEnds = blocks.map(b => String(b.visual_end_datetime || b.calculated_end_datetime || '')).filter(Boolean).sort();
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
    group_type: blocks.length > 1 ? 'COMBINED' : (leader.group_type || summary?.group_type || ''),
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
      return !trialCatalogOpIsOpen(hit);
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

  const summaryByGroupId = new Map(
    (trialState.block_groups || [])
      .filter(g => String(g.machine_id || 0) === String(machineId) && Number(g.group_id || 0) > 0)
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
