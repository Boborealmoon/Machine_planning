"""One-off lookup for PR260234EG and existing PO P26/1630."""
from planning.staged_erp import live_query

cols = live_query(
    """
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'pr_req_new_hdr','pr_req_new_det','pr_req_hst_hdr','pr_req_hst_det',
        'po_order_ost_hdr','po_order_ost_det','po_order_new_hdr','po_order_new_det'
      )
      AND (
        column_name ILIKE '%%po%%'
        OR column_name ILIKE '%%requisition%%'
        OR column_name ILIKE '%%source%%'
        OR column_name ILIKE '%%status%%'
        OR column_name ILIKE '%%state%%'
        OR column_name ILIKE '%%voucher%%'
        OR column_name ILIKE '%%reference%%'
      )
    ORDER BY table_name, ordinal_position
    """,
    timeout_ms=30000,
)
print("--- P26/1630 shipment lines ---")
slines = live_query(
    """
    SELECT h.shipment_voucher_no, d.line_item_no::text, d.inventory_code, d.service_code,
           d.qty, d.qty_received, h.shipment_stage, h.grn_no
    FROM lg_in_shm_ost_hdr h
    JOIN lg_in_shm_ost_det d ON d.shipment_voucher_no = h.shipment_voucher_no
    WHERE BTRIM(h.source_voucher_no) = 'P26/1630'
    ORDER BY h.shipment_voucher_no, d.line_item_no
    """,
    timeout_ms=20000,
)
for row in slines:
    print(row)

print("--- non-PR line sources ---")
odd = live_query(
    """
    SELECT LEFT(BTRIM(d.source_voucher_no), 12) AS prefix, COUNT(*) AS n
    FROM po_order_ost_det d
    WHERE NULLIF(BTRIM(d.source_voucher_no), '') IS NOT NULL
      AND BTRIM(d.source_voucher_no) !~ '^PR'
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 20
    """,
    timeout_ms=20000,
)
for row in odd:
    print("odd", row)

print("--- P26/1630 shipments ---")
ships = live_query(
    """
    SELECT shipment_voucher_no, source_voucher_no, grn_no, shipment_stage, status
    FROM lg_in_shm_ost_hdr
    WHERE BTRIM(source_voucher_no) = 'P26/1630'
    UNION ALL
    SELECT shipment_voucher_no, source_voucher_no, grn_no, shipment_stage, status
    FROM lg_in_shm_hst_hdr
    WHERE BTRIM(source_voucher_no) = 'P26/1630'
    """,
    timeout_ms=20000,
)
print(ships or "none")

print("--- normal PO header vs line source ---")
sample = live_query(
    """
    SELECT h.purchase_order_no, h.purchase_requisition_no AS hdr_pr, h.status,
           d.line_item_no::text, d.source_voucher_no, d.source_voucher_line_item_no::text
    FROM po_order_ost_hdr h
    JOIN po_order_ost_det d ON d.purchase_order_no = h.purchase_order_no
    WHERE NULLIF(BTRIM(h.purchase_requisition_no), '') IS NOT NULL
    ORDER BY h.order_date DESC NULLS LAST
    LIMIT 8
    """,
    timeout_ms=20000,
)
for row in sample:
    print("hdr", row)

print("--- existing-style PO lines (header PR blank, line source set) ---")
blank = live_query(
    """
    SELECT h.purchase_order_no, h.status, COUNT(*) AS lines,
           COUNT(NULLIF(BTRIM(d.source_voucher_no), '')) AS sourced
    FROM po_order_ost_hdr h
    JOIN po_order_ost_det d ON d.purchase_order_no = h.purchase_order_no
    WHERE NULLIF(BTRIM(h.purchase_requisition_no), '') IS NULL
      AND h.status IN ('O', 'U', 'C')
    GROUP BY h.purchase_order_no, h.status
    HAVING COUNT(NULLIF(BTRIM(d.source_voucher_no), '')) > 0
    ORDER BY h.purchase_order_no DESC
    LIMIT 12
    """,
    timeout_ms=20000,
)
for row in blank:
    print("blank-hdr", row)

