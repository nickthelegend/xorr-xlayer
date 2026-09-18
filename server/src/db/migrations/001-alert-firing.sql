-- Alerts that can actually fire, and fire once.
--
-- `alerts` stored what to watch for and nothing about whether it had happened, so an evaluator
-- would have re-sent the same notification every thirty seconds for as long as the condition held.
-- An alert that cannot stop is not an alert; it is a reason to turn off notifications.
--
-- `armed` is the hysteresis. A "BTC above $95k" alert disarms when it fires and only re-arms when
-- the price comes back below the level, so one crossing is one notification. `last_fired_at` is
-- kept for the UI to say when, and for a human to check that the rule is behaving.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS armed boolean NOT NULL DEFAULT true;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_fired_at timestamptz;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS fire_count integer NOT NULL DEFAULT 0;

-- The evaluator sweeps every enabled alert on a schedule; this is the index that sweep uses.
CREATE INDEX IF NOT EXISTS alerts_enabled_idx ON alerts (enabled) WHERE enabled;
