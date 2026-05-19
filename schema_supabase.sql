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
    -- bom_op_stage columns (one row per machining stage)
    stage_no                INTEGER     NOT NULL,
    stage_desc              TEXT,
    op_no                   INTEGER,
    _loaded_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pp_voucher_no, stage_no)
);

-- Run these if the table already exists in Supabase:
-- TRUNCATE TABLE public.pp_voucher;
-- ALTER TABLE public.pp_voucher ADD COLUMN IF NOT EXISTS source_voucher_no   TEXT;
-- ALTER TABLE public.pp_voucher ADD COLUMN IF NOT EXISTS source_line_item_no TEXT;
-- ALTER TABLE public.pp_voucher ADD COLUMN IF NOT EXISTS stage_no   INTEGER;
-- ALTER TABLE public.pp_voucher ADD COLUMN IF NOT EXISTS stage_desc TEXT;
-- ALTER TABLE public.pp_voucher ADD COLUMN IF NOT EXISTS op_no      INTEGER;
-- ALTER TABLE public.pp_voucher ALTER COLUMN stage_no SET NOT NULL;
-- ALTER TABLE public.pp_voucher DROP CONSTRAINT IF EXISTS pp_voucher_pkey;
-- ALTER TABLE public.pp_voucher ADD PRIMARY KEY (pp_voucher_no, stage_no);

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

CREATE TABLE IF NOT EXISTS public.sum_qty_shipped_by_sales_order (
    sales_order_no  TEXT        NOT NULL,
    line_item_no    TEXT        NOT NULL,
    qty_shipped     NUMERIC,
    _loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sales_order_no, line_item_no)
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

CREATE TABLE IF NOT EXISTS public.mfg_wo_status (
    -- Aggregated work order execution status per PP voucher.
    -- Loaded from COMAIN mfg_wo_vch, grouped by source_mps_no.
    -- Priority: I (In Process) > R (Ready to Start) > P (Pending SI) > C (Completed)
    source_mps_no           TEXT        NOT NULL,
    pp_partial_no           INTEGER     NOT NULL DEFAULT 1,
    execution_status        TEXT,
    wo_qty_required         NUMERIC,
    total_acc_qty_produced  NUMERIC,
    total_rej_qty_produced  NUMERIC,
    stage_no                INTEGER,
    plan_start_date         DATE,
    plan_end_date           DATE,
    po_due_date             DATE,       -- origin_rsd from mfg_wo_vch
    so_no                   TEXT,       -- origin_voucher_no from mfg_wo_vch
    _loaded_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_mps_no, pp_partial_no, stage_no)
);

-- Run these ALTER TABLE statements if the table already exists in Supabase:
-- ALTER TABLE public.mfg_wo_status ADD COLUMN IF NOT EXISTS wo_qty_required        NUMERIC;
-- ALTER TABLE public.mfg_wo_status ADD COLUMN IF NOT EXISTS total_acc_qty_produced NUMERIC;
-- ALTER TABLE public.mfg_wo_status ADD COLUMN IF NOT EXISTS total_rej_qty_produced NUMERIC;
-- ALTER TABLE public.mfg_wo_status ADD COLUMN IF NOT EXISTS stage_no               TEXT;
-- ALTER TABLE public.mfg_wo_status ADD COLUMN IF NOT EXISTS pp_partial_no          INTEGER NOT NULL DEFAULT 1;
-- ALTER TABLE public.mfg_wo_status ADD COLUMN IF NOT EXISTS plan_start_date        DATE;
-- ALTER TABLE public.mfg_wo_status ADD COLUMN IF NOT EXISTS plan_end_date          DATE;
-- ALTER TABLE public.mfg_wo_status ADD COLUMN IF NOT EXISTS po_due_date            DATE;
-- ALTER TABLE public.mfg_wo_status ADD COLUMN IF NOT EXISTS so_no                  TEXT;
-- ALTER TABLE public.mfg_wo_status ALTER COLUMN stage_no TYPE INTEGER USING NULLIF(stage_no::TEXT, '')::INTEGER;
-- ALTER TABLE public.mfg_wo_status DROP CONSTRAINT IF EXISTS mfg_wo_status_pkey;
-- ALTER TABLE public.mfg_wo_status ADD PRIMARY KEY (source_mps_no, pp_partial_no, stage_no);

CREATE INDEX IF NOT EXISTS idx_mfg_wo_status_source_mps
    ON public.mfg_wo_status (source_mps_no);


-- ── material_per_bom ─────────────────────────────────────────────────────
-- Loaded from the material_per_bom Power Query (inventory_bom_listing view,
-- filtered to leaf materials only — rows where material_inventory_code does
-- not appear as a source_inventory_code).

CREATE TABLE IF NOT EXISTS public.material_per_bom (
    source_inventory_code   TEXT        NOT NULL,
    bom_code                TEXT        NOT NULL,
    material_inventory_code TEXT        NOT NULL,
    description             TEXT,
    _loaded_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_inventory_code, bom_code, material_inventory_code)
);

