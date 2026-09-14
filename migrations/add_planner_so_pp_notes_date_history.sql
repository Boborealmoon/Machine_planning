-- Material Tracking: audit trail for need date and in-date edits (per PP voucher).

CREATE TABLE IF NOT EXISTS public.planner_so_pp_notes_date_history (
    change_id          BIGSERIAL    PRIMARY KEY,
    pp_voucher_no      TEXT         NOT NULL,
    field_name         TEXT         NOT NULL,
    old_value          TEXT         NOT NULL DEFAULT '',
    new_value          TEXT         NOT NULL DEFAULT '',
    changed_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT planner_so_pp_notes_date_history_field_chk
        CHECK (field_name IN ('material_need_date', 'material_in_date'))
);

CREATE INDEX IF NOT EXISTS idx_so_pp_date_history_pp_field_at
    ON public.planner_so_pp_notes_date_history (
        LOWER(TRIM(pp_voucher_no)),
        field_name,
        changed_at DESC
    );

NOTIFY pgrst, 'reload schema';
