// Pure utility helpers — no trialState access, no DOM side-effects.

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function trialFormatDt(value) {
  if (!value) return '—';
  return String(value).replace('T', ' ').slice(0, 16);
}

function trialParseVisualDateTime(value) {
  if (!value) return null;
  const text = String(value).replace(' ', 'T');
  const dt = new Date(text);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function trialSplitPsId(value) {
  const raw = String(value || '').trim();
  if (!raw) return { base: '', partial: '' };
  const parts = raw.split('::');
  return { base: parts[0] || raw, partial: parts[1] || '' };
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
  return { start: trialTodayLocal(), end: '' };
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

function trialDefaultProfileNameForDate(dateText) {
  const d = new Date(`${dateText || trialTodayLocal()}T00:00:00`);
  const weekday = d.getDay();
  if (weekday === 0) return 'OFF';
  if (weekday === 6) return 'SATURDAY';
  return 'NORMAL_DAY_NIGHT';
}

function trialPayloadToAttr(payload) {
  return escapeHtml(JSON.stringify(payload || {}));
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
