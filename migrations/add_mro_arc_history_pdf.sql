-- Store issued ARC PDF bytes on history for later download.
ALTER TABLE public.mro_arc_history
    ADD COLUMN IF NOT EXISTS pdf_bytes BYTEA,
    ADD COLUMN IF NOT EXISTS pdf_filename TEXT,
    ADD COLUMN IF NOT EXISTS pdf_content_type TEXT;
