"""Process sheet PDF from a traced job, with lot trace columns.

The sheet lists the material the store issued for the job. It adds the lot
fields the shop-floor form does not carry: lot level, lot reference, heat
number, source PO, source voucher, and the lot description.
"""
from __future__ import annotations

import io
import re
from datetime import datetime
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas

from .process_sheet_trace_service import resolve_process_sheet
from .staged_erp import live_query
from .utils import PLANNER_TZ, compact_text, parse_number

_QUERY_TIMEOUT_MS = 30000
_FORM_ID = "Coway/F009 Rev: 04"
_APPROVAL = (
    "This routing has been approved by Engineering. "
    "Therefore, no signature is required on routing."
)
_HEAT_RE = re.compile(
    r"HEAT\s*[:#-]?\s*([A-Z0-9][A-Z0-9./-]*\d[A-Z0-9./-]*)",
    re.IGNORECASE,
)
_PO_RE = re.compile(r"^P\d", re.IGNORECASE)
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

_PAGE_W, _PAGE_H = A4
_MARGIN = 28
_FOOTER_TOP = 46
_CONTENT_BOTTOM = _MARGIN + _FOOTER_TOP
_CONTENT_W = _PAGE_W - (2 * _MARGIN)

_LINE = colors.HexColor("#222222")
_HEAD = colors.HexColor("#ececec")
_MUTED = colors.HexColor("#444444")


def heat_no_from_text(*parts: Any) -> str:
    """First mill heat written as ``HEAT 245346`` on a receipt or lot remark."""
    for part in parts:
        match = _HEAT_RE.search(compact_text(part))
        if match:
            return match.group(1).upper()
    return ""


def source_po_no(shipment_source: Any, lot_source: Any) -> str:
    """Purchase order behind the lot. Transfers and shipments are not POs."""
    for candidate in (shipment_source, lot_source):
        text = compact_text(candidate)
        if _PO_RE.match(text):
            return text
    return ""


def select_partial(rows: list[dict[str, Any]]) -> tuple[int, list[dict[str, Any]]]:
    """Keep the partial that holds the routing. Ties go to the lower partial number."""
    counts: dict[int, int] = {}
    for row in rows:
        partial = int(parse_number(row.get("pp_partial_no"), 1) or 1)
        counts[partial] = counts.get(partial, 0) + 1
    if not counts:
        return 1, []
    chosen = sorted(counts, key=lambda number: (-counts[number], number))[0]
    kept = [
        row
        for row in rows
        if int(parse_number(row.get("pp_partial_no"), 1) or 1) == chosen
    ]
    kept.sort(key=lambda row: (parse_number(row.get("stage_no"), 0), compact_text(row.get("stage_desc"))))
    return chosen, kept


def format_qty(value: Any) -> str:
    return f"{parse_number(value, 0):.1f}"


def _format_time(value: Any, uom: Any) -> str:
    unit = compact_text(uom).upper()[:1]
    text = f"{parse_number(value, 0):.2f}"
    return f"{text} {unit}".strip()


def _stamp(moment: datetime) -> str:
    hour = moment.hour
    suffix = "AM" if hour < 12 else "PM"
    hour12 = hour % 12 or 12
    month = _MONTHS[moment.month - 1]
    return f"{moment.day:02d} {month} {moment.year} {hour12:02d}:{moment.minute:02d}:{moment.second:02d} {suffix}"


def _parse_dt(value: Any) -> datetime | None:
    text = compact_text(value).replace("T", " ")
    if not text:
        return None
    for fmt, size in (("%Y-%m-%d %H:%M:%S", 19), ("%Y-%m-%d", 10)):
        try:
            return datetime.strptime(text[:size], fmt)
        except ValueError:
            continue
    return None


def _display_dt(value: Any) -> str:
    moment = value if isinstance(value, datetime) else _parse_dt(value)
    if moment is None:
        return ""
    month = _MONTHS[moment.month - 1]
    return f"{moment.day:02d} {month} {moment.year} {moment.hour:02d}:{moment.minute:02d}"


def _elapsed_hours(start: Any, end: Any) -> float:
    start_dt = start if isinstance(start, datetime) else _parse_dt(start)
    end_dt = end if isinstance(end, datetime) else _parse_dt(end)
    if start_dt is None or end_dt is None:
        return 0.0
    seconds = (end_dt - start_dt).total_seconds()
    if seconds <= 0:
        return 0.0
    return round(seconds / 3600.0, 2)


