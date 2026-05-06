"""Import object types from a CSV file into the database.
The CSV file should have the following columns:
- name: The name of the object type
- parent_name: The name of the parent object type (can be empty)
- level: The hierarchy level (integer)
- coefficient_a: The leeway coefficient a (float)
- coefficient_b: The leeway coefficient b (float)
- divergence_angle: The divergence angle in degrees (float)"""

import csv
import sys
import os
import psycopg2

DB_NAME = os.getenv("DB_NAME", "sar_datums")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5432")


def get_connection():
    params = {"dbname": DB_NAME, "user": DB_USER, "host": DB_HOST, "port": DB_PORT}
    if DB_PASSWORD:
        params["password"] = DB_PASSWORD
    return psycopg2.connect(**params)


def import_objects(csv_path):
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("TRUNCATE TABLE object_types RESTART IDENTITY CASCADE")

    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        reader = csv.reader(f)
        header = next(reader)
        # Find column indices (by name)
        col_indices = {name.strip(): idx for idx, name in enumerate(header)}
        print("Column indices:", col_indices)

        rows = []
        for row in reader:
            if len(row) < 6:
                continue
            name = row[col_indices['name']].strip()
            parent = row[col_indices['parent_name']].strip() if col_indices['parent_name'] < len(row) else ''
            level = int(row[col_indices['level']].strip())
            a = float(row[col_indices['coefficient_a']].strip())
            b = float(row[col_indices['coefficient_b']].strip())
            div = float(row[col_indices['divergence_angle']].strip())
            rows.append((name, parent, level, a, b, div))

    # Insert rows in two passes
    name_to_id = {}
    for name, parent, level, a, b, div in rows:
        cur.execute("""
            INSERT INTO object_types (name, coefficient_a, coefficient_b, divergence_angle, level)
            VALUES (%s, %s, %s, %s, %s) RETURNING id
        """, (name, a, b, div, level))
        name_to_id[name] = cur.fetchone()[0]

    # Update parent_id
    for name, parent, level, a, b, div in rows:
        if parent:
            parent_id = name_to_id.get(parent)
            if parent_id:
                cur.execute("UPDATE object_types SET parent_id = %s WHERE name = %s", (parent_id, name))

    # Set display_order
    for idx, (name, _, _, _, _, _) in enumerate(rows, start=1):
        cur.execute("UPDATE object_types SET display_order = %s WHERE name = %s", (idx, name))

    conn.commit()
    cur.close()
    conn.close()
    print(f"Imported {len(rows)} objects.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python database/import_objects_csv.py data/objects.csv")
        sys.exit(1)
    import_objects(sys.argv[1])