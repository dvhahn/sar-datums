import math
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from datetime import datetime, timedelta
from domain.model import Coordinate, Wind, SearchObject
from services.drift import calculate_drift, get_currents_grid, get_last_divergence_tracks
from services.gpx import generate_gpx, generate_gpx_multi
from services.kml import generate_kml
import os
import psycopg2


def _get_db_connection():
    conn_params = {
        "dbname": os.getenv("DB_NAME", "sar_datums"),
        "host": os.getenv("DB_HOST", "localhost"),
        "port": os.getenv("DB_PORT", "5432"),
        "user": os.getenv("DB_USER", "postgres")
    }
    password = os.getenv("DB_PASSWORD")
    if password:
        conn_params["password"] = password
    return psycopg2.connect(**conn_params)


def load_search_objects():
    """Load search objects from the database."""
    conn = _get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, name, coefficient_a, coefficient_b, divergence_angle FROM object_types")
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return {row[0]: SearchObject(row[0], row[1], row[2], row[3], row[4]) for row in rows}


app = Flask(__name__, static_folder='ui_ux', static_url_path='')
CORS(app)  # Allow cross-origin requests from any frontend

SEARCH_OBJECTS = load_search_objects()

METRES_PER_NAUTICAL_MILE = 1852


def _calculate_distance_nm(start: Coordinate, end: Coordinate) -> float:
    """Approximate great-circle distance in nautical miles."""
    lat1 = math.radians(start.lat)
    lon1 = math.radians(start.lon)
    lat2 = math.radians(end.lat)
    lon2 = math.radians(end.lon)

    dlat = lat2 - lat1
    dlon = lon2 - lon1

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return (6371000 * c) / METRES_PER_NAUTICAL_MILE


SATELLITE_BEARINGS = (0, 45, 90, 135, 180, 225, 270, 315)


def _offset_position(start: Coordinate, distance_nm: float, bearing_deg: float) -> Coordinate:
    """Coordinate at a given distance and bearing from a start point.
    Mirrors the Excel VBA flat-earth approximation in Datums.VADatums:
        dLat = sin(45°) * radius (deg) ;  dLon = dLat / cos(lat)
    Generalised here to any bearing.
    """
    radius_deg = distance_nm / 60.0
    lat_rad = math.radians(start.lat)
    bearing_rad = math.radians(bearing_deg)

    dlat = math.cos(bearing_rad) * radius_deg
    dlon = math.sin(bearing_rad) * radius_deg / math.cos(lat_rad)
    return Coordinate(start.lat + dlat, start.lon + dlon)


def _calculate_bearing(start: Coordinate, end: Coordinate) -> float:
    """Calculate initial bearing from start to end."""
    lat1 = math.radians(start.lat)
    lat2 = math.radians(end.lat)
    dlon = math.radians(end.lon - start.lon)

    x = math.sin(dlon) * math.cos(lat2)
    y = (
        math.cos(lat1) * math.sin(lat2)
        - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    )
    return (math.degrees(math.atan2(x, y)) + 360) % 360


@app.route('/')
def home():
    return app.send_static_file('index.html')


@app.route('/api')
def api_home():
    return {"message": "SAR Datums API is running"}


