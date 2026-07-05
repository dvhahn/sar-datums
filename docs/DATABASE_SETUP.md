# Database Setup Guide

This guide sets up the PostgreSQL + PostGIS database locally and imports all required tidal data.

## MacOS

**1. Install PostgreSQL 18**

```bash
brew install postgresql@18
brew services start postgresql@18
```

**2. Install PostGIS**

```bash
brew install postgis
```

**3. Create the `sar_datums` database**

```bash
createdb sar_datums
psql sar_datums -c "CREATE EXTENSION postgis;"
```

**4. Run the schema**

```bash
psql sar_datums -f database/schema.sql
```

**5. Install parsing dependencies**

```bash
pip install openpyxl psycopg2-binary
```

**6. Import tide heights and tidal vector data**

```bash
python database/parse_tide_heights.py <excel_path>
python database/parse_tidal_data.py <excel_path>
```
> Takes ~40 minutes.

**7. Import the SAR object catalogue**

Populates `object_types` from `data/objects.csv` (117 entries — leeway coefficients and divergence angles for the object picker / divergence drift):

```bash
python database/import_objects_csv.py data/objects.csv
```

**8. Create the locations table + indexes**

```bash
psql -U postgres -d sar_datums -c "CREATE TABLE locations AS SELECT DISTINCT lat, lon, location FROM tidal_vectors;"
psql -U postgres -d sar_datums -c "CREATE INDEX idx_locations_gist ON locations USING GIST (location);"
psql -U postgres -d sar_datums -c "CREATE INDEX idx_tidal_vectors_coords ON tidal_vectors (lat, lon, time_step);"
```

**9. Verify setup**

```bash
export DB_USER=postgres
export DB_PASSWORD=your_postgres_password
python test_drift.py
```

If it runs without database errors, you're set up correctly.

## Windows

**1. Install PostgreSQL 18**

Download from https://www.postgresql.org/download/windows/ — make sure to include pgAdmin4 and PostGIS during install. If PostGIS isn't bundled, grab it separately from https://postgis.net/windows_downloads/.

If `psql` isn't recognized afterwards, add PostgreSQL's `bin` folder to your PATH (e.g. `C:\Program Files\PostgreSQL\18\bin`).

**2. Create the `sar_datums` database**

```powershell
createdb -U postgres -h localhost sar_datums
psql -U postgres -d sar_datums -c "CREATE EXTENSION postgis;"
```

**3. Run the schema**

```powershell
psql -U postgres -d sar_datums -f database/schema.sql
```

**4. Install parsing dependencies**

```powershell
pip install openpyxl psycopg2-binary
```

**5. Import tide heights and tidal vector data**

```powershell
python database/parse_tide_heights.py "<excel_path>"
python database/parse_tidal_data.py "<excel_path>"
```
> Takes ~40 minutes.

**6. Import the SAR object catalogue**

```powershell
python database/import_objects_csv.py data/objects.csv
```

**7. Create the locations table + indexes**

```powershell
psql -U postgres -d sar_datums -c "CREATE TABLE locations AS SELECT DISTINCT lat, lon, location FROM tidal_vectors;"
psql -U postgres -d sar_datums -c "CREATE INDEX idx_locations_gist ON locations USING GIST (location);"
psql -U postgres -d sar_datums -c "CREATE INDEX idx_tidal_vectors_coords ON tidal_vectors (lat, lon, time_step);"
```

**8. Verify setup**

```powershell
$env:DB_USER="postgres"
$env:DB_PASSWORD="your_postgres_password"
python test_drift.py
```

If it runs without database errors, you're set up correctly.
