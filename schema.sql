-- Run this once to set up the planning data tables

CREATE TABLE IF NOT EXISTS parts (
    id          SERIAL PRIMARY KEY,
    part_number VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flows (
    id         SERIAL PRIMARY KEY,
    part_id    INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    name       VARCHAR(100) NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flow_steps (
    id          SERIAL PRIMARY KEY,
    flow_id     INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    step_order  INTEGER NOT NULL DEFAULT 0,
    operation   VARCHAR(100),
    machine     VARCHAR(100),
    description TEXT,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flows_part_id       ON flows(part_id);
CREATE INDEX IF NOT EXISTS idx_flow_steps_flow_id  ON flow_steps(flow_id);
