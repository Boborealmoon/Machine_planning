"""End-of-shift PDF report for Day/Night HOTO."""
from __future__ import annotations

import io
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from .utils import compact_text


def _txt(value: Any, fallback: str = "-") -> str:
    text = compact_text(value)
    return text if text else fallback


def _yes_no_issue(flag: Any, text: Any) -> str:
    if flag:
        detail = compact_text(text)
        return f"ISSUE: {detail}" if detail else "ISSUE"
    return "Nil"


def build_shift_report_pdf(payload: dict[str, Any]) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=12 * mm,
        bottomMargin=12 * mm,
        title=f"End of Shift Report {_txt(payload.get('work_date'))} {_txt(payload.get('shift_out'))}",
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "SmTitle",
        parent=styles["Heading1"],
        fontSize=16,
        spaceAfter=6,
        textColor=colors.HexColor("#0f172a"),
    )
    h2 = ParagraphStyle(
        "SmH2",
        parent=styles["Heading2"],
        fontSize=12,
        spaceBefore=10,
        spaceAfter=4,
        textColor=colors.HexColor("#0f172a"),
    )
    body = ParagraphStyle(
        "SmBody",
        parent=styles["Normal"],
        fontSize=9,
        leading=12,
        textColor=colors.HexColor("#1e293b"),
    )
    small = ParagraphStyle(
        "SmSmall",
        parent=styles["Normal"],
        fontSize=8,
        leading=10,
        textColor=colors.HexColor("#475569"),
    )

    story: list[Any] = []
    work_date = _txt(payload.get("work_date"))
    shift_out = _txt(payload.get("shift_out"))
    shift_in = _txt(payload.get("shift_in"))
    summary = payload.get("summary") or {}

    story.append(Paragraph("End of Shift Report", title_style))
    story.append(
        Paragraph(
            f"<b>{work_date}</b> &nbsp;|&nbsp; Outgoing: <b>{shift_out}</b>"
            f" &nbsp;?&nbsp; Incoming: <b>{shift_in}</b>",
            body,
        )
    )
    story.append(
        Paragraph(f"Generated: {_txt(payload.get('generated_at'))}", small)
    )
    story.append(Spacer(1, 6))

    summary_rows = [
        ["Machines", str(summary.get("machines") or 0)],
        ["Pending ack", str(summary.get("pending_ack") or 0)],
        ["Open tickets", str(summary.get("open_tickets") or 0)],
        ["Urgent jobs", str(summary.get("urgent_jobs") or 0)],
        ["Open NCRs", str(summary.get("open_ncrs") or 0)],
    ]
    summary_table = Table(summary_rows, colWidths=[45 * mm, 30 * mm])
    summary_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f1f5f9")),
                ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#94a3b8")),
                ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
                ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(summary_table)

    handovers = payload.get("handovers") or []
    if not handovers:
        story.append(Spacer(1, 10))
        story.append(Paragraph("No handovers recorded for this shift.", body))
    for ho in handovers:
        story.append(
            Paragraph(
                f"{_txt(ho.get('machine_no'))} - {_txt(ho.get('job_no'), 'No job')}",
                h2,
            )
        )
        material = _txt(ho.get("material_qty"), "-")
        if material != "-":
            material = f"{material} {_txt(ho.get('material_unit'), '')}".strip()
        rows = [
            ["Machine status", _txt(ho.get("machine_status"))],
            ["Remaining quantity", _txt(ho.get("remaining_qty"), "0")],
            ["First piece status", _txt(ho.get("first_piece_status"))],
            ["Tool life", f"{_txt(ho.get('tool_life_pct'), '100')}%"],
            ["Material balance", material],
            ["Quality issues", _yes_no_issue(ho.get("quality_issue_flag"), ho.get("quality_issue_text"))],
            ["Machine alarms", _yes_no_issue(ho.get("alarm_flag"), ho.get("alarm_text"))],
            ["Pending maintenance", _yes_no_issue(ho.get("maintenance_flag"), ho.get("maintenance_text"))],
            [
                "Urgent jobs",
                (
                    f"{_txt(ho.get('priority'))}: {_txt(ho.get('priority_note'))}"
                    if _txt(ho.get("priority")) in ("High", "Urgent")
                    else _txt(ho.get("priority"), "Normal")
                ),
            ],
            [
                "NCR status",
                (
                    f"{_txt(ho.get('ncr_status'))}"
                    + (f" ({_txt(ho.get('ncr_ref'))})" if compact_text(ho.get("ncr_ref")) else "")
                ),
            ],
            ["Handover status", _txt(ho.get("status"))],
            ["Outgoing", _txt(ho.get("outgoing_display_name"))],
            ["Incoming", _txt(ho.get("incoming_display_name"))],
            ["Remarks", _txt(ho.get("remarks"))],
        ]
        table = Table(rows, colWidths=[42 * mm, 128 * mm])
        table.setStyle(
            TableStyle(
                [
                    ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#94a3b8")),
                    ("INNERGRID", (0, 0), (-1, -1), 0.2, colors.HexColor("#e2e8f0")),
                    ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f8fafc")),
                    ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, -1), 8),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 5),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]
            )
        )
        story.append(table)

        comments = ho.get("comments") or []
        if comments:
            story.append(Paragraph("<b>Handover comments</b>", small))
            for c in comments:
                who = _txt(c.get("display_name") or c.get("username"), "User")
                when = _txt(c.get("created_at"))
                story.append(
                    Paragraph(f"? [{when}] {who}: {_txt(c.get('body'))}", small)
                )

        machine_tickets = ho.get("machine_tickets") or []
        if machine_tickets:
            story.append(Paragraph("<b>Tickets</b>", small))
            for t in machine_tickets:
                story.append(
                    Paragraph(
                        f"? #{_txt(t.get('ticket_id'))} [{_txt(t.get('status'))}/"
                        f"{_txt(t.get('priority'))}] {_txt(t.get('category'))}: "
                        f"{_txt(t.get('title'))} - PS {_txt(t.get('process_sheet_no') or t.get('job_no'))}",
                        small,
                    )
                )

    all_tickets = payload.get("tickets") or []
    if all_tickets:
        story.append(Paragraph("All shift tickets", h2))
        for t in all_tickets:
            story.append(
                Paragraph(
                    f"#{_txt(t.get('ticket_id'))} | {_txt(t.get('machine_no'))} | "
                    f"{_txt(t.get('status'))} | {_txt(t.get('category'))} | "
                    f"{_txt(t.get('title'))}",
                    body,
                )
            )
            if compact_text(t.get("description")):
                story.append(Paragraph(_txt(t.get("description")), small))

    doc.build(story)
    return buf.getvalue()
