// QAQC View — English / Chinese (default: English).

const FQ_LOCALE_KEY = 'qaqc-view-locale-v1';

const FQ_STRINGS = {
  en: {
    page_title: 'QAQC View',
    page_kicker: 'Quality',
    lang_toggle_aria: 'Language',
    hide_done: 'Hide done',
    hide_done_title: 'Grey out and hide checklist-completed rows',
    qc_team: 'QC team',
    qc_team_title: 'Add or remove QC inspector names',
    refresh: 'Refresh',
    refresh_title: 'Sync WO status from ERP then reload queue',

    nav_aria: 'Queue navigation',
    screen_aria: 'Screen mode',
    screen_queue: 'Queue',
    screen_assignments: 'By assignee',
    screen_material_issue: 'Mat issue & assy',
    screen_anticipated_material: 'Anticipated material',
    screen_material_inspection: 'Material inspection',
    screen_qc_queue: 'QC queue',
    ps_type_aria: 'PS type filter',
    temp: 'Temp',
    stage_aria: 'Finishing stage',
    stage_all: 'Overall',
    stage_deburring: 'Deburring',
    stage_final_inspection: 'Final inspection',
    stage_packing: 'Packing',
    stage_engraving_packing: 'Pack & engrave',

    mi_status_aria: 'Material inspection status',
    mi_outstanding: 'Outstanding',
    mi_ready: 'Ready',
    mi_historical: 'Historical',
    mi_search_placeholder: 'Inspection, PO, supplier, GRN, part...',
    qcq_status_aria: 'QC queue status',
    qcq_search_placeholder: 'Inspection, WO, MPS, process sheet, part, SO, stage, segment...',
    am_search_placeholder: 'SO, process sheet, part, customer...',

    board_aria: 'Workload by assignee',
    loading: 'Loading post-machining queue...',

    col_done: 'Done',
    col_done_title: 'Checklist & exceptions',
    col_job: 'Job',
    col_stage: 'Stage',
    col_status: 'Status',
    col_po_due: 'PO due',
    col_edd: 'EDD',
    col_delivery_schedule: 'Delivery schedule',
    col_delivery_schedule_title: 'Week and day from Coway EDD or PO due',
    col_qa_due: 'Target completion date',
    col_deadline: 'Deadline',
    col_assigned: 'Assigned',
    col_more: 'More',

    mia_col_job: 'Job',
    mia_col_part: 'Part',
    mia_col_description: 'Description',
    mia_col_status: 'Status',
    mia_col_qty: 'Qty',
    mia_col_so_qty: 'SO qty',
    mia_col_shipped: 'Shipped',
    mia_col_po_due: 'PO due',
    mia_col_edd: 'EDD',
    mia_col_material_in: 'Material in',
    mia_col_remarks: 'Remarks',

    mi_col_inspection: 'Inspection',
    mi_col_po: 'PO',
    mi_col_supplier: 'Supplier',
    mi_col_shipment: 'Shipment',
    mi_col_grn: 'GRN',
    mi_col_arrival: 'Arrival',
    mi_col_part: 'Part',
    mi_col_description: 'Description',
    mi_col_qty: 'Qty',
    mi_col_erp_status: 'ERP status',
    mi_col_assigned_to: 'Assigned to',
    mi_col_inspector: 'Inspector',
    mi_col_done: 'Done',

    qcq_col_inspection: 'Inspection',
    qcq_col_wo: 'WO',
    qcq_col_mps: 'MPS',
    qcq_col_process_sheet: 'Process sheet',
    qcq_col_segment: 'Segment',
    qcq_col_part: 'Part',
    qcq_col_stage: 'Stage',
    qcq_col_so: 'SO',
    qcq_col_wo_qty: 'WO qty',
    qcq_col_assigned: 'Assigned',
    qcq_col_erp_status: 'ERP status',
    qcq_col_wo_status: 'WO status',
    qcq_col_inspector: 'Inspector',
    qcq_col_started: 'Started',
    qcq_col_ended: 'Ended',
    qcq_col_ncr: 'NCR',

    am_col_job: 'Job',
    am_col_so: 'SO',
    am_col_part: 'Part',
    am_col_description: 'Description',
    am_col_qty: 'Qty',
    am_col_arrival: 'Material in',
    am_col_week: 'Week',
    am_col_po_due: 'PO due',
    am_col_customer: 'Customer',
    am_col_notes: 'Notes',
    am_overdue: 'Overdue',
    am_this_week: 'This week',
    am_delay: 'Material delay flagged',
    am_request: 'Request',
    am_week_group: 'Week {n} · {range}',

    empty_default: 'No partials are currently at a finishing stage.',
    empty_post_machining: 'No partials are currently at a post-machining stage.',
    empty_ps_types: 'No jobs match the selected PS types.',
    empty_stage: 'Nothing in this stage right now.',
    empty_mia: 'No open jobs with an assembly WO stage (SO qty not fully shipped).',
    empty_mi_search: 'No inspections match your search.',
    empty_mi_none: 'No {view} inspections right now.',
    empty_qcq_search: 'No {view} QC records match your search.',
    empty_qcq_segment: 'No {view} records match the selected segment filter.',
    empty_qcq_none: 'No {view} records in the ERP QC queue.',
    empty_am: 'No Material in / Sub-Con dates in S/O Management yet.',
    empty_am_search: 'No anticipated material matches your search.',

    detail_kicker: 'QAQC detail',
    detail_close: 'Close',
    detail_close_aria: 'Close',
    detail_foot: 'Synced staging · edits save automatically',
    detail_quick_edit: 'Quick edit',
    detail_qa_due: 'Target completion date',
    detail_deadline: 'Deadline',
    detail_assigned: 'Assigned',
    detail_remarks: 'Remarks',
    detail_remarks_placeholder: 'Notes for QA team',
    detail_section_stage: 'Stage',
    detail_section_job: 'Job details',
    detail_field_stage: 'Stage',
    detail_field_status: 'Status',
    detail_field_progress: 'Progress',
    detail_field_stage_required: 'Stage required',
    detail_field_stage_produced: 'Stage produced',
    detail_field_stage_rejected: 'Stage rejected',
    detail_field_ps: 'Process sheet',
    detail_field_partial: 'Partial',
    detail_field_part: 'Part',
    detail_field_description: 'Description',
    detail_field_po_due: 'PO due',
    detail_field_coway_edd: 'Coway EDD',
    detail_field_delivery: 'Delivery schedule',
    detail_field_checklist: 'Checklist done',
    detail_field_exception: 'Exception',

    inspectors_title: 'QC inspectors',
    inspectors_hint: 'Add or remove inspector names. They appear in the Assigned dropdown on the queue.',
    inspectors_placeholder: 'Inspector name',
    inspectors_add: 'Add inspector',
    inspectors_empty: 'No inspectors yet.',
    inspectors_remove: 'Remove',
    inspectors_confirm_remove: 'Remove this inspector from the QC team?',

    unassigned: '— Unassigned —',
    unassigned_label: 'Unassigned',
    everyone: 'Everyone',
    yes: 'Yes',
    no: 'No',
    pcs: 'pcs',
    partial: 'partial {n}',
    open_details: 'Open full details',
    mark_done: 'Mark done',
    mark_not_done: 'Mark not done',
    flag_exception: 'Flag exception',
    clear_exception: 'Clear exception',
    mark_inspection_done: 'Mark inspection done',

    status_in_process: 'In Process',
    status_ready: 'Ready to Start',
    status_pending_si: 'Pending SI',
    status_completed: 'Completed',
    status_pending: 'Pending',
    status_ready_short: 'Ready',

    week_label: 'Week {n}',
    week_day: 'Week {n} - {day}',
    weekday_sun: 'Sun',
    weekday_mon: 'Mon',
    weekday_tues: 'Tues',
    weekday_wed: 'Wed',
    weekday_thu: 'Thu',
    weekday_fri: 'Fri',
    weekday_sat: 'Sat',
    from_coway_edd: 'From Coway EDD ({date})',
    from_po_due: 'From PO due ({date})',

    stats_queue: '{n} in queue · {i} in process · {r} ready · {stage}',
    stats_incoming: ' · {n} incoming',
    stats_incoming_only: '{n} incoming from Deburring',
    incoming_from_deburring: 'Incoming from Deburring',
    incoming_now_final_inspection: 'In final inspection',
    incoming_badge: 'Incoming',
    stats_exceptions: ' · {n} exception',
    stats_exceptions_plural: ' · {n} exceptions',
    stats_jobs_assignees: '{n} job across {groups} assignee · grouped workload',
    stats_jobs_assignees_plural: '{n} jobs across {groups} assignees · grouped workload',
    stats_unassigned: '{n} unassigned job',
    stats_unassigned_plural: '{n} unassigned jobs',
    stats_for_assignee: '{n} job for {name}',
    stats_for_assignee_plural: '{n} jobs for {name}',
    stats_sorted: '{n} job · sorted by column',
    stats_sorted_plural: '{n} jobs · sorted by column',
    stats_mia: '{n} job with assembly stage',
    stats_mia_plural: '{n} jobs with assembly stage',
    stats_mi: '{view}: {n} · O {o} · R {r} · H {h}',
    stats_qcq: '{view}: {n} shown · {o} O · {h} H · {total} total ERP records',
    stage_all_label: 'all stages',
    stage_deburring_label: 'deburring',
    stage_final_inspection_label: 'final inspection',
    stage_packing_label: 'packing',
    stage_engraving_packing_label: 'pack & engrave',

    jobs_count: '{n} job',
    jobs_count_plural: '{n} jobs',
    exceptions_count: '{n} exception',
    exceptions_count_plural: '{n} exceptions',
    next_qa: 'next target {date}',
    next_deadline: 'next deadline {date}',
    jobs_total: '{n} job total',
    jobs_total_plural: '{n} jobs total',
    assignees_count: '{n} assignee',
    assignees_count_plural: '{n} assignees',
    qa_from: 'Target from {date}',
    flagged: '{n} flagged',

    saving: 'Saving…',
    saved: 'Saved ✓',
    failed: 'Failed',
    loading_short: 'Loading…',
    loading_mi: 'Loading material inspections…',
    loading_qcq: 'Loading ERP QC queue…',
    loading_am: 'Loading anticipated material…',
    loading_interactive: 'Loading interactive queue…',

    toast_marked_done: 'Marked done ✓',
    toast_unmarked: 'Unmarked',
    toast_exception_flagged: 'Exception flagged',
    toast_exception_cleared: 'Exception cleared',
    toast_assignment_saved: 'Assignment saved',
    toast_qa_due_saved: 'Target completion date saved',
    toast_deadline_saved: 'Deadline saved',
    toast_remarks_saved: 'Remarks saved',
    toast_save_failed: 'Save failed',
    toast_inspection_done: 'Marked inspection done ✓',
    toast_queue_refreshed: 'Queue refreshed from ERP',
    toast_mi_refreshed: 'Material inspection refreshed from ERP',
    toast_qcq_refreshed: 'QC queue refreshed from ERP',
    toast_am_refreshed: 'Anticipated material refreshed',
    toast_syncing: 'Syncing WO status from ERP…',
    toast_sync_fallback: '{msg} — showing last synced data',
    toast_row_mismatch: 'Could not match this row — refresh the page',

    meta_queue: 'Source: synced staging (mfg_wo_status + pp_vouchers_cache) · cached {at} · TTL {ttl}s · Sync ERP for fresh data',
    meta_mi: 'Material inspection · live COMAIN ERP read · cached {at} · assign a QC team member to plan the work',
    meta_qcq: 'QC queue · live COMAIN ERP · inspection + job assignment + mfg WO · cached {at}',
    meta_am: 'Anticipated material · S/O Management Material in / Sub-Con dates · {at}',
    stats_am: '{n} anticipated · {overdue} overdue · {this_week} this week',

    stage_desc_deburring: 'Deburring',
    stage_desc_final_inspection: 'Final Inspection',
    stage_desc_packing: 'Packing',
    stage_desc_engraving_packing: 'Engraving & Packing',
    stage_desc_material_issue: 'Material Issue & Assembly',
  },
  zh: {
    page_title: '质检视图',
    page_kicker: '质量',
    lang_toggle_aria: '语言',
    hide_done: '隐藏已完成',
    hide_done_title: '隐藏已勾选完成的行',
    qc_team: '质检团队',
    qc_team_title: '添加或移除质检员',
    refresh: '刷新',
    refresh_title: '从 ERP 同步工单状态并重新加载队列',

    nav_aria: '队列导航',
    screen_aria: '界面模式',
    screen_queue: '队列',
    screen_assignments: '按负责人',
    screen_material_issue: '发料与装配',
    screen_anticipated_material: '预计来料',
    screen_material_inspection: '来料检验',
    screen_qc_queue: '质检队列',
    ps_type_aria: '工艺单类型筛选',
    temp: '临时',
    stage_aria: '后加工工序',
    stage_all: '全部',
    stage_deburring: '去毛刺',
    stage_final_inspection: '最终检验',
    stage_packing: '包装',
    stage_engraving_packing: '包装与打标',

    mi_status_aria: '来料检验状态',
    mi_outstanding: '未完成',
    mi_ready: '就绪',
    mi_historical: '历史',
    mi_search_placeholder: '检验单、采购单、供应商、收货单、零件…',
    qcq_status_aria: '质检队列状态',
    qcq_search_placeholder: '检验、工单、MPS、工艺单、零件、订单、工序、类型…',
    am_search_placeholder: '订单、工艺单、零件、客户…',

    board_aria: '负责人工作量',
    loading: '正在加载后加工队列…',

    col_done: '完成',
    col_done_title: '清单与异常',
    col_job: '工单',
    col_stage: '工序',
    col_status: '状态',
    col_po_due: '订单交期',
    col_edd: '建议交期',
    col_delivery_schedule: '交货安排',
    col_delivery_schedule_title: '根据建议交期或订单交期计算的周次与星期',
    col_qa_due: '目标完成日期',
    col_deadline: '期限',
    col_assigned: '负责人',
    col_more: '更多',

    mia_col_job: '工单',
    mia_col_part: '零件',
    mia_col_description: '描述',
    mia_col_status: '状态',
    mia_col_qty: '数量',
    mia_col_so_qty: '订单数量',
    mia_col_shipped: '已发货',
    mia_col_po_due: '订单交期',
    mia_col_edd: '建议交期',
    mia_col_material_in: '材料到位',
    mia_col_remarks: '备注',

    mi_col_inspection: '检验单',
    mi_col_po: '采购单',
    mi_col_supplier: '供应商',
    mi_col_shipment: '出货单',
    mi_col_grn: '收货单',
    mi_col_arrival: '到货',
    mi_col_part: '零件',
    mi_col_description: '描述',
    mi_col_qty: '数量',
    mi_col_erp_status: 'ERP 状态',
    mi_col_assigned_to: '分配给',
    mi_col_inspector: '检验员',
    mi_col_done: '完成',

    qcq_col_inspection: '检验单',
    qcq_col_wo: '工单',
    qcq_col_mps: 'MPS',
    qcq_col_process_sheet: '工艺单',
    qcq_col_segment: '类型',
    qcq_col_part: '零件',
    qcq_col_stage: '工序',
    qcq_col_so: '销售订单',
    qcq_col_wo_qty: '工单数量',
    qcq_col_assigned: '负责人',
    qcq_col_erp_status: 'ERP 状态',
    qcq_col_wo_status: '工单状态',
    qcq_col_inspector: '检验员',
    qcq_col_started: '开始',
    qcq_col_ended: '结束',
    qcq_col_ncr: 'NCR',

    am_col_job: '工单',
    am_col_so: '销售订单',
    am_col_part: '零件',
    am_col_description: '描述',
    am_col_qty: '数量',
    am_col_arrival: '预计到料',
    am_col_week: '周次',
    am_col_po_due: '订单交期',
    am_col_customer: '客户',
    am_col_notes: '备注',
    am_overdue: '逾期',
    am_this_week: '本周',
    am_delay: '材料延误已标记',
    am_request: '物料申请',
    am_week_group: '第 {n} 周 · {range}',

    empty_default: '当前没有处于后加工工序的分件。',
    empty_post_machining: '当前没有处于后加工工序的分件。',
    empty_ps_types: '没有符合所选工艺单类型的工单。',
    empty_stage: '此工序暂无记录。',
    empty_mia: '没有带装配工单工序的未完成工单（订单数量尚未全部发货）。',
    empty_mi_search: '没有符合搜索条件的检验单。',
    empty_mi_none: '当前没有{view}检验单。',
    empty_qcq_search: '没有符合搜索条件的{view}质检记录。',
    empty_qcq_segment: '没有符合所选类型筛选的{view}记录。',
    empty_qcq_none: 'ERP 质检队列中没有{view}记录。',
    empty_am: '销售订单管理里还没有填写预计到料日期。',
    empty_am_search: '没有符合搜索条件的预计来料。',

    detail_kicker: '质检详情',
    detail_close: '关闭',
    detail_close_aria: '关闭',
    detail_foot: '同步暂存 · 编辑自动保存',
    detail_quick_edit: '快捷编辑',
    detail_qa_due: '目标完成日期',
    detail_deadline: '期限',
    detail_assigned: '负责人',
    detail_remarks: '备注',
    detail_remarks_placeholder: '质检备注',
    detail_section_stage: '工序',
    detail_section_job: '工单详情',
    detail_field_stage: '工序',
    detail_field_status: '状态',
    detail_field_progress: '进度',
    detail_field_stage_required: '工序需求数量',
    detail_field_stage_produced: '工序已完成',
    detail_field_stage_rejected: '工序不合格',
    detail_field_ps: '工艺单',
    detail_field_partial: '分件',
    detail_field_part: '零件',
    detail_field_description: '描述',
    detail_field_po_due: '订单交期',
    detail_field_coway_edd: '建议交期',
    detail_field_delivery: '交货安排',
    detail_field_checklist: '清单完成',
    detail_field_exception: '异常',

    inspectors_title: '质检员',
    inspectors_hint: '添加或移除质检员。他们会出现在队列的“负责人”下拉菜单中。',
    inspectors_placeholder: '质检员姓名',
    inspectors_add: '添加质检员',
    inspectors_empty: '暂无质检员。',
    inspectors_remove: '移除',
    inspectors_confirm_remove: '从质检团队中移除此质检员？',

    unassigned: '— 未分配 —',
    unassigned_label: '未分配',
    everyone: '全部',
    yes: '是',
    no: '否',
    pcs: '件',
    partial: '分件 {n}',
    open_details: '打开详情',
    mark_done: '标记完成',
    mark_not_done: '取消完成',
    flag_exception: '标记异常',
    clear_exception: '清除异常',
    mark_inspection_done: '标记检验完成',

    status_in_process: '进行中',
    status_ready: '可开始',
    status_pending_si: '待 SI',
    status_completed: '已完成',
    status_pending: '待处理',
    status_ready_short: '就绪',

    week_label: '第 {n} 周',
    week_day: '第 {n} 周 - {day}',
    weekday_sun: '周日',
    weekday_mon: '周一',
    weekday_tues: '周二',
    weekday_wed: '周三',
    weekday_thu: '周四',
    weekday_fri: '周五',
    weekday_sat: '周六',
    from_coway_edd: '来自建议交期（{date}）',
    from_po_due: '来自订单交期（{date}）',

    stats_queue: '{n} 排队 · {i} 进行中 · {r} 可开始 · {stage}',
    stats_incoming: ' · {n} 即将转入',
    stats_incoming_only: '{n} 个即将从去毛刺转入',
    incoming_from_deburring: '去毛刺转入',
    incoming_now_final_inspection: '正在最终检验',
    incoming_badge: '转入',
    stats_exceptions: ' · {n} 个异常',
    stats_exceptions_plural: ' · {n} 个异常',
    stats_jobs_assignees: '{n} 个工单 / {groups} 位负责人 · 按负责人分组',
    stats_jobs_assignees_plural: '{n} 个工单 / {groups} 位负责人 · 按负责人分组',
    stats_unassigned: '{n} 个未分配工单',
    stats_unassigned_plural: '{n} 个未分配工单',
    stats_for_assignee: '{name}：{n} 个工单',
    stats_for_assignee_plural: '{name}：{n} 个工单',
    stats_sorted: '{n} 个工单 · 按列排序',
    stats_sorted_plural: '{n} 个工单 · 按列排序',
    stats_mia: '{n} 个带装配工序的工单',
    stats_mia_plural: '{n} 个带装配工序的工单',
    stats_mi: '{view}：{n} · 未完成 {o} · 就绪 {r} · 历史 {h}',
    stats_qcq: '{view}：显示 {n} · 未完成 {o} · 历史 {h} · ERP 共 {total} 条',
    stage_all_label: '全部工序',
    stage_deburring_label: '去毛刺',
    stage_final_inspection_label: '最终检验',
    stage_packing_label: '包装',
    stage_engraving_packing_label: '包装与打标',

    jobs_count: '{n} 个工单',
    jobs_count_plural: '{n} 个工单',
    exceptions_count: '{n} 个异常',
    exceptions_count_plural: '{n} 个异常',
    next_qa: '最近目标 {date}',
    next_deadline: '最近期限 {date}',
    jobs_total: '共 {n} 个工单',
    jobs_total_plural: '共 {n} 个工单',
    assignees_count: '{n} 位负责人',
    assignees_count_plural: '{n} 位负责人',
    qa_from: '目标从 {date}',
    flagged: '{n} 个标记',

    saving: '保存中…',
    saved: '已保存 ✓',
    failed: '失败',
    loading_short: '加载中…',
    loading_mi: '正在加载来料检验…',
    loading_qcq: '正在加载 ERP 质检队列…',
    loading_am: '正在加载预计来料…',
    loading_interactive: '正在加载交互式队列…',

    toast_marked_done: '已标记完成 ✓',
    toast_unmarked: '已取消标记',
    toast_exception_flagged: '已标记异常',
    toast_exception_cleared: '已清除异常',
    toast_assignment_saved: '分配已保存',
    toast_qa_due_saved: '目标完成日期已保存',
    toast_deadline_saved: '期限已保存',
    toast_remarks_saved: '备注已保存',
    toast_save_failed: '保存失败',
    toast_inspection_done: '已标记检验完成 ✓',
    toast_queue_refreshed: '队列已从 ERP 刷新',
    toast_mi_refreshed: '来料检验已从 ERP 刷新',
    toast_qcq_refreshed: '质检队列已从 ERP 刷新',
    toast_am_refreshed: '预计来料已刷新',
    toast_syncing: '正在从 ERP 同步工单状态…',
    toast_sync_fallback: '{msg} — 显示上次同步数据',
    toast_row_mismatch: '无法匹配此行 — 请刷新页面',

    meta_queue: '来源：同步暂存（mfg_wo_status + pp_vouchers_cache）· 缓存 {at} · TTL {ttl}秒 · 同步 ERP 获取最新数据',
    meta_mi: '来料检验 · COMAIN ERP 实时读取 · 缓存 {at} · 分配质检员以安排工作',
    meta_qcq: '质检队列 · COMAIN ERP 实时 · 检验 + 工单分配 + 制造工单 · 缓存 {at}',
    meta_am: '预计来料 · 来自销售订单管理「材料到位 / 外协」日期 · {at}',
    stats_am: '{n} 项预计来料 · {overdue} 项逾期 · {this_week} 项本周',

    stage_desc_deburring: '去毛刺',
    stage_desc_final_inspection: '最终检验',
    stage_desc_packing: '包装',
    stage_desc_engraving_packing: '打标与包装',
    stage_desc_material_issue: '发料与装配',
  },
};

