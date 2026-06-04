// Export the current machine lane board to a styled Excel workbook.

function trialExportMachineColumns() {
  const cols = [];
  const groups = trialVisibleMachinesGrouped();
  const useGrouped = trialShouldGroupMachineLanes()
    && groups.some(group => group.grouped && group.label);
  if (!useGrouped) {
    const flat = groups[0]?.machines || trialVisibleMachines();
    flat.forEach(machine => cols.push({ machine, groupLabel: '' }));
    return cols;
  }
  groups.forEach(group => {
    if (!group.grouped || !group.label) {
      (group.machines || []).forEach(machine => cols.push({ machine, groupLabel: '' }));
      return;
    }
    const subgroups = Array.isArray(group.subgroups) ? group.subgroups : [];
    if (subgroups.length) {
      subgroups.forEach(sub => {
        (sub.machines || []).forEach(machine => {
          cols.push({ machine, groupLabel: group.label, subgroupLabel: sub.title || '' });
        });
      });
    } else {
      (group.machines || []).forEach(machine => {
        cols.push({ machine, groupLabel: group.label });
      });
    }
  });
  return cols;
}

function trialFormatDueForExport(dateText) {
  const raw = String(dateText || '').trim().slice(0, 10);
  if (!raw) return '';
  const d = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(d.getTime())) return raw;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const yy = String(d.getFullYear()).slice(-2);
  return `${d.getDate()} ${months[d.getMonth()]} ${yy}`;
}

function trialFormatScheduleForExport(dateTimeText) {
  const raw = String(dateTimeText || '').trim();
  if (!raw) return '';
  const datePart = raw.slice(0, 10);
  const dateFmt = trialFormatDueForExport(datePart);
  if (!dateFmt) return typeof trialFormatDt === 'function' ? trialFormatDt(raw) : raw;
  const timeMatch = raw.match(/(?:T|\s)(\d{2}:\d{2})/);
  return timeMatch ? `${dateFmt} ${timeMatch[1]}` : dateFmt;
}

function trialExportJobGroupsForMachine(machineId) {
  return trialBlocksGroupedForMachine(machineId)
    .filter(group => !trialGroupCompletedForQueue(group))
    .filter(trialGroupRunsInsideDateFilter);
}

function trialExportJobCellLines(group, displaySequenceNo) {
  const vm = trialBlockGroupViewModel(group, { displaySequenceNo });
  const leader = vm.leader || {};
  const partName = String(leader.part_name || leader.part_no || '').trim();
  const opLine = String(vm.operationLine || '').trim();
  const detailParts = [];
  if (partName) detailParts.push(partName);
  else if (opLine) detailParts.push(opLine);
  if (vm.targetQty) detailParts.push(`${vm.targetQty}ea`);
  const dueRaw = String(trialDueDateForPs(vm.psDueKey) || '').trim();
  const dueFmt = dueRaw ? trialFormatDueForExport(dueRaw) : '';
  const startFmt = trialFormatScheduleForExport(
    trialBlockQueuedAt(vm.leader || vm.group)
  );
  const endFmt = trialFormatScheduleForExport(
    trialBlockOutputAt(vm.leader || vm.group)
  );
  const lines = [
    vm.psDisplay.base || vm.group.title || '',
    detailParts.join(', '),
    startFmt ? `Start ${startFmt}` : '',
    endFmt ? `End ${endFmt}` : '',
    dueFmt ? `Due Date ${dueFmt}` : '',
  ].filter(line => String(line || '').trim());
  const queuedMachines = vm.queuedMachines || [];
  if (vm.splitAllocationHtml && queuedMachines.length > 1) {
    lines.push(`Next Process ${queuedMachines.join(' @ ')}`);
  }
  const matLabel = String(vm.materialStatus?.label || '').trim();
  if (matLabel) lines.push(matLabel);
  return lines;
}

function trialExportBoardFilename() {
  const stamp = typeof trialTodayLocal === 'function'
    ? trialTodayLocal()
    : new Date().toISOString().slice(0, 10);
  return `machine-production-board-${stamp}.xlsx`;
}

async function trialEnsureExcelJs() {
  if (window.ExcelJS) return window.ExcelJS;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load Excel export library'));
    document.head.appendChild(script);
  });
  return window.ExcelJS;
}

