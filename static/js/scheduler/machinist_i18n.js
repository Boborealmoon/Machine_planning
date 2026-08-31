// Machinist queue board — English / Chinese (default: English).

const TRIAL_MACHINIST_LOCALE_KEY = 'machinist-board-locale-v1';

const TRIAL_MACHINIST_STRINGS = {
  en: {
    page_title: 'Machine Queue Overview',
    read_only_note: 'Read-only · auto-refresh',
    focus_view: 'Focus view',
    focus_view_title: 'Select up to 4 machines to show their lanes',
    stock_colours: 'Stock colours',
    stock_colours_title: 'Show green/red stock status on cards',
    in_stock: 'In stock',
    awaiting_stock: 'Awaiting stock',
    loading: 'Loading machine queues...',
    scroll_hint: 'Swipe sideways for machines · scroll down for queues · pinch to zoom',
    scroll_lanes_aria: 'Scroll machine lanes horizontally',
    scroll_lanes_title: 'Drag to scroll · swipe sideways on mobile',
    find_job: 'Find job',
    job_placeholder: 'Job no. e.g. 0177, NPS26-0178',
    unsure_warning: 'If unsure please ask production controller',
    unsure_warning_caps: 'IF UNSURE PLEASE ASK PRODUCTION CONTROLLER',
    no_jobs_match: 'No queued jobs match.',
    job_pos_head: '#1 · head',
    job_pos: '#{n}',
    job_on_machine: '{ps} is #{pos} on {machine}',
    no_active_jobs: 'No active jobs right now.',
    select_machines: 'Select your machines (max {max})',
    machines_active_aria: 'Machines with active jobs',
    clear: 'Clear',
    none: 'None',
    select_machines_landing: 'Select machines above to show lanes.',
    group: 'Group',
    machine: 'Machine',
    all: 'All',
    all_machines: 'All machines',
    no_machines: 'No machines',
    no_machines_selected: 'No machines selected',
    machines_count: '{n}/{total} machines',
    no_machines_in_group: 'No machines in this group',
    in_queue: '{n} in queue',
    empty_queue: 'Empty queue',
    queued_jobs: 'Queued jobs',
    next_available: 'Next available {dt}',
    focus_hint: 'Now + next {n} · scroll for more',
    now: 'Now',
    next: 'Next',
    then: 'Then',
    partial: 'Partial {n}',
    partial_note: 'Run is for partial {n} only',
    partial_title: 'Process sheet partial',
    qty: 'Qty',
    out: 'Out',
    target: 'Target',
    cycle: 'Cycle',
    due: 'Due',
    end: 'End',
    anchor: 'Anchor',
    queued: 'Queued',
    mtl: 'Mtl',
    mtl_avail: 'Mtl Avail',
    outside_filter_blocks: '{n} on this machine outside the date filter. Clear dates to show all.',
    outside_filter_one: '1 block is on this machine outside the date filter. Clear dates to show all.',
    no_blocks_range: 'No run blocks in this date range.',
    no_blocks: 'No run blocks yet for this machine.',
    max_machines_focus: 'Maximum {max} machines in focus view',
    add_machine_focus: 'Add this machine in focus view (max {max} selected)',
    scripts_failed: 'Board scripts did not load (data.js). Hard-refresh (Ctrl+F5).',
    lang_toggle_aria: 'Language',
    cat_milling: 'Milling',
    cat_turning: 'Turning',
    cat_turnmill: 'Turnmill',
    cat_mpp: 'MPP',
    mpp_label: 'MPP',
    mpp_lanes_on: 'MPP lanes on',
    mpp_lanes_show: 'Show MPP lanes',
    mpp_lanes_on_title: 'Hide CNC 35, 36, and 41 (MPP planner) lanes',
    mpp_lanes_show_title: 'Show CNC 35, 36, and 41 (MPP planner) lanes',
    mpp_badge_title: 'Scheduled in MPP planner',
    mpp_lane_title: 'MPP planner machine',
    mpp_cycles_count: '{n}× cycles',
    mpp_cycle_span: '#{from}–#{to}',
    mpp_expand_cycles: 'Expand',
    mpp_collapse_cycles: 'Collapse',
    mpp_qty_per_cycle: '{qty}/cycle',
    mpp_qty_total: '{total} total',
    mpp_jobs_count: '{n} jobs',
  },
  zh: {
    page_title: '机床队列看板',
    read_only_note: '只读 · 自动刷新',
    focus_view: '聚焦视图',
    focus_view_title: '最多选择 4 台机床显示队列',
    stock_colours: '库存颜色',
    stock_colours_title: '在卡片上显示绿/红库存状态',
    in_stock: '有库存',
    awaiting_stock: '待库存',
    loading: '正在加载机床队列…',
    scroll_hint: '左右滑动查看机床 · 上下滑动查看队列 · 双指缩放',
    scroll_lanes_aria: '横向滚动机床列',
    scroll_lanes_title: '拖动滚动 · 手机上左右滑动',
    find_job: '查找工单',
    job_placeholder: '工单号，如 0177、NPS26-0178',
    unsure_warning: '如有疑问请咨询生产调度',
    unsure_warning_caps: '如有疑问请咨询生产调度',
    no_jobs_match: '没有匹配的队列工单。',
    job_pos_head: '第 1 位 · 当前',
    job_pos: '第 {n} 位',
    job_on_machine: '{ps} 在 {machine} 队列第 {pos} 位',
    no_active_jobs: '当前没有进行中的工单。',
    select_machines: '选择您的机床（最多 {max} 台）',
    machines_active_aria: '有进行工单的机床',
    clear: '清除',
    none: '无',
    select_machines_landing: '请在上方选择机床以显示队列。',
    group: '分组',
    machine: '机床',
    all: '全部',
    all_machines: '全部机床',
    no_machines: '无机床',
    no_machines_selected: '未选择机床',
    machines_count: '{n}/{total} 台机床',
    no_machines_in_group: '此分组无机床',
    in_queue: '队列中 {n} 个',
    empty_queue: '队列为空',
    queued_jobs: '排队工单',
    next_available: '下次可用 {dt}',
    focus_hint: '当前 + 后 {n} 个 · 下滑查看更多',
    now: '当前',
    next: '下一个',
    then: '随后',
    partial: '分件 {n}',
    partial_note: '本批次仅针对分件 {n}',
    partial_title: '工艺单分件',
    qty: '数量',
    out: '产出',
    target: '目标',
    cycle: '周期',
    due: '交期',
    end: '结束',
    anchor: '锚点',
    queued: '排队',
    mtl: '来料',
    mtl_avail: '材料到位',
    outside_filter_blocks: '此机床有 {n} 在日期筛选范围外。清除日期以显示全部。',
    outside_filter_one: '此机床有 1 个排产块在日期筛选范围外。清除日期以显示全部。',
    no_blocks_range: '此日期范围内无排产块。',
    no_blocks: '此机床尚无排产块。',
    max_machines_focus: '聚焦视图最多选择 {max} 台机床',
    add_machine_focus: '请在聚焦视图中添加此机床（最多 {max} 台）',
    scripts_failed: '看板脚本加载失败（data.js）。请强制刷新（Ctrl+F5）。',
    lang_toggle_aria: '语言',
    cat_milling: '铣削',
    cat_turning: '车削',
    cat_turnmill: '车铣',
    cat_mpp: 'MPP',
    mpp_label: 'MPP',
    mpp_lanes_on: '已显示 MPP',
    mpp_lanes_show: '显示 MPP',
    mpp_lanes_on_title: '隐藏 CNC 35、36、41（MPP 排产）机床列',
    mpp_lanes_show_title: '显示 CNC 35、36、41（MPP 排产）机床列',
    mpp_badge_title: '来自 MPP 排产',
    mpp_lane_title: 'MPP 排产机床',
    mpp_cycles_count: '{n}× 循环',
    mpp_cycle_span: '#{from}–#{to}',
    mpp_expand_cycles: '展开',
    mpp_collapse_cycles: '收起',
    mpp_qty_per_cycle: '每循环 {qty}',
    mpp_qty_total: '共 {total}',
    mpp_jobs_count: '{n} 工单',
  },
};

