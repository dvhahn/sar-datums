from domain.model import Coordinate
from datetime import datetime
from xml.sax.saxutils import escape

def generate_kml(positions: list[tuple[Coordinate, datetime]], name: str) -> str:
    """
    Generate a KML (Keyhole Markup Language) file as a string from a list of positions.
    KML is used by Google Earth and other mapping software.

    Uses <gx:Track> so each point carries a timestamp, making the track
    playable on the Google Earth time slider.

    Args:
        positions: List of tuples, each containing (Coordinate object, datetime).
        name: Name of the track (appears in the KML file).

    Returns:
        A string containing the complete KML XML document.
    """

    kml = []

    kml.append('<?xml version="1.0" encoding="UTF-8"?>')

    # gx namespace required for <gx:Track>
    kml.append('<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">')
    kml.append('  <Document>')
    kml.append(f'    <name>{escape(name)}</name>')
    kml.append('    <description>SAR Drift Prediction Track</description>')

    # Style for the line
    kml.append('    <Style id="driftLineStyle">')
    kml.append('      <LineStyle>')
    kml.append('        <color>ff0000ff</color>')  # Red line (AABBGGRR format)
    kml.append('        <width>3</width>')
    kml.append('      </LineStyle>')
    kml.append('    </Style>')

    # Time-aware track — each <when> pairs with the <gx:coord> at the same index
    kml.append('    <Placemark>')
    kml.append('      <name>Drift Path</name>')
    kml.append('      <styleUrl>#driftLineStyle</styleUrl>')
    kml.append('      <gx:Track>')

    for coord, dt in positions:
        kml.append(f'        <when>{dt.isoformat()}</when>')

    # KML coordinate order: lon lat altitude (space-separated inside gx:coord)
    for coord, dt in positions:
        kml.append(f'        <gx:coord>{coord.lon} {coord.lat} 0</gx:coord>')

    kml.append('      </gx:Track>')
    kml.append('    </Placemark>')

    # Start and end point markers
    if len(positions) > 0:
        start_coord, start_time = positions[0]
        kml.append('    <Placemark>')
        kml.append('      <name>Start Point</name>')
        kml.append(f'      <description>Time: {escape(start_time.isoformat())}</description>')
        kml.append('      <Point>')
        kml.append(f'        <coordinates>{start_coord.lon},{start_coord.lat},0</coordinates>')
        kml.append('      </Point>')
        kml.append('    </Placemark>')

        end_coord, end_time = positions[-1]
        kml.append('    <Placemark>')
        kml.append('      <name>End Point</name>')
        kml.append(f'      <description>Time: {escape(end_time.isoformat())}</description>')
        kml.append('      <Point>')
        kml.append(f'        <coordinates>{end_coord.lon},{end_coord.lat},0</coordinates>')
        kml.append('      </Point>')
        kml.append('    </Placemark>')

    kml.append('  </Document>')
    kml.append('</kml>')

    return "\n".join(kml)