async function trialExportBoardToExcel() {
  const columns = trialExportMachineColumns();
  if (!columns.length) {
    toast('No machines to export', 'info');
    return;
  }
  const queues = columns.map(col => ({
    machine: col.machine,
    groups: trialExportJobGroupsForMachine(col.machine.machine_id),
  }));
  const maxDepth = Math.max(1, ...queues.map(q => q.groups.length));
  try {
    if (typeof trialRunWithPlannerBusy === 'function') {
      await trialRunWithPlannerBusy(async () => {
        await trialBuildAndDownloadExcel(columns, queues, maxDepth);
      }, 'Building Excel…', '');
    } else {
      await trialBuildAndDownloadExcel(columns, queues, maxDepth);
    }
    toast('Excel downloaded', 'success');
  } catch (err) {
    console.error('trialExportBoardToExcel failed:', err);
    toast('Export failed: ' + (err?.message || err), 'error');
  }
}

async function trialBuildAndDownloadExcel(columns, queues, maxDepth) {
  const ExcelJS = await trialEnsureExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Production Planner';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Machine Board', {
    views: [{ showGridLines: true }],
  });

  const thinBorder = {
    top: { style: 'thin', color: { argb: 'FFD0D5DD' } },
    left: { style: 'thin', color: { argb: 'FFD0D5DD' } },
    bottom: { style: 'thin', color: { argb: 'FFD0D5DD' } },
    right: { style: 'thin', color: { argb: 'FFD0D5DD' } },
  };

  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
  const groupRow = sheet.getRow(1);
  const machineRow = sheet.getRow(2);
  groupRow.height = 22;
  machineRow.height = 20;

  let colIndex = 1;
  const groupSpans = [];
  columns.forEach((col, idx) => {
    const label = col.groupLabel || '';
    const prev = columns[idx - 1];
    if (!label) {
      groupSpans.push({ start: colIndex, end: colIndex, label: '' });
    } else if (prev && prev.groupLabel === label) {
      groupSpans[groupSpans.length - 1].end = colIndex;
    } else {
      groupSpans.push({ start: colIndex, end: colIndex, label });
    }
    const machineCell = machineRow.getCell(colIndex);
    machineCell.value = col.machine.machine_code || '';
    machineCell.font = { bold: true, size: 11, color: { argb: 'FF1A1C1D' } };
    machineCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    machineCell.fill = headerFill;
    machineCell.border = thinBorder;
    sheet.getColumn(colIndex).width = 22;
    colIndex += 1;
  });

  groupSpans.forEach(span => {
    if (span.end > span.start) {
      sheet.mergeCells(1, span.start, 1, span.end);
    }
    const cell = groupRow.getCell(span.start);
    cell.value = span.label || '';
    cell.font = { bold: true, size: 11, color: { argb: 'FF4B5563' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.fill = headerFill;
    cell.border = thinBorder;
  });

  const availabilityRow = sheet.getRow(3);
  availabilityRow.height = 18;
  columns.forEach((col, colIdx) => {
    const queue = queues[colIdx];
    const availabilityEnd = typeof trialMachineAvailabilityEnd === 'function'
      ? trialMachineAvailabilityEnd(queue.groups)
      : '';
    const cell = availabilityRow.getCell(colIdx + 1);
    cell.border = thinBorder;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.font = { size: 9, color: { argb: 'FF6B7280' } };
    cell.fill = headerFill;
    if (availabilityEnd) {
      cell.value = `Queue ends ${trialFormatScheduleForExport(availabilityEnd)}`;
    }
  });

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const row = sheet.getRow(4 + depth);
    row.height = 84;
    columns.forEach((col, colIdx) => {
      const queue = queues[colIdx];
      const group = queue.groups[depth];
      const cell = row.getCell(colIdx + 1);
      cell.border = thinBorder;
      cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
      cell.font = { size: 10, color: { argb: 'FF1A1C1D' } };
      if (!group) {
        cell.value = '';
        return;
      }
      const lines = trialExportJobCellLines(group, depth + 1);
      cell.value = lines.join('\n');
    });
  }

  sheet.views = [{ state: 'frozen', ySplit: 3, xSplit: 0, activeCell: 'A4' }];

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = trialExportBoardFilename();
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

window.trialExportBoardToExcel = trialExportBoardToExcel;
