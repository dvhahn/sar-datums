import math
import os
from datetime import datetime, timedelta
import psycopg2
from domain.model import Coordinate, Wind, SearchObject, CurrentVector

KNOTS_TO_MS = 1852 / 3600
METRES_PER_DEGREE_LAT = 111120
TIME_STEP_HOURS = 0.1  # 6 minutes per step
TIME_STEP_SECONDS = TIME_STEP_HOURS * 3600  # 360 seconds

# Tidal column layout (from Excel metadata B25-B30)
NEAP_EBB_STEPS = 62    # columns for neap ebb phase
NEAP_FLOOD_STEPS = 61  # columns for neap flood phase
SPRING_EBB_STEPS = 62
SPRING_FLOOD_STEPS = 62

# DB connection settings
DB_NAME = os.getenv("DB_NAME", "sar_datums")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5432")


def _get_db_connection():
    # Connect to database
    conn_params = {
        "dbname": DB_NAME,
        "host": DB_HOST,
        "port": DB_PORT,
        "user": DB_USER
    }
    if DB_PASSWORD:
        conn_params["password"] = DB_PASSWORD
    return psycopg2.connect(**conn_params)


def calculate_leeway(wind: Wind, search_object: SearchObject) -> CurrentVector:
    """Calculate leeway: speed of an object pushed by wind.
    If wind is under 5 knots, leeway is ignored (0).
    See Excel: Datums line 20.
    """
    if wind.speed > 5:
        wind_speed = ((wind.speed * search_object.coefficient_a) + search_object.coefficient_b) * KNOTS_TO_MS
    else:
        wind_speed = 0

    # Reverse direction: wind FROM north pushes object SOUTH
    drift_direction = (wind.direction_deg + 180) % 360
    vx = math.sin(math.radians(drift_direction)) * wind_speed
    vy = math.cos(math.radians(drift_direction)) * wind_speed

    return CurrentVector(vx, vy)


def _find_bracketing_tides(cur, current_time: datetime):
    """Find the two tide height entries that bracket the current time.
    Returns (prev_time, prev_height, next_time, next_height).
    Equivalent to the binary search in VBA VADatums (HtSt/HtNxt).
    """
    cur.execute("""
        SELECT time, height FROM tide_heights
        WHERE time <= %s
        ORDER BY time DESC LIMIT 1
    """, (current_time,))
    prev = cur.fetchone()

    cur.execute("""
        SELECT time, height FROM tide_heights
        WHERE time > %s
        ORDER BY time ASC LIMIT 1
    """, (current_time,))
    nxt = cur.fetchone()

    if prev is None or nxt is None:
        return None
    return prev[0], prev[1], nxt[0], nxt[1]


def _get_config(cur):
    """Load reference tidal ranges from config table."""
    cur.execute("SELECT key, value FROM config")
    return {row[0]: row[1] for row in cur.fetchall()}


def _calculate_time_step(current_time: datetime, prev_time, prev_height, next_time, next_height):
    """Calculate which time_step column to look up in the DB.

    Determines:
    - Ebb or flood (is the tide falling or rising?)
    - Fraction through the current phase (TSCl)
    - Maps to a time_step value (0.0 to 12.5)

    See VBA VADatums: TSCl calculation and column mapping.
    """
    tide_range = next_height - prev_height
    is_ebb = tide_range < 0  # Falling tide = ebb (high water -> low water)

    # Fraction through the current ebb/flood phase (0.0 to 1.0)
    total_period = (next_time - prev_time).total_seconds()
    elapsed = (current_time - prev_time).total_seconds()
    ts_fraction = elapsed / total_period if total_period > 0 else 0
    ts_fraction = max(0.0, min(1.0, ts_fraction))

    if is_ebb:
        # Ebb phase: maps to time_step 0.0 to ~6.1
        step_index = round(ts_fraction * NEAP_EBB_STEPS)
        step_index = min(step_index, NEAP_EBB_STEPS - 1)
    else:
        # Flood phase: maps to time_step ~6.2 to ~12.3
        flood_index = round(ts_fraction * NEAP_FLOOD_STEPS)
        flood_index = min(flood_index, NEAP_FLOOD_STEPS - 1)
        step_index = NEAP_EBB_STEPS + flood_index

    time_step = round(step_index * 0.1, 1)
    return time_step, is_ebb


