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
  change_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_key, observed_bucket)
);

CREATE INDEX IF NOT EXISTS idx_xp_player_time
  ON xp_observations (player_key, observed_at);

CREATE INDEX IF NOT EXISTS idx_xp_player_change
  ON xp_observations (player_key, change_id, observed_bucket);

CREATE TABLE IF NOT EXISTS resource_observations (
  player_key TEXT NOT NULL,
  observed_bucket INTEGER NOT NULL,
  username TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL,
  reporter_account TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  change_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_key, observed_bucket)
);

CREATE INDEX IF NOT EXISTS idx_resources_player_time
  ON resource_observations (player_key, observed_at);

CREATE INDEX IF NOT EXISTS idx_resources_player_change
  ON resource_observations (player_key, change_id, observed_bucket);

CREATE TABLE IF NOT EXISTS resource_observations_quarantine (
  player_key TEXT NOT NULL,
  observed_bucket INTEGER NOT NULL,
  username TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL,
  reporter_account TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  change_id INTEGER NOT NULL,
  rejected_reason TEXT NOT NULL,
  quarantined_at INTEGER NOT NULL,
  PRIMARY KEY (player_key, observed_bucket, rejected_reason)
);

CREATE INDEX IF NOT EXISTS idx_resource_quarantine_player_time
  ON resource_observations_quarantine (player_key, observed_at);

CREATE TABLE IF NOT EXISTS profile_snapshots (
  player_key TEXT NOT NULL,
  observed_bucket INTEGER NOT NULL,
  username TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  profile_json TEXT NOT NULL,
  reporter_account TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  change_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_key, observed_bucket)
);

CREATE INDEX IF NOT EXISTS idx_profiles_player_time
  ON profile_snapshots (player_key, observed_at);

CREATE INDEX IF NOT EXISTS idx_profiles_player_change
  ON profile_snapshots (player_key, change_id, observed_bucket);

CREATE TABLE IF NOT EXISTS sync_change_clock (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS xp_player_state (
  player_key TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  first_activities_json TEXT NOT NULL,
  latest_at INTEGER NOT NULL,
  latest_activities_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  change_id INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_xp_state_updates
  ON xp_player_state (change_id, player_key);

CREATE TABLE IF NOT EXISTS resource_player_state (
  player_key TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  first_value REAL NOT NULL,
  latest_at INTEGER NOT NULL,
  latest_value REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  change_id INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resource_state_updates
  ON resource_player_state (change_id, player_key);

CREATE TABLE IF NOT EXISTS latest_profiles (
  player_key TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  profile_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  change_id INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_latest_profiles_updates
  ON latest_profiles (change_id, player_key);

CREATE TABLE IF NOT EXISTS xp_hourly_rollups (
  player_key TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,
  username TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  first_activities_json TEXT NOT NULL,
  last_at INTEGER NOT NULL,
  last_activities_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_key, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_xp_rollups_player_time
  ON xp_hourly_rollups (player_key, hour_bucket);

CREATE TABLE IF NOT EXISTS resource_hourly_rollups (
  player_key TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,
  username TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  first_value REAL NOT NULL,
  last_at INTEGER NOT NULL,
  last_value REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_key, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_resource_rollups_player_time
  ON resource_hourly_rollups (player_key, hour_bucket);

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

CREATE INDEX IF NOT EXISTS idx_steam_links_device
  ON steam_device_links (device_hash, expires_at);

CREATE TABLE IF NOT EXISTS account_devices (
  device_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  steam_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_account_devices_account
  ON account_devices (account_id, revoked_at);

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

CREATE INDEX IF NOT EXISTS idx_account_systems_updates
  ON account_systems (account_id, updated_at, system_key);

CREATE TABLE IF NOT EXISTS battle_observations (
  battle_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('arena', 'squadron')),
  observed_at INTEGER NOT NULL,
  rounds INTEGER NOT NULL,
  participant_count INTEGER NOT NULL,
  winner_side TEXT NOT NULL CHECK (winner_side IN ('a', 'd', 'tie')),
  battle_json TEXT NOT NULL,
  reporter_account TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_battle_kind_time
  ON battle_observations (kind, observed_at);

CREATE TABLE IF NOT EXISTS battle_model_state (
  kind TEXT PRIMARY KEY CHECK (kind IN ('arena', 'squadron')),
  battle_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  inferred_count INTEGER NOT NULL DEFAULT 0,
  attacker_wins INTEGER NOT NULL DEFAULT 0,
  defender_wins INTEGER NOT NULL DEFAULT 0,
  ties INTEGER NOT NULL DEFAULT 0,
  total_rounds INTEGER NOT NULL DEFAULT 0,
  total_logs INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  blocks INTEGER NOT NULL DEFAULT 0,
  stuns INTEGER NOT NULL DEFAULT 0,
  dots INTEGER NOT NULL DEFAULT 0,
  intercept REAL NOT NULL DEFAULT 0,
  slope REAL NOT NULL DEFAULT 1,
  coefficients_json TEXT NOT NULL DEFAULT '{}',
  brier_sum REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