function fqLocale() {
  try {
    if (localStorage.getItem(FQ_LOCALE_KEY) === 'zh') return 'zh';
  } catch (_) {}
  return 'en';
}

function fqT(key, vars = {}) {
  const locale = fqLocale();
  let text = FQ_STRINGS[locale]?.[key] ?? FQ_STRINGS.en[key] ?? String(key || '');
  Object.entries(vars || {}).forEach(([name, value]) => {
    text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
  });
  return text;
}

function fqPlural(baseKey, n, vars = {}) {
  const key = Number(n) === 1 ? baseKey : `${baseKey}_plural`;
  return fqT(key, { n, ...vars });
}

function fqWeekdayShort(dayIndex) {
  const keys = [
    'weekday_sun', 'weekday_mon', 'weekday_tues', 'weekday_wed',
    'weekday_thu', 'weekday_fri', 'weekday_sat',
  ];
  return fqT(keys[dayIndex] || 'weekday_sun');
}

function fqExecutionLabelI18n(code) {
  const c = String(code || '').trim().toUpperCase();
  if (c === 'I' || c === 'IN_PROCESS') return fqT('status_in_process');
  if (c === 'R' || c === 'READY_TO_START') return fqT('status_ready');
  if (c === 'P' || c === 'PENDING_SI') return fqT('status_pending_si');
  if (c === 'C' || c === 'COMPLETED') return fqT('status_completed');
  if (c === 'PENDING') return fqT('status_pending');
  return c || '—';
}

