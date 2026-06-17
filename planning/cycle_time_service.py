"""Master cycle time publish, harvest from planner jobs, and resolve for new schedules."""

from __future__ import annotations

import json
import os
import re
from typing import Any

from .helpers import one, rows
from .utils import compact_text, parse_number

SOURCE_MANUAL = "MANUAL"
SOURCE_PLANNER_JOB = "PLANNER_JOB"
SOURCE_PLANNER_HARVEST = "PLANNER_HARVEST"
SOURCE_ACTUAL_AVG = "ACTUAL_AVG"
SOURCE_SHEET = "SHEET"

_VALID_SOURCES = {
    SOURCE_MANUAL,
    SOURCE_PLANNER_JOB,
    SOURCE_PLANNER_HARVEST,
    SOURCE_ACTUAL_AVG,
    SOURCE_SHEET,
}

_SNAPSHOT_READY = False


def planner_db_available() -> bool:
    return bool(os.getenv("SUPA_DB_URL", "").strip())


def _master_ideal_cycle(master: dict[str, Any] | None) -> float:
    if not master:
        return 0.0
    ideal = float(master.get("ideal_cycle_time") or 0)
    if ideal > 0:
        return ideal
    return float(master.get("cycle_time") or 0)


def _production_cycle_only_source(source_kind: str) -> bool:
    return compact_text(source_kind) in {SOURCE_PLANNER_HARVEST, SOURCE_PLANNER_JOB}


def _parse_op_no(value: Any) -> int | None:
    text = compact_text(value)
    if not text:
        return None
    match = re.search(r"(\d+)", text)
    if not match:
        return None
    try:
        return int(match.group(1))
    except (TypeError, ValueError):
        return None


def normalize_op_identity(
    op_type: str = "",
    op_no_raw: Any = None,
) -> tuple[int | None, str]:
    """Return canonical (op_no, op_type) — strip duplicated op number from op_type labels."""
    op_no = _parse_op_no(op_no_raw)
    op_type = compact_text(op_type)
    if op_no is None:
        return None, op_type
    op_no_text = str(op_no)
    if not op_type or op_type == op_no_text:
        return op_no, ""
    prefix = re.match(rf"^{re.escape(op_no_text)}\s*[-: ]+\s*(.+)$", op_type, re.I)
    if prefix:
        return op_no, compact_text(prefix.group(1))
    suffix = re.match(rf"^(.+?)\s*[-: ]+\s*{re.escape(op_no_text)}$", op_type, re.I)
    if suffix:
        return op_no, compact_text(suffix.group(1))
    return op_no, op_type


def resolve_schedule_times(
    con,
    *,
    source_ps_id: str,
    source_op_seq_id: int = 0,
    source_op_no: str = "",
    cycle_minutes_per_qty: float = 0,
    setup_minutes: float = 0,
) -> dict[str, Any]:
    """Master-first cycle/setup for new scheduler jobs (catalog drag-drop path)."""
    fallback_cycle = max(0.0, float(cycle_minutes_per_qty or 0))
    fallback_setup = max(0.0, float(setup_minutes or 0))
    # Catalog drag-drop already sends BOM/cycle-times; avoid master REST on every queue POST.
    if fallback_cycle > 0:
        return {
            "cycle_minutes_per_qty": fallback_cycle,
            "setup_minutes": fallback_setup,
            "source": "client",
        }
    source_ps_id = compact_text(source_ps_id)
    if not source_ps_id:
        return {
            "cycle_minutes_per_qty": fallback_cycle,
            "setup_minutes": fallback_setup,
            "source": "client",
        }

    from .process_sheets import ensure_planner_process_sheet

    ps = ensure_planner_process_sheet(con, source_ps_id)
    if not ps:
        return {
            "cycle_minutes_per_qty": fallback_cycle,
            "setup_minutes": fallback_setup,
            "source": "client",
        }

    bom_id = int(ps.get("selected_bom_id") or 0)
    step = None
    if int(source_op_seq_id or 0) > 0 and bom_id > 0:
        step = one(
            con.execute(
                "SELECT * FROM planner_operation_seq WHERE op_seq_id = %s AND bom_id = %s",
                (int(source_op_seq_id), bom_id),
            )
        )
    if not step and compact_text(source_op_no) and bom_id > 0:
        step = one(
            con.execute(
                """
                SELECT * FROM planner_operation_seq
                WHERE bom_id = %s AND op_no = %s
                ORDER BY seq_no, op_seq_id LIMIT 1
                """,
                (bom_id, compact_text(source_op_no)),
            )
        )

    bom_row = (
        one(
            con.execute(
                "SELECT inventory_code, bom_code FROM planner_bom_variation WHERE bom_id = %s",
                (bom_id,),
            )
        )
        if bom_id > 0
        else None
    )
    part_no = compact_text((bom_row or {}).get("inventory_code") or ps.get("inventory_code") or "")
    bom_code = compact_text((bom_row or {}).get("bom_code") or "")
    if not part_no:
        return {
            "cycle_minutes_per_qty": fallback_cycle,
            "setup_minutes": fallback_setup,
            "source": "client",
        }

    master_cache = MasterTimeCache.load(con)
    resolved = resolve_step_times(
        con,
        part_no=part_no,
        bom_code=bom_code,
        step=step or {},
        extra_part_nos=[compact_text(ps.get("inventory_code") or "")],
        master_cache=master_cache,
    )
    cycle = parse_number(resolved.get("cycle_time"), fallback_cycle)
    setup = parse_number(resolved.get("set_up_time"), fallback_setup)
    if resolved.get("source") == "master" and (cycle > 0 or setup > 0):
        return {
            "cycle_minutes_per_qty": cycle if cycle > 0 else fallback_cycle,
            "setup_minutes": setup if setup > 0 else fallback_setup,
            "source": "master",
            "master_id": resolved.get("master_id"),
        }

    if not step and part_no:
        op_no, op_type = normalize_op_identity("", source_op_no)
        master = lookup_master_row(
            con,
            part_no=part_no,
            bom_code=bom_code,
            op_no=op_no,
            op_type=op_type,
        )
        if master:
            ideal = parse_number(master.get("ideal_cycle_time"), 0)
            production = parse_number(master.get("cycle_time"), 0)
            cycle = production if production > 0 else ideal
            setup = parse_number(master.get("set_up_time"), 0)
            if cycle > 0 or setup > 0:
                return {
                    "cycle_minutes_per_qty": cycle if cycle > 0 else fallback_cycle,
                    "setup_minutes": setup if setup > 0 else fallback_setup,
                    "source": "master",
                    "master_id": int(master.get("id") or 0),
                }

    return {
        "cycle_minutes_per_qty": fallback_cycle,
        "setup_minutes": fallback_setup,
        "source": "client",
    }


