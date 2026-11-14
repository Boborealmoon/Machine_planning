from planning.staged_erp import live_query

rows = live_query(
    """
    SELECT h.shipment_voucher_no,
           d.line_item_no::text AS ship_line,
           d.source_voucher_line_item_no::text AS source_line,
           d.po_line_item_no::text AS po_line,
           LEFT(COALESCE(d.line_item_description, ''), 40) AS descr
    FROM lg_in_shm_ost_hdr h
    JOIN lg_in_shm_ost_det d ON d.shipment_voucher_no = h.shipment_voucher_no
    WHERE BTRIM(h.source_voucher_no) = 'P26/1630'
    ORDER BY h.shipment_voucher_no
    """,
    timeout_ms=20000,
)
for row in rows:
    print(row)
