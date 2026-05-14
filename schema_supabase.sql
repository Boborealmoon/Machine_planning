-- ============================================================
-- Supabase schema — PP Voucher pipeline
-- Source tables for raw data loads + view for query output
-- ============================================================

-- ── Source tables ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pp_voucher (
    pp_voucher_no           TEXT        NOT NULL,
    inventory_code          TEXT,
    bom_code                TEXT,
    pp_qty                  NUMERIC,
    source_voucher_no       TEXT,
    source_rsd              DATE,
    source_line_item_no     TEXT,
    status                  TEXT,
    _loaded_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pp_voucher_no)
);

CREATE TABLE IF NOT EXISTS public.mfg_process_sheet_info (
    -- Loaded from mfg_process_sheet_info_v1_view on COMAIN.
    -- Named without _view suffix because this is a staging table, not a view.
    pp_voucher_no           TEXT        NOT NULL,
    process_sheet_no        TEXT,
    inventory_code          TEXT,
    total_qty               NUMERIC,
    sales_order_date        DATE,
    _loaded_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pp_voucher_no, process_sheet_no)
);

CREATE TABLE IF NOT EXISTS public.workorder_status (
    source_voucher_no           TEXT        NOT NULL,
    source_voucher_line_item_no TEXT        NOT NULL,
    item_qty                    NUMERIC,
    status                      TEXT,
    _loaded_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_voucher_no, source_voucher_line_item_no)
);

CREATE TABLE IF NOT EXISTS public.part_desc (
    inventory_code  TEXT        NOT NULL,
    main_desc       TEXT,
    _loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (inventory_code)
);

CREATE TABLE IF NOT EXISTS public.pp_partial (
    pp_voucher_no   TEXT        NOT NULL,
    pp_partial_no   INTEGER     NOT NULL,
    partial_qty     NUMERIC,
    _loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pp_voucher_no, pp_partial_no)
);


-- ── Indexes on foreign-key columns ────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_mfg_process_pp_voucher
    ON public.mfg_process_sheet_info (pp_voucher_no);

CREATE INDEX IF NOT EXISTS idx_workorder_source_voucher
    ON public.workorder_status (source_voucher_no, source_voucher_line_item_no);

CREATE INDEX IF NOT EXISTS idx_pp_partial_pp_voucher
    ON public.pp_partial (pp_voucher_no);


-- ── Cache table (written by Flask auto-sync, read by /api/pp-vouchers) ───

CREATE TABLE IF NOT EXISTS public.pp_vouchers_cache (
    ps_id           TEXT,
    pp_partial_no   INTEGER,
    part_no         TEXT,
    description     TEXT,
    total_qty       NUMERIC,
    partial_qty     NUMERIC,
    due_date        DATE,
    order_date      DATE,
    bom_code        TEXT,
    status          TEXT,
    _synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pp_vouchers_cache_ps_id
    ON public.pp_vouchers_cache (ps_id);


-- ── Combined view (mirrors /api/pp-vouchers query) ────────────────────────

CREATE OR REPLACE VIEW public.vw_pp_vouchers AS
WITH
joined AS (
    SELECT
        b.pp_voucher_no,
        b.inventory_code,
        b.bom_code,
        b.pp_qty,
        b.source_voucher_no,
        b.source_rsd,
        b.source_line_item_no,
        b.status,
        ps.process_sheet_no                                 AS ps_id_raw,
        ps.inventory_code                                   AS ps_inventory_code,
        ps.total_qty                                        AS ps_total_qty,
        ps.sales_order_date                                 AS ps_order_date,
        COALESCE(ps.process_sheet_no, b.pp_voucher_no)      AS ps_id,
        CASE WHEN ps.process_sheet_no IS NOT NULL
             THEN ps.inventory_code
             ELSE b.inventory_code
        END                                                 AS final_inventory_code
    FROM public.pp_voucher b
    LEFT JOIN public.mfg_process_sheet_info ps
           ON b.pp_voucher_no = ps.pp_voucher_no
),
filtered AS (
    SELECT *
    FROM joined
    WHERE ps_id LIKE '%APS%'
       OR ps_id LIKE '%NPS%'
       OR ps_id LIKE '%[SR]%'
),
with_workorder AS (
    SELECT
        f.*,
        wa.ws_item_qty,
        wa.ws_status
    FROM filtered f
    LEFT JOIN (
        SELECT
            source_voucher_no,
            source_voucher_line_item_no,
            MIN(item_qty) AS ws_item_qty,
            MIN(status)   AS ws_status
        FROM public.workorder_status
        GROUP BY source_voucher_no, source_voucher_line_item_no
    ) wa
           ON f.source_voucher_no  = wa.source_voucher_no
          AND f.source_line_item_no = wa.source_voucher_line_item_no
),
with_partial AS (
    SELECT
        ww.*,
        COALESCE(p.pp_partial_no, 1)    AS pp_partial_no,
        p.partial_qty                   AS partial_qty_raw
    FROM with_workorder ww
    LEFT JOIN public.pp_partial p ON ww.pp_voucher_no = p.pp_voucher_no
),
with_desc AS (
    SELECT
        wp.*,
        pd.main_desc AS description
    FROM with_partial wp
    LEFT JOIN public.part_desc pd ON wp.final_inventory_code = pd.inventory_code
),
computed AS (
    SELECT DISTINCT
        ps_id,
        pp_partial_no,
        final_inventory_code    AS part_no,
        description,
        CASE
            WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
            WHEN ws_item_qty  IS NOT NULL AND ws_item_qty  <> 0 THEN ws_item_qty
            ELSE pp_qty
        END                     AS total_qty,
        CASE
            WHEN partial_qty_raw IS NULL
              OR partial_qty_raw = 0
              OR partial_qty_raw >= CASE
                    WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
                    WHEN ws_item_qty  IS NOT NULL AND ws_item_qty  <> 0 THEN ws_item_qty
                    ELSE pp_qty END
              OR (length(ps_id) - length(replace(ps_id, '-', ''))) > 1
            THEN CASE
                    WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
                    WHEN ws_item_qty  IS NOT NULL AND ws_item_qty  <> 0 THEN ws_item_qty
                    ELSE pp_qty END
            ELSE partial_qty_raw
        END                     AS partial_qty,
        source_rsd              AS due_date,
        ps_order_date           AS order_date,
        bom_code,
        CASE
            WHEN ws_status IS NOT NULL THEN ws_status
            WHEN status = 'H'          THEN 'History'
            WHEN status = 'O'          THEN 'Outstanding'
            ELSE status
        END                     AS status
    FROM with_desc
)
SELECT * FROM computed
ORDER BY ps_id, pp_partial_no;