def ensure_cycle_time_snapshot_table(con) -> None:
    global _SNAPSHOT_READY
    if _SNAPSHOT_READY:
        return
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS public.planner_cycle_time_snapshot (
            snapshot_id          BIGSERIAL    PRIMARY KEY,
            master_id            BIGINT       REFERENCES public.planner_cycle_time_master(id) ON DELETE SET NULL,
            part_no              TEXT         NOT NULL,
            bom_code             TEXT         NOT NULL DEFAULT '',
            stage_no             INTEGER      NOT NULL DEFAULT 0,
            stage_name           TEXT         NOT NULL DEFAULT '',
            op_no                INTEGER,
            op_type              TEXT         NOT NULL DEFAULT '',
            program_no           TEXT         NOT NULL DEFAULT '',
            program_file         TEXT         NOT NULL DEFAULT '',
            tool_list_file       TEXT         NOT NULL DEFAULT '',
            cycle_time_old       NUMERIC,
            cycle_time_new       NUMERIC      NOT NULL,
            set_up_time_old      NUMERIC,
            set_up_time_new      NUMERIC      NOT NULL DEFAULT 0,
            source_kind          TEXT         NOT NULL DEFAULT 'MANUAL',
            source_block_id      BIGINT,
            source_operation_id  BIGINT,
            quantum_from         DATE,
            quantum_to           DATE,
            sample_count         INTEGER,
            notes                TEXT         NOT NULL DEFAULT '',
            published_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
        """
    )
    con.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_planner_ct_snapshot_part_bom
            ON public.planner_cycle_time_snapshot (part_no, bom_code)
        """
    )
    _SNAPSHOT_READY = True


_MASTER_ROW_SELECT = (
    "id, part_no, bom_code, stage_no, stage_name, op_no, op_type, "
    "program_no, program_file, tool_list_file, "
    "ideal_cycle_time, cycle_time, set_up_time, updated_at"
)


def _part_no_lookup_candidates(primary: str, *extras: str) -> list[str]:
    out: list[str] = []

    def add(value: str) -> None:
        value = compact_text(value)
        if not value:
            return
        if value not in out:
            out.append(value)
        upper = value.upper()
        for prefix in ("PMM-SUBCON-", "SUBCON-"):
            if upper.startswith(prefix):
                add(value[len(prefix):])

    add(primary)
    for extra in extras:
        add(extra)
    return out


def _load_master_rows_rest() -> list[dict[str, Any]]:
    try:
        from db import supa_headers, supa_url
        from sync import _supa_fetch_all as supa_fetch_all

        base = supa_url()
        if not base:
            return []
        return supa_fetch_all(
            f"{base}/planner_cycle_time_master",
            headers=supa_headers(write=True),
            params={"select": _MASTER_ROW_SELECT, "order": "id"},
        )
    except Exception:
        return []


def _load_master_rows_pg(con) -> list[dict[str, Any]]:
    try:
        return rows(
            con.execute(
                f"""
                SELECT {_MASTER_ROW_SELECT}
                FROM public.planner_cycle_time_master
                ORDER BY id
                """
            )
        )
    except Exception:
        return []


def load_master_time_rows(con) -> list[dict[str, Any]]:
    """Load master cycle rows from Postgres and Supabase REST (same source as cycle-times UI)."""
    by_id: dict[int, dict[str, Any]] = {}
    for row in _load_master_rows_pg(con) + _load_master_rows_rest():
        row_id = int(row.get("id") or 0)
        if row_id > 0:
            by_id[row_id] = row
        else:
            by_id[len(by_id) + 1_000_000] = row
    return list(by_id.values())


def _program_no_candidates(part_no: str, op_text: str) -> list[str]:
    if not op_text:
        return []
    candidates = [f"{part_no}-OP{op_text}"]
    if op_text.isdigit():
        candidates.append(f"{part_no}-OP{int(op_text):02d}")
        candidates.append(f"{part_no}-OP{int(op_text):03d}")
    seen: list[str] = []
    for item in candidates:
        key = compact_text(item).upper()
        if key and key not in seen:
            seen.append(key)
    return seen


