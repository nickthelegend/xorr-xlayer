-- The order a user puts their own watchlist in.
--
-- `/market/watchable` is what a strategy can follow on this network, so the LIST is the executor's
-- and changes as coverage does. This is the user's preference applied to it, which is why it is
-- stored as symbols and positions rather than as a copy of the list: a symbol that stops being
-- watchable keeps its place here and returns to it if the executor offers it again.
--
-- Scoped to the wallet, not the user: everything else in this system is (the permission, the
-- balance, the strategies, the trail), and an account with two addresses would otherwise have one
-- shared watchlist order while every other screen showed two different sets of holdings.
CREATE TABLE IF NOT EXISTS watchlist_order (
  wallet_id  TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  symbol     TEXT NOT NULL,
  -- Position within this wallet's order. Rewritten whole on every save, so gaps are not a concern
  -- and the column never has to be renumbered in place.
  position   INTEGER NOT NULL,
  PRIMARY KEY (wallet_id, symbol)
);

CREATE INDEX IF NOT EXISTS watchlist_order_idx ON watchlist_order(wallet_id, position);
