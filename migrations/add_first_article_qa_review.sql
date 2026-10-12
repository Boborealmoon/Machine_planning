-- QA Review fields. Tracker columns stay for the existing tracker queue.
-- New-part columns are what QA Review reads: the same NEW jobs that need a programme.

ALTER TABLE public.planner_first_article
    ADD COLUMN IF NOT EXISTS review_timestamp TIMESTAMPTZ;

ALTER TABLE public.planner_first_article
    ADD COLUMN IF NOT EXISTS queue_order INTEGER;

ALTER TABLE public.planner_first_article
    ADD COLUMN IF NOT EXISTS program_due_date TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_fa_queue_order
    ON public.planner_first_article (queue_order, first_article_id);

WITH ranked AS (
    SELECT first_article_id,
           ROW_NUMBER() OVER (ORDER BY updated_at DESC, first_article_id DESC)
             + COALESCE((SELECT MAX(queue_order) FROM public.planner_first_article), 0) AS n
    FROM public.planner_first_article
    WHERE queue_order IS NULL
)
UPDATE public.planner_first_article AS fa
SET queue_order = ranked.n
FROM ranked
WHERE fa.first_article_id = ranked.first_article_id;

ALTER TABLE public.planner_first_article_new_part
    ADD COLUMN IF NOT EXISTS review_timestamp TIMESTAMPTZ;

ALTER TABLE public.planner_first_article_new_part
    ADD COLUMN IF NOT EXISTS queue_order INTEGER;

ALTER TABLE public.planner_first_article_new_part
    ADD COLUMN IF NOT EXISTS program_due_date TEXT NOT NULL DEFAULT '';

ALTER TABLE public.planner_first_article_new_part
    ADD COLUMN IF NOT EXISTS gauges_tick BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.planner_first_article_new_part
    ADD COLUMN IF NOT EXISTS gauges_text TEXT NOT NULL DEFAULT '';

ALTER TABLE public.planner_first_article_new_part
    ADD COLUMN IF NOT EXISTS gauges_edited BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_fa_new_part_queue_order
    ON public.planner_first_article_new_part (queue_order, process_sheet_no);

NOTIFY pgrst, 'reload schema';
