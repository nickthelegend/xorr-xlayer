-- Realised P&L, and a cost basis that survives a partial sale.
--
-- `applyFill` reduced `cost_usd` by the sale PROCEEDS rather than by the cost of the units sold.
-- Buy 1 WETH at $2,000 and sell half at $3,000 and the book was left holding 0.5 units at a
-- cost of $500 — an entry of $1,000 a unit for coins that cost $2,000. Every subsequent
-- unrealised-gain figure on that position was overstated, and the profit that was actually taken
-- was recorded nowhere at all.
--
-- So: cost basis comes out at average cost, and the difference — the realised gain or loss — is
-- kept here rather than silently folded into the remaining lot.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS realised_usd numeric(16,2) NOT NULL DEFAULT 0;

-- What was sold, cumulatively. Without it a closed position is indistinguishable from one that
-- never existed, and "you made $400 on WETH" has nothing to stand on once units reach zero.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS units_sold numeric(24,9) NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS proceeds_usd numeric(16,2) NOT NULL DEFAULT 0;