def shape_issue(row: dict[str, Any]) -> dict[str, str]:
    """One issued lot line for the process sheet."""
    lot_source = compact_text(row.get("source_voucher_no"))
    description = (
        compact_text(row.get("lot_desc"))
        or compact_text(row.get("issue_desc"))
        or compact_text(row.get("inventory_desc"))
    )
    level = int(parse_number(row.get("lot_no"), 0))
    issued_by = compact_text(row.get("issued_by_name")) or compact_text(row.get("store_man"))
    return {
        "inventory_code": compact_text(row.get("inventory_code")),
        "qty": format_qty(row.get("qty")),
        "uom": compact_text(row.get("uom_code")),
        "lot_level": str(level) if level else "",
        "lot_reference_no": compact_text(row.get("reference_no")),
        "heat_no": heat_no_from_text(
            row.get("shipment_desc"),
            row.get("special_remarks"),
            row.get("delivery_remarks"),
            row.get("issue_desc"),
            row.get("lot_desc"),
        ),
        "source_po_no": source_po_no(row.get("source_po_no"), lot_source),
        "source_voucher_no": lot_source,
        "lot_description": description,
        "issued_by": issued_by,
    }


def shape_stage(row: dict[str, Any]) -> dict[str, str]:
    description = compact_text(row.get("stage_desc"))
    sign = "Inspector" if "inspect" in description.lower() else "Done By"
    return {
        "wo_no": compact_text(row.get("wo_no")),
        "stage_desc": description,
        "work_center": compact_text(row.get("work_center_code")),
        "machine_no": compact_text(row.get("machine_no")),
        "total_time": f"{_elapsed_hours(row.get('actual_start_date'), row.get('actual_end_date')):.2f} H",
        "setup_time": _format_time(row.get("stage_setup_time"), row.get("uom_setup_time")),
        "cycle_time": _format_time(row.get("unit_cycle_time"), row.get("uom_unit_time")),
        "required_qty": f"{parse_number(row.get('wo_qty_required'), 0):.2f}",
        "accepted_qty": f"{parse_number(row.get('total_acc_qty_produced'), 0):.2f}",
        "rejected_qty": f"{parse_number(row.get('total_rej_qty_produced'), 0):.2f}",
        "start": _display_dt(row.get("actual_start_date")),
        "end": _display_dt(row.get("actual_end_date")),
        "sign_label": sign,
    }


def document_filename(document: dict[str, Any]) -> str:
    raw = compact_text(document.get("pp_no")) or "process-sheet"
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-") or "process-sheet"
    return f"ProcessSheet-{safe}.pdf"


def _query(sql: str, params: tuple) -> list[dict[str, Any]]:
    return live_query(sql, params, timeout_ms=_QUERY_TIMEOUT_MS)


_HEADER_SQL = """
SELECT pp_voucher_no, inventory_code, bom_code, bom_desc, pp_qty,
       remarks, process_description
FROM public.mfg_pp_vch
WHERE UPPER(BTRIM(pp_voucher_no)) = %s
"""

_FOCUS_SQL = """
SELECT inventory_code, process_sheet_no, inventory_main_desc
FROM public.mfg_process_sheet_info_v1_view
WHERE UPPER(BTRIM(pp_voucher_no)) = %s
  AND UPPER(BTRIM(process_sheet_no)) = %s
LIMIT 1
"""

_DESC_SQL = """
SELECT main_desc, uom_code
FROM public.mt_inventory
WHERE inventory_code = %s
LIMIT 1
"""

_BOM_SQL = """
SELECT s.bom_code,
       COUNT(DISTINCT s.stage_no) AS stage_count,
       COUNT(DISTINCT w.voucher_no) AS wo_count
FROM public.mfg_pp_partial_bom_stage s
LEFT JOIN public.mfg_mps_vch mps
  ON UPPER(BTRIM(mps.source_pp_no)) = UPPER(BTRIM(s.pp_voucher_no))
LEFT JOIN public.mfg_wo_vch w
  ON w.voucher_no = mps.wo_voucher_no
 AND w.stage_no = s.stage_no
 AND UPPER(BTRIM(COALESCE(w.stage_desc, ''))) = UPPER(BTRIM(COALESCE(s.stage_desc, '')))
 AND UPPER(BTRIM(COALESCE(w.own_inventory_code, ''))) = UPPER(BTRIM(s.inventory_code))
WHERE UPPER(BTRIM(s.pp_voucher_no)) = %s
  AND UPPER(BTRIM(s.inventory_code)) = %s
GROUP BY s.bom_code
ORDER BY wo_count DESC, stage_count DESC, s.bom_code
LIMIT 1
"""

