"""MRO application — standalone ARC format view (mfg_arc_format_v1_view)."""
from __future__ import annotations

import io
import json
import logging
import os
import re
import time
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from flask import Blueprint, jsonify, redirect, render_template, request, send_file, url_for

from db import planner_db_connect_error
from .helpers import one, planner_db, rows as db_rows
from .mro_arc_pdf import ARC_CORRECTION_TEMPLATES, VARIANT_META, generate_arc_documents
from .staged_erp import live_query
from .utils import compact_text

logger = logging.getLogger(__name__)

_DEFAULT_MRO_PATH = "/MRO"
_ARC_VARIANTS = ("CAAS", "FAA", "EASA", "JCAB", "CAAC")
_DUMMY_SERIAL_PREFIX = "DUMMY"
_ERP_COMPLETED_STATUS = "C"
# Parked: multiple ARCs per process sheet are allowed; do not mark local completion.
_APP_COMPLETION_ENABLED = False

# Status tokens that may be embedded in PP voucher (BOM) remarks.
_ARC_STATUS_TOKENS = (
    "OVERHAULED",
    "INSPECTED/TESTED",
    "INSPECTED",
    "TESTED",
    "MODIFIED",
    "REPAIRED",
    "RETREADED",
    "REASSEMBLED",
    "REBUILT",
)
_ARC_STATUS_ALT = "|".join(re.escape(token) for token in _ARC_STATUS_TOKENS)
# e.g. "… Status (Inspected/Tested)" / "Status: Repaired" / trailing "(Repaired)"
_STATUS_FROM_REMARKS_RE = re.compile(
    rf"""(?ix)
    (?:
      (?:^|[\s;,.\-/])
      Status\b\s*[:\-]?\s*
      (?:
        \(\s*(?P<paren_status>{_ARC_STATUS_ALT})\s*\)
        |
        (?P<bare_status>{_ARC_STATUS_ALT})
      )
      |
      \(\s*(?P<trail_paren>{_ARC_STATUS_ALT})\s*\)
    )
    \s*$
    """,
)

_WORKSCOPE_REMARKS_SQL = """
SELECT
    pp_voucher_no,
    inventory_code,
    bom_code,
    remarks,
    source_voucher_no
FROM public.mfg_pp_vch
WHERE NULLIF(TRIM(remarks), '') IS NOT NULL
  AND (
        %s = ''
        OR LOWER(TRIM(inventory_code)) = LOWER(TRIM(%s))
      )
  AND (
        %s = ''
        OR LOWER(TRIM(COALESCE(bom_code, ''))) = LOWER(TRIM(%s))
      )
  AND (
        %s = ''
        OR LOWER(TRIM(pp_voucher_no)) = LOWER(TRIM(%s))
        OR LOWER(TRIM(COALESCE(pp_voucher_no, ''))) LIKE LOWER('%%' || TRIM(%s) || '%%')
      )
  AND (
        %s = ''
        OR LOWER(COALESCE(remarks, '')) LIKE LOWER('%%' || TRIM(%s) || '%%')
        OR LOWER(COALESCE(inventory_code, '')) LIKE LOWER('%%' || TRIM(%s) || '%%')
        OR LOWER(COALESCE(bom_code, '')) LIKE LOWER('%%' || TRIM(%s) || '%%')
        OR LOWER(COALESCE(pp_voucher_no, '')) LIKE LOWER('%%' || TRIM(%s) || '%%')
      )
ORDER BY
    CASE
        WHEN LOWER(TRIM(pp_voucher_no)) = LOWER(TRIM(%s)) THEN 0
        WHEN LOWER(TRIM(inventory_code)) = LOWER(TRIM(%s)) THEN 1
        ELSE 2
    END,
    pp_voucher_no DESC
LIMIT 80
"""

_WORKSCOPE_REMARKS_STAGED_SQL = """
SELECT
    pp_voucher_no,
    inventory_code,
    bom_code,
    remarks,
    source_voucher_no
FROM public.pp_voucher_hdr
WHERE NULLIF(TRIM(remarks), '') IS NOT NULL
  AND (
        %s = ''
        OR LOWER(TRIM(inventory_code)) = LOWER(TRIM(%s))
      )
  AND (
        %s = ''
        OR LOWER(TRIM(COALESCE(bom_code, ''))) = LOWER(TRIM(%s))
      )
  AND (
        %s = ''
        OR LOWER(TRIM(pp_voucher_no)) = LOWER(TRIM(%s))
        OR LOWER(TRIM(COALESCE(pp_voucher_no, ''))) LIKE LOWER('%%' || TRIM(%s) || '%%')
      )
  AND (
        %s = ''
        OR LOWER(COALESCE(remarks, '')) LIKE LOWER('%%' || TRIM(%s) || '%%')
        OR LOWER(COALESCE(inventory_code, '')) LIKE LOWER('%%' || TRIM(%s) || '%%')
        OR LOWER(COALESCE(bom_code, '')) LIKE LOWER('%%' || TRIM(%s) || '%%')
        OR LOWER(COALESCE(pp_voucher_no, '')) LIKE LOWER('%%' || TRIM(%s) || '%%')
      )
ORDER BY
    CASE
        WHEN LOWER(TRIM(pp_voucher_no)) = LOWER(TRIM(%s)) THEN 0
        WHEN LOWER(TRIM(inventory_code)) = LOWER(TRIM(%s)) THEN 1
        ELSE 2
    END,
    pp_voucher_no DESC
LIMIT 80
"""

# Process sheet → linked PP voucher (part / BOM / remarks).
_WORKSCOPE_PS_RESOLVE_STAGED_SQL = """
SELECT
    ps.process_sheet_no,
    ps.pp_voucher_no,
    COALESCE(NULLIF(TRIM(pp.inventory_code), ''), NULLIF(TRIM(ps.inventory_code), '')) AS inventory_code,
    pp.bom_code,
    pp.remarks,
    pp.source_voucher_no
FROM public.mfg_process_sheet_info ps
LEFT JOIN public.pp_voucher_hdr pp
       ON pp.pp_voucher_no = ps.pp_voucher_no
WHERE LOWER(TRIM(ps.process_sheet_no)) = LOWER(TRIM(%s))
   OR LOWER(TRIM(COALESCE(ps.process_sheet_no, ''))) LIKE LOWER('%%' || TRIM(%s) || '%%')
ORDER BY
    CASE WHEN LOWER(TRIM(ps.process_sheet_no)) = LOWER(TRIM(%s)) THEN 0 ELSE 1 END,
    ps.process_sheet_no,
    ps.pp_voucher_no
LIMIT 40
"""

_WORKSCOPE_PS_RESOLVE_LIVE_SQL = """
SELECT
    ps.process_sheet_no,
    ps.pp_voucher_no,
    COALESCE(NULLIF(TRIM(pp.inventory_code), ''), NULLIF(TRIM(ps.inventory_code), '')) AS inventory_code,
    pp.bom_code,
    pp.remarks,
    pp.source_voucher_no
FROM public.mfg_process_sheet_info_v1_view ps
LEFT JOIN public.mfg_pp_vch pp
       ON pp.pp_voucher_no = ps.pp_voucher_no
WHERE LOWER(TRIM(ps.process_sheet_no)) = LOWER(TRIM(%s))
   OR LOWER(TRIM(COALESCE(ps.process_sheet_no, ''))) LIKE LOWER('%%' || TRIM(%s) || '%%')
ORDER BY
    CASE WHEN LOWER(TRIM(ps.process_sheet_no)) = LOWER(TRIM(%s)) THEN 0 ELSE 1 END,
    ps.process_sheet_no,
    ps.pp_voucher_no
LIMIT 40
"""

mro_bp = Blueprint("mro", __name__)

_CACHE_TTL_SEC = 300
_cache: tuple[float, list[dict[str, Any]]] | None = None
_staff_tables_ready = False
_history_tables_ready = False

_MRO_SQL = """
SELECT
    sales_order_no,
    sales_line_item_no,
    type,
    component_line_item_no,
    parent_inventory_code,
    inventory_code,
    total_qty,
    pp_voucher_no,
    process_sheet_no,
    sales_component_seq_no,
    sn_remarks,
    customer_code,
    customer_po_no,
    customer_po_line_item_no,
    sales_order_date,
    inventory_main_desc,
    inventory_short_desc,
    arc_seq_no,
    caas_doc_no,
    faa_doc_no,
    easa_doc_no,
    arc_status,
    created_by,
    created_datetime,
    last_updated_by,
    last_updated_datetime
FROM public.mfg_arc_format_v1_view
ORDER BY
    last_updated_datetime DESC NULLS LAST,
    sales_order_no,
    sales_line_item_no,
    arc_seq_no
"""

