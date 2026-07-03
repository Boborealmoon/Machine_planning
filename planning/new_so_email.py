"""Detect newly posted sales orders and send notification emails."""
from __future__ import annotations

import html
import logging
import re
import threading
from datetime import datetime
from typing import Any

from .email_config import (
    EmailConfig,
    EmailTriggerConfig,
    load_email_config,
    new_so_config_issues,
    trigger_ready,
)
from .emailer import render_template, send_email
from .helpers import planner_db, rows
from .utils import PLANNER_TZ, compact_text, planner_wall_datetime_to_api

logger = logging.getLogger(__name__)

# New sales order emails only include NPS process sheets (not MPS, APS, PPS, etc.).
_EMAIL_PS_PREFIXES = frozenset({"NPS"})
_PS_PREFIX_RE = re.compile(r"^(APS|NPS|PPS|CPS|MPS|SR)", re.IGNORECASE)


def _ps_type(process_sheet_no: str) -> str:
    match = _PS_PREFIX_RE.match(compact_text(process_sheet_no))
    return match.group(1).upper() if match else ""


def _include_ps_in_email(process_sheet_no: str) -> bool:
    return _ps_type(process_sheet_no) in _EMAIL_PS_PREFIXES


def _filter_email_ps_rows(ps_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in ps_rows if _include_ps_in_email(row.get("process_sheet_no"))]

_ENSURE_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS public.planner_email_notification (
    notification_id   BIGSERIAL    PRIMARY KEY,
    trigger_type      TEXT         NOT NULL,
    sales_order_no    TEXT         NOT NULL,
    subject           TEXT         NOT NULL DEFAULT '',
    recipients        TEXT         NOT NULL DEFAULT '',
    sent_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (trigger_type, sales_order_no)
);

CREATE INDEX IF NOT EXISTS idx_planner_email_notification_sent_at
    ON public.planner_email_notification (sent_at DESC);
"""

_PENDING_NEW_SO_SQL = """
SELECT
    p.sales_order_no,
    p.first_posted_datetime,
    p.latest_posted_datetime,
    p.customer_code,
    p.reference_no,
    h.customer_name,
    h.customer_po_no,
    h.sales_person_name,
    h.sbu_desc,
    h.order_date
FROM public.so_order_posted p
LEFT JOIN public.so_order_header h
       ON h.sales_order_no = p.sales_order_no
WHERE p.first_posted_datetime >= NOW() - (%s * INTERVAL '1 day')
  AND EXISTS (
      SELECT 1
      FROM public.pp_voucher_hdr h
      WHERE h.source_voucher_no = p.sales_order_no
        AND h.pp_voucher_no ILIKE 'NPS%%'
  )
  AND NOT EXISTS (
      SELECT 1
      FROM public.planner_email_notification n
      WHERE n.trigger_type = 'new_sales_order'
        AND n.sales_order_no = p.sales_order_no
  )
ORDER BY p.first_posted_datetime ASC, p.sales_order_no ASC
"""

_SO_LINES_SQL = """
SELECT
    line_item_no,
    inventory_code,
    line_item_description,
    qty,
    required_shipment_date