function fqStageBucketLabel(bucket) {
  const key = String(bucket || '').trim();
  if (!key || key === 'all') return fqT('stage_all_label');
  const map = {
    deburring: 'stage_deburring_label',
    final_inspection: 'stage_final_inspection_label',
    packing: 'stage_packing_label',
    engraving_packing: 'stage_engraving_packing_label',
  };
  return map[key] ? fqT(map[key]) : key.replace(/_/g, ' ');
}

function fqStageDescI18n(desc) {
  const raw = String(desc || '').trim();
  if (!raw) return '—';
  const norm = raw.toLowerCase().replace(/\s+/g, ' ');
  const map = {
    deburring: 'stage_desc_deburring',
    'final inspection': 'stage_desc_final_inspection',
    packing: 'stage_desc_packing',
    'engraving & packing': 'stage_desc_engraving_packing',
    'engraving and packing': 'stage_desc_engraving_packing',
    'pack & engrave': 'stage_desc_engraving_packing',
    'material issue & assembly': 'stage_desc_material_issue',
    'material issue and assembly': 'stage_desc_material_issue',
  };
  const key = map[norm];
  if (key) return fqT(key);
  if (norm.startsWith('final insp') || norm.startsWith('final ispection')) {
    return fqT('stage_desc_final_inspection');
  }
  return raw;
}