# Header fields for the ARC General sidebar (Synergix SO → ARC mapping).
_SO_HEADER_SQL = """
SELECT
    v.sales_order_no,
    v.sales_quotation_no,
    v.sales_person_code,
    COALESCE(
        NULLIF(TRIM(v.sales_person_name), ''),
        NULLIF(TRIM(emp.employee_name), '')
    ) AS sales_person_name,
    v.customer_code,
    v.customer_name,
    v.customer_short_name,
    v.customer_po_no,
    v.sbu_code,
    v.sbu_desc,
    v.sales_category_code,
    cat.sales_category_desc,
    h.segment_1_code,
    COALESCE(
        NULLIF(TRIM(s1.segment_desc), ''),
        NULLIF(TRIM(d1.segment_1_desc), '')
    ) AS segment_1_desc
FROM public.so_order_view v
LEFT JOIN public.so_order_ost_hdr h
       ON h.sales_order_no = v.sales_order_no
LEFT JOIN public.mt_employee emp
       ON emp.employee_code = v.sales_person_code
LEFT JOIN public.mt_sales_category cat
       ON cat.sales_category_code = v.sales_category_code
LEFT JOIN public.mt_segment1 s1
       ON s1.segment_code = h.segment_1_code
LEFT JOIN public.segment_1_desc d1
       ON d1.segment_1_code = h.segment_1_code
WHERE v.sales_order_no = %s
LIMIT 1
"""

_so_header_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}
_SO_HEADER_CACHE_TTL_SEC = 300


def mro_path() -> str:
    raw = (os.getenv("MRO_PATH") or _DEFAULT_MRO_PATH).strip()
    if not raw.startswith("/"):
        raw = "/" + raw
    if len(raw) > 1 and raw.endswith("/"):
        raw = raw.rstrip("/")
    return raw


MRO_PATH = mro_path()


def mro_asset_version() -> str:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    watch = (
        os.path.join(root, "static", "js", "mro.js"),
        os.path.join(root, "static", "css", "mro.css"),
    )
    try:
        mt = max(os.path.getmtime(path) for path in watch)
        return f"mro-{int(mt)}"
    except OSError:
        return "mro-dev"


def invalidate_mro_cache() -> None:
    global _cache, _so_header_cache
    _cache = None
    _so_header_cache.clear()


def _fetch_so_header(sales_order_no: str, *, refresh: bool = False) -> dict[str, Any] | None:
    so = compact_text(sales_order_no)
    if not so:
        return None

    now = time.time()
    if not refresh:
        cached = _so_header_cache.get(so)
        if cached and now - cached[0] < _SO_HEADER_CACHE_TTL_SEC:
            return cached[1]

    rows = live_query(_SO_HEADER_SQL, (so,))
    header = rows[0] if rows else None
    _so_header_cache[so] = (now, header)
    return header


def _ensure_staff_table(con) -> None:
    global _staff_tables_ready
    if _staff_tables_ready:
        return
    # Migrate legacy planner_mro_* name if present.
    con.execute(
        """
        DO $$
        BEGIN
            IF to_regclass('public.planner_mro_certifying_staff') IS NOT NULL
               AND to_regclass('public.mro_certifying_staff') IS NULL THEN
                ALTER TABLE public.planner_mro_certifying_staff
                    RENAME TO mro_certifying_staff;
            END IF;
        END $$;
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.mro_certifying_staff (
            staff_id    BIGSERIAL    PRIMARY KEY,
            name        TEXT         NOT NULL,
            active      BOOLEAN      NOT NULL DEFAULT TRUE,
            created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        ALTER TABLE public.mro_certifying_staff
            ADD COLUMN IF NOT EXISTS signature_image BYTEA,
            ADD COLUMN IF NOT EXISTS signature_mime TEXT,
            ADD COLUMN IF NOT EXISTS signature_updated_at TIMESTAMPTZ
        """
    )
    _staff_tables_ready = True


def _serialize_staff(row: dict[str, Any]) -> dict[str, Any]:
    created = row.get("created_at")
    return {
        "staff_id": row.get("staff_id"),
        "name": compact_text(row.get("name")),
        "active": bool(row.get("active")),
        "has_signature": bool(row.get("has_signature")),
        "created_at": created.isoformat(sep=" ", timespec="seconds") if hasattr(created, "isoformat") else created,
    }


def load_certifying_staff(con) -> list[dict[str, Any]]:
    _ensure_staff_table(con)
    fetched = db_rows(
        con.execute(
            """
            SELECT
                staff_id,
                name,
                active,
                created_at,
                (signature_image IS NOT NULL) AS has_signature
            FROM public.mro_certifying_staff
            WHERE active = TRUE
            ORDER BY LOWER(name), staff_id
            """
        )
    )
    return [_serialize_staff(dict(row)) for row in fetched]


def add_certifying_staff(con, name: str) -> tuple[dict[str, Any], bool]:
    _ensure_staff_table(con)
    clean = compact_text(name)
    if not clean:
        raise ValueError("Name is required")

    existing = one(
        con.execute(
            """
            SELECT
                staff_id,
                name,
                active,
                created_at,
                (signature_image IS NOT NULL) AS has_signature
            FROM public.mro_certifying_staff
            WHERE active = TRUE
              AND LOWER(TRIM(name)) = LOWER(TRIM(%s))
            ORDER BY staff_id
            LIMIT 1
            """,
            (clean,),
        )
    )
    if existing:
        return _serialize_staff(dict(existing)), False

    inactive = one(
        con.execute(
            """
            SELECT
                staff_id,
                name,
                active,
                created_at,
                (signature_image IS NOT NULL) AS has_signature
            FROM public.mro_certifying_staff
            WHERE active = FALSE
              AND LOWER(TRIM(name)) = LOWER(TRIM(%s))
            ORDER BY staff_id
            LIMIT 1
            """,
            (clean,),
        )
    )
    if inactive:
        row = one(
            con.execute(
                """
                UPDATE public.mro_certifying_staff
                SET active = TRUE, name = %s
                WHERE staff_id = %s
                RETURNING
                    staff_id,
                    name,
                    active,
                    created_at,
                    (signature_image IS NOT NULL) AS has_signature
                """,
                (clean, int(inactive["staff_id"])),
            )
        )
        return _serialize_staff(dict(row)), True

    row = one(
        con.execute(
            """
            INSERT INTO public.mro_certifying_staff (name)
            VALUES (%s)
            RETURNING
                staff_id,
                name,
                active,
                created_at,
                (signature_image IS NOT NULL) AS has_signature
            """,
            (clean,),
        )
    )
    return _serialize_staff(dict(row)), True


def delete_certifying_staff(con, staff_id: int) -> bool:
    _ensure_staff_table(con)
    row = one(
        con.execute(
            """
            UPDATE public.mro_certifying_staff
            SET active = FALSE
            WHERE staff_id = %s
              AND active = TRUE
            RETURNING staff_id
            """,
            (staff_id,),
        )
    )
    return bool(row)


_ALLOWED_SIGNATURE_MIMES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
}
_MAX_SIGNATURE_BYTES = 500 * 1024


def save_staff_signature(con, staff_id: int, image_bytes: bytes, mime_type: str) -> dict[str, Any]:
    _ensure_staff_table(con)
    mime = compact_text(mime_type).lower() or "image/png"
    if mime not in _ALLOWED_SIGNATURE_MIMES:
        raise ValueError("Signature must be a PNG, JPEG, or WebP image")
    if not image_bytes:
        raise ValueError("Signature file is empty")
    if len(image_bytes) > _MAX_SIGNATURE_BYTES:
        raise ValueError("Signature image must be 500 KB or smaller")

    # Normalize odd aliases so ReportLab/Pillow can open consistently.
    if mime == "image/jpg":
        mime = "image/jpeg"

    row = one(
        con.execute(
            """
            UPDATE public.mro_certifying_staff
            SET
                signature_image = %s,
                signature_mime = %s,
                signature_updated_at = NOW()
            WHERE staff_id = %s
              AND active = TRUE
            RETURNING
                staff_id,
                name,
                active,
                created_at,
                (signature_image IS NOT NULL) AS has_signature
            """,
            (psycopg2_binary(image_bytes), mime, staff_id),
        )
    )
    if not row:
        raise ValueError("Staff not found")
    return _serialize_staff(dict(row))


