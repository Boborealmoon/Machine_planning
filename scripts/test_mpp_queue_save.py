#!/usr/bin/env python3
"""Test MPP queue save round-trip (dry-run with rollback unless --commit)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    commit = "--commit" in sys.argv
    try:
        from dotenv import load_dotenv

        load_dotenv(ROOT / ".env")
    except ImportError:
        pass

    from planning.helpers import one, planner_db
    from planning.mpp_planner_queue_service import (
        _canonical_planner_ps_id,
        _mpp_job_context,
        _resolve_bom_step,
        load_mpp_planner_queue,
        save_mpp_planner_queue,
    )

    with planner_db() as con:
        for job_id in ["nps26-0222::p1::op30", "nps26-0225::p1::op40", "nps26-0217::p1::op30"]:
            ctx = _mpp_job_context(job_id, {})
            ps = _canonical_planner_ps_id(con, ctx["source_ps_id"], ctx["pp_partial_no"])
            step = _resolve_bom_step(con, ps, ctx["source_op_seq_id"], ctx["source_op_no"])
            print(
                f"BOM {job_id}: ps={ps} "
                f"step={step.get('op_no') if step else None} "
                f"seq={step.get('op_seq_id') if step else None}"
            )

        q = load_mpp_planner_queue(con)
        before = {}
        for slug, lane in (q.get("machines") or {}).items():
            linked = sum(
                1
                for cycle in lane.get("cycles") or []
                for op in cycle.get("ops") or []
                if int(op.get("blockId") or 0) > 0
            )
            before[slug] = {"cycles": len(lane.get("cycles") or []), "linked_ops": linked}
        print("Before save:", before)

        result = save_mpp_planner_queue(
            con,
            {"machines": q["machines"], "jobs": q.get("jobOverrides") or {}},
        )
        print("Save result:", result)

        q2 = load_mpp_planner_queue(con)
        after = {}
        for slug, lane in (q2.get("machines") or {}).items():
            linked = sum(
                1
                for cycle in lane.get("cycles") or []
                for op in cycle.get("ops") or []
                if int(op.get("blockId") or 0) > 0
            )
            after[slug] = {"cycles": len(lane.get("cycles") or []), "linked_ops": linked}
        print("After save:", after)

        for slug in before:
            if before[slug]["cycles"] != after[slug]["cycles"]:
                print(f"FAIL: cycle count changed for {slug}")
                if not commit:
                    con.rollback()
                return 1
            total_ops = sum(len(c.get("ops") or []) for c in (q2["machines"].get(slug, {}).get("cycles") or []))
            if after[slug]["linked_ops"] < total_ops:
                print(
                    f"FAIL: {slug} still has unlinked ops "
                    f"({after[slug]['linked_ops']}/{total_ops} linked)"
                )
                if not commit:
                    con.rollback()
                return 1

        if commit:
            print("COMMITTED")
        else:
            con.rollback()
            print("ROLLED BACK (pass — use --commit to persist fix)")

    print("PASS: save round-trip links all cycle ops to blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
