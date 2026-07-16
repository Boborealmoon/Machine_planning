"""Accounts receivable - credit notes (ar_crn_* tables), isolated from planner."""
from __future__ import annotations

import logging
import os
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from flask import Blueprint, jsonify, redirect, render_template, request, url_for

from .staged_erp import live_query, serialize_row
from .utils import compact_text

logger = logging.getLogger(__name__)

_DEFAULT_ACCOUNTS_PATH = "/accounts"
Bucket = Literal["new", "outstanding", "posted"]

_CACHE_TTL_SEC = 300
_CACHE_VERSION = 2
_list_cache: dict[str, tuple[float, int, list[dict[str, Any]]]] = {}
_soa_periods_cache: tuple[float, int, list[dict[str, Any]]] | None = None
_SOA_CACHE_VERSION = 1

_CREDIT_NOTE_TYPE_LABELS = {
    "D": "Debit",
    "C": "Credit",
}

_NEW_HDR_SQL = """
SELECT
    h.credit_note_no,
    h.customer_code,
    COALESCE(NULLIF(TRIM(c.customer_name), ''), '') AS customer_name,
    h.credit_note_date,
    h.credit_note_type,
    h.crn_category_code,
    h.currency_code,
    h.exch_rate,
    h.reference_no,
    h.customer_po_no,
    h.sales_person_code,
    h.sbu_code,
    h.source_voucher_no,
    h.request_no,
    h.location_code,
    h.credit_note_justification,
    h.remarks_to_customer,
    h.payment_option_code,
    h.billing_party_code,
    h.sales_tax_code,
    h.project_no,
    h.total_disc_amt,
    h.total_pre_tax_amt,
    h.total_pre_tax_home_amt,
    h.total_sales_tax_amt,
    h.total_after_tax_amt,
    h.total_after_tax_home_amt,
    h.unposted_applied_inv_amt,
    h.applicable_amt,
    h.reversed_invoice_no,
    h.remarks,
    h.external_remarks,
    h.created_by,
    h.created_datetime,
    h.last_updated_datetime,
    NULL::timestamp AS posted_datetime,
    NULL::text AS posted_by,
    NULL::double precision AS total_applied_inv_amt,
    NULL::double precision AS total_applied_pymt_amt,
    COALESCE(lc.line_count, 0) AS line_count
FROM public.ar_crn_new_hdr h
LEFT JOIN public.mfg_mes_customer_view c
       ON c.customer_code = h.customer_code
LEFT JOIN (
    SELECT credit_note_no, COUNT(*)::int AS line_count
    FROM public.ar_crn_new_det
    GROUP BY credit_note_no
) lc ON lc.credit_note_no = h.credit_note_no
ORDER BY h.credit_note_date DESC NULLS LAST, h.credit_note_no DESC
"""

_OST_HDR_SQL = """
SELECT
    h.credit_note_no,
    h.customer_code,
    COALESCE(NULLIF(TRIM(c.customer_name), ''), '') AS customer_name,
    h.credit_note_date,
    h.credit_note_type,
    h.crn_category_code,
    h.currency_code,
    h.exch_rate,
    h.reference_no,
    h.customer_po_no,
    h.sales_person_code,
    h.sbu_code,
    NULL::character varying AS source_voucher_no,
    NULL::character varying AS request_no,
    h.location_code,
    h.credit_note_justification,
    h.remarks_to_customer,
    NULL::character varying AS payment_option_code,
    NULL::character varying AS billing_party_code,
    h.sales_tax_code,
    h.project_no,
    NULL::double precision AS total_disc_amt,
    NULL::double precision AS total_pre_tax_amt,
    NULL::double precision AS total_pre_tax_home_amt,
    NULL::double precision AS total_sales_tax_amt,
    h.total_after_tax_amt,
    h.total_after_tax_home_amt,
    h.unposted_applied_inv_amt,
    h.applicable_amt,
    h.reversed_invoice_no,
    h.remarks,
    h.external_remarks,
    h.created_by,
    h.created_datetime,
    h.last_updated_datetime,
    h.application_date AS posted_datetime,
    NULL::text AS posted_by,
    h.total_applied_inv_amt,
    h.total_applied_pymt_amt,
    COALESCE(lc.line_count, 0) AS line_count
FROM public.ar_crn_ost_hdr h
LEFT JOIN public.mfg_mes_customer_view c
       ON c.customer_code = h.customer_code
LEFT JOIN (
    SELECT credit_note_no, COUNT(*)::int AS line_count
    FROM public.ar_crn_hst_det
    GROUP BY credit_note_no
) lc ON lc.credit_note_no = h.credit_note_no
ORDER BY h.credit_note_date DESC NULLS LAST, h.credit_note_no DESC
"""