def clear_staff_signature(con, staff_id: int) -> dict[str, Any]:
    _ensure_staff_table(con)
    row = one(
        con.execute(
            """
            UPDATE public.mro_certifying_staff
            SET
                signature_image = NULL,
                signature_mime = NULL,
                signature_updated_at = NULL
            WHERE staff_id = %s
              AND active = TRUE
            RETURNING
                staff_id,
                name,
                active,
                created_at,
                (signature_image IS NOT NULL) AS has_signature
            """,
            (staff_id,),
        )
    )
    if not row:
        raise ValueError("Staff not found")
    return _serialize_staff(dict(row))


def load_staff_signature_bytes(con, staff_name: str) -> bytes | None:
    """Return signature image bytes for an active staff name, if uploaded."""
    clean = compact_text(staff_name)
    if not clean:
        return None
    _ensure_staff_table(con)
    row = one(
        con.execute(
            """
            SELECT signature_image
            FROM public.mro_certifying_staff
            WHERE active = TRUE
              AND LOWER(TRIM(name)) = LOWER(TRIM(%s))
              AND signature_image IS NOT NULL
            ORDER BY staff_id
            LIMIT 1
            """,
            (clean,),
        )
    )
    if not row:
        return None
    raw = row.get("signature_image")
    if raw is None:
        return None
    return bytes(raw)


def psycopg2_binary(data: bytes):
    """Wrap bytes for BYTEA inserts (psycopg2 Binary when available)."""
    try:
        from psycopg2.extras import Binary

        return Binary(data)
    except Exception:
        return data


def _ensure_history_tables(con) -> None:
    global _history_tables_ready
    if _history_tables_ready:
        return
    # Migrate legacy planner_mro_* names if present.
    con.execute(
        """
        DO $$
        BEGIN
            IF to_regclass('public.planner_mro_arc_serial_seq') IS NOT NULL
               AND to_regclass('public.mro_arc_serial_seq') IS NULL THEN
                ALTER TABLE public.planner_mro_arc_serial_seq
                    RENAME TO mro_arc_serial_seq;
            END IF;
            IF to_regclass('public.planner_mro_arc_history') IS NOT NULL
               AND to_regclass('public.mro_arc_history') IS NULL THEN
                ALTER TABLE public.planner_mro_arc_history
                    RENAME TO mro_arc_history;
            END IF;
        END $$;
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.mro_arc_serial_seq (
            variant      TEXT         PRIMARY KEY,
            next_value   BIGINT       NOT NULL DEFAULT 1
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.mro_arc_history (
            history_id            BIGSERIAL    PRIMARY KEY,
            caas_doc_no           TEXT         UNIQUE,
            faa_doc_no            TEXT         UNIQUE,
            easa_doc_no           TEXT         UNIQUE,
            jcab_doc_no          TEXT         UNIQUE,
            caac_doc_no          TEXT         UNIQUE,
            order_date            DATE,
            process_sheet_no      TEXT,
            part_no               TEXT,
            description           TEXT,
            serial_no             TEXT,
            customer_code         TEXT,
            customer_po_no        TEXT,
            po_item_no            TEXT,
            so_qty                NUMERIC,
            sales_order_no        TEXT,
            sales_line_item_no    TEXT,
            certifying_staff      TEXT,
            cert_date             DATE,
            variants              TEXT[]       NOT NULL DEFAULT '{}',
            payload_json          JSONB,
            created_by            TEXT,
            created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        ALTER TABLE public.mro_arc_history
            ADD COLUMN IF NOT EXISTS jcab_doc_no TEXT,
            ADD COLUMN IF NOT EXISTS caac_doc_no TEXT,
            ADD COLUMN IF NOT EXISTS pdf_bytes BYTEA,
            ADD COLUMN IF NOT EXISTS pdf_filename TEXT,
            ADD COLUMN IF NOT EXISTS pdf_content_type TEXT
        """
    )
    # Rename earlier provisional column names if present.
    con.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'mro_arc_history'
                  AND column_name = 'japan_doc_no'
            ) AND NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'mro_arc_history'
                  AND column_name = 'jcab_doc_no'
            ) THEN
                ALTER TABLE public.mro_arc_history RENAME COLUMN japan_doc_no TO jcab_doc_no;
            END IF;
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'mro_arc_history'
                  AND column_name = 'china_doc_no'
            ) AND NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'mro_arc_history'
                  AND column_name = 'caac_doc_no'
            ) THEN
                ALTER TABLE public.mro_arc_history RENAME COLUMN china_doc_no TO caac_doc_no;
            END IF;
        END $$;
        """
    )
    # Unique indexes for new authority columns (ADD COLUMN IF NOT EXISTS cannot add UNIQUE).
    con.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'mro_arc_history_jcab_doc_no_key'
            ) THEN
                ALTER TABLE public.mro_arc_history
                    ADD CONSTRAINT mro_arc_history_jcab_doc_no_key UNIQUE (jcab_doc_no);
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'mro_arc_history_caac_doc_no_key'
            ) THEN
                ALTER TABLE public.mro_arc_history
                    ADD CONSTRAINT mro_arc_history_caac_doc_no_key UNIQUE (caac_doc_no);
            END IF;
        END $$;
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.mro_arc_app_completion (
            sales_order_no        TEXT         NOT NULL,
            sales_line_item_no    TEXT         NOT NULL DEFAULT '',
            process_sheet_no      TEXT         NOT NULL DEFAULT '',
            history_id            BIGINT       UNIQUE,
            completed_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            PRIMARY KEY (sales_order_no, sales_line_item_no, process_sheet_no)
        )
        """
    )
    for variant in _ARC_VARIANTS:
        con.execute(
            """
            INSERT INTO public.mro_arc_serial_seq (variant, next_value)
            VALUES (%s, 1)
            ON CONFLICT (variant) DO NOTHING
            """,
            (variant,),
        )
    _history_tables_ready = True


def _process_sheet_key(data: dict[str, Any] | None) -> str:
    if not data:
        return ""
    return compact_text(data.get("process_sheet_no") or data.get("pp_voucher_no"))


def _normalize_line_item(value: Any) -> str:
    """Normalize SO line ids so ERP floats like 1.0 match app strings like '1'."""
    text = compact_text(value)
    if not text:
        return ""
    try:
        number = float(text)
    except ValueError:
        return text
    if number.is_integer():
        return str(int(number))
    return text


def _completion_key(
    sales_order_no: Any,
    sales_line_item_no: Any,
    process_sheet_no: Any,
) -> tuple[str, str, str]:
    return (
        compact_text(sales_order_no),
        _normalize_line_item(sales_line_item_no),
        compact_text(process_sheet_no),
    )


def _erp_status_completed(arc_status: Any) -> bool:
    return compact_text(arc_status).upper() == _ERP_COMPLETED_STATUS


def mark_app_completion(
    con,
    *,
    sales_order_no: str,
    sales_line_item_no: str,
    process_sheet_no: str,
    history_id: int | None,
) -> None:
    """Flag a line as completed in this app (Create ARC submit)."""
    _ensure_history_tables(con)
    so, line, ps = _completion_key(sales_order_no, sales_line_item_no, process_sheet_no)
    if not so:
        raise ValueError("sales_order_no is required to mark app completion")
    con.execute(
        """
        INSERT INTO public.mro_arc_app_completion (
            sales_order_no,
            sales_line_item_no,
            process_sheet_no,
            history_id,
            completed_at
        )
        VALUES (%s, %s, %s, %s, NOW())
        ON CONFLICT (sales_order_no, sales_line_item_no, process_sheet_no)
        DO UPDATE SET
            history_id = EXCLUDED.history_id,
            completed_at = NOW()
        """,
        (so, line, ps, history_id),
    )


def clear_app_completion_for_history(con, history_id: int) -> None:
    """Clear the local completion flag when a test history row is deleted."""
    _ensure_history_tables(con)
    con.execute(
        """
        DELETE FROM public.mro_arc_app_completion
        WHERE history_id = %s
        """,
        (history_id,),
    )


