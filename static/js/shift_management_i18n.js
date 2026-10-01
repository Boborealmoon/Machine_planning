/* Shift Management - English / Chinese (default: English). */

const SM_LOCALE_KEY = "shift-mgmt-locale-v1";

const SM_STRINGS = {
  "en": {
    "lang_toggle_aria": "Language",
    "open_record": "Open",
    "submitted_col": "Submitted",
    "filed_handover": "Filed handover{when}{who}. This is the logged copy.",
    "submitted_locked": "Submitted{when}{who}. This sheet is locked.",
    "by_person": " by {name}",
    "ticket_one": "{n} ticket",
    "ticket_many": "{n} tickets",
    "now_plus": "Now + next {n}",
    "more_on_queue": "+{n} more on queue",
    "machines_max": "Select your machines (max {n})",
    "status_set": "Status set to {status}",
    "ps_on": "Process sheet on {machine}",
    "match_one": "{n} match",
    "match_many": "{n} matches",
    "open_n": "{n} open",
    "report_lines_one": "Report filed · {n} line",
    "report_lines_many": "Report filed · {n} lines",
    "hoto_submitted_when": "HOTO submitted {when}",
    "issues_one": "{n} issue raised",
    "issues_many": "{n} issues raised",
    "signed_meta": "Signed {when}",
    "enter_rep": "Enter the {which} shift rep name first",
    "handover_wait_one": "{n} handover waiting for acknowledgement.",
    "handover_wait_many": "{n} handovers waiting for acknowledgement.",
    "queued_one": "queued job",
    "queued_many": "queued jobs",
    "tickets_open_of": "{open} open of {total} tickets",
    "tickets_closed_one": "{n} ticket closed",
    "tickets_closed_many": "{n} tickets closed",
    "item_n": "Item {n}",
    "quality_line": "Quality: {text}",
    "alarm_line": "Alarm: {text}",
    "maint_line": "Maint: {text}",
    "job_option": "{ps} · Q{q} · rem {rem}",
    "machine_line": "{machine} · {shift}",
    "machine_line_status": "{machine} · {shift} | {status}",
    "ack_already": "Already {status}",
    "ack_by": " by {name}",
    "ncr_open": "NCR open: {ref}",
    "priority_flag": "{priority}: {note}",
    "tickets_tab": "Tickets · {n}",
    "chip_ticket_one": "{n} ticket",
    "chip_ticket_many": "{n} tickets",
    "status_for_item": "Status for item {n}",
    "remarks_for_item": "Remarks for item {n}",
    "checked_by_for_item": "Checked by for item {n}",
    "attendance_name": "Attendance name {n}",
    "late_n": "Late {n}",
    "attendance_remarks": "Attendance remarks {n}",
    "set_status_for": "Set status for ticket {id}",
    "ps_aria": "Process sheet {n}",
    "desc_aria": "Description {n}",
    "target_aria": "Target quantity {n}",
    "produced_aria": "Produced quantity {n}",
    "rejected_aria": "Rejected quantity {n}",
    "cnc_aria": "CNC {n}",
    "scanned_aria": "Scanned ERP {n}",
    "qty_suggest": " · Qty {n}",
    "op_prefix": "Op {n}",
    "no_queue_suffix": " (no queue)",
    "idle_suffix": " · idle",
    "ps_job": "{machine} · PS {ps}",
    "ps_chip": "PS {ps}",
    "qty_left": "Qty left: {qty} | Tool life: {tool}%",
    "material_line": "Material: {qty} {unit}",
    "first_ncr": "First piece: {first} | NCR: {ncr}",
    "priority_line": "Priority: {priority}",
    "remarks_line": "Remarks: {text}",
    "open_tickets_n": "Open tickets: {n}",
    "status_job": "Status: {status} | Job {job}",
    "job_qty": "Job: {job} | Qty: {qty}",
    "tool_material": "Tool life: {tool}% | Material: {qty} {unit}",
    "first_piece_line": "First piece: {status}",
    "outgoing_line": "Outgoing: {name}",
    "signed_name": " · signed {name}",
    "submitted_by": "Submitted {when} by {name}",
    "submitted_when": "Submitted {when}",
    "users_status": "No users with status \"{status}\".",
    "created_ok": "Created {name} (approved)",
    "edit_subtitle": "{name} | {status}",
    "approve_failed": "Saved, but approve failed: {error}",
    "title_ops": "Ops Board — Day/Night HOTO",
    "title_jobs": "Jobs - Day/Night HOTO",
    "title_hoto": "HOTO Checklist - Shift Management",
    "title_history": "Shift record — Day/Night HOTO",
    "title_tickets": "Tickets - Day/Night HOTO",
    "title_dashboard": "Dashboard — Day/Night HOTO",
    "title_home": "My Machines — Day/Night HOTO",
    "title_entry": "Handover entry — Day/Night HOTO",
    "title_ack": "Acknowledge — Shift Management",
    "title_backlog": "Handover backlog - Shift Management",
    "title_login": "Shift Management - Sign in",
    "title_register": "Shift Management - Register",
    "title_admin": "Shift Management Users"
  },
  "zh": {
    "lang_toggle_aria": "语言",
    "open_record": "查看",
    "submitted_col": "提交时间",
    "filed_handover": "归档交接{when}{who}。这是已记录的副本。",
    "submitted_locked": "已提交{when}{who}。此表已锁定。",
    "by_person": "，提交人 {name}",
    "ticket_one": "{n} 张问题单",
    "ticket_many": "{n} 张问题单",
    "now_plus": "当前 + 后续 {n}",
    "more_on_queue": "队列中还有 {n} 项",
    "machines_max": "选择机床（最多 {n} 台）",
    "status_set": "状态已设为{status}",
    "ps_on": "{machine} 上的工艺单",
    "match_one": "{n} 条匹配",
    "match_many": "{n} 条匹配",
    "open_n": "{n} 未关闭",
    "report_lines_one": "报表已提交 · {n} 行",
    "report_lines_many": "报表已提交 · {n} 行",
    "hoto_submitted_when": "交接已提交 {when}",
    "issues_one": "已提 {n} 项问题",
    "issues_many": "已提 {n} 项问题",
    "signed_meta": "已签 {when}",
    "enter_rep": "请先填写{which}代表姓名",
    "handover_wait_one": "{n} 份交接待确认。",
    "handover_wait_many": "{n} 份交接待确认。",
    "queued_one": "排队作业",
    "queued_many": "排队作业",
    "tickets_open_of": "{total} 张中有 {open} 张未关闭",
    "tickets_closed_one": "{n} 张问题单已关闭",
    "tickets_closed_many": "{n} 张问题单已关闭",
    "item_n": "第 {n} 项",
    "quality_line": "质量：{text}",
    "alarm_line": "报警：{text}",
    "maint_line": "维护：{text}",
    "job_option": "{ps} · 队列{q} · 剩余 {rem}",
    "machine_line": "{machine} · {shift}",
    "machine_line_status": "{machine} · {shift} | {status}",
    "ack_already": "已{status}",
    "ack_by": "，确认人 {name}",
    "ncr_open": "NCR 未关闭：{ref}",
    "priority_flag": "{priority}：{note}",
    "tickets_tab": "问题单 · {n}",
    "chip_ticket_one": "{n} 张问题单",
    "chip_ticket_many": "{n} 张问题单",
    "status_for_item": "第 {n} 项状态",
    "remarks_for_item": "第 {n} 项备注",
    "checked_by_for_item": "第 {n} 项检查人",
    "attendance_name": "出勤姓名 {n}",
    "late_n": "第 {n} 人迟到",
    "attendance_remarks": "出勤备注 {n}",
    "set_status_for": "设置问题单 {id} 的状态",
    "ps_aria": "工艺单 {n}",
    "desc_aria": "描述 {n}",
    "target_aria": "目标数量 {n}",
    "produced_aria": "完成数量 {n}",
    "rejected_aria": "报废数量 {n}",
    "cnc_aria": "CNC {n}",
    "scanned_aria": "已扫 ERP {n}",
    "qty_suggest": " · 数量 {n}",
    "op_prefix": "工序 {n}",
    "no_queue_suffix": "（无队列）",
    "idle_suffix": " · 空闲",
    "ps_job": "{machine} · 工艺单 {ps}",
    "ps_chip": "工艺单 {ps}",
    "qty_left": "剩余数量：{qty} | 刀具寿命：{tool}%",
    "material_line": "物料：{qty} {unit}",
    "first_ncr": "首件：{first} | NCR：{ncr}",
    "priority_line": "优先级：{priority}",
    "remarks_line": "备注：{text}",
    "open_tickets_n": "未关闭问题单：{n}",
    "status_job": "状态：{status} | 作业 {job}",
    "job_qty": "作业：{job} | 数量：{qty}",
    "tool_material": "刀具寿命：{tool}% | 物料：{qty} {unit}",
    "first_piece_line": "首件：{status}",
    "outgoing_line": "交班人：{name}",
    "signed_name": " · 已签 {name}",
    "submitted_by": "已于 {when} 由 {name} 提交",
    "submitted_when": "已于 {when} 提交",
    "users_status": "没有状态为「{status}」的用户。",
    "created_ok": "已创建 {name}（已批准）",
    "edit_subtitle": "{name} | {status}",
    "approve_failed": "已保存，但批准失败：{error}",
    "title_ops": "作业看板 — 白夜班交接",
    "title_jobs": "作业 — 白夜班交接",
    "title_hoto": "交接检查表 — 班次管理",
    "title_history": "班次记录 — 白夜班交接",
    "title_tickets": "问题单 — 白夜班交接",
    "title_dashboard": "看板 — 白夜班交接",
    "title_home": "我的机床 — 白夜班交接",
    "title_entry": "交接录入 — 白夜班交接",
    "title_ack": "确认交接 — 班次管理",
    "title_backlog": "交接归档 — 班次管理",
    "title_login": "班次管理 — 登录",
    "title_register": "班次管理 — 注册",
    "title_admin": "班次管理用户"
  }
};