@app.route('/api/drift', methods=['POST'])
def drift():
    data = request.get_json()

    try:
        start_pos = Coordinate(lat=data['lat'], lon=data['lon'])
        start_time = datetime.fromisoformat(data['start_time'])
        end_time = datetime.fromisoformat(data['end_time'])
        wind = Wind(speed=data['wind_speed'], direction_deg=data['wind_direction'])
        search_object = SEARCH_OBJECTS.get(data.get('object_id', 1))
        is_reverse = data.get('is_reverse', False)
        multiple_tracks = data.get('multiple_tracks', False)
        radius_nm = float(data.get('radius_nm', 0.2))
        wind_divergence = data.get('wind_divergence', False)
        divergence_angle = data.get('divergence_angle')

        if search_object is None:
            return jsonify({"error": "Invalid object_id"}), 400

    except (KeyError, ValueError) as e:
        return jsonify({"error": f"Invalid input: {str(e)}"}), 400

    positions = calculate_drift(
        start_pos,
        start_time,
        end_time,
        wind,
        search_object,
        is_reverse=is_reverse,
        wind_divergence=wind_divergence,
        divergence_angle_override=divergence_angle
    )

    satellites = []
    if multiple_tracks:
        for bearing in SATELLITE_BEARINGS:
            sat_start = _offset_position(start_pos, radius_nm, bearing)
            sat_positions = calculate_drift(
                sat_start, start_time, end_time, wind, search_object,
                is_reverse=is_reverse,
            )
            satellites.append([
                {"lat": round(p.lat, 6), "lon": round(p.lon, 6)}
                for p in sat_positions
            ])

    # Build response
    result_positions = []
    gpx_normal_points = []  # (Coordinate, datetime) for normal
    timestamps = []         # list of date times for divergence tracks
    # If reverse, move BACKWARDS in time (360s = 0.1h)
    # Use timedelta on the naive datetime directly — going through .timestamp()
    # would leak the server's local timezone into the result.
    step_seconds = -360 if is_reverse else 360

    for i, pos in enumerate(positions):
        dt = start_time + timedelta(seconds=i * step_seconds)
        timestamps.append(dt)
        result_positions.append({
            "lat": round(pos.lat, 6),
            "lon": round(pos.lon, 6),
            "time": dt.isoformat()
        })
        gpx_normal_points.append((pos, dt))

    # Divergence tracks (if enabled)
    pos_div_positions = None
    neg_div_positions = None
    div_tracks = get_last_divergence_tracks()
    if div_tracks and wind_divergence:
        pos_div_positions = []
        neg_div_positions = []
        for i in range(len(div_tracks['pos_div'])):
            dt = timestamps[i] if i < len(timestamps) else start_time + timedelta(seconds=i * step_seconds)
            pos_div_positions.append({
                "lat": round(div_tracks['pos_div'][i].lat, 6),
                "lon": round(div_tracks['pos_div'][i].lon, 6),
                "time": dt.isoformat()
            })
            neg_div_positions.append({
                "lat": round(div_tracks['neg_div'][i].lat, 6),
                "lon": round(div_tracks['neg_div'][i].lon, 6),
                "time": dt.isoformat()
            })

    # Generate GPX (multi‑track if divergence, else single) and KML (normal track only)
    if div_tracks and wind_divergence:
        pos_points = [(div_tracks['pos_div'][i], timestamps[i]) for i in range(len(div_tracks['pos_div']))]
        neg_points = [(div_tracks['neg_div'][i], timestamps[i]) for i in range(len(div_tracks['neg_div']))]
        all_tracks = [
            ("Normal", gpx_normal_points),
            ("Positive Divergence", pos_points),
            ("Negative Divergence", neg_points)
        ]
        gpx_content = generate_gpx_multi(all_tracks, "SAR Drift Prediction")
    else:
        gpx_content = generate_gpx(gpx_normal_points, name="SAR Drift Prediction")

    app.config['last_gpx'] = gpx_content

    kml_content = generate_kml(gpx_normal_points, name="SAR Drift Prediction")
    app.config['last_kml'] = kml_content

    final_position = positions[-1]

    duration_hours = abs((end_time - start_time).total_seconds() / 3600)

    drift_distance_nm = _calculate_distance_nm(start_pos, final_position)
    drift_speed_kts = drift_distance_nm / duration_hours if duration_hours > 0 else 0.0
    drift_bearing_deg = _calculate_bearing(start_pos, final_position) if len(positions) > 1 else 0.0
    leeway_factor = search_object.coefficient_a if wind.speed > 5 else 0.0

    return jsonify({
        "positions": result_positions,
        "satellites": satellites,
        "pos_div_positions": pos_div_positions,
        "neg_div_positions": neg_div_positions,
        "gpx_url": "/api/gpx",
        "kml_url": "/api/kml",
        "summary": {
            "object_type": search_object.name,
            "is_reverse": is_reverse,  # Let the frontend know the mode
            "duration_hours": round(duration_hours, 2),
            "drift_distance_nm": round(drift_distance_nm, 3),
            "drift_speed_kts": round(drift_speed_kts, 3),
            "drift_bearing_deg": round(drift_bearing_deg, 1),
            "leeway_factor": round(leeway_factor, 3),
        }
    })


@app.route('/api/gpx')
def gpx():
    """Download the last generated GPX file."""
    gpx_content = app.config.get('last_gpx')

    if gpx_content is None:
        return jsonify({"error": "No GPX data available. Run /api/drift first."}), 404

    return Response(
        gpx_content,
        mimetype='application/gpx+xml',
        headers={'Content-Disposition': 'attachment; filename=drift_prediction.gpx'}
    )


@app.route('/api/kml')
def kml():
    """Download the last generated KML file."""
    kml_content = app.config.get('last_kml')

    if kml_content is None:
        return jsonify({"error": "No KML data available. Run /api/drift first."}), 404

    return Response(
        kml_content,
        mimetype='application/vnd.google-earth.kml+xml',
        headers={'Content-Disposition': 'attachment; filename=drift_prediction.kml'}
    )


@app.route('/api/currents')
def currents():
    """Sample tidal currents at a grid in the bounding box.
    Query params: bbox=lat_min,lat_max,lon_min,lon_max  &  time=ISO8601
    """
    bbox_str = request.args.get('bbox', '')
    time_str = request.args.get('time')
    try:
        parts = bbox_str.split(',')
        if len(parts) != 4:
            raise ValueError('bbox must be lat_min,lat_max,lon_min,lon_max')
        lat_min, lat_max, lon_min, lon_max = map(float, parts)
        if not time_str:
            raise ValueError('time parameter is required')
        sample_time = datetime.fromisoformat(time_str)
    except ValueError as e:
        return jsonify({"error": f"Invalid params: {str(e)}"}), 400

    arrows = get_currents_grid(sample_time, lat_min, lat_max, lon_min, lon_max)
    return jsonify({"arrows": arrows})


@app.route('/api/object-hierarchy')
def object_hierarchy():
    conn = _get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT id, name, parent_id
        FROM object_types
        ORDER BY display_order NULLS LAST
    """)
    rows = cur.fetchall()
    cur.close()
    conn.close()
    nodes = {row[0]: {"id": row[0], "name": row[1], "children": []} for row in rows}
    tree = []
    for row in rows:
        node = nodes[row[0]]
        if row[2] is None:
            tree.append(node)
        else:
            nodes[row[2]]["children"].append(node)
    return jsonify(tree)


if __name__ == '__main__':
    app.run(debug=True)
    
