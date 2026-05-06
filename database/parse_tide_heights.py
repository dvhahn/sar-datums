"""
parse_tide_heights.py
Parses the tide height predictions from the Excel Data sheet
(columns A-B, rows 44 to 5689) and inserts into the
PostgreSQL tide_heights table.

Each row contains a high or low water event:
  - Column A: datetime of the event
  - Column B: water height in metres above chart datum

Usage:
    python database/parse_tide_heights.py path/to/excel_file.xlsm

Requirements:
    pip install openpyxl psycopg2-binary
"""

import sys
import os
import argparse
from datetime import datetime
import openpyxl
from database.db_config import get_connection

TIDE_START_ROW = 44
TIDE_END_ROW = 5689
TIME_COL = 1   # Column A
HEIGHT_COL = 2  # Column B


def parse_and_insert(excel_path, target):
    print(f"Opening {excel_path}...")
    wb = openpyxl.load_workbook(excel_path, read_only=True, data_only=True)
    ws = wb['Data']

    # Use the helper to connect to local or aws
    conn = get_connection(target=target)
    cur = conn.cursor()

    try:
        print(f"Clearing existing tide heights on {target}...")
        cur.execute("TRUNCATE TABLE tide_heights RESTART IDENTITY;")

        print("Parsing tide heights...")
        count = 0
        for row in ws.iter_rows(min_row=TIDE_START_ROW, max_row=TIDE_END_ROW, values_only=True):
            time_val = row[TIME_COL - 1]
            height_val = row[HEIGHT_COL - 1]

            if time_val is None or height_val is None:
                continue

            # Date parsing logic
            if isinstance(time_val, datetime):
                ts = time_val
            elif isinstance(time_val, str):
                # ... (Keep your existing format loop) ...
                ts = datetime.strptime(time_val, "%d/%m/%Y %H:%M")  # Simplified for example
            else:
                continue

            cur.execute(
                "INSERT INTO tide_heights (time, height) VALUES (%s, %s)",
                (ts, float(height_val))
            )
            count += 1

        conn.commit()
        print(f"Done! Inserted {count} records into {target}.")
    finally:
        cur.close()
        conn.close()
        wb.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("path", help="Path to Excel file")
    parser.add_argument("--target", default="local", choices=["local", "aws"], help="DB to target")
    args = parser.parse_args()

    parse_and_insert(args.path, args.target)