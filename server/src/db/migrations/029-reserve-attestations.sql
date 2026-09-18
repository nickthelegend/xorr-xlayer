-- Proof-of-reserve attestations for xStocks (PLAN.md §8.4).
--
-- The xStocks endpoint publishes only the latest observation per symbol, so any history of how a
-- token's backing has moved exists only if we keep what we read. One row per (symbol, as_of): the
-- attestor's own timestamp is the identity, so re-reading the same observation is a no-op.
CREATE TABLE IF NOT EXISTS reserve_attestations (
  id                 BIGSERIAL PRIMARY KEY,
  symbol             TEXT        NOT NULL,
  shares_held        NUMERIC     NOT NULL,
  circulating_supply NUMERIC     NOT NULL,
  ratio              NUMERIC     NOT NULL,
  custodians         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  as_of              TIMESTAMPTZ NOT NULL,
  read_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (symbol, as_of)
);

CREATE INDEX IF NOT EXISTS reserve_attestations_symbol_as_of
  ON reserve_attestations (symbol, as_of DESC);
