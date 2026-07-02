"""Frame agreement parts — master list for S/O flags and MPP planner intake."""
from __future__ import annotations

import logging
import re
from typing import Any, Callable

import psycopg2.extras

from .bom_materials import _list_bom_codes_with_counts, resolve_bom_materials
from .helpers import one, rows
from .utils import compact_text

logger = logging.getLogger(__name__)

_SCHEMA_READY = False
_PART_KEY_RE = re.compile(r"\s+")


def normalize_part_key(part_no: str) -> str:
    return _PART_KEY_RE.sub(" ", compact_text(part_no)).upper()


def ensure_frame_agreement_schema(con) -> None:
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_frame_agreement_part (
            part_no     TEXT         PRIMARY KEY,
            notes       TEXT         NOT NULL DEFAULT '',
            created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_frame_agreement_part_updated
            ON planner_frame_agreement_part (updated_at DESC)
        """
    )
    _SCHEMA_READY = True


_BOM_STAGE_FILTER = """
      AND (
          s.stage_desc LIKE 'Turning%%'
       OR s.stage_desc LIKE 'Milling%%'
       OR s.stage_desc LIKE 'Turnmill%%'
      )
"""


def _erp_query_dict(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    from db import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]
    finally:
        release_conn(conn)


def _erp_query_one(sql: str, params: tuple = ()) -> dict[str, Any] | None:
    hits = _erp_query_dict(sql, params)
    return hits[0] if hits else None


def _format_qty_per_fg(row: dict[str, Any]) -> str:
    from_api = row.get("qty_per_fg")
    if from_api is not None:
        try:
            val = float(from_api)
            if val > 0:
                return str(int(val)) if val == int(val) else f"{val:.4f}".rstrip("0").rstrip(".")
        except (TypeError, ValueError):
            pass
    try:
        parent = float(row.get("qty_parent") or 0)
        fg = float(row.get("qty_fg") or 0)
    except (TypeError, ValueError):
        return ""
    if parent <= 0:
        return ""
    if fg <= 0 or abs(parent - fg) < 1e-9:
        return str(int(parent)) if parent == int(parent) else f"{parent:.4f}".rstrip("0").rstrip(".")
    val = parent / fg
    return str(int(val)) if val == int(val) else f"{val:.4f}".rstrip("0").rstrip(".")


def _summarize_bom_materials(bom_rows: list[dict[str, Any]]) -> dict[str, str]:
    if not bom_rows:
        return {
            "primary_material": "",
            "primary_material_desc": "",
            "qty_per_fg": "",
            "material_count": "0",
        }
    primary = bom_rows[0]
    return {
        "primary_material": compact_text(primary.get("material_inventory_code")),
        "primary_material_desc": compact_text(primary.get("description")),
        "qty_per_fg": _format_qty_per_fg(primary),
        "material_count": str(len(bom_rows)),
    }


def search_frame_agreement_parts(db_query: Callable, search: str, *, limit: int = 25) -> list[dict[str, Any]]:
    """Search ERP inventory codes that have CNC BOM routes."""
    needle = compact_text(search)
    if not needle:
        return []
    like = f"%{needle}%"
    sql = f"""
        SELECT
            s.inventory_code AS part_no,
            COUNT(DISTINCT s.bom_code) AS bom_count,
            MAX(COALESCE(NULLIF(BTRIM(i.main_desc), ''), NULLIF(BTRIM(i.short_desc), ''), '')) AS description
        FROM public.mt_inventory_bom_stage s
        LEFT JOIN public.ic_inventory_enquiry_summary_view i
            ON i.inventory_code = s.inventory_code
        WHERE s.bom_code IS NOT NULL
        {_BOM_STAGE_FILTER}
          AND s.inventory_code ILIKE %s
        GROUP BY s.inventory_code
        ORDER BY s.inventory_code
        LIMIT %s
    """
    raw = db_query(sql, (like, limit), fetchall=True) or []
    out: list[dict[str, Any]] = []
    for row in raw:
        part_no = compact_text(row[0])
        if not part_no:
            continue
        out.append(
            {
                "part_no": part_no,
                "bom_count": int(row[1] or 0),
                "description": compact_text(row[2]),
            }
        )
    return out


def _build_bom_variants(
    db_query: Callable, part_no: str, bom_codes: list[str]
) -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []
    for code in bom_codes:
        result = resolve_bom_materials(db_query, part_no, code)
        bom_rows = list(result.get("rows") or [])
        if code:
            filtered = [row for row in bom_rows if compact_text(row.get("bom_code")) == code]
            if filtered:
                bom_rows = filtered
        summary = _summarize_bom_materials(bom_rows)
        variants.append(
            {
                "bom_code": code,
                "primary_material": summary["primary_material"],
                "primary_material_desc": summary["primary_material_desc"],
                "qty_per_fg": summary["qty_per_fg"],
                "material_count": int(summary["material_count"] or 0),
            }
        )
    return variants


def fetch_frame_agreement_part_preview(
    db_query: Callable, part_no: str, bom_code: str | None = None
) -> dict[str, Any]:
    """ERP snapshot for confirm modal — description, BOM, materials."""
    part_no = compact_text(part_no)
    if not part_no:
        raise ValueError("part_no is required")

    inv = _erp_query_one(
        """
        SELECT
            inventory_code,
            main_desc,
            short_desc,
            inventory_class_code,
            total_qty_on_hand,
            total_qty_on_order,
            total_free_balance_qty
        FROM public.ic_inventory_enquiry_summary_view
        WHERE inventory_code = %s
        LIMIT 1
        """,
        (part_no,),
    )

    bom_codes_raw = db_query(
        f"""
        SELECT DISTINCT bom_code
        FROM public.mt_inventory_bom_stage s
        WHERE inventory_code = %s
          AND bom_code IS NOT NULL
          {_BOM_STAGE_FILTER}
        ORDER BY bom_code
        """,
        (part_no,),
        fetchall=True,
    ) or []
    stage_codes = [compact_text(row[0]) for row in bom_codes_raw if compact_text(row[0])]
    listing_codes = [code for code, _count in _list_bom_codes_with_counts(db_query, part_no)]
    bom_codes = sorted(set(stage_codes + listing_codes))
    selected_bom = compact_text(bom_code) or (bom_codes[0] if bom_codes else "")

    bom_result = resolve_bom_materials(db_query, part_no, selected_bom or None)
    bom_rows = list(bom_result.get("rows") or [])
    if selected_bom:
        filtered = [row for row in bom_rows if compact_text(row.get("bom_code")) == selected_bom]
        if filtered:
            bom_rows = filtered
    summary = _summarize_bom_materials(bom_rows)
    bom_variants = _build_bom_variants(db_query, part_no, bom_codes) if bom_codes else []

    description = compact_text(inv.get("main_desc") if inv else "")
    if not description and inv:
        description = compact_text(inv.get("short_desc"))

    active_bom = (
        selected_bom
        or compact_text(bom_result.get("resolved_bom_code"))
        or (bom_codes[0] if bom_codes else "")
    )

    return {
        "part_no": part_no,
        "description": description,
        "inventory_class": compact_text(inv.get("inventory_class_code") if inv else ""),
        "stock_on_hand": float(inv.get("total_qty_on_hand") or 0) if inv else None,
        "stock_on_order": float(inv.get("total_qty_on_order") or 0) if inv else None,
        "stock_free_balance": float(inv.get("total_free_balance_qty") or 0) if inv else None,
        "bom_codes": bom_codes,
        "bom_variants": bom_variants,
        "bom_code": active_bom,
        "materials": bom_rows,
        "material_count": len(bom_rows),
        "primary_material": summary["primary_material"],
        "primary_material_desc": summary["primary_material_desc"],
        "qty_per_fg": summary["qty_per_fg"],
        "match_mode": compact_text(bom_result.get("match_mode")),
        "notice": compact_text(bom_result.get("notice")),
    }


def enrich_frame_agreement_part(db_query: Callable, row: dict[str, Any]) -> dict[str, Any]:
    """Attach ERP summary fields to a stored frame-agreement row."""
    part_no = compact_text(row.get("part_no"))
    if not part_no:
        return row
    try:
        preview = fetch_frame_agreement_part_preview(db_query, part_no)
    except Exception as exc:
        logger.warning("frame agreement enrich failed for %s: %s", part_no, exc)
        return {
            **row,
            "description": "",
            "bom_code": "",
            "primary_material": "",
            "qty_per_fg": "",
            "material_count": 0,
            "enrich_error": str(exc),
        }
    return {
        **row,
        "description": preview.get("description") or "",
        "bom_codes": preview.get("bom_codes") or [],
        "bom_variants": preview.get("bom_variants") or [],
        "bom_code": preview.get("bom_code") or "",
        "primary_material": preview.get("primary_material") or "",
        "primary_material_desc": preview.get("primary_material_desc") or "",
        "qty_per_fg": preview.get("qty_per_fg") or "",
        "material_count": preview.get("material_count") or 0,
        "inventory_class": preview.get("inventory_class") or "",
    }


def serialize_part_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    part_no = compact_text(row.get("part_no"))
    if not part_no:
        return None
    out = {
        "part_no": part_no,
        "notes": compact_text(row.get("notes")),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }
    for key in (
        "description",
        "bom_code",
        "bom_codes",
        "bom_variants",
        "primary_material",
        "primary_material_desc",
        "qty_per_fg",
        "material_count",
        "inventory_class",
    ):
        if key in row:
            out[key] = row.get(key)
    return out


def list_frame_agreement_parts(con, *, search: str = "") -> list[dict[str, Any]]:
    ensure_frame_agreement_schema(con)
    q = compact_text(search).lower()
    if q:
        like = f"%{q}%"
        raw = rows(
            con.execute(
                """
                SELECT part_no, notes, created_at, updated_at
                FROM planner_frame_agreement_part
                WHERE LOWER(part_no) LIKE %s OR LOWER(notes) LIKE %s
                ORDER BY part_no
                """,
                (like, like),
            )
        )
    else:
        raw = rows(
            con.execute(
                """
                SELECT part_no, notes, created_at, updated_at
                FROM planner_frame_agreement_part
                ORDER BY part_no
                """
            )
        )
    out = [serialize_part_row(dict(row)) for row in raw]
    return [row for row in out if row]


def load_frame_agreement_part_keys(con) -> set[str]:
    ensure_frame_agreement_schema(con)
    keys: set[str] = set()
    for row in rows(con.execute("SELECT part_no FROM planner_frame_agreement_part")):
        key = normalize_part_key(row.get("part_no"))
        if key:
            keys.add(key)
    return keys


def is_frame_agreement_part(part_no: str, keys: set[str] | None = None) -> bool:
    key = normalize_part_key(part_no)
    if not key or not keys:
        return False
    return key in keys


def add_frame_agreement_part(con, part_no: str, *, notes: str = "") -> dict[str, Any]:
    ensure_frame_agreement_schema(con)
    part_no = compact_text(part_no)
    if not part_no:
        raise ValueError("part_no is required")
    notes = compact_text(notes)
    row = one(
        con.execute(
            """
            INSERT INTO planner_frame_agreement_part (part_no, notes, updated_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (part_no) DO UPDATE SET
                notes = EXCLUDED.notes,
                updated_at = NOW()
            RETURNING part_no, notes, created_at, updated_at
            """,
            (part_no, notes),
        )
    )
    return serialize_part_row(row) or {"part_no": part_no, "notes": notes}


def update_frame_agreement_part(con, part_no: str, *, notes: str) -> dict[str, Any] | None:
    ensure_frame_agreement_schema(con)
    part_no = compact_text(part_no)
    if not part_no:
        raise ValueError("part_no is required")
    row = one(
        con.execute(
            """
            UPDATE planner_frame_agreement_part
            SET notes = %s, updated_at = NOW()
            WHERE part_no = %s
            RETURNING part_no, notes, created_at, updated_at
            """,
            (compact_text(notes), part_no),
        )
    )
    return serialize_part_row(row)


def delete_frame_agreement_part(con, part_no: str) -> bool:
    ensure_frame_agreement_schema(con)
    part_no = compact_text(part_no)
    if not part_no:
        return False
    cur = con.execute(
        "DELETE FROM planner_frame_agreement_part WHERE part_no = %s",
        (part_no,),
    )
    return bool(getattr(cur, "rowcount", 0))


def apply_frame_agreement_flags(orders: list[dict[str, Any]], keys: set[str]) -> None:
    if not keys:
        return
    for order in orders:
        for pp in order.get("pp_vouchers") or []:
            pp_code = compact_text(pp.get("inventory_code"))
            pp["is_frame_agreement"] = is_frame_agreement_part(pp_code, keys)
            for partial in pp.get("partials") or []:
                partial_code = compact_text(partial.get("inventory_code")) or pp_code
                partial["is_frame_agreement"] = is_frame_agreement_part(partial_code, keys)


_MPP_JOBS_SQL = """
WITH fa AS (
    SELECT TRIM(part_no) AS part_no, notes
    FROM planner_frame_agreement_part
),
partials AS (
    SELECT
        c.ps_id,
        c.pp_partial_no,
        MAX(TRIM(c.part_no)) AS part_no,
        MAX(TRIM(COALESCE(c.description, ''))) AS part_desc,
        MAX(NULLIF(TRIM(c.bom_code), '')) AS bom_code,
        MIN(c.due_date) AS due_date,
        MAX(COALESCE(c.partial_qty, c.total_qty, 0)) AS qty,
        MAX(COALESCE(c.status, '')) AS status,
        MAX(COALESCE(c.qty_shipped, 0)) AS qty_shipped
    FROM pp_vouchers_cache c
    INNER JOIN fa ON UPPER(TRIM(c.part_no)) = UPPER(fa.part_no)
    WHERE COALESCE(NULLIF(TRIM(c.ps_id), ''), '') <> ''
      AND COALESCE(NULLIF(TRIM(c.part_no), ''), '') <> ''
      AND (
            UPPER(TRIM(COALESCE(c.status, ''))) IN ('O', 'OUTSTANDING')
         OR (
                UPPER(TRIM(COALESCE(c.status, ''))) NOT IN ('HISTORY', 'H', 'COMPLETE', 'COMPLETED', 'CLOSED')
            AND COALESCE(c.partial_qty, c.total_qty, 0) > COALESCE(c.qty_shipped, 0)
         )
      )
    GROUP BY c.ps_id, c.pp_partial_no
    HAVING MAX(COALESCE(c.partial_qty, c.total_qty, 0)) > 0
),
mpp_steps AS (
    SELECT
        bv.inventory_code AS part_no,
        TRIM(COALESCE(bv.bom_code, '')) AS bom_code,
        os.op_seq_id,
        os.seq_no,
        os.op_no,
        os.op_type,
        os.machine_category,
        os.preferred_machine
    FROM planner_operation_seq os
    JOIN planner_bom_variation bv ON bv.bom_id = os.bom_id
    WHERE UPPER(COALESCE(os.machine_category, '')) = 'MPP'
       OR UPPER(TRIM(COALESCE(os.preferred_machine, ''))) IN (
            SELECT UPPER(TRIM(machine_no))
            FROM planner_machines
            WHERE COALESCE(active, TRUE) = TRUE
              AND UPPER(COALESCE(machine_category, '')) = 'MPP'
            UNION
            SELECT 'CNC 41'
       )
),
ctm AS (
    SELECT
        TRIM(part_no) AS part_no,
        TRIM(COALESCE(bom_code, '')) AS bom_code,
        op_no,
        stage_name,
        op_type,
        MAX(COALESCE(cycle_time, ideal_cycle_time, 0)) AS cycle_time
    FROM planner_cycle_time_master
    GROUP BY TRIM(part_no), TRIM(COALESCE(bom_code, '')), op_no, stage_name, op_type
)
SELECT
    p.ps_id,
    p.pp_partial_no,
    p.part_no,
    p.part_desc,
    p.bom_code,
    p.due_date,
    p.qty,
    p.status,
    m.op_seq_id,
    m.seq_no,
    m.op_no,
    m.op_type,
    m.machine_category,
    m.preferred_machine,
    COALESCE(ct.cycle_time, 0) AS cycle_time,
    COALESCE(ct.stage_name, '') AS stage_name,
    COALESCE(erp.erp_acc_qty, 0) AS erp_acc_qty,
    COALESCE(erp.erp_req_qty, 0) AS erp_req_qty
FROM partials p
JOIN mpp_steps m
  ON UPPER(TRIM(m.part_no)) = UPPER(TRIM(p.part_no))
 AND (
        TRIM(COALESCE(m.bom_code, '')) = ''
     OR TRIM(COALESCE(p.bom_code, '')) = ''
     OR TRIM(m.bom_code) = TRIM(p.bom_code)
 )
LEFT JOIN ctm ct
  ON UPPER(TRIM(ct.part_no)) = UPPER(TRIM(p.part_no))
 AND (
        TRIM(COALESCE(ct.bom_code, '')) = ''
     OR TRIM(COALESCE(p.bom_code, '')) = ''
     OR TRIM(ct.bom_code) = TRIM(p.bom_code)
 )
 AND (
        ct.op_no IS NULL
     OR m.op_no IS NULL
     OR ct.op_no::TEXT = m.op_no::TEXT
 )
LEFT JOIN LATERAL (
    SELECT
        MAX(COALESCE(ws.total_acc_qty_produced, c.wo_qty_produced, 0)) AS erp_acc_qty,
        MAX(COALESCE(ws.wo_qty_required, c.wo_qty_required, 0)) AS erp_req_qty
    FROM pp_vouchers_cache c
    LEFT JOIN mfg_wo_status ws
           ON ws.source_mps_no = c.ps_id
          AND ws.pp_partial_no = c.pp_partial_no
          AND ws.stage_no = c.stage_no
          AND TRIM(COALESCE(ws.stage_desc, '')) = TRIM(COALESCE(c.stage_desc, ''))
    WHERE c.ps_id = p.ps_id
      AND c.pp_partial_no = p.pp_partial_no
      AND (
            TRIM(COALESCE(c.op_no::text, '')) = TRIM(COALESCE(m.op_no::text, ''))
         OR (
                TRIM(COALESCE(c.op_no::text, '')) <> ''
            AND TRIM(COALESCE(m.op_no::text, '')) <> ''
            AND LTRIM(UPPER(TRIM(COALESCE(c.op_no::text, ''))), 'OP')
                = LTRIM(UPPER(TRIM(COALESCE(m.op_no::text, ''))), 'OP')
         )
         OR c.stage_no::text = TRIM(COALESCE(m.op_no::text, ''))
      )
) erp ON TRUE
ORDER BY p.due_date NULLS LAST, p.ps_id, m.seq_no
"""


def _op_label(op_no: Any, op_type: str, stage_name: str) -> str:
    op_no_text = compact_text(op_no)
    op_type_text = compact_text(op_type)
    stage_text = compact_text(stage_name)
    if op_no_text and op_type_text:
        return f"OP{op_no_text} {op_type_text} {op_no_text}".strip()
    if stage_text:
        return stage_text
    if op_type_text:
        return op_type_text
    return "MPP op"


def fetch_mpp_job_candidates(con, *, mpp_machine_codes: set[str] | None = None) -> list[dict[str, Any]]:
    """Open frame-agreement jobs with MPP routing — ERP fallback for MPP planner."""
    ensure_frame_agreement_schema(con)
    keys = load_frame_agreement_part_keys(con)
    if not keys:
        return []

    raw_rows = rows(con.execute(_MPP_JOBS_SQL))
    jobs: list[dict[str, Any]] = []
    seen: set[str] = set()

    for row in raw_rows:
        ps_id = compact_text(row.get("ps_id"))
        op_seq_id = int(row.get("op_seq_id") or 0)
        if not ps_id or op_seq_id <= 0:
            continue
        job_id = f"{ps_id.lower()}::p{int(row.get('pp_partial_no') or 1)}::op{compact_text(row.get('op_no')) or op_seq_id}"
        if job_id in seen:
            continue
        seen.add(job_id)

        part_no = compact_text(row.get("part_no"))
        op_label = _op_label(row.get("op_no"), row.get("op_type"), row.get("stage_name"))
        cycle_time = float(row.get("cycle_time") or 0)
        min_per_pallet = max(1, int(round(cycle_time))) if cycle_time > 0 else 90
        wo_qty = float(row.get("erp_req_qty") or row.get("qty") or 0)
        erp_acc = max(0.0, float(row.get("erp_acc_qty") or 0))
        remaining = max(0.0, wo_qty - erp_acc) if wo_qty > 0 else 0.0

        jobs.append(
            {
                "jobId": job_id,
                "sourcePsId": ps_id,
                "psId": ps_id,
                "ppPartialNo": int(row.get("pp_partial_no") or 1),
                "opSeqId": op_seq_id,
                "partNo": part_no,
                "partDesc": compact_text(row.get("part_desc")),
                "opLabel": op_label,
                "minPerPallet": min_per_pallet,
                "pcsPerPallet": 1,
                "defaultPalletsPerCycle": 1,
                "qty": wo_qty or remaining,
                "out": erp_acc,
                "remainingQty": remaining,
                "requiredQty": wo_qty,
                "erpFinished": erp_acc,
                "plannedQty": 0,
                "schedulable": remaining > 0,
                "blockedReason": "" if remaining > 0 else ("ERP complete" if erp_acc > 0 else ""),
                "due": compact_text(row.get("due_date")),
                "bomCode": compact_text(row.get("bom_code")),
                "preferredMachine": compact_text(row.get("preferred_machine")),
                "machineCategory": compact_text(row.get("machine_category")) or "MPP",
                "status": compact_text(row.get("status")),
                "isFrameAgreement": True,
            }
        )
    return jobs