_POSTED_HDR_SQL = """
SELECT
    h.credit_note_no,
    h.customer_code,
    COALESCE(
        NULLIF(TRIM(h.customer_name), ''),
        NULLIF(TRIM(c.customer_name), ''),
        ''
    ) AS customer_name,
    h.credit_note_date,
    h.credit_note_type,
    h.crn_category_code,
    h.currency_code,
    h.exch_rate,
    h.reference_no,
    h.customer_po_no,
    h.sales_person_code,
    h.sbu_code,
    h.source_voucher_no,
    h.request_no,
    h.location_code,
    h.credit_note_justification,
    h.remarks_to_customer,
    h.payment_option_code,
    h.billing_party_code,
    h.sales_tax_code,
    h.project_no,
    h.total_disc_amt,
    h.total_pre_tax_amt,
    h.total_pre_tax_home_amt,
    h.total_sales_tax_amt,
    h.total_after_tax_amt,
    h.total_after_tax_home_amt,
    NULL::double precision AS unposted_applied_inv_amt,
    NULL::double precision AS applicable_amt,
    h.reversed_invoice_no,
    h.remarks,
    h.external_remarks,
    h.created_by,
    h.created_datetime,
    h.last_updated_datetime,
    h.posted_datetime,
    h.posted_by,
    h.total_applied_inv_amt,
    h.total_applied_pymt_amt,
    COALESCE(lc.line_count, 0) AS line_count
FROM public.ar_crn_hst_hdr h
LEFT JOIN public.mfg_mes_customer_view c
       ON c.customer_code = h.customer_code
LEFT JOIN (
    SELECT credit_note_no, COUNT(*)::int AS line_count
    FROM public.ar_crn_hst_det
    GROUP BY credit_note_no
) lc ON lc.credit_note_no = h.credit_note_no
ORDER BY h.posted_datetime DESC NULLS LAST, h.credit_note_date DESC NULLS LAST, h.credit_note_no DESC
"""

_NEW_HDR_ONE_SQL = """
SELECT
    h.*,
    COALESCE(NULLIF(TRIM(c.customer_name), ''), '') AS customer_name,
    NULL::timestamp AS posted_datetime,
    NULL::text AS posted_by
FROM public.ar_crn_new_hdr h
LEFT JOIN public.mfg_mes_customer_view c
       ON c.customer_code = h.customer_code
WHERE h.credit_note_no = %s
"""

_OST_HDR_ONE_SQL = """
SELECT
    h.*,
    COALESCE(NULLIF(TRIM(c.customer_name), ''), '') AS customer_name,
    h.application_date AS posted_datetime,
    NULL::text AS posted_by
FROM public.ar_crn_ost_hdr h
LEFT JOIN public.mfg_mes_customer_view c
       ON c.customer_code = h.customer_code
WHERE h.credit_note_no = %s
"""

_POSTED_HDR_ONE_SQL = """
SELECT
    h.*,
    COALESCE(
        NULLIF(TRIM(h.customer_name), ''),
        NULLIF(TRIM(c.customer_name), ''),
        ''
    ) AS customer_name
FROM public.ar_crn_hst_hdr h
LEFT JOIN public.mfg_mes_customer_view c
       ON c.customer_code = h.customer_code
WHERE h.credit_note_no = %s
"""

_NEW_DET_SQL = """
SELECT *
FROM public.ar_crn_new_det
WHERE credit_note_no = %s
ORDER BY line_item_no NULLS LAST, seq_no NULLS LAST
"""

_HST_DET_SQL = """
SELECT *
FROM public.ar_crn_hst_det
WHERE credit_note_no = %s
ORDER BY line_item_no NULLS LAST, seq_no NULLS LAST
"""

_BUCKET_HDR_SQL: dict[Bucket, str] = {
    "new": _NEW_HDR_SQL,
    "outstanding": _OST_HDR_SQL,
    "posted": _POSTED_HDR_SQL,
}

_BUCKET_HDR_ONE_SQL: dict[Bucket, str] = {
    "new": _NEW_HDR_ONE_SQL,
    "outstanding": _OST_HDR_ONE_SQL,
    "posted": _POSTED_HDR_ONE_SQL,
}

