// Queue Delays — list of queued jobs with due / Coway EDD risk flags.

const queueDelaysState = {
  jobs: [],
  summary: { total: 0, at_risk: 0 },
  filter: 'at_risk',
  search: '',
};

function queueDelaysFormatDt(value) {
  const text = String(value || '').trim();
  if (!text) return '—';
  if (text.length >= 16) return text.slice(0, 16).replace('T', ' ');
  if (text.length >= 10) return text.slice(0, 10);
  return text;
}

function queueDelaysFormatDate(value) {
  const text = String(value || '').trim();
  if (!text) return '—';
  return text.slice(0, 10);
}

function queueDelaysStatusHtml(job) {
  const parts = [];
  if (job.past_due) {
    const days = Number(job.delay_days || 0);
    parts.push(`<span class="queue-delays-status is-past-due" title="Forecast end is past PS due date">${days > 0 ? `${days}d past due` : 'Past due'}</span>`);
  }
  if (job.past_coway_edd) {
    const days = Number(job.coway_delay_days || 0);
    parts.push(`<span class="queue-delays-status is-past-coway" title="Forecast end is past Coway EDD">${days > 0 ? `${days}d past Coway` : 'Past Coway'}</span>`);
  }
  if (!parts.length) {
    return '<span class="queue-delays-status is-ok">On track</span>';
  }
  return parts.join('');
}

function queueDelaysRowClass(job) {
  if (job.past_due) return 'is-past-due';
  if (job.past_coway_edd) return 'is-past-coway';
  return '';
}

function queueDelaysFilteredJobs() {
  const needle = String(queueDelaysState.search || '').trim().toLowerCase();
  return (queueDelaysState.jobs || []).filter(job => {
    if (queueDelaysState.filter === 'at_risk' && !job.at_risk) return false;
    if (!needle) return true;
    const haystack = [
      job.ps_id,
      job.partial_no ? `partial ${job.partial_no}` : '',
      job.operation,
      job.machine_code,
      job.machine_category,
      job.due_date,
      job.coway_edd,
    ].join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}

function queueDelaysRenderRow(job) {
  const partial = Number(job.partial_no || 0) > 1
    ? `<span class="queue-delays-partial">P${escapeHtml(String(job.partial_no))}</span>`
    : '';
  const endClass = job.past_due ? 'is-past-due' : (job.past_coway_edd ? 'is-past-coway' : '');
  return `
    <tr class="queue-delays-row ${queueDelaysRowClass(job)}">
      <td class="queue-delays-ps">
        <strong>${escapeHtml(job.ps_id || '')}</strong>
        ${partial}
      </td>
      <td class="queue-delays-op">${escapeHtml(job.operation || '')}</td>
      <td class="queue-delays-machine">${escapeHtml(job.machine_code || '')}</td>
      <td class="queue-delays-date">${escapeHtml(queueDelaysFormatDt(job.start_at))}</td>
      <td class="queue-delays-date queue-delays-end ${endClass}">${escapeHtml(queueDelaysFormatDt(job.end_at))}</td>
      <td class="queue-delays-date">${escapeHtml(queueDelaysFormatDate(job.due_date))}</td>
      <td class="queue-delays-date">${escapeHtml(queueDelaysFormatDate(job.coway_edd))}</td>
      <td class="queue-delays-status-cell">${queueDelaysStatusHtml(job)}</td>
    </tr>
  `;
}

function renderQueueDelays() {
  const loading = document.getElementById('queue-delays-loading');
  const wrap = document.getElementById('queue-delays-table-wrap');
  const body = document.getElementById('queue-delays-body');
  const empty = document.getElementById('queue-delays-empty');
  const emptyText = document.getElementById('queue-delays-empty-text');
  const stats = document.getElementById('queue-delays-stats');
  if (!body) return;

  const jobs = queueDelaysFilteredJobs();
  const summary = queueDelaysState.summary || { total: 0, at_risk: 0 };
  if (stats) {
    stats.textContent = `${jobs.length} shown · ${summary.at_risk || 0} at risk · ${summary.total || 0} queued`;
  }

  if (loading) loading.hidden = true;
  if (!jobs.length) {
    if (wrap) wrap.hidden = true;
    if (empty) empty.hidden = false;
    if (emptyText) {
      emptyText.textContent = queueDelaysState.filter === 'at_risk'
        ? 'No queued jobs are forecast to miss their due date or Coway EDD.'
        : 'No queued jobs match your filters.';
    }
    return;
  }

  if (empty) empty.hidden = true;
  if (wrap) wrap.hidden = false;
  body.innerHTML = jobs.map(queueDelaysRenderRow).join('');
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
    queueDelaysState.jobs = Array.isArray(data.jobs) ? data.jobs : [];
    queueDelaysState.summary = data.summary || { total: queueDelaysState.jobs.length, at_risk: 0 };
    renderQueueDelays();
  } catch (err) {
    if (loading) loading.hidden = true;
    toast('Could not load queue delays: ' + err.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('queue-delays-filter')?.addEventListener('change', (event) => {
    queueDelaysState.filter = String(event.target.value || 'at_risk');
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