def _pick_master_row(
    master_rows: list[dict[str, Any]],
    *,
    part_no: str,
    bom_code: str = "",
    op_no: int | None = None,
    op_type: str = "",
    stage_no: int | None = None,
    extra_part_nos: list[str] | None = None,
) -> dict[str, Any] | None:
    part_candidates = _part_no_lookup_candidates(part_no, *(extra_part_nos or []))
    if not part_candidates:
        return None
    bom_code = compact_text(bom_code)
    op_type = compact_text(op_type)
    op_text = str(op_no) if op_no is not None else ""
    stage_val = int(stage_no or 0)
    bom_candidates = [bom_code] if bom_code else []
    if "" not in bom_candidates:
        bom_candidates.append("")

    best: tuple[int, dict[str, Any]] | None = None

    def consider(row: dict[str, Any], score: int) -> None:
        nonlocal best
        if score <= 0:
            return
        if best is None or score > best[0] or (score == best[0] and int(row.get("id") or 0) > int(best[1].get("id") or 0)):
            best = (score, row)

    for row in master_rows or []:
        row_part = compact_text(row.get("part_no"))
        if row_part not in part_candidates:
            continue
        row_bom = compact_text(row.get("bom_code"))
        row_op_text = str(row.get("op_no")) if row.get("op_no") is not None else ""
        row_op_type = compact_text(row.get("op_type"))
        row_stage = int(row.get("stage_no") or 0)
        row_program = compact_text(row.get("program_no")).upper()
        generic_program = (
            not compact_text(row.get("program_file"))
            and not compact_text(row.get("tool_list_file"))
        )

        for bom_try in bom_candidates:
            if row_bom != bom_try:
                continue
            if op_text and row_op_text == op_text:
                score = 900 + (10 if bom_try else 0) + (1 if generic_program else 0)
                consider(row, score)
            elif stage_val > 0 and row_stage == stage_val:
                score = 700 + (10 if bom_try else 0) + (1 if generic_program else 0)
                consider(row, score)
            elif not op_text and row_op_type and row_op_type == op_type:
                score = 500 + (10 if bom_try else 0) + (1 if generic_program else 0)
                consider(row, score)

        if op_text:
            for program_no in _program_no_candidates(row_part, op_text):
                if row_program == program_no.upper():
                    score = 850 + (1 if generic_program else 0)
                    consider(row, score)
            if row_program.endswith(f"-OP{op_text}"):
                score = 800 + (1 if generic_program else 0)
                consider(row, score)

        if op_text and row_op_text == op_text and not bom_code:
            score = 600 + (1 if generic_program else 0)
            consider(row, score)

    return best[1] if best else None


class MasterTimeCache:
    """In-memory master cycle rows for one catalog / batch resolve pass."""

    __slots__ = ("_rows",)

    def __init__(self, rows: list[dict[str, Any]] | None = None):
        self._rows = list(rows or [])

    @classmethod
    def load(cls, con) -> MasterTimeCache:
        return cls(load_master_time_rows(con))

    def lookup(
        self,
        *,
        part_no: str,
        bom_code: str = "",
        op_no: int | None = None,
        op_type: str = "",
        stage_no: int | None = None,
        extra_part_nos: list[str] | None = None,
    ) -> dict[str, Any] | None:
        return _pick_master_row(
            self._rows,
            part_no=part_no,
            bom_code=bom_code,
            op_no=op_no,
            op_type=op_type,
            stage_no=stage_no,
            extra_part_nos=extra_part_nos,
        )


def lookup_master_row(
    con,
    *,
    part_no: str,
    bom_code: str,
    op_no: int | None = None,
    op_type: str = "",
    stage_no: int | None = None,
    extra_part_nos: list[str] | None = None,
    master_cache: MasterTimeCache | None = None,
) -> dict[str, Any] | None:
    part_no = compact_text(part_no)
    if not part_no:
        return None
    if master_cache is not None:
        hit = master_cache.lookup(
            part_no=part_no,
            bom_code=bom_code,
            op_no=op_no,
            op_type=op_type,
            stage_no=stage_no,
            extra_part_nos=extra_part_nos,
        )
        if hit:
            return hit

    bom_code = compact_text(bom_code)
    op_type = compact_text(op_type)
    op_text = str(op_no) if op_no is not None else ""
    stage_val = int(stage_no or 0)

    part_candidates = _part_no_lookup_candidates(part_no, *(extra_part_nos or []))
    bom_candidates: list[str] = []
    if bom_code:
        bom_candidates.append(bom_code)
    if "" not in bom_candidates:
        bom_candidates.append("")

    for part_try in part_candidates:
        for bom_try in bom_candidates:
            row = _fetch_master_row(
                con,
                part_no=part_try,
                bom_code=bom_try,
                op_text=op_text,
                op_type=op_type,
                stage_val=stage_val,
            )
            if row:
                return row

        if op_text:
            row = one(
                con.execute(
                    f"""
                    SELECT {_MASTER_ROW_SELECT}
                    FROM public.planner_cycle_time_master m
                    WHERE trim(m.part_no) = trim(%s)
                      AND m.op_no IS NOT NULL
                      AND m.op_no::text = %s
                    ORDER BY
                        CASE
                            WHEN trim(COALESCE(m.program_no, '')) = ''
                             AND trim(COALESCE(m.program_file, '')) = ''
                             AND trim(COALESCE(m.tool_list_file, '')) = ''
                            THEN 0 ELSE 1
                        END,
                        m.updated_at DESC NULLS LAST,
                        m.id DESC
                    LIMIT 1
                    """,
                    (part_try, op_text),
                )
            )
            if row:
                return row

            for program_no in _program_no_candidates(part_try, op_text):
                row = one(
                    con.execute(
                        f"""
                        SELECT {_MASTER_ROW_SELECT}
                        FROM public.planner_cycle_time_master m
                        WHERE trim(m.part_no) = trim(%s)
                          AND upper(trim(COALESCE(m.program_no, ''))) = upper(trim(%s))
                        ORDER BY m.updated_at DESC NULLS LAST, m.id DESC
                        LIMIT 1
                        """,
                        (part_try, program_no),
                    )
                )
                if row:
                    return row

    if master_cache is None:
        rest_rows = _load_master_rows_rest()
        if rest_rows:
            return _pick_master_row(
                rest_rows,
                part_no=part_no,
                bom_code=bom_code,
                op_no=op_no,
                op_type=op_type,
                stage_no=stage_no,
                extra_part_nos=extra_part_nos,
            )
    return None


def _fetch_master_row(
    con,
    *,
    part_no: str,
    bom_code: str,
    op_text: str,
    op_type: str,
    stage_val: int,
) -> dict[str, Any] | None:
    return one(
        con.execute(
            f"""
            SELECT {_MASTER_ROW_SELECT}
            FROM public.planner_cycle_time_master m
            WHERE trim(m.part_no) = trim(%s)
              AND trim(m.bom_code) = trim(%s)
              AND (
                    (%s <> '' AND m.op_no IS NOT NULL AND m.op_no::text = %s)
                 OR (%s > 0 AND m.stage_no = %s)
                 OR (%s = '' AND %s = 0 AND trim(COALESCE(m.op_type, '')) = %s)
              )
            ORDER BY
                CASE
                    WHEN trim(COALESCE(m.program_no, '')) = ''
                     AND trim(COALESCE(m.program_file, '')) = ''
                     AND trim(COALESCE(m.tool_list_file, '')) = ''
                    THEN 0 ELSE 1
                END,
                m.updated_at DESC NULLS LAST,
                m.id DESC
            LIMIT 1
            """,
            (
                part_no,
                bom_code,
                op_text,
                op_text,
                stage_val,
                stage_val,
                op_text,
                stage_val,
                op_type,
            ),
        )
    )


