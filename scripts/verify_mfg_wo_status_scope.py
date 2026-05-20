"""Verify mfg_wo_status scoped sync: timing, row counts, cache join coverage."""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO))
os.environ.setdefault("WERKZEUG_RUN_MAIN", "false")


def main() -> int:
    from planning.helpers import planner_db, rows as db_rows
    from sync import _build_mfg_wo_status_sql, run_mfg_wo_status_sync

    print("=== 1) Scoped mfg_wo_status sync (Supabase reload) ===\n")
    result = run_mfg_wo_status_sync(force=True)
    for k in (
        "duration_ms",
        "query_ms",
        "reload_ms",
        "row_count",
        "reload",
        "scoped",
        "skipped",
        "reason",
        "error",
    ):
        if k in result:
            print(f"  {k}: {result[k]}")
    if result.get("error") or (result.get("skipped") and not result.get("row_count")):
        print("\nSync did not complete; cannot verify joins.")
        return 1

    print("\n=== 2) Supabase table / view counts ===\n")
    with planner_db() as con:
        counts = {}
        for label, sql in [
            ("mfg_wo_status", "SELECT COUNT(*) AS c FROM public.mfg_wo_status"),
            ("pp_voucher", "SELECT COUNT(*) AS c FROM public.pp_voucher"),
            ("pp_partial", "SELECT COUNT(*) AS c FROM public.pp_partial"),
            ("pp_vouchers_cache", "SELECT COUNT(*) AS c FROM public.pp_vouchers_cache"),
            ("vw_pp_vouchers", "SELECT COUNT(*) AS c FROM public.vw_pp_vouchers"),
            ("cache Outstanding", "SELECT COUNT(*) AS c FROM public.pp_vouchers_cache WHERE COALESCE(status,'') <> 'History'"),
        ]:
            counts[label] = int(db_rows(con.execute(sql))[0]["c"])
            print(f"  {label}: {counts[label]:,}")

        print("\n=== 3) Join coverage: cache rows vs mfg_wo_status (full triple key) ===\n")
        coverage = db_rows(
            con.execute(
                """
                WITH cache_rows AS (
                    SELECT ps_id, pp_partial_no, stage_no
                    FROM public.pp_vouchers_cache
                    WHERE COALESCE(status, '') <> 'History'
                )
                SELECT
                    COUNT(*) AS cache_rows,
                    COUNT(ws.source_mps_no) AS matched_wo,
                    COUNT(*) - COUNT(ws.source_mps_no) AS missing_wo
                FROM cache_rows c
                LEFT JOIN public.mfg_wo_status ws
                  ON ws.source_mps_no = c.ps_id
                 AND ws.pp_partial_no = c.pp_partial_no
                 AND ws.stage_no = c.stage_no
                """
            )
        )[0]
        cache_rows = int(coverage["cache_rows"])
        matched = int(coverage["matched_wo"])
        missing = int(coverage["missing_wo"])
        pct = (100.0 * matched / cache_rows) if cache_rows else 0.0
        print(f"  Active cache rows: {cache_rows:,}")
        print(f"  With WO status row: {matched:,} ({pct:.1f}%)")
        print(f"  Missing WO row:     {missing:,}")

        print("\n=== 4) Sample PS ids missing WO join (up to 10) ===\n")
        samples = db_rows(
            con.execute(
                """
                SELECT c.ps_id, c.pp_partial_no, c.stage_no, c.execution_status, c.stage_desc
                FROM public.pp_vouchers_cache c
                LEFT JOIN public.mfg_wo_status ws
                  ON ws.source_mps_no = c.ps_id
                 AND ws.pp_partial_no = c.pp_partial_no
                 AND ws.stage_no = c.stage_no
                WHERE COALESCE(c.status, '') <> 'History'
                  AND ws.source_mps_no IS NULL
                ORDER BY c.ps_id, c.pp_partial_no, c.stage_no
                LIMIT 10
                """
            )
        )
        if not samples:
            print("  (none — all active cache rows matched a WO status row)")
        else:
            for row in samples:
                print(
                    f"  {row['ps_id']} partial={row['pp_partial_no']} stage={row['stage_no']} "
                    f"cache_exec={row.get('execution_status')!r} {row.get('stage_desc')!r}"
                )

        print("\n=== 5) current_execution_stage fields populated on cache ===\n")
        stage_pop = db_rows(
            con.execute(
                """
                SELECT
                    COUNT(*) AS n,
                    COUNT(NULLIF(TRIM(current_stage_desc), '')) AS with_current_stage
                FROM public.pp_vouchers_cache
                WHERE COALESCE(status, '') <> 'History'
                """
            )
        )[0]
        n = int(stage_pop["n"])
        with_stage = int(stage_pop["with_current_stage"])
        print(f"  Active cache rows: {n:,}")
        print(f"  With current_stage_desc: {with_stage:,} ({100.0 * with_stage / n if n else 0:.1f}%)")

        print("\n=== 6) execution_status distribution (cache, active) ===\n")
        for row in db_rows(
            con.execute(
                """
                SELECT COALESCE(execution_status, '(null)') AS s, COUNT(*) AS c
                FROM public.pp_vouchers_cache
                WHERE COALESCE(status, '') <> 'History'
                GROUP BY 1
                ORDER BY c DESC
                """
            )
        ):
            print(f"  {row['s']}: {row['c']:,}")

    print("\n=== 7) COMAIN scoped vs unscoped row estimate (query only, no reload) ===\n")
    try:
        from db import get_conn, release_conn

        scoped_sql, scoped_params = _build_mfg_wo_status_sql(scoped=True)
        unscoped_sql, unscoped_params = _build_mfg_wo_status_sql(scoped=False)
        src = get_conn()
        try:
            with src.cursor() as cur:
                t0 = time.perf_counter()
                cur.execute(f"SELECT COUNT(*) FROM ({scoped_sql}) q", scoped_params or None)
                scoped_n = int(cur.fetchone()[0])
                scoped_ms = int((time.perf_counter() - t0) * 1000)
                t0 = time.perf_counter()
                cur.execute(f"SELECT COUNT(*) FROM ({unscoped_sql}) q", unscoped_params or None)
                unscoped_n = int(cur.fetchone()[0])
                unscoped_ms = int((time.perf_counter() - t0) * 1000)
        finally:
            release_conn(src)
        print(f"  COMAIN scoped aggregate rows:   {scoped_n:,} ({scoped_ms:,} ms)")
        print(f"  COMAIN unscoped aggregate rows: {unscoped_n:,} ({unscoped_ms:,} ms)")
        if unscoped_n:
            print(f"  Reduction: {100.0 * (1 - scoped_n / unscoped_n):.1f}% fewer rows")
    except Exception as exc:
        print(f"  COMAIN not reachable from this host: {exc}")

    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
