from domain.model import Coordinate
from datetime import datetime


def generate_gpx(positions: list[tuple[Coordinate, datetime]], name: str) -> str:
    """
    Generate a GPX (GPS Exchange Format) file as a string from a list of positions.

    Args:
        positions: List of tuples, each containing (Coordinate object, datetime).
        name: Name of the track (appears in the GPX file).

    Returns:
        A string containing the complete GPX XML document.
    """

    # Start with an empty list to collect lines of the GPX file
    gpx = []
    # XML declaration (required)
    gpx.append('<?xml version="1.0" encoding="UTF-8"?>')
    # Root element with GPX version 1.1, creator info, and namespace
    gpx.append('<gpx version="1.1" creator="Drift Simulator" xmlns="http://www.topografix.com/GPX/1/1">')

    # add track
    gpx.append(f"<trk>")
    gpx.append(f"<name>{name}</name>")

    # Track segment (<trkseg>) – contains the actual track points
    gpx.append("<trkseg>")

    # Loop over each position (coordinate + datetime)
    # Times are NZ local (matches Peter's Excel and the tide DB) — no Z suffix.
    for coord, dt in positions:
        time_str = dt.strftime("%Y-%m-%dT%H:%M:%S")
        # Start a track point with latitude and longitude attributes
        gpx.append(f'<trkpt lat="{coord.lat}" lon="{coord.lon}">')
        # Add the time element inside the track point
        gpx.append(f'  <time>{time_str}</time>')
        # Close the track point
        gpx.append("</trkpt>")

    gpx.append("</trkseg>")
    gpx.append("</trk>")
    gpx.append("</gpx>")

    # Join all lines with newline characters to form the final XML string
    return "\n".join(gpx)


# This function allows us to create a GPX file with multiple tracks in a single file.
def generate_gpx_multi(tracks: list[tuple[str, list[tuple[Coordinate, datetime]]]], name_prefix: str) -> str:
    """
    Generate a GPX file that contains multiple tracks (e.g., normal, positive divergence, negative divergence).

    Args:
        tracks: A list where each item is (track_name, list_of_(Coordinate, datetime))
        name_prefix: The base name for the tracks (e.g., "SAR Drift Prediction")

    Returns:
        A complete GPX XML string.
    """
    gpx = []

    gpx.append('<?xml version="1.0" encoding="UTF-8"?>')
    gpx.append('<gpx version="1.1" creator="Drift Simulator" xmlns="http://www.topografix.com/GPX/1/1">')

    # Loop through each track (normal, pos_div, neg_div)
    for track_name, points in tracks:
        gpx.append("<trk>")
        gpx.append(f"<name>{name_prefix} - {track_name}</name>")
        gpx.append("<trkseg>")

        # Add each point with its timestamp
        for coord, dt in points:
            time_str = dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            gpx.append(f'<trkpt lat="{coord.lat}" lon="{coord.lon}">')
            gpx.append(f'  <time>{time_str}</time>')
            gpx.append("</trkpt>")

        gpx.append("</trkseg>")
        gpx.append("</trk>")

    gpx.append("</gpx>")
    return "\n".join(gpx)