def clear_app_completion_for_line(
    con,
    *,
    sales_order_no: str,
    sales_line_item_no: str,
    process_sheet_no: str,
) -> None:
    _ensure_history_tables(con)
    so, line, ps = _completion_key(sales_order_no, sales_line_item_no, process_sheet_no)
    if not so:
        return
    con.execute(
        """
        DELETE FROM public.mro_arc_app_completion
        WHERE sales_order_no = %s
          AND sales_line_item_no = %s
          AND process_sheet_no = %s
        """,
        (so, line, ps),
    )


def load_app_completion_keys(con) -> set[tuple[str, str, str]]:
    _ensure_history_tables(con)
    fetched = db_rows(
        con.execute(
            """
            SELECT sales_order_no, sales_line_item_no, process_sheet_no
            FROM public.mro_arc_app_completion
            """
        )
    )
    keys: set[tuple[str, str, str]] = set()
    for row in fetched:
        keys.add(
            _completion_key(
                row.get("sales_order_no"),
                row.get("sales_line_item_no"),
                row.get("process_sheet_no"),
            )
        )
    return keys


def annotate_rows_with_completion(
    rows: list[dict[str, Any]],
    completion_keys: set[tuple[str, str, str]],
) -> list[dict[str, Any]]:
    """Merge ERP arc_status with local Create-ARC completion flag.

    Precedence for Completed: ERP status C OR local app_completed flag.
    Refresh keeps pulling fresh ERP status; local flag persists until history delete.
    """
    annotated: list[dict[str, Any]] = []
    for raw in rows:
        row = dict(raw)
        erp_status = compact_text(row.get("arc_status"))
        key = _completion_key(
            row.get("sales_order_no"),
            row.get("sales_line_item_no"),
            _process_sheet_key(row),
        )
        app_completed = (
            key in completion_keys and bool(key[0])
            if _APP_COMPLETION_ENABLED
            else False
        )
        erp_completed = _erp_status_completed(erp_status)
        # App completion is parked — only ERP status C counts as completed for now.
        effective_completed = erp_completed or (
            app_completed if _APP_COMPLETION_ENABLED else False
        )
        row["erp_arc_status"] = erp_status
        row["app_completed"] = app_completed
        row["effective_completed"] = effective_completed
        # Keep arc_status as ERP raw; expose effective code for filters.
        row["effective_status"] = (
            _ERP_COMPLETED_STATUS if effective_completed else (erp_status or "D")
        )
        annotated.append(row)
    return annotated


def _format_dummy_serial(variant: str, number: int) -> str:
    return f"{_DUMMY_SERIAL_PREFIX}-{variant}-{int(number):05d}"


def allocate_dummy_serials(con, variants: list[str]) -> dict[str, str]:
    """Allocate unique running dummy serials per authority. Never reuses a number."""
    _ensure_history_tables(con)
    allocated: dict[str, str] = {}
    for raw in variants:
        variant = compact_text(raw).upper()
        if variant not in _ARC_VARIANTS:
            raise ValueError(f"Unsupported ARC variant: {variant}")
        if variant in allocated:
            continue
        con.execute(
            """
            INSERT INTO public.mro_arc_serial_seq (variant, next_value)
            VALUES (%s, 1)
            ON CONFLICT (variant) DO NOTHING
            """,
            (variant,),
        )
        row = one(
            con.execute(
                """
                UPDATE public.mro_arc_serial_seq
                SET next_value = next_value + 1
                WHERE variant = %s
                RETURNING (next_value - 1) AS allocated
                """,
                (variant,),
            )
        )
        if not row:
            raise RuntimeError(f"Could not allocate serial for {variant}")
        serial = _format_dummy_serial(variant, int(row["allocated"]))
        # Hard uniqueness check against history (seq + UNIQUE constraints).
        clash = one(
            con.execute(
                """
                SELECT history_id
                FROM public.mro_arc_history
                WHERE caas_doc_no = %s
                   OR faa_doc_no = %s
                   OR easa_doc_no = %s
                   OR jcab_doc_no = %s
                   OR caac_doc_no = %s
                LIMIT 1
                """,
                (serial, serial, serial, serial, serial),
            )
        )
        if clash:
            raise RuntimeError(f"Serial {serial} already exists — allocation conflict")
        allocated[variant] = serial
    return allocated


