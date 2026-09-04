-- Versioned native node observations let a newer scan both confirm and revoke
-- a perfect-node record without trusting legacy clients that omitted quality.
ALTER TABLE account_systems ADD COLUMN node_observed_at INTEGER NOT NULL DEFAULT 0;
