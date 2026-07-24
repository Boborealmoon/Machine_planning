# -*- coding: utf-8 -*-
"""Material Issue & Return Slip PDF (one consolidated slip; ops carry CNC/operator blanks)."""
from __future__ import annotations

import io
import os
from datetime import date, datetime
from typing import Any, Sequence

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from .material_bar_calc import normalize_uom, uom_label
from .utils import compact_text, parse_number

MAX_BATCH_LINES = 8

_CJK_FONT = "Helvetica"
_CJK_FONT_BOLD = "Helvetica-Bold"
_CJK_READY = False


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (
        0x4E00 <= code <= 0x9FFF
        or 0x3400 <= code <= 0x4DBF
        or 0xF900 <= code <= 0xFAFF
        or 0x3000 <= code <= 0x303F
        or 0xFF00 <= code <= 0xFFEF
    )


def _has_cjk(text: str) -> bool:
    return bool(text) and any(_is_cjk(ch) for ch in text)


def _ensure_cjk_fonts() -> None:
    global _CJK_FONT, _CJK_FONT_BOLD, _CJK_READY
    if _CJK_READY and _CJK_FONT != "Helvetica":
        return
    _CJK_READY = True
    probe = "\u7269\u6599\u53d1\u6599\u9000\u6599\u5355"

    try:
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont

        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        if pdfmetrics.stringWidth(probe, "STSong-Light", 10) > 0:
            _CJK_FONT = "STSong-Light"
            _CJK_FONT_BOLD = "STSong-Light"
            return
    except Exception:
        pass

    candidates = [
        (r"C:\Windows\Fonts\simsun.ttc", 0),
        (r"C:\Windows\Fonts\SimSun.ttc", 0),
        (r"C:\Windows\Fonts\simhei.ttf", 0),
        (r"C:\Windows\Fonts\msyh.ttc", 0),
        (r"C:\Windows\Fonts\msyh.ttf", 0),
        ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
        ("/usr/share/fonts/truetype/arphic/uming.ttc", 0),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
    ]
    for path, subfont in candidates:
        if not path or not os.path.isfile(path):
            continue
        try:
            face = "SlipCJK"
            try:
                pdfmetrics.registerFont(TTFont(face, path, subfontIndex=subfont))
            except TypeError:
                pdfmetrics.registerFont(TTFont(face, path))
            if pdfmetrics.stringWidth(probe, face, 10) <= 0:
                continue
            _CJK_FONT = face
            _CJK_FONT_BOLD = face
            return
        except Exception:
            continue

    _CJK_FONT = "Helvetica"
    _CJK_FONT_BOLD = "Helvetica-Bold"


def _font(text: str = "", *, bold: bool = False) -> str:
    _ensure_cjk_fonts()
    if _has_cjk(text):
        return _CJK_FONT_BOLD if bold else _CJK_FONT
    return "Helvetica-Bold" if bold else "Helvetica"


def _text_width(c: canvas.Canvas, text: str, size: float, *, bold: bool = False) -> float:
    font = _font(text, bold=bold)
    measured = c.stringWidth(text, font, size)
    if _has_cjk(text):
        estimated = sum(size * 0.95 if _is_cjk(ch) else size * 0.52 for ch in text)
        return max(measured, (measured + estimated) / 2.0)
    return measured


def _draw_centred(
    c: canvas.Canvas, text: str, cx: float, y: float, size: float, *, bold: bool = False
) -> None:
    font = _font(text, bold=bold)
    c.setFont(font, size)
    width = _text_width(c, text, size, bold=bold)
    c.drawString(cx - width / 2.0, y, text)


def _fmt_qty(value, digits: int = 2) -> str:
    n = parse_number(value)
    if abs(n - round(n)) < 1e-9:
        return str(int(round(n)))
    text = f"{n:.{digits}f}".rstrip("0").rstrip(".")
    return text or "0"


def _batch_lines(batches: Sequence[dict[str, Any]] | None, uom: str) -> list[dict[str, str]]:
    """Normalize issued batches into neat {batch_no, qty} rows for the slip."""
    unit = uom_label(uom)
    lines: list[dict[str, str]] = []
    for batch in batches or []:
        batch_no = compact_text(batch.get("batch_no"))
        qty = parse_number(batch.get("length_mm") or batch.get("qty"))
        if not batch_no and qty <= 0:
            continue
        lines.append(
            {
                "batch_no": batch_no or "-",
                "qty": f"{_fmt_qty(qty)} {unit}" if qty > 0 else "",
            }
        )
    return lines


