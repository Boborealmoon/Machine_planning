"""Planner overlays for PPS process sheets (PS-level remarks, flag, dates)."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from .helpers import one, rows
from .utils import compact_text

_ENSURED = False

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS public.planner_pps_sheet_overlay (
    ps_id           TEXT         NOT NULL,
    pp_partial_no   INTEGER      NOT NULL DEFAULT 1,
    remarks         TEXT         NOT NULL DEFAULT '',
    flagged         BOOLEAN      NOT NULL DEFAULT FALSE,
    material_date   DATE,
    delivery_week   TEXT         NOT NULL DEFAULT '',
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ps_id, pp_partial_no)
)
"""

_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_pps_sheet_overlay_flagged
    ON public.planner_pps_sheet_overlay (flagged)
    WHERE flagged = TRUE
"""

_MIGRATE_FROM_OP_SQL = """
INSERT INTO public.planner_pps_sheet_overlay
    (ps_id, pp_partial_no, remarks, flagged, material_date, delivery_week, updated_at)
SELECT
    UPPER(TRIM(ps_id)),
    pp_partial_no,
    COALESCE(
        NULLIF(TRIM(MAX(CASE WHEN NULLIF(TRIM(remarks), '') IS NOT NULL THEN remarks END)), ''),
        ''
    ),
    BOOL_OR(flagged),
    MAX(material_date),
    COALESCE(
        NULLIF(TRIM(MAX(CASE WHEN NULLIF(TRIM(delivery_week), '') IS NOT NULL THEN delivery_week END)), ''),
        ''
    ),
    MAX(updated_at)
FROM public.planner_pps_op_overlay
GROUP BY UPPER(TRIM(ps_id)), pp_partial_no
ON CONFLICT (ps_id, pp_partial_no) DO NOTHING
"""


def ensure_pps_overlay_tables(con) -> None:
    global _ENSURED
    if _ENSURED:
        return
    con.execute(_CREATE_SQL)
    con.execute(_INDEX_SQL)
    # Best-effort one-time lift from the old per-stage table if it exists.
    try:
        exists = one(
            con.execute(
                """
                SELECT 1 AS ok
                FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'planner_pps_op_overlay'
                """
            )
        )
        if exists:
            con.execute(_MIGRATE_FROM_OP_SQL)
    except Exception:
        pass
    _ENSURED = True


def _serialize_overlay(row: dict[str, Any] | None) -> dict[str, Any]:
    if not row:
        return {
            "ps_id": "",
            "pp_partial_no": 1,
            "remarks": "",
            "flagged": False,
            "material_date": None,
            "delivery_week": "",
            "updated_at": None,
        }
    material_date = row.get("material_date")
    if isinstance(material_date, (date, datetime)):
        material_date = material_date.isoformat()[:10]
    elif material_date is not None:
        material_date = compact_text(material_date)[:10] or None
    updated_at = row.get("updated_at")
    if isinstance(updated_at, datetime):
        updated_at = updated_at.isoformat(sep=" ", timespec="seconds")
    return {
        "ps_id": compact_text(row.get("ps_id")),
        "pp_partial_no": int(row.get("pp_partial_no") or 1),
        "remarks": compact_text(row.get("remarks")),
        "flagged": bool(row.get("flagged")),
        "material_date": material_date,
        "delivery_week": compact_text(row.get("delivery_week")),
        "updated_at": updated_at,
    }


def load_overlay(con, *, ps_id: str, pp_partial_no: int = 1) -> dict[str, Any]:
    ensure_pps_overlay_tables(con)
    ps = compact_text(ps_id).split("::", 1)[0].upper()
    partial = int(pp_partial_no or 1)
    if not ps:
        return _serialize_overlay(None)
    row = one(
        con.execute(
            """
            SELECT ps_id, pp_partial_no, remarks, flagged, material_date, delivery_week, updated_at
            FROM planner_pps_sheet_overlay
            WHERE ps_id = %s AND pp_partial_no = %s
            """,
            (ps, partial),
        )
    )
    return _serialize_overlay(row)


def load_overlays_for_keys(
    con,
    keys: list[tuple[str, int]],
) -> dict[tuple[str, int], dict[str, Any]]:
    ensure_pps_overlay_tables(con)
    if not keys:
        return {}
    ps_ids = sorted({compact_text(ps).upper() for ps, _ in keys if compact_text(ps)})
    if not ps_ids:
        return {}
    result: dict[tuple[str, int], dict[str, Any]] = {}
    for row in rows(
        con.execute(
            """
            SELECT ps_id, pp_partial_no, remarks, flagged, material_date, delivery_week, updated_at
            FROM planner_pps_sheet_overlay
            WHERE ps_id = ANY(%s)
            """,
            (ps_ids,),
        )
    ):
        key = (compact_text(row.get("ps_id")).upper(), int(row.get("pp_partial_no") or 1))
        result[key] = _serialize_overlay(row)
    return result


def upsert_sheet_overlay(
    con,
    *,
    ps_id: str,
    pp_partial_no: int = 1,
    remarks: str | None = None,
    flagged: bool | None = None,
    material_date: str | None = None,
    clear_material_date: bool = False,
    delivery_week: str | None = None,
) -> dict[str, Any]:
    ensure_pps_overlay_tables(con)
    ps = compact_text(ps_id).split("::", 1)[0].upper()
    partial = int(pp_partial_no or 1)
    if not ps:
        raise ValueError("ps_id is required")

    existing = one(
        con.execute(
            """
            SELECT remarks, flagged, material_date, delivery_week
            FROM planner_pps_sheet_overlay
            WHERE ps_id = %s AND pp_partial_no = %s
            """,
            (ps, partial),
        )
    )

    next_remarks = compact_text(existing.get("remarks")) if existing else ""
    next_flagged = bool(existing.get("flagged")) if existing else False
    next_material = existing.get("material_date") if existing else None
    next_week = compact_text(existing.get("delivery_week")) if existing else ""

    if remarks is not None:
        next_remarks = compact_text(remarks)
    if flagged is not None:
        next_flagged = bool(flagged)
    if clear_material_date:
        next_material = None
    elif material_date is not None:
        text = compact_text(material_date)[:10]
        next_material = text or None
    if delivery_week is not None:
        next_week = compact_text(delivery_week)

    if isinstance(next_material, datetime):
        next_material = next_material.date().isoformat()
    elif isinstance(next_material, date):
        next_material = next_material.isoformat()

    row = one(
        con.execute(
            """
            INSERT INTO planner_pps_sheet_overlay
                (ps_id, pp_partial_no, remarks, flagged, material_date, delivery_week, updated_at)
            VALUES (%s, %s, %s, %s, %s::date, %s, NOW())
            ON CONFLICT (ps_id, pp_partial_no) DO UPDATE SET
                remarks = EXCLUDED.remarks,
                flagged = EXCLUDED.flagged,
                material_date = EXCLUDED.material_date,
                delivery_week = EXCLUDED.delivery_week,
                updated_at = NOW()
            RETURNING ps_id, pp_partial_no, remarks, flagged, material_date, delivery_week, updated_at
            """,
            (ps, partial, next_remarks, next_flagged, next_material, next_week),
        )
    )
    return _serialize_overlay(row)
