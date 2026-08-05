-- KSPDB Automated Fault Localization Database Schema

DROP TABLE IF EXISTS tickets CASCADE;
DROP TABLE IF EXISTS faults CASCADE;
DROP TABLE IF EXISTS topology_edges CASCADE;
DROP TABLE IF EXISTS telemetry_events CASCADE;
DROP TABLE IF EXISTS scheduled_outages CASCADE;
DROP TABLE IF EXISTS poles CASCADE;
DROP TABLE IF EXISTS transformers CASCADE;

-- 1. Transformers
CREATE TABLE transformers (
    dt_id VARCHAR(64) PRIMARY KEY,
    feeder_id VARCHAR(64) NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    capacity_kva INT DEFAULT 250,
    households_served INT DEFAULT 100,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Poles
CREATE TABLE poles (
    pole_id VARCHAR(64) PRIMARY KEY,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    feeder_id VARCHAR(64) NOT NULL,
    dt_id VARCHAR(64) NOT NULL REFERENCES transformers(dt_id) ON DELETE CASCADE,
    seq_on_line INT,
    parent_pole_id VARCHAR(64),
    pole_type VARCHAR(64) DEFAULT 'LT-9m-PCC',
    ward VARCHAR(64),
    pincode VARCHAR(16),
    device_id VARCHAR(64),
    is_energized BOOLEAN DEFAULT TRUE,
    last_event_ts TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_poles_dt ON poles(dt_id);
CREATE INDEX idx_poles_feeder ON poles(feeder_id);
CREATE INDEX idx_poles_device ON poles(device_id);

-- 3. Telemetry Events
CREATE TABLE telemetry_events (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL,
    pole_id VARCHAR(64) NOT NULL REFERENCES poles(pole_id) ON DELETE CASCADE,
    event VARCHAR(32) NOT NULL,
    energized BOOLEAN NOT NULL,
    ts TIMESTAMP WITH TIME ZONE NOT NULL,
    seq BIGINT NOT NULL,
    battery_mv INT,
    rssi INT,
    fw VARCHAR(16),
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_device_seq UNIQUE(device_id, seq)
);

CREATE INDEX idx_telemetry_pole ON telemetry_events(pole_id);
CREATE INDEX idx_telemetry_ts ON telemetry_events(ts);

-- 4. Topology Edges
CREATE TABLE topology_edges (
    id SERIAL PRIMARY KEY,
    dt_id VARCHAR(64) NOT NULL REFERENCES transformers(dt_id) ON DELETE CASCADE,
    parent_pole_id VARCHAR(64) NOT NULL,
    child_pole_id VARCHAR(64) NOT NULL REFERENCES poles(pole_id) ON DELETE CASCADE,
    distance_meters DOUBLE PRECISION,
    source VARCHAR(16) NOT NULL CHECK (source IN ('explicit', 'inferred')),
    confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_dt_child UNIQUE(dt_id, child_pole_id)
);

CREATE INDEX idx_edges_dt ON topology_edges(dt_id);
CREATE INDEX idx_edges_parent ON topology_edges(parent_pole_id);

-- 5. Faults
CREATE TABLE faults (
    id SERIAL PRIMARY KEY,
    dt_id VARCHAR(64) NOT NULL,
    feeder_id VARCHAR(64) NOT NULL,
    fault_type VARCHAR(32) NOT NULL CHECK (fault_type IN ('SPAN', 'DT', 'FEEDER')),
    upstream_asset_id VARCHAR(64) NOT NULL,
    downstream_asset_id VARCHAR(64) NOT NULL,
    affected_pole_count INT NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    pincode VARCHAR(16),
    confidence DOUBLE PRECISION NOT NULL,
    topology_source VARCHAR(16) NOT NULL CHECK (topology_source IN ('explicit', 'inferred')),
    reason TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_faults_dt ON faults(dt_id);

-- 6. Tickets
CREATE TABLE tickets (
    id SERIAL PRIMARY KEY,
    fault_id INT NOT NULL REFERENCES faults(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL DEFAULT 'DETECTED' CHECK (status IN ('DETECTED', 'ACKNOWLEDGED', 'CREW_ASSIGNED', 'RESOLVED', 'VERIFIED', 'CLOSED')),
    assigned_crew VARCHAR(64),
    detected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    verified_at TIMESTAMP WITH TIME ZONE,
    closed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_tickets_status ON tickets(status);

-- 7. Scheduled Outages
CREATE TABLE scheduled_outages (
    id VARCHAR(64) PRIMARY KEY,
    scope VARCHAR(16) NOT NULL CHECK (scope IN ('feeder', 'dt')),
    target_id VARCHAR(64) NOT NULL,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE NOT NULL,
    reason TEXT
);