function fqMiViewLabelI18n(view) {
  if (view === 'ready') return fqT('mi_ready');
  if (view === 'historical') return fqT('mi_historical');
  return fqT('mi_outstanding');
}

function fqSetLocale(locale) {
  const next = locale === 'zh' ? 'zh' : 'en';
  try {
    localStorage.setItem(FQ_LOCALE_KEY, next);
  } catch (_) {}
  fqSyncLocaleUi();
}

function fqSyncLocaleStatic() {
  const locale = fqLocale();
  document.body.classList.toggle('qaqc-view--zh', locale === 'zh');
  document.body.dataset.fqLocale = locale;
  document.documentElement.lang = locale === 'zh' ? 'zh-Hans' : 'en';

  document.querySelectorAll('[data-fq-i18n]').forEach((el) => {
    const key = el.dataset.fqI18n;
    if (key) el.textContent = fqT(key);
  });
  document.querySelectorAll('[data-fq-i18n-placeholder]').forEach((el) => {
    const key = el.dataset.fqI18nPlaceholder;
    if (key) el.placeholder = fqT(key);
  });
  document.querySelectorAll('[data-fq-i18n-title]').forEach((el) => {
    const key = el.dataset.fqI18nTitle;
    if (key) el.title = fqT(key);
  });
  document.querySelectorAll('[data-fq-i18n-aria]').forEach((el) => {
    const key = el.dataset.fqI18nAria;
    if (key) el.setAttribute('aria-label', fqT(key));
  });

  const titleEl = document.querySelector('title');
  if (titleEl) titleEl.textContent = fqT('page_title');

  const enBtn = document.getElementById('fq-lang-en');
  const zhBtn = document.getElementById('fq-lang-zh');
  if (enBtn) {
    enBtn.classList.toggle('is-active', locale === 'en');
    enBtn.setAttribute('aria-pressed', locale === 'en' ? 'true' : 'false');
  }
  if (zhBtn) {
    zhBtn.classList.toggle('is-active', locale === 'zh');
    zhBtn.setAttribute('aria-pressed', locale === 'zh' ? 'true' : 'false');
  }
}

