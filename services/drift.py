import math
import os
from datetime import datetime, timedelta
from database.db_config import get_connection
from domain.model import Coordinate, Wind, SearchObject, CurrentVector

KNOTS_TO_MS = 1852 / 3600
METRES_PER_DEGREE_LAT = 111120

# Reference-cycle column counts from Peter's spreadsheet (Data!B25-B30).
# Values reflect Excel's INT() rounding that Peter flagged in his email
# ("rounded to 133 and 255 rather than 135 and 257"); leaving them matched
# keeps lookups bug-compatible with the spreadsheet currently shipped to him.
NEAP_EBB_COLS = 62
NEAP_FLOOD_COLS = 61
SPRING_EBB_COLS = 62
SPRING_FLOOD_COLS = 62

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


def _calculate_time_steps(current_time: datetime, prev_time, prev_height, next_time, next_height):
    """Compute the Neap and Spring DB column indices (as `time_step` floats).

    Mirrors VBA VADatums where Neap and Spring lookups use *different* column
    counts:
        clC_neap   = round(TSCl * NeapCols(Td)) * 2 + NeapStart(Td)
        clC_spring = round(TSCl * SpringCols(Td)) * 2 + SpringStart(Td)
    Our parser stored both sections on a unified 0.1h-step axis, so we just
    map each index to its time_step label.

    Returns (neap_time_step, spring_time_step, is_ebb, ts_fraction).
    """
    tide_range = next_height - prev_height
    is_ebb = tide_range < 0  # Falling tide = ebb (high water -> low water)

    total_period = (next_time - prev_time).total_seconds()
    elapsed = (current_time - prev_time).total_seconds()
    ts_fraction = elapsed / total_period if total_period > 0 else 0
    ts_fraction = max(0.0, min(1.0, ts_fraction))

    if is_ebb:
        neap_idx = min(round(ts_fraction * NEAP_EBB_COLS), NEAP_EBB_COLS - 1)
        spring_idx = min(round(ts_fraction * SPRING_EBB_COLS), SPRING_EBB_COLS - 1)
    else:
        # Flood is the second half of the cycle; offset past the ebb columns.
        neap_idx = NEAP_EBB_COLS + min(round(ts_fraction * NEAP_FLOOD_COLS), NEAP_FLOOD_COLS - 1)
        spring_idx = SPRING_EBB_COLS + min(round(ts_fraction * SPRING_FLOOD_COLS), SPRING_FLOOD_COLS - 1)

    neap_time_step = round(neap_idx * 0.1, 1)
    spring_time_step = round(spring_idx * 0.1, 1)
    return neap_time_step, spring_time_step, is_ebb, ts_fraction


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


def _find_nearest_vectors(cur, lat: float, lon: float, neap_time_step: float, spring_time_step: float):
    """Find the tidal current vectors at the nearest grid point.

    Neap and Spring are queried at *different* time_step indices because Peter's
    VBA picks columns separately for each section (Datums.cls computes
    Datums.Cells(rw, clA + 3) for Neap and clA + 4 for Spring). Returns
    (neap_vx, neap_vy, spring_vx, spring_vy).
    """
    # Step 1: Find nearest grid point from locations table (207K rows, fast).
    cur.execute("""
        SELECT lat, lon
        FROM locations
        ORDER BY location <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
        LIMIT 1
    """, (lon, lat))

    nearest = cur.fetchone()
    if nearest is None:
        return 0.0, 0.0, 0.0, 0.0

    nearest_lat, nearest_lon = nearest

    # time_step column is REAL (float4); cast the float8 params so equality
    # matches values like 0.1, 1.7 that don't round-trip across precisions.
    cur.execute("""
        SELECT tide_type, vx, vy
        FROM tidal_vectors
        WHERE lat = %s AND lon = %s
          AND ((tide_type = 'neap'   AND time_step = %s::real)
            OR (tide_type = 'spring' AND time_step = %s::real))
    """, (nearest_lat, nearest_lon, neap_time_step, spring_time_step))

    neap_vx, neap_vy = 0.0, 0.0
    spring_vx, spring_vy = 0.0, 0.0
    for tide_type, vx, vy in cur.fetchall():
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

    # Step 2: Calculate Neap and Spring time_steps separately.
    neap_ts, spring_ts, is_ebb, _ = _calculate_time_steps(
        current_time, prev_time, prev_height, next_time, next_height
    )

    # Step 3: Calculate Spring/Neap interpolation ratio
    tide_range = next_height - prev_height
    rratio = _calculate_rratio(tide_range, config, is_ebb)

    # Step 4: Find nearest vectors (Neap and Spring use different time_steps).
    neap_vx, neap_vy, spring_vx, spring_vy = _find_nearest_vectors(
        cur, lat, lon, neap_ts, spring_ts
    )

    # Step 5: Interpolate between Neap and Spring
    # VBA: x = ((spring_x - neap_x) * RRatio) + neap_x
    vx = neap_vx + (spring_vx - neap_vx) * rratio
    vy = neap_vy + (spring_vy - neap_vy) * rratio

    return CurrentVector(vx, vy)

