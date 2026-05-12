-- Run once to set up supporting tables for the planning app.
-- The inventory_bom_listing view is assumed to already exist in your DB.

-- Stores optional metadata (flow name) for each source+bom combination
CREATE TABLE IF NOT EXISTS bom_metadata (
    source_inventory_code VARCHAR(200),
    bom_code              VARCHAR(200),
    flow_name             VARCHAR(200) DEFAULT '',
    PRIMARY KEY (source_inventory_code, bom_code)
);
