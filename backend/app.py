"""
Search and Rescue (SAR) Tidal Drift Datums - Flask Backend
Provides /api/drift endpoint to calculate drift positions.
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime
import math

app = Flask(__name__)
CORS(app)  # Allow cross-origin requests from any frontend


# ---------------------------------------------------------------------------
# Helper: simple kinematic drift model
# ---------------------------------------------------------------------------

def calculate_drift(lat: float, lon: float,
                    start_time: str, end_time: str,
                    wind_speed: float, wind_direction: float,
                    object_id: int) -> dict:
    """
    Estimate the drifted position of an object.

    This is a simplified leeway / wind-driven drift model:
      - Duration is computed from start_time → end_time (hours).
      - Drift speed  = wind_speed × leeway_factor  (fraction that depends on object type).
      - Drift bearing = wind_direction (downwind drift).
      - New position is computed using the Haversine inverse formula.

    Parameters
    ----------
    lat, lon        : Initial position (decimal degrees, WGS-84).
    start_time      : ISO-8601 string, e.g. "2025-03-15T10:00:00".
    end_time        : ISO-8601 string.
    wind_speed      : Wind speed in knots.
    wind_direction  : Wind direction in degrees (direction wind is blowing *from*).
    object_id       : Object type identifier (1-5 currently supported).

    Returns
    -------
    dict with drift result fields.
    """

    # --- 1. Parse times ---
    fmt = "%Y-%m-%dT%H:%M:%S"
    t0 = datetime.strptime(start_time, fmt)
    t1 = datetime.strptime(end_time,   fmt)
    duration_hours = (t1 - t0).total_seconds() / 3600.0

    if duration_hours <= 0:
        raise ValueError("end_time must be after start_time")

    # --- 2. Object leeway factors (approximate) ---
    leeway_factors = {
        1: 0.035,   # Person in water
        2: 0.04,    # Life raft (no ballast)
        3: 0.025,   # Disabled motorboat
        4: 0.05,    # Sailboat (hull down)
        5: 0.03,    # Debris / container
    }
    leeway = leeway_factors.get(object_id, 0.035)  # default: person in water

    # --- 3. Compute drift distance (nautical miles → degrees) ---
    drift_speed_kts = wind_speed * leeway          # knots
    drift_distance_nm = drift_speed_kts * duration_hours
    drift_distance_km = drift_distance_nm * 1.852

    # Wind blows FROM wind_direction, object drifts DOWNWIND (opposite)
    bearing_deg = (wind_direction + 180.0) % 360.0
    bearing_rad = math.radians(bearing_deg)

    # --- 4. New position via spherical Earth ---
    R_km = 6371.0
    d_over_R = drift_distance_km / R_km

    lat_rad = math.radians(lat)
    lon_rad = math.radians(lon)

    new_lat_rad = math.asin(
        math.sin(lat_rad) * math.cos(d_over_R) +
        math.cos(lat_rad) * math.sin(d_over_R) * math.cos(bearing_rad)
    )
    new_lon_rad = lon_rad + math.atan2(
        math.sin(bearing_rad) * math.sin(d_over_R) * math.cos(lat_rad),
        math.cos(d_over_R) - math.sin(lat_rad) * math.sin(new_lat_rad)
    )

    new_lat = round(math.degrees(new_lat_rad), 6)
    new_lon = round(math.degrees(new_lon_rad), 6)

    # --- 5. Build search area (simple circle radius in nm) ---
    # Uncertainty grows with time; use ±20% as a rough estimate
    search_radius_nm = round(drift_distance_nm * 0.20, 2)

    object_names = {
        1: "Person in Water",
        2: "Life Raft (no ballast)",
        3: "Disabled Motorboat",
        4: "Sailboat (hull down)",
        5: "Debris / Container",
    }

    return {
        "input": {
            "lat": lat,
            "lon": lon,
            "start_time": start_time,
            "end_time": end_time,
            "wind_speed_kts": wind_speed,
            "wind_direction_deg": wind_direction,
            "object_id": object_id,
            "object_type": object_names.get(object_id, "Unknown"),
        },
        "drift": {
            "datum_lat": new_lat,
            "datum_lon": new_lon,
            "drift_distance_nm": round(drift_distance_nm, 3),
            "drift_distance_km": round(drift_distance_km, 3),
            "drift_speed_kts": round(drift_speed_kts, 3),
            "drift_bearing_deg": round(bearing_deg, 1),
            "duration_hours": round(duration_hours, 2),
            "leeway_factor": leeway,
        },
        "search_area": {
            "center_lat": new_lat,
            "center_lon": new_lon,
            "radius_nm": search_radius_nm,
        },
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/", methods=["GET"])
def index():
    return jsonify({
        "service": "SAR Tidal Drift Datums API",
        "version": "1.0.0",
        "endpoints": {
            "POST /api/drift": "Calculate drift datum position",
            "GET  /api/objects": "List supported object types",
            "GET  /api/health": "Health check",
        }
    })


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "timestamp": datetime.utcnow().isoformat() + "Z"})


@app.route("/api/objects", methods=["GET"])
def get_objects():
    """Return the list of supported object types."""
    objects = [
        {"id": 1, "name": "Person in Water",        "leeway_factor": 0.035},
        {"id": 2, "name": "Life Raft (no ballast)", "leeway_factor": 0.040},
        {"id": 3, "name": "Disabled Motorboat",     "leeway_factor": 0.025},
        {"id": 4, "name": "Sailboat (hull down)",   "leeway_factor": 0.050},
        {"id": 5, "name": "Debris / Container",     "leeway_factor": 0.030},
    ]
    return jsonify({"objects": objects})


@app.route("/api/drift", methods=["POST"])
def drift():
    """
    Calculate the drift datum for a given object and weather conditions.

    Expected JSON body:
    {
        "lat": -36.8,
        "lon": 174.8,
        "start_time": "2025-03-15T10:00:00",
        "end_time":   "2025-03-15T13:00:00",
        "wind_speed":     15,
        "wind_direction": 180,
        "object_id":      1
    }
    """
    data = request.get_json(silent=True)

    if not data:
        return jsonify({"error": "Request body must be valid JSON"}), 400

    # --- Validate required fields ---
    required = ["lat", "lon", "start_time", "end_time",
                "wind_speed", "wind_direction", "object_id"]
    missing = [f for f in required if f not in data]
    if missing:
        return jsonify({"error": f"Missing required fields: {missing}"}), 400

    # --- Type coercion & range checks ---
    try:
        lat            = float(data["lat"])
        lon            = float(data["lon"])
        wind_speed     = float(data["wind_speed"])
        wind_direction = float(data["wind_direction"])
        object_id      = int(data["object_id"])
        start_time     = str(data["start_time"])
        end_time       = str(data["end_time"])
    except (ValueError, TypeError) as exc:
        return jsonify({"error": f"Invalid field type: {exc}"}), 400

    if not (-90 <= lat <= 90):
        return jsonify({"error": "lat must be between -90 and 90"}), 400
    if not (-180 <= lon <= 180):
        return jsonify({"error": "lon must be between -180 and 180"}), 400
    if wind_speed < 0:
        return jsonify({"error": "wind_speed must be >= 0"}), 400
    if not (0 <= wind_direction < 360):
        return jsonify({"error": "wind_direction must be 0–359 degrees"}), 400

    # --- Run calculation ---
    try:
        result = calculate_drift(
            lat, lon, start_time, end_time,
            wind_speed, wind_direction, object_id
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"Calculation error: {exc}"}), 500

    return jsonify(result), 200


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=" * 60)
    print("  SAR Tidal Drift Datums - Flask Backend")
    print("  Running at: http://localhost:5000")
    print("=" * 60)
    app.run(debug=True, host="0.0.0.0", port=5000)
