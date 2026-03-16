import math
from domain.model import Coordinate, Wind, SearchObject, CurrentVector

KNOTS_TO_MS = 1852 / 3600
METRES_PER_DEGREE_LAT = 111120

def calculate_leeway(wind: Wind, search_object: SearchObject) -> CurrentVector:
    """leeway = speed of an object pushed by wind. Excel: Datums line 20.
        if under 5 Knots, will be ignored (0).
    """

    if wind.speed > 5:
        wind_speed = ((wind.speed * search_object.coefficient_a) + search_object.coefficient_b) * KNOTS_TO_MS
    else:
        wind_speed = 0

    drift_direction = (wind.direction_deg + 180) % 360 # reverse. 0 degree - north, when wind comes from north object will be pushed south.
    vx = math.sin(math.radians(drift_direction)) * wind_speed
    vy = math.cos(math.radians(drift_direction)) * wind_speed

    return CurrentVector(vx, vy)

def get_tidal_current(lat: float, lon: float, time) -> CurrentVector:
    """retrieve tidal data from DB, to be implemented after DB.
        See "Find" function form Data sheet.
    """

    return CurrentVector(0, 0)


def apply_drift_step(position: Coordinate, current: CurrentVector, leeway: CurrentVector, time_delta_seconds: float) -> Coordinate:
    """
        this function will calculate the coordinate of an object drifting every 0.1 hour.
        adds leeway + tidal -> convert into lat, lon.
    """
    total_vx = current.vx + leeway.vx
    total_vy = current.vy + leeway.vy

    dx = total_vx * time_delta_seconds  # metres
    dy = total_vy * time_delta_seconds  # metres

    new_lat = position.lat + (dy / 111120)
    new_lon = position.lon + ((dx / 111120) / math.cos(math.radians(position.lat)))

    return Coordinate(new_lat, new_lon)