def _calculate_rratio(tide_range: float, config: dict, is_ebb: bool):
    """Calculate the Spring/Neap interpolation ratio (RRatio).
    0.0 = pure Neap, 1.0 = pure Spring.

    See VBA VADatums: RRatio = (Rnge - TideData(Td,1,1)) / (TideData(Td,0,1) - TideData(Td,1,1))
    """
    abs_range = abs(tide_range)

    if is_ebb:
        neap_range = config['neap_ebb_tide_range']
        spring_range = config['spring_ebb_tide_range']
    else:
        neap_range = config['neap_flood_tide_range']
        spring_range = config['spring_flood_tide_range']

    if abs(spring_range - neap_range) < 0.001:
        return 0.5  # Avoid division by zero

    rratio = (abs_range - neap_range) / (spring_range - neap_range)
    return max(0.0, min(1.0, rratio))  # Clamp to 0-1


def _find_nearest_vectors(cur, lat: float, lon: float, time_step: float):
    """Find the tidal current vectors at the nearest grid point for a given time_step.
    Returns (neap_vx, neap_vy, spring_vx, spring_vy).

    This replaces VBA's Find() function + column lookup.
    Uses the locations table (207K rows) for fast spatial search,
    then fetches vectors from tidal_vectors by exact lat/lon match.
    """
    # Step 1: Find nearest grid point from locations table (207K rows, fast)
    cur.execute("""
        SELECT lat, lon
        FROM locations
        ORDER BY location <-> ST_Point(%s, %s)::geography
        LIMIT 1
    """, (lon, lat))

    nearest = cur.fetchone()
    if nearest is None:
        return 0.0, 0.0, 0.0, 0.0

    nearest_lat, nearest_lon = nearest

    # Step 2: Fetch neap and spring vectors at that point for the given time_step
    cur.execute("""
        SELECT tide_type, vx, vy
        FROM tidal_vectors
        WHERE lat = %s AND lon = %s AND ABS(time_step - %s) < 0.001
    """, (nearest_lat, nearest_lon, time_step))

    rows = cur.fetchall()

    neap_vx, neap_vy = 0.0, 0.0
    spring_vx, spring_vy = 0.0, 0.0

    for tide_type, vx, vy in rows:
        if tide_type == 'neap':
            neap_vx, neap_vy = vx, vy
        elif tide_type == 'spring':
            spring_vx, spring_vy = vx, vy

    return neap_vx, neap_vy, spring_vx, spring_vy


def get_tidal_current(cur, lat: float, lon: float, current_time: datetime, config: dict) -> CurrentVector:
    """Retrieve interpolated tidal current vector for a given position and time.

    Steps:
    1. Find bracketing tide heights (which HW/LW are we between?)
    2. Calculate time_step (where in the tidal cycle are we?)
    3. Calculate RRatio (how much Spring vs Neap?)
    4. Find nearest grid point and read Neap + Spring vectors
    5. Interpolate and return final current vector

    See VBA: VADatums + Data.Find
    """
    # Step 1: Find bracketing tides
    brackets = _find_bracketing_tides(cur, current_time)
    if brackets is None:
        return CurrentVector(0, 0)

    prev_time, prev_height, next_time, next_height = brackets

    # Step 2: Calculate time_step
    time_step, is_ebb = _calculate_time_step(
        current_time, prev_time, prev_height, next_time, next_height
    )

    # Step 3: Calculate Spring/Neap interpolation ratio
    tide_range = next_height - prev_height
    rratio = _calculate_rratio(tide_range, config, is_ebb)

    # Step 4: Find nearest vectors
    neap_vx, neap_vy, spring_vx, spring_vy = _find_nearest_vectors(
        cur, lat, lon, time_step
    )

    # Step 5: Interpolate between Neap and Spring
    # VBA: x = ((spring_x - neap_x) * RRatio) + neap_x
    vx = neap_vx + (spring_vx - neap_vx) * rratio
    vy = neap_vy + (spring_vy - neap_vy) * rratio

    return CurrentVector(vx, vy)

def apply_drift_step(position: Coordinate, current: CurrentVector, leeway: CurrentVector, time_delta_seconds: float, multiplier: float = 1.0) -> Coordinate:
    """Calculate new position after drifting for time_delta_seconds.
    Combines tidal current + wind leeway, converts to lat/lon displacement.
    """
    # Apply the multiplier to the total vectors
    total_vx = (current.vx + leeway.vx) * multiplier
    total_vy = (current.vy + leeway.vy) * multiplier

    dx = total_vx * time_delta_seconds
    dy = total_vy * time_delta_seconds

    new_lat = position.lat + (dy / METRES_PER_DEGREE_LAT)
    new_lon = position.lon + ((dx / METRES_PER_DEGREE_LAT) / math.cos(math.radians(position.lat)))

    return Coordinate(new_lat, new_lon)

