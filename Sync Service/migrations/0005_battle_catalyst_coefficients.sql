-- Online model coefficients for every current PvP catalyst family.

ALTER TABLE battle_model_state ADD COLUMN coefficients_json TEXT NOT NULL DEFAULT '{}';
