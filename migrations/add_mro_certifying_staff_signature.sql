-- Store e-signature image bytes on certifying staff for ARC auto-sign.
ALTER TABLE public.mro_certifying_staff
    ADD COLUMN IF NOT EXISTS signature_image BYTEA,
    ADD COLUMN IF NOT EXISTS signature_mime TEXT,
    ADD COLUMN IF NOT EXISTS signature_updated_at TIMESTAMPTZ;