print("--- shipment stages ---")
stages = live_query(
    """
    SELECT COALESCE(shipment_stage, '') AS shipment_stage,
           CASE WHEN NULLIF(BTRIM(grn_no), '') IS NULL THEN 'no-grn' ELSE 'grn' END AS grn,
           COUNT(*) AS n
    FROM lg_in_shm_ost_hdr
    WHERE COALESCE(BTRIM(status), '') <> 'X'
    GROUP BY 1, 2
    ORDER BY 1, 2
    """,
    timeout_ms=20000,
)
for row in stages:
    print("stage", row)

print("--- project MM003875 ---")
proj = live_query(
    """
    SELECT 'new' AS src, purchase_requisition_no, project_no, sbu_code, segment_1_code,
           purchase_requisition_date::text
    FROM pr_req_new_hdr
    WHERE project_no ILIKE '%%MM003875%%'
       OR source_project_no ILIKE '%%MM003875%%'
       OR source_voucher_no ILIKE '%%MM003875%%'
    UNION ALL
    SELECT 'hst' AS src, purchase_requisition_no, project_no, sbu_code, segment_1_code,
           purchase_requisition_date::text
    FROM pr_req_hst_hdr
    WHERE project_no ILIKE '%%MM003875%%'
       OR source_project_no ILIKE '%%MM003875%%'
       OR source_voucher_no ILIKE '%%MM003875%%'
    """,
    timeout_ms=30000,
)
for row in proj:
    print(row)

print("--- desc HYS220 ---")
desc = live_query(
    """
    SELECT 'new' AS src, purchase_requisition_no, line_item_no::text, inventory_code,
           service_code, LEFT(COALESCE(line_item_description, item_description, ''), 80) AS descr
    FROM pr_req_new_det
    WHERE line_item_description ILIKE '%%HYS220%%'
       OR item_description ILIKE '%%HYS220%%'
       OR inventory_code ILIKE '%%SHR_00005%%'
    UNION ALL
    SELECT 'hst' AS src, purchase_requisition_no, line_item_no::text, inventory_code,
           service_code, LEFT(COALESCE(line_item_description, item_description, ''), 80)
    FROM pr_req_hst_det
    WHERE line_item_description ILIKE '%%HYS220%%'
       OR item_description ILIKE '%%HYS220%%'
       OR inventory_code ILIKE '%%SHR_00005%%'
    LIMIT 20
    """,
    timeout_ms=30000,
)
for row in desc:
    print(row)

print("--- PO lines source PRs ---")
srcs = live_query(
    """
    SELECT h.purchase_requisition_no, h.purchase_requisition_date::text, h.sbu_code,
           h.segment_1_code, h.project_no, h.default_supplier_code,
           d.line_item_no::text, d.inventory_code, d.service_code,
           LEFT(COALESCE(d.line_item_description, ''), 90) AS descr
    FROM pr_req_hst_hdr h
    JOIN pr_req_hst_det d
      ON d.purchase_requisition_no = h.purchase_requisition_no
     AND d.revision_no = h.revision_no
    WHERE h.purchase_requisition_no IN ('PR03921REQ', 'PR03922REQ', 'PR03923REQ')
    ORDER BY h.purchase_requisition_no, d.line_item_no
    """,
    timeout_ms=20000,
)
for row in srcs:
    print(row)

print("--- recent PR numbers ---")
recent = live_query(
    """
    SELECT 'new' AS src, purchase_requisition_no, purchase_requisition_date::text, status
    FROM pr_req_new_hdr
    ORDER BY purchase_requisition_date DESC NULLS LAST
    LIMIT 8
    """,
    timeout_ms=20000,
)
for row in recent:
    print(row)
recent_h = live_query(
    """
    SELECT 'hst' AS src, purchase_requisition_no, revision_no, purchase_requisition_date::text, status
    FROM pr_req_hst_hdr
    ORDER BY purchase_requisition_date DESC NULLS LAST
    LIMIT 8
    """,
    timeout_ms=20000,
)
for row in recent_h:
    print(row)

print("--- search 260234 / SHR / MM003875 ---")
hits = live_query(
    """
    SELECT 'pen' AS src, purchase_requisition_no, status
    FROM pr_req_pen_hdr
    WHERE purchase_requisition_no ILIKE '%%260234%%'
       OR source_voucher_no ILIKE '%%1630%%'
    UNION ALL
    SELECT 'new_pen' AS src, purchase_requisition_no, status
    FROM pr_req_new_pen_hdr
    WHERE purchase_requisition_no ILIKE '%%260234%%'
       OR po_manual_no ILIKE '%%1630%%'
       OR source_voucher_no ILIKE '%%1630%%'
    """,
    timeout_ms=20000,
)
for row in hits:
    print("hit", row)

