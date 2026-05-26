import math
from domain.model import Coordinate


def generate_sector_search(
    datum: Coordinate,
    search_direction_deg: float,
    radius_nm: float,
    sector_angle_deg: float,
) -> list[list[Coordinate]]:
    """
    Generate a sector search pattern.

    Args:
        datum:                Centre point of the search (Coordinate).
        search_direction_deg: Initial search direction (degrees true).
        radius_nm:            Search radius in nautical miles.
        sector_angle_deg:     Either 60 (single sector) or 30 (three sectors).

    Returns:
        List of sectors, each sector being a list of Coordinates.
        Single sector returns a list with one inner list.
        30-degree mode returns a list with three inner lists.
    """
    radian = math.pi / 180
    # VBA works in a south-positive latitude frame (negated when writing GPX).
    # Flip the datum positive here and negate the output below.
    datum = Coordinate(-datum.lat, datum.lon)
    conv = math.cos(radian * datum.lat)

    num_sectors = 3 if sector_angle_deg == 30 else 1
    start_deg = search_direction_deg - 180

    sectors: list[list[Coordinate]] = []

    for b in range(num_sectors):
        deg = start_deg
        start_deg += 30

        sector: list[Coordinate] = []
        first_point = None

        for c in range(3):
            for d in range(1, 3):
                lat_a = datum.lat - ((math.cos(radian * deg) * radius_nm) / 60)
                lon_a = datum.lon + ((math.sin(radian * deg) * radius_nm) / (60 * conv))
                sector.append(Coordinate(lat_a, lon_a))

                if c == 0 and d == 1:
                    first_point = Coordinate(lat_a, lon_a)

                deg += 180
            deg += 120

        # Close the sector back to the first point
        sector.append(first_point)
        sectors.append(sector)

    # Back to signed (north-negative) latitude.
    return [[Coordinate(-p.lat, p.lon) for p in sec] for sec in sectors]