import urllib.request
import json
from datetime import datetime


def get_wind(lat: float, lon: float, time_str: str) -> dict:
    """Fetch wind speed and direction from Open-Meteo for a given location and time.

    Args:
        lat: Latitude
        lon: Longitude
        time_str: ISO datetime string e.g. "2026-05-08T14:00:00"

    Returns:
        dict with keys: wind_speed_kts, wind_direction_deg, time_used
    """
    # Parse the requested time to find the matching hourly slot
    try:
        requested_dt = datetime.fromisoformat(time_str[:16])  # trim seconds
    except ValueError:
        requested_dt = datetime.now()

    date_str = requested_dt.strftime('%Y-%m-%d')

    url = (
        f"https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat}&longitude={lon}"
        f"&hourly=wind_speed_10m,wind_direction_10m"
        f"&wind_speed_unit=kn"
        f"&start_date={date_str}&end_date={date_str}"
        f"&timezone=UTC"
    )

    req = urllib.request.Request(url, headers={'User-Agent': 'SARDatums/1.0'})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode())

    times = data['hourly']['time']
    speeds = data['hourly']['wind_speed_10m']
    directions = data['hourly']['wind_direction_10m']

    # Find the closest hourly slot to the requested time
    target = requested_dt.strftime('%Y-%m-%dT%H:00')
    best_idx = 0
    for i, t in enumerate(times):
        if t <= target:
            best_idx = i

    return {
        'wind_speed_kts': round(speeds[best_idx], 1),
        'wind_direction_deg': round(directions[best_idx]),
        'time_used': times[best_idx],
    }
