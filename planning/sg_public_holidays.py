"""Singapore public holidays — fetch from data.gov.sg (MOM) and sync to planner_public_holiday."""
from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from typing import Any

from .helpers import rows
from .utils import compact_text

logger = logging.getLogger(__name__)

SG_MOM_COLLECTION_ID = 691
SG_MOM_SOURCE = "sg_mom"
DATA_GOV_SG_COLLECTION_URL = (
    f"https://api-production.data.gov.sg/v2/public/api/collections/{SG_MOM_COLLECTION_ID}/metadata"
)
DATA_GOV_SG_DATASTORE_URL = "https://data.gov.sg/api/action/datastore_search"
USER_AGENT = "Machine-planning/1.0 (+https://github.com/Machine_planning)"


def _http_get_json(url: str, *, timeout: float = 45.0, retries: int = 4) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(max(1, retries)):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read().decode("utf-8")
            return json.loads(payload)
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code == 429 and attempt + 1 < retries:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt + 1 < retries:
                time.sleep(1.0 * (attempt + 1))
                continue
            raise
    if last_error:
        raise last_error
    return {}


def sg_mom_dataset_ids() -> list[str]:
    """Return datastore resource IDs for each year dataset in the MOM collection."""
    payload = _http_get_json(DATA_GOV_SG_COLLECTION_URL)
    data = payload.get("data") or {}
    meta = data.get("collectionMetadata") or data.get("collection_metadata") or {}
    child = meta.get("childDatasets") or meta.get("child_datasets") or []
    return [compact_text(item) for item in child if compact_text(item)]


def fetch_dataset_holidays(dataset_id: str) -> list[dict[str, str]]:
    """Fetch all holiday rows from one yearly dataset."""
    dataset_id = compact_text(dataset_id)
    if not dataset_id:
        return []

    out: list[dict[str, str]] = []
    offset = 0
    limit = 100
    while True:
        query = urllib.parse.urlencode(
            {"resource_id": dataset_id, "limit": limit, "offset": offset}
        )
        payload = _http_get_json(f"{DATA_GOV_SG_DATASTORE_URL}?{query}")
        result = payload.get("result") or {}
        records = result.get("records") or []
        for row in records:
            holiday_date = compact_text(row.get("date") or "")
            if not holiday_date:
                continue
            try:
                date.fromisoformat(holiday_date)
            except ValueError:
                continue
            out.append(
                {
                    "holiday_date": holiday_date,
                    "note": compact_text(row.get("holiday") or "Public holiday"),
                    "day": compact_text(row.get("day") or ""),
                }
            )
        total = int(result.get("total") or 0)
        offset += limit
        if offset >= total or not records:
            break
    return out


def fetch_sg_public_holidays(
    *,
    from_date: date | None = None,
    to_date: date | None = None,
) -> list[dict[str, str]]:
    """
    Fetch SG public holidays from data.gov.sg for all published year datasets.
    Optional from_date / to_date filter (inclusive).
    """
    merged: dict[str, dict[str, str]] = {}
    dataset_ids = sg_mom_dataset_ids()
    for idx, dataset_id in enumerate(dataset_ids):
        if idx > 0:
            time.sleep(0.35)
        try:
            for row in fetch_dataset_holidays(dataset_id):
                merged[row["holiday_date"]] = row
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError) as exc:
            logger.warning("SG holiday dataset %s failed: %s", dataset_id, exc)

    holidays = list(merged.values())
    holidays.sort(key=lambda item: item["holiday_date"])

    if from_date:
        from_text = from_date.isoformat()
        holidays = [row for row in holidays if row["holiday_date"] >= from_text]
    if to_date:
        to_text = to_date.isoformat()
        holidays = [row for row in holidays if row["holiday_date"] <= to_text]
    return holidays


def list_public_holidays(con, from_date: date, to_date: date) -> list[dict[str, Any]]:
    """Rows from planner_public_holiday in [from_date, to_date]."""
    return [
        {
            "holiday_date": compact_text(row["holiday_date"] or ""),
            "note": compact_text(row.get("note") or ""),
            "source": compact_text(row.get("source") or "manual"),
            "fetched_at": compact_text(row.get("fetched_at") or ""),
        }
        for row in rows(
            con.execute(
                """
                SELECT holiday_date::text AS holiday_date, note,
                       COALESCE(source, 'manual') AS source,
                       fetched_at::text AS fetched_at
                FROM planner_public_holiday
                WHERE holiday_date >= %s::date
                  AND holiday_date <= %s::date
                ORDER BY holiday_date
                """,
                (from_date.isoformat(), to_date.isoformat()),
            )
        )
        if compact_text(row["holiday_date"] or "")
    ]


def sync_sg_public_holidays_to_db(
    con,
    *,
    from_year: int | None = None,
    to_year: int | None = None,
) -> dict[str, Any]:
    """
    Refresh planner_public_holiday from data.gov.sg for the year range.
    Removes prior sg_mom rows in that range, then upserts fetched holidays.
    Manual rows (source != sg_mom) are preserved.
    """
    today = date.today()
    year_start = int(from_year if from_year is not None else today.year - 1)
    year_end = int(to_year if to_year is not None else today.year + 1)
    if year_end < year_start:
        year_start, year_end = year_end, year_start

    range_start = date(year_start, 1, 1)
    range_end = date(year_end, 12, 31)
    fetched = fetch_sg_public_holidays(from_date=range_start, to_date=range_end)
    fetched_at = datetime.now(timezone.utc)

    deleted = con.execute(
        """
        DELETE FROM planner_public_holiday
        WHERE COALESCE(source, 'manual') = %s
          AND holiday_date >= %s::date
          AND holiday_date <= %s::date
        """,
        (SG_MOM_SOURCE, range_start.isoformat(), range_end.isoformat()),
    )
    deleted_count = int(getattr(deleted, "rowcount", 0) or 0)

    upserted = 0
    for row in fetched:
        con.execute(
            """
            INSERT INTO planner_public_holiday (
              holiday_date, note, source, fetched_at, updated_at
            ) VALUES (%s::date, %s, %s, %s, NOW())
            ON CONFLICT (holiday_date) DO UPDATE SET
              note = EXCLUDED.note,
              source = EXCLUDED.source,
              fetched_at = EXCLUDED.fetched_at,
              updated_at = NOW()
            """,
            (
                row["holiday_date"],
                row["note"],
                SG_MOM_SOURCE,
                fetched_at,
            ),
        )
        upserted += 1

    return {
        "ok": True,
        "from_year": year_start,
        "to_year": year_end,
        "fetched_count": len(fetched),
        "upserted_count": upserted,
        "deleted_sg_mom_count": deleted_count,
        "fetched_at": fetched_at.isoformat(),
        "holidays": fetched,
    }
