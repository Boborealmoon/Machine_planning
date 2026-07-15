-- Add JCAB / CAAC ARC document columns for MRO history.
-- Migrates earlier japan_doc_no / china_doc_no names if present.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'mro_arc_history'
          AND column_name = 'japan_doc_no'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'mro_arc_history'
          AND column_name = 'jcab_doc_no'
    ) THEN
        ALTER TABLE public.mro_arc_history RENAME COLUMN japan_doc_no TO jcab_doc_no;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'mro_arc_history'
          AND column_name = 'china_doc_no'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'mro_arc_history'
          AND column_name = 'caac_doc_no'
    ) THEN
        ALTER TABLE public.mro_arc_history RENAME COLUMN china_doc_no TO caac_doc_no;
    END IF;
END $$;

ALTER TABLE public.mro_arc_history
    ADD COLUMN IF NOT EXISTS jcab_doc_no TEXT,
    ADD COLUMN IF NOT EXISTS caac_doc_no TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'mro_arc_history_jcab_doc_no_key'
    ) THEN
        ALTER TABLE public.mro_arc_history
            ADD CONSTRAINT mro_arc_history_jcab_doc_no_key UNIQUE (jcab_doc_no);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'mro_arc_history_caac_doc_no_key'
    ) THEN
        ALTER TABLE public.mro_arc_history
            ADD CONSTRAINT mro_arc_history_caac_doc_no_key UNIQUE (caac_doc_no);
    END IF;
END $$;

-- Prefer JCAB/CAAC serial keys; keep old JAPAN/CHINA rows if already allocated.
INSERT INTO public.mro_arc_serial_seq (variant, next_value)
VALUES
    ('JCAB', 1),
    ('CAAC', 1)
ON CONFLICT (variant) DO NOTHING;

UPDATE public.mro_arc_serial_seq AS dst
SET next_value = GREATEST(dst.next_value, src.next_value)
FROM public.mro_arc_serial_seq AS src
WHERE dst.variant = 'JCAB'
  AND src.variant = 'JAPAN';

UPDATE public.mro_arc_serial_seq AS dst
SET next_value = GREATEST(dst.next_value, src.next_value)
FROM public.mro_arc_serial_seq AS src
WHERE dst.variant = 'CAAC'
  AND src.variant = 'CHINA';
