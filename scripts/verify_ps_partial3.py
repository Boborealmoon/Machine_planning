import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from planning.helpers import planner_db, one
from planning.process_sheets import _PS_SELECT, _flow_steps_for_ps_ids, _resolve_process_sheet_steps, _process_sheet_payload, _flow_steps_for_ps_ids
from planning.process_sheets import _block_metrics_for_ps_ids, _resolve_process_sheet_steps
from planning.process_sheets import material_status_map_for_ps_ids, _step_payload

PS = "NPS25-0279::3"

with planner_db() as con:
    ps = one(con.execute(_PS_SELECT + " WHERE ps.planner_ps_id = %s", (PS,)))
    print("header wo_qty_produced:", ps.get("wo_qty_produced"))
    steps_by = _flow_steps_for_ps_ids(con, [PS])
    steps = _resolve_process_sheet_steps(con, dict(ps), steps_by.get(PS, []))
    metrics_by, _ = _block_metrics_for_ps_ids(con, [PS])
    mat = material_status_map_for_ps_ids(con, [PS], {})
    summary = _process_sheet_payload(dict(ps), steps, metrics_by.get(PS, {}), mat.get(PS, {}))
    print("summary finished:", summary.get("finished_qty"))
    for op in summary.get("ops") or []:
        print(op.get("op_no"), op.get("stage_desc") or op.get("op_type"), "fin=", op.get("finished_qty"), "erp=", op.get("wo_qty_produced"))
