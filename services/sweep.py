"""Sweep width calculator.

Lookup table sourced from Peter's Excel workbook (Setup sheet, columns BG-BU).
Logic mirrors the Calculator UserForm in the VBA workbook.

Calculation steps:
  1. Look up base sweep width from table (object, height_of_eye, visibility)
  2. Apply weather correction multiplier
  3. Apply fatigue multiplier (0.75 if fatigued, per IAMSAR standard)
  4. Multiply by number of search assets → final track spacing
"""

# ---------------------------------------------------------------------------
# Sweep width lookup table
# Keys: object name (lowercase, stripped)
# Values: [eye8_vis1, eye8_vis3, eye8_vis5, eye8_vis10, eye8_vis15, eye8_vis20,
#          eye14_vis1, eye14_vis3, eye14_vis5, eye14_vis10, eye14_vis15, eye14_vis20,
#          weather_15kts, weather_25kts]
# ---------------------------------------------------------------------------

_TABLE = {
    "person in water":          [0.2, 0.2, 0.3, 0.3, 0.3, 0.3, 0.3, 0.4, 0.5, 0.5, 0.5, 0.5, 0.5, 0.25],
    "raft 1 person":            [0.7, 1.3, 1.7, 2.3, 2.6, 2.7, 0.9, 1.8, 2.3, 3.1, 3.4, 3.7, 0.5, 0.25],
    "raft 4 person":            [0.7, 1.7, 2.2, 3.1, 3.5, 3.9, 1.0, 2.2, 3.0, 4.0, 4.6, 5.0, 0.5, 0.25],
    "raft 6 person":            [0.8, 1.9, 2.6, 3.6, 4.3, 4.7, 1.1, 2.5, 3.4, 4.7, 5.5, 6.0, 0.5, 0.25],
    "raft 8 person":            [0.8, 2.0, 2.7, 3.8, 4.4, 4.9, 1.1, 2.5, 3.5, 4.8, 5.7, 6.2, 0.5, 0.25],
    "raft 10 person":           [0.8, 2.0, 2.8, 4.0, 4.8, 5.3, 1.1, 2.6, 3.6, 5.1, 6.1, 6.7, 0.5, 0.25],
    "raft 15 person":           [0.9, 2.2, 3.0, 4.3, 5.1, 5.7, 1.1, 2.8, 3.8, 5.5, 6.5, 7.2, 0.5, 0.25],
    "raft 20 person":           [0.9, 2.3, 3.3, 4.9, 5.8, 6.5, 1.2, 3.0, 4.1, 6.1, 7.3, 8.1, 0.5, 0.25],
    "raft 25 person":           [0.9, 2.4, 3.5, 5.2, 6.3, 7.0, 1.2, 3.1, 4.3, 6.4, 7.8, 8.7, 0.5, 0.25],
    "power boat <15'":          [0.4, 0.8, 1.1, 1.5, 1.6, 1.8, 0.5, 1.1, 1.4, 1.9, 2.1, 2.3, 0.5, 0.25],
    "power boat 15'-25'":       [0.8, 1.5, 2.2, 3.3, 4.0, 4.5, 1.0, 2.0, 2.9, 4.3, 5.2, 5.8, 0.5, 0.25],
    "power boat 25'-40'":       [0.8, 1.9, 2.9, 4.7, 5.9, 6.8, 1.1, 2.5, 3.8, 6.1, 7.7, 8.8, 0.9, 0.9],
    "power boat 40'-65'":       [0.9, 2.4, 3.9, 7.0, 9.3, 11.1, 1.2, 3.1, 5.1, 9.1, 12.1, 14.4, 0.9, 0.9],
    "power boat 65'-90'":       [0.9, 2.5, 4.3, 8.3, 11.4, 14.0, 1.2, 3.2, 5.6, 10.7, 14.7, 18.1, 0.9, 0.9],
    "sail boat 15'":            [0.8, 1.5, 2.1, 3.0, 3.6, 4.0, 1.0, 1.9, 2.7, 3.9, 4.7, 5.2, 0.5, 0.25],
    "sail boat 20'":            [0.8, 1.7, 2.5, 3.7, 4.6, 5.1, 1.0, 2.2, 3.2, 4.8, 5.9, 6.6, 0.5, 0.25],
    "sail boat 25'":            [0.9, 1.9, 2.8, 4.4, 5.4, 6.3, 1.1, 2.4, 3.6, 5.7, 7.0, 8.1, 0.5, 0.25],
    "sail boat 30'":            [0.9, 2.1, 3.2, 5.3, 6.6, 7.7, 1.1, 2.7, 4.1, 6.8, 8.6, 10.0, 0.9, 0.9],
    "sail boat 40'":            [0.9, 2.3, 3.8, 6.6, 8.6, 10.3, 1.2, 3.0, 4.9, 8.5, 11.2, 13.3, 0.9, 0.9],
    "sail boat 50'":            [0.9, 2.4, 4.0, 7.3, 9.7, 11.6, 1.2, 3.1, 5.2, 9.4, 12.5, 15.0, 0.9, 0.9],
    "sail boat 65'-75'":        [0.9, 2.5, 4.2, 7.9, 10.7, 13.1, 1.2, 3.2, 5.5, 10.2, 13.9, 16.9, 0.9, 0.9],
    "sail boat 75'-90'":        [0.9, 2.5, 4.4, 8.3, 11.6, 14.2, 1.2, 3.3, 5.7, 10.8, 15.0, 18.4, 0.9, 0.9],
}