_STAGE_SQL = """
SELECT
    s.pp_partial_no,
    s.stage_no,
    s.stage_desc,
    s.work_center_code,
    s.stage_setup_time,
    s.uom_setup_time,
    s.unit_cycle_time,
    s.uom_unit_time,
    mac.machine_no,
    w.voucher_no AS wo_no,
    w.wo_qty_required,
    w.total_acc_qty_produced,
    w.total_rej_qty_produced,
    w.actual_start_date,
    w.actual_end_date
FROM public.mfg_pp_partial_bom_stage s
LEFT JOIN LATERAL (
    SELECT string_agg(DISTINCT BTRIM(m.machine_no), ', ' ORDER BY BTRIM(m.machine_no)) AS machine_no
    FROM public.mfg_pp_partial_bom_stage_machine m
    WHERE m.pp_voucher_no = s.pp_voucher_no
      AND m.pp_partial_no = s.pp_partial_no
      AND m.inventory_code = s.inventory_code
      AND m.bom_code = s.bom_code
      AND m.stage_no = s.stage_no
      AND BTRIM(COALESCE(m.machine_no, '')) <> ''
) mac ON TRUE
LEFT JOIN LATERAL (
    SELECT w.voucher_no, w.wo_qty_required, w.total_acc_qty_produced, w.total_rej_qty_produced,
           w.actual_start_date, w.actual_end_date
    FROM public.mfg_mps_vch mps
    JOIN public.mfg_wo_vch w ON w.voucher_no = mps.wo_voucher_no
    WHERE UPPER(BTRIM(mps.source_pp_no)) = UPPER(BTRIM(s.pp_voucher_no))
      AND w.stage_no = s.stage_no
      AND UPPER(BTRIM(COALESCE(w.stage_desc, ''))) = UPPER(BTRIM(COALESCE(s.stage_desc, '')))
      AND UPPER(BTRIM(COALESCE(w.own_inventory_code, ''))) = UPPER(BTRIM(s.inventory_code))
    ORDER BY w.wo_qty_required DESC NULLS LAST, w.voucher_no
    LIMIT 1
) w ON TRUE
WHERE UPPER(BTRIM(s.pp_voucher_no)) = %s
  AND UPPER(BTRIM(s.inventory_code)) = %s
  AND UPPER(BTRIM(s.bom_code)) = %s
ORDER BY s.pp_partial_no, s.stage_no, s.stage_desc
"""

