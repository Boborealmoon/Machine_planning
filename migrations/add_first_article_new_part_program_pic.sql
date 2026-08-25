-- First Article Tracker: programme PIC on NEW-part rows.

ALTER TABLE public.planner_first_article_new_part
    ADD COLUMN IF NOT EXISTS program_pic_ids BIGINT[] NOT NULL DEFAULT '{}';

NOTIFY pgrst, 'reload schema';
