from domain.model import Coordinate
from datetime import datetime
from xml.sax.saxutils import escape

# Identifies our app while crediting the source workbook. Visible in any
# chart plotter that surfaces the GPX creator attribute. The "&" gets
# escaped to "&amp;" at serialisation time so strict XML parsers stay happy
# — chart plotters render it back as "&".
_CREATOR = "Peter Comer (pci590@police.govt.nz) & UoA CS399 Team 19 Hammerklavier"

_GPX_OPEN = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    f'<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="{escape(_CREATOR)}" >'
)


def _peter_time(dt: datetime) -> str:
    """Peter's HHMM dd mmm yy NZ-local format, e.g. '0300 28 Apr 26'."""
    return dt.strftime("%H%M %d %b %y")


def generate_gpx(positions: list[tuple[Coordinate, datetime]], name: str) -> str:
    """Single drift track as a Peter-style ``<rte>``.

    Timestamps live inside each ``<rtept>``'s ``<name>`` so they appear as
    waypoint labels on chart plotters that don't render ISO ``<time>``.
    """
    lines = [_GPX_OPEN, "<rte>", f"<name>{name}</name>"]

    for coord, dt in positions:
        label = _peter_time(dt)
        lines.append(
            f'<rtept lat="{coord.lat}" lon="{coord.lon}" >'
            f'<name>{label}</name><sym></sym></rtept>'
        )

    lines.append("</rte>")
    lines.append("</gpx>")
    return "\n".join(lines)


def generate_gpx_multi(
    tracks: list[tuple[str, list[tuple[Coordinate, datetime]]]],
    name_prefix: str,
) -> str:
    """Multiple drift tracks as Peter-style ``<trk>`` blocks.

    Each track gets a red 2px solid-line ``<extensions>`` block (the same
    style Peter writes for divergence/spread tracks). ``<trkpt>`` keeps an
    ISO ``<time>`` so divergence runs remain replayable; Peter leaves
    ``<time></time>`` empty because his spread tracks are time-less.
    """
    lines = [_GPX_OPEN]

    for track_name, points in tracks:
        lines.append("<trk>")
        lines.append(f"<name>{name_prefix} - {track_name}</name>")
        lines.append(
            '<extensions> <line xmlns="http://www.topografix.com/GPX/gpx_style/0/2">'
        )
        lines.append("<color>ff0000</color>")
        lines.append("<opacity>1.00</opacity>")
        lines.append("<width>2.00</width>")
        lines.append("<pattern>Solid</pattern>")
        lines.append("</line></extensions>")
        lines.append("<trkseg>")

        for coord, dt in points:
            iso = dt.strftime("%Y-%m-%dT%H:%M:%S")
            lines.append(
                f'<trkpt lat="{coord.lat}" lon="{coord.lon}" >'
                f'<time>{iso}</time></trkpt>'
            )

        lines.append("</trkseg>")
        lines.append("</trk>")

    lines.append("</gpx>")
    return "\n".join(lines)