_ISSUE_SQL = """
SELECT DISTINCT ON (si.si_voucher_no, mat.line_item_no, lot.lot_line_item_no)
    mat.inventory_code,
    inv.main_desc AS inventory_desc,
    inv.uom_code,
    lot.lot_no,
    lot.reference_no,
    lot.qty,
    lot.line_item_description AS issue_desc,
    si.si_voucher_no,
    si.issued_date,
    mat.line_item_no,
    lot.lot_line_item_no,
    emp.employee_name AS issued_by_name,
    si.store_man,
    ost.line_item_description AS lot_desc,
    ost.source_voucher_no,
    ost.special_remarks,
    ost.delivery_remarks,
    COALESCE(shm_h.source_voucher_no, shm_o.source_voucher_no) AS source_po_no,
    COALESCE(shm_det_h.line_item_description, shm_det_o.line_item_description) AS shipment_desc
FROM public.mfg_mps_vch mps
JOIN public.mfg_wo_vch w
  ON w.voucher_no = mps.wo_voucher_no
JOIN public.ic_stk_issue_vch si
  ON si.source_voucher_no = w.voucher_no
JOIN public.ic_stk_issue_mat mat
  ON mat.si_voucher_no = si.si_voucher_no
JOIN public.ic_stk_issue_mat_lot lot
  ON lot.si_voucher_no = mat.si_voucher_no
 AND lot.line_item_no = mat.line_item_no
LEFT JOIN public.mt_inventory inv
  ON inv.inventory_code = mat.inventory_code
LEFT JOIN public.mt_employee emp
  ON BTRIM(emp.employee_code) = BTRIM(si.store_man)
LEFT JOIN LATERAL (
    SELECT o.line_item_description, o.source_voucher_no, o.special_remarks, o.delivery_remarks
    FROM public.ic_inventory_ost_lot o
    WHERE o.inventory_code = mat.inventory_code
      AND o.lot_no = lot.lot_no
    ORDER BY
        CASE
            WHEN BTRIM(COALESCE(o.reference_no, '')) = BTRIM(COALESCE(lot.reference_no, '')) THEN 0
            ELSE 1
        END,
        o.remaining_qty DESC NULLS LAST
    LIMIT 1
) ost ON TRUE
LEFT JOIN public.lg_in_shm_hst_hdr shm_h
  ON shm_h.shipment_voucher_no = ost.source_voucher_no
LEFT JOIN public.lg_in_shm_ost_hdr shm_o
  ON shm_o.shipment_voucher_no = ost.source_voucher_no
LEFT JOIN LATERAL (
    SELECT d.line_item_description
    FROM public.lg_in_shm_hst_det d
    WHERE d.shipment_voucher_no = ost.source_voucher_no
      AND d.inventory_code = mat.inventory_code
    ORDER BY CASE WHEN d.line_item_description ILIKE '%%HEAT%%' THEN 0 ELSE 1 END
    LIMIT 1
) shm_det_h ON TRUE
LEFT JOIN LATERAL (
    SELECT d.line_item_description
    FROM public.lg_in_shm_ost_det d
    WHERE d.shipment_voucher_no = ost.source_voucher_no
      AND d.inventory_code = mat.inventory_code
    ORDER BY CASE WHEN d.line_item_description ILIKE '%%HEAT%%' THEN 0 ELSE 1 END
    LIMIT 1
) shm_det_o ON TRUE
WHERE UPPER(BTRIM(mps.source_pp_no)) = %s
  AND si.issue_type = 'M'
  AND COALESCE(si.status, '') = 'H'
  AND COALESCE(lot.qty, 0) > 0
  AND (
        %s = ''
        OR UPPER(BTRIM(COALESCE(
            NULLIF(BTRIM(mps.own_inventory_code), ''),
            NULLIF(BTRIM(w.own_inventory_code), '')
        ))) = %s
      )
ORDER BY si.si_voucher_no, mat.line_item_no, lot.lot_line_item_no
"""

_WO_MAT_SQL = """
SELECT
    w.voucher_no AS wo_no,
    w.stage_no,
    mat.mat_seq_no,
    mat.inventory_code,
    inv.main_desc,
    mat.qty_required,
    inv.uom_code
FROM public.mfg_mps_vch mps
JOIN public.mfg_wo_vch w
  ON w.voucher_no = mps.wo_voucher_no
JOIN public.mfg_wo_mat mat
  ON mat.voucher_no = w.voucher_no
LEFT JOIN public.mt_inventory inv
  ON inv.inventory_code = mat.inventory_code
WHERE UPPER(BTRIM(mps.source_pp_no)) = %s
  AND UPPER(BTRIM(COALESCE(w.own_inventory_code, ''))) = %s
ORDER BY w.stage_no, w.voucher_no, mat.mat_seq_no
"""


