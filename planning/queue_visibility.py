"""Server-side machine-lane visibility — mirrors trialGroupCompletedForQueue in data.js."""

from __future__ import annotations



from .blocks import _row_planner_ps_identity

from .catalog import _is_manual_bom_step, catalog_lane_context_for_blocks

from .utils import compact_text, execution_status_is_completed



QTY_TOL = 0.0001





def _normalize_exec_status(value) -> str:

    raw = compact_text(value)

    if not raw:

        return ""

    norm = raw.upper().replace(" ", "_").replace("-", "_")

    if norm == "PENDING":

        return "PENDING_SI"

    return norm





def _execution_done(value) -> bool:

    text = compact_text(value).upper().replace("-", "_").replace(" ", "_")

    return text in {"C", "COMPLETED", "DONE"}





def _catalog_op_matches_block(card_op_no, card_op_seq_id, card_op_label, block) -> bool:

    block_op = compact_text(block.get("source_op_no"))

    card_op = compact_text(card_op_no)

    if card_op and block_op and card_op == block_op:

        return True

    label = compact_text(card_op_label)

    if label and block_op and label == block_op:

        return True

    block_seq = int(block.get("source_op_seq_id") or 0)

    card_seq = int(card_op_seq_id or 0)

    return card_seq > 0 and block_seq > 0 and card_seq == block_seq





def _catalog_op_is_open(card: dict) -> bool:

    if card.get("is_manual_bom") or _is_manual_bom_step(card.get("op") or card):

        return True

    remaining = float(card.get("remaining_qty") or card.get("target_qty") or 0)

    if remaining > QTY_TOL:

        return True

    exec_status = _normalize_exec_status(

        card.get("execution_status") or (card.get("op") or {}).get("execution_status")

    )

    required = float(card.get("required_qty") or card.get("wo_qty_required") or 0)

    produced = float(card.get("finished_qty") or card.get("wo_qty_produced") or 0)

    has_wo = required > QTY_TOL or produced > QTY_TOL or bool(exec_status)

    if not has_wo:

        return False

    return not execution_status_is_completed(exec_status)





def _block_net_output(block) -> float:

    scheduled = float(block.get("scheduled_qty") or 0)

    good = float(

        block.get("qs_good_qty")

        or block.get("good_qty")

        or block.get("actual_good_qty")

        or 0

    )

    if _execution_done(block.get("execution_status") or block.get("status")) and scheduled > 0 and good <= 0:

        return scheduled

    return max(0.0, good)





def _block_lane_remaining_qty(block) -> float:

    if _execution_done(block.get("execution_status") or block.get("status")):

        return 0.0

    scheduled = float(block.get("scheduled_qty") or 0)

    return max(0.0, scheduled - _block_net_output(block))





def _paired_remaining_qty(blocks) -> float:

    if not blocks:

        return 0.0

    target = max(float(b.get("scheduled_qty") or 0) for b in blocks)

    paired_output = min(_block_net_output(b) for b in blocks)

    return max(0.0, target - paired_output)





def _partial_key_for_block(block) -> tuple[str, int] | None:

    base, partial = _row_planner_ps_identity(block)

    if not base:

        return None

    return base, int(partial or 1)





def _block_completed_by_catalog(block, op_cards_by_partial) -> bool:

    key = _partial_key_for_block(block)

    if not key:

        return False

    cards = op_cards_by_partial.get(key, [])

    for card in cards:

        if _catalog_op_matches_block(

            card.get("source_op_no"),

            card.get("source_op_seq_id"),

            card.get("operation_label"),

            block,

        ):

            return not _catalog_op_is_open(card)

    return False





def _row_done_for_queue(block, op_cards_by_partial) -> bool:

    if _execution_done(block.get("execution_status") or block.get("status")):

        return True

    scheduled = float(block.get("scheduled_qty") or 0)

    if scheduled > QTY_TOL and _block_net_output(block) >= scheduled - QTY_TOL:

        return True

    if _block_lane_remaining_qty(block) > QTY_TOL:

        return False

    return _block_completed_by_catalog(block, op_cards_by_partial)





def group_completed_for_queue(member_blocks, op_cards_by_partial) -> bool:

    if not member_blocks:

        return False

    if _paired_remaining_qty(member_blocks) > QTY_TOL:

        return False

    return all(_row_done_for_queue(block, op_cards_by_partial) for block in member_blocks)





def apply_lane_due_dates_from_catalog(blocks, due_by_partial) -> None:

    """Align lane card due dates with catalog ERP dates (not Coway proposed EDD)."""

    if not blocks or not due_by_partial:

        return

    for block in blocks:

        key = _partial_key_for_block(block)

        if not key:

            continue

        due_text = compact_text(due_by_partial.get(key))

        if due_text:

            block["due_date"] = due_text





def _row_done_fast_for_lane(block) -> bool:
    """Hide lane rows by status/qty only — no with-ops catalog round trip."""
    if _execution_done(block.get("execution_status") or block.get("status")):
        return True
    scheduled = float(block.get("scheduled_qty") or 0)
    if scheduled > QTY_TOL and _block_net_output(block) >= scheduled - QTY_TOL:
        return True
    return False


def _group_completed_fast(member_blocks) -> bool:
    if not member_blocks:
        return False
    if _paired_remaining_qty(member_blocks) > QTY_TOL:
        return False
    return all(_row_done_fast_for_lane(block) for block in member_blocks)


def filter_completed_lane_blocks_fast(blocks):
    """Lite board load: drop clearly finished lane cards without catalog enrichment."""
    if not blocks:
        return blocks
    groups: dict[str, list[dict]] = {}
    for block in blocks:
        group_id = int(block.get("group_id") or 0)
        block_id = int(block.get("block_id") or 0)
        group_key = f"g:{group_id}" if group_id > 0 else f"s:{block_id}"
        groups.setdefault(group_key, []).append(block)
    hide_ids: set[int] = set()
    for members in groups.values():
        if _group_completed_fast(members):
            hide_ids.update(int(b.get("block_id") or 0) for b in members if int(b.get("block_id") or 0) > 0)
    if not hide_ids:
        return blocks
    return [b for b in blocks if int(b.get("block_id") or 0) not in hide_ids]


def filter_completed_lane_blocks(con, blocks):

    """Drop lane blocks whose display group is finished per ERP/catalog rules."""

    if not blocks:

        return blocks



    op_cards_by_partial, due_by_partial = catalog_lane_context_for_blocks(con, blocks)

    apply_lane_due_dates_from_catalog(blocks, due_by_partial)



    groups: dict[str, list[dict]] = {}

    for block in blocks:

        group_id = int(block.get("group_id") or 0)

        block_id = int(block.get("block_id") or 0)

        group_key = f"g:{group_id}" if group_id > 0 else f"s:{block_id}"

        groups.setdefault(group_key, []).append(block)



    hide_ids: set[int] = set()

    for members in groups.values():

        if group_completed_for_queue(members, op_cards_by_partial):

            hide_ids.update(int(b.get("block_id") or 0) for b in members if int(b.get("block_id") or 0) > 0)



    if not hide_ids:

        return blocks

    return [b for b in blocks if int(b.get("block_id") or 0) not in hide_ids]

