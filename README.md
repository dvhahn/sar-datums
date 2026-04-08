# Rescue Backend

## Installation

### MacOS
```
cd <project directory>
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Windows
```
cd <project directory>
py -3 -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

## Database Setup Guide
This guide explains how to set up the PostgreSQL + PostGIS database locally and import all required tidal data. Follow these steps exactly to ensure your database matches the rest of the team:

### MacOS
#### 1. Install PostgreSQL 18
```
brew install postgresql@18
```
Start the PostgreSQL server:
```
brew services start postgresql@18
```

#### 2. Install PostGIS:
```
brew install postgis
```

#### 3. Create "sar_datums" Database:
```
createdb sar_datums
```
Enable PostGIS extension inside the database:
```
psql sar_datums -c "CREATE EXTENSION postgis;"
```

#### 4. Run the Database Schema:
This will run the schema file to create all required tables:
```
psql sar_datums -f database/schema.sql
```

#### 5. Install Required Python Packages
This will install dependencies used for parsing Excel files and inserting it into PostgreSQL:
```
pip install openpyxl psycopg2-binary
```

#### 6. Import Tide Heights and Tidal Vector Data
This will run the tide height and tidal vector importers:
```
python database/parse_tide_heights.py <excel_path>
python database/parse_tidal_data.py <excel_path>
```
NOTE: This process may take approximately 40 minutes.

#### 7. Create Locations Table + Indexes
This will create locations table, create a spatial index for faster geospatial lookups, and create an index to speed up tidal vector queries:
```
psql -U postgres -d sar_datums -c "CREATE TABLE locations AS SELECT DISTINCT lat, lon, location FROM tidal_vectors;"
psql -U postgres -d sar_datums -c "CREATE INDEX idx_locations_gist ON locations USING GIST (location);"
psql -U postgres -d sar_datums -c "CREATE INDEX idx_tidal_vectors_coords ON tidal_vectors (lat, lon, time_step);"
```

#### 8. Set Environment Variables for PostgreSQL Login and Verify Setup
To verify that everything is working correctly, run:
```
$env:DB_USER=postgres
$env:DB_PASSWORD=your_postgres_password
python test_drift.py
```
If the script runs successfully and produces output without database errors, your setup is complete.

### Windows
#### 1. Install PostgreSQL 18
During installation ensure that you install pgAdmin4 and PostGIS (If available):
```
https://www.postgresql.org/download/windows/
```
If PostGIS is not included, download it separately from:  
```
https://postgis.net/windows_downloads/
```

#### 2. Add PostgreSQL to PATH
If you get errors like `psql is not recognized`, add PostgreSQL’s bin folder to your PATH.
E.g., `C:\Program Files\PostgreSQL\18\bin`.

#### 3. Create "sar_datums" Database:
```
createdb -U postgres -h localhost sar_datums
```
Enable PostGIS extension inside the database:
```
psql -U postgres -d sar_datums -c "CREATE EXTENSION postgis;"
```

#### 4. Run the Database Schema:
This will run the schema file to create all required tables:
```
psql -U postgres -d sar_datums -f database/schema.sql
```

#### 5. Install Required Python Packages
This will install dependencies used for parsing Excel files and inserting it into PostgreSQL:
```
pip install openpyxl psycopg2-binary
```

#### 6. Import Tide Heights and Tidal Vector Data
This will run the tide height and tidal vector importers:
```
python database/parse_tide_heights.py "<excel_path>"
python database/parse_tidal_data.py "<excel_path>"
```
NOTE: This process may take approximately 40 minutes.

#### 7. Create Locations Table + Indexes
This will create locations table, create a spatial index for faster geospatial lookups, and create an index to speed up tidal vector queries:
```
psql -U postgres -d sar_datums -c "CREATE TABLE locations AS SELECT DISTINCT lat, lon, location FROM tidal_vectors;"
psql -U postgres -d sar_datums -c "CREATE INDEX idx_locations_gist ON locations USING GIST (location);"
psql -U postgres -d sar_datums -c "CREATE INDEX idx_tidal_vectors_coords ON tidal_vectors (lat, lon, time_step);"
```

#### 8. Set Environment Variables for PostgreSQL Login and Verify Setup
To verify that everything is working correctly, run:
```
$env:DB_USER="postgres"
$env:DB_PASSWORD="your_postgres_password"
python test_drift.py
```
If the script runs successfully and produces output without database errors, your setup is complete.