def load_process_sheet_document(process_sheet_no: str) -> dict[str, Any] | None:
    """Build the print payload for a process sheet or one of its line items."""
    pp_no, focus = resolve_process_sheet(process_sheet_no)
    if not pp_no:
        return None
    headers = _query(_HEADER_SQL, (pp_no.upper(),))
    if not headers:
        return None
    header = headers[0]
    fg = compact_text(header.get("inventory_code"))
    part = fg
    part_desc = ""
    printed_pp = compact_text(header.get("pp_voucher_no")) or pp_no
    if focus:
        focused = _query(_FOCUS_SQL, (pp_no.upper(), focus.upper()))
        if focused:
            part = compact_text(focused[0].get("inventory_code")) or fg
            part_desc = compact_text(focused[0].get("inventory_main_desc"))
            printed_pp = compact_text(focused[0].get("process_sheet_no")) or focus

    names = _query(_DESC_SQL, (part,))
    if names:
        part_desc = part_desc or compact_text(names[0].get("main_desc"))
    header_bom = compact_text(header.get("bom_code"))
    bom_rows = _query(_BOM_SQL, (pp_no.upper(), part.upper()))
    routing_bom = compact_text(bom_rows[0].get("bom_code")) if bom_rows else header_bom
    stage_rows = []
    if routing_bom:
        stage_rows = _query(_STAGE_SQL, (pp_no.upper(), part.upper(), routing_bom.upper()))
    partial_no, stages = select_partial(stage_rows)

    # A parent print lists every lot issued on the sheet. A line-item print
    # lists the lots issued to that sub-part's jobs.
    part_filter = "" if not focus or part.upper() == fg.upper() else part.upper()
    issue_rows = _query(_ISSUE_SQL, (pp_no.upper(), part_filter, part_filter))
    issue_rows.sort(
        key=lambda row: (
            compact_text(row.get("issued_date")),
            compact_text(row.get("si_voucher_no")),
            parse_number(row.get("line_item_no"), 0),
            parse_number(row.get("lot_line_item_no"), 0),
        )
    )
    wo_rows = _query(_WO_MAT_SQL, (pp_no.upper(), part.upper()))
    remarks = compact_text(header.get("remarks")) or compact_text(header.get("process_description"))
    bom_display = header_bom if not focus else (routing_bom or header_bom)
    return {
        "pp_no": printed_pp,
        "partial_no": partial_no,
        "bom_code": bom_display,
        "finished_goods": part,
        "description": part_desc,
        "remarks": remarks,
        "printed_at": datetime.now(PLANNER_TZ),
        "issues": [shape_issue(row) for row in issue_rows],
        "wo_materials": [
            {
                "wo_no": compact_text(row.get("wo_no")),
                "item_code": compact_text(row.get("inventory_code")),
                "material": compact_text(row.get("main_desc")),
                "qty": format_qty(row.get("qty_required")),
                "uom": compact_text(row.get("uom_code")),
            }
            for row in wo_rows
        ],
        "stages": [shape_stage(row) for row in stages],
    }


_ISSUE_COLUMNS = (
    ("inventory_code", "Inventory", 108),
    ("qty", "Qty", 32),
    ("uom", "UOM", 28),
    ("lot_reference_no", "Lot reference", 68),
    ("lot_level", "Lot level", 42),
    ("heat_no", "Heat no.", 48),
    ("source_po_no", "Source PO", 52),
    ("source_voucher_no", "Source voucher", 70),
    ("issued_by", "Issued by", _CONTENT_W - (108 + 32 + 28 + 68 + 42 + 48 + 52 + 70)),
)


def _text_width(text: str, font: str, size: float) -> float:
    return pdfmetrics.stringWidth(text, font, size)


def _wrap(text: str, font: str, size: float, width: float) -> list[str]:
    words = compact_text(text).split()
    if not words:
        return []
    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        trial = f"{current} {word}"
        if _text_width(trial, font, size) <= width:
            current = trial
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def _fit(text: str, font: str, size: float, width: float) -> str:
    value = compact_text(text)
    if _text_width(value, font, size) <= width:
        return value
    ellipsis = "…"
    trimmed = value
    while trimmed and _text_width(trimmed + ellipsis, font, size) > width:
        trimmed = trimmed[:-1]
    return (trimmed + ellipsis) if trimmed else ""


def _rule(c: canvas.Canvas, x: float, y: float, w: float, h: float) -> None:
    c.setStrokeColor(_LINE)
    c.setLineWidth(0.4)
    c.rect(x, y, w, h, stroke=1, fill=0)


