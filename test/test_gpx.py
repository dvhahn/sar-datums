import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from domain.model import Coordinate     # Our coordinate class (lat/lon)
from datetime import datetime           # For timestamps on each position
from services.gpx import generate_gpx   # Our GPX generation function

# Create a list of sample positions for testing the GPX exporter.
# Each element is a tuple: (Coordinate object, datetime object)
# These represent the predicted drift path at specific times.
positions = [
    (Coordinate(-36.783007, 174.796026), datetime(2025, 3, 15, 12, 54, 0)),
    (Coordinate(-36.782616, 174.796026), datetime(2025, 3, 15, 13, 0, 0)),
    (Coordinate(-36.782200, 174.795800), datetime(2025, 3, 15, 13, 6, 0))
]

# Generate the GPX XML string by calling our exporter.
# 'positions' contains the track points; "Test Drift Track" is the name of the track.
gpx_string = generate_gpx(positions, "Test Drift Track")

# Write the GPX string to a file named 'output.gpx' in the current working directory.
with open("output.gpx", "w", encoding="utf-8") as f:
    f.write(gpx_string)

print("GPX file saved as output.gpx")