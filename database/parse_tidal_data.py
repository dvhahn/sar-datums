"""
parse_tidal_data.py
Parses the tidal current vector data from the Excel Data sheet
and inserts it into the PostgreSQL tidal_vectors table.

The Excel file stores data in a "wide" format:
  - Each row = one geographic point (lat, lon)
  - Columns = vx/vy pairs for each time step (0.0h to 12.5h)
  - Two sections: Neap and Spring (separated by an empty column)

This script normalises the data into rows of:
  (location, lat, lon, tide_type, time_step, vx, vy)

Usage:
    python database/parse_tidal_data.py path/to/excel_file.xlsm

Requirements:
    pip install openpyxl psycopg2-binary
"""

import sys
import os
import time
import openpyxl
import psycopg2
from io import StringIO

# --- Configuration ---
DB_NAME = os.getenv("DB_NAME", "sar_datums")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5432")

# Excel Data sheet column mapping (1-indexed, openpyxl convention)
LAT_COL = 7        # Column G
LON_COL = 8        # Column H
NEAP_START_COL = 9  # Column I (Neap 0.0h vx)

DATA_START_ROW = 2  # First data row (after header)

# Time steps: 0.0, 0.1, 0.2 ... 12.5 = 126 steps
TIME_STEPS = [round(i * 0.1, 1) for i in range(126)]
COLS_PER_TIDE_TYPE = len(TIME_STEPS) * 2  # 126 steps x 2 (vx, vy) = 252 columns


def find_spring_start(ws):
    """Scan the header row to find where the Spring section begins.
    Looks for a 'lat' header after the Neap columns."""
    header_row = 1
    for col in range(NEAP_START_COL + COLS_PER_TIDE_TYPE, ws.max_column + 1):
        val = ws.cell(row=header_row, column=col).value
        if val and str(val).strip().lower() == 'lat':
            return col
    return None


def parse_and_insert(excel_path):
    print(f"Opening {excel_path}...")
    wb = openpyxl.load_workbook(excel_path, read_only=True, data_only=True)
    ws = wb['Data']

    # Detect Spring section start column
    spring_lat_col = find_spring_start(ws)
    if spring_lat_col is None:
        print("ERROR: Could not find Spring section in Data sheet.")
        sys.exit(1)

    spring_start_col = spring_lat_col + 2  # Skip lat, lon columns
    print(f"Neap starts at col {NEAP_START_COL}, Spring starts at col {spring_start_col}")

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

    # Clear existing data
    cur.execute("TRUNCATE TABLE tidal_vectors RESTART IDENTITY;")
    conn.commit()

    print("Parsing and inserting data...")
    batch_size = 500  # Flush to DB every N rows
    total_rows = 0
    total_db_rows = 0
    start_time = time.time()

    buffer = StringIO()

    for row_idx, row in enumerate(ws.iter_rows(min_row=DATA_START_ROW, values_only=True), start=DATA_START_ROW):
        lat = row[LAT_COL - 1]  # 0-indexed for values_only tuple
        lon = row[LON_COL - 1]

        if lat is None or lon is None:
            continue

        lat = float(lat)
        lon = float(lon)

        # --- Neap data ---
        for i, ts in enumerate(TIME_STEPS):
            col_offset = NEAP_START_COL - 1 + (i * 2)  # 0-indexed
            vx = row[col_offset] if col_offset < len(row) else None
            vy = row[col_offset + 1] if col_offset + 1 < len(row) else None

            if vx is not None and vy is not None:
                buffer.write(f"SRID=4326;POINT({lon} {lat})\t{lat}\t{lon}\tneap\t{ts}\t{vx}\t{vy}\n")
                total_db_rows += 1

        # --- Spring data ---
        for i, ts in enumerate(TIME_STEPS):
            col_offset = spring_start_col - 1 + (i * 2)  # 0-indexed
            vx = row[col_offset] if col_offset < len(row) else None
            vy = row[col_offset + 1] if col_offset + 1 < len(row) else None

            if vx is not None and vy is not None:
                buffer.write(f"SRID=4326;POINT({lon} {lat})\t{lat}\t{lon}\tspring\t{ts}\t{vx}\t{vy}\n")
                total_db_rows += 1

        total_rows += 1

        # Flush batch to database using COPY (much faster than INSERT)
        if total_rows % batch_size == 0:
            buffer.seek(0)
            cur.copy_from(
                buffer,
                'tidal_vectors',
                columns=('location', 'lat', 'lon', 'tide_type', 'time_step', 'vx', 'vy'),
                sep='\t'
            )
            conn.commit()
            buffer = StringIO()

            elapsed = time.time() - start_time
            rate = total_rows / elapsed if elapsed > 0 else 0
            print(f"  {total_rows:,} rows processed ({total_db_rows:,} DB rows) - {rate:.0f} rows/sec")

    # Flush remaining data
    if buffer.tell() > 0:
        buffer.seek(0)
        cur.copy_from(
            buffer,
            'tidal_vectors',
            columns=('location', 'lat', 'lon', 'tide_type', 'time_step', 'vx', 'vy'),
            sep='\t'
        )
        conn.commit()

    elapsed = time.time() - start_time
    print(f"\nDone! {total_rows:,} locations -> {total_db_rows:,} DB rows in {elapsed:.1f}s")

    cur.close()
    conn.close()
    wb.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python database/parse_tidal_data.py <excel_file_path>")
        sys.exit(1)
    parse_and_insert(sys.argv[1])