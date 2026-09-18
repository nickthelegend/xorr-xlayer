-- Limit Order Protocol orders published to this executor (PLAN.md 3.15).
--
-- A maker signs a 1inch limit order off chain and publishes it here instead of to 1inch's public orderbook, which is a
-- mainnet action. The row keeps what the fill needs to rebuild the signed struct — every field but the receiver, which
-- the executor requires to be the maker — and records who took it here and in which transaction.
--
-- Checked before a row is written: the signature recovers the maker, and the hash is the one the router computes.
-- Whether an order is still open is not stored. Filled elsewhere, cancelled, expired and unfunded are read from the
-- chain when the list is, because a stored answer to any of them goes stale by itself.
--
-- `chain` defaults to the session's, as in 015-chain-scope.sql, and every read filters on it. An order is signed for a
-- chain id and a fork of Base shares Base's, so the column is what keeps a fork's orders out of another chain's list.
CREATE TABLE IF NOT EXISTS limit_orders (
  order_hash      text PRIMARY KEY,
  chain           text NOT NULL DEFAULT current_setting('xorr.chain_key'),
  maker           text NOT NULL,
  maker_asset     text NOT NULL,
  taker_asset     text NOT NULL,
  -- uint256 values: numeric(78, 0) holds the largest one exactly, and they are read back as strings.
  making_amount   numeric(78, 0) NOT NULL CHECK (making_amount > 0),
  taking_amount   numeric(78, 0) NOT NULL CHECK (taking_amount > 0),
  salt            numeric(78, 0) NOT NULL,
  maker_traits    numeric(78, 0) NOT NULL,
  -- The 64-byte compact form, r then vs: what the router's fill takes.
  signature       text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  filled_at       timestamptz,
  fill_tx         text,
  taker_wallet_id text REFERENCES wallets(id) ON DELETE SET NULL
);

-- The list: this chain's orders, newest first.
CREATE INDEX IF NOT EXISTS limit_orders_chain_created_idx ON limit_orders (chain, created_at DESC);