CREATE INDEX IF NOT EXISTS idx_material_per_bom_source
    ON public.material_per_bom (source_inventory_code);

CREATE INDEX IF NOT EXISTS idx_material_per_bom_material
    ON public.material_per_bom (material_inventory_code);


-- ── bom_op_stage ──────────────────────────────────────────────────────────
-- Loaded from the bom_op_stage Power Query (mt_inventory_bom_stage,
-- filtered to Turning / Milling / Turnmill stages only).
-- op_no   : integer extracted from stage_desc (number after the first space)
-- op_index: sequential position within each inventory_code + bom_code group
-- machine_no : last known machine from the Workorder Tracker (nullable)
-- setup_time : minutes; defaults to 180 when source has no value
-- cycle_time : minutes/pc; defaults to 20 when source value is 0

CREATE TABLE IF NOT EXISTS public.bom_op_stage (
    inventory_code  TEXT        NOT NULL,
    bom_code        TEXT        NOT NULL,
    stage_no        INTEGER     NOT NULL,
    stage_desc      TEXT        NOT NULL,
    op_no           INTEGER,
    op_index        INTEGER     NOT NULL,
    machine_no      TEXT,
    setup_time      NUMERIC     NOT NULL DEFAULT 180,
    cycle_time      NUMERIC     NOT NULL DEFAULT 20,
    _loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (inventory_code, bom_code, stage_no)
);

CREATE INDEX IF NOT EXISTS idx_bom_op_stage_inv_bom
    ON public.bom_op_stage (inventory_code, bom_code);


-- ── Indexes on foreign-key columns ────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_mfg_process_pp_voucher
    ON public.mfg_process_sheet_info (pp_voucher_no);

CREATE INDEX IF NOT EXISTS idx_workorder_source_voucher
    ON public.workorder_status (source_voucher_no, source_voucher_line_item_no);

CREATE INDEX IF NOT EXISTS idx_qty_shipped_sales_order
    ON public.sum_qty_shipped_by_sales_order (sales_order_no, line_item_no);

CREATE INDEX IF NOT EXISTS idx_pp_partial_pp_voucher
    ON public.pp_partial (pp_voucher_no);

CREATE TABLE IF NOT EXISTS public.so_detail (
    sales_order_no  TEXT        NOT NULL,
    line_item_no    TEXT        NOT NULL,
    inventory_code  TEXT        NOT NULL,
    item_code       TEXT,
    qty             NUMERIC,
    item_qty        NUMERIC,
    _loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sales_order_no, line_item_no, inventory_code)
);

CREATE INDEX IF NOT EXISTS idx_so_detail_sales_order
    ON public.so_detail (sales_order_no, line_item_no);


-- ── Cache table (written by Flask auto-sync, read by /api/pp-vouchers) ───

