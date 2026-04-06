from flask import Flask, request, jsonify, Response
from datetime import datetime
from domain.model import Coordinate, Wind, SearchObject
from services.drift import calculate_drift
from services.gpx import generate_gpx

app = Flask(__name__)

# Search object types (from Peter's Excel - Setup sheet column N-O)
# Each object has wind drift coefficients (a, b)
SEARCH_OBJECTS = {
    1: SearchObject(1, "Person in Water", 0.011, 0.07),
    # TODO: Add more from Peter's data
}


@app.route('/')
def home():
    return {"message": "SAR Datums API is running"}


@app.route('/api/drift', methods=['POST'])
def drift():
    """Calculate drift trajectory.
    
    Expects JSON:
    {
        "lat": -36.8,
        "lon": 174.8,
        "start_time": "2025-03-15T10:00:00",
        "end_time": "2025-03-15T13:00:00",
        "wind_speed": 15,
        "wind_direction": 180,
        "object_id": 1
    }

    Returns JSON with positions list and GPX download URL.
    """
    data = request.get_json()

    # Parse inputs
    try:
        start_pos = Coordinate(lat=data['lat'], lon=data['lon'])
        start_time = datetime.fromisoformat(data['start_time'])
        end_time = datetime.fromisoformat(data['end_time'])
        wind = Wind(speed=data['wind_speed'], direction_deg=data['wind_direction'])
        search_object = SEARCH_OBJECTS.get(data.get('object_id', 1))

        if search_object is None:
            return jsonify({"error": "Invalid object_id"}), 400

    except (KeyError, ValueError) as e:
        return jsonify({"error": f"Invalid input: {str(e)}"}), 400

    # Run drift calculation
    positions = calculate_drift(start_pos, start_time, end_time, wind, search_object)

    # Build response
    result_positions = []
    for i, pos in enumerate(positions):
        t = start_time.timestamp() + (i * 360)  # 0.1h = 360 seconds
        result_positions.append({
            "lat": round(pos.lat, 6),
            "lon": round(pos.lon, 6),
            "time": datetime.fromtimestamp(t).isoformat()
        })

    # Generate GPX string and store temporarily
    gpx_content = generate_gpx(positions, name="SAR Drift Prediction")
    app.config['last_gpx'] = gpx_content

    return jsonify({
        "positions": result_positions,
        "gpx_url": "/api/gpx"
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


@app.route('/api/objects')
def objects():
    """List available search object types for the dropdown."""
    return jsonify([
        {"id": obj.id, "name": obj.name}
        for obj in SEARCH_OBJECTS.values()
    ])


if __name__ == '__main__':
    app.run(debug=True)
    