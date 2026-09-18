-- Every disposal, as it happened.
--
-- `positions` carries running totals — realised, units sold, proceeds — which answer "how am I
-- doing" and cannot answer the question an accountant asks, which is per-disposal: what was sold,
-- when, for how much, and against what cost. Those numbers are already computed at the moment of a
-- sale; they were just added into a total and thrown away.
--
-- Written in the same transaction as the fill, like everything else here, so a disposal cannot
-- exist without the position change that produced it or the other way round.
CREATE TABLE IF NOT EXISTS disposals (
  id           text PRIMARY KEY,
  wallet_id    text NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  symbol       text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  units        numeric(24,9) NOT NULL,
  proceeds_usd numeric(16,2) NOT NULL,
  cost_usd     numeric(16,2) NOT NULL,
  realised_usd numeric(16,2) NOT NULL,
  -- False when some or all of what was sold had no recorded cost. The report says so rather than
  -- presenting an understated gain as complete.
  basis_known  boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS disposals_wallet_idx ON disposals (wallet_id, at DESC);
