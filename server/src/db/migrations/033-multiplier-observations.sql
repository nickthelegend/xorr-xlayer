-- Scaled UI multiplier observations for xStocks (PLAN.md §8.4).
--
-- The multiplier is how Backed expresses a split or an auto-reinvested dividend: the raw balance
-- never moves, the multiplier does. The mint carries only its current value and at most one pending
-- change, so the record of how a token's multiplier has actually moved exists only if we keep it.
--
-- One row per (mint, multiplier, effective_at): re-reading an unchanged multiplier is a no-op, so
-- the table accumulates changes rather than a row per poll.
CREATE TABLE IF NOT EXISTS multiplier_observations (
  id            BIGSERIAL PRIMARY KEY,
  mint          TEXT        NOT NULL,
  symbol        TEXT,
  multiplier    NUMERIC     NOT NULL,
  decimals      SMALLINT    NOT NULL,
  -- The pending multiplier the issuer has scheduled, where there is one.
  new_multiplier          NUMERIC,
  new_multiplier_at       TIMESTAMPTZ,
  -- When this value became the effective one, as the mint states it.
  effective_at  TIMESTAMPTZ NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mint, multiplier, effective_at)
);

CREATE INDEX IF NOT EXISTS multiplier_observations_mint_seen
  ON multiplier_observations (mint, observed_at DESC);