CREATE TABLE IF NOT EXISTS public.pp_vouchers_cache (
    ps_id               TEXT,
    pp_partial_no       INTEGER,
    part_no             TEXT,
    description         TEXT,
    total_qty           NUMERIC,
    partial_qty         NUMERIC,
    due_date            DATE,
    order_date          DATE,
    bom_code            TEXT,
    source_voucher_no   TEXT,
    source_line_item_no TEXT,
    qty_shipped         NUMERIC,
    so_det_qty          NUMERIC,
    status              TEXT,
    execution_status    TEXT,
    wo_qty_required     NUMERIC,
    wo_qty_produced     NUMERIC,
    wo_qty_rejected     NUMERIC,
    stage_no            INTEGER,
    stage_desc          TEXT,
    op_no               INTEGER,
    _synced_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Run these if the table already exists in Supabase:
-- ALTER TABLE public.pp_vouchers_cache ADD COLUMN IF NOT EXISTS stage_no   INTEGER;
-- ALTER TABLE public.pp_vouchers_cache ADD COLUMN IF NOT EXISTS stage_desc TEXT;
-- ALTER TABLE public.pp_vouchers_cache ADD COLUMN IF NOT EXISTS op_no      INTEGER;
-- ALTER TABLE public.pp_vouchers_cache ADD COLUMN IF NOT EXISTS wo_qty_required NUMERIC;
-- ALTER TABLE public.pp_vouchers_cache ADD COLUMN IF NOT EXISTS wo_qty_produced NUMERIC;
-- ALTER TABLE public.pp_vouchers_cache ADD COLUMN IF NOT EXISTS wo_qty_rejected NUMERIC;
-- ALTER TABLE public.pp_vouchers_cache ADD COLUMN IF NOT EXISTS source_voucher_no TEXT;
-- ALTER TABLE public.pp_vouchers_cache ADD COLUMN IF NOT EXISTS source_line_item_no TEXT;
-- ALTER TABLE public.pp_vouchers_cache ADD COLUMN IF NOT EXISTS qty_shipped NUMERIC;

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
        regexp_replace(b.source_line_item_no::TEXT, '\\.0+$', '') AS source_line_item_no,
        b.status,
        b.stage_no,
        b.stage_desc,
        b.op_no,
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
with_shipped AS (
    SELECT
        ww.*,
        sq.qty_shipped
    FROM with_workorder ww
    LEFT JOIN public.sum_qty_shipped_by_sales_order sq
           ON ww.source_voucher_no = sq.sales_order_no
          AND regexp_replace(ww.source_line_item_no::TEXT, '\\.0+$', '') = regexp_replace(sq.line_item_no::TEXT, '\\.0+$', '')
),
so_detail_by_line AS (
    SELECT
        sales_order_no,
        regexp_replace(line_item_no::TEXT, '\\.0+$', '') AS line_item_no,
        MAX(qty) AS so_qty
    FROM public.so_detail
    WHERE sales_order_no IS NOT NULL
      AND line_item_no IS NOT NULL
    GROUP BY sales_order_no, regexp_replace(line_item_no::TEXT, '\\.0+$', '')
),
with_so_detail AS (
    SELECT
        ww.*,
        sd.so_qty
    FROM with_shipped ww
    LEFT JOIN so_detail_by_line sd
           ON sd.sales_order_no = ww.source_voucher_no
          AND sd.line_item_no = regexp_replace(ww.source_line_item_no::TEXT, '\\.0+$', '')
),
with_partial AS (
    SELECT
        ww.*,
        COALESCE(p.pp_partial_no, 1)    AS pp_partial_no,
        p.partial_qty                   AS partial_qty_raw
    FROM with_so_detail ww
    LEFT JOIN public.pp_partial p ON ww.pp_voucher_no = p.pp_voucher_no
),
with_desc AS (
    SELECT
        wp.*,
        pd.main_desc AS description
    FROM with_partial wp
    LEFT JOIN public.part_desc pd ON wp.final_inventory_code = pd.inventory_code
),
with_wo_status AS (
    SELECT
        wd.*,
        ws.execution_status,
        ws.wo_qty_required,
        ws.total_acc_qty_produced,
        ws.total_rej_qty_produced
    FROM with_desc wd
    LEFT JOIN public.mfg_wo_status ws
           ON ws.source_mps_no = wd.ps_id
          AND ws.pp_partial_no = wd.pp_partial_no
          AND ws.stage_no = wd.stage_no
),
computed AS (
    SELECT DISTINCT
        ps_id,
        pp_partial_no,
        final_inventory_code    AS part_no,
        description,
        CASE
            WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
            WHEN pp_qty       IS NOT NULL AND pp_qty       <> 0 THEN pp_qty
            ELSE ws_item_qty
        END                     AS total_qty,
        COALESCE(
            NULLIF(partial_qty_raw, 0),
            CASE
                WHEN ps_total_qty IS NOT NULL AND ps_total_qty <> 0 THEN ps_total_qty
                WHEN pp_qty       IS NOT NULL AND pp_qty       <> 0 THEN pp_qty
                ELSE ws_item_qty
            END
        )                       AS partial_qty,
        so_qty                  AS so_det_qty,
        source_rsd              AS due_date,
        ps_order_date           AS order_date,
        bom_code,
        source_voucher_no,
        source_line_item_no,
        qty_shipped,
        CASE
            WHEN status = 'H'          THEN 'History'
            WHEN ws_status IS NOT NULL THEN ws_status
            WHEN status = 'O'          THEN 'Outstanding'
            ELSE status
        END                     AS status,
        CASE execution_status
            WHEN 'P' THEN 'Pending SI'
            WHEN 'R' THEN 'Ready to Start'
            WHEN 'I' THEN 'In Process'
            WHEN 'C' THEN 'Completed'
            ELSE execution_status
        END                     AS execution_status,
        wo_qty_required,
        total_acc_qty_produced  AS wo_qty_produced,
        total_rej_qty_produced  AS wo_qty_rejected,
        stage_no,
        stage_desc,
        op_no
    FROM with_wo_status
)
SELECT * FROM computed
ORDER BY ps_id, pp_partial_no, stage_no;


CREATE TABLE planner_program_tools (
    id BIGSERIAL PRIMARY KEY,
    ps_no TEXT,                   -- Internal key for upserting (hidden from exports)
    program_file TEXT,
    tool_list_files TEXT,
    part_no_erp TEXT,
    programmer_name TEXT,
    cnc_machine_no TEXT,
    wo_machine TEXT,
    synced_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(ps_no, cnc_machine_no) -- Ensures clean upserts
);

CREATE INDEX idx_ptl_part ON planner_program_tools(part_no_erp);
CREATE INDEX idx_ptl_programmer ON planner_program_tools(programmer_name);