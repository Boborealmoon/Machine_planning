// State queries, filter helpers, metrics derivation — reads trialState, no DOM writes.

function trialSyncScheduleUrl() {
  const params = new URLSearchParams(window.location.search);
  const resolvedStart = String(trialScheduleDateFilter.start || '').trim();
  const resolvedEnd = String(trialScheduleDateFilter.end || '').trim();
  if (resolvedStart) params.set('start', resolvedStart); else params.delete('start');
  if (resolvedEnd) params.set('end', resolvedEnd); else params.delete('end');
  window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
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

function trialCatalogAllocationKey(psId, opNo, opSeqId) {
  const ps = String(psId || '').trim();
  if (!ps) return '';
  const no = String(opNo || '').trim();
  if (no) return `${ps}||op:${no}`;
  const seq = Number(opSeqId || 0);
  if (seq > 0) return `${ps}||seq:${seq}`;
  return '';
}

function trialAllocatedOpKeys() {
  const keys = new Set();
  (trialState.blocks || []).forEach(b => {
    const key = trialCatalogAllocationKey(
      b.source_ps_id || b.job_no,
      b.source_op_no,
      b.source_op_seq_id
    );
    if (key) keys.add(key);
  });
  return keys;
}

function trialIsCatalogOpAllocated(card) {
  const psId = String(card?.source_ps_id || card?.ps_id || '').trim();
  const keys = trialAllocatedOpKeys();
  if (!psId || !keys.size) return false;
  const primary = trialCatalogAllocationKey(psId, card?.source_op_no, card?.source_op_seq_id);
  if (primary && keys.has(primary)) return true;
  const labelKey = trialCatalogAllocationKey(psId, card?.operation_label, 0);
  return Boolean(labelKey && keys.has(labelKey));
}

function trialIsOpAllocated(psId, opNo) {
  if (!psId || !opNo) return false;
  return (trialState.blocks || []).some(b => {
    const bPs = String(b.source_ps_id || b.job_no || '').trim();
    const bOp = String(b.source_op_no || '').trim();
    return bPs === String(psId).trim() && bOp === String(opNo).trim();
  });
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
  return true;
}

function trialFindBlockForCatalogOp(card) {
  const psId = String(card?.source_ps_id || card?.ps_id || '').trim();
  if (!psId) return null;
  const targetKey = trialCatalogAllocationKey(psId, card?.source_op_no, card?.source_op_seq_id);
  return (trialState.blocks || []).find(block => (
    trialCatalogAllocationKey(block.source_ps_id || block.job_no, block.source_op_no, block.source_op_seq_id) === targetKey
  )) || null;
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
  return (trialState.blocks || []).filter(b => String(b.machine_id) === String(machineId));
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
  const shopOutputTotal = (trialState.actuals || [])
    .filter(row => String(row.block_id) === String(block.block_id) && row.output_qty != null)
    .reduce((sum, row) => sum + Number(row.output_qty || 0), 0);
  const shopRejectTotal = (trialState.actuals || [])
    .filter(row => String(row.block_id) === String(block.block_id) && row.reject_qty != null)
    .reduce((sum, row) => sum + Number(row.reject_qty || 0), 0);
  const effective = block?.effective_actuals || {};
  const recon = block?.erp_reconciliation || {};
  const outputTotal = Number(
    effective.effective_output_qty ?? recon.effective_output_qty ?? shopOutputTotal
  );
  const rejectTotal = Number(
    effective.effective_reject_qty ?? recon.effective_reject_qty ?? shopRejectTotal
  );
  const scheduledQty = Number(block.scheduled_qty || 0);
  const netOutput = Number(
    effective.effective_good_qty ?? recon.effective_good_qty ?? trialBlockNetOutput(shopOutputTotal, shopRejectTotal)
  );
  const remainingQty = Math.max(0, scheduledQty - netOutput);
  const pendingSetupMinutes = trialBlockPendingSetupMinutes(block, outputTotal, rejectTotal);
  const remainingMinutes = pendingSetupMinutes + (remainingQty * Number(block.cycle_minutes_per_qty || 0));
  const status = String(block.execution_status || block.status || '').toUpperCase();
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
