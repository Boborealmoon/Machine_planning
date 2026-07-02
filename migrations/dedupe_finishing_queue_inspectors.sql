-- Collapse duplicate active QC inspector names and prevent future duplicates.
-- Safe to re-run.

WITH ranked AS (
    SELECT inspector_id,
           ROW_NUMBER() OVER (
               PARTITION BY LOWER(TRIM(name))
               ORDER BY inspector_id
           ) AS rn,
           FIRST_VALUE(inspector_id) OVER (
               PARTITION BY LOWER(TRIM(name))
               ORDER BY inspector_id
           ) AS keep_id
    FROM public.planner_finishing_queue_inspector
    WHERE active = TRUE
),
dupes AS (
    SELECT inspector_id, keep_id
    FROM ranked
    WHERE rn > 1
)
UPDATE public.planner_finishing_queue_overlay o
SET inspector_id = d.keep_id
FROM dupes d
WHERE o.inspector_id = d.inspector_id;

WITH ranked AS (
    SELECT inspector_id,
           ROW_NUMBER() OVER (
               PARTITION BY LOWER(TRIM(name))
               ORDER BY inspector_id
           ) AS rn
    FROM public.planner_finishing_queue_inspector
    WHERE active = TRUE
)
UPDATE public.planner_finishing_queue_inspector i
SET active = FALSE
FROM ranked r
WHERE i.inspector_id = r.inspector_id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fq_inspector_name_active_unique
    ON public.planner_finishing_queue_inspector (LOWER(TRIM(name)))
    WHERE active = TRUE;

NOTIFY pgrst, 'reload schema';
