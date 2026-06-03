// Queue Delays — nested by PS + partial; Coway EDD on group header.

const queueDelaysState = {
  jobs: [],
  summary: { total: 0, at_risk: 0 },
  filter: 'all',
  search: '',
  sortBy: 'days_late',
  sortDir: 'desc',
};

const QUEUE_DELAYS_SORT_DIR_LABELS = {
  ps: { asc: '↑ A → Z', desc: '↓ Z → A' },
  days_late: { asc: '↑ Least late', desc: '↓ Most late' },
  end: { asc: '↑ Earliest', desc: '↓ Latest' },
  due: { asc: '↑ Earliest', desc: '↓ Latest' },
  coway: { asc: '↑ Earliest', desc: '↓ Latest' },
};

function queueDelaysDateInputValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.slice(0, 10);
}

function queueDelaysSplitPsId(value) {
  const raw = String(value || '').trim();
  if (!raw) return { base: '', partial: 1 };
  const parts = raw.split('::');
  const partial = Number(parts[1] || 1);
  return {
    base: parts[0] || raw,
    partial: Number.isFinite(partial) && partial > 0 ? partial : 1,
  };
}

function queueDelaysPartialNo(job) {
  const fromField = Number(job?.pp_partial_no ?? job?.partial_no);
  if (Number.isFinite(fromField) && fromField > 0) return fromField;
  const parsed = queueDelaysSplitPsId(job?.planner_ps_id || job?.source_ps_id || job?.ps_id);
  return parsed.partial;
}

function queueDelaysPsBase(job) {
  const fromField = String(job?.ps_id || '').trim();
  if (fromField) return fromField.split('::')[0];
  return queueDelaysSplitPsId(job?.planner_ps_id || job?.source_ps_id).base;
}

function queueDelaysPlannerPsId(job) {
  const base = queueDelaysPsBase(job);
  const partial = queueDelaysPartialNo(job);
  if (!base) return String(job?.planner_ps_id || job?.source_ps_id || '').trim();
  return partial > 1 ? `${base}::${partial}` : base;
}

function queueDelaysPartialSiblingCounts(jobs) {
  const counts = new Map();
  (jobs || []).forEach(job => {
    const base = queueDelaysPsBase(job);
    if (!base) return;
    counts.set(base, (counts.get(base) || 0) + 1);
  });
  return counts;
}

function queueDelaysShowPartialLabel(partialNo, psBase, siblingCounts) {
  const siblings = Number(siblingCounts?.get(psBase) || 0);
  return partialNo > 1 || siblings > 1;
}

function queueDelaysPartialLabelHtml(partialNo, psBase, siblingCounts) {
  if (!queueDelaysShowPartialLabel(partialNo, psBase, siblingCounts)) return '';
  return `<span class="queue-delays-partial" title="Partial ${partialNo}">P${escapeHtml(String(partialNo))}</span>`;
}

