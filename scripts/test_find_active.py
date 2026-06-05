from planning.helpers import planner_db, one
from planning.blocks import find_active_catalog_lane_block
from planning.process_sheets import format_planner_ps_id

base = "NPS26-0222"
with planner_db() as con:
    m = one(
        con.execute(
            "SELECT machine_id FROM planner_machines WHERE UPPER(machine_no) = %s",
            ("CNC 35",),
        )
    )
    mid = int(m["machine_id"])
    for ps in (base, format_planner_ps_id(base, 2)):
        bid = find_active_catalog_lane_block(con, mid, ps, "20", 0)
        print(f"find_active({ps!r}, OP20) => {bid}")
