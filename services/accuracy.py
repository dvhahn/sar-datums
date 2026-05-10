import math
import xml.etree.ElementTree as ET
from domain.model import Coordinate

METRES_PER_NAUTICAL_MILE = 1852
GPX_NS = 'http://www.topografix.com/GPX/1/1'


def parse_gpx_coords(gpx_content: str) -> list[Coordinate]:
    """Parse track points from a GPX XML string. Supports both <trkpt> and <rtept>. Returns list of Coordinate."""
    root = ET.fromstring(gpx_content)
    coords = []

    # Try track points first (<trk><trkseg><trkpt>)

    for trkpt in root.findall(f'.//{{{GPX_NS}}}trkpt'):
        lat = float(trkpt.attrib['lat'])
        lon = float(trkpt.attrib['lon'])
        coords.append(Coordinate(lat, lon))

    # If no track points found, try route points (<rte><rtept>)
    if not coords:
        for rtept in root.findall(f'.//{{{GPX_NS}}}rtept'):
            lat = float(rtept.attrib['lat'])
            lon = float(rtept.attrib['lon'])
            coords.append(Coordinate(lat, lon))

    return coords


def haversine_metres(a: Coordinate, b: Coordinate) -> float:
    """Great-circle distance in metres between two coordinates."""
    lat1, lon1 = math.radians(a.lat), math.radians(a.lon)
    lat2, lon2 = math.radians(b.lat), math.radians(b.lon)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def compare_tracks(our_coords: list[Coordinate], ref_coords: list[Coordinate]) -> dict:
    """
    Compare two drift tracks point-by-point.

    Pairs points by index up to the length of the shorter track.
    Returns a summary dict with per-point distances and aggregate stats.
    """
    paired = min(len(our_coords), len(ref_coords))
    distances_m = [
        haversine_metres(our_coords[i], ref_coords[i])
        for i in range(paired)
    ]

    if not distances_m:
        return {
            "paired_points": 0,
            "our_total_points": len(our_coords),
            "ref_total_points": len(ref_coords),
            "max_error_m": None,
            "mean_error_m": None,
            "final_error_m": None,
            "final_error_nm": None,
            "accuracy_pct": None,
            "ref_track_length_m": None,
            "points": []
        }

    final_error_m = haversine_metres(our_coords[paired - 1], ref_coords[paired - 1])

    # Total track length of the reference track (sum of segment distances)
    ref_track_length_m = sum(
        haversine_metres(ref_coords[i], ref_coords[i + 1])
        for i in range(paired - 1)
    )

    # Accuracy % = how close the final point is relative to total track length
    # 100% means perfect match, lower means more deviation
    if ref_track_length_m > 0:
        accuracy_pct = max(0.0, 100.0 - (final_error_m / ref_track_length_m * 100))
    else:
        accuracy_pct = 100.0 if final_error_m == 0 else 0.0

    return {
        "paired_points": paired,
        "our_total_points": len(our_coords),
        "ref_total_points": len(ref_coords),
        "max_error_m": round(max(distances_m), 2),
        "mean_error_m": round(sum(distances_m) / len(distances_m), 2),
        "final_error_m": round(final_error_m, 2),
        "final_error_nm": round(final_error_m / METRES_PER_NAUTICAL_MILE, 4),
        "accuracy_pct": round(accuracy_pct, 2),
        "ref_track_length_m": round(ref_track_length_m, 2),
        "points": [
            {
                "index": i,
                "our_lat": round(our_coords[i].lat, 6),
                "our_lon": round(our_coords[i].lon, 6),
                "ref_lat": round(ref_coords[i].lat, 6),
                "ref_lon": round(ref_coords[i].lon, 6),
                "error_m": round(distances_m[i], 2)
            }
            for i in range(paired)
        ]
    }
