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

    drift_direction = (wind.direction_deg + 180) % 360
    vx = math.sin(math.radians(wind.direction_deg)) * wind_speed
    vy = math.cos(math.radians(wind.direction_deg)) * wind_speed

    return CurrentVector(vx, vy)


def apply_drift_step():
    # TODO
    pass

def get_tidal_current():
    # TODO
    pass