def resolve_step_times(
    con,
    *,
    part_no: str,
    bom_code: str,
    step: dict[str, Any] | None = None,
    extra_part_nos: list[str] | None = None,
    master_cache: MasterTimeCache | None = None,
) -> dict[str, float]:
    """Master-first times for new schedules; never reads planner_operation."""
    step = step or {}
    stage_no = int(step.get("source_stage_no") or step.get("stage_no") or 0)
    op_no = _parse_op_no(step.get("op_no"))
    op_type = compact_text(step.get("op_type"))
    fallback_cycle = parse_number(step.get("cycle_time"), 0)
    fallback_setup = parse_number(step.get("setup_time"), 0)

    master = lookup_master_row(
        con,
        part_no=part_no,
        bom_code=bom_code,
        op_no=op_no,
        op_type=op_type,
        stage_no=stage_no or None,
        extra_part_nos=extra_part_nos,
        master_cache=master_cache,
    )
    if master:
        ideal = parse_number(master.get("ideal_cycle_time"), 0)
        production = parse_number(master.get("cycle_time"), 0)
        cycle = production if production > 0 else ideal
        setup = parse_number(master.get("set_up_time"), 0)
        if cycle > 0 or setup > 0:
            return {
                "cycle_time": cycle if cycle > 0 else fallback_cycle,
                "set_up_time": setup if setup > 0 else fallback_setup,
                "ideal_cycle_time": ideal,
                "source": "master",
                "master_id": int(master.get("id") or 0),
            }
    return {
        "cycle_time": fallback_cycle,
        "set_up_time": fallback_setup,
        "source": "bom_step",
        "master_id": None,
    }


HARVEST_PREVIEW_SQL = """
WITH job_cycles AS (
    SELECT
        TRIM(COALESCE(
            NULLIF(bv.inventory_code, ''),
            NULLIF(step_bv.inventory_code, ''),
            NULLIF(ps.inventory_code, ''),
            ''
        )) AS part_no,
        TRIM(COALESCE(
            NULLIF(bv.bom_code, ''),
            NULLIF(step_bv.bom_code, ''),
            NULLIF(tps.selected_bom_code, ''),
            NULLIF(tps.erp_bom_code, ''),
            NULLIF(erp.erp_bom_code, ''),
            ''
        )) AS bom_code,
        TRIM(COALESCE(step.op_type, '')) AS op_type,
        TRIM(COALESCE(step.op_no, o.source_op_no, '')) AS op_no_raw,
        COALESCE(step.source_stage_no, 0) AS stage_no,
        TRIM(
            COALESCE(
                NULLIF(step.op_type || ' ' || step.op_no, ' '),
                o.operation_name,
                ''
            )
        ) AS stage_name,
        COALESCE(NULLIF(TRIM(pd.main_desc), ''), '') AS part_description,
        COALESCE(step.cycle_time, 0) AS bom_step_cycle_time,
        COALESCE(step.setup_time, 0) AS bom_step_set_up_time,
        COALESCE(o.cycle_minutes_per_qty, 0) AS cycle_time,
        COALESCE(o.setup_minutes, 0) AS set_up_time,
        o.operation_id,
        o.source_ps_id,
        b.block_id,
        m.machine_no,
        GREATEST(o.updated_at, b.updated_at) AS touched_at
    FROM planner_run_block b
    JOIN planner_operation o ON o.operation_id = b.operation_id
    JOIN planner_machines m ON m.machine_id = b.machine_id
    LEFT JOIN planner_process_sheet ps_job
           ON ps_job.planner_ps_id = NULLIF(TRIM(o.job_no), '')
    LEFT JOIN planner_process_sheet ps_src
           ON ps_src.planner_ps_id = NULLIF(TRIM(o.source_ps_id), '')
    LEFT JOIN planner_process_sheet ps ON ps.planner_ps_id = COALESCE(
        ps_job.planner_ps_id,
        ps_src.planner_ps_id
    )
    LEFT JOIN planner_temp_process_sheet tps ON tps.planner_ps_id = ps.planner_ps_id
    LEFT JOIN planner_bom_variation bv ON bv.bom_id = ps.selected_bom_id
    LEFT JOIN planner_operation_seq step ON step.op_seq_id = o.source_op_seq_id
    LEFT JOIN planner_bom_variation step_bv ON step_bv.bom_id = step.bom_id
    LEFT JOIN LATERAL (
        SELECT MAX(NULLIF(TRIM(v.bom_code), '')) AS erp_bom_code
        FROM pp_vouchers_cache v
        WHERE v.ps_id = COALESCE(
            NULLIF(TRIM(ps.source_ps_id), ''),
            CASE
                WHEN NULLIF(TRIM(o.source_ps_id), '') LIKE '%::%'
                THEN split_part(TRIM(o.source_ps_id), '::', 1)
                ELSE NULLIF(TRIM(o.source_ps_id), '')
            END,
            NULLIF(TRIM(o.job_no), '')
        )
          AND v.pp_partial_no = COALESCE(
            ps.pp_partial_no,
            CASE
                WHEN NULLIF(TRIM(o.source_ps_id), '') ~ '::[0-9]+$'
                THEN NULLIF(
                    substring(TRIM(o.source_ps_id) FROM '::([0-9]+)$'),
                    ''
                )::integer
                ELSE 1
            END,
            1
          )
    ) erp ON TRUE
    LEFT JOIN part_desc pd ON pd.inventory_code = TRIM(COALESCE(
        NULLIF(bv.inventory_code, ''),
        NULLIF(step_bv.inventory_code, ''),
        NULLIF(ps.inventory_code, ''),
        ''
    ))
    WHERE COALESCE(b.active, TRUE) = TRUE
      AND COALESCE(b.block_type, 'ORIGINAL') = 'ORIGINAL'
      AND COALESCE(o.cycle_minutes_per_qty, 0) > 0
      AND TRIM(COALESCE(
            NULLIF(bv.inventory_code, ''),
            NULLIF(step_bv.inventory_code, ''),
            NULLIF(ps.inventory_code, ''),
            ''
        )) <> ''
)
SELECT
    part_no,
    bom_code,
    op_type,
    op_no_raw,
    stage_no,
    stage_name,
    part_description,
    MAX(bom_step_cycle_time) AS bom_step_cycle_time,
    MAX(bom_step_set_up_time) AS bom_step_set_up_time,
    COUNT(*)::int AS job_count,
    MIN(cycle_time) AS cycle_min,
    MAX(cycle_time) AS cycle_max,
    json_agg(
        json_build_object(
            'block_id', block_id,
            'operation_id', operation_id,
            'source_ps_id', source_ps_id,
            'machine_no', machine_no,
            'cycle_time', cycle_time,
            'set_up_time', set_up_time,
            'touched_at', touched_at
        )
        ORDER BY touched_at DESC NULLS LAST, block_id DESC
    ) AS jobs_json
FROM job_cycles
GROUP BY part_no, bom_code, op_type, op_no_raw, stage_no, stage_name, part_description
ORDER BY part_no, bom_code, stage_no, op_no_raw
"""


