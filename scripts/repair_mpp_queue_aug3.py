#!/usr/bin/env python3
"""One-shot MPP queue repair: clear CNC41 past anchor, drop ERP-met 0341, trim 0229 overrun."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _op_ps(op: dict) -> str:
    return str(op.get("sourcePsId") or op.get("psId") or "").strip().upper()


def _cycle_has_ps(cycle: dict, ps: str) -> bool:
    target = ps.upper()
    return any(_op_ps(op) == target or target in str(op.get("jobId") or "").upper() for op in (cycle.get("ops") or []))


def main() -> int:
    try:
        from dotenv import load_dotenv

        load_dotenv(ROOT / ".env")
    except ImportError:
        pass

    from planning.helpers import planner_db
    from planning.mpp_planner_queue_service import (
        load_mpp_planner_queue,
        recalculate_mpp_planner_machines,
        save_mpp_planner_queue,
    )
    from planning.mpp_planner_service import fetch_mpp_planner_machines

    with planner_db() as con:
        queue = load_mpp_planner_queue(con)
        machines = queue.get("machines") or {}
        slug_by_code = {
            str(m.get("code") or "").upper(): m["id"]
            for m in fetch_mpp_planner_machines(con)
        }
        cnc35 = slug_by_code.get("CNC 35", "cnc35")
        cnc41 = slug_by_code.get("CNC 41", "cnc41")

        lane35 = machines.get(cnc35) or {"laneAnchor": "", "cycles": []}
        lane41 = machines.get(cnc41) or {"laneAnchor": "", "cycles": []}

        before35 = len(lane35.get("cycles") or [])
        before41 = len(lane41.get("cycles") or [])

        # CNC 35: drop one NPS26-0229 cycle (last matching) ? 12 pc ? 9 pc
        cycles35 = list(lane35.get("cycles") or [])
        drop_idx = None
        for i in range(len(cycles35) - 1, -1, -1):
            if _cycle_has_ps(cycles35[i], "NPS26-0229"):
                drop_idx = i
                break
        if drop_idx is None:
            print("WARN: no NPS26-0229 cycle found on CNC 35")
        else:
            removed = cycles35.pop(drop_idx)
            print(f"CNC 35: removed cycle {removed.get('cycleId')} (NPS26-0229)")
        lane35["cycles"] = cycles35

        # CNC 41: clear past lane anchor; drop all NPS26-0341 cycles
        old_anchor = lane41.get("laneAnchor") or ""
        lane41["laneAnchor"] = ""
        cycles41 = [
            c for c in (lane41.get("cycles") or []) if not _cycle_has_ps(c, "NPS26-0341")
        ]
        removed_0341 = before41 - len(cycles41)
        lane41["cycles"] = cycles41
        print(f"CNC 41: cleared laneAnchor {old_anchor!r} ? ''")
        print(f"CNC 41: removed {removed_0341} NPS26-0341 cycle(s); kept {len(cycles41)}")

        machines[cnc35] = lane35
        machines[cnc41] = lane41

        payload = {
            "machines": machines,
            "probation": queue.get("probation") or {},
            "jobOverrides": queue.get("jobOverrides") or {},
            "dirtyMachines": [cnc35, cnc41],
            "recalculate": False,
        }
        result = save_mpp_planner_queue(con, payload)
        print("save:", {k: result.get(k) for k in ("machinesTouched", "warnings", "touchedMachineIds", "partial")})

        mid_by_slug = {
            m["id"]: int(m.get("machineId") or 0) for m in fetch_mpp_planner_machines(con)
        }
        ids = [mid_by_slug[s] for s in (cnc35, cnc41) if mid_by_slug.get(s)]
        recalc = recalculate_mpp_planner_machines(con, ids, reason="MPP_QUEUE_REPAIR")
        print("recalc:", recalc)

        verify = load_mpp_planner_queue(con)
        v35 = (verify.get("machines") or {}).get(cnc35) or {}
        v41 = (verify.get("machines") or {}).get(cnc41) or {}
        n0229 = sum(1 for c in (v35.get("cycles") or []) if _cycle_has_ps(c, "NPS26-0229"))
        n0341 = sum(1 for c in (v41.get("cycles") or []) if _cycle_has_ps(c, "NPS26-0341"))
        n0342 = sum(1 for c in (v41.get("cycles") or []) if _cycle_has_ps(c, "NPS26-0342"))
        print(
            f"verify: cnc35 cycles={len(v35.get('cycles') or [])} (was {before35}) "
            f"0229={n0229}; cnc41 anchor={v41.get('laneAnchor')!r} "
            f"cycles={len(v41.get('cycles') or [])} (was {before41}) 0341={n0341} 0342={n0342}"
        )
        ok = n0229 == 3 and n0341 == 0 and n0342 == 5 and not (v41.get("laneAnchor") or "").strip()
        print("PASS" if ok else "FAIL")
        return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
