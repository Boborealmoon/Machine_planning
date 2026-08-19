/**
 * MPP planner — pallets from drags, anchor queue, bulk schedule.
 */
(function mppPlannerInit() {
  'use strict';

  const FALLBACK_MACHINES = [
    { id: 'cnc35', code: 'CNC 35', category: 'MPP', shift: '24HR' },
    { id: 'cnc36', code: 'CNC 36', category: 'MPP', shift: '24HR' },
    { id: 'cnc41', code: 'CNC 41', category: 'MPP', shift: 'STANDARD' },
  ];

  let MACHINES = FALLBACK_MACHINES.map((m) => ({ ...m }));

  const MACHINE_FILTER_STORAGE_KEY = 'mpp-planner-hidden-machines';
  const MPP_SHOW_COMPLETED_KEY = 'mpp-planner-show-completed';
  const MPP_FA_ONLY_KEY = 'mpp-planner-fa-only';
  const MPP_SIDEBAR_COLLAPSED_KEY = 'mpp-planner-sidebar-collapsed';
  const MPP_EXTRA_COLLAPSED_KEY = 'mpp-planner-extra-collapsed';
  const DEFAULT_HIDDEN_MACHINE_IDS = ['cnc41'];

  /** Match planning/machines.py — day 08:30–20:00, night 20:00–08:30 next day.
   *  Saturday day is unmanned; Fri 20:00 → Sat 08:30 night spill is valid. */
  const MPP_DAY_START_MIN = 8 * 60 + 30;
  const MPP_DAY_END_MIN = 20 * 60;
  /** Load/unload once per unattended cycle (after pallets finish), not per pallet. */
  const MPP_DEFAULT_LOAD_MIN_PER_CYCLE = 15;
  const MPP_DEFAULT_UNLOAD_MIN_PER_CYCLE = 15;
  const MPP_SHIFT_META = {
    day: { label: 'Day', window: '08:30–20:00' },
    night: { label: 'Night', window: '20:00–08:30' },
  };
  /** Debounced autosave delay after the last queue edit. */
  const QUEUE_SAVE_DEBOUNCE_MS = 600;
  /** Retry failed queue saves; also flush if still pending while idle. */
  const QUEUE_SAVE_RETRY_MS = 5000;
  const QUEUE_SAVE_IDLE_FLUSH_MS = 30000;
  /** Debounced segment recalc after a fast autosave (no inline recalculate). */
  const QUEUE_RECALC_DEBOUNCE_MS = 8000;

  function loadHiddenMachineIds() {
    try {
      const raw = localStorage.getItem(MACHINE_FILTER_STORAGE_KEY);
      if (raw === null) return new Set(DEFAULT_HIDDEN_MACHINE_IDS);
      const parsed = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.map((id) => String(id)) : []);
    } catch {
      return new Set(DEFAULT_HIDDEN_MACHINE_IDS);
    }
  }

  let hiddenMachineIds = loadHiddenMachineIds();

  function loadMppShowCompleted() {
    try {
      return localStorage.getItem(MPP_SHOW_COMPLETED_KEY) === '1';
    } catch {
      return false;
    }
  }

  let mppShowCompleted = loadMppShowCompleted();

  function loadMppFaOnly() {
    try {
      const raw = localStorage.getItem(MPP_FA_ONLY_KEY);
      // Default on: FA-only pool (legacy behaviour).
      if (raw === null) return true;
      return raw === '1';
    } catch {
      return true;
    }
  }

  let mppFaOnly = loadMppFaOnly();

  function loadSidebarCollapsed() {
    try {
      const raw = localStorage.getItem(MPP_SIDEBAR_COLLAPSED_KEY);
      if (raw === null) return true;
      return raw === '1';
    } catch {
      return true;
    }
  }

  let mppSidebarCollapsed = loadSidebarCollapsed();

  function loadExtraCollapsed() {
    try {
      const raw = localStorage.getItem(MPP_EXTRA_COLLAPSED_KEY);
      // Default collapsed until the user opens Extra or picks a PS/op.
      if (raw === null) return true;
      return raw === '1';
    } catch {
      return true;
    }
  }

  let mppExtraCollapsed = loadExtraCollapsed();
  let extraPsId = '';
  let extraJobId = '';
  let extraDraft = null;

  function syncSidebarCollapsedUi() {
    const page = document.querySelector('.mpp-page');
    const panel = document.getElementById('mpp-ops-panel');
    const btn = document.getElementById('mpp-toggle-ops-pool');
    if (page) page.classList.toggle('mpp-page--sidebar-collapsed', mppSidebarCollapsed);
    if (panel) panel.hidden = mppSidebarCollapsed;
    if (btn) {
      btn.setAttribute('aria-pressed', mppSidebarCollapsed ? 'false' : 'true');
      btn.textContent = mppSidebarCollapsed ? 'Show op pool' : 'Hide op pool';
    }
  }

  function syncExtraCollapsedUi() {
    const page = document.querySelector('.mpp-page');
    const panel = document.getElementById('mpp-extra-panel');
    const btn = document.getElementById('mpp-toggle-extra');
    if (page) page.classList.toggle('mpp-page--extra-open', !mppExtraCollapsed);
    if (panel) panel.hidden = mppExtraCollapsed;
    if (btn) {
      btn.setAttribute('aria-pressed', mppExtraCollapsed ? 'false' : 'true');
      btn.textContent = mppExtraCollapsed ? 'Extra' : 'Hide Extra';
    }
  }

  function setExtraCollapsed(collapsed) {
    mppExtraCollapsed = Boolean(collapsed);
    try {
      localStorage.setItem(MPP_EXTRA_COLLAPSED_KEY, mppExtraCollapsed ? '1' : '0');
    } catch { /* ignore */ }
    syncExtraCollapsedUi();
  }

  function toggleExtraCollapsed() {
    setExtraCollapsed(!mppExtraCollapsed);
    if (!mppExtraCollapsed) renderExtraPanel();
  }

  function toggleSidebarCollapsed() {
    mppSidebarCollapsed = !mppSidebarCollapsed;
    try {
      localStorage.setItem(MPP_SIDEBAR_COLLAPSED_KEY, mppSidebarCollapsed ? '1' : '0');
    } catch { /* ignore */ }
    syncSidebarCollapsedUi();
  }

  function saveHiddenMachineIds() {
    localStorage.setItem(MACHINE_FILTER_STORAGE_KEY, JSON.stringify([...hiddenMachineIds]));
  }

  function visibleMachines() {
    return MACHINES.filter((machine) => !hiddenMachineIds.has(machine.id));
  }

  function isMachineVisible(machineId) {
    return !hiddenMachineIds.has(machineId);
  }

  function toggleMachineVisibility(machineId) {
    if (!machineId) return;
    if (hiddenMachineIds.has(machineId)) hiddenMachineIds.delete(machineId);
    else hiddenMachineIds.add(machineId);
    saveHiddenMachineIds();
    renderMachineFilters();
    renderLanes();
  }

  let JOB_TEMPLATES = [];
  /** True once the in-memory pool includes non-FA jobs (full fetch). */
  let jobsPoolIncludesNonFa = false;
  let jobsSource = 'loading';
  let jobsLoadError = '';
  let frameAgreementPartCount = 0;
  let jobsFetchedAt = '';
  let mppOpsSearch = '';
  let mppOpsSearchTimer = null;
  let queueManagerMachineId = null;
  let cycleRunModal = null;
  let cycleDetailModalCycleId = null;
  let cycleAddOpModalCycleId = null;
  let cycleAddOpSearch = '';
  let reviewModalCycleId = null;
  const MPP_CYCLE_EXPANDED_KEY = 'mpp-planner-expanded-cycles';
  const MPP_CYCLE_COLLAPSED_KEY = 'mpp-planner-collapsed-cycles';
  const MPP_CYCLE_RUN_EXPANDED_KEY = 'mpp-planner-expanded-runs';

  /** PS groups the user expanded this session — default collapsed on each page load. */
  function mppPsExpandedSet() {
    if (!window._mppPsExpanded) {
      window._mppPsExpanded = new Set();
    }
    return window._mppPsExpanded;
  }

  function syncMppPsExpandedFromDom(root = document.getElementById('mpp-ops-list')) {
    if (!root) return;
    const set = mppPsExpandedSet();
    root.querySelectorAll('details.mpp-ps-group[data-ps-id]').forEach((el) => {
      const psId = compactText(el.dataset.psId);
      if (!psId) return;
      if (el.open) set.add(psId);
      else set.delete(psId);
    });
  }

  function mppExpandedCycleSet() {
    if (!window._mppExpandedCycles) {
      try {
        const raw = localStorage.getItem(MPP_CYCLE_EXPANDED_KEY);
        window._mppExpandedCycles = new Set(Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : []);
      } catch {
        window._mppExpandedCycles = new Set();
      }
    }
    return window._mppExpandedCycles;
  }

  function saveMppExpandedCycles() {
    localStorage.setItem(MPP_CYCLE_EXPANDED_KEY, JSON.stringify([...mppExpandedCycleSet()]));
  }

  function mppCollapsedCycleSet() {
    if (!window._mppCollapsedCycles) {
      try {
        const raw = localStorage.getItem(MPP_CYCLE_COLLAPSED_KEY);
        window._mppCollapsedCycles = new Set(Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : []);
      } catch {
        window._mppCollapsedCycles = new Set();
      }
    }
    return window._mppCollapsedCycles;
  }

  function saveMppCollapsedCycles() {
    localStorage.setItem(MPP_CYCLE_COLLAPSED_KEY, JSON.stringify([...mppCollapsedCycleSet()]));
  }

  function mppExpandedRunSet() {
    if (!window._mppExpandedRuns) {
      try {
        const raw = localStorage.getItem(MPP_CYCLE_RUN_EXPANDED_KEY);
        window._mppExpandedRuns = new Set(Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : []);
      } catch {
        window._mppExpandedRuns = new Set();
      }
    }
    return window._mppExpandedRuns;
  }

  function saveMppExpandedRuns() {
    localStorage.setItem(MPP_CYCLE_RUN_EXPANDED_KEY, JSON.stringify([...mppExpandedRunSet()]));
  }

  function runExpandKey(machineId, fingerprint, runKey) {
    return `${compactText(machineId)}::${compactText(fingerprint)}::${compactText(runKey)}`;
  }

  function isRunExpanded(machineId, fingerprint, runKey) {
    return mppExpandedRunSet().has(runExpandKey(machineId, fingerprint, runKey));
  }

  function toggleCycleRunExpanded(machineId, fingerprint, runKey) {
    if (!machineId || !fingerprint || !runKey) return;
    const key = runExpandKey(machineId, fingerprint, runKey);
    const set = mppExpandedRunSet();
    if (set.has(key)) set.delete(key);
    else set.add(key);
    saveMppExpandedRuns();
    renderLanes();
  }

  function isCycleExpanded(cycleId, idx) {
    if (mppCollapsedCycleSet().has(cycleId)) return false;
    if (idx === 0) return true;
    return mppExpandedCycleSet().has(cycleId);
  }

  function cycleFingerprint(cycle) {
    const shift = compactText(cycle.shift).toLowerCase() === 'day' ? 'day' : 'night';
    const ops = (cycle.ops || [])
      .map((row) => {
        const job = getJob(row.jobId);
        const pcs = opPcsPerPallet(row, job);
        return `${row.jobId}:${row.palletCount || 1}x${pcs}`;
      })
      .sort()
      .join('|');
    return `${shift}::${ops}`;
  }

  function groupIdenticalCycleRuns(scheduled) {
    const runs = [];
    scheduled.forEach((item) => {
      const fp = cycleFingerprint(item.cycle);
      const tail = runs[runs.length - 1];
      if (tail && tail.fingerprint === fp) {
        tail.items.push(item);
      } else {
        runs.push({ fingerprint: fp, items: [item] });
      }
    });
    return runs;
  }

  function jobDisplayLabel(job, { palletSuffix = '' } = {}) {
    if (!job) return 'Unknown job';
    const ps = compactText(job.psId || job.sourcePsId);
    const op = compactText(job.opLabel || (job.opNo ? `OP${job.opNo}` : ''));
    const base = [ps, op].filter(Boolean).join(' ') || compactText(job.jobId) || 'Unknown job';
    return `${base}${palletSuffix || ''}`;
  }

  function cycleOpsSummary(cycle) {
    const metrics = cycleMetrics(cycle);
    if (!metrics.rows.length) return 'Empty cycle';
    return metrics.rows
      .map(({ row, job }) => {
        const pal = row.palletCount > 1 ? ` ×${row.palletCount}pal` : '';
        return jobDisplayLabel(job, { palletSuffix: pal });
      })
      .join(' · ');
  }

  function cycleOpsPillsHtml(cycle) {
    const metrics = cycleMetrics(cycle);
    if (!metrics.rows.length) {
      return '<span class="mpp-collapsed-op-pill mpp-collapsed-op-pill--empty">Empty cycle</span>';
    }
    return metrics.rows
      .map(({ row, job }) => {
        const pal = row.palletCount > 1 ? ` ×${row.palletCount}pal` : '';
        const label = jobDisplayLabel(job, { palletSuffix: pal });
        return `<span class="mpp-collapsed-op-pill">${escapeHtml(label)}</span>`;
      })
      .join('');
  }

  function renderCycleOpenBtn(cycleId, { compact = false } = {}) {
    return `<button type="button" class="mpp-cycle-expand${compact ? ' mpp-cycle-expand--sm' : ''}"
      data-action="open-cycle" data-cycle-id="${escapeHtml(cycleId)}"
      title="Open cycle details" aria-label="Open cycle details">▸</button>`;
  }

  function mppPsDueClass(due) {
    const raw = compactText(due).slice(0, 10);
    if (!raw) return '';
    const ts = new Date(`${raw}T00:00:00`).getTime();
    if (Number.isNaN(ts)) return '';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((ts - today.getTime()) / 86400000);
    if (diff < 0) return 'overdue';
    if (diff <= 7) return 'due-soon';
    return '';
  }

  function mppJobSearchBlob(job) {
    return [
      job.psId,
      job.partNo,
      job.partDesc,
      job.opLabel,
      job.preferredMachine,
      job.bomCode,
    ].map((v) => compactText(v).toLowerCase()).filter(Boolean).join(' ');
  }

  function mppGroupSearchBlob(group) {
    const jobBlobs = group.jobs.map((j) => mppJobSearchBlob(j));
    return [group.psId, group.partNo, group.partDesc, ...jobBlobs]
      .map((v) => compactText(v).toLowerCase())
      .filter(Boolean)
      .join(' ');
  }

  function mppQueryMatchesBlob(blob, query) {
    const q = compactText(query).toLowerCase();
    if (!q) return true;
    return blob.includes(q);
  }

  function mppPsBaseId(psId) {
    const raw = compactText(psId);
    const idx = raw.indexOf('::');
    return idx >= 0 ? raw.slice(0, idx) : raw;
  }

  function groupPoolJobs(pool) {
    const groups = new Map();
    pool.forEach((job) => {
      const key = compactText(job.psId) || job.jobId;
      if (!groups.has(key)) {
        groups.set(key, {
          psId: key,
          partNo: job.partNo || '',
          partDesc: job.partDesc || '',
          due: job.due || '',
          sourcePsId: job.sourcePsId || mppPsBaseId(key),
          ppPartialNo: Number(job.ppPartialNo) || 1,
          bomCode: job.bomCode || '',
          erpBomCode: job.erpBomCode || '',
          bomStageStatus: job.bomStageStatus || '',
          partialQty: Number(job.partialQty) || 0,
          totalQty: Number(job.totalQty) || 0,
          currentStageDesc: job.currentStageDesc || '',
          currentStageStatus: job.currentStageStatus || '',
          materialIn: job.materialIn === true,
          sourceVoucher: job.sourceVoucher || '',
          plannerStatus: job.plannerStatus || '',
          inventoryCode: job.inventoryCode || job.partNo || '',
          jobs: [],
        });
      }
      groups.get(key).jobs.push(job);
    });
    return [...groups.values()]
      .map((group) => {
        group.jobs.sort((a, b) => String(a.opLabel).localeCompare(String(b.opLabel)));
        return group;
      })
      .sort((a, b) => {
        const da = compactText(a.due).slice(0, 10) || '9999-12-31';
        const db = compactText(b.due).slice(0, 10) || '9999-12-31';
        if (da !== db) return da.localeCompare(db);
        return String(a.psId).localeCompare(String(b.psId));
      });
  }

  function mppPsGroupById(psId) {
    const key = compactText(psId);
    if (!key) return null;
    return groupPoolJobs(JOB_TEMPLATES).find((group) => group.psId === key) || null;
  }

  function mppBomStageBadgeHtml(status, partNo, erpBom) {
    const key = compactText(status).toLowerCase();
    if (!key) return '';
    const labels = {
      ok: 'Matches bom_op_stage',
      planner_mismatch: 'Planner BOM differs from ERP',
      not_in_stage: 'Not in bom_op_stage',
      missing_erp: 'No ERP BOM on voucher',
    };
    const label = labels[key] || key;
    const inv = compactText(partNo);
    const erp = compactText(erpBom);
    return `<span class="trial-bom-stage-badge is-${escapeHtml(key)}" title="${escapeHtml(`${inv} + ${erp || '?'}`)}">${escapeHtml(label)}</span>`;
  }

  function mppDetailRow(label, valueHtml) {
    if (!valueHtml) return '';
    return `<div class="trial-op-detail-row"><dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd></div>`;
  }

  function mppFmtQty(n) {
    const value = Number(n || 0);
    if (!Number.isFinite(value) || value <= 0) return '';
    return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function mppErpAcceptedQty(job) {
    return Math.max(0, Number(job?.erpFinished ?? job?.out ?? 0));
  }

  function mppOpQtyLine(job, { schedulable, rem, queued }) {
    const erpAcc = mppErpAcceptedQty(job);
    const qtyParts = [`Rem <strong>${schedulable ? rem : 0}</strong> pc`];
    qtyParts.push(`ERP acc <strong>${erpAcc}</strong>`);
    if (!schedulable) {
      if (job.requiredQty) qtyParts.push(`WO ${job.requiredQty}`);
      if (job.plannedQty) qtyParts.push(`Planner ${job.plannedQty}`);
    } else {
      if (job.qty) qtyParts.push(`Qty ${job.qty}`);
      const out = Math.max(0, Number(job.out || 0));
      if (out > 0 && out !== erpAcc) qtyParts.push(`Out ${out}`);
      if (queued > 0) qtyParts.push(`Queued ${queued}`);
    }
    return qtyParts.join(' · ');
  }

  function renderMppPsDetailBody(group) {
    const basePs = mppPsBaseId(group.psId);
    const partial = compactText(group.psId).includes('::')
      ? compactText(group.psId).split('::')[1]
      : (Number(group.ppPartialNo) > 1 ? String(group.ppPartialNo) : '');
    const partLine = [group.partNo, group.partDesc].filter(Boolean).map((v) => escapeHtml(v)).join(' · ');
    const materialLabel = group.materialIn ? 'Material in' : 'Material not in';
    const materialClass = group.materialIn ? 'mpp-ps-detail-pill--yes' : 'mpp-ps-detail-pill--no';
    const stageDesc = compactText(group.currentStageDesc);
    const stageStatus = compactText(group.currentStageStatus);
    const bomBadge = mppBomStageBadgeHtml(group.bomStageStatus, group.inventoryCode || group.partNo, group.erpBomCode);
    const opsHtml = group.jobs.map((job) => {
      const live = getJob(job.jobId) || job;
      const schedulable = jobIsSchedulable(live);
      const rem = jobRemaining(job.jobId);
      const erpAcc = mppErpAcceptedQty(live);
      const status = schedulable
        ? `Rem ${rem} pc · ERP acc ${erpAcc}`
        : [
          escapeHtml(live.blockedReason || 'Not schedulable'),
          erpAcc > 0 ? `ERP acc ${erpAcc}` : '',
          live.requiredQty ? `WO ${live.requiredQty}` : '',
        ].filter(Boolean).join(' · ');
      return `
        <div class="mpp-ps-detail-op${schedulable ? '' : ' mpp-ps-detail-op--blocked'}">
          <span class="mpp-ps-detail-op-label">${escapeHtml(live.opLabel)}</span>
          <span class="mpp-ps-detail-op-meta">${status}</span>
        </div>
      `;
    }).join('');
    return `
      <div class="trial-op-detail">
        <div class="trial-op-detail-head">
          <div class="trial-op-detail-title">${escapeHtml(basePs)}</div>
          ${partial ? `<div class="trial-op-detail-sub">Partial ${escapeHtml(partial)}</div>` : ''}
          <div class="trial-op-detail-badges">
            <span class="mpp-ps-detail-pill ${materialClass}">${escapeHtml(materialLabel)}</span>
            ${stageDesc ? `<span class="ps-stage-badge" title="${escapeHtml(stageDesc)}">${escapeHtml(stageDesc)}</span>` : ''}
            ${bomBadge}
          </div>
        </div>
        <dl class="trial-op-detail-grid">
          ${partLine ? mppDetailRow('Part', partLine) : ''}
          ${group.due ? mppDetailRow('Due', escapeHtml(compactText(group.due).slice(0, 10))) : ''}
          ${mppFmtQty(group.partialQty) ? mppDetailRow('Partial qty', escapeHtml(mppFmtQty(group.partialQty))) : ''}
          ${mppFmtQty(group.totalQty) && group.totalQty !== group.partialQty
    ? mppDetailRow('Total qty', escapeHtml(mppFmtQty(group.totalQty))) : ''}
          ${group.bomCode ? mppDetailRow('Planner BOM', escapeHtml(group.bomCode)) : ''}
          ${group.erpBomCode && group.erpBomCode !== group.bomCode
    ? mppDetailRow('ERP BOM', escapeHtml(group.erpBomCode)) : ''}
          ${group.inventoryCode ? mppDetailRow('Inventory', escapeHtml(group.inventoryCode)) : ''}
          ${group.sourceVoucher ? mppDetailRow('SO voucher', escapeHtml(group.sourceVoucher)) : ''}
          ${stageStatus ? mppDetailRow('ERP stage status', escapeHtml(stageStatus)) : ''}
          ${group.plannerStatus ? mppDetailRow('Planner status', escapeHtml(group.plannerStatus)) : ''}
        </dl>
        <div class="trial-op-detail-section">
          <div class="trial-op-detail-section-title">MPP operations</div>
          <div class="mpp-ps-detail-op-list">${opsHtml || '<div class="mpp-ops-empty">No MPP ops on this partial.</div>'}</div>
        </div>
      </div>
    `;
  }

  function openMppPsDetailModal(psId) {
    const group = mppPsGroupById(psId);
    const modal = document.getElementById('mpp-ps-detail-modal');
    const body = document.getElementById('mpp-ps-detail-modal-body');
    const title = document.getElementById('mpp-ps-detail-modal-title');
    if (!group || !modal || !body || !title) return;
    const basePs = mppPsBaseId(group.psId);
    const partial = compactText(group.psId).includes('::')
      ? compactText(group.psId).split('::')[1]
      : (Number(group.ppPartialNo) > 1 ? String(group.ppPartialNo) : '');
    title.textContent = [basePs, partial ? `Partial ${partial}` : ''].filter(Boolean).join(' · ');
    body.innerHTML = renderMppPsDetailBody(group);
    modal.hidden = false;
  }

  function closeMppPsDetailModal() {
    const modal = document.getElementById('mpp-ps-detail-modal');
    if (modal) modal.hidden = true;
  }

  function extraDraftFromJob(job) {
    return {
      palletsPerCycle: Math.max(1, Number(job?.defaultPalletsPerCycle) || 3),
      pcsPerPallet: Math.max(1, Number(job?.pcsPerPallet) || 1),
      minPerPallet: Math.max(0.1, Number(job?.minPerPallet) || 1),
      loadMinPerCycle: Math.max(0, Number(job?.loadMinPerCycle ?? job?.loadMinPerPallet) || MPP_DEFAULT_LOAD_MIN_PER_CYCLE),
      unloadMinPerCycle: Math.max(0, Number(job?.unloadMinPerCycle ?? job?.unloadMinPerPallet) || MPP_DEFAULT_UNLOAD_MIN_PER_CYCLE),
    };
  }

  function readExtraDraftFromDom() {
    if (!extraDraft) return null;
    const pal = Number(document.getElementById('mpp-extra-pallets')?.value);
    const pcs = Number(document.getElementById('mpp-extra-pcs')?.value);
    const min = Number(document.getElementById('mpp-extra-min')?.value);
    const load = Number(document.getElementById('mpp-extra-load')?.value);
    const unload = Number(document.getElementById('mpp-extra-unload')?.value);
    return {
      palletsPerCycle: Number.isFinite(pal) && pal > 0 ? pal : extraDraft.palletsPerCycle,
      pcsPerPallet: Number.isFinite(pcs) && pcs > 0 ? pcs : extraDraft.pcsPerPallet,
      minPerPallet: Number.isFinite(min) && min > 0 ? min : extraDraft.minPerPallet,
      loadMinPerCycle: Number.isFinite(load) && load >= 0 ? load : extraDraft.loadMinPerCycle,
      unloadMinPerCycle: Number.isFinite(unload) && unload >= 0 ? unload : extraDraft.unloadMinPerCycle,
    };
  }

  function pickDefaultExtraJobId(group) {
    if (!group?.jobs?.length) return '';
    const schedulable = group.jobs.find((j) => jobIsSchedulable(getJob(j.jobId)));
    return (schedulable || group.jobs[0]).jobId;
  }

  function openExtraForPs(psId, preferredJobId = '') {
    const group = mppPsGroupById(psId);
    if (!group) return;
    extraPsId = group.psId;
    const jobId = preferredJobId && group.jobs.some((j) => j.jobId === preferredJobId)
      ? preferredJobId
      : pickDefaultExtraJobId(group);
    const job = getJob(jobId);
    if (!job) return;
    extraJobId = job.jobId;
    extraDraft = extraDraftFromJob(job);
    setExtraCollapsed(false);
    renderExtraPanel();
    renderOpsList();
  }

  function openExtraForJob(jobId) {
    const job = getJob(jobId);
    if (!job) return;
    openExtraForPs(job.psId, job.jobId);
  }

  function clearExtraSelection() {
    extraPsId = '';
    extraJobId = '';
    extraDraft = null;
    renderExtraPanel();
    renderOpsList();
  }

  function updateExtraPreview() {
    const job = getJob(extraJobId);
    const results = document.getElementById('mpp-extra-results');
    if (!job || !results || !extraDraft) return;
    extraDraft = readExtraDraftFromDom() || extraDraft;
    const rem = jobRemaining(job.jobId);
    const pal = Math.max(1, Number(extraDraft.palletsPerCycle) || 1);
    const pcs = Math.max(1, Number(extraDraft.pcsPerPallet) || 1);
    const minPal = Math.max(0.1, Number(extraDraft.minPerPallet) || 1);
    const load = Math.max(0, Number(extraDraft.loadMinPerCycle) || 0);
    const unload = Math.max(0, Number(extraDraft.unloadMinPerCycle) || 0);
    const output = pal * pcs;
    const runMin = pal * minPal;
    const cycleMin = load + runMin + unload;
    const plan = planBulkScheduleCycles(rem, rem, pal, pcs);
    const cycleCount = plan.cycles.length;
    const partialNote = plan.partialPcs > 0
      ? ` · includes 1 partial pallet (${plan.partialPcs} pc)`
      : '';
    results.innerHTML = `
      <div class="mpp-extra-kpi">
        <span class="mpp-extra-kpi-label">Expected output / cycle</span>
        <span class="mpp-extra-kpi-value">${output} pc</span>
      </div>
      <div class="mpp-extra-kpi">
        <span class="mpp-extra-kpi-label">Expected cycle time</span>
        <span class="mpp-extra-kpi-value">${fmtMinutes(cycleMin)}</span>
      </div>
      <div class="mpp-extra-kpi">
        <span class="mpp-extra-kpi-label">Run only (excl. load/unload)</span>
        <span class="mpp-extra-kpi-value">${fmtMinutes(runMin)}</span>
      </div>
      <div class="mpp-extra-meta">
        ${cycleCount
    ? `<strong>${cycleCount}</strong> cycle box${cycleCount === 1 ? '' : 'es'} to clear rem · <strong>${plan.scheduledPcs}</strong> pc queued${partialNote}`
    : 'Nothing left to schedule for this rem.'}
      </div>
    `;
  }

  function renderExtraPanel() {
    const body = document.getElementById('mpp-extra-body');
    if (!body) return;
    syncExtraCollapsedUi();
    if (!extraJobId || !extraDraft) {
      body.innerHTML = '<p class="mpp-extra-empty">Select a PS or op to preview 1-cycle output.</p>';
      return;
    }
    const job = getJob(extraJobId);
    const group = mppPsGroupById(extraPsId) || mppPsGroupById(job?.psId);
    if (!job || !group) {
      body.innerHTML = '<p class="mpp-extra-empty">Selected job is no longer in the pool. Pick another PS or op.</p>';
      return;
    }
    const rem = jobRemaining(job.jobId);
    const opOpts = group.jobs.map((row) => {
      const live = getJob(row.jobId) || row;
      const selected = live.jobId === job.jobId ? ' selected' : '';
      const tag = jobIsSchedulable(live) ? '' : ' (blocked)';
      return `<option value="${escapeHtml(live.jobId)}"${selected}>${escapeHtml(live.opLabel)}${tag}</option>`;
    }).join('');
    const partLine = [job.partNo, job.partDesc].filter(Boolean).join(' · ');
    body.innerHTML = `
      <div class="mpp-extra-summary">
        <div><strong>${escapeHtml(job.psId)}</strong></div>
        ${partLine ? `<div class="mpp-extra-meta">${escapeHtml(partLine)}</div>` : ''}
        <div class="mpp-extra-meta">Rem <strong>${rem}</strong> pc · ${fmtMinutes(job.minPerPallet)} run/pal · ${job.pcsPerPallet} pc/pal default</div>
      </div>
      <label class="mpp-form-full">MPP operation
        <select id="mpp-extra-op">${opOpts}</select>
      </label>
      <div class="mpp-form-grid">
        <label>Pallets / cycle<input id="mpp-extra-pallets" type="number" min="1" step="1" value="${extraDraft.palletsPerCycle}"></label>
        <label>Pcs / pallet<input id="mpp-extra-pcs" type="number" min="1" step="1" value="${extraDraft.pcsPerPallet}"></label>
        <label>Run min / pallet<input id="mpp-extra-min" type="number" min="0.1" step="1" value="${extraDraft.minPerPallet}"></label>
        <label>Load min<input id="mpp-extra-load" type="number" min="0" step="1" value="${extraDraft.loadMinPerCycle}"></label>
        <label>Unload min<input id="mpp-extra-unload" type="number" min="0" step="1" value="${extraDraft.unloadMinPerCycle}"></label>
      </div>
      <div class="mpp-extra-results" id="mpp-extra-results" aria-live="polite"></div>
      <div class="mpp-extra-actions">
        <button type="button" class="btn btn-primary btn-sm" id="mpp-extra-schedule"
          ${jobIsSchedulable(job) && rem > 0 ? '' : ' disabled'}
          title="${jobIsSchedulable(job) ? 'Open Schedule to MPP with these values' : 'Job is not schedulable'}">Schedule…</button>
        <button type="button" class="btn btn-ghost btn-sm" id="mpp-extra-clear">Clear</button>
      </div>
    `;
    body.querySelector('#mpp-extra-op')?.addEventListener('change', (e) => {
      const nextId = e.target.value;
      const nextJob = getJob(nextId);
      if (!nextJob) return;
      extraJobId = nextJob.jobId;
      extraDraft = extraDraftFromJob(nextJob);
      renderExtraPanel();
      renderOpsList();
    });
    body.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', updateExtraPreview);
    });
    body.querySelector('#mpp-extra-schedule')?.addEventListener('click', () => {
      extraDraft = readExtraDraftFromDom() || extraDraft;
      openScheduleModal(extraJobId, defaultMachineId(), extraDraft);
    });
    body.querySelector('#mpp-extra-clear')?.addEventListener('click', clearExtraSelection);
    updateExtraPreview();
  }

  function psStageIsOpen(job) {
    const st = compactText(job?.currentStageStatus).toUpperCase();
    if (!st) return true;
    return !['C', 'COMPLETED', 'DONE', 'X', 'CANCELLED', 'CLOSED'].includes(st);
  }

  function psGroupHasOpenStage(group) {
    return group.jobs.some((j) => psStageIsOpen(getJob(j.jobId)));
  }

  function psGroupSchedulableCount(group) {
    return group.jobs.filter((j) => jobIsSchedulable(getJob(j.jobId))).length;
  }

  /** No MPP qty left to schedule on any op in this partial. */
  function psGroupIsAccounted(group) {
    return group.jobs.length > 0 && psGroupSchedulableCount(group) === 0;
  }

  function psGroupIsCompleted(group) {
    return psGroupIsAccounted(group);
  }

  /** Grey header only when the PS itself looks finished — not just MPP ops accounted. */
  function psGroupVisualCompleted(group) {
    if (!psGroupIsAccounted(group)) return false;
    if (psGroupHasOpenStage(group)) return false;
    const sample = getJob(group.jobs[0]?.jobId);
    const shipped = Number(sample?.partialQty || sample?.totalQty || 0);
    const qtyShipped = Number(sample?.qtyShipped);
    if (shipped > 0 && Number.isFinite(qtyShipped) && qtyShipped < shipped) return false;
    return true;
  }

  function psGroupStatusLabel(group) {
    const opCount = group.jobs.length;
    const schedulable = psGroupSchedulableCount(group);
    if (schedulable > 0) {
      return schedulable < opCount
        ? `${opCount} ops · ${schedulable} sched`
        : `${opCount} op${opCount === 1 ? '' : 's'}`;
    }
    const reasons = [...new Set(
      group.jobs.map((j) => compactText(getJob(j.jobId)?.blockedReason)).filter(Boolean),
    )];
    if (reasons.length === 1 && reasons[0] === 'Fully on MPP queue') {
      return `${opCount} ops · on queue`;
    }
    if (psGroupHasOpenStage(group)) {
      return `${opCount} ops · MPP accounted`;
    }
    return `${opCount} op${opCount === 1 ? '' : 's'} · done`;
  }

  function syncShowCompletedToggle() {
    const el = document.getElementById('mpp-show-completed');
    const label = document.getElementById('mpp-show-completed-label');
    if (!el) return;
    el.checked = mppShowCompleted;
    if (!label) return;
    const accounted = groupPoolJobs(poolJobTemplates()).filter(psGroupIsAccounted).length;
    label.textContent = accounted ? `Show accounted (${accounted})` : 'Show accounted';
  }

  function syncFaOnlyToggle() {
    const el = document.getElementById('mpp-fa-only');
    const label = document.getElementById('mpp-fa-only-label');
    if (el) el.checked = mppFaOnly;
    if (!label) return;
    const faCount = JOB_TEMPLATES.filter((j) => j.isFrameAgreement).length;
    const otherCount = JOB_TEMPLATES.length - faCount;
    if (mppFaOnly && otherCount > 0) {
      label.textContent = `FA parts only (${otherCount} other hidden)`;
    } else {
      label.textContent = 'FA parts only';
    }
  }

  function renderPsGroupSummary(group) {
    const due = compactText(group.due).slice(0, 10) || 'No due date';
    const partLine = group.partNo
      ? `<div class="mpp-ps-part" title="${escapeHtml(group.partDesc || group.partNo)}">${escapeHtml(group.partNo)}</div>`
      : '';
    const descLine = group.partDesc
      ? `<div class="mpp-ps-desc" title="${escapeHtml(group.partDesc)}">${escapeHtml(group.partDesc)}</div>`
      : '';
    const countLabel = psGroupStatusLabel(group);
    const infoBtn = `<button type="button" class="trial-catalog-info-btn mpp-ps-info-btn"
      data-action="ps-detail" data-ps-id="${escapeHtml(group.psId)}"
      aria-label="View process sheet details" title="PS details — material, BOM, stage"></button>`;
    const calcBtn = `<button type="button" class="mpp-ps-calc-btn"
      data-action="extra-calc" data-ps-id="${escapeHtml(group.psId)}"
      aria-label="Open Extra cycle calculator" title="1-cycle output for this PS">Calc</button>`;
    return `
      <div class="trial-catalog-ps-main">
        <div class="mpp-ps-id-row">
          <div class="trial-catalog-ps-id">${escapeHtml(group.psId)}</div>
          ${calcBtn}
          ${infoBtn}
        </div>
        ${partLine}
        ${descLine}
        <span class="mpp-ps-op-count">${countLabel}</span>
      </div>
      <div class="trial-catalog-ps-right">
        <span class="trial-catalog-ps-meta trial-catalog-ps-date">${escapeHtml(due)}</span>
      </div>
    `;
  }

  function renderPsGroup(group, { forceOpen = false } = {}) {
    const dueClass = mppPsDueClass(group.due);
    const accountedClass = psGroupIsAccounted(group) ? ' mpp-ps-group--accounted' : '';
    const completedClass = psGroupVisualCompleted(group) ? ' mpp-ps-group--completed' : '';
    const searchBlob = mppGroupSearchBlob(group);
    const isOpen = forceOpen || mppPsExpandedSet().has(group.psId);
    const selectedClass = group.psId === extraPsId ? ' is-extra-selected' : '';
    const opCards = group.jobs.map((job) => renderOpPool(getJob(job.jobId), { compact: true })).join('');
    return `
      <details class="trial-catalog-ps mpp-ps-group${accountedClass}${completedClass}${selectedClass} ${dueClass}" data-ps-id="${escapeHtml(group.psId)}"
        data-search="${escapeHtml(searchBlob)}"${isOpen ? ' open' : ''}>
        <summary>${renderPsGroupSummary(group)}</summary>
        <div class="trial-catalog-oplist">${opCards}</div>
      </details>
    `;
  }

  function applyMppOpsSearchFilter(query) {
    const root = document.getElementById('mpp-ops-list');
    if (!root) return;
    const q = compactText(query).toLowerCase();
    const groups = [...root.querySelectorAll('details.mpp-ps-group')];
    if (!q) {
      groups.forEach((el) => { el.hidden = false; });
      root.querySelector('.mpp-ops-search-empty')?.remove();
      return;
    }
    let anyVisible = false;
    groups.forEach((el) => {
      const blob = String(el.dataset.search || '').toLowerCase();
      const match = blob.includes(q);
      el.hidden = !match;
      if (match) {
        el.open = true;
        anyVisible = true;
      }
    });
    let emptyEl = root.querySelector('.mpp-ops-search-empty');
    if (anyVisible) {
      emptyEl?.remove();
      return;
    }
    if (!emptyEl) {
      emptyEl = document.createElement('p');
      emptyEl.className = 'mpp-ops-empty mpp-ops-search-empty';
      root.appendChild(emptyEl);
    }
    emptyEl.textContent = 'No process sheets or ops match this search.';
  }

  function scheduleMppOpsSearchRender() {
    clearTimeout(mppOpsSearchTimer);
    const input = document.getElementById('mpp-ops-search');
    mppOpsSearch = compactText(input?.value);
    if (mppOpsSearch) applyMppOpsSearchFilter(mppOpsSearch);
    mppOpsSearchTimer = window.setTimeout(() => {
      mppOpsSearchTimer = null;
      renderOpsList();
    }, mppOpsSearch ? 280 : 80);
  }

  function escapeHtml(raw) {
    return String(raw ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtMinutes(totalMin) {
    const m = Math.max(0, Math.round(Number(totalMin) || 0));
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h <= 0) return `${r} min`;
    return r ? `${h} hr ${r} min` : `${h} hr`;
  }

  function parseIsoLocal(iso) {
    if (!iso) return null;
    const d = new Date(iso.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatDt(iso) {
    const d = parseIsoLocal(iso);
    if (!d) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatDateObj(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function toDatetimeLocal(iso) {
    const d = parseIsoLocal(iso);
    if (!d) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fromDatetimeLocal(val) {
    return String(val || '').trim() ? val.replace('T', ' ') : '';
  }

  function addMinutes(iso, minutes) {
    const d = parseIsoLocal(iso) || new Date();
    d.setMinutes(d.getMinutes() + Math.round(minutes));
    return formatDateObj(d);
  }

  function minuteOfDay(d) {
    return d.getHours() * 60 + d.getMinutes();
  }

  function atMinuteOnDay(baseDate, minute) {
    const d = new Date(baseDate);
    d.setHours(0, 0, 0, 0);
    d.setMinutes(Math.floor(minute));
    d.setSeconds(0, 0);
    return d;
  }

  function addCalendarDays(d, n) {
    const out = new Date(d);
    out.setDate(out.getDate() + n);
    return out;
  }

  function machineById(machineId) {
    return MACHINES.find((m) => m.id === machineId);
  }

  function machineSupportsShift(machine, shift) {
    if (shift !== 'night') return true;
    return compactText(machine?.shift).toUpperCase() === '24HR';
  }

  function defaultShiftForMachine(machine) {
    return compactText(machine?.shift).toUpperCase() === '24HR' ? 'night' : 'day';
  }

  function normalizeShift(shift, machine) {
    const raw = compactText(shift).toLowerCase();
    const pick = raw === 'day' ? 'day' : 'night';
    return machineSupportsShift(machine, pick) ? pick : 'day';
  }

  function isSunday(d) {
    return d.getDay() === 0;
  }

  function isSaturday(d) {
    return d.getDay() === 6;
  }

  /** Mon–Fri — no manned day-shift planning on Saturday or Sunday. */
  function nextDayShiftCalendarDay(d) {
    const out = new Date(d);
    while (isSaturday(out) || isSunday(out)) {
      out.setDate(out.getDate() + 1);
    }
    return out;
  }

  /** Next Mon–Fri 20:00 evening start (skips unmanned Sat/Sun). */
  function nextNightShiftEvening(d) {
    const day = nextDayShiftCalendarDay(new Date(d));
    return atMinuteOnDay(day, MPP_DAY_END_MIN);
  }

  function inNightWindow(d) {
    const m = minuteOfDay(d);
    if (isSunday(d)) return false;
    if (isSaturday(d) && m >= MPP_DAY_START_MIN) return false;
    return m >= MPP_DAY_END_MIN || m < MPP_DAY_START_MIN;
  }

  function shiftWindowEnd(startDt, shift) {
    if (shift === 'day') return atMinuteOnDay(startDt, MPP_DAY_END_MIN);
    const m = minuteOfDay(startDt);
    if (m >= MPP_DAY_END_MIN) {
      return atMinuteOnDay(addCalendarDays(startDt, 1), MPP_DAY_START_MIN);
    }
    return atMinuteOnDay(startDt, MPP_DAY_START_MIN);
  }

  function nextShiftStart(afterIso, shift, machine) {
    let d = parseIsoLocal(afterIso) || new Date();
    if (shift === 'night' && machineSupportsShift(machine, 'night')) {
      if (inNightWindow(d)) return formatDateObj(d);
      const m = minuteOfDay(d);
      if (!isSaturday(d) && !isSunday(d) && m < MPP_DAY_END_MIN) {
        return formatDateObj(atMinuteOnDay(d, MPP_DAY_END_MIN));
      }
      return formatDateObj(nextNightShiftEvening(d));
    }
    d = nextDayShiftCalendarDay(d);
    const m = minuteOfDay(d);
    if (m < MPP_DAY_START_MIN) return formatDateObj(atMinuteOnDay(d, MPP_DAY_START_MIN));
    if (m >= MPP_DAY_END_MIN) {
      const next = nextDayShiftCalendarDay(addCalendarDays(d, 1));
      return formatDateObj(atMinuteOnDay(next, MPP_DAY_START_MIN));
    }
    return formatDateObj(d);
  }

  function placeCycleInShift(startHint, durationMin, shift, machine) {
    let start = nextShiftStart(startHint, shift, machine);
    let startDt = parseIsoLocal(start);
    if (shift === 'day' && startDt && (isSaturday(startDt) || isSunday(startDt))) {
      startDt = atMinuteOnDay(nextDayShiftCalendarDay(startDt), MPP_DAY_START_MIN);
      start = formatDateObj(startDt);
    }
    const endDt = new Date(startDt);
    endDt.setMinutes(endDt.getMinutes() + Math.round(durationMin));
    const windowEnd = shiftWindowEnd(startDt, shift);
    const overflows = endDt > windowEnd;
    return {
      start,
      end: formatDateObj(endDt),
      overflows,
      shiftLabel: MPP_SHIFT_META[shift]?.label || shift,
      shiftWindow: MPP_SHIFT_META[shift]?.window || '',
    };
  }

  function newId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  function jobRunMinutes(job, palletCount) {
    const pallets = Math.max(0, Number(palletCount) || 0);
    return pallets * Math.max(0.1, Number(job?.minPerPallet) || 90);
  }

  function defaultCycleTimingFromJob(job) {
    return {
      setupMinutes: Math.max(0, Number(job?.setupMinutes) || 0),
      loadMinPerCycle: MPP_DEFAULT_LOAD_MIN_PER_CYCLE,
      unloadMinPerCycle: MPP_DEFAULT_UNLOAD_MIN_PER_CYCLE,
      sequential: false,
      setupPerOp: false,
    };
  }

  function normalizeCycle(cycle) {
    if (!cycle) return cycle;
    if (cycle.loadMinPerCycle === undefined && cycle.loadMinPerPallet !== undefined) {
      cycle.loadMinPerCycle = cycle.loadMinPerPallet;
    }
    if (cycle.unloadMinPerCycle === undefined && cycle.unloadMinPerPallet !== undefined) {
      cycle.unloadMinPerCycle = cycle.unloadMinPerPallet;
    }
    if (cycle.setupMinutes === undefined) cycle.setupMinutes = 0;
    if (cycle.loadMinPerCycle === undefined) cycle.loadMinPerCycle = MPP_DEFAULT_LOAD_MIN_PER_CYCLE;
    if (cycle.unloadMinPerCycle === undefined) cycle.unloadMinPerCycle = MPP_DEFAULT_UNLOAD_MIN_PER_CYCLE;
    if (cycle.sequential === undefined) cycle.sequential = (cycle.ops || []).length > 1;
    if (cycle.setupPerOp === undefined) cycle.setupPerOp = false;
    return cycle;
  }

  function seedCycleTimingFromJob(cycle, job) {
    if (!cycle || !job) return;
    normalizeCycle(cycle);
    if (!Number(cycle.setupMinutes)) {
      cycle.setupMinutes = Math.max(0, Number(job.setupMinutes) || 0);
    }
  }

  function syncCycleSequentialFlag(cycle) {
    normalizeCycle(cycle);
    if ((cycle.ops || []).length > 1 && cycle.sequential !== false) {
      cycle.sequential = true;
    }
  }

  function cycleTiming(cycle) {
    normalizeCycle(cycle);
    return {
      setup: Math.max(0, Number(cycle.setupMinutes) || 0),
      load: Math.max(0, Number(cycle.loadMinPerCycle) || 0),
      unload: Math.max(0, Number(cycle.unloadMinPerCycle) || 0),
      sequential: cycle.sequential === true,
      setupPerOp: cycle.setupPerOp === true,
    };
  }

  function cycleSprintSetupMinutes(cycle) {
    const timing = cycleTiming(cycle);
    const jobs = (cycle.ops || []).map((row) => getJob(row.jobId)).filter(Boolean);
    if (timing.setupPerOp && jobs.length > 1) {
      return jobs.reduce((sum, job) => sum + Math.max(0, Number(job.setupMinutes) || 0), 0);
    }
    return timing.setup;
  }

  function isCycleSprintStart(lane, cycleIdx) {
    const cycles = lane?.cycles || [];
    if (cycleIdx <= 0) return true;
    const prev = cycles[cycleIdx - 1];
    const cur = cycles[cycleIdx];
    if (!prev || !cur) return true;
    return cycleFingerprint(prev) !== cycleFingerprint(cur);
  }

  function opMinutes(job, palletCount) {
    return jobRunMinutes(job, palletCount);
  }

  function opPcsPerPallet(row, job) {
    const frozen = Number(row?.pcsPerPallet);
    if (Number.isFinite(frozen) && frozen > 0) return frozen;
    return Math.max(1, Number(job?.pcsPerPallet) || 1);
  }

  function jobFullPcsPerPallet(job) {
    return Math.max(1, Number(job?.pcsPerPallet) || 1);
  }

  /** Pieces for the next +1 pallet drop: full pcs/pal, or leftover rem when below a full pallet. */
  function nextPalletPcs(jobId) {
    const job = getJob(jobId);
    if (!job) return 0;
    const rem = jobRemaining(jobId);
    if (rem <= 0) return 0;
    return Math.min(rem, jobFullPcsPerPallet(job));
  }

  function canQueueAnyPcs(jobId) {
    return nextPalletPcs(jobId) >= 1;
  }

  function isPartialNextPallet(jobId) {
    const job = getJob(jobId);
    if (!job) return false;
    const rem = jobRemaining(jobId);
    const full = jobFullPcsPerPallet(job);
    return rem > 0 && rem < full;
  }

  function newCycleOp(jobId, palletCount, job = null, pcsOverride = null) {
    const resolved = job || getJob(jobId);
    const override = Number(pcsOverride);
    return {
      opId: newId('op'),
      jobId,
      palletCount: Math.max(1, Number(palletCount) || 1),
      pcsPerPallet: Number.isFinite(override) && override > 0
        ? override
        : opPcsPerPallet(null, resolved),
    };
  }

  function opOutput(job, palletCount, row = null) {
    return Number(palletCount || 0) * opPcsPerPallet(row, job);
  }


  function mapApiJob(job) {
    return {
      jobId: job.jobId,
      sourcePsId: job.sourcePsId || mppPsBaseId(job.psId),
      psId: job.psId,
      ppPartialNo: Number(job.ppPartialNo) || 1,
      partNo: job.partNo,
      partDesc: job.partDesc || '',
      opLabel: job.opLabel,
      minPerPallet: Number(job.minPerPallet) || 90,
      setupMinutes: Math.max(0, Number(job.setupMinutes) || 0),
      pcsPerPallet: Number(job.pcsPerPallet) || 1,
      defaultPalletsPerCycle: Number(job.defaultPalletsPerCycle) || 1,
      qty: Number(job.qty) || 0,
      out: Number(job.out) || 0,
      remainingQty: Number(job.remainingQty) || 0,
      requiredQty: Number(job.requiredQty) || 0,
      erpFinished: Number(job.erpFinished) || 0,
      plannedQty: Number(job.plannedQty) || 0,
      qtyShipped: Number(job.qtyShipped ?? job.qty_shipped) || 0,
      schedulable: job.schedulable !== false,
      blockedReason: compactText(job.blockedReason),
      due: job.due || '',
      preferredMachine: job.preferredMachine || '',
      bomCode: job.bomCode || '',
      erpBomCode: job.erpBomCode || '',
      bomStageStatus: job.bomStageStatus || '',
      partialQty: Number(job.partialQty) || 0,
      totalQty: Number(job.totalQty) || 0,
      currentStageDesc: job.currentStageDesc || '',
      currentStageStatus: job.currentStageStatus || '',
      materialIn: job.materialIn === true,
      sourceVoucher: job.sourceVoucher || '',
      plannerStatus: job.plannerStatus || '',
      inventoryCode: job.inventoryCode || job.partNo || '',
      opSeqId: Number(job.opSeqId) || 0,
      isFrameAgreement: job.isFrameAgreement === true,
    };
  }

  function jobIsSchedulable(job) {
    if (!job) return false;
    if (job.schedulable === false) return false;
    return jobRemaining(job.jobId) > 0;
  }

  function updateJobsStatusLine() {
    const el = document.getElementById('mpp-ops-status');
    if (!el) return;
    if (jobsLoadError) {
      el.hidden = false;
      el.textContent = `Could not load jobs — ${jobsLoadError}`;
      el.classList.add('mpp-ops-status--error');
      return;
    }
    el.hidden = true;
    el.classList.remove('mpp-ops-status--error');
  }

  function updateJobsSourceBadge() {
    const badge = document.querySelector('.mpp-badge');
    const syncEl = document.getElementById('mpp-queue-sync');
    if (badge) {
      if (jobsLoadError) {
        badge.textContent = 'Load failed';
        badge.classList.remove('mpp-badge--live');
      } else if (jobsSource === 'process_sheets' || jobsSource === 'frame_agreement') {
        badge.textContent = 'Live';
        badge.classList.add('mpp-badge--live');
      } else {
        badge.textContent = 'Loading';
        badge.classList.remove('mpp-badge--live');
      }
    }
    if (!syncEl) return;
    if (queueSyncStatus === 'saving') {
      syncEl.textContent = 'Saving queue…';
      syncEl.className = 'mpp-queue-sync mpp-queue-sync--saving';
    } else if (queueRecalcStatus === 'running') {
      syncEl.textContent = 'Updating schedule segments…';
      syncEl.className = 'mpp-queue-sync mpp-queue-sync--saving';
    } else if (queueSyncStatus === 'pending') {
      syncEl.textContent = 'Autosave pending…';
      syncEl.className = 'mpp-queue-sync mpp-queue-sync--pending';
    } else if (queueSyncStatus === 'error') {
      syncEl.textContent = queueSaveError ? `Save failed — ${queueSaveError}` : 'Save failed';
      syncEl.className = 'mpp-queue-sync mpp-queue-sync--error';
    } else if (queueRecalcStatus === 'pending') {
      syncEl.textContent = 'Queue saved · schedule update pending…';
      syncEl.className = 'mpp-queue-sync mpp-queue-sync--pending';
    } else if (queueRecalcStatus === 'error') {
      syncEl.textContent = queueRecalcError ? `Schedule update failed — ${queueRecalcError}` : 'Schedule update failed';
      syncEl.className = 'mpp-queue-sync mpp-queue-sync--error';
    } else if (queueLoadError) {
      syncEl.textContent = `Queue load failed — ${queueLoadError}`;
      syncEl.className = 'mpp-queue-sync mpp-queue-sync--error';
    } else if (queueSavedAt) {
      const cycleCount = Object.values(state.machines || {}).reduce(
        (sum, lane) => sum + (lane?.cycles?.length || 0),
        0,
      );
      const base = cycleCount
        ? `Queue synced ${queueSavedAt} · ${cycleCount} cycle${cycleCount === 1 ? '' : 's'}`
        : `Queue empty · synced ${queueSavedAt}`;
      if (queueSoftWarning) {
        syncEl.textContent = `${base} · ${queueSoftWarning}`;
        syncEl.className = 'mpp-queue-sync mpp-queue-sync--warn';
        syncEl.title = queueSoftWarning;
      } else {
        syncEl.textContent = base;
        syncEl.className = cycleCount ? 'mpp-queue-sync mpp-queue-sync--saved' : 'mpp-queue-sync';
        syncEl.title = '';
      }
    } else {
      syncEl.textContent = 'Queue empty';
      syncEl.className = 'mpp-queue-sync';
      syncEl.title = '';
    }
  }

  function buildQueueSavePayload({ recalculate = false } = {}) {
    const dirty = [...dirtyMachineSlugs];
    // Partial save: only lanes that changed. Full-fleet rewrite was too slow with 100+ cycles.
    const machines = {};
    dirty.forEach((slug) => {
      if (state.machines[slug]) machines[slug] = state.machines[slug];
    });
    const probation = {};
    dirty.forEach((slug) => {
      probation[slug] = (state.probation && state.probation[slug]) || [];
    });
    const jobIds = new Set();
    Object.values(machines).forEach((lane) => {
      (lane.cycles || []).forEach((cycle) => {
        (cycle.ops || []).forEach((row) => {
          if (row.jobId) jobIds.add(row.jobId);
        });
      });
    });
    Object.values(probation).forEach((entries) => {
      (entries || []).forEach((entry) => {
        if (entry.jobId) jobIds.add(entry.jobId);
      });
    });
    const jobs = {};
    jobIds.forEach((jobId) => {
      const job = state.jobs[jobId] || getJob(jobId);
      if (job) jobs[jobId] = job;
    });
    return {
      machines,
      jobs,
      probation,
      dirtyMachines: dirty,
      recalculate: recalculate === true,
    };
  }

  function machineDbId(machineSlug) {
    return Number(machineById(machineSlug)?.machineId || 0);
  }

  function markMachineDirty(machineSlug) {
    if (!machineSlug || suppressQueueSave || !queueHydrated) return;
    dirtyMachineSlugs.add(String(machineSlug));
    const dbId = machineDbId(machineSlug);
    if (dbId > 0) queueRecalcMachineIds.add(dbId);
  }

  function markMachinesWithJob(jobId) {
    if (!jobId) return;
    Object.entries(state.machines).forEach(([slug, lane]) => {
      const hasJob = (lane.cycles || []).some((cycle) =>
        (cycle.ops || []).some((row) => row.jobId === jobId),
      );
      if (hasJob) markMachineDirty(slug);
    });
  }

  function mergeTouchedMachineIds(payload) {
    const touched = Array.isArray(payload?.touchedMachineIds) ? payload.touchedMachineIds : [];
    touched.forEach((id) => {
      const dbId = Number(id);
      if (dbId > 0) queueRecalcMachineIds.add(dbId);
    });
    dirtyMachineSlugs.clear();
  }

  function buildQueueRecalcBody() {
    const machineIds = [...queueRecalcMachineIds].filter((id) => Number(id) > 0);
    return JSON.stringify({ machine_ids: machineIds });
  }

  function applyQueueHydration(queuePayload) {
    suppressQueueSave = true;
    const machines = queuePayload?.machines || {};
    Object.entries(machines).forEach(([slug, lane]) => {
      if (!state.machines[slug]) state.machines[slug] = { laneAnchor: '', cycles: [] };
      state.machines[slug].laneAnchor = lane.laneAnchor || '';
      state.machines[slug].cycles = (lane.cycles || []).map((cycle) => normalizeCycle({
        cycleId: cycle.cycleId,
        shift: cycle.shift || 'night',
        anchor: cycle.anchor || null,
        label: cycle.label || null,
        setupMinutes: cycle.setupMinutes,
        loadMinPerCycle: cycle.loadMinPerCycle ?? cycle.loadMinPerPallet,
        unloadMinPerCycle: cycle.unloadMinPerCycle ?? cycle.unloadMinPerPallet,
        sequential: cycle.sequential,
        setupPerOp: cycle.setupPerOp,
        ops: (cycle.ops || []).map((row) => {
          const jobId = row.jobId;
          if (jobId) {
            const identity = {
              jobId,
              psId: compactText(row.psId) || undefined,
              sourcePsId: compactText(row.sourcePsId) || undefined,
              opNo: compactText(row.opNo) || undefined,
              opLabel: compactText(row.opLabel) || undefined,
            };
            const existing = getJob(jobId) || { jobId };
            const merged = { ...existing };
            Object.entries(identity).forEach(([key, val]) => {
              if (val && !compactText(merged[key])) merged[key] = val;
            });
            state.jobs[jobId] = merged;
          }
          return {
            opId: row.opId,
            jobId: row.jobId,
            palletCount: Number(row.palletCount) || 1,
            pcsPerPallet: opPcsPerPallet(row, getJob(row.jobId)),
            blockId: Number(row.blockId) || 0,
          };
        }),
      }));
    });
    const probation = queuePayload?.probation || {};
    state.probation = buildProbationState();
    Object.entries(probation).forEach(([slug, entries]) => {
      if (!state.probation[slug]) state.probation[slug] = [];
      state.probation[slug] = (entries || []).map((entry) => ({
        entryId: entry.entryId || newId('prob'),
        jobId: entry.jobId,
        palletCount: Math.max(1, Number(entry.palletCount) || 1),
        shift: entry.shift || 'night',
        note: compactText(entry.note),
      }));
    });
    const overrides = queuePayload?.jobOverrides || {};
    Object.entries(overrides).forEach(([jobId, row]) => {
      const base = getJob(jobId) || { jobId };
      const merged = { ...base, ...row };
      state.jobs[jobId] = merged;
      const idx = JOB_TEMPLATES.findIndex((j) => j.jobId === jobId);
      if (idx >= 0) JOB_TEMPLATES[idx] = { ...JOB_TEMPLATES[idx], ...row };
    });
    queueSavedAt = compactText(queuePayload?.savedAt);
    suppressQueueSave = false;
  }

  async function loadMppQueue() {
    queueLoadError = '';
    try {
      const res = await fetch('/api/mpp-planner/queue');
      const payload = await parseJsonResponse(res);
      if (!res.ok || !payload.ok) {
        queueLoadError = compactApiError(payload?.error) || `HTTP ${res.status}`;
        return false;
      }
      applyQueueHydration(payload);
      return true;
    } catch (err) {
      queueLoadError = err?.message || 'network error';
      return false;
    }
  }

  async function flushQueueSave({ recalculate = false } = {}) {
    if (suppressQueueSave || !queueHydrated) return;
    if (!dirtyMachineSlugs.size && !recalculate) return;
    if (queueSaveInFlight) {
      queueSavePending = true;
      queueSavePendingRecalculate = queueSavePendingRecalculate || recalculate === true;
      return;
    }
    queueSaveInFlight = true;
    queueSyncStatus = 'saving';
    updateJobsSourceBadge();
    try {
      const body = JSON.stringify(buildQueueSavePayload({ recalculate }));
      let res = await fetch('/api/mpp-planner/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (res.status === 405 || res.status === 404) {
        res = await fetch('/api/mpp-planner/queue', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
      }
      const payload = await parseJsonResponse(res);
      if (!res.ok || !payload.ok) {
        throw new Error(compactApiError(payload?.error) || `HTTP ${res.status}`);
      }
      queueSyncStatus = 'saved';
      queueSaveError = '';
      queueSavedAt = compactText(payload.savedAt);
      const warnings = Array.isArray(payload.warnings) ? payload.warnings.filter(Boolean) : [];
      // Qty overrun / per-lane issues are advisory — save already committed.
      queueSoftWarning = warnings[0] || '';
      if (!recalculate && !payload.recalculated) {
        mergeTouchedMachineIds(payload);
        if (queueRecalcMachineIds.size > 0) {
          queueRecalcPending = true;
          scheduleQueueRecalc();
        } else {
          queueRecalcPending = false;
          queueRecalcStatus = 'idle';
          queueRecalcError = '';
        }
      } else {
        queueRecalcPending = false;
        queueRecalcMachineIds.clear();
        queueRecalcStatus = 'idle';
        queueRecalcError = '';
      }
    } catch (err) {
      queueSyncStatus = 'error';
      queueSaveError = err?.message || 'save failed';
      queueSoftWarning = '';
      scheduleQueueSaveRetry();
    } finally {
      queueSaveInFlight = false;
      updateJobsSourceBadge();
      if (queueSavePending) {
        const pendingRecalc = queueSavePendingRecalculate;
        queueSavePending = false;
        queueSavePendingRecalculate = false;
        scheduleQueueSave({ recalculate: pendingRecalc });
      }
    }
  }

  async function flushQueueRecalc() {
    if (!queueHydrated || suppressQueueSave) return;
    if (queueRecalcInFlight) {
      queueRecalcPending = true;
      return;
    }
    if (!queueRecalcPending && queueRecalcStatus !== 'error') return;
    if (!queueRecalcMachineIds.size) {
      queueRecalcPending = false;
      queueRecalcStatus = 'idle';
      return;
    }
    queueRecalcInFlight = true;
    queueRecalcStatus = 'running';
    queueRecalcError = '';
    updateJobsSourceBadge();
    const recalcIds = [...queueRecalcMachineIds];
    try {
      const res = await fetch('/api/mpp-planner/recalculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildQueueRecalcBody(),
      });
      const payload = await parseJsonResponse(res);
      if (!res.ok || !payload.ok) {
        throw new Error(compactApiError(payload?.error) || `HTTP ${res.status}`);
      }
      const warnings = Array.isArray(payload.warnings) ? payload.warnings.filter(Boolean) : [];
      const okIds = Array.isArray(payload.machineIds) ? payload.machineIds : recalcIds;
      okIds.forEach((id) => queueRecalcMachineIds.delete(Number(id)));
      if (warnings.length) {
        // Segment rebuild issues (lock timeout, etc.) must not look like a failed queue save.
        queueSoftWarning = warnings[0];
      }
      if (!queueRecalcMachineIds.size) {
        queueRecalcPending = false;
        queueRecalcStatus = 'idle';
        queueRecalcError = '';
      } else {
        queueRecalcPending = true;
        queueRecalcStatus = 'pending';
      }
    } catch (err) {
      queueRecalcStatus = 'error';
      queueRecalcError = err?.message || 'recalculate failed';
      scheduleQueueRecalcRetry();
    } finally {
      queueRecalcInFlight = false;
      updateJobsSourceBadge();
      if (queueRecalcPending && queueRecalcStatus !== 'error') {
        scheduleQueueRecalc();
      }
    }
  }

  function queueRecalcUrl() {
    return '/api/mpp-planner/recalculate';
  }

  function flushQueueRecalcOnExit() {
    if (!queueHydrated || suppressQueueSave) return;
    if (!queueRecalcMachineIds.size && queueRecalcStatus !== 'error') return;
    clearTimeout(queueRecalcTimer);
    queueRecalcTimer = null;
    clearTimeout(queueRecalcRetryTimer);
    queueRecalcRetryTimer = null;
    try {
      if (typeof fetch === 'function' && queueRecalcMachineIds.size) {
        fetch(queueRecalcUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: buildQueueRecalcBody(),
          keepalive: true,
        }).catch(() => { /* page is unloading */ });
      }
    } catch { /* ignore */ }
  }

  function queueSaveUrl() {
    return '/api/mpp-planner/queue';
  }

  function flushQueueSaveOnExit() {
    if (suppressQueueSave || !queueHydrated) return;
    if (queueSyncStatus !== 'pending' && queueSyncStatus !== 'error') {
      flushQueueRecalcOnExit();
      return;
    }
    clearTimeout(queueSaveTimer);
    queueSaveTimer = null;
    clearTimeout(queueSaveRetryTimer);
    queueSaveRetryTimer = null;
    try {
      const body = JSON.stringify(buildQueueSavePayload({ recalculate: false }));
      if (typeof fetch === 'function') {
        fetch(queueSaveUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => { /* page is unloading */ });
      }
    } catch { /* ignore */ }
    flushQueueRecalcOnExit();
  }

  function scheduleQueueRecalcRetry() {
    clearTimeout(queueRecalcRetryTimer);
    queueRecalcRetryTimer = window.setTimeout(() => {
      queueRecalcRetryTimer = null;
      if (queueRecalcStatus !== 'error' || !queueHydrated || suppressQueueSave) return;
      queueRecalcPending = true;
      updateJobsSourceBadge();
      flushQueueRecalc();
    }, QUEUE_SAVE_RETRY_MS);
  }

  function scheduleQueueRecalc() {
    if (!queueHydrated || suppressQueueSave) return;
    if (!queueRecalcMachineIds.size && queueRecalcStatus !== 'error') return;
    queueRecalcPending = true;
    queueRecalcStatus = 'pending';
    updateJobsSourceBadge();
    clearTimeout(queueRecalcTimer);
    clearTimeout(queueRecalcRetryTimer);
    queueRecalcRetryTimer = null;
    queueRecalcTimer = window.setTimeout(() => {
      queueRecalcTimer = null;
      flushQueueRecalc();
    }, QUEUE_RECALC_DEBOUNCE_MS);
  }

  function scheduleQueueSaveRetry() {
    clearTimeout(queueSaveRetryTimer);
    queueSaveRetryTimer = window.setTimeout(() => {
      queueSaveRetryTimer = null;
      if (queueSyncStatus !== 'error' || !queueHydrated || suppressQueueSave) return;
      queueSyncStatus = 'pending';
      updateJobsSourceBadge();
      flushQueueSave({ recalculate: false });
    }, QUEUE_SAVE_RETRY_MS);
  }

  function scheduleQueueSave({ recalculate = false } = {}) {
    if (suppressQueueSave || !queueHydrated) return;
    if (skipNextQueueSave) {
      skipNextQueueSave = false;
      return;
    }
    queueSyncStatus = 'pending';
    updateJobsSourceBadge();
    clearTimeout(queueSaveTimer);
    clearTimeout(queueSaveRetryTimer);
    queueSaveRetryTimer = null;
    queueSaveTimer = window.setTimeout(() => {
      queueSaveTimer = null;
      // Avoid stacking save + recalc connections when the pool is tight.
      if (queueRecalcInFlight) {
        scheduleQueueSave({ recalculate });
        return;
      }
      flushQueueSave({ recalculate });
    }, QUEUE_SAVE_DEBOUNCE_MS);
  }

  async function loadFrameAgreementJobs(opts = {}) {
    jobsLoadError = '';
    // Keep the full pool once loaded so FA-only can stay a client filter.
    const wantAll = opts.all === true || !mppFaOnly || jobsPoolIncludesNonFa;
    try {
      const res = await fetch(`/api/mpp-planner/jobs?fa_only=${wantAll ? '0' : '1'}`);
      const payload = await parseJsonResponse(res);
      if (!res.ok || !payload.ok) {
        jobsLoadError = compactApiError(payload?.error) || `HTTP ${res.status}`;
        jobsSource = 'error';
        return false;
      }
      frameAgreementPartCount = Number(payload.frame_agreement_part_count) || 0;
      jobsFetchedAt = compactText(payload.fetched_at);
      const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
      JOB_TEMPLATES = jobs.map(mapApiJob);
      jobsPoolIncludesNonFa = wantAll;
      jobsSource = wantAll ? 'process_sheets' : 'frame_agreement';
      return true;
    } catch (err) {
      jobsLoadError = err?.message || 'network error';
      jobsSource = 'error';
      return false;
    }
  }

  function poolJobTemplates() {
    if (!mppFaOnly) return JOB_TEMPLATES;
    return JOB_TEMPLATES.filter((job) => job.isFrameAgreement);
  }

  function compactText(value) {
    return String(value ?? '').trim();
  }

  function compactApiError(value) {
    return compactText(value);
  }

  function defaultMachineId() {
    return visibleMachines()[0]?.id || MACHINES[0]?.id || 'cnc35';
  }

  function buildMachinesState() {
    const machines = {};
    MACHINES.forEach((machine) => {
      machines[machine.id] = { laneAnchor: '', cycles: [] };
    });
    return machines;
  }

  function buildProbationState() {
    const probation = {};
    MACHINES.forEach((machine) => {
      probation[machine.id] = [];
    });
    return probation;
  }

  function resolveMachineForJob(job) {
    if (!job) return defaultMachineId();
    const pref = compactText(job.preferredMachine).toUpperCase();
    if (pref) {
      const match = MACHINES.find((m) => compactText(m.code).toUpperCase() === pref);
      if (match) return match.id;
    }
    return defaultMachineId();
  }

  function probationEntryMinutes(job, palletCount) {
    if (!job) return 0;
    const setup = Math.max(0, Number(job.setupMinutes) || 0);
    const load = MPP_DEFAULT_LOAD_MIN_PER_CYCLE;
    const unload = MPP_DEFAULT_UNLOAD_MIN_PER_CYCLE;
    const run = jobRunMinutes(job, palletCount);
    return setup + load + run + unload;
  }

  function machineCapacitySummary(machineId) {
    const lane = state.machines[machineId] || { cycles: [] };
    const machine = machineById(machineId);
    const scheduled = scheduleLane(lane, machine);
    const scheduledMin = scheduled.reduce((sum, item) => sum + (item.durationMin || 0), 0);
    const probationMin = (state.probation[machineId] || []).reduce((sum, entry) => {
      const job = getJob(entry.jobId);
      return sum + (job ? probationEntryMinutes(job, entry.palletCount) : 0);
    }, 0);
    return { scheduledMin, probationMin, totalMin: scheduledMin + probationMin };
  }

  function ensureProbationLane(machineId) {
    if (!state.probation) state.probation = buildProbationState();
    if (!state.probation[machineId]) state.probation[machineId] = [];
    return state.probation[machineId];
  }

  function findProbationEntry(entryId) {
    for (const [machineId, entries] of Object.entries(state.probation || {})) {
      const idx = (entries || []).findIndex((e) => e.entryId === entryId);
      if (idx >= 0) return { machineId, entries, index: idx, entry: entries[idx] };
    }
    return null;
  }

  function estimateProbationPallets(job) {
    if (!job) return 1;
    const rem = jobRemaining(job.jobId);
    const pcs = Math.max(1, Number(job.pcsPerPallet) || 1);
    if (rem > 0) return Math.max(1, Math.ceil(rem / pcs));
    const target = Math.max(0, Number(job.qty || 0) - Number(job.out || 0));
    if (target > 0) return Math.max(1, Math.ceil(target / pcs));
    return 1;
  }

  function addToProbation(machineId, jobId, palletCount) {
    const job = getJob(jobId);
    if (!job || !machineId) return false;
    const pallets = Math.max(1, Number(palletCount) || estimateProbationPallets(job));
    const lane = ensureProbationLane(machineId);
    const machine = machineById(machineId);
    const shift = defaultShiftForMachine(machine);
    const existing = lane.find((e) => e.jobId === jobId);
    if (existing) {
      existing.palletCount += pallets;
    } else {
      lane.push({
        entryId: newId('prob'),
        jobId,
        palletCount: pallets,
        shift: normalizeShift(shift, machine),
      });
    }
    markMachineDirty(machineId);
    render();
    return true;
  }

  function removeFromProbation(entryId) {
    const found = findProbationEntry(entryId);
    if (!found) return;
    markMachineDirty(found.machineId);
    found.entries.splice(found.index, 1);
    render();
  }

  function promoteProbationToCycle(entryId, cycleId) {
    const found = findProbationEntry(entryId);
    if (!found) return false;
    const { entry } = found;
    const job = getJob(entry.jobId);
    if (!job) return false;
    let palletsLeft = Math.max(1, Number(entry.palletCount) || 1);
    while (palletsLeft > 0 && canQueueAnyPcs(entry.jobId)) {
      if (!addPalletToCycle(cycleId, entry.jobId, { renderAfter: false })) break;
      palletsLeft -= 1;
    }
    found.entries.splice(found.index, 1);
    markMachineDirty(found.machineId);
    const cycleFound = findCycle(cycleId);
    if (cycleFound) markMachineDirty(cycleFound.machineId);
    render();
    return true;
  }

  function defaultState() {
    const jobs = {};
    JOB_TEMPLATES.forEach((t) => { jobs[t.jobId] = { ...t }; });
    return {
      jobs,
      machines: buildMachinesState(),
      probation: buildProbationState(),
      selectedCycleId: '',
      drag: null,
      dragBox: null,
      modal: null,
    };
  }

  let state = defaultState();
  let queueHydrated = false;
  let queueSaveTimer = null;
  let queueSaveRetryTimer = null;
  let queueSaveIdleTimer = null;
  let queueRecalcTimer = null;
  let queueRecalcRetryTimer = null;
  let queueSaveInFlight = false;
  let queueSavePending = false;
  let queueSavePendingRecalculate = false;
  let queueRecalcInFlight = false;
  let queueRecalcPending = false;
  let queueRecalcMachineIds = new Set();
  let dirtyMachineSlugs = new Set();
  let queueSyncStatus = 'idle';
  let queueRecalcStatus = 'idle';
  let queueSaveError = '';
  let queueRecalcError = '';
  let queueSoftWarning = '';
  let queueSavedAt = '';
  let queueLoadError = '';
  let suppressQueueSave = false;
  let skipNextQueueSave = false;

  function getJob(jobId) {
    return state.jobs[jobId] || JOB_TEMPLATES.find((j) => j.jobId === jobId);
  }

  function jobScheduledPcs(jobId) {
    let sum = 0;
    Object.values(state.machines).forEach((lane) => {
      (lane.cycles || []).forEach((cycle) => {
        (cycle.ops || []).forEach((row) => {
          if (row.jobId === jobId) {
            const job = getJob(jobId);
            sum += opOutput(job, row.palletCount, row);
          }
        });
      });
    });
    return sum;
  }

  function jobQueuedPcs(jobId) {
    return jobScheduledPcs(jobId);
  }

  function jobAccountedPcs(jobId) {
    const uiQueued = jobScheduledPcs(jobId);
    const dbPlanned = Math.max(0, Number(getJob(jobId)?.plannedQty) || 0);
    return Math.max(uiQueued, dbPlanned);
  }

  function jobRemaining(jobId) {
    const job = getJob(jobId);
    if (!job) return 0;
    const openWo = Math.max(0, Number(job.qty || 0) - Number(job.out || 0));
    const accounted = jobAccountedPcs(jobId);
    if (accounted > 0) {
      return Math.max(0, openWo - accounted);
    }
    const serverRem = Number(job.remainingQty);
    if (Number.isFinite(serverRem) && serverRem >= 0) {
      return Math.max(0, serverRem);
    }
    return openWo;
  }

  function jobQueuedDisplay(job) {
    const uiQueued = jobQueuedPcs(job.jobId);
    if (uiQueued > 0) return uiQueued;
    return Math.max(0, Number(job.plannedQty || 0));
  }

  async function parseJsonResponse(res) {
    if (typeof parseApiJson === 'function') return parseApiJson(res);
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Server returned an HTML page (HTTP ${res.status || 'ok'}) instead of JSON.`);
    }
  }

  function cycleMetrics(cycle) {
    normalizeCycle(cycle);
    const rows = (cycle.ops || []).map((row) => ({ row, job: getJob(row.jobId) })).filter((x) => x.job);
    const timing = cycleTiming(cycle);
    const runMins = rows.map(({ row, job }) => jobRunMinutes(job, row.palletCount));
    const runBlock = timing.sequential && rows.length > 1
      ? runMins.reduce((sum, n) => sum + n, 0)
      : Math.max(0, ...runMins, 0);
    const cycleMinutes = timing.load + runBlock + timing.unload;
    return { cycleMinutes, runBlock, timing, opCount: rows.length, rows, runMins };
  }

  function findCycle(cycleId) {
    for (const [machineId, lane] of Object.entries(state.machines)) {
      const idx = (lane.cycles || []).findIndex((c) => c.cycleId === cycleId);
      if (idx >= 0) return { machineId, lane, cycle: lane.cycles[idx], index: idx };
    }
    return null;
  }

  function findOpEntry(opId) {
    for (const [machineId, lane] of Object.entries(state.machines)) {
      for (const cycle of lane.cycles || []) {
        const oi = (cycle.ops || []).findIndex((o) => o.opId === opId);
        if (oi >= 0) return { machineId, cycleId: cycle.cycleId, opIndex: oi, op: cycle.ops[oi] };
      }
    }
    return null;
  }

  /** Prefer laneAnchor, but never schedule the display queue from a past cursor. */
  function clampScheduleCursor(iso) {
    const now = new Date();
    const nowIso = formatDateObj(now);
    const dt = parseIsoLocal(iso);
    if (!dt || dt < now) return nowIso;
    return formatDateObj(dt);
  }

  function scheduleLane(lane, machine) {
    let cursor = clampScheduleCursor(lane.laneAnchor || formatDateObj(new Date()));
    return (lane.cycles || []).map((cycle, idx) => {
      const metrics = cycleMetrics(cycle);
      const sprintStart = isCycleSprintStart(lane, idx);
      const durationMin = metrics.cycleMinutes + (sprintStart ? cycleSprintSetupMinutes(cycle) : 0);
      const shift = normalizeShift(cycle.shift, machine);
      let startHint = cursor;
      if (idx === 0 && cycle.anchor) {
        const clampedAnchor = clampScheduleCursor(cycle.anchor);
        const anchorDt = parseIsoLocal(clampedAnchor);
        const cursorDt = parseIsoLocal(cursor);
        if (anchorDt && cursorDt && anchorDt > cursorDt) startHint = clampedAnchor;
      }
      const placed = placeCycleInShift(startHint, durationMin, shift, machine);
      if (idx === 0 && cycle.anchor) {
        const clampedAnchor = clampScheduleCursor(cycle.anchor);
        const anchorAligned = nextShiftStart(clampedAnchor, shift, machine);
        const anchorDt = parseIsoLocal(clampScheduleCursor(anchorAligned));
        const placedStart = parseIsoLocal(placed.start);
        if (anchorDt && placedStart && anchorDt > placedStart) {
          const realigned = placeCycleInShift(anchorAligned, durationMin, shift, machine);
          Object.assign(placed, realigned);
        }
      }
      cursor = placed.end;
      return {
        cycle,
        idx,
        metrics,
        shift,
        anchored: !!cycle.anchor,
        sprintStart,
        sprintSetupMinutes: sprintStart ? cycleSprintSetupMinutes(cycle) : 0,
        durationMin,
        ...placed,
      };
    });
  }

  function laneQueueSummary(lane, machine) {
    const scheduled = scheduleLane(lane, machine);
    const count = scheduled.length;
    const nextEnd = count ? scheduled[count - 1].end : lane.laneAnchor;
    const first = scheduled[0];
    return { count, nextEnd, first };
  }

  function renderRemoveBtn(opId) {
    return `<button type="button" class="trial-block-remove mpp-op-remove" data-action="remove-op"
      data-op-id="${escapeHtml(opId)}" title="Remove from queue" aria-label="Remove from queue">×</button>`;
  }

  function renderCycleTimingBar(cycle, metrics) {
    const t = metrics.timing || cycleTiming(cycle);
    const mode = metrics.opCount > 1
      ? (t.sequential ? 'Sequential ops' : 'Parallel ops (longest run)')
      : 'Single op';
    const setupNote = metrics.opCount > 1 && t.setupPerOp ? ' · setup per op' : ' · setup once/sprint';
    return `
      <div class="mpp-cycle-timing-bar">
        <div class="mpp-cycle-timing-bar-main">
          <span>Setup <strong>${fmtMinutes(t.setup)}</strong></span>
          <span>Load <strong>${fmtMinutes(t.load)}</strong></span>
          <span>Unload <strong>${fmtMinutes(t.unload)}</strong></span>
          <span class="mpp-cycle-timing-mode">${escapeHtml(mode)}${setupNote}</span>
        </div>
        <button type="button" class="mpp-op-edit" data-action="edit-cycle-timing" data-cycle-id="${escapeHtml(cycle.cycleId)}"
          title="Edit cycle setup, load/unload">✎</button>
      </div>
    `;
  }

  function renderOpInCycle(job, row) {
    const pcs = opOutput(job, row.palletCount, row);
    const runMins = jobRunMinutes(job, row.palletCount);
    const palletLabel = row.palletCount === 1 ? '1 pallet' : `${row.palletCount} pallets`;
    const rowPcs = opPcsPerPallet(row, job);
    const partialNote = rowPcs < jobFullPcsPerPallet(job)
      ? ` · ${rowPcs} pc/pal (partial)`
      : ` · ${rowPcs} pc/pal`;
    return `
      <div class="mpp-op-card mpp-op-card--in-cycle" draggable="true" data-drag-kind="op" data-op-id="${escapeHtml(row.opId)}">
        <div class="mpp-op-card-top">
          <div class="mpp-op-ps">${escapeHtml(job.psId)}</div>
          <div class="mpp-op-actions">
            <button type="button" class="mpp-op-edit" data-action="edit-op-run" data-job-id="${escapeHtml(job.jobId)}" title="Edit run time / pcs">✎</button>
            ${renderRemoveBtn(row.opId)}
          </div>
        </div>
        <div class="mpp-op-label">${escapeHtml(job.opLabel)}</div>
        <div class="mpp-pallet-strip">${Array.from({ length: row.palletCount }, (_, i) => `<span class="mpp-pallet-chip" title="Pallet ${i + 1}">P${i + 1}</span>`).join('')}</div>
        <div class="mpp-op-meta">${palletLabel}${partialNote} · ${fmtMinutes(job.minPerPallet)} run/pal · ${fmtMinutes(runMins)} run total</div>
        <div class="mpp-op-pcs"><strong>${pcs} pc</strong> this cycle</div>
      </div>
    `;
  }

  function renderOpPool(job, { compact = false } = {}) {
    const schedulable = jobIsSchedulable(job);
    const rem = jobRemaining(job.jobId);
    const queued = jobQueuedDisplay(job);
    const partLine = !compact && job.partNo
      ? `<div class="mpp-op-part" title="${escapeHtml(job.partDesc || job.partNo)}">${escapeHtml(job.partNo)}</div>`
      : '';
    const psLine = compact
      ? ''
      : `<div class="mpp-op-ps">${escapeHtml(job.psId)}</div>`;
    const pref = job.preferredMachine
      ? `<div class="mpp-op-pref">Pref ${escapeHtml(job.preferredMachine)}</div>`
      : '';
    const qtyLine = mppOpQtyLine(job, { schedulable, rem, queued });
    const partialHint = schedulable && isPartialNextPallet(job.jobId)
      ? ` · partial ${nextPalletPcs(job.jobId)} pc ok`
      : '';
    const actionHtml = schedulable
      ? `<div class="mpp-op-actions-row">
          <button type="button" class="btn btn-ghost btn-sm mpp-schedule-btn" data-action="schedule-job"
            data-job-id="${escapeHtml(job.jobId)}">Schedule to MPP…</button>
          <button type="button" class="btn btn-ghost btn-sm mpp-op-calc-btn" data-action="extra-calc"
            data-job-id="${escapeHtml(job.jobId)}" data-ps-id="${escapeHtml(job.psId)}"
            title="1-cycle expected output">Calc</button>
          <button type="button" class="btn btn-ghost btn-sm mpp-probation-btn" data-action="add-probation"
            data-job-id="${escapeHtml(job.jobId)}" title="Reserve capacity without scheduling a cycle">Probation</button>
        </div>`
      : `<div class="mpp-op-actions-row">
          <p class="mpp-op-blocked-reason">${escapeHtml(job.blockedReason || 'Not schedulable')}</p>
          <button type="button" class="btn btn-ghost btn-sm mpp-op-calc-btn" data-action="extra-calc"
            data-job-id="${escapeHtml(job.jobId)}" data-ps-id="${escapeHtml(job.psId)}"
            title="1-cycle expected output">Calc</button>
          <button type="button" class="btn btn-ghost btn-sm mpp-probation-btn" data-action="add-probation"
            data-job-id="${escapeHtml(job.jobId)}" title="Still reserve machine time while waiting">Probation</button>
        </div>`;
    const selectedClass = job.jobId === extraJobId ? ' is-extra-selected' : '';
    return `
      <div class="mpp-op-card${job.isFrameAgreement ? ' mpp-op-card--fa' : ''}${compact ? ' mpp-op-card--compact' : ''}${schedulable ? '' : ' mpp-op-card--blocked'}${selectedClass}"${schedulable ? ' draggable="true"' : ''} data-drag-kind="pool" data-job-id="${escapeHtml(job.jobId)}">
        <div class="mpp-op-card-top">
          ${psLine}
          <div class="mpp-op-label">${escapeHtml(job.opLabel)}</div>
          ${schedulable ? `<button type="button" class="mpp-op-edit" data-action="edit-op-run" data-job-id="${escapeHtml(job.jobId)}" title="Edit run time / pcs / qty">✎</button>` : ''}
        </div>
        ${partLine}
        <div class="mpp-op-meta">${fmtMinutes(job.minPerPallet)} run/pal · ${job.pcsPerPallet} pc/pal${partialHint}</div>
        <div class="mpp-op-pcs" title="Rem = Qty − ERP acc − Queued on MPP lanes">${qtyLine}</div>
        ${pref}
        ${!compact && job.due ? `<div class="mpp-op-due">Due ${escapeHtml(job.due)}</div>` : ''}
        ${actionHtml}
        ${compact || !schedulable ? '' : `<p class="mpp-op-drag-hint">${isPartialNextPallet(job.jobId) ? `Drag leftover ${nextPalletPcs(job.jobId)} pc as a partial pallet` : 'Drag onto a cycle (even collapsed) — each drop = +1 pallet'}</p>`}
      </div>
    `;
  }

  function renderOpsList() {
    const list = document.getElementById('mpp-ops-list');
    if (!list) return;
    const pool = poolJobTemplates();
    const rawQuery = compactText(mppOpsSearch || document.getElementById('mpp-ops-search')?.value);
    if (!pool.length) {
      if ((jobsSource === 'frame_agreement' || jobsSource === 'process_sheets') && !jobsLoadError) {
        if (mppFaOnly && JOB_TEMPLATES.length && !frameAgreementPartCount) {
          list.innerHTML = '<p class="mpp-ops-empty">No frame agreement parts in master list. Turn off <strong>FA parts only</strong> to see other PS.</p>';
        } else if (mppFaOnly && JOB_TEMPLATES.length) {
          list.innerHTML = `<p class="mpp-ops-empty">No FA ops in the pool — ${JOB_TEMPLATES.length} other PS hidden. Turn off <strong>FA parts only</strong>.</p>`;
        } else if (mppFaOnly && !frameAgreementPartCount) {
          list.innerHTML = '<p class="mpp-ops-empty">No frame agreement parts in master list.</p>';
        } else if (mppFaOnly) {
          list.innerHTML = '<p class="mpp-ops-empty">No FA process sheets with MPP ops right now.</p>';
        } else {
          list.innerHTML = '<p class="mpp-ops-empty">No process sheets with MPP ops right now.</p>';
        }
      } else if (jobsLoadError) {
        list.innerHTML = `<p class="mpp-ops-empty">${escapeHtml(jobsLoadError)}</p>`;
      } else {
        list.innerHTML = '<p class="mpp-ops-empty">Loading process sheets…</p>';
      }
      syncShowCompletedToggle();
      syncFaOnlyToggle();
      return;
    }
    const allMatching = groupPoolJobs(pool).filter((group) => mppQueryMatchesBlob(mppGroupSearchBlob(group), rawQuery));
    const completedHidden = allMatching.filter(psGroupIsCompleted).length;
    const groups = mppShowCompleted ? allMatching : allMatching.filter((g) => !psGroupIsCompleted(g));
    if (!groups.length) {
      if (allMatching.length && completedHidden && !mppShowCompleted) {
        list.innerHTML = `<p class="mpp-ops-empty">Nothing left to drag — ${completedHidden} accounted PS hidden. Turn on <strong>Show accounted</strong> above.</p>`;
      } else {
        list.innerHTML = '<p class="mpp-ops-empty">No process sheets or ops match this search.</p>';
      }
      syncShowCompletedToggle();
      syncFaOnlyToggle();
      return;
    }
    syncMppPsExpandedFromDom(list);
    const forceOpen = Boolean(rawQuery);
    list.innerHTML = groups.map((group) => renderPsGroup(group, { forceOpen })).join('');
    if (rawQuery) applyMppOpsSearchFilter(rawQuery);
    syncShowCompletedToggle();
    syncFaOnlyToggle();
  }

  function renderShiftToggle(cycleId, shift, machine) {
    const supportsNight = machineSupportsShift(machine, 'night');
    const dayActive = shift === 'day' ? ' is-active' : '';
    const nightActive = shift === 'night' ? ' is-active' : '';
    const nightDisabled = supportsNight ? '' : ' disabled title="Night shift requires 24HR machine"';
    return `
      <div class="mpp-shift-toggle" role="group" aria-label="Cycle shift">
        <button type="button" class="mpp-shift-btn mpp-shift-btn--day${dayActive}"
          data-action="set-shift" data-cycle-id="${escapeHtml(cycleId)}" data-shift="day">Day</button>
        <button type="button" class="mpp-shift-btn mpp-shift-btn--night${nightActive}"${nightDisabled}
          data-action="set-shift" data-cycle-id="${escapeHtml(cycleId)}" data-shift="night">Night</button>
      </div>
    `;
  }

  function renderCycleTiming(cycle, item, idx, cycleMinutes) {
    const isFirst = idx === 0;
    const startLabel = cycle.anchor ? 'Anchor' : (isFirst ? 'Start' : 'Chains');
    const startTime = formatDt(item.start);
    const startEditable = isFirst || cycle.anchor;
    const overflowNote = item.overflows
      ? `<span class="mpp-timing-overflow" title="Cycle exceeds ${escapeHtml(item.shiftWindow)} window">⚠ spans shift</span>`
      : '';
    const startInner = startEditable
      ? `<button type="button" class="mpp-timing-cell mpp-timing-cell--btn${cycle.anchor ? ' is-anchored' : ''}"
          data-action="edit-anchor" data-cycle-id="${escapeHtml(cycle.cycleId)}"
          title="${cycle.anchor ? 'Edit anchor time' : 'Set anchor time'}">
          <span class="mpp-timing-kicker">${escapeHtml(startLabel)}</span>
          <span class="mpp-timing-value">${escapeHtml(startTime)}</span>
          <span class="trial-anchor-edit-icon" aria-hidden="true">✎</span>
        </button>`
      : `<div class="mpp-timing-cell">
          <span class="mpp-timing-kicker">${escapeHtml(startLabel)}</span>
          <span class="mpp-timing-value">${escapeHtml(startTime)}</span>
        </div>`;
    return `
      <div class="mpp-cycle-timing">
        <div class="mpp-cycle-timing-track">
          ${startInner}
          <div class="mpp-cycle-timing-mid" aria-hidden="true">
            <span class="mpp-cycle-timing-arrow">→</span>
            <span class="mpp-cycle-timing-duration">${escapeHtml(fmtMinutes(cycleMinutes))}</span>
            ${overflowNote}
          </div>
          <div class="mpp-timing-cell mpp-timing-cell--end">
            <span class="mpp-timing-kicker">End</span>
            <span class="mpp-timing-value">${escapeHtml(item.end)}</span>
          </div>
        </div>
      </div>
    `;
  }

  function renderCycleBox(machineId, item, { inRun = false, inRunAlt = false } = {}) {
    const machine = machineById(machineId);
    const { cycle, idx, metrics, shift } = item;
    const isCurrent = idx === 0;
    const isActive = cycle.cycleId === state.selectedCycleId;
    const queueLabel = isCurrent ? 'Now' : `#${idx + 1}`;
    const title = cycle.label || (metrics.opCount > 1 ? `${metrics.opCount} ops` : 'MPP cycle');
    const opsPills = cycleOpsPillsHtml(cycle);
    const inRunCls = inRun
      ? ` mpp-schedule-box--in-run${inRunAlt ? ' mpp-schedule-box--in-run-alt' : ''}`
      : '';
    return `
      <article class="mpp-schedule-box mpp-schedule-box--${escapeHtml(shift)} mpp-schedule-box--lane${isCurrent ? ' is-current' : ''} is-collapsed${isActive ? ' is-selected' : ''}${inRunCls}"
        data-cycle-id="${escapeHtml(cycle.cycleId)}" data-machine-id="${escapeHtml(machineId)}">
        <header class="mpp-schedule-head" draggable="true" data-drag-kind="box" title="Drag to reorder queue">
          <span class="mpp-schedule-grip">⠿</span>
          ${renderCycleOpenBtn(cycle.cycleId)}
          <span class="mpp-schedule-seq">${escapeHtml(queueLabel)}</span>
          ${renderShiftToggle(cycle.cycleId, shift, machine)}
          <span class="mpp-schedule-title">${escapeHtml(title)}</span>
          <span class="mpp-schedule-stats">${fmtMinutes(item.durationMin ?? metrics.cycleMinutes)}</span>
          <button type="button" class="trial-block-remove mpp-cycle-remove" data-action="remove-cycle"
            data-cycle-id="${escapeHtml(cycle.cycleId)}" title="Remove cycle">×</button>
        </header>
        <div class="mpp-schedule-collapsed-strip is-visible" data-drop-cycle="1"
          data-cycle-id="${escapeHtml(cycle.cycleId)}" data-action="open-cycle"
          title="Open cycle · drop op to add pallet">
          <div class="mpp-collapsed-ops">${opsPills}</div>
          <span class="mpp-collapsed-timing">${escapeHtml(formatDt(item.start))} → ${escapeHtml(item.end)}</span>
        </div>
      </article>
    `;
  }

  function renderCollapsedCycleRun(machineId, run, runIdx = 0) {
    const items = run.items;
    const first = items[0];
    const last = items[items.length - 1];
    const runKey = first.cycle.cycleId;
    const fingerprint = run.fingerprint;
    const count = items.length;
    const startIdx = first.idx;
    const endIdx = last.idx;
    const queueLabel = startIdx === 0 && count === 1
      ? 'Now'
      : (startIdx === endIdx ? `#${startIdx + 1}` : `#${startIdx + 1}–#${endIdx + 1}`);
    const { cycle, metrics, shift } = first;
    const opsPills = cycleOpsPillsHtml(cycle);
    const bandClass = runIdx % 2 ? 'mpp-cycle-run-band--b' : 'mpp-cycle-run-band--a';
    return `
      <article class="mpp-schedule-box mpp-schedule-box--${escapeHtml(shift)} mpp-schedule-run-stack is-collapsed-run mpp-cycle-run-band ${bandClass}"
        data-run-key="${escapeHtml(runKey)}" data-run-fp="${escapeHtml(fingerprint)}" data-machine-id="${escapeHtml(machineId)}">
        <header class="mpp-schedule-head">
          <button type="button" class="mpp-cycle-expand" data-action="toggle-cycle-run"
            data-machine-id="${escapeHtml(machineId)}" data-run-key="${escapeHtml(runKey)}" data-run-fp="${escapeHtml(fingerprint)}"
            aria-label="Expand ${count} cycles" title="Show all ${count} cycles in this lane">▸</button>
          <span class="mpp-schedule-seq">${escapeHtml(queueLabel)}</span>
          <span class="mpp-run-count">${count}×</span>
          <span class="mpp-shift-badge mpp-shift-badge--${escapeHtml(shift)}">${escapeHtml(MPP_SHIFT_META[shift]?.label || shift)}</span>
          <span class="mpp-schedule-stats">${fmtMinutes(metrics.cycleMinutes)}/cycle</span>
          <button type="button" class="btn btn-ghost btn-sm mpp-run-expand-btn" data-action="toggle-cycle-run"
            data-machine-id="${escapeHtml(machineId)}" data-run-key="${escapeHtml(runKey)}" data-run-fp="${escapeHtml(fingerprint)}">Show all…</button>
        </header>
        <div class="mpp-schedule-collapsed-strip is-visible" data-action="toggle-cycle-run"
          data-machine-id="${escapeHtml(machineId)}" data-run-key="${escapeHtml(runKey)}" data-run-fp="${escapeHtml(fingerprint)}"
          title="Show all ${count} cycles in this lane">
          <div class="mpp-collapsed-ops">${opsPills}</div>
          <span class="mpp-collapsed-timing">${escapeHtml(formatDt(first.start))} → ${escapeHtml(last.end)}</span>
        </div>
      </article>
    `;
  }

  function renderExpandedCycleRun(machineId, run, runIdx = 0) {
    const items = run.items;
    const first = items[0];
    const last = items[items.length - 1];
    const runKey = first.cycle.cycleId;
    const fingerprint = run.fingerprint;
    const count = items.length;
    const queueLabel = `#${first.idx + 1}–#${last.idx + 1}`;
    const { metrics, shift } = first;
    const bandClass = runIdx % 2 ? 'mpp-cycle-run-band--b' : 'mpp-cycle-run-band--a';
    const boxes = items
      .map((item, i) => renderCycleBox(machineId, item, { inRun: true, inRunAlt: i % 2 === 1 }))
      .join('');
    return `
      <div class="mpp-cycle-run-expanded mpp-cycle-run-band ${bandClass}"
        data-run-key="${escapeHtml(runKey)}" data-run-fp="${escapeHtml(fingerprint)}" data-machine-id="${escapeHtml(machineId)}">
        <div class="mpp-cycle-run-expanded-head">
          <div class="mpp-cycle-run-expanded-meta">
            <button type="button" class="mpp-cycle-expand" data-action="toggle-cycle-run"
              data-machine-id="${escapeHtml(machineId)}" data-run-key="${escapeHtml(runKey)}" data-run-fp="${escapeHtml(fingerprint)}"
              aria-label="Collapse cycle group" title="Collapse identical cycles">▾</button>
            <span class="mpp-schedule-seq">${escapeHtml(queueLabel)}</span>
            <span class="mpp-run-count-badge">${count}× identical</span>
            <span class="mpp-shift-badge mpp-shift-badge--${escapeHtml(shift)}">${escapeHtml(MPP_SHIFT_META[shift]?.label || shift)}</span>
            <span class="mpp-schedule-stats">${fmtMinutes(metrics.cycleMinutes)}/cycle</span>
            <span class="mpp-run-range-timing">${escapeHtml(formatDt(first.start))} → ${escapeHtml(last.end)}</span>
          </div>
          <button type="button" class="btn btn-ghost btn-sm mpp-run-expand-btn" data-action="toggle-cycle-run"
            data-machine-id="${escapeHtml(machineId)}" data-run-key="${escapeHtml(runKey)}" data-run-fp="${escapeHtml(fingerprint)}">Collapse</button>
        </div>
        <div class="mpp-cycle-run-expanded-body">${boxes}</div>
      </div>
    `;
  }

  function renderCycleRun(machineId, run, runIdx = 0) {
    if (run.items.length === 1) {
      return renderCycleBox(machineId, run.items[0]);
    }
    if (isRunExpanded(machineId, run.fingerprint, run.items[0]?.cycle?.cycleId)) {
      return renderExpandedCycleRun(machineId, run, runIdx);
    }
    return renderCollapsedCycleRun(machineId, run, runIdx);
  }

  function findRunContext(runKey, machineId = null, fingerprint = null) {
    const entries = machineId && state.machines[machineId]
      ? [[machineId, state.machines[machineId]]]
      : Object.entries(state.machines);
    for (const [mid, lane] of entries) {
      if (!lane) continue;
      const machine = machineById(mid);
      const scheduled = scheduleLane(lane, machine);
      const runs = groupIdenticalCycleRuns(scheduled);
      let run = runs.find((r) => r.items[0]?.cycle.cycleId === runKey);
      if (!run && fingerprint) {
        run = runs.find((r) => r.fingerprint === fingerprint && r.items.length > 1);
      }
      if (run) return { machineId: mid, machine, run, scheduled };
    }
    return null;
  }

  function closeCycleRunModal() {
    cycleRunModal = null;
    const el = document.getElementById('mpp-run-modal');
    if (el) el.hidden = true;
  }

  function openCycleRunModal(machineId, runKey) {
    if (!machineId || !runKey) return;
    const ctx = findRunContext(runKey, machineId);
    if (!ctx || ctx.run.items.length <= 1) return;
    cycleRunModal = {
      machineId,
      runKey: ctx.run.items[0].cycle.cycleId,
      fingerprint: ctx.run.fingerprint,
    };
    renderCycleRunModal();
    const el = document.getElementById('mpp-run-modal');
    if (el) el.hidden = false;
  }

  function renderCycleRunModalRow(machine, item, total) {
    const rowHtml = renderQueueManagerRow(machine, item, total);
    const openBtn = `<button type="button" class="btn btn-ghost btn-sm" data-action="open-cycle"
      data-cycle-id="${escapeHtml(item.cycle.cycleId)}">Open cycle</button>`;
    return rowHtml.replace(
      '<div class="mpp-queue-row-actions">',
      `<div class="mpp-queue-row-actions">${openBtn}`,
    );
  }

  function renderCycleRunModal() {
    const body = document.getElementById('mpp-run-modal-body');
    const title = document.getElementById('mpp-run-modal-title');
    const sub = document.getElementById('mpp-run-modal-sub');
    if (!cycleRunModal || !body || !title || !sub) return;
    const ctx = findRunContext(
      cycleRunModal.runKey,
      cycleRunModal.machineId,
      cycleRunModal.fingerprint,
    );
    if (!ctx || ctx.run.items.length <= 1) {
      closeCycleRunModal();
      return;
    }
    cycleRunModal.runKey = ctx.run.items[0].cycle.cycleId;
    cycleRunModal.fingerprint = ctx.run.fingerprint;
    const { machine, run, scheduled } = ctx;
    const first = run.items[0];
    const last = run.items[run.items.length - 1];
    const queueLabel = `#${first.idx + 1}–#${last.idx + 1}`;
    const summary = cycleOpsSummary(first.cycle);
    title.textContent = `${machine.code} — ${queueLabel}`;
    sub.textContent = `${run.items.length}× identical · ${escapeHtml(MPP_SHIFT_META[first.shift]?.label || first.shift)} · ${fmtMinutes(first.metrics.cycleMinutes)}/cycle · ${escapeHtml(summary)}`;
    body.innerHTML = `<div class="mpp-queue-list">${run.items.map((item, i) => `
      <div class="mpp-run-modal-row${i % 2 ? ' mpp-run-modal-row--alt' : ''}">
        ${renderCycleRunModalRow(machine, item, scheduled.length)}
      </div>
    `).join('')}</div>`;
  }

  function schedulablePoolJobs(query = '') {
    const q = compactText(query).toLowerCase();
    return poolJobTemplates().filter((job) => {
      if (!jobIsSchedulable(job)) return false;
      if (!canQueueAnyPcs(job.jobId)) return false;
      if (!q) return true;
      const blob = [job.psId, job.partNo, job.partDesc, job.opLabel].filter(Boolean).join(' ').toLowerCase();
      return blob.includes(q);
    });
  }

  function closeCycleAddOpModal() {
    cycleAddOpModalCycleId = null;
    cycleAddOpSearch = '';
    const el = document.getElementById('mpp-cycle-add-modal');
    if (el) el.hidden = true;
  }

  function openCycleAddOpModal(cycleId) {
    if (!findCycle(cycleId)) return;
    cycleAddOpModalCycleId = cycleId;
    cycleAddOpSearch = '';
    const search = document.getElementById('mpp-cycle-add-search');
    if (search) search.value = '';
    renderCycleAddOpModal();
    const el = document.getElementById('mpp-cycle-add-modal');
    if (el) el.hidden = false;
  }

  function renderCycleAddOpModal() {
    const list = document.getElementById('mpp-cycle-add-list');
    const sub = document.getElementById('mpp-cycle-add-sub');
    const found = cycleAddOpModalCycleId ? findCycle(cycleAddOpModalCycleId) : null;
    if (!found || !list || !sub) {
      closeCycleAddOpModal();
      return;
    }
    const machine = machineById(found.machineId);
    sub.textContent = `Add ops to ${machine.code} cycle — each click adds 1 pallet (partial leftover ok).`;
    const jobs = schedulablePoolJobs(cycleAddOpSearch);
    if (!jobs.length) {
      list.innerHTML = '<p class="mpp-cycle-add-empty">No schedulable ops match. Try another search, or check the op pool on the left.</p>';
      return;
    }
    list.innerHTML = jobs.map((job) => {
      const rem = jobRemaining(job.jobId);
      const nextPcs = nextPalletPcs(job.jobId);
      const btnLabel = isPartialNextPallet(job.jobId)
        ? `+1 partial (${nextPcs} pc)`
        : '+1 pallet';
      return `
      <div class="mpp-cycle-add-row">
        <div class="mpp-cycle-add-row-main">
          <div><strong>${escapeHtml(job.psId)}</strong> · ${escapeHtml(job.opLabel)}</div>
          ${job.partNo ? `<div class="mpp-cycle-add-part">${escapeHtml(job.partNo)}</div>` : ''}
          <div class="mpp-cycle-add-rem">Rem ${rem} pc</div>
        </div>
        <button type="button" class="btn btn-primary btn-sm" data-action="pick-op-pallet"
          data-job-id="${escapeHtml(job.jobId)}" data-cycle-id="${escapeHtml(cycleAddOpModalCycleId)}">${btnLabel}</button>
      </div>
    `;
    }).join('');
  }

  function closeCycleDetailModal() {
    cycleDetailModalCycleId = null;
    closeCycleAddOpModal();
    const el = document.getElementById('mpp-cycle-modal');
    if (el) el.hidden = true;
  }

  function openCycleDetailModal(cycleId) {
    if (!findCycle(cycleId)) return;
    cycleDetailModalCycleId = cycleId;
    renderCycleDetailModal();
    const el = document.getElementById('mpp-cycle-modal');
    if (el) el.hidden = false;
  }

  function renderCycleDetailModal() {
    const body = document.getElementById('mpp-cycle-modal-body');
    const title = document.getElementById('mpp-cycle-modal-title');
    const sub = document.getElementById('mpp-cycle-modal-sub');
    const found = cycleDetailModalCycleId ? findCycle(cycleDetailModalCycleId) : null;
    if (!found || !body || !title || !sub) {
      closeCycleDetailModal();
      return;
    }
    const machine = machineById(found.machineId);
    const item = scheduleLane(found.lane, machine).find((x) => x.cycle.cycleId === cycleDetailModalCycleId);
    if (!item) {
      closeCycleDetailModal();
      return;
    }
    const { cycle, idx, metrics, shift } = item;
    const queueLabel = idx === 0 ? 'Now' : `#${idx + 1}`;
    const summary = cycleOpsSummary(cycle);
    title.textContent = `${machine.code} — Cycle ${queueLabel}`;
    sub.textContent = `${escapeHtml(summary)} · ${escapeHtml(MPP_SHIFT_META[shift]?.label || shift)} · ${fmtMinutes(item.durationMin ?? metrics.cycleMinutes)}`;
    const opsHtml = metrics.rows.length
      ? metrics.rows.map(({ row, job }) => renderOpInCycle(job, row)).join('')
      : '<p class="mpp-queue-no-ops">No ops yet — use <strong>Add op from pool…</strong> below.</p>';
    const canAnchor = idx === 0 || cycle.anchor;
    body.innerHTML = `
      <div class="mpp-cycle-modal-head-row">
        ${renderShiftToggle(cycle.cycleId, shift, machine)}
        <span class="mpp-queue-duration">${escapeHtml(fmtMinutes(item.durationMin ?? metrics.cycleMinutes))}</span>
      </div>
      ${renderCycleTimingBar(cycle, metrics)}
      <div class="mpp-cycle-modal-ops">
        ${opsHtml}
      </div>
      <div class="mpp-cycle-modal-add">
        <button type="button" class="btn btn-ghost btn-sm" data-action="add-op-to-cycle"
          data-cycle-id="${escapeHtml(cycle.cycleId)}">Add op from pool…</button>
      </div>
      ${renderCycleTiming(cycle, item, idx, item.durationMin ?? metrics.cycleMinutes)}
      <div class="mpp-cycle-modal-actions">
        ${canAnchor ? `<button type="button" class="btn btn-ghost btn-sm" data-action="edit-anchor"
          data-cycle-id="${escapeHtml(cycle.cycleId)}">${cycle.anchor ? 'Edit anchor' : 'Set anchor'}</button>` : ''}
        ${metrics.opCount ? `<button type="button" class="btn btn-ghost btn-sm" data-action="replicate-cycle"
          data-cycle-id="${escapeHtml(cycle.cycleId)}">Replicate cycle…</button>` : ''}
        <button type="button" class="btn btn-ghost btn-sm" data-action="review-cycle"
          data-cycle-id="${escapeHtml(cycle.cycleId)}">Review calculation</button>
        <button type="button" class="trial-block-remove mpp-cycle-remove" data-action="remove-cycle"
          data-cycle-id="${escapeHtml(cycle.cycleId)}" title="Remove cycle">×</button>
      </div>
    `;
  }

  function refreshOpenModals() {
    if (queueManagerMachineId) renderQueueManagerModal();
    if (cycleRunModal) renderCycleRunModal();
    if (cycleDetailModalCycleId) renderCycleDetailModal();
    if (cycleAddOpModalCycleId) renderCycleAddOpModal();
  }

  function renderLanesOnly() {
    renderMachineFilters();
    renderLanes();
    if (reviewModalCycleId) renderReviewPanel(reviewModalCycleId);
  }

  function renderProbationCard(entry, machineId) {
    const job = getJob(entry.jobId);
    if (!job) return '';
    const mins = probationEntryMinutes(job, entry.palletCount);
    const blocked = !jobIsSchedulable(job);
    const palLabel = entry.palletCount === 1 ? '1 pal' : `${entry.palletCount} pal`;
    return `
      <div class="mpp-probation-card${blocked ? ' mpp-probation-card--blocked' : ''}" draggable="true"
        data-drag-kind="probation" data-entry-id="${escapeHtml(entry.entryId)}" data-machine-id="${escapeHtml(machineId)}">
        <div class="mpp-probation-card-top">
          <span class="mpp-probation-card-ps">${escapeHtml(job.psId)}</span>
          <button type="button" class="trial-block-remove mpp-op-remove" data-action="remove-probation"
            data-entry-id="${escapeHtml(entry.entryId)}" title="Remove from probation">×</button>
        </div>
        <div class="mpp-probation-card-label">${escapeHtml(job.opLabel)}</div>
        <div class="mpp-probation-card-meta">${palLabel} · ${fmtMinutes(mins)} est · ${opOutput(job, entry.palletCount)} pc</div>
        ${blocked ? `<div class="mpp-probation-card-note">${escapeHtml(job.blockedReason || 'Under probation')}</div>` : ''}
        <button type="button" class="btn btn-ghost btn-sm mpp-probation-promote" data-action="probation-pallet"
          data-entry-id="${escapeHtml(entry.entryId)}" title="Add one more pallet to this hold">+1 pal</button>
      </div>
    `;
  }

  function renderProbationBracket() {
    const grid = document.getElementById('mpp-probation-grid');
    const totalsEl = document.getElementById('mpp-probation-totals');
    if (!grid) return;
    const machines = visibleMachines();
    if (!machines.length) {
      grid.innerHTML = '<p class="mpp-probation-empty">No machine lanes visible.</p>';
      if (totalsEl) totalsEl.innerHTML = '';
      return;
    }
    let fleetScheduled = 0;
    let fleetProbation = 0;
    grid.innerHTML = machines.map((machine) => {
      const cap = machineCapacitySummary(machine.id);
      fleetScheduled += cap.scheduledMin;
      fleetProbation += cap.probationMin;
      const entries = state.probation?.[machine.id] || [];
      const cards = entries.length
        ? entries.map((entry) => renderProbationCard(entry, machine.id)).join('')
        : '<p class="mpp-probation-lane-empty">Drop ops here — reserves capacity before you schedule cycles.</p>';
      return `
        <div class="mpp-probation-lane" data-machine-id="${escapeHtml(machine.id)}">
          <header class="mpp-probation-lane-head">
            <span class="mpp-probation-lane-title">${escapeHtml(machine.code)}</span>
            <span class="mpp-probation-lane-stats" title="Queued + probation = total load">
              Q ${fmtMinutes(cap.scheduledMin)} + P ${fmtMinutes(cap.probationMin)} = <strong>${fmtMinutes(cap.totalMin)}</strong>
            </span>
          </header>
          <div class="mpp-probation-drop" data-drop-probation="1" data-machine-id="${escapeHtml(machine.id)}">${cards}</div>
        </div>
      `;
    }).join('');
    if (totalsEl) {
      const fleetTotal = fleetScheduled + fleetProbation;
      totalsEl.innerHTML = fleetTotal > 0
        ? `<span>Fleet queued <strong>${fmtMinutes(fleetScheduled)}</strong></span>
           <span>Probation <strong>${fmtMinutes(fleetProbation)}</strong></span>
           <span>Total load <strong>${fmtMinutes(fleetTotal)}</strong></span>`
        : '<span class="mpp-probation-totals-empty">No queued or probation load yet.</span>';
    }
  }

  function renderMachine(machine) {
    const lane = state.machines[machine.id];
    const scheduled = scheduleLane(lane, machine);
    const summary = laneQueueSummary(lane, machine);
    const cap = machineCapacitySummary(machine.id);
    const runs = groupIdenticalCycleRuns(scheduled);
    const boxes = runs.map((run, runIdx) => renderCycleRun(machine.id, run, runIdx)).join('');
    return `
      <section class="mpp-machine" data-machine-id="${escapeHtml(machine.id)}">
        <header class="mpp-machine-head">
          <div class="mpp-machine-title-row">
            <div class="mpp-machine-title">${escapeHtml(machine.code)}</div>
            <span class="mpp-machine-queue-count">${summary.count} cycle${summary.count === 1 ? '' : 's'} in queue</span>
            <button type="button" class="btn btn-ghost btn-sm mpp-manage-queue-btn" data-action="manage-queue"
              data-machine-id="${escapeHtml(machine.id)}">Manage queue</button>
          </div>
          <div class="mpp-machine-meta">${escapeHtml(machine.category)} · ${escapeHtml(machine.shift)}</div>
          <div class="mpp-machine-capacity" title="Queued cycles + probation holds">
            <span>Queued <strong>${fmtMinutes(cap.scheduledMin)}</strong></span>
            <span>Probation <strong>${fmtMinutes(cap.probationMin)}</strong></span>
            <span>Total <strong>${fmtMinutes(cap.totalMin)}</strong></span>
          </div>
          <div class="mpp-machine-availability">
            Next available <strong>${escapeHtml(summary.nextEnd || '—')}</strong>
          </div>
        </header>
        <div class="mpp-machine-lane" data-machine-id="${escapeHtml(machine.id)}" data-drop-lane="1">
          ${boxes}
          <div class="mpp-lane-drop card"><span>Drop on a cycle to add pallets (1 per drop). Drop here to <strong>start a new cycle</strong> — or continue the last cycle you added to.</span></div>
          <div class="mpp-new-cycle-actions">
            <button type="button" class="btn btn-ghost btn-sm mpp-new-box-btn mpp-new-box-btn--day" data-action="new-cycle" data-machine-id="${escapeHtml(machine.id)}" data-shift="day">+ Day cycle</button>
            ${machineSupportsShift(machine, 'night')
    ? `<button type="button" class="btn btn-ghost btn-sm mpp-new-box-btn mpp-new-box-btn--night" data-action="new-cycle" data-machine-id="${escapeHtml(machine.id)}" data-shift="night">+ Night cycle</button>`
    : ''}
          </div>
        </div>
      </section>
    `;
  }

  function renderMachineFilters() {
    const el = document.getElementById('mpp-machine-filters');
    if (!el) return;
    if (!MACHINES.length) {
      el.innerHTML = '';
      return;
    }
    const chips = MACHINES.map((machine) => {
      const on = isMachineVisible(machine.id);
      return `<button type="button" class="mpp-machine-filter${on ? ' is-on' : ''}"
        data-action="toggle-machine" data-machine-id="${escapeHtml(machine.id)}"
        aria-pressed="${on ? 'true' : 'false'}" title="${on ? 'Hide' : 'Show'} ${escapeHtml(machine.code)} lane">
        ${escapeHtml(machine.code)}
      </button>`;
    }).join('');
    el.innerHTML = `<span class="mpp-machine-filters-label">Show</span>${chips}`;
  }

  function renderLanes() {
    const root = document.getElementById('mpp-lanes');
    if (!root) return;
    const machines = visibleMachines();
    if (!machines.length) {
      root.innerHTML = '<p class="mpp-lanes-empty">No machine lanes visible — toggle machines above to show queues.</p>';
      return;
    }
    root.innerHTML = machines.map(renderMachine).join('');
  }

  function closeReviewPanel() {
    reviewModalCycleId = null;
    const modal = document.getElementById('mpp-review-modal');
    if (modal) modal.hidden = true;
  }

  function closeQueueManagerModal() {
    queueManagerMachineId = null;
    const el = document.getElementById('mpp-queue-modal');
    if (el) el.hidden = true;
  }

  function openQueueManagerModal(machineId) {
    if (!machineId || !state.machines[machineId]) return;
    queueManagerMachineId = machineId;
    renderQueueManagerModal();
    const el = document.getElementById('mpp-queue-modal');
    if (el) el.hidden = false;
  }

  function renderQueueManagerRow(machine, item, total) {
    const { cycle, idx, metrics, start, end, shift, overflows } = item;
    const queueLabel = idx === 0 ? 'Now' : `#${idx + 1}`;
    const opsHtml = metrics.rows.length
      ? metrics.rows.map(({ row, job }) => `
          <div class="mpp-queue-op-line">
            <span><strong>${escapeHtml(job.psId)}</strong> · ${escapeHtml(job.opLabel)} · ${row.palletCount} pal · ${opOutput(job, row.palletCount, row)} pc</span>
            <button type="button" class="trial-block-remove mpp-op-remove" data-action="remove-op"
              data-op-id="${escapeHtml(row.opId)}" title="Remove op from cycle" aria-label="Remove op">×</button>
          </div>
        `).join('')
      : '<span class="mpp-queue-no-ops">No ops — drag from the left or use Schedule to MPP…</span>';
    const canAnchor = idx === 0 || cycle.anchor;
    return `
      <article class="mpp-queue-row mpp-queue-row--${escapeHtml(shift)}${idx === 0 ? ' is-current' : ''}" data-cycle-id="${escapeHtml(cycle.cycleId)}">
        <div class="mpp-queue-row-main">
          <div class="mpp-queue-row-head">
            <span class="mpp-queue-pos">${escapeHtml(queueLabel)}</span>
            ${renderShiftToggle(cycle.cycleId, shift, machine)}
            <span class="mpp-queue-duration">${escapeHtml(fmtMinutes(item.durationMin ?? metrics.cycleMinutes))}</span>
            <div class="mpp-queue-reorder">
              <button type="button" class="mpp-queue-move" data-action="queue-move-up" data-cycle-id="${escapeHtml(cycle.cycleId)}"
                title="Move earlier in queue" aria-label="Move up"${idx === 0 ? ' disabled' : ''}>↑</button>
              <button type="button" class="mpp-queue-move" data-action="queue-move-down" data-cycle-id="${escapeHtml(cycle.cycleId)}"
                title="Move later in queue" aria-label="Move down"${idx >= total - 1 ? ' disabled' : ''}>↓</button>
            </div>
          </div>
          <div class="mpp-queue-timing${overflows ? ' is-overflow' : ''}">
            ${escapeHtml(start)} → ${escapeHtml(end)}${overflows ? ' · exceeds shift window' : ''}
          </div>
          <div class="mpp-queue-ops">${opsHtml}</div>
        </div>
        <div class="mpp-queue-row-actions">
          ${canAnchor ? `<button type="button" class="btn btn-ghost btn-sm" data-action="edit-anchor"
            data-cycle-id="${escapeHtml(cycle.cycleId)}">${cycle.anchor ? 'Edit anchor' : 'Set anchor'}</button>` : ''}
          ${metrics.opCount ? `<button type="button" class="btn btn-ghost btn-sm" data-action="replicate-cycle"
            data-cycle-id="${escapeHtml(cycle.cycleId)}">Replicate…</button>` : ''}
          <button type="button" class="btn btn-ghost btn-sm" data-action="review-cycle"
            data-cycle-id="${escapeHtml(cycle.cycleId)}">Review</button>
          <button type="button" class="trial-block-remove mpp-cycle-remove" data-action="remove-cycle"
            data-cycle-id="${escapeHtml(cycle.cycleId)}" title="Remove cycle">×</button>
        </div>
      </article>
    `;
  }

  function renderQueueManagerModal() {
    const machineId = queueManagerMachineId;
    const body = document.getElementById('mpp-queue-modal-body');
    const foot = document.getElementById('mpp-queue-modal-foot');
    const title = document.getElementById('mpp-queue-modal-title');
    const sub = document.getElementById('mpp-queue-modal-sub');
    if (!machineId || !body || !foot || !title || !sub) return;
    const machine = machineById(machineId);
    const lane = state.machines[machineId];
    if (!machine || !lane) {
      closeQueueManagerModal();
      return;
    }
    title.textContent = `${machine.code} — Queue manager`;
    const scheduled = scheduleLane(lane, machine);
    const summary = laneQueueSummary(lane, machine);
    sub.textContent = `${summary.count} cycle${summary.count === 1 ? '' : 's'} queued · Next available ${summary.nextEnd || '—'} · ${escapeHtml(machine.category)} · ${escapeHtml(machine.shift)}`;
    body.innerHTML = scheduled.length
      ? `<div class="mpp-queue-list">${scheduled.map((item) => renderQueueManagerRow(machine, item, scheduled.length)).join('')}</div>`
      : '<p class="mpp-queue-empty">No cycles in queue. Add a day or night cycle below, or drag ops from the left.</p>';
    foot.innerHTML = `
      <button type="button" class="btn btn-ghost btn-sm mpp-new-box-btn mpp-new-box-btn--day" data-action="new-cycle"
        data-machine-id="${escapeHtml(machine.id)}" data-shift="day">+ Day cycle</button>
      ${machineSupportsShift(machine, 'night')
    ? `<button type="button" class="btn btn-ghost btn-sm mpp-new-box-btn mpp-new-box-btn--night" data-action="new-cycle"
        data-machine-id="${escapeHtml(machine.id)}" data-shift="night">+ Night cycle</button>`
    : ''}
    `;
  }

  function moveCycleInQueue(cycleId, direction) {
    const found = findCycle(cycleId);
    if (!found) return;
    const delta = direction === 'up' ? -1 : 1;
    const toIdx = found.index + delta;
    if (toIdx < 0 || toIdx >= found.lane.cycles.length) return;
    reorderCycle(found.machineId, found.index, toIdx);
  }

  function renderReviewPanel(cycleId) {
    const modal = document.getElementById('mpp-review-modal');
    const body = document.getElementById('mpp-review-body');
    const found = findCycle(cycleId);
    if (!modal || !body || !found) { closeReviewPanel(); return; }
    reviewModalCycleId = cycleId;
    const { cycle } = found;
    const item = scheduleLane(found.lane, machineById(found.machineId)).find((x) => x.cycle.cycleId === cycleId);
    const metrics = cycleMetrics(cycle);
    const sprintSetup = item?.sprintSetupMinutes ?? 0;
    const t = metrics.timing;
    const rows = metrics.rows.map(({ row, job }, i) => {
      const runMins = metrics.runMins[i] ?? jobRunMinutes(job, row.palletCount);
      return `
      <div class="mpp-review-row">
        <strong>${escapeHtml(job.psId)}</strong> ${escapeHtml(job.opLabel)}<br>
        Run <strong>${fmtMinutes(runMins)}</strong>
        · ${row.palletCount} × ${opPcsPerPallet(row, job)} pc = <strong>${opOutput(job, row.palletCount, row)} pc</strong>
      </div>
    `;
    }).join('');
    const runLabel = t.sequential && metrics.opCount > 1 ? 'Run total (sequential)' : 'Run (longest op)';
    body.innerHTML = `
      ${rows || '<p>No ops in this cycle.</p>'}
      <div class="mpp-review-total">
        <div>Shift: <strong>${escapeHtml(item?.shiftLabel || MPP_SHIFT_META.day.label)}</strong> (${escapeHtml(item?.shiftWindow || '')})</div>
        <div>Load <strong>${fmtMinutes(t.load)}</strong> · ${runLabel} <strong>${fmtMinutes(metrics.runBlock)}</strong> · Unload <strong>${fmtMinutes(t.unload)}</strong></div>
        <div>Cycle duration: <strong>${fmtMinutes(metrics.cycleMinutes)}</strong></div>
        ${sprintSetup > 0 ? `<div>Sprint setup${t.setupPerOp && metrics.opCount > 1 ? ' (per op)' : ''}: <strong>${fmtMinutes(sprintSetup)}</strong></div>` : ''}
        ${item?.durationMin != null ? `<div>Queued slot incl. setup: <strong>${fmtMinutes(item.durationMin)}</strong></div>` : ''}
        ${item?.overflows ? '<div class="mpp-review-overflow">⚠ Cycle duration exceeds this shift window</div>' : ''}
        ${item ? `<div>Start ${escapeHtml(item.start)} → End ${escapeHtml(item.end)}</div>` : ''}
        ${cycle.anchor ? `<div>Anchor: ${escapeHtml(formatDt(cycle.anchor))}</div>` : ''}
      </div>
    `;
    modal.hidden = false;
  }

  function render() {
    pruneAllEmptyCycles();
    renderOpsList();
    renderMachineFilters();
    renderLanes();
    renderProbationBracket();
    syncSidebarCollapsedUi();
    if (!mppExtraCollapsed && extraJobId && document.activeElement?.closest?.('#mpp-extra-body')) {
      extraDraft = readExtraDraftFromDom() || extraDraft;
      updateExtraPreview();
      syncExtraCollapsedUi();
    } else {
      if (!mppExtraCollapsed && extraJobId && document.getElementById('mpp-extra-pallets')) {
        extraDraft = readExtraDraftFromDom() || extraDraft;
      }
      renderExtraPanel();
    }
    updateJobsStatusLine();
    refreshOpenModals();
    if (reviewModalCycleId) renderReviewPanel(reviewModalCycleId);
    scheduleQueueSave();
  }

  function findOpInCycle(cycle, jobId, pcsPerPallet = null) {
    const ops = cycle.ops || [];
    if (pcsPerPallet == null) return ops.find((o) => o.jobId === jobId);
    const target = Number(pcsPerPallet);
    return ops.find((o) => {
      if (o.jobId !== jobId) return false;
      return opPcsPerPallet(o, getJob(jobId)) === target;
    });
  }

  function pruneEmptyCycles(lane) {
    if (!lane?.cycles?.length) return;
    const keepId = state.selectedCycleId;
    lane.cycles = lane.cycles.filter(
      (c) => (c.ops || []).length > 0 || c.cycleId === keepId,
    );
  }

  function pruneAllEmptyCycles() {
    Object.values(state.machines).forEach(pruneEmptyCycles);
  }

  /** Lane drop adds to last cycle when it is empty or still the active build target. */
  function resolveLaneDropCycleId(machineId) {
    const lane = state.machines[machineId];
    const cycles = lane?.cycles || [];
    if (!cycles.length) return null;
    const last = cycles[cycles.length - 1];
    if (!(last.ops || []).length) return last.cycleId;
    if (state.selectedCycleId === last.cycleId) return last.cycleId;
    return null;
  }

  function activateCycle(cycleId, idx = -1) {
    state.selectedCycleId = cycleId;
    if (idx > 0) {
      mppExpandedCycleSet().add(cycleId);
      saveMppExpandedCycles();
    }
  }

  function addPalletToCycle(cycleId, jobId, { renderAfter = true } = {}) {
    const job = getJob(jobId);
    const found = findCycle(cycleId);
    if (!job || !found) return false;
    const pcs = nextPalletPcs(jobId);
    if (pcs < 1) return false;
    const existing = findOpInCycle(found.cycle, jobId, pcs);
    if (existing) {
      existing.palletCount += 1;
    } else {
      found.cycle.ops = [...(found.cycle.ops || []), newCycleOp(jobId, 1, job, pcs)];
      seedCycleTimingFromJob(found.cycle, job);
    }
    syncCycleSequentialFlag(found.cycle);
    activateCycle(cycleId, found.index);
    markMachineDirty(found.machineId);
    if (renderAfter) render();
    return true;
  }

  function newCyclePayload(machineId, shift) {
    const machine = machineById(machineId);
    return normalizeCycle({
      cycleId: newId('c'),
      anchor: null,
      shift: normalizeShift(shift || defaultShiftForMachine(machine), machine),
      setupMinutes: 0,
      loadMinPerCycle: MPP_DEFAULT_LOAD_MIN_PER_CYCLE,
      unloadMinPerCycle: MPP_DEFAULT_UNLOAD_MIN_PER_CYCLE,
      sequential: false,
      setupPerOp: false,
      ops: [],
    });
  }

  function addPalletAsNewCycle(machineId, jobId, shift) {
    const job = getJob(jobId);
    const lane = state.machines[machineId];
    const pcs = nextPalletPcs(jobId);
    if (!job || !lane || pcs < 1) return;
    const cycle = newCyclePayload(machineId, shift);
    cycle.ops = [newCycleOp(jobId, 1, job, pcs)];
    seedCycleTimingFromJob(cycle, job);
    syncCycleSequentialFlag(cycle);
    lane.cycles = [...(lane.cycles || []), cycle];
    activateCycle(cycle.cycleId, lane.cycles.length - 1);
    markMachineDirty(machineId);
    render();
  }

  /**
   * Schedule-to-MPP plan: full pallets first, then one final partial pallet for leftover rem
   * (e.g. 10 pc rem @ 3 pc/pal → 3×1-pal @ 3 pc + 1×1-pal @ 2 pc).
   */
  function planBulkScheduleCycles(qty, rem, palletsPerCycle, pcsPerPallet) {
    const effectivePcs = Math.max(1, Number(pcsPerPallet) || 1);
    const palPerCycle = Math.max(1, Math.floor(Number(palletsPerCycle) || 1));
    let left = Math.min(Math.max(0, Number(qty) || 0), Math.max(0, Number(rem) || 0));
    const maxPerCycle = palPerCycle * effectivePcs;
    const cycles = [];
    while (left >= effectivePcs) {
      const cyclePcs = Math.min(left, maxPerCycle);
      const pallets = Math.min(palPerCycle, Math.floor(cyclePcs / effectivePcs));
      if (pallets < 1) break;
      cycles.push({ palletCount: pallets, pcsPerPallet: effectivePcs });
      left -= pallets * effectivePcs;
    }
    let partialPcs = 0;
    if (left > 0) {
      partialPcs = left;
      cycles.push({ palletCount: 1, pcsPerPallet: left });
      left = 0;
    }
    return {
      cycles,
      palletCounts: cycles.map((c) => c.palletCount),
      scheduledPcs: cycles.reduce((sum, c) => sum + c.palletCount * c.pcsPerPallet, 0),
      leftoverPcs: 0,
      partialPcs,
      effectivePcs,
      palPerCycle,
    };
  }

  function bulkScheduleJob(machineId, jobId, { palletsPerCycle, minPerPallet, pcsPerPallet, qty, shift }) {
    const job = getJob(jobId);
    const lane = state.machines[machineId];
    const machine = machineById(machineId);
    if (!job || !lane) return;
    const effectivePcs = Math.max(1, Number(pcsPerPallet) || Number(job.pcsPerPallet) || 1);
    job.minPerPallet = minPerPallet;
    job.pcsPerPallet = effectivePcs;
    state.jobs[jobId] = job;
    const cycleShift = normalizeShift(shift || defaultShiftForMachine(machine), machine);
    const plan = planBulkScheduleCycles(qty, jobRemaining(jobId), palletsPerCycle, effectivePcs);
    plan.cycles.forEach((spec) => {
      const cycle = normalizeCycle({
        cycleId: newId('c'),
        anchor: null,
        shift: cycleShift,
        setupMinutes: Math.max(0, Number(job.setupMinutes) || 0),
        loadMinPerCycle: MPP_DEFAULT_LOAD_MIN_PER_CYCLE,
        unloadMinPerCycle: MPP_DEFAULT_UNLOAD_MIN_PER_CYCLE,
        sequential: false,
        setupPerOp: false,
        ops: [newCycleOp(jobId, spec.palletCount, job, spec.pcsPerPallet)],
      });
      lane.cycles = [...(lane.cycles || []), cycle];
    });
    markMachineDirty(machineId);
    render();
  }

  function cloneCycleTemplate(cycle, machine) {
    normalizeCycle(cycle);
    return normalizeCycle({
      cycleId: newId('c'),
      label: cycle.label || null,
      anchor: null,
      shift: normalizeShift(cycle.shift, machine),
      setupMinutes: cycle.setupMinutes,
      loadMinPerCycle: cycle.loadMinPerCycle,
      unloadMinPerCycle: cycle.unloadMinPerCycle,
      sequential: cycle.sequential,
      setupPerOp: cycle.setupPerOp,
      ops: (cycle.ops || []).map((row) => ({
        opId: newId('op'),
        jobId: row.jobId,
        palletCount: row.palletCount,
        pcsPerPallet: opPcsPerPallet(row, getJob(row.jobId)),
      })),
    });
  }

  function cycleReplicationLimits(cycle) {
    const ops = (cycle.ops || []).filter((o) => Number(o.palletCount || 0) > 0);
    if (!ops.length) return { maxAdditional: 0, perOp: [] };
    const perOp = ops.map((row) => {
      const job = getJob(row.jobId);
      const pcsPerRep = opOutput(job, row.palletCount, row);
      const rem = jobRemaining(row.jobId);
      const maxForJob = pcsPerRep > 0 ? Math.floor(rem / pcsPerRep) : 0;
      return {
        jobId: row.jobId,
        psId: job?.psId || row.jobId,
        opLabel: job?.opLabel || '',
        palletCount: row.palletCount,
        pcsPerRep,
        rem,
        maxForJob,
      };
    });
    const maxAdditional = perOp.reduce((min, x) => Math.min(min, x.maxForJob), perOp[0]?.maxForJob ?? 0);
    const limiting = perOp.find((x) => x.maxForJob === maxAdditional);
    return { maxAdditional, perOp, limiting };
  }

  function replicateCycle(cycleId, count) {
    const found = findCycle(cycleId);
    if (!found || count <= 0) return 0;
    const limits = cycleReplicationLimits(found.cycle);
    const n = Math.min(count, limits.maxAdditional);
    if (n <= 0) return 0;
    const clones = Array.from({ length: n }, () => cloneCycleTemplate(found.cycle, machineById(found.machineId)));
    const cycles = [...found.lane.cycles];
    cycles.splice(found.index + 1, 0, ...clones);
    found.lane.cycles = cycles;
    return n;
  }

  function removeOp(opId) {
    const loc = findOpEntry(opId);
    if (!loc) return;
    const found = findCycle(loc.cycleId);
    if (!found) return;
    found.cycle.ops = found.cycle.ops.filter((o) => o.opId !== opId);
    syncCycleSequentialFlag(found.cycle);
    if (!found.cycle.ops.length) {
      found.lane.cycles = found.lane.cycles.filter((c) => c.cycleId !== loc.cycleId);
      if (cycleDetailModalCycleId === loc.cycleId) closeCycleDetailModal();
    }
    markMachineDirty(found.machineId);
    render();
  }

  function removeCycle(cycleId) {
    const found = findCycle(cycleId);
    if (!found) return;
    found.lane.cycles = found.lane.cycles.filter((c) => c.cycleId !== cycleId);
    if (cycleDetailModalCycleId === cycleId) closeCycleDetailModal();
    if (reviewModalCycleId === cycleId) closeReviewPanel();
    markMachineDirty(found.machineId);
    render();
  }

  function newEmptyCycle(machineId, shift) {
    const lane = state.machines[machineId];
    if (!lane) return;
    const cycle = newCyclePayload(machineId, shift);
    lane.cycles = [...(lane.cycles || []), cycle];
    activateCycle(cycle.cycleId, lane.cycles.length - 1);
    markMachineDirty(machineId);
    render();
  }

  function setCycleShift(cycleId, shift) {
    const found = findCycle(cycleId);
    if (!found) return;
    const machine = machineById(found.machineId);
    const next = normalizeShift(shift, machine);
    if (found.cycle.shift === next) return;
    found.cycle.shift = next;
    markMachineDirty(found.machineId);
    render();
  }

  function reorderCycle(machineId, fromIdx, toIdx) {
    const lane = state.machines[machineId];
    if (!lane || fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    const cycles = [...lane.cycles];
    const [moved] = cycles.splice(fromIdx, 1);
    cycles.splice(toIdx, 0, moved);
    lane.cycles = cycles;
    markMachineDirty(machineId);
    render();
  }

  function moveOpToCycle(opId, targetCycleId) {
    const loc = findOpEntry(opId);
    const target = findCycle(targetCycleId);
    const src = loc ? findCycle(loc.cycleId) : null;
    if (!loc || !target || !src || loc.cycleId === targetCycleId) return;
    const [row] = src.cycle.ops.splice(loc.opIndex, 1);
    if (!src.cycle.ops.length) {
      src.lane.cycles = src.lane.cycles.filter((c) => c.cycleId !== loc.cycleId);
    }
    const existing = findOpInCycle(target.cycle, row.jobId);
    if (existing) {
      existing.palletCount += row.palletCount;
    } else {
      target.cycle.ops = [...(target.cycle.ops || []), row];
    }
    markMachineDirty(src.machineId);
    if (target.machineId !== src.machineId) markMachineDirty(target.machineId);
    render();
  }

  function closeModal() {
    ['mpp-setup-modal', 'mpp-schedule-modal', 'mpp-anchor-modal', 'mpp-replicate-modal', 'mpp-ps-detail-modal'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    const repSave = document.getElementById('mpp-replicate-modal-save');
    if (repSave) repSave.disabled = false;
    state.modal = null;
    refreshOpenModals();
  }

  function openReplicateModal(cycleId) {
    const found = findCycle(cycleId);
    const form = document.getElementById('mpp-replicate-modal-form');
    const sub = document.getElementById('mpp-replicate-modal-sub');
    if (!found || !form || !sub) return;
    const { cycle } = found;
    const limits = cycleReplicationLimits(cycle);
    const metrics = cycleMetrics(cycle);
    if (!limits.maxAdditional) {
      sub.textContent = 'No remaining quantity to replicate this cycle — all process sheets are fully scheduled for this pattern.';
      form.innerHTML = `<div class="mpp-form-derived">Remove a queued cycle or free up qty with <strong>×</strong> on an op to replicate again.</div>`;
      document.getElementById('mpp-replicate-modal-save').disabled = true;
    } else {
      document.getElementById('mpp-replicate-modal-save').disabled = false;
      sub.textContent = `Duplicate this ${fmtMinutes(metrics.cycleMinutes)} ${escapeHtml(MPP_SHIFT_META[normalizeShift(cycle.shift, machineById(found.machineId))]?.label?.toLowerCase() || 'cycle')} cycle (${limits.perOp.length} op${limits.perOp.length === 1 ? '' : 's'}) into the queue behind it.`;
      const opRows = limits.perOp.map((row) => `
        <div class="mpp-replicate-op-row">
          <strong>${escapeHtml(row.psId)}</strong> · ${row.palletCount} pal → <strong>${row.pcsPerRep} pc</strong>/cycle
          · <span class="mpp-replicate-rem">${row.rem} pc left</span>
          · up to <strong>${row.maxForJob}</strong> more
        </div>
      `).join('');
      const limitNote = limits.limiting
        ? `<p class="mpp-replicate-limit">Max <strong>${limits.maxAdditional}</strong> replicas — limited by <strong>${escapeHtml(limits.limiting.psId)}</strong> (${limits.limiting.rem} pc remaining).</p>`
        : '';
      form.innerHTML = `
        <div class="mpp-replicate-ops">${opRows}</div>
        ${limitNote}
        <div class="mpp-replicate-mode">
          <label class="mpp-replicate-mode-opt">
            <input type="radio" name="mpp-replicate-mode" value="max" checked>
            <span><strong>Max out</strong> — queue ${limits.maxAdditional} identical cycle${limits.maxAdditional === 1 ? '' : 's'}</span>
          </label>
          <label class="mpp-replicate-mode-opt">
            <input type="radio" name="mpp-replicate-mode" value="count">
            <span><strong>Choose count</strong></span>
          </label>
          <label class="mpp-replicate-count-wrap">
            Number of replicas
            <input id="mpp-replicate-count" type="number" min="1" max="${limits.maxAdditional}" step="1" value="${Math.min(1, limits.maxAdditional)}" disabled>
          </label>
        </div>
        <div class="mpp-form-derived" id="mpp-replicate-preview">
          Will add <strong>${limits.maxAdditional}</strong> cycle box${limits.maxAdditional === 1 ? '' : 'es'} after this one.
        </div>
      `;
      const modeInputs = form.querySelectorAll('input[name="mpp-replicate-mode"]');
      const countInput = form.querySelector('#mpp-replicate-count');
      const preview = form.querySelector('#mpp-replicate-preview');
      const syncMode = () => {
        const isCount = form.querySelector('input[name="mpp-replicate-mode"][value="count"]')?.checked;
        if (countInput) {
          countInput.disabled = !isCount;
          if (isCount && Number(countInput.value || 0) < 1) countInput.value = '1';
        }
        const n = isCount
          ? Math.min(limits.maxAdditional, Math.max(1, Number(countInput?.value || 1)))
          : limits.maxAdditional;
        if (preview) {
          preview.innerHTML = `Will add <strong>${n}</strong> cycle box${n === 1 ? '' : 'es'} after this one.`;
        }
      };
      modeInputs.forEach((el) => el.addEventListener('change', syncMode));
      countInput?.addEventListener('input', syncMode);
    }
    state.modal = { type: 'replicate', cycleId, maxAdditional: limits.maxAdditional };
    document.getElementById('mpp-replicate-modal').hidden = false;
  }

  function saveReplicateModal() {
    if (state.modal?.type !== 'replicate') return;
    const form = document.getElementById('mpp-replicate-modal-form');
    const isCount = form?.querySelector('input[name="mpp-replicate-mode"][value="count"]')?.checked;
    const count = isCount
      ? Number(document.getElementById('mpp-replicate-count')?.value || 0)
      : state.modal.maxAdditional;
    const cycleId = state.modal.cycleId;
    const added = replicateCycle(cycleId, count);
    const found = added > 0 ? findCycle(cycleId) : null;
    closeModal();
    if (added > 0 && found) {
      markMachineDirty(found.machineId);
      render();
    }
  }

  function openCycleTimingModal(cycleId) {
    const found = findCycle(cycleId);
    const form = document.getElementById('mpp-setup-modal-form');
    const sub = document.getElementById('mpp-setup-modal-sub');
    const title = document.querySelector('#mpp-setup-modal .mpp-modal-title');
    if (!found || !form || !sub) return;
    const { cycle } = found;
    normalizeCycle(cycle);
    const metrics = cycleMetrics(cycle);
    const t = cycleTiming(cycle);
    if (title) title.textContent = 'Cycle timing';
    sub.textContent = 'Setup, load, and unload apply to this cycle box — not individual ops. Setup counts once per sprint unless “setup per op” is on.';
    const multiOp = metrics.opCount > 1;
    form.innerHTML = `
      <div class="mpp-form-grid">
        <label>Setup (min)<input id="mpp-f-setup" type="number" min="0" step="1" value="${t.setup}"></label>
        <label>Load / cycle (min)<input id="mpp-f-load" type="number" min="0" step="1" value="${t.load}"></label>
        <label>Unload / cycle (min)<input id="mpp-f-unload" type="number" min="0" step="1" value="${t.unload}"></label>
      </div>
      ${multiOp ? `
      <div class="mpp-form-derived mpp-cycle-mode-toggles">
        <label class="mpp-replicate-mode-opt">
          <input type="checkbox" id="mpp-f-sequential" ${t.sequential ? 'checked' : ''}>
          <span><strong>Sequential ops</strong> — run times add up (default for multi-op cycles)</span>
        </label>
        <label class="mpp-replicate-mode-opt">
          <input type="checkbox" id="mpp-f-setup-per-op" ${t.setupPerOp ? 'checked' : ''}>
          <span><strong>Setup per op</strong> — charge each op’s ERP setup at sprint start (off = once per sprint)</span>
        </label>
      </div>` : ''}
      <div class="mpp-form-derived" id="mpp-setup-derived"></div>
    `;
    const refresh = () => {
      const setup = Number(document.getElementById('mpp-f-setup')?.value || 0);
      const load = Number(document.getElementById('mpp-f-load')?.value || 0);
      const unload = Number(document.getElementById('mpp-f-unload')?.value || 0);
      const sequential = document.getElementById('mpp-f-sequential')?.checked ?? metrics.opCount <= 1;
      const el = document.getElementById('mpp-setup-derived');
      if (!el) return;
      const runBlock = sequential && metrics.runMins.length > 1
        ? metrics.runMins.reduce((a, b) => a + b, 0)
        : Math.max(0, ...metrics.runMins, 0);
      const cycleMin = load + runBlock + unload;
      el.innerHTML = `This cycle = <strong>${fmtMinutes(cycleMin)}</strong> (load + run + unload)<br>
        + sprint setup <strong>${fmtMinutes(setup)}</strong> on first identical cycle`;
    };
    form.querySelectorAll('input').forEach((i) => i.addEventListener('input', refresh));
    form.querySelectorAll('input[type="checkbox"]').forEach((i) => i.addEventListener('change', refresh));
    refresh();
    state.modal = { type: 'cycle-timing', cycleId };
    document.getElementById('mpp-setup-modal').hidden = false;
  }

  function saveCycleTimingModal() {
    if (state.modal?.type !== 'cycle-timing') return;
    const found = findCycle(state.modal.cycleId);
    if (!found) return;
    const { cycle } = found;
    cycle.setupMinutes = Math.max(0, Number(document.getElementById('mpp-f-setup')?.value || 0));
    cycle.loadMinPerCycle = Math.max(0, Number(document.getElementById('mpp-f-load')?.value || 0));
    cycle.unloadMinPerCycle = Math.max(0, Number(document.getElementById('mpp-f-unload')?.value || 0));
    const seqEl = document.getElementById('mpp-f-sequential');
    if (seqEl) cycle.sequential = seqEl.checked;
    const setupPerOpEl = document.getElementById('mpp-f-setup-per-op');
    if (setupPerOpEl) cycle.setupPerOp = setupPerOpEl.checked;
    normalizeCycle(cycle);
    closeModal();
    markMachineDirty(found.machineId);
    render();
  }

  function openOpRunModal(jobId) {
    const job = getJob(jobId);
    const form = document.getElementById('mpp-setup-modal-form');
    const sub = document.getElementById('mpp-setup-modal-sub');
    const title = document.querySelector('#mpp-setup-modal .mpp-modal-title');
    if (!job || !form || !sub) return;
    if (title) title.textContent = 'Op run time';
    sub.textContent = `${jobDisplayLabel(job)} — run per pallet only. Setup / load / unload are on the cycle card.`;
    form.innerHTML = `
      <div class="mpp-form-grid">
        <label>Run / pallet (min)<input id="mpp-f-min" type="number" min="0.1" step="1" value="${job.minPerPallet}"></label>
        <label>Pieces per pallet<input id="mpp-f-pcs" type="number" min="1" step="1" value="${job.pcsPerPallet}"></label>
        <label>Order qty<input id="mpp-f-qty" type="number" min="0" step="1" value="${job.qty}"></label>
        <label>Already out<input id="mpp-f-out" type="number" min="0" step="1" value="${job.out}"></label>
      </div>
    `;
    state.modal = { type: 'op-run', jobId };
    document.getElementById('mpp-setup-modal').hidden = false;
  }

  function saveOpRunModal() {
    if (state.modal?.type !== 'op-run') return;
    const job = getJob(state.modal.jobId);
    if (!job) return;
    job.minPerPallet = Math.max(0.1, Number(document.getElementById('mpp-f-min')?.value || 1));
    job.pcsPerPallet = Math.max(1, Number(document.getElementById('mpp-f-pcs')?.value || 1));
    job.qty = Math.max(0, Number(document.getElementById('mpp-f-qty')?.value || 0));
    job.out = Math.max(0, Number(document.getElementById('mpp-f-out')?.value || 0));
    state.jobs[job.jobId] = job;
    closeModal();
    markMachinesWithJob(job.jobId);
    render();
  }

  async function loadMppMachines() {
    try {
      const res = await fetch('/api/mpp-planner/machines');
      const payload = await parseJsonResponse(res);
      if (!res.ok || !payload.ok) return false;
      const machines = Array.isArray(payload.machines) ? payload.machines : [];
      if (!machines.length) return false;
      MACHINES = machines.map((machine) => ({
        id: machine.id,
        code: machine.code,
        category: machine.category || 'MPP',
        shift: machine.shift || 'STANDARD',
        machineId: machine.machineId || 0,
      }));
      return true;
    } catch {
      return false;
    }
  }

  function openScheduleModal(jobId, machineId = defaultMachineId(), seed = null) {
    const job = getJob(jobId);
    const form = document.getElementById('mpp-schedule-modal-form');
    const sub = document.getElementById('mpp-schedule-modal-sub');
    if (!job || !form || !sub) return;
    if (!jobIsSchedulable(job)) return;
    const rem = jobRemaining(jobId);
    const machine = machineById(machineId);
    const defaultShift = defaultShiftForMachine(machine);
    const nightAvail = machineSupportsShift(machine, 'night');
    const seedPallets = Math.max(1, Number(seed?.palletsPerCycle) || Number(job.defaultPalletsPerCycle) || 3);
    const seedMin = Math.max(0.1, Number(seed?.minPerPallet) || Number(job.minPerPallet) || 1);
    const seedPcs = Math.max(1, Number(seed?.pcsPerPallet) || Number(job.pcsPerPallet) || 1);
    sub.textContent = 'Queue one or more full cycles. Each cycle box = one unattended run on the machine.';
    const machineOpts = MACHINES.map((m) => `<option value="${m.id}" ${m.id === machineId ? 'selected' : ''}>${m.code}</option>`).join('');
    const shiftOpts = `
      <label class="mpp-replicate-mode-opt">
        <input type="radio" name="mpp-s-shift" value="day" ${defaultShift === 'day' ? 'checked' : ''}>
        <span><strong>Day</strong> — 08:30–20:00</span>
      </label>
      ${nightAvail ? `
      <label class="mpp-replicate-mode-opt">
        <input type="radio" name="mpp-s-shift" value="night" ${defaultShift === 'night' ? 'checked' : ''}>
        <span><strong>Night</strong> — 20:00–08:30 unattended</span>
      </label>` : ''}
    `;
    form.innerHTML = `
      <div class="mpp-assign-summary"><strong>${escapeHtml(job.psId)}</strong> · ${escapeHtml(job.opLabel)}<br>Remaining: <strong>${rem}</strong> pc</div>
      <label class="mpp-form-full">Machine<select id="mpp-s-machine">${machineOpts}</select></label>
      <fieldset class="mpp-shift-fieldset">
        <legend>Shift per cycle</legend>
        <div class="mpp-replicate-mode">${shiftOpts}</div>
      </fieldset>
      <div class="mpp-form-grid">
        <label>Pallets per cycle<input id="mpp-s-pallets" type="number" min="1" step="1" value="${seedPallets}"></label>
        <label>Minutes per pallet<input id="mpp-s-min" type="number" min="0.1" step="1" value="${seedMin}"></label>
        <label>Pieces per pallet<input id="mpp-s-pcs" type="number" min="1" step="1" value="${seedPcs}"></label>
        <label>Pieces to schedule<input id="mpp-s-qty" type="number" min="1" max="${rem}" step="1" value="${rem}"></label>
      </div>
      <div class="mpp-form-derived" id="mpp-schedule-preview"></div>
    `;
    const preview = () => {
      const pal = Number(document.getElementById('mpp-s-pallets')?.value || 1);
      const m = Number(document.getElementById('mpp-s-min')?.value || 1);
      const p = Number(document.getElementById('mpp-s-pcs')?.value || 1);
      const q = Number(document.getElementById('mpp-s-qty')?.value || 0);
      const plan = planBulkScheduleCycles(q, rem, pal, p);
      const n = plan.cycles.length;
      const perCycle = pal * p;
      const shift = document.querySelector('input[name="mpp-s-shift"]:checked')?.value || 'day';
      const shiftLabel = MPP_SHIFT_META[shift]?.label || shift;
      const el = document.getElementById('mpp-schedule-preview');
      if (el) {
        const partialNote = plan.partialPcs > 0
          ? ` · <span class="mpp-schedule-leftover">+ 1 partial pallet (${plan.partialPcs} pc)</span>`
          : '';
        el.innerHTML = `<strong>${n}</strong> ${shiftLabel.toLowerCase()} cycle box${n === 1 ? '' : 'es'} · ${fmtMinutes(pal * m)} each · up to ${perCycle} pc/cycle · <strong>${plan.scheduledPcs}</strong> pc queued${partialNote}`;
      }
    };
    const syncShiftForMachine = () => {
      const mid = document.getElementById('mpp-s-machine')?.value;
      const m = machineById(mid);
      const fieldset = form.querySelector('.mpp-shift-fieldset .mpp-replicate-mode');
      if (!fieldset || !m) return;
      const nightAvail = machineSupportsShift(m, 'night');
      const def = defaultShiftForMachine(m);
      fieldset.innerHTML = `
        <label class="mpp-replicate-mode-opt">
          <input type="radio" name="mpp-s-shift" value="day" ${def === 'day' ? 'checked' : ''}>
          <span><strong>Day</strong> — 08:30–20:00</span>
        </label>
        ${nightAvail ? `
        <label class="mpp-replicate-mode-opt">
          <input type="radio" name="mpp-s-shift" value="night" ${def === 'night' ? 'checked' : ''}>
          <span><strong>Night</strong> — 20:00–08:30 unattended</span>
        </label>` : ''}
      `;
      fieldset.querySelectorAll('input').forEach((i) => i.addEventListener('change', preview));
      preview();
    };
    form.querySelector('#mpp-s-machine')?.addEventListener('change', syncShiftForMachine);
    form.querySelectorAll('input, select').forEach((i) => i.addEventListener('input', preview));
    preview();
    state.modal = { type: 'schedule', jobId };
    document.getElementById('mpp-schedule-modal').hidden = false;
  }

  function saveScheduleModal() {
    if (state.modal?.type !== 'schedule') return;
    const machineId = document.getElementById('mpp-s-machine')?.value || defaultMachineId();
    const shift = document.querySelector('input[name="mpp-s-shift"]:checked')?.value || defaultShiftForMachine(machineById(machineId));
    const pcsPerPallet = Math.max(1, Number(document.getElementById('mpp-s-pcs')?.value || 1));
    const palletsPerCycle = Math.max(1, Number(document.getElementById('mpp-s-pallets')?.value || 1));
    const qty = Number(document.getElementById('mpp-s-qty')?.value || 0);
    const plan = planBulkScheduleCycles(qty, jobRemaining(state.modal.jobId), palletsPerCycle, pcsPerPallet);
    if (!plan.cycles.length) {
      window.alert('Nothing left to schedule.');
      return;
    }
    bulkScheduleJob(
      machineId,
      state.modal.jobId,
      {
        palletsPerCycle,
        minPerPallet: Math.max(0.1, Number(document.getElementById('mpp-s-min')?.value || 1)),
        pcsPerPallet,
        qty,
        shift,
      },
    );
    closeModal();
  }

  function openAnchorModal(cycleId) {
    const found = findCycle(cycleId);
    if (!found) return;
    document.getElementById('mpp-anchor-input').value = toDatetimeLocal(found.cycle.anchor || found.lane.laneAnchor);
    state.modal = { type: 'anchor', cycleId };
    document.getElementById('mpp-anchor-modal').hidden = false;
  }

  function saveAnchorModal(clear = false) {
    if (state.modal?.type !== 'anchor') return;
    const found = findCycle(state.modal.cycleId);
    if (!found) return;
    found.cycle.anchor = clear ? null : fromDatetimeLocal(document.getElementById('mpp-anchor-input')?.value);
    if (found.index === 0 && found.cycle.anchor) {
      found.lane.laneAnchor = found.cycle.anchor;
    }
    markMachineDirty(found.machineId);
    closeModal();
    render();
  }

  document.getElementById('mpp-review-modal-close')?.addEventListener('click', closeReviewPanel);
  document.getElementById('mpp-review-modal-done')?.addEventListener('click', closeReviewPanel);
  document.getElementById('mpp-review-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'mpp-review-modal') closeReviewPanel();
  });
  document.getElementById('mpp-refresh-jobs')?.addEventListener('click', () => { refreshLiveJobs(); });
  document.getElementById('mpp-toggle-ops-pool')?.addEventListener('click', toggleSidebarCollapsed);
  document.getElementById('mpp-toggle-extra')?.addEventListener('click', toggleExtraCollapsed);
  document.getElementById('mpp-extra-close')?.addEventListener('click', () => setExtraCollapsed(true));
  document.getElementById('mpp-ops-search')?.addEventListener('input', scheduleMppOpsSearchRender);
  document.getElementById('mpp-fa-only')?.addEventListener('change', async (e) => {
    const next = Boolean(e.target.checked);
    mppFaOnly = next;
    try {
      localStorage.setItem(MPP_FA_ONLY_KEY, mppFaOnly ? '1' : '0');
    } catch { /* ignore */ }
    // Turning FA-only off needs the full pool once; turning it on is instant filter.
    if (!mppFaOnly && !jobsPoolIncludesNonFa) {
      const el = e.target;
      if (el) el.disabled = true;
      await refreshLiveJobs({ all: true });
      if (el) el.disabled = false;
      return;
    }
    renderOpsList();
  });
  document.getElementById('mpp-show-completed')?.addEventListener('change', (e) => {
    mppShowCompleted = Boolean(e.target.checked);
    try {
      localStorage.setItem(MPP_SHOW_COMPLETED_KEY, mppShowCompleted ? '1' : '0');
    } catch { /* ignore */ }
    renderOpsList();
  });
  document.getElementById('mpp-ps-detail-close')?.addEventListener('click', closeMppPsDetailModal);
  document.getElementById('mpp-ps-detail-done')?.addEventListener('click', closeMppPsDetailModal);
  document.getElementById('mpp-ps-detail-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'mpp-ps-detail-modal') closeMppPsDetailModal();
  });
  document.getElementById('mpp-ops-list')?.addEventListener('click', (e) => {
    const calcBtn = e.target.closest?.('[data-action="extra-calc"]');
    if (calcBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (calcBtn.dataset.jobId) openExtraForJob(calcBtn.dataset.jobId);
      else openExtraForPs(calcBtn.dataset.psId);
      return;
    }
    const btn = e.target.closest?.('[data-action="ps-detail"]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    openMppPsDetailModal(btn.dataset.psId);
  }, true);
  document.getElementById('mpp-ops-list')?.addEventListener('toggle', (e) => {
    const details = e.target.closest?.('details.mpp-ps-group');
    if (!details) return;
    const psId = compactText(details.dataset.psId);
    const set = mppPsExpandedSet();
    if (details.open) set.add(psId);
    else set.delete(psId);
  }, true);
  document.getElementById('mpp-setup-modal-save')?.addEventListener('click', () => {
    if (state.modal?.type === 'cycle-timing') saveCycleTimingModal();
    else if (state.modal?.type === 'op-run') saveOpRunModal();
  });
  document.getElementById('mpp-schedule-modal-save')?.addEventListener('click', saveScheduleModal);
  document.getElementById('mpp-anchor-save')?.addEventListener('click', () => saveAnchorModal(false));
  document.getElementById('mpp-anchor-clear')?.addEventListener('click', () => saveAnchorModal(true));
  document.getElementById('mpp-replicate-modal-save')?.addEventListener('click', saveReplicateModal);
  document.querySelectorAll('[data-mpp-modal-cancel]').forEach((btn) => btn.addEventListener('click', closeModal));
  ['mpp-setup-modal', 'mpp-schedule-modal', 'mpp-anchor-modal', 'mpp-replicate-modal'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', (e) => { if (e.target.id === id) closeModal(); });
  });
  document.getElementById('mpp-queue-modal-close')?.addEventListener('click', closeQueueManagerModal);
  document.getElementById('mpp-queue-modal-done')?.addEventListener('click', closeQueueManagerModal);
  document.getElementById('mpp-queue-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'mpp-queue-modal') closeQueueManagerModal();
  });
  document.getElementById('mpp-run-modal-close')?.addEventListener('click', closeCycleRunModal);
  document.getElementById('mpp-run-modal-done')?.addEventListener('click', closeCycleRunModal);
  document.getElementById('mpp-run-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'mpp-run-modal') closeCycleRunModal();
  });
  document.getElementById('mpp-cycle-modal-close')?.addEventListener('click', closeCycleDetailModal);
  document.getElementById('mpp-cycle-modal-done')?.addEventListener('click', closeCycleDetailModal);
  document.getElementById('mpp-cycle-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'mpp-cycle-modal') closeCycleDetailModal();
  });
  document.getElementById('mpp-cycle-add-close')?.addEventListener('click', closeCycleAddOpModal);
  document.getElementById('mpp-cycle-add-done')?.addEventListener('click', closeCycleAddOpModal);
  document.getElementById('mpp-cycle-add-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'mpp-cycle-add-modal') closeCycleAddOpModal();
  });
  document.getElementById('mpp-cycle-add-search')?.addEventListener('input', (e) => {
    cycleAddOpSearch = compactText(e.target.value);
    renderCycleAddOpModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const reviewModal = document.getElementById('mpp-review-modal');
    if (reviewModal && !reviewModal.hidden) { e.preventDefault(); closeReviewPanel(); return; }
    const psDetail = document.getElementById('mpp-ps-detail-modal');
    if (psDetail && !psDetail.hidden) { e.preventDefault(); closeMppPsDetailModal(); return; }
    if (state.modal) { e.preventDefault(); closeModal(); return; }
    if (cycleAddOpModalCycleId) { e.preventDefault(); closeCycleAddOpModal(); return; }
    if (cycleDetailModalCycleId) { e.preventDefault(); closeCycleDetailModal(); return; }
    if (cycleRunModal) { e.preventDefault(); closeCycleRunModal(); return; }
    if (queueManagerMachineId) { e.preventDefault(); closeQueueManagerModal(); return; }
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    const action = btn.dataset.action;
    if (action === 'ps-detail') openMppPsDetailModal(btn.dataset.psId);
    if (action === 'extra-calc') {
      if (btn.dataset.jobId) openExtraForJob(btn.dataset.jobId);
      else openExtraForPs(btn.dataset.psId);
    }
    if (action === 'remove-op') removeOp(btn.dataset.opId);
    if (action === 'remove-cycle') removeCycle(btn.dataset.cycleId);
    if (action === 'edit-cycle-timing') openCycleTimingModal(btn.dataset.cycleId);
    if (action === 'edit-op-run') openOpRunModal(btn.dataset.jobId);
    if (action === 'schedule-job') openScheduleModal(btn.dataset.jobId);
    if (action === 'review-cycle') {
      state.selectedCycleId = btn.dataset.cycleId;
      renderReviewPanel(btn.dataset.cycleId);
    }
    if (action === 'replicate-cycle') openReplicateModal(btn.dataset.cycleId);
    if (action === 'new-cycle') newEmptyCycle(btn.dataset.machineId, btn.dataset.shift);
    if (action === 'set-shift') setCycleShift(btn.dataset.cycleId, btn.dataset.shift);
    if (action === 'edit-anchor') openAnchorModal(btn.dataset.cycleId);
    if (action === 'toggle-machine') toggleMachineVisibility(btn.dataset.machineId);
    if (action === 'manage-queue') openQueueManagerModal(btn.dataset.machineId);
    if (action === 'open-cycle') openCycleDetailModal(btn.dataset.cycleId);
    if (action === 'add-op-to-cycle') openCycleAddOpModal(btn.dataset.cycleId);
    if (action === 'pick-op-pallet') {
      addPalletToCycle(btn.dataset.cycleId, btn.dataset.jobId);
      renderCycleAddOpModal();
      refreshOpenModals();
    }
    if (action === 'toggle-cycle-run') {
      toggleCycleRunExpanded(btn.dataset.machineId, btn.dataset.runFp, btn.dataset.runKey);
    }
    if (action === 'open-cycle-run') openCycleRunModal(btn.dataset.machineId, btn.dataset.runKey);
    if (action === 'queue-move-up') moveCycleInQueue(btn.dataset.cycleId, 'up');
    if (action === 'queue-move-down') moveCycleInQueue(btn.dataset.cycleId, 'down');
    if (action === 'add-probation') {
      const job = getJob(btn.dataset.jobId);
      addToProbation(resolveMachineForJob(job), btn.dataset.jobId, estimateProbationPallets(job));
    }
    if (action === 'remove-probation') removeFromProbation(btn.dataset.entryId);
    if (action === 'probation-pallet') {
      const found = findProbationEntry(btn.dataset.entryId);
      if (found?.entry) {
        found.entry.palletCount += 1;
        render();
      }
    }
  });

  function onDragStart(e) {
    if (e.target.closest('button')) { e.preventDefault(); return; }
    const op = e.target.closest('[data-drag-kind="op"]');
    if (op) {
      state.drag = { kind: 'op', opId: op.dataset.opId };
      e.dataTransfer?.setData('text/plain', `op:${op.dataset.opId}`);
      op.classList.add('is-dragging');
      return;
    }
    const pool = e.target.closest('[data-drag-kind="pool"]');
    if (pool) {
      state.drag = { kind: 'pool', jobId: pool.dataset.jobId };
      e.dataTransfer?.setData('text/plain', `job:${pool.dataset.jobId}`);
      pool.classList.add('is-dragging');
      return;
    }
    const probation = e.target.closest('[data-drag-kind="probation"]');
    if (probation) {
      state.drag = { kind: 'probation', entryId: probation.dataset.entryId, machineId: probation.dataset.machineId };
      e.dataTransfer?.setData('text/plain', `prob:${probation.dataset.entryId}`);
      probation.classList.add('is-dragging');
    }
  }

  document.getElementById('mpp-ops-list')?.addEventListener('dragstart', onDragStart);
  document.getElementById('mpp-lanes')?.addEventListener('dragstart', (e) => {
    if (e.target.closest('button')) { e.preventDefault(); return; }
    const head = e.target.closest('[data-drag-kind="box"]');
    if (head) {
      const box = head.closest('.mpp-schedule-box');
      state.dragBox = { machineId: box.dataset.machineId, cycleId: box.dataset.cycleId };
      e.dataTransfer?.setData('text/plain', `box:${box.dataset.cycleId}`);
      head.classList.add('is-dragging');
      return;
    }
    onDragStart(e);
  });

  function onDragEnd(e) {
    e.target.closest('.is-dragging')?.classList.remove('is-dragging');
    document.querySelectorAll('.is-drag-over').forEach((el) => el.classList.remove('is-drag-over'));
    if (!state.dragBox) state.drag = null;
  }
  document.getElementById('mpp-ops-list')?.addEventListener('dragend', onDragEnd);
  document.getElementById('mpp-lanes')?.addEventListener('dragend', (e) => {
    e.target.closest('[data-drag-kind="box"]')?.classList.remove('is-dragging');
    onDragEnd(e);
    state.dragBox = null;
  });

  document.getElementById('mpp-lanes')?.addEventListener('dragover', (e) => {
    if (state.drag?.kind === 'pool' || state.drag?.kind === 'op' || state.drag?.kind === 'probation') {
      const t = e.target.closest('[data-drop-cycle], [data-drop-lane], .mpp-lane-drop');
      if (t) { e.preventDefault(); t.classList.add('is-drag-over'); }
    }
    if (state.dragBox && e.target.closest('.mpp-schedule-box')) e.preventDefault();
  });

  document.getElementById('mpp-lanes')?.addEventListener('dragleave', (e) => {
    e.target.closest('.is-drag-over')?.classList.remove('is-drag-over');
  });

  document.getElementById('mpp-lanes')?.addEventListener('drop', (e) => {
    const cycleEl = e.target.closest('[data-drop-cycle]');
    const laneEl = e.target.closest('[data-drop-lane]');
    const machineId = laneEl?.dataset.machineId || e.target.closest('.mpp-machine')?.dataset.machineId;

    if (state.drag?.kind === 'pool') {
      e.preventDefault();
      document.querySelectorAll('.is-drag-over').forEach((el) => el.classList.remove('is-drag-over'));
      if (cycleEl?.dataset.cycleId) {
        addPalletToCycle(cycleEl.dataset.cycleId, state.drag.jobId);
      } else if (machineId) {
        const reuseCycleId = resolveLaneDropCycleId(machineId);
        if (reuseCycleId) {
          addPalletToCycle(reuseCycleId, state.drag.jobId);
        } else {
          const machine = machineById(machineId);
          const lastCycle = state.machines[machineId]?.cycles?.slice(-1)[0];
          const shift = lastCycle?.shift || defaultShiftForMachine(machine);
          addPalletAsNewCycle(machineId, state.drag.jobId, shift);
        }
      }
      state.drag = null;
      return;
    }
    if (state.drag?.kind === 'probation' && cycleEl?.dataset.cycleId) {
      e.preventDefault();
      document.querySelectorAll('.is-drag-over').forEach((el) => el.classList.remove('is-drag-over'));
      promoteProbationToCycle(state.drag.entryId, cycleEl.dataset.cycleId);
      state.drag = null;
      return;
    }
    if (state.drag?.kind === 'op' && cycleEl) {
      e.preventDefault();
      moveOpToCycle(state.drag.opId, cycleEl.dataset.cycleId);
      state.drag = null;
      return;
    }
    const box = e.target.closest('.mpp-schedule-box');
    if (box && state.dragBox) {
      e.preventDefault();
      const lane = state.machines[state.dragBox.machineId];
      reorderCycle(state.dragBox.machineId,
        lane.cycles.findIndex((c) => c.cycleId === state.dragBox.cycleId),
        lane.cycles.findIndex((c) => c.cycleId === box.dataset.cycleId));
      state.dragBox = null;
    }
  });

  document.getElementById('mpp-probation-grid')?.addEventListener('dragstart', onDragStart);
  document.getElementById('mpp-probation-grid')?.addEventListener('dragend', onDragEnd);
  document.getElementById('mpp-probation-grid')?.addEventListener('dragover', (e) => {
    if (state.drag?.kind === 'pool' || state.drag?.kind === 'probation') {
      const t = e.target.closest('[data-drop-probation]');
      if (t) { e.preventDefault(); t.classList.add('is-drag-over'); }
    }
  });
  document.getElementById('mpp-probation-grid')?.addEventListener('dragleave', (e) => {
    e.target.closest('.is-drag-over')?.classList.remove('is-drag-over');
  });
  document.getElementById('mpp-probation-grid')?.addEventListener('drop', (e) => {
    const dropEl = e.target.closest('[data-drop-probation]');
    if (!dropEl) return;
    e.preventDefault();
    document.querySelectorAll('.is-drag-over').forEach((el) => el.classList.remove('is-drag-over'));
    const machineId = dropEl.dataset.machineId;
    if (state.drag?.kind === 'pool' && machineId) {
      addToProbation(machineId, state.drag.jobId, 1);
      state.drag = null;
      return;
    }
    if (state.drag?.kind === 'probation' && machineId) {
      const found = findProbationEntry(state.drag.entryId);
      if (found && found.machineId !== machineId) {
        found.entries.splice(found.index, 1);
        ensureProbationLane(machineId).push(found.entry);
        render();
      }
      state.drag = null;
    }
  });

  async function refreshLiveJobs(opts = {}) {
    const btn = document.getElementById('mpp-refresh-jobs');
    if (btn) btn.disabled = true;
    const liveOk = await loadFrameAgreementJobs(opts);
    if (liveOk) {
      // Merge templates into existing jobs so queued / edited rows keep local fields.
      const next = { ...state.jobs };
      JOB_TEMPLATES.forEach((t) => {
        const prev = next[t.jobId];
        next[t.jobId] = prev ? { ...prev, ...t } : { ...t };
      });
      state.jobs = next;
    }
    updateJobsSourceBadge();
    updateJobsStatusLine();
    render();
    if (btn) btn.disabled = false;
  }

  async function initMppPlanner() {
    try { localStorage.removeItem('mpp-planner-ps-expanded'); } catch { /* ignore */ }
    queueHydrated = false;
    queueLoadError = '';
    await Promise.all([loadMppMachines(), loadFrameAgreementJobs()]);
    state = defaultState();
    const queueOk = await loadMppQueue();
    if (!queueOk && !queueLoadError) {
      queueLoadError = 'could not load saved queue';
    }
    queueHydrated = queueOk;
    skipNextQueueSave = true;
    updateJobsSourceBadge();
    updateJobsStatusLine();
    render();
    startQueueSaveIdleFlush();
  }

  function startQueueSaveIdleFlush() {
    clearInterval(queueSaveIdleTimer);
    queueSaveIdleTimer = window.setInterval(() => {
      if (!queueHydrated || suppressQueueSave || queueSaveInFlight || queueRecalcInFlight) return;
      if (queueSyncStatus === 'pending') flushQueueSave({ recalculate: false });
      else if (queueSyncStatus === 'error') scheduleQueueSaveRetry();
      else if (queueRecalcPending || queueRecalcStatus === 'error') flushQueueRecalc();
    }, QUEUE_SAVE_IDLE_FLUSH_MS);
  }

  window.addEventListener('pagehide', () => {
    flushQueueSaveOnExit();
    flushQueueRecalcOnExit();
  });
  window.addEventListener('beforeunload', () => {
    flushQueueSaveOnExit();
    flushQueueRecalcOnExit();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (queueSyncStatus === 'pending' && !queueSaveInFlight) {
        clearTimeout(queueSaveTimer);
        queueSaveTimer = null;
        flushQueueSave({ recalculate: false });
      } else {
        flushQueueSaveOnExit();
      }
      if (queueRecalcPending && !queueRecalcInFlight) {
        clearTimeout(queueRecalcTimer);
        queueRecalcTimer = null;
        flushQueueRecalc();
      } else {
        flushQueueRecalcOnExit();
      }
      return;
    }
    if (queueSyncStatus === 'error') scheduleQueueSaveRetry();
    if (queueRecalcStatus === 'error') scheduleQueueRecalcRetry();
  });

  initMppPlanner();
})();
