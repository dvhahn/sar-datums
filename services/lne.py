import math
from domain.model import Coordinate

def _pat_prep_line(
    datum: Coordinate,
    search_direction_deg: float,
    sweep_width_nm: float,
    search_width_nm: float,
    track_length_nm: float,
) -> tuple[Coordinate, Coordinate, float, float, int]:
    """
    Equivalent to PatPrep(1) in VBA.
    Computes the two track endpoints and lateral/longitudinal step offsets
    for a creeping line search pattern.

    Returns:
        end1:       First track endpoint (Coordinate)
        end2:       Second track endpoint (Coordinate)
        lon_step:   Longitude offset per leg (degrees)
        lat_step:   Latitude offset per leg (degrees)
        leg_count:  Number of legs each side of centre
    """
    radian = math.pi / 180
    conv = math.cos(radian * datum.lat)
    sw = sweep_width_nm

    # Peter's feedback: the creeping line must rotate 90 deg from the entered
    # (drift) bearing so the pattern's centre spine runs ALONG the LKP->datum
    # line — legs sweep across the drift track while the pattern creeps along
    # it. The entered direction is therefore the creep/advance axis; legs run
    # perpendicular to it.
    th = search_direction_deg + 90.0
    sin_th = math.sin(th * radian)

    if sin_th == 0:
        # Track runs exactly N or S
        w = 1 if th == 180 else -1   # VBA: th=180 -> 1, else (incl. 0) -> -1
        x = 0.0
        y = w * track_length_nm / 120
        a = 0.0
        b = w * sw / 60
    else:
        g = -math.cos(th * radian) / sin_th
        x = math.copysign(
            math.sqrt(((track_length_nm / 120) ** 2) / (1 + g ** 2)),
            sin_th
        )
        a = math.copysign(
            math.sqrt(((sw / 60) ** 2) / (1 + g ** 2)),
            sin_th
        )
        y = g * x
        b = g * a

    # Track endpoints (equivalent to rwA+12..15 in Setup sheet)
    end1 = Coordinate(datum.lat + y, datum.lon + (x / conv))
    end2 = Coordinate(datum.lat - y, datum.lon - (x / conv))

    # Lateral step offsets perpendicular to track (rwA+18, rwA+19).
    # VBA does `sw = sw / 60` (NM → minutes-of-latitude i.e. degrees) right
    # here before the step computation; we mirror that with sw_deg so the
    # offsets land on a degree scale instead of NM.
    sw_deg = sw / 60
    th2 = th + 90
    radian_th2 = th2 * radian
    if int(th2 / 180) == th2 / 180:
        step_x = 0.0
        step_y = sw_deg if th2 != 180 else -sw_deg
    else:
        g2 = -math.cos(radian_th2) / math.sin(radian_th2)
        step_x = math.sqrt((sw_deg ** 2) / (1 + g2 ** 2))
        if 180 < th2 < 360:
            step_x = -step_x
        step_y = g2 * step_x

    sign = 1
    lon_step = (step_x / conv) * sign
    lat_step = step_y * sign

    # search_width_nm is the TOTAL box width the user enters. Legs are laid at
    # offsets -leg_count..+leg_count (each leg_step = one sweep width), so the
    # span is 2*leg_count sweeps. Halving here keeps the total span == the width
    # entered. (VBA stored a half-width in Wth; its form did this ÷2 for it.)
    leg_count = int((search_width_nm / 2) / sweep_width_nm)

    return end1, end2, lon_step, lat_step, leg_count


def generate_creeping_line(
    datum: Coordinate,
    search_direction_deg: float,
    sweep_width_nm: float,
    search_width_nm: float,
    track_length_nm: float,
) -> list[Coordinate]:
    """
    Generate a creeping line search pattern.

    Args:
        datum:                Centre point of the search (Coordinate).
        search_direction_deg: Direction the track runs (degrees true).
        sweep_width_nm:       Sweep width in nautical miles.
        search_width_nm:      Total search box width in nautical miles.
        track_length_nm:      Length of each track leg in nautical miles.

    Returns:
        List of Coordinates representing the creeping line pattern.
    """
    end1, end2, lon_step, lat_step, leg_count = _pat_prep_line(
        datum, search_direction_deg, sweep_width_nm, search_width_nm, track_length_nm
    )

    positions: list[Coordinate] = []
    c = 1  # Alternates between +1 and -1, selecting end1 or end2

    for a in range(-leg_count, leg_count + 1):
        b = a
        c = -c

        # c=+1 -> end1 (rwA+13/14), c=-1 -> end2 (rwA+12/15 i.e. 13-1 / 14-1)
        base = end1 if c == 1 else end2

        lat_a = base.lat + (b * lat_step)
        lon_a = base.lon + (b * lon_step)
        positions.append(Coordinate(lat_a, lon_a))

        base2 = end2 if c == 1 else end1
        lat_b = base2.lat + (b * lat_step)
        lon_b = base2.lon + (b * lon_step)
        positions.append(Coordinate(lat_b, lon_b))

    return positions