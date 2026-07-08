"""Shared ERP machining-operation lookup (mt_inventory_bom_stage + WO machines)."""
from __future__ import annotations

from typing import Any, Callable

from .utils import compact_text

_BOM_MACHINING_OPS_SQL = """
    WITH bom_machining AS (
        SELECT
            inventory_code,
            bom_code,
            stage_no,
            stage_desc,
            CASE
                WHEN stage_desc ~ ' [0-9]+$'
                THEN substring(stage_desc FROM ' ([0-9]+)$')::INTEGER
                WHEN SPLIT_PART(stage_desc, ' ', 2) ~ '^\\d+$'
                THEN SPLIT_PART(stage_desc, ' ', 2)::INTEGER
                WHEN UPPER(SPLIT_PART(stage_desc, ' ', 2)) ~ '^OP[0-9]+$'
                THEN NULLIF(substring(UPPER(SPLIT_PART(stage_desc, ' ', 2)) FROM 'OP([0-9]+)'), '')::INTEGER
                ELSE NULL
            END AS op_no
        FROM public.mt_inventory_bom_stage
        WHERE stage_desc IS NOT NULL
          AND (
              stage_desc LIKE 'Turning%%'
           OR stage_desc LIKE 'Milling%%'
           OR stage_desc LIKE 'Turnmill%%'
          )
          AND inventory_code = %s
          AND UPPER(TRIM(bom_code)) = UPPER(TRIM(%s))
    ),

    wt_raw AS (
        SELECT
            t2.inventory_code,
            t1.voucher_no,
            t1.machine_no,
            t2.stage_desc,
            t3.total_acc_qty_produced,
            CASE WHEN t1.status = 'H' THEN 1 ELSE 0 END AS status_rank
        FROM mfg_wo_comp_vch t1
        LEFT JOIN mfg_mps_vch t2 ON t1.voucher_no = t2.wo_voucher_no
        LEFT JOIN mfg_wo_vch  t3 ON t1.voucher_no = t3.voucher_no
        WHERE t2.inventory_code = %s
          AND (
              t2.stage_desc LIKE 'Turning%%'
           OR t2.stage_desc LIKE 'Milling%%'
           OR t2.stage_desc LIKE 'Turnmill%%'
          )
    ),

    wt_ranked AS (
        SELECT *,
            ROW_NUMBER() OVER (
                PARTITION BY voucher_no
                ORDER BY total_acc_qty_produced DESC, status_rank DESC
            ) AS rn
        FROM wt_raw
    ),

    wo_machines AS (
        SELECT inventory_code, stage_desc, MIN(machine_no) AS machine_no
        FROM wt_ranked
        WHERE rn = 1
        GROUP BY inventory_code, stage_desc
    )

    SELECT
        b.inventory_code,
        b.bom_code,
        b.stage_no,
        b.stage_desc,
        b.op_no,
        w.machine_no,
        180::NUMERIC AS setup_time,
        20::NUMERIC AS cycle_time
    FROM bom_machining b
    LEFT JOIN wo_machines w
        ON  w.inventory_code = b.inventory_code
        AND w.stage_desc     = b.stage_desc
    ORDER BY
        b.stage_no  ASC,
        b.op_no     ASC NULLS LAST
"""

_MACHINING_OP_COUNT_SQL = """
    SELECT bom_code, COUNT(*)::INTEGER AS op_count
    FROM public.mt_inventory_bom_stage
    WHERE inventory_code = %s
      AND bom_code IS NOT NULL
      AND (
          stage_desc LIKE 'Turning%%'
       OR stage_desc LIKE 'Milling%%'
       OR stage_desc LIKE 'Turnmill%%'
      )
    GROUP BY bom_code
"""


def _row_to_op(row: tuple | dict[str, Any]) -> dict[str, Any]:
    if isinstance(row, dict):
        return {
            "inventory_code": compact_text(row.get("inventory_code")),
            "bom_code": compact_text(row.get("bom_code")),
            "stage_no": row.get("stage_no"),
            "stage_desc": compact_text(row.get("stage_desc")),
            "op_no": row.get("op_no"),
            "machine_no": compact_text(row.get("machine_no")),
            "setup_time": float(row.get("setup_time") or 180),
            "cycle_time": float(row.get("cycle_time") or 20),
        }
    return {
        "inventory_code": compact_text(row[0]),
        "bom_code": compact_text(row[1]),
        "stage_no": row[2],
        "stage_desc": compact_text(row[3]),
        "op_no": row[4],
        "machine_no": compact_text(row[5]),
        "setup_time": float(row[6] if len(row) > 6 else 180),
        "cycle_time": float(row[7] if len(row) > 7 else 20),
    }


def fetch_machining_operations(db_query: Callable, inventory_code: str, bom_code: str) -> list[dict[str, Any]]:
    """Same ERP machining steps as GET /api/bom/operations (Steps modal)."""
    inventory_code = compact_text(inventory_code)
    bom_code = compact_text(bom_code)
    if not inventory_code or not bom_code:
        return []
    rows = db_query(
        _BOM_MACHINING_OPS_SQL,
        (inventory_code, bom_code, inventory_code),
        fetchall=True,
    ) or []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        op = _row_to_op(row)
        op_key = compact_text(op.get("op_no"))
        if not op_key or op_key in seen:
            continue
        seen.add(op_key)
        out.append(op)
    return out


def machining_op_counts_by_bom(db_query: Callable, inventory_code: str) -> dict[str, int]:
    inventory_code = compact_text(inventory_code)
    if not inventory_code:
        return {}
    rows = db_query(_MACHINING_OP_COUNT_SQL, (inventory_code,), fetchall=True) or []
    out: dict[str, int] = {}
    for row in rows:
        code = compact_text(row[0] if not isinstance(row, dict) else row.get("bom_code"))
        count = int((row[1] if not isinstance(row, dict) else row.get("op_count")) or 0)
        if code:
            out[code] = count
    return out
