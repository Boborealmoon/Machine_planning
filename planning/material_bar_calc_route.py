"""API for simple PS material calculator (per-unit + buffer ? target; issued batches ? returnable)."""
from __future__ import annotations

import io
import json
import os
import re

from flask import Blueprint, jsonify, request, session, send_file

from .bom_materials import resolve_bom_materials, resolve_material_per_bom_planner
from .bom_operations import fetch_machining_operations
from .helpers import one, planner_db, rows
from .material_bar_calc import (
    compute_calc,
    cnc_machines_from_assignments,
    normalize_cnc_machines,
    normalize_op_assignments,
    normalize_uom,
    row_to_payload,
    uom_kind,
)
from .material_issue_slip_pdf import parse_slip_date, slip_pdf_from_calc_records
from .machines import fetch_machines
from .materials import _bom_qty_per_fg
from .process_sheets import (
    ensure_planner_process_sheet,
    format_planner_ps_id,
    normalize_standard_ps_id,
    parse_planner_ps_id,
    search_process_sheet_sources,
)
from .utils import bom_code_match_key, compact_text, parse_number

material_bar_calc_bp = Blueprint("material_bar_calc", __name__)


def _erp_db_query(sql, params=(), fetchone=False, fetchall=False):
    from db import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            if fetchone:
                return cur.fetchone()
            if fetchall:
                return cur.fetchall()
            return None
    except Exception:
        raise
    finally:
        release_conn(conn)


def _material_display_label(code, desc) -> str:
    code = compact_text(code)
    desc = compact_text(desc)
    if code and desc and desc != code:
        return f"{code} - {desc}"
    return code or desc


def _bom_row_to_material(row, bom_code_fallback="") -> dict:
    code = compact_text(row.get("material_inventory_code"))
    desc = compact_text(row.get("description"))
    qty = parse_number(row.get("qty_per_fg"))
    if qty <= 0:
        qty = _bom_qty_per_fg(row)
    return {
        "material_inventory_code": code,
        "material_type_grade": _material_display_label(code, desc),
        "material_description": desc,
        "material_uom": compact_text(row.get("uom_code")),
        "bom_qty_per_fg": qty,
        "bom_code": compact_text(row.get("bom_code")) or bom_code_fallback,
    }


def _source_inventory_candidates(con, planner_ps_id, part_no, source_ps_id="") -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()

    def add(value) -> None:
        text = compact_text(value)
        if not text or text in seen:
            return
        seen.add(text)
        candidates.append(text)

    add(part_no)
    if part_no:
        base = re.sub(r"\s+REV\s+\S.*$", "", part_no, flags=re.I).strip()
        add(base)

    ps_row = one(
        con.execute(
            """
            SELECT ps.inventory_code,
                   COALESCE(sf.bom_code, '') AS selected_flow_code
            FROM planner_process_sheet ps
            LEFT JOIN planner_bom_variation sf ON sf.bom_id = ps.selected_bom_id
            WHERE ps.planner_ps_id = %s
            """,
            (compact_text(planner_ps_id),),
        )
    )
    add((ps_row or {}).get("inventory_code"))

    source_ps_id = compact_text(source_ps_id) or compact_text(parse_planner_ps_id(planner_ps_id)[0])
    if source_ps_id:
        mfg = one(
            con.execute(
                """
                SELECT MAX(inventory_code) AS inventory_code
                FROM mfg_process_sheet_info
                WHERE process_sheet_no = %s
                """,
                (source_ps_id,),
            )
        )
        add((mfg or {}).get("inventory_code"))

    return candidates


def _resolve_bom_materials_list(con, sources, bom_code) -> list[dict]:
    requested_bom = compact_text(bom_code)
    for source in sources:
        result = resolve_material_per_bom_planner(con, source, requested_bom)
        rows_out = result.get("rows") or []
        if rows_out:
            resolved_bom = compact_text(result.get("resolved_bom_code")) or requested_bom
            return [_bom_row_to_material(row, resolved_bom) for row in rows_out]

    try:
        for source in sources:
            result = resolve_bom_materials(_erp_db_query, source, requested_bom)
            rows_out = result.get("rows") or []
            if rows_out:
                resolved_bom = compact_text(result.get("resolved_bom_code")) or requested_bom
                return [_bom_row_to_material(row, resolved_bom) for row in rows_out]
    except Exception:
        pass
    return []


def _resolve_bom_material(con, sources, bom_code) -> dict:
    mats = _resolve_bom_materials_list(con, sources, bom_code)
    if mats:
        return mats[0]
    return {
        "material_inventory_code": "",
        "material_type_grade": "",
        "material_description": "",
        "material_uom": "",
        "bom_qty_per_fg": 0.0,
        "bom_code": compact_text(bom_code),
    }