print("--- new_pen columns of interest ---")
pen_cols = live_query(
    """
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'pr_req_new_pen_hdr'
      AND (
        column_name ILIKE '%%po%%'
        OR column_name ILIKE '%%status%%'
        OR column_name ILIKE '%%manual%%'
        OR column_name ILIKE '%%purpose%%'
      )
    ORDER BY ordinal_position
    """,
    timeout_ms=20000,
)
for row in pen_cols:
    print(row["column_name"])

print("--- columns ---")
for row in cols:
    print(row["table_name"] + "." + row["column_name"])

print("--- PR draft ---")
draft = live_query(
    """
    SELECT purchase_requisition_no, status, purpose,
           po_manual_no, po_numbering_scheme_key, source_voucher_no,
           reference_no, source_pr_no, request_voucher_no, default_supplier_code,
           posted_by, posted_datetime, revision_no
    FROM pr_req_new_hdr
    WHERE BTRIM(purchase_requisition_no) = 'PR260234EG'
    """,
    timeout_ms=20000,
)
print(draft)

print("--- PR history ---")
hst = live_query(
    """
    SELECT purchase_requisition_no, revision_no, status, purpose,
           po_numbering_scheme_key, source_voucher_no,
           reference_no, source_pr_no, request_voucher_no, default_supplier_code,
           posted_by, posted_datetime
    FROM pr_req_hst_hdr
    WHERE BTRIM(purchase_requisition_no) = 'PR260234EG'
    ORDER BY revision_no
    """,
    timeout_ms=20000,
)
print(hst)

print("--- PR tables ---")
tables = live_query(
    """
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name ILIKE 'pr_req%%'
    ORDER BY 1
    """,
    timeout_ms=20000,
)
for row in tables:
    print(row["table_name"])

print("--- item SHR_00005 on PR det ---")
item = live_query(
    """
    SELECT 'new' AS src, purchase_requisition_no, line_item_no::text AS line_item_no,
           source_voucher_no, inventory_code, qty
    FROM pr_req_new_det
    WHERE inventory_code = 'SHR_00005'
    UNION ALL
    SELECT 'hst' AS src, purchase_requisition_no, line_item_no::text,
           source_voucher_no, inventory_code, qty
    FROM pr_req_hst_det
    WHERE inventory_code = 'SHR_00005'
    """,
    timeout_ms=30000,
)
for row in item:
    print(row)

print("--- po_manual_no sample ---")
manual = live_query(
    """
    SELECT purchase_requisition_no, status, po_manual_no, po_numbering_scheme_key, purpose
    FROM pr_req_new_hdr
    WHERE NULLIF(BTRIM(po_manual_no), '') IS NOT NULL
    ORDER BY purchase_requisition_date DESC NULLS LAST
    LIMIT 15
    """,
    timeout_ms=20000,
)
for row in manual:
    print(row)

print("--- PO lines P26/1630 ---")
lines = live_query(
    """
    SELECT 'ost' AS src, line_item_no, inventory_code, service_code, qty,
           source_voucher_no, source_voucher_line_item_no
    FROM po_order_ost_det
    WHERE purchase_order_no = 'P26/1630'
    ORDER BY line_item_no
    """,
    timeout_ms=20000,
)
for row in lines:
    print(row)

print("--- PO header ---")
po = live_query(
    """
    SELECT 'ost' AS src, purchase_order_no, purchase_requisition_no, status, state,
           approval_state, source_voucher_no, reference_no, supplier_code, order_date
    FROM po_order_ost_hdr
    WHERE BTRIM(purchase_order_no) = 'P26/1630'
       OR BTRIM(purchase_requisition_no) = 'PR260234EG'
    UNION ALL
    SELECT 'new' AS src, purchase_order_no, purchase_requisition_no, status, state::text,
           NULL::text, source_voucher_no, reference_no, supplier_code, order_date
    FROM po_order_new_hdr
    WHERE BTRIM(purchase_order_no) = 'P26/1630'
       OR BTRIM(purchase_requisition_no) = 'PR260234EG'
    """,
    timeout_ms=20000,
)
print(po)
