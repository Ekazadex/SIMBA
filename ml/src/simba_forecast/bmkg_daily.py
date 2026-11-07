"""Read BMKG observed *daily* rainfall without inventing sub-daily observations."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
import re

from openpyxl import load_workbook

KEMAYORAN_ID = "96745"
MISSING = {8888: "missing_code_8888", 9999: "missing_code_9999"}


def load_daily_rr(directory: str | Path):
    """Return deduplicated Kemayoran daily rows and an auditable exclusion report.

    The workbook date is a reporting label; its exact accumulation interval is
    not established by these downloads. Never interpolate a row to 5-minute truth.
    """
    selected = {}
    audit = {"files": [], "excluded_station_files": [], "date_rows": 0,
             "duplicate_date_rows": 0, "missing_code_rows": 0,
             "conflicts": [], "rainy_valid_days": 0,
             "reporting_date_convention": "unverified_workbook_label_not_a_midnight_5min_interval"}
    files = sorted(Path(directory).glob("*.xlsx"))
    if not files:
        raise FileNotFoundError(f"No BMKG daily workbooks in {directory}")
    for path in files:
        wb = load_workbook(path, read_only=True, data_only=True)
        try:
            rows = wb.active.iter_rows(values_only=True)
            metadata = []
            for row in rows:
                metadata.append(row)
                if str(row[0]).strip().upper() == "TANGGAL":
                    header = [str(value or "").strip().upper() for value in row]
                    break
            else:
                raise ValueError(f"No TANGGAL header: {path.name}")
            station = next((str(r[2] or "") for r in metadata if len(r) > 2 and r[1] == "ID WMO"), "")
            if not re.search(r"\b96745\b", station):
                audit["excluded_station_files"].append(path.name)
                continue
            if "RR" not in header:
                raise ValueError(f"No RR column: {path.name}")
            audit["files"].append(path.name)
            rr_col = header.index("RR")
            for row_number, row in enumerate(rows, start=len(metadata) + 1):
                try:
                    date = datetime.strptime(str(row[0]), "%d-%m-%Y").date().isoformat()
                except (ValueError, TypeError):
                    continue
                audit["date_rows"] += 1
                raw = row[rr_col] if len(row) > rr_col else None
                try:
                    value = float(raw) if raw is not None and str(raw).strip() else None
                except (TypeError, ValueError):
                    value = None
                if value in MISSING:
                    quality = MISSING[int(value)]
                    value = None
                    audit["missing_code_rows"] += 1
                elif value is None:
                    quality = "missing_blank_or_invalid"
                elif value < 0 or not __import__("math").isfinite(value):
                    quality = "missing_invalid"
                    value = None
                else:
                    quality = "observed_daily"
                record = {"date": date, "rr_mm": value, "quality": quality,
                          "station_id": KEMAYORAN_ID, "source_file": path.name,
                          "source_row": row_number}
                if date in selected:
                    audit["duplicate_date_rows"] += 1
                    old = selected[date]
                    if (old["rr_mm"], old["quality"]) != (value, quality):
                        audit["conflicts"].append({"date": date,
                                                   "kept": old["source_file"],
                                                   "discarded": path.name,
                                                   "kept_rr_mm": old["rr_mm"],
                                                   "discarded_rr_mm": value})
                else:
                    selected[date] = record
        finally:
            wb.close()
    records = [selected[key] for key in sorted(selected)]
    audit["distinct_dates"] = len(records)
    audit["rainy_valid_days"] = sum(r["rr_mm"] is not None and r["rr_mm"] > 0 for r in records)
    return records, audit
