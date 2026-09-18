-- A target basket of tokenized equities, and the runs that rebalance it.
--
-- Separate from `strategies`/`strategy_runs` on purpose, and the purpose is the chain. Those tables
-- belong to `executor/run.ts`, which settles on Base through 1inch; an xStock basket settles on
-- Solana through `executor/place.ts`. Putting a Solana basket in `strategies` would also be worse
-- than untidy: `run.ts` claims a run for any live row and then blocks kinds it has no planner for,
-- which would consume the period key every tick and leave the Solana sweep with nothing to claim.
CREATE TABLE IF NOT EXISTS agent_baskets (
  wallet_id   TEXT PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
  -- { "NVDAx": 40, "TSLAx": 30, "AAPLx": 30 } — percentages of the basket's own value.
  targets     JSONB NOT NULL DEFAULT '{}',
  -- How far a sleeve may drift before it is worth a trade. Below this, rebalancing is churn.
  band_pct    NUMERIC(5,2) NOT NULL DEFAULT 5 CHECK (band_pct > 0 AND band_pct <= 50),
  cadence     TEXT NOT NULL DEFAULT 'daily' CHECK (cadence IN ('daily','weekly','biweekly','monthly')),
  enabled     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One rebalance per wallet per period, ever.
--
-- `period_key` is UNIQUE and a run is CLAIMED by inserting it, which is the same guarantee
-- `strategy_runs` gives and for the same reason: a retry, a restart, or two schedulers racing all
-- converge on one run per period because the database refuses the second, not because an `if`
-- somewhere hoped to catch it. PLAN.md 12.8 — "a DCA retry that double-buys is how a trading bot
-- loses real money quietly", and a rebalance that double-trades is the same bug wearing a different
-- name.
CREATE TABLE IF NOT EXISTS basket_runs (
  id           TEXT PRIMARY KEY,
  wallet_id    TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  period_key   TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL CHECK (status IN ('pending','filled','failed','skipped')),
  -- What it decided to do, and why. Null until the planner has looked.
  symbol       TEXT,
  side         TEXT CHECK (side IN ('buy','sell')),
  usd          NUMERIC(14,2),
  drift_pct    NUMERIC(6,2),
  detail       TEXT NOT NULL DEFAULT '',
  signature    TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS basket_runs_wallet_idx ON basket_runs(wallet_id, started_at DESC);