const SM_ZH = {
  "Day/Night HOTO": "白夜班交接",
  "Out": "退出",
  "Language": "语言",
  "← Back": "← 返回",
  "Dashboard": "看板",
  "Queue": "队列",
  "Tickets": "问题单",
  "Jobs": "作业",
  "History": "记录",
  "HOTO": "交接",
  "Backlog": "归档",
  "Floor": "车间",
  "Day": "白班",
  "Night": "夜班",
  "All": "全部",
  "Date": "日期",
  "Find": "查找",
  "Status": "状态",
  "Sort": "排序",
  "From": "从",
  "To": "至",
  "Apply": "筛选",
  "Refresh": "刷新",
  "Shift PDF": "班次 PDF",
  "Download the end-of-shift PDF": "下载班次结束 PDF",
  "Active queue": "当前队列",
  "Shift reporting": "班次报表",
  "Reporting": "报表",
  "Report": "报表",
  "Select up to 4 machines. Tap a job, then Raise ticket.": "最多选 4 台机床。点选作业，然后提交问题单。",
  "Select machines to see their queues.": "选择机床以查看队列。",
  "Machine or PS": "机床或工艺单",
  "Find machine or PS": "查找机床或工艺单",
  "Loading…": "加载中…",
  "Loading...": "加载中...",
  "PRODUCTION SUMMARY & SCANNED ITEMS": "产量汇总与扫描项目",
  "Qty Produced": "完成数量",
  "Process Sheet": "工艺单",
  "Description": "描述",
  "Target Qty": "目标数量",
  "Produced Qty": "完成数量",
  "Rejected Qty": "报废数量",
  "CNC": "CNC",
  "Scanned ERP? (Y/N)": "已扫 ERP？（是/否）",
  "Scanned ERP": "已扫 ERP",
  "TOTAL": "合计",
  "Add line": "添加行",
  "Print": "打印",
  "Start typing a process sheet number and pick a suggestion. Description and target quantity fill in. Then enter the produced and rejected quantity, the CNC, and Y or N for scanned ERP. When the shift is finished, submit HOTO. History keeps this report, the checklist, and the shift's tickets together.": "开始输入工艺单号并选择建议。描述和目标数量会自动填入。然后填写完成数量、报废数量、CNC，以及是否已扫 ERP（是/否）。班次结束后提交交接。记录里会一起保存这份报表、检查表和本班问题单。",
  "Raise ticket": "提交问题单",
  "Machine": "机床",
  "Queued job": "排队作业",
  "Category": "类别",
  "Priority": "优先级",
  "Title": "标题",
  "Details": "详情",
  "What needs attention?": "需要关注什么？",
  "Cancel": "取消",
  "Create ticket": "创建问题单",
  "Create": "创建",
  "Normal": "普通",
  "High": "高",
  "Urgent": "紧急",
  "Work instructions": "作业指示",
  "Choose a machine. Its queue opens so you can pick a process sheet and raise a ticket.": "选择一台机床。队列会打开，以便选择工艺单并提交问题单。",
  "Machine or PS no.": "机床或工艺单号",
  "Shift": "班次",
  "Select a process sheet, then raise a ticket.": "选择工艺单，然后提交问题单。",
  "Shift date": "班次日期",
  "Current shift": "当前班次",
  "Submit": "提交",
  "Reopen": "重新打开",
  "SHIFT HANDOVER (HOTO) CHECKLIST - MFG": "班次交接（HOTO）检查表 - 制造",
  "SHIFT DETAILS": "班次信息",
  "Handover Date/Time": "交接日期/时间",
  "Handover date and time": "交接日期和时间",
  "Outgoing Shift Rep": "交班代表",
  "Outgoing shift rep": "交班代表",
  "Incoming Shift Rep": "接班代表",
  "Incoming shift rep": "接班代表",
  "HANDOVER CHECKLIST": "交接检查项",
  "Checklist Item": "检查项目",
  "Remarks": "备注",
  "Checked By": "检查人",
  "No Issue": "无问题",
  "Issue Raised": "已提问题",
  "SIGN-OFF": "签核",
  "Outgoing Shift Rep (Name & Sign)": "交班代表（姓名与签名）",
  "Incoming Shift Rep (Name & Sign)": "接班代表（姓名与签名）",
  "Sign": "签名",
  "Clear": "清除",
  "SHIFT ATTENDANCE": "出勤",
  "Name": "姓名",
  "Late?": "迟到？",
  "Late": "迟到",
  "E.g.": "例",
  "Early fallout (Medical checkup)": "早退（体检）",
  "see": "参见",
  "ERP scanned output": "ERP 扫描产出",
  "QAQC view": "质检视图",
  "Work done / production plan for the shift communicated": "本班完成工作 / 生产计划已传达",
  "Qty produced this shift reported": "本班产量已汇报",
  "Scanned items for this shift logged": "本班扫描项目已记录",
  "Open issues reviewed and handed over": "未关闭问题已复核并交接",
  "Machines/equipment status and WIP handed over": "设备状态与在制品已交接",
  "Housekeeping, tools, keys, and access handed over": "现场整理、工具、钥匙和权限已交接",
  "Shift record": "班次记录",
  "The production report, HOTO checklist, and tickets filed for one shift.": "一个班次提交的产量报表、交接检查表和问题单。",
  "Recent shifts": "近期班次",
  "New ticket": "新建问题单",
  "Review who raised each ticket, set its status, and sort the queue.": "查看每张问题单的提交人，设置状态，并排序。",
  "You only see tickets you submitted. A supervisor sets the status.": "你只能看到自己提交的问题单。主管设置状态。",
  "Open only": "仅未关闭",
  "In progress": "进行中",
  "On hold": "暂停",
  "Resolved": "已解决",
  "Closed": "已关闭",
  "Newest": "最新",
  "Oldest": "最早",
  "Submitted by": "提交人",
  "Pick a machine from today's queue.": "从今天的队列中选择机床。",
  "Machine / job": "机床 / 作业",
  "Shift dashboard": "班次看板",
  "Download PDF report": "下载 PDF 报表",
  "Queued jobs per CNC": "各 CNC 排队作业",
  "Open tickets": "未关闭问题单",
  "Handover status": "交接状态",
  "My Machines": "我的机床",
  "Tap a machine on the floor or card to open handover entry.": "点选车间图或卡片上的机床，打开交接录入。",
  "1 Status": "1 状态",
  "2 Issues": "2 问题",
  "3 Hand off": "3 交接",
  "Machine…": "机床…",
  "Ready": "就绪",
  "Machine status": "机床状态",
  "Active job (from queue)": "当前作业（来自队列）",
  "Process sheet / Job No": "工艺单 / 作业号",
  "Remaining qty": "剩余数量",
  "First piece": "首件",
  "Tool life (% remaining)": "刀具寿命（剩余 %）",
  "Material balance": "物料结余",
  "Quality issues": "质量问题",
  "Machine alarms": "机床报警",
  "Pending maintenance": "待维护",
  "Nil": "无",
  "Issue": "有问题",
  "Describe quality issue…": "描述质量问题…",
  "Describe alarm…": "描述报警…",
  "Describe maintenance…": "描述维护…",
  "NCR status": "NCR 状态",
  "NCR ref": "NCR 编号",
  "Priority for next shift": "下一班优先级",
  "Why High/Urgent?": "为何为高/紧急？",
  "Remarks (optional)": "备注（可选）",
  "Anything else…": "其他事项…",
  "Shift comments": "班次备注",
  "Add a comment for the next shift…": "给下一班添加备注…",
  "Add comment": "添加备注",
  "Confirm & Hand Over": "确认并交接",
  "Next": "下一步",
  "Review": "核对",
  "Back": "返回",
  "Loading handover…": "正在加载交接…",
  "Handover backlog": "交接归档",
  "Submitted shift handover sheets. Open a row to read or print that filed copy.": "已提交的班次交接表。打开一行即可查看或打印该份归档。",
  "Submitted": "已提交",
  "Outgoing": "交班",
  "Incoming": "接班",
  "Filed by": "提交人",
  "Shift Management": "班次管理",
  "Daily handover and takeover": "日常交接班",
  "Username": "用户名",
  "Password / PIN": "密码 / PIN",
  "Sign in": "登录",
  "Demo PIN 1234 — op1 (operator), sup1 (supervisor), qc1 (quality), adm1 (admin)": "演示 PIN 1234 — op1（操作员）、sup1（主管）、qc1（质量）、adm1（管理员）",
  "Create account": "创建账号",
  "Pending approval after signup": "注册后待批准",
  "Display name": "显示名",
  "Password / PIN (min 4)": "密码 / PIN（至少 4 位）",
  "Confirm": "确认",
  "Register": "注册",
  "Back to sign in": "返回登录",
  "Admin": "管理",
  "Shift Management Users": "班次管理用户",
  "Approve operator accounts and reset PINs.": "批准操作员账号并重置 PIN。",
  "Back to Admin": "返回管理",
  "Open app": "打开应用",
  "Create approved user": "创建已批准用户",
  "Bootstrap operators without waiting for self-registration.": "直接建立操作员，无需等待自行注册。",
  "Role": "角色",
  "Default shift": "默认班次",
  "Create and approve": "创建并批准",
  "Accounts": "账号",
  "Display": "显示名",
  "Created": "创建时间",
  "Last login": "上次登录",
  "Actions": "操作",
  "No users match this filter.": "没有符合此筛选的用户。",
  "Edit user": "编辑用户",
  "New password / PIN (leave blank to keep)": "新密码 / PIN（留空则保持不变）",
  "Save": "保存",
  "Save & Approve": "保存并批准",
  "operator": "操作员",
  "supervisor": "主管",
  "quality": "质量",
  "admin": "管理员",
  "pending": "待审批",
  "approved": "已批准",
  "disabled": "已停用",
  "Running": "运行中",
  "Idle": "空闲",
  "Breakdown": "故障",
  "Under Maintenance": "维修中",
  "Setup": "调机",
  "OK": "合格",
  "Not OK": "不合格",
  "Pending Approval": "待批准",
  "N/A": "不适用",
  "Open": "未关闭",
  "Alarm": "报警",
  "Maintenance": "维护",
  "Material": "物料",
  "Tooling": "刀具",
  "Other": "其他",
  "Quality": "质量",
  "pcs": "件",
  "Y": "是",
  "N": "否",
  "TURNMILL": "车铣",
  "Turnmill": "车铣",
  "TURNING": "车削",
  "Turning": "车削",
  "MILLING": "铣削",
  "Milling": "铣削",
  "NOW": "当前",
  "NEXT": "下一",
  "THEN": "随后",
  "pending_ack": "待确认",
  "acknowledged": "已确认",
  "disputed": "有异议",
  "draft": "草稿",
  "Pending ack": "待确认",
  "Acked": "已确认",
  "Disputed": "有异议",
  "Draft": "草稿",
  "No entry": "无记录",
  "Pending": "待处理",
  "Approved": "已批准",
  "Disabled": "已停用",
  "open": "未关闭",
  "in_progress": "进行中",
  "on_hold": "暂停",
  "resolved": "已解决",
  "closed": "已关闭",
  "Request timed out. Try Refresh.": "请求超时。请点刷新。",
  "Request failed": "请求失败",
  "No queued job": "没有排队作业",
  "No machines match that search.": "没有符合搜索的机床。",
  "Now": "当前",
  "Empty queue": "队列为空",
  "Operation": "工序",
  "Qty": "数量",
  "Plan": "计划",
  "No jobs in this queue.": "此队列没有作业。",
  "No machines assigned. Ask a planner to map machines to your login.": "没有分配机床。请计划员把机床关联到你的登录。",
  "Select machines above to show lanes.": "在上方选择机床以显示队列。",
  "Retry": "重试",
  "Choose a machine first": "请先选择机床",
  "Select a queued job": "请选择排队作业",
  "Choose a machine, then a queued job.": "请先选择机床，再选择排队作业。",
  "Creating…": "正在创建…",
  "Ticket created": "问题单已创建",
  "Not saved": "未保存",
  "Saved": "已保存",
  "Saving…": "正在保存…",
  "Saving...": "正在保存...",
  "No description": "无描述",
  "Not in ERP — type description": "ERP 中没有 — 请填写描述",
  "Save failed": "保存失败",
  "Manual / other": "手动 / 其他",
  "Job": "作业",
  "User": "用户",
  "No open tickets for this machine.": "此机床没有未关闭的问题单。",
  "No comments yet.": "还没有备注。",
  "Issues: Nil": "问题：无",
  "Already handed over": "已经交接",
  "Comment added": "备注已添加",
  "Submitting...": "正在提交...",
  "Handed over - pending acknowledgement": "已交接 — 待确认",
  "Submit failed": "提交失败",
  "No issues flagged": "未标记问题",
  "Comments": "备注",
  "Acknowledge": "确认",
  "Flag discrepancy": "标记差异",
  "What is wrong with this handover?": "这份交接有什么问题？",
  "Submit discrepancy": "提交差异",
  "Acknowledged": "已确认",
  "Discrepancy flagged": "已标记差异",
  "First piece Not OK": "首件不合格",
  "Breakdowns": "故障",
  "Open NCRs": "未关闭 NCR",
  "Pending maint.": "待维护",
  "1st piece NOK": "首件不合格",
  "No handovers for this date yet.": "该日期还没有交接。",
  "No queued jobs for this shift.": "本班没有排队作业。",
  "No open tickets.": "没有未关闭的问题单。",
  "No submitted handovers in this range.": "此范围内没有已提交的交接。",
  "HOTO draft": "交接草稿",
  "No shifts filed in this range.": "此范围内没有已归档班次。",
  "No report yet": "还没有报表",
  "HOTO still a draft": "交接仍是草稿",
  "HOTO not started": "交接未开始",
  "No tickets": "没有问题单",
  "No production report filed for this shift.": "本班尚未提交产量报表。",
  "Fill it on the queue": "到队列填写",
  "PDF report": "PDF 报表",
  "Edit on the queue": "在队列中编辑",
  "No HOTO checklist filed for this shift.": "本班尚未提交交接检查表。",
  "Open HOTO": "打开交接",
  "Draft — not submitted yet": "草稿 — 尚未提交",
  "Item": "项目",
  "Checked by": "检查人",
  "Handover": "交接",
  "ATTENDANCE": "出勤",
  "No attendance recorded.": "没有出勤记录。",
  "Open checklist": "打开检查表",
  "Finish on HOTO": "到交接页完成",
  "No tickets for this shift.": "本班没有问题单。",
  "Raise one from the queue": "从队列提交",
  "Handover submitted": "交接已提交",
  "Choose a machine": "选择机床",
  "No machines on the queue for this shift.": "本班队列没有机床。",
  "Machine queue": "机床队列",
  "· tap a process sheet": "· 点选工艺单",
  "Machines": "机床",
  "Nothing queued on this machine.": "此机床没有排队作业。",
  "Select a process sheet": "请选择工艺单",
  "No tickets.": "没有问题单。",
  "Unknown user": "未知用户",
  "Floor layout unavailable.": "车间布局不可用。",
  "No active machines found.": "没有在用机床。",
  "Factory floor plan": "车间平面图",
  "Unavailable": "不可用",
  "Filed copy": "归档副本",
  "Could not load": "无法加载",
  "Could not load handover": "无法加载交接",
  "Not saved yet": "尚未保存",
  "Could not load checklist": "无法加载检查表",
  "Could not save checklist": "无法保存检查表",
  "Unsaved": "未保存",
  "incoming": "接班",
  "outgoing": "交班",
  "Not submitted": "未提交",
  "Could not submit": "无法提交",
  "Handover reopened": "交接已重新打开",
  "Could not reopen": "无法重新打开",
  "outgoing shift rep": "交班代表",
  "incoming shift rep": "接班代表",
  "outgoing signature": "交班签名",
  "incoming signature": "接班签名",
  "Invalid username or password/PIN.": "用户名或密码/PIN 不正确。",
  "Your account is awaiting approval.": "你的账号正在等待批准。",
  "Your account has been disabled.": "你的账号已停用。",
  "Your account cannot sign in.": "你的账号无法登录。",
  "That username is already taken.": "该用户名已被使用。",
  "Username must be 2-64 characters (letters, numbers, . _ -).": "用户名须为 2-64 个字符（字母、数字、. _ -）。",
  "Password confirmation does not match.": "两次密码不一致。",
  "Password/PIN must be at least 4 characters.": "密码/PIN 至少 4 位。",
  "Account created. An admin must approve it before you can sign in.": "账号已创建。管理员批准后才能登录。",
  "No users yet. Create one above.": "还没有用户。请在上方创建。",
  "No pending accounts. Switch Status to All or Approved to see existing users.": "没有待审批账号。把状态改成全部或已批准以查看现有用户。",
  "Failed to load users.": "无法加载用户。",
  "Approve": "批准",
  "Reject": "拒绝",
  "Disable": "停用",
  "Re-approve": "重新批准",
  "Edit": "编辑",
  "Action failed": "操作失败",
  "Creating...": "正在创建...",
  "Create failed": "创建失败",
  "Password/PIN must be at least 4 characters (or leave blank).": "密码/PIN 至少 4 位（或留空）。",
  "Missing user id.": "缺少用户编号。",
  "Save failed.": "保存失败。",
  "Saved and approved.": "已保存并批准。",
  "Saved.": "已保存。",
  "New password / PIN": "新密码 / PIN",
  "(leave blank to keep)": "（留空则保持不变）"
};

