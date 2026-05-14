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

function trialVisibleMachines() {
  const selected = String(trialMachineCategoryFilter || 'ALL').toUpperCase();
  if (selected === 'ALL') return trialState.machines || [];
  return (trialState.machines || []).filter(m =>
    String(m.machine_category || '').trim().toUpperCase() === selected
  );
}

function trialHasActiveDateFilter() {
  return Boolean(
    String(trialScheduleDateFilter.start || '').trim() ||
    String(trialScheduleDateFilter.end || '').trim()
  );
}

function trialDateStart(dateText) {
  if (!dateText) return null;
  return new Date(`${dateText}T00:00:00`);
}

function trialDateEnd(dateText) {
  if (!dateText) return null;
  return new Date(`${dateText}T23:59:59`);
}

function trialParseDateTime(value) {
  if (!value) return null;
  const text = String(value).replace(' ', 'T');
  const dt = new Date(text);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function trialDateRangesOverlap(itemStart, itemEnd, filterStart, filterEnd) {
  if (!itemStart && !itemEnd) return false;
  const start = itemStart || itemEnd;
  const end = itemEnd || itemStart;
  if (filterStart && end < filterStart) return false;
  if (filterEnd && start > filterEnd) return false;
  return true;
}

function trialGroupRunsInsideDateFilter(group) {
  const filterStart = trialDateStart(trialScheduleDateFilter.start);
  const filterEnd = trialDateEnd(trialScheduleDateFilter.end);
  if (!filterStart && !filterEnd) return true;

  const blockIds = (group.blocks || []).map(b => String(b.block_id || '')).filter(Boolean);
  const groupSegments = (trialState.segments || []).filter(seg =>
    blockIds.includes(String(seg.block_id || ''))
  );

  if (groupSegments.length) {
    const matchedBySegments = groupSegments.some(seg => {
      const segStart = trialParseDateTime(seg.start_datetime);
      const segEnd = trialParseDateTime(seg.end_datetime);
      return trialDateRangesOverlap(segStart, segEnd, filterStart, filterEnd);
    });
    if (matchedBySegments) return true;
  }

  const groupStart = trialParseDateTime(
    group.visual_start_datetime || group.group_start ||
    group.leader?.visual_start_datetime || group.leader?.calculated_start_datetime
  );
  const groupEnd = trialParseDateTime(
    group.visual_end_datetime || group.group_end ||
    group.leader?.visual_end_datetime || group.leader?.calculated_end_datetime
  );
  return trialDateRangesOverlap(groupStart, groupEnd, filterStart, filterEnd);
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

function trialBlockMemberMetrics(block) {
  const outputTotal = (trialState.actuals || [])
    .filter(row => String(row.block_id) === String(block.block_id) && row.output_qty != null)
    .reduce((sum, row) => sum + Number(row.output_qty || 0), 0);
  const rejectTotal = (trialState.actuals || [])
    .filter(row => String(row.block_id) === String(block.block_id) && row.reject_qty != null)
    .reduce((sum, row) => sum + Number(row.reject_qty || 0), 0);
  const scheduledQty = Number(block.scheduled_qty || 0);
  const netOutput = trialBlockNetOutput(outputTotal, rejectTotal);
  const remainingQty = Math.max(0, scheduledQty - netOutput);
  const remainingMinutes = remainingQty * Number(block.cycle_minutes_per_qty || 0);
  const status = String(block.execution_status || block.status || '').toUpperCase();
  return {
    ...block,
    outputTotal,
    rejectTotal,
    netOutput,
    remainingQty,
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
  const pairedRemainingMinutes = pairedRemainingQty *
    rows.reduce((sum, row) => sum + Number(row.cycle_minutes_per_qty || 0), 0);
  return { pairedOutput, pairedRemainingQty, pairedRemainingMinutes };
}

function trialBlocksGroupedForMachine(machineId) {
  const summaryGroups = trialGroupSummaryBlocksForMachine(machineId);

  const trialGroupVisualWindow = group => {
    const blocks = Array.isArray(group?.blocks) ? group.blocks : [];
    const starts = blocks.map(b => String(b.visual_start_datetime || b.calculated_start_datetime || '')).filter(Boolean).sort();
    const ends = blocks.map(b => String(b.visual_end_datetime || b.calculated_end_datetime || '')).filter(Boolean).sort();
    const leader = group?.leader || blocks[0] || null;
    const fallbackStart = String(group?.group_start || leader?.visual_start_datetime || leader?.calculated_start_datetime || leader?.anchor_datetime || '');
    const fallbackEnd = String(group?.group_end || leader?.visual_end_datetime || leader?.calculated_end_datetime || leader?.anchor_datetime || '');
    return {
      visual_start_datetime: starts[0] || fallbackStart,
      visual_end_datetime: ends[ends.length - 1] || fallbackEnd,
    };
  };

  if (summaryGroups.length) {
    const groupedBlockIds = new Set();
    const combinedGroups = summaryGroups.map(group => {
      const blocks = Array.isArray(group.blocks)
        ? group.blocks.map(b => trialBlockMemberMetrics(b))
        : [];
      blocks.forEach(b => groupedBlockIds.add(String(b.block_id || '')));
      const leader = blocks[0] || null;
      const psId = String(group.ps_id || leader?.job_no || leader?.source_ps_id || '').trim();
      const operationLabel = String(group.operation_label || group.group_label || '').trim();
      const pairedMetrics = trialCombinedPairMetrics(blocks, group.target_qty || 0);
      const pairedOutput = Number(group.paired_output_qty ?? pairedMetrics.pairedOutput ?? 0);
      const pairedRemainingQty = Number(group.paired_remaining_qty ?? pairedMetrics.pairedRemainingQty ?? 0);
      const pairedRemainingMinutes = Number(group.paired_remaining_minutes ?? pairedMetrics.pairedRemainingMinutes ?? 0);
      const enrichedBlocks = blocks.map(member => ({
        ...member,
        pairedExcessQty: Math.max(0, Number(member.netOutput || 0) - pairedOutput),
        pairedShortfallQty: Math.max(0, pairedOutput - Number(member.netOutput || 0)),
      }));
      return {
        ...group,
        leader,
        blocks: enrichedBlocks,
        member_metrics: enrichedBlocks,
        ps_id: psId,
        operation_label: operationLabel,
        group_label: operationLabel,
        title: psId,
        subtitle: operationLabel,
        summary_line: `Qty ${fmt(group.target_qty || 0, 0)}`,
        paired_output_qty: pairedOutput,
        paired_remaining_qty: pairedRemainingQty,
        paired_remaining_minutes: pairedRemainingMinutes,
        ...trialGroupVisualWindow({ ...group, leader, blocks: enrichedBlocks }),
      };
    }).sort(trialCompareMachineGroups);

    const singles = trialBlocksForMachine(machineId)
      .filter(b => !groupedBlockIds.has(String(b.block_id)))
      .map(block => {
        const metrics = trialBlockMemberMetrics(block);
        const psId = String(metrics.job_no || metrics.source_ps_id || '').trim();
        const operationLabel = String(metrics.source_op_no || metrics.operation_name || '').trim();
        return {
          group_id: 0,
          group_label: '',
          ps_id: psId,
          operation_label: operationLabel,
          leader: metrics,
          blocks: [metrics],
          member_metrics: [metrics],
          title: psId,
          subtitle: operationLabel,
          summary_line: `Qty ${fmt(metrics.scheduled_qty || 0, 0)}`,
          target_qty: metrics.scheduled_qty || 0,
          setup_minutes: metrics.setup_minutes || 0,
          cycle_minutes_per_qty: metrics.cycle_minutes_per_qty || 0,
          output_qty: metrics.outputTotal || 0,
          reject_qty: metrics.rejectTotal || 0,
          remaining_qty: metrics.remainingQty || 0,
          remaining_minutes: metrics.remainingMinutes || 0,
          status: metrics.isDone ? 'DONE' : (metrics.isInProgress || metrics.outputTotal > 0 || metrics.rejectTotal > 0 ? 'IN_PROGRESS' : 'NOT_STARTED'),
          planning_status: metrics.planning_status || 'UNPLANNED',
          group_type: metrics.group_type || '',
          group_start: metrics.calculated_start_datetime || '',
          group_end: metrics.calculated_end_datetime || '',
          visual_start_datetime: metrics.visual_start_datetime || metrics.calculated_start_datetime || '',
          visual_end_datetime: metrics.visual_end_datetime || metrics.calculated_end_datetime || '',
        };
      }).sort(trialCompareMachineGroups);

    return [...combinedGroups, ...singles].sort(trialCompareMachineGroups);
  }

  const groups = new Map();
  trialBlocksForMachine(machineId).forEach(block => {
    const key = trialBlockGroupKey(block);
    if (!groups.has(key)) {
      groups.set(key, { group_id: Number(block.group_id || 0), group_label: block.group_label || '', blocks: [] });
    }
    groups.get(key).blocks.push(block);
  });

  return Array.from(groups.values()).map(group => {
    group.blocks.sort((a, b) =>
      Number(a.queue_position || 0) - Number(b.queue_position || 0) ||
      Number(a.block_id || 0) - Number(b.block_id || 0)
    );
    const leader = group.blocks[0] || null;
    const memberMetrics = group.blocks.map(trialBlockMemberMetrics);
    const psId = String(group.ps_id || leader?.job_no || leader?.source_ps_id || '').trim();
    const operationLabel = String(
      group.operation_label || group.group_label ||
      group.blocks.map(b => String(b.operation_name || b.job_no || 'Block')).filter(Boolean).join(' & ')
    ).trim();
    const totalSetup = memberMetrics.reduce((sum, b) => Math.max(sum, Number(b.setup_minutes || 0)), 0);
    const totalCycle = memberMetrics.reduce((sum, b) => sum + Number(b.cycle_minutes_per_qty || 0), 0);
    const targetQty = memberMetrics.reduce((sum, b) => Math.max(sum, Number(b.scheduled_qty || 0)), 0);
    const actualGood = memberMetrics.reduce((sum, b) => sum + Number(b.outputTotal || 0), 0);
    const actualReject = memberMetrics.reduce((sum, b) => sum + Number(b.rejectTotal || 0), 0);
    const pairedMetrics = trialCombinedPairMetrics(memberMetrics, targetQty);
    const pairedOutput = Number(group.paired_output_qty ?? pairedMetrics.pairedOutput ?? 0);
    const enrichedMemberMetrics = memberMetrics.map(member => ({
      ...member,
      pairedExcessQty: Math.max(0, Number(member.netOutput || 0) - pairedOutput),
      pairedShortfallQty: Math.max(0, pairedOutput - Number(member.netOutput || 0)),
    }));
    const starts = group.blocks.map(b => String(b.calculated_start_datetime || '')).filter(Boolean).sort();
    const ends = group.blocks.map(b => String(b.calculated_end_datetime || '')).filter(Boolean).sort();
    const visualStarts = group.blocks.map(b => String(b.visual_start_datetime || b.calculated_start_datetime || '')).filter(Boolean).sort();
    const visualEnds = group.blocks.map(b => String(b.visual_end_datetime || b.calculated_end_datetime || '')).filter(Boolean).sort();
    const status = memberMetrics.every(b => b.isDone)
      ? 'DONE'
      : memberMetrics.some(b => b.isInProgress || Number(b.outputTotal || 0) > 0 || Number(b.rejectTotal || 0) > 0)
        ? 'IN_PROGRESS'
        : 'NOT_STARTED';
    const planningStatus = group.blocks.some(b => String(b.planning_status || '').toUpperCase() === 'PARTIALLY_PLANNED')
      ? 'PARTIALLY_PLANNED'
      : group.blocks.every(b => String(b.planning_status || '').toUpperCase() === 'PLANNED')
        ? 'PLANNED'
        : group.blocks[0]?.planning_status || 'UNPLANNED';
    return {
      ...group,
      leader,
      group_label: operationLabel,
      ps_id: psId,
      operation_label: operationLabel,
      title: psId,
      subtitle: operationLabel,
      summary_line: `Qty ${fmt(targetQty, 0)}`,
      target_qty: targetQty,
      setup_minutes: totalSetup,
      cycle_minutes_per_qty: totalCycle,
      output_qty: actualGood,
      reject_qty: actualReject,
      paired_output_qty: pairedOutput,
      remaining_qty: pairedMetrics.pairedRemainingQty,
      remaining_minutes: pairedMetrics.pairedRemainingMinutes,
      member_metrics: enrichedMemberMetrics,
      status,
      planning_status: planningStatus,
      group_type: group.blocks.length > 1 ? 'COMBINED' : (leader?.group_type || ''),
      group_start: starts[0] || leader?.calculated_start_datetime || '',
      group_end: ends[ends.length - 1] || leader?.calculated_end_datetime || '',
      visual_start_datetime: visualStarts[0] || leader?.visual_start_datetime || leader?.calculated_start_datetime || '',
      visual_end_datetime: visualEnds[visualEnds.length - 1] || leader?.visual_end_datetime || leader?.calculated_end_datetime || '',
    };
  }).sort(trialCompareMachineGroups);
}
