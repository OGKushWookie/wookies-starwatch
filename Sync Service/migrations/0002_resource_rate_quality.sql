PRAGMA foreign_keys = ON;

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

-- Before 1.2.1, both public profiles and leaderboard rows were labelled "public".
-- Profile uploads share the same capture time and value, so retain only rows with
-- matching profile evidence. All other public rows remain recoverable here.
INSERT OR IGNORE INTO resource_observations_quarantine
  (player_key, observed_bucket, username, observed_at, value, source,
   reporter_account, created_at, change_id, rejected_reason, quarantined_at)
SELECT row.player_key, row.observed_bucket, row.username, row.observed_at, row.value,
       row.source, row.reporter_account, row.created_at, row.change_id,
       'legacy-leaderboard-or-cache', CAST(unixepoch('now') AS INTEGER) * 1000
FROM resource_observations row
WHERE row.source = 'public'
  AND NOT EXISTS (
    SELECT 1
    FROM profile_snapshots profile
    WHERE profile.player_key = row.player_key
      AND ABS(profile.observed_at - row.observed_at) <= 5000
      AND CAST(json_extract(profile.profile_json, '$.stats.resources') AS REAL) = row.value
  );

DELETE FROM resource_observations
WHERE source = 'public'
  AND EXISTS (
    SELECT 1
    FROM resource_observations_quarantine rejected
    WHERE rejected.player_key = resource_observations.player_key
      AND rejected.observed_bucket = resource_observations.observed_bucket
      AND rejected.rejected_reason = 'legacy-leaderboard-or-cache'
  );

UPDATE resource_observations SET source = 'public-profile' WHERE source = 'public';
UPDATE resource_observations SET source = 'live-profile' WHERE source = 'live';

-- Cumulative resources cannot move backward. Preserve later decreasing rows for
-- audit/recovery and exclude them from rate baselines.
INSERT OR IGNORE INTO resource_observations_quarantine
  (player_key, observed_bucket, username, observed_at, value, source,
   reporter_account, created_at, change_id, rejected_reason, quarantined_at)
WITH ordered AS (
  SELECT row.*,
         MAX(value) OVER (
           PARTITION BY player_key
           ORDER BY observed_at, observed_bucket
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ) AS prior_max
  FROM resource_observations row
)
SELECT player_key, observed_bucket, username, observed_at, value, source,
       reporter_account, created_at, change_id, 'non-monotonic-total',
       CAST(unixepoch('now') AS INTEGER) * 1000
FROM ordered
WHERE prior_max IS NOT NULL AND value < prior_max;

DELETE FROM resource_observations
WHERE EXISTS (
  SELECT 1
  FROM resource_observations_quarantine rejected
  WHERE rejected.player_key = resource_observations.player_key
    AND rejected.observed_bucket = resource_observations.observed_bucket
    AND rejected.rejected_reason = 'non-monotonic-total'
);

-- Hourly rows are derived data. Rebuild them naturally from the clean raw stream.
DELETE FROM resource_hourly_rollups;

INSERT INTO sync_change_clock (changed_at)
VALUES (CAST(unixepoch('now') AS INTEGER) * 1000);

DELETE FROM resource_player_state;

INSERT INTO resource_player_state
  (player_key, username, first_at, first_value, latest_at, latest_value, updated_at, change_id)
SELECT grouped.player_key,
       (SELECT username FROM resource_observations row WHERE row.player_key = grouped.player_key ORDER BY observed_at DESC LIMIT 1),
       grouped.first_at,
       (SELECT value FROM resource_observations row WHERE row.player_key = grouped.player_key ORDER BY observed_at ASC LIMIT 1),
       grouped.latest_at,
       (SELECT value FROM resource_observations row WHERE row.player_key = grouped.player_key ORDER BY observed_at DESC LIMIT 1),
       CAST(unixepoch('now') AS INTEGER) * 1000,
       (SELECT MAX(change_id) FROM sync_change_clock)
FROM (
  SELECT player_key, MIN(observed_at) AS first_at, MAX(observed_at) AS latest_at
  FROM resource_observations
  GROUP BY player_key
) grouped;

PRAGMA optimize;