def _median(values: list[float]) -> float:
    nums = sorted(values)
    if not nums:
        return 0.0
    mid = len(nums) // 2
    if len(nums) % 2:
        return float(nums[mid])
    return float((nums[mid - 1] + nums[mid]) / 2.0)


def _mode(values: list[float]) -> float:
    if not values:
        return 0.0
    rounded = [round(v, 2) for v in values]
    counts: dict[float, int] = {}
    for val in rounded:
        counts[val] = counts.get(val, 0) + 1
    best = max(counts.items(), key=lambda item: (item[1], item[0]))
    return float(best[0])


def _proposed_from_jobs(jobs: list[dict[str, Any]], strategy: str) -> tuple[float, float, int | None, int | None]:
    if not jobs:
        return 0.0, 0.0, None, None
    cycles = [float(j.get("cycle_time") or 0) for j in jobs]
    setups = [float(j.get("set_up_time") or 0) for j in jobs]
    strategy = compact_text(strategy).lower() or "latest"
    if strategy == "median":
        cycle = _median(cycles)
        setup = _median(setups)
        pick = min(jobs, key=lambda j: abs(float(j.get("cycle_time") or 0) - cycle))
    elif strategy == "mode":
        cycle = _mode(cycles)
        setup = _mode(setups)
        pick = next(
            (j for j in jobs if round(float(j.get("cycle_time") or 0), 2) == round(cycle, 2)),
            jobs[0],
        )
    else:
        pick = jobs[0]
        cycle = float(pick.get("cycle_time") or 0)
        setup = float(pick.get("set_up_time") or 0)
    return (
        cycle,
        setup,
        int(pick.get("block_id") or 0) or None,
        int(pick.get("operation_id") or 0) or None,
    )


def _finalize_harvest_item(item: dict[str, Any], *, strategy: str) -> dict[str, Any]:
    jobs = sorted(
        item.get("jobs") or [],
        key=lambda j: (str(j.get("touched_at") or ""), int(j.get("block_id") or 0)),
        reverse=True,
    )
    proposed_cycle, proposed_setup, source_block_id, source_operation_id = _proposed_from_jobs(
        jobs, strategy
    )
    cycles = [float(j.get("cycle_time") or 0) for j in jobs]
    cycle_min = min(cycles) if cycles else proposed_cycle
    cycle_max = max(cycles) if cycles else proposed_cycle
    item.update(
        {
            "jobs": jobs,
            "job_count": len(jobs),
            "proposed_cycle_time": proposed_cycle,
            "proposed_set_up_time": proposed_setup,
            "publish_cycle_time": proposed_cycle,
            "publish_set_up_time": proposed_setup,
            "median_cycle_time": _median(cycles),
            "mode_cycle_time": _mode(cycles),
            "cycle_min": cycle_min,
            "cycle_max": cycle_max,
            "has_variance": abs(cycle_max - cycle_min) > 0.009,
            "source_operation_id": source_operation_id,
            "source_block_id": source_block_id,
        }
    )
    ideal_baseline = (
        float(item.get("current_ideal_cycle_time") or 0)
        if float(item.get("current_ideal_cycle_time") or 0) > 0
        else float(item.get("bom_step_cycle_time") or 0)
    )
    recommendation = (
        "review"
        if ideal_baseline <= 0
        or abs(proposed_cycle - ideal_baseline) > 0.009
        else "clear"
    )
    item["recommendation"] = recommendation
    item["picked_job_index"] = 0 if recommendation == "clear" else None
    current_production = float(item.get("current_cycle_time") or 0)
    item["differs_from_master"] = (
        not item.get("current_master_id")
        or abs(current_production - proposed_cycle) > 0.009
    )
    op_no = item.get("op_no")
    op_type = compact_text(item.get("op_type"))
    item["key"] = (
        f"{item.get('part_no')}|{item.get('bom_code')}|{op_type}|"
        f"{op_no if op_no is not None else ''}"
    )
    return item


