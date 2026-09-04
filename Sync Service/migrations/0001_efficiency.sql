ALTER TABLE xp_observations ADD COLUMN change_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE resource_observations ADD COLUMN change_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profile_snapshots ADD COLUMN change_id INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_xp_player_change
  ON xp_observations (player_key, change_id, observed_bucket);

CREATE INDEX IF NOT EXISTS idx_resources_player_change
  ON resource_observations (player_key, change_id, observed_bucket);

CREATE INDEX IF NOT EXISTS idx_profiles_player_change
  ON profile_snapshots (player_key, change_id, observed_bucket);

CREATE TABLE IF NOT EXISTS sync_change_clock (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_at INTEGER NOT NULL
);

INSERT INTO sync_change_clock (changed_at)
SELECT CAST(unixepoch('now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM sync_change_clock);

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

INSERT INTO xp_player_state
  (player_key, username, first_at, first_activities_json, latest_at, latest_activities_json, updated_at, change_id)
SELECT grouped.player_key,
       (SELECT username FROM xp_observations row WHERE row.player_key = grouped.player_key ORDER BY observed_at DESC LIMIT 1),
       grouped.first_at,
       (SELECT activities_json FROM xp_observations row WHERE row.player_key = grouped.player_key ORDER BY observed_at ASC LIMIT 1),
       grouped.latest_at,
       (SELECT activities_json FROM xp_observations row WHERE row.player_key = grouped.player_key ORDER BY observed_at DESC LIMIT 1),
       grouped.updated_at,
       1
FROM (
  SELECT player_key, MIN(observed_at) AS first_at, MAX(observed_at) AS latest_at, MAX(created_at) AS updated_at
  FROM xp_observations
  GROUP BY player_key
) AS grouped
WHERE 1
ON CONFLICT(player_key) DO NOTHING;

INSERT INTO resource_player_state
  (player_key, username, first_at, first_value, latest_at, latest_value, updated_at, change_id)
SELECT grouped.player_key,
       (SELECT username FROM resource_observations row WHERE row.player_key = grouped.player_key ORDER BY observed_at DESC LIMIT 1),
       grouped.first_at,
       (SELECT value FROM resource_observations row WHERE row.player_key = grouped.player_key ORDER BY observed_at ASC LIMIT 1),
       grouped.latest_at,
       (SELECT value FROM resource_observations row WHERE row.player_key = grouped.player_key ORDER BY observed_at DESC LIMIT 1),
       grouped.updated_at,
       1
FROM (
  SELECT player_key, MIN(observed_at) AS first_at, MAX(observed_at) AS latest_at, MAX(created_at) AS updated_at
  FROM resource_observations
  GROUP BY player_key
) AS grouped
WHERE 1
ON CONFLICT(player_key) DO NOTHING;

INSERT INTO latest_profiles (player_key, username, observed_at, profile_json, updated_at, change_id)
SELECT grouped.player_key,
       (SELECT username FROM profile_snapshots row WHERE row.player_key = grouped.player_key ORDER BY observed_at DESC LIMIT 1),
       grouped.latest_at,
       (SELECT profile_json FROM profile_snapshots row WHERE row.player_key = grouped.player_key ORDER BY observed_at DESC LIMIT 1),
       grouped.updated_at,
       1
FROM (
  SELECT player_key, MAX(observed_at) AS latest_at, MAX(created_at) AS updated_at
  FROM profile_snapshots
  GROUP BY player_key
) AS grouped
WHERE 1
ON CONFLICT(player_key) DO NOTHING;

PRAGMA optimize;
