PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  favorites_json TEXT NOT NULL DEFAULT '[]',
  favorites_updated_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS xp_observations (
  player_key TEXT NOT NULL,
  observed_bucket INTEGER NOT NULL,
  username TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  activities_json TEXT NOT NULL,
  reporter_account TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_key, observed_bucket)
);

CREATE INDEX IF NOT EXISTS idx_xp_player_time ON xp_observations (player_key, observed_at);

CREATE TABLE IF NOT EXISTS resource_observations (
  player_key TEXT NOT NULL,
  observed_bucket INTEGER NOT NULL,
  username TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL,
  reporter_account TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_key, observed_bucket)
);

CREATE INDEX IF NOT EXISTS idx_resources_player_time ON resource_observations (player_key, observed_at);

CREATE TABLE IF NOT EXISTS profile_snapshots (
  player_key TEXT NOT NULL,
  observed_bucket INTEGER NOT NULL,
  username TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  profile_json TEXT NOT NULL,
  reporter_account TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_key, observed_bucket)
);

CREATE INDEX IF NOT EXISTS idx_profiles_player_time ON profile_snapshots (player_key, observed_at);

CREATE TABLE IF NOT EXISTS request_limits (
  account_id TEXT NOT NULL,
  minute_bucket INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, minute_bucket)
);

CREATE TABLE IF NOT EXISTS steam_device_links (
  request_id TEXT PRIMARY KEY,
  device_hash TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  legacy_account_id TEXT,
  previous_device_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  steam_id TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_steam_links_device ON steam_device_links (device_hash, expires_at);

CREATE TABLE IF NOT EXISTS account_devices (
  device_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  steam_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_account_devices_account ON account_devices (account_id, revoked_at);

CREATE TABLE IF NOT EXISTS account_systems (
  account_id TEXT NOT NULL,
  system_key TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  first_seen_at INTEGER NOT NULL,
  perfect INTEGER NOT NULL DEFAULT 0,
  system_json TEXT,
  node_observed_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, system_key)
);

CREATE INDEX IF NOT EXISTS idx_account_systems_updates ON account_systems (account_id, updated_at, system_key);