def harvest_preview(con, *, strategy: str = "latest") -> list[dict[str, Any]]:
    ensure_cycle_time_snapshot_table(con)
    merged: dict[tuple[Any, ...], dict[str, Any]] = {}
    for row in rows(con.execute(HARVEST_PREVIEW_SQL)):
        part_no = compact_text(row.get("part_no"))
        bom_code = compact_text(row.get("bom_code"))
        stage_no = int(row.get("stage_no") or 0)
        op_no, op_type = normalize_op_identity(row.get("op_type"), row.get("op_no_raw"))
        jobs_raw = row.get("jobs_json") or []
        if isinstance(jobs_raw, str):
            jobs_raw = json.loads(jobs_raw)
        jobs: list[dict[str, Any]] = []
        for job in jobs_raw or []:
            jobs.append(
                {
                    "block_id": int(job.get("block_id") or 0) or None,
                    "operation_id": int(job.get("operation_id") or 0) or None,
                    "source_ps_id": compact_text(job.get("source_ps_id")),
                    "machine_no": compact_text(job.get("machine_no")),
                    "cycle_time": float(job.get("cycle_time") or 0),
                    "set_up_time": float(job.get("set_up_time") or 0),
                    "touched_at": str(job.get("touched_at") or "")[:19],
                }
            )

        master = lookup_master_row(
            con,
            part_no=part_no,
            bom_code=bom_code,
            op_no=op_no,
            op_type=op_type,
            stage_no=stage_no or None,
        )
        current_ideal = _master_ideal_cycle(master)
        current_production = float(master.get("cycle_time") or 0) if master else 0.0
        current_setup = float(master.get("set_up_time") or 0) if master else 0.0
        bom_step_cycle = float(row.get("bom_step_cycle_time") or 0)
        is_placeholder = bom_code.upper() in {"PLACEHOLDER", ""} and bom_step_cycle <= 1.01
        stage_name = compact_text(row.get("stage_name"))
        if op_type and op_no is not None:
            canonical_stage = f"{op_type} {op_no}".strip()
            if not stage_name or stage_name == compact_text(row.get("op_type")):
                stage_name = canonical_stage
        elif op_no is not None and not stage_name:
            stage_name = str(op_no)

        merge_key = (part_no, bom_code, stage_no, op_no, op_type)
        if merge_key not in merged:
            merged[merge_key] = {
                "part_no": part_no,
                "bom_code": bom_code,
                "part_description": compact_text(row.get("part_description")),
                "stage_no": stage_no,
                "stage_name": stage_name,
                "op_no": op_no,
                "op_type": op_type,
                "bom_step_cycle_time": bom_step_cycle,
                "bom_step_set_up_time": float(row.get("bom_step_set_up_time") or 0),
                "current_master_id": int(master.get("id") or 0) if master else None,
                "current_ideal_cycle_time": current_ideal,
                "current_cycle_time": current_production,
                "current_set_up_time": current_setup,
                "is_placeholder": is_placeholder,
                "jobs": list(jobs),
                "selected": False,
                "expanded": False,
            }
            continue

        existing = merged[merge_key]
        seen_blocks = {
            int(j.get("block_id") or 0)
            for j in existing.get("jobs") or []
            if int(j.get("block_id") or 0) > 0
        }
        for job in jobs:
            block_id = int(job.get("block_id") or 0)
            if block_id > 0 and block_id in seen_blocks:
                continue
            if block_id > 0:
                seen_blocks.add(block_id)
            existing["jobs"].append(job)
        existing["bom_step_cycle_time"] = max(
            float(existing.get("bom_step_cycle_time") or 0),
            bom_step_cycle,
        )
        existing["bom_step_set_up_time"] = max(
            float(existing.get("bom_step_set_up_time") or 0),
            float(row.get("bom_step_set_up_time") or 0),
        )
        if not existing.get("current_master_id") and master:
            existing["current_master_id"] = int(master.get("id") or 0)
            existing["current_ideal_cycle_time"] = current_ideal
            existing["current_cycle_time"] = current_production
            existing["current_set_up_time"] = current_setup

    out = [
        _finalize_harvest_item(item, strategy=strategy)
        for item in merged.values()
    ]
    out.sort(
        key=lambda item: (
            item.get("part_no") or "",
            item.get("bom_code") or "",
            int(item.get("stage_no") or 0),
            int(item.get("op_no") or 0),
            item.get("op_type") or "",
        )
    )
    return out


def _insert_snapshot(
    con,
    *,
    master_id: int | None,
    row: dict[str, Any],
    cycle_old: float | None,
    setup_old: float | None,
    cycle_new: float,
    setup_new: float,
    source_kind: str,
    notes: str,
    source_block_id: int | None = None,
    source_operation_id: int | None = None,
    quantum_from=None,
    quantum_to=None,
    sample_count: int | None = None,
) -> int:
    snap = one(
        con.execute(
            """
            INSERT INTO public.planner_cycle_time_snapshot (
                master_id, part_no, bom_code, stage_no, stage_name, op_no, op_type,
                program_no, program_file, tool_list_file,
                cycle_time_old, cycle_time_new, set_up_time_old, set_up_time_new,
                source_kind, source_block_id, source_operation_id,
                quantum_from, quantum_to, sample_count, notes
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s
            )
            RETURNING snapshot_id
            """,
            (
                master_id,
                compact_text(row.get("part_no")),
                compact_text(row.get("bom_code")),
                int(row.get("stage_no") or 0),
                compact_text(row.get("stage_name")),
                row.get("op_no"),
                compact_text(row.get("op_type")),
                compact_text(row.get("program_no")),
                compact_text(row.get("program_file")),
                compact_text(row.get("tool_list_file")),
                cycle_old,
                cycle_new,
                setup_old,
                setup_new,
                source_kind,
                source_block_id,
                source_operation_id,
                quantum_from,
                quantum_to,
                sample_count,
                compact_text(notes),
            ),
        )
    )
    return int(snap["snapshot_id"])