function trialMachinistLocale() {
  try {
    if (localStorage.getItem(TRIAL_MACHINIST_LOCALE_KEY) === 'zh') return 'zh';
  } catch (_) {}
  return 'en';
}

function trialMachinistT(key, vars = {}) {
  const locale = trialMachinistLocale();
  let text = TRIAL_MACHINIST_STRINGS[locale]?.[key]
    ?? TRIAL_MACHINIST_STRINGS.en[key]
    ?? String(key || '');
  Object.entries(vars || {}).forEach(([name, value]) => {
    text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
  });
  return text;
}

function trialMachinistCategoryLabel(category) {
  const raw = String(category || '').trim().toUpperCase();
  if (!raw || raw === 'ALL') return trialMachinistT('all');
  if (raw === 'MILLING') return trialMachinistT('cat_milling');
  if (raw === 'TURNING') return trialMachinistT('cat_turning');
  if (raw === 'TURNMILL') return trialMachinistT('cat_turnmill');
  if (raw === 'MPP') return trialMachinistT('cat_mpp');
  if (raw.length <= 3) return raw;
  return raw.charAt(0) + raw.slice(1).toLowerCase();
}

function trialMachinistLaneEmptyMessage(totalGroups, visibleGroups) {
  if (totalGroups > 0 && visibleGroups === 0 && typeof trialHasActiveDateFilter === 'function' && trialHasActiveDateFilter()) {
    if (totalGroups === 1) return trialMachinistT('outside_filter_one');
    return trialMachinistT('outside_filter_blocks', { n: totalGroups });
  }
  if (typeof trialHasActiveDateFilter === 'function' && trialHasActiveDateFilter()) {
    return trialMachinistT('no_blocks_range');
  }
  return trialMachinistT('no_blocks');
}

