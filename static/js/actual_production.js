// Actual Production — list view for queue jobs with inline daily actual entry.

window.ACTUAL_PRODUCTION_PAGE = true;

const actualProductionFilter = {
  category: 'ALL',
  machineId: '',
  search: '',
};

function actualProductionMachinesForFilter() {
  const selected = String(actualProductionFilter.category || 'ALL').toUpperCase();
  let machines = trialState.machines || [];
  if (selected !== 'ALL') {
    machines = machines.filter(m => String(m.machine_category || '').trim().toUpperCase() === selected);
  }
  return machines;
}

function actualProductionQueuedJobs() {
  const jobs = [];
  const machines = actualProductionMachinesForFilter();
  machines.forEach(machine => {
    const groups = trialBlocksGroupedForMachine(machine.machine_id)
      .filter(group => String(group.status || '').toUpperCase() !== 'DONE');
    groups.forEach(group => {
      jobs.push({
        machine,
        group,
        queue: Number(group.leader?.queue_position || group.queue_position || 0),
      });
    });
  });
  return jobs.sort((a, b) => {
    const machineCmp = String(a.machine.machine_code || '').localeCompare(String(b.machine.machine_code || ''));
    if (machineCmp !== 0) return machineCmp;
    if (a.queue !== b.queue) return a.queue - b.queue;
    return Number(a.group.leader?.block_id || 0) - Number(b.group.leader?.block_id || 0);
  });
}

function actualProductionJobMatchesSearch(job, needle) {
  if (!needle) return true;
  const group = job.group || {};
  const leader = group.leader || {};
  const haystack = [
    group.ps_id,
    group.operation_label,
    group.group_label,
    leader.job_no,
    leader.source_ps_id,
    leader.operation_name,
    leader.source_op_no,
    job.machine?.machine_code,
    job.machine?.machine_category,
    ...(group.blocks || []).map(block => block.source_op_no || block.operation_name),
  ].join(' ').toLowerCase();
  return haystack.includes(needle);
}

function actualProductionFilteredJobs() {
  const category = String(actualProductionFilter.category || 'ALL').toUpperCase();
  const machineId = String(actualProductionFilter.machineId || '').trim();
  const needle = String(actualProductionFilter.search || '').trim().toLowerCase();
  return actualProductionQueuedJobs().filter(job => {
    if (category !== 'ALL' && String(job.machine.machine_category || '').toUpperCase() !== category) {
      return false;
    }
    if (machineId && String(job.machine.machine_id) !== machineId) return false;
    return actualProductionJobMatchesSearch(job, needle);
  });
}

function actualProductionJobKey(group) {
  const groupId = Number(group?.group_id || 0);
  if (groupId > 0) return `g:${groupId}`;
  const leaderId = Number(group?.leader?.block_id || group?.blocks?.[0]?.block_id || 0);
  return `s:${leaderId}`;
}

function actualProductionFindJobForBlock(blockId) {
  const block = (trialState.blocks || []).find(item => String(item.block_id) === String(blockId));
  if (!block) return null;
  const machine = (trialState.machines || []).find(item => String(item.machine_id) === String(block.machine_id));
  if (!machine) return null;
  const group = trialBlocksGroupedForMachine(machine.machine_id).find(item => (
    (item.blocks || []).some(member => String(member.block_id || member.leader?.block_id) === String(blockId))
  ));
  if (!group) return null;
  return {
    machine,
    group,
    queue: Number(group.leader?.queue_position || 0),
  };
}

function actualProductionRefreshBlock(blockId) {
  const job = actualProductionFindJobForBlock(blockId);
  const jobKey = job ? actualProductionJobKey(job.group) : '';
  const card = jobKey ? document.querySelector(`.actual-production-job[data-job-key="${jobKey}"]`) : null;
  if (!job || !card) {
    renderActualProduction();
    return;
  }
  card.outerHTML = actualProductionRenderJobCard(job);
  actualProductionBindAddDateButtons();
}

function actualProductionErpSummaryHtml(recon) {
  if (!recon || !recon.linked) {
    return `<div class="actual-production-erp-note is-muted">ERP stage not linked for this operation.</div>`;
  }
  const unallocated = Number(recon.unallocated_erp_qty || 0);
  const syncLabel = recon.erp_last_sync_at ? trialFormatDt(recon.erp_last_sync_at) : '—';
  const erpSource = String(recon.erp_data_source || 'mfg_wo_status').replace(/_/g, ' ');
  const rejectSource = String(recon.reject_source || 'erp');
  const outputSource = String(recon.output_source || 'erp');
  return `
    <div class="actual-production-erp-note">
      <span>ERP output <strong>${fmt(recon.erp_acc_qty || 0, 0)}</strong></span>
      <span>ERP reject <strong>${fmt(recon.erp_acc_reject || 0, 0)}</strong></span>
      <span>Shop reject <strong>${fmt(recon.shop_acc_reject_qty || 0, 0)}</strong></span>
      <span>Using reject <strong>${escapeHtml(rejectSource)}</strong> · output <strong>${escapeHtml(outputSource)}</strong></span>
      ${unallocated > 0 ? `<span class="actual-production-erp-unallocated">Unallocated ERP <strong>${fmt(unallocated, 0)}</strong></span>` : ''}
      <span class="actual-production-erp-sync">Last ERP sync ${escapeHtml(syncLabel)} · ${escapeHtml(erpSource)}</span>
    </div>
  `;
}

