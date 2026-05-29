-- Track SG MOM import vs manual public holidays.
ALTER TABLE public.planner_public_holiday
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE public.planner_public_holiday
    ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ;

COMMENT ON COLUMN public.planner_public_holiday.source IS 'manual | sg_mom';
COMMENT ON COLUMN public.planner_public_holiday.fetched_at IS 'Last refresh from data.gov.sg (sg_mom only)';
