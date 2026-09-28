"""Landscape PDF for the on-time delivery report."""
from __future__ import annotations

import io
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .on_time_delivery import MONTH_LABELS, benchmark_label
from .utils import compact_text

_HEADER_BG = colors.HexColor("#0f172a")
_HEADER_FG = colors.white
_ZEBRA = colors.HexColor("#f8fafc")
_GRID = colors.HexColor("#cbd5e1")
_LATE = colors.HexColor("#c2410c")
_EARLY = colors.HexColor("#0369a1")
_MUTED = colors.HexColor("#475569")


def _esc(value: Any, fallback: str = "-") -> str:
    text = compact_text(value) or fallback
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _pct(value: Any) -> str:
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return "-"
    return f"{rate * 100:.1f}%"


def _days_text(value: Any) -> str:
    if not isinstance(value, int):
        return "-"
    if value > 0:
        return f"+{value}"
    return str(value)


def _status_text(status: Any, *, proposed_benchmark: bool) -> str:
    key = compact_text(status)
    if key == "unclassified":
        return "No EDD" if proposed_benchmark else "No dates"
    return {
        "early": "Early",
        "on_time": "On time",
        "late": "Late",
    }.get(key, key or "-")


def _summary_line(label: str, summary: dict[str, Any]) -> str:
    classified = int(summary.get("classified") or 0)
    on_time = int(summary.get("early") or 0) + int(summary.get("on_time") or 0)
    late = int(summary.get("late") or 0)
    return (
        f"<b>{_esc(label)}</b> {_pct(summary.get('on_time_rate'))} on time "
        f"({on_time} / {classified}), {late} late"
    )


def _table(data: list[list[Any]], col_widths: list[float], font_size: float = 7) -> Table:
    table = Table(data, colWidths=col_widths, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), _HEADER_BG),
                ("TEXTCOLOR", (0, 0), (-1, 0), _HEADER_FG),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), font_size),
                ("TEXTCOLOR", (0, 1), (-1, -1), colors.HexColor("#0f172a")),
                ("BACKGROUND", (0, 1), (-1, -1), colors.white),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _ZEBRA]),
                ("GRID", (0, 0), (-1, -1), 0.25, _GRID),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 3),
                ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    return table


def build_on_time_delivery_pdf(payload: dict[str, Any]) -> bytes:
    """Render the current on-time delivery view. ``payload`` is already filtered."""
    buf = io.BytesIO()
    year = payload.get("year") or ""
    active = benchmark_label(payload.get("benchmark"))
    doc = SimpleDocTemplate(
        buf,
        pagesize=landscape(A4),
        leftMargin=10 * mm,
        rightMargin=10 * mm,
        topMargin=10 * mm,
        bottomMargin=10 * mm,
        title=f"On-time delivery {year} vs {active}",
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "OtdTitle",
        parent=styles["Heading1"],
        fontSize=16,
        leading=19,
        textColor=colors.HexColor("#0f172a"),
        spaceAfter=2,
    )
    body = ParagraphStyle(
        "OtdBody",
        parent=styles["Normal"],
        fontSize=9,
        leading=12,
        textColor=colors.HexColor("#1e293b"),
    )
    small = ParagraphStyle(
        "OtdSmall",
        parent=styles["Normal"],
        fontSize=8,
        leading=11,
        textColor=_MUTED,
    )
    cell = ParagraphStyle(
        "OtdCell",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=7,
        leading=9,
        textColor=colors.HexColor("#0f172a"),
    )
    head_cell = ParagraphStyle(
        "OtdHead",
        parent=cell,
        fontName="Helvetica-Bold",
        textColor=colors.white,
    )

    story: list[Any] = [
        Paragraph("On-time delivery", title_style),
        Paragraph(
            f"{_esc(year)} &nbsp;|&nbsp; Benchmark: <b>{_esc(active)}</b>"
            f" &nbsp;|&nbsp; On time = last delivery on or before { _esc(active) }",
            body,
        ),
    ]
    note = compact_text(payload.get("filter_note"))
    if note:
        story.append(Paragraph(_esc(note), small))
    story.append(Spacer(1, 4))

    summary = payload.get("summary") or {}
    other = payload.get("other_summary") or {}
    other_label = benchmark_label(
        "po_due" if payload.get("benchmark") == "proposed_edd" else "proposed_edd"
    )
    missing = int(payload.get("missing_edd") or 0)
    ref = _summary_line(active, summary) + " &nbsp;&nbsp; " + _summary_line(other_label, other)
    if missing:
        ref += f" &nbsp;&nbsp; {missing} blank proposed EDD, scored on PO due"
    story.append(Paragraph(ref, body))
    story.append(Spacer(1, 6))

    sections = payload.get("sections") or []
    if sections:
        for section in sections:
            story.append(
                Paragraph(
                    f"{_esc(section.get('label'))} - {_esc(section.get('subtitle'))}",
                    ParagraphStyle(
                        "OtdH2",
                        parent=styles["Heading2"],
                        fontSize=11,
                        leading=14,
                        textColor=colors.HexColor("#0f172a"),
                        spaceBefore=8,
                        spaceAfter=3,
                    ),
                )
            )
            story.append(Paragraph(_summary_line(active, section.get("summary") or {}), body))
            story.append(Spacer(1, 3))
            story.append(_month_table(section.get("by_month") or [], head_cell, cell))
            story.append(Spacer(1, 4))
    else:
        story.append(Paragraph("By delivery month", ParagraphStyle(
            "OtdH2b",
            parent=styles["Heading2"],
            fontSize=11,
            leading=14,
            textColor=colors.HexColor("#0f172a"),
            spaceBefore=2,
            spaceAfter=3,
        )))
        story.append(_month_table(payload.get("by_month") or [], head_cell, cell))
        story.append(Spacer(1, 8))
        story.append(Paragraph("Process sheets", ParagraphStyle(
            "OtdH2c",
            parent=styles["Heading2"],
            fontSize=11,
            leading=14,
            textColor=colors.HexColor("#0f172a"),
            spaceBefore=2,
            spaceAfter=3,
        )))
        story.append(
            _detail_table(
                payload.get("rows") or [],
                head_cell,
                cell,
                proposed_benchmark=payload.get("benchmark") == "proposed_edd",
            )
        )

    doc.build(story)
    return buf.getvalue()