function queueDelaysIsoDate(value) {
  const text = queueDelaysDateInputValue(value);
  if (!text) return null;
  const d = new Date(`${text}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function queueDelaysEndDay(value) {
  const text = queueDelaysNormalizeDateTimeText(value);
  if (!text) return null;
  const dayText = text.slice(0, 10);
  const d = new Date(`${dayText}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function queueDelaysApplyRisk(job, groupCoway, groupDue) {
  const coway = queueDelaysDateInputValue(groupCoway != null ? groupCoway : job.coway_edd);
  const due = queueDelaysDateInputValue(groupDue != null ? groupDue : job.due_date);
  const endDay = queueDelaysEndDay(job.end_at);
  let commitmentSource = '';
  let commitmentDate = '';
  let refDay = null;

  if (coway) {
    commitmentSource = 'coway';
    commitmentDate = coway;
    refDay = queueDelaysIsoDate(coway);
  } else if (due) {
    commitmentSource = 'due';
    commitmentDate = due;
    refDay = queueDelaysIsoDate(due);
  }

  const pastCommitment = Boolean(
    endDay && refDay && endDay.getTime() > refDay.getTime()
  );
  const delayDays = pastCommitment
    ? Math.floor((endDay.getTime() - refDay.getTime()) / 86400000)
    : 0;

  job.commitment_source = commitmentSource;
  job.commitment_date = commitmentDate;
  job.past_commitment = pastCommitment;
  job.past_due = pastCommitment && commitmentSource === 'due';
  job.past_coway_edd = pastCommitment && commitmentSource === 'coway';
  job.delay_days = delayDays;
  job.coway_delay_days = job.past_coway_edd ? delayDays : 0;
  job.at_risk = pastCommitment;
  return job;
}

function queueDelaysRecomputeSummary() {
  const groups = queueDelaysBuildGroups(queueDelaysState.jobs || []);
  queueDelaysState.summary = {
    total: queueDelaysState.jobs.length,
    groups: groups.length,
    at_risk: groups.filter(group => group.at_risk).length,
  };
}

function queueDelaysUpdateJobsForPlannerPs(plannerPsId, cowayEdd) {
  const needle = String(plannerPsId || '').trim();
  if (!needle) return;
  (queueDelaysState.jobs || []).forEach(job => {
    if (queueDelaysPlannerPsId(job) !== needle) return;
    job.coway_edd = queueDelaysDateInputValue(cowayEdd);
    queueDelaysApplyRisk(job);
  });
  queueDelaysRecomputeSummary();
}

function queueDelaysNormalizeDateTimeText(value) {
  let text = String(value || '').trim().replace('T', ' ');
  return text.replace(/[+-]\d{2}:?\d{2}$/i, '').replace(/Z$/i, '').trim();
}

function queueDelaysFormatDt(value) {
  const text = queueDelaysNormalizeDateTimeText(value);
  if (!text) return '—';
  return text.slice(0, 16);
}

function queueDelaysFormatDate(value) {
  const text = String(value || '').trim();
  if (!text) return '—';
  return text.slice(0, 10);
}

function queueDelaysStatusHtml(job) {
  if (!job.at_risk) {
    const hint = job.commitment_source === 'coway'
      ? 'Forecast end is on or before Coway EDD'
      : (job.commitment_source === 'due'
        ? 'Forecast end is on or before PS due'
        : 'No commitment date to compare');
    return `<span class="queue-delays-status is-ok" title="${escapeHtml(hint)}">On track</span>`;
  }
  const days = Number(job.delay_days || 0);
  const dayLabel = days > 0 ? `${days}d late` : 'Late';
  if (job.commitment_source === 'coway') {
    return `<span class="queue-delays-status is-past-coway" title="Forecast end is past Coway EDD">${escapeHtml(dayLabel)}</span>`;
  }
  if (job.commitment_source === 'due') {
    return `<span class="queue-delays-status is-past-due" title="Forecast end is past PS due date">${escapeHtml(dayLabel)}</span>`;
  }
  return `<span class="queue-delays-status is-past-due">${escapeHtml(dayLabel)}</span>`;
}

function queueDelaysGroupStatusHtml(group) {
  if (!group.at_risk) {
    return `<span class="queue-delays-status is-ok" title="All queued ops on or before commitment">On track</span>`;
  }
  const worst = group.worst_child;
  if (!worst) return queueDelaysStatusHtml({ at_risk: true, delay_days: group.max_delay_days, commitment_source: group.commitment_source });
  const opHint = worst.operation ? ` · ${worst.operation}` : '';
  const days = Number(group.max_delay_days || 0);
  const dayLabel = days > 0 ? `${days}d late` : 'Late';
  const cls = group.commitment_source === 'coway' ? 'is-past-coway' : 'is-past-due';
  return `<span class="queue-delays-status ${cls}" title="Worst op${opHint}">${escapeHtml(dayLabel)}</span>`;
}

function queueDelaysRowClass(job) {
  if (!job.at_risk) return '';
  if (job.commitment_source === 'coway') return 'is-past-coway';
  if (job.commitment_source === 'due') return 'is-past-due';
  return 'is-past-due';
}

function queueDelaysGroupRowClass(group) {
  if (!group.at_risk) return '';
  if (group.commitment_source === 'coway') return 'is-past-coway';
  if (group.commitment_source === 'due') return 'is-past-due';
  return '';
}

function queueDelaysDateSortValue(value) {
  const day = queueDelaysIsoDate(value) || queueDelaysEndDay(value);
  return day ? day.getTime() : null;
}

function queueDelaysJobSearchHaystack(job) {
  return [
    queueDelaysPsBase(job),
    queueDelaysPlannerPsId(job),
    `P${queueDelaysPartialNo(job)}`,
    `partial ${queueDelaysPartialNo(job)}`,
    `::${queueDelaysPartialNo(job)}`,
    job.operation,
    job.machine_code,
    job.machine_category,
    job.due_date,
    job.coway_edd,
  ].join(' ').toLowerCase();
}

function queueDelaysGroupSearchHaystack(group) {
  const childText = (group.children || []).map(queueDelaysJobSearchHaystack).join(' ');
  return [
    group.ps_id,
    group.planner_ps_id,
    `P${group.partial_no}`,
    group.due_date,
    group.coway_edd,
    childText,
  ].join(' ').toLowerCase();
}

function queueDelaysBuildGroups(jobs) {
  const buckets = new Map();
  (jobs || []).forEach(job => {
    const id = queueDelaysPlannerPsId(job);
    if (!id) return;
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push(job);
  });

  const siblingCounts = queueDelaysPartialSiblingCounts(jobs);
  return Array.from(buckets.entries()).map(([plannerPsId, children]) => {
    const sortedChildren = [...children].sort((a, b) => {
      const machineCmp = String(a.machine_code || '').localeCompare(String(b.machine_code || ''));
      if (machineCmp !== 0) return machineCmp;
      const queueCmp = Number(a.queue_position || 0) - Number(b.queue_position || 0);
      if (queueCmp !== 0) return queueCmp;
      const aStart = queueDelaysDateSortValue(a.start_at);
      const bStart = queueDelaysDateSortValue(b.start_at);
      if (aStart != null && bStart != null && aStart !== bStart) return aStart - bStart;
      return Number(a.block_id || 0) - Number(b.block_id || 0);
    });
    const lead = sortedChildren[0];
    const cowayEdd = queueDelaysDateInputValue(lead?.coway_edd);
    const dueDate = queueDelaysDateInputValue(lead?.due_date);
    sortedChildren.forEach(child => queueDelaysApplyRisk(child, cowayEdd, dueDate));

    const atRisk = sortedChildren.some(child => child.at_risk);
    const maxDelayDays = sortedChildren.reduce((max, child) => Math.max(max, Number(child.delay_days || 0)), 0);
    const worstChild = sortedChildren.reduce((best, child) => (
      Number(child.delay_days || 0) > Number(best?.delay_days || 0) ? child : best
    ), sortedChildren[0]);
    const endTimes = sortedChildren
      .map(child => queueDelaysDateSortValue(child.end_at))
      .filter(value => value != null);
    const latestEndMs = endTimes.length ? Math.max(...endTimes) : null;
    const latestEnd = latestEndMs == null
      ? ''
      : (sortedChildren.find(child => queueDelaysDateSortValue(child.end_at) === latestEndMs)?.end_at || '');

    const psBase = queueDelaysPsBase(lead);
    const partialNo = queueDelaysPartialNo(lead);
    const commitmentSource = cowayEdd ? 'coway' : (dueDate ? 'due' : '');

    return {
      planner_ps_id: plannerPsId,
      ps_id: psBase,
      partial_no: partialNo,
      due_date: dueDate,
      coway_edd: cowayEdd,
      commitment_source: commitmentSource,
      children: sortedChildren,
      op_count: sortedChildren.length,
      at_risk: atRisk,
      max_delay_days: maxDelayDays,
      worst_child: worstChild,
      latest_end_at: latestEnd,
      show_partial: queueDelaysShowPartialLabel(partialNo, psBase, siblingCounts),
    };
  });
}

function queueDelaysGroupSortValue(group, sortBy) {
  switch (sortBy) {
    case 'ps':
      return `${group.ps_id}\x00${String(group.partial_no).padStart(4, '0')}`;
    case 'days_late':
      return Number(group.max_delay_days || 0);
    case 'end':
      return queueDelaysDateSortValue(group.latest_end_at);
    case 'due':
      return queueDelaysDateSortValue(group.due_date);
    case 'coway':
      return queueDelaysDateSortValue(group.coway_edd);
    default:
      return '';
  }
}

function queueDelaysCompareValues(left, right, sortBy) {
  if (sortBy === 'ps') {
    return String(left || '').localeCompare(String(right || ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  }
  if (sortBy === 'days_late') {
    return Number(left || 0) - Number(right || 0);
  }
  const leftMissing = left == null;
  const rightMissing = right == null;
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  return Number(left) - Number(right);
}

function queueDelaysVisibleGroups() {
  const needle = String(queueDelaysState.search || '').trim().toLowerCase();
  let groups = queueDelaysBuildGroups(queueDelaysState.jobs || []);

  if (needle) {
    groups = groups.filter(group => queueDelaysGroupSearchHaystack(group).includes(needle));
  }
  if (queueDelaysState.filter === 'at_risk') {
    groups = groups.filter(group => group.at_risk);
  }

  const sortBy = String(queueDelaysState.sortBy || 'days_late');
  const sortDir = String(queueDelaysState.sortDir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  const sign = sortDir === 'asc' ? 1 : -1;

  return groups.sort((a, b) => {
    const cmp = queueDelaysCompareValues(
      queueDelaysGroupSortValue(a, sortBy),
      queueDelaysGroupSortValue(b, sortBy),
      sortBy,
    );
    if (cmp !== 0) return cmp * sign;
    const tiePs = queueDelaysCompareValues(
      queueDelaysGroupSortValue(a, 'ps'),
      queueDelaysGroupSortValue(b, 'ps'),
      'ps',
    );
    return tiePs * sign;
  });
}

function queueDelaysUpdateSortDirButton() {
  const button = document.getElementById('queue-delays-sort-dir');
  if (!button) return;
  const sortBy = String(queueDelaysState.sortBy || 'days_late');
  const sortDir = String(queueDelaysState.sortDir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  const labels = QUEUE_DELAYS_SORT_DIR_LABELS[sortBy] || QUEUE_DELAYS_SORT_DIR_LABELS.days_late;
  button.textContent = labels[sortDir] || labels.desc;
  button.title = `Sort ${sortDir === 'asc' ? 'ascending' : 'descending'} — click to reverse`;
  button.setAttribute('aria-pressed', sortDir === 'desc' ? 'true' : 'false');
}

function queueDelaysCowayCellHtml(group) {
  const plannerPsId = group.planner_ps_id;
  const psBase = group.ps_id;
  const partialNo = group.partial_no;
  const value = queueDelaysDateInputValue(group.coway_edd);
  const partialLabel = partialNo > 1 ? ` P${partialNo}` : '';
  return `
    <div class="queue-delays-coway-wrap" data-action="coway-edd-wrap">
      <input
        type="date"
        class="queue-delays-coway-input ps-coway-edd-input"
        data-action="coway-edd"
        data-ps-id="${escapeHtml(plannerPsId)}"
        value="${escapeHtml(value)}"
        data-last-saved="${escapeHtml(value)}"
        aria-label="Coway EDD for ${escapeHtml(psBase)}${partialLabel}"
      />
      <span class="queue-delays-coway-status ps-coway-edd-status" hidden></span>
    </div>
  `;
}

function queueDelaysRenderGroupHeader(group) {
  const partial = queueDelaysPartialLabelHtml(group.partial_no, group.ps_id, queueDelaysPartialSiblingCounts(queueDelaysState.jobs));
  const dueMuted = group.commitment_source === 'coway' ? ' queue-delays-due--inactive' : '';
  const dueTitle = group.commitment_source === 'coway'
    ? 'PS due (not used while Coway EDD is set)'
    : 'PS due date';
  const endClass = group.at_risk
    ? (group.commitment_source === 'coway' ? 'is-past-coway' : 'is-past-due')
    : '';
  const opSummary = group.op_count === 1
    ? '1 queued op'
    : `${group.op_count} queued ops`;

  return `
    <tr class="queue-delays-group-row ${queueDelaysGroupRowClass(group)}"
      data-planner-ps-id="${escapeHtml(group.planner_ps_id)}"
      data-row-type="group">
      <td class="queue-delays-ps queue-delays-ps--group" colspan="2">
        <div class="queue-delays-group-head">
          <strong>${escapeHtml(group.ps_id)}</strong>
          ${partial}
          <span class="queue-delays-group-meta">${escapeHtml(opSummary)}</span>
        </div>
      </td>
      <td class="queue-delays-machine queue-delays-muted">—</td>
      <td class="queue-delays-date queue-delays-muted">—</td>
      <td class="queue-delays-date queue-delays-end queue-delays-group-end ${endClass}"
        title="Latest forecast end across queued ops">
        ${escapeHtml(queueDelaysFormatDt(group.latest_end_at))}
      </td>
      <td class="queue-delays-date queue-delays-due${dueMuted}" title="${escapeHtml(dueTitle)}">
        ${escapeHtml(queueDelaysFormatDate(group.due_date))}
      </td>
      <td class="queue-delays-coway">${queueDelaysCowayCellHtml(group)}</td>
      <td class="queue-delays-status-cell">${queueDelaysGroupStatusHtml(group)}</td>
    </tr>
  `;
}

function queueDelaysChildOperationLabel(job, siblings) {
  const base = String(job.operation || '').trim();
  const sameOp = (siblings || [])
    .filter(other => (
      String(other.source_op_no || '') === String(job.source_op_no || '')
      && String(other.machine_code || '') === String(job.machine_code || '')
    ))
    .sort((a, b) => (
      Number(a.queue_position || 0) - Number(b.queue_position || 0)
      || Number(a.block_id || 0) - Number(b.block_id || 0)
    ));
  const qty = Math.round(Number(job.scheduled_qty || 0));
  const qtyText = qty > 0 ? ` · qty ${qty}` : '';
  if (sameOp.length <= 1) return `${base}${qtyText}`;
  const runIndex = sameOp.findIndex(item => Number(item.block_id || 0) === Number(job.block_id || 0)) + 1;
  return `${base} · split ${runIndex}/${sameOp.length}${qtyText}`;
}

function queueDelaysRenderChildRow(job, siblings) {
  const endClass = job.at_risk
    ? (job.commitment_source === 'coway' ? 'is-past-coway' : 'is-past-due')
    : '';
  const opLabel = queueDelaysChildOperationLabel(job, siblings);
  const queueHint = Number(job.queue_position || 0) > 0
    ? ` title="Machine queue #${Number(job.queue_position)}"`
    : '';
  return `
    <tr class="queue-delays-child-row ${queueDelaysRowClass(job)}"
      data-planner-ps-id="${escapeHtml(queueDelaysPlannerPsId(job))}"
      data-row-type="child"
      data-block-id="${Number(job.block_id || 0)}">
      <td class="queue-delays-ps queue-delays-ps--child" aria-hidden="true"></td>
      <td class="queue-delays-op">${escapeHtml(opLabel)}</td>
      <td class="queue-delays-machine"${queueHint}>${escapeHtml(job.machine_code || '')}</td>
      <td class="queue-delays-date">${escapeHtml(queueDelaysFormatDt(job.start_at))}</td>
      <td class="queue-delays-date queue-delays-end ${endClass}">${escapeHtml(queueDelaysFormatDt(job.end_at))}</td>
      <td class="queue-delays-date queue-delays-muted" title="See PS header">—</td>
      <td class="queue-delays-coway queue-delays-muted" title="Edit Coway EDD on PS header">—</td>
      <td class="queue-delays-status-cell">${queueDelaysStatusHtml(job)}</td>
    </tr>
  `;
}

function queueDelaysRenderGroup(group) {
  const children = group.children || [];
  return [
    queueDelaysRenderGroupHeader(group),
    ...children.map(job => queueDelaysRenderChildRow(job, children)),
  ].join('');
}

function queueDelaysSetCowayStatus(wrap, status, message) {
  if (!wrap) return;
  wrap.classList.remove('is-saving', 'is-saved', 'is-error');
  if (status) wrap.classList.add(status);
  const note = wrap.querySelector('.queue-delays-coway-status');
  if (!note) return;
  if (!message) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  note.hidden = false;
  note.textContent = message;
}

async function queueDelaysSaveCoway(plannerPsId, value, inputEl) {
  const psId = String(plannerPsId || '').trim();
  if (!psId) return;
  const nextValue = queueDelaysDateInputValue(value);
  if (inputEl && inputEl.dataset.lastSaved === nextValue) return;

  const wrap = inputEl?.closest('[data-action="coway-edd-wrap"]') || null;
  if (inputEl) {
    inputEl.disabled = true;
    queueDelaysSetCowayStatus(wrap, 'is-saving', 'Saving…');
  }

  try {
    const res = await fetch('/api/process-sheets/coway-proposed-edd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ps_id: psId,
        coway_proposed_edd: nextValue || null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);

    const saved = queueDelaysDateInputValue(data.coway_proposed_edd);
    const savedPsId = String(data.ps_id || psId).trim() || psId;
    queueDelaysUpdateJobsForPlannerPs(savedPsId, saved);
    renderQueueDelays();
  } catch (err) {
    if (inputEl) {
      inputEl.disabled = false;
      inputEl.classList.add('is-error');
      inputEl.title = err.message || 'Could not save Coway EDD';
      queueDelaysSetCowayStatus(wrap, 'is-error', 'Save failed');
    }
    toast('Could not save Coway EDD: ' + err.message, 'error');
  }
}

function queueDelaysBindCowayInputs() {
  const body = document.getElementById('queue-delays-body');
  if (!body || body.dataset.cowayBound === '1') return;
  body.dataset.cowayBound = '1';
  body.addEventListener('change', (event) => {
    const input = event.target.closest('[data-action="coway-edd"]');
    if (!input) return;
    queueDelaysSaveCoway(input.dataset.psId || '', input.value, input);
  });
  body.addEventListener('blur', (event) => {
    const input = event.target.closest('[data-action="coway-edd"]');
    if (!input) return;
    queueDelaysSaveCoway(input.dataset.psId || '', input.value, input);
  }, true);
}

function renderQueueDelays() {
  const loading = document.getElementById('queue-delays-loading');
  const wrap = document.getElementById('queue-delays-table-wrap');
  const body = document.getElementById('queue-delays-body');
  const empty = document.getElementById('queue-delays-empty');
  const emptyText = document.getElementById('queue-delays-empty-text');
  const stats = document.getElementById('queue-delays-stats');
  if (!body) return;

  queueDelaysUpdateSortDirButton();
  const groups = queueDelaysVisibleGroups();
  const totalOps = groups.reduce((sum, group) => sum + Number(group.op_count || 0), 0);
  const atRiskGroups = groups.filter(group => group.at_risk).length;

  if (stats) {
    stats.textContent = `${groups.length} PS · ${totalOps} ops · ${atRiskGroups} at risk`;
  }

  if (loading) loading.hidden = true;
  if (!groups.length) {
    if (wrap) wrap.hidden = true;
    if (empty) empty.hidden = false;
    if (emptyText) {
      emptyText.textContent = queueDelaysState.filter === 'at_risk'
        ? 'No queued PS groups are forecast to miss their commitment date.'
        : 'No queued jobs match your filters.';
    }
    return;
  }

  if (empty) empty.hidden = true;
  if (wrap) wrap.hidden = false;
  body.innerHTML = groups.map(queueDelaysRenderGroup).join('');
  queueDelaysBindCowayInputs();
}

async function loadQueueDelays(options = {}) {
  const loading = document.getElementById('queue-delays-loading');
  const wrap = document.getElementById('queue-delays-table-wrap');
  const empty = document.getElementById('queue-delays-empty');
  if (loading) loading.hidden = false;
  if (wrap) wrap.hidden = true;
  if (empty) empty.hidden = true;

  const url = options.force ? `/api/trial/queue-delays?_=${Date.now()}` : '/api/trial/queue-delays';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    queueDelaysState.jobs = (Array.isArray(data.jobs) ? data.jobs : []).map(job => queueDelaysApplyRisk(job));
    queueDelaysRecomputeSummary();
    renderQueueDelays();
  } catch (err) {
    if (loading) loading.hidden = true;
    toast('Could not load queue delays: ' + err.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const sortBySelect = document.getElementById('queue-delays-sort-by');
  if (sortBySelect) {
    sortBySelect.value = queueDelaysState.sortBy;
  }
  queueDelaysUpdateSortDirButton();

  document.getElementById('queue-delays-filter')?.addEventListener('change', (event) => {
    queueDelaysState.filter = String(event.target.value || 'all');
    renderQueueDelays();
  });
  sortBySelect?.addEventListener('change', (event) => {
    queueDelaysState.sortBy = String(event.target.value || 'days_late');
    queueDelaysUpdateSortDirButton();
    renderQueueDelays();
  });
  document.getElementById('queue-delays-sort-dir')?.addEventListener('click', () => {
    queueDelaysState.sortDir = queueDelaysState.sortDir === 'asc' ? 'desc' : 'asc';
    queueDelaysUpdateSortDirButton();
    renderQueueDelays();
  });
  document.getElementById('queue-delays-search')?.addEventListener('input', (event) => {
    queueDelaysState.search = String(event.target.value || '');
    renderQueueDelays();
  });
  document.getElementById('queue-delays-refresh')?.addEventListener('click', () => {
    loadQueueDelays({ force: true });
  });
  loadQueueDelays();
});