function actualProductionDailyRowHtml(blockId, row) {
  return trialRenderActualDailyRow(blockId, row);
}

function actualProductionRenderBlockEntry(block) {
  const blockId = Number(block.block_id || 0);
  if (!blockId) return '';
  trialResetActualDraft(blockId, block);
  const dailyRows = trialActualDailyRowsForBlock(block);
  const recon = block.erp_reconciliation || null;
  const rowsHtml = dailyRows.length
    ? dailyRows.map(row => actualProductionDailyRowHtml(blockId, row)).join('')
    : '<tr><td colspan="8" class="trial-catalog-empty">No scheduled target rows yet. Add a date or recalculate the schedule in the planner.</td></tr>';
  const opLabel = [block.source_op_no, block.operation_name].filter(Boolean).join(' — ');
  const outputTotal = Number(block.outputTotal || 0);
  const rejectTotal = Number(block.rejectTotal || 0);
  const remainingQty = Number(block.remainingQty || 0);

  return `
    <section class="actual-production-op" data-actual-entry-host="${blockId}">
      <div class="actual-production-op-head">
        <div class="actual-production-op-title">${escapeHtml(opLabel || 'Operation')}</div>
        <div class="actual-production-op-meta">
          <span>Output ${fmt(outputTotal, 0)}</span>
          <span>Reject ${fmt(rejectTotal, 0)}</span>
          <span>Remaining ${fmt(remainingQty, 0)}</span>
        </div>
      </div>
      ${actualProductionErpSummaryHtml(recon)}
      <div class="trial-actual-daily-table actual-production-daily-table">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Target</th>
              <th>Shop output</th>
              <th>Reject</th>
              <th>Remarks</th>
              <th>ERP today</th>
              <th>Status</th>
              <th class="ap-daily-actions-head">Actions</th>
            </tr>
          </thead>
          <tbody data-trial-actual-daily-grid="${blockId}">
            ${rowsHtml}
          </tbody>
        </table>
      </div>
      <div class="actual-production-op-actions">
        <label class="trial-actual-cell" style="min-width:180px">
          <span>Add date</span>
          <input type="date" value="${trialTodayISO()}" data-actual-add-date="${blockId}">
        </label>
        <button type="button" class="btn btn-ghost btn-sm" data-actual-add-btn="${blockId}">Add Date</button>
      </div>
    </section>
  `;
}

function actualProductionRenderJobCard(job) {
  const { machine, group } = job;
  const leader = group.leader || (group.blocks || [])[0] || {};
  const psDisplay = trialBlockPsDisplay(group, leader);
  const queueLabel = job.queue > 0 ? `#${job.queue}` : '—';
  const statusClass = trialStatusClass(group.status);
  const targetQty = Number(group.target_qty || leader.scheduled_qty || 0);
  const outputQty = Number(group.output_qty || 0);
  const rejectQty = Number(group.reject_qty || 0);
  const remainingQty = Number(group.remaining_qty || group.paired_remaining_qty || 0);
  const blocks = (group.blocks || []).map(block => trialBlockMemberMetrics(block));

  return `
    <article class="actual-production-job card" data-machine-id="${machine.machine_id}" data-job-key="${escapeHtml(actualProductionJobKey(group))}">
      <header class="actual-production-job-head">
        <div class="actual-production-job-main">
          <div class="actual-production-job-ps">
            <span class="actual-production-queue">${escapeHtml(queueLabel)}</span>
            <strong>${escapeHtml(psDisplay.base || group.ps_id || leader.job_no || '')}</strong>
            ${psDisplay.partial ? `<span class="actual-production-partial">Partial ${escapeHtml(psDisplay.partial)}</span>` : ''}
          </div>
          <div class="actual-production-job-op">${escapeHtml(group.operation_label || group.group_label || '')}</div>
          <div class="actual-production-job-machine">${escapeHtml(machine.machine_code || '')} · ${escapeHtml(machine.machine_category || '')}</div>
        </div>
        <div class="actual-production-job-side">
          <span class="trial-pill ${statusClass}">${escapeHtml(String(group.status || 'NOT_STARTED').replace(/_/g, ' '))}</span>
          <span class="trial-pill">End ${trialFormatDt(group.visual_end_datetime || leader.calculated_end_datetime)}</span>
        </div>
      </header>
      <div class="trial-actual-summary actual-production-summary">
        <div><span class="field-hint">Scheduled</span><strong>${fmt(targetQty, 0)}</strong></div>
        <div><span class="field-hint">Output</span><strong>${fmt(outputQty, 0)}</strong></div>
        <div><span class="field-hint">Reject</span><strong>${fmt(rejectQty, 0)}</strong></div>
        <div><span class="field-hint">Remaining</span><strong>${fmt(remainingQty, 0)}</strong></div>
      </div>
      <div class="actual-production-ops">
        ${blocks.map(block => actualProductionRenderBlockEntry(block)).join('')}
      </div>
    </article>
  `;
}

