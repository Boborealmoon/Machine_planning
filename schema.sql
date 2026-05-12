-- Run once to set up supporting tables for the planning app.
-- The inventory_bom_listing table/view is assumed to already exist in your DB.

-- Tracks which bom_code is the default for each source_inventory_code
CREATE TABLE IF NOT EXISTS bom_defaults (
    source_inventory_code VARCHAR(200) PRIMARY KEY,
    default_bom_code      VARCHAR(200) NOT NULL,
    updated_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Stores optional metadata (flow name) for each source+bom combination
CREATE TABLE IF NOT EXISTS bom_metadata (
    source_inventory_code VARCHAR(200),
    bom_code              VARCHAR(200),
    flow_name             VARCHAR(200) DEFAULT '',
    PRIMARY KEY (source_inventory_code, bom_code)
);