_BUCKET_DET_SQL: dict[Bucket, str] = {
    "new": _NEW_DET_SQL,
    "outstanding": _HST_DET_SQL,
    "posted": _HST_DET_SQL,
}

_BUCKET_LABELS: dict[Bucket, str] = {
    "new": "New",
    "outstanding": "Outstanding",
    "posted": "Posted",
}

_SOA_PERIODS_SQL = """
SELECT
    financial_year,
    financial_period,
    MAX(period_closing_date) AS period_closing_date,
    COUNT(DISTINCT customer_code) AS customer_count,
    COUNT(*) AS line_count
FROM public.cust_soa_std
GROUP BY financial_year, financial_period
ORDER BY financial_year DESC, financial_period DESC
"""

_SOA_CUSTOMERS_SQL = """
SELECT DISTINCT ON (customer_code, currency_code)
    customer_code,
    party_name,
    currency_code,
    currency_desc,
    period_closing_date,
    current_balance AS closing_balance,
    financial_year,
    financial_period
FROM public.cust_soa_std
WHERE financial_year = %s
  AND financial_period = %s
ORDER BY customer_code, currency_code, voucher_date DESC NULLS LAST
"""

_SOA_STATEMENT_SQL = """
SELECT *
FROM public.cust_soa_std
WHERE customer_code = %s
  AND currency_code = %s
  AND financial_year = %s
  AND financial_period = %s
ORDER BY
    voucher_date ASC NULLS LAST,
    invoice_no ASC NULLS LAST,
    credit_note_no ASC NULLS LAST,
    voucher_no ASC NULLS LAST
"""

_TP_LABELS = {
    ("IN", ""): "Invoice",
    ("IN", "CN"): "Credit note applied",
    ("CN", ""): "Credit note",
}


def accounts_path() -> str:
    raw = (os.getenv("ACCOUNTS_PATH") or _DEFAULT_ACCOUNTS_PATH).strip()
    if not raw.startswith("/"):
        raw = "/" + raw
    if len(raw) > 1 and raw.endswith("/"):
        raw = raw.rstrip("/")
    return raw


ACCOUNTS_PATH = accounts_path()


def accounts_asset_version() -> str:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    watch = (
        os.path.join(root, "static", "js", "accounts.js"),
        os.path.join(root, "static", "css", "accounts.css"),
    )
    try:
        mt = max(os.path.getmtime(path) for path in watch)
        return f"accounts-{int(mt)}"
    except OSError:
        return "accounts-dev"


accounts_bp = Blueprint("accounts", __name__)


def _bucket(raw: str | None) -> Bucket:
    text = compact_text(raw).lower()
    if text in {"outstanding", "ost", "open"}:
        return "outstanding"
    if text in {"posted", "history", "hst", "hist"}:
        return "posted"
    if text in {"new", "draft"}:
        return "new"
    return "posted"


