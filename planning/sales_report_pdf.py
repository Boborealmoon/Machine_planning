"""Management PDF for the sales report.

The page already holds the filtered figures. This module only lays out the
payload the browser posts: a year reading, grouped tables, then line detail.
"""
from __future__ import annotations

import io
import os
import re
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    CondPageBreak,
    HRFlowable,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.pdfgen import canvas

from .utils import compact_text

_FONT = "Helvetica"
_FONT_BOLD = "Helvetica-Bold"
_FONT_READY = False

_INK = colors.HexColor("#0f172a")
_MUTED = colors.HexColor("#64748b")
_LINE = colors.HexColor("#e2e8f0")
_LINE_STRONG = colors.HexColor("#cbd5e1")
_ZEBRA = colors.HexColor("#f8fafc")
_TOTAL_BG = colors.HexColor("#eef2ff")
_HEAD_BG = colors.HexColor("#0f172a")
_GROUP_BG = colors.HexColor("#f1f5f9")

_TONE_BG = {
    "past": colors.HexColor("#ecfdf5"),
    "current": colors.HexColor("#fef3c7"),
    "future": colors.HexColor("#eff6ff"),
    "selected": colors.HexColor("#dbeafe"),
    "open": colors.HexColor("#eef2ff"),
}
_TONE_FG = {
    "past": colors.HexColor("#065f46"),
    "current": colors.HexColor("#92400e"),
    "future": colors.HexColor("#1e40af"),
    "selected": colors.HexColor("#1e3a8a"),
    "open": colors.HexColor("#3730a3"),
}
_KPI_BAR = {
    "shipped": colors.HexColor("#047857"),
    "cleared": colors.HexColor("#b45309"),
    "on-hand": colors.HexColor("#1d4ed8"),
    "early": colors.HexColor("#0e7490"),
    "booked": colors.HexColor("#7c3aed"),
    "year": colors.HexColor("#4338ca"),
    "achieve": colors.HexColor("#be185d"),
}

_MAX_NOTES = 8
_MAX_ROWS = 500
_MAX_GROUPS = 8
_MAX_TABLE_ROWS = 40


