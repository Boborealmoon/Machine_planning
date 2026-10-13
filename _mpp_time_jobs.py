"""Temporary phase timer for MPP planner job intake. Delete after use."""
import time

from planning.helpers import planner_db
from planning import mpp_planner_service as s


class C:
    def __init__(self, con):
        self.con = con
        self.n = 0
        self.slow = []

    def execute(self, sql, params=None):
        self.n += 1
        t = time.perf_counter()
        try:
            if params is None:
                return self.con.execute(sql)
            return self.con.execute(sql, params)
        finally:
            dt = time.perf_counter() - t
            if dt >= 0.15:
                one = " ".join(str(sql).split())[:180]
                self.slow.append((round(dt, 3), one))

    def __getattr__(self, name):
        return getattr(self.con, name)


def main():
    t0 = time.perf_counter()
    with planner_db() as raw:
        raw.execute("SET LOCAL statement_timeout = '120000'")
        con = C(raw)
        marks = []

        def mark(label):
            marks.append((label, round(time.perf_counter() - t0, 2), con.n))

        mark("start")
        s.ensure_frame_agreement_schema(con)
        mark("schema")
        fa_keys = s.load_frame_agreement_mpp_part_keys(con)
        mark(f"fa_keys {len(fa_keys)}")
        mpp_codes = s.mpp_machine_code_set(con)
        mark(f"mpp_codes {len(mpp_codes)}")
        sheets = s._load_mpp_planner_process_sheet_rows(con, fa_keys, fa_only=True)
        mark(f"sheets {len(sheets)}")
        ctx = s._build_intake_context(con, sheets, mpp_codes)
        mark("context")
        t_en = time.perf_counter()
        n0 = con.n
        from planning.erp_wo_merge import mfg_wo_stages_batch

        steps = s._load_operation_steps_by_bom(
            con, [int(row.get("selected_bom_id") or 0) for row in sheets]
        )
        mark(f"steps boms={len(steps)}")
        partial_keys = [
            (s.compact_text(row.get("source_ps_id")), int(row.get("pp_partial_no") or 1))
            for row in sheets
            if s.compact_text(row.get("source_ps_id"))
        ]
        wo = mfg_wo_stages_batch(con, partial_keys)
        mark(f"wo {len(wo)}")
        t_fill = time.perf_counter()
        n1 = con.n
        jobs = []
        seen = set()
        for entry in sheets:
            bom_id = int(entry.get("selected_bom_id") or 0)
            key = (s.compact_text(entry.get("source_ps_id")), int(entry.get("pp_partial_no") or 1))
            enriched = s._fill_sheet_ops_from_cache(
                dict(entry), steps.get(bom_id, []), wo.get(key, []), ctx
            )
            s._emit_jobs_from_item(enriched, ctx, jobs, seen)
        mark(f"fill all jobs={len(jobs)} q={con.n - n1} dt={time.perf_counter() - t_fill:.2f}")
        # Compare two sheets against the old per-sheet enrich.
        diffs = 0
        for entry in sheets[:2]:
            old = s._enrich_entry_ops(con, dict(entry), ctx)
            new = s._fill_sheet_ops_from_cache(
                dict(entry),
                steps.get(int(entry.get("selected_bom_id") or 0), []),
                wo.get((s.compact_text(entry.get("source_ps_id")), int(entry.get("pp_partial_no") or 1)), []),
                ctx,
            )
            old_jobs, new_jobs, seen_a, seen_b = [], [], set(), set()
            s._emit_jobs_from_item(old, ctx, old_jobs, seen_a)
            s._emit_jobs_from_item(new, ctx, new_jobs, seen_b)
            old_map = {j["jobId"]: j for j in old_jobs}
            new_map = {j["jobId"]: j for j in new_jobs}
            if set(old_map) != set(new_map):
                diffs += 1
                print("ID DIFF", entry.get("ps_id"), set(old_map) ^ set(new_map))
            for job_id, old_job in old_map.items():
                new_job = new_map.get(job_id)
                if not new_job:
                    continue
                for field in ("remainingQty", "schedulable", "erpFinished", "plannedQty", "minPerPallet"):
                    if old_job.get(field) != new_job.get(field):
                        diffs += 1
                        print("FIELD", entry.get("ps_id"), job_id, field, old_job.get(field), new_job.get(field))
        mark(f"compare diffs={diffs}")
        print("MARKS")
        for row in marks:
            print(row)
        print("SLOW")
        for row in sorted(con.slow, reverse=True)[:12]:
            print(row)
        print(f"queries={con.n} sheets={len(sheets)}")


if __name__ == "__main__":
    main()
