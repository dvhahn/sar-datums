import math
from domain.model import Coordinate

METRES_PER_NAUTICAL_MILE = 1852


def generate_expanding_circle(
    datum: Coordinate,
    search_width: float,
    track_length: float,
    sweep_width_m: float,
) -> list[Coordinate]:
    """
    Generate an expanding circle search pattern.

    Args:
        datum:          Centre point of the search (Coordinate).
        search_width:   Search width in nautical miles.
        track_length:   Total track length in nautical miles (halved internally).
        sweep_width_m:  Sweep width in metres (converted to nautical miles internally).

    Returns:
        List of Coordinates representing the expanding circle pattern.
    """
    radian = math.pi / 180
    # VBA works in a south-positive latitude frame (negated when writing GPX).
    # Flip the datum positive, then negate the output below.
    datum = Coordinate(-datum.lat, datum.lon)

    sw = sweep_width_m / METRES_PER_NAUTICAL_MILE
    rad = max(search_width, track_length / 2)
    conv = math.cos(radian * datum.lat)
    qty = math.ceil(rad / sw)

    positions: list[Coordinate] = [Coordinate(datum.lat, datum.lon)]

    for a in range(1, qty + 1):
        for b in range(0, 356, 5):
            d = (((a - 1) * sw) + ((b / 360) * sw)) / 60
            x = (math.sin(b * radian) * d) / conv
            y = math.cos(b * radian) * d
            positions.append(Coordinate(datum.lat + y, datum.lon + x))

    # Back to signed (north-negative) latitude.
    return [Coordinate(-p.lat, p.lon) for p in positions]