def _month_table(months: list[dict[str, Any]], head_cell: ParagraphStyle, cell: ParagraphStyle) -> Table:
    header = [
        Paragraph(label, head_cell)
        for label in ("Month", "Early", "On time", "Late", "Classified", "OTD %")
    ]
    data: list[list[Any]] = [header]
    filled = [row for row in months if int(row.get("classified") or 0)]
    if not filled:
        data.append([Paragraph("No classified process sheets.", cell)] + [Paragraph("-", cell)] * 5)
        width = 277 * mm
        return _table(data, [width * share for share in (0.16, 0.14, 0.16, 0.14, 0.2, 0.2)])
    for row in filled:
        data.append(
            [
                Paragraph(_esc(row.get("label") or MONTH_LABELS[int(row.get("month") or 1) - 1]), cell),
                Paragraph(str(int(row.get("early") or 0)), cell),
                Paragraph(str(int(row.get("on_time") or 0)), cell),
                Paragraph(str(int(row.get("late") or 0)), cell),
                Paragraph(str(int(row.get("classified") or 0)), cell),
                Paragraph(_pct(row.get("on_time_rate")), cell),
            ]
        )
    width = 277 * mm
    return _table(data, [width * share for share in (0.16, 0.14, 0.16, 0.14, 0.2, 0.2)])


def _detail_table(
    rows: list[dict[str, Any]],
    head_cell: ParagraphStyle,
    cell: ParagraphStyle,
    *,
    proposed_benchmark: bool,
) -> Table:
    late_cell = ParagraphStyle("OtdLate", parent=cell, textColor=_LATE)
    early_cell = ParagraphStyle("OtdEarly", parent=cell, textColor=_EARLY)
    labels = [
        "Process sheet", "PS", "Sales order", "Customer", "Sales person",
        "Part", "PO due", "Proposed EDD", "Delivery", "Days", "Status",
    ]
    data: list[list[Any]] = [[Paragraph(label, head_cell) for label in labels]]
    if not rows:
        data.append([Paragraph("No process sheets match this filter.", cell)] + [Paragraph("", cell)] * 10)
    for row in rows:
        days = row.get("days")
        day_style = cell
        if isinstance(days, int) and days > 0:
            day_style = late_cell
        elif isinstance(days, int) and days < 0:
            day_style = early_cell
        status = compact_text(row.get("status"))
        status_style = late_cell if status == "late" else (early_cell if status == "early" else cell)
        data.append(
            [
                Paragraph(_esc(row.get("process_sheet_no")), cell),
                Paragraph(_esc(row.get("pp_type_label") or row.get("pp_type")), cell),
                Paragraph(_esc(row.get("sales_order_no")), cell),
                Paragraph(_esc(row.get("customer_name") or row.get("customer_code")), cell),
                Paragraph(_esc(row.get("sales_person_label") or row.get("sales_person_name") or row.get("sales_person_code")), cell),
                Paragraph(_esc(row.get("inventory_code")), cell),
                Paragraph(_esc((row.get("po_due_date") or "")[:10]), cell),
                Paragraph(_esc((row.get("proposed_edd") or "")[:10]), cell),
                Paragraph(_esc((row.get("delivery_date") or "")[:10]), cell),
                Paragraph(_days_text(days), day_style),
                Paragraph(_status_text(status, proposed_benchmark=proposed_benchmark), status_style),
            ]
        )
    width = 277 * mm
    shares = (0.12, 0.05, 0.10, 0.13, 0.12, 0.09, 0.09, 0.10, 0.09, 0.05, 0.06)
    return _table(data, [width * share for share in shares], font_size=7)
