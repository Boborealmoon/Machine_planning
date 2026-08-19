"""Guards so the finishing-queue API does not DISTINCT ON the whole WO table."""

from planning.erp_wo_merge import FINISHING_STAGE_DESCS
from planning.finishing_queue_service import _build_finishing_queue_staging_sql
from sync import PP_VOUCHER_PS_ID_PREFIXES


def test_finishing_queue_sql_scopes_distinct_on_to_finishing_candidates():
    sql, params = _build_finishing_queue_staging_sql()
    lowered = sql.lower()

    assert "finishing_candidates" in lowered
    assert "inner join finishing_candidates" in lowered
    assert "from mfg_wo_status" in lowered
    # Must not sort every open WO before knowing it has a finishing stage.
    assert "coalesce(execution_status, '') not in" not in lowered
    assert sql.count("%s") == 2 + len(PP_VOUCHER_PS_ID_PREFIXES) + 1

    stage_list = list(FINISHING_STAGE_DESCS)
    assert params[0] == stage_list
    assert params[-1] == stage_list
    assert len(params) == sql.count("%s")