def publish_cycle_time(
    con,
    *,
    part_no: str,
    bom_code: str = "",
    stage_no: int = 0,
    stage_name: str = "",
    op_no: int | None = None,
    op_type: str = "",
    cycle_time: float,
    set_up_time: float = 0,
    part_description: str = "",
    program_no: str = "",
    program_file: str = "",
    tool_list_file: str = "",
    source_kind: str = SOURCE_MANUAL,
    notes: str = "",
    master_id: int | None = None,
    source_block_id: int | None = None,
    source_operation_id: int | None = None,
    quantum_from=None,
    quantum_to=None,
    sample_count: int | None = None,
) -> dict[str, Any]:
    """Publish to master + snapshot. Never updates planner_operation."""
    ensure_cycle_time_snapshot_table(con)
    part_no = compact_text(part_no)
    if not part_no:
        raise ValueError("part_no is required")
    if source_kind not in _VALID_SOURCES:
        raise ValueError(f"invalid source_kind: {source_kind}")

    cycle_new = max(0.0, float(cycle_time or 0))
    setup_new = max(0.0, float(set_up_time or 0))

    master = None
    if master_id:
        master = one(
            con.execute(
                """
                SELECT id, part_no, bom_code, stage_no, stage_name, op_no, op_type,
                       program_no, program_file, tool_list_file,
                       ideal_cycle_time, cycle_time, set_up_time
                FROM public.planner_cycle_time_master
                WHERE id = %s
                """,
                (int(master_id),),
            )
        )
    if not master:
        master = lookup_master_row(
            con,
            part_no=part_no,
            bom_code=bom_code,
            op_no=op_no,
            op_type=op_type,
            stage_no=stage_no or None,
        )

    payload = {
        "part_no": part_no,
        "bom_code": compact_text(bom_code),
        "stage_no": int(stage_no or 0),
        "stage_name": compact_text(stage_name),
        "op_no": op_no,
        "op_type": compact_text(op_type),
        "program_no": compact_text(program_no),
        "program_file": compact_text(program_file),
        "tool_list_file": compact_text(tool_list_file),
        "part_description": compact_text(part_description),
    }

    cycle_old = float(master.get("cycle_time") or 0) if master else None
    setup_old = float(master.get("set_up_time") or 0) if master else None
    update_ideal = source_kind == SOURCE_SHEET
    production_only = _production_cycle_only_source(source_kind)

    if master:
        master_id = int(master["id"])
        if production_only:
            con.execute(
                """
                UPDATE public.planner_cycle_time_master
                SET cycle_time = %s,
                    updated_at = NOW()
                WHERE id = %s
                """,
                (cycle_new, master_id),
            )
            setup_new = setup_old if setup_old is not None else 0.0
        else:
            ideal_clause = ", ideal_cycle_time = %s" if update_ideal else ""
            ideal_param = (cycle_new,) if update_ideal else ()
            con.execute(
                f"""
                UPDATE public.planner_cycle_time_master
                SET cycle_time = %s,
                    set_up_time = %s{ideal_clause},
                    part_description = CASE
                        WHEN %s <> '' THEN %s
                        ELSE part_description
                    END,
                    stage_name = CASE
                        WHEN %s <> '' THEN %s
                        ELSE stage_name
                    END,
                    updated_at = NOW()
                WHERE id = %s
                """,
                (
                    cycle_new,
                    setup_new,
                    *ideal_param,
                    payload["part_description"],
                    payload["part_description"],
                    payload["stage_name"],
                    payload["stage_name"],
                    master_id,
                ),
            )
    else:
        ideal_insert = 0.0 if production_only else cycle_new
        setup_insert = 0.0 if production_only else setup_new
        inserted = one(
            con.execute(
                """
                INSERT INTO public.planner_cycle_time_master (
                    bom_code, part_no, part_description, stage_no, stage_name,
                    op_no, op_type, program_no, program_file, tool_list_file,
                    ideal_cycle_time, cycle_time, set_up_time
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id, ideal_cycle_time, cycle_time, set_up_time
                """,
                (
                    payload["bom_code"],
                    payload["part_no"],
                    payload["part_description"],
                    payload["stage_no"],
                    payload["stage_name"],
                    payload["op_no"],
                    payload["op_type"],
                    payload["program_no"],
                    payload["program_file"],
                    payload["tool_list_file"],
                    ideal_insert,
                    cycle_new,
                    setup_insert,
                ),
            )
        )
        master_id = int(inserted["id"])

    snapshot_id = _insert_snapshot(
        con,
        master_id=master_id,
        row=payload,
        cycle_old=cycle_old,
        setup_old=setup_old,
        cycle_new=cycle_new,
        setup_new=setup_new,
        source_kind=source_kind,
        notes=notes,
        source_block_id=source_block_id,
        source_operation_id=source_operation_id,
        quantum_from=quantum_from,
        quantum_to=quantum_to,
        sample_count=sample_count,
    )

    return {
        "master_id": master_id,
        "snapshot_id": snapshot_id,
        "part_no": part_no,
        "bom_code": payload["bom_code"],
        "cycle_time": cycle_new,
        "set_up_time": setup_new,
        "source_kind": source_kind,
    }


def publish_many(con, items: list[dict[str, Any]], *, default_source: str = SOURCE_PLANNER_HARVEST) -> dict[str, Any]:
    published = []
    errors = []
    for item in items or []:
        if item.get("skip") or item.get("selected") is False:
            continue
        try:
            published.append(
                publish_cycle_time(
                    con,
                    part_no=item.get("part_no") or "",
                    bom_code=item.get("bom_code") or "",
                    stage_no=int(item.get("stage_no") or 0),
                    stage_name=item.get("stage_name") or "",
                    op_no=item.get("op_no"),
                    op_type=item.get("op_type") or "",
                    cycle_time=float(item.get("cycle_time") or item.get("proposed_cycle_time") or 0),
                    set_up_time=float(item.get("set_up_time") or item.get("proposed_set_up_time") or 0),
                    part_description=item.get("part_description") or "",
                    program_no=item.get("program_no") or "",
                    program_file=item.get("program_file") or "",
                    tool_list_file=item.get("tool_list_file") or "",
                    source_kind=compact_text(item.get("source_kind") or default_source) or default_source,
                    notes=item.get("notes") or "",
                    master_id=item.get("master_id") or item.get("current_master_id"),
                    source_block_id=item.get("source_block_id"),
                    source_operation_id=item.get("source_operation_id"),
                )
            )
        except Exception as ex:
            errors.append({"item": item, "error": str(ex)})
    return {"published": published, "errors": errors, "count": len(published)}


