# Machine Planning System — User Guide

**Version:** 2025  
**Platform:** Web browser (Chrome / Edge recommended)  
**Access:** Internal network only

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Navigation Overview](#2-navigation-overview)
3. [Planner (Schedule Board)](#3-planner-schedule-board)
4. [Process Sheets](#4-process-sheets)
5. [Orders](#5-orders)
6. [Production Dashboards](#6-production-dashboards)
7. [Master Data](#7-master-data)
8. [ERP Sync](#8-erp-sync)
9. [Filter Reference](#9-filter-reference)
10. [Button Reference](#10-button-reference)
11. [Colour & Status Codes](#11-colour--status-codes)
12. [Access & Security](#12-access--security)

---

## 1. Getting Started

### 1.1 Logging In

| Role | URL | Access |
|------|-----|--------|
| Planner | `/planner` | Passcode-protected |
| Shop floor (machinists) | `/machine-queue` | Open, read-only |

When a passcode has been configured, the root page (`/`) will show a passcode gate before redirecting to the planner. Enter the passcode provided by your administrator.

To **lock** your session when leaving the workstation, click **Lock** in the top-right corner of the navigation bar. This clears your session and returns to the gate.

---

## 2. Navigation Overview

The top navigation bar is always visible and provides access to all sections.

| Nav Item | Sub-items | Purpose |
|----------|-----------|---------|
| **PLANNER** | — | Main drag-and-drop scheduling board |
| **PROCESS SHEETS** | — | View and manage all PP vouchers / process sheets |
| **ORDERS** | New Orders | Goods received this week from COMAIN ERP |
| | Sales Orders | Sales order headers → PP voucher groups |
| | Repeat Orders | Recurring purchase orders |
| **PRODUCTION** | Daily Output | Shift production board |
| | Finishing Queue | Parts at Deburring / Final Inspection / Packing |
| | Material Inspection | QC inspection status of incoming materials |
| | Auk OEE | Machine efficiency dashboard |
| | Queue Delays | Late / at-risk scheduled jobs |
| **MASTER DATA** | Inventory BOM | Bill of materials by part code |
| | Machines | Machine catalog and shift profiles |
| | Cycle Times | Master cycle time reference |
| | Program / Tool List | Program code and tool assignments per part/op |
| **BOM VARIATION** | — | Alternate BOM lookup per part or PS |
| **Sync ERP** | — | Pull latest data from COMAIN (top-right button) |

---

## 3. Planner (Schedule Board)

The Planner is the central scheduling workspace. It displays all machines as horizontal lanes with scheduled operations (blocks) placed on a timeline.

### 3.1 Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  LEGEND STRIP  (status colours explained)                        │
├──────────────┬──────────────────────────────────┬───────────────┤
│  LEFT PANEL  │        MACHINE LANES (scrollable) │  RIGHT SIDEBAR│
│  (filters)   │  [MC-001] [Block] [Block]  ─────  │  PS / Op      │
│              │  [MC-002] [Block]          ─────  │  Catalog      │
│              │  [MC-003]                  ─────  │               │
└──────────────┴──────────────────────────────────┴───────────────┘
```

- **Machine Lanes** — Each row is a machine. Blocks represent scheduled operations in queue order.
- **Right Sidebar** — Lists all unscheduled PS / operations available to be dragged onto a machine.
- **Legend Strip** — Colour key for block statuses (see [Section 11](#11-colour--status-codes)).

### 3.2 Navigating the Board

| Action | How |
|--------|-----|
| Scroll machines left/right | Drag on the lane area, or **Shift + mouse wheel** |
| Scroll the page up/down | Regular mouse wheel |
| Zoom time range | Date range picker (top toolbar) |

### 3.3 Scheduling an Operation

1. Locate the PS in the **right sidebar** catalog. Use the search box ("Search PS, part, op…") to find it.
2. Expand the PS row to see its operations.
3. **Drag** the operation card from the sidebar onto the target machine lane.
4. Drop it into position (before or after existing blocks).
5. The system recalculates start/end times automatically and re-renders the lane.

### 3.4 Reordering Blocks

- **Drag** a block left or right within its machine lane to change queue position.
- The schedule recalculates after every drop.

### 3.5 Block Detail Modal

Click any block to open the detail modal. It has three tabs:

| Tab | Contents |
|-----|----------|
| **Setup** | Edit setup minutes and cycle time per piece. Click **Save** to apply. |
| **Actuals** | Log daily production output: output qty, reject qty, remarks, report date. Click **Add actual** to submit. |
| **Visual** | Gantt view of the block's timing, including break windows and shift profile. |

**Buttons inside the modal:**

| Button | Action |
|--------|--------|
| **Save** | Persist setup/cycle time edits to the database |
| **Create rework** | Opens the rework sub-modal to generate a [Temp] PS for rejected qty |
| **Open material status** | Opens the material supply status modal |

### 3.6 Creating a Rework (Reject Copy)

1. Open the block modal → click **Create rework**.
2. Select the segment (operation step) that has the reject.
3. Enter the rework quantity.
4. Click **Create [Temp] PS**. A temporary process sheet is generated and appears in the sidebar.
5. Schedule the [Temp] PS onto the appropriate machine as needed.

### 3.7 Updating Material Status

1. Click the material status icon on a block card (green = in stock, red = awaiting stock).
2. Set **Supply status**: `ORDERED` / `PENDING CONFIRMATION` / `RECEIVED`.
3. Fill in **Expected ready date**, **Supplier reference**, and **Remarks** as needed.
4. Click **Save**.

### 3.8 Sidebar Controls

| Control | Action |
|---------|--------|
| **Search box** | Filter catalog by PS number, part number, or operation name |
| **Temp PS** button | Open modal to manually create a new [Temp] process sheet |
| **Completed** toggle | Show or hide PS that are fully done |
| **Unqueued only** toggle | Show only PS that still have unscheduled operations |
| **Sort by due** button | Re-sort the catalog list by due date (earliest first) |

### 3.9 Stale Schedule Banner

If you reorder or add blocks while filtered to specific machines, a yellow banner may appear:

> "N machines: schedule times may be outdated"

Click **Recalculate schedules** to trigger a fresh calculation. This is safe to click at any time.

### 3.10 Capacity & Calendar Windows

Administrators can add calendar events per machine (maintenance downtime, overtime, public holidays). These appear as shaded windows in the lane. To manage:

- **Add window:** Via the machine settings panel (admin only).
- **Window types:** Maintenance, Overtime, Holiday.
- **Effect:** The scheduler respects these windows when calculating start/end times.

---

## 4. Process Sheets

**URL:** `/process-sheets`

Lists all process sheets (PP vouchers) from both the planner and the ERP (COMAIN). Used for queue management and scheduling priority decisions.

### 4.1 Tabs

| Tab | Contents |
|-----|----------|
| **Production Queue** | All active planner PS + ERP-only vouchers |
| **Temp Reject PS** | [Temp] reject/rework process sheets only |

### 4.2 Filters (Production Queue tab)

| Filter | Options | Effect |
|--------|---------|--------|
| **Search** | Free text | Matches PS number, part number, PO, description. Comma-separate for multi-term search. |
| **Type** | MPS, APS, NPS, [SR], PPS, CPS | Show only selected PS types (multi-select) |
| **Temp** | All / [Temp] only / Hide [Temp] | Include, exclude, or isolate temporary process sheets |
| **Queue state** | All / Needs scheduling / Queued | Filter by whether ops are placed on the planner board |
| **Sort** | Planning priority / Due ASC / Due DESC | Change row order |
| **Overdue only** | Checkbox | Show only PS whose due date has passed |
| **Hide [SR]** | Checkbox | Suppress service/repair PS from the list |
| **Show completed** | Checkbox | Include fully shipped PS |
| **Completed only** | Checkbox | Show only completed PS |

### 4.3 Queue State Labels

| Label | Meaning |
|-------|---------|
| **Needs scheduling** | One or more operations have not been placed on any machine |
| **Queued** | All operations are placed on machines in the planner |

Counts for each state are shown next to the filter buttons (e.g., "Needs scheduling 12 / Queued 45").

### 4.4 Bulk PS Lookup

In the **Bulk lookup** field at the top, enter comma-separated PS IDs:

```
APS-0123, APS-0124, APS-0125::2
```

The `::2` suffix selects a specific partial number. The table scrolls to and highlights matching rows.

### 4.5 Buttons

| Button | Action |
|--------|--------|
| **Open Planner** | Navigate to the main scheduling board |
| **+ Create temp PS** | Modal: enter qty → creates a [Temp] PS |
| **Refresh From Cache** | Reload the board from the current data snapshot |

---

## 5. Orders

### 5.1 New Orders

**URL:** `/new-orders`

Shows goods received from COMAIN, grouped by sales order line. Use this to verify what has shipped and when.

**Filters:**

| Filter | Options | Effect |
|--------|---------|--------|
| **Week** | This week / Last week / Custom range | Date window (defaults to Mon–Sat of current working week) |
| **From / To** | Date inputs | Active only when "Custom range" is selected |
| **PS Type** | MPS, APS, NPS, [SR], PPS, CPS | Multi-select; filter by voucher type |
| **Hide History** | Checkbox | Suppress lines with "History" voucher status |
| **Search** | Free text | Match SO number, PS, part number, or customer PO |

**Table columns:**

| Column | Description |
|--------|-------------|
| Sales Order | SO number |
| Line | Line item number |
| PS | Process sheet / voucher number |
| Part | Part code |
| Description | Part description |
| PO Due | Customer PO due date |
| Qty | Ordered quantity |
| Issued | Quantity issued / shipped |
| Invoice | Invoice number |
| Shipment | Shipment datetime |

> Data is cached for 5 minutes. To force a refresh, reload the page.

---

### 5.2 Sales Orders

**URL:** `/sales-orders`

Groups PP vouchers by sales order header. Use this to track the status of all vouchers under a single customer SO.

**Tabs:**

| Tab | Contents |
|-----|----------|
| **Active** | Open SO headers with at least one active voucher |
| **Complete** | Fully shipped SOs |

Each SO row expands to show PP vouchers, and each voucher further expands to show partials with their inventory code, customer PO, and qty.

---

### 5.3 Repeat Orders

**URL:** `/repeat-orders`

Shows recurring POs with their frequency, last ordered date, and calculated next due date. No additional filters; use the search box to find a specific part or PO.

---

## 6. Production Dashboards

### 6.1 Daily Output

**URL:** `/daily-output`

The shift production board. Used by shift supervisors to log actual output for every machine against the planned schedule.

#### Header Controls

| Control | Action |
|---------|--------|
| **Date picker** | Select the work date (defaults to today) |
| **Shift Start / End** | Enter shift times (e.g., 08:30 and 20:00). Effective minutes are auto-calculated. |
| **Refresh plan** | Re-pull the latest schedule for this date (POST to `/api/daily-output/refresh-plan`) |
| **Unlock edit** | Prompt for passcode to enable editing of a past date |

#### Toolbar Toggles

| Toggle | Effect |
|--------|--------|
| **Hide empty rows** | Collapse machine rows with no scheduled ops |
| **Collapse idle machines** | Reduce rows for machines with no activity |
| **Full column labels** | Show full header text instead of abbreviations |
| **Column guide** | Switch between Details and Summary column views |

#### Board Columns

| Column | Full Name | Description |
|--------|-----------|-------------|
| **PS** | Process Sheet | PS / voucher number |
| **Opn** | Operation | Operation code and name |
| **C/T** | Cycle Time | Seconds per piece (from master cycle time) |
| **Tgt** | Target | Planned output qty for this shift (from schedule) |
| **Out** | Output | **Editable.** Actual pieces produced |
| **F/pce** | Finish per piece | Quality: finished pieces per unit (flag field) |
| **In-pro** | In Progress | **Editable.** Pieces started but not yet completed |
| **Qua/his** | Quality / History | **Editable.** Quality issue code or history flag |
| **Rej** | Reject | **Editable.** Rejected pieces this shift |
| **Util %** | Utilisation | Auto-calculated: (Tgt / effective minutes) × C/T |
| **Actual %** | Actual efficiency | Auto-calculated: (Out / Tgt) × 100 |

Grey cells are auto-filled from the schedule. White cells are manually editable. Changes are saved automatically on cell edit.

#### Editing Past Dates

Past dates are locked by default. To edit:

1. Click **Unlock edit**.
2. Enter the planner passcode.
3. Session unlocks for all past dates until you lock again.

#### Snapshots

The system records an 11:00 snapshot of the board state for each work day. The snapshots panel (right side) shows timestamps. Click a snapshot to view the board as it looked at that point in time.

---

### 6.2 Finishing Queue

**URL:** `/finishing-queue`

Tracks parts that have reached the final production stages: Deburring, Final Inspection, and Packing.

**Stage filter buttons (tab row):**

| Button | Effect |
|--------|--------|
| **All** | Show all stages |
| **Deburring** | Show only parts at Deburring |
| **Final Inspection** | Show only parts at Final Inspection |
| **Packing** | Show only parts at Packing stage |

Count badges on each button show how many parts are at that stage.

**Status filter buttons:**

| Button | Effect |
|--------|--------|
| **All** | Show all status values |
| **In process (I)** | Parts currently being processed |
| **Ready (R)** | Parts ready to move to next stage |

**Search:** Match PS number, partial, part code, SO number, or BOM code.

**Table columns:**

| Column | Description |
|--------|-------------|
| PS | Process sheet number |
| Partial | Partial number |
| Stage | Current stage (Deburring / Final Inspection / Packing) |
| Status | I = In process, R = Ready, P = Pending, C = Complete |
| Part | Part code |
| Description | Part description |
| BOM | BOM code |
| Qty | Quantity in this partial |
| Stage progress | % complete through this stage |
| Sales Order | Linked SO number |
| Due | Due date |

---

### 6.4 Queue Delays

**URL:** `/queue-delays`

Risk analysis view showing jobs whose scheduled end date is late relative to either the PS due date or the Coway EDD (external delivery deadline).

**Filters:**

| Filter | Options | Effect |
|--------|---------|--------|
| **Show** | All / At risk only | "At risk only" hides jobs that are on track |
| **Sort by** | Days past due / PS no. / End date / Due date / Coway EDD | Column to sort by |
| **Direction** | ↑ Ascending / ↓ Descending | Toggle sort direction |
| **Search** | Free text | Match PS number, operation, or machine |

**Risk flags:**

| Flag colour | Meaning |
|-------------|---------|
| **Red** | Scheduled end date is past the Coway EDD |
| **Amber** | Scheduled end date is past the PS due date (no Coway EDD set) |

**Table columns:**

| Column | Description |
|--------|-------------|
| PS | Process sheet number |
| Operation | Operation name |
| Machine | Machine code |
| Start | Scheduled start date/time |
| End | Scheduled end date/time |
| Due | PS due date |
| Coway EDD | External delivery deadline (if set) |
| Status | Current execution status |

---

### 6.5 Auk OEE Dashboard

**URL:** `/auk-oee`

Real-time Overall Equipment Effectiveness (OEE) metrics by machine and area. Displays availability, performance, and quality rates alongside a combined OEE percentage. Use this to identify underperforming machines in the current shift.

---

### 6.6 Material Inspection

**URL:** `/material-inspection`

Tracks QC inspection status for incoming materials.

**Tabs:**

| Tab | Contents |
|-----|----------|
| **Outstanding** | Inspections not yet started or in progress |
| **Ready** | Materials that have passed inspection |
| **Historical** | Completed inspection records |

**Filters:** Supplier dropdown, Status dropdown, and free-text search (shipment voucher, PO, part).

**Table columns:**

| Column | Description |
|--------|-------------|
| Inspection voucher | QI voucher number |
| Status | Inspection status |
| Inspector | Assigned inspector |
| PO | Purchase order number |
| Supplier | Supplier name |
| Shipment | Shipment reference |
| Item | Material / part code |
| Received | Received quantity |
| Inspected | Inspected quantity |
| Accepted | Accepted quantity |
| Rejected | Rejected quantity |
| GRN | Goods Receipt Note number |
| Arrival | Date material arrived |
| GR Date | Date goods receipt was posted |

---

## 7. Master Data

### 7.1 Inventory BOM

**URL:** `/planning-data/inventory-bom`

Bill of Materials lookup by part code. Shows each BOM's operations and material requirements. Use this to verify correct BOM before scheduling.

### 7.2 Machines

**URL:** `/planning-data/machines`

Full machine catalog. Each record shows:

| Field | Description |
|-------|-------------|
| Machine code | Unique identifier (e.g., MC-001) |
| Category | Machine group / department |
| Shift profile | Working hours template (NORMAL_DAY, NIGHT, OVERTIME, etc.) |
| Active | Whether the machine appears on the planning board |

### 7.3 Cycle Times

**URL:** `/planning-data/cycle-times`

Master reference for cycle time (seconds per piece) by operation and machine group. The planner uses these values to calculate target quantities and segment durations.

### 7.4 Program / Tool List

**URL:** `/planning-data/program-tool-list`

Maps each part/operation combination to its CNC program code and required tooling. Used by machinists to identify the correct program before running a job.

---

## 8. ERP Sync

The **Sync ERP** button (top-right of the nav bar) pulls the latest data from the COMAIN ERP system into the planning database. This is a multi-step process:

| Step | Data synced |
|------|-------------|
| 1 | PP vouchers |
| 2 | Process sheet info |
| 3 | Work order status |
| 4 | Qty shipped |
| 5 | SO detail |
| 6 | Part descriptions |
| 7 | PP partials |
| 8 | Manufacturing work order status |
| 9 | PP vouchers cache rebuild |

Progress is shown in the button label (e.g., "3/9 Work order status…"). When complete it shows "Synced (N rows) ✓".

> **When to sync:** A full ERP sync runs automatically once per day at **08:00** (Windows Task Scheduler). Use **Sync ERP** manually when you need fresher data during the day. Sync takes approximately 20–40 seconds.

---

## 9. Filter Reference

### 9.1 Schedule / Planner Filters

| Parameter | Values | Effect |
|-----------|--------|--------|
| Machine filter | Dropdown | Limit board to selected machine(s) |
| Date range | Start / End date | Window of visible blocks |
| Include completed | On / Off | Show DONE and archived blocks |
| Lite mode | Internal | Skip heavy ERP enrichment for faster page load |

### 9.2 Process Sheet Filters

| Filter | Values | Effect |
|--------|--------|--------|
| Search | Text | PS number, part, PO, description |
| Type | MPS / APS / NPS / [SR] / PPS / CPS | PS classification |
| Temp | All / [Temp] only / Hide [Temp] | Temporary PS visibility |
| Queue state | All / Needs scheduling / Queued | Scheduling progress |
| Sort | Planning priority / Due ASC / Due DESC | Row order |
| Overdue only | Checkbox | Only past-due PS |
| Hide [SR] | Checkbox | Suppress service/repair vouchers |
| Show completed | Checkbox | Include shipped PS |
| Completed only | Checkbox | Only shipped PS |

### 9.3 Orders Filters

| Filter | Values | Effect |
|--------|--------|--------|
| Week selector | This week / Last week / Custom | Date range preset |
| From / To | Date | Custom date range |
| PS Type | MPS / APS / NPS / [SR] / PPS / CPS | Multi-select type filter |
| Hide History | Checkbox | Exclude History-status lines |
| Search | Text | SO, PS, part, customer PO |

### 9.4 Finishing Queue Filters

| Filter | Values | Effect |
|--------|--------|--------|
| Stage | All / Deburring / Final Inspection / Packing | Current production stage |
| Status | All / In process / Ready | Part readiness |
| Search | Text | PS, partial, part, SO, BOM |

### 9.5 Queue Delays Filters

| Filter | Values | Effect |
|--------|--------|--------|
| Show | All / At risk only | Risk filter |
| Sort by | Days past due / PS / End / Due / Coway EDD | Sort column |
| Direction | Ascending / Descending | Sort direction |
| Search | Text | PS, operation, machine |

### 9.6 Material Requirements Filters

| Filter | Values | Effect |
|--------|--------|--------|
| Include unplanned | On / Off | PS with no material requirements |
| Include active | On / Off | Currently scheduled PS |
| Include completed | On / Off | Already shipped PS |
| Search | Text | Requirement details |

---

## 10. Button Reference

### 10.1 Global Navigation

| Button | Location | Action |
|--------|----------|--------|
| **Lock** | Top right | Clear session, return to passcode gate |
| **Sync ERP** | Top right | Run full COMAIN → planner sync (9 steps) |
| **Hamburger** | Mobile only | Open/close nav drawer |

### 10.2 Planner Board

| Button | Action |
|--------|--------|
| **Temp PS** | Open modal to create a [Temp] reject/rework process sheet |
| **Completed** | Toggle showing completed PS in the sidebar catalog |
| **Unqueued only** | Filter sidebar to only unscheduled PS |
| **Sort by due** | Sort catalog ops by due date (ascending) |
| **Refresh** | Reload full schedule from server |
| **Recalculate schedules** | Force recalculation of all dirty machine lanes |

### 10.3 Block Detail Modal

| Button | Action |
|--------|--------|
| **Save** | Persist setup/cycle edits |
| **Add actual** | Submit a daily production actual entry |
| **Create rework** | Open rework sub-modal |
| **Open material status** | Open material supply status modal |
| **Save (material)** | Persist material status changes |

### 10.4 Process Sheets

| Button | Action |
|--------|--------|
| **Open Planner** | Navigate to `/planner` |
| **+ Create temp PS** | Modal to create a [Temp] PS |
| **Refresh From Cache** | Reload board data |

### 10.5 Daily Output

| Button | Action |
|--------|--------|
| **Refresh plan** | Recalculate daily board from current schedule |
| **Unlock edit** | Prompt for passcode to enable past-date editing |
| **Save** (auto) | Cells save on edit automatically |

### 10.6 Finishing Queue

| Button | Action |
|--------|--------|
| **All / Deburring / Final Inspection / Packing** | Stage filter tabs |
| **All / In process / Ready** | Status filter tabs |

### 10.7 Queue Delays

| Button | Action |
|--------|--------|
| **All / At risk only** | Risk filter toggle |
| **↑ / ↓** | Sort direction toggle |

### 10.8 Machinist Board (Shop Floor)

| Button | Action |
|--------|--------|
| **EN / 中文** | Toggle display language |
| **Focus view** | Select up to 4 machines to show in expanded detail |
| **Stock colours** | Toggle card colours: green = in stock, red = awaiting stock |

---

## 11. Colour & Status Codes

### 11.1 Block Status Colours (Planner)

| Colour | Status | Meaning |
|--------|--------|---------|
| Blue | Scheduled | Block is queued but not yet started |
| Green | In process | Machine is currently running this job |
| Grey | Done | Operation completed |
| Red outline | Overdue | Scheduled end is past the PS due date |
| Amber outline | Due soon | Due date is within 7 days |

### 11.2 Material Status on Block Cards

| Indicator | Meaning |
|-----------|---------|
| Green dot | Material in stock / received |
| Red dot | Material awaiting delivery |

### 11.3 Queue State Badges (Process Sheets)

| Badge | Meaning |
|-------|---------|
| Green | Operation is queued on the planner |
| Amber | Operation needs to be scheduled |
| Red | PS is overdue |

### 11.4 Finishing Queue Status Codes

| Code | Full Name | Meaning |
|------|-----------|---------|
| I | In Process | Currently being worked on |
| R | Ready | Complete at this stage; ready to advance |
| P | Pending | Awaiting start |
| C | Complete | All stages done |

### 11.5 PS Type Codes

| Code | Meaning |
|------|---------|
| MPS | Main Production Schedule |
| APS | Additional Production Schedule |
| NPS | New Production Schedule |
| [SR] | Service / Repair |
| PPS | Prototype / Pre-production Schedule |
| CPS | Customer / Contract Production Schedule |
| [Temp] | Temporary (reject / rework copy) |

### 11.6 Queue Delay Risk Colours

| Row colour | Meaning |
|------------|---------|
| Red | Scheduled end is past the Coway EDD (external customer deadline) |
| Amber | Scheduled end is past the PS due date (no Coway EDD set) |
| None | Job is on track |

---

## 12. Access & Security

### 12.1 Session Types

| Session | How to get it | What it allows |
|---------|---------------|----------------|
| **Planner session** | Enter planner passcode at `/` | Full read/write access to all planner features |
| **Daily output edit** | Enter planner passcode via "Unlock edit" | Edit past dates on the daily output board |
| **Machinist board** | No login required | Read-only view of `/machine-queue` |

### 12.2 Locking & Handover

- Always click **Lock** before leaving the planning workstation unattended.
- Locking clears both the planner session and the daily output edit session.
- The machinist board (`/machine-queue`) is always public and cannot be locked.

### 12.3 Data Cache

| Data | Cache duration |
|------|----------------|
| New Orders (ERP) | 5 minutes |
| Sales Orders (ERP) | 5 minutes |
| PP Vouchers (via Sync ERP) | Until next manual sync |
| Schedule board | Reloaded on each page visit or manual Refresh |

---

*End of User Guide*