function trialMachinistFilterButtonLabel() {
  const machines = typeof trialMachinesInCategory === 'function' ? trialMachinesInCategory() : [];
  if (!machines.length) return trialMachinistT('no_machines');
  const selectedCount = machines.filter(m => !trialMachineHiddenSet.has(m.machine_code)).length;
  if (selectedCount === machines.length) return trialMachinistT('all_machines');
  if (selectedCount === 0) return trialMachinistT('no_machines_selected');
  return trialMachinistT('machines_count', { n: selectedCount, total: machines.length });
}

function trialMachinistScheduleLabel(anchored) {
  return anchored ? trialMachinistT('anchor') : trialMachinistT('queued');
}

function trialSetMachinistLocale(locale) {
  const next = locale === 'zh' ? 'zh' : 'en';
  try {
    localStorage.setItem(TRIAL_MACHINIST_LOCALE_KEY, next);
  } catch (_) {}
  trialSyncMachinistLocaleUi();
}

function trialToggleMachinistLocale(locale) {
  if (locale === 'en' || locale === 'zh') {
    trialSetMachinistLocale(locale);
    return;
  }
  trialSetMachinistLocale(trialMachinistLocale() === 'zh' ? 'en' : 'zh');
}

function trialSyncMachinistLocaleStatic() {
  if (typeof trialIsMachinistBoard !== 'function' || !trialIsMachinistBoard()) return;
  const locale = trialMachinistLocale();
  document.body.classList.toggle('machinist-board--zh', locale === 'zh');
  document.body.dataset.machinistLocale = locale;
  document.documentElement.lang = locale === 'zh' ? 'zh-Hans' : 'en';

  document.querySelectorAll('[data-machinist-i18n]').forEach(el => {
    const key = el.dataset.machinistI18n;
    if (key) el.textContent = trialMachinistT(key);
  });
  document.querySelectorAll('[data-machinist-i18n-placeholder]').forEach(el => {
    const key = el.dataset.machinistI18nPlaceholder;
    if (key) el.placeholder = trialMachinistT(key);
  });
  document.querySelectorAll('[data-machinist-i18n-title]').forEach(el => {
    const key = el.dataset.machinistI18nTitle;
    if (key) el.title = trialMachinistT(key);
  });
  document.querySelectorAll('[data-machinist-i18n-aria]').forEach(el => {
    const key = el.dataset.machinistI18nAria;
    if (key) el.setAttribute('aria-label', trialMachinistT(key));
  });

  const enBtn = document.getElementById('machinist-lang-en');
  const zhBtn = document.getElementById('machinist-lang-zh');
  if (enBtn) {
    enBtn.classList.toggle('is-active', locale === 'en');
    enBtn.setAttribute('aria-pressed', locale === 'en' ? 'true' : 'false');
  }
  if (zhBtn) {
    zhBtn.classList.toggle('is-active', locale === 'zh');
    zhBtn.setAttribute('aria-pressed', locale === 'zh' ? 'true' : 'false');
  }

  if (typeof trialSyncMachinistFocusClass === 'function') trialSyncMachinistFocusClass();
  if (typeof trialSyncMachinistStockColorsClass === 'function') trialSyncMachinistStockColorsClass();
}

function trialSyncMachinistLocaleUi(options = {}) {
  const rerender = options.rerender !== false;
  trialSyncMachinistLocaleStatic();
  if (rerender && typeof renderTrial === 'function' && document.getElementById('trial-grid')) {
    renderTrial({ skipCatalog: true });
  }
}
