class Coordinate:
    def __init__(self, lat: float, lon: float):
        self.lat = lat
        self.lon = lon

    @property
    def lat(self):
        return self._lat
    
    @property
    def lon(self):
        return self._lon

    @lat.setter
    def lat(self, value: float):
        if not -90 <= value <= 90:
            raise ValueError("Latitude must be between -90 and 90 degrees")
        self._lat = value

    @lon.setter
    def lon(self, value: float):
        if not -180 <= value <= 180:
            raise ValueError("Longitude must be between -180 and 180 degrees")
        self._lon = value

    def __repr__(self):
        return f"Coordinate(lat={self.lat}, long={self.lon})"
    

class Wind:
    def __init__(self, speed: float, direction_deg: float):
        self.speed = speed
        self.direction_deg = direction_deg

    @property
    def speed(self):
        return self._speed

    @speed.setter
    def speed(self, value):
        if value < 0:
            raise ValueError(f"Wind speed cannot be negative: {value}")
        self._speed = value

    @property
    def direction_deg(self):
        return self._direction_deg

    @direction_deg.setter
    def direction_deg(self, value: float):
        if not 0 <= value < 360:
            raise ValueError("Direction must be between 0 and 360 degrees")
        self._direction_deg = value

    def __repr__(self):
        return f"Wind(speed={self.speed}, direction_deg={self.direction_deg})"


class SearchObject:
    def __init__(self, object_id: int, name: str, coefficient_a: float, coefficient_b: float):
        self._id = object_id
        self._name = name
        self._coefficient_a = coefficient_a
        self._coefficient_b = coefficient_b

    @property
    def id(self):
        return self._id

    @property
    def name(self):
        return self._name

    @property
    def coefficient_a(self):
        return self._coefficient_a
    
    @property
    def coefficient_b(self):
        return self._coefficient_b

    def __repr__(self):
        return f"SearchObject(id={self.id}, name='{self._name}', a={self.coefficient_a}, b={self.coefficient_b})"

class CurrentVector:
    def __init__(self, vx: float, vy: float):
        self.vx = vx
        self.vy = vy

    @property
    def vx(self):
        return self._vx

    @vx.setter
    def vx(self, value: float):
        self._vx = value

    @property
    def vy(self):
        return self._vy

    @vy.setter
    def vy(self, value: float):
        self._vy = value

    def __repr__(self):
        return f"CurrentVector(vx={self.vx}, vy={self.vy})"
    
