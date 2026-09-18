-- A price history for assets that have no price feed.
--
-- The tokenized equities have no CoinGecko series and no candle source anywhere free: their price
-- is derived from a live 1inch route, which is a spot reading and nothing else. So the asset screen
-- says "no price history for this market" and shows a number with no shape around it, which is
-- honest and not much use.
--
-- The one real source available is our own observations. `/market/stocks` already computes a price
-- from a real route every 30 seconds for anyone who asks; recording those, timestamped, builds a
-- genuine series — short at first, and true from the first row. It is not a reconstruction of the
-- past and does not pretend to be: the chart can only ever start when we started watching.
--
-- Deliberately not a general-purpose price table. Crypto has real feeds with real history, and
-- duplicating those here would be a second answer to a question CoinGecko already answers better.
CREATE TABLE IF NOT EXISTS price_observations (
  symbol     TEXT        NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  usd        NUMERIC(20,8) NOT NULL CHECK (usd > 0),
  -- Where the number came from, so a chart can never silently mix sources.
  source     TEXT        NOT NULL DEFAULT '1inch',
  PRIMARY KEY (symbol, at)
);

CREATE INDEX IF NOT EXISTS price_observations_symbol_at ON price_observations (symbol, at DESC);
