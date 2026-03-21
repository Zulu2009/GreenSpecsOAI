-- GreenSpecs D1 Schema
-- Run: wrangler d1 execute greenspecs-db --file=schema.sql

-- Anonymous sessions (no auth required, just a fingerprint)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  scan_count INTEGER NOT NULL DEFAULT 0
);

-- Cached product scans (the core data moat)
CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,                    -- nanoid
  session_id TEXT,                        -- anonymous session
  cache_key TEXT NOT NULL,                -- hash of product_name+claim for dedup
  product_name TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  primary_claim TEXT,
  score INTEGER NOT NULL,                 -- 0-10
  confidence TEXT NOT NULL,               -- high|medium|low
  -- rubric breakdown stored as ints
  specificity_score INTEGER DEFAULT 0,
  transparency_score INTEGER DEFAULT 0,
  third_party_score INTEGER DEFAULT 0,
  bigimpact_score INTEGER DEFAULT 0,
  marketing_score INTEGER DEFAULT 0,
  -- rich content stored as JSON arrays
  what_covers TEXT DEFAULT '[]',
  what_missing TEXT DEFAULT '[]',
  red_flags TEXT DEFAULT '[]',
  tips TEXT DEFAULT '[]',
  better_alternatives TEXT DEFAULT '[]',
  sources TEXT DEFAULT '[]',
  -- Scope 1/2/3 educational content
  scope1_text TEXT,
  scope2_text TEXT,
  scope3_text TEXT,
  -- Location & pricing (the unique data layer)
  lat REAL,
  lng REAL,
  location_name TEXT,                     -- "Oliver's Market, Sebastopol CA"
  price TEXT,                             -- "$4.99"
  -- Metadata
  api_cost_usd REAL DEFAULT 0,
  served_from_cache INTEGER DEFAULT 0,   -- 0=fresh AI, 1=cache hit
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Index for cache lookups (saves AI calls)
CREATE INDEX IF NOT EXISTS idx_scans_cache_key ON scans(cache_key);
-- Index for community feed by location (lat/lng bucketing)
CREATE INDEX IF NOT EXISTS idx_scans_location ON scans(lat, lng);
-- Index for recent feed
CREATE INDEX IF NOT EXISTS idx_scans_created ON scans(created_at DESC);

-- Compare sessions: user pins up to 4 scans for side-by-side
CREATE TABLE IF NOT EXISTS compares (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  scan_ids TEXT NOT NULL,                 -- JSON array of scan IDs
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Analytics: track what unknown products get scanned most
-- (these become the queue for manual scoring)
CREATE TABLE IF NOT EXISTS unknown_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,                    -- product name or barcode
  session_id TEXT,
  lat REAL,
  lng REAL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_unknown_query ON unknown_scans(query);

-- Auth tables
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  google_id TEXT UNIQUE,
  password_hash TEXT,
  salt TEXT,
  avatar TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
