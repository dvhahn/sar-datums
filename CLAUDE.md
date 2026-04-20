# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SAR (Search and Rescue) Datums - A maritime drift prediction system that calculates the trajectory of objects drifting in water based on tidal currents and wind conditions. The system uses real tidal data from Auckland's Hauraki Gulf region stored in PostgreSQL with PostGIS spatial extensions.

## Architecture

### Core Components

**Domain Layer** (`domain/model.py`):
- `Coordinate`: Lat/lon position with validation (-90 to 90 for lat, -180 to 180 for lon)
- `Wind`: Wind speed (knots) and direction (0-360 degrees)
- `SearchObject`: Drift object types with leeway coefficients (a, b)
- `CurrentVector`: Velocity vector (vx, vy) in m/s

**Services Layer**:
- `services/drift.py`: Core drift calculation engine
  - Calculates leeway (wind-driven drift) using object-specific coefficients
  - Queries tidal current vectors from PostGIS database
  - Interpolates between neap/spring tides based on tidal range
  - Steps through time in 0.1-hour (6-minute) increments
  - Returns list of positions representing drift trajectory
- `services/gpx.py`: Generates GPX (GPS Exchange Format) files from position lists

**API Layer** (`app.py`):
- Flask REST API with CORS enabled
- Serves static frontend from `ui_ux/` directory
- Main endpoint: `POST /api/drift` - calculates drift trajectory
- Returns JSON with positions, summary statistics, and GPX download URL

**Database Layer** (`database/`):
- `schema.sql`: PostgreSQL schema with PostGIS extensions
- `parse_tide_heights.py`: Imports tide height predictions from Excel
- `parse_tidal_data.py`: Imports tidal current vectors from Excel (207K grid points)

### Database Schema

**tidal_vectors** (~52M rows):
- Stores current velocity (vx, vy) at each grid point for each time step (0.0h to 12.5h)
- Separated by tide type (neap/spring)
- Uses PostGIS geography type for spatial queries

**locations** (207K rows):
- Unique grid points extracted from tidal_vectors
- Used for fast nearest-neighbour spatial lookups
- Created after data import: `CREATE TABLE locations AS SELECT DISTINCT lat, lon, location FROM tidal_vectors;`

**tide_heights** (~5K rows):
- Predicted high/low water times and heights for Auckland
- Used to determine current tidal phase (ebb/flood) and spring/neap interpolation

**config**:
- Reference tidal ranges for neap/spring ebb/flood phases
- Used for RRatio calculation (spring/neap interpolation factor)

## Development Commands

### Environment Setup

**Virtual Environment**:
```bash
# Create and activate
python3 -m venv venv
source venv/bin/activate  # MacOS/Linux
venv\Scripts\activate     # Windows

# Install dependencies
pip install -r requirements.txt
```

**Database Setup** (PostgreSQL 18 + PostGIS required):
```bash
# Create database
createdb -U postgres sar_datums
psql -U postgres -d sar_datums -c "CREATE EXTENSION postgis;"

# Run schema
psql -U postgres -d sar_datums -f database/schema.sql

# Import data (takes ~40 minutes)
python database/parse_tide_heights.py <excel_path>
python database/parse_tidal_data.py <excel_path>

# Create locations table and indexes
psql -U postgres -d sar_datums -c "CREATE TABLE locations AS SELECT DISTINCT lat, lon, location FROM tidal_vectors;"
psql -U postgres -d sar_datums -c "CREATE INDEX idx_locations_gist ON locations USING GIST (location);"
psql -U postgres -d sar_datums -c "CREATE INDEX idx_tidal_vectors_coords ON tidal_vectors (lat, lon, time_step);"
```

**Environment Variables**:
```bash
export DB_USER=postgres
export DB_PASSWORD=your_password
export DB_NAME=sar_datums
export DB_HOST=localhost
export DB_PORT=5432
```

### Running the Application

**Start Flask Server**:
```bash
python app.py
# Runs on http://localhost:5000 in debug mode
```

**Run Tests**:
```bash
# Quick drift calculation test
python test_drift.py

# GPX generation test
python test/test_gpx.py
```

## Key Algorithms

### Drift Calculation Flow

1. **Leeway Calculation**: Wind-driven drift using object-specific coefficients
   - If wind speed > 5 knots: `leeway_speed = (wind_speed * coeff_a + coeff_b) * KNOTS_TO_MS`
   - Direction: opposite to wind direction (wind FROM north pushes object SOUTH)

2. **Tidal Current Lookup**:
   - Find bracketing tide heights (previous and next high/low water)
   - Calculate time_step (0.0 to 12.5) based on position in tidal cycle
   - Determine ebb vs flood phase
   - Calculate RRatio (spring/neap interpolation factor based on tidal range)
   - Find nearest grid point using PostGIS spatial index
   - Interpolate between neap and spring vectors: `v = neap_v + (spring_v - neap_v) * RRatio`

3. **Position Update**:
   - Combine tidal current + leeway vectors
   - Convert velocity to displacement over time step (6 minutes)
   - Update lat/lon using metres-per-degree conversion

### Time Step Mapping

- Ebb phase (falling tide): time_step 0.0 to ~6.1
- Flood phase (rising tide): time_step ~6.2 to ~12.3
- Each step represents 0.1 hours in the tidal cycle

## Important Constants

- `TIME_STEP_HOURS = 0.1` (6 minutes per iteration)
- `KNOTS_TO_MS = 1852 / 3600` (knot to m/s conversion)
- `METRES_PER_DEGREE_LAT = 111120` (approximate)
- `METRES_PER_NAUTICAL_MILE = 1852`

## API Request Format

```json
POST /api/drift
{
  "lat": -36.8,
  "lon": 174.8,
  "start_time": "2025-03-15T10:00:00",
  "end_time": "2025-03-15T13:00:00",
  "wind_speed": 15,
  "wind_direction": 180,
  "object_id": 1
}
```

## Search Object Types

Defined in `app.py` with leeway coefficients (a, b):
1. Person in Water (0.011, 0.07)
2. PIW with PFD - Average (0.013, 0.07)
3. Life Raft - No ballast, No canopy, No drogue (0.057, 0.21)
4. Person-Powered Craft - Surfboard w/ person (0.02, 0)
5. 55-gallon Oil Drum (0.014, 0)

## Code Conventions

- Use domain models for all coordinate/wind/object representations
- Database connections are created per-request (no connection pooling currently)
- All velocities internally use m/s (convert from knots at API boundary)
- Coordinates use decimal degrees (WGS84)
- Times use Python datetime objects (ISO 8601 format in API)
- GPX output uses ISO 8601 timestamps with 'Z' suffix
