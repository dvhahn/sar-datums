import math
from domain.model import Coordinate


def _pat_prep_square(
    datum: Coordinate,
    search_direction_deg: float,
    sweep_width_nm: float,
    search_width_nm: float,
    track_length_nm: float,
) -> tuple[Coordinate, Coordinate, Coordinate, Coordinate, float, float, float, float, int]:
    """
    Equivalent to PatPrep(2) in VBA.
    Computes the four track endpoints and step offsets for an expanding square pattern.

    Returns:
        end1, end2:             Primary axis endpoints
        end3, end4:             Perpendicular axis endpoints
        lon_step_primary:       Longitude step along primary axis
        lat_step_primary:       Latitude step along primary axis
        lon_step_perp:          Longitude step along perpendicular axis
        lat_step_perp:          Latitude step along perpendicular axis
        leg_count:              Number of legs each side of centre
    """
    radian = math.pi / 180
    conv = math.cos(radian * datum.lat)
    sw = sweep_width_nm

    # Adjust track length and width for expanding square (typ=2 branch)
    if search_width_nm * 2 > track_length_nm:
        track_length_nm = search_width_nm * 2
        search_width_nm = track_length_nm / 2  # original track_length / 2
    track_length_nm = (track_length_nm - (search_width_nm * 2)) + sw

    th = search_direction_deg
    sin_th = math.sin(th * radian)

    if sin_th == 0:
        w = 1 if th != 180 else -1
        x = 0.0
        y = w * track_length_nm / 120
        a_val = 0.0
        b_val = w * sw / 60
    else:
        g = -math.cos(th * radian) / sin_th
        x = math.copysign(
            math.sqrt(((track_length_nm / 120) ** 2) / (1 + g ** 2)),
            sin_th
        )
        a_val = math.copysign(
            math.sqrt(((sw / 60) ** 2) / (1 + g ** 2)),
            sin_th
        )
        y = g * x
        b_val = g * a_val

    # Primary endpoints (rwA+12/13 and rwA+14/15)
    # For expanding square, end1/end2 are offset by b_val/a_val before storing
    end1_base = Coordinate(datum.lat + y, datum.lon + (x / conv))
    end2 = Coordinate(datum.lat - y, datum.lon - (x / conv))

    # rwA+16/17 saves the unmodified end1, then end1 is shifted by b/a
    end3 = end1_base  # saved as rwA+16/17
    end1 = Coordinate(end1_base.lat - b_val, end1_base.lon - (a_val / conv))  # rwA+12/13

    # Perpendicular step offsets (45 degrees for expanding square, rwA+18..21)
    # PatPrep loops B=1,2 with k=45 and l=sqrt(2*sw^2)
    l = math.sqrt(2 * (sw ** 2))
    steps = []
    sign = 1
    for b_iter in range(1, 3):
        th_perp = th + (45 * sign)
        radian_perp = th_perp * radian
        if int(th_perp / 180) == th_perp / 180:
            sx = 0.0
            sy = l if th_perp != 180 else -l
        else:
            gp = -math.cos(radian_perp) / math.sin(radian_perp)
            sx = math.sqrt((l ** 2) / (1 + gp ** 2))
            if 180 < th_perp < 360:
                sx = -sx
            sy = gp * sx

        aa = math.copysign(1, th_perp) if th_perp != 0 else 1
        steps.append(((sx / conv) * sign * aa, sy * sign * aa))
        sign = -sign

    lon_step_primary, lat_step_primary = steps[0]
    lon_step_perp, lat_step_perp = steps[1]

    # end4 is the perpendicular counterpart to end3 (rwA+16/17 shifted)
    end4 = Coordinate(end2.lat, end2.lon)

    leg_count = int(search_width_nm / sweep_width_nm)

    return end1, end2, end3, end4, lon_step_primary, lat_step_primary, lon_step_perp, lat_step_perp, leg_count


def generate_expanding_square(
    datum: Coordinate,
    search_direction_deg: float,
    sweep_width_nm: float,
    search_width_nm: float,
    track_length_nm: float,
) -> list[Coordinate]:
    """
    Generate an expanding square search pattern.

    Args:
        datum:                Centre point of the search (Coordinate).
        search_direction_deg: Direction the track runs (degrees true).
        sweep_width_nm:       Sweep width in nautical miles.
        search_width_nm:      Total search box width in nautical miles.
        track_length_nm:      Length of each track leg in nautical miles.

    Returns:
        List of Coordinates representing the expanding square pattern.
    """
    end1, end2, end3, end4, lon_step_p, lat_step_p, lon_step_q, lat_step_q, leg_count = \
        _pat_prep_square(datum, search_direction_deg, sweep_width_nm, search_width_nm, track_length_nm)

    positions: list[Coordinate] = []
    b = 0
    c = 1

    for a in range(-leg_count, leg_count + 1):
        # B counter logic from VBA
        if b == 0 and c == -1:
            b = 1
        else:
            b = -b
            if b > 0:
                b += 1

        # First point of leg — primary axis endpoints + primary step
        base1 = end1 if c == 1 else end2
        positions.append(Coordinate(
            base1.lat + (b * lat_step_p),
            base1.lon + (b * lon_step_p)
        ))

        # Second point of leg — perpendicular axis endpoints + perpendicular step
        base2 = end3 if c == 1 else end4
        positions.append(Coordinate(
            base2.lat + (b * lat_step_q),
            base2.lon + (b * lon_step_q)
        ))

        c = -c

    return positions