def _prefill_uom_and_per_unit(raw_uom, bom_qty, material_code="", description="") -> tuple[str, float]:
    material_uom = normalize_uom(raw_uom) if compact_text(raw_uom) else ""
    per_unit = parse_number(bom_qty)

    if material_uom == "m":
        per_unit = per_unit * 1000
        material_uom = "mm"

    if not material_uom:
        desc_upper = compact_text(description).upper()
        code_upper = compact_text(material_code).upper()
        if uom_kind(raw_uom or "EA") == "count" or "CFM" in desc_upper or "FORGING" in desc_upper:
            material_uom = "pcs"
        elif per_unit > 0 and per_unit == int(per_unit) and per_unit <= 20:
            material_uom = "pcs"
        else:
            material_uom = "mm"

    if per_unit <= 0 and material_uom == "pcs":
        per_unit = 1.0

    return material_uom, per_unit


def _ops_from_planner_bom_stage(con, sources: list[str], bom_code: str) -> list[dict]:
    """Machining ops from synced bom_op_stage (planner DB)."""
    bom_code = compact_text(bom_code)
    wanted = bom_code_match_key(bom_code)
    out: list[dict] = []
    seen: set[str] = set()
    for source in sources:
        source = compact_text(source)
        if not source:
            continue
        stage_rows = rows(
            con.execute(
                """
                SELECT inventory_code, bom_code, stage_no, stage_desc, op_no, op_index
                FROM bom_op_stage
                WHERE inventory_code = %s
                ORDER BY bom_code, stage_no, op_index NULLS LAST, op_no NULLS LAST
                """,
                (source,),
            )
        )
        matched = []
        if bom_code:
            for row in stage_rows:
                if compact_text(row.get("bom_code")) == bom_code:
                    matched.append(row)
            if not matched and wanted:
                for row in stage_rows:
                    if bom_code_match_key(row.get("bom_code")) == wanted:
                        matched.append(row)
        if not matched:
            matched = stage_rows
        for row in matched:
            op_no = row.get("op_no")
            if op_no is None or op_no == "":
                # Fall back to trailing number in stage_desc
                desc = compact_text(row.get("stage_desc"))
                m = re.search(r"(\d+)\s*$", desc)
                op_no = int(m.group(1)) if m else None
            key = compact_text(op_no)
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "op_no": op_no,
                    "stage_no": row.get("stage_no"),
                    "stage_desc": compact_text(row.get("stage_desc")),
                    "operation_label": f"Operation {op_no}",
                }
            )
        if out:
            break
    return out


def _machining_ops_for_calc(con, record: dict) -> list[dict]:
    """Resolve Turning/Milling/Turnmill BOM stages for this calc's part + BOM."""
    planner_ps_id = compact_text(record.get("planner_ps_id"))
    part_no = compact_text(record.get("part_no"))
    source_ps_id, partial = parse_planner_ps_id(planner_ps_id)

    cache = one(
        con.execute(
            """
            SELECT MAX(part_no) AS part_no, MAX(bom_code) AS bom_code
            FROM pp_vouchers_cache
            WHERE ps_id = %s AND pp_partial_no = %s
            """,
            (source_ps_id, int(partial or 1)),
        )
    )
    bom_code = compact_text((cache or {}).get("bom_code"))
    if not part_no:
        part_no = compact_text((cache or {}).get("part_no"))

    ps_row = one(
        con.execute(
            """
            SELECT ps.inventory_code,
                   COALESCE(sf.bom_code, '') AS selected_flow_code
            FROM planner_process_sheet ps
            LEFT JOIN planner_bom_variation sf ON sf.bom_id = ps.selected_bom_id
            WHERE ps.planner_ps_id = %s
            """,
            (planner_ps_id,),
        )
    )
    if compact_text((ps_row or {}).get("selected_flow_code")):
        bom_code = compact_text(ps_row.get("selected_flow_code"))

    sources = _source_inventory_candidates(con, planner_ps_id, part_no, source_ps_id)

    # Prefer live ERP machining stages (same as Steps modal)
    try:
        for source in sources:
            if not bom_code:
                break
            ops = fetch_machining_operations(_erp_db_query, source, bom_code)
            if ops:
                return [
                    {
                        "op_no": op.get("op_no"),
                        "stage_no": op.get("stage_no"),
                        "stage_desc": compact_text(op.get("stage_desc")),
                        "operation_label": f"Operation {op.get('op_no')}",
                    }
                    for op in ops
                    if op.get("op_no") is not None
                ]
    except Exception:
        pass

    return _ops_from_planner_bom_stage(con, sources, bom_code)


