CREATE TABLE IF NOT EXISTS jobs (
  job TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  ask TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  address_hash TEXT NOT NULL,
  payload_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  gateway_url TEXT NOT NULL,
  release_tag TEXT NOT NULL,
  release_id INTEGER,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  run_started_at INTEGER,
  run_id INTEGER,
  collect_attempts INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER,
  error TEXT,
  settled INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  result_size INTEGER,
  build_json TEXT,
  library_asset_id INTEGER,
  library_url TEXT,
  library_asset_size INTEGER
);

CREATE TABLE IF NOT EXISTS payload_chunks (
  job TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (job, chunk_index),
  FOREIGN KEY (job) REFERENCES jobs(job) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at);
CREATE INDEX IF NOT EXISTS jobs_address_created_idx ON jobs(address_hash, created_at);
CREATE INDEX IF NOT EXISTS jobs_state_created_idx ON jobs(state, created_at);
CREATE INDEX IF NOT EXISTS jobs_ask_idx ON jobs(ask);
