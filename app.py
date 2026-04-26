import math
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from datetime import datetime
from domain.model import Coordinate, Wind, SearchObject
from services.drift import calculate_drift
from services.gpx import generate_gpx
from services.kml import generate_kml
from services.accuracy import parse_gpx_coords, compare_tracks

app = Flask(__name__, static_folder='ui_ux', static_url_path='')
CORS(app)  # Allow cross-origin requests from any frontend

# Search object types (from Peter's Excel - Setup sheet column N-O)
# Each object has wind drift coefficients (a, b)
SEARCH_OBJECTS = {
    1: SearchObject(1, "Person in Water", 0.011, 0.07),
    2: SearchObject(2, "PIW with PFD (Average)", 0.013, 0.07),
    3: SearchObject(3, "Life Raft - No ballast, No canopy, No drogue", 0.057, 0.21),
    4: SearchObject(4, "Person-Powered Craft - Surfboard w/ person", 0.02, 0),
    5: SearchObject(5, "55-gallon Oil Drum", 0.014, 0)

    # TODO: Add more from Peter's data
}

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
        is_reverse=is_reverse
    )

    # Build response
    result_positions = []
    gpx_points = []

    # If reverse, move BACKWARDS in time (360s = 0.1h)
    time_step_direction = -360 if is_reverse else 360

    for i, pos in enumerate(positions):
        t = start_time.timestamp() + (i * time_step_direction)
        dt = datetime.fromtimestamp(t)

        result_positions.append({
            "lat": round(pos.lat, 6),
            "lon": round(pos.lon, 6),
            "time": dt.isoformat()
        })
        gpx_points.append((pos, dt))

    # Generate GPX and KML
    gpx_content = generate_gpx(gpx_points, name="SAR Drift Prediction")
    kml_content = generate_kml(gpx_points, name="SAR Drift Prediction")
    app.config['last_gpx'] = gpx_content
    app.config['last_kml'] = kml_content

    final_position = positions[-1]

    duration_hours = abs((end_time - start_time).total_seconds() / 3600)

    drift_distance_nm = _calculate_distance_nm(start_pos, final_position)
    drift_speed_kts = drift_distance_nm / duration_hours if duration_hours > 0 else 0.0
    drift_bearing_deg = _calculate_bearing(start_pos, final_position) if len(positions) > 1 else 0.0
    leeway_factor = search_object.coefficient_a if wind.speed > 5 else 0.0

    return jsonify({
        "positions": result_positions,
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


@app.route('/api/objects')
def objects():
    """List available search object types for the dropdown."""
    return jsonify([
        {"id": obj.id, "name": obj.name}
        for obj in SEARCH_OBJECTS.values()
    ])


@app.route('/api/accuracy', methods=['POST'])
def accuracy():
    """Compare our drift result against a reference GPX file.

    Expects multipart/form-data:
      - file: the reference GPX file (from Excel/VBA)
      - lat, lon, start_time, end_time, wind_speed, wind_direction, object_id: same as /api/drift
    """
    try:
        ref_file = request.files.get('file')
        if ref_file is None:
            return jsonify({"error": "No reference GPX file uploaded."}), 400

        ref_gpx_content = ref_file.read().decode('utf-8')
        ref_coords = parse_gpx_coords(ref_gpx_content)
        if not ref_coords:
            return jsonify({"error": "Could not parse any track points from the uploaded GPX."}), 400

        start_pos = Coordinate(lat=float(request.form['lat']), lon=float(request.form['lon']))
        start_time = datetime.fromisoformat(request.form['start_time'])
        end_time = datetime.fromisoformat(request.form['end_time'])
        wind = Wind(speed=float(request.form['wind_speed']), direction_deg=float(request.form['wind_direction']))
        search_object = SEARCH_OBJECTS.get(int(request.form.get('object_id', 1)))

        if search_object is None:
            return jsonify({"error": "Invalid object_id"}), 400

    except (KeyError, ValueError) as e:
        return jsonify({"error": f"Invalid input: {str(e)}"}), 400

    our_positions = calculate_drift(start_pos, start_time, end_time, wind, search_object)
    our_coords = our_positions

    result = compare_tracks(our_coords, ref_coords)
    return jsonify(result)


if __name__ == '__main__':
    app.run(debug=True)
    
