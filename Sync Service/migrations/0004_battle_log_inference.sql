-- Keep profile-matched and lower-weight log-derived training evidence distinct.

ALTER TABLE battle_model_state ADD COLUMN inferred_count INTEGER NOT NULL DEFAULT 0;
