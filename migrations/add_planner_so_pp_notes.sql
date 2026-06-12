-- Planner-managed notes per PP voucher on the Sales Orders page.
CREATE TABLE IF NOT EXISTS public.planner_so_pp_notes (
    pp_voucher_no       TEXT         PRIMARY KEY,
    material_subcon     TEXT         NOT NULL DEFAULT '',
    mtl_part_order      TEXT         NOT NULL DEFAULT '',
    quality_doc         TEXT         NOT NULL DEFAULT '',
    ops_notes           TEXT         NOT NULL DEFAULT '',
    sales_notes         TEXT         NOT NULL DEFAULT '',
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