def _parse_optional_date(value: Any) -> date | None:
    text = compact_text(value)
    if not text:
        return None
    candidates = [text[:10], text]
    for candidate in candidates:
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d"):
            try:
                return datetime.strptime(candidate, fmt).date()
            except ValueError:
                continue
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _parse_optional_qty(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        qty = Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return None
    if qty != qty.to_integral_value():
        raise ValueError("Quantity must be a whole number (0 decimal places)")
    return qty.to_integral_value()


def _normalize_arc_payload_quantity(data: dict[str, Any]) -> dict[str, Any]:
    """Ensure item/items quantities are whole-number strings before PDF / history save.

    Unchecked / removed lines stay on the Form 1 as Quantity 0 with a blank
    serial (CAAS / EASA / FAA sample pattern). At least one included line is
    required.
    """
    payload = dict(data)

    def _norm_one(item: dict[str, Any], *, force_removed: bool = False) -> dict[str, Any]:
        out = dict(item)
        removed = force_removed or out.get("removed") is True or out.get("included") is False
        raw_qty = out.get("quantity")
        if removed:
            out["removed"] = True
            out["included"] = False
            out["quantity"] = "0"
            out["serial_no"] = ""
            return out
        out["removed"] = False
        out["included"] = True
        if raw_qty not in (None, ""):
            qty = _parse_optional_qty(raw_qty)
            if qty is None:
                raise ValueError("Quantity must be a whole number (0 decimal places)")
            out["quantity"] = str(int(qty))
            if int(qty) <= 0:
                out["serial_no"] = ""
        return out

    items_raw = payload.get("items")
    if isinstance(items_raw, list) and items_raw:
        items = [_norm_one(dict(item)) for item in items_raw if isinstance(item, dict)]
        if not items:
            raise ValueError("Select at least one item line for the ARC")
        if not any(not item.get("removed") for item in items):
            raise ValueError("Include at least one line item (unchecked lines print as Quantity 0)")
        # Preserve original order / iter positions for Form 1 numbering.
        for idx, item in enumerate(items):
            item["iter"] = compact_text(item.get("iter")) or str(idx + 1)
        payload["items"] = items
        # Primary item for history header fields = first included line.
        primary = next((item for item in items if not item.get("removed")), items[0])
        payload["item"] = dict(primary)
        return payload

    item = dict(payload.get("item") or {}) if isinstance(payload.get("item"), dict) else {}
    raw_qty = item.get("quantity")
    if raw_qty in (None, "") and payload.get("total_qty") not in (None, ""):
        raw_qty = payload.get("total_qty")
        item["quantity"] = raw_qty
    if raw_qty not in (None, ""):
        item = _norm_one(item)
    payload["item"] = item
    payload["items"] = [item] if item else []
    return payload


def _attach_staff_signature(payload: dict[str, Any]) -> dict[str, Any]:
    """Resolve certifying staff e-signature bytes into the PDF payload."""
    out = dict(payload)
    staff_name = compact_text(out.get("certifying_staff"))
    if not staff_name:
        return out
    try:
        with planner_db() as con:
            image = load_staff_signature_bytes(con, staff_name)
    except Exception:
        logger.exception("MRO staff signature lookup failed for %s", staff_name)
        return out
    if image:
        out["signature_image"] = image
    return out


# Spreadsheet-style tracking prefixes (suffix number stored separately in history UI).
# Must match Form Tracking Number prefixes on the ARC PDF.
_TRACKING_PREFIXES = {
    key: meta["tracking_prefix"] for key, meta in VARIANT_META.items()
}


def _doc_running_number(doc_no: Any) -> str | None:
    """Extract trailing running number from a stored doc no (e.g. DUMMY-CAAS-0012 → 0012)."""
    text = compact_text(doc_no)
    if not text:
        return None
    # Prefer last hyphen/underscore segment when it looks numeric.
    for sep in ("-", "/", "_", " "):
        if sep in text:
            tail = text.rsplit(sep, 1)[-1].strip()
            if tail.isdigit():
                return tail
    digits = "".join(ch for ch in text if ch.isdigit())
    return digits or text


def _payload_dict(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("payload_json")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return dict(raw) if isinstance(raw, dict) else {}


def _serialize_history(row: dict[str, Any]) -> dict[str, Any]:
    def _d(value: Any) -> str | None:
        if value is None:
            return None
        if hasattr(value, "isoformat"):
            return value.isoformat()
        return str(value)

    variants = row.get("variants") or []
    if isinstance(variants, str):
        variants = [v for v in variants.strip("{}").split(",") if v]
    variants = [compact_text(v).upper() for v in variants if compact_text(v)]

    qty = row.get("so_qty")
    if isinstance(qty, Decimal):
        qty_out: Any = float(qty)
    else:
        qty_out = qty

    created = row.get("created_at")
    payload = _payload_dict(row)
    payload_doc_nos = payload.get("doc_nos") if isinstance(payload.get("doc_nos"), dict) else {}
    items = payload.get("items") if isinstance(payload.get("items"), list) else []
    item_count = len([x for x in items if isinstance(x, dict)]) if items else 1

    workscope = compact_text(payload.get("workscope"))
    supplementary = compact_text(payload.get("supplementary"))
    customer_name = compact_text(payload.get("customer_name")) or compact_text(
        payload.get("customer_short_name")
    )
    part_type = compact_text(payload.get("part_type")).lower() or None

    # Form-type flags (C1 / C7 / C14 / D1) are not stored yet — best-effort:
    # multi-authority ≈ dual release (D1); CAAS-only ≈ C1. C7/C14 left unset.
    form_c1 = bool(variants) and variants == ["CAAS"]
    form_d1 = len(variants) > 1
    form_c7 = False
    form_c14 = False

    def _resolved_doc(variant: str) -> str | None:
        col = compact_text(row.get(f"{variant.lower()}_doc_no"))
        if col:
            return col
        return compact_text(payload_doc_nos.get(variant)) or None

    def _tracking_fields(variant: str) -> tuple[str | None, str | None, str | None]:
        doc = _resolved_doc(variant)
        has_authority = bool(doc) or variant in variants
        prefix = _TRACKING_PREFIXES.get(variant) if has_authority else None
        return doc, prefix, _doc_running_number(doc) if doc else None

    caas_doc, caas_prefix, caas_no = _tracking_fields("CAAS")
    faa_doc, faa_prefix, faa_no = _tracking_fields("FAA")
    easa_doc, easa_prefix, easa_no = _tracking_fields("EASA")
    jcab_doc, jcab_prefix, jcab_no = _tracking_fields("JCAB")
    caac_doc, caac_prefix, caac_no = _tracking_fields("CAAC")

    return {
        "history_id": row.get("history_id"),
        "caas_doc_no": caas_doc,
        "faa_doc_no": faa_doc,
        "easa_doc_no": easa_doc,
        "jcab_doc_no": jcab_doc,
        "caac_doc_no": caac_doc,
        "caas_tracking_prefix": caas_prefix,
        "caas_tracking_no": caas_no,
        "faa_tracking_prefix": faa_prefix,
        "faa_tracking_no": faa_no,
        "easa_tracking_prefix": easa_prefix,
        "easa_tracking_no": easa_no,
        "jcab_tracking_prefix": jcab_prefix,
        "jcab_tracking_no": jcab_no,
        "caac_tracking_prefix": caac_prefix,
        "caac_tracking_no": caac_no,        "form_c1": form_c1,
        "form_c7": form_c7,
        "form_c14": form_c14,
        "form_d1": form_d1,
        "order_date": _d(row.get("order_date")),
        "process_sheet_no": compact_text(row.get("process_sheet_no")),
        "part_no": compact_text(row.get("part_no")),
        "description": compact_text(row.get("description")),
        "serial_no": compact_text(row.get("serial_no")),
        "customer_code": compact_text(row.get("customer_code")),
        "customer_name": customer_name or None,
        "customer_po_no": compact_text(row.get("customer_po_no")),
        "po_item_no": compact_text(row.get("po_item_no")),
        "so_qty": qty_out,
        "item_count": item_count,
        "sales_order_no": compact_text(row.get("sales_order_no")),
        "sales_line_item_no": compact_text(row.get("sales_line_item_no")),
        "certifying_staff": compact_text(row.get("certifying_staff")),
        "cert_date": _d(row.get("cert_date")),
        "workscope": workscope or None,
        "supplementary": supplementary or None,
        "inspection_report": supplementary or None,
        "remark": workscope or None,
        "part_type": part_type,
        "variants": list(variants),
        "has_pdf": bool(row.get("has_pdf")),
        "pdf_filename": compact_text(row.get("pdf_filename")) or None,
        "created_by": compact_text(row.get("created_by")),
        "created_at": created.isoformat(sep=" ", timespec="seconds") if hasattr(created, "isoformat") else created,
    }


def create_arc_history(con, data: dict[str, Any]) -> dict[str, Any]:
    """Allocate dummy serials, persist creation history, return the saved row + doc_nos."""
    _ensure_history_tables(con)

    raw_variants = data.get("variants") or []
    if isinstance(raw_variants, str):
        raw_variants = [raw_variants]
    variants: list[str] = []
    for item in raw_variants:
        key = compact_text(item).upper()
        if key in _ARC_VARIANTS and key not in variants:
            variants.append(key)
    if not variants:
        raise ValueError("Select at least one variant (CAAS, FAA, EASA, JCAB, or CAAC)")

    certifying_staff = compact_text(data.get("certifying_staff"))
    if not certifying_staff:
        raise ValueError("14d. Name (certifying staff) is required")

    item = data.get("item") if isinstance(data.get("item"), dict) else {}
    items = data.get("items") if isinstance(data.get("items"), list) else []
    if items:
        first_included = next(
            (entry for entry in items if isinstance(entry, dict) and not entry.get("removed")),
            None,
        )
        if isinstance(first_included, dict):
            item = first_included
        elif isinstance(items[0], dict):
            item = items[0]
    doc_nos = allocate_dummy_serials(con, variants)

    order_date = _parse_optional_date(data.get("order_date") or data.get("sales_order_date"))
    cert_date = _parse_optional_date(data.get("cert_date")) or date.today()
    so_qty = _parse_optional_qty(item.get("quantity") if item else data.get("total_qty") or data.get("so_qty"))

    payload_snapshot = dict(data)
    payload_snapshot.pop("signature_image", None)
    payload_snapshot["doc_nos"] = doc_nos
    payload_snapshot["variants"] = variants
    if items:
        payload_snapshot["items"] = items
        payload_snapshot["item"] = item

    row = one(
        con.execute(
            """
            INSERT INTO public.mro_arc_history (
                caas_doc_no,
                faa_doc_no,
                easa_doc_no,
                jcab_doc_no,
                caac_doc_no,
                order_date,
                process_sheet_no,
                part_no,
                description,
                serial_no,
                customer_code,
                customer_po_no,
                po_item_no,
                so_qty,
                sales_order_no,
                sales_line_item_no,
                certifying_staff,
                cert_date,
                variants,
                payload_json,
                created_by
            )
            VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s
            )
            RETURNING
                history_id,
                caas_doc_no,
                faa_doc_no,
                easa_doc_no,
                jcab_doc_no,
                caac_doc_no,
                order_date,
                process_sheet_no,
                part_no,
                description,
                serial_no,
                customer_code,
                customer_po_no,
                po_item_no,
                so_qty,
                sales_order_no,
                sales_line_item_no,
                certifying_staff,
                cert_date,
                variants,
                created_by,
                created_at
            """,
            (
                doc_nos.get("CAAS"),
                doc_nos.get("FAA"),
                doc_nos.get("EASA"),
                doc_nos.get("JCAB"),
                doc_nos.get("CAAC"),
                order_date,
                compact_text(data.get("process_sheet_no")),
                compact_text(item.get("part_no") or data.get("inventory_code") or data.get("part_no")),
                compact_text(item.get("description") or data.get("inventory_main_desc") or data.get("description")),
                compact_text(item.get("serial_no") or data.get("sn_remarks") or data.get("serial_no")),
                compact_text(data.get("customer_code")),
                compact_text(data.get("customer_po_no")),
                compact_text(data.get("po_item_no") or data.get("customer_po_line_item_no")),
                so_qty,
                compact_text(data.get("sales_order_no")),
                compact_text(data.get("sales_line_item_no")),
                certifying_staff,
                cert_date,
                variants,
                json.dumps(payload_snapshot, default=str),
                compact_text(data.get("created_by")) or None,
            ),
        )
    )
    row_dict = dict(row)
    row_dict["payload_json"] = payload_snapshot
    history = _serialize_history(row_dict)
    # Completion flag is parked: multiple ARCs may be issued for the same process sheet.
    if _APP_COMPLETION_ENABLED:
        mark_app_completion(
            con,
            sales_order_no=compact_text(data.get("sales_order_no")),
            sales_line_item_no=compact_text(data.get("sales_line_item_no")),
            process_sheet_no=_process_sheet_key(data),
            history_id=history.get("history_id"),
        )
    return {"history": history, "doc_nos": doc_nos, "variants": variants}


def save_history_pdf(
    con,
    history_id: int,
    pdf_bytes: bytes,
    *,
    filename: str,
    content_type: str = "application/pdf",
) -> None:
    _ensure_history_tables(con)
    con.execute(
        """
        UPDATE public.mro_arc_history
        SET
            pdf_bytes = %s,
            pdf_filename = %s,
            pdf_content_type = %s
        WHERE history_id = %s
        """,
        (psycopg2_binary(pdf_bytes), compact_text(filename) or None, compact_text(content_type) or "application/pdf", history_id),
    )


def load_history_pdf(con, history_id: int) -> dict[str, Any] | None:
    _ensure_history_tables(con)
    row = one(
        con.execute(
            """
            SELECT
                history_id,
                pdf_bytes,
                pdf_filename,
                pdf_content_type,
                payload_json,
                caas_doc_no,
                faa_doc_no,
                easa_doc_no,
                jcab_doc_no,
                caac_doc_no,
                variants,
                process_sheet_no,
                sales_order_no
            FROM public.mro_arc_history
            WHERE history_id = %s
            """,
            (history_id,),
        )
    )
    return dict(row) if row else None


def list_arc_history(con, *, limit: int = 500) -> list[dict[str, Any]]:
    _ensure_history_tables(con)
    limit = max(1, min(int(limit or 500), 2000))
    fetched = db_rows(
        con.execute(
            """
            SELECT
                history_id,
                caas_doc_no,
                faa_doc_no,
                easa_doc_no,
                jcab_doc_no,
                caac_doc_no,
                order_date,
                process_sheet_no,
                part_no,
                description,
                serial_no,
                customer_code,
                customer_po_no,
                po_item_no,
                so_qty,
                sales_order_no,
                sales_line_item_no,
                certifying_staff,
                cert_date,
                variants,
                payload_json,
                created_by,
                created_at,
                pdf_filename,
                (pdf_bytes IS NOT NULL) AS has_pdf
            FROM public.mro_arc_history
            ORDER BY created_at DESC, history_id DESC
            LIMIT %s
            """,
            (limit,),
        )
    )
    return [_serialize_history(dict(row)) for row in fetched]


def delete_arc_history(con, history_id: int) -> dict[str, Any] | None:
    """Delete one ARC history row (testing only — production will be immutable).

    Also clears the local app-completion flag so the line can show Incomplete again
    unless ERP already reports status C.
    """
    _ensure_history_tables(con)
    row = one(
        con.execute(
            """
            DELETE FROM public.mro_arc_history
            WHERE history_id = %s
            RETURNING
                history_id,
                caas_doc_no,
                faa_doc_no,
                easa_doc_no,
                jcab_doc_no,
                caac_doc_no,
                order_date,
                process_sheet_no,
                part_no,
                description,
                serial_no,
                customer_code,
                customer_po_no,
                po_item_no,
                so_qty,
                sales_order_no,
                sales_line_item_no,
                certifying_staff,
                cert_date,
                variants,
                created_by,
                created_at
            """,
            (history_id,),
        )
    )
    if not row:
        clear_app_completion_for_history(con, history_id)
        return None
    clear_app_completion_for_history(con, history_id)
    clear_app_completion_for_line(
        con,
        sales_order_no=compact_text(row.get("sales_order_no")),
        sales_line_item_no=compact_text(row.get("sales_line_item_no")),
        process_sheet_no=compact_text(row.get("process_sheet_no")),
    )
    return _serialize_history(dict(row))


def _fetch_mro(*, refresh: bool = False) -> dict[str, Any]:
    global _cache
    now = time.time()
    if not refresh and _cache and now - _cache[0] < _CACHE_TTL_SEC:
        rows = _cache[1]
        cached_at = _cache[0]
    else:
        rows = live_query(_MRO_SQL)
        _cache = (now, rows)
        cached_at = now

    # Always re-merge local completion flags (Create/Delete) even when ERP is cached.
    completion_keys: set[tuple[str, str, str]] = set()
    try:
        with planner_db() as con:
            completion_keys = load_app_completion_keys(con)
    except Exception:
        logger.exception("MRO app completion lookup failed; returning ERP status only")

    annotated = annotate_rows_with_completion(list(rows), completion_keys)
    return {
        "ok": True,
        "count": len(annotated),
        "rows": annotated,
        "cached_at": datetime.fromtimestamp(cached_at).isoformat(sep=" ", timespec="seconds"),
        "cache_ttl_sec": _CACHE_TTL_SEC,
    }


@mro_bp.get(MRO_PATH)
def mro_page():
    return render_template(
        "mro.html",
        mro_path=MRO_PATH,
        mro_asset_version=mro_asset_version(),
    )


if MRO_PATH != _DEFAULT_MRO_PATH:

    @mro_bp.get(_DEFAULT_MRO_PATH)
    def mro_legacy_redirect():
        return redirect(url_for("mro.mro_page"), code=301)


@mro_bp.get("/api/mro/arc-format")
def api_mro_arc_format():
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes", "on"}
    try:
        return jsonify(_fetch_mro(refresh=refresh))
    except Exception as exc:
        logger.exception("MRO ARC format ERP query failed")
        return jsonify({"ok": False, "error": str(exc)}), 502


@mro_bp.get("/api/mro/sales-order-header")
def api_mro_sales_order_header():
    sales_order_no = compact_text(request.args.get("sales_order_no"))
    if not sales_order_no:
        return jsonify({"ok": False, "error": "sales_order_no is required"}), 400
    refresh = compact_text(request.args.get("refresh")).lower() in {"1", "true", "yes", "on"}
    try:
        header = _fetch_so_header(sales_order_no, refresh=refresh)
        if not header:
            return jsonify({"ok": False, "error": f"Sales order {sales_order_no} not found"}), 404
        return jsonify({"ok": True, "header": header})
    except Exception as exc:
        logger.exception("MRO sales order header lookup failed for %s", sales_order_no)
        return jsonify({"ok": False, "error": str(exc)}), 502


@mro_bp.get("/api/mro/certifying-staff")
def api_mro_certifying_staff_list():
    try:
        with planner_db() as con:
            staff = load_certifying_staff(con)
        return jsonify({"ok": True, "staff": staff})
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("MRO certifying staff list failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mro_bp.post("/api/mro/certifying-staff")
def api_mro_certifying_staff_add():
    data = request.get_json(force=True, silent=True) or {}
    name = compact_text(data.get("name"))
    if not name:
        return jsonify({"ok": False, "error": "Name is required"}), 400
    try:
        with planner_db() as con:
            staff, created = add_certifying_staff(con, name)
        return jsonify(
            {
                "ok": True,
                "created": created,
                "staff": staff,
                "message": f"Added {staff['name']}" if created else f"{staff['name']} is already on the list",
            }
        )
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("MRO certifying staff add failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mro_bp.delete("/api/mro/certifying-staff/<int:staff_id>")
def api_mro_certifying_staff_delete(staff_id: int):
    try:
        with planner_db() as con:
            deleted = delete_certifying_staff(con, staff_id)
        if not deleted:
            return jsonify({"ok": False, "error": "Staff not found"}), 404
        return jsonify({"ok": True, "staff_id": staff_id})
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("MRO certifying staff delete failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mro_bp.post("/api/mro/certifying-staff/<int:staff_id>/signature")
def api_mro_certifying_staff_signature_upload(staff_id: int):
    upload = request.files.get("signature") or request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"ok": False, "error": "Choose a signature image file"}), 400
    mime = compact_text(upload.mimetype) or "application/octet-stream"
    try:
        image_bytes = upload.read()
        with planner_db() as con:
            staff = save_staff_signature(con, staff_id, image_bytes, mime)
        return jsonify({"ok": True, "staff": staff, "message": f"Signature saved for {staff['name']}"})
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("MRO certifying staff signature upload failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mro_bp.delete("/api/mro/certifying-staff/<int:staff_id>/signature")
def api_mro_certifying_staff_signature_clear(staff_id: int):
    try:
        with planner_db() as con:
            staff = clear_staff_signature(con, staff_id)
        return jsonify({"ok": True, "staff": staff, "message": f"Signature cleared for {staff['name']}"})
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("MRO certifying staff signature clear failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mro_bp.get("/api/mro/certifying-staff/<int:staff_id>/signature")
def api_mro_certifying_staff_signature_get(staff_id: int):
    try:
        with planner_db() as con:
            _ensure_staff_table(con)
            row = one(
                con.execute(
                    """
                    SELECT name, signature_image, signature_mime
                    FROM public.mro_certifying_staff
                    WHERE staff_id = %s
                      AND active = TRUE
                    """,
                    (staff_id,),
                )
            )
        if not row or row.get("signature_image") is None:
            return jsonify({"ok": False, "error": "No signature on file"}), 404
        mime = compact_text(row.get("signature_mime")) or "image/png"
        return send_file(
            io.BytesIO(bytes(row["signature_image"])),
            mimetype=mime,
            as_attachment=False,
            download_name=f"signature-{staff_id}.png",
        )
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("MRO certifying staff signature get failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mro_bp.get("/api/mro/arc-correction-templates")
def api_mro_arc_correction_templates():
    return jsonify({"ok": True, "templates": dict(ARC_CORRECTION_TEMPLATES)})


def _workscope_query_params(part_no: str, bom_code: str, pp_voucher_no: str, q: str) -> tuple:
    return (
        part_no,
        part_no,
        bom_code,
        bom_code,
        pp_voucher_no,
        pp_voucher_no,
        pp_voucher_no,
        q,
        q,
        q,
        q,
        q,
        pp_voucher_no,
        part_no,
    )


def split_remarks_status(text: str) -> tuple[str, str | None]:
    """Strip trailing status markers from BOM remarks.

    ERP remarks often append Status (Inspected/Tested) / Status: Repaired /
    or a bare parenthetical status. Returns (cleaned_remarks, STATUS_TOKEN).
    """
    raw = compact_text(text)
    if not raw:
        return "", None
    match = _STATUS_FROM_REMARKS_RE.search(raw)
    if not match:
        return raw, None
    token = (
        match.group("paren_status")
        or match.group("bare_status")
        or match.group("trail_paren")
        or ""
    )
    cleaned = raw[: match.start()].rstrip(" \t,;.-/")
    cleaned = compact_text(cleaned)
    status = compact_text(token).upper() or None
    # Allow empty workscope when remarks were only a status marker.
    return cleaned, status


def _format_workscope_remark_row(
    row: dict[str, Any],
    *,
    process_sheet_no: str = "",
) -> dict[str, Any] | None:
    remarks = compact_text(row.get("remarks"))
    if not remarks:
        return None
    cleaned, status = split_remarks_status(remarks)
    return {
        "pp_voucher_no": compact_text(row.get("pp_voucher_no")),
        "process_sheet_no": compact_text(process_sheet_no or row.get("process_sheet_no") or row.get("pp_voucher_no")),
        "inventory_code": compact_text(row.get("inventory_code")),
        "part_no": compact_text(row.get("inventory_code")),
        "bom_code": compact_text(row.get("bom_code")),
        "sales_order_no": compact_text(row.get("source_voucher_no")),
        "remarks": remarks,
        "remarks_trimmed": cleaned,
        "extracted_status": status,
    }


def _dedupe_workscope_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        if not row:
            continue
        key = "|".join(
            [
                compact_text(row.get("pp_voucher_no")),
                compact_text(row.get("inventory_code") or row.get("part_no")),
                compact_text(row.get("bom_code")),
                compact_text(row.get("remarks")),
            ]
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def _resolve_process_sheet_workscope(process_sheet_no: str) -> list[dict[str, Any]]:
    """Map a process sheet to its PP voucher part/BOM (and remarks when present)."""
    process_sheet_no = compact_text(process_sheet_no)
    if not process_sheet_no:
        return []
    params = (process_sheet_no, process_sheet_no, process_sheet_no)
    rows: list[dict[str, Any]] = []

    try:
        with planner_db() as con:
            fetched = db_rows(con.execute(_WORKSCOPE_PS_RESOLVE_STAGED_SQL, params))
            rows = [dict(row) for row in fetched]
    except Exception as exc:
        msg = str(exc).lower()
        if "does not exist" not in msg and "undefinedtable" not in msg:
            logger.warning("Staged process-sheet workscope resolve failed: %s", exc)

    if not rows:
        try:
            rows = live_query(_WORKSCOPE_PS_RESOLVE_LIVE_SQL, params)
        except Exception:
            logger.exception("Live process-sheet workscope resolve failed")
            raise

    out: list[dict[str, Any]] = []
    for row in rows:
        out.append(
            {
                "process_sheet_no": compact_text(row.get("process_sheet_no")),
                "pp_voucher_no": compact_text(row.get("pp_voucher_no")),
                "inventory_code": compact_text(row.get("inventory_code")),
                "bom_code": compact_text(row.get("bom_code")),
                "remarks": compact_text(row.get("remarks")),
                "source_voucher_no": compact_text(row.get("source_voucher_no")),
            }
        )
    return out


def _fetch_workscope_remark_rows(
    *,
    part_no: str = "",
    bom_code: str = "",
    pp_voucher_no: str = "",
    q: str = "",
) -> list[dict[str, Any]]:
    if not any((part_no, bom_code, pp_voucher_no, q)):
        return []
    params = _workscope_query_params(part_no, bom_code, pp_voucher_no, q)
    rows: list[dict[str, Any]] = []

    try:
        with planner_db() as con:
            fetched = db_rows(con.execute(_WORKSCOPE_REMARKS_STAGED_SQL, params))
            rows = [dict(row) for row in fetched]
    except Exception as exc:
        msg = str(exc).lower()
        if "does not exist" not in msg and "undefinedtable" not in msg:
            logger.warning("Staged workscope remarks lookup failed: %s", exc)

    if not rows:
        try:
            rows = live_query(_WORKSCOPE_REMARKS_SQL, params)
        except Exception:
            logger.exception("Live workscope remarks lookup failed")
            raise
    return rows


def search_workscope_remarks(
    *,
    part_no: str = "",
    bom_code: str = "",
    process_sheet_no: str = "",
    q: str = "",
) -> dict[str, Any]:
    """Search ERP PP voucher remarks by part / BOM / process sheet.

    Process sheet lookup resolves the assigned part_no + bom_code from the
    linked PP voucher, then returns that voucher's remarks (bom remarks).
    """
    part_no = compact_text(part_no)
    bom_code = compact_text(bom_code)
    process_sheet_no = compact_text(process_sheet_no)
    q = compact_text(q)
    if not any((part_no, bom_code, process_sheet_no, q)):
        return {"rows": [], "resolved": None}

    resolved: dict[str, Any] | None = None
    formatted: list[dict[str, Any]] = []

    if process_sheet_no:
        identities = _resolve_process_sheet_workscope(process_sheet_no)
        if not identities:
            # Process sheet not found — do not treat MPS… as a PP voucher no.
            if not any((part_no, bom_code, q)):
                return {"rows": [], "resolved": None}
        else:
            exact = [
                row
                for row in identities
                if compact_text(row.get("process_sheet_no")).lower() == process_sheet_no.lower()
            ]
            picks = exact or identities
            primary = picks[0]
            resolved = {
                "process_sheet_no": compact_text(primary.get("process_sheet_no")),
                "pp_voucher_no": compact_text(primary.get("pp_voucher_no")),
                "part_no": compact_text(primary.get("inventory_code")),
                "inventory_code": compact_text(primary.get("inventory_code")),
                "bom_code": compact_text(primary.get("bom_code")),
            }
            # Prefer identity from the process sheet over free-typed filters.
            part_no = resolved["part_no"] or part_no
            bom_code = resolved["bom_code"] or bom_code

            for row in picks:
                item = _format_workscope_remark_row(
                    {
                        "pp_voucher_no": row.get("pp_voucher_no"),
                        "inventory_code": row.get("inventory_code"),
                        "bom_code": row.get("bom_code"),
                        "remarks": row.get("remarks"),
                        "source_voucher_no": row.get("source_voucher_no"),
                    },
                    process_sheet_no=compact_text(row.get("process_sheet_no")),
                )
                if item and (not q or q.lower() in item["remarks"].lower()):
                    formatted.append(item)

            # Linked voucher has no remarks — fall back to same part + BOM.
            if not formatted and (part_no or bom_code):
                for row in _fetch_workscope_remark_rows(
                    part_no=part_no,
                    bom_code=bom_code,
                    q=q,
                ):
                    item = _format_workscope_remark_row(
                        row,
                        process_sheet_no=resolved["process_sheet_no"],
                    )
                    if item:
                        formatted.append(item)

            return {"rows": _dedupe_workscope_rows(formatted), "resolved": resolved}

    for row in _fetch_workscope_remark_rows(
        part_no=part_no,
        bom_code=bom_code,
        q=q,
    ):
        item = _format_workscope_remark_row(row)
        if item:
            formatted.append(item)
    return {"rows": _dedupe_workscope_rows(formatted), "resolved": resolved}


@mro_bp.get("/api/mro/workscope-remarks")
def api_mro_workscope_remarks():
    part_no = compact_text(request.args.get("part_no") or request.args.get("inventory_code"))
    bom_code = compact_text(request.args.get("bom_code"))
    process_sheet_no = compact_text(
        request.args.get("process_sheet_no")
        or request.args.get("pp_voucher_no")
        or request.args.get("ps")
    )
    q = compact_text(request.args.get("q") or request.args.get("search"))
    try:
        result = search_workscope_remarks(
            part_no=part_no,
            bom_code=bom_code,
            process_sheet_no=process_sheet_no,
            q=q,
        )
        rows = result.get("rows") or []
        return jsonify(
            {
                "ok": True,
                "count": len(rows),
                "rows": rows,
                "resolved": result.get("resolved"),
            }
        )
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("MRO workscope remarks search failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mro_bp.get("/api/mro/arc-history")
def api_mro_arc_history():
    try:
        with planner_db() as con:
            history = list_arc_history(con)
        return jsonify({"ok": True, "count": len(history), "rows": history})
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("MRO ARC history list failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mro_bp.delete("/api/mro/arc-history/<int:history_id>")
def api_mro_arc_history_delete(history_id: int):
    """Temporary testing endpoint — remove a created ARC from history."""
    try:
        with planner_db() as con:
            deleted = delete_arc_history(con, history_id)
        if not deleted:
            return jsonify({"ok": False, "error": "ARC history record not found"}), 404
        return jsonify({"ok": True, "history": deleted})
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("MRO ARC history delete failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mro_bp.post("/api/mro/create-arc")
def api_mro_create_arc():
    """Create ARC history with unique dummy serials, then return a single PDF."""
    data = request.get_json(force=True, silent=True) or {}
    variants = data.get("variants") or []
    if isinstance(variants, str):
        variants = [variants]
    if not variants:
        return jsonify({"ok": False, "error": "Select at least one variant (CAAS, FAA, EASA, JCAB, or CAAC)"}), 400
    if not compact_text(data.get("certifying_staff")):
        return jsonify({"ok": False, "error": "14d. Name (certifying staff) is required"}), 400

    try:
        data = _normalize_arc_payload_quantity(data)
        items = data.get("items") if isinstance(data.get("items"), list) else []
        if not items:
            return jsonify({"ok": False, "error": "Select at least one item line for the ARC"}), 400
        with planner_db() as con:
            created = create_arc_history(con, data)
            payload = dict(data)
            payload["doc_nos"] = created["doc_nos"]
            payload["variants"] = created["variants"]
            payload = _attach_staff_signature(payload)
            # Re-resolve signature inside the open planner connection context is fine;
            # _attach_staff_signature opens its own connection.
            payload_bytes, content_type, filename = generate_arc_documents(payload, list(created["variants"]))
            history_id = created["history"].get("history_id")
            if history_id:
                save_history_pdf(
                    con,
                    int(history_id),
                    payload_bytes,
                    filename=filename,
                    content_type=content_type,
                )
        response = send_file(
            io.BytesIO(payload_bytes),
            mimetype=content_type,
            as_attachment=True,
            download_name=filename,
        )
        history = created["history"]
        response.headers["X-MRO-History-Id"] = str(history.get("history_id") or "")
        response.headers["X-MRO-CAAS-Doc"] = history.get("caas_doc_no") or ""
        response.headers["X-MRO-FAA-Doc"] = history.get("faa_doc_no") or ""
        response.headers["X-MRO-EASA-Doc"] = history.get("easa_doc_no") or ""
        response.headers["X-MRO-JCAB-Doc"] = history.get("jcab_doc_no") or ""
        response.headers["X-MRO-CAAC-Doc"] = history.get("caac_doc_no") or ""
        response.headers["Access-Control-Expose-Headers"] = (
            "Content-Disposition, X-MRO-History-Id, X-MRO-CAAS-Doc, X-MRO-FAA-Doc, "
            "X-MRO-EASA-Doc, X-MRO-JCAB-Doc, X-MRO-CAAC-Doc"
        )
        return response
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("MRO ARC create failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mro_bp.get("/api/mro/arc-history/<int:history_id>/pdf")
def api_mro_arc_history_pdf(history_id: int):
    """Download the stored PDF for an immutable ARC history record."""
    try:
        with planner_db() as con:
            row = load_history_pdf(con, history_id)
        if not row:
            return jsonify({"ok": False, "error": "ARC history record not found"}), 404

        pdf_bytes = row.get("pdf_bytes")
        filename = compact_text(row.get("pdf_filename")) or f"ARC_history_{history_id}.pdf"
        content_type = compact_text(row.get("pdf_content_type")) or "application/pdf"

        if pdf_bytes is None:
            # Fallback for older history rows created before PDF storage.
            payload = row.get("payload_json") or {}
            if isinstance(payload, str):
                payload = json.loads(payload)
            if not isinstance(payload, dict):
                return jsonify({"ok": False, "error": "No PDF on file for this ARC"}), 404
            variants = payload.get("variants") or row.get("variants") or []
            if isinstance(variants, str):
                variants = [v for v in variants.strip("{}").split(",") if v]
            payload = _attach_staff_signature(dict(payload))
            pdf_bytes, content_type, filename = generate_arc_documents(payload, list(variants))
            with planner_db() as con:
                save_history_pdf(
                    con,
                    history_id,
                    pdf_bytes,
                    filename=filename,
                    content_type=content_type,
                )

        return send_file(
            io.BytesIO(bytes(pdf_bytes)),
            mimetype=content_type,
            as_attachment=False,
            download_name=filename,
        )
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        friendly = planner_db_connect_error(exc)
        if friendly:
            return jsonify({"ok": False, "error": friendly}), 503
        logger.exception("MRO ARC history PDF download failed")
        return jsonify({"ok": False, "error": str(exc)}), 500


@mro_bp.post("/api/mro/generate-arc-pdf")
def api_mro_generate_arc_pdf():
    data = request.get_json(force=True, silent=True) or {}
    variants = data.get("variants") or []
    if isinstance(variants, str):
        variants = [variants]
    if not variants:
        return jsonify({"ok": False, "error": "Select at least one variant (CAAS, FAA, EASA, JCAB, or CAAC)"}), 400
    if not compact_text(data.get("certifying_staff")):
        return jsonify({"ok": False, "error": "14d. Name (certifying staff) is required"}), 400
    try:
        data = _normalize_arc_payload_quantity(data)
        data = _attach_staff_signature(data)
        payload_bytes, content_type, filename = generate_arc_documents(data, list(variants))
        return send_file(
            io.BytesIO(payload_bytes),
            mimetype=content_type,
            as_attachment=True,
            download_name=filename,
        )
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        logger.exception("MRO ARC PDF generation failed")
        return jsonify({"ok": False, "error": str(exc)}), 500