# Visibility columns (NM) — index 0-5 for eye 8', index 6-11 for eye 14'
_VIS_COLS = [1, 3, 5, 10, 15, 20]

# Supported object categories for the frontend dropdown
SWEEP_OBJECTS = list(_TABLE.keys())

FATIGUE_FACTOR = 0.9  # Matches Peter's VBA workbook (SweepWidth.frm FatigueYes_Click)


def _interpolate_visibility(row_vals: list, vis: float) -> float:
    """Linear interpolation between the two bracketing visibility columns."""
    cols = _VIS_COLS
    if vis <= cols[0]:
        return row_vals[0]
    if vis >= cols[-1]:
        return row_vals[-1]
    for i in range(len(cols) - 1):
        if cols[i] <= vis <= cols[i + 1]:
            t = (vis - cols[i]) / (cols[i + 1] - cols[i])
            return row_vals[i] + t * (row_vals[i + 1] - row_vals[i])
    return row_vals[-1]


def calculate_sweep_width(
    object_name: str,
    visibility_nm: float,
    height_of_eye: str,   # '8' or '14'
    wind_speed_kts: float,
    sea_state: str,        # 'calm' | 'moderate' | 'rough'
    fatigued: bool,
    num_assets: int,
) -> dict:
    """Calculate sweep width and track spacing.

    Returns a dict with:
      unadjusted_sw, weather_factor, fatigue_factor,
      adjusted_sw, track_spacing, num_assets
    """
    key = object_name.lower().strip()
    if key not in _TABLE:
        raise ValueError(f"Unknown object: {object_name!r}. "
                         f"Available: {list(_TABLE.keys())}")

    row = _TABLE[key]

    # Select eye-height columns (0-5 for 8', 6-11 for 14')
    if str(height_of_eye) == '14':
        vis_vals = row[6:12]
    else:
        vis_vals = row[0:6]

    unadjusted = round(_interpolate_visibility(vis_vals, visibility_nm), 3)

    # Weather correction: index 12 = winds>15kts/seas2-3ft, index 13 = winds>25kts/seas>4ft
    # sea_state directly maps to the three radio button options in the UI
    if sea_state == 'rough':
        weather_factor = row[13]
    elif sea_state == 'moderate':
        weather_factor = row[12]
    else:
        weather_factor = 1.0

    adjusted = round(unadjusted * weather_factor, 3)

    fatigue_f = FATIGUE_FACTOR if fatigued else 1.0
    adjusted = round(adjusted * fatigue_f, 3)

    track_spacing = round(adjusted * max(1, num_assets), 3)

    return {
        "unadjusted_sw": unadjusted,
        "weather_factor": weather_factor,
        "fatigue_factor": fatigue_f,
        "adjusted_sw": adjusted,
        "track_spacing": track_spacing,
        "num_assets": num_assets,
    }