def parse_slip_date(raw) -> date:
    """Accept date / datetime / YYYY-MM-DD string; default today."""
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    text = compact_text(raw)
    if text:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            pass
    return date.today()


def _dotted_line(c: canvas.Canvas, x: float, y: float, width: float, *, thick: bool = False) -> None:
    c.setDash(1.6, 2.2)
    c.setStrokeColorRGB(0.12, 0.12, 0.12) if thick else c.setStrokeColorRGB(0.22, 0.22, 0.22)
    c.setLineWidth(1.55 if thick else 1.15)
    c.line(x, y, x + width, y)
    c.setDash()
    c.setLineWidth(1.0)


def _fit_text(c: canvas.Canvas, text: str, font: str, size: float, max_w: float) -> str:
    if not text:
        return ""
    out = text
    while out and c.stringWidth(out, font, size) > max_w:
        out = out[:-1]
    if out != text and out:
        out = out[:-1] + "..."
    return out


def _draw_field(
    c: canvas.Canvas,
    label: str,
    value: str,
    x: float,
    y: float,
    width: float,
    *,
    font_size: float = 8.0,
    bold: bool = False,
    label_width: float | None = None,
) -> float:
    label_font = _font(label, bold=bold)
    value_font = _font(value, bold=bold)
    c.setFont(label_font, font_size)
    c.setFillColorRGB(0.08, 0.08, 0.08)
    c.drawString(x, y, label)
    lw = label_width if label_width is not None else _text_width(c, label, font_size, bold=bold) + 4
    value_x = x + lw
    line_w = max(16, width - lw)
    _dotted_line(c, value_x, y - 1.4, line_w, thick=True)
    if value:
        size = font_size + (0.4 if bold else 0)
        c.setFont(value_font, size)
        text = _fit_text(c, value, value_font, size, line_w - 2)
        c.drawString(value_x + 1, y + 1.2, text)
    return y - (font_size + (10.5 if bold else 9.0))


def _section_title(c: canvas.Canvas, text: str, x: float, y: float) -> float:
    c.setFillColorRGB(0.08, 0.08, 0.08)
    c.setFont(_font(text, bold=True), 8.2)
    c.drawString(x, y, text)
    return y - 15


def _draw_batch_block(
    c: canvas.Canvas,
    *,
    x: float,
    y: float,
    width: float,
    batches: Sequence[dict[str, str]],
) -> float:
    """Draw Batch No label + one neat line per batch (no semicolon soup)."""
    label = "Batch No:"
    c.setFont("Helvetica", 8.0)
    c.setFillColorRGB(0.08, 0.08, 0.08)
    c.drawString(x, y, label)
    cy = y - 14

    rows = list(batches or [])
    if not rows:
        _dotted_line(c, x, cy - 1.4, width, thick=True)
        return cy - 15

    shown = rows[:MAX_BATCH_LINES]
    extra = len(rows) - len(shown)
    for row in shown:
        batch_no = compact_text(row.get("batch_no"))
        qty = compact_text(row.get("qty"))
        c.setFont("Helvetica", 8.0)
        left = _fit_text(c, batch_no, "Helvetica", 8.0, width * 0.58)
        c.drawString(x + 2, cy, left)
        if qty:
            qw = c.stringWidth(qty, "Helvetica", 8.0)
            c.drawRightString(
                x + width - 2,
                cy,
                qty if qw <= width * 0.38 else _fit_text(c, qty, "Helvetica", 8.0, width * 0.38),
            )
        _dotted_line(c, x, cy - 1.6, width, thick=True)
        cy -= 15

    if extra > 0:
        c.setFont("Helvetica-Oblique", 7.0)
        c.setFillColorRGB(0.35, 0.35, 0.35)
        c.drawString(x + 2, cy, f"+{extra} more batch(es)")
        cy -= 12

    return cy - 4


def _op_label(op: dict[str, Any]) -> str:
    op_no = op.get("op_no")
    if op_no is not None and str(op_no).strip() != "":
        return f"Operation {op_no}  /  \u5de5\u5e8f {op_no}"
    label = compact_text(op.get("operation_label"))
    return label or "Operation -"