def _register_fonts() -> tuple[str, str]:
    global _FONT, _FONT_BOLD, _FONT_READY
    if _FONT_READY:
        return _FONT, _FONT_BOLD
    _FONT_READY = True
    regular = _try_font(
        "SalesReportBody",
        [
            r"C:\Windows\Fonts\msyh.ttc",
            r"C:\Windows\Fonts\msyh.ttf",
            r"C:\Windows\Fonts\simsun.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        ],
    )
    bold = _try_font(
        "SalesReportBody-Bold",
        [
            r"C:\Windows\Fonts\msyhbd.ttc",
            r"C:\Windows\Fonts\msyhbd.ttf",
            r"C:\Windows\Fonts\simhei.ttf",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        ],
    )
    if regular:
        _FONT = regular
        _FONT_BOLD = bold or regular
    else:
        _FONT = "Helvetica"
        _FONT_BOLD = "Helvetica-Bold"
    return _FONT, _FONT_BOLD


def _try_font(face: str, paths: list[str]) -> str | None:
    if face in pdfmetrics.getRegisteredFontNames():
        return face
    for path in paths:
        if not path or not os.path.isfile(path):
            continue
        try:
            pdfmetrics.registerFont(TTFont(face, path, subfontIndex=0))
            return face
        except TypeError:
            try:
                pdfmetrics.registerFont(TTFont(face, path))
                return face
            except Exception:
                continue
        except Exception:
            continue
    return None


def _plain(value: Any, limit: int = 180) -> str:
    text = compact_text(value)
    text = "".join(ch for ch in text if ch >= " " or ch in "\n\t")
    text = " ".join(text.split())
    if len(text) > limit:
        return text[: limit - 3].rstrip() + "..."
    return text


def _line_count_label(value: Any) -> str:
    text = _plain(value, 12)
    try:
        count = int(text)
    except ValueError:
        return text
    noun = "line" if count == 1 else "lines"
    return f"{count} {noun}"


def _xml(value: Any, limit: int = 180) -> str:
    return (
        _plain(value, limit)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _as_list(value: Any, limit: int) -> list[Any]:
    if not isinstance(value, list):
        return []
    return value[:limit]


def _filename(payload: dict[str, Any]) -> str:
    try:
        year = int(payload.get("year") or 0)
    except (TypeError, ValueError):
        year = 0
    try:
        month = int(payload.get("focus_month") or 0)
    except (TypeError, ValueError):
        month = 0
    segment = re.sub(r"[^A-Za-z0-9]+", "-", _plain(payload.get("segment"), 40)).strip("-")
    segment = segment or "segments"
    if year and 1 <= month <= 12:
        return f"Sales-Report-{year}-{month:02d}-{segment}.pdf"
    if year:
        return f"Sales-Report-{year}-{segment}.pdf"
    return "Sales-Report.pdf"


def _kpis(raw: Any) -> list[dict[str, str]]:
    cards: list[dict[str, str]] = []
    for item in _as_list(raw, 12):
        if not isinstance(item, dict):
            continue
        label = _plain(item.get("label"), 40)
        value = _plain(item.get("value"), 32)
        if not label and not value:
            continue
        cards.append(
            {
                "label": label or "-",
                "value": value or "-",
                "sub": _plain(item.get("sub"), 90),
                "tone": _plain(item.get("tone"), 20),
            }
        )
    return cards


def _notes(raw: Any) -> list[str]:
    notes: list[str] = []
    for item in _as_list(raw, _MAX_NOTES):
        text = _plain(item, 420)
        if text:
            notes.append(text)
    return notes


def _string_rows(raw: Any, width: int, limit: int) -> list[list[str]]:
    rows: list[list[str]] = []
    for item in _as_list(raw, limit):
        if not isinstance(item, list):
            continue
        cells = [_plain(cell, 80) for cell in item[:width]]
        if len(cells) < width:
            cells.extend([""] * (width - len(cells)))
        rows.append(cells)
    return rows


def _year_table(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    spans: list[dict[str, Any]] = []
    for item in _as_list(raw.get("spans"), 18):
        if not isinstance(item, dict):
            continue
        try:
            span = int(item.get("span") or 1)
        except (TypeError, ValueError):
            span = 1
        span = max(1, min(span, 4))
        tone = _plain(item.get("tone"), 16)
        if tone not in _TONE_BG:
            tone = "future"
        spans.append({"label": _plain(item.get("label"), 16) or "-", "span": span, "tone": tone})
    subheads = [_plain(item, 24) or "-" for item in _as_list(raw.get("subheads"), 24)]
    if not spans or sum(item["span"] for item in spans) != len(subheads):
        return None
    rows: list[dict[str, Any]] = []
    for item in _as_list(raw.get("rows"), 12):
        if not isinstance(item, dict):
            continue
        values = [_plain(cell, 24) for cell in _as_list(item.get("values"), 24)]
        if len(values) != len(subheads):
            continue
        rows.append(
            {
                "label": _plain(item.get("label"), 24) or "-",
                "values": values,
                "open_year": _plain(item.get("open_year"), 24),
                "open_all": _plain(item.get("open_all"), 24),
                "emphasis": "total" if item.get("emphasis") == "total" else "",
            }
        )
    if not rows:
        return None
    return {
        "spans": spans,
        "subheads": subheads,
        "rows": rows,
        "open_remaining": bool(raw.get("open_remaining")),
        "open_year_label": _plain(raw.get("open_year_label"), 28) or "Due this year",
        "open_all_label": _plain(raw.get("open_all_label"), 28) or "All years",
    }


def _simple_table(raw: Any, *, row_limit: int = _MAX_TABLE_ROWS) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    headers = [_plain(item, 32) or "-" for item in _as_list(raw.get("headers"), 8)]
    if len(headers) < 2:
        return None
    rows = _string_rows(raw.get("rows"), len(headers), row_limit)
    if not rows:
        return None
    numeric = []
    for item in _as_list(raw.get("numeric"), len(headers)):
        try:
            idx = int(item)
        except (TypeError, ValueError):
            continue
        if 0 <= idx < len(headers):
            numeric.append(idx)
    return {
        "title": _plain(raw.get("title"), 80),
        "subtitle": _plain(raw.get("subtitle"), 180),
        "headers": headers,
        "rows": rows,
        "numeric": numeric or list(range(1, len(headers))),
    }


def _timing(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    headers = [_plain(item, 32) or "-" for item in _as_list(raw.get("headers"), 6)]
    if len(headers) < 2:
        return None
    blocks: list[dict[str, Any]] = []
    for item in _as_list(raw.get("blocks"), 8):
        if not isinstance(item, dict):
            continue
        rows = _string_rows(item.get("rows"), len(headers), 12)
        if not rows:
            continue
        total = [_plain(cell, 24) for cell in _as_list(item.get("total"), len(headers))]
        if len(total) < len(headers):
            total.extend([""] * (len(headers) - len(total)))
        blocks.append(
            {
                "label": _plain(item.get("label"), 24) or "-",
                "rows": rows,
                "total": total[: len(headers)],
            }
        )
    if not blocks:
        return None
    return {"headers": headers, "blocks": blocks}


def _line_sections(raw: Any) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    for item in _as_list(raw, 6):
        if not isinstance(item, dict):
            continue
        columns = [_plain(col, 24) or "-" for col in _as_list(item.get("columns"), 12)]
        if len(columns) < 2:
            continue
        numeric = []
        for idx in _as_list(item.get("numeric"), len(columns)):
            try:
                num = int(idx)
            except (TypeError, ValueError):
                continue
            if 0 <= num < len(columns):
                numeric.append(num)
        widths = []
        for weight in _as_list(item.get("widths"), len(columns)):
            try:
                num = float(weight)
            except (TypeError, ValueError):
                num = 1.0
            widths.append(num if num > 0 else 1.0)
        if len(widths) != len(columns):
            widths = [1.0] * len(columns)
        groups: list[dict[str, Any]] = []
        truncated = False
        for group in _as_list(item.get("groups"), _MAX_GROUPS):
            if not isinstance(group, dict):
                continue
            rows = _string_rows(group.get("rows"), len(columns), _MAX_ROWS)
            if not rows:
                continue
            try:
                line_count = int(group.get("line_count") or len(rows))
            except (TypeError, ValueError):
                line_count = len(rows)
            if line_count > len(rows):
                truncated = True
            totals = [_plain(cell, 24) for cell in _as_list(group.get("totals"), len(columns))]
            if len(totals) < len(columns):
                totals.extend([""] * (len(columns) - len(totals)))
            groups.append(
                {
                    "type": _plain(group.get("type"), 16) or "-",
                    "line_count": max(line_count, len(rows)),
                    "rows": rows,
                    "totals": totals[: len(columns)],
                }
            )
        if not groups:
            continue
        sections.append(
            {
                "title": _plain(item.get("title"), 60) or "Breakdown",
                "hint": _plain(item.get("hint"), 180),
                "line_count": _plain(item.get("line_count"), 12),
                "total": _plain(item.get("total"), 24),
                "columns": columns,
                "numeric": numeric,
                "widths": widths,
                "groups": groups,
                "truncated": truncated,
            }
        )
    return sections


def prepare_sales_report_pdf(payload: dict[str, Any]) -> dict[str, Any]:
    """Turn the posted JSON into the view model the PDF draws."""
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object.")
    year_table = _year_table(payload.get("year_table"))
    sections = _line_sections(payload.get("sections"))
    breakdown = _simple_table(payload.get("breakdown"))
    groups = [table for item in _as_list(payload.get("groups"), 4) if (table := _simple_table(item))]
    timing = _timing(payload.get("timing"))
    year_kpis = _kpis(payload.get("year_kpis"))
    month_kpis = _kpis(payload.get("month_kpis"))
    if not any([year_table, sections, breakdown, groups, year_kpis, month_kpis]):
        raise ValueError("Nothing to export. Open the sales report and try again.")

    posted = bool(payload.get("posted_basis"))
    focus = _plain(payload.get("focus_label"), 40)
    segment = _plain(payload.get("segment"), 60) or "Selected segments"
    basis = _plain(payload.get("date_basis"), 40) or "PO due date"
    generated = _plain(payload.get("generated_at"), 40)
    filters = _plain(payload.get("filters"), 160)
    if posted:
        legend = (
            "Amounts are home currency. Completed months are total sales "
            "(every shipment dated in the month). Current and later months are "
            "unfinished onhand by sales-order posted date."
        )
    else:
        legend = (
            "Amounts are home currency. Completed months are total shipped. "
            "The current month splits unfinished work into backlog (PO due before "
            "the month) and onhand (PO due in the month). Later months are unfinished "
            "onhand by PO due date. Open remaining is unfinished value due this year, "
            "and unfinished value across all years."
        )
    recon = payload.get("reconciliation") if isinstance(payload.get("reconciliation"), dict) else None
    recon_line = ""
    if recon:
        state = "balanced" if recon.get("ok") else "needs review"
        recon_line = (
            f"Reconciliation {state}. SO remaining {_plain(recon.get('so_remaining'), 24) or '-'}  |  "
            f"PP-allocated {_plain(recon.get('pp_allocated'), 24) or '-'}  |  "
            f"Shipped {_plain(recon.get('shipped'), 24) or '-'}."
        )
    subtitle = focus or (_plain(payload.get("year"), 8) and f"{_plain(payload.get('year'), 8)} full year")
    return {
        "filename": _filename(payload),
        "header_right": "  |  ".join(part for part in (focus or _plain(payload.get("year"), 8), segment, basis) if part),
        "footer_left": "  |  ".join(part for part in ("Management pack", generated, "Home currency") if part),
        "title": "Sales Report",
        "subtitle": subtitle or "Sales Report",
        "meta": [f"Segment: {segment}", f"Date basis: {basis}"]
        + ([f"Filters: {filters}"] if filters else [])
        + ([f"Generated: {generated}"] if generated else []),
        "legend": legend,
        "reconciliation": recon_line,
        "notes": _notes(payload.get("notes")),
        "year_kpis": year_kpis,
        "month_kpis": month_kpis,
        "month_label": focus,
        "year_table": year_table,
        "timing": timing,
        "breakdown": breakdown,
        "groups": groups,
        "sections": sections,
    }


class _SalesReportCanvas(canvas.Canvas):
    def __init__(self, *args, header_right: str = "", footer_left: str = "", font: str = "Helvetica", font_bold: str = "Helvetica-Bold", **kwargs):
        self._header_right = header_right
        self._footer_left = footer_left
        self._face = font
        self._face_bold = font_bold
        self._records: list[dict[str, Any]] = []
        super().__init__(*args, **kwargs)

    def showPage(self):
        self._records.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        page_count = len(self._records)
        for state in self._records:
            self.__dict__.update(state)
            self._draw_chrome(page_count)
            canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)

    def _draw_chrome(self, page_count: int) -> None:
        width, height = self._pagesize
        page_no = int(self._pageNumber or 1)
        self.saveState()
        self.setFillColor(_INK)
        self.rect(0, height - 11 * mm, width, 11 * mm, fill=1, stroke=0)
        self.setFillColor(colors.white)
        self.setFont(self._face_bold, 9)
        self.drawString(12 * mm, height - 7.2 * mm, "Sales Report")
        self.setFont(self._face, 8)
        right = self._header_right[:110]
        self.drawRightString(width - 12 * mm, height - 7.2 * mm, right)
        self.setFillColor(_MUTED)
        self.setFont(self._face, 7.5)
        self.drawString(12 * mm, 6 * mm, self._footer_left[:120])
        self.drawRightString(width - 12 * mm, 6 * mm, f"Page {page_no} of {page_count}")
        self.restoreState()


def _styles(font: str, font_bold: str) -> dict[str, ParagraphStyle]:
    return {
        "title": ParagraphStyle("SrTitle", fontName=font_bold, fontSize=16, leading=19, textColor=_INK, spaceAfter=1),
        "sub": ParagraphStyle("SrSub", fontName=font, fontSize=10, leading=13, textColor=_INK, spaceAfter=2),
        "meta": ParagraphStyle("SrMeta", fontName=font, fontSize=8, leading=11, textColor=_MUTED),
        "h": ParagraphStyle("SrH", fontName=font_bold, fontSize=11, leading=14, textColor=_INK, spaceBefore=2, spaceAfter=2),
        "body": ParagraphStyle("SrBody", fontName=font, fontSize=8, leading=11, textColor=_INK),
        "note": ParagraphStyle("SrNote", fontName=font, fontSize=8, leading=11, textColor=_INK, leftIndent=8, bulletIndent=0),
        "small": ParagraphStyle("SrSmall", fontName=font, fontSize=7, leading=9, textColor=_MUTED),
        "kpi_label": ParagraphStyle("SrKpiLabel", fontName=font_bold, fontSize=6.5, leading=8, textColor=_MUTED),
        "kpi_value": ParagraphStyle("SrKpiValue", fontName=font_bold, fontSize=10, leading=13, textColor=_INK, spaceBefore=1),
        "kpi_sub": ParagraphStyle("SrKpiSub", fontName=font, fontSize=6.5, leading=8, textColor=_MUTED),
        "th": ParagraphStyle("SrTh", fontName=font_bold, fontSize=7, leading=9, textColor=colors.white, alignment=TA_LEFT),
        "th_right": ParagraphStyle("SrThRight", fontName=font_bold, fontSize=7, leading=9, textColor=colors.white, alignment=TA_RIGHT),
        "td": ParagraphStyle("SrTd", fontName=font, fontSize=7, leading=9, textColor=_INK, alignment=TA_LEFT),
        "td_right": ParagraphStyle("SrTdRight", fontName=font, fontSize=7, leading=9, textColor=_INK, alignment=TA_RIGHT),
        "td_bold": ParagraphStyle("SrTdBold", fontName=font_bold, fontSize=7, leading=9, textColor=_INK, alignment=TA_LEFT),
        "td_bold_right": ParagraphStyle("SrTdBoldRight", fontName=font_bold, fontSize=7, leading=9, textColor=_INK, alignment=TA_RIGHT),
        "month": ParagraphStyle("SrMonth", fontName=font_bold, fontSize=7, leading=9, alignment=TA_CENTER, textColor=_INK),
        "grid": ParagraphStyle("SrGrid", fontName=font, fontSize=6.5, leading=8, alignment=TA_RIGHT, textColor=_INK),
        "grid_bold": ParagraphStyle("SrGridBold", fontName=font_bold, fontSize=6.5, leading=8, alignment=TA_RIGHT, textColor=_INK),
        "grid_left": ParagraphStyle("SrGridLeft", fontName=font_bold, fontSize=7, leading=9, alignment=TA_LEFT, textColor=_INK),
        "center": ParagraphStyle("SrCenter", fontName=font_bold, fontSize=7, leading=9, alignment=TA_CENTER, textColor=_INK),
    }


def _p(text: Any, style: ParagraphStyle, limit: int = 180) -> Paragraph:
    return Paragraph(_xml(text, limit) or "-", style)


def _section_heading(text: str, styles: dict[str, ParagraphStyle]) -> list[Any]:
    return [
        Spacer(1, 3.5 * mm),
        Paragraph(_xml(text, 80), styles["h"]),
        HRFlowable(width="100%", thickness=0.6, color=_LINE_STRONG, spaceAfter=2.5 * mm),
    ]


def _kpi_flowables(cards: list[dict[str, str]], width: float, styles: dict[str, ParagraphStyle]) -> list[Any]:
    if not cards:
        return []
    per_row = 4
    col_w = width / per_row
    flowables: list[Any] = []
    for start in range(0, len(cards), per_row):
        chunk = cards[start : start + per_row]
        while len(chunk) < per_row:
            chunk.append(None)
        data = []
        for card in chunk:
            if not card:
                data.append("")
                continue
            data.append(
                [
                    Paragraph(_xml(card["label"].upper(), 40), styles["kpi_label"]),
                    Paragraph(_xml(card["value"], 32), styles["kpi_value"]),
                    Paragraph(_xml(card["sub"], 90) if card["sub"] else "&nbsp;", styles["kpi_sub"]),
                ]
            )
        table = Table([data], colWidths=[col_w] * per_row)
        style_cmds: list[tuple] = [
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("BACKGROUND", (0, 0), (-1, -1), colors.white),
            ("BOX", (0, 0), (-1, -1), 0.3, _LINE),
            ("LINEAFTER", (0, 0), (-2, -1), 0.3, _LINE),
            ("LINEABOVE", (0, 0), (-1, 0), 2.2, _LINE_STRONG),
        ]
        for idx, card in enumerate(chunk):
            if not card:
                style_cmds.append(("LINEABOVE", (idx, 0), (idx, 0), 0, colors.white))
                style_cmds.append(("BACKGROUND", (idx, 0), (idx, 0), colors.white))
                continue
            style_cmds.append(("LINEABOVE", (idx, 0), (idx, 0), 2.4, _KPI_BAR.get(card["tone"], _INK)))
        table.setStyle(TableStyle(style_cmds))
        flowables.append(table)
        flowables.append(Spacer(1, 2 * mm))
    return flowables


def _grid_table(model: dict[str, Any], width: float, styles: dict[str, ParagraphStyle]) -> Table:
    spans = model["spans"]
    subheads = model["subheads"]
    open_remaining = model["open_remaining"]
    header_top: list[Any] = [_p("Segment", styles["center"], 20)]
    header_sub: list[Any] = [""]
    col = 1
    span_cmds = [("SPAN", (0, 0), (0, 1))]
    tone_cmds = []
    for group in spans:
        header_top.append(_p(group["label"], styles["month"], 16))
        header_top.extend([""] * (group["span"] - 1))
        if group["span"] > 1:
            span_cmds.append(("SPAN", (col, 0), (col + group["span"] - 1, 0)))
        bg = _TONE_BG.get(group["tone"], _ZEBRA)
        fg = _TONE_FG.get(group["tone"], _INK)
        tone_cmds.append(("BACKGROUND", (col, 0), (col + group["span"] - 1, 1), bg))
        tone_cmds.append(("TEXTCOLOR", (col, 0), (col + group["span"] - 1, 1), fg))
        col += group["span"]
    for head in subheads:
        header_sub.append(_p(head, styles["center"], 16))
    if open_remaining:
        header_top.extend(
            [
                _p("Open remaining", styles["center"], 20),
                _p("Open remaining", styles["center"], 20),
            ]
        )
        header_sub.extend(
            [
                _p(model["open_year_label"], styles["center"], 24),
                _p(model["open_all_label"], styles["center"], 24),
            ]
        )
        tone_cmds.append(("BACKGROUND", (col, 0), (col + 1, 1), _TONE_BG["open"]))
    body = [header_top, header_sub]
    total_rows = []
    for offset, row in enumerate(model["rows"]):
        values = [_p(row["label"], styles["grid_left"], 24)]
        grid_style = styles["grid_bold"] if row["emphasis"] == "total" else styles["grid"]
        values.extend(_p(value or "0.00", grid_style, 24) for value in row["values"])
        if open_remaining:
            values.append(_p(row["open_year"] or "-", grid_style, 24))
            values.append(_p(row["open_all"] or "-", grid_style, 24))
        body.append(values)
        if row["emphasis"] == "total":
            total_rows.append(offset + 2)

    label_w = 24 * mm
    open_w = 22 * mm if open_remaining else 0
    month_count = len(subheads)
    month_w = (width - label_w - (open_w * 2 if open_remaining else 0)) / month_count
    col_widths = [label_w] + [month_w] * month_count
    if open_remaining:
        col_widths.extend([open_w, open_w])
    table = Table(body, colWidths=col_widths, repeatRows=2)
    cmds: list[tuple] = [
        ("FONTNAME", (0, 0), (-1, -1), styles["grid"].fontName),
        ("BACKGROUND", (0, 0), (0, 1), _GROUP_BG),
        ("ALIGN", (1, 2), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.3, _LINE_STRONG),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("BACKGROUND", (0, 2), (0, -1), colors.white),
    ]
    cmds.extend(span_cmds)
    cmds.extend(tone_cmds)
    for row_idx in range(2, len(body)):
        if (row_idx % 2) == 0 and row_idx not in total_rows:
            cmds.append(("BACKGROUND", (0, row_idx), (0, row_idx), _ZEBRA))
    for row_idx in total_rows:
        cmds.append(("BACKGROUND", (0, row_idx), (-1, row_idx), _TOTAL_BG))
    table.setStyle(TableStyle(cmds))
    return table


def _data_table(
    headers: list[str],
    rows: list[list[str]],
    numeric: list[int],
    width: float,
    styles: dict[str, ParagraphStyle],
    *,
    first_width: float | None = None,
    weights: list[float] | None = None,
) -> Table:
    numeric_set = set(numeric)
    head = [
        _p(text, styles["th_right"] if idx in numeric_set else styles["th"], 32)
        for idx, text in enumerate(headers)
    ]
    body = [head]
    for row in rows:
        styled = []
        is_total = _plain(row[0], 20).lower() == "total"
        for idx, cell in enumerate(row):
            if is_total:
                style = styles["td_bold_right"] if idx in numeric_set else styles["td_bold"]
            else:
                style = styles["td_right"] if idx in numeric_set else styles["td"]
            styled.append(_p(cell or "-", style, 80) if cell else Paragraph("&nbsp;", style))
        body.append(styled)
    if weights and len(weights) == len(headers):
        scale = width / sum(weights)
        col_widths = [weight * scale for weight in weights]
    elif first_width:
        rest = max(len(headers) - 1, 1)
        col_widths = [first_width] + [(width - first_width) / rest] * rest
    else:
        col_widths = [width / len(headers)] * len(headers)
    table = Table(body, colWidths=col_widths, repeatRows=1)
    cmds: list[tuple] = [
        ("BACKGROUND", (0, 0), (-1, 0), _HEAD_BG),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.25, _LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("ALIGN", (0, 1), (-1, -1), "LEFT"),
    ]
    for idx in numeric:
        cmds.append(("ALIGN", (idx, 1), (idx, -1), "RIGHT"))
    for row_idx in range(1, len(body)):
        if _plain(rows[row_idx - 1][0], 20).lower() == "total":
            cmds.append(("BACKGROUND", (0, row_idx), (-1, row_idx), _TOTAL_BG))
        elif row_idx % 2 == 0:
            cmds.append(("BACKGROUND", (0, row_idx), (-1, row_idx), _ZEBRA))
    table.setStyle(TableStyle(cmds))
    return table


def _story(model: dict[str, Any], width: float, font: str, font_bold: str) -> list[Any]:
    styles = _styles(font, font_bold)
    story: list[Any] = [
        Paragraph(model["title"], styles["title"]),
        Paragraph(_xml(model["subtitle"], 80), styles["sub"]),
        Paragraph("  |  ".join(_xml(line, 80) for line in model["meta"]), styles["meta"]),
        Spacer(1, 2 * mm),
        Paragraph(_xml(model["legend"], 500), styles["body"]),
    ]
    if model["reconciliation"]:
        story.append(Spacer(1, 1.2 * mm))
        story.append(Paragraph(_xml(model["reconciliation"], 240), styles["small"]))
    if model["notes"]:
        story.extend(_section_heading("Reading this report", styles))
        for note in model["notes"]:
            story.append(Paragraph(f"- {_xml(note, 420)}", styles["note"]))
    if model["year_kpis"]:
        story.extend(_section_heading("Year position", styles))
        story.extend(_kpi_flowables(model["year_kpis"], width, styles))
    if model["year_table"]:
        if not model["year_kpis"]:
            story.extend(_section_heading("Year position by segment", styles))
        else:
            story.append(Paragraph("By segment", styles["h"]))
        story.append(_grid_table(model["year_table"], width, styles))
        story.append(Spacer(1, 1.5 * mm))
        open_note = (
            " The last two columns are unfinished open value."
            if model["year_table"].get("open_remaining")
            else ""
        )
        story.append(Paragraph(
            "Green months are completed shipments. Amber is the current month. Blue months are still ahead."
            + open_note,
            styles["small"],
        ))
    if model["timing"]:
        story.extend(_section_heading("Completed months: shipment timing", styles))
        story.append(Paragraph(
            "Grouped by segment. Backlog delivered was shipped in the month with an earlier PO due date. On-time matches the PO due month. Early was shipped before the PO due month.",
            styles["small"],
        ))
        story.append(Spacer(1, 1.5 * mm))
        for block in model["timing"]["blocks"]:
            rows = list(block["rows"])
            if any(block["total"]):
                rows.append(block["total"])
            block_table = _data_table(
                model["timing"]["headers"],
                rows,
                list(range(1, len(model["timing"]["headers"]))),
                width,
                styles,
                first_width=28 * mm,
            )
            story.append(KeepTogether([
                Paragraph(_xml(block["label"], 24), styles["td_bold"]),
                Spacer(1, 1 * mm),
                block_table,
                Spacer(1, 2.5 * mm),
            ]))
    if model["month_kpis"]:
        label = model["month_label"] or "This month"
        story.extend(_section_heading(label, styles))
        story.extend(_kpi_flowables(model["month_kpis"], width, styles))
    if model["breakdown"]:
        table = model["breakdown"]
        story.extend(_section_heading(table["title"] or "Breakdown by PP type", styles))
        if table["subtitle"]:
            story.append(Paragraph(_xml(table["subtitle"], 180), styles["small"]))
            story.append(Spacer(1, 1.5 * mm))
        story.append(_data_table(table["headers"], table["rows"], table["numeric"], width, styles, first_width=28 * mm))
    for table in model["groups"]:
        story.extend(_section_heading(table["title"] or "Grouped", styles))
        if table["subtitle"]:
            story.append(Paragraph(_xml(table["subtitle"], 180), styles["small"]))
            story.append(Spacer(1, 1.5 * mm))
        story.append(_data_table(table["headers"], table["rows"], table["numeric"], width, styles, first_width=62 * mm))
    if model["sections"]:
        story.append(PageBreak())
        story.extend(_section_heading("Line breakdown", styles))
        story.append(Paragraph(
            "Same month, grouped by status and then by PP type. Lines inside each group are ordered by home-currency value. Use Export CSV when you need every field.",
            styles["small"],
        ))
        for section in model["sections"]:
            count = section["line_count"]
            bits = [section["title"]]
            if section["total"]:
                bits.append(section["total"])
            if count:
                bits.append(_line_count_label(count))
            story.append(Spacer(1, 3 * mm))
            story.append(Paragraph(_xml("  |  ".join(bits), 120), styles["h"]))
            if section["hint"]:
                story.append(Paragraph(_xml(section["hint"], 180), styles["small"]))
            for group in section["groups"]:
                shown = len(group["rows"])
                label = f"{group['type']}  |  {_line_count_label(shown)}"
                if group["line_count"] > shown:
                    label = (
                        f"{group['type']}  |  showing {shown} of "
                        f"{_line_count_label(group['line_count'])}"
                    )
                rows = list(group["rows"])
                if any(group["totals"]):
                    rows.append(group["totals"])
                group_table = _data_table(
                    section["columns"],
                    rows,
                    section["numeric"],
                    width,
                    styles,
                    weights=section["widths"],
                )
                story.append(Spacer(1, 2 * mm))
                story.append(CondPageBreak(28 * mm))
                story.append(Paragraph(_xml(label, 60), styles["td_bold"]))
                story.append(Spacer(1, 1 * mm))
                story.append(group_table)
            if section["truncated"]:
                story.append(Spacer(1, 1 * mm))
                story.append(Paragraph("This section was shortened for the pack. Export CSV for the full line list.", styles["small"]))
    return story


def build_sales_report_pdf(payload: dict[str, Any], *, compress: bool = True) -> tuple[bytes, str]:
    model = prepare_sales_report_pdf(payload)
    font, font_bold = _register_fonts()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=landscape(A4),
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=16 * mm,
        bottomMargin=12 * mm,
        title=f"Sales Report {model['subtitle']}",
        author="Sales Report",
    )

    def _maker(*args, **kwargs):
        kwargs["pageCompression"] = 1 if compress else 0
        return _SalesReportCanvas(
            *args,
            header_right=model["header_right"],
            footer_left=model["footer_left"],
            font=font,
            font_bold=font_bold,
            **kwargs,
        )

    doc.build(_story(model, doc.width, font, font_bold), canvasmaker=_maker)
    return buf.getvalue(), model["filename"]