def _grid_step_for_bbox(bbox_width: float) -> float:
    """Pick a stable grid step (degrees) from a discrete ladder based on bbox width.
    Cells are anchored to the global (0, 0) origin so panning never reshuffles arrows;
    only crossing a width threshold (i.e. zooming) triggers a step change.
    """
    for threshold, step in ((1.0, 0.04), (0.4, 0.02), (0.1, 0.01), (0.05, 0.005)):
        if bbox_width >= threshold:
            return step
    return 0.0025


def get_currents_grid(
    sample_time: datetime,
    lat_min: float, lat_max: float,
    lon_min: float, lon_max: float,
    target: str = "local",
) -> list[dict]:
    """Sample tidal currents at a grid of points within the bbox for `sample_time`.
    Returns one entry per cell with speed (knots) and compass bearing (degrees).
    """
    conn = get_connection(target=target)
    cur = conn.cursor()
    try:
        config = _get_config(cur)

        brackets = _find_bracketing_tides(cur, sample_time)
        if brackets is None:
            return []
        prev_time, prev_height, next_time, next_height = brackets
        neap_ts, spring_ts, is_ebb, _ = _calculate_time_steps(
            sample_time, prev_time, prev_height, next_time, next_height
        )
        tide_range = next_height - prev_height
        rratio = _calculate_rratio(tide_range, config, is_ebb)

        width = lon_max - lon_min
        height = lat_max - lat_min
        if width <= 0 or height <= 0:
            return []
        step = _grid_step_for_bbox(max(width, height))

        # Globally-anchored grid: FLOOR(coord / step) gives the same cell index for
        # any coord regardless of bbox position, so panning yields stable points.
        cur.execute("""
            SELECT DISTINCT ON (
                FLOOR(lat / %s),
                FLOOR(lon / %s)
            ) lat, lon
            FROM locations
            WHERE lat BETWEEN %s AND %s
              AND lon BETWEEN %s AND %s
            ORDER BY FLOOR(lat / %s), FLOOR(lon / %s), lat, lon
        """, (
            step, step,
            lat_min, lat_max, lon_min, lon_max,
            step, step,
        ))
        points = cur.fetchall()
        if not points:
            return []

        # One round-trip for all neap+spring vectors. Neap and Spring use
        # different time_step indices (Peter's VBA picks columns separately
        # for each), so the WHERE clause filters per tide_type.
        values_sql = ','.join(f'({lat}, {lon})' for lat, lon in points)
        cur.execute(f"""
            SELECT lat, lon, tide_type, vx, vy
            FROM tidal_vectors
            WHERE (lat, lon) IN (VALUES {values_sql})
              AND ((tide_type = 'neap'   AND time_step = %s::real)
                OR (tide_type = 'spring' AND time_step = %s::real))
        """, (neap_ts, spring_ts))

        by_point: dict = {}
        for lat, lon, tide_type, vx, vy in cur.fetchall():
            entry = by_point.setdefault((float(lat), float(lon)), {})
            entry[tide_type] = (float(vx), float(vy))

        result = []
        for (lat, lon), vectors in by_point.items():
            neap_vx, neap_vy = vectors.get('neap', (0.0, 0.0))
            spring_vx, spring_vy = vectors.get('spring', (0.0, 0.0))
            vx = neap_vx + (spring_vx - neap_vx) * rratio
            vy = neap_vy + (spring_vy - neap_vy) * rratio
            speed_kt = math.sqrt(vx * vx + vy * vy) * 3600 / 1852
            bearing_deg = (math.degrees(math.atan2(vx, vy)) + 360) % 360
            result.append({
                'lat': lat,
                'lon': lon,
                'speed_kt': round(speed_kt, 2),
                'bearing_deg': round(bearing_deg, 1),
            })
        return result
    finally:
        cur.close()
        conn.close()


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