def _ensure_tables(con):
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_ps_material_calc (
            calc_id                BIGSERIAL    PRIMARY KEY,
            planner_ps_id          TEXT         NOT NULL,
            part_no                TEXT         NOT NULL DEFAULT '',
            revision               TEXT         NOT NULL DEFAULT '',
            material_type_grade    TEXT         NOT NULL DEFAULT '',
            stock_od_mm            NUMERIC      NOT NULL DEFAULT 0,
            standard_bar_length_mm NUMERIC      NOT NULL DEFAULT 0,
            density_g_cm3          NUMERIC      NOT NULL DEFAULT 7.85,
            finished_part_length_mm NUMERIC     NOT NULL DEFAULT 0,
            clamp_length_op1_mm    NUMERIC      NOT NULL DEFAULT 0,
            clamp_length_op2_mm    NUMERIC      NOT NULL DEFAULT 0,
            jaw_length_op1_mm      NUMERIC      NOT NULL DEFAULT 0,
            jaw_length_op2_mm      NUMERIC      NOT NULL DEFAULT 0,
            facing_allowance_mm    NUMERIC      NOT NULL DEFAULT 0,
            cutoff_kerf_mm         NUMERIC      NOT NULL DEFAULT 0,
            chamfer_allowance_mm   NUMERIC      NOT NULL DEFAULT 0,
            order_qty              NUMERIC      NOT NULL DEFAULT 0,
            setup_pieces           NUMERIC      NOT NULL DEFAULT 0,
            scrap_allowance_pct    NUMERIC      NOT NULL DEFAULT 0,
            issued_length_mm       NUMERIC      NOT NULL DEFAULT 0,
            issued_bars            NUMERIC      NOT NULL DEFAULT 0,
            length_per_piece_mm    NUMERIC      NOT NULL DEFAULT 0,
            parts_per_bar          INTEGER      NOT NULL DEFAULT 0,
            remnant_length_mm      NUMERIC      NOT NULL DEFAULT 0,
            pieces_needed          NUMERIC      NOT NULL DEFAULT 0,
            bars_needed            NUMERIC      NOT NULL DEFAULT 0,
            target_total_mm        NUMERIC      NOT NULL DEFAULT 0,
            target_total_kg        NUMERIC      NOT NULL DEFAULT 0,
            returnable_mm          NUMERIC      NOT NULL DEFAULT 0,
            actual_total_mm        NUMERIC,
            actual_total_kg        NUMERIC,
            remarks                TEXT         NOT NULL DEFAULT '',
            created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    # Allow multiple materials on the same PS (one calc row per material).
    con.execute(
        """
        ALTER TABLE public.planner_ps_material_calc
            DROP CONSTRAINT IF EXISTS planner_ps_material_calc_planner_ps_id_key
        """
    )
    con.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_planner_ps_material_calc_ps_material
            ON public.planner_ps_material_calc (
                planner_ps_id,
                lower(btrim(material_type_grade))
            )
        """
    )
    con.execute(
        """
        ALTER TABLE public.planner_ps_material_calc
            ADD COLUMN IF NOT EXISTS material_per_unit_mm NUMERIC NOT NULL DEFAULT 0
        """
    )
    con.execute(
        """
        ALTER TABLE public.planner_ps_material_calc
            ADD COLUMN IF NOT EXISTS buffer_length_mm NUMERIC NOT NULL DEFAULT 0
        """
    )
    con.execute(
        """
        ALTER TABLE public.planner_ps_material_calc
            ADD COLUMN IF NOT EXISTS cnc_machines TEXT[] NOT NULL DEFAULT '{}'
        """
    )
    con.execute(
        """
        ALTER TABLE public.planner_ps_material_calc
            ADD COLUMN IF NOT EXISTS stock_in_operator TEXT NOT NULL DEFAULT ''
        """
    )
    con.execute(
        """
        ALTER TABLE public.planner_ps_material_calc
            ADD COLUMN IF NOT EXISTS stock_out_operator TEXT NOT NULL DEFAULT ''
        """
    )
    con.execute(
        """
        ALTER TABLE public.planner_ps_material_calc
            ADD COLUMN IF NOT EXISTS material_uom TEXT NOT NULL DEFAULT 'mm'
        """
    )
    con.execute(
        """
        ALTER TABLE public.planner_ps_material_calc
            ADD COLUMN IF NOT EXISTS slip_date DATE
        """
    )
    con.execute(
        """
        ALTER TABLE public.planner_ps_material_calc
            ADD COLUMN IF NOT EXISTS op_assignments JSONB NOT NULL DEFAULT '[]'::jsonb
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_ps_material_issued (
            issued_id     BIGSERIAL    PRIMARY KEY,
            calc_id       BIGINT       NOT NULL
                REFERENCES public.planner_ps_material_calc(calc_id) ON DELETE CASCADE,
            batch_no      TEXT         NOT NULL DEFAULT '',
            length_mm     NUMERIC      NOT NULL DEFAULT 0,
            created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_ps_material_issued_calc
            ON public.planner_ps_material_issued (calc_id)
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_ps_material_calc_updated
            ON public.planner_ps_material_calc (updated_at DESC)
        """
    )


@material_bar_calc_bp.before_request
def _protect_api():
    if (
        request.path.startswith("/api/material-bar-calc")
        and (os.getenv("PLANNER_PASSCODE") or "").strip()
        and session.get("planner_access_ok") is not True
    ):
        return jsonify({"error": "Planner access locked."}), 401
    return None


def _canonical_ps_id(raw) -> str:
    planner_ps_id = compact_text(raw)
    if not planner_ps_id:
        return ""
    source, partial = parse_planner_ps_id(planner_ps_id)
    return format_planner_ps_id(normalize_standard_ps_id(source), partial)


def _issued_for_calc(con, calc_id):
    return rows(
        con.execute(
            """
            SELECT issued_id, batch_no, length_mm
            FROM planner_ps_material_issued
            WHERE calc_id = %s
            ORDER BY issued_id
            """,
            (int(calc_id),),
        )
    )


def _replace_issued(con, calc_id, batches):
    con.execute(
        "DELETE FROM planner_ps_material_issued WHERE calc_id = %s",
        (int(calc_id),),
    )
    for batch in batches:
        con.execute(
            """
            INSERT INTO planner_ps_material_issued (calc_id, batch_no, length_mm)
            VALUES (%s, %s, %s)
            """,
            (int(calc_id), batch["batch_no"], batch["length_mm"]),
        )


def _payload(con, row):
    if not row:
        return None
    batches = _issued_for_calc(con, row["calc_id"])
    return row_to_payload(
        row,
        [
            {
                "issued_id": b.get("issued_id"),
                "batch_no": compact_text(b.get("batch_no")),
                "length_mm": parse_number(b.get("length_mm")),
            }
            for b in batches
        ],
    )


def _fetch_calc(con, calc_id):
    return one(
        con.execute(
            "SELECT * FROM planner_ps_material_calc WHERE calc_id = %s",
            (int(calc_id),),
        )
    )


def _fetch_calc_by_ps(con, planner_ps_id):
    return one(
        con.execute(
            """
            SELECT * FROM planner_ps_material_calc
            WHERE planner_ps_id = %s
            ORDER BY calc_id
            LIMIT 1
            """,
            (planner_ps_id,),
        )
    )


def _fetch_calcs_by_ps(con, planner_ps_id) -> list:
    return rows(
        con.execute(
            """
            SELECT * FROM planner_ps_material_calc
            WHERE planner_ps_id = %s
            ORDER BY lower(btrim(material_type_grade)), calc_id
            """,
            (planner_ps_id,),
        )
    )


def _fetch_calc_by_ps_material(con, planner_ps_id, material_type_grade):
    return one(
        con.execute(
            """
            SELECT * FROM planner_ps_material_calc
            WHERE planner_ps_id = %s
              AND lower(btrim(material_type_grade)) = lower(btrim(%s))
            ORDER BY calc_id
            LIMIT 1
            """,
            (planner_ps_id, compact_text(material_type_grade)),
        )
    )


def _parse_body(data: dict) -> tuple[dict, list]:
    per_unit = parse_number(data.get("material_per_unit_mm") or data.get("finished_part_length_mm"))
    buffer_mm = parse_number(data.get("buffer_length_mm") or data.get("clamp_length_op1_mm"))
    order_qty = parse_number(data.get("order_qty"))
    material_uom = normalize_uom(data.get("material_uom"))
    slip_date = parse_slip_date(data.get("slip_date") or data.get("date"))
    inputs = {
        "material_per_unit_mm": per_unit,
        "buffer_length_mm": buffer_mm,
        "order_qty": order_qty,
        "material_uom": material_uom,
        "issued_batches": data.get("issued_batches"),
    }
    computed = compute_calc(inputs)
    op_assignments = normalize_op_assignments(data.get("op_assignments"))
    cncs = cnc_machines_from_assignments(op_assignments)
    if not cncs:
        cncs = normalize_cnc_machines(data.get("cnc_machines"))
    return {
        "planner_ps_id": _canonical_ps_id(data.get("planner_ps_id") or data.get("ps_id")),
        "part_no": compact_text(data.get("part_no")),
        "material_type_grade": compact_text(data.get("material_type_grade")),
        "material_uom": material_uom,
        "slip_date": slip_date,
        "order_qty": order_qty,
        "material_per_unit_mm": per_unit,
        "buffer_length_mm": buffer_mm,
        "finished_part_length_mm": per_unit,
        "clamp_length_op1_mm": buffer_mm,
        "length_per_piece_mm": computed["length_per_piece_mm"],
        "target_total_mm": computed["target_total_mm"],
        "issued_length_mm": computed["issued_total_mm"],
        "returnable_mm": computed["returnable_mm"],
        "op_assignments": op_assignments,
        "cnc_machines": cncs,
        "stock_in_operator": compact_text(data.get("stock_in_operator")),
        "stock_out_operator": compact_text(data.get("stock_out_operator")),
        "remarks": compact_text(data.get("remarks")),
    }, computed["issued_batches"]


def _bom_materials_for_ps(con, planner_ps_id, part_no, bom_code, source_ps_id="") -> list[dict]:
    """All leaf materials for a PS (planner requirements, else ERP/planner BOM listing)."""
    planner_ps_id = compact_text(planner_ps_id)
    part_no = compact_text(part_no)
    bom_code = compact_text(bom_code)

    reqs = rows(
        con.execute(
            """
            SELECT material_inventory_code, material_description, material_uom,
                   material_qty_needed, bom_code, source_inventory_code
            FROM planner_material_requirement
            WHERE planner_ps_id = %s
              AND COALESCE(material_inventory_code, '') <> ''
            ORDER BY requirement_id
            """,
            (planner_ps_id,),
        )
    )
    if reqs:
        out = []
        seen = set()
        for req in reqs:
            code = compact_text(req.get("material_inventory_code"))
            key = code.upper()
            if not code or key in seen:
                continue
            seen.add(key)
            desc = compact_text(req.get("material_description"))
            raw_uom = compact_text(req.get("material_uom"))
            qty = parse_number(req.get("material_qty_needed"))
            material_uom, per_unit = _prefill_uom_and_per_unit(raw_uom, qty, code, desc)
            out.append(
                {
                    "material_inventory_code": code,
                    "material_type_grade": _material_display_label(code, desc),
                    "material_description": desc,
                    "material_uom": material_uom,
                    "bom_qty_per_fg": qty,
                    "material_per_unit_mm": per_unit,
                    "bom_code": compact_text(req.get("bom_code")) or bom_code,
                }
            )
        if out:
            return out

    ps_row = one(
        con.execute(
            """
            SELECT ps.inventory_code,
                   COALESCE(sf.bom_code, '') AS selected_flow_code
            FROM planner_process_sheet ps
            LEFT JOIN planner_bom_variation sf ON sf.bom_id = ps.selected_bom_id
            WHERE ps.planner_ps_id = %s
            """,
            (planner_ps_id,),
        )
    )
    flow = compact_text((ps_row or {}).get("selected_flow_code")) or bom_code
    sources = _source_inventory_candidates(con, planner_ps_id, part_no, source_ps_id)
    mats = _resolve_bom_materials_list(con, sources, flow)
    out = []
    for mat in mats:
        code = compact_text(mat.get("material_inventory_code"))
        desc = compact_text(mat.get("material_description") or mat.get("material_type_grade"))
        material_uom, per_unit = _prefill_uom_and_per_unit(
            mat.get("material_uom"),
            mat.get("bom_qty_per_fg"),
            code,
            desc,
        )
        out.append(
            {
                **mat,
                "material_uom": material_uom,
                "material_per_unit_mm": per_unit,
                "bom_code": compact_text(mat.get("bom_code")) or flow,
            }
        )
    return out


def _bom_material_for_ps(con, planner_ps_id, part_no, bom_code, source_ps_id=""):
    mats = _bom_materials_for_ps(con, planner_ps_id, part_no, bom_code, source_ps_id)
    if mats:
        return mats[0]
    return {
        "material_inventory_code": "",
        "material_type_grade": "",
        "material_description": "",
        "material_uom": "",
        "bom_qty_per_fg": 0.0,
        "material_per_unit_mm": 0.0,
        "bom_code": compact_text(bom_code),
    }


@material_bar_calc_bp.post("/api/material-bar-calc/compute")
def api_compute():
    data = request.get_json(force=True, silent=True) or {}
    fields, batches = _parse_body(data)
    result = compute_calc(
        {
            "material_per_unit_mm": fields["material_per_unit_mm"],
            "buffer_length_mm": fields["buffer_length_mm"],
            "order_qty": fields["order_qty"],
        },
        batches,
    )
    return jsonify({"ok": True, "result": result})


@material_bar_calc_bp.get("/api/material-bar-calc/records")
def api_list_records():
    search = compact_text(request.args.get("search"))
    limit = max(1, min(int(request.args.get("limit") or 200), 500))
    with planner_db() as con:
        _ensure_tables(con)
        if search:
            pattern = f"%{search}%"
            calc_rows = rows(
                con.execute(
                    """
                    SELECT * FROM planner_ps_material_calc
                    WHERE planner_ps_id ILIKE %s
                       OR part_no ILIKE %s
                       OR material_type_grade ILIKE %s
                    ORDER BY updated_at DESC, calc_id DESC
                    LIMIT %s
                    """,
                    (pattern, pattern, pattern, limit),
                )
            )
        else:
            calc_rows = rows(
                con.execute(
                    """
                    SELECT * FROM planner_ps_material_calc
                    ORDER BY updated_at DESC, calc_id DESC
                    LIMIT %s
                    """,
                    (limit,),
                )
            )
        return jsonify({"ok": True, "records": [_payload(con, r) for r in calc_rows]})


@material_bar_calc_bp.get("/api/material-bar-calc/records/<int:calc_id>")
def api_get_record(calc_id):
    with planner_db() as con:
        _ensure_tables(con)
        row = _fetch_calc(con, calc_id)
        if not row:
            return jsonify({"error": "Record not found"}), 404
        return jsonify({"ok": True, "record": _payload(con, row)})


@material_bar_calc_bp.post("/api/material-bar-calc/records")
def api_create_record():
    data = request.get_json(force=True, silent=True) or {}
    fields, batches = _parse_body(data)
    if not fields["planner_ps_id"]:
        return jsonify({"error": "planner_ps_id is required"}), 400

    with planner_db() as con:
        _ensure_tables(con)
        existing = _fetch_calc_by_ps_material(
            con, fields["planner_ps_id"], fields["material_type_grade"]
        )
        if existing:
            return jsonify(
                {
                    "error": "A calculation already exists for this PS + material",
                    "calc_id": existing.get("calc_id"),
                    "record": _payload(con, existing),
                }
            ), 409

        try:
            ensure_planner_process_sheet(con, fields["planner_ps_id"])
        except Exception:
            pass

        inserted = one(
            con.execute(
                """
                INSERT INTO planner_ps_material_calc (
                    planner_ps_id, part_no, material_type_grade, material_uom, slip_date,
                    order_qty, material_per_unit_mm, buffer_length_mm,
                    finished_part_length_mm, clamp_length_op1_mm,
                    length_per_piece_mm, target_total_mm, issued_length_mm, returnable_mm,
                    cnc_machines, op_assignments, stock_in_operator, stock_out_operator,
                    remarks
                ) VALUES (
                    %s, %s, %s, %s, %s,
                    %s, %s, %s,
                    %s, %s,
                    %s, %s, %s, %s,
                    %s, %s::jsonb, %s, %s,
                    %s
                )
                RETURNING calc_id
                """,
                (
                    fields["planner_ps_id"],
                    fields["part_no"],
                    fields["material_type_grade"],
                    fields["material_uom"],
                    fields["slip_date"],
                    fields["order_qty"],
                    fields["material_per_unit_mm"],
                    fields["buffer_length_mm"],
                    fields["finished_part_length_mm"],
                    fields["clamp_length_op1_mm"],
                    fields["length_per_piece_mm"],
                    fields["target_total_mm"],
                    fields["issued_length_mm"],
                    fields["returnable_mm"],
                    fields["cnc_machines"],
                    json.dumps(fields["op_assignments"]),
                    fields["stock_in_operator"],
                    fields["stock_out_operator"],
                    fields["remarks"],
                ),
            )
        )
        calc_id = int((inserted or {}).get("calc_id") or 0)
        row = _fetch_calc(con, calc_id) if calc_id else None
        if not row:
            row = _fetch_calc_by_ps_material(
                con, fields["planner_ps_id"], fields["material_type_grade"]
            )
        _replace_issued(con, row["calc_id"], batches)
        return jsonify({"ok": True, "record": _payload(con, row)}), 201


@material_bar_calc_bp.put("/api/material-bar-calc/records/<int:calc_id>")
def api_update_record(calc_id):
    data = request.get_json(force=True, silent=True) or {}
    fields, batches = _parse_body(data)
    with planner_db() as con:
        _ensure_tables(con)
        existing = _fetch_calc(con, calc_id)
        if not existing:
            return jsonify({"error": "Record not found"}), 404

        planner_ps_id = fields["planner_ps_id"] or existing["planner_ps_id"]
        material_type_grade = (
            fields["material_type_grade"]
            or compact_text(existing.get("material_type_grade"))
        )
        clash = _fetch_calc_by_ps_material(con, planner_ps_id, material_type_grade)
        if clash and int(clash["calc_id"]) != int(calc_id):
            return jsonify(
                {"error": "Another record already uses that PS + material"}
            ), 409

        con.execute(
            """
            UPDATE planner_ps_material_calc SET
                planner_ps_id = %s,
                part_no = %s,
                material_type_grade = %s,
                material_uom = %s,
                slip_date = %s,
                order_qty = %s,
                material_per_unit_mm = %s,
                buffer_length_mm = %s,
                finished_part_length_mm = %s,
                clamp_length_op1_mm = %s,
                length_per_piece_mm = %s,
                target_total_mm = %s,
                issued_length_mm = %s,
                returnable_mm = %s,
                cnc_machines = %s,
                op_assignments = %s::jsonb,
                stock_in_operator = %s,
                stock_out_operator = %s,
                remarks = %s,
                updated_at = NOW()
            WHERE calc_id = %s
            """,
            (
                planner_ps_id,
                fields["part_no"] or compact_text(existing.get("part_no")),
                material_type_grade,
                fields["material_uom"] or normalize_uom(existing.get("material_uom")),
                fields["slip_date"],
                fields["order_qty"],
                fields["material_per_unit_mm"],
                fields["buffer_length_mm"],
                fields["finished_part_length_mm"],
                fields["clamp_length_op1_mm"],
                fields["length_per_piece_mm"],
                fields["target_total_mm"],
                fields["issued_length_mm"],
                fields["returnable_mm"],
                fields["cnc_machines"],
                json.dumps(fields["op_assignments"]),
                fields["stock_in_operator"],
                fields["stock_out_operator"],
                fields["remarks"],
                int(calc_id),
            ),
        )
        _replace_issued(con, calc_id, batches)
        row = _fetch_calc(con, calc_id)
        return jsonify({"ok": True, "record": _payload(con, row)})


@material_bar_calc_bp.delete("/api/material-bar-calc/records/<int:calc_id>")
def api_delete_record(calc_id):
    with planner_db() as con:
        _ensure_tables(con)
        existing = _fetch_calc(con, calc_id)
        if not existing:
            return jsonify({"error": "Record not found"}), 404
        con.execute(
            "DELETE FROM planner_ps_material_calc WHERE calc_id = %s",
            (int(calc_id),),
        )
        return jsonify({"ok": True, "deleted": calc_id})


@material_bar_calc_bp.get("/api/material-bar-calc/records/<int:calc_id>/issue-slip-pdf")
def api_issue_slip_pdf(calc_id):
    """Generate Material Issue & Return Slip PDF.

    One slip per material on the PS, stacked top-to-bottom. Each slip lists
    machining ops with CNC/operator blanks.
    """
    try:
        override_date = compact_text(request.args.get("date") or request.args.get("slip_date"))
        with planner_db() as con:
            _ensure_tables(con)
            row = _fetch_calc(con, calc_id)
            if not row:
                return jsonify({"error": "Record not found"}), 404
            record = _payload(con, row)
            sibling_rows = _fetch_calcs_by_ps(con, compact_text(row.get("planner_ps_id")))
            records = [_payload(con, r) for r in sibling_rows] or [record]
            try:
                operations = _machining_ops_for_calc(con, record or {})
            except Exception:
                operations = []

        slip_dt = parse_slip_date(override_date or (record or {}).get("slip_date"))
        pdf_bytes, filename = slip_pdf_from_calc_records(
            records, operations, slip_date=slip_dt
        )
        return send_file(
            io.BytesIO(pdf_bytes),
            mimetype="application/pdf",
            as_attachment=True,
            download_name=filename,
        )
    except Exception as exc:
        return jsonify({"error": f"PDF generation failed: {exc}"}), 500


@material_bar_calc_bp.get("/api/material-bar-calc/from-ps/<path:ps_id>")
def api_from_ps(ps_id):
    planner_ps_id = _canonical_ps_id(ps_id)
    if not planner_ps_id:
        return jsonify({"error": "Invalid PS id"}), 400
    source_ps_id, partial = parse_planner_ps_id(planner_ps_id)

    with planner_db() as con:
        _ensure_tables(con)
        cache = one(
            con.execute(
                """
                SELECT ps_id, pp_partial_no,
                       MAX(part_no) AS part_no,
                       MAX(description) AS description,
                       MAX(COALESCE(NULLIF(partial_qty, 0), total_qty, 0)) AS display_qty,
                       MAX(bom_code) AS bom_code
                FROM pp_vouchers_cache
                WHERE ps_id = %s AND pp_partial_no = %s
                GROUP BY ps_id, pp_partial_no
                """,
                (source_ps_id, int(partial or 1)),
            )
        )
        if not cache:
            cache = one(
                con.execute(
                    """
                    SELECT process_sheet_no AS ps_id,
                           1 AS pp_partial_no,
                           MAX(inventory_code) AS part_no,
                           '' AS description,
                           MAX(COALESCE(total_qty, 0)) AS display_qty,
                           '' AS bom_code
                    FROM mfg_process_sheet_info
                    WHERE process_sheet_no = %s
                    GROUP BY process_sheet_no
                    """,
                    (source_ps_id,),
                )
            )

        part_no = compact_text((cache or {}).get("part_no"))
        bom_code = compact_text((cache or {}).get("bom_code"))
        materials = _bom_materials_for_ps(con, planner_ps_id, part_no, bom_code, source_ps_id)
        mat = materials[0] if materials else {
            "material_inventory_code": "",
            "material_type_grade": "",
            "material_description": "",
            "material_uom": "mm",
            "bom_qty_per_fg": 0.0,
            "material_per_unit_mm": 0.0,
            "bom_code": bom_code,
        }

        existing_rows = _fetch_calcs_by_ps(con, planner_ps_id)
        existing_records = [_payload(con, row) for row in existing_rows]
        existing_by_mat = {}
        for rec in existing_records:
            key = compact_text(rec.get("material_type_grade")).upper()
            if key and key not in existing_by_mat:
                existing_by_mat[key] = rec

        materials_out = []
        for item in materials:
            code = compact_text(item.get("material_inventory_code"))
            grade = compact_text(item.get("material_type_grade")) or code
            match = existing_by_mat.get(grade.upper()) or existing_by_mat.get(code.upper())
            materials_out.append(
                {
                    **item,
                    "existing_calc_id": (match or {}).get("calc_id"),
                    "existing_record": match,
                }
            )

        # If saved calcs exist for materials not on BOM, still include them.
        bom_keys = {
            compact_text(m.get("material_type_grade")).upper()
            for m in materials_out
            if compact_text(m.get("material_type_grade"))
        }
        for rec in existing_records:
            grade = compact_text(rec.get("material_type_grade"))
            if not grade or grade.upper() in bom_keys:
                continue
            materials_out.append(
                {
                    "material_inventory_code": grade,
                    "material_type_grade": grade,
                    "material_description": "",
                    "material_uom": normalize_uom(rec.get("material_uom")),
                    "bom_qty_per_fg": parse_number(rec.get("material_per_unit_mm")),
                    "material_per_unit_mm": parse_number(rec.get("material_per_unit_mm")),
                    "bom_code": bom_code,
                    "existing_calc_id": rec.get("calc_id"),
                    "existing_record": rec,
                }
            )

        if not materials_out:
            materials_out = [
                {
                    "material_inventory_code": "",
                    "material_type_grade": "",
                    "material_description": "",
                    "material_uom": "mm",
                    "bom_qty_per_fg": 0.0,
                    "material_per_unit_mm": 0.0,
                    "bom_code": bom_code,
                    "existing_calc_id": None,
                    "existing_record": None,
                }
            ]

        prefill = {
            "planner_ps_id": planner_ps_id,
            "part_no": part_no,
            "order_qty": parse_number((cache or {}).get("display_qty")),
            "description": compact_text((cache or {}).get("description")),
            "bom_code": mat.get("bom_code") or bom_code,
            "material_type_grade": mat.get("material_type_grade") or "",
            "material_inventory_code": mat.get("material_inventory_code") or "",
            "material_description": mat.get("material_description") or "",
            "bom_qty_per_fg": parse_number(mat.get("bom_qty_per_fg")),
            "material_uom": normalize_uom(mat.get("material_uom") or "mm"),
            "material_per_unit_mm": parse_number(mat.get("material_per_unit_mm")),
            "materials": materials_out,
            "existing_calc_id": (existing_rows[0] or {}).get("calc_id") if existing_rows else None,
            "existing_record": existing_records[0] if existing_records else None,
            "existing_records": existing_records,
        }
        return jsonify({"ok": True, "prefill": prefill})


@material_bar_calc_bp.get("/api/material-bar-calc/machines")
def api_list_cnc_machines():
    """Active CNC machines for per-operation selection."""
    with planner_db() as con:
        machines = []
        for m in fetch_machines(con):
            code = compact_text(m.get("machine_no") or m.get("machine_code"))
            if not code:
                continue
            if not code.upper().startswith("CNC"):
                continue
            machines.append(
                {
                    "machine_id": m.get("machine_id"),
                    "machine_no": code,
                }
            )
        return jsonify({"ok": True, "machines": machines})


@material_bar_calc_bp.get("/api/material-bar-calc/machining-ops")
def api_machining_ops():
    """Machining BOM operations for a PS (used by production assignment rows)."""
    planner_ps_id = _canonical_ps_id(request.args.get("planner_ps_id") or request.args.get("ps_id"))
    if not planner_ps_id:
        return jsonify({"error": "planner_ps_id is required"}), 400
    part_no = compact_text(request.args.get("part_no"))
    with planner_db() as con:
        _ensure_tables(con)
        record = {
            "planner_ps_id": planner_ps_id,
            "part_no": part_no,
        }
        try:
            operations = _machining_ops_for_calc(con, record)
        except Exception:
            operations = []
        return jsonify({"ok": True, "operations": operations})


@material_bar_calc_bp.get("/api/material-bar-calc/ps-search")
def api_ps_search():
    query = compact_text(request.args.get("q") or request.args.get("search"))
    limit = max(1, min(int(request.args.get("limit") or 20), 50))
    with planner_db() as con:
        hits = search_process_sheet_sources(con, query, limit=limit)
        results = []
        for hit in hits:
            source = compact_text(hit.get("ps_id"))
            partial = int(hit.get("pp_partial_no") or 1)
            planner_ps_id = format_planner_ps_id(source, partial)
            results.append(
                {
                    "planner_ps_id": planner_ps_id,
                    "ps_id": source,
                    "pp_partial_no": partial,
                    "part_no": compact_text(hit.get("part_no")),
                    "description": compact_text(hit.get("description")),
                    "display_qty": parse_number(hit.get("display_qty")),
                    "bom_code": compact_text(hit.get("bom_code")),
                }
            )
        return jsonify({"ok": True, "results": results})