def _draw_operation_row(
    c: canvas.Canvas,
    *,
    op: dict[str, Any],
    x: float,
    y: float,
    width: float,
) -> float:
    """One production row: Operation N | CNC blank | Operator blank."""
    label = _op_label(op)
    font_size = 8.0
    gap = 10.0
    cnc_label = "CNC / \u673a\u53f0\u53f7:"
    op_label_text = "Operator / \u64cd\u4f5c\u5458:"
    cnc_value = compact_text(op.get("cnc"))
    operator_value = compact_text(op.get("operator"))

    # Op label takes ~28%, then CNC and Operator share the rest.
    op_w = width * 0.28
    rest_w = width - op_w - gap
    field_w = (rest_w - gap) / 2.0

    c.setFillColorRGB(0.08, 0.08, 0.08)
    c.setFont(_font(label, bold=True), font_size)
    fitted = _fit_text(c, label, _font(label, bold=True), font_size, op_w - 2)
    c.drawString(x, y, fitted)

    cnc_x = x + op_w + gap
    _draw_field(c, cnc_label, cnc_value, cnc_x, y, field_w, font_size=font_size)

    op_x = cnc_x + field_w + gap
    _draw_field(c, op_label_text, operator_value, op_x, y, field_w, font_size=font_size)
    return y - (font_size + 14)


def _estimate_slip_height(slip: dict[str, Any], inner_w: float) -> float:
    """Rough content height so the border fits the form."""
    batches = list(slip.get("issue_batches") or [])
    ops = list(slip.get("operations") or [])
    batch_rows = min(len(batches), MAX_BATCH_LINES) or 1
    extra = 1 if len(batches) > MAX_BATCH_LINES else 0
    # title + header fields + sections + batches + ops + padding (roomier spacing)
    h = (
        34  # titles
        + 3 * 18  # date / ps / material
        + 18  # issuance title
        + 16  # batch label
        + batch_rows * 15
        + extra * 12
        + 2 * 18  # issued + target used
        + 18  # return title
        + 2 * 18  # return batch + target
        + 18  # production title
        + max(1, len(ops)) * 24
        + 36  # padding
    )
    return max(h, 110 * mm)


def _draw_slip(
    c: canvas.Canvas,
    *,
    x: float,
    y: float,
    width: float,
    height: float,
    slip: dict[str, Any],
) -> None:
    pad = 5.5 * mm
    inner_x = x + pad
    inner_w = width - 2 * pad
    top = y + height - pad

    c.setDash(2.5, 2)
    c.setStrokeColorRGB(0.35, 0.35, 0.35)
    c.setLineWidth(1.2)
    c.rect(x + 1.2 * mm, y + 1.2 * mm, width - 2.4 * mm, height - 2.4 * mm, stroke=1, fill=0)
    c.setDash()

    title_en = "MATERIAL ISSUE & RETURN SLIP"
    title_zh = "\u7269\u6599\u53d1\u6599\u4e0e\u9000\u6599\u5355"
    _draw_centred(c, title_en, x + width / 2, top - 1, 11, bold=True)
    title_w = _text_width(c, title_en, 11, bold=True)
    c.setStrokeColorRGB(0.08, 0.08, 0.08)
    c.setLineWidth(1.3)
    c.line(x + (width - title_w) / 2, top - 3.0, x + (width + title_w) / 2, top - 3.0)
    _draw_centred(c, title_zh, x + width / 2, top - 16, 9, bold=True)

    cy = top - 36
    cy = _draw_field(c, "Date / \u65e5\u671f:", compact_text(slip.get("date")), inner_x, cy, inner_w)
    cy = _draw_field(c, "PS No:", compact_text(slip.get("ps_batch")), inner_x, cy, inner_w)
    cy = _draw_field(
        c,
        "Material / \u7269\u6599:",
        compact_text(slip.get("material_spec")),
        inner_x,
        cy,
        inner_w,
    )

    cy -= 6
    cy = _section_title(c, "[ ISSUANCE / \u53d1\u6599 ]", inner_x, cy)
    cy = _draw_batch_block(
        c,
        x=inner_x,
        y=cy,
        width=inner_w,
        batches=slip.get("issue_batches") or [],
    )
    issued_label = "Issued Qty sub total / \u53d1\u6599\u5c0f\u8ba1:"
    cy = _draw_field(
        c,
        issued_label,
        compact_text(slip.get("issued_subtotal")),
        inner_x,
        cy,
        inner_w,
        bold=True,
        label_width=_text_width(c, issued_label, 8.0, bold=True) + 4,
    )
    used_label = "Target Used / \u76ee\u6807\u7528\u91cf:"
    cy = _draw_field(
        c,
        used_label,
        compact_text(slip.get("issuable_total")),
        inner_x,
        cy,
        inner_w,
        label_width=_text_width(c, used_label, 8.0) + 4,
    )

    cy -= 6
    cy = _section_title(c, "[ RETURN / \u9000\u6599 ]", inner_x, cy)
    cy = _draw_field(c, "Batch No:", "", inner_x, cy, inner_w)
    ret_label = "TARGET Return / \u5e94\u9000\u76ee\u6807:"
    cy = _draw_field(
        c,
        ret_label,
        compact_text(slip.get("returnable_total")),
        inner_x,
        cy,
        inner_w,
        bold=True,
        font_size=8.4,
        label_width=_text_width(c, ret_label, 8.4, bold=True) + 4,
    )

    cy -= 6
    cy = _section_title(c, "[ PRODUCTION / \u751f\u4ea7 ]", inner_x, cy)
    ops = list(slip.get("operations") or [])
    if not ops:
        ops = [{"op_no": None, "operation_label": "Operation -"}]
    for op in ops:
        cy = _draw_operation_row(c, op=op, x=inner_x, y=cy, width=inner_w)