def block_cycle_time_context(con, block_id: int) -> dict[str, Any] | None:
    block = one(
        con.execute(
            """
            SELECT b.block_id, o.operation_id, o.cycle_minutes_per_qty, o.setup_minutes,
                   o.source_ps_id, o.source_op_no, o.source_op_seq_id,
                   ps.inventory_code, ps.selected_bom_id,
                   COALESCE(bv.inventory_code, step_bv.inventory_code) AS bom_part_no,
                   TRIM(COALESCE(
                       NULLIF(bv.bom_code, ''),
                       NULLIF(step_bv.bom_code, ''),
                       NULLIF(tps.selected_bom_code, ''),
                       NULLIF(tps.erp_bom_code, ''),
                       NULLIF(erp.erp_bom_code, ''),
                       ''
                   )) AS bom_code,
                   step.op_type, step.op_no, step.source_stage_no,
                   step.op_type || ' ' || step.op_no AS stage_name
            FROM planner_run_block b
            JOIN planner_operation o ON o.operation_id = b.operation_id
            LEFT JOIN planner_process_sheet ps_job
                   ON ps_job.planner_ps_id = NULLIF(TRIM(o.job_no), '')
            LEFT JOIN planner_process_sheet ps_src
                   ON ps_src.planner_ps_id = NULLIF(TRIM(o.source_ps_id), '')
            LEFT JOIN planner_process_sheet ps ON ps.planner_ps_id = COALESCE(
                ps_job.planner_ps_id,
                ps_src.planner_ps_id
            )
            LEFT JOIN planner_temp_process_sheet tps ON tps.planner_ps_id = ps.planner_ps_id
            LEFT JOIN planner_bom_variation bv ON bv.bom_id = ps.selected_bom_id
            LEFT JOIN planner_operation_seq step ON step.op_seq_id = o.source_op_seq_id
            LEFT JOIN planner_bom_variation step_bv ON step_bv.bom_id = step.bom_id
            LEFT JOIN LATERAL (
                SELECT MAX(NULLIF(TRIM(v.bom_code), '')) AS erp_bom_code
                FROM pp_vouchers_cache v
                WHERE v.ps_id = COALESCE(
                    NULLIF(TRIM(ps.source_ps_id), ''),
                    CASE
                        WHEN NULLIF(TRIM(o.source_ps_id), '') LIKE '%::%'
                        THEN split_part(TRIM(o.source_ps_id), '::', 1)
                        ELSE NULLIF(TRIM(o.source_ps_id), '')
                    END,
                    NULLIF(TRIM(o.job_no), '')
                )
                  AND v.pp_partial_no = COALESCE(
                    ps.pp_partial_no,
                    CASE
                        WHEN NULLIF(TRIM(o.source_ps_id), '') ~ '::[0-9]+$'
                        THEN NULLIF(
                            substring(TRIM(o.source_ps_id) FROM '::([0-9]+)$'),
                            ''
                        )::integer
                        ELSE 1
                    END,
                    1
                  )
            ) erp ON TRUE
            WHERE b.block_id = %s
            """,
            (int(block_id),),
        )
    )
    if not block:
        return None

    part_no = compact_text(block.get("bom_part_no") or block.get("inventory_code"))
    bom_code = compact_text(block.get("bom_code"))
    op_no, op_type = normalize_op_identity(block.get("op_type"), block.get("op_no") or block.get("source_op_no"))
    stage_no = int(block.get("source_stage_no") or 0)

    master = lookup_master_row(
        con,
        part_no=part_no,
        bom_code=bom_code,
        op_no=op_no,
        op_type=op_type,
        stage_no=stage_no or None,
    )

    bom_step_cycle = 0.0
    bom_step_setup = 0.0
    if block.get("source_op_seq_id"):
        step = one(
            con.execute(
                "SELECT cycle_time, setup_time FROM planner_operation_seq WHERE op_seq_id = %s",
                (int(block["source_op_seq_id"]),),
            )
        )
        if step:
            bom_step_cycle = float(step.get("cycle_time") or 0)
            bom_step_setup = float(step.get("setup_time") or 0)

    return {
        "block_id": int(block_id),
        "operation_id": int(block.get("operation_id") or 0),
        "part_no": part_no,
        "bom_code": bom_code,
        "op_no": op_no,
        "op_type": op_type,
        "stage_no": stage_no,
        "stage_name": compact_text(block.get("stage_name")),
        "job_cycle_time": float(block.get("cycle_minutes_per_qty") or 0),
        "job_set_up_time": float(block.get("setup_minutes") or 0),
        "bom_step_cycle_time": bom_step_cycle,
        "bom_step_set_up_time": bom_step_setup,
        "master": {
            "id": int(master.get("id") or 0) if master else None,
            "ideal_cycle_time": float(master.get("ideal_cycle_time") or 0) if master else 0.0,
            "cycle_time": float(master.get("cycle_time") or 0) if master else 0.0,
            "set_up_time": float(master.get("set_up_time") or 0) if master else 0.0,
        },
    }


def publish_from_block(con, block_id: int, *, notes: str = "") -> dict[str, Any]:
    ctx = block_cycle_time_context(con, int(block_id))
    if not ctx:
        raise ValueError(f"block not found: {block_id}")
    if not compact_text(ctx.get("part_no")):
        raise ValueError("block has no part / BOM context for master publish")
    job_cycle = float(ctx.get("job_cycle_time") or 0)
    if job_cycle <= 0:
        raise ValueError("job cycle time must be greater than zero")

    return publish_cycle_time(
        con,
        part_no=ctx["part_no"],
        bom_code=ctx.get("bom_code") or "",
        stage_no=int(ctx.get("stage_no") or 0),
        stage_name=ctx.get("stage_name") or "",
        op_no=ctx.get("op_no"),
        op_type=ctx.get("op_type") or "",
        cycle_time=job_cycle,
        set_up_time=float(ctx.get("job_set_up_time") or 0),
        source_kind=SOURCE_PLANNER_JOB,
        notes=notes,
        master_id=ctx.get("master", {}).get("id"),
        source_block_id=int(block_id),
        source_operation_id=int(ctx.get("operation_id") or 0) or None,
    )