const SM_PAGE_TITLES = {
  ops: "title_ops",
  jobs: "title_jobs",
  hoto: "title_hoto",
  history: "title_history",
  tickets: "title_tickets",
  dashboard: "title_dashboard",
  home: "title_home",
  entry: "title_entry",
  ack: "title_ack",
  backlog: "title_backlog",
  login: "title_login",
  register: "title_register",
  admin: "title_admin",
};

function smLocale() {
  try {
    return localStorage.getItem(SM_LOCALE_KEY) === "zh" ? "zh" : "en";
  } catch (_) {
    return "en";
  }
}

function smT(key, vars) {
  const locale = smLocale();
  let text =
    (SM_STRINGS[locale] && SM_STRINGS[locale][key]) ||
    (SM_STRINGS.en && SM_STRINGS.en[key]) ||
    String(key || "");
  if (vars) {
    Object.keys(vars).forEach(function (name) {
      text = text.split("{" + name + "}").join(vars[name] == null ? "" : String(vars[name]));
    });
  }
  return text;
}

function smL(text) {
  const raw = text == null ? "" : String(text);
  if (smLocale() !== "zh") return raw;
  if (Object.prototype.hasOwnProperty.call(SM_ZH, raw)) return SM_ZH[raw];
  const add = raw.match(/^Add (.+) before submitting\.$/);
  if (add) {
    const parts = add[1].split(", ").map(function (part) {
      return SM_ZH[part] || part;
    });
    return "\u63d0\u4ea4\u524d\u8bf7\u5148\u586b\u5199\uff1a" + parts.join("\u3001") + "\u3002";
  }
  const pin = raw.match(/^Password\/PIN must be at least (\d+) characters\.$/);
  if (pin) return "\u5bc6\u7801/PIN \u81f3\u5c11 " + pin[1] + " \u4f4d\u3002";
  return raw;
}

