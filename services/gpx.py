from domain.model import Coordinate

def generate_gpx(positions: list[Coordinate], name: str) -> str:
    gpx = []

    gpx.append('<?xml version="1.0" encoding="UTF-8"?>')
    gpx.append('<gpx version="1.1" creator="Drift Simulator" xmlns="http://www.topografix.com/GPX/1/1">')

    # add track
    gpx.append(f"<trk>")
    gpx.append(f"<name>{name}</name>")

    # add segment
    gpx.append("<trkseg>")

    # add point (lat,lon)
    for pos in positions:
        gpx.append(f'<trkpt lat="{pos.lat}" lon="{pos.lon}"></trkpt>')


    gpx.append("</trkseg>")
    gpx.append("</trk>")
    gpx.append("</gpx>")

    return "\n".join(gpx)