def build_slip_payload(
    *,
    date_text: str,
    planner_ps_id: str,
    material_spec: str,
    issued_subtotal: str,
    issuable_total: str,
    returnable_total: str,
    issue_batches: Sequence[dict[str, str]],
    operations: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    """Build one consolidated slip payload (shared issue/return; ops list for CNC/operator)."""
    ops = list(operations) if operations else [{"op_no": None, "operation_label": "Operation -"}]
    normalized: list[dict[str, Any]] = []
    for op in ops:
        op_no = op.get("op_no")
        label = compact_text(op.get("operation_label"))
        if not label:
            if op_no is not None and str(op_no).strip() != "":
                label = f"Operation {op_no}"
            else:
                label = "Operation -"
        normalized.append(
            {
                "op_no": op_no,
                "operation_label": label,
                "stage_desc": compact_text(op.get("stage_desc")),
                "cnc": compact_text(op.get("cnc")),
                "operator": compact_text(op.get("operator")),
            }
        )
    return {
        "date": date_text,
        "ps_batch": planner_ps_id,
        "material_spec": material_spec,
        "issue_batches": list(issue_batches),
        "issued_subtotal": issued_subtotal,
        "issuable_total": issuable_total,
        "returnable_total": returnable_total,
        "operations": normalized,
    }


def build_slip_payloads(
    *,
    date_text: str,
    planner_ps_id: str,
    material_spec: str,
    issued_subtotal: str,
    issuable_total: str,
    returnable_total: str,
    issue_batches: Sequence[dict[str, str]],
    operations: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Back-compat wrapper: returns a single-item list with the consolidated slip."""
    return [
        build_slip_payload(
            date_text=date_text,
            planner_ps_id=planner_ps_id,
            material_spec=material_spec,
            issued_subtotal=issued_subtotal,
            issuable_total=issuable_total,
            returnable_total=returnable_total,
            issue_batches=issue_batches,
            operations=operations,
        )
    ]


def _normalize_slip_list(
    slip: dict[str, Any] | Sequence[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    if slip is None:
        return []
    if isinstance(slip, dict):
        return [slip]
    if isinstance(slip, Sequence) and not isinstance(slip, (str, bytes)):
        return [item for item in slip if isinstance(item, dict)]
    return []


def generate_material_issue_slip_pdf(slip: dict[str, Any] | Sequence[dict[str, Any]]) -> bytes:
    """Render material slips stacked top-to-bottom (one slip per material)."""
    _ensure_cjk_fonts()
    payloads = _normalize_slip_list(slip)
    if not payloads:
        payloads = [
            build_slip_payload(
                date_text=date.today().isoformat(),
                planner_ps_id="",
                material_spec="",
                issued_subtotal="",
                issuable_total="",
                returnable_total="",
                issue_batches=[],
                operations=[],
            )
        ]

    buf = io.BytesIO()
    page_w, page_h = A4
    margin_x = 12 * mm
    margin_y = 12 * mm
    gap_y = 5 * mm
    slip_w = page_w - 2 * margin_x
    max_slip_h = page_h - 2 * margin_y

    c = canvas.Canvas(buf, pagesize=A4)
    cursor_y = page_h - margin_y
    page_started = False

    for payload in payloads:
        slip_h = min(_estimate_slip_height(payload, slip_w - 10 * mm), max_slip_h)
        # New page when this slip won't fit below the previous one.
        if page_started and cursor_y - slip_h < margin_y:
            c.showPage()
            cursor_y = page_h - margin_y
            page_started = False
        if page_started:
            cursor_y -= gap_y
        sy = cursor_y - slip_h
        _draw_slip(c, x=margin_x, y=sy, width=slip_w, height=slip_h, slip=payload)
        cursor_y = sy
        page_started = True

    c.showPage()
    c.save()
    return buf.getvalue()


def _record_to_slip_payload(
    record: dict[str, Any],
    operations: Sequence[dict[str, Any]],
    *,
    slip_date: date | None = None,
) -> dict[str, Any]:
    uom = normalize_uom(record.get("material_uom"))
    unit = uom_label(uom)
    batches = record.get("issued_batches") or []
    issue_batches = _batch_lines(batches, uom)
    material = compact_text(record.get("material_type_grade")) or compact_text(
        record.get("material_inventory_code")
    )
    issued_qty = sum(parse_number(b.get("length_mm") or b.get("qty")) for b in batches)
    if issued_qty <= 0:
        issued_qty = parse_number(record.get("issued_total_mm"))
    issued_subtotal = f"{_fmt_qty(issued_qty)} {unit}".strip()
    issuable = f"{_fmt_qty(record.get('target_total_mm'))} {unit}".strip()
    returnable = f"{_fmt_qty(record.get('returnable_mm'))} {unit}".strip()

    resolved = slip_date or parse_slip_date(record.get("slip_date"))
    date_text = resolved.strftime("%Y-%m-%d")
    ps_id = compact_text(record.get("planner_ps_id"))

    assign_by_op: dict[str, dict[str, str]] = {}
    for row in record.get("op_assignments") or []:
        if not isinstance(row, dict):
            continue
        key = compact_text(row.get("op_no"))
        if not key:
            continue
        assign_by_op[key] = {
            "cnc": compact_text(row.get("cnc")),
            "operator": compact_text(row.get("operator")),
        }

    ops_out: list[dict[str, Any]] = []
    for op in operations or []:
        op_no = op.get("op_no")
        key = compact_text(op_no)
        saved = assign_by_op.get(key) or {}
        ops_out.append(
            {
                **dict(op),
                "cnc": saved.get("cnc") or compact_text(op.get("cnc")),
                "operator": saved.get("operator") or compact_text(op.get("operator")),
            }
        )

    return build_slip_payload(
        date_text=date_text,
        planner_ps_id=ps_id,
        material_spec=material,
        issued_subtotal=issued_subtotal,
        issuable_total=issuable,
        returnable_total=returnable,
        issue_batches=issue_batches,
        operations=ops_out,
    )


def slip_pdf_from_calc_records(
    records: Sequence[dict[str, Any]],
    operations: Sequence[dict[str, Any]],
    *,
    slip_date: date | None = None,
) -> tuple[bytes, str]:
    """One slip per material record, stacked top-to-bottom on the PDF."""
    slips: list[dict[str, Any]] = []
    ps_id = ""
    for record in records or []:
        if not record:
            continue
        if not ps_id:
            ps_id = compact_text(record.get("planner_ps_id"))
        slips.append(_record_to_slip_payload(record, operations, slip_date=slip_date))
    if not slips:
        slips = [
            build_slip_payload(
                date_text=(slip_date or date.today()).isoformat(),
                planner_ps_id="",
                material_spec="",
                issued_subtotal="",
                issuable_total="",
                returnable_total="",
                issue_batches=[],
                operations=operations,
            )
        ]
    pdf = generate_material_issue_slip_pdf(slips)
    safe_ps = ps_id.replace("/", "-").replace("::", "_") or "PS"
    filename = f"Material_Issue_Return_Slip_{safe_ps}.pdf"
    return pdf, filename


def slip_pdf_from_calc_record(
    record: dict[str, Any],
    operations: Sequence[dict[str, Any]],
    *,
    slip_date: date | None = None,
) -> tuple[bytes, str]:
    return slip_pdf_from_calc_records([record], operations, slip_date=slip_date)