FROM public.so_order_line
WHERE sales_order_no = %s
ORDER BY line_item_no
"""

_SO_PROCESS_SHEETS_SQL = """
SELECT
    h.pp_voucher_no AS process_sheet_no,
    regexp_replace(h.source_line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
    h.inventory_code AS part_no,
    h.bom_code,
    h.pp_qty AS qty,
    h.source_rsd AS po_due_date,
    h.bom_desc AS description
FROM public.pp_voucher_hdr h
WHERE h.source_voucher_no = %s
  AND h.pp_voucher_no ILIKE 'NPS%%'
ORDER BY h.source_line_item_no, h.pp_voucher_no
"""

_schema_ready = False
_schema_lock = threading.Lock()


def ensure_email_notification_schema(con) -> None:
    global _schema_ready
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        for stmt in _ENSURE_SCHEMA_SQL.split(";"):
            text = stmt.strip()
            if text:
                con.execute(text)
        _schema_ready = True


def _format_dt(value: Any) -> str:
    text = planner_wall_datetime_to_api(value)
    return text or ""


def _format_date(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return compact_text(value)


def _ps_row_fields(row: dict[str, Any]) -> dict[str, str]:
    return {
        "process_sheet_no": compact_text(row.get("process_sheet_no")),
        "part_no": compact_text(row.get("part_no")),
        "line_item_no": compact_text(row.get("line_item_no")),
        "bom_code": compact_text(row.get("bom_code")),
        "qty": "" if row.get("qty") is None else str(row.get("qty")),
        "po_due_date": _format_date(row.get("po_due_date")),
        "description": compact_text(row.get("description")),
    }


def _render_process_sheet_lines(
    trigger: EmailTriggerConfig,
    ps_rows: list[dict[str, Any]],
) -> tuple[str, str, list[str]]:
    """Return (text block, html block, list of PS numbers)."""
    if not trigger.ps_enabled:
        return "", "", []

    numbers = [
        compact_text(row.get("process_sheet_no"))
        for row in ps_rows
        if compact_text(row.get("process_sheet_no"))
    ]
    heading = trigger.ps_heading.strip()
    if not ps_rows:
        empty = f"{heading}\n  (none yet in staging)" if heading else "(no process sheets in staging)"
        html_block = ""
        if heading:
            html_block = f"<h3>{html.escape(heading)}</h3><p><em>(none yet in staging)</em></p>"
        return empty, html_block, numbers

    rendered_lines = [
        render_template(trigger.ps_line_template, **_ps_row_fields(row))
        for row in ps_rows
    ]
    text_lines = [heading, *rendered_lines] if heading else rendered_lines
    text_block = "\n".join(line for line in text_lines if line is not None)

    html_items = "".join(
        f"<li>{html.escape(line.lstrip(' -'))}</li>"
        for line in rendered_lines
        if line.strip()
    )
    html_block = ""
    if heading or html_items:
        html_block = (
            (f"<h3>{html.escape(heading)}</h3>" if heading else "")
            + f"<ul>{html_items or '<li><em>(none)</em></li>'}</ul>"
        )
    return text_block, html_block, numbers


def _build_new_so_bodies(
    order: dict[str, Any],
    lines: list[dict[str, Any]],
    ps_rows: list[dict[str, Any]],
    trigger: EmailTriggerConfig,
) -> tuple[str, str]:
    so_no = compact_text(order.get("sales_order_no"))
    ps_text, ps_html, ps_numbers = _render_process_sheet_lines(trigger, ps_rows)

    header_lines = [
        f"Sales order: {so_no}",
        f"First posted: {_format_dt(order.get('first_posted_datetime'))}",
        f"Customer: {compact_text(order.get('customer_code'))} {compact_text(order.get('customer_name'))}".strip(),
        f"Customer PO: {compact_text(order.get('customer_po_no'))}",
        f"Reference: {compact_text(order.get('reference_no'))}",
        f"Sales person: {compact_text(order.get('sales_person_name'))}",
        f"SBU: {compact_text(order.get('sbu_desc'))}",
        f"Order date: {_format_date(order.get('order_date'))}",
    ]
    if ps_text:
        header_lines.extend(["", ps_text])
    header_lines.extend(["", "Line items:"])

    if not lines:
        header_lines.append("  (no lines in staging)")
    else:
        for line in lines:
            header_lines.append(
                "  - {line_no} | {part} | qty {qty} | RSD {rsd} | {desc}".format(
                    line_no=compact_text(line.get("line_item_no")),
                    part=compact_text(line.get("inventory_code")),
                    qty=line.get("qty") or "",
                    rsd=_format_date(line.get("required_shipment_date")),
                    desc=compact_text(line.get("line_item_description")),
                )
            )
    text_body = "\n".join(header_lines)

    html_rows = "".join(
        "<tr>"
        f"<td>{html.escape(compact_text(line.get('line_item_no')))}</td>"
        f"<td>{html.escape(compact_text(line.get('inventory_code')))}</td>"
        f"<td>{line.get('qty') or ''}</td>"
        f"<td>{html.escape(_format_date(line.get('required_shipment_date')))}</td>"
        f"<td>{html.escape(compact_text(line.get('line_item_description')))}</td>"
        "</tr>"
        for line in lines
    )
    ps_count = len(ps_numbers)
    html_body = f"""
<html><body>
  <h2>New Sales Order: {html.escape(so_no)}</h2>
  <table cellpadding="4" cellspacing="0" border="0">
    <tr><td><b>First posted</b></td><td>{html.escape(_format_dt(order.get('first_posted_datetime')))}</td></tr>
    <tr><td><b>Customer</b></td><td>{html.escape(compact_text(order.get('customer_code')))} {html.escape(compact_text(order.get('customer_name')))}</td></tr>
    <tr><td><b>Customer PO</b></td><td>{html.escape(compact_text(order.get('customer_po_no')))}</td></tr>
    <tr><td><b>Reference</b></td><td>{html.escape(compact_text(order.get('reference_no')))}</td></tr>
    <tr><td><b>Sales person</b></td><td>{html.escape(compact_text(order.get('sales_person_name')))}</td></tr>
    <tr><td><b>SBU</b></td><td>{html.escape(compact_text(order.get('sbu_desc')))}</td></tr>
    <tr><td><b>Order date</b></td><td>{html.escape(_format_date(order.get('order_date')))}</td></tr>
    <tr><td><b>Process sheets</b></td><td>{ps_count} ({html.escape(', '.join(ps_numbers)) if ps_numbers else 'none yet'})</td></tr>
  </table>
  {ps_html}
  <h3>Line items</h3>
  <table cellpadding="4" cellspacing="0" border="1">
    <tr><th>Line</th><th>Part</th><th>Qty</th><th>RSD</th><th>Description</th></tr>
    {html_rows or '<tr><td colspan="5">(no lines in staging)</td></tr>'}
  </table>
</body></html>
""".strip()
    return text_body, html_body


def _record_notification(
    con,
    *,
    sales_order_no: str,
    subject: str,
    recipients: list[str],
) -> None:
    con.execute(
        """
        INSERT INTO public.planner_email_notification
            (trigger_type, sales_order_no, subject, recipients, sent_at)
        VALUES ('new_sales_order', %s, %s, %s, NOW())
        ON CONFLICT (trigger_type, sales_order_no) DO NOTHING
        """,
        (sales_order_no, subject, ", ".join(recipients)),
    )


def notify_new_sales_orders(*, cfg: EmailConfig | None = None, dry_run: bool = False) -> dict:
    """Find un-notified posted SOs and email configured recipients."""
    cfg = cfg or load_email_config(force_reload=True)
    trigger = cfg.new_sales_order
    issues = new_so_config_issues(cfg)
    if not dry_run and not trigger_ready(cfg, trigger):
        return {
            "ok": False,
            "skipped": True,
            "reason": "Cannot send — finish configuration first",
            "issues": issues,
        }

    with planner_db() as con:
        ensure_email_notification_schema(con)
        pending = rows(con.execute(_PENDING_NEW_SO_SQL, (trigger.lookback_days,)))

        sent: list[dict[str, Any]] = []
        failed: list[dict[str, Any]] = []
        for order in pending:
            so_no = compact_text(order.get("sales_order_no"))
            if not so_no:
                continue
            line_rows = rows(con.execute(_SO_LINES_SQL, (so_no,)))
            ps_rows = _filter_email_ps_rows(rows(con.execute(_SO_PROCESS_SHEETS_SQL, (so_no,))))
            if not ps_rows:
                continue
            _, _, ps_numbers = _render_process_sheet_lines(trigger, ps_rows)
            subject = render_template(trigger.subject_template, **order, process_sheets=", ".join(ps_numbers))
            body_text, body_html = _build_new_so_bodies(order, line_rows, ps_rows, trigger)
            recipients = list(trigger.recipients)

            entry = {
                "sales_order_no": so_no,
                "subject": subject,
                "process_sheet_nos": ps_numbers,
                "process_sheet_count": len(ps_numbers),
            }
            if dry_run:
                entry["dry_run"] = True
                sent.append(entry)
                continue

            result = send_email(
                to=recipients,
                cc=trigger.cc,
                bcc=trigger.bcc,
                subject=subject,
                body_text=body_text,
                body_html=body_html,
                cfg=cfg,
            )
            if result.get("ok"):
                _record_notification(con, sales_order_no=so_no, subject=subject, recipients=recipients)
                sent.append(entry)
            else:
                failed.append({**entry, "error": result.get("error")})

        if not dry_run:
            con.commit()

    return {
        "ok": not failed if not dry_run else True,
        "checked_at": datetime.now(PLANNER_TZ).isoformat(),
        "lookback_days": trigger.lookback_days,
        "pending_count": len(pending),
        "sent_count": len(sent),
        "failed_count": len(failed),
        "sent": sent,
        "failed": failed,
        "dry_run": dry_run,
        "issues": issues,
        "send_ready": trigger_ready(cfg, trigger),
        "ps_filter": "NPS only",
    }


def notify_new_sales_orders_after_sync(*, background: bool = True, dry_run: bool = False) -> dict:
    """Hook for ERP post-sync — runs in a background thread by default."""
    if background and not dry_run:
        holder: dict[str, dict] = {}

        def _worker() -> None:
            try:
                holder["result"] = notify_new_sales_orders()
            except Exception as exc:
                logger.warning("new sales order email notify failed: %s", exc, exc_info=True)
                holder["result"] = {"ok": False, "error": str(exc)}

        threading.Thread(
            target=_worker,
            name="new-so-email",
            daemon=True,
        ).start()
        return {"queued": True, "background": True}

    try:
        return notify_new_sales_orders(dry_run=dry_run)
    except Exception as exc:
        logger.warning("new sales order email notify failed: %s", exc, exc_info=True)
        return {"ok": False, "error": str(exc)}
