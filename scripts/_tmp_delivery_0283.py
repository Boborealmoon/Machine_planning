#!/usr/bin/env python3
import time

from planning.helpers import planner_db
from planning.process_sheets import (
    list_delivery_schedule_board_items,
    list_process_sheets_payload,
)


def hits(items, needle="0283"):
    out = [
        i
        for i in items
        if needle in str(i.get("source_ps_id", "")).upper()
        or needle in str(i.get("ps_id", "")).upper()
    ]
    return sorted(out, key=lambda x: int(x.get("pp_partial_no") or 1))


def main():
    from app import app

    with app.test_request_context():
        with planner_db() as con:
            t0 = time.time()
            all_items = list_process_sheets_payload(con, show_completed=True)
            t1 = time.time()
            print(f"list_process_sheets_payload(all) count={len(all_items)} time={t1 - t0:.1f}s")
            for i in hits(all_items):
                print(
                    f"  partial={i.get('pp_partial_no')} ps_id={i.get('ps_id')} "
                    f"completed={i.get('is_completed')} shipped={i.get('shipped_completed')} "
                    f"erp_wo={i.get('erp_all_wo_complete')} exec={i.get('execution_completed')} "
                    f"stage={i.get('current_stage_status')}"
                )

            open_items = list_process_sheets_payload(con, show_completed=False)
            print(f"open planner hits for 0283: {len(hits(open_items))}")

            t_search0 = time.time()
            search_items = list_delivery_schedule_board_items(con, search="283")
            t_search1 = time.time()
            print(f"search=283 count={len(search_items)} time={t_search1 - t_search0:.1f}s")
            for i in hits(search_items):
                print(
                    f"  partial={i.get('pp_partial_no')} ps_id={i.get('ps_id')} "
                    f"completed={i.get('is_completed')}"
                )

            t2 = time.time()
            board = list_delivery_schedule_board_items(con)
            t3 = time.time()
            print(f"list_delivery_schedule_board_items(full) count={len(board)} time={t3 - t2:.1f}s")
            print(f"delivery board hits for 0283: {len(hits(board))}")
            for i in hits(board):
                print(
                    f"  partial={i.get('pp_partial_no')} ps_id={i.get('ps_id')} "
                    f"completed={i.get('is_completed')}"
                )


if __name__ == "__main__":
    main()