function actualProductionBindAddDateButtons() {
  document.querySelectorAll('[data-actual-add-btn]').forEach(button => {
    if (button.dataset.bound === '1') return;
    button.dataset.bound = '1';
    button.addEventListener('click', () => {
      const blockId = Number(button.dataset.actualAddBtn || 0);
      const input = document.querySelector(`[data-actual-add-date="${blockId}"]`);
      trialAddActualDailyRow(blockId, input?.value || trialTodayISO());
    });
  });
}

function actualProductionRenderFilters() {
  const categorySelect = document.getElementById('actual-production-category');
  if (categorySelect) {
    const categories = trialMachineCategories();
    categorySelect.innerHTML = categories.map(cat => `
      <option value="${escapeHtml(cat)}" ${String(actualProductionFilter.category) === String(cat) ? 'selected' : ''}>
        ${escapeHtml(trialMachineCategoryLabel(cat))}
      </option>
    `).join('');
  }

  const machineSelect = document.getElementById('actual-production-machine');
  if (machineSelect) {
    const machines = actualProductionMachinesForFilter();
    const options = ['<option value="">All machines</option>'].concat(
      machines.map(machine => `
        <option value="${machine.machine_id}" ${String(actualProductionFilter.machineId) === String(machine.machine_id) ? 'selected' : ''}>
          ${escapeHtml(machine.machine_code || '')}
        </option>
      `)
    );
    machineSelect.innerHTML = options.join('');
  }
}

function renderActualProduction() {
  const loading = document.getElementById('actual-production-loading');
  const list = document.getElementById('actual-production-list');
  const empty = document.getElementById('actual-production-empty');
  const stats = document.getElementById('actual-production-stats');
  if (!list) return;

  actualProductionRenderFilters();
  const jobs = actualProductionFilteredJobs();
  if (stats) {
    const total = actualProductionQueuedJobs().length;
    stats.textContent = `${jobs.length} shown · ${total} on queue`;
  }

  if (loading) loading.hidden = true;
  if (!jobs.length) {
    list.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }

  if (empty) empty.hidden = true;
  list.hidden = false;
  list.innerHTML = jobs.map(job => actualProductionRenderJobCard(job)).join('');
  actualProductionBindAddDateButtons();
}

async function loadActualProduction(options = {}) {
  const loading = document.getElementById('actual-production-loading');
  const list = document.getElementById('actual-production-list');
  if (loading) loading.hidden = false;
  if (list) list.hidden = true;

  trialScheduleDateFilter = trialDefaultScheduleDateFilter();
  const params = new URLSearchParams({ lite: '1', include: 'segments,actuals,actual_daily' });
  if (options.force) params.set('_', String(Date.now()));

  try {
    const scheduleData = await GET(`/api/trial/schedule?${params}`);
    trialApplySchedulePayload(scheduleData, { machines: [] }, null);
    if (!scheduleData.machines?.length) {
      const machinesResult = await GET('/api/planner/machines').catch(() => ({ machines: [] }));
      if (machinesResult?.machines?.length) {
        trialApplySchedulePayload(scheduleData, machinesResult, null);
      }
    }
    renderActualProduction();
  } catch (err) {
    if (loading) loading.hidden = true;
    toast('Could not load queue jobs: ' + err.message, 'error');
  }
}

function actualProductionOnCategoryChange(event) {
  actualProductionFilter.category = String(event.target.value || 'ALL');
  actualProductionFilter.machineId = '';
  renderActualProduction();
}

function actualProductionOnMachineChange(event) {
  actualProductionFilter.machineId = String(event.target.value || '');
  renderActualProduction();
}

function actualProductionOnSearchInput(event) {
  actualProductionFilter.search = String(event.target.value || '');
  renderActualProduction();
}

window.trialScheduleRenderHook = renderActualProduction;

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('actual-production-category')?.addEventListener('change', actualProductionOnCategoryChange);
  document.getElementById('actual-production-machine')?.addEventListener('change', actualProductionOnMachineChange);
  document.getElementById('actual-production-search')?.addEventListener('input', actualProductionOnSearchInput);
  document.getElementById('actual-production-refresh')?.addEventListener('click', () => loadActualProduction({ force: true }));
  loadActualProduction();
});