def calculate_drift(start_position, start_time, end_time, wind, search_object, is_reverse=False) -> list[Coordinate]:
    conn = _get_db_connection()
    cur = conn.cursor()
    config = _get_config(cur)

    leeway = calculate_leeway(wind, search_object)
    multiplier = -1.0 if is_reverse else 1.0

    positions = [start_position]
    current_position = start_position
    current_time = start_time

    def has_not_reached_end(current, end, reverse):
        return current < end if not reverse else current > end

    while has_not_reached_end(current_time, end_time, is_reverse):
        # Get bracketing tides to calculate VBA-style dynamic TmPeriod
        brackets = _find_bracketing_tides(cur, current_time)
        if brackets is None:
            break

        prev_time, prev_height, next_time, next_height = brackets
        tide_range = next_height - prev_height
        is_ebb = tide_range < 0

        # VBA: TmPeriod = (NxtTm - TideTm) / ColCount(Td, SpNp, 0)
        # Determine spring or neap
        abs_range = abs(tide_range)
        if is_ebb:
            neap_range = config['neap_ebb_tide_range']
            spring_range = config['spring_ebb_tide_range']
            neap_steps = NEAP_EBB_STEPS
            spring_steps = SPRING_EBB_STEPS
        else:
            neap_range = config['neap_flood_tide_range']
            spring_range = config['spring_flood_tide_range']
            neap_steps = NEAP_FLOOD_STEPS
            spring_steps = SPRING_FLOOD_STEPS

        # Pick closer of spring/neap for step count (VBA: SpNp)
        if abs(abs_range - spring_range) < abs(abs_range - neap_range):
            col_count = spring_steps
        else:
            col_count = neap_steps

        # Dynamic step size matching VBA TmPeriod
        tide_period_seconds = (next_time - prev_time).total_seconds()
        tm_period_seconds = tide_period_seconds / col_count

        # Advance by one TmPeriod (capped at end_time)
        if is_reverse:
            step_end = current_time - timedelta(seconds=tm_period_seconds)
            if step_end < end_time:
                step_end = end_time
        else:
            step_end = current_time + timedelta(seconds=tm_period_seconds)
            if step_end > end_time:
                step_end = end_time

        actual_seconds = abs((step_end - current_time).total_seconds())

        tidal_current = get_tidal_current(
            cur, current_position.lat, current_position.lon, current_time, config
        )

        current_position = apply_drift_step(
            current_position, tidal_current, leeway, actual_seconds, multiplier
        )

        positions.append(current_position)
        current_time = step_end

    cur.close()
    conn.close()
    return positions


def get_currents_grid(sample_time: datetime, lat_min: float, lat_max: float, lon_min: float, lon_max: float, grid_size: int = 15) -> list[dict]:
    """Sample tidal currents at a grid of points within the bounding box.
    Returns a list of arrow objects for visualization.

    Args:
        sample_time: Time to sample currents at
        lat_min, lat_max, lon_min, lon_max: Bounding box
        grid_size: Number of points along each axis (default 15x15 grid)

    Returns:
        List of dicts with keys: lat, lon, bearing_deg, speed_kt
    """
    conn = _get_db_connection()
    cur = conn.cursor()
    config = _get_config(cur)

    arrows = []

    # Create a grid of sample points
    lat_step = (lat_max - lat_min) / (grid_size - 1) if grid_size > 1 else 0
    lon_step = (lon_max - lon_min) / (grid_size - 1) if grid_size > 1 else 0

    for i in range(grid_size):
        for j in range(grid_size):
            lat = lat_min + i * lat_step
            lon = lon_min + j * lon_step

            # Get tidal current at this point
            current = get_tidal_current(cur, lat, lon, sample_time, config)

            # Convert velocity components to bearing and speed
            if abs(current.vx) < 0.001 and abs(current.vy) < 0.001:
                continue  # Skip zero-velocity points

            # Calculate bearing (direction current is flowing TO)
            bearing_rad = math.atan2(current.vx, current.vy)
            bearing_deg = (math.degrees(bearing_rad) + 360) % 360

            # Calculate speed in knots
            speed_ms = math.sqrt(current.vx ** 2 + current.vy ** 2)
            speed_kt = speed_ms / KNOTS_TO_MS

            arrows.append({
                'lat': lat,
                'lon': lon,
                'bearing_deg': bearing_deg,
                'speed_kt': round(speed_kt, 2)
            })

    cur.close()
    conn.close()
    return arrows