class _Sheet:
    def __init__(self, c: canvas.Canvas, document: dict[str, Any], page_total: int):
        self.c = c
        self.document = document
        self.page_total = page_total
        self.page = 1
        self.y = _PAGE_H

    def new_page(self) -> None:
        self._footer()
        self.c.showPage()
        self.page += 1
        self.y = self._header()

    def ensure(self, height: float) -> bool:
        if self.y - height < _CONTENT_BOTTOM:
            self.new_page()
            return True
        return False

    def _header(self) -> float:
        c = self.c
        top = _PAGE_H - 28
        c.setFillColor(colors.black)
        c.setFont("Helvetica-Bold", 16)
        c.drawString(_MARGIN, top - 4, "Process Sheet")

        right = _PAGE_W - _MARGIN
        label_x = right - 210
        value_x = right - 118
        rows = (
            ("PP No.", compact_text(self.document.get("pp_no"))),
            ("Partial No.", str(self.document.get("partial_no") or "")),
            ("Finished Goods", compact_text(self.document.get("finished_goods"))),
        )
        y = top - 2
        for label, value in rows:
            c.setFont("Helvetica", 8)
            c.drawRightString(label_x + 78, y, label)
            c.drawString(label_x + 84, y, ":")
            c.setFont("Helvetica-Bold", 8)
            c.drawString(value_x, y, _fit(value, "Helvetica-Bold", 8, right - value_x))
            y -= 12

        c.setFillColor(colors.black)
        c.setFont("Helvetica", 8)
        c.drawString(_MARGIN, top - 28, f"BOM: {compact_text(self.document.get('bom_code'))}")

        info_top = top - 46
        c.setFont("Helvetica", 8)
        c.drawString(_MARGIN, info_top, "Inventory Code")
        c.drawString(_MARGIN + 72, info_top, ":")
        c.setFont("Helvetica-Bold", 8)
        c.drawString(
            _MARGIN + 80,
            info_top,
            _fit(compact_text(self.document.get("finished_goods")), "Helvetica-Bold", 8, 180),
        )
        c.setFont("Helvetica", 8)
        c.drawString(_MARGIN, info_top - 12, "Assy Dwg")
        c.drawString(_MARGIN + 72, info_top - 12, ":")

        box_x = _MARGIN + 250
        box_w = _CONTENT_W - 250
        box_h = 28
        box_y = info_top - 18
        _rule(c, box_x, box_y, box_w, box_h)
        c.setFont("Helvetica", 7)
        c.drawString(box_x + 4, box_y + box_h - 9, "Description:")
        desc_lines = _wrap(compact_text(self.document.get("description")), "Helvetica", 7.5, box_w - 8)[:2]
        c.setFont("Helvetica", 7.5)
        line_y = box_y + box_h - 20
        for line in desc_lines:
            c.drawString(box_x + 4, line_y, line)
            line_y -= 9
        return box_y - 12

    def _footer(self) -> None:
        c = self.c
        y = _MARGIN + 8
        box_h = 28
        _rule(c, _MARGIN, y, _CONTENT_W, box_h)
        c.line(_MARGIN + _CONTENT_W * 0.62, y, _MARGIN + _CONTENT_W * 0.62, y + box_h)
        c.setFillColor(colors.black)
        c.setFont("Helvetica", 8)
        text_x = _MARGIN + _CONTENT_W * 0.62 + 8
        c.drawString(text_x, y + 16, "Printed By:")
        printed = self.document.get("printed_at")
        printed_text = _stamp(printed) if isinstance(printed, datetime) else ""
        c.drawString(text_x, y + 5, f"Printed Date:  {printed_text}")
        total = self.page_total or self.page
        c.setFont("Helvetica", 8)
        c.drawRightString(_PAGE_W - _MARGIN, y + box_h + 4, f"Page {self.page} of {total}")
        c.setFont("Helvetica-Oblique", 8)
        c.drawRightString(_PAGE_W - _MARGIN, _MARGIN - 2, _FORM_ID)

    def paint(self) -> int:
        self.y = self._header()
        self._issue_table()
        self._wo_table()
        self._note()
        self._footer()
        self.c.showPage()
        return self.page

    def _issue_table(self) -> None:
        rows = list(self.document.get("issues") or [])
        self._table(
            _ISSUE_COLUMNS,
            rows,
            lambda row: self._issue_lines(row),
        )

    def _issue_lines(self, row: dict[str, str]) -> list[tuple[str, bool]]:
        code = compact_text(row.get("inventory_code"))
        desc = compact_text(row.get("lot_description"))
        lines = [(code, True)]
        if desc and desc.upper() != code.upper():
            wrapped = _wrap(desc, "Helvetica", 6, _ISSUE_COLUMNS[0][2] - 6)
            if len(wrapped) > 2:
                wrapped = wrapped[:2]
                wrapped[1] = _fit(wrapped[1] + " …", "Helvetica", 6, _ISSUE_COLUMNS[0][2] - 6)
            lines.extend((line, False) for line in wrapped)
        return lines

    def _table(self, columns, rows: list[dict[str, str]], line_fn) -> None:
        if not rows:
            self.ensure(28)
            self._column_header(columns)
            self.c.setFillColor(_MUTED)
            self.c.setFont("Helvetica-Oblique", 8)
            self.c.drawString(_MARGIN + 4, self.y - 14, "No material has been issued.")
            _rule(self.c, _MARGIN, self.y - 20, _CONTENT_W, 20)
            self.y -= 28
            return
        self.ensure(36)
        self._column_header(columns)
        for row in rows:
            lines = line_fn(row) or [("", True)]
            height = max(16, 6 + (len(lines) * 8))
            if self.ensure(height):
                self._column_header(columns)
            self._table_row(columns, row, lines, height)

    def _column_header(self, columns) -> None:
        self.ensure(18)
        top = self.y
        height = 16
        self.c.setFillColor(_HEAD)
        self.c.rect(_MARGIN, top - height, _CONTENT_W, height, stroke=0, fill=1)
        _rule(self.c, _MARGIN, top - height, _CONTENT_W, height)
        x = _MARGIN
        self.c.setFillColor(colors.black)
        self.c.setFont("Helvetica-Bold", 6.5)
        for _key, label, width in columns:
            self.c.drawString(x + 3, top - 11, _fit(label, "Helvetica-Bold", 6.5, width - 5))
            x += width
            if x < _MARGIN + _CONTENT_W - 1:
                self.c.line(x, top - height, x, top)
        self.y = top - height

    def _table_row(self, columns, row: dict[str, str], lines: list[tuple[str, bool]], height: float) -> None:
        top = self.y
        _rule(self.c, _MARGIN, top - height, _CONTENT_W, height)
        x = _MARGIN
        numeric = {"qty"}
        for index, (key, _label, width) in enumerate(columns):
            if index == 0:
                text_y = top - 9
                for line, bold in lines:
                    self.c.setFillColor(colors.black if bold else _MUTED)
                    self.c.setFont("Helvetica-Bold" if bold else "Helvetica", 6.5 if bold else 6)
                    self.c.drawString(x + 3, text_y, _fit(line, "Helvetica-Bold" if bold else "Helvetica", 6.5 if bold else 6, width - 6))
                    text_y -= 8
            else:
                value = compact_text(row.get(key))
                self.c.setFillColor(colors.black)
                self.c.setFont("Helvetica", 6.5)
                if key in numeric:
                    self.c.drawRightString(x + width - 3, top - 11, value)
                else:
                    self.c.drawString(x + 3, top - 11, _fit(value, "Helvetica", 6.5, width - 6))
            x += width
            if x < _MARGIN + _CONTENT_W - 1:
                self.c.setStrokeColor(_LINE)
                self.c.line(x, top - height, x, top)
        self.y = top - height

    def _wo_table(self) -> None:
        rows = list(self.document.get("wo_materials") or [])
        if not rows:
            return
        columns = (
            ("wo_no", "WO No.", 90),
            ("item_code", "Item Code", 145),
            ("material", "Material", 175),
            ("qty", "Require Qty", 70),
            ("uom", "UOM", _CONTENT_W - (90 + 145 + 175 + 70)),
        )
        self.y -= 8
        self._table(columns, rows, lambda row: [(compact_text(row.get("wo_no")), True)])

    def _note(self) -> None:
        self.y -= 8
        self.ensure(16)
        self.c.setFillColor(colors.black)
        self.c.setFont("Helvetica-Oblique", 7.5)
        self.c.drawString(_MARGIN, self.y - 10, _APPROVAL)
        self.y -= 16

def _draw(document: dict[str, Any], page_total: int) -> tuple[bytes, int]:
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4, pageCompression=0)
    pdf.setTitle(f"Process Sheet {compact_text(document.get('pp_no'))}")
    sheet = _Sheet(pdf, document, page_total)
    pages = sheet.paint()
    pdf.save()
    return buffer.getvalue(), pages


def render_process_sheet_pdf(document: dict[str, Any]) -> bytes:
    _unused, total = _draw(document, 0)
    pdf, _pages = _draw(document, total)
    return pdf
