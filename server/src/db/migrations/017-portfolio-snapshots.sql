-- What each wallet was worth, when (PLAN.md 2.10).
--
-- The Portfolio graph replayed what is held now over last week's prices. It could show how today's
-- holdings would have moved, and could not show a deposit, a sale or a withdrawal at all: nothing kept
-- the value at the time. This keeps it, read from the chain the way `/wallet/balance` reads it.
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id            bigserial PRIMARY KEY,
  wallet_id     text NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  chain         text NOT NULL DEFAULT current_setting('xorr.chain_key'),
  at            timestamptz NOT NULL DEFAULT now(),
  total_usd     numeric(18,2) NOT NULL,
  cash_usd      numeric(18,2) NOT NULL,
  holdings_usd  numeric(18,2) NOT NULL,
  supplied_usd  numeric(18,2) NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('interval', 'fill', 'close', 'withdrawal'))
);
CREATE INDEX IF NOT EXISTS portfolio_snapshots_wallet_chain_at_idx ON portfolio_snapshots (wallet_id, chain, at);
