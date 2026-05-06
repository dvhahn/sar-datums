"""
Quick test for the drift calculation pipeline.
Run from project root: python test_drift.py
"""
from datetime import datetime
from domain.model import Coordinate, Wind, SearchObject
from services.drift import calculate_drift

# Test inputs: someone falls in the Hauraki Gulf
start = Coordinate(lat=-36.8, lon=174.8)
start_time = datetime(2025, 3, 15, 10, 0)  # 15 March 2025, 10:00 AM
end_time = datetime(2025, 3, 15, 13, 0)    # 3 hours later

wind = Wind(speed=15, direction_deg=180)    # 15 knots from the south

# Person in water (example coefficients)
person = SearchObject(object_id=1, name="Person in Water", coefficient_a=0.011, coefficient_b=0.07)

print("Starting drift calculation...")
print(f"  Start: {start}")
print(f"  Time:  {start_time} -> {end_time}")
print(f"  Wind:  {wind}")
print(f"  Object: {person}")
print()

positions, timestamps = calculate_drift(start, start_time, end_time, wind, person)

print(f"Result: {len(positions)} positions")
print()
for pos, dt in zip(positions, timestamps):
    elapsed_hr = (dt - start_time).total_seconds() / 3600.0
    print(f"  t={elapsed_hr:5.3f}h ({dt:%H:%M:%S})  lat={pos.lat:.6f}  lon={pos.lon:.6f}")
print()
print(f"Final position: lat={positions[-1].lat:.6f}  lon={positions[-1].lon:.6f}")
