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


def lookup_master_row(
    con,
    *,
    part_no: str,
    bom_code: str,
    op_no: int | None = None,
    op_type: str = "",
    stage_no: int | None = None,
) -> dict[str, Any] | None:
    part_no = compact_text(part_no)
    if not part_no:
        return None
    bom_code = compact_text(bom_code)
    op_type = compact_text(op_type)
    op_text = str(op_no) if op_no is not None else ""
    stage_val = int(stage_no or 0)

    return one(
        con.execute(
            """
            SELECT id, part_no, bom_code, stage_no, stage_name, op_no, op_type,
                   program_no, program_file, tool_list_file,
                   ideal_cycle_time, cycle_time, set_up_time, updated_at
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


def harvest_preview(con, *, strategy: str = "latest") -> list[dict[str, Any]]:
    ensure_cycle_time_snapshot_table(con)
    out: list[dict[str, Any]] = []
    for row in rows(con.execute(HARVEST_PREVIEW_SQL)):
        part_no = compact_text(row.get("part_no"))
        bom_code = compact_text(row.get("bom_code"))
        op_no = _parse_op_no(row.get("op_no_raw"))
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
            op_type=compact_text(row.get("op_type")),
            stage_no=int(row.get("stage_no") or 0) or None,
        )
        proposed_cycle, proposed_setup, source_block_id, source_operation_id = _proposed_from_jobs(
            jobs, strategy
        )
        current_cycle = float(master.get("cycle_time") or 0) if master else 0.0
        current_setup = float(master.get("set_up_time") or 0) if master else 0.0
        job_count = int(row.get("job_count") or len(jobs) or 1)
        cycle_min = float(row.get("cycle_min") or proposed_cycle)
        cycle_max = float(row.get("cycle_max") or proposed_cycle)
        has_variance = abs(cycle_max - cycle_min) > 0.009
        bom_step_cycle = float(row.get("bom_step_cycle_time") or 0)
        is_placeholder = bom_code.upper() in {"PLACEHOLDER", ""} and bom_step_cycle <= 1.01
        recommendation = "review" if has_variance or is_placeholder else "clear"
        median_cycle = _median([j["cycle_time"] for j in jobs])
        mode_cycle = _mode([j["cycle_time"] for j in jobs])
        differs = (
            master is None
            or abs(current_cycle - proposed_cycle) > 0.009
            or abs(current_setup - proposed_setup) > 0.009
        )
        auto_select = differs and recommendation == "clear"
        out.append(
            {
                "key": f"{part_no}|{bom_code}|{compact_text(row.get('op_type'))}|{compact_text(row.get('op_no_raw'))}",
                "part_no": part_no,
                "bom_code": bom_code,
                "part_description": compact_text(row.get("part_description")),
                "stage_no": int(row.get("stage_no") or 0),
                "stage_name": compact_text(row.get("stage_name")),
                "op_no": op_no,
                "op_type": compact_text(row.get("op_type")),
                "proposed_cycle_time": proposed_cycle,
                "proposed_set_up_time": proposed_setup,
                "publish_cycle_time": proposed_cycle,
                "publish_set_up_time": proposed_setup,
                "median_cycle_time": median_cycle,
                "mode_cycle_time": mode_cycle,
                "bom_step_cycle_time": bom_step_cycle,
                "bom_step_set_up_time": float(row.get("bom_step_set_up_time") or 0),
                "current_master_id": int(master.get("id") or 0) if master else None,
                "current_cycle_time": current_cycle,
                "current_set_up_time": current_setup,
                "job_count": job_count,
                "cycle_min": cycle_min,
                "cycle_max": cycle_max,
                "has_variance": has_variance,
                "is_placeholder": is_placeholder,
                "recommendation": recommendation,
                "differs_from_master": differs,
                "jobs": jobs,
                "source_operation_id": source_operation_id,
                "source_block_id": source_block_id,
                "selected": auto_select,
                "expanded": False,
                "picked_job_index": 0 if recommendation == "clear" else None,
            }
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

    if master:
        master_id = int(master["id"])
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
                    cycle_new,
                    cycle_new,
                    setup_new,
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
    op_no = _parse_op_no(block.get("op_no") or block.get("source_op_no"))
    op_type = compact_text(block.get("op_type"))
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
