-- Passive, privacy-minimized battle observations and incremental simulator calibration.

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
  brier_sum REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
