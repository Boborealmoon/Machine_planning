from dotenv import load_dotenv

load_dotenv()
from planning.helpers import planner_db, rows

with planner_db() as con:
    files = rows(con.execute(
        """
        SELECT sheet_id, file_name, rfq_folder, status, date_in
          FROM public.planner_ops_sheet
         ORDER BY rfq_folder
        """
    ))
    hit = rows(con.execute(
        """
        SELECT part_number, description
          FROM public.planner_ops_sheet_line
         WHERE part_number ILIKE %s OR description ILIKE %s
         LIMIT 8
        """,
        ("%10405235%", "%GUIDE BUSH%"),
    ))
print("FILES", len(files))
for item in files:
    print(
        item["sheet_id"],
        "|",
        item["status"],
        "|",
        item["date_in"],
        "|",
        item["rfq_folder"],
        "|",
        item["file_name"],
    )
print("HITS", len(hit))
for item in hit:
    print(item["part_number"], "|", item["description"])
