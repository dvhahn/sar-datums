from domain.model import Coordinate
from datetime import datetime

def generate_kml(positions: list[tuple[Coordinate, datetime]], name: str) -> str:
    """
    Generate a KML (Keyhole Markup Language) file as a string from a list of positions.
    KML is used by Google Earth and other mapping software.

    Args:
        positions: List of tuples, each containing (Coordinate object, datetime).
        name: Name of the track (appears in the KML file).

    Returns:
        A string containing the complete KML XML document.
    """

    # Start with an empty list to collect lines of the KML file
    kml = []

    # XML declaration (required)
    kml.append('<?xml version="1.0" encoding="UTF-8"?>')

    # Root element with KML namespace
    kml.append('<kml xmlns="http://www.opengis.net/kml/2.2">')
    kml.append('  <Document>')
    kml.append(f'    <name>{name}</name>')
    kml.append('    <description>SAR Drift Prediction Track</description>')

    # Style for the line
    kml.append('    <Style id="driftLineStyle">')
    kml.append('      <LineStyle>')
    kml.append('        <color>ff0000ff</color>')  # Red line (AABBGGRR format)
    kml.append('        <width>3</width>')
    kml.append('      </LineStyle>')
    kml.append('    </Style>')

    # Placemark for the drift path
    kml.append('    <Placemark>')
    kml.append(f'      <name>Drift Path</name>')
    kml.append('      <styleUrl>#driftLineStyle</styleUrl>')

    # LineString with coordinates
    kml.append('      <LineString>')
    kml.append('        <tessellate>1</tessellate>')
    kml.append('        <coordinates>')

    # KML format: lon,lat,altitude (note: longitude comes first!)
    for coord, dt in positions:
        kml.append(f'          {coord.lon},{coord.lat},0')

    kml.append('        </coordinates>')
    kml.append('      </LineString>')
    kml.append('    </Placemark>')

    # Add start and end point markers
    if len(positions) > 0:
        start_coord, start_time = positions[0]
        kml.append('    <Placemark>')
        kml.append('      <name>Start Point</name>')
        kml.append(f'      <description>Time: {start_time.isoformat()}</description>')
        kml.append('      <Point>')
        kml.append(f'        <coordinates>{start_coord.lon},{start_coord.lat},0</coordinates>')
        kml.append('      </Point>')
        kml.append('    </Placemark>')

        end_coord, end_time = positions[-1]
        kml.append('    <Placemark>')
        kml.append('      <name>End Point</name>')
        kml.append(f'      <description>Time: {end_time.isoformat()}</description>')
        kml.append('      <Point>')
        kml.append(f'        <coordinates>{end_coord.lon},{end_coord.lat},0</coordinates>')
        kml.append('      </Point>')
        kml.append('    </Placemark>')

    kml.append('  </Document>')
    kml.append('</kml>')

    # Join all lines with newline characters to form the final XML string
    return "\n".join(kml)
