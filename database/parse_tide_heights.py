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
import psycopg2
import openpyxl
from datetime import datetime

DB_NAME = os.getenv("DB_NAME", "sar_datums")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5432")

TIDE_START_ROW = 44
TIDE_END_ROW = 5689
TIME_COL = 1   # Column A
HEIGHT_COL = 2  # Column B


def parse_and_insert(excel_path):
    print(f"Opening {excel_path}...")
    wb = openpyxl.load_workbook(excel_path, read_only=True, data_only=True)
    ws = wb['Data']

    # Connect to database
    conn_params = {
        "dbname": DB_NAME,
        "host": DB_HOST,
        "port": DB_PORT,
        "user": DB_USER
    }
    if DB_PASSWORD:
        conn_params["password"] = DB_PASSWORD
    conn = psycopg2.connect(**conn_params)
    cur = conn.cursor()

    cur.execute("TRUNCATE TABLE tide_heights RESTART IDENTITY;")
    conn.commit()

    print("Parsing tide heights...")
    count = 0

    for row in ws.iter_rows(min_row=TIDE_START_ROW, max_row=TIDE_END_ROW, values_only=True):
        time_val = row[TIME_COL - 1]
        height_val = row[HEIGHT_COL - 1]

        if time_val is None or height_val is None:
            continue

        # openpyxl returns datetime objects for date-formatted cells
        if isinstance(time_val, datetime):
            ts = time_val
        elif isinstance(time_val, str):
            for fmt in ("%d/%m/%Y %H:%M", "%d/%m/%Y", "%Y-%m-%d %H:%M:%S"):
                try:
                    ts = datetime.strptime(time_val, fmt)
                    break
                except ValueError:
                    continue
            else:
                print(f"  Warning: Cannot parse date '{time_val}', skipping")
                continue
        else:
            print(f"  Warning: Unexpected type {type(time_val)} for time, skipping")
            continue

        height = float(height_val)
        cur.execute(
            "INSERT INTO tide_heights (time, height) VALUES (%s, %s)",
            (ts, height)
        )
        count += 1

    conn.commit()
    print(f"Done! Inserted {count} tide height records.")

    cur.close()
    conn.close()
    wb.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python database/parse_tide_heights.py <excel_file_path>")
        sys.exit(1)
    parse_and_insert(sys.argv[1])