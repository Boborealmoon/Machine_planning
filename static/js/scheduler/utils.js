// Pure utility helpers — no trialState access, no DOM side-effects.

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(value, decimals) {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function trialFormatDt(value) {
  if (!value) return '—';
  let text = String(value).replace('T', ' ');
  text = text.replace(/[+-]\d{2}:?\d{2}$/i, '').replace(/Z$/i, '').trim();
  return text.slice(0, 16);
}

function trialParseVisualDateTime(value) {
  return trialParsePlannerDateTime(value);
}

/** Parse planner/API datetime as wall-clock components (no browser TZ shift). */
function trialParsePlannerDateTime(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  text = text.replace('T', ' ');
  text = text.replace(/\.\d+$/, '');
  text = text.replace(/[+-]\d{2}:?\d{2}$/i, '').replace(/Z$/i, '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
}

/** Format API datetime for <input type="datetime-local"> (wall clock, not UTC-shifted). */
function trialDatetimeLocalValue(value) {
  const parts = trialParsePlannerDateTime(value);
  if (!parts) return '';
  const y = parts.year;
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  const h = String(parts.hour).padStart(2, '0');
  const min = String(parts.minute).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}`;
}

/** Convert datetime-local value to planner storage format (naive local YYYY-MM-DD HH:MM:SS). */
function trialDatetimeLocalToStorage(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const normalized = text.replace('T', ' ');
  return normalized.length === 16 ? `${normalized}:00` : normalized.slice(0, 19);
}

function trialSplitPsId(value) {
  const raw = String(value || '').trim();
  if (!raw) return { base: '', partial: '' };
  const parts = raw.split('::');
  return { base: parts[0] || raw, partial: parts[1] || '' };
}

function trialTempPsDisplayId(psId) {
  const raw = String(psId || '').trim();
  if (!raw.startsWith('[Temp]')) return raw;
  const body = raw.slice('[Temp]'.length);
  return body ? `[Temp] ${body}` : raw;
}

function trialMachineCategoryLabel(category) {
  const raw = String(category || '').trim().toUpperCase();
  if (!raw || raw === 'ALL') return 'All';
  if (raw.length <= 3 || raw === 'MPP') return raw;
  return raw.charAt(0) + raw.slice(1).toLowerCase();
}

function trialTodayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function trialBlockQueuedAt(block) {
  if (!block) return '';
  return String(
    block.visual_start_datetime
    || block.calculated_start_datetime
    || block.predicted_start_at
    || block.planned_start_at
    || block.group_start
    || block.anchor_datetime
    || ''
  ).trim();
}

function trialBlockOutputAt(block) {
  if (!block) return '';
  if (block.actual_end_at) return String(block.actual_end_at).trim();
  return String(
    block.predicted_end_at
    || block.calculated_end_datetime
    || block.visual_end_datetime
    || block.planned_end_at
    || block.group_end
    || ''
  ).trim();
}

function trialBlockOutputTitle(block) {
  if (!block) return '';
  if (block.actual_end_at) return 'Output complete (from reported actuals)';
  if (block.actual_start_at) return 'Forecast output end (job in progress)';
  return 'Forecast output end (no actuals yet)';
}

function trialAddDaysISO(dateText, deltaDays) {
  if (!dateText) return '';
  const base = new Date(`${String(dateText).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(base.getTime())) return '';
  base.setDate(base.getDate() + Number(deltaDays || 0));
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, '0');
  const d = String(base.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function trialNormalizeScheduleDates(startText, endText) {
  let start = String(startText || '').trim();
  let end = String(endText || '').trim();
  if (end && start && end < start) end = start;
  return { start, end };
}

function trialDefaultScheduleDateFilter() {
  return { start: '', end: '' };
}

// Execution status chips — match Process Sheets (.ps-op-status) colour coding.
function trialNormalizeExecStatus(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const norm = raw.toUpperCase().replace(/[\s-]+/g, '_');
  if (norm === 'PENDING') return 'PENDING_SI';
  return norm;
}

function trialExecStatusLabel(value) {
  const norm = trialNormalizeExecStatus(value);
  const labels = {
    P: 'Pending SI',
    PENDING_SI: 'Pending SI',
    R: 'Ready to Start',
    READY_TO_START: 'Ready to Start',
    I: 'In Process',
    IN_PROCESS: 'In Process',
    C: 'Completed',
    COMPLETED: 'Completed',
  };
  return labels[norm] || String(value || '').trim();
}

function trialOpStatusClass(value) {
  const status = trialNormalizeExecStatus(value);
  if (status === 'I' || status === 'IN_PROCESS') return 'is-in-process';
  if (status === 'R' || status === 'READY_TO_START') return 'is-ready';
  if (status === 'P' || status === 'PENDING_SI') return 'is-pending';
  if (status === 'C' || status === 'COMPLETED') return 'is-completed';
  return 'is-unknown';
}

function trialOpStatusHtml(value, options = {}) {
  const status = String(value || '').trim();
  if (!trialNormalizeExecStatus(status)) return '';
  const label = trialExecStatusLabel(status);
  const opNo = String(options.opNo || '').trim();
  const title = String(options.title || '').trim();
  const compact = !!options.compact;
  if (compact) {
    return `<span class="ps-op-status ${trialOpStatusClass(status)}" title="${escapeHtml(title || label)}">${escapeHtml(label)}</span>`;
  }
  return `
    <span class="ps-op-status ${trialOpStatusClass(status)}" title="${escapeHtml(title || label)}">
      ${opNo ? `<strong>${escapeHtml(opNo)}</strong>` : ''}
      <span>${escapeHtml(label)}</span>
    </span>
  `;
}

function trialResolvedScheduleDateFilterFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const hasStart = params.has('start') || params.has('from');
  const hasEnd = params.has('end') || params.has('to');
  if (!hasStart && !hasEnd) {
    return trialDefaultScheduleDateFilter();
  }
  const urlStart = String(params.get('start') || params.get('from') || '').trim();
  const urlEnd = String(params.get('end') || params.get('to') || '').trim();
  if (!urlStart && !urlEnd) {
    return trialDefaultScheduleDateFilter();
  }
  return trialNormalizeScheduleDates(urlStart, urlEnd);
}

function trialEscapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trialDateDiffDays(dateText) {
  if (!dateText) return null;
  const date = new Date(`${String(dateText).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date(`${trialTodayLocal()}T00:00:00`);
  return Math.floor((date.getTime() - today.getTime()) / 86400000);
}

function trialTodayLocal() {
  return trialDateText(new Date());
}

function trialDateText(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function trialShiftDate(dateText, deltaDays) {
  const base = new Date(`${dateText || trialTodayLocal()}T00:00:00`);
  base.setDate(base.getDate() + Number(deltaDays || 0));
  return trialDateText(base);
}

function trialPublicHolidayMap() {
  const map = new Map();
  (trialState.public_holidays || []).forEach((row) => {
    const key = String(row.holiday_date || '').trim();
    if (key) map.set(key, row);
  });
  return map;
}

function trialPublicHolidayForDate(dateText) {
  return trialPublicHolidayMap().get(String(dateText || '').trim()) || null;
}

function trialDefaultProfileNameForDate(dateText) {
  if (trialPublicHolidayForDate(dateText)) return 'OFF';
  const d = new Date(`${dateText || trialTodayLocal()}T00:00:00`);
  const weekday = d.getDay();
  if (weekday === 0) return 'OFF';
  if (weekday === 6) return 'OFF';
  return 'NORMAL_DAY_NIGHT';
}

function trialPayloadToAttr(payload) {
  return escapeHtml(JSON.stringify(payload || {}));
}

// ── Lightweight perf tracing ──────────────────────────────────────────────────

let trialPerfSamples = [];

function trialPerfIsEnabled() {
  // Enabled by default for live debugging. Set window.trialPerfDebug = false to mute.
  return window.trialPerfDebug !== false;
}

function trialPerfNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function trialPerfStart(label, meta = {}) {
  return {
    label: String(label || 'perf'),
    meta: meta || {},
    t0: trialPerfNow(),
    marks: [],
  };
}

function trialPerfMark(span, name, data = {}) {
  if (!span) return;
  span.marks.push({
    name: String(name || 'mark'),
    t: trialPerfNow(),
    data: data || {},
  });
}

function trialPerfEnd(span, extra = {}) {
  if (!span) return null;
  const tEnd = trialPerfNow();
  const marks = [];
  let prev = span.t0;
  span.marks.forEach(mark => {
    const dt = Math.max(0, mark.t - prev);
    marks.push({
      name: mark.name,
      ms: Number(dt.toFixed(2)),
      ...mark.data,
    });
    prev = mark.t;
  });
  const totalMs = Math.max(0, tEnd - span.t0);
  const sample = {
    label: span.label,
    total_ms: Number(totalMs.toFixed(2)),
    started_at_ms: Number(span.t0.toFixed(2)),
    marks,
    ...span.meta,
    ...extra,
  };
  trialPerfSamples.push(sample);
  if (trialPerfSamples.length > 60) {
    trialPerfSamples = trialPerfSamples.slice(-60);
  }
  window.trialPerfSamples = trialPerfSamples;
  window.trialPerfLast = sample;

  if (trialPerfIsEnabled()) {
    const head = `[trial-perf] ${sample.label} ${sample.total_ms}ms`;
    if (console.groupCollapsed) console.groupCollapsed(head);
    else console.log(head);
    if (sample.marks.length) console.table(sample.marks);
    console.log(sample);
    if (console.groupEnd) console.groupEnd();
  }
  return sample;
}

function trialPerfSummary(lastN = 20) {
  const samples = (window.trialPerfSamples || []).slice(-Math.max(1, Number(lastN || 20)));
  const byLabel = new Map();
  samples.forEach(sample => {
    const key = String(sample.label || 'unknown');
    const entry = byLabel.get(key) || { label: key, count: 0, total: 0, max: 0, min: Number.POSITIVE_INFINITY };
    const ms = Number(sample.total_ms || 0);
    entry.count += 1;
    entry.total += ms;
    entry.max = Math.max(entry.max, ms);
    entry.min = Math.min(entry.min, ms);
    byLabel.set(key, entry);
  });
  const rows = Array.from(byLabel.values()).map(entry => ({
    label: entry.label,
    count: entry.count,
    avg_ms: Number((entry.total / Math.max(1, entry.count)).toFixed(2)),
    max_ms: Number(entry.max.toFixed(2)),
    min_ms: Number((entry.min === Number.POSITIVE_INFINITY ? 0 : entry.min).toFixed(2)),
  })).sort((a, b) => b.avg_ms - a.avg_ms);
  if (console.table) console.table(rows);
  return rows;
}

function trialOpFromPayload(payload) {
  if (!payload) return null;
  return payload.op || {
    source_ps_id: payload.source_ps_id || payload.ps_id || '',
    source_op_seq_id: Number(payload.source_op_seq_id || 0),
    source_op_no: payload.source_op_no || '',
    operation_name: payload.operation_name || '',
    op_type: payload.op_type || '',
    total_qty: Number(payload.total_qty || payload.remaining_qty || payload.target_qty || 0),
    remaining_qty: Number(payload.remaining_qty || payload.total_qty || payload.target_qty || 0),
    setup_time: Number(payload.setup_time || payload.setup_minutes || 0),
    cycle_time: Number(payload.cycle_time || payload.cycle_minutes_per_qty || 0),
    compatible_machine_group: payload.compatible_machine_group || '',
  };
}

// ── Toast notifications ───────────────────────────────────────────────────────

let _toastContainer = null;

function _ensureToastContainer() {
  if (_toastContainer && document.body.contains(_toastContainer)) return _toastContainer;
  _toastContainer = document.createElement('div');
  _toastContainer.id = 'toast-container';
  Object.assign(_toastContainer.style, {
    position: 'fixed', bottom: '24px', right: '24px',
    display: 'flex', flexDirection: 'column', gap: '8px',
    zIndex: '9999', pointerEvents: 'none',
  });
  document.body.appendChild(_toastContainer);
  return _toastContainer;
}

function toast(message, type = 'info') {
  const container = _ensureToastContainer();
  const el = document.createElement('div');
  const bg = type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#374151';
  Object.assign(el.style, {
    background: bg, color: '#fff', padding: '10px 16px',
    borderRadius: '10px', fontSize: '13px', fontWeight: '600',
    maxWidth: '320px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
    pointerEvents: 'auto', opacity: '0',
    transition: 'opacity 0.2s ease', lineHeight: '1.4',
    wordBreak: 'break-word',
  });
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  const remove = () => {
    el.style.opacity = '0';
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  };
  el.addEventListener('click', remove);
  setTimeout(remove, type === 'error' ? 6000 : 3500);
}