def _amount(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _date_only(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    if not text:
        return None
    return text[:10] if len(text) >= 10 else text


def _enrich_header(row: dict[str, Any], *, bucket: Bucket) -> dict[str, Any]:
    out = serialize_row(row)
    out["bucket"] = bucket
    out["bucket_label"] = _BUCKET_LABELS[bucket]
    out["credit_note_date"] = _date_only(out.get("credit_note_date"))
    out["posted_date"] = _date_only(out.get("posted_datetime"))
    cn_type = compact_text(out.get("credit_note_type")).upper()
    out["credit_note_type_label"] = _CREDIT_NOTE_TYPE_LABELS.get(cn_type, cn_type or "-")
    out["total_after_tax_amt"] = _amount(out.get("total_after_tax_amt"))
    out["total_pre_tax_amt"] = _amount(out.get("total_pre_tax_amt"))
    out["total_applied_inv_amt"] = _amount(out.get("total_applied_inv_amt"))
    out["unposted_applied_inv_amt"] = _amount(out.get("unposted_applied_inv_amt"))
    out["line_count"] = int(out.get("line_count") or 0)
    return out


def _enrich_line(row: dict[str, Any]) -> dict[str, Any]:
    out = serialize_row(row)
    for key in (
        "qty",
        "display_qty",
        "base_unit_selling_price",
        "display_unit_price",
        "pre_tax_extended_amt",
        "sales_tax_amt",
        "discount_amt",
        "base_extended_amt",
    ):
        if key in out:
            out[key] = _amount(out.get(key))
    out["line_item_no"] = out.get("line_item_no")
    return out


def _fetch_headers(bucket: Bucket, *, refresh: bool = False) -> list[dict[str, Any]]:
    cache_key = bucket
    now = time.time()
    cached = _list_cache.get(cache_key)
    if (
        not refresh
        and cached
        and cached[1] == _CACHE_VERSION
        and now - cached[0] < _CACHE_TTL_SEC
    ):
        return cached[2]

    sql = _BUCKET_HDR_SQL[bucket]
    try:
        raw_rows = live_query(sql)
    except Exception:
        logger.exception("accounts: failed to load %s credit note headers", bucket)
        raise

    rows_out = [_enrich_header(row, bucket=bucket) for row in raw_rows]
    _list_cache[cache_key] = (now, _CACHE_VERSION, rows_out)
    return rows_out


def _summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    currencies: dict[str, float] = {}
    customers: set[str] = set()
    for row in rows:
        code = compact_text(row.get("currency_code")) or "-"
        currencies[code] = currencies.get(code, 0.0) + _amount(row.get("total_after_tax_amt"))
        cust = compact_text(row.get("customer_code"))
        if cust:
            customers.add(cust)
    return {
        "count": len(rows),
        "customer_count": len(customers),
        "currency_totals": [
            {"currency_code": code, "total_after_tax_amt": round(total, 2)}
            for code, total in sorted(currencies.items())
        ],
    }


def _filter_rows(
    rows: list[dict[str, Any]],
    *,
    q: str,
    customer: str,
    currency: str,
    date_from: str,
    date_to: str,
) -> list[dict[str, Any]]:
    needle = compact_text(q).lower()
    cust_needle = compact_text(customer).lower()
    curr = compact_text(currency).upper()

    def _match(row: dict[str, Any]) -> bool:
        if curr and compact_text(row.get("currency_code")).upper() != curr:
            return False
        if cust_needle:
            hay = " ".join(
                compact_text(row.get(key))
                for key in ("customer_code", "customer_name")
            ).lower()
            if cust_needle not in hay:
                return False
        if date_from:
            row_date = _date_only(row.get("credit_note_date")) or ""
            if row_date < date_from:
                return False
        if date_to:
            row_date = _date_only(row.get("credit_note_date")) or ""
            if row_date > date_to:
                return False
        if needle:
            hay = " ".join(
                compact_text(row.get(key))
                for key in (
                    "credit_note_no",
                    "customer_code",
                    "customer_name",
                    "customer_po_no",
                    "reference_no",
                    "source_voucher_no",
                    "reversed_invoice_no",
                    "remarks",
                )
            ).lower()
            if needle not in hay:
                return False
        return True

    return [row for row in rows if _match(row)]


def invalidate_accounts_cache() -> None:
    global _soa_periods_cache
    _list_cache.clear()
    _soa_periods_cache = None


def _soa_transaction_label(tp: str, apl_tp: str) -> str:
    key = (compact_text(tp).upper(), compact_text(apl_tp).upper())
    if key in _TP_LABELS:
        return _TP_LABELS[key]
    parts = [compact_text(tp), compact_text(apl_tp)]
    label = " / ".join(part for part in parts if part)
    return label or "-"


def _soa_document_no(row: dict[str, Any]) -> str:
    for key in (
        "invoice_no",
        "credit_note_no",
        "receipt_voucher_no",
        "contra_voucher_no",
        "voucher_no",
    ):
        text = compact_text(row.get(key))
        if text:
            return text
    return "-"


def _enrich_soa_line(row: dict[str, Any]) -> dict[str, Any]:
    out = serialize_row(row)
    tp = compact_text(out.get("tp")).upper()
    apl_tp = compact_text(out.get("apl_tp")).upper()
    debit = _amount(out.get("debit"))
    voucher_amt = _amount(out.get("voucher_amt"))
    out["transaction_type"] = _soa_transaction_label(tp, apl_tp)
    out["document_no"] = _soa_document_no(out)
    out["voucher_date"] = _date_only(out.get("voucher_date"))
    out["due_date"] = _date_only(out.get("due_date"))
    out["debit_amt"] = debit if debit > 0 else None
    if debit > 0:
        out["credit_amt"] = None
    elif voucher_amt > 0:
        out["credit_amt"] = voucher_amt
    else:
        out["credit_amt"] = None
    out["balance"] = _amount(out.get("current_balance"))
    out["voucher_amt"] = voucher_amt
    out["previous_balance"] = _amount(out.get("previous_balance"))
    out["current_balance"] = _amount(out.get("current_balance"))
    return out


def _fetch_soa_periods(*, refresh: bool = False) -> list[dict[str, Any]]:
    global _soa_periods_cache
    now = time.time()
    if (
        not refresh
        and _soa_periods_cache
        and _soa_periods_cache[1] == _SOA_CACHE_VERSION
        and now - _soa_periods_cache[0] < _CACHE_TTL_SEC
    ):
        return _soa_periods_cache[2]

    rows = live_query(_SOA_PERIODS_SQL)
    out: list[dict[str, Any]] = []
    for row in rows:
        item = serialize_row(row)
        item["period_closing_date"] = _date_only(item.get("period_closing_date"))
        item["label"] = f"{item.get('financial_year')}/{int(item.get('financial_period') or 0):02d}"
        out.append(item)
    _soa_periods_cache = (now, _SOA_CACHE_VERSION, out)
    return out


def _filter_soa_customers(
    rows: list[dict[str, Any]],
    *,
    q: str,
    currency: str,
) -> list[dict[str, Any]]:
    needle = compact_text(q).lower()
    curr = compact_text(currency).upper()

    def _match(row: dict[str, Any]) -> bool:
        if curr and compact_text(row.get("currency_code")).upper() != curr:
            return False
        if needle:
            hay = " ".join(
                compact_text(row.get(key))
                for key in ("customer_code", "party_name")
            ).lower()
            if needle not in hay:
                return False
        return True

    return [row for row in rows if _match(row)]


def _enrich_soa_customer(row: dict[str, Any]) -> dict[str, Any]:
    out = serialize_row(row)
    out["period_closing_date"] = _date_only(out.get("period_closing_date"))
    out["closing_balance"] = _amount(out.get("closing_balance"))
    return out


def _build_soa_statement(
    rows: list[dict[str, Any]],
    *,
    customer_code: str,
    currency_code: str,
    financial_year: int,
    financial_period: int,
) -> dict[str, Any]:
    lines = [_enrich_soa_line(row) for row in rows]
    header_row = rows[0] if rows else {}
    header = serialize_row(header_row)
    opening_balance = _amount(lines[0].get("previous_balance")) if lines else 0.0
    closing_balance = _amount(lines[-1].get("current_balance")) if lines else 0.0
    return {
        "customer_code": customer_code,
        "currency_code": currency_code,
        "financial_year": financial_year,
        "financial_period": financial_period,
        "period_closing_date": _date_only(header.get("period_closing_date")),
        "party_name": compact_text(header.get("party_name")),
        "address": compact_text(header.get("address")),
        "postal_zip_code": compact_text(header.get("postal_zip_code")),
        "country_name": compact_text(header.get("country_name")),
        "currency_desc": compact_text(header.get("currency_desc")),
        "opening_balance": opening_balance,
        "closing_balance": closing_balance,
        "line_count": len(lines),
        "lines": lines,
    }


@accounts_bp.get(ACCOUNTS_PATH)
def accounts_page():
    return render_template(
        "accounts.html",
        active="accounts",
        accounts_path=ACCOUNTS_PATH,
        accounts_asset_version=accounts_asset_version(),
    )


if ACCOUNTS_PATH != _DEFAULT_ACCOUNTS_PATH:

    @accounts_bp.get(_DEFAULT_ACCOUNTS_PATH)
    def accounts_legacy_redirect():
        return redirect(url_for("accounts.accounts_page"), code=301)


@accounts_bp.get("/api/accounts/summary")
def api_accounts_summary():
    refresh = request.args.get("refresh", "").strip().lower() in {"1", "true", "yes", "on"}
    try:
        new_rows = _fetch_headers("new", refresh=refresh)
        outstanding_rows = _fetch_headers("outstanding", refresh=refresh)
        posted_rows = _fetch_headers("posted", refresh=refresh)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502

    return jsonify(
        {
            "ok": True,
            "new": _summary(new_rows),
            "outstanding": _summary(outstanding_rows),
            "posted": _summary(posted_rows),
            "refreshed": refresh,
        }
    )


@accounts_bp.get("/api/accounts/credit-notes")
def api_accounts_credit_notes():
    bucket = _bucket(request.args.get("bucket"))
    refresh = request.args.get("refresh", "").strip().lower() in {"1", "true", "yes", "on"}
    try:
        rows = _fetch_headers(bucket, refresh=refresh)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502

    filtered = _filter_rows(
        rows,
        q=request.args.get("q", ""),
        customer=request.args.get("customer", ""),
        currency=request.args.get("currency", ""),
        date_from=compact_text(request.args.get("from")),
        date_to=compact_text(request.args.get("to")),
    )
    return jsonify(
        {
            "ok": True,
            "bucket": bucket,
            "summary": _summary(filtered),
            "items": filtered,
            "refreshed": refresh,
        }
    )


@accounts_bp.get("/api/accounts/credit-notes/<path:credit_note_no>")
def api_accounts_credit_note_detail(credit_note_no: str):
    bucket = _bucket(request.args.get("bucket"))
    note_no = compact_text(credit_note_no)
    if not note_no:
        return jsonify({"ok": False, "error": "credit_note_no required"}), 400

    hdr_sql = _BUCKET_HDR_ONE_SQL[bucket]
    det_sql = _BUCKET_DET_SQL[bucket]
    try:
        hdr_rows = live_query(hdr_sql, (note_no,))
        if not hdr_rows:
            return jsonify({"ok": False, "error": "Credit note not found"}), 404
        header = _enrich_header(hdr_rows[0], bucket=bucket)
        lines = [_enrich_line(row) for row in live_query(det_sql, (note_no,))]
    except Exception as exc:
        logger.exception("accounts: detail load failed for %s", note_no)
        return jsonify({"ok": False, "error": str(exc)}), 502

    return jsonify(
        {
            "ok": True,
            "bucket": bucket,
            "header": header,
            "lines": lines,
            "line_count": len(lines),
        }
    )


@accounts_bp.get("/api/accounts/soa/periods")
def api_accounts_soa_periods():
    refresh = request.args.get("refresh", "").strip().lower() in {"1", "true", "yes", "on"}
    try:
        periods = _fetch_soa_periods(refresh=refresh)
    except Exception as exc:
        logger.exception("accounts: failed to load SOA periods")
        return jsonify({"ok": False, "error": str(exc)}), 502
    return jsonify({"ok": True, "periods": periods, "refreshed": refresh})


@accounts_bp.get("/api/accounts/soa/customers")
def api_accounts_soa_customers():
    refresh = request.args.get("refresh", "").strip().lower() in {"1", "true", "yes", "on"}
    try:
        year = int(compact_text(request.args.get("year")))
        period = int(compact_text(request.args.get("period")))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "year and period are required"}), 400

    try:
        rows = [
            _enrich_soa_customer(row)
            for row in live_query(_SOA_CUSTOMERS_SQL, (year, period))
        ]
    except Exception as exc:
        logger.exception("accounts: failed to load SOA customers")
        return jsonify({"ok": False, "error": str(exc)}), 502

    filtered = _filter_soa_customers(
        rows,
        q=request.args.get("q", ""),
        currency=request.args.get("currency", ""),
    )
    return jsonify(
        {
            "ok": True,
            "financial_year": year,
            "financial_period": period,
            "items": filtered,
            "count": len(filtered),
            "refreshed": refresh,
        }
    )


@accounts_bp.get("/api/accounts/soa/statement")
def api_accounts_soa_statement():
    customer_code = compact_text(request.args.get("customer"))
    currency_code = compact_text(request.args.get("currency"))
    if not customer_code or not currency_code:
        return jsonify({"ok": False, "error": "customer and currency are required"}), 400
    try:
        year = int(compact_text(request.args.get("year")))
        period = int(compact_text(request.args.get("period")))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "year and period are required"}), 400

    try:
        rows = live_query(
            _SOA_STATEMENT_SQL,
            (customer_code, currency_code, year, period),
        )
        if not rows:
            return jsonify({"ok": False, "error": "Statement not found"}), 404
        statement = _build_soa_statement(
            rows,
            customer_code=customer_code,
            currency_code=currency_code,
            financial_year=year,
            financial_period=period,
        )
    except Exception as exc:
        logger.exception(
            "accounts: SOA statement failed for %s %s %s/%s",
            customer_code,
            currency_code,
            year,
            period,
        )
        return jsonify({"ok": False, "error": str(exc)}), 502

    return jsonify({"ok": True, "statement": statement})
