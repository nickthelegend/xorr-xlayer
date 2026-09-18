-- Test funds the executor's faucet sent to a wallet (PLAN.md 4.4).
--
-- A new wallet had no USDC and no way to get any. The faucet sends a fixed amount of the settlement token: on a fork of
-- Base, real USDC moved from a real holder by impersonation, with the wallet's fork ETH topped up to a floor; on Base
-- Sepolia, Circle's USDC from the faucet key, when that key holds any.
--
-- One row per send, written only once its receipt is in, so the table records transfers that happened and nothing that
-- was merely attempted.
--
-- Once per wallet per 24 hours, measured from `claimed_at` by the executor's clock. These rows are what make the window
-- survive a restart and a redeploy; the per-wallet advisory lock the executor holds around a send is what stops two
-- requests racing past the check before either row exists.
--
-- `chain` defaults to the session's, as in 015-chain-scope.sql, and every read filters on it: fork USDC is not Sepolia
-- USDC, and a claim on one chain says nothing about the other.
CREATE TABLE IF NOT EXISTS faucet_claims (
  id            text PRIMARY KEY,
  chain         text NOT NULL DEFAULT current_setting('xorr.chain_key'),
  wallet_id     text NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  -- Where the USDC went, as sent.
  address       text NOT NULL,
  -- Who paid it: the impersonated holder on a fork, the faucet key on a testnet.
  paid_by       text NOT NULL,
  -- USDC in base units (six decimals), exactly.
  usdc_raw      numeric(78, 0) NOT NULL CHECK (usdc_raw > 0),
  usdc_tx       text NOT NULL,
  -- Native ETH added to reach the fork's floor, in wei. Zero for a wallet already above it, and on a testnet.
  eth_added_wei numeric(78, 0) NOT NULL DEFAULT 0 CHECK (eth_added_wei >= 0),
  claimed_at    timestamptz NOT NULL
);

-- The window check: a wallet's latest claim on this chain.
CREATE INDEX IF NOT EXISTS faucet_claims_wallet_chain_claimed_idx ON faucet_claims (wallet_id, chain, claimed_at DESC);