def calculate_drift(start_position, start_time, end_time, wind, search_object, is_reverse=False, target="local"):
    """Walk a drifting object forward (or backward) in time.

    Step length adapts to the current ebb/flood cycle, mirroring Peter's VBA
    `TmPeriod = (NxtTm - TideTm) / ColCount(...)`. Each iteration advances by
    one reference column's worth of the *current* cycle, so a longer cycle
    produces longer steps. Steps also snap to cycle boundaries and end_time so
    Neap/Spring lookups always reference a single cycle.

    `target` selects the DB pool ('local' or 'aws') via database.db_config.

    Returns (positions, timestamps) — same length, parallel lists. Timestamps
    are no longer uniform 0.1h, so callers must use them directly instead of
    assuming a fixed cadence.
    """
    conn = get_connection(target=target)
    cur = conn.cursor()
    try:
        config = _get_config(cur)
        leeway = calculate_leeway(wind, search_object)

        positions = [start_position]
        timestamps = [start_time]
        current_position = start_position
        current_time = start_time

        sign = -1 if is_reverse else 1
        multiplier = float(sign)

        # Safety: bound iterations so a degenerate cycle can't spin forever.
        MAX_ITERS = 5000
        for _ in range(MAX_ITERS):
            if sign > 0 and current_time >= end_time:
                break
            if sign < 0 and current_time <= end_time:
                break

            brackets = _find_bracketing_tides(cur, current_time)
            if brackets is None:
                break
            prev_time, prev_height, next_time, next_height = brackets

            is_ebb = (next_height - prev_height) < 0
            cycle_seconds = (next_time - prev_time).total_seconds()
            # TmPeriod uses the Neap reference column count (matches VBA when
            # SpNp picks Neap; the Spring branch differs by ~1 column in
            # practice, well below per-step accuracy noise).
            col_count = NEAP_EBB_COLS if is_ebb else NEAP_FLOOD_COLS
            tm_period_seconds = cycle_seconds / col_count if col_count else 360

            # Compute step end, capped at the cycle boundary AND the final time.
            step_delta = timedelta(seconds=tm_period_seconds * sign)
            next_step_time = current_time + step_delta
            if sign > 0:
                if next_step_time > next_time: next_step_time = next_time
                if next_step_time > end_time:  next_step_time = end_time
            else:
                if next_step_time < prev_time: next_step_time = prev_time
                if next_step_time < end_time:  next_step_time = end_time

            actual_seconds = abs((next_step_time - current_time).total_seconds())
            if actual_seconds < 1:
                # Stuck on a cycle boundary; nudge past it so the next iter
                # picks up the new HW/LW pair.
                current_time = current_time + timedelta(seconds=sign)
                continue

            tidal_current = get_tidal_current(
                cur, current_position.lat, current_position.lon, current_time, config
            )
            current_position = apply_drift_step(
                current_position, tidal_current, leeway, actual_seconds, multiplier
            )

            positions.append(current_position)
            timestamps.append(next_step_time)
            current_time = next_step_time

        return positions, timestamps
    finally:
        cur.close()
        conn.close()