function smN(n, oneKey, manyKey, extra) {
  const vars = Object.assign({ n: n }, extra || {});
  return smT(Number(n) === 1 ? oneKey : manyKey, vars);
}

function smFill(el, attr, read, write) {
  const key = el.getAttribute(attr);
  if (key) {
    write(smT(key, el.getAttribute("data-sm-n") != null ? { n: el.getAttribute("data-sm-n") } : undefined));
    return;
  }
  const srcAttr = attr + "-src";
  if (!el.hasAttribute(srcAttr)) el.setAttribute(srcAttr, read() || "");
  write(smL(el.getAttribute(srcAttr)));
}

function smApply() {
  const locale = smLocale();
  document.body.classList.toggle("sm-locale-zh", locale === "zh");
  document.body.dataset.smLocale = locale;
  document.documentElement.lang = locale === "zh" ? "zh-Hans" : "en";

  document.querySelectorAll("[data-sm-t]").forEach(function (el) {
    smFill(el, "data-sm-t", function () { return (el.textContent || "").trim(); }, function (text) { el.textContent = text; });
  });
  document.querySelectorAll("[data-sm-ph]").forEach(function (el) {
    smFill(el, "data-sm-ph", function () { return el.getAttribute("placeholder") || ""; }, function (text) { el.placeholder = text; });
  });
  document.querySelectorAll("[data-sm-aria]").forEach(function (el) {
    smFill(el, "data-sm-aria", function () { return el.getAttribute("aria-label") || ""; }, function (text) { el.setAttribute("aria-label", text); });
  });
  document.querySelectorAll("[data-sm-title]").forEach(function (el) {
    smFill(el, "data-sm-title", function () { return el.getAttribute("title") || ""; }, function (text) { el.title = text; });
  });
  document.querySelectorAll("[data-sm-msg]").forEach(function (el) {
    el.textContent = smL(el.getAttribute("data-sm-msg"));
  });
  document.querySelectorAll("[data-sm-nav]").forEach(function (el) {
    const label = {
      dashboard: "Dashboard",
      ops: "Queue",
      tickets: "Tickets",
      jobs: "Jobs",
      history: "History",
      hoto: "HOTO",
      backlog: "Backlog",
      machines: "Floor",
    }[el.getAttribute("data-sm-nav")];
    if (label) el.textContent = smL(label);
  });
  const pill = document.getElementById("sm-user-pill");
  if (pill) {
    const role = pill.getAttribute("data-sm-role") || "";
    const name = (window.SM && SM.userDisplay) || "";
    pill.textContent = (name ? name + " \u00b7 " : "") + smL(role);
    pill.title = smL(role);
  }
  const page = (document.body && document.body.getAttribute("data-page")) || "";
  const titleKey = SM_PAGE_TITLES[page];
  if (titleKey) document.title = smT(titleKey);

  const enBtn = document.getElementById("sm-lang-en");
  const zhBtn = document.getElementById("sm-lang-zh");
  if (enBtn) {
    enBtn.classList.toggle("is-active", locale === "en");
    enBtn.setAttribute("aria-pressed", locale === "en" ? "true" : "false");
  }
  if (zhBtn) {
    zhBtn.classList.toggle("is-active", locale === "zh");
    zhBtn.setAttribute("aria-pressed", locale === "zh" ? "true" : "false");
  }
}

function smSetLocale(locale) {
  const next = locale === "zh" ? "zh" : "en";
  try {
    localStorage.setItem(SM_LOCALE_KEY, next);
  } catch (_) {}
  smApply();
  document.dispatchEvent(new CustomEvent("sm-locale", { detail: { locale: next } }));
}

function smBindLocale() {
  if (window.__smLocaleBound) return;
  window.__smLocaleBound = true;
  const enBtn = document.getElementById("sm-lang-en");
  const zhBtn = document.getElementById("sm-lang-zh");
  if (enBtn) enBtn.addEventListener("click", function () { smSetLocale("en"); });
  if (zhBtn) zhBtn.addEventListener("click", function () { smSetLocale("zh"); });
  smApply();
}

window.smLocale = smLocale;
window.smT = smT;
window.smL = smL;
window.smN = smN;
window.smApply = smApply;
window.smSetLocale = smSetLocale;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", smBindLocale);
} else {
  smBindLocale();
}