function fqSyncLocaleUi() {
  fqSyncLocaleStatic();
  if (typeof fqRenderTable === 'function' && window.__fqInteractive) {
    fqRenderTable();
    if (typeof fqOpenDetail === 'function' && fqState?.selectedKey) {
      const item = typeof fqFindItemByKey === 'function'
        ? fqFindItemByKey(fqState.selectedKey)
        : null;
      if (item) fqOpenDetail(item);
    }
    if (typeof fqRenderInspectorPanel === 'function') fqRenderInspectorPanel();
  }
}

function fqBindLocaleToggle() {
  if (window.__fqLocaleBound) return;
  window.__fqLocaleBound = true;
  document.getElementById('fq-lang-en')?.addEventListener('click', () => fqSetLocale('en'));
  document.getElementById('fq-lang-zh')?.addEventListener('click', () => fqSetLocale('zh'));
  fqSyncLocaleStatic();
}

window.fqLocale = fqLocale;
window.fqT = fqT;
window.fqPlural = fqPlural;
window.fqWeekdayShort = fqWeekdayShort;
window.fqExecutionLabelI18n = fqExecutionLabelI18n;
window.fqStageBucketLabel = fqStageBucketLabel;
window.fqStageDescI18n = fqStageDescI18n;
window.fqMiViewLabelI18n = fqMiViewLabelI18n;
window.fqSetLocale = fqSetLocale;
window.fqSyncLocaleUi = fqSyncLocaleUi;
window.fqBindLocaleToggle = fqBindLocaleToggle;
