-- PPS process-sheet overlays (PS-level remarks, flag, material date, delivery week).

CREATE TABLE IF NOT EXISTS public.planner_pps_sheet_overlay (
    ps_id           TEXT         NOT NULL,
    pp_partial_no   INTEGER      NOT NULL DEFAULT 1,
    remarks         TEXT         NOT NULL DEFAULT '',
    flagged         BOOLEAN      NOT NULL DEFAULT FALSE,
    material_date   DATE,
    delivery_week   TEXT         NOT NULL DEFAULT '',
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ps_id, pp_partial_no)
);

CREATE INDEX IF NOT EXISTS idx_pps_sheet_overlay_flagged
    ON public.planner_pps_sheet_overlay (flagged)
    WHERE flagged = TRUE;

-- Lift any existing per-stage overlays into one row per PS.
INSERT INTO public.planner_pps_sheet_overlay
    (ps_id, pp_partial_no, remarks, flagged, material_date, delivery_week, updated_at)
SELECT
    UPPER(TRIM(ps_id)),
    pp_partial_no,
    COALESCE(
        NULLIF(TRIM(MAX(CASE WHEN NULLIF(TRIM(remarks), '') IS NOT NULL THEN remarks END)), ''),
        ''
    ),
    BOOL_OR(flagged),
    MAX(material_date),
    COALESCE(
        NULLIF(TRIM(MAX(CASE WHEN NULLIF(TRIM(delivery_week), '') IS NOT NULL THEN delivery_week END)), ''),
        ''
    ),
    MAX(updated_at)
FROM public.planner_pps_op_overlay
GROUP BY UPPER(TRIM(ps_id)), pp_partial_no
ON CONFLICT (ps_id, pp_partial_no) DO NOTHING;

NOTIFY pgrst, 'reload schema';
