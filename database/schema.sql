-- SAR Datums Database Schema
-- PostgreSQL + PostGIS

CREATE EXTENSION IF NOT EXISTS postgis;

-- ============================================================
-- Table 1: tidal_vectors
-- Source: Data sheet, columns G onwards (207,801 rows)
-- Stores current velocity (vx, vy) at each grid point
-- for each time step (0.0h to 12.5h) within a tidal cycle,
-- separated by tide type (neap/spring).
--
-- Original Excel uses a "wide table" format (one row per location,
-- ~252 columns of vx/vy pairs). We normalise this so each
-- (location, tide_type, time_step) combination is its own row.
-- This enables efficient PostGIS spatial queries.
-- ============================================================

CREATE TABLE tidal_vectors (
    id          SERIAL PRIMARY KEY,
    location    GEOGRAPHY(Point, 4326) NOT NULL,  -- PostGIS point (lon, lat)
    lat         DOUBLE PRECISION NOT NULL,
    lon         DOUBLE PRECISION NOT NULL,
    tide_type   VARCHAR(10) NOT NULL,             -- 'neap' or 'spring'
    time_step   REAL NOT NULL,                    -- 0.0, 0.1, 0.2 ... 12.5 (hours since high/low water)
    vx          DOUBLE PRECISION NOT NULL,        -- east-west velocity (m/s, positive = east)
    vy          DOUBLE PRECISION NOT NULL          -- north-south velocity (m/s, positive = north)
);

-- Spatial index for nearest-neighbour lookups
CREATE INDEX idx_tidal_vectors_location ON tidal_vectors USING GIST (location);

-- Composite index for filtering by tide type and time step
CREATE INDEX idx_tidal_vectors_lookup ON tidal_vectors (tide_type, time_step);


-- ============================================================
-- Table 2: tide_heights
-- Source: Data sheet, columns A-B (rows 44 to 5689)
-- Predicted high/low water times and heights for Auckland.
-- Updated annually with new tidal predictions.
-- ============================================================

CREATE TABLE tide_heights (
    id      SERIAL PRIMARY KEY,
    time    TIMESTAMP NOT NULL,
    height  DOUBLE PRECISION NOT NULL             -- metres above chart datum
);

CREATE INDEX idx_tide_heights_time ON tide_heights (time);


-- ============================================================
-- Table 3: config
-- Source: Data sheet, cells B9-B34 (metadata/reference values)
-- Reference tidal values used for spring/neap interpolation.
-- ============================================================

CREATE TABLE config (
    key     VARCHAR(100) PRIMARY KEY,
    value   DOUBLE PRECISION NOT NULL
);

-- Neap tidal reference values
INSERT INTO config (key, value) VALUES
    ('neap_hw_time',     0),       -- B9:  Neap Epoch HW (serial date, update later)
    ('neap_hw_height',   0.746),   -- B10: Height
    ('neap_lw_time',     0),       -- B11: Next Low Water
    ('neap_lw_height',  -0.640),   -- B12: Height
    ('neap_hw2_time',    0),       -- B13: Next High Water
    ('neap_hw2_height',  0.645),   -- B14: Height
    ('spring_hw_time',   0),       -- B16: Spring Epoch HW
    ('spring_hw_height', 1.337),   -- B17: Height
    ('spring_lw_time',   0),       -- B18: Next Low Water
    ('spring_lw_height',-1.392),   -- B19: Height
    ('spring_hw2_time',  0),       -- B20: Next High Water
    ('spring_hw2_height',1.376),   -- B21: Height
    ('neap_ebb_tide_range',   1.386),  -- B31
    ('neap_flood_tide_range', 1.285),  -- B32
    ('spring_ebb_tide_range', 2.729),  -- B33
    ('spring_flood_tide_range',2.768), -- B34
    ('msl', 1.93);                     -- B42: Mean Sea Level